// Administrator controls for the Google Calendar connection (lib/google-config.js). Mounted by routes/admin/calendar.js. Setup, the redirect address and
// troubleshooting: docs-internal/google-calendar.md.
//   read (any signed-in admin role)   whether Google is connected, to which account, how the last syncs went, and whether Microsoft 365 sharing is also on
//   administrator or manager          Sync now (read Google's calendar into the website immediately)
//   administrator                     see/save the OAuth client, connect, test, disconnect
//   callback (NO session needed)      where Google sends the browser back - see the note on it below
const express = require('express');
const { requireAdmin } = require('../../middleware/auth');
const { requireRole } = require('../../middleware/rbac');
const { adminRateLimiter } = require('../../middleware/rate-limiters');
const { logAudit } = require('../../lib/audit-log');
const db = require('../../database');
const google = require('../../lib/google-config');
const router = express.Router();
const adminOnly = [requireAdmin, requireRole(['administrator'])];
const managerUp = [requireAdmin, requireRole(['administrator', 'manager'])];
const CALLBACK_PATH = '/api/admin/google-calendar/callback';
const fail = (res, e, what) => {
    console.error('google-calendar ' + what + ' failed:', e && e.message);
    res.status(500).json({ success: false, message: e && e.code === 'ENOKEY' ? e.message : 'The Google Calendar request could not be completed.' });
};
const audit = (req, action, oldValues, newValues, reason) =>
    logAudit({ tableName: 'settings', recordId: 0, action, req, oldValues: { google_calendar: oldValues }, newValues: { google_calendar: newValues }, reason })
        .catch((e) => console.error('logAudit failed:', e.message));

// The address Google must be told it may send the browser back to (Google Cloud > the OAuth client > Authorized redirect URIs). On a local machine that is
// the address in the browser's bar; on the live site it is BASE_URL when set (the public address), otherwise the address the request came in on.
function redirectUriFor(req) {
    const origin = req.protocol + '://' + req.get('host');
    const local = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(origin);
    const base = String(process.env.BASE_URL || '').trim().replace(/\/+$/, '');
    return (local || !/^https?:\/\/[^/]+$/i.test(base) ? origin : base) + CALLBACK_PATH;
}

// How the last syncs went, and whether the Microsoft 365 calendar is ALSO switched on (then a confirmed booking can be on two calendars - the screens warn about it).
// Safe for every signed-in role: plain-language text, no credentials.
async function syncExtras(view) {
    const sync = await google.getSyncStatus();
    const m365Enabled = await new Promise((resolve) => db.get('SELECT enabled FROM calendar_sync_state WHERE id = 1', [], (err, row) => resolve(!err && !!row && Number(row.enabled) === 1)));
    return { sync, m365Enabled, doubleEntryRisk: !!view.connected && m365Enabled };
}

router.get('/api/admin/google-calendar', requireAdmin, async (req, res) => {
    try {
        const view = await google.getStatus();
        const extras = await syncExtras(view);
        if ((req.session.role || 'assistant') !== 'administrator') {
            // Everyone signed in may see whether the calendar is connected; the client ID and where the credentials come from are for administrators.
            return res.json({ success: true, canManage: false, state: view.state, connected: view.connected, account: view.account, ...extras });
        }
        res.json({ success: true, canManage: true, redirectUri: redirectUriFor(req), ...view, ...extras });
    } catch (e) { fail(res, e, 'status'); }
});

// "Sync now": read Google's calendar into the website immediately (the same pull that runs every 15 minutes: appointments there block those times here, entries
// that were removed there are removed here). Administrators and managers; one at a time.
let syncing = false;
router.post('/api/admin/google-calendar/sync', ...managerUp, async (req, res) => {
    try {
        const view = await google.getStatus();
        if (!view.connected) return res.status(409).json({ success: false, message: 'Google Calendar is not connected.' });
        if (syncing) return res.status(409).json({ success: false, message: 'A Google Calendar sync is already running. Try again in a moment.' });
        syncing = true;
        let result;
        try { result = await require('../../lib/calendar-sync').syncCalendarHolds(); }
        finally { syncing = false; }
        const sync = await google.getSyncStatus();
        res.json({ success: true, ok: !!(result && result.ok), sync, message: result && result.ok ? 'Google Calendar was read just now.' : (sync.lastError || 'Google Calendar could not be read.') });
    } catch (e) { syncing = false; fail(res, e, 'sync'); }
});

