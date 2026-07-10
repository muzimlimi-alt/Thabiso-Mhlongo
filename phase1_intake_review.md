# Phase 1 — Booking Request Intake: Architecture, QA & Optimisation Review

**Scope:** `POST /api/public/bookings` (server.js), the booking wizard in `index.html` / `js/myscript.js`, and the `bookings` / `clients` / `venues` / `consent_audit` / `audit_log` / `abandoned_bookings` tables.
**Date:** 2026-07-09 (revised — see the correction in §3, G12)
**Method:** static review of the implementation, schema inspection against the live `database.sqlite`, and behavioural testing of the endpoint against a running server — each defect reproduced on the pre-fix build and re-tested after the fix.

---

## 1. Assessment of the current workflow

The reference diagram describes five sequential steps. **The implementation is materially more advanced than the diagram suggests**, and most of the automation an analyst would normally recommend is already built:

| Capability | Diagram | Reality |
|---|---|---|
| Multi-step form | not shown | 4-step wizard with progress bar |
| Draft autosave | not shown | debounced autosave + `navigator.sendBeacon` on exit |
| Resume abandoned booking | not shown | `abandoned_bookings` + `resume_token` links |
| Abandoned-booking reminders | not shown | scheduled reminder + purge jobs, opt-out link |
| Duplicate detection | not shown | pre-submit lookup + server-side `(email, date)` rule |
| Real-time validation | not shown | `blur` handlers on name/email/cell/location/event |
| Contact prefill | not shown | prefills from last consented booking |
| Consent audit | "Validated" | dedicated immutable `consent_audit` table |
| Audit trail | not shown | `audit_log` CREATE row per booking |
| Calendar sync | "calendar sync" | Google Calendar insert + admin alert on failure |
| Availability | one box | `date_holds` + standalone `events` + bookings + Google free/busy |

So the honest conclusion is: **Phase 1 does not need more automation. It needs correctness.** The steps in the diagram are all necessary, none is redundant, and the sequence is sound. What the review found instead is a cluster of defects in *how* those steps execute — several of which silently destroy bookings.

The one structural change worth making, and the one I made, is to **reorder** the steps so that every rejection happens before the first database write.

### Current sequence (pre-fix)

```
validate → check availability → duplicate check → working hours → time overlap
   → CREATE CLIENT + CREATE VENUE          ← first writes
   → validate services (can reject!)       ← leaves orphans behind
   → lead-time / per-day / quantity rules  ← leaves orphans behind
   → calendar conflict (can reject!)       ← leaves orphans behind
   → BEGIN IMMEDIATE → insert → COMMIT
   → side effects
```

### Optimised sequence (implemented)

```
normalise + validate  (types, lengths, date sanity, time format, consent)
   → validate services + snapshot pricing        ┐
   → compute ONE occupancy window                │ read-only.
   → date availability                           │ no writes.
   → duplicate (email, date)                     │ any rejection here
   → working hours                               │ costs nothing.
   → time overlap                                │
   → calendar conflict (local + Google)          ┘
   → find/create client + venue                  ← first writes
   → withDbTransaction:
        BEGIN IMMEDIATE
        re-check availability / conflict / duplicate under the lock
        insert booking + consent_audit + audit_log + services + line items
        COMMIT
   → side effects (calendar, emails, draft→recovered) — never block the response
```

---

## 2. Bugs identified and fixed

Every row below was reproduced on the pre-fix build. "Evidence" is the observed pre-fix behaviour.

### B1 — Concurrent bookings were lost with HTTP 500 *(critical)*

`node-sqlite3` multiplexes all requests over a **single connection**, and a transaction is a property of the connection, not the request. A second `BEGIN IMMEDIATE` issued while another request's transaction is open fails outright, and the handler mapped that to a generic 500.

**Evidence.** Eight simultaneous submissions from eight *distinct* clients on eight *distinct* dates — no business reason to reject any of them:

```
pre-fix:   1 × 200, 7 × 500 "Database error while saving booking."   → 1 booking persisted
post-fix:  8 × 200                                                    → 8 bookings persisted
```

Seven leads were dropped with no row in `bookings`, no `abandoned_bookings` draft, and nothing in the logs beyond `Status: 500`. The client saw "Database error while saving booking."

A second, worse consequence of the same root cause: statements from an *unrelated* request that interleave with an open transaction get swept into it, and are discarded by its `ROLLBACK`.

