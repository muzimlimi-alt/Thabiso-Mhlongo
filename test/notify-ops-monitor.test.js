// Notification Centre Phase 2 internals: the operations monitor (overdue invoices, milestones, upcoming events, sales closing), ticket-sales
// alerts (orders, low stock, sold out), door check-ins and the calendar / mailbox failure hooks with fake Microsoft answers. The REAL modules run in a
// child process (test/notify-ops-monitor.child.js) against a throwaway DB - they open the database, so they must not run in the runner process.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function runChild(script) {
    const tmpDb = path.join(os.tmpdir(), `notify-ops-child-${process.pid}-${Date.now()}.sqlite`);
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
    const out = await runChild('notify-ops-monitor.child.js');
    const checks = out.split('\n').filter((l) => l.startsWith('CHECK:')).map((l) => JSON.parse(l.slice(6)));
    check('the operations-monitor scenarios ran to the end', checks.length >= 22 && !checks.some((c) => c.name === 'child crashed'), out.slice(-1800));
    for (const c of checks) check(c.name, c.pass, c.detail);
};
