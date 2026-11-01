// Event ticketing - an ON-SALE RUSH against the real server (HTTP, the real SQLite file, every safeguard in place):
//   A. 100 buyers press Continue at the same moment for a 50-ticket show: exactly 50 holds, 50 polite "sold out" answers, never an error,
//      never one ticket too many - while the homepage's events list keeps answering;
//   B. 120 buyers wanting 1-4 tickets each at once for 100 tickets: the tickets held add up to what was sold, never above 100;
//   C. 10 buyers pay at the same moment, and PayFast sends every notification TWICE at once: 10 paid orders, exactly 10 tickets, no duplicates.
//      In production the notification endpoint takes 20 a minute from any address but PayFast's own (exempt) and answers the rest "200"
//      WITHOUT acting (middleware/rate-limiters.js payfastItnRateLimiter; off under NODE_ENV=test). Kept within that anyway, and any order
//      still unpaid is notified again a minute later, as PayFast / the safety net would.
// Timings are printed (the server handles reservations one at a time - SQLite BEGIN IMMEDIATE - so this is also the speed check).
// Date offsets 1996-1998 are reserved for this file. Every event it creates is cancelled before it ends.
const { api, pub, q, one, future, sleep } = require('./support');
const { generatePayFastItnSignature } = require('../lib/payfast-signature');

const waitFor = async (fn, ms = 60000) => { const t = Date.now(); let v; while (Date.now() - t < ms) { v = await fn(); if (v) return v; await sleep(250); } return v; };
const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const timed = async (fn) => { const t = Date.now(); const r = await fn(); return { ...r, ms: Date.now() - t }; };

module.exports = async function ({ check }) {
    const made = [];
    try { await suite(check, made); }
    finally { for (const ev of made) await api('PUT', `/api/admin/events/${ev.id}`, { event_title: ev.title, event_datetime: ev.when, event_status: 'cancelled', sync_to_gcal: false }).catch(() => {}); }
};

async function makeShow(made, offset, title, capacity) {
    const when = `${future(offset)}T20:00`;
    const ev = (await api('POST', '/api/admin/events', { event_title: title, event_datetime: when, venue_name: 'Load Hall', event_status: 'upcoming', sync_to_gcal: false })).body;
    made.push({ id: ev.id, title, when });
    const tier = (await api('POST', `/api/admin/events/${ev.id}/ticket-types`, { name: 'General', price: '100', is_active: true, max_per_order: 4, capacity })).body.tier;
    return { id: ev.id, tier };
}
const reserve = (eventId, tierId, qty) => timed(() => pub('POST', '/api/public/ticket-orders', { event_id: eventId, items: [{ ticket_type_id: tierId, quantity: qty }] }));
const tierRow = (id) => one('SELECT capacity, sold, reserved FROM ticket_types WHERE id = ?', [id]);

