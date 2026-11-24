/* Admin navigation registry - the ONE place that says which pages exist, what they are called, which group they belong to and who may open them.
   (docs-internal/admin-nav-map.md has the human-readable map.)

   Before this file the same facts lived in four places that had to be kept in step by hand: the sidebar markup, applyRoleGating's list, a second copy of
   that list inside switchTab, and a breadcrumb map that pointed at an element that does not exist. Now:
     * switchTab and applyRoleGating both ask canAccess() / inSidebar() here;
     * a page that moves keeps working under its old id through `aliases` (stale session values, old deep links, other modules);
     * test/admin-nav.test.js reads this file and the sidebar markup and fails when they disagree.

   The sidebar stays static HTML (frozen contract: every destination is <li><a class="tm-nav-link" href="#sectionId"> inside ul.admin-sidebar);
   this registry does not render it, it governs it.

   Works in the browser (window.ADMIN_NAV, window.admNav) and in Node (require) so the static test can use the same data. */
(function (root, factory) {
    var api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else { root.ADMIN_NAV = api; root.admNav = api.runtime(root); }
})(typeof window !== 'undefined' ? window : this, function () {
    'use strict';

    var ALL = ['administrator', 'manager', 'assistant'];
    var OPS = ['administrator', 'manager'];
    var ADMIN = ['administrator'];

    // id -> { label: sidebar text, title: the page's own heading, group, access: roles that may open it, sidebar: roles that SEE the link (default = access) }
    // `title` equals `label` for every page that has been reorganised; the rest keep the heading they always had (listed here so each difference is deliberate).
    // perm: the minimum permission key (module.view) needed to access this section.
    // Used by the permission-aware gating pass (admin.html _applyPermGating) in addition to
    // the coarse role check. null = section has no granular permission (always accessible to its role tier).
    var sections = {
        dashboardAdmin:    { label: 'Dashboard',        title: 'Command Center',            group: 'Insight',      access: ALL,   perm: 'dashboard.view' },
        notificationsAdmin: { label: 'Notifications',   title: 'Notifications',             group: 'Insight',      access: ALL,   perm: 'notifications.view' },   // every role; the server returns only that role's categories (docs-internal/notifications.md)
        bookingsAdmin:     { label: 'Pipeline',         title: 'Event Bookings',            group: 'Bookings',     access: ALL,   perm: 'bookings.view' },
        calendarAdmin:     { label: 'Calendar',         title: 'Calendar',                  group: 'Bookings',     access: ALL,   perm: 'calendar.view' },
        eventsAdmin:       { label: 'Events',           title: 'Events Management',         group: 'Bookings',     access: ALL,   perm: 'events.view' },
        financeAdmin:      { label: 'Finance',          title: 'Financial Ledger',          group: 'Revenue',      access: OPS,   perm: 'finance.view' },
        servicesAdmin:     { label: 'Services',         title: 'Services Catalogue',        group: 'Revenue',      access: ALL,   perm: 'services.view' },
        paymentSetupAdmin: { label: 'Payment Setup',    title: 'Payment Setup',             group: 'Revenue',      access: ADMIN, perm: 'payment-setup.view' },
        inquiriesAdmin:    { label: 'Mailbox',           title: 'Mailbox',                   group: 'Email',        access: ALL,   perm: 'inquiries.view' },
        newsletterAdmin:   { label: 'Newsletter',       title: 'Newsletter',                group: 'Outreach',     access: OPS,   perm: 'newsletter.view' },
        socialAdmin:       { label: 'Social Media',     title: 'Social Media',              group: 'Outreach',     access: ALL,   perm: 'social.view' },
        contactAdmin:      { label: 'Contact Details',  title: 'Contact',                   group: 'Outreach',     access: ALL,   perm: 'contact.view' },
        homeAdmin:         { label: 'Home Slider',      title: 'Home Slider',               group: 'Site Content', access: ALL,   perm: 'site-content.view' },
        aboutAdmin:        { label: 'About Me',         title: 'About Me',                  group: 'Site Content', access: ALL,   perm: 'site-content.view' },
        careerAdmin:       { label: 'Career',           title: 'Career Highlights',         group: 'Site Content', access: ALL,   perm: 'site-content.view' },
        accoladesAdmin:    { label: 'Accolades',        title: 'Accolades & Recognition',   group: 'Site Content', access: ALL,   perm: 'site-content.view' },
        footprintAdmin:    { label: 'Footprint',        title: 'Footprint',                 group: 'Site Content', access: ALL,   perm: 'site-content.view' },
        teamAdmin:         { label: 'Management Team',  title: 'Management Team',           group: 'Site Content', access: ALL,   perm: 'site-content.view' },
        testimonialsAdmin: { label: 'Testimonials',     title: 'Testimonials',              group: 'Site Content', access: ALL,   perm: 'site-content.view' },
        faqAdmin:          { label: 'FAQ',              title: 'FAQ',                       group: 'Site Content', access: ALL,   perm: 'site-content.view' },
        galleryAdmin:      { label: 'Gallery',          title: 'Gallery',                   group: 'Site Content', access: ALL,   perm: 'site-content.view' },
        businessAdmin:     { label: 'Business Profile', title: 'Business Profile',          group: 'Business',     access: OPS,   perm: 'business-profile.view' },   // managers read it (the API gives them a view-only profile)
        policiesAdmin:     { label: 'Legal & Compliance', title: 'Legal & Compliance',      group: 'Business',     access: ALL,   perm: 'legal.view' },
        brandingAdmin:     { label: 'Site Appearance',  title: 'Site Appearance',                  group: 'Public Site',  access: ADMIN, perm: 'branding.view' },
        integrationsAdmin: { label: 'Integrations',     title: 'Integrations',              group: 'System',       access: ADMIN, perm: 'integrations.view' },
        usersAdmin:        { label: 'Users',            title: 'User Management',           group: 'People & Access', access: ADMIN, perm: 'users.view' },
        rolesAdmin:        { label: 'Roles & Permissions', title: 'Roles & Permissions',    group: 'People & Access', access: ADMIN, perm: 'roles.view' },
        securityAdmin:     { label: 'Security & Audit', title: 'Security & Audit',          group: 'People & Access', access: ADMIN, perm: 'security.view' },
        emailLogsAdmin:    { label: 'Delivery Log',     title: 'Delivery Log',              group: 'Email',        access: ADMIN, perm: 'email-logs.view' },
        emailBannersAdmin: { label: 'Email Banners',    title: 'Email Banners',             group: 'Email',        access: ADMIN, perm: 'email-banners.view' }
    };

    // old page id -> the id that now holds that content. Used by switchTab, the remembered-section restore and admNav.go, so a stale
    // sessionStorage value or an older caller lands on the right page instead of nowhere.
    var aliases = { preferencesAdmin: 'brandingAdmin', adminPortalAdmin: 'brandingAdmin', emailSetupAdmin: 'inquiriesAdmin' };   // "Admin Settings" was split up (Payment Setup, Email, Integrations, Business Profile, Admin Portal); "Email Setup" became the Setup tab on Inquiries; "Admin Portal" became tabs of Site Appearance

    function has(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
    function resolve(id) {
        id = String(id == null ? '' : id).replace(/^#/, '');
        return has(aliases, id) ? aliases[id] : id;
    }
    // A page the registry does not know about (not a navigation section) is not restricted here.
    function canAccess(role, id) {
        var s = sections[resolve(id)];
        return !s || s.access.indexOf(role) >= 0;
    }
    function inSidebar(role, id) {
        var s = sections[resolve(id)];
        return !s || (s.sidebar || s.access).indexOf(role) >= 0;
    }
    // Granular permission check: returns false when the section has a `perm` key and the
    // permSet (a Set<string> from /api/admin/me/permissions) does not contain it.
    // Administrators always pass (they have '*'). An unknown section (no registry entry) passes.
    function canAccessByPerm(permSet, id) {
        var s = sections[resolve(id)];
        if (!s || !s.perm) return true;
        if (!permSet || typeof permSet.has !== 'function') return true; // not loaded yet — permissive
        return permSet.has(s.perm);
    }
    // Return the view permission key for a section, or null.
    function permOf(id) { var s = sections[resolve(id)]; return s ? (s.perm || null) : null; }
    function titleOf(id) { var s = sections[resolve(id)]; return s ? s.label : ''; }

    // ── browser behaviour ──────────────────────────────────────────────────────────────────────────────────────────
    function runtime(win) {
        var doc = win.document;
        function hide(el) { el.style.display = 'none'; el.setAttribute('data-role-hidden', '1'); }
        function hidden(el) { return el.getAttribute('data-role-hidden') === '1'; }

        // Show / hide everything the role cannot use: sidebar leaves, then any group or label that is left with nothing under it
        // (managers and assistants used to see an empty "People & Access" button and an "Administration" heading over nothing), dashboard
        // tiles and account-menu items. Starts by undoing its own earlier work, so an in-place re-login as another role is exact.
        function applyRole(role) {
            var list = doc.querySelector('.admin-sidebar');
            if (list) {
                [].forEach.call(list.querySelectorAll('[data-role-hidden]'), function (el) { el.removeAttribute('data-role-hidden'); el.style.display = ''; });
                [].forEach.call(list.querySelectorAll('a.tm-nav-link'), function (a) {
                    var id = (a.getAttribute('href') || '').replace('#', '');
                    if (!inSidebar(role, id)) { var li = a.closest('li'); if (li) hide(li); }
                });
                [].forEach.call(list.querySelectorAll('li.atl-nav-group'), function (g) {
                    var kids = g.querySelectorAll('.atl-nav-sub > li');
                    if (kids.length && [].every.call(kids, hidden)) hide(g);
                });
                var items = [].slice.call(list.children);
                items.forEach(function (li, i) {
                    if (!li.classList.contains('sh-nav-label')) return;
                    var any = false;
                    for (var j = i + 1; j < items.length && !items[j].classList.contains('sh-nav-label'); j++) { if (!hidden(items[j])) { any = true; break; } }
                    if (!any) hide(li);
                });
            }
            [].forEach.call(doc.querySelectorAll('[id^="dashStat-"]'), function (el) {
                var card = el.closest('.db-stat-card');
                if (card) card.style.display = canAccess(role, el.id.replace('dashStat-', '')) ? '' : 'none';
            });
            [].forEach.call(doc.querySelectorAll('#admProfileMenu [data-menu-nav]'), function (a) {
                a.style.display = canAccess(role, a.getAttribute('data-menu-nav')) ? '' : 'none';
            });
        }

        // Open a page, optionally on a tab, optionally scrolling to an element once its loader has had a moment to show it.
        function go(id, opts) {
            opts = opts || {};
            var target = resolve(id);
            if (typeof win.switchTab === 'function') win.switchTab(target);
            if (opts.tab) setTimeout(function () { var b = doc.querySelector('[data-um-tab="' + opts.tab + '"]'); if (b) b.click(); }, 0);
            if (opts.scroll) setTimeout(function () {
                var el = doc.querySelector(opts.scroll);
                if (el && el.scrollIntoView && el.offsetParent !== null) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }, opts.delay || 400);
        }

        // The browser tab says where you are (the old breadcrumb pointed at an element that was never in the page).
        function setTitle(id) {
            var t = titleOf(id);
            if (t) doc.title = t + ' | Thabiso Mhlongo Admin';
        }

        doc.addEventListener('click', function (e) {
            var b = e.target.closest && e.target.closest('[data-nav-go]');
            if (!b) return;
            e.preventDefault();
            go(b.getAttribute('data-nav-go'), { tab: b.getAttribute('data-nav-tab') || '', scroll: b.getAttribute('data-nav-scroll') || '' });
        });

        return { applyRole: applyRole, go: go, setTitle: setTitle };
    }

    return { sections: sections, aliases: aliases, resolve: resolve, canAccess: canAccess, canAccessByPerm: canAccessByPerm, permOf: permOf, inSidebar: inSidebar, titleOf: titleOf, runtime: runtime, ALL: ALL, OPS: OPS, ADMIN: ADMIN };
});
