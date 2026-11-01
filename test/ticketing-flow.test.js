// Event ticketing end to end against the real server (docs-internal/ticketing.md): an admin's event and tiers -> the public Events list ->
// reserve (incl. the last-ticket race over HTTP) -> checkout (the signed PayFast redirect) -> PayFast's notification on the SAME webhook bookings
// use (forged, wrong amount, genuine, replayed, cancelled, failed, late) -> tickets + e-mail + PDF -> the /t/<token> page -> door check-in
// (double scan, two phones at once, roles) -> refund -> CSV / figures. Every order here is confirmed ONLY by a notification, never by a return.
// Date offsets 1920-1949 are reserved for this file. Every event it creates is cancelled before it ends.
const sqlite3 = require('sqlite3');
const { api, pub, q, one, future, sleep, loginAs, BASE, TEST_DB, getChildLog, extractPdfText } = require('./support');
const { generatePayFastItnSignature, generatePayFastSignature } = require('../lib/payfast-signature');

const evDate = (offset, time = '20:00') => `${future(offset)}T${time}`;
const MERCHANT_ID = '10000100';
let pfSeq = 0;

module.exports = async function ({ check }) {
    const made = [];
    const rw = new sqlite3.Database(TEST_DB);
    rw.configure('busyTimeout', 8000);
    const run = (sql, p = []) => new Promise((res, rej) => rw.run(sql, p, function (e) { e ? rej(e) : res(this); }));
    try { await suite(check, made, run); }
    finally {
        for (const ev of made) await api('PUT', `/api/admin/events/${ev.id}`, { event_title: ev.title, event_datetime: ev.when, event_status: 'cancelled', sync_to_gcal: false }).catch(() => {});
        await new Promise(r => rw.close(r));
    }
};

async function waitFor(fn, ms = 20000) { const t = Date.now(); let v; while (Date.now() - t < ms) { v = await fn(); if (v) return v; await sleep(200); } return v; }

async function makeEvent(made, offset, title) {
    const when = evDate(offset);
    const r = await api('POST', '/api/admin/events', { event_title: title, event_datetime: when, venue_name: 'Ticket Test Hall', event_status: 'upcoming', sync_to_gcal: false });
    if (r.body && r.body.id) made.push({ id: r.body.id, title, when });
    return { id: r.body && r.body.id, title, when };
}
async function addTier(eventId, body) {
    const r = await api('POST', `/api/admin/events/${eventId}/ticket-types`, { is_active: true, ...body });
    return r.body && r.body.tier;
}
const reserve = (eventId, items) => pub('POST', '/api/public/ticket-orders', { event_id: eventId, items });
const buyer = (over = {}) => ({ buyer_name: 'Thandi Test', buyer_email: `buyer.${Date.now()}.${pfSeq}@example.invalid`, buyer_phone: '0821234567', popia_consent: true, terms_accepted: true, ...over });
const order = (ref) => pub('GET', `/api/public/ticket-orders/${ref}`);
const dbOrder = (ref) => one('SELECT * FROM ticket_orders WHERE public_reference = ?', [ref]);
const tierRow = (id) => one('SELECT * FROM ticket_types WHERE id = ?', [id]);

// a notification shaped like PayFast's own (field order, blank fields, signature last)
function itnFor(o, { status = 'COMPLETE', amount, pfPaymentId } = {}) {
    const m = {
        m_payment_id: o.m_payment_id, pf_payment_id: pfPaymentId || `TKT-PF-${Date.now()}-${++pfSeq}`, payment_status: status, item_name: `Tickets - Order ${o.id}`, item_description: '',
        amount_gross: amount || (o.total_cents / 100).toFixed(2), amount_fee: '-5.00', amount_net: '1.00',
        custom_str1: '', custom_str2: '', custom_str3: '', custom_str4: '', custom_str5: '', custom_int1: '', custom_int2: '', custom_int3: '', custom_int4: '', custom_int5: '',
        name_first: 'Thandi', name_last: "O'Test", email_address: o.buyer_email || 'x@example.invalid', merchant_id: MERCHANT_ID
    };
    m.signature = generatePayFastItnSignature(m, null);
    return m;
}
const postItn = (itn) => pub('POST', '/api/payment/webhook/payfast', itn);
const outcomes = async (orderId) => (await q('SELECT outcome FROM ticket_webhook_events WHERE order_id = ? ORDER BY id', [orderId])).map(r => r.outcome);

