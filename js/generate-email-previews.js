/**
 * Renders the email component toolkit (js/emailComponents.js) to static HTML in
 * ./email-previews so they can be opened in a browser. Prompt 2 checkpoint.
 *
 *   node js/generate-email-previews.js
 *
 * Offline-safe: the sample emails omit bannerSrc so the banner_slot text-headline
 * fallback renders without any network image.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const C = require('./emailComponents');

const OUT_DIR = path.join(__dirname, '..', 'email-previews');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

const SAMPLE_SOCIAL = [
    { platform_name: 'Instagram', platform_url: 'https://instagram.com/thabisocomedian' },
    { platform_name: 'YouTube', platform_url: 'https://youtube.com/@thabisocomedian' },
    { platform_name: 'TikTok', platform_url: 'https://tiktok.com/@thabisocomedian' }
];

/* ── 1. Component gallery ── each partial rendered on the obsidian background ── */
function gallery() {
    const item = (name, html) => `
    <tr><td style="padding:22px 0 6px; font-family:${C.TOKENS.mono}; font-size:12px; letter-spacing:1px; color:${C.TOKENS.gold}; text-transform:uppercase; border-top:1px solid ${C.TOKENS.hairline};">${name}</td></tr>
    <tr><td style="padding:8px 0 4px;">${html}</td></tr>`;

    const inner = `
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" align="center" style="width:600px; max-width:600px;">
      <tr><td style="padding:28px 0 8px; font-family:${C.TOKENS.serif}; font-size:26px; color:${C.TOKENS.gold};">Email Component Gallery</td></tr>
      <tr><td style="padding:0 0 18px; font-family:${C.TOKENS.body}; font-size:13px; color:${C.TOKENS.muted};">js/emailComponents.js — every partial with sample data.</td></tr>
      ${item('banner_slot (image src)', C.bannerSlot({ bannerSrc: 'https://via.placeholder.com/600x176/111111/D4AF37?text=BANNER+ART', alt: 'Banner', headline: 'Fallback' }))}
      ${item('banner_slot (fallback — no src)', C.bannerSlot({ headline: 'Your Booking Is Confirmed', subtitle: 'Officially funny since 2014' }))}
      ${item('system_header', C.systemHeader({ category: 'Payments & Invoices', severity: 'alert' }))}
      ${item('cta_button', C.ctaButton({ label: 'View Your Invoice', url: '#' }))}
      ${item('info_card', C.infoCard({ title: 'Booking Details', rows: [
        { label: 'Reference', value: '#100045' },
        { label: 'Event', value: 'Comedy Night', mono: false },
        { label: 'Date', value: '2026-08-14' },
        { label: 'Amount Due', value: 'R 4,500.00', highlight: true }
      ] }))}
      ${item('alert_strip (info)', C.alertStrip({ severity: 'info', text: 'This is an informational note.' }))}
      ${item('alert_strip (action)', C.alertStrip({ severity: 'action', text: 'A quote is awaiting your response.' }))}
      ${item('alert_strip (alert)', C.alertStrip({ severity: 'alert', text: '3 transactions are stuck in PENDING.' }))}
      ${item('divider', C.divider())}
      ${item('spacer(24)', `<div style="border:1px dashed ${C.TOKENS.cardBorder};">${C.spacer(24)}</div>`)}
      ${item('footer (with unsubscribe + social)', C.footer({ unsubscribeUrl: '#', socialLinks: SAMPLE_SOCIAL }))}
      <tr><td style="height:40px;"></td></tr>
    </table>`;

    return C.baseLayout({
        preheaderText: 'Component gallery',
        contentHtml: `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.TOKENS.obsidian}" style="background-color:${C.TOKENS.obsidian};"><tr><td align="center" class="tm-px" style="padding:0 24px;">${inner}</td></tr></table>`,
        footerHtml: '',
        title: 'Component Gallery'
    });
}

/* ── 2. Full PREMIUM sample email ── */
function samplePremium() {
    return C.renderPremiumEmail({
        preheaderText: 'Your booking #100045 is confirmed — here are the details.',
        headline: 'Your Booking Is Confirmed',            // banner falls back to this text headline
        greeting: 'Hi Naledi,',
        bodyHtml: `Thank you for booking Thabiso Mhlongo. Your event is locked in and we can't wait to bring the house down. Below is a summary of your booking — keep it for your records.`,
        cards: [{
            title: 'Booking Summary',
            rows: [
                { label: 'Reference', value: '#100045' },
                { label: 'Event', value: 'Corporate Year-End', mono: false },
                { label: 'Date', value: 'Sat, 14 Aug 2026 · 19:00' },
                { label: 'Venue', value: 'The Venue, Sandton', mono: false },
                { label: 'Balance Due', value: 'R 4,500.00', highlight: true }
            ]
        }],
        cta: { label: 'View Your Booking', url: 'https://thabisomhlongo.com/track?ref=100045' },
        unsubscribeUrl: null,
        socialLinks: SAMPLE_SOCIAL
    });
}

/* ── 3. Full SYSTEM sample email ── */
function sampleSystem() {
    return C.renderSystemEmail({
        preheaderText: 'ALERT · 3 booking(s) with a payment discrepancy.',
        category: 'Payments & Invoices',
        severity: 'alert',
        leadFact: '3 booking(s) have a ledger vs. transactions discrepancy totalling R 9,200.00.',
        bodyHtml: 'Review the affected bookings and reconcile before month-end.',
        cards: [{
            title: 'Affected Bookings',
            rows: [
                { label: '#100031', value: 'R 2,500.00 short' },
                { label: '#100037', value: 'R 4,200.00 short' },
                { label: '#100044', value: 'R 2,500.00 over' }
            ]
        }]
    });
}

/* ── Write files ── */
const files = {
    'components.html': gallery(),
    'sample-premium.html': samplePremium(),
    'sample-system.html': sampleSystem()
};

/* ── Prompt 3, Batch 1 — representative renders of the rebuilt PREMIUM emails ──
   (Mirrors the server.js builders; the live functions add DB-resolved social links
   and real booking data.) */
