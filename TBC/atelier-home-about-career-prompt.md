# Atelier Admin — Home Slider / About Me / Career Highlights Gap Audit & Fix Prompt

> **What this prompt is for.** Bring `#homeAdmin`, `#aboutAdmin`, and `#careerAdmin` to the same
> standard as the platform's most mature sections: consistent tab structure, About tabs, proper
> error surfacing, token-based styling in JS-generated markup, and resolution of confirmed bugs —
> without touching the booking/CRM pipeline or changing any currently-working workflow.
>
> **Every finding in this document was verified by direct file read, with line numbers.** Nothing
> is assumed. Where a line number is cited, re-grep before editing to account for line drift from
> any prior prompt execution.

---

## 0. How to use this prompt

* Execute **one phase at a time** in the order given (§6 → §7 → §8 → §9). Each phase is
  independently shippable and scoped to one `.admin-section`.
* §6 (shared foundation) must land first — all three section phases consume its CSS.
* Where §5 lists a decision gate, do not implement that specific item until Muzi has confirmed
  the resolution. Implement everything else in the phase, then flag the pending gate.
* If a line number no longer matches (because a prior prompt has edited the file), re-grep to
  find the current location before proceeding.

---

## 1. What these three sections actually are (confirmed by line read)

All three sections follow the same **two-card, two-column layout** (`um-grid-2 um-grid-2--5-7`):
a left "add/edit" form card and a right "current items" list or preview card. None of the three
has a tab bar, and none has an About entry point.

| Section | Left card | Right card | Live data source |
|---|---|---|---|
| `#homeAdmin` (5854–5939) | Upload zone + URL input (add slider images) | Drag-sortable list of active slides | `GET /api/admin/home-slider` (server.js 8374) |
| `#aboutAdmin` (5942–6032) | Three Quill editors + file upload / URL fallback | Live preview pane | `GET /api/admin/about-me` (server.js 8849) |
| `#careerAdmin` (6035–6132) | Structured form: year/title/badge/location/desc/image | List of highlight cards with kebab-menu (Edit/Delete) | `GET /api/public/highlights` (server.js 8333) |

Key contextual facts:
* `fetchHomeSlider()` uses raw `fetch()`, not `apiCall()` — it bypasses the session-expiry and
  centralised error-handling built into `apiCall()`.
* `loadHighlights()` calls `/api/public/highlights` — the **public** (unauthenticated) endpoint —
  not an admin-specific route. Flagged as a decision gate (§5.4).
* Three Quill editors in `#aboutAdmin` are initialised in a dedicated `(function(){...})()` block
  at the bottom of the file (admin.html ~17808–17822) and wired to `updateAboutPreview()` via
  `q.on('text-change', ...)`. This init block must not be touched.
* `initDraggableSlider()` (admin.html 8276) guards itself with `list.dataset.dragInit = '1'` so
  it never double-binds even when `renderHomeList()` is called multiple times. This guard must
  be preserved.

---

## 2. Full-stack impact analysis

| Layer | `#homeAdmin` | `#aboutAdmin` | `#careerAdmin` |
|---|---|---|---|
| **Database** | `home_slider` — `id, url, alt, file_name, file_size, uploader_name, display_order`. No schema change. | `about_me` — `id, image_path, paragraph1, paragraph2, paragraph3, updated_at, updated_by`. No schema change. | `career_highlights` — `id, year, title, badge, location, description, image_path, display_order, created_at`. Backend change required for D17. |
| **Backend** | server.js 8374–8411 (GET, POST, DELETE, reorder, publish). All use `requireAdmin`. No new routes. | server.js 8849–8886 (GET admin, POST upsert). No changes. | server.js 8333–8364 (GET public, POST Multer, PUT, DELETE). **D17 requires a surgical fix to `PUT /api/admin/highlights/:id`**. |
| **Frontend markup** | admin.html 5854–5939. Two cards, no tab bar. | admin.html 5942–6032. Two cards, no tab bar. | admin.html 6035–6132. Two cards, no tab bar. |
| **Frontend JS** | `processHomeFiles()` 8129, `fetchHomeSlider()` 8224, `renderHomeList()` 8234, `initDraggableSlider()` 8276, `$('#homeForm').on(submit)` 8329, `$('#publishHomeBtn').on(click)` 8367 | `updateAboutPreview()` 8396, `loadAboutData()` 8413, `$('#aboutForm').on(submit)` 8430, `$('#aboutFile').on(change)` 8472, Quill init ~17808 | `initCareerYears()` 9160, `loadHighlights()` 9169, `.remove-career-action` 9229, `editingHighlightId` var 9239, `.edit-career-action` 9241, `$('#careerForm').on(submit)` 9267 |
| **Shared infra (no changes)** | `uploadFileToServer()` 8113, `apiCall()` ~10345, `notificationService`, `initTabs()` 17154, `.atl-tab-bar`/`.um-panel` CSS 1708–1720 |

---

## 3. Confirmed defects (found by direct file read, line-cited)

Fix each defect as part of the phase for its section. None of these is hypothetical.

