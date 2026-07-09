# Phase 4 — Event Execution & Completion: Test & Close Gaps (v2 — re-audited against latest code)

## Changelog from v1 — two of three flagged gaps are now resolved

1. **Gap 2 from v1 (no alerting for stuck CONFIRMED+unpaid bookings past event
   date) is fixed.** A new cron ("4. Overdue payment reminder", server.js
   ~1311–1329) sends a batched admin digest email for exactly this scenario,
   with `overdue_reminded_at` tracking to avoid re-spamming within 7 days.
2. **Gap 3 from v1 (refund execution path unconfirmed) is now a confirmed,
   reproducible bug, not an open question.** A dedicated, otherwise well-built
   refund endpoint exists — and fails every time it's called, because it
   writes a `refund_status` value the database's own `CHECK` trigger rejects.
   See section 1 for the exact line and fix.
3. **A significant correction to v1's core model**: `events` rows are **no
   longer exclusively tied to public/ticketed promotion**. Re-read section 1.

## 0. Phase boundary

Starts at `bookings.status = 'CONFIRMED'`. Covers the run-up to the event date,
automatic completion, and what happens after.

## 1. Confirmed implementation (re-audited against the latest upload)

**Correction to v1: `events` rows are now auto-created on every CONFIRMED
transition, not just public promotion.** Inside `applyStatusChange()`
(server.js ~7546+), when `requestedStatus === 'CONFIRMED'` and the booking has
no `event_id` yet, an `events` row is inserted automatically
(`event_status: 'upcoming'`, `created_by: 'system'`) and linked back via
`bookings.event_id`. The original public-promotion path (`is_public` toggle,
server.js ~8133+) still exists separately and **was confirmed to handle this
correctly** — if `booking.event_id` already exists (from the auto-create on
confirmation), promoting to public *updates* that same row instead of creating
a duplicate. No duplicate-events risk found.

