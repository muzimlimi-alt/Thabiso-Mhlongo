// Phase 5 (HOUSEKEEPING-NOTES.md): relocated from app.js verbatim, alongside its own immediate-run
// + schedule.scheduleJob wiring — wrapped into registerOverdueFlaggingSweep() to match every other
// scheduled job's convention. app.js calls it once, at the same module-load-time position the
// inline runDailyOverdueFlaggingSweep()/schedule.scheduleJob(...) pair used to sit at.
const db = require('../database');
const moment = require('moment-timezone');
const schedule = require('node-schedule');
const { flagOverdueInvoices } = require('../database/repositories/invoices-quotations.repository');
const { flagOverduePaymentSchedules } = require('../database/repositories/finance.repository');

// Phase 4: Daily Overdue Auto-Flagging Cron Job (runs at 00:05 AM)
// Flag invoices and payment milestones as OVERDUE/overdue when past their due dates
function runDailyOverdueFlaggingSweep() {
    console.log('[cron] Starting daily overdue flagging sweep...');
    // Africa/Johannesburg, not UTC — SQLite's DATE('now') is UTC and SA is UTC+2, so an invoice due
    // "today" was flagged overdue up to two hours before the local business day ended.
    const todayLocal = moment().tz('Africa/Johannesburg').format('YYYY-MM-DD');
    db.serialize(() => {
        // 1. Flag invoices as OVERDUE
        flagOverdueInvoices(
            todayLocal,
            function(err) {
                if (err) {
                    console.error('[cron] Invoice overdue flagging error:', err.message);
                } else if (this.changes > 0) {
                    console.log(`[cron] Flagged ${this.changes} invoice(s) as OVERDUE.`);
                }
            }
        );

        // 2. Flag payment schedules as overdue
        flagOverduePaymentSchedules(
            todayLocal,
            function(err) {
                if (err) {
                    console.error('[cron] Payment schedule overdue flagging error:', err.message);
                } else if (this.changes > 0) {
                    console.log(`[cron] Flagged ${this.changes} payment schedule milestone(s) as overdue.`);
                }
            }
        );
    });
}

function registerOverdueFlaggingSweep() {
    runDailyOverdueFlaggingSweep();
    schedule.scheduleJob('5 0 * * *', runDailyOverdueFlaggingSweep);
}

module.exports = { runDailyOverdueFlaggingSweep, registerOverdueFlaggingSweep };
