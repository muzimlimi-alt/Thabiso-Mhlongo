# AI Agent Prompt: Convert the Events Section to Inline Expandable Event Cards (Atelier Obsidian)

---

## OBJECTIVE

Redesign the **Events section (`#eventsAdmin`) in `admin.html`** so it abandons the current two-panel split — a left-hand **"Manage Event"** form (`.col-md-5`) and a right-hand **"Current Event Items"** list (`.col-md-7`) — and adopts the **inline expandable-card pattern already used by the Bookings section**.

Every event in the list becomes a self-contained, collapsible card. Clicking a card expands it (accordion behaviour) and reveals the **full event editor inline, directly beneath that event**, so an administrator can view, edit, update, and delete an event without scrolling to a separate panel and losing visual context of which event they are editing. Collapsed cards sit **two-up on desktop and stack on mobile**; the **expanded card spans the full width** to give the editor room.

**This is a front-end structural + styling refactor only.** No database schema, no API route, no payload shape, and no business logic changes. Every JavaScript-bound `id`, `data-*` attribute, function, and event handler listed in Section 2 must survive verbatim.

> ⚠️ **Read Section 3 before writing any code.** The naïve approach — giving every card its own copy of the form fields — is **forbidden** and will break the build, because the editor's inputs are bound by unique `id`s (`#eventsTitle`, `#eventsDate`, …), a single flatpickr instance, and a single submit handler. The mandated architecture is a **single shared editor that is *moved* into the active card.**

---

## 1. FULL-STACK IMPACT ANALYSIS (verified against the codebase)

Before implementation, every layer is accounted for. Findings are grounded in the actual files, not assumed.

### Database layer — **NO CHANGE**
The `events` table is used exactly as defined. No new columns, no migrations, no renames.

| Column (from `database.js` ~L368–395) | Used by the editor as |
|---|---|
| `event_id` (PK, AUTOINCREMENT) | `#eventsId` (hidden) — drives create vs. update |
| `event_title` (NOT NULL) | `#eventsTitle` |
| `event_description` | `#eventsDesc` |
| `event_datetime` | `#eventsDate` (flatpickr) |
| `venue_name` | `#eventsVenue` |
| `venue_map_link` | `#eventsVenueMapLink` |
| `ticket_sales_link` | `#eventsTicketUrl` |
| `poster_image_path` | `#eventsFile` upload → `#eventsFallbackUrl` |
| `event_status` (default `'upcoming'`) | `#eventsStatus` (`upcoming` / `draft`) |
| `google_calendar_event_id` | GCal badge/link |
| `bookings.event_id` (FK → `events.event_id`) | "Linked to Booking" badge / `#eventsBookingId` |

Relationships preserved: **Event → Booking** (via `bookings.event_id`). No duplication is introduced — there is still exactly one create path and one update path.

### Backend layer — **NO CHANGE**
All event routes remain untouched and continue to be gated server-side:

| Route (`server.js` ~L7577–7686) | Method | Guard |
|---|---|---|
| `/api/admin/events` | `GET` | `requireAdmin` |
| `/api/admin/events` | `POST` | `requireAdmin` |
| `/api/admin/events/:id` | `PUT` | `requireAdmin` |
| `/api/admin/events/:id` | `DELETE` | `requireAdmin` |

The booking pipeline (enquiry → quoted → confirmed → completed → paid), pricing, invoices, availability/conflict logic, and `server.js` are **strictly out of scope**. Event status is still validated server-side exactly as today; the front end is not granted any new authority.

### Frontend layer — **ALL CHANGES LIVE HERE**
1. Replace the `.row` / `.col-md-5` + `.col-md-7` structure inside `#eventsAdmin` with a single accordion-card layout.
2. Re-template `renderEventsList()` to emit Atelier accordion cards instead of `.um-item-card` summary rows.
3. Introduce **one** editor controller that *moves* the single `#eventsForm` between a top "create dock" and the active card's mount point.
4. Add accordion CSS (reusing the existing `.atl-booking-card` / `.atl-detail-region` system) + a responsive card grid.
5. Re-point existing deep-links (calendar popup "Edit Event", global search) to *open and expand the matching card* rather than scroll to the old form.

