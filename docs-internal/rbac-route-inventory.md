# RBAC Route Inventory

**Generated:** 2026-11-23  
**Total routes:** 410  
**Scope:** All files under `routes/admin/`

## Summary

| Status | Count | Meaning |
|--------|-------|---------|
| DONE | 31 | Already using `requirePermission(...)` |
| EXEMPT | 8 | Auth/session endpoints — no RBAC check applies |
| PENDING | 371 | Using `requireAdmin` or `requireRole([...])` — needs conversion |

## Legend

**Status**
- `DONE` — route already uses `requirePermission('key')` ✓
- `PENDING` — still uses `requireAdmin` or `requireRole([...])`, needs conversion
- `EXEMPT` — login/logout/reset-password/session — not subject to RBAC

**Scope** (derived from current guard)
- `any-admin` — `requireAdmin` only (all logged-in admins)
- `manager+` — `requireRole(['administrator','manager'])`
- `admin-only` — `requireRole(['administrator'])`
- `no-auth` — no session required (public auth endpoints)

**Proposed Permission** — target `requirePermission('key')` after conversion.  
Keys marked `*NEW*` need a new action added to `lib/rbac-registry.js` before conversion.

---

## Group: Auth (auth.js)

Auth endpoints manage the session lifecycle and do not use the RBAC permission system.

| L# | Method | Path | Proposed Permission | Current Guard | Scope | Status |
|----|--------|------|---------------------|---------------|-------|--------|
| 18 | POST | `/api/admin/login` | EXEMPT | none | no-auth | EXEMPT |
| 74 | POST | `/api/admin/force-change-password` | EXEMPT | session only | any-admin | EXEMPT |
| 90 | POST | `/api/admin/logout` | EXEMPT | session only | any-admin | EXEMPT |
| 116 | GET | `/api/admin/session` | EXEMPT | session only | any-admin | EXEMPT |
| 155 | GET | `/api/admin/me/permissions` | EXEMPT | session only | any-admin | EXEMPT |
| 186 | POST | `/api/admin/forgot-password` | EXEMPT | none | no-auth | EXEMPT |
| 261 | POST | `/api/admin/reset-password` | EXEMPT | none | no-auth | EXEMPT |
| 341 | POST | `/api/admin/session/heartbeat` | EXEMPT | session only | any-admin | EXEMPT |

---

## Group: Bookings (bookings.js)

| L# | Method | Path | Proposed Permission | Current Guard | Scope | Status |
|----|--------|------|---------------------|---------------|-------|--------|
| 260 | GET | `/api/admin/bookings/:id/communications` | `bookings.view` | requireAdmin | any-admin | PENDING |
| 271 | POST | `/api/admin/bookings/:id/unlink-client` | `bookings.edit` | requireAdmin | any-admin | PENDING |
| 280 | GET | `/api/admin/bookings/:id/notes` | `bookings.view` | requireAdmin | any-admin | PENDING |
| 290 | POST | `/api/admin/bookings/:id/notes` | `bookings.edit` | requireAdmin | any-admin | PENDING |
| 304 | DELETE | `/api/admin/bookings/:id/notes/:noteId` | `bookings.edit` | requireAdmin | any-admin | PENDING |
| 316 | GET | `/api/admin/bookings/:id/details` | `bookings.view` | requireAdmin | any-admin | PENDING |
| 363 | GET | `/api/admin/bookings/:id/quote-history` | `bookings.view` | requireAdmin | any-admin | PENDING |
| 378 | GET | `/api/admin/bookings/:id/expenses` | `bookings.view` | requireRole(['administrator','manager']) | manager+ | PENDING |
| 418 | GET | `/api/admin/bookings/:id/financials` | `bookings.view` | requireRole(['administrator','manager']) | manager+ | PENDING |
| 448 | GET | `/api/admin/bookings/:id/cancellation-preview` | `bookings.view` | requireAdmin | any-admin | PENDING |
| 465 | POST | `/api/admin/bookings/:id/reopen` | `bookings.manage` | requireAdmin | any-admin | PENDING |
| 491 | GET | `/api/admin/bookings/:id/reconcile` | `bookings.view` | requireAdmin | any-admin | PENDING |
| 519 | GET | `/api/admin/bookings/:id/invoice/download` | `invoices.view` | requireAdmin | any-admin | PENDING |
| 534 | GET | `/api/admin/bookings/:id/quote/download` | `bookings.view` | requireAdmin | any-admin | PENDING |
| 550 | GET | `/api/admin/bookings/:id/quote/:quoteId/download` | `bookings.view` | requireAdmin | any-admin | PENDING |
| 566 | POST | `/api/admin/bookings/:id/contract/generate` | `bookings.manage` | requireAdmin | any-admin | PENDING |
| 585 | GET | `/api/admin/bookings/:id/contract/builder-data` | `bookings.view` | requireAdmin | any-admin | PENDING |
| 636 | POST | `/api/admin/bookings/:id/contract/preview` | `bookings.view` | requireAdmin | any-admin | PENDING |
| 670 | GET | `/api/admin/bookings/:id/contract` | `bookings.view` | requireAdmin | any-admin | PENDING |
| 678 | POST | `/api/admin/bookings/:id/contract` | `bookings.manage` | requireAdmin | any-admin | PENDING |
| 737 | PUT | `/api/admin/bookings/:id/contract/sign` | `bookings.approve` | requireAdmin | any-admin | PENDING |
| 815 | GET | `/api/admin/bookings/:id/contract/download` | `bookings.view` | requireAdmin | any-admin | PENDING |
| 835 | POST | `/api/admin/bookings/:id/contract/send` | `bookings.manage` | requireAdmin | any-admin | PENDING |
| 879 | POST | `/api/admin/bookings/:id/contract/remind` | `bookings.manage` | requireAdmin | any-admin | PENDING |
| 935 | POST | `/api/admin/bookings/:id/remind` | `bookings.manage` | requireAdmin | any-admin | PENDING |
| 946 | POST | `/api/admin/bookings/bulk-remind` | `bookings.manage` | requireRole(['administrator','manager']) | manager+ | PENDING |
| 965 | POST | `/api/admin/bookings/:id/resend-quote` | `bookings.manage` | requireAdmin | any-admin | PENDING |
| 982 | POST | `/api/admin/bookings/:id/resend-confirmation` | `bookings.manage` | requireAdmin | any-admin | PENDING |
| 996 | POST | `/api/admin/bookings/:id/review-request` | `bookings.manage` | requireAdmin | any-admin | PENDING |
| 1012 | POST | `/api/admin/bookings/:id/book-again` | `bookings.create` | requireAdmin | any-admin | PENDING |
| 1091 | POST | `/api/admin/bookings/:id/sync-calendar` | `bookings.manage` | requireAdmin | any-admin | PENDING |
| 1102 | PUT | `/api/admin/bookings/:id/venue` | `bookings.edit` | requireAdmin | any-admin | PENDING |
| 1165 | PUT | `/api/admin/bookings/:id/venue-google` | `bookings.edit` | requireAdmin | any-admin | PENDING |
| 1221 | PATCH | `/api/admin/bookings/:id/date` | `bookings.edit` | requireAdmin | any-admin | PENDING |
| 1245 | PATCH | `/api/admin/bookings/:id/venue` | `bookings.edit` | requireAdmin | any-admin | PENDING |
| 1279 | POST | `/api/admin/bookings/:id/quote` | `bookings.approve` | requireRole(['administrator','manager']) | manager+ | PENDING |
| 1650 | GET | `/api/admin/bookings/full` | `bookings.view` | requireAdmin | any-admin | PENDING |
| 1719 | POST | `/api/admin/bookings` | `bookings.create` | requireRole(['administrator','manager']) | manager+ | PENDING |
| 1989 | GET | `/api/admin/bookings` | `bookings.view` | requireAdmin | any-admin | PENDING |
| 2078 | GET | `/api/admin/bookings/:id` | `bookings.view` | requireAdmin | any-admin | PENDING |
| 2156 | PUT | `/api/admin/bookings/:id/contact` | `bookings.edit` | requireRole(['administrator','manager']) | manager+ | PENDING |
| 2251 | PUT | `/api/admin/bookings/:id/event-details` | `bookings.edit` | requireRole(['administrator','manager']) | manager+ | PENDING |
| 2329 | PUT | `/api/admin/bookings/:id` | `bookings.edit` | requireAdmin | any-admin | PENDING |
| 2338 | PATCH | `/api/admin/bookings/:id/buffer` | `bookings.edit` | requireAdmin | any-admin | PENDING |
| 2353 | PUT | `/api/admin/bookings/:id/public` | `bookings.manage` | requireAdmin | any-admin | PENDING |
| 2477 | PUT | `/api/admin/bookings/:id/status` | `bookings.approve` | requireAdmin | any-admin | PENDING |
| 2489 | PUT | `/api/admin/bookings/:id/disposition` | `bookings.edit` | requireAdmin | any-admin | PENDING |
| 2515 | POST | `/api/admin/bookings/:id/invoice/generate` | `invoices.create` | requireRole(['administrator','manager']) | manager+ | PENDING |
| 2544 | POST | `/api/admin/bookings/:id/reconcile/sync` | `payments.manage` | requireRole(['administrator','manager']) | manager+ | PENDING |
| 2608 | GET | `/api/admin/bookings/:id/payment-schedules` | `payments.view` | requireAdmin | any-admin | PENDING |
| 2633 | POST | `/api/admin/bookings/:id/payment-schedules` | `payments.manage` | requireRole(['administrator','manager']) | manager+ | PENDING |
| 2744 | POST | `/api/admin/bookings/:id/payment-schedules/rebalance` | `payments.manage` | requireRole(['administrator','manager']) | manager+ | PENDING |
| 2804 | DELETE | `/api/admin/bookings/:id` | `bookings.delete` | requireRole(['administrator']) | admin-only | PENDING |
| 2873 | POST | `/api/admin/bookings/:id/respond` | `bookings.approve` | requireAdmin | any-admin | PENDING |
| 2927 | PUT | `/api/admin/bookings/:id/manual-payment` | `payments.create` | requireRole(['administrator','manager']) | manager+ | PENDING |
| 2974 | POST | `/api/admin/bookings/:id/cancel` | `bookings.manage` | requireAdmin | any-admin | PENDING |
| 3110 | POST | `/api/admin/bookings/:id/complete` | `bookings.manage` | requireAdmin | any-admin | PENDING |
| 3161 | PUT | `/api/admin/bookings/:id/refund` | `payments.manage` | requireRole(['administrator','manager']) | manager+ | PENDING |

