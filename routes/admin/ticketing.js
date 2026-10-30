// Event ticketing - admin API (docs-internal/ticketing.md). Part of the Events area of the portal.
//   ticket types (tiers) + open/close sales : administrators and managers
//   orders, refunds, resend, attendee CSV     : administrators and managers
//   door check-in + door counts               : every admin role (assistants work the door)
// The server decides every permission; the page only hides what a role can't use.
const express = require('express');
const { requireAdmin } = require('../../middleware/auth');
const { requireRole } = require('../../middleware/rbac');
const { exportRateLimiter } = require('../../middleware/rate-limiters');
const { logAudit } = require('../../lib/audit-log');
const core = require('../../lib/ticketing-core');
const ticketing = require('../../lib/ticketing');
const delivery = require('../../lib/ticketing-delivery');
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

// ---------------------------------------------------------------- an event's tickets (the event drawer's Tickets tab)

router.get('/api/admin/events/:id/ticketing', requireAdmin, async (req, res) => {
    try {
        const ev = await ticketing.getEvent(idParam(req.params.id));
        if (!ev) return res.status(404).json({ success: false, message: 'Event not found.' });
        const tiers = await ticketing.listTiers(ev.event_id);
        const block = core.eventBlockReason(ev);
        const totals = tiers.reduce((a, t) => ({ capacity: a.capacity + t.capacity, sold: a.sold + t.sold, reserved: a.reserved + t.reserved }), { capacity: 0, sold: 0, reserved: 0 });
        res.json({
            success: true,
            event: { event_id: ev.event_id, title: ev.event_title, event_status: ev.event_status, event_capacity: ev.event_capacity, standalone: !ev.booking_id },
            can_sell: !block, block_reason: block,
            sales_open: tiers.some(t => t.is_active),
            tiers: tiers.map(t => adminTier(t, ev)), totals,
            capacity_warning: await ticketing.capacityWarning(ev.event_id),
            limits: { min_price_cents: core.MIN_PRICE_CENTS, max_per_order: core.MAX_PER_ORDER_LIMIT, hold_minutes: core.HOLD_MINUTES }
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
        await logAudit({ tableName: 'ticket_types', recordId: after.id, action: 'TICKET_TYPE_UPDATED', req, oldValues: before, newValues: after });
        res.json({ success: true, tier: after, capacity_warning: await ticketing.capacityWarning(after.event_id), message: `"${after.name}" saved.` });
    } catch (e) { fail(res, e, 'update tier'); }
});

router.delete('/api/admin/ticket-types/:id', requireAdmin, MANAGE, async (req, res) => {
    try {
        const tier = await ticketing.deleteTier(idParam(req.params.id));
        await logAudit({ tableName: 'ticket_types', recordId: tier.id, action: 'TICKET_TYPE_DELETED', req, oldValues: tier });
        res.json({ success: true, message: `"${tier.name}" deleted.` });
    } catch (e) { fail(res, e, 'delete tier'); }
});

// The event-wide switch: { open: true | false }.
router.post('/api/admin/events/:id/ticket-sales', requireAdmin, MANAGE, async (req, res) => {
    try {
        const open = req.body && (req.body.open === true || req.body.open === 'true');
        const eventId = idParam(req.params.id);
        const r = await ticketing.setEventSales(eventId, open);
        await logAudit({ tableName: 'events', recordId: eventId, action: open ? 'TICKET_SALES_OPENED' : 'TICKET_SALES_CLOSED', req, newValues: { tiers_changed: r.changed } });
        res.json({ success: true, sales_open: open, message: open ? 'Ticket sales are open.' : 'Ticket sales are closed.' });
    } catch (e) { fail(res, e, 'sales switch'); }
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
        if (!(await ticketing.getEvent(id))) return res.status(404).json({ success: false, message: 'Event not found.' });
        const s = await ticketing.eventStats(id);
        if (isAssistant(req)) { delete s.revenue_cents; delete s.refunded_cents; delete s.refund_due_cents; s.tiers = s.tiers.map(({ price_cents, ...t }) => t); }
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
        res.json({ success: true, ...d });
    } catch (e) { fail(res, e, 'order detail'); }
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
        if (note.length < 3) return res.status(400).json({ success: false, message: 'Please note how it was refunded (for example "Refunded in PayFast on 30 Oct").' });
        const r = await ticketing.refundOrder(idParam(req.params.id), req.session.adminId, note);
        await logAudit({ tableName: 'ticket_orders', recordId: r.after.id, action: 'TICKET_ORDER_REFUNDED', req,
            oldValues: { status: r.before.status, refund_required: r.before.refund_required }, newValues: { status: r.after.status }, reason: note });
        res.json({ success: true, message: r.checkedIn ? `Marked as refunded. Note: ${r.checkedIn} of its tickets had already been used at the door.` : 'Marked as refunded - its tickets no longer work and the places are back on sale.' });
    } catch (e) { fail(res, e, 'refund'); }
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

// What a scanned ticket is - for the staff view on /t/<token> and the scanner page. A GET never checks anyone in.
function doorView(t) {
    return t && {
        token: t.token, event_id: t.event_id, event_title: core.tidy(t.event_title), when: core.formatSast(core.eventStart({ event_datetime: t.event_datetime })),
        tier: t.tier_name, holder: t.holder_name || t.buyer_name || '', order_id: t.order_id,
        status: t.voided_at || t.order_status !== 'paid' ? 'void' : (t.checked_in_at ? 'checked_in' : 'valid'),
        checked_in_at: t.checked_in_at, checked_in_label: t.checked_in_at ? core.formatSast(t.checked_in_at, 'HH:mm') : null, checked_in_by: t.checked_in_by_name || null
    };
}

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

router.get('/api/admin/ticketing/events/:id/door', requireAdmin, async (req, res) => {
    try {
        const ev = await ticketing.getEvent(idParam(req.params.id));
        if (!ev) return res.status(404).json({ success: false, message: 'Event not found.' });
        const found = req.query.q ? (await ticketing.searchTickets(ev.event_id, req.query.q)).map(doorView) : [];
        res.json({ success: true, event: ticketing.publicEvent(ev), counts: await ticketing.doorCounts(ev.event_id), results: found });
    } catch (e) { fail(res, e, 'door'); }
});

module.exports = router;