### Security / role layer — **NO CHANGE**
Authentication and ADMIN/MANAGER enforcement already live on the backend (`requireAdmin`). Nothing in this refactor moves trust to the client. No private client data, internal pricing, or financial logic is exposed (events carry none).

### End-to-end data flow — **PRESERVED**
```
Admin edits inline → existing #eventsForm submit handler → existing PUT/POST
→ SQLite (events) → JSON response → renderEventsList() re-render → cards reflect change
```
This is the identical pipeline that runs today; only the *location* of the form in the DOM changes.

---

## 2. NON-NEGOTIABLE RULES

1. **Exactly ONE `#eventsForm` and ONE of each `id="events*"` in the DOM at all times.** Duplicating the editor markup per card is forbidden — it produces duplicate IDs, a second flatpickr that never initialises, and a submit handler bound to the wrong node. (See Section 3 for the sanctioned mechanism.)
2. **Do not rename, remove, or duplicate any of these JS hooks** (verified present in `admin.html`):
   - **Form + fields:** `#eventsForm`, `#eventsId`, `#eventsTitle`, `#eventsDesc`, `#eventsFile`, `#eventsTicketUrl`, `#eventsDate`, `#eventsVenue`, `#eventsVenueSearch`, `#eventsVenueMapLink`, `#eventsStatus`, `#eventsFallbackUrl`, `#eventsBookingId`, `#eventsBlockType`, `#eventsSubmitBtn`
   - **Conditional UI:** `#eventsConflictResolutionGroup`, `#eventsLinkedBookingBadge`, `#eventsLinkedBookingLink`, `#eventsGcalSync`, `#eventsGcalLinkBadge`, `#eventsGcalLink`, `#eventVideoWarning`
   - **List containers:** `#adminUpcomingEventsList`, `#adminPastEventsList`, `#clearEventsBtn`
   - **Action hook classes:** `.edit-events-action` (carries `data-payload`), `.remove-events-action` (carries `data-id`)
   - **Functions/handlers:** `renderEventsList()`, `getEventsData()`, the `$(document).on('click', '.edit-events-action', …)` handler, the `$(document).on('click', '.remove-events-action', …)` handler, the `$('#eventsForm').on('submit', …)` handler, and the **flatpickr init on `#eventsDate`** (currently `flatpickr("#eventsDate", {…})`).
3. **Do not touch the request payload.** The submit handler must keep sending `{ event_title, event_description, event_datetime, venue_name, venue_map_link, ticket_sales_link, poster_image_path, event_status, booking_id, block_type, sync_to_gcal }` unchanged.
4. **No backend, no `server.js`, no `database.js`, no schema.** Visual/structural front-end only.
5. **Every colour references a CSS variable** from the Atelier token system (`--atl-*`). No new hardcoded hex values. Where you relocate existing inline styles, keep their variable references intact.
6. **Mobile-first.** Author base styles for the smallest viewport (≥0px), then add `@media (min-width: …)` upward. Never write desktop-first and compress.
7. **Preserve all existing behaviour:** poster upload (label-wrapped `#eventsFile`), 30-minute time validation, video-URL warning, GCal sync toggle/badge, linked-booking conditional (`#eventsConflictResolutionGroup` hidden when `booking_id` present), draft/upcoming status, delete confirmation modal, the "Clear All Events" button.
8. **Validate the rendered DOM before submitting.** Open at least one card, confirm the editor mounts, edits save, and re-render restores a clean collapsed state.

---

## 3. MANDATED ARCHITECTURE — "Single shared editor, docked into context"

The editor (`#eventsForm`) is treated as **one movable node**. It lives in one of two places at any moment:

- **Create dock** — a new collapsible region `#eventsCreateDock` at the top of the section. This is the editor's *home*. At page load the form sits here, dock collapsed.
- **An event card's mount point** — each rendered card contains an empty `<div class="evt-form-mount"></div>` inside its detail region. When a card is opened for editing, the form is moved here.

