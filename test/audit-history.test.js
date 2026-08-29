// "Last Updated By" & Audit History: verifies the resolveActor/logAudit backend wiring — exactly
// one audit_log row per save (no double-writes from the 4 trigger-covered tables: bookings, events,
// inquiries, date_holds), actor_role correctly round-tripped through the scratch-column trigger
// trick, every in-scope module's save response carries a well-formed last_updated object, and the
// audit_log endpoint's new record_id filter + actor-name join.
module.exports = async function ({ check, api, q, one }) {
    const hasLastUpdated = (obj) => !!(obj && obj.last_updated && obj.last_updated.name && obj.last_updated.at);

    // ── Gallery: no pre-existing trigger — logAudit() must write exactly one row ──
    const g = await api('POST', '/api/admin/gallery', { title: 'AuditTest Image', fallback_url: 'images/gallery/audit-test.jpg', uploader_name: 'Tester', location: 'Test Venue' });
    check('gallery create returns last_updated', g.body && g.body.success && hasLastUpdated(g.body), JSON.stringify(g.body));
    let rows = await q("SELECT * FROM audit_log WHERE table_name='gallery_images' AND record_id=? AND action='create'", [g.body && g.body.id]);
    check('gallery create writes exactly one audit_log row', rows.length === 1, `rows=${rows.length}`);
    check('gallery audit_log row has actor_role', !!(rows[0] && rows[0].actor_role), JSON.stringify(rows[0]));

    const gUpd = await api('PUT', `/api/admin/gallery/${g.body.id}`, { title: 'AuditTest Image Updated', uploader_name: 'Tester', location: 'Test Venue' });
    check('gallery update returns last_updated', gUpd.body && gUpd.body.success && hasLastUpdated(gUpd.body), JSON.stringify(gUpd.body));
    rows = await q("SELECT * FROM audit_log WHERE table_name='gallery_images' AND record_id=? AND action='update'", [g.body.id]);
    check('gallery update writes exactly one audit_log row', rows.length === 1, `rows=${rows.length}`);

    // ── Users: no pre-existing trigger — logAudit() must write exactly one row ──
    const uEmail = `audit.test.${Date.now()}@example.invalid`;
    const u = await api('POST', '/api/admin/users', { email: uEmail, full_name: 'Audit Test User', phone: '0821234567', role: 'manager' });
    check('user create returns last_updated', u.body && u.body.success && hasLastUpdated(u.body), JSON.stringify(u.body));
    rows = await q("SELECT * FROM audit_log WHERE table_name='admins' AND record_id=? AND action='create'", [u.body && u.body.id]);
    check('user create writes exactly one audit_log row', rows.length === 1, `rows=${rows.length}`);

    const uUpd = await api('PUT', `/api/admin/users/${u.body.id}`, { email: uEmail, full_name: 'Audit Test User Updated', phone: '0821234567', role: 'manager' });
    check('user update returns last_updated', uUpd.body && uUpd.body.success && hasLastUpdated(uUpd.body), JSON.stringify(uUpd.body));
    rows = await q("SELECT * FROM audit_log WHERE table_name='admins' AND record_id=? AND action='update'", [u.body.id]);
    check('user update writes exactly one audit_log row', rows.length === 1, `rows=${rows.length}`);

    // ── Events: trigger-covered — the extended trigger must be the SOLE writer (no explicit
    // parallel insert added alongside it) ──
    const ev = await api('POST', '/api/admin/events', { event_title: 'Audit Test Event', event_datetime: '2027-06-01T18:00', event_type: 'Corporate Event', venue_name: 'Test Venue', sync_to_gcal: false });
    check('event create returns last_updated', ev.body && ev.body.success && hasLastUpdated(ev.body), JSON.stringify(ev.body));

    const evUpd = await api('PUT', `/api/admin/events/${ev.body.id}`, { event_title: 'Audit Test Event Updated', event_datetime: '2027-06-02T18:00', event_type: 'Corporate Event', venue_name: 'Test Venue 2', sync_to_gcal: false });
    check('event update returns last_updated', evUpd.body && evUpd.body.success && hasLastUpdated(evUpd.body), JSON.stringify(evUpd.body));
    rows = await q("SELECT * FROM audit_log WHERE table_name='events' AND record_id=? AND action='UPDATE'", [ev.body.id]);
    check('event update writes exactly one audit_log row (trigger is sole writer)', rows.length === 1, `rows=${rows.length}`);
    check('event update audit_log row has actor_role via trigger round-trip', !!(rows[0] && rows[0].actor_role), JSON.stringify(rows[0]));

    // ── Calendar (date_holds): trigger-covered, INSERT + UPDATE both now attributed ──
    const hold = await api('POST', '/api/admin/calendar/hold', { date: '2027-07-01', reason: 'Audit test hold' });
    check('calendar hold create returns last_updated', hold.body && hold.body.success && hasLastUpdated(hold.body), JSON.stringify(hold.body));
    const holdId = hold.body && hold.body.hold && hold.body.hold.id;
    rows = await q("SELECT * FROM audit_log WHERE table_name='date_holds' AND record_id=? AND action='INSERT'", [holdId]);
    check('date_holds create writes exactly one audit_log row with an attributed actor', rows.length === 1 && !!rows[0].changed_by, JSON.stringify(rows));

    const holdMove = await api('PATCH', `/api/admin/calendar/hold/${holdId}/date`, { date: '2027-07-02' });
    check('calendar hold move returns last_updated', holdMove.body && holdMove.body.success && hasLastUpdated(holdMove.body), JSON.stringify(holdMove.body));
    rows = await q("SELECT * FROM audit_log WHERE table_name='date_holds' AND record_id=? AND action='UPDATE'", [holdId]);
    check('date_holds move writes exactly one audit_log row', rows.length === 1, `rows=${rows.length}`);
    check('date_holds move audit_log row has actor_role', !!(rows[0] && rows[0].actor_role), JSON.stringify(rows[0]));

    // ── Inquiries: trigger-covered ──
    const inqRow = await one("SELECT inquiry_id FROM inquiries LIMIT 1");
    if (inqRow) {
        const before = await q("SELECT COUNT(*) c FROM audit_log WHERE table_name='inquiries' AND record_id=?", [inqRow.inquiry_id]);
        const pr = await api('PUT', `/api/admin/inquiries/${inqRow.inquiry_id}/priority`, { priority: 'high' });
        check('inquiry priority change returns last_updated', pr.body && pr.body.success && hasLastUpdated(pr.body), JSON.stringify(pr.body));
        const after = await q("SELECT * FROM audit_log WHERE table_name='inquiries' AND record_id=? ORDER BY id DESC", [inqRow.inquiry_id]);
        const delta = after.length - before[0].c;
        check('inquiry priority change writes exactly one new audit_log row', delta === 1, `delta=${delta}`);
        check('inquiry audit_log row has actor_role', !!(after[0] && after[0].actor_role), JSON.stringify(after[0]));
    } else {
        check('inquiry priority change (skipped — no inquiry in fixture DB)', true, '');
    }

    // ── Bookings: trigger-covered — verify the removed parallel explicit insert didn't leave a
    // double-write on the primary status-change path. Pre-fix, applyStatusChange() inserted its own
    // audit_log row on top of the one the trigger already wrote for every save — this is the
    // regression this test guards against. EXPIRED -> PENDING has no other bookings-table side
    // effects (unlike CANCELLED, which cascades into further UPDATEs on the same row).
    const bkRow = await one("SELECT id FROM bookings WHERE status = 'EXPIRED' LIMIT 1");
    if (bkRow) {
        const before = await q("SELECT COUNT(*) c FROM audit_log WHERE table_name='bookings' AND record_id=?", [bkRow.id]);
        const st = await api('PUT', `/api/admin/bookings/${bkRow.id}`, { status: 'PENDING', reason: 'audit test' });
        check('booking status change returns last_updated', st.body && st.body.success && hasLastUpdated(st.body), JSON.stringify(st.body));
        const after = await q("SELECT * FROM audit_log WHERE table_name='bookings' AND record_id=? ORDER BY id DESC", [bkRow.id]);
        const delta = after.length - before[0].c;
        check('booking status change writes exactly one new audit_log row (no duplicate insert)', delta === 1, `delta=${delta}`);
        check('booking status change audit_log row has actor_role', !!(after[0] && after[0].actor_role), JSON.stringify(after[0]));
    } else {
        check('booking status change (skipped — no EXPIRED booking in fixture DB)', true, '');
    }

    // ── Newsletter: pre-existing created_by/modified_by columns (frontend-only per plan) — the
    // route must still return last_updated when a real field changes.
    const subRow = await one("SELECT subscriber_id FROM newsletter_subscribers LIMIT 1");
    if (subRow) {
        const subUpd = await api('PUT', `/api/admin/newsletter/subscribers/${subRow.subscriber_id}`, { internal_notes: 'Audit history test note' });
        check('newsletter subscriber update returns last_updated', subUpd.body && subUpd.body.success && hasLastUpdated(subUpd.body), JSON.stringify(subUpd.body));
    } else {
        check('newsletter subscriber update (skipped — no subscriber in fixture DB)', true, '');
    }

    // ── GET /api/admin/audit_log: record_id filter + actor-name join ──
    const al = await api('GET', `/api/admin/audit_log?table=admins&record_id=${u.body.id}`);
    check('audit_log table+record_id filter succeeds', !!(al.body && al.body.success), JSON.stringify(al.body));
    const onlyThisRecord = (al.body.logs || []).every(l => String(l.record_id) === String(u.body.id) && l.table_name === 'admins');
    check("audit_log table+record_id filter returns only this record's rows", onlyThisRecord, JSON.stringify(al.body.logs));
    const joined = (al.body.logs || []).find(l => l.actor_full_name || l.actor_username);
    check('audit_log join resolves an actor name for numeric changed_by rows', !!joined, JSON.stringify(al.body.logs));

    // A bare record_id with no table is meaningless (ids aren't unique across tables) — must be
    // ignored as a filter, not crash and not silently mis-filter the whole table.
    const alBare = await api('GET', `/api/admin/audit_log?record_id=${u.body.id}`);
    check('audit_log bare record_id (no table) does not crash', !!(alBare.body && alBare.body.success), JSON.stringify(alBare.body));
    check('audit_log bare record_id (no table) is ignored, not applied as a filter', (alBare.body.total || 0) > (al.body.total || 0), `bare total=${alBare.body.total} filtered total=${al.body.total}`);
};
