# admin.html — UI defect fix prompt

## What this prompt is for
Fix every recurring UI defect across the entire `admin.html` admin interface — every form, modal, card, filter bar, and settings panel — in one pass. The same root causes repeat everywhere. Apply fixes **systemically at the shared layer** (base input styles, shared classes, `showAtelierModal`) so every current and future component inherits them automatically, rather than patching one component at a time.

---

## Design system — tokens and values

Use these tokens throughout. Do not hardcode hex values. Add new tokens to this list rather than inlining colours.

| Token | Value | Purpose |
|---|---|---|
| `--atl-card` | `#1a1a1a` | Panel / card surface |
| `--atl-input-bg` | `#0f0f0f` | Recessed input well |
| `--atl-surface2` | `#242424` | Elevated header / footer bars |
| `--atl-amber` | (existing) | Gold accent, focus border |
| `--atl-focus` | (existing) | Focus glow (box-shadow) |
| `--atl-border` | (existing) | Default border colour |
| `--atl-r-xl` | `16px` | Container corner radius |
| `--atl-r-sm` | (existing) | Small element radius |
| `--atl-required` | add → `var(--atl-amber)` | Required asterisk accent — add this token |

Breakpoints used in this file:

| Name | Value | Use |
|---|---|---|
| Mobile base | default (no query) | ≤ 599px — design target |
| Tablet | `min-width: 600px` | ≥ 600px scale-up |
| Desktop | `min-width: 1024px` | ≥ 1024px scale-up |

---

## Defects and required fixes

### 1 — Leading icons collide with field text *(Critical)*

**Root cause:** Icons are absolutely positioned at `left: 11px`. Inputs keep the default `~12px` left padding, so the first character or placeholder renders underneath the icon.

**Confirmed affected fields:** Form Delivery Email, Manager Name, Manager Email, Manager Cell, Manager WhatsApp, Event Date, Start Time, Venue / Location, the global search bar, the Bookings filter search input.

