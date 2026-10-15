// SMTP configuration: resolution, validation, secret handling and error classification for the one mail
// transport in js/emailService.js. This is NOT a second settings store - the values live where they always did:
//   - the `settings` table (smtp_host / smtp_port / smtp_user / smtp_pass / smtp_from, plus smtp_secure and
//     smtp_from_name), edited from Admin -> System Settings -> Email (SMTP); and
//   - the SMTP_* environment variables already documented in .env.example (deployment defaults / secrets).
// Precedence per field: unsaved form value (test-connection only) > settings table > environment > default.
//
// The password is the one secret. It is stored AES-256-GCM encrypted in settings.smtp_pass (key derived from
// SETTINGS_ENCRYPTION_KEY, falling back to SESSION_SECRET), or supplied by the SMTP_PASS environment variable, and
// it is never returned by any API, written to a log, or copied into process.env.
// The legacy Gmail pair (EMAIL_USER / EMAIL_PASS) is honoured ONLY while nothing else is configured, as a complete
// unit, so that credentials for one provider can never be sent to another.
// Sign-in is either the mailbox PASSWORD or Microsoft 365 OAuth (tenant ID + application ID + client secret; token handling is in
// lib/smtp-oauth.js). The client secret is stored and protected exactly like the password.
// See docs-internal/smtp-email.md for the full picture.
'use strict';
const crypto = require('crypto');
const db = require('../database');
const { upsertSetting } = require('../database/repositories/settings.repository');
const { decodeStoredText } = require('./html-sanitize');
const oauth = require('./smtp-oauth');

const KEYS = ['smtp_host', 'smtp_port', 'smtp_secure', 'smtp_user', 'smtp_pass', 'smtp_from', 'smtp_from_name',
    'smtp_auth', 'smtp_oauth_tenant', 'smtp_oauth_client', 'smtp_oauth_secret'];
const ENC_PREFIX = 'enc:v1:';
const DEFAULT_FROM_NAME = 'Thabiso Mhlongo';
const PROD_PORTS = [25, 465, 587, 2525];   // standard mail-submission ports; the host/port are admin-typed, so keep the probe surface small in production

// ── secret encryption ────────────────────────────────────────────────────────────────────────────────────────
function encryptionKey() {
    let secret = process.env.SETTINGS_ENCRYPTION_KEY || process.env.SESSION_SECRET;
    if (!secret && process.env.NODE_ENV !== 'production') secret = 'dev-only-secret-change-before-deploy';   // same dev fallback app.js uses for sessions
    if (!secret) return null;
    return Buffer.from(crypto.hkdfSync('sha256', secret, 'thabiso-smtp-settings', 'smtp_pass v1', 32));
}

function encryptSecret(plain) {
    const key = encryptionKey();
    if (!key) {
        const e = new Error('Cannot store the password securely: set SETTINGS_ENCRYPTION_KEY (or SESSION_SECRET) on the server, or supply the password through the SMTP_PASS environment variable instead.');
        e.code = 'ENOKEY';
        throw e;
    }
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
    return ENC_PREFIX + Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
}

// Returns the plain text, or null when it cannot be decrypted (key changed / value damaged).
function decryptSecret(stored) {
    try {
        const key = encryptionKey();
        if (!key || typeof stored !== 'string' || !stored.startsWith(ENC_PREFIX)) return null;
        const buf = Buffer.from(stored.slice(ENC_PREFIX.length), 'base64');
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
        decipher.setAuthTag(buf.subarray(12, 28));
        return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
    } catch (e) { return null; }
}

// app.js deepEscapeBody encodes any "...pass..." key with a plain single escapeHtml pass (stored password hashes were
// made from that form). This is its exact single-pass inverse. decodeStoredText() loops until stable, which would
// corrupt a password that really contains "&amp;".
function unescapeOnce(s) {
    return String(s).replace(/&(amp|lt|gt|quot|#x27);/g, (m, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#x27': "'" }[e]));
}

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

const has = (v) => v !== undefined && v !== null && String(v).trim() !== '';

// SMTP_FROM may be a bare address or the "Display Name" <address> form some .env templates use.
function parseFrom(v) {
    const s = String(v).trim();
    const m = /^"?([^"<]*?)"?\s*<\s*([^<>\s]+@[^<>\s]+)\s*>$/.exec(s);
    return m ? { address: m[2], name: m[1].trim() || null } : { address: s, name: null };
}

