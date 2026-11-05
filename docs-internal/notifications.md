# Business Activity & Alert Management (Notification Centre)

Started 2026-11-02. Owner decisions: **phased, foundation first** (P1 foundation + finance + system health, P2 operations, P3 compliance /
security / subscribers / preferences); **absorb the existing admin alert e-mails gradually** (same wording, one engine, no double e-mails);
**role-scoped visibility** (administrator: everything; manager: operations; assistant: bookings / enquiries / subscribers).

The rule behind all of it: *record everything important, interrupt only for what matters.* Every event goes in the Activity Log; only events the
registry marks as `action` or `attention` become notifications; only the priorities the owner chose are e-mailed; repeats are grouped.

## 0. Final development report (2026-11-03, Phases 1-3 complete, not yet committed)

**Existing notification functionality audited.** No in-app notification system existed. The table called `notifications` is the e-mail outbox;
about 20 admin alert e-mails were built ad hoc in different modules, all to `settings.notification_email`; `audit_log` (+ DB triggers),
`financial_audit_log`, `payment_logs`, `email_logs`, `calendar_sync_log` and `admin_login_logs` recorded history but never alerted anyone;
~20 scheduled jobs logged failures to the console only; Express 500s, crashes and browser errors went nowhere (the browser toast claimed
"our team has been notified" - untrue); a half-built bell in admin.html was dead code. Silent gaps found: refused PayFast notifications, payments
matching no booking, door-link check-ins (not logged at all), failed sign-ins, newsletter activity, EFT rejection, quote expiry, PayFast
credential and payment-policy changes (not even audited), low / sold-out stock, B-BBEE expiry. One dead alert: the "Calendar Sync Failed"
e-mail on new bookings could never fire.

**Event categories supported** (72 events, `lib/notify-events.js`): Finance & Payments, Bookings & Enquiries, Events & Ticketing, Calendar &
Scheduling, Customer & Business Changes, Compliance & Expiry, Website & System, Subscribers, Email & Communication, Users & Security.
Tables of every event: sections 4, 4b and 4c.

**Channels implemented.** In-app (bell + unread count, red for critical; dropdown; Notification Centre with Action required / Attention /
Activity feed / Expiry dates / Preferences; 30 s polling, visibility-guarded). E-mail through the existing outbox (retries, SMTP pause,
Delivery Log), to the notification address plus up to 5 backup addresses for critical alerts, from a chosen minimum priority (default High).
Browser push / SMS / WhatsApp: assessed, not built - see Costs.

**Priority and escalation rules.** Four levels (critical / high / medium / info). Mandatory events (money integrity, security, critical system)
cannot be switched off, have their e-mail switched off or be lowered below High. Repeats group into one incident; escalation thresholds raise the
priority (e.g. server errors / refused PayFast notifications at 10, failing jobs at 5, repeated failed sign-ins at the 4th repeat) and
re-surface it as unread with one e-mail. Recurrence after resolution reopens the incident where that is the same problem (failures), or starts a
new one where it is a new fact (a new EFT proof).

**Lifecycle.** open → acknowledged → resolved (note required for action items) → archived; per-admin read state; who / when / note recorded and
audited; workflows close their own incidents (EFT reviewed, payment arrived, quote sent, enquiry replied, order refunded, sync recovered,
invoice paid, renewal recorded ...).

**New background jobs / monitors.** Job monitor + watchdog (`lib/job-monitor.js`, every scheduled job wrapped, missed-run detection),
operations monitor (`lib/ops-monitor.js`, hourly), compliance expiry monitor (`lib/compliance-monitor.js`, daily + on change), notification
retention (in `lib/data-retention-caretaker.js`, daily + at boot). System Integrity (Security & Audit) shows all of it live.

**Database changes** (additive only): migration 119 - `activity_log`, `admin_notifications`, `admin_notification_reads`, `notification_prefs`,
`notification_rules`, `job_heartbeats`, `expiry_reminders_sent`; migration 120 - `compliance_items`. Settings keys: `notifications_enabled`,
`notification_backup_emails`, `ntf_email_min_priority`, `ntf_low_stock_threshold` (plus the existing `notification_email`).

