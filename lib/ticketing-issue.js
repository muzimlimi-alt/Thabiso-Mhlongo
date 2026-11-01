// Event ticketing - tickets issued OUTSIDE a sale (migration 116), by administrators / managers in Events -> Ticket Sales:
//   * COMPLIMENTARY tickets (guest list, press, sponsors): a paid order at R0, marked complimentary, with who issued it and why. They take
//     seats like any ticket (capacity is checked the same atomic way - a guest list can never oversell the venue) but are never revenue and
//     never touch PayFast. Cancelling them (lib/ticketing.js refundOrder, no e-mail) puts the seats back.
//   * VOID AND REISSUE one ticket (lost phone, a forwarded QR, a wrong name): the old code stops working at once and a new code is issued to
//     the same order and ticket type - the seat count does not change. The old ticket keeps when / who / why; the new one points back at it.
// Every write goes through ticketing.inTransaction (see lib/ticketing.js).
const { dbRun, dbGet, dbAll } = require('./db-helpers');
const core = require('./ticketing-core');
const ticketing = require('./ticketing');
const { Refusal, inTransaction, nowIso } = ticketing;

const MAX_COMPS = 20;
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Cleans the office's input. Resolves { clean, errors } like core.validateBuyer: guest name required, e-mail / phone optional.
function validateComp(src) {
    const s = src || {};
    const errors = {};
    const clean = {
        ticket_type_id: parseInt(s.ticket_type_id, 10),
        quantity: parseInt(s.quantity, 10),
        guest_name: core.oneLine(s.guest_name).slice(0, 120),
        guest_email: core.oneLine(s.guest_email).toLowerCase().slice(0, 200),
        guest_phone: core.oneLine(s.guest_phone).replace(/[\s()-]/g, '').slice(0, 20),
        note: core.oneLine(s.note).slice(0, 300)
    };
    if (!Number.isInteger(clean.ticket_type_id)) errors.ticket_type_id = 'Choose a ticket type.';
    if (!Number.isInteger(clean.quantity) || clean.quantity < 1 || clean.quantity > MAX_COMPS) errors.quantity = `Choose 1 to ${MAX_COMPS} tickets.`;
    if (clean.guest_name.length < 2) errors.guest_name = 'Enter the guest\'s name.';
    if (clean.guest_email && !EMAIL_SHAPE.test(clean.guest_email)) errors.guest_email = 'That e-mail address does not look right.';
    if (clean.guest_phone && !/^\+?\d{9,15}$/.test(clean.guest_phone)) errors.guest_phone = 'That phone number does not look right.';
    if (clean.note.length < 3) errors.note = 'Say who they are or why (e.g. "Press - Sowetan", "Sponsor").';
    return { clean, errors };
}

// Resolves { order, tickets } of the new complimentary order.
async function issueComplimentary(eventId, input, adminId) {
    const { clean, errors } = validateComp(input);
    if (Object.keys(errors).length) throw new Refusal(400, Object.values(errors)[0], { errors });
    return inTransaction(async () => {
        const ev = await ticketing.getEvent(eventId);
        if (!ev) throw new Refusal(404, 'Event not found.');
        if (ev.booking_id) throw new Refusal(409, 'This event does not sell tickets.');
        if (String(ev.event_status || '').toLowerCase() === 'cancelled') throw new Refusal(409, 'This show is cancelled.');
        const tier = await ticketing.getTier(clean.ticket_type_id);
        if (!tier || tier.event_id !== ev.event_id) throw new Refusal(400, 'That ticket type is not for this show.');
        await ticketing.expireStaleInTxn(ev.event_id);
        // the same guard as a sale: never above capacity (a CHECK in the table backs it up)
        const took = await dbRun('UPDATE ticket_types SET sold = sold + ? WHERE id = ? AND sold + reserved + ? <= capacity', [clean.quantity, tier.id, clean.quantity]);
        if (!took.changes) {
            const left = Math.max(0, tier.capacity - tier.sold - tier.reserved);
            throw new Refusal(409, left ? `Only ${left} ${tier.name} ticket${left === 1 ? '' : 's'} left - raise the capacity first, or issue fewer.` : `${tier.name} is full - raise its capacity first.`);
        }
        const t = nowIso();
        const ins = await dbRun(
            `INSERT INTO ticket_orders (public_reference, event_id, buyer_name, buyer_email, buyer_phone, total_cents, status, reserved_until, created_at, paid_at,
                                        complimentary, issued_by, comp_note)
             VALUES (?, ?, ?, ?, ?, 0, 'paid', ?, ?, ?, 1, ?, ?)`,
            [core.randomToken(), ev.event_id, clean.guest_name, clean.guest_email || null, clean.guest_phone || null, t, t, t, adminId || null, clean.note]);
        await dbRun('INSERT INTO ticket_order_items (order_id, ticket_type_id, quantity, unit_price_cents) VALUES (?, ?, ?, 0)', [ins.lastID, tier.id, clean.quantity]);
        for (let i = 0; i < clean.quantity; i++) {
            await dbRun('INSERT INTO tickets (order_id, ticket_type_id, holder_name, token, created_at) VALUES (?, ?, ?, ?, ?)', [ins.lastID, tier.id, clean.guest_name, core.randomToken(), t]);
        }
        return { order: await ticketing.getOrderById(ins.lastID), tickets: await ticketing.orderTickets(ins.lastID) };
    });
}

