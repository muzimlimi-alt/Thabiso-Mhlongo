// Rate card 2026, Phase 3: the service pricing model and the logic that consumes it.
//
// Covers: the pure rules (lib/service-pricing.js), the loaded catalogue against the official rate card
// (the expected table below is typed from Thabiso_Mhlongo_Booking_Kit_2026.pdf, deliberately NOT imported
// from lib/rate-card-2026.js, so a drift in either one fails here), the admin API for every price type
// (fixed / range / from / enquire / enquire-with-minimum, hourly + monthly units), booking snapshots,
// the quote guard (no guessed amounts), and historical protection (editing a rate never rewrites a
// saved booking or quote).
const sqlite3 = require('sqlite3');
const sp = require('../lib/service-pricing');

let seq = 0;
const email = () => `svcprice.${Date.now()}.${seq++}@example.invalid`;
const uniq = () => `ZZ-PT ${Date.now().toString(36)}${seq++}`;

// name, group, type, fee (fixed only), min, max, unit, expected admin label — straight from the PDF.
const PDF = [
    // Club and Theatre
    ['Club – 10 min Set (Guest Spot)', 'club_theatre', 'fixed', 5000, null, null, null, 'R5,000'],
    ['Club – 20 min Set (Support)', 'club_theatre', 'fixed', 10000, null, null, null, 'R10,000'],
    ['Club – 45 min Headline', 'club_theatre', 'fixed', 18000, null, null, null, 'R18,000'],
    ['Club – MC Club Night', 'club_theatre', 'fixed', 12000, null, null, null, 'R12,000'],
    // Corporate and Events (Most Booked)
    ['Corporate – 15 min Comedic Performance', 'corporate_events', 'fixed', 28000, null, null, null, 'R28,000'],
    ['Corporate – 30 min Comedic Performance', 'corporate_events', 'fixed', 42000, null, null, null, 'R42,000'],
    ['Corporate – 45–60 min Comedic Performance', 'corporate_events', 'fixed', 55000, null, null, null, 'R55,000'],
    ['Corporate – MC Duties 1–2 Hours', 'corporate_events', 'fixed', 30000, null, null, null, 'R30,000'],
    ['Corporate – MC Duties 2–4 Hours', 'corporate_events', 'fixed', 45000, null, null, null, 'R45,000'],
    ['Corporate – MC Duties 4–6 Hours', 'corporate_events', 'fixed', 60000, null, null, null, 'R60,000'],
    ['Corporate – MC Duties Full Day (6+ Hours)', 'corporate_events', 'fixed', 75000, null, null, null, 'R75,000'],
    // Private functions, weddings, year-end
    ['Private – MC 1–3 Hours', 'private_functions', 'fixed', 30000, null, null, null, 'R30,000'],
    ['Private – MC 3–5 Hours', 'private_functions', 'fixed', 42000, null, null, null, 'R42,000'],
    ['Private – Performance + MC Combo', 'private_functions', 'from', 0, 50000, null, null, 'From R50,000'],
    // Writing and creative
    ['Writing – Copywriting / Roast Writing / Joke Pack', 'writing_creative', 'range', 0, 12000, 25000, null, 'R12,000 – R25,000'],
    ['Writing – TV Script (30 min Episode)', 'writing_creative', 'range', 0, 18000, 35000, null, 'R18,000 – R35,000'],
    ['Writing – Film / Telenovela Script (per draft)', 'writing_creative', 'enquire', 0, null, null, 'draft', 'Enquire'],
    ['Writing – Head Writer (per month)', 'writing_creative', 'range', 0, 90000, 140000, 'month', 'R90,000 – R140,000 per month'],
    ['Writing – Script Editor (per month)', 'writing_creative', 'range', 0, 45000, 65000, 'month', 'R45,000 – R65,000 per month'],
    ['Writing – Consultation', 'writing_creative', 'fixed', 2500, null, null, 'hour', 'R2,500 per hour'],
    // Acting, voice-over, brand campaigns
    ['Acting – Per SAGA', 'acting_voice_brand', 'enquire_min', 0, 15000, null, 'session', 'Enquire – minimum R15,000 per session'],
    ['Voice-Over – Per SAGA/SAG', 'acting_voice_brand', 'enquire_min', 0, 15000, null, 'session', 'Enquire – minimum R15,000 per session'],
    ['Brand Campaign / Content Day Rate + Usage', 'acting_voice_brand', 'from', 0, 60000, null, null, 'From R60,000']
];

