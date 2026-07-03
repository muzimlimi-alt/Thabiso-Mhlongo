# Atelier Admin — Bookings / Calendar / Events Gap Audit & Fix Prompt

> **What this prompt is for.** Resolve the specific, confirmed gaps in `#bookingsAdmin`,
> `#calendarAdmin`, and `#eventsAdmin` — primarily missing error handling, dead/unwired UI
> elements, deprecated resource references, and hardcoded hex values — while preserving every
> working workflow in three of the most complex sections in the admin.
>
> These three sections are meaningfully more mature than the sections covered by prior prompts.
> The gap list here is narrower and more surgical. Read the full impact analysis (§2) before
> touching anything — especially in `#bookingsAdmin`, where the booking lifecycle, modal system,
> and ARIA structure must not be disturbed.
>
> **Every finding was verified by direct file read with line numbers.** Re-grep before editing.

---

## 0. How to use this prompt

Execute one phase at a time: §6 (foundation) → §7 (`#bookingsAdmin`) → §8 (`#calendarAdmin`) →
§9 (`#eventsAdmin`). Each is independently shippable. §6 must land first. Resolve all §5
decision gates before implementing the items they govern.

---

## 1. What these three sections actually are (confirmed by line read)

| Section | Lines | Structure | Tab system |
|---|---|---|---|
| `#bookingsAdmin` | 4954–5066 | Custom bespoke header (`.atl-overline`/`.atl-heading`) → pipeline pills → toolbar (search + filter + clear) → `#bookingsListContainer` | No tab bar. Modal-based (`#atlModalRoot`, `showAtelierModal()`). |
| `#calendarAdmin` | 5068–5205 | Two-column: 8/12 FullCalendar + 4/12 sidebar. Sidebar has its own 3-tab system (`cal-sidebar-tabs`/`cal-sidebar-tab`/`cal-tab-panel`) with self-contained JS wiring at 16252–16269. | **Custom `cal-sidebar-tab` system**, not `atl-tab-bar`. Already has: Navigation, Schedule, Upcoming. |
| `#eventsAdmin` | 6400–6655 | Header → `#eventsCreateDock` (collapsible form, `atl-detail-region`) → search+bulk toolbar → dual-column card lists (upcoming/past). Form uses `.um-input`/`.um-upload-zone`; cards use `.atl-event-card`. | No tab bar. Accordion pattern (`atl-detail-region`). |

Key contextual facts every phase must respect:
* `#bookingsAdmin` uses Tailwind-style utility classes (`relative z-10`, `mb-8`, `space-y-4`) on
  its outer wrappers — these are inert dead class names (no Tailwind CSS is loaded). They are
  harmless and must not be removed without Muzi's confirmation (§5.5).
* `#eventsAdmin`'s form (`#eventsForm`) is **a single shared instance detached and re-attached**
  via `mountEventEditor()` (jQuery `.detach().appendTo()`) every time a card is expanded or the
  create dock opens. Any change to the form's IDs or the `#eventsFormHomeMount` container will
  break this mechanism.
* `#calendarAdmin`'s sidebar tab JS (16252–16269) fires `renderWorkingSchedule()` when the
  Upcoming tab is clicked. Do not duplicate or replace this handler — add the About tab to the
  same handler block.
* `showAtelierModal()` is defined at admin.html 7544 and is the correct mechanism for modal-based
  About entry points in sections that don't have a tab bar.

---

## 2. Full-stack impact analysis

| Layer | `#bookingsAdmin` | `#calendarAdmin` | `#eventsAdmin` |
|---|---|---|---|
| **Database** | `bookings`, `clients`, `invoices`, `quotes` — no schema changes | `working_hours`, `events`, `calendar holds`, `settings` — no schema changes | `events`, `booking_holds` — no schema changes |
| **Backend** | server.js 3237–5804 (booking lifecycle routes). Not touched by this prompt. | server.js 3848–3967 (working-hours GET/PUT), 6397–6400 (calendar/events GET), 6791 (ics feed). Not touched. | server.js 8059–8253 (events CRUD + duplicate + patch-date). Not touched. |
| **Frontend markup** | admin.html 4954–5066 | admin.html 5068–5205 | admin.html 6400–6655 |
| **Frontend JS** | `loadBookings()` 10688, `renderBookingsTable()` 10922, `applyBookingFilter()` 13257, `btnRefreshBookings` handler 16500 | `loadWorkingHours()` 18760, `saveWorkingHours()` 18816, `btnRefreshCalendar` handler 16438, `btnCopyIcsFeed` handler 16459, `btnNewDateHold` handler 16664 | `getEventsData()` 8532, `renderEventsList()` 8537, `eventsForm` submit 8947, bulk action handlers 8742–8782, `clearEventsBtn` 6650 |