| # | Section | Defect | Evidence |
|---|---|---|---|
| D1 | `#homeAdmin` | **`#clearHomeBtn` has no click handler.** The button's visibility is managed (`show()` at 8249, `hide()` at 8245) but no click handler exists anywhere in the file. Clicking it does nothing. | admin.html grep: only occurrences are markup (5927) and show/hide calls (8245, 8249). |
| D2 | `#homeAdmin` | **`fetchHomeSlider()` silently swallows load failures.** Uses raw `fetch()`, catch block is console-only. Slider list appears blank/stale on failure with no user-visible explanation. | admin.html 8224–8232. |
| D3 | `#homeAdmin` | **`processHomeFiles()` and URL-submit path POST to `/api/admin/home-slider` without checking `res.ok`.** A server 400/500 is silently ignored and the function still shows "Added!". | admin.html 8143, 8351. Compare: `publishHomeBtn` at 8373 correctly checks `data.success`. |
| D4 | `#homeAdmin` | **Drag-reorder `fetch` at 8296 has no `res.ok` check and catch is console-only.** A failed reorder silently presents as successful — the UI shows the new order but the DB retains the old one. | admin.html 8289–8303. |
| D5 | `#homeAdmin` | **Empty state overrides `.um-empty-state` class styles with hardcoded inline colours** (`#222` border, `#333` icon, `#555` text). These break in light mode. | admin.html 8240–8243. |
| D6 | `#homeAdmin` | **`.um-slider-card` has zero CSS rules** in any file. All visual properties are inline. Prevents theming. | grep of admin.html, redesign.css, style.css returns no `.um-slider-card` rule. |
| D7 | `#homeAdmin` | **Hardcoded hex in `renderHomeList()` JS-generated markup:** `#161616` (card bg), `#222` (border), `#eee` (filename), `#666` (file-size). All fail to re-theme. | admin.html 8252–8262. |
| D8 | `#homeAdmin` | **Hardcoded `#1a1800` in drag-enter/dragover handlers** as the drop-zone active background. | admin.html 8187, 8195. |
| D9 | `#aboutAdmin` | **`loadAboutData()` catch conflates "no data exists yet" with a real API error.** Both cases reach `console.warn('No About Me data in DB yet.')` — a network failure looks identical to an empty-DB first-run. | admin.html 8425–8427. |
| D10 | `#aboutAdmin` | **`#aboutFile` auto-upload catch is console-only.** If the file upload fails, the admin sees nothing — no error feedback. | admin.html 8487. |
| D11 | `#aboutAdmin` | **Live preview pane uses Bootstrap `row`/`col-sm-5`/`col-sm-7`** — the only place in these three sections where the Bootstrap grid is used instead of the `um-grid-2` system. Structural inconsistency. | admin.html 6016–6025. |
| D12 | `#aboutAdmin` | **Hardcoded `#555` in the "No lead text" fallback** inside the preview pane. Breaks light-mode contrast. | admin.html 6021. |
| D13 | `#careerAdmin` | **`#clearCareerBtn` is always hidden and has no click handler.** The `show()` call is inside the empty/error branch (9176) which also immediately calls `hide()` at 9180 with the comment "Backend handles granular deletes". There is no code path that ever makes the button visible. It is dead markup. | admin.html 6125, 9176, 9180. |
| D14 | `#careerAdmin` | **`loadHighlights()` has no `try/catch` wrapper.** If `apiCall()` throws (session expired, network error, non-JSON), the function crashes with an unhandled promise rejection. No user-visible feedback. | admin.html 9169–9177. |
| D15 | `#careerAdmin` | **`loadHighlights()` calls `/api/public/highlights`** — the unauthenticated public endpoint. All other admin data loads call authenticated routes. Security observation: the data is public biography content, so not an active exploit, but it violates the pattern. Decision gate §5.4. | admin.html 9170. |
| D16 | `#careerAdmin` | **Broken CSS value typo: `color: var(--atl-ink)fff`** (admin.html 9205). Browsers produce an invalid value; the title text colour falls back to the cascade. Fix to `color: var(--atl-ink)`. | admin.html 9205. |
| D17 | `#careerAdmin` | **`PUT /api/admin/highlights/:id` does not update `image_path`** (server.js 8353). The UPDATE sets `year, title, badge, location, description, display_order` only. Editing a career item with a new fallback URL silently ignores the new value. Backend fix required. | server.js 8352–8357. |
| D18 | `#careerAdmin` | **Career CREATE `fetch()` at 9312 has no `res.ok` check.** A server 400/500 response causes the code to fall through to form reset + "Saved Successfully!" because `fetch()` resolves on any HTTP status — it only throws on network failure. | admin.html 9310–9328. |
| D19 | `#careerAdmin` | **No cancel/discard button for edit mode.** Clicking `.edit-career-action` (9241) populates the form and changes the button to "Update Career Highlight". `editingHighlightId` (9239) is reset only on successful submit (9321). There is no exit path short of reloading the page. | admin.html 9241–9264, 9318–9321. |
| D20 | `#careerAdmin` | **`#careerFile` is a plain `<input type="file">` with minimal inline styling** (6090), inconsistent with the `.um-upload-zone` pattern used by `#homeAdmin` (5884) and `#aboutAdmin` (5966). | admin.html 5884, 5966, 6090. |
| D21 | `#careerAdmin` | **Kebab-menu dropdowns in `loadHighlights()` use Bootstrap classes and hardcoded hex:** `btn btn-link dropdown-toggle`, `dropdown-menu dropdown-menu-right`, `background: #282828`, `border: 1px solid #444`, `box-shadow: rgba(0,0,0,0.5)`, delete link `color: #ff4d4d`. Replace with `.atl-actions-dropdown-*` components already in use in `#bookingsAdmin`. | admin.html 9213–9221. |

