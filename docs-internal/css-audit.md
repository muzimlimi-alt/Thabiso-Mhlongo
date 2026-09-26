# CSS Architecture Audit — Phase 0

**Date:** 2026-09-23
**Branch:** `feature/booking-system-overhaul`
**Status:** Audit only. **No files changed.**
**Scope:** `index.html`, `admin.html`, `css/**`, `js/**`, `app.js`, SQLite content columns.

> **Deliverable path note.** The brief specifies `docs/css-audit.md`. In this repo `docs/` is **not** a
> documentation folder — it is the runtime PDF store for client contracts, invoices and quotes
> (235 tracked files), and it is gitignored (`.gitignore:18`). A file written there would sit among
> client financial documents and would never be committed. `docs-internal/` is the tracked
> engineering-docs folder (`admin-html-map.md`, `routes.md`, `data-access.md`, `asset-references.md`),
> so the audit lives here. Flagging rather than silently relocating — say the word if you want it moved.

---

## 1. Headline findings

Five things materially change the plan. Everything else in this report is detail.

### F1 — `--atl-*` tokens do not exist on the public site, and public CSS references them anyway

All 85 `--atl-*` definitions live in **`admin.html` only** (lines 729–800 dark, 805–839 light).
`index.html` defines none, loads no file that defines any, and no script injects them at runtime.

Yet three stylesheets the public page **does** load reference `--atl-*`:

| File | `var(--atl-*)` refs | Loaded by |
|---|---|---|
| `css/style.css` | 47 | both pages |
| `css/redesign.css` | 18 | both pages |
| `css/notifications.css` | 11 | both pages |

Verified in a real browser (Chrome 147, `http://localhost:3000/index.html`):

```
--atl-amber = (UNDEFINED)     --atl-card = (UNDEFINED)     --atl-ink = (UNDEFINED)
--atl-line  = (UNDEFINED)     --atl-muted = (UNDEFINED)
```

Those declarations are *invalid at computed-value time* — the property falls back to `inherit`
(inherited properties) or `initial` (everything else). **This is a live defect, not a theory.**
The clearest consequence, measured on the running site:

```
index.html  .tm-toast  ->  background-color: rgba(0, 0, 0, 0)     ← fully transparent
                           color:            rgb(245, 245, 245)
```

`notifications.css:10` sets `--noti-bg: var(--atl-card)` and `:13` sets `--noti-gold: var(--atl-amber)`.
Both resolve to UNDEFINED on the public page, so **every toast and modal on the public site renders
with no background panel and no gold accent.** `--noti-text`, `--noti-border` and `--noti-bg-deep`
survive only because they carry literal fallbacks.

**Why this dominates the plan:** G1 (move tokens to a shared `css/core/tokens.css`) is described in the
brief as a cascade risk. It is worse than that — it is a **guaranteed visual change**, because defining
`--atl-*` on the public page will switch on ~39 currently-inert declarations at once. That collides
head-on with constraint §2.1 (pixel parity). It needs your explicit decision (see G1 below).

Most of the inert declarations in `style.css` are in legacy rules that `redesign.css` already overrides
(e.g. `#back-to-top` is fully redefined at `redesign.css:2092`; the `.career-panel` accordion markup no
longer exists — `#career` is now `.tm-milestones` / `.ms-row`, `index.html:373`). The notification
system is the surface where the breakage is actually visible.

### F2 — `redesign.css` is two stylesheets in one trench coat, and both pages load all of it

`css/redesign.css` is 181 KB / 5,692 lines. Class-name analysis against both pages' markup:

| Region | Distinct classes | Notes |
|---|---|---|
| matched in **public** markup only | 249 | the actual redesign |
| matched in **admin** markup only | **123** | admin shell, from ~line 3740 onward |
| matched in both | 17 | genuinely shared |
| matched in neither | 153 | 92 referenced from `js/`, 61 unmatched (see §6) |

From `redesign.css:3742` the file becomes the admin portal: `.admin-body`, `.admin-layout`,
`.tm-admin-sidebar` (3966), `.adm-header` (4354), `.adm-search__*` (4417–4515), `.adm-dropdown__*`
(4520–4590), `.um-*` user-management drawers (4995–5300). **`index.html` downloads and applies roughly
1,950 lines of admin CSS it can never use** — and some selectors in that region are generic enough to
reach public markup (`.nav` at 4078, `.collapsed` at 3985).

