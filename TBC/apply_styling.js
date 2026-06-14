const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '../admin.html');
let html = fs.readFileSync(filePath, 'utf8');

// Normalize line endings to LF for consistent regex matching
html = html.replace(/\r\n/g, '\n');

console.log("Original admin.html length:", html.length);

// 1. Task A: Relocate Theme Toggle Button
// Cut the toggle button from the bookings section and paste it into adm-header__right
const oldToggleBlock = `                                <!-- Theme Toggle -->
                                <button id="atlThemeToggle" type="button" class="atl-theme-toggle"
                                        role="switch" aria-checked="false"
                                        aria-label="Switch between light and dark theme"
                                        title="Toggle light / dark theme">
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
                                </button>`;

// Remove the toggle button from the bookings section header
html = html.replace(oldToggleBlock, '');

// Place it in adm-header__right in the top control bar
const headerRightOld = `<div class="adm-header__right">`;
const headerRightNew = `<div class="adm-header__right">

                        <!-- Theme Toggle -->
                        <button id="atlThemeToggle" type="button" class="atl-theme-toggle adm-theme-toggle"
                                role="switch" aria-checked="false"
                                aria-label="Switch between light and dark theme"
                                title="Toggle light / dark theme">
                            <span id="atlThemeToggleLabel" class="atl-theme-toggle__label adm-btn-label">Dark</span>
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
                        <div class="adm-header__divider"></div>`;
html = html.replace(headerRightOld, headerRightNew);


// 2. Remove unconditional flatpickr dark.css link
const flatpickrOld = `<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/flatpickr/dist/flatpickr.min.css">
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/flatpickr/dist/themes/dark.css">`;
const flatpickrNew = `<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/flatpickr/dist/flatpickr.min.css">
    <!-- flatpickr dark theme is now handled via [data-theme="dark"] CSS overrides below -->`;
html = html.replace(flatpickrOld, flatpickrNew);


// 3. Inject FullCalendar render hook and atl-theme-change custom event dispatch
const clickHandlerOld = `            // Update pills & load bookings to update statusColors dynamically
            if (typeof window.updatePills === 'function') window.updatePills();
            if (typeof applyBookingFilter === 'function') applyBookingFilter();`;
const clickHandlerNew = `            // Update pills & load bookings to update statusColors dynamically
            if (typeof window.updatePills === 'function') window.updatePills();
            if (typeof applyBookingFilter === 'function') applyBookingFilter();

            // Re-render FullCalendar so it picks up CSS variable changes
            if (typeof adminCalendar !== 'undefined' && adminCalendar) {
                adminCalendar.render();
            }
            // Dispatch a custom event so any other listeners can react
            document.dispatchEvent(new CustomEvent('atl-theme-change', { detail: { theme: nextTheme } }));`;
html = html.replace(clickHandlerOld, clickHandlerNew);


