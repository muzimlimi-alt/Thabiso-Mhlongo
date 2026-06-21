# AI Agent Prompt: Apply Atelier Obsidian Design System Across Entire admin.html

---

## NON-NEGOTIABLE RULES

1. This is a **styling pass only.** Every API call, fetch, jQuery handler, Bootstrap modal trigger (`$().modal('show')`), form submit handler, `switchTab()`, session management, and all business logic must remain byte-for-byte identical.
2. Do not rename or remove any `id`, `data-*`, event-listener class, or JS-wired attribute anywhere in the file.
3. `artist-booking-dashboard-obsidian.html` is the **single source of visual truth.** Do not invent styles. If in doubt, copy from the reference.
4. All colours must reference CSS variables — no hardcoded hex values in new or replaced CSS.
5. Mobile-first. All new CSS starts from the smallest viewport and scales up with `@media (min-width: ...)`.
6. Bootstrap 3 class names (`.form-control`, `.table`, `.modal-*`, `.btn`, `.nav-tabs`, etc.) that cannot be removed (because JS depends on them) must be **visually overridden** via targeted CSS rules. Do not remove them from HTML.
7. Work section by section. Validate each section visually before moving to the next. Do not run a global find-replace that could break adjacent styles.
8. The booking section (`#bookingsAdmin`) has already been styled by a previous pass. Do not regress it. Apply the same patterns globally.
9. The complete Light/Dark theme system (toggled via `data-theme` on `<html>`) must work on every element of the page, not just the booking section.
10. Every interactive element across the entire page must meet a minimum 44×44px tap target on mobile.

---

## OBJECTIVE

Transform every visible element of `admin.html` so the entire portal — from the login screen through every admin section — is visually unified with the **Atelier Obsidian aesthetic**: near-black surfaces, antique gold accents, Cormorant Garamond display type, Outfit body type, JetBrains Mono metadata type, consistent card elevation, consistent button variants, and premium editorial spacing.

The result must feel like a single cohesive product, not a collection of individually-styled sections. A user navigating from the Dashboard to Finance to Bookings to Settings should see the same design language throughout.

---

## SCOPE

**Every element of `admin.html` is in scope**, including:
- Login screen
- Sidebar navigation
- Admin control bar (top nav)
- All 20 admin sections (dashboardAdmin, usersAdmin, inquiriesAdmin, bookingsAdmin, calendarAdmin, financeAdmin, servicesAdmin, policiesAdmin, homeAdmin, aboutAdmin, careerAdmin, galleryAdmin, socialAdmin, eventsAdmin, contactAdmin, newsletterAdmin, preferencesAdmin, brandingAdmin, emailLogsAdmin, securityAdmin)
- All Bootstrap modals
- All form controls
- All tables
- All buttons
- All status badges
- All notifications
- All dropdowns
- All tabs

**Out of scope:** Any JavaScript logic, API calls, data binding, event handlers, or backend functionality.

---

## SECTION 1: GLOBAL CSS TOKEN SYSTEM

Place this token block in a `<style>` tag in `<head>`, before all other stylesheets. It extends the booking-section tokens already present to cover the full page.

```css
/* ================================================================
   ATELIER OBSIDIAN — GLOBAL DESIGN TOKENS
   All colours, shadows, radii, and transitions reference these.
   ================================================================ */

:root,
[data-theme="dark"] {
  color-scheme: dark;

  /* ── Surfaces ── */
  --atl-paper:      #0a0a0a;
  --atl-card:       #1a1a1a;
  --atl-surface2:   #242424;
  --atl-surface3:   #2e2e2e;   /* tertiary elevation — e.g. nested items */
  --atl-input-bg:   #0f0f0f;
  --atl-sidebar-bg: #111111;   /* sidebar is slightly lighter than pure black */
  --atl-topbar-bg:  #141414;   /* top nav sits above page content */

  /* ── Text ── */
  --atl-ink:         #ffffff;
  --atl-ink-dim:     #e0ddd6;  /* slightly warmer white for headings */
  --atl-muted:       #949494;
  --atl-muted-dim:   #666666;  /* very secondary text, footer labels */
  --atl-placeholder: #555555;

  /* ── Borders ── */
  --atl-line:        rgba(255,255,255,0.10);
  --atl-line-strong: rgba(255,255,255,0.18);

  /* ── Brand — Gold ── */
  --atl-amber:       #D4AF37;
  --atl-amber-hover: #E8C14B;
  --atl-amber-dim:   rgba(212,175,55,0.12);
  --atl-amber-border:rgba(212,175,55,0.30);
  --atl-on-amber:    #0a0a0a;

  /* ── Semantic ── */
  --atl-sage:        #4ade80;
  --atl-clay:        #f87171;
  --atl-blue:        #60a5fa;
  --atl-orange:      #fb923c;
  --atl-purple:      #c084fc;

  /* ── Focus ── */
  --atl-focus:       #E8C14B;

  /* ── Shadows ── */
  --atl-shadow-sm:    0 2px 8px rgba(0,0,0,0.35);
  --atl-shadow-card:  0 8px 32px rgba(0,0,0,0.45);
  --atl-shadow-modal: 0 24px 80px rgba(0,0,0,0.70), 0 0 0 1px rgba(212,175,55,0.15);
  --atl-shadow-top:   0 2px 12px rgba(0,0,0,0.55);

  /* ── Overlays ── */
  --atl-overlay:      rgba(0,0,0,0.72);
  --atl-selection-bg: rgba(212,175,55,0.28);
  --atl-grain-opacity: 0.04;

  /* ── Radius ── */
  --atl-r-sm:  6px;
  --atl-r-md:  10px;
  --atl-r-lg:  14px;
  --atl-r-xl:  18px;
  --atl-r-pill:999px;

  /* ── Transitions ── */
  --atl-t-fast:   0.15s ease;
  --atl-t-base:   0.2s ease;
  --atl-t-slow:   0.35s ease;

  /* ── Spacing scale ── */
  --atl-sp-xs:  4px;
  --atl-sp-sm:  8px;
  --atl-sp-md:  16px;
  --atl-sp-lg:  24px;
  --atl-sp-xl:  32px;
  --atl-sp-2xl: 48px;
}

[data-theme="light"] {
  color-scheme: light;
  --atl-paper:       #f7f4ee;
  --atl-card:        #ffffff;
  --atl-surface2:    #f1ece1;
  --atl-surface3:    #e8e2d6;
  --atl-input-bg:    #fbf9f4;
  --atl-sidebar-bg:  #1a1a1a;   /* sidebar stays dark in light theme */
  --atl-topbar-bg:   #ffffff;
  --atl-ink:         #1c1a16;
  --atl-ink-dim:     #2a2723;
  --atl-muted:       #6b6457;
  --atl-muted-dim:   #9b9384;
  --atl-placeholder: #9b9384;
  --atl-line:        rgba(28,26,22,0.12);
  --atl-line-strong: rgba(28,26,22,0.22);
  --atl-amber:       #9a7611;
  --atl-amber-hover: #7e6109;
  --atl-amber-dim:   rgba(154,118,17,0.10);
  --atl-amber-border:rgba(154,118,17,0.30);
  --atl-on-amber:    #ffffff;
  --atl-sage:        #1f9254;
  --atl-clay:        #c0362c;
  --atl-blue:        #1d4ed8;
  --atl-orange:      #c2410c;
  --atl-purple:      #7e22ce;
  --atl-focus:       #9a7611;
  --atl-shadow-sm:    0 2px 8px rgba(40,36,28,0.10);
  --atl-shadow-card:  0 8px 28px rgba(40,36,28,0.12);
  --atl-shadow-modal: 0 24px 70px rgba(40,36,28,0.22), 0 0 0 1px rgba(154,118,17,0.18);
  --atl-shadow-top:   0 2px 10px rgba(40,36,28,0.10);
  --atl-overlay:      rgba(40,36,28,0.45);
  --atl-selection-bg: rgba(154,118,17,0.20);
  --atl-grain-opacity: 0.025;
}
```

---

## SECTION 2: TYPOGRAPHY

Load these fonts in `<head>` if not already present:

```html
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,500;0,600;0,700;1,400;1,500;1,600&family=Outfit:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
```

### Global font assignments

```css
/* ── GLOBAL TYPOGRAPHY ───────────────────────────── */

html, body {
  font-family: 'Outfit', system-ui, sans-serif;
  font-size: 14px;
  line-height: 1.5;
  color: var(--atl-ink);
  background-color: var(--atl-paper);
  transition: background-color 0.4s ease, color 0.4s ease;
  -webkit-font-smoothing: antialiased;
}

/* All display headings use Cormorant Garamond */
h1, h2, h3, h4, h5, h6,
.admin-section > h2,
.admin-section-title,
.section-heading,
.db-card-header h3 {
  font-family: 'Cormorant Garamond', Georgia, serif;
  font-weight: 500;
  color: var(--atl-ink-dim);
  line-height: 1.1;
  letter-spacing: -0.01em;
}

/* Section page headings — large editorial display */
.atl-section-heading {
  font-family: 'Cormorant Garamond', Georgia, serif;
  font-size: clamp(28px, 5vw, 44px);
  font-weight: 500;
  color: var(--atl-ink-dim);
  letter-spacing: -0.01em;
  margin: 0 0 4px;
}

/* Section overline label — above the heading */
.atl-section-eyebrow {
  font-family: 'Outfit', sans-serif;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.25em;
  color: var(--atl-amber);
  margin-bottom: 8px;
}

/* Section subtitle — below the heading */
.atl-section-sub {
  font-family: 'Outfit', sans-serif;
  font-size: clamp(13px, 1.8vw, 15px);
  color: var(--atl-muted);
  margin: 4px 0 0;
}

/* JetBrains Mono for IDs, counts, codes, technical labels */
.atl-mono {
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  letter-spacing: 0.05em;
}

/* Text selection */
::selection { background: var(--atl-selection-bg); color: var(--atl-ink); }
```