---

## 3. Confirmed defects (verified by direct file read, line-cited)

### 3.1 `#bookingsAdmin`

| # | Defect | Evidence |
|---|---|---|
| D1 | **`loadBookings()` has no try/catch wrapper.** `apiCall()` throws on network errors, 401s, and 500s. Since `loadBookings()` has no outer try/catch, these throws become unhandled promise rejections — the loading spinner remains, `#bookingsListContainer` never updates, and no error is shown. The inline `if (!data || data.error)` guard only catches cases where `apiCall()` resolves normally with a bad body, not cases where it throws. | admin.html 10688–10710. `apiCall()` is confirmed throw-on-error via its definition. |
| D2 | **No About entry point.** The section has no tab bar and no info button. | grep confirms absence. `showAtelierModal()` available at 7544 for the fix. |

### 3.2 `#calendarAdmin`

| # | Defect | Evidence |
|---|---|---|
| D3 | **`loadWorkingHours()` catch block is console-only.** `catch(e) { console.error('[loadWorkingHours]', e); }` at 18805–18807 — no `notificationService` call. When working hours fail to load, the schedule table silently stays blank with no user-visible explanation. | admin.html 18805–18807. |
| D4 | **`btnCopyIcsFeed` uses raw `fetch('/api/admin/settings')` without `res.ok` check.** If the API returns a non-2xx response (e.g. 401), `r.json()` still resolves (JSON error body) but `d.settings` is `undefined`, so `token` becomes an empty string and the feed URL is generated without authentication — potentially exposing the calendar to unauthorized access. The catch handles hard failures but not soft 4xx/5xx responses. | admin.html 16462–16467. |
| D5 | **No About entry point.** No fourth `cal-sidebar-tab` or equivalent. | grep confirms absence. The cal-sidebar-tab system (16252–16269) is the natural place to add it. |

### 3.3 `#eventsAdmin`

| # | Defect | Evidence |
|---|---|---|
| D6 | **`clearEventsBtn` has no click handler and is never shown.** `style="display:none"` at 6650. No `clearEventsBtn.show()` call exists anywhere in the file (grep confirms). The button is permanently invisible and unresponsive. Decision gate §5.1. | admin.html 6650; grep of full file for `clearEventsBtn`. |
| D7 | **`getEventsData()` has no try/catch.** `async function getEventsData() { var data = await apiCall('/api/admin/events'); return data || []; }` — if `apiCall()` throws, the throw propagates directly into `renderEventsList()`, which also has no try/catch (see D8). | admin.html 8532–8535. |
| D8 | **`renderEventsList()` has no try/catch.** The throw from D7 propagates to every call site: delete handler (8668), duplicate handler (8685), bulk publish (8753), bulk unpublish (8768), bulk delete (8780), form submit (9012), and on-login load (14619, 14742). A single network failure causes an unhandled promise rejection at all of these, leaving the event lists blank with no feedback. | admin.html 8537–8660. |
| D9 | **Bulk publish, unpublish, and delete handlers (`#evtBulkPublish`, `#evtBulkUnpublish`, `#evtBulkDelete`) have no try/catch.** Each loops over selected IDs calling `apiCall()` per item. If any single `apiCall()` throws mid-loop, execution stops, no error is surfaced, the success toast never fires, and the list re-renders with some items changed and some not — a silent partial failure. | admin.html 8742–8782. |
| D10 | **`via.placeholder.com` is used for video thumbnail fallback.** `'https://via.placeholder.com/320x180/111/fff?text=Video+URL'` at line 8560. The `via.placeholder.com` service has been decommissioned and now redirects or fails. The same file already uses `placehold.co` for other fallbacks (lines 8254, 8609). Replace with `placehold.co` consistently. | admin.html 8560. |
| D11 | **Hardcoded `#aaa` on the Google Calendar sync label.** `color:#aaa` at line 6570 — breaks in light mode. Replace with `var(--atl-muted)`. | admin.html 6570. |
| D12 | **Hardcoded `rgba(0,0,0,0.55)` and `#fff` on the poster preview badge.** The "Preview" label overlay at line 6460 — breaks in light mode (dark overlay on potentially light-mode background). Replace with `background:var(--atl-ink-dim)` (or a dedicated token if one exists). The `#fff` text → `var(--atl-paper)`. | admin.html 6460. |
| D13 | **Hardcoded `rgba(96,165,250,0.08)`, `rgba(96,165,250,0.25)`, and `#8ab4f8` in `#eventsGcalLinkBadge`.** The badge already correctly uses `color:var(--atl-blue)` for text — only the background, border-color, and link-text color are hardcoded. `var(--atl-blue)` and a computed `rgba(var(--atl-blue-rgb), 0.08)` — or simpler, `background:var(--atl-blue-dim)` and `border:1px solid var(--atl-blue-border)` if those tokens exist. Check for existing `--atl-blue-dim`/`--atl-blue-border` first; if absent, use inline `rgba` with the known blue value until the token exists. The link `#8ab4f8` → `var(--atl-blue)`. | admin.html 6576–6579. |
| D14 | **No About entry point.** | grep confirms absence. |