---

## 4. Non-negotiable constraints

* **Do not rename or remove any existing `id`, `name`, `data-*`, or JS function name** unless it
  is the dead button (`#clearCareerBtn`) confirmed for removal in §5.2, or a class that is being
  replaced by a token-based equivalent with matching behaviour.
* **Do not touch the Quill init block** (`window.aboutQuill1/2/3`, ~17808–17822). Adding a tab
  bar wraps the form container but does not move or rename any Quill target IDs.
* **Do not touch `initDraggableSlider()`** (8276). Its `dataset.dragInit` guard is load-bearing.
* **D17** is a surgical change to `server.js` — touch only the `db.run()` UPDATE statement and
  its parameter array. Do not restructure the route.
* **`uploadFileToServer()` (8113)** is shared across all three sections. Do not alter it — only
  change how callers handle a `null` return value.
* **No new component classes.** Slider cards → `.um-slider-card` (new CSS rule in inline
  `<style>`, following the `.um-*` system). Career cards → `.um-career-card` (same). Kebab menus
  → `.atl-actions-dropdown-*` already in `#bookingsAdmin`. Upload zone → `.um-upload-zone` in
  `redesign.css` 5535+. All other surfaces → existing `.atl-*` / `--atl-*` tokens.
* **`apiCall()` as the standard** for all authenticated admin data fetches — replace every raw
  `fetch()` that targets an admin route. The only legitimate remaining raw `fetch()` calls after
  this prompt are: `uploadFileToServer()` (goes to `/upload`, not the admin API) and career
  CREATE `POST` (multipart `FormData` — `apiCall()` forces `Content-Type: application/json`).

---

## 5. Decision gates — confirm with Muzi before implementing

1. **D1 — `#clearHomeBtn`:** Implement as a real "delete all slides" action (with a
   `showConfirm({isDestructive:true})`) — or remove the button entirely since per-item delete
   buttons already cover the use case?
2. **D13 — `#clearCareerBtn`:** The inline comment ("Backend handles granular deletes") strongly
   implies intentional removal. Confirm before deleting from markup.
3. **`fetchHomeSlider()` → `apiCall()`:** This function calls `GET /api/admin/home-slider` (an
   authenticated admin route). Converting it to `apiCall()` is the correct standardisation (D2
   fix). Confirm there is no reason it was left as raw `fetch()`.
4. **D15 — `loadHighlights()` public endpoint:** Add a `GET /api/admin/highlights` route with
   `requireAdmin`, or accept the existing public endpoint for admin reads since the data is
   publicly visible biography content?

---

## 6. Shared foundation (build first)

If `atelier-contact-social-newsletter-inquiries-prompt.md` has already been executed, its §6
foundation (`.um-pagination-btns` CSS and About-tab skeleton) is already in place. Skip §6.1
and §6.2 below and go straight to §6.3.

### 6.1 Pagination CSS
If not already added: define `.um-pagination-btns` and `.um-pagination-info` per the previous
prompt's §6.1 spec (in the inline `<style>` block).

### 6.2 About-tab skeleton (reusable across all sections)
```html
<div id="{section}AboutPanel" class="um-panel">
    <div class="atl-card">
        <div class="um-icon-header" style="margin-bottom:16px;">
            <div class="um-icon-header__icon"><i class="fa-solid fa-circle-info"></i></div>
            <div>
                <h4 class="um-section-label">About This Section</h4>
                <p class="um-section-desc">{one-line purpose}</p>
            </div>
        </div>
        <hr class="um-divider" style="margin-top:0;">
        <!-- purpose / controls / workflow / security note blocks per this template -->
    </div>
</div>
```
Add a matching `<button class="atl-tab-btn" data-um-tab="{section}AboutPanel">About</button>`
to each section's tab bar, always last. `initTabs()` (17154) handles all wiring automatically.

### 6.3 `.um-slider-card` CSS class (new, fixes D6 + D7)
Add to the inline `<style>` block — do not create a new `<style>` tag:

