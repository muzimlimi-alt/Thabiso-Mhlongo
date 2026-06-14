# AI Agent Prompt: Overhaul the Booking Section of admin.html to Match the Atelier Obsidian Design System

---

## NON-NEGOTIABLE RULES

These rules override everything else. If you are uncertain, stop and re-read them.

1. `artist-booking-dashboard-obsidian.html` is the **single source of visual truth**. Do not redesign independently.
2. This is a **styling and UX refactor only**. Do not change functionality under any circumstances.
3. Do not remove, rename, or modify any working JavaScript logic, event handlers, API calls, fetch requests, jQuery calls, database interactions, state management, form POST logic, or existing workflows.
4. Styling improvements must sit **on top of** current functionality, not replace it.
5. Do not make rushed global replacements. Work component by component. Validate after each phase.
6. All new CSS must be scoped to `#bookingsAdmin` or prefixed `atl-` to prevent conflicts with the rest of `admin.html`.
7. Do not add Tailwind CSS. Use plain CSS rules only.
8. Do not touch any section outside `#bookingsAdmin` — no login, sidebar, dashboard, calendar, events, inquiries, newsletter, or gallery.
9. The final system must support reliable Light and Dark Mode switching with no visual defects, broken contrast, or component drift.
10. Every phase must be internally validated before proceeding to the next.

---

## OBJECTIVE AND SCOPE

Transform the `#bookingsAdmin` section of `admin.html` so it is visually indistinguishable from the **Atelier Artist Booking Dashboard (Obsidian)** reference. The result should feel like the Atelier dashboard was professionally adapted onto the existing admin booking functionality — the same editorial-luxury aesthetic, the same design language, the same interactions — while 100% of the existing data flows, API calls, and business logic remains completely intact.

**In scope:** Everything inside `<div id="bookingsAdmin">` — HTML structure, CSS classes, inline styles, and the JavaScript that renders booking cards, status badges, filter pills, action buttons, and all modals.

**Out of scope:** Every other section of `admin.html`. All backend logic. All API endpoints. All database queries.

---

## DESIGN REFERENCE

The reference dashboard is a dark-mode, single-page booking CRM with the following character: **obsidian stage** — a near-black performance venue where content glows out of the darkness. It is refined, editorial, and high-contrast. Every surface is a shade of near-black or very dark grey. The single brand accent is antique gold (`#D4AF37`). Text is pure white. The overall impression is a premium CRM, never a generic admin panel.

---

## PHASED EXECUTION PLAN

Work through these phases in strict order. Do not begin a phase until the previous one is validated.

---

### PHASE 1 — DISCOVERY AND AUDIT

**Before making any changes**, inspect and analyse both files in full.

Produce an internal mapping report covering:

**From `admin.html` — identify every existing booking component:**
- Booking list container and card structure
- Status filter pills / pipeline bar
- Search input and payment dropdown
- Booking card header (collapsed state): reference ID, status badge, payment badge, event title, metadata line, submission age, tag badges, expand button
- Booking card body (expanded state): client panel, message panel, ledger panel, venue panel, public promotion panel, contract panel, notes panel, line items, transactions, quote history
- All action buttons and their current variants
- All modal types: their titles, fields, footer buttons
- Loading state and empty state markup
- All inline styles and hardcoded colour values to be replaced
- All Bootstrap classes and jQuery modal calls to be migrated

**From `artist-booking-dashboard-obsidian.html` — extract the design system:**
- Full CSS variable set and their exact values
- Font stack and per-element typography rules
- Surface depth system (paper → card → surface2 → input-bg)
- Status colour table for all six statuses
- Interaction patterns: hover, focus, expand/collapse, modal open/close
- Animation timings and easing curves
- Shadow and border values
- Responsive breakpoints and clamp() usage

Do not modify any code in Phase 1. Use the audit as the migration blueprint.

---

### PHASE 2 — STYLE ARCHITECTURE CONSOLIDATION

**Goal:** Build a clean, centralised design system before any visual changes.

Tasks:
1. Locate and catalogue all inline styles currently inside `#bookingsAdmin` and its JS rendering functions.
2. Identify all hardcoded colour values, duplicate spacing rules, inconsistent border radii, scattered shadow values, and conflicting class definitions.
3. Introduce the centralized CSS token system (detailed in the Implementation Reference below). Every colour, shadow, spacing value, and transition in the booking section must reference these tokens.
4. Do not change how anything looks yet — only prepare the architecture.

Validate: The booking section must look identical to before Phase 2. No visual changes.

---

### PHASE 3 — VISUAL FOUNDATION

**Goal:** The booking section should already feel like Atelier before component-level restyling begins.

Apply:
- The obsidian page background with radial gold glow
- The film grain texture overlay
- The Cormorant Garamond / Outfit / JetBrains Mono font stack
- The header layout with the "Booking Operations" gold label, display heading, subtitle, and gold gradient rule
- Base spacing rhythm and container padding

Validate: Readability, responsiveness, and that no functionality has changed.

---

### PHASE 4 — COMPONENT MIGRATION (booking section only)

Migrate components one at a time in this order. Validate after each group before moving on.

1. **Header** — gold label, Cormorant heading, subtitle, "New enquiry" button
2. **Status filter pills** — replace pipeline bar with Atelier pills
3. **Search and filter controls** — search input, payment select, clear button
4. **Result count and live region** — result count paragraph, screen-reader live region
5. **Booking card — collapsed state** — reference ID tag, status badge, payment badge, event title, metadata, submission age, tag badges, expand button
6. **Booking card — expanded state** — client panel, message panel, ledger panel, venue panel, promotion panel, contract panel
7. **Lazy-loaded detail panels** — line items table, transactions table, quote history, internal notes
8. **Action buttons and actions dropdown** — primary/ghost/danger variants, dropdown menu
9. **Loading and empty states** — spinner, no-bookings message, no-filter-results message
10. **All six modal types** — quote builder, record payment, cancel booking, contract, new enquiry, delete confirm