// Voids one ticket and issues its replacement. Refused for a ticket already used at the door (undo the check-in first), a voided one, or
// one of an order that is not paid (refunded / refund owed). Resolves { old, ticket } (ticket = the new one, door view fields).
async function reissueTicket(token, { reason, holderName }, adminId) {
    const why = core.oneLine(reason).slice(0, 300);
    if (why.length < 3) throw new Refusal(400, 'Say why (e.g. "lost phone", "QR forwarded", "name change").');
    const name = holderName == null ? null : core.oneLine(holderName).slice(0, 120);
    return inTransaction(async () => {
        const old = await ticketing.ticketByToken(String(token || ''));
        if (!old) throw new Refusal(404, 'Ticket not found.');
        if (old.order_status !== 'paid' || old.refund_required) throw new Refusal(409, 'Only a ticket of a paid order can be reissued.');
        if (old.voided_at) throw new Refusal(409, 'This ticket is already void.');
        if (old.checked_in_at) throw new Refusal(409, 'This ticket was already used at the door - undo the check-in first if that was a mistake.');
        const t = nowIso();
        const voided = await dbRun('UPDATE tickets SET voided_at = ?, voided_by = ?, void_reason = ? WHERE id = ? AND voided_at IS NULL AND checked_in_at IS NULL',
            [t, adminId || null, why, old.id]);
        if (!voided.changes) throw new Refusal(409, 'This ticket was changed a moment ago (scanned at the door?) - reload it.');
        const ins = await dbRun('INSERT INTO tickets (order_id, ticket_type_id, holder_name, token, created_at, replaces_ticket_id) VALUES (?, ?, ?, ?, ?, ?)',
            [old.order_id, old.ticket_type_id, name === null ? old.holder_name : (name || null), core.randomToken(), t, old.id]);
        const fresh = await dbGet('SELECT token FROM tickets WHERE id = ?', [ins.lastID]);
        return { old, ticket: await ticketing.ticketByToken(fresh.token) };
    });
}

// For the order drawer: complimentary details + each voided ticket's story.
async function issueDetails(orderId) {
    const o = await dbGet(`SELECT o.complimentary, o.comp_note, a.username AS issued_by_name FROM ticket_orders o LEFT JOIN admins a ON a.id = o.issued_by WHERE o.id = ?`, [orderId]);
    const voids = await dbAll(`SELECT k.id, k.voided_at, k.void_reason, a.username AS voided_by_name, (SELECT n.id FROM tickets n WHERE n.replaces_ticket_id = k.id) AS replaced_by
        FROM tickets k LEFT JOIN admins a ON a.id = k.voided_by WHERE k.order_id = ? AND k.voided_at IS NOT NULL AND k.void_reason IS NOT NULL ORDER BY k.id`, [orderId]);
    return { complimentary: !!(o && o.complimentary), comp_note: o && o.comp_note, issued_by_name: o && o.issued_by_name, voids };
}

module.exports = { MAX_COMPS, validateComp, issueComplimentary, reissueTicket, issueDetails };
