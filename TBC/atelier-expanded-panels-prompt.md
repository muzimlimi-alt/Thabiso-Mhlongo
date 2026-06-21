# AI Agent Prompt: Align Expanded Booking Card Detail Panels to the Atelier Obsidian Design System

---

## OBJECTIVE

Restyle and restructure every sub-panel inside the **expanded booking card body** of `admin.html` so each one matches its counterpart in `artist-booking-dashboard-obsidian.html`.

This is a **styling and structural refactor only.** Every existing API call, fetch, jQuery event handler, `allBookingsCache` reference, `renderContractStatus()`, `formatQuoteDetails()`, `renderBookingsTable()`, and all related business logic must remain completely intact.

---

## NON-NEGOTIABLE RULES

1. Do not break any existing functionality — venue linking, promotion toggle, notes loading, lazy-load details fetch, contract modal, cancellation modal, quote modal — all must continue to work exactly as before.
2. Do not rename or remove any `id`, `data-*`, or JS-hook class (`.bk-action-*`, `.bkr-more-item`, `.promote-toggle`, `.bk-notes-load-btn`, `.bk-add-note-btn`, `.bk-link-venue-btn`, `.bk-link-venue-select`, etc.).
3. Preserve every `row.*` field reference — do not add or remove data fields from the row object.
4. All new CSS must use the `atl-det-*` prefix and be scoped to the booking section.
5. Every colour must reference a CSS variable from the Atelier token system — no hardcoded hex values.
6. Validate that the expanded panel renders correctly before and after your changes. Do not submit broken HTML templates.
7. **This implementation is mobile-first.** Write base styles for the smallest viewport (≥0px). Add breakpoints progressively for larger screens. Never write desktop styles first and compress downward.

---

## MOBILE-FIRST DESIGN METHODOLOGY

This redesign follows a strict mobile-first methodology. Before writing any CSS:

1. **Design for the smallest supported viewport first** — assume a 360px-wide phone screen as the base canvas.
2. **Build progressively upward** — add `@media (min-width: N)` rules for small tablet (480px), large tablet (640px), laptop (1024px), desktop (1280px), and ultra-wide (1536px).
3. **Every component must be fully usable on mobile before desktop enhancement begins.**

The expanded booking experience should feel intentionally designed for mobile, not compressed from a desktop layout. Administrators frequently access this portal from phones and tablets; treat touch devices as the primary interaction method, not an afterthought.

**Assume touch.** Do not rely on hover states to communicate functionality. Every interaction must be accessible via tap. Hover enhancements are additive polish only.

**Avoid horizontal scrolling on mobile.** Tables, cards, and form controls must adapt so content remains readable without zooming or sideways scrolling.

---

## DESIGN REFERENCE

The target appearance is `artist-booking-dashboard-obsidian.html`'s `buildDetailHTML()` function — specifically its two-column panel grid. Every sub-panel in that function is the visual template for the corresponding panel in admin.html.

---

## SECTION 1: CURRENT VS TARGET LAYOUT

### Current admin.html layout

The expanded `.bkr-card-body` is a **flat vertical stack**:

```
[bkr-info-grid: 3-col strip → Client | Event | Ledger]
[bkr-venue-panel]
[bkr-promote-panel]
[bkr-message]
[attachments function]
[bkr-quote-panel]
[bkr-admin-notes]
[bkr-details-area: lazy-loaded → Line items / Transactions / Quote history]
```

Contract data is only accessible via the Actions dropdown modal (`bk-action-contract`).
Cancellation data is only accessible via the cancel modal.
Audience & Budget data is only accessible via the Booking Info modal (`bk-action-info`).

### Target layout

Replace the flat stack with an **Atelier two-column grid** that places every panel as a matching card. The grid is single-column on mobile and two-column on tablet and above.

```
.atl-det-grid (single column mobile → 2 columns ≥640px)
├── LEFT COLUMN (.atl-det-col)
│   ├── Client card
│   ├── Event card
│   ├── Audience & Budget card (conditional)
│   ├── Ledger card
│   ├── Venue card
│   ├── Public Promotion card (ACCEPTED/CONFIRMED/COMPLETED only)
│   ├── Contract card (populated via lazy-load)
│   └── Cancellation card (CANCELLED status only, populated via lazy-load)
└── RIGHT COLUMN (.atl-det-col)
    ├── Client message card (if row.message)
    ├── Attachments card (if attachment files exist)
    ├── Quote card (replaces bkr-quote-panel)
    ├── Internal Notes card
    ├── Line Items card (lazy-loaded)
    ├── Transactions card (lazy-loaded)
    └── Quote History card (lazy-loaded, ≥2 versions only)
```

---

## SECTION 2: UNIVERSAL SUB-PANEL CSS

All CSS in this section is written **mobile-first** — base styles target the smallest screens and breakpoints add refinement for larger viewports. Write styles in this order: base (mobile), then `@media (min-width: ...)`.

### Panel container

```css
/* Mobile base */
.atl-det-card {
  background: var(--atl-surface2);
  border-radius: 12px;
  padding: 14px;
  transition: background-color 0.4s ease;
}
/* Scale padding as viewport grows */
@media (min-width: 480px) { .atl-det-card { padding: 15px; } }
@media (min-width: 768px) { .atl-det-card { padding: 16px; } }
```

### Panel title

```css
.atl-det-title {
  font-family: 'Outfit', sans-serif;
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--atl-muted);
  margin-bottom: 12px;
}
```

### Two-column grid — full responsive breakpoint range

```css
/* ── GRID — mobile-first, all six breakpoints ─────── */

/* Base: single column for all phone widths */
.atl-det-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 12px;
  padding: 16px;
  border-top: 1px solid var(--atl-line);
}

/* Small tablet (480px): more breathing room, still single column */
@media (min-width: 480px) {
  .atl-det-grid { padding: 20px; gap: 14px; }
}

/* Large tablet (640px): introduce two-column layout */
@media (min-width: 640px) {
  .atl-det-grid {
    grid-template-columns: 1fr 1fr;
    gap: 16px;
  }
}

/* Laptop (1024px): comfortable spacing */
@media (min-width: 1024px) {
  .atl-det-grid { padding: 24px; gap: 18px; }
}

/* Desktop (1280px): full Atelier editorial spacing */
@media (min-width: 1280px) {
  .atl-det-grid { gap: 20px; padding: 28px; }
}

/* Ultra-wide (1536px): cap content width — avoid overstretched cards */
@media (min-width: 1536px) {
  .atl-det-grid {
    max-width: 1440px;
    margin-left: auto;
    margin-right: auto;
  }
}

/* Column: stacks cards vertically, gap scales with viewport */
.atl-det-col {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
@media (min-width: 640px) { .atl-det-col { gap: 14px; } }
@media (min-width: 1024px) { .atl-det-col { gap: 16px; } }
```

### Inline links (email, phone, PDF)

```css
.atl-det-link {
  color: var(--atl-amber);
  text-decoration: underline;
  text-underline-offset: 2px;
  font-size: 13px;
  transition: color 0.15s ease;
}
.atl-det-link:hover { color: var(--atl-amber-hover); }
.atl-det-link:active { opacity: 0.7; }   /* touch feedback */
```

### Key-value definition list (Ledger, Event, Audience)

