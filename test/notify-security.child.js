// Run by notify-security.test.js in its OWN process (it opens the database): the failed sign-in rule (lib/security-alerts.js) against a throwaway DB -
// one or two failures are only logged; the third within 15 minutes raises ONE "repeated failed sign-ins" alert that escalates; another account is
// a separate alert; old failures do not count. Also the login limiter's lockout handler (middleware/rate-limiters.js). Prints "CHECK:{...}" lines.
const rec = (name, pass, detail) => console.log('CHECK:' + JSON.stringify({ name, pass: !!pass, detail: pass ? '' : String(detail === undefined ? '' : detail).slice(0, 700) }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    const db = require('../database');
    const q = (sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => e ? rej(e) : res(r)));
    const run = (sql, p = []) => new Promise((res, rej) => db.run(sql, p, function (e) { e ? rej(e) : res(this); }));
    for (let i = 0; i < 240; i++) {
        const m = await q('SELECT 1 AS x FROM schema_migrations WHERE version IN (106, 120)').catch(() => []);
        if (m.length === 2) break;
        await sleep(250);
    }
    await sleep(500);
    const { recordFailedLogin } = require('../lib/security-alerts');
    const req = { ip: '203.0.113.7' };
    const alerts = (acct) => q(`SELECT * FROM admin_notifications WHERE event_type = 'security.login_failed_repeated' AND entity_id = ?`, [acct]);

    await recordFailedLogin(req, 'Owner@Example.invalid', 'wrong password');
    await recordFailedLogin(req, 'owner@example.invalid', 'wrong password');
    rec('two failures are logged but raise no alert (typos happen)', (await alerts('owner@example.invalid')).length === 0 && (await q(`SELECT id FROM activity_log WHERE event_type = 'security.login_failed' AND entity_id = 'owner@example.invalid'`)).length === 2);
    await recordFailedLogin(req, 'owner@example.invalid', 'wrong password');
    let a = await alerts('owner@example.invalid');
    rec('the third within 15 minutes raises ONE "repeated failed sign-ins" alert (high, mandatory) naming the address it came from', a.length === 1 && a[0].priority === 'high' && a[0].mandatory === 1 && /3 failed attempts/.test(a[0].body) && /203\.0\.113\.7/.test(a[0].body), JSON.stringify(a));
    for (let i = 0; i < 3; i++) await recordFailedLogin(req, 'owner@example.invalid', 'wrong password');
    a = await alerts('owner@example.invalid');
    rec('continuing attempts stay one alert and escalate to critical', a.length === 1 && a[0].priority === 'critical' && a[0].occurrence_count === 4, JSON.stringify(a.map((x) => [x.priority, x.occurrence_count])));
    await recordFailedLogin(req, 'other@example.invalid', 'unknown account');
    rec('a different account is counted separately', (await alerts('other@example.invalid')).length === 0);
    await run(`UPDATE activity_log SET occurred_at = ? WHERE entity_id = 'stale@example.invalid'`, [new Date(Date.now() - 60 * 60000).toISOString()]);
    for (let i = 0; i < 2; i++) await recordFailedLogin(req, 'stale@example.invalid', 'wrong password');
    await run(`UPDATE activity_log SET occurred_at = ? WHERE event_type = 'security.login_failed' AND entity_id = 'stale@example.invalid'`, [new Date(Date.now() - 60 * 60000).toISOString()]);
    await recordFailedLogin(req, 'stale@example.invalid', 'wrong password');
    rec('failures older than 15 minutes do not count towards the rule', (await alerts('stale@example.invalid')).length === 0);

    // the lockout handler, through a real (throwaway) Express app with the REAL limiter in front of a login that always refuses
    const express = require('express');
    const { adminLoginRateLimiter } = require('../middleware/rate-limiters');
    const app = express();
    app.use(express.json());
    app.post('/login', adminLoginRateLimiter, (r, res) => res.status(401).json({ success: false }));
    const server = await new Promise((resolve) => { const sv = app.listen(0, '127.0.0.1', () => resolve(sv)); });
    const url = `http://127.0.0.1:${server.address().port}/login`;
    let status = null, body = null;
    for (let i = 0; i < 6; i++) {
        const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'attacker@example.invalid', password: 'x' }) });
        status = r.status; body = await r.json().catch(() => null);
    }
    server.close();
    await sleep(400);
    const lock = await q(`SELECT * FROM admin_notifications WHERE event_type = 'security.login_locked'`);
    rec('hitting the sign-in limit returns 429 AND raises "sign-in temporarily blocked" for that address', status === 429 && lock.length === 1 && /attacker@example\.invalid/.test(lock[0].body), JSON.stringify([status, body, lock]));
    process.exit(0);
})().catch((e) => { console.log('CHECK:' + JSON.stringify({ name: 'child crashed', pass: false, detail: String(e && e.stack || e).slice(0, 700) })); process.exit(0); });
