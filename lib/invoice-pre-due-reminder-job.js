// Phase 5 (HOUSEKEEPING-NOTES.md): relocated from app.js verbatim, alongside its own startup/
// scheduling wiring — registerInvoicePreDueReminderJob() is called once from app.js at the same
// module-load-time position the inline setTimeout used to sit at.
const db = require('../database');
const { sendInvoicePreDueEmail } = require('./scheduled-job-emails');
const { markInvoicePreDueReminded } = require('../database/repositories/invoices-quotations.repository');

// S4-2: Invoice pre-due reminder — sends email 3 days before invoice due_date for SENT invoices
async function runInvoicePreDueReminderJob() {
    const daysBefore = 3;
    const targetDate = new Date();
    targetDate.setDate(targetDate.getDate() + daysBefore);
    const targetStr = targetDate.toISOString().split('T')[0];

    const invoices = await new Promise(resolve =>
        db.all(
            `SELECT i.id, i.invoice_number, i.due_date, i.total_amount,
                    b.id AS booking_id, b.name, b.email, b.event_name, b.event_type, b.date
             FROM invoices i
             JOIN bookings b ON b.id = i.booking_id
             WHERE UPPER(i.status) = 'SENT'
               AND i.due_date = ?
               AND i.pre_due_reminded_at IS NULL
               AND b.status = 'CONFIRMED'
               AND b.payment_status NOT IN ('PAID')`,
            [targetStr],
            (err, rows) => resolve(err ? [] : (rows || []))
        )
    );

    let sent = 0, errors = 0;
    for (const inv of invoices) {
        const booking = { id: inv.booking_id, name: inv.name, email: inv.email, event_name: inv.event_name, event_type: inv.event_type, date: inv.date };
        try {
            await sendInvoicePreDueEmail(booking, inv, daysBefore);
            markInvoicePreDueReminded(inv.id);
            sent++;
            console.log(`[Invoice Pre-Due Reminder] Sent to booking #${inv.booking_id} (invoice #${inv.id})`);
        } catch (e) {
            console.error(`[Invoice Pre-Due Reminder] Failed for invoice #${inv.id}:`, e.message);
            errors++;
        }
    }
    console.log(`[Invoice Pre-Due Reminder Job] Done — sent: ${sent}, errors: ${errors}`);
}

function registerInvoicePreDueReminderJob() {
    setTimeout(() => {
        runInvoicePreDueReminderJob().catch(err => console.error('[Invoice Pre-Due Reminder Job] Startup run failed:', err.message));
        setInterval(() => {
            runInvoicePreDueReminderJob().catch(err => console.error('[Invoice Pre-Due Reminder Job] Scheduled run failed:', err.message));
        }, 24 * 60 * 60 * 1000);
    }, 40000);
}

module.exports = { runInvoicePreDueReminderJob, registerInvoicePreDueReminderJob };