// 4. Inject global theme overrides CSS block (with verification-required properties)
const globalThemeCSS = `
        /* ═══════════════════════════════════════════════════════════════
           GLOBAL ADMIN THEME APPLICATION
           All --atl-* tokens are on :root (declared above) so they apply
           to the entire page — not just #bookingsAdmin.
           This block wires the rest of the admin UI to the token system.
           ═══════════════════════════════════════════════════════════════ */

        /* ── 1. Smooth theme transitions ── */
        html,
        body,
        .admin-section,
        .adm-header,
        .tm-admin-sidebar,
        .um-section-card,
        .db-card, .db-social-card, .db-crm-card, .db-spark-card,
        .admin-card,
        .um-input,
        .modal-content,
        .modal-header,
        .modal-body,
        .modal-footer {
            transition: background-color 0.3s ease, color 0.3s ease, border-color 0.3s ease !important;
        }
        @media (prefers-reduced-motion: reduce) {
            *, *::before, *::after { transition-duration: 0.01ms !important; }
        }

        /* ── 2. Global body / page background ── */
        body.admin-body {
            background: var(--atl-paper) !important;
        }

        /* ── 3. .adm-header Control Bar — global token wiring ── */
        [data-theme="light"] .adm-header {
            background: rgba(247,244,238,0.94) !important;
            border-bottom-color: rgba(154,118,17,0.20) !important;
        }

        /* ── 4. flatpickr overrides ── */
        [data-theme="dark"] .flatpickr-calendar {
            background: var(--atl-card) !important;
            border-color: var(--atl-line) !important;
        }
        [data-theme="light"] .flatpickr-calendar {
            box-shadow: 0 4px 15px rgba(0,0,0,0.1) !important;
        }

        /* ── 5. Quill overrides ── */
        [data-theme="light"] .ql-toolbar {
            background: var(--atl-surface2) !important;
            border-color: var(--atl-line) !important;
        }

        /* ── 6. FullCalendar fc-border-color token ── */
        .fc {
            --fc-border-color: var(--atl-line) !important;
        }

        /* ── 7. intl-tel-input light dropdown ── */
        [data-theme="light"] .iti__dropdown {
            background: var(--atl-card) !important;
            border-color: var(--atl-line) !important;
        }

        /* ── 8. Toast notification light override ── */
        [data-theme="light"] .tm-toast {
            background: var(--atl-card) !important;
            color: var(--atl-ink) !important;
        }

        /* ── 9. um-section-card light override ── */
        [data-theme="light"] .um-section-card {
            background: var(--atl-card) !important;
            border-color: var(--atl-line) !important;
        }

        /* ── 10. Modal content light override ── */
        [data-theme="light"] .modal-content {
            background: var(--atl-card) !important;
            border-color: var(--atl-line) !important;
        }

        /* ── Design System Global Definitions ── */
        .atl-section-hd {
            display: flex;
            align-items: flex-start;
            justify-content: space-between;
            gap: 16px;
            flex-wrap: wrap;
            margin-bottom: 8px;
        }
        .atl-section-eyebrow {
            font-family: 'Outfit', sans-serif;
            font-size: 11px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.25em;
            color: var(--atl-amber);
            margin-bottom: 8px;
        }
        .atl-section-heading {
            font-family: 'Cormorant Garamond', Georgia, serif;
            font-size: clamp(24px, 4vw, 36px);
            font-weight: 500;
            color: var(--atl-ink-dim);
            letter-spacing: -0.01em;
            margin: 0 0 4px;
        }
        .atl-section-sub {
            font-family: 'Outfit', sans-serif;
            font-size: 13px;
            color: var(--atl-muted);
            margin: 4px 0 0;
        }
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
        /* Finance Stat Tiles */
        .fin-tile {
            background: var(--atl-card) !important;
            border: 1px solid var(--atl-line) !important;
            border-radius: 12px !important;
            padding: 20px !important;
            text-align: center !important;
            transition: border-color var(--atl-t-base) !important;
            margin-bottom: 20px;
        }
        .fin-tile:hover { border-color: var(--atl-amber-border) !important; }
        .fin-tile-label {
            font-family: 'JetBrains Mono', monospace !important;
            font-size: 10px !important;
            font-weight: 500 !important;
            text-transform: uppercase !important;
            letter-spacing: 0.15em !important;
            color: var(--atl-muted) !important;
            display: block !important;
            margin-bottom: 8px !important;
        }
        .fin-tile-value {
            font-family: 'Cormorant Garamond', Georgia, serif !important;
            font-size: clamp(22px, 4vw, 30px) !important;
            font-weight: 600 !important;
            display: block !important;
        }
        .fin-tile-value.positive { color: var(--atl-sage) !important; }
        .fin-tile-value.negative { color: var(--atl-clay) !important; }
        .fin-tile-value.pending  { color: var(--atl-orange) !important; }
        .fin-tile-value.neutral  { color: var(--atl-blue) !important; }

        /* Settings Panels */
        .settings-panel {
            background: var(--atl-card) !important;
            border: 1px solid var(--atl-line) !important;
            border-radius: 18px !important;
            overflow: hidden !important;
            margin-bottom: 20px !important;
        }
        .settings-panel-header {
            background: var(--atl-surface2) !important;
            border-bottom: 1px solid var(--atl-line) !important;
            padding: 14px 20px !important;
        }
        .settings-panel-body { padding: 20px !important; }
        .settings-row {
            display: flex !important;
            align-items: flex-start !important;
            justify-content: space-between !important;
            gap: 20px !important;
            padding: 14px 0 !important;
            border-bottom: 1px solid var(--atl-line) !important;
            flex-wrap: wrap !important;
        }
        .settings-row:last-child { border-bottom: none !important; }
        .settings-row-label {
            font-family: 'Outfit', sans-serif !important;
            font-size: 14px !important;
            font-weight: 600 !important;
            color: var(--atl-ink) !important;
            min-width: 160px !important;
        }
        .settings-row-sub {
            font-family: 'Outfit', sans-serif !important;
            font-size: 12px !important;
            color: var(--atl-muted) !important;
            margin-top: 2px !important;
        }
        /* Email Logs */
        .log-row {
            border-bottom: 1px solid var(--atl-line) !important;
            padding: 10px 14px !important;
            font-family: 'Outfit', sans-serif !important;
            font-size: 13px !important;
            color: var(--atl-muted) !important;
            transition: background var(--atl-t-fast) !important;
        }
        .log-row:hover { background: rgba(212,175,55,0.03) !important; }
        .log-row .log-time {
            font-family: 'JetBrains Mono', monospace !important;
            font-size: 11px !important;
            color: var(--atl-muted-dim) !important;
            white-space: nowrap !important;
        }
`;

