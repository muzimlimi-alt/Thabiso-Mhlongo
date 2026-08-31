// Phase 5 (HOUSEKEEPING-NOTES.md): relocated from app.js verbatim. Quote/confirmation/reminder/
// review-request emails plus the state-aware remindBooking() orchestrator, shared between
// routes/admin/bookings.js's email-action routes (resend-quote, resend-confirmation, review-request,
// remind, bulk-remind) and several not-yet-moved call sites (the admin quote route, payment
// processing, cron jobs) — app.js re-imports whichever of these it still needs.
const fs = require('fs');
const path = require('path');
const moment = require('moment-timezone');
const emailComponents = require('../js/emailComponents');
const bannerRegistry = require('../js/bannerRegistry');
const { sendEmail } = require('../js/emailService');
const { escapeEmailFields } = require('./email-escape');
const { getEmailFooterContext, emailBaseUrl } = require('./email-context');
const { getVatRate } = require('./document-totals');
const { dbGet, dbRun } = require('./db-helpers');
const { resolveDocsPath } = require('./runtime-paths');
const { sendInvoiceEmail } = require('./invoice-email');
const db = require('../database');
const { getNotificationEmail } = require('../database/repositories/settings.repository');
const {
    getPaymentSchedulesForDocument, getExpensesForBookingEmail
} = require('../database/repositories/finance.repository');
const {
    getInvoiceForPaidReceipt, getInvoiceTaxAmountForBooking, getQuoteTaxAmountForBooking
} = require('../database/repositories/invoices-quotations.repository');

function generateBookingICS(booking) {
    try {
        const ical = require('ical-generator').default;
        const cal = ical({ name: 'Thabiso Mhlongo Event' });
        const startTime = booking.event_start_time || '18:00';
        const startDt = moment(`${booking.date}T${startTime}`);

        // Resolve end time (priority: slot range > duration > 2 h default)
        let endDt;
        const slotMatch = (booking.performance_slot || '').match(/(\d{1,2}:\d{2})\s*[–\-]\s*(\d{1,2}:\d{2})/);
        if (slotMatch) {
            endDt = moment(`${booking.date}T${slotMatch[2]}`);
            if (endDt.isSameOrBefore(startDt)) endDt.add(1, 'day'); // midnight crossover
        } else {
            const durStr = booking.performance_duration || '';
            const minMatch = durStr.match(/^(\d+)\s*min/i);               // "45 min"
            const hmMatch  = durStr.match(/^(\d+)h(?:\s*(\d+)m)?/i);     // "2h" / "1h 30m"
            const durationH = minMatch
                ? parseInt(minMatch[1]) / 60
                : hmMatch
                    ? parseInt(hmMatch[1]) + (hmMatch[2] ? parseInt(hmMatch[2]) / 60 : 0)
                    : (parseFloat(durStr) || 2);
            endDt = startDt.clone().add(durationH, 'hours');
        }

        cal.createEvent({
            uid: `booking-${booking.id}@thabisomhlongo.com`,
            start: startDt,
            end: endDt,
            summary: (booking.event_name || booking.event_type || 'Event') + ' – Thabiso Mhlongo',
            description: `Booking Reference: #${booking.id}\nClient: ${booking.name}`,
            location: booking.event_location || '',
            url: `${process.env.BASE_URL || 'https://www.thabisomhlongo.com'}/booking?id=${booking.id}`
        });
        return cal.toString();
    } catch (e) {
        console.error('ICS generation error:', e.message);
        return null;
    }
}

async function sendQuoteEmail(booking, amount, pdfPath, pdfFileName, items = []) {
    booking = escapeEmailFields(booking);
    const { id, name, email, event_name, event_type, date } = booking;

    let attachments = [];
    if (pdfPath && fs.existsSync(pdfPath)) {
        attachments.push({
            filename: pdfFileName || `Quote_${id}_Thabiso_Mhlongo.pdf`,
            path: pdfPath,
            contentType: 'application/pdf'
        });
    }

    let itemsHtml = '';
    if (items && items.length > 0) {
        itemsHtml = '<div style="margin: 20px 0; padding: 15px; background: #111; border-radius: 4px;">';
        itemsHtml += '<h3 style="margin-top:0; font-size:14px; color:#D4AF37;">Service Breakdown:</h3>';
        itemsHtml += '<table style="width:100%; font-size:13px; color:#ccc;">';
        let subtotal = 0;
        items.forEach(it => {
            const qty = parseFloat(it.quantity_minutes) || parseFloat(it.quantity) || 0;
            const p = parseFloat(it.unit_price) || 0;
            const model = it.pricing_model || 'flat';
            const total = (qty === 0 && (model === 'flat' || model === 'flat_fee')) ? p : (qty * p);
            const desc = it.description || it.service_name || it.name;
            subtotal += total;

            let qtyStr = '';
            if (model === 'per_minute') {
                qtyStr = `${qty} min × R ${p.toFixed(2)}`;
            } else if (model === 'per_hour') {
                qtyStr = `${qty} hr × R ${p.toFixed(2)}`;
            } else if (model === 'flat' || model === 'flat_fee') {
                qtyStr = qty > 1 ? `${qty} × R ${p.toFixed(2)}` : 'Flat Fee';
            } else {
                qtyStr = `${qty} × R ${p.toFixed(2)}`;
            }

            itemsHtml += `<tr>
                <td style="padding:4px 0;">${desc}</td>
                <td style="padding:4px 0; text-align:right;">${qtyStr}</td>
                <td style="padding:4px 0; text-align:right; color:#fff;">R ${total.toFixed(2)}</td>
            </tr>`;
        });

        const discount = parseFloat(booking.discount) || 0;
        const applyVat = booking.apply_vat;

        itemsHtml += `<tr style="border-top: 1px solid #333;">
            <td style="padding:4px 0;"><strong>Subtotal</strong></td>
            <td></td>
            <td style="padding:4px 0; text-align:right;"><strong>R ${subtotal.toFixed(2)}</strong></td>
        </tr>`;

        let vatable = subtotal;
        if (discount > 0) {
            itemsHtml += `<tr>
                <td style="padding:4px 0;">Discount</td>
                <td></td>
                <td style="padding:4px 0; text-align:right; color:#ff4d4d;">- R ${discount.toFixed(2)}</td>
            </tr>`;
            vatable = Math.max(0, subtotal - discount);
        }

        const vatRate = await getVatRate();
        if (applyVat) {
            const vat = vatable * vatRate;
            const total = vatable + vat;
            itemsHtml += `<tr>
                <td style="padding:4px 0;">VAT (${(vatRate * 100).toFixed(0)}%)</td>
                <td></td>
                <td style="padding:4px 0; text-align:right;">R ${vat.toFixed(2)}</td>
            </tr>`;
            itemsHtml += `<tr>
                <td style="padding:4px 0;"><strong style="color:#D4AF37;">Total (Incl. VAT)</strong></td>
                <td></td>
                <td style="padding:4px 0; text-align:right;"><strong style="color:#D4AF37;">R ${total.toFixed(2)}</strong></td>
            </tr>`;
        } else {
            itemsHtml += `<tr>
                <td style="padding:4px 0;"><strong style="color:#D4AF37;">Total</strong></td>
                <td></td>
                <td style="padding:4px 0; text-align:right;"><strong style="color:#D4AF37;">R ${vatable.toFixed(2)}</strong></td>
            </tr>`;
        }

        itemsHtml += '</table></div>';
    }

    // NOTE: itemsHtml + `${amount || booking.quote_amount}` carry computed figures — kept verbatim.
    const { socialLinks } = await getEmailFooterContext();
    const banner = await bannerRegistry.resolveBanner('quote');
    const acceptUrl = `${process.env.BASE_URL || 'https://www.thabisomhlongo.com'}/?track=${id}&email=${encodeURIComponent(email)}&action=accept`;
    const bodyHtml =
        `We've prepared a formal quotation for your upcoming event, <strong style="color:#FAFAFA;">${event_name || event_type}</strong> on <strong style="color:#FAFAFA;">${date}</strong>. The full breakdown of services and terms is attached as a PDF for your records.` +
        `<br><br><strong style="color:#D4AF37;">Terms &amp; Policies:</strong><br>${booking.terms || 'Standard cancellation policy applies.'}` +
        itemsHtml +
        `<p style="margin:14px 0 0;"><strong style="color:#FAFAFA;">Total Quote: ${amount || booking.quote_amount}</strong></p>` +
        `<p style="margin:10px 0 0; color:#E6E6E6;">To secure this date, please review and accept the quotation via your booking portal.</p>`;
    const html = emailComponents.renderPremiumEmail({
        preheaderText: `Your quotation for booking #${id} is ready to review.`,
        bannerSrc: banner?.src, bannerAlt: banner?.alt, subtitle: banner?.subtitle,
        headline: banner?.headline || 'Your Quotation',
        greeting: `Hi ${name},`,
        bodyHtml,
        cta: { label: 'Review & Accept Quote', url: acceptUrl },
        socialLinks
    });

    const result = await sendEmail({
        to: email,
        subject: `Quotation for Booking #${id}`,
        htmlContent: html,
        preWrapped: true,
        attachments: attachments,
        titleOverride: 'Your Quotation',
        trigger_event: 'Booking: Quote Generated'
    });

    return result.success;
}

