// Event ticketing - the database side: an event's ticket tiers, the public summary of what is on sale, reserving stock without ever
// overselling, holds that run out, the buyer's details at checkout, refunds and the door check-in. Pure rules: lib/ticketing-core.js.
// Payments: lib/ticketing-payments.js. Tickets by e-mail/PDF: lib/ticketing-delivery.js. Design: docs-internal/ticketing.md.
//
// Overselling is impossible by construction:
//   1. every stock change runs inside withDbTransaction + BEGIN IMMEDIATE (one writer at a time on the one shared connection);
//   2. a reservation is a conditional UPDATE - "... WHERE sold + reserved + q <= capacity" - and 0 changed rows means sold out;
//   3. the table itself refuses it: CHECK (sold + reserved <= capacity) on ticket_types (lib/ticketing-schema.js).
// Functions named *InTxn run inside a transaction the caller already holds - they must never call withDbTransaction themselves
// (the queue is a single chain, so a nested call would wait for itself forever).
const { dbRun, dbGet, dbAll } = require('./db-helpers');
const { withDbTransaction } = require('./db-transaction');
const core = require('./ticketing-core');

const nowIso = () => new Date().toISOString();

async function inTransaction(fn) {
    return withDbTransaction(async () => {
        await dbRun('BEGIN IMMEDIATE');
        try {
            const out = await fn();
            await dbRun('COMMIT');
            return out;
        } catch (e) {
            await dbRun('ROLLBACK').catch(() => {});
            throw e;
        }
    });
}

// A result the caller should report to the user rather than treat as a failure: the transaction is rolled back, nothing changed.
class Refusal extends Error {
    constructor(status, message, extra) { super(message); this.refusal = true; this.status = status; Object.assign(this, extra || {}); }
}

// ---------------------------------------------------------------- events

const EVENT_COLUMNS = 'event_id, event_title, event_datetime, event_end_time, venue_name, venue_map_link, poster_image_path, event_status, event_capacity, booking_id';

async function getEvent(eventId) {
    const id = Number(eventId);
    if (!Number.isInteger(id) || id < 1) return null;
    return (await dbGet(`SELECT ${EVENT_COLUMNS} FROM events WHERE event_id = ?`, [id])) || null;
}

// ---------------------------------------------------------------- tiers (admin)

const listTiers = (eventId) => dbAll('SELECT * FROM ticket_types WHERE event_id = ? ORDER BY sort_order, price_cents, id', [eventId]);
const getTier = async (id) => (await dbGet('SELECT * FROM ticket_types WHERE id = ?', [id])) || null;

async function capacityWarning(eventId) {
    const ev = await getEvent(eventId);
    if (!ev || !ev.event_capacity) return null;
    const row = await dbGet('SELECT COALESCE(SUM(capacity), 0) AS total FROM ticket_types WHERE event_id = ?', [eventId]);
    return row.total > ev.event_capacity ? `The ticket types add up to ${row.total} places but the event's capacity is ${ev.event_capacity}.` : null;
}

// clean: from core.validateTier(). Tiers may only be added to a standalone event (Thabiso's own show - not a client's booking).
async function createTier(eventId, clean, adminId) {
    const ev = await getEvent(eventId);
    if (!ev) throw new Refusal(404, 'Event not found.');
    if (ev.booking_id) throw new Refusal(409, 'Tickets can only be sold for your own (standalone) events, not for a client booking.');
    const t = nowIso();
    try {
        const ins = await dbRun(
            `INSERT INTO ticket_types (event_id, name, description, price_cents, capacity, sales_start, sales_end, max_per_order, is_active, sort_order, created_by, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [ev.event_id, clean.name, clean.description, clean.price_cents, clean.capacity, clean.sales_start, clean.sales_end, clean.max_per_order,
             clean.is_active, clean.sort_order, adminId || null, t, t]);
        return getTier(ins.lastID);
    } catch (e) {
        if (/UNIQUE/.test(e.message)) throw new Refusal(409, `This event already has a ticket type called "${clean.name}".`);
        throw e;
    }
}

// Price changes only affect NEW orders (each order line keeps the price it was sold at). Capacity can never drop below what is
// already sold or held - inside a transaction so a sale cannot slip in between the check and the update.
async function updateTier(id, clean) {
    return inTransaction(async () => {
        const before = await getTier(id);
        if (!before) throw new Refusal(404, 'Ticket type not found.');
        const committed = before.sold + before.reserved;
        if (clean.capacity < committed) throw new Refusal(409, `Capacity can't go below ${committed} - that many are already sold or held.`);
        try {
            await dbRun(
                `UPDATE ticket_types SET name = ?, description = ?, price_cents = ?, capacity = ?, sales_start = ?, sales_end = ?, max_per_order = ?,
                        is_active = ?, sort_order = ?, updated_at = ? WHERE id = ?`,
                [clean.name, clean.description, clean.price_cents, clean.capacity, clean.sales_start, clean.sales_end, clean.max_per_order,
                 clean.is_active, clean.sort_order, nowIso(), id]);
        } catch (e) {
            if (/UNIQUE/.test(e.message)) throw new Refusal(409, `This event already has a ticket type called "${clean.name}".`);
            throw e;
        }
        return { before, after: await getTier(id) };
    });
}

