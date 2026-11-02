// Ticket sales as MONEY, for Finance (admin Finance -> Ticket Sales, and the consolidated revenue-sources strip).
// This module only READS: ticket_orders / ticket_order_items / ticket_types / tickets / ticket_webhook_events (lib/ticketing*.js are the
// authoritative writers) and, for the consolidated view, `transactions` with the same rules as every other revenue figure
// (lib/booking-amounts.js). It never writes and never recalculates what an order costs - an order's total_cents was fixed at checkout.
//
// What counts as money (the same rule the Ticket Sales tiles use, lib/ticketing.js eventStats):
//   * RECEIVED     = an order PayFast confirmed (status paid or refunded, not complimentary), dated by paid_at;
//   * REFUNDED     = status refunded, dated by refunded_at (it leaves the account, like a refund transaction on a booking);
//   * REFUND OWED  = status paid + refund_required (PayFast took the money but the seats had gone) - received, but owed back;
//   * NET REVENUE  = received - refunded - owed  (a later-refunded order is counted once as received and once as refunded);
//   * FEES         = PayFast's own amount_fee from the VERIFIED payment notification, only where PayFast sent one (a payment recovered
//                    by the safety net from the history has none - it is reported as "fee not known", never as zero);
//   * NOT REVENUE  = pending, failed, expired / abandoned orders and complimentary tickets (reported apart, in counts and what they were worth).
// Amounts leave this module in rand (cents / 100) so they sit beside the booking figures, which are rand.
const { dbAll, dbGet } = require('./db-helpers');
const { receivedAmountSql, revenueRowsSql } = require('./booking-amounts');

const rand = (cents) => Math.round(Number(cents) || 0) / 100;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function period(from, to) {
    const now = new Date();
    const f = DATE_RE.test(from || '') ? from : new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
    const t = DATE_RE.test(to || '') ? to : now.toISOString().slice(0, 10);
    return { from: f, to: t };
}

// PayFast's fee for one verified notification: amount_fee comes back as "-3.45" (money leaving) - the size of it is what we need.
function feeCentsFromPayload(raw) {
    if (!raw) return null;
    let o; try { o = JSON.parse(raw); } catch (e) { return null; }
    if (!o || o.amount_fee === undefined || o.amount_fee === null || o.amount_fee === '') return null;
    const n = Math.abs(Number(o.amount_fee));
    return Number.isFinite(n) ? Math.round(n * 100) : null;
}

// order id -> fee in cents, for the confirmed orders given (one verified COMPLETE notification each).
async function feesFor(orderIds) {
    const out = new Map();
    if (!orderIds.length) return out;
    for (let i = 0; i < orderIds.length; i += 400) {
        const chunk = orderIds.slice(i, i + 400);
        const rows = await dbAll(
            `SELECT order_id, raw_payload FROM ticket_webhook_events
             WHERE verified = 1 AND payment_status = 'COMPLETE' AND order_id IN (${chunk.map(() => '?').join(',')}) ORDER BY id`, chunk);
        for (const r of rows) { const f = feeCentsFromPayload(r.raw_payload); if (f !== null && !out.has(r.order_id)) out.set(r.order_id, f); }
    }
    return out;
}

// Orders PayFast confirmed (received) in the period, with their fee.
async function receivedOrders(p) {
    const rows = await dbAll(
        `SELECT o.id, o.event_id, o.total_cents, o.status, o.refund_required, o.paid_at, o.refunded_at,
                (SELECT COALESCE(SUM(quantity), 0) FROM ticket_order_items WHERE order_id = o.id) AS qty
         FROM ticket_orders o
         WHERE o.status IN ('paid', 'refunded') AND o.complimentary = 0 AND o.paid_at IS NOT NULL AND DATE(o.paid_at) BETWEEN ? AND ?`, [p.from, p.to]);
    const fees = await feesFor(rows.map(r => r.id));
    return rows.map(r => ({ ...r, fee_cents: fees.has(r.id) ? fees.get(r.id) : null }));
}

