/**
 * Thabiso Mhlongo — Email Component System (Prompt 2)
 * =====================================================
 * Reusable, HARD-RULE-compliant email partials. Pure functions that return
 * HTML strings — no DB, no fs, no dependencies — so they are trivially unit-
 * testable and preview-renderable.
 *
 * HARD RULES honoured (see antigravity-email-system-prompts.md, Prompt 0):
 *  - Layout is table-based with inline CSS. The <style> block carries hover /
 *    responsive progressive-enhancement ONLY; no critical layout depends on it.
 *  - CTAs are bulletproof table/VML buttons, never baked into images.
 *  - Dark-mode safety: color-scheme meta + bgcolor attribute AND inline
 *    background-color on every structural table; obsidian #0A0A0A (not #000).
 *  - Fallback font stacks only (real brand fonts assumed only inside banner art).
 *  - Every image has alt text + explicit width/height.
 *
 * NOTE: This module is the toolkit for the Prompt 3/4 rebuild. It does NOT touch
 * the live pipeline (js/emailService.js still uses js/emailTemplates.js) yet.
 */

'use strict';

/* ── Brand tokens (single source of truth — no ad-hoc hex in components) ── */
const TOKENS = {
    obsidian:  '#0A0A0A',   // body / page background
    sectionBg: '#111111',   // header / footer / banner-fallback surface
    card:      '#1A1A1A',   // info cards, alert strips
    cardBorder:'#2A2A2A',   // card hairline
    gold:      '#D4AF37',   // brand gold
    goldHover: '#E8C14B',   // interactive gold (progressive hover)
    amber:     '#E8A83E',   // alert severity (never red-on-black)
    ink:       '#FAFAFA',   // near-white strong text (avoid pure #FFF)
    text:      '#E6E6E6',   // body copy
    muted:     '#B0B0B0',   // secondary text
    mutedDim:  '#707070',   // legal / de-emphasised
    hairline:  'rgba(255,255,255,0.08)',
    // Fallback font stacks — web fonts are NOT reliable in email.
    serif: "'Cormorant Garamond', Georgia, 'Times New Roman', serif",
    body:  "'Outfit', 'Helvetica Neue', Helvetica, Arial, sans-serif",
    mono:  "'JetBrains Mono', Consolas, 'Courier New', monospace",
    maxWidth: 600
};