This is the single largest structural win available and maps cleanly onto the `public/` ÷ `admin/` split
in §6 of the brief.

### F3 — Three parallel token systems, none of them retired

| System | Defined in | Consumers |
|---|---|---|
| `--atl-*` (85 tokens) | `admin.html:729–839` | admin.html (2,751), `css/admin/*` (477), `js/` (744) |
| `--bg-* --y-* --text-* --f-* --fs-* --r* --sh-*` | `redesign.css:17–140` | public site, `tracking.css` |
| `--noti-*` | `notifications.css:8–37` | notification system (bridges to `--atl-*`) |
| `--tm-*` (alias layer) | `admin.html:189–200` | admin login screen — pure aliases onto `--atl-*` |
| `--sidebar-*`, `--bk-*` | `redesign.css:3910`, `:5375` | two more ad-hoc `:root` blocks |

`:root` is declared in **5 separate places**. `error.html:22–69` carries a *sixth*, hand-copied partial
`--atl-*` set that has already drifted (it defines `--atl-glow` and `--atl-selection`, which don't exist
in `admin.html`; `admin.html` has `--atl-selection-bg`).

Also: `js/` references four tokens that **are not defined anywhere**, surviving on fallbacks only —
`--atl-bg`, `--atl-border`, `--atl-mono`, `--atl-font-display`
(e.g. `js/admin/testimonials.js:52`, `js/admin/calendar.js:81`).

### F4 — The brief describes a preloader that does not exist

`grep -rn "preloader"` across the entire repo (excluding `node_modules`) returns **zero hits**. There is
no preloader element, no preloader CSS, and no "four legacy CSS variables". Searches for
`loader|splash|intro|curtain` in `index.html` also come back empty.

**Therefore G2 is moot**, `css/public/preloader.css` should not be created, and the §15 test-matrix row
"Preloader plays and dismisses as before" has nothing to test. Everything else in §15 stands.

### F5 — Duplicate `<link>` tags and duplicate component definitions already violate §14

`admin.html` links the same stylesheet more than once:

- `css/admin/calendar.css` — **3×** (lines 1278, 1348, 3386)
- `css/admin/dashboard.css` — **2×** (lines 3152, 3530)

And two files define the same components with **different values**:

```
.db-summary-grid   dashboard.css:92   → grid-template-columns: repeat(2, 1fr)
                   dashboard-widget.css:80 → grid-template-columns: 1fr
.db-social-grid    dashboard.css:101  → repeat(2, 1fr)
                   dashboard-widget.css:306 → 1fr
```

`dashboard-widget.css` is linked at line 4874, after both `dashboard.css` links, so **it currently wins**.
That is a load-order accident, not a decision. Resolving it is required by the acceptance criteria and
must be logged as a deliberate re-derivation.

---

## 2. Full-stack impact analysis (§1 of the brief)

| Layer | Confirmed impact | Evidence |
|---|---|---|
| **Database** | **Low, but not none** | 71 tables scanned, all text columns. Findings below. |
| **Backend** | **None** | `app.js:341` — `express.static(path.join(__dirname,'/'))` serves the repo root, so any new `css/**` subfolder resolves with no config change. No route whitelists CSS paths. CSP `styleSrc` (`app.js:179`) is `'self' 'unsafe-inline'` + CDNs — new subfolders are covered by `'self'`. Cache headers are extension-based (`.css` → `max-age=86400`), not path-based. |
| **Frontend – public** | **High** | 7 `<link>` + 1 inline `<style>` (41–115) + 1 JS-injected `<style>` (`index.html:127`) + 204 inline `style=""`. |
| **Frontend – admin** | **Very high** | 12 `<link>` in `<head>` + 13 more mid-`<body>` + **19 inline `<style>` blocks totalling 4,511 lines** + 2,606 inline `style=""`. |
| **Email templates** | **Out of scope, confirmed clean** | `js/emailTemplates.js` links no project stylesheet. |

