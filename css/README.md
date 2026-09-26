# CSS Architecture

How the stylesheets in this project are organised, and the rules for changing them.

Background: [`docs-internal/css-audit.md`](../docs-internal/css-audit.md) (what was here before and
why) and [`docs-internal/css-refactor-log.md`](../docs-internal/css-refactor-log.md) (what moved, and
the parity proof for each phase).

---

## Folder structure

```
css/
├── vendor/       bootstrap.min.css — never edited
├── core/         tokens.css, themes.css — the --atl-* design system
├── overrides/    project overrides of vendor widgets
├── components/   genuinely shared between public and admin
├── public/       index.html and the public sub-pages
└── admin/        admin.html only
```

| Layer | Contains | Loaded by |
|---|---|---|
| `vendor/` | `bootstrap.min.css` (**v3.3.6** + normalize 3.0.3) | all pages |
| `core/` | `tokens.css`, `themes.css` | **admin only** — see *Tokens* below |
| `overrides/` | `quill.css`, `flatpickr.css`, `fullcalendar.css`, `plugins-light.css` | admin |
| `components/` | `notifications.css` | `index`, `admin`, `confirm-subscription`, `unsubscribe` |
| `public/` | `redesign.css`, `tracking-modal.css`, `booking-form.css` | public pages (+ admin loads `redesign.css`) |
| `admin/` | `redesign-admin.css`, `01–20-*.css`, and the older section files | `admin.html` |

`css/style.css` is legacy and still loads on both pages. `redesign.css` supersedes most of it — see
*Legacy* below.

---

## Tokens

**`--atl-*` is the design system.** 85 tokens, defined once in `core/tokens.css` (dark/default) and
`core/themes.css` (light overrides).

- **Never hardcode a colour, radius, shadow, spacing or transition where a token exists.**
- **Token names are frozen.** `js/` contains 744 `var(--atl-*)` references and `admin.html` has 609
  inline `style=""` attributes using `--atl-ink` / `--atl-amber`. Renaming one breaks both silently.
- To add a token: prove the value repeats, name it in the existing `--atl-*` pattern, define it in
  **both** `tokens.css` and `themes.css`, and log it in the refactor log.

### `core/themes.css` must load immediately after `core/tokens.css`

`[data-theme="light"]` has specificity (0,1,0), which **ties** with `:root` in `tokens.css`. Source
order is the only thing breaking the tie. Load them the other way round and light theme silently stops
working — no error, no obvious symptom until someone toggles it.

### The public site does not load the tokens

This is deliberate, not an oversight. `style.css`, `public/redesign.css` and
`components/notifications.css` contain ~76 `var(--atl-*)` references that resolve to **nothing** on
`index.html`, because nothing defines `--atl-*` there. Those declarations fall back to `inherit` /
`initial`.

The visible consequence: **public toasts render with a transparent background**
(`--noti-bg: var(--atl-card)` → undefined). This is finding **F1** — a real, pre-existing defect.
Loading `core/tokens.css` on `index.html` would fix it *and* switch on ~76 dormant declarations at
once, which is a visual change. That was deferred as a separate, explicitly-approved change
(gate G1). **Do not add `core/tokens.css` to `index.html` without that sign-off.**

### Other token systems

There are three, and only `--atl-*` is canonical going forward:

| System | Defined in | Used by |
|---|---|---|
| `--atl-*` | `core/tokens.css`, `core/themes.css` | admin |
| `--bg-* --y-* --text-* --f-* --fs-* --r* --sh-*` | `public/redesign.css` `:root` | public site, `tracking-modal.css` |
| `--noti-*` | `components/notifications.css` | notification system; bridges to `--atl-*` |
| `--bk-*` | `admin/redesign-admin.css` | booking status pills (admin only) |
| `--tm-*` | `admin/02-login.css` | login screen; pure aliases onto `--atl-*` |

`error.html` carries its own embedded copy of a partial `--atl-*` set. That is deliberate — it must
render when the server is failing and static assets may be unavailable. It has drifted (`--atl-glow`,
`--atl-selection` exist there but not in `tokens.css`); reconciling it is an open item.

---

## Naming