**Fix.** Guarded transactional sections queue behind `withDbTransaction()`, making `BEGIN → COMMIT/ROLLBACK` atomic with respect to other guarded sections. The transaction body was rewritten promise-first (`dbRun` / `dbGet`) so `ROLLBACK` and the queue slot are released on every exit path, including throws. Retested at 8-way concurrency across 5 rounds.

**All 9 transaction sites are now migrated (commit `b464865`)** — `generateInvoice`, `POST /api/admin/bookings`, admin cancel, public cancel, quote generation, newsletter CSV import, GDPR anonymization, plus the public intake and the booking delete. Measured with 3 public + 3 admin bookings fired simultaneously, all independent:

```
before:  1 × 200, 5 × 500 "cannot start a transaction within a transaction"  → 1 of 6 persisted
after:   6 × 200                                                              → 6 of 6 persisted
```

See §2b for the three further bugs that migration exposed.

### B2 — Bookings could be created in the past *(high)*

`event_date` was format-checked (`YYYY-MM-DD`) but never compared to today. The only date sanity check in the handler was the **per-service lead time**, and that check is skipped entirely when `booking_lead_time_days = 0` — true for 13 of 30 rows in `services`, 4 of them active and bookable.

**Evidence.** A booking dated `2020-01-01` returned `200 {"success":true}` and was persisted.

**Fix.** Reject past dates, impossible dates (`2026-02-31`), and dates more than 5 years out.

### B3 — Rejected submissions left orphan `clients` and `venues` rows *(high)*

`findOrCreateClient()` and `findOrCreateVenueFromPlace()` ran *before* service validation, lead-time, per-day, quantity and calendar-conflict checks. Each of those gates returns 400/409 with no cleanup.

This matters more than it looks: `clients.email` is `UNIQUE`, so a junk row created by a rejected submission **permanently occupies that email**, and the next legitimate signup from the same address silently binds to it.

**Evidence.** Six rejected submissions → `clients` 46 → 51, `venues` 44 → 45.

**Fix.** All read-only gates now run before the first write.

### B4 — Duplicate `(email, date)` rule was not enforced under the lock *(medium)*

The `(email, date)` duplicate check ran before `BEGIN IMMEDIATE` but was never repeated inside it. The in-lock re-check that *did* exist (`hasCalendarConflict`) skips rows with a `NULL event_start_time`, so two concurrent **untimed** submissions for the same date could not collide there.

**Note on evidence:** I could not force a double-insert — Node's single thread plus SQLite's write lock make the window narrow, and in practice the collision surfaced as B1's 500 instead. The window is real by inspection; the re-check closes it deterministically. Post-fix, 8 concurrent identical submissions yield exactly `1 × 200, 7 × 409` and one persisted row.

### B5 — A database read error was reported as "date no longer available" *(medium)*

`checkDateAvailability()` calls back with `(err)` and **no result**. The pre-lock caller did `resolve(result)` and then read `.available` off `undefined`. The in-lock caller did `resolve(r || { available: false })` — turning a transient `SQLITE_BUSY` into a hard "the selected date is no longer available", sending a client away from a date that is in fact free.

**Fix.** Read failures and unavailable dates are now distinct: `503` ("we couldn't confirm availability, try again") vs `409`.

### B6 — `event_start_time` was never validated *(medium)*

The value flowed unchecked into `moment()`, `addMinutesToTime()` and the working-hours gate. `"abc"` produced `"NaN:NaN"` end times and an Invalid-date ISO conversion.

**Evidence.** `event_start_time: "abc"` returned `200` and was stored.

**Fix.** Must match `HH:MM` (24-hour); zero-padded on write, so `"9:00"` and `"09:00"` no longer compare differently.

### B7 — Non-string JSON values crashed the handler *(medium)*

`name.trim()`, `cell.replace()` and `message.trim()` were called before any type check.

**Evidence.** `{"name": ["a","b"]}` → `500 name.trim is not a function`.

**Fix.** All free-text fields are coerced and trimmed once, up-front; non-scalars collapse to `''` and fall through to the required-field check as a clean 400.

### B8 — No length cap on 17 free-text columns *(medium, availability)*

`message` was capped at 2000 characters. `company`, `event_name`, `event_location`, `venue_address`, `city`, `country`, `venue_type`, `event_type`, `audience_size`, `audience_demographic`, `budget_range`, `performance_slot`, `performance_duration`, `vat_number`, `policy_version`, `source` and `referrer` were not, and SQLite `TEXT` has no length constraint. A single request could write megabytes.

**Fix.** Per-column caps enforced before the first write.

### B9 — The working-hours gate and the stored end time used different durations *(medium)*