### Database detail

| Table.column | What's stored | Refactor risk |
|---|---|---|
| `about_me.paragraph1/2/3` | Quill HTML with **hardcoded inline colours** — `rgb(26,26,26)`, `rgb(176,176,176)` | Renders on the public About section. Inline styles beat any stylesheet, so these are **theme-locked to dark** and cannot respond to tokens. Not broken by the refactor; flagged because they silently defeat it. |
| `newsletter_campaigns.content`, `scheduled_newsletters.content` | Quill classes — `ql-size-huge` | **`ql-*` is a frozen vendor namespace.** Never rename; Quill's CSS must keep matching stored content. |
| `contracts.content_html` (2 rows) | Self-contained `<style>` for PDF generation | Independent of project CSS. No impact. |
| `notifications.body` (169 rows) | Stored email HTML | Email layer. Out of scope. |
| `settings.setting_value` | Email template with inline `style=""` | Email layer. Out of scope. |

**No stored theme preference and no stored project class names outside the Quill namespace.** Renaming
project classes will not break stored content — but §2.3 / G5 still apply.

---

## 3. Inventory (§3.1)

### Stylesheet files

| File | Size | Lines | Loaded by |
|---|---:|---:|---|
| `css/bootstrap.min.css` | 156,629 B | 7,211 | both — **Bootstrap v3.3.6** (+ normalize 3.0.3) |
| `css/redesign.css` | 181,498 B | 5,692 | both (`?v=2` on public only) |
| `css/style.css` | 26,686 B | 1,144 | both |
| `css/notifications.css` | 16,227 B | 507 | both |
| `css/tracking.css` | 15,736 B | 443 | **public only** |
| `css/admin/inquiries.css` | 29,478 B | 367 | admin |
| `css/admin/dashboard-widget.css` | 17,647 B | 451 | admin |
| `css/admin/calendar.css` | 6,315 B | 157 | admin (**×3**) |
| `css/admin/dashboard.css` | 4,479 B | 110 | admin (**×2**) |
| `css/admin/events.css` | 4,124 B | 55 | admin |
| `css/admin/legal-compliance.css` | 3,058 B | 32 | admin |
| `css/admin/about.css` | 2,350 B | 35 | admin |
| `css/admin/email-logs.css` | 1,342 B | 22 | admin |
| `css/admin/email-logs-2.css` | 948 B | 20 | admin |
| `css/admin/security-audit.css` | 389 B | 5 | admin |

**Project CSS total: 310,277 B.** Vendor: 156,629 B.
`_quarantine/css/*.dead-rules.css` (6 files, tracked) are retired rules from the earlier housekeeping
refactor — precedent for where removed CSS goes.

### `css/tracking.css` — placement resolved

Styles the **public** booking-tracking modal: `#trackingModal`, `.trk-*`, `.pay-btn-*`. It consumes the
**redesign token system** (`--text-primary`, `--f-body`, `--bg-page`, `--r-md`), not `--atl-*`. Loaded
only by `index.html`. → belongs at **`css/public/tracking-modal.css`**. Not dead; do not `/TBC` it.

### Load order — public (`index.html`), verified in-browser

```
1  css/bootstrap.min.css                          (30)
2  cdnjs … font-awesome 6.5.0                      (31)
3  cdnjs … intl-tel-input 17.0.19                  (32)
4  css/style.css                                   (35)
5  css/redesign.css?v=2                            (36)
6  css/tracking.css                                (37)
7  css/notifications.css                           (38)
8  INLINE <style>                                  (41–115)
9  INLINE <style data-tm-sections>  — injected by index.html:127
```

Item 9 is a JS-injected sheet that hides sections per `localStorage.tm_sections` using
`{display:none !important}`. **It must keep loading last** or section-hiding breaks. `?v=2` appears on
`redesign.css` on the public page but **not** on admin — the cache-busting pattern is already inconsistent.

### Load order — admin (`admin.html`)

`<head>`: font-awesome → bootstrap.min.css → style.css → redesign.css → intl-tel-input → notifications.css
→ flatpickr → quill.snow.css → Google Fonts → jsvectormap, then inline blocks.