const P = (o) => C.renderPremiumEmail(Object.assign({ socialLinks: SAMPLE_SOCIAL }, o));
const premium = {
    'booking-received-client.html': P({
        preheaderText: "We've received your booking request — Ref #100045.",
        headline: "We've Received Your Request", greeting: 'Hi Naledi,',
        bodyHtml: `Thank you for reaching out to book Thabiso Mhlongo for your upcoming <strong style="color:#D4AF37;">Corporate Year-End</strong> on <strong style="color:#D4AF37;">Sat, 14 Aug 2026</strong>. Our management team has received your enquiry and will be in touch shortly to confirm availability and discuss pricing.<br><br><span style="color:#B0B0B0; font-size:13px;">Keep your booking reference <strong style="color:#D4AF37;">#100045</strong> safe — you'll need it to track your booking status.</span>`,
        cards: [{ title: 'Booking Summary · Ref #100045', rows: [
            { label: 'Event Type', value: 'Corporate Year-End', mono: false },
            { label: 'Event Date', value: 'Sat, 14 Aug 2026 at 19:00' },
            { label: 'Venue', value: 'The Venue, Sandton', mono: false },
            { label: 'Audience', value: '250 (corporate)', mono: false }
        ]}],
        cta: { label: 'Track Your Booking', url: '#' }
    }),
    'booking-under-review.html': P({
        preheaderText: 'Ref #100045 — your booking is now with our management team.',
        headline: 'Your Booking Is Under Review', greeting: 'Hi Naledi,',
        bodyHtml: `Great news — your request for <strong style="color:#FAFAFA;">Corporate Year-End</strong> on <strong style="color:#FAFAFA;">Sat, 14 Aug 2026</strong> is now being actively reviewed by our management team. We're confirming availability and preparing a tailored quotation.`,
        cards: [{ title: 'Booking · Ref #100045', rows: [
            { label: 'Event', value: 'Corporate Year-End', mono: false },
            { label: 'Date', value: 'Sat, 14 Aug 2026' },
            { label: 'Reference', value: '#100045' }
        ]}],
        cta: { label: 'Track Your Booking', url: '#' }
    }),
    'quote.html': P({
        preheaderText: 'Your quotation for booking #100045 is ready to review.',
        headline: 'Your Quotation', greeting: 'Hi Naledi,',
        bodyHtml: `We've prepared a formal quotation for your upcoming event, <strong style="color:#FAFAFA;">Corporate Year-End</strong> on <strong style="color:#FAFAFA;">Sat, 14 Aug 2026</strong>. The full breakdown of services and terms is attached as a PDF.` +
            `<br><br><strong style="color:#D4AF37;">Terms &amp; Policies:</strong><br>Standard cancellation policy applies.` +
            `<p style="margin:14px 0 0;"><strong style="color:#FAFAFA;">Total Quote: R 18,500.00</strong></p>`,
        cta: { label: 'Review & Accept Quote', url: '#' }
    }),
    'quote-accepted.html': P({
        preheaderText: 'Booking #100045 accepted — invoice issued.',
        headline: 'Invoice Sent — Awaiting Payment', greeting: 'Hi Naledi,',
        bodyHtml: `We've received your acceptance of the quote for <strong style="color:#FAFAFA;">Corporate Year-End</strong> on <strong style="color:#FAFAFA;">Sat, 14 Aug 2026</strong>. Your booking reference is <strong style="color:#D4AF37;">#100045</strong>, and our team will formally confirm your booking shortly.`,
        cards: [{ title: 'Payment Schedule', rows: [
            { label: '50% Deposit · due 20 Jul 2026', value: 'R 9,250.00', highlight: true },
            { label: '50% Balance · due 07 Aug 2026', value: 'R 9,250.00', highlight: true }
        ]}],
        cta: { label: 'View Your Booking', url: '#' }
    }),
    'quote-expired.html': P({
        preheaderText: 'Your quote for booking #100045 has expired.',
        headline: 'Your Quote Has Expired', greeting: 'Hi Naledi,',
        bodyHtml: `Your quote for <strong style="color:#FAFAFA;">Corporate Year-End</strong> on <strong style="color:#FAFAFA;">Sat, 14 Aug 2026</strong> has expired and is no longer valid.<br><br>If you're still interested in booking Thabiso Mhlongo, we'd be glad to prepare a fresh quote — just submit a new enquiry.`,
        cta: { label: 'Submit a New Enquiry', url: '#' }
    }),
    'quote-expiry-warning.html': P({
        preheaderText: 'Your quote for booking #100045 expires tomorrow.',
        headline: 'Your Quote Expires Tomorrow', greeting: 'Hi Naledi,',
        bodyHtml: `Your quote for <strong style="color:#FAFAFA;">Corporate Year-End</strong> on <strong style="color:#FAFAFA;">Sat, 14 Aug 2026</strong> expires <strong style="color:#D4AF37;">tomorrow (13 Jul 2026)</strong>. Accept it now via your booking tracker before it lapses.`,
        cta: { label: 'Accept Your Quote', url: '#' }
    }),

    /* ── Batch 2: confirm & lifecycle ── */
    'booking-confirmed.html': P({
        preheaderText: 'Booking #100045 is confirmed — see you on Sat, 14 Aug 2026!',
        headline: 'Your Booking Is Confirmed', greeting: 'Hi Naledi,',
        bodyHtml: `Wonderful news — your booking for <strong style="color:#FAFAFA;">Corporate Year-End</strong> on <strong style="color:#FAFAFA;">Sat, 14 Aug 2026</strong> at <strong style="color:#FAFAFA;">The Venue, Sandton</strong> is now fully <strong style="color:#D4AF37;">CONFIRMED</strong>.<br><br>Thabiso Mhlongo is excited to be part of your event, and our team will be in touch with any final logistics closer to the date.<br><br><span style="color:#B0B0B0; font-size:13px;">We've attached a calendar invite (.ics) so you can save the event to your calendar.</span>`,
        cards: [{ title: 'Confirmed Booking', rows: [
            { label: 'Event', value: 'Corporate Year-End', mono: false },
            { label: 'Date', value: 'Sat, 14 Aug 2026' },
            { label: 'Venue', value: 'The Venue, Sandton', mono: false },
            { label: 'Performance Slot', value: '20:00 – 21:00', mono: false },
            { label: 'Reference', value: '#100045' }
        ]}],
        cta: { label: 'View Your Booking', url: '#' }
    }),
    'booking-completed.html': P({
        preheaderText: 'Thank you — booking #100045 is complete. We hope it was a blast!',
        headline: 'Event Completed — Thank You!', greeting: 'Hi Naledi,',
        bodyHtml: `We hope you had an absolutely wonderful time! Your event — <strong style="color:#FAFAFA;">Corporate Year-End</strong> on <strong style="color:#FAFAFA;">Sat, 14 Aug 2026</strong> at <strong style="color:#FAFAFA;">The Venue, Sandton</strong> — has been marked as completed.<br><br>It was a pleasure working with you. Here's a summary of your booking <span style="color:#B0B0B0; font-size:13px;">(reference #100045)</span>:`,
        cards: [
            { title: 'Services Delivered', rows: [
                { label: 'Stand-up Set (60 min)', value: 'R 15,000.00' },
                { label: 'Travel Buyout – Gauteng', value: 'R 3,500.00' }
            ]},
            { title: 'Financial Summary', rows: [
                { label: 'Total', value: 'R 18,500.00' },
                { label: 'Amount Paid', value: 'R 18,500.00', highlight: true }
            ]}
        ]
    }),
    'review-request.html': P({
        preheaderText: "How was your event? We'd love your feedback on booking #100045.",
        headline: "We'd Love Your Feedback", greeting: 'Hi Naledi,',
        bodyHtml: `We hope your event — <strong style="color:#FAFAFA;">Corporate Year-End</strong> on <strong style="color:#FAFAFA;">Sat, 14 Aug 2026</strong> — was everything you imagined!<br><br>If you enjoyed working with Thabiso, a short review or testimonial would mean the world to us.`,
        cta: { label: 'Send Your Review', url: '#' }
    }),
    'date-changed.html': P({
        preheaderText: 'Booking #100045: the event date changed to Sat, 21 Aug 2026.',
        headline: 'Event Date Updated', greeting: 'Hi Naledi,',
        bodyHtml: `Please note that the date for your booking <strong style="color:#FAFAFA;">#100045</strong> — <strong style="color:#FAFAFA;">Corporate Year-End</strong> — has been updated. Please update your calendar accordingly.<br><br><span style="color:#B0B0B0; font-size:13px;">If this change was made in error or you have any concerns, please contact us immediately at <a href="mailto:bookings@thabisomhlongo.com" style="color:#D4AF37;">bookings@thabisomhlongo.com</a>.</span>`,
        cards: [{ title: 'Date Change', rows: [
            { label: 'Previous Date', rawValue: '<span style="text-decoration:line-through; color:#707070;">Sat, 14 Aug 2026</span>' },
            { label: 'New Date', value: 'Sat, 21 Aug 2026', highlight: true }
        ]}],
        cta: { label: 'View My Booking', url: '#' }
    }),
    'booking-cancelled.html': P({
        preheaderText: 'Booking #100045 has been cancelled.',
        headline: 'Booking Cancelled', greeting: 'Hi Naledi,',
        bodyHtml: `We regret to inform you that your booking for <strong style="color:#FAFAFA;">Corporate Year-End</strong> on <strong style="color:#FAFAFA;">Sat, 14 Aug 2026</strong> has been cancelled.<br><br><strong style="color:#FAFAFA;">Reason:</strong> Venue no longer available` +
            C.spacer(14) +
            C.alertStrip({ severity: 'info', text: `<strong style="color:#B0B0B0;">Cancellation Policy Applied</strong><br>Cancelled more than 30 days before the event — 100% of the deposit is refundable.<br><span style="font-size:12px;color:#B0B0B0;">Days until event at time of cancellation: <strong>33</strong></span>` }) +
            `<p style="margin:14px 0 0;"><strong style="color:#D4AF37;">Refund Due: R 9,250.00</strong><br><span style="color:#B0B0B0;">Your refund will be processed within 5&ndash;7 business days.</span></p>` +
            `<p style="margin:12px 0 0; color:#B0B0B0;">If you have any questions, please contact us directly. <span style="font-size:13px;">(Booking reference #100045)</span></p>`
    }),
    'pending-expired.html': P({
        preheaderText: 'Enquiry #100045 has expired — you can submit a new one any time.',
        headline: 'Your Enquiry Has Expired', greeting: 'Hi Naledi,',
        bodyHtml: `Your booking enquiry for <strong style="color:#FAFAFA;">Corporate Year-End</strong> on <strong style="color:#FAFAFA;">Sat, 14 Aug 2026</strong> has expired due to inactivity.<br><br>If you're still interested, we'd love to help make your event special — just submit a new enquiry. <span style="color:#B0B0B0; font-size:13px;">(Original reference #100045)</span>`,
        cta: { label: 'Submit a New Enquiry', url: '#' }
    }),

    /* ── Batch 3: payment-critical A ── */
    'invoice.html': P({
        preheaderText: 'Your invoice for booking #100045 is attached.',
        headline: 'Your Invoice', greeting: 'Hi Naledi,',
        bodyHtml: `Your formal invoice is ready for <strong style="color:#FAFAFA;">Corporate Year-End</strong> on <strong style="color:#FAFAFA;">Sat, 14 Aug 2026</strong>. Please find the attached PDF for the full service breakdown.` +
            `<p style="margin:12px 0 0;"><strong style="color:#D4AF37;">Terms &amp; Policies:</strong><br>Standard cancellation policy applies.</p>` +
            `<p style="margin:10px 0 0; color:#E6E6E6;">Payment can be made via the secure link sent in our previous communications or via bank transfer using the details in the invoice.</p>` +
            `<p style="margin:10px 0 0; color:#B0B0B0; font-size:13px;">Invoice Reference: <strong style="color:#D4AF37;">#100045</strong></p>`,
        cta: { label: 'View Your Booking', url: '#' }
    }),
    'invoice-pre-due.html': P({
        preheaderText: 'Invoice INV-2026-100045 is due in 3 days.',
        headline: 'Invoice Payment Reminder', greeting: 'Hi Naledi,',
        bodyHtml: `This is a friendly reminder that your invoice for <strong style="color:#FAFAFA;">Corporate Year-End</strong> on <strong style="color:#FAFAFA;">Sat, 14 Aug 2026</strong> is due in <strong style="color:#D4AF37;">3 days</strong>.` +
            `<p style="margin:12px 0 0; color:#B0B0B0; font-size:12px;">If you have already arranged payment, please disregard this message. (Booking reference #100045)</p>`,
        cards: [{ title: 'Payment Due', rows: [
            { label: 'Invoice #', value: 'INV-2026-100045' },
            { label: 'Due Date', value: '2026-08-07' },
            { label: 'Amount Due', value: 'R 9250.00', highlight: true }
        ]}],
        cta: { label: 'Pay Now', url: '#' }
    }),
    'invoice-overdue.html': P({
        preheaderText: 'Invoice INV-2026-100045 is overdue — R 9250.00 outstanding.',
        headline: 'Invoice Overdue', greeting: 'Hi Naledi,',
        bodyHtml: `Your invoice for <strong style="color:#FAFAFA;">Corporate Year-End</strong> on <strong style="color:#FAFAFA;">Sat, 14 Aug 2026</strong> was due on <strong style="color:#E8A83E;">2026-08-07</strong> and is now <strong style="color:#E8A83E;">overdue</strong>.` +
            C.spacer(14) +
            C.alertStrip({ severity: 'alert', text: 'Please settle this payment at your earliest convenience to avoid any disruption to your booking.' }) +
            `<p style="margin:12px 0 0; color:#B0B0B0; font-size:12px;">If you believe this is an error or have already made payment, please contact us immediately and we will update your records. (Booking reference #100045)</p>`,
        cards: [{ title: 'Outstanding Invoice', rows: [
            { label: 'Invoice #', value: 'INV-2026-100045' },
            { label: 'Was Due', value: '2026-08-07' },
            { label: 'Outstanding Amount', value: 'R 9250.00', highlight: true }
        ]}],
        cta: { label: 'Pay Now', url: '#' }
    }),
    'payment-received.html': P({
        preheaderText: 'Partial Payment Received for booking #100045 — R9250.00.',
        headline: 'Partial Payment Received', greeting: 'Hi Naledi,',
        bodyHtml: `We've successfully processed a payment for the booking of <strong style="color:#FAFAFA;">Corporate Year-End</strong> on <strong style="color:#FAFAFA;">Sat, 14 Aug 2026</strong>.` +
            `<p style="margin:12px 0 0; color:#E6E6E6;">Your booking will be fully confirmed once the remaining balance is settled. <span style="color:#B0B0B0; font-size:13px;">(Booking reference #100045)</span></p>`,
        cards: [{ title: 'Payment Summary', rows: [
            { label: 'Total Quote', value: 'R18500.00' },
            { label: 'Amount Paid', value: 'R9250.00', highlight: true },
            { label: 'Remaining Balance', rawValue: '<span style="color:#E8A83E;">R9250.00</span>' }
        ]}],
        cta: { label: 'View Your Booking', url: '#' }
    }),

    /* ── Batch 4: payment-critical B ── */
    'deposit-balance-due.html': P({
        preheaderText: 'Deposit received — balance of R9250.00 due for booking #100045.',
        headline: 'Deposit Received', greeting: 'Hi Naledi,',
        bodyHtml: `Thank you for your deposit payment for <strong style="color:#FAFAFA;">Corporate Year-End</strong> on <strong style="color:#FAFAFA;">Sat, 14 Aug 2026</strong>. Your booking is confirmed.` +
            `<p style="margin:10px 0 0; color:#B0B0B0; font-size:13px;">Please ensure payment is received at least 48 hours before the event. (Booking reference #100045)</p>`,
        cards: [{ title: 'Balance Due', rows: [{ label: 'Remaining Balance', value: 'R9250.00', highlight: true }] }],
        cta: { label: 'Settle Your Balance', url: '#' }
    }),
    'payment-failed.html': P({
        preheaderText: "We couldn't complete your payment for booking #100045.",
        headline: 'Payment Not Completed', greeting: 'Hi Naledi,',
        bodyHtml: `We noticed that your payment for <strong style="color:#FAFAFA;">Corporate Year-End</strong> on <strong style="color:#FAFAFA;">Sat, 14 Aug 2026</strong> was not completed successfully.` +
            `<p style="margin:12px 0 0;"><strong style="color:#D4AF37;">Amount Due:</strong> R18500.00</p>` +
            `<p style="margin:10px 0 0; color:#E6E6E6;">Please try again via your booking tracker, or contact us directly if you need assistance. <span style="color:#B0B0B0; font-size:13px;">(Booking reference #100045)</span></p>` +
            `<p style="margin:10px 0 0; color:#B0B0B0; font-size:13px;">If this was a mistake, no action is needed — your booking remains active.</p>`,
        cta: { label: 'Try Payment Again', url: '#' }
    }),
    'refund-processed.html': P({
        preheaderText: 'Your refund of R 9250.00 for booking #100045 has been processed.',
        headline: 'Refund Confirmation', greeting: 'Hi Naledi,',
        bodyHtml: `We are writing to confirm that your refund for Booking <strong style="color:#FAFAFA;">#100045</strong> — <strong style="color:#FAFAFA;">Corporate Year-End</strong> on <strong style="color:#FAFAFA;">Sat, 14 Aug 2026</strong> — has been processed.` +
            `<p style="margin:14px 0 0; color:#E6E6E6;">Please allow 3&ndash;5 business days for the funds to reflect in your account, depending on your bank or payment method.</p>`,
        cards: [{ title: 'Refund Details', rows: [
            { label: 'Refund Amount', value: 'R 9250.00', highlight: true },
            { label: 'Reference', value: 'PF-REF-88214' }
        ]}]
    }),
    'schedule-payment-reminder.html': P({
        preheaderText: 'Payment reminder: 50% Deposit due 2026-07-31.',
        headline: 'Payment Reminder', greeting: 'Hi Naledi,',
        bodyHtml: `This is a friendly reminder that a payment is due in <strong style="color:#D4AF37;">3 days</strong> for your upcoming event booking.`,
        cards: [{ title: 'Payment Details', rows: [
            { label: 'Booking', value: 'Corporate Year-End', mono: false },
            { label: 'Description', value: '50% Deposit', mono: false },
            { label: 'Due Date', value: '2026-07-31' },
            { label: 'Amount', value: 'R 9250.00', highlight: true }
        ]}],
        cta: { label: 'Make Payment Now', url: '#' }
    }),
    'quote-still-open.html': P({
        preheaderText: 'Your quote for booking #100045 is still open.',
        headline: 'Your Quote Awaits', greeting: 'Hi Naledi,',
        bodyHtml: `This is a friendly reminder that you have an open quotation for your upcoming <strong style="color:#FAFAFA;">Corporate</strong> on <strong style="color:#FAFAFA;">Sat, 14 Aug 2026</strong>.` +
            `<p style="margin:10px 0 0; color:#B0B0B0;">Your quote of <strong style="color:#D4AF37;">R 18500.00</strong> is still awaiting your response. Please note your quote expires on <strong style="color:#D4AF37;">2026-08-04</strong>.</p>` +
            `<p style="margin:10px 0 0; color:#E6E6E6;">Use the button below to review and accept — the date is still available for you.</p>`,
        cta: { label: 'Review & Accept Quote', url: '#' }
    }),
    'balance-payment-reminder.html': P({
        preheaderText: 'Balance of R 9250.00 due — event in 5 days.',
        headline: 'Balance Due — Event Approaching', greeting: 'Hi Naledi,',
        bodyHtml: `Your event <strong style="color:#FAFAFA;">Corporate Year-End</strong> is coming up in <strong style="color:#D4AF37;">5 days</strong>!` +
            `<p style="margin:10px 0 0; color:#E6E6E6;">We wanted to remind you that a <strong style="color:#D4AF37;">balance payment of R 9250.00</strong> is still outstanding for your booking.</p>`,
        cards: [{ title: 'Balance Due', rows: [
            { label: 'Event Date', value: 'Sat, 14 Aug 2026' },
            { label: 'Balance Due', value: 'R 9250.00', highlight: true }
        ]}],
        cta: { label: 'Pay Balance Now', url: '#' }
    }),

    /* ── Batch 5: contract & admin-triggered client ── */
    'contract-sent.html': P({
        preheaderText: 'Your booking contract for #100045 is ready to review and sign.',
        headline: 'Your Booking Contract', greeting: 'Hi Naledi,',
        bodyHtml: `Your booking contract for <strong style="color:#FAFAFA;">Corporate Year-End</strong> on <strong style="color:#FAFAFA;">Sat, 14 Aug 2026</strong> is ready. Please review the attached PDF and sign it online at your convenience.` +
            `<p style="margin:10px 0 0; color:#B0B0B0; font-size:12px;">Once you've signed, our team will countersign to finalise the agreement. If you have any questions about the terms, just reply to this email. (Booking reference #100045)</p>`,
        cta: { label: 'Review & Sign Contract', url: '#' }
    }),
    'contract-sign-reminder.html': P({
        preheaderText: 'Your booking contract for Corporate Year-End is awaiting your signature.',
        headline: 'Contract Signature Reminder', greeting: 'Hi Naledi,',
        bodyHtml: `A friendly reminder that your booking contract for <strong style="color:#FAFAFA;">Corporate Year-End</strong> on Sat, 14 Aug 2026 is awaiting your signature. You can review and sign it from your booking page.`,
        cta: { label: 'Review & Sign Contract', url: '#' }
    }),
    'custom-response.html': P({
        preheaderText: "We've received your request for booking #100045.",
        headline: 'Request Received', greeting: 'Hi Naledi,',
        bodyHtml: `We've received your <strong style="color:#D4AF37;">quote revision</strong> request for booking <strong style="color:#FAFAFA;">#100045</strong>. Our team will review your request and get back to you shortly.` +
            `<p style="margin:10px 0 0; color:#B0B0B0; font-size:12px;">Your request: "Could we push the event start time to 8pm?"</p>`
    }),
    'inquiry-reply.html': P({
        preheaderText: 'Re: Availability enquiry for December',
        headline: 'Management Response',
        bodyHtml: `<p style="color:#B0B0B0; font-size:13px; margin:0 0 12px;">In reference to Inquiry #Availability enquiry for December</p>Thanks so much for reaching out! Thabiso is available on that date — I've sent a formal quote through to your email.`
    }),
    'direct-compose.html': P({
        preheaderText: 'A message from Thabiso Mhlongo Management.',
        headline: 'Direct Message',
        bodyHtml: `Just confirming we received your deposit — looking forward to the show!`
    }),
    'abandoned-booking-recovery.html': P({
        preheaderText: 'You started a booking request — pick up right where you left off.',
        headline: 'Finish Your Booking Request', greeting: 'Hi there,',
        bodyHtml: `It looks like you started a booking request for <strong style="color:#D4AF37;">Thabiso Mhlongo</strong> but didn't quite finish. Good news — your details are saved, so you can pick up right where you left off.` +
            `<p style="margin:12px 0 0; color:#B0B0B0; font-size:12px;">Submitting a request doesn't confirm a booking — our team reviews each one and sends a personalised quote, usually within 2 business days.</p>`,
        cards: [{ title: 'Your Booking So Far', rows: [
            { label: 'Event', value: 'Birthday Party', mono: false },
            { label: 'Date', value: '2026-09-12' },
            { label: 'Venue', value: 'Home', mono: false }
        ]}],
        cta: { label: 'Resume My Booking', url: '#' },
        unsubscribeUrl: '#'
    }),

    /* ── Batch 6: visitor & subscriber ── */
    'contact-auto-reply.html': P({
        preheaderText: "We've received your message — thanks for reaching out, Naledi!",
        headline: "We've Received Your Message", greeting: 'Hi Naledi,',
        bodyHtml: `Thank you for reaching out to Thabiso Mhlongo Management. We have successfully received your inquiry regarding <strong style="color:#D4AF37;">"Availability for a private event"</strong> and our team will review it shortly.` +
            `<p style="margin:10px 0 0; color:#E6E6E6;">In the meantime, feel free to follow Thabiso on social media for the latest updates and tour dates.</p>` +
            `<p style="margin:18px 0 0; color:#B0B0B0;">Stay funny,<br><span style="font-family:'Cormorant Garamond',Georgia,serif; font-size:18px; color:#D4AF37;">Thabiso Mhlongo Management</span></p>`
    }),
    'newsletter-welcome.html': P({
        preheaderText: "You're on the list — welcome to the newsletter!",
        headline: "You're On The List!",
        bodyHtml: `<p style="text-align:center;">Thank you for subscribing to my official newsletter. I truly appreciate your support. You will now be the first to know about my upcoming stand-up tour dates, new video releases, and exclusive content.</p>` +
            `<p style="text-align:center; color:#B0B0B0;">Rest assured, your email address will be used responsibly and will never be shared with third parties.</p>` +
            `<p style="text-align:center; margin-top:18px; color:#B0B0B0;">Stay funny,<br><span style="font-family:'Cormorant Garamond',Georgia,serif; font-size:18px; color:#D4AF37;">Thabiso Mhlongo</span></p>`,
        unsubscribeUrl: '#'
    }),
    'newsletter-campaign.html': P({
        preheaderText: 'New Tour Dates Just Announced!',
        headline: 'New Tour Dates Just Announced!',
        bodyHtml: `<p>Hey there!</p><p>I'm thrilled to announce four new stand-up dates across Gauteng this September. Tickets go live Friday at 9am — subscribers get first access.</p><p>See you in the front row,<br>Thabiso</p>`,
        unsubscribeUrl: '#'
    }),

    /* ── Audit gap closed alongside Batch 5: admin->client booking responder (was missing from the
       original inventory; already used its own self-built shell correctly — migrated for consistency). ── */
    'booking-management-response.html': P({
        preheaderText: 'Re: Booking Request #100045',
        headline: 'Management Response',
        bodyHtml: `<p style="color:#B0B0B0; font-size:13px; margin:0 0 12px;">In reference to Booking Request #100045</p>Hi Naledi, thanks for your patience — I've reviewed the updated guest count and the quote will be revised shortly.`
    })
};

