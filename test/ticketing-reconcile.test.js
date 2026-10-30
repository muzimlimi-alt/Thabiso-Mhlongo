// Event ticketing x the PayFast safety net (lib/payfast-reconcile.js): a buyer paid for tickets at PayFast but the notification never arrived.
// The existing safety net must find it in PayFast's OWN records (test/fake-payfast-api.js, as strict as PayFast) and record it exactly once
// through the same confirmTicketPayment() the notification uses - tickets issued, or a refund flagged if they sold out meanwhile - and must
// never credit anything that does not match. Date offsets 1940-1949 are reserved for this file.
const sqlite3 = require('sqlite3');
const { api, pub, q, one, future, sleep, TEST_DB } = require('./support');
const { createFakePayFastApi, row, sastNow } = require('./fake-payfast-api');
const { generatePayFastItnSignature } = require('../lib/payfast-signature');

const write = (sql, params = []) => new Promise((resolve, reject) => {
    const d = new sqlite3.Database(TEST_DB);
    d.configure('busyTimeout', 8000);
    d.run(sql, params, function (e) { d.close(() => (e ? reject(e) : resolve(this))); });
});
const poll = async (fn, ms = 15000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(150); } return v; };

module.exports = async function ({ check }) {
    const made = [];
    const fake = createFakePayFastApi({ port: 3198, merchantId: '10000100', passphrase: '' });
    await fake.start();
    try { await suite(check, fake, made); }
    finally {
        await fake.stop();
        for (const ev of made) await api('PUT', `/api/admin/events/${ev.id}`, { event_title: ev.title, event_datetime: ev.when, event_status: 'cancelled', sync_to_gcal: false }).catch(() => {});
    }
};