**13 further `<link>` tags appear inside `<body>`** (lines 1278–4874), interleaved with inline `<style>`
blocks. Load order is therefore partly determined by document position, which makes the current cascade
fragile and hard to reproduce — this is the main risk in Phase 7.

Google Fonts is loaded **twice**: `<link>` at `admin.html:26` and `@import` at `redesign.css:14`. The
`@import` also serialises against `redesign.css` itself (§2.5 explicitly warns about this).

### Inline `<style>` blocks — `admin.html` (19 blocks, 4,511 lines)

```
  38–179   (142)     180–186   (7)      187–572  (386)     575–719  (145)
 722–1277  (556) ←tokens   1279–1281 (3)  1283–1347 (65)  1349–3151 (1803) ←largest
3153–3157  (5)     3159–3385 (227)   3387–3449 (63)    3451–3477 (27)
3479–3529  (51)    3531–3873 (343)   3875–4105 (231)   4107–4121 (15)
4123–4222  (100)   5648–5695 (48)   14753–15046 (294)
```

### Inline `style=""` attributes

| Page | Count | Top patterns |
|---|---:|---|
| `admin.html` | 2,606 | `color:var(--atl-ink)` ×482 · `color:var(--atl-amber)` ×127 · `display:none` ×84 |
| `index.html` | 204 | `display:none` ×24 · `margin-right:6px` ×13 · `color:#D4AF37` ×6 |

The two leaders in admin (609 combined) are pure token colour application on static markup — the
highest-value, lowest-risk §10 extraction available.

### Styles injected by JS

| Vector | Count | Notes |
|---|---:|---|
| `.style.` | `js/` 129 · admin 95 · index 3 | mostly runtime `display`/position — **leave inline** per §10 |
| jQuery `.css(` | `js/` 210 · admin 20 · index 11 | same |
| `cssText` | 6 in `js/` | `calendar.js:81`, `testimonials.js:52` build token-bearing CSS strings |
| `createElement('style')` | 1 | `index.html:127` (section hiding) |
| `insertRule` | 0 | — |

### Class manipulation (the frozen surface)

| API | `js/` | admin.html | index.html |
|---|---:|---:|---:|
| `addClass` | 108 | 6 | 4 |
| `removeClass` | 104 | 3 | 3 |
| `toggleClass` | 17 | 8 | 0 |
| `hasClass` | 47 | 0 | 0 |
| `classList.*` | 52 | 29 | 6 |

---

## 4. Token audit (§3.2)

`--atl-*`: **85 definitions**, `admin.html:729–800` (dark, under `[data-theme="dark"], :root:not([data-theme="light"])`)
and `:805–839` (light, under `[data-theme="light"]`). Families: surfaces (7), text (5), lines (2),
amber (6), status (6), focus (1), shadows (4), overlays (4), radius (5), transitions (3), spacing (6).

**Theme mechanism (G6):** `document.documentElement.setAttribute('data-theme', savedTheme)`,
`admin.html:8`, persisted to `localStorage`, read before paint. Default dark via
`:root:not([data-theme="light"])`. **No `prefers-color-scheme` anywhere in the project.**
The public site has no theme toggle and never sets `data-theme` — it is dark-only. Light-theme rules in
`notifications.css:29–37` are therefore dead weight on the public page.

### Hardcoded colours — top of the frequency audit

| Value | Count | Maps to |
|---|---:|---|
| `#d4af37` | 88 | `--atl-amber` (dark) / `--y-base` |
| `#fff` / `#ffffff` | 81 | `--atl-ink` / `--atl-card` (light) |
| `#111` | 31 | `--atl-sidebar-bg` / `--bg-section` |
| `#888` | 25 | ≈ `--atl-muted` — **no exact token** |
| `#222` / `#222222` | 32 | **no token** — legacy `style.css` grey |
| `#2a2a2a` | 21 | between `--atl-surface2` and `surface3` — **no token** |
| `#ccc` | 21 | **no token** |
| `#ef5350` | 17 | ≈ `--atl-clay` (`#f87171`) — **near-duplicate, not equal** |
| `#333` / `#444` / `#555` / `#666` / `#aaa` | 81 | legacy greyscale ladder, **no tokens** |