// S2-2: Notify all admin users when a quote has been dispatched to a client
async function sendAdminQuoteSentNotification(booking, amount) {
    // event_name was used in the template below but never destructured, so this function threw
    // ReferenceError on every call. The throw was swallowed by the caller's .catch(), meaning the
    // admin has never actually received a "quote sent" notification.
    const { id, name, email, event_name, date } = booking;
    const notifEmail = await getNotificationEmail();
    const emailBody = emailComponents.renderSystemEmail({
        preheaderText: `Quote sent to ${name} for booking #${id}.`,
        category: 'Quotes & Proposals',
        severity: 'info',
        leadFact: `A quotation has been dispatched to the client for Booking <strong style="color:#FAFAFA;">#${id}</strong>.`,
        bodyHtml: `<p style="margin:0; color:#B0B0B0;">The client has been emailed their quote PDF and a direct link to accept it. Log in to the Admin Dashboard to track the response.</p>`,
        cards: [{
            title: 'Quote Details',
            rows: [
                { label: 'Client', value: name, mono: false },
                { label: 'Client Email', value: email },
                { label: 'Event', value: `${event_name} • ${date}`, mono: false },
                { label: 'Quote Amount', value: `${amount || booking.quote_amount}`, highlight: true }
            ]
        }]
    });
    return sendEmail({
        to: notifEmail,
        subject: `Quote Sent — Booking #${id} (${name})`,
        htmlContent: emailBody,
        preWrapped: true,
        titleOverride: `Quote Dispatched — #${id}`,
        trigger_event: 'Booking: Quote Sent (Admin Notification)'
    });
}

async function sendBookingConfirmedEmail(booking) {
    booking = escapeEmailFields(booking);
    const { id, name, email, event_name, event_type, date, event_location, performance_slot, performance_duration } = booking;

    const { socialLinks } = await getEmailFooterContext();
    const cardRows = [
        { label: 'Event', value: event_name || event_type, mono: false },
        { label: 'Date', value: date },
        { label: 'Venue', value: event_location || 'TBD', mono: false }
    ];
    if (performance_slot) cardRows.push({ label: 'Performance Slot', value: performance_slot, mono: false });
    if (performance_duration) cardRows.push({ label: 'Duration', value: performance_duration, mono: false });
    cardRows.push({ label: 'Reference', value: `#${id}` });

    const banner = await bannerRegistry.resolveBanner('booking_confirmed');
    const html = emailComponents.renderPremiumEmail({
        preheaderText: `Booking #${id} is confirmed — see you on ${date}!`,
        bannerSrc: banner?.src, bannerAlt: banner?.alt, subtitle: banner?.subtitle,
        headline: banner?.headline || 'Your Booking Is Confirmed',
        greeting: `Hi ${name},`,
        bodyHtml:
            `Wonderful news — your booking for <strong style="color:#FAFAFA;">${event_name || event_type}</strong> on <strong style="color:#FAFAFA;">${date}</strong> at <strong style="color:#FAFAFA;">${event_location || 'TBD'}</strong> is now fully <strong style="color:#D4AF37;">CONFIRMED</strong>.<br><br>Thabiso Mhlongo is excited to be part of your event, and our team will be in touch with any final logistics closer to the date.<br><br><span style="color:#B0B0B0; font-size:13px;">We've attached a calendar invite (.ics) so you can save the event to your calendar.</span>`,
        cards: [{ title: 'Confirmed Booking', rows: cardRows }],
        cta: { label: 'View Your Booking', url: `${emailBaseUrl()}/?track=${id}&email=${encodeURIComponent(email)}` },
        socialLinks
    });

    const icsContent = generateBookingICS(booking);
    const attachments = icsContent ? [{
        filename: `Booking_${id}_Thabiso_Mhlongo.ics`,
        content: Buffer.from(icsContent),
        contentType: 'text/calendar; method=REQUEST'
    }] : [];

    const result = await sendEmail({
        to: email,
        subject: `Booking Confirmed 🎉 – #${id}`,
        htmlContent: html,
        preWrapped: true,
        attachments,
        titleOverride: 'Booking Confirmed!',
        trigger_event: 'Booking: Final Confirmation'
    });

    return result.success;
}

