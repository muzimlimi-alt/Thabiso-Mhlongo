# Client-designed payment plans: rules, data flow, operations

Written October 2026, when clients got control of their own payment milestones. A client designs the plan while
accepting a quote and can later rearrange the payments they still owe from the booking tracker. Read this before
touching `payment_schedules`, the accept/track/pay routes, or the admin Payment Milestones card.

## Owner decisions (fixed)

1. The client designs the plan when **accepting a quote**, and can later **rearrange the unpaid milestones**. Paid
   milestones are locked.
2. Changes apply **immediately**, with no approval step. The admin is **notified** and can still edit the plan under
   Setup Milestones.
3. **At most 4 payments** per booking in total. Locked (paid) rows count toward the 4.
4. Every client-made plan satisfies the rules below: deposit floor, first payment within 7 days of acceptance, paid
   off 2 days before the event, and a minimum per payment.
5. Admin-built plans (Setup Milestones, the admin QUOTED→ACCEPTED auto plan, the Rebalance button) are **not** bound
   by the client rules. They only have to add up to the booking total.

## Where the code lives

| Piece | File | Notes |
|---|---|---|
| The rules | `js/shared/payment-plan-rules.js` | UMD, ES5, no dependencies, no clock. `require()`d by the server; `window.PaymentPlanRules` in the tracker. **The only definition of the rules.** |
| Server state + writes | `lib/payment-plan.js` | `loadPlanState`, `writeClientPlanInTx`, `getMinInstallmentAmount`, `todaySast`, contract/invoice follow-ups |
| Routes | `routes/public/bookings.js` | `/track` (plan block), `/accept-quote` (`milestones`), `POST /payment-plan` (rearrange) |
| Emails | `lib/booking-notifications.js` | `sendAdminPaymentPlanChangedNotification`, `sendPaymentPlanUpdatedEmail`; the accept-time admin email is `sendAdminQuoteAcceptedNotification` in the route file |
| Invoice PDF refresh | `lib/invoicing.js` | `refreshInvoicePdf` (shares `computeInvoiceItemsAndTotals` with `generateInvoice`) |
| Client UI | `js/public/payment-plan-builder.js`, mounted in the `index.html` booking tracker (`#planBuilder` at acceptance, the "Change payment plan" editor afterwards) | Loads after `js/shared/payment-plan-rules.js`; runs entirely on `payment_plan.context` from `/track` |
| Admin UI | `admin.html` (Payment Milestones card, Setup Milestones editor), `js/admin/policies.js` | Badge, "locked" marker, minimum-instalment policy field |
| Schema | `database.js` | `policies.min_installment_amount` seed, `bookings.payment_plan_changed_at`, banner key `payment_plan_updated` |

## The rules

All money is **integer cents** and all dates are **`YYYY-MM-DD` strings** compared as strings, with arithmetic done
through `Date.UTC`. "Today" is always the **Africa/Johannesburg** calendar date. The server passes it in
(`todaySast()`); the module never reads the clock.

| Constant | Value | Meaning |
|---|---|---|
| `MAX_PAYMENTS` | 4 | payments per booking, paid ones included |
| `FIRST_DUE_WITHIN_DAYS` | 7 | the first payment is due within 7 days of the **original** acceptance |
| `LAST_DUE_DAYS_BEFORE_EVENT` | 2 | the last due date is the event date minus 2 |
| `DEFAULT_MIN_PAYMENT` | 500 | rands; Booking Policies `min_installment_amount` overrides it |
| `DEFAULT_DEPOSIT_PERCENTAGE` | 50 | Booking Policies `deposit_percentage` overrides it (clamped 0–100) |

`validatePlan(ctx, rows)` checks every rule and reports **every** problem, not just the first. Each error is
`{index, field, message}`. `index` is the payment's position in the submitted array (null for a plan-wide problem),
and "Payment N" in a message means `locked_count` + that position + 1 — the same number the card and its label
show, counting the paid payments first. The server
returns `errors[0].message` as the top-level message and the whole list as `errors`.

