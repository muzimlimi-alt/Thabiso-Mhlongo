// Admin navigation: the registry (js/admin/nav-config.js), the sidebar markup and the pages in admin.html have to describe the same portal.
// Static - reads files, no server. (The browser side - what each role actually sees and what each link opens - is test/browser/admin-nav.js.)
//
//   * every sidebar link opens a page that exists, and every page has exactly one sidebar link (switchTab finds the FIRST match);
//   * the sidebar text is the registry label; a page that has been reorganised carries a heading equal to its label;
//   * who may open what is pinned here by hand, so a change to the registry has to be a deliberate change to this file too;
//   * the old inline restriction lists are gone (they used to exist twice and drift);
//   * ids are unique and every tab points at a panel that exists.
const fs = require('fs');
const path = require('path');
const NAV = require('../js/admin/nav-config');

const unescape = (s) => String(s).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/&middot;/g, '·').trim();

// ids that are duplicated in admin.html today (drawers / modal fields repeated in two markup blocks); a NEW duplicate must fail this test
const KNOWN_DUPLICATE_IDS = ['umAddUserDrawer', 'cancelBookingId', 'cancelNotes', '${rowId}'];

// Pages whose own heading is deliberately not their sidebar label (kept as they have always been). Reorganised pages are NOT in this list:
// their heading must equal their label. Shrinks as pages are brought into line.
const HEADING_DIFFERS = ['dashboardAdmin', 'bookingsAdmin', 'eventsAdmin', 'financeAdmin', 'servicesAdmin', 'contactAdmin', 'careerAdmin', 'accoladesAdmin',
    'usersAdmin'];