---

## Group: Advancing (advancing.js)

| L# | Method | Path | Proposed Permission | Current Guard | Scope | Status |
|----|--------|------|---------------------|---------------|-------|--------|
| 108 | GET | `/api/admin/bookings/:id/advancing` | `bookings.view` | requireAdmin | any-admin | PENDING |
| 158 | PUT | `/api/admin/bookings/:id/advancing` | `bookings.edit` | requireAdmin | any-admin | PENDING |
| 210 | POST | `/api/admin/bookings/:id/advancing/run-of-show` | `bookings.edit` | requireAdmin | any-admin | PENDING |
| 232 | PUT | `/api/admin/advancing/run-of-show/:itemId` | `bookings.edit` | requireAdmin | any-admin | PENDING |
| 251 | DELETE | `/api/admin/advancing/run-of-show/:itemId` | `bookings.edit` | requireAdmin | any-admin | PENDING |
| 268 | PUT | `/api/admin/bookings/:id/advancing/run-of-show/reorder` | `bookings.edit` | requireAdmin | any-admin | PENDING |
| 305 | POST | `/api/admin/bookings/:id/advancing/contacts` | `bookings.edit` | requireAdmin | any-admin | PENDING |
| 322 | DELETE | `/api/admin/advancing/contacts/:contactId` | `bookings.edit` | requireAdmin | any-admin | PENDING |
| 336 | POST | `/api/admin/bookings/:id/advancing/pdf` | `bookings.manage` | requireAdmin | any-admin | PENDING |
| 365 | GET | `/api/admin/bookings/:id/advancing/download` | `bookings.view` | requireAdmin | any-admin | PENDING |
| 388 | POST | `/api/admin/bookings/:id/advancing/send` | `bookings.manage` | requireRole(['administrator','manager']) | manager+ | PENDING |
| 430 | POST | `/api/admin/bookings/:id/advancing/confirm` | `bookings.manage` | requireAdmin | any-admin | PENDING |

---

## Group: Abandoned Bookings (abandoned-bookings.js)

| L# | Method | Path | Proposed Permission | Current Guard | Scope | Status |
|----|--------|------|---------------------|---------------|-------|--------|
| 10 | GET | `/api/admin/abandoned-bookings` | `bookings.view` | requireAdmin | any-admin | PENDING |
| 43 | GET | `/api/admin/abandoned-bookings/stats` | `bookings.view` | requireAdmin | any-admin | PENDING |
| 70 | GET | `/api/admin/abandoned-bookings/export` | `bookings.export` | requireAdmin | any-admin | PENDING |
| 83 | GET | `/api/admin/abandoned-bookings/:id` | `bookings.view` | requireAdmin | any-admin | PENDING |
| 92 | POST | `/api/admin/abandoned-bookings/:id/resend-reminder` | `bookings.manage` | requireRole(['administrator','manager']) | manager+ | PENDING |
| 106 | PUT | `/api/admin/abandoned-bookings/:id/status` | `bookings.manage` | requireRole(['administrator','manager']) | manager+ | PENDING |

---

## Group: Calendar (calendar.js, calendar-sync.js)

### calendar.js

| L# | Method | Path | Proposed Permission | Current Guard | Scope | Status |
|----|--------|------|---------------------|---------------|-------|--------|
| 89 | GET | `/api/admin/calendar/events` | `calendar.view` | requireAdmin | any-admin | PENDING |
| 245 | POST | `/api/admin/calendar/hold` | `calendar.create` | requireAdmin | any-admin | PENDING |
| 272 | DELETE | `/api/admin/calendar/hold/:id` | `calendar.delete` | requireAdmin | any-admin | PENDING |
| 279 | PATCH | `/api/admin/calendar/hold/:id/date` | `calendar.edit` | requireAdmin | any-admin | PENDING |

### calendar-sync.js

| L# | Method | Path | Proposed Permission | Current Guard | Scope | Status |
|----|--------|------|---------------------|---------------|-------|--------|
| 18 | GET | `/api/admin/calendar-sync` | `integrations.view` | requireAdmin | any-admin | PENDING |
| 25 | POST | `/api/admin/calendar-sync/test` | `integrations.manage` | requireAdmin | any-admin | PENDING |
| 31 | PUT | `/api/admin/calendar-sync` | `integrations.manage` | requireAdmin | any-admin | PENDING |
| 52 | POST | `/api/admin/calendar-sync/run` | `integrations.manage` | requireAdmin | any-admin | PENDING |
| 63 | GET | `/api/admin/calendar-sync/log` | `integrations.view` | requireAdmin | any-admin | PENDING |
| 67 | GET | `/api/admin/calendar-sync/entries` | `integrations.view` | requireAdmin | any-admin | PENDING |
| 75 | GET | `/api/admin/calendar-sync/entry` | `integrations.view` | requireAdmin | any-admin | PENDING |
| 81 | POST | `/api/admin/calendar-sync/entries/:id/` | `integrations.manage` | requireAdmin | any-admin | PENDING |

---

## Group: Events & Ticketing (events.js, ticketing.js)

### events.js

| L# | Method | Path | Proposed Permission | Current Guard | Scope | Status |
|----|--------|------|---------------------|---------------|-------|--------|
| 127 | GET | `/api/admin/events` | `events.view` | requireAdmin | any-admin | PENDING |
| 150 | POST | `/api/admin/events` | `events.create` | requireAdmin | any-admin | PENDING |
| 232 | PUT | `/api/admin/events/:id` | `events.edit` | requireAdmin | any-admin | PENDING |
| 348 | DELETE | `/api/admin/events/:id` | `events.delete` | requireRole(['administrator']) | admin-only | PENDING |
| 378 | PATCH | `/api/admin/events/:id/date` | `events.edit` | requireAdmin | any-admin | PENDING |
| 444 | POST | `/api/admin/events/:id/duplicate` | `events.create` | requireAdmin | any-admin | PENDING |

### ticketing.js