---

## 4. Non-negotiable constraints

* **`#bookingsAdmin`'s entire booking lifecycle, modal system, and card structure must not be
  touched.** `#atlModalRoot`, `showAtelierModal()`, `renderBookingsTable()`, `applyBookingFilter()`,
  the pipeline pills, the `.bk-*` CSS classes, the `btnRefreshBookings` and `btnNewManualBooking`
  handlers — all untouched. This prompt only adds a try/catch to `loadBookings()` and an About
  entry point.
* **`#eventsForm` is a single shared detachable form.** Do not add a second `#eventsForm`, do not
  change its ID, do not move `#eventsFormHomeMount` or `#eventsCreateDock`. The
  `mountEventEditor()` mechanism (8788–8791) depends on the exact DOM structure.
* **`#calendarAdmin`'s sidebar tab JS (16252–16269) is self-contained.** Adding a 4th "About"
  tab requires only: (a) a new `<button class="cal-sidebar-tab" data-tab="cal-about"...>` button
  in the markup, (b) a matching `<div class="cal-tab-panel" id="cal-about"...>` panel, and (c)
  adding a case to the existing click handler where `target === 'cal-about'` does not call
  `renderWorkingSchedule()`. The handler at 16252 already handles any `data-tab` value
  generically — no JS change is needed, only the markup addition.
* **FullCalendar (`adminCalendar`, `refetchEvents()`, `setOption()`) must not be initialised more
  than once.** Do not add any calendar-related code to the About tab.
* **`mountEventEditor()` and `collapseAllEventCards()` are called from multiple sites.** If any
  markup change causes `$('#eventsFormHomeMount')` to return an empty jQuery set (e.g. if the
  element is wrapped or renamed), the form detach/attach mechanism will silently stop working.
* **Do not remove the Tailwind-style utility classes** from `#bookingsAdmin` outer wrappers (lines
  4955–5065) without Muzi's confirmation (§5.5).

---

## 5. Decision gates — confirm with Muzi before implementing

1. **D6 — `#clearEventsBtn`:** Implement as a real "delete all events" action with
   `showConfirm({isDestructive:true})` looping through both `#adminUpcomingEventsList` and
   `#adminPastEventsList` card IDs — or remove the button entirely? The per-card delete buttons
   already cover the use case. The section also has bulk delete via `#evtBulkDelete`. A "clear
   all" adds little functional value here but is a decision only Muzi can make.
2. **About entry point for `#bookingsAdmin`:** Use `showAtelierModal()` triggered from a header
   info button in the `atl-section-hd` actions row (line 4965), matching the pattern used by
   `#inquiriesAdmin`. Or is a dedicated "Help" link elsewhere preferred? Confirm placement.
3. **About entry point for `#eventsAdmin`:** Same question — `showAtelierModal()` triggered from
   a small info button next to `#eventsAddNewBtn` (line 4410 equivalent), or elsewhere?
