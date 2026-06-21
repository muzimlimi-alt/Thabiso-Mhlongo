# Atelier Admin — Full Component Standardization Prompt (adopt the "Obsidian & Gold" design system page‑wide)

> **What this prompt is for.** Make **every** UI element in `admin.html` — typography, labels,
> paragraphs, inputs, textareas, selects, date pickers, search/filter controls, checkboxes,
> radios, buttons, dropdowns, cards, panels, tables, badges, status indicators, pills,
> navigation, sidebar, tabs, accordions, modals, dialogs, alerts, notifications, empty states,
> loading states, and pagination — read as though it were originally built with the **Atelier
> Artist Dashboard (Obsidian & Gold)** system in the attached reference.
>
> **This is not a redesign.** Do **not** invent new patterns, new colours, or a new design
> language. The attached `artist-booking-dashboard.html` (and its obsidian twin
> `artist-booking-dashboard-obsidian.html`) is the **single source of truth**. The matching
> implementation already exists inside `admin.html` as a mature **116‑class `.atl-*` component
> library** plus the `--atl-*` token system, the `.atl-btn` button framework, the
> `.atl-modal-*` panel architecture, the **"UNIVERSAL MODAL SYSTEM"** CSS block, and a
> **runtime transformer** (`showAtelierModal()`) that ports Bootstrap modals into Atelier panels.
> Your job is to **adopt and apply that existing system everywhere**, replacing the legacy
> markup and hardcoded styling — not to recreate it.
>
> **This is a UI / design‑system standardization task only.** No business logic, APIs, database
> calls, workflows, validation rules, event handlers, or user interactions change (see §12).

---

## 0. Current state (read before changing anything)

### 0.1 The Atelier system already exists — and is mostly built

`admin.html` already contains the full design system. **Reuse it; do not fork it.** Inventory:

- **Tokens** — `--atl-*` custom properties for **dark** (`:root:not([data-theme="light"])`) and
  **light** (`[data-theme="light"]`). Single source of truth for all colour, spacing, radius,
  shadow, transition. (Surfaces `--atl-paper #0a0a0a` / `--atl-card #1a1a1a` /
  `--atl-surface2 #242424` / `--atl-input-bg #0f0f0f`; text `--atl-ink` / `--atl-ink-dim` /
  `--atl-muted #949494` / `--atl-muted-dim #666` / `--atl-placeholder #555`; lines `--atl-line`
  / `--atl-line-strong`; gold `--atl-amber #D4AF37` (+hover/light/border/on-amber); status
  `--atl-sage/clay/blue/green/orange/purple`; radii `--atl-r-sm/md/lg/xl`; shadows;
  `--atl-focus`; `--atl-overlay`.) Light remaps these (gold → `#9a7611`, white‑on‑gold) so
  **using the token is what buys you light‑mode + AA for free.**
- **Buttons** — `.atl-btn` + `.atl-btn--primary` (gold) / `.atl-btn--ghost` / `.atl-btn--danger`
  (**global**), plus `.atl-new-btn`, `.atl-clear-btn`, `.atl-expand-btn`.
- **Badges / status** — `.atl-badge` + 12 variants (`--pending/quoted/accepted/confirmed/
  completed/cancelled/paid/unpaid/overdue/new/info/warning`) with `[data-theme="light"]`
  overrides (**global**); also `.atl-status-badge`, `.atl-payment-badge`, `.atl-tag-badge`,
  `.atl-promote-live-badge`. Pipeline/pills: `.atl-pipeline`, `.atl-pill`, `.atl-pill-count`,
  `.atl-pill-dot`.
- **Cards / panels** — `.atl-card` / `.atl-card-header` / `.atl-card-body` (**global**, already
  grouped with `.db-card`/`.cms-card`), `.atl-surface`, `.atl-sub-panel`, `.atl-panel-label`,
  `.atl-booking-card`, `.atl-det-card`.
