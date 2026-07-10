# Phase 3 — Contract, Invoice & Payment: Audit, Fixes & Open Items

**Scope:** the PayFast ITN (`POST /api/payment/webhook/payfast`), manual payment (`PUT /api/admin/bookings/:id/manual-payment` + `processManualPayment`), `POST /api/admin/transactions/manual`, `reconcile/sync`, refunds, `generateContract`, the contract routes, and the invoice/overdue sweeps.
**Date:** 2026-07-10
**Commits:** `0ee1df4` (Phase 2 close-out, Part A), `ade77d9` (Phase 3, Part B)
**Method:** the phase brief read against current code, three parallel exploration passes, then behavioural testing against a running server — ITN tests in PayFast **sandbox** mode. Every assertion was run against the preceding commit first to confirm it discriminates.

---

## 1. The brief was mostly right, and partly overtaken

The v2 brief had already corrected its own v1 findings well. Two of its three remaining gaps turned out to be **already closed**:

| Brief gap | Actual state |
|---|---|
| **Gap 2** — contract re-upload silently overwrites a signed contract | **Already blocked.** The upload route refuses when `status='signed'` or `is_frozen=1` (server.js ~6384). Verified. |
| **Gap 3** — manual full-payment-without-acceptance produces a receipt with no invoice | **Already handled.** `processManualPayment` calls `generateInvoice()` when no live invoice exists (server.js ~5040). Verified. |
| **Gap 1** — PayFast confirms on deposit, manual doesn't | **Fixed** (P3-1). |

One structural claim in the brief was too generous: "re-read the revision-request route, treat the quote route as stable." The quote route is where Phase 2's worst bug lived, and the payment code held several more.

**Owner decision (2026-07-10): a deposit confirms a booking.** Every path now agrees.

---

## 2. Bugs found and fixed

### P3-1 — "When does a payment confirm a booking?" was answered four different ways *(high)*

| Path | Old rule |
|---|---|
| PayFast ITN | any payment on ACCEPTED/CONFIRMED → CONFIRMED |
| `processManualPayment` | matched PayFast |
| `/transactions/manual` (payment + adjustment) | only full `PAID` → CONFIRMED |
| `reconcile/sync` | only full `PAID` → CONFIRMED |

So the **same R500 deposit** confirmed the booking through PayFast or the manual-payment button, but left it `ACCEPTED` when recorded through `/transactions/manual` or reconcile/sync.

**Fix.** One helper, `deriveBookingStatusAfterPayment(currentStatus, paymentStatus)`, owns the rule. All four manual/admin sites call it. The ITN keeps expressing the identical rule as a race-free SQL `CASE` — routing it through JS would reintroduce a read-then-write window — so the two are kept in sync by meaning, with a comment at each end saying so.

Verified: a R500 deposit via `manual-payment` and via `/transactions/manual` both land on `CONFIRMED`/`DEPOSIT_PAID`.

### P3-2 — `processManualPayment` trusted the declared `payment_status` *(medium)*

The route took `payment_status` verbatim from the request body, so an admin could record R1 against a R1000 booking as `PAID`.

**Fix.** `payment_status` is derived from the amount, using the same thresholds as `/transactions/manual` (`>= total` → PAID, `>= half` → DEPOSIT_PAID, `> 0` → PARTIALLY_PAID). The body field is now advisory, and the route no longer *requires* it (the entry guard rejects a garbage value but accepts its absence). Verified: R1 declared `PAID` is stored `PARTIALLY_PAID`.

### P3-3 — The PayFast ITN was not idempotent at the database level *(high)*

`transactions.pf_payment_id` is `TEXT UNIQUE` and was **never populated** on the ITN path — `logPaymentEvent` wrote the id into the `reference` column instead. Dedupe was a non-atomic `SELECT … WHERE reference=? AND booking_id=? AND source='payfast'` followed by a fire-and-forget insert. Two concurrent duplicate ITNs could both pass the SELECT and both credit, and the `+R1` overpayment guard does not catch a doubled 50% deposit (2 × 50% = 100% ≤ total).

**Fix.** `pf_payment_id` is written on the `transactions` insert, inside the credit transaction. A replayed or concurrent duplicate fails the `UNIQUE` constraint, the whole credit rolls back, and it is logged `IGNORED_DUPLICATE`. No backfill: existing rows are `NULL`, and SQLite permits many `NULL`s in a `UNIQUE` column. The existing reference pre-check is kept as the sandbox dedupe (sandbox ITNs carry no `pf_payment_id`).

Verified: the same ITN posted twice leaves exactly one `transactions` row and credits once.

### P3-4 — The ITN credit sequence was not transactional *(high)*

The `transactions` insert, the ledger credit, and the invoice → `PAID` sync were three independent statements. A crash between them left partial state, and the overpayment-rejected path left a phantom completed `transactions` row.

**Fix.** All three are one `withDbTransaction` unit. An overpayment now rolls the `transactions` insert back too (verified: no phantom row). Kept **outside** the lock: the ~8 s PayFast postback (never hold the write lock across a network round-trip), calendar sync, every email, the auto-`events` insert, and `alignMilestonePayments`.

### P3-5 — The ITN source-IP check was bypassable *(medium, security)*

It read `req.headers['x-forwarded-for']` and took the leftmost, client-controlled value, so a caller could spoof an allowlisted PayFast IP with a header.

**Fix.** Uses `req.ip`. `app.set('trust proxy', 1)` is configured (server.js:365), so Express resolves `req.ip` from the trusted proxy hop. Signature and postback validation still apply — this is defence-in-depth, but a check that can be spoofed is worth nothing.

### P3-6 — The overdue-invoice reminder had never fired *(high)*

