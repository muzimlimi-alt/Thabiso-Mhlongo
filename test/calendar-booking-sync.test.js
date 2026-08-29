// Characterisation test for the calendar-sync half of Phase 2's "booking lifecycle" coverage:
// confirm, reschedule and cancel must each actually invoke a Google Calendar sync attempt for a
// BOOKING (not a standalone event — calendar.test.js's CP17 already proves this for a standalone
// event's reschedule, but nothing in the suite proves it for a booking's own confirm/reschedule/
// cancel specifically).
//
// What this test can and cannot prove, and why:
//   - server.js requires googleapis's `calendar` client as a bare module-level const (see
//     server.js ~line 103) and support.js always runs the app in a separate CHILD PROCESS
//     (spawn(), not require() — see support.js's spawnAndWait()). There is no seam this test
//     process can reach into to replace that client with a mock, so "mock the Google API and
//     assert the request payloads sent" — the literal wording of the housekeeping plan's Phase 2
//     Step 2 item 6 — is not achievable without changing server.js itself to accept an injectable
//     calendar client or a configurable API base URL. Phase 2's own rule ("do not refactor
//     anything to make testing easier... note it and leave it untested for now") applies directly
//     here; this gap is recorded in HOUSEKEEPING-NOTES.md rather than worked around.
//   - What IS achievable, and what this file proves instead: syncBookingToCalendar() /
//     deleteGoogleEvent() were actually INVOKED for this exact booking on each of the three
//     transitions, by matching the id-specific log line each one emits (success or failure —
//     GOOGLE_REFRESH_TOKEN is a deliberately-invalid test-mode value per support.js, so failure is
//     the expected outcome, but either line proves the call happened rather than being silently
//     skipped). This is the same technique calendar.test.js's CP17 already uses.
const { api, pub, one, future, sleep, getTrackingToken, getChildLog } = require('./support');

const SVC = 15; // 'Travel Buyout – Gauteng' (active, flat fee, zero lead time) — see booking.test.js
const email = () => `calsync.${Date.now()}@example.invalid`;

// Date offsets 900-910 are reserved for this file (see calendar.test.js's comment on why offsets
// must not collide across *.test.js files sharing one server/DB per npm test run).
module.exports = async function ({ check }) {
    const em = email();
    const created = await api('POST', '/api/admin/bookings', {
        name: 'Cal Sync Test', email: em, cell: '+27821234567', event_date: future(900),
        event_name: 'Cal Sync Event', event_type: 'Corporate', event_location: 'Test Hall',
        message: 'Booking calendar-sync evidence test.',
        services: [{ service_id: SVC }], status: 'NEW', override_working_hours: true,
    });
    const id = created.body && created.body.booking_id;
    check('fixture: booking created', !!id, JSON.stringify(created.body));
    if (!id) return;

    await sleep(50);
    const bk = await one('SELECT date FROM bookings WHERE id=?', [id]);
    const expiry = new Date(Date.parse(bk.date) - 10 * 86400000).toISOString().slice(0, 10);
    await api('POST', `/api/admin/bookings/${id}/quote`, {
        quote_expiry_date: expiry, terms: 'T', apply_vat: false, discount: 0,
        items: [{ service_id: SVC, description: 'Travel Buyout – Gauteng', quantity: 1, unit_price: 1000 }],
    });
    const token = await getTrackingToken(id, em);
    await pub('POST', `/api/public/bookings/${id}/accept-quote`, { access_token: token, terms_agreed: true });

    // ── 1. Confirm: full manual payment reaches CONFIRMED, which calls syncBookingToCalendar() ──
    await api('PUT', `/api/admin/bookings/${id}/manual-payment`, { amount_paid: 1000, payment_status: 'PAID', force: true });
    await sleep(300);
    let logAfterConfirm = getChildLog();
    const confirmSyncAttempted = logAfterConfirm.includes(`GCal Event for Booking #${id}`) || logAfterConfirm.includes(`Error syncing booking #${id} to GCal`);
    check('confirm: syncBookingToCalendar was invoked for this booking (not silently skipped)', confirmSyncAttempted, logAfterConfirm.slice(-600));

    // ── 2. Reschedule: PATCH .../date must also trigger a sync attempt ──
    const newDate = future(901);
    const dateRes = await api('PATCH', `/api/admin/bookings/${id}/date`, { date: newDate, time: '19:00' });
    check('reschedule: date PATCH -> 200', dateRes.status === 200 && dateRes.body.success, JSON.stringify(dateRes.body));
    await sleep(300);
    const rescheduledRow = await one('SELECT date FROM bookings WHERE id=?', [id]);
    check('reschedule: booking date actually changed', rescheduledRow.date === newDate, `${rescheduledRow.date} (expected ${newDate})`);
    const logAfterReschedule = getChildLog();
    // The reschedule call is async (db.get callback -> syncBookingToCalendar), so distinguishing
    // "a second attempt happened" from "the first attempt's line is still there" requires counting
    // occurrences, not just checking presence.
    const countOccurrences = (hay, needle) => (hay.match(new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
    const successOrFailureCountAfterConfirm = countOccurrences(logAfterConfirm, `Booking #${id}`) + countOccurrences(logAfterConfirm, `syncing booking #${id}`);
    const successOrFailureCountAfterReschedule = countOccurrences(logAfterReschedule, `Booking #${id}`) + countOccurrences(logAfterReschedule, `syncing booking #${id}`);
    check('reschedule: a SECOND sync attempt was logged for this booking (not just the confirm-time one)',
        successOrFailureCountAfterReschedule > successOrFailureCountAfterConfirm,
        `after confirm=${successOrFailureCountAfterConfirm}, after reschedule=${successOrFailureCountAfterReschedule}`);

    // ── 3. Cancel: deleteGoogleEvent() runs only when google_event_id is set. The real create
    // attempt above failed (bogus refresh token, per file header), so google_event_id is still
    // NULL — seed a fake one first, exactly as calendar.test.js's CP2 already does, so the delete
    // branch actually has something to act on. ──
    const sqlite3 = require('sqlite3');
    const support = require('./support');
    const rw = new sqlite3.Database(support.TEST_DB);
    const run = (sql, params = []) => new Promise((res, rej) => rw.run(sql, params, function (e) { e ? rej(e) : res(this); }));
    const fakeGCalId = `fake-cancel-sync-test-${id}`;
    await run('UPDATE bookings SET google_event_id = ? WHERE id = ?', [fakeGCalId, id]);

    const cancelRes = await api('POST', `/api/admin/bookings/${id}/cancel`, { reason: 'calendar-sync evidence test' });
    check('cancel: 200', cancelRes.status === 200, JSON.stringify(cancelRes.body));
    await sleep(300);
    const afterCancel = await one('SELECT google_event_id FROM bookings WHERE id=?', [id]);
    check('cancel: google_event_id nulled (consistent with calendar.test.js CP2)', afterCancel.google_event_id === null, JSON.stringify(afterCancel));
    const logAfterCancel = getChildLog();
    const deleteAttempted = logAfterCancel.includes(`GCal event ${fakeGCalId}`) || logAfterCancel.includes(`GCal Event: ${fakeGCalId}`);
    check('cancel: deleteGoogleEvent was invoked with this booking\'s calendar id (not silently skipped)', deleteAttempted, logAfterCancel.slice(-600));

    rw.close();
};
