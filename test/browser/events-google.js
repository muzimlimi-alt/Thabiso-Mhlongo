// Admin -> Events -> the event form and Google Calendar: "Sync to Google Calendar" follows the real connection (off + a Set up link when Google is not connected, a
// plain-text notice when it is connected but not answering), a failed sync says WHY, and "View Event" opens the event (Google needs the event id and the calendar id
// together). The Google status the server gives is SIMULATED per scenario (puppeteer request interception on GET /api/admin/google-calendar), and saving an event is
// intercepted too so nothing can reach Google; the real routes and libraries are covered by test/google-calendar.test.js against a fake Google.
//
// Not part of `npm test`: run it with `npm run test:browser` (needs PUPPETEER_EXECUTABLE_PATH on this machine, see test-suite notes).
const sqlite3 = require('sqlite3');
const support = require('../support');
const puppeteer = require('puppeteer');
const { BASE, sleep } = support;
let fails = 0;
const ok = (c, n, detail) => { if (!c) fails++; console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '\n        -> ' + detail)); };
const PASSWORD = 'TestRunnerPass1!';

const sqlRun = (sql, params = []) => new Promise((res, rej) => { const db = new sqlite3.Database(support.TEST_DB); db.run(sql, params, function (e) { db.close(); e ? rej(e) : res(this); }); });
async function cookieFor(email) {
    const r = await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: PASSWORD }) });
    const sc = r.headers.get('set-cookie');
    if (r.status !== 200 || !sc) throw new Error('login failed for ' + email + ': ' + r.status);
    return sc.split(';')[0];
}
const status = (over = {}) => Object.assign({
    success: true, canManage: true, state: 'connected', connected: true, account: 'owner@example.test', m365Enabled: false, doubleEntryRisk: false,
    sync: { lastRunAt: new Date().toISOString(), lastOkAt: new Date().toISOString(), healthy: true, lastError: null, lastCategory: null, errorAt: null, failures: 0, errorKind: null }
}, over);

// p.google = the status JSON the server "gives". Only GET /api/admin/google-calendar is simulated (exact path).
async function openAdmin(browser, cookie, google, { width = 1440, height = 1000 } = {}) {
    const ctx = await browser.createBrowserContext();
    const p = await ctx.newPage();
    await p.setViewport({ width, height });
    p.errs = []; p.google = google; p.statusCalls = 0;
    p.on('pageerror', e => p.errs.push(e.message.slice(0, 200)));
    p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|Loading the font|API Error/.test(m.text())) p.errs.push('console: ' + m.text().slice(0, 200)); });
    const [name, ...rest] = cookie.split('=');
    await p.setCookie({ name, value: rest.join('='), url: BASE });
    await p.setRequestInterception(true);
    p.on('request', r => {
        const u = new URL(r.url());
        if (/\/api\/admin\/maps-config/.test(u.pathname)) return r.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, key: '' }) });
        if (u.pathname === '/api/admin/google-calendar' && r.method() === 'GET' && p.google) { p.statusCalls++; return r.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(p.google) }); }
        r.continue();
    });
    await p.goto(BASE + '/admin.html', { waitUntil: 'networkidle0', timeout: 90000 });
    await p.waitForFunction(() => typeof window.switchTab === 'function' && !!window.currentUserRole && typeof window.openEvtCreateDrawer === 'function', { timeout: 30000 });
    await p.evaluate(() => window.switchTab('eventsAdmin'));
    await sleep(800);
    return p;
}
const openCreate = async (p) => { await p.evaluate(() => window.openEvtCreateDrawer()); await p.waitForFunction(() => document.getElementById('evtDrawer').classList.contains('atl-drawer--open'), { timeout: 10000 }); await sleep(500); };
const form = (p) => p.evaluate(() => {
    const cb = document.getElementById('eventsGcalSync'), h = document.getElementById('eventsGcalHint');
    return { checked: cb.checked, disabled: cb.disabled, hint: h && getComputedStyle(h).display !== 'none' ? h.textContent : null, hintKids: h ? h.querySelectorAll('*').length : 0, hintColor: h ? h.style.borderColor : '', link: !!document.getElementById('eventsGcalSetup') };
});

