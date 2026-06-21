# Phase 1 — Request & Intake: Test & Close Gaps (v2 — re-audited against latest code)

## Changelog from v1

This phase was substantially rewritten since the last audit. Most of v1's flagged
gaps in the manual-booking route are now **fixed**. What follows reflects the
current code, not the prior version — don't carry over v1's gap list as-is.

## 0. Phase boundary

Covers booking creation only: a `bookings` row reaching `status = 'NEW'` via
either entry point. Ends before quoting begins (Phase 2).

- **Public**: `POST /api/public/bookings` (server.js ~3099–3413)
- **Admin/manual**: `POST /api/admin/bookings` (server.js ~7235–7416)

## 1. Confirmed implementation (re-audited against the latest upload)

**Public path is unchanged from the prior audit** — same validation order,
duplicate check, working-hours/overlap checks, service/pricing snapshot,
`hasCalendarConflict()`, `BEGIN IMMEDIATE` transaction with in-lock re-check,
`booking_services`/`booking_line_items` writes, async Google Calendar sync with
admin-alert-on-failure, and a notification dispatch on success.

**One thing worth re-testing rather than assuming**: notification dispatch no
longer sends email directly. `server.js` now requires `./js/emailService`
instead of having its own `sendEmail`. `emailService.sendEmail()` **queues** the
message into the `notifications` table (`status='pending'`) rather than sending
it — a separate `processNotificationQueue()` loop (server.js ~849, run on a
20-second `setInterval`) picks up to 10 pending email rows per tick, flips them
to `'sending'` immediately (to prevent double-send), then calls
`emailService.sendEmailDirectly()` for the actual SMTP send. **This means every
"email sent" step documented in this phase (and the others) now has up to ~20
seconds of queue latency, and a real failure mode that didn't exist before**: a
notification can get stuck in `'pending'` or `'sending'` if the queue processor
crashes mid-batch. Test for this explicitly (see test plan).

**Manual/admin path — largely rewritten, now much closer to parity with public:**
1. Requires `name, email, cell, event_date, event_name, event_type, event_location, message` — same as before
2. **Now requires `services[]`** (400 if missing/empty) — previously optional/absent entirely
3. **Now validates each service** (exists, computes pricing via the same flat/per_minute/per_hour model logic as the public route) and computes `calculatedBaseScope`
4. **Now computes real event duration** from service `performance_length_minutes` + `setup_time_minutes`
5. **Now calls `hasCalendarConflict()`** before and again inside the `BEGIN IMMEDIATE` lock — returns 409 with `conflict: true` unless the request includes `override_conflict: true`
6. **`total_amount`, `amount_outstanding`, `quote_amount` are now properly initialized** from the computed pricing — no longer `NULL`
7. **`performance_end_time` is now computed and stored** (previously never set)
8. **Google Calendar sync now fires** (`syncBookingToCalendar`, non-blocking)
9. `audit_log` entry created (unchanged)

**What's still missing from the manual path, confirmed by direct comparison with the public route:**
- **No duplicate-booking check** (same email + date + active status) — the public route has this, the manual route does not
- **No working-hours enforcement** (`isWithinWorkingHours`) — public route has it, manual route does not
- **`popia_consent` is still hardcoded to `1`** in the INSERT, regardless of whether the actual client consented to anything
- **`validStatuses = ['NEW','PENDING','QUOTED','CONFIRMED']` still allows direct `CONFIRMED` creation** with zero payment on record — now at least correctly *priced* (so it won't slip through Phase 4's guard with `NULL` financials), but an admin can still mark a booking `CONFIRMED` on creation with `amount_paid = 0`. Confirm with the business owner whether this is intended (e.g., "confirmed pending invoice" workflows are common) or should be blocked.

## 2. Non-negotiable constraints

- Do not remove `override_conflict` — it's the correct pattern (matches the public
  route's spirit while preserving admin override capability) and should not be
  re-litigated, only extended to cover the remaining gaps below the same way.
- Do not change the public path.
- Any fix must write to `audit_log` when an override is used — confirm this
  already happens for `override_conflict` (it should, via the existing generic
  audit_log insert) and apply the same pattern to any new override flags added
  for duplicate-check or working-hours bypass.

## 3. Test plan — does Phase 1 work as documented?