### Replace all hardcoded inline `style="color:#888"` etc.

Wherever section heading text appears with inline styles (e.g. `style="color: #D4AF37; font-weight: 700;"` on Dashboard heading), replace with Atelier classes. Do not change the HTML element type — only add/replace class and remove the inline style.

Specific replacements:
- `style="font-size: 38px; color: #D4AF37; font-weight: 700;"` on "COMMAND CENTER" → add class `atl-section-heading` and `atl-section-eyebrow`
- `style="color: #888; font-size: 18px; letter-spacing: 1px;"` on subheadings → add class `atl-section-sub`
- `style="width: 80px; border-top: 3px solid #D4AF37; margin: 25px auto;"` → replace with the gold gradient rule (see Section 5)

---

## SECTION 3: PAGE BODY & BACKGROUND

```css
/* ── PAGE BODY ───────────────────────────────────── */

body {
  background-color: var(--atl-paper);
  background-image:
    radial-gradient(ellipse 80% 40% at 20% 0%,   rgba(212,175,55,0.06), transparent 55%),
    radial-gradient(ellipse 60% 30% at 85% 100%,  rgba(212,175,55,0.04), transparent 50%);
  background-attachment: fixed;
  min-height: 100vh;
  transition: background-color 0.4s ease;
}

/* Film grain — fixed overlay on entire page */
body::before {
  content: '';
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 0;
  opacity: var(--atl-grain-opacity);
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.75' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
}

/* Ensure all content is above the grain */
#loginSection,
#dashboardSection,
#loginCard,
.admin-section { position: relative; z-index: 1; }
```

---

## SECTION 4: LOGIN SCREEN

The login screen already has strong Atelier character. Align its typography and form controls to match the new global token system without changing its layout or animation.

```css
/* ── LOGIN SCREEN ────────────────────────────────── */

/* Card background */
.login-card-wrapped {
  background: var(--atl-card);
  border: 1px solid var(--atl-line);
  border-radius: var(--atl-r-xl);
  box-shadow: var(--atl-shadow-modal);
}

/* Heading inside login */
.login-header h1 {
  font-family: 'Cormorant Garamond', Georgia, serif;
  font-size: clamp(26px, 5vw, 34px);
  font-weight: 500;
  color: var(--atl-ink-dim);
}
.login-header p {
  font-family: 'Outfit', sans-serif;
  color: var(--atl-muted);
  font-size: 14px;
}

/* Brand name on the left panel */
.brand-name {
  font-family: 'Cormorant Garamond', Georgia, serif;
  font-weight: 500;
  color: var(--atl-ink-dim);
}
.brand-name .surname { color: var(--atl-amber); }
.brand-tagline {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  letter-spacing: 0.3em;
  text-transform: uppercase;
  color: var(--atl-muted);
}

/* Form fields */
.tm-form-label {
  font-family: 'Outfit', sans-serif;
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--atl-muted);
  display: block;
  margin-bottom: 6px;
}
.tm-form-input {
  width: 100%;
  background: var(--atl-input-bg);
  border: 1px solid var(--atl-line);
  color: var(--atl-ink);
  font-family: 'Outfit', sans-serif;
  font-size: 14px;
  padding: 10px 14px;
  border-radius: var(--atl-r-md);
  transition: border-color var(--atl-t-base), box-shadow var(--atl-t-base);
  min-height: 44px;
}
.tm-form-input::placeholder { color: var(--atl-placeholder); }
.tm-form-input:focus {
  outline: none;
  border-color: var(--atl-amber);
  box-shadow: 0 0 0 3px rgba(212,175,55,0.15);
}

/* Login button */
.tm-login-btn {
  width: 100%;
  background: var(--atl-amber);
  color: var(--atl-on-amber);
  font-family: 'Outfit', sans-serif;
  font-size: 14px;
  font-weight: 700;
  padding: 12px;
  border: none;
  border-radius: var(--atl-r-md);
  cursor: pointer;
  letter-spacing: 0.04em;
  min-height: 48px;
  transition: background var(--atl-t-base), transform var(--atl-t-fast);
}
.tm-login-btn:hover {
  background: var(--atl-amber-hover);
  transform: translateY(-1px);
}

/* Error / info alert */
.tm-login-error {
  background: rgba(248,113,113,0.10);
  border: 1px solid rgba(248,113,113,0.30);
  border-radius: var(--atl-r-md);
  color: var(--atl-clay);
  font-family: 'Outfit', sans-serif;
  font-size: 13px;
  padding: 10px 14px;
}

/* "Forgot?" link */
.forgot-link {
  font-family: 'Outfit', sans-serif;
  font-size: 13px;
  color: var(--atl-amber);
  text-decoration: none;
}
.forgot-link:hover { color: var(--atl-amber-hover); text-decoration: underline; }
```

---

## SECTION 5: SIDEBAR NAVIGATION

```css
/* ── SIDEBAR ─────────────────────────────────────── */

.tm-admin-wrapper { background: var(--atl-paper); }

.tm-admin-sidebar {
  background: var(--atl-sidebar-bg);
  border-right: 1px solid var(--atl-line);
  transition: background-color 0.4s ease;
}

/* Logo / brand area */
.tm-admin-logo img { opacity: 0.92; }
.tm-admin-sidebar-brand { color: var(--atl-ink-dim); }

/* Section group labels ("MANAGEMENT", "CONTENT", etc.) */
.tm-sidebar-group-title span {
  font-family: 'JetBrains Mono', monospace;
  font-size: 9px;
  font-weight: 500;
  letter-spacing: 0.25em;
  text-transform: uppercase;
  color: var(--atl-muted-dim);
}

/* Nav items */
.tm-admin-sidebar .nav.admin-sidebar > li > a {
  color: var(--atl-muted);
  font-family: 'Outfit', sans-serif;
  font-size: 13px;
  font-weight: 400;
  transition: color var(--atl-t-base), background var(--atl-t-base);
  border-radius: var(--atl-r-sm);
}
.tm-admin-sidebar .nav.admin-sidebar > li > a > i {
  color: var(--atl-muted-dim);
  transition: color var(--atl-t-base);
}

/* Hover state */
.tm-admin-sidebar .nav.admin-sidebar > li > a:hover {
  color: var(--atl-ink);
  background: rgba(212,175,55,0.07);
}
.tm-admin-sidebar .nav.admin-sidebar > li > a:hover > i { color: var(--atl-amber); }

/* Active item */
.tm-admin-sidebar .nav.admin-sidebar > li.active > a {
  color: var(--atl-amber);
  background: rgba(212,175,55,0.12);
  border-left: 2px solid var(--atl-amber);
}
.tm-admin-sidebar .nav.admin-sidebar > li.active > a > i { color: var(--atl-amber); }

/* Sidebar toggle button */
.tm-admin-sidebar-toggle {
  color: var(--atl-muted);
  background: transparent;
  border: 1px solid var(--atl-line);
  border-radius: var(--atl-r-sm);
}
.tm-admin-sidebar-toggle:hover {
  color: var(--atl-amber);
  border-color: var(--atl-amber-border);
}

/* Scrollbar */
.tm-admin-sidebar-scroll::-webkit-scrollbar { width: 3px; }
.tm-admin-sidebar-scroll::-webkit-scrollbar-thumb {
  background: var(--atl-line-strong);
  border-radius: 3px;
}

/* Mobile overlay */
.tm-sidebar-overlay { background: var(--atl-overlay); }

/* Logout button */
.logout-action { color: var(--atl-muted) !important; }
.logout-action:hover { color: var(--atl-clay) !important; background: rgba(248,113,113,0.08) !important; }

/* Mobile open button */
.tm-mobile-admin-open {
  background: var(--atl-card);
  border: 1px solid var(--atl-line);
  color: var(--atl-ink);
  border-radius: var(--atl-r-sm);
}
```

---

## SECTION 6: ADMIN CONTROL BAR (TOP NAV)

