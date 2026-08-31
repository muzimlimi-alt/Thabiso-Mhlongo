// Phase 5 (HOUSEKEEPING-NOTES.md): relocated from app.js verbatim, alongside its own startup/
// scheduling wiring — registerEventReminderJob() is called once from app.js at the same
// module-load-time position the inline setTimeout used to sit at.
const { sendEventReminderEmail } = require('./scheduled-job-emails');
const { getConfirmedBookingsOnDate, markEventReminderSent } = require('../database/repositories/bookings.repository');

// Pre-event reminder — a logistics/countdown nudge for every CONFIRMED booking 3 days before its
// event, regardless of payment status (that's the separate balance-due reminder's job). Mirrors
// runInvoicePreDueReminderJob's exact-date-match + dedup-column pattern.
async function runEventReminderJob() {
    const daysBefore = 3;
    const targetDate = new Date();
    targetDate.setDate(targetDate.getDate() + daysBefore);
    const targetStr = targetDate.toISOString().split('T')[0];

    const bookings = await new Promise(resolve =>
        getConfirmedBookingsOnDate(targetStr, (err, rows) => resolve(err ? [] : (rows || [])))
    );

    let sent = 0, errors = 0;
    for (const b of bookings) {
        try {
            await sendEventReminderEmail(b, daysBefore);
            markEventReminderSent(b.id);
            sent++;
            console.log(`[Event Reminder] Sent to booking #${b.id} (${b.email})`);
        } catch (e) {
            console.error(`[Event Reminder] Failed for booking #${b.id}:`, e.message);
            errors++;
        }
    }
    console.log(`[Event Reminder Job] Done — sent: ${sent}, errors: ${errors}`);
}

function registerEventReminderJob() {
    setTimeout(() => {
        runEventReminderJob().catch(err => console.error('[Event Reminder Job] Startup run failed:', err.message));
        setInterval(() => {
            runEventReminderJob().catch(err => console.error('[Event Reminder Job] Scheduled run failed:', err.message));
        }, 24 * 60 * 60 * 1000);
    }, 44000);
}

module.exports = { runEventReminderJob, registerEventReminderJob };