4. **D4 (`btnCopyIcsFeed` raw `fetch`):** Converting to `apiCall()` is the correct fix, but
   `apiCall()` sets `Content-Type: application/json` and may behave differently for a GET. Confirm
   whether replacing `fetch('/api/admin/settings')` with `apiCall('/api/admin/settings', 'GET')`
   is acceptable, or whether a manual `res.ok` check on the existing `fetch()` is preferred.
5. **Tailwind-style utility classes in `#bookingsAdmin`** (`relative z-10`, `max-w-6xl mx-auto`,
   `px-4`, `sm:px-6`, `py-8`, `mb-8`, `space-y-4`, `text-sm ml-auto self-center`): these have
   no CSS effect today (no Tailwind is loaded). Remove them silently, or leave them in place
   pending a future cleanup pass? Confirm before acting.

---

## 6. Shared foundation (build first)

If prior prompts in this series have already landed, the About-tab skeleton and
`.um-pagination-btns` CSS are in place. Verify the following specific items are available — add
only what is missing:

### 6.1 `showAtelierModal()` About modal content template
`showAtelierModal()` takes a selector targeting an existing Bootstrap modal structure and applies
the platform's chrome to it. For About entry points in sections without a tab bar, the pattern is:

```js
function showAboutModal(sectionId, title, bodyHtml) {
    // Build or find a transient modal, populate it, call showAtelierModal()
    // — reuse the pattern already used by the existing About modals in #inquiriesAdmin
    // if that prompt has already landed. Do not create a duplicate implementation.
}
```

If no shared About modal helper exists yet, create one in the shared utilities block rather than
duplicating the modal construction inline for each section.

### 6.2 Error-handling norm (carry-over)
Same norm established in prior prompts: every `catch` block touched in this prompt adds
`window.notificationService.showError('...')` alongside `console.error`. Both fire; neither
replaces the other.

---

## 7. Phase 1 — `#bookingsAdmin` (smallest gap surface; do first)

### 7.1 Tasks

**T1 — Fix D1 (`loadBookings()` missing try/catch).** Wrap the entire body of `loadBookings()`
in a try/catch. The existing inline error-state HTML (the `bkr-empty` div with "Failed to load
bookings") is already well-written — the catch should show that same inline state plus a
`notificationService.showError`:
```js
async function loadBookings() {
    const $container = $('#bookingsListContainer');
    $container.html('<div class="bkr-empty" style="padding:40px 20px;"><i class="fa-solid fa-circle-notch fa-spin" style="font-size:28px;opacity:.4;display:block;margin-bottom:12px;"></i><p>Loading…</p></div>');
    try {
        const data = await apiCall('/api/admin/bookings/full');
        if (!data || data.error || !Array.isArray(data)) {
            $container.html('<div class="bkr-empty"><i class="fa-solid fa-triangle-exclamation"></i><p>Failed to load bookings. Please refresh.</p></div>');
            return;
        }
        allBookingsCache = data;
        ['NEW','PENDING','QUOTED','ACCEPTED','CONFIRMED','COMPLETED','EXPIRED','CANCELLED'].forEach(s => {
            $(`#bkStat-${s}`).text(data.filter(b => (b.status||'').toUpperCase() === s).length);
        });
        applyBookingFilter();
    } catch(e) {
        console.error('[loadBookings]', e);
        $container.html('<div class="bkr-empty"><i class="fa-solid fa-triangle-exclamation"></i><p>Failed to load bookings. Please refresh.</p></div>');
        window.notificationService.showError('Could not load bookings — please check your connection and refresh.');
    }
}
```
The internal logic (pipeline count update, `applyBookingFilter()`) is unchanged; only the
wrapping try/catch is added.

**T2 — Add About entry point (per §5.2 decision).** Add a small info icon button to the actions
row in the header (line 4965), before `#btnRefreshBookings`:
```html
<button id="btnBookingsAbout" class="atl-btn atl-btn--ghost" title="About this section"
    style="height:40px; display:inline-flex; align-items:center; gap:6px;">
    <i class="fa-solid fa-circle-info"></i>
</button>
```

