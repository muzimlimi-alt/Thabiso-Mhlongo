// Notification Centre API (routes/admin/notifications.js + lib/notify-store.js), against the running test server. docs-internal/notifications.md.
//   A. access      - signed-out is refused; every list is scoped to the caller's role on the SERVER
//   B. lists       - views (action / attention), filters (open / unread / urgent / resolved / all), category, search, paging, summary counts
//   C. read state  - per admin; reading never resolves
//   D. lifecycle   - acknowledge -> resolve (note required for action items) -> archive, with who/when, conflicts refused, audited
//   E. preferences - a muted category hides non-mandatory items only
//   F. rules       - a mandatory alert cannot be switched off / lowered; others can (administrator only)
//   G. settings    - recipients / threshold validated (administrator only)
//   H. browser errors, system health, Activity Log
// Incidents are seeded straight into the test DB (other suites raise real ones too, so every check targets the seeded ids, never totals).
const sqlite3 = require('sqlite3');
const support = require('./support');

const rw = new sqlite3.Database(support.TEST_DB);
const run = (sql, params = []) => new Promise((res, rej) => rw.run(sql, params, function (e) { e ? rej(e) : res(this); }));
const MARK = 'NTFTEST' + Date.now().toString(36);

async function seed(o) {
    const ts = o.at || new Date().toISOString();
    const r = await run(
        `INSERT INTO admin_notifications (dedupe_key, event_type, category, priority, kind, title, body, status, occurrence_count, first_seen_at, last_seen_at, mandatory, link_json, details_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
        [`${o.event}|${MARK}-${Math.random()}`, o.event, o.category, o.priority, o.kind, `${MARK} ${o.title}`, o.body || 'seeded', o.status || 'open', ts, ts, o.mandatory ? 1 : 0,
            JSON.stringify(o.link || { section: 'financeAdmin' }), JSON.stringify({ secretish: 'only admins see details' })]);
    return r.lastID;
}
const ids = (r) => ((r.body && r.body.items) || []).map((n) => n.id);

module.exports = async function ({ check, api, pub, one, sleep, loginAs }) {
    // ── A. access ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
    const anon = await pub('GET', '/api/admin/notifications');
    check('signed-out requests are refused', anon.status === 401 || anon.status === 403, anon.status);

    const eft = await seed({ event: 'finance.eft_proof_submitted', category: 'finance', priority: 'high', kind: 'action', mandatory: true, title: 'EFT awaiting verification' });
    const refund = await seed({ event: 'events.ticket_refund_required', category: 'events', priority: 'critical', kind: 'action', mandatory: true, title: 'Ticket refund required' });
    const sysErr = await seed({ event: 'system.client_error', category: 'system', priority: 'medium', kind: 'attention', title: 'Browser error' });
    const expiry = await seed({ event: 'compliance.expiring', category: 'compliance', priority: 'high', kind: 'attention', mandatory: true, title: 'Certificate expiring' });
    const oldDone = await seed({ event: 'finance.payment_failed', category: 'finance', priority: 'high', kind: 'action', mandatory: true, status: 'resolved', title: 'Old resolved failure' });
    const bank = await seed({ event: 'finance.bank_details_changed', category: 'finance', priority: 'high', kind: 'attention', mandatory: true, title: 'Bank details changed' });
    const pending = await seed({ event: 'finance.payment_pending_timeout', category: 'finance', priority: 'high', kind: 'action', mandatory: true, title: 'Payment pending' });

    const asManager = await loginAs('manager');
    const asAssistant = await loginAs('assistant');

    // ── B. lists ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
    const act = await api('GET', `/api/admin/notifications?view=action&q=${MARK}&pageSize=100`);
    check('Action required lists the open action items only', act.status === 200 && [eft, refund, pending].every((i) => ids(act).includes(i)) && !ids(act).includes(sysErr) && !ids(act).includes(oldDone), JSON.stringify(ids(act)));
    check('...ordered most urgent first (critical before high)', ids(act).indexOf(refund) < ids(act).indexOf(eft), JSON.stringify(ids(act)));
    const att = await api('GET', `/api/admin/notifications?view=attention&q=${MARK}`);
    check('Attention lists the open attention items only', [sysErr, expiry, bank].every((i) => ids(att).includes(i)) && !ids(att).includes(eft), JSON.stringify(ids(att)));
    const resolvedList = await api('GET', `/api/admin/notifications?view=action&filter=resolved&q=${MARK}`);
    check('a view can show what was resolved', ids(resolvedList).includes(oldDone) && !ids(resolvedList).includes(eft), JSON.stringify(ids(resolvedList)));
    const urgent = await api('GET', `/api/admin/notifications?filter=urgent&q=${MARK}&pageSize=100`);
    check('Urgent = critical + high, still open', ids(urgent).includes(refund) && ids(urgent).includes(eft) && !ids(urgent).includes(sysErr) && !ids(urgent).includes(oldDone), JSON.stringify(ids(urgent)));
    const cat = await api('GET', `/api/admin/notifications?category=events&q=${MARK}`);
    check('filter by category', ids(cat).length === 1 && ids(cat)[0] === refund, JSON.stringify(ids(cat)));
    const search = await api('GET', `/api/admin/notifications?q=${encodeURIComponent(MARK + ' Ticket refund')}`);
    check('search matches the title', ids(search).length === 1 && ids(search)[0] === refund, JSON.stringify(ids(search)));
    const paged = await api('GET', `/api/admin/notifications?q=${MARK}&pageSize=2&page=2`);
    check('paging returns page 2 with the total', paged.body.items.length === 2 && paged.body.total >= 6 && paged.body.page === 2, JSON.stringify({ n: paged.body.items.length, total: paged.body.total }));
    const item = act.body.items.find((n) => n.id === eft);
    check('an item carries its link, actions, category label and lifecycle fields', item && item.link && item.link.section === 'financeAdmin' && item.category_label === 'Finance & Payments' && item.status === 'open' && item.mandatory === true && item.is_read === false, JSON.stringify(item));
    check('an administrator sees the technical details', item && item.details && item.details.secretish, JSON.stringify(item && item.details));
    const bad = await api('GET', '/api/admin/notifications/abc');
    check('a non-numeric id is a 404, not a server error', bad.status === 404, bad.status);

    // ── A (roles) ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
    const mList = await asManager('GET', `/api/admin/notifications?q=${MARK}&pageSize=100`);
    check('a manager sees finance and events alerts', [eft, refund, pending].every((i) => ids(mList).includes(i)), JSON.stringify(ids(mList)));
    check('...but not system errors or bank-detail changes (administrator only)', !ids(mList).includes(sysErr) && !ids(mList).includes(bank), JSON.stringify(ids(mList)));
    check('...and never the technical details', mList.body.items.every((n) => n.details === undefined));
    const mGet = await asManager('GET', `/api/admin/notifications/${sysErr}`);
    check('a manager asking for an administrator-only item directly gets 404', mGet.status === 404, mGet.status);
    const aList = await asAssistant('GET', `/api/admin/notifications?q=${MARK}`);
    check('an assistant sees none of the finance / events / system alerts', aList.status === 200 && ids(aList).length === 0, JSON.stringify(ids(aList)));
    const aAck = await asAssistant('POST', `/api/admin/notifications/${eft}/ack`);
    check('an assistant cannot acknowledge a finance alert', aAck.status === 404, aAck.status);

    // ── C. read state ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
    const s0 = await api('GET', '/api/admin/notifications/summary');
    check('summary returns counts and the latest items', s0.status === 200 && typeof s0.body.unread === 'number' && Array.isArray(s0.body.latest) && s0.body.latest.length <= 8, JSON.stringify(s0.body).slice(0, 300));
    await api('POST', '/api/admin/notifications/read', { ids: [eft, refund] });
    const s1 = await api('GET', '/api/admin/notifications/summary');
    check('marking 2 read lowers the unread count by 2', s1.body.unread === s0.body.unread - 2, `${s0.body.unread} -> ${s1.body.unread}`);
    const afterRead = await api('GET', `/api/admin/notifications/${eft}`);
    check('READING DOES NOT RESOLVE: still open after being read', afterRead.body.notification.status === 'open' && afterRead.body.notification.is_read === true, JSON.stringify(afterRead.body.notification));
    const mStill = await asManager('GET', `/api/admin/notifications/${eft}`);
    check('read state is per admin (still unread for the manager)', mStill.body.notification.is_read === false);
    await api('POST', '/api/admin/notifications/read', { ids: [eft], read: false });
    check('mark as unread works', (await api('GET', `/api/admin/notifications/${eft}`)).body.notification.is_read === false);
    const unreadOnly = await api('GET', `/api/admin/notifications?filter=unread&q=${MARK}&pageSize=100`);
    check('the Unread filter excludes what this admin has read', ids(unreadOnly).includes(eft) && !ids(unreadOnly).includes(refund), JSON.stringify(ids(unreadOnly)));
    const all = await api('POST', '/api/admin/notifications/read-all');
    check('mark all read', all.status === 200 && (await api('GET', '/api/admin/notifications/summary')).body.unread === 0);

    // ── D. lifecycle ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
    const ack = await asManager('POST', `/api/admin/notifications/${eft}/ack`);
    check('a manager acknowledges: status acknowledged, who and when recorded', ack.status === 200 && ack.body.notification.status === 'acknowledged' && !!ack.body.notification.acknowledged_by && !!ack.body.notification.acknowledged_at, JSON.stringify(ack.body));
    const ack2 = await api('POST', `/api/admin/notifications/${eft}/ack`);
    check('acknowledging twice is refused (409)', ack2.status === 409, ack2.status);
    const noNote = await api('POST', `/api/admin/notifications/${eft}/resolve`, {});
    check('an action item cannot be resolved without a note', noNote.status === 400, noNote.status);
    const archOpen = await api('POST', `/api/admin/notifications/${eft}/archive`);
    check('an unresolved action item cannot be archived', archOpen.status === 409, archOpen.status);
    const res = await api('POST', `/api/admin/notifications/${eft}/resolve`, { note: 'Checked the bank statement; approved.' });
    check('resolve records status, who, when and the note', res.status === 200 && res.body.notification.status === 'resolved' && !!res.body.notification.resolved_by && res.body.notification.resolution_note === 'Checked the bank statement; approved.' && res.body.notification.resolved_auto === false, JSON.stringify(res.body));
    check('...and keeps who acknowledged it', !!res.body.notification.acknowledged_by);
    const res2 = await api('POST', `/api/admin/notifications/${eft}/resolve`, { note: 'again' });
    check('resolving a closed item is refused (409)', res2.status === 409, res2.status);
    const arch = await api('POST', `/api/admin/notifications/${eft}/archive`);
    check('a resolved item can be archived', arch.status === 200 && arch.body.notification.status === 'archived' && !!arch.body.notification.archived_at);
    const archAtt = await api('POST', `/api/admin/notifications/${sysErr}/archive`);
    check('an attention item can be archived straight away', archAtt.status === 200 && archAtt.body.notification.status === 'archived');
    const badAction = await api('POST', `/api/admin/notifications/${refund}/delete`);
    check('an unknown action is refused', badAction.status === 404, badAction.status);
    let audits = [];
    for (let i = 0; i < 20 && audits.length < 3; i++) { audits = await support.q("SELECT action FROM audit_log WHERE table_name = 'admin_notifications' AND record_id = ?", [eft]); if (audits.length < 3) await sleep(150); }
    check('acknowledge / resolve / archive are in the audit log', ['ACK', 'RESOLVE', 'ARCHIVE'].every((a) => audits.some((r) => r.action === a)), JSON.stringify(audits));

    // ── E. preferences ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
    const nonMand = await seed({ event: 'finance.eft_rejected', category: 'finance', priority: 'medium', kind: 'attention', mandatory: false, title: 'Non-mandatory finance item' });
    const p0 = await asManager('GET', '/api/admin/notification-prefs');
    check('a manager gets preferences for their own categories only', p0.status === 200 && p0.body.prefs.some((p) => p.category === 'finance') && !p0.body.prefs.some((p) => p.category === 'system'), JSON.stringify(p0.body.prefs.map((p) => p.category)));
    await asManager('PUT', '/api/admin/notification-prefs', { prefs: [{ category: 'finance', in_app: false }, { category: 'system', in_app: false }] });
    const mMuted = await asManager('GET', `/api/admin/notifications?q=${MARK}&pageSize=100`);
    check('muting Finance hides the non-mandatory finance item', !ids(mMuted).includes(nonMand), JSON.stringify(ids(mMuted)));
    check('...but MANDATORY finance alerts still show', ids(mMuted).includes(pending), JSON.stringify(ids(mMuted)));
    check('...and only for that manager (the administrator still sees it)', ids(await api('GET', `/api/admin/notifications?q=${MARK}&pageSize=100`)).includes(nonMand));
    await asManager('PUT', '/api/admin/notification-prefs', { prefs: [{ category: 'finance', in_app: true }] });
    check('unmuting brings it back', ids(await asManager('GET', `/api/admin/notifications?q=${MARK}&pageSize=100`)).includes(nonMand));

    // ── F. rules ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
    check('a manager cannot read the business-wide rules', (await asManager('GET', '/api/admin/notification-rules')).status === 403);
    const rules = await api('GET', '/api/admin/notification-rules');
    check('rules list every registered event with its defaults', rules.status === 200 && rules.body.rules.some((r) => r.event_type === 'finance.eft_proof_submitted' && r.mandatory === true && r.default_priority === 'high'), JSON.stringify(rules.body).slice(0, 300));
    const offMand = await api('PUT', '/api/admin/notification-rules/finance.eft_proof_submitted', { enabled: false });
    check('a mandatory alert cannot be switched off', offMand.status === 400, offMand.status);
    const lowMand = await api('PUT', '/api/admin/notification-rules/finance.payment_amount_mismatch', { priority: 'info' });
    check('a mandatory alert cannot be lowered below High', lowMand.status === 400, lowMand.status);
    const mailOff = await api('PUT', '/api/admin/notification-rules/finance.eft_proof_submitted', { email: false });
    check('a mandatory alert\'s e-mail cannot be switched off', mailOff.status === 400, mailOff.status);
    const offOk = await api('PUT', '/api/admin/notification-rules/system.client_error', { enabled: false });
    check('a non-mandatory alert can be switched off', offOk.status === 200 && offOk.body.rules.find((r) => r.event_type === 'system.client_error').enabled === false);
    await api('PUT', '/api/admin/notification-rules/system.client_error', { enabled: null });
    check('an unknown event is a 404', (await api('PUT', '/api/admin/notification-rules/nope.event', { enabled: false })).status === 404);

    // ── G. settings ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
    check('a manager cannot change notification recipients', (await asManager('PUT', '/api/admin/notification-settings', { backup_emails: ['x@example.invalid'] })).status === 403);
    const before = (await api('GET', '/api/admin/notification-settings')).body.settings;
    const badMail = await api('PUT', '/api/admin/notification-settings', { backup_emails: ['not-an-email'] });
    check('an invalid backup address is refused with a field error', badMail.status === 400 && badMail.body.errors && badMail.body.errors.backup_emails, JSON.stringify(badMail.body));
    const badPri = await api('PUT', '/api/admin/notification-settings', { email_min_priority: 'loud' });
    check('an invalid e-mail threshold is refused', badPri.status === 400 && badPri.body.errors.email_min_priority);
    const okSet = await api('PUT', '/api/admin/notification-settings', { backup_emails: ['backup1@example.invalid', 'backup2@example.invalid'], email_min_priority: 'critical' });
    check('valid backup recipients and threshold are saved', okSet.status === 200 && okSet.body.settings.backup_emails.length === 2 && okSet.body.settings.email_min_priority === 'critical', JSON.stringify(okSet.body));
    await api('PUT', '/api/admin/notification-settings', { backup_emails: before.backup_emails, email_min_priority: before.email_min_priority });

    // ── H. browser errors, health, activity ────────────────────────────────────────────────────────────────────────────────────────
    const ce = await api('POST', '/api/admin/client-errors', { message: `${MARK} TypeError: x is undefined`, source: '/js/admin/thing.js', line: 42, page: '/admin.html?x=1#y' });
    check('a browser error report is accepted (204)', ce.status === 204, ce.status);
    let ceRow = null;
    for (let i = 0; i < 20 && !ceRow; i++) { ceRow = await one("SELECT * FROM admin_notifications WHERE event_type = 'system.client_error' AND body LIKE ?", [`%${MARK} TypeError%`]); if (!ceRow) await sleep(150); }
    check('...and becomes an administrator-only Attention item with its source line', ceRow && ceRow.kind === 'attention' && /thing\.js:42/.test(ceRow.body), JSON.stringify(ceRow));
    for (let i = 0; i < 25; i++) await api('POST', '/api/admin/client-errors', { message: `${MARK} flood`, source: 'loop.js', line: 1 });
    const flood = await one("SELECT occurrence_count FROM admin_notifications WHERE event_type = 'system.client_error' AND body LIKE ? AND status = 'open'", [`%${MARK} flood%`]);
    check('a flood of identical browser errors is ONE incident, capped per minute', flood && flood.occurrence_count <= 20, JSON.stringify(flood));
    check('a signed-out browser cannot report errors', [401, 403].includes((await pub('POST', '/api/admin/client-errors', { message: 'x' })).status));

    const health = await api('GET', '/api/admin/system-health');
    check('system health lists the monitored jobs and the e-mail queue', health.status === 200 && Array.isArray(health.body.jobs) && health.body.email_queue && typeof health.body.open_alerts.critical === 'number', JSON.stringify(health.body).slice(0, 300));
    check('the scheduled jobs registered heartbeats', health.body.jobs.some((j) => j.name === 'lifecycle-sweep' || j.name === 'calendar-holds-sync' || j.name === 'notification-retention'), JSON.stringify(health.body.jobs.map((j) => j.name)));
    check('a manager cannot see system health', (await asManager('GET', '/api/admin/system-health')).status === 403);

    const activity = await api('GET', `/api/admin/activity?q=${encodeURIComponent(MARK)}`);
    check('the Activity Log is searchable and records the browser error', activity.status === 200 && activity.body.items.some((a) => a.event_type === 'system.client_error' && a.actor_type === 'admin'), JSON.stringify(activity.body).slice(0, 400));
    const mActivity = await asManager('GET', `/api/admin/activity?q=${encodeURIComponent(MARK)}`);
    check('a manager\'s Activity Log leaves out administrator-only events', mActivity.status === 200 && !mActivity.body.items.some((a) => a.category === 'system'), JSON.stringify(mActivity.body.items.map((a) => a.category)));

    // tidy: everything seeded or raised here
    await run("DELETE FROM admin_notifications WHERE title LIKE ? OR body LIKE ?", [`${MARK}%`, `%${MARK}%`]);
    await run("DELETE FROM activity_log WHERE summary LIKE ? OR details_json LIKE ?", [`%${MARK}%`, `%${MARK}%`]);
    await run("DELETE FROM notification_prefs WHERE admin_id IN (SELECT id FROM admins WHERE username LIKE 'test.%@example.invalid')");
};
