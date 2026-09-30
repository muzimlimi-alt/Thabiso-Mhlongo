# Admin Consolidation Log

Bringing the Thabiso Mhlongo admin into alignment with the O'luhle Scents reference.

- Reference inspection: [`oluhle-admin-reference.md`](oluhle-admin-reference.md)
- Preceding CSS refactor: [`css-refactor-log.md`](css-refactor-log.md)

**Verification note.** The parity harness (`scripts/css-parity.js`) changes role in this workstream.
During the CSS refactor it was a pass/fail gate — `STYLE CHANGED: 0` or stop. Here, changes are
*intended*, so it becomes a **change-detector**: every diff must be explained as intended-or-not, and
the key question is what was **lost**, not what changed. A component line disappearing is a
regression; a token line appearing is the point.

---

## Step 1 — Extend the admin token layer

**Label:** `consol1-tokens` · compared against `phase8-cleanup`

### What was added

All additive — **no existing token changed value**.

| Group | Tokens | Rationale |
|---|---|---|
| Colour channels | `--atl-amber-rgb`, `--atl-sage-rgb`, `--atl-clay-rgb`, `--atl-blue-rgb`, `--atl-orange-rgb`, `--atl-ink-rgb` | The codebase repeats `rgba(212,175,55,…)` at ~30 different alphas. A bare `r, g, b` triple lets rules mix their own alpha instead of hardcoding a parallel translucent literal per opacity. Re-stated per theme in `themes.css`. |
| Layout | `--atl-nav-w: 260px`, `--atl-nav-w-rail: 72px`, `--atl-top-h: 68px` | Were hardcoded, or held as `--sidebar-width-*` in `admin/redesign-admin.css`, outside the token namespace. **Values are the current measured ones, not the reference's.** |
| Touch target | `--atl-tap: 44px` | **New capability.** WCAG 2.5.5. The admin has no minimum-target rule today. |
| Z-index scale | 13 tokens, `--atl-z-base` → `--atl-z-login` | See below. |
| Typography role | `--atl-eyebrow-size`, `--atl-eyebrow-tracking` | The wide-tracked uppercase label, promoted from ad hoc values. |

### What was deliberately NOT imported

- **`--success-text` / `--warning-text` / `--error-text` / `--info-text`.** The reference needs a
  second set of status colours because its raw semantic tokens fail AA as text — its own comment
  measures `--color-warning` at ~1.7:1 on its own tint. **This project already solves that better**:
  `--atl-sage/clay/blue/green/orange` are re-tuned per theme in `themes.css` (`#4ade80` dark →
  `#1f9254` light), so one name stays correct on both surfaces. Adding a parallel `-text` set would
  be importing a workaround for a problem we don't have.
- **The `--color-*` alias layer** (~35 aliases the reference keeps for backwards compatibility).
  Importing it would give this project a **fourth** parallel token system on top of the three it has.
- **`#b89b6a` "TOCA Gold"** — a different brand's accent.
- **`.theme-dark` / `.theme-light` class overrides** — this project's `[data-theme]` attribute
  mechanism is frozen under gate G6 and works.

### The z-index scale, and the conflicts it exposed

Neither codebase had a scale. The reference hardcodes `z-index: 1000` in its Drawer and Modal. So the
scale was derived from **this project's actual stacking**, recorded at as-found values so that wiring
a literal to its token is a no-op.

Mapping every `z-index` to its selector surfaced four genuine conflicts:

| Conflict | Detail |
|---|---|
| `.tm-admin-sidebar` | declared at **200**, **1040** and **10000** across three files |
| `.adm-header` | declared at **300** and **1040** |
| `.adm-search__results` | declared at **2000** and **5000** |
| **Modal under-stacked** | `.atl-modal-overlay` is **9000**, but `#admProfileMenu` is **20000** and `.atl-actions-dropdown-panel` / `.bkr-more-dropdown` are **99999** — so a profile menu or an actions dropdown renders **over an open modal** |

The last is a real UX defect, not just untidiness. **None has been changed** — fixing them alters
rendering and needs a decision. Flagged in `core/tokens.css` at the scale definition.

### Verification

```
phase8-cleanup → consol1-tokens
  views compared   : 135
  STYLE CHANGED    : 132  (all admin; public 3/3 unchanged)

  fingerprint lines lost  : 133
  fingerprint lines added : 3433
```

The 132 changed views are the expected consequence of new tokens resolving on `:root`. What matters
is the loss column:

| Lost | Cause |
|---:|---|
| 132 | the `TOKEN count` row itself, 241 → 266 |
| 1 | `.adm-profile-btn` at 375px — the known `clamp()`/`vw` float artifact (0.0002px), documented in the refactor log |

**Zero component style lines lost.** Admin `:root` tokens 241 → 266 (+25, exactly what was added);
public `:root` 107 → 107 with no style change, since `index.html` does not load `core/tokens.css`.

**Step 1 complete and verified additive.**

---

## Step 2 — Shared overlay stack

**Label:** `consol2-overlay` · behaviour change, verified by a functional suite rather than the
CSS harness

### The defect, measured before touching anything

The reference's `overlayStack` exists to keep nested overlays correct. Checking whether this project
had the same problem — driving the real admin, opening a drawer, then a confirm dialog inside it:

```
1. drawer opened                 drawerOpen:true   modalActive:false   bodyOverflow:"hidden"
2. confirm opened over drawer    drawerOpen:true   modalActive:true    bodyOverflow:"hidden"
3. after ONE Escape press        drawerOpen:false  modalActive:false   bodyOverflow:"(unset)"
```

**One Escape closed both**, and unlocked page scroll. The user loses the drawer they were working in.

Two causes, both confirmed by reading the code:

1. `drawer.js` and `notificationService._showModal` each bound their own document-level `keydown`
   handler, and **neither checked whether it owned the topmost layer**.
2. The modal's `closeModal` set `document.body.style.overflow = ''` **unconditionally**, with no
   notion that a drawer might still be open beneath it.

**Correction to an earlier reading of mine:** I initially recorded a third cause — that the modal
never removed its keydown listener. That was wrong; `closeModal` does call
`removeEventListener('keydown', handleKey)`. I had read a truncated excerpt that cut off above that
line. The modal's own focus trap, focus restore and listener cleanup were already correct, and were
left alone.

### What was built

`js/overlay-stack.js` — a small vanilla module, loaded on **both** pages before
`notificationService.js`, exposing `push / pop / isTop / depth / topEntry / trapFocus /
prefersReducedMotion` and a shared `FOCUSABLE_SELECTOR`.

**Merged rather than replaced (§3).** This project already had a drawer stack (`atlDrawerStack` in
`js/admin/components/drawer.js`) that tracked open drawers, refcounted the scroll lock across them
and stepped Escape back one drawer at a time. In one respect it is **better than the reference**: it
hands each drawer an increasing z-index so the most recently opened wins the paint order, where the
reference gives every overlay a flat `z-index: 1000`. That behaviour is preserved — `drawer.js` still
owns z-index laddering; the shared module owns ordering, scroll-lock and focus restore.

What changed:

| File | Change |
|---|---|
| `js/overlay-stack.js` | new |
| `js/admin/components/drawer.js` | `atlDrawerPush/Pop` delegate scroll-lock to the stack; Escape handler now returns unless a drawer owns the top layer |
| `js/notificationService.js` | modal registers with the stack on open and pops on close; `handleKey` returns unless the modal is topmost, and now calls `stopPropagation()`; added a `closed` guard so Escape and a click landing in the same frame can't double-resolve |
| `index.html`, `admin.html` | load `js/overlay-stack.js` before the consumers |

