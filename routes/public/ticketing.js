// Event ticketing - public API (docs-internal/ticketing.md). The drawer on the Events section of the homepage uses these:
//   GET  /api/public/events/:id/tickets              what is on sale for a show
//   POST /api/public/ticket-orders                   reserve tickets (a 10-minute hold) -> the order's reference
//   POST /api/public/ticket-orders/:ref/checkout     buyer details + POPIA consent -> the signed PayFast redirect
//   GET  /api/public/ticket-orders/:ref              the order's status (the return page polls this - the return itself proves nothing)
//   POST /api/public/ticket-orders/:ref/payment-check  back from PayFast: ask the safety net to confirm with PayFast's own records now
//   POST /api/public/ticket-orders/:ref/release      give the held tickets back now
//   GET  /api/public/ticket-orders/:ref/tickets.pdf  the paid tickets as a PDF
//   GET  /t/:token                                   the page a ticket's QR code opens: "Valid ticket for <show>" - and, for signed-in
//                                                    staff, the door check-in (js/checkin.js; the check-in itself is an admin POST)
// The order reference is 144 random bits and is the buyer's key to their own order (it is in their e-mail); nothing here takes a price,
// a total or a payment status from the request.
const express = require('express');
const path = require('path');
const { ticketReserveRateLimiter, ticketLookupRateLimiter } = require('../../middleware/rate-limiters');
const turnstile = require('../../lib/turnstile');
const { CURRENT_POLICY_VERSION } = require('../../lib/booking-policy');
const core = require('../../lib/ticketing-core');
const ticketing = require('../../lib/ticketing');
const payments = require('../../lib/ticketing-payments');
const delivery = require('../../lib/ticketing-delivery');
const reconcile = require('../../lib/payfast-reconcile');
const { decodeStoredText } = require('../../lib/html-sanitize');
const router = express.Router();

const fail = (res, e, label) => {
    if (e && e.refusal) return res.status(e.status).json({ success: false, message: e.message, errors: e.errors, sold_out: e.sold_out, order_status: e.order_status });
    console.error(`[Ticketing] ${label}:`, e && e.message);
    return res.status(500).json({ success: false, message: 'Something went wrong. Please try again.' });
};
const maskEmail = (e) => {
    const [user, domain] = String(e || '').split('@');
    if (!user || !domain) return '';
    return `${user[0]}${'*'.repeat(Math.max(1, Math.min(6, user.length - 1)))}@${domain}`;
};
const noStore = (res) => res.set('Cache-Control', 'no-store');

// The order as its buyer may see it. Paid orders carry their tickets (QR codes) - the reference IS the buyer's key to them.
async function orderView(order) {
    const ev = await ticketing.getEvent(order.event_id);
    const items = await ticketing.orderItems(order.id);
    return {
        reference: order.public_reference, order_number: order.id, status: order.status, refund_required: !!order.refund_required,
        total_cents: order.total_cents, reserved_until: order.reserved_until, server_now: new Date().toISOString(),
        checkout_started: !!order.checkout_started_at, email_hint: maskEmail(order.buyer_email),
        event: ev ? ticketing.publicEvent(ev) : null,
        items: items.map(i => ({ name: i.name, quantity: i.quantity, unit_price_cents: i.unit_price_cents })),
        terms: order.status === 'pending' ? core.TICKET_TERMS : undefined,
        tickets: order.status === 'paid' && !order.refund_required ? await delivery.ticketsForBuyer(order.id) : []
    };
}

// A pending order whose hold has passed is released the moment anyone looks at it (the sweep would do it within a minute anyway).
async function freshOrder(ref) {
    let order = await ticketing.getOrderByReference(ref);
    if (order && order.status === 'pending' && order.reserved_until < new Date().toISOString()) {
        await ticketing.expireStaleOrders(order.event_id);
        order = await ticketing.getOrderById(order.id);
    }
    return order;
}

