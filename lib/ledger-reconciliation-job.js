// Phase 5 (HOUSEKEEPING-NOTES.md): relocated from app.js verbatim, alongside its own startup/
// scheduling wiring — registerLedgerReconciliationJob() is called once from app.js at the same
// module-load-time position the inline setTimeout used to sit at.
const db = require('../database');
const emailComponents = require('../js/emailComponents');
const { sendEmail } = require('../js/emailService');
const { getNotificationEmail } = require('../database/repositories/settings.repository');
const { receivedAmountSql } = require('./booking-amounts');

// The bookings whose recorded amount_paid disagrees with their transactions by more than R1 (exported so the query itself can be tested).
// "Actual" is the money really received: payments minus refunds / chargebacks, and NO adjustments (receivedAmountSql). The alert used to quote
// a plain SUM(amount) beside a check that netted refunds, and the check counted adjustments as payments - so an adjustment raised a false
// alert and could even cover a real shortfall.
function findLedgerDiscrepancies() {
    return new Promise(resolve => {
        db.all(
            `SELECT b.id, b.name, b.event_name, b.amount_paid AS recorded,
                    COALESCE(SUM(${receivedAmountSql('t')}), 0) AS actual
             FROM bookings b
             LEFT JOIN transactions t ON t.booking_id = b.id
               AND t.is_duplicate = 0
               AND (t.status = 'completed' OR t.status IS NULL)
             WHERE b.payment_status NOT IN ('UNPAID','CANCELLED')
             GROUP BY b.id
             HAVING ABS(b.amount_paid - COALESCE(SUM(${receivedAmountSql('t')}), 0)) > 1`,
            [],
            (err, rows) => resolve(err ? [] : (rows || []))
        );
    });
}

// P2-10: Daily ledger reconciliation — compare bookings.amount_paid vs SUM(verified transactions).
async function runLedgerReconciliationJob() {
    const discrepancies = await findLedgerDiscrepancies();

    if (discrepancies.length === 0) return;

    console.warn(`[Ledger Reconciliation] ${discrepancies.length} booking(s) have amount_paid vs transaction-sum discrepancy.`);

    const adminEmail = await getNotificationEmail();
    if (!adminEmail) return;

    const body = emailComponents.renderSystemEmail({
        preheaderText: `${discrepancies.length} booking(s) with a payment ledger discrepancy.`,
        category: 'Payments & Invoices',
        severity: 'alert',
        leadFact: `The following bookings have a mismatch between <strong style="color:#FAFAFA;">bookings.amount_paid</strong> and the <strong style="color:#FAFAFA;">sum of completed non-duplicate transactions</strong>. Please investigate and correct manually.`,
        cards: [{
            title: 'Payment Ledger Discrepancies',
            rows: discrepancies.map(d => ({
                label: `#${d.id} — ${d.name || ''}${d.event_name ? ' · ' + d.event_name : ''}`,
                value: `Recorded R ${parseFloat(d.recorded).toFixed(2)} · Tx Sum R ${parseFloat(d.actual).toFixed(2)} · Drift R ${(parseFloat(d.recorded) - parseFloat(d.actual)).toFixed(2)}`,
                mono: false
            }))
        }]
    });

    await sendEmail({
        to: adminEmail,
        subject: `[Ledger Alert] ${discrepancies.length} booking(s) with payment discrepancy`,
        htmlContent: body,
        preWrapped: true,
        titleOverride: 'Ledger Discrepancy Alert',
        trigger_event: 'Admin: Ledger Reconciliation'
    });
}

function registerLedgerReconciliationJob() {
    setTimeout(() => {
        runLedgerReconciliationJob().catch(err => console.error('[Ledger Reconciliation] Startup run failed:', err.message));
        setInterval(() => {
            runLedgerReconciliationJob().catch(err => console.error('[Ledger Reconciliation] Scheduled run failed:', err.message));
        }, 24 * 60 * 60 * 1000);
    }, 55000);
}

module.exports = { runLedgerReconciliationJob, registerLedgerReconciliationJob, findLedgerDiscrepancies };
