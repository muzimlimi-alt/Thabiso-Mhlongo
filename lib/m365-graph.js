// Microsoft Graph client for the ONE shared mailbox (bookings@...). It is the READ side of the Contact / Inquiries integration
// (lib/inbox-sync.js) and the transport of the Admin Calendar integration (lib/calendar-m365.js, which also writes events);
// outgoing mail stays on the SMTP + OAuth transport in js/emailService.js.
//
// Why this module is deliberately small and strict:
//   - one app registration, one secret: it signs in with the OAuth credentials already saved in Admin -> System -> Email Setup ->
//     Email (SMTP) (tenant, application ID, client secret) and only asks for a different token audience (GRAPH_SCOPE);
//   - it can only ever address /users/<the configured mailbox>/... : callers pass a path RELATIVE to that mailbox, and absolute
//     nextLink / deltaLink URLs (which are stored in the database) are refused unless they point at the same mailbox on Graph;
//   - what it may do is decided by Exchange, not by this file: "Application Mail.Read" for the inbox sync, "Application Calendars.ReadWrite" for the
//     calendar sync (RBAC for Applications, scoped to the mailbox). Only GET / POST / PATCH / DELETE are ever sent, and only to that mailbox;
//   - it never throws for an expected failure: every call resolves { ok:true, ... } or { ok:false, category, message, ... } where
//     `message` is safe to log and to show an administrator (no secret, no token, no mailbox content);
//   - it retries only what is safe to retry (429 / 5xx / network), honouring Retry-After, with a hard cap. A POST that may already have been
//     applied is NOT retried unless the caller marks it idempotent (the calendar sends a Graph transactionId, so a repeat cannot create twice).
// It has no database dependency at load time; resolveContext() loads the saved settings on demand.
// Setup, permissions and troubleshooting: docs-internal/contact-inquiries-m365.md.
'use strict';
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const oauth = require('./smtp-oauth');

const GRAPH_DEFAULT = 'https://graph.microsoft.com/v1.0';
const REQUEST_TIMEOUT_MS = 20000;
const MAX_ATTEMPTS = 4;                    // the first try + up to three retries
const MAX_RETRY_WAIT_MS = 30000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

// Where requests go. Always Microsoft Graph over https. M365_GRAPH_BASE_URL (server environment only) exists so the tests can point
// at a fake Graph server; it is ignored entirely in production, and outside production it must be https or plain http on loopback.
function graphBase() {
    const raw = String(process.env.M365_GRAPH_BASE_URL || '').trim().replace(/\/+$/, '');
    if (raw && process.env.NODE_ENV !== 'production') {
        try {
            const u = new URL(raw);
            if (u.protocol === 'https:') return raw;
            if (u.protocol === 'http:' && /^(127\.0\.0\.1|localhost|\[::1\])$/.test(u.hostname)) return raw;
        } catch (e) { /* fall through to the default */ }
    }
    return GRAPH_DEFAULT;
}

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

// ── context: which mailbox, which credentials ────────────────────────────────────────────────────────────────
// ctx = { mailbox, oauth: { tenant, clientId, secret } }.  Built from the saved Email (SMTP) settings; the mailbox is the OAuth
// sign-in address. Reading is only possible with Microsoft 365 OAuth (a mailbox password cannot sign in to Graph).
async function resolveContext() {
    // Same rule as the SMTP transport: mock mode never talks to Microsoft (the automated tests and a developer's local run).
    if (process.env.SMTP_MOCK === 'true') return { ok: false, message: 'Mail is running in mock mode (SMTP_MOCK=true); Microsoft is not contacted.' };
    const smtpConfig = require('./smtp-config');   // lazy: pulls in the database, which a pure caller (the unit tests) must not open
    const r = await smtpConfig.resolveSmtpConfig();
    const c = r && r.config;
    if (!c || c.auth !== 'oauth') return { ok: false, message: 'Reading the mailbox needs Microsoft 365 OAuth sign-in (System > Email > Email Setup).' };
    if (!r.ok || !c.oauth || !c.oauth.tenant || !c.oauth.clientId || !c.oauth.secret) return { ok: false, message: 'The Microsoft 365 OAuth settings are incomplete.' };
    if (!c.user || !c.user.includes('@')) return { ok: false, message: 'The mailbox address (SMTP user) is not set.' };
    return { ok: true, ctx: { mailbox: c.user.trim().toLowerCase(), oauth: c.oauth } };
}

