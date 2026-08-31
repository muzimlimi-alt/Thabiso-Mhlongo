// Phase 5 (HOUSEKEEPING-NOTES.md): relocated from app.js verbatim, alongside its own startup/
// scheduling wiring — registerQuoteFollowUpJob() is called once from app.js at the same
// module-load-time position the inline setTimeout used to sit at.
const db = require('../database');
const emailComponents = require('../js/emailComponents');
const bannerRegistry = require('../js/bannerRegistry');
const { sendEmail } = require('../js/emailService');
const { getEmailFooterContext } = require('./email-context');
const { getBookingsForQuoteFollowUp, markQuoteFollowUpSent } = require('../database/repositories/bookings.repository');

// S2-6: Automated quote follow-up — sends a reminder to clients with open (QUOTED) quotes older than N days
async function runQuoteFollowUpJob() {
    const policyRow = await new Promise(resolve =>
        db.get("SELECT policy_value FROM policies WHERE policy_key = 'quote_followup_days'", [], (err, row) => resolve(row))
    );
    const followUpDays = parseInt(policyRow?.policy_value) || 5;

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - followUpDays);
    const cutoffStr = cutoff.toISOString().split('T')[0];
    const baseUrl = process.env.BASE_URL || 'https://www.thabisomhlongo.com';

    const bookings = await new Promise(resolve =>
        getBookingsForQuoteFollowUp(cutoffStr, (err, rows) => resolve(err ? [] : (rows || [])))
    );

    let sent = 0, errors = 0;
    for (const b of bookings) {
        try {
            // PAYMENT-CRITICAL: `R ${parseFloat(b.quote_amount || 0).toFixed(2)}` kept verbatim.
            const expiryNote = b.quote_expiry_date
                ? ` Please note your quote expires on <strong style="color:#D4AF37;">${b.quote_expiry_date}</strong>.`
                : '';
            const { socialLinks: followUpSocialLinks } = await getEmailFooterContext();
            const banner = await bannerRegistry.resolveBanner('quote_still_open');
            const emailBody = emailComponents.renderPremiumEmail({
                preheaderText: `Your quote for booking #${b.id} is still open.`,
                bannerSrc: banner?.src, bannerAlt: banner?.alt, subtitle: banner?.subtitle,
                headline: banner?.headline || 'Your Quote Awaits',
                greeting: `Hi ${b.name},`,
                bodyHtml:
                    `This is a friendly reminder that you have an open quotation for your upcoming <strong style="color:#FAFAFA;">${b.event_type}</strong> on <strong style="color:#FAFAFA;">${b.date}</strong>.` +
                    `<p style="margin:10px 0 0; color:#B0B0B0;">Your quote of <strong style="color:#D4AF37;">R ${parseFloat(b.quote_amount || 0).toFixed(2)}</strong> is still awaiting your response.${expiryNote}</p>` +
                    `<p style="margin:10px 0 0; color:#E6E6E6;">Use the button below to review and accept — the date is still available for you.</p>` +
                    `<p style="margin:10px 0 0; color:#707070; font-size:12px;">If you no longer wish to proceed, simply reply to this email or contact us directly and we will close the enquiry. (Booking reference #${b.id})</p>`,
                cta: { label: 'Review & Accept Quote', url: `${baseUrl}/?track=${b.id}&email=${encodeURIComponent(b.email)}&action=accept` },
                socialLinks: followUpSocialLinks
            });
            const result = await sendEmail({
                to: b.email,
                subject: `Reminder: Your Quote Is Still Open — Ref #${b.id}`,
                htmlContent: emailBody,
                preWrapped: true,
                titleOverride: 'Your Quote Awaits',
                trigger_event: 'Booking: Quote Follow-Up Reminder'
            });
            if (result.success) {
                markQuoteFollowUpSent(b.id);
                sent++;
            } else {
                errors++;
            }
        } catch (e) {
            console.error(`[Quote Follow-Up] Failed for booking ${b.id}:`, e.message);
            errors++;
        }
    }
    console.log(`[Quote Follow-Up Job] Done — sent: ${sent}, errors: ${errors}`);
    return { sent, errors };
}

function registerQuoteFollowUpJob() {
    setTimeout(() => {
        runQuoteFollowUpJob().catch(err => console.error('[Quote Follow-Up Job] Startup run failed:', err.message));
        setInterval(() => {
            runQuoteFollowUpJob().catch(err => console.error('[Quote Follow-Up Job] Scheduled run failed:', err.message));
        }, 24 * 60 * 60 * 1000);
    }, 20000);
}

module.exports = { runQuoteFollowUpJob, registerQuoteFollowUpJob };
