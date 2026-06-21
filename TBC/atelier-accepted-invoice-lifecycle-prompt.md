# Accepted-Booking Invoice Lifecycle — Full-Stack Execution Prompt

**Target file(s):** `admin.html` (primary), `server.js` (only if Option B is chosen — see §3), `database.js` (read-only reference)
**Role of executing agent:** Implement the change. **Role of reviewer (Muzi):** Approve the §3 decision gate *before* the agent writes code.
**Status of this document:** Grounded against the live codebase. Every table, column, route, function, line number, and CSS token below was verified against the repository as it currently stands. Do **not** substitute remembered names for the ones written here.

---

## 0. WHAT THIS FEATURE ACTUALLY IS

Make **Accepted** bookings participate in the invoice lifecycle so an administrator can tell, *at a glance from the booking card*, where a booking sits between quote-acceptance and payment, and so the card always surfaces the single most relevant next action.

Critically: **the booking's `status` stays `ACCEPTED` throughout this entire sub-flow.** "Invoice Ready", "Invoiced", and "Paid / Confirmed" are **presentation states layered over `status = 'ACCEPTED'` + the associated invoice's status** — they are *not* new booking statuses. The only booking-status transition this feature touches is the existing `ACCEPTED → CONFIRMED` move, fired by the **Confirm** CTA. Do not invent booking statuses; do not edit `ALLOWED_TRANSITIONS` to add fake stages.

---

## 1. FULL-STACK IMPACT ANALYSIS (MANDATORY — read before coding)

### 1.1 Database layer — **NO new fields, NO migrations required**

The schema already supports everything. Relevant tables (defined in `database.js`):

| Table | Key columns this feature reads | Notes |
|---|---|---|
| `bookings` | `id`, `status`, `payment_status`, `quote_amount`, `total_amount`, `amount_paid`, `amount_outstanding`, `accepted_at`, `confirmed_at`, `client_id` | `status` enum (de-facto): `NEW, PENDING, QUOTED, ACCEPTED, CONFIRMED, COMPLETED, CANCELLED, EXPIRED`. `payment_status`: `UNPAID, PAID` (also `DEPOSIT_PAID, PARTIALLY_PAID, FAILED` per UI labels). |
| `invoices` | `id`, `booking_id`, `client_id`, `invoice_number`, `status`, `total_amount`, `file_path`, `voided_at`, `created_at` | `status` column **DEFAULT `'draft'`**, but see §1.2 — the live code never actually writes `'draft'`. FK `booking_id → bookings(id)`. |
| `transactions` | `booking_id`, `invoice_id`, `amount`, `status` | Payment ledger. Already updated by the payment flow. |
| `communication_log` | `booking_id`, `client_id`, `direction`, `channel`, `subject`, `content_snippet`, `sent_at` | The "CRM activity timeline" sink. **Currently NOT written on invoice send.** |
| `audit_log` | `table_name`, `record_id`, `action`, `changed_by`, `changes_json`, `change_timestamp` | The "audit log" sink. **Currently NOT written on invoice send.** |
| `payment_schedules` | `booking_id`, `invoice_id`, `description`, `due_date`, `expected_amount`, `status` | Auto-created (50/50) on quote acceptance — see `server.js` accept-quote route. |

> **Integrity hazard to fix, not inherit:** `invoices.status` is written with **inconsistent casing** across the codebase — `'SENT'` (`server.js:903`), `'void'`/`'paid'` (`:862`, `:6044`), `'PAID'` (`:3057`), `'VOID'` (`:5452`). Any logic that branches on invoice status **must normalise case** (`String(x).toUpperCase()`), and any SQL filter on invoice status must be case-insensitive.

### 1.2 Backend layer

**The card's data source is `GET /api/admin/bookings/full` (`server.js:5542`)** — *not* `/api/admin/bookings`. Confirm this: `admin.html` `loadBookings()` (≈line 9869) calls `apiCall('/api/admin/bookings/full')`.

