// Phase 5 (HOUSEKEEPING-NOTES.md): relocated from app.js verbatim. Email helpers used only by the
// background scheduled-job functions (lib/*-job.js and lib/background-clerk.js) — not called from
// any route.
const emailComponents = require('../js/emailComponents');
const bannerRegistry = require('../js/bannerRegistry');
const { sendEmail } = require('../js/emailService');
const { escapeEmailFields } = require('./email-escape');
const { getEmailFooterContext } = require('./email-context');

async function sendInvoicePreDueEmail(booking, invoice, daysUntilDue) {
    booking = escapeEmailFields(booking);
    const { id, name, email, event_name, event_type, date } = booking;
    const baseUrl = process.env.BASE_URL || 'https://www.thabisomhlongo.com';
    const payUrl  = `${baseUrl}/?track=${id}&email=${encodeURIComponent(email)}`;
    const amount  = parseFloat(invoice.total_amount || 0).toFixed(2);
    const dueDate = invoice.due_date || '';

    // PAYMENT-CRITICAL: invoice number, due date, `R ${amount}` and payUrl kept verbatim.
    // (The old card used display:flex, which many email clients ignore — infoCard is table-based.)
    const { socialLinks } = await getEmailFooterContext();
    const banner = await bannerRegistry.resolveBanner('invoice_pre_due');
    const html = emailComponents.renderPremiumEmail({
        preheaderText: `Invoice ${invoice.invoice_number || id} is due in ${daysUntilDue} day${daysUntilDue !== 1 ? 's' : ''}.`,
        bannerSrc: banner?.src, bannerAlt: banner?.alt, subtitle: banner?.subtitle,
        headline: banner?.headline || 'Invoice Payment Reminder',
        greeting: `Hi ${name},`,
        bodyHtml:
            `This is a friendly reminder that your invoice for <strong style="color:#FAFAFA;">${event_name || event_type}</strong> on <strong style="color:#FAFAFA;">${date}</strong> is due in <strong style="color:#D4AF37;">${daysUntilDue} day${daysUntilDue !== 1 ? 's' : ''}</strong>.` +
            `<p style="margin:12px 0 0; color:#B0B0B0; font-size:12px;">If you have already arranged payment, please disregard this message. <span style="font-size:12px;">(Booking reference #${id})</span></p>`,
        cards: [{
            title: 'Payment Due',
            rows: [
                { label: 'Invoice #', value: `${invoice.invoice_number || id}` },
                { label: 'Due Date', value: dueDate },
                { label: 'Amount Due', value: `R ${amount}`, highlight: true }
            ]
        }],
        cta: { label: 'Pay Now', url: payUrl },
        socialLinks
    });

    const result = await sendEmail({
        to: email,
        subject: `Invoice Due in ${daysUntilDue} Day${daysUntilDue !== 1 ? 's' : ''} — Booking #${id}`,
        htmlContent: html,
        preWrapped: true,
        titleOverride: 'Invoice Payment Reminder',
        trigger_event: 'Booking: Invoice Pre-Due Reminder'
    });
    return result.success;
}

// Pre-event logistics reminder — a friendly countdown, not a payment nudge (that's the separate
// balance-due reminder). Mirrors sendInvoicePreDueEmail's structure.
async function sendEventReminderEmail(booking, daysBefore) {
    booking = escapeEmailFields(booking);
    const { id, name, email, event_name, event_type, date, event_location } = booking;

    const { socialLinks } = await getEmailFooterContext();
    const banner = await bannerRegistry.resolveBanner('event_reminder');
    const html = emailComponents.renderPremiumEmail({
        preheaderText: `Your event is in ${daysBefore} day${daysBefore !== 1 ? 's' : ''} — ${event_name || event_type}.`,
        bannerSrc: banner?.src, bannerAlt: banner?.alt, subtitle: banner?.subtitle,
        headline: banner?.headline || 'Your Event Is Coming Up',
        greeting: `Hi ${name},`,
        bodyHtml:
            `Just a friendly reminder that <strong style="color:#FAFAFA;">${event_name || event_type}</strong> is coming up in <strong style="color:#D4AF37;">${daysBefore} day${daysBefore !== 1 ? 's' : ''}</strong>! We're looking forward to it.` +
            `<p style="margin:10px 0 0; color:#B0B0B0; font-size:12px;">If anything about your booking has changed, just reply to this email. (Booking reference #${id})</p>`,
        cards: [{
            title: 'Event Details',
            rows: [
                { label: 'Event', value: event_name || event_type },
                { label: 'Date', value: date },
                { label: 'Venue', value: event_location || 'TBD' }
            ]
        }],
        socialLinks
    });

    const result = await sendEmail({
        to: email,
        subject: `Your Event Is in ${daysBefore} Day${daysBefore !== 1 ? 's' : ''} — ${event_name || event_type} (Booking #${id})`,
        htmlContent: html,
        preWrapped: true,
        titleOverride: 'Your Event Is Coming Up',
        trigger_event: 'Booking: Event Reminder'
    });
    return result.success;
}

