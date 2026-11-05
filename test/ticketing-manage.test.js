// Event ticketing - Manage Tickets (migration 117): changing a show's ticket inventory, prices, categories and sales state AFTER tickets
// have sold, without recreating the event and without touching any order, ticket, QR code or payment already made.
// Covers the owner's 2026-11-05 brief: increase / reduce places (never below sold + held), price change for new buyers only, add / switch
// off / reorder categories, event date / venue change, pause / resume, close / reopen, sold-out mark, sales window, event-capacity limit,
// live holds, existing QR tickets still admitting, Finance seeing the new sales, audit trail, roles.
// Date offsets 2060-2069 are reserved for this file. Every event it creates is cancelled before it ends.
const { api, pub, one, q, future, sleep, loginAs } = require('./support');
const { generatePayFastItnSignature } = require('../lib/payfast-signature');

const waitFor = async (fn, ms = 20000) => { const t = Date.now(); let v; while (Date.now() - t < ms) { v = await fn(); if (v) return v; await sleep(200); } return v; };
let pf = 0;

module.exports = async function ({ check }) {
    const made = [];
    try { await suite(check, made); }
    finally { for (const ev of made) await api('PUT', `/api/admin/events/${ev.id}`, { event_title: ev.title, event_datetime: ev.when, event_status: 'cancelled', sync_to_gcal: false }).catch(() => {}); }
};

async function makeShow(made, offset, title, extra = {}) {
    const when = `${future(offset)}T20:00`;
    const r = await api('POST', '/api/admin/events', { event_title: title, event_datetime: when, venue_name: 'Old Hall', event_status: 'upcoming', sync_to_gcal: false, ...extra });
    made.push({ id: r.body.id, title, when });
    return { id: r.body.id, title, when };
}
const addTier = async (eventId, body) => (await api('POST', `/api/admin/events/${eventId}/ticket-types`, { is_active: true, max_per_order: 10, ...body })).body;
const reserve = (eventId, tierId, qty) => pub('POST', '/api/public/ticket-orders', { event_id: eventId, items: [{ ticket_type_id: tierId, quantity: qty }] });
const tierRow = (id) => one('SELECT * FROM ticket_types WHERE id = ?', [id]);
const manage = (id) => api('GET', `/api/admin/events/${id}/ticketing`);
const sales = (id, action) => api('POST', `/api/admin/events/${id}/ticket-sales`, { action });

async function paidOrder(eventId, tierId, qty, email) {
    const o = (await reserve(eventId, tierId, qty)).body.order;
    await pub('POST', `/api/public/ticket-orders/${o.reference}/checkout`, { buyer_name: 'Manage Buyer', buyer_email: email, buyer_phone: '0821234567', popia_consent: true, terms_accepted: true });
    const row = await one('SELECT * FROM ticket_orders WHERE public_reference = ?', [o.reference]);
    const m = { m_payment_id: row.m_payment_id, pf_payment_id: `MNG-${Date.now()}-${++pf}`, payment_status: 'COMPLETE', item_name: 'x', item_description: '', amount_gross: (row.total_cents / 100).toFixed(2), amount_fee: '-1.00', amount_net: '1.00',
        custom_str1: '', custom_str2: '', custom_str3: '', custom_str4: '', custom_str5: '', custom_int1: '', custom_int2: '', custom_int3: '', custom_int4: '', custom_int5: '', name_first: 'M', name_last: 'B', email_address: email, merchant_id: '10000100' };
    m.signature = generatePayFastItnSignature(m, null);
    await pub('POST', '/api/payment/webhook/payfast', m);
    await waitFor(async () => (await one('SELECT status FROM ticket_orders WHERE id = ?', [row.id])).status === 'paid');
    await waitFor(async () => (await one('SELECT COUNT(*) AS n FROM tickets WHERE order_id = ?', [row.id])).n === qty);
    return one('SELECT * FROM ticket_orders WHERE id = ?', [row.id]);
}