| L# | Method | Path | Proposed Permission | Current Guard | Scope | Status |
|----|--------|------|---------------------|---------------|-------|--------|
| 53 | GET | `/api/admin/events/:id/ticketing` | `events.view` | requireAdmin | any-admin | PENDING |
| 83 | POST | `/api/admin/events/:id/ticket-types` | `events.create` | requireAdmin | any-admin | PENDING |
| 93 | PUT | `/api/admin/ticket-types/:id` | `events.edit` | requireAdmin | any-admin | PENDING |
| 106 | DELETE | `/api/admin/ticket-types/:id` | `events.delete` | requireAdmin | any-admin | PENDING |
| 115 | POST | `/api/admin/ticket-types/:id/capacity` | `events.edit` | requireAdmin | any-admin | PENDING |
| 124 | POST | `/api/admin/ticket-types/:id/enabled` | `events.edit` | requireAdmin | any-admin | PENDING |
| 134 | POST | `/api/admin/events/:id/ticket-types/reorder` | `events.edit` | requireAdmin | any-admin | PENDING |
| 148 | POST | `/api/admin/events/:id/ticket-sales` | `events.manage` | requireAdmin | any-admin | PENDING |
| 164 | PUT | `/api/admin/events/:id/ticket-sales-window` | `events.edit` | requireAdmin | any-admin | PENDING |
| 176 | POST | `/api/admin/events/:id/sold-out` | `events.manage` | requireAdmin | any-admin | PENDING |
| 187 | GET | `/api/admin/events/:id/ticketing-history` | `events.view` | requireAdmin | any-admin | PENDING |
| 198 | GET | `/api/admin/ticketing/events` | `events.view` | requireAdmin | any-admin | PENDING |
| 206 | GET | `/api/admin/ticketing/events/:id/stats` | `events.view` | requireAdmin | any-admin | PENDING |
| 219 | GET | `/api/admin/ticketing/orders` | `events.view` | requireAdmin | any-admin | PENDING |
| 225 | GET | `/api/admin/ticketing/orders/:id` | `events.view` | requireAdmin | any-admin | PENDING |
| 234 | GET | `/api/admin/ticketing/finance` | `finance.view` | requireAdmin | any-admin | PENDING |
| 237 | GET | `/api/admin/ticketing/finance/events/:id/orders` | `finance.view` | requireAdmin | any-admin | PENDING |
| 244 | GET | `/api/admin/ticketing/finance/orders/:id` | `finance.view` | requireAdmin | any-admin | PENDING |
| 252 | POST | `/api/admin/ticketing/orders/:id/resend` | `events.manage` | requireAdmin | any-admin | PENDING |
| 265 | POST | `/api/admin/ticketing/orders/:id/refund` | `payments.manage` | requireAdmin | any-admin | PENDING |
| 295 | POST | `/api/admin/ticketing/events/:id/complimentary` | `events.manage` | requireAdmin | any-admin | PENDING |
| 310 | POST | `/api/admin/ticketing/tickets/:token/reissue` | `events.manage` | requireAdmin | any-admin | PENDING |
| 330 | POST | `/api/admin/ticketing/events/:id/notify-holders` | `events.manage` | requireAdmin | any-admin | PENDING |
| 350 | GET | `/api/admin/ticketing/events/:id/orders.csv` | `events.export` | requireAdmin | any-admin | PENDING |
| 369 | GET | `/api/admin/ticketing/events/:id/attendees.csv` | `events.export` | requireAdmin | any-admin | PENDING |
| 392 | GET | `/api/admin/ticketing/events/:id/door-passes` | `events.view` | requireAdmin | any-admin | PENDING |
| 398 | POST | `/api/admin/ticketing/events/:id/door-passes` | `events.manage` | requireAdmin | any-admin | PENDING |
| 407 | DELETE | `/api/admin/ticketing/events/:id/door-passes/:passId` | `events.delete` | requireAdmin | any-admin | PENDING |
| 415 | GET | `/api/admin/ticketing/tickets/:token` | `events.view` | requireAdmin | any-admin | PENDING |
| 424 | POST | `/api/admin/ticketing/tickets/:token/check-in` | `events.manage` | requireAdmin | any-admin | PENDING |
| 439 | POST | `/api/admin/ticketing/tickets/:token/undo-check-in` | `events.manage` | requireAdmin | any-admin | PENDING |
| 450 | GET | `/api/admin/ticketing/events/:id/door` | `events.view` | requireAdmin | any-admin | PENDING |

---

## Group: Finance (finance.js, financials.js, expenses.js, bank-statement.js, reconciliation.js, transactions.js, invoices.js, eft.js, payfast-reconcile.js)

### finance.js — DONE

| L# | Method | Path | Proposed Permission | Current Guard | Scope | Status |
|----|--------|------|---------------------|---------------|-------|--------|
| 17 | GET | `/api/admin/finance/export` | `finance.export` | requirePermission('finance.export') | — | DONE |
| 72 | GET | `/api/admin/finance/pl` | `finance.view` | requirePermission('finance.view') | — | DONE |

### financials.js — DONE

| L# | Method | Path | Proposed Permission | Current Guard | Scope | Status |
|----|--------|------|---------------------|---------------|-------|--------|
| 15 | GET | `/api/admin/financials/analytics` | `finance.view` | requirePermission('finance.view') | — | DONE |
| 106 | GET | `/api/admin/financials/stats` | `finance.view` | requirePermission('finance.view') | — | DONE |

### expenses.js — DONE

| L# | Method | Path | Proposed Permission | Current Guard | Scope | Status |
|----|--------|------|---------------------|---------------|-------|--------|
| 34 | GET | `/api/admin/expenses` | `finance.view` | requirePermission('finance.view') | — | DONE |
| 55 | POST | `/api/admin/expenses` | `finance.create` | requirePermission('finance.create') | — | DONE |
| 105 | DELETE | `/api/admin/expenses/:id` | `finance.delete` | requirePermission('finance.delete') | — | DONE |
| 129 | PUT | `/api/admin/expenses/:id` | `finance.edit` | requirePermission('finance.edit') | — | DONE |
| 180 | GET | `/api/admin/expenses/export` | `finance.export` | requirePermission('finance.export') | — | DONE |
| 219 | POST | `/api/admin/expenses/upload-receipt` | `finance.create` | requirePermission('finance.create') | — | DONE |

### bank-statement.js — DONE

| L# | Method | Path | Proposed Permission | Current Guard | Scope | Status |
|----|--------|------|---------------------|---------------|-------|--------|
| 26 | POST | `/api/admin/bank-statement/import` | `finance.manage` | requirePermission('finance.manage') | — | DONE |
| 66 | GET | `/api/admin/bank-statement/lines` | `finance.view` | requirePermission('finance.view') | — | DONE |
| 87 | PATCH | `/api/admin/bank-statement/lines/:id/match` | `finance.manage` | requirePermission('finance.manage') | — | DONE |
| 99 | DELETE | `/api/admin/bank-statement/lines/:id` | `finance.delete` | requirePermission('finance.delete') | — | DONE |
| 107 | DELETE | `/api/admin/bank-statement/batch/:batchId` | `finance.delete` | requirePermission('finance.delete') | — | DONE |

### reconciliation.js — DONE

| L# | Method | Path | Proposed Permission | Current Guard | Scope | Status |
|----|--------|------|---------------------|---------------|-------|--------|
| 25 | GET | `/api/admin/reconciliation` | `payments.view` | requirePermission('payments.view') | — | DONE |
| 87 | GET | `/api/admin/reconciliation/:bookingId/transactions` | `payments.view` | requirePermission('payments.view') | — | DONE |
| 97 | GET | `/api/admin/transactions/:id/proof` | `payments.view` | requirePermission('payments.view') | — | DONE |
| 116 | PATCH | `/api/admin/transactions/:id/reconcile` | `payments.manage` | requirePermission('payments.manage') | — | DONE |
| 143 | GET | `/api/admin/reconciliation/export/csv` | `finance.export` | requirePermission('finance.export') | — | DONE |

### transactions.js — DONE

| L# | Method | Path | Proposed Permission | Current Guard | Scope | Status |
|----|--------|------|---------------------|---------------|-------|--------|
| 35 | POST | `/api/admin/transactions/manual` | `payments.create` | requirePermission('payments.create') | — | DONE |

### invoices.js — DONE