For each component: preserve all `id` attributes, `data-*` attributes, JS event listener hooks, and API wiring. Replace only the visual shell.

---

### PHASE 5 — BOOKING SECTION POLISH

Once all components are migrated, apply finish-level polish:

- Confirm card animation stagger (each card `animation-delay: index × 40ms`)
- Confirm expand/collapse smooth animation on every card
- Confirm pill active states respond instantly on click
- Confirm modal open/close animation and backdrop blur
- Confirm all hover states lift elements by 1px with `transform: translateY(-1px)`
- Confirm the gold gradient rule renders correctly under the header
- Confirm the submission-age warning (⚠, clay/red) triggers correctly for PENDING bookings ≥7 days old
- Confirm status dot + tint + text colour triplets are correct for all six statuses

---

### PHASE 6 — LIGHT/DARK THEME SYSTEM

Build a robust, token-driven theme system on top of the completed dark-mode implementation.

**Requirements:**

- Both themes use the **same design language** — light mode must feel like Atelier Light (warm ivory, deep gold, warm taupe), not a generic white admin panel.
- All colour values must be driven by CSS variables. No hardcoded colours in component styles.
- Theme is applied by setting `data-theme="dark"` or `data-theme="light"` on the `<html>` element.
- A pre-paint inline `<script>` in `<head>` applies the saved or system preference before first render, preventing a flash of the wrong theme.
- Theme preference is persisted to `localStorage`.
- A toggle button (accessible, `role="switch"`, keyboard-operable, sun/moon icons) is placed at the top of `#bookingsAdmin`. On click, it flips the theme, updates `aria-checked` and the visible label, persists to `localStorage`, announces the change via the live region, and re-renders the booking list so that JS-injected status colours update to their theme-appropriate values.

**Dark theme tokens** — see Section B of the Implementation Reference below.

**Light theme tokens** (`[data-theme="light"]`):

```css
[data-theme="light"] {
  color-scheme: light;
  --atl-paper:       #f7f4ee;               /* warm ivory page */
  --atl-card:        #ffffff;               /* clean card surface */
  --atl-surface2:    #f1ece1;               /* warm elevated panel */
  --atl-input-bg:    #fbf9f4;               /* soft inset for form controls */
  --atl-ink:         #1c1a16;               /* near-black warm text */
  --atl-muted:       #6b6457;               /* secondary text */
  --atl-placeholder: #9b9384;
  --atl-line:        rgba(28,26,22,0.14);

  --atl-amber:       #9a7611;               /* deeper gold for AA contrast on light */
  --atl-amber-hover: #7e6109;
  --atl-amber-light: #c79a2a;
  --atl-on-amber:    #ffffff;               /* white text on the deeper gold fill */

  --atl-sage:        #1f9254;               /* darkened for contrast on light */
  --atl-clay:        #c0362c;
  --atl-blue:        #1d4ed8;
  --atl-green:       #0f7a45;
  --atl-focus:       #9a7611;

  --atl-shadow-card:  0 8px 30px rgba(40,36,28,0.12);
  --atl-shadow-modal: 0 24px 70px rgba(40,36,28,0.22), 0 0 0 1px rgba(154,118,17,0.18);
  --atl-overlay:      rgba(40,36,28,0.45);
  --atl-selection-bg: rgba(154,118,17,0.22);

  --atl-grain-opacity: 0.025;               /* grain is more visible on light; reduce it */
}
```

**Status colour variants for light theme** (used by the JS `statusColors()` resolver):

| Status | Light text/dot | Light tint |
|---|---|---|
| PENDING | `#8a6a0d` | `rgba(154,118,17,0.14)` |
| QUOTED | `#8a6a0d` | `rgba(154,118,17,0.16)` |
| ACCEPTED | `#1d4ed8` | `rgba(37,99,235,0.12)` |
| CONFIRMED | `#0f7a45` | `rgba(15,122,69,0.12)` |
| COMPLETED | `#15803d` | `rgba(21,128,61,0.12)` |
| CANCELLED | `#b91c1c` | `rgba(185,28,28,0.10)` |

**Toggle controller logic (vanilla JS):**

```javascript
(function () {
  const html  = document.documentElement;
  const btn   = document.getElementById('atlThemeToggle');
  const label = document.getElementById('atlThemeToggleLabel');

  function currentTheme() {
    return html.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  }

  function syncUI(theme) {
    const isLight = theme === 'light';
    btn.setAttribute('aria-checked', String(isLight));
    label.textContent = isLight ? 'Light' : 'Dark';
  }

  function applyTheme(theme, opts) {
    opts = opts || {};
    html.setAttribute('data-theme', theme);
    syncUI(theme);
    if (opts.persist !== false) {
      try { localStorage.setItem('atl-theme', theme); } catch(e) {}
    }
    // Re-render booking list so JS-injected status colours update
    if (typeof renderBookings === 'function') renderBookings();
    else if (typeof loadBookings === 'function') loadBookings();
    if (opts.announce !== false && typeof atlAnnounce === 'function') {
      atlAnnounce(theme === 'light' ? 'Light theme enabled.' : 'Dark theme enabled.');
    }
  }

  syncUI(currentTheme());

  btn.addEventListener('click', function () {
    applyTheme(currentTheme() === 'light' ? 'dark' : 'light');
  });

  // Follow OS changes if user has no saved preference
  if (window.matchMedia) {
    var mq = window.matchMedia('(prefers-color-scheme: light)');
    var onChange = function(e) {
      var saved = null;
      try { saved = localStorage.getItem('atl-theme'); } catch(ex) {}
      if (!saved) applyTheme(e.matches ? 'light' : 'dark', { persist: false });
    };
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else if (mq.addListener) mq.addListener(onChange);
  }
})();
```