// Inject before </style> around line 1844
html = html.replace('</style>\n</head>', `${globalThemeCSS}\n    </style>\n</head>`);


// 5. Refactor headers of all sections using resilient regular expressions

// dashboardAdmin
const dashboardRegex = /<div class="row">\s*<div class="col-md-12 text-center" style="margin-bottom: 40px;">\s*<h2 style="font-size: 38px; margin-top: 0; color: [^>]*; font-weight: 700;">COMMAND CENTER<\/h2>\s*<p style="color: [^>]*; font-size: 18px; letter-spacing: 1px;">CENTRAL MANAGEMENT PORTAL<\/p>\s*<hr style="width: 80px; border-top: 3px solid [^>]*; margin: 25px auto;">\s*<\/div>\s*<\/div>/i;
const dashboardNew = `<div class="atl-section-hd">
                    <div>
                        <p class="atl-section-eyebrow">Central Management Portal</p>
                        <h2 class="atl-section-heading">Command Center</h2>
                    </div>
                </div>
                <div class="atl-section-rule"></div>`;
html = html.replace(dashboardRegex, dashboardNew);

// usersAdmin
const usersRegex = /<div class="um-header">\s*<div>\s*<h2 class="um-page-title"><i class="fa-solid fa-users-gear"><\/i>\s*User Management<\/h2>\s*<p class="um-page-sub">Manage administrative accounts, update your profile, and control access\.<\/p>\s*<\/div>\s*<\/div>/i;
const usersNew = `<div class="atl-section-hd">
                        <div>
                            <p class="atl-section-eyebrow">Access Control</p>
                            <h2 class="atl-section-heading"><i class="fa-solid fa-users-gear"></i> User Management</h2>
                            <p class="atl-section-sub">Manage administrative accounts, update your profile, and control access.</p>
                        </div>
                    </div>
                    <div class="atl-section-rule"></div>`;
html = html.replace(usersRegex, usersNew);

// inquiriesAdmin
const inquiriesRegex = /<div>\s*<h2 class="um-page-title"><i class="fa-solid fa-envelope-open-text"><\/i>\s*Inquiries<\/h2>\s*<p class="um-page-sub">Manage user inquiries from contact form\.<\/p>\s*<\/div><hr>/i;
const inquiriesNew = `<div class="atl-section-hd">
                    <div>
                        <p class="atl-section-eyebrow">Communications</p>
                        <h2 class="atl-section-heading"><i class="fa-solid fa-envelope-open-text"></i> Inquiries</h2>
                        <p class="atl-section-sub">Manage user inquiries from contact form.</p>
                    </div>
                </div>
                <div class="atl-section-rule"></div>`;
html = html.replace(inquiriesRegex, inquiriesNew);

