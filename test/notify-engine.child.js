// Run by notify-engine.test.js in its OWN process (it opens the database): the REAL notification engine (lib/notify.js + the event registry)
// against a throwaway DB. Covers recording, grouping, escalation, reopen, resolve, rules, the kill-switch, the e-mail channel and the
// secret sanitiser. Nothing leaves the machine (SMTP_MOCK, and the outbox is only inspected, never drained). Prints one "CHECK:{...}" per assertion.
const rec = (name, pass, detail) => console.log('CHECK:' + JSON.stringify({ name, pass: !!pass, detail: pass ? '' : String(detail === undefined ? '' : detail).slice(0, 700) }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    const db = require('../database');
    const q = (sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => e ? rej(e) : res(r)));
    const one = async (sql, p = []) => (await q(sql, p))[0];
    const run = (sql, p = []) => new Promise((res, rej) => db.run(sql, p, function (e) { e ? rej(e) : res(this); }));

    for (let i = 0; i < 240; i++) {
        const t = await q("SELECT name FROM sqlite_master WHERE name IN ('admin_notifications','activity_log','settings','notifications')").catch(() => []);
        const m = await q('SELECT 1 AS x FROM schema_migrations WHERE version = 119').catch(() => []);
        const r = await q('SELECT 1 AS x FROM schema_migrations WHERE version = 106').catch(() => []);
        if (t.length === 4 && m.length && r.length) break;
        await sleep(250);
    }
    await sleep(500);

    const notify = require('../lib/notify');
    const setSetting = async (k, v) => { await run('INSERT OR REPLACE INTO settings (setting_key, setting_value) VALUES (?, ?)', [k, v]); notify.invalidateCaches(); };
    const mails = (id) => q(`SELECT * FROM notifications WHERE related_entity = 'admin_notification' AND related_id = ?`, [id]);
    await setSetting('notification_email', 'owner@example.invalid');

    // ── 1. an action event: Activity Log row + ONE incident + ONE e-mail ───────────────────────────────────────────────────────────
    const eft = { submissionId: 501, bookingId: 77, amount: 2500, clientName: 'Test Client', clientEmail: 'client@example.invalid', eventName: 'Gala', eventDate: '2027-01-01' };
    const id1 = await notify.emit('finance.eft_proof_submitted', eft, {});
    const n1 = await one('SELECT * FROM admin_notifications WHERE id = ?', [id1]);
    rec('an EFT proof becomes an ACTION-REQUIRED incident, high priority, status open', n1 && n1.kind === 'action' && n1.priority === 'high' && n1.status === 'open' && n1.category === 'finance', JSON.stringify(n1));
    rec('its title says it is awaiting verification and it is NOT described as received', /awaiting verification/i.test(n1.title) && !/payment received/i.test(n1.title), n1 && n1.title);
    rec('it links to the EFT tab and the proof record', (() => { const l = JSON.parse(n1.link_json); return l.section === 'financeAdmin' && l.tab === 'finEft' && l.record.type === 'eft_submission' && String(l.record.id) === '501'; })(), n1.link_json);
    rec('it is flagged mandatory (cannot be muted)', n1.mandatory === 1, n1.mandatory);
    const act1 = await q("SELECT * FROM activity_log WHERE event_type = 'finance.eft_proof_submitted'");
    rec('the Activity Log recorded it once', act1.length === 1 && act1[0].entity_type === 'eft_submission' && act1[0].entity_id === '501', JSON.stringify(act1));
    rec('personal e-mail address is NOT kept in the stored details', !/client@example/.test(n1.details_json || '') && !/client@example/.test(act1[0].details_json || ''), n1.details_json);
    const m1 = await mails(id1);
    rec('exactly one e-mail was queued to the notification address, using the preserved EFT wording', m1.length === 1 && m1[0].recipient_email === 'owner@example.invalid' && /EFT proof awaiting review/.test(m1[0].subject), JSON.stringify(m1.map((m) => [m.recipient_email, m.subject])));
    rec('the incident records that its e-mail was queued', (await one('SELECT email_state FROM admin_notifications WHERE id = ?', [id1])).email_state === 'queued');

    // ── 2. grouping: a repeat raises the count, adds no row and no second e-mail ───────────────────────────────────────────────────
    const id1b = await notify.emit('finance.eft_proof_submitted', eft, {});
    const cnt = await one("SELECT COUNT(*) c, MAX(occurrence_count) oc FROM admin_notifications WHERE event_type = 'finance.eft_proof_submitted'");
    rec('the same EFT again is grouped into the SAME incident (count 2, still one row)', id1b === id1 && cnt.c === 1 && cnt.oc === 2, JSON.stringify(cnt));
    rec('and does NOT send a second e-mail', (await mails(id1)).length === 1);
    const idOther = await notify.emit('finance.eft_proof_submitted', { ...eft, submissionId: 502 }, {});
    rec('a different EFT is a different incident', idOther !== id1);

    // ── 3. five at once (the unique-index race): one incident ──────────────────────────────────────────────────────────────────────
    await Promise.all([1, 2, 3, 4, 5].map(() => notify.emit('finance.itn_rejected', { reason: 'signature_mismatch', bookingId: 9 }, {})));
    const race = await q("SELECT * FROM admin_notifications WHERE event_type = 'finance.itn_rejected'");
    rec('5 simultaneous identical events end up as ONE open incident with a count of 5', race.length === 1 && race[0].occurrence_count === 5, JSON.stringify(race.map((r) => [r.id, r.occurrence_count])));

    // ── 4. lifecycle: resolve, then a recurrence ───────────────────────────────────────────────────────────────────────────────────
    const changed = await notify.resolve('finance.eft_proof_submitted', 501, { note: 'Approved' });
    const r1 = await one('SELECT * FROM admin_notifications WHERE id = ?', [id1]);
    rec('resolve() closes the incident (auto, with the note and a time)', changed === 1 && r1.status === 'resolved' && r1.resolved_auto === 1 && r1.resolution_note === 'Approved' && !!r1.resolved_at, JSON.stringify(r1));
    const id1c = await notify.emit('finance.eft_proof_submitted', eft, {});
    rec('after resolution the same non-reopen incident STARTS A NEW ONE (history kept)', id1c !== id1 && (await one('SELECT status FROM admin_notifications WHERE id = ?', [id1])).status === 'resolved', id1c);

    const pf = { bookingId: 12, status: 'FAILED', amount: 1000 };
    const pid = await notify.emit('finance.payment_failed', pf, {});
    await notify.resolve('finance.payment_failed', 12, { note: 'Client paid by EFT' });
    const pid2 = await notify.emit('finance.payment_failed', pf, {});
    const pr = await one('SELECT * FROM admin_notifications WHERE id = ?', [pid]);
    rec('a reopen-on-recurrence event REOPENS the resolved incident instead of duplicating it', pid2 === pid && pr.status === 'open' && pr.occurrence_count === 2 && pr.resolved_at === null, JSON.stringify(pr));

    // ── 5. activity-only events never create a notification ───────────────────────────────────────────────────────────────────────
    const before = (await one('SELECT COUNT(*) c FROM admin_notifications')).c;
    const ret = await notify.emit('finance.payment_received', { bookingId: 5, amount: 300, method: 'PayFast' }, {});
    rec('a routine success is recorded in the Activity Log only', ret === null && (await one('SELECT COUNT(*) c FROM admin_notifications')).c === before && (await q("SELECT * FROM activity_log WHERE event_type = 'finance.payment_received'")).length === 1);

    // ── 6. escalation + e-mail on the threshold ────────────────────────────────────────────────────────────────────────────────────
    let eid;
    for (let i = 0; i < 10; i++) eid = await notify.emit('system.server_error', { fingerprint: 'abc123', route: '/api/x', method: 'POST', errorClass: 'TypeError', message: 'boom' }, {});
    const se = await one('SELECT * FROM admin_notifications WHERE id = ?', [eid]);
    rec('10 identical server errors are ONE incident, count 10', se && se.occurrence_count === 10, JSON.stringify(se));
    rec('it escalated from high to critical at the threshold', se.priority === 'critical', se.priority);
    rec('and was e-mailed on the first occurrence and again on escalation (2 mails, not 10)', (await mails(eid)).length === 2, (await mails(eid)).length);

    // ── 7. rules: switching off a non-mandatory event; a mandatory one cannot be switched off ─────────────────────────────────────────
    await run("INSERT OR REPLACE INTO notification_rules (event_type, enabled, updated_at) VALUES ('system.client_error', 0, datetime('now'))");
    await run("INSERT OR REPLACE INTO notification_rules (event_type, enabled, updated_at) VALUES ('finance.ledger_drift', 0, datetime('now'))");
    notify.invalidateCaches();
    const ce = await notify.emit('system.client_error', { fingerprint: 'zz', message: 'x' }, {});
    rec('a non-mandatory event switched off creates no notification (but is still in the Activity Log)', ce === null && (await q("SELECT * FROM activity_log WHERE event_type = 'system.client_error'")).length === 1);
    const ld = await notify.emit('finance.ledger_drift', { count: 2 }, {});
    rec('a MANDATORY financial-integrity event ignores the off switch', !!ld && (await one('SELECT status FROM admin_notifications WHERE id = ?', [ld])).status === 'open');

    // ── 8. e-mail thresholds + backup recipients ───────────────────────────────────────────────────────────────────────────────────
    await setSetting('notification_backup_emails', 'backup@example.invalid, second@example.invalid');
    const crit = await notify.emit('finance.payment_amount_mismatch', { bookingId: 31, received: 90, expected: 100, gatewayPaymentId: 'pf-1' }, {});
    const cm = await mails(crit);
    rec('a CRITICAL alert is e-mailed to the primary AND the backup recipients', cm.length === 3 && cm.some((m) => m.recipient_email === 'backup@example.invalid') && cm.some((m) => m.recipient_email === 'owner@example.invalid'), JSON.stringify(cm.map((m) => m.recipient_email)));
    const hi = await notify.emit('finance.itn_rejected', { reason: 'ip_blocked', bookingId: 1 }, {});
    rec('a HIGH alert goes to the primary address only', (await mails(hi)).length === 1, (await mails(hi)).length);
    await setSetting('ntf_email_min_priority', 'critical');
    const hi2 = await notify.emit('finance.itn_rejected', { reason: 'merchant_mismatch', bookingId: 1 }, {});
    rec('raising the e-mail threshold to critical stops HIGH alerts e-mailing (still in-app)', !!hi2 && (await mails(hi2)).length === 0 && (await one('SELECT email_state FROM admin_notifications WHERE id = ?', [hi2])).email_state === 'skipped');
    await setSetting('ntf_email_min_priority', 'high');

    // ── 9. refresh-on-repeat (compliance stages) ───────────────────────────────────────────────────────────────────────────────────
    const ex = { itemKey: 'bbbee', name: 'B-BBEE certificate', expiryDate: '2026-11-18', daysLeft: 30, reference: 'X1' };
    const xid = await notify.emit('compliance.expiring', { ...ex, emailNow: true }, {});   // the monitor asks for the e-mail when a stage is new
    const xid2 = await notify.emit('compliance.expiring', { ...ex, daysLeft: 14, emailNow: true }, {});
    const xr = await one('SELECT * FROM admin_notifications WHERE id = ?', [xid]);
    rec('expiry reminder stages REFRESH one incident (no duplicate row, count unchanged)', xid2 === xid && xr.occurrence_count === 1 && /14 day/.test(xr.title), JSON.stringify(xr));
    rec('and e-mail once per stage (creation + the 14-day stage = 2)', (await mails(xid)).length === 2);
    const xs = await notify.emit('compliance.expiring', { ...ex, daysLeft: 14 }, {});
    rec('re-running the monitor on the same day sends nothing more', xs === xid && (await mails(xid)).length === 2);

    // ── 10. kill-switch ────────────────────────────────────────────────────────────────────────────────────────────────────────────
    await setSetting('notifications_enabled', '0');
    const ks = await notify.emit('finance.eft_proof_submitted', { ...eft, submissionId: 999 }, {});
    rec('with the master switch off no incident is created, but the Activity Log still records it', ks === null && (await q("SELECT * FROM admin_notifications WHERE entity_id = '999'")).length === 0 && (await q("SELECT * FROM activity_log WHERE entity_id = '999'")).length === 1);
    await setSetting('notifications_enabled', '1');

    // ── 11. safety: unknown event, hostile payloads, secrets ───────────────────────────────────────────────────────────────────────
    let threw = false;
    try { rec('an unknown event is ignored, not fatal', (await notify.emit('nope.nothing', {}, {})) === null); } catch (e) { threw = true; }
    const circ = { bookingId: 1 }; circ.self = circ;
    try { await notify.emit('finance.payment_received', circ, {}); await notify.emit('finance.payment_received', null, {}); await notify.emit('finance.payment_received'); } catch (e) { threw = true; }
    rec('emit() never throws (unknown event, circular payload, null payload)', !threw);
    const dirty = notify.sanitize({ password: 'hunter2', api_key: 'abc', merchant_key: 'k', nested: { Authorization: 'Bearer abcdef.ghi.jkl', note: 'ok' }, url: 'https://x.test/p?token=SECRET123&a=1', blob: 'A'.repeat(80), long: 'x '.repeat(400), email: 'a@b.c', n: 5 });
    const dj = JSON.stringify(dirty);
    rec('credential-looking keys are redacted', dirty.password === '[redacted]' && dirty.api_key === '[redacted]' && dirty.merchant_key === '[redacted]' && dirty.nested.Authorization === '[redacted]', dj);
    rec('secrets inside values are scrubbed (bearer, ?token=, long opaque strings)', !/SECRET123|hunter2|abcdef\.ghi/.test(dj) && !/A{60}/.test(dj), dj);
    rec('long text is truncated and harmless fields survive', dirty.long.length <= 502 && dirty.nested.note === 'ok' && dirty.n === 5 && dirty.email === undefined, dj);
    const leak = await emitLeak(notify, q);
    rec('a secret passed through emit() never reaches either table', leak.clean, leak.detail);

    process.exit(0);
})().catch((e) => { console.log('CHECK:' + JSON.stringify({ name: 'child crashed', pass: false, detail: String(e && e.stack || e).slice(0, 700) })); process.exit(0); });

// A made-up key shaped like a live payment key. Assembled at run time on purpose: written out whole it matches GitHub's secret scanner
// (it blocked the push once), even though it is not a real credential.
const FAKE_KEY = ['sk', 'live', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcd'].join('_');

async function emitLeak(notify, q) {
    await notify.emit('system.job_failed', { job: 'leaktest', label: 'Leak test', failures: 1, error: 'connect failed password=hunter2 Bearer ' + FAKE_KEY, passphrase: 'pp', token: 'tok' }, {});
    const a = await q("SELECT * FROM admin_notifications WHERE event_type = 'system.job_failed'");
    const l = await q("SELECT * FROM activity_log WHERE event_type = 'system.job_failed'");
    const all = JSON.stringify([a, l]);
    return { clean: !all.includes(FAKE_KEY.slice(0, 16)) && !/"tok"|"pp"/.test(all) && !/ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcd/.test(all), detail: all.slice(0, 500) };
}
