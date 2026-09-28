// Selected-date bar <-> calendar state
// Browser test for the public booking drawer (index.html). The chosen date is shown in a bar under the calendar
// (#bookDateDisplay) that must always agree with that date's calendar cell: same state (data-state), same colour
// (shared --status-* tokens), same date, no matter how the date was picked or how the server answered.
// Boots the real app on an isolated database copy (test/support.js), seeds a hold and two accepted bookings through the
// real APIs, and drives the REAL wizard in headless Chrome. Not part of `npm test`: run it with `npm run test:browser`.
const fs = require('fs');
const path = require('path');
const d = require('./drive');
const { api, pub, one, future, getTrackingToken } = d.support;
let fails = 0;
const ok = (c, n, detail) => { if (!c) fails++; console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '\n        -> ' + detail)); };

// the ONE colour per state (r, g, b as the browser reports it) - css/public/redesign.css :root --status-*-rgb
const RGB = { avail: '76, 175, 80', booked: '255, 152, 0', held: '239, 83, 80', muted: '176, 176, 176' };
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const longDate = ds => { const [y, m, dd] = ds.split('-').map(Number); return `${DAYS[new Date(y, m - 1, dd).getDay()]}, ${dd} ${MONTHS[m - 1]} ${y}`; };

// Everything the bar and the selected cell show, read the way a visitor sees it (computed style, not class names).
const snapFn = () => {
    const rgb = s => (String(s).match(/rgba?\(([^)]+)\)/) || [])[1] || String(s);
    const cs = e => getComputedStyle(e);
    const bar = document.getElementById('bookDateDisplay');
    const icon = bar.querySelector('.bk-date-status__icon'), msg = bar.querySelector('.bk-date-status__msg'), date = bar.querySelector('.bk-date-status__date');
    const sel = document.querySelector('.tm-cal-cell--selected');
    // contrast of the message text on the bar's own (translucent) background over the calendar panel
    const parse = s => (String(s).match(/[\d.]+/g) || []).map(Number);
    const lum = ([r, g, b]) => { const f = v => { v /= 255; return v <= .03928 ? v / 12.92 : Math.pow((v + .055) / 1.055, 2.4); }; return .2126 * f(r) + .7152 * f(g) + .0722 * f(b); };
    const base = parse(cs(document.querySelector('.tm-avail-cal__widget')).backgroundColor);
    const bg = parse(cs(bar).backgroundColor), a = bg.length > 3 ? bg[3] : 1;
    const flat = [0, 1, 2].map(i => bg[i] * a + base[i] * (1 - a));
    const l1 = lum(parse(cs(msg).color)), l2 = lum(flat);
    const contrast = (Math.max(l1, l2) + .05) / (Math.min(l1, l2) + .05);
    const r = bar.getBoundingClientRect();
    return {
        barState: bar.dataset.state, barBorder: rgb(cs(bar).borderTopColor), iconColor: rgb(cs(icon).color), msgColor: rgb(cs(msg).color),
        date: date.textContent.trim(), msg: msg.textContent.trim(), iconCls: icon.className, contrast: Math.round(contrast * 100) / 100,
        cell: sel ? { ds: sel.dataset.date, state: sel.dataset.state, ring: rgb(cs(sel).borderTopColor), tick: /✓/.test(getComputedStyle(sel, '::before').content), focus: document.activeElement === sel } : null,
        selectedCount: document.querySelectorAll('.tm-cal-cell--selected').length,
        bookDate: document.getElementById('bookDate').value, nextDisabled: document.getElementById('bookNext1').disabled,
        barTop: Math.round(r.top), barBottom: Math.round(r.bottom), vh: window.innerHeight, vw: window.innerWidth,
        live: { role: bar.getAttribute('role'), polite: bar.getAttribute('aria-live') }
    };
};