`#8212` (10 hits) is a false positive — the `&#8212;` em-dash entity.

`--brand-gold` is set at runtime by `applyBranding.js:48` but **no public stylesheet consumes it**; only
`error.html:32/58` does. The admin accent-colour branding feature is effectively inert on the public site.

### Fonts, z-index, breakpoints

- **Fonts:** `'Outfit'` 119 (43 `!important`), `'JetBrains Mono'` 49, `'Cormorant Garamond'` 31,
  `var(--f-body)` 55, `var(--f-display)` 22, `var(--theme-font)` 8. Three ways to say the same thing.
- **z-index:** 31 distinct values, `0 → 100000`: `1 2 3 4 5 6 10 15 100 200 299 300 900 990 999 1000 1001
  1030 1040 1050 1060 1070 2000 5000 9000 9999 10000 20000 99999 100000`. The 1030–1070 band is
  Bootstrap 3's. No scale exists; §7 requires one built from observed stacking.
- **Breakpoints:** ~30 distinct values — `360, 479, 480, 520, 575, 576, 599, 600, 639, 640, 767, 768,
  769, 800, 900, 992, 1024, 1280, 1330, 1700`, written both spaced and unspaced
  (`(min-width: 768px)` ×5 vs `(min-width:768px)` ×7). Near-duplicate pairs (479/480, 575/576, 599/600,
  639/640, 767/768/769) are the main source of responsive drift.

---

## 5. Selector & conflict audit (§3.3)

Tokenised all 15 project stylesheets **plus all 20 inline `<style>` blocks** (34 sources):

```
distinct selectors                     2,924
declared in more than one place          407
  exact duplicates (identical body)        3   (1 cross-file)
  conflicts (different body)             404   (200 cross-file)
```

### Element-level conflicts (leak between pages)

| Selector | Declared in | Winner |
|---|---|---|
| `html` | `style.css:7`, `redesign.css:158,164`, `admin.html:2312,3545` | last inline block |
| `body` | `style.css:10`, `redesign.css:167,3740`, `admin.html:2312,3545` | last inline block |
| `h1`–`h4` | `style.css:39`, `redesign.css:178,186–189,3778`, `admin.html:2326` | last inline block |

`style.css:10` sets `font-family: var(--theme-font) !important`; `redesign.css:167` sets
`font-family: var(--f-body) !important`. Two `!important` element rules fighting over `body`, resolved
purely by file order. `redesign.css:3740` (`body{background:#fff!important;color:#000!important}`) is
inside the **print** block — print styles exist and are in scope for §15's regression row.

### `!important` census — 1,824 total

| File | Count | Beating |
|---|---:|---|
| `admin.html` (inline) | 812 | Bootstrap 3, flatpickr, Quill, FullCalendar, intl-tel-input, and JS inline styles |
| `css/redesign.css` | 694 | Bootstrap 3 + `style.css` (it loads after both, so most are unnecessary) |
| `css/style.css` | 106 | Bootstrap 3 |
| `css/admin/calendar.css` | 71 | FullCalendar |
| `css/admin/dashboard.css` | 50 | layout conflicts with `dashboard-widget.css` (see F5) |
| `css/notifications.css` | 14 | inline styles from `notificationService.js` — **must stay** |
| others | 77 | — |

The `redesign.css` cluster is the biggest opportunity: it loads *after* `style.css` and after Bootstrap,
so a large share of its 694 is redundant even today. Each removal still needs per-rule verification.

### Vendor override surface (never edit vendor — §2.4)

| Plugin | Override mentions | Where |
|---|---:|---|
| Quill (`ql-*`) | 74 | `admin.html` 72, `css/admin` 2 |
| flatpickr | 70 | `admin.html` only |
| FullCalendar (`fc-*`) | 59 | `admin.html` 29, `css/admin/calendar.css` 30 |
| intl-tel-input (`iti*`) | 13 | `style.css` 4, `redesign.css` 5, `admin.html` 4 — **spans both pages** |
| jsvectormap (`jvm-*`) | 3 | `css/admin` |
| ApexCharts | 1 | `admin.html` |
| Bootstrap 3 | 740 | everywhere |

