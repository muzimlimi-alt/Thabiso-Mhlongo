// Public availability: the month view (GET /api/public/availability/month), the per-date check
// (GET /api/public/availability?date=) and the config (GET /api/public/booking-config) must agree, because the
// booking drawer's calendar colours dates from the first and the visitor is then bound by the second.
//
// The bug this guards against: a date whose booking has no start time occupies the WHOLE day (the per-date check
// answers "already booked"), but the month view only listed it as "booked" (reserved), so the calendar offered it
// as selectable and it was refused only after the click. The month view now also reports such dates as `full`.
// Date offsets live in the 975+ range, clear of every other file's claimed ranges.
module.exports = async function ({ check, api, pub, one, future, getTrackingToken }) {
    const monthOf = (ds) => ({ year: +ds.slice(0, 4), month: +ds.slice(5, 7) });
    const monthData = async (ds) => { const m = monthOf(ds); return (await pub('GET', `/api/public/availability/month?year=${m.year}&month=${m.month}`)).body; };
    const perDate = async (ds) => (await pub('GET', `/api/public/availability?date=${ds}`)).body;

    // ── config exposes the notice rule the per-date check enforces ──
    const cfg = (await pub('GET', '/api/public/booking-config?dow=all')).body;
    check('config?dow=all returns 7 weekdays', Array.isArray(cfg.days) && cfg.days.length === 7, JSON.stringify(cfg).slice(0, 160));
    check('config?dow=all exposes min_advance_hours (the "too soon" rule)', cfg.min_advance_hours === 48, String(cfg.min_advance_hours));
    const single = (await pub('GET', '/api/public/booking-config?dow=1')).body;
    check('single-day config also exposes min_advance_hours', single.min_advance_hours === 48, JSON.stringify(single));
    const soon = await perDate(future(1));
    check('the per-date check really does reject a date inside that window (too_soon)', soon.available === false && soon.reason === 'too_soon', JSON.stringify(soon));

    // ── seed: an all-day hold, an UNTIMED accepted booking, and a TIMED accepted booking ──
    const heldDate = future(975), fullDate = future(976), timedDate = future(977);
    const hold = await api('POST', '/api/admin/calendar/hold', { date: heldDate, reason: 'availability test hold' });
    check('seed: all-day hold created', hold.status === 200 && hold.body.success, JSON.stringify(hold.body));

    let n = 0;
    const seedAccepted = async (date, extra) => {
        const em = `avail.${Date.now()}.${n++}@example.invalid`;
        const cr = await api('POST', '/api/admin/bookings', Object.assign({
            name: 'Availability IT', email: em, cell: '+27821234567', event_date: date, event_name: 'Availability Event', event_type: 'Corporate',
            event_location: 'Test Hall', message: 'Integration-test booking, over ten characters.', services: [{ service_id: 15 }], status: 'NEW', override_working_hours: true
        }, extra || {}));
        const id = cr.body && cr.body.booking_id;
        const bk = await one('SELECT date, event_start_time FROM bookings WHERE id=?', [id]);
        await api('POST', `/api/admin/bookings/${id}/quote`, {
            quote_expiry_date: new Date(Date.parse(bk.date) - 10 * 86400000).toISOString().slice(0, 10), terms: 'T', apply_vat: false, discount: 0,
            items: [{ service_id: 15, description: 'Travel Buyout – Gauteng', quantity: 1, unit_price: 1000 }]
        });
        const token = await getTrackingToken(id, em);
        const acc = await pub('POST', `/api/public/bookings/${id}/accept-quote`, { access_token: token, terms_agreed: true });
        return { id, status: acc.status, start: bk.event_start_time };
    };
    const full = await seedAccepted(fullDate);                                   // no start time -> occupies the whole day
    const timed = await seedAccepted(timedDate, { event_start_time: '18:00' });  // timed -> blocks only its own window
    check('seed: untimed booking accepted', full.status === 200 && !full.start, JSON.stringify(full));
    check('seed: timed booking accepted', timed.status === 200 && timed.start === '18:00', JSON.stringify(timed));

    // ── the month view agrees with the per-date check, date by date ──
    const mHeld = await monthData(heldDate), mFull = await monthData(fullDate), mTimed = await monthData(timedDate);
    check('month view lists the all-day hold as held', (mHeld.held || []).includes(heldDate), JSON.stringify(mHeld));
    check('month view: an all-day hold is NOT also reported as full (held wins)', !(mHeld.full || []).includes(heldDate), JSON.stringify(mHeld.full));
    check('month view lists the untimed booking date as booked AND full', (mFull.booked || []).includes(fullDate) && (mFull.full || []).includes(fullDate), JSON.stringify(mFull));
    check('month view lists the timed booking date as booked but NOT full', (mTimed.booked || []).includes(timedDate) && !(mTimed.full || []).includes(timedDate), JSON.stringify(mTimed));

    const aHeld = await perDate(heldDate), aFull = await perDate(fullDate), aTimed = await perDate(timedDate);
    check('per-date check: held date unavailable', aHeld.available === false && aHeld.reason === 'held', JSON.stringify(aHeld));
    check('per-date check: `full` date unavailable ("booked") - agrees with the month view', aFull.available === false && aFull.reason === 'booked', JSON.stringify(aFull));
    check('per-date check: timed-booking date available with that window busy - agrees with booked-but-not-full',
        aTimed.available === true && (aTimed.busy_ranges || []).some(r => r.start === '18:00'), JSON.stringify(aTimed));

    // Invariant over EVERY month involved: every `full` date is refused; every reserved-but-not-full, not-held date is offered.
    const bad = [];
    for (const mo of [...new Set([heldDate, fullDate, timedDate].map(d => d.slice(0, 7)))]) {
        const inv = await monthData(mo + '-01');
        for (const ds of inv.full || []) { const a = await perDate(ds); if (a.available !== false) bad.push(`full ${ds} -> ${JSON.stringify(a)}`); }
        for (const ds of (inv.booked || []).filter(d => !(inv.full || []).includes(d) && !(inv.held || []).includes(d))) {
            const a = await perDate(ds); if (a.available !== true) bad.push(`reserved ${ds} -> ${JSON.stringify(a)}`);
        }
    }
    check('invariant: every `full` date is refused and every open reserved date is offered by the per-date check', bad.length === 0, bad.join(' | '));

    // ── robustness ──
    const badMonth = await pub('GET', '/api/public/availability/month?year=abc&month=13');
    check('month view rejects a malformed year/month (400, no crash)', badMonth.status === 400, String(badMonth.status));
};