```css
/* Mobile base: two-column with auto/1fr */
.atl-det-dl {
  display: grid;
  grid-template-columns: auto 1fr;
  column-gap: 16px;
  row-gap: 4px;
  font-size: clamp(12px, 3.2vw, 13px);
}
.atl-det-dl dt {
  color: var(--atl-muted);
  font-family: 'Outfit', sans-serif;
  font-weight: 400;
}
.atl-det-dl dd {
  color: var(--atl-ink);
  font-family: 'Outfit', sans-serif;
  text-align: right;
  font-weight: 400;
  margin: 0;
}
.atl-det-dl dd.atl-det-positive { color: var(--atl-sage); font-weight: 700; }
.atl-det-dl dd.atl-det-negative { color: var(--atl-clay); font-weight: 700; }
.atl-det-dl dd.atl-det-gold     { color: var(--atl-amber); font-weight: 700; }

/* Very narrow screens: stack dt/dd pairs for readability */
@media (max-width: 359px) {
  .atl-det-dl {
    grid-template-columns: 1fr;
    row-gap: 0;
  }
  .atl-det-dl dd {
    text-align: left;
    padding-bottom: 6px;
    font-weight: 600;
  }
}
```

### Table — base styles and tablet+ overflow

```css
.atl-det-table {
  width: 100%;
  border-collapse: collapse;
  font-family: 'Outfit', sans-serif;
  font-size: clamp(11px, 2.8vw, 12px);
  color: var(--atl-ink);
}
.atl-det-table caption { display: none; }
.atl-det-table thead tr { border-bottom: 2px solid var(--atl-ink); }
.atl-det-table th {
  padding: 6px 0;
  font-weight: 700;
  color: var(--atl-ink);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.atl-det-table th.right, .atl-det-table td.right { text-align: right; }
.atl-det-table tbody tr { border-bottom: 1px solid var(--atl-line); }
.atl-det-table td { padding: 6px 0; font-size: clamp(11px, 2.8vw, 12px); color: var(--atl-ink); }
.atl-det-table tfoot tr:first-child td,
.atl-det-table tfoot tr:first-child th { padding-top: 8px; color: var(--atl-muted); }
.atl-det-table tfoot tr:last-child td,
.atl-det-table tfoot tr:last-child th { font-weight: 700; font-size: 13px; padding-bottom: 4px; }
.atl-det-table tr.atl-det-active-row { background: rgba(212,175,55,0.04); }
.atl-det-tabular { font-variant-numeric: tabular-nums; }

/* Overflow wrapper — only activated on tablet+ where horizontal scroll is acceptable */
@media (min-width: 600px) {
  .atl-det-table-wrap {
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
  }
}
```

### Loading placeholder (for lazy-loaded panels)

```css
.atl-det-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 32px 0;
  color: var(--atl-muted);
  font-family: 'Outfit', sans-serif;
  font-size: 13px;
}
```

### Empty/null state inside a panel

```css
.atl-det-empty {
  font-family: 'Outfit', sans-serif;
  font-size: clamp(12px, 3vw, 13px);
  color: var(--atl-muted);
  font-style: italic;
  padding: 4px 0;
}
```

---

## SECTION 2A: BREAKPOINT REFERENCE TABLE

| Breakpoint | Width | Grid | Behaviour |
|---|---|---|---|
| Mobile | 0 – 479px | 1 column | Stack all cards vertically, tables become stacked rows |
| Small tablet | 480 – 639px | 1 column | Wider padding, more comfortable spacing |
| Large tablet | 640 – 1023px | 2 columns | Introduce two-column Atelier grid |
| Laptop | 1024 – 1279px | 2 columns | Comfortable editorial spacing |
| Desktop | 1280 – 1535px | 2 columns | Full Atelier spacing rhythm |
| Ultra-wide | 1536px+ | 2 columns | Max-width cap at 1440px to preserve readability |

---

## SECTION 2B: RESPONSIVE TABLE SYSTEM

Tables are the most challenging element on mobile. At or below 599px, every `atl-det-table-responsive` table must transform from a horizontal layout into a **stacked label-value card** layout. No horizontal scrolling is acceptable on mobile for these data tables.

### How it works

Add class `atl-det-table-responsive` to every `<table>` element alongside `atl-det-table`. On mobile, `thead` is hidden and each `<tbody>` row becomes a mini card. Each `<td>` shows its column name via the `data-label` attribute using a CSS `::before` pseudo-element.

**Every `<td>` in every table must have a `data-label` attribute** containing the plain-text column header. This is required for the mobile transformation. See the updated JS templates in Section 3K, 3M, 3N, and 3O.

### CSS

```css
/* ── MOBILE TABLE TRANSFORMATION (≤599px) ─────────── */
@media (max-width: 599px) {

  /* Hide column headers — replaced by data-label on each cell */
  .atl-det-table-responsive thead {
    display: none;
  }

  /* Each row becomes a mini card */
  .atl-det-table-responsive tbody tr {
    display: block;
    background: var(--atl-paper);
    border: 1px solid var(--atl-line);
    border-radius: 8px;
    padding: 10px 12px;
    margin-bottom: 8px;
  }
  .atl-det-table-responsive tbody tr:last-child { margin-bottom: 0; }

  /* Active row in quote history keeps its gold tint */
  .atl-det-table-responsive tbody tr.atl-det-active-row {
    background: rgba(212,175,55,0.06);
    border-color: rgba(212,175,55,0.20);
  }

  /* Each cell: flex row — label left, value right */
  .atl-det-table-responsive tbody td {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 12px;
    padding: 4px 0;
    border: none;
    font-size: 12px;
    line-height: 1.4;
    text-align: right;
  }

  /* Column label injected from data-label attribute */
  .atl-det-table-responsive tbody td::before {
    content: attr(data-label);
    color: var(--atl-muted);
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    flex-shrink: 0;
    white-space: nowrap;
    min-width: 72px;
    text-align: left;
    padding-top: 1px;
  }

  /* Tfoot: summary rows displayed as label-value flex pairs */
  .atl-det-table-responsive tfoot {
    display: block;
    border-top: 1px solid var(--atl-line);
    margin-top: 8px;
    padding-top: 8px;
  }
  .atl-det-table-responsive tfoot tr {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 3px 0;
    font-size: 12px;
    color: var(--atl-muted);
  }
  /* colspan cells in tfoot: flex:1 so they fill the left side as labels */
  .atl-det-table-responsive tfoot td[colspan] {
    flex: 1;
    font-size: 11px;
    text-align: left;
  }
  /* Non-colspan cells in tfoot: the actual values, right-aligned */
  .atl-det-table-responsive tfoot td:not([colspan]) {
    font-variant-numeric: tabular-nums;
    font-weight: 600;
  }
  /* Last tfoot row (Total): bigger, bolder, gold value */
  .atl-det-table-responsive tfoot tr:last-child {
    border-top: 1px solid var(--atl-line);
    margin-top: 6px;
    padding-top: 8px;
    font-size: 14px;
    font-weight: 700;
    color: var(--atl-ink);
  }

  /* Terms row spans full width */
  .atl-det-table-responsive tfoot td.atl-tfoot-terms {
    display: block;
    font-size: 11px;
    color: var(--atl-muted);
    padding-top: 8px;
    border-top: 1px solid var(--atl-line);
    margin-top: 6px;
  }
}

/* ── TABLET REFINEMENTS (600px – 767px) ────────────── */
@media (min-width: 600px) and (max-width: 767px) {
  .atl-det-table-responsive th,
  .atl-det-table-responsive td { padding: 6px 4px; }
  .atl-det-table-responsive { font-size: 12px; }
}
```

### The `data-label` requirement

**Every `<td>` generated by the four table functions (Quote, Line Items, Transactions, Quote History) must include a `data-label` attribute.** The label must exactly match the column heading. Examples:

