// The admin Dashboard's Overview and Finance figures (routes/admin/insights.js -> js/admin/dashboard.js). Read-only: it never writes.
//
// Money rules are the EXISTING ones, not new ones:
//   * booking money received = lib/booking-amounts.js revenueRowsSql + receivedAmountSql (completed, not a flagged duplicate; a refund or
//     chargeback comes off; a manual adjustment is not money) - the same rule as the Finance page, the trend and the P&L;
//   * ticket money = ticket_orders (its own tables, never in `transactions`, so it cannot be counted twice): paid orders, minus refunds,
//     complimentary tickets excluded;
//   * an uploaded proof of payment (eft_payment_submissions 'pending') is shown as "awaiting checking" and is never money - only an
//     approved one becomes a `transactions` row (lib/eft-approval.js), and that row is what counts;
//   * receivables = database/repositories/bookings.repository.js getOutstandingTotal (accepted commitments only).
// Dates: transactions / invoices / quotations / expenses carry local calendar dates; booking and ticket timestamps are stored in UTC and
// are shifted to South African time (+2 hours) before they are compared with a date.
const { dbAll, dbGet } = require('./db-helpers');
const { receivedAmountSql, revenueRowsSql, agreedAmountSql } = require('./booking-amounts');
const { pctChange } = require('./insights-range');

const SAST = "'+2 hours'";
const money = (n) => Math.round((Number(n) || 0) * 100) / 100;
const cents = (n) => Math.round(Number(n) || 0) / 100;
const num = (n) => Number(n) || 0;
const withChange = (cur, prev) => ({ value: cur, previous: prev, change: pctChange(cur, prev) });

// booking money received between two dates (inclusive)
const BOOKING_ROWS = `${revenueRowsSql('t')} AND COALESCE(t.transaction_type, '') <> 'adjustment' AND DATE(t.transaction_date) BETWEEN ? AND ?`;

async function bookingMoney(from, to) {
    const r = await dbGet(`SELECT COALESCE(SUM(${receivedAmountSql('t')}), 0) AS net,
                                  COALESCE(SUM(CASE WHEN t.transaction_type IN ('refund','chargeback') THEN t.amount ELSE 0 END), 0) AS refunds,
                                  COALESCE(SUM(CASE WHEN t.transaction_type NOT IN ('refund','chargeback') THEN t.amount ELSE 0 END), 0) AS payments,
                                  COUNT(CASE WHEN t.transaction_type NOT IN ('refund','chargeback') THEN 1 END) AS payment_count
                           FROM transactions t WHERE ${BOOKING_ROWS}`, [from, to]);
    return { net: money(r.net), payments: money(r.payments), refunds: money(r.refunds), paymentCount: num(r.payment_count) };
}

// ticket money between two dates: sold (paid in the period, including orders refunded since), refunded in the period, net
async function ticketMoney(from, to) {
    const sold = await dbGet(`SELECT COALESCE(SUM(total_cents), 0) AS c, COUNT(*) AS orders FROM ticket_orders
                              WHERE complimentary = 0 AND status IN ('paid', 'refunded') AND paid_at IS NOT NULL
                                AND DATE(paid_at, ${SAST}) BETWEEN ? AND ?`, [from, to]);
    const refunded = await dbGet(`SELECT COALESCE(SUM(total_cents), 0) AS c, COUNT(*) AS orders FROM ticket_orders
                                  WHERE complimentary = 0 AND status = 'refunded' AND refunded_at IS NOT NULL
                                    AND DATE(refunded_at, ${SAST}) BETWEEN ? AND ?`, [from, to]);
    const tickets = await dbGet(`SELECT COUNT(*) AS n FROM tickets k JOIN ticket_orders o ON o.id = k.order_id
                                 WHERE o.complimentary = 0 AND o.status = 'paid' AND k.voided_at IS NULL
                                   AND DATE(o.paid_at, ${SAST}) BETWEEN ? AND ?`, [from, to]);
    const gross = cents(sold.c), refunds = cents(refunded.c);
    return { gross, refunds, net: money(gross - refunds), orders: num(sold.orders), refundedOrders: num(refunded.orders), ticketsSold: num(tickets.n) };
}