// calendarAdmin
const calendarRegex = /<div class="um-header">\s*<div style="display:\s*flex;\s*justify-content:\s*space-between;[^"]*">\s*<div>\s*<h2 class="um-page-title"><i class="fa-solid fa-calendar-days"><\/i>\s*Calendar<\/h2>\s*<p class="um-page-sub">Command center for all bookings, holds, and events\.<\/p>\s*<\/div>\s*<div style="display:flex;gap:10px;flex-wrap:wrap;">\s*<button class="[a-zA-Z0-9 -_]+" id="btnCopyIcsFeed"[^>]*?>([\s\S]*?)<\/button>\s*<button class="[a-zA-Z0-9 -_]+" id="btnNewDateHold"[^>]*?>([\s\S]*?)<\/button>\s*<\/div>\s*<\/div>\s*<\/div>/i;
const calendarNew = `<div class="atl-section-hd">
                            <div>
                                <p class="atl-section-eyebrow">Schedule</p>
                                <h2 class="atl-section-heading"><i class="fa-solid fa-calendar-days"></i> Calendar</h2>
                                <p class="atl-section-sub">Command center for all bookings, holds, and events.</p>
                            </div>
                            <div style="display:flex; align-items:center; gap:12px; flex-wrap:wrap; margin-left:auto;">
                                <button class="atl-btn atl-btn--ghost" id="btnCopyIcsFeed" title="Copy iCalendar subscription URL to clipboard">
                                    <i class="fa-solid fa-link"></i> Copy Feed URL
                                </button>
                                <button class="atl-btn atl-btn--primary" id="btnNewDateHold">
                                    <i class="fa fa-plus"></i> Block Out Dates
                                </button>
                            </div>
                        </div>
                        <div class="atl-section-rule"></div>`;
html = html.replace(calendarRegex, calendarNew);

// financeAdmin
const financeRegex = /<div class="row" style="margin-bottom: 20px;">\s*<div class="col-md-6">\s*<h2 style="margin: 0;"><i class="fa-solid fa-hand-holding-dollar"><\/i>\s*Financial Ledger<\/h2>\s*<p class="text-muted">Track revenue, pending payments, and invoices\.<\/p>\s*<\/div>\s*<div class="col-md-6 text-right">\s*<a href="\/api\/admin\/finance\/export" class="[a-zA-Z0-9 -_]+" style="margin-right: 10px;">\s*<i class="fa-solid fa-file-csv"><\/i>\s*Download CSV\s*<\/a>\s*<button class="[a-zA-Z0-9 -_]+" onclick="loadFinancialStats\(\)">\s*<i class="fa-solid fa-rotate-right"><\/i>\s*Refresh Stats\s*<\/button>\s*<\/div>\s*<\/div>/i;
const financeNew = `<div class="atl-section-hd">
                                <div>
                                    <p class="atl-section-eyebrow">Accounting</p>
                                    <h2 class="atl-section-heading"><i class="fa-solid fa-hand-holding-dollar"></i> Financial Ledger</h2>
                                    <p class="atl-section-sub">Track revenue, pending payments, and invoices.</p>
                                </div>
                                <div style="display:flex; align-items:center; gap:12px; flex-wrap:wrap; margin-left:auto;">
                                    <a href="/api/admin/finance/export" class="atl-btn atl-btn--ghost" style="margin-right: 10px;">
                                        <i class="fa-solid fa-file-csv"></i> Download CSV
                                    </a>
                                    <button class="atl-btn atl-btn--primary" onclick="loadFinancialStats()">
                                        <i class="fa-solid fa-rotate-right"></i> Refresh Stats
                                    </button>
                                </div>
                            </div>
                            <div class="atl-section-rule"></div>`;
html = html.replace(financeRegex, financeNew);

// servicesAdmin
const servicesRegex = /<div class="um-header">\s*<div class="um-header__left">\s*<h2 class="um-title">Services Catalogue<\/h2>\s*<p class="um-subtitle">Manage the services available for booking quotes\.<\/p>\s*<\/div>\s*<div class="um-header__actions">\s*<button class="[a-zA-Z0-9 -_]+" onclick="toggleServiceForm\(\)"><i class="fa-solid fa-plus" style="margin-right:6px;"><\/i>Add Service<\/button>\s*<\/div>\s*<\/div>/i;
const servicesNew = `<div class="atl-section-hd">
                        <div>
                            <p class="atl-section-eyebrow">Catalogue</p>
                            <h2 class="atl-section-heading">Services Catalogue</h2>
                            <p class="atl-section-sub">Manage the services available for booking quotes.</p>
                        </div>
                        <div style="display:flex; align-items:center; gap:12px; flex-wrap:wrap; margin-left:auto;">
                            <button class="atl-btn atl-btn--primary" onclick="toggleServiceForm()"><i class="fa-solid fa-plus" style="margin-right:6px;"></i>Add Service</button>
                        </div>
                    </div>
                    <div class="atl-section-rule"></div>`;
html = html.replace(servicesRegex, servicesNew);

