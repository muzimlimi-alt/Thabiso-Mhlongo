# Phase 2 — Quote & Acceptance: Audit, Fixes & Open Items

**Scope:** `POST /api/admin/bookings/:id/quote`, `POST /api/public/bookings/:id/accept-quote`, `generateInvoice()`, the quote-expiry sweeps, and the `quotations` / `payment_schedules` / `invoices` tables.
**Date:** 2026-07-09
**Commit:** `3310254`
**Method:** the phase brief (`TBC/process/phase2-quote-acceptance-test-prompt.md`) read against the current code, then behavioural testing against a running server. Every assertion was run against the preceding commit (`b464865`) first, to confirm it discriminates.

---

## 1. The brief is partly stale

Three of its four gaps have moved since it was written.

| Brief | Actual state |
|---|---|
| **Gap 2** — acceptance email claims an invoice exists even when generation failed | **Already fixed.** `invoiceGenerated` is tracked and the client is told "our team will be in touch" on failure. |
| **Gap 4** — undocumented `RESPONDED` status | **Already resolved.** Retired; only `'QUOTED'` is accepted. Nothing writes it. Three comments are all that remain. |
| **Gap 3** — re-quoting an `ACCEPTED` booking doesn't reconcile payment schedules | **Implemented, and it introduced a worse bug.** See P2-1. |
| **Gap 1** — acceptance authenticated by email match alone | **Still open.** Reviewed with the owner 2026-07-09 and accepted as risk. |

The brief's "confirmed-stable, re-test only if you find evidence otherwise" instruction for the quote route did not hold: the route's re-quote cascade is where the worst defect lives.

---

## 2. Bugs found and fixed

### P2-1 — Re-quoting an accepted booking destroyed its invoice, permanently *(critical)*

`invoices.invoice_number` is `INV-<YYYY>-<bookingId>`, `TEXT UNIQUE NOT NULL` — deterministic per booking per year. Re-quoting an `ACCEPTED` booking voids its live invoice, and a voided invoice keeps its number. The replacement could therefore never be inserted.

**Evidence.** Reproduced end to end on the preceding commit:

```
quote R1000 → accept   → ACCEPTED, schedules 500/500, INV-2026-100043/SENT = 1000
re-quote R5000         → QUOTED,   schedules superseded, invoice VOID
re-accept              → ACCEPTED, total 5000, schedules 2500/2500  ✓
                       → invoices: INV-2026-100043/VOID = 1000   ← no live invoice
                       → invoice_generated: false
```

The client is told "our team will be in touch shortly with your invoice details" — honest, thanks to the Gap-2 fix, but the invoice never arrives. **Every negotiation cycle** (client haggles, admin re-quotes) left that booking unable to be invoiced for the rest of the calendar year. No booking in the database has ever had a second invoice.

**Fix.** Invoices take a revision suffix on regeneration:

```
first issue:   INV-2026-0044
regenerated:   INV-2026-0044-R2, -R3, …
```

A number is never reused and the voided original stays in the audit trail — the statutory requirement. The 19 existing invoices are untouched. Scheme chosen with the owner over a global sequential counter (which would leave two formats in the ledger) and over mutating the invoice in place (which would destroy the record of what the client was first sent).

### P2-2 — The invoice number on the client's PDF never matched the ledger *(high)*

`pdfService.generateDocument()` derived its own header number, `INV-<bookingId>-<YYMM>`, while `generateInvoice()` stored `INV-<YYYY>-<bookingId>`. The number the client sees on their invoice has never been the number in the database.

**Fix.** `generateDocument()` takes an optional `docNumberOverride`; `generateInvoice()` passes the number it allocated. Quotes are unaffected — they already used `pdfResult.number` as `quotations.quote_number`, so PDF and ledger agreed there.

### P2-3 — Re-quote's cascade ran outside its own transaction *(high)*

The three writes implied by Gap 3 — supersede the payment schedules, void the invoice, write the `REQUOTE_AFTER_ACCEPTED` audit row — were issued *before* `withDbTransaction` opened, fire-and-forget with no error callback. A rolled-back quote left the booking `ACCEPTED` with its schedules superseded and its invoice voided.