router.get('/api/public/events/:id/tickets', ticketLookupRateLimiter, async (req, res) => {
    try {
        noStore(res);
        const data = await ticketing.publicEventTickets(req.params.id);
        if (!data) return res.status(404).json({ success: false, message: 'Tickets for this show are not available online.' });
        // bot_check: the Turnstile site key when the "are you human?" check is on (lib/turnstile.js), else null
        res.json({ success: true, ...data, bot_check: turnstile.config().siteKey });
    } catch (e) { fail(res, e, 'event tickets'); }
});

// Turnstile (off unless its keys are set) before a hold is made - holding stock is what a bot would abuse; one check per purchase.
router.post('/api/public/ticket-orders', ticketReserveRateLimiter, turnstile.requireTurnstile, async (req, res) => {
    try {
        noStore(res);
        const body = req.body || {};
        const { order } = await ticketing.reserve(body.event_id, Array.isArray(body.items) ? body.items : [], body.hold_key);
        res.status(201).json({ success: true, order: await orderView(order) });
    } catch (e) {
        if (e && e.refusal && e.sold_out) {
            // send the fresh counts with a sell-out, so the drawer can show what is still left
            const fresh = await ticketing.publicEventTickets(e.event_id).catch(() => null);
            return res.status(409).json({ success: false, message: e.message, sold_out: e.sold_out, tiers: fresh ? fresh.tiers : [] });
        }
        fail(res, e, 'reserve');
    }
});

router.post('/api/public/ticket-orders/:ref/checkout', ticketReserveRateLimiter, async (req, res) => {
    try {
        noStore(res);
        const existing = await freshOrder(req.params.ref);
        if (!existing) return res.status(404).json({ success: false, message: 'We could not find that order.' });
        const items = await ticketing.orderItems(existing.id);
        const count = items.reduce((n, i) => n + i.quantity, 0);
        const { clean, errors } = core.validateBuyer(req.body, count);
        if (Object.keys(errors).length) return res.status(400).json({ success: false, message: Object.values(errors)[0], errors });
        const order = await ticketing.startCheckout(req.params.ref, clean, CURRENT_POLICY_VERSION, core.TICKET_TERMS.version);
        const ev = await ticketing.getEvent(order.event_id);
        const { pfData, pfHost } = payments.buildCheckout(order, { event_title: decodeStoredText(ev.event_title || '') }, req);
        console.log(`[Ticketing] Checkout started: order #${order.id}, ${order.m_payment_id}, R${core.centsToAmountString(order.total_cents)}`);
        res.json({ success: true, pfHost, pfData, reserved_until: order.reserved_until, server_now: new Date().toISOString() });
    } catch (e) { fail(res, e, 'checkout'); }
});

router.get('/api/public/ticket-orders/:ref', ticketLookupRateLimiter, async (req, res) => {
    try {
        noStore(res);
        const order = await freshOrder(req.params.ref);
        if (!order) return res.status(404).json({ success: false, message: 'We could not find that order.' });
        res.json({ success: true, order: await orderView(order) });
    } catch (e) { fail(res, e, 'order status'); }
});

// Back from PayFast: the same buyer-return check bookings have (routes/public/payfast-check.js) - a status word only, never PayFast data.
router.post('/api/public/ticket-orders/:ref/payment-check', ticketLookupRateLimiter, async (req, res) => {
    try {
        noStore(res);
        const order = await ticketing.getOrderByReference(req.params.ref);
        if (!order) return res.status(404).json({ success: false, message: 'We could not find that order.' });
        if (order.status === 'paid' || order.status === 'refunded') return res.json({ success: true, status: 'recorded' });
        const r = await reconcile.reconcileNow({ reason: 'buyer-return', ticketOrderId: order.id, minIntentAgeSeconds: reconcile.RETURN_MIN_AGE_SECONDS });
        let status = 'waiting';
        if (r.recovered && r.recovered.length) status = 'recorded';
        else if (r.skipped === 'throttled' || r.skipped === 'busy') status = 'busy';
        else if (r.skipped || r.checked === 0) status = 'nothing';
        else if (r.ok === false) status = 'unavailable';
        res.json({ success: true, status });
    } catch (e) { fail(res, e, 'payment check'); }
});

