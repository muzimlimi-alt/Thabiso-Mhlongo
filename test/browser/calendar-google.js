// Admin -> Bookings -> Calendar -> the Google strip, "Sync now", the double-entry warning and the Google filter, driven through the REAL admin.html on an isolated DB copy
// (test/support.js). The Google STATUS the server gives and the answer to "Sync now" are SIMULATED per scenario (puppeteer request interception), so each state can be shown
// and nothing can reach Google; the calendar feed itself is the real one over seeded bookings / events (the feed's Google flags are also covered by
// test/google-calendar.test.js). Connecting Google (the settings card) is test/browser/google-calendar.js; the event form is test/browser/events-google.js.
//
// Not part of `npm test`: run it with `npm run test:browser` (needs PUPPETEER_EXECUTABLE_PATH on this machine, see test-suite notes).
const sqlite3 = require('sqlite3');
const support = require('../support');
const puppeteer = require('puppeteer');
const { BASE, sleep } = support;
let fails = 0;
const ok = (c, n, detail) => { if (!c) fails++; console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '\n        -> ' + detail)); };
const PASSWORD = 'TestRunnerPass1!';
const SHOTS = process.env.CALG_SHOTS_DIR || null;

const sqlRun = (sql, params = []) => new Promise((res, rej) => { const db = new sqlite3.Database(support.TEST_DB); db.run(sql, params, function (e) { db.close(); e ? rej(e) : res(this); }); });
async function cookieFor(email) {
    const r = await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: PASSWORD }) });
    const sc = r.headers.get('set-cookie');
    if (r.status !== 200 || !sc) throw new Error('login failed for ' + email + ': ' + r.status);
    return sc.split(';')[0];
}
const iso = (minAgo) => new Date(Date.now() - minAgo * 60000).toISOString();
const healthy = { lastRunAt: iso(2), lastOkAt: iso(2), healthy: true, lastError: null, lastCategory: null, errorAt: null, failures: 0, errorKind: null };
const view = (over = {}) => Object.assign({ success: true, canManage: true, state: 'connected', connected: true, account: 'owner@example.test', m365Enabled: false, doubleEntryRisk: false, sync: healthy }, over);

// p.google = the status JSON; p.syncAnswer = what "Sync now" answers; p.syncCalls counts the POSTs.
async function openCalendar(browser, cookie, google, { width = 1440, height = 1100, gotoDate } = {}) {
    const ctx = await browser.createBrowserContext();
    const p = await ctx.newPage();
    await p.setViewport({ width, height });
    p.errs = []; p.google = google; p.syncCalls = 0; p.syncAnswer = { status: 200, json: { success: true, ok: true, message: 'Google Calendar was read just now.' } };
    p.on('pageerror', e => p.errs.push(e.message.slice(0, 200)));
    p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|Loading the font|API Error/.test(m.text())) p.errs.push('console: ' + m.text().slice(0, 200)); });
    const [name, ...rest] = cookie.split('=');
    await p.setCookie({ name, value: rest.join('='), url: BASE });
    await p.setRequestInterception(true);
    p.on('request', r => {
        const u = new URL(r.url());
        if (/\/api\/admin\/maps-config/.test(u.pathname)) return r.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, key: '' }) });
        if (u.pathname === '/api/admin/google-calendar' && r.method() === 'GET') return r.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(p.google) });
        if (u.pathname === '/api/admin/google-calendar/sync' && r.method() === 'POST') { p.syncCalls++; return r.respond({ status: p.syncAnswer.status, contentType: 'application/json', body: JSON.stringify(p.syncAnswer.json) }); }
        r.continue();
    });
    await p.goto(BASE + '/admin.html', { waitUntil: 'networkidle0', timeout: 90000 });
    await p.waitForFunction(() => typeof window.switchTab === 'function' && typeof window.FullCalendar !== 'undefined' && !!window.currentUserRole, { timeout: 30000 });
    await p.evaluate(() => window.switchTab('calendarAdmin'));
    await p.waitForFunction(() => typeof adminCalendar !== 'undefined' && adminCalendar && (document.querySelectorAll('#calendar .fc-daygrid-day').length > 20 || !!document.querySelector('#calendar .fc-list')), { timeout: 30000 });
    if (gotoDate) { await p.evaluate(d => { adminCalendar.gotoDate(d); }, gotoDate); await sleep(900); }
    await p.waitForFunction(() => { const s = document.getElementById('calGoogleStrip'); return s && !s.hidden; }, { timeout: 20000 });
    await sleep(250);
    return p;
}
const strip = (p) => p.evaluate(() => {
    const vis = (id) => { const e = document.getElementById(id); return !!e && !e.hidden && getComputedStyle(e).display !== 'none'; };
    return { cls: document.getElementById('calGoogleStrip').className, text: document.getElementById('calGoogleText').textContent, warn: vis('calGoogleWarn') ? document.getElementById('calGoogleWarn').textContent : null, run: vis('calGoogleRun'), setup: vis('calGoogleSetup'), filter: vis('calGoogleFilterWrap') };
});
const refresh = async (p) => { await p.evaluate(() => window.calGoogleRefreshStrip()); await sleep(350); };
const shown = (p) => p.evaluate(() => [...document.querySelectorAll('#calendar .fc-event')].filter(e => e.offsetParent !== null && getComputedStyle(e).display !== 'none').map(e => e.textContent));