// Merges form overrides / settings table / environment / defaults into one config. Never throws; `ok` is false (and
// `problems` says why) when it cannot be used to send. `overrides` are UNSAVED form values (test-connection).
async function resolveSmtpConfig(overrides) {
    const ov = overrides || {};
    const stored = await readStored();
    const env = process.env;
    const problems = [];

    const first = (...cands) => { for (const [v, src] of cands) if (has(v)) return { value: String(v).trim(), source: src }; return null; };
    const host = first([ov.host, 'form'], [stored.smtp_host, 'settings'], [env.SMTP_HOST, 'environment']);
    const user = first([ov.user, 'form'], [stored.smtp_user, 'settings'], [env.SMTP_USER, 'environment']);
    const secureRaw = first([ov.secure, 'form'], [stored.smtp_secure, 'settings'], [env.SMTP_SECURE, 'environment']);
    const portRaw = first([ov.port, 'form'], [stored.smtp_port, 'settings'], [env.SMTP_PORT, 'environment']);
    const fromRaw = first([ov.from, 'form'], [stored.smtp_from, 'settings'], [env.SMTP_FROM, 'environment']);
    const nameRaw = first([ov.fromName, 'form'], [stored.smtp_from_name, 'settings'], [env.SMTP_FROM_NAME, 'environment']);
    // Sign-in method: 'password' (default) or 'oauth' (Microsoft 365 app sign-in: tenant + application ID + client secret, no mailbox password).
    const authRaw = first([ov.auth, 'form'], [stored.smtp_auth, 'settings'], [env.SMTP_AUTH, 'environment']);
    const authMode = authRaw && authRaw.value.toLowerCase() === 'oauth' ? 'oauth' : 'password';
    const tenantRaw = first([ov.oauthTenant, 'form'], [stored.smtp_oauth_tenant, 'settings'], [env.SMTP_OAUTH_TENANT_ID, 'environment']);
    const clientRaw = first([ov.oauthClient, 'form'], [stored.smtp_oauth_client, 'settings'], [env.SMTP_OAUTH_CLIENT_ID, 'environment']);

    // Password: unsaved form value > encrypted settings value > SMTP_PASS. A stored value that cannot be decrypted is never
    // sent: it is reported - as a problem when nothing else can supply a password, otherwise as a warning.
    const warnings = [];
    let pass = null, passSource = null, undecryptable = false;
    if (has(ov.pass)) { pass = String(ov.pass); passSource = 'form'; }
    else if (has(stored.smtp_pass)) {
        const plain = stored.smtp_pass.startsWith(ENC_PREFIX) ? decryptSecret(stored.smtp_pass) : unescapeOnce(stored.smtp_pass);   // legacy rows were plaintext
        if (plain) { pass = plain; passSource = 'settings'; }
        else undecryptable = true;
    }
    if (!pass && has(env.SMTP_PASS)) { pass = String(env.SMTP_PASS); passSource = 'environment'; }
    if (undecryptable && authMode === 'password') (pass ? warnings : problems).push('The saved SMTP password cannot be decrypted (the server encryption key changed) - re-enter it');

    // OAuth client secret: same precedence (form > encrypted settings value > SMTP_OAUTH_CLIENT_SECRET) and the same rule that a
    // value which cannot be decrypted is reported and never used.
    let oauthSecret = null, oauthSecretSource = null, secretUndecryptable = false;
    if (has(ov.oauthSecret)) { oauthSecret = String(ov.oauthSecret); oauthSecretSource = 'form'; }
    else if (has(stored.smtp_oauth_secret)) {
        const plain = decryptSecret(stored.smtp_oauth_secret);
        if (plain) { oauthSecret = plain; oauthSecretSource = 'settings'; } else secretUndecryptable = true;
    }
    if (!oauthSecret && has(env.SMTP_OAUTH_CLIENT_SECRET)) { oauthSecret = String(env.SMTP_OAUTH_CLIENT_SECRET); oauthSecretSource = 'environment'; }
    if (secretUndecryptable && authMode === 'oauth') (oauthSecret ? warnings : problems).push('The saved Microsoft client secret cannot be decrypted (the server encryption key changed) - re-enter it');

    // An unsaved form is judged strictly on its own merits (Test Connection, verify-before-save); only the live sending path
    // (no form values) may fall back, below.
    const hasOv = !!overrides && Object.values(overrides).some(has);
    const secure = secureRaw ? secureRaw.value.toLowerCase() : 'starttls';
    const port = portRaw ? parseInt(portRaw.value, 10) : (secure === 'ssl' ? 465 : 587);
    const userVal = user ? user.value : null;
    const fromParsed = fromRaw ? parseFrom(fromRaw.value) : null;
    const from = fromParsed ? fromParsed.address : (userVal && userVal.includes('@') ? userVal : null);
    const fromName = nameRaw ? decodeStoredText(nameRaw.value) : ((fromParsed && fromParsed.name) || DEFAULT_FROM_NAME);

    if (!host) problems.push('SMTP host is not set');
    if (!userVal) problems.push('SMTP user is not set');
    if (authMode === 'oauth') {
        if (!tenantRaw) problems.push('Microsoft tenant ID is not set');
        if (!clientRaw) problems.push('Microsoft application (client) ID is not set');
        if (!has(oauthSecret)) problems.push('Microsoft client secret is not set');
        if (userVal && !userVal.includes('@')) problems.push('SMTP user must be the mailbox address for OAuth sign-in');
    } else if (!has(pass)) problems.push('SMTP password is not set');
    if (!from) problems.push('From address is not set');
    if (!['starttls', 'ssl'].includes(secure)) problems.push('Encryption must be STARTTLS or SSL');
    if (!(port >= 1 && port <= 65535)) problems.push('Port is not valid');

    // Live sending path: while the SMTP configuration is missing or incomplete, keep the existing legacy Gmail pair working AS A
    // UNIT instead of stopping all mail - e.g. a half-filled card, or stale values that older builds saved but ignored. The
    // Gmail password still never goes to any other host. The admin screen reports the fallback (fallbackFrom).
    if (!hasOv && problems.length && has(env.EMAIL_USER) && has(env.EMAIL_PASS)) {
        const cfg = {
            host: 'smtp.gmail.com', port: 587, secure: 'starttls', user: env.EMAIL_USER, pass: env.EMAIL_PASS,
            from: env.EMAIL_USER, fromName, source: 'legacy-env', passSource: 'legacy-env', auth: 'password'
        };
        _cachedSender = cfg.from;
        return { ok: true, problems: [], warnings, fallbackFrom: (host || userVal || has(pass) || tenantRaw || clientRaw || has(oauthSecret)) ? problems : [], config: cfg };
    }

    const sources = [host, user, fromRaw, portRaw].filter(Boolean).map(x => x.source);
    const source = sources.includes('form') ? 'form' : sources.includes('settings') ? 'settings' : 'environment';
    const config = {
        host: host ? host.value : null, port, secure, user: userVal, pass, from, fromName, source, passSource,
        auth: authMode, oauth: { tenant: tenantRaw ? tenantRaw.value : null, clientId: clientRaw ? clientRaw.value : null, secret: oauthSecret }, secretSource: oauthSecretSource
    };
    if (!hasOv) _cachedSender = config.from || _cachedSender;
    return { ok: problems.length === 0, problems, warnings, fallbackFrom: [], config };
}

