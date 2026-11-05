// Phase 5 (HOUSEKEEPING-NOTES.md): relocated from app.js verbatim, alongside its own startup/
// scheduling wiring — registerPayFastPendingTimeoutJob() is called once from app.js at the same
// module-load-time position the inline setTimeout used to sit at.
const notify = require('./notify');
const { getStuckPaymentIntents } = require('../database/repositories/finance.repository');

// P3-14: Detect PayFast redirects that were built but never followed by a matching ITN within an
// hour, and alert admin. Originally queried transactions.pf_status = 'PENDING', but nothing on the
// ITN path ever wrote that value — insertPayfastTransaction always inserts status='completed', so
// this job silently never found anything. Repointed (2026-10-15) at payfast_payment_intents, which
// is written at redirect time specifically so this kind of thing is detectable.
async function runPayFastPendingTimeoutJob() {
    const stuckTx = await getStuckPaymentIntents();

    if (stuckTx.length === 0) return;

    console.warn(`[PayFast Pending] ${stuckTx.length} payment redirect(s) with no matching ITN after >1 hour.`);
    // Notification Centre (docs-internal/notifications.md): one incident per unconfirmed redirect, e-mailed ONCE when it first appears (this job used
    // to re-send the whole digest every hour for the same items). It closes itself when the payment arrives (routes/public/payment.js).
    for (const t of stuckTx) {
        notify.emit('finance.payment_pending_timeout', { bookingId: t.booking_id, clientName: t.name || '', amount: parseFloat(t.expected_amount) || 0, started: t.created_at }, { actorType: 'system' });
    }
}

const monitoredRun = require('./job-monitor').monitored('payfast-pending-timeout', 'PayFast pending-payment check', 60 * 60 * 1000, runPayFastPendingTimeoutJob);   // heartbeat + grouped failure alert (docs-internal/notifications.md)
function registerPayFastPendingTimeoutJob() {
    setTimeout(() => {
        monitoredRun().catch(e => console.error('[PayFast Pending Timeout] Startup run failed:', e.message));
        setInterval(() => {
            monitoredRun().catch(e => console.error('[PayFast Pending Timeout] Scheduled run failed:', e.message));
        }, 60 * 60 * 1000); // check hourly
    }, 65000);
}

module.exports = { runPayFastPendingTimeoutJob, registerPayFastPendingTimeoutJob };
