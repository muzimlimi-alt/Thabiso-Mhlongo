// Event ticketing - the admin side against the real server: ticket types inside an event, the Open/Close sales switch, who may do what,
// and how ticketing changes the existing Events routes (cancel/postpone stops sales; an event with only unsold tiers still deletes).
// Date offsets 1900-1919 are reserved for this file. Every event it creates is cancelled or deleted before it ends.
const { api, future, loginAs } = require('./support');

const evDate = (offset, time = '20:00') => `${future(offset)}T${time}`;

module.exports = async function ({ check }) {
    const made = [];
    try { await suite(check, made); }
    finally {
        for (const ev of made) {
            await api('PUT', `/api/admin/events/${ev.id}`, { event_title: ev.title, event_datetime: ev.when, event_status: 'cancelled', sync_to_gcal: false }).catch(() => {});
        }
    }
};

async function makeEvent(made, offset, title, extra = {}) {
    const when = evDate(offset);
    const r = await api('POST', '/api/admin/events', { event_title: title, event_datetime: when, venue_name: 'Test Venue', event_status: 'upcoming', sync_to_gcal: false, ...extra });
    const id = r.body && r.body.id;
    if (id) made.push({ id, title, when });
    return { id, when, title, status: r.status, body: r.body };
}

async function suite(check, made) {
    const ev = await makeEvent(made, 1900, 'Ticketing Admin Show');
    check('setup: an ordinary standalone event is created through the existing Events API', !!ev.id, JSON.stringify(ev.body));

    const empty = await api('GET', `/api/admin/events/${ev.id}/ticketing`);
    check('an event starts with no ticket types, sales closed, and can sell (standalone, future, upcoming)',
        empty.status === 200 && empty.body.tiers.length === 0 && empty.body.sales_open === false && empty.body.can_sell === true && empty.body.event.standalone === true, JSON.stringify(empty.body));

    const gen = await api('POST', `/api/admin/events/${ev.id}/ticket-types`, { name: 'General', price: '150', capacity: 100, max_per_order: 6, is_active: false });
    const vip = await api('POST', `/api/admin/events/${ev.id}/ticket-types`, { name: 'VIP &amp; Meet', price: 'R 450,50', capacity: 20, max_per_order: 2, sales_end: future(1899) + 'T18:00' });
    check('admin adds ticket types: price stored in cents, entity-encoded names stored as plain text',
        gen.status === 200 && gen.body.tier.price_cents === 15000 && vip.status === 200 && vip.body.tier.price_cents === 45050 && vip.body.tier.name === 'VIP & Meet', JSON.stringify([gen.body, vip.body]));
    const badPrice = await api('POST', `/api/admin/events/${ev.id}/ticket-types`, { name: 'Free', price: '0', capacity: 10 });
    const dup = await api('POST', `/api/admin/events/${ev.id}/ticket-types`, { name: 'General', price: '100', capacity: 10 });
    check('a price under R5 (PayFast\'s minimum) is refused with a message; a duplicate name in the same event is refused (409)',
        badPrice.status === 400 && /R 5\.00/.test(badPrice.body.message) && dup.status === 409, JSON.stringify([badPrice.body, dup.body]));

    const open = await api('POST', `/api/admin/events/${ev.id}/ticket-sales`, { open: true });
    const afterOpen = await api('GET', `/api/admin/events/${ev.id}/ticketing`);
    check('Open sales switches every tier of the event on, and the tab reports sales open',
        open.status === 200 && afterOpen.body.sales_open === true && afterOpen.body.tiers.every(t => t.is_active) && afterOpen.body.tiers.find(t => t.name === 'General').state === 'on_sale', JSON.stringify(afterOpen.body.tiers));
    check('the editor gets sale times back as Johannesburg datetime-local values', afterOpen.body.tiers.find(t => t.name === 'VIP & Meet').sales_end_local === future(1899) + 'T18:00', JSON.stringify(afterOpen.body.tiers.map(t => t.sales_end_local)));

    const edit = await api('PUT', `/api/admin/ticket-types/${gen.body.tier.id}`, { name: 'General Admission', price: '175', capacity: 120, max_per_order: 6, is_active: true });
    check('editing a tier saves name, price and capacity', edit.status === 200 && edit.body.tier.name === 'General Admission' && edit.body.tier.price_cents === 17500 && edit.body.tier.capacity === 120, JSON.stringify(edit.body));

    // capacity warning against the event's own capacity
    const capped = await makeEvent(made, 1901, 'Ticketing Capped Show', { event_capacity: 50 });
    const over = await api('POST', `/api/admin/events/${capped.id}/ticket-types`, { name: 'General', price: '100', capacity: 60 });
    check('a tier bigger than the event\'s own capacity is refused (409) and the message says why', over.status === 409 && /60 tickets/.test(over.body.message || '') && /capacity is 50/.test(over.body.message || ''), JSON.stringify(over.body));

    // roles
    const asst = await loginAs('assistant');
    const asstRead = await asst('GET', `/api/admin/events/${ev.id}/ticketing`);
    const asstAdd = await asst('POST', `/api/admin/events/${ev.id}/ticket-types`, { name: 'Sneaky', price: '100', capacity: 5 });
    const asstClose = await asst('POST', `/api/admin/events/${ev.id}/ticket-sales`, { open: false });
    check('an assistant can SEE an event\'s tickets but cannot add tiers or switch sales (403)', asstRead.status === 200 && asstAdd.status === 403 && asstClose.status === 403, JSON.stringify([asstRead.status, asstAdd.status, asstClose.status]));
    const mgr = await loginAs('manager');
    const mgrAdd = await mgr('POST', `/api/admin/events/${ev.id}/ticket-types`, { name: 'Early Bird', price: '99', capacity: 30 });
    check('a manager can manage ticket types', mgrAdd.status === 200, JSON.stringify(mgrAdd.body));
    const anon = await fetch(`${require('./support').BASE}/api/admin/events/${ev.id}/ticketing`);
    check('anyone not logged in gets 401', anon.status === 401, String(anon.status));

    // delete a never-ordered tier
    const del = await api('DELETE', `/api/admin/ticket-types/${mgrAdd.body.tier.id}`);
    check('a ticket type nobody ordered can be deleted', del.status === 200, JSON.stringify(del.body));

    // the Events routes: cancelling / postponing stops sales
    const pp = await api('PUT', `/api/admin/events/${ev.id}`, { event_title: ev.title, event_datetime: ev.when, event_status: 'postponed', sync_to_gcal: false });
    const afterPp = await api('GET', `/api/admin/events/${ev.id}/ticketing`);
    check('postponing the event (existing Events edit) closes its ticket sales and says so',
        pp.status === 200 && pp.body.ticket_paid_orders === 0 && afterPp.body.sales_open === false && afterPp.body.can_sell === false && afterPp.body.block_reason === 'event_postponed', JSON.stringify([pp.body, afterPp.body.block_reason]));
    const reopen = await api('POST', `/api/admin/events/${ev.id}/ticket-sales`, { open: true });
    check('sales cannot be reopened while the event is postponed', reopen.status === 409, JSON.stringify(reopen.body));

    // the Events routes: deleting an event whose tiers were never ordered still works (tiers go with it)
    const gone = await makeEvent(made, 1902, 'Ticketing Delete Me');
    await api('POST', `/api/admin/events/${gone.id}/ticket-types`, { name: 'General', price: '100', capacity: 10 });
    const delEv = await api('DELETE', `/api/admin/events/${gone.id}`);
    const after = await api('GET', `/api/admin/events/${gone.id}/ticketing`);
    check('deleting an event with only unsold ticket types still works through the existing Events delete', delEv.status === 200 && after.status === 404, JSON.stringify([delEv.body, after.status]));
    if (delEv.status === 200) made.splice(made.findIndex(m => m.id === gone.id), 1);
}
