// A manual adjustment (credit / debit) changes what a client OWES - it is not money received. The nightly ledger check
// (lib/ledger-reconciliation-job.js) compares each booking's recorded amount_paid with its transactions; it summed every completed
// transaction, adjustments included, so an adjustment was flagged as a payment discrepancy and could even hide a real shortfall.
// The REAL query runs in a child process (test/ledger-adjustments.child.js) against a throwaway DB - it opens the database, so it must
// not run in the runner process. Nothing is sent anywhere.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function runChild() {
    const tmpDb = path.join(os.tmpdir(), `ledger-adjustments-child-${process.pid}-${Date.now()}.sqlite`);
    const env = {
        ...process.env, DB_PATH: tmpDb, NODE_ENV: 'test', R2_ENDPOINT: '', R2_BUCKET: '', R2_ACCESS_KEY_ID: '', R2_SECRET_ACCESS_KEY: '',
        GOOGLE_REFRESH_TOKEN: 'test-mode-invalid-refresh-token', SMTP_MOCK: 'true', EMAIL_OVERHAUL_ENABLED: '', SETTINGS_ENCRYPTION_KEY: 'test-only-settings-encryption-key'
    };
    ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'SMTP_AUTH', 'EMAIL_USER', 'EMAIL_PASS'].forEach((k) => delete env[k]);
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [path.join(__dirname, 'ledger-adjustments.child.js')], { cwd: ROOT, env });
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
    const out = await runChild();
    const checks = out.split('\n').filter((l) => l.startsWith('CHECK:')).map((l) => JSON.parse(l.slice(6)));
    check('the nightly ledger-check scenarios ran to the end', checks.length >= 7 && !checks.some((c) => c.name === 'child crashed'), out.slice(-1500));
    for (const c of checks) check(c.name, c.pass, c.detail);
};