// ── URL building and the "only this mailbox" rule ────────────────────────────────────────────────────────────
const mailboxRoot = (ctx) => `${graphBase()}/users/${encodeURIComponent(ctx.mailbox)}`;

function buildUrl(ctx, mailPath, query) {
    if (typeof mailPath !== 'string' || !mailPath.startsWith('/') || mailPath.includes('..') || /[\r\n]/.test(mailPath)) {
        throw new Error('Graph path must be a plain path relative to the mailbox');
    }
    const qs = query ? '?' + Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => `${encodeURIComponent(k).replace(/%24/g, '$')}=${encodeURIComponent(v)}`).join('&') : '';
    return mailboxRoot(ctx) + mailPath + qs;
}

// A stored @odata.nextLink / @odata.deltaLink is just a string out of our own database; before it is followed it must still
// point at Graph, over the same scheme/host, inside THIS mailbox. Anything else (tampered row, other mailbox, other host) is refused.
function linkSearch(ctx, link) {
    try {
        const u = new URL(link);
        const base = new URL(graphBase());
        if (u.protocol !== base.protocol || u.host !== base.host || u.username || u.password) return null;
        return u.search;
    } catch (e) { return null; }
}
// A stored @odata.nextLink / @odata.deltaLink is just a string out of our own database. Graph writes such links in its own style
// (users('<id>')/mailFolders('<id>')/...), not the /users/<address>/... form we send, so the PATH of a link cannot be compared with ours.
// Instead only its query string (the checkpoint tokens) is kept, and only if the link points at Graph itself (same scheme and host, no credentials);
// the request is then rebuilt on the pinned mailbox path by the caller. A tampered link can therefore never steer a request to another mailbox or host.
function isGraphLink(ctx, link) { return linkSearch(ctx, link) !== null; }

// ── redaction ───────────────────────────────────────────────────────────────
function redact(text, ctx) {
    let t = String(text == null ? '' : text);
    const secret = ctx && ctx.oauth && ctx.oauth.secret;
    if (secret && String(secret).length >= 4) t = t.split(String(secret)).join('[redacted]');
    return t.replace(/Bearer\s+[A-Za-z0-9._~+\/=-]{10,}/gi, 'Bearer [redacted]')
        .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, '[redacted-token]');
}

// ── error classification ─────────────────────────────────────────────────────────────────────────────────────
// Turns an HTTP status / Graph error body / network failure into { category, code, message, retryable, systemic }.
//   systemic = every call will fail the same way until an administrator acts (credentials, permission) - the sync must stop and say so.
function classify({ status, json, netCode, tokenError, requestId, resource, item }) {
    const code = (json && json.error && (json.error.code || json.error.innerError && json.error.innerError.code)) || null;
    const ref = requestId ? ` [request-id ${requestId}]` : '';
    if (tokenError) {
        return { category: 'auth', code: 'TOKEN', retryable: false, systemic: true, message: String(tokenError.message || tokenError).replace(/^\[oauth-token\]\s*/, '').slice(0, 300) };
    }
    if (netCode) {
        return { category: 'connection', code: netCode, retryable: true, systemic: false, message: `Could not reach Microsoft Graph (${netCode}).` };
    }
    if (status === 401) {
        return { category: 'auth', code: code || 'Unauthorized', retryable: false, systemic: true, message: `Microsoft Graph rejected the access token (401${code ? ' ' + code : ''}).${ref}` };
    }
    if (status === 403) {
        if (resource === 'calendar') {
            return { category: 'permission', code: code || 'Forbidden', retryable: false, systemic: true,
                message: 'The app is not allowed to use the calendar of this mailbox (403). In Exchange Online grant the "Application Calendars.ReadWrite" role for this mailbox ' +
                    '(RBAC for Applications) and wait up to 2 hours for it to apply - see docs-internal/calendar-m365.md.' + ref };
        }
        return { category: 'permission', code: code || 'Forbidden', retryable: false, systemic: true,
            message: 'The app is not allowed to read this mailbox (403). In Exchange Online grant the "Application Mail.Read" role for this mailbox ' +
                '(RBAC for Applications) and wait up to 2 hours for it to apply - see docs-internal/contact-inquiries-m365.md.' + ref };
    }
    if (status === 404 && item) {
        // addressed one event by id: it is gone (deleted in Outlook, or never existed) - an event-level fact, not a mailbox problem
        return { category: 'notfound', code: code || 'ErrorItemNotFound', retryable: false, systemic: false, message: 'Microsoft 365 no longer has that item (404).' + ref };
    }
    if (status === 404) {
        return { category: 'mailbox', code: code || 'NotFound', retryable: false, systemic: true,
            message: /MailboxNotEnabledForRESTAPI|MailboxNotSupportedForRESTAPI/i.test(code || '')
                ? 'This mailbox cannot be read through Microsoft Graph (it is not a cloud mailbox with a licence).' + ref
                : 'Microsoft Graph cannot find that mailbox or folder (404). Check the SMTP user address.' + ref };
    }
    if (status === 410 || /syncState|resync/i.test(code || '')) {
        return { category: 'resync', code: code || 'Gone', retryable: false, systemic: false, message: 'Microsoft no longer accepts the saved sync position; the mailbox will be re-scanned from scratch.' + ref };
    }
    if (status === 429) {
        return { category: 'throttled', code: code || 'TooManyRequests', retryable: true, systemic: false, message: 'Microsoft Graph is throttling requests (429).' + ref };
    }
    if (status >= 500) {
        return { category: 'server', code: code || 'ServerError', retryable: true, systemic: false, message: `Microsoft Graph had a temporary problem (${status}).${ref}` };
    }
    return { category: 'invalid', code: code || 'BadRequest', retryable: false, systemic: false, message: `Microsoft Graph refused the request (${status}${code ? ' ' + code : ''}).${ref}` };
}

