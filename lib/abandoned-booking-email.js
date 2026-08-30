// Phase 5 (HOUSEKEEPING-NOTES.md): relocated from app.js verbatim. Shared by the admin
// resend-reminder route (routes/admin/abandoned-bookings.js) and the not-yet-moved automated
// abandoned-booking reminder sweep (still in app.js).
const emailComponents = require('../js/emailComponents');
const bannerRegistry = require('../js/bannerRegistry');
const { sendEmail } = require('../js/emailService');
const { getEmailFooterContext } = require('./email-context');

async function sendAbandonedBookingReminderEmail(draft) {
    if (!draft || !draft.email || draft.opt_out) return false;
    const base = process.env.BASE_URL || 'https://www.thabisomhlongo.com';
    const resumeUrl = `${base}/?resume=${encodeURIComponent(draft.resume_token)}`;
    const optOutUrl = `${base}/api/public/bookings/draft/${encodeURIComponent(draft.resume_token)}/optout`;
    let services = [];
    try { services = draft.services_json ? JSON.parse(draft.services_json) : []; } catch (e) {}
    const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const summaryRows = [
        ['Event', draft.event_name],
        ['Date', draft.event_date],
        ['Type', draft.event_type],
        ['Venue', draft.event_location],
        ['Services', services.map(s => esc(s.name)).filter(Boolean).join(', ')]
    ].filter(r => r[1]).map(r => ({ label: r[0], value: r[1], mono: false }));

    const { socialLinks } = await getEmailFooterContext();
    const banner = await bannerRegistry.resolveBanner('abandoned_booking_recovery');
    const html = emailComponents.renderPremiumEmail({
        preheaderText: "You started a booking request — pick up right where you left off.",
        bannerSrc: banner?.src, bannerAlt: banner?.alt, subtitle: banner?.subtitle,
        headline: banner?.headline || 'Finish Your Booking Request',
        greeting: `Hi ${esc(draft.name || 'there')},`,
        bodyHtml:
            `It looks like you started a booking request for <strong style="color:#D4AF37;">Thabiso Mhlongo</strong> but didn't quite finish. Good news — your details are saved, so you can pick up right where you left off.` +
            `<p style="margin:12px 0 0; color:#B0B0B0; font-size:12px;">Submitting a request doesn't confirm a booking — our team reviews each one and sends a personalised quote, usually within 2 business days.</p>`,
        cards: summaryRows.length ? [{ title: 'Your Booking So Far', rows: summaryRows }] : [],
        cta: { label: 'Resume My Booking', url: resumeUrl },
        unsubscribeUrl: optOutUrl,
        socialLinks
    });
    try {
        const info = await sendEmail({
            to: draft.email,
            subject: 'Complete your booking request — Thabiso Mhlongo',
            htmlContent: html,
            preWrapped: true,
            titleOverride: 'Finish Your Booking Request',
            trigger_event: 'Booking: Recovery Reminder'
        });
        return !!(info && info.success);
    } catch (e) { console.error('[Booking Recovery] reminder email failed:', e.message); return false; }
}

module.exports = { sendAbandonedBookingReminderEmail };
