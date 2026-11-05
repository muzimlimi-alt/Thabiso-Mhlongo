// Event ticketing - the rules that need no database: money in integer cents, random tokens/references, what a tier or a buyer may
// look like, when a tier is on sale, and how a cell is written into a CSV. Kept free of any require() that opens the database so tests
// (and the PDF/e-mail code) can load it without side effects - the same split as lib/eft-core.js. The database side is lib/ticketing.js.
//
// Stored text: like the EFT banking details, ticketing text (tier names, buyer details) is stored as validated PLAIN text. The request
// body arrives entity-encoded (app.js deepEscapeBody), so it is decoded first and then held to a strict character set; every consumer
// that prints it as HTML escapes it itself, and PDF / e-mail / CSV / PayFast get it as it is.
const crypto = require('crypto');
const moment = require('moment-timezone');
const { decodeStoredText } = require('./html-sanitize');

const TZ = 'Africa/Johannesburg';
const HOLD_MINUTES = 10;                 // how long a reservation holds tickets before they go back on sale
const MIN_PRICE_CENTS = 500;             // PayFast does not take a payment under R5.00
const MAX_PRICE_CENTS = 10000000;        // R100 000 - a typo guard, not a business rule
const MAX_CAPACITY = 100000;
const MAX_PER_ORDER_LIMIT = 20;          // a tier's own limit can be lower, never higher
const MAX_TICKETS_PER_ORDER = 20;        // across all tiers of one order
const ORDER_STATUSES = Object.freeze(['pending', 'paid', 'failed', 'expired', 'refunded']);
// An event in one of these states sells nothing, whatever its tiers say. ('sold_out' set by hand shows as Sold Out on the card.)
const NON_SELLING_EVENT_STATUSES = Object.freeze(['cancelled', 'postponed', 'draft', 'completed', 'sold_out']);
const SALES_CONTROLS = Object.freeze(['paused', 'closed']);   // the event-level switch (ticket_event_sales.sales_control); none = open
const M_PAYMENT_PREFIX = 'TKT_';         // PayFast m_payment_id of a ticket order; booking ids are plain numbers

// ---------------------------------------------------------------- the ticket terms the buyer accepts
// Approved by the owner on 2026-11-01 - plain language for South African buyers; the owner's legal adviser should still confirm it
// against the Consumer Protection Act before the first public sale. Change the text -> change the version, so every
// order keeps the version its buyer accepted (ticket_orders.terms_version).
const TICKET_TERMS = Object.freeze({
    version: 'ticket-terms-2026-11-01',
    // shown in the drawer above the checkbox
    summary: Object.freeze([
        'Tickets are for this show, date and venue only - please check them before you pay.',
        'If the show is cancelled, you get a full refund. If it is postponed, your tickets stay valid for the new date.',
        'Otherwise tickets cannot be refunded or exchanged, except where the law says they must be.'
    ]),
    // one tap away ("Read all ticket terms")
    full: Object.freeze([
        'Tickets are sold for a specific show, date and venue, as shown when you buy. Please check these details before you pay.',
        'Prices are in South African rand and include any fees shown at checkout.',
        'If the show is cancelled, we refund the full ticket price to the payment method you used, and e-mail you when the refund has been made.',
        'If the show is postponed, your tickets stay valid for the new date. If you cannot attend the new date, contact us within 7 days of the announcement and we will refund you in full.',
        'Apart from a cancellation or postponement, tickets cannot be refunded or exchanged if you are unable to attend, except where the law requires a refund.',
        'Each ticket\'s QR code admits one person, once. Keep it private: the first person to present it is admitted, and a ticket that was already scanned will be refused.',
        'The venue\'s rules apply on the night, including any age restriction, bag checks and the right of admission.',
        'The line-up, running order and start time may change. Changes like these are not grounds for a refund unless the show is cancelled or postponed.',
        'We use your name, e-mail address and phone number only to issue and deliver your tickets, admit you at the event and contact you about it (see the Privacy Policy).'
    ])
});

