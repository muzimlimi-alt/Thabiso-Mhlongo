// The notification engine (lib/notify.js + lib/notify-events.js): recording, grouping, escalation, reopen/resolve, per-event rules, the master
// switch, the e-mail channel (primary + backup recipients, thresholds) and the secret sanitiser. The REAL engine runs in a child process
// (test/notify-engine.child.js) against a throwaway DB - it opens the database, so it must not run in the runner process. Nothing is sent.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function runChild(script) {
    const tmpDb = path.join(os.tmpdir(), `notify-engine-child-${process.pid}-${Date.now()}.sqlite`);
    const env = {
        ...process.env, DB_PATH: tmpDb, NODE_ENV: 'test', R2_ENDPOINT: '', R2_BUCKET: '', R2_ACCESS_KEY_ID: '', R2_SECRET_ACCESS_KEY: '',
        GOOGLE_REFRESH_TOKEN: 'test-mode-invalid-refresh-token', SMTP_MOCK: 'true', EMAIL_OVERHAUL_ENABLED: '', SETTINGS_ENCRYPTION_KEY: 'test-only-settings-encryption-key'
    };
    ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'SMTP_AUTH', 'EMAIL_USER', 'EMAIL_PASS', 'NOTIFICATION_EMAIL'].forEach((k) => delete env[k]);
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [path.join(__dirname, script)], { cwd: ROOT, env });
        let out = '';
        child.stdout.on('data', (d) => { out += d; });
        child.stderr.on('data', (d) => { out += d; });
        const timer = setTimeout(() => child.kill(), 120000);
        child.on('close', () => {
            clearTimeout(timer);
            for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + suffix); } catch (e) {} }
            resolve(out);
        });
    });
}

module.exports = async function ({ check }) {
    const out = await runChild('notify-engine.child.js');
    const checks = out.split('\n').filter((l) => l.startsWith('CHECK:')).map((l) => JSON.parse(l.slice(6)));
    check('the notification-engine scenarios ran to the end', checks.length >= 25 && !checks.some((c) => c.name === 'child crashed'), out.slice(-1800));
    for (const c of checks) check(c.name, c.pass, c.detail);
};
