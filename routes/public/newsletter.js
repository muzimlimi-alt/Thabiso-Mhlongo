const express = require('express');
const crypto = require('crypto');
const { ipRateLimiter } = require('../../middleware/rate-limiters');
const { sanitizeEmailInput, EMAIL_FORMAT_RE, isValidBirthday } = require('../../lib/validation');
const { CURRENT_POLICY_VERSION } = require('../../lib/booking-policy');
const { getEmailFooterContext, emailBaseUrl } = require('../../lib/email-context');
const { applyMergeFields } = require('../../js/mergeFields');
const { sendNewsletterWelcomeEmail } = require('../../lib/newsletter-emails');
const bannerRegistry = require('../../js/bannerRegistry');
const emailComponents = require('../../js/emailComponents');
const { sendEmail } = require('../../js/emailService');
const {
    insertPendingSubscriber, getSubscriberDuplicateCheck, touchSubscriberCooldown, reactivateSubscriber,
    getSubscriberForConfirm, confirmSubscriber, getSubscriberForUnsubscribe, unsubscribeSubscriber
} = require('../../database/repositories/newsletter.repository');
const router = express.Router();

const NEWSLETTER_PENDING_MESSAGE = 'Almost there! Check your email to confirm your subscription.';

// Fired at signup (and on a cooldown-gated resend) to gate the subscription behind double opt-in.
// Deliberately does NOT fall through to the banner's own headline/subtitle — a custom headline an
// admin later sets on the newsletter_welcome template key must never leak onto this pre-confirmation email.
async function sendNewsletterConfirmationEmail(email, first_name, unsubscribe_token) {
    const { socialLinks } = await getEmailFooterContext();
    const confirmUrl = `${emailBaseUrl()}/confirm-subscription.html?token=${unsubscribe_token}&email=${encodeURIComponent(email)}`;
    const banner = await bannerRegistry.resolveBanner('newsletter_welcome');
    const greeting = applyMergeFields('Hi {{first_name}},', { first_name }, confirmUrl);
    const emailBody = emailComponents.renderPremiumEmail({
        preheaderText: 'One more step — confirm your subscription.',
        bannerSrc: banner?.src, bannerAlt: banner?.alt,
        headline: 'Confirm Your Subscription',
        bodyHtml:
            `<p style="text-align:center;">${greeting}</p>` +
            `<p style="text-align:center;">Please confirm your email address to start receiving Thabiso Mhlongo's newsletter — tour dates, new releases, and exclusive content.</p>` +
            `<p style="text-align:center; color:#B0B0B0;">If you didn't request this, you can safely ignore this email — you won't be subscribed unless you confirm.</p>`,
        cta: { label: 'Confirm My Subscription', url: confirmUrl },
        socialLinks
    });
    return sendEmail({
        to: email,
        subject: "Confirm Your Subscription to Thabiso Mhlongo's Newsletter",
        htmlContent: emailBody,
        preWrapped: true,
        titleOverride: 'Confirm your subscription',
        trigger_event: 'Newsletter: Confirmation Request'
    });
}

