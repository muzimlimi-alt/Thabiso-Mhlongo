/**
 * Thabiso Mhlongo — Unified Email Sending Service v1.0
 * Implementation of Phased Overhaul Phase 3.
 */

const crypto = require('crypto');
const nodemailer = require('nodemailer');
const emailTemplates = require('./emailTemplates');
const emailAssets = require('./emailAssets');
const db = require('../database');
const { decodeStoredText, unescapeHtml } = require('../lib/html-sanitize');
const smtpConfig = require('../lib/smtp-config');
const smtpOauth = require('../lib/smtp-oauth');
const queuedAttachments = require('../lib/queued-attachments');
require('dotenv').config();

// The ONE transport. It is built lazily from the resolved SMTP configuration (lib/smtp-config.js: Admin -> System
// Settings -> Email (SMTP), then SMTP_* environment variables, then the legacy EMAIL_USER/EMAIL_PASS pair) and is rebuilt
// automatically whenever that configuration changes, so a saved change applies to the next email without a restart.
// Every workflow - queued emails, the background clerk, scheduled jobs, test sends - reaches SMTP only through here.
const mockTransport = {
    sendMail: async (options) => {
        // Simulate 50ms network delay
        await new Promise(r => setTimeout(r, 50));
        return { messageId: 'mock-id-' + Date.now(), response: '250 OK' };
    }
};
const isMock = () => process.env.SMTP_MOCK === 'true';
if (isMock()) console.log('⚠️ [EMAIL SERVICE] SMTP Mocking Enabled. No real emails will be sent.');

let _cached = { key: null, transport: null, config: null };

async function getTransport() {
    if (isMock()) {
        const sender = smtpConfig.getSenderEmail() || 'mock@localhost';
        return { transport: mockTransport, config: { host: 'mock', port: 0, from: sender, fromName: smtpConfig.DEFAULT_FROM_NAME, source: 'mock' } };
    }
    const r = await smtpConfig.resolveSmtpConfig();
    if (!r.ok) {
        const e = new Error('SMTP is not configured: ' + r.problems.join('; '));
        e.code = 'ECONFIG';
        throw e;
    }
    const opts = smtpConfig.toTransportOptions(r.config);
    // anything that changes how we sign in must change the key, so a saved change takes effect on the very next email
    const credential = r.config.auth === 'oauth' ? [r.config.oauth.tenant, r.config.oauth.clientId, r.config.oauth.secret].join('|') : String(r.config.pass);
    const key = JSON.stringify([opts.host, opts.port, opts.secure, opts.requireTLS, r.config.auth || 'password', opts.auth.user,
        crypto.createHash('sha256').update(credential).digest('hex'), opts.tls.rejectUnauthorized]);
    if (_cached.key !== key) {
        try { if (_cached.transport && _cached.transport.close) _cached.transport.close(); } catch (e) { /* idle connection already gone */ }
        _cached = { key, transport: nodemailer.createTransport(opts), config: r.config };
    } else {
        _cached.config = r.config;   // sender address / display name can change without a new connection
    }
    return _cached;
}

// A systemic fault (wrong password, SMTP AUTH switched off, bad TLS, refused sender) fails EVERY email the same way until an
// admin acts, so the queue worker pauses instead of burning retries - and hammering the mail server's sign-in - on customer mail.
let _pausedUntil = 0;
function pauseSending(ms) { _pausedUntil = Date.now() + ms; }
function isSendingPaused() { return Date.now() < _pausedUntil; }

// Called whenever the SMTP settings are saved: the next email uses them and a paused queue resumes immediately.
function resetTransport() { _cached = { key: null, transport: null, config: null }; _pausedUntil = 0; smtpOauth.clearTokens(); }

// Back-compat facade: this export used to be a nodemailer transporter. Nothing outside this file uses it any more.
const transporter = { sendMail: async (options) => (await getTransport()).transport.sendMail(options) };

