# Atelier Admin — Full Styling Prompt (v2: Global Theme Rollout)

> **Why this is a v2.** The original `atelier-full-admin-styling-prompt.md` was written
> as if the Editorial-Luxe ("atelier") theme still had to be built. It no longer does.
> The token system, the dark **and** light palettes, and a working theme toggle already
> exist in `admin.html` — they are simply **scoped to the Bookings section only**. The job
> has therefore shifted from *"build a theme"* to *"promote the existing theme to a single
> global system, governed by one toggle in the top control bar."* Use this prompt instead
> of the original.

---

## 0. Current state (read before changing anything)

The atelier design system is already present in `admin.html` and is mature:

- **FOUC-safe init.** An inline script in `<head>` reads `localStorage['atl-theme']`
  (default `'dark'`) and sets `data-theme` on `<html>` before paint.
- **Token system.** `--atl-*` custom properties are fully defined for both themes:
  `[data-theme="dark"]`, `[data-theme="light"]`, and a `:root:not([data-theme="light"])`
  fallback. ~223 `var(--atl-*)` references already exist.
- **Working toggle.** `#atlThemeToggle` (a `role="switch"` button with sun/moon icons and a
  sliding knob) flips `data-theme` on `<html>`, persists to `localStorage['atl-theme']`, and
  is wired with **event delegation** on `document` — so it keeps working no matter where the
  button lives in the DOM.
- **Theme-aware JS exists as a model.** `window.statusColors(statusKey)` already returns
  different palettes for light vs dark by reading `data-theme`. Follow this pattern wherever
  colours must be computed in JS rather than CSS.

**The gap.** All of the above is applied **only inside `#bookingsAdmin`**. The token-driven
selectors are namespaced to that section, and the rest of the dashboard does not consume the
tokens. Concretely:

- The global **control bar** (`<header class="adm-header" id="adminControlBar">` — logo,
  search, "New"/notifications/profile cluster) uses its own hardcoded palette.
- The other **19 `.admin-section` panels** (`dashboardAdmin`, `usersAdmin`, `inquiriesAdmin`,
  `calendarAdmin`, `financeAdmin`, `servicesAdmin`, `policiesAdmin`, `homeAdmin`, `aboutAdmin`,
  `careerAdmin`, `galleryAdmin`, `socialAdmin`, `eventsAdmin`, `contactAdmin`, `newsletterAdmin`,
  `preferencesAdmin`, `brandingAdmin`, `emailLogsAdmin`, `securityAdmin`) use hardcoded dark hex.
- Hardcoded dark literals are everywhere: `#1a1a1a` (~59×), `#252525` (~17×), `#0a0a0a` (~8×),
  `#181818`, `#101010`, `#161616`, `#111111`, plus `rgba(255,255,255,…)` hairlines that only
  read correctly on a dark ground.
- Third-party widgets are hard-pinned to dark: **flatpickr** loads `themes/dark.css`
  unconditionally; **Quill** (`.ql-toolbar`, `.ql-editor`) is dark-only; **FullCalendar**,
  **ApexCharts**, and **intl-tel-input** have no light variants.

**Consequence to fix:** the moment the toggle becomes global, switching to **Light** will
re-theme Bookings while leaving everything else dark. The bulk of this task is eliminating
that split.

> **Note on scope I could not see:** the bulk of the hardcoded colour almost certainly also
> lives in the linked stylesheets `css/style.css`, `css/redesign.css`, and `css/notifications.css`,
> which are **not** in scope-of-sight here. Treat those three files as in-scope for the same
> tokenisation pass. `server.js` is **out of scope** — it only stores *public-site* branding
> (`primary_color`, `theme_font`, logos), which is unrelated to the admin dark/light theme.

---

## 1. Primary objective

> **Relocate the dark/light theme toggle out of the Bookings section header and into the global
> top navigation (the admin control bar), so that a single toggle governs the theme of the
> entire admin website — not just the Bookings view.** Then make the rest of the dashboard
> actually obey it.

