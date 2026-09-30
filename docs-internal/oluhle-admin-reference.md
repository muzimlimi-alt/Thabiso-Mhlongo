# O'luhle Scents — Admin System Reference

**Source:** `github.com/muzimlimi-alt/O-luhle-Scents` @ `main` (shallow clone, inspected 2026-09-23)
**Purpose:** reference for consolidating the Thabiso Mhlongo admin. Inspection only — nothing in
Thabiso Mhlongo has been changed on the basis of this document yet.

---

## 0. The headline: different stack, shared lineage

**O'luhle's admin is a React 19 + Vite SPA.** `admin-dashboard/src/` holds 27 page components, 20
shared components, React context providers, and a `services/api.js` client. Thabiso Mhlongo's admin is
a single 13,573-line `admin.html` driven by jQuery, Bootstrap 3 and 30 vanilla-JS modules under
`js/admin/`.

**Component code does not transfer.** There is no `Drawer.jsx` to copy into a jQuery app.

**But the CSS and the UX rules do** — and more importantly, the two projects share a design lineage.
O'luhle's canonical tokens are recognisably the same system as Thabiso's `redesign.css` tokens:

| Token | O'luhle | Thabiso `public/redesign.css` |
|---|---|---|
| `--bg-page` | `#0a0a0a` | `#0a0a0a` |
| `--bg-section` | `#111111` | `#111111` |
| `--bg-surface` | `#1a1a1a` | `#1a1a1a` |
| `--y-base` | `#D4AF37` | `#D4AF37` |
| `--y-hover` | `#E8C14B` | `#E8C14B` |
| `--f-display` | Cormorant Garamond | Cormorant Garamond |
| `--f-body` | Outfit | Outfit |
| `--f-mono` | JetBrains Mono | JetBrains Mono |

So this is not a port. It is **reconciling two branches of one design system**, where O'luhle's branch
has matured further. That materially lowers the risk.

### ⚠ The reference file has a committed merge conflict

`admin-dashboard/src/styles/design-tokens.css` lines 26–36 contain **unresolved conflict markers**:

```css
:root {
<<<<<<< HEAD
  /* ── Canonical tokens — Obsidian · Gold (house default) ── */
  --bg-page: #0a0a0a;
  --bg-section: #111111;
  --bg-surface: #1a1a1a;
  --bg-elevated: #242424;
  --bg-glass: rgba(20, 20, 20, .7);
=======
  /* Constant Brand Identity Tokens */
  --color-primary: #b89b6a;      /* TOCA Gold */
  --color-primary-light: #d4bc91;
  --color-primary-dark: #8c7650;
>>>>>>> cc1345d8f96b760d66ac13c97afed99b99705239
```

A CSS parser discards declarations until it recovers, so **`--bg-page`, `--bg-section`, `--bg-surface`,
`--bg-elevated` and `--bg-glass` are almost certainly not being defined at all** in O'luhle's own
`:root`, and the three `--color-primary*` literals on the other side are dead too (they are
re-declared as aliases further down). The layout survives because `.theme-dark` / `.theme-light`
redefine the same names.

**Implication for us:** the file cannot be copied verbatim, and the HEAD side is the one to take —
it matches the canonical naming the rest of the file, `appearance.css` and every component consume.
The `#b89b6a` "TOCA Gold" on the other side is a different brand's colour and must not come across.

**Worth telling whoever maintains O'luhle** — this is a live defect in their repo, not just our problem.

---

## 1. How O'luhle separates its stylesheets

| File | Lines | Role |
|---|---:|---|
| `src/styles/design-tokens.css` | 346 | tokens + base element styles (`*`, `body`, `h1–h4`, `a`, focus, scrollbar) |
| `src/styles/appearance.css` | 185 | theme axes — pure token overrides, no component selectors |
| `src/styles/buttons.css` | 140 | the button system |
| `src/styles/App.css` | 368 | shared components — cards, tables, badges, KPI grid, form grid |
| `src/index.css` | 16 | imports |
| co-located `<style>` in each `.jsx` | — | layout + overlay CSS, owned by the component that renders it |

The stated convention: **layout CSS lives with the component that owns it; anything used by more than
one page goes in `App.css`; anything that is a *value* goes in `design-tokens.css`.**

Thabiso's post-refactor layering (`core/ overrides/ components/ public/ admin/`) is compatible — the
mapping is direct, and Thabiso's is arguably cleaner because nothing is injected at runtime.

---

## 2. The token system

### What O'luhle has that Thabiso's `--atl-*` does not

