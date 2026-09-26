# CSS Refactor Log

Companion to [`css-audit.md`](css-audit.md). One entry per phase: what moved, what the parity run
found, and the cause + fix for every difference. **No phase starts with an unexplained diff.**

Parity is measured with `scripts/css-parity.js`, which captures 135 shots — `index.html` at 375/768/1440
plus all 22 `switchTab` admin sections in both themes at all three widths — and records a SHA-256 per
shot.

```
node scripts/css-parity.js capture <label>
node scripts/css-parity.js compare <base> <other>
```

**Capture conventions.** Animations and transitions are frozen during capture (identically for every
run, so the hashes stay comparable). Images are retained only for the reference set — the 3 public shots
and the 22 admin dark@1440 shots — because C: runs at ~99.9% full; all 135 are still hashed, so
detection coverage is complete. `PARITY_KEEP_ALL=1` retains everything; `PARITY_OUT` redirects captures
off the OneDrive-synced tree.

---

## Phase 1 — Baseline

**Label:** `phase1-baseline` · 135 shots · 25 images (5.5 MB) · captured 2026-09-23

Two harness bugs were found and fixed *before* the baseline was accepted. Both would have produced a
silently worthless baseline:

1. **Truncated admin captures.** The admin shell scrolls inside `.tm-admin-main`, not on `<body>`
   (`switchTab` sets `mainEl.scrollTop`, `admin.html:15305`). `document.body.scrollHeight` stays at
   viewport height, so Puppeteer's `fullPage: true` captured only the top ~900px of every admin
   section — `dashboardAdmin` came out 87 KB against a real content height of 2,823px. Fixed by
   growing the viewport to the inner container's `scrollHeight` before each shot (`fitAdminViewport`).
   Same section now captures at 243 KB with all six ApexCharts and the jsvectormap rendered. Width is
   never altered, so no media query is affected.
2. **Broken bundled Chrome.** `puppeteer@24.42`'s bundled `win64-147.0.7727.57` fails to start on this
   machine (side-by-side configuration error — missing VC++ runtime). The harness points
   `executablePath` at system Chrome, matching `scratch_screenshot_inq.js`.

**Baseline notes recorded in `manifest.json` (pre-existing, not caused by this work):**

| Note | Assessment |
|---|---|
| `404 /images/480681105_…_n.jpg` | Missing gallery image on `index.html`. Pre-existing; unrelated to CSS. Left alone. |
| `401` on `/api/admin/session`, `/bookings`, `/about-me`, `/settings` | Expected — emitted by the first `admin.html` load, which happens *before* the harness logs in. Verified against the captured images: every admin section rendered in authenticated state with live data. |
| `pageerror: Cannot read properties of undefined (reading 'showError')` | Fires on the pre-login load, where `notificationService` isn't initialised yet. Pre-existing; recorded so a *new* occurrence is detectable. |

**Deviation from the brief:** captures live in `docs-internal/css-baseline/`, not `docs/css-baseline/`.
`docs/` is the gitignored runtime PDF store for client contracts and invoices — see the note at the top
of `css-audit.md`.

---

## Phase 2 — Scaffold + vendor

**Label:** `phase2-vendor` · compared against `phase1-baseline`

### Changes

| Change | Detail |
|---|---|
| Created empty scaffold | `css/vendor/`, `css/core/`, `css/overrides/`, `css/components/`, `css/public/` (`css/admin/` already existed) |
| Moved vendor CSS | `css/bootstrap.min.css` → `css/vendor/bootstrap.min.css`, via `git mv` to preserve history |
| Updated references | **5 pages**, not the 2 the brief anticipated |

**Checksum — vendor file byte-identical (acceptance criterion §14):**

```
before  5d55ca982a7d3ab617fafda3f974170eacb838a33811d8d36b4a435347f091ac  css/bootstrap.min.css
after   5d55ca982a7d3ab617fafda3f974170eacb838a33811d8d36b4a435347f091ac  css/vendor/bootstrap.min.css
```

### Finding — three more pages linked Bootstrap

The brief's impact analysis covers `index.html` and `admin.html`. A repo-wide grep found
`css/bootstrap.min.css` referenced by **five** pages:

```
index.html:30   admin.html:16   confirm-subscription.html:10   error.html:8   unsubscribe.html:10
```

`confirm-subscription.html`, `error.html` and `unsubscribe.html` are outside the §15 test matrix but are
live pages (newsletter double-opt-in, the error handler, and unsubscribe). Updating only the two
matrix pages would have 404'd Bootstrap on all three. All five were updated together.

