// Coverage for the Booking<->Calendar workflow audit: DB hardening (CP1), Google Calendar ID
// nulling after delete (CP2), status-transition <-> event-sync consistency (CP3-4), venue/review
// propagation fixes (CP5-6), the missing conflict check on booking-linked event edits (CP7), and the
// public/private events conflation bug (CP8) — a CONFIRMED private booking's auto-generated calendar
// shadow row was leaking onto the public tour-dates page.
const support = require('./support');
const { api, pub, one, q, future, sleep, getTrackingToken } = support;
const sqlite3 = require('sqlite3');

// Direct read-write handle to the isolated TEST_DB, so the DB-level trigger can be asserted
// independently of any route-level validation that duplicates the same rule.
const rw = new sqlite3.Database(support.TEST_DB);
const run = (sql, params = []) => new Promise((res, rej) => rw.run(sql, params, function (e) { e ? rej(e) : res(this); }));

const SVC = 15; // 'Travel Buyout – Gauteng' (active, flat fee, zero lead time) — see booking.test.js
let seq = 0;
const email = () => `cal.test.${Date.now()}.${seq++}@example.invalid`;

async function makeAccepted(amount, days, em) {
    const created = await api('POST', '/api/admin/bookings', {
        name: 'Calendar Test', email: em, cell: '+27821234567', event_date: future(days),
        event_name: 'Calendar Test Event', event_type: 'Corporate', event_location: 'Test Hall',
        message: 'Booking<->Calendar audit integration test, over ten characters.',
        services: [{ service_id: SVC }], status: 'NEW', override_working_hours: true,
    });
    const id = created.body && created.body.booking_id;
    await sleep(50);
    const bk = await one('SELECT date FROM bookings WHERE id=?', [id]);
    const expiry = new Date(Date.parse(bk.date) - 10 * 86400000).toISOString().slice(0, 10);
    await api('POST', `/api/admin/bookings/${id}/quote`, {
        quote_expiry_date: expiry, terms: 'T', apply_vat: false, discount: 0,
        items: [{ service_id: SVC, description: 'Travel Buyout – Gauteng', quantity: 1, unit_price: amount }],
    });
    const token = await getTrackingToken(id, em);
    await pub('POST', `/api/public/bookings/${id}/accept-quote`, { access_token: token, terms_agreed: true });
    return id;
}

async function makeConfirmed(days) {
    const id = await makeAccepted(1000, days, email());
    await api('PUT', `/api/admin/bookings/${id}/manual-payment`, { amount_paid: 500 });
    await sleep(200);
    const row = await one('SELECT status, event_id FROM bookings WHERE id=?', [id]);
    return { id, eventId: row.event_id, status: row.status };
}