- **Forms** — `.atl-input` / `.atl-select` / `.atl-textarea` (focus ring), `.atl-filter-select`
  (**global**), `.atl-search` / `.atl-search-wrap`, `.atl-venue-input`, `.atl-modal-label`,
  `.atl-field-error`.
- **Dropdowns** — `.atl-actions-dropdown-btn` / `-panel` / `-item` / `-item--danger` / `-sep`.
- **Tables** — `.atl-det-table` / `-responsive` / `-wrap` / `-tabular`, `.atl-tfoot-terms`.
- **Typography** — `.atl-heading`, `.atl-subtitle`, `.atl-overline`, `.atl-mono`,
  `.atl-section-hd` / `-heading` / `-eyebrow` / `-sub` / `-rule`, `.atl-det-title`,
  `.atl-event-title`.
- **States** — `.atl-empty-state` / `.atl-empty-sub` / `.atl-empty-display` / `.atl-empty-mono`,
  `.atl-spinner`, `.atl-det-loading`, `.atl-det-empty`.
- **Modal** — `.atl-modal-overlay` / `-panel` / `-header` / `-title` / `-close` / `-body` /
  `-footer` / `-label`; the **"UNIVERSAL MODAL SYSTEM"** CSS (token `!important` rules for
  `.modal-content/.modal-header/.modal-title/.close/.modal-body/.modal-footer/.modal-backdrop`);
  the **runtime transformer** `showAtelierModal()`/`hideAtelierModal()` and the
  `jQuery.fn.modal` monkey‑patch (`targetModalIds`).
- **Decor / a11y** — `.atl-grain` (film‑grain), `.atl-header-rule` / `.atl-section-rule` (gold
  rules), `.atl-sr-only`, `.atl-switch`, `.atl-chevron`, `.atl-detail-region` (collapse),
  `.atl-theme-toggle*` + `.atl-toggle-sun`/`-moon`.

> ⚠️ **Scoping caveat — this is the crux of the work.** Several core classes are **namespaced to
> `#bookingsAdmin`** and therefore do **nothing** when applied to the other sections until you
> **de‑scope them** (move the rule to a global selector, or add a global duplicate):
> - **Form fields:** `#bookingsAdmin input.atl-input`, `#bookingsAdmin select.atl-select`,
>   `#bookingsAdmin textarea.atl-textarea` (and their `:focus`/`::placeholder`). Outside
>   `#bookingsAdmin` (and outside `.atl-modal-body`), `.atl-input` is currently unstyled.
> - **Typography:** `#bookingsAdmin .atl-overline`, `#bookingsAdmin .atl-heading`,
>   `#bookingsAdmin .atl-subtitle`.
>
> `.atl-section-*`, `.atl-mono`, `.atl-filter-select`, `.atl-empty-state`, `.atl-spinner`,
> `.atl-btn*`, `.atl-card*`, `.atl-badge*`, `.atl-modal-*` are already **global**.

### 0.2 The gap — what is *not* yet on the system

- **Legacy class systems** carry hardcoded styling and inconsistent typography and must be
  migrated to the `.atl-*` system: **`um-*` ≈ 611 uses**, `card` ≈ 108, **`db-*` ≈ 105**,
  `adm-*` ≈ 92 (control bar), Bootstrap **`.form-control` ≈ 89**, `btn btn-*` ≈ 24,
  `btn-admin` ≈ 15, Bootstrap `badge` ≈ 20.
- **The system is applied only inside `#bookingsAdmin`.** The other **19 `.admin-section`**
  panels (`dashboardAdmin`, `usersAdmin`, `inquiriesAdmin`, `calendarAdmin`, `financeAdmin`,
  `servicesAdmin`, `policiesAdmin`, `homeAdmin`, `aboutAdmin`, `careerAdmin`, `galleryAdmin`,
  `socialAdmin`, `eventsAdmin`, `contactAdmin`, `newsletterAdmin`, `preferencesAdmin`,
  `brandingAdmin`, `emailLogsAdmin`, `securityAdmin`) use hardcoded dark hex and the legacy
  systems.