// Only a tier nobody has ever ordered can be deleted; otherwise it is closed (is_active = 0) and keeps its history.
async function deleteTier(id) {
    return inTransaction(async () => {
        const tier = await getTier(id);
        if (!tier) throw new Refusal(404, 'Ticket type not found.');
        const used = await dbGet('SELECT COUNT(*) AS n FROM ticket_order_items WHERE ticket_type_id = ?', [id]);
        if (tier.sold || tier.reserved || used.n) throw new Refusal(409, 'This ticket type has orders, so it can\'t be deleted - close its sales instead.');
        await dbRun('DELETE FROM ticket_types WHERE id = ?', [id]);
        return tier;
    });
}

// The event-wide Open / Close sales switch: every tier of the event at once.
async function setEventSales(eventId, open) {
    const ev = await getEvent(eventId);
    if (!ev) throw new Refusal(404, 'Event not found.');
    if (open && core.eventBlockReason(ev)) throw new Refusal(409, 'This event can\'t sell tickets right now (it is cancelled, postponed, a draft, past, or has no date).');
    const r = await dbRun('UPDATE ticket_types SET is_active = ?, updated_at = ? WHERE event_id = ?', [open ? 1 : 0, nowIso(), ev.event_id]);
    if (open && !r.changes) throw new Refusal(409, 'Add a ticket type first.');
    return { changed: r.changes };
}

// Called by routes/admin/events.js when an event is cancelled or postponed: sales stop; paid orders are reported, never auto-refunded.
async function closeSalesForEvent(eventId) {
    await dbRun('UPDATE ticket_types SET is_active = 0, updated_at = ? WHERE event_id = ? AND is_active = 1', [nowIso(), eventId]);
    const paid = await dbGet("SELECT COUNT(*) AS n FROM ticket_orders WHERE event_id = ? AND status = 'paid'", [eventId]);
    return { paidOrders: paid.n };
}

// For routes/admin/events.js DELETE: what deleting this event would destroy. Orders block it (financial records); bare tiers do not.
async function eventDeletionCheck(eventId) {
    const orders = await dbGet('SELECT COUNT(*) AS n FROM ticket_orders WHERE event_id = ?', [eventId]);
    const tiers = await dbGet('SELECT COUNT(*) AS n FROM ticket_types WHERE event_id = ?', [eventId]);
    return { orders: orders.n, tiers: tiers.n };
}
// Removes the unsold tiers of an event that is about to be deleted (only valid when eventDeletionCheck() found no orders).
const deleteUnsoldTiersOfEvent = (eventId) => dbRun('DELETE FROM ticket_types WHERE event_id = ? AND sold = 0 AND reserved = 0 AND id NOT IN (SELECT ticket_type_id FROM ticket_order_items)', [eventId]);

// ---------------------------------------------------------------- holds that run out

// Releases every pending order whose hold has passed. Must run inside the caller's transaction.
async function expireStaleInTxn(eventId) {
    const t = nowIso();
    const stale = await dbAll(
        `SELECT id FROM ticket_orders WHERE status = 'pending' AND reserved_until < ?${eventId ? ' AND event_id = ?' : ''}`,
        eventId ? [t, eventId] : [t]);
    for (const o of stale) await releaseHoldInTxn(o.id, 'expired', t);
    return stale.length;
}

// pending -> expired|failed, giving the held stock back. The status guard makes it a no-op for an order that already moved on.
async function releaseHoldInTxn(orderId, toStatus, at) {
    const col = toStatus === 'failed' ? 'failed_at' : 'expired_at';
    const flip = await dbRun(`UPDATE ticket_orders SET status = ?, ${col} = ? WHERE id = ? AND status = 'pending'`, [toStatus, at || nowIso(), orderId]);
    if (!flip.changes) return false;
    const items = await dbAll('SELECT ticket_type_id, quantity FROM ticket_order_items WHERE order_id = ?', [orderId]);
    for (const it of items) {
        const r = await dbRun('UPDATE ticket_types SET reserved = reserved - ? WHERE id = ? AND reserved >= ?', [it.quantity, it.ticket_type_id, it.quantity]);
        if (!r.changes) throw new Error(`ticketing: hold accounting broken for order ${orderId} tier ${it.ticket_type_id}`);
    }
    return true;
}