Every integration point degrades to the previous behaviour if `window.atlOverlayStack` is absent, so
a load-order mistake cannot leave scroll permanently locked.

**Not implemented, deliberately:** the reference also marks the app root `inert` while an overlay is
open. Correct for modal dialogs, but this project's drawers are not uniformly modal — some are used
alongside the page behind them — so applying it blanket-fashion would change interaction, not just
accessibility. **Open item.**

### Verification

A functional suite (`overlaysuite.js`) drives the real admin through all three paths — the CSS
harness cannot see behaviour:

```
A. drawer alone
  PASS  drawer open locks scroll, depth 1
  PASS  Escape closes drawer, unlocks scroll
B. modal alone
  PASS  modal open locks scroll, depth 1
  PASS  Escape closes modal, unlocks scroll
C. modal over drawer (the reported defect)
  PASS  both open, depth 2
  PASS  1st Escape closes ONLY modal, scroll stays locked
  PASS  2nd Escape closes drawer, unlocks scroll
```

The suite also flags page errors. It reports the pre-existing
`Cannot read properties of undefined (reading 'showError')`, which fires on the **pre-login** load
where `notificationService` is not yet initialised. It is present in every baseline capture from
Phase 1 onward and is unrelated to this change — recorded so a *new* error stays detectable.

CSS parity: `consol1-tokens → consol2-overlay` returned **STYLE CHANGED: 0** across all 135 views —
the added `<script>` tags had no visual side-effect.

**Step 2 complete.**

---

## Step 3 — Appearance system (three axes)

**Brief:** `TBC/TOCA Appearance.md` · **Label:** `consol3-appearance`

Three independent axes as attributes on `<html>`, freely combinable:

| Axis | Attribute | Values |
|---|---|---|
| Finish | `data-theme` | `dark` (Obsidian, default) · `light` (Ivory) · `ember` (**new**) |
| Accent | `data-accent` | `gold` (default) · `vetiver` · `cassis` · `cuivre` |
| Presence | `data-presence` | `editorial` (default) · `boutique` · `operations` |

### Files

| File | Change |
|---|---|
| `css/core/appearance.css` | new — all three axes + the panel's own styling |
| `js/appearance.js` | new — single writer for the three attributes, panel builder |
| `css/core/tokens.css` | the dark selector's `:not()` chain now excludes `ember` |
| `admin.html` | pre-paint script extended to three axes; `appearance.css` linked last; header toggle replaced by an Appearance control + popover; panel embedded in Preferences; old toggle handler replaced |

### The specificity trap, and why the tokens.css edit was mandatory

`core/tokens.css` expressed dark as `:root, [data-theme="dark"], :root:not([data-theme="light"])`.
That third arm is **(0,2,0)**. A bare `[data-theme="ember"]` is **(0,1,0)** and would have *lost* to
it — **Ember would have silently rendered as Obsidian, with no error anywhere.** Two independent
guards now: the `:not()` chain excludes ember by name, and the ember block is written
`:root[data-theme="ember"]` (0,2,0). With no attribute set, every arm still matches and dark remains
the default — verified in the browser.

### Storage and migration

**Finish keeps the existing `atl-theme` key.** That *is* the migration: the values already stored
there (`dark`/`light`) remain valid Finish values, so an existing admin lands on exactly the look they
had, with no translation step and therefore no chance of mistranslating it. `ember` simply joins the
set. The two new axes get their own keys rather than being folded into one blob, because a blob would
have required rewriting the pre-paint read path *and* migrating every stored value to get there.
Verified: an admin with `atl-theme=light` still resolves to Ivory with today's exact `#9a7611` gold.

### Contrast — measured, and one finding

Text ≥ 4.5:1 (AA), accent-as-button-background ≥ 3:1 (1.4.11). All three surfaces per Finish.

**Obsidian** (paper `#0a0a0a` / card `#1a1a1a` / surface2 `#242424`)

| Accent | as text | as button bg |
|---|---|---|
| gold | 9.42 / 8.28 / 7.38 | 9.42 |
| vetiver | 9.42 / 8.28 / 7.38 | 9.42 |
| cassis | 8.01 / 7.04 / 6.28 | 8.01 |
| cuivre | 8.94 / 7.86 / 7.01 | 8.94 |

**Ember** (`#110c08` / `#221a11` / `#2e2318`)

| Accent | as text | as button bg |
|---|---|---|
| gold | 9.25 / 8.16 / 7.29 | 9.25 |
| vetiver | 9.25 / 8.16 / 7.29 | 9.25 |
| cassis | 7.86 / 6.94 / 6.20 | 7.86 |
| cuivre | 8.78 / 7.74 / 6.92 | 8.78 |

**Ivory** (`#f7f4ee` / `#ffffff` / `#f1ece1`)

| Accent | as text | as button bg | |
|---|---|---|---|
| gold — **today's `#9a7611`** | **3.85 / 4.22 / 3.58** | 3.85 | ❌ fails AA on all three |
| vetiver `#2F6B3A` | 5.82 / 6.39 / 5.43 | 5.82 | ✅ |
| cassis `#8E2F4E` | 7.17 / 7.87 / 6.68 | 7.17 | ✅ |
| cuivre `#9A4F1E` | 5.45 / 5.98 / 5.08 | 5.45 | ✅ |

*(gold and vetiver reporting identical ratios on the dark finishes is not an error — `#D4AF37` and
`#8CC084` have near-identical relative luminance, 0.449328 vs 0.449407.)*

**The one finding: the existing Ivory gold fails AA as text on every light surface.** That is
pre-existing, not introduced here, and this change has not silently fixed it — see the conflict below.

### A conflict inside the brief, and the call I made

The brief requires two mutually exclusive things for gold-under-Ivory:

> "Gold is the default and must produce **byte-identical** output to today's `--atl-amber` values, so
> nothing visually changes for an admin who never opens the picker."

> "Deep variants (under Ivory ONLY): gold **#8A6A14**"

Today's Ivory gold is `#9a7611`. Applying `#8A6A14` would change it for every existing light-theme
admin — exactly what the first constraint forbids. **The byte-identical constraint wins**, because it
is the one with a stated rationale, and because it is the conservative, reversible choice.

So **gold emits no rule at all**. The deep-variant table applies to vetiver/cassis/cuivre only.

For the record, `#8A6A14` would have improved matters but still failed: 4.61 / 5.06 / **4.29** —
surface2 is under the 4.5 threshold. **`#846613` clears all three** (4.92 / 5.40 / 4.58). Changing it
is a one-line edit whenever you want the contrast fixed; it needs to be a deliberate visual change.

### Deliberate deviations and derived values

- **Deep hover/light are derived, not specified.** The brief gives base/dim/border/rgb for the deep
  variants but no hover or light. Derived using the relationship today's gold ramp already uses —
  hover = base × 0.82, light = base blended 45% toward white — and marked `/* derived */` in the file.
- **Five Ember tokens are derived.** The brief lists surfaces, text and borders. `--atl-surface3`,
  `--atl-topbar-bg`, `--atl-input-bg`, `--atl-muted-dim` and `--atl-placeholder` also exist in this
  project and had to be given Ember values; each mirrors its dark-theme relationship.