async function sendOverdueInvoiceEmail(booking, invoice) {
    booking = escapeEmailFields(booking);
    const { id, name, email, event_name, event_type, date } = booking;
    const baseUrl = process.env.BASE_URL || 'https://www.thabisomhlongo.com';
    const payUrl  = `${baseUrl}/?track=${id}&email=${encodeURIComponent(email)}`;
    const amount  = parseFloat(invoice.total_amount || 0).toFixed(2);
    const dueDate = invoice.due_date || '';

    // PAYMENT-CRITICAL: invoice number, due date, `R ${amount}` and payUrl kept verbatim.
    // Red (#ef4444) replaced with the design system's amber alert (no red-on-black per HARD RULES).
    const { socialLinks } = await getEmailFooterContext();
    const banner = await bannerRegistry.resolveBanner('invoice_overdue');
    const html = emailComponents.renderPremiumEmail({
        preheaderText: `Invoice ${invoice.invoice_number || id} is overdue — R ${amount} outstanding.`,
        bannerSrc: banner?.src, bannerAlt: banner?.alt, subtitle: banner?.subtitle,
        headline: banner?.headline || 'Invoice Overdue',
        greeting: `Hi ${name},`,
        bodyHtml:
            `Your invoice for <strong style="color:#FAFAFA;">${event_name || event_type}</strong> on <strong style="color:#FAFAFA;">${date}</strong> was due on <strong style="color:#E8A83E;">${dueDate}</strong> and is now <strong style="color:#E8A83E;">overdue</strong>.` +
            emailComponents.spacer(14) +
            emailComponents.alertStrip({ severity: 'alert', text: 'Please settle this payment at your earliest convenience to avoid any disruption to your booking.' }) +
            `<p style="margin:12px 0 0; color:#B0B0B0; font-size:12px;">If you believe this is an error or have already made payment, please contact us immediately and we will update your records. <span style="font-size:12px;">(Booking reference #${id})</span></p>`,
        cards: [{
            title: 'Outstanding Invoice',
            rows: [
                { label: 'Invoice #', value: `${invoice.invoice_number || id}` },
                { label: 'Was Due', value: dueDate },
                { label: 'Outstanding Amount', value: `R ${amount}`, highlight: true }
            ]
        }],
        cta: { label: 'Pay Now', url: payUrl },
        socialLinks
    });

    const result = await sendEmail({
        to: email,
        subject: `Invoice Overdue — Booking #${id}`,
        htmlContent: html,
        preWrapped: true,
        titleOverride: 'Invoice Overdue',
        trigger_event: 'Booking: Invoice Overdue Reminder'
    });
    return result.success;
}

async function sendQuoteExpiredEmail(booking) {
    booking = escapeEmailFields(booking);
    const { id, name, email, event_name, event_type, date } = booking;
    const { socialLinks } = await getEmailFooterContext();
    const banner = await bannerRegistry.resolveBanner('quote_expired');
    const html = emailComponents.renderPremiumEmail({
        preheaderText: `Your quote for booking #${id} has expired.`,
        bannerSrc: banner?.src, bannerAlt: banner?.alt, subtitle: banner?.subtitle,
        headline: banner?.headline || 'Your Quote Has Expired',
        greeting: `Hi ${name},`,
        bodyHtml: `Your quote for <strong style="color:#FAFAFA;">${event_name || event_type}</strong> on <strong style="color:#FAFAFA;">${date}</strong> has expired and is no longer valid.<br><br>If you're still interested in booking Thabiso Mhlongo for your event, we'd be glad to prepare a fresh quote — just submit a new enquiry and we'll take it from there. <span style="color:#B0B0B0; font-size:13px;">(Booking reference #${id})</span>`,
        cta: { label: 'Submit a New Enquiry', url: `${process.env.SITE_URL || ''}/index.html#booking` },
        socialLinks
    });
    const result = await sendEmail({
        to: email, subject: `Your Quote Has Expired – Booking #${id}`,
        htmlContent: html, preWrapped: true, titleOverride: 'Quote Expired',
        trigger_event: 'Booking: Quote Expired'
    });
    return result.success;
}

async function sendPendingExpiredEmail(booking) {
    booking = escapeEmailFields(booking);
    const { id, name, email, event_name, event_type, date } = booking;
    const { socialLinks } = await getEmailFooterContext();
    const banner = await bannerRegistry.resolveBanner('pending_expired');
    const html = emailComponents.renderPremiumEmail({
        preheaderText: `Enquiry #${id} has expired — you can submit a new one any time.`,
        bannerSrc: banner?.src, bannerAlt: banner?.alt, subtitle: banner?.subtitle,
        headline: banner?.headline || 'Your Enquiry Has Expired',
        greeting: `Hi ${name},`,
        bodyHtml: `Your booking enquiry for <strong style="color:#FAFAFA;">${event_name || event_type}</strong>${date ? ` on <strong style="color:#FAFAFA;">${date}</strong>` : ''} has expired due to inactivity.<br><br>If you're still interested, we'd love to help make your event special — just submit a new enquiry. <span style="color:#B0B0B0; font-size:13px;">(Original reference #${id})</span>`,
        cta: { label: 'Submit a New Enquiry', url: `${process.env.SITE_URL || ''}/index.html#booking` },
        socialLinks
    });
    const result = await sendEmail({
        to: email, subject: `Booking Enquiry Expired – Reference #${id}`,
        htmlContent: html, preWrapped: true, titleOverride: 'Enquiry Expired',
        trigger_event: 'Booking: Enquiry Expired'
    });
    return result.success;
}

module.exports = {
    sendInvoicePreDueEmail, sendEventReminderEmail, sendOverdueInvoiceEmail,
    sendQuoteExpiredEmail, sendPendingExpiredEmail,
};