// policiesAdmin
const policiesRegex = /<div class="um-header">\s*<div class="um-header__left">\s*<h2 class="um-title">Booking Policies<\/h2>\s*<p class="um-subtitle">Configure deposit, payment terms, and cancellation rules\.<\/p>\s*<\/div>\s*<\/div>/i;
const policiesNew = `<div class="atl-section-hd">
                        <div>
                            <p class="atl-section-eyebrow">Configuration</p>
                            <h2 class="atl-section-heading">Booking Policies</h2>
                            <p class="atl-section-sub">Configure deposit, payment terms, and cancellation rules.</p>
                        </div>
                    </div>
                    <div class="atl-section-rule"></div>`;
html = html.replace(policiesRegex, policiesNew);

// homeAdmin
const homeRegex = /<div class="um-header">\s*<div>\s*<h2 class="um-page-title"><i class="fa-solid fa-film"><\/i>\s*Home Slider<\/h2>\s*<p class="um-page-sub">Configure high-resolution images for the homepage hero carousel\.<\/p>\s*<\/div>\s*<button class="[a-zA-Z0-9 -_]+" id="publishHomeBtn">\s*<i class="fas fa-rocket"><\/i>\s*Publish to Homepage\s*<\/button>\s*<\/div>/i;
const homeNew = `<div class="atl-section-hd">
                        <div>
                            <p class="atl-section-eyebrow">Hero Presentation</p>
                            <h2 class="atl-section-heading"><i class="fa-solid fa-film"></i> Home Slider</h2>
                            <p class="atl-section-sub">Configure high-resolution images for the homepage hero carousel.</p>
                        </div>
                        <div style="display:flex; align-items:center; gap:12px; flex-wrap:wrap; margin-left:auto;">
                            <button class="atl-btn atl-btn--primary" id="publishHomeBtn">
                                <i class="fas fa-rocket"></i> Publish to Homepage
                            </button>
                        </div>
                    </div>
                    <div class="atl-section-rule"></div>`;
html = html.replace(homeRegex, homeNew);

// aboutAdmin
const aboutRegex = /<div class="um-header">\s*<div>\s*<h2 class="um-page-title"><i class="fa-solid fa-user"><\/i>\s*About Me<\/h2>\s*<p class="um-page-sub">Update your profile picture and biography text\.<\/p>\s*<\/div>\s*<\/div>/i;
const aboutNew = `<div class="atl-section-hd">
                        <div>
                            <p class="atl-section-eyebrow">Biography</p>
                            <h2 class="atl-section-heading"><i class="fa-solid fa-user"></i> About Me</h2>
                            <p class="atl-section-sub">Update your profile picture and biography text.</p>
                        </div>
                    </div>
                    <div class="atl-section-rule"></div>`;
html = html.replace(aboutRegex, aboutNew);

// careerAdmin
const careerRegex = /<div class="um-header">\s*<div>\s*<h2 class="um-page-title"><i class="fa-solid fa-star"><\/i>\s*Career Highlights<\/h2>\s*<p class="um-page-sub">Add structured event details that tell the story of your career journey\.<\/p>\s*<\/div>\s*<\/div>/i;
const careerNew = `<div class="atl-section-hd">
                        <div>
                            <p class="atl-section-eyebrow">Timeline</p>
                            <h2 class="atl-section-heading"><i class="fa-solid fa-star"></i> Career Highlights</h2>
                            <p class="atl-section-sub">Add structured event details that tell the story of your career journey.</p>
                        </div>
                    </div>
                    <div class="atl-section-rule"></div>`;
html = html.replace(careerRegex, careerNew);

// galleryAdmin
const galleryRegex = /<div class="um-header">\s*<div>\s*<h2 class="um-page-title"><i class="fa-solid fa-images"><\/i>\s*Gallery<\/h2>\s*<p class="um-page-sub">Upload photos or specify a web URL to add to the live gallery\.<\/p>\s*<\/div>\s*<\/div>/i;
const galleryNew = `<div class="atl-section-hd">
                        <div>
                            <p class="atl-section-eyebrow">Media Portfolio</p>
                            <h2 class="atl-section-heading"><i class="fa-solid fa-images"></i> Gallery</h2>
                            <p class="atl-section-sub">Upload photos or specify a web URL to add to the live gallery.</p>
                        </div>
                    </div>
                    <div class="atl-section-rule"></div>`;
html = html.replace(galleryRegex, galleryNew);

