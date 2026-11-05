// Notification Centre - Phase 2 operations events through the REAL routes on the test server (docs-internal/notifications.md):
//   A. a contact-form enquiry -> "New enquiry" (Action required, visible to an assistant); marking it replied resolves it
//   B. a public booking request -> "New booking request"; moving the booking on resolves it; every status change is in the Activity Log
//   C. cancelling -> "Booking cancelled" with the refund due
//   D. contact details changed -> before / after kept, shown to administrators only, hidden from an assistant
//   E. a booking moved to another date -> "Booking moved"
//   F. an event cancelled -> "Event cancelled" (managers yes, assistants no); creation is Activity only
// Nothing real is sent (SMTP mock). Every check targets the records created here.
const MARK = 'NTFOPS' + Date.now().toString(36);
let seq = 0;
// far-future dates in a randomised band, so nothing created by the other suites (they share one test database) can clash
const BAND = 1500 + (Date.now() % 300);
const email = () => `ntfops.${Date.now()}.${seq++}@example.invalid`;

module.exports = async function ({ check, api, pub, one, q, sleep, future, loginAs }) {
    const poll = async (sql, params, ok = (r) => !!r, tries = 40) => {
        let row = null;
        for (let i = 0; i < tries; i++) { row = await one(sql, params); if (ok(row)) return row; await sleep(150); }
        return row;
    };
    const incident = (event, entityId) => poll(`SELECT * FROM admin_notifications WHERE event_type = ? AND entity_id = ? ORDER BY id DESC LIMIT 1`, [event, String(entityId)]);
    const asManager = await loginAs('manager');
    const asAssistant = await loginAs('assistant');

    // ── A. enquiry ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
    const enqEmail = email();
    const form = await pub('POST', '/send-email', { name: `${MARK} Enquirer`, email: enqEmail, cell: '+27821234567', category: 'General Inquiry', subject: `${MARK} subject`, message: 'A question about availability next month.', popia_consent: true });
    check('A contact-form message is accepted', form.status === 200, JSON.stringify(form.body));
    const inq = await poll('SELECT inquiry_id FROM inquiries WHERE LOWER(sender_email) = LOWER(?)', [enqEmail]);
    const enq = inq ? await incident('bookings.enquiry_received', inq.inquiry_id) : null;
    check('A it becomes an Action-required "New enquiry" linking to Inquiries and that enquiry', enq && enq.kind === 'action' && enq.status === 'open' && /inquiriesAdmin/.test(enq.link_json) && enq.title.includes(MARK), JSON.stringify(enq));
    check('A the name is stored as plain text (decoded once)', enq && !/&#x27;|&amp;/.test(enq.title));
    const aView = enq ? await asAssistant('GET', `/api/admin/notifications/${enq.id}`) : { status: 0 };
    check('A an assistant can see enquiries', aView.status === 200, aView.status);
    if (inq) await api('PUT', `/api/admin/inquiries/${inq.inquiry_id}/status`, { status: 'replied' });
    const enqDone = enq ? await poll('SELECT * FROM admin_notifications WHERE id = ?', [enq.id], (r) => r && r.status === 'resolved') : null;
    check('A marking the enquiry replied resolves it (by that admin)', enqDone && enqDone.status === 'resolved' && enqDone.resolved_by && /replied/i.test(enqDone.resolution_note || ''), JSON.stringify(enqDone));

    // ── B. booking request ─────────────────────────────────────────────────────────────────────────────────────────────────────────
    const svc = await one('SELECT id FROM services WHERE is_active = 1 AND COALESCE(is_deleted, 0) = 0 ORDER BY id LIMIT 1');
    const bkEmail = email();
    const created = await pub('POST', '/api/public/bookings', {
        name: `${MARK} O'Brien & Sons`, email: bkEmail, cell: '+27821234567', event_date: future(BAND), event_name: `${MARK} Gala`,
        event_location: 'Test Hall', event_type: 'Corporate', message: 'Notification centre operations test booking.',
        services: [{ service_id: svc ? svc.id : 1 }], popia_consent: true
    });
    const bookingId = created.body && created.body.booking_id;
    check('B a public booking request is accepted', !!bookingId, `${created.status} ${JSON.stringify(created.body)}`);
    if (bookingId) {
        const req = await incident('bookings.request_received', bookingId);
        check('B it becomes an Action-required "New booking request" (medium) linking to the booking', req && req.kind === 'action' && req.priority === 'medium' && /"type":"booking"/.test(req.link_json), JSON.stringify(req));
        check('B the client name reads O\'Brien & Sons - decoded once, no entity junk', req && req.title.includes("O'Brien & Sons"), req && req.title);
        check('B it did not e-mail (the existing admin booking e-mail stays the only one)', req && req.email_state === 'skipped', req && req.email_state);

        const st = await api('PUT', `/api/admin/bookings/${bookingId}/status`, { status: 'PENDING' });
        check('B status change accepted', st.status === 200, JSON.stringify(st.body));
        const act = await poll(`SELECT * FROM activity_log WHERE event_type = 'bookings.status_changed' AND entity_id = ? ORDER BY id DESC LIMIT 1`, [String(bookingId)]);
        check('B every status change is in the Activity Log with who did it', act && act.actor_type === 'admin' && /→ PENDING/.test(act.summary), JSON.stringify(act));
        check('B moving to PENDING (still waiting for a quote) leaves the request open', (await one('SELECT status FROM admin_notifications WHERE id = ?', [req.id])).status === 'open');

        // ── C. cancel ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
        const cn = await api('PUT', `/api/admin/bookings/${bookingId}/status`, { status: 'CANCELLED', reason: `${MARK} client changed plans` });
        check('C cancelling accepted', cn.status === 200, JSON.stringify(cn.body));
        const reqDone = await poll('SELECT * FROM admin_notifications WHERE id = ?', [req.id], (r) => r && r.status === 'resolved');
        check('C the waiting request closes itself when the booking moves on', reqDone && reqDone.status === 'resolved' && /CANCELLED/.test(reqDone.resolution_note || ''), JSON.stringify(reqDone));
        const can = await incident('bookings.cancelled', bookingId);
        check('C "Booking cancelled" appears (Attention, high) with the reason and the refund position', can && can.kind === 'attention' && can.priority === 'high' && /refund/i.test(can.body || '') && (can.body || '').includes(MARK), JSON.stringify(can));
    }

    // ── D. contact change (admin) ──────────────────────────────────────────────────────────────────────────────────────────────────
    const adm = await api('POST', '/api/admin/bookings', {
        name: `${MARK} Contact`, email: email(), cell: '+27821234567', event_date: future(BAND + 3), event_name: `${MARK} Contact Event`, event_type: 'Corporate',
        event_location: 'Test Hall', message: 'Notification centre contact test booking.', services: [{ service_id: svc ? svc.id : 1 }], status: 'NEW', override_working_hours: true
    });
    const b2 = adm.body && adm.body.booking_id;
    check('D an admin booking for the contact test is created', !!b2, JSON.stringify(adm.body));
    if (b2) {
        const up = await api('PUT', `/api/admin/bookings/${b2}/contact`, { cell: '+27829990000' });
        check('D contact update accepted', up.status === 200, JSON.stringify(up.body));
        const cc = await incident('customer.contact_changed', b2);
        check('D "Contact details changed" appears naming the field', cc && cc.kind === 'attention' && /cell|phone/i.test(cc.body || ''), JSON.stringify(cc));
        const asAdmin = cc ? await api('GET', `/api/admin/notifications/${cc.id}`) : null;
        check('D administrators see the previous and new value', asAdmin && asAdmin.body.notification.details && JSON.stringify(asAdmin.body.notification.details).includes('+27829990000') && JSON.stringify(asAdmin.body.notification.details).includes('+27821234567'), JSON.stringify(asAdmin && asAdmin.body));
        const asMgr = cc ? await asManager('GET', `/api/admin/notifications/${cc.id}`) : null;
        check('D a manager sees the alert but not the values', asMgr && asMgr.status === 200 && asMgr.body.notification.details === undefined, JSON.stringify(asMgr && asMgr.body));
        check('D an assistant does not see customer-detail changes', cc && (await asAssistant('GET', `/api/admin/notifications/${cc.id}`)).status === 404);

        // ── E. moved date ──────────────────────────────────────────────────────────────────────────────────────────────────────────
        const newDate = future(BAND + 6);
        const mv = await api('PATCH', `/api/admin/bookings/${b2}/date`, { date: newDate });
        check('E moving the booking date accepted', mv.status === 200, JSON.stringify(mv.body));
        const rs = await poll(`SELECT * FROM admin_notifications WHERE event_type = 'bookings.rescheduled' AND entity_id = ? ORDER BY id DESC LIMIT 1`, [String(b2)]);
        check('E "Booking moved" names the new date', rs && rs.title.includes(newDate), JSON.stringify(rs));
        await api('PUT', `/api/admin/bookings/${b2}/status`, { status: 'CANCELLED', reason: 'test clean-up' });
    }

    // ── F. events ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
    const ev = await api('POST', '/api/admin/events', { event_title: `${MARK} Show`, event_datetime: `${future(BAND + 9)}T19:00`, event_type: 'Corporate Event', venue_name: 'Test Venue', event_status: 'upcoming', sync_to_gcal: false });
    check('F event created', ev.body && ev.body.success, JSON.stringify(ev.body));
    if (ev.body && ev.body.id) {
        const evAct = await poll(`SELECT * FROM activity_log WHERE event_type = 'events.created' AND entity_id = ?`, [String(ev.body.id)]);
        check('F creating an event is recorded in the Activity Log (not a notification)', !!evAct && !(await one(`SELECT id FROM admin_notifications WHERE event_type = 'events.created' AND entity_id = ?`, [String(ev.body.id)])), JSON.stringify(evAct));
        const cx = await api('PUT', `/api/admin/events/${ev.body.id}`, { event_title: `${MARK} Show`, event_datetime: `${future(BAND + 9)}T19:00`, event_type: 'Corporate Event', venue_name: 'Test Venue', event_status: 'cancelled', cancellation_reason: 'Venue flooded', sync_to_gcal: false });
        check('F cancelling the event accepted', cx.body && cx.body.success, JSON.stringify(cx.body));
        const ec = await incident('events.cancelled', ev.body.id);
        check('F "Event cancelled" appears (high) with the reason and says sales were closed', ec && ec.priority === 'high' && /Venue flooded/.test(ec.body || '') && /closed/i.test(ec.body || ''), JSON.stringify(ec));
        check('F a manager sees event alerts', ec && (await asManager('GET', `/api/admin/notifications/${ec.id}`)).status === 200);
        check('F an assistant does not', ec && (await asAssistant('GET', `/api/admin/notifications/${ec.id}`)).status === 404);
        const again = await api('PUT', `/api/admin/events/${ev.body.id}`, { event_title: `${MARK} Show`, event_datetime: `${future(BAND + 9)}T19:00`, event_type: 'Corporate Event', venue_name: 'Test Venue', event_status: 'cancelled', cancellation_reason: 'Venue flooded', sync_to_gcal: false });
        await sleep(400);
        const nCx = (await q(`SELECT id FROM admin_notifications WHERE event_type = 'events.cancelled' AND entity_id = ?`, [String(ev.body.id)])).length;
        check('F saving an already-cancelled event again does not raise a second alert', again.body && again.body.success && nCx === 1, nCx);
    }
};
