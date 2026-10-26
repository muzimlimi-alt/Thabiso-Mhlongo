// Admin navigation, driven through the REAL admin page in headless Chrome on an isolated DB copy (test/support.js - the real database is never touched).
// The static half (registry <-> sidebar markup <-> pages) is test/admin-nav.test.js; this file checks what a person actually gets:
//   - every sidebar link opens exactly its own page, marks its own menu item active, remembers it for a refresh, and titles the browser tab
//   - each role sees exactly the links the registry gives it, and never an EMPTY group button or a heading with nothing under it
//   - a page a role may not open sends it to the dashboard (with a message); a moved page's old id still works (alias)
//   - signing in as another role in place restores / removes links exactly (the old gating never un-hid anything)
//   - the account menu offers only what the role can open
//   - every tab bar controls panels that share its parent (js/admin/user-management.js initTabs scopes panels by the bar's parent)
// Not part of `npm test`: run it with `npm run test:browser` (needs PUPPETEER_EXECUTABLE_PATH on this machine, see test-suite notes).
const support = require('../support');
const puppeteer = require('puppeteer');
const NAV = require('../../js/admin/nav-config');
const { BASE, sleep, loginAs } = support;
let fails = 0;
const ok = (c, n, detail) => { if (!c) fails++; console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '\n        -> ' + detail)); };

async function cookieFor(email, password) {
    const r = await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
    const sc = r.headers.get('set-cookie');
    if (r.status !== 200 || !sc) throw new Error('login failed: ' + email + ' ' + r.status);
    return sc.split(';')[0];
}
async function openAdmin(browser, cookie, { width = 1440, height = 1000 } = {}) {
    const ctx = await browser.createBrowserContext();
    const p = await ctx.newPage();
    await p.setViewport({ width, height });
    p._errs = [];
    p.on('pageerror', e => p._errs.push(e.message.slice(0, 200)));
    const [name, ...rest] = cookie.split('=');
    await p.setCookie({ name, value: rest.join('='), url: BASE });
    await p.setRequestInterception(true);
    p.on('request', r => {
        if (/\/api\/admin\/maps-config/.test(r.url())) return r.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, key: '' }) });
        r.continue();
    });
    await p.goto(BASE + '/admin.html', { waitUntil: 'networkidle0', timeout: 90000 });
    await p.waitForFunction(() => typeof window.switchTab === 'function' && !!window.admNav && !!document.querySelector('.admin-sidebar') && !!window.currentUserRole, { timeout: 30000, polling: 200 });
    await p.evaluate(() => { window.__toasts = []; const ns = window.notificationService; const orig = ns.showError.bind(ns); ns.showError = function () { window.__toasts.push([].join.call(arguments, ' ')); return orig.apply(null, arguments); }; });
    return p;
}

// what the sidebar shows right now: visible leaves, visible group buttons (with how many visible leaves they hold) and visible headings (with visible items under them)
const sidebarState = (p) => p.evaluate(() => {
    const list = document.querySelector('.admin-sidebar');
    const vis = (el) => el.getAttribute('data-role-hidden') !== '1' && el.style.display !== 'none';
    const leaves = [...list.querySelectorAll('a.tm-nav-link')].filter(a => vis(a.closest('li'))).map(a => a.getAttribute('href').replace('#', ''));
    const groups = [...list.querySelectorAll('li.atl-nav-group')].filter(vis).map(g => ({ id: (g.querySelector('.atl-nav-sub') || {}).id, shown: [...g.querySelectorAll('.atl-nav-sub > li')].filter(vis).length }));
    const items = [...list.children];
    const labels = items.map((li, i) => ({ li, i })).filter(x => x.li.classList.contains('sh-nav-label') && vis(x.li)).map(x => {
        let n = 0; for (let j = x.i + 1; j < items.length && !items[j].classList.contains('sh-nav-label'); j++) if (vis(items[j])) n++;
        return { text: x.li.textContent.trim(), shown: n };
    });
    return { leaves, groups, labels };
});

