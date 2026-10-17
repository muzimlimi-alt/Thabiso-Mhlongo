// Admin -> Calendar -> Microsoft 365: the sync strip and its panel, a marker on every item (synced / waiting / failed / changed in Outlook / deleted in Outlook), the
// popup section with its actions, appointments that live only in Outlook, the sync filter, and what each role may do - driven through the REAL admin.html on an isolated
// DB copy (test/support.js: SMTP mocked, the real database and Microsoft are never touched). The sync STATE is seeded straight into the throwaway DB (the engine itself is
// covered by test/calendar-m365.test.js against a fake Graph); this test is about what the administrator sees and can do.
//
// Not part of `npm test`: run it with `npm run test:browser` (needs PUPPETEER_EXECUTABLE_PATH on this machine, see test-suite notes).
const sqlite3 = require('sqlite3');
const moment = require('moment-timezone');
const support = require('../support');
const puppeteer = require('puppeteer');
const { BASE, sleep } = support;
let fails = 0;
const ok = (c, n, detail) => { if (!c) fails++; console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '\n        -> ' + detail)); };
const PASSWORD = 'TestRunnerPass1!';
const SHOTS = process.env.CAL_SHOTS_DIR || null;

function sqlRun(sql, params = []) {
    return new Promise((res, rej) => { const db = new sqlite3.Database(support.TEST_DB); db.run(sql, params, function (e) { db.close(); e ? rej(e) : res(this); }); });
}
function sqlAll(sql, params = []) {
    return new Promise((res, rej) => { const db = new sqlite3.Database(support.TEST_DB); db.all(sql, params, (e, r) => { db.close(); e ? rej(e) : res(r); }); });
}
async function cookieFor(email) {
    const r = await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: PASSWORD }) });
    const sc = r.headers.get('set-cookie');
    if (r.status !== 200 || !sc) throw new Error('login failed for ' + email + ': ' + r.status);
    return sc.split(';')[0];
}
async function openCalendar(browser, cookie, { width = 1440, height = 1100, gotoDate } = {}) {
    const ctx = await browser.createBrowserContext();
    const p = await ctx.newPage();
    await p.setViewport({ width, height });
    p._errs = [];
    p.on('pageerror', e => p._errs.push(e.message.slice(0, 200)));
    p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|Loading the font|API Error/.test(m.text())) p._errs.push('console: ' + m.text().slice(0, 200)); });
    const [name, ...rest] = cookie.split('=');
    await p.setCookie({ name, value: rest.join('='), url: BASE });
    await p.setRequestInterception(true);
    p.on('request', r => {
        if (/\/api\/admin\/maps-config/.test(r.url())) return r.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, key: '' }) });
        r.continue();
    });
    await p.goto(BASE + '/admin.html', { waitUntil: 'networkidle0', timeout: 90000 });
    await p.waitForFunction(() => typeof window.switchTab === 'function' && typeof window.FullCalendar !== 'undefined', { timeout: 30000 });
    await p.evaluate(() => window.switchTab('calendarAdmin'));
    await p.waitForFunction(() => typeof adminCalendar !== 'undefined' && adminCalendar && (document.querySelectorAll('#calendar .fc-daygrid-day').length > 20 || !!document.querySelector('#calendar .fc-list')), { timeout: 30000 });
    if (gotoDate) { await p.evaluate(d => { adminCalendar.gotoDate(d); }, gotoDate); await sleep(900); }
    await p.waitForFunction(() => !document.getElementById('calM365Strip').hidden, { timeout: 20000 });
    return p;
}
const textOf = (p, sel) => p.evaluate(s => { const e = document.querySelector(s); return e ? e.innerText : null; }, sel);
const clickItem = async (p, title) => {
    const found = await p.evaluate(t => { const e = [...document.querySelectorAll('#calendar .fc-event')].find(x => x.textContent.includes(t) && x.offsetParent !== null); if (!e) return false; e.click(); return true; }, title);
    if (found) await sleep(400);
    return found;
};
const popupText = p => textOf(p, '#calEventPopup');
const closePopup = p => p.evaluate(() => { const e = document.getElementById('calEventPopup'); if (e) e.remove(); });