**Pre-paint theme init** (place inline in `<head>`, before any stylesheet):

```html
<script>
  (function(){
    try {
      var s = localStorage.getItem('atl-theme');
      var t = s || (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
      document.documentElement.setAttribute('data-theme', t);
    } catch(e) {
      document.documentElement.setAttribute('data-theme', 'dark');
    }
  })();
</script>
```

Validate: Toggle works, no flash on reload, all components inherit correct colours in both themes, status badges re-render correctly after a theme switch.

---

### PHASE 7 — UX AND ACCESSIBILITY POLISH

Apply Atelier-level finish:

1. **Focus states** — Every interactive element has a visible 3px gold focus ring (see Section O of the Implementation Reference). Test keyboard navigation through the entire booking section.
2. **Hover and motion** — Subtle `translateY(-1px)` lifts on buttons and pills. No excessive animation. All transitions ≤0.3s.
3. **Reduced motion** — `@media (prefers-reduced-motion: reduce)` disables animations and caps transitions at 0.3s.
4. **ARIA attributes** — Pills have `aria-pressed`, expand buttons have `aria-expanded`/`aria-controls`, modals have `role="dialog"`/`aria-modal`/`aria-labelledby`, required fields have `aria-required="true"`, validation errors have `role="alert"`.
5. **Contrast check** — Verify all text/background combinations meet WCAG AA (4.5:1 for normal text, 3:1 for large text) in both dark and light modes.
6. **Mobile** — Pills scroll horizontally on narrow screens (`overflow-x: auto`). All grids collapse to single-column below 640px. Font sizes use `clamp()`.

---

### PHASE 8 — FINAL QA

Before declaring completion, run this checklist in full.

**VISUAL**
- [ ] Booking section matches Atelier Obsidian aesthetic end-to-end
- [ ] Consistent spacing, no mixed design systems, no remnant Bootstrap visual patterns
- [ ] No unfinished or partially-migrated components
- [ ] Film grain, radial glow, and gold gradient rule are present
- [ ] All six status colours render correctly in both themes
- [ ] Tag badges (Promoted/Invoice/Venue linked) render in gold
- [ ] Card hover lifts with gold border glow
- [ ] Submission age warning (⚠, red) fires for PENDING ≥7 days

**THEMES**
- [ ] Dark mode is visually stable — all components readable
- [ ] Light mode is visually stable — warm ivory, not white-admin
- [ ] Theme toggle button works and persists across page reloads
- [ ] No flash of wrong theme on reload
- [ ] JS-injected status colours (badges, pills) update correctly after theme switch
- [ ] No contrast failures in either mode

**FUNCTIONALITY — verify none of these broke:**
- [ ] `loadBookings()` / `renderBookings()` still fetch and display real data
- [ ] Status filter pills correctly filter the booking list
- [ ] Payment dropdown filter works
- [ ] Search input filters in real time
- [ ] Booking card expands and collapses correctly
- [ ] Lazy-loaded detail panels (line items, transactions, quote history) load on expand
- [ ] Internal notes load and can be submitted
- [ ] All six modal types open and close correctly
- [ ] Quote builder: line items add/remove, totals calculate, form submits to API
- [ ] Payment recording: pre-fills outstanding amount, submits to API
- [ ] Booking cancellation: validates required fields, submits to API
- [ ] Contract panel: state transitions (draft → sent → signed) work
- [ ] New enquiry modal: validates required fields, creates real booking record
- [ ] Delete confirm: removes booking from list on confirmation
- [ ] "Promote" toggle updates `is_public` via API
- [ ] Venue link select + button saves correctly
- [ ] All action buttons trigger correct API calls
- [ ] Escape key closes modals
- [ ] Clicking modal backdrop closes modal
- [ ] Focus returns to trigger element on modal close

**CODE QUALITY**
- [ ] No hardcoded colour values outside the token system
- [ ] No inline styles left except where dynamically applied by JS (e.g. status-specific colours)
- [ ] All new CSS is under `#bookingsAdmin` scope or prefixed `atl-`
- [ ] No Bootstrap classes remain on new elements (legacy ones that are JS-wired may stay)
- [ ] Code is clean, readable, and maintainable

---

## IMPLEMENTATION REFERENCE

The sections below are the exact specifications for every visual element. These are the ground truth for what each component must look like. Use them throughout Phases 3–7.

---

### SECTION A: COMPLETE CSS VARIABLE SYSTEM (DARK MODE DEFAULT)

Scope under `:root` or `[data-theme="dark"]`. All colours in the booking section must reference these tokens.

```css
:root,
[data-theme="dark"] {
  color-scheme: dark;

  /* Surfaces */
  --atl-paper:       #0a0a0a;              /* page / section background */
  --atl-card:        #1a1a1a;              /* booking card background */
  --atl-surface2:    #242424;              /* elevated panels inside cards */
  --atl-input-bg:    #0f0f0f;              /* form control inset background */

  /* Text */
  --atl-ink:         #ffffff;
  --atl-muted:       #949494;
  --atl-placeholder: #777777;

  /* Borders */
  --atl-line:        rgba(255,255,255,0.12);

  /* Brand — Gold */
  --atl-amber:       #D4AF37;
  --atl-amber-hover: #E8C14B;
  --atl-amber-light: #F4E4B5;
  --atl-on-amber:    #0a0a0a;              /* dark text on a gold fill */

  /* Semantic */
  --atl-sage:        #4ade80;              /* success / positive / paid */
  --atl-clay:        #f87171;              /* danger / negative / cancelled */
  --atl-blue:        #60a5fa;              /* accepted status */
  --atl-green:       #34d399;              /* confirmed status */

  /* Focus ring */
  --atl-focus:       #E8C14B;

  /* Shadows */
  --atl-shadow-card:  0 8px 40px rgba(0,0,0,0.40);
  --atl-shadow-modal: 0 24px 80px rgba(0,0,0,0.70), 0 0 0 1px rgba(212,175,55,0.15);
  --atl-overlay:      rgba(0,0,0,0.72);

  /* Selection */
  --atl-selection-bg: rgba(212,175,55,0.30);

  /* Grain */
  --atl-grain-opacity: 0.04;
}
```

