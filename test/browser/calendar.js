// Availability calendar
// Browser test for the public booking drawer (index.html). Boots the real app on an isolated database copy
// (test/support.js - SMTP mocked, never touches the real database), drives the REAL wizard in headless Chrome
// via puppeteer, and prints PASS/FAIL per check. Seeds a hold and two accepted bookings through the real APIs and checks state colours, selection, keyboard, loading / error / retry / stale-response behaviour.
// Not part of `npm test` (that runner only loads test/*.test.js): run it with `npm run test:browser`.
const d = require('./drive');
const { api, pub, one, future, getTrackingToken } = d.support;
let fails = 0;
const ok = (c, n, detail) => { if (!c) fails++; console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '\n        -> ' + detail)); };
const rgbOf = s => (String(s).match(/rgba?\(([^)]+)\)/) || [])[1] || String(s);

(async () => {
    await d.support.start();

    // ── seed REAL availability data through the real admin/public APIs ──
    const heldDate = future(12), fullDate = future(16), timedDate = future(21);
    const hold = await api('POST', '/api/admin/calendar/hold', { date: heldDate, reason: 'calendar state test' });
    ok(hold.status === 200 && hold.body.success, 'seed: blocked date created', JSON.stringify(hold.body));
    let n = 0;
    const seedAccepted = async (date, extra) => {
        const em = `cal.${Date.now()}.${n++}@example.invalid`;
        const cr = await api('POST', '/api/admin/bookings', Object.assign({ name: 'Cal Test', email: em, cell: '+27821234567', event_date: date, event_name: 'Cal Event', event_type: 'Corporate',
            event_location: 'Hall', message: 'Calendar state test booking.', services: [{ service_id: 15 }], status: 'NEW', override_working_hours: true }, extra || {}));
        const bid = cr.body && cr.body.booking_id;
        const bk = await one('SELECT date, event_start_time FROM bookings WHERE id=?', [bid]);
        await api('POST', `/api/admin/bookings/${bid}/quote`, { quote_expiry_date: new Date(Date.parse(bk.date) - 10 * 864e5).toISOString().slice(0, 10), terms: 'T', apply_vat: false, discount: 0, items: [{ service_id: 15, description: 'Travel', quantity: 1, unit_price: 1000 }] });
        const tok = await getTrackingToken(bid, em);
        const acc = await pub('POST', `/api/public/bookings/${bid}/accept-quote`, { access_token: tok, terms_agreed: true });
        return { status: acc.status, start: bk.event_start_time };
    };
    const a1 = await seedAccepted(fullDate);                                   // no start time -> occupies the whole day
    const a2 = await seedAccepted(timedDate, { event_start_time: '18:00' });   // timed -> only blocks its own window
    ok(a1.status === 200 && !a1.start, 'seed: UNTIMED booking accepted (whole day)', JSON.stringify(a1));
    ok(a2.status === 200 && a2.start === '18:00', 'seed: TIMED booking accepted (other times stay open)', JSON.stringify(a2));
    const avFull = await (await fetch(d.BASE + '/api/public/availability?date=' + fullDate)).json();
    const avTimed = await (await fetch(d.BASE + '/api/public/availability?date=' + timedDate)).json();
    ok(avFull.available === false && avFull.reason === 'booked', 'server per-date check: untimed booking date is NOT available', JSON.stringify(avFull));
    ok(avTimed.available === true && (avTimed.busy_ranges || []).length === 1, 'server per-date check: timed booking date IS available (one busy window)', JSON.stringify(avTimed));
    const cfg = await (await fetch(d.BASE + '/api/public/booking-config?dow=all')).json();
    ok(Array.isArray(cfg.days) && cfg.days.length === 7 && cfg.min_advance_hours === 48, 'config endpoint exposes the 48h notice rule', JSON.stringify(cfg).slice(0, 200));
    const closedDow = cfg.days.filter(x => x.is_working_day === false).map(x => x.day_of_week);

    const browser = await d.launch();
    const p = await d.openDrawer(browser, { w: 1440, h: 900 });
    await p.waitForSelector('#calDaysGrid .tm-cal-cell[data-date]', { timeout: 20000 });
    await d.sleep(3000);   // first-load auto-advance (if the current month has nothing bookable) settles

    // helper: navigate to the month a date belongs to (by comparing the DISPLAYED month, so the calendar's
    // first-load auto-advance can't make us overshoot)
    const shownMonth = () => p.evaluate(() => { const c = document.querySelector('.tm-cal-cell[data-date]'); return c ? c.dataset.date.slice(0, 7) : null; });
    const showDate = async (ds) => {
        for (let i = 0; i < 8; i++) {
            if (await p.$(`.tm-cal-cell[data-date="${ds}"]`)) return true;
            const shown = await shownMonth();
            if (!shown) { await d.sleep(600); continue; }
            const btn = shown < ds.slice(0, 7) ? '#calNext' : '#calPrev';
            if (await p.$eval(btn, b => b.disabled)) return false;
            await p.click(btn); await d.sleep(1300);
        }
        return false;
    };
    const cell = (ds) => p.evaluate(ds => {
        const c = document.querySelector(`.tm-cal-cell[data-date="${ds}"]`); if (!c) return null;
        const cs = getComputedStyle(c);
        return { cls: c.className, state: c.dataset.state, border: cs.borderTopColor, bg: cs.backgroundColor, cursor: cs.cursor, disabled: c.getAttribute('aria-disabled'), label: c.getAttribute('aria-label'), tabindex: c.getAttribute('tabindex') };
    }, ds);

    // ── states follow the real data ──
    await showDate(heldDate);
    let c = await cell(heldDate);
    ok(c && c.state === 'held' && /239, 68, 68/.test(c.border) && c.disabled === 'true', 'blocked date: red ring, disabled', JSON.stringify(c));
    await showDate(timedDate);
    c = await cell(timedDate);
    ok(c && c.state === 'booked' && !c.cls.includes('--full') && /245, 158, 11/.test(c.border) && !c.disabled, 'reserved (timed booking): orange ring, still selectable', JSON.stringify(c));
    await showDate(fullDate);
    c = await cell(fullDate);
    ok(c && c.state === 'booked' && c.cls.includes('--full') && /245, 158, 11/.test(c.border) && c.disabled === 'true' && /whole day/.test(c.label), 'reserved (whole day taken): orange ring, NOT selectable, says why', JSON.stringify(c));
    const freeDs = await p.evaluate(() => { const x = [...document.querySelectorAll('.tm-cal-cell--avail')][0]; return x && x.dataset.date; });
    c = await cell(freeDs);
    ok(c && c.state === 'avail' && /16, 185, 129/.test(c.border), 'available business day: green ring', JSON.stringify(c));
    ok(closedDow.length > 0, 'test DB has a non-working weekday to check against', JSON.stringify(closedDow));
    const closedDs = await p.evaluate(dows => { const x = [...document.querySelectorAll('.tm-cal-cell--nonworking')][0]; return x && x.dataset.date; }, closedDow);
    c = await cell(closedDs);
    ok(c && c.state === 'nonworking' && c.disabled === 'true' && /0, 0, 0, 0|transparent/.test(c.border), 'non-working day: muted, no ring, disabled', JSON.stringify(c));

    // start from the current month for today/soon/past checks
    await p.evaluate(() => window.refreshAvailCalendar && 0);
    const cur = new Date(); const monthKey = `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}`;
    await showDate(future(0));   // back to the current month for the today / past / notice-window checks
    const today = future(0), tomorrow = future(1);
    c = await cell(today);
    ok(c && (c.state === 'soon' || c.state === 'nonworking' || c.state === 'held'), 'today is inside the notice window: not selectable', JSON.stringify(c));
    const dot = await p.evaluate(ds => getComputedStyle(document.querySelector(`.tm-cal-cell[data-date="${ds}"]`), '::after').content, today);
    ok(dot === '""', "today has its own marker (a dot), independent of the state ring", dot);
    c = await cell(tomorrow);
    if (c) ok(c.state === 'soon' || c.state === 'nonworking' || c.state === 'past', 'tomorrow (<48h) is not offered as available', JSON.stringify(c));
    const past = await p.evaluate(() => { const x = document.querySelector('.tm-cal-cell--past'); return x ? x.dataset.date : null; });
    if (past) { c = await cell(past); ok(c.disabled === 'true', 'past dates are disabled', JSON.stringify(c)); }
    ok(await p.$eval('#calPrev', b => b.disabled), 'previous-month button is disabled at the current month', '');

    // unselectable dates ignore clicks
    await showDate(heldDate);   // a later month always has a closed weekday in view
    const closedNow = await p.evaluate(() => { const x = document.querySelector('.tm-cal-cell--nonworking'); return x && x.dataset.date; });
    await p.evaluate(ds => document.querySelector(`.tm-cal-cell[data-date="${ds}"]`).click(), closedNow);
    let bd = await p.$eval('#bookDate', i => i.value);
    ok(bd === '', 'clicking a non-working day selects nothing', bd);
    await showDate(heldDate);
    await p.evaluate(ds => document.querySelector(`.tm-cal-cell[data-date="${ds}"]`).click(), heldDate);
    bd = await p.$eval('#bookDate', i => i.value);
    ok(bd === '', 'clicking a blocked day selects nothing', bd);

    // selection keeps the state colour
    await showDate(fullDate);
    await p.evaluate(ds => document.querySelector(`.tm-cal-cell[data-date="${ds}"]`).click(), fullDate);
    bd = await p.$eval('#bookDate', i => i.value);
    ok(bd === '', 'clicking a whole-day-reserved date selects nothing', bd);
    await showDate(timedDate);
    await p.evaluate(ds => document.querySelector(`.tm-cal-cell[data-date="${ds}"]`).click(), timedDate);
    await d.sleep(1200);
    c = await cell(timedDate);
    const selInfo = await p.evaluate(ds => { const e = document.querySelector(`.tm-cal-cell[data-date="${ds}"]`); return { pressed: e.getAttribute('aria-pressed'), tick: getComputedStyle(e, '::before').content, shadow: getComputedStyle(e).boxShadow }; }, timedDate);
    ok(c.cls.includes('tm-cal-cell--selected') && /245, 158, 11/.test(c.border) && selInfo.pressed === 'true' && selInfo.tick !== 'none', 'selected reserved date keeps its ORANGE ring (not overridden), has a tick + aria-pressed', JSON.stringify({ c, selInfo }));
    ok(/245, 158, 11/.test(selInfo.shadow), 'selected ring shadow uses the state colour', selInfo.shadow);
    const disp = await p.$eval('#bookDateDisplay', e => e.textContent);
    ok(/^\w+day, \d{1,2} \w+ \d{4}$/.test(disp.trim()), 'selected date shown in a readable long format', disp);
    const status = await p.$eval('#hint-bookDate', e => e.textContent).catch(() => '');
    ok(/available/i.test(status) && /blocked/i.test(status), 'server check allows the reserved-but-open date and notes the blocked window', status);

    // hover on an available date must not turn it into another state colour
    await showDate(freeDs);
    await p.hover(`.tm-cal-cell[data-date="${freeDs}"]`); await d.sleep(300);
    c = await cell(freeDs);
    ok(/16, 185, 129/.test(c.border), 'hover keeps the green availability colour', JSON.stringify(c));
    // focus ring takes the state colour
    await showDate(freeDs);
    await p.focus(`.tm-cal-cell[data-date="${freeDs}"]`);
    await p.keyboard.press('ArrowRight'); await p.keyboard.press('ArrowLeft'); await d.sleep(200);   // real keyboard modality -> :focus-visible
    const outline = await p.evaluate(() => ({ ds: document.activeElement.dataset.date, st: document.activeElement.dataset.state, col: getComputedStyle(document.activeElement).outlineColor, w: getComputedStyle(document.activeElement).outlineWidth }));
    ok(outline.ds === freeDs && /16, 185, 129/.test(outline.col) && outline.w !== '0px', 'keyboard focus ring uses the availability colour', JSON.stringify(outline));

    // ── keyboard ──
    const tabStops = await p.$$eval('#calDaysGrid [tabindex="0"]', n => n.length);
    ok(tabStops === 1, 'grid has a single Tab stop (roving tabindex)', String(tabStops));
    await p.focus(`.tm-cal-cell[data-date="${freeDs}"]`);
    await p.keyboard.press('ArrowRight'); await d.sleep(150);
    let foc = await p.evaluate(() => document.activeElement.dataset.date);
    const expectNext = new Date(freeDs + 'T00:00:00'); expectNext.setDate(expectNext.getDate() + 1);
    ok(foc === expectNext.toISOString().slice(0, 10) || foc === `${expectNext.getFullYear()}-${String(expectNext.getMonth() + 1).padStart(2, '0')}-${String(expectNext.getDate()).padStart(2, '0')}`, 'ArrowRight moves to the next day', foc);
    await p.keyboard.press('ArrowDown'); await d.sleep(150);
    const foc2 = await p.evaluate(() => document.activeElement.dataset.date);
    ok(foc2 && foc2 > foc, 'ArrowDown moves a week ahead', `${foc} -> ${foc2}`);
    const titleBefore = await p.$eval('#calTitle', e => e.textContent);
    await p.keyboard.press('PageDown'); await d.sleep(1500);
    const titleAfter = await p.$eval('#calTitle', e => e.textContent);
    const dayAfter = await p.evaluate(() => document.activeElement.dataset.date);
    ok(titleAfter !== titleBefore && dayAfter, 'PageDown goes to the next month and keeps focus in the grid', `${titleBefore} -> ${titleAfter}, focus ${dayAfter}`);
    await p.keyboard.press('PageUp'); await d.sleep(1500);
    ok((await p.$eval('#calTitle', e => e.textContent)) === titleBefore, 'PageUp returns', '');

    // Enter selects an available date from the keyboard
    const kd = await p.evaluate(() => { const min = new Date(Date.now() + 8 * 864e5).toISOString().slice(0, 10); const x = [...document.querySelectorAll('.tm-cal-cell--avail')].find(e => e.dataset.date >= min); return x && x.dataset.date; });
    await p.focus(`.tm-cal-cell[data-date="${kd}"]`); await p.keyboard.press('Enter'); await d.sleep(1200);
    ok((await p.$eval('#bookDate', i => i.value)) === kd, 'Enter selects the focused available date', kd);

    ok(p._errs.length === 0, 'no page errors so far', p._errs.join(' | '));
    await p.close();

    // ── loading / error / stale-response states (month endpoint simulated) ──
    const monthMock = (handler) => [{ test: /\/api\/public\/availability\/month/, respond: handler }];
    // slow
    let p2 = await d.openDrawer(browser, { w: 1440, h: 900, mocks: monthMock(async r => { await d.sleep(2500); r.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ held: [], booked: [] }) }); }) });
    await d.sleep(600);
    const loading = await p2.evaluate(() => ({ status: document.getElementById('calStatus').textContent.trim(), busy: document.getElementById('calDaysGrid').getAttribute('aria-busy'), cls: document.getElementById('calDaysGrid').className }));
    ok(/Loading availability/.test(loading.status) && loading.busy === 'true' && /loading/.test(loading.cls), 'slow availability: a loading state is shown and announced', JSON.stringify(loading));
    await p2.waitForFunction(() => !document.getElementById('calDaysGrid').hasAttribute('aria-busy') && document.querySelector('.tm-cal-cell[data-date]'), { timeout: 15000 });
    ok(await p2.$eval('#calStatus', e => e.textContent.trim() === ''), 'loading message clears once data arrives', '');
    await p2.close();

    // failure + rate limit -> honest error state, not "everything available"
    for (const [label, status] of [['rate limited (429)', 429], ['not found (404)', 404]]) {
        let fail = true;
        const p3 = await d.openDrawer(browser, { w: 1440, h: 900, mocks: monthMock(r => fail ? r.respond({ status, contentType: 'application/json', body: JSON.stringify({ error: 'x' }) }) : r.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ held: [], booked: [], full: [] }) })) });
        await p3.waitForSelector('#calDaysGrid .tm-cal-cell[data-date]', { timeout: 20000 }); await d.sleep(500);
        await p3.click('#calNext'); await d.sleep(1200);   // a later month always has bookable weekdays in view
        const er = await p3.evaluate(() => ({ status: document.getElementById('calStatus').textContent.trim(), retry: !!document.getElementById('calRetry'),
            avail: document.querySelectorAll('.tm-cal-cell--avail').length, unknown: document.querySelectorAll('.tm-cal-cell--unknown').length }));
        ok(/couldn't load live availability/.test(er.status) && er.retry && er.avail === 0 && er.unknown > 0, `${label}: honest error + retry, dates NOT shown as available`, JSON.stringify(er));
        fail = false; await p3.click('#calRetry'); await d.sleep(1800);
        const rec = await p3.evaluate(() => ({ avail: document.querySelectorAll('.tm-cal-cell--avail').length, status: document.getElementById('calStatus').textContent.trim() }));
        ok(rec.avail > 0 && rec.status === '', `${label}: Try again recovers`, JSON.stringify(rec));
        await p3.close();
    }

    // stale response: an OLD, slow reply must never overwrite what you navigated to. The first (slow) reply marks
    // every day of the next ~100 days as held; if it were applied, the displayed month would be all red.
    let call = 0;
    const allHeld = []; for (let i = 0; i < 100; i++) allHeld.push(new Date(Date.now() + i * 864e5).toISOString().slice(0, 10));
    const p4 = await d.openDrawer(browser, { w: 1440, h: 900, mocks: monthMock(async r => {
        const n = ++call;
        if (n === 1) { await d.sleep(3500); return r.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ held: allHeld, booked: [] }) }); }
        r.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ held: [], booked: [], full: [] }) });
    }) });
    await d.sleep(500);
    await p4.click('#calNext');
    await p4.waitForFunction(() => document.querySelector('.tm-cal-cell[data-date]'), { timeout: 15000 });
    await d.sleep(4500);                                        // let the stale first response land
    const stale = await p4.evaluate(() => ({
        title: document.getElementById('calTitle').textContent,
        firstDate: (document.querySelector('.tm-cal-cell[data-date]') || {}).dataset.date,
        held: document.querySelectorAll('.tm-cal-cell--held').length,
        bookable: document.querySelectorAll('.tm-cal-cell--avail').length
    }));
    ok(stale.held === 0 && stale.bookable > 0, 'a slow OLD response does not overwrite the month shown (nothing turned red)', JSON.stringify(stale));
    const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    const fd = new Date(stale.firstDate + 'T00:00:00');
    ok(stale.title === monthNames[fd.getMonth()] + ' ' + fd.getFullYear(), 'the month title matches the days shown', JSON.stringify(stale));
    ok(p4._errs.length === 0, 'no page errors in stale-response scenario', p4._errs.join(' | '));
    await p4.close();

    await browser.close(); await d.support.stop();
    console.log(fails ? `\n${fails} FAILURE(S)` : '\nALL PASS'); process.exit(fails ? 1 : 0);
})().catch(async e => { console.error('ERR', e.stack || e.message); try { await d.support.stop(); } catch (_) {} process.exit(2); });
