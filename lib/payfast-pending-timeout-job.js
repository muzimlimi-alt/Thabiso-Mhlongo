// Phase 5 (HOUSEKEEPING-NOTES.md): relocated from app.js verbatim, alongside its own startup/
// scheduling wiring — registerPayFastPendingTimeoutJob() is called once from app.js at the same
// module-load-time position the inline setTimeout used to sit at.
const emailComponents = require('../js/emailComponents');
const { sendEmail } = require('../js/emailService');
const { getNotificationEmail } = require('../database/repositories/settings.repository');
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
    const adminEmail = await getNotificationEmail();
    if (!adminEmail) return;

    const body = emailComponents.renderSystemEmail({
        preheaderText: `${stuckTx.length} PayFast payment redirect(s) never confirmed within an hour.`,
        category: 'Payments & Invoices',
        severity: 'alert',
        leadFact: `The following PayFast payment redirects were built more than 1 hour ago but <strong style="color:#FAFAFA;">no matching ITN has arrived</strong>. The customer may have abandoned checkout, or PayFast's notification failed to reach this server. Please check the PayFast dashboard and confirm or follow up manually.`,
        cards: [{
            title: 'Unconfirmed PayFast Redirects',
            rows: stuckTx.map(t => ({
                label: `#${t.booking_id} — ${t.name || ''}`,
                value: `R${parseFloat(t.expected_amount).toFixed(2)} (${t.payment_type || ''}) · Started ${t.created_at}`,
                mono: false
            }))
        }]
    });

    await sendEmail({
        to: adminEmail,
        subject: `[PayFast Alert] ${stuckTx.length} payment redirect(s) unconfirmed for >1 hour`,
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