1. **Count.** There must be 1 to `slots` payments, where `slots = 4 − locked_count`. The message names the total of
   4 and the payments already made.
2. **Readable.** Each amount must be > 0 with at most 2 decimals. On the wire it is a number, or a string matching
   `^\d+(\.\d{1,2})?$`. Each due date must be a real calendar date.
3. **One payment per day.** After sorting by date, the dates are strictly ascending.
4. **Window.** Each due date satisfies `earliest_due ≤ due ≤ latest_due`.
   - `earliest_due = max(today, latest locked due date)`.
   - `latest_due = event − 2`, never before `earliest_due`. With no event date it is `today + 30`.
5. **Sum.** The payments add up to exactly `remaining_cents = total − locked`.
6. **Minimum.** When there is more than one payment, each is ≥ `min_payment_cents`. A single remaining payment is
   exempt, since it is simply the whole balance.
7. **Deposit floor.** This is judged cumulatively. While `locked_cents < deposit_floor_cents`, the first (earliest)
   new payment must be ≥ `deposit_needed_cents = floor − locked`. `floor = round(total × pct / 100)`. Once locked
   money reaches the floor, the rule no longer applies.
8. **First payment by.** While nothing is locked, the first payment is due on or before `first_due_by`:
   - `first_due_by = clamp(max(today, acceptedDate + 7), earliest_due, latest_due)`.
   - `acceptedDate` is the SAST date of `accepted_at`, or today at acceptance itself.
   - Because it is anchored to the original acceptance, repeated edits cannot push the deposit back. Once that
     window has passed, the first payment must be due **today**.

The module limits each payment to one amount error (the first payment gets whichever of rules 6/7 is higher). It also
reports rule 8 instead of rule 4's upper bound on the first payment, so one date is not flagged twice.

### The context (`buildContext`)

The server builds the context from fresh DB state, and `/track` ships it to the browser verbatim as
`payment_plan.context`. The browser never derives rules from DOM text. Fields:

```
mode ('accept'|'change'), today, max_payments, deposit_percentage, min_payment_cents,
total_cents, paid_cents, locked_cents, credit_cents, remaining_cents,
locked_ids, locked_count, locked_rows, unpaid_rows [{id, due_date, amount_cents, status, sequence, source}],
slots, sequence_base, deposit_floor_cents, require_deposit, deposit_needed_cents,
require_first_by, earliest_due, latest_due, first_due_by, event_date, consistent, event_passed
```

### Presets (`buildPreset(ctx, n)`, n = 1..4)

- **Amounts.**
  - n = 1: the whole remaining balance.
  - Deposit still needed: the deposit needed (raised to the minimum payment if it is smaller) first, then the rest
    split equally in cents (the last payment absorbs the remainder).
  - Otherwise: an equal split.
- **Dates.**
  - While nothing is paid: from `first_due_by`, spread evenly to `latest_due`. For a short-notice event, where
    `first_due_by` is clamped onto `latest_due`, the first payment is pulled forward just enough to leave one day for
    each later payment (never before `earliest_due`).
  - Otherwise: spread evenly after `earliest_due`, with the last on `latest_due`.
- A preset that would break any rule returns `null`. Examples: the R500 minimum, two payments on one day for a
  short-notice event, or `n > slots`.
- With nothing paid, the 2-payment preset is the classic deposit/balance plan (floor due today + 7, balance due
  event − 2). That is the same as `autoBuildDepositBalanceSchedule` for a normal event.
- The client-facing **3-payment preset changed** from 30/30/40 to "deposit floor first, remainder split equally"
  (50/25/25 at 50%), because 30/30/40 breaks the deposit rule. The admin path keeps 30/30/40.

### Labels (`labelPlan`) — always server-generated

Clients never send descriptions; only `{amount, due_date}` survives the shape check. With N = locked rows + new rows:

| Plan | Labels |
|---|---|
| 2 new rows, nothing locked, first row exactly the deposit floor, 0 < pct < 100 | `50% Deposit` / `50% Balance` (the long-standing labels the golden PDFs and tests rely on) |
| 1 new row, nothing locked | `Full Payment` |
| otherwise | first row with nothing locked: `Deposit – Payment 1 of N`; last: `Final Payment – Payment N of N`; others `Payment k of N` (k counts locked rows first) |

