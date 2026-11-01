// Event ticketing - two real-world situations against the real server:
//   1. one live hold per browser per show (migration 113 hold_key): a second reservation from the same browser replaces the first instead
//      of holding twice; a refused one (sold out) leaves the first in place; a hold already at PayFast is never given back; other
//      browsers are unaffected.
//   2. a show is cancelled or postponed: the Ticket Sales figures say so, and one action e-mails every paid buyer - once each, with the
//      right message, and only for a cancelled / postponed show, only by administrators / managers.
// Date offsets 1970-1979 are reserved for this file. Every event it creates is cancelled before it ends.
const { api, pub, q, one, future, sleep, loginAs } = require('./support');
const { generatePayFastItnSignature } = require('../lib/payfast-signature');

const waitFor = async (fn, ms = 20000) => { const t = Date.now(); let v; while (Date.now() - t < ms) { v = await fn(); if (v) return v; await sleep(200); } return v; };
const KEY_A = 'browserAAAAAAAAAAAAAAAAAAAAAAAA', KEY_B = 'browserBBBBBBBBBBBBBBBBBBBBBBBB';
let pf = 0;

module.exports = async function ({ check }) {
    const made = [];
    try { await suite(check, made); }
    finally { for (const ev of made) await api('PUT', `/api/admin/events/${ev.id}`, { event_title: ev.title, event_datetime: ev.when, event_status: 'cancelled', sync_to_gcal: false }).catch(() => {}); }
};

async function makeShow(made, offset, title, tier) {
    const when = `${future(offset)}T20:00`;
    const ev = (await api('POST', '/api/admin/events', { event_title: title, event_datetime: when, venue_name: 'Hall', event_status: 'upcoming', sync_to_gcal: false })).body;
    made.push({ id: ev.id, title, when });
    const t = (await api('POST', `/api/admin/events/${ev.id}/ticket-types`, { name: 'General', price: '100', is_active: true, max_per_order: 4, ...tier })).body.tier;
    return { id: ev.id, title, when, tier: t };
}
const reserve = (eventId, tierId, qty, key) => pub('POST', '/api/public/ticket-orders', { event_id: eventId, items: [{ ticket_type_id: tierId, quantity: qty }], hold_key: key });
const tierRow = (id) => one('SELECT sold, reserved FROM ticket_types WHERE id = ?', [id]);
const orderStatus = async (ref) => (await one('SELECT status FROM ticket_orders WHERE public_reference = ?', [ref])).status;

async function paidOrder(eventId, tierId, email) {
    const o = (await reserve(eventId, tierId, 1)).body.order;
    await pub('POST', `/api/public/ticket-orders/${o.reference}/checkout`, { buyer_name: 'Notice Buyer', buyer_email: email, buyer_phone: '0821234567', popia_consent: true, terms_accepted: true });
    const row = await one('SELECT * FROM ticket_orders WHERE public_reference = ?', [o.reference]);
    const m = { m_payment_id: row.m_payment_id, pf_payment_id: `EVCH-${Date.now()}-${++pf}`, payment_status: 'COMPLETE', item_name: 'x', item_description: '', amount_gross: (row.total_cents / 100).toFixed(2), amount_fee: '-1.00', amount_net: '1.00',
        custom_str1: '', custom_str2: '', custom_str3: '', custom_str4: '', custom_str5: '', custom_int1: '', custom_int2: '', custom_int3: '', custom_int4: '', custom_int5: '', name_first: 'N', name_last: 'B', email_address: email, merchant_id: '10000100' };
    m.signature = generatePayFastItnSignature(m, null);
    await pub('POST', '/api/payment/webhook/payfast', m);
    await waitFor(async () => (await one('SELECT status FROM ticket_orders WHERE id = ?', [row.id])).status === 'paid');
    return row;
}

