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

let ok = 0;
for (const [name, html] of Object.entries(files)) {
    const p = path.join(OUT_DIR, name);
    fs.writeFileSync(p, html, 'utf8');
    const kb = (Buffer.byteLength(html, 'utf8') / 1024).toFixed(1);
    console.log(`✓ ${path.relative(path.join(__dirname, '..'), p)}  (${kb} KB)`);
    ok++;
}
console.log(`\nRendered ${ok} preview file(s) → email-previews/`);
console.log('Open them in a browser to review the component system.');