```css
/* ── ADMIN CONTROL BAR ───────────────────────────── */

.adm-header {
  background: var(--atl-topbar-bg);
  border-bottom: 1px solid var(--atl-line);
  box-shadow: var(--atl-shadow-top);
  transition: background-color 0.4s ease;
}

/* Breadcrumb */
.adm-breadcrumb__root { color: var(--atl-amber); }
.adm-breadcrumb__root i { color: var(--atl-amber); }
.adm-breadcrumb__sep { color: var(--atl-muted-dim); }
.adm-breadcrumb__current {
  font-family: 'Outfit', sans-serif;
  color: var(--atl-muted);
  font-size: 13px;
}

/* Global search */
.adm-search__input {
  background: var(--atl-input-bg);
  border: 1px solid var(--atl-line);
  color: var(--atl-ink);
  font-family: 'Outfit', sans-serif;
  font-size: 13px;
  border-radius: var(--atl-r-md);
  transition: border-color var(--atl-t-base), box-shadow var(--atl-t-base);
}
.adm-search__input::placeholder { color: var(--atl-placeholder); }
.adm-search__input:hover {
  border-color: var(--atl-line-strong);
  background: var(--atl-card);
}
.adm-search__input:focus {
  outline: none;
  border-color: var(--atl-amber);
  box-shadow: 0 0 0 3px rgba(212,175,55,0.14);
  background: var(--atl-card);
}
.adm-search:focus-within .adm-search__icon { color: var(--atl-amber); }
.adm-search__icon { color: var(--atl-muted-dim); }
.adm-search__shortcut {
  background: var(--atl-surface2);
  border: 1px solid var(--atl-line);
  color: var(--atl-muted-dim);
  font-family: 'JetBrains Mono', monospace;
  font-size: 9px;
  border-radius: var(--atl-r-sm);
}

/* Search results panel */
.adm-search__results {
  background: var(--atl-card);
  border: 1px solid var(--atl-line-strong);
  box-shadow: var(--atl-shadow-card);
  border-radius: var(--atl-r-lg);
}
.adm-search__group-label {
  font-family: 'JetBrains Mono', monospace;
  font-size: 9px;
  font-weight: 500;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  color: var(--atl-muted-dim);
}
.adm-search__divider { background: var(--atl-line); }
.adm-search__result { color: var(--atl-muted); font-family: 'Outfit', sans-serif; }
.adm-search__result:hover, .adm-search__result:focus {
  background: var(--atl-amber-dim);
  color: var(--atl-ink);
}
.adm-search__result i {
  background: var(--atl-amber-dim);
  color: var(--atl-amber);
  border-radius: var(--atl-r-sm);
}
.adm-search__result-title { font-size: 13px; color: var(--atl-ink); }
.adm-search__result-sub   { font-size: 11px; color: var(--atl-muted); }
.adm-search__empty { color: var(--atl-muted); font-family: 'Outfit', sans-serif; font-size: 13px; }

/* Create/Notifications/Profile icon buttons */
.adm-icon-btn,
.adm-create-btn,
.adm-profile-btn {
  background: transparent;
  border: 1px solid var(--atl-line);
  color: var(--atl-muted);
  border-radius: var(--atl-r-md);
  transition: all var(--atl-t-base);
  min-height: 36px;
  min-width: 36px;
}
.adm-icon-btn:hover,
.adm-create-btn:hover,
.adm-profile-btn:hover {
  border-color: var(--atl-amber-border);
  color: var(--atl-amber);
  background: var(--atl-amber-dim);
}

/* Notification badge */
.adm-badge {
  background: var(--atl-clay);
  color: var(--atl-ink);
  font-family: 'JetBrains Mono', monospace;
  font-size: 9px;
  font-weight: 700;
  border-radius: var(--atl-r-pill);
  border: 2px solid var(--atl-topbar-bg);
}

/* Profile avatar */
.adm-avatar {
  background: var(--atl-amber-dim);
  border: 1px solid var(--atl-amber-border);
  color: var(--atl-amber);
  font-family: 'Outfit', sans-serif;
  font-weight: 700;
  border-radius: var(--atl-r-pill);
}

/* Profile name label */
.adm-profile-name {
  font-family: 'Outfit', sans-serif;
  font-size: 13px;
  color: var(--atl-muted);
}

/* Header divider */
.adm-header__divider { background: var(--atl-line); }

/* Dropdown menus */
.adm-dropdown__menu {
  background: var(--atl-card);
  border: 1px solid var(--atl-line-strong);
  box-shadow: var(--atl-shadow-card);
  border-radius: var(--atl-r-lg);
}
.adm-dropdown__header {
  font-family: 'JetBrains Mono', monospace;
  font-size: 9px;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  color: var(--atl-muted-dim);
  border-bottom: 1px solid var(--atl-line);
}
.adm-dropdown__header-action { color: var(--atl-muted); }
.adm-dropdown__header-action:hover { color: var(--atl-amber); }
.adm-dropdown__divider { background: var(--atl-line); }

/* Dropdown items */
.adm-dropdown__item {
  font-family: 'Outfit', sans-serif;
  font-size: 13px;
  color: var(--atl-muted);
  border-radius: var(--atl-r-sm);
  transition: all var(--atl-t-fast);
}
.adm-dropdown__item:hover, .adm-dropdown__item:focus {
  background: var(--atl-amber-dim);
  color: var(--atl-ink);
}
.adm-dropdown__item > i {
  background: var(--atl-amber-dim);
  color: var(--atl-amber);
  border-radius: var(--atl-r-sm);
}
.adm-dropdown__item-title { font-size: 13px; font-family: 'Outfit', sans-serif; }
.adm-dropdown__item-sub   { font-size: 11px; color: var(--atl-muted-dim); }
.adm-dropdown__item--danger:hover {
  background: rgba(248,113,113,0.08);
  color: var(--atl-clay);
}
.adm-dropdown__item--danger:hover > i {
  background: rgba(248,113,113,0.12);
  color: var(--atl-clay);
}
.adm-dropdown__footer-link {
  font-family: 'Outfit', sans-serif;
  font-size: 12px;
  color: var(--atl-amber);
  text-decoration: none;
  text-align: center;
  display: block;
  padding: 10px;
  border-top: 1px solid var(--atl-line);
}
.adm-dropdown__footer-link:hover { color: var(--atl-amber-hover); }

/* Profile card inside dropdown */
.adm-profile-card {
  background: var(--atl-surface2);
  border-radius: var(--atl-r-md);
  margin: 8px;
  padding: 12px;
}
.adm-profile-card__name {
  font-family: 'Outfit', sans-serif;
  font-weight: 600;
  color: var(--atl-ink);
  font-size: 14px;
}
```

---

## SECTION 7: MAIN CONTENT AREA

```css
/* ── MAIN CONTENT AREA ───────────────────────────── */

.tm-admin-main {
  background: var(--atl-paper);
  transition: background-color 0.4s ease;
}

/* Section wrapper padding */
.admin-section {
  padding: clamp(20px, 4vw, 40px) clamp(16px, 3vw, 32px);
}
```

---

## SECTION 8: UNIVERSAL SECTION HEADER

Apply to every section's top. Replace existing hardcoded heading styles with this pattern:

```html
<!-- Replace every section's hardcoded heading block with: -->
<div class="atl-section-hd">
  <div>
    <p class="atl-section-eyebrow"><!-- e.g. "Booking Operations" --></p>
    <h2 class="atl-section-heading"><!-- e.g. "Event Bookings" --></h2>
    <p class="atl-section-sub"><!-- subtitle if applicable --></p>
  </div>
  <!-- Optional: primary action button -->
</div>
<div class="atl-section-rule"></div>
```

```css
.atl-section-hd {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}

/* Gold gradient rule beneath every section header */
.atl-section-rule {
  height: 1px;
  margin: 16px 0 28px;
  background: linear-gradient(
    to right,
    var(--atl-amber),
    rgba(212,175,55,0.20) 40%,
    transparent 75%
  );
}
```

---

## SECTION 9: UNIVERSAL CARD COMPONENT

All cards throughout the admin — dashboard stat cards, social cards, CRM cards, content cards — use this system:

```css
/* ── UNIVERSAL CARD ──────────────────────────────── */

.atl-card {
  background: var(--atl-card);
  border: 1px solid var(--atl-line);
  border-radius: var(--atl-r-xl);
  overflow: hidden;
  transition: border-color var(--atl-t-base), box-shadow var(--atl-t-base),
              background-color 0.4s ease;
}
.atl-card:hover {
  border-color: var(--atl-amber-border);
  box-shadow: var(--atl-shadow-card);
}
.atl-card-header {
  padding: 16px 20px 12px;
  border-bottom: 1px solid var(--atl-line);
}
.atl-card-header h3,
.atl-card-header h4 {
  font-family: 'Cormorant Garamond', Georgia, serif;
  font-size: clamp(16px, 2.5vw, 20px);
  font-weight: 500;
  color: var(--atl-ink-dim);
  margin: 0;
}
.atl-card-body { padding: 16px 20px; }
.atl-card-footer {
  padding: 12px 20px;
  border-top: 1px solid var(--atl-line);
  background: var(--atl-surface2);
}

/* Elevated surface inside a card — nested panels */
.atl-surface {
  background: var(--atl-surface2);
  border-radius: var(--atl-r-lg);
  padding: 16px;
  transition: background-color 0.4s ease;
}
```

---

## SECTION 10: UNIVERSAL BUTTON SYSTEM

Replace all button variants throughout the page with this unified system. All existing `btn-admin-primary`, `btn-admin-secondary`, `um-btn--primary`, etc. must visually match these.