(async () => {
    await support.start();
    let browser;
    try {
        browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-quic'], executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined });
        await loginAs('manager'); await loginAs('assistant');
        const cookies = {
            administrator: await cookieFor('test.runner@example.invalid', 'TestRunnerPass1!'),
            manager: await cookieFor('test.manager@example.invalid', 'TestRunnerPass1!'),
            assistant: await cookieFor('test.assistant@example.invalid', 'TestRunnerPass1!')
        };
        const ids = Object.keys(NAV.sections);

        // ── administrator: every link opens its page ──
        const admin = await openAdmin(browser, cookies.administrator);
        const bad = [];
        for (const id of ids) {
            const r = await admin.evaluate((id) => {
                const a = document.querySelector('.admin-sidebar a[href="#' + id + '"]');
                a.click();
                const shown = [...document.querySelectorAll('.admin-section')].filter(s => s.style.display === 'block').map(s => s.id);
                return { shown, active: a.closest('li').classList.contains('active'), others: document.querySelectorAll('.admin-sidebar li.active').length, remembered: sessionStorage.getItem('admin_active_section'), title: document.title };
            }, id);
            const problems = [];
            if (r.shown.length !== 1 || r.shown[0] !== id) problems.push('shown=' + r.shown.join('+'));
            if (!r.active) problems.push('its menu item is not active');
            if (r.remembered !== id) problems.push('remembered=' + r.remembered);
            if (r.title.indexOf(NAV.sections[id].label) !== 0) problems.push('title=' + r.title);
            if (problems.length) bad.push(id + ': ' + problems.join(', '));
            await sleep(60);
        }
        ok(bad.length === 0, `administrator: all ${ids.length} sidebar links open exactly their own page, mark their menu item active, remember it for a refresh and title the browser tab`, bad.join(' | '));
        ok(admin._errs.length === 0, 'administrator: no page errors while visiting every page', admin._errs.join(' | '));

        let st = await sidebarState(admin);
        ok(JSON.stringify(st.leaves.slice().sort()) === JSON.stringify(ids.filter(id => NAV.inSidebar('administrator', id)).sort()), 'administrator: sees every sidebar link', JSON.stringify(st.leaves));

        // the account menu: an administrator is offered both items, and "My profile" opens the profile tab
        const menu = await admin.evaluate(() => [...document.querySelectorAll('#admProfileMenu [data-menu-nav]')].map(a => ({ nav: a.getAttribute('data-menu-nav'), tab: a.getAttribute('data-menu-tab'), shown: a.style.display !== 'none', text: a.textContent.trim() })));
        ok(menu.length === 2 && menu.every(m => m.shown) && /My profile/.test(menu[0].text) && /Team/.test(menu[1].text), 'administrator: the account menu offers "My profile" and "Team & roles"', JSON.stringify(menu));
        await admin.evaluate(() => window.switchTab('dashboardAdmin'));
        await admin.evaluate(() => { document.getElementById('admProfileTrigger').click(); });
        await sleep(200);
        await admin.evaluate(() => document.querySelector('#admProfileMenu [data-menu-nav="usersAdmin"][data-menu-tab="umPanelProfile"]').click());
        await sleep(500);
        const prof = await admin.evaluate(() => ({ page: document.getElementById('usersAdmin').style.display, tab: document.getElementById('umPanelProfile').classList.contains('active') }));
        ok(prof.page === 'block' && prof.tab, '"My profile" opens the Users page on the My Profile tab', JSON.stringify(prof));
        await admin.evaluate(() => { document.getElementById('admProfileTrigger').click(); });
        await sleep(200);
        await admin.evaluate(() => document.querySelector('#admProfileMenu [data-menu-nav="usersAdmin"][data-menu-tab="umPanelUsers"]').click());
        await sleep(600);
        ok(await admin.evaluate(() => document.getElementById('umPanelUsers').classList.contains('active')), '"Team & roles" opens the Manage Users tab', '');

        // a moved page's old id still works
        await admin.evaluate(() => { window.ADMIN_NAV.aliases.legacyBookings = 'bookingsAdmin'; window.switchTab('legacyBookings'); });
        ok(await admin.evaluate(() => document.getElementById('bookingsAdmin').style.display === 'block' && sessionStorage.getItem('admin_active_section') === 'bookingsAdmin'), 'an alias (old page id) lands on the page that now holds that content, and the remembered section is the NEW id', '');
        await admin.evaluate(() => { delete window.ADMIN_NAV.aliases.legacyBookings; });

        // ── managers and assistants ──
        for (const role of ['manager', 'assistant']) {
            const p = await openAdmin(browser, cookies[role]);
            st = await sidebarState(p);
            const want = ids.filter(id => NAV.inSidebar(role, id)).sort();
            ok(JSON.stringify(st.leaves.slice().sort()) === JSON.stringify(want), `${role}: sees exactly the ${want.length} links the registry gives it`, JSON.stringify({ got: st.leaves.slice().sort(), want }));
            ok(st.groups.every(g => g.shown > 0), `${role}: no group button is left with nothing in it`, JSON.stringify(st.groups));
            ok(st.labels.every(l => l.shown > 0), `${role}: no heading is left with nothing under it`, JSON.stringify(st.labels));
            await p.evaluate(() => window.switchTab('inquiriesAdmin'));
            ok(await p.evaluate(() => ['inqSetupTabBtn'].every(id => getComputedStyle(document.getElementById(id)).display === 'none')), `${role}: Inquiries offers no Setup tab`, '');
            const mm = await p.evaluate(() => [...document.querySelectorAll('#admProfileMenu [data-menu-nav]')].filter(a => a.style.display !== 'none').length);
            ok(mm === 0, `${role}: the account menu does not offer "My profile" / "Team & roles" (the user pages are administrator-only, they used to answer "Access denied")`, String(mm));
            const denied = ids.filter(id => !NAV.canAccess(role, id));
            const lands = [];
            for (const id of denied) {
                await p.evaluate(() => { window.__toasts.length = 0; });
                const r = await p.evaluate((id) => { window.switchTab(id); return { shown: [...document.querySelectorAll('.admin-section')].filter(s => s.style.display === 'block').map(s => s.id), toast: window.__toasts.filter(t => /Access denied/.test(t)).length }; }, id);
                if (r.shown.join() !== 'dashboardAdmin' || r.toast !== 1) lands.push(id + ' -> ' + r.shown.join('+') + ' toasts=' + r.toast);
            }
            ok(lands.length === 0, `${role}: opening any of the ${denied.length} pages it may not open lands on the dashboard with one "Access denied" message`, lands.join(' | '));
            // the dashboard tiles follow the same rule
            const tiles = await p.evaluate(() => [...document.querySelectorAll('[id^="dashStat-"]')].map(el => ({ id: el.id.replace('dashStat-', ''), shown: el.closest('.db-stat-card').style.display !== 'none' })));
            ok(tiles.every(t => t.shown === NAV.canAccess(role, t.id)), `${role}: dashboard tiles show only pages it may open`, JSON.stringify(tiles));
            if (role === 'assistant') {
                // signing in as someone else in place (no reload): everything is restored exactly, then removed again
                await p.evaluate(() => window.applyRoleGating('administrator'));
                const full = await sidebarState(p);
                ok(JSON.stringify(full.leaves.slice().sort()) === JSON.stringify(ids.slice().sort()) && full.groups.length >= 5 && full.labels.length >= 5, 'assistant -> administrator in place: every link, group and heading is back (the old gating never un-hid anything)', JSON.stringify({ n: full.leaves.length, g: full.groups.length, l: full.labels.length }));
                const back = await p.evaluate(() => { window.applyRoleGating('assistant'); return null; });
                const again = await sidebarState(p);
                ok(JSON.stringify(again.leaves.slice().sort()) === JSON.stringify(want), '...and back to assistant removes exactly the same links again', JSON.stringify(again.leaves));
            }
            ok(p._errs.length === 0, `${role}: no page errors`, p._errs.join(' | '));
        }

        // ── where each card lives (the page that owns it) ──
        const LIVES_IN = {
            stSmtpCard: 'inquiriesAdmin', stSmtpHost: 'inquiriesAdmin', stInboxBlock: 'inquiriesAdmin', stInboxToggleBtn: 'inquiriesAdmin', stNotifCard: 'inquiriesAdmin', stNotificationEmail: 'inquiriesAdmin',
            btnSaveSmtp: 'inquiriesAdmin', btnSaveAlertEmail: 'inquiriesAdmin', emailLogsBody: 'emailLogsAdmin',
            bp_legal_name: 'businessAdmin', bp_vat_number: 'businessAdmin', bpCardBank: 'businessAdmin', secSearch: 'brandingAdmin', btnSaveSections: 'brandingAdmin', brandPanelHomepage: 'brandingAdmin', stGoogleCard: 'calendarAdmin', testPlacesBtn: 'integrationsAdmin', atlAppearancePanelPrefs: 'brandingAdmin', brandLoginBgUrl: 'brandingAdmin', stPayfastId: 'paymentSetupAdmin', stPayfastUrl: 'paymentSetupAdmin', btnSavePayfast: 'paymentSetupAdmin', stEftCard: 'paymentSetupAdmin', eftHolder: 'paymentSetupAdmin', eftSaveDetailsBtn: 'paymentSetupAdmin'
        };
        const where = await admin.evaluate((m) => Object.keys(m).map(id => { const el = document.getElementById(id); return [id, el ? (el.closest('.admin-section') || {}).id : null]; }), LIVES_IN);
        const misplaced = where.filter(([id, sec]) => sec !== LIVES_IN[id]);
        ok(misplaced.length === 0, 'every moved card / control lives on the page that owns it (email cards on Inquiries > Setup, the log on Delivery Log)', JSON.stringify(misplaced));
        ok(await admin.evaluate(() => !document.getElementById('preferencesAdmin') && !document.querySelector('[data-um-tab^="prefPanel"]') && !document.getElementById('brandPanelSite')), 'the old Admin Settings page and the Site Appearance "Site" tab are gone', '');
        ok(await admin.evaluate(() => !document.getElementById('brandingAdmin').querySelector('#stSmtpCard, #stInboxBlock, #stNotifCard, #stNotificationEmail, #stPayfastId, #stEftCard, #btnSavePayfast, #bpRoot, #stGoogleCard')), 'and none of the moved cards is left behind on Site Appearance', '');
        // Email Banners is its own page in the Email group; opening it loads the banner library
        await admin.evaluate(() => window.switchTab('emailBannersAdmin'));
        await admin.waitForFunction(() => document.querySelectorAll('#bnrCategory option').length > 0 && getComputedStyle(document.getElementById('emailBannersAdmin')).display !== 'none', { timeout: 15000, polling: 200 });
        ok(await admin.evaluate(() => !document.getElementById('brandingAdmin').querySelector('#bnrCategory, #brandPanelEmail') && !!document.querySelector('#navEmail a[href="#emailBannersAdmin"]')), 'Email Banners is a page under the Email group and is gone from Site Appearance', '');
        // the real alias: an old id (and a stale remembered section) lands on Site Appearance
        ok(await admin.evaluate(() => { window.switchTab('preferencesAdmin'); return document.getElementById('brandingAdmin').style.display === 'block' && sessionStorage.getItem('admin_active_section') === 'brandingAdmin'; }), 'the retired "Admin Settings" id still works: it opens Site Appearance', '');
        await admin.evaluate(() => { window.switchTab('dashboardAdmin'); sessionStorage.setItem('admin_active_section', 'preferencesAdmin'); });
        await admin.reload({ waitUntil: 'networkidle0' });
        await admin.waitForFunction(() => document.getElementById('brandingAdmin') && document.getElementById('brandingAdmin').style.display === 'block', { timeout: 20000, polling: 200 });
        ok(true, 'a stale remembered section ("Admin Settings") is followed to Site Appearance after a refresh', '');

        // ── a moved card still loads and saves from its new page: PayFast sends ONLY its own four keys ──
        await admin.evaluate(() => { window.__puts = []; const of = window.fetch; window.fetch = function (u, o) { if (o && o.method === 'PUT' && /\/api\/admin\/settings$/.test(String(u))) window.__puts.push(o.body); return of.apply(this, arguments); }; });
        await admin.evaluate(() => window.switchTab('paymentSetupAdmin'));
        await sleep(800);
        await admin.evaluate(() => { const e = document.getElementById('stPayfastId'); e.value = '10000199'; e.dispatchEvent(new Event('input', { bubbles: true })); });
        await admin.evaluate(() => document.getElementById('btnSavePayfast').click());
        await admin.waitForFunction(() => window.__puts.length === 1, { timeout: 15000, polling: 200 });
        const pfPut = await admin.evaluate(() => JSON.parse(window.__puts[0]).settings);
        ok(Object.keys(pfPut).length >= 1 && Object.keys(pfPut).every(k => /^payfast_/.test(k)) && pfPut.payfast_merchant_id === '10000199', 'PayFast: Save PayFast settings sends only payfast_* keys (never the mail server or the alert address)', JSON.stringify(Object.keys(pfPut)));
        const stored = await (await fetch(BASE + '/api/admin/settings', { headers: { Cookie: cookies.administrator } })).json();
        ok(stored.settings.payfast_merchant_id === '10000199', 'PayFast: the new merchant id is stored', String(stored.settings.payfast_merchant_id));
        await admin.evaluate(() => { window.switchTab('dashboardAdmin'); window.switchTab('paymentSetupAdmin'); });
        await admin.waitForFunction(() => document.getElementById('stPayfastId').value === '10000199', { timeout: 15000, polling: 200 });
        ok(true, 'PayFast: reopening the page loads the saved merchant id into the card', '');

        // ── tab bars: every button's panel sits under the bar's own parent (initTabs scopes panels by that parent) ──
        const bars = await admin.evaluate(() => [...document.querySelectorAll('.atl-tab-bar')].map(bar => {
            const parent = bar.parentElement, btns = [...bar.querySelectorAll('[data-um-tab]')];
            const missing = btns.filter(b => !parent.querySelector('#' + b.getAttribute('data-um-tab'))).map(b => b.getAttribute('data-um-tab'));
            const section = (bar.closest('.admin-section') || {}).id || '?';
            const active = btns.filter(b => b.classList.contains('active')).length;
            return { section, buttons: btns.length, missing, active };
        }));
        const offenders = bars.filter(b => b.missing.length || b.buttons === 0);
        ok(offenders.length === 0, `all ${bars.length} tab bars control panels that share their parent`, JSON.stringify(offenders));
        const noActive = bars.filter(b => b.active !== 1);
        console.log('INFO tab bars without exactly one active button: ' + JSON.stringify(noActive.map(b => b.section + ':' + b.active)));
    } catch (e) {
        fails++;
        console.log('FAIL browser test crashed: ' + (e.stack || e.message).slice(0, 700));
    } finally {
        if (browser) await browser.close();
        await support.stop();
    }
    console.log(fails ? `\n${fails} check(s) FAILED` : '\nAll checks passed');
    process.exit(fails ? 1 : 0);
})();
