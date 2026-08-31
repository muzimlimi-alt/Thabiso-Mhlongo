// Phase 5 (HOUSEKEEPING-NOTES.md): relocated from app.js verbatim, alongside its own startup/
// scheduling wiring — registerPayFastPendingTimeoutJob() is called once from app.js at the same
// module-load-time position the inline setTimeout used to sit at.
const db = require('../database');
const emailComponents = require('../js/emailComponents');
const { sendEmail } = require('../js/emailService');
const { getNotificationEmail } = require('../database/repositories/settings.repository');

// P3-14: Detect transactions stuck in pending PayFast status for >1 hour and alert admin.
async function runPayFastPendingTimeoutJob() {
    const stuckTx = await new Promise(resolve => {
        db.all(
            `SELECT t.id, t.booking_id, t.amount, t.created_at, b.name, b.email, b.event_name
             FROM transactions t
             JOIN bookings b ON b.id = t.booking_id
             WHERE t.source = 'payfast'
               AND (t.pf_status = 'PENDING' OR (t.status = 'pending' AND t.pf_status IS NULL))
               AND t.created_at <= datetime('now', '-1 hour')`,
            [],
            (err, rows) => resolve(err ? [] : (rows || []))
        );
    });

    if (stuckTx.length === 0) return;

    console.warn(`[PayFast Pending] ${stuckTx.length} transaction(s) stuck in PENDING for >1 hour.`);
    const adminEmail = await getNotificationEmail();
    if (!adminEmail) return;

    const body = emailComponents.renderSystemEmail({
        preheaderText: `${stuckTx.length} PayFast transaction(s) stuck in PENDING for over 1 hour.`,
        category: 'Payments & Invoices',
        severity: 'alert',
        leadFact: `The following PayFast transactions have been in <strong style="color:#FAFAFA;">PENDING</strong> status for more than 1 hour. PayFast may have not sent an ITN. Please check the PayFast dashboard and confirm or void manually.`,
        cards: [{
            title: 'Stuck PayFast Transactions',
            rows: stuckTx.map(t => ({
                label: `#${t.booking_id} — ${t.name || ''}`,
                value: `R${parseFloat(t.amount).toFixed(2)} · Started ${t.created_at}`,
                mono: false
            }))
        }]
    });

    await sendEmail({
        to: adminEmail,
        subject: `[PayFast Alert] ${stuckTx.length} transaction(s) stuck in PENDING for >1 hour`,
        htmlContent: body,
        preWrapped: true,
        titleOverride: 'PayFast Pending Timeout',
        trigger_event: 'Admin: PayFast Pending Timeout'
    });
}

function registerPayFastPendingTimeoutJob() {
    setTimeout(() => {
        runPayFastPendingTimeoutJob().catch(e => console.error('[PayFast Pending Timeout] Startup run failed:', e.message));
        setInterval(() => {
            runPayFastPendingTimeoutJob().catch(e => console.error('[PayFast Pending Timeout] Scheduled run failed:', e.message));
        }, 60 * 60 * 1000); // check hourly
    }, 65000);
}

module.exports = { runPayFastPendingTimeoutJob, registerPayFastPendingTimeoutJob };
