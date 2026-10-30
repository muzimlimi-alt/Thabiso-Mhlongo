// Event ticketing - the rules that need no server (lib/ticketing-core.js): money in integer cents, random tokens, tier and buyer
// validation, when a tier is on sale, what a reservation may contain, and CSV cells that can never become spreadsheet formulas.
// lib/ticketing-core.js opens no database, so it is safe to require here (lib files that do must never be required from a test).
const core = require('../lib/ticketing-core');

module.exports = async function ({ check }) {
    // ═══ money ═══
    const p = core.parseRandsToCents;
    check('money: rands in every shape an admin types become integer cents',
        p('150') === 15000 && p('150.5') === 15050 && p('R 1 500,00') === 150000 && p('1,500.00') === 150000 && p(150) === 15000 && p('R150.05') === 15005,
        JSON.stringify([p('150'), p('150.5'), p('R 1 500,00'), p('1,500.00'), p(150), p('R150.05')]));
    check('money: anything that is not a clean amount is refused (no silent rounding of 3 decimals, no negatives, no text)',
        p('150.555') === null && p('-5') === null && p('abc') === null && p('') === null && p(null) === null, '');
    check('money: cents -> PayFast amount string without floating point (0.1 + 0.2 never appears)',
        core.centsToAmountString(15000) === '150.00' && core.centsToAmountString(5) === '0.05' && core.centsToAmountString(1234567) === '12345.67', core.centsToAmountString(5));
    check('money: PayFast\'s amount_gross back to cents, exactly; malformed amounts are null',
        core.amountStringToCents('150.00') === 15000 && core.amountStringToCents('150') === 15000 && core.amountStringToCents('150.001') === null && core.amountStringToCents('R150') === null, '');
    check('money: formatted for buyers as R with grouped rands', core.formatZar(150000) === 'R 1 500.00' && core.formatZar(500) === 'R 5.00', core.formatZar(150000));

    // ═══ tokens ═══
    const toks = new Set(Array.from({ length: 2000 }, () => core.randomToken()));
    check('tokens: 2000 fresh tokens are all different and all 24 base64url characters (144 random bits)',
        toks.size === 2000 && [...toks].every(core.isTokenShape), [...toks][0]);
    check('tokens: the shape check refuses ids, short strings, padding and other alphabets',
        !core.isTokenShape('12345') && !core.isTokenShape('a'.repeat(23)) && !core.isTokenShape('a'.repeat(22) + '==') && !core.isTokenShape('a'.repeat(23) + '/') && !core.isTokenShape(null), '');
    check('PayFast reference: a ticket order is TKT_<id> and parses back; a booking reference is never mistaken for one',
        core.mPaymentIdFor(42) === 'TKT_42' && core.orderIdFromPaymentId('TKT_42') === 42 && core.orderIdFromPaymentId('100054_DEPOSIT') === null
        && !core.isTicketPaymentId('100054_SCHED7') && core.orderIdFromPaymentId('TKT_0') === null && core.orderIdFromPaymentId('TKT_4x') === null, '');

    // ═══ tiers ═══
    const goodTier = { name: 'General', description: 'Standing', price: '150', capacity: '200', max_per_order: '8', sales_start: '', sales_end: '2099-01-01T18:00', is_active: true };
    const v = core.validateTier(goodTier);
    check('tier: an ordinary tier validates and the price is stored in cents', Object.keys(v.errors).length === 0 && v.clean.price_cents === 15000 && v.clean.capacity === 200 && v.clean.max_per_order === 8 && v.clean.is_active === 1, JSON.stringify(v));
    check('tier: sales times are Johannesburg wall time stored as UTC (18:00 SAST = 16:00Z)', v.clean.sales_end === '2099-01-01T16:00:00.000Z' && v.clean.sales_start === null, v.clean.sales_end);
    check('tier: the entity-encoded form a request arrives in is stored as plain text', core.validateTier({ ...goodTier, name: 'VIP &amp; Meet' }).clean.name === 'VIP & Meet', '');
    const bad = (patch) => Object.keys(core.validateTier({ ...goodTier, ...patch }).errors);
    check('tier: under PayFast\'s R5 minimum, zero capacity, a per-order limit over 20 and markup are all refused',
        bad({ price: '4.99' }).includes('price') && bad({ capacity: '0' }).includes('capacity') && bad({ max_per_order: '21' }).includes('max_per_order') && bad({ name: '<b>VIP</b>' }).includes('name'), '');
    check('tier: sales must end after they start', bad({ sales_start: '2099-01-02T10:00', sales_end: '2099-01-01T10:00' }).includes('sales_end'), '');

    // ═══ when a tier is on sale ═══
    const now = new Date('2030-06-01T10:00:00Z');
    const ev = { event_id: 7, event_datetime: '2030-06-10T20:00', event_status: 'upcoming', booking_id: null };
    const tier = { id: 1, event_id: 7, name: 'General', price_cents: 15000, capacity: 10, sold: 4, reserved: 2, is_active: 1, max_per_order: 4, sales_start: null, sales_end: null };
    check('state: an active tier with places left is on sale; remaining = capacity - sold - reserved', core.tierState(tier, ev, now) === 'on_sale' && core.remainingOf(tier) === 4, '');
    check('state: sold + reserved = capacity is sold out (held tickets count)', core.tierState({ ...tier, sold: 8, reserved: 2 }, ev, now) === 'sold_out', '');
    check('state: closed tier, sales not started, sales ended', core.tierState({ ...tier, is_active: 0 }, ev, now) === 'closed'
        && core.tierState({ ...tier, sales_start: '2030-06-02T00:00:00.000Z' }, ev, now) === 'not_started' && core.tierState({ ...tier, sales_end: '2030-06-01T09:00:00.000Z' }, ev, now) === 'ended', '');
    check('state: a cancelled, postponed or draft event, a started show, an undated event and a client booking all sell nothing',
        ['cancelled', 'postponed', 'draft'].every(s => core.tierState(tier, { ...ev, event_status: s }, now) === 'closed')
        && core.tierState(tier, { ...ev, event_datetime: '2030-06-01T11:00' }, new Date('2030-06-01T09:30:00Z')) === 'closed'   // 11:00 SAST = 09:00Z
        && core.tierState(tier, { ...ev, event_datetime: null }, now) === 'closed' && core.tierState(tier, { ...ev, booking_id: 55 }, now) === 'closed', '');
    check('summary: no tiers -> null (the card keeps its external ticket link)', core.eventSummary([], ev, now) === null, '');
    check('summary: on sale from the cheapest on-sale tier; all gone -> sold out; none open -> closed / opens later',
        JSON.stringify(core.eventSummary([tier, { ...tier, id: 2, price_cents: 9000 }, { ...tier, id: 3, price_cents: 5000, sold: 10, reserved: 0 }], ev, now)) === JSON.stringify({ state: 'on_sale', from_cents: 9000, opens_at: null })
        && core.eventSummary([{ ...tier, sold: 10, reserved: 0 }], ev, now).state === 'sold_out'
        && core.eventSummary([{ ...tier, is_active: 0 }], ev, now).state === 'closed'
        && core.eventSummary([{ ...tier, sales_start: '2030-06-05T08:00:00.000Z' }], ev, now).opens_at === '2030-06-05T08:00:00.000Z', '');
    const pt = core.publicTier(tier, ev, now);
    check('public tier: buyers see price, remaining and limit, never the sold / reserved internals', pt.remaining === 4 && !('sold' in pt) && !('reserved' in pt) && !('capacity' in pt), JSON.stringify(pt));

    // ═══ a reservation ═══
    const byId = new Map([[1, tier], [2, { ...tier, id: 2, name: 'VIP', price_cents: 50000, max_per_order: 2 }]]);
    const r = core.validateReservation([{ ticket_type_id: 1, quantity: 2 }, { ticket_type_id: 2, quantity: 1 }, { ticket_type_id: 1, quantity: 1 }], byId, ev, now);
    check('reservation: lines merge per tier and take the price from the TIER ROW', r.errors.length === 0 && r.lines.length === 2 && r.lines[0].quantity === 3 && r.lines[0].unit_price_cents === 15000 && core.orderTotalCents(r.lines) === 95000, JSON.stringify(r));
    check('reservation: a price sent by the client is ignored', core.validateReservation([{ ticket_type_id: 1, quantity: 1, unit_price_cents: 1 }], byId, ev, now).lines[0].unit_price_cents === 15000, '');
    const rerr = (items, e = ev) => core.validateReservation(items, byId, e, now).errors.map(x => x.code);
    check('reservation: over the tier limit, an unknown tier, nothing chosen, a negative or fractional quantity are refused',
        rerr([{ ticket_type_id: 2, quantity: 3 }]).includes('over_limit') && rerr([{ ticket_type_id: 99, quantity: 1 }]).includes('unknown_tier') && rerr([]).includes('empty')
        && rerr([{ ticket_type_id: 1, quantity: 0 }]).includes('empty') && rerr([{ ticket_type_id: 1, quantity: -1 }]).includes('bad_item') && rerr([{ ticket_type_id: 1, quantity: 1.5 }]).includes('bad_item'), '');
    check('reservation: a tier of ANOTHER event cannot be bought through this one', rerr([{ ticket_type_id: 1, quantity: 1 }], { ...ev, event_id: 8 }).includes('unknown_tier'), '');
    check('reservation: a cancelled event refuses the whole order', rerr([{ ticket_type_id: 1, quantity: 1 }], { ...ev, event_status: 'cancelled' }).includes('event_cancelled'), '');

    // ═══ the buyer ═══
    const goodBuyer = { buyer_name: 'Lindiwe O&#x27;Neill', buyer_email: ' Lindiwe@Example.Invalid ', buyer_phone: '+27 82 123 4567', holder_names: ['', 'Sipho'], popia_consent: true };
    const b = core.validateBuyer(goodBuyer, 2);
    check('buyer: name decoded, email lower-cased and trimmed, phone compacted, blank holder names become null',
        Object.keys(b.errors).length === 0 && b.clean.buyer_name === "Lindiwe O'Neill" && b.clean.buyer_email === 'lindiwe@example.invalid' && b.clean.buyer_phone === '+27821234567' && JSON.stringify(b.clean.holder_names) === '[null,"Sipho"]', JSON.stringify(b));
    const berr = (patch) => Object.keys(core.validateBuyer({ ...goodBuyer, ...patch }, 2).errors);
    check('buyer: no POPIA consent, a bad email, a bad phone, markup in a holder name are refused',
        berr({ popia_consent: false }).includes('popia_consent') && berr({ buyer_email: 'nope' }).includes('buyer_email') && berr({ buyer_phone: '12' }).includes('buyer_phone') && berr({ holder_names: ['<x>'] }).includes('holder_names'), '');
    check('buyer: PayFast name split', core.splitName('Mary Jane Watson').first === 'Mary Jane' && core.splitName('Mary Jane Watson').last === 'Watson' && core.splitName('Cher').last === '', '');

    // ═══ CSV ═══
    check('CSV: a cell that starts like a formula is neutralised (= + - @ tab)',
        core.csvCell('=HYPERLINK("x")') === '"\'=HYPERLINK(""x"")"' && core.csvCell('+27 82') === "'+27 82" && core.csvCell('-1') === "'-1" && core.csvCell('@SUM(A1)') === "'@SUM(A1)", core.csvCell('=HYPERLINK("x")'));
    check('CSV: stored text is decoded, commas/quotes/newlines quoted, null is empty', core.csvCell('Tom &amp; Jerry') === 'Tom & Jerry' && core.csvCell('a,b') === '"a,b"' && core.csvCell(null) === '' && core.csvRow(['x', 'y "z"']) === 'x,"y ""z"""', '');
};