The light theme token block is defined in Phase 6 above.

---

### SECTION B: TYPOGRAPHY

Load these Google Fonts if not already present in the page:

```html
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,500;0,600;0,700;1,400;1,500&family=Outfit:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
```

Font assignments inside the booking section:

| Element | Font | Weight | Notes |
|---|---|---|---|
| Section heading "Event Bookings" | Cormorant Garamond | 500 | `clamp(40px, 6vw, 56px)`, `letter-spacing: -0.01em` |
| Booking event title on each card | Cormorant Garamond | 500 | `clamp(22px, 3.5vw, 30px)`, `line-height: 1.1` |
| All body copy, labels, metadata, buttons | Outfit | 400–600 | `font-size: 13px` standard |
| Reference IDs, count chips, uppercase tags | JetBrains Mono | 400 | `font-size: 11px` |
| "Booking Operations" overline label | Outfit | 600 | `11px`, `letter-spacing: 0.25em`, uppercase, `var(--atl-amber)` |

---

### SECTION C: SECTION BACKGROUND, HEADER AND TEXTURE

**Background:**
```css
#bookingsAdmin {
  background-color: var(--atl-paper);
  background-image:
    radial-gradient(circle at 15% 10%, rgba(212,175,55,0.07), transparent 42%),
    radial-gradient(circle at 85% 85%, rgba(212,175,55,0.04), transparent 48%);
  transition: background-color 0.4s ease;
  position: relative;
}
```

**Film grain overlay** (`<div class="atl-grain" aria-hidden="true">` first child of `#bookingsAdmin`):
```css
.atl-grain {
  pointer-events: none;
  position: absolute;
  inset: 0;
  z-index: 0;
  opacity: var(--atl-grain-opacity);
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='3'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
}
```

**Header layout:**
```
┌────────────────────────────────────────────────────────┐
│  [gold overline] "Booking Operations"                  │
│  [display heading] "Event Bookings"    [＋ New enquiry] │
│  [subtitle, muted] "Manage bookings from first…"       │
├────────────────────────────────────────────────────────┤
│  [gold gradient rule — fades right to transparent]     │
└────────────────────────────────────────────────────────┘
```

Gold gradient rule:
```css
.atl-header-rule {
  height: 1px;
  margin-top: 24px;
  background: linear-gradient(to right, var(--atl-amber), rgba(212,175,55,0.15) 40%, transparent);
}
```

---

### SECTION D: NEW ENQUIRY BUTTON

```css
.atl-new-btn {
  padding: 10px 20px;
  font-family: 'Outfit', sans-serif;
  font-size: 14px;
  font-weight: 600;
  border-radius: 8px;
  border: none;
  background: var(--atl-amber);
  color: var(--atl-on-amber);
  cursor: pointer;
  flex-shrink: 0;
  transition: background 0.2s ease, transform 0.15s ease;
}
.atl-new-btn:hover {
  background: var(--atl-amber-hover);
  transform: translateY(-1px);
}
```

Label: `＋ New enquiry`

---

### SECTION E: STATUS/PIPELINE FILTER PILLS

Clickable toggle buttons. Active pill (`aria-pressed="true"`) uses its status colour for border, text, and tinted background. Inactive pill uses card background with default border.

**Base pill:**
```css
.atl-pill {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  border-radius: 12px;
  font-family: 'Outfit', sans-serif;
  font-size: 13px;
  font-weight: 600;
  border: 1px solid var(--atl-line);
  background: var(--atl-card);
  color: var(--atl-ink);
  cursor: pointer;
  user-select: none;
  transition: border-color 0.2s ease, background 0.2s ease, transform 0.15s ease;
}
.atl-pill:hover { transform: translateY(-1px); }

.atl-pill-dot {
  width: 9px; height: 9px;
  border-radius: 50%;
  display: inline-block;
  flex-shrink: 0;
}

.atl-pill-count {
  padding: 2px 6px;
  border-radius: 5px;
  font-size: 11px;
  background: rgba(0,0,0,0.35);   /* use var(--atl-chip-bg) in light theme */
  color: var(--atl-muted);
}
```

**Dark theme status colour table:**

| Status | Colour | Tint background |
|---|---|---|
| PENDING | `#D4AF37` | `rgba(212,175,55,0.14)` |
| QUOTED | `#E8C14B` | `rgba(232,193,75,0.14)` |
| ACCEPTED | `#60a5fa` | `rgba(96,165,250,0.16)` |
| CONFIRMED | `#34d399` | `rgba(52,211,153,0.16)` |
| COMPLETED | `#4ade80` | `rgba(74,222,128,0.16)` |
| CANCELLED | `#f87171` | `rgba(248,113,113,0.16)` |

Use a `statusColors(statusKey)` JS helper that reads `document.documentElement.getAttribute('data-theme')` and returns either the dark or light colour pair (from the light table in Phase 6), so status colours adapt when the theme switches.

---

### SECTION F: FILTER CONTROLS