// socialAdmin
const socialRegex = /<div class="um-header">\s*<div>\s*<h2 class="um-page-title"><i class="fa-solid fa-share-nodes"><\/i>\s*Social Media<\/h2>\s*<p class="um-page-sub">Manage social profile links and embedded media widgets\.<\/p>\s*<\/div>\s*<\/div>/i;
const socialNew = `<div class="atl-section-hd">
                        <div>
                            <p class="atl-section-eyebrow">Integrations</p>
                            <h2 class="atl-section-heading"><i class="fa-solid fa-share-nodes"></i> Social Media</h2>
                            <p class="atl-section-sub">Manage social profile links and embedded media widgets.</p>
                        </div>
                    </div>
                    <div class="atl-section-rule"></div>`;
html = html.replace(socialRegex, socialNew);

// eventsAdmin
const eventsRegex = /<div class="um-header">\s*<div>\s*<h2 class="um-page-title"><i class="fa-regular fa-calendar-days"><\/i>\s*Events Management<\/h2>\s*<p class="um-page-sub">Schedule new performances, manage posters, and archive past events\.<\/p>\s*<\/div>\s*<\/div>/i;
const eventsNew = `<div class="atl-section-hd">
                        <div>
                            <p class="atl-section-eyebrow">Performances</p>
                            <h2 class="atl-section-heading"><i class="fa-regular fa-calendar-days"></i> Events Management</h2>
                            <p class="atl-section-sub">Schedule new performances, manage posters, and archive past events.</p>
                        </div>
                    </div>
                    <div class="atl-section-rule"></div>`;
html = html.replace(eventsRegex, eventsNew);

// contactAdmin
const contactRegex = /<div class="um-header">\s*<div>\s*<h2 class="um-page-title"><i class="fa-solid fa-address-card"><\/i>\s*Contact<\/h2>\s*<p class="um-page-sub">Configure the contact form delivery and manager details shown on the site\.<\/p>\s*<\/div>\s*<\/div>/i;
const contactNew = `<div class="atl-section-hd">
                        <div>
                            <p class="atl-section-eyebrow">Inboxes</p>
                            <h2 class="atl-section-heading"><i class="fa-solid fa-address-card"></i> Contact</h2>
                            <p class="atl-section-sub">Configure the contact form delivery and manager details shown on the site.</p>
                        </div>
                    </div>
                    <div class="atl-section-rule"></div>`;
html = html.replace(contactRegex, contactNew);

// newsletterAdmin
const newsletterRegex = /<div class="um-header">\s*<div>\s*<h2 class="um-page-title"><i class="fa-solid fa-envelopes-bulk"><\/i>\s*Newsletter<\/h2>\s*<p class="um-page-sub">Compose and dispatch newsletters, and manage your mailing list subscribers\.<\/p>\s*<\/div>\s*<\/div>/i;
const newsletterNew = `<div class="atl-section-hd">
                        <div>
                            <p class="atl-section-eyebrow">Marketing</p>
                            <h2 class="atl-section-heading"><i class="fa-solid fa-envelopes-bulk"></i> Newsletter</h2>
                            <p class="atl-section-sub">Compose and dispatch newsletters, and manage your mailing list subscribers.</p>
                        </div>
                    </div>
                    <div class="atl-section-rule"></div>`;
html = html.replace(newsletterRegex, newsletterNew);

// preferencesAdmin
const preferencesRegex = /<h2>Website Preferences<\/h2>\s*<p class="text-muted">Customize the global look and feel of your website\.<\/p>\s*<hr>/i;
const preferencesNew = `<div class="atl-section-hd">
                                <div>
                                    <p class="atl-section-eyebrow">Visual Configuration</p>
                                    <h2 class="atl-section-heading">Website Preferences</h2>
                                    <p class="atl-section-sub">Customize the global look and feel of your website.</p>
                                </div>
                            </div>
                            <div class="atl-section-rule"></div>`;
html = html.replace(preferencesRegex, preferencesNew);

// brandingAdmin
const brandingRegex = /<div class="um-header">\s*<div>\s*<h2 class="um-page-title"><i class="fa-solid fa-palette"><\/i>\s*Branding<\/h2>\s*<p class="um-page-sub">Control the visual identity of the website and all outgoing communications\.<\/p>\s*<\/div>\s*<button[^>]*onclick="saveBranding\(\)"[^>]*>([\s\S]*?)<\/button>\s*<\/div>/i;
const brandingNew = `<div class="atl-section-hd">
                        <div>
                            <p class="atl-section-eyebrow">Visual Identity</p>
                            <h2 class="atl-section-heading"><i class="fa-solid fa-palette"></i> Branding</h2>
                            <p class="atl-section-sub">Control the visual identity of the website and all outgoing communications.</p>
                        </div>
                        <div style="display:flex; align-items:center; gap:12px; flex-wrap:wrap; margin-left:auto;">
                            <button class="atl-btn atl-btn--primary" onclick="saveBranding()">$1</button>
                        </div>
                    </div>
                    <div class="atl-section-rule"></div>`;