/**
 * Connection test for the admin "Test Connection" control. Opens a fresh connection with the saved settings (plus any
 * unsaved form values in `overrides`), negotiates STARTTLS and authenticates, WITHOUT sending a message. The result
 * never contains the password; failures are classified into actionable categories (config / connection / tls / auth).
 */
async function verifySmtp(overrides) {
    const started = Date.now();
    if (isMock()) return { ok: true, mock: true, endpoint: 'mock', message: 'SMTP mock mode is on - no real connection was made.', ms: 0 };
    const r = await smtpConfig.resolveSmtpConfig(overrides);
    if (!r.ok) {
        return { ok: false, category: 'config', code: 'ECONFIG', stage: 'config', message: 'SMTP is not fully configured: ' + r.problems.join('; ') + '.', ms: 0 };
    }
    const cfg = r.config;
    const t = nodemailer.createTransport(Object.assign(smtpConfig.toTransportOptions(cfg), { connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 20000 }));
    const endpoint = `${cfg.host}:${cfg.port}`;
    if (cfg.auth === 'oauth') smtpOauth.clearTokens();   // a test must really ask Microsoft for a fresh token
    try {
        await t.verify();
        if (!overrides || !Object.keys(overrides).length) _pausedUntil = 0;   // the saved settings are proven good
        return {
            ok: true, endpoint, encryption: cfg.secure === 'ssl' ? 'SSL' : 'STARTTLS', user: cfg.user, from: cfg.from, source: cfg.source,
            ms: Date.now() - started,
            authMethod: cfg.auth || 'password',
            message: cfg.auth === 'oauth'
                ? `Got a Microsoft 365 access token for the app, connected to ${endpoint}, secured the connection with ${cfg.secure === 'ssl' ? 'SSL' : 'STARTTLS'} and signed in to ${cfg.user} with OAuth (no mailbox password used). No email was sent.`
                : `Connected to ${endpoint}, secured the connection with ${cfg.secure === 'ssl' ? 'SSL' : 'STARTTLS'} and authenticated as ${cfg.user}. No email was sent.`
        };
    } catch (err) {
        const c = smtpConfig.classifySmtpError(err, cfg);
        const stage = { config: 'config', connection: 'connect', tls: 'starttls', auth: 'authenticate', oauth: 'token' }[c.category] || 'connect';
        return { ok: false, endpoint, stage, category: c.category, code: c.code, message: c.message, ms: Date.now() - started };
    } finally {
        try { t.close(); } catch (e) { /* nothing to close */ }
    }
}

/**
 * Strips HTML tags and normalizes whitespace for text-only fallback.
 */
function htmlToPlainText(html) {
    if (!html) return '';
    return unescapeHtml(html
        .replace(/<style[^>]*>.*<\/style>/gms, '') // Remove styles
        .replace(/<[^>]+>/g, ' ')                  // Strip tags
        .replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')  // entities the text/plain part has no use for
        .replace(/\s\s+/g, ' '))                   // Normalize spaces
        .trim();
}

/**
 * Detects base64 inline images, converts them to buffer attachments with CIDs,
 * and updates the img src attributes.
 */
function extractInlineImages(htmlContent) {
    const inlineAttachments = [];
    if (!htmlContent) return { html: '', attachments: [] };

    let imageCounter = 0;
    // Regex matches <img src="data:image/[a-zA-Z0-9.-+];base64,[^"']+" ...> case-insensitively
    const updatedHtml = htmlContent.replace(/<img([^>]+)src=["'](data:image\/([a-zA-Z0-9\+\-\.]+);base64,([^"'>]+))["']([^>]*)/gi, (match, beforeSrc, fullUri, mimeType, base64Data, afterSrc) => {
        imageCounter++;
        const cid = `inlineImage_${imageCounter}_${Date.now()}`;
        const buffer = Buffer.from(base64Data, 'base64');
        const extension = mimeType === 'svg+xml' ? 'svg' : mimeType;

        inlineAttachments.push({
            filename: `inline_image_${imageCounter}.${extension}`,
            content: buffer,
            cid: cid
        });

        // Reconstruct img tag with cid reference
        return `<img${beforeSrc}src="cid:${cid}"${afterSrc}`;
    });

    return {
        html: updatedHtml,
        attachments: inlineAttachments
    };
}