/* ── Prompt 4, Batch 1 — representative renders of the rebuilt SYSTEM emails ── */
const S = (o) => C.renderSystemEmail(o);
const system = {
    'booking-received-admin.html': S({
        preheaderText: 'New booking request #100045: Corporate Year-End on Sat, 14 Aug 2026.',
        category: 'Booking Requests', severity: 'action',
        leadFact: 'New booking request from <strong style="color:#FAFAFA;">Naledi Mokoena</strong> for <strong style="color:#FAFAFA;">Corporate</strong> on <strong style="color:#FAFAFA;">Sat, 14 Aug 2026</strong>.',
        bodyHtml: `<p style="margin:0 0 6px; color:#D4AF37; font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:0.7px;">Additional Notes</p><div style="padding:14px 16px; background:#1A1A1A; border-left:3px solid #D4AF37; color:#E6E6E6; font-size:13px; line-height:1.6;">Looking for a 45-60 min set for our year-end function, ~250 guests.</div><p style="margin:12px 0 0; color:#B0B0B0; font-size:12px;">Log in to the Admin Dashboard to reply and manage this booking natively.</p><p style="margin:14px 0 0; text-align:center;"><a href="#" style="display:inline-block; background:#D4AF37; color:#0A0A0A; padding:10px 24px; border-radius:4px; text-decoration:none; font-weight:600; font-size:13px;">Open Booking #100045 in Admin &rarr;</a></p>`,
        cards: [{ title: 'Client & Event', rows: [
            { label: 'Client Name', value: 'Naledi Mokoena', mono: false },
            { label: 'Email', rawValue: '<a href="mailto:naledi@example.com" style="color:#D4AF37; text-decoration:none;">naledi@example.com</a>' },
            { label: 'Event Date & Time', value: 'Sat, 14 Aug 2026 at 19:00' },
            { label: 'Budget', value: 'R15,000 - R20,000', mono: false }
        ] }]
    }),
    'quote-sent-notification.html': S({
        preheaderText: 'Quote sent to Naledi Mokoena for booking #100045.',
        category: 'Quotes & Proposals', severity: 'info',
        leadFact: 'A quotation has been dispatched to the client for Booking <strong style="color:#FAFAFA;">#100045</strong>.',
        bodyHtml: `<p style="margin:0; color:#B0B0B0;">The client has been emailed their quote PDF and a direct link to accept it. Log in to the Admin Dashboard to track the response.</p>`,
        cards: [{ title: 'Quote Details', rows: [
            { label: 'Client', value: 'Naledi Mokoena', mono: false },
            { label: 'Event', value: 'Corporate Year-End • Sat, 14 Aug 2026', mono: false },
            { label: 'Quote Amount', value: 'R 18,500.00', highlight: true }
        ] }]
    }),
    'payment-received-notification.html': S({
        preheaderText: 'Payment received for booking #100045 — R9250.00.',
        category: 'Payments & Invoices', severity: 'info',
        leadFact: 'Payment received for booking <strong style="color:#FAFAFA;">#100045</strong>.',
        cards: [{ rows: [
            { label: 'Client', rawValue: 'Naledi Mokoena (<a href="mailto:naledi@example.com" style="color:#D4AF37; text-decoration:none;">naledi@example.com</a>)' },
            { label: 'Event', value: 'Corporate Year-End on Sat, 14 Aug 2026', mono: false },
            { label: 'Amount Paid', value: 'R9250.00', highlight: true },
            { label: 'Payment Status', value: 'DEPOSIT_PAID' }
        ] }]
    }),
    'quote-accepted-notification.html': S({
        preheaderText: 'Naledi Mokoena accepted the quote for booking #100045 — invoice auto-generated.',
        category: 'Quotes & Proposals', severity: 'action',
        leadFact: '<strong style="color:#FAFAFA;">Naledi Mokoena</strong> (naledi@example.com) has accepted the quote for booking <strong style="color:#FAFAFA;">#100045</strong>.',
        bodyHtml: `<p style="margin:0; color:#E6E6E6;">An invoice has been auto-generated. Log in to confirm the booking.</p>`,
        cards: [{ rows: [{ label: 'Event', value: 'Corporate Year-End on Sat, 14 Aug 2026', mono: false }] }]
    }),
    'client-cancelled-notice.html': S({
        preheaderText: 'Naledi Mokoena cancelled booking #100045.',
        category: 'Booking Requests', severity: 'action',
        leadFact: '<strong style="color:#FAFAFA;">Naledi Mokoena</strong> cancelled booking <strong style="color:#FAFAFA;">#100045</strong>.',
        cards: [{ rows: [
            { label: 'Reason', value: 'Venue no longer available', mono: false },
            { label: 'Refund Due', value: 'R9250.00', highlight: true }
        ] }]
    }),
    'new-review-notice.html': S({
        preheaderText: 'Naledi Mokoena left a 5/5 review for booking #100045.',
        category: 'Thank You & Reviews', severity: 'info',
        leadFact: '<strong style="color:#FAFAFA;">Naledi Mokoena</strong> has submitted a <strong style="color:#D4AF37;">5/5</strong> review for Booking <strong style="color:#FAFAFA;">#100045</strong>.',
        bodyHtml: `<blockquote style="border-left:3px solid #D4AF37; padding:10px 16px; margin:0 0 12px; color:#E6E6E6; background:#1A1A1A;">Thabiso was an absolute hit at our year-end function — professional and hilarious!</blockquote><p style="margin:0; color:#B0B0B0;">Log in to the admin panel to approve or manage reviews.</p>`
    }),
    'contract-signed-notice.html': S({
        preheaderText: 'Naledi Mokoena signed the contract for booking #100045 — countersignature due.',
        category: 'Contracts & Signatures', severity: 'action',
        leadFact: '<strong style="color:#FAFAFA;">Naledi Mokoena</strong> has signed the contract for booking <strong style="color:#FAFAFA;">#100045</strong> online.',
        bodyHtml: `<p style="margin:0; color:#E6E6E6;">Log in to the admin panel to countersign and finalise it.</p>`
    }),

    /* ── Batch 2: ops alerts & completion ── */
    'calendar-sync-failure.html': S({
        preheaderText: 'Booking #100045 saved but its Google Calendar event failed.',
        category: 'System', severity: 'alert',
        leadFact: 'Booking <strong style="color:#FAFAFA;">#100045</strong> was saved successfully but the Google Calendar event could not be created.',
        bodyHtml: `<p style="margin:0 0 10px; color:#B0B0B0; font-size:12px;">Error: Request had insufficient authentication scopes.</p><p style="margin:0; color:#E6E6E6;">Please create the calendar entry manually to avoid a scheduling conflict.</p>`
    }),
    'custom-request-alert.html': S({
        preheaderText: 'Quote Revision request from Naledi Mokoena for booking #100045.',
        category: 'Quotes & Proposals', severity: 'action',
        leadFact: 'A client has submitted a <strong style="color:#D4AF37;">Quote Revision</strong> request for booking <strong style="color:#FAFAFA;">#100045</strong>.',
        bodyHtml: `<p style="margin:0; color:#B0B0B0; font-size:12px;">Please review this request in the admin panel and respond to the client accordingly.</p>`,
        cards: [{ rows: [
            { label: 'Client', value: 'Naledi Mokoena', mono: false },
            { label: 'Email', value: 'naledi@example.com' },
            { label: 'Quote Amount', value: 'R 18,500.00', highlight: true },
            { label: 'Request Type', value: 'Quote Revision', mono: false, highlight: true },
            { label: 'Client Message', value: 'Could we push the start time to 8pm instead?', mono: false }
        ] }]
    }),
    'completion-summary.html': S({
        preheaderText: 'Booking #100045 completed — Corporate Year-End.',
        category: 'Booking Confirmations', severity: 'info',
        leadFact: '<strong style="color:#FAFAFA;">Booking #100045</strong> has been marked as <strong style="color:#D4AF37;">COMPLETED</strong>.',
        bodyHtml: `<p style="margin:0; color:#B0B0B0; font-size:12px;">Open the Financials modal for full transaction history and VAT breakdown.</p>`,
        cards: [
            { rows: [
                { label: 'Client', rawValue: 'Naledi Mokoena (<a href="mailto:naledi@example.com" style="color:#D4AF37; text-decoration:none;">naledi@example.com</a>)' },
                { label: 'Event', value: 'Corporate Year-End on Sat, 14 Aug 2026', mono: false },
                { label: 'Venue', value: 'The Venue, Sandton', mono: false }
            ] },
            { title: 'Services', rows: [{ label: 'Stand-up Set (60 min)', value: 'R 15,000.00', mono: false }] },
            { title: 'Profit & Loss', rows: [
                { label: 'Total Quoted', value: 'R 18,500.00' },
                { label: 'Amount Collected', value: 'R 18,500.00', highlight: true }
            ] }
        ]
    }),
    'stuck-notification-alert.html': S({
        preheaderText: '3 notification(s) stuck in the queue for over 10 minutes.',
        category: 'System', severity: 'alert',
        leadFact: 'There are <strong style="color:#FAFAFA;">3</strong> notification(s) stuck in the queue for more than 10 minutes.',
        bodyHtml: `<p style="margin:0; color:#E6E6E6;">This may indicate that the background queue processor is down, experiencing high latency, or has crashed.</p>`,
        cards: [{ title: 'Stuck Notifications', rows: [
            { label: '#4821 — pending', value: 'To naledi@example.com · 2026-07-12 08:14:02', mono: false },
            { label: '#4820 — sending', value: 'To thabiso@example.com · 2026-07-12 08:10:41', mono: false },
            { label: '#4819 — pending', value: 'To admin@example.com · 2026-07-12 08:09:55', mono: false }
        ] }]
    }),
    'website-inquiry.html': S({
        preheaderText: 'New website inquiry: Availability for a private event.',
        category: 'Contact & Support', severity: 'action',
        leadFact: 'You have received a new contact message through the Thabiso Mhlongo official website.',
        bodyHtml:
            `<p style="margin:14px 0 6px; color:#D4AF37; font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:0.7px;">Message Body</p>` +
            `<div style="padding:16px; background:#1A1A1A; border-left:3px solid #D4AF37; color:#E6E6E6; font-size:14px; line-height:1.6;">Hi, is Thabiso available for a private birthday event on 12 September?</div>` +
            `<p style="margin:16px 0 0; color:#707070; font-size:11px; text-align:center;">This email was securely dispatched and logged in the CRM database.</p>`,
        cards: [{ rows: [
            { label: 'Name', value: 'Kagiso Dlamini', mono: false },
            { label: 'Email', rawValue: '<a href="mailto:kagiso@example.com" style="color:#D4AF37; text-decoration:none;">kagiso@example.com</a>' },
            { label: 'Category', value: 'Private Event', mono: false, highlight: true },
            { label: 'Subject', value: 'Availability for a private event', mono: false }
        ] }]
    }),
    'test-notification.html': S({
        preheaderText: 'Test notification — confirming admin routing.',
        category: 'System', severity: 'info',
        leadFact: 'This is a test email confirming that admin notifications are correctly routed to <strong style="color:#FAFAFA;">admin@thabisomhlongo.com</strong>.',
        timestamp: '2026-07-12 08:00 UTC'
    }),

    /* ── Batch 3: digests (table-in-card) ── */
    'digest-enquiries-expiring.html': S({
        preheaderText: '2 enquiry(ies) expiring within ~24 hours.',
        category: 'Booking Requests', severity: 'action',
        leadFact: 'The following enquiries will <strong style="color:#FAFAFA;">auto-expire within the next ~24 hours</strong> unless a quote is sent — after which the client is notified their request lapsed.',
        bodyHtml: `<p style="margin:0; color:#E6E6E6;">Open the Bookings pipeline and send a quote to keep them alive.</p>`,
        cards: [{ title: 'Expiring Enquiries', rows: [
            { label: '#100050 — Priya Naidoo', value: 'Corporate (event 2026-08-20)', mono: false },
            { label: '#100051 — Sipho Zulu', value: 'Birthday Party (event 2026-08-22)', mono: false }
        ] }]
    }),
    'digest-overdue-payments.html': S({
        preheaderText: '2 overdue booking(s), R5150.49 outstanding.',
        category: 'Payments & Invoices', severity: 'alert',
        leadFact: 'The following confirmed bookings have unpaid balances with past event dates.',
        cards: [{ title: 'Overdue Bookings', rows: [
            { label: '#100050 — Priya Naidoo', value: 'R3250.50 outstanding', mono: false },
            { label: '#100051 — Sipho Zulu', value: 'R1899.99 outstanding', mono: false }
        ] }]
    }),
    'digest-stalled-bookings.html': S({
        preheaderText: '2 ACCEPTED booking(s) missing an invoice.',
        category: 'Payments & Invoices', severity: 'action',
        leadFact: 'The following bookings have been in <strong style="color:#D4AF37;">ACCEPTED</strong> status for more than 3 days with no invoice generated.',
        bodyHtml: `<p style="margin:0; color:#B0B0B0; font-size:12px;">Log in to the admin portal to generate invoices for these bookings.</p>`,
        cards: [{ title: 'Stalled Bookings', rows: [
            { label: '#100050 — Priya Naidoo', value: 'Corporate · Event: 2026-08-20 · Accepted: 2026-07-08', mono: false },
            { label: '#100051 — Sipho Zulu', value: 'Birthday Party · Event: 2026-08-22 · Accepted: 2026-07-07', mono: false }
        ] }]
    }),
    'digest-ledger-discrepancy.html': S({
        preheaderText: '1 booking(s) with a payment ledger discrepancy.',
        category: 'Payments & Invoices', severity: 'alert',
        leadFact: 'The following bookings have a mismatch between <strong style="color:#FAFAFA;">bookings.amount_paid</strong> and the <strong style="color:#FAFAFA;">sum of completed non-duplicate transactions</strong>. Please investigate and correct manually.',
        cards: [{ title: 'Payment Ledger Discrepancies', rows: [
            { label: '#100045 — Naledi Mokoena · Corporate Year-End', value: 'Recorded R 18500.00 · Tx Sum R 17500.00 · Drift R 1000.00', mono: false }
        ] }]
    }),
    'digest-payfast-stuck.html': S({
        preheaderText: '1 PayFast transaction(s) stuck in PENDING for over 1 hour.',
        category: 'Payments & Invoices', severity: 'alert',
        leadFact: 'The following PayFast transactions have been in <strong style="color:#FAFAFA;">PENDING</strong> status for more than 1 hour. PayFast may have not sent an ITN. Please check the PayFast dashboard and confirm or void manually.',
        cards: [{ title: 'Stuck PayFast Transactions', rows: [
            { label: '#100050 — Priya Naidoo', value: 'R3250.50 · Started 2026-07-12 06:45:00', mono: false }
        ] }]
    }),

    /* ── Batch 4: PayFast ITN alerts (HIGH — figures verbatim) ── */
    'itn-missing-total.html': S({
        preheaderText: 'PayFast ITN for booking #100099 rejected — no total_amount set.',
        category: 'Payments & Invoices', severity: 'alert',
        leadFact: 'A PayFast ITN for booking <strong style="color:#FAFAFA;">#100099</strong> (R750.00) was <strong style="color:#E8A83E;">rejected</strong> because the booking has no total_amount set.',
        bodyHtml: `<p style="margin:0; color:#E6E6E6;">Set the booking total and replay the transaction manually.</p>`
    }),
    'itn-failed.html': S({
        preheaderText: 'PayFast payment for booking #100099 could not be recorded.',
        category: 'Payments & Invoices', severity: 'alert',
        leadFact: 'A verified PayFast payment for booking <strong style="color:#FAFAFA;">#100099</strong> (R750.00) could not be recorded: SQLITE_BUSY: database is locked.',
        bodyHtml: `<p style="margin:0; color:#E6E6E6;">The booking ledger is unchanged. Replay manually.</p>`
    }),
    'itn-overpayment.html': S({
        preheaderText: 'Overpayment detected for booking #100099 — credit NOT applied.',
        category: 'Payments & Invoices', severity: 'alert',
        leadFact: 'PayFast sent <strong style="color:#FAFAFA;">R1200.00</strong> for booking <strong style="color:#FAFAFA;">#100099</strong> but crediting it would exceed the R750.00 booking total.',
        bodyHtml: `<p style="margin:0; color:#E6E6E6;">Credit was <strong style="color:#E8A83E;">NOT applied</strong>. Manual review required.</p>`
    }),
    'itn-balance-payment-failed.html': S({
        preheaderText: 'Balance payment failed for booking #100099 — deposit remains on record.',
        category: 'Payments & Invoices', severity: 'alert',
        leadFact: 'A balance payment attempt by <strong style="color:#FAFAFA;">Priya Naidoo</strong> for Booking <strong style="color:#FAFAFA;">#100099</strong> has failed.',
        bodyHtml: `<p style="margin:0; color:#E6E6E6;">The booking still has a deposit on record. Payment status remains <strong style="color:#D4AF37;">DEPOSIT_PAID</strong>. Please follow up with the client.</p>`,
        cards: [{ rows: [{ label: 'PayFast Status', value: 'FAILED', highlight: true }] }]
    }),

    /* ── Batch 5: security / user-account (HIGH — token links verbatim) ── */
    'dashboard-invite.html': S({
        preheaderText: "You've been added as a Manager to the Thabiso Mhlongo dashboard.",
        category: 'User Accounts & Security', severity: 'action',
        leadFact: 'Hello <strong style="color:#FAFAFA;">Naledi</strong> — you\'ve been added as a <strong style="color:#FAFAFA;">Manager</strong> to the Thabiso Mhlongo management dashboard.',
        bodyHtml:
            `<p style="margin:0 0 18px; color:#E6E6E6;">To activate your account, set your password using the secure link below. This link will safely expire in 72 hours.</p>` +
            C.ctaButton({ label: 'Set Your Password', url: '#' }) +
            `<p style="margin:18px 0 0; color:#E6E6E6;">Your sign-in email is <strong style="color:#FAFAFA;">naledi@example.com</strong>.</p>` +
            `<p style="margin:10px 0 0; color:#B0B0B0; font-size:12px;">If you weren't expecting this invitation, you can safely ignore this automated message.</p>`
    }),
    'password-reset.html': S({
        preheaderText: 'A password reset was requested for your dashboard account.',
        category: 'User Accounts & Security', severity: 'action',
        leadFact: 'Hello <strong style="color:#FAFAFA;">admin</strong> — we received a request to reset the administrative password associated with this email address.',
        bodyHtml:
            `<p style="margin:0 0 18px; color:#E6E6E6;">You can reset your password by clicking the secure link below. This link will safely expire in 1 hour.</p>` +
            C.ctaButton({ label: 'Reset Password', url: '#' }) +
            `<p style="margin:18px 0 0; color:#B0B0B0; font-size:12px;">If you did not request a password reset, you can safely ignore this automated message.</p>`
    })
};