```css
/* ── BUTTON SYSTEM ───────────────────────────────── */

/* Base — shared by all variants */
.atl-btn,
.btn-admin-primary,
.btn-admin-secondary,
.um-btn,
[class*="um-btn--"] {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  font-family: 'Outfit', sans-serif;
  font-size: 13px;
  font-weight: 600;
  border-radius: var(--atl-r-md);
  padding: 8px 16px;
  min-height: 40px;
  border: 1px solid transparent;
  cursor: pointer;
  text-decoration: none;
  transition: all var(--atl-t-base);
  white-space: nowrap;
}
.atl-btn:hover, [class*="um-btn--"]:hover { transform: translateY(-1px); }

/* PRIMARY — gold fill */
.atl-btn--primary,
.btn-admin-primary,
.um-btn--primary {
  background: var(--atl-amber) !important;
  color: var(--atl-on-amber) !important;
  border-color: var(--atl-amber) !important;
}
.atl-btn--primary:hover,
.btn-admin-primary:hover,
.um-btn--primary:hover {
  background: var(--atl-amber-hover) !important;
  border-color: var(--atl-amber-hover) !important;
  box-shadow: 0 4px 14px rgba(212,175,55,0.28) !important;
}

/* GHOST — bordered, transparent */
.atl-btn--ghost,
.btn-admin-secondary,
.um-btn--ghost {
  background: transparent !important;
  color: var(--atl-ink) !important;
  border-color: var(--atl-line-strong) !important;
}
.atl-btn--ghost:hover,
.btn-admin-secondary:hover,
.um-btn--ghost:hover {
  border-color: var(--atl-amber-border) !important;
  color: var(--atl-amber) !important;
  background: var(--atl-amber-dim) !important;
}

/* DANGER — red border/text */
.atl-btn--danger,
.um-btn--danger {
  background: transparent !important;
  color: var(--atl-clay) !important;
  border-color: rgba(248,113,113,0.35) !important;
}
.atl-btn--danger:hover,
.um-btn--danger:hover { background: rgba(248,113,113,0.08) !important; }

/* DANGER SOLID — red fill */
.atl-btn--danger-solid,
.um-btn--danger-solid {
  background: var(--atl-clay) !important;
  color: #ffffff !important;
  border-color: var(--atl-clay) !important;
}

/* SIZE VARIANTS */
.atl-btn--sm { padding: 5px 10px; font-size: 11px; min-height: 32px; }
.atl-btn--lg { padding: 12px 24px; font-size: 15px; min-height: 48px; }

/* ICON BUTTON — square, no text */
.atl-btn--icon {
  padding: 8px;
  min-width: 40px;
}

/* Bootstrap .btn override — maintain functionality, replace look */
.btn {
  font-family: 'Outfit', sans-serif;
  border-radius: var(--atl-r-md);
  font-weight: 600;
  transition: all var(--atl-t-base);
  border: 1px solid transparent;
  min-height: 36px;
}
```

---

## SECTION 11: UNIVERSAL FORM CONTROLS

Override all Bootstrap `.form-control` and native inputs, selects, and textareas:

```css
/* ── FORM CONTROLS ───────────────────────────────── */

/* The global base for ALL inputs, selects, textareas */
input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="file"]),
select,
textarea,
.form-control,
.um-input,
.tm-form-input,
.adm-search__input {
  background: var(--atl-input-bg) !important;
  color: var(--atl-ink) !important;
  border: 1px solid var(--atl-line) !important;
  border-radius: var(--atl-r-md) !important;
  font-family: 'Outfit', sans-serif !important;
  font-size: 13px !important;
  padding: 9px 12px !important;
  min-height: 40px;
  transition: border-color var(--atl-t-base), box-shadow var(--atl-t-base) !important;
  /* Remove old color-scheme hints */
  color-scheme: inherit;
}

input::placeholder,
textarea::placeholder,
.form-control::placeholder { color: var(--atl-placeholder) !important; }

input:focus,
select:focus,
textarea:focus,
.form-control:focus,
.um-input:focus {
  outline: none !important;
  border-color: var(--atl-amber) !important;
  box-shadow: 0 0 0 3px rgba(212,175,55,0.14) !important;
  background: var(--atl-card) !important;
}

/* Select dropdown options */
select option { background: var(--atl-card) !important; color: var(--atl-ink) !important; }

/* Textarea */
textarea {
  resize: vertical;
  line-height: 1.5;
}

/* Form group labels — universal */
label,
.um-label,
.tm-form-label {
  font-family: 'Outfit', sans-serif;
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--atl-muted);
  display: block;
  margin-bottom: 5px;
}

/* Required asterisk */
label .req,
label .required,
label abbr[title="required"] {
  color: var(--atl-clay);
  text-decoration: none;
}

/* Input with icon (search fields) */
.um-input-icon { color: var(--atl-muted-dim); }
.um-input-wrap:focus-within .um-input-icon { color: var(--atl-amber); }

/* Input group (Bootstrap) */
.input-group-addon,
.input-group-btn .btn {
  background: var(--atl-surface2) !important;
  border-color: var(--atl-line) !important;
  color: var(--atl-muted) !important;
}

/* Checkboxes and radios — custom styled */
input[type="checkbox"],
input[type="radio"] {
  accent-color: var(--atl-amber);
  width: 16px;
  height: 16px;
  cursor: pointer;
}

/* Password strength bar */
.um-strength-seg {
  background: var(--atl-line-strong);
  border-radius: 2px;
  height: 4px;
}
.um-strength-seg.weak   { background: var(--atl-clay); }
.um-strength-seg.fair   { background: var(--atl-orange); }
.um-strength-seg.strong { background: var(--atl-sage); }
.um-strength-label { font-family: 'Outfit', sans-serif; font-size: 12px; color: var(--atl-muted); }
```

---

## SECTION 12: UNIVERSAL TABLE STYLES

Override all Bootstrap `.table` instances throughout the page:

```css
/* ── TABLES ──────────────────────────────────────── */

/* Wrapper */
.table-responsive {
  border-radius: var(--atl-r-lg);
  overflow: hidden;
  border: 1px solid var(--atl-line);
}

/* Table base */
.table,
table {
  border-collapse: collapse;
  width: 100%;
  font-family: 'Outfit', sans-serif;
  font-size: 13px;
  color: var(--atl-ink);
  background: transparent;
}

/* Header */
.table thead th,
table thead th {
  background: var(--atl-surface2);
  color: var(--atl-muted);
  font-size: 10px;
  font-family: 'JetBrains Mono', monospace;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.12em;
  padding: 10px 12px;
  border-bottom: 1px solid var(--atl-line-strong) !important;
  border-top: none !important;
  white-space: nowrap;
}

/* Body rows */
.table tbody tr,
table tbody tr {
  border-bottom: 1px solid var(--atl-line) !important;
  transition: background var(--atl-t-fast);
}
.table tbody tr:hover,
table tbody tr:hover { background: rgba(212,175,55,0.03); }

.table td,
table td {
  padding: 10px 12px;
  vertical-align: middle;
  color: var(--atl-ink);
  border: none !important;
}

/* Striped rows */
.table-striped tbody tr:nth-of-type(odd) {
  background: rgba(255,255,255,0.015);
}

/* Row color states for finance/status rows */
.table tr.row-paid   td { border-left: 2px solid var(--atl-sage) !important; }
.table tr.row-unpaid td { border-left: 2px solid var(--atl-orange) !important; }
.table tr.row-fail   td { border-left: 2px solid var(--atl-clay) !important; }

/* Financial value columns */
.table td.td-amount,
table td.td-amount {
  font-family: 'JetBrains Mono', monospace;
  font-variant-numeric: tabular-nums;
  text-align: right;
}

/* Mobile: responsive table transform */
@media (max-width: 599px) {
  .table-responsive { overflow-x: auto; -webkit-overflow-scrolling: touch; }
}
```

---

## SECTION 13: UNIVERSAL MODAL SYSTEM

Replace the visual styling of all Bootstrap modals (their JS mechanics — `.modal('show')`, `data-dismiss` — must remain):

```css
/* ── BOOTSTRAP MODAL OVERRIDES ───────────────────── */

.modal-backdrop { background-color: var(--atl-paper) !important; }
.modal-backdrop.in { opacity: 0.72 !important; }

.modal-content {
  background: var(--atl-card) !important;
  border: 1px solid var(--atl-line-strong) !important;
  border-radius: var(--atl-r-xl) !important;
  box-shadow: var(--atl-shadow-modal) !important;
  overflow: hidden;
  color: var(--atl-ink) !important;
}

.modal-header {
  background: var(--atl-surface2) !important;
  border-bottom: 1px solid var(--atl-line) !important;
  padding: 18px 22px !important;
}
.modal-header .modal-title,
.modal-header h4 {
  font-family: 'Cormorant Garamond', Georgia, serif !important;
  font-size: 22px !important;
  font-weight: 600 !important;
  color: var(--atl-ink-dim) !important;
}
.modal-header .close {
  color: var(--atl-muted) !important;
  opacity: 1 !important;
  font-size: 20px !important;
  text-shadow: none !important;
  background: transparent;
  border: none;
  padding: 6px 8px;
  border-radius: var(--atl-r-sm);
  transition: color var(--atl-t-fast), background var(--atl-t-fast);
}
.modal-header .close:hover {
  color: var(--atl-ink) !important;
  background: rgba(255,255,255,0.07) !important;
}

.modal-body {
  background: var(--atl-card) !important;
  color: var(--atl-ink) !important;
  padding: 22px !important;
}

.modal-footer {
  background: var(--atl-surface2) !important;
  border-top: 1px solid var(--atl-line) !important;
  padding: 14px 22px !important;
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  flex-wrap: wrap;
}

/* Modal labels (for form fields inside modals) */
.modal-body label {
  font-family: 'Outfit', sans-serif;
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--atl-muted);
  margin-bottom: 5px;
}
```