```html
<td data-label="Description">Main Performance</td>
<td data-label="Qty" class="right atl-det-tabular">90</td>
<td data-label="Unit" class="right atl-det-tabular">R 4500.00</td>
<td data-label="Total" class="right atl-det-tabular" style="font-weight:700;">R 405000.00</td>
```

See updated templates in Sections 3K, 3M, 3N, and 3O.

---

## SECTION 2C: TOUCH-FIRST INTERACTIONS

All interactive elements must meet a minimum 44×44px tap target. Apply this globally within `#bookingsAdmin`:

```css
/* ── TOUCH TARGET MINIMUMS ─────────────────────────── */

/* All primary interactive elements: minimum 44px height */
.atl-btn,
.atl-new-btn,
.atl-clear-btn,
.atl-filter-select,
.bk-notes-load-btn,
.bk-add-note-btn {
  min-height: 44px;
}

/* The atl-switch is visually 28px tall but needs a 44px touch area.
   Use a transparent pseudo-element to extend the hit area without changing appearance. */
.atl-switch {
  position: relative;
}
.atl-switch::before {
  content: '';
  position: absolute;
  top: -8px;
  left: -8px;
  right: -8px;
  bottom: -8px;
}

/* Venue inputs and form controls: comfortable tap height */
.atl-venue-input,
.bk-link-venue-select,
.bkr-venue-select {
  min-height: 44px;
  padding-top: 10px;
  padding-bottom: 10px;
}

/* bk-add-note-btn and bk-notes-load-btn padding */
.bk-notes-load-btn,
.bk-add-note-btn {
  padding: 10px 16px;
}

/* Actions row on narrow screens: wrap and give each button room to breathe */
@media (max-width: 479px) {
  .bkr-actions {
    flex-wrap: wrap;
    gap: 8px;
  }
  .bkr-actions .atl-btn {
    flex: 1;
    min-width: 100px;
    justify-content: center;
    text-align: center;
  }
}

/* Actions dropdown on very narrow screens: full viewport width */
@media (max-width: 479px) {
  .bkr-more-dropdown {
    min-width: calc(100vw - 32px) !important;
    left: 16px !important;
    right: auto !important;
  }
  .bkr-more-item {
    padding: 12px 16px !important;   /* larger tap area inside dropdown */
    font-size: 13px !important;
  }
}

/* Touch feedback — :active states for all tappable elements */
.atl-btn:active,
.atl-new-btn:active,
.atl-clear-btn:active  { opacity: 0.80; }
.atl-det-link:active   { opacity: 0.70; }
.atl-switch:active     { opacity: 0.85; }

/* No hover-only state: any state communicated by hover must also be
   communicated on focus (already handled by the atl-focus ring system). */
```

---

## SECTION 3: PANEL-BY-PANEL SPECIFICATIONS

### 3A. CLIENT PANEL

**Position:** Left column, first card.
**Reference:** Atelier `buildDetailHTML()` Client panel.
**Data fields:** `row.name`, `row.company`, `row.email`, `row.cell`

```html
<div class="atl-det-card">
  <h5 class="atl-det-title">Client</h5>
  <p style="font-size:clamp(12px,3.2vw,13px); font-weight:600; color:var(--atl-ink); margin:0 0 4px;">
    ${row.name}${row.company ? ` <span style="font-weight:400;color:var(--atl-muted)">· ${row.company}</span>` : ''}
  </p>
  <p style="font-size:clamp(12px,3.2vw,13px); margin:0; color:var(--atl-muted);">
    <a href="mailto:${row.email}" class="atl-det-link">${row.email}</a>
    ${row.cell ? ` · <a href="tel:${row.cell.replace(/\s/g,'')}" class="atl-det-link">${row.cell}</a>` : ''}
  </p>
</div>
```

Replace the current `bkr-info-block` Client block with this card.

---

### 3B. EVENT PANEL

**Position:** Left column, second card.
**Data fields:** `row.event_name || row.event_type`, `row.date`, `row.event_start_time`, `row.event_location`, `row.venue_type`, `row.performance_slot`, `row.performance_duration`

**Note:** `performance_slot`, `performance_duration`, and `venue_type` are present on the full booking row from `/api/admin/bookings/full`. They are currently only displayed in the Booking Info modal. Add them here so the inline expanded card surfaces the full event detail without requiring the modal.

```html
<div class="atl-det-card">
  <h5 class="atl-det-title">Event</h5>
  <p style="font-size:clamp(12px,3.2vw,13px); font-weight:600; color:var(--atl-ink); margin:0 0 8px;">
    ${row.event_name || row.event_type || '—'}
  </p>
  <dl class="atl-det-dl">
    <dt>Date</dt>
    <dd>${row.date || '—'}${row.event_start_time ? ' · ' + row.event_start_time : ''}</dd>
    <dt>Location</dt>
    <dd>${row.event_location || '—'}</dd>
    ${row.performance_slot     ? `<dt>Slot</dt><dd>${row.performance_slot}</dd>` : ''}
    ${row.performance_duration ? `<dt>Duration</dt><dd>${row.performance_duration}</dd>` : ''}
    ${row.venue_type           ? `<dt>Venue type</dt><dd>${row.venue_type}</dd>` : ''}
  </dl>
</div>
```

---

### 3C. AUDIENCE AND BUDGET PANEL

**Position:** Left column, third card. Admin-specific. Only render if at least one field has data.

```javascript
const hasAudienceData = row.audience_size || row.audience_demographic
                      || row.budget_range  || row.travel_accommodation != null;
```

```html
<!-- Render only if hasAudienceData is truthy -->
<div class="atl-det-card">
  <h5 class="atl-det-title">Audience &amp; Budget</h5>
  <dl class="atl-det-dl">
    ${row.audience_size        ? `<dt>Audience size</dt><dd>${row.audience_size}</dd>` : ''}
    ${row.audience_demographic ? `<dt>Demographic</dt><dd>${row.audience_demographic}</dd>` : ''}
    ${row.budget_range         ? `<dt>Budget range</dt><dd class="atl-det-gold">${row.budget_range}</dd>` : ''}
    ${row.travel_accommodation != null
      ? `<dt>Travel provided</dt>
         <dd style="color:${row.travel_accommodation ? 'var(--atl-sage)' : 'var(--atl-muted)'}; font-weight:600;">
           ${row.travel_accommodation ? 'Yes' : 'No'}
         </dd>` : ''}
  </dl>
</div>
```

**Data sourcing:** `audience_size`, `audience_demographic`, `budget_range`, and `travel_accommodation` are already on the booking row object from `/api/admin/bookings/full`. No new API calls are needed.

---

### 3D. LEDGER PANEL

**Position:** Left column, fourth card.
**Reference:** Atelier `buildDetailHTML()` Ledger panel.
**Data fields:** `row.payment_status`, `row.quote_amount`, `row.amount_paid`, `row.amount_outstanding`, `row.payment_date`, `row.payment_reference`

