// Ticket-sales alerts for the Notification Centre (docs-internal/notifications.md). Called after a ticket order is PAID (lib/ticketing-payments.js,
// after the commit): one grouped "new ticket orders today" item per show, a low-stock alert per tier when what is left falls to the owner's
// threshold (Preferences -> notification settings, default 10), and "sold out" when every active tier is gone. Never throws.
const { dbGet, dbAll } = require('./db-helpers');
const notify = require('./notify');

const DEFAULT_THRESHOLD = 10;

async function lowStockThreshold() {
    const row = await dbGet("SELECT setting_value FROM settings WHERE setting_key = 'ntf_low_stock_threshold'").catch(() => null);
    const n = row ? parseInt(row.setting_value, 10) : NaN;
    return Number.isInteger(n) && n >= 0 ? n : DEFAULT_THRESHOLD;
}

async function afterPaidOrder(order) {
    try {
        if (!order || !order.event_id || order.complimentary) return;
        const ev = await dbGet('SELECT event_id, event_title FROM events WHERE event_id = ?', [order.event_id]);
        const title = ev ? ev.event_title : null;
        const day = new Date(Date.now() + 2 * 3600000).toISOString().slice(0, 10);   // the business day (SAST)
        await notify.emit('events.ticket_orders', {
            eventId: order.event_id, eventTitle: title, day, orderId: order.id, buyerName: order.buyer_name, amount: (order.total_cents || 0) / 100
        }, { actorType: 'client', actorLabel: order.buyer_name || null });

        const threshold = await lowStockThreshold();
        const tiers = await dbAll('SELECT id, name, capacity, sold, reserved, is_active FROM ticket_types WHERE event_id = ?', [order.event_id]);
        const active = tiers.filter((t) => t.is_active && t.capacity > 0);
        for (const t of active) {
            const remaining = Math.max(0, t.capacity - t.sold - t.reserved);
            if (remaining > 0 && remaining <= threshold) {
                await notify.emit('events.low_stock', { tierId: t.id, tierName: t.name, eventTitle: title, remaining, sold: t.sold, capacity: t.capacity, threshold }, { actorType: 'system' });
            }
        }
        if (active.length && active.every((t) => t.capacity - t.sold <= 0)) {
            await notify.emit('events.sold_out', { eventId: order.event_id, eventTitle: title, sold: active.reduce((a, t) => a + t.sold, 0) }, { actorType: 'system' });
            for (const t of active) await notify.resolve('events.low_stock', t.id, { note: 'Sold out.' });
        }
    } catch (e) {
        console.error('[ticket-alerts]', e && e.message);
    }
}

module.exports = { afterPaidOrder, lowStockThreshold, DEFAULT_THRESHOLD };