When a change is saved, paid rows whose label this feature generated (`Payment k of M`, optionally prefixed
`Deposit – ` / `Final Payment – `) are renumbered to the new total so the schedule reads consistently; only the
description changes. Other labels (`50% Deposit`, an admin's own wording) are left as they are.

## Locked rows come from money, not flags

Locking is decided by `bookings.amount_paid`, not by any row's status:

- Live rows (status not `superseded`/`cancelled`) are walked in `due_date ASC, id ASC` order, the same order
  `alignMilestonePayments` uses. The walk subtracts `amount_paid` in cents.
- Each row the money fully covers is **locked**. The walk stops at the first row it can't cover.
- `credit_cents = paid − locked`.
- `consistent = (credit_cents === 0 && every row flagged 'paid' is locked)`.

Why money and not flags: a row is covered by money a few seconds before alignment flags it `paid`, and a refund can
leave a stale `paid` flag on a row the money no longer covers. An inconsistent state (a part-payment sitting inside a
milestone, or a `paid` flag the money doesn't back) is refused as **NEEDS_ADMIN**. The admin sorts those out.

**Ordering invariant.** New rows have strictly ascending due dates, all ≥ the latest locked row's due date.
Their `sequence` is `sequence_base + i + 1`, where `sequence_base = max(locked_count, max locked sequence)`. This
ensures:

- the payment waterfall (due-date order) can never "un-pay" a locked row by putting an earlier unpaid row in front
  of it;
- `/pay`, which picks the next payable row by `sequence ASC`, charges rows in the same order the waterfall credits
  them.

## Data flow

```
read     POST /track ──► loadPlanState(booking) ──► buildContext + judgeEditability ──► payment_plan {mode, editable,
                                                    (lib/payment-plan.js)                reason_code, reason, plan_version,
                                                                                         context}; schedule rows + source/locked
                                    │
                    browser: PaymentPlanRules.validatePlan / buildPreset / labelPlan, live, no server round trip
                                    │
accept   POST /accept-quote {terms_agreed, milestones?} ──► BEGIN IMMEDIATE: CAS QUOTED→ACCEPTED/CONFIRMED,
                                    quotation stamp, audit QUOTE_ACCEPTED, buildContext('accept') on re-read rows,
                                    validatePlan → writeClientPlanInTx ──► COMMIT ──► calendar, invoice (emailed),
                                    draft contract, client email, admin email (with a "Payment plan" card)
change   POST /payment-plan {access_token, plan_version, milestones} ──► BEGIN IMMEDIATE: re-read booking,
                                    loadPlanState('change') → editable? → plan_version match? → validatePlan →
                                    unchanged? (COMMIT, 200 unchanged:true) → writeClientPlanInTx, stamp booking,
                                    audit row, booking note ──► COMMIT ──► align, invoice PDF refresh, draft
                                    contract regen, admin + client emails ──► 200 {payment_schedule, payment_plan}
```

### `/track`

- Each `payment_schedule` row gains `source` and `locked` (paid, by money).
- `payment_plan` carries `{mode, editable, reason_code, reason, plan_version, context}`. The mode is `accept` while
  the booking is QUOTED, otherwise `change`.
- `plan_version` is `sortedLiveIds|paid_cents|total_cents`. It changes whenever a milestone is added or superseded,
  money arrives, or the total changes.
- The top-level `deposit_percentage` stays, for old cached tracker scripts.
- If plan state can't be built, `/track` still answers with the plain schedule and `payment_plan: null`.

### Accept (`POST /api/public/bookings/:id/accept-quote`)

- **`milestones` sent.** The client's plan, validated inside the acceptance transaction against fresh state:
  - The total is `quote_amount`, else `total_amount`.
  - `acceptedDate` is today.
  - Paid rows that survived a re-quote stay locked and count toward the 4.
  - Any rule failure rolls back the **whole acceptance**: the response is
    `400 {success:false, code:'INVALID_PLAN', message: errors[0].message, errors}`, the booking stays QUOTED, and
    nothing is written.
  - The plan replaces any unpaid rows already on the booking.
- **`milestones` not sent** (an old open tab):
  - If there are live unpaid rows (an admin pre-built plan), they are kept.
  - Otherwise the preset with `installment_count || 2` payments is used, falling back to fewer, down to 1.
  - If no preset satisfies the rules (for example 4 payments already made before a re-quote raised the total), the
    remaining balance becomes **one** row with `source='auto'`, due `first_due_by` (or `latest_due`), for the
    admin to adjust.
- A shape error (not an array, empty, more than 10 entries, an entry that isn't an object, an over-long field) is a
  `400 INVALID_PLAN` before the transaction.
- Writing a fresh plan clears `payment_plan_changed_at`.

### Change (`POST /api/public/bookings/:id/payment-plan`)

Middleware is the same as accept-quote: `mutateRateLimiter, ipRateLimiter, requireBookingAccessToken`. Responses:

| Status | Body `code` | When |
|---|---|---|
| 200 | — | Saved. `{success, message, payment_schedule, payment_plan}`, both in `/track`'s shape, so the tracker re-renders without calling `/track` (trackRateLimiter is 10 per 15 min) |
| 200 | — (`unchanged: true`) | The submitted rows equal the current unpaid rows (same amounts and dates, any order). Nothing is written, nobody is notified |
| 400 | `INVALID_PLAN` | Shape error, or `validatePlan` failed (`errors[]` included) |
| 401 | `TOKEN_REQUIRED` | Missing or expired tracker access token |
| 404 | — | No such booking |
| 409 | `PLAN_CHANGED` | `plan_version` missing or stale, or the live rows moved during the write (`PLAN_CONFLICT`). The tracker reloads the plan |
| 409 | one of the reason codes below | The plan isn't editable right now. `message` is the client-facing reason |
| 503 / 500 | — | Database busy / unexpected failure. Everything is rolled back |

### Reason codes (`loadPlanState` → `reason_code` / `reason`)

| Mode | Code | When |
|---|---|---|
| accept | `NOT_QUOTED` | the booking is no longer QUOTED |
| accept | `NO_QUOTE` | no positive quote total |
| accept / change | `FULLY_PAID` | nothing left to schedule (`payment_status` PAID or remaining ≤ 0) |
| change | `NOT_ACCEPTED` | status is not ACCEPTED/CONFIRMED (while QUOTED the message points at the accept step) |
| change | `REFUNDED` | `payment_status` REFUNDED |
| change | `EVENT_PASSED` | event date before today |
| change | `NO_UNPAID` | no unpaid rows to rearrange |
| change | `NEEDS_ADMIN` | `!consistent`: a part-payment inside a milestone, or a `paid` flag the money doesn't cover |
| change | `NO_SLOTS` | 4 or more rows are already locked |
| change | `PAYMENT_IN_PROGRESS` | a `payfast_payment_intents` row for the booking is `pending` and less than 60 minutes old (an ITN may still arrive for a row the change would supersede) |

The tracker offers "Change payment plan" only while the plan is editable. Otherwise it shows the reason as a muted
line for `NEEDS_ADMIN`, `NO_SLOTS` and `PAYMENT_IN_PROGRESS`, and nothing for the other codes.

## Writing a plan (`writeClientPlanInTx`)

It must run inside an open `BEGIN IMMEDIATE` (inside `withDbTransaction`), with the context built in that same
transaction. **No network calls inside**: they would hold the shared queue for every other guarded write.

1. Re-read the live rows. If they aren't exactly `locked_ids + unpaid_rows`, throw `PLAN_CONFLICT` (→ 409
   `PLAN_CHANGED`).
2. **Supersede, never delete or update in place.** Set `status='superseded', updated_at=CURRENT_TIMESTAMP` on exactly
   `ctx.unpaid_rows`, and only while they are still `pending`/`overdue`. If the changed-row count differs (an
   interleaved alignment just marked one paid), throw `PLAN_CONFLICT`. Superseding instead of deleting is required
   for three reasons:
   - `reminders_log.schedule_id` is a foreign key, so a DELETE fails once a reminder was sent.
   - New ids make the 7- and 2-day reminders fire again for the new dates. Reminders de-duplicate on
     `(booking_id, schedule_id, days_before)`, so an in-place date change would suppress them.
   - PayFast intents keep pointing at the row they were built for.
3. Insert the new rows: `insertPaymentScheduleMilestone(id, label, due_date, amount, sequence, 'client')` with
   server labels and `sequence_base + i + 1`.
4. **Invariant.** The sum of live `expected_amount`, in cents per row, must equal `total_cents`. Otherwise throw, and
   everything rolls back.

The change route then updates the booking in the same transaction:

- `bookings.payment_plan_changed_at = CURRENT_TIMESTAMP`;
- `modified_by = NULL, modified_by_role = 'client'`, so the `audit_bookings_update` trigger attributes the change to
  the client and not to the last admin;
- an `audit_log` row on table `bookings`:
  - `action = 'CLIENT_PAYMENT_PLAN_CHANGED'`, `changed_by = user_email` = the verified client email,
    `actor_role = 'client'`;
  - flat `old_values`/`new_values` such as `{"Payment 2 of 3": "R 4,000.00 due 2 Nov 2026"}`, which the booking's
    Change History card diffs key by key;
- a `[Payment Plan Changed]` booking note (author Client, `encodeUserHtml`) listing the previous and new plan.

`markScheduleRowsPaid` / `markScheduleRowsPending` re-check `status NOT IN ('superseded','cancelled')` in the UPDATE
itself. Alignment reads and writes in separate statements, so without that guard a racing alignment could resurrect a
row that was just superseded, and live rows would then sum to more than the total.

## After the commit (never fails the request)

1. `updateBookingMilestones(id)` re-runs the payment waterfall over the new rows.
2. **Invoice.** `refreshInvoicePdf(id)` re-renders the live invoice (the newest one that is not VOID or PAID) **in
   place**:
   - same number, status, totals and line items; new file name, then `invoices.file_path` is updated;
   - no email, no new invoice number;
   - a no-op when no live invoice exists;
   - refused (`totals-changed`) when the recomputed total no longer matches the issued invoice. The admin email then
     says the invoice still shows the old schedule;
   - `generateInvoice` is byte-identical to before: both share `computeInvoiceItemsAndTotals`.
3. **Contract.** `syncContractAfterPlanChange(id)` regenerates only an unsent, auto-generated **draft** (Contract
   Builder clauses are kept). A sent, client-signed, countersigned or frozen contract, or a hand-uploaded PDF, is
   never touched. The admin email flags it as still showing the previous schedule.
4. **Emails.** Neither is awaited, and both check `r.success`:
   - **Admin** `sendAdminPaymentPlanChangedNotification`: to `getNotificationEmail()`, subject
     `Payment Plan Changed – Booking #N`, `replyTo` = the client, trigger `Admin: Client Payment Plan Changed`.
     - Cards: Booking, "Previous plan" and "New plan" (paid rows marked "(paid)").
     - Body: "Applied immediately — no approval needed. You can still change it under Setup Milestones."
     - Action-severity warnings for a stale invoice or contract.
   - **Client** `sendPaymentPlanUpdatedEmail`: a premium email with the `payment_plan_updated` banner (category
     Payments & Invoices; tolerated when missing) and the whole schedule, paid rows marked paid. The CTA goes to the
     tracking link. Subject `Your Payment Plan Has Been Updated – Booking #N`, trigger
     `Booking: Payment Plan Updated`.
   - At **acceptance** there is no separate plan email. The client's acceptance email already lists the schedule.
     The admin's "Invoice Issued" notification gains a **Payment plan** card, titled "Payment plan – Client-designed"
     when `milestones` were sent.

## Policies

- `deposit_percentage` (existing) and **`min_installment_amount`** (new):
  - seeded `'500'` in `database.js` `defaultPolicies` (`INSERT OR IGNORE`, so existing databases get it on next boot
    without overwriting an admin value);
  - `PUT /api/admin/policies` rejects a non-finite or negative value with 400 and stores it rounded to 2 decimals;
  - `getMinInstallmentAmount()` falls back to 500 for a missing or garbled row.
- Admin UI: **Policies → Booking Policies → Minimum Instalment Amount (R)** (`#polMinInstallment`, wired in
  `js/admin/policies.js`). A blank box saves the default of 500. The browser rejects negatives and unparseable input
  before sending.
- Policies are read when the context is built. A change applies to the next plan a client saves; existing plans are
  not re-validated.

## Admin interaction

- **Payment Milestones card** (`loadBookingPaymentSchedule`, admin.html):
  - When **any** live row has `source='client'`, the card shows a **Client-designed plan** badge and either
    "Designed by the client at quote acceptance" or "Last changed by the client on {SAST date, time}" (from
    `payment_plan_changed_at`, which the GET `/payment-schedules` route now returns).
  - Paid rows are marked **Paid · locked for the client**.
  - Descriptions are escaped (`window.escHtml`, which decodes the stored form first).
  - "Edit Schedule" reads the rows from a per-booking cache instead of a JSON `onclick` attribute, which entity
    decoding used to be able to break out of.
- **Setup Milestones editor:**
  - It confirms before replacing a plan where **any** row is the client's.
  - The server backstop (`409 requires_override` unless `acknowledge_override`) also checks any live client row,
    not just the first. After a client rearrangement the first row is usually an older paid deposit.
  - A save is one `BEGIN IMMEDIATE` transaction: it supersedes **every** live row (paid ones included) and inserts
    the submitted rows as `source='admin'`, `pending`. Alignment then re-derives paid rows from `amount_paid`.
  - This replaced a hard DELETE, which failed with a foreign-key 500 once a reminder had been sent.
  - An admin save removes the client badge. The client's history stays in the audit log and notes.
- The client can still rearrange an admin-built plan later, under the same rules and gates.
- The admin QUOTED→ACCEPTED path still builds `autoBuildDepositBalanceSchedule` (`source='auto'`), unchanged.

## Edge cases

- **Short-notice events.**
  - `latest_due` is never before `earliest_due`.
  - Event in 3 days: the window is today to tomorrow, so at most 2 payments.
  - Event 2 days away or closer (or, at accept, already past): the window collapses to today, so only a single
    payment due today is possible.
  - After acceptance, a passed event is `EVENT_PASSED`.
- **No event date.** `latest_due = today + 30`. The window rolls forward each day.
- **0% deposit.** There is no deposit rule; the first-payment-within-7-days rule still applies while nothing is
  paid.
- **100% deposit.** Only a single payment is possible.
- **Small totals.** Splitting needs every payment to reach the minimum, so an amount to schedule below twice the
  minimum (for example R800 with a R500 minimum) leaves only the 1-payment plan. That plan is always available while
  anything is owed and a payment slot is free. When the deposit needed is below the minimum, the first payment simply
  has to reach the minimum.
- **Deposit paid early** (before its due date). New rows can't be dated before that paid row's due date, even when it
  is later than today (`earliest_due`).
- **Re-quote after a payment.**
  - The re-quote supersedes the non-paid rows; paid rows survive.
  - On re-acceptance they are locked, count toward the 4, and the plan covers `new total − locked`.
- **Overdue rows** are unpaid. A change supersedes them and the new rows start `pending`.
- **Unrounded totals** (a re-quote can store the raw total) are rounded to cents everywhere through `roundToCents`, so
  the invariant and the context agree.
- **Legacy bookings without `accepted_at`** are treated as accepted today, which gives a fresh 7-day first-payment
  window.
- **Concurrent saves.**
  - Two tabs: the second gets `PLAN_CHANGED`.
  - A payment landing mid-save: `PLAN_CONFLICT`, rollback, then `PLAN_CHANGED`.
  - An admin Setup Milestones save: serialised by `BEGIN IMMEDIATE`, after which `plan_version` no longer matches.
- **Late PayFast ITN.** The ITN credits `bookings.amount_paid` regardless of which schedule row its `m_payment_id`
  named, and alignment re-derives coverage from money. The 60-minute `PAYMENT_IN_PROGRESS` block stops the client
  from superseding the row they are paying while the redirect is fresh.

## Tests

- `test/payment-plan-rules.test.js`: pure unit tests of the shared module (no server, fixed "today"). It covers:
  - every rule at its boundary, presets 1–4 (the 2-payment preset matches `autoBuildDepositBalanceSchedule` for
    normal events), and labels (the standard pair, 33.5%, numbering after locked rows);
  - short-notice events and 0%/100% deposits;
  - totals below the minimum;
  - locked rows and `earliest_due`, money-based locking (stale flags, partial credit, refunds, overpayment), the
    cumulative deposit rule, and the acceptance-date anchor;
  - cents rounding;
  - a property check over 240 contexts, and `parseMoneyInput`/`toCents` variants;
  - loading the file as a browser script in a `vm` sandbox.
- `test/client-milestones.test.js`: end to end against the test server (date offsets 1000–1049 plus a few free
  short-notice offsets; service 15; policies restored in `finally`; rows read with `q()` because `/track` is
  rate-limited for the whole suite). It covers:
  - accept with custom 2-, 3- and 4-row plans, and a rejection for each rule (the booking stays QUOTED with no rows);
  - a change after paying the first instalment: the locked row stays paid, and sequences, labels, superseded rows,
    the audit row and both emails are checked;
  - `PLAN_CHANGED`, `PAYMENT_IN_PROGRESS`, `NEEDS_ADMIN` on partial credit, 401 without a token, and not editable
    while QUOTED/CANCELLED;
  - admin Setup Milestones after a client change (the override and the former FK failure);
  - an admin pre-built plan kept when the client accepts without designing one, the invoice PDF re-rendered in
    place (same number and status, new file), short-notice events (event in 4 and 5 days), and the minimum
    instalment policy being validated, stored to the cent and enforced.
- `test/installment-plan.test.js`: the 3-payment preset is now deposit-first / equal split. The 3-payment and the
  30%-deposit fixtures use R2000, so every payment of the split can satisfy the R500 minimum.
- `test/smoke.js` requests every row of `docs-internal/routes.md`, including `POST /api/public/bookings/:id/payment-plan`.
  The route must answer 4xx to an empty, unauthenticated body.

## Known gaps (deliberately left alone)

- **Overdue non-deposit payments can be moved later.** Once the deposit is paid, the first-payment-by rule no longer
  applies, so a client can move an overdue instalment to any date up to 2 days before the event. Only the deposit
  is pinned (to `first_due_by`, which becomes today once the 7 days are over).
- **Sent or signed contracts keep the old schedule.** They are never regenerated automatically; the admin email
  warns. The contract's deposit clause also prints the policy percentage ("A deposit of 50% … secures the booking")
  rather than the client's actual first payment.
- **`/pay` still charges a row's full amount.** It doesn't subtract credit already sitting inside a milestone (for
  example after a part-payment the admin recorded, or a late ITN for a superseded row). The booking then shows
  `NEEDS_ADMIN` for plan changes until the admin reconciles it.
- **Policy changes don't re-validate existing plans.** Raising the deposit percentage or the minimum only bites when
  the client next saves. A saved plan that no longer satisfies the new rules can't be re-saved unchanged; it must be
  adjusted.
- **The "Payment Terms" policy text** (quotes and contracts) still defaults to "50% deposit on acceptance, balance
  48 hours before the event". The owner has to reword it; code never rewrites policy text.
- **Rate limit.** `mutateRateLimiter` allows 5 requests per 15 minutes per IP, shared with accept, cancel,
  revision-request, review and contract-sign. The tracker validates in the browser so that only the final save
  spends a request.
- **Admin edits.** Setup Milestones saves still write no audit row, and the Rebalance button can produce plans that
  break the client rules (fine for admins, but the client then can't re-save such a plan unchanged).
- **No in-app admin notification.** The admin is told by email, a booking note and the Change History entry only.