// ---------------------------------------------------------------- tokens and references

// 18 random bytes = 144 bits, written base64url (24 characters). Never derived from an id or anything guessable.
const randomToken = () => crypto.randomBytes(18).toString('base64url');
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{24}$/;
const isTokenShape = (s) => typeof s === 'string' && TOKEN_SHAPE.test(s);

// What an admin / the door typed into a ticket search, read every way it can mean something:
//   order number "1042" / "#1042"; ticket number "1042-2" (as printed on the ticket: order - n); the ticket CODE (24 characters, also
//   typed in the PDF's groups of four); a phone number in any SA form ("082 123 4567", "+27 82 123 4567") -> national digits "0821234567".
// like = the lower-case text for name / e-mail matching (LIKE-escaped). Fields that do not apply are -1 / null.
function parseSearch(q) {
    const raw = oneLine(q == null ? '' : q);
    const compact = raw.replace(/\s+/g, '');
    const out = { text: raw.toLowerCase(), like: '%' + raw.toLowerCase().replace(/[%_\\]/g, (c) => '\\' + c) + '%', orderNo: -1, ticketIndex: null, token: null, phone: null };
    let m;
    if ((m = /^#?(\d{1,10})$/.exec(compact))) out.orderNo = parseInt(m[1], 10);
    else if ((m = /^#?(\d{1,10})-(\d{1,3})$/.exec(compact))) { out.orderNo = parseInt(m[1], 10); out.ticketIndex = parseInt(m[2], 10); }
    if (TOKEN_SHAPE.test(compact)) out.token = compact;
    const digits = raw.replace(/\D/g, '');
    if (/^[+\d\s()-]+$/.test(raw) && digits.length >= 6) out.phone = digits.startsWith('27') && digits.length >= 11 ? '0' + digits.slice(2) : digits;
    return out;
}
// SQL for a stored buyer_phone in the same national form as parseSearch's phone ("+27821234567" / "27821234567" -> "0821234567").
const NATIONAL_PHONE_SQL = (col) => `(CASE WHEN REPLACE(COALESCE(${col}, ''), '+', '') LIKE '27%' THEN '0' || SUBSTR(REPLACE(${col}, '+', ''), 3) ELSE REPLACE(COALESCE(${col}, ''), '+', '') END)`;

// The drawer's per-browser hold key (random, made in the browser, kept in localStorage): not personal data, just "the same browser".
const isHoldKey = (s) => typeof s === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(s);

const mPaymentIdFor = (orderId) => M_PAYMENT_PREFIX + orderId;
const isTicketPaymentId = (m) => typeof m === 'string' && m.startsWith(M_PAYMENT_PREFIX);
function orderIdFromPaymentId(m) {
    if (!isTicketPaymentId(m)) return null;
    const rest = m.slice(M_PAYMENT_PREFIX.length);
    return /^[1-9]\d{0,9}$/.test(rest) ? parseInt(rest, 10) : null;
}

// The request logger (app.js) prints every URL. A ticket token or an order reference in a URL is a key, so it is replaced before logging:
// /t/<token>, /api/public/ticket-orders/<ref>..., /api/admin/ticketing/tickets/<token>..., and ?tickets=<ref>. The ticketing admin search
// (?q= on /api/admin/ticketing/...) is a buyer's name or e-mail - personal information - so it is hidden too.
function maskSecretsInUrl(url) {
    let s = String(url == null ? '' : url)
        .replace(/(\/t\/|\/api\/public\/ticket-orders\/|\/api\/admin\/ticketing\/tickets\/|\/api\/door\/tickets\/)[A-Za-z0-9_-]{8,}/g, '$1[hidden]')
        .replace(/([?&](?:tickets|pass)=)[^&#]+/g, '$1[hidden]');
    // searches (admin and door links) hold names, e-mails, phone numbers
    if (s.startsWith('/api/admin/ticketing/') || s.startsWith('/api/door/')) s = s.replace(/([?&]q=)[^&#]*/g, '$1[hidden]');
    return s;
}

// ---------------------------------------------------------------- money (integer cents, ZAR)

// '150', '150.5', 'R 1 500,00', 1500 -> cents. null when it is not a clean amount. A number is taken as RANDS.
function parseRandsToCents(input) {
    if (input === null || input === undefined || input === '') return null;
    if (typeof input === 'number') return Number.isFinite(input) ? Math.round(input * 100) : null;
    let s = String(input).trim().replace(/^R\s*/i, '').replace(/[\s ]/g, '');
    if (/^\d+,\d{1,2}$/.test(s)) s = s.replace(',', '.');      // 150,50 (South African decimal comma)
    s = s.replace(/,/g, '');                                   // 1,500.00 thousands separators
    if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
    const [r, c = ''] = s.split('.');
    return parseInt(r, 10) * 100 + parseInt((c + '00').slice(0, 2), 10);
}

// PayFast's amount field: rands with exactly two decimals, from integer cents - no floating point involved.
const centsToAmountString = (cents) => `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;

// What PayFast posted back ('1500.00') -> cents, or null when it is not a clean two-decimal amount.
function amountStringToCents(s) {
    const t = String(s == null ? '' : s).trim();
    if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
    return parseRandsToCents(t);
}

// 150000 -> 'R 1 500.00' (the public-site money style, with a thin grouping space).
function formatZar(cents) {
    const n = Number.isFinite(cents) ? cents : 0;
    const rands = String(Math.floor(Math.abs(n) / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    return `${n < 0 ? '-' : ''}R ${rands}.${String(Math.abs(n) % 100).padStart(2, '0')}`;
}

// ---------------------------------------------------------------- dates (events are stored as SAST wall time, no zone)

// events.event_datetime 'YYYY-MM-DDTHH:MM' (Johannesburg wall time) -> Date, or null.
function eventStart(event) {
    const raw = event && event.event_datetime;
    if (!raw) return null;
    const m = moment.tz(String(raw).replace(' ', 'T'), ['YYYY-MM-DDTHH:mm', 'YYYY-MM-DDTHH:mm:ss', 'YYYY-MM-DD'], true, TZ);
    return m.isValid() ? m.toDate() : null;
}

// An admin's 'YYYY-MM-DDTHH:MM' (datetime-local, Johannesburg time) -> ISO UTC string; '' / null -> null; anything else -> undefined.
function localInputToIso(v) {
    if (v === null || v === undefined || String(v).trim() === '') return null;
    const m = moment.tz(String(v).trim(), ['YYYY-MM-DDTHH:mm', 'YYYY-MM-DDTHH:mm:ss'], true, TZ);
    return m.isValid() ? m.toDate().toISOString() : undefined;
}

// ISO UTC -> 'YYYY-MM-DDTHH:MM' Johannesburg time (to fill a datetime-local input), or ''.
const isoToLocalInput = (iso) => (iso ? moment(iso).tz(TZ).format('YYYY-MM-DDTHH:mm') : '');
const formatSast = (dateLike, fmt = 'ddd D MMM YYYY, HH:mm') => (dateLike ? moment(dateLike).tz(TZ).format(fmt) : '');

// ---------------------------------------------------------------- text

const tidy = (v) => decodeStoredText(v == null ? '' : String(v)).replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
const oneLine = (v) => tidy(v).replace(/\n/g, ' ');
const NAME_CHARS = /^[\p{L}\p{M}\p{N} &.,'’()\/+@#!-]+$/u;
const FREE_TEXT_CHARS = /^[^<>`\u0000-\u0008\u000B-\u001F\u007F]*$/;
const EMAIL = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[A-Za-z]{2,}$/;

// ---------------------------------------------------------------- tiers

// input: the admin form. Returns { clean, errors }. `clean` is only meaningful when `errors` is empty.
function validateTier(input) {
    const src = input || {};
    const errors = {};
    const clean = {};

    clean.name = oneLine(src.name);
    if (clean.name.length < 2 || clean.name.length > 60) errors.name = 'Give the ticket type a name of 2 to 60 characters (e.g. General, VIP).';
    else if (!NAME_CHARS.test(clean.name)) errors.name = 'The name may only contain letters, numbers, spaces and & . , \' ( ) / + @ # ! -';

    clean.description = tidy(src.description) || null;
    if (clean.description && (clean.description.length > 300 || !FREE_TEXT_CHARS.test(clean.description))) errors.description = 'The description must be under 300 characters and cannot contain < > or backticks.';

    clean.price_cents = Number.isInteger(src.price_cents) ? src.price_cents : parseRandsToCents(src.price);
    if (clean.price_cents === null || clean.price_cents < MIN_PRICE_CENTS || clean.price_cents > MAX_PRICE_CENTS) errors.price = `The price must be at least ${formatZar(MIN_PRICE_CENTS)} (PayFast's minimum).`;

    clean.capacity = Number(src.capacity);
    if (!Number.isInteger(clean.capacity) || clean.capacity < 1 || clean.capacity > MAX_CAPACITY) errors.capacity = `Capacity must be a whole number from 1 to ${MAX_CAPACITY}.`;

    clean.max_per_order = src.max_per_order === undefined || src.max_per_order === '' ? 10 : Number(src.max_per_order);
    if (!Number.isInteger(clean.max_per_order) || clean.max_per_order < 1 || clean.max_per_order > MAX_PER_ORDER_LIMIT) errors.max_per_order = `The per-order limit must be from 1 to ${MAX_PER_ORDER_LIMIT}.`;

    clean.sales_start = localInputToIso(src.sales_start);
    if (clean.sales_start === undefined) errors.sales_start = 'Sales start must be a date and time, or left blank (on sale straight away).';
    clean.sales_end = localInputToIso(src.sales_end);
    if (clean.sales_end === undefined) errors.sales_end = 'Sales end must be a date and time, or left blank (until the show starts).';
    if (clean.sales_start && clean.sales_end && clean.sales_end <= clean.sales_start) errors.sales_end = 'Sales must end after they start.';

    clean.is_active = src.is_active === true || src.is_active === 1 || src.is_active === '1' || src.is_active === 'true' ? 1 : 0;
    // null = not sent: a new category goes to the end of the list and an edit keeps the position the organiser gave it (Manage Tickets)
    clean.sort_order = src.sort_order === undefined || src.sort_order === null || src.sort_order === '' || !Number.isInteger(Number(src.sort_order)) ? null : Number(src.sort_order);
    return { clean, errors };
}

const remainingOf = (tier) => Math.max(0, (tier.capacity || 0) - (tier.sold || 0) - (tier.reserved || 0));

// Why an event sells nothing right now, or null when it may sell.
function eventBlockReason(event, now = new Date()) {
    if (!event) return 'not_found';
    if (event.booking_id) return 'not_standalone';           // tickets are sold for Thabiso's own (standalone) shows only
    if (NON_SELLING_EVENT_STATUSES.includes(String(event.event_status || '').toLowerCase())) return 'event_' + String(event.event_status).toLowerCase();
    const start = eventStart(event);
    if (!start) return 'no_date';
    if (start <= now) return 'started';
    return null;
}

// The event-level sales switch and window (ticket_event_sales, merged into the event by lib/ticketing.js getEvent): why the whole show is
// not selling although it could, or null. Separate from eventBlockReason (cancelled / postponed / draft / past) and from each
// category's own on/off switch.
function salesGate(event, now = new Date()) {
    if (!event) return null;
    if (event.sales_control === 'paused') return 'sales_paused';
    if (event.sales_control === 'closed') return 'sales_closed';
    const iso = now.toISOString();
    if (event.sales_opens_at && iso < event.sales_opens_at) return 'sales_not_open';
    if (event.sales_closes_at && iso >= event.sales_closes_at) return 'sales_ended';
    return null;
}
const GATE_TEXT = Object.freeze({
    sales_paused: 'Ticket sales for this show are paused right now - please check back soon.',
    sales_closed: 'Ticket sales for this show are closed.',
    sales_not_open: 'Ticket sales for this show have not opened yet.',
    sales_ended: 'Ticket sales for this show have ended.'
});

// One tier's state for buyers: on_sale | sold_out | not_started | ended | closed | paused.
function tierState(tier, event, now = new Date()) {
    if (!tier.is_active || eventBlockReason(event, now)) return 'closed';
    const gate = salesGate(event, now);
    if (gate === 'sales_paused') return 'paused';
    if (gate === 'sales_closed') return 'closed';
    if (gate === 'sales_ended') return 'ended';
    if (gate === 'sales_not_open') return 'not_started';
    const iso = now.toISOString();
    if (tier.sales_start && iso < tier.sales_start) return 'not_started';
    if (tier.sales_end && iso >= tier.sales_end) return 'ended';
    return remainingOf(tier) > 0 ? 'on_sale' : 'sold_out';
}

// The card on the public Events section: null when the event has no tiers (it then keeps its external ticket_sales_link, if any),
// else { state: on_sale | sold_out | not_started | closed, from_cents, opens_at }.
function eventSummary(tiers, event, now = new Date()) {
    if (!tiers || !tiers.length) return null;
    if (eventBlockReason(event, now) === 'event_sold_out') return { state: 'sold_out', from_cents: null, opens_at: null };
    if (!eventBlockReason(event, now)) {
        const gate = salesGate(event, now);
        if (gate === 'sales_paused') return { state: 'paused', from_cents: null, opens_at: null };
        if (gate === 'sales_not_open') return { state: 'not_started', from_cents: null, opens_at: event.sales_opens_at };
        if (gate === 'sales_closed' || gate === 'sales_ended') return { state: 'closed', from_cents: null, opens_at: null };
    }
    const states = tiers.map(t => ({ t, s: tierState(t, event, now) }));
    const onSale = states.filter(x => x.s === 'on_sale');
    if (onSale.length) return { state: 'on_sale', from_cents: Math.min(...onSale.map(x => x.t.price_cents)), opens_at: null };
    if (states.some(x => x.s === 'sold_out')) return { state: 'sold_out', from_cents: null, opens_at: null };
    const upcoming = states.filter(x => x.s === 'not_started').map(x => x.t.sales_start).sort();
    if (upcoming.length) return { state: 'not_started', from_cents: null, opens_at: upcoming[0] };
    return { state: 'closed', from_cents: null, opens_at: null };
}

// What the buyer may see of a tier (no sold/reserved internals).
function publicTier(tier, event, now = new Date()) {
    const state = tierState(tier, event, now);
    return {
        id: tier.id, name: tier.name, description: tier.description || '', price_cents: tier.price_cents,
        remaining: state === 'on_sale' ? remainingOf(tier) : 0, max_per_order: tier.max_per_order, state,
        sales_start: tier.sales_start || null, sales_end: tier.sales_end || null
    };
}

// The organiser's one-line answer to "is this show selling?": { state, reason? }. The first thing that stops sales wins.
//   no_categories | blocked (reason) | marked_sold_out | paused | closed | not_open | ended | sold_out (every enabled category is
//   full - automatic, nothing was switched) | open.   closed carries reason 'organiser' or 'no_enabled'.
function salesOverview(tiers, event, now = new Date()) {
    if (!tiers || !tiers.length) return { state: 'no_categories' };
    const block = eventBlockReason(event, now);
    if (block === 'event_sold_out') return { state: 'marked_sold_out', reason: block };
    if (block) return { state: 'blocked', reason: block };
    const gate = salesGate(event, now);
    if (gate === 'sales_paused') return { state: 'paused' };
    if (gate === 'sales_closed') return { state: 'closed', reason: 'organiser' };
    if (gate === 'sales_not_open') return { state: 'not_open' };
    if (gate === 'sales_ended') return { state: 'ended' };
    const enabled = tiers.filter(t => t.is_active);
    if (!enabled.length) return { state: 'closed', reason: 'no_enabled' };
    if (enabled.every(t => remainingOf(t) === 0)) return { state: 'sold_out' };
    return { state: 'open' };
}

// The event-wide sales window from the Manage Tickets screen: datetime-local values (Johannesburg) or blank. Returns { clean, errors }.
function validateSalesWindow(input) {
    const src = input || {};
    const errors = {};
    const clean = { opens_at: localInputToIso(src.opens_at), closes_at: localInputToIso(src.closes_at) };
    if (clean.opens_at === undefined) errors.opens_at = 'Sales open must be a date and time, or left blank.';
    if (clean.closes_at === undefined) errors.closes_at = 'Sales close must be a date and time, or left blank.';
    if (!errors.opens_at && !errors.closes_at && clean.opens_at && clean.closes_at && clean.closes_at <= clean.opens_at) errors.closes_at = 'Sales must close after they open.';
    return { clean, errors };
}

// A new total capacity for one category: "set to N" ({ capacity }) or "add / remove N" ({ add }). Returns { capacity } or { error }.
function resolveCapacityChange(current, input) {
    const src = input || {};
    let target;
    if (src.add !== undefined && src.add !== null && src.add !== '') {
        const n = Number(src.add);
        if (!Number.isInteger(n) || n === 0) return { error: 'Enter a whole number of tickets to add or remove.' };
        target = current + n;
    } else {
        target = Number(src.capacity);
    }
    if (!Number.isInteger(target) || target < 1 || target > MAX_CAPACITY) return { error: `Capacity must be a whole number from 1 to ${MAX_CAPACITY}.` };
    return { capacity: target };
}

// ---------------------------------------------------------------- an order

// items: [{ ticket_type_id, quantity }] from the drawer. tiersById: the event's tiers. Returns { lines, errors }.
// Prices are never read from the request - they come from the tier rows.
function validateReservation(items, tiersById, event, now = new Date()) {
    const errors = [];
    const blocked = eventBlockReason(event, now);
    if (blocked) return { lines: [], errors: [{ code: blocked, message: 'Tickets for this show are not on sale.' }] };
    const gate = salesGate(event, now);
    if (gate) return { lines: [], errors: [{ code: gate, message: GATE_TEXT[gate] }] };
    if (!Array.isArray(items) || !items.length) return { lines: [], errors: [{ code: 'empty', message: 'Choose at least one ticket.' }] };
    const qty = new Map();
    for (const it of items) {
        const id = Number(it && it.ticket_type_id);
        const q = Number(it && it.quantity);
        if (!Number.isInteger(id) || !Number.isInteger(q) || q < 0) { errors.push({ code: 'bad_item', message: 'That ticket selection is not valid.' }); continue; }
        if (q === 0) continue;
        qty.set(id, (qty.get(id) || 0) + q);
    }
    const lines = [];
    let total = 0;
    for (const [id, q] of qty) {
        const tier = tiersById.get(id);
        if (!tier || tier.event_id !== event.event_id) { errors.push({ code: 'unknown_tier', ticket_type_id: id, message: 'That ticket type is not available.' }); continue; }
        const state = tierState(tier, event, now);
        if (state !== 'on_sale' && state !== 'sold_out') { errors.push({ code: 'tier_' + state, ticket_type_id: id, message: `${tier.name} tickets are not on sale.` }); continue; }
        if (q > tier.max_per_order) { errors.push({ code: 'over_limit', ticket_type_id: id, message: `You can buy up to ${tier.max_per_order} ${tier.name} tickets per order.` }); continue; }
        lines.push({ ticket_type_id: id, quantity: q, unit_price_cents: tier.price_cents });
        total += q;
    }
    if (!errors.length && !lines.length) errors.push({ code: 'empty', message: 'Choose at least one ticket.' });
    if (total > MAX_TICKETS_PER_ORDER) errors.push({ code: 'order_limit', message: `One order can hold up to ${MAX_TICKETS_PER_ORDER} tickets.` });
    return { lines, errors };
}

const orderTotalCents = (lines) => lines.reduce((sum, l) => sum + l.quantity * l.unit_price_cents, 0);

// The checkout form. ticketCount = how many tickets the order holds (for the optional per-ticket names).
function validateBuyer(input, ticketCount) {
    const src = input || {};
    const errors = {};
    const clean = {};
    clean.buyer_name = oneLine(src.buyer_name);
    if (clean.buyer_name.length < 2 || clean.buyer_name.length > 100) errors.buyer_name = 'Please enter your full name.';
    else if (!NAME_CHARS.test(clean.buyer_name)) errors.buyer_name = 'Your name may only contain letters, spaces and . , \' ( ) -';

    clean.buyer_email = oneLine(src.buyer_email).toLowerCase();
    if (!EMAIL.test(clean.buyer_email) || clean.buyer_email.length > 254) errors.buyer_email = 'Please enter a valid email address - your tickets are sent there.';

    const phone = oneLine(src.buyer_phone).replace(/[\s()-]/g, '');
    clean.buyer_phone = phone;
    if (!/^\+?\d{9,15}$/.test(phone)) errors.buyer_phone = 'Please enter a valid phone number.';

    const names = Array.isArray(src.holder_names) ? src.holder_names : [];
    clean.holder_names = [];
    for (let i = 0; i < ticketCount; i++) {
        const n = oneLine(names[i]);
        if (n && (n.length > 100 || !NAME_CHARS.test(n))) { errors.holder_names = `Ticket ${i + 1}: that name has characters we can't print.`; break; }
        clean.holder_names.push(n || null);
    }
    const yes = (v) => v === true || v === 'true' || v === 1;
    // one checkbox in the drawer covers both: the ticket terms AND consent to use the details (POPIA); both must be true
    if (!yes(src.popia_consent) || !yes(src.terms_accepted)) errors.popia_consent = 'Please accept the ticket terms and the Privacy Policy to continue.';
    return { clean, errors };
}

// PayFast wants first and last name separately.
function splitName(full) {
    const parts = oneLine(full).split(' ').filter(Boolean);
    if (!parts.length) return { first: '', last: '' };
    if (parts.length === 1) return { first: parts[0], last: '' };
    return { first: parts.slice(0, -1).join(' '), last: parts[parts.length - 1] };
}

// ---------------------------------------------------------------- CSV

// One CSV cell: decoded text, quoted when needed, and a leading = + - @ (or tab / CR) neutralised so a spreadsheet never runs it as a formula.
function csvCell(v) {
    if (v === null || v === undefined) return '';
    let s = decodeStoredText(String(v));
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
const csvRow = (cells) => cells.map(csvCell).join(',');

module.exports = {
    TICKET_TERMS, TZ, HOLD_MINUTES, MIN_PRICE_CENTS, MAX_PRICE_CENTS, MAX_CAPACITY, MAX_PER_ORDER_LIMIT, MAX_TICKETS_PER_ORDER,
    ORDER_STATUSES, NON_SELLING_EVENT_STATUSES, SALES_CONTROLS, GATE_TEXT, M_PAYMENT_PREFIX,
    randomToken, isTokenShape, isHoldKey, parseSearch, NATIONAL_PHONE_SQL, mPaymentIdFor, isTicketPaymentId, orderIdFromPaymentId, maskSecretsInUrl,
    parseRandsToCents, centsToAmountString, amountStringToCents, formatZar,
    eventStart, localInputToIso, isoToLocalInput, formatSast,
    tidy, oneLine,
    validateTier, remainingOf, eventBlockReason, salesGate, salesOverview, validateSalesWindow, resolveCapacityChange, tierState, eventSummary, publicTier,
    validateReservation, orderTotalCents, validateBuyer, splitName,
    csvCell, csvRow
};