// ── transport ────────────────────────────────────────────────────────────────────────────────────────────────
function rawRequest(method, urlString, token, extraHeaders, bodyText) {
    return new Promise((resolve) => {
        const url = new URL(urlString);
        const lib = url.protocol === 'http:' ? http : https;
        const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(extraHeaders || {}) };
        if (bodyText !== undefined) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(bodyText); }
        const req = lib.request({
            method, hostname: url.hostname, port: url.port || (url.protocol === 'http:' ? 80 : 443), path: url.pathname + url.search,
            headers,
            rejectUnauthorized: String(process.env.SMTP_TLS_REJECT_UNAUTHORIZED).toLowerCase() !== 'false', minVersion: 'TLSv1.2',
            servername: /^[\d.]+$/.test(url.hostname) ? undefined : url.hostname, timeout: REQUEST_TIMEOUT_MS
        }, (res) => {
            let data = '', size = 0;
            res.setEncoding('utf8');
            res.on('data', (d) => { size += d.length; if (size > MAX_RESPONSE_BYTES) req.destroy(Object.assign(new Error('too large'), { code: 'ERESPONSE_TOO_LARGE' })); else data += d; });
            res.on('end', () => {
                let json = null; try { json = data ? JSON.parse(data) : null; } catch (e) { /* not JSON */ }
                resolve({ status: res.statusCode, json, headers: res.headers });
            });
            res.on('error', (e) => resolve({ netCode: e.code || 'ECONNRESET' }));
        });
        req.on('timeout', () => req.destroy(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })));
        req.on('error', (e) => resolve({ netCode: e.code || 'ECONNECTION' }));
        req.end(bodyText);
    });
}

function retryWaitMs(attempt, retryAfterHeader, baseMs) {
    const secs = Number(retryAfterHeader);
    if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, MAX_RETRY_WAIT_MS);
    return Math.min(baseMs * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 250), MAX_RETRY_WAIT_MS);
}

const METHODS = new Set(['GET', 'POST', 'PATCH', 'DELETE']);

/**
 * One call to the configured mailbox. `path` is relative to /users/<mailbox> (e.g. '/mailFolders/inbox', '/calendar/events/<id>').
 * To continue a stored nextLink / deltaLink pass it as `url` TOGETHER WITH the `path` it continues (see linkSearch): only its query is used.
 * Resolves { ok:true, status, json, requestId } or { ok:false, ...classify() } - never throws.
 *   method      GET (default) | POST | PATCH | DELETE;  `body` (an object) is sent as JSON for POST / PATCH.
 *   resource    'mail' (default) | 'calendar' - only chooses which Exchange role the permission message names.
 *   item        true when the path addresses ONE item by id: a 404 then means "that item is gone", not "no such mailbox".
 *   idempotent  true when repeating the POST cannot create a second thing (the caller sent a transactionId); only then is a POST retried after a
 *               timeout / 5xx. A 429 is always retried: Microsoft did not process that request. An unconfirmed write is flagged `unconfirmed:true`.
 * opts: { sleep, retryBaseMs }   (so the tests do not wait for real back-off)
 */
