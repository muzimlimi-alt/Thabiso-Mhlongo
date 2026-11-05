// Run by notify-jobs.test.js in its OWN process (it opens the database): the REAL job monitor (lib/job-monitor.js) and the notification retention
// (lib/data-retention-caretaker.js pruneNotificationData) against a throwaway DB. Prints one "CHECK:{...}" line per assertion.
const rec = (name, pass, detail) => console.log('CHECK:' + JSON.stringify({ name, pass: !!pass, detail: pass ? '' : String(detail === undefined ? '' : detail).slice(0, 700) }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    const db = require('../database');
    const q = (sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => e ? rej(e) : res(r)));
    const one = async (sql, p = []) => (await q(sql, p))[0];
    const run = (sql, p = []) => new Promise((res, rej) => db.run(sql, p, function (e) { e ? rej(e) : res(this); }));
    for (let i = 0; i < 240; i++) {
        const m = await q('SELECT 1 AS x FROM schema_migrations WHERE version IN (106, 119)').catch(() => []);
        if (m.length === 2) break;
        await sleep(250);
    }
    await sleep(500);

    const jm = require('../lib/job-monitor');
    const incidents = (job) => q("SELECT * FROM admin_notifications WHERE event_type = 'system.job_failed' AND entity_id = ?", [job]);

    // ── a wrapped job: success, failure, repeat failure, recovery ─────────────────────────────────────────────────────────────────────
    let mode = 'ok';
    const run1 = jm.monitored('test-job', 'Test job', 60 * 60 * 1000, async () => { if (mode === 'fail') throw new Error('database is locked token=abc123SECRET'); return 'done'; });
    const out = await run1();
    let hb = await one("SELECT * FROM job_heartbeats WHERE job_name = 'test-job'");
    rec('a successful run returns its result and stamps the heartbeat', out === 'done' && hb && hb.last_run_at && hb.last_success_at && hb.consecutive_failures === 0 && hb.expected_interval_s === 3600, JSON.stringify(hb));

    mode = 'fail';
    let threw = false;
    try { await run1(); } catch (e) { threw = /database is locked/.test(e.message); }
    rec('a failing run still throws to the caller (existing logging unchanged)', threw);
    hb = await one("SELECT * FROM job_heartbeats WHERE job_name = 'test-job'");
    rec('the failure is counted and the error kept - without the secret', hb.consecutive_failures === 1 && /database is locked/.test(hb.last_error) && !/abc123SECRET/.test(hb.last_error), JSON.stringify(hb));
    let inc = await incidents('test-job');
    rec('a failure raises ONE system.job_failed incident (open, high, links to system health)', inc.length === 1 && inc[0].status === 'open' && inc[0].priority === 'high' && /secPanelIntegrity/.test(inc[0].link_json), JSON.stringify(inc));
    for (let i = 0; i < 4; i++) { try { await run1(); } catch (e) { /* expected */ } }
    inc = await incidents('test-job');
    rec('5 failures in a row are still ONE incident, count 5, escalated to critical', inc.length === 1 && inc[0].occurrence_count === 5 && inc[0].priority === 'critical', JSON.stringify(inc.map((r) => [r.occurrence_count, r.priority])));
    rec('the incident text says how many times in a row', /5 times in a row/.test(inc[0].body) || inc[0].occurrence_count === 5, inc[0].body);

    mode = 'ok';
    await run1();
    inc = await incidents('test-job');
    hb = await one("SELECT * FROM job_heartbeats WHERE job_name = 'test-job'");
    rec('the next success resolves the incident automatically and resets the counter', inc[0].status === 'resolved' && inc[0].resolved_auto === 1 && hb.consecutive_failures === 0, JSON.stringify([inc[0].status, inc[0].resolved_auto, hb.consecutive_failures]));
    mode = 'fail';
    try { await run1(); } catch (e) { /* expected */ }
    inc = await incidents('test-job');
    rec('failing again REOPENS the same incident (no duplicate)', inc.length === 1 && inc[0].status === 'open', JSON.stringify(inc.map((r) => [r.id, r.status])));
    mode = 'ok';
    await run1();

    // ── the watchdog: a job that has stopped running ───────────────────────────────────────────────────────────────────────────────
    jm.register('stopped-job', 'Stopped job', 60 * 1000);
    await sleep(300);
    const old = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    await run("UPDATE job_heartbeats SET last_run_at = ?, started_at = ? WHERE job_name = 'stopped-job'", [old, old]);
    const raised = await jm.checkMissed();
    const missed = await q("SELECT * FROM admin_notifications WHERE event_type = 'system.job_missed' AND entity_id = 'stopped-job'");
    rec('a job silent for far longer than twice its interval raises "has stopped running" (action required)', raised >= 1 && missed.length === 1 && missed[0].kind === 'action' && missed[0].status === 'open', JSON.stringify(missed));
    rec('...naming how long ago it last ran', /ago/.test(missed[0].body), missed[0].body);
    await jm.checkMissed();
    const missed2 = await q("SELECT * FROM admin_notifications WHERE event_type = 'system.job_missed' AND entity_id = 'stopped-job'");
    rec('the watchdog running again does not repeat the alert', missed2.length === 1 && missed2[0].occurrence_count === 1, JSON.stringify(missed2.map((r) => r.occurrence_count)));
    rec('a healthy job is not flagged', (await q("SELECT * FROM admin_notifications WHERE event_type = 'system.job_missed' AND entity_id = 'test-job'")).length === 0);
    await jm.beat('stopped-job', 'Stopped job', 60 * 1000);
    const back = await one("SELECT status FROM admin_notifications WHERE event_type = 'system.job_missed' AND entity_id = 'stopped-job'");
    rec('when the job runs again the alert resolves itself', back.status === 'resolved', back.status);
    const h = await jm.health();
    rec('the health snapshot reports each job with a status', h.jobs.some((j) => j.name === 'test-job' && j.status === 'ok') && h.jobs.some((j) => j.name === 'stopped-job'), JSON.stringify(h.jobs));
    await run("UPDATE job_heartbeats SET last_run_at = ?, started_at = ?, consecutive_failures = 0 WHERE job_name = 'stopped-job'", [old, old]);
    rec('a stale job shows as stale in the health snapshot', (await jm.health()).jobs.find((j) => j.name === 'stopped-job').status === 'stale');

    // ── compliance expiry (lib/compliance-monitor.js) ──────────────────────────────────────────────────────────────────────────────
    await run("INSERT INTO settings (setting_key, setting_value) VALUES ('notification_email', 'owner@example.invalid') ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value");
    require('../lib/notify').invalidateCaches();
    const cm = require('../lib/compliance-monitor');
    const bpRow = await one('SELECT id FROM business_profile WHERE id = 1');
    rec('the business profile row exists to watch', !!bpRow);
    const DAY = 86400000;
    const T0 = Date.parse(cm.todaySast() + 'T10:00:00Z');
    const plusDays = (n) => new Date(T0 + n * DAY).toISOString().slice(0, 10);
    const exp1 = plusDays(30);
    await run('UPDATE business_profile SET bbbee_expiry_date = ?, bbbee_certificate_number = ? WHERE id = 1', [exp1, 'CERT-123']);
    const xrows = () => q(`SELECT * FROM admin_notifications WHERE event_type = 'compliance.expiring' AND entity_id = 'bbbee' ORDER BY id`);
    const xmails = async () => (await q(`SELECT o.id FROM notifications o JOIN admin_notifications n ON o.related_entity = 'admin_notification' AND o.related_id = n.id WHERE n.event_type = 'compliance.expiring'`)).length;
    await cm.runComplianceCheck(T0);
    let xr = await xrows();
    rec('30 days before expiry: one Attention incident, "expires in 30 day(s)", linking to the Business Profile', xr.length === 1 && /30 day/.test(xr[0].title) && xr[0].kind === 'attention' && /businessAdmin/.test(xr[0].link_json), JSON.stringify(xr.map((r) => r.title)));
    rec('...and one reminder e-mail', (await xmails()) === 1, await xmails());
    await cm.runComplianceCheck(T0 + 3600000);
    await cm.runComplianceCheck(T0 + 2 * DAY);
    xr = await xrows();
    rec('running again the same day or two days later sends NOTHING more (same stage) but keeps the day count current', (await xmails()) === 1 && xr.length === 1 && /28 day/.test(xr[0].title), JSON.stringify([await xmails(), xr.map((r) => r.title)]));
    await cm.runComplianceCheck(T0 + 16 * DAY);
    xr = await xrows();
    rec('reaching the 14-day stage e-mails again and refreshes the SAME incident', (await xmails()) === 2 && xr.length === 1 && /14 day/.test(xr[0].title), JSON.stringify([await xmails(), xr.map((r) => r.title)]));
    await cm.runComplianceCheck(T0 + 31 * DAY);
    xr = await xrows();
    rec('the day after expiry: "EXPIRED", e-mailed, still one incident', (await xmails()) === 3 && xr.length === 1 && /EXPIRED/.test(xr[0].title), JSON.stringify([await xmails(), xr.map((r) => r.title)]));
    await cm.runComplianceCheck(T0 + 39 * DAY);
    rec('a week after expiry it reminds again (weekly until renewed)', (await xmails()) === 4, await xmails());
    await run('UPDATE business_profile SET bbbee_expiry_date = ? WHERE id = 1', [plusDays(400)]);
    await cm.runComplianceCheck(T0 + 40 * DAY);
    xr = await xrows();
    rec('recording a renewed expiry date resolves the alert automatically, with a note', xr.length === 1 && xr[0].status === 'resolved' && xr[0].resolved_auto === 1 && /new expiry date/i.test(xr[0].resolution_note || ''), JSON.stringify(xr.map((r) => [r.status, r.resolution_note])));
    const exp2 = plusDays(20);
    await run('UPDATE business_profile SET bbbee_expiry_date = ? WHERE id = 1', [exp2]);
    await cm.runComplianceCheck(T0);
    let open2 = await q(`SELECT * FROM admin_notifications WHERE event_type = 'compliance.expiring' AND status = 'open'`);
    rec('a new date inside the window starts a fresh incident', open2.length === 1 && open2[0].dedupe_key.indexOf(exp2) >= 0, JSON.stringify(open2.map((r) => r.dedupe_key)));
    await run(`UPDATE admin_notifications SET status = 'resolved', resolved_at = ?, resolution_note = 'renewal submitted' WHERE id = ?`, [new Date().toISOString(), open2[0].id]);
    const mailsBefore = await xmails();
    await cm.runComplianceCheck(T0 + DAY);
    open2 = await q(`SELECT * FROM admin_notifications WHERE event_type = 'compliance.expiring' AND status = 'open'`);
    rec('an alert the owner resolved is NOT recreated or re-sent before the next stage', open2.length === 0 && (await xmails()) === mailsBefore, JSON.stringify([open2.length, mailsBefore, await xmails()]));
    await cm.runComplianceCheck(T0 + 7 * DAY);
    open2 = await q(`SELECT * FROM admin_notifications WHERE event_type = 'compliance.expiring' AND status = 'open'`);
    rec('...but the next stage (14 days) brings it back, e-mailed', open2.length === 1 && (await xmails()) === mailsBefore + 1, JSON.stringify([open2.length, await xmails()]));
    rec('stage maths: 91 days = none, 90 = d90, 1 = d7, 0 = d0, -8 = expired week 1', cm.stageFor(91) === null && cm.stageFor(90) === 'd90' && cm.stageFor(1) === 'd7' && cm.stageFor(0) === 'd0' && cm.stageFor(-8) === 'expired-w1');

    // ── retention ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
    const ins = (status, priority, kind, when) => run(
        `INSERT INTO admin_notifications (dedupe_key, event_type, category, priority, kind, title, status, first_seen_at, last_seen_at, resolved_at)
         VALUES (?, 'system.client_error', 'system', ?, ?, 'retention test', ?, ?, ?, ?)`, ['ret|' + Math.random(), priority, kind, status, when, when, status === 'resolved' ? when : null]).then((r) => r.lastID);
    const yearsAgo = new Date(Date.now() - 400 * 86400000).toISOString();
    const monthsAgo = new Date(Date.now() - 120 * 86400000).toISOString();
    const recent = new Date(Date.now() - 5 * 86400000).toISOString();
    const oldResolved = await ins('resolved', 'high', 'attention', yearsAgo);
    const oldOpenAction = await ins('open', 'critical', 'action', yearsAgo);
    const infoResolved = await ins('resolved', 'info', 'attention', monthsAgo);
    const highResolved4m = await ins('resolved', 'high', 'attention', monthsAgo);
    const recentResolved = await ins('resolved', 'info', 'attention', recent);
    await run("INSERT INTO activity_log (occurred_at, event_type, category, summary) VALUES (?, 'system.client_error', 'system', 'old activity')", [yearsAgo]);
    await run("INSERT INTO activity_log (occurred_at, event_type, category, summary) VALUES (?, 'system.client_error', 'system', 'recent activity')", [recent]);
    const { pruneNotificationData } = require('../lib/data-retention-caretaker');
    await pruneNotificationData();
    const exists = async (id) => !!(await one('SELECT id FROM admin_notifications WHERE id = ?', [id]));
    rec('a resolved incident older than 12 months is deleted', !(await exists(oldResolved)));
    rec('an UNRESOLVED action item is never deleted, whatever its age', await exists(oldOpenAction));
    rec('a resolved info-priority item older than 90 days is deleted', !(await exists(infoResolved)));
    rec('a resolved high-priority item of 4 months is kept (12-month rule)', await exists(highResolved4m));
    rec('recent resolved items are kept', await exists(recentResolved));
    const acts = (await q("SELECT summary FROM activity_log WHERE summary IN ('old activity','recent activity')")).map((r) => r.summary);
    rec('the Activity Log keeps 13 months', acts.includes('recent activity') && !acts.includes('old activity'), JSON.stringify(acts));

    process.exit(0);
})().catch((e) => { console.log('CHECK:' + JSON.stringify({ name: 'child crashed', pass: false, detail: String(e && e.stack || e).slice(0, 700) })); process.exit(0); });