| L# | Method | Path | Proposed Permission | Current Guard | Scope | Status |
|----|--------|------|---------------------|---------------|-------|--------|
| 15 | POST | `/api/admin/invoices/:id/send` | `invoices.manage` | requirePermission('invoices.manage') | — | DONE |
| 41 | POST | `/api/admin/invoices/bulk-send-unsent` | `invoices.manage` | requirePermission('invoices.manage') | — | DONE |
| 67 | POST | `/api/admin/invoices/:id/void` | `invoices.delete` | requirePermission('invoices.delete') | — | DONE |
| 101 | POST | `/api/admin/invoices/:id/mark-paid` | `invoices.approve` | requirePermission('invoices.approve') | — | DONE |
| 136 | GET | `/api/admin/invoices` | `invoices.view` | requirePermission('invoices.view') | — | DONE |

### eft.js

| L# | Method | Path | Proposed Permission | Current Guard | Scope | Status |
|----|--------|------|---------------------|---------------|-------|--------|
| 21 | GET | `/api/admin/eft/settings` | `payment-setup.view` | requireAdmin | any-admin | PENDING |
| 29 | PUT | `/api/admin/eft/settings` | `payment-setup.edit` | requireAdmin | any-admin | PENDING |
| 40 | GET | `/api/admin/eft/bank-details` | `payment-setup.view` | requireAdmin | any-admin | PENDING |
| 53 | PUT | `/api/admin/eft/bank-details` | `payment-setup.manage` | requireAdmin | any-admin | PENDING |
| 78 | GET | `/api/admin/eft/submissions` | `payments.view` | requireAdmin | any-admin | PENDING |
| 85 | GET | `/api/admin/eft/submissions/:id` | `payments.view` | requireAdmin | any-admin | PENDING |
| 94 | GET | `/api/admin/eft/submissions/:id/proof` | `payments.view` | requireAdmin | any-admin | PENDING |
| 115 | POST | `/api/admin/eft/submissions/:id/approve` | `payments.manage` | requireAdmin | any-admin | PENDING |
| 118 | POST | `/api/admin/eft/submissions/:id/reject` | `payments.manage` | requireAdmin | any-admin | PENDING |
| 121 | POST | `/api/admin/eft/submissions/:id/request-replacement` | `payments.manage` | requireAdmin | any-admin | PENDING |
| 126 | GET | `/api/admin/bookings/:id/eft-submissions` | `payments.view` | requireAdmin | any-admin | PENDING |

### payfast-reconcile.js

| L# | Method | Path | Proposed Permission | Current Guard | Scope | Status |
|----|--------|------|---------------------|---------------|-------|--------|
| 12 | GET | `/api/admin/payfast/reconcile` | `payments.view` | requireAdmin | any-admin | PENDING |
| 20 | POST | `/api/admin/payfast/reconcile/run` | `payments.manage` | requireAdmin | any-admin | PENDING |
| 33 | POST | `/api/admin/payfast/reconcile/findings/:id/resolve` | `payments.manage` | requireAdmin | any-admin | PENDING |

---

## Group: Inquiries (inquiries.js)

| L# | Method | Path | Proposed Permission | Current Guard | Scope | Status |
|----|--------|------|---------------------|---------------|-------|--------|
| 20 | GET | `/api/admin/inquiries` | `inquiries.view` | requireAdmin | any-admin | PENDING |
| 100 | PUT | `/api/admin/inquiries/:id/status` | `inquiries.manage` | requireRole(['administrator','manager']) | manager+ | PENDING |
| 115 | GET | `/api/admin/inquiries/assignable-admins` | `inquiries.assign` | requireAdmin | any-admin | PENDING |
| 122 | PUT | `/api/admin/inquiries/:id/assign` | `inquiries.assign` | requireRole(['administrator','manager']) | manager+ | PENDING |
| 144 | PUT | `/api/admin/inquiries/:id/priority` | `inquiries.manage` | requireRole(['administrator','manager']) | manager+ | PENDING |
| 158 | GET | `/api/admin/inquiries/categories` | `inquiries.view` | requireAdmin | any-admin | PENDING |
| 165 | PUT | `/api/admin/inquiries/:id/category` | `inquiries.manage` | requireAdmin | any-admin | PENDING |
| 174 | GET | `/api/admin/inquiries/:id/notes` | `inquiries.view` | requireAdmin | any-admin | PENDING |
| 184 | POST | `/api/admin/inquiries/:id/notes` | `inquiries.create` | requireAdmin | any-admin | PENDING |
| 202 | DELETE | `/api/admin/inquiries/:id/notes/:noteId` | `inquiries.delete` | requireAdmin | any-admin | PENDING |
| 227 | GET | `/api/admin/inquiries/:id/messages` | `inquiries.view` | requireAdmin | any-admin | PENDING |
| 249 | POST | `/api/admin/inquiries/:id/messages/:mid/retry` | `inquiries.manage` | requireRole(['administrator','manager']) | manager+ | PENDING |
| 268 | PUT | `/api/admin/inquiries/bulk-status` | `inquiries.manage` | requireRole(['administrator','manager']) | manager+ | PENDING |
| 290 | POST | `/api/admin/inquiries/bulk-delete` | `inquiries.delete` | requireRole(['administrator']) | admin-only | PENDING |
| 306 | DELETE | `/api/admin/inquiries/:id` | `inquiries.delete` | requireRole(['administrator']) | admin-only | PENDING |

---

## Group: Newsletter (newsletter-campaigns.js, newsletter-subscribers.js, campaigns.js)

### newsletter-campaigns.js

| L# | Method | Path | Proposed Permission | Current Guard | Scope | Status |
|----|--------|------|---------------------|---------------|-------|--------|
| 31 | POST | `/api/admin/newsletter/drafts` | `newsletter.create` | requireRole(['administrator','manager']) | manager+ | PENDING |
| 42 | PUT | `/api/admin/newsletter/drafts/:id` | `newsletter.edit` | requireRole(['administrator','manager']) | manager+ | PENDING |
| 54 | GET | `/api/admin/newsletter/drafts` | `newsletter.view` | requireAdmin | any-admin | PENDING |
| 64 | GET | `/api/admin/newsletter/drafts/:id` | `newsletter.view` | requireAdmin | any-admin | PENDING |
| 75 | DELETE | `/api/admin/newsletter/drafts/:id` | `newsletter.delete` | requireRole(['administrator','manager']) | manager+ | PENDING |
| 89 | POST | `/api/admin/newsletter/preview` | `newsletter.view` | requireAdmin | any-admin | PENDING |
| 123 | POST | `/api/admin/newsletter/schedule` | `newsletter.manage` | requireRole(['administrator','manager']) | manager+ | PENDING |
| 147 | GET | `/api/admin/newsletter/schedule` | `newsletter.view` | requireAdmin | any-admin | PENDING |
| 157 | DELETE | `/api/admin/newsletter/schedule/:id` | `newsletter.delete` | requireRole(['administrator','manager']) | manager+ | PENDING |
| 179 | PUT | `/api/admin/newsletter/schedule/:id` | `newsletter.edit` | requireRole(['administrator','manager']) | manager+ | PENDING |
| 234 | GET | `/api/admin/newsletter/campaigns/audience-count` | `newsletter.view` | requireAdmin | any-admin | PENDING |
| 242 | GET | `/api/admin/newsletter/birthday-settings` | `newsletter.view` | requireAdmin | any-admin | PENDING |
| 253 | PUT | `/api/admin/newsletter/birthday-settings` | `newsletter.edit` | requireRole(['administrator','manager']) | manager+ | PENDING |
| 288 | POST | `/api/admin/newsletter/birthday-settings/preview` | `newsletter.view` | requireAdmin | any-admin | PENDING |
| 305 | POST | `/api/admin/newsletter/birthday-settings/send-test` | `newsletter.manage` | requireRole(['administrator','manager']) | manager+ | PENDING |

### newsletter-subscribers.js