Because **only one card is open at a time** and there is only one create dock, the single `#eventsForm` is never cloned — it is **detached and re-appended** (jQuery `.detach()` / `.appendTo()`), which preserves the node, all bound listeners, the live flatpickr instance, and any selected file. This is what makes Rule 1 satisfiable.

### Why `.detach()`/move is safe (do not use `.clone()` or innerHTML)
- The `#eventsForm` submit handler is bound directly to the node → travels with it.
- `.edit-events-action` / `.remove-events-action` handlers are **delegated on `document`** → unaffected by where the form lives.
- flatpickr stores its instance on the `#eventsDate` element and renders its calendar on `<body>`; moving the input re-positions the calendar on next open. **Do not re-init flatpickr** — that would create a second instance.

### The controller (add this; names are suggestions, keep them consistent)

```js
// The form's safe home. Must exist in the markup (Section 6, Task 1).
function eventEditorHome() { return document.getElementById('eventsCreateDock'); }

// Move the single #eventsForm into a target element (detach preserves listeners + flatpickr).
function mountEventEditor(targetEl) {
    if (!targetEl) return;
    $('#eventsForm').detach().appendTo(targetEl);
}

// Collapse every open event card and re-dock the form to its home.
function collapseAllEventCards({ redock = true } = {}) {
    $('.atl-event-card .atl-detail-region.open').removeClass('open');
    $('.atl-event-card .atl-expand-btn[aria-expanded="true"]')
        .attr('aria-expanded', 'false');
    if (redock) mountEventEditor(eventEditorHome());
}

// Open ONE card for editing. forceOpen mirrors window.toggleBookingDetail's contract.
window.toggleEventCard = function (eventId, forceOpen) {
    const $card   = $(`.atl-event-card[data-id="${eventId}"]`);
    if (!$card.length) return;
    const $region = $card.find('.atl-detail-region');
    const $btn    = $card.find('.atl-expand-btn');
    const isOpen  = $region.hasClass('open');
    const next    = (forceOpen !== undefined) ? forceOpen : !isOpen;
    if (next === isOpen) return;

    if (next) {
        collapseAllEventCards({ redock: false }); // exclusivity: close any other open card
        $('#eventsCreateDock').removeClass('open'); // also close the create dock
        $region.addClass('open');
        $btn.attr('aria-expanded', 'true');
        // Populate the moved form using the SAME logic as the existing edit handler.
        mountEventEditor($region.find('.evt-form-mount')[0]);
        populateEventEditorFromCard(eventId); // see note below
    } else {
        $region.removeClass('open');
        $btn.attr('aria-expanded', 'false');
        mountEventEditor(eventEditorHome()); // park the form back home on collapse
    }
};
```

### Reusing the existing populate logic (do not rewrite field mapping)
The current `.edit-events-action` handler already contains the complete, correct field-population block (`$('#eventsId').val(item.event_id)`, the flatpickr datetime conversion, the linked-booking conditional, the GCal badge, the submit-button label swap). **Extract that block into a function** so both the card-expand flow and any legacy deep-link can call it:

```js
function applyEventToEditor(item) {
    // ⟵ move the EXISTING body of the .edit-events-action handler here, UNCHANGED,
    //    except: remove the final scrollTo/$("#eventsAdmin").animate(...) lines
    //    (the form is now already visible inside the open card).
}
// The card template stores its row as data-payload (same encoding as today),
// so the card-expand path can read it:
function populateEventEditorFromCard(eventId) {
    const payload = $(`.atl-event-card[data-id="${eventId}"]`).attr('data-payload');
    if (payload) applyEventToEditor(JSON.parse(decodeURIComponent(payload)));
}
// Keep the delegated handler working for backwards-compatible deep-links:
$(document).on('click', '.edit-events-action', function (e) {
    e.preventDefault();
    const id = $(this).data('id');               // ensure the card template adds data-id here
    if (id) { window.toggleEventCard(id, true); $('html,body').animate({ scrollTop: $(`.atl-event-card[data-id="${id}"]`).offset().top - 70 }, 400); }
});
```

### The "Add New Event" (create) flow
- Add a persistent primary button in the section header: **`＋ Add New Event`**.
- On click: `collapseAllEventCards({ redock: true })` → reset the form → `$('#eventsCreateDock').addClass('open')` → focus `#eventsTitle`.

