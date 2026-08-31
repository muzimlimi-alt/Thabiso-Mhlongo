// Phase 5 (HOUSEKEEPING-NOTES.md): relocated from app.js verbatim, alongside its own startup/
// scheduling wiring — registerPostEventFollowupJob() is called once from app.js at the same
// module-load-time position the inline setTimeout used to sit at.
const { sendReviewRequestEmail } = require('./booking-notifications');
const { getCompletedBookingsAwaitingReview, stampReviewEmailSent } = require('../database/repositories/bookings.repository');

// S6-1: Post-event follow-up job — sends review-request email the day after a COMPLETED event
async function runPostEventFollowupJob() {
    const baseUrl = process.env.SITE_URL || '';
    // Bug fix: this previously selected c.name/b.client_name and c.email/b.client_email — none of
    // which exist (bookings.name/email are the real columns; clients has full_name, not name). The
    // query threw "no such column" on every run, silently swallowed by the resolve(err ? [] : ...)
    // below, so this job — the only automatic trigger for review-request emails — never fired.
    const bookings = await new Promise(resolve => {
        getCompletedBookingsAwaitingReview((err, rows) => { if (err) console.error('[Post-Event Followup] query failed:', err.message); resolve(err ? [] : (rows || [])); });
    });

    let sent = 0, errors = 0;
    for (const b of bookings) {
        try {
            // Send the review request (function already exists)
            await sendReviewRequestEmail(b);
            stampReviewEmailSent(b.id);
            sent++;
            console.log(`[Post-Event Followup] Review request sent for booking #${b.id} (${b.email})`);
        } catch (e) {
            console.error(`[Post-Event Followup] Failed for booking #${b.id}:`, e.message);
            errors++;
        }
    }
    if (sent > 0 || errors > 0) {
        console.log(`[Post-Event Followup Job] Done — sent: ${sent}, errors: ${errors}`);
    }
}

function registerPostEventFollowupJob() {
    setTimeout(() => {
        runPostEventFollowupJob().catch(err => console.error('[Post-Event Followup Job] Startup run failed:', err.message));
        setInterval(() => {
            runPostEventFollowupJob().catch(err => console.error('[Post-Event Followup Job] Scheduled run failed:', err.message));
        }, 24 * 60 * 60 * 1000);
    }, 35000);
}

module.exports = { runPostEventFollowupJob, registerPostEventFollowupJob };
