// Service pricing model — the single source of truth for HOW a catalogue service is priced.
//
// A service is priced in one of five ways (services.price_type):
//   fixed        one agreed catalogue fee (default_price, or base_price when set)        "R28,000"
//   range        a published band; the amount is agreed per engagement                    "R12,000 – R25,000"
//   from         a starting price; the amount is agreed per engagement                    "From R50,000"
//   enquire      no published amount at all                                               "Enquire"
//   enquire_min  enquire, with a published minimum                                        "Enquire – minimum R15,000 per session"
// plus an optional billing unit (services.price_unit: minute | hour | month | session | draft).
//
// The rule everything else leans on: ONLY a fixed price is an amount the system may put on a booking or
// quote line by itself. A range's minimum / maximum / midpoint, a "from" price and a minimum fee are
// published figures, never an agreed price — so for those types default_price stays 0 and the quote must
// be given an explicit amount by an administrator. Nothing here invents one.
//
// Used by: routes/admin/services.js (validation + display labels), routes/admin/bookings.js (quote line
// checks), routes/public/bookings.js and the manual-booking route (catalogue snapshot), lib/rate-card-2026.js.

const PRICE_TYPES = Object.freeze(['fixed', 'range', 'from', 'enquire', 'enquire_min']);
const PRICE_UNITS = Object.freeze(['minute', 'hour', 'month', 'session', 'draft']);
const PRICING_MODELS = Object.freeze(['flat_fee', 'per_minute', 'per_hour']);

// What each type means, in the words the admin screens use (served by GET /api/admin/services/meta so the browser
// never keeps its own copy of the vocabulary).
const PRICE_TYPE_INFO = Object.freeze({
    fixed:       { label: 'Fixed price',                hint: 'One catalogue fee. New bookings and quotes are pre-filled with it.' },
    range:       { label: 'Price range',                hint: 'A published band. The agreed amount is entered on each quote.' },
    from:        { label: 'Starting price (From)',      hint: 'A starting price. The agreed amount is entered on each quote.' },
    enquire:     { label: 'Enquire only',               hint: 'No published amount. The agreed amount is entered on each quote.' },
    enquire_min: { label: 'Enquire, with minimum fee',  hint: 'No fixed amount, but a published minimum. The agreed amount is entered on each quote.' }
});
const PRICE_UNIT_LABELS = Object.freeze({ minute: 'per minute', hour: 'per hour', month: 'per month', session: 'per session', draft: 'per draft' });

// Rate-card display groups (services.service_group holds the slug, so no entity-encoded text lives in the column).
const GROUPS = Object.freeze({
    club_theatre:       'Club & Theatre',
    corporate_events:   'Corporate & Events',
    private_functions:  'Private Functions, Weddings & Year-End Events',
    writing_creative:   'Writing & Creative Services',
    acting_voice_brand: 'Acting, Voice-Over & Brand Campaigns'
});
const FEATURED_GROUP = 'corporate_events'; // carries the "Most Booked" designation

// '' / null / undefined -> null; anything else -> Number (NaN is possible and is checked by callers).
const toNum = (v) => (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) ? null : Number(v);
const isPositive = (n) => Number.isFinite(n) && n > 0;

// Legacy rows (created before price_type existed) carry NULL — those are ordinary fixed-price services.
function priceTypeOf(svc) {
    const t = svc && svc.price_type;
    return PRICE_TYPES.includes(t) ? t : 'fixed';
}
const isFixedPrice = (svc) => priceTypeOf(svc) === 'fixed';
// True for every type that cannot be priced without an administrator choosing an amount.
const needsIndividualQuote = (svc) => !isFixedPrice(svc);

// The billing unit: an explicit price_unit wins; otherwise implied by a time-based pricing model.
function effectiveUnit(svc) {
    if (svc && PRICE_UNITS.includes(svc.price_unit)) return svc.price_unit;
    if (svc && svc.pricing_model === 'per_hour') return 'hour';
    if (svc && svc.pricing_model === 'per_minute') return 'minute';
    return null;
}