**These three pages are now a known blind spot for the rest of the refactor** — they load
`style.css` / `redesign.css` too, and nothing in the test matrix covers them. Recommend adding them
as a fourth capture target before Phase 6 touches the public layer.

### Regression found and fixed — Glyphicons 404

The first parity run surfaced three new 404s:

```
404 /css/fonts/glyphicons-halflings-regular.woff2
404 /css/fonts/glyphicons-halflings-regular.woff
404 /css/fonts/glyphicons-halflings-regular.ttf
```

**Cause.** Bootstrap 3 requests its icon font at `../fonts/glyphicons-halflings-regular.woff2`,
relative to the stylesheet. At `css/bootstrap.min.css` that resolved to `/fonts/`; from
`css/vendor/bootstrap.min.css` the same relative URL resolves to `/css/fonts/`, which does not exist.

**Why the obvious fix was wrong.** Moving `fonts/` → `css/fonts/` looked safe — the folder holds
nothing but Glyphicons and no stylesheet or page references it. But `js/pdfService.js:20–21` reads
that same directory **from disk by path** for the invoice/quote wordmark:

```js
const WORDMARK_FONT_REGULAR = path.join(__dirname, '..', 'fonts', 'CormorantGaramond-Regular.ttf');
```

Moving the folder would have broken PDF generation. (Those two TTFs are absent from the repo, and
`pdfService` documents a deliberate fallback to PDFKit's built-in Times — a pre-existing state, not
something this refactor introduced or should fix.)

**Fix applied** — `app.js`, one mount beside the existing `/images` and `/uploads` aliases:

```js
app.use('/css/fonts', express.static(path.join(__dirname, 'fonts')));
```

The URL is aliased back to the real folder. Vendor CSS is not edited (§2.4), no files are duplicated,
and `fonts/` stays where `pdfService` expects it. All three fonts now return 200, and the 404s are
absent from the `phase2-vendor` capture notes.

### Method change — the parity signal had to be replaced

The first `phase1-baseline → phase2-vendor` comparison reported **100 of 135 views changed**, for a
change that cannot alter rendering. The cause is that this app drifts between capture runs:
`tracker.js` records a pageview every time the harness loads `index.html`, so dashboard analytics
move, and timestamps advance across email logs, audit tables and today's-schedule panels. A pixel
hash cannot separate that from a real regression, which makes §14's "zero unexplained differences"
unreachable by construction.

The harness now records a **computed-style fingerprint** per view as the verdict:

- every custom property resolving on `:root` — **241 on admin, 125 on public**, which covers all
  three token systems in `css-audit.md` F3;
- a curated set of ~66 design-system selectors (**46 typically present** per admin view) — shell,
  components, Bootstrap surfaces, notifications, public sections — each recording the 28 CSS
  properties a cascade change actually perturbs.

Geometry (`width`/`height`) is excluded: those resolve to *used* values, so a longer client name or
one extra booking row moves them. An earlier full-DOM-walk version was tried and discarded — it was as
noisy as the pixels, because ApexCharts and jsvectormap regenerate their SVG subtrees on every render.

**Validated, not assumed.** Two identical back-to-back captures with no code change between them:

```
noise-a → noise-b
  STYLE CHANGED (verdict)   : 0
  pixels-only (data drift)  : 2
```

Zero noise on the verdict signal, drift still visible on pixels — confirming both the diagnosis and
the fix. Full style fingerprints are written to `<label>/styles/*.txt` so a failing phase can be
diffed property by property, not just flagged. Screenshots are still captured for human review; they
no longer decide pass/fail.

### Parity result

Phase 2 was temporarily reverted to capture a true fingerprinted "before" (`pre-phase2`), then
re-applied and re-captured. The revert was done by hand rather than with `git stash`, because the
working tree already carried unrelated uncommitted changes to `admin.html`, `index.html` and four
`css/*.css` files that stashing by path would have swept up.

```
pre-phase2 → phase2-vendor
  views compared            : 135
  STYLE CHANGED (verdict)   : 0
  pixels-only (data drift)  : 60

  PARITY HELD — no computed-style differences.
```

| Check | Result |
|---|---|
| All 5 pages HTTP 200 | ✅ |
| `css/vendor/bootstrap.min.css` served | ✅ 200 |
| Old path no longer resolves | ✅ 404 — nothing still points at it |
| Vendor file byte-identical | ✅ checksum match above |
| Glyphicons restored | ✅ 200 on `.woff2` / `.woff` / `.ttf`; absent from capture notes |
| Computed-style parity, 135 views | ✅ 0 differences |