(async () => {
    await support.start();
    await support.loginAs('manager');
    await support.loginAs('assistant');
    const adminCookie = await cookieFor('test.runner@example.invalid');
    const managerCookie = await cookieFor('test.manager@example.invalid');
    const assistantCookie = await cookieFor('test.assistant@example.invalid');

    // seed: three bookings on three days (one on Google) and a standalone event that is on Google, in a quiet month so everything lands in one grid
    const base = new Date(); base.setMonth(base.getMonth() + 2); base.setDate(10);
    const day = (n) => new Date(base.getTime() + n * 86400000).toISOString().slice(0, 10);
    const mk = (title, n, gid) => sqlRun(`INSERT INTO bookings (name, email, cell, date, message, status, event_start_time, performance_end_time, event_name, event_type, event_location, city, total_amount, google_event_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        ['Seed Client', `g${n}@example.invalid`, '+27820000000', day(n), 'seed', 'CONFIRMED', '18:00', '20:00', title, 'Corporate', 'Seed Hall', 'Pretoria', 1000, gid]);
    await mk('GFilter On', 0, 'gcal-seed-1');
    await mk('GFilter Off', 1, null);
    await mk('GFilter Also Off', 2, null);
    await sqlRun(`INSERT INTO events (event_title, event_datetime, event_status, venue_name, google_calendar_event_id) VALUES ('GFilter Show', ?, 'upcoming', 'The Lyric', 'gcal-seed-ev')`, [day(3) + 'T19:30']);

    const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-quic'] });

    // ═══ administrator ═══
    const p = await openCalendar(browser, adminCookie, view(), { gotoDate: day(0) });
    let s = await strip(p);
    ok(/connected as owner@example\.test/.test(s.text) && /read 2 min ago/.test(s.text) && /--ok/.test(s.cls) && s.warn === null, 'strip, connected and healthy: names the account and when Google was last read, green, no warning', JSON.stringify(s));
    ok(s.run && s.setup && s.filter, 'an administrator gets Sync now, Settings and the Google filter', JSON.stringify(s));
    if (SHOTS) await p.screenshot({ path: SHOTS + '/calendar-google-healthy.png' });

    p.google = view({ sync: { lastRunAt: iso(1), lastOkAt: iso(180), healthy: false, lastError: 'Google no longer accepts the saved sign-in: it was revoked, or it expired. Connect Google again.', lastCategory: 'auth', errorAt: iso(1), failures: 4, errorKind: 'pull' } });
    await refresh(p);
    s = await strip(p);
    ok(/can't sync right now/.test(s.text) && /no longer accepts the saved sign-in/.test(s.text) && /Last good sync 3 h ago/.test(s.text) && /--bad/.test(s.cls), 'strip, Google failing: red, says it cannot sync, gives the recorded reason and when it last worked', JSON.stringify(s));
    if (SHOTS) await p.screenshot({ path: SHOTS + '/calendar-google-failing.png' });

    const HOSTILE = '<img src=x onerror="window.__xss=1"> Google said <b>no</b>';
    p.google = view({ sync: { lastRunAt: iso(1), lastOkAt: null, healthy: false, lastError: HOSTILE, lastCategory: 'unknown', errorAt: iso(1), failures: 1, errorKind: 'push' } });
    await refresh(p);
    s = await strip(p);
    ok(s.text.includes(HOSTILE) && !(await p.evaluate(() => window.__xss === 1)) && (await p.evaluate(() => document.getElementById('calGoogleText').children.length)) === 0, 'text that came from Google is shown as plain text (no markup is created)', JSON.stringify(s));

    p.google = view({ m365Enabled: true, doubleEntryRisk: true });
    await refresh(p);
    s = await strip(p);
    ok(/Both Google Calendar and Microsoft 365 sharing are switched on/.test(s.warn || '') && /BOTH calendars/.test(s.warn || '') && /--warn/.test(s.cls), 'both calendars switched on: an amber strip with the double-entry warning in plain words', JSON.stringify(s));
    if (SHOTS) await p.screenshot({ path: SHOTS + '/calendar-google-double.png' });
    p.google = view({ m365Enabled: true, doubleEntryRisk: false, connected: false, state: 'none', account: null });
    await refresh(p);
    s = await strip(p);
    ok(s.warn === null && /not connected/.test(s.text) && s.run === false && s.filter === false && /--off/.test(s.cls), 'not connected: no warning, no Sync now, no Google filter; neutral strip', JSON.stringify(s));

    // Sync now
    p.google = view();
    await refresh(p);
    await p.click('#calGoogleRun'); await sleep(900);
    ok(p.syncCalls === 1 && !(await p.evaluate(() => document.getElementById('calGoogleRun').disabled)) && /Sync now/.test(await p.evaluate(() => document.getElementById('calGoogleRun').textContent)), 'Sync now: asks the server once, then gives the button back with its label', String(p.syncCalls));
    ok(await p.evaluate(() => /Google Calendar was read just now\./.test(document.body.textContent)), 'Sync now: a success message appears', '');
    p.syncAnswer = { status: 200, json: { success: true, ok: false, message: 'The Google Calendar API is switched off for this Google Cloud project.' } };
    await p.click('#calGoogleRun'); await sleep(900);
    ok(p.syncCalls === 2 && await p.evaluate(() => /Google Calendar API is switched off/.test(document.body.textContent)), 'Sync now when Google cannot be read: the reason is shown', '');
    p.syncAnswer = { status: 409, json: { success: false, message: 'A Google Calendar sync is already running. Try again in a moment.' } };
    await p.click('#calGoogleRun'); await sleep(900);
    ok(await p.evaluate(() => /already running/.test(document.body.textContent)), 'Sync now while one is already running: says so', '');

    // the Google filter over the real feed
    p.google = view();
    await refresh(p);
    await p.evaluate(d => { adminCalendar.gotoDate(d); }, day(0)); await sleep(1000);
    let t = await shown(p);
    const has = (arr, w) => arr.some(x => x.includes(w));
    ok(has(t, 'GFilter On') && has(t, 'GFilter Off') && has(t, 'GFilter Also Off') && has(t, 'GFilter Show'), 'the seeded bookings and event are all on the calendar', JSON.stringify(t));
    await p.select('#calGoogleFilter', 'on'); await sleep(300);
    t = await shown(p);
    ok(has(t, 'GFilter On') && has(t, 'GFilter Show') && !has(t, 'GFilter Off') && !has(t, 'GFilter Also Off'), 'filter "On Google Calendar": only the booking and the event that are on Google', JSON.stringify(t));
    await p.select('#calGoogleFilter', 'off'); await sleep(300);
    t = await shown(p);
    ok(has(t, 'GFilter Off') && has(t, 'GFilter Also Off') && !has(t, 'GFilter On') && !has(t, 'GFilter Show'), 'filter "Not on Google Calendar": only the ones that are not', JSON.stringify(t));
    await p.select('#calGoogleFilter', 'all'); await sleep(300);
    t = await shown(p);
    ok(has(t, 'GFilter On') && has(t, 'GFilter Off') && has(t, 'GFilter Show'), 'back to "All entries" shows everything again', JSON.stringify(t));
    await p.select('#calGoogleFilter', 'on'); await sleep(200);
    p.google = view({ connected: false, state: 'none', account: null });
    await refresh(p);
    t = await shown(p);
    ok((await strip(p)).filter === false && (await p.evaluate(() => document.getElementById('calGoogleFilter').value)) === 'all' && has(t, 'GFilter Off'), 'if Google is disconnected while the filter is on, the filter resets and the calendar shows everything', JSON.stringify(t));
    ok(p.errs.length === 0, 'no script errors (administrator)', p.errs.join(' | '));
    await p.close();

    // ═══ manager ═══
    const pm = await openCalendar(browser, managerCookie, view({ canManage: false }), { gotoDate: day(0) });
    s = await strip(pm);
    ok(s.run === true && s.setup === false, 'a manager can Sync now but is not offered Settings (administrator only)', JSON.stringify(s));
    await pm.close();

    // ═══ assistant ═══
    const pa = await openCalendar(browser, assistantCookie, view({ canManage: false, m365Enabled: true, doubleEntryRisk: true }), { gotoDate: day(0) });
    s = await strip(pa);
    ok(s.run === false && s.setup === false && /connected as owner@example\.test/.test(s.text) && /BOTH calendars/.test(s.warn || ''), 'an assistant sees the status and the warning but no buttons', JSON.stringify(s));
    await pa.close();

    // ═══ phone ═══
    const pp = await openCalendar(browser, adminCookie, view({ m365Enabled: true, doubleEntryRisk: true, sync: { lastRunAt: iso(1), lastOkAt: iso(60), healthy: false, lastError: 'Google Calendar could not be reached. Check the server\'s internet access and try again.', lastCategory: 'connection', errorAt: iso(1), failures: 2, errorKind: 'pull' } }), { width: 390, height: 844, gotoDate: day(0) });
    const m = await pp.evaluate(() => ({
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        w: document.getElementById('calGoogleStrip').getBoundingClientRect().width, vw: window.innerWidth,
        btnH: Math.min.apply(null, [...document.querySelectorAll('#calGoogleStrip .cal-m365-strip__btn')].filter(b => b.offsetParent !== null).map(b => b.getBoundingClientRect().height)),
        filterH: document.getElementById('calGoogleFilter').getBoundingClientRect().height
    }));
    ok(m.overflow <= 1 && m.w <= m.vw && m.btnH >= 43 && m.filterH >= 43, 'on a phone nothing scrolls sideways, the strip fits, and its buttons and the filter are at least 44px tall', JSON.stringify(m));
    if (SHOTS) await pp.screenshot({ path: SHOTS + '/calendar-google-phone.png' });
    await pp.close();

    await browser.close();
    await support.stop();
    console.log(fails ? `\n${fails} FAILED` : '\nAll Calendar x Google browser checks passed');
    process.exit(fails ? 1 : 0);
})().catch(async (e) => { console.error('BROWSER TEST ERROR', e); try { console.error(support.getChildLog().slice(-1500)); await support.stop(); } catch (_) {} process.exit(2); });