Wire it to `showAtelierModal()` with a populated About body covering: the 8-stage booking
lifecycle (NEW → PENDING → QUOTED → ACCEPTED → CONFIRMED → COMPLETED/EXPIRED/CANCELLED);
what the pipeline pills do (they are filter shortcuts, not status changers); how to create a
manual enquiry; the difference between booking status and payment status in the filter dropdown;
the Refresh button and when to use it; how cards expand to show the full lifecycle panel; and a
security note that all booking status transitions are validated server-side.

### 7.2 Hard constraints specific to this phase
* `loadBookings`, `allBookingsCache`, `applyBookingFilter`, `renderBookingsTable` — unchanged.
* `#bookingsListContainer`, `#bookingStatsBar`, `#bkSearchInput`, `#bookingStatusFilter`,
  `#clearFilters`, `#atlModalRoot`, `#btnRefreshBookings`, `#btnNewManualBooking` — IDs unchanged.
* The `atl-overline`/`atl-heading`/`atl-subtitle`/`atl-pipeline`/`atl-toolbar` CSS classes and
  their definitions (lines 892–1025) are untouched — do not migrate the header to `atl-section-hd`.

---

## 8. Phase 2 — `#calendarAdmin`

### 8.1 Tasks

**T1 — Fix D3 (`loadWorkingHours` console-only catch).** Replace at 18805–18807:
```js
} catch(e) {
    console.error('[loadWorkingHours]', e);
    window.notificationService.showError('Could not load working hours schedule — please refresh.');
}
```

**T2 — Fix D4 (`btnCopyIcsFeed` raw `fetch` + no `res.ok`).** Per §5.4 decision. If using
`apiCall()`: replace `const r = await fetch('/api/admin/settings')` and `const d = await r.json()`
with `const d = await apiCall('/api/admin/settings', 'GET')`, then update `const token` to read
from `d.settings && d.settings.CALENDAR_FEED_SECRET`. If keeping raw `fetch()`: add
`if (!r.ok) throw new Error('Settings API returned ' + r.status)` immediately after `await fetch`.
Either approach is valid; the existing catch already surfaces errors via `notificationService`.

**T3 — Add About tab to the sidebar.** Add a fourth `cal-sidebar-tab` to the markup at 5139–5143:
```html
<button class="cal-sidebar-tab" data-tab="cal-about" role="tab" aria-selected="false">About</button>
```
And a fourth panel after the Upcoming panel (after line 5198):
```html
<div class="cal-tab-panel" id="cal-about" role="tabpanel">
    <!-- §6.2-style About content — no .atl-card wrapper needed, panels are already inside .atl-card -->
    <h3 class="um-section-label" style="font-size:13px;margin:0 0 14px;">
        <i class="fa-solid fa-circle-info" style="margin-right:6px;color:var(--atl-amber);"></i> About This Section
    </h3>
    <!-- purpose, controls, workflow content -->
</div>
```
The existing tab click handler at 16252–16269 already handles any `data-tab` generically — it
reads `this.dataset.tab`, removes `.active` from all tabs and panels, then adds `.active` to the
clicked tab and the matching panel. **No JS change is needed** — the handler works for any
`data-tab`/`id` pair inside the same `.atl-card` container.

About tab content for `#calendarAdmin`: the four filter types (Bookings/Holds/Events/Milestones)
and their colour coding (matches the legend in the markup at 5116–5129); how to block out dates
(click a day in the mini-calendar or use "Block Out Dates"); the Working Hours schedule and what
it controls (availability check during new bookings — changing it does not retroactively affect
confirmed bookings); the Upcoming panel; the ICS feed and what the token does (unauthenticated
access to the calendar for third-party apps); note that calendar events from the bookings pipeline
are synced automatically when a booking is promoted to a gig.

### 8.2 Hard constraints specific to this phase
* `#cal-nav`, `#cal-sched`, `#cal-upcoming`, `#miniCalendarBody`, `#workingHoursTbody`,
  `#upcomingScheduleList`, `#btnSaveWorkingHours`, `#btnRefreshCalendar`, `#btnCopyIcsFeed`,
  `#btnNewDateHold` — IDs unchanged.
* The `cal-sidebar-tab` click handler (16252–16269) must not be replaced — add the About tab
  markup and confirm the existing handler picks it up without code change.
* FullCalendar initialisation at 16086 is untouched.

---