(async () => {
    await support.start();
    await support.loginAs('manager');
    await support.loginAs('assistant');
    const base = moment().add(2, 'months').startOf('month').add(2, 'days');       // a quiet month: every seeded item lands in one grid
    const day = n => base.clone().add(n, 'days').format('YYYY-MM-DD');
    const nowIso = (minAgo) => new Date(Date.now() - minAgo * 60000).toISOString();

    // ── seed ──
    const mkBooking = (o) => sqlRun(`INSERT INTO bookings (name, email, cell, date, message, status, event_start_time, performance_end_time, event_name, event_type, event_location, city, total_amount) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        ['Seed Client', `seed${o.n}@example.invalid`, '+27820000000', day(o.n), 'seed', o.status, o.start === undefined ? '18:00' : o.start, o.end === undefined ? '20:00' : o.end, o.title, 'Corporate', 'Seed Hall', 'Pretoria', 1000]).then(r => r.lastID);
    const mkLink = (type, id, o) => sqlRun(`INSERT INTO calendar_links (source_type, source_id, graph_event_id, create_token, web_link, sync_status, pushed_hash, attempt_count, next_attempt_at, last_error, last_error_category, conflict_json, last_synced_at, last_seen_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [type, id, o.graph === undefined ? 'GRAPH-' + type + id : o.graph, 'tok-' + type + id, o.web === undefined ? 'https://outlook.office.com/calendar/item/' + id : o.web, o.status, 'h', o.attempts || 0, o.next || null, o.error || null, o.cat || null, o.conflict ? JSON.stringify(o.conflict) : null, o.synced || null, nowIso(1)]);
    const bSynced = await mkBooking({ n: 0, status: 'CONFIRMED', title: 'Gala Synced' });
    const bPending = await mkBooking({ n: 1, status: 'CONFIRMED', title: 'Gala Pending' });
    const bError = await mkBooking({ n: 2, status: 'CONFIRMED', title: 'Gala Error' });
    const bConflict = await mkBooking({ n: 3, status: 'CONFIRMED', title: 'Gala Conflict' });
    const bDeleted = await mkBooking({ n: 4, status: 'CONFIRMED', title: 'Gala Deleted' });
    const bWaiting = await mkBooking({ n: 5, status: 'ACCEPTED', title: 'Gala Waiting' });
    const bQuoted = await mkBooking({ n: 6, status: 'QUOTED', title: 'Gala Quoted' });
    const evId = (await sqlRun(`INSERT INTO events (event_title, event_datetime, event_status, venue_name) VALUES (?,?,?,?)`, ['Show Synced', day(7) + 'T19:30', 'upcoming', 'The Lyric'])).lastID;
    await mkLink('booking', bSynced, { status: 'synced', synced: nowIso(3) });
    await mkLink('booking', bPending, { status: 'pending', graph: null });
    await mkLink('booking', bError, { status: 'error', attempts: 3, next: new Date(Date.now() + 3600000).toISOString(), cat: 'permission', error: 'The app is not allowed to use the calendar of this mailbox (403).' });
    await mkLink('booking', bConflict, { status: 'conflict', cat: 'conflict', error: 'Changed in Microsoft 365', conflict: { subject: 'Gala Conflict - moved by Sipho', start: day(3) + 'T10:00', end: day(3) + 'T12:00', isAllDay: false, location: '', showAs: 'busy' } });
    await mkLink('booking', bDeleted, { status: 'external_deleted', cat: 'notfound', error: 'This event was deleted in Microsoft 365.' });
    await mkLink('event', evId, { status: 'synced', synced: nowIso(3) });
    const ext = (id, subject, o) => sqlRun(`INSERT INTO calendar_external_events (graph_event_id, subject, start_date, start_time, end_date, end_time, all_day, show_as, location, web_link, blocks) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [id, subject, o.sd, o.st || null, o.ed, o.et || null, o.allDay ? 1 : 0, o.showAs, o.loc || '', 'https://outlook.office.com/calendar/item/' + id, o.blocks ? 1 : 0]);
    const HOSTILE = '&lt;img src=x onerror=&quot;window.__xss=1&quot;&gt; Dentist &amp; Co';     // stored the way the sync stores it: entity-encoded once
    await ext('X-BUSY', HOSTILE, { sd: day(8), st: '09:00', ed: day(8), et: '10:00', showAs: 'busy', blocks: true, loc: 'Clinic' });
    await ext('X-FREE', 'Lunch break (free)', { sd: day(9), ed: day(10), allDay: true, showAs: 'free' });
    await ext('X-TENT', 'Maybe: supplier call', { sd: day(9), st: '14:00', ed: day(9), et: '15:00', showAs: 'tentative' });
    await sqlRun(`INSERT INTO date_holds (hold_date, notes, status, hold_expires_at, start_time, end_time, block_type, m365_event_id) VALUES (?, 'Microsoft 365 calendar', 'active', '9999-12-31 23:59:59', '09:00', '10:00', 'm365_sync', 'X-BUSY')`, [day(8)]);
    await sqlRun(`INSERT INTO calendar_sync_log (direction, action, source_type, source_id, outcome, category, message) VALUES ('push', 'create', 'booking', ?, 'ok', NULL, NULL)`, [bSynced]);
    await sqlRun(`INSERT INTO calendar_sync_log (direction, action, source_type, source_id, outcome, category, message) VALUES ('push', 'update', 'booking', ?, 'error', 'permission', 'The app is not allowed to use the calendar of this mailbox (403).')`, [bError]);
    await sqlRun(`UPDATE calendar_sync_state SET enabled = 1, mailbox = 'bookings@test.invalid', last_run_at = ?, last_success_at = ?, baseline_at = ? WHERE id = 1`, [nowIso(1), nowIso(2), nowIso(30)]);

    // ── the data the screen gets ──
    const adminCookie = await cookieFor('test.runner@example.invalid');
    const managerCookie = await cookieFor('test.manager@example.invalid');
    const assistantCookie = await cookieFor('test.assistant@example.invalid');
    const feed = await (await fetch(BASE + '/api/admin/calendar/events', { headers: { Cookie: adminCookie } })).json();
    const byTitle = (t) => feed.find(e => String(e.title).includes(t));
    ok(byTitle('Gala Synced').extendedProps.m365.status === 'synced' && byTitle('Gala Error').extendedProps.m365.status === 'error' && byTitle('Gala Conflict').extendedProps.m365.status === 'conflict', 'the calendar feed carries each booking\'s sync state', JSON.stringify(byTitle('Gala Error').extendedProps));
    ok(byTitle('Gala Waiting').extendedProps.m365 === null && byTitle('Gala Waiting').extendedProps.m365Eligible === true && byTitle('Gala Quoted').extendedProps.m365Eligible === false, 'a booking with no entry yet says whether it WILL be shared (accepted) or never is (enquiry)', JSON.stringify([byTitle('Gala Waiting').extendedProps.m365Eligible, byTitle('Gala Quoted').extendedProps.m365Eligible]));
    ok(feed.filter(e => e.extendedProps && e.extendedProps.type === 'external').length === 3, 'the three Outlook appointments are in the feed as read-only external items', JSON.stringify(feed.filter(e => e.extendedProps.type === 'external').map(e => e.id)));
    ok(!feed.some(e => e.extendedProps && e.extendedProps.blockType === 'm365_sync'), 'the hold that only mirrors an Outlook appointment is not shown a second time', '');
    const hostile = feed.find(e => e.id === 'x-X-BUSY');
    ok(hostile.title === '<img src=x onerror="window.__xss=1"> Dentist & Co', 'Outlook titles come out of the feed as plain text (decoded once) for the screen to show as text', hostile.title);
    ok(!JSON.stringify(feed).includes('GRAPH-booking') && !JSON.stringify(feed).includes('tok-booking'), 'no Microsoft id or create token reaches the browser', '');

    const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-quic'] });

    // ═══════════ administrator, desktop ═══════════
    const p = await openCalendar(browser, adminCookie, { gotoDate: base.format('YYYY-MM-DD') });
    await p.waitForFunction(() => document.querySelectorAll('#calendar .fc-event').length >= 10, { timeout: 20000 });
    const strip = await p.evaluate(() => ({ text: document.getElementById('calM365Text').textContent, cls: document.getElementById('calM365Strip').className,
        attn: document.getElementById('calM365Attention').textContent, attnShown: !document.getElementById('calM365Attention').hidden, run: !document.getElementById('calM365Run').hidden && document.getElementById('calM365Run').offsetParent !== null,
        ext: !document.getElementById('calFilterExternal').hidden, sel: !document.getElementById('calSyncFilterWrap').hidden }));
    ok(/connected/.test(strip.text) && /synced 2 min ago/.test(strip.text) && /cal-m365-strip--warn/.test(strip.cls), 'the strip says Microsoft 365 is connected and when it last synced (amber, because something needs attention)', JSON.stringify(strip));
    ok(strip.attnShown && /3 need attention/.test(strip.attn), 'it counts the entries that need attention (failed + changed in Outlook + deleted in Outlook)', JSON.stringify(strip));
    ok(strip.run && strip.ext && strip.sel, 'Sync now, the Microsoft 365 filter button and the sync filter are shown once the integration is in use', JSON.stringify(strip));

    const badges = await p.evaluate(() => ['synced', 'pending', 'error', 'conflict', 'external_deleted', 'External'].map(k => [k, document.querySelectorAll('#calendar .fc-m365-badge--' + k).length]));
    ok(badges.find(b => b[0] === 'synced')[1] >= 2 && badges.slice(1).every(b => b[1] >= 1), 'every state has its own marker on the calendar (synced on a booking and an event, waiting, failed, changed, deleted, Outlook appointment)', JSON.stringify(badges));
    const labelled = await p.evaluate(() => [...document.querySelectorAll('#calendar .fc-m365-badge')].every(b => b.getAttribute('role') === 'img' && b.getAttribute('aria-label') && b.title && b.querySelector('i')));
    ok(labelled, 'each marker is an icon with a text label (screen readers and hover), not colour alone', '');
    const noBadge = await p.evaluate(() => { const e = [...document.querySelectorAll('#calendar .fc-event')].find(x => x.textContent.includes('Gala Quoted')); return e ? e.querySelectorAll('.fc-m365-badge').length : -1; });
    ok(noBadge === 0, 'a website-only item (an enquiry) has no marker', String(noBadge));
    const extStyle = await p.evaluate(() => { const e = document.querySelector('#calendar .fc-event--type-external'); const s = e && getComputedStyle(e); return e ? { dashed: s.borderLeftStyle, img: s.backgroundImage } : null; });
    ok(extStyle && extStyle.dashed === 'dashed' && /gradient/.test(extStyle.img), 'an Outlook appointment looks different from a website item (hatched, dashed edge)', JSON.stringify(extStyle));
    ok(await p.evaluate(() => { const f = adminCalendar.getOption('eventAllow'); return f({}, { extendedProps: { type: 'external' } }) === false && f({}, { extendedProps: { type: 'booking' } }) === true; }), 'an Outlook appointment cannot be dragged; bookings still can', '');

    // escaping
    ok(await p.evaluate(() => window.__xss === undefined && !document.querySelector('#calendar img')), 'a hostile title from Outlook is shown as text on the calendar - no markup, no script', await p.evaluate(() => String(window.__xss)));
    ok(await clickItem(p, 'Dentist'), 'the hostile appointment can be opened', '');
    let pt = await popupText(p);
    ok(/Microsoft 365 calendar/.test(pt) && /<img src=x onerror="window.__xss=1"> Dentist & Co/.test(pt) && /Clinic/.test(pt) && /Blocks the booking form:\s*Yes/.test(pt) && /Shown as:\s*Busy/.test(pt), 'its popup shows the title literally, the place, "Busy" and that it blocks the booking form', pt);
    ok(await p.evaluate(() => window.__xss === undefined && !document.querySelector('#calEventPopup img')), '...without running or rendering anything', '');
    ok(/lives in Outlook/.test(pt) && !(await p.$('#calEventPopup [data-m365-act]')), '...and offers no edit actions (it lives in Outlook)', pt);
    const link = await p.evaluate(() => { const a = document.querySelector('#calEventPopup a'); return a ? { href: a.href, rel: a.rel, target: a.target } : null; });
    ok(link && /^https:\/\/outlook\.office\.com\//.test(link.href) && /noopener/.test(link.rel) && link.target === '_blank', '...with an Open in Outlook link that opens safely in a new tab', JSON.stringify(link));
    await closePopup(p);
    await clickItem(p, 'Lunch break');
    pt = await popupText(p);
    ok(/Shown as:\s*Free/.test(pt) && /Blocks the booking form:\s*No/.test(pt) && /all day/.test(pt), 'a free all-day appointment says it does not block the booking form', pt);
    await closePopup(p);

    // the popup sections
    await clickItem(p, 'Gala Synced');
    pt = await popupText(p);
    ok(/Synced/.test(pt) && /Last synced 3 min ago/.test(pt) && /Open in Outlook/.test(pt) && !/Retry|Keep website|Use Microsoft/.test(pt), 'a synced booking: "Synced", when, and Open in Outlook - nothing to fix', pt);
    await closePopup(p);
    await clickItem(p, 'Gala Pending');
    pt = await popupText(p);
    ok(/Waiting to sync/.test(pt), 'a queued booking: "Waiting to sync"', pt);
    await closePopup(p);
    await clickItem(p, 'Gala Error');
    pt = await popupText(p);
    ok(/Couldn't sync/.test(pt) && /3 tries/.test(pt) && /isn't allowed to change the Microsoft 365 calendar/.test(pt) && /Retry sync/.test(pt), 'a failed booking: plain-language reason (the Exchange permission), how many tries, and Retry sync', pt);
    ok(/not allowed to use the calendar of this mailbox \(403\)/.test(pt), '...with the technical detail underneath for whoever has to fix it', pt);
    await p.evaluate(() => document.querySelector('#calEventPopup [data-m365-act="retry"]').click());
    await p.waitForFunction(() => !document.getElementById('calEventPopup'), { timeout: 10000 });
    const retried = (await sqlAll(`SELECT next_attempt_at FROM calendar_links WHERE source_type = 'booking' AND source_id = ?`, [bError]))[0];
    ok(retried.next_attempt_at === null, 'Retry clears the back-off on the server (the next sync tries it at once)', JSON.stringify(retried));

    await clickItem(p, 'Gala Conflict');
    pt = await popupText(p);
    ok(/Changed in Microsoft 365/.test(pt) && /Someone changed this in Outlook/.test(pt) && /website[\s\S]*18:00–20:00/i.test(pt) && /microsoft 365[\s\S]*10:00–12:00/i.test(pt) && /moved by Sipho/.test(pt), 'a conflict: shows the website\'s time next to what Outlook now says, and what changed', pt);
    ok(/Keep website version/.test(pt) && /Use Microsoft 365 time/.test(pt) && /Nothing has been changed on the website/.test(pt), '...with both choices, and says nothing was overwritten', pt);
    await p.evaluate(() => document.querySelector('#calEventPopup [data-m365-act="keep_website"]').click());
    await p.waitForSelector('#tm-modal-confirm', { visible: true, timeout: 8000 });
    const ask = await p.evaluate(() => document.querySelector('.tm-modal-container').innerText);
    ok(/overwrites the change made in Outlook/.test(ask), '"Keep website version" asks for confirmation and says it overwrites the Outlook change', ask);
    await p.click('#tm-modal-cancel'); await sleep(300);
    ok((await sqlAll(`SELECT sync_status FROM calendar_links WHERE source_type = 'booking' AND source_id = ?`, [bConflict]))[0].sync_status === 'conflict', '...and cancelling leaves the conflict open', '');
    await closePopup(p);

    await clickItem(p, 'Gala Deleted');
    pt = await popupText(p);
    ok(/Deleted in Microsoft 365/.test(pt) && /not put back automatically/.test(pt) && /booking itself is unaffected/.test(pt) && /Re-create in Microsoft 365/.test(pt), 'a booking deleted in Outlook: says so, that it is not put back automatically, that the booking is fine, and offers Re-create', pt);
    await closePopup(p);
    await clickItem(p, 'Gala Waiting');
    pt = await popupText(p);
    ok(/Waiting to sync/.test(pt) && /within a couple of minutes/.test(pt), 'an accepted booking with no entry yet: "Waiting to sync" (it is going to be shared)', pt);
    await closePopup(p);
    await clickItem(p, 'Gala Quoted');
    pt = await popupText(p);
    ok(/Website only/.test(pt) && /Enquiries and quotes are shared only once the client has accepted/.test(pt), 'an enquiry: "Website only" with the reason', pt);
    await closePopup(p);
    await clickItem(p, 'Show Synced');
    pt = await popupText(p);
    ok(/Microsoft 365 calendar/.test(pt) && /Synced/.test(pt), 'a public event shows its sync state too', pt);
    await closePopup(p);

    // the filter
    const visibleCount = () => p.evaluate(() => [...document.querySelectorAll('#calendar .fc-event')].filter(e => e.offsetParent !== null && !e.classList.contains('fc-bg-event')).length);
    const all = await visibleCount();
    await p.select('#calSyncFilter', 'attention'); await sleep(300);
    const attention = await visibleCount();
    const onlyAttention = await p.evaluate(() => [...document.querySelectorAll('#calendar .fc-event')].filter(e => e.offsetParent !== null && !e.classList.contains('fc-bg-event')).every(e => /Gala (Error|Conflict|Deleted)/.test(e.textContent)));
    ok(attention === 3 && onlyAttention && all > attention, 'the sync filter "Needs attention" shows exactly the three entries that need it', JSON.stringify({ all, attention }));
    await p.select('#calSyncFilter', 'website'); await sleep(300);
    const websiteOnly = await p.evaluate(() => [...document.querySelectorAll('#calendar .fc-event')].filter(e => e.offsetParent !== null && !e.classList.contains('fc-bg-event')).map(e => e.textContent));
    ok(websiteOnly.some(t => /Gala Quoted/.test(t)) && websiteOnly.some(t => /Gala Waiting/.test(t)) && !websiteOnly.some(t => /Gala Synced|Dentist/.test(t)), '"Website only" shows items that are not in Microsoft 365 (enquiries, waiting) and hides synced ones and Outlook appointments', JSON.stringify(websiteOnly));
    await p.select('#calSyncFilter', 'all'); await sleep(300);
    await p.click('#calFilterExternal'); await sleep(300);
    ok(await p.evaluate(() => [...document.querySelectorAll('#calendar .fc-event--type-external')].every(e => e.offsetParent === null)) && await p.$eval('#calFilterExternal', b => b.getAttribute('aria-pressed') === 'false'), 'the "Microsoft 365" toggle hides Outlook appointments', '');
    await p.click('#calFilterExternal'); await sleep(300);

    // attention shortcut
    await p.click('#calM365Attention'); await sleep(300);
    ok(await p.$eval('#calSyncFilter', s => s.value) === 'attention', 'the "need attention" button applies the Needs attention filter', '');
    await p.select('#calSyncFilter', 'all');

    // panel
    await p.click('#calM365Toggle'); await sleep(300);
    const panel = await textOf(p, '#calM365Panel');
    ok(/bookings@test\.invalid/.test(panel) && /Africa\/Johannesburg/.test(panel) && /2 min ago/.test(panel) && /3 need attention/.test(panel) && /Test calendar access/.test(panel) && /Switch sharing off/.test(panel), 'the details panel shows the shared calendar, the business time zone, last sync, counts, and (for an administrator) Test / Switch', panel);
    ok(/never the client.s e-mail, phone number or notes/.test(panel.replace(/’/g, "'")) || (await p.evaluate(() => [...document.querySelectorAll('#calM365Panel details')].some(d => /never the client/.test(d.textContent)))), 'it explains what is and is not shared', '');
    await p.waitForSelector('#calM365Activity li', { timeout: 10000 });
    await p.click('#calM365Activity summary'); await sleep(200);
    const act = await textOf(p, '#calM365Activity');
    ok(/Recent activity/.test(act) && /update . booking/.test(act) && /error/.test(act) && /not allowed to use the calendar of this mailbox/.test(act) && /create . booking/.test(act), 'an administrator sees the recent sync activity (what was done to which booking, whether it worked, and why not)', act);
    await p.click('#calM365Test');
    await p.waitForSelector('#calM365Panel .cal-m365-steps li', { timeout: 15000 });
    const steps = await textOf(p, '#calM365Panel .cal-m365-test');
    ok(/Settings/.test(steps) && /mock mode/i.test(steps), '"Test calendar access" reports each step in plain language (mock mode here, so Microsoft is not contacted)', steps);
    await p.click('#calM365Toggle'); await sleep(200);
    ok(await p.$eval('#calM365Panel', e => e.hidden), 'the panel closes again', '');
    ok(p._errs.length === 0, 'no page errors on the calendar', JSON.stringify(p._errs));
    if (SHOTS) { await p.screenshot({ path: SHOTS + '/calendar-m365-desktop.png' }); }

    // the upcoming list escapes titles too (stubbed feed: whatever dates the copy of the database holds)
    const upcoming = await p.evaluate(async () => {
        const real = window.fetch;
        window.fetch = async () => ({ json: async () => [{ id: 'x-1', title: '<img src=x onerror="window.__xss2=1">Hostile', start: new Date(Date.now() + 86400000).toISOString(), extendedProps: { type: 'external', showAs: 'busy' } }] });
        await renderWorkingSchedule();
        window.fetch = real;
        const list = document.getElementById('upcomingScheduleList');
        return { imgs: list.querySelectorAll('img').length, text: list.textContent, label: /MICROSOFT 365/.test(list.textContent), xss: window.__xss2 };
    });
    ok(upcoming.imgs === 0 && upcoming.xss === undefined && /<img src=x/.test(upcoming.text) && upcoming.label, 'the Upcoming list shows an Outlook title as text and labels it "Microsoft 365"', JSON.stringify(upcoming));

    // ═══════════ manager and assistant ═══════════
    const pm = await openCalendar(browser, managerCookie, { gotoDate: base.format('YYYY-MM-DD') });
    const m = await pm.evaluate(() => ({ run: getComputedStyle(document.getElementById('calM365Run')).display, toggle: getComputedStyle(document.getElementById('calM365Toggle')).display }));
    await pm.click('#calM365Toggle'); await sleep(300);
    const mAdminBox = await pm.evaluate(() => getComputedStyle(document.querySelector('#calM365Panel .cal-m365-admin-box')).display);
    ok(!(await pm.$('#calM365Activity')), 'a manager is not shown the activity log (administrator only)', '');
    ok(m.run !== 'none' && mAdminBox === 'none', 'a manager can Sync now but is not offered Test / Switch (administrator only)', JSON.stringify({ m, mAdminBox }));
    await clickItem(pm, 'Gala Conflict');
    ok(/Keep website version/.test(await popupText(pm)), 'a manager can resolve a conflict', await popupText(pm));
    await pm.close();
    const pa = await openCalendar(browser, assistantCookie, { gotoDate: base.format('YYYY-MM-DD') });
    const a = await pa.evaluate(() => ({ run: getComputedStyle(document.getElementById('calM365Run')).display, strip: document.getElementById('calM365Text').textContent }));
    ok(a.run === 'none' && /Microsoft 365/.test(a.strip), 'an assistant sees the sync status (here: the plain-language reason the mock server cannot sync) but has no Sync now', JSON.stringify(a));
    await clickItem(pa, 'Gala Conflict');
    const aText = await popupText(pa);
    ok(/Changed in Microsoft 365/.test(aText) && (await pa.evaluate(() => [...document.querySelectorAll('#calEventPopup [data-m365-act]')].every(b => getComputedStyle(b).display === 'none'))), 'an assistant sees the conflict but none of the buttons that change anything', aText);
    await pa.close();

    // ═══════════ phone ═══════════
    const pp = await openCalendar(browser, adminCookie, { width: 390, height: 844, gotoDate: base.format('YYYY-MM-DD') });
    const phone = await pp.evaluate(() => ({
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        stripW: document.getElementById('calM365Strip').getBoundingClientRect().width, vw: window.innerWidth,
        btnH: Math.min.apply(null, [...document.querySelectorAll('.cal-m365-strip__btn')].filter(b => b.offsetParent !== null).map(b => b.getBoundingClientRect().height)),
        selH: document.getElementById('calSyncFilter').getBoundingClientRect().height
    }));
    ok(phone.overflow <= 1, 'on a phone the page does not scroll sideways', JSON.stringify(phone));
    ok(phone.stripW <= phone.vw && phone.btnH >= 43 && phone.selH >= 43, 'the strip fits the screen and its buttons / the filter are at least 44px tall', JSON.stringify(phone));
    if (SHOTS) { await pp.screenshot({ path: SHOTS + '/calendar-m365-phone.png' }); }
    await pp.close();

    await browser.close();
    await support.stop();
    console.log(fails ? `\n${fails} FAILED` : '\nAll calendar Microsoft 365 browser checks passed');
    process.exit(fails ? 1 : 0);
})().catch(async (e) => { console.error('BROWSER TEST ERROR', e); try { console.error(support.getChildLog().slice(-1500)); await support.stop(); } catch (_) {} process.exit(2); });