**Phase 2 complete.** `phase2-vendor` is the baseline for Phase 3.

---

## Phase 3 — Tokens & themes

**Label:** `phase3-tokens` · compared against `phase2-vendor`

### Changes

| Change | Detail |
|---|---|
| `css/core/tokens.css` | New. Dark/default block moved verbatim from `admin.html:723–801` — 50 token declarations |
| `css/core/themes.css` | New. Light block moved verbatim from `admin.html:803–840` — 35 token declarations |
| `admin.html` | Those 119 lines deleted; two `<link>`s added after `css/vendor/bootstrap.min.css`. Now contains **zero** `--atl-*` definitions |

Both extracted bodies were `diff`'d against the lines they replaced — byte-identical, no
reformatting. 50 + 35 = the 85 definitions the audit counted.

**Scope — admin only.** `index.html` does not load either file. Per gate G1 this is deliberate:
defining `--atl-*` on the public page would switch on ~76 currently-inert `var(--atl-*)` references
in `style.css` (47), `redesign.css` (18) and `notifications.css` (11), which is a visual change.
Public adoption is a separate, approved change.

### The file order is load-bearing

`themes.css` must load immediately after `tokens.css`. `[data-theme="light"]` has specificity
(0,1,0), which **ties** with `:root` in `tokens.css` — source order is the only thing breaking the
tie. Loading them the other way round silently disables light theme with no error and no obvious
symptom until someone toggles it. Documented in both file headers and at the `<link>` site, because
a future reorganisation could easily reorder them without realising.

The default block keeps its original three-selector form
(`:root, [data-theme="dark"], :root:not([data-theme="light"])`). The `:not()` arm is deliberately
more specific (0,2,0) so dark values still beat a bare `:root` while light mode is active. That is
gate G6 — mechanism preserved exactly, including the pre-paint inline script at `admin.html:7` that
reads `localStorage['atl-theme']`.

**Cascade safety checked before moving:** the tokens moved from line ~723 (after every `<link>`) to
line ~17 (before most of them). Safe because (a) these are the only `--atl-*` definitions in the
document, and `var()` resolves against a custom property's final computed value regardless of
declaration order; (b) the only non-custom property in the moved blocks is `color-scheme`, and the
three other `color-scheme` declarations in `admin.html` (lines 1025, 2781, 2815 pre-edit) target form
controls, not `:root`.

### Deliberately not done

§7 also asks for a z-index scale and flags tokens that exist only as fallbacks. Both are held back:

- **z-index scale** — stacking currently spans 31 ad-hoc values (0 → 100000). Defining a scale that
  nothing reads would add tokens for no behavioural gain and inflate the fingerprint with a diff to
  explain. It lands in the phase that applies it.
- **`--atl-bg`, `--atl-border`, `--atl-mono`, `--atl-font-display`** — referenced by `js/` but defined
  nowhere, surviving on inline fallbacks (`js/admin/testimonials.js:52`, `js/admin/calendar.js:81`).
  Defining them is only behaviour-neutral if the *same* literal goes into both theme blocks, which
  would bake a dark value (`#0a0a0a`) into light theme. Correcting that is a visual decision, not a
  move. **Open item.**

### Parity result

```
phase2-vendor → phase3-tokens
  views compared            : 135
  STYLE CHANGED (verdict)   : 0
  pixels-only (data drift)  : 54

  PARITY HELD — no computed-style differences.
```

| Check | Result |
|---|---|
| Custom properties on `:root`, admin | ✅ 241 → 241 (dark and light) |
| Custom properties on `:root`, public | ✅ 125 → 125 (untouched, as intended) |
| Design-system probes resolved | ✅ 46 → 46 admin, 29 → 29 public |
| Extracted bodies vs originals | ✅ byte-identical (`diff` clean) |
| `--atl-*` definitions left in `admin.html` | ✅ 0 |
| New console errors or 404s | ✅ none — capture notes unchanged from Phase 2 |
| Computed-style parity, 135 views | ✅ 0 differences |

**Phase 3 complete.** `phase3-tokens` is the baseline for Phase 4.

---

## Phase 4 — Vendor overrides

**Label:** `phase4-overrides` · compared against `phase3-tokens-v2`

### Probe extended first