```css
.um-slider-card {
    background: var(--atl-card);
    border: 1px solid var(--atl-line);
    border-radius: var(--atl-r-sm);
    overflow: hidden;
    display: flex;
    align-items: center;
    gap: 15px;
    padding: 12px;
    transition: background 0.2s ease;
    cursor: grab;
}
.um-slider-card:active { cursor: grabbing; }
.um-slider-card:hover  { background: var(--atl-surface2); }
.um-slider-card__thumb {
    width: 80px; height: 50px;
    background: var(--atl-paper);
    border-radius: 4px; overflow: hidden; flex-shrink: 0;
}
.um-slider-card__thumb img { width: 100%; height: 100%; object-fit: cover; }
.um-slider-card__name  { color: var(--atl-ink); font-weight: 500; font-size: 13px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.um-slider-card__meta  { color: var(--atl-muted-dim); font-size: 11px;
    display: flex; gap: 10px; margin-top: 2px; }
```

### 6.4 Drag-zone active state CSS (fixes D8)
Add to the inline `<style>` block:
```css
.um-upload-zone--dragging {
    border-color: var(--atl-amber) !important;
    background: rgba(212,175,55,0.06) !important;
}
```
In drag-enter/dragover handlers: `zone.classList.add('um-upload-zone--dragging')`.
In dragleave/drop: `zone.classList.remove('um-upload-zone--dragging')`.
Remove all `zone.style.background = '#1a1800'` and `zone.style.borderColor = 'var(--atl-amber)'`
inline style assignments.

---

## 7. Phase 1 — `#homeAdmin` (simplest; do first)

### 7.1 Tasks

**T1 — Fix D1 (`#clearHomeBtn` unwired).** Per §5.1 decision: implement or remove.
If implementing: fire `window.notificationService.showConfirm({ title: 'Clear Slider',
message: 'Permanently remove all slider images?', isDestructive: true })`, then call
`apiCall('/api/admin/home-slider/' + id, 'DELETE')` for each item ID read from
`$('#adminHomeList .um-slider-card').map(...)`. On success call `fetchHomeSlider()`.
If removing: delete markup (5927–5929) and the two show/hide calls (8245, 8249).

**T2 — Fix D2 + D3 + D4 (raw `fetch()` → error-checked calls).** Per §5.3 decision:
* `fetchHomeSlider()` (8224): convert to `apiCall('/api/admin/home-slider')` in try/catch that
  calls `notificationService.showError('Could not load slider items — please refresh.')`.
* `processHomeFiles()` POST at 8143: add `if (!res.ok) throw new Error(await res.text() || 'Server
  error')` after each `await fetch(...)` inside the loop. The outer catch already calls
  `notificationService.showError`.
* URL-submit path POST at 8351: same `if (!res.ok) throw new Error(...)` after `await fetch`.
* Drag-reorder at 8296: add `if (!res.ok) window.notificationService.showError('Reorder failed —
  please refresh and try again.')` inside the try, after `await fetch`.
* `.remove-home-btn` DELETE (8324): already checks `res.ok` for the success path; add
  `else { window.notificationService.showError('Could not remove slide.'); }` for the failure case.

**T3 — Fix D5 (empty state inline overrides).** Remove inline style overrides from the
`.um-empty-state` div at 8240–8243. The redesign.css rule (line 5439) provides base styling.
Replace icon color `#333` with `var(--atl-muted-dim)` (inline or via the class). Replace
text color `#555` with `var(--atl-muted)`. Replace `border: 1px dashed #222` with
`border: 1px dashed var(--atl-line)`.

**T4 — Fix D6 + D7 (`.um-slider-card` inline styles → CSS class).** After §6.3 adds the CSS,
update `renderHomeList()` (8250–8270) to use structured markup:
```html
<div class="um-slider-card" draggable="true" data-id="${item.id}">
    <div class="um-slider-card__thumb">
        <img src="${item.url}" onerror="this.src='https://placehold.co/100x100/111/EEE?text=Error'" alt="${item.alt || ''}">
    </div>
    <div style="flex:1; min-width:0;">
        <div class="um-slider-card__name">${item.file_name || 'Web URL Image'}</div>
        <div class="um-slider-card__meta">
            <span>${item.file_size || 'Unknown size'}</span>
            ${item.uploader_name ? `<span>• By ${item.uploader_name}</span>` : ''}
        </div>
    </div>
    <div style="display:flex; gap:8px;">
        <button class="um-btn um-btn--danger um-btn--sm remove-home-btn" data-id="${item.id}" title="Remove" style="padding:6px; height:32px; width:32px;">
            <i class="fas fa-trash-alt"></i>
        </button>
    </div>
</div>
```
No inline style on the card wrapper itself. All hardcoded hex removed.

**T5 — Fix D8 (drag-zone `#1a1800`).** Per §6.4: replace all `zone.style.background = '#1a1800'`
and `zone.style.borderColor = 'var(--atl-amber)'` at 8187/8195 with
`zone.classList.add('um-upload-zone--dragging')`, and in dragleave/drop reset with
`zone.classList.remove('um-upload-zone--dragging')`. Remove the corresponding `zone.style.borderColor = ''`
and `zone.style.background = ''` reset lines — they are replaced by the class remove.

**T6 — Add tab bar + About tab.** Wrap the existing `um-grid-2` layout block in
`<div id="homeConfigPanel" class="um-panel active">`. Add `<div id="homeAboutPanel" class="um-panel">`
(§6.2 skeleton). Insert `.atl-tab-bar` between `.atl-section-rule` and the first panel.

