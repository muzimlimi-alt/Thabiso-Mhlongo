// Google Calendar connection: where the account's credentials live, how an administrator connects it, and how the connection is checked.
// Until now the only way to give the website a Google account was to edit .env on the server (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET /
// GOOGLE_REFRESH_TOKEN) and run scripts/get-google-refresh-token.js by hand. This is the admin-facing side that was missing - the sync itself is
// unchanged (lib/google-calendar.js holds the one Google client, lib/calendar-sync.js uses it). Setup and troubleshooting: docs-internal/google-calendar.md.
//
// Values live in the `settings` table (Admin -> System -> Integrations -> Google Calendar), under google_cal_*:
//   google_cal_client_id       the OAuth client ID (not secret)
//   google_cal_client_secret   AES-256-GCM encrypted, exactly like the SMTP password (lib/smtp-config.js encryptSecret/decryptSecret)
//   google_cal_refresh_token   AES-256-GCM encrypted; the result of "Connect Google"
//   google_cal_token_client    the client ID that token was issued to (a token only works with the client that issued it)
//   google_cal_account / google_cal_connected_at   what to show (the calendar's owner address, when)
//   google_cal_pending         the one-time state of a connection in progress (hash of the nonce, expiry, who started it, the redirect URI)
//   google_cal_sync_state      how the last Google syncs went (JSON: when, and the last error in plain words) - shown on the admin Calendar; no secrets
// None of them is ever returned by an API, written to a log or copied into process.env (app.js skips the google_cal_ prefix, the generic settings
// route hides it). Precedence: the client ID and secret are a PAIR - saved ones win over GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET, and the refresh token is
// used only with the client it was issued to (saved token first, then GOOGLE_REFRESH_TOKEN) - so credentials for one Google client can never be sent
// to another.
'use strict';
const crypto = require('crypto');
const db = require('../database');
const { upsertSetting } = require('../database/repositories/settings.repository');
const { decodeStoredText } = require('./html-sanitize');
const smtpConfig = require('./smtp-config');   // the one AES-256-GCM scheme every saved secret uses
const gc = () => require('./google-calendar'); // lazy: google-calendar.js reads this module's config, so neither may require the other while loading

const K = {
    clientId: 'google_cal_client_id', secret: 'google_cal_client_secret', token: 'google_cal_refresh_token', tokenClient: 'google_cal_token_client',
    account: 'google_cal_account', connectedAt: 'google_cal_connected_at', pending: 'google_cal_pending', sync: 'google_cal_sync_state'
};
const KEYS = Object.values(K);
const SCOPE = 'https://www.googleapis.com/auth/calendar';
const PENDING_TTL_MS = 10 * 60 * 1000;
const CLIENT_ID_RE = /^\d{6,}-[a-z0-9_-]{8,}\.apps\.googleusercontent\.com$/i;

const has = (v) => v !== undefined && v !== null && String(v).trim() !== '';
const sameId = (a, b) => has(a) && has(b) && String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const coded = (code, message) => Object.assign(new Error(message), { code });

// ── stored values ────────────────────────────────────────────────────────────────────────────────────────────
function readStored() {
    return new Promise((resolve) => {
        db.all(`SELECT setting_key, setting_value FROM settings WHERE setting_key IN (${KEYS.map(() => '?').join(',')})`, KEYS, (err, rows) => {
            const out = {};
            if (!err) (rows || []).forEach(r => { out[r.setting_key] = r.setting_value; });
            resolve(out);
        });
    });
}
const save = (key, value) => new Promise((resolve, reject) => upsertSetting(key, value, (err) => err ? reject(err) : resolve()));
const forget = (keys) => new Promise((resolve, reject) => db.run(`DELETE FROM settings WHERE setting_key IN (${keys.map(() => '?').join(',')})`, keys, (err) => err ? reject(err) : resolve()));

