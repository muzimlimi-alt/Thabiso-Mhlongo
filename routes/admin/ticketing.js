// Event ticketing - admin API (docs-internal/ticketing.md). Part of the Events area of the portal.
//   ticket types (tiers), capacity, order, sales pause/close/window, sold-out mark : administrators and managers
//   orders, refunds, resend, attendee CSV     : administrators and managers
//   door check-in + door counts               : every admin role (assistants work the door)
// The server decides every permission; the page only hides what a role can't use.
const express = require('express');
const { requireAdmin } = require('../../middleware/auth');
const { requireRole } = require('../../middleware/rbac');
const { exportRateLimiter } = require('../../middleware/rate-limiters');
const { logAudit } = require('../../lib/audit-log');
const ntf = require('../../lib/notify');   // Notification Centre (docs-internal/notifications.md)
const core = require('../../lib/ticketing-core');
const ticketing = require('../../lib/ticketing');
const delivery = require('../../lib/ticketing-delivery');
const door = require('../../lib/ticketing-door');
const issue = require('../../lib/ticketing-issue');
const ticketFinance = require('../../lib/ticket-finance');
const { emailBaseUrl } = require('../../lib/email-context');
const router = express.Router();

const MANAGE = requireRole(['administrator', 'manager']);
const fail = (res, e, label) => {
    if (e && e.refusal) return res.status(e.status).json({ success: false, message: e.message, sold_out: e.sold_out, errors: e.errors });
    console.error(`[Ticketing admin] ${label}:`, e && e.message);
    return res.status(500).json({ success: false, message: 'Something went wrong. Please try again.' });
};
const idParam = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };

// A tier as the admin editor needs it: the counts, and its sale times as Johannesburg datetime-local values.
function adminTier(t, ev) {
    return {
        ...t, is_active: !!t.is_active, remaining: core.remainingOf(t), state: core.tierState(t, ev),
        sales_start_local: core.isoToLocalInput(t.sales_start), sales_end_local: core.isoToLocalInput(t.sales_end),
        price: core.centsToAmountString(t.price_cents)
    };
}

// What changed on a category, in words, for the audit log's reason column ("price R 150.00 -> R 175.00; places 100 -> 150").
function describeTierChange(b, a) {
    const out = [];
    if (b.name !== a.name) out.push(`name "${b.name}" -> "${a.name}"`);
    if (b.price_cents !== a.price_cents) out.push(`price ${core.formatZar(b.price_cents)} -> ${core.formatZar(a.price_cents)}`);
    if (b.capacity !== a.capacity) out.push(`places ${b.capacity} -> ${a.capacity}`);
    if (b.max_per_order !== a.max_per_order) out.push(`max per order ${b.max_per_order} -> ${a.max_per_order}`);
    if (!!b.is_active !== !!a.is_active) out.push(a.is_active ? 'switched on' : 'switched off');
    if ((b.sales_start || '') !== (a.sales_start || '') || (b.sales_end || '') !== (a.sales_end || '')) out.push('sale dates changed');
    if ((b.description || '') !== (a.description || '')) out.push('description changed');
    return out.length ? `${a.name}: ${out.join('; ')}` : null;
}

// ---------------------------------------------------------------- an event's tickets (the Manage Tickets screen and the event drawer's Tickets tab)

