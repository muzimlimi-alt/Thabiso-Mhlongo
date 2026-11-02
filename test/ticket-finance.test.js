// Finance <- Event ticketing (lib/ticket-finance.js, GET /api/admin/ticketing/finance*) against the real server.
//   * only orders PayFast confirmed count as money; pending / abandoned ones never do;
//   * a refund comes off (net = received - refunded) and the same order is not counted twice;
//   * PayFast's fee is taken from the verified notification, and reported as "not known" - not as zero - where PayFast sent none;
//   * revenue by ticket category, by event, the month trend, upcoming shows (projection kept apart from real money);
//   * the reconciliation finds an order with no verified payment, and is clean for an honest one;
//   * administrators / managers only; every figure here equals what the existing Ticket Sales tiles say.
// Date offset 2050 is reserved for this file. The event it creates is cancelled before it ends.
const sqlite3 = require('sqlite3');
const { api, pub, one, future, sleep, loginAs, TEST_DB } = require('./support');
const { generatePayFastItnSignature } = require('../lib/payfast-signature');

const waitFor = async (fn, ms = 20000) => { const t = Date.now(); let v; while (Date.now() - t < ms) { v = await fn(); if (v) return v; await sleep(200); } return v; };
const mod = (sql, p) => new Promise((res, rej) => { const db = new sqlite3.Database(TEST_DB); db.run(sql, p, (er) => { db.close(); er ? rej(er) : res(); }); });
let pf = 0;

module.exports = async function ({ check }) {
    const made = [];
    try { await suite(check, made); }
    finally { for (const ev of made) await api('PUT', `/api/admin/events/${ev.id}`, { event_title: ev.title, event_datetime: ev.when, event_status: 'cancelled', sync_to_gcal: false }).catch(() => {}); }
};