- **Hardcoded dark literals everywhere:** `#1a1a1a` (~59×), `#252525` (~17×), `#0a0a0a` (~8×),
  `#181818`, `#161616`, `#111111`, `#101010`, plus muted greys (`#aaa`, `#bbb`, `#888`, `#666`,
  `#555`, `#444`, `#333`) that **fail WCAG AA and do not flip in light mode**, and
  `rgba(255,255,255,…)` hairlines that only read on a dark ground.
- **Font bloat.** The Atelier trio is loaded (**Cormorant Garamond** display, **Outfit** UI,
  **JetBrains Mono** data) — but so are **Open Sans, Roboto, Lato, Montserrat, Raleway, Oswald,
  Playfair Display, Merriweather, Fraunces, Archivo**. Everything must consolidate to the trio;
  the rest should be removed from `<head>`.
- **External stylesheets are in scope but not visible here.** `admin.html` links
  `css/style.css`, `css/redesign.css`, `css/notifications.css` (and `css/bootstrap.min.css`).
  A large share of the legacy colour/typography almost certainly lives in the first three —
  **treat them as in‑scope for the same tokenisation/standardisation pass.** (`css/bootstrap.min.css`
  is the vendor base — override via your own rules, don't edit it.)

### 0.3 Out of scope / companion prompts

- **Out of scope:** `server.js`, `database.js`, API routes, the booking pipeline and all
  business/validation logic. (`server.js` only stores *public‑site* branding, unrelated to the
  admin theme.)
- **Companion prompts (do not duplicate their work here):**
  - `atelier-full-admin-styling-prompt-v2.md` owns the **theme‑toggle relocation into the control
    bar** and the **third‑party‑widget theming** (flatpickr / Quill / FullCalendar / ApexCharts /
    intl‑tel‑input). Run that for theme *propagation*; this prompt is the component *fidelity* pass.
    (They share one mechanic — “replace hardcoded hex with `--atl-*`” — so progress here helps there.)
  - `atelier-modals-styling-prompt.md` is the deep dive on the **18 individual dialogs**. §11 below
    stays at summary altitude and points to it.

---

## 1. Primary objective

> **Adopt and replicate the attached Atelier (Obsidian & Gold) design system across the entire
> `admin.html` page (and the three linked CSS files) by applying the existing `.atl-*` component
> classes and `--atl-*` tokens to every element, de‑scoping the classes currently locked to
> `#bookingsAdmin`, migrating the legacy `um-*`/`db-*`/`adm-*`/Bootstrap markup onto the system,
> consolidating typography to the Atelier font trio, and removing all hardcoded hex — so every
> component is visually unified, theme‑aware in dark and light, AA‑accessible, and responsive,
> with zero change to functionality.**

---

## 2. The visual contract (the reference, distilled)

The attached reference and the admin's `.atl-*` classes already agree on this. Treat it as the
spec every element must satisfy.

**Typography (→ existing classes).**
- **Display / page H1:** Cormorant Garamond, ~`text-5xl/6xl`, 600, tight tracking → use the
  display treatment / `.atl-section-heading` family for section titles.
- **Section heading:** Cormorant, ~22–28px, 600 → `.atl-section-heading` (+ leading `<i>` accent).
- **Eyebrow / overline:** Outfit (or JetBrains Mono), ~11px, 600, `text‑transform:uppercase`,
  `letter‑spacing:.2em`, colour `--atl-muted` / `--atl-amber` → `.atl-section-eyebrow` / `.atl-overline`.
- **Body / paragraph:** Outfit, ~13–14px, 400, `color:var(--atl-ink-dim)` for copy,
  `var(--atl-muted)` for secondary → `.atl-subtitle` / plain prose on tokens.
- **Field label:** Outfit, 11px, 700, uppercase, `letter‑spacing:.08em`, `--atl-muted` →
  `.atl-modal-label`.
- **Data / figures / IDs / codes:** JetBrains Mono → `.atl-mono`.
- **One scale only.** Remove ad‑hoc `font-size`/`line-height`/`font-weight`/`font-family` literals.

**Colour.** Tokens only. Map by **semantic role**, never literal match (an inset field bg →
`--atl-input-bg`; an elevated panel → `--atl-surface2`; a recessed read‑only block → `--atl-paper`;
even if all three were once `#1a1a1a`).

**Spacing / radius / shadow.** Use the `--atl-sp-*` rhythm, `--atl-r-sm/md/lg/xl` radii, and
`--atl-shadow-sm/card/modal`. Cards/inputs round at 8–10px; panels/modals 14–16px.

**Interaction states (apply to every interactive element).**
- **Hover:** buttons lift (`transform:translateY(-1px)`); rows tint `rgba(212,175,55,0.03)`;
  ghost controls gain `--atl-amber` border.
- **Focus (WCAG 2.4.7):** a **visible focus ring** on *every* interactive element. The reference
  uses `:focus-visible { outline:3px solid var(--atl-focus); outline-offset:2px; border-radius:4px }`;
  fields additionally show `border-color:var(--atl-amber); box-shadow:0 0 0 3px var(--atl-focus)`.
- **Active / selected:** gold accent (`--atl-amber` border/underline or `--atl-amber-dim` fill).
- **Disabled:** reduced opacity + `not-allowed` cursor; never a new grey literal.
- **Loading:** `.atl-spinner` (3px ring, gold top) and/or `.atl-empty-state` skeletons.

**Accessibility / a11y patterns from the reference** (port, don't reinvent): skip link,
`.atl-sr-only`, a `role="status" aria-live="polite"` live region for async updates, **status
conveyed by patterned dots/labels (`.atl-pill-dot`/badge text) — not colour alone**, and
`@media (prefers-reduced-motion: reduce)` disabling animation/transition.

**Decor.** Keep the Atelier signature: `.atl-grain` film‑grain overlay, the gold header/section
rule, the radial gold glow, gold accent throughout.

---

## 3. Task A — Typography standardization (do this first; it's load‑bearing)

1. **De‑scope** `.atl-overline`, `.atl-heading`, `.atl-subtitle` from `#bookingsAdmin` to global
   (move the rule or add a global duplicate). `.atl-section-*` and `.atl-mono` are already global.
2. **Consolidate fonts to the trio.** Remove the non‑Atelier font `<link>`s from `<head>`
   (Open Sans, Roboto, Lato, Montserrat, Raleway, Oswald, Playfair Display, Merriweather,
   Fraunces, Archivo) **unless** a font is provably required by the public site logic — verify,
   don't assume. Replace any `font-family:` literals in `admin.html` + the three CSS files with
   the trio (display = Cormorant, UI = Outfit, data = JetBrains Mono).
3. **Apply the scale everywhere.** Every heading, eyebrow, label, helper text, paragraph, table
   cell, form label, modal copy, nav item, and status message adopts the matching class from §2.
   Eliminate competing sizes/weights/line‑heights.

---

## 4. Task B — Forms (inputs, textareas, selects, date/file/search/filter controls)

1. **De‑scope the field classes.** Generalise `#bookingsAdmin input.atl-input` /
   `select.atl-select` / `textarea.atl-textarea` (incl. `:focus` and `::placeholder`) to apply
   wherever the class is used — or migrate the **89 `.form-control`** usages onto a global field
   rule. Net effect: any field anywhere gets the Atelier treatment.
2. **Field spec:** `background:var(--atl-input-bg); color:var(--atl-ink);
   border:1px solid var(--atl-line); border-radius:8px; padding:8px 12px`; **focus** =
   `border-color:var(--atl-amber); box-shadow:0 0 0 3px var(--atl-focus); outline:none`;
   `placeholder` = `var(--atl-placeholder)`; **disabled** = dimmed; **validation error** =
   `border-color:var(--atl-clay)` + `.atl-field-error` message.
3. **Labels** use `.atl-modal-label` (uppercase micro‑label). **Checkboxes/radios** get a gold
   accent (`accent-color:var(--atl-amber)` or styled control) and the same focus ring.
4. **Search/filter** controls use `.atl-search`/`.atl-search-wrap`/`.atl-filter-select`.
5. **Third‑party field widgets** (flatpickr, Quill, intl‑tel‑input) — their internal theming is
   owned by `…-v2.md`; here, just ensure the **trigger input** matches the field spec so the
   control reads as one Atelier field.

---

## 5. Task C — Buttons & icon buttons

Migrate every `btn btn-*`, `btn-admin`, and `um-btn--*` to the `.atl-btn` family:
- **Primary** (gold) → `.atl-btn--primary`; **secondary / cancel** → `.atl-btn--ghost`;
  **destructive** → `.atl-btn--danger`; **icon‑only** → `.atl-btn` with a centred icon and an
  `aria-label`.
- Standardise sizing/padding, the `translateY(-1px)` hover, the focus ring, disabled, and a
  **loading** affordance (spinner or disabled + label swap). **Strip inline hardcoded button
  colours** (e.g. Material blue) — let the variant's tokens apply.

---

## 6. Task D — Cards, panels, containers

- `.atl-card` is already grouped with `.db-card`/`.cms-card`; **extend the same rule to the
  `um-*` card/panel classes** (or re‑class them to `.atl-card`).
- Surfaces by role: page = `--atl-paper`; card = `--atl-card`; elevated/nested panel =
  `--atl-surface2`; recessed read‑only block = `--atl-paper`. Headers `.atl-card-header`, bodies
  `.atl-card-body`; radius `--atl-r-lg/xl`; shadow `--atl-shadow-card`; hairline `--atl-line`.

---

## 7. Task E — Tables & data‑heavy sections (Bookings, Inquiries, Users, Events, CRM)

Apply the Atelier table system for readability/density/scannability:
- **Header row:** Outfit/JetBrains, 12px, uppercase, `color:var(--atl-muted)`, `border-bottom:1px
  solid var(--atl-line)`, no per‑cell borders.
- **Body rows:** `border-bottom:1px solid var(--atl-line)`, **hover** tint
  `rgba(212,175,55,0.03)`, **selected** = `--atl-amber-dim`; cell text `--atl-ink`.
- **Status** via `.atl-badge--*`; **row actions** via `.atl-actions-dropdown-*`; **figures/IDs**
  via `.atl-mono`.
- **Pagination & filter bars** on tokens + `.atl-btn`/`.atl-filter-select`; keep them tappable on
  mobile.
- Tables stay horizontally scrollable on small screens (`.atl-det-table-responsive` pattern).

---

## 8. Task F — Badges, status indicators, pills

- Re‑class Bootstrap `badge`s to the `.atl-badge--*` matching the lifecycle/payment state.
- **Tokenise the few hardcoded badge colours** in the existing rules (e.g. `#E8C14B`, `#60a5fa`,
  `#34d399`, `#4ade80`, `#f87171`) → `var(--atl-amber-hover|blue|green|sage|clay)`, keeping the
  `[data-theme="light"]` overrides.
- **Never rely on colour alone** — pair every status with text and/or a `.atl-pill-dot` pattern
  (WCAG 1.4.1). Use `.atl-pill`/`.atl-pipeline` for the lifecycle row.

---

## 9. Task G — Navigation, sidebar, tabs, accordions

- Map the nav/sidebar surfaces, item hover/active, and dividers onto `--atl-*`
  (`--atl-sidebar-bg`, `--atl-line`, active = `--atl-amber`/`--atl-amber-dim`).
- Tabs: active tab = gold underline/accent on tokens; inactive = `--atl-muted`.
- Accordions/collapsibles: reuse `.atl-chevron` (rotate) + `.atl-detail-region` (max‑height
  transition) instead of any bespoke collapse.

---

## 10. Task H — Alerts, notifications, empty states, loading, pagination, search

- **Empty states** → `.atl-empty-state` / `-sub` / `-display` / `-mono`. **Loading** →
  `.atl-spinner` / skeletons.
- **Toasts / notifications** (likely styled in `css/notifications.css`) → tokens, with a
  `[data-theme="light"]` variant; semantic accent via `--atl-sage`/`--atl-clay`/`--atl-amber`.
- **Alerts** → tokenised surface + status accent; readable in both themes.
- **Pagination & global search bar** → `.atl-btn`/tokens/`.atl-search`.

---

## 11. Task I — Modals & dialogs (summary — see the dedicated prompt)

Reuse the **`.atl-modal-*`** architecture, the **"UNIVERSAL MODAL SYSTEM"** CSS, and the
**runtime transformer** (`showAtelierModal()` + the `jQuery.fn.modal` monkey‑patch). At a glance:
one **SVG ✕** close affordance everywhere, header = Cormorant title on `--atl-surface2`, body on
`--atl-card`, footer = `.atl-btn` actions, all inner content tokenised, fields styled per §4.
**Do not invent a modal design.** The exhaustive, per‑dialog treatment for all 18 modals lives in
`atelier-modals-styling-prompt.md` — follow it for this task and keep the two consistent.

---

## 12. Hard constraints (the boundary — non‑negotiable)

- **No functionality changes.** Do not modify business logic, APIs, `server.js`, `database.js`,
  database integrations, workflows, validation rules, event handlers, or user interactions
  except where strictly required to support the styling migration.
- **Do not change any `id`, `name`, or `data-*` attribute** (especially `data-dismiss`,
  `data-target`, `data-toggle`). JS, Bootstrap, and the booking pipeline key off these. Preserve
  hidden legacy anchors (e.g. `adminBookingModal`'s hidden `#ab*` fields + `#adminRespondForm`)
  and every form field / message sink.
- **Reuse the existing system; do not fork it.** Every colour routes through a `--atl-*` token;
  every component adopts an existing `.atl-*` class. **No new palette, no invented patterns, no
  new hardcoded hex.** Prefer de‑scoping/applying existing rules over writing parallel ones.
- **Include the linked CSS files** (`css/style.css`, `css/redesign.css`, `css/notifications.css`)
  in the same pass. Do not edit `css/bootstrap.min.css` (override it instead).
- **WCAG 2.1 AA in both themes.** Lift the failing greys (`#aaa`/`#888`/`#666`/`#555`/`#444`/`#333`)
  to tokens that pass 4.5:1 on their surface; verify accents against `--atl-surface2` and against
  the light palette; status never colour‑only; visible 3px focus ring; tap targets ≥ 40px.
- **Mobile‑first responsive.** Every pattern adapts across mobile/tablet/desktop with no
  clipping, horizontal overflow only where intended (tables), and tappable controls.
- **Preserve the Atelier language.** Cormorant display, Outfit UI, JetBrains Mono data, gold
  accent, film‑grain, gold rules, radial glow. Don't flatten into a generic Bootstrap admin.
- **No assumptions.** Verify structure before removing/merging anything; don't delete a font load
  or a duplicate‑looking component without confirming it's truly unused/duplicated — flag instead.
- **No regressions in `#bookingsAdmin`** — it is the reference implementation and must look
  identical (or better) afterwards.

---

## 13. Acceptance criteria

- [ ] Every section (all 20) renders in the Atelier system — no section still on legacy
      `um-*`/`db-*`/Bootstrap visuals.
- [ ] The `#bookingsAdmin`‑scoped classes (`.atl-input/.atl-select/.atl-textarea`,
      `.atl-overline/.atl-heading/.atl-subtitle`) are de‑scoped and working page‑wide.
- [ ] Only the **Atelier font trio** loads; no competing `font-family` literals remain.
- [ ] All inputs/selects/textareas/search/filters/checkboxes/radios match the field spec, with a
      visible gold focus ring and tokenised placeholder/disabled/validation states.
- [ ] All buttons use `.atl-btn` variants; no hardcoded button colours remain.
- [ ] All cards/panels, tables, badges/status, nav/tabs/accordions, alerts/toasts, empty/loading
      states, and pagination conform to the reference.
- [ ] Zero hardcoded dark hex remains (`#1a1a1a`, `#252525`, `#0a0a0a`, `#101010`, `#181818`,
      `#161616`, `#111111`, the grey ramp) in `admin.html` **and** the three CSS files.
- [ ] Flipping `#atlThemeToggle` re‑themes the whole dashboard — no dark island in light mode
      (and vice‑versa); choice persists across reload with no FOUC.
- [ ] All text meets WCAG AA in both themes; status is never colour‑only; `prefers-reduced-motion`
      honoured.
- [ ] Fully responsive on mobile/tablet/desktop; nothing clips; controls remain tappable.
- [ ] **Zero functional regressions** — every workflow, validation, handler, and API call behaves
      exactly as before.

---

## 14. Test plan (run before declaring done)

- **Functional regression:** exercise each section's core flows (create/edit/save, status
  changes, quote/payment/contract actions, user management, calendar, newsletter send, file
  uploads, search/filter, pagination) and confirm behaviour, validation, and API calls are
  unchanged.
- **Theme:** open each section in dark, flip to light (and reload), confirm chrome, surfaces,
  text, fields, tables, badges, and controls all re‑theme; no FOUC.
- **Component audit:** spot‑check one of each component type (button, field, select, table row,
  badge, card, tab, accordion, toast, empty state, spinner, modal) against the reference,
  side‑by‑side, in both themes.
- **Accessibility:** keyboard‑traverse each section — focus ring visible, order sane, labels
  resolve, status not colour‑only; run a contrast check on the new mappings.
- **Responsive:** verify mobile/tablet/desktop for every section; tables scroll, footers/filters
  wrap, nav collapses correctly.
- **Final sweep:** grep `admin.html` + the three CSS files for residual hardcoded hex and
  non‑trio `font-family`; refactor until clean.

---

## 15. Suggested order of work

1. **§3 Typography** — de‑scope heading/overline/subtitle, consolidate fonts, apply the scale.
   (Load‑bearing; everything else sits on it.)
2. **§4 Forms** — de‑scope the field classes / migrate `.form-control`. (Highest‑frequency win.)
3. **§5 Buttons** → **§6 Cards** → **§8 Badges** — high‑volume, low‑risk class swaps.
4. **§7 Tables** and **§9 Nav/Tabs/Accordions** — the data‑heavy and structural surfaces.
5. **§10 Alerts/Notifications/States** (incl. `css/notifications.css`).
6. **§11 Modals** — per `atelier-modals-styling-prompt.md`.
7. Token‑sweep `css/style.css` + `css/redesign.css` for any remaining legacy hex.
8. **Full §13 + §14 pass** in both themes, desktop + mobile. Deliver a change log: classes
   de‑scoped, legacy systems migrated, fonts removed, hex→token counts, and anything flagged
   (suspected‑unused fonts, duplicate components) for human review.

> **Pair with:** `atelier-full-admin-styling-prompt-v2.md` (theme‑toggle relocation +
> third‑party‑widget theming) and `atelier-modals-styling-prompt.md` (the 18 dialogs). Together
> these three unify the admin under the Atelier Obsidian & Gold system.