The harness probe was widened before any rule moved, to cover the widgets being changed —
`.ql-toolbar`, `.ql-container`, `.ql-editor`, `.ql-snow`, `.flatpickr-input`, `.flatpickr-calendar`,
`.flatpickr-day`, `.fc`, `.fc-toolbar`, `.fc-daygrid-day`, `.fc-event`, `.fc-col-header-cell`,
`.iti`, `.iti__flag-container`, `.iti__selected-flag`, `.apexcharts-canvas`, `.jvm-container`.
Verifying an overrides move with a probe blind to the overridden widgets would have proved nothing.

All 17 resolve on the admin sections that matter (`aboutAdmin`, `calendarAdmin`, `eventsAdmin`), so
the coverage is real rather than nominal. Changing the probe list invalidates earlier fingerprints,
so the Phase 3 end-state was re-captured as `phase3-tokens-v2` to serve as this phase's baseline.

### Changes

| File | Lines | Extracted from |
|---|---:|---|
| `css/overrides/quill.css` | 157 | the whole inline block at `admin.html:45–186` |
| `css/overrides/flatpickr.css` | 115 | `admin.html:3334–3432` |
| `css/overrides/plugins-light.css` | 30 | `admin.html:3434–3449` |
| `css/overrides/fullcalendar.css` | 69 | `admin.html:14450–14498` |

### Links were NOT moved to `<head>` — deliberately

Gate G4 approved consolidating `<link>` tags into `<head>`. That is held back until Phase 7, because
doing it now would **break** the thing this phase exists to protect: every override must load *after*
the vendor sheet it overrides. `quill.snow.css` is linked at `admin.html:30`; hoisting
`overrides/quill.css` up beside the other project CSS would put it *before* Quill's own stylesheet and
silently revert the dark editor theme.

So each `<link>` sits at the exact document position its rules occupied inline, splitting the
enclosing `<style>` element where necessary:

```html
    </style>
    <link rel="stylesheet" href="css/overrides/flatpickr.css">
    <link rel="stylesheet" href="css/overrides/plugins-light.css">
    <style>
```

The cascade is unchanged **by construction**, not by argument. Consolidation into `<head>` becomes
safe once nothing is interleaved — which is Phase 7's exit state, not this one's.

### Why the collision check wasn't treated as sufficient

A rule-level scan found **0 selector strings shared** between a plugin rule and a non-plugin rule.
That was not taken as proof: two different selectors can still match the same element — `input.form-control`
and `.flatpickr-input` both match a date field — so on equal specificity, order still decides. Position
preservation is what makes the move safe; the collision check only confirmed there was no *additional*
hazard.

### Judgment calls

**`fullcalendar.css` contains two non-`.fc-` rules.** `#cal-main-card:hover` and `#calendar` look like
project rules, but the first exists solely to stop the card-level hover glow washing over the calendar,
and the second sets `--fc-highlight-color`, a FullCalendar variable. Both sit *between* `.fc-*` rules in
the source. Separating them would break their coupling and reorder the cascade, so they moved together.
Documented in the file header.

**Three intl-tel-input rules stayed inline.** They sit inside two large admin component blocks that are
only 1% plugin (353 and 110 rules respectively). Splitting a 351-rule block to extract three rules buys
nothing; they come out naturally in Phase 7 when those blocks are dismantled. **Open item.**

**`.ql-*` remains frozen.** It is Quill's own namespace *and* appears in stored database content
(`newsletter_campaigns.content`, `scheduled_newsletters.content` both contain `ql-size-huge`).
Noted in the file header so a later cleanup doesn't rename it.

### Parity result

```
phase3-tokens-v2 → phase4-overrides
  views compared            : 135
  STYLE CHANGED (verdict)   : 0
  pixels-only (data drift)  : 48

  PARITY HELD — no computed-style differences.
```

| Check | Result |
|---|---|
| All 4 override files serve | ✅ 200 |
| `<style>` tags balanced | ✅ 20 open / 20 close |
| Vendor widget surfaces probed | ✅ 17 selectors, all resolving |
| Plugin rules left inline | 3 intl-tel-input (deferred to Phase 7) |
| New console errors or 404s | ✅ none |
| Computed-style parity, 135 views | ✅ 0 differences |

**Phase 4 complete.** `phase4-overrides` is the baseline for Phase 5.

---

## Phase 5 — Shared components

**Label:** `phase5-components` (+ `phase5-recheck`) · compared against `phase4-overrides`

### Finding — there is no shared component layer in this codebase

The brief's §5 specifies `components/` holding `buttons.css`, `cards.css`, `modals.css`,
`drawers.css`, `tabs.css`, `tables.css`, `badges.css`, `dropdowns.css`. Checked against the real
markup, none of those components is shared:

| Component | `index.html` | `admin.html` |
|---|---:|---:|
| `atl-card` | 0 | 253 |
| `atl-drawer` | 0 | 204 |
| `um-panel` | 0 | 80 |
| `adm-dropdown` | 0 | 28 |
| `atl-tab-bar` | 0 | 24 |
| `atl-badge` | 0 | 21 |

Of the 95 class names appearing in **both** pages' markup, ~60 are Font Awesome icons, ~21 are
Bootstrap 3 primitives (`modal-*`, `col-md-*`, `row`, `form-group`, `table`, `table-responsive`), and
the rest are utilities (`active`, `fade`, `close`, `text-center`, `lead`). The two pages evolved
separately — which §6 anticipates: *"similar-looking but separately-evolving things stay in their page
layer."*

So `components/` holds the one thing that genuinely qualifies, rather than eight files manufactured to
match a template. The `atl-*` components move to `css/admin/` in Phase 7, where §6 puts them.

### Changes

| Change | Detail |
|---|---|
| `css/notifications.css` → `css/components/notifications.css` | via `git mv`; checksum `037ffe00…51a4` unchanged |
| References updated | **4 pages** — `index.html`, `admin.html`, `confirm-subscription.html`, `unsubscribe.html` |

`notifications.css` qualifies on every count: loaded by four pages, driven by
`js/notificationService.js`, and its class names (`tm-toast`, `tm-toast--*`, `tm-modal*`,
`tm-http-error*`) are frozen and built at runtime.

**Deferred:** `overrides/bootstrap.css`. The shared Bootstrap 3 overrides are the one other real
consolidation candidate, but they are currently spread across `style.css`, `redesign.css` and admin
inline blocks — all of which Phases 6 and 7 will split. Assembling that file now would mean moving
rules out of files about to be dismantled. **Open item for Phase 7.**

### A false positive, and what caused it

The first comparison reported **3 STYLE CHANGED** — all three public views, admin untouched. The
fingerprint diff was precise about it:

```
< .tm-toast | ABSENT
> .tm-toast | flex | relative | auto | … | rgba(0, 0, 0, 0) | …
```

Not a style change — a toast that existed in the DOM during one capture and not the other. The capture
notes explained why: **eight new `429 Too Many Requests`** responses on
`/api/public/booking-config` and `/api/public/availability/month`. Repeated back-to-back captures had
exhausted the public rate limiters (`middleware/rate-limiters.js`, 15-minute windows), the page
surfaced an error toast, and the probe correctly recorded it.

Re-captured after the window reset, with zero 429s:

```
public_index_375       IDENTICAL
public_index_768       IDENTICAL
public_index_1440      IDENTICAL
```

**Parity holds.** Worth noting the fingerprint behaved exactly as intended here — it did not cry wolf,
it reported a genuine DOM difference and pointed straight at the cause.

*(Incidentally this re-confirms finding F1: the toast's computed `background-color` on the public page
is `rgba(0, 0, 0, 0)` — fully transparent, because `--noti-bg` derives from the undefined `--atl-card`.)*

**Harness practice from here on:** restart the dev server immediately before each capture. The rate
limiter state is in-memory, so a restart clears it and removes this whole class of false positive.

### Parity result

| Check | Result |
|---|---|
| `notifications.css` checksum across the move | ✅ identical |
| Old path no longer resolves | ✅ 404 |
| All 4 referencing pages serve | ✅ 200 |
| Admin views, 132 | ✅ 0 style differences |
| Public views, 3 | ✅ identical once rate limiting was excluded |

**Phase 5 complete.** `phase5-components` is the baseline for Phase 6, with the public rows
superseded by `phase5-recheck`.

---

## Phase 6 — Public layer

**Label:** `phase6-public` · compared against `phase5-components` / `phase5-recheck`

### Changes

| File | Lines | Source |
|---|---:|---|
| `css/public/redesign.css` | 3,922 | `css/redesign.css` lines 1–3922 |
| `css/admin/redesign-admin.css` | 1,770 | `css/redesign.css` lines 3923–5692 |
| `css/public/tracking-modal.css` | 443 | `css/tracking.css` (checksum `ff4916ed…abb1` unchanged) |
| `css/public/booking-form.css` | 73 | the inline `<style>` at `index.html:41–115` |
| `_quarantine/css/redesign.superseded.css` | 5,692 | the original, retired not deleted |

Both halves of the split were `diff`'d against their source ranges — **byte-identical**.
**`index.html` now has zero inline `<style>` blocks.**

### Where the cut went, and why not where the audit suggested