**Modules integrated.** Payments (PayFast ITN, safety net, pending timeout, ledger check, manual payments, refunds), EFT, invoicing, bookings
(public routes, status choke point, admin cancel / contact / date / quote / contract), enquiries (contact form, mailbox, replies), events,
ticketing (payments, alerts, check-in incl. door links), Google + Microsoft 365 calendars, inbox sync, e-mail outbox, newsletter, admin users,
sign-in + rate limiter, integrations (Google, M365 calendar, mailbox, SMTP), payment settings, bank details, business profile, error handler,
process crash handlers, browser errors, all scheduled jobs.

**Outstanding events not yet monitored.** E-mail template edits; public-site browser errors (deliberately admin-only to avoid spam); a customer
"important response" beyond new enquiries (replies are visible in Inquiries); duplicate calendar entries as such (conflicts and Outlook deletions
are covered); certificate / domain expiry are reminders from the dates the owner records, not live checks of the certificate itself; hooks verified
by reading rather than automated tests: Google `recordSync` (needs a connected account), M365 conflict / external-delete / per-item failures,
bounce matching, and the client accept-quote / correction / revision / contract-sign / payment-plan routes.

**Testing results.** New suites: `notify-engine` (35), `notify-jobs` (34), `notifications` API (61), `notify-operations` (30),
`notify-ops-monitor` (26), `notify-security` (7), `notify-governance` (32), browser `notifications.js` (28). Full suite (crash-tolerant run,
Phase 2): 3816 / 3846 - every failure also fails on pristine HEAD (environment: an inactive service in the live DB copy, another session's
menu rename, inbox sync enabled in the copy; and `npm test` itself aborts at `cleanup-test-data.test.js`, a pre-existing crash). Phase 3 ran
the related existing suites plus every notification suite (business profile, newsletter opt-in / scheduling, users / audit history, M365 and Google
calendars, inbox sync, rate limiters, SMTP, admin nav): 881 / 890 before one test-only fix, every remaining failure a known baseline one (nav rename
by another session; inbox / calendar sync enabled in the live DB copy). Browser test: 29 / 29 incl. the Expiry dates tab.
Sandbox only: SMTP mocked, fake Microsoft / Google answers, no real payments, refunds or customer e-mails.

**Additional service costs / external dependencies.** None added - no new packages, no third-party services; everything runs in the existing
Node.js app and SQLite database. Options assessed: browser push (Web Push with VAPID keys) costs nothing and needs no provider - can be added as
an opt-in; SMS and WhatsApp need a paid provider (per-message pricing, WhatsApp business verification) and were not introduced, as instructed.

## 1. How it works, end to end

```
 module (payment.js, eft-approval.js, a job, the error handler ...)
        │  notify.emit('finance.eft_proof_submitted', { ... }, { req })        ← after the commit, never awaited on a user's path
        ▼
 lib/notify.js ── sanitize payload (no secrets, no client e-mail in the log)
        ├─► activity_log                (always: what happened, when, who/what started it)
        ├─ registry says 'activity'? stop here
        ├─► admin_notifications         (ONE row per incident: a repeat bumps occurrence_count; escalate / reopen per the registry)
        └─► e-mail (first occurrence, reopen, escalation, explicit stage) through the existing outbox
               → notification_email (+ backup recipients when critical) → background-clerk queue → retries / SMTP pause / Delivery Log
 browser: bell polls /api/admin/notifications/summary every 30 s; Insight → Notifications lists, acknowledges, resolves, archives
```

1. A module calls `notify.emit(eventKey, payload, ctx)`. It never throws and never rejects.
2. The registry entry (`lib/notify-events.js`) decides category, default priority, kind (`action` / `attention` / `activity`), the dedupe key,
   reopen / escalation behaviour, audience, mandatory flag and the e-mail wording.
3. Overrides: `notification_rules` (business-wide, administrator) and `notification_prefs` (per admin, in-app only). A **mandatory** event
   cannot be switched off, have its e-mail switched off, or be lowered below High.