---

## SECTION 14: NAV TABS (Bootstrap override)

```css
/* ── NAV TABS ────────────────────────────────────── */

.nav-tabs {
  border-bottom: 1px solid var(--atl-line) !important;
  gap: 4px;
  display: flex;
  flex-wrap: wrap;
}

.nav-tabs > li > a {
  font-family: 'Outfit', sans-serif !important;
  font-size: 13px !important;
  font-weight: 600 !important;
  color: var(--atl-muted) !important;
  border: 1px solid transparent !important;
  border-radius: var(--atl-r-md) var(--atl-r-md) 0 0 !important;
  padding: 8px 14px !important;
  transition: color var(--atl-t-base), border-color var(--atl-t-base) !important;
  background: transparent !important;
  min-height: 40px;
  display: flex;
  align-items: center;
  gap: 6px;
}
.nav-tabs > li > a:hover {
  color: var(--atl-ink) !important;
  background: rgba(212,175,55,0.06) !important;
  border-color: var(--atl-line) !important;
}
.nav-tabs > li.active > a,
.nav-tabs > li.active > a:hover {
  color: var(--atl-amber) !important;
  background: var(--atl-card) !important;
  border: 1px solid var(--atl-line) !important;
  border-bottom-color: var(--atl-card) !important;
}

/* Tab content */
.tab-content > .tab-pane { color: var(--atl-ink); }
.tab-content > .active { background: var(--atl-card); }
```

---

## SECTION 15: STATUS BADGES

Consistent badge system used across bookings, finance, events, inquiries:

```css
/* ── STATUS BADGES ───────────────────────────────── */

.atl-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 10px;
  border-radius: var(--atl-r-pill);
  font-family: 'Outfit', sans-serif;
  font-size: 11px;
  font-weight: 600;
}

/* State variants */
.atl-badge--pending   { background: rgba(212,175,55,0.14); color: #D4AF37; }
.atl-badge--quoted    { background: rgba(232,193,75,0.14);  color: #E8C14B; }
.atl-badge--accepted  { background: rgba(96,165,250,0.16);  color: #60a5fa; }
.atl-badge--confirmed { background: rgba(52,211,153,0.16);  color: #34d399; }
.atl-badge--completed { background: rgba(74,222,128,0.16);  color: #4ade80; }
.atl-badge--cancelled { background: rgba(248,113,113,0.16); color: #f87171; }
.atl-badge--paid      { background: rgba(74,222,128,0.14);  color: #4ade80; }
.atl-badge--unpaid    { background: rgba(255,255,255,0.06); color: var(--atl-muted); border: 1px solid var(--atl-line); }
.atl-badge--overdue   { background: rgba(248,113,113,0.14); color: #f87171; }
.atl-badge--new       { background: rgba(96,165,250,0.14);  color: #60a5fa; }
.atl-badge--info      { background: rgba(212,175,55,0.10);  color: var(--atl-amber); }
.atl-badge--warning   { background: rgba(251,146,60,0.14);  color: var(--atl-orange); }

/* Light theme adjustments for status badges */
[data-theme="light"] .atl-badge--pending   { color: #8a6a0d; }
[data-theme="light"] .atl-badge--completed { color: #15803d; }
[data-theme="light"] .atl-badge--confirmed { color: #0f7a45; }
[data-theme="light"] .atl-badge--accepted  { color: #1d4ed8; }
[data-theme="light"] .atl-badge--cancelled { color: #b91c1c; }
[data-theme="light"] .atl-badge--paid      { color: #15803d; }
```

Apply these consistently when replacing inline status-coloured spans:
- Replace `style="color:#66BB6A;"` (paid green) → `class="atl-badge atl-badge--paid"`
- Replace `style="color:#ef5350;"` (cancelled red) → `class="atl-badge atl-badge--cancelled"`
- Replace `style="color:#FFA726;"` (pending orange) → `class="atl-badge atl-badge--pending"`
- etc.

---

## SECTION 16: NOTIFICATIONS PANEL

```css
/* ── NOTIFICATIONS ───────────────────────────────── */

.adm-noti-list { max-height: 320px; overflow-y: auto; }

/* Individual notification item */
.adm-noti-item {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--atl-line);
  transition: background var(--atl-t-fast);
  cursor: pointer;
}
.adm-noti-item:hover { background: var(--atl-amber-dim); }
.adm-noti-item:last-child { border-bottom: none; }

/* Notification icon */
.adm-noti-icon {
  width: 32px;
  height: 32px;
  border-radius: var(--atl-r-md);
  background: var(--atl-amber-dim);
  color: var(--atl-amber);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  flex-shrink: 0;
}

/* Notification text */
.adm-noti-title {
  font-family: 'Outfit', sans-serif;
  font-size: 13px;
  color: var(--atl-ink);
  font-weight: 600;
}
.adm-noti-sub {
  font-family: 'Outfit', sans-serif;
  font-size: 11px;
  color: var(--atl-muted);
  margin-top: 2px;
}
.adm-noti-time {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  color: var(--atl-muted-dim);
  white-space: nowrap;
}

/* Unread dot */
.adm-noti-item.unread { background: rgba(212,175,55,0.03); }
.adm-noti-item.unread .adm-noti-title::before {
  content: '●';
  color: var(--atl-amber);
  font-size: 7px;
  margin-right: 5px;
  vertical-align: middle;
}
```

---

## SECTION 17: DASHBOARD SECTION (`#dashboardAdmin`)

The dashboard uses inline `<style>` blocks for its `.db-*` classes. Update them in-place using the token system.

### Summary stat cards (`.db-stat-card`)

```css
.db-stat-card {
  background: var(--atl-card);
  border: 1px solid var(--atl-line);
  border-radius: var(--atl-r-xl);
  padding: 20px;
  display: flex;
  align-items: center;
  gap: 16px;
  cursor: pointer;
  transition: border-color var(--atl-t-base), box-shadow var(--atl-t-base), transform var(--atl-t-fast);
}
.db-stat-card:hover {
  border-color: var(--atl-amber-border);
  box-shadow: var(--atl-shadow-card);
  transform: translateY(-2px);
}
.db-stat-icon {
  width: 48px;
  height: 48px;
  border-radius: var(--atl-r-lg);
  background: var(--atl-amber-dim);
  color: var(--atl-amber);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 18px;
  flex-shrink: 0;
}
.db-stat-label {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.15em;
  color: var(--atl-muted);
  display: block;
}
.db-stat-value {
  font-family: 'Cormorant Garamond', Georgia, serif;
  font-size: 28px;
  font-weight: 600;
  color: var(--atl-ink-dim);
  display: block;
  line-height: 1;
  margin-top: 4px;
}
```

### Social media cards (`.db-social-card`)

```css
.db-social-card {
  background: var(--atl-card);
  border: 1px solid var(--atl-line);
  border-radius: var(--atl-r-lg);
  padding: 16px;
  transition: border-color var(--atl-t-base);
}
.db-social-card:hover { border-color: var(--atl-amber-border); }
.db-social-name {
  font-family: 'Outfit', sans-serif;
  font-size: 12px;
  font-weight: 600;
  color: var(--atl-muted);
}
.db-social-count {
  font-family: 'Cormorant Garamond', Georgia, serif;
  font-size: 26px;
  font-weight: 600;
  color: var(--atl-ink-dim);
}
.db-social-label {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.12em;
  color: var(--atl-muted-dim);
}
.db-social-trend { font-family: 'Outfit', sans-serif; font-size: 11px; font-weight: 600; }
.trend-up   { color: var(--atl-sage); }
.trend-down { color: var(--atl-clay); }
```

### Analytics/chart cards (`.db-card`)

```css
.db-card {
  background: var(--atl-card);
  border: 1px solid var(--atl-line);
  border-radius: var(--atl-r-xl);
  overflow: hidden;
  transition: border-color var(--atl-t-base);
}
.db-card-header {
  padding: 16px 20px 12px;
  border-bottom: 1px solid var(--atl-line);
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.db-card-header h3 {
  font-family: 'Cormorant Garamond', Georgia, serif;
  font-size: 18px;
  font-weight: 500;
  color: var(--atl-ink-dim);
  margin: 0;
}
.db-spark-value {
  font-family: 'Cormorant Garamond', Georgia, serif;
  font-size: 20px;
  font-weight: 600;
  color: var(--atl-ink-dim);
}
.db-card-body { padding: 16px; }
```

### CRM progress cards (`.db-crm-card`)

```css
.db-crm-card {
  background: var(--atl-card);
  border: 1px solid var(--atl-line);
  border-radius: var(--atl-r-xl);
  padding: 20px;
}
.db-crm-label {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.15em;
  color: var(--atl-muted);
}
.db-crm-value {
  font-family: 'Cormorant Garamond', Georgia, serif;
  font-size: 28px;
  font-weight: 600;
  color: var(--atl-ink-dim);
  margin: 6px 0 2px;
}
.db-crm-trend { font-family: 'Outfit', sans-serif; font-size: 12px; }
.db-crm-progress-bar {
  height: 4px;
  background: var(--atl-surface2);
  border-radius: var(--atl-r-pill);
  margin-top: 12px;
  overflow: hidden;
}
.db-crm-progress {
  height: 100%;
  background: linear-gradient(to right, var(--atl-amber), var(--atl-amber-hover));
  border-radius: var(--atl-r-pill);
}
```

