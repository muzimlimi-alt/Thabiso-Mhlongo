// Dashboard Overview + Finance figures (routes/admin/insights.js, lib/insights.js) against a known set of records planted in an otherwise
// empty window (March 2001; the "previous period" is the 31 days before). Proves the money rules the owner set out:
//   an invoice is not money; a refund comes off; a manual adjustment and a flagged duplicate are not money; an uploaded proof of payment is
//   not a payment; ticket money is counted once (it never sits in `transactions`), refunds taken off, complimentary tickets excluded;
//   net profit only from recorded expenses; money hidden from an assistant.
const sqlite3 = require('sqlite3');
const support = require('./support');
const { api, loginAs } = support;

const W = '&range=custom&from=2001-03-01&to=2001-03-31';
function sqlRun(db, sql, p = []) { return new Promise((res, rej) => db.run(sql, p, function (e) { e ? rej(e) : res(this); })); }

module.exports = async function ({ check }) {
    const db = new sqlite3.Database(support.TEST_DB);
    const ins = async (sql, p) => (await sqlRun(db, sql, p)).lastID;
    let ids;
    try {
        const client = await ins(`INSERT INTO clients (full_name, email, phone) VALUES ('ZZ Insights Client', 'zz.insights@example.invalid', '0820000000')`);
        const bk = (name, status, extra) => ins(`INSERT INTO bookings (name, email, date, message, status, event_type, event_name, client_id, created_at, quoted_at, accepted_at, confirmed_at, cancelled_at, total_amount, amount_paid, amount_outstanding)
                                                 VALUES (?, 'zz.insights@example.invalid', '2001-04-20', 'x', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [name, status, extra.type || 'Corporate Event', name, client, extra.created, extra.quoted || null, extra.accepted || null, extra.confirmed || null, extra.cancelled || null, extra.total || 0, extra.paid || 0, extra.outstanding || 0]);
        const b1 = await bk('ZZ Insights A', 'CONFIRMED', { created: '2001-03-02 08:00:00', quoted: '2001-03-03 08:00:00', accepted: '2001-03-04 08:00:00', confirmed: '2001-03-05 08:00:00', total: 10000, paid: 4000, outstanding: 6000 });
        const b2 = await bk('ZZ Insights B', 'QUOTED', { created: '2001-03-03 08:00:00', quoted: '2001-03-04 08:00:00', total: 5000 });
        await bk('ZZ Insights C', 'PENDING', { created: '2001-03-04 08:00:00' });
        await bk('ZZ Insights D', 'CANCELLED', { created: '2001-03-06 08:00:00', cancelled: '2001-03-07 08:00:00' });

        const tx = (amount, type, method, source, date, dup) => ins(`INSERT INTO transactions (booking_id, amount, transaction_type, payment_method, source, transaction_date, status, is_duplicate) VALUES (?, ?, ?, ?, ?, ?, 'completed', ?)`,
            [b1, amount, type, method, source, date, dup ? 1 : 0]);
        await tx(3000, 'payment', 'payfast', 'payfast', '2001-03-05', 0);
        await tx(1000, 'payment', 'bank_transfer', 'manual', '2001-03-10', 0);
        await tx(500, 'refund', 'bank_transfer', 'admin_refund', '2001-03-12', 0);
        await tx(700, 'adjustment', 'other', 'manual', '2001-03-12', 0);          // not money
        await tx(999, 'payment', 'payfast', 'payfast', '2001-03-13', 1);          // flagged duplicate: not money
        await tx(200, 'payment', 'cash', 'manual', '2001-02-15', 0);              // previous period

        await ins(`INSERT INTO invoices (booking_id, client_id, invoice_number, invoice_date, due_date, subtotal, total_amount, status) VALUES (?, ?, 'ZZ-INV-1', '2001-03-05', '2001-03-20', 10000, 10000, 'SENT')`, [b1, client]);
        await ins(`INSERT INTO invoices (booking_id, client_id, invoice_number, invoice_date, due_date, subtotal, total_amount, status) VALUES (?, ?, 'ZZ-INV-2', '2001-03-06', '2001-03-20', 2000, 2000, 'VOID')`, [b1, client]);
        await ins(`INSERT INTO quotations (client_id, booking_id, quote_date, total_amount, status, archived) VALUES (?, ?, '2001-03-04', 5000, 'sent', 0)`, [client, b2]);
        await ins(`INSERT INTO quotations (client_id, booking_id, quote_date, total_amount, status, archived) VALUES (?, ?, '2001-03-03', 4000, 'sent', 1)`, [client, b2]);   // superseded revision
        await ins(`INSERT INTO expenses (expense_date, description, amount) VALUES ('2001-03-15', 'ZZ insights expense', 400)`);
        await ins(`INSERT INTO eft_payment_submissions (booking_id, claimed_amount, proof_filename, proof_mime, proof_size, proof_sha256, status, created_at) VALUES (?, 8888, 'zz.pdf', 'application/pdf', 10, 'zz-insights-sha', 'pending', '2001-03-14 08:00:00')`, [b1]);

        // tickets: R100 a ticket; O1 2 tickets paid; O2 1 ticket paid then refunded; O3 complimentary; O4 still at checkout
        const ev = await ins(`INSERT INTO events (event_title, event_datetime, event_status) VALUES ('ZZ Insights Show', '2001-04-10T20:00', 'completed')`);
        const tier = await ins(`INSERT INTO ticket_types (event_id, name, price_cents, capacity, sold, is_active, created_at, updated_at) VALUES (?, 'General', 10000, 10, 3, 0, '2001-03-01', '2001-03-01')`, [ev]);
        const order = async (ref, total, status, paid, refunded, comp, qty) => {
            const id = await ins(`INSERT INTO ticket_orders (public_reference, event_id, total_cents, status, paid_at, refunded_at, complimentary, reserved_until, created_at, checkout_started_at)
                                  VALUES (?, ?, ?, ?, ?, ?, ?, '2001-03-01T00:00:00Z', '2001-03-01T00:00:00Z', '2001-03-01T00:00:00Z')`, [ref, ev, total, status, paid, refunded, comp]);
            if (qty) {
                await ins(`INSERT INTO ticket_order_items (order_id, ticket_type_id, quantity, unit_price_cents) VALUES (?, ?, ?, ?)`, [id, tier, qty, comp ? 0 : 10000]);
                for (let i = 0; i < qty; i++) await ins(`INSERT INTO tickets (order_id, ticket_type_id, token, voided_at, created_at) VALUES (?, ?, ?, ?, '2001-03-01')`, [id, tier, `${ref}-${i}`, status === 'refunded' ? '2001-03-20T10:00:00Z' : null]);
            }
            return id;
        };
        await order('zz-ins-o1', 20000, 'paid', '2001-03-08T10:00:00Z', null, 0, 2);
        await order('zz-ins-o2', 10000, 'refunded', '2001-03-09T10:00:00Z', '2001-03-20T10:00:00Z', 0, 1);
        await order('zz-ins-o3', 0, 'paid', '2001-03-09T10:00:00Z', null, 1, 1);
        await order('zz-ins-o4', 10000, 'pending', null, null, 0, 0);
        ids = { b1, ev };
    } finally {
        db.close();
    }

    const f = (await api('GET', `/api/admin/insights/finance?x=1${W}`)).body;
    const o = f.overview;
    check('finance: booking money = payments minus the refund - no adjustment, no flagged duplicate (R3 000 + R1 000 - R500)', o.bookingRevenue.value === 3500, JSON.stringify(o.bookingRevenue));
    check('finance: ticket money = sold minus refunded, complimentary excluded (R300 - R100)', o.ticketRevenue.value === 200 && f.tickets.gross === 300 && f.tickets.refunds === 100, JSON.stringify(f.tickets));
    check('finance: total revenue counts each rand once (R3 500 + R200), compared with R200 in the 31 days before', o.revenue.value === 3700 && o.revenue.previous === 200, JSON.stringify(o.revenue));
    check('finance: payments received R4 300 (booking payments + tickets sold); refunds R600 shown on their own', o.paymentsReceived.value === 4300 && o.refunds.value === 600, JSON.stringify([o.paymentsReceived, o.refunds]));
    check('finance: invoiced = invoices issued (R10 000) - a void invoice is not counted, and invoiced is NOT revenue', o.invoiced.value === 10000 && f.overview.invoiceCount === 1 && o.revenue.value !== o.invoiced.value, JSON.stringify(o.invoiced));
    check('finance: the overdue invoice (SENT, due 20 Mar 2001) is counted as overdue as of today', o.overdueInvoices.count >= 1 && o.overdueInvoices.value >= 10000, JSON.stringify(o.overdueInvoices));
    check('finance: expenses R400 and net profit R3 300 (revenue - recorded expenses)', o.expenses && o.expenses.value === 400 && o.netProfit.value === 3300, JSON.stringify([o.expenses, o.netProfit]));
    const m = Object.fromEntries(f.payments.methods.map(x => [x.method, x]));
    check('finance: payments by method - PayFast R3 000, EFT R1 000, the duplicate and the adjustment nowhere', m.payfast.value === 3000 && m.payfast.count === 1 && m.eft.value === 1000 && m.cash.value === 0 && m.other.value === 0, JSON.stringify(f.payments.methods));
    check('finance: an uploaded proof of payment is "awaiting checking", never money (R8 888 is in neither revenue nor payments)',
        f.payments.eftAwaitingCheck.count >= 1 && f.payments.eftAwaitingCheck.value >= 8888 && o.paymentsReceived.value === 4300, JSON.stringify(f.payments.eftAwaitingCheck));
    check('finance: the enquiries of the period - 4 in, 2 quoted, 1 accepted, 1 confirmed, 1 cancelled, conversion 25%',
        f.bookings.cohort.enquiries === 4 && f.bookings.cohort.quoted === 2 && f.bookings.cohort.accepted === 1 && f.bookings.cohort.confirmed === 1 && f.bookings.cohort.cancelled === 1 && f.bookings.conversion === 25, JSON.stringify(f.bookings));
    check('finance: average booking value = the agreed total of bookings confirmed in the period (R10 000)', f.bookings.averageValue === 10000, String(f.bookings.averageValue));
    check('finance: quotations - the superseded revision is not counted (1 sent, R5 000)', f.documents.quotes.length === 1 && f.documents.quotes[0].status === 'sent' && f.documents.quotes[0].count === 1 && f.documents.quotes[0].value === 5000, JSON.stringify(f.documents.quotes));
    check('finance: tickets - 2 sold, 1 complimentary, 1 refunded order; by show R200 / 2 tickets; by type R200 / 2',
        f.tickets.ticketsSold === 2 && f.tickets.complimentary === 1 && f.tickets.refundedOrders === 1 &&
        f.tickets.byEvent.some(e => e.label === 'ZZ Insights Show' && e.value === 200 && e.tickets === 2) && f.tickets.byTier.some(t => /ZZ Insights Show - General/.test(t.label) && t.value === 200 && t.tickets === 2), JSON.stringify(f.tickets));
    check('finance: revenue by category and the daily series add up to the same R3 700',
        f.byCategory.some(c => c.label === 'Corporate Event' && c.value === 3500) && Math.round(f.series.reduce((s, r) => s + r.bookings + r.tickets, 0)) === 3700, JSON.stringify([f.byCategory, f.series]));

    const ov = (await api('GET', `/api/admin/insights/overview?x=1${W}`)).body;
    check('overview: revenue R3 700, 4 enquiries, 1 confirmed booking, 2 tickets sold', ov.business.revenue.value === 3700 && ov.business.enquiries.value === 4 && ov.business.confirmedBookings.value === 1 && ov.business.ticketsSold.value === 2 && ov.seesMoney === true, JSON.stringify(ov.business));

    const asst = await loginAs('assistant');
    const ao = (await asst('GET', `/api/admin/insights/overview?x=1${W}`)).body;
    const af = await asst('GET', `/api/admin/insights/finance?x=1${W}`);
    check('an assistant sees the visitor and booking counts but no money, and is refused the Finance tab', ao.success && !('revenue' in ao.business) && !('payments' in ao.business) && ao.business.enquiries.value === 4 && af.status === 403, JSON.stringify([ao.business, af.status]));
    const bad = await api('GET', '/api/admin/insights/finance?range=custom&from=2001-03-31&to=2001-03-01');
    check('a reversed custom range is refused with a reason (400)', bad.status === 400 && /after the end/.test(bad.body.error), JSON.stringify(bad.body));
    check('setup sanity', !!ids, '');

    // the Dashboard's week view (?days=7): today and the six days after it, by day; ?days missing = today only (older callers)
    const sast = (n) => new Date(Date.now() + 2 * 3600e3 + n * 864e5).toISOString().slice(0, 10);
    const wk = new sqlite3.Database(support.TEST_DB);
    try {
        await sqlRun(wk, `INSERT INTO bookings (name, email, date, message, status, event_name, created_at) VALUES ('ZZ Week Client', 'zz.week@example.invalid', ?, 'x', 'CONFIRMED', 'ZZ Week Gig', '2001-01-01 00:00:00')`, [sast(3)]);
        await sqlRun(wk, `INSERT INTO events (event_title, event_datetime, event_status) VALUES ('ZZ Week Show', ?, 'upcoming')`, [sast(5) + 'T19:30']);
        await sqlRun(wk, `INSERT INTO events (event_title, event_datetime, event_status) VALUES ('ZZ Week Cancelled Show', ?, 'cancelled')`, [sast(2) + 'T19:30']);
        await sqlRun(wk, `INSERT INTO events (event_title, event_datetime, event_status) VALUES ('ZZ Next Week Show', ?, 'upcoming')`, [sast(8) + 'T19:30']);
    } finally { wk.close(); }
    const week = (await api('GET', '/api/admin/analytics/todays-schedule?days=7')).body;
    const titles = (week.rows || []).map(r => r.title);
    const gig = (week.rows || []).find(r => r.title === 'ZZ Week Gig'), show = (week.rows || []).find(r => r.title === 'ZZ Week Show');
    check('week view: today + 6 days, each row with its date (a gig in 3 days, a show in 5 at 19:30); nothing cancelled, nothing after the week',
        week.from === sast(0) && week.to === sast(6) && gig && gig.date === sast(3) && show && show.date === sast(5) && show.start_time === '19:30' &&
        !titles.includes('ZZ Week Cancelled Show') && !titles.includes('ZZ Next Week Show'), JSON.stringify(week));
    const sorted = (week.rows || []).every((r, i, a) => i === 0 || String(a[i - 1].date) <= String(r.date));
    const todayOnly = (await api('GET', '/api/admin/analytics/todays-schedule')).body;
    check('week view is in day order; without ?days it is still today only', sorted && todayOnly.from === todayOnly.to && !(todayOnly.rows || []).some(r => r.title === 'ZZ Week Gig'), JSON.stringify(todayOnly));
};
