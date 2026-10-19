// Manual EFT - the e-mails. They go through the same sendEmail() / notifications table / premium templates as every other message the site sends.
//
// The wording is part of the safeguard: a client who uploads a proof is told it has been RECEIVED and is being CHECKED - never that a payment
// was received. "Payment verified" is sent only from approval (lib/eft-approval.js), after the ledger has been credited.
const emailComponents = require('../js/emailComponents');
const bannerRegistry = require('../js/bannerRegistry');
const { sendEmail } = require('../js/emailService');
const { escapeEmailHtml } = require('./email-escape');
const { getEmailFooterContext, emailBaseUrl } = require('./email-context');
const { getNotificationEmail } = require('../database/repositories/settings.repository');

const rand = (n) => `R${(parseFloat(n) || 0).toFixed(2)}`;
const trackUrl = (booking) => `${emailBaseUrl()}/?track=${booking.id}&email=${encodeURIComponent(booking.email)}`;
const eventLine = (b) => `<strong style="color:#FAFAFA;">${escapeEmailHtml(b.event_name || b.event_type || 'your event')}</strong> on <strong style="color:#FAFAFA;">${escapeEmailHtml(b.date)}</strong>`;

async function clientEmail(booking, { key, headline, subject, preheader, bodyHtml, cards, titleOverride, trigger_event }) {
    const { socialLinks } = await getEmailFooterContext();
    const banner = await bannerRegistry.resolveBanner(key);
    const html = emailComponents.renderPremiumEmail({
        preheaderText: preheader,
        bannerSrc: banner?.src, bannerAlt: banner?.alt, subtitle: banner?.subtitle,
        headline: banner?.headline || headline,
        greeting: `Hi ${escapeEmailHtml(booking.name)},`,
        bodyHtml, cards,
        cta: { label: 'View Your Booking', url: trackUrl(booking) },
        socialLinks
    });
    const result = await sendEmail({ to: booking.email, subject, htmlContent: html, preWrapped: true, titleOverride, trigger_event });
    return result.success;
}

// The client has uploaded a proof. Received - not paid.
async function sendProofReceivedEmail(booking, submission, reference) {
    return clientEmail(booking, {
        key: 'eft_proof_received',
        // Not "Proof of Payment Received": a headline that reads "Payment Received" is the one thing this e-mail must never say.
        headline: 'We Have Your Proof of Payment',
        subject: `We received your proof of payment – Booking #${booking.id}`,
        preheader: `Your proof of payment for booking #${booking.id} is with our team for checking.`,
        bodyHtml:
            `Thank you. We have received the proof of payment you sent for ${eventLine(booking)}, and our team will now check it against our bank account.` +
            `<p style="margin:12px 0 0; color:#E6E6E6;"><strong style="color:#D4AF37;">This is not yet a confirmation of payment.</strong> Your booking will be updated, and we will email you again, once the payment has been verified.</p>`,
        cards: [{
            title: 'What you sent us',
            rows: [
                { label: 'Amount you reported', value: rand(submission.claimed_amount), highlight: true },
                ...(reference ? [{ label: 'Payment reference', value: reference, mono: true }] : []),
                { label: 'Booking reference', value: `#${booking.id}` }
            ]
        }],
        titleOverride: 'Proof of Payment Submitted',
        trigger_event: 'Booking: EFT Proof Received'
    });
}