async function sendDepositBalanceDueEmail(booking, outstanding) {
    booking = escapeEmailFields(booking);
    const { id, name, email, event_name, event_type, date, event_location } = booking;
    // PAYMENT-CRITICAL: `R${parseFloat(outstanding).toFixed(2)}` kept verbatim (subject + body).
    const { socialLinks } = await getEmailFooterContext();
    const banner = await bannerRegistry.resolveBanner('deposit_balance_due');
    const html = emailComponents.renderPremiumEmail({
        preheaderText: `Deposit received — balance of R${parseFloat(outstanding).toFixed(2)} due for booking #${id}.`,
        bannerSrc: banner?.src, bannerAlt: banner?.alt, subtitle: banner?.subtitle,
        headline: banner?.headline || 'Deposit Received',
        greeting: `Hi ${name},`,
        bodyHtml:
            `Thank you for your deposit payment for <strong style="color:#FAFAFA;">${event_name || event_type}</strong> on <strong style="color:#FAFAFA;">${date}</strong>. Your booking is confirmed.` +
            `<p style="margin:10px 0 0; color:#B0B0B0; font-size:13px;">Please ensure payment is received at least 48 hours before the event. <span>(Booking reference #${id})</span></p>`,
        cards: [{
            title: 'Balance Due',
            rows: [{ label: 'Remaining Balance', value: `R${parseFloat(outstanding).toFixed(2)}`, highlight: true }]
        }],
        cta: { label: 'Settle Your Balance', url: `${process.env.SITE_URL || ''}/index.html#track` },
        socialLinks
    });
    const result = await sendEmail({
        to: email, subject: `Deposit Received – Balance Due R${parseFloat(outstanding).toFixed(2)} | Booking #${id}`,
        htmlContent: html, preWrapped: true, titleOverride: 'Deposit Received – Balance Reminder',
        trigger_event: 'Booking: Deposit Received, Balance Due'
    });
    return result.success;
}

async function sendQuoteExpiryWarningEmail(booking) {
    booking = escapeEmailFields(booking);
    const { id, name, email, event_name, event_type, date, quote_expiry_date } = booking;
    const { socialLinks } = await getEmailFooterContext();
    const banner = await bannerRegistry.resolveBanner('quote_expiry_warning');
    const html = emailComponents.renderPremiumEmail({
        preheaderText: `Your quote for booking #${id} expires tomorrow.`,
        bannerSrc: banner?.src, bannerAlt: banner?.alt, subtitle: banner?.subtitle,
        headline: banner?.headline || 'Your Quote Expires Tomorrow',
        greeting: `Hi ${name},`,
        bodyHtml: `Your quote for <strong style="color:#FAFAFA;">${event_name || event_type}</strong> on <strong style="color:#FAFAFA;">${date}</strong> expires <strong style="color:#D4AF37;">tomorrow (${quote_expiry_date})</strong>. Accept it now via your booking tracker before it lapses.`,
        cta: { label: 'Accept Your Quote', url: `${process.env.SITE_URL || ''}/index.html#track` },
        socialLinks
    });
    return sendEmail({ to: email, subject: `Your Quote Expires Tomorrow – Booking #${id}`,
        htmlContent: html, preWrapped: true, titleOverride: 'Quote Expiring Soon', trigger_event: 'Booking: Quote Expiry Warning' });
}

async function sendReviewRequestEmail(booking) {
    booking = escapeEmailFields(booking);
    const { id, name, email, event_name, event_type, date } = booking;
    const { socialLinks } = await getEmailFooterContext();
    const banner = await bannerRegistry.resolveBanner('review_request');
    const html = emailComponents.renderPremiumEmail({
        preheaderText: `How was your event? We'd love your feedback on booking #${id}.`,
        bannerSrc: banner?.src, bannerAlt: banner?.alt, subtitle: banner?.subtitle,
        headline: banner?.headline || "We'd Love Your Feedback",
        greeting: `Hi ${name},`,
        bodyHtml: `We hope your event — <strong style="color:#FAFAFA;">${event_name || event_type}</strong> on <strong style="color:#FAFAFA;">${date}</strong> — was everything you imagined!<br><br>If you enjoyed working with Thabiso, a short review or testimonial would mean the world to us.`,
        cta: { label: 'Send Your Review', url: `mailto:info@thabisomhlongo.com?subject=Review for Booking %23${id}` },
        socialLinks
    });
    return sendEmail({ to: email, subject: `How was your event? – Booking #${id}`,
        htmlContent: html, preWrapped: true, titleOverride: "We'd Love Your Feedback!", trigger_event: 'Booking: Review Request' });
}