| L# | Method | Path | Proposed Permission | Current Guard | Scope | Status |
|----|--------|------|---------------------|---------------|-------|--------|
| 23 | GET | `/api/admin/newsletter/subscribers` | `newsletter.view` | requireAdmin | any-admin | PENDING |
| 62 | GET | `/api/admin/newsletter/subscribers/stats` | `newsletter.view` | requireAdmin | any-admin | PENDING |
| 75 | POST | `/api/admin/newsletter/subscribers` | `newsletter.create` | requireRole(['administrator','manager']) | manager+ | PENDING |
| 102 | PUT | `/api/admin/newsletter/subscribers/:id` | `newsletter.edit` | requireRole(['administrator','manager']) | manager+ | PENDING |
| 154 | PUT | `/api/admin/newsletter/subscribers/:id/status` | `newsletter.manage` | requireRole(['administrator','manager']) | manager+ | PENDING |
| 182 | DELETE | `/api/admin/newsletter/subscribers/:id` | `newsletter.delete` | requireRole(['administrator']) | admin-only | PENDING |
| 193 | PUT | `/api/admin/newsletter/subscribers/bulk-status` | `newsletter.manage` | requireRole(['administrator','manager']) | manager+ | PENDING |
| 231 | POST | `/api/admin/newsletter/subscribers/bulk-delete` | `newsletter.delete` | requireRole(['administrator']) | admin-only | PENDING |
| 247 | POST | `/api/admin/newsletter/subscribers/import` | `newsletter.manage` | requireRole(['administrator','manager']) | manager+ | PENDING |

### campaigns.js (unified email campaigns)

| L# | Method | Path | Proposed Permission | Current Guard | Scope | Status |
|----|--------|------|---------------------|---------------|-------|--------|
| 30 | POST | `/api/admin/campaigns` | `newsletter.create` | requireRole(['administrator','manager']) | manager+ | PENDING |
| 127 | POST | `/api/admin/campaigns/send-test` | `newsletter.manage` | requireRole(['administrator','manager']) | manager+ | PENDING |
| 169 | DELETE | `/api/admin/campaigns/:id` | `newsletter.delete` | requireRole(['administrator']) | admin-only | PENDING |
| 177 | GET | `/api/admin/campaigns/unified` | `newsletter.view` | requireAdmin | any-admin | PENDING |
| 220 | POST | `/api/admin/campaigns/bulk-delete` | `newsletter.delete` | requireRole(['administrator']) | admin-only | PENDING |

---

## Group: Notifications (notifications.js, reminders.js)

### notifications.js

| L# | Method | Path | Proposed Permission | Current Guard | Scope | Status |
|----|--------|------|---------------------|---------------|-------|--------|
| 19 | GET | `/api/admin/notifications` | `notifications.view` | requireAdmin | any-admin | PENDING |
| 23 | GET | `/api/admin/notifications/summary` | `notifications.view` | requireAdmin | any-admin | PENDING |
| 27 | GET | `/api/admin/notifications/meta` | `notifications.view` | requireAdmin | any-admin | PENDING |
| 35 | POST | `/api/admin/notifications/read` | `notifications.manage` | requireAdmin | any-admin | PENDING |
| 41 | POST | `/api/admin/notifications/read-all` | `notifications.manage` | requireAdmin | any-admin | PENDING |
| 48 | GET | `/api/admin/notifications/:id` | `notifications.view` | requireAdmin | any-admin | PENDING |
| 55 | POST | `/api/admin/notifications/:id/:action` | `notifications.manage` | requireAdmin | any-admin | PENDING |
| 63 | GET | `/api/admin/activity` | `notifications.view` | requireAdmin | any-admin | PENDING |
| 68 | GET | `/api/admin/notification-prefs` | `notifications.view` | requireAdmin | any-admin | PENDING |
| 71 | PUT | `/api/admin/notification-prefs` | `notifications.manage` | requireAdmin | any-admin | PENDING |
| 78 | GET | `/api/admin/notification-rules` | `notifications.view` | requireAdmin | any-admin | PENDING |
| 81 | PUT | `/api/admin/notification-rules/:event` | `notifications.manage` | requireAdmin | any-admin | PENDING |
| 86 | GET | `/api/admin/notification-settings` | `notifications.view` | requireAdmin | any-admin | PENDING |
| 89 | PUT | `/api/admin/notification-settings` | `notifications.manage` | requireAdmin | any-admin | PENDING |
| 101 | GET | `/api/admin/compliance-items` | `legal.view` | requireAdmin | any-admin | PENDING |
| 104 | POST | `/api/admin/compliance-items` | `legal.create` | requireAdmin | any-admin | PENDING |
| 114 | PUT | `/api/admin/compliance-items/:id` | `legal.edit` | requireAdmin | any-admin | PENDING |
| 126 | DELETE | `/api/admin/compliance-items/:id` | `legal.delete` | requireAdmin | any-admin | PENDING |
| 137 | GET | `/api/admin/system-health` | `security.view` | requireAdmin | any-admin | PENDING |
| 144 | POST | `/api/admin/client-errors` | `notifications.manage` | requireAdmin | any-admin | PENDING |

### reminders.js

| L# | Method | Path | Proposed Permission | Current Guard | Scope | Status |
|----|--------|------|---------------------|---------------|-------|--------|
| 11 | GET | `/api/admin/reminders` | `notifications.view` | requireAdmin | any-admin | PENDING |
| 28 | POST | `/api/admin/reminders/run` | `notifications.manage` | requireAdmin | any-admin | PENDING |

---

## Group: Site Content (content.js, home-social.js, accolades.js, banners.js, faq.js, team.js, site-content.js)

### content.js

| L# | Method | Path | Proposed Permission | Current Guard | Scope | Status |
|----|--------|------|---------------------|---------------|-------|--------|
| 22 | GET | `/api/admin/highlights` | `site-content.view` | requireAdmin | any-admin | PENDING |
| 30 | POST | `/api/admin/highlights` | `site-content.create` | requireAdmin | any-admin | PENDING |
| 45 | PUT | `/api/admin/highlights/:id` | `site-content.edit` | requireAdmin | any-admin | PENDING |
| 71 | DELETE | `/api/admin/highlights/:id` | `site-content.delete` | requireRole(['administrator']) | admin-only | PENDING |
| 81 | GET | `/api/admin/footprint` | `site-content.view` | requireAdmin | any-admin | PENDING |
| 88 | POST | `/api/admin/footprint` | `site-content.create` | requireAdmin | any-admin | PENDING |
| 103 | PUT | `/api/admin/footprint/:id` | `site-content.edit` | requireAdmin | any-admin | PENDING |
| 124 | DELETE | `/api/admin/footprint/:id` | `site-content.delete` | requireRole(['administrator']) | admin-only | PENDING |
| 135 | GET | `/api/admin/testimonials` | `site-content.view` | requireAdmin | any-admin | PENDING |
| 146 | POST | `/api/admin/testimonials` | `site-content.create` | requireAdmin | any-admin | PENDING |
| 162 | PUT | `/api/admin/testimonials/:id` | `site-content.edit` | requireAdmin | any-admin | PENDING |
| 186 | DELETE | `/api/admin/testimonials/:id` | `site-content.delete` | requireRole(['administrator']) | admin-only | PENDING |
| 196 | PUT | `/api/admin/gallery/reorder` | `site-content.edit` | requireAdmin | any-admin | PENDING |
| 211 | POST | `/api/admin/gallery` | `site-content.create` | requireAdmin | any-admin | PENDING |
| 226 | PUT | `/api/admin/gallery/:id` | `site-content.edit` | requireAdmin | any-admin | PENDING |
| 248 | DELETE | `/api/admin/gallery/:id` | `site-content.delete` | requireRole(['administrator']) | admin-only | PENDING |

### home-social.js

| L# | Method | Path | Proposed Permission | Current Guard | Scope | Status |
|----|--------|------|---------------------|---------------|-------|--------|
| 12 | GET | `/api/admin/home-slider` | `site-content.view` | requireAdmin | any-admin | PENDING |
| 19 | POST | `/api/admin/home-slider` | `site-content.create` | requireAdmin | any-admin | PENDING |
| 32 | DELETE | `/api/admin/home-slider/:id` | `site-content.delete` | requireRole(['administrator']) | admin-only | PENDING |
| 42 | PUT | `/api/admin/home-slider/reorder` | `site-content.edit` | requireAdmin | any-admin | PENDING |
| 61 | PUT | `/api/admin/home-slider/:id` | `site-content.edit` | requireAdmin | any-admin | PENDING |
| 81 | GET | `/api/admin/social_links` | `social.view` | requireAdmin | any-admin | PENDING |
| 88 | POST | `/api/admin/social_links` | `social.create` | requireAdmin | any-admin | PENDING |
| 115 | DELETE | `/api/admin/social_links/:id` | `social.delete` | requireRole(['administrator']) | admin-only | PENDING |
| 122 | GET | `/api/admin/social_embeds` | `social.view` | requireAdmin | any-admin | PENDING |
| 139 | POST | `/api/admin/social_embeds` | `social.create` | requireAdmin | any-admin | PENDING |
| 170 | DELETE | `/api/admin/social_embeds/:id` | `social.delete` | requireRole(['administrator']) | admin-only | PENDING |
| 177 | POST | `/api/admin/publish-home-slider` | `site-content.manage` | requireAdmin | any-admin | PENDING |

