// A refund is money that LEAVES the account, so every revenue figure subtracts it. Refunds are stored as positive amounts with transaction_type
// 'refund', and the revenue queries summed `amount` as it stood: after a R2,000 payment and a R400 refund the dashboard and the 12-month trend read
// +R2,400 (the right figure is +R1,600), while the profit-and-loss report ignored refunds and read +R2,000. This follows the owner's rule
// ("refunds leave my account, so it should be a subtraction") through every revenue figure:
//   dashboard revenue (period), 12-month trend, top clients, revenue by category, the profit-and-loss report, and a booking's own P&L.
// A manual adjustment (credit / debit) is not money at all; a payment flagged as a duplicate is not revenue anywhere (the P&L report used to
// count it). The schema has no chargeback type (transaction_type is deposit / payment / refund / adjustment), so there is nothing to test there:
// the SQL helper (lib/booking-amounts.js) would net one if it ever appeared.
// Amounts are large on purpose: the dashboard lists only the top 5 clients / 8 categories, and the development database seeds these tests with a few
// real-looking ones.
const sqlite3 = require('sqlite3');

let seq = 0;
const stamp = () => `${Date.now().toString(36)}${seq++}`;
const num = (v) => Number(v) || 0;

module.exports = async function ({ check, api, pub, one, future, sleep, getTrackingToken, TEST_DB }) {
    const eq = (name, got, want) => check(name, Math.abs(got - want) < 0.005, `got ${got}, want ${want}`);
    // support.q() opens the database read-only; the one row no route creates (a bare adjustment) is written directly.
    const write = (sql, params = []) => new Promise((resolve, reject) => {
        const db = new sqlite3.Database(TEST_DB);
        db.configure('busyTimeout', 10000);
        db.run(sql, params, (e) => db.close(() => (e ? reject(e) : resolve())));
    });

    const service = await one("SELECT id FROM services WHERE name = 'Writing – Head Writer (per month)'");     // a range service: quoted at an agreed amount
    const name = `ZZ Refund Revenue ${stamp()}`;
    const email = `refund.revenue.${stamp()}@example.invalid`;
    const created = await api('POST', '/api/admin/bookings', {
        name, email, cell: '+27821234567', event_date: future(1650), event_name: 'Refund revenue test', event_type: 'Corporate Event',
        event_location: 'Test Hall', message: 'Refund revenue integration test, over ten characters.', services: [{ service_id: service.id }], status: 'NEW', override_working_hours: true
    });
    const id = created.body && created.body.booking_id;
    check('fixture: the booking is created', !!id, JSON.stringify(created.body));
    const bk = await one('SELECT date FROM bookings WHERE id = ?', [id]);
    const expiry = new Date(Date.parse(bk.date) - 10 * 86400000).toISOString().slice(0, 10);
    const quoted = await api('POST', `/api/admin/bookings/${id}/quote`, { quote_expiry_date: expiry, terms: 'Standard terms apply.', apply_vat: false, discount: 0,
        items: [{ service_id: service.id, description: 'Head writer - one month', quantity: 1, unit_price: 120000 }] });
    check('fixture: the quotation (R120,000) is issued', quoted.status === 200, JSON.stringify(quoted.body).slice(0, 200));
    const accepted = await pub('POST', `/api/public/bookings/${id}/accept-quote`, { access_token: await getTrackingToken(id, email), terms_agreed: true });
    check('fixture: the client accepts it', accepted.status === 200, JSON.stringify(accepted.body).slice(0, 200));

    const month = new Date().toISOString().slice(0, 7);
    const metrics = async () => {
        const st = ((await api('GET', '/api/admin/financials/stats')).body || {}).stats || {};
        const an = (await api('GET', '/api/admin/financials/analytics')).body || {};
        const pl = (await api('GET', '/api/admin/finance/pl?period=month')).body || {};
        const trend = (an.revenueTrend || []).find((x) => x.month === month);
        const category = (an.revenueByCategory || []).find((x) => x.category === 'Corporate Event');
        const client = (an.topClients || []).find((x) => x.client_name === name);
        const own = (await api('GET', `/api/admin/bookings/${id}/expenses`)).body || {};
        return { dashboard: num(st.revenue), trend: trend ? num(trend.total_revenue) : 0, pl: num((pl.totals || {}).revenue), category: category ? num(category.revenue) : 0,
            client: client ? num(client.total_spent) : 0, gross: num(own.gross_revenue), refunded: num(own.refunded), net: num(own.net_profit) };
    };
    const m0 = await metrics();
    // every figure's change since the start, in one place
    const moved = (m, want, label) => {
        eq(`${label}: dashboard revenue moved by ${want}`, m.dashboard - m0.dashboard, want);
        eq(`${label}: 12-month trend moved by ${want}`, m.trend - m0.trend, want);
        eq(`${label}: profit-and-loss revenue moved by ${want}`, m.pl - m0.pl, want);
        eq(`${label}: revenue by category moved by ${want}`, m.category - m0.category, want);
        eq(`${label}: this client's total spent is ${want}`, m.client, want);
    };

    // ── a payment of R100,000 ──
    await api('PUT', `/api/admin/bookings/${id}/manual-payment`, { amount_paid: 100000 });
    await sleep(1500);
    let m = await metrics();
    moved(m, 100000, 'after a R100,000 payment');
    eq('after the payment: the booking\'s own P&L gross is its agreed R120,000', m.gross, 120000);
    eq('...nothing refunded yet, so its net is R120,000 (no expenses)', m.net, 120000);

    // ── a refund of R20,000 comes OFF ──
    const refund = await api('POST', '/api/admin/transactions/manual', { booking_id: id, amount: 20000, transaction_type: 'refund', payment_method: 'eft', reference: `ZZ-RFND-${stamp()}` });
    check('the refund is recorded', refund.status === 200, JSON.stringify(refund.body).slice(0, 200));
    await sleep(1000);
    m = await metrics();
    moved(m, 80000, 'after a R20,000 refund');
    eq('after the refund: the booking\'s own P&L still shows the agreed R120,000 as gross', m.gross, 120000);
    eq('...reports the R20,000 refunded', m.refunded, 20000);
    eq('...and its net is R100,000 (gross less the refund)', m.net, 100000);

    // ── a manual adjustment is not money: nothing moves ──
    await write(`INSERT INTO transactions (booking_id, amount, transaction_type, payment_method, reference, notes, transaction_date, status, source, is_duplicate)
                 VALUES (?, 500, 'adjustment', 'bank_transfer', ?, '[Adjustment: credit] goodwill', DATE('now'), 'completed', 'manual', 0)`, [id, `ZZ-ADJ-${stamp()}`]);
    m = await metrics();
    moved(m, 80000, 'after a R500 adjustment (not money)');

    // ── a payment flagged as a duplicate is not revenue anywhere ──
    const dup = await api('POST', '/api/admin/transactions/manual', { booking_id: id, amount: 3000, transaction_type: 'payment', payment_method: 'cash', reference: `ZZ-DUP-${stamp()}` });
    check('the second payment (to be flagged) is recorded', dup.status === 200, JSON.stringify(dup.body).slice(0, 200));
    await sleep(1000);
    m = await metrics();
    moved(m, 83000, 'after another R3,000 payment');
    const dupRow = await one(`SELECT id FROM transactions WHERE booking_id = ? AND transaction_type = 'payment' AND reference LIKE 'ZZ-DUP-%'`, [id]);
    const flag = await api('PATCH', `/api/admin/transactions/${dupRow && dupRow.id}/reconcile`, { is_duplicate: true, reconcile_note: 'duplicate of the cash payment' });
    check('the payment is flagged as a duplicate', flag.status === 200, JSON.stringify(flag.body));
    m = await metrics();
    moved(m, 80000, 'after flagging that payment as a duplicate');
};