async function suite(check, fake, made) {
    let pf = 8100000 + Math.floor(Math.random() * 100000);
    const nextPf = () => String(++pf);
    const when = `${future(1940)}T20:00`;
    const title = 'Ticketing Safety Net Show';
    const ev = (await api('POST', '/api/admin/events', { event_title: title, event_datetime: when, venue_name: 'Hall', event_status: 'upcoming', sync_to_gcal: false })).body;
    made.push({ id: ev.id, title, when });
    // 4 places: a takes 2, b holds 1, c takes 1 -> full; later b's hold lapses, e buys its place, and b's payment turns up too late
    const tier = (await api('POST', `/api/admin/events/${ev.id}/ticket-types`, { name: 'General', price: '200', capacity: 4, max_per_order: 3, is_active: true })).body.tier;
    // a buyer who went to PayFast (reserved + checkout) - and whose notification never comes
    const startPaying = async (qty, email) => {
        const ref = (await pub('POST', '/api/public/ticket-orders', { event_id: ev.id, items: [{ ticket_type_id: tier.id, quantity: qty }] })).body.order.reference;
        await pub('POST', `/api/public/ticket-orders/${ref}/checkout`, { buyer_name: 'Net Buyer', buyer_email: email, buyer_phone: '0821234567', popia_consent: true });
        return one('SELECT * FROM ticket_orders WHERE public_reference = ?', [ref]);
    };
    const pfRow = (o, over = {}) => row({ date: sastNow(5), grossCents: o.total_cents, mPaymentId: o.m_payment_id, pfPaymentId: nextPf(), name: `Tickets - Order ${o.id}`, ...over });
    const runFor = (o) => api('POST', '/api/admin/payfast/reconcile/run', { ticket_order_id: o.id });
    const getOrder = (id) => one('SELECT * FROM ticket_orders WHERE id = ?', [id]);
    const tickets = async (id) => (await one('SELECT COUNT(*) AS n FROM tickets WHERE order_id = ?', [id])).n;
    const tierRow = () => one('SELECT sold, reserved FROM ticket_types WHERE id = ?', [tier.id]);

    // ═══ recovered: PayFast has the payment, we never heard ═══
    const a = await startPaying(2, `net.a.${Date.now()}@example.invalid`);
    fake.reset();
    const rowA = fake.addRow(pfRow(a));
    const r1 = await runFor(a);
    const paidA = await poll(async () => { const o = await getOrder(a.id); return o.status === 'paid' ? o : null; });
    check('safety net: a ticket payment PayFast received but never notified is found in PayFast\'s own history and recorded - order paid, tickets issued',
        r1.status === 200 && r1.body.recovered.length === 1 && !!paidA && paidA.gateway_payment_id === rowA.pfPaymentId && (await tickets(a.id)) === 2, JSON.stringify(r1.body));
    check('...the held tickets became sold (no double count)', (await tierRow()).sold === 2 && (await tierRow()).reserved === 0, JSON.stringify(await tierRow()));
    const fA = await one('SELECT * FROM payfast_reconcile_findings WHERE pf_payment_id = ?', [rowA.pfPaymentId]);
    check('...and the safety net\'s own record names the ticket order (kind recovered, already resolved)', !!fA && fA.kind === 'recovered' && fA.status === 'resolved' && fA.ticket_order_id === a.id && fA.booking_id === null, JSON.stringify(fA));
    const listed = await api('GET', '/api/admin/payfast/reconcile');
    const inList = ((listed.body && listed.body.findings) || []).find(f => String(f.pf_payment_id) === rowA.pfPaymentId);
    check('the admin findings list shows it with the buyer\'s name (ticket orders have no booking)', !!inList && inList.client_name === 'Net Buyer', JSON.stringify(inList));
    const mailA = await poll(async () => one("SELECT id FROM notifications WHERE recipient_email = ? AND subject LIKE 'Your tickets - %'", [a.buyer_email]));
    check('...and the buyer gets their tickets by e-mail, exactly as after a notification', !!mailA, '');

    const again = await runFor(a);
    check('running the check again records nothing more (the order is paid, so it is not even a candidate)', again.body.recovered.length === 0 && (await tickets(a.id)) === 2, JSON.stringify(again.body));
    // the lost notification turns up after all
    const late = { m_payment_id: a.m_payment_id, pf_payment_id: rowA.pfPaymentId, payment_status: 'COMPLETE', item_name: 'x', item_description: '', amount_gross: (a.total_cents / 100).toFixed(2), amount_fee: '-1.00', amount_net: '1.00',
        custom_str1: '', custom_str2: '', custom_str3: '', custom_str4: '', custom_str5: '', custom_int1: '', custom_int2: '', custom_int3: '', custom_int4: '', custom_int5: '', name_first: 'Net', name_last: 'Buyer', email_address: a.buyer_email, merchant_id: '10000100' };
    late.signature = generatePayFastItnSignature(late, null);
    await pub('POST', '/api/payment/webhook/payfast', late);
    await poll(async () => (await q('SELECT outcome FROM ticket_webhook_events WHERE order_id = ? AND source = ? ORDER BY id DESC', [a.id, 'itn'])).some(r => r.outcome === 'ignored_duplicate'));
    check('the lost notification arriving AFTER the recovery is ignored as a duplicate - still 2 tickets, still 2 sold',
        (await q("SELECT outcome FROM ticket_webhook_events WHERE order_id = ? AND source = 'itn'", [a.id])).some(r => r.outcome === 'ignored_duplicate') && (await tickets(a.id)) === 2 && (await tierRow()).sold === 2, JSON.stringify(await q('SELECT source, verified, outcome FROM ticket_webhook_events WHERE order_id = ?', [a.id])));

    // ═══ never credited: a different amount ═══
    const b = await startPaying(1, `net.b.${Date.now()}@example.invalid`);
    fake.reset();
    const rowB = fake.addRow(pfRow(b, { grossCents: b.total_cents - 1 }));
    const r2 = await runFor(b);
    const fB = await one('SELECT * FROM payfast_reconcile_findings WHERE pf_payment_id = ?', [rowB.pfPaymentId]);
    check('a payment for the wrong amount is NEVER credited: the order stays unpaid and a finding (mismatch) names the ticket order',
        r2.status === 200 && r2.body.recovered.length === 0 && (await getOrder(b.id)).status === 'pending' && !!fB && fB.kind === 'mismatch' && fB.status === 'open' && fB.ticket_order_id === b.id, JSON.stringify([r2.body, fB]));

    // ═══ the buyer's return check ═══
    const c = await startPaying(1, `net.c.${Date.now()}@example.invalid`);
    const early = await pub('POST', `/api/public/ticket-orders/${c.public_reference}/payment-check`);
    check('buyer return check right after paying: nothing yet (a notification on its way gets 30 s to win by itself)', early.status === 200 && early.body.status === 'nothing', JSON.stringify(early.body));
    await write('UPDATE ticket_orders SET checkout_started_at = ? WHERE id = ?', [new Date(Date.now() - 60000).toISOString(), c.id]);
    fake.reset();
    fake.addRow(pfRow(c, { date: sastNow(-30) }));
    const ret = await pub('POST', `/api/public/ticket-orders/${c.public_reference}/payment-check`);
    check('buyer return check a minute later: PayFast has it -> "recorded", the order is paid, and the answer is a status word only',
        ret.body.status === 'recorded' && (await getOrder(c.id)).status === 'paid' && Object.keys(ret.body).sort().join() === 'status,success', JSON.stringify(ret.body));

    // ═══ late: b's hold ran out, its place went to someone else, THEN b's (right-amount) payment shows up in PayFast's history ═══
    await write('UPDATE ticket_orders SET reserved_until = ? WHERE id = ?', [new Date(Date.now() - 1000).toISOString(), b.id]);
    await pub('GET', `/api/public/ticket-orders/${b.public_reference}`);           // releases b's hold
    const e = await startPaying(1, `net.e.${Date.now()}@example.invalid`);
    fake.reset();
    const rowE = fake.addRow(pfRow(e));
    await runFor(e);                                                              // e pays (recovered) -> the show is sold out
    fake.reset();
    const rowB2 = fake.addRow(pfRow(b));                                          // NOW b's real payment, right amount, turns up in PayFast's history
    const r3 = await runFor(b);
    const owed = await getOrder(b.id);
    check('late recovery after a sell-out: recorded as paid but flagged for a refund, no tickets, and never oversold (4 of 4)',
        r3.body.recovered.length === 1 && owed.status === 'paid' && owed.refund_required === 1 && (await tickets(b.id)) === 0 && (await tierRow()).sold === 4 && (await tierRow()).reserved === 0,
        JSON.stringify([r3.body, owed, await tierRow(), rowE.pfPaymentId, rowB2.pfPaymentId]));
}