- **`1.6rem` renders at 22.4px, not 25.6px.** The admin root is **14px**
  (`css/admin/07-components.css:983`), not the 16px the reference assumes. `rem` was kept — a density
  axis should track the root — but the absolute sizes are 87.5% of the reference's.
- **Presence table targets are limited** to `.atl-bk-table`, `.lc-table`, `.users-table`. Date grids
  (`.mini-calendar-table`) and inline detail tables (`.atl-det-table`) are excluded: re-padding them
  breaks their alignment and they are not reading surfaces.

### The `applyBranding.js` hazard — checked, currently clear

`js/applyBranding.js` and `admin.html` write `--brand-gold` and `--theme-font` as **inline** styles on
`documentElement`, which would beat any stylesheet rule. Verified:

- **`var(--brand-gold)` is consumed by no admin CSS** (only `error.html`), so it cannot override an
  accent today.
- **No code anywhere writes an `--atl-*` property inline** — confirmed by grep.
- `--theme-font` *is* consumed, by four `body.admin-body …{font-family:var(--theme-font)!important}`
  rules in `css/style.css`. Presence's heading rules beat those on specificity (0,3,2 vs 0,1,1) and
  use literal families, so branding cannot reach them.

**The hazard is latent, not active.** If anyone later points `--atl-amber` at `--brand-gold`, the
accent axis breaks silently. Flagged, not worked around.

### Charts

The old toggle re-rendered FullCalendar (twice — a copy/paste duplication, now collapsed to one) but
**never reloaded the dashboard**, so ApexCharts kept its previous colours until a section switch.
`afterChange()` now also calls `loadDashboardKPIs` and `loadAnalyticsDashboard`, guarded by `typeof`.
**Not independently verified** that every Apex series recolours — the automated checks cover tokens
and computed styles, not canvas pixels. Worth an eyeball on the dashboard.

### Verification — 16 automated checks, all passing

```
1. defaults          attributes dark/gold/editorial · gold byte-identical (#D4AF37 / #E8C14B)
2. Ember             surfaces actually applied (the specificity trap) — #110c08 / #221a11 / #fdf8f1
3. Vetiver + Ember   bright variant #8CC084 · focus ring follows the accent (#A3D49B)
4. Vetiver + Ivory   deep variant #2F6B3A · Ivory surfaces intact
5. Operations        spacing 16/20/28px · heading → Outfit at 1.6rem
6. Reload            all three axes survive · pre-paint applied the stored Finish (no FOUC)
7. Reset + migration house default restored · legacy atl-theme=light → Ivory with #9a7611
8. Junk input        invalid stored accent falls back to gold
9. Panel             10 radios, 3 fieldsets, aria-live region
```

The suite also reports the pre-existing `showError` page error from the pre-login load — present
since Phase 1, unrelated.

### Left out

- **`inert` on the app root** while an overlay is open (carried over from Step 2) — correct for modal
  dialogs, wrong for this project's non-modal drawers. Needs a per-drawer modality decision.
- **Reduced motion** is honoured only for the appearance panel's own transitions. The admin-wide
  `prefers-reduced-motion` rule and the manual per-admin toggle the reference has are **not done**.
- **The public site is untouched**, per the scope boundary — no appearance CSS or JS wired into
  `index.html`.

---

## Step 4 — Multilevel sidebar + header dropdown

**Label:** `consol4-nav` · deliberate visual change

New: `css/admin/sidebar-nav.css`, `js/admin/sidebar-nav.js`. The sidebar markup in `admin.html` was
rebuilt; one guard was added to the existing navigation handler.

### Regrouping — the reported confusion

> "the branding and settings section both have settings that relate to changing the look of the site,
> it is confusing"

Confirmed by reading both sections:

| Section | Contains |
|---|---|
| `brandingAdmin` | Header/Site Logo · Favicon · **Primary Accent Colour** · **Theme Font** · Master Banner System · Admin Login Background |
| `preferencesAdmin` | **Appearance** · PayFast · Email (SMTP) · Notifications · Website Sections |

Two colour/typography controls in one section, a third in the other, and both sat side by side under
a single **System Settings** heading. The distinction that actually matters — *which surface does this
restyle?* — was invisible.

**Fixed structurally rather than by moving code between sections** (moving cards would be a
functional change with its own risk):

- **"Branding" → "Site Appearance"**, moved under a new **PUBLIC SITE** group, beside the content it
  restyles. Tooltip: *"Logo, favicon, accent colour, fonts & banners for the PUBLIC site"*.
- **"Settings" → "Admin Settings"**, under **ADMINISTRATION**. Tooltip: *"Admin appearance, payments,
  email & section visibility"*.

They are now in different sections of the menu, and each title names its surface.

### New structure — 4 sections, 5 collapsible groups, all 22 sections reachable

```
  Dashboard
OPERATIONS      Bookings ▸ Pipeline · Calendar · Events
                Revenue  ▸ Finance · Services · Policies
AUDIENCE        Inquiries
                Outreach ▸ Newsletter · Social Media · Contact Details
PUBLIC SITE     Site Content ▸ Home Slider · About Me · Career · Footprint · Testimonials · Gallery
                Site Appearance
ADMINISTRATION  Admin Settings
                People & Access ▸ Users · Security & Audit · Email Logs
```

Ported from the reference: section eyebrows, collapsible groups with rotating chevrons, persisted
expanded state, auto-expand of the group owning the current section, the left-border + gradient active
treatment, and the rail flyout. Everything reads `--atl-*`, so all three Finishes and four Accents flow
through — **no rule in the file names a colour.**

### Three real bugs found while building it

**1. Group buttons navigated.** The existing handler falls back to
`li.querySelector('.tm-nav-link')` for any click inside a sidebar `<li>`. With nesting, that resolved a
group's expand button to its first child — opening "Revenue" also jumped to Finance. Guarded with an
early return on `.atl-nav-parent`.

**2. Closed submenus kept their full height.** `grid-template-rows: 0fr` on the `<ul>` defines **one**
row; every `<li>` after the first got an implicit `auto` row — measured `"0px 35.5px 35.5px"`, a closed
group still occupying 71px. The reference avoids this by wrapping its items in a single `<div>`, which
is not valid inside a `<ul>`. Moved the grid onto the group `<li>` instead (two rows: button, submenu),
which gives exactly one animatable row and keeps the markup valid.

**3. Bootstrap 3 silently won.** `.nav > li { display: block }` is (0,1,1); my `.atl-nav-group` was
(0,1,0). The `grid-template-rows` applied but `display: grid` did not, so the rows were inert.
Selector raised to `.atl-nav > li.atl-nav-group` (0,2,1). Separately,
`css/admin/12-focus-accessibility.css` carries a blanket `a { color: var(--atl-amber) !important }`,
which painted every submenu link gold as though active — the colour declarations here need
`!important` purely to outrank it.

### Frozen contract preserved

`window.switchTab` resolves `.admin-sidebar a[href="#<id>"]` and sets `.active` on that anchor's
**parent `<li>`**. Every leaf is still an `<a class="tm-nav-link">` inside its own `<li>` inside
`ul.admin-sidebar`. The nesting changed; the contract did not. Verified: all 22 `.admin-section`
elements have a sidebar link, and clicking a nested leaf still routes through `switchTab`.

### Header dropdown