// State-aware per-booking reminder. Picks the reminder appropriate to where the booking is in the
// lifecycle and returns what it did. Shared by the single-booking route and the bulk action.
// Throttling reuses existing state: the contract reminder is gated by contracts.sent_to_client_at,
// the balance reminder by a reminders_log row (schedule_id NULL, days_before=0 sentinel — distinct
// from the 7/3/1 pre-event reminders and the milestone reminders which carry a non-NULL schedule_id).
async function remindBooking(bookingId) {
    const b = await dbGet(
        `SELECT b.id, COALESCE(c.full_name, b.name) AS name, COALESCE(c.email, b.email) AS email,
                b.event_name, b.event_type, b.date, b.status, b.amount_outstanding, b.quote_expiry_date
         FROM bookings b LEFT JOIN clients c ON b.client_id = c.id WHERE b.id = ?`, [bookingId]);
    if (!b) return { booking_id: bookingId, sent: false, skipped: 'not found' };

    const status = (b.status || '').toUpperCase();
    const todayLocal = moment().tz('Africa/Johannesburg').format('YYYY-MM-DD');

    // 1. QUOTED and not expired → quote follow-up.
    if (status === 'QUOTED' && (!b.quote_expiry_date || b.quote_expiry_date >= todayLocal)) {
        await sendQuoteExpiryWarningEmail(b);
        return { booking_id: bookingId, sent: true, type: 'quote' };
    }

    // 2. Committed with a contract sent but not yet client-signed → contract signing reminder.
    if (['ACCEPTED', 'CONFIRMED'].includes(status)) {
        const contract = await dbGet("SELECT status, is_frozen, sent_to_client_at, signed_by_client_at FROM contracts WHERE booking_id = ?", [bookingId]);
        if (contract && contract.status === 'sent' && !contract.signed_by_client_at && contract.is_frozen !== 1) {
            const last = contract.sent_to_client_at ? moment(contract.sent_to_client_at) : null;
            if (last && moment().diff(last, 'hours') < 24) return { booking_id: bookingId, sent: false, skipped: 'contract reminded <24h ago' };
            const { socialLinks: remindSocialLinks } = await getEmailFooterContext();
            const remindBanner = await bannerRegistry.resolveBanner('contract_sign_reminder');
            await sendEmail({
                to: b.email,
                subject: `Action Required: Please sign your booking contract — ${b.event_name || b.event_type}`,
                htmlContent: emailComponents.renderPremiumEmail({
                    preheaderText: `Your booking contract for ${b.event_name || b.event_type} is awaiting your signature.`,
                    bannerSrc: remindBanner?.src, bannerAlt: remindBanner?.alt, subtitle: remindBanner?.subtitle,
                    headline: remindBanner?.headline || 'Contract Signature Reminder',
                    greeting: `Hi ${b.name},`,
                    bodyHtml:
                        `A friendly reminder that your booking contract for <strong style="color:#FAFAFA;">${b.event_name || b.event_type}</strong> on ${b.date} is awaiting your signature. You can review and sign it from your booking page.`,
                    cta: { label: 'Review & Sign Contract', url: `${emailBaseUrl()}/?track=${bookingId}&email=${encodeURIComponent(b.email)}` },
                    socialLinks: remindSocialLinks
                }),
                preWrapped: true,
                titleOverride: 'Contract Signature Reminder',
                trigger_event: 'Admin: Contract Remind'
            });
            await dbRun("UPDATE contracts SET sent_to_client_at = CURRENT_TIMESTAMP WHERE booking_id = ?", [bookingId]);
            return { booking_id: bookingId, sent: true, type: 'contract' };
        }
    }

    // 3. CONFIRMED with an outstanding balance → balance-due reminder.
    if (status === 'CONFIRMED' && (parseFloat(b.amount_outstanding) || 0) > 0.01) {
        const recent = await dbGet(
            "SELECT id FROM reminders_log WHERE booking_id = ? AND schedule_id IS NULL AND days_before = 0 AND sent_at > datetime('now','-24 hours')",
            [bookingId]);
        if (recent) return { booking_id: bookingId, sent: false, skipped: 'balance reminded <24h ago' };
        await sendDepositBalanceDueEmail(b, b.amount_outstanding);
        await dbRun(
            "INSERT INTO reminders_log (booking_id, schedule_id, days_before, due_date, amount_due, recipient_email, status) VALUES (?, NULL, 0, ?, ?, ?, 'sent')",
            [bookingId, b.date || todayLocal, b.amount_outstanding, b.email]);
        return { booking_id: bookingId, sent: true, type: 'balance' };
    }

    return { booking_id: bookingId, sent: false, skipped: 'nothing due' };
}

async function sendDateChangedEmail(booking, oldDate, newDate) {
    booking = escapeEmailFields(booking);
    const { id, name, email, event_name, event_type } = booking;
    const baseUrl = process.env.BASE_URL || 'https://www.thabisomhlongo.com';
    const trackUrl = `${baseUrl}/?track=${id}&email=${encodeURIComponent(email)}`;
    const { socialLinks } = await getEmailFooterContext();
    const banner = await bannerRegistry.resolveBanner('booking_date_changed');
    const html = emailComponents.renderPremiumEmail({
        preheaderText: `Booking #${id}: the event date changed to ${newDate}.`,
        bannerSrc: banner?.src, bannerAlt: banner?.alt, subtitle: banner?.subtitle,
        headline: banner?.headline || 'Event Date Updated',
        greeting: `Hi ${name},`,
        bodyHtml: `Please note that the date for your booking <strong style="color:#FAFAFA;">#${id}</strong> — <strong style="color:#FAFAFA;">${event_name || event_type}</strong> — has been updated. Please update your calendar accordingly.<br><br><span style="color:#B0B0B0; font-size:13px;">If this change was made in error or you have any concerns, please contact us immediately at <a href="mailto:bookings@thabisomhlongo.com" style="color:#D4AF37;">bookings@thabisomhlongo.com</a>.</span>`,
        cards: [{
            title: 'Date Change',
            rows: [
                { label: 'Previous Date', rawValue: `<span style="text-decoration:line-through; color:#707070;">${oldDate}</span>` },
                { label: 'New Date', value: newDate, highlight: true }
            ]
        }],
        cta: { label: 'View My Booking', url: trackUrl },
        socialLinks
    });
    return sendEmail({ to: email, subject: `Event Date Updated – Booking #${id}`,
        htmlContent: html, preWrapped: true, titleOverride: 'Event Date Changed', trigger_event: 'Booking: Date Changed' });
}