async function suite(check, made) {
    // ═══ A. 100 at once for 50 ═══
    const a = await makeShow(made, 1996, 'ZZ Load Rush Show', 50);
    const listTimes = [];
    let bursting = true;
    const lister = (async () => { while (bursting) { const r = await timed(() => pub('GET', '/api/public/events')); listTimes.push({ ms: r.ms, ok: r.status === 200 }); await sleep(100); } })();
    const t0 = Date.now();
    const rushA = await Promise.all(Array.from({ length: 100 }, () => reserve(a.id, a.tier.id, 1)));
    const wallA = Date.now() - t0;
    bursting = false;
    await lister;
    const won = rushA.filter(r => r.status === 201), lost = rushA.filter(r => r.status === 409), other = rushA.filter(r => r.status !== 201 && r.status !== 409);
    const rowA = await tierRow(a.tier.id);
    const msA = rushA.map(r => r.ms);
    console.log(`  rush A: 100 reservations in ${wallA} ms - median ${pct(msA, .5)} ms, p95 ${pct(msA, .95)} ms, slowest ${Math.max(...msA)} ms; ` +
        `events list during the rush: ${listTimes.length} calls, slowest ${Math.max(0, ...listTimes.map(x => x.ms))} ms`);
    check('A: 100 buyers at once for 50 tickets - exactly 50 holds and 50 "sold out" (409) answers, no errors',
        won.length === 50 && lost.length === 50 && other.length === 0, JSON.stringify({ won: won.length, lost: lost.length, other: other.map(r => [r.status, r.body]) }));
    check('A: the database agrees - 50 held, 0 sold, never above capacity; 50 pending orders',
        rowA.reserved === 50 && rowA.sold === 0 && (await one("SELECT COUNT(*) n FROM ticket_orders WHERE event_id = ? AND status = 'pending'", [a.id])).n === 50, JSON.stringify(rowA));
    check('A: a "sold out" answer says what is left (0) so the drawer can say so', lost.every(r => r.body && Array.isArray(r.body.sold_out)), JSON.stringify(lost[0] && lost[0].body));
    check('A: the whole rush is answered within 20 s, and nobody waits more than 15 s', wallA < 20000 && Math.max(...msA) < 15000, `${wallA} ms / ${Math.max(...msA)} ms`);
    check('A: the homepage\'s events list kept answering during the rush (every call OK, none slower than 10 s)',
        listTimes.length > 0 && listTimes.every(x => x.ok && x.ms < 10000), JSON.stringify(listTimes.slice(0, 8)));

    // ═══ B. mixed quantities ═══
    const b = await makeShow(made, 1997, 'ZZ Load Mixed Show', 100);
    const wants = Array.from({ length: 120 }, (_, i) => 1 + (i * 7) % 4);
    const rushB = await Promise.all(wants.map(qty => reserve(b.id, b.tier.id, qty)));
    const heldB = rushB.reduce((n, r, i) => n + (r.status === 201 ? wants[i] : 0), 0);
    const rowB = await tierRow(b.tier.id);
    const badB = rushB.filter(r => r.status !== 201 && r.status !== 409);
    console.log(`  rush B: 120 buyers wanting ${wants.reduce((x, y) => x + y, 0)} tickets for 100 - ${rushB.filter(r => r.status === 201).length} holds, ${heldB} tickets held, slowest ${Math.max(...rushB.map(r => r.ms))} ms`);
    check('B: 120 buyers wanting 1-4 each for 100 tickets - what is held adds up exactly, never above 100, every refusal a 409',
        badB.length === 0 && heldB === rowB.reserved && rowB.reserved <= 100 && rowB.reserved >= 97, JSON.stringify({ heldB, rowB, bad: badB.length }));

    // ═══ C. 10 pay at once, every PayFast notification arrives twice at once ═══
    const c = await makeShow(made, 1998, 'ZZ Load Pay Show', 15);
    const holds = (await Promise.all(Array.from({ length: 10 }, () => reserve(c.id, c.tier.id, 1)))).map(r => r.body.order.reference);
    const outs = await Promise.all(holds.map((ref, i) => pub('POST', `/api/public/ticket-orders/${ref}/checkout`, { buyer_name: `Load Buyer ${i}`, buyer_email: `load.${i}.${Date.now()}@example.invalid`, buyer_phone: '0821234567', popia_consent: true, terms_accepted: true })));
    check('C: 10 checkouts at once all reach the PayFast hand-off', outs.every(o => o.status === 200 && o.body && o.body.pfData), JSON.stringify(outs.filter(o => o.status !== 200).map(o => [o.status, o.body]).slice(0, 3)));
    const rows = await q(`SELECT * FROM ticket_orders WHERE public_reference IN (${holds.map(() => '?').join(',')})`, holds);
    const itn = (row, i) => { const m = { m_payment_id: row.m_payment_id, pf_payment_id: `LOAD-${Date.now()}-${i}`, payment_status: 'COMPLETE', item_name: 'x', item_description: '', amount_gross: (row.total_cents / 100).toFixed(2), amount_fee: '-1.00', amount_net: '1.00',
        custom_str1: '', custom_str2: '', custom_str3: '', custom_str4: '', custom_str5: '', custom_int1: '', custom_int2: '', custom_int3: '', custom_int4: '', custom_int5: '', name_first: 'L', name_last: 'B', email_address: row.buyer_email, merchant_id: '10000100' };
        m.signature = generatePayFastItnSignature(m, null); return m; };
    const msgs = rows.map(itn);
    const tPay = Date.now();
    const send = (m) => pub('POST', '/api/payment/webhook/payfast', m);
    await Promise.all(msgs.flatMap(m => [send(m), send(m)]));
    const paidCount = async () => (await one(`SELECT COUNT(*) n FROM ticket_orders WHERE event_id = ? AND status = 'paid'`, [c.id])).n;
    let allPaid = await waitFor(async () => (await paidCount()) === 10, 8000);
    for (let round = 0; !allPaid && round < 2; round++) {               // another test file used up this minute's allowance: as PayFast would
        await sleep(61000);
        const unpaid = await q(`SELECT m_payment_id FROM ticket_orders WHERE event_id = ? AND status <> 'paid'`, [c.id]);
        await Promise.all(msgs.filter(m => unpaid.some(u => u.m_payment_id === m.m_payment_id)).map(send));
        allPaid = await waitFor(async () => (await paidCount()) === 10, 8000);
    }
    console.log(`  rush C: 20 PayFast notifications (10 payments x 2) settled in ${Date.now() - tPay} ms`);
    const rowC = await tierRow(c.tier.id);
    const tk = await q('SELECT k.token FROM tickets k JOIN ticket_orders o ON o.id = k.order_id WHERE o.event_id = ?', [c.id]);
    check('C: 10 payments, each notified twice at the same moment - 10 paid orders, exactly 10 tickets (all different), 10 sold, nothing still held',
        !!allPaid && tk.length === 10 && new Set(tk.map(t => t.token)).size === 10 && rowC.sold === 10 && rowC.reserved === 0, JSON.stringify({ rowC, tickets: tk.length }));
}