```js
$('#eventsAddNewBtn').on('click', function () {
    collapseAllEventCards({ redock: true });
    $('#eventsForm')[0].reset();
    $('#eventsId').val('');
    $('#eventsFallbackUrl').val('');
    $('#eventsGcalLinkBadge').hide();
    $('#eventsLinkedBookingBadge').hide();
    $('#eventsConflictResolutionGroup').show();
    $('#eventsSubmitBtn').html('<i class="fa-solid fa-calendar-check"></i> Add Event');
    $('#eventsCreateDock').addClass('open');
    $('#eventsTitle').focus();
});
```

### 🔒 Critical re-render guard (prevents the form from being destroyed)
`renderEventsList()` calls `$('#adminUpcomingEventsList').empty()` / `$('#adminPastEventsList').empty()`. If the form is currently mounted inside a card in one of those lists, `.empty()` will **delete the only `#eventsForm` node**. Therefore, **make the very first action inside `renderEventsList()` re-dock the form**:

```js
async function renderEventsList() {
    mountEventEditor(eventEditorHome());   // ⟵ ADD THIS LINE FIRST, before any .empty()
    $('#eventsCreateDock').removeClass('open');
    // … existing body continues unchanged (getEventsData, empty, forEach, append) …
}
```
This guarantees the single form survives every re-render (after save, after delete, on initial load), regardless of which code path triggered the render.

### Cancel button
The existing inline `onclick` on the Cancel button resets the form and relabels the submit button. Replace it with a call that also collapses context:
```js
// New named handler the Cancel button calls:
function cancelEventEdit() {
    $('#eventsForm')[0].reset();
    $('#eventsId').val('');
    $('#eventsGcalLinkBadge').hide();
    $('#eventsSubmitBtn').html('<i class="fa-solid fa-calendar-check"></i> Add Event');
    collapseAllEventCards({ redock: true });
    $('#eventsCreateDock').removeClass('open');
}
```

---

## 4. MOBILE-FIRST RESPONSIVE GRID

Treat phones and tablets as the primary devices. **Assume touch** — do not rely on hover to communicate function; hover is additive polish only. **No horizontal scrolling** at any width.

### Card grid (applied to the list containers)
Apply the grid to `#adminUpcomingEventsList` and `#adminPastEventsList`:

```css
/* Base: single column, all phone widths */
.evt-card-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 16px;
  align-items: start;          /* don't stretch collapsed cards to match a tall expanded sibling */
}
/* Tablet: a touch more breathing room, still single column */
@media (min-width: 640px)  { .evt-card-grid { gap: 18px; } }
/* Laptop/desktop: two cards side-by-side (the col-md-5 intent) */
@media (min-width: 1024px) { .evt-card-grid { grid-template-columns: 1fr 1fr; gap: 20px; } }
```

### The expanded card spans the full row
A tall editor crammed into a half-width column reads badly on desktop. When a card opens, make it span both columns so the form has room and the "this form belongs to this event" relationship stays obvious:

```css
@media (min-width: 1024px) {
  .atl-event-card.is-expanded { grid-column: 1 / -1; }
}
```
Add/remove `.is-expanded` in `toggleEventCard` alongside the `.open` class on the region.

### Editor on small screens
- Inside the expanded card the editor is **single-column**: `.um-form-grid` (the Date/Venue pair) must collapse to one column below ~640px so fields are full-width and finger-friendly.
- All inputs ≥44px tall touch targets; labels never clipped (the relocated form is now inside a region that is not independently scrolled at open).
- The poster upload zone (`.um-upload-zone`) remains tappable; the date picker (flatpickr) opens correctly after the move.

---

## 5. VISUAL CONTRACT

The Events cards must read as a sibling of the Bookings cards. Reuse the **existing** Atelier accordion machinery rather than inventing new mechanics:

| Concern | Reuse / mirror |
|---|---|
| Card shell | `.atl-booking-card` (radius 16, `border:1px solid var(--atl-line)`, `background:var(--atl-card)`, `overflow:hidden`, `atl-card-in` entry animation). Apply an `.atl-event-card` companion class for event-specific tweaks. |
| Clickable header | `.atl-booking-card-header` pattern (`cursor:pointer`, flex, wrap). |
| Expand toggle | `.atl-expand-btn` with the `.atl-chevron` SVG that rotates 180° via `[aria-expanded="true"]`. |
| Expand animation | `.atl-detail-region` (`max-height:0` → `.open { max-height:4000px }`, `transition: max-height .35s cubic-bezier(.4,0,.2,1)`) wrapping `.atl-detail-inner`. **Do not** swap this for `display:none/block`. |
| Status pills | `.atl-status-badge`, `.atl-tag-badge`. Event states to surface as badges: **Upcoming** vs **Past** (derive from `event_datetime` as `renderEventsList` already does), **Draft · Not on public site** (`event_status === 'draft'`), **Linked to Booking #N** (`booking_id`), **GCal Synced** (`google_calendar_event_id`), **Video** (poster is a YouTube/Vimeo URL). |
| Typography | `.atl-event-title` (Cormorant Garamond) for the event name; Outfit for meta; JetBrains Mono for the `#id` chip. |

**Field-level styling boundary:** keep the relocated editor's existing `.um-*` markup (`.um-field-group`, `.um-label`, `.um-input`, `.um-input-wrap`, `.um-upload-zone`, `.um-form-grid`, `.um-form-actions`) **as-is**. Global field restyling to the `.atl-*` token system is owned by the **separate standardization prompt** (`atelier-admin-standardization-prompt.md`); duplicating that work here would collide. Your job is the **card chrome + layout + the accordion/editor wiring**, not re-skinning every input.

> **Known latent class:** `.um-upload-zone` is referenced throughout the markup but **never defined in CSS** (a pre-existing issue). Since the poster upload is now prominent inside the open card, define a minimal `.um-upload-zone` using `--atl-*` tokens (dashed border, `--atl-input-bg` recessed background, hover/`:focus-within` accent) so it renders intentionally. This overlaps the project's open "missing CSS classes" item — flag it in your summary.

---

## 6. NUMBERED IMPLEMENTATION TASKS

### Task 1 — Restructure the `#eventsAdmin` markup (lines ~5945–6132)
**Remove** the `.row` containing `.col-md-5` (the standalone "Manage Event" panel) and `.col-md-7` (the list panel). **Replace** with a single-column layout:

```
#eventsAdmin
├── .atl-section-hd  (existing header)
│     └── add a primary button:  <button id="eventsAddNewBtn" class="atl-btn atl-btn--primary">＋ Add New Event</button>
├── #eventsCreateDock  .atl-detail-region   ← the form's HOME (collapsed by default)
│     └── .atl-detail-inner
│           └── <div id="eventsFormHomeMount"></div>   ← #eventsForm physically lives here at load
├── Upcoming Events heading
│     └── #adminUpcomingEventsList  .evt-card-grid    ← JS-injected cards
├── Past Events heading
│     └── #adminPastEventsList      .evt-card-grid    ← JS-injected cards
└── #clearEventsBtn (existing, unchanged)
```

- Move the **entire existing `<form id="eventsForm">…</form>`** (lines ~5970–6094) verbatim into `#eventsFormHomeMount`. Do not edit its internals beyond rewiring the Cancel button's `onclick` to `cancelEventEdit()` (Section 3).
- Keep the form's `.um-icon-header` "Manage Event" heading inside the dock so create mode reads clearly.
- `#eventsCreateDock` uses the **same** `.atl-detail-region` open/close mechanism as cards (so create mode animates open like an event card).

