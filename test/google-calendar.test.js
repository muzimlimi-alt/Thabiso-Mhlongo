// Admin -> System Settings -> Google Calendar (lib/google-config.js, lib/google-calendar.js, routes/admin/google-calendar.js).
//   A. the real libraries and routes, in a child process with a throwaway DB, against a fake Google sign-in + Calendar API (test/google-calendar.child.js): saving the
//      OAuth client, the connect round trip (one-time state, no session cookie, every refusal), re-pointing the shared Google client in place, Test connection,
//      disconnect, precedence over .env, and "nothing secret anywhere";
//   B. the same routes on the running (SMTP_MOCK) server: authentication and roles, what the generic settings API will and will not reveal or accept, masking, the
//      callback with no session, and that the request log never sees Google's one-time code or the state.
// Nothing here talks to Google: the child uses the fake, and the running server only ever builds the consent address (it is never fetched).
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3');
const support = require('./support');

const ROOT = path.join(__dirname, '..');
const CID = '444444444444-liveservertestclient00' + '.apps.googleusercontent.com';
const SECRET = 'GOCSPX' + '-liveServerTestSecret_VALUE-77';
const CB = '/api/admin/google-calendar/callback';

function runChild() {
    const tmpDb = path.join(os.tmpdir(), `google-child-${process.pid}-${Date.now()}.sqlite`);
    const env = {
        ...process.env, DB_PATH: tmpDb, NODE_ENV: 'test', R2_ENDPOINT: '', R2_BUCKET: '', R2_ACCESS_KEY_ID: '', R2_SECRET_ACCESS_KEY: '',
        SMTP_MOCK: 'true', EMAIL_OVERHAUL_ENABLED: '', SETTINGS_ENCRYPTION_KEY: 'test-only-settings-encryption-key'
    };
    ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN', 'SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'SMTP_AUTH', 'EMAIL_USER', 'EMAIL_PASS'].forEach((k) => delete env[k]);
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [path.join(__dirname, 'google-calendar.child.js')], { cwd: ROOT, env });
        let out = '';
        child.stdout.on('data', (d) => { out += d; });
        child.stderr.on('data', (d) => { out += d; });
        const timer = setTimeout(() => child.kill(), 280000);
        child.on('close', () => {
            clearTimeout(timer);
            for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + suffix); } catch (e) {} }
            resolve(out);
        });
    });
}

const writeDb = (sql, params = []) => new Promise((resolve, reject) => {
    const db = new sqlite3.Database(support.TEST_DB);
    db.run(sql, params, (e) => db.close(() => e ? reject(e) : resolve()));
});
const raw = async (method, urlPath) => {
    const r = await fetch(support.BASE + urlPath, { method, redirect: 'manual' });
    return { status: r.status, text: await r.text(), type: r.headers.get('content-type') || '' };
};