// Date offsets in this file all live in the 500+ range, spaced well apart — other test files
// (booking.test.js, contract.test.js, inquiries.test.js) already claim various offsets in the
// 30-300 range for their own bookings, and since every *.test.js shares one server/DB per npm test
// run, a same-day collision trips the real (and correct) booking conflict check across files.
module.exports = async function ({ check }) {
    // ── CP1: events.event_status has a real DB-level guard, matching invoices/contracts/etc ──
    const { id: cp1Id, eventId: cp1EventId } = await makeConfirmed(510);
    check('CP1: CONFIRMED booking has an auto-created event (precondition)', !!cp1EventId, cp1EventId);
    let cp1TriggerRejected = false;
    try { await run("UPDATE events SET event_status = 'not_a_real_status' WHERE event_id = ?", [cp1EventId]); }
    catch (e) { cp1TriggerRejected = /must be one of/i.test(e.message); }
    check('CP1: BEFORE UPDATE trigger rejects an invalid events.event_status', cp1TriggerRejected, 'expected RAISE(ABORT) from the statusGuard trigger');

    // ── CP1: date_holds now has an audit trail ──
    const holdIns = await run("INSERT INTO date_holds (hold_date, hold_expires_at, status, block_type, notes) VALUES (?, ?, 'active', 'personal', 'audit test')", [future(520), future(521)]);
    const holdAudit = await one("SELECT * FROM audit_log WHERE table_name = 'date_holds' AND record_id = ? AND action = 'INSERT'", [holdIns.lastID]);
    check('CP1: audit_log INSERT row written for a new date_holds row', !!holdAudit, JSON.stringify(holdAudit));
    await run("DELETE FROM date_holds WHERE id = ?", [holdIns.lastID]);
    const holdDeleteAudit = await one("SELECT * FROM audit_log WHERE table_name = 'date_holds' AND record_id = ? AND action = 'DELETE'", [holdIns.lastID]);
    check('CP1: audit_log DELETE row written when a date_holds row is removed', !!holdDeleteAudit, JSON.stringify(holdDeleteAudit));

    // ── CP2: google_event_id is nulled after cancellation (not left permanently stale) ──
    const { id: cp2Id } = await makeConfirmed(530);
    await run("UPDATE bookings SET google_event_id = 'fake-google-id-for-test' WHERE id = ?", [cp2Id]);
    const cancelRes = await api('POST', `/api/admin/bookings/${cp2Id}/cancel`, { reason: 'CP2 test cancellation' });
    check('CP2: cancel endpoint 200', cancelRes.status === 200, JSON.stringify(cancelRes.body));
    const afterCancel = await one('SELECT google_event_id FROM bookings WHERE id = ?', [cp2Id]);
    check('CP2: google_event_id nulled after cancel (no permanent silent re-sync failure)', afterCancel.google_event_id === null, JSON.stringify(afterCancel));

    // ── CP3: applyStatusChange's COMPLETED branch now advances the linked event ──
    // (a non-near date — the quote's required expiry, event date minus 10 days, would otherwise fall
    // in the past and silently fail quote creation, leaving the booking stuck at NEW)
    const { id: cp3Id, eventId: cp3EventId } = await makeConfirmed(540);
    await run("UPDATE bookings SET amount_outstanding = 0 WHERE id = ?", [cp3Id]);
    const completeRes = await api('PUT', `/api/admin/bookings/${cp3Id}/status`, { status: 'COMPLETED' });
    check('CP3: PUT /:id/status to COMPLETED -> 200', completeRes.status === 200, JSON.stringify(completeRes.body));
    await sleep(150);
    const cp3Event = await one('SELECT event_status FROM events WHERE event_id = ?', [cp3EventId]);
    check('CP3: linked event advanced to completed via the generic status route (parity fix)', !!cp3Event && cp3Event.event_status === 'completed', JSON.stringify(cp3Event));

    // ── CP4: both cancellation paths now leave fully consistent, symmetric state ──
    const { id: cp4aId, eventId: cp4aEventId } = await makeConfirmed(550);
    await api('PUT', `/api/admin/bookings/${cp4aId}/status`, { status: 'CANCELLED' });
    await sleep(150);
    const cp4aBooking = await one('SELECT event_id FROM bookings WHERE id = ?', [cp4aId]);
    const cp4aEvent = await one('SELECT booking_id, event_status FROM events WHERE event_id = ?', [cp4aEventId]);
    check('CP4a (applyStatusChange CANCELLED path): bookings.event_id cleared', cp4aBooking.event_id === null, JSON.stringify(cp4aBooking));
    check('CP4a: events.booking_id ALSO cleared (previously only one side was)', cp4aEvent.booking_id === null, JSON.stringify(cp4aEvent));
    check('CP4a: linked event demoted to draft', cp4aEvent.event_status === 'draft', JSON.stringify(cp4aEvent));

    const { id: cp4bId, eventId: cp4bEventId } = await makeConfirmed(560);
    await api('POST', `/api/admin/bookings/${cp4bId}/cancel`, { reason: 'CP4b test' });
    await sleep(150);
    const cp4bBooking = await one('SELECT event_id FROM bookings WHERE id = ?', [cp4bId]);
    const cp4bEvent = await one('SELECT booking_id, event_status FROM events WHERE event_id = ?', [cp4bEventId]);
    check('CP4b (POST /:id/cancel path): bookings.event_id cleared (previously left dangling)', cp4bBooking.event_id === null, JSON.stringify(cp4bBooking));
    check('CP4b: events.booking_id cleared', cp4bEvent.booking_id === null, JSON.stringify(cp4bEvent));
    check('CP4b: linked event demoted to draft (previously stayed upcoming — public listing kept showing a cancelled show)', cp4bEvent.event_status === 'draft', JSON.stringify(cp4bEvent));

    // ── CP5: free-text venue PATCH now propagates to the linked event ──
    const { id: cp5Id, eventId: cp5EventId } = await makeConfirmed(570);
    const venuePatch = await api('PATCH', `/api/admin/bookings/${cp5Id}/venue`, { event_location: 'CP5 New Venue Name', venue_address: '123 Test Street' });
    check('CP5: venue PATCH -> 200', venuePatch.status === 200, JSON.stringify(venuePatch.body));
    const cp5Event = await one('SELECT venue_name FROM events WHERE event_id = ?', [cp5EventId]);
    check('CP5: linked event.venue_name updated (previously stayed stale)', !!cp5Event && cp5Event.venue_name === 'CP5 New Venue Name', JSON.stringify(cp5Event));

    // ── CP6: manual review-request stamps review_email_sent_at (prevents a duplicate cron send) ──
    const { id: cp6Id } = await makeConfirmed(580); // see CP3 comment re: near dates + quote expiry
    await run("UPDATE bookings SET status = 'COMPLETED', amount_outstanding = 0 WHERE id = ?", [cp6Id]);
    const reviewRes = await api('POST', `/api/admin/bookings/${cp6Id}/review-request`, {});
    check('CP6: manual review-request -> 200', reviewRes.status === 200, JSON.stringify(reviewRes.body));
    const cp6Booking = await one('SELECT review_email_sent_at FROM bookings WHERE id = ?', [cp6Id]);
    check('CP6: review_email_sent_at stamped (previously left NULL -> duplicate cron send)', !!cp6Booking.review_email_sent_at, JSON.stringify(cp6Booking));

    // ── CP7: editing a booking-linked event's date via the full edit form now re-checks conflicts ──
    const { id: cp7aId } = await makeConfirmed(590);
    const cp7aBooking = await one('SELECT date, event_start_time FROM bookings WHERE id = ?', [cp7aId]);
    const { id: cp7bId, eventId: cp7bEventId } = await makeConfirmed(591); // adjacent date, will be moved into conflict below
    const cp7Event = await one('SELECT event_title, event_type FROM events WHERE event_id = ?', [cp7bEventId]);
    const conflictingDatetime = `${cp7aBooking.date}T${(cp7aBooking.event_start_time || '18:00').substring(0, 5)}`;
    const eventEditRes = await api('PUT', `/api/admin/events/${cp7bEventId}`, {
        event_title: cp7Event.event_title || 'Test Event', event_datetime: conflictingDatetime, event_type: cp7Event.event_type || '',
        sync_to_gcal: false,
    });
    check('CP7: moving a booking-linked event into an occupied slot is now rejected -> 409 (previously had zero conflict check)', eventEditRes.status === 409, JSON.stringify(eventEditRes.body));

    // ── CP8: a CONFIRMED private booking's auto-created event no longer leaks onto the public listing ──
    const { id: cp8Id, eventId: cp8EventId } = await makeConfirmed(610);
    const publicEventsBefore = await pub('GET', '/api/public/events?limit=200');
    const leaked = (publicEventsBefore.body || []).some(e => String(e.event_id) === String(cp8EventId));
    check('CP8: private CONFIRMED booking\'s shadow event does NOT appear on the public events endpoint', !leaked, `event_id=${cp8EventId} present=${leaked}`);

    // Promoting the same booking to public SHOULD make it (or a new events row) appear.
    const promoteRes = await api('PUT', `/api/admin/bookings/${cp8Id}/public`, { is_public: true });
    check('CP8: promote-to-public -> 200', promoteRes.status === 200, JSON.stringify(promoteRes.body));
    const promotedBooking = await one('SELECT event_id FROM bookings WHERE id = ?', [cp8Id]);
    // Promoted events start life as 'draft' (an admin must explicitly advance them) — flip it live to
    // assert the public-listing filter's positive case, not just its negative case above.
    await run("UPDATE events SET event_status = 'upcoming' WHERE event_id = ?", [promotedBooking.event_id]);
    const publicEventsAfter = await pub('GET', '/api/public/events?limit=200');
    const nowVisible = (publicEventsAfter.body || []).some(e => String(e.event_id) === String(promotedBooking.event_id));
    check('CP8: explicitly promoted + live event DOES appear on the public events endpoint', nowVisible, `event_id=${promotedBooking.event_id} present=${nowVisible}`);

    // ── CP8: admin Events tab default view also excludes private shadow rows, incl. from KPI count ──
    const { eventId: cp8bEventId } = await makeConfirmed(630);
    const adminEventsDefault = await api('GET', '/api/admin/events?limit=500');
    const shownByDefault = (adminEventsDefault.body || []).some(e => String(e.event_id) === String(cp8bEventId));
    check('CP8: admin Events tab default view excludes a private booking shadow row', !shownByDefault, `event_id=${cp8bEventId} present=${shownByDefault}`);
    const adminEventsIncludePrivate = await api('GET', '/api/admin/events?limit=500&include_private=1');
    const shownWithFlag = (adminEventsIncludePrivate.body || []).some(e => String(e.event_id) === String(cp8bEventId));
    check('CP8: admin Events tab ?include_private=1 still shows it (escape hatch preserved)', shownWithFlag, `event_id=${cp8bEventId} present=${shownWithFlag}`);

    // ── CP17: dragging a standalone event's date now re-syncs its OWN Google Calendar entry ──
    // (previously only a linked booking's GCal copy got refreshed; a standalone event's never did).
    // GOOGLE_REFRESH_TOKEN is a deliberately-bogus test-mode value (see support.js), so the real
    // Google API call always fails - but syncEventToCalendar() logs either a success or failure line
    // for this exact event_id either way, which is enough to prove the call actually happened.
    const cp17Create = await api('POST', '/api/admin/events', {
        event_title: 'CP17 Standalone Event', event_datetime: `${future(680)}T18:00`,
        venue_name: 'Test Venue', event_type: 'Comedy Club', sync_to_gcal: false,
    });
    check('CP17: standalone event created -> 200', cp17Create.status === 200 && cp17Create.body.success, JSON.stringify(cp17Create.body));
    const cp17EventId = cp17Create.body.id;
    const cp17DateRes = await api('PATCH', `/api/admin/events/${cp17EventId}/date`, { date: future(681), time: '19:00' });
    check('CP17: drag-reschedule date PATCH -> 200', cp17DateRes.status === 200 && cp17DateRes.body.success, JSON.stringify(cp17DateRes.body));
    await sleep(300);
    const cp17Log = support.getChildLog();
    // syncEventToCalendar() logs one of these two lines for this exact event_id no matter which way
    // the real Google API call resolves — the bogus test-mode refresh token means the error line is
    // the expected outcome, but either proves the function was actually invoked (not silently skipped).
    const cp17SyncAttempted = cp17Log.includes(`Error syncing event #${cp17EventId} to GCal`) || cp17Log.includes(`GCal Event for Event #${cp17EventId}`);
    check('CP17: syncEventToCalendar was actually invoked after the drag (not silently skipped)', cp17SyncAttempted, cp17Log.slice(-800));

    // ── CP18: standalone events are now checked against EACH OTHER for scheduling conflicts ──
    // (previously checkEventConflicts only queried bookings and date_holds, never other events).
    const cp18Create = await api('POST', '/api/admin/events', {
        event_title: 'CP18 Base Event', event_datetime: `${future(690)}T18:00`,
        venue_name: 'Test Venue', event_type: 'Comedy Club', sync_to_gcal: false,
    });
    check('CP18: base event created -> 200', cp18Create.status === 200 && cp18Create.body.success, JSON.stringify(cp18Create.body));
    const cp18Overlap = await api('POST', '/api/admin/events', {
        event_title: 'CP18 Overlapping Event', event_datetime: `${future(690)}T18:30`,
        venue_name: 'Other Venue', event_type: 'Comedy Club', sync_to_gcal: false,
    });
    check('CP18: a second standalone event in an overlapping slot is now rejected -> 409', cp18Overlap.status === 409, JSON.stringify(cp18Overlap.body));
    const cp18Clear = await api('POST', '/api/admin/events', {
        event_title: 'CP18 Non-overlapping Event', event_datetime: `${future(690)}T21:00`,
        venue_name: 'Other Venue', event_type: 'Comedy Club', sync_to_gcal: false,
    });
    check('CP18: a non-overlapping same-day event is still allowed -> 200', cp18Clear.status === 200 && cp18Clear.body.success, JSON.stringify(cp18Clear.body));

    // ── CP19: creating a standalone event with block_type:'booking' now links BOTH directions ──
    // (previously bookings.event_id pointed at the event, but events.booking_id was left NULL,
    // so any later lookup FROM the event's side — cancel/complete/venue cascades — found nothing).
    const cp19Create = await api('POST', '/api/admin/events', {
        event_title: 'CP19 Event With Placeholder Booking', event_datetime: `${future(700)}T18:00`,
        venue_name: 'Test Venue', event_type: 'Comedy Club', block_type: 'booking', sync_to_gcal: false,
    });
    check('CP19: event with block_type:booking created -> 200', cp19Create.status === 200 && cp19Create.body.success, JSON.stringify(cp19Create.body));
    await sleep(200);
    const cp19Event = await one('SELECT booking_id FROM events WHERE event_id = ?', [cp19Create.body.id]);
    check('CP19: events.booking_id now points back at the placeholder booking (previously NULL)', !!(cp19Event && cp19Event.booking_id), JSON.stringify(cp19Event));
    if (cp19Event && cp19Event.booking_id) {
        const cp19Booking = await one('SELECT event_id FROM bookings WHERE id = ?', [cp19Event.booking_id]);
        check('CP19: the placeholder booking\'s event_id points back at the same event (bidirectional)', String(cp19Booking.event_id) === String(cp19Create.body.id), JSON.stringify(cp19Booking));
    }

    // ── CP20: deleting an event that has a linked hold (block_type:'hold') no longer 500s ──
    // (foreign_keys=ON means date_holds.event_id referencing a deleted events row used to throw a
    // bare FOREIGN KEY constraint error instead of deleting).
    const cp20Create = await api('POST', '/api/admin/events', {
        event_title: 'CP20 Event With Hold', event_datetime: `${future(710)}T18:00`,
        venue_name: 'Test Venue', event_type: 'Comedy Club', block_type: 'hold', sync_to_gcal: false,
    });
    check('CP20: event with block_type:hold created -> 200', cp20Create.status === 200 && cp20Create.body.success, JSON.stringify(cp20Create.body));
    const cp20HoldBefore = await one('SELECT id FROM date_holds WHERE event_id = ?', [cp20Create.body.id]);
    check('CP20: a date_holds row was created and linked to the event (precondition)', !!cp20HoldBefore, JSON.stringify(cp20HoldBefore));
    const cp20Delete = await api('DELETE', `/api/admin/events/${cp20Create.body.id}`);
    check('CP20: deleting the event no longer fails with a FK constraint error -> 200', cp20Delete.status === 200 && cp20Delete.body.success, JSON.stringify(cp20Delete.body));
    const cp20HoldAfter = await one('SELECT id, event_id FROM date_holds WHERE id = ?', [cp20HoldBefore.id]);
    check('CP20: the hold itself survives, un-linked (event_id nulled, not orphaned-dangling)', cp20HoldAfter && cp20HoldAfter.event_id === null, JSON.stringify(cp20HoldAfter));

    // ── CP21: cancelling an event now always drops its Google Calendar entry ──
    // (bulk cancel / the single Cancel-event modal both pass sync_to_gcal:false, which used to skip
    // this cleanup entirely — the event stayed live on the calendar even though the app now called it
    // cancelled).
    const cp21Create = await api('POST', '/api/admin/events', {
        event_title: 'CP21 Event To Cancel', event_datetime: `${future(720)}T18:00`,
        venue_name: 'Test Venue', event_type: 'Comedy Club', sync_to_gcal: false,
    });
    await run("UPDATE events SET google_calendar_event_id = 'fake-gcal-id-for-test' WHERE event_id = ?", [cp21Create.body.id]);
    const cp21Cancel = await api('PUT', `/api/admin/events/${cp21Create.body.id}`, {
        event_title: 'CP21 Event To Cancel', event_datetime: `${future(720)}T18:00`,
        venue_name: 'Test Venue', event_type: 'Comedy Club', event_status: 'cancelled', sync_to_gcal: false,
    });
    check('CP21: cancel via PUT (sync_to_gcal:false, matching the real bulk/modal call) -> 200', cp21Cancel.status === 200 && cp21Cancel.body.success, JSON.stringify(cp21Cancel.body));
    const cp21After = await one('SELECT google_calendar_event_id FROM events WHERE event_id = ?', [cp21Create.body.id]);
    check('CP21: google_calendar_event_id cleared on cancel, regardless of sync_to_gcal (previously left stale)', cp21After && cp21After.google_calendar_event_id === null, JSON.stringify(cp21After));
};
