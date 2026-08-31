// Phase 5 (HOUSEKEEPING-NOTES.md): relocated from app.js verbatim, alongside its own startup/
// scheduling wiring — registerAbandonedBookingJobs() is called once from app.js at the same
// module-load-time position the inline setTimeout used to sit at (it registered both jobs
// together in the original code, so they stay together here).
const db = require('../database');
const { sendAbandonedBookingReminderEmail } = require('./abandoned-booking-email');
const { findActiveBookingByEmailAndDate } = require('../database/repositories/bookings.repository');

// ============================================================================
// BOOKING RECOVERY — reminder + purge jobs
//  Reminder cadence: #1 at last_activity + 1h, #2 at last_reminder + 24h,
//  #3 at last_reminder + 72h. Consent-gated (consent_given=1), opt-out-aware,
//  capped at 3. Due-time selection is done in SQL to avoid TZ parsing issues.
// ============================================================================
async function runAbandonedBookingReminderJob() {
    const candidates = await new Promise(resolve =>
        db.all(`SELECT * FROM abandoned_bookings
                WHERE status IN ('ABANDONED','REMINDED') AND consent_given=1 AND opt_out=0
                  AND converted_booking_id IS NULL AND reminders_sent < 3 AND email IS NOT NULL
                  AND (
                    (reminders_sent = 0 AND last_activity_at <= datetime('now','-1 hour')) OR
                    (reminders_sent = 1 AND last_reminder_at <= datetime('now','-24 hours')) OR
                    (reminders_sent = 2 AND last_reminder_at <= datetime('now','-72 hours'))
                  )`, [], (err, rows) => resolve(err ? [] : (rows || []))));
    if (!candidates.length) return;

    for (const d of candidates) {
        // Defensive: if a real booking now exists for this email+date, mark recovered instead of emailing.
        if (d.event_date) {
            const existing = await new Promise(resolve => findActiveBookingByEmailAndDate(d.email, d.event_date, (e, row) => resolve(row)));
            if (existing) {
                await new Promise(r => db.run(`UPDATE abandoned_bookings SET status='RECOVERED', converted_booking_id=? WHERE id=?`, [existing.id, d.id], () => r()));
                continue;
            }
        }
        const ok = await sendAbandonedBookingReminderEmail(d);
        if (ok) {
            await new Promise(r => db.run(`UPDATE abandoned_bookings SET reminders_sent=reminders_sent+1, last_reminder_at=CURRENT_TIMESTAMP, status='REMINDED' WHERE id=?`, [d.id], () => r()));
            console.log(`[Booking Recovery] reminder #${d.reminders_sent + 1} sent for draft ${d.id}`);
        }
    }
}

// POPIA retention: purge stale, non-converted drafts after 30 days.
function runAbandonedBookingPurgeJob() {
    db.run(`DELETE FROM abandoned_bookings WHERE status NOT IN ('RECOVERED','WON') AND last_activity_at < datetime('now','-30 days')`, function (err) {
        if (err) return console.error('[Booking Recovery] purge failed:', err.message);
        if (this && this.changes > 0) console.log(`[Booking Recovery] POPIA purge removed ${this.changes} stale draft(s).`);
    });
}

function registerAbandonedBookingJobs() {
    setTimeout(() => {
        runAbandonedBookingReminderJob().catch(e => console.error('[Booking Recovery] reminder startup run failed:', e.message));
        setInterval(() => {
            runAbandonedBookingReminderJob().catch(e => console.error('[Booking Recovery] reminder run failed:', e.message));
        }, 15 * 60 * 1000);
        runAbandonedBookingPurgeJob();
        setInterval(runAbandonedBookingPurgeJob, 24 * 60 * 60 * 1000);
    }, 30000);
}

module.exports = { runAbandonedBookingReminderJob, runAbandonedBookingPurgeJob, registerAbandonedBookingJobs };