## 9. Phase 3 — `#eventsAdmin` (most changes in this batch; do last)

### 9.1 Tasks

**T1 — Fix D6 (`clearEventsBtn`) per §5.1 decision.** Either:
* *Implement:* Wire `#clearEventsBtn` with a `showConfirm({isDestructive:true})`, collect all
  rendered event IDs from `$('.atl-event-card').map(...)`, call `apiCall('/api/admin/events/' + id, 'DELETE')` per ID in a loop wrapped in try/catch, show success/error toast, call `renderEventsList()`. Also add a `show()` call inside `renderEventsList()` after the data renders (parallel to how `clearCareerBtn` was originally intended to work). Make the button appear only when at least one event exists.
* *Remove:* Delete the button markup at 6650–6652, and the surrounding `<div class="um-form-actions">` at 6649–6653 if it has no other content.

**T2 — Fix D7 + D8 (`getEventsData()` + `renderEventsList()` missing try/catch).** Wrap
`getEventsData()`:
```js
async function getEventsData() {
    try {
        var data = await apiCall('/api/admin/events');
        return Array.isArray(data) ? data : [];
    } catch(e) {
        console.error('[getEventsData]', e);
        return null; // distinct from [] to signal a fetch failure vs. an empty list
    }
}
```
In `renderEventsList()`, check for the null return and render an error state:
```js
async function renderEventsList() {
    if (typeof mountEventEditor === 'function') mountEventEditor(eventEditorHome());
    $('#eventsCreateDock').removeClass('open');
    var data = await getEventsData();

    var $upcomingList = $('#adminUpcomingEventsList');
    var $pastList     = $('#adminPastEventsList');

    if (data === null) {
        // Network / API failure
        var errState = '<div class="atl-empty-state" style="padding:30px;border:1px dashed var(--atl-line);border-radius:12px;text-align:center;"><i class="fa-solid fa-triangle-exclamation" style="font-size:24px;color:var(--atl-clay);display:block;margin-bottom:10px;"></i><p style="color:var(--atl-muted);margin:0;">Failed to load events — please refresh.</p></div>';
        $upcomingList.html(errState);
        $pastList.html(errState);
        window.notificationService.showError('Could not load events — please check your connection and refresh.');
        return;
    }
    // ... rest of the existing render logic unchanged ...
}
```
The rest of the function body is entirely unchanged — only the null-data branch is new.

**T3 — Fix D9 (bulk actions missing try/catch).** Each bulk handler loops through IDs calling
`apiCall()`. Wrap each loop in a try/catch and track failures:
```js
$('#evtBulkPublish').on('click', async function() {
    var ids = evtGetSelectedIds();
    if (!ids.length) return;
    var failed = 0;
    for (var i = 0; i < ids.length; i++) {
        try {
            var card = $('.atl-event-card[data-id="' + ids[i] + '"]');
            var payload = JSON.parse(decodeURIComponent(card.attr('data-payload') || '{}'));
            payload.event_status = 'upcoming';
            payload.sync_to_gcal = false;
            await apiCall('/api/admin/events/' + ids[i], 'PUT', payload);
        } catch(e) { failed++; }
    }
    if (failed > 0) window.notificationService.showError(failed + ' event(s) could not be published.');
    else window.notificationService.showSuccess((ids.length - failed) + ' event(s) published.');
    renderEventsList();
    $('#evtBulkCancel').trigger('click');
});
```
Apply the same `failed` counter pattern to `#evtBulkUnpublish` and `#evtBulkDelete`. For delete,
the confirm dialog fires before the loop — do not add a second confirm inside the loop.

**T4 — Fix D10 (deprecated `via.placeholder.com`).** On line 8560, replace:
```js
var safeThumb = isVideo ? 'https://via.placeholder.com/320x180/111/fff?text=Video+URL' : posterUrl;
```
with:
```js
var safeThumb = isVideo ? 'https://placehold.co/320x180/111/fff?text=Video+Poster' : posterUrl;
```
`placehold.co` is already used at lines 8254, 8609. This makes the three usages consistent and
removes the dependency on the decommissioned CDN.

**T5 — Fix D11 (hardcoded `#aaa` on GCal sync label).** On line 6570, change:
`color:#aaa;` → `color:var(--atl-muted);`

