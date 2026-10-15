// E-mail transport + SMTP settings (Microsoft 365 hardening). Three layers:
//   A. the REAL js/emailService.js, lib/smtp-config.js and the notification-queue worker, in a child process, against a fake
//      SMTP server that speaks STARTTLS/AUTH (test/smtp-transport.child.js) - twice: once trusting the fake server's
//      certificate, once not, to prove the certificate is genuinely verified;
//   B. the admin HTTP API on the running (SMTP_MOCK) test server: roles, masking, atomic validation, Send Test, Test Connection;
//   C. a source scan: one nodemailer transport, no stray hard-coded senders.
// Nothing here talks to a real mail server. The child's passwords are scanned for in everything it prints.
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3');
const { makeSelfSignedCert } = require('./fake-smtp');
const support = require('./support');

const ROOT = path.join(__dirname, '..');
const KEY = 'test-only-settings-encryption-key';             // also given to the test server by support.js
const PASS1 = 'Env&Pass"w<o>rd\'/\\1x';
const PASS_DB = 'Db&Pass"w<o>rd\'/\\2y';
const LEGACY = 'LEGACY-SENTINEL-PASSWORD';
const OAUTH_SECRET = 'Qx8~Zr3.fakeClientSecret_VALUE-7';

function runChild(mode, certFile, keyFile) {
    const tmpDb = path.join(os.tmpdir(), `smtp-child-${process.pid}-${Date.now()}-${mode}.sqlite`);
    const env = {
        ...process.env, DB_PATH: tmpDb, NODE_ENV: 'test', R2_ENDPOINT: '', R2_BUCKET: '', R2_ACCESS_KEY_ID: '', R2_SECRET_ACCESS_KEY: '',
        GOOGLE_REFRESH_TOKEN: 'test-mode-invalid-refresh-token', SMTP_MOCK: 'false', EMAIL_OVERHAUL_ENABLED: '', SETTINGS_ENCRYPTION_KEY: KEY,
        MODE: mode, FAKE_TLS_CERT: certFile, FAKE_TLS_KEY: keyFile, T_PASS1: PASS1, T_PASSDB: PASS_DB, T_LEGACY: LEGACY, T_OAUTHSECRET: OAUTH_SECRET
    };
    if (mode === 'trusted') env.NODE_EXTRA_CA_CERTS = certFile; else delete env.NODE_EXTRA_CA_CERTS;
    const r = spawnSync(process.execPath, [path.join(__dirname, 'smtp-transport.child.js')], { cwd: ROOT, env, encoding: 'utf8', timeout: 180000 });
    for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + suffix); } catch (e) {} }
    return r;
}

const writeDb = (sql, params = []) => new Promise((resolve, reject) => {
    const db = new sqlite3.Database(support.TEST_DB);
    db.run(sql, params, (e) => db.close(() => e ? reject(e) : resolve()));
});

// Decrypts a stored value with the REAL lib/smtp-config in a throwaway child (the runner never opens the database itself).
function decryptsTo(cipher, expected) {
    const rt = spawnSync(process.execPath, ['-e', "console.log('RT:' + String(require('./lib/smtp-config').decryptSecret(process.env.T_CIPHER) === process.env.T_EXPECT))"], {
        cwd: ROOT, encoding: 'utf8', timeout: 60000,
        env: { ...process.env, DB_PATH: path.join(os.tmpdir(), 'smtp-rt-' + process.pid + '-' + Date.now() + '.sqlite'), SETTINGS_ENCRYPTION_KEY: KEY, T_CIPHER: cipher, T_EXPECT: expected, NODE_ENV: 'test' }
    });
    return /^RT:true$/m.test(rt.stdout || '');
}