```html
<div class="atl-det-card">
  <h5 class="atl-det-title">Ledger</h5>
  <dl class="atl-det-dl">
    <dt>Payment</dt>
    <dd>${paymentStatusLabel(row.payment_status)}</dd>
    <dt>Quoted total</dt>
    <dd class="atl-det-tabular">R ${parseFloat(row.quote_amount||0).toFixed(2)}</dd>
    <dt>Paid</dt>
    <dd class="atl-det-tabular">R ${parseFloat(row.amount_paid||0).toFixed(2)}</dd>
    <dt>Outstanding</dt>
    <dd class="atl-det-tabular ${parseFloat(row.amount_outstanding)>0 ? 'atl-det-negative' : 'atl-det-positive'}">
      R ${parseFloat(row.amount_outstanding||0).toFixed(2)}
    </dd>
    ${row.payment_date
      ? `<dt>Last payment</dt>
         <dd>${new Date(row.payment_date).toLocaleDateString('en-ZA')}
             ${row.payment_reference ? ' · ' + row.payment_reference : ''}</dd>`
      : ''}
  </dl>
</div>
```

`paymentStatusLabel()` maps `PAID → 'Paid'`, `DEPOSIT_PAID → 'Deposit paid'`, `UNPAID → 'Unpaid'`, `FAILED → 'Failed'`. Use existing `payLbl` map in `renderBookingsTable`.

---

### 3E. VENUE PANEL

**Position:** Left column, fifth card.
**Reference:** Atelier `buildDetailHTML()` Venue panel.

Preserve all inner JS hooks: `.bk-link-venue-select`, `.bk-link-venue-btn`, `.bk-venue-edit-btn`, `.bk-venue-save-btn`, `.bk-venue-cancel-btn`.

**When venue is linked** (`row.venue_id` is set):
```html
<div class="atl-det-card">
  <h5 class="atl-det-title"><span aria-hidden="true">⌖</span> Venue</h5>
  <p style="font-family:'Cormorant Garamond',serif;
             font-size:clamp(15px,4.5vw,17px);
             font-weight:600;
             color:var(--atl-ink);
             margin:0 0 6px;
             line-height:1.2;">
    ${row.venue_name || row.event_location || '—'}
  </p>
  <p style="font-size:clamp(12px,3vw,13px); color:var(--atl-muted); margin:0;">
    ${row.venue_city ? row.venue_city + ' · ' : ''}
    ${row.venue_capacity ? 'Cap. ' + row.venue_capacity.toLocaleString() + ' · ' : ''}
    ${row.venue_contact
      ? `<a href="mailto:${row.venue_contact}" class="atl-det-link">${row.venue_contact}</a>`
      : ''}
  </p>
  ${row.venue_contact_phone
    ? `<p style="font-size:12px;color:var(--atl-muted);margin-top:4px;">${row.venue_contact_phone}</p>`
    : ''}
  ${row.venue_notes
    ? `<p style="font-size:11px;color:var(--atl-muted);margin-top:6px;font-style:italic;">${row.venue_notes}</p>`
    : ''}
</div>
```

**When no venue is linked:**
```html
<div class="atl-det-card">
  <h5 class="atl-det-title">Venue
    <span style="font-size:10px;color:var(--atl-clay);margin-left:6px;font-weight:400;">· Unlinked</span>
  </h5>
  <p style="font-size:13px;color:var(--atl-muted);margin:0 0 10px;">${row.event_location || '—'}</p>
  <!-- Venue edit form: replace hardcoded colours with atl-venue-input class (see below) -->
  <div class="bkr-venue-link-row" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:10px;">
    <label for="venueSel-${row.id}" class="atl-det-title" style="margin:0;flex-shrink:0;">Link a venue</label>
    <select class="bkr-venue-select bk-link-venue-select atl-filter-select"
            style="flex:1;min-width:140px;"
            data-booking-id="${row.id}">
      <option value="">— Select venue —</option>
    </select>
    <button type="button"
            class="bkr-venue-link-btn bk-link-venue-btn atl-btn atl-btn--primary"
            data-booking-id="${row.id}">
      <i class="fa-solid fa-link"></i> Link
    </button>
  </div>
</div>
```

**Input styling for venue edit form fields:**
```css
.atl-venue-input {
  width: 100%;
  background: var(--atl-input-bg);
  border: 1px solid var(--atl-line);
  color: var(--atl-ink);
  border-radius: 6px;
  padding: 10px 12px;       /* 10px vertical ensures 44px height with font */
  font-size: 12px;
  font-family: 'Outfit', sans-serif;
  margin-bottom: 6px;
  min-height: 44px;         /* touch target */
  transition: border-color 0.2s ease;
}
.atl-venue-input::placeholder { color: var(--atl-placeholder); }
.atl-venue-input:focus { outline: 3px solid var(--atl-focus); border-color: var(--atl-amber); }
```

Apply `.atl-venue-input` to `#venue-loc-${row.id}`, `#venue-addr-${row.id}`, `#venue-city-${row.id}`, `#venue-country-${row.id}`.

---

### 3F. PUBLIC PROMOTION PANEL

**Position:** Left column, sixth card. Only for ACCEPTED / CONFIRMED / COMPLETED.
**Reference:** Atelier Public promotion panel.

Keep all inner functionality. Only restyle the container and replace the Bootstrap switch.

**Container:**
```html
<div class="atl-det-card" id="promote-panel-${row.id}">
  <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap;">
    <div style="flex:1;min-width:140px;">
      <h5 class="atl-det-title" id="promoLabel-${row.id}" style="margin-bottom:4px;">
        <i class="fa-solid fa-bullhorn" aria-hidden="true" style="color:var(--atl-amber);margin-right:6px;"></i>
        Public Promotion
        <!-- existing bkr-promote-live-badge span, restyled as atl-promote-live-badge -->
      </h5>
      <p style="font-size:clamp(12px,3vw,13px);color:var(--atl-muted);margin:0;">
        List this booking on the public events page.
      </p>
    </div>
    <!-- Atelier atl-switch replaces Bootstrap custom-switch -->
    <button type="button"
            class="atl-switch promote-toggle"
            role="switch"
            id="promote-${row.id}"
            data-id="${row.id}"
            aria-checked="${row.is_public ? 'true' : 'false'}"
            aria-labelledby="promoLabel-${row.id}"
            style="flex-shrink:0;">
    </button>
  </div>
  <!-- All inner blocks unchanged: bkr-promote-warn, bkr-promote-preview, bkr-promote-ticket -->
</div>
```

**Replace the Bootstrap checkbox** with the Atelier `role="switch"` button. Update JS toggle handlers:
```javascript
// Read:  $(this).attr('aria-checked') === 'true'
// Write: $(this).attr('aria-checked', 'true' / 'false')
```

**Promote panel inner styles:**
```css
.atl-promote-live-badge {
  display: inline-flex; align-items: center; gap: 4px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 9px; letter-spacing: 0.15em; text-transform: uppercase;
  padding: 2px 8px; border-radius: 999px;
  background: rgba(74,222,128,0.15); color: var(--atl-sage);
  border: 1px solid rgba(74,222,128,0.3);
  margin-left: 8px; vertical-align: middle;
}
.atl-promote-live-badge--off {
  background: var(--atl-surface2); color: var(--atl-muted); border-color: var(--atl-line);
}
.atl-promote-warn {
  display: flex; align-items: flex-start; gap: 8px;
  background: rgba(248,113,113,0.08); border: 1px solid rgba(248,113,113,0.25);
  border-radius: 8px; padding: 10px 12px; margin-top: 12px;
  font-size: 12px; color: var(--atl-clay);
}
.atl-promote-warn-item { font-weight: 700; text-decoration: underline; text-underline-offset: 2px; }
.atl-promote-preview {
  margin-top: 12px; background: var(--atl-paper);
  border: 1px solid var(--atl-line); border-radius: 10px; padding: 12px; font-size: 12px;
}
.atl-promote-preview--hidden { display: none; }
.atl-promote-preview__eyebrow {
  font-family: 'JetBrains Mono', monospace; font-size: 9px;
  text-transform: uppercase; letter-spacing: 0.2em; color: var(--atl-muted); margin-bottom: 8px;
}
.atl-promote-preview__name {
  font-family: 'Cormorant Garamond', serif; font-size: clamp(14px,4vw,16px);
  font-weight: 600; color: var(--atl-ink); margin-bottom: 6px;
}
.atl-promote-preview__meta {
  display: flex; flex-wrap: wrap; gap: 8px; font-size: 12px; color: var(--atl-muted);
}
.atl-promote-ticket-save {
  background: rgba(212,175,55,0.12); border: 1px solid rgba(212,175,55,0.35);
  color: var(--atl-amber); border-radius: 6px;
  padding: 10px 14px;       /* 44px-friendly height */
  font-size: 11px; font-weight: 700; cursor: pointer; white-space: nowrap;
  min-height: 44px; display: inline-flex; align-items: center;
  transition: background 0.15s ease;
}
.atl-promote-ticket-save:hover { background: rgba(212,175,55,0.2); }
```