**Search input:**
```css
.atl-search {
  background: var(--atl-input-bg);
  border: 1px solid var(--atl-line);
  border-radius: 8px;
  padding: 8px 12px;
  font-family: 'Outfit', sans-serif;
  font-size: 13px;
  color: var(--atl-ink);
  min-width: 220px;
  transition: border-color 0.2s ease;
}
.atl-search:focus { outline: 3px solid var(--atl-focus); border-color: var(--atl-amber); }
.atl-search::placeholder { color: var(--atl-placeholder); }
```

**Payment filter select:**
```css
.atl-filter-select {
  background: var(--atl-card);
  border: 1px solid var(--atl-line);
  border-radius: 8px;
  padding: 8px 12px;
  font-family: 'Outfit', sans-serif;
  font-size: 13px;
  color: var(--atl-ink);
  cursor: pointer;
  min-width: 180px;
}
.atl-filter-select option { background: var(--atl-card); color: var(--atl-ink); }
```

**Clear filters button:**
```css
.atl-clear-btn {
  padding: 8px 16px;
  border: 1px solid var(--atl-line);
  border-radius: 8px;
  background: transparent;
  color: var(--atl-ink);
  font-family: 'Outfit', sans-serif;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: border-color 0.2s ease;
}
.atl-clear-btn:hover { border-color: var(--atl-amber); }
```

---

### SECTION G: BOOKING CARD — COLLAPSED STATE

```css
.atl-booking-card {
  border-radius: 16px;
  border: 1px solid var(--atl-line);
  background: var(--atl-card);
  overflow: hidden;
  transition: border-color 0.3s ease, box-shadow 0.3s ease, background-color 0.4s ease;
  animation: atl-card-in 0.4s ease backwards;
}
.atl-booking-card:hover {
  border-color: rgba(212,175,55,0.35);
  box-shadow: var(--atl-shadow-card);
}
@keyframes atl-card-in {
  from { opacity: 0; transform: translateY(10px); }
  to   { opacity: 1; transform: none; }
}
/* Stagger: each card gets animation-delay: index * 40ms */
```

**Booking reference ID tag:**
```css
.atl-booking-id {
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 5px;
  background: var(--atl-surface2);
  color: var(--atl-muted);
}
```

**Status badge** (background and color set dynamically from status table):
```css
.atl-status-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: 999px;
  font-family: 'Outfit', sans-serif;
  font-size: 11px;
  font-weight: 600;
  /* background: [status tint]; color: [status colour] — set in JS */
}
/* Contains a 9×9px filled circle dot: <span class="atl-pill-dot" style="background:[status colour]"> */
```

**Payment badge:**
```css
.atl-payment-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  border: 1px solid var(--atl-line);
  color: var(--atl-muted);
}
/* Icon prefix: ✓ PAID  ✕ FAILED  ◐ DEPOSIT_PAID  ○ UNPAID */
```

**Tag badges** (Promoted ★ / Venue linked ⌖ / Invoice ▤):
```css
.atl-tag-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  background: var(--atl-amber);
  color: var(--atl-on-amber);
}
```

**Event title:**
```css
.atl-event-title {
  font-family: 'Cormorant Garamond', Georgia, serif;
  font-size: clamp(22px, 3.5vw, 30px);
  font-weight: 500;
  line-height: 1.1;
  color: var(--atl-ink);
  margin: 4px 0;
}
```

**Expand/collapse button:**
```css
.atl-expand-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  border: 1px solid var(--atl-line);
  border-radius: 8px;
  background: transparent;
  color: var(--atl-ink);
  font-family: 'Outfit', sans-serif;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  flex-shrink: 0;
}
.atl-expand-btn .atl-chevron { transition: transform 0.3s ease; }
.atl-expand-btn[aria-expanded="true"] .atl-chevron { transform: rotate(180deg); }
```

Label changes: collapsed = `Details ∨`, expanded = `Hide ∧`.

---

### SECTION H: BOOKING CARD — EXPANDED DETAIL PANEL

**Expand/collapse animation:**
```css
.atl-detail-region {
  overflow: hidden;
  max-height: 0;
  transition: max-height 0.35s cubic-bezier(0.4,0,0.2,1);
}
.atl-detail-region.open { max-height: 4000px; }
```

Inner content has `padding: 24px`, `border-top: 1px solid var(--atl-line)`.

**Panel label (used by all sub-panels):**
```css
.atl-panel-label {
  font-family: 'Outfit', sans-serif;
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--atl-muted);
  margin-bottom: 10px;
}
```

**Sub-panel container (client, ledger, venue, promotion, contract):**
```css
.atl-sub-panel {
  background: var(--atl-surface2);
  border-radius: 12px;
  padding: 16px;
  transition: background-color 0.4s ease;
}
```

**Client panel:** Client name bold (`font-weight: 600`). Email and phone as anchor links: `color: var(--atl-amber); text-decoration: none; font-size: 13px`.

**Client message:** Italic, Cormorant Garamond, 15px, with typographic quotation marks.

**Ledger panel row values:**
- Payment status — coloured by its payment status
- Quoted total, Paid — `var(--atl-ink)`
- Outstanding — `var(--atl-sage)` if zero; `var(--atl-clay)` if positive

**Venue panel** — contains a `<select>` using `.atl-filter-select` styles and a gold **Link** button using `.atl-btn--primary` styles.

**Public promotion panel** — contains the `.atl-switch` toggle (see Section J below).

**Contract panel** states:
- Draft → "Status: Draft" + "Send to client" gold button
- Sent → "Status: **Sent to client**" (`color: var(--atl-amber)`) + "Mark signed" gold button
- Signed → "Status: **Signed ✓**" (`color: var(--atl-sage)`) + signer name + date

---

### SECTION I: TOGGLE SWITCH (promotion panel, VAT in quote modal)