// first-party visitor figures (tracker.js -> analytics_* tables; consenting visitors only once the consent fix is in)
async function website(from, to) {
    const pv = await dbGet(`SELECT COUNT(*) AS pageviews, COUNT(DISTINCT visitor_id) AS visitors FROM analytics_pageviews
                            WHERE DATE(viewed_at, ${SAST}) BETWEEN ? AND ?`, [from, to]);
    const ss = await dbGet(`SELECT COUNT(*) AS sessions FROM analytics_sessions WHERE DATE(started_at, ${SAST}) BETWEEN ? AND ?`, [from, to]);
    return { visitors: num(pv.visitors), sessions: num(ss.sessions), pageviews: num(pv.pageviews) };
}

async function bookingActivity(from, to) {
    const r = await dbGet(`SELECT
            COUNT(CASE WHEN DATE(created_at, ${SAST}) BETWEEN ? AND ? THEN 1 END) AS enquiries,
            COUNT(CASE WHEN confirmed_at IS NOT NULL AND DATE(confirmed_at, ${SAST}) BETWEEN ? AND ? THEN 1 END) AS confirmed,
            COUNT(CASE WHEN accepted_at IS NOT NULL AND DATE(accepted_at, ${SAST}) BETWEEN ? AND ? THEN 1 END) AS accepted,
            COUNT(CASE WHEN cancelled_at IS NOT NULL AND DATE(cancelled_at, ${SAST}) BETWEEN ? AND ? THEN 1 END) AS cancelled
        FROM bookings`, [from, to, from, to, from, to, from, to]);
    return { enquiries: num(r.enquiries), confirmed: num(r.confirmed), accepted: num(r.accepted), cancelled: num(r.cancelled) };
}

async function receivables() {
    const r = await dbGet(`SELECT COALESCE(SUM(amount_outstanding), 0) AS total FROM bookings WHERE status IN ('ACCEPTED', 'CONFIRMED', 'COMPLETED')`);
    return money(r.total);
}

// ---------------------------------------------------------------------------------------------------------------- Overview

async function overview(range) {
    const [w, wp, bm, bmp, tm, tmp, ba, bap, outstanding] = await Promise.all([
        website(range.from, range.to), website(range.prevFrom, range.prevTo),
        bookingMoney(range.from, range.to), bookingMoney(range.prevFrom, range.prevTo),
        ticketMoney(range.from, range.to), ticketMoney(range.prevFrom, range.prevTo),
        bookingActivity(range.from, range.to), bookingActivity(range.prevFrom, range.prevTo),
        receivables()
    ]);
    return {
        website: {
            visitors: withChange(w.visitors, wp.visitors),
            sessions: withChange(w.sessions, wp.sessions),
            pageviews: withChange(w.pageviews, wp.pageviews)
        },
        business: {
            revenue: withChange(money(bm.net + tm.net), money(bmp.net + tmp.net)),
            payments: withChange(bm.payments + tm.gross, bmp.payments + tmp.gross),
            outstanding: { value: outstanding, asOfToday: true },
            confirmedBookings: withChange(ba.confirmed, bap.confirmed),
            enquiries: withChange(ba.enquiries, bap.enquiries),
            ticketsSold: withChange(tm.ticketsSold, tmp.ticketsSold)
        }
    };
}

// ---------------------------------------------------------------------------------------------------------------- Finance

// chart buckets: days, or months for long ranges (finance has no hourly view)
function bucketFormat(range) { return range.granularity === 'month' ? '%Y-%m' : '%Y-%m-%d'; }

async function revenueSeries(range) {
    const fmt = bucketFormat(range);
    const booking = await dbAll(`SELECT strftime('${fmt}', DATE(t.transaction_date)) AS k, SUM(${receivedAmountSql('t')}) AS v
                                 FROM transactions t WHERE ${BOOKING_ROWS} GROUP BY k ORDER BY k`, [range.from, range.to]);
    const sold = await dbAll(`SELECT strftime('${fmt}', DATE(paid_at, ${SAST})) AS k, SUM(total_cents) AS c FROM ticket_orders
                              WHERE complimentary = 0 AND status IN ('paid','refunded') AND paid_at IS NOT NULL AND DATE(paid_at, ${SAST}) BETWEEN ? AND ?
                              GROUP BY k`, [range.from, range.to]);
    const refunded = await dbAll(`SELECT strftime('${fmt}', DATE(refunded_at, ${SAST})) AS k, SUM(total_cents) AS c FROM ticket_orders
                                  WHERE complimentary = 0 AND status = 'refunded' AND refunded_at IS NOT NULL AND DATE(refunded_at, ${SAST}) BETWEEN ? AND ?
                                  GROUP BY k`, [range.from, range.to]);
    const map = {};
    const at = (k) => (map[k] = map[k] || { bucket: k, bookings: 0, tickets: 0 });
    booking.forEach(r => { at(r.k).bookings += money(r.v); });
    sold.forEach(r => { at(r.k).tickets += cents(r.c); });
    refunded.forEach(r => { at(r.k).tickets -= cents(r.c); });
    return Object.values(map).sort((a, b) => (a.bucket < b.bucket ? -1 : 1)).map(r => ({ bucket: r.bucket, bookings: money(r.bookings), tickets: money(r.tickets) }));
}

