// Client-selectable installment plans (2 or 3 payments, chosen at accept-quote time) and the
// "pay one specific installment separately, in strict due order" flow through /pay's new
// schedule_id path. Date offsets live in the 950+ range, clear of every other file's claimed
// ranges (see calendar-booking-sync.test.js's own header comment on this convention).
const SVC = 15; // 'Travel Buyout – Gauteng' (active, flat fee, zero lead time)
let seq = 0;
const email = () => `test.${Date.now()}.ip${seq++}@example.invalid`;

module.exports = async function ({ check, api, pub, one, q, future, sleep, getTrackingToken }) {
    const em = email();
    const created = await api('POST', '/api/admin/bookings', {
        name: 'Installments IT', email: em, cell: '+27821234567', event_date: future(950),
        event_name: 'Installments Event', event_type: 'Corporate', event_location: 'Test Hall',
        message: 'Integration-test booking, over ten characters.',
        services: [{ service_id: SVC }], status: 'NEW', override_working_hours: true,
    });
    const id = created.body && created.body.booking_id;
    if (!id) throw new Error(`installment-plan: booking creation failed (status ${created.status}): ${JSON.stringify(created.body)}`);
    await sleep(50);

    const bk = await one('SELECT date FROM bookings WHERE id=?', [id]);
    const expiry = new Date(Date.parse(bk.date) - 10 * 86400000).toISOString().slice(0, 10);
    const AMOUNT = 1000;
    await api('POST', `/api/admin/bookings/${id}/quote`, {
        quote_expiry_date: expiry, terms: 'T', apply_vat: false, discount: 0,
        items: [{ service_id: SVC, description: 'Travel Buyout – Gauteng', quantity: 1, unit_price: AMOUNT }],
    });
    const token = await getTrackingToken(id, em);

    // ── Accept with installment_count:3 ──
    const acceptRes = await pub('POST', `/api/public/bookings/${id}/accept-quote`, { access_token: token, terms_agreed: true, installment_count: 3 });
    check('accept-quote with installment_count:3 -> 200', acceptRes.status === 200, JSON.stringify(acceptRes.body));
    await sleep(100);

    const rows = await q('SELECT id, expected_amount, sequence, source, status FROM payment_schedules WHERE booking_id=? ORDER BY sequence ASC', [id]);
    check('3 live rows created', rows.length === 3, `rows=${rows.length}`);
    check('sequence 1/2/3 assigned', rows.every((r, i) => r.sequence === i + 1), JSON.stringify(rows.map(r => r.sequence)));
    check('source=client on every row', rows.every(r => r.source === 'client'), JSON.stringify(rows.map(r => r.source)));
    const sum = rows.reduce((s, r) => s + parseFloat(r.expected_amount), 0);
    check('amounts sum to total', Math.abs(sum - AMOUNT) < 0.01, `sum=${sum}`);
    check('30/30/40 split', Math.abs(parseFloat(rows[0].expected_amount) - 300) < 0.01
        && Math.abs(parseFloat(rows[1].expected_amount) - 300) < 0.01
        && Math.abs(parseFloat(rows[2].expected_amount) - 400) < 0.01,
        JSON.stringify(rows.map(r => r.expected_amount)));

    // ── Attempt to skip ahead to installment 3 while 1 is still outstanding -> 409 ──
    const skipRes = await pub('POST', `/api/public/bookings/${id}/pay`, { access_token: token, schedule_id: rows[2].id });
    check('paying installment 3 before 1 -> 409', skipRes.status === 409, `${skipRes.status} ${JSON.stringify(skipRes.body)}`);

    // ── Pay installment 1 via manual-payment (deterministic, no PayFast network dependency —
    // same reasoning as booking.test.js's makeAccepted/deposit flow) ──
    // alignMilestonePayments (marks individual schedule rows paid) runs after an awaited
    // syncBookingToCalendar() call in processManualPayment's post-commit chain, which makes a
    // real network attempt to Google's OAuth endpoint (failing on this test env's deliberately
    // invalid refresh token, with retries/backoff) before it ever gets there — a short sleep
    // isn't enough margin for the row-level status to have settled, even though the booking-level
    // payment_status (set synchronously, before that chain starts) is already reliable much sooner.
    await api('PUT', `/api/admin/bookings/${id}/manual-payment`, { amount_paid: parseFloat(rows[0].expected_amount) });
    await sleep(3000);
    let b = await one('SELECT payment_status, status FROM bookings WHERE id=?', [id]);
    check('after installment 1: DEPOSIT_PAID (covers first row, not a flat 50%)', b.payment_status === 'DEPOSIT_PAID', JSON.stringify(b));
    check('after installment 1: booking CONFIRMED', b.status === 'CONFIRMED', JSON.stringify(b));
    let row1 = await one('SELECT status FROM payment_schedules WHERE id=?', [rows[0].id]);
    check('installment 1 marked paid', row1.status === 'paid', JSON.stringify(row1));

    // Still can't skip to installment 3 — installment 2 is now the next payable row.
    const skip2Res = await pub('POST', `/api/public/bookings/${id}/pay`, { access_token: token, schedule_id: rows[2].id });
    check('paying installment 3 before 2 -> 409', skip2Res.status === 409, `${skip2Res.status} ${JSON.stringify(skip2Res.body)}`);

    // ── Pay installment 2 ──
    // Still DEPOSIT_PAID, not PARTIALLY_PAID or PAID: by design (see lib/payment-processing.js's
    // deriveManualPaymentStatus comment), any coverage from installment 1 through the
    // second-to-last installment stays DEPOSIT_PAID — a deliberate choice not to invent a third
    // intermediate label that every existing badge/email consumer would need to learn about, for
    // a 2-way plan where DEPOSIT_PAID already covers the entire 50%-99% range the same way.
    await api('PUT', `/api/admin/bookings/${id}/manual-payment`, { amount_paid: parseFloat(rows[0].expected_amount) + parseFloat(rows[1].expected_amount) });
    await sleep(3000);
    b = await one('SELECT payment_status FROM bookings WHERE id=?', [id]);
    check('after installment 2: still DEPOSIT_PAID (not PAID) — by design, no 3rd intermediate label', b.payment_status === 'DEPOSIT_PAID', JSON.stringify(b));

    // ── Pay installment 3 (the final one) ──
    await api('PUT', `/api/admin/bookings/${id}/manual-payment`, { amount_paid: AMOUNT });
    await sleep(3000);
    b = await one('SELECT payment_status, amount_outstanding FROM bookings WHERE id=?', [id]);
    check('after installment 3: PAID', b.payment_status === 'PAID', JSON.stringify(b));
    check('outstanding is zero', parseFloat(b.amount_outstanding) === 0, JSON.stringify(b));
    const finalRows = await q('SELECT status FROM payment_schedules WHERE booking_id=? ORDER BY sequence ASC', [id]);
    check('all 3 rows marked paid', finalRows.every(r => r.status === 'paid'), JSON.stringify(finalRows));

    // ── 2-way plan (the default) stays byte-identical to pre-feature behaviour ──
    const em2 = email();
    const created2 = await api('POST', '/api/admin/bookings', {
        name: 'Installments IT 2way', email: em2, cell: '+27821234567', event_date: future(955),
        event_name: 'Installments Event 2', event_type: 'Corporate', event_location: 'Test Hall',
        message: 'Integration-test booking, over ten characters.',
        services: [{ service_id: SVC }], status: 'NEW', override_working_hours: true,
    });
    const id2 = created2.body && created2.body.booking_id;
    await sleep(50);
    const bk2 = await one('SELECT date FROM bookings WHERE id=?', [id2]);
    const expiry2 = new Date(Date.parse(bk2.date) - 10 * 86400000).toISOString().slice(0, 10);
    await api('POST', `/api/admin/bookings/${id2}/quote`, {
        quote_expiry_date: expiry2, terms: 'T', apply_vat: false, discount: 0,
        items: [{ service_id: SVC, description: 'Travel Buyout – Gauteng', quantity: 1, unit_price: AMOUNT }],
    });
    const token2 = await getTrackingToken(id2, em2);
    // No installment_count at all — exercises the "stale cached frontend" default path.
    const accept2Res = await pub('POST', `/api/public/bookings/${id2}/accept-quote`, { access_token: token2, terms_agreed: true });
    check('accept-quote with no installment_count -> 200 (defaults to 2)', accept2Res.status === 200, JSON.stringify(accept2Res.body));
    await sleep(100);
    const rows2 = await q('SELECT expected_amount, source FROM payment_schedules WHERE booking_id=? ORDER BY sequence ASC', [id2]);
    check('defaults to 2 rows', rows2.length === 2, `rows=${rows2.length}`);
    check('50/50 split, source=client', Math.abs(parseFloat(rows2[0].expected_amount) - 500) < 0.01
        && Math.abs(parseFloat(rows2[1].expected_amount) - 500) < 0.01
        && rows2.every(r => r.source === 'client'),
        JSON.stringify(rows2));
};
