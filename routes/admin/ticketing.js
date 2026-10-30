// Event ticketing - admin API (docs-internal/ticketing.md). Part of the Events area of the portal.
//   ticket types (tiers) + open/close sales : administrators and managers
//   orders, refunds, resend, attendee CSV     : administrators and managers
//   door check-in + door counts               : every admin role (assistants work the door)
// The server decides every permission; the page only hides what a role can't use.
const express = require('express');
const { requireAdmin } = require('../../middleware/auth');
const { requireRole } = require('../../middleware/rbac');
const { logAudit } = require('../../lib/audit-log');
const core = require('../../lib/ticketing-core');
const ticketing = require('../../lib/ticketing');
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

module.exports = router;