const PREMIUM_DIR = path.join(OUT_DIR, 'premium');
if (!fs.existsSync(PREMIUM_DIR)) fs.mkdirSync(PREMIUM_DIR, { recursive: true });
const SYSTEM_DIR = path.join(OUT_DIR, 'system');
if (!fs.existsSync(SYSTEM_DIR)) fs.mkdirSync(SYSTEM_DIR, { recursive: true });

let ok = 0;
for (const [name, html] of Object.entries(files)) {
    const p = path.join(OUT_DIR, name);
    fs.writeFileSync(p, html, 'utf8');
    const kb = (Buffer.byteLength(html, 'utf8') / 1024).toFixed(1);
    console.log(`✓ ${path.relative(path.join(__dirname, '..'), p)}  (${kb} KB)`);
    ok++;
}
for (const [name, html] of Object.entries(premium)) {
    const p = path.join(PREMIUM_DIR, name);
    fs.writeFileSync(p, html, 'utf8');
    const kb = (Buffer.byteLength(html, 'utf8') / 1024).toFixed(1);
    console.log(`✓ ${path.relative(path.join(__dirname, '..'), p)}  (${kb} KB)`);
    ok++;
}
for (const [name, html] of Object.entries(system)) {
    const p = path.join(SYSTEM_DIR, name);
    fs.writeFileSync(p, html, 'utf8');
    const kb = (Buffer.byteLength(html, 'utf8') / 1024).toFixed(1);
    console.log(`✓ ${path.relative(path.join(__dirname, '..'), p)}  (${kb} KB)`);
    ok++;
}
console.log(`\nRendered ${ok} preview file(s) → email-previews/ (+ premium/, system/)`);
console.log('Open them in a browser to review the component system.');
