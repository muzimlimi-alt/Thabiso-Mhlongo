// Characterisation test for the full booking lifecycle (Phase 2 of the housekeeping plan):
// intake -> quote -> accept -> invoice -> payment -> completed, asserting the bookings row's
// six lifecycle timestamp columns (created_at, quoted_at, accepted_at, confirmed_at,
// completed_at, cancelled_at) at every step. This does not re-test business rules already
// covered elsewhere (booking.test.js, contract.test.js) — it exists solely to pin down which
// timestamp gets set on which transition, since nothing else in the suite asserts all six
// columns together across one continuous walk.
const { api, pub, one, future, sleep, getTrackingToken } = require('./support');

const SVC = 15; // 'Travel Buyout – Gauteng' (active, flat fee, zero lead time) — see booking.test.js
const email = () => `lifecycle.${Date.now()}@example.invalid`;

// Date offsets 800-820 are not used by any other *.test.js file (see calendar.test.js's comment
// on why offsets must not collide across files sharing one server/DB per npm test run).
module.exports = async function ({ check }) {
    const em = email();

    // ── 1. Intake (public) — the "inquiry" stage: a NEW booking row, only created_at set ──
    const created = await pub('POST', '/api/public/bookings', {
        name: 'Lifecycle Test', email: em, cell: '+27821234567', event_date: future(800),
        event_location: 'Test Hall', event_type: 'Corporate',
        message: 'Phase 2 lifecycle characterisation test booking, over ten characters.',
        services: [{ service_id: SVC }], popia_consent: true, override_working_hours: true,
    });
    check('intake: 200 + booking_id', created.status === 200 && !!created.body.booking_id, `${created.status}`);
    const id = created.body.booking_id;
    if (!id) return;

    let row = await one('SELECT * FROM bookings WHERE id=?', [id]);
    check('intake: status=NEW', row.status === 'NEW', row.status);
    check('intake: created_at set', !!row.created_at, row.created_at);
    check('intake: quoted_at/accepted_at/confirmed_at/completed_at/cancelled_at all NULL',
        row.quoted_at === null && row.accepted_at === null && row.confirmed_at === null && row.completed_at === null && row.cancelled_at === null,
        JSON.stringify({ q: row.quoted_at, a: row.accepted_at, c: row.confirmed_at, comp: row.completed_at, x: row.cancelled_at }));

    // ── 2. Quote issued (admin) ──
    const expiry = new Date(Date.parse(row.date) - 10 * 86400000).toISOString().slice(0, 10);
    const quoteRes = await api('POST', `/api/admin/bookings/${id}/quote`, {
        quote_expiry_date: expiry, terms: 'Standard terms', apply_vat: false, discount: 0,
        items: [{ service_id: SVC, description: 'Travel Buyout – Gauteng', quantity: 1, unit_price: 2000 }],
    });
    check('quote: 200', quoteRes.status === 200, `${quoteRes.status}`);

    row = await one('SELECT * FROM bookings WHERE id=?', [id]);
    check('quote: status=QUOTED', row.status === 'QUOTED', row.status);
    check('quote: quoted_at now set', !!row.quoted_at, row.quoted_at);
    check('quote: accepted_at/confirmed_at/completed_at still NULL',
        row.accepted_at === null && row.confirmed_at === null && row.completed_at === null,
        JSON.stringify({ a: row.accepted_at, c: row.confirmed_at, comp: row.completed_at }));
    check('quote: created_at unchanged by the quote step', !!row.created_at, row.created_at);

    // No invoice should exist yet — generateInvoice() only runs on acceptance (see accept-quote
    // handler in server.js), not on quote issuance.
    const invBeforeAccept = await one('SELECT COUNT(*) c FROM invoices WHERE booking_id=?', [id]);
    check('quote: no invoice generated yet (invoice is created on acceptance, not on quoting)', invBeforeAccept.c === 0, `count=${invBeforeAccept.c}`);

    // ── 3. Quote accepted (public, via booking-access token) ──
    const token = await getTrackingToken(id, em);
    check('accept: obtained a tracking/access token', !!token, String(token));
    const acceptRes = await pub('POST', `/api/public/bookings/${id}/accept-quote`, { access_token: token, terms_agreed: true });
    check('accept: 200', acceptRes.status === 200 && acceptRes.body.success, `${acceptRes.status} ${acceptRes.body && acceptRes.body.message}`);

    row = await one('SELECT * FROM bookings WHERE id=?', [id]);
    check('accept: status=ACCEPTED (no payment yet, so not promoted straight to CONFIRMED)', row.status === 'ACCEPTED', row.status);
    check('accept: accepted_at now set', !!row.accepted_at, row.accepted_at);
    check('accept: confirmed_at/completed_at still NULL', row.confirmed_at === null && row.completed_at === null,
        JSON.stringify({ c: row.confirmed_at, comp: row.completed_at }));
    check('accept: quoted_at unchanged by the accept step', !!row.quoted_at, row.quoted_at);

    // ── 4. Invoice generated — as a side effect of acceptance ──
    const inv = await one('SELECT * FROM invoices WHERE booking_id=? ORDER BY id DESC LIMIT 1', [id]);
    check('invoice: a row now exists for this booking (generated on acceptance)', !!inv, JSON.stringify(inv));
    if (inv) {
        check('invoice: has an invoice_number', !!inv.invoice_number, inv.invoice_number);
        check('invoice: total_amount matches the quoted amount (R2000)', Math.abs(parseFloat(inv.total_amount) - 2000) < 0.01, inv.total_amount);
        check('invoice: created_at set', !!inv.created_at, inv.created_at);
    }

    // ── 5. Payment recorded (full amount, manual path — deterministic, no PayFast network dependency) ──
    const payRes = await api('PUT', `/api/admin/bookings/${id}/manual-payment`, { amount_paid: 2000, payment_status: 'PAID', force: true });
    check('payment: manual-payment 200', payRes.status === 200, `${payRes.status}`);
    await sleep(200);

    row = await one('SELECT * FROM bookings WHERE id=?', [id]);
    check('payment: payment_status=PAID', row.payment_status === 'PAID', row.payment_status);
    check('payment: status promoted to CONFIRMED', row.status === 'CONFIRMED', row.status);
    check('payment: confirmed_at now set (payment_status reached PAID)', !!row.confirmed_at, row.confirmed_at);
    check('payment: completed_at still NULL', row.completed_at === null, row.completed_at);
    check('payment: accepted_at/quoted_at/created_at all unchanged', !!row.accepted_at && !!row.quoted_at && !!row.created_at,
        JSON.stringify({ a: row.accepted_at, q: row.quoted_at, c: row.created_at }));

    // ── 6. Completed ──
    // The generic status route requires amount_outstanding=0 to allow a COMPLETED transition
    // (see calendar.test.js CP3); a full manual payment above already brings it to 0.
    const completeRes = await api('PUT', `/api/admin/bookings/${id}/status`, { status: 'COMPLETED' });
    check('complete: 200', completeRes.status === 200, `${completeRes.status} ${JSON.stringify(completeRes.body).slice(0, 120)}`);

    row = await one('SELECT * FROM bookings WHERE id=?', [id]);
    check('complete: status=COMPLETED', row.status === 'COMPLETED', row.status);
    check('complete: completed_at now set', !!row.completed_at, row.completed_at);
    check('complete: every earlier timestamp still present (nothing gets cleared on completion)',
        !!row.created_at && !!row.quoted_at && !!row.accepted_at && !!row.confirmed_at,
        JSON.stringify({ cr: row.created_at, q: row.quoted_at, a: row.accepted_at, co: row.confirmed_at }));
    check('complete: cancelled_at still NULL (booking was never cancelled)', row.cancelled_at === null, row.cancelled_at);
};