// ── resolution ───────────────────────────────────────────────────────────────────────────────────────────────
// Never throws. state: 'none' (nothing configured) | 'incomplete' (a client but no sign-in yet) | 'connected' (client ID + secret + refresh token).
async function resolveGoogleConfig() {
    const stored = await readStored();
    const env = process.env;
    const problems = [];

    const storedId = has(stored[K.clientId]) ? decodeStoredText(stored[K.clientId]).trim() : null;
    const clientId = storedId || (has(env.GOOGLE_CLIENT_ID) ? String(env.GOOGLE_CLIENT_ID).trim() : null);

    // The secret belongs to the client ID it was created for: a saved client uses its saved secret only, the environment client its environment secret.
    let clientSecret = null, secretSource = null;
    if (storedId) {
        if (has(stored[K.secret])) {
            const plain = smtpConfig.decryptSecret(stored[K.secret]);
            if (plain) { clientSecret = plain; secretSource = 'settings'; }
            else problems.push('The saved Google client secret cannot be decrypted (the server encryption key changed) - enter it again');
        }
    } else if (has(env.GOOGLE_CLIENT_SECRET)) { clientSecret = String(env.GOOGLE_CLIENT_SECRET).trim(); secretSource = 'environment'; }

    // The refresh token is used only with the client that issued it: the saved one first, then GOOGLE_REFRESH_TOKEN.
    let refreshToken = null, tokenSource = null;
    if (has(stored[K.token]) && sameId(stored[K.tokenClient], clientId)) {
        const plain = smtpConfig.decryptSecret(stored[K.token]);
        if (plain) { refreshToken = plain; tokenSource = 'settings'; }
        else problems.push('The saved Google sign-in cannot be decrypted (the server encryption key changed) - connect Google again');
    }
    if (!refreshToken && has(env.GOOGLE_REFRESH_TOKEN) && (!storedId || sameId(env.GOOGLE_CLIENT_ID, storedId))) {
        refreshToken = String(env.GOOGLE_REFRESH_TOKEN).trim(); tokenSource = 'environment';
    }

    const state = clientId && clientSecret && refreshToken ? 'connected' : (clientId || clientSecret || refreshToken ? 'incomplete' : 'none');
    return {
        state, clientId, clientSecret, refreshToken, secretSource, tokenSource, problems,
        idSource: storedId ? 'settings' : (clientId ? 'environment' : null),
        account: tokenSource === 'settings' && has(stored[K.account]) ? decodeStoredText(stored[K.account]) : null,
        connectedAt: tokenSource === 'settings' && has(stored[K.connectedAt]) ? stored[K.connectedAt] : null
    };
}

// What an API may reveal: everything except the client secret and the refresh token themselves.
function publicView(cfg) {
    return {
        state: cfg.state, connected: cfg.state === 'connected', clientId: cfg.clientId || '', secretSet: has(cfg.clientSecret),
        idSource: cfg.idSource || null, secretSource: cfg.secretSource || null, tokenSource: cfg.tokenSource || null,
        account: cfg.account || null, connectedAt: cfg.connectedAt || null, problems: cfg.problems || []
    };
}
const getStatus = async () => publicView(await resolveGoogleConfig());