This is the same defect as B14 in Phase 1, in a different route.

**Evidence.** Forced a deterministic rollback by re-quoting with an unknown `service_id` (`booking_services.service_id` has a foreign key to `services`, so the insert aborts inside the transaction):

```
before fix:  status=ACCEPTED  schedules=[superseded, superseded]  invoices=[VOID]
after fix:   status=ACCEPTED  schedules=[pending, pending]        invoices=[SENT]
```

The audit row was also written for a re-quote that never happened.

### P2-4 — Acceptance had no transaction *(high)*

The status flip, the `quotations` stamp, the audit row and both `payment_schedules` inserts were four independent statements. Two of them caught their own errors and continued. A schedule-insert failure therefore left an `ACCEPTED` booking with **no payment plan**, and `generateInvoice()` — which reads `payment_schedules` to render the split on the PDF — then produced an invoice with no split, while the client was told everything succeeded.

**Fix.** One guarded transaction. `generateInvoice()` and `generateContract()` open their own guarded transactions, so they necessarily stay outside it; they run after the commit, as side effects, exactly as before.

### P2-5 — No compare-and-swap on acceptance *(medium, hardening)*

`UPDATE bookings SET status = 'ACCEPTED' … WHERE id = ?` was not conditioned on the status the handler had just read, and the event loop yields between the read and the write.

**Note on evidence:** as with B4 in Phase 1, I could not force a double acceptance — 8 concurrent requests already yielded one winner on the old code. The window is real by inspection; the guard closes it deterministically. Post-fix, 8 concurrent acceptances give `1 × 200, 7 × 409`, two schedule rows, one audit row, one invoice.

### P2-6 — Two unguarded `await`s inside a sqlite3 callback *(medium)*

`await syncBookingToCalendar(id)` and `await sendQuoteAcceptedEmail(...)` sat inside `async function(upErr)`, a node-sqlite3 callback rather than an Express handler. `syncBookingToCalendar` rejects when its `db.get` fails (`getBooking(...).catch(reject)`), and an unhandled rejection there means the client never receives a response — for a booking that has already been accepted. Both are now caught.

### P2-7 — The three quote-expiry checks disagreed on what "today" is *(medium)*

| Site | Timezone |
|---|---|
| hourly cron (`server.js:1408`) | `Africa/Johannesburg` |
| `runQuoteExpirySweep()` | UTC |
| `accept-quote`'s own expiry guard | UTC |

South Africa is UTC+2, so for the two hours after local midnight the UTC date is still yesterday: a quote that expired yesterday was still acceptable, and one sweep disagreed with the other. All three now use SAST.

### P2-8 — A zero-value quote was acceptable *(low)*

The guard read `if (!row.quote_amount || row.quote_amount === '0')`, but the quote route writes `finalTotal.toFixed(2)` — a zero quote is the string `"0.00"`. Now parsed numerically.

### P2-9 — `vat_number` arrived unbounded and unencoded *(low, security)*

Taken from the acceptance request body straight into `bookings.vat_number`, a column the admin panel renders. Capped at 30 characters and passed through `encodeUserHtml()`, matching every other public free-text field. A 60-character VAT number was previously accepted with a 200.

---

## 3. Open items

### Gap 1 — Acceptance is authenticated by email match alone

Anyone who knows a client's email address and booking ID can accept a quote on their behalf. Booking IDs are sequential; the email appears in any forwarded quote.

**Decision (owner, 2026-07-09): accepted as risk.** The blast radius is one booking marked `ACCEPTED`, which an admin can reverse by re-quoting. The reasoning is recorded as a comment at the check itself so it isn't rediscovered as a "bug" next pass.

Revisit if booking IDs ever become externally enumerable, or if acceptance starts triggering an irreversible action (a payment capture, say).

### Q1 — `quote_number` collides on same-second regeneration — **FIXED (commit `0ee1df4`)**