### Task 2 — Re-template `renderEventsList()` (lines ~8011–8094)
Replace the `.um-item-card` summary template with an Atelier accordion card mirroring the booking card structure (`admin.html` ~L10217–10278). Each card must:
- Be `<article class="atl-event-card" data-id="${item.event_id}" data-payload="${encodedItem}">` — **carry `data-payload`** (the existing `encodeURIComponent(JSON.stringify(item))`) so the expand flow can populate the editor.
- Header (`.atl-booking-card-header`, `cursor:pointer`): poster thumbnail, `.atl-event-title` title, datetime + venue meta, and the status badges from Section 5.
- Right aside: an `.atl-expand-btn` (`data-id`, `aria-expanded="false"`, `aria-controls="eventDetail-${id}"`) with the chevron SVG, plus a **Delete** button reusing `.remove-events-action` with `data-id="${item.event_id}"` (unchanged behaviour).
- Detail region: `<div id="eventDetail-${id}" class="atl-detail-region" role="region"><div class="atl-detail-inner"><div class="evt-form-mount"></div></div></div>` — the empty mount the shared editor moves into.
- Keep the existing upcoming/past split logic (`itemTime >= now`) and the empty-state markup.

Worked header skeleton (fill with the existing display variables — `displayTitle`, `displayDateStr`, `displayVenue`, `safeThumb`, `isVideo`, badge conditionals):
```js
var html = `
<article class="atl-event-card" data-id="${item.event_id}" data-payload="${encodedItem}">
  <div style="padding:20px;">
    <div class="atl-booking-card-header" style="display:flex; gap:16px; cursor:pointer; align-items:flex-start;">
      <img src="${safeThumb}" onerror="this.src='https://placehold.co/100x140/222/D4AF37?text=No+Image';"
           style="width:72px; height:100px; object-fit:cover; border-radius:8px; flex-shrink:0;">
      <div style="flex:1; min-width:0;">
        <div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:6px;">
          <span class="atl-booking-id">#${item.event_id}</span>
          ${badgeUpcomingOrPast}${badgeDraft}${badgeLinkedBooking}${badgeGcal}${badgeVideo}
        </div>
        <h3 class="atl-event-title" style="margin:0;">${displayTitle}</h3>
        <p style="color:var(--atl-muted); font-size:13px; margin:4px 0 0;">
          <i class="fa-regular fa-calendar-check"></i> ${displayDateStr} · <i class="fa-solid fa-location-dot"></i> ${displayVenue}
        </p>
      </div>
      <div style="display:flex; align-items:center; gap:10px; flex-shrink:0; flex-wrap:wrap;">
        <button type="button" class="atl-expand-btn" data-id="${item.event_id}" aria-expanded="false" aria-controls="eventDetail-${item.event_id}">
          <span>Edit</span>
          <svg class="atl-chevron" width="14" height="14" viewBox="0 0 24 24" style="stroke:currentColor; stroke-width:2.5; fill:none; stroke-linecap:round; stroke-linejoin:round;"><path d="M6 9l6 6 6-6"/></svg>
        </button>
        <button type="button" class="um-btn um-btn--danger um-btn--sm remove-events-action" data-id="${item.event_id}">
          <i class="fa-solid fa-trash-can"></i>
        </button>
      </div>
    </div>
  </div>
  <div id="eventDetail-${item.event_id}" class="atl-detail-region" role="region" aria-label="Edit ${displayTitle}">
    <div class="atl-detail-inner"><div class="evt-form-mount"></div></div>
  </div>
</article>`;
```
And prepend the re-dock guard to the function (Section 3, "Critical re-render guard").

### Task 3 — Wire the editor controller
Add `mountEventEditor`, `collapseAllEventCards`, `window.toggleEventCard`, `applyEventToEditor` (extracted from the existing edit handler), `populateEventEditorFromCard`, the `#eventsAddNewBtn` handler, and `cancelEventEdit` (all in Section 3). Add header-click + expand-button delegation mirroring Bookings:
```js
$(document).off('click.evtcard').on('click.evtcard', '.atl-event-card .atl-booking-card-header', function (e) {
    if ($(e.target).closest('.atl-expand-btn, .remove-events-action').length) return; // let buttons handle themselves
    window.toggleEventCard($(this).closest('.atl-event-card').data('id'));
});
$(document).off('click.evtbtn').on('click.evtbtn', '.atl-event-card .atl-expand-btn', function () {
    window.toggleEventCard($(this).data('id'));
});
```
The **existing** `#eventsForm` submit handler is unchanged except that after a successful save it already calls `renderEventsList()` — which now re-docks + collapses automatically. Confirm the success path leaves the UI in a clean collapsed state.