// ── validation of admin input ────────────────────────────────────────────────────────────────────────────────
// Body text arrives entity-encoded once by deepEscapeBody and is decoded here. Returns the cleaned values plus per-field errors.
function validateCredentials(raw) {
    const errors = {}, clean = {};
    if (raw.clientId !== undefined && raw.clientId !== null && String(raw.clientId) !== '') {
        const id = decodeStoredText(String(raw.clientId)).trim();
        if (!CLIENT_ID_RE.test(id)) errors.clientId = 'That does not look like a Google OAuth client ID. It ends in .apps.googleusercontent.com (Google Cloud > APIs & Services > Credentials > your OAuth client).';
        else clean.clientId = id;
    }
    if (has(raw.clientSecret)) {
        const s = decodeStoredText(String(raw.clientSecret)).trim();
        if (/^[[{]/.test(s) || /client_secret|"web"|"installed"/.test(s)) errors.clientSecret = 'Paste only the client secret value, not the downloaded JSON file.';
        else if (s.length < 8 || s.length > 256 || /[\x00-\x20"'<>\\]/.test(s)) errors.clientSecret = 'The client secret is a single string of letters, digits, - and _ with no spaces or line breaks.';
        else clean.clientSecret = s;
    }
    return { errors, clean };
}

// Saves the OAuth client. Both halves are stored together: a new client ID needs its own secret, and it invalidates the saved sign-in (the old token was
// issued to the old client). Throws a coded error for input the validators cannot judge on their own.
async function saveCredentials(clean) {
    const before = await resolveGoogleConfig();
    const stored = await readStored();
    const savedId = has(stored[K.clientId]) ? decodeStoredText(stored[K.clientId]).trim() : null;
    const prevId = savedId || before.clientId;
    const newId = clean.clientId || prevId;
    if (!newId) throw coded('EINPUT', 'Enter the OAuth client ID.');
    const keepsSecret = !clean.clientSecret && savedId && sameId(savedId, newId) && before.secretSource === 'settings';
    if (!clean.clientSecret && !keepsSecret) throw coded('EINPUT', 'Enter the client secret' + (prevId && !sameId(prevId, newId) ? ' - a different client ID needs its own secret.' : '.'));
    const idChanged = !!prevId && !sameId(newId, prevId);
    if (clean.clientSecret) await save(K.secret, smtpConfig.encryptSecret(clean.clientSecret));   // may throw ENOKEY
    await save(K.clientId, newId);
    if (idChanged) await forget([K.token, K.tokenClient, K.account, K.connectedAt, K.pending]);
    await gc().reloadFromSettings();
    return { idChanged, secretChanged: !!clean.clientSecret };
}

// ── error wording ────────────────────────────────────────────────────────────────────────────────────────────
// Turns whatever googleapis / google-auth-library threw into { code, category, message }. `message` is safe to show an administrator: no credentials, and
// it says what to do. The token endpoint answers { error: 'invalid_grant', error_description }, the Calendar API { error: { code, message, errors: [{ reason }] } }.
function classify(err) {
    const data = err && err.response && err.response.data;
    const status = Number((err && (err.status || (err.response && err.response.status))) || 0) || (data && data.error && data.error.code) || 0;
    const oauth = data && typeof data.error === 'string' ? data.error : '';
    const desc = String((data && (data.error_description || (data.error && data.error.message))) || (err && err.message) || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    const reasons = data && data.error && Array.isArray(data.error.errors) ? data.error.errors.map(e => e.reason) : [];
    const code = err && err.code;
    const out = (category, message, extra) => Object.assign({ code: category, category, message }, extra);

    if (code === 'EREADONLY') return out('permission', err.message);
    if (code === 'ENOKEY') return out('config', err.message);
    if (oauth === 'invalid_grant') return out('auth', 'Google no longer accepts the saved sign-in: it was revoked, or it expired (Google expires them after 7 days while the Google Cloud app is still in "Testing"). Connect Google again - and set the app\'s publishing status to "In production" so it lasts.');
    if (oauth === 'invalid_client' || oauth === 'unauthorized_client') return out('client', 'Google rejected the client ID or client secret. Copy them again from Google Cloud > APIs & Services > Credentials (the secret is shown on the OAuth client\'s page).');
    if (oauth === 'redirect_uri_mismatch' || /redirect_uri_mismatch/i.test(desc)) return out('redirect', 'Google does not know the redirect address shown in the card. Add it under "Authorized redirect URIs" on the OAuth client in Google Cloud, save, wait a minute, then connect again.');
    if (oauth === 'access_denied') return out('denied', 'Access was not granted on the Google screen.');
    if (status === 403 && (reasons.includes('accessNotConfigured') || /has not been used in project|is disabled|SERVICE_DISABLED|accessNotConfigured/i.test(desc))) return out('api', 'The Google Calendar API is switched off for this Google Cloud project. Enable it: Google Cloud > APIs & Services > Library > Google Calendar API > Enable (it can take a few minutes to apply).');
    if (status === 403) return out('permission', 'Google refused the request (403) - the account may not be allowed to use this calendar.' + (desc ? ' Google said: ' + desc : ''));
    if (status === 401) return out('auth', 'Google refused the sign-in (401). Connect Google again.');
    if (status === 404) return out('calendar', 'Google could not find the calendar (404).');
    if (status === 429 || reasons.includes('rateLimitExceeded') || reasons.includes('userRateLimitExceeded')) return out('throttled', 'Google asked us to slow down. Try again in a minute.');
    if (status >= 500) return out('server', 'Google had a temporary problem. Try again in a minute.');
    if (['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH'].includes(code) || /timeout|timed out/i.test(desc)) return out('connection', 'Could not reach Google. Check the server\'s internet access and try again.');
    return out('unknown', 'Google did not accept the request.' + (desc ? ' (' + desc + ')' : ''));
}

// Signs in with `auth` (an OAuth2 client with credentials) and reads the primary calendar: proves the token works AND says who owns the calendar and
// whether this account may change it (the sync adds, changes and removes events).
async function calendarProbe(auth) {
    const r = await gc().newCalendarApi(auth).calendarList.get({ calendarId: 'primary' }, { timeout: 15000 });
    const role = r.data.accessRole;
    if (role !== 'owner' && role !== 'writer') throw coded('EREADONLY', 'This Google account can only read its primary calendar (role: ' + (role || 'unknown') + '). The website needs permission to add and change events.');
    return { account: r.data.id || null, summary: r.data.summary || null };
}

// ── connecting ───────────────────────────────────────────────────────────────────────────────────────────────
// Step 1 (administrator clicks "Connect Google"): remember a one-time state and return the Google consent URL.
async function beginAuthorization({ redirectUri, adminId }) {
    const cfg = await resolveGoogleConfig();
    if (!cfg.clientId || !cfg.clientSecret) throw coded('ENOCREDS', 'Save the Google client ID and client secret first.');
    const nonce = crypto.randomBytes(32).toString('base64url');
    await save(K.pending, JSON.stringify({ h: sha256(nonce), exp: Date.now() + PENDING_TTL_MS, by: adminId || null, ru: redirectUri, cid: cfg.clientId }));
    const url = gc().newOAuthClient(cfg.clientId, cfg.clientSecret, redirectUri).generateAuthUrl({
        access_type: 'offline',   // a refresh token, so the sync keeps working without anyone signed in
        prompt: 'consent',        // force Google to issue one even if this app was authorised before
        scope: [SCOPE],
        state: nonce
    });
    return { url };
}

// Step 2 (Google redirects the browser back): the browser arrives WITHOUT the admin session when the cookie is SameSite=Strict (production), so this
// cannot rely on it. The one-time state - issued only to a signed-in administrator in step 1 - is what authorises it. It is spent on first use, valid for
// ten minutes, and compared in constant time. Verify-before-save: nothing is stored unless Google issued a refresh token AND the calendar can be read and changed.
// Returns { ok, code, account, by } - `code` is one of a fixed vocabulary the landing page and the admin screen turn into words.
async function completeAuthorization({ state, code, error }) {
    const stored = await readStored();
    let pending = null;
    try { pending = JSON.parse(stored[K.pending] || 'null'); } catch (e) { pending = null; }

    const given = has(state) ? Buffer.from(sha256(state)) : null;
    const want = pending && typeof pending.h === 'string' ? Buffer.from(pending.h) : null;
    const matches = !!given && !!want && given.length === want.length && crypto.timingSafeEqual(given, want);
    // A request that does not carry the right state changes nothing - otherwise anyone who can reach this address could cancel an administrator's
    // connection in progress. A matching state is single use: it is spent right here, whatever happens next. A stale one is simply cleared.
    if (!matches) {
        if (pending && !(Date.now() <= pending.exp)) await forget([K.pending]);
        return { ok: false, code: 'state', by: null };
    }
    await forget([K.pending]);
    if (!(Date.now() <= pending.exp)) return { ok: false, code: 'state', by: null };
    const by = pending.by || null;
    if (error) return { ok: false, code: error === 'access_denied' ? 'denied' : 'google', by };
    if (!has(code)) return { ok: false, code: 'google', by };

    const cfg = await resolveGoogleConfig();
    if (!cfg.clientSecret || !sameId(cfg.clientId, pending.cid)) return { ok: false, code: 'state', by };   // the credentials were changed while Google was open

    const client = gc().newOAuthClient(cfg.clientId, cfg.clientSecret, pending.ru);
    let tokens;
    try { tokens = (await client.getToken({ code: String(code), redirect_uri: pending.ru })).tokens; }
    catch (e) { const c = classify(e); return { ok: false, code: c.category === 'unknown' ? 'exchange' : c.category, by }; }
    if (!tokens || !tokens.refresh_token) return { ok: false, code: 'no_refresh_token', by };

    client.setCredentials(tokens);
    let info;
    try { info = await calendarProbe(client); }
    catch (e) { const c = classify(e); return { ok: false, code: c.category === 'unknown' ? 'calendar' : c.category, by }; }

    await save(K.token, smtpConfig.encryptSecret(tokens.refresh_token));
    await save(K.tokenClient, cfg.clientId);
    await save(K.account, info.account || '');
    await save(K.connectedAt, new Date().toISOString());
    await resetSync();
    await gc().reloadFromSettings();
    return { ok: true, code: 'connected', account: info.account, by };
}

// Forgets the saved sign-in (the client ID and secret stay, so reconnecting is one click) and asks Google to revoke it. Revoking is best effort: if the
// token is already dead or Google cannot be reached, forgetting it here is what matters.
async function disconnect() {
    const cfg = await resolveGoogleConfig();
    let revoked = false;
    if (cfg.tokenSource === 'settings' && cfg.refreshToken && cfg.clientId && cfg.clientSecret) {
        try {
            await Promise.race([
                gc().newOAuthClient(cfg.clientId, cfg.clientSecret).revokeToken(cfg.refreshToken),
                new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 8000).unref())
            ]);
            revoked = true;
        } catch (e) { /* already revoked / expired / unreachable */ }
    }
    await forget([K.token, K.tokenClient, K.account, K.connectedAt, K.pending]);
    await resetSync();
    await gc().reloadFromSettings();
    const after = await resolveGoogleConfig();
    return { revoked, stillConnectedViaEnvironment: after.state === 'connected' };
}

// ── sync health ──────────────────────────────────────────────────────────────────────────────────────────────
// The sync itself (lib/calendar-sync.js) used to fail silently into the server log. It now reports each outcome here - separately for the PULL (Google's
// calendar -> date holds, every 15 minutes) and the PUSH (a booking / event -> Google) - so the admin Calendar can say when Google was last reached and, if
// not, why in plain words. The error text is the sanitised one from classify() (no credentials), never the raw error.
const blankKind = () => ({ runAt: null, okAt: null, error: null, category: null, errorAt: null, failures: 0 });
let syncState = null;
async function loadSync() {
    if (syncState) return syncState;
    const stored = await readStored();
    let parsed = {};
    try { parsed = JSON.parse(stored[K.sync] || '{}') || {}; } catch (e) { parsed = {}; }
    syncState = { pull: Object.assign(blankKind(), parsed.pull), push: Object.assign(blankKind(), parsed.push) };
    return syncState;
}
// kind: 'pull' | 'push'; err undefined = it worked. Never throws and never delays a sync; nothing is recorded while no Google account is connected
// (the status then says "not connected", which is the real reason).
async function recordSync(kind, err) {
    try {
        if (kind !== 'pull' && kind !== 'push') return;
        if (!gc().oauth2Client.credentials.refresh_token) return;
        const s = await loadSync();
        const k = s[kind], now = new Date().toISOString();
        k.runAt = now;
        if (!err) { k.okAt = now; k.error = null; k.category = null; k.failures = 0; }
        else { const c = classify(err); k.error = c.message.slice(0, 300); k.category = c.category; k.errorAt = now; k.failures += 1; }
        await save(K.sync, JSON.stringify(s));
    } catch (e) { /* bookkeeping must never affect a sync */ }
}
async function resetSync() {
    syncState = { pull: blankKind(), push: blankKind() };
    try { await forget([K.sync]); } catch (e) { /* ignore */ }
}
const later = (a, b) => (a && (!b || a > b)) ? a : b;
// What the admin screens may see: when Google was last reached, whether the latest attempt of each kind worked, and the most recent problem in words.
async function getSyncStatus() {
    const s = await loadSync();
    const bad = ['pull', 'push'].filter((k) => s[k].failures > 0).sort((a, b) => String(s[b].errorAt).localeCompare(String(s[a].errorAt)))[0];
    return {
        lastRunAt: later(s.pull.runAt, s.push.runAt), lastOkAt: later(s.pull.okAt, s.push.okAt), healthy: !bad,
        lastError: bad ? s[bad].error : null, lastCategory: bad ? s[bad].category : null, errorAt: bad ? s[bad].errorAt : null,
        failures: bad ? s[bad].failures : 0, errorKind: bad || null
    };
}

// "Test connection": checks the SAVED configuration only (no form values, so no secret travels in the request) with a fresh client, so a cached access
// token cannot hide a dead refresh token. A failed check is a normal result (ok:false), not a request error.
async function diagnose() {
    const steps = [];
    const add = (key, label, ok, message) => { steps.push({ key, label, ok, message }); return ok; };
    const finish = () => ({ ok: steps.length > 0 && steps.every(s => s.ok), steps });

    const cfg = await resolveGoogleConfig();
    if (cfg.state !== 'connected') {
        const msg = cfg.state === 'none' ? 'Google Calendar has not been set up yet.' : (cfg.clientId && cfg.clientSecret ? 'Google is not connected yet - press "Connect Google".' : 'The client ID or client secret is missing.');
        add('credentials', 'Credentials saved', false, (cfg.problems[0] || msg));
        return finish();
    }
    add('credentials', 'Credentials saved', true, cfg.tokenSource === 'environment' || cfg.secretSource === 'environment'
        ? 'Using the credentials supplied by the server environment (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN).'
        : 'The client ID, client secret and Google sign-in are saved (encrypted).');

    const auth = gc().newOAuthClient(cfg.clientId, cfg.clientSecret);
    auth.setCredentials({ refresh_token: cfg.refreshToken });
    try { await auth.getAccessToken(); add('signin', 'Sign in to Google', true, 'Google accepted the saved sign-in.'); }
    catch (e) { add('signin', 'Sign in to Google', false, classify(e).message); return finish(); }

    try {
        const info = await calendarProbe(auth);
        add('calendar', 'Read and change the calendar', true, 'Connected to ' + (info.account || 'the primary calendar') + (info.summary && info.summary !== info.account ? ' (' + info.summary + ')' : '') + ' - the website can add and change events on it.');
    } catch (e) { add('calendar', 'Read and change the calendar', false, classify(e).message); }
    return finish();
}

module.exports = {
    KEYS, SCOPE, PENDING_TTL_MS,
    resolveGoogleConfig, publicView, getStatus, validateCredentials, saveCredentials,
    beginAuthorization, completeAuthorization, disconnect, diagnose, classify, recordSync, getSyncStatus, resetSync
};