module.exports = async function ({ check, api, pub, one, q, future, sleep, TEST_DB }) {
    const eq = (name, got, want) => check(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    const rejects = (name, r, re) => check(name, r.status === 400 && re.test((r.body && (r.body.error || r.body.message)) || ''), `${r.status} ${JSON.stringify(r.body)}`);

    // ═══ 1. The pure rules ═══
    check('a legacy row with no (or an unknown) price_type is an ordinary fixed price',
        sp.priceTypeOf({}) === 'fixed' && sp.priceTypeOf({ price_type: null }) === 'fixed' && sp.priceTypeOf({ price_type: 'bogus' }) === 'fixed');
    const label = (o) => sp.describePrice(o).price_label;
    eq('label: fixed fee', label({ price_type: 'fixed', default_price: 28000 }), 'R28,000');
    eq('label: fixed fee keeps cents', label({ price_type: 'fixed', default_price: 333.33 }), 'R333.33');
    eq('label: hourly fixed rate carries its unit', label({ price_type: 'fixed', default_price: 2500, pricing_model: 'per_hour' }), 'R2,500 per hour');
    eq('label: range', label({ price_type: 'range', price_min: 12000, price_max: 25000 }), 'R12,000 – R25,000');
    eq('label: monthly range', label({ price_type: 'range', price_min: 90000, price_max: 140000, price_unit: 'month' }), 'R90,000 – R140,000 per month');
    eq('label: starting price', label({ price_type: 'from', price_min: 50000 }), 'From R50,000');
    eq('label: enquiry', label({ price_type: 'enquire' }), 'Enquire');
    eq('label: enquiry with a minimum', label({ price_type: 'enquire_min', price_min: 15000, price_unit: 'session' }), 'Enquire – minimum R15,000 per session');
    eq('label: a range with no usable bounds degrades to Enquire, never an invented figure', label({ price_type: 'range', price_min: 5000 }), 'Enquire');
    eq('label: a "from" price with no amount degrades to Enquire', label({ price_type: 'from', price_min: 0 }), 'Enquire');
    check('only fixed prices are not quote-required',
        !sp.describePrice({ price_type: 'fixed' }).quote_required && ['range', 'from', 'enquire', 'enquire_min'].every(t => sp.describePrice({ price_type: t }).quote_required));

    eq('catalogue price: fixed uses default_price', sp.catalogueUnitPrice({ price_type: 'fixed', default_price: 28000 }), 28000);
    eq('catalogue price: base_price wins when set (existing booking behaviour)', sp.catalogueUnitPrice({ price_type: 'fixed', default_price: 100, base_price: 2500 }), 2500);
    eq('catalogue price: legacy row (no type) is still its default_price', sp.catalogueUnitPrice({ default_price: 1500 }), 1500);
    eq('catalogue price: a range is NEVER pre-filled, even with a stale default_price', sp.catalogueUnitPrice({ price_type: 'range', default_price: 5000, base_price: 4000, price_min: 1000, price_max: 9000 }), 0);
    eq('catalogue price: "from" is never pre-filled', sp.catalogueUnitPrice({ price_type: 'from', default_price: 7, price_min: 50000 }), 0);
    eq('catalogue price: enquiry is never pre-filled', sp.catalogueUnitPrice({ price_type: 'enquire_min', default_price: 7, price_min: 15000 }), 0);

    const norm = (input, existing) => sp.normalizeServicePricing(input, existing || null);
    let n = norm({ default_price: '1500' });
    check('create with only a price is a fixed price with no band', n.ok && n.fields.price_type === 'fixed' && n.fields.default_price === 1500 && n.fields.price_min === null && n.fields.price_max === null, JSON.stringify(n));
    check('fixed price is required', !norm({ price_type: 'fixed' }).ok && /default_price is required/.test(norm({}).error));
    check('fixed price cannot be negative', !norm({ default_price: -1 }).ok);
    n = norm({ price_type: 'range', price_min: 1000, price_max: 2000, default_price: 999, base_price: 50 });
    check('range stores its band and forces default/base price to nothing', n.ok && n.fields.default_price === 0 && n.fields.base_price === null && n.fields.price_min === 1000 && n.fields.price_max === 2000, JSON.stringify(n));
    check('range needs both bounds', !norm({ price_type: 'range', price_min: 1000 }).ok && !norm({ price_type: 'range', price_max: 1000 }).ok);
    check('range bounds must be above zero', !norm({ price_type: 'range', price_min: 0, price_max: 1000 }).ok);
    check('range min must be below max (equal -> use a fixed price)', !norm({ price_type: 'range', price_min: 1000, price_max: 1000 }).ok && !norm({ price_type: 'range', price_min: 2000, price_max: 1000 }).ok);
    n = norm({ price_type: 'from', price_min: 100, price_max: 999 });
    check('"from" keeps only its starting price', n.ok && n.fields.price_min === 100 && n.fields.price_max === null && n.fields.default_price === 0, JSON.stringify(n));
    check('"from" needs a starting price', !norm({ price_type: 'from' }).ok);
    n = norm({ price_type: 'enquire', price_min: 100, price_max: 200, default_price: 50 });
    check('enquiry carries no amount at all', n.ok && n.fields.price_min === null && n.fields.price_max === null && n.fields.default_price === 0, JSON.stringify(n));
    check('enquiry-with-minimum needs the minimum', !norm({ price_type: 'enquire_min' }).ok && norm({ price_type: 'enquire_min', price_min: 15000 }).ok);
    check('unknown price_type / price_unit / service_group are rejected',
        !norm({ price_type: 'bogus', default_price: 1 }).ok && !norm({ default_price: 1, price_unit: 'fortnight' }).ok && !norm({ default_price: 1, service_group: 'nope' }).ok);
    check('known price_unit and service_group are accepted', norm({ default_price: 1, price_unit: 'month', service_group: 'writing_creative' }).ok);
    n = norm({ default_price: 2500, pricing_model: 'per_hour' });
    check('hourly model implies the hour unit', n.ok && n.fields.price_unit === 'hour', JSON.stringify(n));
    check('hourly / per-minute billing is for fixed prices only', !norm({ price_type: 'range', price_min: 1, price_max: 2, pricing_model: 'per_hour' }).ok);
    check('a unit that contradicts the pricing model is rejected', !norm({ default_price: 1, pricing_model: 'per_hour', price_unit: 'month' }).ok);
    check('legacy "flat" model is read as flat_fee; unknown models are rejected', norm({ default_price: 1, pricing_model: 'flat' }).fields.pricing_model === 'flat_fee' && !norm({ default_price: 1, pricing_model: 'banana' }).ok);
    check('featured flag: true/1 on, false/absent off', norm({ default_price: 1, is_featured: true }).fields.is_featured === 1 && norm({ default_price: 1, is_featured: 'false' }).fields.is_featured === 0 && norm({ default_price: 1 }).fields.is_featured === 0);

    const rangeRow = { price_type: 'range', price_min: 12000, price_max: 25000, default_price: 0, pricing_model: 'flat_fee', price_unit: 'month', is_featured: 1, service_group: 'writing_creative' };
    n = norm({ default_price: 0 }, rangeRow);
    check('an edit that does not mention price_type keeps a range a range (older admin screens)', n.ok && n.fields.price_type === 'range' && n.fields.price_min === 12000 && n.fields.price_max === 25000 && n.fields.price_unit === 'month' && n.fields.service_group === 'writing_creative' && n.fields.is_featured === 1, JSON.stringify(n));
    eq('...and ignores a posted default_price for it', norm({ default_price: 4321 }, rangeRow).fields.default_price, 0);
    n = norm({ price_type: 'fixed', default_price: 4321 }, rangeRow);
    check('an explicit change to fixed drops the band', n.ok && n.fields.price_type === 'fixed' && n.fields.default_price === 4321 && n.fields.price_min === null && n.fields.price_max === null, JSON.stringify(n));
    check('...but converting to fixed must name a price above zero (a stored 0 must not become a free service)',
        !norm({ price_type: 'fixed' }, rangeRow).ok && !norm({ price_type: 'fixed', default_price: 0 }, rangeRow).ok && /Enter the fixed price/.test(norm({ price_type: 'fixed' }, rangeRow).error)
        && norm({ default_price: 0 }, { price_type: 'fixed', default_price: 0 }).ok);
    check('an explicit change of band bounds is honoured', norm({ price_min: 13000, price_max: 26000 }, rangeRow).fields.price_min === 13000);

    check('flat fee is always exactly one unit', JSON.stringify(sp.normalizeQuantityLimits('flat_fee', 5, 9)) === JSON.stringify({ ok: true, min: 1, max: null }));
    check('per-minute services still need a 15 minute minimum', !sp.normalizeQuantityLimits('per_minute', 1, 60).ok && sp.normalizeQuantityLimits('per_minute', 15, 60).ok);
    check('hourly services can start at 1 hour (was wrongly forced to 15)', sp.normalizeQuantityLimits('per_hour', 1, 8).ok && sp.normalizeQuantityLimits('per_hour', 1, null).ok);
    check('minimum cannot exceed maximum', !sp.normalizeQuantityLimits('per_hour', 5, 2).ok);

    const rng = { name: 'R', price_type: 'range', price_min: 12000, price_max: 25000 };
    check('band warning: inside a range is quiet', sp.priceBandWarning(rng, 15000) === null && sp.priceBandWarning(rng, 12000) === null && sp.priceBandWarning(rng, 25000) === null);
    check('band warning: outside a range warns', /outside its published range of R12,000 – R25,000/.test(sp.priceBandWarning(rng, 30000) || '') && /outside/.test(sp.priceBandWarning(rng, 11000) || ''));
    check('band warning: below a starting price warns, at or above is quiet', /below its published starting price of R50,000/.test(sp.priceBandWarning({ name: 'F', price_type: 'from', price_min: 50000 }, 40000) || '') && sp.priceBandWarning({ name: 'F', price_type: 'from', price_min: 50000 }, 50000) === null);
    check('band warning: below a minimum fee warns', /below its published minimum of R15,000 per session/.test(sp.priceBandWarning({ name: 'A', price_type: 'enquire_min', price_min: 15000, price_unit: 'session' }, 10000) || ''));
    check('band warning: enquiry, fixed and zero never warn', sp.priceBandWarning({ price_type: 'enquire' }, 5) === null && sp.priceBandWarning({ price_type: 'fixed', default_price: 100 }, 5) === null && sp.priceBandWarning(rng, 0) === null);

    const cat = [{ id: 1, name: 'Ranged', price_type: 'range', price_min: 12000, price_max: 25000 }, { id: 2, name: 'Flat', price_type: 'fixed', default_price: 500 }, { id: 3, name: 'Ask', price_type: 'enquire' }];
    check('quote check: a fixed-price line is left alone (even at 0)', sp.checkQuoteLinePricing([{ service_id: 2, unit_price: 0 }], cat).error === null);
    check('quote check: a range line with no amount is refused', /Ranged.*priced individually/.test(sp.checkQuoteLinePricing([{ service_id: 1, unit_price: 0 }], cat).error || ''));
    check('quote check: an enquiry line with no amount is refused', /Ask.*Enquire/.test(sp.checkQuoteLinePricing([{ service_id: 3, unit_price: '' }], cat).error || ''));
    check('quote check: an explicit amount passes, with a warning only when outside the band',
        sp.checkQuoteLinePricing([{ service_id: 1, unit_price: '15000' }], cat).error === null && sp.checkQuoteLinePricing([{ service_id: 1, unit_price: '15000' }], cat).warnings.length === 0 && sp.checkQuoteLinePricing([{ service_id: 1, unit_price: 99999 }], cat).warnings.length === 1);
    check('quote check: custom lines and unknown service ids are skipped', sp.checkQuoteLinePricing([{ description: 'custom', unit_price: 0 }, { service_id: 999, unit_price: 0 }], cat).error === null);

    // ═══ 2. The loaded catalogue against the official rate card ═══
    // The server accepts requests while its boot-time data migration may still be queued, so poll for the
    // migration marker (it is written inside the migration's own transaction) instead of racing it.
    let migrated = false;
    for (let i = 0; i < 100 && !migrated; i++) {
        migrated = !!(await one('SELECT 1 AS x FROM schema_migrations WHERE version = 106'));
        if (!migrated) await sleep(100);
    }
    check('the rate card migration has been applied at boot', migrated);
    const listAll = async () => (await api('GET', '/api/admin/services?include_deleted=1')).body || [];
    let all = await listAll();
    const byName = (name) => all.find(s => s.name === name);
    // Group headings exactly as the rate card prints them (stored as slugs; the label is what the admin shows).
    const GROUP_LABEL = { club_theatre: 'Club & Theatre', corporate_events: 'Corporate & Events', private_functions: 'Private Functions, Weddings & Year-End Events',
        writing_creative: 'Writing & Creative Services', acting_voice_brand: 'Acting, Voice-Over & Brand Campaigns' };
    for (const [name, group, type, fee, min, max, unit, lbl] of PDF) {
        const s = byName(name);
        if (!s) { check(`rate card: "${name}" exists`, false, 'missing'); continue; }
        const ok = !!s.is_active && !s.is_deleted && s.service_group === group && s.service_group_label === GROUP_LABEL[group] && s.price_type === type
            && Number(s.default_price) === fee && (s.price_min === null ? null : Number(s.price_min)) === min
            && (s.price_max === null ? null : Number(s.price_max)) === max && (s.price_unit || null) === unit
            && s.price_label === lbl && s.quote_required === (type !== 'fixed')
            && s.pricing_model === (name === 'Writing – Consultation' ? 'per_hour' : 'flat_fee')
            && !!s.is_taxable && s.tax_class === 'standard' && (group === 'corporate_events') === !!s.is_featured;
        check(`rate card: "${name}" — ${lbl}`, ok, JSON.stringify(s));
    }
    const live = all.filter(s => s.service_group && s.is_active && !s.is_deleted);
    eq('rate card: exactly the 23 published services are live in a rate-card group', live.length, 23);
    eq('rate card: no duplicate service names', new Set(all.map(s => s.name)).size, all.length);
    eq('rate card: the Most Booked flag is on the 7 Corporate services and nowhere else', all.filter(s => s.is_featured).length, 7);
    const addOnActive = (prefix) => all.some(s => !s.is_deleted && s.is_active && s.name.startsWith(prefix));
    check('rate card: travel / accommodation / rider / merchandise add-ons are still active',
        ['Travel Buyout – Gauteng', 'Travel Buyout – National', 'Travel Buyout – International', 'Technical Rider', 'Accommodation', 'Merchandise'].every(addOnActive));
    const svc15 = await one('SELECT name, is_active, is_deleted FROM services WHERE id = 15');
    check('service 15 (used across the suite) is untouched', svc15 && svc15.name === 'Travel Buyout – Gauteng' && svc15.is_active === 1 && !svc15.is_deleted, JSON.stringify(svc15));
    const legacy = all.filter(s => !s.is_deleted && ['MC & Host – Hourly Rate', 'Comedy Roast – Event Host', 'Voice-Over – Per Spot', 'Voice-Over – Session Rate (per minute)', 'TV / Film Appearance – Day Rate', 'Podcast / Interview Guest Appearance', 'MC / Hosting (Per Minute)'].includes(s.name));
    check('old catalogue rows that are not on the rate card are deactivated, not deleted', legacy.every(s => !s.is_active), JSON.stringify(legacy.map(s => [s.name, s.is_active])));
    const settings = Object.fromEntries((await q("SELECT setting_key, setting_value FROM settings WHERE setting_key LIKE 'rate_card_%'")).map(r => [r.setting_key, r.setting_value]));
    check('rate card validity and conditions are stored', settings.rate_card_valid_until === '2026-12-31' && settings.rate_card_currency === 'ZAR'
        && /exclude VAT at 15%, travel, accommodation, and rider/.test(settings.rate_card_conditions || '') && /valid until 31 December 2026/.test(settings.rate_card_conditions || '') && settings.rate_card_featured_group === 'corporate_events', JSON.stringify(settings));
    check('the migration is recorded once', (await one('SELECT COUNT(*) c FROM schema_migrations WHERE version = 106')).c === 1);

    // ═══ 3. Admin API — every price type ═══
    const createdIds = [];   // archived again at the end, so these fixtures do not linger in the shared test DB
    const mk = async (over) => { const res = await api('POST', '/api/admin/services', { name: uniq(), category: 'Other', is_taxable: true, is_active: true, ...over }); if (res.body && res.body.id) createdIds.push(res.body.id); return res; };
    const fetchOne = async (id) => (await listAll()).find(s => s.id === id);

    let r = await mk({ default_price: 1234 });
    let s = r.body && r.body.id ? await fetchOne(r.body.id) : null;
    check('create fixed: stored as a fixed price', r.status === 200 && s && s.price_type === 'fixed' && Number(s.default_price) === 1234 && s.price_min === null && s.price_label === 'R1,234' && s.quote_required === false, `${r.status} ${JSON.stringify(s)}`);

    r = await mk({ price_type: 'range', price_min: 1000, price_max: 2000, default_price: 777, base_price: 55 });
    const rangeId = r.body && r.body.id;
    s = rangeId ? await fetchOne(rangeId) : null;
    check('create range: band kept, default/base price forced empty', r.status === 200 && s && s.price_type === 'range' && Number(s.default_price) === 0 && s.base_price === null && Number(s.price_min) === 1000 && Number(s.price_max) === 2000 && s.price_label === 'R1,000 – R2,000' && s.quote_required === true, `${r.status} ${JSON.stringify(s)}`);

    r = await mk({ price_type: 'range', price_min: 90000, price_max: 140000, price_unit: 'month', service_group: 'writing_creative' });
    s = r.body && r.body.id ? await fetchOne(r.body.id) : null;
    check('create monthly range: unit and group kept', r.status === 200 && s && s.price_unit === 'month' && s.service_group === 'writing_creative' && s.price_label === 'R90,000 – R140,000 per month', `${r.status} ${JSON.stringify(s)}`);

    r = await mk({ price_type: 'from', price_min: 3000, price_max: 9999 });
    s = r.body && r.body.id ? await fetchOne(r.body.id) : null;
    check('create "from": only the starting price is kept', r.status === 200 && s && Number(s.price_min) === 3000 && s.price_max === null && Number(s.default_price) === 0 && s.price_label === 'From R3,000', `${r.status} ${JSON.stringify(s)}`);

    r = await mk({ price_type: 'enquire', price_min: 5, price_max: 10, default_price: 5 });
    s = r.body && r.body.id ? await fetchOne(r.body.id) : null;
    check('create enquiry: no amount is stored', r.status === 200 && s && s.price_min === null && s.price_max === null && Number(s.default_price) === 0 && s.price_label === 'Enquire', `${r.status} ${JSON.stringify(s)}`);

    r = await mk({ price_type: 'enquire_min', price_min: 4000, price_unit: 'session' });
    s = r.body && r.body.id ? await fetchOne(r.body.id) : null;
    check('create enquiry with a minimum: minimum and unit kept', r.status === 200 && s && Number(s.price_min) === 4000 && s.price_unit === 'session' && s.price_label === 'Enquire – minimum R4,000 per session', `${r.status} ${JSON.stringify(s)}`);

    r = await mk({ pricing_model: 'per_hour', default_price: 2500, min_quantity: 1, max_quantity: 8 });
    const hourlyId = r.body && r.body.id;
    s = hourlyId ? await fetchOne(hourlyId) : null;
    check('create hourly fixed rate: 1 hour minimum accepted, hour unit and "hr" display set', r.status === 200 && s && s.price_unit === 'hour' && s.display_unit === 'hr' && s.min_quantity === 1 && s.max_quantity === 8 && s.price_label === 'R2,500 per hour', `${r.status} ${JSON.stringify(s)}`);

    r = await mk({ pricing_model: 'per_minute', default_price: 50, min_quantity: 15, max_quantity: 120 });
    s = r.body && r.body.id ? await fetchOne(r.body.id) : null;
    check('create per-minute rate: 15 minute minimum accepted, minute unit set', r.status === 200 && s && s.price_unit === 'minute' && s.display_unit === 'min' && s.min_quantity === 15, `${r.status} ${JSON.stringify(s)}`);

    r = await mk({ default_price: 10, is_featured: true, service_group: 'corporate_events' });
    s = r.body && r.body.id ? await fetchOne(r.body.id) : null;
    check('create with featured flag and group', r.status === 200 && s && s.is_featured === 1 && s.service_group === 'corporate_events', `${r.status} ${JSON.stringify(s)}`);

    const before = (await listAll()).length;
    rejects('reject: range without a maximum', await mk({ price_type: 'range', price_min: 1000 }), /both price_min and price_max/);
    rejects('reject: range with min >= max', await mk({ price_type: 'range', price_min: 2000, price_max: 1000 }), /less than price_max/);
    rejects('reject: "from" without a starting price', await mk({ price_type: 'from' }), /price_min/);
    rejects('reject: enquiry-with-minimum without a minimum', await mk({ price_type: 'enquire_min' }), /price_min/);
    rejects('reject: unknown price_type', await mk({ price_type: 'bogus', default_price: 1 }), /price_type must be one of/);
    rejects('reject: unknown price_unit', await mk({ default_price: 1, price_unit: 'fortnight' }), /price_unit must be one of/);
    rejects('reject: unknown service_group', await mk({ default_price: 1, service_group: 'nope' }), /service_group must be one of/);
    rejects('reject: hourly billing on a range', await mk({ price_type: 'range', price_min: 1, price_max: 2, pricing_model: 'per_hour' }), /fixed-price services/);
    rejects('reject: fixed price missing', await mk({}), /default_price is required/);
    rejects('reject: negative fixed price', await mk({ default_price: -5 }), /negative/);
    rejects('reject: per-minute minimum below 15', await mk({ pricing_model: 'per_minute', default_price: 5, min_quantity: 1 }), /at least 15 minutes/);
    rejects('reject: minimum above maximum', await mk({ pricing_model: 'per_hour', default_price: 5, min_quantity: 5, max_quantity: 2 }), /cannot exceed/);
    rejects('reject: missing name', await api('POST', '/api/admin/services', { default_price: 5 }), /name is required/);
    eq('no rejected request created a row', (await listAll()).length, before);

    // Editing: older admin screens know nothing about price_type.
    const oldUi = (row, over) => ({
        name: row.name, description: '', default_price: 0, category: row.category || 'Other', pricing_model: 'flat_fee', display_unit: 'unit',
        min_quantity: 1, max_quantity: null, is_taxable: true, is_active: true, service_type: 'core', pricing_group: 'Standard',
        availability_rule: 'any_time', booking_lead_time_days: 0, setup_time_minutes: 0, performance_length_minutes: 0,
        tax_class: 'standard', base_price: null, is_deleted: 0, ...over
    });
    const rangeBefore = await fetchOne(rangeId);
    r = await api('PUT', `/api/admin/services/${rangeId}`, oldUi(rangeBefore));
    s = await fetchOne(rangeId);
    check('PUT from an older screen (no price_type): a range stays a range', r.status === 200 && s.price_type === 'range' && Number(s.price_min) === 1000 && Number(s.price_max) === 2000 && Number(s.default_price) === 0, `${r.status} ${JSON.stringify(s)}`);
    r = await api('PUT', `/api/admin/services/${rangeId}`, oldUi(rangeBefore, { default_price: 4321 }));
    s = await fetchOne(rangeId);
    check('...a posted price cannot turn it into a fixed fee', r.status === 200 && s.price_type === 'range' && Number(s.default_price) === 0, JSON.stringify(s));
    r = await api('PUT', `/api/admin/services/${rangeId}`, { ...rangeBefore, is_deleted: 0, is_active: true });
    s = await fetchOne(rangeId);
    check('restore-style PUT (the full row echoed back, labels included) is accepted and changes nothing', r.status === 200 && s.price_type === 'range' && Number(s.price_min) === 1000 && s.price_label === 'R1,000 – R2,000', `${r.status} ${JSON.stringify(s)}`);
    r = await api('PUT', `/api/admin/services/${rangeId}`, oldUi(rangeBefore, { price_type: 'fixed', default_price: 4321 }));
    s = await fetchOne(rangeId);
    check('an explicit change to fixed drops the band', r.status === 200 && s.price_type === 'fixed' && Number(s.default_price) === 4321 && s.price_min === null && s.price_max === null && s.price_label === 'R4,321', `${r.status} ${JSON.stringify(s)}`);
    r = await api('PUT', `/api/admin/services/${rangeId}`, oldUi(rangeBefore, { price_type: 'from', price_min: 900 }));
    s = await fetchOne(rangeId);
    check('...and on to a starting price', r.status === 200 && s.price_type === 'from' && Number(s.price_min) === 900 && Number(s.default_price) === 0 && s.price_label === 'From R900', `${r.status} ${JSON.stringify(s)}`);
    await sleep(120);
    const aud = await one("SELECT old_values, new_values FROM audit_log WHERE table_name='services' AND record_id=? AND action='UPDATE' ORDER BY id DESC LIMIT 1", [rangeId]);
    check('the rate change is audited with what it was and what it became', aud && /"price_type":"fixed"/.test(aud.old_values || '') && /"default_price":4321/.test(aud.old_values || '') && /"price_type":"from"/.test(aud.new_values || '') && /"price_min":900/.test(aud.new_values || ''), JSON.stringify(aud));

    rejects('PUT: converting a priced-individually service to fixed needs a real price', await api('PUT', `/api/admin/services/${rangeId}`, oldUi(rangeBefore, { price_type: 'fixed', default_price: 0 })), /Enter the fixed price/);
    check('...and the refused conversion changed nothing', (await fetchOne(rangeId)).price_type === 'from');

    const hourlyRow = await fetchOne(hourlyId);
    r = await api('PUT', `/api/admin/services/${hourlyId}`, oldUi(hourlyRow, { default_price: 2500, pricing_model: 'per_hour', display_unit: 'hr', min_quantity: 1, max_quantity: 8 }));
    check('editing an hourly service with a 1 hour minimum now works (was a 400)', r.status === 200, `${r.status} ${JSON.stringify(r.body)}`);
    rejects('PUT validates too: bad range is refused', await api('PUT', `/api/admin/services/${rangeId}`, oldUi(rangeBefore, { price_type: 'range', price_min: 5, price_max: 1 })), /less than price_max/);
    eq('PUT of an unknown service is a 404', (await api('PUT', '/api/admin/services/99999999', oldUi(rangeBefore))).status, 404);

    // The database refuses an out-of-vocabulary price type even if a write bypasses the API.
    const rw = new sqlite3.Database(TEST_DB);
    rw.configure('busyTimeout', 5000);
    const run = (sql, params = []) => new Promise((res, rej) => rw.run(sql, params, function (e) { e ? rej(e) : res(this); }));
    let dbErr = null;
    try { await run("UPDATE services SET price_type = 'bogus' WHERE id = ?", [rangeId]); } catch (e) { dbErr = e; }
    check('DB guard: an invalid price_type is refused on update', !!dbErr && /price_type must be one of/.test(dbErr.message), dbErr && dbErr.message);
    dbErr = null;
    try { await run("INSERT INTO services (name, default_price, price_unit) VALUES (?, 1, 'fortnight')", [uniq()]); } catch (e) { dbErr = e; }
    check('DB guard: an invalid price_unit is refused on insert', !!dbErr && /price_unit must be one of/.test(dbErr.message), dbErr && dbErr.message);

    // ═══ 4. Booking snapshots ═══
    const idOf = async (name) => (await one('SELECT id FROM services WHERE name = ?', [name])).id;
    const base = (over = {}) => ({
        name: 'Svc Price IT', email: email(), cell: '+27821234567', event_date: future(1100),
        event_name: 'Svc Price Event', event_location: 'Hall', event_type: 'Corporate',
        message: 'Service pricing integration test, over ten characters.', popia_consent: true, ...over
    });
    const manual = (days, services) => api('POST', '/api/admin/bookings', {
        name: 'Svc Price IT', email: email(), cell: '+27821234567', event_date: future(days), event_name: 'Svc Price Event',
        event_type: 'Corporate', event_location: 'Test Hall', message: 'Service pricing integration test, over ten characters.',
        services, status: 'NEW', override_working_hours: true
    });
    const snap = async (bookingId) => ({
        bs: await q('SELECT service_id, quantity_minutes, unit_price, total_price FROM booking_services WHERE booking_id = ? ORDER BY id', [bookingId]),
        li: await q('SELECT service_id, quantity, unit_price FROM booking_line_items WHERE booking_id = ? ORDER BY id', [bookingId]),
        bk: await one('SELECT total_amount, payment_status, status FROM bookings WHERE id = ?', [bookingId])
    });

    const fixedId = await idOf('Club – 10 min Set (Guest Spot)');
    const rangeSvcId = await idOf('Writing – Copywriting / Roast Writing / Joke Pack');
    const fromSvcId = await idOf('Private – Performance + MC Combo');
    const enquireSvcId = await idOf('Writing – Film / Telenovela Script (per draft)');
    const minSvcId = await idOf('Acting – Per SAGA');
    const hourlySvcId = await idOf('Writing – Consultation');

    r = await pub('POST', '/api/public/bookings', base({ event_date: future(1101), services: [{ service_id: fixedId }] }));
    let sn = r.body && r.body.booking_id ? await snap(r.body.booking_id) : null;
    check('public booking of a fixed service snapshots its catalogue fee', r.status === 200 && sn && sn.bs.length === 1 && sn.bs[0].unit_price === 5000 && sn.li[0].unit_price === 5000 && sn.bk.total_amount === 5000, `${r.status} ${JSON.stringify(r.body)} ${JSON.stringify(sn)}`);

    r = await pub('POST', '/api/public/bookings', base({ event_date: future(1102), services: [{ service_id: rangeSvcId }] }));
    sn = r.body && r.body.booking_id ? await snap(r.body.booking_id) : null;
    check('public booking of a range service snapshots NO amount (never its minimum or midpoint)', r.status === 200 && sn && sn.bs[0].unit_price === 0 && sn.bs[0].total_price === 0 && sn.li[0].unit_price === 0 && sn.bk.total_amount === 0, `${r.status} ${JSON.stringify(r.body)} ${JSON.stringify(sn)}`);
    check('...and a booking with no price yet is not marked paid', sn && sn.bk.payment_status === 'UNPAID' && sn.bk.status === 'NEW', JSON.stringify(sn && sn.bk));

    const mf = await manual(1103, [{ service_id: fromSvcId }, { service_id: enquireSvcId }, { service_id: minSvcId }]);
    sn = mf.body && mf.body.booking_id ? await snap(mf.body.booking_id) : null;
    check('manual booking: "from", enquiry and minimum-fee services all snapshot 0', mf.status === 200 && sn && sn.bs.length === 3 && sn.bs.every(x => x.unit_price === 0 && x.total_price === 0) && sn.bk.total_amount === 0, `${mf.status} ${JSON.stringify(mf.body)} ${JSON.stringify(sn)}`);

    // Hourly consultation: the public path (performance_duration in minutes) and the manual path (minutes
    // from the form) must store the SAME billable quantity — whole hours — or the quote prefill is wrong.
    r = await pub('POST', '/api/public/bookings', base({ event_date: future(1104), services: [{ service_id: hourlySvcId }], performance_duration: '120' }));
    const pubHourly = r.body && r.body.booking_id ? await snap(r.body.booking_id) : null;
    check('public hourly booking: 120 minutes bills as 2 hours', r.status === 200 && pubHourly && pubHourly.bs[0].quantity_minutes === 2 && pubHourly.bs[0].unit_price === 2500 && pubHourly.bs[0].total_price === 5000, `${r.status} ${JSON.stringify(r.body)} ${JSON.stringify(pubHourly)}`);
    const mh = await manual(1105, [{ service_id: hourlySvcId, quantity_minutes: 120 }]);
    const manHourly = mh.body && mh.body.booking_id ? await snap(mh.body.booking_id) : null;
    check('manual hourly booking: 120 minutes is stored as 2 hours too (not "120 hr")', mh.status === 200 && manHourly && manHourly.bs[0].quantity_minutes === 2 && manHourly.bs[0].unit_price === 2500 && manHourly.bs[0].total_price === 5000 && manHourly.li[0].quantity === 2 && manHourly.bk.total_amount === 5000, `${mh.status} ${JSON.stringify(mh.body)} ${JSON.stringify(manHourly)}`);
    const mh2 = await manual(1106, [{ service_id: hourlySvcId, quantity_minutes: 150 }]);
    const manHourly2 = mh2.body && mh2.body.booking_id ? await snap(mh2.body.booking_id) : null;
    check('manual hourly booking: a part hour rounds up (150 min -> 3 hours)', mh2.status === 200 && manHourly2 && manHourly2.bs[0].quantity_minutes === 3 && manHourly2.bs[0].total_price === 7500, `${mh2.status} ${JSON.stringify(manHourly2)}`);

    // ═══ 5. The quote: no guessed amounts ═══
    const quote = async (bookingId, items, over = {}) => {
        const bk = await one('SELECT date FROM bookings WHERE id = ?', [bookingId]);
        const expiry = new Date(Date.parse(bk.date) - 10 * 86400000).toISOString().slice(0, 10);
        return api('POST', `/api/admin/bookings/${bookingId}/quote`, { quote_expiry_date: expiry, terms: 'T', apply_vat: false, discount: 0, items, ...over });
    };
    const qCount = async (bookingId) => (await one('SELECT COUNT(*) c FROM quotations WHERE booking_id = ?', [bookingId])).c;

    const qb = (await manual(1110, [{ service_id: rangeSvcId }])).body.booking_id;
    await sleep(50);
    r = await quote(qb, [{ service_id: rangeSvcId, description: 'Joke pack', quantity: 1, unit_price: 0 }]);
    rejects('quote: a range line with no agreed amount is refused', r, /priced individually \(R12,000 – R25,000\)/);
    check('...and nothing was issued (no quotation, booking still NEW)', (await qCount(qb)) === 0 && (await one('SELECT status FROM bookings WHERE id = ?', [qb])).status === 'NEW');
    r = await quote(qb, [{ service_id: rangeSvcId, description: 'Joke pack', quantity: 1, unit_price: 15000 }]);
    let qrow = await one('SELECT total_amount FROM quotations WHERE booking_id = ? ORDER BY id DESC LIMIT 1', [qb]);
    check('quote: an explicit amount inside the published range is accepted, with no warning', r.status === 200 && !r.body.warnings && qrow && qrow.total_amount === 15000, `${r.status} ${JSON.stringify(r.body)} ${JSON.stringify(qrow)}`);
    check('...and the quote line carries exactly that amount', JSON.stringify((await q('SELECT service_id, unit_price FROM quote_line_items WHERE quotation_id = (SELECT id FROM quotations WHERE booking_id = ? ORDER BY id DESC LIMIT 1)', [qb]))) === JSON.stringify([{ service_id: rangeSvcId, unit_price: 15000 }]));
    await sleep(1100);
    r = await quote(qb, [{ service_id: rangeSvcId, description: 'Joke pack', quantity: 1, unit_price: 30000 }]);
    check('quote: an amount outside the published range goes out, with a warning', r.status === 200 && Array.isArray(r.body.warnings) && r.body.warnings.some(w => /outside its published range of R12,000 – R25,000/.test(w)), `${r.status} ${JSON.stringify(r.body)}`);

    const qf = (await manual(1111, [{ service_id: fromSvcId }])).body.booking_id;
    await sleep(50);
    r = await quote(qf, [{ service_id: fromSvcId, description: 'Combo', quantity: 1, unit_price: 40000 }]);
    check('quote: below a "from" price warns about the starting price', r.status === 200 && (r.body.warnings || []).some(w => /below its published starting price of R50,000/.test(w)), `${r.status} ${JSON.stringify(r.body)}`);

    const qe = (await manual(1112, [{ service_id: enquireSvcId }])).body.booking_id;
    await sleep(50);
    rejects('quote: an enquiry-only service cannot be quoted at nothing', await quote(qe, [{ service_id: enquireSvcId, description: 'Film script', quantity: 1, unit_price: 0 }]), /priced individually \(Enquire\)/);
    r = await quote(qe, [{ service_id: enquireSvcId, description: 'Film script', quantity: 1, unit_price: 20000 }]);
    check('quote: an enquiry service with an explicit amount is issued without warning', r.status === 200 && !r.body.warnings, `${r.status} ${JSON.stringify(r.body)}`);

    const qm = (await manual(1113, [{ service_id: minSvcId }])).body.booking_id;
    await sleep(50);
    r = await quote(qm, [{ service_id: minSvcId, description: 'Acting day', quantity: 1, unit_price: 10000 }]);
    check('quote: below a published minimum fee warns', r.status === 200 && (r.body.warnings || []).some(w => /below its published minimum of R15,000 per session/.test(w)), `${r.status} ${JSON.stringify(r.body)}`);

    // Hourly consultation totals: quantity is hours, VAT applies once.
    const qh = (await manual(1114, [{ service_id: hourlySvcId, quantity_minutes: 180 }])).body.booking_id;
    await sleep(50);
    r = await quote(qh, [{ service_id: hourlySvcId, description: 'Consultation', quantity: 3, unit_price: 2500 }]);
    qrow = await one('SELECT total_amount FROM quotations WHERE booking_id = ? ORDER BY id DESC LIMIT 1', [qh]);
    check('quote: 3 hours of consultation at R2,500 totals R7,500 ex VAT', r.status === 200 && qrow && qrow.total_amount === 7500, `${r.status} ${JSON.stringify(qrow)}`);
    const qh2 = (await manual(1115, [{ service_id: hourlySvcId, quantity_minutes: 180 }])).body.booking_id;
    await sleep(50);
    r = await quote(qh2, [{ service_id: hourlySvcId, description: 'Consultation', quantity: 3, unit_price: 2500 }], { apply_vat: true });
    qrow = await one('SELECT total_amount FROM quotations WHERE booking_id = ? ORDER BY id DESC LIMIT 1', [qh2]);
    check('quote: the same with VAT applied once is R8,625', r.status === 200 && qrow && qrow.total_amount === 8625, `${r.status} ${JSON.stringify(qrow)}`);

    // ═══ 6. Historical protection: editing a rate never rewrites a saved booking or quote ═══
    r = await mk({ default_price: 1000, pricing_model: 'flat_fee' });
    const histId = r.body.id;
    const hb = (await manual(1120, [{ service_id: histId }])).body.booking_id;
    await sleep(50);
    r = await quote(hb, [{ service_id: histId, description: 'Hist service', quantity: 1, unit_price: 1000 }]);
    check('historical setup: booking and quote issued at R1,000', r.status === 200, `${r.status} ${JSON.stringify(r.body)}`);
    const histBefore = JSON.stringify({
        bs: await q('SELECT unit_price, total_price FROM booking_services WHERE booking_id = ?', [hb]),
        bl: await q('SELECT quantity, unit_price FROM booking_line_items WHERE booking_id = ?', [hb]),
        ql: await q('SELECT quantity, unit_price FROM quote_line_items WHERE quotation_id IN (SELECT id FROM quotations WHERE booking_id = ?)', [hb]),
        qt: await q('SELECT total_amount FROM quotations WHERE booking_id = ?', [hb]),
        bk: await one('SELECT total_amount, quote_amount FROM bookings WHERE id = ?', [hb])
    });
    const histRow = await fetchOne(histId);
    r = await api('PUT', `/api/admin/services/${histId}`, oldUi(histRow, { default_price: 9999 }));
    check('the service fee is changed to R9,999', r.status === 200 && Number((await fetchOne(histId)).default_price) === 9999, `${r.status}`);
    const histAfter = JSON.stringify({
        bs: await q('SELECT unit_price, total_price FROM booking_services WHERE booking_id = ?', [hb]),
        bl: await q('SELECT quantity, unit_price FROM booking_line_items WHERE booking_id = ?', [hb]),
        ql: await q('SELECT quantity, unit_price FROM quote_line_items WHERE quotation_id IN (SELECT id FROM quotations WHERE booking_id = ?)', [hb]),
        qt: await q('SELECT total_amount FROM quotations WHERE booking_id = ?', [hb]),
        bk: await one('SELECT total_amount, quote_amount FROM bookings WHERE id = ?', [hb])
    });
    check('the saved booking, its line items, its quote lines and totals are unchanged', histBefore === histAfter, `${histBefore}\n${histAfter}`);
    const hb2 = (await manual(1121, [{ service_id: histId }])).body.booking_id;
    sn = await snap(hb2);
    check('a booking made after the change snapshots the new fee', sn.bs[0].unit_price === 9999 && sn.bk.total_amount === 9999, JSON.stringify(sn));

    await new Promise(res => rw.close(res));

    // ═══ 7. The migration itself, on synthetic legacy data (in-memory — never the live catalogue) ═══
    const rc = require('../lib/rate-card-2026');
    const memDb = () => new sqlite3.Database(':memory:');
    const mRun = (d, sql, p = []) => new Promise((res, rej) => d.run(sql, p, function (e) { e ? rej(e) : res(this); }));
    const mAll = (d, sql, p = []) => new Promise((res, rej) => d.all(sql, p, (e, rows) => e ? rej(e) : res(rows)));
    const mExec = (d, sql) => new Promise((res, rej) => d.exec(sql, e => e ? rej(e) : res()));
    // Schema + legacy rows go in as ONE exec (atomic on the connection) so a poller never sees tables without rows.
    const seedMem = async (d, { withAudit = true } = {}) => {
        const legacy = [
            ['Stand-Up Comedy – Short Set (15 min)', 8500, 'flat_fee', 'Performance', 'core', 1, 0],
            ['Stand-Up Comedy – Headline Set (60 min)', 35000, 'flat_fee', 'Performance', 'core', 1, 0],
            ['MC & Host – Full Day', 24950, 'flat_fee', 'Performance', 'core', 1, 0],
            ['MC & Host – Hourly Rate', 2950, 'per_hour', 'Performance', 'core', 1, 0],
            ['Travel Buyout – Gauteng', 2500, 'flat_fee', 'Travel', 'add-on', 1, 0],
            ['Accommodation – Single Night', 2200, 'flat_fee', 'Other', 'add-on', 1, 0],
            ['Archived thing', 500, 'flat_fee', 'Performance', 'core', 1, 1],
            ['Already inactive thing', 700, 'flat_fee', 'Performance', 'core', 0, 0]
        ];
        const inserts = legacy.map(([n, p, m, c, t, a, x]) => `INSERT INTO services (name, default_price, pricing_model, category, service_type, is_active, is_deleted) VALUES ('${n}', ${p}, '${m}', '${c}', '${t}', ${a}, ${x});`).join('\n');
        await mExec(d, `CREATE TABLE services (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT, default_price DECIMAL(10,2) NOT NULL,
            base_price DECIMAL(10,2), pricing_model TEXT DEFAULT 'flat_fee', min_quantity INTEGER DEFAULT 1, max_quantity INTEGER, display_unit TEXT DEFAULT 'unit',
            is_taxable BOOLEAN DEFAULT 1, tax_class TEXT DEFAULT 'standard', category TEXT, service_type TEXT DEFAULT 'core', is_active INTEGER DEFAULT 1,
            is_deleted INTEGER DEFAULT 0, setup_time_minutes INTEGER DEFAULT 0, availability_rule TEXT DEFAULT 'any_time', performance_length_minutes INTEGER DEFAULT 0,
            price_type TEXT DEFAULT 'fixed', price_min DECIMAL(10,2), price_max DECIMAL(10,2), price_unit TEXT, is_featured INTEGER DEFAULT 0, service_group TEXT);
            CREATE TABLE settings (id INTEGER PRIMARY KEY AUTOINCREMENT, setting_key TEXT UNIQUE NOT NULL, setting_value TEXT NOT NULL);
            CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL);` +
            (withAudit ? `CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, table_name TEXT NOT NULL, record_id INTEGER NOT NULL, action TEXT NOT NULL, changed_by TEXT, old_values TEXT, new_values TEXT, reason TEXT);` : '') +
            '\n' + inserts);
    };

    const m1 = memDb();
    await seedMem(m1);
    const legacyIds = Object.fromEntries((await mAll(m1, 'SELECT id, name FROM services')).map(x => [x.name, x.id]));
    const planned = rc.planRateCard(await mAll(m1, 'SELECT * FROM services'));
    check('plan: 3 clear mappings reused, 20 created, 1 old row deactivated, 2 add-ons kept',
        planned.summary.updated.length === 3 && planned.summary.created.length === 20 && planned.summary.deactivated.length === 1 && planned.summary.kept.length === 2, JSON.stringify(planned.summary));
    check('plan: archived and already-inactive rows are left alone', !planned.summary.deactivated.some(x => /Archived|inactive/.test(x.name)));
    await mExec(m1, planned.sql);
    const after = await mAll(m1, 'SELECT * FROM services');
    const live1 = after.filter(x => x.service_group && x.is_active && !x.is_deleted);
    eq('plan applied: exactly 23 live rate-card services', live1.length, 23);
    check('reused rows keep their ids and take the card name and fee',
        [['Stand-Up Comedy – Short Set (15 min)', 'Corporate – 15 min Comedic Performance', 28000], ['Stand-Up Comedy – Headline Set (60 min)', 'Corporate – 45–60 min Comedic Performance', 55000], ['MC & Host – Full Day', 'Corporate – MC Duties Full Day (6+ Hours)', 75000]]
            .every(([old, nu, fee]) => { const x = after.find(y => y.id === legacyIds[old]); return x && x.name === nu && x.default_price === fee && x.is_active === 1; }));
    check('the unmapped old row is deactivated (not deleted) and the add-ons are untouched',
        after.find(x => x.id === legacyIds['MC & Host – Hourly Rate']).is_active === 0
        && after.find(x => x.id === legacyIds['Travel Buyout – Gauteng']).is_active === 1 && after.find(x => x.id === legacyIds['Accommodation – Single Night']).default_price === 2200);
    check('archived / inactive rows are exactly as they were', after.find(x => x.name === 'Archived thing').is_deleted === 1 && after.find(x => x.name === 'Already inactive thing').is_active === 0);
    const a1 = await mAll(m1, `SELECT action, COUNT(*) c FROM audit_log GROUP BY action ORDER BY action`);
    check('every change is audited (20 create, 1 deactivate, 3 update)', JSON.stringify(a1) === JSON.stringify([{ action: 'RATE_CARD_2026_CREATE', c: 20 }, { action: 'RATE_CARD_2026_DEACTIVATE', c: 1 }, { action: 'RATE_CARD_2026_UPDATE', c: 3 }]), JSON.stringify(a1));
    const linked = await mAll(m1, `SELECT COUNT(*) c FROM audit_log a JOIN services s ON s.id = a.record_id WHERE a.action = 'RATE_CARD_2026_CREATE' AND json_extract(a.new_values, '$.name') = s.name`);
    eq('each create-audit row points at the row it created', linked[0].c, 20);
    const old = JSON.parse((await mAll(m1, `SELECT old_values FROM audit_log WHERE action = 'RATE_CARD_2026_UPDATE' AND record_id = ?`, [legacyIds['Stand-Up Comedy – Short Set (15 min)']]))[0].old_values);
    check('an update audit row keeps the old name and fee', old.name === 'Stand-Up Comedy – Short Set (15 min)' && old.default_price === 8500, JSON.stringify(old));
    check('settings and the applied marker are written in the same transaction', (await mAll(m1, 'SELECT COUNT(*) c FROM settings'))[0].c === 6 && (await mAll(m1, 'SELECT COUNT(*) c FROM schema_migrations WHERE version = 106'))[0].c === 1);
    const replan = rc.planRateCard(after);
    check('planning again over the migrated rows creates and deactivates nothing', replan.summary.created.length === 0 && replan.summary.deactivated.length === 0 && replan.summary.updated.length === 23, JSON.stringify(replan.summary));
    let doneArgs = null;
    await new Promise(res => rc.applyOnce(m1, (e, s) => { doneArgs = [e, s]; res(); }));
    check('applyOnce skips a database that already carries the marker', doneArgs[0] === null && doneArgs[1] === null && (await mAll(m1, 'SELECT COUNT(*) c FROM services'))[0].c === after.length);

    // Atomicity: a failure part-way through must leave the old catalogue exactly as it was.
    const m2 = memDb();
    await seedMem(m2, { withAudit: false }); // no audit_log table => the script fails on its first audit insert, after the first UPDATE ran
    const snap2 = JSON.stringify(await mAll(m2, 'SELECT * FROM services ORDER BY id'));
    let applyErr = null;
    try { await rc.applyRateCard(m2); } catch (e) { applyErr = e; }
    check('a failing migration reports the error', !!applyErr && /audit_log/.test(applyErr.message), applyErr && applyErr.message);
    check('...and has rolled back completely (no reused row renamed, nothing created or deactivated)', JSON.stringify(await mAll(m2, 'SELECT * FROM services ORDER BY id')) === snap2);
    check('...and no marker or settings were left behind', (await mAll(m2, 'SELECT COUNT(*) c FROM schema_migrations'))[0].c === 0 && (await mAll(m2, 'SELECT COUNT(*) c FROM settings'))[0].c === 0);
    let stuck = null;
    try { await mExec(m2, 'BEGIN IMMEDIATE; COMMIT;'); } catch (e) { stuck = e; }
    check('...and the connection is not left inside an open transaction', stuck === null, stuck && stuck.message);
    const m3 = memDb();
    await seedMem(m3);
    await mRun(m3, "UPDATE services SET name = 'MC &amp; Host – Full Day' WHERE name = 'MC & Host – Full Day'");
    const p3 = rc.planRateCard(await mAll(m3, 'SELECT * FROM services'));
    check('a legacy name saved entity-encoded ("MC &amp; Host") is still recognised and reused',
        p3.summary.updated.some(x => /Full Day/.test(x.from) && /MC Duties Full Day/.test(x.to)) && p3.summary.updated.length === 3, JSON.stringify(p3.summary.updated));

    // Timing: init of a brand-new database is still creating tables when the migration is first called, and
    // another transaction may be open — the migration must wait for both, and never roll back what is not its own.
    const m4 = memDb(); // completely empty: no tables yet
    let r4 = null;
    const p4 = new Promise(res => rc.applyOnce(m4, (e, s) => { r4 = [e, s]; res(); }));
    await sleep(700);
    check('a database that is still being created: the migration waits (neither fails nor finishes early)', r4 === null, JSON.stringify(r4));
    await seedMem(m4); // the schema and the legacy rows now appear
    await p4;
    check('...then applies the rate card as soon as the schema exists', r4[0] === null && r4[1] && r4[1].created.length === 20 && r4[1].updated.length === 3, JSON.stringify(r4));
    eq('...and exactly 23 rate-card services are live', (await mAll(m4, 'SELECT COUNT(*) c FROM services WHERE service_group IS NOT NULL AND is_active = 1'))[0].c, 23);

    const m5 = memDb();
    await seedMem(m5);
    await mRun(m5, 'BEGIN');
    await mRun(m5, "INSERT INTO settings (setting_key, setting_value) VALUES ('probe', 'kept')");
    let r5 = null;
    const p5 = new Promise(res => rc.applyOnce(m5, (e, s) => { r5 = [e, s]; res(); }));
    await sleep(700);
    check('another transaction is open: the migration holds off (nothing applied yet)',
        r5 === null && (await mAll(m5, 'SELECT COUNT(*) c FROM services WHERE service_group IS NOT NULL'))[0].c === 0, JSON.stringify(r5));
    await mRun(m5, 'COMMIT');
    check('...and it did not roll back the other transaction (its write survived)', (await mAll(m5, "SELECT setting_value v FROM settings WHERE setting_key = 'probe'")).length === 1);
    await p5;
    check('...then applies once that transaction has ended', r5[0] === null && r5[1] && r5[1].created.length === 20, JSON.stringify(r5));

    for (const d of [m1, m2, m3, m4, m5]) await new Promise(res => d.close(res));
    for (const id of createdIds) await api('DELETE', `/api/admin/services/${id}`);   // soft-archive: gone from every list, history intact
};