const blank = () => ({ orders: 0, tickets: 0, received_c: 0, refunded_c: 0, owed_c: 0, fee_c: 0, fee_known: 0, fee_missing: 0 });
function addTo(acc, o) {
    acc.orders += 1; acc.tickets += o.qty; acc.received_c += o.total_cents;
    if (o.status === 'refunded') { acc.refunded_c += o.total_cents; acc.tickets -= o.qty; }
    else if (o.refund_required) { acc.owed_c += o.total_cents; acc.tickets -= o.qty; }
    if (o.fee_cents === null) acc.fee_missing += 1; else { acc.fee_c += o.fee_cents; acc.fee_known += 1; }
}
function shape(a) {
    const net = a.received_c - a.refunded_c - a.owed_c;
    return {
        orders: a.orders, tickets_sold: a.tickets, gross: rand(a.received_c), refunded: rand(a.refunded_c), refund_owed: rand(a.owed_c), net_revenue: rand(net),
        fees: rand(a.fee_c), fees_known_orders: a.fee_known, fees_unknown_orders: a.fee_missing,
        net_receipts: rand(net - a.fee_c)
    };
}

// Orders that are NOT revenue, by what became of them (created in the period).
async function notRevenue(p) {
    const r = await dbAll(
        `SELECT status, complimentary, COUNT(*) AS n, COALESCE(SUM(total_cents), 0) AS cents,
                COALESCE(SUM(CASE WHEN checkout_started_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS at_checkout
         FROM ticket_orders WHERE status IN ('pending', 'failed', 'expired') AND DATE(created_at) BETWEEN ? AND ? GROUP BY status`, [p.from, p.to]);
    const pick = (s) => r.find(x => x.status === s) || { n: 0, cents: 0, at_checkout: 0 };
    const comps = await dbGet(`SELECT COALESCE(SUM(i.quantity), 0) AS n FROM ticket_order_items i JOIN ticket_orders o ON o.id = i.order_id
        WHERE o.complimentary = 1 AND o.status = 'paid' AND DATE(o.paid_at) BETWEEN ? AND ?`, [p.from, p.to]);
    return {
        pending: { orders: pick('pending').n, value: rand(pick('pending').cents) },
        failed: { orders: pick('failed').n, value: rand(pick('failed').cents) },
        abandoned: { orders: pick('expired').n, value: rand(pick('expired').cents), reached_checkout: pick('expired').at_checkout },
        complimentary_tickets: comps.n
    };
}

async function byEvent(p, orders) {
    const map = new Map();
    for (const o of orders) { if (!map.has(o.event_id)) map.set(o.event_id, blank()); addTo(map.get(o.event_id), o); }
    const ids = [...map.keys()];
    const evs = ids.length ? await dbAll(`SELECT event_id, event_title, event_datetime, event_status FROM events WHERE event_id IN (${ids.map(() => '?').join(',')})`, ids) : [];
    return evs.map(e => ({ event_id: e.event_id, title: e.event_title, starts: e.event_datetime, status: e.event_status, ...shape(map.get(e.event_id)) }))
        .sort((a, b) => b.net_revenue - a.net_revenue);
}

// By ticket category (the tier's name, across events): tickets and money from the order lines (price as it was at checkout).
async function byTier(p) {
    const rows = await dbAll(
        `SELECT t.name AS tier, o.status, o.refund_required, SUM(i.quantity) AS qty, SUM(i.quantity * i.unit_price_cents) AS cents
         FROM ticket_order_items i JOIN ticket_orders o ON o.id = i.order_id JOIN ticket_types t ON t.id = i.ticket_type_id
         WHERE o.status IN ('paid', 'refunded') AND o.complimentary = 0 AND o.paid_at IS NOT NULL AND DATE(o.paid_at) BETWEEN ? AND ?
         GROUP BY t.name, o.status, o.refund_required`, [p.from, p.to]);
    const m = new Map();
    for (const r of rows) {
        const x = m.get(r.tier) || { tier: r.tier, tickets_sold: 0, gross_c: 0, net_c: 0 };
        x.gross_c += r.cents;
        if (r.status === 'paid' && !r.refund_required) { x.tickets_sold += r.qty; x.net_c += r.cents; }
        m.set(r.tier, x);
    }
    return [...m.values()].map(x => ({ tier: x.tier, tickets_sold: x.tickets_sold, gross: rand(x.gross_c), net_revenue: rand(x.net_c) })).sort((a, b) => b.net_revenue - a.net_revenue);
}

