// Event ticketing - getting tickets to the buyer (docs-internal/ticketing.md), through the EXISTING mail and PDF code:
//   * one e-mail per paid order (js/emailService.js sendEmail - the one transport and its queue), with every ticket's QR code inline
//     (data: images become CID attachments in emailService) AND a PDF of the tickets attached (js/pdfService.js generateTicketsPdf);
//   * a link back to the tickets on the site (/?tickets=<public reference>);
//   * the QR code encodes <site>/t/<token> - the door check-in page (routes/public/ticketing.js);
//   * PDFs and QR images are rebuilt from the database whenever they are needed, never stored.
// Buyer/holder names are stored as plain text (lib/ticketing-core.js); event text comes from the events table, entity-encoded, so it is
// decoded for the PDF and escaped (emailComponents.esc decodes first) for HTML.
const QRCode = require('qrcode');
const { dbRun, dbGet, dbAll } = require('./db-helpers');
const core = require('./ticketing-core');
const { decodeStoredText } = require('./html-sanitize');
const { emailBaseUrl, getEmailFooterContext } = require('./email-context');
const { loadIssuer } = require('./business-profile');
const pdfService = require('../js/pdfService');
const emailComponents = require('../js/emailComponents');
const bannerRegistry = require('../js/bannerRegistry');
const { sendEmail } = require('../js/emailService');
const { getNotificationEmail } = require('../database/repositories/settings.repository');

const esc = emailComponents.esc;
const ticketUrl = (token) => `${emailBaseUrl()}/t/${token}`;
const ordersViewUrl = (ref) => `${emailBaseUrl()}/?tickets=${encodeURIComponent(ref)}`;
const QR_OPTS = { errorCorrectionLevel: 'M', margin: 2, color: { dark: '#000000', light: '#FFFFFF' } };
const qrPng = (text) => QRCode.toBuffer(text, { ...QR_OPTS, width: 600 });
const qrDataUri = (text) => QRCode.toDataURL(text, { ...QR_OPTS, width: 320 });

// Everything about a paid order that its tickets need. Voided (refunded) tickets are left out.
async function orderBundle(orderId) {
    const order = await dbGet('SELECT * FROM ticket_orders WHERE id = ?', [orderId]);
    if (!order) return null;
    const event = await dbGet('SELECT event_id, event_title, event_datetime, venue_name FROM events WHERE event_id = ?', [order.event_id]);
    const tickets = await dbAll(
        `SELECT k.id, k.token, k.holder_name, k.checked_in_at, k.voided_at, t.name AS tier_name
         FROM tickets k JOIN ticket_types t ON t.id = k.ticket_type_id WHERE k.order_id = ? AND k.voided_at IS NULL ORDER BY k.id`, [orderId]);
    const start = core.eventStart(event);
    return {
        order, tickets,
        event: { id: event && event.event_id, title: decodeStoredText((event && event.event_title) || 'Show'), when: start ? core.formatSast(start) : '', venue: decodeStoredText((event && event.venue_name) || '') }
    };
}

// The tickets of a paid order as one PDF (a Buffer), or null when the order has none to show.
async function ticketsPdf(orderId) {
    const b = await orderBundle(orderId);
    if (!b || b.order.status !== 'paid' || !b.tickets.length) return null;
    const tickets = [];
    for (const t of b.tickets) tickets.push({ tier_name: t.tier_name, holder_name: t.holder_name, token: t.token, url: ticketUrl(t.token), qrPng: await qrPng(ticketUrl(t.token)) });
    return pdfService.generateTicketsPdf({ event: b.event, order: { id: b.order.id, buyer_name: b.order.buyer_name }, tickets, issuer: await loadIssuer().catch(() => null) });
}

// The QR codes for the buyer's own "your tickets" view on the site (routes/public/ticketing.js).
async function ticketsForBuyer(orderId) {
    const b = await orderBundle(orderId);
    if (!b) return [];
    const out = [];
    for (const t of b.tickets) out.push({ tier_name: t.tier_name, holder_name: t.holder_name, code: t.token, qr: await qrDataUri(ticketUrl(t.token)), checked_in: !!t.checked_in_at });
    return out;
}