router.get('/api/admin/events/:id/ticketing', requireAdmin, async (req, res) => {
    try {
        const ev = await ticketing.getEvent(idParam(req.params.id));
        if (!ev) return res.status(404).json({ success: false, message: 'Event not found.' });
        const tiers = await ticketing.listTiers(ev.event_id);
        const block = core.eventBlockReason(ev);
        const totals = tiers.reduce((a, t) => ({ capacity: a.capacity + t.capacity, sold: a.sold + t.sold, reserved: a.reserved + t.reserved }), { capacity: 0, sold: 0, reserved: 0 });
        const overview = core.salesOverview(tiers, ev);
        res.json({
            success: true,
            event: {
                event_id: ev.event_id, title: ev.event_title, event_status: ev.event_status, event_capacity: ev.event_capacity, standalone: !ev.booking_id,
                starts_label: core.formatSast(core.eventStart(ev)), venue_name: ev.venue_name || ''
            },
            can_sell: !block, block_reason: block,
            // the switch-level view: nothing blocks the show, nobody paused/closed it, and at least one category is switched on
            sales_open: !block && !ev.sales_control && tiers.some(t => t.is_active),
            sales: {
                ...overview, control: ev.sales_control || null, can_pause: !block && !ev.sales_control && tiers.length > 0, can_close: tiers.length > 0 && ev.sales_control !== 'closed',
                opens_local: core.isoToLocalInput(ev.sales_opens_at), closes_local: core.isoToLocalInput(ev.sales_closes_at),
                opens_at: ev.sales_opens_at || null, closes_at: ev.sales_closes_at || null
            },
            holds: await ticketing.liveHolds(ev.event_id),
            tiers: tiers.map(t => adminTier(t, ev)), totals,
            capacity_warning: await ticketing.capacityWarning(ev.event_id),
            limits: { min_price_cents: core.MIN_PRICE_CENTS, max_per_order: core.MAX_PER_ORDER_LIMIT, hold_minutes: core.HOLD_MINUTES, max_capacity: core.MAX_CAPACITY }
        });
    } catch (e) { fail(res, e, 'event ticketing'); }
});

router.post('/api/admin/events/:id/ticket-types', requireAdmin, MANAGE, async (req, res) => {
    try {
        const { clean, errors } = core.validateTier(req.body);
        if (Object.keys(errors).length) return res.status(400).json({ success: false, message: Object.values(errors)[0], errors });
        const tier = await ticketing.createTier(idParam(req.params.id), clean, req.session.adminId);
        await logAudit({ tableName: 'ticket_types', recordId: tier.id, action: 'TICKET_TYPE_CREATED', req, newValues: tier });
        res.json({ success: true, tier, capacity_warning: await ticketing.capacityWarning(tier.event_id), message: `"${tier.name}" added.` });
    } catch (e) { fail(res, e, 'create tier'); }
});

router.put('/api/admin/ticket-types/:id', requireAdmin, MANAGE, async (req, res) => {
    try {
        const { clean, errors } = core.validateTier(req.body);
        if (Object.keys(errors).length) return res.status(400).json({ success: false, message: Object.values(errors)[0], errors });
        const { before, after } = await ticketing.updateTier(idParam(req.params.id), clean);
        await logAudit({ tableName: 'ticket_types', recordId: after.id, action: 'TICKET_TYPE_UPDATED', req, oldValues: before, newValues: after, reason: describeTierChange(before, after) });
        // a price change only reaches NEW buyers: every order already made keeps the price on its own line
        const kept = before.price_cents !== after.price_cents ? await ticketing.tierOrderCount(after.id) : 0;
        const note = kept ? ` The ${kept} existing order${kept === 1 ? '' : 's'} keep${kept === 1 ? 's' : ''} the old price (${core.formatZar(before.price_cents)}).` : '';
        res.json({ success: true, tier: after, capacity_warning: await ticketing.capacityWarning(after.event_id), existing_orders_keep_price: kept, message: `"${after.name}" saved.${note}` });
    } catch (e) { fail(res, e, 'update tier'); }
});

router.delete('/api/admin/ticket-types/:id', requireAdmin, MANAGE, async (req, res) => {
    try {
        const tier = await ticketing.deleteTier(idParam(req.params.id));
        await logAudit({ tableName: 'ticket_types', recordId: tier.id, action: 'TICKET_TYPE_DELETED', req, oldValues: tier });
        res.json({ success: true, message: `"${tier.name}" deleted.` });
    } catch (e) { fail(res, e, 'delete tier'); }
});

// A category's total places, on its own: { capacity: 150 } sets it, { add: 50 } / { add: -10 } adds or removes. Never below sold + held.
router.post('/api/admin/ticket-types/:id/capacity', requireAdmin, MANAGE, async (req, res) => {
    try {
        const { before, after } = await ticketing.setTierCapacity(idParam(req.params.id), req.body);
        await logAudit({ tableName: 'ticket_types', recordId: after.id, action: 'TICKET_CAPACITY_CHANGED', req, oldValues: before, newValues: after, reason: `${after.name}: places ${before.capacity} -> ${after.capacity}` });
        res.json({ success: true, tier: after, capacity_warning: await ticketing.capacityWarning(after.event_id), message: `${after.name} now has ${after.capacity} places (${core.remainingOf(after)} available).` });
    } catch (e) { fail(res, e, 'tier capacity'); }
});

