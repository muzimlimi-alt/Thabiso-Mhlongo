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
    })
};

const PREMIUM_DIR = path.join(OUT_DIR, 'premium');
if (!fs.existsSync(PREMIUM_DIR)) fs.mkdirSync(PREMIUM_DIR, { recursive: true });

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
console.log(`\nRendered ${ok} preview file(s) → email-previews/ (+ premium/)`);
console.log('Open them in a browser to review the component system.');
