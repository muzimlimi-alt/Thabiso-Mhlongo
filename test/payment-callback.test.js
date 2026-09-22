// Characterisation test for the PayFast ITN webhook (POST /api/payment/webhook/payfast),
// per Phase 2 of the housekeeping plan: a normal callback, a duplicate callback, and a callback
// for an unknown booking reference. The route ALWAYS responds 200 immediately (PayFast requires
// that) before doing any real work asynchronously in the background — see server.js ~line 5508 —
// so every assertion here is against DB state after a short wait, never against the HTTP response.
//
// support.js's spawnAndWait() runs the app with PAYFAST_URL=sandbox and PAYFAST_MERCHANT_ID=
// '10000100', which the route reads via process.env — merchant_id must match that value below or
// the ITN is silently dropped. Sandbox mode also tolerates a signature mismatch (logs a warning
// and continues) and skips the source-IP allowlist, so a real PayFast signature is not required
// here; a placeholder string is enough.
const { api, pub, one, future, sleep, getTrackingToken } = require('./support');

const SVC = 15; // 'Travel Buyout – Gauteng' (active, flat fee, zero lead time) — see booking.test.js
const MERCHANT_ID = '10000100'; // must match PAYFAST_MERCHANT_ID set by support.js's spawnAndWait()
const email = () => `pfitn.${Date.now()}@example.invalid`;

// Date offsets 830-850 are reserved for this file (see calendar.test.js's comment on why offsets
// must not collide across *.test.js files sharing one server/DB per npm test run).
async function makeAcceptedBooking(days, amount) {
    const em = email();
    const created = await api('POST', '/api/admin/bookings', {
        name: 'PF ITN Test', email: em, cell: '+27821234567', event_date: future(days),
        event_name: 'PF ITN Event', event_type: 'Corporate', event_location: 'Test Hall',
        message: 'PayFast ITN webhook integration test booking.',
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

function itnPayload({ bookingId, paymentType = 'FULL', amount, pfPaymentId }) {
    return {
        m_payment_id: `${bookingId}_${paymentType}`,
        pf_payment_id: pfPaymentId,
        payment_status: 'COMPLETE',
        amount_gross: amount.toFixed(2),
        merchant_id: MERCHANT_ID,
        payment_method: 'cc',
        signature: 'not-a-real-signature', // tolerated in sandbox mode, see file header
    };
}

module.exports = async function ({ check }) {
    // ── 1. Normal ITN: credits the booking, records a transaction ──
    const id1 = await makeAcceptedBooking(830, 1000);
    const ref1 = `IT-PF-${Date.now()}-1`;
    const itnRes1 = await pub('POST', '/api/payment/webhook/payfast', itnPayload({ bookingId: id1, amount: 1000, pfPaymentId: ref1 }));
    check('ITN: webhook always answers 200 immediately (PayFast requirement)', itnRes1.status === 200, `${itnRes1.status}`);
    // The route makes a real outbound HTTPS call to sandbox.payfast.co.za to "confirm" the ITN
    // before crediting anything; give it room to time out if this environment has no outbound
    // network access (sandbox mode proceeds regardless of that call's outcome — see server.js).
    await sleep(4000);

    const txns1 = await one('SELECT COUNT(*) c FROM transactions WHERE booking_id=? AND reference=? AND source=?', [id1, ref1, 'payfast']);
    check('ITN: exactly one transaction row recorded', txns1.c === 1, `count=${txns1.c}`);
    const bk1 = await one('SELECT payment_status, amount_paid, confirmed_at FROM bookings WHERE id=?', [id1]);
    check('ITN: booking credited to PAID for the full amount', bk1.payment_status === 'PAID' && Math.abs(bk1.amount_paid - 1000) < 0.01, JSON.stringify(bk1));
    check('ITN: confirmed_at stamped', !!bk1.confirmed_at, bk1.confirmed_at);

    // ── 2. Duplicate ITN: same pf_payment_id replayed — must not double-credit ──
    const itnRes2 = await pub('POST', '/api/payment/webhook/payfast', itnPayload({ bookingId: id1, amount: 1000, pfPaymentId: ref1 }));
    check('duplicate ITN: still answers 200 (no error surfaced to PayFast)', itnRes2.status === 200, `${itnRes2.status}`);
    await sleep(4000);

    const txns1b = await one('SELECT COUNT(*) c FROM transactions WHERE booking_id=? AND reference=? AND source=?', [id1, ref1, 'payfast']);
    check('duplicate ITN: still exactly one transaction row (no duplicate credit)', txns1b.c === 1, `count=${txns1b.c}`);
    const bk1b = await one('SELECT amount_paid FROM bookings WHERE id=?', [id1]);
    check('duplicate ITN: amount_paid unchanged (not double-credited to 2000)', Math.abs(bk1b.amount_paid - 1000) < 0.01, bk1b.amount_paid);
    const dupLog = await one(
        "SELECT COUNT(*) c FROM payment_logs WHERE booking_id=? AND event_type='IGNORED_DUPLICATE'", [id1]);
    check('duplicate ITN: an IGNORED_DUPLICATE row was logged', dupLog.c >= 1, `count=${dupLog.c}`);

    // ── 3. Unknown reference: booking id in m_payment_id does not exist ──
    const fakeBookingId = 900000000 + Math.floor(Math.random() * 1000);
    const preCheck = await one('SELECT id FROM bookings WHERE id=?', [fakeBookingId]);
    check('unknown-reference fixture: chosen booking id genuinely does not exist', !preCheck, JSON.stringify(preCheck));

    const itnRes3 = await pub('POST', '/api/payment/webhook/payfast', itnPayload({ bookingId: fakeBookingId, amount: 500, pfPaymentId: `IT-PF-${Date.now()}-3` }));
    check('unknown-reference ITN: still answers 200 (webhook never surfaces app-side errors to PayFast)', itnRes3.status === 200, `${itnRes3.status}`);
    await sleep(1000); // this path returns early on the booking lookup — no outbound HTTPS call is made, so no need for the longer wait

    const txnsUnknown = await one('SELECT COUNT(*) c FROM transactions WHERE booking_id=?', [fakeBookingId]);
    check('unknown-reference ITN: no transaction row created', txnsUnknown.c === 0, `count=${txnsUnknown.c}`);
    // payment_logs.booking_id has a FOREIGN KEY REFERENCES bookings(id) (database.js ~line 262), so
    // logPaymentEvent()'s own ITN_RECEIVED insert still fails its FK check for a booking id that
    // doesn't exist — that part of the original finding (Deferred fix #2, HOUSEKEEPING-NOTES.md)
    // still holds and isn't something to change (payment_logs is meant to be strictly booking-scoped).
    const receivedLog = await one(
        "SELECT COUNT(*) c FROM payment_logs WHERE booking_id=? AND event_type='ITN_RECEIVED'", [fakeBookingId]);
    check('unknown-reference ITN: still no payment_logs row (FK correctly blocks it there)', receivedLog.c === 0, `count=${receivedLog.c}`);
    // FIXED: logPaymentEvent()'s error callback now falls back to audit_log (no FK on record_id) when
    // the payment_logs insert fails, so a garbled/spoofed/replayed ITN referencing a bogus booking id
    // no longer vanishes without a trace.
    const fallbackAudit = await one(
        "SELECT COUNT(*) c FROM audit_log WHERE table_name='payment_logs' AND record_id=? AND action='ITN_RECEIVED'", [fakeBookingId]);
    check('unknown-reference ITN: fallback audit_log row now records the event', fallbackAudit.c === 1, `count=${fallbackAudit.c}`);
};