(The toggle currently sits in the **Bookings section header**, alongside Refresh / New enquiry —
it reads as "the toggle in the booking modal." It is moving up to the persistent control bar.)

---

## 2. Task A — Move the toggle into the control bar

1. **Cut** the `#atlThemeToggle` button (the full `role="switch"` block with the sun/moon SVGs
   and `.atl-theme-toggle__knob`) out of the `#bookingsAdmin` header.
2. **Paste** it into `adm-header__right` in the control bar — place it as the **first** item in
   the utility cluster (before the "New" dropdown), or immediately before the
   `adm-header__divider`, whichever reads cleaner. It must be visible from **every** section.
3. **Do not rewrite the JS.** The click handler and `initThemeToggleUI()` are delegated on
   `document` and key off `data-theme` on `<html>`, so the button works unchanged after the move.
   Verify both still fire post-move.
4. **Reconcile the toggle's own styling with the control bar.** The toggle is styled with
   `--atl-*` tokens (`--atl-card`, `--atl-line`, `--atl-amber`, etc.). Once those tokens are
   global (Task B) it inherits correctly; until then, ensure it does not look orphaned against
   the control bar's current palette.
5. **Mobile/responsive:** confirm it fits the control bar at small widths (the cluster already
   collapses labels via `.adm-btn-label`). Hide the `__label` text on narrow screens if needed,
   keeping the switch itself tappable (≥40px hit target).
6. **A11y:** preserve `role="switch"`, keep `aria-checked` in sync, and ensure it sits in a
   sensible tab order within the control bar.

---

## 3. Task B — Promote `--atl-*` to the global token system

The `--atl-*` definitions are the **single source of truth**. Do not invent a parallel palette.

1. **De-scope the tokens.** Ensure the `--atl-*` custom properties cascade to the whole document
   (they already live on `:root`/`[data-theme]`, so this is mostly about *consuming* them
   everywhere rather than redefining them).
2. **Replace hardcoded dark literals with tokens**, across `admin.html` **and** `style.css`,
   `redesign.css`, `notifications.css`:

   | Hardcoded value(s)                              | Replace with        |
   | ----------------------------------------------- | ------------------- |
   | `#0a0a0a`, `#0f0f0f`, `#101010`, `#111111`      | `var(--atl-paper)` / `var(--atl-input-bg)` (by role) |
   | `#1a1a1a`, `#161616`                            | `var(--atl-card)`   |
   | `#181818`, `#242424`, `#252525`                 | `var(--atl-surface2)` |
   | `#ffffff` body text, `#e0e0e0`                  | `var(--atl-ink)`    |
   | greys `#949494`, `#777`, `#aaa`, `#6b…`         | `var(--atl-muted)` / `var(--atl-placeholder)` |
   | `rgba(255,255,255,0.x)` hairlines/borders       | `var(--atl-line)`   |
   | gold `#D4AF37` / `#E8C14B`                       | `var(--atl-amber)` / `var(--atl-amber-hover)` |
   | status greens/reds/blues                        | `var(--atl-sage|green|clay|blue)` |

   Map **by semantic role**, not by literal match — e.g. an inset field background becomes
   `--atl-input-bg`, an elevated panel becomes `--atl-surface2`, even if both were `#1a1a1a`.
3. **Add smooth transitions.** Surfaces and text that change between themes should transition
   (`background-color`/`color` ~0.3–0.4s), matching the existing `#bookingsAdmin` behaviour,
   but respect `prefers-reduced-motion` (already handled for the bookings subtree — extend it).

---

## 4. Task C — Make the control bar theme-aware

The `adm-*` control bar is a parallel design language and must now flex with the theme:

- Map `adm-header` background, the search field (`adm-search__input`), dropdown menus
  (`adm-dropdown__menu`, `adm-dropdown__item`), notification list, the profile card, badges,
  dividers, and the `kbd` shortcut chip onto `--atl-*` tokens.
