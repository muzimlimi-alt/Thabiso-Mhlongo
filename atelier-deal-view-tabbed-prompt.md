# Atelier — Tabbed Deal View + Advancing Pack

This document contains **two parts with different scopes and a strict sequencing dependency.** Ship them in order.

| | Part | Scope | Ships |
|---|---|---|---|
| **Part I** | Tabbed Deal View | **Frontend only** — `admin.html`. Zero DB, zero `server.js`. | First — creates the Advancing tab slot. |
| **Part II** | Advancing Pack | **Full-stack** — `database.js` + `server.js` + `admin.html`. New tables, new routes, PDF, send-to-venue. | Second — fills the Advancing tab (supersedes Part I's Phase 5 stub). |

**Two external dependencies gate Part II only** (see Part II §2): `pdfService.js` and `js/emailService.js` + `js/emailTemplates.js` are `require`d by the running server but were **not available for audit**. Part II specs everything up to those boundaries and marks them as blocking dependencies — provide the files to finalise the PDF and send steps. **Part I has no such dependency and can be built immediately.**

**Grounding:** Every line citation was verified by direct audit of the current `admin.html` / `server.js` / `database.js`. Do **not** infer structure from this document — open the cited lines and confirm before editing.

---

# ══════════ PART I — TABBED DEAL VIEW (frontend only) ══════════

**Feature:** Convert the flat, two-column booking detail region into a tabbed **Deal View** (Overview · Offer & Contract · Invoices & Payments · Advancing · Timeline & Notes · Files).
**Scope:** **Frontend only.** One file: `admin.html`. **Zero** database changes. **Zero** `server.js` changes.
**Visual spec:** `atelier-deal-view-mockup.html` (obsidian/gold, real `--atl-*` tokens, drawer model, six tabs) is the reference for layout, spacing, and interaction feel.

---

## 0. PROMPT RULES (read first, apply to every task)

1. **Tokens only.** Every colour, radius, shadow, and spacing value comes from the existing `--atl-*` system (`admin.html:730–840`). **Zero hardcoded hex.** If a value you need has no token, add it to the `:root` / `[data-theme="light"]` blocks in both themes — never inline a raw hex.
2. **Error surfacing.** Every `catch` calls `window.notificationService.showError('<user-facing message>')` **and** `console.error(...)`. No silent catches.
3. **Fetch standard.** Use `apiCall(url, method, body)` (`admin.html:10310`) for any authenticated request you introduce or relocate. Raw `fetch(..., {credentials:'same-origin'})` is retained only where it already exists and you are *not* moving it, or for multipart/`/upload`.
4. **Do not touch the backend.** No route, schema, or middleware edits. All data already exists behind the endpoints listed in §1.
5. **Do not touch RBAC.** Server-side guard is `requireAdmin` (`server.js:1229`) — untouched. Client-side: **relocate the existing action buttons verbatim** (class + `data-id` + any gating attributes intact). Do not re-implement gating or re-bind handlers.
6. **Preserve every hook.** Every `id`, `data-id`, `class`, and delegated event-handler class on a relocated control must survive byte-for-byte (see §2 F4). Relocation ≠ rewrite.
7. **No name collisions.** `window.switchTab` (`admin.html:15798`) already owns the **admin section** switcher. The new within-deal tab controller MUST use a distinct name (this doc uses `dvActivateTab`).

---

## 1. FULL-STACK IMPACT ANALYSIS

| Layer | Impact | Detail |
|---|---|---|
| **Database** | **None** | No new tables, columns, or migrations. |
| **Backend / API** | **None** | Reuses existing endpoints only: `GET /api/admin/bookings/:id/details` (`server.js:6075`), `/quote-history`, `/contract`, `/notes`, `/communications`. No new routes. |
| **Frontend** | **Major (contained)** | Refactor the detail region inside `renderBookingsTable` (`admin.html:10922–11640`) into six tab panels; add a tab controller; re-route lazy loads to tab activation; per **DG-1**, convert the inline `.atl-detail-region` into a shared drawer. |
| **Security / RBAC** | **Untouched** | `requireAdmin` server-side stays. Client action buttons + gating relocated verbatim. New tab/drawer controls are presentational. |

---

## 2. CONFIRMED CURRENT-STATE FINDINGS (audit, cited)

These are facts the refactor must respect, not optional context.

- **F1 — Eager masonry.** The detail region (`admin.html:11202`, `<div id="bookingDetail-${row.id}" class="atl-detail-region">`) renders ~14 cards in a two-column grid (`atl-det-grid` → `atl-det-col`), all built up front in the `renderBookingsTable` template string through ~line 11640.
- **F2 — Multi-open today.** Each booking card (`.atl-booking-card[data-id]`) owns its own `.atl-detail-region`, and every element id is suffixed with `${row.id}`, so several rows can be expanded at once. **DG-1** decides whether this survives.
- **F3 — Open orchestration + once-only guard.** `window.toggleBookingDetail(bookingId, forceOpen)` (`admin.html:7852`) fires `/notes` and `/communications` on **every** open, but gates the heavy `Promise.all([/details, /quote-history, /contract])` behind `$region.data('loaded')` (`:7887`). Re-routing to tabs MUST preserve a once-only guard per resource, or you will double-fetch on every tab switch.
- **F4 — Class-delegated actions.** Action controls are bound by delegation on stable classes with `data-id`: `bk-action-quote`, `bk-action-gen-invoice`, `bk-action-send-invoice`, `bk-action-resend-quote`, `bk-venue-edit-btn` / `-save-btn` / `-cancel-btn`, `bk-unlink-venue-btn`, `bk-link-venue-google-btn`, `bk-notes-load-btn`, `bk-add-note-btn`, `bk-delete-note-btn`, `bk-comms-load-btn`, `bk-save-buffer-btn`, `promote-toggle`, `bk-view-client-history`, `bkr-promote-ticket-save`. Relocation is safe **only** if the class + `data-id` are preserved and the delegation root still contains the moved node.
- **F5 — Google Places re-init.** `initBookingVenueAutocomplete(bookingId)` (`admin.html:7867`) runs on open to wire venue-link autocomplete. It must re-run whenever the **Overview** panel (venue card) mounts.
- **F6 — `switchTab` collision.** `window.switchTab(sectionId)` (`admin.html:15798`) is the admin-section navigator. The new tab controller must not reuse this name (see Rule 7).
- **F7 — Out-of-scope note.** The detail renders `budget_range` (`admin.html:11268`) though the public form never collects it (dead field). **Do not fix here** — flagged only so you don't mistake the empty state for a bug.

---

## 3. NON-NEGOTIABLE CONSTRAINTS (the fence)

- No edits to `server.js`, `database.js`, or any route/middleware.
- No edits to `requireAdmin` or any role-gating logic.
- Preserve all ids, `data-id`s, classes, and delegated handlers on relocated controls (F4).
- Reuse existing render helpers unchanged: `formatQuoteDetailsAtelier` (`admin.html:11501`), `formatInvoiceDetailsAtelier` (`:11514`), `renderNotesThread`, `renderCommsThread`, and the line-items builder inside `toggleBookingDetail` (`:7898+`).
- `--atl-*` tokens only; both dark and light themes must render correctly.
- Full keyboard operability and visible focus; respect `prefers-reduced-motion`; mobile-first (drawer/tab bar behave at ≤640px).

---

## 4. DECISION GATES (require Muzi's sign-off before Phase 2)

| ID | Decision | Options | Recommendation |
|---|---|---|---|
| **DG-1** (primary) | Container model | **A. Inline tabs** — keep `.atl-detail-region`, drop a tab bar + panels inside it. · **B. Drawer** — one shared right-side drawer, one deal open at a time. | **B (Drawer).** Cleaner with tabs; the tab strip stays pinned; no table-jump. Trade-off: loses multi-booking side-by-side (F2). |
| **DG-2** | Tab set + order | The six tabs above. | Accept. **Advancing ships as a stub** (empty state + ghost sketch), no endpoint. |
| **DG-3** | Multi-open behavior | Keep multiple bookings open (only viable with A) · Single-open. | **Single-open** (follows from B). |
| **DG-4** | Lazy-load timing | Load-on-tab-activation · Eager-on-open. | **Load-on-tab-activation** — Offer tab fetches contract/quote-history on first open; Timeline fetches notes/comms on first open; Overview is instant from `/details`. |

Phase 2 below is written for the **recommended path (B + single-open + tab-activated loads)**. Fork points where Option A differs are marked ⑃.

---

## 5. PHASED TASKS

### Phase 0 — Tokens & CSS scaffolding (no behavior change)
Add classes for the tab bar, drawer shell, overlay, and panels, driven entirely by `--atl-*`. Mirror the mockup's `.dv-*` treatment. Add any missing tokens to **both** theme blocks. No markup wired yet.

### Phase 1 — Extract cards into panel builders (no behavior change)
Refactor the detail template so each current card becomes a small pure function returning its existing HTML **verbatim** (same classes, ids, `data-id`s). Group them into six panel builders. **Distribution map:**

| Panel | Cards relocated (current anchors) |
|---|---|
| **Overview** | Client (`11208`), Event + travel buffer (`11221`/`11240`), Audience & Budget (`11262`), Ledger snapshot (`11278`), Venue linked/unlinked (`11300`), Public Promotion (`11367`) |
| **Offer & Contract** | Quote (`11498`, via `formatQuoteDetailsAtelier`), Contract lazy card (`11436`) |
| **Invoices & Payments** | Invoice (`11511`, via `formatInvoiceDetailsAtelier`), plus the payment/ledger detail from `/details` |
| **Advancing** | **New stub** (Phase 5) |
| **Timeline & Notes** | Client message (`11457`), Internal Notes lazy (`11526`), comms thread (`bk-comms-load-btn`) |
| **Files** | Attachments (`11473`) + generated quote/contract/invoice PDFs as file chips |

Verify F4: every moved control keeps class + `data-id`. Do not touch handler bindings.

### Phase 2 — Container (recommended: Drawer) ⑃
Add **one** shared shell near the end of `#bookingsAdmin` markup:
```html
<div class="dv-overlay" id="dealViewOverlay" hidden></div>
<aside class="dv-drawer" id="dealViewDrawer" role="dialog" aria-modal="true"
       aria-labelledby="dvTitle" hidden>
  <header class="dv-head" id="dvHead"><!-- title, status, chips, actions, tab bar injected here --></header>
  <div class="dv-body" id="dvBody"><!-- active panel injected here --></div>
</aside>
```
Rewrite `toggleBookingDetail(bookingId, forceOpen)` to: resolve the booking row → render header + panels into the drawer → slide in (`.open`) → set focus to the drawer, trap focus within it, and restore focus to the triggering row on close. Close on the overlay click, the header close button, and `Esc`. Preserve F3's once-only guard by keying loaded-state per booking (e.g. a module map, not `$region.data`).
**⑃ Option A:** skip the drawer shell; inject the tab bar + panels inside the existing `.atl-detail-region`; keep multi-open; no focus trap.

### Phase 3 — Tab controller (`dvActivateTab`)
Implement the ARIA tabs pattern, mirroring the working `.cal-sidebar-tab role="tab"` example (`admin.html:5140`):
- `role="tablist"` container; each tab `role="tab"` with `aria-selected`, `aria-controls`, and `tabindex` 0 (active) / -1 (inactive); each panel `role="tabpanel"` `aria-labelledby`, `hidden` when inactive.
- Keyboard: `←/→` move + activate, `Home`/`End` jump, click activates. Focus follows selection. Reset `dvBody` scroll on switch.
- Function name **must** be `dvActivateTab` (or similar) — never `switchTab` (F6).

### Phase 4 — Route lazy loads to tab activation (DG-4)
- **Overview:** render instantly from the `/details` payload already fetched on open; re-run `initBookingVenueAutocomplete(bookingId)` when the venue card mounts (F5).
- **Offer & Contract:** on first activation, fetch `/contract` + `/quote-history` (reuse existing parsing), then mark loaded.
- **Timeline & Notes:** on first activation, fetch `/notes` (→ `renderNotesThread`) + `/communications` (→ `renderCommsThread`), then mark loaded.
- **Invoices, Files:** render from `/details`; no extra fetch.
Guard each so re-activating a tab does not re-fetch (F3).

### Phase 5 — Advancing tab
**If Part II is in scope (recommended), skip the stub and build the real panel per Part II §5 — it replaces this phase.** Only if Part I ships alone: render a presentational stub (empty state `No advancing pack yet` + non-wired "Start advancing pack" button, plus the ghosted section sketch), no endpoint, no schema, reserving the slot.

### Phase 6 — Cleanup
Remove the now-dead two-column masonry wrapper and any orphaned markup. Grep-confirm no handler class or `data-id` was dropped. Confirm `renderBookingsTable` still renders the list rows unchanged.

---

## 6. ACCEPTANCE CRITERIA

- [ ] Opening a booking shows the Deal View with header (breadcrumb, title, status + payment badges, chips, action buttons) and the six-tab bar.
- [ ] All six tabs switch by click and by `←/→`/`Home`/`End`; correct `aria-selected`/`hidden`/focus at all times.
- [ ] Every card renders in its assigned tab with identical data to the pre-refactor detail.
- [ ] Prepare Quote, Generate/Send Invoice, Resend Quote, add/delete Note, load Comms, link/unlink/edit Venue, save Buffer, Promote toggle, ticket-save, view-client-history all still fire (delegation intact).
- [ ] No fetch fires more than once per resource per open (F3 preserved).
- [ ] Google Places venue autocomplete works after opening the Overview tab (F5).
- [ ] `window.switchTab` section navigation is unaffected (F6).
- [ ] Both themes render correctly; zero hardcoded hex introduced.
- [ ] Drawer (Option B): focus moves in on open, is trapped, returns to the row on close; `Esc` and overlay close it.
- [ ] Keyboard-only path complete; visible focus; `prefers-reduced-motion` respected; usable at ≤640px.

---

## 7. TEST MATRIX

**Normal**
- Open `CONFIRMED` deposit-paid booking → Overview populated → cycle all tabs → Offer shows quote + signed contract → Invoices shows invoice + schedule + txn → Timeline shows activity + notes → Files lists PDFs.
- Prepare a quote from the Offer tab → existing quote flow runs unchanged.
- Add a note from Timeline → persists and re-renders.

**Edge**
- Booking with **no** quote / no contract / no invoice / no notes / no attachments → each tab shows its empty state, no errors.
- `CANCELLED` booking → cancellation detail still surfaces; Advancing/promotion cards suppressed as before.
- `NEW`/`PENDING` booking (no financials) → Invoices/Offer show empty states.
- Very long client message and long venue notes → layout holds, no overflow.
- Booking with `amount_outstanding = 0` → ledger shows positive/zero styling.

**Failure**
- `/details` returns 500 → `notificationService.showError` fires, drawer still opens with whatever rendered; no console-swallow.
- `/contract` or `/notes` rejects → that tab shows a load-failure state, other tabs unaffected.
- Offline mid-session → tab switch that needs a fetch surfaces an error, does not hang.

**Regression**
- Multiple bookings opened in sequence → correct data each time; no stale `data-id` bleed.
- `window.switchTab` between admin sections still works; returning to Bookings re-renders the list.
- List-level controls (status filter, search, sort) unaffected.
- Keyboard nav, theme toggle, mobile full-width drawer, reduced-motion all pass.
- Grep check: every F4 handler class + `data-id` still present post-refactor; no duplicate element ids.

---

## Appendix — anchor index (Part I)
- List renderer: `renderBookingsTable` `admin.html:10922–11640`
- Detail region open: `#bookingDetail-${id}` `admin.html:11202`; row element `.atl-booking-card[data-id]`
- Open/close orchestration: `toggleBookingDetail` `admin.html:7852` (once-only guard `:7887`; venue autocomplete `:7867`)
- Card anchors: Client `11208` · Event/buffer `11221`/`11240` · Audience&Budget `11262` · Ledger `11278` · Venue `11300` · Promotion `11367` · Contract(lazy) `11436` · Cancellation(lazy) `11446` · Message `11457` · Attachments `11473` · Quote `11498` · Invoice `11511` · Notes(lazy) `11526`
- Render helpers: `formatQuoteDetailsAtelier` `11501` · `formatInvoiceDetailsAtelier` `11514` · line-items builder `7898+`
- Shared: `apiCall` `10310` · `window.switchTab` `15798` · ARIA tab pattern `.cal-sidebar-tab` `5140`
- Tokens: `admin.html:730–840`
- Backend (unchanged): `requireAdmin` `server.js:1229`; `/details` `server.js:6075`

---

# ══════════ PART II — ADVANCING PACK (full-stack) ══════════

**Feature:** Build the show-day operations pack — run-of-show, technical, hospitality, contacts, travel — editable in the Deal View's **Advancing** tab, exportable to PDF, and sendable to the client and venue. This is the one capability the platform does not currently have.
**Scope:** Full-stack — `database.js` (new tables), `server.js` (new routes), `admin.html` (fills the Advancing tab from Part I). **Depends on Part I** for the tab slot.
**Why it's needed (audit):** `run-of-show`, `technical rider`, `settlement`, `soundcheck` → **0 hits** across `server.js` / `admin.html` / `database.js`. "Advancing" in the code only ever means advance-notice (`MIN_ADVANCE_HOURS`, `server.js:3681`) or advancing pipeline status. The only show-day data held is `venues.green_room_notes` / `load_in_time`, shown read-only in the booking detail (`admin.html:13365`). No run-of-show builder, no structured tech/hospitality/contacts pack, nothing to send to a venue.

---

## 0. PROMPT RULES — Part II additions
All Part I rules apply. Plus:
1. **Idempotent migrations only.** New tables via `CREATE TABLE IF NOT EXISTS`; any later column via the existing `PRAGMA table_info` → `ALTER TABLE … ADD COLUMN` failsafe pattern already used throughout `database.js` (e.g. `:69`, `:536`). Never a destructive migration.
2. **New routes are `requireAdmin`.** Mirror the existing admin route signature (`server.js:1229`). No public exposure.
3. **Reuse, don't reinvent, document generation.** PDF goes through `pdfService.generateDocument(type, booking, items, pdfPath)` — the exact function used for `'Quote'` (`server.js:7107`) and `'Invoice'` (`:924`). See dependency **BS-1**.
4. **POPIA.** The send step transmits personal contact data to a third party (the venue). It must respect the platform's existing consent/policy framework — reuse the same handling applied to other outbound client communications; do not build a parallel path.

---

## 1. FULL-STACK IMPACT ANALYSIS

| Layer | Impact | Detail |
|---|---|---|
| **Database** | **New** | 3 tables: `advancing_packs` (1:1 booking), `run_of_show_items` (N per pack), `advancing_contacts` (N per pack, extras only). Idempotent. |
| **Backend / API** | **New** | ~9 `requireAdmin` routes (§5 Phase 2). PDF via existing `pdfService` (BS-1). Send via existing `send…Email` helper pattern (BS-2). |
| **Frontend** | **Fills Part I's Advancing tab** | Sub-sectioned editor (Run-of-Show / Technical / Hospitality / Contacts / Travel / Notes), editable ROS rows, PDF preview, send + confirm. Replaces Part I Phase 5 stub. |
| **Security / RBAC** | **Untouched** | `requireAdmin` reused verbatim. No middleware edits. |
| **External deps** | **Blocking (2)** | `pdfService.js` and `js/emailService.js` + `js/emailTemplates.js` — not auditable; see §2. |

---

## 2. CONFIRMED CURRENT-STATE FINDINGS (audit, cited)

**What the pack builds on (verified present):**
- **P1 — Venue link is real.** `bookings.venue_id` is an indexed column (`database.js:536`, index `:1181`); link routes `PUT /venue` (`server.js:5913`), `/venue-google` (`:5997`), `PATCH /venue` (`:6761`). The pack pre-fills show-day data from the linked venue.
- **P2 — Venue carries show-day fields.** `venues` has `contact_name`, `contact_phone`, `contact_email`, `capacity`, `load_in_time`, `green_room_notes`, `negotiated_rates` (`database.js:562`). These seed the Technical/Hospitality/Contacts sections.
- **P3 — Four contact sources already exist.** Client → `bookings.name/email/cell`; Venue tech → `venues.contact_*`; Artist → `comedians` (`stage_name/legal_name/email/phone`, `database.js:586`); Manager → `manager_details` (`name/cell_number/whatsapp_number/email`, `database.js:323`). Contacts auto-source from these; `advancing_contacts` is only for extras (stage manager, driver).
- **P4 — PDF call pattern.** `pdfService.generateDocument('Quote'|'Invoice', booking, items, pdfPath)` (`server.js:924, 7107`); output written under `docs/` and stored as a `file_path`/`pdf_url`. `pdfkit` is also required directly (`server.js:13`).
- **P5 — Attachment/dir pattern.** `bookingAttachUpload` multer writes to `docs/booking_attachments` (`server.js:403`). Pack PDFs follow the same `docs/…` convention.
- **P6 — Send pattern.** Outbound mail uses named helpers (e.g. `sendPendingExpiredEmail`, `sendQuoteExpiredEmail`, `server.js:1087,1101`) that wrap the email layer.

**Blocking dependencies (not auditable — provide to finalise):**
- **BS-1 — `pdfService.js` not in the mount.** The call signature is known from its call sites, but its implementation isn't. It must be extended to render an `'Advancing'` document type. The route can be written against `pdfService.generateDocument('Advancing', booking, packData, pdfPath)`, but the template inside `pdfService.js` cannot be specified until the file is provided. **Decision Gate DG-A2.**
- **BS-2 — `js/emailService.js` + `js/emailTemplates.js` not in the mount** (`require`d at `server.js:8,11`). The send step needs a new `sendAdvancingPackEmail(...)` helper + a new Atelier-styled template. Build the route and the frontend Send control now, but leave the send **disabled** until these are audited. **Decision Gate DG-A3.**

---

## 3. NON-NEGOTIABLE CONSTRAINTS (Part II)
- Preserve every Part I hook; the Advancing panel mounts inside the Part I tab without altering other panels.
- No edits to `pdfService.js` or the email layer are specified blind — those extensions are deferred behind BS-1 / BS-2.
- All new UI uses `--atl-*` tokens; both themes render.
- Every `catch` → `notificationService.showError()` + `console.error()`.
- All authenticated fetches use `apiCall()` (`admin.html:10310`).
- Run-of-show reordering persists server-side; the editor never trusts client order for the PDF.

---

## 4. DECISION GATES (Part II)

| ID | Decision | Options | Recommendation |
|---|---|---|---|
| **DG-A1** | Structured columns vs. JSON for Technical/Hospitality/Travel | A. Discrete columns (queryable, matches `services` style) · B. JSON blobs | **A**, with `internal_notes` as the free-text escape hatch. |
| **DG-A2** | PDF (BS-1) | Extend `pdfService.js` for `'Advancing'` · Defer | **Extend** once `pdfService.js` is provided. Route ships against the known signature meanwhile. |
| **DG-A3** | Send (BS-2) | New `sendAdvancingPackEmail` + template · Defer | **Build route + disabled UI now**, finalise send when email layer is provided. |
| **DG-A4** | When is the pack available? | From `ACCEPTED` · From `CONFIRMED` | **CONFIRMED** — show-day planning follows confirmation; earlier stages show a "confirm the booking first" empty state. |
| **DG-A5** | Contacts persistence | Auto-source live + snapshot into PDF at send · Persist all into `advancing_contacts` | **Auto-source live for editing; snapshot into the PDF at send** (so the sent pack is immutable even if a source record later changes). |

Phase tasks below assume the recommended options.

---

## 5. PHASED TASKS

### Phase 1 — Schema (`database.js`, idempotent)
Add in the existing serialize flow, following the surrounding `CREATE TABLE IF NOT EXISTS` + failsafe-`ALTER` pattern:

```sql
CREATE TABLE IF NOT EXISTS advancing_packs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id INTEGER NOT NULL UNIQUE,
  status TEXT DEFAULT 'draft' CHECK(status IN ('draft','sent','confirmed')),
  -- Technical
  mic_type TEXT, pa_spec TEXT, monitors TEXT, lighting TEXT,
  stage_layout TEXT, equipment_responsibility TEXT,
  -- Hospitality
  green_room_notes TEXT, meals TEXT, dietary TEXT, parking_wifi TEXT,
  -- Travel & accommodation
  travel_type TEXT, flights TEXT, hotel TEXT, ground_transport TEXT,
  -- Meta
  internal_notes TEXT, pdf_url TEXT,
  sent_to_client_at DATETIME, sent_to_venue_at DATETIME, confirmed_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (booking_id) REFERENCES bookings(id)
);

CREATE TABLE IF NOT EXISTS run_of_show_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pack_id INTEGER NOT NULL,
  sort_order INTEGER DEFAULT 0,
  time_label TEXT,           -- '18:30'
  duration_minutes INTEGER,
  title TEXT NOT NULL,       -- 'Doors open', 'Thabiso set'
  detail TEXT,
  responsible TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (pack_id) REFERENCES advancing_packs(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_ros_pack ON run_of_show_items(pack_id);

CREATE TABLE IF NOT EXISTS advancing_contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pack_id INTEGER NOT NULL,
  role TEXT, name TEXT, phone TEXT, email TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (pack_id) REFERENCES advancing_packs(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_advcontacts_pack ON advancing_contacts(pack_id);
```
`travel_type` is validated in the route layer (`local`/`out_of_town`/null) rather than a CHECK, to keep the failsafe-ALTER path clean.

### Phase 2 — Backend routes (`server.js`, all `requireAdmin`)
- `GET  /api/admin/bookings/:id/advancing` — returns the pack (or a **pre-filled draft skeleton** built from the linked venue P2 + auto-sourced contacts P3 when no row exists yet), its `run_of_show_items` (ordered by `sort_order`), and `advancing_contacts`. Gate on booking status ≥ `CONFIRMED` (DG-A4).
- `PUT  /api/admin/bookings/:id/advancing` — upsert the pack header (insert row if none; `updated_at = CURRENT_TIMESTAMP`). Validate `travel_type`.
- `POST /api/admin/bookings/:id/advancing/run-of-show` — add a ROS item (append `sort_order`).
- `PUT  /api/admin/advancing/run-of-show/:itemId` — edit an item.
- `DELETE /api/admin/advancing/run-of-show/:itemId` — delete an item.
- `PUT  /api/admin/bookings/:id/advancing/run-of-show/reorder` — persist `{ orderedIds: [...] }` → rewrite `sort_order`.
- `POST /api/admin/bookings/:id/advancing/contacts` · `DELETE /api/admin/advancing/contacts/:contactId` — extra contacts.
- `POST /api/admin/bookings/:id/advancing/pdf` — assemble pack + ordered ROS + snapshotted contacts (DG-A5) → `pdfService.generateDocument('Advancing', booking, packData, pdfPath)` → store `pdf_url`. **[BS-1 / DG-A2]**
- `POST /api/admin/bookings/:id/advancing/send` — regenerate/attach PDF, call `sendAdvancingPackEmail(client, venueContact, pdfPath)`, set `sent_to_client_at` / `sent_to_venue_at`, `status='sent'`. **Block if the linked venue has no `contact_email`**, returning a clear message. **[BS-2 / DG-A3 — leave the send helper stubbed + the button disabled until the email layer is provided.]**
- `POST /api/admin/bookings/:id/advancing/confirm` — `status='confirmed'`, `confirmed_at`.

### Phase 3 — Frontend Advancing panel (`admin.html`, replaces Part I Phase 5)
Mount inside the Part I Advancing tab. Sub-section the panel (a lightweight inner nav or stacked sections) per the source spec §6.5:
- **Run-of-Show** — editable rows: time · duration · title · detail · responsible; add / delete / reorder (up-down buttons minimum; drag optional). Persist via the routes above; PDF uses server order.
- **Technical** — fields bound to `mic_type / pa_spec / monitors / lighting / stage_layout / equipment_responsibility`.
- **Hospitality** — `green_room_notes` (show a "pre-filled from venue" hint when sourced from P2) / `meals / dietary / parking_wifi`.
- **Contacts** — the four auto-sourced contacts rendered read-only with their origin labelled; plus add/remove extras (`advancing_contacts`).
- **Travel & Accommodation** — `travel_type` toggle · `flights / hotel / ground_transport`.
- **Notes** — `internal_notes`.
- **Actions bar** — Save draft · Preview PDF · **Send to Client & Venue** (disabled with an explanatory tooltip until BS-2) · Mark Confirmed. Status badge reflects `draft/sent/confirmed`.
All fetches via `apiCall()`; every `catch` → `notificationService.showError()` + `console.error()`; `--atl-*` tokens only. Empty states use interface-voice direction (e.g. venue-missing → "Link a venue to auto-fill contacts and load-in.").

---

## 6. ACCEPTANCE CRITERIA (Part II)
- [ ] For a `CONFIRMED` booking, opening the Advancing tab shows a pack pre-filled from the linked venue (load-in, green room, venue contact) and the four auto-sourced contacts.
- [ ] Run-of-show rows add / edit / delete / reorder and persist across reload; the generated PDF respects the saved order.
- [ ] Technical / Hospitality / Travel / Notes fields save and reload correctly.
- [ ] Extra contacts add and remove; auto-sourced contacts are read-only and correctly labelled.
- [ ] Preview PDF produces a document via `pdfService` and stores `pdf_url` (once BS-1 provided).
- [ ] Send is disabled with a clear tooltip until BS-2 is provided; once wired, it sets the sent timestamps, flips status to `sent`, and blocks when the venue has no contact email.
- [ ] Mark Confirmed sets `confirmed_at` and `status='confirmed'`.
- [ ] Pre-`CONFIRMED` bookings show the "confirm first" empty state, not an editor.
- [ ] Migrations are idempotent (re-run safe); no other table altered.
- [ ] Both themes render; zero hardcoded hex; all fetches via `apiCall`; all catches surfaced.

---

## 7. TEST MATRIX (Part II)

**Normal** — Confirmed booking with linked venue → pack pre-fills → add three ROS rows, reorder → save Technical/Hospitality → add a driver contact → Preview PDF renders in order → Mark Confirmed flips status.

**Edge** — Booking with **no linked venue** → contacts/hospitality show empty states + link prompt; send blocked. · Pack with **zero ROS rows** → PDF still generates (header + sections). · Very long ROS detail / notes → layout holds. · Reorder a single-row list → no-op, no error. · Duplicate confirm → idempotent.

**Failure** — `pdfService` throws (BS-1 not yet extended) → `notificationService.showError`, no partial `pdf_url` written. · `/advancing` GET 500 → tab shows load-failure state, other Deal View tabs unaffected. · Send attempted with no venue email → 4xx with a clear message, no timestamps set. · Reorder request drops mid-flight → order unchanged server-side.

**Regression** — Part I tabs and all relocated action handlers still fire. · `bookings.venue_id` link/unlink (Part I venue card) still works and now also drives pack pre-fill. · Existing Quote/Invoice PDF generation via `pdfService` unaffected by the new `'Advancing'` type. · `requireAdmin` behaviour unchanged on all new routes. · Idempotent migration re-run on an existing DB adds nothing and errors nowhere.

---

## Appendix — anchor index (Part II)
- Absence confirmed: `run-of-show` / `technical rider` / `settlement` / `soundcheck` → 0 hits
- Venue link: `bookings.venue_id` `database.js:536` (index `:1181`); routes `server.js:5913 / 5997 / 6761`
- Venue show-day fields: `venues` `database.js:562`; read-only surface `admin.html:13365`
- Contact sources: `comedians` `database.js:586` · `manager_details` `database.js:323` · booking client fields · `venues.contact_*`
- PDF: `pdfService.generateDocument` `server.js:924, 7107`; `pdfkit` `server.js:13` — **file not in mount (BS-1)**
- Send helpers pattern: `server.js:1087, 1101`; email layer `require` `server.js:8, 11` — **files not in mount (BS-2)**
- Attachment dir pattern: `bookingAttachUpload` `server.js:403`
- Migration/failsafe pattern: `database.js:69, 536`
- Backend RBAC: `requireAdmin` `server.js:1229`