async function suite(check, made) {
    // ═══ 1. one hold per browser per show ═══
    const s = await makeShow(made, 1970, 'ZZ Hold Key Show', { capacity: 5 });
    const a1 = (await reserve(s.id, s.tier.id, 2, KEY_A)).body.order;
    const a2 = (await reserve(s.id, s.tier.id, 3, KEY_A)).body.order;
    check('the same browser reserving again for the same show REPLACES its earlier hold (2 then 3 held = 3, not 5)',
        !!a1 && !!a2 && (await orderStatus(a1.reference)) === 'expired' && (await orderStatus(a2.reference)) === 'pending' && (await tierRow(s.tier.id)).reserved === 3, JSON.stringify(await tierRow(s.tier.id)));
    const b1 = await reserve(s.id, s.tier.id, 2, KEY_B);
    check('another browser is unaffected: it holds the last 2 alongside', b1.status === 201 && (await tierRow(s.tier.id)).reserved === 5 && (await orderStatus(a2.reference)) === 'pending', JSON.stringify(await tierRow(s.tier.id)));
    const refused = await reserve(s.id, s.tier.id, 4, KEY_B);
    check('a replacement that is REFUSED (sold out) leaves that browser\'s earlier hold in place - the swap is all or nothing',
        refused.status === 409 && (await orderStatus(b1.body.order.reference)) === 'pending' && (await tierRow(s.tier.id)).reserved === 5, JSON.stringify([refused.status, await tierRow(s.tier.id)]));
    await pub('POST', `/api/public/ticket-orders/${a2.reference}/checkout`, { buyer_name: 'At PayFast', buyer_email: 'at.payfast@example.invalid', buyer_phone: '0821234567', popia_consent: true, terms_accepted: true });
    await pub('POST', `/api/public/ticket-orders/${b1.body.order.reference}/release`);
    const a3 = await reserve(s.id, s.tier.id, 1, KEY_A);
    check('a hold whose buyer already went to PayFast is NEVER given back by a new reservation from the same browser',
        a3.status === 201 && (await orderStatus(a2.reference)) === 'pending' && (await tierRow(s.tier.id)).reserved === 4, JSON.stringify([a3.status, await tierRow(s.tier.id)]));
    const noKey = await reserve(s.id, s.tier.id, 1);
    check('a reservation without a key (or a malformed one) still works as before', noKey.status === 201, JSON.stringify(noKey.body));

    // ═══ 2. a cancelled / postponed show ═══
    const c = await makeShow(made, 1971, 'ZZ Cancel Me Show', { capacity: 10 });
    const p1 = await paidOrder(c.id, c.tier.id, `cancel.one.${Date.now()}@example.invalid`);
    const p2 = await paidOrder(c.id, c.tier.id, `cancel.two.${Date.now()}@example.invalid`);
    const early = await api('POST', `/api/admin/ticketing/events/${c.id}/notify-holders`);
    check('ticket holders cannot be "told" about a show that is still on (409)', early.status === 409, JSON.stringify(early.body));
    await api('PUT', `/api/admin/events/${c.id}`, { event_title: c.title, event_datetime: c.when, event_status: 'cancelled', sync_to_gcal: false });
    const stats = await api('GET', `/api/admin/ticketing/events/${c.id}/stats`);
    check('the Ticket Sales figures say the show is cancelled and that 0 of 2 ticket holders were told', stats.body.stats.event_status === 'cancelled' && stats.body.stats.notice.total === 2 && stats.body.stats.notice.sent === 0, JSON.stringify(stats.body.stats.notice));
    const asst = await loginAs('assistant');
    check('an assistant cannot e-mail the ticket holders (403)', (await asst('POST', `/api/admin/ticketing/events/${c.id}/notify-holders`)).status === 403, '');
    const [t1, t2] = await Promise.all([api('POST', `/api/admin/ticketing/events/${c.id}/notify-holders`), api('POST', `/api/admin/ticketing/events/${c.id}/notify-holders`)]);
    check('two admins pressing it at the same moment e-mail each buyer ONCE (2 sent between them, 2 of 2 told)', t1.body.sent + t2.body.sent === 2 && t1.body.notice.sent === 2 && t2.body.notice.sent === 2, JSON.stringify([t1.body, t2.body]));
    const mails = await waitFor(async () => { const r = await q("SELECT recipient_email, body FROM notifications WHERE subject = 'Cancelled: ZZ Cancel Me Show'"); return r.length >= 2 ? r : null; });
    check('each buyer gets "Cancelled: <show>" saying they WILL be refunded and will be e-mailed when it is made - never that it already happened',
        !!mails && mails.length === 2 && new Set(mails.map(m => m.recipient_email)).size === 2 && mails.every(m => /as soon as the refund has been made/.test(m.body) && !/has been made to your/.test(m.body)), JSON.stringify((mails || []).map(m => m.recipient_email)));
    const again = await api('POST', `/api/admin/ticketing/events/${c.id}/notify-holders`);
    check('pressing it again tells nobody twice', again.status === 200 && again.body.sent === 0 && /already been told/.test(again.body.message), JSON.stringify(again.body));

    const pp = await makeShow(made, 1972, 'ZZ Postpone Me Show', { capacity: 10 });
    await paidOrder(pp.id, pp.tier.id, `postpone.${Date.now()}@example.invalid`);
    await api('PUT', `/api/admin/events/${pp.id}`, { event_title: pp.title, event_datetime: pp.when, event_status: 'postponed', sync_to_gcal: false });
    const pr = await api('POST', `/api/admin/ticketing/events/${pp.id}/notify-holders`);
    const pmail = await waitFor(async () => one("SELECT body FROM notifications WHERE subject = 'Postponed: ZZ Postpone Me Show'").catch(() => null));
    check('a postponed show: "Postponed: <show>" says the tickets stay valid and the new date will follow', pr.body.sent === 1 && !!pmail && /stay valid/.test(pmail.body) && /new date/.test(pmail.body), JSON.stringify(pr.body));
    void p1; void p2;

    // ═══ 3. undo a mistaken check-in; the reconciliation CSV ═══
    const u = await makeShow(made, 1973, 'ZZ Undo Show', { capacity: 10 });
    const uo = await paidOrder(u.id, u.tier.id, `undo.${Date.now()}@example.invalid`);
    const tk = await one('SELECT token FROM tickets WHERE order_id = ?', [uo.id]);
    await api('POST', `/api/admin/ticketing/tickets/${tk.token}/check-in`);
    check('undo check-in: an assistant cannot (403); without a reason it is refused (400)',
        (await asst('POST', `/api/admin/ticketing/tickets/${tk.token}/undo-check-in`, { reason: 'mistake' })).status === 403
        && (await api('POST', `/api/admin/ticketing/tickets/${tk.token}/undo-check-in`, {})).status === 400, '');
    const undo = await api('POST', `/api/admin/ticketing/tickets/${tk.token}/undo-check-in`, { reason: 'Scanned the wrong ticket' });
    const audit = await one("SELECT old_values, reason FROM audit_log WHERE action = 'TICKET_CHECK_IN_UNDONE' ORDER BY id DESC LIMIT 1");
    const reIn = await api('POST', `/api/admin/ticketing/tickets/${tk.token}/check-in`);
    check('undo check-in: the ticket is back to "not in", the audit log keeps when / who had checked it in and why, and it can be admitted again',
        undo.status === 200 && !!audit && /checked_in_at/.test(audit.old_values) && audit.reason === 'Scanned the wrong ticket' && reIn.body.result === 'admitted', JSON.stringify([undo.body, audit, reIn.body.result]));
    check('undoing a ticket that is not checked in is refused (409)', (await api('POST', `/api/admin/ticketing/tickets/${(await one('SELECT token FROM tickets WHERE order_id = ? ', [uo.id])).token}/undo-check-in`, { reason: 'x y z' })).status === 200
        && (await api('POST', `/api/admin/ticketing/tickets/${tk.token}/undo-check-in`, { reason: 'again' })).status === 409, '');
    const csv = await require('./support').apiBinary('GET', `/api/admin/ticketing/events/${u.id}/orders.csv`);
    const text = csv.buffer.toString('utf8');
    const paidRow = await one('SELECT gateway_payment_id FROM ticket_orders WHERE id = ?', [uo.id]);
    check('orders CSV for reconciliation: a header and the order with its PayFast payment id and status', csv.status === 200 && text.startsWith('﻿Order,Created (SAST),Status')
        && text.includes(paidRow.gateway_payment_id) && text.includes(',paid,'), text.slice(0, 300));
    check('an assistant cannot download the orders CSV (403)', (await asst('GET', `/api/admin/ticketing/events/${u.id}/orders.csv`)).status === 403, '');
}