```css
.atl-switch {
  position: relative; width: 52px; height: 28px;
  border-radius: 999px;
  background: var(--atl-line);
  border: 1px solid var(--atl-line);
  cursor: pointer;
  flex-shrink: 0;
  transition: background 0.2s ease;
}
.atl-switch[aria-checked="true"] { background: var(--atl-sage); }
.atl-switch::after {
  content: "";
  position: absolute; top: 2px; left: 2px;
  width: 22px; height: 22px;
  border-radius: 999px;
  background: #fff;
  box-shadow: 0 1px 3px rgba(0,0,0,.3);
  transition: transform 0.2s ease;
}
.atl-switch[aria-checked="true"]::after { transform: translateX(24px); }
```

---

### SECTION J: ACTION BUTTONS SYSTEM

**Base:**
```css
.atl-btn {
  padding: 6px 12px;
  font-family: 'Outfit', sans-serif;
  font-size: 12px;
  font-weight: 600;
  border-radius: 8px;
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.2s ease;
}
.atl-btn:hover { transform: translateY(-1px); }
```

**Three variants:**
```css
/* PRIMARY — gold fill */
.atl-btn--primary {
  background: var(--atl-amber);
  color: var(--atl-on-amber);
  border: 1px solid var(--atl-amber);
}
.atl-btn--primary:hover { background: var(--atl-amber-hover); }

/* GHOST — transparent with border */
.atl-btn--ghost {
  background: transparent;
  color: var(--atl-ink);
  border: 1px solid var(--atl-line);
}
.atl-btn--ghost:hover { border-color: var(--atl-amber); }

/* DANGER — transparent with red border and text */
.atl-btn--danger {
  background: transparent;
  color: var(--atl-clay);
  border: 1px solid var(--atl-clay);
}
.atl-btn--danger:hover { background: rgba(248,113,113,0.08); }
```

**Status-to-action mapping:**

| Status | Primary button | Ghost buttons | Danger buttons |
|---|---|---|---|
| PENDING | Send quote | Contract, Full details | Cancel, Delete |
| QUOTED | Accept booking | Contract, Full details | Cancel, Delete |
| ACCEPTED | Confirm | Record payment, Contract, Full details | Cancel, Delete |
| CONFIRMED | Mark complete | Record payment, Contract, Full details | Cancel, Delete |
| COMPLETED | Generate invoice (if none yet) | Contract, Full details | Delete |
| CANCELLED | Generate invoice (if applicable) | Contract, Full details | Delete |

**Actions dropdown button:**
```css
.atl-actions-dropdown-btn {
  background: rgba(255,255,255,0.06);
  border: 1px solid var(--atl-line);
  color: var(--atl-muted);
  border-radius: 8px;
  padding: 6px 12px;
  font-size: 12px;
  cursor: pointer;
}
```

**Dropdown panel:**
```css
.atl-actions-dropdown-panel {
  position: fixed;
  z-index: 99999;
  background: var(--atl-card);
  border: 1px solid rgba(255,255,255,0.15);
  border-radius: 10px;
  padding: 6px 0;
  min-width: 200px;
  box-shadow: 0 8px 32px rgba(0,0,0,0.7);
}
.atl-actions-dropdown-item {
  display: flex; align-items: center; gap: 10px;
  width: 100%; background: none; border: none;
  color: var(--atl-ink);
  padding: 9px 16px;
  font-size: 13px; font-family: 'Outfit', sans-serif;
  cursor: pointer; text-align: left;
  transition: background 0.15s ease;
}
.atl-actions-dropdown-item:hover { background: rgba(255,255,255,0.06); }
.atl-actions-dropdown-item--danger { color: var(--atl-clay); }
.atl-actions-dropdown-sep { height: 1px; background: var(--atl-line); margin: 4px 0; }
```

---

### SECTION K: MODAL SYSTEM

Replace all Bootstrap `$('#...').modal('show')` calls with a vanilla JS modal function.

**Open/close functions:**
```javascript
function openAtelierModal(html) {
  var lastFocused = document.activeElement;
  var root = document.getElementById('atlModalRoot');
  root.innerHTML = '<div class="atl-modal-overlay" role="presentation">' + html + '</div>';
  var overlay = root.querySelector('.atl-modal-overlay');
  var panel   = overlay.querySelector('[role="dialog"]');
  var focusables = function() {
    return panel.querySelectorAll('button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])');
  };
  var f = focusables();
  if (f.length) f[0].focus();
  overlay.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') { closeAtelierModal(); return; }
    if (e.key === 'Tab') {
      var els = Array.from(focusables()).filter(function(el){ return !el.disabled && el.offsetParent !== null; });
      if (!els.length) return;
      if (e.shiftKey && document.activeElement === els[0]) { e.preventDefault(); els[els.length-1].focus(); }
      else if (!e.shiftKey && document.activeElement === els[els.length-1]) { e.preventDefault(); els[0].focus(); }
    }
  });
  overlay.addEventListener('mousedown', function(e) {
    if (e.target === overlay) closeAtelierModal();
  });
  overlay._lastFocused = lastFocused;
}
function closeAtelierModal() {
  var root = document.getElementById('atlModalRoot');
  var overlay = root.querySelector('.atl-modal-overlay');
  var lf = overlay && overlay._lastFocused;
  root.innerHTML = '';
  if (lf && lf.focus) lf.focus();
}
```

Add `<div id="atlModalRoot"></div>` as the last child of `#bookingsAdmin`.

**Overlay:**
```css
.atl-modal-overlay {
  position: fixed; inset: 0; z-index: 9000;
  background: var(--atl-overlay);
  backdrop-filter: blur(4px);
  display: flex; align-items: flex-start; justify-content: center;
  padding: 5vh 16px; overflow-y: auto;
}
```

