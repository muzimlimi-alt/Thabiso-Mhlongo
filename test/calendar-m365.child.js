// Run by calendar-m365.test.js in its OWN process (it opens the database): the REAL lib/calendar-m365.js + lib/m365-graph.js against a fake Microsoft sign-in + Graph
// calendar (test/fake-graph.js) on a throwaway DB. Prints one "CHECK:{...}" line per assertion. Nothing reaches Microsoft.
const { startFakeGraph } = require('./fake-graph');
const moment = require('moment-timezone');
const rec = (name, pass, detail) => console.log('CHECK:' + JSON.stringify({ name, pass: !!pass, detail: pass ? '' : String(detail === undefined ? '' : detail).slice(0, 900) }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MAILBOX = 'bookings@test.invalid';
const SECRET = 'Zq9~fakeCalSyncSecret_VALUE-6';
const TENANT = '11111111-1111-1111-1111-111111111111', CLIENT = '22222222-2222-2222-2222-222222222222';
const SAST = 'South Africa Standard Time';

(async () => {
    const g = await startFakeGraph({ mailbox: MAILBOX, secret: SECRET, tenant: TENANT, pageSize: 2 });
    g.cal.pageSize = 3;
    process.env.SMTP_OAUTH_AUTHORITY = g.origin;
    process.env.M365_GRAPH_BASE_URL = g.origin + '/v1.0';
    process.env.BASE_URL = 'https://www.example.invalid';

    const db = require('../database');
    const sync = require('../lib/calendar-m365');
    const model = require('../lib/calendar-m365-model');
    const graph = require('../lib/m365-graph');
    const oauth = require('../lib/smtp-oauth');
    const q = (sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => e ? rej(e) : res(r)));
    const one = async (sql, p = []) => (await q(sql, p))[0];
    const run = (sql, p = []) => new Promise((res, rej) => db.run(sql, p, function (e) { e ? rej(e) : res(this.lastID); }));
    const quick = { sleep: async () => {}, retryBaseMs: 1 };
    const ctx = { mailbox: MAILBOX, oauth: { tenant: TENANT, clientId: CLIENT, secret: SECRET } };
    const deps = { resolveContext: async () => ({ ok: true, ctx }), graphRequest: (c, a) => graph.graphRequest(c, a, quick) };
    const go = (extra) => sync.runSync({ force: true, deps: { ...deps, ...(extra || {}) } });
    const waitFor = async (fn, ms = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(150); } return false; };

    for (let i = 0; i < 80; i++) {
        const t = await q("SELECT name FROM sqlite_master WHERE name IN ('calendar_sync_state','calendar_links','calendar_external_events','calendar_sync_log','bookings','events','date_holds')").catch(() => []);
        const st = await q('SELECT id FROM calendar_sync_state').catch(() => []);
        if (t.length === 7 && st.length === 1) break;
        await sleep(250);
    }
    const adminId = await run(`INSERT INTO admins (username, email, password_hash, role, is_active, must_change_password) VALUES ('cal.admin', 'cal.admin@test.invalid', 'x', 'administrator', 1, 0)`);

    const D = (n) => moment.tz('Africa/Johannesburg').add(n, 'days').format('YYYY-MM-DD');
    let bn = 0;
    const mkBooking = (o = {}) => run(
        `INSERT INTO bookings (name, email, cell, date, message, status, event_start_time, performance_end_time, performance_duration, event_name, event_type, event_location, city, total_amount)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [o.name || `Client ${++bn}`, o.email || `client${bn}@private.invalid`, '+27829990000', o.date || D(60), 'Private notes: gate code 9999', o.status || 'CONFIRMED',
            o.start === undefined ? '18:00' : o.start, o.end === undefined ? '20:00' : o.end, o.duration || null, o.event || `Show ${bn}`, 'Corporate', o.location || 'Test Hall', o.city || 'Pretoria', o.total || 12345]
    );
    const mkEvent = (o = {}) => run(
        `INSERT INTO events (event_title, event_datetime, event_start_time, event_end_time, event_status, venue_name, booking_id, ticket_sales_link) VALUES (?,?,?,?,?,?,?,?)`,
        [o.title || 'Public Show', o.datetime || D(90), o.start || null, o.end || null, o.status || 'upcoming', o.venue || 'The Lyric', o.bookingId || null, o.tickets || null]
    );
    const setStatus = (id, s) => run('UPDATE bookings SET status = ? WHERE id = ?', [s, id]);
    const link = (type, id) => one('SELECT * FROM calendar_links WHERE source_type = ? AND source_id = ?', [type, id]);
    const remoteOf = async (type, id) => { const l = await link(type, id); return l && l.graph_event_id ? g.cal.events.get(l.graph_event_id) : undefined; };
    const writes = () => g.cal.log.filter((l) => ['create', 'create-dedup', 'patch', 'delete'].includes(l.op));
    const writeOps = () => writes().map((l) => l.op).join(',');
    const clearLog = () => { g.cal.log.length = 0; g.cal.created.length = 0; };
    const bookingRow = (id) => one('SELECT * FROM bookings WHERE id = ?', [id]);
    const extCount = async () => (await one('SELECT COUNT(*) AS n FROM calendar_external_events')).n;
    const holds = (idPrefix) => q(`SELECT * FROM date_holds WHERE block_type = 'm365_sync' ${idPrefix ? 'AND m365_event_id = ?' : ''} ORDER BY hold_date, start_time`, idPrefix ? [idPrefix] : []);
    const outlook = (subject, startAt, endAt, extra) => ({ subject, start: { dateTime: startAt, timeZone: SAST }, end: { dateTime: endAt, timeZone: SAST }, ...(extra || {}) });

    // ══════════ the switch ══════════
    const idle = await sync.runIfDue();
    rec('switched off by default: nothing runs and Microsoft is never asked', idle === null && g.requests.length === 0 && (await sync.getStatus()).enabled === false, JSON.stringify(g.requests));
    const skipped = await sync.runSync({ deps });
    rec('...and an unforced run says it is switched off', skipped && skipped.skipped && /switched off/.test(skipped.skipped), JSON.stringify(skipped));

    // ══════════ nothing eligible: nothing published ══════════
    const enquiries = [];
    for (const s of ['NEW', 'PENDING', 'QUOTED']) enquiries.push(await mkBooking({ status: s, date: D(50) }));
    enquiries.push(await mkBooking({ status: 'CANCELLED', date: D(51) }));
    let r = await go();
    rec('enquiries and cancelled bookings are never published (no event, no link row)', r.ok && g.cal.events.size === 0 && (await q('SELECT * FROM calendar_links')).length === 0 && writeOps() === '', JSON.stringify([r, g.cal.events.size]));
    rec('the first run read the calendar (a full delta round) and saved a checkpoint', g.cal.log.some((l) => l.op === 'delta') && (await sync.getStatus()).hasCheckpoint === true, JSON.stringify(g.cal.log));

    // ══════════ publish ══════════
    const bC = await mkBooking({ status: 'CONFIRMED', date: D(60), start: '18:00', end: '20:30', event: 'Year End Gala', name: 'Ann Lee', location: 'Sandton Convention Centre', city: 'Johannesburg' });
    const snapshot = JSON.stringify(await bookingRow(bC));
    clearLog();
    r = await go();
    const lC = await link('booking', bC), eC = await remoteOf('booking', bC);
    rec('a CONFIRMED booking is published as ONE busy event, timed in the business zone', r.ok && g.cal.events.size === 1 && eC && eC.subject === 'Year End Gala - Ann Lee' && eC.showAs === 'busy' && eC.start.dateTime.startsWith(`${D(60)}T18:00:00`) && eC.end.dateTime.startsWith(`${D(60)}T20:30:00`) && eC.start.timeZone === SAST, JSON.stringify(eC));
    rec('...the link row maps the booking to the Graph id with a change key and a link back to Outlook; status synced', lC.sync_status === 'synced' && lC.graph_event_id === eC.id && !!lC.change_key && /^http/.test(lC.web_link || '') && lC.attempt_count === 0 && !lC.last_error, JSON.stringify(lC));
    rec('...it was created idempotently: the create token IS the Graph transactionId', g.cal.created.length === 1 && g.cal.created[0].transactionId === lC.create_token && lC.create_token.length > 20, JSON.stringify(g.cal.created));
    const sentDump = JSON.stringify(g.cal.created[0]);
    rec('PRIVACY: nothing about the client (e-mail, phone, notes) and no attendees went to the shared calendar', !/private\.invalid|\+2782999|gate code|9999/i.test(sentDump) && !g.cal.created[0].attendees, sentDump);
    rec('creating the Microsoft event changed NOTHING in the booking (status, payments, totals - the whole row is identical)', JSON.stringify(await bookingRow(bC)) === snapshot, '');

    const bA = await mkBooking({ status: 'ACCEPTED', date: D(61), event: 'Wedding', name: 'Bo Kim', start: null, end: null });
    const bN = await mkBooking({ status: 'CONFIRMED', date: D(62), start: '22:00', end: '01:00', event: 'Late Show', name: 'Cy Dube' });
    const evId = await mkEvent({ title: 'Comedy Night', datetime: `${D(91)}T19:30`, end: '21:00', tickets: 'https://tickets.example/x' });
    const evShadow = await mkEvent({ title: 'Gala (shadow of booking)', datetime: `${D(60)}T18:00`, bookingId: bC, status: 'upcoming' });
    const evDraft = await mkEvent({ title: 'Draft', datetime: `${D(92)}T19:30`, status: 'draft' });
    const evDay = await mkEvent({ title: 'All Day Festival', datetime: D(93) });
    clearLog();
    r = await go();
    const eA = await remoteOf('booking', bA), eN = await remoteOf('booking', bN), eE = await remoteOf('event', evId), eD = await remoteOf('event', evDay);
    rec('an ACCEPTED booking is TENTATIVE and says so; with no start time it is an ALL-DAY event ending at the next midnight', eA && eA.showAs === 'tentative' && /^\[Tentative\] Wedding - Bo Kim$/.test(eA.subject) && eA.isAllDay === true && eA.start.dateTime.startsWith(`${D(61)}T00:00:00`) && eA.end.dateTime.startsWith(`${D(62)}T00:00:00`), JSON.stringify(eA));
    rec('an overnight booking (22:00-01:00) ends the next morning', eN && eN.start.dateTime.startsWith(`${D(62)}T22:00:00`) && eN.end.dateTime.startsWith(`${D(63)}T01:00:00`), JSON.stringify(eN));
    rec('a public event is published with its venue and ticket link; an event with only a date is all-day', eE && eE.subject === 'Comedy Night' && eE.location.displayName === 'The Lyric' && /Tickets: https:\/\/tickets\.example\/x/.test(eE.body.content) && eD && eD.isAllDay === true, JSON.stringify([eE, eD]));
    rec('a booking\'s shadow event and a draft event are NOT published (one entry per booking; no duplicate of the Gala)', !(await link('event', evShadow)) && !(await link('event', evDraft)) && g.cal.events.size === 5, `${g.cal.events.size} events: ` + [...g.cal.events.values()].map((e) => e.subject).join(' | '));

    // ══════════ nothing to do -> nothing sent ══════════
    clearLog();
    r = await go();
    rec('a run with no changes sends no write at all (create/patch/delete)', r.ok && writeOps() === '' && r.stats.push.created === 0 && r.stats.push.updated === 0, JSON.stringify([writeOps(), r.stats]));
    rec('LOOP: our own events coming back through the delta feed are recognised - no conflict, no copy as somebody else\'s appointment, no hold', r.stats.pull.conflicts === 0 && (await extCount()) === 0 && (await holds()).length === 0 && (await q(`SELECT sync_status FROM calendar_links`)).every((l) => l.sync_status === 'synced'), JSON.stringify(r.stats));
    clearLog();
    await go(); await go();
    rec('...and stays that way over repeated runs (all-day and overnight entries included: no false "changed in Outlook")', writeOps() === '' && (await q(`SELECT sync_status FROM calendar_links WHERE sync_status != 'synced'`)).length === 0, writeOps());

    // Exchange re-stamping the change key without changing anything we own
    const k0 = (await link('booking', bC)).change_key;
    g.calEdit(eC.id, { categories: ['Website', 'Checked by Sipho'], body: { contentType: 'text', content: 'a note somebody added' } });
    clearLog();
    r = await go();
    const lC2 = await link('booking', bC);
    rec('a change key that moved without any change to title / time / place / availability is adopted quietly (no conflict, no write)', r.ok && lC2.sync_status === 'synced' && lC2.change_key !== k0 && writeOps() === '' && r.stats.pull.conflicts === 0, JSON.stringify([lC2.sync_status, r.stats.pull]));

    // ══════════ changes made on the website ══════════
    run('UPDATE bookings SET date = ? WHERE id = ?', [D(65), bC]);
    clearLog();
    r = await go();
    const eC3 = await remoteOf('booking', bC);
    rec('rescheduling a booking UPDATES its event in place (same Microsoft id, one event, no duplicate)', eC3 && eC3.id === eC.id && g.cal.events.size === 5 && writeOps() === 'patch' && eC3.start.dateTime.startsWith(`${D(65)}T18:00:00`), JSON.stringify([writeOps(), g.cal.events.size, eC3 && eC3.start]));
    await setStatus(bA, 'CONFIRMED');
    clearLog();
    await go();
    const eA2 = await remoteOf('booking', bA);
    rec('ACCEPTED -> CONFIRMED turns the entry from tentative to busy and drops the [Tentative] prefix, same event', eA2.id === eA.id && eA2.showAs === 'busy' && eA2.subject === 'Wedding - Bo Kim' && writeOps() === 'patch', JSON.stringify([eA2.showAs, eA2.subject, writeOps()]));
    run('UPDATE events SET event_title = ? WHERE event_id = ?', ['Comedy Night (late show added)', evId]);
    await go();
    rec('a public event edited on the website is updated in place', (await remoteOf('event', evId)).subject === 'Comedy Night (late show added)' && g.cal.events.size === 5, '');

    await setStatus(bC, 'CANCELLED');
    clearLog();
    r = await go();
    rec('cancelling a booking REMOVES its event; the link is kept as history (removed); the booking itself is untouched', !g.cal.events.has(eC.id) && (await link('booking', bC)).sync_status === 'removed' && writeOps() === 'delete' && (await bookingRow(bC)).status === 'CANCELLED' && (await bookingRow(bC)).total_amount === 12345, writeOps());
    clearLog();
    await go();
    rec('...and a cancelled booking is not touched again', writeOps() === '', writeOps());
    await setStatus(bN, 'COMPLETED');
    clearLog();
    await go();
    rec('a COMPLETED booking keeps its event unchanged (history stays on the calendar)', g.cal.events.has((await link('booking', bN)).graph_event_id) && writeOps() === '' && (await link('booking', bN)).sync_status === 'synced', writeOps());
    const bDel = await mkBooking({ status: 'CONFIRMED', date: D(70), event: 'To be erased' });
    await go();
    const delGraphId = (await link('booking', bDel)).graph_event_id;
    const eventsBefore = g.cal.events.size;
    await run('DELETE FROM bookings WHERE id = ?', [bDel]);
    clearLog();
    await go();
    rec('a booking that is erased from the website (POPIA / purge) has ONLY its own event removed; every other event is untouched', !g.cal.events.has(delGraphId) && g.cal.events.size === eventsBefore - 1 && (await link('booking', bDel)).sync_status === 'removed' && writeOps() === 'delete', writeOps());

    // ══════════ somebody edits an entry in Outlook -> flagged, nothing overwritten ══════════
    const bEdit = await mkBooking({ status: 'CONFIRMED', date: D(72), start: '19:00', end: '21:00', event: 'Edit Me', name: 'Di Mokoena', total: 5000 });
    await go();
    const lEdit = await link('booking', bEdit);
    const rowBefore = JSON.stringify(await bookingRow(bEdit));
    g.calEdit(lEdit.graph_event_id, { subject: 'Edit Me - moved by Sipho', start: { dateTime: `${D(73)}T10:00:00`, timeZone: SAST }, end: { dateTime: `${D(73)}T12:00:00`, timeZone: SAST } });
    clearLog();
    r = await go();
    const lEdit2 = await link('booking', bEdit);
    rec('CONFLICT: an edit made in Outlook marks the entry "conflict" and keeps what Microsoft now says', r.ok && lEdit2.sync_status === 'conflict' && /10:00/.test(lEdit2.conflict_json) && /moved by Sipho/.test(lEdit2.conflict_json) && r.stats.pull.conflicts === 1, JSON.stringify(lEdit2));
    rec('...and NOTHING is overwritten: the booking row is identical (date, status, payments) and the Outlook version stays on the calendar', JSON.stringify(await bookingRow(bEdit)) === rowBefore && g.cal.events.get(lEdit.graph_event_id).subject === 'Edit Me - moved by Sipho' && writeOps() === '', writeOps());
    run('UPDATE bookings SET event_name = ? WHERE id = ?', ['Edit Me (renamed on the website)', bEdit]);
    clearLog();
    await go();
    rec('while it is in conflict the website does not push over it either (waiting for an administrator)', writeOps() === '' && g.cal.events.get(lEdit.graph_event_id).subject === 'Edit Me - moved by Sipho' && (await link('booking', bEdit)).sync_status === 'conflict', writeOps());
    const logCount = (await q('SELECT COUNT(*) AS n FROM calendar_sync_log WHERE action = ?', ['conflict']))[0].n;
    await go();
    rec('...and the same conflict is not logged over and over', (await q('SELECT COUNT(*) AS n FROM calendar_sync_log WHERE action = ?', ['conflict']))[0].n === logCount, '');

    const bad = await sync.resolveConflict(lEdit.id, 'nonsense', adminId);
    const notConflict = await sync.resolveConflict((await link('booking', bC)).id, 'keep_website', adminId);
    const missing = await sync.resolveConflict(999999, 'keep_website', adminId);
    rec('resolving: unknown choice -> 400, an entry without a conflict -> 409, unknown entry -> 404', bad.status === 400 && notConflict.status === 409 && missing.status === 404, JSON.stringify([bad, notConflict, missing]));
    const noHook = await sync.resolveConflict(lEdit.id, 'accept_microsoft', adminId, {});
    rec('"use the Microsoft time" cannot be done by writing tables from the sync: without the validated date-change hook it is refused and nothing changes', !noHook.ok && (await link('booking', bEdit)).sync_status === 'conflict' && (await bookingRow(bEdit)).date === D(72), JSON.stringify(noHook));
    const refuse = await sync.resolveConflict(lEdit.id, 'accept_microsoft', adminId, { applyExternalSchedule: async () => ({ ok: false, status: 409, message: 'That time clashes with another booking.' }) });
    rec('...and when that hook refuses (e.g. a clash), the conflict stays open with the reason', !refuse.ok && /clashes/.test(refuse.message) && (await link('booking', bEdit)).sync_status === 'conflict', JSON.stringify(refuse));
    let hookArg = null;
    const accept = await sync.resolveConflict(lEdit.id, 'accept_microsoft', adminId, { applyExternalSchedule: async (a) => { hookArg = a; await run('UPDATE bookings SET date = ?, event_start_time = ?, performance_end_time = ? WHERE id = ?', [D(73), '10:00', '12:00', bEdit]); return { ok: true }; } });
    rec('"use the Microsoft time" hands the Microsoft schedule to the date-change hook and then re-syncs the entry', accept.ok && hookArg && /10:00/.test(JSON.stringify(hookArg.remote)) && hookArg.adminId === adminId && (await link('booking', bEdit)).sync_status === 'pending', JSON.stringify([accept, hookArg]));
    clearLog();
    await go();
    const lEdit3 = await link('booking', bEdit), remoteEdit = g.cal.events.get(lEdit.graph_event_id);
    rec('...after which the website wording (title) is sent for the new time and the entry is synced again, same Microsoft event', lEdit3.sync_status === 'synced' && remoteEdit.subject === 'Edit Me (renamed on the website) - Di Mokoena' && remoteEdit.start.dateTime.startsWith(`${D(73)}T10:00:00`) && writeOps() === 'patch', JSON.stringify([lEdit3.sync_status, remoteEdit.subject, writeOps()]));

    g.calEdit(lEdit.graph_event_id, { showAs: 'free' });
    await go();
    const keep = await sync.resolveConflict(lEdit.id, 'keep_website', adminId);
    clearLog();
    await go();
    const lEdit4 = await link('booking', bEdit);
    rec('"keep the website version" sends the website\'s entry again, overwriting the Outlook edit on purpose, and the conflict is cleared', keep.ok && lEdit4.sync_status === 'synced' && !lEdit4.conflict_json && g.cal.events.get(lEdit.graph_event_id).showAs === 'busy' && writeOps() === 'patch', JSON.stringify([keep.ok, lEdit4.sync_status, writeOps()]));
    rec('...who decided is in the log', (await one(`SELECT COUNT(*) AS n FROM calendar_sync_log WHERE action IN ('resolve_keep_website','resolve_accept_microsoft') AND actor_id = ?`, [adminId])).n === 2, '');

    // ══════════ "use the Microsoft 365 time" through the REAL date-change path ══════════
    const apply = { applyExternalSchedule: sync.applyExternalSchedule };
    const bAcc = await mkBooking({ status: 'CONFIRMED', date: D(200), start: '18:00', end: '20:00', event: 'Accept Me', name: 'Fay Zulu', total: 7777 });
    await go();
    const lAcc = await link('booking', bAcc);
    g.calEdit(lAcc.graph_event_id, { start: { dateTime: `${D(201)}T10:00:00`, timeZone: SAST }, end: { dateTime: `${D(201)}T12:30:00`, timeZone: SAST } });
    await go();
    const accBefore = await bookingRow(bAcc);
    rec('(setup) the edit in Outlook is flagged as a conflict', (await link('booking', bAcc)).sync_status === 'conflict', '');
    const acc = await sync.resolveConflict(lAcc.id, 'accept_microsoft', adminId, apply);
    const accRow = await bookingRow(bAcc);
    rec('ACCEPT: the booking\'s date, start and end now follow Microsoft - through the same validated date-change path the calendar drag uses', acc.ok && accRow.date === D(201) && accRow.event_start_time === '10:00' && accRow.performance_end_time === '12:30', JSON.stringify([acc, accRow.date, accRow.event_start_time, accRow.performance_end_time]));
    rec('...and nothing else about the booking moved: status, payment status, totals', accRow.status === accBefore.status && accRow.payment_status === accBefore.payment_status && accRow.total_amount === 7777 && accRow.email === accBefore.email, '');
    const accAudit = await one(`SELECT changed_by, new_values FROM audit_log WHERE table_name = 'bookings' AND record_id = ? AND action = 'UPDATE' AND changed_by = ? ORDER BY id DESC`, [bAcc, String(adminId)]);
    rec('...who accepted it is in the audit trail', accAudit && /"date":"/.test(accAudit.new_values) && accAudit.new_values.includes(D(201)), JSON.stringify(accAudit));
    clearLog();
    await go();
    const accRemote = await remoteOf('booking', bAcc);
    rec('...the entry is then synced again: still ONE Microsoft event, now at the accepted time, no conflict left', (await link('booking', bAcc)).sync_status === 'synced' && accRemote.start.dateTime.startsWith(`${D(201)}T10:00:00`) && accRemote.end.dateTime.startsWith(`${D(201)}T12:30:00`) && [...g.cal.events.values()].filter((e) => /^Accept Me/.test(e.subject)).length === 1, JSON.stringify([accRemote.start, accRemote.end]));

    // a clash is refused, exactly as dragging the booking onto that slot would be
    const bOther = await mkBooking({ status: 'CONFIRMED', date: D(210), start: '18:00', end: '20:00', event: 'Already There' });
    const bClash = await mkBooking({ status: 'CONFIRMED', date: D(211), start: '18:00', end: '20:00', event: 'Will Clash' });
    await go();
    const lClash = await link('booking', bClash);
    g.calEdit(lClash.graph_event_id, { start: { dateTime: `${D(210)}T19:00:00`, timeZone: SAST }, end: { dateTime: `${D(210)}T21:00:00`, timeZone: SAST } });
    await go();
    const clash = await sync.resolveConflict(lClash.id, 'accept_microsoft', adminId, apply);
    rec('ACCEPT onto a slot that clashes with another booking is REFUSED (409, the usual message); the booking is unchanged and the conflict stays open', !clash.ok && clash.status === 409 && /conflicts with an existing booking/.test(clash.message) && (await bookingRow(bClash)).date === D(211) && (await link('booking', bClash)).sync_status === 'conflict', JSON.stringify(clash));

    // an appointment somebody else has in the way (a busy Outlook appointment) blocks it too
    const bBusy = await mkBooking({ status: 'CONFIRMED', date: D(212), start: '18:00', end: '20:00', event: 'Blocked By Outlook' });
    await go();
    const dentist = g.calSeed(outlook('Dentist', `${D(213)}T09:00:00`, `${D(213)}T11:00:00`, { showAs: 'busy' }));
    await go();
    const lBusy = await link('booking', bBusy);
    g.calEdit(lBusy.graph_event_id, { start: { dateTime: `${D(213)}T10:00:00`, timeZone: SAST }, end: { dateTime: `${D(213)}T12:00:00`, timeZone: SAST } });
    await go();
    const busyTry = await sync.resolveConflict(lBusy.id, 'accept_microsoft', adminId, apply);
    rec('...and so does somebody else\'s busy appointment on that calendar (it holds the date for the website too)', !busyTry.ok && busyTry.status === 409 && (await bookingRow(bBusy)).date === D(212), JSON.stringify(busyTry));

    g.calDelete(dentist.id);
    await go();

    // overnight, multi-day, all-day
    const bNight = await mkBooking({ status: 'CONFIRMED', date: D(220), start: '20:00', end: '22:00', event: 'Night Move' });
    await go();
    const lNight = await link('booking', bNight);
    g.calEdit(lNight.graph_event_id, { start: { dateTime: `${D(222)}T22:00:00`, timeZone: SAST }, end: { dateTime: `${D(223)}T01:00:00`, timeZone: SAST } });
    await go();
    const night = await sync.resolveConflict(lNight.id, 'accept_microsoft', adminId, apply);
    const nightRow = await bookingRow(bNight);
    rec('an overnight time from Outlook (22:00 -> 01:00 the next day) is accepted as an overnight booking', night.ok && nightRow.date === D(222) && nightRow.event_start_time === '22:00' && nightRow.performance_end_time === '01:00', JSON.stringify([night, nightRow.date, nightRow.event_start_time, nightRow.performance_end_time]));
    const bMulti = await mkBooking({ status: 'CONFIRMED', date: D(230), start: '18:00', end: '20:00', event: 'Multi Day' });
    await go();
    const lMulti = await link('booking', bMulti);
    g.calEdit(lMulti.graph_event_id, { start: { dateTime: `${D(230)}T18:00:00`, timeZone: SAST }, end: { dateTime: `${D(233)}T12:00:00`, timeZone: SAST } });
    await go();
    const multi = await sync.resolveConflict(lMulti.id, 'accept_microsoft', adminId, apply);
    rec('an event stretched over several days in Outlook is refused (a booking is one day) - nothing changes', !multi.ok && multi.status === 422 && /several days|next day/.test(multi.message) && (await bookingRow(bMulti)).date === D(230), JSON.stringify(multi));
    const bDay = await mkBooking({ status: 'CONFIRMED', date: D(240), start: '18:00', end: '20:00', event: 'Becomes All Day' });
    await go();
    const lDay = await link('booking', bDay);
    g.calEdit(lDay.graph_event_id, { isAllDay: true, start: { dateTime: `${D(241)}T00:00:00`, timeZone: SAST }, end: { dateTime: `${D(242)}T00:00:00`, timeZone: SAST } });
    await go();
    const day = await sync.resolveConflict(lDay.id, 'accept_microsoft', adminId, apply);
    const dayRow = await bookingRow(bDay);
    rec('an event turned into an ALL-DAY event in Outlook is accepted as a booking with no start / end time', day.ok && dayRow.date === D(241) && dayRow.event_start_time === null && dayRow.performance_end_time === null, JSON.stringify([day, dayRow.date, dayRow.event_start_time, dayRow.performance_end_time]));
    const evAcc = await mkEvent({ title: 'Accept Event', datetime: `${D(250)}T19:00`, end: '21:00' });
    await go();
    const lEv = await link('event', evAcc);
    g.calEdit(lEv.graph_event_id, { subject: 'Accept Event - changed' });
    await go();
    const evTry = await sync.resolveConflict(lEv.id, 'accept_microsoft', adminId, apply);
    rec('for a public event "use the Microsoft time" is not offered by the sync: it points to the Events screen (422) and changes nothing', !evTry.ok && evTry.status === 422 && /Events screen/.test(evTry.message) && (await link('event', evAcc)).sync_status === 'conflict', JSON.stringify(evTry));

    // ══════════ the existing hooks nudge the sync ══════════
    sync._internals.setDefaultDeps(deps);
    await sync.setEnabled(true, adminId);
    const calSync = require('../lib/calendar-sync');
    const googleCal = require('../lib/google-calendar');
    const bHook = await mkBooking({ status: 'CONFIRMED', date: D(260), event: 'Hooked' });
    await run(`UPDATE calendar_sync_state SET last_run_at = NULL, retry_after = NULL WHERE id = 1`);
    calSync.syncBookingToCalendar(bHook).catch(() => {});
    const hooked = await waitFor(async () => !!(await link('booking', bHook)) && (await link('booking', bHook)).sync_status === 'synced');
    rec('saving a booking through the existing Google sync entry point also brings it to the Microsoft calendar within seconds (no change to any caller)', hooked, JSON.stringify(await link('booking', bHook)));
    await setStatus(bHook, 'CANCELLED');
    googleCal.deleteGoogleEvent(null).catch(() => {});
    const unhooked = await waitFor(async () => (await link('booking', bHook)).sync_status === 'removed');
    rec('a cancellation (which always calls deleteGoogleEvent) removes it from the Microsoft calendar within seconds', unhooked && ![...g.cal.events.values()].some((e) => /^Hooked/.test(e.subject)), JSON.stringify(await link('booking', bHook)));
    await sync.setEnabled(false, adminId);
    sync._internals.setDefaultDeps({});

    // ══════════ somebody deletes an entry in Outlook -> flagged, never recreated on its own ══════════
    const bGone = await mkBooking({ status: 'CONFIRMED', date: D(80), event: 'Deleted In Outlook', name: 'Eli Naidoo' });
    await go();
    const lGone = await link('booking', bGone);
    const goneRow = JSON.stringify(await bookingRow(bGone));
    g.calDelete(lGone.graph_event_id);
    clearLog();
    r = await go();
    const lGone2 = await link('booking', bGone);
    rec('EXTERNAL DELETE: an entry deleted in Outlook is flagged "external_deleted"; the booking is untouched', lGone2.sync_status === 'external_deleted' && JSON.stringify(await bookingRow(bGone)) === goneRow && r.stats.pull.externalDeleted === 1, JSON.stringify(lGone2));
    run('UPDATE bookings SET event_name = ? WHERE id = ?', ['Deleted In Outlook (renamed)', bGone]);
    clearLog();
    await go(); await go();
    rec('...it is NOT re-created on its own, however often the sync runs or the booking changes', writeOps() === '' && !g.cal.events.has(lGone.graph_event_id) && [...g.cal.events.values()].every((e) => !/Deleted In Outlook/.test(e.subject)), writeOps());
    const re = await sync.recreateLink(lGone.id, adminId);
    clearLog();
    await go();
    const lGone3 = await link('booking', bGone);
    rec('an administrator can ask for it back: it is created again (a NEW Microsoft id), once', re.ok && lGone3.sync_status === 'synced' && lGone3.graph_event_id && lGone3.graph_event_id !== lGone.graph_event_id && writeOps() === 'create' && [...g.cal.events.values()].filter((e) => /Deleted In Outlook/.test(e.subject)).length === 1, JSON.stringify([re.ok, lGone3.sync_status, writeOps()]));
    rec('re-creating is only offered for a deleted entry (409 otherwise)', (await sync.recreateLink(lGone3.id, adminId)).status === 409, '');

    const bGone2 = await mkBooking({ status: 'CONFIRMED', date: D(81), event: 'Deleted Then Cancelled' });
    await go();
    g.calDelete((await link('booking', bGone2)).graph_event_id);
    await go();
    await setStatus(bGone2, 'CANCELLED');
    clearLog();
    r = await go();
    rec('a deleted-in-Outlook entry whose booking is then cancelled just becomes "removed" - no pointless delete call, no error', (await link('booking', bGone2)).sync_status === 'removed' && writeOps() === '' && r.ok, writeOps());

    // a deletion that the delta feed does not report (it happened between our read and our write)
    const bRace = await mkBooking({ status: 'CONFIRMED', date: D(82), event: 'Race' });
    await go();
    g.cal.events.delete((await link('booking', bRace)).graph_event_id);   // gone, but nobody has told the feed
    run('UPDATE bookings SET event_name = ? WHERE id = ?', ['Race (renamed)', bRace]);
    clearLog();
    await go();
    rec('updating an event that has meanwhile vanished (404) flags it external_deleted instead of failing or re-creating', (await link('booking', bRace)).sync_status === 'external_deleted' && !writes().some((l) => l.op === 'create'), JSON.stringify(g.cal.log));
    // a deletion the feed never mentioned, found by the daily full read
    const bMissed = await mkBooking({ status: 'CONFIRMED', date: D(83), event: 'Missed Deletion' });
    await go();
    g.cal.events.delete((await link('booking', bMissed)).graph_event_id);
    await run(`UPDATE calendar_sync_state SET baseline_at = '2000-01-01T00:00:00.000Z' WHERE id = 1`);
    clearLog();
    await go();
    rec('the daily full read of the window catches a deletion the feed missed', (await link('booking', bMissed)).sync_status === 'external_deleted', (await link('booking', bMissed)).sync_status);

    // ══════════ other people's appointments ══════════
    const before = JSON.stringify((await q('SELECT source_id FROM calendar_links ORDER BY id')).map((x) => x.source_id));
    const tom = g.calSeed(outlook('Tom & "Jerry" <b>x</b>', `${D(100)}T10:00:00`, `${D(100)}T11:00:00`, { showAs: 'busy', location: { displayName: 'Clinic' } }));
    const free = g.calSeed(outlook('Lunch (free)', `${D(101)}T00:00:00`, `${D(102)}T00:00:00`, { isAllDay: true, showAs: 'free' }));
    const tent = g.calSeed(outlook('Maybe meeting', `${D(103)}T09:00:00`, `${D(103)}T10:00:00`, { showAs: 'tentative' }));
    const trip = g.calSeed(outlook('Away', `${D(110)}T00:00:00`, `${D(113)}T00:00:00`, { isAllDay: true, showAs: 'oof' }));
    const occ = g.calSeed(outlook('Weekly standup', `${D(120)}T08:00:00`, `${D(120)}T08:30:00`, { showAs: 'busy', type: 'occurrence', seriesMasterId: 'AAMkMaster=' }));
    const cancelled = g.calSeed(outlook('Called off', `${D(121)}T08:00:00`, `${D(121)}T09:00:00`, { showAs: 'busy', isCancelled: true }));
    const weird = g.calSeed(outlook('Unreadable', `${D(122)}T08:00:00`, `${D(122)}T09:00:00`));
    g.cal.events.get(weird.id).start = { dateTime: `${D(122)}T08:00:00.0000000`, timeZone: 'Atlantis Standard Time' };
    clearLog();
    r = await go();
    rec('everybody else\'s appointments are mirrored read-only: 5 shown, the cancelled one and the unreadable one skipped (counted, no crash)', r.ok && (await extCount()) === 5 && r.stats.pull.unreadable === 1, JSON.stringify([await extCount(), r.stats.pull]));
    const mTom = await one('SELECT * FROM calendar_external_events WHERE graph_event_id = ?', [tom.id]);
    rec('...their text is stored entity-encoded once (the site\'s stored-text convention), so markup in a title cannot become markup', mTom.subject === 'Tom &amp; &quot;Jerry&quot; &lt;b&gt;x&lt;/b&gt;' && mTom.location === 'Clinic' && mTom.start_time === '10:00' && mTom.end_time === '11:00' && mTom.blocks === 1, JSON.stringify(mTom));
    const hTom = await holds(tom.id), hTrip = await holds(trip.id);
    rec('a BUSY appointment holds exactly its hour for the public booking form; the hold carries no title (nothing about the appointment leaks)', hTom.length === 1 && hTom[0].hold_date === D(100) && hTom[0].start_time === '10:00' && hTom[0].end_time === '11:00' && hTom[0].status === 'active' && hTom[0].notes === 'Microsoft 365 calendar' && hTom[0].block_type === 'm365_sync', JSON.stringify(hTom));
    rec('an OUT-OF-OFFICE trip of three all-day days holds those three whole days', hTrip.length === 3 && hTrip.every((h) => h.start_time === null && h.end_time === null) && hTrip[0].hold_date === D(110) && hTrip[2].hold_date === D(112), JSON.stringify(hTrip));
    rec('free and tentative appointments are shown but do NOT block', (await holds(free.id)).length === 0 && (await holds(tent.id)).length === 0 && (await one('SELECT blocks FROM calendar_external_events WHERE graph_event_id = ?', [tent.id])).blocks === 0, '');
    rec('a recurring occurrence is read-only like any other (series master remembered)', (await one('SELECT series_master_id FROM calendar_external_events WHERE graph_event_id = ?', [occ.id])).series_master_id === 'AAMkMaster=', '');
    rec('LOOP: foreign appointments are never sent back to Microsoft, and the website\'s own entries were not touched', writeOps() === '' && JSON.stringify((await q('SELECT source_id FROM calendar_links ORDER BY id')).map((x) => x.source_id)) === before, writeOps());
    const availRows = await q(`SELECT start_time, end_time, block_type FROM date_holds WHERE hold_date = ? AND status = 'active' AND (hold_expires_at IS NULL OR hold_expires_at > datetime('now'))`, [D(100)]);
    rec('the existing availability check sees the hold (same query the public form uses)', availRows.length === 1 && availRows[0].block_type === 'm365_sync' && availRows[0].start_time === '10:00', JSON.stringify(availRows));
    await go();
    rec('a repeated run neither duplicates mirrors nor holds', (await extCount()) === 5 && (await holds()).length === 5, JSON.stringify([await extCount(), (await holds()).length]));

    g.calEdit(tom.id, { start: { dateTime: `${D(104)}T14:00:00`, timeZone: SAST }, end: { dateTime: `${D(104)}T15:00:00`, timeZone: SAST }, subject: 'Tom moved' });
    g.calEdit(trip.id, { showAs: 'free' });
    await go();
    const hTom2 = await holds(tom.id);
    rec('a foreign appointment moved in Outlook moves its hold (the old day is released)', hTom2.length === 1 && hTom2[0].hold_date === D(104) && hTom2[0].start_time === '14:00' && (await q(`SELECT 1 FROM date_holds WHERE m365_event_id = ? AND hold_date = ?`, [tom.id, D(100)])).length === 0, JSON.stringify(hTom2));
    rec('...one that becomes Free stops blocking but stays visible', (await holds(trip.id)).length === 0 && !!(await one('SELECT 1 FROM calendar_external_events WHERE graph_event_id = ?', [trip.id])), '');
    g.calDelete(tom.id);
    await go();
    rec('...and one deleted in Outlook disappears with its hold', !(await one('SELECT 1 FROM calendar_external_events WHERE graph_event_id = ?', [tom.id])) && (await holds(tom.id)).length === 0, '');

    // ══════════ failures and recovery ══════════
    const bRec = await mkBooking({ status: 'CONFIRMED', date: D(130), event: 'Recover Me' });
    g.cal.mode = '403';
    clearLog();
    r = await go();
    let st = await sync.getStatus();
    rec('no permission (403): the run fails with a plain message naming the Exchange calendar role, is flagged systemic, and backs off', !r.ok && r.category === 'permission' && /Application Calendars\.ReadWrite/.test(r.error) && st.consecutiveFailures >= 1 && !!st.retryAfter && st.lastErrorCategory === 'permission', JSON.stringify([r, st]));
    rec('...and nothing was sent while the calendar cannot be read (an Outlook edit must be seen before the website writes)', writeOps() === '' && !(await link('booking', bRec)), writeOps());
    rec('...no website data was lost or changed', (await bookingRow(bRec)).status === 'CONFIRMED', '');
    g.cal.mode = 'writes-403';
    r = await go();
    const lRec = await link('booking', bRec);
    rec('read works but write is refused (Calendars.Read only): the run fails with the role to grant; the booking stays QUEUED (pending, token kept) - not dropped', !r.ok && r.category === 'permission' && lRec && lRec.sync_status === 'pending' && !!lRec.create_token && !lRec.graph_event_id, JSON.stringify([r, lRec]));
    g.cal.mode = 'ok';
    clearLog();
    r = await go();
    const lRec2 = await link('booking', bRec);
    rec('RECOVERY: once the permission is fixed, the queued booking is created - exactly once, with the token it was queued with', r.ok && lRec2.sync_status === 'synced' && lRec2.create_token === lRec.create_token && g.cal.created.filter((c) => c.transactionId === lRec.create_token).length === 1 && st.consecutiveFailures >= 1 && (await sync.getStatus()).consecutiveFailures === 0, JSON.stringify([r.ok, lRec2.sync_status]));

    const bFlaky = await mkBooking({ status: 'CONFIRMED', date: D(131), event: 'Flaky' });
    g.cal.mode = '503';
    clearLog();
    r = await go();
    rec('Microsoft down (503): the pull fails, the run is not systemic and backs off; nothing is sent', !r.ok && r.category === 'server' && writeOps() === '' && !(await link('booking', bFlaky)), JSON.stringify(r));
    g.cal.mode = 'ok';
    await run(`UPDATE calendar_sync_state SET retry_after = NULL WHERE id = 1`);
    // a failure on ONE write must not stop the others
    const bOk = await mkBooking({ status: 'CONFIRMED', date: D(132), event: 'Fine' });
    let failNext = 1;
    const flakyDeps = { graphRequest: (c, a) => (a.method === 'POST' && failNext-- > 0) ? Promise.resolve({ ok: false, category: 'server', retryable: true, systemic: false, message: 'Microsoft Graph had a temporary problem (503).', status: 503 }) : graph.graphRequest(c, a, quick) };
    clearLog();
    r = await go(flakyDeps);
    const lFlaky = await link('booking', bFlaky), lOk = await link('booking', bOk);
    rec('one failed create does not stop the others: it is queued as "error" with a back-off and a plain reason, the other is created', r.ok && r.stats.push.errors === 1 && [lFlaky, lOk].filter((l) => l.sync_status === 'error').length === 1 && [lFlaky, lOk].filter((l) => l.sync_status === 'synced').length === 1, JSON.stringify([r.stats.push, lFlaky.sync_status, lOk.sync_status]));
    const failed = [lFlaky, lOk].find((l) => l.sync_status === 'error');
    rec('...the failed one records attempts, the category, a message an administrator can read, and when it will be tried again', failed.attempt_count === 1 && failed.last_error_category === 'server' && /temporary problem/.test(failed.last_error) && Date.parse(failed.next_attempt_at) > Date.now(), JSON.stringify(failed));
    clearLog();
    r = await sync.runSync({ deps });
    rec('...a normal run leaves it alone until its time (back-off); no tight retry loop', writeOps() === '' && (await link('booking', failed.source_id)).sync_status === 'error', writeOps());
    rec('retry: only a failed entry can be retried (409 otherwise); unknown -> 404', (await sync.retryLink([lFlaky, lOk].find((l) => l.sync_status === 'synced').id, adminId)).status === 409 && (await sync.retryLink(999999, adminId)).status === 404, '');
    const rt = await sync.retryLink(failed.id, adminId);
    clearLog();
    r = await go();
    const failed2 = await link('booking', failed.source_id);
    rec('"retry" clears the back-off and the next run creates it; the counters reset, no duplicate', rt.ok && failed2.sync_status === 'synced' && failed2.attempt_count === 0 && !failed2.last_error && [...g.cal.events.values()].filter((e) => e.subject.startsWith(failed.source_id === bFlaky ? 'Flaky' : 'Fine')).length === 1, JSON.stringify(failed2));

    // lost answer after a create: end to end, exactly one event
    const bLost = await mkBooking({ status: 'CONFIRMED', date: D(133), event: 'Lost Answer' });
    g.cal.mode = 'drop-after-apply-once';
    clearLog();
    r = await go();
    g.cal.mode = 'ok';
    rec('a create whose answer is lost is repeated with the same transactionId and ends as ONE event, linked', r.ok && (await link('booking', bLost)).sync_status === 'synced' && [...g.cal.events.values()].filter((e) => e.subject.startsWith('Lost Answer')).length === 1, JSON.stringify([r.ok, writeOps()]));

    // crash between "POST accepted" and "id recorded": the queued row still has its token
    const bCrash = await mkBooking({ status: 'CONFIRMED', date: D(134), event: 'Crash Window' });
    const tokenCrash = 'crash-token-' + Date.now();
    await run(`INSERT INTO calendar_links (source_type, source_id, create_token, sync_status) VALUES ('booking', ?, ?, 'pending')`, [bCrash, tokenCrash]);
    const orphan = await graph.graphRequest(ctx, { method: 'POST', path: '/calendar/events', resource: 'calendar', idempotent: true, body: { ...model.desiredForBooking({ id: bCrash, status: 'CONFIRMED', date: D(134), event_start_time: '18:00', performance_end_time: '20:00', event_name: 'Crash Window', client_name: 'X', event_location: 'Test Hall', city: 'Pretoria' }), transactionId: tokenCrash } }, quick);
    clearLog();
    r = await go();
    rec('CRASH WINDOW: an event Graph already made for a queued row is found again by its token - linked, not duplicated, not left as a stranger\'s appointment', r.ok && (await link('booking', bCrash)).graph_event_id === orphan.json.id && [...g.cal.events.values()].filter((e) => e.subject.startsWith('Crash Window')).length === 1 && !(await one('SELECT 1 FROM calendar_external_events WHERE graph_event_id = ?', [orphan.json.id])) && (await holds(orphan.json.id)).length === 0, JSON.stringify([r.ok, writeOps(), await link('booking', bCrash)]));

    // delta problems
    g.cal.deltaMode = '500';
    clearLog();
    run('UPDATE bookings SET event_name = ? WHERE id = ?', ['Recover Me 2', bRec]);
    r = await go();
    rec('the calendar feed failing (500) fails the run without systemic stop, and no push happens', !r.ok && r.category === 'server' && writeOps() === '', JSON.stringify(r));
    g.cal.deltaMode = '410-token';
    await run(`UPDATE calendar_sync_state SET retry_after = NULL WHERE id = 1`);
    clearLog();
    const extBefore = await extCount();
    const reqs0 = g.graphRequests.length;
    r = await go();
    const sent410 = g.graphRequests.slice(reqs0).map((x) => x.path);
    g.cal.deltaMode = 'ok';
    rec('an expired checkpoint (410) is repaired inside the same run: the window is read afresh, mirrors do not duplicate, and the pending website change is pushed', r.ok && (await remoteOf('booking', bRec)).subject.startsWith('Recover Me 2') && (await extCount()) === extBefore && (await sync.getStatus()).consecutiveFailures === 0 && /deltatoken=/.test(sent410.join(' ')) && /startDateTime=/.test(sent410.join(' ')), JSON.stringify([r, await extCount(), extBefore, sent410]));

    // sign-in problems
    oauth.clearTokens();
    r = await sync.runSync({ force: true, deps: { resolveContext: async () => ({ ok: true, ctx: { ...ctx, oauth: { ...ctx.oauth, secret: 'wrong-secret-VALUE' } } }), graphRequest: deps.graphRequest } });
    rec('an expired / wrong client secret fails the run as "auth" (systemic) with Microsoft\'s code and WITHOUT the secret', !r.ok && r.category === 'auth' && /AADSTS/.test(r.error) && !JSON.stringify(r).includes('wrong-secret-VALUE'), JSON.stringify(r));
    r = await sync.runSync({ force: true, deps: { resolveContext: async () => ({ ok: false, message: 'Mail is running in mock mode (SMTP_MOCK=true); Microsoft is not contacted.' }) } });
    rec('no usable Microsoft settings (e.g. mock mode) fails the run as "config" and contacts nobody', !r.ok && r.category === 'config', JSON.stringify(r));
    await run(`UPDATE calendar_sync_state SET retry_after = NULL, consecutive_failures = 0 WHERE id = 1`);
    oauth.clearTokens();

    // a different mailbox resets the checkpoint
    await run(`UPDATE calendar_sync_state SET mailbox = 'someone.else@test.invalid' WHERE id = 1`);
    r = await go();
    rec('a checkpoint that belongs to a different mailbox is discarded and the calendar is read afresh', r.ok && (await sync.getStatus()).mailbox === MAILBOX, JSON.stringify(r));

    // ══════════ volume: a bounded number of writes per run, the rest queued ══════════
    const bulk = [];
    for (let i = 0; i < 70; i++) bulk.push(await mkBooking({ status: 'CONFIRMED', date: D(140 + (i % 20)), start: '09:00', end: '10:00', event: `Bulk ${i}` }));
    clearLog();
    r = await go();
    const first = g.cal.created.length;
    rec('70 new bookings: a run makes at most 60 writes and queues the rest (polite to Microsoft)', r.ok && first === 60 && r.stats.push.deferred >= 10, JSON.stringify([first, r.stats.push]));
    r = await go();
    rec('...the next run finishes the rest; every booking has exactly one event', r.ok && (await q(`SELECT COUNT(*) AS n FROM calendar_links WHERE source_id IN (${bulk.join(',')}) AND sync_status = 'synced'`))[0].n === 70 && [...g.cal.events.values()].filter((e) => /^Bulk \d+ - /.test(e.subject)).length === 70, '');

    // resumable full read
    await run(`UPDATE calendar_sync_state SET baseline_at = NULL, delta_link = NULL WHERE id = 1`);
    clearLog();
    r = await go({ maxPages: 2, pageSize: 5 });
    const midState = await sync._internals.getState();
    rec('a full read that runs out of its page budget saves where it stopped and is NOT swept (this run did not see everything)', r.ok && !midState.baseline_at && !!midState.delta_link && r.stats.pull.pages === 2 && (await extCount()) > 0, JSON.stringify([r.ok, midState.baseline_at, r.stats.pull.pages]));
    let guard = 0;
    while (!(await sync._internals.getState()).baseline_at && guard++ < 60) await go({ maxPages: 2, pageSize: 5 });
    rec('...and the following runs carry on from there until the read is complete and a baseline is stored', !!(await sync._internals.getState()).baseline_at && guard < 60, String(guard));
    const odd = (await q(`SELECT source_id FROM calendar_links WHERE sync_status = 'external_deleted' ORDER BY source_id`)).map((x) => x.source_id);
    rec('...and no false deletions came out of the partial reads: only the two entries really deleted earlier are flagged as deleted (the conflicts left open on purpose stay open)', JSON.stringify(odd) === JSON.stringify([bRace, bMissed].sort((x, y) => x - y)), JSON.stringify(odd));

    // ══════════ status, concurrency, nudge, log hygiene ══════════
    const status = await sync.getStatus();
    rec('the status shows counts and times but never the checkpoint URL or anything from an event', status.hasCheckpoint === true && !JSON.stringify(status).includes('http') && status.businessTimeZone === 'Africa/Johannesburg' && typeof status.links.synced === 'number', JSON.stringify(status).slice(0, 400));
    const [a, b2] = await Promise.all([go(), go()]);
    rec('two runs at once: one does the work, the other steps aside (no double pushing)', [a, b2].filter((x) => x.skipped).length === 1 && [a, b2].filter((x) => x.ok && !x.skipped).length === 1, JSON.stringify([a, b2]));

    sync._internals.setDefaultDeps(deps);
    const en = await sync.setEnabled(true, adminId);
    const bNudge = await mkBooking({ status: 'CONFIRMED', date: D(160), event: 'Nudged' });
    await run(`UPDATE calendar_sync_state SET last_run_at = NULL, retry_after = NULL WHERE id = 1`);
    sync.requestSync('test'); sync.requestSync('test again');
    const nudged = await waitFor(async () => !!(await link('booking', bNudge)) && (await link('booking', bNudge)).sync_status === 'synced');
    rec('a nudge (a booking just changed) triggers one run within seconds when the sync is on', en.after === true && nudged, JSON.stringify(await link('booking', bNudge)));
    await sync.setEnabled(false, adminId);
    const bNoNudge = await mkBooking({ status: 'CONFIRMED', date: D(161), event: 'Not Nudged' });
    sync.requestSync('test');
    await sleep(6000);
    rec('...and does nothing when the sync is off', !(await link('booking', bNoNudge)), '');
    rec('switching on resets the checkpoint (a fresh read) and clears old failures; both switches are logged with who did it', (await q(`SELECT COUNT(*) AS n FROM calendar_sync_log WHERE action IN ('enable','disable') AND actor_id = ?`, [adminId]))[0].n >= 2, '');

    await run(`INSERT INTO calendar_sync_log (at, direction, action, outcome, message) VALUES ('2000-01-01 00:00:00', 'push', 'create', 'ok', 'ancient')`);
    await run(`INSERT INTO calendar_sync_log (direction, action, outcome, message) VALUES ('push', 'create', 'ok', 'recent')`);
    const pruned = await sync.pruneLog(true);
    rec('log retention: rows older than 90 days are pruned, recent ones are kept', pruned >= 1 && !(await one(`SELECT 1 FROM calendar_sync_log WHERE message = 'ancient'`)) && !!(await one(`SELECT 1 FROM calendar_sync_log WHERE message = 'recent'`)), String(pruned));
    const recentRows = await sync.recentLog(5);
    rec('the activity log is newest first, names who did a manual action, and carries no Microsoft event id', recentRows.length === 5 && recentRows[0].id > recentRows[1].id && recentRows.every((r) => !('graphEventId' in r)) && (await sync.recentLog(500)).length <= 200 && (await sync.recentLog(500)).some((r) => r.actor === 'cal.admin'), JSON.stringify(recentRows[0]));
    const logRows = await q('SELECT * FROM calendar_sync_log');
    const dumpLog = JSON.stringify(logRows);
    rec('the sync log has create / update / delete / conflict / external_delete / retry entries', ['create', 'update', 'delete', 'conflict', 'external_delete', 'retry', 'recreate'].every((x) => logRows.some((l) => l.action === x)), [...new Set(logRows.map((l) => l.action))].join(','));
    rec('...and NO secret, token, client e-mail, phone number or booking note is in it', !dumpLog.includes(SECRET) && !/Bearer|fake-access-token|private\.invalid|\+2782999|gate code/i.test(dumpLog), dumpLog.slice(0, 300));
    const linkDump = JSON.stringify(await q('SELECT * FROM calendar_links'));
    rec('...nor in the link table', !/private\.invalid|\+2782999|gate code|fake-access-token/i.test(linkDump) && !linkDump.includes(SECRET), '');
    rec('no request ever left for any mailbox but the configured one', g.graphRequests.every((x) => x.path.toLowerCase().startsWith(`/v1.0/users/${encodeURIComponent(MAILBOX)}/`.toLowerCase())), JSON.stringify(g.graphRequests.filter((x) => !x.path.toLowerCase().startsWith(`/v1.0/users/${encodeURIComponent(MAILBOX)}/`.toLowerCase())).slice(0, 3)));
    rec('every delta request asked for the business time zone', g.cal.log.filter((l) => l.op === 'delta').every((l) => /South Africa Standard Time/.test(l.prefer || '')), '');

    await g.close();
    process.exit(0);
})().catch((e) => { console.log('CHECK:' + JSON.stringify({ name: 'child crashed', pass: false, detail: String(e && e.stack || e).slice(0, 1500) })); process.exit(1); });