(async () => {
    await d.support.start();

    // ── seed REAL availability data (on WORKING weekdays: a closed weekday outranks blocked / reserved) ──
    const cfg = await (await fetch(d.BASE + '/api/public/booking-config?dow=all')).json();
    const closedDows = cfg.days.filter(x => x.is_working_day === false).map(x => x.day_of_week);
    const working = (n) => { for (let i = n; i < n + 7; i++) if (!closedDows.includes(new Date(future(i) + 'T12:00:00').getDay())) return future(i); return future(n); };
    const heldDate = working(12), fullDate = working(16), timedDate = working(21);
    const hold = await api('POST', '/api/admin/calendar/hold', { date: heldDate, reason: 'date-status test' });
    ok(hold.status === 200 && hold.body.success, 'seed: blocked date created', JSON.stringify(hold.body));
    let n = 0;
    const seedAccepted = async (date, extra) => {
        const em = `ds.${Date.now()}.${n++}@example.invalid`;
        const cr = await api('POST', '/api/admin/bookings', Object.assign({ name: 'DS Test', email: em, cell: '+27821234567', event_date: date, event_name: 'DS Event', event_type: 'Corporate',
            event_location: 'Hall', message: 'Date status test booking.', services: [{ service_id: 15 }], status: 'NEW', override_working_hours: true }, extra || {}));
        const bid = cr.body && cr.body.booking_id;
        const bk = await one('SELECT date FROM bookings WHERE id=?', [bid]);
        await api('POST', `/api/admin/bookings/${bid}/quote`, { quote_expiry_date: new Date(Date.parse(bk.date) - 10 * 864e5).toISOString().slice(0, 10), terms: 'T', apply_vat: false, discount: 0, items: [{ service_id: 15, description: 'Travel', quantity: 1, unit_price: 1000 }] });
        const tok = await getTrackingToken(bid, em);
        return (await pub('POST', `/api/public/bookings/${bid}/accept-quote`, { access_token: tok, terms_agreed: true })).status;
    };
    ok(await seedAccepted(fullDate) === 200, 'seed: whole-day (untimed) booking accepted', '');
    ok(await seedAccepted(timedDate, { event_start_time: '18:00' }) === 200, 'seed: timed booking accepted (18:00)', '');
    const freeDates = []; for (let i = 25; i < 60 && freeDates.length < 3; i++) { const ds = future(i); if (!closedDows.includes(new Date(ds + 'T12:00:00').getDay()) && ![heldDate, fullDate, timedDate].includes(ds)) freeDates.push(ds); }

    const browser = await d.launch();

    // helpers bound to a page
    const shownMonth = p => p.evaluate(() => { const c = document.querySelector('.tm-cal-cell[data-date]'); return c ? c.dataset.date.slice(0, 7) : null; });
    const showDate = async (p, ds) => {
        for (let i = 0; i < 10; i++) {
            if (await p.$(`.tm-cal-cell[data-date="${ds}"]`)) return true;
            const shown = await shownMonth(p);
            if (!shown) { await d.sleep(600); continue; }
            const btn = shown < ds.slice(0, 7) ? '#calNext' : '#calPrev';
            if (await p.$eval(btn, b => b.disabled)) return false;
            await p.click(btn); await d.sleep(1300);
        }
        return false;
    };
    const settle = async (p) => {
        await p.waitForFunction(() => !/Checking availability/.test(document.getElementById('hint-bookDate').textContent), { timeout: 10000 }).catch(() => {});
        await d.sleep(450);   // let the .15-.2s colour transitions finish before measuring
    };
    const pick = async (p, ds) => {
        await showDate(p, ds);
        await p.evaluate(x => document.querySelector(`.tm-cal-cell[data-date="${x}"]`).click(), ds);
        await settle(p);
        // SHOTS_DIR=<folder> saves a picture of the calendar panel after every pick (for eyeballing; not needed to pass)
        if (process.env.SHOTS_DIR) { const w = await p.$('.tm-avail-cal__widget'); if (w) await w.screenshot({ path: path.join(process.env.SHOTS_DIR, `${p.viewport().width}-${ds}.png`) }); }
        return p.evaluate(snapFn);
    };
    const closedDs = async (p) => p.evaluate(() => { const x = document.querySelector('.tm-cal-cell--nonworking'); return x && x.dataset.date; });
    // the invariant the whole feature exists for
    const inSync = (s, ds, wantState, wantRgb, label) => {
        const problems = [];
        if (!s.cell) problems.push('no selected cell');
        else {
            if (s.cell.ds !== ds) problems.push(`selected cell is ${s.cell.ds}`);
            if (s.cell.state !== wantState) problems.push(`cell state ${s.cell.state}`);
            if (s.barState !== s.cell.state) problems.push(`bar state ${s.barState} != cell state ${s.cell.state}`);
            if (s.barBorder !== s.cell.ring) problems.push(`bar border ${s.barBorder} != cell ring ${s.cell.ring}`);
        }
        if (s.barBorder !== wantRgb) problems.push(`bar border ${s.barBorder} != ${wantRgb}`);
        if (s.iconColor !== wantRgb) problems.push(`icon ${s.iconColor}`);
        if (s.msgColor !== wantRgb) problems.push(`message ${s.msgColor}`);
        if (s.date !== longDate(ds)) problems.push(`date text "${s.date}"`);
        if (s.selectedCount !== 1) problems.push(`${s.selectedCount} selected cells`);
        ok(problems.length === 0, label, problems.join(' | ') + ' :: ' + JSON.stringify(s));
    };

    // ══════════ desktop and mobile: each of the four states ══════════
    for (const [name, vp] of [['desktop', { w: 1440, h: 900 }], ['mobile', { w: 390, h: 844 }]]) {
        const p = await d.openDrawer(browser, vp);
        await p.waitForSelector('#calDaysGrid .tm-cal-cell[data-date]', { timeout: 20000 });
        await d.sleep(3000);   // first-load auto-advance settles
        const at = `[${name}] `;

        const noneSnap = await p.evaluate(snapFn);
        ok(noneSnap.barState === 'none' && /No date selected/.test(noneSnap.date) && noneSnap.selectedCount === 0, at + 'nothing chosen: neutral bar, no selected cell', JSON.stringify(noneSnap));
        const geo = await p.evaluate(() => { const g = document.getElementById('calDaysGrid').getBoundingClientRect(), b = document.getElementById('bookDateDisplay').getBoundingClientRect(), l = document.querySelector('.tm-cal-legend').getBoundingClientRect(); return { gridBottom: g.bottom, barTop: b.top, barBottom: b.bottom, legendTop: l.top, barW: b.width, gridW: g.width }; });
        ok(geo.barTop >= geo.gridBottom - 1 && geo.legendTop >= geo.barBottom - 1 && Math.abs(geo.barW - geo.gridW) < 2, at + 'the bar sits directly under the calendar grid (above the legend) at the grid\'s width', JSON.stringify(geo));

        let s = await pick(p, freeDates[0]);
        inSync(s, freeDates[0], 'avail', RGB.avail, at + 'AVAILABLE date: cell ring, bar border, icon and message are the same green (#4CAF50)');
        ok(/available/i.test(s.msg) && s.bookDate === freeDates[0] && !s.nextDisabled && s.cell.tick, at + 'available: says "available", is the booking date, Next enabled, tick on the cell', JSON.stringify(s));
        ok(s.contrast >= 4.5, at + `available: message contrast ${s.contrast}:1 on the bar (>= 4.5)`, JSON.stringify(s));
        ok(s.live.role === 'status' && s.live.polite === 'polite', at + 'the bar is a polite live region (state changes are announced)', JSON.stringify(s.live));

        s = await pick(p, timedDate);
        inSync(s, timedDate, 'booked', RGB.booked, at + 'RESERVED date (timed booking): cell ring, bar border, icon and message are the same orange');
        ok(/reserved/i.test(s.msg) && /18:00/.test(s.msg) && s.bookDate === timedDate && !s.nextDisabled, at + 'reserved: names the taken window, still bookable, Next enabled', JSON.stringify(s));
        ok(s.contrast >= 4.5, at + `reserved: message contrast ${s.contrast}:1 (>= 4.5)`, JSON.stringify(s));

        s = await pick(p, fullDate);
        inSync(s, fullDate, 'booked', RGB.booked, at + 'RESERVED date (whole day taken): same orange in cell, bar, icon and message');
        ok(/whole day/i.test(s.msg) && s.bookDate === '' && s.nextDisabled && !s.cell.tick && /calendar-xmark/.test(s.iconCls), at + 'whole day taken: explained, NOT booked, Next stays disabled, no tick', JSON.stringify(s));

        s = await pick(p, heldDate);
        inSync(s, heldDate, 'held', RGB.held, at + 'BLOCKED date: cell ring, bar border, icon and message are the same red (#EF5350)');
        ok(/blocked/i.test(s.msg) && s.bookDate === '' && s.nextDisabled && !s.cell.tick, at + 'blocked: explained, NOT booked, Next stays disabled, no tick', JSON.stringify(s));
        ok(s.contrast >= 4.5, at + `blocked: message contrast ${s.contrast}:1 (>= 4.5)`, JSON.stringify(s));

        const cd = await closedDs(p);
        s = await pick(p, cd);
        inSync(s, cd, 'nonworking', RGB.muted, at + 'NON-BUSINESS day: cell ring, bar border, icon and message are the same muted grey');
        ok(/not a working day/i.test(s.msg) && s.bookDate === '' && s.nextDisabled, at + 'non-business day: explained, NOT booked, Next stays disabled', JSON.stringify(s));
        ok(s.contrast >= 4.5, at + `non-business: message contrast ${s.contrast}:1 (>= 4.5)`, JSON.stringify(s));

        // legend dots read the very same tokens
        const dots = await p.evaluate(() => { const rgb = s => (s.match(/rgba?\(([^)]+)\)/) || [])[1]; const g = k => rgb(getComputedStyle(document.querySelector('.tm-cal-dot--' + k)).borderTopColor); return { avail: g('avail'), booked: g('booked'), held: g('held') }; });
        ok(dots.avail === RGB.avail && dots.booked === RGB.booked && dots.held === RGB.held, at + 'legend dots use the same three status colours', JSON.stringify(dots));

        // ── change dates repeatedly: bar and cell never drift apart ──
        const seq = [freeDates[0], heldDate, timedDate, cd, freeDates[1], fullDate, freeDates[0], cd, timedDate, freeDates[2], heldDate, freeDates[1], fullDate, timedDate, freeDates[0], cd, heldDate, freeDates[2]];
        const want = ds => ds === heldDate ? ['held', RGB.held] : ds === fullDate || ds === timedDate ? ['booked', RGB.booked] : ds === cd ? ['nonworking', RGB.muted] : ['avail', RGB.avail];
        const drift = [];
        for (const ds of seq) {
            const sn = await pick(p, ds);
            const [ws, wr] = want(ds);
            const bookable = ws === 'avail' || ds === timedDate;
            const bad = [];
            if (!sn.cell || sn.cell.ds !== ds || sn.cell.state !== ws) bad.push('cell ' + JSON.stringify(sn.cell));
            if (sn.barState !== ws || sn.barBorder !== wr || sn.msgColor !== wr || sn.iconColor !== wr) bad.push(`bar ${sn.barState}/${sn.barBorder}`);
            if (sn.date !== longDate(ds) || sn.selectedCount !== 1) bad.push(`date "${sn.date}", ${sn.selectedCount} selected`);
            if ((sn.bookDate === ds) !== bookable || sn.nextDisabled === bookable) bad.push(`bookDate=${sn.bookDate} nextDisabled=${sn.nextDisabled}`);
            if (bad.length) drift.push(ds + ': ' + bad.join(', '));
        }
        ok(drift.length === 0, at + `${seq.length} date changes in a row (all four states, across months): bar, ring and gate agree every time`, drift.join(' || '));

        // ── a real tap/click (not a scripted .click()) on a bookable date, then the bar is on screen ──
        await showDate(p, freeDates[1]);
        // worst case for the bar: the tapped date sits low on screen, right above the sticky Back/Next row
        await p.evaluate(x => {
            const c = document.querySelector(`.tm-cal-cell[data-date="${x}"]`);
            c.scrollIntoView({ block: 'center' });
            let sc = c.parentElement;
            while (sc && !(sc.scrollHeight > sc.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(sc).overflowY))) sc = sc.parentElement;
            const foot = document.querySelector('#bookStep1 .bk-nav-row');
            if (sc && foot) sc.scrollTop -= Math.round(foot.getBoundingClientRect().top - 8 - c.getBoundingClientRect().bottom);
        }, freeDates[1]);
        await d.sleep(200);
        if (vp.w < 500) await p.tap(`.tm-cal-cell[data-date="${freeDates[1]}"]`); else await p.click(`.tm-cal-cell[data-date="${freeDates[1]}"]`);
        await settle(p);
        s = await p.evaluate(snapFn);
        inSync(s, freeDates[1], 'avail', RGB.avail, at + 'a real ' + (vp.w < 500 ? 'tap' : 'click') + ' selects and syncs the same way');
        const clear = await p.evaluate(() => {
            const bar = document.getElementById('bookDateDisplay').getBoundingClientRect(), foot = document.querySelector('#bookStep1 .bk-nav-row').getBoundingClientRect();
            const hit = document.elementFromPoint(bar.left + bar.width / 2, bar.bottom - 4);
            return { barTop: Math.round(bar.top), barBottom: Math.round(bar.bottom), footerTop: Math.round(foot.top), hitInsideBar: !!(hit && hit.closest('#bookDateDisplay')) };
        });
        ok(clear.barTop >= 0 && clear.barBottom <= clear.footerTop + 1 && clear.hitInsideBar, at + 'after tapping a date low on screen the bar is scrolled clear of the sticky Back/Next row (not hidden under it)', JSON.stringify(clear));
        const overflow = await p.evaluate(() => { const b = document.getElementById('bookDateDisplay').getBoundingClientRect(); const sc = document.querySelector('#bookingDrawer .atl-drawer__body, #bookingDrawer [class*="drawer__body"]') || document.scrollingElement; return { barRight: Math.round(b.right), vw: window.innerWidth, hScroll: sc.scrollWidth > sc.clientWidth + 1 }; });
        ok(overflow.barRight <= overflow.vw && !overflow.hScroll, at + 'no horizontal overflow from the bar', JSON.stringify(overflow));

        // ── reset (wizard closed / draft cleared) ──
        await p.evaluate(() => window.bkResetDateDisplay());
        s = await p.evaluate(snapFn);
        ok(s.barState === 'none' && s.selectedCount === 0 && s.bookDate === '', at + 'reset returns to "no date selected" (bar neutral, no selected cell, no value)', JSON.stringify(s));
        ok(p._errs.length === 0, at + 'no page errors', p._errs.join(' | '));
        await p.close();
    }

    // ══════════ the server disagrees with the month view: the fresher per-date answer wins for BOTH ══════════
    // The month view is faked as "everything free", so the blocked date is offered (green). The real per-date check then
    // says "blocked". The cell must turn red together with the bar - never green cell + red bar.
    const monthFree = [{ test: /\/api\/public\/availability\/month/, respond: r => r.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ held: [], booked: [], full: [] }) }) }];
    {
        const p = await d.openDrawer(browser, { w: 1440, h: 900, mocks: monthFree });
        await p.waitForSelector('#calDaysGrid .tm-cal-cell[data-date]', { timeout: 20000 }); await d.sleep(3000);
        await showDate(p, heldDate);
        const before = await p.evaluate(x => document.querySelector(`.tm-cal-cell[data-date="${x}"]`).dataset.state, heldDate);
        ok(before === 'avail', 'stale month view: the blocked date is (wrongly) offered as available before it is checked', before);
        // keyboard: focus + Enter, so focus preservation across the redraw is exercised too
        await p.focus(`.tm-cal-cell[data-date="${heldDate}"]`);
        await p.keyboard.press('Enter');
        await settle(p);
        const s = await p.evaluate(snapFn);
        inSync(s, heldDate, 'held', RGB.held, 'the server\'s per-date answer recolours the cell AND the bar red together');
        ok(s.cell && s.cell.focus, 'keyboard focus stays on the date after its cell is redrawn', JSON.stringify(s.cell));
        ok(s.bookDate === heldDate && s.nextDisabled && /blocked/i.test(s.msg) && /Try .* instead/.test(s.msg), 'the refused date offers "Try <date> instead", and Next is disabled', JSON.stringify(s));
        // the suggestion goes through the calendar: right month, selected cell, green bar
        await p.evaluate(() => document.getElementById('bk-use-suggestion').click());
        await settle(p);
        const t2 = await p.evaluate(snapFn);
        const sug = t2.cell && t2.cell.ds;
        ok(sug && sug !== heldDate && sug === t2.bookDate && t2.date === longDate(sug) && t2.barState === t2.cell.state && !t2.nextDisabled, 'the suggested date is selected in the calendar (its month is shown) and the bar follows', JSON.stringify(t2));
        ok(t2.barState === 'avail' && t2.barBorder === RGB.avail && t2.cell.ring === RGB.avail, 'the suggested date is green in cell and bar', JSON.stringify(t2));
        ok(p._errs.length === 0, 'no page errors (stale month view)', p._errs.join(' | '));
        await p.close();
    }

    // ══════════ a slow answer for an EARLIER pick must not overwrite a later pick ══════════
    {
        const A = heldDate, B = freeDates[0];
        const slowA = [{ test: new RegExp('/api/public/availability\\?date=' + A), respond: async r => { await d.sleep(2200); r.continue(); } }, ...monthFree];
        const p = await d.openDrawer(browser, { w: 1440, h: 900, mocks: slowA });
        await p.waitForSelector('#calDaysGrid .tm-cal-cell[data-date]', { timeout: 20000 }); await d.sleep(3000);
        await showDate(p, A);
        await p.evaluate(x => document.querySelector(`.tm-cal-cell[data-date="${x}"]`).click(), A);   // slow check starts
        await d.sleep(150);
        await showDate(p, B);
        await p.evaluate(x => document.querySelector(`.tm-cal-cell[data-date="${x}"]`).click(), B);   // fast check finishes first
        await d.sleep(3200);                                                                          // A's late answer lands
        const s = await p.evaluate(snapFn);
        inSync(s, B, 'avail', RGB.avail, 'slow answer for an earlier date: the later pick stays selected, in sync and green');
        ok(s.bookDate === B && !s.nextDisabled && /available/i.test(s.msg), 'slow answer for an earlier date does not close Next or change the message', JSON.stringify(s));
        await showDate(p, A);
        const cellA = await p.evaluate(x => document.querySelector(`.tm-cal-cell[data-date="${x}"]`).dataset.state, A);
        ok(cellA === 'held', 'the earlier date still learns its own answer (its cell turns blocked)', cellA);
        await p.close();
    }

    // ══════════ the per-date check can't be reached (rate limit): honest neutral state in BOTH ══════════
    {
        const limited = [{ test: /\/api\/public\/availability\?date=/, respond: r => r.respond({ status: 429, contentType: 'application/json', body: JSON.stringify({ error: 'slow down' }) }) }];
        const p = await d.openDrawer(browser, { w: 1440, h: 900, mocks: limited });
        await p.waitForSelector('#calDaysGrid .tm-cal-cell[data-date]', { timeout: 20000 }); await d.sleep(3000);
        const s = await pick(p, freeDates[0]);
        inSync(s, freeDates[0], 'unknown', RGB.muted, 'availability check unreachable (429): cell and bar are both the neutral "not confirmed" state');
        ok(/couldn.t confirm/i.test(s.msg) && s.bookDate === freeDates[0] && !s.nextDisabled, 'not confirmed: says so, but the visitor may continue (the server re-checks on submit)', JSON.stringify(s));
        await p.close();
    }

    // ══════════ one colour system: nothing status-coloured is hard-coded outside the tokens ══════════
    {
        const root = path.resolve(__dirname, '..', '..');
        const css = f => fs.readFileSync(path.join(root, 'css', 'public', f), 'utf8').replace(/\r\n/g, '\n');
        const files = { 'redesign.css': css('redesign.css'), 'booking-form.css': css('booking-form.css') };
        const literal = /#4caf50|#ff9800|#ef5350|\b76,\s*175,\s*80\b|\b255,\s*152,\s*0\b|\b239,\s*83,\s*80\b/i;
        const stray = [];
        for (const [f, txt] of Object.entries(files)) txt.split('\n').forEach((l, i) => { if (literal.test(l) && !/--status-(available|reserved|blocked)-rgb\s*:/.test(l)) stray.push(`${f}:${i + 1}: ${l.trim().slice(0, 90)}`); });
        ok(stray.length === 0, 'the four status colours are defined once (:root --status-*-rgb) - no copy of them elsewhere in the public CSS', stray.join(' | '));
        const tokenLines = (files['redesign.css'].match(/--status-(available|reserved|blocked)-rgb\s*:/g) || []).length;
        ok(tokenLines === 3, 'each of the three coloured states has exactly one token definition', String(tokenLines));
        // rules for the calendar, the bar and the drawer's ok/error fields must take colour from the tokens, not the generic --success / --warning / --error
        const rules = []; const re = /([^{}]+)\{([^{}]*)\}/g; let m;
        for (const txt of Object.values(files)) while ((m = re.exec(txt))) if (/tm-cal|bk-date-status|bk-input--(ok|err)|bk-step-err|bk-venue-(selected|status)|bk-required|bk-slot-msg|bookingFormError|bk-success__(icon|status)/.test(m[1])) rules.push([m[1].trim().split('\n').pop(), m[2]]);
        const offenders = rules.filter(([, body]) => /var\(--(success|warning|error|danger)\b|#(10b981|f59e0b|ef4444)\b/i.test(body)).map(([sel]) => sel.slice(0, 60));
        ok(rules.length > 20 && offenders.length === 0, 'calendar / bar / drawer-status rules take their colours from --status-* tokens (' + rules.length + ' rules checked)', offenders.join(' | '));
    }

    await browser.close(); await d.support.stop();
    console.log(fails ? `\n${fails} FAILURE(S)` : '\nALL PASS'); process.exit(fails ? 1 : 0);
})().catch(async e => { console.error('ERR', e.stack || e.message); try { await d.support.stop(); } catch (_) {} process.exit(2); });