Apply `.atl-venue-input` to the ticket URL input field.

---

### 3G. CONTRACT PANEL (new inline panel)

**Position:** Left column, seventh card.
**Reference:** Atelier `buildDetailHTML()` Contract panel.

**HTML placeholder** (pre-rendered immediately, populated via lazy-load):

```html
<div class="atl-det-card" id="atl-contract-${row.id}">
  <h5 class="atl-det-title">Contract</h5>
  <div class="atl-det-loading">
    <span class="atl-spinner" aria-hidden="true"></span>
    <span>Loading contract status…</span>
  </div>
</div>
```

**Add a third fetch** to the existing `Promise.all()` in the expand handler:

```javascript
Promise.all([
  fetch('/api/admin/bookings/' + bookingId + '/details',       { credentials:'same-origin' }).then(r=>r.json()),
  fetch('/api/admin/bookings/' + bookingId + '/quote-history',  { credentials:'same-origin' }).then(r=>r.json()).catch(()=>[]),
  fetch('/api/admin/bookings/' + bookingId + '/contract',       { credentials:'same-origin' }).then(r=>r.json()).catch(()=>null)
]).then(function([d, history, contract]) {
  // ... existing line-items / transactions / history rendering unchanged ...
  renderInlineContractPanel(bookingId, contract);
});
```

**`renderInlineContractPanel(id, c)` function:**

```javascript
function renderInlineContractPanel(id, c) {
  var $panel = $('#atl-contract-' + id);
  if (!$panel.length) return;
  if (!c || c.error) {
    $panel.html('<h5 class="atl-det-title">Contract</h5><p class="atl-det-empty">No contract on file.</p>');
    return;
  }
  var states = {
    draft:  { color: 'var(--atl-muted)',  label: 'Draft' },
    sent:   { color: 'var(--atl-amber)',  label: 'Sent to client' },
    signed: { color: 'var(--atl-sage)',   label: 'Signed ✓' }
  };
  var st = states[c.status] || states.draft;
  var html = '<h5 class="atl-det-title">Contract</h5>';
  html += '<p style="font-size:13px;margin:0 0 6px;">Status: <strong style="color:' + st.color + '">' + st.label + '</strong></p>';
  if (c.pdf_url) {
    html += '<p style="font-size:12px;color:var(--atl-muted);margin:0 0 6px;">'
          + '<i class="fa-solid fa-file-pdf" style="color:var(--atl-clay);margin-right:6px;"></i>'
          + '<a href="' + c.pdf_url + '" target="_blank" rel="noopener" class="atl-det-link">'
          + (c.pdf_url.split('/').pop() || 'contract.pdf') + '</a></p>';
  }
  if (c.signed_by) {
    html += '<p style="font-size:12px;color:var(--atl-muted);margin:0 0 4px;">Signed by <strong style="color:var(--atl-ink)">'
          + c.signed_by + '</strong>'
          + (c.signed_date ? ' on ' + new Date(c.signed_date).toLocaleDateString('en-ZA') : '') + '</p>';
  }
  if (c.uploaded_by) {
    html += '<p style="font-size:11px;color:var(--atl-muted);margin:0;">Uploaded by ' + c.uploaded_by + '</p>';
  }
  $panel.html(html);
}
```

The Contract modal (`#contractModal`) and its upload/sign/download workflow remain fully intact via the Actions dropdown. This panel is display-only.

---

### 3H. CANCELLATION PANEL (new inline panel, CANCELLED only)

**Position:** Left column, last card. Only when `s === 'CANCELLED'`.
**Reference:** Atelier Cancellation panel — clay-tinted.

```html
<div class="atl-det-card atl-det-card--cancel" id="atl-cancel-${row.id}">
  <div class="atl-det-loading">
    <span class="atl-spinner" aria-hidden="true"></span>
    <span>Loading cancellation details…</span>
  </div>
</div>
```

```css
.atl-det-card--cancel {
  background: rgba(248,113,113,0.08);
  border: 1px solid rgba(248,113,113,0.30);
  border-left: 3px solid var(--atl-clay);
}
.atl-det-card--cancel .atl-det-title { color: var(--atl-clay); }
```

**Populate from the `/details` response:**

```javascript
function renderInlineCancellationPanel(id, d) {
  var $panel = $('#atl-cancel-' + id);
  if (!$panel.length) return;
  var c = d.cancellation;
  if (!c) { $panel.remove(); return; }
  var html = '<h5 class="atl-det-title">Cancellation</h5>';
  if (c.reason) html += '<p style="font-size:13px;color:var(--atl-ink);margin:0 0 6px;">' + c.reason + '</p>';
  html += '<p style="font-size:12px;color:var(--atl-muted);margin:0 0 4px;">';
  if (c.cancelled_by) html += 'By <strong style="color:var(--atl-ink)">' + c.cancelled_by + '</strong>';
  if (c.refund_amount > 0) html += ' · Refund R ' + parseFloat(c.refund_amount).toFixed(2);
  html += '</p>';
  if (c.notes) html += '<p style="font-size:12px;color:var(--atl-muted);margin:0;font-style:italic;">' + c.notes + '</p>';
  $panel.html(html);
}
```

Call `renderInlineCancellationPanel(bookingId, d)` inside the `.then()` callback only when `s === 'CANCELLED'`.

---

### 3I. CLIENT MESSAGE PANEL

**Position:** Right column, first card. Only render if `row.message` is non-empty.
**Reference:** Atelier Client message panel.

```html
<div class="atl-det-card">
  <h5 class="atl-det-title">Client message</h5>
  <p style="font-family:'Cormorant Garamond',Georgia,serif;
             font-size:clamp(14px,4vw,15px);
             font-style:italic;
             line-height:1.6;
             color:var(--atl-muted);
             margin:0;
             word-wrap:break-word;
             overflow-wrap:break-word;">
    &ldquo;${row.message}&rdquo;
  </p>
</div>
```

The `word-wrap: break-word` prevents long client messages from overflowing the card on mobile.

---

### 3J. ATTACHMENTS PANEL

**Position:** Right column, second card (if files exist).