### Schedule list items (`.db-schedule-item`)

```css
.db-schedule-item {
  border-bottom: 1px solid var(--atl-line);
  padding: 10px 0;
  display: flex;
  align-items: flex-start;
  gap: 12px;
}
.db-schedule-time {
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  color: var(--atl-amber);
  white-space: nowrap;
  margin-top: 2px;
}
.db-schedule-title {
  font-family: 'Outfit', sans-serif;
  font-size: 13px;
  font-weight: 600;
  color: var(--atl-ink);
}
.db-schedule-desc {
  font-family: 'Outfit', sans-serif;
  font-size: 12px;
  color: var(--atl-muted);
}
```

---

## SECTION 18: FINANCE SECTION (`#financeAdmin`)

Finance summary tiles already use inline styles. Replace with token-based styles:

```css
/* Finance stat tiles */
.fin-tile {
  background: var(--atl-card);
  border: 1px solid var(--atl-line);
  border-radius: var(--atl-r-xl);
  padding: 20px;
  text-align: center;
  transition: border-color var(--atl-t-base);
}
.fin-tile:hover { border-color: var(--atl-amber-border); }
.fin-tile-label {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.15em;
  color: var(--atl-muted);
  display: block;
  margin-bottom: 8px;
}
.fin-tile-value {
  font-family: 'Cormorant Garamond', Georgia, serif;
  font-size: clamp(22px, 4vw, 30px);
  font-weight: 600;
  color: var(--atl-ink-dim);
  display: block;
}
/* Semantic colouring for finance values */
.fin-tile-value.positive { color: var(--atl-sage); }
.fin-tile-value.negative { color: var(--atl-clay); }
.fin-tile-value.pending  { color: var(--atl-orange); }
.fin-tile-value.neutral  { color: var(--atl-blue); }
```

Apply to the existing stat divs by replacing their inline styles:
- `style="color:#4CAF50; font-size:13px; font-weight:bold; text-transform:uppercase;"` on "Total Revenue" → `.fin-tile-label` + add class `positive` to value
- `style="color:#FF9800; ..."` on "Outstanding" → `.fin-tile-label` + `pending`
- `style="color:#2196F3; ..."` on "Pending Quotes" → `.fin-tile-label` + `neutral`

---

## SECTION 19: INQUIRIES SECTION (`#inquiriesAdmin`)

```css
/* ── INQUIRIES ───────────────────────────────────── */

.inq-compose-btn {
  background: var(--atl-amber) !important;
  color: var(--atl-on-amber) !important;
  border: none !important;
  border-radius: var(--atl-r-md) !important;
  font-family: 'Outfit', sans-serif !important;
  font-weight: 600 !important;
  min-height: 44px;
}
.inq-compose-btn:hover {
  background: var(--atl-amber-hover) !important;
  transform: translateY(-1px);
}

.inq-search-input {
  background: var(--atl-input-bg) !important;
  border: 1px solid var(--atl-line) !important;
  color: var(--atl-ink) !important;
  font-family: 'Outfit', sans-serif !important;
  border-radius: var(--atl-r-md) !important;
}
.inq-search-input:focus { border-color: var(--atl-amber) !important; }
.inq-search-input::placeholder { color: var(--atl-placeholder) !important; }

/* Folder list */
.inq-folders { border-right: 1px solid var(--atl-line); }
.inq-folder {
  color: var(--atl-muted);
  font-family: 'Outfit', sans-serif;
  font-size: 13px;
  font-weight: 500;
  border-radius: var(--atl-r-md);
  transition: all var(--atl-t-base);
  padding: 8px 12px;
}
.inq-folder:hover { background: var(--atl-amber-dim); color: var(--atl-ink); }
.inq-folder.active {
  background: var(--atl-amber-dim);
  color: var(--atl-amber);
  border-left: 2px solid var(--atl-amber);
}

/* Message row */
.inq-row {
  border-bottom: 1px solid var(--atl-line);
  transition: background var(--atl-t-fast);
  padding: 12px 16px;
}
.inq-row:hover { background: rgba(212,175,55,0.03); }
.inq-row.unread { background: rgba(212,175,55,0.04); }
.inq-row-name {
  font-family: 'Outfit', sans-serif;
  font-size: 13px;
  font-weight: 600;
  color: var(--atl-ink);
}
.inq-row-subject {
  font-family: 'Outfit', sans-serif;
  font-size: 13px;
  color: var(--atl-muted);
}
.inq-row-time {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  color: var(--atl-muted-dim);
}
```

---

## SECTION 20: USER MANAGEMENT SECTION (`#usersAdmin`)

```css
/* ── USER MANAGEMENT ─────────────────────────────── */

/* Panel tabs */
.um-tabs { border-bottom: 1px solid var(--atl-line); }
.um-tab {
  font-family: 'Outfit', sans-serif;
  font-size: 13px;
  font-weight: 600;
  color: var(--atl-muted);
  padding: 10px 16px;
  border-bottom: 2px solid transparent;
  cursor: pointer;
  transition: color var(--atl-t-base), border-color var(--atl-t-base);
  min-height: 44px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.um-tab:hover { color: var(--atl-ink); }
.um-tab.active {
  color: var(--atl-amber);
  border-bottom-color: var(--atl-amber);
}

/* Profile hero */
.um-avatar-xl {
  background: var(--atl-amber-dim);
  border: 2px solid var(--atl-amber-border);
  color: var(--atl-amber);
  font-family: 'Outfit', sans-serif;
  font-weight: 700;
  font-size: 32px;
  width: 80px;
  height: 80px;
  border-radius: var(--atl-r-pill);
  display: flex;
  align-items: center;
  justify-content: center;
}
.um-profile-hero__name {
  font-family: 'Cormorant Garamond', Georgia, serif;
  font-size: clamp(20px, 3.5vw, 28px);
  font-weight: 500;
  color: var(--atl-ink-dim);
}
.um-profile-hero__since {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.15em;
  color: var(--atl-muted-dim);
}

/* Drawer panel */
.um-drawer {
  background: var(--atl-surface2);
  border: 1px solid var(--atl-line);
  border-radius: var(--atl-r-xl);
  overflow: hidden;
}
.um-drawer__header {
  background: var(--atl-surface3);
  border-bottom: 1px solid var(--atl-line);
  padding: 14px 18px;
}
.um-drawer__close {
  background: transparent;
  border: none;
  color: var(--atl-muted);
  cursor: pointer;
  padding: 4px;
  border-radius: var(--atl-r-sm);
  transition: color var(--atl-t-fast);
}
.um-drawer__close:hover { color: var(--atl-ink); }

/* User cards in the users grid */
.um-user-card {
  background: var(--atl-card);
  border: 1px solid var(--atl-line);
  border-radius: var(--atl-r-xl);
  padding: 16px;
  display: flex;
  align-items: center;
  gap: 12px;
  transition: border-color var(--atl-t-base);
}
.um-user-card:hover { border-color: var(--atl-amber-border); }
.um-user-name {
  font-family: 'Outfit', sans-serif;
  font-size: 14px;
  font-weight: 600;
  color: var(--atl-ink);
}
.um-user-role {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--atl-muted);
}
.um-feedback {
  font-family: 'Outfit', sans-serif;
  font-size: 13px;
  border-radius: var(--atl-r-md);
  padding: 10px 14px;
  margin-top: 12px;
}
.um-feedback.success {
  background: rgba(74,222,128,0.10);
  color: var(--atl-sage);
  border: 1px solid rgba(74,222,128,0.25);
}
.um-feedback.error {
  background: rgba(248,113,113,0.10);
  color: var(--atl-clay);
  border: 1px solid rgba(248,113,113,0.25);
}

/* Count label */
.um-user-count {
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  color: var(--atl-muted);
  background: var(--atl-surface2);
  padding: 3px 10px;
  border-radius: var(--atl-r-pill);
}
```

---

## SECTION 21: CALENDAR SECTION (`#calendarAdmin`)

```css
/* ── CALENDAR ────────────────────────────────────── */

/* Calendar wrapper card */
#calendarAdmin .fc {
  font-family: 'Outfit', sans-serif;
  color: var(--atl-ink);
}
#calendarAdmin .fc-toolbar-title {
  font-family: 'Cormorant Garamond', Georgia, serif;
  font-size: clamp(20px, 3vw, 26px);
  font-weight: 500;
  color: var(--atl-ink-dim);
}
#calendarAdmin .fc-button {
  background: var(--atl-card) !important;
  border: 1px solid var(--atl-line) !important;
  color: var(--atl-muted) !important;
  font-family: 'Outfit', sans-serif !important;
  font-size: 12px !important;
  font-weight: 600 !important;
  border-radius: var(--atl-r-sm) !important;
  padding: 6px 12px !important;
  box-shadow: none !important;
  min-height: 36px;
}
#calendarAdmin .fc-button:hover,
#calendarAdmin .fc-button-active {
  background: var(--atl-amber-dim) !important;
  border-color: var(--atl-amber-border) !important;
  color: var(--atl-amber) !important;
}
#calendarAdmin .fc-daygrid-day-number,
#calendarAdmin .fc-col-header-cell-cushion {
  font-family: 'Outfit', sans-serif;
  color: var(--atl-muted);
  font-size: 12px;
  font-weight: 600;
}
#calendarAdmin .fc-day-today { background: rgba(212,175,55,0.06) !important; }
#calendarAdmin .fc-daygrid-event {
  border-radius: var(--atl-r-sm);
  font-size: 11px;
  font-family: 'Outfit', sans-serif;
}
/* Blockout chip */
.cal-block-chip {
  border-radius: var(--atl-r-md);
  font-family: 'Outfit', sans-serif;
  font-size: 12px;
  font-weight: 600;
}
```