The existing `.adm-dropdown__menu` markup is **richer than the reference's** — profile card, section
labels, two-line items with title and subtitle — so this aligned its *treatment*, not its structure:
accent top rule, token-driven surfaces, `--atl-tap` row heights, and the icon-goes-accent-on-hover
behaviour the sidebar now shares.

### Verification — 10 automated checks, all passing

```
1. structure    5 groups · 4 eyebrows · 22 links · every .admin-section reachable
2. expand       opens and closes, aria-expanded tracks
3. navigation   expanded submenu visible + keyboard-reachable; nested leaf routes via switchTab
4. persistence  group owning the restored section auto-expands after reload
5. rail         submenu becomes an absolute flyout, hidden until hover, revealed on hover
6. tokens       active leaf recolours with the Accent axis
```

Plus a visual check of the rendered sidebar — the first screenshot is what exposed bugs 2 and 3,
which every automated check had passed straight over.

### Blast radius — confirmed contained

This is a deliberate visual change, so the harness was used as a change-detector: the question is not
"did anything change" but "did anything change that shouldn't have".

```
consol1-tokens → consol4-nav
  fingerprint lines lost  : 372
  fingerprint lines added : 372

  .tm-nav-link              132x   sidebar links
  .adm-dropdown__menu       132x   header dropdown
  .admin-sidebar li.active  108x   active state
```

**Exactly three probes moved, and they are exactly the two components being redesigned.** Lost and
added are equal and cover the same selectors — nothing was removed, only restyled. No other surface
(cards, tables, drawers, forms, modals, badges, vendor widgets) shifted by a single property.

### Note

The sidebar **ships collapsed** (`class="tm-admin-sidebar collapsed"`), so the rail flyout is the
default experience, not an edge case. Worth knowing when judging the design.

### Left out

- The reference's sidebar has a **dedicated rail toggle in a sidebar footer**; this project keeps its
  existing hamburger in the sidebar header. Not changed — it works, and replacing it would touch the
  `sessionStorage admin_sidebar_locked` restore.
- **Group membership is a judgement call**, not a derived fact. "Revenue" bundling Finance/Services/
  Policies, and Inquiries sitting outside "Outreach", are the arrangements that seemed to fit a
  booking business; both are a one-line move in the markup if you'd order them differently.

---

## Step 4 follow-up — three bugs reported after the fact, all fixed

**Label:** `consol5-navfix`. Reported: (1) sidebar labels missing, (2) an accent-coloured "glow"
staying gold under a non-gold accent, (3) not all sidebar sections clickable. All three were real;
none were cosmetic. Root causes below, each confirmed with a live measurement before being called a
cause, per the standing rule for this log.

### 1 & 3 together — the sidebar's default state hid most of the navigation

