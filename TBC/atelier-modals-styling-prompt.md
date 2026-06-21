# Atelier Admin — Modal Styling Prompt (Bring all 18 modals into "Atelier Obsidian & Gold" alignment)

> **What this prompt is for.** Every dialog in `admin.html` must read as one coherent
> "Atelier Obsidian & Gold" modal — identical in panel shape, header/body/footer treatment,
> typography, field styling, close affordance, focus behaviour, and theme-awareness — matching
> the reference dashboard (`artist-booking-dashboard.html` / its obsidian twin
> `artist-booking-dashboard-obsidian.html`).
>
> The good news: most of the machinery already exists in `admin.html`
> (the `--atl-*` token system, the `.atl-modal-*` panel classes, the `.atl-btn` button
> system, a "UNIVERSAL MODAL SYSTEM" CSS block, and a runtime transformer that ports
> Bootstrap modals into Atelier panels). The job is **not** to invent a modal design — it is
> to **finish applying the existing one consistently to all 18 modals**, kill the hardcoded
> hex that breaks the light theme and WCAG contrast, and unify the chrome (close icon,
> accents, buttons) across both rendering paths.
>
> **This is a styling/markup task only.** No backend, no business logic, no data wiring,
> no API calls, no IDs/names/data-attributes are to change. See §7.

---

## 0. Current state (read before changing anything)

### 0.1 The 18 modals and how each is rendered