async function suite(check, made, run) {
    // ═══════════ 1. admin sets up a show ═══════════
    const ev = await makeEvent(made, 1920, 'Ticketing Flow Show');
    const gen = await addTier(ev.id, { name: 'General', price: '150', capacity: 5, max_per_order: 4 });
    const vip = await addTier(ev.id, { name: 'VIP', price: '500', capacity: 1, max_per_order: 1 });
    const bare = await makeEvent(made, 1921, 'Ticketing No Tiers Show');
    check('setup: event with two on-sale tiers and an event with none', !!(ev.id && gen && vip && bare.id), JSON.stringify({ ev, gen, vip }));

    const list = await pub('GET', '/api/public/events');
    const card = (list.body || []).find(e => e.event_id === ev.id);
    const plain = (list.body || []).find(e => e.event_id === bare.id);
    check('public Events list: the ticketed show says on sale from the cheapest tier (R150); a show without tiers has ticketing null (keeps its old link)',
        card && card.ticketing && card.ticketing.state === 'on_sale' && card.ticketing.from_cents === 15000 && plain && plain.ticketing === null, JSON.stringify([card && card.ticketing, plain && plain.ticketing]));
    const offer = await pub('GET', `/api/public/events/${ev.id}/tickets`);
    check('the drawer gets the tiers with price, remaining and limit - and never sold / reserved / capacity',
        offer.status === 200 && offer.body.tiers.length === 2 && offer.body.tiers[0].remaining === 5 && !('sold' in offer.body.tiers[0]) && !('capacity' in offer.body.tiers[0]) && offer.body.hold_minutes === 10, JSON.stringify(offer.body));

    // ═══════════ 2. reserve ═══════════
    const r1 = await reserve(ev.id, [{ ticket_type_id: gen.id, quantity: 2, unit_price_cents: 1 }]);
    const o1 = r1.body && r1.body.order;
    check('reserve: 201, a 10-minute hold, the total from the DATABASE price (a client-sent price is ignored)',
        r1.status === 201 && o1.status === 'pending' && o1.total_cents === 30000 && Math.round((Date.parse(o1.reserved_until) - Date.parse(o1.server_now)) / 60000) === 10, JSON.stringify(r1.body));
    check('reserve: the stock is held', (await tierRow(gen.id)).reserved === 2, '');

    const race = await Promise.all(Array.from({ length: 10 }, () => reserve(ev.id, [{ ticket_type_id: vip.id, quantity: 1 }])));
    const won = race.filter(r => r.status === 201);
    const lost = race.filter(r => r.status === 409);
    check('RACE over HTTP: 10 buyers for the last VIP ticket -> exactly one hold, nine "sold out" answers carrying the fresh counts',
        won.length === 1 && lost.length === 9 && lost.every(r => r.body.sold_out.includes(vip.id) && Array.isArray(r.body.tiers) && r.body.tiers.find(t => t.id === vip.id).remaining === 0)
        && (await tierRow(vip.id)).reserved === 1, JSON.stringify(race.map(r => r.status)));
    const vipRef = won[0] && won[0].body.order.reference;

    // ═══════════ 3. checkout ═══════════
    const noConsent = await pub('POST', `/api/public/ticket-orders/${o1.reference}/checkout`, buyer({ popia_consent: false }));
    check('checkout: without POPIA consent it is refused (400) and nothing goes to PayFast', noConsent.status === 400 && noConsent.body.errors.popia_consent && !noConsent.body.pfData, JSON.stringify(noConsent.body));
    const noTerms = await pub('POST', `/api/public/ticket-orders/${o1.reference}/checkout`, buyer({ terms_accepted: false }));
    check('checkout: without accepting the ticket terms it is refused too (400)', noTerms.status === 400 && !!noTerms.body.errors.popia_consent && !noTerms.body.pfData, JSON.stringify(noTerms.body));
    const b1 = buyer({ buyer_email: `flow.buyer.${Date.now()}@example.invalid`, holder_names: ['Alice Holder', ''] });
    const co = await pub('POST', `/api/public/ticket-orders/${o1.reference}/checkout`, b1);
    const pf = co.body && co.body.pfData;
    const row1 = await dbOrder(o1.reference);
    const { signature, ...unsigned } = pf || {};
    check('checkout: the signed PayFast redirect - TKT_<order>, R300.00 from the order, return/cancel back to the order, notify to the shared webhook',
        co.status === 200 && pf.m_payment_id === `TKT_${row1.id}` && pf.amount === '300.00' && pf.return_url.includes(`tickets=${encodeURIComponent(o1.reference)}`) && pf.return_url.includes('payment=success')
        && pf.cancel_url.includes('payment=cancel') && /\/api\/payment\/webhook\/payfast$/.test(pf.notify_url) && pf.merchant_id === MERCHANT_ID && /payfast\.co\.za/.test(co.body.pfHost), JSON.stringify(co.body));
    check('checkout: the signature is PayFast\'s checkout recipe over exactly the posted fields', signature === generatePayFastSignature(unsigned, null), '');
    check('checkout: buyer, consent time + policy version and per-ticket names are stored', row1.buyer_email === b1.buyer_email && !!row1.consent_at && row1.consent_policy_version === 'v2.2' && /^ticket-terms-/.test(row1.terms_version || '') && row1.holder_names === '["Alice Holder",null]', JSON.stringify(row1));
    const pending = await order(o1.reference);
    check('status before payment: pending, no tickets, e-mail shown masked', pending.body.order.status === 'pending' && pending.body.order.tickets.length === 0 && /^f\*+@example\.invalid$/.test(pending.body.order.email_hint), JSON.stringify(pending.body.order));

    // ═══════════ 4. PayFast's notification ═══════════
    const forged = itnFor(row1);
    forged.amount_gross = '1.00';                                  // tampered after signing
    await postItn(forged);
    await waitFor(async () => (await outcomes(row1.id)).includes('rejected_signature'));
    check('a FORGED notification (tampered after signing) is refused - even in sandbox - and the order stays pending',
        (await outcomes(row1.id)).includes('rejected_signature') && (await dbOrder(o1.reference)).status === 'pending', JSON.stringify(await outcomes(row1.id)));

    const wrongAmount = itnFor(row1, { amount: '299.99' });
    await postItn(wrongAmount);
    await waitFor(async () => (await outcomes(row1.id)).includes('rejected_amount_mismatch'));
    check('a correctly signed notification for the WRONG amount is refused - the amount must equal the order total to the cent',
        (await outcomes(row1.id)).includes('rejected_amount_mismatch') && (await dbOrder(o1.reference)).status === 'pending', JSON.stringify(await outcomes(row1.id)));

    const genuine = itnFor(row1, { pfPaymentId: forged.pf_payment_id });        // the SAME PayFast id the forgery used: the forgery must not have taken its slot
    await postItn(genuine);
    const paid = await waitFor(async () => { const r = await dbOrder(o1.reference); return r.status === 'paid' ? r : null; });
    const tix = paid ? await q('SELECT * FROM tickets WHERE order_id = ? ORDER BY id', [paid.id]) : [];
    check('the genuine notification marks it paid - even though a forgery used the same PayFast id first (unverified rows never block it)', !!paid && paid.gateway_payment_id === forged.pf_payment_id, JSON.stringify(paid));
    check('inventory: held -> sold for exactly that order', (await tierRow(gen.id)).sold === 2 && (await tierRow(gen.id)).reserved === 0, JSON.stringify(await tierRow(gen.id)));
    check('tickets: one per admission, each with its own 24-char random token; per-ticket names used, the blank one gets the buyer\'s name',
        tix.length === 2 && new Set(tix.map(t => t.token)).size === 2 && tix.every(t => /^[A-Za-z0-9_-]{24}$/.test(t.token)) && tix[0].holder_name === 'Alice Holder' && tix[1].holder_name === 'Thandi Test', JSON.stringify(tix));
    check('the verified notification is stored once, marked paid', (await q("SELECT COUNT(*) AS n FROM ticket_webhook_events WHERE order_id = ? AND verified = 1", [paid.id]))[0].n === 1 && (await outcomes(paid.id)).includes('paid'), JSON.stringify(await outcomes(paid.id)));

    await postItn(genuine);                                                      // PayFast retries the same notification
    await waitFor(async () => (await outcomes(paid.id)).includes('ignored_duplicate'));
    check('REPLAY: the same notification again is ignored - still 2 tickets, still 2 sold',
        (await outcomes(paid.id)).includes('ignored_duplicate') && (await q('SELECT COUNT(*) AS n FROM tickets WHERE order_id = ?', [paid.id]))[0].n === 2 && (await tierRow(gen.id)).sold === 2, JSON.stringify(await outcomes(paid.id)));

    // the buyer pays a SECOND time for the same order (two browser tabs): a different PayFast payment, the right amount
    const second = itnFor(paid);
    await postItn(second);
    const dupFinding = await waitFor(async () => one('SELECT * FROM payfast_reconcile_findings WHERE pf_payment_id = ?', [second.pf_payment_id]).catch(() => null));
    check('PAID TWICE: a second, different PayFast payment for an already-paid order is reported (Finance -> Reconciliation finding), never ignored - and issues nothing',
        !!dupFinding && dupFinding.kind === 'duplicate_payment' && dupFinding.status === 'open' && dupFinding.ticket_order_id === paid.id && dupFinding.booking_id === null
        && (await outcomes(paid.id)).includes('second_payment_reported') && (await q('SELECT COUNT(*) AS n FROM tickets WHERE order_id = ?', [paid.id]))[0].n === 2 && (await tierRow(gen.id)).sold === 2,
        JSON.stringify([dupFinding, await outcomes(paid.id)]));
    await postItn(second);                                                       // PayFast repeats that second notification
    await waitFor(async () => (await outcomes(paid.id)).filter(o => o === 'second_payment_reported').length >= 2);
    check('...PayFast repeating that notification does not report it twice', (await q('SELECT COUNT(*) AS n FROM payfast_reconcile_findings WHERE pf_payment_id = ?', [second.pf_payment_id]))[0].n === 1, '');

    // ═══════════ 5. delivery ═══════════
    const mail = await waitFor(async () => one("SELECT * FROM notifications WHERE recipient_email = ? AND subject LIKE 'Your tickets - %' ORDER BY id DESC LIMIT 1", [b1.buyer_email]).catch(() => null));
    check('the buyer is e-mailed through the existing mail queue: one "Your tickets" e-mail, the PDF attached, the QR codes inline, the trigger recorded',
        !!mail && /tickets-order-\d+\.pdf/.test(mail.attachment_paths || '') && /application\/pdf/.test(mail.attachment_paths || '') && /Tickets: Confirmation/.test(mail.body || '') && /data:image\/png;base64/.test(mail.body || ''),
        JSON.stringify({ subject: mail && mail.subject, att: mail && String(mail.attachment_paths).slice(0, 200) }));
    const viewPaid = await order(o1.reference);
    check('status after payment: paid, with both tickets and a QR code (data: PNG) each', viewPaid.body.order.status === 'paid' && viewPaid.body.order.tickets.length === 2 && viewPaid.body.order.tickets.every(t => /^data:image\/png;base64,/.test(t.qr)), JSON.stringify(viewPaid.body.order).slice(0, 300));
    const pdfRes = await fetch(`${BASE}/api/public/ticket-orders/${o1.reference}/tickets.pdf`);
    const pdfBuf = Buffer.from(await pdfRes.arrayBuffer());
    const pdfText = extractPdfText(pdfBuf);
    check('the tickets PDF downloads (one page per ticket) and prints the show, tier and the names', pdfRes.status === 200 && /application\/pdf/.test(pdfRes.headers.get('content-type')) && pdfText.includes('Ticketing Flow Show') && pdfText.includes('General') && pdfText.includes('Alice Holder'), pdfText.slice(0, 200));

    // ═══════════ 6. the ticket page + door check-in ═══════════
    const [t1, t2] = tix;
    const page = await fetch(`${BASE}/t/${t1.token}`);
    const html = await page.text();
    check('/t/<token> for anyone: "Valid ticket for <show>" and NOTHING else - no name, no order, no e-mail; not cached, not indexed',
        page.status === 200 && html.includes('Valid ticket for Ticketing Flow Show') && !html.includes('Alice') && !html.includes('Thandi') && !/\bOrder\b/i.test(html) && !html.includes('@example.invalid')
        && /noindex/.test(html) && page.headers.get('cache-control') === 'no-store', `cache-control=${page.headers.get('cache-control')} ` + html.slice(html.indexOf('<main'), html.indexOf('<main') + 500));
    const nope = await fetch(`${BASE}/t/AAAAAAAAAAAAAAAAAAAAAAAA`);
    check('/t/<token> for an unknown token: 404 "Ticket not found"', nope.status === 404 && (await nope.text()).includes('Ticket not found'), String(nope.status));
    const viewed = await one('SELECT checked_in_at FROM tickets WHERE id = ?', [t1.id]);
    check('opening the ticket page (or a link preview of it) never checks anyone in', viewed.checked_in_at === null, JSON.stringify(viewed));

    const anonIn = await pub('POST', `/api/admin/ticketing/tickets/${t1.token}/check-in`);
    check('check-in without being signed in is refused (401)', anonIn.status === 401, String(anonIn.status));
    const look = await api('GET', `/api/admin/ticketing/tickets/${t1.token}`);
    check('staff lookup shows holder, tier and "valid" (a GET changes nothing)', look.status === 200 && look.body.ticket.holder === 'Alice Holder' && look.body.ticket.tier === 'General' && look.body.ticket.status === 'valid' && look.body.counts.valid === 2 && look.body.counts.checked_in === 0, JSON.stringify(look.body));
    const asst = await loginAs('assistant');
    const in1 = await asst('POST', `/api/admin/ticketing/tickets/${t1.token}/check-in`);
    check('an assistant at the door checks the ticket in: "Admitted"', in1.status === 200 && in1.body.result === 'admitted' && in1.body.message === 'Admitted' && in1.body.counts.checked_in === 1, JSON.stringify(in1.body));
    const in2 = await api('POST', `/api/admin/ticketing/tickets/${t1.token}/check-in`);
    check('DOUBLE SCAN: the second scan is refused "Already scanned at HH:MM"', in2.body.result === 'already' && /^Already scanned at \d{2}:\d{2}$/.test(in2.body.message) && in2.body.success === false, JSON.stringify(in2.body));
    const both = await Promise.all([api('POST', `/api/admin/ticketing/tickets/${t2.token}/check-in`), asst('POST', `/api/admin/ticketing/tickets/${t2.token}/check-in`)]);
    check('two phones scanning the same ticket at the same instant: exactly one "Admitted"', both.filter(r => r.body.result === 'admitted').length === 1 && both.filter(r => r.body.result === 'already').length === 1, JSON.stringify(both.map(r => r.body.result)));
    const bad = await api('POST', `/api/admin/ticketing/tickets/AAAAAAAAAAAAAAAAAAAAAAAA/check-in`);
    check('an unknown ticket: "Invalid ticket" (404)', bad.status === 404 && bad.body.result === 'invalid', JSON.stringify(bad.body));
    const stats = await api('GET', `/api/admin/ticketing/events/${ev.id}/stats`);
    check('attendance figures: 2 checked in of 2 valid, revenue R300 (from paid orders), per tier sold / checked in',
        stats.body.stats.door.checked_in === 2 && stats.body.stats.door.valid === 2 && stats.body.stats.revenue_cents === 30000 && stats.body.stats.tiers.find(t => t.id === gen.id).checked_in === 2, JSON.stringify(stats.body.stats));
    const asstStats = await asst('GET', `/api/admin/ticketing/events/${ev.id}/stats`);
    check('an assistant sees the door figures but not the money', asstStats.status === 200 && asstStats.body.stats.door.checked_in === 2 && !('revenue_cents' in asstStats.body.stats), JSON.stringify(asstStats.body.stats));
    const asstRefund = await asst('POST', `/api/admin/ticketing/orders/${paid.id}/refund`, { note: 'try' });
    check('an assistant cannot refund (403)', asstRefund.status === 403, String(asstRefund.status));

    // ═══════════ 7. holds that run out, cancelled / failed / late payments ═══════════
    const ex = (await reserve(ev.id, [{ ticket_type_id: gen.id, quantity: 1 }])).body.order;
    await run('UPDATE ticket_orders SET reserved_until = ? WHERE public_reference = ?', [new Date(Date.now() - 1000).toISOString(), ex.reference]);
    const exView = await order(ex.reference);
    check('EXPIRED reservation: looking at it releases the hold - status expired, the ticket back on sale', exView.body.order.status === 'expired' && (await tierRow(gen.id)).reserved === 0, JSON.stringify([exView.body.order.status, await tierRow(gen.id)]));
    const exCo = await pub('POST', `/api/public/ticket-orders/${ex.reference}/checkout`, buyer());
    check('...and it cannot go to PayFast any more (409)', exCo.status === 409, JSON.stringify(exCo.body));

    const late = (await reserve(ev.id, [{ ticket_type_id: gen.id, quantity: 1 }])).body.order;
    await pub('POST', `/api/public/ticket-orders/${late.reference}/checkout`, buyer());
    await run('UPDATE ticket_orders SET reserved_until = ? WHERE public_reference = ?', [new Date(Date.now() - 1000).toISOString(), late.reference]);
    await order(late.reference);                                                   // expires it
    const lateRow = await dbOrder(late.reference);
    await postItn(itnFor(lateRow));
    const latePaid = await waitFor(async () => { const r = await dbOrder(late.reference); return r.status === 'paid' ? r : null; });
    check('LATE payment while tickets are left: the order is re-reserved and paid, tickets issued (outcome paid_late)',
        !!latePaid && !latePaid.refund_required && (await outcomes(latePaid.id)).includes('paid_late') && (await q('SELECT COUNT(*) AS n FROM tickets WHERE order_id = ?', [latePaid.id]))[0].n === 1 && (await tierRow(gen.id)).sold === 3, JSON.stringify([latePaid, await tierRow(gen.id)]));

    // the VIP hold from the race: let it lapse, sell the VIP ticket to someone else, THEN the first buyer's payment arrives
    const vipRow = await dbOrder(vipRef);
    await pub('POST', `/api/public/ticket-orders/${vipRef}/checkout`, buyer({ buyer_email: `late.vip.${Date.now()}@example.invalid` }));
    await run('UPDATE ticket_orders SET reserved_until = ? WHERE id = ?', [new Date(Date.now() - 1000).toISOString(), vipRow.id]);
    await order(vipRef);
    const other = (await reserve(ev.id, [{ ticket_type_id: vip.id, quantity: 1 }])).body.order;
    await pub('POST', `/api/public/ticket-orders/${other.reference}/checkout`, buyer());
    await postItn(itnFor(await dbOrder(other.reference)));
    await waitFor(async () => (await dbOrder(other.reference)).status === 'paid');
    await postItn(itnFor(await dbOrder(vipRef)));
    const owed = await waitFor(async () => { const r = await dbOrder(vipRef); return r.status === 'paid' ? r : null; });
    check('LATE payment after it sold out: paid but flagged refund_required, NO tickets, and never oversold (VIP still 1 of 1)',
        !!owed && owed.refund_required === 1 && (await q('SELECT COUNT(*) AS n FROM tickets WHERE order_id = ?', [owed.id]))[0].n === 0 && (await tierRow(vip.id)).sold === 1 && (await tierRow(vip.id)).reserved === 0, JSON.stringify([owed, await tierRow(vip.id)]));
    const refundMail = await waitFor(async () => one("SELECT id, body FROM notifications WHERE subject LIKE 'About your ticket payment%' AND recipient_email = ?", [owed.buyer_email]).catch(() => null));
    check('...the buyer is told they WILL be refunded and will be e-mailed when it is done - never that a refund is already on its way',
        !!refundMail && /as soon as the refund has been made/.test(refundMail.body) && !/on its way/i.test(refundMail.body), refundMail && refundMail.body.slice(0, 200));

    const cx = (await reserve(ev.id, [{ ticket_type_id: gen.id, quantity: 1 }])).body.order;
    await pub('POST', `/api/public/ticket-orders/${cx.reference}/checkout`, buyer());
    const cxRow = await dbOrder(cx.reference);
    await postItn(itnFor(cxRow, { status: 'CANCELLED' }));
    await waitFor(async () => (await outcomes(cxRow.id)).includes('status_cancelled'));
    check('CANCELLED payment: the order stays pending and the tickets stay held, so the buyer can try again', (await dbOrder(cx.reference)).status === 'pending' && (await tierRow(gen.id)).reserved === 1, JSON.stringify(await outcomes(cxRow.id)));
    await postItn(itnFor(cxRow, { status: 'FAILED' }));
    await waitFor(async () => (await dbOrder(cx.reference)).status === 'failed');
    check('FAILED payment: the order is failed and its ticket goes back on sale', (await dbOrder(cx.reference)).status === 'failed' && (await tierRow(gen.id)).reserved === 0, JSON.stringify(await outcomes(cxRow.id)));

    // ═══════════ 8. the office: orders, refund, CSV ═══════════
    const found = await api('GET', `/api/admin/ticketing/orders?event_id=${ev.id}&q=${encodeURIComponent(b1.buyer_email)}`);
    const owedList = await api('GET', `/api/admin/ticketing/orders?event_id=${ev.id}&status=refund_required`);
    check('orders: search by e-mail finds the order; the "refund required" filter lists the late VIP payment',
        found.body.items.length === 1 && found.body.items[0].id === paid.id && owedList.body.items.some(o => o.id === owed.id), JSON.stringify([found.body.total, owedList.body.items.map(o => o.id)]));
    const asstOrders = await asst('GET', `/api/admin/ticketing/orders?event_id=${ev.id}`);
    check('an assistant cannot list orders (buyers\' personal details) - 403', asstOrders.status === 403, String(asstOrders.status));
    const detail = await api('GET', `/api/admin/ticketing/orders/${paid.id}`);
    check('order detail: lines, tickets with check-in, notifications WITHOUT the raw payload', detail.status === 200 && detail.body.tickets.length === 2 && detail.body.notifications.length >= 1 && !('raw_payload' in detail.body.notifications[0]), JSON.stringify(detail.body).slice(0, 300));
    const resend = await api('POST', `/api/admin/ticketing/orders/${paid.id}/resend`);
    check('Resend queues the tickets e-mail again', resend.status === 200 && !!(await waitFor(async () => one("SELECT id FROM notifications WHERE recipient_email = ? AND subject LIKE 'Your tickets (resent)%'", [b1.buyer_email]).catch(() => null))), JSON.stringify(resend.body));

    const csvEmail = `=cmd.${Date.now()}@example.invalid`;               // a buyer e-mail that looks like a spreadsheet formula
    const csvO = (await reserve(ev.id, [{ ticket_type_id: gen.id, quantity: 1 }])).body.order;
    await pub('POST', `/api/public/ticket-orders/${csvO.reference}/checkout`, buyer({ buyer_email: csvEmail, buyer_name: 'Zola Csv' }));
    await postItn(itnFor(await dbOrder(csvO.reference)));
    await waitFor(async () => (await dbOrder(csvO.reference)).status === 'paid');
    const csvText = await adminText(`/api/admin/ticketing/events/${ev.id}/attendees.csv`);
    check('attendee CSV: a header, one row per valid ticket, and a formula-looking cell neutralised',
        csvText.startsWith('﻿Ticket,Order,Ticket type') && csvText.includes('Alice Holder') && csvText.includes(`'${csvEmail}`) && !csvText.includes(`,${csvEmail}`), csvText.slice(0, 400));

    const refundNoNote = await api('POST', `/api/admin/ticketing/orders/${paid.id}/refund`, {});
    check('refund needs a note of what was done', refundNoNote.status === 400, JSON.stringify(refundNoNote.body));
    const refund = await api('POST', `/api/admin/ticketing/orders/${paid.id}/refund`, { note: 'Refunded in the PayFast dashboard' });
    const after = await dbOrder(o1.reference);
    check('REFUND recorded: order refunded, its tickets void, its places back on sale (sold 4 -> 2), and the note says 2 had been used',
        refund.status === 200 && after.status === 'refunded' && /2 of its tickets/.test(refund.body.message) && (await q('SELECT COUNT(*) AS n FROM tickets WHERE order_id = ? AND voided_at IS NOT NULL', [paid.id]))[0].n === 2 && (await tierRow(gen.id)).sold === 2, JSON.stringify([refund.body, await tierRow(gen.id)]));
    const voidScan = await api('POST', `/api/admin/ticketing/tickets/${t1.token}/check-in`);
    const voidPage = await (await fetch(`${BASE}/t/${t1.token}`)).text();
    check('a refunded ticket fails at the door ("no longer valid") and its page says so', voidScan.body.result === 'void' && /no longer valid/.test(voidPage), JSON.stringify(voidScan.body));
    const madeMail = await waitFor(async () => one("SELECT body FROM notifications WHERE subject LIKE 'Your refund has been made%' AND recipient_email = ?", [b1.buyer_email]).catch(() => null));
    check('...and only NOW the buyer is e-mailed that the refund has been made (amount, order, tickets no longer work)',
        refund.body.mailed === true && !!madeMail && /R 300\.00/.test(madeMail.body.replace(/&nbsp;| /g, ' ')) && /no longer work/.test(madeMail.body), JSON.stringify([refund.body, !!madeMail]));
    const owedRefund = await api('POST', `/api/admin/ticketing/orders/${owed.id}/refund`, { note: 'Refunded in PayFast', notify: false });
    check('refunding the refund-required order changes only its status (it never took stock)', owedRefund.status === 200 && (await tierRow(vip.id)).sold === 1, JSON.stringify(await tierRow(vip.id)));
    check('...with "e-mail the buyer" unticked, no refund e-mail is sent', owedRefund.body.mailed === false
        && !(await one("SELECT id FROM notifications WHERE subject LIKE 'Your refund has been made%' AND recipient_email = ?", [owed.buyer_email]).catch(() => null)), JSON.stringify(owedRefund.body));

    // ═══════════ 9. the existing Events routes still protect the records ═══════════
    const del = await api('DELETE', `/api/admin/events/${ev.id}`);
    check('an event with ticket orders cannot be deleted (409 - cancel it instead)', del.status === 409 && /ticket order/.test(del.body.message), JSON.stringify(del.body));

    // ═══════════ 10. secrets never reach the log ═══════════
    await sleep(300);
    const log = getChildLog();
    const leaked = [t1.token, t2.token, o1.reference, ex.reference].filter(s => log.includes(s));
    check('no ticket token or order reference appears in the server log (the request logger masks them)', leaked.length === 0 && log.includes('/t/[hidden]'), leaked.join(','));
    // The shared mail queue's own "sent email #N to <address>" line is a known, documented pre-existing finding (docs-internal/ticketing.md
    // section 8, lib/background-clerk.js) - not ticketing's logging - so those lines are left out of this check.
    const ownLog = log.split('\n').filter(l => !/\[Notification Queue\]/.test(l)).join('\n');
    check('no buyer e-mail appears in ticketing\'s / the request log, not even URL-encoded in an admin search', !ownLog.includes(b1.buyer_email) && !ownLog.includes(encodeURIComponent(b1.buyer_email)) && log.includes('q=[hidden]'), '');
}

// GET a non-JSON admin resource as the suite's administrator.
async function adminText(urlPath) {
    const support = require('./support');
    const r = await support.apiBinary('GET', urlPath);
    return r.buffer ? r.buffer.toString('utf8') : '';
}