// Save the OAuth client (client ID + client secret). The secret is stored encrypted and never returned; leaving it blank keeps the saved one.
router.put('/api/admin/google-calendar/credentials', ...adminOnly, async (req, res) => {
    try {
        const b = req.body || {};
        const v = google.validateCredentials({ clientId: b.clientId, clientSecret: b.clientSecret });
        if (Object.keys(v.errors).length) return res.status(400).json({ success: false, message: 'Google settings not saved: ' + Object.values(v.errors).join(' '), errors: v.errors });
        const before = await google.getStatus();
        let result;
        try { result = await google.saveCredentials(v.clean); }
        catch (e) {
            if (e.code === 'EINPUT') return res.status(400).json({ success: false, message: 'Google settings not saved: ' + e.message });
            throw e;
        }
        const after = await google.getStatus();
        audit(req, 'update', before, Object.assign({}, after, { clientSecretChanged: result.secretChanged, signInCleared: result.idChanged }));
        res.json({ success: true, ...after, canManage: true, redirectUri: redirectUriFor(req), signInCleared: result.idChanged });
    } catch (e) { fail(res, e, 'save'); }
});

// "Connect Google": returns the Google consent address; the browser goes there and Google sends it back to the callback below.
router.post('/api/admin/google-calendar/connect', ...adminOnly, async (req, res) => {
    try {
        const { url } = await google.beginAuthorization({ redirectUri: redirectUriFor(req), adminId: req.session.adminId });
        res.json({ success: true, url });
    } catch (e) {
        if (e.code === 'ENOCREDS') return res.status(400).json({ success: false, message: e.message });
        fail(res, e, 'connect');
    }
});

// Where Google sends the browser back. In production the session cookie is SameSite=Strict, which the browser does not send on a navigation that came from
// another site - so this arrives with NO session, and that is fine: the one-time `state` that "Connect Google" issued to a signed-in administrator is what
// authorises it (see completeAuthorization). For the same reason it answers with a small page that moves on by itself (a navigation started by our own page
// carries the cookie again) instead of a redirect (which would still count as coming from Google). The page never repeats anything Google sent: the outcome is
// one word from a fixed list and the admin screen turns it into a sentence.
const OUTCOMES = new Set(['connected', 'state', 'denied', 'google', 'exchange', 'no_refresh_token', 'client', 'redirect', 'api', 'permission', 'calendar', 'auth', 'connection', 'throttled', 'server', 'internal']);
const landingPage = (outcome) => {
    const ok = outcome === 'connected';
    const target = '/admin.html?google=' + outcome;
    return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">'
        + '<title>Google Calendar</title><meta http-equiv="refresh" content="1;url=' + target + '">'
        + '<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#111;color:#eee;font:16px/1.5 system-ui,sans-serif}main{max-width:28rem;padding:2rem;text-align:center}a{color:#e0b44c}</style>'
        + '</head><body><main><h1>' + (ok ? 'Google Calendar connected' : 'Google Calendar was not connected') + '</h1><p>Taking you back to the admin&hellip;</p>'
        + '<p><a href="' + target + '">Continue</a></p></main></body></html>';
};
router.get(CALLBACK_PATH, adminRateLimiter, async (req, res) => {
    const text = (v) => (typeof v === 'string' ? v : '');
    const { state, code, error } = req.query || {};
    req.url = req.path;   // drop the query now it is read: the request logger in app.js would otherwise print Google's one-time code and the state
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    let result;
    try { result = await google.completeAuthorization({ state: text(state), code: text(code), error: text(error) }); }
    catch (e) { console.error('google-calendar callback failed:', e && e.message); result = { ok: false, code: 'internal', by: null }; }
    const outcome = OUTCOMES.has(result.code) ? result.code : 'google';
    if (result.ok) audit(req, 'update', { connected: false }, { connected: true, account: result.account }, 'Google Calendar connected' + (result.by ? ' by administrator #' + result.by : ''));
    res.status(result.ok ? 200 : 400).type('html').send(landingPage(outcome));
});

// "Test connection": checks the SAVED settings only (see diagnose). A failed check is a normal result (HTTP 200, ok:false).
router.post('/api/admin/google-calendar/test', ...adminOnly, async (req, res) => {
    try { res.json({ success: true, ...(await google.diagnose()) }); } catch (e) { fail(res, e, 'test'); }
});

// "Disconnect": forget the saved Google sign-in (and ask Google to revoke it). The client ID and secret stay so reconnecting is one click.
router.delete('/api/admin/google-calendar', ...adminOnly, async (req, res) => {
    try {
        const before = await google.getStatus();
        const result = await google.disconnect();
        const after = await google.getStatus();
        audit(req, 'update', before, Object.assign({}, after, { revoked: result.revoked }), 'Google Calendar disconnected');
        res.json({ success: true, ...result, ...after, canManage: true, redirectUri: redirectUriFor(req) });
    } catch (e) { fail(res, e, 'disconnect'); }
});

module.exports = router;