// Switch one category on / off for new buyers: { enabled: true | false }.
router.post('/api/admin/ticket-types/:id/enabled', requireAdmin, MANAGE, async (req, res) => {
    try {
        const enabled = !!req.body && (req.body.enabled === true || req.body.enabled === 'true');
        const { before, after } = await ticketing.setTierEnabled(idParam(req.params.id), enabled);
        await logAudit({ tableName: 'ticket_types', recordId: after.id, action: enabled ? 'TICKET_TYPE_ENABLED' : 'TICKET_TYPE_DISABLED', req, oldValues: before, newValues: after, reason: `${after.name}: ${enabled ? 'switched on' : 'switched off'}` });
        res.json({ success: true, tier: after, message: enabled ? `"${after.name}" is on sale again.` : `"${after.name}" is switched off - new buyers can't see it. Orders already made are not affected.` });
    } catch (e) { fail(res, e, 'tier enabled'); }
});

// The order the categories are listed in: { order: [tier ids, first to last] }.
router.post('/api/admin/events/:id/ticket-types/reorder', requireAdmin, MANAGE, async (req, res) => {
    try {
        const eventId = idParam(req.params.id);
        const { before, after } = await ticketing.reorderTiers(eventId, req.body && req.body.order);
        await logAudit({ tableName: 'events', recordId: eventId, action: 'TICKET_TYPES_REORDERED', req, oldValues: { order: before }, newValues: { order: after }, reason: 'ticket types reordered' });
        res.json({ success: true, message: 'Order saved.' });
    } catch (e) { fail(res, e, 'reorder tiers'); }
});

// The event-level sales switch: { action: 'open' | 'pause' | 'resume' | 'close' | 'reopen' } (the older { open: true | false } still works).
const SALES_WORDS = {
    open: ['TICKET_SALES_OPENED', 'Ticket sales are open.'], resume: ['TICKET_SALES_RESUMED', 'Ticket sales have resumed.'], reopen: ['TICKET_SALES_REOPENED', 'Ticket sales are open again.'],
    pause: ['TICKET_SALES_PAUSED', 'Ticket sales are paused. Buyers already paying can finish.'], close: ['TICKET_SALES_CLOSED', 'Ticket sales are closed. Buyers already paying can finish.']
};
router.post('/api/admin/events/:id/ticket-sales', requireAdmin, MANAGE, async (req, res) => {
    try {
        const body = req.body || {};
        const action = typeof body.action === 'string' ? body.action : (body.open === true || body.open === 'true' ? 'open' : 'close');
        const eventId = idParam(req.params.id);
        const r = await ticketing.setSalesState(eventId, action, req.session.adminId);
        const [auditAction, text] = SALES_WORDS[action];
        await logAudit({ tableName: 'events', recordId: eventId, action: auditAction, req, newValues: { state: r.overview.state, categories_switched_on: r.enabledAll, buyers_paying_now: r.holds.orders }, reason: text });
        res.json({
            success: true, sales_open: r.overview.state === 'open' || r.overview.state === 'sold_out', overview: r.overview, holds: r.holds,
            message: text + (r.enabledAll ? ' Every ticket type was switched off, so they were all switched on.' : '') + (['ended', 'not_open'].includes(r.overview.state) ? ' The sales window you set still applies.' : '')
        });
    } catch (e) { fail(res, e, 'sales switch'); }
});

// The event-wide sales window (both optional): { opens_at, closes_at } as datetime-local values, South African time.
router.put('/api/admin/events/:id/ticket-sales-window', requireAdmin, MANAGE, async (req, res) => {
    try {
        const { clean, errors } = core.validateSalesWindow(req.body);
        if (Object.keys(errors).length) return res.status(400).json({ success: false, message: Object.values(errors)[0], errors });
        const eventId = idParam(req.params.id);
        const { before, after } = await ticketing.setSalesWindow(eventId, clean, req.session.adminId);
        await logAudit({ tableName: 'events', recordId: eventId, action: 'TICKET_SALES_WINDOW_CHANGED', req, oldValues: before, newValues: after, reason: 'sales window changed' });
        res.json({ success: true, message: after.opens_at || after.closes_at ? 'Sales window saved.' : 'Sales window cleared - sales follow the switch only.' });
    } catch (e) { fail(res, e, 'sales window'); }
});