// The scheduled sweep (and anyone who wants a tidy count) - its own transaction.
const expireStaleOrders = (eventId) => inTransaction(() => expireStaleInTxn(eventId || null));

// ---------------------------------------------------------------- public: what is on sale

// What the public Events section shows per event: { [event_id]: summary } (see core.eventSummary). Lazily releases lapsed holds first
// so a "Sold Out" card is never caused by an abandoned basket.
async function summariesForEvents(events) {
    const ids = (events || []).map(e => e.event_id).filter(Number.isInteger);
    if (!ids.length) return {};
    const lapsed = await dbGet(`SELECT COUNT(*) AS n FROM ticket_orders WHERE status = 'pending' AND reserved_until < ?`, [nowIso()]);
    if (lapsed && lapsed.n) await expireStaleOrders().catch(e => console.error('[Ticketing] lazy expiry failed:', e.message));
    const tiers = await dbAll(`SELECT * FROM ticket_types WHERE event_id IN (${ids.map(() => '?').join(',')})`, ids);
    const byEvent = new Map();
    for (const t of tiers) { if (!byEvent.has(t.event_id)) byEvent.set(t.event_id, []); byEvent.get(t.event_id).push(t); }
    const out = {};
    const now = new Date();
    for (const ev of events) {
        const s = core.eventSummary(byEvent.get(ev.event_id), ev, now);
        if (s) out[ev.event_id] = s;
    }
    return out;
}

// The drawer's first step: the event and its tiers as a buyer may see them.
async function publicEventTickets(eventId) {
    const ev = await getEvent(eventId);
    if (!ev || ev.booking_id || ['draft', 'cancelled'].includes(String(ev.event_status || '').toLowerCase())) return null;
    await inTransaction(() => expireStaleInTxn(ev.event_id));
    const tiers = (await listTiers(ev.event_id)).filter(t => t.is_active || t.sold);   // closed, never-sold tiers stay invisible
    if (!tiers.length) return null;
    const now = new Date();
    return {
        event: publicEvent(ev),
        summary: core.eventSummary(tiers, ev, now),
        tiers: tiers.map(t => core.publicTier(t, ev, now)),
        hold_minutes: core.HOLD_MINUTES,
        server_now: now.toISOString()
    };
}

function publicEvent(ev) {
    const start = core.eventStart(ev);
    return {
        event_id: ev.event_id, title: ev.event_title, starts_at: start ? start.toISOString() : null,
        starts_label: start ? core.formatSast(start) : '', venue_name: ev.venue_name || '', venue_map_link: ev.venue_map_link || '',
        poster_image_path: ev.poster_image_path || ''
    };
}

// ---------------------------------------------------------------- reserve (the oversell guard)

// items: [{ ticket_type_id, quantity }]. Resolves { order, lines } or throws a Refusal:
//   400 with `errors` (bad selection, sales closed, over the limit) or 409 with `sold_out: [ticket_type_id...]` and fresh `tiers`.
async function reserve(eventId, items) {
    return inTransaction(async () => {
        const ev = await getEvent(eventId);
        if (!ev) throw new Refusal(404, 'Event not found.');
        await expireStaleInTxn(ev.event_id);
        const tiers = await listTiers(ev.event_id);
        const byId = new Map(tiers.map(t => [t.id, t]));
        const now = new Date();
        const { lines, errors } = core.validateReservation(items, byId, ev, now);
        if (errors.length) throw new Refusal(400, errors[0].message, { errors });

        const soldOut = [];
        for (const l of lines) {
            const r = await dbRun('UPDATE ticket_types SET reserved = reserved + ? WHERE id = ? AND sold + reserved + ? <= capacity', [l.quantity, l.ticket_type_id, l.quantity]);
            if (!r.changes) soldOut.push(l.ticket_type_id);
        }
        if (soldOut.length) {
            // Throwing rolls back the tiers that DID reserve, so nothing is held. The route re-reads the tiers for fresh counts.
            throw new Refusal(409, soldOut.length === lines.length && lines.length === 1 ? 'Sorry - those tickets have just sold out.' : 'Sorry - some of those tickets have just sold out.', { sold_out: soldOut, event_id: ev.event_id });
        }
        const t = now.toISOString();
        const reservedUntil = new Date(now.getTime() + core.HOLD_MINUTES * 60000).toISOString();
        const total = core.orderTotalCents(lines);
        let ins;
        for (let attempt = 0; ; attempt++) {
            try {
                ins = await dbRun('INSERT INTO ticket_orders (public_reference, event_id, total_cents, status, reserved_until, created_at) VALUES (?, ?, ?, \'pending\', ?, ?)',
                    [core.randomToken(), ev.event_id, total, reservedUntil, t]);
                break;
            } catch (e) { if (!/UNIQUE/.test(e.message) || attempt > 2) throw e; }   // a 144-bit collision is not going to happen, but never 500 on it
        }
        await dbRun('UPDATE ticket_orders SET m_payment_id = ? WHERE id = ?', [core.mPaymentIdFor(ins.lastID), ins.lastID]);
        for (const l of lines) {
            await dbRun('INSERT INTO ticket_order_items (order_id, ticket_type_id, quantity, unit_price_cents) VALUES (?, ?, ?, ?)', [ins.lastID, l.ticket_type_id, l.quantity, l.unit_price_cents]);
        }
        return { order: await getOrderById(ins.lastID), lines };
    });
}