- Shared / design-system components: **`atl-`** (`atl-card`, `atl-drawer`, `atl-tab-bar`, `atl-badge`).
  Despite the generic prefix these are **admin-only** — no `atl-*` class appears in `index.html`.
- Admin domains: `admin-`, `adm-`, `um-` (user management), `bk-` / `bkr-` (bookings), `inq-`
  (inquiries), `fin-` (finance), `cal-` (calendar), `db-` (dashboard).
- Public: `tm-` (`tm-navbar`, `tm-section`, `tm-footer`), `trk-` (tracking modal), `bk-` (booking wizard).
- Vendor namespaces — **never rename**: `ql-` (Quill), `fc-` (FullCalendar), `flatpickr-`, `iti__`
  (intl-tel-input), `jvm-` (jsVectorMap), `apexcharts-`, and Bootstrap 3's own classes.

### Frozen classes

These are read or written by JavaScript. Changing one means updating every reference in the same
commit, or it breaks silently:

| Class | Owner |
|---|---|
| `atl-tab-bar`, `atl-tab-btn`, `um-panel`, `um-panel-toprow` | `js/admin/user-management.js:47` — `initTabs()` sweeps **all** descendant `.um-panel`, not just direct children |
| `admin-section`, `admin-sidebar`, `atl-drawer--open`, `tm-admin-main`, `tm-nav-link`, `active` | `window.switchTab` in `admin.html` |
| `tm-toast`, `tm-toast--*`, `tm-modal*`, `tm-http-error*`, `tm-live-region`, `tm-sr-only` | `js/notificationService.js` — `tm-toast--${type}` is built at runtime |
| `atl-badge--{pending,completed,confirmed,accepted,cancelled,paid}` | built by string concatenation |
| `fc-cal--hide-*` | `js/admin/calendar.js` event-type filtering |
| `ql-*` | Quill **and stored database content** — `newsletter_campaigns.content` and `scheduled_newsletters.content` contain `ql-size-huge`. Renaming breaks saved newsletters. |

Because several of these are built by concatenation (`'atl-badge--' + status`), a plain grep for the
full class name will not find them. Always search for the **prefix** before assuming a class is dead.

---

## Theme

`admin.html:7` reads `localStorage['atl-theme']` (default `'dark'`) and sets `data-theme` on `<html>`
in a blocking inline script **before first paint**, so there is no flash. The toggle writes the same
key.

- Dark is the default, written as `:root:not([data-theme="light"])` so a document with no attribute
  still renders dark.
- There is **no `prefers-color-scheme` rule anywhere** in the project.
- **The public site is dark-only** — `index.html` never sets `data-theme`, so the
  `[data-theme="light"]` rules in `components/notifications.css` are inert there.

Theme rules belong in `core/themes.css` as token reassignments. Where a component genuinely cannot
express a theme difference as a token, keep the `[data-theme="light"]` block at the bottom of that
component's own file.

---

## Load order

Both pages layer the same way: **vendor → core → project → overrides → page**. Overrides must come
after the vendor sheet they override.

### `index.html`

```
css/vendor/bootstrap.min.css
  (CDN) font-awesome, intl-tel-input
css/style.css
css/public/redesign.css?v=2
css/public/tracking-modal.css
css/components/notifications.css
css/public/booking-form.css        ← must stay LAST
```

### `admin.html`

```
(CDN) font-awesome
css/vendor/bootstrap.min.css
css/core/tokens.css
css/core/themes.css                ← must stay directly after tokens.css
css/style.css
css/public/redesign.css
css/admin/redesign-admin.css       ← must stay directly after public/redesign.css
  (CDN) intl-tel-input, flatpickr, quill, jsvectormap
css/components/notifications.css
css/overrides/*.css   interleaved with
css/admin/01…20-*.css              in document order
```

### Order constraints that are load-bearing

Four places where **source order alone** decides the winner. Reordering any of them changes rendering
with no error:

1. `core/themes.css` after `core/tokens.css` — specificity tie (see *Tokens*).
2. `admin/redesign-admin.css` immediately after `public/redesign.css` — together they reproduce the
   original single `redesign.css` byte for byte.
3. `public/booking-form.css` **last** on `index.html` — it was an inline block after every `<link>`,
   so it won ties.