/**
 * Unified async function to send emails with professional branding and logging/**
 * Unified public email queue function. Instead of sending directly, it inserts the details into the notifications queue.
 */
async function sendEmail({
    to,
    subject,
    htmlContent,
    plainTextAlternative = null,
    attachments = [],
    fromName = null,   // null = the configured sender name (Admin -> System Settings -> Email (SMTP)); a caller may still pass its own
    replyTo = null,
    skipBrandAttachments = false,
    titleOverride = null,
    trigger_event = 'System Communication',
    related_entity = null,
    related_id = null,
    preWrapped = false,
    cc = null,
    bcc = null,
    branding = 'default',
    messageId = null,   // an RFC 5322 Message-ID chosen by the caller (lib/inquiry-messages.js) so the sent mail can be matched when the customer answers
    headers = null      // extra headers, e.g. { 'In-Reply-To': '<...>', 'X-TM-Inquiry-Id': '42' } - see safeHeaders()
}) {
    try {
        // Attachments must survive the queue: every in-memory attachment is copied into notification_attachments (once per distinct file)
        // and each entry keeps its filename and content type. Throws - so the email is reported as NOT queued - if one cannot be stored.
        const attachmentPathsString = await queuedAttachments.store(attachments);

        const emailDetails = {
            htmlContent,
            plainTextAlternative,
            fromName,
            replyTo,
            skipBrandAttachments,
            titleOverride,
            trigger_event,
            preWrapped,
            cc,
            bcc,
            branding,
            messageId,
            headers
        };

        const notificationId = await new Promise((resolve, reject) => {
            db.run(
                `INSERT INTO notifications (type, channel, status, recipient_email, recipient_name, subject, body, attachment_paths, related_entity, related_id)
                 VALUES ('email', 'email', 'pending', ?, ?, ?, ?, ?, ?, ?)`,
                [to, fromName, subject, JSON.stringify(emailDetails), attachmentPathsString, related_entity || null, related_id || null],
                function(err) {
                    if (err) reject(err);
                    else resolve(this.lastID);
                }
            );
        });

        return { success: true, message: 'Email queued successfully.', notificationId };
    } catch (error) {
        console.error('❌ Failed to queue email:', error);
        return { success: false, error: error.message };
    }
}

// ── email_logs: one row per delivery ATTEMPT, written for both rendering branches ───────────────────────────────
// status 'success' means "accepted by the SMTP server" (submission) - the server's own reply is kept in smtp_response.
// It is NOT proof that the message reached the recipient's inbox; only a bounce / message trace can show that.
const dbRun = (sql, params) => new Promise((resolve) => db.run(sql, params, function (err) { resolve(err ? null : this.lastID); }));

async function openEmailLog(to, subject, trigger_event) {
    return dbRun("INSERT INTO email_logs (recipient_email, subject, trigger_event, status) VALUES (?, ?, ?, 'pending')", [to, subject, trigger_event]);
}

function closeEmailLog(logId, to, subject, trigger_event, status, errorMessage, smtpResponse) {
    const safeResponse = smtpResponse ? String(smtpResponse).slice(0, 500) : null;
    if (!logId) {
        // The 'pending' insert failed - still record the outcome so it is never lost.
        db.run("INSERT INTO email_logs (recipient_email, subject, trigger_event, status, error_message) VALUES (?, ?, ?, ?, ?)", [to, subject, trigger_event, status, errorMessage]);
        return;
    }
    db.run("UPDATE email_logs SET status = ?, error_message = ?, smtp_response = ? WHERE id = ?", [status, errorMessage, safeResponse, logId], (err) => {
        // smtp_response is added by a migration at boot; on the first instants of a fresh DB it may not exist yet.
        if (err) db.run("UPDATE email_logs SET status = ?, error_message = ? WHERE id = ?", [status, errorMessage, logId]);
    });
}

