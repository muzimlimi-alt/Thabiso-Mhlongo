// Regression test for the bug fixed in routes/admin/transactions.js (HOUSEKEEPING-NOTES.md,
// Deferred fix #5): POST /api/admin/transactions/manual with no booking_id always 500'd with a raw
// SQLite "NOT NULL constraint failed: transactions.booking_id" message, because the route's own
// no-booking branch was unreachable — the INSERT threw before ever getting there. No test exercised
// this route before, which is exactly how the bug went unnoticed; this file exists so it can't
// regress silently again.
const { api, q } = require('./support');

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
};