4. `overrides/*.css` after their vendor sheets — hoisting `overrides/quill.css` above
   `quill.snow.css` reverts the dark editor theme.

The numeric prefixes on `admin/01–20-*.css` **encode the original document order**. They are not
cosmetic. Do not renumber, merge or reorder them without re-running the parity harness.

Cache-busting: only `index.html` uses it (`redesign.css?v=2`). The pattern is inconsistent across the
project; bump or add `?v=` when shipping a change users must not get stale.

---

## Where new styles go

| Situation | File |
|---|---|
| New public-site section or component | `public/redesign.css`, or a new `public/*.css` linked before `booking-form.css` |
| New admin component | the relevant `admin/NN-*.css`, or a new `admin/*.css` linked at the end |
| Used identically by **both** pages | `components/` — but check first; almost nothing qualifies |
| Restyling a vendor widget | `overrides/<plugin>.css`, **after** the vendor sheet. Never edit vendor files. |
| New design value | a token in `core/tokens.css` + `core/themes.css` |

**`components/` is deliberately near-empty.** Of the 95 class names appearing in both pages' markup,
~60 are Font Awesome and ~21 are Bootstrap 3 primitives. The public site and admin portal evolved
separately and share no bespoke components. Resist the urge to "share" a component that merely looks
similar — put it in the page layer.

---

## Breakpoints

Custom properties cannot be used inside `@media`, so these are documented, not tokenised.

```
375   480   576   768   992   1024   1280
```

The codebase currently uses ~30 distinct widths including near-duplicate pairs (479/480, 575/576,
599/600, 639/640, 767/768/769), written both spaced and unspaced. **Use the list above for new work.**
Consolidating the existing ones is outstanding.

Media queries go at the bottom of the file whose rules they modify — not in a separate breakpoint file.

---

## `!important`

There are ~1,800 in the project. Most are load-bearing, and the reasons differ:

- beating Bootstrap 3, which is specific and loads first;
- beating inline styles written by JavaScript at runtime (`notificationService`, flatpickr, Quill) —
  **these can never be removed**, only a more specific selector or a different mechanism will do;
- beating `public/redesign.css`'s blanket `h1–h6 { … !important }`, which bleeds into admin headings.

Before removing one, find out what it is beating. Several are documented in comments at the usage
site — keep those comments accurate if you move the rule.

---

## Legacy and open items

- **`css/style.css`** — the pre-redesign stylesheet, still loaded by both pages. `redesign.css`
  supersedes most of it, and much is orphaned (e.g. the entire `.career-panel` accordion, whose markup
  no longer exists — `#career` is now `.tm-milestones`). Retiring it needs per-rule proof.
- **Admin rules in `public/redesign.css`** — a handful sit above the split point at line 3922. They are
  inert on public pages (their selectors match no public markup) but should move to the admin layer.
- **Duplicate component definitions** — `.db-summary-grid` / `.db-social-grid` are defined differently
  in `admin/dashboard.css` and `admin/dashboard-widget.css`. The latter wins by load order.
- **`error.html` token drift** — see *Tokens*.
- **Public token adoption (F1)** — the deferred G1 change.
- **`--atl-bg`, `--atl-border`, `--atl-mono`, `--atl-font-display`** — referenced by `js/` but defined
  nowhere, surviving on inline fallbacks. Defining them is only safe once the correct light-theme
  value is decided.
- **There is no preloader.** The original brief assumed one with four legacy variables; a repo-wide
  search finds zero occurrences.

---

## Verifying a change

Never trust reasoning about the cascade in this codebase — measure it.

```bash
node scripts/css-parity.js capture before      # restart the dev server first
#   …make your change…
node scripts/css-parity.js capture after
node scripts/css-parity.js compare before after
```

Captures 135 views (public at 375/768/1440, all 22 admin sections in both themes at all three widths)
and reports **computed-style** differences. It deliberately ignores pixel differences, because this app
drifts between runs — `tracker.js` records a pageview on every load, so dashboard analytics and
timestamps move. `STYLE CHANGED: 0` is the pass condition.

**Restart the dev server before each capture.** The rate limiters
(`middleware/rate-limiters.js`, 15-minute windows) are in-memory, and repeated captures exhaust them —
the page then renders an error toast, which shows up as a false positive.