// "R5,000" / "R333.33" — the rate card's own formatting (comma thousands, no space).
function formatRand(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return '';
    const s = Number.isInteger(v) ? String(v) : v.toFixed(2);
    const [int, dec] = s.split('.');
    return 'R' + int.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (dec ? '.' + dec : '');
}

// What the amount a catalogue row may pre-fill into a booking snapshot / quote line is.
// Fixed -> the catalogue fee (base_price wins over default_price, as the booking path always did).
// Anything else -> 0: there is no agreed amount to pre-fill.
function catalogueUnitPrice(svc) {
    if (!isFixedPrice(svc)) return 0;
    const p = parseFloat(svc.base_price != null ? svc.base_price : svc.default_price);
    return Number.isFinite(p) ? p : 0;
}

// Display description for administrators (the public site never shows prices). Never invents a figure:
// a range/from/minimum row with unusable bounds degrades to "Enquire".
function describePrice(svc) {
    const type = priceTypeOf(svc);
    const unit = effectiveUnit(svc);
    const per = unit ? ` per ${unit}` : '';
    const min = toNum(svc && svc.price_min);
    const max = toNum(svc && svc.price_max);
    let label;
    if (type === 'fixed') {
        label = formatRand(catalogueUnitPrice(svc)) + per;
    } else if (type === 'range' && isPositive(min) && isPositive(max)) {
        label = `${formatRand(min)} – ${formatRand(max)}${per}`;
    } else if (type === 'from' && isPositive(min)) {
        label = `From ${formatRand(min)}${per}`;
    } else if (type === 'enquire_min' && isPositive(min)) {
        label = `Enquire – minimum ${formatRand(min)}${per}`;
    } else {
        label = 'Enquire';
    }
    return { price_type: type, price_label: label, price_unit_effective: unit, quote_required: type !== 'fixed' };
}