4. The workflow that finishes the job closes the incident itself: e.g. approving / rejecting an EFT calls
   `notify.resolve('finance.eft_proof_submitted', submissionId, { req })` → resolved **by that admin**, with a note.
5. An admin can acknowledge (I'm on it), resolve (note required for action items) and archive. Reading never resolves anything.

## 2. Tables (migration 119, `lib/notifications-schema.js`)

| Table | Purpose |
|---|---|
| `activity_log` | chronological record: `occurred_at, event_type, category, severity, actor_type (admin/client/system/gateway), actor_id, actor_label, entity_type, entity_id, summary, details_json, correlation_id` |
| `admin_notifications` | one row per incident; lifecycle `open → acknowledged → resolved → archived`, with `ack_by/at`, `resolved_by/at`, `resolution_note`, `resolved_auto`; `occurrence_count`, `first/last_seen_at`; `email_state`; partial UNIQUE index: at most one open incident per `dedupe_key` |
| `admin_notification_reads` | per-admin read state |
| `notification_prefs` | per-admin, per-category in-app switch (mandatory items always show) |
| `notification_rules` | business-wide per-event overrides (enabled / priority / e-mail) |
| `job_heartbeats` | per scheduled job: expected interval, last run / success / error, consecutive failures |
| `expiry_reminders_sent` | reserved for the P3 expiry service (one reminder per item, expiry date and stage) |

NOT the `notifications` table - that is the e-mail outbox. E-mails a notification sends are outbox rows with
`related_entity = 'admin_notification'`, which is how the Centre shows "e-mail sent / pending / failed".

Settings keys (dedicated, validated route - never the generic settings PUT): `notifications_enabled` (master switch; the Activity Log keeps
recording), `notification_email` (existing primary recipient), `notification_backup_emails` (critical only, max 5), `ntf_email_min_priority`
(default `high`).

## 3. Priorities, kinds and the three views

| Priority | Used for | E-mail by default |
|---|---|---|
| critical | money integrity (unmatched / mismatched / unrecordable payment), safety net down, crash, repeated server errors | yes + backups |
| high | EFT awaiting verification, payment failed / pending, ITN refused, ledger drift, bank / financial settings changed, job failing / stopped, expiry approaching | yes |
| medium | browser errors, (P2) new enquiries, new ticket orders, subscribers | no (threshold) |
| info | routine success (payment received, EFT approved) | no - Activity Log only |

Views: **Action required** (kind `action`, open), **Attention** (kind `attention`, open), **Activity feed** (`activity_log`). Filters: Open, Unread,
Urgent (critical + high), Resolved, All; category, dates, search (title, body, reference).

Escalation: `system.server_error` / `finance.itn_rejected` become critical at 10 occurrences, `system.job_failed` at 5, `email.send_failed` at 5.
An escalation re-surfaces the item as unread and e-mails once.

## 4. Events (Phase 1)

| Event | Kind / priority | Where it is raised | Legacy e-mail |
|---|---|---|---|
| `finance.eft_proof_submitted` | action / high, mandatory | `routes/public/eft.js` (client upload) - **never** "payment received" | absorbed (same wording) |
| `finance.eft_approved` / `eft_rejected` | activity | `lib/eft-approval.js`; both resolve the proof's incident | - |
| `finance.payment_received` | activity | ITN success, manual payment (`lib/payment-processing.js`) | admin payment e-mail unchanged |
| `finance.payment_failed` | action / high | ITN non-COMPLETE (not CANCELLED); resolved by the next payment | legacy kept (`email:false`) |
| `finance.payment_pending_timeout` | action / high | `lib/payfast-pending-timeout-job.js`, per redirect, once | absorbed (was an hourly repeating digest) |
| `finance.itn_rejected` | attention / high→critical | `logPaymentEvent` FAILED_* (stale, signature [not sandbox], IP, merchant, confirmation, no id) | new |
| `finance.payment_unmatched` | action / critical | ITN for a booking that does not exist | new |
| `finance.payment_amount_mismatch` | action / critical | ITN amount ≠ payment intent (production) | new |
| `finance.payment_credit_failed` | action / critical | no total / credit failed / overpayment | legacy kept |
| `finance.payfast_recovered` / `payfast_finding` / `payfast_safety_net_failure` | attention / action | `lib/payfast-reconcile.js`; finding resolves with the reconciliation finding; failure resolves on the next good run | absorbed |
| `finance.ledger_drift` | action / high | nightly ledger job; e-mails again only when the set of bookings changes; resolves when clean | absorbed |
| `finance.refund_recorded` | activity | booking refund route | - |
| `finance.bank_details_changed` | attention / high, admin-only | `routes/admin/eft.js` (field names only) | new |
| `finance.settings_changed` | attention / high, admin-only | EFT settings, payment policies, PayFast credentials (policies + PayFast were not audited before - now they are) | new |
| `events.ticket_payment_mismatch` / `ticket_paid_twice` / `ticket_refund_required` | action | `lib/ticketing-payments.js`, `lib/ticketing-delivery.js`; resolved when the order is marked refunded | absorbed |
| `system.job_failed` / `system.job_missed` | attention / action | `lib/job-monitor.js` | new |
| `system.server_error` / `system.crash` / `system.client_error` | attention / action | `middleware/error-handler.js` (≥500, `ref` in the JSON), `server.js` process handlers, `POST /api/admin/client-errors` | new |
| `system.email_queue_stuck` | action / critical | `lib/background-clerk.js` | legacy direct e-mail kept (the queue is what is stuck) |
| `email.send_failed` | attention / high | outbox row failed for good | in-app only (never mail about mail failing) |
| `compliance.expiring` | attention / high | registered; the monitor arrives with the expiry service | - |

## 4b. Events (Phase 2 - operations, 2026-11-03)

Legacy admin e-mails that already exist for these stay as they are (`email: false`, the registry names them in `legacyEmail`), so nothing is
sent twice; the Centre adds the in-app item, the lifecycle and the Activity Log.

| Event | Kind / priority | Raised in | Closes itself when |
|---|---|---|---|
| `bookings.request_received` | action / medium | public booking POST (`routes/public/bookings.js`) | the booking leaves PENDING (`lib/booking-status.js`), a quote is sent, the client cancels, or it expires |
| `bookings.enquiry_received` | action / medium | contact form (`lib/contact-intake.js`), new mail in the booking mailbox (`lib/inbox-sync.js`) | a reply is accepted (`lib/inquiry-messages.js markReplied`) or it is marked replied / archived |
| `bookings.status_changed` | activity | every admin status change (`applyStatusChange`) | - |
| `bookings.cancelled` | attention / high | client cancel, admin `/cancel`, status → CANCELLED; shows the refund due | - |
| `bookings.rescheduled` | attention / medium | `lib/booking-reschedule.js` (admin date change, Outlook time) | - |
| `bookings.quote_accepted` / `quote_expired` | attention / medium | accept-quote route; background clerk | - |
| `bookings.request_expired` | activity | background clerk (48 h without a quote) | - |
| `bookings.revision_requested` / `change_requested` | action / medium | quote-revision and correction-request routes | a new quote is sent / the quote expires (revision) |
| `bookings.contract_signed` | action / medium (countersign due) | client contract sign | the admin countersigns |
| `bookings.payment_plan_changed` / `invoice_issued` | activity | payment-plan route; `lib/invoicing.js` | - |
| `bookings.milestone_due` | attention / medium | operations monitor (due within 3 days) | paid / no longer due soon |
| `finance.invoice_overdue` | action / high | operations monitor (status OVERDUE) | paid, voided or re-dated (in-app only - the overdue digest e-mail stays) |
| `customer.contact_changed` | attention / medium | client contact route and admin contact route; previous / new values in details (administrators only) | - |
| `events.created` / `events.updated` | activity | `routes/admin/events.js` | - |
| `events.cancelled` | attention / high | event set to cancelled / postponed (once per change); says how many paid ticket orders need a decision | - |
| `events.ticket_orders` | attention / medium | `lib/ticket-alerts.js` after a paid order - ONE item per show per day, counting orders (complimentary excluded) | - |
| `events.low_stock` / `events.sold_out` | attention / high, medium | `lib/ticket-alerts.js`; threshold `ntf_low_stock_threshold` (default 10, 0 = off) in Preferences | low stock closes on sell-out |
| `events.sales_closing` / `events.upcoming` | attention / medium | operations monitor (48 h / 3 days) | sales over / event past |
| `events.checkin` | activity | `lib/ticketing.js checkIn` (admin scanner AND door links) | - |
| `events.checkin_duplicate` / `checkin_void` | attention / medium → high | same; grouped per show (escalates at 10 / 5) | - |
| `calendar.sync_failed` | attention / high → critical | Google `recordSync` (2 failures in a row), M365 `failRun` (2 in a row) | the next good sync |
| `calendar.item_failed` | attention / medium | M365 `failLink` (3+ attempts), grouped | - |
| `calendar.conflict` | action / medium | M365 pull sees an Outlook edit | `resolveConflict` |
| `calendar.external_deleted` | attention / high | M365: deleted in Outlook, still on the website | - |
| `email.inbox_sync_failed` | attention / high → critical | `lib/inbox-sync.js failRun` (2 in a row) | the next good run |
| `email.reply_bounced` | attention / medium | inbox sync matched a bounce to a reply | - |

Removed: the "Calendar Sync Failed" admin e-mail on new bookings (`routes/public/bookings.js`) - it could never fire (`syncBookingToCalendar`
never rejects). Google failures now surface through `calendar.sync_failed`.

**Operations monitor** (`lib/ops-monitor.js`, hourly, monitored): overdue invoices, milestones due in 3 days, events in 3 days, ticket sales
closing in 48 h. Each item refreshes its wording and closes itself when the condition is gone (`closeGone`).

Stored text: the engine decodes entity-encoded DB text once (`decodeStoredText`) before building titles - "O'Brien & Sons", never `O&#x27;Brien`.

## 4c. Events (Phase 3 - governance, 2026-11-03)

| Event | Kind / priority | Raised in |
|---|---|---|
| `subscribers.signed_up` | activity | public subscribe (address masked `f***@domain`) |
| `subscribers.confirmed` / `unsubscribed` | attention / medium, info - ONE item per day with a count | confirm / unsubscribe routes |
| `subscribers.confirmation_failed` | attention / medium (in-app only) | confirmation e-mail could not be queued |
| `security.user_created` / `user_changed` (role, suspended, re-activated, deleted) | attention / high, mandatory, administrators only | `routes/admin/users.js` |
| `security.login_failed` | activity | every failed admin sign-in (`lib/security-alerts.js`); the password is never passed |
| `security.login_failed_repeated` | attention / high → critical | 3+ failures for one account within 15 minutes |
| `security.login_locked` | attention / high | the login rate limiter blocked an address (its `handler`) |
| `security.integration_changed` | attention / high, mandatory | Google Calendar connect / disconnect / settings, M365 calendar on / off, mailbox collection on / off, SMTP changed |
| `customer.business_changed` | attention / medium, administrators | any business-profile change, before / after in details (sensitive fields masked) |
| `customer.registration_changed` | attention / high, mandatory, administrators | tax / VAT / business type, and legal / trading / SARS names, registration / enterprise / tax reference numbers, registered address |
| `compliance.expiring` (list items) | attention / high | `compliance_items` via the monitor; changes re-check at once; removal resolves |

**Expiry dates tab** (Notification Centre, administrators + managers; only administrators delete): domain, SSL, Microsoft 365, API credentials,
licences, tax / VAT documents, insurance, other; the B-BBEE certificate from the Business Profile is listed read-only. API:
`GET/POST /api/admin/compliance-items`, `PUT/DELETE /api/admin/compliance-items/:id`, all audited.

## 5. Scheduled-job monitoring

`lib/job-monitor.js` `monitored(name, label, intervalMs, fn)` wraps a job: heartbeat in `job_heartbeats`, failure → one grouped
`system.job_failed` (resolves on the next success), re-throws so the job's own logging is unchanged. `beat()` for callback-style jobs.
A watchdog (5 min, unref'd, started by the first registration) raises `system.job_missed` after 2 × interval + 2 min without a run (the
process start counts, so a redeploy never false-alarms) and clears it when the job runs.

Monitored: payment / deposit / invoice / event / quote / post-event reminders, overdue invoice sweep, stalled-booking alert, abandoned-booking
reminders, ledger reconciliation, PayFast pending timeout, PayFast safety net, ticket hold expiry, Google calendar hold sync, the hourly
lifecycle sweep, overdue flagging, analytics rollup, notification retention. Not wrapped (own state rows / high frequency): the 20 s e-mail
queue (covered by the stuck-queue check), inbox sync and M365 calendar (their state is shown in System Health).

System Integrity (Security & Audit) now shows this live instead of the static mock.

## 6. Retention (`lib/data-retention-caretaker.js`, daily + 2 min after boot)

Activity Log 13 months; resolved / archived incidents 12 months; resolved info-priority 90 days. **Unresolved incidents are never deleted.**

## 7. API (`routes/admin/notifications.js`)

`GET /api/admin/notifications` (view, filter, category, priority, from, to, q, page, pageSize) · `GET .../summary` · `GET .../meta` ·
`GET .../:id` · `POST .../read {ids, read}` · `POST .../read-all` · `POST .../:id/ack|resolve|archive {note}` · `GET /api/admin/activity` ·
`GET/PUT /api/admin/notification-prefs` · administrator: `GET/PUT /api/admin/notification-rules[/:event]`, `GET/PUT /api/admin/notification-settings`,
`GET /api/admin/system-health` · `POST /api/admin/client-errors` (signed-in, 20/min per admin).

## 8. Files

New: `lib/notify.js`, `lib/notify-events.js`, `lib/notify-store.js`, `lib/notifications-schema.js`, `lib/job-monitor.js`, `lib/compliance-monitor.js`,
`lib/ops-monitor.js`, `lib/ticket-alerts.js`,
`routes/admin/notifications.js`, `js/admin/notifications.js`, `css/admin/notifications.css`.
Hooks: see the "Where" column above, plus `database.js` (schema), `app.js` (router), the job files (one `monitored(...)` line each).

## 9. Testing

`test/notify-engine.test.js` (+ `.child.js`, real engine on a throwaway DB), `test/notify-jobs.test.js` (+ `.child.js`, job monitor + retention),
`test/notifications.test.js` (API against the test server: roles, lifecycle, prefs, rules, settings, client errors, health, activity).
Nothing real is sent: SMTP mock; the outbox is inspected, never drained.

Phase 2 adds `test/notify-operations.test.js` (real routes: enquiry, booking request, status, cancel, contact change, date move, event cancel;
roles) and `test/notify-ops-monitor.test.js` (+ `.child.js`: operations monitor, ticket alerts, check-ins, calendar / mailbox failures with fake
Microsoft answers).

## 10. Not yet / known limits

- Phase 3: subscribers, user / security events (account created / role / disabled, failed-login bursts), integration connect / disconnect,
  business / tax / trading-name changes, the generic compliance-document list, full preference UI per role.
- Phase 2 hooks not covered by an automated test (verified by reading): Google `recordSync` (needs a connected Google account), M365 conflict /
  external-delete / per-item failures, bounce matching, the accept-quote / correction / revision / contract-sign / payment-plan client routes.
- The generic expiry service (B-BBEE, domain, SSL, M365, API credentials): Phase 3. The B-BBEE certificate in the business profile expires 2026-11-18.
- Web push is possible at no cost (VAPID, no third party); SMS / WhatsApp need paid providers - costed before anything is added.
- Activity rows for client-side events are only as good as the module that emits them; DB-trigger-only changes (bookings / events status) are
  announced from the application call sites in Phase 2.