async function sendQuoteAcceptedEmail(booking, options = {}) {
    booking = escapeEmailFields(booking);
    const { invoiceGenerated = true } = options;
    const { id, name, email, event_name, event_type, date } = booking;

    // Fetch payment schedule to include in the confirmation email
    const schedules = await getPaymentSchedulesForDocument(id);

    const scheduleTableRows = schedules.length > 0
        ? schedules.map(s => `
            <tr>
                <td style="padding:8px 12px;border-bottom:1px solid #333;color:#ccc;">${s.description}</td>
                <td style="padding:8px 12px;border-bottom:1px solid #333;color:#ccc;">${s.due_date}</td>
                <td style="padding:8px 12px;border-bottom:1px solid #333;color:#D4AF37;font-weight:600;">R ${parseFloat(s.expected_amount).toFixed(2)}</td>
            </tr>`
        ).join('')
        : `<tr><td colspan="3" style="padding:8px 12px;color:#888;text-align:center;">No schedule on record — our team will send payment details shortly.</td></tr>`;

    const paymentScheduleHtml = `
        <div style="margin:20px 0;">
            <h3 style="color:#D4AF37;font-size:14px;letter-spacing:1px;text-transform:uppercase;margin-bottom:10px;">Payment Schedule</h3>
            <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;background:#111;border:1px solid #333;border-radius:4px;">
                <thead>
                    <tr style="background:#1a1a1a;">
                        <th style="padding:8px 12px;text-align:left;color:#D4AF37;font-size:11px;text-transform:uppercase;letter-spacing:1px;">Description</th>
                        <th style="padding:8px 12px;text-align:left;color:#D4AF37;font-size:11px;text-transform:uppercase;letter-spacing:1px;">Due Date</th>
                        <th style="padding:8px 12px;text-align:left;color:#D4AF37;font-size:11px;text-transform:uppercase;letter-spacing:1px;">Amount</th>
                    </tr>
                </thead>
                <tbody>${scheduleTableRows}</tbody>
            </table>
        </div>`;

    // NOTE: paymentScheduleHtml carries the scheduled amounts — kept verbatim.
    const { socialLinks } = await getEmailFooterContext();
    const banner = await bannerRegistry.resolveBanner('quote_accepted');
    const html = emailComponents.renderPremiumEmail({
        preheaderText: invoiceGenerated ? `Booking #${id} accepted — invoice issued.` : `Booking #${id} — quote accepted.`,
        bannerSrc: banner?.src, bannerAlt: banner?.alt, subtitle: banner?.subtitle,
        headline: banner?.headline || (invoiceGenerated ? 'Invoice Sent — Awaiting Payment' : 'Quote Accepted'),
        greeting: `Hi ${name},`,
        bodyHtml:
            `We've received your acceptance of the quote for <strong style="color:#FAFAFA;">${event_name || event_type}</strong> on <strong style="color:#FAFAFA;">${date}</strong>. Your booking reference is <strong style="color:#D4AF37;">#${id}</strong>, and our team will formally confirm your booking shortly.` +
            paymentScheduleHtml +
            `<p style="font-size:12px; color:#B0B0B0; margin-top:8px;">Please ensure each payment is made by its due date to keep your booking active. Contact us if you have any questions.</p>`,
        cta: { label: 'View Your Booking', url: `${emailBaseUrl()}/?track=${id}&email=${encodeURIComponent(email)}` },
        socialLinks
    });

    // E3: ICS calendar invite attached to quote acceptance confirmation
    const icsContent = generateBookingICS(booking);
    const icsAttachments = icsContent ? [{
        filename: `Booking_${id}_Thabiso_Mhlongo.ics`,
        content: Buffer.from(icsContent),
        contentType: 'text/calendar; method=REQUEST'
    }] : [];

    const result = await sendEmail({
        to: email,
        // Gap 2: Subject and title reflect whether the invoice was actually generated (honest messaging).
        subject: invoiceGenerated ? `Invoice Issued – Booking #${id}` : `Quote Accepted – Booking #${id}`,
        htmlContent: html,
        preWrapped: true,
        attachments: icsAttachments,
        titleOverride: invoiceGenerated ? 'Invoice Sent – Awaiting Payment' : 'Quote Accepted – Awaiting Payment',
        trigger_event: 'Booking: Quote Accepted Receipt'
    });

    return result.success;
}

async function sendBookingReceivedEmail(bookingId, data) {
    data = escapeEmailFields(data);
    const {
        name, company, email, cell,
        event_name, event_date, event_start_time, performance_slot, performance_duration,
        event_location, venue_address, city, country, venue_type,
        event_type, audience_size, audience_demographic, budget_range, travel_accommodation, message
    } = data;

    const logoFilePath = path.join(__dirname, '..', 'images', 'logo4.png');
    const siteUrl = process.env.SITE_URL || 'https://www.thabisomhlongo.com';

    // SYSTEM (Prompt 4 rebuild): the travel/accommodation cell keeps its exact conditional wording.
    const travelValue = (!travel_accommodation || travel_accommodation === 0 || travel_accommodation === '0' || travel_accommodation === 'Not required')
        ? 'Not required'
        : (travel_accommodation === 1 || travel_accommodation === true ? 'Provided' : travel_accommodation);
    const adminHtmlTemplate = emailComponents.renderSystemEmail({
        preheaderText: `New booking request #${bookingId}: ${event_type} on ${event_date}.`,
        category: 'Booking Requests',
        severity: 'action',
        leadFact: `New booking request from <strong style="color:#FAFAFA;">${name}</strong> for <strong style="color:#FAFAFA;">${event_type}</strong> on <strong style="color:#FAFAFA;">${event_date}</strong>.`,
        bodyHtml: `<p style="margin:0 0 6px; color:#D4AF37; font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:0.7px;">Additional Notes</p><div style="padding:14px 16px; background:#1A1A1A; border-left:3px solid #D4AF37; white-space:pre-wrap; color:#E6E6E6; font-size:13px; line-height:1.6;">${message.replace(/\n/g, '<br>')}</div><p style="margin:12px 0 0; color:#B0B0B0; font-size:12px;">Log in to the Admin Dashboard to reply and manage this booking natively.</p><p style="margin:14px 0 0; text-align:center;"><a href="${siteUrl}/admin#bookingsAdmin" style="display:inline-block; background:#D4AF37; color:#0A0A0A; padding:10px 24px; border-radius:4px; text-decoration:none; font-weight:600; font-size:13px;">Open Booking #${bookingId} in Admin &rarr;</a></p>`,
        cards: [
            {
                title: 'Client & Event',
                rows: [
                    { label: 'Client Name', value: `${name} ${company ? `(${company})` : ''}`, mono: false },
                    { label: 'Email', rawValue: `<a href="mailto:${email}" style="color:#D4AF37; text-decoration:none;">${email}</a>` },
                    { label: 'Phone', value: cell },
                    { label: 'Event Name', value: event_name || 'N/A', mono: false },
                    { label: 'Event Date & Time', value: `${event_date} ${event_start_time ? `at ${event_start_time}` : ''}` },
                    { label: 'Performance Slot', value: performance_slot || 'N/A', mono: false },
                    { label: 'Duration', value: performance_duration || 'N/A', mono: false },
                    { label: 'Location Name', value: event_location, mono: false },
                    { label: 'Full Address', value: `${venue_address ? venue_address + ', ' : ''}${city ? city + ', ' : ''}${country || ''}`, mono: false },
                    { label: 'Type', value: `${event_type} (${venue_type || 'Unspecified Venue Type'})`, mono: false },
                    { label: 'Audience', value: `${audience_size || 'N/A'} ${audience_demographic ? `(${audience_demographic})` : ''}`, mono: false },
                    { label: 'Travel/Accommodation', value: travelValue, mono: false },
                    { label: 'Budget', value: budget_range || 'N/A', mono: false }
                ]
            }
        ]
    });

    // Client receipt (PREMIUM, Prompt 3 rebuild) — booking summary as an info card.
    const clientCardRows = [
        { label: 'Event Type', value: event_type, mono: false },
        { label: 'Event Date', value: `${event_date}${event_start_time ? ' at ' + event_start_time : ''}` }
    ];
    if (performance_slot) clientCardRows.push({ label: 'Performance Slot', value: performance_slot, mono: false });
    if (performance_duration) clientCardRows.push({ label: 'Duration', value: performance_duration, mono: false });
    clientCardRows.push({ label: 'Venue', value: `${event_location}${city ? ', ' + city : ''}`, mono: false });
    if (audience_size) clientCardRows.push({ label: 'Audience', value: `${audience_size}${audience_demographic ? ' (' + audience_demographic + ')' : ''}`, mono: false });
    if (budget_range) clientCardRows.push({ label: 'Budget Range', value: budget_range, mono: false });

    try {
        const notifEmail = await getNotificationEmail();

        // E2: ICS calendar invite for client (so they can reserve the date immediately)
        const icsBooking = {
            id: bookingId,
            name,
            date: event_date,
            event_name,
            event_type,
            event_location,
            event_start_time,
            performance_slot,
            performance_duration
        };
        const icsContent = generateBookingICS(icsBooking);
        const icsAttachments = icsContent ? [{
            filename: `Booking_${bookingId}_Thabiso_Mhlongo.ics`,
            content: Buffer.from(icsContent),
            contentType: 'text/calendar; method=REQUEST'
        }] : [];

        const { socialLinks } = await getEmailFooterContext();
        const banner = await bannerRegistry.resolveBanner('booking_received_client');
        const clientHtml = emailComponents.renderPremiumEmail({
            preheaderText: `We've received your booking request — Ref #${bookingId}.`,
            bannerSrc: banner?.src, bannerAlt: banner?.alt, subtitle: banner?.subtitle,
            headline: banner?.headline || "We've Received Your Request",
            greeting: `Hi ${name},`,
            bodyHtml: `Thank you for reaching out to book Thabiso Mhlongo for your upcoming <strong style="color:#D4AF37;">${event_type}</strong> on <strong style="color:#D4AF37;">${event_date}</strong>. Our management team has received your enquiry and will be in touch shortly to confirm availability and discuss pricing.<br><br><span style="color:#B0B0B0; font-size:13px;">Keep your booking reference <strong style="color:#D4AF37;">#${bookingId}</strong> safe — you'll need it to track your booking status.</span>`,
            cards: [{ title: `Booking Summary · Ref #${bookingId}`, rows: clientCardRows }],
            cta: { label: 'Track Your Booking', url: `${emailBaseUrl()}/?track=${bookingId}&email=${encodeURIComponent(email)}` },
            socialLinks
        });

        const [adminInfo, clientInfo] = await Promise.all([
            sendEmail({
                to: notifEmail,
                subject: `NEW BOOKING REQUEST: ${event_type} on ${event_date}`,
                htmlContent: adminHtmlTemplate,
                preWrapped: true,
                fromName: name,
                replyTo: email,
                titleOverride: `New Booking Request #${bookingId}`,
                trigger_event: 'Booking: Admin Notification'
            }),
            sendEmail({
                to: email,
                subject: `Booking Request Confirmation: Thabiso Mhlongo`,
                htmlContent: clientHtml,
                preWrapped: true,
                attachments: icsAttachments,
                titleOverride: "We've Received Your Booking Request!",
                trigger_event: 'Booking: Client Receipt'
            })
        ]);
        console.log(`Booking emails dispatched: Admin(${adminInfo.success}) Client(${clientInfo.success})`);
        return adminInfo.success && clientInfo.success;
    } catch (emailError) {
        console.error('Error dispatching dual booking emails:', emailError);
        return false;
    }
}