**T6 — Fix D12 (hardcoded `rgba(0,0,0,0.55)` + `#fff` on poster preview badge).** On line 6460:
```html
<!-- BEFORE -->
<span style="position:absolute;...;background:rgba(0,0,0,0.55);color:#fff;...">Preview</span>

<!-- AFTER -->
<span style="position:absolute;...;background:var(--atl-ink-dim);color:var(--atl-paper);...">Preview</span>
```
Verify `var(--atl-ink-dim)` and `var(--atl-paper)` produce sufficient contrast in both themes
before finalising — if `--atl-ink-dim` is too light in dark mode, use a dedicated `--atl-scrim`
token if one exists, or `rgba(0,0,0,0.55)` with a CSS custom property alias.

**T7 — Fix D13 (hardcoded `rgba(96,165,250,...)` + `#8ab4f8` in `#eventsGcalLinkBadge`).** On
lines 6576–6579:
* First check whether `--atl-blue-dim` and `--atl-blue-border` are defined in `redesign.css`.
  Use them if they exist. If not, the safest approach is:
  ```html
  style="...;background:rgba(var(--atl-blue-rgb,96,165,250),0.08);
         border:1px solid rgba(var(--atl-blue-rgb,96,165,250),0.25);...;color:var(--atl-blue);"
  ```
  The link `color:#8ab4f8` → `color:var(--atl-blue)` (already used correctly on the same line
  for the icon and text).

**T8 — Add About entry point (per §5.3 decision).** Add a small info icon button next to
`#eventsAddNewBtn` in the header actions row (line 6409–6413):
```html
<button id="btnEventsAbout" class="atl-btn atl-btn--ghost" title="About this section"
    style="height:40px; display:inline-flex; align-items:center; gap:6px;">
    <i class="fa-solid fa-circle-info"></i>
</button>
```
Wire to `showAtelierModal()` with About content covering: the two lists (Upcoming and Past are
split by event date, not status); the create dock (`#eventsCreateDock`) and how it works; the
shared form mechanism (editing an event expands its card and moves the form into it — only one
card can be in edit mode at a time); Google Calendar sync and what it does; duplicate feature
(always creates a draft); the Video poster limitation (cannot upload videos — use YouTube URL);
the `#eventsBlockType` field and its calendar conflict options; bulk actions and the select mode.

### 9.2 Hard constraints specific to this phase
* `#eventsForm`, `#eventsFormHomeMount`, `#eventsCreateDock` — IDs and DOM positions unchanged.
  `mountEventEditor()` (8788) and `collapseAllEventCards()` (8793) depend on this structure.
* `#eventsDate` and `#eventsEndTime` have flatpickr instances bound via `$('#eventsDate')[0]._flatpickr`
  (e.g. 8812). Do not rename these IDs.
* `#eventsTitle`, `#eventsDesc`, `#eventsVenue`, `#eventsVenueSearch`, `#eventsVenueMapLink`,
  `#eventsTicketUrl`, `#eventsType`, `#eventsStatus`, `#eventsBlockType`, `#eventsId`,
  `#eventsFallbackUrl`, `#eventsBookingId`, `#eventsFile`, `#eventsGcalSync`, `#eventsGcalLinkBadge`,
  `#eventsLinkedBookingBadge`, `#eventsConflictResolutionGroup` — all IDs unchanged.
* `#adminUpcomingEventsList`, `#adminPastEventsList`, `#evtCountUpcoming`, `#evtCountPast`,
  `#eventsSearchInput`, `#evtBulkBar`, `#evtBulkCount`, `#evtBulkToggle`, `#evtBulkPublish`,
  `#evtBulkUnpublish`, `#evtBulkDelete`, `#evtBulkCancel` — IDs unchanged.
* The `data-payload` attribute on `.atl-event-card` holds the encoded item — it is the only
  source of truth for the edit pre-population in `populateEventEditorFromCard()` (8862). Do not
  change this attribute's encoding scheme.

---

## 10. Acceptance criteria

- [ ] **`#bookingsAdmin`:** `loadBookings()` is wrapped in try/catch — a simulated network
      failure shows the error state AND an error toast (D1 regression test). About entry point
      present per §5.2 decision.
