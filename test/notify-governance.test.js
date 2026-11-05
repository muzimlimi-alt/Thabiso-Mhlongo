// Notification Centre - Phase 3 through the REAL routes on the test server (docs-internal/notifications.md):
//   A. newsletter: sign-up (Activity), confirmation and unsubscribe (grouped per day, address masked)
//   B. a failed admin sign-in is recorded - never the password (ONE attempt only: the login limiter is live in tests and shared by every suite;
//      the "3 in 15 minutes" rule is tested in test/notify-security.child.js)
//   C. staff accounts: created, role changed, suspended, deleted - administrator-only security alerts
//   D. an integration switched off
//   E. business profile: an ordinary change (medium) vs a registration change (high), before / after for administrators only
//   F. the expiry list: managers add / edit, assistants cannot, administrators delete; reminders follow the date and stop on removal
const MARK = 'NTFGOV' + Date.now().toString(36);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = async function ({ check, api, pub, one, q, loginAs, future }) {
    const poll = async (sql, params, ok = (r) => !!r, tries = 40) => {
        let row = null;
        for (let i = 0; i < tries; i++) { row = await one(sql, params); if (ok(row)) return row; await sleep(150); }
        return row;
    };
    const asManager = await loginAs('manager');
    const asAssistant = await loginAs('assistant');

    // ── A. subscribers ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
    const subEmail = `${MARK.toLowerCase()}.sub@example.invalid`;
    const s1 = await pub('POST', '/api/public/subscribe', { email: subEmail, popia_consent: true, first_name: 'Subby' });
    check('A sign-up accepted', s1.status === 200, JSON.stringify(s1.body));
    const sub = await poll('SELECT subscriber_id, unsubscribe_token FROM newsletter_subscribers WHERE email = ?', [subEmail]);
    const su = await poll(`SELECT * FROM activity_log WHERE event_type = 'subscribers.signed_up' AND summary LIKE ? ORDER BY id DESC LIMIT 1`, ['%Subby%']);
    check('A a sign-up waiting for confirmation is in the Activity Log only, address masked', su && /n\*\*\*@example\.invalid/.test(su.summary) && !su.summary.includes(subEmail), JSON.stringify(su));
    const cf = sub ? await pub('POST', '/api/public/newsletter/confirm', { email: subEmail, token: sub.unsubscribe_token }) : { status: 0 };
    check('A confirmation accepted', cf.status === 200, JSON.stringify(cf.body));
    const conf = await poll(`SELECT * FROM admin_notifications WHERE event_type = 'subscribers.confirmed' ORDER BY id DESC LIMIT 1`, [], (r) => r && /Subby/.test(r.body || ''));
    check('A a confirmed subscriber raises "New newsletter subscribers today" (medium, grouped per day)', conf && conf.priority === 'medium' && /subsnew:\d{4}-\d{2}-\d{2}/.test(conf.dedupe_key), JSON.stringify(conf));
    check('A the full address is never stored in the alert', conf && !JSON.stringify(conf).includes(subEmail), conf && conf.body);
    check('A an assistant can see subscriber news', conf && (await asAssistant('GET', `/api/admin/notifications/${conf.id}`)).status === 200);
    const un = sub ? await pub('POST', '/api/public/newsletter/unsubscribe', { email: subEmail, token: sub.unsubscribe_token }) : { status: 0 };
    check('A unsubscribe accepted', un.status === 200, JSON.stringify(un.body));
    const gone = await poll(`SELECT * FROM admin_notifications WHERE event_type = 'subscribers.unsubscribed' ORDER BY id DESC LIMIT 1`, [], (r) => r && /n\*\*\*@example/.test(r.body || '') && r.last_seen_at > new Date(Date.now() - 60000).toISOString());
    check('A an unsubscribe is grouped into "Newsletter unsubscribes today"', !!gone, JSON.stringify(gone));

    // ── B. one failed sign-in ──────────────────────────────────────────────────────────────────────────────────────────────────────
    const badPass = `${MARK}-WrongPassword!`;
    const lf = await pub('POST', '/api/admin/login', { email: 'test.runner@example.invalid', password: badPass });
    check('B a wrong password is refused', lf.status === 401, lf.status);
    const fl = await poll(`SELECT * FROM activity_log WHERE event_type = 'security.login_failed' AND entity_id = 'test.runner@example.invalid' ORDER BY id DESC LIMIT 1`, []);
    check('B the failed sign-in is recorded with the reason', fl && /wrong password/.test(fl.summary), JSON.stringify(fl));
    const leak = await one(`SELECT COUNT(*) AS n FROM activity_log WHERE summary LIKE ? OR details_json LIKE ?`, [`%${badPass}%`, `%${badPass}%`]);
    check('B the password typed never reaches the log', leak.n === 0, leak.n);

    // ── C. staff accounts ──────────────────────────────────────────────────────────────────────────────────────────────────────────
    const uEmail = `${MARK.toLowerCase()}.user@example.invalid`;
    const cu = await api('POST', '/api/admin/users', { email: uEmail, full_name: `${MARK} Staffer`, phone: '0821234567', role: 'assistant' });
    const uid = cu.body && (cu.body.id || cu.body.user_id || (cu.body.user && cu.body.user.id)) || (await one('SELECT id FROM admins WHERE email = ?', [uEmail]) || {}).id;
    check('C a staff account is created', cu.status === 200 && !!uid, JSON.stringify(cu.body));
    const created = uid ? await poll(`SELECT * FROM admin_notifications WHERE event_type = 'security.user_created' AND entity_id = ?`, [String(uid)]) : null;
    check('C "New assistant account created" - high, mandatory', created && created.priority === 'high' && created.mandatory === 1 && /assistant account created/.test(created.title), JSON.stringify(created));
    check('C security alerts are for administrators only (not managers)', created && (await asManager('GET', `/api/admin/notifications/${created.id}`)).status === 404);
    if (uid) {
        await api('PUT', `/api/admin/users/${uid}`, { email: uEmail, role: 'manager' });
        const rc = await poll(`SELECT * FROM admin_notifications WHERE event_type = 'security.user_changed' AND entity_id = ? AND dedupe_key LIKE '%:role'`, [String(uid)]);
        check('C a role change is announced, old and new role', rc && /now manager/.test(rc.title) && /was assistant/.test(rc.body || ''), JSON.stringify(rc));
        await api('PUT', `/api/admin/users/${uid}`, { email: uEmail, role: 'manager', is_active: false });
        const dis = await poll(`SELECT * FROM admin_notifications WHERE event_type = 'security.user_changed' AND entity_id = ? AND dedupe_key LIKE '%:disabled'`, [String(uid)]);
        check('C suspending an account is announced', dis && /suspended/i.test(dis.title), JSON.stringify(dis));
        await api('DELETE', `/api/admin/users/${uid}`);
        const del = await poll(`SELECT * FROM admin_notifications WHERE event_type = 'security.user_changed' AND entity_id = ? AND dedupe_key LIKE '%:deleted'`, [String(uid)]);
        check('C deleting an account is announced', del && /deleted/i.test(del.title), JSON.stringify(del));
    }

    // ── D. an integration switched off ─────────────────────────────────────────────────────────────────────────────────────────────
    const st = await one('SELECT enabled FROM inbox_sync_state WHERE id = 1');
    const maxBefore = (await one(`SELECT COALESCE(MAX(id), 0) AS m FROM admin_notifications`)).m;   // other suites may have toggled it already - judge only what happens now
    const t0 = new Date().toISOString();
    await api('PUT', '/api/admin/inbox-sync', { enabled: true }).catch(() => null);   // refused in mock mode (verify-before-enable) - so it can only be switched off
    if (st && st.enabled) {
        const off = await api('PUT', '/api/admin/inbox-sync', { enabled: false });
        const ig = await poll(`SELECT * FROM admin_notifications WHERE event_type = 'security.integration_changed' AND entity_id = 'inbox-sync' ORDER BY id DESC LIMIT 1`, []);
        check('D switching mailbox reply collection off is a security alert', off.status === 200 && ig && /switched off/.test(ig.title), JSON.stringify([off.body, ig]));
        await one('SELECT 1');   // (left off: the test database is a throwaway copy)
    } else {
        await sleep(400);
        const ig = await one(`SELECT id FROM admin_notifications WHERE event_type = 'security.integration_changed' AND entity_id = 'inbox-sync' AND id > ?`, [maxBefore]);
        const reopened = await one(`SELECT id FROM admin_notifications WHERE event_type = 'security.integration_changed' AND entity_id = 'inbox-sync' AND last_seen_at > ?`, [t0]);
        check('D a refused switch-on (verification failed) raises nothing', !ig && !reopened, JSON.stringify([ig, reopened]));
    }

    // ── E. business profile ────────────────────────────────────────────────────────────────────────────────────────────────────────
    const URL = '/api/admin/business-profile';
    const view = async () => (await api('GET', URL)).body;
    const put = async (patch) => api('PUT', URL, Object.assign({}, patch, { version: (await view()).profile.version, confirm_registration_change: true }));
    const before = await view();
    const oldSite = before.profile.website;
    const w = await put({ website: `www.${MARK.toLowerCase()}.example` });
    check('E an ordinary profile change saves', w.status === 200, JSON.stringify(w.body).slice(0, 300));
    const bc = await poll(`SELECT * FROM admin_notifications WHERE event_type = 'customer.business_changed' ORDER BY id DESC LIMIT 1`, [], (r) => r && /website/.test(r.body || ''));
    check('E "Business profile updated" (medium) names the field', bc && bc.priority === 'medium' && /website/.test(bc.body), JSON.stringify(bc));
    const bcAdmin = bc ? await api('GET', `/api/admin/notifications/${bc.id}`) : null;
    check('E administrators see the previous and new value', bcAdmin && JSON.stringify(bcAdmin.body.notification.details).includes(MARK.toLowerCase()), JSON.stringify(bcAdmin && bcAdmin.body.notification.details).slice(0, 300));
    check('E business-profile alerts are administrator-only', bc && (await asManager('GET', `/api/admin/notifications/${bc.id}`)).status === 404);
    const oldTrading = (await view()).profile.trading_name;
    const tr = await put({ trading_name: `${MARK} Trading` });
    const rc = await poll(`SELECT * FROM admin_notifications WHERE event_type = 'customer.registration_changed' ORDER BY id DESC LIMIT 1`, [], (r) => r && r.last_seen_at > new Date(Date.now() - 60000).toISOString());
    check('E a trading-name change is a HIGH "Registered business details changed" alert', tr.status === 200 && rc && rc.priority === 'high' && /Registered business details changed/.test(rc.title), JSON.stringify([tr.status, rc && rc.title]));
    await put({ website: oldSite, trading_name: oldTrading });

    // ── F. expiry list ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
    check('F an assistant cannot read the expiry list', (await asAssistant('GET', '/api/admin/compliance-items')).status === 403);
    const bad = await asManager('POST', '/api/admin/compliance-items', { name: 'x', kind: 'nope', expiry_date: '2026-13-45' });
    check('F invalid items are refused with field errors', bad.status === 400 && bad.body.errors && bad.body.errors.name && bad.body.errors.kind && bad.body.errors.expiry_date, JSON.stringify(bad.body));
    const add = await asManager('POST', '/api/admin/compliance-items', { name: `${MARK} domain`, kind: 'domain', reference: 'thabisomhlongo.com', expiry_date: future(10) });
    const itemId = add.body && add.body.id;
    check('F a manager adds an item and the list shows days left (B-BBEE from the profile listed read-only)', add.status === 200 && itemId && add.body.items.some((i) => i.id === itemId && i.days_left >= 9 && i.days_left <= 11) && add.body.items.some((i) => i.read_only && i.kind === 'bbbee'), JSON.stringify(add.body).slice(0, 400));
    const exp = itemId ? await poll(`SELECT * FROM admin_notifications WHERE event_type = 'compliance.expiring' AND entity_id = ?`, [`doc:${itemId}`]) : null;
    check('F an item expiring in 10 days raises its reminder at once, linking to the Expiry dates tab', exp && /expires in 1\d day/.test(exp.title) && /ntfPanelExpiry/.test(exp.link_json), JSON.stringify(exp));
    const ed = await asManager('PUT', `/api/admin/compliance-items/${itemId}`, { expiry_date: future(400) });
    const res = exp ? await poll('SELECT * FROM admin_notifications WHERE id = ?', [exp.id], (r) => r && r.status === 'resolved') : null;
    check('F renewing (a date a year out) resolves the reminder automatically', ed.status === 200 && res && res.status === 'resolved', JSON.stringify([ed.status, res && res.status]));
    await asManager('PUT', `/api/admin/compliance-items/${itemId}`, { expiry_date: future(5) });
    const exp2 = await poll(`SELECT * FROM admin_notifications WHERE event_type = 'compliance.expiring' AND entity_id = ? AND status = 'open'`, [`doc:${itemId}`]);
    check('F a nearer date brings a fresh reminder', !!exp2, '');
    check('F a manager cannot delete', (await asManager('DELETE', `/api/admin/compliance-items/${itemId}`)).status === 403);
    const dl = await api('DELETE', `/api/admin/compliance-items/${itemId}`);
    const exp3 = exp2 ? await poll('SELECT * FROM admin_notifications WHERE id = ?', [exp2.id], (r) => r && r.status === 'resolved') : null;
    check('F an administrator deletes it and its reminder stops (resolved)', dl.status === 200 && exp3 && exp3.status === 'resolved' && /removed/i.test(exp3.resolution_note || ''), JSON.stringify(exp3));
    const audits = await q(`SELECT action FROM audit_log WHERE table_name = 'compliance_items' AND record_id = ?`, [itemId]);
    check('F every change to the list is in the audit log', ['create', 'update', 'delete'].every((a) => audits.some((r) => r.action === a)), JSON.stringify(audits));
};