About tab content for `#homeAdmin`: purpose of the section (homepage hero carousel); how to add
images (upload or URL); alt text applies to all files in a batch; images are auto-resized to max
1200px server-side; drag-to-reorder persists immediately to the database; "Publish to Homepage"
writes new `<img>` tags directly into `index.html` on disk — this is a file system write, not
just a DB update; individual delete is instant; the Clear All option (if implemented) removes all
slides and cannot be undone.

### 7.2 Hard constraints specific to this phase
* `#homeFile`, `#homeUrl`, `#homeAlt`, `#homeSubmitBtn`, `#publishHomeBtn`, `#adminHomeList`,
  `#clearHomeBtn` (or the markup replacing it) — IDs unchanged.
* `initDraggableSlider()` targets `document.getElementById('adminHomeList')` — container must not
  be renamed. The `dataset.dragInit` guard must survive.

---

## 8. Phase 2 — `#aboutAdmin`

### 8.1 Tasks

**T1 — Fix D9 (conflated catch in `loadAboutData()`).** Replace the catch block at 8425–8427:
```js
} catch(e) {
    // Distinguish genuine "no record yet" (404) from real errors
    const isNotFound = e && e.message && (e.message.includes('404') || e.message.includes('not found'));
    if (!isNotFound) {
        console.error('Failed to load About Me data:', e);
        window.notificationService.showError('Could not load About Me content — please refresh.');
    } else {
        console.info('No About Me record exists yet — first-run state.');
    }
}
```

**T2 — Fix D10 (auto-upload silent failure).** In `$('#aboutFile').on('change', ...)` (8472),
replace the catch at 8487:
```js
} catch(e) {
    console.error('Auto upload failed:', e);
    window.notificationService.showError('Photo upload failed — please try again or use the URL fallback field.');
}
```

**T3 — Fix D11 (Bootstrap grid → `um-grid-2`).** Replace the Bootstrap grid inside the preview
card's `.live-preview-box` (admin.html 6016–6025):
```html
<!-- BEFORE -->
<div class="row">
    <div class="col-sm-5 text-center">...</div>
    <div class="col-sm-7" style="color: var(--atl-ink-dim);">...</div>
</div>

<!-- AFTER -->
<div class="um-grid-2 um-grid-2--5-7">
    <div style="text-align:center;">...</div>
    <div style="color:var(--atl-ink-dim);">...</div>
</div>
```
All four preview IDs (`#previewAboutImg`, `#previewAboutP1`, `#previewAboutP2`, `#previewAboutP3`)
stay exactly where they are inside their respective columns.

**T4 — Fix D12 (`#555` in preview fallback).** On admin.html 6021, change
`<em style="color:#555;">No lead text provided yet.</em>` to
`<em style="color:var(--atl-muted);">No lead text provided yet.</em>`.

**T5 — Add tab bar + About tab.** Wrap the `um-grid-2` block as
`<div id="aboutConfigPanel" class="um-panel active">`, add
`<div id="aboutAboutPanel" class="um-panel">`, insert `.atl-tab-bar` between
`.atl-section-rule` and the first panel.

About tab content for `#aboutAdmin`: purpose (biography and profile photo visible on the public
site); Paragraph 1 is the lead/intro and is styled larger than P2/P3; the live preview updates
as you type; submitting with empty Quill editors saves blank content to the DB — fill all fields
before saving or they will appear blank on the public site; photo can be uploaded (takes priority)
or set via URL fallback; the backend strips `<script>`, `<iframe>`, `<form>`, and `on*` event
handlers via `sanitizeAboutHtml()` — rich formatting (bold, italic, lists, links) is preserved.

### 8.2 Hard constraints specific to this phase
* `#aboutFile`, `#aboutUrl`, `#aboutSubmitBtn`, `#aboutVideoWarning`, `#previewAboutImg`,
  `#previewAboutP1/P2/P3`, `#aboutEditorP1/P2/P3` — all IDs unchanged.
* Quill init block (~17808–17822) and `window.aboutQuill1/2/3` references — untouched.
* `updateAboutPreview()` (8396) must remain callable from the `text-change` handlers at 17817.

---

## 9. Phase 3 — `#careerAdmin` (most changes; do last)

### 9.1 Tasks

**T1 — Fix D13 (`#clearCareerBtn` dead markup).** Per §5.2 decision: remove the button from
markup (6125–6127) and both `$('#clearCareerBtn').hide()` calls (9176, 9180). If Muzi wants to
preserve the option: leave the button in markup but add a proper click handler with
`showConfirm({isDestructive:true})` and a loop calling `apiCall('/api/admin/highlights/' + id,
'DELETE')` for each rendered item. Do not leave the button visible but unwired.