- Hover/active states should use `--atl-amber` / `--atl-surface2` rather than fixed greys.
- Keep the control bar visually distinct from page content if that hierarchy matters (e.g. a
  hairline `--atl-line` bottom border and `--atl-card`/`--atl-surface2` background), but it must
  read correctly in **both** themes.

---

## 5. Task D — Theme the third-party widgets

Drive each off `data-theme` so light mode is coherent:

- **flatpickr** — stop loading `themes/dark.css` unconditionally. Either load the light/default
  theme and override for `[data-theme="dark"]`, or scope both calendars' colours to `data-theme`
  using `--atl-*` tokens (`--atl-card`, `--atl-ink`, `--atl-amber` for the selected day).
- **Quill** (newsletter composer + About-Me editors) — the toolbar/container/editor are dark-only.
  Add `[data-theme="light"]` overrides for `.ql-toolbar`, `.ql-container`, `.ql-editor`,
  stroke/fill icon colours, picker dropdowns, and the blank-placeholder colour, all via tokens.
- **FullCalendar** — set its CSS variables (grid lines, today highlight, event chips, headers)
  from `--atl-*` per theme.
- **ApexCharts** — charts read `data-theme` already exists for status colours; extend the same
  idea to axis/label/grid/tooltip colours, re-rendering or re-applying options on toggle.
  (Reuse the existing `statusColors()` resolver as the canonical example.)
- **intl-tel-input** — style the country dropdown surface/hover for light mode.

For anything that must be computed in JS, **mirror `window.statusColors()`**: read
`document.documentElement.getAttribute('data-theme')` and branch a `lightMeta`/`darkMeta` map.
The existing toggle handler already calls `updatePills()` and `applyBookingFilter()` on switch —
add equivalent re-paint hooks for charts/calendars there.

---

## 6. Hard constraints

- **No regressions in `#bookingsAdmin`.** It is the reference implementation; it must look
  identical (or better) after the rollout.
- **Preserve the atelier language.** Cormorant Garamond display, Outfit UI, JetBrains Mono
  micro-labels, the gold accent, the film-grain overlay, the radial gold glow, the gold header
  rule. Do not flatten it into a generic admin theme.
- **AA contrast in both themes.** The light palette already uses a deeper gold (`#9a7611`) and
  white-on-gold for contrast — keep that discipline for any new mappings.
- **Single source of truth.** Every colour decision routes through a `--atl-*` token. No new
  hardcoded hex.
- **Keep the FOUC-prevention inline script** intact; do not move theme init below the fold.
- **Don't touch `server.js`** for this work.

---

## 7. Acceptance criteria

- [ ] The theme toggle lives in the control bar and is reachable from **all 20 sections**.
- [ ] Flipping it re-themes the **entire** dashboard — control bar, all sections, modals, and
      third-party widgets — with no dark island left in light mode (and vice-versa).
- [ ] No remaining hardcoded dark hex (`#1a1a1a`, `#252525`, `#0a0a0a`, `#101010`, `#181818`,
      `#161616`, `#111111`, etc.) that breaks the off-theme.
- [ ] Choice persists across reload via `localStorage['atl-theme']`; no flash of wrong theme.
- [ ] `flatpickr`, `Quill`, `FullCalendar`, `ApexCharts`, `intl-tel-input` all read correctly in
      both themes.
- [ ] All text meets WCAG AA in both themes.
- [ ] `prefers-reduced-motion` is honoured for the new transitions.
- [ ] `#bookingsAdmin` shows zero visual regressions.

---

## 8. Suggested order of work

1. Task A (move the toggle) — small, immediately testable.
2. Task B (global tokenisation of `admin.html` + the three CSS files) — the heavy lift.
3. Task C (control bar) — depends on B.
4. Task D (third-party widgets) — last, most fiddly.
5. Full pass against §7 in both themes, desktop + mobile.