### Task 4 — CSS
Add the `.evt-card-grid` rules + `.atl-event-card.is-expanded { grid-column:1/-1 }` (Section 4), an `.atl-event-card` companion to `.atl-booking-card`, the small-screen `.um-form-grid` single-column collapse, the `.um-upload-zone` definition (Section 5 note), a visible focus ring on inputs inside the open card (`:focus-visible` using `--atl-amber`), and a themed scrollbar only if any inner region scrolls. All via `--atl-*` tokens.

### Task 5 — Re-point legacy deep-links
Today, the calendar popup "Edit Event" button (≈L14831) and other entry points (`switchTab('eventsAdmin')` then trigger `.edit-events-action`, ≈L17652+) expect to scroll to the old top form. With the new `.edit-events-action` handler (Section 3) these now **open and scroll to the matching card**. Verify each path: calendar popup → Edit, and global-search → event result both expand the correct card.

### Task 6 — Remove the now-dead bits
Delete the old standalone left-panel wrapper and the old summary `.um-item-card` template only **after** the new card template renders. Do **not** delete `#eventsForm`, any `#events*` field, `renderEventsList`, `getEventsData`, or the delegated handlers.

---

## 7. EDGE CASES & ERROR HANDLING

| Scenario | Required behaviour |
|---|---|
| No events at all | Existing empty-state markup renders in both lists; "Add New Event" still works. |
| Event with no poster | Thumbnail falls back to placeholder (existing `onerror`). |
| Video-URL poster | "Video" badge shown; on save the existing `#eventVideoWarning` logic for local video files still fires. |
| Linked-to-booking event | On expand, `#eventsConflictResolutionGroup` hidden + `#eventsLinkedBookingBadge` shown (existing `applyEventToEditor` logic). |
| Draft status | "Draft · Not on public site" badge; `#eventsStatus` reflects `draft`. |
| Open card B while card A is open | A collapses (exclusivity), form moves from A to B, B repopulates. **No unsaved A edits silently persisting into B** — moving the form resets its values via `applyEventToEditor(B)`. If you want a guard, optionally confirm before discarding dirty edits (nice-to-have, not required). |
| Re-render while editing (save/delete) | Re-dock guard moves the form to its home *before* `.empty()`, so the node survives; UI returns to collapsed. |
| flatpickr after a move | Picker opens against the input's new position; **never re-init** (would create a duplicate instance). |
| Invalid time (not :00/:30) | Existing 30-minute server-side-mirrored validation in the submit handler fires unchanged. |
| Missing required title | Native `required` + existing handling; field is visible inside the open card. |
| Past-dated event edit | Allowed (past events are editable today); card routes to the Past list on re-render. |
| API failure (PUT/POST/DELETE 4xx/5xx, network drop) | Existing `notificationService.showError(...)` paths fire; form stays mounted so the admin can retry without re-finding the event. |
| Duplicate-ID regression | After build, assert exactly one of each `id="events*"` (Section 9). |

---

## 8. ACCEPTANCE CRITERIA

**Functional**
- [ ] Clicking an event card expands it and reveals the **full editor inline**, pre-populated with that event's data.
- [ ] Only one card (or the create dock) is open at a time.
- [ ] Editing + **Update Event** persists via the existing PUT and the card reflects the change after re-render.
- [ ] **＋ Add New Event** opens an empty editor in the create dock; **Add Event** creates via the existing POST.
- [ ] **Delete** (and "Clear All Events") behave exactly as before.
- [ ] Exactly one `#eventsForm` and one of each `#events*` id exist in the DOM throughout the full open → edit → save → delete cycle.
- [ ] flatpickr opens correctly inside an expanded card; poster upload + GCal toggle + linked-booking conditional all work.
- [ ] Calendar-popup and global-search deep-links open and expand the correct card.

**Visual**
- [ ] Cards are visually consistent with the Bookings cards (shell, header, chevron, badges, max-height animation).
- [ ] Status/linked/GCal/draft/video badges render with correct `--atl-*` colours in both dark and light themes.

