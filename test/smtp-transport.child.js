// Run by smtp.test.js in its OWN process (never required by the test runner, because it opens the database): drives the
// REAL js/emailService.js + lib/smtp-config.js + the notification-queue worker against a fake SMTP server and prints one
// "CHECK:{...}" line per assertion. DB_PATH points at a throwaway file the parent deletes.
// MODE=trusted   : NODE_EXTRA_CA_CERTS trusts the fake server's certificate (the happy paths run here)
// MODE=untrusted : it does not, so STARTTLS must be refused - proves the mail server's certificate is really verified.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';          // exactly what app.js does process-wide: the transport must still verify

const fs = require('fs');
const { startFakeSmtp } = require('./fake-smtp');
const MODE = process.env.MODE;
const PASS1 = process.env.T_PASS1, PASS_DB = process.env.T_PASSDB, LEGACY = process.env.T_LEGACY, OAUTH_SECRET = process.env.T_OAUTHSECRET;
const tlsMaterial = { cert: fs.readFileSync(process.env.FAKE_TLS_CERT, 'utf8'), key: fs.readFileSync(process.env.FAKE_TLS_KEY, 'utf8') };

const rec = (name, pass, detail) => console.log('CHECK:' + JSON.stringify({ name, pass: !!pass, detail: pass ? '' : String(detail === undefined ? '' : detail).slice(0, 500) }));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const q = (db, sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => e ? rej(e) : res(r)));
const run = (db, sql, p = []) => new Promise((res, rej) => db.run(sql, p, function (e) { e ? rej(e) : res(this.lastID); }));

const SMTP_VARS = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'SMTP_FROM_NAME', 'EMAIL_USER', 'EMAIL_PASS',
    'SMTP_AUTH', 'SMTP_OAUTH_TENANT_ID', 'SMTP_OAUTH_CLIENT_ID', 'SMTP_OAUTH_CLIENT_SECRET', 'SMTP_OAUTH_AUTHORITY'];
function useEnv(port, over = {}) {
    SMTP_VARS.forEach(k => delete process.env[k]);
    Object.assign(process.env, {
        SMTP_HOST: '127.0.0.1', SMTP_PORT: String(port), SMTP_SECURE: 'starttls', SMTP_USER: 'bookings@test.invalid',
        SMTP_PASS: PASS1, SMTP_FROM: 'bookings@test.invalid', SMTP_FROM_NAME: 'Thabiso Mhlongo'
    }, over);
}
const clearEnv = () => SMTP_VARS.forEach(k => delete process.env[k]);

// Minimal MIME reader for the raw message the fake SMTP server captured: returns every attachment part as { filename, type, bytes }.
function parseAttachments(raw) {
    const out = [];
    const unfold = (s) => s.replace(/\r\n[ \t]+/g, ' ');
    const qpDecode = (s) => Buffer.from(s.replace(/=\r\n/g, '').replace(/=([0-9A-F]{2})/gi, (m, h) => String.fromCharCode(parseInt(h, 16))), 'latin1');
    for (const b of [...raw.matchAll(/boundary="?([^"\r\n;]+)"?/gi)].map(m => m[1])) {
        for (const part of raw.split('--' + b)) {
            const idx = part.indexOf('\r\n\r\n');
            if (idx < 0) continue;
            const head = unfold(part.slice(0, idx)), body = part.slice(idx + 4);
            const disp = /Content-Disposition:\s*attachment[^\r\n]*?filename\*?=(?:"([^"]+)"|([^;\r\n]+))/i.exec(head);
            if (!disp) continue;
            const enc = ((/Content-Transfer-Encoding:\s*(\S+)/i.exec(head) || [])[1] || '7bit').toLowerCase();
            const clean = body.replace(/\r\n--\s*$/, '');
            const bytes = enc === 'base64' ? Buffer.from(clean.replace(/\s+/g, ''), 'base64') : enc === 'quoted-printable' ? qpDecode(clean) : Buffer.from(clean.replace(/\r\n$/, ''), 'latin1');
            out.push({ filename: disp[1] || disp[2], type: (/Content-Type:\s*([^\r\n]+)/i.exec(head) || [])[1] || '', bytes });
        }
    }
    return out;
}

const emailService = require('../js/emailService');
const smtp = require('../lib/smtp-config');
const db = require('../database');
const { upsertSetting } = require('../database/repositories/settings.repository');
const { processNotificationQueue } = require('../lib/background-clerk');

const mailTo = (to, extra = {}) => Object.assign({ to, subject: 'Hello & welcome', htmlContent: '<p>Hi there</p>', preWrapped: true, trigger_event: 'Test: smtp' }, extra);

