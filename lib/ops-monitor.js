// Operations monitor for the Notification Centre (docs-internal/notifications.md): the deadline-type items no single request raises.
// Runs hourly (monitored by lib/job-monitor.js). Each item is ONE incident that refreshes its own wording (days left / overdue) and closes
// itself when the condition is gone - an invoice paid or voided, a milestone paid, an event past, a tier's sales over. Nothing is e-mailed from
// here (the clients get their own reminders; the owner already has the overdue digest) - these are in-app Attention / Action items.
//
//   finance.invoice_overdue   invoices with status OVERDUE (flagged nightly by lib/overdue-flagging-sweep.js)
//   bookings.milestone_due    pending payment-schedule rows due within 3 days, on live bookings
//   events.upcoming           public events (upcoming) within the next 3 days
//   events.sales_closing      active ticket tiers whose sales end within 48 hours with tickets left
const { dbAll } = require('./db-helpers');
const notify = require('./notify');

const DAY = 86400000;
const sastToday = (now) => new Date(now + 2 * 3600000).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / DAY);

// Resolve every open incident of `eventKey` whose entity is NOT in `keepIds` (the condition went away).
async function closeGone(eventKey, keepIds, note) {
    const open = await dbAll(`SELECT entity_id FROM admin_notifications WHERE event_type = ? AND status IN ('open','acknowledged')`, [eventKey]);
    const keep = new Set(keepIds.map(String));
    let n = 0;
    for (const r of open) {
        if (!keep.has(String(r.entity_id))) { n += await notify.resolve(eventKey, r.entity_id, { note }); }
    }
    return n;
}

async function runOpsCheck(now = Date.now()) {
    const today = sastToday(now);
    const out = { overdue: 0, milestones: 0, upcoming: 0, closing: 0, closed: 0 };

    const overdue = await dbAll(
        `SELECT i.id, i.invoice_number, i.booking_id, i.due_date, i.total_amount, b.name FROM invoices i LEFT JOIN bookings b ON b.id = i.booking_id
          WHERE i.status = 'OVERDUE' AND i.due_date IS NOT NULL`);
    for (const i of overdue) {
        await notify.emit('finance.invoice_overdue', {
            invoiceId: i.id, invoiceNumber: i.invoice_number, bookingId: i.booking_id, clientName: i.name, amount: i.total_amount,
            dueDate: String(i.due_date).slice(0, 10), daysOverdue: Math.max(0, daysBetween(String(i.due_date).slice(0, 10), today))
        }, { actorType: 'system' });
    }
    out.overdue = overdue.length;
    out.closed += await closeGone('finance.invoice_overdue', overdue.map((i) => i.id), 'The invoice is no longer overdue (paid, voided or re-dated).');

    const until = new Date(Date.parse(today + 'T00:00:00Z') + 3 * DAY).toISOString().slice(0, 10);
    const due = await dbAll(
        `SELECT ps.id, ps.booking_id, ps.description, ps.due_date, ps.expected_amount, b.name FROM payment_schedules ps JOIN bookings b ON b.id = ps.booking_id
          WHERE ps.status = 'pending' AND date(ps.due_date) BETWEEN date(?) AND date(?) AND b.status NOT IN ('CANCELLED','EXPIRED','COMPLETED')`, [today, until]);
    for (const m of due) {
        await notify.emit('bookings.milestone_due', {
            scheduleId: m.id, bookingId: m.booking_id, description: m.description || 'Payment', amount: m.expected_amount, clientName: m.name,
            dueDate: String(m.due_date).slice(0, 10), daysLeft: daysBetween(today, String(m.due_date).slice(0, 10))
        }, { actorType: 'system' });
    }
    out.milestones = due.length;
    out.closed += await closeGone('bookings.milestone_due', due.map((m) => m.id), 'Paid, or no longer due soon.');

    const soon = await dbAll(
        `SELECT e.event_id, e.event_title, e.event_datetime, e.venue_name,
                (SELECT COALESCE(SUM(sold), 0) FROM ticket_types t WHERE t.event_id = e.event_id) AS sold
           FROM events e WHERE e.event_status = 'upcoming' AND date(e.event_datetime) BETWEEN date(?) AND date(?)`, [today, until]);
    for (const e of soon) {
        const date = String(e.event_datetime).slice(0, 10);
        await notify.emit('events.upcoming', { eventId: e.event_id, title: e.event_title, date, venue: e.venue_name, daysLeft: daysBetween(today, date), ticketsSold: e.sold || 0 }, { actorType: 'system' });
    }
    out.upcoming = soon.length;
    out.closed += await closeGone('events.upcoming', soon.map((e) => e.event_id), 'The event date has passed or it is no longer upcoming.');

    const nowIso = new Date(now).toISOString();
    const in48 = new Date(now + 2 * DAY).toISOString();
    const closing = await dbAll(
        `SELECT t.id, t.name, t.sales_end, t.capacity, t.sold, t.reserved, e.event_title FROM ticket_types t JOIN events e ON e.event_id = t.event_id
          WHERE t.is_active = 1 AND t.sales_end IS NOT NULL AND t.sales_end > ? AND t.sales_end <= ? AND t.capacity - t.sold - t.reserved > 0 AND e.event_status = 'upcoming'`, [nowIso, in48]);
    for (const t of closing) {
        await notify.emit('events.sales_closing', {
            tierId: t.id, tierName: t.name, eventTitle: t.event_title, salesEnd: String(t.sales_end).replace('T', ' ').slice(0, 16),
            hoursLeft: Math.max(0, Math.round((Date.parse(t.sales_end) - now) / 3600000)), remaining: t.capacity - t.sold - t.reserved
        }, { actorType: 'system' });
    }
    out.closing = closing.length;
    out.closed += await closeGone('events.sales_closing', closing.map((t) => t.id), 'Ticket sales for this tier have ended or sold out.');
    return out;
}

function registerOpsMonitor() {
    const run = require('./job-monitor').monitored('ops-monitor', 'Deadlines & overdue items monitor', 60 * 60 * 1000, () => runOpsCheck());
    setTimeout(() => {
        run().catch((e) => console.error('[Ops monitor] Startup run failed:', e.message));
        setInterval(() => run().catch((e) => console.error('[Ops monitor] Run failed:', e.message)), 60 * 60 * 1000);
    }, 85000);
}

module.exports = { runOpsCheck, registerOpsMonitor };