| Gap | O'luhle tokens | Why it matters |
|---|---|---|
| **Layout dimensions** | `--nav-w: 270px`, `--nav-w-rail: 76px`, `--top-h: 68px`, `--tap: 44px` | sidebar/topbar sizing is tokenised, not hardcoded per rule. `--tap` enforces a 44px minimum touch target. |
| **RGB triples** | `--y-rgb`, `--ok-rgb`, `--warn-rgb`, `--bad-rgb`, `--info-rgb` | lets any rule build `rgba(var(--y-rgb), .12)` tints instead of hardcoding a parallel translucent colour for every alpha. |
| **Status *text* pairings** | `--success-text`, `--warning-text`, `--error-text`, `--info-text` | **the accessibility one.** The raw semantic colours are tuned for icons/backgrounds and fail AA as text — their own comment measures `--color-warning` at ~1.7:1 on its own tint. The `-text` variants are re-tuned per finish. |
| **Focus ring** | `--focus-ring` | one token drives every `:focus-visible` outline. |
| **Fast transition** | `--t-fast: .18s` | Thabiso has `--atl-t-fast/base/slow` — equivalent, already present. |
| **Typography extras** | `--eyebrow-size`, `--eyebrow-tracking` | the small wide-tracked uppercase label is a first-class token, not ad hoc. |
| **Reduced motion** | `@media (prefers-reduced-motion)` + `html.reduce-motion` | OS-level *and* a manual per-admin preference. Thabiso has **no `prefers-color-scheme` or reduced-motion handling at all.** |

### What Thabiso's `--atl-*` has that O'luhle does not

`--atl-sidebar-bg`, `--atl-topbar-bg`, `--atl-input-bg`, `--atl-placeholder`, `--atl-surface3`,
`--atl-amber-dim`, `--atl-amber-border`, `--atl-on-amber`, `--atl-scrim`, `--atl-grain-opacity`,
`--atl-r-xl`, `--atl-sp-2xl`, `--atl-shadow-top`, `--atl-required`.

**Thabiso's token set is finer-grained for surfaces and form controls.** The merge should be additive
in both directions, not a replacement.

### Neither has z-index tokens

The brief asks for z-index/layer management. **O'luhle does not tokenise z-index either** — it
hardcodes `z-index: 1000` in the Drawer and Modal CSS. Thabiso currently spans 31 ad-hoc values
(0 → 100000). So this is a genuine gap in *both*, and the layer scale has to be designed rather than
copied. O'luhle's contribution here is `overlayStack.js` (below), which is about *behaviour*, not
z-index.

### The `:root` vs `<body>` rule — already correct in Thabiso

`appearance.css` documents a subtle and important constraint:

> A custom property's `var()` references resolve against the **same element's** cascade at the point
> the alias is declared — the resolved value then inherits down as a plain literal, it does not
> re-resolve per descendant. Overriding `--y-base` only on `<body>` would leave every `:root`-declared
> alias frozen on the default forever.

Thabiso already sets `data-theme` on `<html>` (`admin.html:7`), so it is on the right side of this.
**Worth preserving deliberately** — it looks like a stylistic choice and is not.

---

## 3. Component patterns worth adopting

### 3.1 Overlay behaviour — `overlayStack.js`

The single most valuable transferable piece, and it is plain JS with no React dependency. A shared
stack backing every overlay:

- **push/pop** with a stack, so scroll-lock and `inert` are only released when the *last* overlay
  closes — correct when a confirmation dialog opens on top of a drawer
- `document.body.style.overflow = 'hidden'` scroll-lock
- `inert` + `aria-hidden` on the app root while any overlay is open
- `isTopOverlay(id)` so **only the topmost overlay** responds to ESC
- focus moved into the panel on open, **restored to the triggering element** on close
- Tab/Shift-Tab focus trap against a shared `FOCUSABLE_SELECTOR`
- `prefersReducedMotion()` helper

Thabiso has `closeAtlDrawer`, drawer scroll-locking and `atl-drawer--open`, but no shared stack, so
nested overlay cases (drawer + confirm + toast) are handled ad hoc. This is directly portable.

### 3.2 Modal vs Drawer — an explicit division of labour

> **Modal:** "Centered, focus-locked dialog — reserved for destructive confirmations and anything that
> needs to feel like a stop rather than a workspace."
> **Drawer:** "Slide-out panel… used for every create/edit form — the 'here's a record to work on' case."

A clear, enforceable rule. Thabiso currently uses drawers and modals with less separation.

### 3.3 Drawer anatomy — matches the brief exactly

```
.drawer-overlay          fixed inset:0, rgba(0,0,0,.68), backdrop-filter blur(3px), z-index 1000
└── .drawer-panel        width: min(var(--drawer-w,480px), 100vw), flex column, border-left
    ├── .drawer-head     flex:none · .eyebrow + .drawer-title + .drawer-close
    ├── .drawer-body     flex:1, overflow-y:auto
    └── .drawer-foot     flex:none, sticky action bar, border-top, background var(--bg-page)
```

Notable details:
- width is a **per-instance custom property** (`style={{'--drawer-w': ...}}`), not a modifier class
- close button is `var(--tap)` square — 44px touch target
- `@media (max-width: 480px)`: footer becomes a column and buttons go full-width
- a `raw` mode lets complex consumers (tabbed editors) supply their own internal layout while still
  getting the overlay + a11y wrapper — **relevant to Thabiso's Deal Drawer**, which has internal tabs

### 3.4 Consolidation precedents

The comments record what was collapsed, which is the same exercise Thabiso needs:

- **StatusBadge** replaced *"seven different ad hoc badge conventions that each picked their own
  colors, several with real AA contrast failures"* — `.status-badge`, `.status-indicator`,
  `.badge-status`, `.patron-status`, `.partner-status`, `.role-badge-elite`, `.status-pill-elite`
- **LoadingState** replaced *"3+ competing loading idioms"*
- **EmptyState** replaced a `.elite-empty-state` duplicated verbatim across pages
- Badges are styled via **global CSS, not per-instance injected `<style>`**, explicitly because a table
  may render dozens

### 3.5 Buttons

`.btn` + `--primary` / `--secondary` / `--outline` / `--danger`, sizes `--xs/--sm/--lg`, plus
`.action-btn` / `.icon-btn` for icon-only. Consistent treatment: `:active { transform: scale(.98) }`,
`:disabled { opacity:.5; filter: grayscale(1) }`, and a `:focus-visible` ring via `box-shadow` because
`.btn` sets `outline: none`.

Primary uses a gradient and a `translateY(-2px)` hover lift — **a visual choice, not a system one.**
Thabiso's flat Atelier buttons should keep their own treatment; adopt the *structure* (modifier names,
states, sizes, disabled/focus handling), not the gradient.

### 3.6 Tables

`.modern-table` — uppercase `.66rem` tracked headers, `th` on `--bg-section`, `.num` right-align
helper, row hover at `rgba(255,255,255,.028)`, last-row border removed. Plus a nice detail:

```css
.card:has(> .table-wrapper:only-child) { padding: 0; }
```

a card framing only a table sits flush instead of double-padding.

---

## 4. Accessibility patterns

Materially ahead of Thabiso, and all portable:

| Pattern | O'luhle |
|---|---|
| Focus visibility | `:focus { outline: none }` + `:focus-visible { outline: 2px solid var(--focus-ring); offset 3px }` globally, and on native `input/select/textarea` |
| Focus trap | shared, in every overlay |
| Focus restoration | to the triggering element on close |
| `inert` | app root inert while an overlay is open |
| Reduced motion | OS media query **and** a manual preference class |
| Touch targets | `--tap: 44px`, applied to overlay close buttons |
| Contrast | separate `-text` token pairings, with the failure they fix documented |
| Live regions | `role="status" aria-live="polite"` on loading |
| Labelling | `aria-modal`, `aria-labelledby` wired to generated ids |

Thabiso has `12-focus-accessibility.css` and `.tm-sr-only`, but no focus trap, no `inert`, no
reduced-motion support and no contrast-tuned text tokens.

---

## 5. What I'd propose bringing across

Ordered by value-to-risk. Nothing below has been done yet.

| # | Change | Risk |
|---|---|---|
| 1 | **Extend `core/tokens.css`** with the missing capabilities: `--atl-*-rgb` triples, `--atl-*-text` contrast pairings, `--atl-nav-w`/`--atl-nav-w-rail`/`--atl-top-h`/`--atl-tap`, `--atl-focus-ring`, eyebrow tokens | Low — additive; existing names untouched |
| 2 | **A z-index scale** derived from Thabiso's real stacking, since neither codebase has one | Low if values are preserved exactly |
| 3 | **Port `overlayStack`** as a vanilla-JS module; wire Thabiso's drawers/modals through it | Medium — behavioural, needs testing with drawer+modal+toast |
| 4 | **Reduced-motion support** — OS media query + a Preferences toggle | Low |
| 5 | **`:focus-visible` ring** standardised on `--atl-focus-ring` | Low–medium; touches many components |
| 6 | **Standardise the drawer anatomy** (`head`/`body`/`foot` + sticky footer) across Thabiso's drawers, Deal Drawer included via the `raw` equivalent | Medium — structural markup change |
| 7 | **Consolidate badge/empty/loading variants** onto one convention each, following O'luhle's precedent | Medium — needs an inventory of Thabiso's current variants first |
| 8 | **Button modifier structure** (`--primary/--secondary/--outline/--danger`, `--xs/--sm/--lg`) keeping Atelier's flat visual treatment | Medium |

### What should *not* come across

- `#b89b6a` "TOCA Gold" and the `--color-*` alias layer — that is O'luhle's legacy-compatibility
  shim for 35 pages, and importing it would give Thabiso a **fourth** parallel token system on top of
  the three it already has
- The gradient/lift button treatment — wrong for Editorial-Luxe
- `.theme-dark` / `.theme-light` class-scoped overrides — Thabiso's `[data-theme]` attribute mechanism
  is frozen under gate G6 and works
- The Appearance finish/accent axes (Ember/Ivory) — a product feature, not a system pattern

---

## 6. Open question before any of this starts

Thabiso's admin currently has **no reduced-motion support, no focus trap, no `inert`** — and its CSS
was just brought to a verified-parity state through an eight-phase refactor. Every item in §5 is a
**deliberate behavioural or visual change**, which is the opposite of that refactor's contract.

So the parity harness (`scripts/css-parity.js`) changes role here: it stops being a pass/fail gate and
becomes a **change-detector** — it will show exactly which of the 135 views each change touches, and
each diff needs reviewing as intended-or-not rather than driven to zero.

Worth agreeing the sequence and the review standard before Change 1.