// Validates + normalises the pricing fields of a services write (POST: existing = null; PUT: the stored row).
// A field the request does not mention keeps its stored value, so an older admin tab that knows nothing
// about price_type cannot silently turn a range into a free fixed fee. Returns { ok, fields } or { ok:false, error }.
function normalizeServicePricing(input, existing) {
    input = input || {};
    const has = (k) => input[k] !== undefined;
    const stored = (k) => (existing && existing[k] !== undefined) ? existing[k] : null;
    const pick = (k) => has(k) ? input[k] : stored(k);
    const fail = (error) => ({ ok: false, error });

    // pricing_model — 'flat' is the legacy spelling of 'flat_fee'.
    let model = pick('pricing_model');
    if (model === undefined || model === null || model === '') model = 'flat_fee';
    if (model === 'flat') model = 'flat_fee';
    if (!PRICING_MODELS.includes(model)) return fail(`pricing_model must be one of: ${PRICING_MODELS.join(', ')}.`);

    // price_type — absent on a create means the long-standing behaviour: a fixed price.
    let type = has('price_type') ? input.price_type : (existing ? priceTypeOf(existing) : 'fixed');
    if (type === null || type === '') type = 'fixed';
    if (!PRICE_TYPES.includes(type)) return fail(`price_type must be one of: ${PRICE_TYPES.join(', ')}.`);

    // price_unit
    let unit = pick('price_unit');
    if (unit === '' || unit === undefined) unit = null;
    if (unit !== null && !PRICE_UNITS.includes(unit)) return fail(`price_unit must be one of: ${PRICE_UNITS.join(', ')}.`);
    const timeUnit = model === 'per_hour' ? 'hour' : model === 'per_minute' ? 'minute' : null;
    if (timeUnit) {
        if (type !== 'fixed') return fail('Only fixed-price services can be billed per hour or per minute; use a flat-fee model for ranges, starting prices and enquiries.');
        if (has('price_unit') && unit !== null && unit !== timeUnit) return fail(`price_unit "${unit}" conflicts with the ${model} pricing model.`);
        unit = timeUnit;
    }

    let price = 0, basePrice = null, min = null, max = null;
    if (type === 'fixed') {
        // Converting a range / "from" / enquiry into a fixed price must NAME the price: silently keeping the
        // stored 0 would turn a published band into a free service.
        if (existing && priceTypeOf(existing) !== 'fixed' && !isPositive(toNum(input.default_price))) {
            return fail('Enter the fixed price (above zero) when changing this service to a fixed price.');
        }
        const p = toNum(pick('default_price'));
        if (p === null || !Number.isFinite(p)) return fail('default_price is required for a fixed price.');
        if (p < 0) return fail('default_price cannot be negative.');
        price = p;
        const b = toNum(pick('base_price'));
        if (b !== null) {
            if (!Number.isFinite(b) || b < 0) return fail('base_price must be a non-negative number.');
            basePrice = b > 0 ? b : null; // 0 / blank means "no separate booking rate" (as the form always sent)
        }
    } else {
        // default_price stays 0 and base_price empty: no amount may be pre-filled for these types.
        const lo = toNum(pick('price_min'));
        const hi = toNum(pick('price_max'));
        if (type === 'range') {
            if (!isPositive(lo) || !isPositive(hi)) return fail('A price range needs both price_min and price_max, each above zero.');
            if (lo >= hi) return fail('price_min must be less than price_max; use a fixed price for a single amount.');
            min = lo; max = hi;
        } else if (type === 'from' || type === 'enquire_min') {
            if (!isPositive(lo)) return fail(`price_min (the ${type === 'from' ? 'starting price' : 'minimum fee'}) is required and must be above zero.`);
            min = lo; // any price_max is meaningless for this type and is dropped
        } // enquire: no published amount at all
    }

    // Featured ("Most Booked") flag and display group.
    const rawFeat = pick('is_featured');
    const featured = (rawFeat === true || rawFeat === 1 || rawFeat === '1' || rawFeat === 'true') ? 1 : 0;
    let group = pick('service_group');
    if (group === '' || group === undefined) group = null;
    if (group !== null && !Object.prototype.hasOwnProperty.call(GROUPS, group)) {
        return fail(`service_group must be one of: ${Object.keys(GROUPS).join(', ')}.`);
    }

    return {
        ok: true,
        fields: {
            pricing_model: model, price_type: type, default_price: price, base_price: basePrice,
            price_min: min, price_max: max, price_unit: unit, is_featured: featured, service_group: group
        }
    };
}

// Quantity limits per pricing model. flat_fee is always exactly 1 unit; per_minute is bounded in
// minutes (>= 15, the booking engine's slot size); per_hour is bounded in whole hours (>= 1).
function normalizeQuantityLimits(model, minQuantity, maxQuantity) {
    if (model === 'flat_fee') return { ok: true, min: 1, max: null };
    const min = parseInt(minQuantity) || 1;
    const max = parseInt(maxQuantity) || null;
    if (model === 'per_minute' && min < 15) return { ok: false, error: 'Minimum quantity for time-based services must be at least 15 minutes.' };
    if (model === 'per_hour' && min < 1) return { ok: false, error: 'Minimum quantity for hourly services must be at least 1 hour.' };
    if (min > (max || Infinity)) return { ok: false, error: 'Minimum quantity cannot exceed maximum quantity.' };
    return { ok: true, min, max };
}