**Panel:**
```css
.atl-modal-panel {
  width: 100%; max-width: 680px;
  border-radius: 16px;
  background: var(--atl-card);
  box-shadow: var(--atl-shadow-modal);
  animation: atl-modal-in 0.25s cubic-bezier(0.2,0.8,0.2,1);
}
@keyframes atl-modal-in {
  from { opacity: 0; transform: translateY(16px) scale(0.98); }
  to   { opacity: 1; transform: none; }
}
```

**Header:** `border-bottom: 1px solid var(--atl-line)`, padding `20px`. Title in Cormorant Garamond 24px weight 600.

**Close button:**
```css
.atl-modal-close {
  padding: 8px; border-radius: 8px;
  background: transparent; border: none;
  color: var(--atl-ink); cursor: pointer;
  transition: background 0.15s ease;
}
.atl-modal-close:hover { background: rgba(255,255,255,0.08); }
```

Close button uses an inline SVG ✕ (20×20, `stroke="currentColor"`, `stroke-width="2.5"`).

**Body:** `padding: 20px`, `max-height: 60vh`, `overflow-y: auto`.

**Footer:** `border-top: 1px solid var(--atl-line)`, `padding: 20px`, buttons right-aligned.

**Form labels inside modals:**
```css
.atl-modal-label {
  display: block;
  font-family: 'Outfit', sans-serif;
  font-size: 11px; font-weight: 700;
  text-transform: uppercase; letter-spacing: 0.08em;
  color: var(--atl-muted);
  margin-bottom: 4px;
}
```

Required field asterisks: `color: var(--atl-clay)`.

**All form inputs/selects/textareas inside modals:**
```css
background: var(--atl-input-bg);
color: var(--atl-ink);
border: 1px solid var(--atl-line);
border-radius: 8px;
padding: 8px 12px;
font-family: 'Outfit', sans-serif;
font-size: 13px;
width: 100%;
transition: border-color 0.2s ease;
```

**Validation error:**
```css
.atl-field-error {
  font-family: 'Outfit', sans-serif;
  font-size: 12px; font-weight: 500;
  color: var(--atl-clay);
  margin-top: 4px;
}
```

---

### SECTION L: ALL SIX MODAL TYPES

Preserve all existing API calls inside each modal. Restyle only.

**L1 — Quote Builder Modal**
Title: "Send quote". Info panel at top (client + event, `var(--atl-surface2)` bg). Line-item editor with description/qty/price inputs and remove button. Quick-add select + Add primary button. Discount input. VAT toggle (`.atl-switch`). Expiry date. Payment terms textarea. Live totals panel: Subtotal, Discount, VAT (15%), Total (large, `var(--atl-amber)`). Footer: Cancel ghost + "Send quote" primary.

**L2 — Record Payment Modal**
Title: "Record payment". Amount input (pre-filled with outstanding). Payment status select. Reference input. Footer: Cancel ghost + "Record payment" primary.

**L3 — Cancel Booking Modal**
Title: "Cancel booking". Reason * / Cancelled by * / Refund amount / Notes textarea. Footer: Keep ghost + "Cancel booking" danger (red fill, near-black text).

**L4 — Contract Modal**
Title: "Contract". Three states: Draft (Send to client primary), Sent ("Sent to client" amber text + Mark signed primary), Signed (sage check + signer name + date).

**L5 — New Enquiry Modal**
Title: "New enquiry". Body intro: "Log a new enquiry. It enters the pipeline as a **Pending** booking, ready to quote." Fields: Client name *, Company (default "Freelance"), Email *, Phone ("+27 …"), Event name *, Event date * / Time / Location (three-column grid on desktop), Client message. Footer: Cancel ghost + "Create enquiry" primary. Client-side validation required.

**L6 — Delete Confirm Modal**
Title: "Delete booking". Body: "Permanently remove **[ID] — [Event name]** from records? This cannot be undone." Footer: Keep ghost + "Delete" danger.

---

### SECTION M: EMPTY AND LOADING STATES

**Loading:**
```html
<div class="atl-empty-state">
  <div class="atl-spinner"></div>
  <p class="atl-empty-mono">Fetching booking records…</p>
</div>
```
```css
.atl-spinner {
  width: 22px; height: 22px;
  border: 3px solid var(--atl-line);
  border-top-color: var(--atl-amber);
  border-radius: 50%;
  animation: atl-spin 0.7s linear infinite;
  margin: 0 auto;
}
@keyframes atl-spin { to { transform: rotate(360deg); } }
.atl-empty-mono {
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px; letter-spacing: 0.2em;
  text-transform: uppercase;
  color: var(--atl-muted); margin-top: 16px;
}
.atl-empty-state { text-align: center; padding: 80px 40px; }
```

**No bookings:**
```html
<div class="atl-empty-state">
  <p class="atl-empty-display">No bookings yet</p>
  <p class="atl-empty-sub">When enquiries come in, they will appear here.</p>
</div>
```
```css
.atl-empty-display {
  font-family: 'Cormorant Garamond', serif;
  font-size: 24px; font-style: italic;
  color: var(--atl-muted);
}
.atl-empty-sub { font-size: 13px; color: var(--atl-muted); margin-top: 8px; }
```

**No filter results:** Same structure, message "No bookings match these filters", sub "Try clearing the filters to see everything."

---

### SECTION N: FOCUS STATES, SELECTION, AND MISC

```css
/* Focus ring — all interactive elements */
#bookingsAdmin a:focus-visible,
#bookingsAdmin button:focus-visible,
#bookingsAdmin select:focus-visible,
#bookingsAdmin input:focus-visible,
#bookingsAdmin textarea:focus-visible,
#bookingsAdmin [role="switch"]:focus-visible {
  outline: 3px solid var(--atl-focus);
  outline-offset: 2px;
  border-radius: 4px;
}

/* Text selection */
#bookingsAdmin ::selection { background: var(--atl-selection-bg); color: var(--atl-ink); }

/* Screen-reader only utility */
.atl-sr-only {
  position: absolute; width: 1px; height: 1px;
  padding: 0; margin: -1px; overflow: hidden;
  clip: rect(0,0,0,0); white-space: nowrap; border: 0;
}

/* Reduced motion */
@media (prefers-reduced-motion: reduce) {
  #bookingsAdmin *, #bookingsAdmin *::before, #bookingsAdmin *::after {
    animation-duration: 0.01ms !important;
    animation-delay: 0s !important;
    transition-duration: 0.3s !important;
  }
}

/* Tables */
#bookingsAdmin table { border-collapse: collapse; }
```