module.exports = async function ({ check, api, pub, loginAs, q, one, getChildLog, restart }) {
    // ══════════ A. the libraries and routes ══════════
    const out = await runChild();
    const checks = out.split('\n').filter((l) => l.startsWith('CHECK:')).map((l) => JSON.parse(l.slice(6)));
    check('the Google Calendar scenarios ran to the end', checks.length >= 75 && !checks.some((c) => c.name === 'child crashed'), out.slice(-2500));
    for (const c of checks) check(c.name, c.pass, c.detail);

    // ══════════ B. the running server ══════════
    const base = '/api/admin/google-calendar';
    const asManager = await loginAs('manager');
    const asAssistant = await loginAs('assistant');
    await writeDb("DELETE FROM settings WHERE LOWER(setting_key) LIKE 'google\\_cal\\_%' ESCAPE '\\'");

    // who may do what
    check('server: status / save / connect / test / disconnect without a session -> 401 each',
        [(await pub('GET', base)).status, (await pub('PUT', base + '/credentials', { clientId: CID, clientSecret: SECRET })).status, (await pub('POST', base + '/connect')).status, (await pub('POST', base + '/test')).status, (await pub('DELETE', base)).status].every((s) => s === 401), '');
    for (const [name, as] of [['assistant', asAssistant], ['manager', asManager]]) {
        const st = await as('GET', base);
        check(`server: ${name} may read the status but gets no client ID or redirect address`, st.status === 200 && st.body.canManage === false && !('clientId' in st.body) && !('redirectUri' in st.body), JSON.stringify(st.body));
        const codes = [(await as('PUT', base + '/credentials', { clientId: CID, clientSecret: SECRET })).status, (await as('POST', base + '/connect')).status, (await as('POST', base + '/test')).status, (await as('DELETE', base)).status];
        check(`server: ${name} cannot save, connect, test or disconnect (403 each)`, codes.every((s) => s === 403), codes.join(','));
    }
    const view = await api('GET', base);
    check('server: administrator sees canManage and the exact redirect address to register at Google', view.status === 200 && view.body.canManage === true && view.body.redirectUri === support.BASE + CB, JSON.stringify(view.body));

    // validation reaches the person who typed it, and refusals change nothing
    const bad = await api('PUT', base + '/credentials', { clientId: 'nope', clientSecret: SECRET });
    check('server: a malformed client ID -> 400 naming the field', bad.status === 400 && !!(bad.body.errors || {}).clientId, JSON.stringify(bad.body));
    // Connecting needs a client from somewhere: saved in the settings, or supplied by the server's .env (a developer's copy may have one; a clean checkout does not).
    const early = await api('POST', base + '/connect');
    if (view.body.clientId && view.body.secretSet) {
        const eu = early.body && early.body.url ? new URL(early.body.url) : null;
        check('server: connect with only the .env client (nothing saved yet) works - no need to retype it', early.status === 200 && !!eu && eu.searchParams.get('client_id') === view.body.clientId && view.body.idSource === 'environment', JSON.stringify(early.body));
    } else {
        check('server: connect before a client is saved -> 400 "save the client ID and secret first"', early.status === 400 && /Save the Google client ID/.test(early.body.message), JSON.stringify(early.body));
    }

    // the generic settings API must neither show nor accept these keys
    await writeDb("INSERT OR REPLACE INTO settings (setting_key, setting_value) VALUES ('google_cal_client_secret', 'enc:v1:SEEDED-ONLY-FOR-THE-TEST'), ('Google_Cal_Account', 'seeded@example.test'), ('notification_email', 'ops@example.test')");
    const all = await api('GET', '/api/admin/settings');
    check('server: the generic settings list never contains google_cal_* (any capitalisation), and still lists ordinary settings', all.status === 200 && !/google_cal_/i.test(JSON.stringify(all.body)) && !JSON.stringify(all.body).includes('SEEDED-ONLY') && all.body.settings.notification_email === 'ops@example.test', JSON.stringify(all.body).slice(0, 500));
    const put1 = await api('PUT', '/api/admin/settings', { settings: { google_cal_client_id: CID } });
    const put2 = await api('PUT', '/api/admin/settings', { settings: { Google_Cal_Client_Secret: 'x', notification_email: 'ops2@example.test' } });
    check('server: the generic settings API refuses to write google_cal_* (any capitalisation) - even mixed with ordinary keys - and writes nothing', put1.status === 400 && put2.status === 400 && !(await one("SELECT 1 AS x FROM settings WHERE setting_key = 'google_cal_client_id'")) && (await one("SELECT setting_value AS v FROM settings WHERE setting_key = 'notification_email'")).v === 'ops@example.test', JSON.stringify([put1, put2]));
    await writeDb("DELETE FROM settings WHERE LOWER(setting_key) LIKE 'google\\_cal\\_%' ESCAPE '\\'");

    // saving (through the real request sanitiser)
    const saved = await api('PUT', base + '/credentials', { clientId: CID, clientSecret: SECRET });
    check('server: saving a valid client -> 200, secretSet, state "incomplete", and the secret is nowhere in the answer', saved.status === 200 && saved.body.secretSet === true && saved.body.clientId === CID && saved.body.state === 'incomplete' && !JSON.stringify(saved.body).includes(SECRET), JSON.stringify(saved.body));
    const row = await one("SELECT setting_value AS v FROM settings WHERE setting_key = 'google_cal_client_secret'");
    check('server: the secret is stored encrypted (enc:v1:), never as text', !!row && row.v.startsWith('enc:v1:') && !row.v.includes(SECRET), row && row.v);
    const all2 = await api('GET', '/api/admin/settings');
    check('server: ...and still absent from the generic settings list', !/google_cal_/i.test(JSON.stringify(all2.body)) && !JSON.stringify(all2.body).includes(SECRET), '');
    const audit = await one("SELECT * FROM audit_log WHERE table_name = 'settings' AND new_values LIKE '%google_calendar%' ORDER BY id DESC");
    check('server: ...the change is in the audit trail without the secret', !!audit && !JSON.stringify(audit).includes(SECRET), JSON.stringify(audit));

    // connect: the address Google is sent to, and what is remembered
    const conn = await api('POST', base + '/connect');
    const u = conn.body && conn.body.url ? new URL(conn.body.url) : null;
    check('server: connect returns the Google consent address for THIS client with the right redirect address, offline access and a state', conn.status === 200 && !!u && u.hostname === 'accounts.google.com' && u.searchParams.get('client_id') === CID && u.searchParams.get('redirect_uri') === support.BASE + CB && u.searchParams.get('access_type') === 'offline' && !!u.searchParams.get('state') && !conn.body.url.includes(SECRET), JSON.stringify(conn.body));
    const state = u && u.searchParams.get('state');
    const pend = await one("SELECT setting_value AS v FROM settings WHERE setting_key = 'google_cal_pending'");
    check('server: only a hash of the state is stored', !!pend && !pend.v.includes(state), pend && pend.v);

    // the callback: no session, wrong state first
    const logMark = getChildLog().length;
    const wrong = await raw('GET', CB + '?state=wrong-state&code=4/0AbCdEf-fake-code');
    check('server: the callback without a session and with a wrong state -> 400 page back to the admin (not 401), HTML', wrong.status === 400 && /text\/html/.test(wrong.type) && /was not connected/.test(wrong.text) && wrong.text.includes('/admin.html?google=state'), wrong.status + ' ' + wrong.text.slice(0, 200));
    check('server: ...and the wrong state did not cancel the connection in progress', !!(await one("SELECT 1 AS x FROM settings WHERE setting_key = 'google_cal_pending'")), '');
    const denied = await raw('GET', CB + '?state=' + encodeURIComponent(state) + '&error=access_denied');
    check('server: the callback with the right state but "access_denied" -> 400, "denied" outcome, and the state is spent', denied.status === 400 && denied.text.includes('/admin.html?google=denied') && !(await one("SELECT 1 AS x FROM settings WHERE setting_key = 'google_cal_pending'")), denied.text.slice(0, 200));
    await new Promise((r) => setTimeout(r, 300));
    const lines = getChildLog().slice(logMark).split('\n').filter((l) => l.includes('/api/admin/google-calendar/callback'));
    check('server: the request log recorded both callbacks but shows neither Google\'s code nor the state', lines.length >= 2 && !lines.some((l) => /code=|state=|error=|wrong-state|4\/0AbCdEf/.test(l)) && !getChildLog().includes(state), lines.join(' | '));

    // test / disconnect with nothing connected
    const t = await api('POST', base + '/test');
    check('server: test connection with no sign-in yet -> a normal answer (200, ok:false) saying Google is not connected', t.status === 200 && t.body.ok === false && t.body.steps.length === 1 && !t.body.steps[0].ok && /not connected|Connect Google/i.test(t.body.steps[0].message), JSON.stringify(t.body));
    const dc = await api('DELETE', base);
    check('server: disconnect with nothing to disconnect -> 200, nothing revoked, the client stays saved', dc.status === 200 && dc.body.revoked === false && dc.body.secretSet === true && dc.body.clientId === CID, JSON.stringify(dc.body));

    // sync health + Sync now: who may do what (the work itself is covered against the fake Google above)
    check('server: Sync now without a session -> 401, as an assistant -> 403', (await pub('POST', base + '/sync')).status === 401 && (await asAssistant('POST', base + '/sync')).status === 403, '');
    const asstStatus = await asAssistant('GET', base);
    check('server: every role\'s status carries the sync record and the double-entry flags (and still no client ID for an assistant)',
        asstStatus.status === 200 && !!asstStatus.body.sync && 'healthy' in asstStatus.body.sync && 'lastOkAt' in asstStatus.body.sync && typeof asstStatus.body.m365Enabled === 'boolean' && typeof asstStatus.body.doubleEntryRisk === 'boolean' && !('clientId' in asstStatus.body), JSON.stringify(asstStatus.body));

    // the Calendar feed: the Google "synced" marker (and the other three) read columns the feed never selected, so they were always blank
    const feedDay = new Date(Date.now() + 61 * 86400000).toISOString().slice(0, 10);
    const mkBooking = (title, extra) => writeDb(`INSERT INTO bookings (name, email, cell, date, message, status, event_start_time, performance_end_time, event_name, event_type, event_location, city, total_amount, google_event_id, accepted_at, popia_consent, attachment_files) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        ['Feed Client', `feed-${title.replace(/\W/g, '')}@example.invalid`, '+27820000000', feedDay, 'x', 'CONFIRMED', '18:00', '20:00', title, 'Corporate', 'Hall', 'Pretoria', 1000].concat(extra));
    await mkBooking('GFeed Synced', ['gcal-event-secret-id-123', '2026-10-01 10:00:00', 1, '["a.pdf"]']);
    await mkBooking('GFeed Plain', [null, null, 0, null]);
    const feed = await api('GET', '/api/admin/calendar/events');
    const feedItem = (t) => (Array.isArray(feed.body) ? feed.body : []).find((e) => String(e.title).includes(t));
    const fs1 = feedItem('GFeed Synced'), fp1 = feedItem('GFeed Plain');
    check('server: the Calendar feed marks a booking that is on Google (and accepted / POPIA-consented / with attachments)', !!fs1 && fs1.extendedProps.isCalSynced === true && fs1.extendedProps.isAccepted === true && fs1.extendedProps.isPopiaDone === true && fs1.extendedProps.hasAttachments === true, JSON.stringify(fs1 && fs1.extendedProps));
    check('server: ...and leaves a plain booking unmarked', !!fp1 && fp1.extendedProps.isCalSynced === false && fp1.extendedProps.isAccepted === false && fp1.extendedProps.isPopiaDone === false && fp1.extendedProps.hasAttachments === false, JSON.stringify(fp1 && fp1.extendedProps));
    check('server: the feed sends the browser a yes/no only - never the Google event id or the attachment file names', !JSON.stringify(feed.body).includes('gcal-event-secret-id-123') && !JSON.stringify(feed.body).includes('a.pdf'), '');
    // public events carry the same yes/no (the Calendar's Google filter reads it)
    const evDay = feedDay + 'T19:30';
    await writeDb(`INSERT INTO events (event_title, event_datetime, event_status, venue_name, google_calendar_event_id) VALUES ('GFeed Show On', ?, 'upcoming', 'The Lyric', 'gcal-show-secret-id-9'), ('GFeed Show Off', ?, 'upcoming', 'The Lyric', NULL)`, [evDay, evDay]);
    const feed2 = await api('GET', '/api/admin/calendar/events');
    const evOn = (Array.isArray(feed2.body) ? feed2.body : []).find((e) => String(e.title).includes('GFeed Show On'));
    const evOff = (Array.isArray(feed2.body) ? feed2.body : []).find((e) => String(e.title).includes('GFeed Show Off'));
    check('server: public events say whether they are on Google too (and never reveal the Google event id)', !!evOn && !!evOff && evOn.extendedProps.isCalSynced === true && evOff.extendedProps.isCalSynced === false && !JSON.stringify(feed2.body).includes('gcal-show-secret-id-9'), JSON.stringify([evOn && evOn.extendedProps, evOff && evOff.extendedProps]));
    await writeDb("DELETE FROM events WHERE event_title LIKE 'GFeed Show %'");
    await writeDb("DELETE FROM bookings WHERE event_name LIKE 'GFeed %'");

    // leave the throwaway server as it was found
    await writeDb("DELETE FROM settings WHERE LOWER(setting_key) LIKE 'google\\_cal\\_%' ESCAPE '\\'");
    await restart();
};