// The organiser's own "Sold out" mark (the Events status) - distinct from closing sales and from the automatic sold-out: { mark: true | false }.
router.post('/api/admin/events/:id/sold-out', requireAdmin, MANAGE, async (req, res) => {
    try {
        const mark = !!req.body && (req.body.mark === true || req.body.mark === 'true');
        const eventId = idParam(req.params.id);
        const r = await ticketing.setSoldOutMark(eventId, mark, req.session.adminId, req.session.role);
        await logAudit({ tableName: 'events', recordId: eventId, action: mark ? 'TICKET_EVENT_MARKED_SOLD_OUT' : 'TICKET_EVENT_SOLD_OUT_CLEARED', req, oldValues: { event_status: r.from }, newValues: { event_status: r.to }, reason: mark ? 'marked as sold out' : 'sold-out mark removed' });
        res.json({ success: true, message: mark ? 'The show is marked as sold out. Nobody can buy until you remove the mark.' : 'The sold-out mark is removed.' });
    } catch (e) { fail(res, e, 'sold-out mark'); }
});

// Who changed what in this event's ticketing, newest first.
router.get('/api/admin/events/:id/ticketing-history', requireAdmin, MANAGE, async (req, res) => {
    try {
        const rows = await ticketing.eventHistory(idParam(req.params.id));
        res.json({ success: true, history: rows.map(r => ({ id: r.id, action: r.action, what: r.reason || r.action, who: r.actor || 'system', at: r.change_timestamp })) });
    } catch (e) { fail(res, e, 'ticketing history'); }
});

// ---------------------------------------------------------------- Events -> Ticket Sales (orders, refunds, figures)

const isAssistant = (req) => (req.session.role || 'assistant') === 'assistant';

router.get('/api/admin/ticketing/events', requireAdmin, async (req, res) => {
    try {
        const rows = await ticketing.ticketedEvents();
        res.json({ success: true, events: rows.map(e => ({ ...e, event_title: e.event_title, starts_label: core.formatSast(core.eventStart(e)) })) });
    } catch (e) { fail(res, e, 'ticketed events'); }
});

// Revenue is for the people who handle money; an assistant at the door sees sold / checked-in counts only.
router.get('/api/admin/ticketing/events/:id/stats', requireAdmin, async (req, res) => {
    try {
        const id = idParam(req.params.id);
        const ev = await ticketing.getEvent(id);
        if (!ev) return res.status(404).json({ success: false, message: 'Event not found.' });
        const s = await ticketing.eventStats(id);
        s.event_status = String(ev.event_status || '').toLowerCase();
        s.notice = await ticketing.eventNoticeCounts(id);
        if (isAssistant(req)) { for (const k of ['revenue_cents', 'refunded_cents', 'refund_due_cents', 'gross_cents', 'net_cents', 'pending_cents', 'failed_cents']) delete s[k]; s.tiers = s.tiers.map(({ price_cents, ...t }) => t); }
        res.json({ success: true, stats: s });
    } catch (e) { fail(res, e, 'stats'); }
});

router.get('/api/admin/ticketing/orders', requireAdmin, MANAGE, async (req, res) => {
    try {
        res.json({ success: true, ...(await ticketing.listOrders({ eventId: idParam(req.query.event_id), status: req.query.status, q: req.query.q, page: req.query.page, pageSize: req.query.page_size })) });
    } catch (e) { fail(res, e, 'orders'); }
});

router.get('/api/admin/ticketing/orders/:id', requireAdmin, MANAGE, async (req, res) => {
    try {
        const d = await ticketing.orderDetail(idParam(req.params.id));
        if (!d) return res.status(404).json({ success: false, message: 'Order not found.' });
        res.json({ success: true, ...d, issue: await issue.issueDetails(d.order.id) });
    } catch (e) { fail(res, e, 'order detail'); }
});