module.exports = async function ({ check, api, pub, loginAs, q, one, sleep }) {
    // ══════════ A. transport against a fake SMTP server ══════════
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smtp-test-'));
    const { cert, key } = makeSelfSignedCert();
    const certFile = path.join(dir, 'cert.pem'), keyFile = path.join(dir, 'key.pem');
    fs.writeFileSync(certFile, cert); fs.writeFileSync(keyFile, key);

    const outputs = [];
    for (const mode of ['trusted', 'untrusted']) {
        const r = runChild(mode, certFile, keyFile);
        outputs.push(r.stdout || '', r.stderr || '');
        const lines = (r.stdout || '').split('\n').filter(l => l.startsWith('CHECK:'));
        check(`transport child (${mode}) ran and reported checks`, lines.length > 0 && r.status === 0, `exit ${r.status}; ${(r.stderr || '').slice(-400)} ${(r.stdout || '').slice(-300)}`);
        for (const l of lines) { const c = JSON.parse(l.slice(6)); check(c.name, c.pass, c.detail); }
    }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
    const printed = outputs.join('\n');
    check('no password (env, database or legacy) appears anywhere the transport process printed', ![PASS1, PASS_DB, LEGACY, OAUTH_SECRET].some(s => printed.includes(s)), 'a secret leaked into stdout/stderr');

    // ══════════ B. admin API (server runs with SMTP_MOCK=true) ══════════
    const asManager = await loginAs('manager');
    const asAssistant = await loginAs('assistant');
    const SECRET = 'Sp&c"ial\'<pw>/\\9Zq';
    const GOOD = {
        smtp_host: 'smtp.office365.com', smtp_port: '587', smtp_secure: 'starttls', smtp_user: 'bookings@thabisomhlongo.com',
        smtp_from: 'bookings@thabisomhlongo.com', smtp_from_name: 'Thabiso Mhlongo', smtp_pass: SECRET
    };
    const smtpRows = () => q("SELECT setting_key, setting_value FROM settings WHERE setting_key LIKE 'smtp\\_%' ESCAPE '\\'");
    await writeDb("DELETE FROM settings WHERE setting_key LIKE 'smtp\\_%' ESCAPE '\\'");
    const notifBefore = (await one("SELECT setting_value AS v FROM settings WHERE setting_key = 'notification_email'")) || {};

    let g = await api('GET', '/api/admin/settings');
    check('GET /api/admin/settings (administrator) returns a safe smtp view', g.status === 200 && g.body.smtp && typeof g.body.smtp.passwordSet === 'boolean' && !('pass' in g.body.smtp), JSON.stringify(g.body && g.body.smtp));
    check('...and no smtp_* key inside the generic settings map', Object.keys(g.body.settings || {}).every(k => !k.startsWith('smtp_')), Object.keys(g.body.settings || {}).join());
    const gm = await asManager('GET', '/api/admin/settings'), ga = await asAssistant('GET', '/api/admin/settings');
    check('a manager / assistant can still load settings but get NO smtp section', gm.status === 200 && ga.status === 200 && !('smtp' in gm.body) && !('smtp' in ga.body), JSON.stringify([Object.keys(gm.body || {}), Object.keys(ga.body || {})]));

    check('PUT smtp settings as manager -> 403', (await asManager('PUT', '/api/admin/settings', { settings: { smtp_host: 'evil.example.com' } })).status === 403, '');
    check('PUT smtp settings as assistant -> 403', (await asAssistant('PUT', '/api/admin/settings', { settings: { smtp_host: 'evil.example.com' } })).status === 403, '');
    check('PUT smtp settings unauthenticated -> 401', (await pub('PUT', '/api/admin/settings', { settings: { smtp_host: 'evil.example.com' } })).status === 401, '');
    check('...and nothing was written by any of those refusals', (await smtpRows()).length === 0, JSON.stringify(await smtpRows()));

    const bad = await api('PUT', '/api/admin/settings', { settings: { smtp_host: 'smtp.office365.com', smtp_port: '70000', notification_email: 'should-not-save@example.invalid' } });
    const notifAfterBad = (await one("SELECT setting_value AS v FROM settings WHERE setting_key = 'notification_email'")) || {};
    check('an invalid port is rejected with 400 and says which field', bad.status === 400 && /port/i.test(bad.body.message || '') && !!(bad.body.errors && bad.body.errors.port), JSON.stringify(bad.body));
    check('...validation is all-or-nothing: no smtp row and no other setting from that request was saved', (await smtpRows()).length === 0 && notifAfterBad.v === notifBefore.v, JSON.stringify({ rows: await smtpRows(), n: notifAfterBad }));
    check('an unknown smtp_* key is rejected', (await api('PUT', '/api/admin/settings', { settings: { smtp_evil: 'x' } })).status === 400, '');
    check('a display name with a line break (header injection) is rejected', (await api('PUT', '/api/admin/settings', { settings: { ...GOOD, smtp_from_name: 'Thabiso\r\nBcc: spy@example.invalid' } })).status === 400, '');
    check('a partial set that cannot form a working config is refused with what is missing', await (async () => {
        const r = await api('PUT', '/api/admin/settings', { settings: { smtp_host: 'smtp.office365.com', smtp_user: 'bookings@thabisomhlongo.com' } });
        return r.status === 400 && /password/i.test(r.body.message || '');
    })(), '');

    const put = await api('PUT', '/api/admin/settings', { settings: GOOD });
    check('saving a complete, valid Microsoft 365 config succeeds (connection check passes in mock mode)', put.status === 200 && put.body.success === true && put.body.smtp && put.body.smtp.host === 'smtp.office365.com' && put.body.smtp.passwordSet === true, JSON.stringify(put.body));
    check('the response never contains the password', !JSON.stringify(put.body).includes(SECRET), '');
    const rows = Object.fromEntries((await smtpRows()).map(r => [r.setting_key, r.setting_value]));
    check('host / port / encryption / user / sender / name are stored', rows.smtp_host === 'smtp.office365.com' && rows.smtp_port === '587' && rows.smtp_secure === 'starttls' && rows.smtp_user === 'bookings@thabisomhlongo.com' && rows.smtp_from === 'bookings@thabisomhlongo.com' && rows.smtp_from_name === 'Thabiso Mhlongo', JSON.stringify({ ...rows, smtp_pass: '<hidden>' }));
    check('the password is stored encrypted, not as plaintext or its HTML-encoded form', rows.smtp_pass.startsWith('enc:v1:') && !rows.smtp_pass.includes('Sp') && !rows.smtp_pass.includes('&amp;'), rows.smtp_pass.slice(0, 12));
    const rt = spawnSync(process.execPath, ['-e', "console.log('RT:' + String(require('./lib/smtp-config').decryptSecret(process.env.T_CIPHER) === process.env.T_EXPECT))"], {
        cwd: ROOT, encoding: 'utf8', timeout: 60000,
        env: { ...process.env, DB_PATH: path.join(os.tmpdir(), `smtp-rt-${process.pid}-${Date.now()}.sqlite`), SETTINGS_ENCRYPTION_KEY: KEY, T_CIPHER: rows.smtp_pass, T_EXPECT: SECRET, NODE_ENV: 'test' }
    });
    check('what was stored decrypts to exactly the password typed (special characters survive deepEscapeBody)', /^RT:true$/m.test(rt.stdout || ''), `${rt.stdout} ${(rt.stderr || '').slice(-200)}`);

    g = await api('GET', '/api/admin/settings');
    check('reloading the page shows the saved values and only a "password is set" flag', g.body.smtp.host === 'smtp.office365.com' && g.body.smtp.user === 'bookings@thabisomhlongo.com' && g.body.smtp.fromName === 'Thabiso Mhlongo' && g.body.smtp.passwordSet === true && !JSON.stringify(g.body).includes(SECRET) && !JSON.stringify(g.body).includes('enc:v1'), JSON.stringify(g.body.smtp));

    const keep = await api('PUT', '/api/admin/settings', { settings: { smtp_from_name: 'Thabiso M.' } });
    const rows2 = Object.fromEntries((await smtpRows()).map(r => [r.setting_key, r.setting_value]));
    check('editing other fields without a password keeps the stored password untouched', keep.status === 200 && rows2.smtp_pass === rows.smtp_pass && rows2.smtp_from_name === 'Thabiso M.', JSON.stringify(keep.body));

    const mgrOther = await asManager('PUT', '/api/admin/settings', { settings: { notification_email: 'smtp-test@example.invalid' } });
    check('a manager can still save non-SMTP settings (existing behaviour preserved)', mgrOther.status === 200, JSON.stringify(mgrOther.body));

    // Test Connection
    let tc = await api('POST', '/api/admin/settings/smtp/test-connection', {});
    check('Test Connection (administrator) returns a result object with ok + no secrets', tc.status === 200 && tc.body.success === true && tc.body.ok === true && tc.body.result && !JSON.stringify(tc.body).includes(SECRET), JSON.stringify(tc.body));
    check('Test Connection validates unsaved form values', (await api('POST', '/api/admin/settings/smtp/test-connection', { smtp_port: 'abc' })).status === 400, '');
    check('Test Connection is administrator-only', (await asManager('POST', '/api/admin/settings/smtp/test-connection', {})).status === 403 && (await asAssistant('POST', '/api/admin/settings/smtp/test-connection', {})).status === 403 && (await pub('POST', '/api/admin/settings/smtp/test-connection', {})).status === 401, '');

    // Send Test (existing control, repaired)
    const sent = await api('POST', '/api/admin/settings/test-notification', {});
    check('Send Test no longer claims "sent": it reports acceptance by the mail server and says inbox delivery is not proven', sent.status === 200 && sent.body.success === true && /accepted/i.test(sent.body.message) && /not proven|only/i.test(sent.body.message) && !/email sent to/i.test(sent.body.message), JSON.stringify(sent.body));
    await sleep(300);
    const lg = await one("SELECT * FROM email_logs WHERE trigger_event = 'Admin: Test Notification' ORDER BY id DESC LIMIT 1");
    check('...and the attempt is in the existing Email Logs, addressed to the notification inbox, status success', !!lg && lg.status === 'success' && lg.recipient_email === 'smtp-test@example.invalid', JSON.stringify(lg));
    check('Send Test is administrator-only', (await asManager('POST', '/api/admin/settings/test-notification', {})).status === 403 && (await asAssistant('POST', '/api/admin/settings/test-notification', {})).status === 403, '');
    const logsApi = await api('GET', '/api/admin/email-logs?limit=5');
    check('the Email Logs API exposes the server reply column', logsApi.status === 200 && logsApi.body.logs.length > 0 && 'smtp_response' in logsApi.body.logs[0], Object.keys((logsApi.body.logs || [{}])[0]).join());

    const audit = await one("SELECT * FROM audit_log WHERE table_name = 'settings' ORDER BY id DESC LIMIT 1");
    check('changing SMTP settings is audited, and the audit row holds no password', !!audit && !JSON.stringify(audit).includes(SECRET) && !String(audit.new_values).includes('enc:v1'), JSON.stringify(audit));

    // ══════════ Microsoft 365 OAuth settings through the same API ══════════
    const OAUTH = { smtp_auth: 'oauth', smtp_oauth_tenant: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', smtp_oauth_client: '11111111-2222-3333-4444-555555555555', smtp_oauth_secret: OAUTH_SECRET };
    const snapBefore = JSON.stringify(await smtpRows());
    const badO = await api('PUT', '/api/admin/settings', { settings: { ...OAUTH, smtp_oauth_tenant: 'not a tenant!' } });
    const badC = await api('PUT', '/api/admin/settings', { settings: { ...OAUTH, smtp_oauth_client: 'abc' } });
    const badA = await api('PUT', '/api/admin/settings', { settings: { smtp_auth: 'basic' } });
    check('OAuth: an invalid tenant / client ID / sign-in method is rejected with 400, naming the field', badO.status === 400 && !!badO.body.errors.oauthTenant && badC.status === 400 && !!badC.body.errors.oauthClient && badA.status === 400 && !!badA.body.errors.auth, JSON.stringify([badO.body, badC.body, badA.body]));
    check('...and nothing was written (the stored rows are exactly as before)', JSON.stringify(await smtpRows()) === snapBefore, 'stored settings changed');
    check('OAuth: a partial set (no secret) is refused with what is missing', await (async () => {
        const r = await api('PUT', '/api/admin/settings', { settings: { smtp_host: 'smtp.office365.com', smtp_user: 'bookings@thabisomhlongo.com', smtp_auth: 'oauth', smtp_oauth_tenant: OAUTH.smtp_oauth_tenant, smtp_oauth_client: OAUTH.smtp_oauth_client } });
        return r.status === 400 && /client secret/i.test(r.body.message || '') && !/password/i.test(r.body.message || '');
    })(), '');
    check('OAuth settings cannot be changed by a manager', (await asManager('PUT', '/api/admin/settings', { settings: OAUTH })).status === 403, '');

    const putOa = await api('PUT', '/api/admin/settings', { settings: { ...GOOD, ...OAUTH, smtp_pass: '' } });
    check('OAuth: saving a complete OAuth configuration succeeds, and the response never contains the secret', putOa.status === 200 && putOa.body.success === true && putOa.body.smtp.auth === 'oauth' && putOa.body.smtp.secretSet === true && !JSON.stringify(putOa.body).includes(OAUTH_SECRET), JSON.stringify(putOa.body).replace(OAUTH_SECRET, '<secret>'));
    const orows = Object.fromEntries((await smtpRows()).map(r => [r.setting_key, r.setting_value]));
    check('OAuth: method, tenant and application ID are stored; the client secret is AES-encrypted at rest', orows.smtp_auth === 'oauth' && orows.smtp_oauth_tenant === OAUTH.smtp_oauth_tenant && orows.smtp_oauth_client === OAUTH.smtp_oauth_client && orows.smtp_oauth_secret.startsWith('enc:v1:') && !orows.smtp_oauth_secret.includes(OAUTH_SECRET), (orows.smtp_oauth_secret || '').slice(0, 12));
    check('OAuth: the stored client secret decrypts to exactly what was entered', decryptsTo(orows.smtp_oauth_secret, OAUTH_SECRET), '');
    const gOa = await api('GET', '/api/admin/settings');
    check('OAuth: reloading shows the method, tenant and application ID and only "secret is set" - never the secret or its ciphertext', gOa.body.smtp.auth === 'oauth' && gOa.body.smtp.oauthTenant === OAUTH.smtp_oauth_tenant && gOa.body.smtp.oauthClient === OAUTH.smtp_oauth_client && gOa.body.smtp.secretSet === true && !JSON.stringify(gOa.body).includes(OAUTH_SECRET) && !JSON.stringify(gOa.body).includes('enc:v1'), JSON.stringify(gOa.body.smtp));
    const keepO = await api('PUT', '/api/admin/settings', { settings: { smtp_from_name: 'Thabiso M.' } });
    const orows2 = Object.fromEntries((await smtpRows()).map(r => [r.setting_key, r.setting_value]));
    check('OAuth: editing other fields with the secret box blank keeps the stored secret', keepO.status === 200 && orows2.smtp_oauth_secret === orows.smtp_oauth_secret, JSON.stringify(keepO.body));
    const tcO = await api('POST', '/api/admin/settings/smtp/test-connection', { smtp_auth: 'oauth' });
    check('OAuth: Test Connection accepts the OAuth fields and reports a result without secrets', tcO.status === 200 && tcO.body.ok === true && !JSON.stringify(tcO.body).includes(OAUTH_SECRET), JSON.stringify(tcO.body));
    check('OAuth: Test Connection rejects a malformed tenant / client ID', (await api('POST', '/api/admin/settings/smtp/test-connection', { smtp_auth: 'oauth', smtp_oauth_client: 'abc' })).status === 400, '');
    const backP = await api('PUT', '/api/admin/settings', { settings: { smtp_auth: 'password' } });
    check('OAuth: switching back to Password sign-in works and is reported', backP.status === 200 && backP.body.smtp.auth === 'password', JSON.stringify(backP.body.smtp || backP.body));

    // restore the throwaway DB
    await writeDb("DELETE FROM settings WHERE setting_key LIKE 'smtp\\_%' ESCAPE '\\'");
    if (notifBefore.v !== undefined) await writeDb("UPDATE settings SET setting_value = ? WHERE setting_key = 'notification_email'", [notifBefore.v]);

    // ══════════ C. source scan ══════════
    const skip = new Set(['node_modules', '.git', 'test', 'scratch', 'backups', 'docs', 'images', 'fonts', 'css', 'thabiso-mhlongo-runtime-data', '_quarantine', 'email-previews', 'TBC', 'hi']);
    const files = [];
    (function walk(d) {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            if (e.isDirectory()) { if (!skip.has(e.name)) walk(path.join(d, e.name)); }
            else if (e.name.endsWith('.js')) files.push(path.join(d, e.name));
        }
    })(ROOT);
    const hits = (re) => files.filter(f => re.test(fs.readFileSync(f, 'utf8'))).map(f => path.relative(ROOT, f).replace(/\\/g, '/'));
    check('exactly one nodemailer transport exists in the application (js/emailService.js)', JSON.stringify(hits(/createTransport\s*\(/)) === JSON.stringify(['js/emailService.js']), JSON.stringify(hits(/createTransport\s*\(/)));
    check('the legacy EMAIL_USER / EMAIL_PASS variables are read only by lib/smtp-config.js', JSON.stringify(hits(/process\.env\.EMAIL_(USER|PASS)/).filter(f => f !== 'lib/smtp-config.js')) === '[]', JSON.stringify(hits(/process\.env\.EMAIL_(USER|PASS)/)));
    check('no source file hard-codes a personal Gmail address', JSON.stringify(hits(/@gmail\.com/).filter(f => !/^(js\/generate-email-previews)/.test(f))) === '[]', JSON.stringify(hits(/@gmail\.com/)));
};