// S2-1: Notify client when their booking moves to PENDING (under review)
async function sendBookingUnderReviewEmail(booking) {
    booking = escapeEmailFields(booking);
    const { id, name, email, event_type, date, event_name } = booking;
    const eventLabel = event_name || event_type;
    const { socialLinks } = await getEmailFooterContext();
    const banner = await bannerRegistry.resolveBanner('booking_under_review');
    const html = emailComponents.renderPremiumEmail({
        preheaderText: `Ref #${id} — your booking is now with our management team.`,
        bannerSrc: banner?.src, bannerAlt: banner?.alt, subtitle: banner?.subtitle,
        headline: banner?.headline || 'Your Booking Is Under Review',
        greeting: `Hi ${name},`,
        bodyHtml: `Great news — your request for <strong style="color:#FAFAFA;">${eventLabel}</strong> on <strong style="color:#FAFAFA;">${date}</strong> is now being actively reviewed by our management team. We're confirming availability, going through your event details, and preparing a tailored quotation. You can expect to hear from us shortly.`,
        cards: [{
            title: `Booking · Ref #${id}`,
            rows: [
                { label: 'Event', value: eventLabel, mono: false },
                { label: 'Date', value: date },
                { label: 'Reference', value: `#${id}` }
            ]
        }],
        cta: { label: 'Track Your Booking', url: `${emailBaseUrl()}/?track=${id}&email=${encodeURIComponent(email)}` },
        socialLinks
    });
    const result = await sendEmail({
        to: email,
        subject: `Your Booking Is Under Review — Ref #${id}`,
        htmlContent: html,
        preWrapped: true,
        titleOverride: 'Booking Under Review',
        trigger_event: 'Booking: Under Review'
    });
    return result.success;
}