async function suite(check, made) {
    // ── setup: a show with three categories, inside an event capacity of 250 ──
    const show = await makeShow(made, 2060, 'ZZ Manage Show', { event_capacity: 250 });
    const ga = (await addTier(show.id, { name: 'General Admission', price: '150', capacity: 100 })).tier;
    const vip = (await addTier(show.id, { name: 'VIP', price: '500', capacity: 30 })).tier;
    const eb = (await addTier(show.id, { name: 'Early Bird', price: '100', capacity: 50 })).tier;
    check('setup: a show with General 100, VIP 30, Early Bird 50 (new categories go to the end of the list)', !!(ga && vip && eb) && vip.sort_order > ga.sort_order && eb.sort_order > vip.sort_order, JSON.stringify([ga, vip, eb].map(t => t && t.sort_order)));
    const open0 = await sales(show.id, 'open');
    check('Open sales: the show is selling', open0.status === 200 && open0.body.overview.state === 'open', JSON.stringify(open0.body));

    // a completed purchase at the ORIGINAL price
    const first = await paidOrder(show.id, ga.id, 2, 'manage-first@test.invalid');
    const firstTickets = await q('SELECT token FROM tickets WHERE order_id = ?', [first.id]);
    const firstLine = await one('SELECT unit_price_cents FROM ticket_order_items WHERE order_id = ?', [first.id]);
    check('setup: a paid order of 2 General tickets at R150', first.status === 'paid' && first.total_cents === 30000 && firstLine.unit_price_cents === 15000 && firstTickets.length === 2, JSON.stringify(first));

    // 1. increase capacity after tickets sold
    const up = await api('POST', `/api/admin/ticket-types/${ga.id}/capacity`, { capacity: 150 });
    const upRow = await tierRow(ga.id);
    check('1. General goes from 100 to 150 places after tickets sold - sold count untouched', up.status === 200 && upRow.capacity === 150 && upRow.sold === 2, JSON.stringify([up.body, upRow]));
    const add = await api('POST', `/api/admin/ticket-types/${vip.id}/capacity`, { add: 10 });
    check('1b. "add 10" to VIP gives 40', add.status === 200 && (await tierRow(vip.id)).capacity === 40, JSON.stringify(add.body));

    // event capacity: 150 + 40 + 50 = 240 of 250 -> +20 is refused
    const over = await api('POST', `/api/admin/ticket-types/${eb.id}/capacity`, { add: 20 });
    check('allocations past the event capacity (250) are refused with the numbers', over.status === 409 && /260 tickets/.test(over.body.message) && /capacity is 250/.test(over.body.message) && (await tierRow(eb.id)).capacity === 50, JSON.stringify(over.body));
    const capDown = await api('PUT', `/api/admin/events/${show.id}`, { event_title: show.title, event_datetime: show.when, venue_name: 'Old Hall', event_status: 'upcoming', event_capacity: 200, sync_to_gcal: false });
    check('the event capacity cannot be lowered below what the categories give out (240)', capDown.status === 409 && /240 places/.test(capDown.body.message || ''), JSON.stringify(capDown.body));

    // 2. reduce, never below sold + held  (General: 2 sold; hold 3 more)
    const hold = await reserve(show.id, ga.id, 3);
    const tooLow = await api('POST', `/api/admin/ticket-types/${ga.id}/capacity`, { capacity: 4 });
    const okLow = await api('POST', `/api/admin/ticket-types/${ga.id}/capacity`, { capacity: 5 });
    check('2. reducing below sold + held (2 + 3) is refused with why; reducing to exactly 5 works', !!(hold.body && hold.body.order) && tooLow.status === 409 && /2 are sold and 3 are held/.test(tooLow.body.message) && okLow.status === 200 && (await tierRow(ga.id)).capacity === 5, JSON.stringify([tooLow.body, okLow.body]));
    const full = await reserve(show.id, ga.id, 1);
    check('2b. no sale beyond the inventory: General is now full (5 of 5 sold or held)', full.status === 409, JSON.stringify(full.body));

    // 9. active reservations are counted and reported
    const m1 = await manage(show.id);
    check('9. Manage Tickets reports the live hold (1 buyer, 3 tickets) and General as 0 available',
        m1.body.holds.orders >= 1 && m1.body.holds.tickets >= 3 && m1.body.tiers.find(t => t.id === ga.id).remaining === 0, JSON.stringify(m1.body.holds));
    await pub('POST', `/api/public/ticket-orders/${hold.body.order.reference}/release`).catch(() => {});
    await api('POST', `/api/admin/ticket-types/${ga.id}/capacity`, { capacity: 150 });

    // 3 + 12. price change: old order keeps R150, new purchase pays R175
    const price = await api('PUT', `/api/admin/ticket-types/${ga.id}`, { name: 'General Admission', price: '175', capacity: 150, max_per_order: 10, is_active: true });
    check('3. changing the price after a purchase says how many orders keep the old price', price.status === 200 && price.body.tier.price_cents === 17500 && price.body.existing_orders_keep_price >= 1 && /old price \(R 150\.00\)/.test(price.body.message), JSON.stringify(price.body));
    const firstAfter = await one('SELECT o.total_cents, i.unit_price_cents FROM ticket_orders o JOIN ticket_order_items i ON i.order_id = o.id WHERE o.id = ?', [first.id]);
    check('11. the completed order is unchanged (R300, R150 a ticket)', firstAfter.total_cents === 30000 && firstAfter.unit_price_cents === 15000, JSON.stringify(firstAfter));
    const second = await paidOrder(show.id, ga.id, 1, 'manage-second@test.invalid');
    check('12. a new purchase pays the new price (R175)', second.total_cents === 17500, JSON.stringify(second));
    check('the editor kept the category\'s list position (no sort_order sent)', (await tierRow(ga.id)).sort_order === ga.sort_order, String((await tierRow(ga.id)).sort_order));

    // 4. add a category to an existing, selling event
    const prem = await addTier(show.id, { name: 'Premium', price: '800', capacity: 10 });
    const m2 = await manage(show.id);
    check('4. a new category on an event that already sold tickets is on sale at once', prem.success && m2.body.tiers.find(t => t.name === 'Premium').state === 'on_sale', JSON.stringify(prem));

    // reorder
    const order = [prem.tier.id, vip.id, ga.id, eb.id];
    const ro = await api('POST', `/api/admin/events/${show.id}/ticket-types/reorder`, { order });
    const pubTiers = (await pub('GET', `/api/public/events/${show.id}/tickets`)).body;
    const pubOrder = pubTiers && pubTiers.tiers ? pubTiers.tiers.map(t => t.id) : [];
    check('reorder: the categories (and the buyer\'s drawer) follow the new order', ro.status === 200 && JSON.stringify(pubOrder) === JSON.stringify(order), JSON.stringify([ro.body, pubOrder]));
    const badRo = await api('POST', `/api/admin/events/${show.id}/ticket-types/reorder`, { order: [ga.id, vip.id] });
    check('reorder refuses a list that leaves categories out', badRo.status === 400, JSON.stringify(badRo.body));

    // 5. disable a category
    const off = await api('POST', `/api/admin/ticket-types/${eb.id}/enabled`, { enabled: false });
    const offBuy = await reserve(show.id, eb.id, 1);
    check('5. a switched-off category cannot be bought; the rest still sell', off.status === 200 && offBuy.status === 400 && (await reserve(show.id, vip.id, 1)).status < 300, JSON.stringify([off.body, offBuy.body]));

    // 7. pause / resume - the category switch survives
    const pause = await sales(show.id, 'pause');
    const pausedBuy = await reserve(show.id, ga.id, 1);
    const pausedPub = (await pub('GET', `/api/public/events/${show.id}/tickets`)).body;
    check('7. pausing stops new buyers with a "paused" message and the public summary says paused',
        pause.status === 200 && pause.body.overview.state === 'paused' && pausedBuy.status === 400 && /paused/i.test(pausedBuy.body.message || '') && pausedPub && pausedPub.summary.state === 'paused', JSON.stringify([pause.body, pausedBuy.body, pausedPub && pausedPub.summary]));
    const pauseTwice = await sales(show.id, 'pause');
    const resume = await sales(show.id, 'resume');
    check('7b. resume brings sales back; pausing twice is refused', pauseTwice.status === 409 && resume.status === 200 && resume.body.overview.state === 'open' && (await reserve(show.id, ga.id, 1)).status < 300, JSON.stringify([pauseTwice.body, resume.body]));
    check('7c. Early Bird was switched off before the pause and is STILL off after resuming', (await tierRow(eb.id)).is_active === 0, '');

    // 8. close / reopen
    const close = await sales(show.id, 'close');
    const closedBuy = await reserve(show.id, ga.id, 1);
    const resumeClosed = await sales(show.id, 'resume');
    const reopen = await sales(show.id, 'reopen');
    check('8. closed sales refuse buyers; resume is refused on a closed show; reopen works and keeps Early Bird off',
        close.status === 200 && closedBuy.status === 400 && resumeClosed.status === 409 && reopen.status === 200 && reopen.body.overview.state === 'open' && (await tierRow(eb.id)).is_active === 0,
        JSON.stringify([close.body, closedBuy.body, resumeClosed.body, reopen.body]));

    // sold-out mark is not the same as closing
    const mark = await api('POST', `/api/admin/events/${show.id}/sold-out`, { mark: true });
    const m3 = await manage(show.id);
    const markedBuy = await reserve(show.id, ga.id, 1);
    const unmark = await api('POST', `/api/admin/events/${show.id}/sold-out`, { mark: false });
    const m4 = await manage(show.id);
    check('the organiser\'s sold-out mark shows as "marked_sold_out" (not closed), stops sales, and removing it restores selling',
        mark.status === 200 && m3.body.sales.state === 'marked_sold_out' && markedBuy.status === 400 && unmark.status === 200 && m4.body.sales.state === 'open' && m4.body.event.event_status === 'upcoming', JSON.stringify([m3.body.sales, m4.body.sales]));

    // sales window
    const winBad = await api('PUT', `/api/admin/events/${show.id}/ticket-sales-window`, { opens_at: `${future(2061)}T10:00`, closes_at: `${future(2061)}T09:00` });
    const win = await api('PUT', `/api/admin/events/${show.id}/ticket-sales-window`, { opens_at: `${future(2050)}T10:00`, closes_at: '' });
    const m5 = await manage(show.id);
    const earlyBuy = await reserve(show.id, ga.id, 1);
    const clear = await api('PUT', `/api/admin/events/${show.id}/ticket-sales-window`, { opens_at: '', closes_at: '' });
    check('an event-wide sales window that has not opened stops sales ("not_open"); a window that closes before it opens is refused; clearing it restores selling',
        winBad.status === 400 && win.status === 200 && m5.body.sales.state === 'not_open' && m5.body.sales.opens_local === `${future(2050)}T10:00` && earlyBuy.status === 400 && clear.status === 200 && (await manage(show.id)).body.sales.state === 'open',
        JSON.stringify([winBad.body, m5.body.sales, earlyBuy.body]));

    // 6 + 10. change date, time and venue: the existing QR tickets still admit
    const newWhen = `${future(2062)}T19:30`;
    const moved = await api('PUT', `/api/admin/events/${show.id}`, { event_title: show.title, event_datetime: newWhen, venue_name: 'New Hall', event_status: 'upcoming', event_capacity: 250, sync_to_gcal: false });
    made.find(m => m.id === show.id).when = newWhen;
    const evRow = await one('SELECT event_datetime, venue_name FROM events WHERE event_id = ?', [show.id]);
    const count = await one('SELECT COUNT(*) AS n FROM events WHERE event_title = ?', [show.title]);
    check('6. date, time and venue change on the SAME event record (no duplicate)', moved.status === 200 && evRow.event_datetime === newWhen && evRow.venue_name === 'New Hall' && count.n === 1, JSON.stringify([moved.body, evRow, count]));
    const scan = await api('POST', `/api/admin/ticketing/tickets/${firstTickets[0].token}/check-in`);
    const tokensNow = await q('SELECT token FROM tickets WHERE order_id = ? AND voided_at IS NULL', [first.id]);
    check('10. a ticket bought before all these changes still admits at the door, and its QR token never changed',
        scan.status === 200 && scan.body.result === 'admitted' && JSON.stringify(tokensNow.map(t => t.token).sort()) === JSON.stringify(firstTickets.map(t => t.token).sort()), JSON.stringify(scan.body));

    // 13. Finance / stats see the new sales; sold counts only verified payments
    const st = (await api('GET', `/api/admin/ticketing/events/${show.id}/stats`)).body.stats;
    check('13. the figures: gross R475 (R300 + R175 verified), net = revenue, inventory totals add up, 1 checked in',
        st.gross_cents === 47500 && st.net_cents === st.revenue_cents && st.totals.sold === 3 && st.totals.allocated === st.tiers.reduce((n, t) => n + t.capacity, 0) && st.door.checked_in === 1,
        JSON.stringify({ g: st.gross_cents, n: st.net_cents, r: st.revenue_cents, totals: st.totals, door: st.door }));
    const fin = await api('GET', '/api/admin/ticketing/finance');
    check('13b. Finance -> Ticket Sales answers with this show\'s new sale included (no error)', fin.status === 200, JSON.stringify(fin.body).slice(0, 300));
    check('increasing inventory never created a sale: sold = tickets issued on paid orders', (await one(`SELECT COALESCE(SUM(sold), 0) AS s FROM ticket_types WHERE event_id = ?`, [show.id])).s ===
        (await one(`SELECT COUNT(*) AS n FROM tickets k JOIN ticket_orders o ON o.id = k.order_id WHERE o.event_id = ? AND o.status = 'paid' AND k.voided_at IS NULL`, [show.id])).n, '');

    // audit trail
    const hist = await api('GET', `/api/admin/events/${show.id}/ticketing-history`);
    const actions = (hist.body.history || []).map(h => h.action);
    const priceRow = (hist.body.history || []).find(h => h.action === 'TICKET_TYPE_UPDATED' && /price R 150\.00 -> R 175\.00/.test(h.what));
    check('audit: capacity, price, on/off, reorder, pause/resume/close/reopen, window and sold-out changes are all recorded with who did it',
        ['TICKET_CAPACITY_CHANGED', 'TICKET_TYPE_DISABLED', 'TICKET_TYPES_REORDERED', 'TICKET_SALES_PAUSED', 'TICKET_SALES_RESUMED', 'TICKET_SALES_CLOSED', 'TICKET_SALES_REOPENED', 'TICKET_SALES_WINDOW_CHANGED', 'TICKET_EVENT_MARKED_SOLD_OUT', 'TICKET_TYPE_CREATED'].every(a => actions.includes(a)) && !!priceRow && priceRow.who !== 'system',
        JSON.stringify(actions));

    // roles
    const asst = await loginAs('assistant');
    const a1 = await asst('POST', `/api/admin/ticket-types/${ga.id}/capacity`, { add: 1 });
    const a2 = await asst('POST', `/api/admin/events/${show.id}/ticket-sales`, { action: 'pause' });
    const a3 = await asst('POST', `/api/admin/events/${show.id}/sold-out`, { mark: true });
    const a4 = await asst('GET', `/api/admin/ticketing/events/${show.id}/stats`);
    check('an assistant cannot change places, sales or the sold-out mark (403), and sees no revenue', a1.status === 403 && a2.status === 403 && a3.status === 403 && a4.status === 200 && a4.body.stats.gross_cents === undefined && a4.body.stats.net_cents === undefined,
        JSON.stringify([a1.status, a2.status, a3.status, a4.body.stats && Object.keys(a4.body.stats)]));
    const mgr = await loginAs('manager');
    const m6 = await mgr('POST', `/api/admin/ticket-types/${vip.id}/capacity`, { add: -5 });
    check('a manager can manage places', m6.status === 200 && (await tierRow(vip.id)).capacity === 35, JSON.stringify(m6.body));

    // a legacy show: every category switched off -> Open switches them all on (what Open always did)
    const legacy = await makeShow(made, 2063, 'ZZ Manage Legacy');
    const lt = (await addTier(legacy.id, { name: 'General', price: '100', capacity: 10, is_active: false })).tier;
    const m7 = await manage(legacy.id);
    const lo = await sales(legacy.id, 'open');
    check('a show whose categories are all off reads "closed (no_enabled)"; Open switches them on and says so',
        m7.body.sales.state === 'closed' && m7.body.sales.reason === 'no_enabled' && lo.status === 200 && /switched on/.test(lo.body.message) && (await tierRow(lt.id)).is_active === 1, JSON.stringify([m7.body.sales, lo.body]));
}
