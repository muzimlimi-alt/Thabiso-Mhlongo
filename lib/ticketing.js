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
// EVERY write here goes through inTransaction(), even a single statement: the app shares ONE connection, so a bare write that happens to
// run while another request's transaction is open is swept into it - and silently undone if that one rolls back (a door check-in would
// then show "Admitted" and be scannable again).
const { dbRun, dbGet, dbAll } = require('./db-helpers');
const { withDbTransaction } = require('./db-transaction');
const core = require('./ticketing-core');
const { decodeStoredText } = require('./html-sanitize');

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

// The event plus its event-level sales controls (ticket_event_sales: the pause / close switch and the optional sales window).
const EVENT_SELECT = `SELECT e.event_id, e.event_title, e.event_datetime, e.event_end_time, e.venue_name, e.venue_map_link, e.poster_image_path, e.event_status,
        e.event_capacity, e.booking_id, s.sales_control, s.opens_at AS sales_opens_at, s.closes_at AS sales_closes_at, s.changed_at AS sales_changed_at
    FROM events e LEFT JOIN ticket_event_sales s ON s.event_id = e.event_id`;

async function getEvent(eventId) {
    const id = Number(eventId);
    if (!Number.isInteger(id) || id < 1) return null;
    return (await dbGet(`${EVENT_SELECT} WHERE e.event_id = ?`, [id])) || null;
}

// ---------------------------------------------------------------- tiers (admin)

const listTiers = (eventId) => dbAll('SELECT * FROM ticket_types WHERE event_id = ? ORDER BY sort_order, price_cents, id', [eventId]);
const getTier = async (id) => (await dbGet('SELECT * FROM ticket_types WHERE id = ?', [id])) || null;

// The places given out across ALL of an event's categories may never exceed the event's own capacity (when it has one). Only an INCREASE is
// checked, so an event that was over-allocated before this rule existed can still be brought down. Runs inside the caller's transaction.
async function assertAllocationFits(ev, extraPlaces) {
    if (!ev || !ev.event_capacity || extraPlaces <= 0) return;
    const cur = (await dbGet('SELECT COALESCE(SUM(capacity), 0) AS n FROM ticket_types WHERE event_id = ?', [ev.event_id])).n;
    if (cur + extraPlaces > ev.event_capacity) {
        throw new Refusal(409, `That would give out ${cur + extraPlaces} tickets, but this event's capacity is ${ev.event_capacity} (${cur} are already allocated). Raise the event's capacity under Edit event, or take places from another category first.`,
            { code: 'over_event_capacity', allocated: cur, event_capacity: ev.event_capacity });
    }
}