This endpoint **already surfaces invoice state per row** via correlated subqueries (`server.js:5578–5583`):
```
(SELECT status         FROM invoices WHERE booking_id = b.id AND status != 'VOID' ORDER BY created_at DESC LIMIT 1) AS invoice_status,
(SELECT invoice_number FROM invoices WHERE booking_id = b.id AND status != 'VOID' ORDER BY created_at DESC LIMIT 1) AS invoice_number,
(SELECT id             FROM invoices WHERE booking_id = b.id AND status != 'VOID' ORDER BY created_at DESC LIMIT 1) AS invoice_id
```
So `row.invoice_status`, `row.invoice_id`, and `row.invoice_number` are **already available in `renderBookingsTable`** and are simply not used by the ACCEPTED card branch yet. **This is the single most important fact for scoping: the feature is overwhelmingly a frontend presentation change.**

> **Bug in the above subquery:** `status != 'VOID'` is case-sensitive. `generateInvoice` voids superseded invoices with **lowercase** `'void'` (`server.js:862`), so a lowercase-voided invoice is **not** excluded and can surface as the "active" invoice. **Fix all three subqueries to `UPPER(status) != 'VOID'`** and likewise normalise the quotations join on `:5587` (`status != 'void'`). This is mandatory for correct card state.

**Invoice lifecycle endpoints (current behaviour):**

| Route | File:line | What it does today | Gap vs. feature |
|---|---|---|---|
| `generateInvoice(bookingId)` | `server.js:840` | Voids prior non-paid invoices; inserts a **new invoice with status `'SENT'` (`:903`)**; emails it (`:935`); updates `bookings.total_amount`/`amount_outstanding`. | **Generation == sending.** No way to create an unsent/draft invoice. |
| `POST /api/admin/bookings/:id/invoice/generate` | `server.js:6850` | Wraps `generateInvoice()`. | Same — produces a `'SENT'` invoice + email in one step. |
| `POST /api/admin/invoices/:id/send` | `server.js:5433` | **Resends** the existing PDF by email. | **Does NOT** update `invoices.status`; **does NOT** write `communication_log` or `audit_log`. No persisted "sent" milestone. |
| `POST /api/admin/invoices/:id/void` | `server.js:5450` | Voids (uppercase `'VOID'`). | — |
| `PUT /api/admin/bookings/:id/status` | `server.js:6620` → `applyStatusChange()` `:5970` | Status transition, gated by `ALLOWED_TRANSITIONS` (`:5971`): `ACCEPTED → ['QUOTED','CONFIRMED','CANCELLED']`. Writes `confirmed_at`, syncs calendar, sends confirmed email (`:6039`). | This is the **Confirm** CTA's backend. Reuse as-is. |

**Consequence:** the feature's row-2 state ("ACCEPTED + Invoice Generated but Not Sent → *Send Invoice*") cannot occur in the current backend, because no path leaves an invoice in a not-yet-sent state. Resolving this is the §3 decision gate.

### 1.3 Frontend layer (`admin.html`)