`quotations.quote_number` was `QT-<id>-<YYMMDDHHmmss>` and `UNIQUE`; two quotes for one booking inside the same second — a double-click on *Generate Quote* — collided and the second rolled back with a 500. Now takes a revision suffix (`-R2`, `-R3`), the same scheme as invoices, via the `docNumberOverride` argument `pdfService.generateDocument` already accepts — which also makes the PDF header match `quotations.quote_number`. Verified: two quotes in the same second both succeed, the second numbered `-R2`, each with its own PDF file.

### Q2 — The quote route trusts `service_id` — **FIXED (commit `0ee1df4`)**

The structured branch takes `items[].service_id` on trust and inserts into `booking_services`, which has a foreign key to `services`. An unknown id used to surface as a 500. The quote transaction's `catch` now detects the `SQLITE_CONSTRAINT` + `FOREIGN KEY` combination and returns a 400 ("One or more selected services no longer exist"). The insert is still what fails — deliberately, so the deterministic rollback lever the test suite relies on is preserved — only the surfaced status changed. `unit_price` remains free-form (the quote builder exists to override catalogue prices).

### Q3 — Two expiry sweeps do the same job

The hourly cron's step 2 and `runQuoteExpirySweep()` both expire overdue quotes. Harmless now that they agree on the date, but they should be consolidated. Both write `status = 'EXPIRED'` directly rather than going through `applyStatusChange`, bypassing `ALLOWED_TRANSITIONS` — the state-machine bypass the phase brief flags for Phase 4.

### Q4 — Re-quote reconciliation arithmetic — **FIXED (commit `0ee1df4`)**

Re-quoting a committed booking supersedes every non-paid schedule row and voids the live invoice, forcing the client to re-accept. This turned out to be worse than "the split is computed on the wrong base": the surviving *paid* row was counted as an existing custom plan, so on re-acceptance **no schedule was created for the outstanding balance at all**. R500 paid on R1000, re-quoted to R5000 → one paid R500 milestone and R4500 owed against nothing.

Fixed: the "does a live plan exist?" check now excludes `paid` rows, and the auto split covers `total − SUM(paid milestones' expected_amount)`, labelled *Outstanding Balance – Deposit/Final*. Invariant now holds: `SUM(expected_amount over live rows) == total_amount`.

Two things the fix exposed and also resolved:
* A deposit confirms a booking, and the re-quote cascade only fired on `ACCEPTED` — so re-quoting a `CONFIRMED` (deposit-paid) booking moved `total_amount` while leaving the invoice and plan on the old figure, and the client could not re-accept (`accept-quote` requires `QUOTED`), stranding the booking. The cascade now covers `CONFIRMED`, and re-acceptance lands back on `CONFIRMED` when a deposit exists (a race-free `CASE` in the compare-and-swap). **Owner decision: push back to QUOTED and require explicit re-acceptance of the new total.**
* `alignMilestonePayments` was rewriting *every* schedule row including superseded ones, so a payment after a re-quote would have resurrected them. Now operates on live rows only. See `phase3_contract_invoice_payment_review.md`.

---

## 4. Verification

| Suite | Result |
|---|---|
| Phase 2 (this change) | 28/28 |
| Transaction migration (`b464865`) | 29/29 |
| Phase 1 intake | 21/21 |
| 8 distinct concurrent bookings | 8/8, no 5xx |
| Duplicate-booking race | exactly 1 winner |

Against the preceding commit the Phase 2 suite scored 19/28, failing precisely on: re-acceptance producing no invoice, the missing `-R2` number, the rolled-back re-quote superseding schedules and voiding the invoice, the phantom audit row, the oversized `vat_number`, and the booking left `ACCEPTED` by it.

Two Phase 2 assertions passed on the old code and are therefore hardening rather than proven fixes: the compare-and-swap under concurrency (P2-5), and the invoice PDF filename (which always used the ledger number — it was the PDF *header* that disagreed).

---

## 5. What changed in the database

Nothing. No migration, no schema change. `invoices.invoice_number` remains `TEXT UNIQUE NOT NULL`; the revision suffix lives inside the existing column, and the 19 existing invoice numbers are untouched.