**T2 — Fix D14 (`loadHighlights()` missing try/catch).** Wrap the entire function body:
```js
async function loadHighlights() {
    try {
        const data = await apiCall('/api/public/highlights'); // route per §5.4 decision
        var $list = $('#adminCareerList');
        $list.empty();
        if (data.error || !Array.isArray(data) || data.length === 0) {
            $list.html('<div class="atl-empty-state"><i class="fa-solid fa-star-half-stroke"></i><p>No career highlights yet.</p><p class="atl-empty-sub">Add your first highlight using the form.</p></div>');
            return;
        }
        // ... rest of render logic unchanged ...
    } catch(err) {
        console.error('Failed to load career highlights:', err);
        window.notificationService.showError('Could not load career highlights — please refresh.');
        $('#adminCareerList').html('<div class="atl-empty-state"><i class="fa-solid fa-circle-exclamation"></i><p>Failed to load highlights.</p></div>');
    }
}
```
Replace the old `<p class="text-muted">` empty state with the proper `.atl-empty-state` markup
(already globally defined in `redesign.css` 5439).

**T3 — Fix D16 (CSS typo one-character fix).** On admin.html line 9205, change:
`color: var(--atl-ink)fff;` → `color: var(--atl-ink);`
Re-grep the line number before editing — this is a single-character change with high blast radius
if applied to the wrong line.

**T4 — Fix D17 (backend PUT missing `image_path`).** In `server.js` at lines 8351–8357, make the
following surgical change — only the `db.run()` call and its surrounding destructuring change:
```js
// BEFORE:
app.put('/api/admin/highlights/:id', requireAdmin, (req, res) => {
    const { year, title, badge, location, description, display_order } = req.body;
    db.run("UPDATE career_highlights SET year = ?, title = ?, badge = ?, location = ?, description = ?, display_order = ? WHERE id = ?",
        [year, title, badge, location, description, display_order, req.params.id], function(err) {

// AFTER:
app.put('/api/admin/highlights/:id', requireAdmin, (req, res) => {
    const { year, title, badge, location, description, display_order, fallback_url } = req.body;
    const hasFallback = typeof fallback_url === 'string' && fallback_url.trim() !== '';
    const sql = hasFallback
        ? "UPDATE career_highlights SET year=?,title=?,badge=?,location=?,description=?,image_path=?,display_order=? WHERE id=?"
        : "UPDATE career_highlights SET year=?,title=?,badge=?,location=?,description=?,display_order=? WHERE id=?";
    const params = hasFallback
        ? [year, title, badge, location, description, fallback_url.trim(), display_order, req.params.id]
        : [year, title, badge, location, description, display_order, req.params.id];
    db.run(sql, params, function(err) {
```
The response shape (`{ success: true }` / error) is unchanged.

**T5 — Fix D18 (career form raw `fetch()` + no `res.ok`).** In `$('#careerForm').on('submit')`
(9267):
* **PUT path** (edit, text-only, 9305): replace `await fetch(url, { method: 'PUT', headers: ...,
  body: JSON.stringify(jsonBody) })` with `await apiCall(url, 'PUT', jsonBody)`. `apiCall()`
  throws on non-2xx, existing outer catch covers it.
* **POST path** (create, FormData, 9312): keep raw `fetch()` (required for multipart) but add:
  ```js
  const res = await fetch(url, { method: 'POST', body: formData });
  if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || 'Upload failed — server returned ' + res.status);
  }
  ```

**T6 — Fix D19 (no cancel button for edit mode).** Add immediately after `#careerSubmitBtn`
in the markup (6106–6108):
```html
<button type="button" class="atl-btn atl-btn--ghost" id="careerCancelEditBtn"
    style="display:none; width:100%; justify-content:center; margin-top:8px;">
    <i class="fa-solid fa-xmark"></i> Cancel Edit
</button>
```

Wire in JS (add after the existing `.edit-career-action` handler block):
```js
$('#careerCancelEditBtn').on('click', function() {
    editingHighlightId = null;
    $('#careerForm')[0].reset();
    initCareerYears();
    $('#careerSubmitBtn')
        .text('Add Highlight')
        .removeClass('btn-admin-warning')
        .addClass('btn-admin-primary')
        .prop('disabled', false);
    $('#careerCancelEditBtn').hide();
});
```

In `.edit-career-action` handler (9241), after the line that changes submit button text (9259):
```js
$('#careerCancelEditBtn').show();
```

In the form submit handler, after `editingHighlightId = null` at 9321:
```js
$('#careerCancelEditBtn').hide();
```

**T7 — Fix D20 (`#careerFile` plain input → `.um-upload-zone`).** Replace lines 6088–6093:
```html
<!-- BEFORE -->
<div class="um-field-group">
    <label class="um-label" for="careerFile">Upload Highlight Image (Optional)</label>
    <input type="file" id="careerFile" accept="image/*" style="color: var(--atl-ink-dim); font-size:13px;">
    ...
</div>

<!-- AFTER -->
<div class="um-field-group">
    <label class="um-label">Upload Highlight Image (Optional)</label>
    <label for="careerFile" class="um-upload-zone">
        <i class="fa-solid fa-image um-upload-icon"></i>
        <p class="um-upload-text">Drag &amp; drop or click to upload</p>
        <input type="file" id="careerFile" class="um-file-input" accept="image/*">
    </label>
    <small id="careerVideoWarning" style="display:none; color:var(--atl-clay); font-size:12px; margin-top:4px;">
        Videos cannot be uploaded directly. Please use the Web URL field below.
    </small>
    <small style="color:var(--atl-muted-dim); font-size:12px; margin-top:4px; display:block;">
        Will scale automatically. Huge files are fine.
    </small>
</div>
```
The `#careerFile` ID is on the `<input>` — all existing JS references at 9270, 9319, 9338 still
resolve. Add the `um-upload-zone--dragging` class toggle (§6.4) to this zone's drag event
listeners, matching the pattern established in `#homeAdmin`.

