# Comprehensive End-to-End Booking Process Audit — Thabiso Mhlongo Management Platform

## 0. Verified System Context (read this before auditing — corrects assumptions in a
generic version of this brief that do not match this codebase)

**Stack & scale:** Node.js/Express (`server.js`, ~9,550 lines) + SQLite (`database.js`,
schema only, ~1,330 lines) + two large single-file frontends: `index.html` (public
site, ~2,700 lines) and `admin.html` (admin portal, ~19,800 lines). No separate
frontend framework/build step — everything is server-rendered routes + jQuery/Bootstrap
in `admin.html`.

**Confirmed schema** (grep `CREATE TABLE` in `database.js` before assuming any other
table exists): `admins`, `password_reset_tokens`, `inquiries`, `bookings`,
`payment_logs`, `clients`, `venues`, `comedians`, `services`, `service_uoms`,
`booking_services`, `tax_rates`, `booking_line_items`, `quotations`,
`quote_line_items`, `invoices`, `invoice_line_items`, `transactions`,
`cancellations`, `contracts`, `communication_log`, `date_holds`,
`payment_schedules`, `booking_notes`, `expenses`, `policies`, `settings`,
`sars_rates`, `audit_log`, `reminders_log`, `notifications`, `schema_migrations`,
`service_reviews`, `working_hours`, `consent_audit`. (Plus CMS-only tables —
newsletter, gallery, career, social, home_slider, about_me — not part of the
booking lifecycle.)

**Terminology corrections vs. a generic audit brief:**
- There is **no dedicated "CRM" section or `clients` admin page** — no
  `clientsAdmin`/`clientsTable`/`clientModal` exists anywhere in `admin.html`.
  Client data is managed inline through the booking detail view (`bookingsAdmin`),
  keyed by `clients.id`. Treat "CRM integration" as "how booking ↔ client data
  stays consistent," not as a standalone module to inspect.
- "**Quote Builder**" is real, but it's a **modal** (`#quoteModalLabel`,
  `quoteModal`) launched from a booking card's "Send Quote" action — not a
  standalone page.
- "**Financial Ledger**" is real — it's the literal heading on the `financeAdmin`
  section (`<h2 class="atl-section-heading">... Financial Ledger</h2>`).
- "**Contract management**" is real but also lives **inline per-booking**
  (`renderInlineContractPanel()`, `contractModal`) plus
  `GET /api/admin/bookings/:id/contract` — there is no standalone Contracts list page.
- "**Audit logs**" and "**Activity logs**" are **the same single table**
  (`audit_log`), surfaced in the `securityAdmin` section via `loadAuditLogs()` /
  `GET /api/admin/audit_log`. Do not treat these as two separate subsystems.
- "**Role-based permissions**" — confirmed **not implemented**. The `admins` table
  has no `role` column at all; all 144 protected routes gate through a single flat
  `requireAdmin` middleware. There is no ADMIN vs. MANAGER distinction anywhere in
  the schema or routes. Audit this as a confirmed gap, not an unknown.
- Full list of actual top-level admin sections (`id="...Admin"` in `admin.html`):
  `dashboardAdmin`, `bookingsAdmin`, `inquiriesAdmin`, `calendarAdmin`,
  `eventsAdmin`, `financeAdmin`, `servicesAdmin`, `usersAdmin`, `securityAdmin`,
  `emailLogsAdmin`, `newsletterAdmin`, `policiesAdmin`, `contactAdmin`,
  `brandingAdmin`, `careerAdmin`, `galleryAdmin`, `homeAdmin`, `aboutAdmin`,
  `socialAdmin`, `preferencesAdmin`. Anything you'd call "CRM," "Contracts," or
  "Quotes/Invoices" lives inside `bookingsAdmin` or `financeAdmin`, not as its own tab.

**Confirmed integrations (real, not aspirational):**
- **PayFast**: ITN webhook at `POST /api/payment/webhook/payfast` (rate-limited),
  `transactions` table has `pf_payment_id`, `pf_signature`, `pf_status` columns.
- **Google Calendar**: genuine two-way sync — conflict checking against Thabiso's
  calendar, event creation/removal, and a local `date_holds` reconciliation pass
  (`block_type = 'calendar_sync'`) that prunes holds no longer present on Google's
  side. Confirm sync coverage per booking-creation path (see known gap below).

**Confirmed status-value inconsistency (real risk, not a guess):** the codebase
mixes **UPPERCASE** status conventions (`bookings.status`: `NEW`, `QUOTED`,
`ACCEPTED`, `CONFIRMED`, `DEPOSIT_PAID`, `COMPLETED`, `CANCELLED`, `EXPIRED`) with
**lowercase** conventions on related tables (`quotations`/`invoices`/`contracts`/
`transactions`/`date_holds`/`payment_schedules`: `draft`, `sent`, `paid`, `pending`,
`failed`, `cancelled`, `completed`, `signed`, `active`, `released`). Any SQL filter
or JS comparison that hardcodes a casing assumption is a candidate bug — one
instance is already confirmed (`invoices.status != 'VOID'` is case-sensitive and
silently misses lowercase-voided rows). **Systematically search for this pattern
across all status comparisons, not just invoices.**