// The tickets e-mail. opts.resend: an admin pressed Resend (the subject says so). Resolves the sendEmail result.
async function deliverOrder(orderId, opts = {}) {
    const b = await orderBundle(orderId);
    if (!b || b.order.status !== 'paid' || !b.tickets.length || !b.order.buyer_email) return { success: false, error: 'nothing to send' };
    const { order, event, tickets } = b;
    const cards = [{
        title: 'Your booking', rows: [
            { label: 'Show', value: event.title, mono: false }, { label: 'When', value: event.when, mono: false },
            event.venue ? { label: 'Where', value: event.venue, mono: false } : null,
            { label: 'Order', value: `#${order.id}` }, { label: 'Paid', value: core.formatZar(order.total_cents), highlight: true }
        ].filter(Boolean)
    }];
    for (let i = 0; i < tickets.length; i++) {
        const t = tickets[i];
        const qr = await qrDataUri(ticketUrl(t.token));
        cards.push({
            title: `Ticket ${i + 1} of ${tickets.length} - ${t.tier_name}`, rows: [
                { label: 'Name', value: t.holder_name || order.buyer_name, mono: false },
                { label: 'Code', value: t.token.match(/.{1,4}/g).join(' ') },
                { label: 'Scan at the door', rawValue: `<img src="${qr}" width="180" height="180" alt="QR code for ticket ${i + 1}" style="display:block; width:180px; height:180px; border:0; background:#FFFFFF;">` }
            ]
        });
    }
    const pdf = await ticketsPdf(order.id);
    const { socialLinks } = await getEmailFooterContext();
    const banner = await bannerRegistry.resolveBanner('ticket_confirmation');
    const html = emailComponents.renderPremiumEmail({
        preheaderText: `Your ${tickets.length === 1 ? 'ticket' : tickets.length + ' tickets'} for ${event.title}.`,
        bannerSrc: banner && banner.src, bannerAlt: banner && banner.alt, subtitle: banner && banner.subtitle,
        headline: (banner && banner.headline) || 'Your Tickets',
        greeting: `Hi ${esc(order.buyer_name)},`,
        bodyHtml: `Thank you - your payment was received and your ${tickets.length === 1 ? 'ticket is' : 'tickets are'} below and in the attached PDF. ` +
            `Show the QR code (on your phone or printed) at the door; each code lets one person in, once, so please don't share it.`,
        cards,
        cta: { label: 'View my tickets', url: ordersViewUrl(order.public_reference) },
        socialLinks
    });
    const result = await sendEmail({
        to: order.buyer_email,
        subject: `${opts.resend ? 'Your tickets (resent)' : 'Your tickets'} - ${event.title}`,
        htmlContent: html, preWrapped: true, titleOverride: 'Your Tickets',
        attachments: pdf ? [{ filename: `tickets-order-${order.id}.pdf`, content: pdf, contentType: 'application/pdf' }] : [],
        trigger_event: opts.resend ? 'Tickets: Resent' : 'Tickets: Confirmation', related_entity: 'ticket_order', related_id: order.id
    });
    if (result && result.success) await require('./ticketing').inTransaction(() => dbRun('UPDATE ticket_orders SET tickets_emailed_at = ? WHERE id = ?', [new Date().toISOString(), order.id]));
    return result;
}