// Month by month for the last 12 months: received (by paid date) and refunded (by refund date).
async function trend() {
    const from = new Date(); from.setMonth(from.getMonth() - 11); from.setDate(1);
    const f = from.toISOString().slice(0, 10);
    const rec = await dbAll(`SELECT strftime('%Y-%m', paid_at) AS month, SUM(total_cents) AS cents, SUM(CASE WHEN refund_required = 1 AND status = 'paid' THEN total_cents ELSE 0 END) AS owed
        FROM ticket_orders WHERE status IN ('paid', 'refunded') AND complimentary = 0 AND paid_at IS NOT NULL AND DATE(paid_at) >= ? GROUP BY month`, [f]);
    const ref = await dbAll(`SELECT strftime('%Y-%m', refunded_at) AS month, SUM(total_cents) AS cents FROM ticket_orders
        WHERE status = 'refunded' AND complimentary = 0 AND refunded_at IS NOT NULL AND DATE(refunded_at) >= ? GROUP BY month`, [f]);
    const m = {};
    for (const r of rec) m[r.month] = { month: r.month, received_c: r.cents, refunded_c: 0, owed_c: r.owed };
    for (const r of ref) { m[r.month] = m[r.month] || { month: r.month, received_c: 0, refunded_c: 0, owed_c: 0 }; m[r.month].refunded_c = r.cents; }
    return Object.values(m).sort((a, b) => (a.month < b.month ? -1 : 1))
        .map(x => ({ month: x.month, gross: rand(x.received_c), refunded: rand(x.refunded_c + x.owed_c), net_revenue: rand(x.received_c - x.refunded_c - x.owed_c) }));
}

// Upcoming shows: what has ACTUALLY been received (net) apart from what is only a projection (held in a checkout / still unsold).
async function upcoming() {
    const rows = await dbAll(
        `SELECT e.event_id, e.event_title, e.event_datetime, e.event_status,
                COALESCE(SUM(t.capacity), 0) AS capacity, COALESCE(SUM(t.sold), 0) AS sold, COALESCE(SUM(t.reserved), 0) AS reserved,
                COALESCE(SUM(t.reserved * t.price_cents), 0) AS held_c,
                COALESCE(SUM(CASE WHEN t.is_active = 1 THEN (t.capacity - t.sold - t.reserved) * t.price_cents ELSE 0 END), 0) AS open_c
         FROM events e JOIN ticket_types t ON t.event_id = e.event_id
         WHERE e.event_datetime >= datetime('now') AND LOWER(COALESCE(e.event_status, '')) NOT IN ('cancelled', 'draft')
         GROUP BY e.event_id ORDER BY e.event_datetime`);
    const out = [];
    for (const r of rows) {
        const m = await dbGet(`SELECT COALESCE(SUM(CASE WHEN status = 'paid' AND refund_required = 0 THEN total_cents END), 0) AS net FROM ticket_orders WHERE event_id = ?`, [r.event_id]);
        out.push({
            event_id: r.event_id, title: r.event_title, starts: r.event_datetime, status: r.event_status,
            capacity: r.capacity, sold: r.sold, held: r.reserved,
            actual_net_revenue: rand(m.net),                       // received and not refunded: real money
            held_in_checkout: rand(r.held_c),                      // tickets being paid for right now: NOT revenue yet
            unsold_open_potential: rand(r.open_c),                 // seats still on sale x price: a ceiling, not a forecast
            projected_if_sold_out: rand(m.net + r.held_c + r.open_c)
        });
    }
    return out;
}