**Responsive**
- [ ] Mobile (~360–480px): cards stack, editor single-column, ≥44px touch targets, **no horizontal scroll**.
- [ ] Tablet (~640–1023px): single-column grid, comfortable spacing.
- [ ] Desktop (≥1024px): collapsed cards two-up; **expanded card spans full width**.

**Accessibility**
- [ ] `.atl-expand-btn` exposes `aria-expanded` (toggles true/false) and `aria-controls` the region id.
- [ ] Region has `role="region"` + `aria-label`.
- [ ] Visible keyboard focus ring on all editor controls; full keyboard operability of expand/collapse, edit, save, delete.
- [ ] Restyled muted text and asterisks meet WCAG 2.1 AA (≥4.5:1) — do not carry forward any failing source greys.

**Regression**
- [ ] No console errors on load, expand, save, delete, or theme toggle.
- [ ] Bookings, Calendar, and every other admin section are visually and functionally unchanged.

---

## 9. TEST PLAN

**Normal flow**
1. Load admin → Events. Confirm two card grids render (Upcoming / Past) with existing data.
2. Click a card → editor mounts inline, pre-filled. Change the title/venue → **Update Event** → card re-renders with the new values, collapsed.
3. **＋ Add New Event** → fill required fields → **Add Event** → new card appears in the correct list.
4. Delete an event → confirm modal → card removed.

**Edge cases**
5. Open card A, edit a field, then open card B → A collapses, B shows B's data (not A's edits).
6. Open the create dock, then click a card → dock collapses, card opens.
7. Expand a **linked-to-booking** event → conflict-resolution group hidden, linked badge shown.
8. Expand a **draft** event → status reflects draft, badge present.
9. Edit a **past** event → saves; lands in Past list.
10. Pick an invalid time (e.g. 18:15) → 30-minute validation blocks save.

**Failure cases**
11. Simulate a 500 on PUT (or offline) → error toast shown, form stays mounted, retry works.
12. Simulate a 500 on DELETE → error toast, card remains.
13. **Duplicate-ID assertion** — in the console after a full cycle:
    ```js
    ['eventsForm','eventsTitle','eventsDate','eventsFile','eventsId','eventsStatus']
      .forEach(id => console.assert(document.querySelectorAll('#'+id).length === 1, 'DUPLICATE/MISSING: '+id));
    console.assert(typeof window.toggleEventCard === 'function');
    console.assert(document.querySelectorAll('#eventsDate')[0]._flatpickr, 'flatpickr lost');
    ```
14. Deep-link: trigger the calendar popup "Edit Event" → correct card opens and scrolls into view.

**Consistency**
- [ ] Data identical across stages (list ↔ editor ↔ DB after refresh).
- [ ] No broken flows or regressions in other sections.

---

## 10. SUGGESTED ORDER OF WORK

1. **Markup scaffold (Task 1)** — collapse the two columns, add `#eventsAddNewBtn`, `#eventsCreateDock`, and move `#eventsForm` into `#eventsFormHomeMount`. Confirm create still works against the old list.
2. **Controller (Task 3, minus card delegation)** — add `mountEventEditor`, `collapseAllEventCards`, the re-dock guard in `renderEventsList`, `applyEventToEditor` extraction, Add/Cancel handlers. Verify the form survives a manual `renderEventsList()` call.
3. **Card template (Task 2)** — re-template the cards with mount points + `data-payload`.
4. **Accordion wiring (Task 3 delegation)** — `toggleEventCard` + header/expand delegation; verify open/edit/save/collapse end-to-end.
5. **CSS (Task 4)** — grid, expanded full-width span, mobile collapse, focus ring, `.um-upload-zone`, scrollbar.
6. **Deep-links (Task 5)** + **cleanup (Task 6)**.
7. **Full regression** against Section 9 across mobile / tablet / laptop / desktop and both themes.

---

### Deliverable
A single self-contained, drop-in edit to `admin.html` (markup + JS + CSS in their existing in-file locations). No build step, no npm changes, no backend edits. Provide a short changelog noting: the relocated form mechanism, the re-dock guard added to `renderEventsList`, and the newly defined `.um-upload-zone` class (which closes one of the project's open "missing CSS class" items).