// PayFast took the money but the tickets had gone (a payment that arrived after its hold ran out): tell the buyer, alert the office.
async function notifyRefundRequired(orderId) {
    const b = await orderBundle(orderId);
    if (!b) return;
    const { order, event } = b;
    if (order.buyer_email) {
        const { socialLinks } = await getEmailFooterContext();
        await sendEmail({
            to: order.buyer_email, subject: `About your ticket payment - ${event.title}`, preWrapped: true, titleOverride: 'About Your Payment',
            htmlContent: emailComponents.renderPremiumEmail({
                preheaderText: `We received your payment for ${event.title}, but the tickets sold out.`,
                headline: 'About Your Payment', greeting: `Hi ${esc(order.buyer_name)},`,
                bodyHtml: `We received your payment of <strong>${esc(core.formatZar(order.total_cents))}</strong> for <strong>${esc(event.title)}</strong>, ` +
                    `but it arrived after your 10-minute hold had ended and the tickets sold out in the meantime, so no tickets were issued. We're sorry. ` +
                    `<strong>We will refund the full amount</strong> to your original payment method and e-mail you as soon as the refund has been made. ` +
                    `You don't need to do anything.`,
                cards: [{ rows: [{ label: 'Order', value: `#${order.id}` }, { label: 'Amount', value: core.formatZar(order.total_cents), highlight: true }] }],
                socialLinks
            }),
            trigger_event: 'Tickets: Refund Due', related_entity: 'ticket_order', related_id: order.id
        });
    }
    await alertAdmin({
        subject: `Ticket refund needed - Order ${order.id}`,
        lead: `A payment of <strong>${esc(core.formatZar(order.total_cents))}</strong> for ticket order <strong>#${order.id}</strong> (${esc(event.title)}) arrived after its hold ended and the tickets had sold out. <strong>No tickets were issued.</strong>`,
        body: 'Refund the payment in the PayFast dashboard, then mark the order refunded under Events -> Ticket Sales.',
        trigger: 'Admin: Ticket Refund Needed'
    });
}

// The refund has been made (an administrator recorded it in Events -> Ticket Sales after refunding in PayFast): tell the buyer, and that
// any tickets of the order no longer work.
async function notifyRefunded(orderId) {
    const order = await dbGet('SELECT * FROM ticket_orders WHERE id = ?', [orderId]);
    if (!order || order.status !== 'refunded' || !order.buyer_email) return { success: false, error: 'nothing to send' };
    const event = await dbGet('SELECT event_title FROM events WHERE event_id = ?', [order.event_id]);
    const title = decodeStoredText((event && event.event_title) || 'the show');
    const issued = (await dbGet('SELECT COUNT(*) AS n FROM tickets WHERE order_id = ?', [order.id])).n;
    const { socialLinks } = await getEmailFooterContext();
    return sendEmail({
        to: order.buyer_email, subject: `Your refund has been made - ${title}`, preWrapped: true, titleOverride: 'Refund Made',
        htmlContent: emailComponents.renderPremiumEmail({
            preheaderText: `Your refund of ${core.formatZar(order.total_cents)} for ${title} has been made.`,
            headline: 'Refund Made', greeting: `Hi ${esc(order.buyer_name)},`,
            bodyHtml: `Your refund of <strong>${esc(core.formatZar(order.total_cents))}</strong> for <strong>${esc(title)}</strong> has been made to your original payment method. ` +
                `Depending on your bank it can take a few working days to show on your statement.` +
                (issued ? ` The ${issued === 1 ? 'ticket' : issued + ' tickets'} from this order no longer work at the door.` : ''),
            cards: [{ rows: [{ label: 'Order', value: `#${order.id}` }, { label: 'Refunded', value: core.formatZar(order.total_cents), highlight: true }] }],
            socialLinks
        }),
        trigger_event: 'Tickets: Refund Made', related_entity: 'ticket_order', related_id: order.id
    });
}

// An e-mail to the office (the notification address in Settings), in the existing system-alert style.
async function alertAdmin({ subject, lead, body, trigger }) {
    const to = await getNotificationEmail();
    if (!to) return;
    return sendEmail({
        to, subject, preWrapped: true, titleOverride: subject, trigger_event: trigger || 'Admin: Ticketing',
        htmlContent: emailComponents.renderSystemEmail({ preheaderText: subject, category: 'Event Tickets', severity: 'alert', leadFact: lead, bodyHtml: body ? `<p style="margin:0;">${esc(body)}</p>` : '' })
    });
}

module.exports = { ticketUrl, ordersViewUrl, qrPng, qrDataUri, orderBundle, ticketsPdf, ticketsForBuyer, deliverOrder, notifyRefundRequired, notifyRefunded, alertAdmin };