/**
 * Hands one fully-built message to the shared transport and records the outcome. Returns
 * { success, messageId, response } or { success:false, error, code, category, retryable, systemic } - never throws.
 * A failure is never reported as success, and `error` is already safe to log/show (no credentials).
 */
async function deliver(mailOptions, { to, subject, trigger_event, fromName }) {
    const logId = await openEmailLog(to, subject, trigger_event);
    let cfg = null;
    try {
        const t = await getTransport();
        cfg = t.config;
        mailOptions.from = { name: decodeStoredText(fromName) || cfg.fromName || smtpConfig.DEFAULT_FROM_NAME, address: cfg.from };
        const info = await t.transport.sendMail(mailOptions);
        if (Array.isArray(info.accepted) && info.accepted.length === 0) {
            const e = new Error('The mail server accepted no recipients');
            e.code = 'EENVELOPE';
            throw e;
        }
        const rejected = Array.isArray(info.rejected) && info.rejected.length ? `Some recipients were refused: ${info.rejected.join(', ')}` : null;
        closeEmailLog(logId, to, subject, trigger_event, 'success', rejected, info.response);
        return { success: true, messageId: info.messageId, response: info.response };
    } catch (err) {
        const c = smtpConfig.classifySmtpError(err, cfg);
        console.error(`❌ Email failed [${trigger_event}] to ${to}: ${c.message}`);   // classified + redacted: never the raw error object
        closeEmailLog(logId, to, subject, trigger_event, 'failed', c.message.slice(0, 480), null);
        return { success: false, error: c.message, code: c.code, category: c.category, retryable: c.retryable, systemic: c.systemic };
    }
}

// Message-ID and threading headers a caller may set on one message. Only these are honoured, with CR/LF refused outright, so a stored value can
// never smuggle in another header: X-TM-* (our own markers), In-Reply-To and References (threading); Message-ID must look like <local@domain>.
const MESSAGE_ID_RE = /^<[A-Za-z0-9._%+=~-]{1,120}@[A-Za-z0-9.-]{1,120}>$/;
function applyMessageIdentity(mailOptions, messageId, headers) {
    if (typeof messageId === 'string' && MESSAGE_ID_RE.test(messageId)) mailOptions.messageId = messageId;
    if (headers && typeof headers === 'object') {
        const out = {};
        for (const [name, value] of Object.entries(headers)) {
            if (!/^(X-TM-[A-Za-z0-9-]{1,40}|In-Reply-To|References)$/i.test(name) || typeof value !== 'string' || /[\r\n]/.test(value) || value.length > 1000) continue;
            out[name] = value;
        }
        if (Object.keys(out).length) mailOptions.headers = out;
    }
}

/**
 * Internal direct email sender that connects to the SMTP transporter.
 */
