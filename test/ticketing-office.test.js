// Event ticketing - the office's extra tools (Phase C) against the real server:
//   1. search: by phone in any SA form, by ticket code (with or without the PDF's spaces), by ticket number "1042-2"; a door link never
//      searches by phone;
//   2. complimentary tickets (migration 116, lib/ticketing-issue.js): administrators / managers only, a reason required, capacity checked the
//      same atomic way as a sale, never revenue, e-mailed as "Complimentary", admitted at the door; cancelling them frees the seats and
//      e-mails nobody;
//   3. void and reissue one ticket: the old code stops working, the new one admits, the seat count does not move, the buyer gets the new
//      ticket, the audit log keeps who / why; refused for a ticket already used at the door.
// Date offsets 2040-2044 are reserved for this file. Every event it creates is cancelled before it ends.
const { api, pub, q, one, future, sleep, loginAs, BASE } = require('./support');
const { generatePayFastItnSignature } = require('../lib/payfast-signature');

const waitFor = async (fn, ms = 20000) => { const t = Date.now(); let v; while (Date.now() - t < ms) { v = await fn(); if (v) return v; await sleep(200); } return v; };
let pf = 0;

module.exports = async function ({ check }) {
    const made = [];
    try { await suite(check, made); }
    finally { for (const ev of made) await api('PUT', `/api/admin/events/${ev.id}`, { event_title: ev.title, event_datetime: ev.when, event_status: 'cancelled', sync_to_gcal: false }).catch(() => {}); }
};

async function makeShow(made, offset, title, capacity) {
    const when = `${future(offset)}T20:00`;
    const ev = (await api('POST', '/api/admin/events', { event_title: title, event_datetime: when, venue_name: 'Office Hall', event_status: 'upcoming', sync_to_gcal: false })).body;
    made.push({ id: ev.id, title, when });
    const tier = (await api('POST', `/api/admin/events/${ev.id}/ticket-types`, { name: 'General', price: '100', is_active: true, max_per_order: 4, capacity })).body.tier;
    return { id: ev.id, tier };
}
async function paidOrder(eventId, tierId, qty, name, email, phone) {
    const o = (await pub('POST', '/api/public/ticket-orders', { event_id: eventId, items: [{ ticket_type_id: tierId, quantity: qty }] })).body.order;
    await pub('POST', `/api/public/ticket-orders/${o.reference}/checkout`, { buyer_name: name, buyer_email: email, buyer_phone: phone, popia_consent: true, terms_accepted: true });
    const row = await one('SELECT * FROM ticket_orders WHERE public_reference = ?', [o.reference]);
    const m = { m_payment_id: row.m_payment_id, pf_payment_id: `OFFICE-${Date.now()}-${++pf}`, payment_status: 'COMPLETE', item_name: 'x', item_description: '', amount_gross: (row.total_cents / 100).toFixed(2), amount_fee: '-1.00', amount_net: '1.00',
        custom_str1: '', custom_str2: '', custom_str3: '', custom_str4: '', custom_str5: '', custom_int1: '', custom_int2: '', custom_int3: '', custom_int4: '', custom_int5: '', name_first: 'O', name_last: 'B', email_address: email, merchant_id: '10000100' };
    m.signature = generatePayFastItnSignature(m, null);
    await pub('POST', '/api/payment/webhook/payfast', m);
    await waitFor(async () => (await one('SELECT status FROM ticket_orders WHERE id = ?', [row.id])).status === 'paid');
    return { order: row, tickets: await q('SELECT * FROM tickets WHERE order_id = ? ORDER BY id', [row.id]) };
}
const tierRow = (id) => one('SELECT capacity, sold, reserved FROM ticket_types WHERE id = ?', [id]);
const ids = (r) => (r.body && r.body.items || []).map(x => x.id);
const door = async (path, pass) => { const r = await fetch(BASE + path, { headers: { 'x-door-pass': pass } }); return { status: r.status, body: await r.json().catch(() => null) }; };