---

## SECTION 22: CONTENT MANAGEMENT SECTIONS

Applies to: homeAdmin, aboutAdmin, careerAdmin, galleryAdmin, socialAdmin, contactAdmin, newsletterAdmin

All of these sections use a mix of Bootstrap cards, forms, and tables. The global overrides in Sections 9–13 above handle most of the work. Additionally:

```css
/* ── CONTENT MANAGEMENT SECTIONS ────────────────── */

/* Section intro text */
.admin-section .section-intro {
  font-family: 'Outfit', sans-serif;
  font-size: 14px;
  color: var(--atl-muted);
  margin-bottom: 24px;
  max-width: 640px;
}

/* Content block cards (e.g. gallery uploads, social links) */
.cms-card {
  background: var(--atl-card);
  border: 1px solid var(--atl-line);
  border-radius: var(--atl-r-xl);
  padding: 20px;
  transition: border-color var(--atl-t-base), box-shadow var(--atl-t-base);
}
.cms-card:hover { border-color: var(--atl-amber-border); }
.cms-card-label {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.15em;
  color: var(--atl-muted);
  margin-bottom: 8px;
}

/* Gallery image cards */
.gal-thumb {
  border: 1px solid var(--atl-line);
  border-radius: var(--atl-r-lg);
  overflow: hidden;
  transition: border-color var(--atl-t-base), transform var(--atl-t-fast);
}
.gal-thumb:hover {
  border-color: var(--atl-amber-border);
  transform: translateY(-2px);
  box-shadow: var(--atl-shadow-card);
}

/* Social link rows */
.social-row {
  border-bottom: 1px solid var(--atl-line);
  padding: 14px 0;
  display: flex;
  align-items: center;
  gap: 12px;
}
.social-row:last-child { border-bottom: none; }
.social-icon {
  width: 36px;
  height: 36px;
  border-radius: var(--atl-r-md);
  background: var(--atl-surface2);
  color: var(--atl-muted);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 15px;
  flex-shrink: 0;
  transition: background var(--atl-t-base), color var(--atl-t-base);
}
.social-row:hover .social-icon { background: var(--atl-amber-dim); color: var(--atl-amber); }
```

---

## SECTION 23: SETTINGS SECTIONS

Applies to: preferencesAdmin, brandingAdmin, securityAdmin, servicesAdmin, policiesAdmin

```css
/* ── SETTINGS SECTIONS ───────────────────────────── */

/* Settings group panel */
.settings-panel {
  background: var(--atl-card);
  border: 1px solid var(--atl-line);
  border-radius: var(--atl-r-xl);
  overflow: hidden;
  margin-bottom: 20px;
}
.settings-panel-header {
  background: var(--atl-surface2);
  border-bottom: 1px solid var(--atl-line);
  padding: 14px 20px;
}
.settings-panel-header h4 {
  font-family: 'Cormorant Garamond', Georgia, serif;
  font-size: 18px;
  font-weight: 500;
  color: var(--atl-ink-dim);
  margin: 0;
}
.settings-panel-body { padding: 20px; }

/* Settings row — label left, control right */
.settings-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 20px;
  padding: 14px 0;
  border-bottom: 1px solid var(--atl-line);
  flex-wrap: wrap;
}
.settings-row:last-child { border-bottom: none; }
.settings-row-label {
  font-family: 'Outfit', sans-serif;
  font-size: 14px;
  font-weight: 600;
  color: var(--atl-ink);
  min-width: 160px;
}
.settings-row-sub {
  font-family: 'Outfit', sans-serif;
  font-size: 12px;
  color: var(--atl-muted);
  margin-top: 2px;
}

/* Security / email log table rows */
#securityAdmin .table tr.row-ok      td:first-child { border-left: 2px solid var(--atl-sage) !important; }
#securityAdmin .table tr.row-suspect td:first-child { border-left: 2px solid var(--atl-clay) !important; }

/* Service catalogue cards */
.svc-card {
  background: var(--atl-card);
  border: 1px solid var(--atl-line);
  border-radius: var(--atl-r-xl);
  padding: 18px;
  transition: border-color var(--atl-t-base);
}
.svc-card:hover { border-color: var(--atl-amber-border); }
.svc-name {
  font-family: 'Outfit', sans-serif;
  font-size: 15px;
  font-weight: 600;
  color: var(--atl-ink);
}
.svc-price {
  font-family: 'Cormorant Garamond', Georgia, serif;
  font-size: 20px;
  font-weight: 600;
  color: var(--atl-amber);
}
.svc-meta {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--atl-muted);
}
```

---

## SECTION 24: EMAIL LOGS SECTION (`#emailLogsAdmin`)

```css
/* ── EMAIL LOGS ──────────────────────────────────── */

.log-row {
  border-bottom: 1px solid var(--atl-line);
  padding: 10px 14px;
  font-family: 'Outfit', sans-serif;
  font-size: 13px;
  color: var(--atl-muted);
  transition: background var(--atl-t-fast);
}
.log-row:hover { background: rgba(212,175,55,0.03); }
.log-row .log-time {
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  color: var(--atl-muted-dim);
  white-space: nowrap;
}
.log-row .log-status-sent     { color: var(--atl-sage); }
.log-row .log-status-failed   { color: var(--atl-clay); }
.log-row .log-status-queued   { color: var(--atl-orange); }
.log-row .log-status-opened   { color: var(--atl-blue); }
```

---

## SECTION 25: GLOBAL FOCUS STATES AND ACCESSIBILITY

```css
/* ── GLOBAL FOCUS STATES ─────────────────────────── */

:focus-visible {
  outline: 3px solid var(--atl-focus);
  outline-offset: 2px;
  border-radius: var(--atl-r-sm);
}

/* Reset default Browser outline where we supply our own */
*:focus:not(:focus-visible) { outline: none; }

/* Links throughout */
a {
  color: var(--atl-amber);
  transition: color var(--atl-t-fast);
}
a:hover { color: var(--atl-amber-hover); }

/* Scrollbar styling — global dark scrollbar */
::-webkit-scrollbar { width: 6px; height: 6px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb {
  background: var(--atl-line-strong);
  border-radius: var(--atl-r-pill);
}
::-webkit-scrollbar-thumb:hover { background: var(--atl-muted-dim); }
```

---

## SECTION 26: LIGHT/DARK THEME TOGGLE

Extend the existing theme toggle (already built for the booking section) to cover the full page:

1. The pre-paint script in `<head>` already handles flash prevention — no change needed.
2. The toggle controller already sets `data-theme` on `<html>` — CSS variables cascade to all elements automatically.
3. **Sidebar stays dark in light theme** (`--atl-sidebar-bg: #1a1a1a` in the light token block) — this is intentional for contrast and navigation legibility. The main content area uses `var(--atl-paper)` which becomes warm ivory in light mode.
4. The topbar uses `--atl-topbar-bg` which flips to white in light mode.
5. Add the theme toggle button to the top of the admin control bar, alongside the existing icon buttons:

```html
<!-- Place this inside .adm-header__right, before the notifications button -->
<button id="atlThemeToggle" type="button"
        class="atl-theme-toggle adm-icon-btn"
        role="switch" aria-checked="false"
        aria-label="Switch between light and dark theme"
        title="Toggle theme">
  <!-- Sun icon -->
  <svg class="atl-toggle-sun" width="15" height="15" viewBox="0 0 24 24" fill="none"
       stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="12" cy="12" r="4"/>
    <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>
  </svg>
  <!-- Moon icon -->
  <svg class="atl-toggle-moon" width="15" height="15" viewBox="0 0 24 24" fill="none"
       stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
  </svg>
</button>
```

```css
.atl-toggle-sun  { display: none; }
.atl-toggle-moon { display: block; }
[data-theme="light"] .atl-toggle-sun  { display: block; color: var(--atl-amber); }
[data-theme="light"] .atl-toggle-moon { display: none; }
```

---

## SECTION 27: MOBILE-FIRST RESPONSIVE SYSTEM

All CSS above is written mobile-first (base = narrowest viewport, `@media (min-width: ...)` for wider). Additionally:

```css
/* ── MOBILE-FIRST BREAKPOINTS ────────────────────── */

/* Sidebar: hidden on mobile, slide in */
@media (max-width: 767px) {
  .tm-admin-sidebar {
    transform: translateX(-100%);
    transition: transform 0.3s ease;
    position: fixed;
    z-index: 200;
  }
  .tm-admin-sidebar.mobile-open { transform: translateX(0); }
  .tm-admin-main { margin-left: 0 !important; width: 100% !important; }
}

/* Admin control bar: stack search below on narrow screens */
@media (max-width: 599px) {
  .adm-header__inner { flex-wrap: wrap; gap: 8px; }
  .adm-header__centre { order: 3; width: 100%; max-width: none; }
  .adm-btn-label { display: none; }  /* hide text labels next to icon buttons */
}

/* Dashboard summary grid: 2 col on mobile, up to 5 col on wide */
.db-summary-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 12px;
}
@media (min-width: 480px)  { .db-summary-grid { grid-template-columns: repeat(2, 1fr); gap: 14px; } }
@media (min-width: 768px)  { .db-summary-grid { grid-template-columns: repeat(3, 1fr); gap: 16px; } }
@media (min-width: 1024px) { .db-summary-grid { grid-template-columns: repeat(5, 1fr); } }

/* Social grid */
.db-social-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 12px;
}
@media (min-width: 480px)  { .db-social-grid { grid-template-columns: repeat(2, 1fr); } }
@media (min-width: 640px)  { .db-social-grid { grid-template-columns: repeat(3, 1fr); } }
@media (min-width: 1024px) { .db-social-grid { grid-template-columns: repeat(5, 1fr); } }

/* Tables: safe overflow on mobile */
@media (max-width: 599px) {
  .table-responsive { overflow-x: auto; -webkit-overflow-scrolling: touch; }
  .table td, .table th { white-space: normal; min-width: 80px; }
}

/* Modal dialog: full width on mobile */
@media (max-width: 599px) {
  .modal-dialog { margin: 10px; width: auto; }
  .modal-content { border-radius: var(--atl-r-lg) !important; }
  .modal-footer { flex-wrap: wrap; }
  .modal-footer .btn { flex: 1; min-width: 120px; text-align: center; }
}

/* Nav tabs: scrollable on narrow screens */
@media (max-width: 599px) {
  .nav-tabs { flex-wrap: nowrap; overflow-x: auto; -webkit-overflow-scrolling: touch; }
  .nav-tabs > li > a { white-space: nowrap; }
}

/* Admin sections: padding scales */
@media (max-width: 479px) {
  .admin-section { padding: 16px 12px; }
}
```

---

## SECTION 28: HARDCODED COLOUR AUDIT

The following patterns appear repeatedly across inline styles throughout `admin.html`. Replace all instances with the corresponding CSS variable:

| Hardcoded value | Replace with | Usage |
|---|---|---|
| `#0a0a0a`, `#111`, `#111111` | `var(--atl-paper)` | Backgrounds |
| `#1a1a1a`, `#1c1c1c` | `var(--atl-card)` | Card backgrounds |
| `#222`, `#242424` | `var(--atl-surface2)` | Elevated surfaces |
| `#0d0d0d`, `#0f0f0f` | `var(--atl-input-bg)` | Input backgrounds |
| `#333`, `#2a2a2a`, `#252525` | `var(--atl-line)` | Borders |
| `#444`, `#3a3a3a` | `var(--atl-line-strong)` | Strong borders |
| `#ffffff`, `#fff`, `#eee`, `#e0e0e0` | `var(--atl-ink)` | Primary text |
| `#ccc`, `#bbb`, `#ddd` | `var(--atl-ink-dim)` | Slightly dimmed text |
| `#aaa`, `#999`, `#888` | `var(--atl-muted)` | Secondary text |
| `#666`, `#555` | `var(--atl-muted-dim)` | Tertiary text |
| `#D4AF37`, `#d4af37` | `var(--atl-amber)` | Gold accent |
| `#E8C14B`, `#C09A1A` | `var(--atl-amber-hover)` | Gold hover |
| `rgba(212,175,55,0.1*)` | `var(--atl-amber-dim)` | Gold tint backgrounds |
| `rgba(212,175,55,0.3*)` | `var(--atl-amber-border)` | Gold tint borders |
| `#4CAF50`, `#66BB6A`, `#4ade80` | `var(--atl-sage)` | Success/positive |
| `#ef5350`, `#EF5350`, `#f87171` | `var(--atl-clay)` | Danger/negative |
| `#60a5fa`, `#64B5F6`, `#2196F3` | `var(--atl-blue)` | Info/accepted |
| `#FFA726`, `#FF9800`, `#fb923c` | `var(--atl-orange)` | Warning/outstanding |
| `#9C27B0`, `#AB47BC` | `var(--atl-purple)` | Special/purple |

**Process:** Search for each hardcoded value across all inline `style=` attributes and the inline `<style>` blocks in `admin.html`. Replace using CSS variables. Where inline styles set colours on elements that now have a class-based style, remove the inline style entirely.

---

## SECTION 29: VALIDATION CHECKLIST

### Global visual consistency
- [ ] All page backgrounds use `var(--atl-paper)` — no `#111`, `#1a1a1a` on page-level backgrounds
- [ ] All card surfaces use `var(--atl-card)` with 1px `var(--atl-line)` border
- [ ] All elevated panels use `var(--atl-surface2)`
- [ ] All text uses `var(--atl-ink)` (primary) or `var(--atl-muted)` (secondary)
- [ ] All gold accents use `var(--atl-amber)` — no hardcoded `#D4AF37`
- [ ] Cormorant Garamond on all `h1`–`h4`, display values, event names, stat values
- [ ] Outfit on all body text, labels, buttons, form controls, metadata
- [ ] JetBrains Mono on all IDs, counts, timestamps, uppercase tags, breadcrumbs
- [ ] Section headers use the `atl-section-hd` / `atl-section-eyebrow` / `atl-section-rule` pattern
- [ ] Film grain overlay is visible globally (subtle, ≤4%)
- [ ] Radial gold glow in body background (barely perceptible)

### Component uniformity
- [ ] All buttons across every section use the same three-variant system (primary/ghost/danger)
- [ ] All form inputs across every section have identical styling (dark inset, amber focus ring)
- [ ] All modals match the Atelier modal pattern (surface2 header, card body, surface2 footer)
- [ ] All Bootstrap nav-tabs look like the Atelier nav-tab pattern
- [ ] All Bootstrap tables look like the Atelier table pattern
- [ ] Status badges consistently use the `atl-badge--*` system across all sections

### Booking section — no regression
- [ ] Booking section (`#bookingsAdmin`) is visually unchanged from the previous pass
- [ ] Expanded card panels still use `.atl-det-card`, `.atl-det-dl`, `.atl-det-table` etc.
- [ ] Theme toggle in booking section still works

### Login screen
- [ ] Login card uses `var(--atl-card)` background
- [ ] Form inputs match global input styles
- [ ] Login button matches primary button variant
- [ ] Typography updated to Cormorant/Outfit/JetBrains Mono

### Sidebar
- [ ] Sidebar uses `var(--atl-sidebar-bg)` (stays dark in both themes)
- [ ] Active nav item has amber left-border indicator + amber text + amber icon
- [ ] Group labels use JetBrains Mono uppercase tracked style
- [ ] Hover states show amber tint

### Admin control bar
- [ ] Top bar uses `var(--atl-topbar-bg)` (flips to white in light mode)
- [ ] Search input matches global form input style
- [ ] Dropdowns match the Atelier dropdown menu style
- [ ] Theme toggle button in top bar works

### Dashboard
- [ ] Stat cards have `var(--atl-card)` surface with hover gold border
- [ ] Stat values use Cormorant Garamond
- [ ] Stat labels use JetBrains Mono uppercase
- [ ] Social cards match the `.db-social-card` pattern
- [ ] Trend up/down use `var(--atl-sage)` / `var(--atl-clay)`

### Finance
- [ ] Finance summary tiles replace hardcoded green/orange/blue text with semantic classes
- [ ] Financial tables match global table pattern
- [ ] Export and action buttons match global button variants

### Light/Dark themes
- [ ] Dark mode: all 20 sections look correct — no contrast failures
- [ ] Light mode: all 20 sections look correct — warm ivory, not blue-white
- [ ] Sidebar stays dark in light mode (sidebar-bg token)
- [ ] Theme toggle switches the entire page instantly
- [ ] No flash on page reload
- [ ] No unmigrated hardcoded hex values that break light mode

### Mobile/Responsive
- [ ] Dashboard stat grid is 2-col on mobile, 5-col on desktop
- [ ] Sidebar slides off-screen on mobile, revealed by hamburger
- [ ] Admin control bar search stacks below icons on narrow screens
- [ ] All tables are scrollable horizontally on mobile (no overflow)
- [ ] All modals are full-width on mobile
- [ ] Nav tabs scroll horizontally on mobile instead of wrapping uglily
- [ ] All interactive elements meet 44px minimum tap target

### Functional regression (nothing broke)
- [ ] Login and logout work
- [ ] Tab switching (`switchTab()`) works for all 20 sections
- [ ] All Bootstrap modals open and close correctly
- [ ] All form submissions reach their API endpoints
- [ ] Search in control bar returns results
- [ ] Notifications panel populates
- [ ] Booking cards expand, lazy-load, and all actions work
- [ ] Calendar renders and blockout chips are interactive
- [ ] Finance tables load and filter correctly
- [ ] Gallery uploads work
- [ ] Newsletter sends work
- [ ] All delete/confirm actions work

---

*End of prompt. The completed admin.html should read as a single, cohesive product — every page and section feeling like it was designed as one system from the beginning, unified by the Atelier Obsidian design language.*