async function graphRequest(ctx, { method = 'GET', path, url, query, headers, body, resource = 'mail', item = false, idempotent = false } = {}, opts = {}) {
    method = String(method).toUpperCase();
    if (!METHODS.has(method)) return { ok: false, category: 'invalid', code: 'BadMethod', retryable: false, systemic: false, message: 'Unsupported request method.' };
    let target;
    try {
        if (url) {
            const search = linkSearch(ctx, url);
            if (search === null) return { ok: false, category: 'invalid', code: 'ForeignLink', retryable: false, systemic: false, message: 'Refused to follow a link that does not point at Microsoft Graph.' };
            if (!path) return { ok: false, category: 'invalid', code: 'BadPath', retryable: false, systemic: false, message: 'A saved link must be followed together with the path it continues.' };
            target = buildUrl(ctx, path) + search;
        } else {
            target = buildUrl(ctx, path, query);
        }
    } catch (e) {
        return { ok: false, category: 'invalid', code: 'BadPath', retryable: false, systemic: false, message: e.message };
    }
    const bodyText = body !== undefined && (method === 'POST' || method === 'PATCH') ? JSON.stringify(body) : undefined;
    const mayRepeat = method !== 'POST' || idempotent;
    const sleep = opts.sleep || sleepMs;
    const baseMs = opts.retryBaseMs == null ? 1000 : opts.retryBaseMs;
    let renewToken = false, renewedOnce = false, last = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        let token;
        try {
            token = (await oauth.getAccessToken(ctx.oauth, { scope: oauth.GRAPH_SCOPE, forceRenew: renewToken })).token;
        } catch (err) {
            const c = classify({ tokenError: err });
            return { ok: false, ...c, message: redact(c.message, ctx) };
        }
        renewToken = false;
        const res = await rawRequest(method, target, token, headers, bodyText);
        const requestId = res.headers && (res.headers['request-id'] || res.headers['client-request-id']) || null;
        if (!res.netCode && res.status >= 200 && res.status < 300) return { ok: true, status: res.status, json: res.json, requestId };

        last = { ...classify({ status: res.status, json: res.json, netCode: res.netCode, requestId, resource, item }), status: res.status || null, requestId };
        if (res.status === 401 && attempt < MAX_ATTEMPTS && !renewedOnce) { renewToken = renewedOnce = true; continue; }   // the cached token may have been revoked: one fresh token, once
        if (!last.retryable || attempt === MAX_ATTEMPTS) break;
        if (!mayRepeat && last.category !== 'throttled') break;   // the first try may have been applied: do not risk doing it twice
        await sleep(retryWaitMs(attempt, res.headers && res.headers['retry-after'], baseMs));
    }
    if (!mayRepeat && (last.category === 'connection' || last.category === 'server')) last.unconfirmed = true;
    return { ok: false, ...last, message: redact(last.message, ctx) };
}

// GET from the configured mailbox (the original, read-only entry point; same arguments as graphRequest without method / body).
function graphGet(ctx, args, opts) { return graphRequest(ctx, { ...(args || {}), method: 'GET' }, opts); }

// ── diagnostics (administrator button; also used by the sync before it starts) ───────────────────────────────
// Three independent checks, each with a plain-language result. Reads ONE folder's counters - never a message - so it is safe to run any time.
async function diagnose(ctxIn) {
    const steps = [];
    const add = (id, label, ok, message) => steps.push({ id, label, ok, message });
    let ctx = ctxIn;
    if (!ctx) {
        const r = await resolveContext();
        if (!r.ok) { add('config', 'Settings', false, r.message); return { ok: false, steps }; }
        ctx = r.ctx;
    }
    add('config', 'Settings', true, `Reading the inbox of ${ctx.mailbox} with the saved Microsoft 365 OAuth app.`);

    try {
        await oauth.getAccessToken(ctx.oauth, { scope: oauth.GRAPH_SCOPE, forceRenew: true });
        add('token', 'Microsoft Graph sign-in', true, 'Microsoft issued an access token for Graph.');
    } catch (err) {
        add('token', 'Microsoft Graph sign-in', false, redact(classify({ tokenError: err }).message, ctx));
        return { ok: false, mailbox: ctx.mailbox, steps };
    }

    const r = await graphGet(ctx, { path: '/mailFolders/inbox', query: { $select: 'id,displayName,totalItemCount,unreadItemCount' } });
    if (r.ok) {
        const f = r.json || {};
        add('inbox', 'Inbox access', true, `The inbox is readable (${Number(f.totalItemCount) || 0} messages, ${Number(f.unreadItemCount) || 0} unread).`);
    } else {
        add('inbox', 'Inbox access', false, r.message);
    }
    return { ok: steps.every((s) => s.ok), mailbox: ctx.mailbox, steps };
}