/* ── Small helpers ── */
function esc(v) {
    return String(v == null ? '' : v)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function renderSocial(socialLinks = []) {
    const iconFor = (platform) => {
        const n = (platform || '').toLowerCase().trim();
        if (n.includes('instagram')) return 'instagram';
        if (n.includes('facebook')) return 'facebook';
        if (n.includes('linkedin')) return 'linkedin';
        if (n.includes('tiktok')) return 'tiktok';
        if (n.includes('whatsapp')) return 'whatsapp';
        if (n.includes('youtube')) return 'youtube';
        if (n.includes('twitter') || n === 'x') return 'x';
        return 'link';
    };
    if (!socialLinks || socialLinks.length === 0) return '';
    return socialLinks.map(l =>
        `<a href="${l.platform_url}" target="_blank" rel="noopener noreferrer" title="${esc(l.platform_name)}" style="display:inline-block; margin:0 7px; text-decoration:none;"><img src="https://img.icons8.com/ios-filled/40/D4AF37/${iconFor(l.platform_name)}.png" alt="${esc(l.platform_name)}" width="22" height="22" style="display:block; width:22px; height:22px; border:0;" /></a>`
    ).join('');
}

/* ── Hidden preheader (inbox preview text) ── */
function preheader(text = '') {
    if (!text) return '';
    // Trailing zero-width chars stop the client pulling body copy into the preview.
    return `<div style="display:none; max-height:0; overflow:hidden; mso-hide:all; opacity:0; color:transparent; height:0; width:0; font-size:1px; line-height:1px;">${esc(text)}${'&zwnj;&nbsp;'.repeat(30)}</div>`;
}

/* ── 1. base_layout ── 600px table shell, dark-mode-safe ── */
function baseLayout({ preheaderText = '', contentHtml = '', footerHtml = '', title = 'Thabiso Mhlongo' } = {}) {
    return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="color-scheme" content="dark">
<meta name="supported-color-schemes" content="dark">
<title>${esc(title)}</title>
<!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->
<style>
  /* Progressive enhancement ONLY — no critical layout lives here. */
  a { text-decoration: none; }
  .tm-btn:hover { background-color: ${TOKENS.goldHover} !important; }
  @media screen and (max-width: 600px) {
    .tm-container { width: 100% !important; }
    .tm-px { padding-left: 24px !important; padding-right: 24px !important; }
  }
</style>
</head>
<body style="margin:0; padding:0; background-color:${TOKENS.obsidian}; -webkit-text-size-adjust:100%; -ms-text-size-adjust:100%;" bgcolor="${TOKENS.obsidian}">
${preheader(preheaderText)}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${TOKENS.obsidian}" style="background-color:${TOKENS.obsidian};">
  <tr>
    <td align="center" style="padding:24px 12px;">
      <table role="presentation" class="tm-container" width="${TOKENS.maxWidth}" cellpadding="0" cellspacing="0" border="0" bgcolor="${TOKENS.obsidian}" style="width:${TOKENS.maxWidth}px; max-width:${TOKENS.maxWidth}px; background-color:${TOKENS.obsidian}; border:1px solid rgba(255,255,255,0.12);">
        <tr><td>${contentHtml}</td></tr>
        <tr><td>${footerHtml}</td></tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}

/* ── 2. header ── text wordmark (always renders) + optional banner ── */
function header({ bannerSrc = null, alt = 'Thabiso Mhlongo', headline = '', subtitle = '' } = {}) {
    const wordmark = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${TOKENS.obsidian}" style="background-color:${TOKENS.obsidian};"><tr><td align="center" style="padding:26px 24px 18px;">
    <span style="font-family:${TOKENS.serif}; font-size:20px; letter-spacing:3px; color:${TOKENS.ink}; text-transform:uppercase;">Thabiso <span style="color:${TOKENS.gold};">Mhlongo</span></span>
  </td></tr></table>`;
    return wordmark + bannerSlot({ bannerSrc, alt, headline, subtitle });
}

/* ── 3. banner_slot ── image by src, or graceful text-headline fallback ── */
function bannerSlot({ bannerSrc = null, alt = 'Thabiso Mhlongo', headline = '', subtitle = '' } = {}) {
    if (bannerSrc) {
        return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${TOKENS.sectionBg}" style="background-color:${TOKENS.sectionBg};"><tr><td align="center" style="font-size:0; line-height:0;">
    <img src="${bannerSrc}" alt="${esc(alt)}" width="600" height="176" style="display:block; width:100%; max-width:600px; height:auto; border:0;" />
  </td></tr></table>`;
    }
    // Fallback: text headline block (no image dependency)
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${TOKENS.sectionBg}" style="background-color:${TOKENS.sectionBg}; border-top:1px solid ${TOKENS.hairline}; border-bottom:1px solid ${TOKENS.hairline};"><tr><td align="center" class="tm-px" style="padding:38px 32px;">
    <div style="font-family:${TOKENS.serif}; font-size:26px; line-height:1.2; color:${TOKENS.gold}; letter-spacing:0.5px;">${esc(headline || 'Thabiso Mhlongo')}</div>
    ${subtitle ? `<div style="font-family:${TOKENS.body}; font-size:13px; color:${TOKENS.muted}; margin-top:8px;">${esc(subtitle)}</div>` : ''}
  </td></tr></table>`;
}

/* ── content padding block (body copy) ── */
function contentBlock(innerHtml = '', pad = '32px 40px') {
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${TOKENS.obsidian}" style="background-color:${TOKENS.obsidian};"><tr><td class="tm-px" style="padding:${pad};">${innerHtml}</td></tr></table>`;
}