const allocatedPlaces = async (eventId) => (await dbGet('SELECT COALESCE(SUM(capacity), 0) AS n FROM ticket_types WHERE event_id = ?', [eventId])).n;

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
        const ins = await inTransaction(async () => {
            await assertAllocationFits(ev, clean.capacity);
            // a new category goes to the end of the list unless the form said otherwise
            const sortOrder = clean.sort_order || ((await dbGet('SELECT COALESCE(MAX(sort_order), 0) AS n FROM ticket_types WHERE event_id = ?', [ev.event_id])).n + 10);
            return dbRun(
                `INSERT INTO ticket_types (event_id, name, description, price_cents, capacity, sales_start, sales_end, max_per_order, is_active, sort_order, created_by, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [ev.event_id, clean.name, clean.description, clean.price_cents, clean.capacity, clean.sales_start, clean.sales_end, clean.max_per_order,
                 clean.is_active, sortOrder, adminId || null, t, t]);
        });
        return getTier(ins.lastID);
    } catch (e) {
        if (/UNIQUE/.test(e.message)) throw new Refusal(409, `This event already has a ticket type called "${clean.name}".`);
        throw e;
    }
}

const tooLowMessage = (tier, committed) => `${tier.name} can't go below ${committed} places - ${tier.sold} are sold and ${tier.reserved} are held by buyers who are paying right now.`;

// Price changes only affect NEW orders (each order line keeps the price it was sold at). Capacity can never drop below what is
// already sold or held - inside a transaction so a sale cannot slip in between the check and the update.
async function updateTier(id, clean) {
    return inTransaction(async () => {
        const before = await getTier(id);
        if (!before) throw new Refusal(404, 'Ticket type not found.');
        const committed = before.sold + before.reserved;
        if (clean.capacity < committed) throw new Refusal(409, tooLowMessage(before, committed));
        await assertAllocationFits(await getEvent(before.event_id), clean.capacity - before.capacity);
        try {
            await dbRun(
                `UPDATE ticket_types SET name = ?, description = ?, price_cents = ?, capacity = ?, sales_start = ?, sales_end = ?, max_per_order = ?,
                        is_active = ?, sort_order = ?, updated_at = ? WHERE id = ?`,
                [clean.name, clean.description, clean.price_cents, clean.capacity, clean.sales_start, clean.sales_end, clean.max_per_order,
                 clean.is_active, clean.sort_order == null ? before.sort_order : clean.sort_order, nowIso(), id]);
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

// Raise or lower ONE category's total places without touching anything else ("add 50", "set to 150"). Never below sold + held, never past
// the event's capacity; the conditional UPDATE re-checks sold + reserved at the moment of writing, so a sale cannot slip in between.
async function setTierCapacity(id, input) {
    return inTransaction(async () => {
        const before = await getTier(id);
        if (!before) throw new Refusal(404, 'Ticket type not found.');
        const r = core.resolveCapacityChange(before.capacity, input);
        if (r.error) throw new Refusal(400, r.error);
        const committed = before.sold + before.reserved;
        if (r.capacity < committed) throw new Refusal(409, tooLowMessage(before, committed), { code: 'below_committed', committed });
        await assertAllocationFits(await getEvent(before.event_id), r.capacity - before.capacity);
        const w = await dbRun('UPDATE ticket_types SET capacity = ?, updated_at = ? WHERE id = ? AND sold + reserved <= ?', [r.capacity, nowIso(), id, r.capacity]);
        if (!w.changes) throw new Refusal(409, 'Tickets were just sold or reserved - reload and try again.');
        return { before, after: await getTier(id) };
    });
}

// Switch one category on or off for NEW buyers. Orders already made, and buyers already holding tickets, are not affected.
async function setTierEnabled(id, enabled) {
    return inTransaction(async () => {
        const before = await getTier(id);
        if (!before) throw new Refusal(404, 'Ticket type not found.');
        await dbRun('UPDATE ticket_types SET is_active = ?, updated_at = ? WHERE id = ?', [enabled ? 1 : 0, nowIso(), id]);
        return { before, after: await getTier(id) };
    });
}

// The order categories are listed in (Manage Tickets and the buyer's drawer). ids = every category of the event, once each, first to last.
async function reorderTiers(eventId, ids) {
    return inTransaction(async () => {
        const tiers = await listTiers(eventId);
        const want = Array.isArray(ids) ? ids.map(Number) : [];
        const have = tiers.map(t => t.id);
        if (want.length !== have.length || new Set(want).size !== want.length || !want.every(i => have.includes(i))) {
            throw new Refusal(400, 'The new order must list every ticket type of this event exactly once.');
        }
        const t = nowIso();
        for (let i = 0; i < want.length; i++) await dbRun('UPDATE ticket_types SET sort_order = ?, updated_at = ? WHERE id = ? AND event_id = ?', [(i + 1) * 10, t, want[i], eventId]);
        return { before: have, after: want };
    });
}

// Buyers who are in the middle of buying right now: holds that are still alive (and how many are already at PayFast).
async function liveHolds(eventId) {
    const r = await dbGet(
        `SELECT COUNT(*) AS orders, COALESCE(SUM(CASE WHEN checkout_started_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS at_checkout,
                COALESCE(SUM((SELECT COALESCE(SUM(quantity), 0) FROM ticket_order_items WHERE order_id = o.id)), 0) AS tickets
         FROM ticket_orders o WHERE o.event_id = ? AND o.status = 'pending' AND o.reserved_until > ?`, [eventId, nowIso()]);
    return { orders: r.orders, at_checkout: r.at_checkout, tickets: r.tickets };
}

const SALES_ACTIONS = Object.freeze(['open', 'pause', 'resume', 'close', 'reopen']);
const upsertSalesRow = (eventId, control, adminId) => dbRun(
    `INSERT INTO ticket_event_sales (event_id, sales_control, changed_by, changed_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(event_id) DO UPDATE SET sales_control = excluded.sales_control, changed_by = excluded.changed_by, changed_at = excluded.changed_at`,
    [eventId, control, adminId || null, nowIso()]);

// The event-level sales switch. open / resume / reopen start selling again (a show whose categories are ALL switched off gets them all
// switched on - what "Open sales" always did); pause / close stop NEW buyers only - holds already made can still be paid - and never touch
// the categories' own on/off switches, so a category the organiser had turned off stays off after a reopen.
async function setSalesState(eventId, action, adminId) {
    if (!SALES_ACTIONS.includes(action)) throw new Refusal(400, 'Unknown sales action.');
    const out = await inTransaction(async () => {
        const ev = await getEvent(eventId);
        if (!ev) throw new Refusal(404, 'Event not found.');
        const tiers = await listTiers(ev.event_id);
        const before = core.salesOverview(tiers, ev);
        if (action === 'pause' || action === 'close') {
            if (!tiers.length) throw new Refusal(409, 'Add a ticket type first.');
            if (action === 'pause' && ev.sales_control === 'paused') throw new Refusal(409, 'Ticket sales are already paused.');
            if (action === 'pause' && ev.sales_control === 'closed') throw new Refusal(409, 'Ticket sales are closed - reopen them before pausing.');
            if (action === 'close' && ev.sales_control === 'closed') throw new Refusal(409, 'Ticket sales are already closed.');
            await upsertSalesRow(ev.event_id, action === 'pause' ? 'paused' : 'closed', adminId);
            return { enabledAll: false };
        }
        if (core.eventBlockReason(ev)) throw new Refusal(409, 'This event can\'t sell tickets right now (it is cancelled, postponed, a draft, past, or has no date).');
        if (!tiers.length) throw new Refusal(409, 'Add a ticket type first.');
        if (action === 'resume' && ev.sales_control !== 'paused') throw new Refusal(409, 'Ticket sales are not paused.');
        if (action === 'reopen' && ev.sales_control !== 'closed' && before.state !== 'closed') throw new Refusal(409, 'Ticket sales are not closed.');
        await upsertSalesRow(ev.event_id, null, adminId);
        let enabledAll = false;
        if (!tiers.some(t => t.is_active)) {
            await dbRun('UPDATE ticket_types SET is_active = 1, updated_at = ? WHERE event_id = ?', [nowIso(), ev.event_id]);
            enabledAll = true;
        }
        return { enabledAll };
    });
    const ev = await getEvent(eventId);
    const tiers = await listTiers(eventId);
    return { ...out, overview: core.salesOverview(tiers, ev), holds: await liveHolds(eventId) };
}

// The event-wide sales window (blank = no limit). clean from core.validateSalesWindow().
async function setSalesWindow(eventId, clean, adminId) {
    return inTransaction(async () => {
        const before = await getEvent(eventId);
        if (!before) throw new Refusal(404, 'Event not found.');
        await dbRun(
            `INSERT INTO ticket_event_sales (event_id, opens_at, closes_at, changed_by, changed_at) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(event_id) DO UPDATE SET opens_at = excluded.opens_at, closes_at = excluded.closes_at, changed_by = excluded.changed_by, changed_at = excluded.changed_at`,
            [eventId, clean.opens_at, clean.closes_at, adminId || null, nowIso()]);
        return { before: { opens_at: before.sales_opens_at || null, closes_at: before.sales_closes_at || null }, after: clean };
    });
}

// "Mark as sold out" / "Remove the sold-out mark": the Events status itself (what the existing Events edit form also sets), so the public
// card says Sold Out and the event's Change History records who did it. This is the organiser's call - different from the automatic
// sold-out of every category being full, and from closing sales.
async function setSoldOutMark(eventId, mark, adminId, role) {
    return inTransaction(async () => {
        const ev = await getEvent(eventId);
        if (!ev) throw new Refusal(404, 'Event not found.');
        const from = mark ? ['upcoming', 'live'] : ['sold_out'];
        const status = String(ev.event_status || '').toLowerCase();
        if (!from.includes(status)) throw new Refusal(409, mark ? 'Only an upcoming or live show can be marked as sold out.' : 'This show is not marked as sold out.');
        const to = mark ? 'sold_out' : 'upcoming';
        const w = await dbRun('UPDATE events SET event_status = ?, modified_by = ?, modified_by_role = ?, modified_on = CURRENT_TIMESTAMP WHERE event_id = ? AND event_status = ?',
            [to, adminId || null, role || null, ev.event_id, ev.event_status]);
        if (!w.changes) throw new Refusal(409, 'The event was changed a moment ago - reload it.');
        return { from: ev.event_status, to };
    });
}

// How many live (paid or waiting) orders include this category - for "the price change applies to future buyers only".
const tierOrderCount = async (tierId) => (await dbGet(
    `SELECT COUNT(DISTINCT i.order_id) AS n FROM ticket_order_items i JOIN ticket_orders o ON o.id = i.order_id
     WHERE i.ticket_type_id = ? AND o.status IN ('paid', 'pending')`, [tierId])).n;

// The ticket-related audit trail of one event, newest first: category changes (audit_log rows of ticket_types carry the event id in their
// JSON, so deleted categories are still found) and the sales actions logged against the event.
async function eventHistory(eventId, limit = 100) {
    return dbAll(
        `SELECT l.id, l.table_name, l.record_id, l.action, l.old_values, l.new_values, l.reason, l.change_timestamp, a.username AS actor
         FROM audit_log l LEFT JOIN admins a ON CAST(a.id AS TEXT) = l.changed_by
         WHERE (l.table_name = 'ticket_types' AND CAST(json_extract(COALESCE(l.new_values, l.old_values), '$.event_id') AS INTEGER) = ?)
            OR (l.table_name = 'events' AND l.record_id = ? AND l.action LIKE 'TICKET%')
         ORDER BY l.id DESC LIMIT ?`, [eventId, eventId, Math.max(1, Math.min(300, limit))]);
}

// Called by routes/admin/events.js when an event is cancelled or postponed: sales stop; paid orders are reported, never auto-refunded.
async function closeSalesForEvent(eventId) {
    await inTransaction(() => dbRun('UPDATE ticket_types SET is_active = 0, updated_at = ? WHERE event_id = ? AND is_active = 1', [nowIso(), eventId]));
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
const deleteUnsoldTiersOfEvent = (eventId) => inTransaction(() => dbRun('DELETE FROM ticket_types WHERE event_id = ? AND sold = 0 AND reserved = 0 AND id NOT IN (SELECT ticket_type_id FROM ticket_order_items)', [eventId]));

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

// Every minute: one cheap read, and a write only when a hold has really lapsed (reads elsewhere release lapsed holds lazily as well).
// Not scheduled under NODE_ENV=test - tests drive expiry directly.
function registerTicketHoldExpiryJob() {
    if (process.env.NODE_ENV === 'test') return;
    const tick = async () => {
        try {
            const due = await dbGet("SELECT COUNT(*) AS n FROM ticket_orders WHERE status = 'pending' AND reserved_until < ?", [nowIso()]);
            if (!due || !due.n) return;
            const n = await expireStaleOrders();
            if (n) console.log(`[Ticketing] Released ${n} lapsed ticket hold(s).`);
        } catch (e) { console.error('[Ticketing] hold sweep failed:', e.message); throw e; }   // re-thrown so the monitor sees the failure; the callers below swallow it
    };
    const monitoredTick = require('./job-monitor').monitored('ticket-hold-expiry', 'Ticket hold expiry', 60 * 1000, tick);
    setTimeout(() => { monitoredTick().catch(() => {}); setInterval(() => monitoredTick().catch(() => {}), 60 * 1000); }, 30 * 1000);
}

// ---------------------------------------------------------------- public: what is on sale

// What the public Events section shows per event: { [event_id]: summary } (see core.eventSummary). Lazily releases lapsed holds first
// so a "Sold Out" card is never caused by an abandoned basket.
async function summariesForEvents(events) {
    const ids = (events || []).map(e => e.event_id).filter(Number.isInteger);
    if (!ids.length) return {};
    const lapsed = await dbGet(`SELECT COUNT(*) AS n FROM ticket_orders WHERE status = 'pending' AND reserved_until < ?`, [nowIso()]);
    if (lapsed && lapsed.n) await expireStaleOrders().catch(e => console.error('[Ticketing] lazy expiry failed:', e.message));
    const marks = ids.map(() => '?').join(',');
    const tiers = await dbAll(`SELECT * FROM ticket_types WHERE event_id IN (${marks})`, ids);
    const controls = new Map((await dbAll(`SELECT event_id, sales_control, opens_at AS sales_opens_at, closes_at AS sales_closes_at FROM ticket_event_sales WHERE event_id IN (${marks})`, ids)).map(r => [r.event_id, r]));
    const byEvent = new Map();
    for (const t of tiers) { if (!byEvent.has(t.event_id)) byEvent.set(t.event_id, []); byEvent.get(t.event_id).push(t); }
    const out = {};
    const now = new Date();
    for (const row of events) {
        const ev = controls.has(row.event_id) ? { ...row, ...controls.get(row.event_id) } : row;
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
        terms: core.TICKET_TERMS,
        server_now: now.toISOString()
    };
}

// Events text is stored entity-encoded (app.js deepEscapeBody); the public ticketing API sends it as plain text and the page escapes it.
function publicEvent(ev) {
    const start = core.eventStart(ev);
    return {
        event_id: ev.event_id, title: decodeStoredText(ev.event_title || ''), starts_at: start ? start.toISOString() : null,
        starts_label: start ? core.formatSast(start) : '', venue_name: decodeStoredText(ev.venue_name || ''), venue_map_link: ev.venue_map_link || '',
        poster_image_path: ev.poster_image_path || ''
    };
}

// ---------------------------------------------------------------- reserve (the oversell guard)

// items: [{ ticket_type_id, quantity }]. Resolves { order, lines } or throws a Refusal:
//   400 with `errors` (bad selection, sales closed, over the limit) or 409 with `sold_out: [ticket_type_id...]` and fresh `tiers`.
// holdKey (optional): the buyer's browser key. One live hold per browser per show: an earlier hold from the same browser for this show is
// given back first - in this same transaction, so if the new reservation is refused (sold out) the rollback restores the earlier hold.
// A hold whose buyer already went to PayFast (checkout_started_at) is never touched.
async function reserve(eventId, items, holdKey) {
    const key = core.isHoldKey(holdKey) ? holdKey : null;
    return inTransaction(async () => {
        const ev = await getEvent(eventId);
        if (!ev) throw new Refusal(404, 'Event not found.');
        await expireStaleInTxn(ev.event_id);
        if (key) {
            const earlier = await dbAll("SELECT id FROM ticket_orders WHERE hold_key = ? AND event_id = ? AND status = 'pending' AND checkout_started_at IS NULL", [key, ev.event_id]);
            for (const o of earlier) await releaseHoldInTxn(o.id, 'expired');
        }
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
                ins = await dbRun('INSERT INTO ticket_orders (public_reference, event_id, total_cents, status, reserved_until, created_at, hold_key) VALUES (?, ?, ?, \'pending\', ?, ?, ?)',
                    [core.randomToken(), ev.event_id, total, reservedUntil, t, key]);
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
async function startCheckout(ref, buyer, policyVersion, termsVersion) {
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
            `UPDATE ticket_orders SET buyer_name = ?, buyer_email = ?, buyer_phone = ?, holder_names = ?, consent_at = ?, consent_policy_version = ?, terms_version = ?, checkout_started_at = ?
             WHERE id = ? AND status = 'pending'`,
            [buyer.buyer_name, buyer.buyer_email, buyer.buyer_phone, JSON.stringify(buyer.holder_names || []), t, policyVersion || null, termsVersion || null, t, order.id]);
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

// ---------------------------------------------------------------- the door

const TICKET_JOIN = `SELECT k.id, k.token, k.holder_name, k.checked_in_at, k.checked_in_by, k.checked_in_via, k.voided_at, k.order_id, k.ticket_type_id, t.name AS tier_name,
        o.status AS order_status, o.refund_required, o.buyer_name, o.event_id, e.event_title, e.event_datetime, e.venue_name, a.username AS checked_in_by_name
    FROM tickets k JOIN ticket_types t ON t.id = k.ticket_type_id JOIN ticket_orders o ON o.id = k.order_id
    JOIN events e ON e.event_id = o.event_id LEFT JOIN admins a ON a.id = k.checked_in_by`;

async function ticketByToken(token) {
    if (!core.isTokenShape(token)) return null;
    return (await dbGet(`${TICKET_JOIN} WHERE k.token = ?`, [token])) || null;
}

// The one atomic check-in: a single conditional UPDATE, so of two phones scanning the same ticket at the same instant exactly one admits.
// result: 'admitted' | 'already' (checked in before - when, by whom) | 'void' (refunded / not paid) | 'invalid' (no such ticket).
// via: the door link's label when a volunteer checked it in without a portal account (adminId is then null).
async function checkIn(token, adminId, via) {
    if (!core.isTokenShape(token)) return { result: 'invalid' };
    const r = await inTransaction(() => dbRun(
        `UPDATE tickets SET checked_in_at = ?, checked_in_by = ?, checked_in_via = ?
         WHERE token = ? AND checked_in_at IS NULL AND voided_at IS NULL AND order_id IN (SELECT id FROM ticket_orders WHERE status = 'paid')`,
        [nowIso(), adminId || null, via || null, token]));
    const ticket = await ticketByToken(token);
    if (!ticket) return { result: 'invalid' };
    // Notification Centre: admissions go to the Activity Log; a second scan of a used ticket, or a cancelled ticket at the door, is grouped per show.
    const ntf = require('./notify');
    const base = { eventId: ticket.event_id, eventTitle: ticket.event_title, ticketId: ticket.id, via: via || (adminId ? 'admin scanner' : null) };
    const ctx = adminId ? { actor: { type: 'admin', id: String(adminId), label: null } } : { actorType: 'system', actorLabel: via || null };
    if (r.changes === 1) { ntf.emit('events.checkin', base, ctx); return { result: 'admitted', ticket }; }
    if (ticket.voided_at || ticket.order_status !== 'paid') { ntf.emit('events.checkin_void', base, ctx); return { result: 'void', ticket }; }
    ntf.emit('events.checkin_duplicate', base, ctx);
    return { result: 'already', ticket };
}

// A mistaken admission (wrong ticket scanned, a tap on the wrong row): the check-in is taken back so the ticket works again. Resolves the
// ticket as it was BEFORE (for the audit trail: when and by whom it had been checked in). Only a checked-in, valid ticket qualifies.
async function undoCheckIn(token) {
    if (!core.isTokenShape(token)) throw new Refusal(404, 'Invalid ticket.');
    return inTransaction(async () => {
        const before = await ticketByToken(token);
        if (!before) throw new Refusal(404, 'Invalid ticket.');
        if (!before.checked_in_at) throw new Refusal(409, 'This ticket is not checked in.');
        const r = await dbRun('UPDATE tickets SET checked_in_at = NULL, checked_in_by = NULL, checked_in_via = NULL WHERE token = ? AND checked_in_at IS NOT NULL', [token]);
        if (!r.changes) throw new Refusal(409, 'This ticket changed a moment ago - reload it.');
        return before;
    });
}

// Every order of an event for the reconciliation CSV - one row per order, with PayFast's payment id to tick off against the PayFast dashboard.
const ordersForExport = (eventId) => dbAll(
    `SELECT o.id, o.created_at, o.status, o.refund_required, o.buyer_name, o.buyer_email, o.buyer_phone, o.total_cents, o.gateway_payment_id,
            o.paid_at, o.refunded_at, o.refund_note, (SELECT COALESCE(SUM(quantity), 0) FROM ticket_order_items WHERE order_id = o.id) AS ticket_count
     FROM ticket_orders o WHERE o.event_id = ? AND (o.checkout_started_at IS NOT NULL OR o.status IN ('paid', 'refunded')) ORDER BY o.id`, [eventId]);

// The door counter for one event: valid tickets (paid, not voided) and how many of them are in.
async function doorCounts(eventId) {
    const row = await dbGet(
        `SELECT COUNT(*) AS valid, COALESCE(SUM(CASE WHEN k.checked_in_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS checked_in
         FROM tickets k JOIN ticket_orders o ON o.id = k.order_id WHERE o.event_id = ? AND o.status = 'paid' AND k.voided_at IS NULL`, [eventId]);
    return { valid: row.valid, checked_in: row.checked_in };
}

// The manual door search (a phone that will not scan): this event's valid tickets by holder / buyer name, e-mail or order number.
// opts.byEmail false: a door link (no portal account) may find tickets by name or order number but never test whether an e-mail bought one.
// Door search within one show: holder / buyer name, order number, ticket number ("1042-2" = that order's 2nd ticket), ticket code - and,
// for signed-in staff only (byEmail), the buyer's e-mail or phone. A door link (byEmail:false) never searches by contact details.
async function searchTickets(eventId, q, opts = {}) {
    const s = core.parseSearch(q);
    if (s.text.length < 2) return [];
    const byContact = opts.byEmail !== false;
    const ors = ["LOWER(COALESCE(k.holder_name, '')) LIKE ? ESCAPE '\\'", "LOWER(COALESCE(o.buyer_name, '')) LIKE ? ESCAPE '\\'", 'o.id = ?', 'k.token = ?'];
    const params = [eventId, s.like, s.like, s.orderNo, s.token || ''];
    if (byContact) { ors.push("LOWER(COALESCE(o.buyer_email, '')) LIKE ? ESCAPE '\\'"); params.push(s.like); }
    if (byContact && s.phone) { ors.push(`${core.NATIONAL_PHONE_SQL('o.buyer_phone')} LIKE ?`); params.push(`%${s.phone}%`); }
    const rows = await dbAll(`${TICKET_JOIN} WHERE o.event_id = ? AND o.status = 'paid' AND k.voided_at IS NULL AND (${ors.join(' OR ')})
        ORDER BY k.holder_name, k.id LIMIT 25`, params);
    if (s.ticketIndex === null) return rows;
    // "1042-2": the order's tickets are numbered 1..n in the order they were issued (as on the PDF)
    const all = await dbAll('SELECT id FROM tickets WHERE order_id = ? AND voided_at IS NULL ORDER BY id', [s.orderNo]);   // as the PDF numbers them
    const wanted = all[s.ticketIndex - 1];
    return wanted ? rows.filter(r => r.id === wanted.id) : [];
}

// ---------------------------------------------------------------- the office: orders, refunds, figures

// Search by name / e-mail / order number / the start of the reference; filter by status ('refund_required' = paid but owed back).
async function listOrders({ eventId, status, q, page = 1, pageSize = 25 } = {}) {
    const where = [];
    const params = [];
    if (eventId) { where.push('o.event_id = ?'); params.push(Number(eventId)); }
    if (status === 'refund_required') where.push("o.status = 'paid' AND o.refund_required = 1");
    else if (core.ORDER_STATUSES.includes(status)) { where.push('o.status = ?'); params.push(status); }
    const s = core.parseSearch(q);
    if (s.text) {
        // name / e-mail, order number (also from a ticket number "1042-2"), the start of the reference, a ticket code, a phone number
        const ors = ["LOWER(COALESCE(o.buyer_name, '')) LIKE ? ESCAPE '\\'", "LOWER(COALESCE(o.buyer_email, '')) LIKE ? ESCAPE '\\'", 'o.id = ?',
            "o.public_reference LIKE ? ESCAPE '\\'", 'o.id IN (SELECT order_id FROM tickets WHERE token = ?)'];
        params.push(s.like, s.like, s.orderNo, `${core.oneLine(q).replace(/[%_\\]/g, (c) => '\\' + c)}%`, s.token || '');
        if (s.phone) { ors.push(`${core.NATIONAL_PHONE_SQL('o.buyer_phone')} LIKE ?`); params.push(`%${s.phone}%`); }
        where.push(`(${ors.join(' OR ')})`);
    }
    const sqlWhere = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const size = Math.max(1, Math.min(100, parseInt(pageSize, 10) || 25));
    const total = (await dbGet(`SELECT COUNT(*) AS n FROM ticket_orders o ${sqlWhere}`, params)).n;
    const pages = Math.max(1, Math.ceil(total / size));
    const p = Math.max(1, Math.min(pages, parseInt(page, 10) || 1));
    const items = await dbAll(
        `SELECT o.id, o.public_reference, o.event_id, e.event_title, o.buyer_name, o.buyer_email, o.total_cents, o.status, o.refund_required, o.complimentary,
                o.created_at, o.paid_at, o.refunded_at, o.tickets_emailed_at,
                (SELECT COALESCE(SUM(quantity), 0) FROM ticket_order_items WHERE order_id = o.id) AS ticket_count
         FROM ticket_orders o JOIN events e ON e.event_id = o.event_id ${sqlWhere}
         ORDER BY o.id DESC LIMIT ? OFFSET ?`, [...params, size, (p - 1) * size]);
    return { items, total, page: p, pages };
}

// One order for the admin drawer: its lines, its tickets (with check-in), and its PayFast notifications (never the raw payload).
async function orderDetail(orderId) {
    const order = await getOrderById(orderId);
    if (!order) return null;
    const ev = await getEvent(order.event_id);
    const tickets = await dbAll(`${TICKET_JOIN} WHERE k.order_id = ? ORDER BY k.id`, [order.id]);
    const notifications = await dbAll('SELECT id, gateway_payment_id, payment_status, amount_cents, source, verified, outcome, received_at FROM ticket_webhook_events WHERE order_id = ? ORDER BY id', [order.id]);
    const refunder = order.refunded_by ? await dbGet('SELECT username FROM admins WHERE id = ?', [order.refunded_by]) : null;
    return { order: { ...order, refunded_by_name: refunder ? refunder.username : null }, event: ev ? publicEvent(ev) : null, items: await orderItems(order.id), tickets, notifications };
}

// The refund itself happens in the PayFast dashboard; this RECORDS it: the order becomes refunded, its tickets stop working at the door and
// their places go back on sale. An order that was flagged refund_required never took any stock, so only its status changes.
async function refundOrder(orderId, adminId, note) {
    return inTransaction(async () => {
        const before = await getOrderById(orderId);
        if (!before) throw new Refusal(404, 'Order not found.');
        if (before.status !== 'paid') throw new Refusal(409, 'Only a paid order can be marked as refunded.');
        const t = nowIso();
        let checkedIn = 0;
        if (!before.refund_required) {
            const items = await dbAll('SELECT ticket_type_id, quantity FROM ticket_order_items WHERE order_id = ?', [before.id]);
            for (const it of items) {
                const r = await dbRun('UPDATE ticket_types SET sold = sold - ? WHERE id = ? AND sold >= ?', [it.quantity, it.ticket_type_id, it.quantity]);
                if (!r.changes) throw new Error(`ticketing: sold count broken for order ${before.id} tier ${it.ticket_type_id}`);
            }
            checkedIn = (await dbGet('SELECT COUNT(*) AS n FROM tickets WHERE order_id = ? AND checked_in_at IS NOT NULL', [before.id])).n;
            await dbRun('UPDATE tickets SET voided_at = ? WHERE order_id = ? AND voided_at IS NULL', [t, before.id]);
        }
        const flip = await dbRun("UPDATE ticket_orders SET status = 'refunded', refunded_at = ?, refunded_by = ?, refund_note = ? WHERE id = ? AND status = 'paid'",
            [t, adminId || null, note || null, before.id]);
        if (!flip.changes) throw new Refusal(409, 'This order was changed a moment ago - reload it.');
        return { before, after: await getOrderById(before.id), checkedIn };
    });
}

// The Ticket Sales tiles: revenue (paid, not owed back), what was refunded, sold / held / checked in per tier.
async function eventStats(eventId) {
    const tiers = await dbAll(
        `SELECT t.id, t.name, t.price_cents, t.capacity, t.sold, t.reserved, t.is_active, t.sort_order,
                (SELECT COUNT(*) FROM tickets k JOIN ticket_orders o ON o.id = k.order_id
                 WHERE k.ticket_type_id = t.id AND k.checked_in_at IS NOT NULL AND k.voided_at IS NULL AND o.status = 'paid') AS checked_in
         FROM ticket_types t WHERE t.event_id = ? ORDER BY t.sort_order, t.price_cents, t.id`, [eventId]);
    const money = await dbGet(
        `SELECT COALESCE(SUM(CASE WHEN status = 'paid' AND refund_required = 0 THEN total_cents END), 0) AS revenue_cents,
                COALESCE(SUM(CASE WHEN status = 'refunded' THEN total_cents END), 0) AS refunded_cents,
                COALESCE(SUM(CASE WHEN status = 'paid' AND refund_required = 1 THEN total_cents END), 0) AS refund_due_cents,
                SUM(CASE WHEN status = 'paid' THEN 1 ELSE 0 END) AS paid_orders,
                SUM(CASE WHEN status = 'paid' AND refund_required = 1 THEN 1 ELSE 0 END) AS refund_due_orders,
                SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending_orders,
                -- gross = everything PayFast confirmed (paid, later refunded, or owed back); complimentary orders are R0 so they add nothing
                COALESCE(SUM(CASE WHEN status IN ('paid', 'refunded') THEN total_cents END), 0) AS gross_cents,
                -- pending = buyers who have gone on to pay and PayFast has not confirmed yet; failed = PayFast said the payment failed
                COALESCE(SUM(CASE WHEN status = 'pending' AND checkout_started_at IS NOT NULL AND reserved_until > ? THEN total_cents END), 0) AS pending_cents,
                SUM(CASE WHEN status = 'pending' AND checkout_started_at IS NOT NULL AND reserved_until > ? THEN 1 ELSE 0 END) AS pending_payment_orders,
                COALESCE(SUM(CASE WHEN status = 'failed' THEN total_cents END), 0) AS failed_cents,
                SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_orders,
                SUM(CASE WHEN status = 'refunded' THEN 1 ELSE 0 END) AS refunded_orders
         FROM ticket_orders WHERE event_id = ?`, [nowIso(), nowIso(), eventId]);
    // complimentary tickets (lib/ticketing-issue.js) take seats but are never revenue - shown apart
    const comps = await dbGet(`SELECT COALESCE(SUM(i.quantity), 0) AS n FROM ticket_order_items i JOIN ticket_orders o ON o.id = i.order_id
        WHERE o.event_id = ? AND o.status = 'paid' AND o.complimentary = 1`, [eventId]);
    // net = gross - refunded - owed back = revenue_cents (the same figure two ways; the tests hold them equal)
    money.net_cents = money.gross_cents - money.refunded_cents - money.refund_due_cents;
    const allocated = tiers.reduce((n, t) => n + t.capacity, 0), sold = tiers.reduce((n, t) => n + t.sold, 0), held = tiers.reduce((n, t) => n + t.reserved, 0);
    const totals = { allocated, sold, reserved: held, available: Math.max(0, allocated - sold - held), committed_pct: allocated ? Math.round(100 * (sold + held) / allocated) : 0 };
    return { tiers, ...money, comp_tickets: comps.n, totals, door: await doorCounts(eventId) };
}

// Every valid admission of an event, for the attendee CSV.
const attendees = (eventId) => dbAll(
    `SELECT k.id AS ticket_id, o.id AS order_id, t.name AS tier, k.holder_name, o.buyer_name, o.buyer_email, o.buyer_phone, o.paid_at, k.checked_in_at
     FROM tickets k JOIN ticket_orders o ON o.id = k.order_id JOIN ticket_types t ON t.id = k.ticket_type_id
     WHERE o.event_id = ? AND o.status = 'paid' AND k.voided_at IS NULL ORDER BY t.sort_order, t.id, k.holder_name, k.id`, [eventId]);

// ---------------------------------------------------------------- a show cancelled / postponed: telling the ticket holders

// Paid orders (with tickets) of an event and how many of their buyers were already told about the change.
async function eventNoticeCounts(eventId) {
    const r = await dbGet(`SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN event_notice_sent_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS sent
        FROM ticket_orders WHERE event_id = ? AND status = 'paid' AND refund_required = 0 AND buyer_email IS NOT NULL`, [eventId]);
    return { total: r.total, sent: r.sent };
}
// Orders whose buyer has not been told yet.
const eventNoticePending = (eventId) => dbAll(`SELECT id FROM ticket_orders WHERE event_id = ? AND status = 'paid' AND refund_required = 0
    AND buyer_email IS NOT NULL AND event_notice_sent_at IS NULL ORDER BY id`, [eventId]);
// Claims one order for the notice BEFORE its e-mail is queued - of two clicks (or two admins) only one gets each order. true = claimed.
const claimEventNotice = async (orderId) => (await inTransaction(() => dbRun(
    'UPDATE ticket_orders SET event_notice_sent_at = ? WHERE id = ? AND event_notice_sent_at IS NULL', [nowIso(), orderId]))).changes === 1;
// The e-mail could not be queued: let the next click try that buyer again.
const unclaimEventNotice = (orderId) => inTransaction(() => dbRun('UPDATE ticket_orders SET event_notice_sent_at = NULL WHERE id = ?', [orderId]));

// Events that have ticket types, for the Ticket Sales tab's picker (newest first).
const ticketedEvents = () => dbAll(
    `SELECT e.event_id, e.event_title, e.event_datetime, e.event_status,
            (SELECT COALESCE(SUM(sold), 0) FROM ticket_types WHERE event_id = e.event_id) AS sold,
            (SELECT COALESCE(SUM(reserved), 0) FROM ticket_types WHERE event_id = e.event_id) AS reserved,
            (SELECT COALESCE(SUM(capacity), 0) FROM ticket_types WHERE event_id = e.event_id) AS allocated,
            (SELECT sales_control FROM ticket_event_sales WHERE event_id = e.event_id) AS sales_control
     FROM events e WHERE EXISTS (SELECT 1 FROM ticket_types t WHERE t.event_id = e.event_id) ORDER BY e.event_datetime DESC`);

module.exports = {
    Refusal, inTransaction, nowIso,
    ticketByToken, checkIn, undoCheckIn, ordersForExport, doorCounts, searchTickets,
    listOrders, orderDetail, refundOrder, eventStats, attendees, ticketedEvents,
    eventNoticeCounts, eventNoticePending, claimEventNotice, unclaimEventNotice,
    getEvent, publicEvent,
    listTiers, getTier, createTier, updateTier, deleteTier, closeSalesForEvent, capacityWarning,
    allocatedPlaces, setTierCapacity, setTierEnabled, reorderTiers, setSalesState, setSalesWindow, setSoldOutMark, liveHolds, tierOrderCount, eventHistory, SALES_ACTIONS,
    eventDeletionCheck, deleteUnsoldTiersOfEvent,
    expireStaleInTxn, releaseHoldInTxn, expireStaleOrders, registerTicketHoldExpiryJob,
    summariesForEvents, publicEventTickets,
    reserve, getOrderById, getOrderByReference, orderItems, orderTickets, startCheckout, releaseByBuyer
};