async function sendEmailDirectly({
    to,
    subject,
    htmlContent,
    plainTextAlternative = null,
    attachments = [],
    fromName = null,
    replyTo = null,
    skipBrandAttachments = false,
    titleOverride = null,
    trigger_event = 'System Communication',
    preWrapped = false,
    cc = null,
    bcc = null,
    branding = 'default',
    messageId = null,
    headers = null
}) {
    const isOverhaulEnabled = process.env.EMAIL_OVERHAUL_ENABLED === 'true';
    const meta = { to, subject, trigger_event, fromName };

    // 1. Fallback Logic (Feature Flag Restricted)
    if (!isOverhaulEnabled) {
        let mailOptions;
        try {
            const processedContent = extractInlineImages(htmlContent);
            mailOptions = {
                to,
                subject: decodeStoredText(subject),   // a header is plain text; the stored form is entity-encoded
                html: processedContent.html,
                // Prompt 8: this branch is the one actually active (EMAIL_OVERHAUL_ENABLED is unset in
                // every deployment so far), and it previously sent HTML-only with no text/plain part at
                // all — a deliverability/accessibility gap for every email the app has ever sent.
                text: plainTextAlternative || htmlToPlainText(processedContent.html)
            };
            if (replyTo) mailOptions.replyTo = replyTo;
            if (cc) mailOptions.cc = cc;
            if (bcc) mailOptions.bcc = bcc;
            applyMessageIdentity(mailOptions, messageId, headers);
            const merged = [...processedContent.attachments, ...attachments];
            if (merged.length > 0) mailOptions.attachments = merged;
        } catch (error) {
            console.error('❌ Legacy Email Fallback Failed:', error.message);
            return { success: false, error: error.message };
        }
        return deliver(mailOptions, meta);
    }

    // 2. Branded Logic
    let mailOptions;
    try {
        const processedContent = extractInlineImages(htmlContent);
        const emailBody = processedContent.html;
        const inlineAttachments = processedContent.attachments;

        let unsubscribeUrl = null;
        const subRow = await new Promise((resolve) => {
            db.get("SELECT unsubscribe_token FROM newsletter_subscribers WHERE LOWER(email) = LOWER(?)", [to], (err, row) => resolve(row));
        });

        if (subRow && subRow.unsubscribe_token) {
            const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
            unsubscribeUrl = `${baseUrl}/unsubscribe.html?token=${subRow.unsubscribe_token}&email=${encodeURIComponent(to)}`;
        }

        const socialLinks = await new Promise((resolve) => {
            db.all("SELECT platform_name, platform_url FROM social_links WHERE is_active = 1 ORDER BY display_order ASC", [], (err, rows) => resolve(err ? [] : (rows || [])));
        });

        // Bug fix: this always attached the legacy logo/banner image files as real email
        // attachments, even for preWrapped emails (every current-generation template — quote,
        // invoice, contract, birthday, tracker OTP, etc.) that render their own images via hosted
        // URLs and never reference these files at all. Recipients were getting unrelated,
        // unexplained "2 Attachments" on every email. These legacy files are only meaningful to the
        // pre-rebuild createEmailWrapper() path below, which is skipped entirely when preWrapped.
        const brandAttachments = (skipBrandAttachments || preWrapped) ? [] : emailAssets.getBrandAttachments();
        const mergedAttachments = [...brandAttachments, ...inlineAttachments, ...attachments];

        let bannerSrc = null;
        let finalBranding = branding || 'default';
        if (branding && (branding.startsWith('http') || branding.startsWith('/') || branding.includes('.'))) {
            const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
            bannerSrc = branding.startsWith('/') ? baseUrl + branding : branding;
            finalBranding = 'banner';
        } else {
            const hasBanner = brandAttachments.some(a => a.cid === 'thabisoBanner');
            bannerSrc = hasBanner ? 'cid:thabisoBanner' : (process.env.EMAIL_BANNER || null);
        }

        // preWrapped emails (Prompt 3 rebuild) already contain their full shell via
        // js/emailComponents.js — do NOT wrap again or they double-nest.
        const finalHtml = preWrapped
            ? emailBody
            : emailTemplates.createEmailWrapper(emailBody, titleOverride || subject, unsubscribeUrl, bannerSrc, socialLinks, finalBranding);
        const finalPlainText = plainTextAlternative || htmlToPlainText(emailBody);

        mailOptions = {
            to,
            subject: decodeStoredText(subject),   // a header is plain text; the stored form is entity-encoded
            html: finalHtml,
            text: finalPlainText,
            attachments: mergedAttachments
        };

        if (replyTo) mailOptions.replyTo = replyTo;
        if (cc) mailOptions.cc = cc;
        if (bcc) mailOptions.bcc = bcc;
        applyMessageIdentity(mailOptions, messageId, headers);
    } catch (error) {
        console.error('❌ Premium Email Service Failed:', error.message);
        db.run("INSERT INTO email_logs (recipient_email, subject, trigger_event, status, error_message) VALUES (?, ?, ?, 'failed', ?)",
            [to, subject, trigger_event, error.message]
        );
        return { success: false, error: error.message };
    }
    return deliver(mailOptions, meta);
}

module.exports = {
    transporter,
    sendEmail,
    sendEmailDirectly,
    verifySmtp,
    resetTransport,
    pauseSending,
    isSendingPaused,
    htmlToPlainText,
    extractInlineImages
};