**Root cause A — wrong default.** `admin.html`'s `<aside>` shipped with a hard-coded `collapsed`
class. Every fresh session (new tab, new day, cleared `sessionStorage`) therefore loaded the icon-only
rail, not the labelled tree Step 4 built — so "no labels" was accurate, and every nested leaf was
unreachable without first discovering the hover/click affordance on an icon-only button. Fixed: the
default is now expanded. `sessionStorage['admin_sidebar_locked']` still remembers an explicit choice
to collapse, restored by a synchronous script placed immediately after `</aside>` (mirrors the
Appearance axes' pre-paint pattern from Step 3 — no flash of the wrong state).

**Root cause B — two independent click handlers on the same button.** `js/myscript.js` (loaded on
`admin.html` too, for shared components) carried its own, older `$tmSidebarToggle.on('click', ...)`
handler — dead code that happened to still bind, since its `#tmAdminSidebar` guard only prevented it
from running on the *public* page, not on admin. It fired first (loaded earlier in the document),
`admin.html`'s own handler fired second and read the class *that handler had just changed* — so most
clicks were a net no-op. Traced with a `MutationObserver` on the class attribute:
```
+0.0ms   class -> "...collapsed"   (myscript.js's naive toggle)
+11.7ms  class -> "..."             (admin.html's handler read that change and reverted it)
```
Fixed by deleting myscript.js's copy — admin.html's is a strict superset (padding-left, FullCalendar
re-measure, sessionStorage persistence, none of which the deleted copy had).

**Root cause C — a second desync, found while fixing B.** `toggleSidebar()` tracked open/closed via a
separate `dataset.locked` flag rather than reading the actual class. That flag was only ever written
to `'1'` by the (now-deleted) restore-on-load code, or `'0'` inside the function itself — never
initialised for "expanded because that's the new default, no explicit choice made yet." Reading it
as `false` there sent the *first* click after a fresh load into the wrong branch: a no-op, since the
sidebar was already expanded. Fixed by deriving `isLocked` from `!classList.contains('collapsed')`
directly — the class can't desync from itself.

**Root cause D — the real severity of "not clickable": the rail flyout was invisible, not just
hard to reach.** Confirmed with a direct measurement and a screenshot, not assumption:
```
.tm-admin-sidebar-scroll clip box:  0–71px
.atl-nav-sub (flyout) box:         71–289px   — entirely past the clip boundary
```
`.tm-admin-sidebar-scroll` sets `overflow-x: hidden` (pre-existing, load-bearing — stops a horizontal
scrollbar in the expanded state) which clips *every* descendant, including a `position:absolute;
left:100%` flyout trying to escape it. The screenshot showed exactly that: rail icons and the
dashboard behind them, no flyout, for hover *or* click. A scripted Puppeteer click had been passing
in earlier testing only because `page.click()` calls `scrollIntoViewIfNeeded()` first, which can
programmatically scroll a `hidden` axis even though nothing in the actual UI lets a person do the
same — a real user got nothing, ever, from the rail state.

`overflow-x: visible` cannot fix this: per the CSS Overflow spec, when one axis is `visible` and the
other (`overflow-y: auto`, needed for vertical scroll) is not, the visible axis is silently
recomputed to `auto` — which still clips. Escaping an overflow-clipping ancestor requires moving the
element out of that ancestor's subtree; there is no CSS-only fix.

**Fix: a JS-managed portal**, in `js/admin/sidebar-nav.js`. While railed, opening a group (hover,
keyboard focus, or a plain click) moves its `.atl-nav-sub` to a direct child of `<body>`,
`position: fixed`, positioned from the trigger's live `getBoundingClientRect()` — escaping the
clipping ancestor entirely — and returns it to its exact original DOM slot the moment it closes, so
tab order is unaffected whenever it isn't in use. Hover state is tracked across both the trigger and
the now-detached flyout (they're no longer DOM-adjacent, so `:hover` combinators can't reach across
the gap), with a short close-delay so crossing from one to the other doesn't flicker it shut.

### 2 — the "glow" was a real hard-coded colour, unrelated to the sidebar work

`.um-icon-header__icon` (`css/admin/redesign-admin.css:1127` — the small rounded square in front of
every settings-card heading; 44 occurrences on `admin.html`, including the one visible in the
original report) hard-codes `rgba(212,175,55,…)` / `#D4AF37` directly, never reading `--atl-amber`.
That file is kept byte-identical to the original `redesign.css` split (its own header says so), so
the fix lives in `css/core/appearance.css` instead — the file whose entire purpose is making the
admin respond to the Accent axis, loaded after it. One rule, three properties
(`background`/`border-color`/`color`) repointed at `--atl-amber-dim`/`--atl-amber-border`/
`--atl-amber`.

### A genuine dead end, recorded so it isn't re-chased

Mid-investigation, `page.click()` and `page.mouse.click()` (Puppeteer's CDP-dispatched mouse events)
stopped firing *any* listener on the toggle button — not even a freshly attached capture-phase
listener — specifically in the first few seconds after a `page.reload()`, while a plain
`element.click()` (same semantics as a real click or a keyboard Enter/Space activation) fired
correctly and toggled the class as expected. Confirmed with `elementsFromPoint` (button genuinely
topmost, no overlay), a body-level capture listener (fired, proving the event dispatches at all), and
a same-tick synthetic-click control (worked). This is a Puppeteer/headless-Chrome input-routing quirk
tied to the test harness, not a defect in the shipped code — the rest of this section's verification
uses `element.click()` throughout for that reason.

### Verification — 13 automated checks (`nav-final-verify.js`) + the original 10 (`nav-test.js`,
one updated for the portal) + all 16 Appearance checks, all passing; two screenshots

```
Issue 1   fresh session loads EXPANDED, a leaf label visible, a section eyebrow visible
Issue 1b  one click collapses, a second expands — no more no-op first click
Issue 1c  explicit collapse persists across reload; one click after reload re-expands it
Issue 2   default Gold renders gold; Vetiver recolours the icon square to green, not gold
Issue 3   every sidebar link clickable with every group open (scrolled into view first —
          5 groups open at once is an artificial stress case; content genuinely exceeds the
          scroll container's height, exactly like any long scrollable list would)
Issue 3b  rail flyout: portalled + visible from a click alone; the leaf is the real hit
          target at its coordinates (not clipped); clicking it navigates; portal cleans
          up and returns the submenu to its original DOM slot
```

Screenshots: the default fresh-session sidebar (expanded, labelled, Revenue group open,
`final-expanded.png`) and the Preferences page under a Vetiver accent showing the icon-header square,
tab underline and section icon all recoloured green (`final-vetiver-icons.png`) — confirming the fix
visually, not just via computed-style assertions.

### Blast radius

`consol1-tokens → consol5-navfix` CSS parity: **132 of 135 views changed** (2 more are pixels-only
analytics/timestamp drift, unrelated). That number looks alarming in isolation, so it was not taken
at face value — broken down by selector instead, the same way Step 4's blast-radius check was:

```
  .tm-nav-link              132x   sidebar links
  .adm-dropdown__menu       132x   header dropdown
  .db-social-grid           132x   dashboard social widget — reflow, not restyle (see below)
  .admin-sidebar li.active  108x   active state
  .tm-admin-main             44x   main content wrapper's padding-left
  .tm-admin-sidebar-header   44x   sidebar header bar (brand + toggle)
  .db-summary-grid            2x   same reflow story as .db-social-grid
```

**594 lines lost, 594 added — an exact match, meaning every one of these is a RESTYLE, nothing was
removed.** Every selector on the list is directly explained by the one deliberate change this pass
made: the sidebar's default state flipped from collapsed (72px) to expanded (260px). Since the
sidebar renders on every admin page, that single change legitimately touches every page:

- `.tm-nav-link` / `.adm-dropdown__menu` / `.admin-sidebar li.active` — the sidebar/dropdown
  components themselves, expected from Step 4 and now doubly affected by the default-width flip.
- `.tm-admin-sidebar-header` — the header BAR inside the sidebar resizes with the sidebar.
- `.tm-admin-main` — its `padding-left` is set by the CSS sibling-combinator rule keyed off the
  sidebar's `collapsed` class (`css/admin/redesign-admin.css:352`), so a wider default sidebar
  directly narrows the main content column on every page, at every breakpoint.
- `.db-social-grid` / `.db-summary-grid` — **reflow, not restyle.** A narrower main content column
  is exactly the kind of change that shifts how many columns a responsive grid fits; these are the
  dashboard's own grids re-wrapping in response to the width change, not anything touched directly.

**Nothing outside that explained set appears** — no table, form, modal, badge, or vendor-widget
selector shows up anywhere in the diff. The width change is exactly as wide as it should be (every
page, since the sidebar is global) and exactly as narrow as it should be (only sidebar-adjacent
components and their direct width-reflow consequences, nothing else).


---

## Step 5 — Admin shell and tokens copied from O'luhle/TOCA

**Label:** `consol6-toca` · deliberate global visual change

**Brief (user, 2026-09-25):** "The sidebar still doesn't look and behave like the O'luhle Scents admin
sidebar. Copy the exact styling of the admin token styling from there. Update the Thabiso Mhlongo admin
styling and functionality the same as O'luhle."

Step 4 had *adapted* TOCA's sidebar to Thabiso's existing look. This step replaces that with a copy.

### Reference = the live build, not the source

The O'luhle project is local (`Dev-Beast/O'luhle Scents/`) and its admin is served from a built bundle at
`http://localhost:3001/admin/`. Its source files (`Sidebar.jsx`, `DashboardLayout.jsx`,
`design-tokens.css`) contain **unresolved merge-conflict markers**, so the source is not what renders.
The ground truth used here:

- the built CSS/JS (`/admin/assets/main-*.css|js`) — tokens from the CSS, shell styles from the style
  strings embedded in the JS. The build shipped the "HEAD" side of the conflicts (brand block, labelled
  sections, footer rail toggle, account menu), confirmed by which class names exist in the bundle.
- **computed styles measured from the running TOCA admin** (37 shell elements), rendered headless with
  only `/api/auth/me` mocked — no credentials used, no data touched.

### What changed

| Area | Change |
|---|---|
| `css/core/tokens.css` | 20 dark values re-pointed to TOCA's; added `--atl-amber-dark`, `--atl-line-bold` |
| `css/core/themes.css` | 24 Ivory values re-pointed to TOCA's `.finish-ivory` + gold; same two tokens added |
| `css/core/appearance.css` | Ember + all accent ramps re-pointed to TOCA's (incl. `-dark` per accent; focus = accent base) |
| `css/admin/shell.css` | **new** — sidebar, top bar, account menu, rail flyout, mobile; replaces `sidebar-nav.css` |
| `css/admin/sidebar-nav.css` | **removed** (superseded; backup kept outside the repo) |
| `admin.html` | sidebar + top bar markup rebuilt to TOCA's structure; Appearance moved into the account menu; profile loader shows initials/name/role/email; ⌘K/Ctrl+K search; menu offset 10px; keyboard-only autofocus |
| `js/admin/sidebar-nav.js` | flyout re-positions after the sidebar's width transition |
| `js/appearance.js` | Ivory gold swatch → `#8a6a14` |

**Token names are unchanged** (744 `var(--atl-*)` references). Only values changed.

Notable value changes (dark): secondary text `#e0ddd6 → #b0b0b0`, muted `#949494 → #8f8f8f`, borders
10%/18% → 8%/15%, **radii 6/10/14/18 → 2/4/8/8px**, shadows to TOCA's `--sh-*`, motion to TOCA's
`.18s`/`.35s` curves, top bar background → page colour, nav widths 260/72 → 270/76.

### Shell — how "exact" was checked

`shell-diff.js` measures the same 21 computed properties on every Thabiso shell element and diffs them
against TOCA's measurements. Final result: **every property matches** except differences that come from
content (brand text "THABISO" vs "TOCA", 3 vs 4 children in the first group, a longer account menu) or
from the test's real mouse cursor resting on a button (hover colour).