// ---------------------------------------------------------------- Finance: ticket sales as money (lib/ticket-finance.js - read-only)
router.get('/api/admin/ticketing/finance', requireAdmin, MANAGE, async (req, res) => {
    try { res.json({ success: true, ...(await ticketFinance.overview(req.query.date_from, req.query.date_to)) }); } catch (e) { fail(res, e, 'finance overview'); }
});
router.get('/api/admin/ticketing/finance/events/:id/orders', requireAdmin, MANAGE, async (req, res) => {
    try {
        const id = idParam(req.params.id);
        if (!id) return res.status(404).json({ success: false, message: 'Event not found.' });
        res.json({ success: true, orders: await ticketFinance.eventOrders(id) });
    } catch (e) { fail(res, e, 'finance event orders'); }
});
router.get('/api/admin/ticketing/finance/orders/:id', requireAdmin, MANAGE, async (req, res) => {
    try {
        const p = await ticketFinance.orderPayment(idParam(req.params.id));
        if (!p) return res.status(404).json({ success: false, message: 'Order not found.' });
        res.json({ success: true, payment: p });
    } catch (e) { fail(res, e, 'finance order'); }
});

router.post('/api/admin/ticketing/orders/:id/resend', requireAdmin, MANAGE, async (req, res) => {
    try {
        const order = await ticketing.getOrderById(idParam(req.params.id));
        if (!order) return res.status(404).json({ success: false, message: 'Order not found.' });
        if (order.status !== 'paid' || order.refund_required) return res.status(409).json({ success: false, message: 'Only a paid order with tickets can have them resent.' });
        const r = await delivery.deliverOrder(order.id, { resend: true });
        if (!r || !r.success) return res.status(502).json({ success: false, message: 'The e-mail could not be queued - check Email settings and try again.' });
        await logAudit({ tableName: 'ticket_orders', recordId: order.id, action: 'TICKETS_RESENT', req });
        res.json({ success: true, message: 'The tickets are on their way to the buyer again.' });
    } catch (e) { fail(res, e, 'resend'); }
});

// Records a refund made in the PayFast dashboard: tickets stop working at the door, places go back on sale.
router.post('/api/admin/ticketing/orders/:id/refund', requireAdmin, MANAGE, async (req, res) => {
    try {
        const note = core.oneLine((req.body && req.body.note) || '').slice(0, 300);
        const target = await ticketing.getOrderById(idParam(req.params.id));
        const comp = !!(target && target.complimentary);
        if (note.length < 3) return res.status(400).json({ success: false, message: comp ? 'Please say why these complimentary tickets are cancelled.' : 'Please note how it was refunded (for example "Refunded in PayFast on 30 Oct").' });
        const r = await ticketing.refundOrder(idParam(req.params.id), req.session.adminId, note);
        if (comp) {
            // complimentary tickets: nothing was paid, so no "refund made" e-mail - the seats just go back
            await logAudit({ tableName: 'ticket_orders', recordId: r.after.id, action: 'TICKETS_COMPLIMENTARY_CANCELLED', req, reason: note });
            return res.json({ success: true, mailed: false, message: 'Complimentary tickets cancelled - they no longer work at the door and the seats are free again.' });
        }
        await logAudit({ tableName: 'ticket_orders', recordId: r.after.id, action: 'TICKET_ORDER_REFUNDED', req,
            oldValues: { status: r.before.status, refund_required: r.before.refund_required }, newValues: { status: r.after.status }, reason: note });
        // Notification Centre: the refund is done, so the "ticket refund required" / "paid twice" alerts for this order close - resolved BY this admin.
        ntf.resolve('events.ticket_refund_required', r.after.id, { req, note: note });
        ntf.resolve('events.ticket_paid_twice', r.after.id, { req, note: note });
        ntf.resolve('events.ticket_payment_mismatch', r.after.id, { req, note: note });
        // The buyer is told the refund has been MADE (only now - never before it happened). notify: false skips it (e.g. already told by phone).
        let mailed = false;
        if (!(req.body && req.body.notify === false)) {
            const m = await delivery.notifyRefunded(r.after.id).catch(() => null);
            mailed = !!(m && m.success);
        }
        const tail = mailed ? ' The buyer has been e-mailed that the refund was made.' : '';
        res.json({ success: true, mailed, message: (r.checkedIn ? `Marked as refunded. Note: ${r.checkedIn} of its tickets had already been used at the door.` : 'Marked as refunded - its tickets no longer work and the places are back on sale.') + tail });
    } catch (e) { fail(res, e, 'refund'); }
});