// Does every confirmed order have its payment, its ticket(s), and the right amount - and is no ticket payment also on a booking?
async function reconcile() {
    const confirmed = await dbGet(`SELECT COUNT(*) AS n FROM ticket_orders WHERE status IN ('paid', 'refunded') AND complimentary = 0`);
    const noPayment = await dbAll(
        `SELECT o.id, o.total_cents FROM ticket_orders o
         WHERE o.status IN ('paid', 'refunded') AND o.complimentary = 0
           AND NOT EXISTS (SELECT 1 FROM ticket_webhook_events w WHERE w.order_id = o.id AND w.verified = 1 AND w.payment_status = 'COMPLETE'
                           AND w.gateway_payment_id = o.gateway_payment_id) LIMIT 50`);
    const wrongAmount = await dbAll(
        `SELECT o.id, o.total_cents, w.amount_cents FROM ticket_orders o JOIN ticket_webhook_events w ON w.order_id = o.id AND w.verified = 1 AND w.payment_status = 'COMPLETE'
         WHERE o.status IN ('paid', 'refunded') AND o.complimentary = 0 AND w.amount_cents IS NOT NULL AND w.amount_cents <> o.total_cents LIMIT 50`);
    const ticketGap = await dbAll(
        `SELECT o.id, (SELECT COALESCE(SUM(quantity), 0) FROM ticket_order_items WHERE order_id = o.id) AS expected,
                (SELECT COUNT(*) FROM tickets k WHERE k.order_id = o.id AND k.voided_at IS NULL) AS issued
         FROM ticket_orders o WHERE o.status = 'paid' AND o.refund_required = 0 AND o.complimentary = 0
           AND expected <> issued LIMIT 50`);
    const refundedStillValid = await dbAll(
        `SELECT o.id, COUNT(k.id) AS live FROM ticket_orders o JOIN tickets k ON k.order_id = o.id AND k.voided_at IS NULL
         WHERE o.status = 'refunded' GROUP BY o.id LIMIT 50`);
    // the same PayFast payment id must never be on a ticket order AND on a booking transaction
    const alsoOnBooking = await dbAll(
        `SELECT o.id, o.gateway_payment_id FROM ticket_orders o JOIN transactions t ON t.pf_payment_id = o.gateway_payment_id
         WHERE o.gateway_payment_id IS NOT NULL LIMIT 50`);
    const issues = [
        ...noPayment.map(r => ({ order_id: r.id, kind: 'no_verified_payment', text: 'Marked paid, but there is no verified PayFast payment for it.' })),
        ...wrongAmount.map(r => ({ order_id: r.id, kind: 'amount_differs', text: `PayFast confirmed R${rand(r.amount_cents).toFixed(2)} but the order is R${rand(r.total_cents).toFixed(2)}.` })),
        ...ticketGap.map(r => ({ order_id: r.id, kind: 'tickets_differ', text: `${r.issued} valid ticket(s) issued for ${r.expected} bought.` })),
        ...refundedStillValid.map(r => ({ order_id: r.id, kind: 'refunded_tickets_valid', text: `Refunded, but ${r.live} ticket(s) still work at the door.` })),
        ...alsoOnBooking.map(r => ({ order_id: r.id, kind: 'also_on_booking', text: 'The same PayFast payment is also recorded against a booking - it would be counted twice.' }))
    ];
    return { confirmed_orders: confirmed.n, clean: issues.length === 0, issues };
}

// Client-booking money by how it arrived (PayFast / bank transfer / cash / other): the same rows and the same rule as every booking figure.
async function bookingRevenue(p) {
    const rows = await dbAll(
        `SELECT CASE WHEN t.payment_method = 'payfast' THEN 'payfast' WHEN t.payment_method = 'bank_transfer' THEN 'eft' WHEN t.payment_method = 'cash' THEN 'cash' ELSE 'other' END AS method,
                COALESCE(SUM(${receivedAmountSql('t')}), 0) AS amount
         FROM transactions t WHERE ${revenueRowsSql('t')} AND COALESCE(t.transaction_type, '') <> 'adjustment' AND DATE(t.transaction_date) BETWEEN ? AND ? GROUP BY method`, [p.from, p.to]);
    const by = { payfast: 0, eft: 0, cash: 0, other: 0 };
    for (const r of rows) by[r.method] = Math.round(r.amount * 100) / 100;
    return { ...by, total: Math.round((by.payfast + by.eft + by.cash + by.other) * 100) / 100 };
}