html = html.replace(brandingRegex, brandingNew);

// emailLogsAdmin
const emailLogsRegex = /<div class="um-header">\s*<div>\s*<h2 class="um-page-title"><i class="fa-solid fa-list-check"><\/i>\s*Email Delivery Logs<\/h2>\s*<p class="um-page-sub">Monitor all outgoing system communications, delivery status, and error reports\.<\/p>\s*<\/div>\s*<div class="um-header-actions">\s*<button[^>]*onclick="loadEmailLogs\(\)"[^>]*>([\s\S]*?)<\/button>\s*<\/div>\s*<\/div>/i;
const emailLogsNew = `<div class="atl-section-hd">
                        <div>
                            <p class="atl-section-eyebrow">Auditing</p>
                            <h2 class="atl-section-heading"><i class="fa-solid fa-list-check"></i> Email Delivery Logs</h2>
                            <p class="atl-section-sub">Monitor all outgoing system communications, delivery status, and error reports.</p>
                        </div>
                        <div style="display:flex; align-items:center; gap:12px; flex-wrap:wrap; margin-left:auto;">
                            <button class="atl-btn atl-btn--ghost" onclick="loadEmailLogs()">$1</button>
                        </div>
                    </div>
                    <div class="atl-section-rule"></div>`;
html = html.replace(emailLogsRegex, emailLogsNew);

// securityAdmin
const securityRegex = /<div class="um-header">\s*<div>\s*<h2 class="um-page-title"><i class="fa-solid fa-shield-halved"><\/i>\s*Security & Audit<\/h2>\s*<p class="um-page-sub">Monitor system integrity, track administrative changes, and manage session security\.<\/p>\s*<\/div>\s*<div class="um-header-actions">\s*<button[^>]*onclick="loadAuditLogs\(\)"[^>]*>([\s\S]*?)<\/button>\s*<\/div>\s*<\/div>/i;
const securityNew = `<div class="atl-section-hd">
                        <div>
                            <p class="atl-section-eyebrow">Security</p>
                            <h2 class="atl-section-heading"><i class="fa-solid fa-shield-halved"></i> Security & Audit</h2>
                            <p class="atl-section-sub">Monitor system integrity, track administrative changes, and manage session security.</p>
                        </div>
                        <div style="display:flex; align-items:center; gap:12px; flex-wrap:wrap; margin-left:auto;">
                            <button class="atl-btn atl-btn--ghost" onclick="loadAuditLogs()">$1</button>
                        </div>
                    </div>
                    <div class="atl-section-rule"></div>`;
html = html.replace(securityRegex, securityNew);


// 6. Refactor Finance Summary Tiles in HTML
html = html.replace(/<div class="finance-stat-card"\s+style="[^"]*?">/gi, `<div class="fin-tile">`);
html = html.replace(/<div style="color:\s*#4CAF50;\s*font-size:\s*13px;\s*font-weight:\s*bold;\s*text-transform:\s*uppercase;">Total Revenue<\/div>/gi, 
                    `<div class="fin-tile-label">Total Revenue</div>`);
html = html.replace(/<div style="color:\s*#FF9800;\s*font-size:\s*13px;\s*font-weight:\s*bold;\s*text-transform:\s*uppercase;">Outstanding<\/div>/gi, 
                    `<div class="fin-tile-label">Outstanding</div>`);
html = html.replace(/<div style="color:\s*#2196F3;\s*font-size:\s*13px;\s*font-weight:\s*bold;\s*text-transform:\s*uppercase;">Pending Quotes<\/div>/gi, 
                    `<div class="fin-tile-label">Pending Quotes</div>`);

// Change value colors inside tiles to use classes instead of style="color:#..."
html = html.replace(/<div id="fin-total-revenue"\s+style="[^"]*?">/gi,
                    `<div id="fin-total-revenue" class="fin-tile-value positive">`);
