// Customer replies from the booking mailbox into Inquiries (Phase 5): lib/inbox-sync.js + the administrator controls.
//   A. the engine, in a child process with a throwaway DB against a fake Microsoft sign-in + Graph server (test/inbox-sync.child.js):
//      matching, ignoring, de-duplication, checkpoints, paging, back-off, a lost checkpoint, a tampered checkpoint, a different mailbox,
//      configuration from the saved Email (SMTP) settings, mock mode;
//   B. the HTTP controls on the running (SMTP_MOCK) server: administrator-only, verify-before-enable, nothing about the checkpoint exposed.
// Nothing here talks to Microsoft.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function runChild() {
    const tmpDb = path.join(os.tmpdir(), `sync-child-${process.pid}-${Date.now()}.sqlite`);
    const env = {
        ...process.env, DB_PATH: tmpDb, NODE_ENV: 'test', R2_ENDPOINT: '', R2_BUCKET: '', R2_ACCESS_KEY_ID: '', R2_SECRET_ACCESS_KEY: '',
        GOOGLE_REFRESH_TOKEN: 'test-mode-invalid-refresh-token', SMTP_MOCK: 'true', EMAIL_OVERHAUL_ENABLED: '', SETTINGS_ENCRYPTION_KEY: 'test-only-settings-encryption-key'
    };
    ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'SMTP_AUTH', 'EMAIL_USER', 'EMAIL_PASS'].forEach((k) => delete env[k]);
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [path.join(__dirname, 'inbox-sync.child.js')], { cwd: ROOT, env });
        let out = '';
        child.stdout.on('data', (d) => { out += d; });
        child.stderr.on('data', (d) => { out += d; });
        const timer = setTimeout(() => child.kill(), 240000);
        child.on('close', () => {
            clearTimeout(timer);
            for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + suffix); } catch (e) {} }
            resolve(out);
        });
    });
}

module.exports = async function ({ check, pub, api, loginAs, q, one }) {
    // ══════════ A. the engine ══════════
    const out = await runChild();
    const checks = out.split('\n').filter((l) => l.startsWith('CHECK:')).map((l) => JSON.parse(l.slice(6)));
    check('the sync scenarios ran to the end', checks.length >= 30 && !checks.some((c) => c.name === 'child crashed'), out.slice(-1500));
    for (const c of checks) check(c.name, c.pass, c.detail);

    // ══════════ B. HTTP controls ══════════
    const asManager = await loginAs('manager');
    const asAssistant = await loginAs('assistant');
    const urls = [['GET', '/api/admin/inbox-sync'], ['PUT', '/api/admin/inbox-sync'], ['POST', '/api/admin/inbox-sync/run']];
    for (const [method, url] of urls) {
        const body = method === 'GET' ? undefined : { enabled: true };
        check(`${method} ${url}: unauthenticated -> 401, assistant -> 403, manager -> 403`,
            (await pub(method, url, body)).status === 401 && (await asAssistant(method, url, body)).status === 403 && (await asManager(method, url, body)).status === 403, '');
    }
    const status = await api('GET', '/api/admin/inbox-sync');
    check('the administrator sees the status: off by default, no checkpoint, no secrets', status.status === 200 && status.body.success && status.body.enabled === false && status.body.hasCheckpoint === false && !/delta|token|secret/i.test(JSON.stringify(status.body).replace(/hasCheckpoint|lastSuccessAt/g, '')), JSON.stringify(status.body));
    check('PUT needs a real boolean', (await api('PUT', '/api/admin/inbox-sync', { enabled: 'yes' })).status === 400 && (await api('PUT', '/api/admin/inbox-sync', {})).status === 400, '');
    const enable = await api('PUT', '/api/admin/inbox-sync', { enabled: true });
    check('switching ON is verify-before-enable: with no working Microsoft sign-in (mock mode) it is refused with 422 and the failed step, and nothing changes', enable.status === 422 && enable.body.success === false && /NOT switched on/.test(enable.body.message) && Array.isArray(enable.body.steps) && enable.body.steps.some((s) => !s.ok) && (await one('SELECT enabled FROM inbox_sync_state WHERE id = 1')).enabled === 0, JSON.stringify(enable.body));
    const run = await api('POST', '/api/admin/inbox-sync/run', {});
    check('"Sync now" while switched off -> 409 with the reason', run.status === 409 && /switched off/.test(run.body.message), JSON.stringify(run.body));
    const off = await api('PUT', '/api/admin/inbox-sync', { enabled: false });
    check('switching OFF always works', off.status === 200 && off.body.enabled === false, JSON.stringify(off.body));
    const audit = await one(`SELECT COUNT(*) AS n FROM audit_log WHERE table_name = 'inbox_sync_state'`);
    check('the change to the switch is audited with who did it', audit.n >= 1, JSON.stringify(audit));

    // the generic settings API cannot be used to reach the sync state (it lives in its own table)
    const generic = await api('GET', '/api/admin/settings');
    check('the generic settings API exposes nothing of the sync (own table, administrator-only routes)', generic.status === 200 && !Object.keys(generic.body.settings || {}).some((k) => /inbox|delta/i.test(k)), Object.keys(generic.body.settings || {}).join());
};