// Synchronous "what address do we send as" for the handful of places that used process.env.EMAIL_USER as a
// reply-to / fallback inbox. Kept fresh by every resolveSmtpConfig() (each send, boot, each settings save).
let _cachedSender = null;
function getSenderEmail() {
    return _cachedSender || process.env.SMTP_FROM || process.env.SMTP_USER || process.env.EMAIL_USER || null;
}

// What an API may reveal about the configuration: everything except the password itself.
function publicView(cfg) {
    return {
        host: cfg.host || '', port: cfg.port || '', secure: cfg.secure || 'starttls', user: cfg.user || '', from: cfg.from || '',
        fromName: cfg.fromName || '', source: cfg.source || 'none', passwordSet: has(cfg.pass), passwordSource: cfg.passSource || null,
        auth: cfg.auth || 'password', oauthTenant: (cfg.oauth && cfg.oauth.tenant) || '', oauthClient: (cfg.oauth && cfg.oauth.clientId) || '',
        secretSet: has(cfg.oauth && cfg.oauth.secret), secretSource: cfg.secretSource || null
    };
}

// ── validation of admin input ────────────────────────────────────────────────────────────────────────────────
const HOST_RE = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;
const EMAIL_RE = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/;
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isPrivateHost = (h) => /^(localhost|0\.0\.0\.0|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(h);

// Validates only the fields present in `raw` (an unsaved form or a PUT body). Returns the cleaned values to store,
// per-field errors, and non-blocking warnings. Text fields arrive entity-encoded by deepEscapeBody and are decoded.
function validateInput(raw) {
    const errors = {}, warnings = [], clean = {};
    const present = (k) => raw[k] !== undefined && raw[k] !== null;
    const prod = process.env.NODE_ENV === 'production';

    if (present('host')) {
        const h = decodeStoredText(String(raw.host)).trim();
        if (h) {
            if (!HOST_RE.test(h)) errors.host = 'Enter just the server name, e.g. smtp.office365.com (no http://, spaces or port).';
            else if (prod && isPrivateHost(h)) errors.host = 'That address is not allowed - use your mail provider\'s public server name.';
        }
        clean.host = h;
    }
    if (present('port')) {
        const p = String(raw.port).trim();
        if (p) {
            const n = /^\d{1,5}$/.test(p) ? parseInt(p, 10) : NaN;
            if (!(n >= 1 && n <= 65535)) errors.port = 'Port must be a number between 1 and 65535 (587 for Microsoft 365).';
            else if (prod && !PROD_PORTS.includes(n)) errors.port = 'Use a standard mail-submission port: 587 (STARTTLS) or 465 (SSL).';
        }
        clean.port = p;
    }
    if (present('secure')) {
        const s = String(raw.secure).trim().toLowerCase();
        if (s && !['starttls', 'ssl'].includes(s)) errors.secure = 'Encryption must be STARTTLS or SSL.';
        clean.secure = s;
    }
    if (clean.port && clean.secure && !errors.port && !errors.secure) {
        if (clean.port === '587' && clean.secure === 'ssl') errors.secure = 'Port 587 uses STARTTLS, not SSL.';
        if (clean.port === '465' && clean.secure === 'starttls') errors.secure = 'Port 465 uses SSL, not STARTTLS.';
    }
    if (present('user')) {
        const u = decodeStoredText(String(raw.user)).trim();
        if (u && (u.length > 254 || /[\s\x00-\x1f]/.test(u))) errors.user = 'Enter the mailbox login, e.g. bookings@thabisomhlongo.com.';
        clean.user = u;
    }
    if (present('from')) {
        const f = decodeStoredText(String(raw.from)).trim();
        if (f && (f.length > 254 || !EMAIL_RE.test(f))) errors.from = 'Enter a valid email address.';
        clean.from = f;
    }
    if (present('fromName')) {
        const n = decodeStoredText(String(raw.fromName)).trim();
        if (n.length > 100 || /[\x00-\x1f]/.test(n)) errors.fromName = 'Use up to 100 characters, no line breaks.';
        clean.fromName = n;
    }
    if (present('pass') && String(raw.pass) !== '') {
        const p = unescapeOnce(raw.pass);
        if (p.length > 256 || /[\x00\r\n]/.test(p)) errors.pass = 'The password is too long or contains line breaks.';
        clean.pass = p;
    }

    if (present('auth')) {
        const a = String(raw.auth).trim().toLowerCase();
        if (a && !['password', 'oauth'].includes(a)) errors.auth = 'Sign-in method must be Password or Microsoft 365 OAuth.';
        clean.auth = a;
    }
    if (present('oauthTenant')) {
        const t = decodeStoredText(String(raw.oauthTenant)).trim();
        if (t && !GUID_RE.test(t) && !HOST_RE.test(t)) errors.oauthTenant = 'Enter the Directory (tenant) ID - a GUID - or your tenant domain, e.g. contoso.onmicrosoft.com.';
        clean.oauthTenant = t;
    }
    if (present('oauthClient')) {
        const c = decodeStoredText(String(raw.oauthClient)).trim();
        if (c && !GUID_RE.test(c)) errors.oauthClient = 'Enter the Application (client) ID - a GUID.';
        clean.oauthClient = c;
    }
    if (present('oauthSecret') && String(raw.oauthSecret) !== '') {
        const s = decodeStoredText(String(raw.oauthSecret)).trim();
        if (s.length > 512 || /[\x00-\x20]/.test(s)) errors.oauthSecret = 'The client secret must be the secret VALUE, with no spaces or line breaks.';
        else if (GUID_RE.test(s)) warnings.push('That looks like the client secret ID. Microsoft needs the secret VALUE, which is shown only once when the secret is created.');
        clean.oauthSecret = s;
    }
    if (clean.auth === 'oauth' && clean.user && !clean.user.includes('@') && !errors.user) errors.user = 'For OAuth, SMTP User must be the mailbox address, e.g. bookings@thabisomhlongo.com.';

    const effHost = (clean.host || '').toLowerCase();
    if (/office365|outlook\.com/.test(effHost)) {
        if (clean.secure === 'ssl') warnings.push('Microsoft 365 accepts mail on port 587 with STARTTLS; SSL on 465 is not offered.');
        if (clean.from && clean.user && clean.from.toLowerCase() !== clean.user.toLowerCase())
            warnings.push('Microsoft 365 only accepts a From address that is the signed-in mailbox or one it has "Send As" permission for.');
    }
    return { errors, warnings, clean };
}

// ── engine options ───────────────────────────────────────────────────────────────────────────────────────────
function toTransportOptions(cfg) {
    const legacy = cfg.source === 'legacy-env';
    return {
        host: cfg.host,
        port: cfg.port,
        secure: cfg.secure === 'ssl',
        requireTLS: cfg.secure === 'starttls',     // never fall back to plaintext after EHLO - the password would cross the wire in clear
        // OAuth: nodemailer asks for a token through provisionCallback and sends it with SASL XOAUTH2 - no password is involved.
        auth: cfg.auth === 'oauth'
            ? { type: 'OAuth2', user: cfg.user, provisionCallback: oauth.provisionCallback({ tenant: cfg.oauth.tenant, clientId: cfg.oauth.clientId, secret: cfg.oauth.secret }) }
            : { user: cfg.user, pass: cfg.pass },
        connectionTimeout: 30000,
        greetingTimeout: 30000,
        socketTimeout: 45000,
        tls: {
            minVersion: 'TLSv1.2',
            // app.js sets NODE_TLS_REJECT_UNAUTHORIZED=0 process-wide; an explicit option here overrides it, so the mail
            // server's certificate IS verified. SMTP_TLS_REJECT_UNAUTHORIZED=false is the documented escape hatch for a
            // TLS-intercepting proxy. The legacy Gmail fallback keeps its old (unverified) behaviour until it is migrated.
            rejectUnauthorized: legacy ? false : String(process.env.SMTP_TLS_REJECT_UNAUTHORIZED).toLowerCase() !== 'false'
        }
    };
}

// ── error handling ───────────────────────────────────────────────────────────────────────────────────────────
function redact(text, cfg) {
    let t = String(text == null ? '' : text);
    const secrets = [];
    if (cfg && cfg.pass && String(cfg.pass).length >= 4) {
        const p = String(cfg.pass);
        secrets.push(p, Buffer.from(p).toString('base64'));
        if (cfg.user) secrets.push(Buffer.from('\0' + cfg.user + '\0' + p).toString('base64'));
    }
    if (cfg && cfg.oauth && cfg.oauth.secret && String(cfg.oauth.secret).length >= 4) secrets.push(String(cfg.oauth.secret));
    for (const s of secrets) t = t.split(s).join('[redacted]');
    return t.replace(/AUTH (PLAIN|LOGIN|XOAUTH2)\s+[A-Za-z0-9+/=]{8,}/gi, 'AUTH $1 [redacted]')
        .replace(/Bearer\s+[A-Za-z0-9._~+\/=-]{10,}/gi, 'Bearer [redacted]')
        .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, '[redacted-token]');
}

