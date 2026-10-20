// Run by google-calendar.test.js in its OWN process (it opens the database): the REAL lib/google-config.js, lib/google-calendar.js and routes/admin/google-calendar.js
// (mounted in a tiny Express app with a stand-in session) against a fake Google sign-in + Calendar API (test/fake-google.js) on a throwaway DB.
// Prints one "CHECK:{...}" line per assertion. Nothing reaches Google.
const express = require('express');
const { startFakeGoogle } = require('./fake-google');
const rec = (name, pass, detail) => console.log('CHECK:' + JSON.stringify({ name, pass: !!pass, detail: pass ? '' : String(detail === undefined ? '' : detail).slice(0, 900) }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CID_A = '111111111111-aaaaaaaaaaaaaaaaaaaa' + '.apps.googleusercontent.com', SEC_A = 'GOCSPX' + '-fakeSecretA_VALUE-1234567890';
const CID_B = '222222222222-bbbbbbbbbbbbbbbbbbbb' + '.apps.googleusercontent.com', SEC_B = 'GOCSPX' + '-fakeSecretB_VALUE-0987654321';
const CID_C = '333333333333-cccccccccccccccccccc' + '.apps.googleusercontent.com', SEC_C = 'GOCSPX' + '-fakeSecretC_VALUE-5555555555';
const CB = '/api/admin/google-calendar/callback';
const ENV_KEYS = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN'];

(async () => {
    ENV_KEYS.forEach((k) => delete process.env[k]);
    const g = await startFakeGoogle({ clients: { [CID_A]: SEC_A, [CID_B]: SEC_B, [CID_C]: SEC_C } });
    Object.assign(process.env, g.env);
    const logged = [];   // everything the libraries print, scanned for secrets at the end
    for (const m of ['log', 'warn', 'error']) { const orig = console[m].bind(console); console[m] = (...a) => { logged.push(a.map(String).join(' ')); orig(...a); }; }

    const db = require('../database');
    const cfg = require('../lib/google-config');
    const gc = require('../lib/google-calendar');
    const smtpConfig = require('../lib/smtp-config');
    const router = require('../routes/admin/google-calendar');
    const q = (sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => e ? rej(e) : res(r)));
    const one = async (sql, p = []) => (await q(sql, p))[0];
    const run = (sql, p = []) => new Promise((res, rej) => db.run(sql, p, function (e) { e ? rej(e) : res(this.lastID); }));
    const setting = async (k) => { const r = await one('SELECT setting_value FROM settings WHERE setting_key = ?', [k]); return r ? r.setting_value : undefined; };
    const googleRows = () => q("SELECT setting_key, setting_value FROM settings WHERE setting_key LIKE 'google\\_cal\\_%' ESCAPE '\\'");
    const setEnv = (o) => { ENV_KEYS.forEach((k) => delete process.env[k]); Object.assign(process.env, o || {}); };

    for (let i = 0; i < 80; i++) {
        const t = await q("SELECT name FROM sqlite_master WHERE name IN ('settings','admins','audit_log')").catch(() => []);
        if (t.length === 3) break;
        await sleep(250);
    }
    await sleep(500);
    const adminId = await run(`INSERT INTO admins (username, email, password_hash, role, is_active, must_change_password) VALUES ('g.admin', 'g.admin@test.invalid', 'x', 'administrator', 1, 0)`);

    // ── the routes, in a tiny app. A request carries a stand-in session only when it says which role it has (x-role): Google's redirect carries none. ──
    const seenUrls = [];
    const allBodies = [];
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { res.on('finish', () => seenUrls.push(req.url)); next(); });
    app.use((req, res, next) => { const role = req.headers['x-role']; req.session = role ? { adminId, role } : {}; next(); });
    app.use(router);
    const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const BASE = 'http://127.0.0.1:' + srv.address().port;
    const call = async (method, url, { role, body } = {}) => {
        const r = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', ...(role ? { 'x-role': role } : {}) }, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
        const text = await r.text();
        allBodies.push(text);
        let json = null; try { json = JSON.parse(text); } catch (e) { /* html */ }
        return { status: r.status, json, text, headers: r.headers };
    };
    const asAdmin = (m, u, b) => call(m, u, { role: 'administrator', body: b });
    const landed = (r, outcome) => r.text.includes('/admin.html?google=' + outcome);
    const save = (clientId, clientSecret) => asAdmin('PUT', '/api/admin/google-calendar/credentials', { clientId, clientSecret });

    // One full "Connect Google" round trip; `mutate` lets a scenario change something between the click and Google's answer.
    async function connectFlow({ codeOpts, mutate, state, noCode, error } = {}) {
        const c = await asAdmin('POST', '/api/admin/google-calendar/connect');
        if (!c.json || !c.json.url) return { connect: c };
        const u = new URL(c.json.url);
        const info = { state: u.searchParams.get('state'), ru: u.searchParams.get('redirect_uri'), cid: u.searchParams.get('client_id'), url: u };
        if (mutate) await mutate(info);
        const code = noCode ? '' : g.issueCode(info.cid, info.ru, codeOpts);
        const qs = new URLSearchParams({ state: state !== undefined ? state : info.state });
        if (code) qs.set('code', code);
        if (error) qs.set('error', error);
        const cb = await call('GET', CB + '?' + qs.toString());   // no role: this is Google's redirect, which carries no session
        return { connect: c, info, code, cb };
    }

    // ═════ A. what is configured where ═════
    let s = await cfg.resolveGoogleConfig();
    rec('nothing configured: state "none", not connected', s.state === 'none' && !cfg.publicView(s).connected, JSON.stringify(cfg.publicView(s)));
    setEnv({ GOOGLE_CLIENT_ID: CID_C, GOOGLE_CLIENT_SECRET: SEC_C, GOOGLE_REFRESH_TOKEN: '1//env-token' });
    s = await cfg.resolveGoogleConfig();
    rec('the three .env values still work exactly as before: connected, every part marked "environment"', s.state === 'connected' && s.idSource === 'environment' && s.secretSource === 'environment' && s.tokenSource === 'environment', JSON.stringify(cfg.publicView(s)));
    rec('...and the public view never carries the secret or the token', !JSON.stringify(cfg.publicView(s)).includes(SEC_C) && !JSON.stringify(cfg.publicView(s)).includes('1//env-token'), JSON.stringify(cfg.publicView(s)));
    setEnv({ GOOGLE_CLIENT_ID: CID_C, GOOGLE_REFRESH_TOKEN: '1//env-token' });
    s = await cfg.resolveGoogleConfig();
    rec('a client and a token without the secret is "incomplete", not connected', s.state === 'incomplete' && !cfg.publicView(s).connected, s.state);
    setEnv({});

    // ═════ B. validation of what an administrator types ═════
    const v = (o) => cfg.validateCredentials(o);
    rec('validation: a client ID must end in .apps.googleusercontent.com', !!v({ clientId: 'my-client-id' }).errors.clientId && !!v({ clientId: 'https://accounts.google.com' }).errors.clientId && !v({ clientId: CID_A }).errors.clientId, JSON.stringify(v({ clientId: 'my-client-id' })));
    rec('validation: pasting the downloaded JSON into the secret box is refused with a clear message', /not the downloaded JSON/.test(v({ clientSecret: '{"web":{"client_id":"x","client_secret":"y"}}' }).errors.clientSecret || ''), '');
    rec('validation: a secret with spaces / line breaks / quotes is refused; a normal one passes', !!v({ clientSecret: 'GOCSPX abc def ghi' }).errors.clientSecret && !!v({ clientSecret: 'GOCSPX-abc\ndef12345' }).errors.clientSecret && !!v({ clientSecret: 'short' }).errors.clientSecret && !v({ clientSecret: SEC_A }).errors.clientSecret, '');
    rec('validation: surrounding spaces are trimmed (a pasted value usually has some)', v({ clientId: '  ' + CID_A + ' \n' }).clean.clientId === CID_A && v({ clientSecret: '  ' + SEC_A + '  ' }).clean.clientSecret === SEC_A, JSON.stringify(v({ clientId: '  ' + CID_A + ' \n' })));

    // ═════ C. who may do what ═════
    const base = '/api/admin/google-calendar';
    rec('unauthenticated: status, save, connect, test and disconnect are all refused (401)',
        [(await call('GET', base)).status, (await call('PUT', base + '/credentials', { body: { clientId: CID_A, clientSecret: SEC_A } })).status, (await call('POST', base + '/connect')).status, (await call('POST', base + '/test')).status, (await call('DELETE', base)).status].every((x) => x === 401), '');
    for (const role of ['assistant', 'manager']) {
        const st = await call('GET', base, { role });
        rec(`${role}: may read whether Google is connected, but sees no client ID, redirect address or credential source`, st.status === 200 && st.json.canManage === false && st.json.state === 'none' && !('clientId' in st.json) && !('redirectUri' in st.json) && !('idSource' in st.json), JSON.stringify(st.json));
        const codes = [(await call('PUT', base + '/credentials', { role, body: { clientId: CID_A, clientSecret: SEC_A } })).status, (await call('POST', base + '/connect', { role })).status, (await call('POST', base + '/test', { role })).status, (await call('DELETE', base, { role })).status];
        rec(`${role}: cannot save, connect, test or disconnect (403 each)`, codes.every((x) => x === 403), codes.join(','));
    }
    const adminView = await asAdmin('GET', base);
    rec('administrator: sees canManage, the exact redirect address to register at Google, and no secret', adminView.status === 200 && adminView.json.canManage === true && adminView.json.redirectUri === BASE + CB && adminView.json.state === 'none', JSON.stringify(adminView.json));
    const early = await asAdmin('POST', base + '/connect');
    rec('connecting before the client is saved is refused with "save the client ID and secret first"', early.status === 400 && /Save the Google client ID/.test(early.json.message), JSON.stringify(early.json));

    // ═════ D. saving the OAuth client ═════
    const badId = await save('not-a-client-id', SEC_A);
    rec('save: a malformed client ID -> 400 naming the field; nothing stored', badId.status === 400 && !!badId.json.errors.clientId && (await googleRows()).length === 0, JSON.stringify(badId.json));
    const jsonSecret = await save(CID_A, '{"web":{"client_secret":"abc"}}');
    rec('save: the downloaded JSON pasted as the secret -> 400; nothing stored', jsonSecret.status === 400 && !!jsonSecret.json.errors.clientSecret && (await googleRows()).length === 0, JSON.stringify(jsonSecret.json));
    const noSecret = await save(CID_A, '');
    rec('save: a new client ID with no secret -> 400 "enter the client secret"', noSecret.status === 400 && /client secret/i.test(noSecret.json.message), JSON.stringify(noSecret.json));
    const saved = await save(CID_A, SEC_A);
    rec('save: a valid client -> 200, state "incomplete" (a client but no Google sign-in yet), secretSet true, client ID echoed',
        saved.status === 200 && saved.json.state === 'incomplete' && saved.json.secretSet === true && saved.json.clientId === CID_A && saved.json.connected === false, JSON.stringify(saved.json));
    rec('...and the response carries no secret', !saved.text.includes(SEC_A), saved.text);
    const secretRow = await setting('google_cal_client_secret');
    rec('...the secret is stored ENCRYPTED (enc:v1:), not as text, and decrypts back to what was typed', typeof secretRow === 'string' && secretRow.startsWith('enc:v1:') && !secretRow.includes(SEC_A) && smtpConfig.decryptSecret(secretRow) === SEC_A, secretRow);
    const keep = await save(CID_A, '');
    rec('save: the same client ID with the secret left blank keeps the saved secret', keep.status === 200 && keep.json.secretSet === true && (await setting('google_cal_client_secret')) === secretRow, JSON.stringify(keep.json));
    const swapNoSecret = await save(CID_B, '');
    rec('save: a DIFFERENT client ID with no secret is refused (it needs its own); the saved client is untouched', swapNoSecret.status === 400 && /own secret/.test(swapNoSecret.json.message) && (await setting('google_cal_client_id')) === CID_A, JSON.stringify(swapNoSecret.json));
    const audit1 = await one("SELECT * FROM audit_log WHERE table_name = 'settings' AND new_values LIKE '%google_calendar%' ORDER BY id DESC");
    rec('save: written to the audit trail, with no secret in it', !!audit1 && !JSON.stringify(audit1).includes(SEC_A), JSON.stringify(audit1));

    // ═════ E. connecting Google ═════
    const first = await connectFlow({ state: 'not-the-state' });
    const authUrl = first.info.url;
    rec('connect: the Google address asks for offline access with a consent prompt, the calendar scope, THIS client and the redirect address shown to the administrator',
        authUrl.origin + authUrl.pathname === g.origin + '/auth' && authUrl.searchParams.get('access_type') === 'offline' && authUrl.searchParams.get('prompt') === 'consent'
        && authUrl.searchParams.get('scope') === 'https://www.googleapis.com/auth/calendar' && authUrl.searchParams.get('client_id') === CID_A && authUrl.searchParams.get('redirect_uri') === BASE + CB && authUrl.searchParams.get('response_type') === 'code', authUrl.toString());
    rec('...and the address carries no secret', !authUrl.toString().includes(SEC_A), authUrl.toString());
    const pend = JSON.parse(await setting('google_cal_pending'));
    rec('connect: only a HASH of the one-time state is stored, with an expiry about ten minutes away, who started it and the redirect address',
        pend.h && pend.h !== first.info.state && !JSON.stringify(pend).includes(first.info.state) && pend.by === adminId && pend.ru === BASE + CB && pend.exp > Date.now() + 8 * 60000 && pend.exp < Date.now() + 11 * 60000, JSON.stringify(pend));
    rec('callback with a wrong state: refused (400) with a page that sends the administrator back to the admin, nothing stored', first.cb.status === 400 && landed(first.cb, 'state') && /was not connected/.test(first.cb.text) && !(await setting('google_cal_refresh_token')), first.cb.text.slice(0, 300));
    rec('...and a wrong state does NOT cancel the connection in progress (a stranger cannot spoil it)', !!(await setting('google_cal_pending')), '');
    const arr = await call('GET', CB + '?state[]=a&state[]=b&code[x]=1');
    rec('callback with array / object parameters: handled as a plain refusal, no crash', arr.status === 400 && landed(arr, 'state'), arr.text.slice(0, 200));

    const denied = await connectFlow({ noCode: true, error: 'access_denied' });
    rec('callback after the administrator pressed "Cancel" at Google: refused (400, "denied"), nothing stored, the state is spent', denied.cb.status === 400 && landed(denied.cb, 'denied') && !(await setting('google_cal_refresh_token')) && !(await setting('google_cal_pending')), denied.cb.text.slice(0, 200));

    const noRt = await connectFlow({ codeOpts: { refresh: false } });
    rec('Google issued no refresh token: refused ("no_refresh_token"), nothing stored', noRt.cb.status === 400 && landed(noRt.cb, 'no_refresh_token') && !(await setting('google_cal_refresh_token')), noRt.cb.text.slice(0, 200));

    g.behaviour.accessRole = 'reader';
    const reader = await connectFlow();
    rec('an account that can only READ its calendar is refused ("permission"): the sync must be able to write; nothing stored', reader.cb.status === 400 && landed(reader.cb, 'permission') && !(await setting('google_cal_refresh_token')), reader.cb.text.slice(0, 200));
    g.behaviour.accessRole = 'owner';

    g.behaviour.apiDisabled = true;
    const noApi = await connectFlow();
    rec('the Calendar API switched off in Google Cloud: refused ("api"), nothing stored', noApi.cb.status === 400 && landed(noApi.cb, 'api') && !(await setting('google_cal_refresh_token')), noApi.cb.text.slice(0, 200));
    g.behaviour.apiDisabled = false;

    const mism = await connectFlow({ mutate: async (i) => { i.ru = i.ru + '/other'; } });
    rec('Google reporting a redirect address mismatch: refused ("redirect"), nothing stored', mism.cb.status === 400 && landed(mism.cb, 'redirect') && !(await setting('google_cal_refresh_token')), mism.cb.text.slice(0, 200));

    g.behaviour.tokenFailure = { status: 401, error: 'invalid_client', description: 'Unauthorized' };
    const badClient = await connectFlow();
    rec('Google rejecting the client ID / secret at the exchange: refused ("client"), nothing stored', badClient.cb.status === 400 && landed(badClient.cb, 'client') && !(await setting('google_cal_refresh_token')), badClient.cb.text.slice(0, 200));
    g.behaviour.tokenFailure = null;

    const stale = await connectFlow({ mutate: async () => { const p = JSON.parse(await setting('google_cal_pending')); p.exp = Date.now() - 1000; await run("UPDATE settings SET setting_value = ? WHERE setting_key = 'google_cal_pending'", [JSON.stringify(p)]); } });
    rec('a state older than ten minutes is refused ("state") and cleared', stale.cb.status === 400 && landed(stale.cb, 'state') && !(await setting('google_cal_refresh_token')) && !(await setting('google_cal_pending')), stale.cb.text.slice(0, 200));

    const swapped = await connectFlow({ mutate: async () => { await save(CID_B, SEC_B); } });
    rec('changing the client while Google is open invalidates the connection in progress ("state"); nothing is stored for the wrong client', swapped.cb.status === 400 && landed(swapped.cb, 'state') && !(await setting('google_cal_refresh_token')), swapped.cb.text.slice(0, 200));
    await save(CID_A, SEC_A);   // back to client A (a client change needs its secret too)

    // the real thing
    seenUrls.length = 0;
    const ok = await connectFlow();
    rec('connect: with the right state, no session cookie and a valid code -> 200 "Google Calendar connected" page that returns to the admin', ok.cb.status === 200 && landed(ok.cb, 'connected') && /Google Calendar connected/.test(ok.cb.text), ok.cb.text.slice(0, 300));
    rec('...the page is no-store / no-referrer and repeats nothing Google sent (not the code, not the state)', ok.cb.headers.get('cache-control') === 'no-store' && ok.cb.headers.get('referrer-policy') === 'no-referrer' && !ok.cb.text.includes(ok.code) && !ok.cb.text.includes(ok.info.state), JSON.stringify([...ok.cb.headers]));
    const cbReq = seenUrls.find((u) => u.startsWith(CB));
    rec('...the request log sees the path only - Google\'s one-time code and the state are not in it', !!cbReq && !/code=|state=/.test(cbReq) && !seenUrls.some((u) => /code=|state=/.test(u)), JSON.stringify(seenUrls));
    s = await cfg.resolveGoogleConfig();
    rec('...now connected: the account (calendar owner) is recorded, the sign-in comes from the saved settings', s.state === 'connected' && s.tokenSource === 'settings' && s.account === 'owner@example.test' && !!s.connectedAt, JSON.stringify(cfg.publicView(s)));
    const tokRow = await setting('google_cal_refresh_token');
    const issued = [...g.refreshTokens.keys()].pop();
    rec('...the refresh token is stored ENCRYPTED and tied to the client that issued it', tokRow.startsWith('enc:v1:') && !tokRow.includes(issued) && smtpConfig.decryptSecret(tokRow) === issued && (await setting('google_cal_token_client')) === CID_A, tokRow);
    const exch = g.tokenLog.filter((t) => t.grant_type === 'authorization_code').pop();
    rec('...Google was asked to exchange the code with this client, its secret and the same redirect address', exch.client_id === CID_A && exch.client_secret === SEC_A && exch.redirect_uri === BASE + CB, JSON.stringify(exch));
    rec('...the one shared Google client was re-pointed IN PLACE: same object, new client and refresh token (no restart needed)', gc.oauth2Client._clientId === CID_A && gc.oauth2Client._clientSecret === SEC_A && gc.oauth2Client.credentials.refresh_token === issued, JSON.stringify({ id: gc.oauth2Client._clientId, rt: gc.oauth2Client.credentials.refresh_token }));
    g.apiLog.length = 0;
    const ins = await gc.calendar.events.insert({ calendarId: gc.CALENDAR_ID, requestBody: { summary: 'Sync check' } });
    rec('...and the existing sync code path (calendar.events.insert) now works with it: Google saw an access token made from THAT refresh token', ins.status === 200 && g.apiLog.length === 1 && g.apiLog[0].refreshToken === issued && g.tokenLog.some((t) => t.grant_type === 'refresh_token' && t.refresh_token === issued && t.client_id === CID_A), JSON.stringify(g.apiLog));
    const grants = () => g.tokenLog.filter((t) => t.grant_type === 'authorization_code').length;
    const grantsBefore = grants();
    const replay = await call('GET', CB + '?' + new URLSearchParams({ state: ok.info.state, code: g.issueCode(CID_A, ok.info.ru) }).toString());
    rec('replaying the same state is refused (it is single use) and does not call Google again', replay.status === 400 && landed(replay, 'state') && grants() === grantsBefore, replay.text.slice(0, 200));
    const auditConn = await one("SELECT * FROM audit_log WHERE reason LIKE 'Google Calendar connected%' ORDER BY id DESC");
    rec('connecting is in the audit trail with who started it (and no token)', !!auditConn && /administrator #/.test(auditConn.reason) && !JSON.stringify(auditConn).includes(issued), JSON.stringify(auditConn));
    const viewNow = await asAdmin('GET', base);
    rec('status now says connected, with the account and where the sign-in comes from', viewNow.json.connected === true && viewNow.json.account === 'owner@example.test' && viewNow.json.tokenSource === 'settings' && viewNow.json.secretSet === true, JSON.stringify(viewNow.json));
    const viewAssistant = await call('GET', base, { role: 'assistant' });
    rec('...and an assistant sees "connected" and the account, nothing more', viewAssistant.json.connected === true && viewAssistant.json.account === 'owner@example.test' && !('clientId' in viewAssistant.json), JSON.stringify(viewAssistant.json));

    // ═════ F. Test connection ═════
    const t1 = await asAdmin('POST', base + '/test');
    rec('test connection: three green steps (credentials, sign-in, calendar) naming the account', t1.json.ok === true && t1.json.steps.length === 3 && t1.json.steps.every((x) => x.ok) && /owner@example\.test/.test(t1.json.steps[2].message), JSON.stringify(t1.json));
    const refreshesBefore = g.tokenLog.filter((t) => t.grant_type === 'refresh_token').length;
    await asAdmin('POST', base + '/test');
    rec('...every test signs in afresh (a cached access token cannot hide a dead refresh token)', g.tokenLog.filter((t) => t.grant_type === 'refresh_token').length === refreshesBefore + 1, '');

    g.revoke(issued);
    const t2 = await asAdmin('POST', base + '/test');
    rec('after the user revokes access at Google: the test fails at the sign-in step and says to connect again (mentioning the 7-day "Testing" expiry); no calendar step is attempted',
        t2.json.ok === false && t2.json.steps.length === 2 && t2.json.steps[1].key === 'signin' && !t2.json.steps[1].ok && /Connect Google again/.test(t2.json.steps[1].message) && /Testing/.test(t2.json.steps[1].message), JSON.stringify(t2.json));
    rec('...and the status screen still works (it reports what is saved, the test reports whether it works)', (await asAdmin('GET', base)).json.connected === true, '');

    const re1 = await connectFlow();
    const issued2 = [...g.refreshTokens.keys()].pop();
    rec('reconnecting after that works and replaces the dead sign-in', re1.cb.status === 200 && smtpConfig.decryptSecret(await setting('google_cal_refresh_token')) === issued2 && issued2 !== issued, re1.cb.text.slice(0, 200));

    g.behaviour.apiDisabled = true;
    const t3 = await asAdmin('POST', base + '/test');
    rec('test with the Calendar API switched off: sign-in passes, the calendar step fails and says how to enable the API', t3.json.ok === false && t3.json.steps[1].ok && !t3.json.steps[2].ok && /Google Calendar API is switched off/.test(t3.json.steps[2].message), JSON.stringify(t3.json));
    g.behaviour.apiDisabled = false;
    g.behaviour.accessRole = 'reader';
    const t4 = await asAdmin('POST', base + '/test');
    rec('test with an account that can only read: the calendar step fails and says so', t4.json.ok === false && !t4.json.steps[2].ok && /can only read/.test(t4.json.steps[2].message), JSON.stringify(t4.json));
    g.behaviour.accessRole = 'owner';
    g.behaviour.tokenFailure = { status: 401, error: 'invalid_client', description: 'Unauthorized' };
    const t5 = await asAdmin('POST', base + '/test');
    rec('test when Google rejects the client: sign-in step fails and points at the client ID / secret', t5.json.ok === false && /client ID or client secret/.test(t5.json.steps[1].message), JSON.stringify(t5.json));
    g.behaviour.tokenFailure = null;

    // ═════ changing the client while connected ═════
    const swap = await save(CID_B, SEC_B);
    rec('switching to a different client clears the saved Google sign-in (it was issued to the old client), says so, and the shared client stops using it',
        swap.status === 200 && swap.json.signInCleared === true && swap.json.state === 'incomplete' && !(await setting('google_cal_refresh_token')) && !(await setting('google_cal_account'))
        && !gc.oauth2Client.credentials.refresh_token && gc.oauth2Client._clientId === CID_B, JSON.stringify(swap.json));
    const back = await save(CID_A, SEC_A);
    rec('...and switching back to the first client does not bring the old sign-in back', back.json.state === 'incomplete' && back.json.connected === false, JSON.stringify(back.json));
    const re4 = await connectFlow();
    rec('...connecting again gives a working connection', re4.cb.status === 200 && (await asAdmin('GET', base)).json.connected === true, re4.cb.text.slice(0, 200));

    // ═════ G. disconnect ═════
    g.behaviour.revokeStatus = 500;
    const dc1 = await asAdmin('DELETE', base);
    rec('disconnect when Google cannot revoke: the saved sign-in is still forgotten here (revoked:false)', dc1.status === 200 && dc1.json.revoked === false && dc1.json.state === 'incomplete' && !(await setting('google_cal_refresh_token')) && !(await setting('google_cal_account')), JSON.stringify(dc1.json));
    g.behaviour.revokeStatus = 200;
    const re2 = await connectFlow();
    const issued3 = [...g.refreshTokens.keys()].pop();
    g.revokeLog.length = 0;
    const dc2 = await asAdmin('DELETE', base);
    rec('disconnect: Google is asked to revoke exactly that token, it is forgotten, the client ID and secret STAY (reconnecting is one click)',
        re2.cb.status === 200 && dc2.json.revoked === true && g.revokeLog.length === 1 && g.revokeLog[0].token === issued3 && dc2.json.state === 'incomplete' && dc2.json.secretSet === true && dc2.json.clientId === CID_A, JSON.stringify({ dc: dc2.json, rv: g.revokeLog }));
    rec('...and the one shared Google client no longer holds a refresh token (the sync stops using the account at once)', !gc.oauth2Client.credentials.refresh_token && gc.oauth2Client._clientId === CID_A, JSON.stringify(gc.oauth2Client.credentials));
    const afterDc = await gc.calendar.events.insert({ calendarId: gc.CALENDAR_ID, requestBody: { summary: 'x' } }).then(() => 'sent', (e) => 'refused');
    rec('...a sync attempt now fails locally instead of acting as the old account', afterDc === 'refused', afterDc);
    const auditDc = await one("SELECT * FROM audit_log WHERE reason = 'Google Calendar disconnected' ORDER BY id DESC");
    rec('disconnecting is in the audit trail (no token)', !!auditDc && !JSON.stringify(auditDc).includes(issued3), JSON.stringify(auditDc));

    // ═════ H. precedence between saved values and the server environment ═════
    g.refreshTokens.set('1//env-token-for-A', CID_A);
    setEnv({ GOOGLE_CLIENT_ID: CID_A, GOOGLE_CLIENT_SECRET: SEC_A, GOOGLE_REFRESH_TOKEN: '1//env-token-for-A' });
    s = await cfg.resolveGoogleConfig();
    rec('a saved client with NO saved sign-in falls back to the environment token when the environment is the SAME client', s.state === 'connected' && s.tokenSource === 'environment' && s.idSource === 'settings' && s.secretSource === 'settings', JSON.stringify(cfg.publicView(s)));
    const re3 = await connectFlow();
    s = await cfg.resolveGoogleConfig();
    rec('...and a connection made from the screen wins over the environment token', re3.cb.status === 200 && s.tokenSource === 'settings', JSON.stringify(cfg.publicView(s)));
    const dc3 = await asAdmin('DELETE', base);
    rec('disconnecting while the environment still holds a sign-in for that client says so (stillConnectedViaEnvironment)', dc3.json.stillConnectedViaEnvironment === true && dc3.json.connected === true && dc3.json.tokenSource === 'environment', JSON.stringify(dc3.json));
    setEnv({ GOOGLE_CLIENT_ID: CID_C, GOOGLE_CLIENT_SECRET: SEC_C, GOOGLE_REFRESH_TOKEN: '1//env-token' });
    s = await cfg.resolveGoogleConfig();
    rec('a saved client DIFFERENT from the environment one never borrows the environment secret or token (credentials of one client are never sent to another)',
        s.clientId === CID_A && s.clientSecret === SEC_A && s.tokenSource === null && s.refreshToken === null && s.state === 'incomplete', JSON.stringify(cfg.publicView(s)));
    setEnv({});

    // connect with ONLY the environment client (nothing saved): "Connect" works and the result is saved against that client
    await run("DELETE FROM settings WHERE setting_key LIKE 'google\\_cal\\_%' ESCAPE '\\'");
    await gc.reloadFromSettings();
    setEnv({ GOOGLE_CLIENT_ID: CID_C, GOOGLE_CLIENT_SECRET: SEC_C });
    const envOnly = await connectFlow();
    s = await cfg.resolveGoogleConfig();
    rec('a client supplied only by the server environment can be connected from the screen without retyping it; the sign-in is saved and tied to that client',
        envOnly.cb.status === 200 && s.state === 'connected' && s.idSource === 'environment' && s.secretSource === 'environment' && s.tokenSource === 'settings' && (await setting('google_cal_token_client')) === CID_C && !(await setting('google_cal_client_id')), JSON.stringify(cfg.publicView(s)));
    setEnv({});
    s = await cfg.resolveGoogleConfig();
    rec('...and the saved sign-in is ignored (not mis-used) once the environment client it belongs to is gone', s.state === 'none' && s.tokenSource === null, JSON.stringify(cfg.publicView(s)));
    await run("DELETE FROM settings WHERE setting_key LIKE 'google\\_cal\\_%' ESCAPE '\\'");

    // an encryption key that changed: reported, never guessed
    await save(CID_A, SEC_A);
    const goodKey = process.env.SETTINGS_ENCRYPTION_KEY;
    process.env.SETTINGS_ENCRYPTION_KEY = 'a-different-key';
    s = await cfg.resolveGoogleConfig();
    rec('a saved secret that cannot be decrypted (server key changed) is reported and NOT used; the card tells the administrator to enter it again',
        s.clientSecret === null && s.state === 'incomplete' && s.problems.some((p) => /cannot be decrypted/.test(p)) && cfg.publicView(s).secretSet === false, JSON.stringify(cfg.publicView(s)));
    const dt = await cfg.diagnose();
    rec('...and Test connection says the same instead of failing mysteriously', dt.ok === false && /cannot be decrypted/.test(dt.steps[0].message), JSON.stringify(dt));
    process.env.SETTINGS_ENCRYPTION_KEY = goodKey;
    s = await cfg.resolveGoogleConfig();
    rec('...with the right key again everything is back', s.clientSecret === SEC_A && s.problems.length === 0, JSON.stringify(cfg.publicView(s)));

    // ═════ I. nothing sensitive anywhere ═════
    const secrets = [SEC_A, SEC_B, SEC_C, ...Array.from(g.refreshTokens.keys()).filter((k) => k.startsWith('1//rt-')), ...Array.from(g.accessTokens.keys())];
    const auditAll = JSON.stringify(await q('SELECT * FROM audit_log'));
    const dumpBodies = allBodies.join('\n');
    const dumpLogs = logged.join('\n');
    const leak = (hay) => secrets.find((x) => hay.includes(x));
    rec('no client secret, refresh token or access token appears in ANY response the routes sent', !leak(dumpBodies), leak(dumpBodies));
    rec('...nor in the audit trail', !leak(auditAll), leak(auditAll));
    rec('...nor in anything the server printed', !leak(dumpLogs), leak(dumpLogs));
    const rowsDump = JSON.stringify(await googleRows());
    rec('...and nor in the settings rows (everything secret is encrypted there)', !leak(rowsDump), leak(rowsDump));
    rec('no one-time state value is stored anywhere (only its hash was)', !(await googleRows()).some((r) => [first, denied, noRt, ok].some((f) => f.info && r.setting_value.includes(f.info.state))), '');

    srv.close();
    await g.close();
    process.exit(0);
})().catch((e) => { console.log('CHECK:' + JSON.stringify({ name: 'child crashed', pass: false, detail: String(e && e.stack || e).slice(0, 1500) })); process.exit(1); });