// ---------------------------------------------------------------- orders

const getOrderById = async (id) => (await dbGet('SELECT * FROM ticket_orders WHERE id = ?', [id])) || null;
async function getOrderByReference(ref) {
    if (!core.isTokenShape(ref)) return null;
    return (await dbGet('SELECT * FROM ticket_orders WHERE public_reference = ?', [ref])) || null;
}
const orderItems = (orderId) => dbAll(
    `SELECT i.ticket_type_id, i.quantity, i.unit_price_cents, t.name
     FROM ticket_order_items i JOIN ticket_types t ON t.id = i.ticket_type_id WHERE i.order_id = ? ORDER BY t.sort_order, t.id`, [orderId]);
const orderTickets = (orderId) => dbAll(
    `SELECT k.id, k.token, k.holder_name, k.checked_in_at, k.voided_at, k.ticket_type_id, t.name AS tier_name
     FROM tickets k JOIN ticket_types t ON t.id = k.ticket_type_id WHERE k.order_id = ? ORDER BY k.id`, [orderId]);

// The buyer gives their details and consent; the hold must still be alive. Resolves the order ready for PayFast.
// The optional per-ticket names wait on the order (JSON) until tickets are issued, when they become tickets.holder_name.
async function startCheckout(ref, buyer, policyVersion) {
    const result = await inTransaction(async () => {
        const order = await getOrderByReference(ref);
        if (!order) throw new Refusal(404, 'We could not find that order.');
        if (order.status !== 'pending') throw new Refusal(409, order.status === 'paid' ? 'This order is already paid.' : 'This order is no longer open - please choose your tickets again.', { order_status: order.status });
        if (order.reserved_until <= nowIso()) {
            // Give the tickets back and COMMIT that - refusing by throwing here would roll the release back with it.
            await releaseHoldInTxn(order.id, 'expired');
            return { lapsed: true };
        }
        const t = nowIso();
        await dbRun(
            `UPDATE ticket_orders SET buyer_name = ?, buyer_email = ?, buyer_phone = ?, holder_names = ?, consent_at = ?, consent_policy_version = ?, checkout_started_at = ?
             WHERE id = ? AND status = 'pending'`,
            [buyer.buyer_name, buyer.buyer_email, buyer.buyer_phone, JSON.stringify(buyer.holder_names || []), t, policyVersion || null, t, order.id]);
        return { order: await getOrderById(order.id) };
    });
    if (result.lapsed) throw new Refusal(409, 'Your hold on these tickets ran out - please choose them again.', { order_status: 'expired' });
    return result.order;
}

// The buyer pressed "Release" (or closed the drawer and said so): give the tickets back now instead of waiting for the hold to run out.
async function releaseByBuyer(ref) {
    return inTransaction(async () => {
        const order = await getOrderByReference(ref);
        if (!order) throw new Refusal(404, 'We could not find that order.');
        const released = await releaseHoldInTxn(order.id, 'expired');
        return { released };
    });
}

module.exports = {
    Refusal, inTransaction, nowIso,
    getEvent, publicEvent,
    listTiers, getTier, createTier, updateTier, deleteTier, setEventSales, closeSalesForEvent, capacityWarning,
    eventDeletionCheck, deleteUnsoldTiersOfEvent,
    expireStaleInTxn, releaseHoldInTxn, expireStaleOrders,
    summariesForEvents, publicEventTickets,
    reserve, getOrderById, getOrderByReference, orderItems, orderTickets, startCheckout, releaseByBuyer
};