ApexCharts and jsvectormap are styled almost entirely via JS options, not CSS — expect chart theming to
live in `js/admin/dashboard.js`, outside this refactor.

### Overly broad selectors

`.nav` (`redesign.css:4078`) and `.collapsed` (`:3985`) sit in the admin region of a file the public page
loads, and both are Bootstrap 3 names. `.admin-card`, `.card`, `.btn`, `table td` and `input` rules in
`style.css` are scoped by `.admin-body`/`.admin-card` in most but not all cases — each needs checking in
Phase 6/7 rather than a blanket rule.

---

## 6. Dead-code audit (§3.4)

Method: every candidate was searched across `index.html`, `admin.html`, all 45 files in `js/**`, and
checked for **dynamic prefix construction** (`'atl-badge--' + status`). A candidate is only "unused" when
all searches are empty **and** no prefix of it is built at runtime.

Of 153 `redesign.css` classes matching no markup, 92 are referenced in `js/`. Of the remaining 61, a
sample of 26 verified as follows:

| Verdict | Classes |
|---|---|
| **USED** (found in markup/JS) | `.is-visible` `.is-scrolled` `.is-open` `.bk-success__hint` |
| **UNVERIFIED** (prefix built dynamically — treat as frozen) | `.career-panel` `.tm-navbar__track` `.tm-newsletter__inner` `.bk-trp` `.bk-dur-auto` `.admin-card` `.btn-admin-secondary` `.tm-admin-logo` `.adm-dropdown__header` `.adm-badge` `.adm-noti-list` `.atl-theme-toggle` `.um-drawer` |
| **UNUSED** (provable, → `/TBC` in Phase 8, never deleted) | `.tm-form-group--error` `.tm-btn--primary` `.tm-btn--outline` `.tm-btn--lg` `.tm-btn--sm` `.panel-group` `.dashboard-icon-wrap` `.adm-create-btn` `.um-loading-state` |

The `.tm-btn--*` family is interesting: the modifiers are unused but `.tm-btn` itself is live — a
half-built component. Do not consolidate it without a decision.

**Frozen class list (confirmed JS-bound — §2.3):**

- `atl-tab-bar`, `um-panel`, `um-panel-toprow` — `js/admin/user-management.js:47–57` (`initTabs()`
  sweeps **all** descendant `.um-panel`, not just direct children; `admin.html:1660` documents this)
- `admin-section`, `admin-sidebar`, `atl-drawer--open`, `tm-admin-main`, `tm-nav-link`, `active`
  — `window.switchTab`, `admin.html:15305–15380`
- `tm-toast`, `tm-toast--*`, `tm-modal*`, `tm-http-error*`, `tm-live-region`, `tm-sr-only`
  — `js/notificationService.js` (`tm-toast--${type}` is built at runtime)
- `atl-badge--{pending|completed|confirmed|accepted|cancelled|paid}` — `admin.html:3108–3113`
- `ql-*` — Quill **and** stored DB content (§2 above)

---

## 7. Real section names (§5)

**Public `index.html`** — `#hero` `#about` `#career` (rendered as *Milestones*) `#footprint` `#gallery`
`#events` `#social` `#newsletter` `#testimonials` `#contact`. No `#whatido`, no `#services` section
element (`.tm-services` / `.tm-features` are class-based and referenced only in the section-hiding MAP at
`index.html:123`).

**Admin `switchTab` targets — 22 `.admin-section` panels:**
`dashboardAdmin` `bookingsAdmin` `inquiriesAdmin` `financeAdmin` `eventsAdmin` `calendarAdmin`
`newsletterAdmin` `emailLogsAdmin` `usersAdmin` `securityAdmin` `brandingAdmin` `preferencesAdmin`
`policiesAdmin` `servicesAdmin` `galleryAdmin` `socialAdmin` `testimonialsAdmin` `footprintAdmin`
`careerAdmin` `contactAdmin` `aboutAdmin` `homeAdmin`.