/* ── 4. cta_button ── bulletproof table + VML button ── */
function ctaButton({ label = 'View', url = '#' } = {}) {
    return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:6px auto;"><tr><td align="center">
  <!--[if mso]>
  <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${url}" style="height:48px; v-text-anchor:middle; width:260px;" arcsize="8%" strokecolor="${TOKENS.gold}" fillcolor="${TOKENS.gold}">
    <w:anchorlock/>
    <center style="color:${TOKENS.obsidian}; font-family:Arial,sans-serif; font-size:14px; font-weight:bold; letter-spacing:1px;">${esc(label)}</center>
  </v:roundrect>
  <![endif]-->
  <!--[if !mso]><!-- -->
  <a class="tm-btn" href="${url}" target="_blank" style="background-color:${TOKENS.gold}; color:${TOKENS.obsidian}; display:inline-block; font-family:${TOKENS.body}; font-size:14px; font-weight:700; letter-spacing:1px; line-height:48px; min-height:48px; text-align:center; text-decoration:none; text-transform:uppercase; min-width:220px; padding:0 30px; border-radius:3px;">${esc(label)}</a>
  <!--<![endif]-->
  </td></tr></table>`;
}

/* ── 5. info_card ── label/value rows; values in mono by default ── */
function infoCard({ title = '', rows = [] } = {}) {
    const rowsHtml = (rows || []).map((r, i) => {
        const last = i === rows.length - 1;
        const bb = last ? '' : `border-bottom:1px solid ${TOKENS.hairline};`;
        const valFont = r.mono === false ? TOKENS.body : TOKENS.mono;
        const valColor = r.highlight ? TOKENS.gold : TOKENS.ink;
        const valSize = r.highlight ? '16px' : '14px';
        const value = r.rawValue != null ? r.rawValue : esc(r.value);
        return `<tr>
      <td style="padding:12px 18px; ${bb} font-family:${TOKENS.body}; font-size:13px; color:${TOKENS.muted}; width:42%; vertical-align:top;">${esc(r.label)}</td>
      <td style="padding:12px 18px; ${bb} font-family:${valFont}; font-size:${valSize}; color:${valColor}; vertical-align:top;">${value}</td>
    </tr>`;
    }).join('');
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${TOKENS.card}" style="background-color:${TOKENS.card}; border:1px solid ${TOKENS.cardBorder}; border-radius:6px;">
    ${title ? `<tr><td style="padding:14px 18px 2px; font-family:${TOKENS.body}; font-size:11px; font-weight:700; letter-spacing:1px; text-transform:uppercase; color:${TOKENS.gold};">${esc(title)}</td></tr>` : ''}
    <tr><td style="padding:6px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rowsHtml}</table></td></tr>
  </table>`;
}

/* ── 6a. divider ── gold hairline ── */
function divider() {
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" style="padding:10px 0;">
    <table role="presentation" width="44" cellpadding="0" cellspacing="0" border="0"><tr><td height="2" bgcolor="${TOKENS.gold}" style="background-color:${TOKENS.gold}; height:2px; line-height:2px; font-size:0;">&nbsp;</td></tr></table>
  </td></tr></table>`;
}

/* ── 6b. spacer ── vertical rhythm ── */
function spacer(px = 24) {
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td height="${px}" style="height:${px}px; line-height:${px}px; font-size:0;">&nbsp;</td></tr></table>`;
}

/* ── 7. alert_strip ── gold/amber left border on card, no red ── */
function alertStrip({ severity = 'info', text = '' } = {}) {
    const colour = { info: TOKENS.muted, action: TOKENS.gold, alert: TOKENS.amber }[severity] || TOKENS.muted;
    const label = { info: 'INFO', action: 'ACTION REQUIRED', alert: 'ALERT' }[severity] || 'INFO';
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${TOKENS.card}" style="background-color:${TOKENS.card}; border-left:3px solid ${colour};"><tr><td style="padding:13px 16px;">
    <div style="font-family:${TOKENS.mono}; font-size:10px; font-weight:700; letter-spacing:1px; color:${colour}; margin-bottom:5px;">${label}</div>
    <div style="font-family:${TOKENS.body}; font-size:14px; line-height:1.5; color:${TOKENS.ink};">${text}</div>
  </td></tr></table>`;
}

/* ── 8. footer ── contact/social/legal + conditional unsubscribe ── */
function footer({ unsubscribeUrl = null, socialLinks = [] } = {}) {
    const social = renderSocial(socialLinks);
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${TOKENS.sectionBg}" style="background-color:${TOKENS.sectionBg}; border-top:1px solid ${TOKENS.hairline};"><tr><td align="center" class="tm-px" style="padding:28px 32px;">
    <div style="font-family:${TOKENS.body}; font-size:13px; color:${TOKENS.muted};"><strong style="color:${TOKENS.ink};">Thabiso Mhlongo Management</strong></div>
    <div style="font-family:${TOKENS.serif}; font-size:14px; font-style:italic; color:${TOKENS.gold}; margin-top:2px;">Officially funny since 2014</div>
    ${social ? `<div style="margin:16px 0 4px;">${social}</div>` : `<div style="height:8px; line-height:8px; font-size:0;">&nbsp;</div>`}
    <div style="font-family:${TOKENS.body}; font-size:12px; color:${TOKENS.muted}; margin-top:8px;"><a href="https://thabisomhlongo.com" target="_blank" style="color:${TOKENS.muted}; text-decoration:underline;">thabisomhlongo.com</a> &nbsp;&bull;&nbsp; South Africa &bull; Nationwide</div>
    <div style="font-family:${TOKENS.body}; font-size:11px; color:${TOKENS.mutedDim}; margin-top:12px;">&copy; ${new Date().getFullYear()} Thabiso Mhlongo. All rights reserved.</div>
    ${unsubscribeUrl ? `<div style="margin-top:16px; padding-top:12px; border-top:1px solid rgba(255,255,255,0.06);"><a href="${unsubscribeUrl}" target="_blank" style="font-family:${TOKENS.body}; font-size:11px; color:${TOKENS.mutedDim}; text-decoration:underline;">Unsubscribe from this list</a></div>` : ''}
  </td></tr></table>`;
}