// A failure to GET a token from Microsoft (see lib/smtp-oauth.js, which marks its messages "[oauth-token]"): wrong tenant /
// application ID / secret, an expired secret, or no route to login.microsoftonline.com.
function classifyOauthToken(err, raw, cfg, mk) {
    const tenant = (cfg && cfg.oauth && cfg.oauth.tenant) || 'the tenant';
    const aadsts = (err && err.aadsts) || (/AADSTS\d+/.exec(raw) || [])[0] || '';
    const detail = ' (' + raw.replace(/^\[oauth-token\]\s*/, '').slice(0, 200) + ')';
    const ex = { code: 'EOAUTH', systemic: true };
    if ((err && err.netCode) || /Could not reach the Microsoft sign-in service/.test(raw))
        return mk('connection', 'Could not reach the Microsoft sign-in service (login.microsoftonline.com) to get an access token. Check the server\'s internet access and firewall.' + detail, { code: 'EOAUTH', retryable: true });
    switch (aadsts) {
        case 'AADSTS7000215': return mk('oauth', 'Microsoft rejected the client secret (AADSTS7000215). Enter the secret VALUE (shown only once when it was created), not the Secret ID - or create a new secret in the app registration.' + detail, ex);
        case 'AADSTS7000222': return mk('oauth', 'The client secret has expired (AADSTS7000222). Create a new secret under Certificates and secrets in the app registration and enter its value here.' + detail, ex);
        case 'AADSTS700016': return mk('oauth', 'No application with that Application (client) ID exists in ' + tenant + ' (AADSTS700016). Check the Application (client) ID and the Directory (tenant) ID.' + detail, ex);
        case 'AADSTS90002':
        case 'AADSTS900023': return mk('oauth', 'Microsoft cannot find that Directory (tenant) ID (' + aadsts + '). Copy it from Microsoft Entra ID > Overview.' + detail, ex);
        case 'AADSTS7000112': return mk('oauth', 'The application is disabled in this tenant (AADSTS7000112). Enable it under Enterprise applications.' + detail, ex);
        default: return mk('oauth', 'Microsoft did not issue an access token for the app.' + detail, ex);
    }
}