**Known starting findings from a prior partial audit** (flagged previously — verify
these are still accurate and assess full downstream impact rather than treating
them as already fixed):
- `POST /api/admin/bookings` (manual booking creation, confirmed route) was
  previously found to bypass conflict detection, skip service/line-item record
  creation, skip end-time computation, not sync to Google Calendar, and allow
  direct `CONFIRMED`-status creation without payment — i.e., it does not enforce
  the same business rules as the public booking path. Confirm current behavior.
- Invoice status casing bug described above.
- No role/permission tier exists (confirmed in this audit, see above).

---

## 1. Objective

Conduct a comprehensive end-to-end audit of the booking process across
`index.html` (public site) and `admin.html` (admin portal), backed by `server.js`
and `database.js`, to determine whether the workflow is robust, scalable, secure,
user-friendly, and operationally complete — and to produce a concrete, prioritised
remediation plan grounded in the actual schema, routes, and UI confirmed above.

## 2. Scope of Review

Analyse the complete booking lifecycle as it actually exists in this system:

**Visitor Inquiry (`inquiries` table) → Booking Request (`bookings`) → Quote
Creation (`quotations` + Quote Builder modal) → Quote Delivery → Quote Acceptance
→ Booking Confirmation → Contract Generation (`contracts`, inline panel) →
Invoice Generation (`invoices`) → Payment Collection (`transactions`, PayFast ITN)
→ Payment Schedules (`payment_schedules`, `reminders_log`) → Event Planning
(`events`, Google Calendar) → Event Execution → Event Completion → Receipting →
Reporting & Analytics (`dashboardAdmin`).**

Evaluate how data, statuses, notifications, documents, and integrations move
across this whole chain — not each admin section in isolation.

### Frontend Booking Flow (`index.html`)

Review:
- Booking enquiry / contact forms and their write path into `inquiries` vs. `bookings`
- Quote acceptance workflow (client-facing) and what it actually updates
- Booking status visibility to the client
- PayFast client-side payment experience and post-payment redirect/confirmation handling
- Mobile responsiveness, WCAG accessibility, form validation, error handling, and confirmation messaging

Determine whether a client can move through the journey without confusion, dead
ends, inconsistent information, or missing communication.

### Admin Booking Flow (`admin.html`)

Review, using the actual section IDs above:
- Manual booking creation (`POST /api/admin/bookings`) vs. the public booking path — confirm parity or document the gap
- Booking management and pipeline within `bookingsAdmin`
- Quote Builder modal — generation, line items, expiry, sending, acceptance tracking
- Inline Contract panel/modal — generation, sending, signing, status (`draft`/`sent`/`signed`)
- `financeAdmin` (Financial Ledger) — invoices, transactions, payment schedules, expenses
- Payment milestone management (`payment_schedules`, `reminders_log`)
- `eventsAdmin` and `calendarAdmin` — event creation and Google Calendar sync
- `usersAdmin` and `securityAdmin` — admin account management, and the confirmed absence of role tiers
- `audit_log` coverage via `securityAdmin` — which actions are actually logged vs. silent
- `dashboardAdmin` — KPI accuracy and live-vs-static data (cross-reference any existing dashboard analytics work already done on this codebase, if present, rather than re-deriving it from scratch)

Determine whether administrators have what they need to manage a booking from
enquiry through completion, and where the manual path diverges from the
public/automated path.

## 3. Workflow Logic Audit

Map every value `bookings.status`, `quotations.status`, `invoices.status`, and
`contracts.status` can actually take (per the confirmed values above) and verify:
- Can a booking reach `CONFIRMED` without an `quotations` row in an accepted state?
- Can an `invoices` row be created before its linked quote is accepted?
- Can a `transactions` row exist with no corresponding `invoices.id`?
- Can a booking reach `COMPLETED` while `amount_outstanding > 0`?
- Can a `CANCELLED` booking still have unprocessed `transactions`/refunds
  (`cancellations.refund_due` vs. actual processed state)?
- Can duplicate `quotations` or `invoices` rows be generated for the same booking?
- Where do the UPPERCASE (`bookings`) and lowercase (`quotations`/`invoices`/
  `contracts`/`transactions`) status vocabularies need to agree, and where do
  comparisons assume the wrong casing (see confirmed `VOID` bug above)?

Identify every transition the backend does *not* actually guard against.

## 4. Quote & Invoice Lifecycle

Review, against actual table relationships:
- `quotations` → `quote_line_items` generation and the Quote Builder modal
- Quote sending (`quotations.sent_at`) and acceptance flow
- `invoices` → `invoice_line_items` generation, VAT handling (`is_vat_inclusive`,
  `tax_rates`, `sars_rates`)
- `payment_schedules` milestone/deposit calculations and their relationship to
  `invoices.total_amount` / `bookings.amount_outstanding`
- `reminders_log` — pre-due and overdue reminder firing (`invoices.pre_due_reminded_at`,
  `overdue_reminded_at`)
