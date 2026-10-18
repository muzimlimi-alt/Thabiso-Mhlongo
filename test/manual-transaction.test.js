// Regression test for the bug fixed in routes/admin/transactions.js (HOUSEKEEPING-NOTES.md,
// Deferred fix #5): POST /api/admin/transactions/manual with no booking_id always 500'd with a raw
// SQLite "NOT NULL constraint failed: transactions.booking_id" message, because the route's own
// no-booking branch was unreachable — the INSERT threw before ever getting there. No test exercised
// this route before, which is exactly how the bug went unnoticed; this file exists so it can't
// regress silently again.
//
// Second regression (rate card 2026 follow-up): a PAYMENT logged through this route was recorded TWICE. The route inserted the payment
// itself (with the admin's reference, note and method) and then called logPaymentEvent('MANUAL_PAYMENT_RECORDED'), which inserts a transaction
// of its own as well (reference "MANUAL-<booking>-<timestamp>", method 'payfast'). bookings.amount_paid went up once, but every sum over
// transactions - revenue, the P&L, the reconciliation CSV, the nightly ledger check, a cancellation refund - saw the payment twice.
//
// Date offsets 1350-1359 are reserved for the second half of this file (grep the WHOLE test folder before picking: service-visibility books
// through a helper, `mk(1200, ...)`, which a search for `future(` misses).
const { api, pub, q, one, future, sleep, getTrackingToken } = require('./support');

module.exports = async function ({ check }) {
    const noBookingRes = await api('POST', '/api/admin/transactions/manual', {
        amount: 50, transaction_type: 'payment', payment_method: 'cash'
    });
    check('no booking_id: 400, not the old raw SQLite 500', noBookingRes.status === 400, `${noBookingRes.status}: ${JSON.stringify(noBookingRes.body)}`);
    check('no booking_id: clean validation message, not a SQLite error string', noBookingRes.body?.message === 'A booking is required to log a manual transaction.', JSON.stringify(noBookingRes.body));

    // Sanity: the normal, with-booking_id path still works exactly as before this fix.
    const [existingBooking] = await q('SELECT id FROM bookings LIMIT 1');
    if (existingBooking) {
        const withBookingRes = await api('POST', '/api/admin/transactions/manual', {
            booking_id: existingBooking.id, amount: 1, transaction_type: 'adjustment', direction: 'credit', notes: 'test'
        });
        check('with booking_id: still 200 (fix did not disturb the normal path)', withBookingRes.status === 200 && withBookingRes.body?.success === true, JSON.stringify(withBookingRes.body));
    }

    // ═══ A payment is ONE transaction ═══
    const sClub = (await one("SELECT id FROM services WHERE name = 'Club – 10 min Set (Guest Spot)'")).id;   // fixed R5,000
    let day = 1350, seq = 0;
    const accepted = async (label) => {
        const email = `mtx.${Date.now()}.${seq++}@example.invalid`;
        const created = await api('POST', '/api/admin/bookings', {
            name: `MTX ${label}`, email, cell: '+27821234567', event_date: future(day++), event_name: `MTX ${label}`, event_type: 'Corporate', event_location: 'Hall',
            message: 'Manual transaction integration test booking, over ten characters.', services: [{ service_id: sClub }], status: 'NEW', override_working_hours: true
        });
        const id = created.body && created.body.booking_id;
        const bk = await one('SELECT date FROM bookings WHERE id = ?', [id]);
        const expiry = new Date(Date.parse(bk.date) - 10 * 86400000).toISOString().slice(0, 10);
        await api('POST', `/api/admin/bookings/${id}/quote`, { quote_expiry_date: expiry, terms: 'T', apply_vat: false, discount: 0, items: [{ service_id: sClub, description: 'Club set', quantity: 1, unit_price: 5000, pricing_model: 'flat_fee' }] });
        await pub('POST', `/api/public/bookings/${id}/accept-quote`, { access_token: await getTrackingToken(id, email), terms_agreed: true });
        return id;
    };
    // the payment's extra writes happen just after the response, so wait until the row count has stopped changing before counting
    const settledRows = async (id) => {
        let last = -1, still = 0;
        for (let i = 0; i < 40 && still < 5; i++) {
            const n = (await one('SELECT COUNT(*) c FROM transactions WHERE booking_id = ?', [id])).c;
            still = n === last ? still + 1 : 0; last = n;
            await sleep(200);
        }
        return q('SELECT amount, transaction_type, payment_method, reference, notes, source FROM transactions WHERE booking_id = ? ORDER BY id', [id]);
    };
    const revenue = async () => Number((((await api('GET', '/api/admin/financials/stats')).body || {}).stats || {}).revenue) || 0;

    const bId = await accepted('payment once');
    const rev0 = await revenue();
    const pay = await api('POST', '/api/admin/transactions/manual', { booking_id: bId, amount: 2000, transaction_type: 'payment', payment_method: 'eft', reference: 'ZZ-MTX-REF-1', notes: 'deposit by EFT' });
    const rows = await settledRows(bId);
    const rev1 = await revenue();
    check('a R2,000 payment logged through the route is ONE transaction row (it used to write a second, "MANUAL-..." twin)', pay.status === 200 && rows.length === 1, JSON.stringify({ status: pay.status, rows }));
    check('...and it is the row the admin typed: their reference, their note and the bank-transfer method (the twin said "payfast")',
        rows.length >= 1 && rows[0].reference === 'ZZ-MTX-REF-1' && rows[0].payment_method === 'bank_transfer' && /deposit by EFT/.test(rows[0].notes || '') && rows[0].amount === 2000, JSON.stringify(rows));
    const bk = await one('SELECT amount_paid, amount_outstanding FROM bookings WHERE id = ?', [bId]);
    check('the booking is credited once: R2,000.00 paid, R3,000.00 outstanding', bk.amount_paid === 2000 && bk.amount_outstanding === 3000, JSON.stringify(bk));
    check('the dashboard revenue goes up by the R2,000.00 paid - once', Math.round((rev1 - rev0) * 100) / 100 === 2000, `${rev0} -> ${rev1}`);
    const logs = await q("SELECT event_type FROM payment_logs WHERE booking_id = ? AND event_type = 'MANUAL_PAYMENT_RECORDED'", [bId]);
    check('the payment event is still written to the audit log', logs.length === 1, JSON.stringify(logs));

    const pay2 = await api('POST', '/api/admin/transactions/manual', { booking_id: bId, amount: 1000, transaction_type: 'payment', payment_method: 'cash', reference: 'ZZ-MTX-REF-2' });
    const rows2 = await settledRows(bId);
    check('a second payment adds exactly one more row: two payments, two rows, R3,000.00 paid', pay2.status === 200 && rows2.length === 2 && rows2.reduce((s, r) => s + r.amount, 0) === 3000 && (await one('SELECT amount_paid FROM bookings WHERE id = ?', [bId])).amount_paid === 3000, JSON.stringify(rows2));

    // the other admin payment path already wrote one row - it must keep doing so
    const bOther = await accepted('other path');
    await api('PUT', `/api/admin/bookings/${bOther}/manual-payment`, { amount_paid: 2000 });
    const rowsOther = await settledRows(bOther);
    check('PUT .../manual-payment still records one payment as one row (unchanged)', rowsOther.length === 1 && rowsOther[0].amount === 2000, JSON.stringify(rowsOther));
};
