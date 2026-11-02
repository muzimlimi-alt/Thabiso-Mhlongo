// "Social KPIs" is a tab of the Dashboard (moved from Social Media > Dashboard KPIs), and its show / hide switch for the Social Media Channels
// cards is a per-ACCOUNT preference kept on the server:
//   * the Dashboard has a "Social KPIs" tab with the switch and the platform settings; the Social Media page no longer has "Dashboard KPIs";
//   * switching the cards off (in the UI) is saved for the account, and a different browser (separate cookies = another device) that signs in as
//     the same account sees them off and the switch off; another account is unaffected and still sees them;
//   * switching back on is remembered the same way.
// Boots the real app on an isolated database copy (test/support.js). Not part of `npm test`: run with `npm run test:browser`.
const support = require('../support');
const puppeteer = require('puppeteer');
const sqlite3 = require('sqlite3');
const { BASE, sleep, api, loginAs, TEST_DB } = support;
const mod = (sql, p) => new Promise((res, rej) => { const db = new sqlite3.Database(TEST_DB); db.run(sql, p, (e) => { db.close(); e ? rej(e) : res(); }); });
let fails = 0;
const ok = (c, n, detail) => { if (!c) fails++; console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '\n        -> ' + String(detail).slice(0, 400))); };

async function signIn(role) {
    const r = await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: `test.${role}@example.invalid`, password: 'TestRunnerPass1!' }) });
    return String(r.headers.get('set-cookie')).split(';')[0];
}
async function openDashboard(browser, cookie) {
    const p = await (await browser.createBrowserContext()).newPage();   // its own cookie jar = its own device
    await p.setViewport({ width: 1440, height: 1000 });
    const errs = []; p.on('pageerror', e => errs.push(e.message.slice(0, 200)));
    const [name, ...rest] = cookie.split('=');
    await p.setCookie({ name, value: rest.join('='), url: BASE });
    await p.setRequestInterception(true);
    p.on('request', r => /\/api\/admin\/maps-config/.test(r.url()) ? r.respond({ status: 200, contentType: 'application/json', body: '{"success":true,"key":""}' }) : r.continue());
    await p.goto(BASE + '/admin.html', { waitUntil: 'domcontentloaded', timeout: 90000 });
    await sleep(4500);
    p._errs = errs;
    return p;
}
const cardsShown = (p) => p.evaluate(() => [...document.querySelectorAll('#dashboardAdmin .db-social-grid')].some(g => g.style.display !== 'none' && g.offsetParent !== null));
const switchOn = (p) => p.evaluate(() => document.getElementById('dashSocialCardsToggle').checked);

(async () => {
    await support.start();
    let browser;
    try {
        await loginAs('administrator'); await loginAs('manager');
        const adminCookie = await signIn('administrator'), mgrCookie = await signIn('manager');
        browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'], executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined });

        // ---- API
        // the copied database may hold the older, shared choice: it is the starting point for an account that has not chosen yet
        await mod("DELETE FROM settings WHERE setting_key = 'dashboard_show_social_cards'");
        const get = (c) => fetch(BASE + '/api/admin/dashboard/preferences', { headers: { Cookie: c } }).then(r => r.json());
        ok((await get(adminCookie)).preferences.social_cards === true, 'API: the cards are shown until an account chooses', '');
        await mod("INSERT OR REPLACE INTO settings (setting_key, setting_value) VALUES ('dashboard_show_social_cards', '0')");
        ok((await get(mgrCookie)).preferences.social_cards === false, "API: an older shared 'hidden' choice still applies to an account that has not chosen", '');
        await mod("DELETE FROM settings WHERE setting_key = 'dashboard_show_social_cards'");
        const bad = await fetch(BASE + '/api/admin/dashboard/preferences', { method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: adminCookie }, body: JSON.stringify({ social_cards: 'maybe' }) });
        ok(bad.status === 400, 'API: a value that is not true / false is refused', bad.status);
        ok((await fetch(BASE + '/api/admin/dashboard/preferences')).status === 401, 'API: signed-out visitors cannot read it', '');

        // ---- device A: structure + switch off
        const a = await openDashboard(browser, adminCookie);
        ok(await a.evaluate(() => !!document.getElementById('dbTabSocial') && document.getElementById('dbTabSocial').closest('#dbTabBar') !== null), 'the Dashboard has a "Social KPIs" tab', '');
        ok(await a.evaluate(() => !document.querySelector('#socialTabBar [data-um-tab="socialKpiPanel"]') && !document.getElementById('socialKpiPanel')), 'the Social Media page no longer has "Dashboard KPIs"', '');
        ok(await cardsShown(a), 'device A: the Social Media Channels cards show by default', '');
        await a.evaluate(() => document.getElementById('dbTabSocial').click()); await sleep(1500);
        ok(await a.evaluate(() => document.getElementById('dbPanelSocial').classList.contains('active') && document.getElementById('dashSocialCardsToggle').offsetParent !== null && document.querySelectorAll('#kpiSettingsContainer > *').length > 0), 'the tab opens with the switch and the platform settings', '');
        await a.evaluate(() => { const t = document.getElementById('dashSocialCardsToggle'); t.checked = false; t.dispatchEvent(new Event('change', { bubbles: true })); });
        await sleep(1500);
        ok((await get(adminCookie)).preferences.social_cards === false, 'switching off is saved for the account on the server', '');
        await a.evaluate(() => document.querySelector('#dbTabBar [data-um-tab="dbPanelOverview"]').click()); await sleep(600);
        ok(!(await cardsShown(a)), 'device A: the cards are hidden on the dashboard', '');

        // ---- device B: same account, fresh browser
        const b = await openDashboard(browser, adminCookie);
        ok(!(await cardsShown(b)), 'device B (same account, another browser): the cards are still hidden', '');
        await b.evaluate(() => document.getElementById('dbTabSocial').click()); await sleep(1000);
        ok((await switchOn(b)) === false, 'device B: the switch shows OFF', '');

        // ---- another account is unaffected
        const m = await openDashboard(browser, mgrCookie);
        ok(await cardsShown(m), 'another account (manager): still shows the cards', '');
        ok((await get(mgrCookie)).preferences.social_cards === true, "API: the manager's own preference is untouched", '');

        // ---- switch back on from device B, seen from a third browser
        await b.evaluate(() => { const t = document.getElementById('dashSocialCardsToggle'); t.checked = true; t.dispatchEvent(new Event('change', { bubbles: true })); }); await sleep(1500);
        const c = await openDashboard(browser, adminCookie);
        ok(await cardsShown(c), 'switching back on is remembered by another browser too', '');
        for (const [n, p] of [['A', a], ['B', b], ['manager', m], ['C', c]]) ok(p._errs.length === 0, `no page errors (${n})`, p._errs.join(' | '));
    } finally {
        if (browser) await browser.close();
        await support.stop();
    }
    console.log(fails ? `\n${fails} dashboard-social-pref check(s) FAILED` : '\nAll dashboard social preference checks passed');
    process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