The brief's admin list ("Content", "Users/RBAC", "Security & Audit", "Email") maps onto
`aboutAdmin`/`homeAdmin`/`galleryAdmin`/`socialAdmin`/`testimonialsAdmin`/`careerAdmin`/`footprintAdmin`/
`contactAdmin`/`servicesAdmin` (content), `usersAdmin`, `securityAdmin`, `emailLogsAdmin`+`newsletterAdmin`.
Proposed `css/admin/` filenames should use the real panel names — draft map in §9.

---

## 8. Decision gates — recommendations

> **All gates were signed off on 2026-09-23. The binding decisions are in §11** — where they differ in
> emphasis from the recommendations below, §11 governs. This section is kept for the reasoning.

| # | Question | Finding | Recommendation |
|---|---|---|---|
| **G1** | Shared tokens on both pages? | **Not a cascade risk — a guaranteed visual change.** Public toasts/modals currently render with transparent backgrounds (F1, measured). Defining `--atl-*` publicly switches on ~39 inert declarations at once. | **Your call — this is the one real fork.** My recommendation: **stage it.** Phase 3 ships `tokens.css` to **admin only** (zero public change, provable parity). Then treat the public token adoption as a separate, explicitly-approved change with before/after screenshots of the notification system. Do **not** bundle a bug-fix into a "no visual change" refactor. |
| **G2** | Preloader variables | **No preloader exists** (F4). | **Drop the gate.** No `public/preloader.css`. Remove the preloader row from the §15 matrix. |
| **G3** | `redesign.css` vs `style.css` canonical? | `redesign.css` loads second on both pages and carries 694 `!important`. It wins nearly everywhere; `style.css` is largely superseded legacy (e.g. the whole `.career-panel` accordion is orphaned markup). | **`redesign.css` is canonical.** Split it public/admin (F2) first, then retire superseded `style.css` blocks to `_quarantine/` with proof, one domain at a time. |
| **G4** | File count vs HTTP requests | No build step; admin already has 25 `<link>` tags, 13 of them mid-`<body>`. HTTP/1.1 on localhost, `max-age=86400` in production. | **Moderate granularity**, per §5, with one change: **consolidate the 10 `css/admin/*.css` files** (5 are under 60 lines; `security-audit.css` is 5 lines) into the proposed section files. And **move every `<link>` into `<head>`** — mid-body links are the biggest parity risk in Phase 7. |
| **G5** | Renames | Not needed for the structural win. `.db-*-grid` (F5) is the only forced disambiguation. | **No renames.** Resolve F5 by deleting the losing duplicate, not by renaming. Revisit after Phase 8. |
| **G6** | Theme mechanism | `data-theme` on `<html>`, set pre-paint from `localStorage`, default dark via `:not([data-theme="light"])`. No `prefers-color-scheme`. | **Keep exactly.** Move the two token blocks verbatim into `core/themes.css`. |
| **G7** | Parity impossible | **Triggered by G1** (F1) and **F5** (duplicate grids resolved by load-order accident). | Both are flagged here rather than resolved. Awaiting your decision. |

---

## 9. Proposed adjustments to the target architecture

Based on what the audit actually found — deltas from §5 of the brief only:

- **Drop** `css/public/preloader.css` (F4).
- **Add** `css/public/tracking-modal.css` — `tracking.css`, public-only, 443 lines (§3).
- **Add** `css/public/booking.css` — the `bk-*` family is large and spans `redesign.css` + the
  `index.html` inline block.
- **`css/admin/` by real panel name:** `dashboard.css` (absorbing `dashboard-widget.css`),
  `bookings.css`, `inquiries.css`, `finance.css`, `calendar-events.css`, `content.css`
  (about/home/gallery/social/testimonials/career/footprint/contact/services), `users-security.css`
  (users + security-audit + legal-compliance), `email.css` (email-logs ×2 + newsletter),
  `settings.css` (branding + preferences + policies), `layout.css`, `responsive.css`.
- **`overrides/plugins.css` splits on day one** — Quill 74 + flatpickr 70 + FullCalendar 59 is already
  too much for one file. Suggest `overrides/quill.css`, `overrides/flatpickr.css`,
  `overrides/fullcalendar.css`, `overrides/misc.css` (intl-tel-input, jsvectormap, ApexCharts).