Three translations were needed to produce identical output, none visible:
1. **rem → px.** TOCA runs on the browser's 16px root; this admin sets `html{font-size:14px}`, so every
   copied `rem` would have rendered 12.5% small. All TOCA sizes are written as their px value at 16px.
2. **TOCA variables → `--atl-*`**, so Finish/Accent still drive the shell. TOCA hard-codes `#fff` for
   hover/current text; that became `--atl-ink`, which is why Thabiso's Ivory shows dark text where
   TOCA's own Ivory shows white on cream.
3. **`sh-` class prefix.** TOCA's `.top` is used 100+ times in existing admin CSS, and `.side`, `.brand`,
   `.brand-name`, `.search` also collide; copying the names verbatim would have pulled those rules in.

TOCA quirks copied deliberately because they are part of its look: group labels render at weight 400
(buttons don't inherit body's 300) while plain links are 300; section labels have no top margin (each
is its section's `:first-child`); closed groups keep a 10px sub-list margin, spacing the rows after them.

### Deliberate departures from TOCA

- **The rail flyout works.** TOCA positions it `absolute` inside a nav with `overflow-x:hidden`, which
  clips it — verified in the live TOCA admin: hovering a railed group shows a 2px gold sliver and the
  links are not clickable. Here the identical-looking flyout is portalled to `<body>` (Step 4 follow-up).
- **Account menu keeps Thabiso's quick actions** (New booking / New inquiry / New event) between TOCA's
  items and Sign out. TOCA has no equivalent; removing them would drop functionality. One markup block
  to remove if you want the menu identical.
- **Brand text** is "THABISO / Mhlongo · Admin" with a "T" mark (TOCA: "TOCA / Admin"). The old logo
  image and breadcrumb were removed from the top bar, as TOCA has neither there.
- **Mobile breakpoint stays 768px** (TOCA: 1080px). Between 769–1080px Thabiso still shows the
  sidebar; moving the breakpoint would reflow every section's existing responsive rules.
- **Appearance opens as a panel under the top bar**, not TOCA's side drawer.

### Bugs found and fixed during this step

1. **My token-port script broke the token layer.** It wrote annotations as `/* TOCA */ --text-muted — was
   #949494`: the text after `*/` is raw CSS, which swallowed the *following* declaration on every edited
   line. Caught by the computed-style diff (colours falling back to white, borders missing), not by eye.
   All 48 annotations moved inside their comments; a scan confirms no stray text remains after any
   token declaration.
2. `css/style.css` makes `.admin-sidebar` a centred, wrapping flex row — nav items sat side by side.
3. A global `.tm-nav-text{opacity:0}` (redesign-admin.css) made portalled flyout labels invisible.
4. `redesign-admin.css` draws a rule under every section title — removed in the shell.
5. The legacy rail widened on hover (TOCA doesn't) — disabled.
6. The dropdown manager focused the first menu item on every open, so a mouse click showed the first
   row as hovered. Now only keyboard-opened menus move focus (TOCA behaviour).
7. `#logoutBtn` is bound unguarded at load (`admin.html` ~8500); removing it would throw and halt the
   rest of that script. The account menu's Sign out now carries that id.

A testing note, so it isn't re-chased: Puppeteer's clipped screenshots temporarily resize the viewport
to the clip size, which at 420px flips the page into its mobile layout mid-capture — that produced a
misplaced/missing flyout in screenshots only. Use `captureBeyondViewport:false` for small clips.

### Contrast (WCAG AA, text 4.5:1), ported values

All pass except one value TOCA itself ships:

| | paper / sidebar / card / surface2 |
|---|---|
| Obsidian muted `#8f8f8f` | 6.12 / 5.84 / 5.38 / 4.80 |
| Ember muted `#9a8b78` | 5.87 / 5.60 / 5.18 / 4.63 |
| Ivory muted `#635d50` | 5.65 / 5.16 / 6.43 / 5.89 |
| **Ivory gold `#8a6a14`** | **4.37 / 3.99** / 4.97 / 4.56 — fails on page and sidebar |

The sidebar failure matters: the active sub-link's text uses gold on the Ivory sidebar. **`#7f6212`**
(same hue, slightly darker) clears all four: 4.96 / 4.53 / 5.65 / 5.17. Kept at TOCA's value because
the brief was "exact"; it is a one-line change in `css/core/themes.css` (plus the swatch in
`js/appearance.js`).

### Verification

- Shell computed-style diff against live TOCA: all properties match (see above).
- `nav-final-verify.js` 13/13, `nav-test.js` 10/10, `appearance-test.js` 16/16. Five expectations were
  updated to assert the new TOCA values (5 section labels incl. Insight; focus ring = accent base;
  Ivory surfaces and gold; in-place rail submenu no longer absolutely positioned) — none removed.
- Screenshots: expanded, group open, account menu, rail, rail flyout, Ivory+Cassis, Ember+Cuivre,
  mobile top bar and drawer.

### Blast radius — `consol5-navfix → consol6-toca`

**132 of 135 views changed** (2 more pixels-only data drift). Expected: token values reach every page.
Broken down by selector and *property* (`prop-breakdown.js`), rather than taken as one number:

- **44 selectors — explained.** Either only token-driven properties moved (border, border-radius,
  colour, background, box-shadow — e.g. `.atl-card`, `.form-control`, `input`, `.modal-content`,
  `.flatpickr-*`, `.fc-*`, headings, tables, Quill), or the selector is part of the rebuilt shell
  (`.tm-admin-sidebar`, `.tm-nav-link`, `.adm-header`, `.adm-search__input`, `.adm-dropdown__menu`…).
- **7 selectors changed a non-token property outside the shell**, each accounted for:
  - `.admin-section` padding — intended (TOCA's 32px page padding).
  - `.adm-breadcrumb`, `.nav` absent — intended (breadcrumb removed from the top bar; Bootstrap `.nav`
    removed from the sidebar list).
  - `.db-summary-grid` columns (6 views) — reflow from the main column's new width.
  - `.apexcharts-canvas`, `.jvm-container` (1 view each) — chart render timing, not CSS.
  - **`.db-social-grid` display: grid → none (132 views)** — *not* caused by this work. It is hidden
    by the admin setting `dashboard_show_social_cards`, which reads `"0"` in the database, updated
    `2026-09-25 14:30:54` UTC — seven minutes after a login from a desktop Edge browser (14:23:56),
    none of this session's test scripts touch that toggle. The setting was left untouched; re-enable
    it under Outreach → Social Media → "Social Media cards on the dashboard".
- **No selector disappeared** that existed before, other than the intended removals above.

---

<<<<<<< Updated upstream
## Step 6 — Applying the token scale; a first, bounded pass at portal-wide standardisation

**Label:** `consol7-tokenapply` · CSS-only, no markup/JS behaviour change

**Brief (user, 2026-09-29):** "Standardise the entire admin portal using the sidebar (Step 5's shell)
as the design reference — navigation, page structure, forms, buttons, tables, cards, drawers,
overlays, typography, colours, states, responsive, both themes, accessibility — reuse existing
components rather than one-off CSS, and audit every section rather than assuming it's already done."

### What this step actually is, and isn't

The brief's scope — every category, across ~25 admin sections — is not a CSS pass; it is comparable
in size to Steps 1-5 combined, and attempting it in one sitting risks exactly what the brief itself
warns against (§16): broad, shallow, unverified changes to a revenue-critical application. This step
instead audited what Steps 1-5 already delivered against the brief's checklist, found the concrete,
already-well-specified gaps that step deliberately deferred, fixed those, and verified them the same
way every prior step did. What remains unaddressed is listed at the end, not silently skipped.

**Already satisfied by Steps 1-5, confirmed rather than assumed:**
- **One token layer** (`css/core/tokens.css`/`themes.css`/`appearance.css`) that 744 `var(--atl-*)`
  references across the codebase already draw from — Step 5's own blast-radius count (132/135 views)
  is direct evidence the token layer already reaches nearly everywhere.
- **One overlay-stack behaviour** (Step 2) and **one drawer component** (`js/admin/components/
  drawer.js`, referenced from 7 files: admin.html, about/bookings-actions/bookings-contracts/
  bookings-dealview/bookings-finance/services).
- **One reusable table + pagination component** (`js/admin/components/data-table.js` /
  `pagination.js`), adopted by 6 sections (email logs, financials' reminders, newsletter's
  subscribers + campaigns, security-audit's audit log + POPIA requests, user-management's users +
  logs) — 8 `new DataTable(...)` instances total.
- **One search-input standard** (`.um-input`, per the earlier `a4d9484b style(admin): make all
  search boxes use the #eventsAdmin (.um-input) standard`).

**Concrete gaps found, all traced to specific, previously-unresolved comments already left in
`tokens.css` describing exactly this — not newly discovered:**

1. **The sidebar's own z-index was declared three different, disagreeing ways** across three older
   files the shell only ever *out-!important*s on other properties: `.tm-admin-sidebar { z-index:
   200 }` (12-focus-accessibility.css, mobile), `1040` (redesign-admin.css, base), `10000`
   (redesign-admin.css, an off-canvas variant). None is wrong in isolation; together they mean the
   *effective* stacking order the sidebar actually gets depends on which of the three currently
   applies, not on a single decided value. Fixed with one new, unconditional rule in `shell.css`:
   `#tmAdminSidebar { z-index: var(--atl-z-sidebar) !important; }` — same pattern the shell already
   uses everywhere else (win by loading last, `!important`, over the five legacy files), so nothing
   about *how* the shell asserts precedence changed, just that this one property now does too.
2. **`.adm-header`'s two z-indexes (300 vs 1040)** — already resolved by Step 5 without documenting
   it as such: `#adminControlBar` (the same element, confirmed — `<header class="adm-header sh-top"
   id="adminControlBar">`) already carries `z-index: var(--atl-z-sticky) !important` in `shell.css`,
   which wins on both specificity (ID > class) and source order. No change needed; recorded here so
   the open item in `tokens.css`'s comment doesn't get re-investigated as if it were still live.
3. **Search-results / dropdown-menu z-index (2000 vs 5000)** — not actually a conflict once read in
   context: `.adm-search__results` is 2000 on desktop (a dropdown) and 5000 only inside a mobile
   media query where it becomes a full-screen overlay (deliberately higher, to clear the mobile
   sidebar). Both values, and `.adm-dropdown__menu`'s matching 2000, were still bare literals rather
   than reading the two tokens `tokens.css` had already named for exactly this pair
   (`--atl-z-dropdown`, `--atl-z-search`) — wired to them, no value changed.
4. **`.atl-modal-overlay` (9000) and `.atl-actions-dropdown-panel` (99999)** were likewise bare
   literals matching already-named tokens (`--atl-z-modal`, `--atl-z-action-menu`) — wired, no value
   changed. The *relative ordering* `tokens.css` flags between modal/profile-menu/action-menu (a
   dropdown left open could in principle render over a later-opened modal) is a real question but a
   values decision, not a wiring one — left as the open item it already was rather than reshuffled
   without being able to trace every place that currently depends on the existing order.
5. **The brand colour, `#D4AF37`, was still hardcoded 47 times** across `redesign-admin.css` (44),
   `03-bookings-panels.css`, `04-section-backgrounds.css` and `07-components.css` (1 each) — mostly
   as direct `color`/`border-color`/`background`/`outline` values that `var(--atl-amber)` already
   provides everywhere else, including four `var(--atl-amber, #D4AF37)` fallbacks (the fallback was
   always identical to the token, so simplified to a bare `var(--atl-amber)`). Converted mechanically,
   then checked for exactly the failure mode a blind find-replace risks: **one instance
   (`--bk-quoted`, a `:root` status-badge colour) was itself a token *definition*, one of nine
   `--bk-*` status colours that are all deliberately theme-independent (a booking-status pill looks
   the same on Obsidian and Ivory) — turning only that one theme-aware via `var(--atl-amber)` would
   have made QUOTED the one status pill that shifts hue on Ivory while its eight siblings don't.
   Reverted to a fixed hex, matching its siblings; the other 46 sites (direct property usages, not
   token definitions) kept the conversion.

### Verification

`scripts/css-parity.js` against an isolated DB copy (throwaway seeded admin, no production data),
22 sections × 2 themes × 1440px (viewports narrowed — none of this is viewport-dependent; §15's full
3-viewport matrix isn't needed to catch a colour or z-index regression):

- First pass caught the `--bk-quoted` issue above by itself — `STYLE CHANGED` on 30/45 views, every
  one traced (via the per-view computed-style fingerprint, not just the pixel hash) to that single
  `:root` token line. Fixed, recaptured.
- Second pass: **0 genuine style changes.** The remaining 13/45 "changed" views all differ on exactly
  one property, `.tm-admin-main`'s `padding-left` (e.g. `269.467px` vs `270px`) — the sidebar-width
  transition not having fully settled at capture time in one run or the other, present in both
  directions (sometimes before < after, sometimes the reverse) across otherwise-identical fingerprints.
  Not caused by this change; recorded here as a capture-methodology note for the next phase, the same
  way Step 5 recorded the dashboard social-cards setting as drift rather than a regression.
- `node test/run.js` (809/809) and `npm run test:browser` (all 6 files, including the admin-portal
  browser test added alongside the location-search work two sessions ago) both still pass — this
  step touched no markup or JS, so this mainly confirms the CSS edits didn't break parsing.
- Cache-busters bumped: `shell.css`, `redesign-admin.css`, `03-bookings-panels.css`,
  `04-section-backgrounds.css`, `07-components.css` — none had a `?v=` query before this step.

### Left out — the size of the real remaining brief

The brief's checklist is much larger than the above, and none of it should be read as done:

- **Bookings — the largest, most business-critical section — does not use the shared DataTable /
  Pagination component.** `js/admin/bookings-pipeline.js` hand-rolls its own row rendering and
  filtering. Whether that's a safe migration or a case where Bookings' own requirements (pipeline
  stages, deal-view drawer, kanban-style grouping) genuinely don't fit the shared component is its
  own investigation — not attempted here given the size and centrality of that surface.
- **A full per-category audit of all ~25 sections** (typography scale, card variants, empty/loading
  states, badge/pill styling beyond the one `--bk-*` set touched above, responsive behaviour beyond
  what the shell itself already handles, focus-visible coverage beyond `12-focus-accessibility.css`'s
  existing scope) has not been done. This step found and fixed what was already concretely flagged;
  it did not re-run Step 5's own full-shell audit process against the other ~7000 lines of admin CSS.
- **The remaining ~40+ distinct hardcoded-colour/shadow/radius values** this pass's grep surfaced but
  didn't touch (every other semantic colour beside the one brand amber, plus shadow and
  border-radius literals matching `--atl-shadow-*`/`--atl-r-*`) are the same *kind* of finding as §5
  above, at a scale that needs its own pass(es) to do with the same care (the `--bk-quoted` near-miss
  is exactly why "mechanical" still needs a human check on every non-obvious substitution).

**Recommended next step**, if this is picked up again: one category at a time (e.g. "every hardcoded
shadow value" or "Bookings onto the shared table"), each with its own before/after parity capture —
the same shape as Steps 1-5, rather than attempting the full brief as a single step.
=======
## Step 6 — Portal-wide standardisation, increment 1: audit + component consolidation

**Brief:** "standardise the entire admin portal using the new sidebar's design language" — full 18-section
brief plus an explicit DRY/reuse addendum ("reuse existing code, do not create multiple versions of the
same component"). Scope: admin only, never `index.html`.

### Audit finding, before any edit

The premise that the rest of the admin needs a component system *built* is wrong — it already has one.
`css/admin/07-components.css` carries "UNIVERSAL CARD/BUTTON/FORM/TABLE/MODAL SYSTEM" blocks that already
bridge legacy class names onto shared, token-driven rules (`.atl-card, .db-card, .cms-card`; `.atl-btn,
.btn-admin-primary, .um-btn`; `.form-control, .um-input, .tm-form-input`; etc.), and `docs-internal/
oluhle-admin-reference.md` §5 already scoped and partly executed this exact work before Step 5 (tokens,
z-index scale, `overlayStack` port are already done — see tokens.css's z-index scale and `js/overlay-
stack.js`). So this increment is a **gap-finding pass against a mature system**, not a from-scratch build
— consistent with the brief's own reuse instruction.

### Fixed

1. **Theme-breaking hardcodes in the global search dropdown** (`redesign-admin.css` `.adm-search__results`
   and its descendants) — the entire panel (`#141414` background, `#2a2a2a` border, `#ccc/#fff/#ddd/#666/
   #555` text, `#D4AF37` accents) was hardcoded to dark values with **no light-theme override anywhere**,
   unlike every other themed surface in the admin. In light theme this rendered a dark popup with
   dark-on-dark badge tints over the site's cream chrome. Repointed every value to the matching `--atl-*`
   token (`--atl-surface2`, `--atl-line-strong`, `--atl-shadow-modal`, `--atl-ink`/`-dim`, `--atl-muted`,
   `--atl-amber`/`-dim`), keeping the old literal as the `var(..., fallback)` value — this file's own
   existing convention (`.adm-search__input::placeholder` already does this). The booking/event result
   badges had no `--atl-*` equivalent for their green/blue tints, so they now read `rgba(var(--atl-sage-
   rgb), .15)` / `rgba(var(--atl-blue-rgb), .15)` — reusing the RGB-channel tokens already defined for
   exactly this purpose, rather than inventing new ones. **Not yet visually verified against a live login**
   (no admin credentials in this session) — spot-check the search dropdown in light theme.
2. **Focus-ring colour, tokenised.** `rgba(212,175,55,0.22)` was hardcoded at 10 call sites across 6 files
   (`07-components.css` ×5, `04-section-backgrounds.css`, `17-shell-forms.css`, `20-calendar-filters.css`
   ×2, `redesign-admin.css`) for every text-input/select/textarea focus box-shadow — same defect class as
   #1 (never re-declared for light theme, so every focused field showed the *dark* theme's gold at 0.22
   alpha regardless of the active theme). Added `--atl-focus-ring: rgba(var(--atl-amber-rgb), 0.22)` to
   `core/tokens.css` (built from the already-per-theme `--atl-amber-rgb` channel, so it needs no restating
   in `themes.css` — same same-element `var()` resolution rule `oluhle-admin-reference.md` §2 documents),
   and repointed all 10 sites. Two near-identical literals were deliberately left alone after checking
   their call sites: `07-components.css:939` (`.atl-promote-ticket-save:hover` background fill, not a
   focus ring) and `calendar.css:85` (`[data-theme="dark"]` `.fc-day-today`, already theme-scoped
   on purpose per its own comment) — reusing a "focus ring" token for either would be a misnomer than a
   consolidation.
3. **Badge radius, tokenised.** `border-radius: 999px` (`atl-status-badge`, `atl-payment-badge`,
   `atl-tag-badge`, `evt-badge`) and `border-radius: 20px` (`svc-card__cat-badge`, `svc-card__model-
   badge`, `svc-tag`, `adm-search__result-badge`) both already render as a full pill at badge scale —
   repointed both to the existing `--atl-r-pill` token (already `999px`). Zero visual change; removes 8
   more hardcoded repeats of a value that already had a name.
4. **Dead tab system quarantined.** `.nav-tabs` (Bootstrap tabs) in `07-components.css` had exactly one
   remaining match anywhere in `admin.html`/`js/`: the comment at `admin.html:2353` documenting that its
   one caller ("Ledger tabs") already migrated to `.atl-tab-bar`. Confirmed dead, not just unlikely —
   moved verbatim to `_quarantine/css/admin/07-components.dead-rules.css` per the Phase 8 convention
   (soak before delete), leaving a pointer comment. The admin now has exactly one tab visual language.

### Audited and left alone (real duplication, but lower value or higher risk than the above)

- **Section-specific badge families** (`.um-role-badge`/`.um-status-badge`, `.inq-badge`/`.inq-overdue-
  badge`, `.evt-badge--*`) already use `--atl-*` tokens and `--atl-r-pill` (post-fix) for their base shape
  — they differ from `.atl-badge` only in class name, not in any token/value that's actually wrong. Worth
  a follow-up pass to fold them onto one shared base rule (a `07-components.css`-style combined selector,
  same technique already used for buttons/cards/inputs), but that's a bigger, purely-cosmetic refactor
  with no live defect behind it — deferred rather than rushed.
- **Pagination containers** (`.um-pagination-btns`, `.inq-pagination`, `.atl-pagination-bar`, `.lc-
  pagination`) turned out to already share the real component (their buttons are `.atl-btn`); the
  per-section classes are layout wrappers whose differences (space-between vs centered, border-top or
  not) track genuine content differences, not drift. No change made — flagged in case that judgment is
  wrong for a section not yet built.
- **`.atl-btn`/`.atl-input`/`.atl-modal-*` at `07-components.css:97-295`** duplicate declarations that the
  file's own later "UNIVERSAL BUTTON SYSTEM" block (line ~1320) already supersedes for every overlapping
  property (same class, second declaration wins by source order) — cosmetically redundant but not
  provably safe to delete in this pass without diffing every non-overlapping property (e.g. `outline:
  none` at line 107) computed-style-by-computed-style first. Left in place rather than guessed at.

### What Sections 2–11 of the brief still need, beyond this increment

This pass covered tokens/badges/tabs — a slice, not the full 22-section, every-control sweep the brief
asks for. Sections not yet audited section-by-section against the shell language: Calendar, Events,
Gallery, Home, Career/Milestones, Testimonials, Footprint, Newsletter, Contact, Social, Legal/Policies,
Preferences, Email Logs/Management, Finance, Quotes, Invoices, Payments, Settings — and the full
mobile-breakpoint and light/dark sweep the brief's §14/§15/§18 ask for. Flagging explicitly rather than
implying the brief is complete.
>>>>>>> Stashed changes