// The calendar twin of diagnose(): sign-in, can the calendar be read, and (probe:true) can an event be written and removed again.
// The write probe is the only way to prove "Application Calendars.ReadWrite" is in force before real bookings depend on it: it creates one
// invisible 5-minute event in the year 2001 (free, no reminder, no attendees, so nobody is notified) and deletes it straight away.
async function diagnoseCalendar(ctxIn, { probe = true, deps = {} } = {}) {
    const steps = [];
    const add = (id, label, ok, message) => steps.push({ id, label, ok, message });
    const request = deps.graphRequest || graphRequest;
    let ctx = ctxIn;
    if (!ctx) {
        const r = await resolveContext();
        if (!r.ok) { add('config', 'Settings', false, r.message); return { ok: false, steps }; }
        ctx = r.ctx;
    }
    add('config', 'Settings', true, `Using the calendar of ${ctx.mailbox} with the saved Microsoft 365 OAuth app.`);

    try {
        await oauth.getAccessToken(ctx.oauth, { scope: oauth.GRAPH_SCOPE, forceRenew: true });
        add('token', 'Microsoft Graph sign-in', true, 'Microsoft issued an access token for Graph.');
    } catch (err) {
        add('token', 'Microsoft Graph sign-in', false, redact(classify({ tokenError: err }).message, ctx));
        return { ok: false, mailbox: ctx.mailbox, steps };
    }

    const cal = await request(ctx, { path: '/calendar', query: { $select: 'id,name,canEdit' }, resource: 'calendar' });
    if (!cal.ok) { add('calendar', 'Calendar access', false, cal.message); return { ok: false, mailbox: ctx.mailbox, steps }; }
    const name = String((cal.json && cal.json.name) || 'Calendar').replace(/[^\p{L}\p{N} ._'-]/gu, '').slice(0, 60) || 'Calendar';
    add('calendar', 'Calendar access', true, `The calendar "${name}" can be read.`);
    if (cal.json && cal.json.canEdit === false) {
        add('write', 'Calendar write access', false, 'This calendar is read-only for the app. Events cannot be created or changed in it.');
        return { ok: false, mailbox: ctx.mailbox, steps };
    }

    if (probe) {
        const when = (hms) => ({ dateTime: `2001-01-02T${hms}`, timeZone: 'UTC' });
        const made = await request(ctx, {
            method: 'POST', path: '/calendar/events', resource: 'calendar', idempotent: true,
            body: { subject: 'Website connection test - safe to delete', start: when('03:00:00'), end: when('03:05:00'), showAs: 'free', isReminderOn: false, transactionId: crypto.randomUUID() }
        });
        if (!made.ok) { add('write', 'Calendar write access', false, made.message); return { ok: false, mailbox: ctx.mailbox, steps }; }
        const id = made.json && made.json.id;
        const removed = id ? await request(ctx, { method: 'DELETE', path: `/calendar/events/${encodeURIComponent(id)}`, resource: 'calendar', item: true }) : { ok: false, message: 'No event id came back.' };
        add('write', 'Calendar write access', true, removed.ok
            ? 'A test event was created and removed again.'
            : 'A test event was created, but it could not be removed (' + removed.message + ') - delete "Website connection test - safe to delete" (2 January 2001) from the calendar by hand.');
    }
    return { ok: steps.every((s) => s.ok), mailbox: ctx.mailbox, steps };
}

module.exports = { graphBase, resolveContext, graphGet, graphRequest, diagnose, diagnoseCalendar, classify, isGraphLink, buildUrl, redact };