async function sendPaymentReceivedEmail(booking, newAmountPaid, newOutstanding, newPaymentStatus) {
    booking = escapeEmailFields(booking);
    const { id, name, email, event_name, event_type, date, total_amount, quote_amount } = booking;

    const isPartial = newPaymentStatus === 'PARTIALLY_PAID';
    const titleStatus = isPartial ? 'Partial Payment Received' : 'Full Payment Received';
    const displayTotal = total_amount || (quote_amount ? parseFloat(quote_amount.replace(/[^0-9.]/g, '')) : 0);

    // PAYMENT-CRITICAL: the exact figure strings (R${...} — no space, as before) are unchanged.
    const { socialLinks } = await getEmailFooterContext();
    const banner = await bannerRegistry.resolveBanner('payment_received');
    const html = emailComponents.renderPremiumEmail({
        preheaderText: `${titleStatus} for booking #${id} — R${newAmountPaid.toFixed(2)}.`,
        bannerSrc: banner?.src, bannerAlt: banner?.alt, subtitle: banner?.subtitle,
        headline: banner?.headline || titleStatus,
        greeting: `Hi ${name},`,
        bodyHtml:
            `We've successfully processed a payment for the booking of <strong style="color:#FAFAFA;">${event_name || event_type}</strong> on <strong style="color:#FAFAFA;">${date}</strong>.` +
            `<p style="margin:12px 0 0; color:#E6E6E6;">${isPartial ? 'Your booking will be fully confirmed once the remaining balance is settled.' : `Your booking is now <strong style="color:#D4AF37;">CONFIRMED</strong>. We look forward to performing at your event!`} <span style="color:#B0B0B0; font-size:13px;">(Booking reference #${id})</span></p>`,
        cards: [{
            title: 'Payment Summary',
            rows: [
                { label: 'Total Quote', value: `R${displayTotal.toFixed(2)}` },
                { label: 'Amount Paid', value: `R${newAmountPaid.toFixed(2)}`, highlight: true },
                { label: 'Remaining Balance', rawValue: `<span style="color:${newOutstanding > 0 ? '#E8A83E' : '#D4AF37'};">R${newOutstanding.toFixed(2)}</span>` }
            ]
        }],
        cta: { label: 'View Your Booking', url: `${emailBaseUrl()}/?track=${id}&email=${encodeURIComponent(email)}` },
        socialLinks
    });

    const result = await sendEmail({
        to: email,
        subject: `${titleStatus} – Booking #${id}`,
        htmlContent: html,
        preWrapped: true,
        titleOverride: titleStatus,
        trigger_event: 'Booking: Payment Received'
    });

    return result.success;
}

// P3-7: Resend the paid invoice PDF as a payment receipt when booking becomes fully PAID.
async function sendPaidReceiptEmail(booking) {
    booking = escapeEmailFields(booking);
    const inv = await getInvoiceForPaidReceipt(booking.id);
    if (!inv || !inv.file_path) return;
    const pdfPath = resolveDocsPath('invoices', inv.file_path);
    if (!fs.existsSync(pdfPath)) return;
    await sendInvoiceEmail(booking, pdfPath);
}

async function sendBookingCompletedEmail(booking) {
    booking = escapeEmailFields(booking);
    const { id, name, email, event_name, event_type, date, event_location,
            total_amount, amount_paid, quote_amount } = booking;

    // Fetch services delivered for the summary table
    const services = await new Promise(resolve => {
        db.all(`SELECT bs.quantity_minutes, bs.unit_price, bs.total_price, s.name as service_name, s.display_unit
                FROM booking_services bs
                LEFT JOIN services s ON bs.service_id = s.id
                WHERE bs.booking_id = ?`, [id], (e, rows) => resolve(e ? [] : (rows || [])));
    });

    // Fetch VAT from the latest non-voided invoice, then fall back to the latest quotation
    const vatRow = await new Promise(resolve => {
        getInvoiceTaxAmountForBooking(id, (e, row) => {
            if (!e && row) return resolve(row);
            getQuoteTaxAmountForBooking(id, (e2, row2) => resolve(e2 ? null : row2));
        });
    });
    const vatAmount = vatRow ? parseFloat(vatRow.tax_amount) || 0 : 0;
    const displayTotal = parseFloat(total_amount) || parseFloat((quote_amount || '0').replace(/[^0-9.]/g, '')) || 0;
    const paid = parseFloat(amount_paid) || 0;
    const subtotal = displayTotal - vatAmount;

    // Services + financial figures below are rendered with the exact same computed strings as before.
    const { socialLinks } = await getEmailFooterContext();
    const cards = [];
    if (services.length > 0) {
        cards.push({
            title: 'Services Delivered',
            rows: services.map(s => {
                const qty = s.quantity_minutes && s.display_unit ? ` (${s.quantity_minutes} ${s.display_unit})` : '';
                return { label: `${s.service_name || 'Service'}${qty}`, value: `R ${(parseFloat(s.total_price) || 0).toFixed(2)}` };
            })
        });
    }
    cards.push({
        title: 'Financial Summary',
        rows: [
            ...(vatAmount > 0 ? [{ label: 'Subtotal (excl. VAT)', value: `R ${subtotal.toFixed(2)}` }] : []),
            ...(vatAmount > 0 ? [{ label: 'VAT (15%)',            value: `R ${vatAmount.toFixed(2)}` }] : []),
            { label: 'Total',        value: `R ${displayTotal.toFixed(2)}` },
            { label: 'Amount Paid',  value: `R ${paid.toFixed(2)}`, highlight: true },
        ]
    });

    const banner = await bannerRegistry.resolveBanner('booking_completed');
    const html = emailComponents.renderPremiumEmail({
        preheaderText: `Thank you — booking #${id} is complete. We hope it was a blast!`,
        bannerSrc: banner?.src, bannerAlt: banner?.alt, subtitle: banner?.subtitle,
        headline: banner?.headline || 'Event Completed — Thank You!',
        greeting: `Hi ${name},`,
        bodyHtml:
            `We hope you had an absolutely wonderful time! Your event — <strong style="color:#FAFAFA;">${event_name || event_type}</strong> on <strong style="color:#FAFAFA;">${date}</strong> at <strong style="color:#FAFAFA;">${event_location || 'your venue'}</strong> — has been marked as completed.<br><br>It was a pleasure working with you. Here's a summary of your booking <span style="color:#B0B0B0; font-size:13px;">(reference #${id})</span>:`,
        cards,
        socialLinks
    });
    const result = await sendEmail({
        to: email, subject: `Thank You – Event Completed! Booking #${id}`,
        htmlContent: html, preWrapped: true, titleOverride: 'Event Completed – Thank You!',
        trigger_event: 'Booking: Completed'
    });
    return result.success;
}

async function sendAdminPaymentNotification(booking, amountPaid, paymentStatus) {
    const notifEmail = await getNotificationEmail();
    const { id, name, email, event_name, event_type, date } = booking;
    const body = emailComponents.renderSystemEmail({
        preheaderText: `Payment received for booking #${id} — R${parseFloat(amountPaid).toFixed(2)}.`,
        category: 'Payments & Invoices',
        severity: 'info',
        leadFact: `Payment received for booking <strong style="color:#FAFAFA;">#${id}</strong>.`,
        cards: [{
            rows: [
                { label: 'Client', rawValue: `${emailComponents.esc(name)} (<a href="mailto:${email}" style="color:#D4AF37; text-decoration:none;">${email}</a>)` },
                { label: 'Event', value: `${event_name || event_type} on ${date}`, mono: false },
                { label: 'Amount Paid', value: `R${parseFloat(amountPaid).toFixed(2)}`, highlight: true },
                { label: 'Payment Status', value: paymentStatus }
            ]
        }]
    });
    await sendEmail({ to: notifEmail, subject: `Payment Received – Booking #${id}`,
        htmlContent: body, preWrapped: true, replyTo: email, titleOverride: 'Payment Received',
        trigger_event: 'Admin: Payment Notification' });
}