/* ── 9. system_header ── compact mono text header, no photographic banner ── */
function systemHeader({ category = 'System Notification', timestamp = null, severity = 'info' } = {}) {
    const ts = timestamp || (new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC');
    const colour = { info: TOKENS.muted, action: TOKENS.gold, alert: TOKENS.amber }[severity] || TOKENS.muted;
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${TOKENS.sectionBg}" style="background-color:${TOKENS.sectionBg}; border-bottom:1px solid ${TOKENS.hairline};"><tr><td class="tm-px" style="padding:18px 28px;">
    <div style="font-family:${TOKENS.mono}; font-size:12px; font-weight:700; letter-spacing:1.5px; color:${TOKENS.gold};">TM &middot; SYSTEM NOTIFICATION</div>
    <div style="font-family:${TOKENS.mono}; font-size:11px; color:${colour}; margin-top:5px;">${esc(category)} &nbsp;&bull;&nbsp; <span style="color:${TOKENS.muted};">${esc(ts)}</span></div>
  </td></tr></table>`;
}

/* ── Composer: PREMIUM email (client/visitor/subscriber) ── */
function renderPremiumEmail({
    preheaderText = '', bannerSrc = null, bannerAlt = 'Thabiso Mhlongo', headline = '', subtitle = '', greeting = '',
    bodyHtml = '', cards = [], cta = null, unsubscribeUrl = null, socialLinks = [], title = null
} = {}) {
    const cardsHtml = (cards || []).map(c => infoCard(c)).join(spacer(8));
    const inner =
        (greeting ? `<div style="font-family:${TOKENS.body}; font-size:18px; color:${TOKENS.ink}; margin-bottom:14px;">${greeting}</div>` : '') +
        (bodyHtml ? `<div style="font-family:${TOKENS.body}; font-size:16px; line-height:1.6; color:${TOKENS.text};">${bodyHtml}</div>` : '') +
        (cardsHtml ? spacer(18) + cardsHtml : '') +
        (cta ? spacer(22) + ctaButton(cta) : '');
    const content = header({ bannerSrc, alt: bannerAlt, headline, subtitle }) + contentBlock(inner);
    return baseLayout({
        preheaderText, contentHtml: content,
        footerHtml: footer({ unsubscribeUrl, socialLinks }),
        title: title || headline || 'Thabiso Mhlongo'
    });
}

/* ── Composer: SYSTEM email (internal admin/ops) ── */
function renderSystemEmail({
    preheaderText = '', category = 'System Notification', severity = 'info',
    leadFact = '', bodyHtml = '', cards = [], timestamp = null, title = null
} = {}) {
    const cardsHtml = (cards || []).map(c => infoCard(c)).join(spacer(8));
    const inner =
        (leadFact ? alertStrip({ severity, text: leadFact }) : '') +
        (bodyHtml ? `<div style="font-family:${TOKENS.body}; font-size:14px; line-height:1.55; color:${TOKENS.text}; margin-top:${leadFact ? '14px' : '0'};">${bodyHtml}</div>` : '') +
        (cardsHtml ? spacer(14) + cardsHtml : '');
    const content = systemHeader({ category, severity, timestamp }) + contentBlock(inner, '24px 28px');
    return baseLayout({
        preheaderText, contentHtml: content,
        footerHtml: footer({}),
        title: title || category
    });
}

module.exports = {
    TOKENS,
    esc,
    preheader,
    baseLayout,
    header,
    bannerSlot,
    contentBlock,
    ctaButton,
    infoCard,
    divider,
    spacer,
    alertStrip,
    footer,
    systemHeader,
    renderPremiumEmail,
    renderSystemEmail
};
