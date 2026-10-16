// Microsoft Graph client for the ONE shared mailbox (bookings@...). It is the READ side of the Contact / Inquiries integration
// (lib/inbox-sync.js); outgoing mail stays on the SMTP + OAuth transport in js/emailService.js.
//
// Why this module is deliberately small and strict:
//   - one app registration, one secret: it signs in with the OAuth credentials already saved in Admin -> System Settings ->
//     Email (SMTP) (tenant, application ID, client secret) and only asks for a different token audience (GRAPH_SCOPE);
//   - it can only ever address /users/<the configured mailbox>/... : callers pass a path RELATIVE to that mailbox, and absolute
//     nextLink / deltaLink URLs (which are stored in the database) are refused unless they point at the same mailbox on Graph;
//   - it is read-only (GET only) - the least privilege the feature needs ("Application Mail.Read", scoped to the mailbox in Exchange);
//   - it never throws for an expected failure: every call resolves { ok:true, ... } or { ok:false, category, message, ... } where
//     `message` is safe to log and to show an administrator (no secret, no token, no mailbox content);
//   - it retries only what is safe to retry (429 / 5xx / network), honouring Retry-After, with a hard cap.
// It has no database dependency at load time; resolveContext() loads the saved settings on demand.
// Setup, permissions and troubleshooting: docs-internal/contact-inquiries-m365.md.
'use strict';
const https = require('https');
const http = require('http');
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
    if (!c || c.auth !== 'oauth') return { ok: false, message: 'Reading the mailbox needs Microsoft 365 OAuth sign-in (Admin > System Settings > Email (SMTP)).' };
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
function isOwnLink(ctx, link) {
    try {
        const u = new URL(link);
        const root = new URL(mailboxRoot(ctx));
        return u.protocol === root.protocol && u.host === root.host && !u.username && !u.password &&
            (u.pathname + '/').toLowerCase().startsWith((root.pathname + '/').toLowerCase());
    } catch (e) { return false; }
}

// ── redaction ────────────────────────────────────────────────────────────────────────────────────────────────
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
function classify({ status, json, netCode, tokenError, requestId }) {
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
        return { category: 'permission', code: code || 'Forbidden', retryable: false, systemic: true,
            message: 'The app is not allowed to read this mailbox (403). In Exchange Online grant the "Application Mail.Read" role for this mailbox ' +
                '(RBAC for Applications) and wait up to 2 hours for it to apply - see docs-internal/contact-inquiries-m365.md.' + ref };
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
function rawGet(urlString, token, extraHeaders) {
    return new Promise((resolve) => {
        const url = new URL(urlString);
        const lib = url.protocol === 'http:' ? http : https;
        const req = lib.request({
            method: 'GET', hostname: url.hostname, port: url.port || (url.protocol === 'http:' ? 80 : 443), path: url.pathname + url.search,
            headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(extraHeaders || {}) },
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
        req.end();
    });
}

function retryWaitMs(attempt, retryAfterHeader, baseMs) {
    const secs = Number(retryAfterHeader);
    if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, MAX_RETRY_WAIT_MS);
    return Math.min(baseMs * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 250), MAX_RETRY_WAIT_MS);
}

/**
 * GET from the configured mailbox. Exactly one of `path` (relative to /users/<mailbox>, e.g. '/mailFolders/inbox') or `url`
 * (a stored nextLink/deltaLink) must be given.  Resolves { ok:true, status, json, requestId } or { ok:false, ...classify() } - never throws.
 * opts: { query, headers, sleep, retryBaseMs }   (sleep / retryBaseMs exist so the tests do not wait for real back-off)
 */
async function graphGet(ctx, { path, url, query, headers } = {}, opts = {}) {
    let target;
    try {
        if (url) { if (!isOwnLink(ctx, url)) return { ok: false, category: 'invalid', code: 'ForeignLink', retryable: false, systemic: false, message: 'Refused to follow a link that does not belong to this mailbox.' }; target = url; }
        else target = buildUrl(ctx, path, query);
    } catch (e) {
        return { ok: false, category: 'invalid', code: 'BadPath', retryable: false, systemic: false, message: e.message };
    }
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
        const res = await rawGet(target, token, headers);
        const requestId = res.headers && (res.headers['request-id'] || res.headers['client-request-id']) || null;
        if (!res.netCode && res.status >= 200 && res.status < 300) return { ok: true, status: res.status, json: res.json, requestId };

        last = { ...classify({ status: res.status, json: res.json, netCode: res.netCode, requestId }), status: res.status || null, requestId };
        if (res.status === 401 && attempt < MAX_ATTEMPTS && !renewedOnce) { renewToken = renewedOnce = true; continue; }   // the cached token may have been revoked: one fresh token, once
        if (!last.retryable || attempt === MAX_ATTEMPTS) break;
        await sleep(retryWaitMs(attempt, res.headers && res.headers['retry-after'], baseMs));
    }
    return { ok: false, ...last, message: redact(last.message, ctx) };
}

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

module.exports = { graphBase, resolveContext, graphGet, diagnose, classify, isOwnLink, buildUrl, redact };