async function finance(range) {
    const { from, to, prevFrom, prevTo } = range;
    const [bm, bmp, tm, tmp, outstanding] = await Promise.all([
        bookingMoney(from, to), bookingMoney(prevFrom, prevTo), ticketMoney(from, to), ticketMoney(prevFrom, prevTo), receivables()
    ]);

    // invoices issued in the period; open / overdue ones as of today (both SENT and OVERDUE count - see the report)
    const invPeriod = await dbAll(`SELECT UPPER(COALESCE(status,'')) AS status, COUNT(*) AS n, COALESCE(SUM(total_amount),0) AS v FROM invoices
                                   WHERE UPPER(COALESCE(status,'')) <> 'VOID' AND DATE(invoice_date) BETWEEN ? AND ? GROUP BY 1`, [from, to]);
    const invPrev = await dbGet(`SELECT COALESCE(SUM(total_amount),0) AS v FROM invoices WHERE UPPER(COALESCE(status,'')) <> 'VOID' AND DATE(invoice_date) BETWEEN ? AND ?`, [prevFrom, prevTo]);
    const invOpen = await dbGet(`SELECT COUNT(*) AS n, COALESCE(SUM(total_amount),0) AS v,
                                        COUNT(CASE WHEN due_date IS NOT NULL AND DATE(due_date) < DATE('now', ${SAST}) THEN 1 END) AS overdue_n,
                                        COALESCE(SUM(CASE WHEN due_date IS NOT NULL AND DATE(due_date) < DATE('now', ${SAST}) THEN total_amount END),0) AS overdue_v
                                 FROM invoices WHERE UPPER(COALESCE(status,'')) IN ('SENT','OVERDUE','PARTIAL','PARTIALLY_PAID')`);
    const invoiced = invPeriod.reduce((s, r) => s + num(r.v), 0);
    const invoiceCount = invPeriod.reduce((s, r) => s + num(r.n), 0);

    // quotations created in the period (current versions only: a revision archives the one before it)
    const quotes = await dbAll(`SELECT LOWER(COALESCE(status,'')) AS status, COUNT(*) AS n, COALESCE(SUM(total_amount),0) AS v FROM quotations
                                WHERE COALESCE(archived,0) = 0 AND LOWER(COALESCE(status,'')) NOT IN ('void','archived')
                                  AND DATE(COALESCE(quote_date, created_at)) BETWEEN ? AND ? GROUP BY 1`, [from, to]);

    // expenses: only shown - and net profit only worked out - when expenses have been recorded at all
    const expAny = await dbGet(`SELECT COUNT(*) AS n FROM expenses WHERE deleted_at IS NULL`);
    const exp = await dbGet(`SELECT COALESCE(SUM(amount),0) AS v FROM expenses WHERE deleted_at IS NULL AND expense_date BETWEEN ? AND ?`, [from, to]);
    const expP = await dbGet(`SELECT COALESCE(SUM(amount),0) AS v FROM expenses WHERE deleted_at IS NULL AND expense_date BETWEEN ? AND ?`, [prevFrom, prevTo]);
    const tracksExpenses = num(expAny.n) > 0;
    const revenue = money(bm.net + tm.net), revenuePrev = money(bmp.net + tmp.net);

    // payments by method in the period (payments only; refunds shown on their own)
    const methods = await dbAll(`SELECT CASE WHEN COALESCE(t.source,'') = 'payfast' OR t.payment_method = 'payfast' THEN 'payfast'
                                             WHEN t.payment_method = 'bank_transfer' THEN 'eft'
                                             WHEN t.payment_method = 'cash' THEN 'cash' ELSE 'other' END AS method,
                                        COUNT(*) AS n, COALESCE(SUM(t.amount),0) AS v
                                 FROM transactions t WHERE ${BOOKING_ROWS} AND t.transaction_type NOT IN ('refund','chargeback') GROUP BY 1`, [from, to]);
    const eftPending = await dbGet(`SELECT COUNT(*) AS n, COALESCE(SUM(claimed_amount),0) AS v FROM eft_payment_submissions WHERE status = 'pending'`);
    const eftRejected = await dbGet(`SELECT COUNT(*) AS n FROM eft_payment_submissions WHERE status IN ('rejected','replacement_requested') AND DATE(COALESCE(reviewed_at, created_at), ${SAST}) BETWEEN ? AND ?`, [from, to]);
    const ticketPending = await dbGet(`SELECT COUNT(*) AS n FROM ticket_orders WHERE status = 'pending' AND checkout_started_at IS NOT NULL`);
    const ticketFailed = await dbGet(`SELECT COUNT(*) AS n FROM ticket_orders WHERE status = 'failed' AND DATE(COALESCE(failed_at, created_at), ${SAST}) BETWEEN ? AND ?`, [from, to]);

    // bookings: what happened in the period, and the journey of the enquiries that arrived in it
    const act = await bookingActivity(from, to);
    const actP = await bookingActivity(prevFrom, prevTo);
    const cohort = await dbGet(`SELECT COUNT(*) AS enquiries,
            COUNT(CASE WHEN ${agreedAmountSql('b')} THEN 1 END) AS quoted,
            COUNT(CASE WHEN b.accepted_at IS NOT NULL OR b.status IN ('ACCEPTED','CONFIRMED','COMPLETED') THEN 1 END) AS accepted,
            COUNT(CASE WHEN b.confirmed_at IS NOT NULL OR b.status IN ('CONFIRMED','COMPLETED') THEN 1 END) AS confirmed,
            COUNT(CASE WHEN COALESCE(b.amount_paid,0) > 0 THEN 1 END) AS paid,
            COUNT(CASE WHEN b.status = 'CANCELLED' THEN 1 END) AS cancelled
        FROM bookings b WHERE DATE(b.created_at, ${SAST}) BETWEEN ? AND ?`, [from, to]);
    const avgValue = await dbGet(`SELECT AVG(b.total_amount) AS v, COUNT(*) AS n FROM bookings b
                                  WHERE b.confirmed_at IS NOT NULL AND DATE(b.confirmed_at, ${SAST}) BETWEEN ? AND ? AND ${agreedAmountSql('b')}`, [from, to]);

    const byCategory = await dbAll(`SELECT COALESCE(NULLIF(b.event_type,''),'Other') AS label, SUM(${receivedAmountSql('t')}) AS v
                                    FROM transactions t JOIN bookings b ON b.id = t.booking_id WHERE ${BOOKING_ROWS} GROUP BY 1 ORDER BY v DESC LIMIT 8`, [from, to]);
    const byClient = await dbAll(`SELECT COALESCE(c.full_name, b.name, 'Unknown') AS label, SUM(${receivedAmountSql('t')}) AS v
                                  FROM transactions t JOIN bookings b ON b.id = t.booking_id LEFT JOIN clients c ON c.id = b.client_id
                                  WHERE ${BOOKING_ROWS} GROUP BY 1 ORDER BY v DESC LIMIT 6`, [from, to]);

    // tickets by show and by ticket type (paid in the period, refunds taken off)
    const byEvent = await dbAll(`SELECT e.event_title AS label,
                                        SUM(CASE WHEN o.status = 'paid' THEN o.total_cents ELSE 0 END) AS c,
                                        (SELECT COUNT(*) FROM tickets k JOIN ticket_orders o2 ON o2.id = k.order_id
                                          WHERE o2.event_id = o.event_id AND o2.status = 'paid' AND o2.complimentary = 0 AND k.voided_at IS NULL
                                            AND DATE(o2.paid_at, ${SAST}) BETWEEN ? AND ?) AS tickets
                                 FROM ticket_orders o JOIN events e ON e.event_id = o.event_id
                                 WHERE o.complimentary = 0 AND o.status IN ('paid','refunded') AND DATE(o.paid_at, ${SAST}) BETWEEN ? AND ?
                                 GROUP BY o.event_id ORDER BY c DESC LIMIT 8`, [from, to, from, to]);
    const byTier = await dbAll(`SELECT e.event_title || ' - ' || tt.name AS label, SUM(i.quantity) AS qty, SUM(i.quantity * i.unit_price_cents) AS c
                                FROM ticket_order_items i JOIN ticket_orders o ON o.id = i.order_id JOIN ticket_types tt ON tt.id = i.ticket_type_id
                                JOIN events e ON e.event_id = o.event_id
                                WHERE o.complimentary = 0 AND o.status = 'paid' AND DATE(o.paid_at, ${SAST}) BETWEEN ? AND ?
                                GROUP BY i.ticket_type_id ORDER BY c DESC LIMIT 8`, [from, to]);
    const comps = await dbGet(`SELECT COUNT(*) AS n FROM tickets k JOIN ticket_orders o ON o.id = k.order_id
                               WHERE o.complimentary = 1 AND DATE(o.paid_at, ${SAST}) BETWEEN ? AND ?`, [from, to]);
    const refundDue = await dbGet(`SELECT COUNT(*) AS n, COALESCE(SUM(total_cents),0) AS c FROM ticket_orders WHERE status = 'paid' AND refund_required = 1`);

    // the last 12 months, bookings vs tickets, whatever the period chosen (the "trend" view)
    const monthly = await revenueSeries({ from: twelveMonthsAgo(to), to, granularity: 'month' });

    return {
        overview: {
            revenue: withChange(revenue, revenuePrev),
            bookingRevenue: withChange(bm.net, bmp.net),
            ticketRevenue: withChange(tm.net, tmp.net),
            paymentsReceived: withChange(money(bm.payments + tm.gross), money(bmp.payments + tmp.gross)),
            refunds: { value: money(bm.refunds + tm.refunds) },
            invoiced: withChange(money(invoiced), money(invPrev.v)),
            invoiceCount,
            outstanding: { value: outstanding, asOfToday: true },
            openInvoices: { count: num(invOpen.n), value: money(invOpen.v), asOfToday: true },
            overdueInvoices: { count: num(invOpen.overdue_n), value: money(invOpen.overdue_v), asOfToday: true },
            expenses: tracksExpenses ? withChange(money(exp.v), money(expP.v)) : null,
            netProfit: tracksExpenses ? withChange(money(revenue - exp.v), money(revenuePrev - expP.v)) : null
        },
        series: await revenueSeries(range),
        monthly,
        byCategory: byCategory.map(r => ({ label: r.label, value: money(r.v) })),
        byClient: byClient.map(r => ({ label: r.label, value: money(r.v) })),
        bookings: {
            period: { ...act, previous: actP },
            cohort: { enquiries: num(cohort.enquiries), quoted: num(cohort.quoted), accepted: num(cohort.accepted), confirmed: num(cohort.confirmed), paid: num(cohort.paid), cancelled: num(cohort.cancelled) },
            conversion: num(cohort.enquiries) ? Math.round((num(cohort.confirmed) / num(cohort.enquiries)) * 1000) / 10 : null,
            averageValue: num(avgValue.n) ? money(avgValue.v) : null,
            revenue: bm.net
        },
        payments: {
            methods: ['payfast', 'eft', 'cash', 'other'].map(m => { const r = methods.find(x => x.method === m) || {}; return { method: m, count: num(r.n), value: money(r.v) }; }),
            refunds: money(bm.refunds + tm.refunds),
            eftAwaitingCheck: { count: num(eftPending.n), value: money(eftPending.v), asOfToday: true },
            eftRejected: num(eftRejected.n),
            ticketCheckoutsOpen: num(ticketPending.n),
            ticketPaymentsFailed: num(ticketFailed.n),
            outstanding
        },
        documents: {
            quotes: quotes.map(r => ({ status: r.status, count: num(r.n), value: money(r.v) })),
            invoices: invPeriod.map(r => ({ status: r.status, count: num(r.n), value: money(r.v) })),
            averageInvoice: invoiceCount ? money(invoiced / invoiceCount) : null
        },
        tickets: {
            gross: tm.gross, refunds: tm.refunds, net: tm.net, orders: tm.orders, ticketsSold: tm.ticketsSold, refundedOrders: tm.refundedOrders,
            complimentary: num(comps.n),
            refundDue: { count: num(refundDue.n), value: cents(refundDue.c), asOfToday: true },
            byEvent: byEvent.map(r => ({ label: r.label, value: cents(r.c), tickets: num(r.tickets) })),
            byTier: byTier.map(r => ({ label: r.label, value: cents(r.c), tickets: num(r.qty) }))
        },
        tracksExpenses
    };
}

function twelveMonthsAgo(to) {
    const d = new Date(to + 'T00:00:00Z');
    d.setUTCMonth(d.getUTCMonth() - 11, 1);
    return d.toISOString().slice(0, 10);
}

module.exports = { overview, finance, bookingMoney, ticketMoney, website, revenueSeries };