// ── tickets issued outside a sale (lib/ticketing-issue.js): complimentary orders, void and reissue of one ticket ──
router.post('/api/admin/ticketing/events/:id/complimentary', requireAdmin, MANAGE, async (req, res) => {
    try {
        const r = await issue.issueComplimentary(idParam(req.params.id), req.body || {}, req.session.adminId);
        await logAudit({ tableName: 'ticket_orders', recordId: r.order.id, action: 'TICKETS_COMPLIMENTARY_ISSUED', req,
            newValues: { event_id: r.order.event_id, tickets: r.tickets.length, guest: r.order.buyer_name, note: r.order.comp_note } });
        let mailed = false;
        if (r.order.buyer_email && !(req.body && req.body.send_email === false)) {
            const m = await delivery.deliverOrder(r.order.id).catch(() => null);
            mailed = !!(m && m.success);
        }
        res.json({ success: true, order: { id: r.order.id, public_reference: r.order.public_reference }, tickets: r.tickets.length, mailed,
            message: `${r.tickets.length} complimentary ticket${r.tickets.length === 1 ? '' : 's'} issued to ${r.order.buyer_name}.` + (mailed ? ' They have been e-mailed.' : r.order.buyer_email ? '' : ' No e-mail address: open the order to print or share them.') });
    } catch (e) { fail(res, e, 'complimentary'); }
});

router.post('/api/admin/ticketing/tickets/:token/reissue', requireAdmin, MANAGE, async (req, res) => {
    try {
        res.set('Cache-Control', 'no-store');
        const body = req.body || {};
        const r = await issue.reissueTicket(String(req.params.token || ''), { reason: body.reason, holderName: body.holder_name }, req.session.adminId);
        await logAudit({ tableName: 'tickets', recordId: r.old.id, action: 'TICKET_REISSUED', req, oldValues: { ticket_id: r.old.id, holder: r.old.holder_name },
            newValues: { ticket_id: r.ticket.id, holder: r.ticket.holder_name }, reason: core.oneLine(body.reason).slice(0, 300) });
        let mailed = false;
        const order = await ticketing.getOrderById(r.ticket.order_id);
        if (order.buyer_email && body.send_email !== false) {
            const m = await delivery.deliverOrder(order.id, { resend: true }).catch(() => null);
            mailed = !!(m && m.success);
        }
        res.json({ success: true, mailed, ticket: doorView(r.ticket),
            message: 'The old code no longer works; a new ticket was issued.' + (mailed ? ' The buyer has been e-mailed the new ticket.' : '') });
    } catch (e) { fail(res, e, 'reissue'); }
});

// The show was cancelled or postponed (set in the Events editor): e-mail every paid order's buyer, once each. Cancelled -> "you will be
// refunded" (each refund is then made in PayFast and marked per order); postponed -> "your tickets stay valid".
router.post('/api/admin/ticketing/events/:id/notify-holders', requireAdmin, MANAGE, async (req, res) => {
    try {
        const ev = await ticketing.getEvent(idParam(req.params.id));
        if (!ev) return res.status(404).json({ success: false, message: 'Event not found.' });
        const kind = String(ev.event_status || '').toLowerCase();
        if (kind !== 'cancelled' && kind !== 'postponed') return res.status(409).json({ success: false, message: 'Only a cancelled or postponed show can be announced to its ticket holders - change the event\'s status first.' });
        let sent = 0, failed = 0;
        for (const o of await ticketing.eventNoticePending(ev.event_id)) {
            if (!(await ticketing.claimEventNotice(o.id))) continue;          // another click / admin is telling this buyer
            const r = await delivery.notifyEventChange(o.id, kind).catch(() => null);
            if (r && r.success) sent++; else { failed++; await ticketing.unclaimEventNotice(o.id).catch(() => {}); }
        }
        await logAudit({ tableName: 'events', recordId: ev.event_id, action: kind === 'cancelled' ? 'TICKET_HOLDERS_TOLD_CANCELLED' : 'TICKET_HOLDERS_TOLD_POSTPONED', req, newValues: { sent, failed } });
        const counts = await ticketing.eventNoticeCounts(ev.event_id);
        res.json({ success: true, sent, failed, notice: counts,
            message: (sent ? `${sent} ticket holder${sent === 1 ? '' : 's'} e-mailed.` : 'Everyone had already been told.') + (failed ? ` ${failed} could not be queued - try again.` : '') });
    } catch (e) { fail(res, e, 'notify holders'); }
});

