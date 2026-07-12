// Deterministic integration tests for the booking → quote → accept → pay lifecycle.
// No PayFast-network dependency: payments go through the manual path, so these run reliably in CI.
// Service 15 = 'Travel Buyout – Gauteng' (active, flat fee, zero lead time).
const { api, pub, one, q, future, sleep } = require('./support');

const SVC = 15;
let seq = 0;
const email = () => `test.${Date.now()}.${seq++}@example.invalid`;

async function makeAccepted(check, amount, days, em) {
    const created = await api('POST', '/api/admin/bookings', {
        name: 'IT', email: em, cell: '+27821234567', event_date: future(days),
        event_name: 'IT Event', event_type: 'Corporate', event_location: 'Test Hall',
        message: 'Integration-test booking, over ten characters.',
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
    await pub('POST', `/api/public/bookings/${id}/accept-quote`, { email: em, terms_agreed: true });
    return id;
}

module.exports = async function ({ check }) {
    // ── Intake validation ──
    const base = (over = {}) => ({
        name: 'Intake', email: email(), cell: '+27821234567', event_date: future(40),
        event_location: 'Hall', event_type: 'Corporate',
        message: 'Public intake integration test, over ten characters.',
        services: [{ service_id: SVC }], popia_consent: true, ...over,
    });

    let r = await pub('POST', '/api/public/bookings', base({ event_date: '2020-01-01' }));
    check('past event date rejected 400', r.status === 400 && /past/i.test(r.body.message || ''), `${r.status} ${r.body && r.body.message}`);

    r = await pub('POST', '/api/public/bookings', base({ event_start_time: 'abc' }));
    check('non-time event_start_time rejected 400', r.status === 400, `${r.status}`);

    r = await pub('POST', '/api/public/bookings', base({ name: ['a', 'b'] }));
    check('non-string field -> 400 not 500', r.status === 400, `${r.status}`);

    r = await pub('POST', '/api/public/bookings', base({ popia_consent: false }));
    check('missing POPIA consent rejected 400', r.status === 400 && /consent/i.test(r.body.message || ''), `${r.status}`);

    // Orphan prevention: a rejected submission must not create a client row.
    const cBefore = (await one('SELECT COUNT(*) c FROM clients')).c;
    await pub('POST', '/api/public/bookings', base({ services: [{ service_id: 999999 }], email: 'orphan@example.invalid' }));
    const cAfter = (await one('SELECT COUNT(*) c FROM clients')).c;
    check('rejected submission writes no orphan client', cAfter === cBefore, `clients ${cBefore} -> ${cAfter}`);

    // Happy path. The public route enforces the configured working_hours (per weekday), so
    // derive a compliant date + start time from the fixture DB instead of hardcoding 9:00 —
    // the owner can change working hours in Settings and the test must not break when they do.
    const okEmail = email();
    let happyDays = 55, whRow = null;
    for (let i = 0; i < 7; i++) { // find a working day at/after future(55)
        const dow = new Date(future(55 + i) + 'T12:00:00').getDay();
        const rowW = await one('SELECT start_time, is_working_day FROM working_hours WHERE day_of_week=?', [dow]);
        if (!rowW || rowW.is_working_day) { happyDays = 55 + i; whRow = rowW; break; }
    }
    const happyDate = future(happyDays);
    const startPadded = (whRow && whRow.start_time) ? whRow.start_time : '09:00'; // stored, zero-padded form
    const startInput = startPadded.replace(/^0/, '');                             // un-padded input exercises normalisation
    const [sh, sm] = startPadded.split(':').map(Number);
    const endM = sh * 60 + sm + 90;
    const endPadded = `${String(Math.floor(endM / 60) % 24).padStart(2, '0')}:${String(endM % 60).padStart(2, '0')}`;

    r = await pub('POST', '/api/public/bookings', base({ email: okEmail, event_date: happyDate, event_start_time: startInput, performance_duration: '90' }));
    check('valid public booking accepted', r.status === 200 && r.body.success, `${r.status} ${r.body && r.body.message}`);
    const pubId = r.body.booking_id;
    if (pubId) {
        const row = await one('SELECT status, event_start_time, performance_end_time, travel_accommodation FROM bookings WHERE id=?', [pubId]);
        check('booking saved as NEW', row.status === 'NEW', row.status);
        check('event_start_time zero-padded', row.event_start_time === startPadded, `${row.event_start_time} (expected ${startPadded})`);
        check(`performance_end_time derived (${startPadded} + 90m)`, row.performance_end_time === endPadded, `${row.performance_end_time} (expected ${endPadded})`);
        const consent = (await one('SELECT COUNT(*) c FROM consent_audit WHERE booking_id=?', [pubId])).c;
        check('consent_audit row written on intake', consent === 1, `consent=${consent}`);
        // Duplicate same-email/same-date rejected.
        r = await pub('POST', '/api/public/bookings', base({ email: okEmail, event_date: happyDate }));
        check('duplicate (email,date) rejected 409', r.status === 409, `${r.status}`);
    }

    // ── Concurrency: independent bookings must all persist (shared-connection transaction guard) ──
    const before = (await one('SELECT COUNT(*) c FROM bookings')).c;
    const concurrent = await Promise.all([0, 1, 2, 3, 4].map(i =>
        pub('POST', '/api/public/bookings', base({ email: email(), event_date: future(120 + i * 3) }))));
    const okCount = concurrent.filter(x => x.status === 200).length;
    const after = (await one('SELECT COUNT(*) c FROM bookings')).c;
    check('5 concurrent independent bookings all 200', okCount === 5, `${okCount}/5`);
    check('all 5 persisted (no lost writes)', after - before === 5, `${before} -> ${after}`);

    // ── Re-quote arithmetic + milestone invariant ──
    const rqEmail = email();
    const rqId = await makeAccepted(check, 1000, 200, rqEmail);
    await api('PUT', `/api/admin/bookings/${rqId}/manual-payment`, { amount_paid: 500 });
    await sleep(150);
    const afterDep = await one('SELECT status FROM bookings WHERE id=?', [rqId]);
    check('deposit confirms the booking', afterDep.status === 'CONFIRMED', afterDep.status);
    // Re-quote to a higher total, then re-accept.
    await sleep(1100); // quote_number is second-resolution
    const rq = await api('POST', `/api/admin/bookings/${rqId}/quote`, {
        quote_expiry_date: new Date(Date.parse((await one('SELECT date FROM bookings WHERE id=?', [rqId])).date) - 10 * 86400000).toISOString().slice(0, 10),
        terms: 'T', apply_vat: false, discount: 0,
        items: [{ service_id: SVC, description: 'Travel Buyout – Gauteng', quantity: 1, unit_price: 5000 }],
    });
    check('re-quote of a part-paid booking succeeds', rq.status === 200, `${rq.status}`);
    const backToQuoted = await one('SELECT status FROM bookings WHERE id=?', [rqId]);
    check('re-quote returns booking to QUOTED', backToQuoted.status === 'QUOTED', backToQuoted.status);
    const acc = await pub('POST', `/api/public/bookings/${rqId}/accept-quote`, { email: rqEmail, terms_agreed: true });
    check('client can re-accept the new total', acc.status === 200, `${acc.status}`);
    const liveSched = await q("SELECT expected_amount FROM payment_schedules WHERE booking_id=? AND LOWER(COALESCE(status,'pending')) NOT IN ('superseded','cancelled')", [rqId]);
    const liveSum = liveSched.reduce((a, s) => a + s.expected_amount, 0);
    const bkTot = await one('SELECT total_amount FROM bookings WHERE id=?', [rqId]);
    check('milestone invariant: sum(live expected) == total_amount', Math.abs(liveSum - bkTot.total_amount) < 0.01, `liveSum=${liveSum} total=${bkTot.total_amount}`);

    // ── Events auto-creation on CONFIRMED (Phase 4 FK fix), via the manual path ──
    const evId = await makeAccepted(check, 1000, 240, email());
    await api('PUT', `/api/admin/bookings/${evId}/manual-payment`, { amount_paid: 500 });
    await sleep(200);
    const evRow = await one('SELECT status, event_id FROM bookings WHERE id=?', [evId]);
    check('CONFIRMED booking gets its events row (created_by FK fix)', evRow.status === 'CONFIRMED' && !!evRow.event_id, `${evRow.status} event_id=${evRow.event_id}`);

    // ── Refund re-derives payment_status ──
    const refEmail = email();
    const refId = await makeAccepted(check, 1000, 260, refEmail);
    await api('PUT', `/api/admin/bookings/${refId}/manual-payment`, { amount_paid: 1000, payment_status: 'PAID', force: true });
    await sleep(150);
    await api('POST', `/api/admin/bookings/${refId}/cancel`, { reason: 'test', cancelled_by: 'mutual' });
    const rref = await api('PUT', `/api/admin/bookings/${refId}/refund`, { refund_amount: 1000, refund_reference: `IT-REF-${refId}` });
    check('refund endpoint succeeds', rref.status === 200, `${rref.status}`);
    const afterRef = await one('SELECT payment_status FROM bookings WHERE id=?', [refId]);
    check('full refund re-derives payment_status to UNPAID', afterRef.payment_status === 'UNPAID', afterRef.payment_status);
};