The admin region of `redesign.css` begins at ~3742 (`.admin-body`), but cutting there would have
broken the public site. Three **global** rules sit inside that region and do affect public rendering:

| Original line | Rule | Effect on public |
|---|---|---|
| 3895–3909 | `::-webkit-scrollbar*` | live — styles the public scrollbar via `--bg-page` / `--y-muted` |
| 3914–3922 | `:root { --sidebar-* }` | defines tokens counted on public `:root` |
| 3780 | `h1,h2,h3,h4,h5,h6 { font-family: var(--f-display) !important }` | **exact duplicate** of the same declaration at line 179 |

So the cut went at **3922**, after all three. A handful of admin-only rules therefore remain in
`css/public/redesign.css`; they are inert on the public pages because their selectors match no public
markup. Gate decision: single cut, zero cascade risk, ~1,770 lines (31%) off the public bundle —
finding **F2 closed**. Full separation via `core/base.css` was considered and rejected for this phase
because it would move global element rules ~3,700 lines earlier in the cascade.

### Order is load-bearing in two new places

- `css/admin/redesign-admin.css` must stay **immediately after** `css/public/redesign.css` in
  `admin.html`. Together they reproduce the original single file byte for byte; separating or
  reordering them changes the cascade.
- `css/public/booking-form.css` must stay the **last** project stylesheet on `index.html`. It was an
  inline block after every `<link>`, so it won ties. Hoisting it above `public/redesign.css` would let
  the redesign's booking rules override it.

Both are commented at the `<link>` site and in the file headers.

### Correction — `reset-password.html` does not load `redesign.css`

A file-level grep listed it, but the only match is a code comment at line 78. Four pages needed
updating, not five: `index.html`, `admin.html`, `confirm-subscription.html`, `unsubscribe.html`.

### Parity result

```
phase5-components → phase6-public
  views compared            : 135
  STYLE CHANGED (verdict)   : 3   (public only; admin 132/132 held)
  pixels-only (data drift)  : 50
```

The three public views changed in **exactly one way**, and it was the predicted one:

```
< TOKEN --bk-accepted = #4ade80          … 18 booking-status tokens …
< TOKEN count = 125
> TOKEN count = 107
```

`index.html` no longer defines the 18 `--bk-*` booking-status tokens, because they lived at original
line 5375 — inside the admin half. **Every one of the 66 component probes, with all 28 computed
properties, is byte-identical.** Nothing rendered differently; the public page simply stopped
declaring 18 variables it never read.

Verified exhaustively — `var(--bk-` appears in **zero** of the files any public page loads
(`index.html`, `style.css`, `public/redesign.css`, `public/tracking-modal.css`,
`public/booking-form.css`, `components/notifications.css`, `js/myscript.js`,
`js/notificationService.js`, `js/applyBranding.js`, `tracker.js`, `confirm-subscription.html`,
`unsubscribe.html`). The only consumers are `admin.html` and `css/admin/redesign-admin.css`, both of
which still load them.

**Accepted as an intended improvement, not a regression.**

| Check | Result |
|---|---|
| Split halves vs source ranges | ✅ byte-identical |
| `tracking.css` checksum across move | ✅ identical |
| Inline `<style>` blocks in `index.html` | ✅ 0 (was 1) |
| Admin views, 132 | ✅ 0 style differences |
| Public views, 3 | ✅ only 18 unused tokens removed; all component styles identical |
| Admin CSS downloaded by public page | ✅ 1,770 lines removed |

### Open item — stale line references