async function main() {
    // wait for the throwaway DB to finish creating its tables / migrations
    for (let i = 0; i < 60; i++) {
        const cols = await q(db, 'PRAGMA table_info(email_logs)').catch(() => []);
        const n = await q(db, "SELECT name FROM sqlite_master WHERE name IN ('notifications','settings')").catch(() => []);
        if (cols.some(c => c.name === 'smtp_response') && n.length === 2) break;
        await sleep(250);
    }

    if (MODE === 'untrusted') {
        const f = await startFakeSmtp({ user: 'bookings@test.invalid', pass: PASS1, tlsMaterial });
        useEnv(f.port);
        emailService.resetTransport();
        const r = await emailService.sendEmailDirectly(mailTo('qa@test.invalid'));
        rec('an untrusted (self-signed) mail-server certificate is REFUSED even though NODE_TLS_REJECT_UNAUTHORIZED=0 is set process-wide', !r.success && r.category === 'tls', JSON.stringify(r));
        rec('...and no credentials are sent to a server whose certificate cannot be trusted', f.sessions.every(s => s.authAttempts === 0 && !s.mailFrom), JSON.stringify(f.sessions));
        const v = await emailService.verifySmtp();
        rec('Test Connection reports the same certificate problem as a TLS failure with the escape-hatch hint', !v.ok && v.stage === 'starttls' && /SMTP_TLS_REJECT_UNAUTHORIZED/.test(v.message), JSON.stringify(v));
        await f.close();
        const { startFakeTokenServer } = require('./fake-smtp');
        const oauthLib = require('../lib/smtp-oauth');
        const TEN = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', CLI = '11111111-2222-3333-4444-555555555555';
        const tokU = await startFakeTokenServer({ tlsMaterial, tenant: TEN, clientId: CLI, secret: OAUTH_SECRET });
        process.env.SMTP_OAUTH_AUTHORITY = tokU.url;
        let refused = false, why = '';
        try { await oauthLib.getAccessToken({ tenant: TEN, clientId: CLI, secret: OAUTH_SECRET }, { forceRenew: true }); } catch (e) { refused = true; why = e.message; }
        rec('OAuth: a token endpoint with an untrusted certificate is refused and the client secret is never sent to it', refused && tokU.requests.length === 0 && /\[oauth-token\]/.test(why), why);
        await tokU.close();
        return;
    }

    // ── 1. env-configured SMTP: STARTTLS, auth, sender, headers, log row (legacy rendering branch) ──────────────
    {
        const f = await startFakeSmtp({ user: 'bookings@test.invalid', pass: PASS1, tlsMaterial });
        useEnv(f.port, { EMAIL_USER: 'legacy.sentinel@gmail.invalid', EMAIL_PASS: LEGACY });   // legacy pair present but must NOT be used
        process.env.EMAIL_OVERHAUL_ENABLED = '';
        emailService.resetTransport();
        const r = await emailService.sendEmailDirectly(mailTo('qa@test.invalid', { trigger_event: 'Test: env', preWrapped: false }));
        const s = f.sessions.find(x => x.data) || f.sessions[0] || {};
        rec('mail goes out through the SMTP_* configuration (success reported)', r.success === true, JSON.stringify(r));
        rec('the connection was upgraded with STARTTLS before the login was sent', s.tlsActive === true && s.authOk === true, JSON.stringify(s));
        rec('the login used the configured user/password (special characters intact), not the legacy EMAIL_* pair', s.authUser === 'bookings@test.invalid' && !(s.data || '').includes('legacy.sentinel'), JSON.stringify({ u: s.authUser }));
        rec('envelope sender is the configured mailbox and the recipient is the one asked for', s.mailFrom === 'bookings@test.invalid' && s.rcpt[0] === 'qa@test.invalid', JSON.stringify({ f: s.mailFrom, r: s.rcpt }));
        rec('From header carries the configured sender name + address', /^From: .*Thabiso Mhlongo.* <bookings@test\.invalid>/m.test(s.data || ''), (s.data || '').slice(0, 200));
        rec('Subject header is plain text and a text/plain part was sent too', /^Subject: Hello & welcome/m.test(s.data || '') && /Content-Type: text\/plain/i.test(s.data || ''), (s.data || '').slice(0, 300));
        await sleep(250);
        const log = (await q(db, "SELECT * FROM email_logs WHERE trigger_event = 'Test: env' ORDER BY id DESC LIMIT 1"))[0] || {};
        rec('the legacy rendering branch now writes an email_logs row: status success + the server\'s own reply', log.status === 'success' && /Queued mail for delivery/.test(log.smtp_response || ''), JSON.stringify(log));
        await f.close();

        // ── 2. branded branch + an explicit per-workflow display name is still honoured (and decoded) ──
        const f2 = await startFakeSmtp({ user: 'bookings@test.invalid', pass: PASS1, tlsMaterial });
        useEnv(f2.port);
        process.env.EMAIL_OVERHAUL_ENABLED = 'true';
        emailService.resetTransport();
        const r2 = await emailService.sendEmailDirectly(mailTo('qa@test.invalid', { trigger_event: 'Test: branded', fromName: 'O&#x27;Brien &amp; Sons' }));
        const s2 = f2.sessions.find(x => x.data) || {};
        rec('branded rendering branch sends through the same transport', r2.success === true && s2.authOk === true, JSON.stringify(r2));
        rec('an explicit fromName (stored/entity-encoded) is decoded into the From header', /^From: .*O'Brien & Sons.* <bookings@test\.invalid>/m.test(s2.data || ''), (s2.data || '').slice(0, 200));
        await sleep(250);
        const log2 = (await q(db, "SELECT status FROM email_logs WHERE trigger_event = 'Test: branded' ORDER BY id DESC LIMIT 1"))[0] || {};
        rec('branded branch logs success too', log2.status === 'success', JSON.stringify(log2));
        process.env.EMAIL_OVERHAUL_ENABLED = '';
        await f2.close();
    }

    // ── 3. wrong password: classified, systemic, never "sent", no secret anywhere ───────────────────────────────
    {
        const f = await startFakeSmtp({ user: 'bookings@test.invalid', pass: 'a-different-password', tlsMaterial, authFailMessage: 'Authentication unsuccessful, SmtpClientAuthentication is disabled for the Tenant' });
        useEnv(f.port);
        emailService.resetTransport();
        const r = await emailService.sendEmailDirectly(mailTo('qa@test.invalid', { trigger_event: 'Test: badauth' }));
        rec('a rejected login is reported as a failure, never as success', r.success === false && r.category === 'auth', JSON.stringify(r));
        rec('...marked systemic (every email would fail the same way) and not retryable-by-count', r.systemic === true && r.retryable === false, JSON.stringify(r));
        rec('...with an actionable Microsoft 365 explanation (5.7.139 / Authenticated SMTP)', /5\.7\.139/.test(r.error || '') && /Authenticated SMTP/i.test(r.error || ''), r.error);
        rec('the error text does not contain the password', !(r.error || '').includes(PASS1), r.error);
        await sleep(250);
        const log = (await q(db, "SELECT * FROM email_logs WHERE trigger_event = 'Test: badauth' ORDER BY id DESC LIMIT 1"))[0] || {};
        rec('email_logs records status failed with the safe error and no response', log.status === 'failed' && !!log.error_message && !String(log.error_message).includes(PASS1) && !log.smtp_response, JSON.stringify(log));
        rec('no message was transmitted', f.sessions.every(s => !s.mailFrom && s.data === null), JSON.stringify(f.sessions));
        await f.close();
    }

    // ── 4. server that does not offer STARTTLS: refuse, and never send the password in clear ───────────────────
    {
        const f = await startFakeSmtp({ user: 'bookings@test.invalid', pass: PASS1, tlsMaterial, advertiseStartTls: false });
        useEnv(f.port);
        emailService.resetTransport();
        const r = await emailService.sendEmailDirectly(mailTo('qa@test.invalid', { trigger_event: 'Test: nostarttls' }));
        rec('a server without STARTTLS is refused (TLS category), not silently used in plaintext', r.success === false && r.category === 'tls', JSON.stringify(r));
        rec('...and the credentials were never transmitted', f.sessions.every(s => s.authAttempts === 0), JSON.stringify(f.sessions));
        await f.close();
    }

    // ── 5. From address not permitted for this login (Microsoft 5.7.60 SendAsDenied) ───────────────────────────
    {
        const f = await startFakeSmtp({ user: 'bookings@test.invalid', pass: PASS1, tlsMaterial, allowedFrom: 'someone.else@test.invalid' });
        useEnv(f.port);
        emailService.resetTransport();
        const r = await emailService.sendEmailDirectly(mailTo('qa@test.invalid', { trigger_event: 'Test: sendas' }));
        rec('a refused sender address is reported as such and treated as systemic', r.success === false && r.category === 'sender' && r.systemic === true && /Send As/i.test(r.error || ''), JSON.stringify(r));
        await f.close();
    }

    // ── 6. settings table beats env; password stored encrypted, never copied to process.env; legacy plaintext migrates ──
    {
        const fa = await startFakeSmtp({ user: 'bookings@test.invalid', pass: PASS1, tlsMaterial });
        const fb = await startFakeSmtp({ user: 'db.user@test.invalid', pass: PASS_DB, tlsMaterial });
        useEnv(fa.port);
        const save = (k, v) => new Promise((res, rej) => upsertSetting(k, v, e => e ? rej(e) : res()));
        await save('smtp_host', '127.0.0.1'); await save('smtp_port', String(fb.port)); await save('smtp_secure', 'starttls');
        await save('smtp_user', 'db.user@test.invalid'); await save('smtp_from', 'db.from@test.invalid'); await save('smtp_from_name', 'DB Sender');
        await save('smtp_pass', smtp.encryptSecret(PASS_DB));
        emailService.resetTransport();
        const r = await emailService.sendEmailDirectly(mailTo('qa@test.invalid', { trigger_event: 'Test: dbsettings' }));
        const sb = fb.sessions.find(x => x.data) || {};
        rec('settings saved in the admin table take effect on the next email (and beat the environment)', r.success === true && sb.authUser === 'db.user@test.invalid' && sb.mailFrom === 'db.from@test.invalid' && /^From: .*DB Sender/m.test(sb.data || ''), JSON.stringify({ r, u: sb.authUser, f: sb.mailFrom }));
        rec('...and the environment server received nothing', fa.sessions.every(s => !s.mailFrom), JSON.stringify(fa.sessions));
        const raw = (await q(db, "SELECT setting_value AS v FROM settings WHERE setting_key = 'smtp_pass'"))[0].v;
        rec('settings.smtp_pass is AES-encrypted at rest (enc:v1:), not plaintext', raw.startsWith('enc:v1:') && !raw.includes(PASS_DB), raw.slice(0, 20));
        rec('it decrypts back to the exact password; each encryption is unique; a tampered value is rejected', smtp.decryptSecret(raw) === PASS_DB && smtp.encryptSecret(PASS_DB) !== smtp.encryptSecret(PASS_DB) && smtp.decryptSecret(raw.slice(0, -4) + 'AAAA') === null, '');
        rec('the password was NOT copied into process.env', process.env.SMTP_PASS === PASS1, '');
        const oldKey = process.env.SETTINGS_ENCRYPTION_KEY; process.env.SETTINGS_ENCRYPTION_KEY = 'a-rotated-key';
        const rotated = await smtp.resolveSmtpConfig();
        process.env.SETTINGS_ENCRYPTION_KEY = oldKey;
        rec('a changed encryption key is detected and reported (stored password is not used, env password is, config still works)', rotated.ok === true && rotated.config.passSource === 'environment' && rotated.warnings.some(p => /cannot be decrypted/.test(p)), JSON.stringify({ s: rotated.config.passSource, w: rotated.warnings, ok: rotated.ok }));

        // legacy: older builds stored the password in plaintext (entity-encoded by deepEscapeBody)
        await save('smtp_pass', PASS_DB.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;'));
        emailService.resetTransport();
        const rl = await emailService.sendEmailDirectly(mailTo('qa@test.invalid', { trigger_event: 'Test: legacypw' }));
        rec('a legacy plaintext (entity-encoded) stored password still authenticates', rl.success === true, JSON.stringify(rl));
        const migrated = await smtp.migrateLegacyPassword();
        const raw2 = (await q(db, "SELECT setting_value AS v FROM settings WHERE setting_key = 'smtp_pass'"))[0].v;
        rec('...and is encrypted in place by the boot migration (idempotent)', migrated === true && raw2.startsWith('enc:v1:') && smtp.decryptSecret(raw2) === PASS_DB && (await smtp.migrateLegacyPassword()) === false, raw2.slice(0, 12));

        await run(db, "DELETE FROM settings WHERE setting_key LIKE 'smtp\\_%' ESCAPE '\\'");
        emailService.resetTransport();
        await fa.close(); await fb.close();
    }

    // ── 7. unreachable server: transient, retryable, not systemic ─────────────────────────────────────────────
    {
        const dead = await startFakeSmtp({ tlsMaterial }); const deadPort = dead.port; await dead.close();
        useEnv(deadPort);
        emailService.resetTransport();
        const r = await emailService.sendEmailDirectly(mailTo('qa@test.invalid', { trigger_event: 'Test: refused' }));
        rec('connection refused is a retryable connection failure that names the endpoint', r.success === false && r.category === 'connection' && r.retryable === true && r.systemic === false && r.error.includes('127.0.0.1:' + deadPort), JSON.stringify(r));
    }

    // ── 8. Test Connection (no message sent) ─────────────────────────────────────────────────────────────────
    {
        const f = await startFakeSmtp({ user: 'bookings@test.invalid', pass: PASS1, tlsMaterial });
        useEnv(f.port);
        emailService.resetTransport();
        const ok = await emailService.verifySmtp();
        rec('verifySmtp connects, secures with STARTTLS and authenticates, and reports it', ok.ok === true && ok.encryption === 'STARTTLS' && /authenticated as bookings@test\.invalid/.test(ok.message), JSON.stringify(ok));
        rec('...without sending any message', f.sessions.every(s => s.data === null && !s.mailFrom), JSON.stringify(f.sessions));
        const bad = await emailService.verifySmtp({ pass: 'not-the-password' });
        rec('unsaved form values are tested instead of the saved ones (wrong password fails at the authenticate stage)', bad.ok === false && bad.stage === 'authenticate', JSON.stringify(bad));
        rec('...and neither result echoes a password', !JSON.stringify([ok, bad]).includes(PASS1) && !JSON.stringify(bad).includes('not-the-password'), '');
        await f.close();
    }

    // ── 9. not configured / legacy rules ────────────────────────────────────────────────────────────────────────
    {
        clearEnv(); emailService.resetTransport();
        const r = await emailService.sendEmailDirectly(mailTo('qa@test.invalid', { trigger_event: 'Test: unconfigured' }));
        rec('with no SMTP configuration at all, sending fails cleanly (config, systemic) and is logged as failed', r.success === false && r.code === 'ECONFIG' && r.systemic === true, JSON.stringify(r));
        const v = await emailService.verifySmtp();
        rec('Test Connection says what is missing', v.ok === false && v.stage === 'config' && /host is not set/.test(v.message), JSON.stringify(v));
        process.env.EMAIL_USER = 'old@gmail.invalid'; process.env.EMAIL_PASS = LEGACY;
        const leg = await smtp.resolveSmtpConfig();
        rec('only the legacy EMAIL_USER/EMAIL_PASS pair present -> it is used as a unit (Gmail, as before)', leg.ok && leg.config.source === 'legacy-env' && leg.config.host === 'smtp.gmail.com', JSON.stringify(smtp.publicView(leg.config)));
        process.env.SMTP_HOST = 'smtp.office365.com';
        const live = await smtp.resolveSmtpConfig();
        rec('an INCOMPLETE SMTP config keeps the live path on the working legacy pair as a unit (Gmail host), and reports why', live.ok === true && live.config.source === 'legacy-env' && live.config.host === 'smtp.gmail.com' && live.fallbackFrom.includes('SMTP user is not set'), JSON.stringify({ ok: live.ok, src: live.config.source, host: live.config.host, fb: live.fallbackFrom }));
        const strict = await smtp.resolveSmtpConfig({ host: 'smtp.office365.com' });
        rec('...but a strict check of form values never borrows the legacy password (a Gmail password cannot reach Microsoft)', strict.ok === false && strict.config.pass == null && strict.config.host === 'smtp.office365.com' && strict.problems.includes('SMTP password is not set'), JSON.stringify({ ok: strict.ok, pass: strict.config.pass == null, p: strict.problems }));
        process.env.SMTP_FROM = '"Thabiso Mhlongo Management" <bookings@test.invalid>'; process.env.SMTP_USER = 'bookings@test.invalid'; process.env.SMTP_PASS = 'x-complete-config';
        const disp = await smtp.resolveSmtpConfig();
        rec('a complete SMTP config wins over the legacy pair; SMTP_FROM in "Name" <address> form is split into address + name', disp.ok === true && disp.config.source === 'environment' && disp.config.from === 'bookings@test.invalid' && disp.config.fromName === 'Thabiso Mhlongo Management', JSON.stringify(smtp.publicView(disp.config)));
        clearEnv();
    }

    // ── 10. validation ────────────────────────────────────────────────────────────────────────────────────────
    {
        const e = (raw) => Object.keys(smtp.validateInput(raw).errors);
        rec('host: a URL / spaces / path are rejected; a plain host name is accepted', e({ host: 'http://smtp.office365.com' }).includes('host') && e({ host: 'smtp office365.com' }).includes('host') && e({ host: 'smtp.office365.com' }).length === 0, '');
        rec('port: must be 1-65535 digits', e({ port: '70000' }).includes('port') && e({ port: '587a' }).includes('port') && e({ port: '0' }).includes('port') && e({ port: '587' }).length === 0, '');
        rec('encryption: only starttls / ssl, and it must match the well-known ports', e({ secure: 'none' }).includes('secure') && e({ port: '587', secure: 'ssl' }).includes('secure') && e({ port: '465', secure: 'starttls' }).includes('secure') && e({ port: '465', secure: 'ssl' }).length === 0, '');
        rec('sender: invalid address / line breaks in the display name rejected', e({ from: 'not-an-email' }).includes('from') && e({ fromName: 'Evil\r\nBcc: x@y.z' }).includes('fromName'), '');
        rec('password: line breaks rejected; blank is allowed (means "keep the stored one")', e({ pass: 'a\r\nb' }).includes('pass') && e({ pass: '' }).length === 0, '');
        const enc = smtp.validateInput({ pass: 'P&amp;ss&#x27;w&quot;&lt;rd&gt;&amp;lt;', user: 'bookings&#x27;@x.com' });
        rec('a password arrives entity-encoded once by deepEscapeBody and is decoded exactly once (a literal "&lt;" survives)', enc.clean.pass === 'P&ss\'w"<rd>&lt;', JSON.stringify(enc.clean));
        const w = smtp.validateInput({ host: 'smtp.office365.com', user: 'bookings@thabisomhlongo.com', from: 'other@thabisomhlongo.com' });
        rec('Microsoft 365 with a From that is not the signed-in mailbox produces a Send As warning (not an error)', w.warnings.some(x => /Send As/.test(x)) && Object.keys(w.errors).length === 0, JSON.stringify(w));
        const prev = process.env.NODE_ENV; process.env.NODE_ENV = 'production';
        const prod = { host: e({ host: 'localhost' }), ip: e({ host: '169.254.169.254' }), p: e({ port: '8025' }), ok: e({ host: 'smtp.office365.com', port: '587' }) };
        process.env.NODE_ENV = prev;
        rec('production: loopback / link-local / private hosts and non-mail ports cannot be probed from the server', prod.host.includes('host') && prod.ip.includes('host') && prod.p.includes('port') && prod.ok.length === 0, JSON.stringify(prod));
    }

    // ── 11. error classification + redaction ──────────────────────────────────────────────────────────────────
    {
        const cfg = { host: 'smtp.office365.com', port: 587, user: 'bookings@thabisomhlongo.com', pass: 'TopSecret123' };
        const c = (err) => smtp.classifySmtpError(err, cfg);
        const basic = c({ code: 'EAUTH', responseCode: 550, response: '550 5.7.30 Basic authentication is not supported for Client Submission' });
        rec('5.7.30 -> tenant has switched off basic auth: says OAuth / re-enable', basic.category === 'auth' && basic.systemic && /OAuth/.test(basic.message), basic.message);
        rec('5.7.57 -> Authenticated SMTP disabled for the mailbox', c({ code: 'EAUTH', responseCode: 530, response: '530 5.7.57 Client not authenticated to send mail' }).message.includes('5.7.57'), '');
        const g573 = c({ code: 'EAUTH', responseCode: 535, response: '535 5.7.3 Authentication unsuccessful [JN3P275CA0028.ZAFP275.PROD.OUTLOOK.COM 2026-10-12T18:17:25.085Z 08DF270FBB6A194B]' });
        rec('535 5.7.3 (Microsoft\'s generic refusal, seen live) lists the real candidate causes and points at the Entra sign-in log', g573.category === 'auth' && g573.systemic && /Entra/.test(g573.message) && /MFA/.test(g573.message) && /Authenticated SMTP/.test(g573.message) && !/5\.7\.30/.test(g573.message), g573.message);
        rec('generic 535 -> wrong username/password', /username or password/.test(c({ code: 'EAUTH', responseCode: 535, response: '535 Bad credentials' }).message), '');
        rec('5.7.60 -> sender not permitted (Send As)', c({ responseCode: 550, response: '550 5.7.60 SMTP; Client does not have permissions to send as this sender' }).category === 'sender', '');
        rec('timeout / DNS / refused -> retryable connection errors with the right hint', c({ code: 'ETIMEDOUT' }).retryable && /could not be found/.test(c({ code: 'ENOTFOUND' }).message) && /refused/.test(c({ code: 'ECONNREFUSED' }).message), '');
        rec('4xx -> temporary (retryable); 550 5.1.1 -> recipient (permanent)', c({ responseCode: 451, response: '451 4.7.0 Try again' }).category === 'temporary' && c({ responseCode: 550, response: '550 5.1.1 User unknown' }).category === 'recipient', '');
        rec('certificate errors -> tls', c({ message: 'self-signed certificate' }).category === 'tls' && c({ code: 'ETLS', message: 'x' }).category === 'tls', '');
        const leak = c({ code: 'EAUTH', message: 'login TopSecret123 failed; AUTH PLAIN ' + Buffer.from('\0bookings@thabisomhlongo.com\0TopSecret123').toString('base64') + ' ' + Buffer.from('TopSecret123').toString('base64') });
        rec('the password (plain, base64, and as an AUTH PLAIN token) is redacted from error text', !leak.message.includes('TopSecret123') && !leak.message.includes(Buffer.from('TopSecret123').toString('base64')) && !/AUTH PLAIN [A-Za-z0-9+/=]{8,}/.test(leak.message), leak.message);
    }

    // ── 13. Microsoft 365 OAuth (client credentials + SASL XOAUTH2) ───────────────────────────────────────────────
    {
        const { startFakeTokenServer } = require('./fake-smtp');
        const TENANT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', CLIENT = '11111111-2222-3333-4444-555555555555', MAILBOX = 'bookings@test.invalid';
        const tok = await startFakeTokenServer({ plain: true, tlsMaterial, tenant: TENANT, clientId: CLIENT, secret: OAUTH_SECRET });
        const f = await startFakeSmtp({ tlsMaterial, user: 'nobody', pass: 'nobody', oauthUser: MAILBOX, acceptToken: (t) => tok.issued.has(t) });
        const useOauth = (over = {}) => {
            SMTP_VARS.forEach(k => delete process.env[k]);
            Object.assign(process.env, {
                SMTP_HOST: '127.0.0.1', SMTP_PORT: String(f.port), SMTP_SECURE: 'starttls', SMTP_USER: MAILBOX, SMTP_FROM: MAILBOX, SMTP_FROM_NAME: 'Thabiso Mhlongo',
                SMTP_AUTH: 'oauth', SMTP_OAUTH_TENANT_ID: TENANT, SMTP_OAUTH_CLIENT_ID: CLIENT, SMTP_OAUTH_CLIENT_SECRET: OAUTH_SECRET, SMTP_OAUTH_AUTHORITY: tok.url,
                SMTP_PASS: PASS1                         // a mailbox password is present too - OAuth mode must never send it
            }, over);
            emailService.resetTransport();
        };

        useOauth();
        const r1 = await emailService.sendEmailDirectly(mailTo('qa@test.invalid', { trigger_event: 'Test: oauth' }));
        const s1 = f.sessions.find(x => x.data) || {};
        rec('OAuth: a message goes out through the same transport, signed in with SASL XOAUTH2 over STARTTLS', r1.success === true && s1.authMethod === 'XOAUTH2' && s1.authOk === true && s1.tlsActive === true, JSON.stringify({ r1, m: s1.authMethod, ok: s1.authOk, tls: s1.tlsActive }));
        rec('...the token presented to Exchange is one the (fake) Microsoft issued, for the mailbox, and the mailbox password was never sent', f.sessions.every(s => s.authMethod !== 'PASSWORD') && tok.issued.has(s1.oauthToken) && s1.oauthUser === MAILBOX, JSON.stringify({ methods: f.sessions.map(s => s.authMethod), user: s1.oauthUser }));
        const q1 = tok.requests[0] || {};
        rec('...the token request is Microsoft\'s documented client-credentials call (tenant path, grant, Exchange scope, right app, right secret)', tok.requests.length === 1 && q1.method === 'POST' && q1.path === '/' + TENANT + '/oauth2/v2.0/token' && q1.grant_type === 'client_credentials' && q1.scope === 'https://outlook.office365.com/.default' && q1.client_id === CLIENT && q1.secretOk === true && /x-www-form-urlencoded/.test(q1.contentType), JSON.stringify(q1));
        rec('...envelope sender and From header are the mailbox', s1.mailFrom === MAILBOX && /^From: .*<bookings@test\.invalid>/m.test(s1.data || ''), s1.mailFrom);
        await sleep(250);
        const l1 = (await q(db, "SELECT status, smtp_response FROM email_logs WHERE trigger_event = 'Test: oauth' ORDER BY id DESC LIMIT 1"))[0] || {};
        rec('...and email_logs records success with the server reply', l1.status === 'success' && /Queued mail for delivery/.test(l1.smtp_response || ''), JSON.stringify(l1));

        const r2 = await emailService.sendEmailDirectly(mailTo('qa2@test.invalid', { trigger_event: 'Test: oauth2' }));
        rec('OAuth: the token is cached - a second email does not ask Microsoft again', r2.success === true && tok.requests.length === 1, 'token requests=' + tok.requests.length);

        const v = await emailService.verifySmtp();
        rec('OAuth: Test Connection forces a fresh token, signs in, and says it used OAuth (no mailbox password)', v.ok === true && v.authMethod === 'oauth' && /OAuth/.test(v.message) && /no mailbox password/.test(v.message) && tok.requests.length === 2, JSON.stringify({ v, n: tok.requests.length }));
        rec('...and sends no message', f.sessions.filter(s => s.data).length === 2, '');

        // wrong secret / app / tenant: classified from Microsoft's own AADSTS text, nothing reaches SMTP, nothing leaks
        const authAttempts = () => f.sessions.reduce((n, s) => n + s.authAttempts, 0);
        const before = authAttempts();
        useOauth({ SMTP_OAUTH_CLIENT_SECRET: 'Wrong~secret.VALUE_123' });
        const rs = await emailService.sendEmailDirectly(mailTo('qa@test.invalid', { trigger_event: 'Test: oauth-badsecret' }));
        rec('OAuth: a wrong client secret is classified as such (AADSTS7000215), tells the admin to use the secret VALUE, and is systemic', rs.success === false && rs.category === 'oauth' && rs.systemic === true && /AADSTS7000215/.test(rs.error) && /secret VALUE/.test(rs.error), JSON.stringify(rs));
        rec('...neither the wrong secret nor the real one appears in the message, and SMTP was never contacted', !rs.error.includes('Wrong~secret.VALUE_123') && !rs.error.includes(OAUTH_SECRET) && authAttempts() === before, rs.error);
        const vs = await emailService.verifySmtp();
        rec('...Test Connection reports it at the "token" stage', vs.ok === false && vs.stage === 'token', JSON.stringify(vs));
        useOauth({ SMTP_OAUTH_CLIENT_ID: '99999999-2222-3333-4444-555555555555' });
        const rc = await emailService.sendEmailDirectly(mailTo('qa@test.invalid', { trigger_event: 'Test: oauth-badclient' }));
        rec('OAuth: an unknown Application (client) ID is classified (AADSTS700016) and points at the IDs', rc.category === 'oauth' && /AADSTS700016/.test(rc.error) && /Application \(client\) ID/.test(rc.error), rc.error);
        useOauth({ SMTP_OAUTH_TENANT_ID: '00000000-0000-0000-0000-000000000000' });
        const rt = await emailService.sendEmailDirectly(mailTo('qa@test.invalid', { trigger_event: 'Test: oauth-badtenant' }));
        rec('OAuth: an unknown tenant is classified (AADSTS90002) and points at Entra ID > Overview', rt.category === 'oauth' && /AADSTS90002/.test(rt.error) && /Overview/.test(rt.error), rt.error);

        // Exchange refuses the token (the app is not registered in Exchange / lacks FullAccess on the mailbox)
        const fRefuse = await startFakeSmtp({ tlsMaterial, user: 'nobody', pass: 'nobody', oauthUser: MAILBOX, acceptToken: () => false });
        useOauth({ SMTP_PORT: String(fRefuse.port) });
        const rr = await emailService.sendEmailDirectly(mailTo('qa@test.invalid', { trigger_event: 'Test: oauth-refused' }));
        rec('OAuth: when Exchange refuses a valid token (535 5.7.3) the message lists the Exchange setup steps that are usually missing', rr.success === false && rr.category === 'auth' && rr.systemic === true && /New-ServicePrincipal/.test(rr.error) && /ENTERPRISE/.test(rr.error) && /FullAccess/.test(rr.error) && /SMTP\.SendAsApp/.test(rr.error), JSON.stringify(rr));
        rec('...and the token itself is never in the message', !/eyJ[A-Za-z0-9_-]{8,}\./.test(rr.error), rr.error);
        await fRefuse.close();

        // token endpoint unreachable -> transient connection problem, not systemic
        const deadTok = await startFakeTokenServer({ plain: true, tlsMaterial, tenant: TENANT, clientId: CLIENT, secret: OAUTH_SECRET }); const deadUrl = deadTok.url; await deadTok.close();
        useOauth({ SMTP_OAUTH_AUTHORITY: deadUrl });
        const ru = await emailService.sendEmailDirectly(mailTo('qa@test.invalid', { trigger_event: 'Test: oauth-unreachable' }));
        rec('OAuth: an unreachable Microsoft sign-in service is a retryable connection problem (not systemic)', ru.success === false && ru.category === 'connection' && ru.retryable === true && ru.systemic === false && /sign-in service/.test(ru.error), JSON.stringify(ru));

        // settings table: encrypted secret, picked up on the next email, never copied to process.env
        const save = (k, val) => new Promise((res, rej) => upsertSetting(k, val, e => e ? rej(e) : res()));
        SMTP_VARS.forEach(k => delete process.env[k]);
        process.env.SMTP_OAUTH_AUTHORITY = tok.url;            // test-only server env, not an SMTP setting
        await save('smtp_host', '127.0.0.1'); await save('smtp_port', String(f.port)); await save('smtp_secure', 'starttls'); await save('smtp_user', MAILBOX);
        await save('smtp_from', MAILBOX); await save('smtp_auth', 'oauth'); await save('smtp_oauth_tenant', TENANT); await save('smtp_oauth_client', CLIENT);
        await save('smtp_oauth_secret', smtp.encryptSecret(OAUTH_SECRET));
        emailService.resetTransport();
        const rd = await emailService.sendEmailDirectly(mailTo('qa@test.invalid', { trigger_event: 'Test: oauth-db' }));
        rec('OAuth settings saved in the admin table are used on the next email', rd.success === true && f.sessions.some(s => s.authMethod === 'XOAUTH2' && s.oauthToken && s.mailFrom === MAILBOX && s.data && /Test|Hello/.test(s.data)), JSON.stringify(rd));
        const rawSecret = (await q(db, "SELECT setting_value AS v FROM settings WHERE setting_key = 'smtp_oauth_secret'"))[0].v;
        rec('...the client secret is AES-encrypted at rest and decrypts back exactly', rawSecret.startsWith('enc:v1:') && !rawSecret.includes(OAUTH_SECRET) && smtp.decryptSecret(rawSecret) === OAUTH_SECRET, rawSecret.slice(0, 12));
        const dcfg = await smtp.resolveSmtpConfig();
        const pv = JSON.stringify(smtp.publicView(dcfg.config));
        rec('...the public view reports only that a secret is set (and where from), never the secret', dcfg.ok === true && dcfg.config.auth === 'oauth' && /"secretSet":true/.test(pv) && !pv.includes(OAUTH_SECRET) && !('SMTP_OAUTH_CLIENT_SECRET' in process.env), pv);
        await run(db, "DELETE FROM settings WHERE setting_key LIKE 'smtp\\_%' ESCAPE '\\'");
        delete process.env.SMTP_OAUTH_AUTHORITY;

        // incomplete OAuth config says what is missing (strict form check)
        const inc = await smtp.resolveSmtpConfig({ auth: 'oauth', host: 'smtp.office365.com', user: MAILBOX });
        rec('OAuth: an incomplete configuration lists exactly what is missing', inc.ok === false && inc.problems.includes('Microsoft tenant ID is not set') && inc.problems.includes('Microsoft application (client) ID is not set') && inc.problems.includes('Microsoft client secret is not set') && !inc.problems.includes('SMTP password is not set'), JSON.stringify(inc.problems));

        // validation + classification + redaction units
        const ve = (raw) => smtp.validateInput(raw);
        rec('OAuth validation: sign-in method, tenant (GUID or domain), client ID (GUID), secret (no spaces) and mailbox-style user', Object.keys(ve({ auth: 'basic' }).errors).includes('auth')
            && Object.keys(ve({ oauthTenant: 'not a tenant!' }).errors).includes('oauthTenant') && Object.keys(ve({ oauthTenant: 'contoso.onmicrosoft.com' }).errors).length === 0 && Object.keys(ve({ oauthTenant: TENANT }).errors).length === 0
            && Object.keys(ve({ oauthClient: 'abc' }).errors).includes('oauthClient') && Object.keys(ve({ oauthClient: CLIENT }).errors).length === 0
            && Object.keys(ve({ oauthSecret: 'has space' }).errors).includes('oauthSecret') && Object.keys(ve({ oauthSecret: OAUTH_SECRET }).errors).length === 0
            && Object.keys(ve({ auth: 'oauth', user: 'not-an-email' }).errors).includes('user'), '');
        rec('OAuth validation: pasting the Secret ID (a GUID) instead of the secret VALUE produces a warning', ve({ oauthSecret: CLIENT }).warnings.some(w => /secret ID/.test(w)), JSON.stringify(ve({ oauthSecret: CLIENT })));
        const cfgO = { host: 'smtp.office365.com', port: 587, auth: 'oauth', oauth: { tenant: TENANT, clientId: CLIENT, secret: 'S3cr3t~value.ABC' } };
        const exp = smtp.classifySmtpError({ code: 'EAUTH', message: '[oauth-token] Microsoft did not issue a token (HTTP 401 invalid_client, AADSTS7000222). The provided client secret keys are expired.', aadsts: 'AADSTS7000222' }, cfgO);
        rec('OAuth: an expired client secret (AADSTS7000222) says so and tells the admin to create a new one', exp.category === 'oauth' && /expired/.test(exp.message) && /new secret/.test(exp.message), exp.message);
        const leak = smtp.classifySmtpError({ code: 'EAUTH', message: 'boom S3cr3t~value.ABC and Bearer eyJhbGciOiJSUzI1NiJ9.eyJhdWQiOiJ4In0.sigsigsig plus eyJhbGciOiJSUzI1NiJ9.eyJhdWQiOiJ5In0.sig2' }, cfgO);
        rec('OAuth: the client secret, "Bearer" tokens and bare JWTs are redacted from error text', !/S3cr3t~value\.ABC/.test(leak.message) && !/eyJhbGci/.test(leak.message) && /redacted/.test(leak.message), leak.message);

        // the token request's own TLS rules (a secret must never go to an endpoint whose certificate is not trusted)
        const oauthLib = require('../lib/smtp-oauth');
        const prevEnv = process.env.NODE_ENV, prevAuth = process.env.SMTP_OAUTH_AUTHORITY;
        process.env.SMTP_OAUTH_AUTHORITY = 'http://127.0.0.1:9';
        const a1 = oauthLib.authority();
        process.env.SMTP_OAUTH_AUTHORITY = 'http://login.microsoftonline.com';
        const a2 = oauthLib.authority();
        process.env.NODE_ENV = 'production'; process.env.SMTP_OAUTH_AUTHORITY = 'http://127.0.0.1:9';
        const a3 = oauthLib.authority();
        process.env.NODE_ENV = prevEnv; process.env.SMTP_OAUTH_AUTHORITY = prevAuth || '';
        if (!prevAuth) delete process.env.SMTP_OAUTH_AUTHORITY;
        rec('OAuth: plain http for the token endpoint is allowed only to a loopback address, never to a real host and never in production', a1 === 'http://127.0.0.1:9' && a2 === 'https://login.microsoftonline.com' && a3 === 'https://login.microsoftonline.com', JSON.stringify([a1, a2, a3]));
        const tokTls = await startFakeTokenServer({ tlsMaterial, tenant: TENANT, clientId: CLIENT, secret: OAUTH_SECRET });
        const intercepted = await new Promise((resolve) => {
            const sock = require('tls').connect({ host: '127.0.0.1', port: tokTls.port, rejectUnauthorized: false }, () => {
                const same = sock.getPeerCertificate().fingerprint256 === new (require('crypto').X509Certificate)(tlsMaterial.cert).fingerprint256;
                sock.end(); resolve(!same);
            });
            sock.on('error', () => resolve(false));
        });
        process.env.SMTP_OAUTH_AUTHORITY = tokTls.url;
        let https1 = null;
        try { https1 = await oauthLib.getAccessToken({ tenant: TENANT, clientId: CLIENT, secret: OAUTH_SECRET }, { forceRenew: true }); } catch (e) { https1 = e; }
        if (intercepted) rec('OAuth: the token request over https to a certificate trusted via NODE_EXTRA_CA_CERTS succeeds (SKIPPED here: security software on this machine re-signs loopback TLS)', true, '');
        else rec('OAuth: the token request over https succeeds when the endpoint certificate is trusted, and the secret was sent only after the handshake', !(https1 instanceof Error) && !!https1.token && tokTls.requests.length === 1 && tokTls.requests[0].secretOk === true, https1 && https1.message);
        delete process.env.SMTP_OAUTH_AUTHORITY;
        await tokTls.close();

        await f.close(); await tok.close();
        clearEnv(); emailService.resetTransport();
    }

    // ── 12. queue worker: systemic fault pauses without burning retries; transient faults keep the 3-try rule; no duplicates ──
    {
        const pend = async (to) => { await emailService.sendEmail({ to, subject: 'Queue test', htmlContent: '<p>queued</p>', preWrapped: true, trigger_event: 'Test: queue' }); };
        const rows = () => q(db, "SELECT * FROM notifications WHERE subject = 'Queue test' ORDER BY id");
        const f = await startFakeSmtp({ user: 'bookings@test.invalid', pass: 'server-wants-another', tlsMaterial });
        useEnv(f.port);
        emailService.resetTransport();
        await pend('one@test.invalid'); await pend('two@test.invalid');
        await processNotificationQueue();
        let r = await rows();
        rec('wrong credentials: both queued emails stay pending, no retry burned, reason recorded', r.length === 2 && r.every(x => x.status === 'pending' && (x.retry_count || 0) === 0) && !!r[0].error_message, JSON.stringify(r.map(x => [x.status, x.retry_count, x.error_message])));
        rec('...the worker stopped after the first failure (one login attempt, not one per email) and the queue is paused', f.sessions.reduce((n, s) => n + s.authAttempts, 0) === 1 && emailService.isSendingPaused() === true, JSON.stringify({ attempts: f.sessions.map(s => s.authAttempts), paused: emailService.isSendingPaused() }));
        const before = f.sessions.length;
        await processNotificationQueue();
        rec('...and while paused later sweeps do not contact the server at all', f.sessions.length === before, '');
        await f.close();

        const g = await startFakeSmtp({ user: 'bookings@test.invalid', pass: PASS1, tlsMaterial });
        useEnv(g.port);
        emailService.resetTransport();                    // what saving fixed settings does
        rec('saving settings resumes a paused queue immediately', emailService.isSendingPaused() === false, '');
        await processNotificationQueue();
        r = await rows();
        const delivered = g.sessions.filter(s => s.data).map(s => s.rcpt[0]).sort();
        rec('after the fix both emails are delivered exactly once and marked sent', r.every(x => x.status === 'sent') && delivered.join() === 'one@test.invalid,two@test.invalid', JSON.stringify({ st: r.map(x => x.status), delivered }));
        await processNotificationQueue(); await processNotificationQueue();
        rec('further sweeps never re-send a sent email (no duplicates)', g.sessions.filter(s => s.data).length === 2, '');
        await g.close();

        // transient failure keeps the existing 3-attempt rule
        const dead = await startFakeSmtp({ tlsMaterial }); const deadPort = dead.port; await dead.close();
        useEnv(deadPort); emailService.resetTransport();
        await run(db, "DELETE FROM notifications WHERE subject = 'Queue test'");
        await pend('three@test.invalid');
        await processNotificationQueue();
        r = await rows();
        rec('an unreachable server burns one retry per sweep and keeps the email pending (transient)', r[0].status === 'pending' && r[0].retry_count === 1, JSON.stringify(r[0]));
        await processNotificationQueue(); await processNotificationQueue();
        r = await rows();
        rec('...and the email is marked failed after the third attempt (existing rule preserved)', r[0].status === 'failed' && r[0].retry_count === 3, JSON.stringify(r[0]));
        await sleep(250);
        const logs = await q(db, "SELECT status FROM email_logs WHERE recipient_email = 'three@test.invalid'");
        rec('every attempt is in email_logs as failed - none as success', logs.length === 3 && logs.every(l => l.status === 'failed'), JSON.stringify(logs));

        // rows stuck behind a systemic fault give up after 24h
        await run(db, "INSERT INTO notifications (type, channel, status, recipient_email, subject, body, error_message, created_at) VALUES ('email','email','pending','old@test.invalid','Queue test old','{}','auth failed','2000-01-01 00:00:00')");
        await processNotificationQueue();
        const old = (await q(db, "SELECT status FROM notifications WHERE subject = 'Queue test old'"))[0];
        rec('an email that has waited 24h behind a mail-server fault is expired rather than sent late', old.status === 'failed', JSON.stringify(old));
    }

    // ── 14. attachments survive the queue ────────────────────────────────────────────────────────────────────────
    {
        const fs = require('fs'), os = require('os'), pathMod = require('path');
        const qa = require('../lib/queued-attachments');
        const f = await startFakeSmtp({ user: 'bookings@test.invalid', pass: PASS1, tlsMaterial });
        useEnv(f.port); emailService.resetTransport();
        await run(db, 'DELETE FROM notifications'); await run(db, 'DELETE FROM notification_attachments');
        const blobCount = async () => (await q(db, 'SELECT COUNT(*) n FROM notification_attachments'))[0].n;
        const queue = (to, subject, attachments, extra = {}) => emailService.sendEmail(Object.assign({ to, subject, htmlContent: '<p>x</p>', preWrapped: true, trigger_event: 'Test: att', attachments }, extra));
        const pdfBytes = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from(Array.from({ length: 256 }, (_, i) => i)), Buffer.from('\n%%EOF')]);   // every byte value 0-255
        const icsText = 'BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nSUMMARY:Show\r\nEND:VCALENDAR\r\n';
        const diskFile = pathMod.join(os.tmpdir(), 'qa-disk-' + process.pid + '.txt'); fs.writeFileSync(diskFile, 'bytes on disk');

        const rq = await queue('att1@test.invalid', 'Att test', [
            { filename: 'Contract_7_Thabiso_Mhlongo.pdf', content: pdfBytes, contentType: 'application/pdf' },
            { filename: 'Booking_7.ics', content: Buffer.from(icsText), contentType: 'text/calendar; method=REQUEST' },
            { filename: 'Notes from me.txt', content: 'plain string content' },
            { filename: 'Nice Name.txt', path: diskFile }
        ]);
        const queued = (await q(db, "SELECT id, attachment_paths FROM notifications WHERE subject = 'Att test'"))[0] || {};
        rec('queueing keeps every attachment (the old queue stored NULL for the in-memory ones)', rq.success === true && !!queued.attachment_paths && JSON.parse(queued.attachment_paths).length === 4, JSON.stringify(rq) + ' ' + queued.attachment_paths);
        rec('...the queue row holds hashes and names, not the file bytes', !queued.attachment_paths.includes('JVBERi') && (await blobCount()) === 3 && /"filename":"Contract_7_Thabiso_Mhlongo.pdf"/.test(queued.attachment_paths), queued.attachment_paths);
        await processNotificationQueue();
        const sess = f.sessions.find(s => s.data && s.rcpt[0] === 'att1@test.invalid') || {};
        const atts = parseAttachments(sess.data || '');
        const by = (n) => atts.find(a => a.filename === n) || {};
        const summary = JSON.stringify(atts.map(a => [a.filename, a.type.slice(0, 30), a.bytes && a.bytes.length]));
        rec('the PDF arrives with its filename, content type and EXACT bytes (all 256 byte values)', !!by('Contract_7_Thabiso_Mhlongo.pdf').bytes && by('Contract_7_Thabiso_Mhlongo.pdf').bytes.equals(pdfBytes) && /application\/pdf/.test(by('Contract_7_Thabiso_Mhlongo.pdf').type), summary);
        rec('the .ics invite arrives as text/calendar (method=REQUEST) with its content intact', !!by('Booking_7.ics').bytes && by('Booking_7.ics').bytes.toString().trim() === icsText.trim() && /text\/calendar/.test(by('Booking_7.ics').type) && /REQUEST/.test(by('Booking_7.ics').type), summary);
        rec('string content and a file on disk arrive too, under their given display names', !!by('Notes from me.txt').bytes && by('Notes from me.txt').bytes.toString().trim() === 'plain string content' && !!by('Nice Name.txt').bytes && by('Nice Name.txt').bytes.toString().trim() === 'bytes on disk', summary);
        await sleep(400);
        const done = (await q(db, "SELECT status FROM notifications WHERE subject = 'Att test'"))[0];
        rec('after delivery the email is marked sent and its stored bytes are deleted', done.status === 'sent' && (await blobCount()) === 0, JSON.stringify({ s: done.status, blobs: await blobCount() }));

        // one file, three recipients (a newsletter): stored once, kept until the LAST sibling is done
        const shared = Buffer.from('newsletter flyer ' + 'x'.repeat(8000));
        for (const n of [1, 2]) await queue('news' + n + '@test.invalid', 'Dedupe test', [{ filename: 'Flyer.pdf', content: shared, contentType: 'application/pdf' }], { trigger_event: 'Test: dedupe' });
        rec('the same file queued for two recipients is stored ONCE', (await blobCount()) === 1, 'blobs=' + (await blobCount()));
        const sib = await q(db, "SELECT id, attachment_paths FROM notifications WHERE subject = 'Dedupe test' ORDER BY id");
        const d1 = await qa.release(sib[0].attachment_paths, sib[0].id);
        rec('release() keeps the bytes while a sibling email is still pending...', d1 === 0 && (await blobCount()) === 1, 'deleted=' + d1);
        await run(db, "UPDATE notifications SET status = 'sent' WHERE id = ?", [sib[1].id]);
        const d2 = await qa.release(sib[0].attachment_paths, sib[0].id);
        rec('...and deletes them once no pending email needs them', d2 === 1 && (await blobCount()) === 0, 'deleted=' + d2);
        await run(db, "DELETE FROM notifications WHERE subject = 'Dedupe test'");

        // a transient failure keeps the bytes until the email finally gives up
        const dead = await startFakeSmtp({ tlsMaterial }); const deadPort = dead.port; await dead.close();
        useEnv(deadPort); emailService.resetTransport();
        await queue('retry@test.invalid', 'Retry att', [{ filename: 'R.pdf', content: Buffer.from('retry bytes'), contentType: 'application/pdf' }]);
        await processNotificationQueue();
        await sleep(300);
        const r1 = (await q(db, "SELECT status, retry_count FROM notifications WHERE subject = 'Retry att'"))[0];
        rec('a transient failure keeps the stored bytes (the retry still needs them)', r1.status === 'pending' && r1.retry_count === 1 && (await blobCount()) === 1, JSON.stringify(r1));
        await processNotificationQueue(); await processNotificationQueue(); await sleep(400);
        const r3 = (await q(db, "SELECT status FROM notifications WHERE subject = 'Retry att'"))[0];
        rec('...and releases them only when the email is finally marked failed', r3.status === 'failed' && (await blobCount()) === 0, JSON.stringify({ r3, blobs: await blobCount() }));

        // missing bytes: fail loudly, never send without the attachment
        const f2 = await startFakeSmtp({ user: 'bookings@test.invalid', pass: PASS1, tlsMaterial });
        useEnv(f2.port); emailService.resetTransport();
        await queue('lost@test.invalid', 'Lost att', [{ filename: 'Lost.pdf', content: Buffer.from('gone soon'), contentType: 'application/pdf' }]);
        await run(db, 'DELETE FROM notification_attachments');
        await processNotificationQueue(); await sleep(300);
        const lost = (await q(db, "SELECT status, error_message FROM notifications WHERE subject = 'Lost att'"))[0];
        rec('an email whose stored attachment is gone is FAILED with a clear reason - never sent without its attachment', lost.status === 'failed' && /^ATTACHMENT_ERROR/.test(lost.error_message) && /Lost\.pdf/.test(lost.error_message) && !f2.sessions.some(s => s.data && s.rcpt[0] === 'lost@test.invalid'), JSON.stringify(lost));

        // limits and unsupported shapes are reported as "not queued"
        const big = await queue('big@test.invalid', 'Too big', [{ filename: 'Big.bin', content: Buffer.alloc(qa.MAX_TOTAL_BYTES + 1) }]);
        const nBig = (await q(db, "SELECT COUNT(*) n FROM notifications WHERE subject = 'Too big'"))[0].n;
        rec('attachments over the size limit make sendEmail report failure and queue nothing', big.success === false && /larger than/.test(big.error) && nBig === 0, JSON.stringify(big));
        const odd = await queue('odd@test.invalid', 'Odd att', [{ filename: 'x.pdf', href: 'http://example.invalid/x.pdf' }]);
        rec('an unsupported attachment shape is reported, not silently dropped', odd.success === false && /unsupported attachment/.test(odd.error), JSON.stringify(odd));

        // orphan sweep
        await run(db, "INSERT INTO notification_attachments (sha256, size, data, created_at) VALUES ('" + 'a'.repeat(64) + "', 1, x'00', '2000-01-01 00:00:00')");
        await run(db, "INSERT INTO notification_attachments (sha256, size, data, created_at) VALUES ('" + 'b'.repeat(64) + "', 1, x'00', '2000-01-01 00:00:00')");
        await run(db, "INSERT INTO notification_attachments (sha256, size, data) VALUES ('" + 'c'.repeat(64) + "', 1, x'00')");
        await run(db, "INSERT INTO notifications (type, channel, status, recipient_email, subject, body, attachment_paths, scheduled_at) VALUES ('email','email','pending','sched@test.invalid','Scheduled att','{}', ?, datetime('now','+7 days'))", [JSON.stringify([{ filename: 'S.pdf', blob: 'b'.repeat(64) }])]);
        const swept = await qa.sweepOrphans();
        const left = (await q(db, 'SELECT sha256 FROM notification_attachments')).map(r => r.sha256[0]).sort().join('');
        rec('the hourly sweep deletes old bytes nothing references, and keeps referenced ones and brand-new ones', swept === 1 && left === 'bc', JSON.stringify({ swept, left }));

        // rows queued by the previous build (a plain JSON array of path strings) still send
        await run(db, 'DELETE FROM notification_attachments');
        await run(db, "INSERT INTO notifications (type, channel, status, recipient_email, subject, body, attachment_paths) VALUES ('email','email','pending','legacy@test.invalid','Legacy att', ?, ?)",
            [JSON.stringify({ htmlContent: '<p>x</p>', preWrapped: true, trigger_event: 'Test: legacy' }), JSON.stringify([diskFile])]);
        await processNotificationQueue(); await sleep(300);
        const lg = parseAttachments((f2.sessions.find(s => s.data && s.rcpt[0] === 'legacy@test.invalid') || {}).data || '');
        rec('a row queued by the previous build (plain path string) is still delivered with its file', lg.length === 1 && lg[0].bytes.toString().trim() === 'bytes on disk', JSON.stringify(lg.map(a => [a.filename, a.bytes.length])));

        try { fs.unlinkSync(diskFile); } catch (e) { /* temp file */ }
        await f.close(); await f2.close();
        clearEnv(); emailService.resetTransport();
    }
}

main().then(() => process.exit(0)).catch((e) => { console.log('CHECK:' + JSON.stringify({ name: 'child crashed', pass: false, detail: String(e && e.stack || e).slice(0, 600) })); process.exit(1); });
