// Rate card 2026, Phase 4: who sees which price.
//   A. the PUBLIC site never learns a price (services API = an allowlist, in rate-card order, with the group + Most Booked);
//   B. the public tracking response withholds every amount until a quotation has been sent;
//   C. the pricing conditions ride on the quotation PDF and the quotation emails (and follow the quote: VAT shown or not,
//      individually priced lines, validity only while the rate card is valid);
//   D. the admin meta + rate-card validity endpoints (and their roles);
//   E. saving a service from the admin form keeps the fields the form no longer sends.
// The admin screens themselves are driven in a real browser by test/browser/service-pricing.js.
const sp = require('../lib/service-pricing');
const pc = require('../lib/pricing-conditions');
const bt = require('../lib/booking-tracking');

let seq = 0;
const email = () => `svcvis.${Date.now()}.${seq++}@example.invalid`;
const uniq = () => `ZZ-VIS ${Date.now().toString(36)}${seq++}`;

module.exports = async function ({ check, api, pub, apiBinary, one, q, future, sleep, loginAs, getTrackingToken, extractPdfText }) {
    const eq = (name, got, want) => check(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

    // ═══ 0. Pure rules ═══
    const lines = pc.buildQuotationConditions;
    const base = { validUntil: '2026-12-31', today: '2026-10-18' };
    check('conditions: currency, VAT-not-added, travel exclusion and validity (in that order) for a plain quotation',
        JSON.stringify(lines(base)) === JSON.stringify([
            'All amounts are in South African rand (ZAR).',
            'VAT is not included in the amounts above.',
            'Fees exclude travel, accommodation and rider unless they are itemised in this quotation.',
            'Rates are valid until 31 December 2026.']), JSON.stringify(lines(base)));
    check('conditions: with VAT the sentence says VAT is added in the totals, at the real rate',
        lines({ ...base, applyVat: true })[1] === 'Fees exclude VAT. VAT at 15% is added in the totals above.' && lines({ ...base, applyVat: true, vatRate: 0.14 })[1] === 'Fees exclude VAT. VAT at 14% is added in the totals above.');
    check('conditions: a quote with an individually priced line gets the plain-language note', lines({ ...base, individuallyQuoted: true }).some(l => /priced individually for each engagement/.test(l)) && !lines(base).some(l => /individually/.test(l)));
    check('conditions: the validity sentence is dropped once the rate card has expired, kept on its last day',
        !lines({ ...base, today: '2027-01-01' }).some(l => /valid until/.test(l)) && lines({ ...base, today: '2026-12-31' }).some(l => /valid until 31 December 2026/.test(l)));
    check('conditions: no validity date set -> no validity sentence; garbage date ignored', !lines({ today: '2026-10-18' }).some(l => /valid until/.test(l)) && !lines({ ...base, validUntil: 'soon' }).some(l => /valid until/.test(l)));
    check('conditions: nothing but the four facts - no discount, deposit or payment-term wording', !lines({ ...base, applyVat: true, individuallyQuoted: true }).some(l => /discount|deposit|payment term|surcharge|cancel/i.test(l)));
    eq('email block: empty input renders nothing', pc.conditionsHtml([]), '');
    check('email block: renders every line, escaped', /Pricing conditions/.test(pc.conditionsHtml(['a & b <c>'])) && /a &amp; b &lt;c&gt;/.test(pc.conditionsHtml(['a & b <c>'])));
    check('prices are revealed only after a quotation: statuses and quote count',
        !bt.pricesRevealed({ status: 'NEW', quoteVersionCount: 0 }) && !bt.pricesRevealed({ status: 'PENDING' }) && !bt.pricesRevealed({ status: 'REVIEWED', quoteVersionCount: 0 })
        && bt.pricesRevealed({ status: 'QUOTED' }) && bt.pricesRevealed({ status: 'accepted' }) && bt.pricesRevealed({ status: 'CONFIRMED' }) && bt.pricesRevealed({ status: 'COMPLETED' })
        && bt.pricesRevealed({ status: 'CANCELLED', quoteVersionCount: 2 }) && !bt.pricesRevealed({ status: 'CANCELLED', quoteVersionCount: 0 }) && !bt.pricesRevealed());
    const pubRow = sp.toPublicService({ id: 1, name: 'X', default_price: 999, base_price: 5, price_type: 'range', price_min: 1, financial_category: 'PERFORMANCE_REV', revenue_gl_code: '4001', pricing_model: 'flat_fee', service_group: 'corporate_events', is_featured: 1 });
    check('public view: the allowlist drops every price and accounting field and adds the group label', !('default_price' in pubRow) && !('base_price' in pubRow) && !('price_type' in pubRow)
        && !('financial_category' in pubRow) && !('revenue_gl_code' in pubRow) && pubRow.service_group_label === 'Corporate & Events' && pubRow.is_featured === true && pubRow.is_flat === true, JSON.stringify(pubRow));

    const idOf = async (name) => (await one('SELECT id FROM services WHERE name = ?', [name])).id;

    // ═══ A. The public site never learns a price ═══
    let r = await pub('GET', '/api/public/services');
    const rows = Array.isArray(r.body) ? r.body : [];
    check('public services API answers with the catalogue', r.status === 200 && rows.length >= 23, `${r.status} rows=${rows.length}`);
    const keys = new Set(rows.flatMap(x => Object.keys(x)));
    const ALLOWED = ['id', 'name', 'description', 'pricing_model', 'is_flat', 'min_quantity', 'max_quantity', 'display_unit', 'setup_time_minutes', 'performance_length_minutes',
        'travel_included', 'availability_rule', 'booking_lead_time_days', 'service_group', 'service_group_label', 'is_featured'];
    check('the public payload carries exactly the allowlisted fields (no price, no price type, no GL code, no tax or cost field)', [...keys].sort().join() === ALLOWED.slice().sort().join(), JSON.stringify([...keys].sort()));
    const stripped = JSON.stringify(rows.map(({ name, description, service_group_label, ...rest }) => rest));
    check('no published fee appears anywhere in the public payload as a value', !/\b(2500|5000|10000|12000|15000|18000|28000|30000|35000|42000|45000|50000|55000|60000|65000|75000|90000|140000)\b/.test(stripped), stripped.slice(0, 200));
    const catalogue = rows.filter(x => !/^ZZ-/.test(x.name));   // other test files leave fixture services (ZZ-...) in this shared DB
    const grouped = catalogue.filter(x => x.service_group);
    eq('the 23 rate-card services are in the public list, with their group labels', grouped.filter(x => x.service_group_label).length, 23);
    const order = Object.keys(sp.GROUPS);
    const ranks = rows.map(x => { const i = order.indexOf(x.service_group); return i === -1 ? 99 : i; });
    check('services come in rate-card group order, add-ons / ungrouped last', ranks.every((v, i) => i === 0 || v >= ranks[i - 1]), JSON.stringify(ranks));
    const featured = catalogue.filter(x => x.is_featured);
    check('"Most Booked" is on the 7 Corporate & Events services and nowhere else', featured.length === 7 && featured.every(x => x.service_group === 'corporate_events'), JSON.stringify(featured.map(x => x.name)));
    check('service 15 (the booking-form tests\' service) is still offered', rows.some(x => x.id === 15));
    check('deactivated services are not offered publicly', !rows.some(x => /Hourly Rate|Comedy Roast/.test(x.name)));

    // ═══ B. Amounts reach the client only after a quotation is sent ═══
    const fixedId = await idOf('Club – 10 min Set (Guest Spot)');       // fixed R5,000
    const rangeId = await idOf('Writing – Copywriting / Roast Writing / Joke Pack');
    const mk = (days, services, em) => api('POST', '/api/admin/bookings', {
        name: 'Svc Vis IT', email: em, cell: '+27821234567', event_date: future(days), event_name: 'Svc Vis Event', event_type: 'Corporate',
        event_location: 'Test Hall', message: 'Service visibility integration test, over ten characters.', services, status: 'NEW', override_working_hours: true
    });
    const track = async (id, em) => pub('POST', `/api/public/bookings/${id}/track`, { access_token: await getTrackingToken(id, em) });
    const quote = async (id, items, over = {}) => {
        const bk = await one('SELECT date FROM bookings WHERE id = ?', [id]);
        const expiry = new Date(Date.parse(bk.date) - 10 * 86400000).toISOString().slice(0, 10);
        return api('POST', `/api/admin/bookings/${id}/quote`, { quote_expiry_date: expiry, terms: 'Standard terms apply.', apply_vat: false, discount: 0, items, ...over });
    };

    const em1 = email();
    const b1 = (await mk(1200, [{ service_id: fixedId }], em1)).body.booking_id;
    await sleep(50);
    r = await track(b1, em1);
    const pre = r.body || {};
    check('before a quotation: tracking succeeds and shows the booking', r.status === 200 && pre.success && pre.booking && pre.booking.id === b1 && pre.booking.status === 'NEW', `${r.status} ${JSON.stringify(pre).slice(0, 200)}`);
    check('before a quotation: no quote amount, quote details, expiry, total or outstanding balance is sent',
        pre.booking.quote_amount === null && pre.booking.quote_details === null && pre.booking.quote_expiry_date === null && pre.booking.total_amount === null && pre.booking.amount_outstanding === null, JSON.stringify(pre.booking));
    check('before a quotation: the service lines carry no unit price or line total',
        Array.isArray(pre.services) && pre.services.length === 1 && !('unit_price' in pre.services[0]) && !('line_total' in pre.services[0]) && !!pre.services[0].service_name, JSON.stringify(pre.services));
    check('before a quotation: the response contains the fee nowhere', !/5000/.test(JSON.stringify(pre)), JSON.stringify(pre).slice(0, 300));

    const em2 = email();
    const b2 = (await mk(1201, [{ service_id: rangeId }], em2)).body.booking_id;
    await sleep(50);
    r = await track(b2, em2);
    check('a booking for an individually priced service shows no amount either before its quote', r.status === 200 && r.body.booking.total_amount === null && r.body.booking.quote_amount === null && !('unit_price' in r.body.services[0]), JSON.stringify(r.body).slice(0, 300));

    // pin the rate-card validity so the conditions below are independent of today's date (the original is restored at the end)
    const originalValidity = (((await api('GET', '/api/admin/services/meta')).body || {}).rate_card || {}).valid_until || null;
    r = await api('PUT', '/api/admin/services/rate-card', { valid_until: '2099-12-31' });
    eq('fixture: rate-card validity set far ahead', r.status, 200);

    let qr = await quote(b1, [{ service_id: fixedId, description: 'Club – 10 min Set (Guest Spot)', quantity: 1, unit_price: 5000 }]);
    eq('the quotation is issued', qr.status, 200);
    r = await track(b1, em1);
    const post = r.body || {};
    check('after the quotation: the quote amount, details, expiry and total are sent', post.booking.quote_amount === '5000.00' && !!post.booking.quote_details && !!post.booking.quote_expiry_date && post.booking.total_amount === 5000, JSON.stringify(post.booking));
    check('after the quotation: the service lines carry their snapshot prices', post.services.length === 1 && post.services[0].unit_price === 5000 && post.services[0].line_total === 5000, JSON.stringify(post.services));
    check('after the quotation: the client still sees the quotation in the booking status (QUOTED)', post.booking.status === 'QUOTED' && post.quote_version_count >= 1, `${post.booking.status} ${post.quote_version_count}`);

    // ═══ C. Pricing conditions ride on the quotation PDF and the quotation emails ═══
    const pdfText = async (id) => extractPdfText((await apiBinary('GET', `/api/admin/bookings/${id}/quote/download`)).buffer);
    let txt = await pdfText(b1);
    check('quotation PDF: a PRICING CONDITIONS section is printed', /PRICING CONDITIONS/.test(txt), txt.slice(-600));
    check('quotation PDF: currency, VAT-not-added, travel/accommodation/rider and validity are all stated',
        txt.includes('All amounts are in South African rand (ZAR).') && txt.includes('VAT is not included in the amounts above.')
        && txt.includes('Fees exclude travel, accommodation and rider unless they are itemised in this quotation.') && txt.includes('Rates are valid until 31 December 2099.'), txt.slice(-700));
    check('quotation PDF: no individually-priced note on a fixed-price quotation', !/priced individually/.test(txt));
    const pos = (s) => txt.indexOf(s);
    check('quotation PDF: the conditions sit between the totals and the terms', pos('TOTAL AMOUNT') > -1 && pos('PRICING CONDITIONS') > pos('TOTAL AMOUNT') && pos('TERMS & CONDITIONS') > pos('PRICING CONDITIONS'), `${pos('TOTAL AMOUNT')} ${pos('PRICING CONDITIONS')} ${pos('TERMS & CONDITIONS')}`);

    let mail = null;
    for (let i = 0; i < 50 && !mail; i++) {
        mail = await one("SELECT body FROM notifications WHERE type='email' AND subject = ? AND recipient_email = ? ORDER BY id DESC LIMIT 1", [`Quotation for Booking #${b1}`, em1]);
        if (!mail) await sleep(100);
    }
    check('quotation email: carries the same pricing conditions', !!mail && /Pricing conditions/.test(mail.body) && /All amounts are in South African rand \(ZAR\)\./.test(mail.body)
        && /VAT is not included in the amounts above\./.test(mail.body) && /Rates are valid until 31 December 2099\./.test(mail.body), mail && mail.body.slice(0, 300));

    // resend-quote rebuilds the conditions from the stored quote (no items on hand)
    r = await api('POST', `/api/admin/bookings/${b1}/resend-quote`, {});
    eq('resend-quote succeeds', r.status, 200);
    let mail2 = null;
    for (let i = 0; i < 50 && !mail2; i++) {
        const all = await q("SELECT id, body FROM notifications WHERE type='email' AND subject = ? AND recipient_email = ? ORDER BY id DESC", [`Quotation for Booking #${b1}`, em1]);
        if (all.length >= 2) mail2 = all[0];
        else await sleep(100);
    }
    check('resent quotation email: still carries the conditions', !!mail2 && /Pricing conditions/.test(mail2.body) && /VAT is not included in the amounts above\./.test(mail2.body), mail2 && mail2.body.slice(0, 200));

    // VAT shown on the quotation -> the sentence says so
    const em3 = email();
    const b3 = (await mk(1202, [{ service_id: fixedId }], em3)).body.booking_id;
    await sleep(50);
    qr = await quote(b3, [{ service_id: fixedId, description: 'Club – 10 min Set (Guest Spot)', quantity: 1, unit_price: 5000 }], { apply_vat: true });
    eq('quotation with VAT is issued', qr.status, 200);
    txt = await pdfText(b3);
    check('quotation PDF with VAT: says VAT at 15% is added in the totals (and not "not included")', txt.includes('Fees exclude VAT. VAT at 15% is added in the totals above.') && !txt.includes('VAT is not included'), txt.slice(-700));
    check('quotation PDF with VAT: the total really is R5,750.00 (VAT once)', /5\s?750\.00/.test(txt), txt.slice(-900));

    // an individually priced line -> the plain-language note, on the PDF and in the email
    const em4 = email();
    const b4 = (await mk(1203, [{ service_id: rangeId }], em4)).body.booking_id;
    await sleep(50);
    qr = await quote(b4, [{ service_id: rangeId, description: 'Joke pack', quantity: 1, unit_price: 15000 }]);
    eq('quotation with an individually priced line is issued', qr.status, 200);
    txt = await pdfText(b4);
    check('quotation PDF: the individually-priced note appears', /priced individually for each engagement/.test(txt), txt.slice(-800));
    let mail4 = null;
    for (let i = 0; i < 50 && !mail4; i++) {
        mail4 = await one("SELECT body FROM notifications WHERE type='email' AND subject = ? AND recipient_email = ? ORDER BY id DESC LIMIT 1", [`Quotation for Booking #${b4}`, em4]);
        if (!mail4) await sleep(100);
    }
    check('quotation email: the individually-priced note appears too', !!mail4 && /priced individually for each engagement/.test(mail4.body), mail4 && mail4.body.slice(0, 200));

    // once the rate card has expired, the validity sentence is gone (everything else stays)
    r = await api('PUT', '/api/admin/services/rate-card', { valid_until: '2020-01-01' });
    eq('fixture: rate-card validity moved into the past', r.status, 200);
    const em5 = email();
    const b5 = (await mk(1204, [{ service_id: fixedId }], em5)).body.booking_id;
    await sleep(50);
    qr = await quote(b5, [{ service_id: fixedId, description: 'Club – 10 min Set (Guest Spot)', quantity: 1, unit_price: 5000 }]);
    eq('quotation after expiry is issued', qr.status, 200);
    txt = await pdfText(b5);
    check('quotation PDF after the rate card expired: no validity sentence, the other conditions remain', !/Rates are valid until/.test(txt) && txt.includes('All amounts are in South African rand (ZAR).') && /PRICING CONDITIONS/.test(txt), txt.slice(-700));
    await api('PUT', '/api/admin/services/rate-card', { valid_until: '2099-12-31' });

    // ═══ D. Admin meta + rate-card validity ═══
    r = await api('GET', '/api/admin/services/meta');
    const meta = r.body || {};
    check('meta: the five price types, five units and five rate-card groups, with hints and the Most Booked group',
        r.status === 200 && meta.price_types.length === 5 && meta.price_types.every(t => t.label && t.hint) && meta.price_units.length === 5 && meta.groups.length === 5
        && meta.groups.filter(g => g.featured).length === 1 && meta.groups.find(g => g.featured).value === 'corporate_events' && meta.groups.map(g => g.label).includes('Writing & Creative Services'), JSON.stringify(meta).slice(0, 300));
    check('meta: rate-card block has title, updated, currency and validity', !!meta.rate_card && meta.rate_card.currency === 'ZAR' && /Booking Kit 2026/.test(meta.rate_card.title) && meta.rate_card.updated === 'September 2026' && meta.rate_card.valid_until === '2099-12-31' && meta.rate_card.expired === false && meta.rate_card.days_left > 1000, JSON.stringify(meta.rate_card));
    r = await api('PUT', '/api/admin/services/rate-card', { valid_until: '2020-01-01' });
    check('rate-card validity: a past date is accepted and the meta reports it expired', r.status === 200 && r.body.rate_card.expired === true && r.body.rate_card.days_left < 0, JSON.stringify(r.body));
    r = await api('PUT', '/api/admin/services/rate-card', { valid_until: '31 December 2027' });
    check('rate-card validity: a non-ISO / unreal date is refused', r.status === 400 && /real date/.test(r.body.error || ''), JSON.stringify(r.body));
    r = await api('PUT', '/api/admin/services/rate-card', { valid_until: '2027-02-31' });
    eq('rate-card validity: 31 February is refused', r.status, 400);
    r = await api('PUT', '/api/admin/services/rate-card', {});
    eq('rate-card validity: a missing date is refused', r.status, 400);
    r = await api('PUT', '/api/admin/services/rate-card', { valid_until: '2027-12-31' });
    check('rate-card validity: a good date is saved and returned', r.status === 200 && r.body.rate_card.valid_until === '2027-12-31' && r.body.rate_card.expired === false, JSON.stringify(r.body));
    const aud = await one("SELECT old_values, new_values, changed_by FROM audit_log WHERE table_name='settings' AND action='RATE_CARD_VALIDITY_UPDATE' ORDER BY id DESC LIMIT 1");
    check('rate-card validity: the change is audited with old and new date', !!aud && /2020-01-01/.test(aud.old_values) && /2027-12-31/.test(aud.new_values) && !!aud.changed_by, JSON.stringify(aud));
    const asAssistant = await loginAs('assistant');
    const asManager = await loginAs('manager');
    eq('rate-card validity: an assistant cannot change it (403)', (await asAssistant('PUT', '/api/admin/services/rate-card', { valid_until: '2028-01-01' })).status, 403);
    eq('rate-card validity: a manager can', (await asManager('PUT', '/api/admin/services/rate-card', { valid_until: '2027-12-31' })).status, 200);
    eq('meta: an assistant can read it (like the services list)', (await asAssistant('GET', '/api/admin/services/meta')).status, 200);
    eq('meta: unauthenticated -> 401', (await pub('GET', '/api/admin/services/meta')).status, 401);
    const setting = await one("SELECT setting_value FROM settings WHERE setting_key = 'rate_card_valid_until'");
    eq('the stored setting is the date the quotation conditions read', setting.setting_value, '2027-12-31');

    // ═══ E. Saving from the admin form keeps what the form no longer sends ═══
    const name = uniq();
    r = await api('POST', '/api/admin/services', {
        name, description: 'adv', category: 'Production', default_price: 1500, is_taxable: true, is_active: true, service_type: 'core',
        revenue_gl_code: '4001', crew_required: 3, financial_category: 'PRODUCTION', item_category: 'ABCD', legacy_code: 'LEG-1', marketing_segment: 'CORPORATE',
        tax_category: 'EXEMPT', fulfillment_type: 'remote', cost_center: 'CC-9', profit_center: 'PC-9', is_capital_asset: true, base_uom: 'hr', sac_code: '9999', preferred_resource_id: null
    });
    const advId = r.body && r.body.id;
    eq('fixture: a service with accounting fields is created', r.status, 200);
    const ADV_COLS = 'revenue_gl_code, crew_required, financial_category, item_category, legacy_code, marketing_segment, tax_category, fulfillment_type, cost_center, profit_center, is_capital_asset, base_uom, sac_code, is_deleted';
    const advBefore = JSON.stringify(await one(`SELECT ${ADV_COLS} FROM services WHERE id = ?`, [advId]));
    // exactly what the admin form sends today: no Advanced / Financial fields at all
    r = await api('PUT', `/api/admin/services/${advId}`, {
        name, description: 'edited', default_price: 1750, category: 'Production', pricing_model: 'flat_fee', display_unit: 'unit', min_quantity: 1, max_quantity: null,
        is_taxable: true, is_active: true, service_type: 'core', pricing_group: 'Standard', availability_rule: 'any_time', booking_lead_time_days: 0,
        setup_time_minutes: 0, performance_length_minutes: 0, tax_class: 'standard', travel_included: false, base_price: null, internal_note: null, external_note: null, valid_from: null, valid_to: null,
        price_type: 'fixed', price_min: null, price_max: null, price_unit: null, service_group: null, is_featured: false
    });
    eq('a save from the current admin form (no Advanced fields) succeeds', r.status, 200);
    const advAfter = JSON.stringify(await one(`SELECT ${ADV_COLS} FROM services WHERE id = ?`, [advId]));
    check('...and the accounting / financial fields it does not send are exactly as they were', advBefore === advAfter && /"revenue_gl_code":"4001"/.test(advAfter) && /"crew_required":3/.test(advAfter), `${advBefore}\n${advAfter}`);
    check('...while the edited fields did change', Number((await one('SELECT default_price FROM services WHERE id = ?', [advId])).default_price) === 1750);
    r = await api('PUT', `/api/admin/services/${advId}`, { name, default_price: 1750, category: 'Production', is_deleted: 1 });
    check('an explicit is_deleted still archives', r.status === 200 && (await one('SELECT is_deleted FROM services WHERE id = ?', [advId])).is_deleted === 1);
    r = await api('PUT', `/api/admin/services/${advId}`, { name, default_price: 1750, category: 'Production' });
    check('an edit that does not mention is_deleted does not un-archive it', r.status === 200 && (await one('SELECT is_deleted FROM services WHERE id = ?', [advId])).is_deleted === 1);
    if (originalValidity) await api('PUT', '/api/admin/services/rate-card', { valid_until: originalValidity });
};