// Turns whatever nodemailer threw into { category, code, retryable, systemic, message }. `message` is safe to log and to
// show an admin: no credentials, actionable. `systemic` = every message will fail the same way until an admin acts, so
// the queue must pause instead of burning retries on customer emails.
function classifySmtpError(err, cfg) {
    const code = err && err.code;
    const rc = err && err.responseCode;
    const raw = redact([err && err.response, err && err.message].filter(Boolean).join(' | '), cfg).replace(/\s+/g, ' ').trim();
    const detail = raw ? ` (${raw.slice(0, 180)})` : '';
    const endpoint = cfg && cfg.host ? `${cfg.host}:${cfg.port}` : 'the mail server';
    const mk = (category, message, extra) => Object.assign({ category, code: code || category.toUpperCase(), retryable: false, systemic: false, message: message.slice(0, 480) }, extra);

    if (code === 'ECONFIG') return mk('config', (err.message || 'SMTP is not configured') + '.', { code: 'ECONFIG', systemic: true });
    if (code === 'ENOKEY') return mk('config', err.message, { code: 'ENOKEY', systemic: true });
    if (/\[oauth-token\]/.test(raw)) return classifyOauthToken(err, raw, cfg, mk);
    if (cfg && cfg.auth === 'oauth') {
        // Microsoft accepted the app's token request; these are Exchange's answers to the SMTP sign-in that used it.
        if (/5\.7\.3\b/.test(raw))
            return mk('auth', 'Microsoft 365 issued a token but refused the SMTP sign-in (535 5.7.3). This almost always means the app is not fully set up in Exchange: (1) its service principal must be registered with New-ServicePrincipal using the Object ID from ENTERPRISE applications (not App registrations); (2) it needs Add-MailboxPermission ... -AccessRights FullAccess on this mailbox; (3) the SMTP.SendAsApp permission needs admin consent; (4) Authenticated SMTP must be enabled for the mailbox and the organisation. New permissions can take 15-30 minutes to apply.' + detail, { code: 'EAUTH', systemic: true });
        if (/5\.7\.139\b|5\.7\.57\b/.test(raw))
            return mk('auth', 'Microsoft 365 refused the OAuth sign-in (5.7.139 / 5.7.57): Authenticated SMTP is disabled for the mailbox or for the whole organisation. Enable it (Exchange admin center > Mail flow > Settings, and the mailbox Manage email apps).' + detail, { code: 'EAUTH', systemic: true });
    }
    if (/5\.7\.30\b|basic authentication is not supported/i.test(raw))
        return mk('auth', 'Microsoft 365 has switched off basic (username + password) SMTP sign-in for this tenant (5.7.30). A Microsoft 365 admin must re-enable SMTP AUTH basic authentication, or the app must move to OAuth.' + detail, { code: 'EAUTH', systemic: true });
    if (/5\.7\.139\b/.test(raw))
        return mk('auth', 'Microsoft 365 rejected the sign-in (535 5.7.139). Check: Authenticated SMTP is enabled for the mailbox AND the tenant, security defaults / MFA / Conditional Access are not blocking basic auth, and the password is correct.' + detail, { code: 'EAUTH', systemic: true });
    if (/5\.7\.57\b|client not authenticated to send mail/i.test(raw))
        return mk('auth', 'The server says the client is not authenticated to send mail (5.7.57). Authenticated SMTP is probably disabled for this mailbox.' + detail, { code: 'EAUTH', systemic: true });
    if (/5\.7\.3\b/.test(raw))
        return mk('auth', 'Microsoft 365 rejected the sign-in (535 5.7.3 - its generic refusal). It cannot tell us which: the password is wrong or was changed, the account needs MFA or is blocked by security defaults / Conditional Access / an authentication policy, Authenticated SMTP is off for the mailbox or tenant, or the mailbox is unlicensed or disabled. The mailbox\'s sign-in log in Microsoft Entra shows the exact reason.' + detail, { code: 'EAUTH', systemic: true });
    if (code === 'EAUTH' || [530, 534, 535].includes(rc))
        return mk('auth', 'Authentication failed: the mail server rejected the username or password.' + detail, { code: 'EAUTH', systemic: true });
    if (/5\.7\.60\b|sendasdenied|5\.2\.252|not have permissions to send as this sender/i.test(raw))
        return mk('sender', 'The mail server will not send as this From address (5.7.60 SendAsDenied). Use the signed-in mailbox as the From address, or grant it "Send As" permission.' + detail, { code: 'ESENDER', systemic: true });
    if (code === 'ETLS' || err && err.command === 'STARTTLS' || /certificate|self[- ]signed|CERT_|ERR_SSL|SSL routines|wrong version number|handshake|STARTTLS/i.test(raw))
        return mk('tls', 'Could not establish a secure (STARTTLS) connection to ' + endpoint + '. The server certificate may not be trusted or STARTTLS is unavailable on this port. If a corporate proxy intercepts TLS, set SMTP_TLS_REJECT_UNAUTHORIZED=false (not recommended).' + detail, { code: 'ETLS', systemic: true });
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN')
        return mk('connection', `The server name ${cfg && cfg.host ? cfg.host : ''} could not be found. Check the SMTP host.`.replace('  ', ' ') + detail, { code, retryable: true });
    if (code === 'ECONNREFUSED')
        return mk('connection', `Connection to ${endpoint} was refused. Check the host and port, and that outbound SMTP is not blocked by a firewall.` + detail, { code, retryable: true });
    if (['ETIMEDOUT', 'ESOCKET', 'ECONNECTION', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH'].includes(code))
        return mk('connection', `Could not reach ${endpoint} (${code}). Check the host and port, and that outbound port ${cfg && cfg.port || 587} is not blocked.` + detail, { code, retryable: true });
    if (code === 'EENVELOPE' || [550, 551, 553, 554].includes(rc))
        return mk('recipient', 'The mail server refused the message or a recipient address.' + detail, { code: code || 'EENVELOPE' });
    if ([421, 450, 451, 452].includes(rc) || (rc >= 400 && rc < 500))
        return mk('temporary', 'The mail server asked us to try again later.' + detail, { code: code || 'ETEMP', retryable: true });
    return mk('unknown', 'Sending failed.' + detail, { code: code || 'EUNKNOWN', retryable: true });
}

// Encrypts a legacy plaintext settings.smtp_pass in place (older builds stored it unencrypted). Idempotent.
async function migrateLegacyPassword() {
    const stored = await readStored();
    const v = stored.smtp_pass;
    if (!has(v) || v.startsWith(ENC_PREFIX) || !encryptionKey()) return false;
    await new Promise((resolve) => upsertSetting('smtp_pass', encryptSecret(unescapeOnce(v)), () => resolve()));
    return true;
}

module.exports = {
    KEYS, DEFAULT_FROM_NAME, ENC_PREFIX,
    resolveSmtpConfig, getSenderEmail, publicView, validateInput, toTransportOptions,
    classifySmtpError, redact, encryptSecret, decryptSecret, unescapeOnce, migrateLegacyPassword, readStored
};