There are **18** Bootstrap modals (`<div class="modal fade" …>`). They split into **two
rendering paths**, and this distinction governs the whole task. Confirm each by `id`
(line numbers drift — search the `id`, don't trust the line):

A **jQuery monkey-patch** (in the modal-init script) overrides `jQuery.fn.modal` for a fixed
allow-list, redirecting `.modal('show'|'hide')` to `showAtelierModal()` / `hideAtelierModal()`:

```js
const targetModalIds = [
  'quoteModal', 'recordPaymentModal', 'cancelBookingModal', 'cancelModal',
  'contractModal', 'manualBookingModal', 'promoteBookingModal',
  'bookingInfoModal', 'bookingFinancialsModal', 'bookingEmailModal'
];
```

**Group A — Atelier-transformed (10 modals).** Opening these moves the modal into
`#atlModalOverlay` (`.atl-modal-overlay`, blurred backdrop), converts `.modal-dialog` →
`.atl-modal-panel`, **inline-styles** `.modal-content / .modal-header / .modal-title /
.close / .modal-body / .modal-footer` via jQuery `.css()` using `--atl-*` tokens, **swaps the
close button for the reference SVG "✕"**, adds `.atl-input` to every field, and installs a
focus-trap + ESC/backdrop-close. Their *chrome* is therefore already on-theme; their *inner
content* is not.

| `id` | Title | Notes |
|---|---|---|
| `quoteModal` | Quote Builder | richest offender — see §3.2 |
| `recordPaymentModal` | Record Payment | `bkr-sheet-modal` |
| `cancelBookingModal` | Cancel Booking | `bkr-sheet-modal` — see duplicate note §7 |
| `cancelModal` | Cancel Booking | `bkr-sheet-modal`, centered — see duplicate note §7 |
| `contractModal` | Contract Management | `bkr-sheet-modal`, `modal-lg`; hardcoded `#0d0d0d` chrome |
| `manualBookingModal` | New Enquiry / Manual Booking | the reference's `newbk` analogue |
| `promoteBookingModal` | Promote to Public Event | centered |
| `bookingInfoModal` | Booking Info | body has `color:#ddd` |
| `bookingFinancialsModal` | Financial Controls | body has `color:#ddd` |
| `bookingEmailModal` | Email Client | body has `color:#ddd` |

**Group B — native Bootstrap (8 modals).** These are **not** in the allow-list, so they
render as plain Bootstrap modals. They get the "UNIVERSAL MODAL SYSTEM" CSS (below) for the
chrome but keep the legacy `<button class="close">&times;</button>` affordance, no overlay
blur, no focus-trap-by-us (native Bootstrap only), and fully hardcoded inner content.

| `id` | Title | Notes |
|---|---|---|
| `blockOutModal` | Block Out Date | `modal-sm` — see duplicate note §7 |
| `adminBookingModal` | Booking Request Details | **legacy shell** — body is hidden `#ab*` anchors + hidden `#adminRespondForm`; preserve (see §7) |
| `expenseModal` | Add Expense | hardcoded `#0d0d0d` chrome, `#222` fields |
| `privacyModalAdmin` | Privacy Policy | **long-form legal text** — keep native scroll (see §5) |
| `termsModalAdmin` | Terms | **long-form legal text** — keep native scroll (see §5) |
| `modalDateHold` | Block Out Date | see duplicate note §7 |
| `importSubscribersModal` | Import Subscribers | form modal |
| `newsletterPreviewModal` | Newsletter Preview | preview modal |

> There is **also** a separate, fully-tokenised custom modal system rendered into
> `#atlModalRoot` via `.atl-modal-panel` markup (not the 18 Bootstrap ones). It is already
> correct — **do not restyle it**; use it only as the canonical look to match.

### 0.2 Infrastructure you must reuse (do not duplicate or fork)

- **Tokens** — `--atl-*` custom properties, defined for **dark** (`:root:not([data-theme="light"])`)
  and **light** (`[data-theme="light"]`). These are the single source of truth. Relevant ones:
  `--atl-paper #0a0a0a` / `--atl-card #1a1a1a` / `--atl-surface2 #242424` / `--atl-input-bg #0f0f0f` /
  `--atl-topbar-bg #141414`; text `--atl-ink #fff` / `--atl-ink-dim #e0ddd6` / `--atl-muted #949494` /
  `--atl-muted-dim #666` / `--atl-placeholder #555`; lines `--atl-line` / `--atl-line-strong`;
  gold `--atl-amber #D4AF37` / `--atl-amber-hover` / `--atl-amber-border` / `--atl-on-amber`;
  status `--atl-sage #4ade80` / `--atl-clay #f87171` / `--atl-blue #60a5fa` / `--atl-green #34d399` /
  `--atl-orange #fb923c` / `--atl-purple #c084fc`; `--atl-shadow-modal`, `--atl-overlay`, `--atl-focus`,
  radii `--atl-r-sm/md/lg/xl`. (Light theme remaps these — e.g. gold becomes `#9a7611` — so
  **using the token is what gives you free light-mode + AA**.)
- **`.atl-modal-*` classes** — `.atl-modal-overlay / -panel / -header / -title / -close /
  -body / -footer / -label`, plus tokenised field styling for `.atl-modal-body input|select|textarea`
  (incl. gold focus ring). This is the reference modal ported to admin already.
- **`.atl-btn` system** — `.atl-btn` + `.atl-btn--primary` (gold) / `.atl-btn--ghost` /
  `.atl-btn--danger`. Use these for footer actions.
- **"UNIVERSAL MODAL SYSTEM" CSS block** — token-based `!important` rules for `.modal-content`,
  `.modal-header`, `.modal-header .modal-title`, `.modal-header .close`, `.modal-body`,
  `.modal-footer`, `.modal-backdrop`, plus the mobile and `[data-theme="light"] .modal-content`
  overrides. Because these use `!important`, **they already win over most per-element inline
  hex on the chrome** — meaning a lot of that inline hex is dead, but it must still be removed
  for clarity and to avoid the cases the universal block does *not* cover.
- **`showAtelierModal()` / `hideAtelierModal()`** — the runtime transformer for Group A.

### 0.3 The gap (what's actually broken)

1. **Hardcoded inner-content colour that does not flip with the theme and fails WCAG AA.**
   Audited counts inside the modal blocks:
   - Dark-only greys: `#aaa` (~30×), `#666` (~6×), `#bbb` (~4×), `#555` (~13×), `#444` (~5×),
     `#333`, `#888` — these are the muted greys flagged project-wide as **failing 4.5:1** and
     **invisible/incoherent in light mode**.
   - Field/panel backgrounds: `#222` (~12×), header/footer slabs `#0d0d0d` (~5×), `#0e0e0e`
     (~2×), `#080808`.
   - Off-palette accents: Material blue `#2196F3` / `#42A5F5` / `#1565C0` (~7×), greens
     `#5cb85c` / `#66BB6A`, red `#EF5350`, orange `#FFA726`, purple `#9C27B0`, and even
     hardcoded gold `#D4AF37` / `#e0c04a` / `#fff` that should be tokens.
2. **Two different close affordances.** Group A shows the reference SVG "✕"; Group B shows a
   Bootstrap `&times;` glyph. Inconsistent.
3. **Accent titles fight the gold system.** Several modal titles are inline-coloured blue/sage
   (`#2196F3`, `--atl-blue`, `--atl-sage`) but the universal `.modal-header .modal-title`
   rule forces `color: var(--atl-ink-dim) !important`, so the accents are currently dead —
   the intent must be made explicit and consistent (see §4.2).
4. **Footer primary button rendered blue** (`background:#2196F3`) instead of the gold
   `.atl-btn--primary`.
5. **Group B fields aren't guaranteed the tokenised field styling** (the `.atl-modal-body
   input` selector only matches the transformed panels, not native `.modal-body`).

---

## 1. Primary objective

> **Make all 18 modals visually identical to the reference Atelier modal in both dark and
> light themes — same panel, same chrome, same fields, same buttons, same close icon, same
> focus behaviour — by routing every colour through `--atl-*` tokens and reusing the existing
> `.atl-modal-*` / `.atl-btn` systems. Remove every hardcoded hex inside the modals. Change
> nothing about IDs, attributes, JS bindings, data flow, or the backend.**

---

## 2. The reference modal — the visual contract

From `artist-booking-dashboard.html` (`modalShell()` + field/button patterns). The admin's
`.atl-modal-*` classes are already a faithful port of this; match it exactly.

- **Panel.** `max-width: 680px` (`max-w-2xl`), `border-radius: 16px`, `background: var(--atl-card)`,
  `box-shadow: var(--atl-shadow-modal)`, slide-in animation. `role="dialog"`, `aria-modal="true"`,
  `aria-labelledby="…-title"`.
- **Header.** `display:flex; align-items:center; justify-content:space-between; padding:20px`,
  `border-bottom:1px solid var(--atl-line)`. Title = **Cormorant Garamond, 24px, 600**.
- **Close.** An inline **SVG ✕** (not a glyph), `data-dismiss="modal"`, `aria-label`, `padding:8px;
  border-radius:8px; background:transparent; color:var(--atl-ink)`, subtle hover bg. Exact markup
  used by the transformer:
  ```html
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>
  </svg>
  ```
- **Body.** `padding:20px; max-height:60vh; overflow-y:auto`.
- **Footer.** `display:flex; justify-content:flex-end; gap:12px; padding:20px`,
  `border-top:1px solid var(--atl-line)`.
- **Field label.** Uppercase micro-label: `font-size:11px; font-weight:700; letter-spacing:.08em;
  text-transform:uppercase; color:var(--atl-muted)` → i.e. the `.atl-modal-label` class.
- **Field (input/select/textarea).** `background:var(--atl-input-bg); color:var(--atl-ink);
  border:1px solid var(--atl-line); border-radius:8px; padding:8px 12px`, **focus** =
  `border-color:var(--atl-amber); box-shadow:0 0 0 3px var(--atl-focus)`. (= `.atl-input` /
  `.atl-modal-body input`.)
- **Recessed info panel** (read-only summary block inside a body): `background:var(--atl-paper);
  border-radius:12px; padding`. `--atl-paper` is the **darker, recessed** surface; `--atl-surface2`
  is the **lighter, elevated** surface — pick by role.
- **Buttons.** Primary = solid; ghost = outline; destructive = clay outline. Map to
  `.atl-btn--primary` / `--ghost` / `--danger`.
- **Inline error.** `font-size:12px; color:var(--atl-clay); role="alert"; hidden` → `.atl-field-error`.

> **Palette note for the agent.** The literal hexes/fonts in the *attached* reference file
> (`artist-booking-dashboard.html`) are its **warm-ivory / terracotta** variant
> (`Fraunces`/`Archivo`, `--amber:#b8612f`). **Do not import those literals** into the admin —
> the admin is the **obsidian-gold** system. Use the attached file only for **structure, spacing,
> typography scale, field/button/close patterns, and a11y**; take all **colours from the admin's
> existing `--atl-*` tokens** (which equal the obsidian reference `artist-booking-dashboard-obsidian.html`).

---

## 3. Task A — Tokenise all inner-content hardcoded colour (heavy lift, non-breaking)

Sweep the body of **every** modal and replace hardcoded colour with the correct **semantic**
token. Map by **role**, not by literal value (two `#222`s can become different tokens).

### 3.1 Mapping table

| Hardcoded value(s) | Replace with | Role |
|---|---|---|
| `#222` (field / table / summary-panel bg) | `var(--atl-input-bg)` for inputs; `var(--atl-surface2)` for elevated summary panels | inset field vs elevated panel |
| `#0d0d0d`, `#0e0e0e`, `#080808` (header/footer slab) | remove (let UNIVERSAL `.modal-header/.modal-footer` = `var(--atl-surface2)` apply) | chrome |
| `#ddd`, `#bbb` (body/primary text) | `var(--atl-ink-dim)` (or `var(--atl-ink)` for emphasis) | primary copy |
| `#aaa` (secondary labels, table headers, summary labels) | `var(--atl-muted)` | secondary copy |
| `#888`, `#666`, `#555` (faint copy) | `var(--atl-muted)` (copy) or `var(--atl-muted-dim)` (very secondary) | faint copy |
| `#444`, `#333` (hairlines/borders) | `var(--atl-line)` (or `var(--atl-line-strong)` for stronger dividers) | borders |
| `#fff` (text) | `var(--atl-ink)` | text |
| `#2196F3`, `#42A5F5`, `#1565C0` (blue accent) | `var(--atl-blue)` | info accent |
| `#5cb85c`, `#66BB6A` (green) | `var(--atl-sage)` (status) / `var(--atl-green)` | success |
| `#EF5350` (red) | `var(--atl-clay)` | danger |
| `#FFA726` (orange) | `var(--atl-orange)` | warning |
| `#9C27B0` (purple) | `var(--atl-purple)` | accent |
| `#D4AF37`, `#e0c04a` (gold) | `var(--atl-amber)` / `var(--atl-amber-hover)` | brand |
| raw `rgba(33,150,243,.05/.2)` (blue tint blocks) | `var(--atl-blue)` for border + a low-alpha derived tint; prefer an existing `--atl-*-dim` pattern over a new literal | tinted callouts |
| raw `rgba(248,113,113,…)` (clay tints) | keep as clay-derived tint or token; do not invent new named greys | tinted callouts |

**Keep** any inline style that *already* uses a token (`var(--atl-paper)`, `var(--atl-line-strong)`,
`var(--atl-ink)`, `var(--atl-amber)`, etc.) — those are fine; only the literals change.

### 3.2 Worked example — `quoteModal` (the densest case)

This modal mixes tokens and literals. Representative transforms:

```html
<!-- BEFORE -->
<label style="color:#2196F3; font-size:11px; text-transform:uppercase; …">Quick Select…</label>
<table class="table" style="background:#222; border-radius:6px; color: var(--atl-ink);">
  <tr style="border-bottom:1px solid #444;">
    <th style="border:none; color:#aaa; font-size:12px;">Description</th>
<textarea id="quoteModalDetails" style="background:#222; border:1px solid var(--atl-line-strong); …">
<span style="color:#aaa; font-size:13px;">Subtotal:</span>
<div style="border-top:1px solid #444; …"></div>
<button id="quoteModalSendBtn" class="atl-btn atl-btn--primary" style="background:#2196F3; color: var(--atl-ink); border:none;">…</button>

<!-- AFTER -->
<label class="atl-modal-label" style="color:var(--atl-blue);">Quick Select…</label>
<table class="table" style="background:var(--atl-surface2); border-radius:6px; color:var(--atl-ink);">
  <tr style="border-bottom:1px solid var(--atl-line);">
    <th style="border:none; color:var(--atl-muted); font-size:12px;">Description</th>
<textarea id="quoteModalDetails" style="background:var(--atl-input-bg); border:1px solid var(--atl-line); …">
<span style="color:var(--atl-muted); font-size:13px;">Subtotal:</span>
<div style="border-top:1px solid var(--atl-line); …"></div>
<button id="quoteModalSendBtn" class="atl-btn atl-btn--primary">…</button>  <!-- drop the blue bg; let gold apply -->
```

Note: the **`id`s, classes, structure, content, and JS-targeted attributes are unchanged** —
only colour literals are swapped (and the dead blue button bg removed).

---

## 4. Task B — Unify the chrome and the close affordance

### 4.1 One close icon everywhere

Group A already gets the SVG ✕ at runtime. For **Group B** (`blockOutModal`, `adminBookingModal`,
`expenseModal`, `privacyModalAdmin`, `termsModalAdmin`, `modalDateHold`, `importSubscribersModal`,
`newsletterPreviewModal`), replace the glyph inside the existing close button with the **same SVG**
from §2 — **without** changing the button's `class="close"`, `data-dismiss="modal"`, or
`aria-label`:

```html
<!-- BEFORE -->
<button type="button" class="close" data-dismiss="modal" aria-label="Close"><span aria-hidden="true">&times;</span></button>
<!-- AFTER -->
<button type="button" class="close" data-dismiss="modal" aria-label="Close">
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg>
</button>
```

(The UNIVERSAL `.modal-header .close` rule already sets `color:var(--atl-muted)→var(--atl-ink)` on
hover; `stroke="currentColor"` inherits it.) **Do not** convert Group B to `data-close` — keep
Bootstrap's `data-dismiss="modal"`.

### 4.2 Decide the title-accent policy (and make it real)

Right now several titles carry a semantic accent (blue/sage/amber/clay) that the universal
`.modal-header .modal-title { color: var(--atl-ink-dim) !important }` silently overrides.
Choose **one** policy and apply it uniformly:

- **Recommended:** keep a subtle **semantic accent on the title icon only** (e.g. `--atl-blue`
  for info, `--atl-clay` for destructive, `--atl-sage` for success, `--atl-amber` for
  brand/financial) and let the **title text** stay `--atl-ink-dim`. This preserves the
  at-a-glance colour cue without fighting the gold system. Achieve it by colouring the leading
  `<i>`/`<svg>` via a token, not the `<h_>` text.
- If a coloured **title** is genuinely wanted, override with a token at sufficient specificity
  (e.g. a scoped rule using the modal `id`), never a hardcoded hex, and re-verify AA on
  `--atl-surface2`.

Remove dead inline title colours that the universal rule already overrides.

### 4.3 Remove dead chrome literals

Delete inline `background:#0d0d0d / #0e0e0e / #080808` on `.modal-header` / `.modal-footer`
(the UNIVERSAL rules already paint them `var(--atl-surface2)`), so nothing diverges if those
rules change.

---

## 5. Task C — Footer buttons, fields, focus, a11y (every modal)

### 5.1 Footer actions → `.atl-btn`

All footer buttons use the `.atl-btn` family. Primary = `.atl-btn--primary` (gold, no inline
override), secondary/close = `.atl-btn--ghost`, destructive (Cancel/Delete actions) =
`.atl-btn--danger`. **Strip inline `background:#2196F3` / hardcoded button colours.** Keep each
button's `id`, `data-dismiss`, and any `onclick`/handler intact.

### 5.2 Guarantee tokenised fields in native (Group B) modals too

The `.atl-modal-body input|…` rule only matches transformed panels. So native modals need the
same field treatment. Add a **scoped CSS rule** (do not touch markup) so native modal fields
match the reference field spec from §2 — e.g.:

```css
.modal-body .form-control,
.modal-body input:not([type="checkbox"]):not([type="radio"]),
.modal-body select,
.modal-body textarea {
  background: var(--atl-input-bg) !important;
  color: var(--atl-ink) !important;
  border: 1px solid var(--atl-line) !important;
  border-radius: 8px !important;
}
.modal-body .form-control:focus,
.modal-body input:focus, .modal-body select:focus, .modal-body textarea:focus {
  border-color: var(--atl-amber) !important;
  box-shadow: 0 0 0 3px var(--atl-focus) !important;
  outline: none !important;
}
.modal-body .form-control::placeholder,
.modal-body textarea::placeholder { color: var(--atl-placeholder) !important; }
```

This also lets you delete the per-field inline `background:#222` once the rule covers them.

### 5.3 Accessibility (both rendering paths)

- Every modal keeps a working `aria-labelledby` → matching title `id` (Group B already has them;
  verify after the icon swap).
- Every field keeps a programmatic label (`<label for>` or wrapping). Don't orphan labels.
- Visible **gold focus ring** on all interactive controls (from §5.2 + `.atl-btn:focus`).
- Tap targets ≥ 40px; the close button padding from §2 satisfies this.
- Group A focus-trap/ESC/backdrop is provided by the transformer; Group B uses native Bootstrap
  ESC/backdrop — **do not** remove `tabindex="-1"` or `data-dismiss` hooks.

### 5.4 (Optional, guarded) promote eligible Group B form-modals into the transformer

For full parity (overlay blur + SVG ✕ + focus-trap), you **may** add **form-style** Group B
modals to `targetModalIds` — candidates: `blockOutModal`, `expenseModal`, `modalDateHold`,
`importSubscribersModal`. **Only if** you first verify (a) their open/close JS doesn't depend
on native Bootstrap `shown.bs.modal`/`hidden.bs.modal` events, and (b) their content fits the
680px / `max-height:60vh` panel. **Do not** add `privacyModalAdmin` / `termsModalAdmin` (long
legal text — keep native scroll; just tokenise them) and **do not** add `adminBookingModal`
(legacy hidden shell). This edits JS, so test open/close/submit for each promoted modal. If in
doubt, skip this and rely on §4–§5 to make native modals look correct.

---

## 6. Hard constraints (the boundary — non-negotiable)

- **Do not touch the backend or data layer at all:** `server.js`, `database.js`, API routes,
  the booking pipeline (enquiry → quote → confirmed → completed → paid), pricing/invoice/status
  logic. This task does not change a single byte of server-side or data code.
- **Do not change any `id`, `name`, or `data-*` attribute** — especially `data-dismiss`,
  `data-target`, `data-toggle`. JS and Bootstrap key off these.
- **Preserve every data-capture field and its validation/feedback containers:** e.g.
  `#quoteModal*`, `#qb*` (qbItemsTable/qbItemsBody/qbDiscount/qbApplyVat/qbDepositPercentage/…),
  `#expenseModal*`, `#respond*`, and message/error sinks `#quoteModalMsg`, `#cancelModalMsg`,
  `#contractModalMsg`, `#expenseModalMsg`, `#respondAlert`, `.atl-field-error`. Restyle, never
  remove or rename.
- **`adminBookingModal` is a legacy shell.** Its body holds hidden `#ab*` anchors
  (`#abName`, `#abEmail`, `#abDate`, …) and a hidden `#adminRespondForm` (`#respondBookingId`,
  `#respondSubject`, `#respondMessage`, `#emailTemplate`, `#respondSubmitBtn`) preserved for JS
  backward-compat. **Keep them, keep `display:none`, keep the IDs.** Only restyle the visible
  header chrome.
- **Do not remove or rename entries in `targetModalIds`.** You may *add* (per §5.4) only.
- **No new hardcoded hex.** Every colour decision routes through a `--atl-*` token.
- **WCAG 2.1 AA in both themes.** The dark-only greys (`#aaa`/`#888`/`#666`/`#555`/`#444`/`#333`)
  must lift to tokens that pass 4.5:1 on their surface; verify any title/accent colour against
  `--atl-surface2` and against the light palette.
- **Preserve the Atelier language:** Cormorant Garamond display titles, Outfit uppercase
  micro-labels, JetBrains Mono for data/figures, gold accent, recessed `--atl-paper` panels,
  `--atl-shadow-modal`. Don't flatten into a generic Bootstrap modal.
- **No assumptions / verify before merging.** The repo appears to contain near-duplicate modals:
  `cancelBookingModal` **and** `cancelModal` (both "Cancel Booking"), and `blockOutModal`
  **and** `modalDateHold` (both "Block Out Date"). **Do not merge or delete either** — restyle
  both in place and flag the apparent duplication in your summary for a human to resolve.

---

## 7. Acceptance criteria

- [ ] All 18 modals share one panel shape, header/body/footer treatment, and the **SVG ✕** close
      icon (no `&times;` glyph remains).
- [ ] Zero hardcoded colour literals inside any modal block: no `#222`, `#0d0d0d`, `#0e0e0e`,
      `#080808`, `#aaa`, `#bbb`, `#888`, `#666`, `#555`, `#444`, `#333`, `#2196F3`/`#42A5F5`/`#1565C0`,
      `#5cb85c`/`#66BB6A`, `#EF5350`, `#FFA726`, `#9C27B0`, or stray `#D4AF37`/`#e0c04a`/`#fff`.
- [ ] Every modal renders correctly in **dark** *and* **light** (flip `#atlThemeToggle`) — no
      dark island in light mode, no washed-out text in either.
- [ ] All fields in every modal show the tokenised surface + visible **gold focus ring**;
      placeholders use `--atl-placeholder`.
- [ ] Footer primary actions are gold `.atl-btn--primary`; destructive are `.atl-btn--danger`;
      no blue button backgrounds remain.
- [ ] All modal text meets **WCAG AA (4.5:1)** in both themes.
- [ ] `adminBookingModal` still contains all hidden `#ab*` anchors + `#adminRespondForm` with
      unchanged IDs; all message/error sinks intact.
- [ ] `targetModalIds` unchanged except any documented §5.4 additions, each verified.
- [ ] Mobile (≤599px): modals fit, footers wrap, fields are tappable, nothing clips.

---

## 8. Test plan (run before declaring done)

**Functional regression (no behaviour may change):**
- Quote Builder: open → quick-add a catalogue item → adjust qty/discount/VAT/deposit → totals
  recompute → Generate & Send PDF still fires.
- Record Payment / Cancel (both cancel modals) / Contract / Expense / Manual Booking / Promote /
  Booking Info / Financials / Email Client: open, interact, submit/confirm, close — all unchanged.
- Privacy / Terms: open, scroll the long content, close.
- Import Subscribers / Newsletter Preview: open, interact, close.
- Confirm `data-dismiss`, ESC, and backdrop-click still close every modal.

**Theme:** open *each* modal in dark, flip to light with the modal open and via re-open; confirm
chrome, fields, panels, accents, and buttons all re-theme; reload persists theme (no FOUC).

**Edge/failure UI (display only — do not alter the logic):** trigger an existing validation
error (e.g. empty required field) and confirm the error text/`.atl-field-error`/`*Msg` sink
renders legibly in both themes; confirm a long client/event name doesn't break the header.

**Accessibility:** tab through each modal — focus ring visible, focus order sane, `aria-labelledby`
resolves, no keyboard trap beyond the intended focus-trap.

**Cross-path parity:** put a Group A modal and a Group B modal side by side (screenshots) — they
must be indistinguishable in styling.

---

## 9. Suggested order of work

1. **Task A** — tokenise inner-content hex across all 18 (start with `quoteModal`, then the
   other Group A bodies, then Group B). Pure markup colour swaps; lowest risk.
2. **Task B** — close-icon swap for Group B + title-accent policy + remove dead chrome literals.
3. **Task C §5.1–5.3** — footer buttons, the scoped `.modal-body` field rule, a11y pass.
4. **Task C §5.4** (optional) — promote eligible Group B form-modals into the transformer, with
   the guardrails; test each.
5. **Full §7 + §8 pass** in both themes, desktop + mobile. Report the duplicate-modal finding.

> Deliver a short change log: which modals touched, the hex→token swaps made, whether §5.4 was
> applied (and to which modals), and the duplicate-modal flag.