```html
<div class="atl-det-card">
  <h5 class="atl-det-title">Attached files</h5>
  <div style="display:flex;flex-wrap:wrap;gap:8px;">
    ${files.map(f =>
      `<a href="/api/admin/booking-attachments/${encodeURIComponent(f.filename)}"
          target="_blank" rel="noopener"
          class="atl-tag-badge"
          style="font-size:11px;padding:8px 12px;border-radius:6px;
                 text-decoration:none;min-height:36px;display:inline-flex;
                 align-items:center;gap:6px;">
         <i class="fa-solid fa-paperclip" style="font-size:10px;flex-shrink:0;"></i>
         <span style="word-break:break-all;max-width:180px;">${f.original_name}</span>
       </a>`
    ).join('')}
  </div>
</div>
```

`word-break: break-all` on the filename span prevents long file names from overflowing on mobile.

---

### 3K. QUOTE PANEL — with responsive table

**Position:** Right column, third card.
**Reference:** Atelier Quote panel.

```html
<div class="atl-det-card">
  <h5 class="atl-det-title">Quote</h5>
  ${row.quote_amount
    ? `<div class="atl-det-table-wrap">${formatQuoteDetailsAtelier(row.quote_details, row.quote_amount, row.quote_expiry_date)}</div>`
    : `<p class="atl-det-empty">No quote prepared yet.</p>`}
</div>
```

**`formatQuoteDetailsAtelier()` — updated with `data-label` on every `<td>`:**

```javascript
function formatQuoteDetailsAtelier(json, totalAmount, expiryDate) {
  if (!json) return '<p class="atl-det-empty">No line items on record.</p>';
  var qd;
  try { qd = JSON.parse(json); } catch(e) { return '<p class="atl-det-empty">Quote details unavailable.</p>'; }
  if (!qd || !Array.isArray(qd.items)) return '<p class="atl-det-empty">Quote details unavailable.</p>';

  var subtotal = 0;
  var rows = qd.items.map(function(item) {
    var qty  = item.quantity_minutes || item.quantity || 1;
    var unit = parseFloat(item.unit_price || 0);
    var tot  = qty * unit;
    subtotal += tot;
    return '<tr>'
      + '<td data-label="Description">' + (item.description || '—') + '</td>'
      + '<td data-label="Qty" class="right atl-det-tabular">' + qty + '</td>'
      + '<td data-label="Unit" class="right atl-det-tabular">R ' + unit.toFixed(2) + '</td>'
      + '<td data-label="Total" class="right atl-det-tabular" style="font-weight:700;">R ' + tot.toFixed(2) + '</td>'
      + '</tr>';
  }).join('');

  var discount    = parseFloat(qd.discount || 0);
  var vatAmount   = qd.apply_vat ? Math.round((subtotal - discount) * 0.15) : 0;
  var displayTotal = parseFloat(totalAmount || 0) || (subtotal - discount + vatAmount);

  var tfoot = '<tr>'
    + '<td colspan="3" class="right" style="color:var(--atl-muted);padding-top:8px;">Subtotal</td>'
    + '<td class="right atl-det-tabular" style="padding-top:8px;">R ' + subtotal.toFixed(2) + '</td>'
    + '</tr>';
  if (discount > 0) {
    tfoot += '<tr>'
      + '<td colspan="3" class="right" style="color:var(--atl-muted);">Discount</td>'
      + '<td class="right atl-det-tabular" style="color:var(--atl-clay);">–R ' + discount.toFixed(2) + '</td>'
      + '</tr>';
  }
  if (qd.apply_vat) {
    tfoot += '<tr>'
      + '<td colspan="3" class="right" style="color:var(--atl-muted);">VAT (15%)</td>'
      + '<td class="right atl-det-tabular">R ' + vatAmount.toFixed(2) + '</td>'
      + '</tr>';
  }
  tfoot += '<tr>'
    + '<td colspan="3" class="right" style="padding-top:6px;font-weight:700;">Total</td>'
    + '<td class="right atl-det-tabular" style="font-weight:700;font-size:14px;color:var(--atl-amber);">'
    + 'R ' + displayTotal.toFixed(2) + '</td>'
    + '</tr>';
  if (qd.terms) {
    tfoot += '<tr><td colspan="4" class="atl-tfoot-terms">'
           + '<strong style="color:var(--atl-ink);">Terms:</strong> ' + qd.terms
           + '</td></tr>';
  }

  var html = '<table class="atl-det-table atl-det-table-responsive">'
    + '<thead><tr>'
    + '<th>Description</th>'
    + '<th class="right">Qty</th>'
    + '<th class="right">Unit</th>'
    + '<th class="right">Total</th>'
    + '</tr></thead>'
    + '<tbody>' + rows + '</tbody>'
    + '<tfoot>' + tfoot + '</tfoot>'
    + '</table>';

  if (expiryDate) {
    html += '<p style="font-size:11px;color:var(--atl-muted);margin-top:8px;">Expires: ' + expiryDate + '</p>';
  }
  return html;
}
```

---

### 3L. INTERNAL NOTES PANEL

**Position:** Right column, fourth card.

```html
<div class="atl-det-card">
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;gap:8px;">
    <h5 class="atl-det-title" style="margin:0;">Internal notes</h5>
    <button type="button" class="bk-notes-load-btn atl-btn atl-btn--ghost"
            data-id="${row.id}"
            style="font-size:10px;padding:8px 12px;white-space:nowrap;min-height:36px;">
      <i class="fa-solid fa-rotate" style="margin-right:4px;"></i>Load
    </button>
  </div>
  <div class="bk-notes-thread" id="notes-thread-${row.id}"
       style="max-height:180px;overflow-y:auto;
              background:var(--atl-input-bg);
              border:1px solid var(--atl-line);
              border-radius:8px;
              padding:10px;
              margin-bottom:10px;
              font-family:'Outfit',sans-serif;
              font-size:12px;
              line-height:1.5;
              color:var(--atl-muted);
              display:none;
              -webkit-overflow-scrolling:touch;">
    No notes yet.
  </div>
  <div style="display:flex;gap:8px;align-items:flex-end;">
    <textarea class="bk-note-input" id="note-input-${row.id}" rows="2"
              style="flex:1;
                     background:var(--atl-input-bg);
                     border:1px solid var(--atl-line);
                     color:var(--atl-ink);
                     border-radius:8px;
                     padding:10px;
                     font-family:'Outfit',sans-serif;
                     font-size:12px;
                     line-height:1.4;
                     resize:vertical;
                     min-height:80px;"
              placeholder="Add a private note…"></textarea>
    <button type="button" class="bk-add-note-btn atl-btn"
            data-id="${row.id}"
            style="background:rgba(212,175,55,0.10);
                   border:1px solid rgba(212,175,55,0.35);
                   color:var(--atl-amber);
                   border-radius:8px;
                   padding:10px 14px;
                   min-height:44px;
                   white-space:nowrap;
                   font-size:12px;
                   font-weight:600;
                   display:flex;
                   align-items:center;
                   gap:6px;
                   cursor:pointer;
                   transition:background 0.15s ease;
                   flex-shrink:0;">
      <i class="fa-solid fa-plus"></i> Add
    </button>
  </div>
</div>
```

All `.bk-notes-load-btn`, `.bk-note-input`, `.bk-add-note-btn` JS event handlers remain unchanged.

---

### 3M. LINE ITEMS PANEL — with responsive table and `data-label`

**Position:** Right column, fifth card (lazy-loaded).