- **`core/tokens.css` must include** the four tokens `js/` already references with fallbacks —
  `--atl-bg`, `--atl-border`, `--atl-mono`, `--atl-font-display` — or those fallbacks stay load-bearing
  forever (F3). Adding them is a §7-sanctioned addition; each goes in the log.
- **`error.html`** keeps its own embedded copy for now (it must render when the server is failing and
  static assets may be unavailable). Document as deliberate, and reconcile the `--atl-glow` /
  `--atl-selection` drift.

---

## 10. Phase 1 readiness

- **Server:** running on `:3000`, both pages return 200.
- **Browser automation:** `puppeteer@24.42` is a project dependency, but its **bundled Chrome is broken**
  (`win64-147.0.7727.57` fails with a side-by-side configuration error — missing VC++ runtime).
  Baselines must use **system Chrome** at `C:\Program Files\Google\Chrome\Application\chrome.exe` via
  `executablePath`, with an explicit `--user-data-dir`. This is the pattern already working in
  `scratch_screenshot_inq.js`. Confirmed working for this audit's measurements.
- **Admin screenshots** need a login; `scratch_screenshot_inq.js` shows the local dev credentials and the
  `POST /api/admin/login` flow to reuse.
- **Pre-existing baseline noise to record, not fix:** `index.html` 404s on
  `images/480681105_1563104084637146_1105632398058673475_n.jpg`. Zero JS console errors on the public page.
- **Baseline storage:** the brief says `docs/css-baseline/` — same problem as the audit path. Suggest
  `docs-internal/css-baseline/` (tracked) or an untracked scratch dir if the PNG volume is a concern.

---

## 11. Decisions — signed off 2026-09-23

All gates resolved. These are now binding constraints on Phases 2–8.

| Ref | Decision |
|---|---|
| **G1** | **Stage the token move admin-first.** Phase 3 ships `css/core/tokens.css` to `admin.html` only. The public site keeps its current (broken) inert `var(--atl-*)` references, so public parity stays provable. Public token adoption is a **separate, later, explicitly-approved change** with before/after captures of the notification system. The F1 defect is documented, not fixed, in this refactor. |
| **G2** | **Dropped** — no preloader exists. No `css/public/preloader.css`. Preloader row removed from the §15 matrix. |
| **G3** | **`redesign.css` is canonical.** Split public/admin first, then retire superseded `style.css` blocks to `_quarantine/` with per-rule proof, one domain at a time. |
| **G4** | **All four approved:** consolidate the 10 `css/admin/*.css` files onto real `switchTab` panel names · move every `<link>` into `<head>` · split `overrides/` per plugin from day one · de-duplicate the repeated `<link>` tags. |
| **G5** | **No renames.** F5 resolved by removing the losing duplicate, not by renaming. |
| **G6** | **Keep the `data-theme` mechanism exactly.** Both token blocks move verbatim into `core/themes.css`. |
| **F5** | **Keep current rendering** — `dashboard-widget.css` wins (1-column base → 2/3/5–6 at breakpoints). Retire the `dashboard.css` duplicates of `.db-summary-grid` / `.db-social-grid`. Zero visual change. |
| **Paths** | Audit, refactor log and baselines → **`docs-internal/`** (tracked). Retired CSS → **`_quarantine/`** (tracked, matching the previous refactor's precedent). **`/TBC` is not used** for this refactor, because it is gitignored and would drop files out of version control. |

### Consequences to carry forward

- Because of G1, **`css/core/tokens.css` and `css/core/themes.css` are linked by `admin.html` only** until
  the separate public-adoption change. `index.html` keeps loading `style.css` / `redesign.css` /
  `notifications.css` with their inert token references intact — removing or fixing them is out of scope.
- The four undefined tokens `js/` relies on (`--atl-bg`, `--atl-border`, `--atl-mono`,
  `--atl-font-display`) are added to `tokens.css` in Phase 3 **with the exact values their current
  fallbacks use**, so behaviour is unchanged. Logged as §7 additions.
- De-duplicating the `<link>` tags and moving them into `<head>` (G4) both alter effective load order.
  Each is verified rule-by-rule against the Phase 1 baseline, not reasoned about.