`runDailyOverdueFlaggingSweep()` runs at startup and 00:05 and flips `SENT → OVERDUE`. `runOverdueInvoiceSweepJob()` runs 45 s after startup and matched only `UPPER(i.status)='SENT'`. The flagging sweep always won, so the reminder found nothing.

**Evidence.** 7 invoices `OVERDUE`; `SELECT COUNT(*) FROM invoices WHERE overdue_reminded_at IS NOT NULL` returned **0**.

**Fix.** Matches `SENT` and `OVERDUE`; `overdue_reminded_at IS NULL` keeps it idempotent.

**Operational action taken.** Fixing the filter means the sweep would email every currently-overdue client on the next start. Exactly 1 of the 7 met the full criteria (`b.status='CONFIRMED' AND b.payment_status NOT IN ('PAID')`), and it was an internal address. Per the owner decision, all 7 overdue invoices were backfilled `overdue_reminded_at = CURRENT_TIMESTAMP` as a one-off, so the fix affects only invoices that go overdue from now on. Confirmed 0 unreminded overdue invoices remain.

### P3-7 — Both overdue sweeps computed "today" in UTC *(medium)*

`runDailyOverdueFlaggingSweep` and `runOverdueInvoiceSweepJob` used SQLite `DATE('now')` (UTC) while the quote sweeps use `Africa/Johannesburg`. SA is UTC+2, so for the two hours after local midnight an invoice due "today" was flagged overdue early. Both now use the SAST date.

### P3-8 — Refund did not re-derive `payment_status` *(medium)*

`PUT /api/admin/bookings/:id/refund` recomputed `amount_paid`/`amount_outstanding` from the transaction sum but left `payment_status` stale, so a fully refunded booking stayed `PAID`. (`trg_auto_payment_status` only ever *forces* `PAID` when outstanding hits 0; it cannot demote.)

**Fix.** Re-derives `payment_status` from the recomputed ledger — same derivation the `/transactions/manual` refund branch already used — and re-runs the milestone waterfall so newly-uncovered rows fall back to `pending`. Verified: a full refund moves `PAID → UNPAID`.

### P3-9 — `POST /contract/remind` was unmetered *(low)*

No rate limit, no DB write, no timestamp — the reminder could be sent on a loop.

**Fix.** `mutateRateLimiter`, plus `contracts.sent_to_client_at` (a column that existed and was never written) as the throttle: a repeat within 24 h returns `429` unless `{ force: true }`. No schema change.

---

## 3. Discovered, reported — **not** fixed

### D1 — The pre-event balance-due reminder is broken and may re-send hourly

The hourly cron's balance-due reminder (server.js ~1506) queries and inserts `reminders_log` by a `reminder_type` column that **does not exist** in the table:

```sql
SELECT id FROM reminders_log WHERE booking_id = ? AND reminder_type = ?
INSERT INTO reminders_log (booking_id, reminder_type, status) VALUES (?, ?, 'sent')
```

`reminders_log` has no `reminder_type` column (it keys on `days_before` and has `days_before`, `due_date`, `recipient_email` as `NOT NULL`). So the `SELECT` errors → the idempotency guard sees no prior row → it sends → the `INSERT` also errors and records nothing. For a `CONFIRMED` booking with an outstanding balance on the 7/3/1-day marks before its event, this can re-send **every hour**.

I did not fix this in the Phase 3 batch: it is outside the contract/invoice/payment surface, and the fix is a schema decision — either add a `reminder_type` column (and rework the `UNIQUE(booking_id, schedule_id, days_before)` constraint), or move these reminders onto the `days_before`/`due_date` shape the table already has. It deserves its own change with that decision made explicitly. **Flagagged for a follow-up.**

### D2 — `quotations.quote_number` still collides on a same-second double-click

Carried from Phase 2. The invoice half of this (`invoice_number`) was fixed with a revision suffix; the same treatment should be applied to `quote_number`. Narrow window, clean rollback.

### D3 — The ITN `+R1` overpayment guard is amount-blind to split deposits

The guard rejects a credit that would exceed `total + R1`. It correctly stops a doubled full payment, and P3-3 now stops an exact ITN replay. But it does not verify that an ITN's amount matches the *expected* milestone — a tampered-but-smaller amount that passes signature and postback is still credited as sent. Low priority (signature + postback are the real gate), noted for completeness.

---

## 4. Verification

| Suite | Fresh-snapshot result | Against preceding commit |
|---|---|---|
| Phase 3 (this change) | 19/19 | 12/19 on `0ee1df4` |
| Phase 2 close-out | 27/27 | 9/27 on `63b1c56` |
| Phase 2 | 28/28 | — |
| Transaction migration | 29/29 | — |
| Phase 1 intake | 21/21 | — |

Each suite passes 100% **on a fresh snapshot**. Running all of them back-to-back against one un-restored database drops a couple of tests — shared temp admin, same-second `quote_number` collisions across suites, duplicate-payment guards firing between suites — which is test-harness cross-talk, not a code regression; each was re-confirmed green in isolation.

Two Phase 3 checks are hardening rather than reproduced-bug fixes and do not discriminate against the old code: the ITN IP check (P3-5 — in production the signature check blocks a spoofed ITN first) and the UTC→SAST sweep dates (P3-7 — only observable in the post-midnight window). Both are verified by inspection.

The transaction invariant holds: `grep -c 'db.run("BEGIN|COMMIT|ROLLBACK'` is **0**, and `withDbTransaction` call count equals the `BEGIN IMMEDIATE` count (11 each — the ITN credit added one).

---

## 5. Database

One data change, no schema change: the 7 pre-existing `OVERDUE` invoices were stamped `overdue_reminded_at = CURRENT_TIMESTAMP` (P3-6). `transactions.pf_payment_id` is now populated going forward; existing rows keep their `NULL`.