// Compares an AGREED unit price with the service's published rate card. Returns a warning string or null.
// Only a warning — an individual quotation may legitimately sit outside the card, so this never blocks.
function priceBandWarning(svc, unitPrice) {
    const p = Number(unitPrice);
    if (!isPositive(p) || !svc) return null;
    const type = priceTypeOf(svc);
    const min = toNum(svc.price_min), max = toNum(svc.price_max);
    const per = effectiveUnit(svc) ? ` per ${effectiveUnit(svc)}` : '';
    const name = svc.name || 'This service';
    if ((type === 'from' || type === 'enquire_min') && isPositive(min) && p < min) {
        return `"${name}" is quoted at ${formatRand(p)}, below its published ${type === 'from' ? 'starting price' : 'minimum'} of ${formatRand(min)}${per}.`;
    }
    if (type === 'range' && isPositive(min) && isPositive(max) && (p < min || p > max)) {
        return `"${name}" is quoted at ${formatRand(p)}, outside its published range of ${formatRand(min)} – ${formatRand(max)}${per}.`;
    }
    return null;
}

// Server-side check of a structured quote's lines against the catalogue.
//  - error:    a service-linked line for a non-fixed service must carry an explicit amount above zero
//              (the explicit, authorised selection the rate card requires) — otherwise the quote would go
//              out with a R0 line, or worse, a guessed one.
//  - warnings: lines priced outside the published band (informational).
// `services` is the array of catalogue rows for the lines' service_ids; unknown ids are left to the FK check.
function checkQuoteLinePricing(items, services) {
    const byId = new Map((services || []).map(s => [s.id, s]));
    const warnings = [];
    for (const it of (items || [])) {
        const svc = byId.get(parseInt(it && it.service_id));
        if (!svc) continue;
        const price = parseFloat(it.unit_price);
        if (needsIndividualQuote(svc)) {
            if (!isPositive(price)) {
                const d = describePrice(svc);
                return { error: `"${svc.name}" is priced individually (${d.price_label}). Enter the agreed amount for this line before sending the quote.`, warnings };
            }
            const w = priceBandWarning(svc, price);
            if (w) warnings.push(w);
        }
    }
    return { error: null, warnings };
}

// ── What the PUBLIC site may know about a service ──────────────────────────────────────────────────────────────
// Owner rule: prices are never public; a client first sees an amount in the quotation. So the public payload is an
// ALLOWLIST (the services table keeps gaining columns - prices, GL codes, cost centres - and a denylist rots).
// Nothing here says what a service costs, how it is priced (range / from / enquire) or how it is booked in the books.
const PUBLIC_SERVICE_COLUMNS = Object.freeze([
    'id', 'name', 'description', 'pricing_model', 'min_quantity', 'max_quantity', 'display_unit',
    'setup_time_minutes', 'performance_length_minutes', 'travel_included', 'availability_rule',
    'booking_lead_time_days', 'service_group', 'is_featured'
]);
const GROUP_ORDER = Object.keys(GROUPS);

function toPublicService(row) {
    const out = {};
    PUBLIC_SERVICE_COLUMNS.forEach(k => { out[k] = row[k] === undefined ? null : row[k]; });
    out.is_featured = !!row.is_featured;
    out.is_flat = row.pricing_model === 'flat' || row.pricing_model === 'flat_fee';
    out.service_group_label = GROUPS[row.service_group] || null;
    return out;
}

// Rate-card group order (club, corporate, private, writing, acting/voice/brand), then the ungrouped add-ons; by name within a group.
function publicServiceList(rows) {
    const rank = (r) => { const i = GROUP_ORDER.indexOf(r.service_group); return i === -1 ? GROUP_ORDER.length : i; };
    return (rows || []).slice()
        .sort((a, b) => (rank(a) - rank(b)) || String(a.name || '').localeCompare(String(b.name || '')))
        .map(toPublicService);
}

module.exports = {
    PRICE_TYPES, PRICE_UNITS, PRICING_MODELS, GROUPS, FEATURED_GROUP, PRICE_TYPE_INFO, PRICE_UNIT_LABELS,
    priceTypeOf, isFixedPrice, needsIndividualQuote, effectiveUnit, formatRand,
    catalogueUnitPrice, describePrice, normalizeServicePricing, normalizeQuantityLimits,
    priceBandWarning, checkQuoteLinePricing,
    PUBLIC_SERVICE_COLUMNS, toPublicService, publicServiceList
};
