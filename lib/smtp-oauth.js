// OAuth 2.0 client-credentials tokens for SMTP sign-in to Microsoft 365 (SASL XOAUTH2). Used by js/emailService.js through
// lib/smtp-config.js when the Email (SMTP) settings say "Microsoft 365 OAuth": no mailbox password is sent, so Entra security
// defaults / MFA / legacy-auth blocks (which stop password SMTP) do not apply - the app signs in as itself.
//
// Microsoft's documented flow (learn.microsoft.com ... how-to-authenticate-an-imap-pop-smtp-application-by-using-oauth):
//   POST https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token
//        grant_type=client_credentials & client_id & client_secret & scope=https://outlook.office365.com/.default
//   then SMTP:  AUTH XOAUTH2 base64("user=<mailbox>\x01auth=Bearer <token>\x01\x01")   (nodemailer builds that part)
// The app registration needs the "SMTP.SendAsApp" application permission (admin-consented), and its Enterprise-application
// service principal must be registered in Exchange (New-ServicePrincipal) with FullAccess on the mailbox - see
// docs-internal/smtp-email.md.
//
// Security properties:
//   - the request's TLS certificate is VERIFIED even though app.js sets NODE_TLS_REJECT_UNAUTHORIZED=0 process-wide (an explicit
//     per-request option wins); SMTP_TLS_REJECT_UNAUTHORIZED=false is the same documented escape hatch the SMTP side has;
//   - the client secret and tokens are never logged; every message built here is safe to show (Microsoft's error text does not
//     echo the secret, and lib/smtp-config.js redact() scrubs it anyway);
//   - SMTP_OAUTH_AUTHORITY exists only so the tests can point at a fake token server. It is read from the server environment,
//     never from the admin screen.
'use strict';
const https = require('https');
const http = require('http');
const crypto = require('crypto');

const SCOPE = 'https://outlook.office365.com/.default';
// Microsoft Graph (lib/m365-graph.js: reading the shared mailbox). Same app registration and secret, different token audience.
const GRAPH_SCOPE = 'https://graph.microsoft.com/.default';
const SAFETY_MARGIN_MS = 2 * 60 * 1000;      // renew two minutes early
const REQUEST_TIMEOUT_MS = 15000;
const cache = new Map();                      // sha256(tenant|client|secret) -> { token, expiresAt }

// Where the token request goes. Always Microsoft over https. SMTP_OAUTH_AUTHORITY (server environment only, never the admin screen)
// exists so the tests can point at a fake token server: https, or plain http to a LOOPBACK address outside production - so the tests do
// not depend on loopback TLS behaving (security software on a developer PC can re-sign it). A secret is never sent over plain http to a
// real host, and plain http is refused outright in production.
function authority() {
    const raw = String(process.env.SMTP_OAUTH_AUTHORITY || 'https://login.microsoftonline.com').trim().replace(/\/+$/, '');
    try {
        const u = new URL(raw);
        if (u.protocol === 'https:') return raw;
        if (u.protocol === 'http:' && process.env.NODE_ENV !== 'production' && /^(127\.0\.0\.1|localhost|\[::1\])$/.test(u.hostname)) return raw;
    } catch (e) { /* fall through to the default */ }
    return 'https://login.microsoftonline.com';
}
const verifyTls = () => String(process.env.SMTP_TLS_REJECT_UNAUTHORIZED).toLowerCase() !== 'false';
const cacheKey = (c, scope) => crypto.createHash('sha256').update([c.tenant, c.clientId, c.secret, scope].join('\u0000')).digest('hex');

// An Error whose message starts with "[oauth-token]" so lib/smtp-config.js classifySmtpError() can recognise it (nodemailer wraps
// a token failure as a generic EAUTH error that carries only this message).
function tokenError(message, extra) {
    const e = new Error('[oauth-token] ' + message);
    e.code = 'EOAUTH';
    return Object.assign(e, extra || {});
}

function postForm(urlString, form) {
    return new Promise((resolve, reject) => {
        const url = new URL(urlString);
        const body = new URLSearchParams(form).toString();
        const req = (url.protocol === 'http:' ? http : https).request({
            method: 'POST', hostname: url.hostname, port: url.port || (url.protocol === 'http:' ? 80 : 443), path: url.pathname + url.search,
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body), Accept: 'application/json' },
            rejectUnauthorized: verifyTls(), minVersion: 'TLSv1.2', servername: /^[\d.]+$/.test(url.hostname) ? undefined : url.hostname,
            timeout: REQUEST_TIMEOUT_MS
        }, (res) => {
            let data = '';
            res.setEncoding('utf8');
            res.on('data', (d) => { data += d; if (data.length > 200000) req.destroy(new Error('response too large')); });
            res.on('end', () => { let json = null; try { json = JSON.parse(data); } catch (e) { /* not JSON */ } resolve({ status: res.statusCode, json }); });
        });
        req.on('timeout', () => req.destroy(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })));
        req.on('error', reject);
        req.end(body);
    });
}

// cfg: { tenant, clientId, secret }.  Resolves { token, expiresAt }  (expiresAt = absolute epoch milliseconds, which is what
// nodemailer's provisionCallback expects).  `forceRenew` ignores the cache (used by Test Connection and by nodemailer's retry).
// `scope` defaults to SMTP (Exchange Online); lib/m365-graph.js passes GRAPH_SCOPE. Tokens are cached per scope.
async function getAccessToken(cfg, { forceRenew = false, scope = SCOPE } = {}) {
    const key = cacheKey(cfg, scope);
    const hit = cache.get(key);
    if (!forceRenew && hit && hit.expiresAt > Date.now()) return hit;

    const host = new URL(authority()).host;
    let res;
    try {
        res = await postForm(`${authority()}/${encodeURIComponent(cfg.tenant)}/oauth2/v2.0/token`, {
            grant_type: 'client_credentials', client_id: cfg.clientId, client_secret: cfg.secret, scope
        });
    } catch (err) {
        throw tokenError(`Could not reach the Microsoft sign-in service (${host}): ${err.code || err.message}`, { netCode: err.code || 'ECONNECTION' });
    }
    const j = res.json || {};
    if (res.status !== 200 || !j.access_token) {
        const desc = String(j.error_description || '').replace(/\s+/g, ' ');
        const aadsts = (/AADSTS\d+/.exec(desc) || [])[0] || null;
        // keep the first sentence(s) only - Microsoft appends Trace ID / Correlation ID / Timestamp, which would just be noise here
        const short = desc.split(/\s*Trace ID:/i)[0].slice(0, 260);
        throw tokenError(`Microsoft did not issue a token (HTTP ${res.status}${j.error ? ' ' + j.error : ''}${aadsts ? ', ' + aadsts : ''}). ${short}`.trim(), { aadsts, status: res.status });
    }
    const expiresIn = Math.max(60, Number(j.expires_in) || 3600);
    const entry = { token: j.access_token, expiresAt: Date.now() + expiresIn * 1000 - SAFETY_MARGIN_MS };
    cache.set(key, entry);
    return entry;
}

// nodemailer `auth.provisionCallback`: (user, renew, cb(err, accessToken, expiresAtMs)).
function provisionCallback(cfg) {
    return (user, renew, callback) => {
        getAccessToken(cfg, { forceRenew: !!renew }).then(
            (t) => callback(null, t.token, t.expiresAt),
            (err) => callback(err)
        );
    };
}

const clearTokens = () => cache.clear();

// `authority` is exported only so the tests can assert the plain-http / production rules above.
module.exports = { SCOPE, GRAPH_SCOPE, getAccessToken, provisionCallback, clearTokens, authority };
