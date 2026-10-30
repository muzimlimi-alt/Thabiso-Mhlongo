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
const M_PAYMENT_PREFIX = 'TKT_';         // PayFast m_payment_id of a ticket order; booking ids are plain numbers

// ---------------------------------------------------------------- tokens and references

// 18 random bytes = 144 bits, written base64url (24 characters). Never derived from an id or anything guessable.
const randomToken = () => crypto.randomBytes(18).toString('base64url');
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{24}$/;
const isTokenShape = (s) => typeof s === 'string' && TOKEN_SHAPE.test(s);

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
        .replace(/(\/t\/|\/api\/public\/ticket-orders\/|\/api\/admin\/ticketing\/tickets\/)[A-Za-z0-9_-]{8,}/g, '$1[hidden]')
        .replace(/([?&]tickets=)[^&#]+/g, '$1[hidden]');
    if (s.startsWith('/api/admin/ticketing/')) s = s.replace(/([?&]q=)[^&#]*/g, '$1[hidden]');
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
    clean.sort_order = Number.isInteger(Number(src.sort_order)) ? Number(src.sort_order) : 0;
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

// One tier's state for buyers: on_sale | sold_out | not_started | ended | closed.
function tierState(tier, event, now = new Date()) {
    if (!tier.is_active || eventBlockReason(event, now)) return 'closed';
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

// ---------------------------------------------------------------- an order

// items: [{ ticket_type_id, quantity }] from the drawer. tiersById: the event's tiers. Returns { lines, errors }.
// Prices are never read from the request - they come from the tier rows.
function validateReservation(items, tiersById, event, now = new Date()) {
    const errors = [];
    const blocked = eventBlockReason(event, now);
    if (blocked) return { lines: [], errors: [{ code: blocked, message: 'Tickets for this show are not on sale.' }] };
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
    if (!(src.popia_consent === true || src.popia_consent === 'true' || src.popia_consent === 1)) errors.popia_consent = 'Please agree to the Privacy Policy so we can send your tickets.';
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
    TZ, HOLD_MINUTES, MIN_PRICE_CENTS, MAX_PRICE_CENTS, MAX_CAPACITY, MAX_PER_ORDER_LIMIT, MAX_TICKETS_PER_ORDER,
    ORDER_STATUSES, NON_SELLING_EVENT_STATUSES, M_PAYMENT_PREFIX,
    randomToken, isTokenShape, mPaymentIdFor, isTicketPaymentId, orderIdFromPaymentId, maskSecretsInUrl,
    parseRandsToCents, centsToAmountString, amountStringToCents, formatZar,
    eventStart, localInputToIso, isoToLocalInput, formatSast,
    tidy, oneLine,
    validateTier, remainingOf, eventBlockReason, tierState, eventSummary, publicTier,
    validateReservation, orderTotalCents, validateBuyer, splitName,
    csvCell, csvRow
};