router.post('/api/public/ticket-orders/:ref/release', ticketLookupRateLimiter, async (req, res) => {
    try {
        noStore(res);
        const r = await ticketing.releaseByBuyer(req.params.ref);
        res.json({ success: true, released: r.released });
    } catch (e) { fail(res, e, 'release'); }
});

router.get('/api/public/ticket-orders/:ref/tickets.pdf', ticketLookupRateLimiter, async (req, res) => {
    try {
        const order = await ticketing.getOrderByReference(req.params.ref);
        const pdf = order && order.status === 'paid' ? await delivery.ticketsPdf(order.id) : null;
        if (!pdf) return res.status(404).json({ success: false, message: 'No tickets to download for this order.' });
        res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="tickets-order-${order.id}.pdf"`, 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' });
        res.send(pdf);
    } catch (e) { fail(res, e, 'tickets pdf'); }
});

// ---------------------------------------------------------------- the page a ticket's QR code opens

const h = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// Anyone: "Valid ticket for <show>" and nothing else (no name, no seat, no check-in state) - a stranger who finds a photo of the QR code
// learns only that it is a real ticket. Staff who are signed in to the portal get the door controls on the same page: js/checkin.js asks
// the ADMIN api (same-origin, so the session cookie goes with it) and only a POST from that page checks anyone in - opening, previewing
// or crawling this URL never consumes a ticket.
function ticketPage({ title, heading, line, state, token }) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${h(title)}</title>
<link rel="icon" href="/favicon.ico">
<link href="/css/public/redesign.css?v=33" rel="stylesheet">
<link href="/css/public/checkin.css?v=3" rel="stylesheet">
</head>
<body class="ck-body">
<main class="ck-shell" id="ckMain" data-token="${h(token)}" data-state="${h(state)}">
  <section class="ck-public" id="ckPublic">
    <p class="ck-eyebrow">Thabiso Mhlongo · Ticket</p>
    <h1 class="ck-title">${h(heading)}</h1>
    <p class="ck-line">${h(line)}</p>
  </section>
  <section class="ck-staff" id="ckStaff" hidden></section>
</main>
<script src="/js/checkin.js?v=3"></script>
</body>
</html>`;
}

// The door scanner page (checkin.html + js/checkin.js) at a short address staff can type. The page itself holds nothing - every lookup
// and check-in it makes is an admin API call that needs a signed-in session.
router.get('/checkin', (req, res) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' });
    res.sendFile(path.join(__dirname, '..', '..', 'checkin.html'));
});

router.get('/t/:token', ticketLookupRateLimiter, async (req, res) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer' });
    try {
        const token = String(req.params.token || '');
        const row = core.isTokenShape(token) ? await ticketing.ticketByToken(token) : null;
        if (!row) return res.status(404).type('html').send(ticketPage({ title: 'Ticket not found', heading: 'Ticket not found', line: 'This is not a valid ticket. Check the link or QR code and try again.', state: 'invalid', token }));
        const show = decodeStoredText(row.event_title || 'the show');
        const when = row.event_datetime ? core.formatSast(core.eventStart({ event_datetime: row.event_datetime })) : '';
        if (row.voided_at || row.order_status !== 'paid') {
            return res.type('html').send(ticketPage({ title: 'Ticket no longer valid', heading: 'This ticket is no longer valid', line: `It was issued for ${show}${when ? ' (' + when + ')' : ''}, but has since been cancelled.`, state: 'void', token }));
        }
        res.type('html').send(ticketPage({ title: `Valid ticket - ${show}`, heading: `Valid ticket for ${show}`, line: when ? when + (row.venue_name ? ' · ' + decodeStoredText(row.venue_name) : '') : '', state: 'valid', token }));
    } catch (e) {
        console.error('[Ticketing] ticket page:', e.message);
        res.status(500).type('html').send(ticketPage({ title: 'Ticket', heading: 'Something went wrong', line: 'Please try again in a moment.', state: 'error', token: '' }));
    }
});

// Door links: the scanner API for volunteers without a portal account (routes/public/ticketing-door.js).
router.use(require('./ticketing-door'));

module.exports = router;