module.exports = async function ({ check }) {
    const html = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');
    const start = html.indexOf('<ul class="admin-sidebar');
    const sidebar = html.slice(start, html.indexOf('</nav>', start));
    const links = [...sidebar.matchAll(/<a href="#([A-Za-z0-9_]+)" class="tm-nav-link[^"]*"[^>]*>([\s\S]*?)<\/a>/g)].map(m => ({
        id: m[1], text: unescape((m[2].match(/<span class="tm-nav-text[^"]*">([^<]*)<\/span>/) || [])[1] || '')
    }));
    const pages = [...html.matchAll(/<div class="admin-section"[^>]*id="([A-Za-z0-9_]+)"/g)].map(m => m[1]);
    const registry = Object.keys(NAV.sections);

    check('the sidebar has links and the page has sections', links.length >= 20 && pages.length >= 20, `${links.length} links, ${pages.length} pages`);
    const dupLinks = links.map(l => l.id).filter((id, i, a) => a.indexOf(id) !== i);
    check('no destination has two sidebar links (switchTab uses the first match)', dupLinks.length === 0, dupLinks.join(','));
    check('every sidebar link opens a page that exists', links.every(l => pages.includes(l.id)), links.filter(l => !pages.includes(l.id)).map(l => l.id).join(','));
    check('every page has a sidebar link', pages.every(p => links.some(l => l.id === p)), pages.filter(p => !links.some(l => l.id === p)).join(','));
    check('every sidebar link and every page is in the registry, and every registry entry is in the sidebar',
        links.every(l => registry.includes(l.id)) && pages.every(p => registry.includes(p)) && registry.every(id => links.some(l => l.id === id)),
        JSON.stringify({ notInRegistry: links.filter(l => !registry.includes(l.id)).map(l => l.id), notInSidebar: registry.filter(id => !links.some(l => l.id === id)) }));
    check('the sidebar text of every link is its registry label', links.every(l => !NAV.sections[l.id] || NAV.sections[l.id].label === l.text),
        links.filter(l => NAV.sections[l.id] && NAV.sections[l.id].label !== l.text).map(l => `${l.id}: "${l.text}" vs "${NAV.sections[l.id].label}"`).join(' | '));

    // page headings: <div class="admin-section" id="X"> ... <h2 class="atl-section-heading">Title</h2>
    const headingOf = (id) => {
        const a = html.indexOf(`id="${id}"`);
        const m = html.slice(a, a + 6000).match(/<h2[^>]*class="[^"]*atl-section-heading[^"]*"[^>]*>([\s\S]*?)<\/h2>/);
        return m ? unescape(m[1].replace(/<[^>]*>/g, '')) : null;
    };
    const wrong = [];
    for (const id of registry) {
        const h = headingOf(id);
        const want = HEADING_DIFFERS.includes(id) ? NAV.sections[id].title : NAV.sections[id].label;
        if (h !== null && h !== want) wrong.push(`${id}: heading "${h}", expected "${want}"`);
    }
    check('every page heading is its registry title, and equals its sidebar label unless listed as a known difference', wrong.length === 0, wrong.join(' | '));

    // who may open what - written out by hand
    const ADMIN_ONLY = ['brandingAdmin', 'integrationsAdmin', 'adminPortalAdmin', 'usersAdmin', 'securityAdmin', 'emailSetupAdmin', 'emailLogsAdmin', 'paymentSetupAdmin'];
    const NOT_ASSISTANT = ['financeAdmin', 'newsletterAdmin', 'businessAdmin'];
    const expect = (role, id) => role === 'administrator' ? true : role === 'manager' ? !ADMIN_ONLY.includes(id) : !ADMIN_ONLY.includes(id) && !NOT_ASSISTANT.includes(id);
    for (const role of ['administrator', 'manager', 'assistant']) {
        const bad = registry.filter(id => NAV.canAccess(role, id) !== expect(role, id) || NAV.inSidebar(role, id) !== expect(role, id));
        check(`access matrix: ${role} may open exactly ${registry.filter(id => expect(role, id)).length} of ${registry.length} pages (and sees exactly those in the sidebar)`, bad.length === 0, bad.join(','));
    }
    check('a page the registry does not know is not restricted, and an alias resolves', NAV.canAccess('assistant', 'someOtherPanel') === true
        && NAV.resolve('#bookingsAdmin') === 'bookingsAdmin' && Object.keys(NAV.aliases).every(old => NAV.sections[NAV.aliases[old]] && !NAV.sections[old]), JSON.stringify(NAV.aliases));

    // the account menu only points at real pages
    const menuTargets = [...html.matchAll(/data-menu-nav="([A-Za-z0-9_]+)"/g)].map(m => m[1]);
    check('every account-menu item opens a page that exists', menuTargets.length >= 2 && menuTargets.every(id => pages.includes(NAV.resolve(id))), menuTargets.join(','));

    // the duplicated lists are gone: admin.html asks the registry
    check('admin.html no longer carries its own role restriction lists', !/restricted\.push|restrictedSidebar|restrictedTiles/.test(html) && /ADMIN_NAV\.canAccess/.test(html) && /admNav\.applyRole/.test(html), '');
    check('nav-config.js is loaded before the inline scripts that use it', html.indexOf('js/admin/nav-config.js') > 0 && html.indexOf('js/admin/nav-config.js') < html.indexOf('function applyRoleGating'), '');
    check('the dead breadcrumb is gone (it wrote into an element that is not in the page)', !/admBreadcrumb|updateBreadcrumb|sectionMap/.test(html), '');

    // ids and tabs
    const counts = {};
    for (const m of html.matchAll(/\sid="([^"]+)"/g)) counts[m[1]] = (counts[m[1]] || 0) + 1;
    const dups = Object.keys(counts).filter(k => counts[k] > 1);
    check('no NEW duplicate ids in admin.html (known duplicates are listed in this test)', dups.every(d => KNOWN_DUPLICATE_IDS.includes(d)), dups.filter(d => !KNOWN_DUPLICATE_IDS.includes(d)).join(','));
    const tabTargets = [...new Set([...html.matchAll(/data-um-tab="([^"]+)"/g)].map(m => m[1]))];
    check('every tab button points at a panel that exists', tabTargets.every(t => counts[t]), tabTargets.filter(t => !counts[t]).join(','));
};