async function sendAdminCompletionSummaryEmail(booking) {
    booking = escapeEmailFields(booking);
    const notifEmail = await getNotificationEmail();
    const { id, name, email, event_name, event_type, date, event_location,
            total_amount, amount_paid, quote_amount } = booking;

    const displayTotal = parseFloat(total_amount) || parseFloat((quote_amount || '0').replace(/[^0-9.]/g, '')) || 0;
    const paid = parseFloat(amount_paid) || 0;

    // Fetch services for the P&L view
    const services = await new Promise(resolve => {
        db.all(`SELECT bs.quantity_minutes, bs.unit_price, bs.total_price, s.name as service_name, s.display_unit
                FROM booking_services bs
                LEFT JOIN services s ON bs.service_id = s.id
                WHERE bs.booking_id = ?`, [id], (e, rows) => resolve(e ? [] : (rows || [])));
    });

    // Fetch expenses (table is named 'expenses')
    const expenseRows = await getExpensesForBookingEmail(id);
    const totalExpenses = expenseRows.reduce((sum, ex) => sum + (parseFloat(ex.amount) || 0), 0);
    const netRevenue = paid - totalExpenses;

    const cards = [{
        rows: [
            { label: 'Client', rawValue: `${emailComponents.esc(name)} (<a href="mailto:${email}" style="color:#D4AF37; text-decoration:none;">${email}</a>)` },
            { label: 'Event', value: `${event_name || event_type} on ${date}`, mono: false },
            { label: 'Venue', value: event_location || '—', mono: false }
        ]
    }];
    if (services.length > 0) {
        cards.push({ title: 'Services', rows: services.map(s => ({ label: s.service_name || 'Service', value: `R ${(parseFloat(s.total_price) || 0).toFixed(2)}`, mono: false })) });
    }
    if (expenseRows.length > 0) {
        cards.push({ title: 'Expenses', rows: expenseRows.map(ex => ({ label: ex.description, value: `– R ${(parseFloat(ex.amount) || 0).toFixed(2)}`, mono: false })) });
    }
    cards.push({
        title: 'Profit & Loss',
        rows: [
            { label: 'Total Quoted',     value: `R ${displayTotal.toFixed(2)}` },
            { label: 'Amount Collected', value: `R ${paid.toFixed(2)}`, highlight: true },
            ...(expenseRows.length > 0 ? [{ label: 'Total Expenses', value: `– R ${totalExpenses.toFixed(2)}` }] : []),
            ...(expenseRows.length > 0 ? [{ label: 'Net Revenue',    value: `R ${netRevenue.toFixed(2)}`, highlight: netRevenue > 0 }] : [])
        ]
    });

    const body = emailComponents.renderSystemEmail({
        preheaderText: `Booking #${id} completed — ${event_name || event_type}.`,
        category: 'Booking Confirmations',
        severity: 'info',
        leadFact: `<strong style="color:#FAFAFA;">Booking #${id}</strong> has been marked as <strong style="color:#D4AF37;">COMPLETED</strong>.`,
        bodyHtml: `<p style="margin:0; color:#B0B0B0; font-size:12px;">Open the Financials modal for full transaction history and VAT breakdown.</p>`,
        cards
    });

    await sendEmail({
        to: notifEmail, subject: `Booking #${id} Completed — ${event_name || event_type}`,
        htmlContent: body, preWrapped: true, replyTo: email, titleOverride: 'Booking Completed',
        trigger_event: 'Admin: Booking Completed Summary'
    });
}

async function sendRefundProcessedEmail(booking, refundAmount, refundReference) {
    booking = escapeEmailFields(booking);
    const { id, name, email, event_name, event_type, date } = booking;
    // PAYMENT-CRITICAL: amtFormatted (`R {amount}`, space kept) and refundReference verbatim.
    // (Old table used light-mode #f5f5f5 cells inside the dark email — same defect as date-changed.)
    const amtFormatted = `R ${parseFloat(refundAmount || 0).toFixed(2)}`;
    const { socialLinks } = await getEmailFooterContext();
    const rows = [{ label: 'Refund Amount', value: amtFormatted, highlight: true }];
    if (refundReference) rows.push({ label: 'Reference', value: `${refundReference}` });
    const banner = await bannerRegistry.resolveBanner('refund_processed');
    const html = emailComponents.renderPremiumEmail({
        preheaderText: `Your refund of ${amtFormatted} for booking #${id} has been processed.`,
        bannerSrc: banner?.src, bannerAlt: banner?.alt, subtitle: banner?.subtitle,
        headline: banner?.headline || 'Refund Confirmation',
        greeting: `Hi ${name},`,
        bodyHtml:
            `We are writing to confirm that your refund for Booking <strong style="color:#FAFAFA;">#${id}</strong> — <strong style="color:#FAFAFA;">${event_name || event_type}</strong> on <strong style="color:#FAFAFA;">${date}</strong> — has been processed.` +
            `<p style="margin:14px 0 0; color:#E6E6E6;">Please allow 3&ndash;5 business days for the funds to reflect in your account, depending on your bank or payment method.</p>` +
            `<p style="margin:10px 0 0; color:#B0B0B0; font-size:13px;">If you have any questions, please reply to this email or contact us at <a href="mailto:bookings@thabisomhlongo.com" style="color:#D4AF37;">bookings@thabisomhlongo.com</a>.</p>`,
        cards: [{ title: 'Refund Details', rows }],
        socialLinks
    });
    return sendEmail({ to: email, subject: `Refund Processed – Booking #${id}`,
        htmlContent: html, preWrapped: true, titleOverride: 'Refund Confirmation', trigger_event: 'Booking: Refund Processed' });
}

module.exports = {
    generateBookingICS, sendQuoteEmail, sendAdminQuoteSentNotification, sendBookingConfirmedEmail,
    sendDepositBalanceDueEmail, sendQuoteExpiryWarningEmail, sendReviewRequestEmail, remindBooking,
    sendDateChangedEmail, sendQuoteAcceptedEmail, sendBookingReceivedEmail,
    sendBookingUnderReviewEmail, sendPaymentReceivedEmail, sendPaidReceiptEmail,
    sendBookingCompletedEmail, sendAdminPaymentNotification, sendAdminCompletionSummaryEmail,
    sendRefundProcessedEmail
};