// Reconciliation: every order that went to PayFast, with PayFast's payment id, status and refund - to tick off against the PayFast dashboard.
router.get('/api/admin/ticketing/events/:id/orders.csv', requireAdmin, MANAGE, exportRateLimiter, async (req, res) => {
    try {
        const ev = await ticketing.getEvent(idParam(req.params.id));
        if (!ev) return res.status(404).json({ success: false, message: 'Event not found.' });
        const rows = await ticketing.ordersForExport(ev.event_id);
        const status = (o) => (o.status === 'paid' && o.refund_required ? 'paid - refund needed' : o.status);
        const lines = [core.csvRow(['Order', 'Created (SAST)', 'Status', 'Buyer', 'Buyer email', 'Buyer phone', 'Tickets', 'Total (R)', 'PayFast payment id', 'Paid (SAST)', 'Refunded (SAST)', 'Refund note'])];
        for (const o of rows) {
            lines.push(core.csvRow([o.id, core.formatSast(o.created_at, 'YYYY-MM-DD HH:mm'), status(o), o.buyer_name, o.buyer_email, o.buyer_phone, o.ticket_count,
                core.centsToAmountString(o.total_cents), o.gateway_payment_id, o.paid_at ? core.formatSast(o.paid_at, 'YYYY-MM-DD HH:mm') : '',
                o.refunded_at ? core.formatSast(o.refunded_at, 'YYYY-MM-DD HH:mm') : '', o.refund_note]));
        }
        await logAudit({ tableName: 'events', recordId: ev.event_id, action: 'TICKET_ORDERS_EXPORTED', req, newValues: { rows: rows.length } });
        const slug = core.oneLine(ev.event_title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'event';
        res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="orders-${slug}-${ev.event_id}.csv"`, 'Cache-Control': 'no-store' });
        res.send('﻿' + lines.join('\r\n') + '\r\n');
    } catch (e) { fail(res, e, 'orders csv'); }
});

router.get('/api/admin/ticketing/events/:id/attendees.csv', requireAdmin, MANAGE, exportRateLimiter, async (req, res) => {
    try {
        const ev = await ticketing.getEvent(idParam(req.params.id));
        if (!ev) return res.status(404).json({ success: false, message: 'Event not found.' });
        const rows = await ticketing.attendees(ev.event_id);
        const lines = [core.csvRow(['Ticket', 'Order', 'Ticket type', 'Name on ticket', 'Buyer', 'Buyer email', 'Buyer phone', 'Paid (SAST)', 'Checked in (SAST)'])];
        for (const r of rows) {
            lines.push(core.csvRow([r.ticket_id, r.order_id, r.tier, r.holder_name || r.buyer_name, r.buyer_name, r.buyer_email, r.buyer_phone,
                core.formatSast(r.paid_at, 'YYYY-MM-DD HH:mm'), r.checked_in_at ? core.formatSast(r.checked_in_at, 'YYYY-MM-DD HH:mm') : '']));
        }
        await logAudit({ tableName: 'events', recordId: ev.event_id, action: 'TICKET_ATTENDEES_EXPORTED', req, newValues: { rows: rows.length } });
        const slug = core.oneLine(ev.event_title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'event';
        res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="attendees-${slug}-${ev.event_id}.csv"`, 'Cache-Control': 'no-store' });
        res.send('﻿' + lines.join('\r\n') + '\r\n');           // BOM so Excel opens UTF-8 names correctly
    } catch (e) { fail(res, e, 'attendees csv'); }
});

// ---------------------------------------------------------------- the door (every role)

// What a scanned ticket is - for the staff view on /t/<token> and the scanner page (lib/ticketing-door.js). A GET never checks anyone in.
const { doorView } = door;

// ── door links (administrators / managers): create, list, switch off ──
router.get('/api/admin/ticketing/events/:id/door-passes', requireAdmin, MANAGE, async (req, res) => {
    try { res.json({ success: true, passes: await door.listPasses(idParam(req.params.id)) }); }
    catch (e) { fail(res, e, 'door passes'); }
});