- Receipting — confirm whether a receipt is a distinct artifact or just a paid-invoice state
- Whether `bookings.total_amount`/`amount_paid`/`amount_outstanding` (the
  "decimal ledger" columns per the migration comment in `database.js`) stay in
  sync with the relational `invoices`/`transactions` data, or whether these are
  two sources of truth that can drift

## 5. Payment Processing Audit

Review:
- PayFast ITN webhook (`POST /api/payment/webhook/payfast`) — signature
  verification, idempotency (`transactions.pf_payment_id UNIQUE`), replay
  protection, rate limiting
- Deposit vs. final payment handling through `payment_schedules`
- Manual/offline payment entry (admin-side) vs. PayFast-confirmed payment —
  confirm both paths reconcile into the same `transactions`/ledger state, and
  check for the duplicate-payment scenario referenced in the codebase comment
  ("'duplicate': both payfast and manual entries exist for same booking")
- Failed/pending PayFast transactions (`pf_status`) and what the system does with them
- Refunds — `cancellations.refund_due`/`refund_processed_at` vs. any actual refund execution path (PayFast or manual)

## 6. Integration Review

Verify that booking actions correctly and consistently update:
- `events` + Google Calendar (both directions, including the `date_holds` sync
  reconciliation pass)
- `clients` (created/matched, not duplicated, on each new booking)
- `transactions` / the finance ledger
- `audit_log`
- `notifications` (the actual unified table — check `related_entity`/`related_id`
  usage for booking-related events specifically)
- `dashboardAdmin` KPIs

Identify any action that updates one of these but not another (e.g., a status
change that updates `bookings.status` but not `audit_log`, or a manual booking
that doesn't create a Google Calendar event).

## 7. Data Integrity Review

Verify foreign-key consistency and look for drift between:
- `bookings` legacy fields (`quote_amount`, `quote_details` as TEXT) vs. the
  relational `quotations`/`quote_line_items` — confirm which is authoritative and
  whether both are still being written
- `bookings.amount_paid`/`amount_outstanding` vs. `SUM(transactions.amount)` for
  the same booking
- Duplicate `clients` records from repeated bookings using the same email/phone
- Orphaned `quotations`/`invoices`/`contracts` rows (booking deleted or status
  changed without cascading)

## 8. Automation Opportunities

Identify where the system could automatically (and where it currently requires
manual admin action) generate: follow-up reminders beyond `reminders_log`'s
current scope, `notifications` for stalled bookings (e.g., quote sent but not
accepted after N days), automatic event creation on booking confirmation,
automatic receipt issuance on full payment, and `dashboardAdmin` KPI refresh
triggers.

## 9. Security & Compliance Review

Assess:
- `requireAdmin`-gated routes (144 confirmed occurrences) — confirm none of the
  booking/finance-sensitive routes are missing this gate
- The confirmed absence of role separation — what's the actual blast radius (can
  any authenticated admin void invoices, edit financial data, delete bookings?)
- `consent_audit` / `popia_consent` handling on `inquiries`/`bookings` — is it
  enforced or just recorded?
- PayFast webhook signature/IP validation
- Input sanitisation on manual booking creation and Quote Builder line items
- `audit_log` completeness — which financially significant actions are NOT logged

## 10. User Experience Review

Evaluate workflow clarity, next-step guidance, and status indicators for both
the client (`index.html`) and admin (`bookingsAdmin` pipeline view) — whether
each side always knows current booking status, outstanding actions, next
required step, payment status, and event readiness.

## 11. Edge Case Testing

Review system behavior for: cancelled bookings (`cancellations` table) with
prior payments, rescheduled events, expired quotes (`quotations.expiry_date`
vs. enforcement), overdue invoices (`invoices.due_date` vs. `reminders_log`),
partial/failed PayFast payments, duplicate booking submissions, manual bookings
missing required client info, and session-timeout/network-failure recovery on
both the public booking flow and admin panel.

## 12. Deliverables

1. A complete booking process map reflecting the **actual** tables/routes/UI
   confirmed above (not a generic lifecycle diagram).
2. A gap analysis of the current workflow, distinguishing newly-found issues
   from the known starting findings listed in §0.
3. Critical issues ranked by severity (P1–P4).
4. Missing validations and business rules, with exact route/file/line references.
5. Missing or inconsistent integrations (per §6).
6. Data integrity concerns (per §7), including the legacy-vs-relational quote/
   invoice field duplication.
7. Security concerns (per §9), prioritising the confirmed no-role-tier gap.
8. UX/UI recommendations for both `index.html` and `admin.html`.
9. Automation opportunities (per §8).
10. Database improvement recommendations (schema, indexes, constraints —
    especially around the status-casing inconsistency in §3).
11. Reporting/analytics improvements for `dashboardAdmin`.
12. A prioritised remediation plan, sequenced so that data-integrity and
    security fixes (status casing, manual-booking parity, role separation)
    precede UX polish.

## 13. Final Objective

Transform the booking process into a fully integrated, enterprise-grade artist
management workflow — robust, scalable, secure, financially accurate,
mobile-first, and capable of supporting the complete lifecycle from first
enquiry through final payment and event completion — grounded entirely in what
this specific codebase actually does, not in assumed best-practice features it
doesn't yet have.
