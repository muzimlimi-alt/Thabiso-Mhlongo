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
    var sections = {
        dashboardAdmin:    { label: 'Dashboard',        title: 'Command Center',            group: 'Insight',      access: ALL },
        bookingsAdmin:     { label: 'Pipeline',         title: 'Event Bookings',            group: 'Bookings',     access: ALL },
        calendarAdmin:     { label: 'Calendar',         title: 'Calendar',                  group: 'Bookings',     access: ALL },
        eventsAdmin:       { label: 'Events',           title: 'Events Management',         group: 'Bookings',     access: ALL },
        financeAdmin:      { label: 'Finance',          title: 'Financial Ledger',          group: 'Revenue',      access: OPS },
        servicesAdmin:     { label: 'Services',         title: 'Services Catalogue',        group: 'Revenue',      access: ALL },
        paymentSetupAdmin: { label: 'Payment Setup',    title: 'Payment Setup',             group: 'Revenue',      access: ADMIN },
        inquiriesAdmin:    { label: 'Inquiries',        title: 'Inquiries',                 group: 'Audience',     access: ALL },
        newsletterAdmin:   { label: 'Newsletter',       title: 'Newsletter',                group: 'Outreach',     access: OPS },
        socialAdmin:       { label: 'Social Media',     title: 'Social Media',              group: 'Outreach',     access: ALL },
        contactAdmin:      { label: 'Contact Details',  title: 'Contact',                   group: 'Outreach',     access: ALL },
        homeAdmin:         { label: 'Home Slider',      title: 'Home Slider',               group: 'Site Content', access: ALL },
        aboutAdmin:        { label: 'About Me',         title: 'About Me',                  group: 'Site Content', access: ALL },
        careerAdmin:       { label: 'Career',           title: 'Career Highlights',         group: 'Site Content', access: ALL },
        accoladesAdmin:    { label: 'Accolades',        title: 'Accolades & Recognition',   group: 'Site Content', access: ALL },
        footprintAdmin:    { label: 'Footprint',        title: 'Footprint',                 group: 'Site Content', access: ALL },
        teamAdmin:         { label: 'Management Team',  title: 'Management Team',           group: 'Site Content', access: ALL },
        testimonialsAdmin: { label: 'Testimonials',     title: 'Testimonials',              group: 'Site Content', access: ALL },
        galleryAdmin:      { label: 'Gallery',          title: 'Gallery',                   group: 'Site Content', access: ALL },
        businessAdmin:     { label: 'Business Profile', title: 'Business Profile',          group: 'Business',     access: OPS },   // managers read it (the API gives them a view-only profile)
        policiesAdmin:     { label: 'Legal & Compliance', title: 'Legal & Compliance',      group: 'Business',     access: ALL },
        brandingAdmin:     { label: 'Site Appearance',  title: 'Site Appearance',                  group: 'Public Site',  access: ADMIN },
        integrationsAdmin: { label: 'Integrations',     title: 'Integrations',              group: 'System',       access: ADMIN },
        adminPortalAdmin:  { label: 'Admin Portal',     title: 'Admin Portal',              group: 'System',       access: ADMIN },
        usersAdmin:        { label: 'Users',            title: 'User Management',           group: 'People & Access', access: ADMIN },
        securityAdmin:     { label: 'Security & Audit', title: 'Security & Audit',          group: 'People & Access', access: ADMIN },
        emailSetupAdmin:   { label: 'Email Setup',      title: 'Email Setup',               group: 'Email',        access: ADMIN },
        emailLogsAdmin:    { label: 'Delivery Log',     title: 'Delivery Log',              group: 'Email',        access: ADMIN }
    };

    // old page id -> the id that now holds that content. Used by switchTab, the remembered-section restore and admNav.go, so a stale
    // sessionStorage value or an older caller lands on the right page instead of nowhere.
    var aliases = { preferencesAdmin: 'adminPortalAdmin' };   // "Admin Settings" was split up (Payment Setup, Email, Integrations, Business Profile, Admin Portal)

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

    return { sections: sections, aliases: aliases, resolve: resolve, canAccess: canAccess, inSidebar: inSidebar, titleOf: titleOf, runtime: runtime, ALL: ALL, OPS: OPS, ADMIN: ADMIN };
});
