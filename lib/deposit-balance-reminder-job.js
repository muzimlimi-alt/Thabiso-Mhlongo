// Phase 5 (HOUSEKEEPING-NOTES.md): relocated from app.js verbatim, alongside its own startup/
// scheduling wiring — registerDepositBalanceReminderJob() is called once from app.js at the same
// module-load-time position the inline setTimeout used to sit at.
const moment = require('moment-timezone');
const emailComponents = require('../js/emailComponents');
const bannerRegistry = require('../js/bannerRegistry');
const { sendEmail } = require('../js/emailService');
const { getEmailFooterContext } = require('./email-context');
const { getBookingsForDepositBalanceReminder, markDepositBalanceReminded } = require('../database/repositories/bookings.repository');

// S4-1: DEPOSIT_PAID approaching-event reminder job
// Fires for DEPOSIT_PAID bookings whose event is within 14 days; deduplicates per booking using deposit_balance_reminded_at.
async function runDepositBalanceReminderJob() {
    const windowDays = 14; // start reminding when event is this many days away
    const targetDate = moment().add(windowDays, 'days').format('YYYY-MM-DD');
    const baseUrl = process.env.BASE_URL || 'https://www.thabisomhlongo.com';

    const bookings = await new Promise(resolve =>
        getBookingsForDepositBalanceReminder(targetDate, (err, rows) => resolve(err ? [] : (rows || [])))
    );

    let sent = 0, errors = 0;
    for (const b of bookings) {
        const outstanding = parseFloat(b.amount_outstanding) || 0;
        if (outstanding <= 0) continue; // already fully paid

        const daysUntilEvent = moment(b.event_date).diff(moment(), 'days');
        const payUrl = `${baseUrl}/?track=${b.id}&email=${encodeURIComponent(b.email)}`;

        // PAYMENT-CRITICAL: `R ${outstanding.toFixed(2)}` kept verbatim (both mentions).
        const { socialLinks: balanceSocialLinks } = await getEmailFooterContext();
        const banner = await bannerRegistry.resolveBanner('balance_payment_reminder');
        const emailBody = emailComponents.renderPremiumEmail({
            preheaderText: `Balance of R ${outstanding.toFixed(2)} due — event in ${daysUntilEvent} day${daysUntilEvent !== 1 ? 's' : ''}.`,
            bannerSrc: banner?.src, bannerAlt: banner?.alt, subtitle: banner?.subtitle,
            headline: banner?.headline || 'Balance Due — Event Approaching',
            greeting: `Hi ${b.name},`,
            bodyHtml:
                `Your event <strong style="color:#FAFAFA;">${b.event_name || b.event_type}</strong> is coming up in <strong style="color:#D4AF37;">${daysUntilEvent} day${daysUntilEvent !== 1 ? 's' : ''}</strong>!` +
                `<p style="margin:10px 0 0; color:#E6E6E6;">We wanted to remind you that a <strong style="color:#D4AF37;">balance payment of R ${outstanding.toFixed(2)}</strong> is still outstanding for your booking.</p>`,
            cards: [{
                title: 'Balance Due',
                rows: [
                    { label: 'Event Date', value: b.event_date },
                    { label: 'Balance Due', value: `R ${outstanding.toFixed(2)}`, highlight: true }
                ]
            }],
            cta: { label: 'Pay Balance Now', url: payUrl },
            socialLinks: balanceSocialLinks
        });

        try {
            await sendEmail({
                to: b.email,
                subject: `Balance Payment Reminder — ${b.event_date} Event (Booking #${b.id})`,
                htmlContent: emailBody,
                preWrapped: true,
                titleOverride: 'Balance Due — Event Approaching',
                trigger_event: 'Booking: Deposit Balance Approaching Event Reminder'
            });
            markDepositBalanceReminded(b.id);
            sent++;
            console.log(`[Deposit Balance Reminder] Sent to booking #${b.id} (${b.email})`);
        } catch (e) {
            console.error(`[Deposit Balance Reminder] Failed for booking #${b.id}:`, e.message);
            errors++;
        }
    }
    console.log(`[Deposit Balance Reminder Job] Done — sent: ${sent}, errors: ${errors}`);
}

function registerDepositBalanceReminderJob() {
    setTimeout(() => {
        runDepositBalanceReminderJob().catch(err => console.error('[Deposit Balance Reminder Job] Startup run failed:', err.message));
        setInterval(() => {
            runDepositBalanceReminderJob().catch(err => console.error('[Deposit Balance Reminder Job] Scheduled run failed:', err.message));
        }, 24 * 60 * 60 * 1000);
    }, 30000);
}

module.exports = { runDepositBalanceReminderJob, registerDepositBalanceReminderJob };