**T8 — Fix D21 (Bootstrap kebab menus → `.atl-actions-dropdown-*`).** In `loadHighlights()`
(9213–9221), replace the Bootstrap dropdown with the platform's dropdown system. The
`data-id` and `data-json` attributes on the action `<a>` elements must survive — they are the
only identifiers for `.edit-career-action` and `.remove-career-action` event handlers:
```html
<div style="position:relative; padding-left:15px;">
    <button class="atl-actions-dropdown-btn" aria-haspopup="true" aria-expanded="false">
        <i class="fa-solid fa-ellipsis-vertical"></i>
    </button>
    <div class="atl-actions-dropdown-panel">
        <a href="#" class="atl-actions-dropdown-item edit-career-action"
            data-id="${item.id}"
            data-json='${JSON.stringify(item).replace(/'/g, "&#39;")}'>
            <i class="fa-solid fa-pencil"></i> Edit
        </a>
        <div class="atl-actions-dropdown-sep"></div>
        <a href="#" class="atl-actions-dropdown-item atl-actions-dropdown-item--danger remove-career-action"
            data-id="${item.id}">
            <i class="fa-solid fa-trash"></i> Delete
        </a>
    </div>
</div>
```

**T9 — Fix D21 continued — hardcoded hex in career card body.** Define a CSS class for career
list items (add to inline `<style>` block):
```css
.um-career-card {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    padding: 16px;
    background: var(--atl-card);
    border-radius: var(--atl-r-md);
    margin-bottom: 14px;
    border: 1px solid var(--atl-line);
    transition: background 0.25s ease;
}
.um-career-card:hover { background: var(--atl-surface2); }
.um-career-card__thumb {
    position: relative; width: 180px; height: 101px; flex-shrink: 0;
    background: var(--atl-paper); border-radius: var(--atl-r-sm);
    overflow: hidden; border: 1px solid var(--atl-line);
}
.um-career-card__thumb img { width: 100%; height: 100%; object-fit: cover; }
.um-career-card__video-badge {
    position: absolute; bottom: 4px; right: 4px;
    background: var(--atl-amber); color: var(--atl-paper);
    font-size: 11px; padding: 2px 6px; border-radius: 4px; font-weight: bold;
}
.um-career-card__title {
    font-size: 16px; color: var(--atl-ink); margin-bottom: 8px;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
    overflow: hidden; line-height: 1.3; font-family: var(--f-display);
    letter-spacing: 0.02em;
}
.um-career-card__subtitle { color: var(--atl-amber); font-size: 13px; margin-bottom: 8px; font-weight: 500; }
.um-career-card__desc { font-size: 13px; color: var(--atl-muted); font-weight: 300; line-height: 1.6; max-height: 42px; overflow: hidden; }
```

Update the `loadHighlights()` HTML template to use these classes instead of inline styles. Note:
`var(--y-base)` (currently used for subtitle and video badge colors) resolves correctly via
`redesign.css` line 25 — replace with `var(--atl-amber)` in the new class definitions to
consolidate onto the `--atl-*` token system.

**T10 — Add tab bar + About tab.** Wrap the `um-grid-2` block as
`<div id="careerConfigPanel" class="um-panel active">`, add
`<div id="careerAboutPanel" class="um-panel">`, insert `.atl-tab-bar` with two tab buttons.

About tab content for `#careerAdmin`: purpose (career timeline displayed on the public site);
required fields (Year and Title are required; Badge, Location, and Image/URL are optional);
display ordering (sorted by year descending, then by creation date — no drag-to-reorder UI
exists yet); the Edit mode and how to use the new Cancel button; image-on-edit limitation — the
edit form (PUT route) updates text fields and optionally the fallback URL; uploading a brand-new
file while in edit mode is not supported via the PUT route (the backend's PUT has no Multer
middleware), so image replacement requires either using the URL fallback field or deleting and
recreating the highlight; the kebab menu's Delete action is immediate and irreversible.

### 9.2 Hard constraints specific to this phase
* `#careerYear`, `#careerTitle`, `#careerBadge`, `#careerLocation`, `#careerDesc`, `#careerUrl`,
  `#careerFile`, `#careerSubmitBtn`, `#adminCareerList`, `#careerVideoWarning` — all IDs unchanged.
* `editingHighlightId` must remain a `var` (not `let`/`const`) — it is set and read across
  multiple separately-bound event handlers.