**This auto-create only happens via `applyStatusChange()`** — i.e., the admin
manual status-change route (`PUT /api/admin/bookings/:id`). **It does not
happen** when a booking reaches `CONFIRMED` via the PayFast ITN handler or the
manual-payment route, since both of those write `status='CONFIRMED'` directly
via raw SQL, bypassing `applyStatusChange()` entirely. **This is a newly
discovered inconsistency, not something v1 could have found** (the
auto-create logic didn't exist in the version v1 was audited against):
a booking confirmed by an admin manually changing its status gets an `events`
row; a booking confirmed by a client paying via PayFast does not. Confirm this
reproduces — see test plan.

**Automatic completion (S6 cron, server.js ~1249–1269)** — same trigger
condition as v1 (`CONFIRMED + PAID + date < today`), but now additionally:
- Sends `sendBookingCompletedEmail()` to the client (wasn't documented in v1)
- The events-sync line (`UPDATE events ... WHERE event_id = ?`) is unchanged

**Manual completion** still shares `applyStatusChange()`'s outstanding-balance
guard (`amount_outstanding > 0.01` blocks `COMPLETED`) — unchanged from v1, and
**also now**, on reaching `COMPLETED` via `applyStatusChange()`:
- Sends two emails: `sendBookingCompletedEmail()` (client) and
  `sendAdminCompletionSummaryEmail()` (admin) — both new since v1
- Auto-marks the linked invoice `PAID` if not already (`status NOT IN
  ('VOID','PAID')`) — new since v1, a reasonable safety net given the
  outstanding-balance guard already confirmed full payment

**Cancellation, now with real refund calculation** (server.js ~7594–7610): on
`CANCELLED`, fetches the `cancellation_policy` setting, runs
`calculateCancellationRefund(booking, policy)`, and upserts into
`cancellations` with `refund_due`, `retention_amount`, and `refund_status:
'pending'`. The column is added via migration (`database.js` ~1124:
`ALTER TABLE cancellations ADD COLUMN refund_status TEXT DEFAULT 'pending'`),
confirmed to exist — and is protected by two `CHECK`-style triggers
(`database.js` ~1476–1485) that only permit `refund_status` to be one of
`'pending', 'processing', 'processed', 'failed', 'cancelled'` on insert or update.

**A dedicated refund-recording endpoint exists and is genuinely well-built**:
`PUT /api/admin/bookings/:id/refund` (server.js ~5045–5076). It validates the
refund amount isn't negative or larger than `total_paid_to_date`, requires a
payment reference when an amount is given, and — critically — records a
`transactions` row with `transaction_type: 'refund'` and then recalculates
`amount_paid` from `SUM(transactions)` rather than doing arithmetic
subtraction, specifically to avoid ledger drift. This is the correct design.

**But it's confirmed broken**: the `UPDATE cancellations SET refund_status =
'refunded', ...` statement (line ~5066) writes the literal string `'refunded'`
— which is **not** in the trigger's allowed list (`pending / processing /
processed / failed / cancelled`). Every call to this endpoint with a non-zero
refund amount will hit the `BEFORE UPDATE` trigger's `RAISE(ABORT, 'Invalid
cancellations.refund_status value')` and fail, surfacing to the admin as a
generic 500 (`if (upErr) return res.status(500)...`). **This is not a
hypothetical — it's a confirmed, reproducible, currently-broken feature.** The
fix is a one-word change (`'refunded'` → `'processed'`, matching the allowed
vocabulary), but it needs to be paired with checking the frontend: if
`admin.html` has any code expecting `refund_status === 'refunded'` as a
string (e.g., to render a "Refunded" badge), that needs to change too, or the
UI will never recognize a successful refund even after the backend is fixed.

**Cross-phase risk from Phase 1's v1 Gap 2 (NULL `total_amount` slipping past
the completion guard) is now substantially mitigated**, since the manual
booking route (Phase 1) properly initializes pricing. Still worth a regression
test (below) rather than assuming closed, since the completion guard itself
wasn't changed to add a defense-in-depth `total_amount IS NOT NULL` check — it
relies entirely on Phase 1 never producing a `NULL` again.

## 2. Non-negotiable constraints

- Do not change the outstanding-balance guard's `0.01` tolerance.
- Do not make the auto-event-creation universal across all three confirmation paths without confirming with the project owner whether payment-triggered confirmations *should* get an events row — it's plausible this is intentional (a `CONFIRMED`-via-payment booking might not need a calendar/public event the same way an admin-confirmed one does), so treat this as a question to resolve, not an assumed bug.
- Do not touch the cancellation refund calculator's formula — only investigate whether its output (`refund_status`) is ever advanced past `'pending'`.

## 3. Test plan — does Phase 4 work as documented?

| Case | Steps | Expected |
|---|---|---|
| Normal | CONFIRMED+PAID booking, event date passed | S6 auto-completes it, sends completion email, marks linked invoice PAID if not already |
| **New — events auto-creation via admin transition** | Admin manually transitions a booking `ACCEPTED → CONFIRMED` via `PUT /api/admin/bookings/:id` | `events` row auto-created, `bookings.event_id` set |
| **New — events auto-creation via payment** | Booking reaches `CONFIRMED` via PayFast deposit or manual full payment instead | Confirm whether `events.event_id` stays `NULL` — reproduce the inconsistency described above |
| **Confirmed bug — reproduce it** | Cancel a booking with `total_paid_to_date > 0`, then call `PUT /api/admin/bookings/:id/refund` with a valid `refund_amount` and `refund_reference` | Currently fails: 500 response, the `cancellations` UPDATE is rejected by the database's own `CHECK` trigger because `'refunded'` isn't in its allowed vocabulary |
| **Confirmed bug — verify the fix** | After changing `'refunded'` → `'processed'` in the route | Same request now succeeds: `refund_status='processed'`, `refunded_at` set, a `transactions` row with `transaction_type='refund'` exists, and `amount_paid` is recalculated from `SUM(transactions)` |
| Edge | CONFIRMED, PARTIALLY_PAID, event date passed | Should not auto-complete (unchanged) — now also confirm the new overdue-payment cron digest actually includes this booking |
| Edge | Manually-created CONFIRMED booking (Phase 1, properly priced now) reaches its event date unpaid | Appears in the overdue-payment digest, does not auto-complete |
| Regression | Booking auto-completes via S6 | `bookings.status='COMPLETED'`, linked `events.event_status='completed'` (if an event_id exists), invoice marked PAID, completion email sent |

## 4. Gaps to close

### Gap 1 (new) — Inconsistent `events` row creation across the three CONFIRMED paths
**Impact analysis:**
- *Database*: no schema change.
- *Backend*: either extract the events-auto-create block from
  `applyStatusChange()` into a shared helper and call it from the PayFast ITN
  handler and `processManualPayment` too when their status update results in
  `CONFIRMED`, or confirm this is intentional (payment-confirmed bookings
  don't need an events row) and document why, so it's not rediscovered as a
  "bug" later.
- *Frontend*: any admin.html view that expects every `CONFIRMED` booking to
  have a linked event (e.g., a calendar view driven by the `events` table
  rather than `bookings.date`) would silently miss payment-confirmed bookings
  — check `calendarAdmin`/`eventsAdmin` for this assumption before deciding
  this is low-priority.

### Gap 2 (re-scoped from v1, now fully confirmed) — Refund endpoint writes an invalid `refund_status` value
**Impact analysis:**
- *Database*: no schema change needed — the trigger's allowed vocabulary
  (`pending/processing/processed/failed/cancelled`) is reasonable as-is; the
  application code is what's wrong.
- *Backend*: change `PUT /api/admin/bookings/:id/refund` (server.js ~5066) to
  write `'processed'` instead of `'refunded'`. Consider also using
  `'processing'` as an intermediate state if refund execution is ever made
  asynchronous (e.g., calling a PayFast refund API rather than just recording
  a bank transfer reference) — out of scope for the immediate fix, but worth
  designing the column's usage with that in mind.
- *Frontend*: search `admin.html` for any `refund_status === 'refunded'` (or
  similar string match) used to drive a badge, filter, or conditional render.
  Update to match `'processed'`, or the UI will keep showing cancellations as
  unrefunded even after this fix ships.

This is the highest-priority item in this phase — it's not a hypothetical risk,
it's a feature that fails every time it's used.

## 5. Acceptance criteria

- [ ] `events` row creation is consistent across all three paths to `CONFIRMED`, or the inconsistency is explicitly confirmed as intentional and documented
- [ ] `PUT /api/admin/bookings/:id/refund` writes a `refund_status` value that's actually in the trigger's allowed list, and the request no longer 500s
- [ ] `admin.html` reflects the corrected `refund_status` value wherever it's displayed
- [ ] Overdue-payment digest cron is confirmed to include manually-created bookings from Phase 1, not just publicly-submitted ones

## 6. Test matrix (post-fix regression)

| Case | Expected after fix |
|---|---|
| Booking confirmed via admin transition | Events row created (unchanged) |
| Booking confirmed via PayFast/manual payment | Events row created consistently — or documented as intentionally not, per the resolved decision |
| Record a refund via the dedicated endpoint | Succeeds, `refund_status='processed'`, transaction recorded, `amount_paid` recalculated correctly |
| Admin views a cancelled-and-refunded booking | UI correctly shows it as refunded |