router.post('/api/public/subscribe', ipRateLimiter, (req, res) => {
    let { email, popia_consent, first_name, birthday_day, birthday_month } = req.body;
    if (!email) {
        return res.status(400).json({ success: false, message: 'Email is required' });
    }
    email = sanitizeEmailInput(email);
    if (!EMAIL_FORMAT_RE.test(email)) {
        return res.status(400).json({ success: false, message: 'Please enter a valid email address.' });
    }
    first_name = (typeof first_name === 'string') ? sanitizeEmailInput(first_name).slice(0, 100) : '';
    if (!first_name) {
        return res.status(400).json({ success: false, message: 'First name is required.' });
    }

    // Validate POPIA consent
    if (!popia_consent) {
        return res.status(400).json({ success: false, message: 'POPIA consent is required to subscribe.' });
    }

    // Birthday is optional — day/month only, never a year (see newsletter_subscribers schema).
    let birthdayDayVal = null, birthdayMonthVal = null;
    const hasDay = birthday_day != null && birthday_day !== '';
    const hasMonth = birthday_month != null && birthday_month !== '';
    if (hasDay || hasMonth) {
        if (!hasDay || !hasMonth || !isValidBirthday(birthday_day, birthday_month)) {
            return res.status(400).json({ success: false, message: 'Please provide a valid birthday day and month.' });
        }
        birthdayDayVal = parseInt(birthday_day, 10);
        birthdayMonthVal = parseInt(birthday_month, 10);
    }

    const ip_address = req.ip || req.connection.remoteAddress || 'unknown';
    const user_agent = req.get('User-Agent') || 'unknown';
    const source = 'index.html';
    console.log(`[Newsletter] Attempting subscription for: ${email} from ${ip_address}`);

    const unsubscribe_token = crypto.randomBytes(16).toString('hex');

    // Double opt-in: new signups start pending, not active — they only count toward campaigns
    // (status='active' everywhere) and get the real welcome email once they confirm.
    insertPendingSubscriber(email, unsubscribe_token, ip_address, user_agent, source, CURRENT_POLICY_VERSION, first_name, birthdayDayVal, birthdayMonthVal, function(err) {
        if (err) {
            if (!err.message.includes('UNIQUE')) {
                console.error("Newsletter Subscription DB Error:", err.message);
                return res.status(500).json({ success: false, message: 'Server error: ' + err.message });
            }
            // Duplicate email — branch on the existing row's status rather than a flat reject.
            // All non-'active' branches return the SAME response body: differentiating "brand new"
            // vs. "resend" vs. "reactivating" in the response would let an attacker learn an
            // email's subscription history without ever proving they control that inbox.
            getSubscriberDuplicateCheck(email, (selErr, row) => {
                if (selErr || !row) return res.status(500).json({ success: false, message: 'Server error.' });

                if (row.status === 'active') {
                    return res.status(409).json({ success: false, message: 'You are already subscribed!' });
                }

                if (row.status === 'pending_confirmation') {
                    // Cooldown-gated resend (5 min, keyed off modified_on — no new column) so
                    // repeatedly resubmitting the same email can't be used to bomb an inbox.
                    touchSubscriberCooldown(row.subscriber_id, function(cooldownErr) {
                        if (!cooldownErr && this.changes > 0) {
                            sendNewsletterConfirmationEmail(email, first_name, row.unsubscribe_token).catch(e => console.error('Error resending confirmation email to ' + email + ':', e));
                        }
                        res.json({ success: true, message: NEWSLETTER_PENDING_MESSAGE });
                    });
                    return;
                }

                // status === 'unsubscribed' (the bug fix): a genuine resubscribe. Reuse the
                // existing unsubscribe_token (any unsubscribe link from a past campaign keeps working)
                // and re-capture consent/profile fields fresh from this submission.
                reactivateSubscriber(CURRENT_POLICY_VERSION, first_name, birthdayDayVal, birthdayMonthVal, ip_address, user_agent, source, row.subscriber_id, (reErr) => {
                    if (reErr) return res.status(500).json({ success: false, message: 'Server error.' });
                    sendNewsletterConfirmationEmail(email, first_name, row.unsubscribe_token).catch(e => console.error('Error sending confirmation email to ' + email + ':', e));
                    res.json({ success: true, message: NEWSLETTER_PENDING_MESSAGE });
                });
            });
            return;
        }
        console.log(`[Newsletter] DB Insert SUCCESS (pending confirmation) for: ${email}`);

        sendNewsletterConfirmationEmail(email, first_name, unsubscribe_token)
            .catch(e => console.error("Error sending confirmation email to " + email + ":", e));

        res.json({ success: true, message: NEWSLETTER_PENDING_MESSAGE });
    });
});

// Confirm a pending subscription (double opt-in).
router.post('/api/public/newsletter/confirm', ipRateLimiter, (req, res) => {
    const { email, token } = req.body;
    if (!email || !token) {
        return res.status(400).json({ success: false, message: 'Missing required parameters.' });
    }

    getSubscriberForConfirm(email, token, (err, row) => {
        if (err) return res.status(500).json({ success: false, error: err.message });
        if (!row) return res.status(404).json({ success: false, message: 'Invalid confirmation link or subscriber not found.' });

        if (row.status === 'active') {
            return res.json({ success: true, message: 'Your subscription is already confirmed!', alreadyConfirmed: true });
        }
        if (row.status !== 'pending_confirmation') {
            // e.g. 'unsubscribed' — a stale confirm link from before they unsubscribed must NOT
            // silently reactivate them; that would bypass the POPIA consent re-capture that a
            // genuine resubscribe through the public form always performs.
            return res.status(409).json({ success: false, message: 'This subscription is no longer active. Please sign up again to resubscribe.' });
        }

        confirmSubscriber(row.subscriber_id, (uErr) => {
            if (uErr) return res.status(500).json({ success: false, error: uErr.message });
            sendNewsletterWelcomeEmail(email, row.first_name, row.unsubscribe_token).catch(e => console.error('Error sending welcome email to ' + email + ':', e));
            res.json({ success: true, message: 'Subscription confirmed! Welcome aboard.' });
        });
    });
});

// Unsubscribe API
router.post('/api/public/newsletter/unsubscribe', ipRateLimiter, (req, res) => {
    const { email, token } = req.body;
    if (!email || !token) {
        return res.status(400).json({ success: false, message: 'Missing required parameters.' });
    }

    getSubscriberForUnsubscribe(email, token, (err, row) => {
        if (err) return res.status(500).json({ success: false, error: err.message });
        if (!row) return res.status(404).json({ success: false, message: 'Invalid unsubscription link or subscriber not found.' });

        unsubscribeSubscriber(row.subscriber_id, (uErr) => {
            if (uErr) return res.status(500).json({ success: false, error: uErr.message });
            res.json({ success: true, message: 'Successfully unsubscribed.' });
        });
    });
});

module.exports = router;
