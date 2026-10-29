// POST /api/public/bookings/:id/pay {payment_type:'FULL'} asks PayFast for what is still owed IN MONEY (total - paid), even in the
// moment after a payment when its schedule row is not yet flagged 'paid' (every payment path flags rows after it has answered).
// Summing the not-yet-flagged rows asked for too much, and the ITN's overpayment guard would then refuse to record the payment.
// Date offsets 2030-2032 belong to this file. Runs against the isolated test DB.
const path = require('path');
const sqlite3 = require('sqlite3');
const PaymentPlanRules = require('../js/shared/payment-plan-rules');
const { api, pub, one, future, getTrackingToken, TEST_DB } = require('./support');

let seq = 0;
const email = () => `pb.${Date.now()}.${seq++}@example.invalid`;

// A write on the test copy only (never the real database).
function testDbRun(sql, params) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(TEST_DB);
        db.configure('busyTimeout', 5000);
        db.run(sql, params, (e) => db.close(() => (e ? reject(e) : resolve())));
    });
}

async function quoted(days, amount) {
    const em = email();
    const id = (await api('POST', '/api/admin/bookings', {
        name: 'PB Client', email: em, cell: '+27821234567', event_date: future(days), event_name: 'PB Event', event_type: 'Corporate Event',
        event_location: 'Hall', message: 'Pay-balance integration test booking.', services: [{ service_id: 15 }],
        status: 'NEW', override_working_hours: true, override_conflict: true
    })).body.booking_id;
    const bk = await one('SELECT date FROM bookings WHERE id = ?', [id]);
    await api('POST', `/api/admin/bookings/${id}/quote`, {
        quote_expiry_date: new Date(Date.parse(bk.date) - 10 * 86400000).toISOString().slice(0, 10), terms: 'T', apply_vat: false, discount: 0,
        items: [{ service_id: 15, description: 'MC Hosting', quantity: 1, unit_price: amount }]
    });
    return { id, token: await getTrackingToken(id, em) };
}

// Accept with the plan the client's "N payments" button would build.
async function acceptWith(b, count) {
    const track = await pub('POST', `/api/public/bookings/${b.id}/track`, { access_token: b.token });
    const preset = PaymentPlanRules.buildPreset(track.body.payment_plan.context, count);
    return pub('POST', `/api/public/bookings/${b.id}/accept-quote`, {
        access_token: b.token, terms_agreed: true, milestones: preset.map((r) => ({ amount: r.amount_cents / 100, due_date: r.due_date }))
    });
}

module.exports = async function ({ check }) {
    await api('PUT', '/api/admin/policies', { policies: { deposit_percentage: '50' } });

    // ── unpaid: FULL is the whole total, DEPOSIT the first milestone (unchanged) ──
    const u = await quoted(2030, 9000);
    const acc = await acceptWith(u, 3);
    check('setup: accepted with a 3-payment plan (R4,500 + R2,250 + R2,250)', acc.status === 200 && acc.body.success, JSON.stringify(acc.body));
    const fullU = await pub('POST', `/api/public/bookings/${u.id}/pay`, { payment_type: 'FULL', access_token: u.token });
    check('nothing paid yet: FULL asks PayFast for the whole R9,000.00', fullU.status === 200 && fullU.body.pfData && fullU.body.pfData.amount === '9000.00', JSON.stringify(fullU.body.pfData && fullU.body.pfData.amount));
    const depU = await pub('POST', `/api/public/bookings/${u.id}/pay`, { payment_type: 'DEPOSIT', access_token: u.token });
    check('...and DEPOSIT is still the first milestone, R4,500.00', depU.status === 200 && depU.body.pfData && depU.body.pfData.amount === '4500.00', JSON.stringify(depU.body.pfData && depU.body.pfData.amount));

    // ── deposit paid, but its row not flagged yet (the moment right after the payment): FULL is the R4,500 still owed ──
    await api('PUT', `/api/admin/bookings/${u.id}/manual-payment`, { amount_paid: 4500 });
    const after = await one('SELECT amount_paid, payment_status FROM bookings WHERE id = ?', [u.id]);
    check('setup: the deposit is recorded (R4,500 paid, DEPOSIT_PAID)', after.amount_paid === 4500 && after.payment_status === 'DEPOSIT_PAID', JSON.stringify(after));
    await testDbRun("UPDATE payment_schedules SET status = 'pending' WHERE booking_id = ? AND LOWER(COALESCE(status,'pending')) NOT IN ('superseded','cancelled')", [u.id]);
    const fullP = await pub('POST', `/api/public/bookings/${u.id}/pay`, { payment_type: 'FULL', access_token: u.token });
    check('deposit paid, schedule flags lagging: FULL asks for the R4,500.00 still owed - not R9,000.00 (every unflagged row)',
        fullP.status === 200 && fullP.body.pfData && fullP.body.pfData.amount === '4500.00', JSON.stringify(fullP.body.pfData && { amount: fullP.body.pfData.amount, item: fullP.body.pfData.item_name }));
    const intent = await one("SELECT expected_amount FROM payfast_payment_intents WHERE booking_id = ? AND m_payment_id = ?", [u.id, `${u.id}_FULL`]);
    check('...and the recorded PayFast intent (what the ITN is checked against) is R4,500 too', intent && intent.expected_amount === 4500, JSON.stringify(intent));

    // ── fully paid: nothing to pay ──
    await api('PUT', `/api/admin/bookings/${u.id}/manual-payment`, { amount_paid: 9000, payment_status: 'PAID', force: true });
    const none = await pub('POST', `/api/public/bookings/${u.id}/pay`, { payment_type: 'FULL', access_token: u.token });
    check('fully paid: FULL is refused (nothing to pay)', none.status === 400, `${none.status} ${JSON.stringify(none.body)}`);
};