(async () => {
    await support.start();
    await support.loginAs('assistant');
    const adminCookie = await cookieFor('test.runner@example.invalid');
    const assistantCookie = await cookieFor('test.assistant@example.invalid');
    const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-quic'] });

    // ═══ not connected, administrator ═══
    {
        const p = await openAdmin(browser, adminCookie, status({ state: 'none', connected: false, account: null }));
        await openCreate(p);
        const f = await form(p);
        ok(f.checked === false && f.disabled === true, 'Google not connected: "Sync to Google Calendar" is unticked and cannot be ticked (it could only fail)', JSON.stringify(f));
        ok(/isn't connected/.test(f.hint || '') && f.link, 'Google not connected: the form says so and offers "Set up Google Calendar" to an administrator', JSON.stringify(f));
        await p.click('#eventsGcalSetup'); await sleep(900);
        const nav = await p.evaluate(() => ({ drawerOpen: document.getElementById('evtDrawer').classList.contains('atl-drawer--open'), calendarShown: getComputedStyle(document.getElementById('calendarAdmin')).display !== 'none' }));
        ok(!nav.drawerOpen && nav.calendarShown, '"Set up Google Calendar" closes the form and takes the administrator to the Calendar (where Google is set up)', JSON.stringify(nav));
        // opening the form again re-applies the state; and a saved payload carries sync_to_gcal:false
        await p.evaluate(() => window.switchTab('eventsAdmin')); await sleep(500);
        await openCreate(p);
        ok((await form(p)).disabled === true, 'opening the form again shows the same state', '');
        ok(p.errs.length === 0, 'no script errors (not connected)', p.errs.join(' | '));
        await p.close();
    }

    // ═══ not connected, assistant ═══
    {
        const p = await openAdmin(browser, assistantCookie, status({ state: 'none', connected: false, account: null, canManage: false }));
        await openCreate(p);
        const f = await form(p);
        ok(f.disabled === true && f.checked === false && /An administrator can connect it/.test(f.hint || '') && f.link === false, 'Google not connected, assistant: told an administrator can connect it, no link offered', JSON.stringify(f));
        await p.close();
    }

    // ═══ connected ═══
    {
        const p = await openAdmin(browser, adminCookie, status());
        await openCreate(p);
        let f = await form(p);
        ok(f.checked === true && f.disabled === false && f.hint === null, 'Google connected and healthy: the box is ticked and usable, and there is no notice', JSON.stringify(f));
        // it flips live when the connection changes: the status is cached for 30 s, so ask again explicitly
        p.google = status({ state: 'none', connected: false, account: null });
        await p.evaluate(() => { _gcalStatusAt = 0; });
        await p.evaluate(() => evtApplyGcalState()); await sleep(300);
        f = await form(p);
        ok(f.disabled === true && f.checked === false, 'when the connection is lost the form follows (unticked, disabled)', JSON.stringify(f));
        p.google = status({ sync: { lastRunAt: new Date().toISOString(), lastOkAt: null, healthy: false, lastError: '<img src=x onerror="window.__xss=1"> Google said <b>no</b>', lastCategory: 'auth', errorAt: new Date().toISOString(), failures: 3, errorKind: 'push' } });
        await p.evaluate(() => { _gcalStatusAt = 0; });
        await p.evaluate(() => evtApplyGcalState()); await sleep(300);
        f = await form(p);
        const xss = await p.evaluate(() => window.__xss === 1);
        ok(f.disabled === false && /not answering right now: <img src=x onerror="window.__xss=1"> Google said <b>no<\/b>/.test(f.hint || '') && f.hintKids === 0 && !xss, 'connected but Google is failing: a notice with the recorded reason, shown as plain text (no markup is created), the box stays usable', JSON.stringify(f));
        if (process.env.EGOOGLE_SHOTS) { await p.evaluate(() => document.getElementById('eventsGcalHint').scrollIntoView({ block: 'center' })); await sleep(300); await p.screenshot({ path: process.env.EGOOGLE_SHOTS + '/events-google-notice.png' }); }

        // a save that Google did not take says why
        await p.evaluate(() => { window.__err = null; window.notificationService.showError = function (m) { window.__err = m; }; });
        await p.evaluate(() => evtGcalFailureToast('Event created'));
        await sleep(300);
        const msg = await p.evaluate(() => window.__err);
        ok(msg === 'Event created, but Google Calendar sync failed: <img src=x onerror="window.__xss=1"> Google said <b>no</b>', 'a save that Google did not take names the recorded reason ("... sync failed: <reason>")', String(msg));
        p.google = status();
        await p.evaluate(() => evtGcalFailureToast('Event updated')); await sleep(300);
        ok((await p.evaluate(() => window.__err)) === 'Event updated, but Google Calendar sync failed.', 'with no recorded reason it falls back to the plain sentence', String(await p.evaluate(() => window.__err)));
        await p.close();
    }

    // ═══ the "View Event" link ═══
    {
        const evId = (await sqlRun(`INSERT INTO events (event_title, event_datetime, event_status, venue_name, google_calendar_event_id) VALUES ('Linked Google Show', ?, 'upcoming', 'The Lyric', 'abc123evt')`, [new Date(Date.now() + 50 * 86400000).toISOString().slice(0, 10) + 'T19:30'])).lastID;
        const eid = Buffer.from('abc123evt owner@example.test').toString('base64').replace(/=+$/, '');
        const p = await openAdmin(browser, adminCookie, status());
        await p.waitForFunction((id) => !!document.querySelector('.atl-event-card[data-id="' + id + '"]'), { timeout: 20000 }, evId);
        await p.evaluate((id) => window.openEvtEditDrawer(id), evId);
        await p.waitForFunction(() => document.getElementById('evtDrawer').classList.contains('atl-drawer--open'), { timeout: 10000 });
        await sleep(700);
        let href = await p.evaluate(() => document.getElementById('eventsGcalLink').getAttribute('href'));
        ok(href === 'https://calendar.google.com/calendar/event?eid=' + eid, '"View Event" opens THIS event: the address carries the event id and the calendar id together (base64), not the bare id Google cannot open', href);
        ok(await p.evaluate(() => getComputedStyle(document.getElementById('eventsGcalLinkBadge')).display !== 'none'), 'an event that is on Google shows its "Synced to Google Calendar" line', '');
        ok((await form(p)).checked === true, 'editing a synced event keeps the sync box ticked', '');
        // no account known (credentials supplied by the server environment): the link opens the calendar itself rather than a dead address
        p.google = status({ account: null });
        await p.evaluate(() => { _gcalStatus = null; });
        await p.evaluate((id) => { window.resetEventForm && window.resetEventForm(); window.openEvtEditDrawer(id); }, evId);
        await sleep(900);
        href = await p.evaluate(() => document.getElementById('eventsGcalLink').getAttribute('href'));
        ok(href === 'https://calendar.google.com/calendar/r', 'with no account recorded the link opens the Google Calendar page instead of a broken address', href);
        ok(p.errs.length === 0, 'no script errors (edit)', p.errs.join(' | '));
        await p.close();
    }

    await browser.close();
    await support.stop();
    console.log(fails ? `\n${fails} FAILED` : '\nAll Events x Google browser checks passed');
    process.exit(fails ? 1 : 0);
})().catch(async (e) => { console.error('BROWSER TEST ERROR', e); try { console.error(support.getChildLog().slice(-1500)); await support.stop(); } catch (_) {} process.exit(2); });
