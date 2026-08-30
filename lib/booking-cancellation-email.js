// Phase 5 (HOUSEKEEPING-NOTES.md): relocated from app.js verbatim — shared by the admin manual
// cancellation routes (not yet moved) and lib/popia.js's notifyPopiaCancellations().
const emailComponents = require('../js/emailComponents');
const bannerRegistry = require('../js/bannerRegistry');
const { sendEmail } = require('../js/emailService');
const { escapeEmailFields } = require('./email-escape');
const { getEmailFooterContext } = require('./email-context');

async function sendCancellationEmail(booking, cancellationData) {
    booking = escapeEmailFields(booking);
    const { id, name, email, event_name, event_type, date } = booking;
    const { reason, refund_due, rule, days_until_event, is_force_majeure } = cancellationData;

    // SC-3: Policy strip — always tells the client which rule was applied and the timing context.
    // Refund figure kept verbatim: R ${parseFloat(refund_due).toFixed(2)}.
    const { socialLinks } = await getEmailFooterContext();
    const policyStrip = rule ? emailComponents.alertStrip({
        severity: is_force_majeure ? 'action' : 'info',
        text: `<strong style="color:${is_force_majeure ? '#D4AF37' : '#B0B0B0'};">${is_force_majeure ? 'Force Majeure — Full Refund Granted' : 'Cancellation Policy Applied'}</strong><br>${rule}` +
              (days_until_event !== null && days_until_event !== undefined
                  ? `<br><span style="font-size:12px;color:#B0B0B0;">Days until event at time of cancellation: <strong>${days_until_event}</strong></span>` : '')
    }) : '';
    const refundHtml = parseFloat(refund_due) > 0
        ? `<p style="margin:14px 0 0;"><strong style="color:#D4AF37;">Refund Due: R ${parseFloat(refund_due).toFixed(2)}</strong><br><span style="color:#B0B0B0;">Your refund will be processed within 5&ndash;7 business days.</span></p>`
        : `<p style="margin:14px 0 0; color:#B0B0B0;">No refund is applicable for this cancellation per our cancellation policy.</p>`;
    const banner = await bannerRegistry.resolveBanner('booking_cancelled');
    const html = emailComponents.renderPremiumEmail({
        preheaderText: `Booking #${id} has been cancelled.`,
        bannerSrc: banner?.src, bannerAlt: banner?.alt, subtitle: banner?.subtitle,
        headline: banner?.headline || 'Booking Cancelled',
        greeting: `Hi ${name},`,
        bodyHtml:
            `We regret to inform you that your booking for <strong style="color:#FAFAFA;">${event_name || event_type}</strong> on <strong style="color:#FAFAFA;">${date}</strong> has been cancelled.` +
            (reason ? `<br><br><strong style="color:#FAFAFA;">Reason:</strong> ${reason}` : '') +
            (policyStrip ? emailComponents.spacer(14) + policyStrip : '') +
            refundHtml +
            `<p style="margin:12px 0 0; color:#B0B0B0;">If you have any questions, please contact us directly. <span style="font-size:13px;">(Booking reference #${id})</span></p>`,
        socialLinks
    });
    const result = await sendEmail({
        to: email,
        subject: `Booking Cancelled – Reference #${id}`,
        htmlContent: html,
        preWrapped: true,
        titleOverride: 'Booking Cancellation',
        trigger_event: 'Booking: Cancellation'
    });
    return result.success;
}

module.exports = { sendCancellationEmail };
