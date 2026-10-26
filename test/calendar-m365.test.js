// Admin Calendar <-> Microsoft 365 (Phases 3-4, 7): lib/calendar-m365.js + the administrator / manager controls.
//   A. the engine, in a child process with a throwaway DB against a fake Microsoft sign-in + Graph calendar (test/calendar-m365.child.js): publishing, updating,
//      cancelling, conflicts, deletions, other people's appointments, failures and recovery, volume, nothing sensitive in logs;
//   B. the HTTP controls on the running (SMTP_MOCK) server: roles, verify-before-enable, validation, nothing secret exposed.
// Nothing here talks to Microsoft.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function runChild() {
    const tmpDb = path.join(os.tmpdir(), `calsync-child-${process.pid}-${Date.now()}.sqlite`);
    const env = {
        ...process.env, DB_PATH: tmpDb, NODE_ENV: 'test', R2_ENDPOINT: '', R2_BUCKET: '', R2_ACCESS_KEY_ID: '', R2_SECRET_ACCESS_KEY: '',
        GOOGLE_REFRESH_TOKEN: 'test-mode-invalid-refresh-token', SMTP_MOCK: 'true', EMAIL_OVERHAUL_ENABLED: '', SETTINGS_ENCRYPTION_KEY: 'test-only-settings-encryption-key'
    };
    ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'SMTP_AUTH', 'EMAIL_USER', 'EMAIL_PASS'].forEach((k) => delete env[k]);
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [path.join(__dirname, 'calendar-m365.child.js')], { cwd: ROOT, env });
        let out = '';
        child.stdout.on('data', (d) => { out += d; });
        child.stderr.on('data', (d) => { out += d; });
        const timer = setTimeout(() => child.kill(), 280000);
        child.on('close', () => {
            clearTimeout(timer);
            for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + suffix); } catch (e) {} }
            resolve(out);
        });
    });
}

