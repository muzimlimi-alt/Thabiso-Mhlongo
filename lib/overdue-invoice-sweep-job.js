// Phase 5 (HOUSEKEEPING-NOTES.md): relocated from app.js verbatim, alongside its own startup/
// scheduling wiring — registerOverdueInvoiceSweepJob() is called once from app.js at the same
// module-load-time position the inline setTimeout used to sit at.
const db = require('../database');
const moment = require('moment-timezone');
const { sendOverdueInvoiceEmail } = require('./scheduled-job-emails');
const { markInvoiceOverdueReminded } = require('../database/repositories/invoices-quotations.repository');

// S4-3: Overdue invoice sweep — sends the overdue notice for invoices past their due_date
async function runOverdueInvoiceSweepJob() {
    // Africa/Johannesburg, not UTC. SQLite's DATE('now') is UTC, and SA is UTC+2, so for the two
    // hours after local midnight an invoice due "today" was treated as already overdue.
    const todayLocal = moment().tz('Africa/Johannesburg').format('YYYY-MM-DD');
    const invoices = await new Promise(resolve =>
        db.all(
            // Match SENT *and* OVERDUE. runDailyOverdueFlaggingSweep() runs at startup + 00:05 and
            // flips SENT → OVERDUE, so by the time this reminder ran the invoices it should chase were
            // already OVERDUE and this WHERE — which only matched SENT — found nothing. The result was
            // that the overdue reminder had NEVER fired (measured: 7 OVERDUE invoices, 0 with
            // overdue_reminded_at set). overdue_reminded_at IS NULL keeps it idempotent.
            `SELECT i.id, i.invoice_number, i.due_date, i.total_amount,
                    b.id AS booking_id, b.name, b.email, b.event_name, b.event_type, b.date
             FROM invoices i
             JOIN bookings b ON b.id = i.booking_id
             WHERE UPPER(i.status) IN ('SENT','OVERDUE')
               AND i.due_date IS NOT NULL
               AND i.due_date < ?
               AND i.overdue_reminded_at IS NULL
               AND b.status = 'CONFIRMED'
               AND b.payment_status NOT IN ('PAID')`,
            [todayLocal],
            (err, rows) => resolve(err ? [] : (rows || []))
        )
    );

    let sent = 0, errors = 0;
    for (const inv of invoices) {
        const booking = { id: inv.booking_id, name: inv.name, email: inv.email, event_name: inv.event_name, event_type: inv.event_type, date: inv.date };
        try {
            await sendOverdueInvoiceEmail(booking, inv);
            markInvoiceOverdueReminded(inv.id);
            sent++;
            console.log(`[Overdue Invoice Sweep] Sent to booking #${inv.booking_id} (invoice #${inv.id})`);
        } catch (e) {
            console.error(`[Overdue Invoice Sweep] Failed for invoice #${inv.id}:`, e.message);
            errors++;
        }
    }
    console.log(`[Overdue Invoice Sweep Job] Done — sent: ${sent}, errors: ${errors}`);
}

function registerOverdueInvoiceSweepJob() {
    setTimeout(() => {
        runOverdueInvoiceSweepJob().catch(err => console.error('[Overdue Invoice Sweep Job] Startup run failed:', err.message));
        setInterval(() => {
            runOverdueInvoiceSweepJob().catch(err => console.error('[Overdue Invoice Sweep Job] Scheduled run failed:', err.message));
        }, 24 * 60 * 60 * 1000);
    }, 45000);
}

module.exports = { runOverdueInvoiceSweepJob, registerOverdueInvoiceSweepJob };
