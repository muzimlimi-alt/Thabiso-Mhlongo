# Phase 4 — Event Execution & Completion: Audit, Fixes & Findings

**Scope:** the run from `bookings.status = 'CONFIRMED'` through automatic/manual completion — the events-row auto-creation on the three CONFIRMED paths, the S6 auto-completion cron, the overdue-payment digest, and the refund endpoint.
**Date:** 2026-07-11
**Commit:** `a233bca` (plus `96cc01f` for the Phase 3 D1 balance-reminder fix)
**Method:** brief read against current code, then behavioural testing against a running server in PayFast sandbox mode; every assertion re-run against the pre-fix commit to confirm it discriminates.

---

## 1. The brief was two-thirds already resolved

| Brief item | Actual state |
|---|---|
| **Gap 2** — refund endpoint writes an invalid `refund_status = 'refunded'`, 500s every time | **Already fixed.** The route ([server.js:6191](server.js#L6191)) writes `'processed'`, which the `chk_cancellations_refund_status` trigger allows. `admin.html` has no `'refunded'` string check. Verified end to end: the refund succeeds, `refund_status='processed'`, and a `transaction_type='refund'` row is recorded. |
| Overdue-payment digest should include manual bookings | **Already true.** The cron ([server.js:1473](server.js#L1473)) selects `status='CONFIRMED' AND payment_status NOT IN ('PAID') AND date < today` with no source filter. |
| **Gap 1** — inconsistent `events` row creation across CONFIRMED paths | **Real, and worse than described — see §2.** |

The brief was written against an older revision. The refund `'refunded'`→`'processed'` change had already landed.

---

## 2. Gap 1 — the events auto-creation never worked, on any path

### The bug the brief named
Three paths reach `CONFIRMED`, and they created the linked `events` row inconsistently:
* `applyStatusChange()` (admin status change) — on the CONFIRMED transition.
* `processManualPayment()` — on any CONFIRMED (deposit or full).
* PayFast ITN — **only** on full `PAID`, so a PayFast *deposit* that confirmed the booking got no row.

### The bug underneath it
All three sites inserted the literal string `'system'` into `events.created_by` — which is an **`INTEGER` foreign key to `admins(id)`**. With `PRAGMA foreign_keys = ON`, every insert failed:

```
[Auto-Event] Insert failed for booking #100043: SQLITE_CONSTRAINT: FOREIGN KEY constraint failed
```

So **no `CONFIRMED` booking has ever received its `events` row via any of the three paths.** Confirmed against the live database: zero `events` rows exist with `created_by = 'system'`, and the two real system-created rows use `created_by = NULL`. The brief's premise — "admin transition confirmation creates the events row, confirmed working" — was itself untrue; it fails on the same FK.

### The fix
1. **`'system'` → `NULL`** at all three sites ([server.js:4785](server.js#L4785), [:5096](server.js#L5096), [:9488](server.js#L9488)). `NULL` is the system-created marker `admins(id)` allows and is what the existing rows already use. This alone is what makes the feature work for the first time.
2. **PayFast ITN gated on CONFIRMED, not PAID** — the events block moved out of the `if (newPaymentStatus === 'PAID')` branch and re-gated on `updatedRow.status === 'CONFIRMED'`, matching the other two paths. Owner decision (2026-07-11): make PayFast consistent with the manual path, which already creates the row on deposit-confirm.

### Verification
11/11 on the Phase 4 suite; 4/10 on the pre-fix commit, where every events assertion fails (the FK rejects the insert even on the manual and full-payment paths). Cases covered: PayFast deposit-confirm creates a linked `upcoming` events row; PayFast full payment creates exactly one (no duplicate); manual deposit-confirm creates one (parity); the refund endpoint succeeds with `refund_status='processed'`.

### Impact that was and wasn't real
The admin calendar (`GET /api/admin/calendar/events`) reads from **bookings** (`LEFT JOIN events`), so it was never blind to these bookings — a missing `events` row only cost the `★` linked-event badge. The events-table-driven views (`eventsAdmin`, public promotion) are what gained the bookings. No schema change; no data migration (nothing to migrate — no rows were ever created).

---

## 3. Confirmed working (regression checks)

* **S6 auto-completion** (`CONFIRMED + PAID + date < today` → `COMPLETED`, completion emails, linked invoice → `PAID`, `events.event_status='completed'`) — unchanged and consistent with the brief. The `events` sync is now meaningful because a row can finally exist.
* **Manual completion** outstanding-balance guard (`amount_outstanding > 0.01` blocks `COMPLETED`) — unchanged; the `0.01` tolerance left intact per the constraint.
* **Refund** — the dedicated endpoint records the refund transaction and recomputes `amount_paid` from `SUM(transactions)`; since Phase 3 (B7) it also re-derives `payment_status` and re-runs the milestone waterfall.

---

## 4. Note for a future pass

`events.created_by` being an integer FK to `admins(id)` with no room for a "system" sentinel is why this bug existed. `NULL` is a correct and sufficient fix, but if a future change wants to *distinguish* system-created events from admin-created-but-later-orphaned ones, that needs a dedicated column or a reserved admin row — not the string `'system'`. Recorded so the `NULL` isn't "tidied" back to a string later.