**Fix:**
- Create two shared classes: `.has-leading-icon` (single icon, e.g. envelope, person, magnifier) and `.has-flag-input` (country-flag / dial-code widget, which is wider).
- Apply `.has-leading-icon` to every input that has an icon pinned at `left: ~11px`.
- Apply `.has-flag-input` (or target the phone library's input directly, e.g. `.iti input`) to phone number fields.
- Rules:

```css
.has-leading-icon input,
input.has-leading-icon        { padding-left: 38px; }

.has-flag-input input,
input.has-flag-input,
.iti input                    { padding-left: 58px; }
```

- Do **not** patch fields individually. Apply the class and let the rule do the work.
- After applying, audit every icon field across all pages (contact, bookings, calendar, settings) and confirm no first character is hidden.

---

### 2 — Input wells are invisible against the panel *(High)*

**Root cause:** Inputs use `background: var(--atl-card)` — the same colour as the panel they sit on. Only the thin border separates them from the surface.

**Fix:** Apply at the global base input rule:

```css
input, select, textarea {
  background: var(--atl-input-bg);
}
```

---

### 3 — No visible focus ring (WCAG 2.4.7) *(High)*

**Root cause:** Inputs set `outline: none` inline with no replacement. Keyboard focus is undetectable.

**Fix:** Add to the base input `:focus` rule. `box-shadow` is not blocked by an inline `outline: none`:

```css
input:focus, select:focus, textarea:focus {
  border-color: var(--atl-amber);
  box-shadow: 0 0 0 3px var(--atl-focus);
  outline: none;
}
```

Verify by tabbing through every form — the amber ring must appear on every field.

---

### 4 — Rounded panels with square, unclipped children *(Minor — visible)*

**Root cause:** Cards and modals set `border-radius: var(--atl-r-xl)` on the container, but elevated child bars (headers, footers painted with `--atl-surface2`) have square corners. The lighter child fills in the rounded corner and creates a hard seam.

**Fix:** Match corner radii on the children — do **not** use `overflow: hidden` on the panel (footers carry `overflow: visible` so dropdowns and pickers can escape):

```css
.atl-modal-header, .atl-card-header {
  border-top-left-radius: var(--atl-r-xl);
  border-top-right-radius: var(--atl-r-xl);
}

.atl-modal-footer, .atl-card-footer {
  border-bottom-left-radius: var(--atl-r-xl);
  border-bottom-right-radius: var(--atl-r-xl);
}
```

Use `!important` only if `showAtelierModal` sets these inline and cannot be patched at source.

Apply to **every** modal and every card with an elevated header or footer bar — not only the booking modal.

---

### 5 — Required asterisks are invisible *(Medium)*

**Root cause:** The `*` marker uses the same muted grey as the label text.

**Fix:**
1. Add `--atl-required: var(--atl-amber)` to the token block.
2. Wrap each `*` in `<span class="req">*</span>` where not already done.
3. Apply:

```css
label .req {
  color: var(--atl-required);
  font-weight: 600;
}
```

4. Confirm each required marker is intentional — a required `*` on a notes / details field is unusual. Remove or adjust if not intended.
5. Add a `* = required` legend below the heading on any form with three or more required fields.

---

### 6 — Modals open scrolled past the first row of labels *(Critical)*

**Root cause:** The modal body opens scrolled down ~one label's height, hiding the first row's labels above the fold while the inputs remain visible.

**Fix (CSS half):**

```css
.modal-body                                  { scroll-padding-top: 16px; }
.modal-body label,
.modal-body input,
.modal-body select,
.modal-body textarea                         { scroll-margin-top: 28px; }
```

**Fix (JS — required):** Inside `showAtelierModal`, after the transform completes, reset scroll. Or attach to the Bootstrap shown event globally:

```js
document.querySelectorAll('.modal').forEach(modal => {
  modal.addEventListener('shown.bs.modal', () => {
    const body = modal.querySelector('.modal-body');
    if (body) body.scrollTop = 0;
  });
});
```

---

### 7 — Status filter tab row clips content *(Critical — mobile)*

**Root cause:** `overflow` is not set to auto/scroll on the tab row, and there is no scroll affordance — the tab labelled "Accepted" is clipped mid-word with no visual cue that more tabs exist.

**Fix:**

```css
.atl-status-tabs {
  display: flex;
  gap: 8px;
  overflow-x: auto;
  scroll-snap-type: x mandatory;
  -webkit-overflow-scrolling: touch;
  scrollbar-width: none;
  padding-bottom: 4px;
  -webkit-mask-image: linear-gradient(to right, black 80%, transparent 100%);
          mask-image: linear-gradient(to right, black 80%, transparent 100%);
}
.atl-status-tabs::-webkit-scrollbar { display: none; }
.atl-status-tab {
  flex-shrink: 0;
  scroll-snap-align: start;
  white-space: nowrap;
}
```

Remove the fade mask at `min-width: 600px` and allow tabs to wrap.

---

### 8 — Filter row: search input and select are different heights *(High — mobile)*

**Root cause:** No explicit height or `align-items` on the row — the select renders taller than the search input.

**Fix:**

```css
.atl-filter-row {
  display: flex;
  gap: 8px;
  align-items: center;
}
.atl-filter-row input[type="search"],
.atl-filter-row input[type="text"] {
  flex: 1;
  min-width: 0;
  height: 44px;
}
.atl-filter-row select {
  flex-shrink: 0;
  height: 44px;
}
```

---

### 9 — Booking card: primary CTA buried on second row *(Critical — mobile)*

**Root cause:** No `order` or flex priority set on the action bar — "Mark Completed" wraps below secondary actions.

**Fix:**

```css
.atl-booking-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}
.atl-booking-actions .atl-primary-cta {
  flex: 1;
  order: -1;
  min-width: 160px;
}
```

At `min-width: 600px`: set `flex-wrap: nowrap`.

---

### 10 — Tag chip rows consume excessive vertical space *(Medium — mobile)*

**Fix:** Cap at two rows; expose a "show more" toggle:

```css
.atl-tag-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  max-height: calc(2 * (24px + 6px + 2px));
  overflow: hidden;
}
.atl-tag-chips.expanded { max-height: none; }
```

Add a small JS toggle that adds/removes `.expanded` on the chip container.

At `min-width: 600px`: remove the `max-height` cap entirely.

---

### 11 — Calendar toolbar is cramped and unreadable on mobile *(High — mobile)*

**Root cause:** Navigation arrows, month label, "Today", and Month/Week/List toggle all compete on one line.

**Fix:**

```css
.atl-cal-toolbar    { display: flex; flex-direction: column; gap: 8px; }
.atl-cal-nav-row    { display: flex; align-items: center; justify-content: space-between; }
.atl-cal-view-toggle { display: flex; gap: 4px; justify-content: center; }
```

At `min-width: 600px`: restore `flex-direction: row; align-items: center; justify-content: space-between` on `.atl-cal-toolbar`.

---

### 12 — Touch targets below 44px minimum (WCAG 2.5.5) *(High — mobile)*

**Affected:** calendar sidebar tabs (NAVIGATION / SCHEDULE / UPCOMING), status tab pills, filter chip buttons, any icon-only button.

**Fix:**

```css
button, .atl-btn, .atl-tab-item, .atl-status-tab, a.nav-link {
  min-height: 44px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding-left: 16px;
  padding-right: 16px;
}
```

---

### 13 — Calendar legend chips don't wrap; status legend wastes height *(Medium — mobile)*

**SHOW: chip row:**

```css
.atl-show-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}
```

**Status legend box (Bookings / Other two-row block):**

```css
.atl-cal-legend {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px 16px;
}
```

At `min-width: 1024px`: revert legend to `display: flex; flex-wrap: wrap`.

---

### 14 — Mini-calendar date indicator dots are near-invisible *(Medium — mobile)*

**Root cause:** Dots are ~4px and low-contrast against the dark surface.

**Fix:**

```css
.atl-cal-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--atl-amber);
  opacity: 1;
  margin: 2px auto 0;
}
```

---

### 15 — Service line item blocks lack visual separation *(Medium — all)*

**Fix:** Wrap each SERVICE / QTY / UNIT / TOTAL group in a container:

```css
.atl-line-item {
  border: 1px solid var(--atl-border);
  border-radius: var(--atl-r-sm);
  padding: 12px;
  margin-bottom: 8px;
}
```

---

### 16 — Two-column field grids don't collapse on mobile *(Minor)*

**Fix (mobile-first):**

```css
/* base (mobile) */
.atl-field-grid { grid-template-columns: 1fr; }

/* tablet and above */
@media (min-width: 600px) {
  .atl-field-grid { grid-template-columns: 1fr 1fr; }
}
```

Apply to: booking modal, Contact page, Settings panels, and any other two-column form grid in the file.

---

### 17 — No home-indicator safe area padding *(Minor — mobile)*

**Fix:**

```css
.atl-modal-footer,
.atl-page-bottom,
.modal-body {
  padding-bottom: max(16px, env(safe-area-inset-bottom));
}
```

---

### 18 — Browser-default scrollbar not themed *(Minor)*

**Fix:**

```css
.modal-body, .atl-scroll-container {
  scrollbar-width: thin;
  scrollbar-color: #3a3a3a transparent;
}
.modal-body::-webkit-scrollbar,
.atl-scroll-container::-webkit-scrollbar        { width: 10px; }
.modal-body::-webkit-scrollbar-track,
.atl-scroll-container::-webkit-scrollbar-track  { background: transparent; }
.modal-body::-webkit-scrollbar-thumb,
.atl-scroll-container::-webkit-scrollbar-thumb  {
  background: #3a3a3a;
  border-radius: 8px;
  border: 2px solid var(--atl-card);
}
```

---

## Implementation strategy

Apply fixes in this order, from broadest to narrowest scope:

1. **Token block** — add `--atl-required`.
2. **Global base rules** — fixes 2, 3 (inputs/focus). These cascade everywhere automatically.
3. **Shared classes** — add `.has-leading-icon` and `.has-flag-input` to the stylesheet; mark every affected field in the HTML (fix 1). Confirm all icon fields across all pages.
4. **showAtelierModal** — fix 4 (corner radii) and fix 6 JS (scroll reset) here, not in per-component overrides, so every current and future modal inherits them.
5. **Mobile-first component rules** — fixes 7–18, written base-first (≤599px), scaled up with `min-width: 600px` and `min-width: 1024px`.
6. **HTML** — wrap required `*` in `<span class="req">` (fix 5); add `.has-leading-icon` / `.has-flag-input` classes to relevant inputs; add `.atl-primary-cta` class to primary action buttons; add "show more" toggle JS for tag chips (fix 10).

Prefer fixing values at the source over `!important`. Use `!important` only when overriding `showAtelierModal`'s inline styles and the source cannot be reached.

---

## Acceptance criteria

- [ ] Every icon field across all pages: no first character or placeholder letter is hidden behind an icon (email, name, phone/flag, venue, date, time, search).
- [ ] Keyboard tab through every form shows an amber focus ring on each field.
- [ ] Every input, select, and textarea reads as a visually recessed well distinct from its card or panel.
- [ ] No modal or card has a squared corner or visible seam where an elevated header/footer meets the rounded container. Dropdowns and date pickers still escape modal footers.
- [ ] Required asterisks are amber/gold and visually distinct from label text.
- [ ] Modals open with the first row of labels fully visible (scrollTop = 0).
- [ ] Status tab row on mobile scrolls horizontally with a fade-mask affordance. No tab label is clipped.
- [ ] Search input and status select in the filter row are the same height and vertically centred.
- [ ] On mobile, "Mark Completed" (or the primary CTA) appears on the first action row — never wrapped below secondary actions.
- [ ] All tappable elements (tabs, buttons, chips) meet the 44px minimum touch target.
- [ ] Calendar toolbar on mobile stacks to two rows; the Month/Week/List toggle is centred on its own row.
- [ ] Calendar SHOW: chips wrap freely. Status legend renders in two columns on mobile.
- [ ] Date indicator dots in the mini-calendar are clearly visible (6px, full amber opacity).
- [ ] Service line item groups (SERVICE / QTY / UNIT / TOTAL) are visually separated from one another.
- [ ] All two-column field grids collapse to a single column at ≤599px.
- [ ] Scrollbars are themed to the obsidian palette across all scroll containers.

---

## Deliverable

Edit `admin.html` directly — styles in the existing `<style>` block (or a linked sheet), JS patch in the existing script block alongside `showAtelierModal`. Return a short summary confirming which selectors changed and which acceptance-criteria items are resolved.