async function suite(check, made) {
    const stamp = Date.now();
    const when = `${future(2050)}T20:00`;
    const ev = (await api('POST', '/api/admin/events', { event_title: 'ZZ Finance Show', event_datetime: when, venue_name: 'Finance Hall', event_status: 'upcoming', sync_to_gcal: false })).body;
    made.push({ id: ev.id, title: 'ZZ Finance Show', when });
    const gen = (await api('POST', `/api/admin/events/${ev.id}/ticket-types`, { name: 'General', price: '100', is_active: true, max_per_order: 6, capacity: 20 })).body.tier;
    const vip = (await api('POST', `/api/admin/events/${ev.id}/ticket-types`, { name: 'VIP', price: '300', is_active: true, max_per_order: 6, capacity: 10 })).body.tier;

    const start = async (items, who) => {
        const o = (await pub('POST', '/api/public/ticket-orders', { event_id: ev.id, items })).body.order;
        await pub('POST', `/api/public/ticket-orders/${o.reference}/checkout`, { buyer_name: who, buyer_email: `fin.${stamp}.${who}@example.invalid`, buyer_phone: '0821110000', popia_consent: true, terms_accepted: true });
        return one('SELECT * FROM ticket_orders WHERE public_reference = ?', [o.reference]);
    };
    const pay = async (row, fee) => {
        const m = { m_payment_id: row.m_payment_id, pf_payment_id: `FIN-${stamp}-${++pf}`, payment_status: 'COMPLETE', item_name: 'x', item_description: '', amount_gross: (row.total_cents / 100).toFixed(2),
            ...(fee ? { amount_fee: fee, amount_net: ((row.total_cents / 100) + Number(fee)).toFixed(2) } : {}), name_first: 'F', name_last: 'B', email_address: row.buyer_email, merchant_id: '10000100' };
        m.signature = generatePayFastItnSignature(m, null);
        await pub('POST', '/api/payment/webhook/payfast', m);
        await waitFor(async () => (await one('SELECT status FROM ticket_orders WHERE id = ?', [row.id])).status === 'paid');
    };
    // A: 2 General (R200, fee R3.45)   B: 1 VIP (R300, fee R5.00)   C: 1 General (R100, no fee on the notification), refunded   D: 1 VIP left pending
    const A = await start([{ ticket_type_id: gen.id, quantity: 2 }], 'Alpha'); await pay(A, '-3.45');
    const B = await start([{ ticket_type_id: vip.id, quantity: 1 }], 'Bravo'); await pay(B, '-5.00');
    const C = await start([{ ticket_type_id: gen.id, quantity: 1 }], 'Charlie'); await pay(C, null);
    const rf = await api('POST', `/api/admin/ticketing/orders/${C.id}/refund`, { note: 'Refunded in PayFast (test)' });
    const D = await start([{ ticket_type_id: vip.id, quantity: 1 }], 'Delta');
    check('setup: three paid orders, one refunded, one still pending', rf.status === 200 && (await one('SELECT status FROM ticket_orders WHERE id = ?', [D.id])).status === 'pending', JSON.stringify(rf.body));

    const today = new Date().toISOString().slice(0, 10);
    const r = await api('GET', `/api/admin/ticketing/finance?date_from=${today}&date_to=${today}`);
    const e = (r.body.by_event || []).find(x => x.event_id === ev.id);
    check('the overview lists this show', r.status === 200 && !!e, JSON.stringify(r.body).slice(0, 300));
    if (!e) return;
    check('gross = every order PayFast confirmed (A + B + C = R600), including the one refunded later', e.gross === 600, e.gross);
    check('refunded = R100; net revenue = R500 (the refunded order is counted once as received and once as refunded)', e.refunded === 100 && e.net_revenue === 500, JSON.stringify(e));
    check('tickets sold = 3 (the refunded ticket is not sold)', e.tickets_sold === 3, e.tickets_sold);
    check('PayFast fees = R8.45 from the verified notifications; the order without a fee is reported as unknown, not zero', e.fees === 8.45 && e.fees_known_orders === 2 && e.fees_unknown_orders === 1, JSON.stringify(e));
    check('net receipts = net revenue - fees', e.net_receipts === 491.55, e.net_receipts);
    const stats = (await api('GET', `/api/admin/ticketing/events/${ev.id}/stats`)).body.stats;
    check("the net revenue equals the Ticket Sales tile's revenue for the same show (one rule, not two)", Math.round(e.net_revenue * 100) === stats.revenue_cents, `${e.net_revenue} vs ${stats.revenue_cents}`);

    const tiers = r.body.by_tier || [];
    const g = tiers.find(t => t.tier === 'General'), v = tiers.find(t => t.tier === 'VIP');
    check('revenue by category: General sold 2 for R200 net, VIP 1 for R300', g && g.tickets_sold >= 2 && v && v.tickets_sold >= 1 && g.net_revenue >= 200 && v.net_revenue >= 300, JSON.stringify(tiers));
    check('a pending (unpaid) order is NOT revenue - it is reported on its own', r.body.not_revenue.pending.orders >= 1 && r.body.totals.gross === r.body.by_event.reduce((s, x) => s + x.gross, 0), JSON.stringify(r.body.not_revenue));
    check('this month shows in the trend', (r.body.trend || []).some(t => t.month === today.slice(0, 7) && t.gross >= 600 && t.refunded >= 100), JSON.stringify(r.body.trend));
    const up = (r.body.upcoming || []).find(x => x.event_id === ev.id);
    check('upcoming: real money (R500) is kept apart from the held ticket (R300) and the unsold ceiling', up && up.actual_net_revenue === 500 && up.held_in_checkout === 300 && up.unsold_open_potential === 18 * 100 + 8 * 300 && up.projected_if_sold_out === 500 + 300 + 18 * 100 + 8 * 300, JSON.stringify(up));
    check('reconciliation: orders, payments and tickets agree for these orders', !(r.body.reconciliation.issues || []).some(i => [A.id, B.id, C.id].includes(i.order_id)), JSON.stringify(r.body.reconciliation.issues));
    check('the consolidated block carries client-booking money by method', typeof r.body.bookings.total === 'number' && 'payfast' in r.body.bookings && 'eft' in r.body.bookings, JSON.stringify(r.body.bookings));

    // drill-down
    const ord = await api('GET', `/api/admin/ticketing/finance/events/${ev.id}/orders`);
    const byId = (id) => (ord.body.orders || []).find(o => o.id === id);
    check("drill-down: the event's orders with amount, fee and status", byId(A.id) && byId(A.id).amount === 200 && byId(A.id).fee === 3.45 && byId(C.id).status === 'refunded' && byId(C.id).fee === null && byId(D.id).status === 'pending', JSON.stringify(ord.body.orders));
    const pay1 = await api('GET', `/api/admin/ticketing/finance/orders/${A.id}`);
    check("drill-down: one order's money trail (gross, fee, net, verified notification)", pay1.body.payment.gross === 200 && pay1.body.payment.fee === 3.45 && pay1.body.payment.net_receipt === 196.55 && pay1.body.payment.notifications.some(n => n.verified && n.status === 'COMPLETE'), JSON.stringify(pay1.body));
    const pay2 = await api('GET', `/api/admin/ticketing/finance/orders/${D.id}`);
    check('a pending order has no gross in its trail', pay2.body.payment.gross === 0 && pay2.body.payment.net_receipt === null, JSON.stringify(pay2.body));

    // reconciliation catches a broken order (the module only reads: break the data, look, put it back)
    const goodId = (await one('SELECT gateway_payment_id AS g FROM ticket_orders WHERE id = ?', [B.id])).g;
    await mod("UPDATE ticket_orders SET gateway_payment_id = 'NO-SUCH-PAYMENT' WHERE id = ?", [B.id]);
    const bad = await api('GET', `/api/admin/ticketing/finance?date_from=${today}&date_to=${today}`);
    check('reconciliation flags an order whose payment cannot be found', (bad.body.reconciliation.issues || []).some(i => i.order_id === B.id && i.kind === 'no_verified_payment') && bad.body.reconciliation.clean === false, JSON.stringify(bad.body.reconciliation.issues));
    await mod('UPDATE ticket_orders SET gateway_payment_id = ? WHERE id = ?', [goodId, B.id]);

    // roles: money is for administrators and managers
    const mgr = await loginAs('manager'), asst = await loginAs('assistant');
    check('a manager can read it', (await mgr('GET', '/api/admin/ticketing/finance')).status === 200, '');
    check('an assistant cannot', (await asst('GET', '/api/admin/ticketing/finance')).status === 403 && (await asst('GET', `/api/admin/ticketing/finance/orders/${A.id}`)).status === 403, '');
    const anon = await pub('GET', '/api/admin/ticketing/finance');
    check('anonymous visitors cannot', anon.status === 401 || anon.status === 403, anon.status);
}