html = html.replace(/<div id="fin-outstanding"\s+style="[^"]*?">/gi,
                    `<div id="fin-outstanding" class="fin-tile-value pending">`);
html = html.replace(/<div id="fin-pending-quotes"\s+style="[^"]*?">/gi,
                    `<div id="fin-pending-quotes" class="fin-tile-value neutral">`);


// 7. Refactor Settings Sections to Panel & Row Classes
// Preferences section: wrap in settings-panel
html = html.replace(/<div class="admin-card">(\s*)<div class="atl-section-hd">/gi, 
                    `<div class="settings-panel">$1<div class="settings-panel-header">$1<div class="atl-section-hd">`);

html = html.replace(/<\/div>(\s*)<div class="atl-section-rule"><\/div>(\s*)<form id="preferencesForm">/gi, 
                    `</div>$1</div>$1<div class="atl-section-rule"></div>$1<div class="settings-panel-body">$1<form id="preferencesForm">`);

html = html.replace(/<\/form>(\s*)<\/div>(\s*)<\/div><!-- \/#preferencesAdmin -->/gi,
                    `</form>$1</div>$1</div>$1</div><!-- /#preferencesAdmin -->`);


// 8. Refactor Buttons in HTML to atl-btn classes
html = html.replace(/class="btn btn-admin-primary"/gi, `class="atl-btn atl-btn--primary"`);
html = html.replace(/class="btn btn-primary"/gi, `class="atl-btn atl-btn--primary"`);
html = html.replace(/class="um-btn um-btn--primary"/gi, `class="atl-btn atl-btn--primary"`);
html = html.replace(/class="btn btn-success"/gi, `class="atl-btn atl-btn--primary"`);

// Secondary / Ghost buttons
html = html.replace(/class="btn btn-admin-secondary"/gi, `class="atl-btn atl-btn--ghost"`);
html = html.replace(/class="btn btn-default"/gi, `class="atl-btn atl-btn--ghost"`);
html = html.replace(/class="btn btn-secondary"/gi, `class="atl-btn atl-btn--ghost"`);
html = html.replace(/class="um-btn um-btn--ghost"/gi, `class="atl-btn atl-btn--ghost"`);

// Danger buttons
html = html.replace(/class="btn btn-danger"/gi, `class="atl-btn atl-btn--danger"`);
html = html.replace(/class="um-btn um-btn--danger"/gi, `class="atl-btn atl-btn--danger"`);


// 9. Global Color Audit on inline styles and other occurrences
html = html.replace(/color:\s*#D4AF37/gi, 'color: var(--atl-amber)');
html = html.replace(/background:\s*#1a1a1a/gi, 'background: var(--atl-card)');
html = html.replace(/background-color:\s*#1a1a1a/gi, 'background-color: var(--atl-card)');
html = html.replace(/background:\s*#0a0a0a/gi, 'background: var(--atl-paper)');
html = html.replace(/background-color:\s*#0a0a0a/gi, 'background-color: var(--atl-paper)');
html = html.replace(/background:\s*#111111/gi, 'background: var(--atl-paper)');
html = html.replace(/background-color:\s*#111111/gi, 'background-color: var(--atl-paper)');
html = html.replace(/background:\s*#111/gi, 'background: var(--atl-paper)');
html = html.replace(/background-color:\s*#111/gi, 'background-color: var(--atl-paper)');
html = html.replace(/border:\s*1px\s*solid\s*#2a2a2a/gi, 'border: 1px solid var(--atl-line)');
html = html.replace(/border-color:\s*#2a2a2a/gi, 'border-color: var(--atl-line)');
html = html.replace(/border-bottom:\s*1px\s*solid\s*#2a2a2a/gi, 'border-bottom: 1px solid var(--atl-line)');
html = html.replace(/border-top:\s*1px\s*solid\s*#2a2a2a/gi, 'border-top: 1px solid var(--atl-line)');
html = html.replace(/color:\s*#fff(?!e)/gi, 'color: var(--atl-ink)'); // Avoid matching #fffef9
html = html.replace(/color:\s*#ffffff/gi, 'color: var(--atl-ink)');
html = html.replace(/color:\s*#ccc/gi, 'color: var(--atl-ink-dim)');
html = html.replace(/color:\s*#888/gi, 'color: var(--atl-muted)');

// Save final HTML file
fs.writeFileSync(filePath, html, 'utf8');
console.log("Updated admin.html length:", html.length);
console.log("Successfully refactored admin.html styling structures!");