### accolades.js

| L# | Method | Path | Proposed Permission | Current Guard | Scope | Status |
|----|--------|------|---------------------|---------------|-------|--------|
| 66 | GET | `/api/admin/accolades` | `site-content.view` | requireAdmin | any-admin | PENDING |
| 76 | POST | `/api/admin/accolades` | `site-content.create` | requireAdmin | any-admin | PENDING |
| 111 | PUT | `/api/admin/accolades/reorder` | `site-content.edit` | requireAdmin | any-admin | PENDING |
| 151 | POST | `/api/admin/accolades/bulk` | `site-content.manage` | requireRole(['administrator']) | admin-only | PENDING |
| 209 | PUT | `/api/admin/accolades/:id` | `site-content.edit` | requireAdmin | any-admin | PENDING |
| 247 | DELETE | `/api/admin/accolades/:id` | `site-content.delete` | requireRole(['administrator']) | admin-only | PENDING |

### banners.js (email banners)

| L# | Method | Path | Proposed Permission | Current Guard | Scope | Status |
|----|--------|------|---------------------|---------------|-------|--------|
| 60 | GET | `/api/admin/banners` | `email-banners.view` | requireRole(['administrator','manager']) | manager+ | PENDING |
| 107 | GET | `/api/admin/banners/:id` | `email-banners.view` | requireRole(['administrator','manager']) | manager+ | PENDING |
| 120 | POST | `/api/admin/banners` | `email-banners.create` | requireRole(['administrator','manager']) | manager+ | PENDING |
| 151 | PUT | `/api/admin/banners/:id` | `email-banners.edit` | requireRole(['administrator','manager']) | manager+ | PENDING |
| 209 | PATCH | `/api/admin/banners/:id/archive` | `email-banners.edit` | requireRole(['administrator','manager']) | manager+ | PENDING |
| 211 | PATCH | `/api/admin/banners/:id/restore` | `email-banners.edit` | requireRole(['administrator','manager']) | manager+ | PENDING |

### faq.js

| L# | Method | Path | Proposed Permission | Current Guard | Scope | Status |
|----|--------|------|---------------------|---------------|-------|--------|
| 24 | GET | `/api/admin/faqs` | `site-content.view` | requireAdmin | any-admin | PENDING |
| 29 | POST | `/api/admin/faqs` | `site-content.create` | requireAdmin | any-admin | PENDING |
| 45 | PUT | `/api/admin/faqs/:id` | `site-content.edit` | requireAdmin | any-admin | PENDING |
| 66 | POST | `/api/admin/faqs/:id/move` | `site-content.edit` | requireAdmin | any-admin | PENDING |
| 92 | DELETE | `/api/admin/faqs/:id` | `site-content.delete` | requireRole(['administrator']) | admin-only | PENDING |

### team.js

| L# | Method | Path | Proposed Permission | Current Guard | Scope | Status |
|----|--------|------|---------------------|---------------|-------|--------|
| 17 | GET | `/api/admin/team` | `site-content.view` | requireAdmin | any-admin | PENDING |
| 26 | PUT | `/api/admin/team/reorder` | `site-content.edit` | requireAdmin | any-admin | PENDING |
| 40 | POST | `/api/admin/team` | `site-content.create` | requireAdmin | any-admin | PENDING |
| 67 | PUT | `/api/admin/team/:id` | `site-content.edit` | requireAdmin | any-admin | PENDING |
| 115 | DELETE | `/api/admin/team/:id` | `site-content.delete` | requireRole(['administrator']) | admin-only | PENDING |

### site-content.js

| L# | Method | Path | Proposed Permission | Current Guard | Scope | Status |
|----|--------|------|---------------------|---------------|-------|--------|
| 14 | POST | `/api/admin/migrate` | `settings.manage` | requireAdmin | any-admin | PENDING |
| 53 | PUT | `/api/admin/branding` | `branding.edit` | requireRole(['administrator']) | admin-only | PENDING |
| 74 | GET | `/api/admin/venues` | `bookings.view` | requireAdmin | any-admin | PENDING |
| 85 | GET | `/api/admin/reviews` | `site-content.view` | requireAdmin | any-admin | PENDING |
| 96 | PUT | `/api/admin/manager` | `site-content.edit` | requireAdmin | any-admin | PENDING |
| 135 | DELETE | `/api/admin/manager` | `site-content.delete` | requireRole(['administrator']) | admin-only | PENDING |
| 142 | POST | `/api/admin/contact_info` | `contact.edit` | requireAdmin | any-admin | PENDING |
| 181 | GET | `/api/admin/about-me` | `site-content.view` | requireAdmin | any-admin | PENDING |
| 193 | POST | `/api/admin/about-me` | `site-content.edit` | requireAdmin | any-admin | PENDING |
| 228 | PUT | `/api/admin/site-content` | `site-content.manage` | requireAdmin | any-admin | PENDING |

---

## Group: Services (services.js)

| L# | Method | Path | Proposed Permission | Current Guard | Scope | Status |
|----|--------|------|---------------------|---------------|-------|--------|
| 40 | GET | `/api/admin/services` | `services.view` | requireAdmin | any-admin | PENDING |
| 60 | GET | `/api/admin/services/meta` | `services.view` | requireAdmin | any-admin | PENDING |
| 82 | PUT | `/api/admin/services/rate-card` | `services.manage` | requireRole(['administrator','manager']) | manager+ | PENDING |
| 100 | POST | `/api/admin/services` | `services.create` | requireAdmin | any-admin | PENDING |
| 173 | PUT | `/api/admin/services/:id` | `services.edit` | requireAdmin | any-admin | PENDING |
| 261 | GET | `/api/admin/services/:id/usage` | `services.view` | requireAdmin | any-admin | PENDING |
| 269 | DELETE | `/api/admin/services/:id` | `services.delete` | requireAdmin | any-admin | PENDING |

---

## Group: Dashboard & Analytics (dashboard.js, analytics.js, insights.js)

### dashboard.js

| L# | Method | Path | Proposed Permission | Current Guard | Scope | Status |
|----|--------|------|---------------------|---------------|-------|--------|
| 12 | GET | `/api/admin/dashboard/social_kpis` | `dashboard.view` | requireAdmin | any-admin | PENDING |
| 140 | POST | `/api/admin/dashboard/social_kpis` | `social.manage` | requireRole(['administrator','manager']) | manager+ | PENDING |
| 180 | GET | `/api/admin/dashboard/preferences` | `dashboard.view` | requireAdmin | any-admin | PENDING |
| 189 | PUT | `/api/admin/dashboard/preferences` | `dashboard.view` | requireAdmin | any-admin | PENDING |
| 203 | GET | `/api/admin/preferences/appearance` | `settings.view` | requireAdmin | any-admin | PENDING |
| 213 | PUT | `/api/admin/preferences/appearance` | `settings.edit` | requireAdmin | any-admin | PENDING |

### analytics.js

| L# | Method | Path | Proposed Permission | Current Guard | Scope | Status |
|----|--------|------|---------------------|---------------|-------|--------|
| 29 | GET | `/api/admin/analytics/summary` | `dashboard.view` | requireAdmin | any-admin | PENDING |
| 66 | GET | `/api/admin/analytics/visits-over-time` | `dashboard.view` | requireAdmin | any-admin | PENDING |
| 90 | GET | `/api/admin/analytics/traffic-sources` | `dashboard.view` | requireAdmin | any-admin | PENDING |
| 108 | GET | `/api/admin/analytics/top-referrers` | `dashboard.view` | requireAdmin | any-admin | PENDING |
| 127 | GET | `/api/admin/analytics/devices` | `dashboard.view` | requireAdmin | any-admin | PENDING |
| 145 | GET | `/api/admin/analytics/countries` | `dashboard.view` | requireAdmin | any-admin | PENDING |
| 171 | GET | `/api/admin/analytics/top-pages` | `dashboard.view` | requireAdmin | any-admin | PENDING |
| 194 | GET | `/api/admin/analytics/bookings-trend` | `dashboard.view` | requireAdmin | any-admin | PENDING |
| 207 | GET | `/api/admin/analytics/todays-schedule` | `dashboard.view` | requireAdmin | any-admin | PENDING |
| 278 | GET | `/api/admin/analytics/sections` | `dashboard.view` | requireAdmin | any-admin | PENDING |
| 305 | GET | `/api/admin/analytics/interactions` | `dashboard.view` | requireAdmin | any-admin | PENDING |
| 338 | GET | `/api/admin/analytics/visitor-mix` | `dashboard.view` | requireAdmin | any-admin | PENDING |
| 366 | GET | `/api/admin/analytics/consent` | `dashboard.view` | requireAdmin | any-admin | PENDING |
| 388 | GET | `/api/admin/analytics/cities` | `dashboard.view` | requireAdmin | any-admin | PENDING |