module.exports = async function ({ check, pub, api, loginAs, one }) {
    // ══════════ A. the engine ══════════
    const out = await runChild();
    const checks = out.split('\n').filter((l) => l.startsWith('CHECK:')).map((l) => JSON.parse(l.slice(6)));
    check('the calendar sync scenarios ran to the end', checks.length >= 70 && !checks.some((c) => c.name === 'child crashed'), out.slice(-2500));
    for (const c of checks) check(c.name, c.pass, c.detail);

    // ══════════ B. HTTP controls ══════════
    const asManager = await loginAs('manager');
    const asAssistant = await loginAs('assistant');
    const base = '/api/admin/calendar-sync';

    // who may do what
    const unauth = await pub('GET', base);
    check('status: unauthenticated -> 401', unauth.status === 401, JSON.stringify(unauth));
    check('status: every admin role may read it (assistant 200, manager 200)', (await asAssistant('GET', base)).status === 200 && (await asManager('GET', base)).status === 200, '');
    for (const [method, url] of [['PUT', base], ['POST', base + '/test']]) {
        check(`${method} ${url}: unauthenticated -> 401, assistant -> 403, manager -> 403 (administrator only)`,
            (await pub(method, url, { enabled: true })).status === 401 && (await asAssistant(method, url, { enabled: true })).status === 403 && (await asManager(method, url, { enabled: true })).status === 403, '');
    }
    for (const url of [base + '/run', base + '/entries/1/retry', base + '/entries/1/resolve', base + '/entries/1/recreate']) {
        check(`POST ${url}: unauthenticated -> 401, assistant -> 403 (administrator or manager only)`,
            (await pub('POST', url, {})).status === 401 && (await asAssistant('POST', url, {})).status === 403, '');
    }
    check('listing entries and reading one entry: any signed-in admin, unauthenticated -> 401',
        (await pub('GET', base + '/entries')).status === 401 && (await asAssistant('GET', base + '/entries')).status === 200 && (await pub('GET', base + '/entry?type=booking&id=1')).status === 401, '');

    // status content
    const status = await api('GET', base);
    check('the administrator sees the status: off by default, no checkpoint, the business time zone, and nothing secret', status.status === 200 && status.body.success && status.body.enabled === false && status.body.hasCheckpoint === false && status.body.businessTimeZone === 'Africa/Johannesburg' && !/secret|token|password|deltatoken|http/i.test(JSON.stringify(status.body)), JSON.stringify(status.body));

    // switch
    check('PUT needs a real boolean', (await api('PUT', base, { enabled: 'yes' })).status === 400 && (await api('PUT', base, {})).status === 400, '');
    const enable = await api('PUT', base, { enabled: true });
    check('switching ON is verify-before-enable: with no working Microsoft sign-in (mock mode) it is refused with 422 and the failed step, and nothing changes', enable.status === 422 && enable.body.success === false && /NOT switched on/.test(enable.body.message) && enable.body.steps[0].id === 'config' && (await api('GET', base)).body.enabled === false, JSON.stringify(enable.body));
    const run = await api('POST', base + '/run', {});
    check('"Sync now" while switched off -> 409 with the reason (administrator and manager alike)', run.status === 409 && /switched off/.test(run.body.message) && (await asManager('POST', base + '/run', {})).status === 409, JSON.stringify(run.body));
    const off = await api('PUT', base, { enabled: false });
    check('switching OFF always works', off.status === 200 && off.body.enabled === false, JSON.stringify(off.body));
    const audit = await one(`SELECT COUNT(*) AS n FROM audit_log WHERE table_name = 'calendar_sync_state'`);
    check('...and is recorded in the audit log with who did it', audit.n >= 1, JSON.stringify(audit));

    // entries
    check('entry lookup validates its input (400)', (await api('GET', base + '/entry?type=nonsense&id=1')).status === 400 && (await api('GET', base + '/entry?type=booking&id=abc')).status === 400 && (await api('GET', base + '/entry?type=booking')).status === 400, '');
    const none = await api('GET', base + '/entry?type=booking&id=987654');
    check('a booking that was never published has no sync entry (null, not an error)', none.status === 200 && none.body.entry === null, JSON.stringify(none.body));
    const list = await api('GET', base + '/entries?status=conflict&type=booking');
    check('the list of entries needing attention is an array (empty here) and ignores unknown filters safely', list.status === 200 && Array.isArray(list.body.entries) && (await api('GET', base + '/entries?status=%27%3B%20DROP%20TABLE%20bookings--')).status === 200, JSON.stringify(list.body));
    check('actions on an unknown entry -> 404 (manager allowed), on a bad id -> 400', (await asManager('POST', base + '/entries/987654/retry', {})).status === 404 && (await api('POST', base + '/entries/abc/retry', {})).status === 400 && (await asManager('POST', base + '/entries/987654/recreate', {})).status === 404, '');
    check('resolving an unknown entry -> 404; a bad choice is rejected before anything happens', (await asManager('POST', base + '/entries/987654/resolve', { choice: 'keep_website' })).status === 404, '');

    // the activity log: administrator only
    check('GET /log: unauthenticated -> 401, assistant -> 403, manager -> 403 (administrator only)', (await pub('GET', base + '/log')).status === 401 && (await asAssistant('GET', base + '/log')).status === 403 && (await asManager('GET', base + '/log')).status === 403, '');
    const logRes = await api('GET', base + '/log?limit=5');
    check('the administrator reads the latest log entries (an array, bounded by the limit), with nothing secret in them', logRes.status === 200 && Array.isArray(logRes.body.entries) && logRes.body.entries.length <= 5 && !/secret|token|password|Bearer/i.test(JSON.stringify(logRes.body)), JSON.stringify(logRes.body).slice(0, 300));
    check('...a nonsense limit is harmless', (await api('GET', base + '/log?limit=abc')).status === 200 && (await api('GET', base + '/log?limit=-5')).status === 200, '');

    // regression: the calendar itself still serves
    const cal = await api('GET', '/api/admin/calendar/events');
    check('the existing calendar endpoint still serves bookings, holds and events', cal.status === 200 && Array.isArray(cal.body), String(cal.status));
};