async function overview(from, to) {
    const p = period(from, to);
    const orders = await receivedOrders(p);
    const all = blank(); orders.forEach(o => addTo(all, o));
    const totals = shape(all);
    // refunds issued IN the period may belong to orders paid before it: the cash view counts them when they happened
    const refundsInPeriod = await dbGet(`SELECT COALESCE(SUM(total_cents), 0) AS c, COUNT(*) AS n FROM ticket_orders WHERE status = 'refunded' AND complimentary = 0 AND DATE(refunded_at) BETWEEN ? AND ?`, [p.from, p.to]);
    const owedNow = await dbGet(`SELECT COALESCE(SUM(total_cents), 0) AS c, COUNT(*) AS n FROM ticket_orders WHERE status = 'paid' AND refund_required = 1 AND complimentary = 0`);
    return {
        period: p, totals,
        refunds: { issued_in_period: rand(refundsInPeriod.c), issued_orders: refundsInPeriod.n, outstanding_now: rand(owedNow.c), outstanding_orders: owedNow.n },
        not_revenue: await notRevenue(p),
        by_event: await byEvent(p, orders), by_tier: await byTier(p), trend: await trend(), upcoming: await upcoming(),
        reconciliation: await reconcile(), bookings: await bookingRevenue(p)
    };
}

// One event's orders, each with its payment (gross / PayFast fee / net) - the drill-down under an event row.
async function eventOrders(eventId) {
    const rows = await dbAll(
        `SELECT o.id, o.buyer_name, o.buyer_email, o.total_cents, o.status, o.refund_required, o.complimentary, o.paid_at, o.refunded_at, o.gateway_payment_id,
                (SELECT COALESCE(SUM(quantity), 0) FROM ticket_order_items WHERE order_id = o.id) AS qty
         FROM ticket_orders o WHERE o.event_id = ? AND o.status IN ('paid', 'refunded', 'pending', 'failed', 'expired') ORDER BY o.id DESC LIMIT 500`, [eventId]);
    const fees = await feesFor(rows.filter(r => r.status === 'paid' || r.status === 'refunded').map(r => r.id));
    return rows.map(r => ({
        id: r.id, buyer: r.buyer_name, email: r.buyer_email, tickets: r.qty, amount: rand(r.total_cents), complimentary: !!r.complimentary,
        status: r.status === 'paid' && r.refund_required ? 'refund_owed' : r.status, paid_at: r.paid_at, refunded_at: r.refunded_at,
        pf_payment_id: r.gateway_payment_id, fee: fees.has(r.id) ? rand(fees.get(r.id)) : null
    }));
}

// One order's money trail: the order, its PayFast payment(s) and the fee.
async function orderPayment(orderId) {
    const o = await dbGet('SELECT id, total_cents, status, refund_required, complimentary, gateway_payment_id, paid_at, refunded_at, refund_note FROM ticket_orders WHERE id = ?', [orderId]);
    if (!o) return null;
    const fees = await feesFor([o.id]);
    const notes = await dbAll(`SELECT payment_status, amount_cents, source, verified, outcome, received_at FROM ticket_webhook_events WHERE order_id = ? ORDER BY id`, [o.id]);
    const fee = fees.has(o.id) ? fees.get(o.id) : null;
    const counted = (o.status === 'paid' || o.status === 'refunded') && !o.complimentary;
    return {
        order_id: o.id, status: o.status, refund_required: !!o.refund_required, complimentary: !!o.complimentary, pf_payment_id: o.gateway_payment_id,
        gross: counted ? rand(o.total_cents) : 0, fee: fee === null ? null : rand(fee), net_receipt: counted && fee !== null ? rand(o.total_cents - fee) : null,
        refunded: o.status === 'refunded' ? rand(o.total_cents) : 0, refund_owed: o.status === 'paid' && o.refund_required ? rand(o.total_cents) : 0,
        paid_at: o.paid_at, refunded_at: o.refunded_at, refund_note: o.refund_note,
        notifications: notes.map(n => ({ status: n.payment_status, amount: n.amount_cents === null ? null : rand(n.amount_cents), source: n.source, verified: !!n.verified, outcome: n.outcome, at: n.received_at }))
    };
}

module.exports = { overview, eventOrders, orderPayment, feeCentsFromPayload, period };