**Result count paragraph:**
```html
<p id="atlResultCount" aria-live="polite"
   style="font-size:13px; color:var(--atl-muted); font-family:'Outfit', sans-serif;">
  6 of 6 bookings
</p>
```

**Live region for screen-reader announcements:**
```html
<div id="atlLiveRegion" class="atl-sr-only" role="status" aria-live="polite" aria-atomic="true"></div>
```

JS helper:
```javascript
function atlAnnounce(msg) {
  var el = document.getElementById('atlLiveRegion');
  if (el) el.textContent = msg;
}
```

---

### SECTION O: THEME TOGGLE BUTTON MARKUP

```html
<button id="atlThemeToggle" type="button" class="atl-theme-toggle"
        role="switch" aria-checked="false"
        aria-label="Switch between light and dark theme">
  <span id="atlThemeToggleLabel" class="atl-theme-toggle__label">Dark</span>
  <span class="atl-theme-toggle__track" aria-hidden="true">
    <!-- Sun icon (visible in light mode) -->
    <svg class="atl-toggle-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14">
      <circle cx="12" cy="12" r="4"/>
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>
    </svg>
    <!-- Moon icon (visible in dark mode) -->
    <svg class="atl-toggle-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
    </svg>
    <span class="atl-theme-toggle__knob"></span>
  </span>
</button>
```

```css
.atl-theme-toggle {
  display: inline-flex; align-items: center; gap: 10px;
  padding: 6px 8px 6px 14px;
  border: 1px solid var(--atl-line);
  border-radius: 999px;
  background: var(--atl-card);
  cursor: pointer;
  transition: border-color 0.2s ease, background-color 0.4s ease;
}
.atl-theme-toggle:hover { border-color: var(--atl-amber); }
.atl-theme-toggle__label {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px; letter-spacing: 0.18em; text-transform: uppercase;
  color: var(--atl-muted); user-select: none;
}
.atl-theme-toggle__track {
  position: relative; width: 54px; height: 28px;
  border-radius: 999px;
  background: var(--atl-surface2);
  border: 1px solid var(--atl-line);
  overflow: hidden;
}
.atl-toggle-sun, .atl-toggle-moon {
  position: absolute; top: 50%; transform: translateY(-50%);
  transition: opacity 0.3s ease;
}
.atl-toggle-sun  { left: 6px;  color: var(--atl-amber); opacity: 0; }
.atl-toggle-moon { right: 6px; color: var(--atl-muted); opacity: 1; }
[data-theme="light"] .atl-toggle-sun  { opacity: 1; }
[data-theme="light"] .atl-toggle-moon { opacity: 0; }
.atl-theme-toggle__knob {
  position: absolute; top: 2px; left: 2px;
  width: 22px; height: 22px; border-radius: 999px;
  background: var(--atl-amber);
  box-shadow: 0 1px 3px rgba(0,0,0,.3);
  transition: transform 0.28s cubic-bezier(0.34,1.4,0.5,1);
  z-index: 1;
}
[data-theme="dark"]  .atl-theme-toggle__knob { transform: translateX(26px); }
[data-theme="light"] .atl-theme-toggle__knob { transform: translateX(0); }
```

---

## BEFORE / AFTER SUMMARY

| Element | Current state | Target state |
|---|---|---|
| Background | Dark grey from admin theme | `#0a0a0a` near-black with gold radial glow and film grain |
| Section heading | Plain `<h2>` | Cormorant Garamond display heading with gold overline label |
| Card style | Bootstrap `.card` / `.bkr-card` | `atl-booking-card` rounded-2xl, hover gold border + shadow |
| Event title | Small bold text | Cormorant Garamond ~30px display heading |
| Reference ID | Plain text | JetBrains Mono monospace pill on `--atl-surface2` bg |
| Status badge | `.bkr-badge` coloured pill | Atelier tinted pill with colour dot + text in status colour |
| Payment badge | `.bkr-badge` | Border-only pill, muted text, icon prefix |
| Tag badges (Promoted etc.) | Custom gold badges | Gold-fill `.atl-tag-badge` rounded pill |
| Filter pills | `.bkr-pill` pipeline bar | `.atl-pill` with full active-state colour response |
| Search/filter controls | Bootstrap form controls | Inset dark inputs referencing CSS tokens |
| Action buttons | Bootstrap `.btn` / `.bkr-btn` | Three-variant `atl-btn` system (primary/ghost/danger) |
| Modals | Bootstrap `$().modal('show')` | Vanilla JS focus-trapped modals with blur backdrop |
| Form inputs in modals | Bootstrap `.form-control` | Atelier inset inputs with `--atl-input-bg` |
| Expand/collapse | Bootstrap collapse plugin | CSS `max-height` transition on `.atl-detail-region` |
| Loading/empty states | Generic spinner | Atelier gold spinner + Cormorant italic empty message |
| Theme support | Dark only | Dark + Light with instant toggle, no flash, token-driven |
| Focus rings | Browser default | 3px `--atl-focus` gold ring on all interactive elements |

---

*End of prompt. Execute all phases in strict sequence. Validate between phases. The visual result — in both dark and light mode — must be indistinguishable from the Atelier Artist Booking Dashboard Obsidian reference design.*