Working hours were validated against the **form's** `performance_duration`; `performance_end_time` — the value every *later* booking is conflict-checked against — was computed from the **service catalogue** duration. A booking could pass the gate and then persist an end time outside working hours.

**Evidence.** Form duration 90 min → stored `performance_end_time` was `11:00` (120-min default), not `10:30`.

**Fix.** One occupancy window, `max(catalogue, form)`, drives the gate, the conflict window and the stored end time.

### B10 — `performance_start_time` was left NULL on timed bookings *(low)*

Only the `performance_slot` branch wrote `performance_start_time`. Both `event_start_time` branches wrote `performance_end_time` alone.

**Evidence.** A booking with `event_start_time: "9:00"` persisted `performance_start_time = NULL`, `performance_end_time = "11:00"`.

### B11 — `travel_accommodation` stored NULL instead of 0 *(low)*

`travel_accommodation || null` turns `false` into `NULL` on a `BOOLEAN DEFAULT 0` column.

### B12 — `audit_log.ip_address` was NULL for every public submission *(low, compliance)*

The column exists and was never populated on the intake path. Now stamped from `req.ip`.

---

---

## 2b. Bugs the transaction migration exposed *(commit `b464865`)*

Rewriting each transaction promise-first surfaced defects the callback style had been hiding. Errors that were previously passed to a callback nobody checked now throw. Each was reproduced on the preceding commit.

### B13 — Admin cancellation has never worked *(critical)*

`POST /api/admin/bookings/:id/cancel` writes `payment_status = 'CANCELLED'`. The `chk_bookings_payment_status_update` trigger permits only `UNPAID | DEPOSIT_PAID | PARTIALLY_PAID | PAID | REFUNDED | FAILED`, so the statement aborts and takes `status` and `cancelled_at` with it.

**Evidence.** Against the previous commit:

```
POST /api/admin/bookings/100044/cancel
  → 500  {"message":"SQLITE_CONSTRAINT: Invalid bookings.payment_status value"}
  booking after:  {"status":"NEW","payment_status":"UNPAID"}
  cancellations rows: 0
```

The same statement appears in the status-change cancel path (`server.js:9203`) with **no error callback**, so the `ABORT` silently discarded `cancellation_reason` and `cancelled_by` as well.

