// Newsletter-related email senders — Phase 5 of the housekeeping effort (HOUSEKEEPING-NOTES.md).
// Moved out of the app.js monolith byte-identical, one function at a time as the batch that needs
// it comes up (this file will grow with sendNewsletterConfirmationEmail and others in a later
// newsletter batch).
const emailComponents = require('../js/emailComponents');
const bannerRegistry = require('../js/bannerRegistry');
const { sendEmail } = require('../js/emailService');
const { applyMergeFields } = require('../js/mergeFields');
const { getEmailFooterContext, emailBaseUrl } = require('./email-context');

// Fired once a subscriber is confirmed (public double opt-in confirm, or an admin manually
// activating a still-pending row). Unchanged from the email this always used to send at signup.
async function sendNewsletterWelcomeEmail(email, first_name, unsubscribe_token) {
    const { socialLinks } = await getEmailFooterContext();
    const unsubscribeUrl = `${emailBaseUrl()}/unsubscribe.html?token=${unsubscribe_token}&email=${encodeURIComponent(email)}`;
    const banner = await bannerRegistry.resolveBanner('newsletter_welcome');
    const greeting = applyMergeFields('Hi {{first_name}},', { first_name }, unsubscribeUrl);
    const emailBody = emailComponents.renderPremiumEmail({
        preheaderText: "You're on the list — welcome to the newsletter!",
        bannerSrc: banner?.src, bannerAlt: banner?.alt, subtitle: banner?.subtitle,
        headline: banner?.headline || "You're On The List!",
        bodyHtml:
            `<p style="text-align:center;">${greeting}</p>` +
            `<p style="text-align:center;">Thank you for subscribing to my official newsletter. I truly appreciate your support. You will now be the first to know about my upcoming stand-up tour dates, new video releases, and exclusive content.</p>` +
            `<p style="text-align:center; color:#B0B0B0;">Rest assured, your email address will be used responsibly and will never be shared with third parties.</p>` +
            `<p style="text-align:center; margin-top:18px; color:#B0B0B0;">Stay funny,<br><span style="font-family:'Cormorant Garamond',Georgia,serif; font-size:18px; color:#D4AF37;">Thabiso Mhlongo</span></p>`,
        unsubscribeUrl,
        socialLinks
    });
    return sendEmail({
        to: email,
        subject: "Welcome to Thabiso Mhlongo's Newsletter!",
        htmlContent: emailBody,
        preWrapped: true,
        titleOverride: "You're on the list!",
        trigger_event: 'Newsletter: Welcome Receipt'
    });
}

module.exports = { sendNewsletterWelcomeEmail };