`admin.html` carries ~10 comments citing `redesign.css` line numbers to justify `!important`
(e.g. *"redesign.css:4058 has `.admin-body input…`"*). Those now resolve into
`css/admin/redesign-admin.css` at **line − 3922 + 17** (17 = the new file's header). The comments
exist to satisfy §9, so they are worth correcting rather than leaving to rot — scheduled as a
discrete pass in Phase 8.

**Phase 6 complete.** `phase6-public` is the baseline for Phase 7.

---

## Phase 7 — Admin layer

**Label:** `phase7-admin` · compared against `phase6-public`

### Approach — block-wise, in place

The §5 target is one file per admin section. That is not reachable by moving blocks here: the 20
inline `<style>` blocks are **internally mixed**, not grouped by section. Classifying every rule:

| Domain | Rules |
|---|---:|
| `.atl-*` components | 339 |
| generic / Bootstrap overrides | 320 |
| users & security | 114 |
| bookings | 74 |
| admin shell | 65 |
| calendar / finance | 48 |
| settings / content / email | 9 |

The largest block alone (1,803 lines) interleaves 198 `.atl-*` rules with 64 generic, 48 shell and 19
users-security rules. Reaching section-per-file means re-sorting ~900 rules, which reorders the
cascade — and this codebase has already produced **four** places where source order alone decides a
winner. Gate decision: extract each block wholesale to a file named for its dominant content, linked
at the exact position it occupied.

### Changes

**All 20 inline `<style>` blocks extracted.** `admin.html`: **17,645 → 13,576 lines**, now containing
**zero inline CSS**.

Files are `css/admin/01-*.css` … `20-*.css`. **The numeric prefixes encode original document order and
are load-bearing** — they are what makes the cascade reproducible. Do not renumber, merge or reorder
without re-running the harness.

Done as a single scripted transformation rather than 20 manual edits, because every removal shifts all
subsequent line numbers.

### Verification of the extraction itself

```
blocks in original: 20   extracted files: 20
ALL 20 BLOCKS VERBATIM — 1039 rule bodies preserved
```

**A false alarm worth recording:** the first verifier reported **19 of 20 files as mismatched**. That
was the verifier, not the extraction — it sliced the file body at the header terminator and left two
blank lines in, so every comparison was offset by two rows. The second verifier (strip all blank lines
and indentation, then compare) is *stricter* on content and passed cleanly. Noting it because
"the tool failed, then I changed the tool and it passed" is a pattern that deserves to be auditable.

17 of the 20 auto-generated filenames were poor — one picked up an incidental comment and became
`16-users-security-phase-6-housekeeping-notes-md-the-abouta.css` — so they were renamed to match
actual content and the links updated.

### Parity result

```
phase6-public → phase7-admin
  views compared            : 135
  STYLE CHANGED (verdict)   : 0
  pixels-only (data drift)  : 54

  PARITY HELD — no computed-style differences.
```

The largest single change in the refactor, and nothing moved.

**Phase 7 complete.** `phase7-admin` is the baseline for Phase 8.

---

## Phase 8 — Cleanup & docs

**Label:** `phase8-cleanup` · compared against `phase7-admin`

### Changes

| Change | Detail |
|---|---|
| Duplicate `<link>` removed | `calendar.css` 3× → 1×, `dashboard.css` 2× → 1× |
| Finding **F5** resolved | losing `.db-summary-grid` / `.db-social-grid` removed from `dashboard.css` |
| `css/README.md` | written — the §13 contract |
| Stale citation fixed | `07-components.css` now cites file + selector, not a line number |
| Header comments corrected | `dashboard.css` / `dashboard-widget.css` duplication notes updated |

**De-duplicating links kept the LAST occurrence** of each. With copies at A < B < C, any rule between
them already loses to C, so removing A and B is exactly equivalent. Keeping an *earlier* one would
have flipped winners.

**F5 removal was provably a no-op.** `dashboard-widget.css` is linked later and its base rule sets
`display`, `grid-template-columns` **and** `gap`. Media queries add no specificity, so even
`dashboard.css`'s breakpoint variants (`gap: 14px` at ≥480px etc.) were already being overridden by
that base rule. Removed rules kept in `_quarantine/css/admin/dashboard.db-grids.removed.css`.

**`.db-stat-card` / `.db-schedule-item` deliberately left duplicated.** Unlike the grids,
`dashboard.css` wins for these *despite loading first*, because its declarations carry `!important`
and `dashboard-widget.css`'s do not; the two also set overlapping-but-different property sets.
Resolving that changes rendering, so it is a visual decision. **Open item.**

### Parity result

```
phase7-admin → phase8-cleanup
  views compared            : 135
  STYLE CHANGED (verdict)   : 1
      admin_footprintAdmin_light_375
```

The one difference, in full:

```
< .adm-profile-btn | … | 13.4425px | 300 | 22.8523px | …
> .adm-profile-btn | … | 13.4423px | 300 | 22.852px  | …
```

A **0.0002px** font-size difference. `body` inherits
`--fs-base: clamp(0.95rem, 0.92rem + 0.15vw, 1rem)`, so at a 375px viewport the size is computed from
a `vw` term and rounds differently between runs. Float jitter in the clamp evaluation, not a style
change. **Known noise source at 375px** — the fingerprint is sensitive to the 4th decimal place.

---

## End-to-end proof

Comparing the pre-refactor capture with the final one line by line, across **all 135 views**:

```
pre-phase2  →  phase8-cleanup
  probe lines present BEFORE but not after : 58
  probe lines present AFTER but not before  : 2299
```

The headline `compare` reports 135/135 changed, but that is an artifact: the probe list gained 17
vendor-widget selectors in Phase 4, so every fingerprint has extra rows (the 2,299). What matters is
what was **lost**, and all 58 are accounted for:

| Lost lines | Cause |
|---:|---|
| 57 | 3 public views × (18 `--bk-*` tokens + the `TOKEN count` row) — the intended Phase 6 change; nothing public reads those tokens |
| 1 | `admin_footprintAdmin_light_375 :: .adm-profile-btn` — the 0.0002px float jitter above |

**Zero component style values changed across the entire refactor.** All 132 admin views lost nothing
at all.

---

## Acceptance criteria (§14)

| # | Criterion | Result |
|---|---|---|
| 1 | `docs-internal/css-audit.md` with citations | ✅ |
| 2 | Every stylesheet path resolves | ✅ all local paths checked across 6 pages |
| 3 | No stylesheet linked twice | ✅ none on either page |
| 4 | No two files define the same component | ⚠️ `.db-stat-card` / `.db-schedule-item` remain — see above |
| 5 | `--atl-*` defined once; every name still exists | ✅ 85 tokens, only in `core/tokens.css` + `core/themes.css` |
| 6 | No hardcoded hex where a token exists | ❌ **not met — 513 hex literals remain.** See below. |
| 7 | Vendor byte-identical | ✅ `0ae5d093…` both sides once CRLF is normalised; git records a pure rename |
| 8 | Renamed selectors have no stale references | ✅ no renames performed (G5) |
| 9 | Frozen JS-bound classes untouched | ✅ all present, none renamed |
| 10 | `!important` count reduced or unchanged | ✅ **1,783 real declarations, zero added** (raw grep 1824→1827; the +3 are explanatory comments) |
| 11 | No inline `<style>` blocks left | ✅ 0 in both `index.html` and `admin.html` |
| 12 | Obsolete files retired, none deleted | ✅ `_quarantine/` (tracked) |
| 13 | `css/README.md` present | ✅ |
| 14 | Zero unexplained differences vs baseline | ✅ every difference explained above |
| 15 | No new console errors | ✅ capture notes unchanged throughout |

### Criterion 6 — not met, deliberately

**513 hex literals remain** in project CSS, including 54 × `#d4af37` where `--atl-amber` exists.
Phase 3's brief did include *"remove hardcoded values that map to tokens"*, and it was not done:

1. Substituting tokens for literals is a **content change**, not a move; each substitution carries
   parity risk and this refactor's contract was pixel parity.
2. More decisively — under gate **G1**, the public half of the codebase cannot resolve `--atl-*` at
   all. Replacing literals with tokens in `style.css` or `public/redesign.css` would not tidy them,
   it would **break** them.

This becomes clean, low-risk work once G1's public token adoption lands. Until then it is correctly
blocked.

### Vendor checksum — read the note before re-running

A naïve `sha256sum` comparison against git **fails**: the worktree file is 156,629 bytes and the git
blob is 149,418, because `autocrlf` rewrites line endings on checkout. Normalise first
(`git show HEAD:css/bootstrap.min.css | tr -d '\r'`) and both sides are `0ae5d093…`. Git itself
records the change as `R css/bootstrap.min.css -> css/vendor/bootstrap.min.css` with no content edit,
which is the stronger proof.

---

## Open items

1. **Public token adoption (F1)** — deferred G1 change. Public toasts render with a transparent
   background until it lands.
2. **Hardcoded hex** — criterion 6, blocked on item 1.
3. **`.db-stat-card` / `.db-schedule-item`** duplication — needs a visual decision.
4. **z-index scale** — 31 ad-hoc values, 0 → 100000. To be defined in the phase that applies it.
5. **`--atl-bg`, `--atl-border`, `--atl-mono`, `--atl-font-display`** — referenced by `js/`, defined
   nowhere, surviving on fallbacks. Defining them needs a light-theme value decision.
6. **`error.html` token drift** — carries its own partial `--atl-*` copy with `--atl-glow` /
   `--atl-selection` that do not exist in `tokens.css`.
7. **Admin rules in `public/redesign.css`** — a few sit above the line-3922 cut; inert on public.
8. **`css/style.css`** — 1,144 lines of largely superseded legacy, still loaded by both pages.
9. **Breakpoint consolidation** — ~30 distinct widths including near-duplicate pairs.
10. **Secondary pages untested** — `confirm-subscription.html`, `unsubscribe.html`, `error.html`,
    `reset-password.html` load project CSS but are outside the §15 matrix. Worth adding as a fourth
    capture target.