* `initCareerYears()` (9160) must remain callable from both the module load (9167) and from after
  form reset (9320) and from the new cancel handler (T6).
* `.edit-career-action` reads `data-json` (9243) — the JSON template string at 9218 with
  `.replace(/'/g, "&#39;")` must survive in T8's replacement markup.

---

## 10. Acceptance criteria

- [ ] **`#homeAdmin`:** `#clearHomeBtn` resolved per §5.1. All slider API calls check for failure
      and surface via `notificationService`. `.um-slider-card` styled via CSS class — no inline
      styles on the card or its children. Empty state uses only `.atl-empty-state` — no inline
      colour overrides. No `#1a1800` anywhere. Tab bar + About tab present.
- [ ] **`#aboutAdmin`:** Load failure distinguished from empty-DB state via catch logic. File
      auto-upload failure surfaces via `notificationService`. Preview uses `um-grid-2` — no Bootstrap
      grid. `#555` replaced with `var(--atl-muted)`. Tab bar + About tab present.
- [ ] **`#careerAdmin`:** `#clearCareerBtn` resolved per §5.2. `loadHighlights()` wrapped in
      try/catch with error toast. `var(--atl-ink)fff` typo fixed. `PUT` route persists
      `fallback_url` to `image_path` when supplied. Career form never reports false success on
      server error. Cancel-edit button added and functional. `#careerFile` uses `.um-upload-zone`.
      Kebab menus use `.atl-actions-dropdown-*`. Career cards styled via `.um-career-card` CSS
      class — all hardcoded hex removed from the HTML template string. Tab bar + About tab present.
- [ ] **Zero functional regressions** across all three sections.
- [ ] No new hardcoded hex in any edited block. All new CSS uses `--atl-*` tokens.
- [ ] All §5 decision gates resolved with Muzi's input or left in current state pending that input.

---

## 11. Test matrix

| Scenario | `#homeAdmin` | `#aboutAdmin` | `#careerAdmin` |
|---|---|---|---|
| **Normal** | Upload 3 images, confirm all appear; drag-reorder, reload, confirm order persisted; Publish to Homepage, open `index.html`, confirm carousel updated | Type P1/P2/P3, watch preview update in real time; upload a photo; submit; reload section, confirm data persisted | Add a highlight with year + title only; add another with all fields including image; both appear correctly year-ordered |
| **Edit** | Delete an individual slide; confirm list refreshes | Change URL fallback, submit — preview + DB path update | Edit a career item, change the location; save — confirm only location changed. Edit again, add a fallback URL — confirm image path updated in DB (D17 regression test) |
| **Cancel** | N/A | N/A | Click Edit; click Cancel; form resets to blank, button reads "Add Highlight", `editingHighlightId` is null |
| **Failure** | Force 500 from `POST /api/admin/home-slider` — confirm `notificationService.showError` fires, not silent "Added!" (D3 test). Force 500 from reorder — error toast appears (D4 test) | Force a non-404 5xx error from `GET /api/admin/about-me` — error toast fires, not the "no data" silent path (D9 test) | Force 500 from `PUT /api/admin/highlights/:id` — error toast fires, form not reset, "Saved Successfully!" not shown (D18 test) |
| **Regression** | Publish after reorder — `index.html` still regenerates correctly. Drag init guard — drag still works on second `fetchHomeSlider()` call | All three Quill editors still initialise; still fire `updateAboutPreview` on keystroke; data round-trips through save/load | Year dropdown still re-populates after submit. Kebab Edit/Delete still work after T8. Video URL → YouTube thumbnail still renders |
| **Theme** | Slider cards re-theme correctly in light mode — no residual `#161616`/`#222` | Preview pane re-themes — `#555` gone | Career cards re-theme — all hardcoded hex replaced, video badge readable in light mode |

---

## 12. Suggested order of work

1. **§6 Shared foundation** — `.um-slider-card` CSS, `.um-career-card` CSS, drag-zone class.
   These must exist before any JS references them.
2. **§7 `#homeAdmin`** — validates the raw-`fetch()` → checked-`fetch()`/`apiCall()` migration
   pattern and the CSS-class-extraction approach before they're applied in the more complex career
   section.
3. **§8 `#aboutAdmin`** — straightforward catch-block improvements and one Bootstrap grid
   removal; lowest risk of all three phases.
4. **§9 `#careerAdmin`** — recommended sub-order within the phase:
   T1 (dead button) → T2 (try/catch) → T3 (typo, one character) → T4 (backend PUT, server.js) →
   T5 (res.ok) → T6 (cancel button) → T7 (upload zone) → T8+T9 (dropdown + tokens) → T10 (tabs).
   Verify T4 independently against the DB before moving to T5.
5. **Full §10 + §11 pass** across all three sections before declaring done.

> **Pair with:** `atelier-contact-social-newsletter-inquiries-prompt.md` (shared foundation;
> this prompt extends that standard to three more sections). `atelier-admin-standardization-prompt.md`
> should run after both functional-gap prompts have landed, so its bulk hex-replacement pass does
> not clobber the specific token substitutions made here.
