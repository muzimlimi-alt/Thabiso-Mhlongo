# Atelier — Booking Triage (Soft-Decline)

**Feature:** Let a fresh enquiry be politely dispositioned as **Not a Fit** or **Archived** without cancelling it — so declining a bad-fit lead is distinct from cancelling a live deal, and conversion analytics stay clean.
**Scope:** Small full-stack — one `disposition` column (`database.js`) + one route and an analytics tweak (`server.js`) + list/detail actions and a filter (`admin.html`).
**Key property:** the recommended design is **orthogonal to the pipeline state machine** — it does **not** touch `ALLOWED_TRANSITIONS`.
**Grounding:** All citations verified by direct audit.

---

## 0. PROMPT RULES
Standard Atelier rules: `--atl-*` tokens only; `catch` → `notificationService.showError()` + `console.error()`; `apiCall()` (`admin.html:10310`); new route `requireAdmin` (`server.js:1229`); idempotent migration; **do not modify `ALLOWED_TRANSITIONS` (`server.js:6289`)** or any RBAC.

---

## 1. FULL-STACK IMPACT ANALYSIS

| Layer | Impact | Detail |
|---|---|---|
| **Database** | **One column** | `bookings.disposition TEXT DEFAULT 'active'` (idempotent ALTER). No CHECK (matches the existing convention — `status` has none either). |
| **Backend / API** | **One route + one query tweak** | `PUT /api/admin/bookings/:id/disposition` (set active/not_a_fit/archived, write `audit_log`). Update the pipeline count query to scope to `disposition='active'` (or add a disposition breakdown). |
| **Frontend** | **Actions + filter** | "Not a Fit" / "Archive" / "Restore" actions in the booking detail; a list filter that hides non-active by default. |
| **Security / RBAC** | **Untouched** | `requireAdmin` reused. |

---

## 2. CONFIRMED CURRENT-STATE FINDINGS (audit, cited)

- **T1 — Only rejection path is CANCELLED.** `ALLOWED_TRANSITIONS` (`server.js:6289`) offers `NEW → [PENDING, QUOTED, CANCELLED]`; there is no `NOT_A_FIT` / `ARCHIVED`. So a polite "no thanks" to a fresh enquiry is recorded identically to cancelling a signed, deposit-paid deal.
- **T2 — `status` is unconstrained free text.** `bookings.status TEXT DEFAULT 'NEW'` with **no CHECK** (`database.js:127`); the state machine is the sole enforcement. Mechanically you *could* add statuses, but…
- **T3 — Analytics count by status.** The dashboard's booking-status counts use `COUNT(CASE WHEN status = 'PENDING' THEN 1 END) …` etc. (`server.js:7674+`). Overloading `status` with triage values pollutes these counts and any conversion math, and would force edits to the state machine (T1).
- **T4 — Two-axis precedent exists.** The system already runs a second orthogonal axis, `payment_status`, beside `status`. A `disposition` axis follows the same pattern and keeps the pipeline enum pristine — and requires **no** state-machine change.

---

## 3. NON-NEGOTIABLE CONSTRAINTS
- Do not change `ALLOWED_TRANSITIONS` or the status-transition route.
- `disposition` is orthogonal: setting it is a simple `UPDATE` + `audit_log` write, not a pipeline transition.
- Non-active bookings are **excluded from the active pipeline and its conversion metrics** by default, but remain retrievable via a filter (nothing is deleted).
- Idempotent migration; `--atl-*` tokens; surfaced catches; `apiCall`.

---

## 4. DECISION GATES

| ID | Decision | Options | Recommendation |
|---|---|---|---|
| **DG-T1** | Where triage lives | A. New `disposition` axis (active/not_a_fit/archived) · B. Add `NOT_A_FIT`/`ARCHIVED` to the `status` enum | **A.** Keeps `status` clean, preserves conversion analytics, and needs no state-machine edit (T3/T4). B forces analytics + state-machine changes. |
| **DG-T2** | Disposition values | active / not_a_fit / archived · add more (e.g. `spam`, `duplicate`) | Start with the three; extend later. |
| **DG-T3** | When is triage offered | Any status · Only before the deal goes live (pre-`QUOTED`) | Offer freely, but the primary use is fresh enquiries; a live deal that dies still uses `CANCELLED`. |

Phases assume DG-T1 = A.

---

## 5. PHASED TASKS

### Phase 1 — Schema (`database.js`, idempotent)
Add via the existing `PRAGMA table_info` → failsafe-`ALTER` pattern (e.g. alongside `:160`):
```sql
ALTER TABLE bookings ADD COLUMN disposition TEXT DEFAULT 'active';
CREATE INDEX IF NOT EXISTS idx_bookings_disposition ON bookings(disposition);
```

### Phase 2 — Backend (`server.js`)
- `PUT /api/admin/bookings/:id/disposition` (`requireAdmin`): validate value ∈ {active, not_a_fit, archived}; `UPDATE bookings SET disposition = ?`; write an `audit_log` row (old→new) exactly like status changes do (`server.js:6321`). No `ALLOWED_TRANSITIONS` call.
- **Analytics:** in the booking-status count query (`server.js:7674+`), scope active-pipeline counts to `WHERE disposition = 'active'` (or `disposition IS NULL` for legacy rows), so triaged leads don't inflate the funnel. Optionally add `not_a_fit_count` / `archived_count` for a lead-quality view.
- **List query:** default the bookings list to `disposition = 'active'`; accept a filter param to include others.

### Phase 3 — Frontend (`admin.html`)
- In the booking detail (Deal View header "More" menu, per the tabbed prompt), add **Mark Not a Fit** / **Archive**, and **Restore** for non-active bookings. Confirm-then-`apiCall`.
- In the bookings list, add a filter (Active / Not a Fit / Archived / All), defaulting to Active. Non-active rows show a subtle disposition badge when viewed.
- After a disposition change, refresh the list so the row leaves the active view.

---

## 6. ACCEPTANCE CRITERIA
- [ ] A fresh enquiry can be marked Not a Fit or Archived without a `status` change and without touching `ALLOWED_TRANSITIONS`.
- [ ] Non-active bookings drop out of the default active list and the pipeline/conversion counts.
- [ ] The list filter surfaces Not a Fit / Archived / All; Restore returns a booking to active.
- [ ] Every disposition change writes an `audit_log` entry.
- [ ] Migration is idempotent; legacy rows (no disposition) count as active.
- [ ] `--atl-*` only; both themes; `apiCall`; catches surfaced.

---

## 7. TEST MATRIX
**Normal** — New enquiry → Mark Not a Fit → leaves active list, funnel count unchanged by it → filter to "Not a Fit" shows it → Restore → back in active.
**Edge** — Archive a booking that already has a quote → allowed, but note it's unusual (dies via disposition, not CANCELLED). · Legacy booking with `disposition = NULL` → treated as active everywhere. · Toggle filter to "All" → shows every disposition.
**Failure** — Invalid disposition value → 4xx, no write. · Analytics query with zero active bookings → returns zeros, no error.
**Regression** — `status` transitions, the state machine, and `CANCELLED` behaviour all unchanged. · Existing dashboard counts for active bookings match pre-change values. · No duplicate booking ids; migration re-run adds nothing.

---

## Appendix — anchor index
- State machine (do not touch): `ALLOWED_TRANSITIONS` `server.js:6289`; audit write pattern `:6321`
- `bookings.status` (unconstrained): `database.js:127`; failsafe-ALTER pattern `:160`
- Status-count analytics: `server.js:7674+`
- Two-axis precedent: `payment_status` `database.js:132`
- Backend RBAC: `requireAdmin` `server.js:1229`