async function suite(check, made) {
    const stamp = Date.now();
    const asst = await loginAs('assistant');

    // ═══ 1. search ═══
    const s = await makeShow(made, 2040, 'ZZ Office Search Show', 20);
    const A = await paidOrder(s.id, s.tier.id, 2, 'Phone Search Buyer', `office.a.${stamp}@example.invalid`, '+27821239876');
    const B = await paidOrder(s.id, s.tier.id, 1, 'Other Buyer', `office.b.${stamp}@example.invalid`, '0835550000');
    const list = (qs) => api('GET', `/api/admin/ticketing/orders?event_id=${s.id}&q=${encodeURIComponent(qs)}`);
    const p1 = await list('082 123 9876'), p2 = await list('+27 82 123 9876'), p3 = await list('0821239876');
    check('orders search by phone: "082 123 9876", "+27 82 123 9876" and "0821239876" all find the order stored as +27821239876, and only it',
        [p1, p2, p3].every(r => JSON.stringify(ids(r)) === JSON.stringify([A.order.id])), JSON.stringify([ids(p1), ids(p2), ids(p3)]));
    const code = A.tickets[1].token;
    const c1 = await list(code), c2 = await list(code.match(/.{1,4}/g).join(' '));
    check('orders search by ticket code - as one string or in the PDF\'s groups of four', JSON.stringify(ids(c1)) === JSON.stringify([A.order.id]) && JSON.stringify(ids(c2)) === JSON.stringify([A.order.id]), JSON.stringify([ids(c1), ids(c2)]));
    check('orders search by ticket number "<order>-2" finds the order', JSON.stringify(ids(await list(`${A.order.id}-2`))) === JSON.stringify([A.order.id]), '');
    const staffDoor = (qs) => api('GET', `/api/admin/ticketing/events/${s.id}/door?q=${encodeURIComponent(qs)}`);
    const dn = await staffDoor(`${A.order.id}-2`);
    const dp = await staffDoor('082 123 9876');
    check('door search (staff): ticket number "<order>-2" gives exactly that order\'s 2nd ticket; a phone number finds the buyer\'s tickets',
        dn.body.results.length === 1 && dn.body.results[0].token === A.tickets[1].token && dp.body.results.length === 2 && dp.body.results.every(t => t.order_id === A.order.id), JSON.stringify([dn.body.results.map(t => t.token), dp.body.results.length]));
    const pass = (await api('POST', `/api/admin/ticketing/events/${s.id}/door-passes`, { label: 'Office door' })).body.link.split('pass=')[1];
    const vp = await door('/api/door/search?q=' + encodeURIComponent('082 123 9876'), pass);
    const vn = await door('/api/door/search?q=' + encodeURIComponent(`${B.order.id}-1`), pass);
    check('a door link never finds anyone by phone number, but does by ticket number', vp.status === 200 && vp.body.results.length === 0 && vn.body.results.length === 1 && vn.body.results[0].token === B.tickets[0].token, JSON.stringify([vp.body, vn.body && vn.body.results.length]));

    // ═══ 2. complimentary tickets ═══
    const c = await makeShow(made, 2041, 'ZZ Office Guest Show', 5);
    await paidOrder(c.id, c.tier.id, 2, 'Paying Buyer', `office.pay.${stamp}@example.invalid`, '0821110000');
    const statsBefore = (await api('GET', `/api/admin/ticketing/events/${c.id}/stats`)).body.stats;
    const guestEmail = `office.guest.${stamp}@example.invalid`;
    const comp = (body) => api('POST', `/api/admin/ticketing/events/${c.id}/complimentary`, body);
    check('complimentary: an assistant cannot issue them (403); without a reason they are refused (400)',
        (await asst('POST', `/api/admin/ticketing/events/${c.id}/complimentary`, { ticket_type_id: c.tier.id, quantity: 1, guest_name: 'X Guest', note: 'Press' })).status === 403
        && (await comp({ ticket_type_id: c.tier.id, quantity: 1, guest_name: 'X Guest' })).status === 400, '');
    const over = await comp({ ticket_type_id: c.tier.id, quantity: 4, guest_name: 'Too Many', note: 'Sponsor' });
    check('complimentary: more than the seats left is refused (409, "Only 3 ... left") - a guest list never oversells', over.status === 409 && /Only 3/.test(over.body.message) && (await tierRow(c.tier.id)).sold === 2, JSON.stringify(over.body));
    const g = await comp({ ticket_type_id: c.tier.id, quantity: 2, guest_name: 'Lerato Guest', guest_email: guestEmail, guest_phone: '082 444 5555', note: 'Press - Sowetan' });
    const gRow = g.body.order && await one('SELECT * FROM ticket_orders WHERE id = ?', [g.body.order.id]);
    const gTk = gRow ? await q('SELECT * FROM tickets WHERE order_id = ? ORDER BY id', [gRow.id]) : [];
    check('complimentary: 2 tickets issued - a paid R0 order marked complimentary, with the reason and who issued it; 2 seats taken; no PayFast id',
        g.status === 200 && gRow && gRow.status === 'paid' && gRow.total_cents === 0 && gRow.complimentary === 1 && gRow.comp_note === 'Press - Sowetan' && !!gRow.issued_by && !gRow.m_payment_id
        && gTk.length === 2 && gTk.every(t => t.holder_name === 'Lerato Guest') && (await tierRow(c.tier.id)).sold === 4, JSON.stringify([g.body, gRow]));
    const statsAfter = (await api('GET', `/api/admin/ticketing/events/${c.id}/stats`)).body.stats;
    check('complimentary: revenue does not change; the figures show 2 complimentary', statsAfter.revenue_cents === statsBefore.revenue_cents && statsAfter.comp_tickets === 2, JSON.stringify([statsBefore.revenue_cents, statsAfter.revenue_cents, statsAfter.comp_tickets]));
    const mail = await waitFor(async () => (await q('SELECT subject, body FROM notifications WHERE recipient_email = ?', [guestEmail]))[0]);
    check('complimentary: the guest is e-mailed the tickets - "guest list", "Complimentary", never a price paid', !!mail && /Your tickets/.test(mail.subject) && /guest list/.test(mail.body) && /Complimentary/.test(mail.body) && !/payment was received/.test(mail.body), mail && mail.subject);
    const inList = (await api('GET', `/api/admin/ticketing/orders?event_id=${c.id}`)).body.items.find(o => o.id === gRow.id);
    check('complimentary: the orders list marks it complimentary', !!inList && inList.complimentary === 1, JSON.stringify(inList));
    const adm = await api('POST', `/api/admin/ticketing/tickets/${gTk[0].token}/check-in`);
    check('complimentary: the ticket admits at the door', adm.body.result === 'admitted', JSON.stringify(adm.body));
    const cancel = await api('POST', `/api/admin/ticketing/orders/${gRow.id}/refund`, { note: 'Guest cannot come' });
    const afterCancel = await one('SELECT status FROM ticket_orders WHERE id = ?', [gRow.id]);
    await sleep(500);
    const refundMail = await q("SELECT subject FROM notifications WHERE recipient_email = ? AND subject LIKE '%refund%'", [guestEmail]);
    check('complimentary: cancelling them voids the codes, frees the seats (4 -> 2) and e-mails nobody about a "refund"',
        cancel.status === 200 && /Complimentary tickets cancelled/.test(cancel.body.message) && afterCancel.status === 'refunded' && (await tierRow(c.tier.id)).sold === 2
        && (await q('SELECT COUNT(*) n FROM tickets WHERE order_id = ? AND voided_at IS NULL', [gRow.id]))[0].n === 0 && refundMail.length === 0, JSON.stringify([cancel.body, afterCancel, refundMail]));
    const noMail = await comp({ ticket_type_id: c.tier.id, quantity: 1, guest_name: 'No Email Guest', note: 'Family' });
    check('complimentary without an e-mail: issued, and the office is told to print / share them from the order', noMail.status === 200 && noMail.body.mailed === false && /No e-mail address/.test(noMail.body.message), JSON.stringify(noMail.body));

    // ═══ 3. void and reissue ═══
    const r = await makeShow(made, 2042, 'ZZ Office Reissue Show', 10);
    const buyerEmail = `office.re.${stamp}@example.invalid`;
    const R = await paidOrder(r.id, r.tier.id, 2, 'Reissue Buyer', buyerEmail, '0827770000');
    const [t1, t2] = R.tickets;
    const before = await tierRow(r.tier.id);
    check('reissue: an assistant cannot (403); without a reason it is refused (400)',
        (await asst('POST', `/api/admin/ticketing/tickets/${t1.token}/reissue`, { reason: 'lost phone' })).status === 403
        && (await api('POST', `/api/admin/ticketing/tickets/${t1.token}/reissue`, {})).status === 400, '');
    const re = await api('POST', `/api/admin/ticketing/tickets/${t1.token}/reissue`, { reason: 'Lost phone', holder_name: 'New Holder' });
    const fresh = re.body.ticket;
    const oldRow = await one('SELECT * FROM tickets WHERE id = ?', [t1.id]);
    const newRow = fresh && await one('SELECT * FROM tickets WHERE token = ?', [fresh.token]);
    check('reissue: the old ticket is void (when / who / why kept); a new code for the same order and type, named as asked, pointing back at it; seats unchanged',
        re.status === 200 && !!oldRow.voided_at && oldRow.void_reason === 'Lost phone' && !!oldRow.voided_by && !!newRow && newRow.order_id === R.order.id && newRow.ticket_type_id === t1.ticket_type_id
        && newRow.holder_name === 'New Holder' && newRow.replaces_ticket_id === t1.id && newRow.token !== t1.token && JSON.stringify(await tierRow(r.tier.id)) === JSON.stringify(before), JSON.stringify([re.body, oldRow, newRow]));
    const oldScan = await api('POST', `/api/admin/ticketing/tickets/${t1.token}/check-in`);
    const newScan = await api('POST', `/api/admin/ticketing/tickets/${fresh.token}/check-in`);
    check('reissue: the OLD code is refused at the door ("no longer valid"), the NEW one admits', oldScan.body.result === 'void' && newScan.body.result === 'admitted', JSON.stringify([oldScan.body.result, newScan.body.result]));
    const resent = await waitFor(async () => (await q("SELECT subject, body FROM notifications WHERE recipient_email = ? AND subject LIKE 'Your tickets (resent)%'", [buyerEmail]))[0]);
    check('reissue: the buyer is e-mailed the tickets again, with the new code and without the old one', !!resent && resent.body.includes(fresh.token.match(/.{1,4}/g).join(' ')) && !resent.body.includes(t1.token.match(/.{1,4}/g).join(' ')), resent && resent.subject);
    const audit = await one("SELECT action, reason FROM audit_log WHERE table_name = 'tickets' AND record_id = ? AND action = 'TICKET_REISSUED'", [t1.id]);
    check('reissue: in the audit log with the reason', !!audit && audit.reason === 'Lost phone', JSON.stringify(audit));
    const detail = (await api('GET', `/api/admin/ticketing/orders/${R.order.id}`)).body;
    check('reissue: the order drawer tells the story (voided, by whom, why, reissued)', !!detail.issue && detail.issue.voids.length === 1 && detail.issue.voids[0].void_reason === 'Lost phone' && detail.issue.voids[0].replaced_by === newRow.id, JSON.stringify(detail.issue));
    check('reissue: refused for a ticket already used at the door (409) and for a void one (409)',
        (await api('POST', `/api/admin/ticketing/tickets/${fresh.token}/reissue`, { reason: 'try again' })).status === 409
        && (await api('POST', `/api/admin/ticketing/tickets/${t1.token}/reissue`, { reason: 'try again' })).status === 409, '');
    const dnum = await api('GET', `/api/admin/ticketing/events/${r.id}/door?q=${R.order.id}-1`);
    check('after a reissue the ticket numbers follow the tickets PDF (valid tickets only): "<order>-1" is now the untouched ticket', dnum.body.results.length === 1 && dnum.body.results[0].token === t2.token, JSON.stringify(dnum.body.results.map(x => x.token)));
}