| Concept (feature's wording) | Where it lives now | Current ACCEPTED behaviour |
|---|---|---|
| Card builder | `renderBookingsTable(data)` ≈`:10063`; per-row `s = (row.status||'PENDING').toUpperCase()` (`:10082`), `ps = (row.payment_status||'UNPAID').toUpperCase()` (`:10083`) | — |
| **Status Pill** | main status badge; label from `sLbl` map (`:10079`); colour from `window.statusColors(s)` | Shows raw `"Accepted"` always |
| **Next-Step Badge** | `nextStepHtml`, an `.atl-status-badge` chain (`:10114–10143`) | ACCEPTED branch (`:10125–10126`) is hardcoded **"Confirm Booking"**, invoice-blind |
| **Primary CTA(s)** | `actionButtonsHtml` (`:10156–10183`) | ACCEPTED branch (`:10167–10170`): **"Confirm"** (`.bk-action-status` `data-status="CONFIRMED"`) + **"Payment"** (`.bk-action-record-payment`) |
| Re-render after an action | delegated handlers call `loadBookings()` (e.g. `.bk-action-status` handler at `:11020`, calls `loadBookings()` `:11029`) | This full re-fetch **is** the "update without page refresh" mechanism — reuse it; do not build a second refresh path |

**Reusable invoice helpers that already exist (use these — do NOT create new ones):**
- `window.generateInvoice(bookingId, btnEl)` — `admin.html:16711` → `POST /api/admin/bookings/:id/invoice/generate` (generate **and** send; takes a **booking** id).
- `window.sendInvoice(invoiceId)` — `admin.html:16687` → `POST /api/admin/invoices/:id/send` (resend; takes an **invoice** id).
- `window.voidInvoice(invoiceId, num)` — `admin.html:16697`.

> **The source prompt's `bk-action-send-invoice` handler does not exist** anywhere in `admin.html`. Wherever the source prompt says "reuse `bk-action-send-invoice`", it means: reuse the real helpers above. The booking card has the booking id *and* (via the `/full` payload) `row.invoice_id`, so it can call either helper correctly.

### 1.4 Per-layer change summary (state this before implementation — Section 1 requirement)

- **Database:** No schema change. (Option B adds zero columns; it only changes which string value `status` holds.)
- **Backend:** Mandatory: harden the `/full` invoice subqueries to case-insensitive `VOID` filtering (`server.js:5578–5587`). Conditional on §3: if **Option B**, add a draft stage + a status-persisting send + timeline/audit writes. If **Option A**, **no other backend change**.
- **Frontend:** The substantive work. Rewrite the ACCEPTED branches of `nextStepHtml`, the Status-Pill label, and `actionButtonsHtml` to branch on `row.invoice_status` (case-normalised) and wire the CTA to the existing helpers. Ensure post-action re-render via `loadBookings()`.

---

## 2. TARGET STATE TABLE (canonical)

The booking is `status = 'ACCEPTED'` for all rows below. `inv` = case-normalised `row.invoice_status`; "active invoice" = the latest non-void invoice (already provided as `row.invoice_id`/`row.invoice_status`).

| Sub-state (detected from data) | Status Pill | Next-Step Badge | Primary CTA → handler |
|---|---|---|---|
| `ACCEPTED`, no active invoice (`invoice_id` null) | **Accepted** | **Generate Invoice** *(or "Confirm Booking" — see §3)* | **Generate Invoice** → `window.generateInvoice(row.id, this)` *(Option A)* / **Confirm** → existing `.bk-action-status data-status="CONFIRMED"` |
| `ACCEPTED` + invoice `DRAFT` *(Option B only)* | **Invoice Ready** | **Send Invoice** | **Send Invoice** → `window.sendInvoice(row.invoice_id)` |
| `ACCEPTED` + invoice `SENT` | **Invoiced** | **Awaiting Payment** | **Record Payment** → existing `.bk-action-record-payment` *(primary)*; secondary **Confirm** retained |
| `ACCEPTED` + invoice `PAID` | **Paid · Confirmed** | **Event Preparation** | **Confirm** / **Open Booking** → existing `.bk-action-info` (or `.bk-action-status data-status="CONFIRMED"`) |

Notes:
- Treat `inv` values case-insensitively. Map `SENT`/`sent` → Invoiced; `PAID`/`paid` → Paid; ignore `VOID`/`void` (the subquery should already exclude them once the casing bug is fixed).
- Keep the existing **Payment** button available wherever it is today (it is the real payment-recording entry point); the feature only changes which CTA is visually *primary*.
- Never hide the **Confirm** path entirely: the administrator must always retain a way to perform `ACCEPTED → CONFIRMED`.

---

## 3. DECISION GATE — resolve before writing code (REQUIRES MUZI'S SIGN-OFF)

The source spec's four-state model assumes an invoice can exist in a *generated-but-not-sent* state. The current backend has no such state (§1.2). Choose one:

### Option A — Frontend-only (zero `server.js` logic change beyond the casing fix)
Collapse to the three states the backend can actually produce. There is no `DRAFT` row.
- No active invoice → Pill **Accepted**, badge **Generate Invoice**, primary CTA **Generate Invoice** → `window.generateInvoice(row.id, this)` (which generates *and* sends in one step, consistent with current behaviour). Keep **Confirm** as a secondary button.
- Active invoice not `PAID` → Pill **Invoiced**, badge **Awaiting Payment**, primary CTA **Record Payment**; offer **Resend Invoice** (`window.sendInvoice(row.invoice_id)`) in the **⋮ More** dropdown.
- Active invoice `PAID` → Pill **Paid · Confirmed**, badge **Event Preparation**, primary CTA **Confirm**.
- **Pros:** smallest blast radius, honours the standing "don't touch `server.js`" preference, ships fast. **Cons:** the literal "Send Invoice as a distinct step" CTA from the spec does not appear (because generate already sends).

### Option B — Full four-state fidelity (surgical, bounded `server.js` changes)
Introduce a real draft stage so "Send Invoice" becomes a genuine, persisted action — the only way the source spec is satisfied literally.
1. **Parameterise generation:** change `generateInvoice(bookingId)` → `generateInvoice(bookingId, { send = true } = {})`. When `send === false`: insert the invoice with status **`'DRAFT'`** instead of `'SENT'` (`server.js:903`) and **skip** `sendInvoiceEmail` (`:935`). All other behaviour unchanged.
2. **Expose a draft route:** add `POST /api/admin/bookings/:id/invoice/draft` (mirrors `:6850`) calling `generateInvoice(id, { send:false })`; or accept a `?send=false` query on the existing route. The admin "Generate Invoice" CTA for a no-invoice ACCEPTED booking calls this → produces a `DRAFT`.
3. **Make send persist + sync:** in `POST /api/admin/invoices/:id/send` (`:5433`), after a successful email, within a transaction: `UPDATE invoices SET status='SENT', updated_at=CURRENT_TIMESTAMP WHERE id=? AND UPPER(status) IN ('DRAFT','SENT')`; insert a `communication_log` row (`direction='outgoing'`, `channel='email'`, `subject='Invoice <number> sent'`); insert an `audit_log` row (`table_name='invoices'`, `record_id=invoice.id`, `action='SEND'`, `changes_json` describing the transition). Return the updated invoice so the client can reconcile.
4. **Normalise casing** everywhere invoice status is written so detection is deterministic: standardise on **uppercase** (`'DRAFT'`, `'SENT'`, `'PAID'`, `'VOID'`) — update `:862`, `:903` (already `'SENT'`), `:3057`, `:5452`, `:6044`, and the `/full` subqueries.
- **Pros:** exactly matches the spec's four-state table; "Send Invoice" is a real, auditable, reuse-once action; CRM/audit/timeline sync (which the spec demands) is genuinely wired. **Cons:** touches `server.js` business logic — requires regression-testing the public accept-quote flow (`server.js:3422` calls `generateInvoice` with the default `send:true`, so it stays SENT — verify) and the admin generate flow.

> **Default recommendation:** **Option B**, because the source spec's headline instruction ("reuse the existing *send-invoice* handler so invoice actions get the same status as quote actions") is only literally true when sending is a distinct persisted step. But Option B edits `server.js`, which is normally out of scope. **Muzi to confirm A or B before the agent proceeds.** The frontend tasks in §4 are written to work under either; §4.4 marks the parts that are Option-B-only.

---

## 4. TASKS (numbered, with worked examples)

> All frontend edits are inside `renderBookingsTable` / the ACCEPTED branches identified in §1.3. Preserve every existing class, `data-*` attribute, and delegated-handler selector exactly. Add behaviour; do not rename hooks.

### Task 1 — Backend casing fix (MANDATORY under both options)
In `server.js:5578–5587`, change every invoice-status filter from `status != 'VOID'` to `UPPER(status) != 'VOID'`, and the quotations join from `status != 'void'` to `UPPER(status) != 'VOID'`. No behavioural change beyond correctly excluding lowercase-voided rows.

### Task 2 — Derive the invoice sub-state in the card builder
Inside `renderBookingsTable`'s per-row loop (near `:10082`), add a normalised reader used by Tasks 3–5:
```js
// Normalised invoice signal for ACCEPTED-card lifecycle (data already supplied by /api/admin/bookings/full)
const inv      = String(row.invoice_status || '').toUpperCase();      // '', 'DRAFT', 'SENT', 'PAID'
const invId    = row.invoice_id || null;
const hasInv   = !!invId && inv !== 'VOID';
const invPaid  = inv === 'PAID' || ps === 'PAID';
// Sub-state key drives pill / badge / CTA in one place:
let acceptedStage = 'none';                 // no active invoice
if (hasInv && inv === 'DRAFT') acceptedStage = 'ready';   // Option B only
else if (hasInv && inv === 'SENT' && !invPaid) acceptedStage = 'invoiced';
else if (invPaid) acceptedStage = 'paid';
```

### Task 3 — Status Pill label override (ACCEPTED only)
The pill text currently comes from `sLbl[s]` (`:10079`). For `s === 'ACCEPTED'`, override the displayed label by `acceptedStage`:
- `none` → `Accepted`
- `ready` → `Invoice Ready`
- `invoiced` → `Invoiced`
- `paid` → `Paid · Confirmed`

Keep the pill's existing classes and `window.statusColors` colour for ACCEPTED, but you may tint by stage using existing tokens only (`--atl-amber` for ready, `--atl-blue` for invoiced, `--atl-green`/`--atl-sage` for paid). **Do not introduce new hex literals** — the global light-theme cascade depends on tokens.

### Task 4 — Next-Step Badge (rewrite the ACCEPTED branch)
Replace the single hardcoded ACCEPTED branch (`:10125–10126`) with stage-aware badges, all using the existing `.atl-status-badge` structure, FontAwesome icons already in the file, token colours, and an informative `title=` + `aria-label=` (the existing badges set both — match that for WCAG parity):

| `acceptedStage` | Badge text | Icon | `aria-label` |
|---|---|---|---|
| `none` | Generate Invoice *(A)* / Confirm Booking | `fa-file-invoice-dollar` / `fa-circle-check` | "Next step: generate the client's invoice" |
| `ready` *(B)* | Send Invoice | `fa-paper-plane` | "Next step: send the invoice to the client" |
| `invoiced` | Awaiting Payment | `fa-hourglass-half` | "Next step: awaiting client payment" |
| `paid` | Event Preparation | `fa-clipboard-check` | "Next step: prepare for the event" |

> Once an invoice is `SENT`/`PAID`, the badge must **not** say anything implying an invoice still needs sending. (Acceptance criterion AC-5.)

### Task 5 — Primary CTA (rewrite the ACCEPTED branch)
Replace the ACCEPTED block in `actionButtonsHtml` (`:10167–10170`) so the *primary* button matches the stage, while **retaining** the existing **Payment** button and a path to **Confirm**:
```js
if (s === 'ACCEPTED') {
  if (acceptedStage === 'none') {
    // Option A: generate (which sends). Option B: generate draft (see Task 7).
    actionButtonsHtml += `<button type="button" class="atl-btn atl-btn--primary bk-action-gen-invoice" data-id="${row.id}"><i class="fa-solid fa-file-invoice-dollar" style="margin-right:6px;"></i>Generate Invoice</button>`;
    actionButtonsHtml += `<button type="button" class="atl-btn atl-btn--ghost bk-action-status" data-id="${row.id}" data-status="CONFIRMED"><i class="fa-solid fa-circle-check" style="margin-right:6px;"></i>Confirm</button>`;
  } else if (acceptedStage === 'ready') {            // Option B only
    actionButtonsHtml += `<button type="button" class="atl-btn atl-btn--primary bk-action-send-invoice" data-id="${row.id}" data-invoice-id="${invId}"><i class="fa-solid fa-paper-plane" style="margin-right:6px;"></i>Send Invoice</button>`;
    actionButtonsHtml += `<button type="button" class="atl-btn atl-btn--ghost bk-action-status" data-id="${row.id}" data-status="CONFIRMED"><i class="fa-solid fa-circle-check" style="margin-right:6px;"></i>Confirm</button>`;
  } else if (acceptedStage === 'invoiced') {
    actionButtonsHtml += `<button type="button" class="atl-btn atl-btn--primary bk-action-record-payment" data-id="${row.id}" data-quote="${row.quote_amount||''}"><i class="fa-solid fa-money-bill-wave" style="margin-right:6px;"></i>Record Payment</button>`;
    actionButtonsHtml += `<button type="button" class="atl-btn atl-btn--ghost bk-action-status" data-id="${row.id}" data-status="CONFIRMED"><i class="fa-solid fa-circle-check" style="margin-right:6px;"></i>Confirm</button>`;
  } else { // paid
    actionButtonsHtml += `<button type="button" class="atl-btn atl-btn--primary bk-action-status" data-id="${row.id}" data-status="CONFIRMED"><i class="fa-solid fa-circle-check" style="margin-right:6px;"></i>Confirm</button>`;
    actionButtonsHtml += `<button type="button" class="atl-btn atl-btn--ghost bk-action-info" data-id="${row.id}"><i class="fa-solid fa-folder-open" style="margin-right:6px;"></i>Open Booking</button>`;
  }
  // RETAIN the existing Payment button for non-paid stages (do not remove the current entry point):
  if (!invPaid) {
    actionButtonsHtml += `<button type="button" class="atl-btn atl-btn--ghost bk-action-record-payment" data-id="${row.id}" data-quote="${row.quote_amount||''}" ${ps==='PAID'?'disabled style="opacity:.45;cursor:not-allowed;"':''}><i class="fa-solid fa-money-bill-wave" style="margin-right:6px;"></i>Payment</button>`;
  }
}
```

### Task 6 — Wire the new card hooks to existing logic (NO duplicate logic)
Add delegated handlers next to the existing ones (the file uses `$(document).off('click.x').on('click.x', '.selector', …)` — follow that exact pattern; e.g. the `.bk-action-status` handler at `:11020`). Each new handler is a *thin shim* over an existing helper — do **not** reimplement invoice sending/generation, do **not** add new endpoints (except the §3 Option-B draft route), do **not** add new modals:
```js
// Generate (and, in Option A, send) — reuse window.generateInvoice
$(document).off('click.bkgeninv').on('click.bkgeninv', '.bk-action-gen-invoice', function() {
  window.generateInvoice($(this).data('id'), this);   // existing helper; calls loadBookings on success path as today
});
// Send an already-generated (DRAFT) invoice — Option B — reuse window.sendInvoice (takes an INVOICE id)
$(document).off('click.bksendinv').on('click.bksendinv', '.bk-action-send-invoice', async function() {
  const invoiceId = $(this).data('invoice-id');
  await window.sendInvoice(invoiceId);   // existing helper → POST /api/admin/invoices/:id/send
  await loadBookings();                  // re-render so pill/badge/CTA transition without a page refresh
});
```
> `window.generateInvoice` already toasts and updates its own button; ensure it (or this shim) triggers `loadBookings()` so the *card* transitions. If it does not already, call `loadBookings()` after its success — but do not duplicate the API call.

### Task 7 — (Option B only) Backend draft + persisted send + sync
Implement §3 Option B steps 1–4 in `server.js`. Keep each edit surgical and within a transaction where it writes multiple tables. After this, the `.bk-action-gen-invoice` CTA for a no-invoice booking should call the **draft** route (so it yields `acceptedStage === 'ready'`), and `.bk-action-send-invoice` flips it to `SENT` with `communication_log` + `audit_log` written. Verify the **public** accept-quote path (`server.js:3422`) still calls `generateInvoice` with `send:true` and therefore still produces a `SENT` invoice + client email (no regression to the public funnel).

### Task 8 — Dashboard metrics / pipeline pills sanity check
The top filter bar pills (`admin.html:4609–4639`) count by booking `status`; ACCEPTED stays ACCEPTED, so counts are unaffected — **verify** the ACCEPTED count does not double-count or shift after this change. If any dashboard metric keys off invoice status, confirm it reads the normalised value.

---

## 5. HARD CONSTRAINTS

1. **Preserve all JS-bound hooks.** Every existing class, `id`, and `data-*` on booking cards and their handlers must remain. New hooks are additive (`bk-action-gen-invoice`, `bk-action-send-invoice`).
2. **No duplicate logic.** Reuse `window.generateInvoice`, `window.sendInvoice`, `.bk-action-record-payment`, `.bk-action-status`, and `loadBookings()`. No new modals, no parallel send/generate endpoints (except the single Option-B draft route), no second refresh mechanism.
3. **Booking status is sacred.** Do not add booking statuses; do not modify `ALLOWED_TRANSITIONS` (`server.js:5971`). The four sub-states are presentation over `ACCEPTED` + invoice status.
4. **Server-authoritative money & status.** The card may *read* `invoice_status`/totals but must never compute or assert financial truth client-side. Confirm/payment/send all go through existing server routes.
5. **Tokens only — no raw hex** in any added markup or CSS. Use `--atl-*` variables and existing `.atl-btn`, `.atl-btn--primary`, `.atl-btn--ghost`, `.atl-status-badge`, `.atl-pill` classes so dark/light theming and the global cascade keep working.
6. **`server.js` is touched only if Option B is approved.** Under Option A, the sole backend edit is the Task 1 casing fix.
7. **Case-insensitive invoice-status handling** everywhere (read and SQL).

---

## 6. ACCEPTANCE CRITERIA

- **AC-1** A booking at `ACCEPTED` with **no** active invoice shows Pill **Accepted** and a **Generate Invoice** (Option A) primary CTA, with **Confirm** available.
- **AC-2** *(Option B)* After generating a draft, the same card transitions to Pill **Invoice Ready** / badge **Send Invoice** / CTA **Send Invoice** **without a page refresh**.
- **AC-3** After the invoice is sent (`SENT`), the card shows Pill **Invoiced** / badge **Awaiting Payment**; the primary CTA is **Record Payment**; **no** UI element implies the invoice still needs sending.
- **AC-4** When payment is recorded/`PAID`, the card shows Pill **Paid · Confirmed** / badge **Event Preparation** and guides toward **Confirm / Open Booking**.
- **AC-5** The **Send Invoice** action invokes the **existing** `window.sendInvoice(invoiceId)` (→ `POST /api/admin/invoices/:id/send`); no duplicate sending logic, modal, endpoint, or handler is introduced.
- **AC-6** *(Option B)* A successful send writes `invoices.status='SENT'`, one `communication_log` row, and one `audit_log` row; the booking's CRM timeline and audit view reflect it.
- **AC-7** Lowercase-`'void'` invoices never drive card state (casing bug fixed); the latest **non-void** invoice is the one reflected.
- **AC-8** The public accept-quote funnel and the admin generate flow show **no regression** (still produce an invoice + client email as before).
- **AC-9** All added badges/buttons carry `title` + `aria-label`, are keyboard-focusable with a visible focus state, and meet WCAG 2.1 AA contrast (4.5:1) in **both** themes.

---

## 7. TEST PLAN (run before declaring done)

**Normal flow**
1. Admin manually moves a `QUOTED` booking → `ACCEPTED` (no invoice). Card → *Accepted / Generate Invoice*.
2. Click **Generate Invoice**. Option A: card → *Invoiced / Awaiting Payment* (generate==send). Option B: card → *Invoice Ready / Send Invoice*; then click **Send Invoice** → card → *Invoiced / Awaiting Payment* with no refresh.
3. **Record Payment** in full → card → *Paid · Confirmed / Event Preparation*.
4. **Confirm** → booking transitions `ACCEPTED → CONFIRMED`; standard confirmed flow fires.

**Public-funnel parity**
5. Accept a quote via the public route. Confirm an invoice is created `SENT` and emailed, and the admin card shows *Invoiced / Awaiting Payment* (because generate==send via `server.js:3422`).

**Edge cases**
6. A booking with a lowercase-`'void'` superseded invoice and a newer `SENT` invoice → card reflects the `SENT` one only.
7. Mixed-case `invoice_status` (`'sent'`, `'paid'`) → detection still correct (Task 2 normalisation).
8. `ACCEPTED` + `payment_status='PAID'` but invoice row `SENT` → treated as **paid** (AC-4) — verify `invPaid` precedence.
9. No-invoice ACCEPTED booking: **Confirm** still works and is reachable.

**Failure cases**
10. `window.sendInvoice` API failure → existing error toast shows; card state unchanged; **no** optimistic "Invoiced" flip.
11. *(Option B)* Draft route or send `UPDATE` fails inside the transaction → rollback; no partial `communication_log`/`audit_log` rows; card unchanged.
12. Invoice PDF missing on send (`server.js:5438` already guards) → user sees the "regenerate" error, not a silent success.

**Regression**
13. Non-ACCEPTED cards (NEW/PENDING/QUOTED/CONFIRMED/COMPLETED/CANCELLED/EXPIRED) render unchanged.
14. Top filter-bar status counts unchanged (Task 8).
15. Full visual/responsive/keyboard pass on the bookings list in **both** dark and light themes; verify focus rings and contrast on the new badges/buttons.

---

## 8. SUGGESTED ORDER OF WORK

1. **Get Muzi's §3 decision (A or B).**
2. Task 1 (casing fix) — independent, low-risk, do first.
3. Tasks 2–6 (frontend presentation + thin shims) — the bulk of the feature; works under either option.
4. Task 7 (Option B backend) — only if approved; test the public funnel immediately after.
5. Task 8 (metrics sanity).
6. Full §7 test matrix in both themes.
7. Confirm every §6 acceptance criterion before sign-off.

---

### Appendix — verified reference index (file:line)
- Card data source: `admin.html` `loadBookings()` ≈`:9869` → `GET /api/admin/bookings/full` `server.js:5542`; invoice fields exposed `:5578–5583`; casing bug `:5578`,`:5587`.
- Card builder & ACCEPTED branches: `admin.html` `renderBookingsTable` `:10063`; `s`/`ps` `:10082–10083`; `sLbl` `:10079`; `nextStepHtml` ACCEPTED `:10125–10126`; `actionButtonsHtml` ACCEPTED `:10167–10170`; **⋮ More** dropdown `:10186–10205`.
- Reusable helpers: `window.generateInvoice` `:16711`; `window.sendInvoice` `:16687`; `window.voidInvoice` `:16697`.
- Existing delegated-handler pattern: `.bk-action-status` `:11020` (calls `loadBookings()` `:11029`).
- Invoice backend: `generateInvoice` `server.js:840` (status `'SENT'` `:903`, email `:935`, lowercase void `:862`); generate route `:6850`; send route `:5433`; void route `:5450`.
- Status transition: `PUT /api/admin/bookings/:id/status` `:6620` → `applyStatusChange` `:5970`; `ALLOWED_TRANSITIONS` `:5971`.
- Schema: `bookings` `database.js:105`; `invoices` `:779`; `transactions` `:819`; `communication_log` `:880`; `audit_log` `:988`; `payment_schedules` `:912`.