// An administrator turned a proof down (kind 'rejected') or asked for a clearer one (kind 'replacement_requested'), with a reason for the client.
async function sendProofRejectedEmail(booking, submission, kind) {
    const replacement = kind === 'replacement_requested';
    const reason = escapeEmailHtml(submission.review_note || '');
    return clientEmail(booking, {
        key: 'eft_proof_rejected',
        headline: replacement ? 'Please Send a Clearer Proof of Payment' : 'We Could Not Accept Your Proof of Payment',
        subject: replacement ? `Please send a new proof of payment – Booking #${booking.id}` : `We could not verify your payment – Booking #${booking.id}`,
        preheader: replacement ? `We need a clearer proof of payment for booking #${booking.id}.` : `Your proof of payment for booking #${booking.id} could not be accepted.`,
        bodyHtml:
            (replacement
                ? `We could not use the proof of payment you sent for ${eventLine(booking)} and would like you to send a new one.`
                : `We were not able to verify the payment you reported for ${eventLine(booking)}.`) +
            (reason ? `<p style="margin:12px 0 0; color:#E6E6E6;"><strong style="color:#D4AF37;">Reason:</strong> ${reason}</p>` : '') +
            `<p style="margin:12px 0 0; color:#E6E6E6;">Nothing has been credited to your booking. You can upload a new proof of payment from your booking page, or pay by card instead. If you believe this is a mistake, simply reply to this email.</p>`,
        cards: [{ title: 'Your submission', rows: [{ label: 'Amount you reported', value: rand(submission.claimed_amount), highlight: true }, { label: 'Booking reference', value: `#${booking.id}` }] }],
        titleOverride: replacement ? 'New Proof of Payment Needed' : 'Proof of Payment Not Accepted',
        trigger_event: replacement ? 'Booking: EFT Replacement Requested' : 'Booking: EFT Proof Rejected'
    });
}

// Sent only after approval has credited the booking: the figures are the ledger's own.
async function sendProofApprovedEmail(booking, submission, totals) {
    const total = parseFloat(booking.total_amount) || 0;
    const outstanding = parseFloat(totals.newOutstanding) || 0;
    const paidInFull = totals.newPaymentStatus === 'PAID';
    return clientEmail(booking, {
        key: 'eft_proof_approved',
        headline: paidInFull ? 'Payment Verified – Paid in Full' : 'Payment Verified',
        subject: `Your EFT payment has been verified – Booking #${booking.id}`,
        preheader: `We verified your ${rand(submission.verified_amount)} payment for booking #${booking.id}.`,
        bodyHtml:
            `Your proof of payment for ${eventLine(booking)} has been checked and your payment of <strong style="color:#D4AF37;">${rand(submission.verified_amount)}</strong> has been applied to your booking.` +
            `<p style="margin:12px 0 0; color:#E6E6E6;">${paidInFull ? 'Your booking is now paid in full.' : 'The remaining balance is shown below and can be paid by card or EFT at any time.'}</p>`,
        cards: [{
            title: 'Payment Summary',
            rows: [
                { label: 'Total', value: rand(total) },
                { label: 'Amount Paid', value: rand(totals.newAmountPaid), highlight: true },
                { label: 'Remaining Balance', rawValue: `<span style="color:${outstanding > 0 ? '#E8A83E' : '#D4AF37'};">${rand(outstanding)}</span>` }
            ]
        }],
        titleOverride: 'Payment Verified',
        trigger_event: 'Booking: EFT Payment Approved'
    });
}

// The owner's inbox: a proof is waiting. Nothing else needs doing until someone looks at it.
async function sendAdminProofNotification(booking, submission) {
    const to = await getNotificationEmail();
    if (!to) return;
    const body = emailComponents.renderSystemEmail({
        preheaderText: `Proof of payment awaiting review for booking #${booking.id} — ${rand(submission.claimed_amount)}.`,
        category: 'Payments & Invoices',
        severity: 'info',
        leadFact: `A client uploaded a proof of payment for booking <strong style="color:#FAFAFA;">#${booking.id}</strong>. It is <strong style="color:#E8A83E;">awaiting review</strong> - nothing has been credited.`,
        cards: [{
            rows: [
                { label: 'Client', value: String(booking.name || '') },
                { label: 'Event', value: `${booking.event_name || booking.event_type || ''} on ${booking.date}`, mono: false },
                { label: 'Amount reported', value: rand(submission.claimed_amount), highlight: true },
                ...(submission.claimed_reference ? [{ label: 'Client reference', value: String(submission.claimed_reference) }] : [])
            ]
        }],
        bodyHtml: `<p style="margin:0; color:#E6E6E6;">Check the amount against the bank statement, then approve or reject it under <strong>Finance &rarr; EFT Payments</strong> in the admin panel.</p>`
    });
    await sendEmail({ to, subject: `EFT proof awaiting review – Booking #${booking.id}`, htmlContent: body, preWrapped: true, replyTo: booking.email, titleOverride: 'EFT Proof Awaiting Review', trigger_event: 'Admin: EFT Proof Submitted' });
}

module.exports = { sendProofReceivedEmail, sendProofRejectedEmail, sendProofApprovedEmail, sendAdminProofNotification };