**Fix.** `payment_status` is no longer written on cancellation. It is not a legal value, and the real payment state must survive cancellation anyway — the refund owed is computed from what the client actually paid. This matches the public cancel route, which never touched the column, and the four existing `CANCELLED` bookings, which retain `UNPAID`/`DEPOSIT_PAID`/`PAID`. Nothing reads `bookings.payment_status === 'CANCELLED'` (the two apparent matches are PayFast's payload field, not the column).

This is the same defect class already catalogued for `notifications.status` and `payment_method` — one instance was missed.

### B14 — A failed invoice regeneration destroyed the live invoice *(high)*

`generateInvoice()` voided the booking's existing invoice **outside** the transaction, before the PDF was even generated. `invoices.invoice_number` is `INV-<YYYY>-<bookingId>`, `TEXT UNIQUE NOT NULL` — deterministic per booking per year — so regenerating within the same year always fails the insert.

**Evidence.** Regenerating an existing invoice on the previous commit left `sent=0, void=1`: the booking had no live invoice at all. After the fix, the same call leaves `sent=1, void=0` — the `VOID` is inside the transaction and rolls back with it.

The `UNIQUE` collision itself is **left alone**: invoice numbering carries statutory requirements (sequential, unique, non-reused), and changing the scheme is a finance decision, not a refactor. See §3, G13.

### B15 — The admin has never received a "quote sent" notification *(medium)*

`sendAdminQuoteSentNotification()` interpolates `${event_name}` into its email template but destructures `{ id, name, email, event_type, date }` — `event_name` is never bound. Every call threw `ReferenceError: event_name is not defined`, swallowed by the caller's `.catch()`.

**Evidence.** `[Quote] Admin notif failed: event_name is not defined` on every quote generation.

### Two latent faults removed by the rewrite rather than found

* The quote route issued a `ROLLBACK` and a 500 from the `DELETE` error callbacks while the `insertNext()` chain carried on regardless — a second response on the same request.
* The GDPR route wrapped callback-style `db.run()` calls in a `try/catch`, which cannot observe an async sqlite error. Every statement's failure was dropped and the route reported success even when nothing was anonymized. It now awaits each step and returns the affected row counts.

Post-`COMMIT` child writes moved inside their transactions: the admin booking route's `consent_audit`, services, line items and audit row (previously written after `COMMIT` with errors swallowed by a bare `console.error`, so a failure left a committed booking with no services while the route answered 200); the admin-cancel cascades (holds, invoices, payment schedules, events); and the quote audit row. The in-lock conflict re-check in `POST /api/admin/bookings` now passes `skipGoogle=true`, matching the public path — it was making a Google free/busy network call while holding the write lock.

---

## 3. Gaps and weaknesses — found, **not** fixed

These are reported rather than changed: each either touches financial reporting semantics, crosses into another phase, or is a schema migration that deserves its own change window.

### G1 — Unquoted enquiries inflate outstanding revenue — **FIXED (commit `dde0a4a`)**

Intake writes `amount_outstanding = calculatedBaseScope` on a `NEW` booking that has never been quoted, and `server.js:11524` summed every booking `NOT IN ('CANCELLED','EXPIRED')` into the all-time outstanding KPI. So every unquoted enquiry counted as a receivable. Impact was muted because `base_price` is `NULL` for most `flat_fee` services (→ 0), but a `per_hour` service such as *MC & Host – Hourly Rate* (R2 950) added its full estimate the moment someone submitted the form.

The query is now an allowlist of statuses that represent an accepted commitment:

```sql
WHERE status IN ('ACCEPTED', 'CONFIRMED', 'COMPLETED')
```

Today's figure is **unchanged at R138,925.01** — no `NEW`/`PENDING`/`QUOTED` bookings currently exist, so the change is zero-diff now and correct going forward. A `QUOTED` booking is deliberately excluded: a quote that has been sent but not accepted is not money owed.

The intake columns (`total_amount`, `amount_outstanding`) are left as written, so the admin pipeline still shows the catalogue estimate. Only the receivables aggregate changed.

The pre-event balance-reminder job was checked and is safe: it filters `status = 'CONFIRMED'` (server.js:1482), so no client was ever emailed about a balance on an unquoted enquiry.

### G2 — `quote_amount` is a formatted string

`quote_amount` is `TEXT` and intake writes `"R 1234.00"`. Currency belongs in an integer-cents or `REAL` column with formatting at the presentation layer.

### G3 — `bookings.status` has no `CHECK` constraint, and the column default contradicts the code

`status TEXT DEFAULT 'pending'` (lowercase) while every code path writes uppercase (`NEW`, `QUOTED`, …). No constraint prevents a typo'd status from being written. This is the same class of defect already catalogued for `notifications.status` and `payment_method`.

### G4 — Missing indexes

* `booking_services(booking_id)` — **no index at all**, despite `ON DELETE CASCADE` from `bookings`.
* The duplicate check filters on `lower(email)`, which cannot use `idx_bookings_email` on `bookings(email)`. It is a full scan today (46 rows). Add `CREATE INDEX idx_bookings_email_lower_date ON bookings(lower(email), date)`.
* `bookings(created_at)` for the intake-volume analytics queries.

### G5 — `policy_version` is client-supplied — **FIXED (commit `dde0a4a`)**

The browser told the server which privacy-policy version the user consented to, and that value was written verbatim into `bookings.policy_version` **and** `consent_audit.policy_version` — the artefact you would hand a regulator. A stale cached page, or a crafted request, recorded consent against a policy the user never saw.

Now stamped from a server-owned `CURRENT_POLICY_VERSION` constant (server.js:215), which also replaces the three other hardcoded `'v2.2'` literals (newsletter signup, admin booking creation, admin consent audit). `req.body.policy_version` is ignored. Verified: a submission carrying `policy_version: "ATTACKER-CONTROLLED-v9.9"` persists `v2.2` in both tables.

### G6 — Conflict detection fails open

`hasCalendarConflict()` resolves `false` on a database error, on a Google API error, and in its outer `catch`. A read failure therefore *permits* a double-booking. That is a deliberate availability-over-safety trade-off, but it is undocumented and unmonitored — a failing Google credential silently degrades conflict detection to local-only, which is exactly what the running instance is doing right now (`No access, refresh token, API key or refresh handler callback is set`).

### G7 — Untimed bookings are asymmetric

A submission with no `event_start_time` is conflict-probed against a phantom `18:00` window, but once stored it has `event_start_time = NULL` and `hasCalendarConflict()` skips it — so it never blocks anyone else. An all-day booking does not hold its day.

### G8 — Two duration parsers with different fallbacks

`parseDurationMins()` (line 26) defaults to **60**; `parseDurationToMinutes()` (line 533) defaults to **120**. The first drives billable quantity, the second drives scheduling. A `per_minute` service submitted without a duration is billed for 60 minutes and scheduled for 120.

### G9 — `services.valid_from` / `valid_to` are never checked

The columns exist. Intake validates `is_active` and `is_deleted` but not the validity window, so a service outside its window is bookable.

### G10 — No timezone model

Every `moment()` call parses in server-local time. There is no timezone column on `bookings` or `venues`. A booking for an international venue (the catalogue has *Travel Buyout – International*) is stored and conflict-checked in the server's timezone.

### G11 — Draft autosave is weakly rate-limited

`POST /api/public/bookings/draft` uses only `ipRateLimiter` (100/hr) by design, so debounced autosaves aren't blocked. But `abandoned_bookings.draft_token` is client-generated, so one IP can create 100 draft rows per hour, each holding an email address. The 30-day purge bounds it, but a dedicated per-token limit would be better.

### G13 — Document numbering collides on regeneration — **invoice half FIXED (commit `3310254`)**

Both document numbers are derived from a timestamp, and both columns are `UNIQUE`:

| Column | Format | Collides when | Status |
|---|---|---|---|
| `invoices.invoice_number` | `INV-<YYYY>-<bookingId>` | any regeneration in the same **year** | **fixed** — revision suffix |
| `quotations.quote_number` | `QT-<id>-<YYMMDDHHmmss>` | two quotes in the same **second** (a double-click on *Generate Quote*) | open |

The invoice case turned out to be far more serious than "a 500 to the admin". Phase 2 proved it silently breaks a normal workflow: re-quoting an `ACCEPTED` booking voids its invoice, and the replacement could then never be inserted — the booking could not be invoiced again for the rest of the year. See `phase2_quote_acceptance_review.md`, P2-1.

Invoices now take a revision suffix on regeneration (`INV-2026-0044`, then `-R2`, `-R3`), chosen with the owner. A number is never reused and the voided original stays in the audit trail. The 19 existing invoices are untouched.

The quote-number case remains open. It is a genuinely narrow window and the rollback is now clean.

### G12 — Booking deletion was broken by the missing cascades — **FIXED (commit `dde0a4a`)**

> **Correction.** An earlier revision of this document said "something deletes bookings with foreign keys disabled." That was wrong, and the truth is more actionable.

`PRAGMA foreign_keys = ON` **is** enforced at runtime (verified: `PRAGMA foreign_keys` returns `1` on the app's connection). Five tables declare a FK to `bookings(id)` with `ON DELETE NO ACTION` and were **not** cascaded by `DELETE /api/admin/bookings/:id`: `consent_audit`, `payment_logs`, `reminders_log`, `expenses`, `bank_statement_lines`.

So deletion never orphaned anything. It **failed**. Measured on booking #77 — which has a `consent_audit` row, no payments, and is therefore deletable per the business rules:

```
DELETE /api/admin/bookings/77
  → 500  {"error":"SQLITE_CONSTRAINT: FOREIGN KEY constraint failed"}
  booking still present:                    YES
  audit_log rows claiming it was DELETED:   1
```

**15 of the 33** deletable bookings were undeletable this way. And two side effects ran *before* `BEGIN TRANSACTION`, so a failed delete still:

* wrote an `audit_log` `DELETE` entry for a booking that still exists (observed above), and
* executed `UPDATE bookings SET event_id = NULL`, permanently unlinking the calendar event — **4 deletable bookings currently have a linked event**.

`deleteGoogleEvent()` also ran before the transaction, destroying the Google Calendar event of a booking the delete then failed to remove.

**Fixed.** `consent_audit`, `payment_logs` and `reminders_log` now cascade. `consent_audit` is purged deliberately: deleting a booking erases the personal data captured with it (IP, user agent), so retaining its consent proof would recreate exactly the orphans below. `expenses` and `bank_statement_lines` are **unlinked, not deleted** — a cost the business incurred and a bank's own record both outlive the booking, and both columns are nullable. The audit entry, the `event_id` clear and the Google cleanup all moved inside/after the transaction, and the route now runs under `withDbTransaction()`.

**Remaining data issue (not code).** The existing rows still show:

* **24 of 41** bookings with `popia_consent = 1` have no `consent_audit` row.
* **18 of 35** `consent_audit` rows point at a `booking_id` that no longer exists.

Both are residue from before FK enforcement. New bookings are covered — the consent row is written inside the booking transaction, so a booking can never exist without one. These 18 orphans need a decision: backfill what can be reconstructed and document the rest as pre-audit-table records, or purge them. Adding `ON DELETE CASCADE` explicitly to the schema would make the new intent visible rather than relying on the route's cascade list.

---

## 4. Optimised workflow

```mermaid
flowchart TD
    A([Visitor opens booking wizard]) --> B[Step 1-3: event, client, venue]
    B -.autosave.-> D[(abandoned_bookings\ndraft_token)]
    D -.reminder + resume link.-> B
    B --> C[Step 4: review + POPIA consent]
    C --> V{Normalise + validate\ntypes · lengths · date sanity\ntime format · consent}
    V -->|400| C

    V --> R[Read-only gates]
    R --> R1[services + pricing snapshot]
    R1 --> R2[one occupancy window]
    R2 --> R3[date availability]
    R3 --> R4[duplicate email+date]
    R4 --> R5[working hours]
    R5 --> R6[time overlap]
    R6 --> R7[calendar conflict\nlocal + Google]
    R7 -->|409| C

    R7 --> W[find/create client + venue]
    W --> T[withDbTransaction]

    subgraph T [BEGIN IMMEDIATE · serialized]
        T1[re-check availability] --> T2[re-check conflict]
        T2 --> T3[re-check duplicate]
        T3 --> T4[(INSERT booking · status NEW)]
        T4 --> T5[(consent_audit)]
        T5 --> T6[(audit_log CREATE + ip)]
        T6 --> T7[(booking_services + line_items)]
        T7 --> T8[COMMIT]
    end

    T --> S{{Side effects — never block the response}}
    S --> S1[Google Calendar sync\nadmin alert on failure]
    S --> S2[Client + admin emails]
    S --> S3[draft → RECOVERED]
    S --> OK([201 · booking_id])
```

The change from the original: **one write boundary**, everything cheap and rejectable happens to the left of it, and everything that can fail without invalidating the booking happens to the right of it.

---

## 5. Automation opportunities

Already automated (verified in code): booking creation, duplicate detection, availability, conflict detection, booking-number generation, status defaulting, calendar creation, client + admin email, CRM upsert (`clients`), audit logging, consent recording, analytics capture, abandoned-booking detection, follow-up reminders.

Genuinely missing:

| Opportunity | Value | Notes |
|---|---|---|
| Server-authoritative `policy_version` | compliance | see G5 |
| Outbox for side effects | reliability | calendar sync + email are fire-and-forget; a crash between COMMIT and dispatch loses the notification permanently. Persist an intent row, drain with a worker. |
| Idempotency key on submit | correctness | a double-tap or retry currently relies on the `(email, date)` rule; an explicit `Idempotency-Key` header would make retries safe |
| `valid_from`/`valid_to` enforcement | correctness | see G9 |
| Structured intake metrics | ops | count 400/409/500 by reason; today a 500 is invisible |

Event-driven rework of the rest is not justified at this volume (46 bookings lifetime). The outbox is the one pattern worth adopting now, because it fixes a real data-loss path rather than an imagined scaling one.

---

## 6. UX / UI improvements

The wizard is in good shape: 4 steps, autosave, resume, prefill, blur-level validation, focus-on-first-error. Concrete gaps found in the markup (24 form controls inside `#dedicatedBookingForm`):

| Finding | Count | Fix |
|---|---|---|
| `autocomplete` attributes | 1 of 24 | add `name`, `email`, `tel`, `organization`, `address-level2`, `country-name` |
| `inputmode` attributes | 0 | `inputmode="tel"` / `"numeric"` on phone and audience-size |
| Error text tied to its field | 0 `aria-describedby` | link each message to its input |
| `#bookingFormError` announced | not a live region | `role="alert"` |

Beyond attributes:

* **Reduce required fields.** 12 of 24 controls are `required`. `event_name`, `audience_demographic` and `budget_range` are qualification data, not intake data — collect them on the quote request instead.
* **`message` minimum of 10 characters** is friction on a form that already captures event type, date, venue, audience and services. Consider making it optional.
* **The duplicate 409 is a dead end.** It returns `existing_id`; the UI should offer "track that booking" as a button, not prose.
* **Smart defaults.** `country` should default from the venue's Google Place result rather than being asked.

---

## 7. Backend improvements

Implemented: input normalisation, type coercion, length caps, date and time validation, gate reordering, transaction serialisation, error-class separation (503 vs 409), audit IP capture.

Recommended: server-authoritative `policy_version` (G5); an explicit `409` body discriminator (`reason: "duplicate" | "unavailable" | "conflict"`) so the client can branch without string-matching the message; migrate the remaining `BEGIN TRANSACTION` sites onto `withDbTransaction()`.

Note that `POST /api/admin/bookings` (server.js:8616) shares this endpoint's shape — including the `BEGIN IMMEDIATE` on the shared connection at line 8752. It has the same B1 exposure and should be migrated next.

---

## 8. Database improvements

```sql
-- G4: the duplicate check cannot use idx_bookings_email because of lower()
CREATE INDEX IF NOT EXISTS idx_bookings_email_lower_date ON bookings(lower(email), date);

-- G4: no index at all on the cascade child
CREATE INDEX IF NOT EXISTS idx_booking_services_booking ON booking_services(booking_id);

-- G4: intake-volume analytics
CREATE INDEX IF NOT EXISTS idx_bookings_created_at ON bookings(created_at);

-- audit lookups by record
CREATE INDEX IF NOT EXISTS idx_audit_log_record ON audit_log(table_name, record_id);
```

Schema changes deserving a migration: a `CHECK` constraint on `bookings.status` with the default corrected to `'NEW'` (G3); `quote_amount` moved off `TEXT` (G2); a `timezone` column on `venues` (G10); a foreign key from `abandoned_bookings.converted_booking_id` to `bookings(id)`.

---

## 9. API improvements

* `POST /api/public/bookings` returns `200`; a resource-creating call should return `201` with a `Location` header. *(Not changed — would break the existing client, which checks `result.success`.)*
* The 409 responses are distinguishable only by message text. Add a machine-readable `reason`.
* `booking_id` is returned but no `resume`/`track` token, so the client cannot deep-link the confirmation.

---

## 10. Performance

At 46 lifetime bookings, nothing here is slow. The relevant observations are about *shape*, not speed:

* The Google free/busy call is on the critical path, with a 1500 ms timeout, before the transaction. It is correctly skipped inside the lock (`skipGoogle=true`) so no network round-trip is held under `BEGIN IMMEDIATE`.
* `withDbTransaction()` serialises guarded sections. The booking transaction contains no network calls, so the queue drains at local-write speed. This is a correctness win, not a throughput cost.
* The duplicate check is a full table scan (G4).

---

## 11. Security improvements

* **Fixed:** unbounded free-text writes (B8); type-confusion 500s (B7); orphan `clients` rows squatting a `UNIQUE` email (B3).
* **Fixed:** `source` and `referrer` were written to the database raw and unencoded. Both are now passed through `encodeUserHtml()` like every other client-supplied string, since the admin panel renders these fields via `innerHTML`.
* **Open:** `policy_version` is client-controlled and lands in the consent audit trail (G5).
* **Open:** conflict detection fails open on error (G6).
* Rate limiting on the endpoint (`5 / 15 min` per IP, plus a 100/hr IP limiter) is reasonable.

---

## 12. Accessibility (WCAG 2.2 AA)

| Criterion | Status |
|---|---|
| 1.3.1 Info and Relationships | labels present (20), but no `fieldset`/`legend` grouping the four steps |
| 1.3.5 Identify Input Purpose | **fails** — 1 `autocomplete` across 24 controls |
| 3.3.1 Error Identification | partial — errors shown visually, `#bookingFormError` is not a live region |
| 3.3.2 Labels or Instructions | passes |
| 3.3.3 Error Suggestion | passes — messages are specific and actionable |
| 4.1.3 Status Messages | **fails** — no `role="alert"` on the error container |

The step bar already carries `aria`/`role` attributes, and focus is moved to the first invalid field on submit — both good.

---

## 13. Prioritised roadmap

### Quick wins — done in this change

1. Transaction serialisation (B1) — the single highest-value fix.
2. Past-date guard (B2).
3. Gate reordering to eliminate orphan rows (B3).
4. In-lock duplicate re-check (B4).
5. Availability read-error vs unavailable-date separation (B5).
6. `event_start_time` validation and zero-padding (B6).
7. Type coercion (B7) and length caps (B8).
8. Unified occupancy window (B9); `performance_start_time` (B10); `travel_accommodation` (B11); audit IP (B12).
9. `source` / `referrer` output-encoding.

### Quick wins — done in commit `dde0a4a` (follow-up)

10. Booking deletion: the five missing FK cascades, `expenses`/`bank_statement_lines` unlinked rather than deleted, audit entry + `event_id` clear + Google cleanup moved inside/after the transaction, route migrated onto `withDbTransaction()` (G12).
11. Server-authoritative `policy_version` (G5).
12. Outstanding-revenue KPI restricted to accepted commitments — zero-diff today (G1).

### Quick wins — done in commit `b464865` (transaction migration)

13. All 9 `BEGIN` sites migrated onto `withDbTransaction()`. Concurrent public + admin booking creation went from 1-of-6 to 6-of-6.
14. Admin cancellation unblocked (B13) — it had never worked.
15. Failed invoice regeneration no longer destroys the live invoice (B14).
16. Admin "quote sent" notification actually sends (B15).

### Medium priority — next change window

17. The four indexes in §8.
18. Accessibility: `autocomplete`, `inputmode`, `role="alert"`, `aria-describedby`.
19. `409` reason discriminator + "track that booking" button on the duplicate path.
20. Decide backfill vs purge for the 18 orphan `consent_audit` rows, and declare `ON DELETE CASCADE` in the schema (G12).
21. Instrument `hasCalendarConflict()`'s fail-open paths so a broken Google credential is visible rather than silently degrading conflict detection to local-only (G6) — it is degraded right now.
22. Apply the invoice revision-suffix treatment to `quotations.quote_number`, which still collides on a double-click (G13, remaining half).

> **Audit the other CHECK triggers.** B13 was a value the schema forbids, written by code that never checked. The same class already bit `notifications.status`, `cancelled_by` and `payment_method`. A short script that enumerates every `chk_*` trigger's allowed set and greps the codebase for literals written to that column would find the rest in one pass. Worth doing before the next release.

### Long-term

16. Outbox table for calendar + email side effects; drain with the existing scheduled-job infrastructure.
17. `CHECK` constraint on `bookings.status`; `quote_amount` off `TEXT`.
18. Timezone model on `venues` (G10).
19. Reconcile the two duration parsers (G8).
20. An automated test suite. `package.json` currently has `"test": "echo \"Error: no test specified\" && exit 1"`. Every defect in §2 is cheaply expressible as an HTTP-level test; the harness used for this review is a starting point.

---

## AI & smart features — assessment

The prompt asks for automatic event categorisation, suggested durations, suggested pricing, venue validation, intelligent conflict resolution, predictive availability, lead scoring.

**None of these should be built yet**, and the reason is in the data: 46 lifetime bookings, of which 19 are `EXPIRED` and 11 `COMPLETED`. There is no signal to learn from. Lead scoring on 30 non-expired examples will encode noise, and a suggested-pricing model would be fitting a curve to a catalogue that already has explicit `base_price` values.

Two of the listed items are worth doing as **rules, not models**, today:

* **Venue validation** — already half-built. `venuePlaceId` is captured from Google Places; validate it server-side against the Places API rather than trusting the client's `event_location` string.
* **Suggested durations** — the catalogue already carries `performance_length_minutes` and `setup_time_minutes`. Surface them in the wizard as a default duration instead of asking the client to type one. This directly removes the `parseDurationToMinutes` ambiguity in G8.

Revisit the ML-shaped items at ~500 bookings.

---

## Effort estimates

I can only honestly quantify what I measured.

**Measured:** concurrent-submission success rate went from **1 of 8 to 8 of 8**. On a form that receives simultaneous submissions — which is exactly what happens after a broadcast appearance or a newsletter send — this is the difference between capturing a lead and losing it with a database error.

**Estimated, not measured:**

* *Client clicks:* dropping `event_name`, `audience_demographic` and `budget_range` from required removes ~3 interactions from a ~24-control form. Defaulting `country` from the Places result removes one more.
* *Administrator actions:* unchanged by this work. Phase 1 already requires zero admin action to capture a booking.
* *Processing time:* unchanged. The endpoint was never slow; it was wrong.
* *Manual intervention:* the orphan-row fix (B3) removes a recurring, invisible clean-up task from the `clients` table — one that nobody knew existed.

---

## Compliance & compatibility statement

* **Business rules preserved.** No rule was relaxed. Two were tightened, both with cause: the working-hours gate now uses the longer of the catalogue and form durations (B9), and past dates are rejected (B2). Same-client multi-booking on the same day remains allowed.
* **Backward compatible.** The request and response shapes are unchanged. `200` is retained on success. No column was dropped or renamed.
* **POPIA.** Consent remains mandatory; `consent_audit` is still written inside the transaction, so a booking can never exist without its consent record. `audit_log.ip_address` is now populated. One open item: `policy_version` should be server-stamped (G5).
* **Auditability.** The `audit_log` CREATE row now records the normalised values actually persisted, rather than the raw request body.
