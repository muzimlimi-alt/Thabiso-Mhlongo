// Phase 5 (HOUSEKEEPING-NOTES.md): relocated from app.js verbatim. Quote/confirmation/reminder/
// review-request emails plus the state-aware remindBooking() orchestrator, shared between
// routes/admin/bookings.js's email-action routes (resend-quote, resend-confirmation, review-request,
// remind, bulk-remind) and several not-yet-moved call sites (the admin quote route, payment
// processing, cron jobs) — app.js re-imports whichever of these it still needs.
const fs = require('fs');
const moment = require('moment-timezone');
const emailComponents = require('../js/emailComponents');
const bannerRegistry = require('../js/bannerRegistry');
const { sendEmail } = require('../js/emailService');
const { escapeEmailFields } = require('./email-escape');
const { getEmailFooterContext, emailBaseUrl } = require('./email-context');
const { getVatRate } = require('./document-totals');
const { dbGet, dbRun } = require('./db-helpers');
const { getNotificationEmail } = require('../database/repositories/settings.repository');

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

module.exports = {
    generateBookingICS, sendQuoteEmail, sendAdminQuoteSentNotification, sendBookingConfirmedEmail,
    sendDepositBalanceDueEmail, sendQuoteExpiryWarningEmail, sendReviewRequestEmail, remindBooking
};