```javascript
if (d.line_items && d.line_items.length) {
  var liRows = d.line_items.map(function(li) {
    var qty  = li.quantity_minutes || li.quantity || 0;
    var unit = parseFloat(li.unit_price);
    var tot  = parseFloat(li.total_price || unit * qty);
    return '<tr>'
      + '<td data-label="Service">'      + (li.service_name || li.description || '—') + '</td>'
      + '<td data-label="Qty" class="right atl-det-tabular">'   + qty + ' ' + (li.display_unit || 'min') + '</td>'
      + '<td data-label="Unit" class="right atl-det-tabular">R ' + unit.toFixed(2) + '</td>'
      + '<td data-label="Total" class="right atl-det-tabular" style="font-weight:700;">R ' + tot.toFixed(2) + '</td>'
      + '</tr>';
  }).join('');

  lineItemsHtml =
    '<div class="atl-det-card">'
    + '<h5 class="atl-det-title">Line items</h5>'
    + '<div class="atl-det-table-wrap">'
    + '<table class="atl-det-table atl-det-table-responsive">'
    + '<thead><tr>'
    + '<th>Service</th>'
    + '<th class="right">Qty</th>'
    + '<th class="right">Unit</th>'
    + '<th class="right">Total</th>'
    + '</tr></thead>'
    + '<tbody>' + liRows + '</tbody>'
    + '</table></div></div>';
}
```

---

### 3N. TRANSACTIONS PANEL — with responsive table and `data-label`

**Position:** Right column, sixth card (lazy-loaded).

```javascript
if (d.transactions && d.transactions.length) {
  var txRows = d.transactions.map(function(t) {
    var isRefund = (t.transaction_type || '').toLowerCase() === 'refund';
    var sc = isRefund ? 'var(--atl-clay)'
           : t.status === 'completed' ? 'var(--atl-sage)'
           : t.status === 'failed'    ? 'var(--atl-clay)'
           : '#ff9800';
    var amtStyle  = isRefund ? 'color:var(--atl-clay);font-weight:700;' : 'font-weight:700;';
    var refundBadge = isRefund
      ? '<span style="font-size:9px;background:rgba(248,113,113,0.12);color:var(--atl-clay);'
        + 'padding:1px 5px;border-radius:3px;margin-right:4px;font-weight:700;">REFUND</span>'
      : '';
    var dateStr = t.transaction_date
      ? new Date(t.transaction_date).toLocaleDateString('en-ZA') : '—';
    return '<tr>'
      + '<td data-label="Date">' + dateStr + '</td>'
      + '<td data-label="Method">' + refundBadge + (t.payment_method || '—') + '</td>'
      + '<td data-label="Reference" style="font-size:11px;opacity:.75;">'
        + (t.reference || t.reference_number || '—') + '</td>'
      + '<td data-label="Amount" class="right atl-det-tabular" style="' + amtStyle + '">'
        + (isRefund ? '–' : '') + 'R ' + parseFloat(t.amount).toFixed(2) + '</td>'
      + '<td data-label="Status" style="color:' + sc + ';font-size:11px;">' + t.status + '</td>'
      + '</tr>';
  }).join('');

  transactionsHtml =
    '<div class="atl-det-card">'
    + '<h5 class="atl-det-title">Transactions</h5>'
    + '<div class="atl-det-table-wrap">'
    + '<table class="atl-det-table atl-det-table-responsive">'
    + '<thead><tr>'
    + '<th>Date</th><th>Method</th><th>Reference</th>'
    + '<th class="right">Amount</th><th>Status</th>'
    + '</tr></thead>'
    + '<tbody>' + txRows + '</tbody>'
    + '</table></div></div>';
} else {
  transactionsHtml =
    '<div class="atl-det-card">'
    + '<h5 class="atl-det-title">Transactions</h5>'
    + '<p class="atl-det-empty">No transactions recorded.</p>'
    + '</div>';
}
```

---

### 3O. QUOTE HISTORY PANEL — with responsive table and `data-label`

**Position:** Right column, seventh card (lazy-loaded, ≥2 versions only).

```javascript
if (history.length >= 2) {
  var histRows = history.map(function(q) {
    var active  = !q.archived;
    var qDate   = q.created_at ? new Date(q.created_at).toLocaleDateString('en-ZA') : '—';
    var pdfLink = q.pdf_url
      ? '<a href="' + q.pdf_url + '" target="_blank" rel="noopener" class="atl-det-link">View PDF</a>'
      : '—';
    var stHtml = active
      ? '<span style="color:var(--atl-sage);font-weight:600;">● Active</span>'
      : '<span style="color:var(--atl-muted);">Superseded</span>';
    return '<tr class="' + (active ? 'atl-det-active-row' : '') + '">'
      + '<td data-label="Version" style="color:' + (active ? 'var(--atl-amber)' : 'var(--atl-muted)') + ';">'
        + 'v' + q.version + (active ? ' ✦' : '') + '</td>'
      + '<td data-label="Date">' + qDate + '</td>'
      + '<td data-label="Total" class="right atl-det-tabular">R ' + parseFloat(q.total_amount||0).toFixed(2) + '</td>'
      + '<td data-label="Status">' + stHtml + '</td>'
      + '<td data-label="PDF">' + pdfLink + '</td>'
      + '</tr>';
  }).join('');

  historyHtml =
    '<div class="atl-det-card">'
    + '<h5 class="atl-det-title">Quote history</h5>'
    + '<div class="atl-det-table-wrap">'
    + '<table class="atl-det-table atl-det-table-responsive">'
    + '<thead><tr>'
    + '<th>Version</th><th>Date</th>'
    + '<th class="right">Total</th><th>Status</th><th>PDF</th>'
    + '</tr></thead>'
    + '<tbody>' + histRows + '</tbody>'
    + '</table></div></div>';
}
```

---

## SECTION 4: LAZY-LOAD INSERTION TARGETS

Replace the single `$det.html(...)` call with named placeholder divs populated individually.

**Pre-rendered placeholders in the card body:**

```html
<!-- Right column -->
<div id="atl-lineitems-${row.id}">
  <div class="atl-det-card">
    <h5 class="atl-det-title">Line items</h5>
    <div class="atl-det-loading">
      <span class="atl-spinner" aria-hidden="true"></span><span>Loading…</span>
    </div>
  </div>
</div>
<div id="atl-transactions-${row.id}">
  <div class="atl-det-card">
    <h5 class="atl-det-title">Transactions</h5>
    <div class="atl-det-loading">
      <span class="atl-spinner" aria-hidden="true"></span><span>Loading…</span>
    </div>
  </div>
</div>
<div id="atl-history-${row.id}"></div>

<!-- Left column -->
<div class="atl-det-card" id="atl-contract-${row.id}">
  <h5 class="atl-det-title">Contract</h5>
  <div class="atl-det-loading"><span class="atl-spinner" aria-hidden="true"></span><span>Loading…</span></div>
</div>
${s === 'CANCELLED' ? `<div class="atl-det-card atl-det-card--cancel" id="atl-cancel-${row.id}">
  <div class="atl-det-loading"><span class="atl-spinner" aria-hidden="true"></span><span>Loading cancellation details…</span></div>
</div>` : ''}
```

**In the `.then()` callback:**

```javascript
$('#atl-lineitems-'    + bookingId).html(lineItemsHtml   || emptyLineItemsHtml);
$('#atl-transactions-' + bookingId).html(transactionsHtml);
$('#atl-history-'      + bookingId).html(historyHtml     || '');
renderInlineContractPanel(bookingId, contract);
if (s === 'CANCELLED') renderInlineCancellationPanel(bookingId, d);
```

Remove the old `$det` / `#bkDetails-${id}` container.

---

## SECTION 5: REMOVE LEGACY CLASSES

After migration, stub out these `redesign.css` classes:

| Old class | Replaced by |
|---|---|
| `.bkr-card-body` | `.atl-det-grid` |
| `.bkr-info-grid`, `.bkr-info-block` | Removed |
| `.bkr-info-label` | `.atl-det-title` |
| `.bkr-info-row`, `.bkr-info-link` | Removed / `.atl-det-link` |
| `.bkr-ledger`, `.bkr-ledger-cell` | `.atl-det-dl` |
| `.bkr-venue-panel`, `.bkr-section-label`, `.bkr-venue-row` | `.atl-det-card` / `.atl-det-title` |
| `.bkr-message` | `.atl-det-card` with Cormorant italic paragraph |
| `.bkr-quote-panel`, `.bkr-quote-panel-header`, `.bkr-quote-label`, `.bkr-quote-total` | `.atl-det-card` / `.atl-det-title` / tfoot |
| `.bkr-details-area` | Named placeholder divs |
| `.bkr-admin-notes` | `.atl-det-card` |

Keep `.bkr-promote-panel` family as empty stubs until all references are confirmed migrated.

---

## SECTION 6: COMPLETE PANEL MAPPING TABLE

| admin.html current panel | New panel | Column | Data source |
|---|---|---|---|
| `bkr-info-block` Client | Client card | LEFT | `row.name/company/email/cell` |
| `bkr-info-block` Event | Event card | LEFT | `row.event_name/date/location/slot/duration/venue_type` |
| *(only in bookingInfoModal)* | Audience & Budget card | LEFT | `row.audience_size/demographic/budget_range/travel_accommodation` |
| `bkr-info-block` Ledger | Ledger card | LEFT | `row.payment_status/quote_amount/amount_paid/outstanding` |
| `bkr-venue-panel` | Venue card | LEFT | `row.venue_*` |
| `bkr-promote-panel` | Public Promotion card | LEFT | `row.is_public/ticket_link` |
| *(only via modal)* | Contract card (lazy-loaded) | LEFT | `/api/.../contract` |
| *(only via modal)* | Cancellation card (lazy-loaded) | LEFT | `d.cancellation` |
| `bkr-message` | Client message card | RIGHT | `row.message` |
| attachments inline fn | Attachments card | RIGHT | `row.attachment_files` |
| `bkr-quote-panel` | Quote card | RIGHT | `row.quote_amount/quote_details` |
| `bkr-admin-notes` | Internal notes card | RIGHT | (existing JS) |
| `bkr-details-area` line items | Line items card (lazy-loaded) | RIGHT | `d.line_items` |
| `bkr-details-area` transactions | Transactions card (lazy-loaded) | RIGHT | `d.transactions` |
| `bkr-details-area` quote history | Quote history card (lazy-loaded) | RIGHT | `history[]` |

---

## SECTION 7: VALIDATION CHECKLIST

Before submitting, verify every item in all four groups.

### Layout & visual fidelity
- [ ] `.atl-det-grid` is single column on mobile, two columns at ≥640px
- [ ] Left column: Client, Event, Audience & Budget (conditional), Ledger, Venue, Promotion (conditional), Contract, Cancellation (conditional)
- [ ] Right column: Client message (conditional), Attachments (conditional), Quote, Internal Notes, Line Items, Transactions, Quote History (conditional)
- [ ] No panels are missing for any booking status
- [ ] Every panel uses `var(--atl-surface2)`, `border-radius: 12px`, scaled padding
- [ ] Every panel title uses `.atl-det-title` (11px, uppercase, tracked, muted)
- [ ] All links use `var(--atl-amber)` with underline
- [ ] Ledger outstanding: sage (zero) / clay (positive)
- [ ] Budget range: gold (`atl-det-gold`)
- [ ] Contract: draft = muted, sent = amber, signed = sage
- [ ] Cancellation panel: clay-tinted with 3px left border
- [ ] Client message: Cormorant Garamond italic with typographic quotes
- [ ] Quote total row: amber, bold, 14px
- [ ] Active quote history row: subtle gold tint

### Responsive & mobile
- [ ] No horizontal scrolling on any screen width
- [ ] No card overflow or content clipping on narrow screens
- [ ] Tables transform to stacked label-value rows on screens ≤599px
- [ ] Every `<td>` in every table has a `data-label` attribute
- [ ] `tfoot` summary rows are readable on mobile (flex label + value pairs)
- [ ] `.atl-det-dl` stacks to single column on screens ≤359px
- [ ] Card padding scales from 14px (mobile) to 16px (tablet+)
- [ ] Grid gap scales from 12px (mobile) to 20px (desktop)
- [ ] Ultra-wide screens: grid max-width 1440px, centred
- [ ] Typography uses `clamp()` for scaling values (client message, venue name, body text)
- [ ] All interactive elements meet 44px minimum tap target height
- [ ] `.atl-switch` has extended pseudo-element hit area
- [ ] Actions dropdown is full-width on screens ≤479px
- [ ] Promotion panel wraps correctly when toggle button and label are side-by-side on narrow screens
- [ ] Client message `word-wrap: break-word` prevents overflow on long text
- [ ] Attachment file names have `word-break: break-all` fallback

### Functionality
- [ ] Venue link select populates and "Link" button saves via API
- [ ] Edit location form shows/hides and saves correctly
- [ ] Promotion toggle (`promote-toggle`) reads/sets `aria-checked` correctly and updates `is_public` via API
- [ ] Internal notes: Load button fetches, Add button submits
- [ ] Quote modal still opens from Actions dropdown and calculates totals correctly
- [ ] Contract modal still opens from Actions dropdown (upload / sign / download)
- [ ] Cancel modal still opens from Actions dropdown
- [ ] Delete and all Actions dropdown items work
- [ ] Lazy-load triggers once on expand, not on every toggle
- [ ] Line items, transactions, and quote history render with real data
- [ ] Contract inline panel populates from the lazy-load fetch
- [ ] Cancellation inline panel renders only when status is CANCELLED

### Themes
- [ ] All panels inherit dark/light theme correctly via CSS variables
- [ ] Cancellation card clay tint visible and readable in both themes
- [ ] Atelier switch animates correctly in both themes
- [ ] Responsive table stacked rows adapt to dark/light backgrounds
- [ ] Touch feedback `:active` states work in both themes

---

## SECTION 8: RESPONSIVE SUCCESS CRITERIA

The completed implementation is successful when a person using it on a phone, tablet, laptop, and desktop monitor each has this experience:

**On mobile (360–479px):** Cards stack vertically with comfortable 16px padding. All text is readable without zooming. Tables show as compact label-value mini-cards — no horizontal scroll, no text truncation. Buttons are large enough to tap comfortably. The promotion toggle has a generous hit area. The overall experience feels intentionally designed for mobile, not compressed from desktop.

**On tablet (640–1023px):** The two-column Atelier grid activates. Cards sit side-by-side with appropriate spacing. Tables display horizontally with scroll-safety on wider tables. The layout reflects the premium editorial quality of the Atelier reference design.

**On desktop (1280px+):** Full Atelier spacing rhythm. Cards breathe. The two-column grid mirrors the reference design exactly. The obsidian dark surface with gold accents creates the same premium feel as the `artist-booking-dashboard-obsidian.html` reference.

**On ultra-wide (1536px+):** Content does not stretch across the full viewport. The grid caps at 1440px and centres — preserving readability and the Atelier editorial aesthetic at extreme widths.

In all contexts: the expanded booking card must be visually indistinguishable from the Atelier `buildDetailHTML()` output, while preserving 100% of admin.html's existing booking management functionality.

---

*End of prompt.*
