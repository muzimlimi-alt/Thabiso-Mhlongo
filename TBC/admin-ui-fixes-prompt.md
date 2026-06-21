# Prompt — Fix recurring UI defects across `@admin.html`

## Objective
Resolve the recurring UI defects that appear across the **entire** `@admin.html` admin — every form, modal, card, search/filter bar, and settings panel — not one component at a time. The same handful of root causes repeats everywhere, so apply the fixes **systemically at the shared layer**: the base input/panel styles and the runtime modal transformer (`showAtelierModal`), which currently restyles the chrome (panel/header/footer) but leaves inner-field padding, scroll position, focus, and child-corner radii unaddressed.

## Design tokens — use these, do not hardcode hex
| Purpose | Token | Value |
|---|---|---|
| Panel / card surface | `--atl-card` | `#1a1a1a` |
| Recessed input well | `--atl-input-bg` | `#0f0f0f` |
| Elevated header/footer | `--atl-surface2` | `#242424` |
| Gold accent / focus border | `--atl-amber` | (existing) |
| Focus glow | `--atl-focus` | (existing) |
| Container radius | `--atl-r-xl` | `16px` |

If a fix needs a colour with no token (e.g. a required-marker red), **add a new token** alongside these rather than inlining a hex.

## Recurring defects and required fixes

### 1. Leading icons collide with field text
Leading icons are absolutely positioned at ~`left:11px`, but inputs keep the default ~`12px` left padding, so the first character/placeholder renders *under* the icon (e.g. "Muzi…" → "uzi…", "Select date…" → "elect date…", phone digits hidden behind the country flag).
**Fix:** every input/select/textarea with a leading icon gets left padding **≥ 36px**; fields with a wider country-flag / dial-code widget get **≥ 56px**. Do this through shared classes (e.g. `.has-leading-icon`, `.has-flag`) applied wherever an icon exists — not per-field overrides. Audit **all** icon fields page-wide: contact, booking modal, global search, table filters, date/time/venue pickers.

### 2. Focus state is invisible (WCAG 2.4.7)
Inputs set `outline:none` with no replacement, so keyboard focus is undetectable.
**Fix:** at the base input rule, give every input/select/textarea a visible focus treatment — `border-color: var(--atl-amber); box-shadow: 0 0 0 3px var(--atl-focus);` (keep `outline:none`; the shadow is the indicator, and it is not blocked by an inline `outline:none`). Tabbing through any form must show the ring on every field.

### 3. Inputs don't separate from their panel
Fields use `background: var(--atl-card)` — the same colour as the surface they sit on — so only a thin border defines them.
**Fix:** inputs/selects/textareas use `background: var(--atl-input-bg)` so each reads as a recessed well. Apply at the base layer.

### 4. Rounded containers with square, unclipped children
Cards/modals round their corners (`--atl-r-xl`), but elevated children — headers, footers, toolbars painted with `--atl-surface2` — have square corners and aren't clipped, so the lighter child paints over the rounded corner and leaves a hard seam.
**Fix:** match each elevated child's corner radii to its container (top-left/top-right on headers, bottom-left/bottom-right on footers). **Do not** use a blanket `overflow:hidden` on panels — footers carry `overflow:visible` so dropdowns/date pickers can escape. Audit every modal and every card with an elevated header or footer bar.

### 5. Required markers are weak and inconsistent
Asterisks are the same muted grey as the label, there's no "* = required" legend, and some fields are marked required without obvious reason (e.g. a notes field).
**Fix:** give required `*` a distinct accent (a dedicated `--atl-required` token, or `--atl-amber`); add a "* = required" legend to forms with several required fields; confirm each `*` is intentional and flag any that look wrong.

### 6. Modals open scrolled past the first labels
A modal can open scrolled down ~one label's height, hiding the first row's labels above the fold while the inputs stay visible.
**Fix:** in `showAtelierModal` (and/or the modal's shown event), reset the scroll container's `scrollTop` to `0` after the transform; add `scroll-margin-top` to fields so an autofocused input can't push its label out of view.

### 7. Polish
Theme the browser scrollbars to the obsidian palette; give "details/notes" textareas a larger `min-height` (3 rows is cramped); ensure two-column field grids collapse to a single column at ≤600px.

## Where to apply — systemic, not piecemeal
- Put **#2**, **#3** and the focus/recessed-well rules on the **global** `input, select, textarea` selectors in the base stylesheet so every section inherits them automatically.
- Put **#1**'s padding on **shared icon classes**, and add those classes wherever a leading icon appears.
- Fix **#4** and **#6** **inside `showAtelierModal`** (and the universal modal CSS) so they're corrected at the source the per-component bugs come from — then they hold for every current and future modal.
- Sweep the whole file: do not stop at the booking modal and the Contact page.

## Constraints
- Reuse existing tokens; add new tokens (don't inline hex) if a colour is missing.
- Preserve the footer's `overflow:visible`.
- Change layout/spacing only as far as each fix requires.
- Prefer fixing values at the source over `!important`; only reach for `!important` if you must override the transformer's inline styles and cannot reach the source.

## Acceptance criteria
- [ ] No first character or placeholder sits under a leading icon anywhere (email, name, phone/flag, venue, date, time, search).
- [ ] Keyboard-tab through every form → a visible amber focus ring on each field.
- [ ] Every input reads as a recessed well, distinct from its card/panel.
- [ ] No modal or card shows a squared corner or seam where an elevated header/footer meets a rounded container; dropdowns/pickers still escape footers.
- [ ] Required asterisks are visually distinct; a legend appears where multiple required fields exist.
- [ ] Modals open scrolled to top with the first labels visible.
- [ ] At ≤600px, two-column field grids stack to one column; scrollbars match the dark theme.

## Deliverable
Edit the shared styles and `showAtelierModal` in `@admin.html` directly. Return a short summary of which selectors/functions changed and confirm each acceptance-criteria box.
