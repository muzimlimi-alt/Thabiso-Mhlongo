# Atelier — Public Booking Form Fields

**Feature:** Capture four booking inputs the form currently misses — **budget**, **alternative/backup dates**, a **content-suitability note**, and an optional **"how did you hear about us."**
**Scope:** Small full-stack — a couple of idempotent columns (`database.js`) + intake mapping/validation (`server.js`) + form inputs (`index.html`) + display (`admin.html`).
**Grounding:** All citations verified by direct audit.

---

## 0. PROMPT RULES
Standard Atelier rules: `--atl-*` tokens; `catch` → `notificationService.showError()` + `console.error()`; `apiCall()` where authenticated; idempotent migrations; no RBAC/business-logic changes beyond the intake field mapping explicitly scoped here. New fields are **optional** — do not add required-field gates that raise the submission barrier.

---

## 1. FULL-STACK IMPACT ANALYSIS

| Layer | Impact | Detail |
|---|---|---|
| **Database** | **Two columns** (+1 already exists) | `budget_range` **already exists** (`database.js:124`). Add `alternative_dates TEXT`, `content_notes TEXT`, and (optional) `heard_about TEXT`. Idempotent ALTERs. |
| **Backend / API** | **Intake mapping + light validation** | The intake route already destructures `budget_range` (`server.js:2444`) — it just isn't sent by the form. Add the new fields to the destructure + INSERT, with length validation. |
| **Frontend (public)** | **Four inputs** | Add to the booking form in `index.html`; client-side validation matching the server. |
| **Frontend (admin)** | **Display** | Surface the new fields in the booking detail (budget already renders at `admin.html:11268` and will now be populated). |
| **Security / RBAC** | **Untouched** | — |

---

## 2. CONFIRMED CURRENT-STATE FINDINGS (audit, cited)

- **F1 — Budget is a one-line fix.** `budget_range` exists as a column (`database.js:124`) **and** is already destructured in the intake route (`server.js:2444`). Only the **form input is missing** — no `bookBudget` field exists in `index.html`. Add the input and it wires end-to-end; the admin detail already displays it (`admin.html:11268`).
- **F2 — Three columns genuinely absent.** `content_notes`, `alternative_dates`, `heard_about` do not exist in the schema (grep-confirmed). These need idempotent ALTERs + intake mapping + inputs + display.
- **F3 — Intake validation pattern.** The route validates name/email/phone/date/message length + POPIA consent + availability + working hours (`server.js:2450+`). New fields get light length caps only; none become required.
- **F4 — "How did you hear" is optional.** `source` / `referrer` are already auto-captured (`database.js:189–190`), so the self-reported `heard_about` is additive, not essential — the lowest-priority of the four. **DG-F1.**

---

## 3. NON-NEGOTIABLE CONSTRAINTS
- All four new fields are optional; do not extend the required-field check (`server.js:2450`).
- Idempotent migrations only (existing `PRAGMA table_info` → failsafe-`ALTER` pattern).
- Server-side validation mirrors client-side; never trust client length limits alone.
- `--atl-*` tokens on all new UI (form and admin); both themes.
- Do not remove or repurpose the auto-captured `source`/`referrer`.

---

## 4. DECISION GATES

| ID | Decision | Options | Recommendation |
|---|---|---|---|
| **DG-F1** | Include self-reported "how did you hear"? | Add `heard_about` field · Rely on auto `source`/`referrer` | Optional. Add only if the human answer is wanted alongside the automatic capture (F4). |
| **DG-F2** | Alternative dates shape | A. Freeform `alternative_dates TEXT` ("any Friday in Dec") · B. A structured second date | **A** — clients express backup dates loosely; freeform captures reality better. |
| **DG-F3** | Content-suitability shape | Freeform `content_notes TEXT` · A quick-select (corporate-safe / any material / restrictions) + freeform | Freeform to start; add a quick-select later if it's frequently the same few answers. |

Phases assume DG-F2 = A, DG-F3 = freeform, DG-F1 = include.

---

## 5. PHASED TASKS

### Phase 1 — Schema (`database.js`, idempotent)
Via the existing failsafe-`ALTER` pattern (alongside `:160`):
```sql
ALTER TABLE bookings ADD COLUMN alternative_dates TEXT;
ALTER TABLE bookings ADD COLUMN content_notes TEXT;
ALTER TABLE bookings ADD COLUMN heard_about TEXT;   -- DG-F1
```
(`budget_range` already exists — do not re-add.)

### Phase 2 — Intake route (`server.js:2441`)
- Add `alternative_dates`, `content_notes`, `heard_about` to the `req.body` destructure (beside the existing `budget_range`) and to the `INSERT` column list.
- Validation: cap each at a sane length (e.g. `content_notes` ≤ 500, `alternative_dates` ≤ 300, `heard_about` ≤ 200); trim; all optional. No new required checks (F3).

### Phase 3 — Public form (`index.html`)
Add to the booking form, styled with `--atl-*`:
- **Budget** (`bookBudget`) — select or text mapping to `budget_range` (e.g. ranges: "< R10k / R10–25k / R25–50k / R50k+ / Prefer not to say").
- **Alternative dates** (`bookAltDates`) — freeform text (DG-F2).
- **Content suitability** (`bookContentNotes`) — freeform, placeholder "e.g. corporate-safe, no explicit material" (DG-F3).
- **How did you hear** (`bookHeardAbout`) — optional select/text (DG-F1).
Client validation mirrors Phase 2 caps; all optional so the form still submits without them.

### Phase 4 — Admin display (`admin.html`)
Surface the new fields in the booking detail (Deal View Overview → Audience & Budget / Event cards per the tabbed prompt): budget already renders (`:11268`); add `content_notes`, `alternative_dates`, and `heard_about` read-outs, shown only when present.

---

## 6. ACCEPTANCE CRITERIA
- [ ] Submitting the form with all four fields persists them; budget lands in the existing `budget_range` and shows in the admin detail.
- [ ] Submitting with **none** of the four still succeeds (all optional).
- [ ] Server rejects over-length values with a clear message; client mirrors the caps.
- [ ] `content_notes` / `alternative_dates` / `heard_about` render in the admin detail only when present.
- [ ] Migration is idempotent; `budget_range` not duplicated; `source`/`referrer` untouched.
- [ ] `--atl-*` only on all new UI; both themes.

---

## 7. TEST MATRIX
**Normal** — Fill all four → submit → all persist → admin detail shows budget + content note + alt dates + heard-about.
**Edge** — Submit with fields blank → succeeds, admin detail omits the empty read-outs. · Budget "Prefer not to say" → stored, no downstream break. · Very long content note → client + server both cap it. · Emoji/unicode in freeform fields → stored and displayed intact.
**Failure** — Over-length `content_notes` bypassing client validation → server 4xx, no partial insert. · Malformed request missing required (existing) fields → unchanged existing behaviour.
**Regression** — Existing required-field validation, POPIA consent, availability, and working-hours checks all unchanged. · Auto `source`/`referrer` still captured. · `budget_range` intake mapping (already present) still works. · Migration re-run adds nothing.

---

## Appendix — anchor index
- Intake route: `POST /api/public/bookings` `server.js:2441`; destructure incl. `budget_range` `:2444`; validation block `:2450+`
- `budget_range` column (exists): `database.js:124`; failsafe-ALTER pattern `:160`
- Auto-captured source/referrer: `database.js:189–190`
- Admin budget read-out (already renders): `admin.html:11268`
- Public form field ids: `index.html` (`book*`)
