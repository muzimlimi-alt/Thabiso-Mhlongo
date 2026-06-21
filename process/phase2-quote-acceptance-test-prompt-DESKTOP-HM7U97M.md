# Phase 2 — Quote & Acceptance: Test & Close Gaps (v2 — re-audited against latest code)

## Changelog from v1

Smaller changes than Phase 1, but two real ones: payment-schedule creation now
preserves admin-configured milestones instead of always forcing a 50/50 split,
and there's a new accepted-status value (`RESPONDED`) that doesn't appear in the
formal state machine — worth resolving before testing further.

## 0. Phase boundary

Starts where Phase 1 ends (`bookings.status = 'NEW'` or `'PENDING'`). Covers
quote generation through client acceptance, ending at `status = 'ACCEPTED'`.
Acceptance still triggers payment-schedule and invoice creation that overlaps
into Phase 3 — test the handoff, not just the status field.

## 1. Confirmed implementation (re-audited against the latest upload)

**Quote generation** — `POST /api/admin/bookings/:id/quote` (server.js ~8285+):
opening structure (legacy vs. structured mode, expiry validation, VAT/discount
calc, versioned `quotations` insert, line-item refresh, calendar sync, email
dispatch) is unchanged from the prior audit. Treat as confirmed-stable; re-test
only if you find evidence otherwise.

**Quote acceptance** — `POST /api/public/bookings/:id/accept-quote` (server.js
~4347–4429). Confirmed changes from the prior audit:

- **Now accepts both `'QUOTED'` and `'RESPONDED'` as valid current-status values**
  (`if (!['QUOTED', 'RESPONDED'].includes(row.status))`). `'RESPONDED'` does
  **not** appear in `ALLOWED_TRANSITIONS` (Phase 4's state machine) at all —
  there's no transition into it documented anywhere in `applyStatusChange`.
  **This needs investigation before anything else in this phase**: find where
  (if anywhere) a booking's status actually becomes `'RESPONDED'`, and whether
  this is a legitimate parallel status path or dead code left over from a
  rename. If nothing ever sets it, this branch is harmless but confusing; if
  something does set it outside `ALLOWED_TRANSITIONS`, that's a second
  state-machine bypass alongside the cron jobs (see Phase 4).
- **Payment-schedule creation is now conditional**: before auto-creating the
  50/50 deposit/balance split, it checks `SELECT COUNT(*) FROM payment_schedules
  WHERE booking_id = ?` — if an admin already configured custom milestones,
  those are preserved and the 50/50 default is skipped entirely. This closes
  what would have been a real gap (custom payment plans silently overwritten).
- **Audit log entry added** (`action: 'QUOTE_ACCEPTED'`) — wasn't present before.
- Invoice auto-generation (`generateInvoice()`), calendar sync, and the
  client/admin email dispatch sequence are otherwise unchanged, **including the
  same unresolved issue**: if `generateInvoice()` throws, the error is caught
  and logged but the flow continues as if it succeeded, and the client-facing
  response still says "your invoice has been generated and emailed to you."

**Quote-revision-request** (server.js ~4432+) and the quote-expiry cron were not
re-read line-by-line in this pass — the cron's existence and basic trigger
condition (`status='QUOTED' AND quote_expiry_date < today`) were confirmed via
the scheduler block, including a **new 24-hour pre-expiry warning email**
(`sendQuoteExpiryWarningEmail`, tracked via a `quote_expiry_warned` column) that
wasn't documented before. Audit the revision-request route body directly before
writing detailed tests against it.

## 2. Non-negotiable constraints

- Do not change the versioned-quotation archiving logic.
- Do not weaken the email-match acceptance check without an explicit decision — still flagged as Gap 1 below, still a decision gate, not a unilateral fix.
- Do not change the new conditional payment-schedule logic — preserving admin-configured milestones is correct, keep it.
- Do not move invoice generation out of the acceptance flow without confirming with the business owner, for the same reason as v1 (the client-facing response text makes a promise).

## 3. Test plan — does Phase 2 work as documented?

| Case | Steps | Expected |
|---|---|---|
| Normal | Admin builds and sends a structured quote | Unchanged: `QUOTED`, versioned `quotations` row, emails sent |
| Normal | Client accepts with matching email, no pre-existing payment schedule | `ACCEPTED`, 50/50 schedule auto-created, invoice generated, audit log entry present |
| **New — custom milestones preserved** | Admin manually creates 3 custom `payment_schedules` rows for a `QUOTED` booking, then the client accepts | Confirm the 3 custom rows survive untouched and no 50/50 rows are added |
| **New — investigate RESPONDED** | Search the codebase for every place `'RESPONDED'` is written to `bookings.status` | Document the actual trigger (or confirm none exists and this is dead code) before relying on it in any other test |
| Edge | Re-quote an already-`ACCEPTED` booking | Same as v1: confirm whether the existing `payment_schedules`/invoice from the original acceptance are reconciled or left stale (still an open gap, see below) |
| Failure | `generateInvoice()` forced to fail during acceptance | Same as v1: client still gets told the invoice was generated — confirm this still reproduces |

## 4. Gaps to close (carried forward, still open) + one new item

### Gap 1 — Acceptance auth is email-only (unchanged, still open)
Same as v1. No second factor beyond matching the stored email address.

### Gap 2 — Acceptance email can overpromise on invoice-generation failure (unchanged, still open)
Same as v1.

### Gap 3 — Re-quoting an ACCEPTED booking doesn't reconcile payment schedules (status unclear, re-verify)
v1 flagged this against the old unconditional-50/50 logic. With the new
conditional logic (skip auto-creation if schedules already exist), re-quoting
an accepted booking with a different total now leaves the *existing* schedule
rows completely untouched (previously they'd at least get silently
overwritten by a fresh, also-wrong 50/50 split based on the old amount — now
they're not touched at all). Functionally similar problem, slightly different
mechanism. Still needs the same decision gate from v1: force re-acceptance, or
build proportional reconciliation.

### New — Gap 4: undocumented `RESPONDED` status
See the investigation task in the test plan. This needs to be resolved (either
documented as legitimate or removed as dead code) before it can be called
either "working as intended" or "a gap."

## 5. Acceptance criteria

- [ ] `RESPONDED` status is either documented with its actual trigger path and added to `ALLOWED_TRANSITIONS`, or removed as dead code
- [ ] Quote acceptance requires more than email-match alone, or this is explicitly confirmed as acceptable risk
- [ ] Acceptance email is never sent claiming an invoice exists if generation actually failed
- [ ] Re-quoting an `ACCEPTED` booking has defined, tested behavior for payment-schedule reconciliation

## 6. Test matrix (post-fix regression)

| Case | Expected after fix |
|---|---|
| Quote acceptance via the (now-investigated and either fixed-or-confirmed) RESPONDED path | Behaves consistently with the documented state machine |
| Custom milestone preservation | Unaffected by any of the above fixes (regression check) |
| Re-quote an ACCEPTED booking | Schedules reconcile per whichever decision was made |