- [ ] **`#calendarAdmin`:** `loadWorkingHours()` failure shows an error toast (D3 regression
      test). `btnCopyIcsFeed` handles a non-2xx settings response without generating a token-less
      feed URL (D4 regression test). About tab present as fourth `cal-sidebar-tab` and
      panel-switches correctly (D5 resolved).
- [ ] **`#eventsAdmin`:** `renderEventsList()` failure shows an error state AND an error toast
      (D7/D8 regression test — simulate by briefly returning a non-JSON response from the
      events endpoint). Bulk publish/unpublish/delete each show per-item failure counts rather
      than silent partial failures (D9). `via.placeholder.com` absent from the file (D10).
      `#aaa` replaced by `var(--atl-muted)` on GCal sync label (D11). Poster preview badge and
      `#eventsGcalLinkBadge` use tokens only (D12/D13). `clearEventsBtn` resolved per §5.1.
      About entry point present per §5.3 decision.
- [ ] **Zero functional regressions** — booking lifecycle, calendar filters, event form
      detach/attach, bulk select mode, flatpickr date pickers, Google Calendar sync, ICS feed
      URL copy — all still work after changes.
- [ ] No new hardcoded hex in any edited block.
- [ ] All §5 decision gates resolved with Muzi's input or left in current state pending that input.

---

## 11. Test matrix

| Scenario | `#bookingsAdmin` | `#calendarAdmin` | `#eventsAdmin` |
|---|---|---|---|
| **Normal** | Load section; confirm pipeline pill counts update; click a pill to filter; open a booking card; use Refresh | Switch all 4 sidebar tabs; save working hours; use "Block Out Dates"; copy ICS feed URL | Add a new event; edit it; duplicate it; publish via bulk; delete via bulk |
| **Failure** | Force 500 from `GET /api/admin/bookings/full` — error state shows + error toast fires (D1 test). Confirm no unhandled promise rejection in console | Force 500 from `GET /api/admin/working-hours` — error toast fires (D3 test). Force 401 from `GET /api/admin/settings` — ICS copy should show error, not generate a bare URL (D4 test) | Force 500 from `GET /api/admin/events` — both list containers show error state + error toast fires (D7/D8 test). Bulk-publish 3 events; intercept one PUT to fail — confirm `2 published, 1 failed` feedback (D9 test) |
| **Regression** | Refresh button still calls `loadBookings()` + `refetchEvents()`; "New Enquiry" still opens manual booking modal | Working hours save flow still completes + reloads schedule; Upcoming tab still calls `renderWorkingSchedule()` | Form detach/attach: click Edit on card A → click Edit on card B → card A collapses correctly. flatpickr still fires on date fields. Google Calendar sync checkbox still included in submit payload |
| **Theme** | Pipeline pill dots use `--atl-*` tokens — confirm no hardcoded colours in their `style` attrs (already token-based; regression check only) | Legend dots in calendar are `--atl-*` tokens (already token-based) | GCal sync label readable in light mode (no `#aaa`). Poster preview badge readable in both themes. GCal link badge visible in light mode (no hardcoded `rgba` background) |

---

## 12. Suggested order of work

1. **§6 Shared foundation** — verify prior prompts' foundation is in place; add shared About
   modal helper if needed.
2. **§7 `#bookingsAdmin`** — smallest surface area. The try/catch addition is one surgical
   wrapping operation. Validates the pattern before the more involved events work.
3. **§8 `#calendarAdmin`** — two catch improvements + markup-only About tab addition. Medium
   effort, low risk.
4. **§9 `#eventsAdmin`** — most tasks. Recommended sub-order within the phase:
   T4 (deprecated CDN — one-line, zero risk) → T5 (one-token substitution) → T6 + T7
   (hex/rgba token substitutions) → T2 (getEventsData/renderEventsList try/catch — test
   carefully) → T3 (bulk action catch pattern) → T1 (clearEventsBtn, gated) → T8 (About,
   gated). Test the form detach/attach mechanism after T2 before proceeding.
5. **Full §10 + §11 pass** across all three sections before declaring done.

> **Pair with:** The four prior prompts in this series share the same About-entry-point pattern,
> error-handling norm, and foundation CSS. `atelier-admin-standardization-prompt.md` owns
> visual/token migrations at scale — run it after all functional-gap prompts have landed.