| Case | Steps | Expected |
|---|---|---|
| Normal — public | Submit valid booking | Unchanged from before: 200, `NEW`, services snapshotted, calendar synced |
| Normal — manual | Create booking via admin route with services, no conflict | 200, `NEW`, correctly priced `total_amount`/`amount_outstanding`, calendar event created |
| **Re-verify — manual conflict handling** | Create a manual booking for a date/time that conflicts with an existing confirmed booking, no `override_conflict` | 409 with `conflict: true` |
| **Re-verify — manual conflict override** | Same, with `override_conflict: true` | 201/200, booking created, confirm `audit_log` records that the override was used |
| **Still-open — duplicate check** | Create two manual bookings, same email + date | Currently both succeed (no duplicate guard) — confirm this reproduces, then treat as a gap to close, matching the public route's behavior |
| **Still-open — working hours** | Create a manual booking at 3am | Currently succeeds (no working-hours check) — confirm and treat as a gap |
| **Still-open — direct CONFIRMED** | Create a manual booking with `status: 'CONFIRMED'`, no payment | Currently succeeds — confirm with the business owner whether this is intended before "fixing" it |
| **New — queue latency** | Submit a public booking, immediately check `notifications` table | Row should exist with `status='pending'` initially, transitioning to `'sending'` then presumably `'sent'`/`'success'`-equivalent within ~20s — confirm the actual terminal status value used (the queue processor code wasn't fully read in this pass; confirm what status it sets on success vs. the `email_logs` table's separate `'success'`/`'failed'` values, since there appear to be two different logging mechanisms — `notifications.status` and `email_logs.status` — verify they stay consistent with each other) |
| **New — queue failure mode** | Force `sendEmailDirectly` to throw (e.g. invalid SMTP creds in a test environment) | Confirm the notification row doesn't get stuck in `'sending'` forever — there should be either a retry mechanism or a transition to a `'failed'` state; if neither exists, that's a gap |

## 4. Gaps to close

### Gap 1 (re-scoped) — Manual path still lacks duplicate-booking and working-hours checks
Lower severity than v1's finding (the dangerous parts — no pricing, no calendar
check, no Google Calendar sync — are fixed), but still real. Add the same
`existingBooking` duplicate query and `isWithinWorkingHours` call used in the
public route, gated behind the same `override_conflict` flag (or a new,
separately-named override if you want granular control over which checks an
admin can bypass).

### Gap 2 — `popia_consent` still not real consent on the manual path
Unchanged from v1. Add a `consent_source` column (`'public_form' |
'admin_recorded'`) distinguishing the two.

### Gap 3 — Direct-to-CONFIRMED manual creation with no payment (decision gate)
Not a regression — this was already possible in v1 and remains possible. Needs
a business decision, not a unilateral fix: should manual booking creation be
allowed to set `CONFIRMED` at all, or should it cap at `QUOTED`/`ACCEPTED` and
require the payment routes (which now correctly gate `CONFIRMED` behind
`ACCEPTED`-or-better status) to be the only path to `CONFIRMED`?

### Gap 4 (new) — Notification queue failure visibility
Confirm whether a notification stuck in `'pending'` or `'sending'` for an
extended period (queue processor down, crashed mid-batch, etc.) ever surfaces
to an admin. If not, add a check (could piggyback on the existing cron
infrastructure) that alerts when notifications are older than, say, 10 minutes
and still not `'sent'`.

## 5. Acceptance criteria

- [ ] Manual booking route enforces duplicate-booking and working-hours checks, matching the public route, with an override path
- [ ] `consent_source` distinguishes client vs. admin-recorded consent
- [ ] Direct-to-CONFIRMED manual creation is either confirmed-intended or blocked, per the business decision
- [ ] Stuck notifications (queue failures) are surfaced to an admin, not silent
- [ ] Public path behavior is unchanged (regression check)

## 6. Test matrix (post-fix regression)

| Case | Expected after fix |
|---|---|
| Manual booking, duplicate email+date | Rejected or requires override, matching public route |
| Manual booking, 3am with no working-hours override | Rejected or requires override |
| Manual booking, `status: CONFIRMED`, no payment | Behavior matches whatever the Gap 3 decision resolved to |
| Notification queue processor down for 15+ minutes with pending emails | Admin alerted |
| Public booking flow | Unchanged |