### insights.js

| L# | Method | Path | Proposed Permission | Current Guard | Scope | Status |
|----|--------|------|---------------------|---------------|-------|--------|
| 34 | GET | `/api/admin/insights/overview` | `dashboard.view` | requireAdmin | any-admin | PENDING |
| 49 | GET | `/api/admin/insights/finance` | `finance.view` | requirePermission('finance.view') | — | DONE |
| 63 | GET | `/api/admin/insights/cloudflare` | `dashboard.view` | requireAdmin | any-admin | PENDING |

---

## Group: Direct Email (direct-emails.js)

> **Note:** `direct-email` module in registry lacks `edit` and `delete` actions. Add both to `lib/rbac-registry.js` before converting DELETE and PUT routes.

| L# | Method | Path | Proposed Permission | Current Guard | Scope | Status |
|----|--------|------|---------------------|---------------|-------|--------|
| 42 | POST | `/api/admin/direct-emails/upload` | `direct-email.create` | requireAdmin | any-admin | PENDING |
| 54 | GET | `/api/admin/direct-emails` | `direct-email.view` | requireAdmin | any-admin | PENDING |
| 91 | GET | `/api/admin/direct-emails/:id` | `direct-email.view` | requireAdmin | any-admin | PENDING |
| 100 | POST | `/api/admin/direct-emails` | `direct-email.create` | requireAdmin | any-admin | PENDING |
| 146 | PUT | `/api/admin/direct-emails/:id` | `direct-email.create` *(draft edit — no edit action)* | requireAdmin | any-admin | PENDING |
| 198 | DELETE | `/api/admin/direct-emails/:id` | `direct-email.delete` *`*NEW*`* | requireAdmin | any-admin | PENDING |
| 227 | POST | `/api/admin/direct-emails/:id/send` | `direct-email.create` | requireAdmin | any-admin | PENDING |
| 252 | POST | `/api/admin/direct-emails/preview` | `direct-email.view` | requireAdmin | any-admin | PENDING |

---

## Group: Email Templates & Email Logs (email-templates.js, misc.js email-logs)

### email-templates.js

| L# | Method | Path | Proposed Permission | Current Guard | Scope | Status |
|----|--------|------|---------------------|---------------|-------|--------|
| 16 | GET | `/api/admin/email-templates` | `settings.view` | requireRole(['administrator','manager']) | manager+ | PENDING |
| 29 | PUT | `/api/admin/email-templates/assign` | `settings.edit` | requireRole(['administrator','manager']) | manager+ | PENDING |
| 63 | GET | `/api/admin/email-templates/:key/preview` | `settings.view` | requireRole(['administrator','manager']) | manager+ | PENDING |

---

## Group: Settings & Integrations (settings.js, google-calendar.js, inbox-sync.js, calendar-sync.js, places.js)

### settings.js

| L# | Method | Path | Proposed Permission | Current Guard | Scope | Status |
|----|--------|------|---------------------|---------------|-------|--------|
| 22 | GET | `/api/admin/working-hours` | `settings.view` | requireAdmin | any-admin | PENDING |
| 41 | PUT | `/api/admin/working-hours` | `settings.edit` | requireAdmin | any-admin | PENDING |
| 84 | GET | `/api/admin/audit_log` | `security.view` | requireAdmin | any-admin | PENDING |
| 156 | GET | `/api/admin/financial_audit_log` | `finance.view` | requirePermission('finance.view') | — | DONE |
| 179 | GET | `/api/admin/policies` | `legal.view` | requireAdmin | any-admin | PENDING |
| 199 | PUT | `/api/admin/policies` | `legal.manage` | requireAdmin | any-admin | PENDING |
| 252 | GET | `/api/admin/settings` | `settings.view` | requireAdmin | any-admin | PENDING |
| 270 | PUT | `/api/admin/settings` | `settings.manage` | requireAdmin | any-admin | PENDING |
| 391 | POST | `/api/admin/settings/smtp/test-connection` | `settings.manage` | requirePermission('settings.manage') | — | DONE |
| 413 | POST | `/api/admin/settings/m365/test-mailbox-read` | `settings.manage` | requirePermission('settings.manage') | — | DONE |

### google-calendar.js

| L# | Method | Path | Proposed Permission | Current Guard | Scope | Status |
|----|--------|------|---------------------|---------------|-------|--------|
| 45 | GET | `/api/admin/google-calendar` | `integrations.view` | requireAdmin | any-admin | PENDING |
| 60 | POST | `/api/admin/google-calendar/sync` | `integrations.manage` | requireAdmin | any-admin | PENDING |
| 75 | PUT | `/api/admin/google-calendar/credentials` | `integrations.manage` | requireAdmin | any-admin | PENDING |
| 95 | POST | `/api/admin/google-calendar/connect` | `integrations.manage` | requireAdmin | any-admin | PENDING |
| 120 | GET | `/api/admin/google-calendar/callback` | EXEMPT *(OAuth callback — no RBAC)* | none | any | EXEMPT |
| 135 | POST | `/api/admin/google-calendar/test` | `integrations.manage` | requireAdmin | any-admin | PENDING |
| 140 | DELETE | `/api/admin/google-calendar` | `integrations.manage` | requireAdmin | any-admin | PENDING |

### inbox-sync.js

| L# | Method | Path | Proposed Permission | Current Guard | Scope | Status |
|----|--------|------|---------------------|---------------|-------|--------|
| 12 | GET | `/api/admin/inbox-sync` | `integrations.view` | requireAdmin | any-admin | PENDING |
| 19 | PUT | `/api/admin/inbox-sync` | `integrations.manage` | requireAdmin | any-admin | PENDING |
| 42 | POST | `/api/admin/inbox-sync/run` | `integrations.manage` | requireAdmin | any-admin | PENDING |

### places.js

| L# | Method | Path | Proposed Permission | Current Guard | Scope | Status |
|----|--------|------|---------------------|---------------|-------|--------|
| 14 | GET | `/api/admin/places/autocomplete` | `bookings.view` | requireAdmin | any-admin | PENDING |
| 25 | GET | `/api/admin/places/details` | `bookings.view` | requireAdmin | any-admin | PENDING |
| 37 | GET | `/api/admin/places/status` | `integrations.view` | requireRole(['administrator']) | admin-only | PENDING |

---

## Group: Business Profile (business-profile.js)

| L# | Method | Path | Proposed Permission | Current Guard | Scope | Status |
|----|--------|------|---------------------|---------------|-------|--------|
| 21 | GET | `/api/admin/business-profile` | `business-profile.view` | requireAdmin | any-admin | PENDING |
| 31 | PUT | `/api/admin/business-profile` | `business-profile.edit` | requireAdmin | any-admin | PENDING |
| 42 | POST | `/api/admin/business-profile/reveal-director-id` | `business-profile.manage` | requireAdmin | any-admin | PENDING |
| 55 | POST | `/api/admin/business-profile/preview` | `business-profile.view` | requireAdmin | any-admin | PENDING |

---

## Group: Legal & POPIA (legal.js, popia.js)

> **Note:** `legal` module lacks `export` action. Use `legal.manage` for the POPIA export route, or add `legal.export` to the registry.

### legal.js