// The link (and a QR code of it, to open it on the volunteer's phone) is returned ONCE - only its hash is kept.
router.post('/api/admin/ticketing/events/:id/door-passes', requireAdmin, MANAGE, async (req, res) => {
    try {
        const { pass, secret } = await door.createPass(idParam(req.params.id), req.body && req.body.label, req.session.adminId);
        const link = `${emailBaseUrl()}/checkin?pass=${secret}`;
        await logAudit({ tableName: 'ticket_door_passes', recordId: pass.id, action: 'DOOR_LINK_CREATED', req, newValues: { event_id: pass.event_id, label: pass.label, expires_at: pass.expires_at } });
        res.json({ success: true, pass, link, qr: await delivery.qrDataUri(link) });
    } catch (e) { fail(res, e, 'create door pass'); }
});

router.delete('/api/admin/ticketing/events/:id/door-passes/:passId', requireAdmin, MANAGE, async (req, res) => {
    try {
        await door.revokePass(idParam(req.params.id), idParam(req.params.passId));
        await logAudit({ tableName: 'ticket_door_passes', recordId: idParam(req.params.passId), action: 'DOOR_LINK_SWITCHED_OFF', req });
        res.json({ success: true, message: 'Door link switched off - it stops working straight away.' });
    } catch (e) { fail(res, e, 'revoke door pass'); }
});

router.get('/api/admin/ticketing/tickets/:token', requireAdmin, async (req, res) => {
    try {
        res.set('Cache-Control', 'no-store');
        const t = await ticketing.ticketByToken(String(req.params.token || ''));
        if (!t) return res.status(404).json({ success: false, result: 'invalid', message: 'Invalid ticket.' });
        res.json({ success: true, ticket: doorView(t), counts: await ticketing.doorCounts(t.event_id) });
    } catch (e) { fail(res, e, 'ticket lookup'); }
});

router.post('/api/admin/ticketing/tickets/:token/check-in', requireAdmin, async (req, res) => {
    try {
        res.set('Cache-Control', 'no-store');
        const r = await ticketing.checkIn(String(req.params.token || ''), req.session.adminId);
        if (r.result === 'invalid') return res.status(404).json({ success: false, result: 'invalid', message: 'Invalid ticket.' });
        const view = doorView(r.ticket);
        if (r.result === 'admitted') {
            await logAudit({ tableName: 'tickets', recordId: r.ticket.id, action: 'TICKET_CHECKED_IN', req, newValues: { order_id: r.ticket.order_id } }).catch(() => {});
        }
        const message = r.result === 'admitted' ? 'Admitted' : r.result === 'already' ? `Already scanned at ${view.checked_in_label}` : 'This ticket is no longer valid';
        res.json({ success: r.result === 'admitted', result: r.result, message, ticket: view, counts: await ticketing.doorCounts(r.ticket.event_id) });
    } catch (e) { fail(res, e, 'check-in'); }
});

// Undo a mistaken check-in (administrators and managers, with a reason - kept in the audit log with when / who had checked it in).
router.post('/api/admin/ticketing/tickets/:token/undo-check-in', requireAdmin, MANAGE, async (req, res) => {
    try {
        const reason = core.oneLine((req.body && req.body.reason) || '').slice(0, 300);
        if (reason.length < 3) return res.status(400).json({ success: false, message: 'Please say why the check-in is being undone (a few words).' });
        const before = await ticketing.undoCheckIn(String(req.params.token || ''));
        await logAudit({ tableName: 'tickets', recordId: before.id, action: 'TICKET_CHECK_IN_UNDONE', req,
            oldValues: { checked_in_at: before.checked_in_at, checked_in_by: before.checked_in_by_name || before.checked_in_by }, newValues: { checked_in_at: null }, reason });
        res.json({ success: true, message: 'Check-in undone - the ticket can be scanned again.', counts: await ticketing.doorCounts(before.event_id) });
    } catch (e) { fail(res, e, 'undo check-in'); }
});

router.get('/api/admin/ticketing/events/:id/door', requireAdmin, async (req, res) => {
    try {
        const ev = await ticketing.getEvent(idParam(req.params.id));
        if (!ev) return res.status(404).json({ success: false, message: 'Event not found.' });
        const found = req.query.q ? (await ticketing.searchTickets(ev.event_id, req.query.q)).map(doorView) : [];
        res.json({ success: true, event: ticketing.publicEvent(ev), counts: await ticketing.doorCounts(ev.event_id), results: found });
    } catch (e) { fail(res, e, 'door'); }
});

module.exports = router;