| L# | Method | Path | Proposed Permission | Current Guard | Scope | Status |
|----|--------|------|---------------------|---------------|-------|--------|
| 20 | GET | `/api/admin/legal/overview` | `legal.view` | requireAdmin | any-admin | PENDING |
| 47 | GET | `/api/admin/legal/documents` | `legal.view` | requireAdmin | any-admin | PENDING |
| 58 | GET | `/api/admin/legal/documents/:type/history` | `legal.view` | requireAdmin | any-admin | PENDING |
| 70 | POST | `/api/admin/legal/documents/:type/draft` | `legal.create` | requireRole(['administrator']) | admin-only | PENDING |
| 93 | POST | `/api/admin/legal/documents/:type/publish` | `legal.manage` | requireRole(['administrator']) | admin-only | PENDING |
| 127 | POST | `/api/admin/legal/documents/:type/restore/:versionId` | `legal.manage` | requireRole(['administrator']) | admin-only | PENDING |
| 149 | GET | `/api/admin/legal/documents/:type` | `legal.view` | requireAdmin | any-admin | PENDING |
| 166 | GET | `/api/admin/legal/consent-audit` | `legal.view` | requireAdmin | any-admin | PENDING |
| 192 | GET | `/api/admin/legal/contracts` | `legal.view` | requireAdmin | any-admin | PENDING |

### popia.js

| L# | Method | Path | Proposed Permission | Current Guard | Scope | Status |
|----|--------|------|---------------------|---------------|-------|--------|
| 24 | GET | `/api/admin/popia/requests` | `legal.view` | requireAdmin | any-admin | PENDING |
| 53 | GET | `/api/admin/popia/requests/export` | `legal.manage` *(add `legal.export` to registry if preferred)* | requireRole(['administrator','manager']) | manager+ | PENDING |
| 82 | GET | `/api/admin/popia/requests/:id` | `legal.view` | requireAdmin | any-admin | PENDING |
| 150 | PUT | `/api/admin/popia/requests/:id/approve` | `legal.manage` | requireRole(['administrator']) | admin-only | PENDING |
| 156 | PUT | `/api/admin/popia/requests/:id/reject` | `legal.manage` | requireRole(['administrator']) | admin-only | PENDING |
| 164 | POST | `/api/admin/popia/requests/:id/process` | `legal.manage` | requireRole(['administrator']) | admin-only | PENDING |
| 183 | POST | `/api/admin/popia/requests/:id/complete-anonymization` | `legal.manage` | requireRole(['administrator']) | admin-only | PENDING |
| 192 | POST | `/api/admin/popia/requests` | `legal.create` | requireRole(['administrator']) | admin-only | PENDING |
| 239 | POST | `/api/admin/gdpr/delete` | `legal.manage` | requireRole(['administrator']) | admin-only | PENDING |

---

## Group: Users & Roles (users.js, roles.js)

### users.js

| L# | Method | Path | Proposed Permission | Current Guard | Scope | Status |
|----|--------|------|---------------------|---------------|-------|--------|
| 28 | GET | `/api/admin/users` | `users.view` | requireRole(['administrator']) | admin-only | PENDING |
| 36 | GET | `/api/admin/user-login-logs` | `security.view` | requireRole(['administrator']) | admin-only | PENDING |
| 46 | POST | `/api/admin/users` | `users.create` | requireRole(['administrator']) | admin-only | PENDING |
| 108 | POST | `/api/admin/users/:id/resend-invite` | `users.manage` | requireRole(['administrator']) | admin-only | PENDING |
| 131 | PUT | `/api/admin/users/:id` | `users.edit` | requireRole(['administrator']) | admin-only | PENDING |
| 250 | DELETE | `/api/admin/users/:id` | `users.delete` | requireRole(['administrator']) | admin-only | PENDING |
| 284 | GET | `/api/admin/users/:id/permissions` | `users.manage` | requirePermission('users.manage') | — | DONE |

> **Missing from extract:** `PUT /api/admin/users/:id/permissions` (user permission overrides). Check users.js for the 8th route.

### roles.js

| L# | Method | Path | Proposed Permission | Current Guard | Scope | Status |
|----|--------|------|---------------------|---------------|-------|--------|
| 18 | GET | `/api/admin/roles` | `roles.view` | requireAdmin | any-admin | PENDING |
| 34 | GET | `/api/admin/roles/:id` | `roles.view` | requireAdmin | any-admin | PENDING |
| 54 | POST | `/api/admin/roles` | `roles.create` | requireAdmin | any-admin | PENDING |
| 93 | PUT | `/api/admin/roles/:id` | `roles.edit` | requireAdmin | any-admin | PENDING |
| 134 | DELETE | `/api/admin/roles/:id` | `roles.delete` | requireAdmin | any-admin | PENDING |
| 156 | GET | `/api/admin/permissions` | `roles.view` | requireAdmin | any-admin | PENDING |
| 186 | PUT | `/api/admin/roles/:id/permissions` | `roles.manage` | requireAdmin | any-admin | PENDING |

---

## Group: Misc (misc.js)

| L# | Method | Path | Proposed Permission | Current Guard | Scope | Status |
|----|--------|------|---------------------|---------------|-------|--------|
| 18 | GET | `/api/admin/email-logs` | `email-logs.view` | requireAdmin | any-admin | PENDING |
| 76 | POST | `/api/admin/settings/test-notification` | `settings.manage` | requireRole(['administrator']) | admin-only | PENDING |
| 107 | GET | `/api/admin/clients/duplicates` | `users.view` | requireAdmin | any-admin | PENDING |
| 144 | GET | `/api/admin/booking-attachments/:filename` | `bookings.view` | requireAdmin | any-admin | PENDING |
| 152 | PATCH | `/api/admin/reviews/:id` | `site-content.edit` | requireAdmin | any-admin | PENDING |
| 163 | GET | `/api/admin/payment-schedules/mismatches` | `payments.view` | requireRole(['administrator','manager']) | manager+ | PENDING |
| 191 | POST | `/api/admin/compose` | `direct-email.create` | requireAdmin | any-admin | PENDING |
| 252 | POST | `/api/admin/system/migrate-legacy-data` | `settings.manage` | requireRole(['administrator']) | admin-only | PENDING |
| 264 | POST | `/api/admin/debug` | `security.manage` | requireAdmin | any-admin | PENDING |

---

## Registry Gap Notes

The following registry changes are needed before converting the routes that reference them:

| Gap | Action Required |
|-----|-----------------|
| `direct-email.delete` missing | Add `'delete'` to `direct-email` actions in `lib/rbac-registry.js` |
| `direct-email.edit` missing | Add `'edit'` to `direct-email` actions (optional — can reuse `create` for drafts) |
| `legal.export` missing | Add `'export'` to `legal` actions (optional — can use `legal.manage`) |
| `events.export` missing | Add `'export'` to `events` actions for CSV export routes |
| `dashboard.edit` missing | Add `'edit'` to `dashboard` actions (dashboard preferences PUT) |
| `users.js` 8th route | Verify `PUT /api/admin/users/:id/permissions` exists and is listed |

---

## Conversion Batches

### Batch 1 — Content/Catalog (lowest risk)
Files: `accolades.js`, `banners.js`, `content.js`, `faq.js`, `home-social.js`, `team.js`, `site-content.js`, `services.js`  
Routes to convert: ~50  
Pre-work: none

### Batch 2 — Operations
Files: `bookings.js`, `advancing.js`, `abandoned-bookings.js`, `calendar.js`, `events.js`, `ticketing.js`, `notifications.js`, `reminders.js`, `inquiries.js`, `newsletter-campaigns.js`, `newsletter-subscribers.js`, `campaigns.js`, `direct-emails.js`, `email-templates.js`, `dashboard.js`, `analytics.js`  
Routes to convert: ~200  
Pre-work: add `events.export`, `dashboard.edit` to registry if desired; add `direct-email.delete`

### Batch 3 — Finance / Payments (most critical)
Files: `eft.js`, `payfast-reconcile.js`, plus payment-touching routes in `bookings.js` already in Batch 2  
Routes to convert: ~14  
Pre-work: none (payment-setup module already registered)

### Batch 4 — Credentials / Admin / Integrations
Files: `users.js`, `roles.js`, `settings.js`, `google-calendar.js`, `calendar-sync.js`, `inbox-sync.js`, `business-profile.js`, `legal.js`, `popia.js`, `places.js`, `misc.js`, `insights.js`  
Routes to convert: ~60  
Pre-work: add `legal.export` to registry if preferred

---

*Inventory complete. Update `Status` column to `DONE` as each batch is converted.*
