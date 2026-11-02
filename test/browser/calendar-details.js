// Admin calendar: every item opens a details view first, and the view always fits the window (js/admin/calendar.js, css/admin/calendar.css).
//   * clicking a hold, a booking, a payment milestone or a public event opens its details - it never removes, cancels or changes anything;
//   * "Remove hold" is a button inside the hold's view and still asks before deleting (cancelling keeps the hold);
//   * the view stays inside the window at desktop, laptop, tablet and phone sizes (a bottom sheet on the phone), its footer actions stay
//     visible, a long description wraps and the body scrolls when it must, and Escape / the close button close it;
//   * a hold shows its full description, time, duration and source; a booking its client, time, venue and money; a milestone its amount and status.
// Boots the real app on an isolated database copy (test/support.js) and drives headless Chrome.
// Not part of `npm test`: run with `npm run test:browser` (needs PUPPETEER_EXECUTABLE_PATH).
const support = require('../support');
const puppeteer = require('puppeteer');
const { BASE, sleep, api, future } = support;
let fails = 0;
const ok = (c, n, detail) => { if (!c) fails++; console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '\n        -> ' + String(detail).slice(0, 500))); };

const LONG = 'Recording the audiobook for the brand campaign - studio booked all day, phone off, only urgent calls through the manager, back online the next morning';

(async () => {
    await support.start();
    let browser;
    try {
        await support.loginAs('administrator');
        const lr = await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'test.administrator@example.invalid', password: 'TestRunnerPass1!' }) });
        const raw = lr.headers.get('set-cookie');
        const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
        const longDay = day(40), timedDay = day(41);
        // two months can be on screen at once, so keep the test's items in one month: the month of longDay, any of its days
        const month = longDay.slice(0, 8) + '01';
        const sameMonth = (d) => d.slice(0, 7) === longDay.slice(0, 7);
        const a = await api('POST', '/api/admin/calendar/hold', { date: longDay, reason: LONG, block_type: 'unavailable' });
        const b = await api('POST', '/api/admin/calendar/hold', { date: timedDay, start_time: '14:00', end_time: '16:30', reason: 'Dentist', block_type: 'personal' });
        ok(a.status === 200 && b.status === 200 && sameMonth(timedDay), 'setup: a long all-day hold and a timed hold in the same month', JSON.stringify([a.status, b.status, longDay, timedDay]));

        const listed = await api('GET', '/api/admin/calendar/events?include=milestones');
        const firstOf = (t) => { const e = (listed.body || []).find(x => x.extendedProps && x.extendedProps.type === t && !x.extendedProps.isBgFill); return e ? String(e.start).slice(0, 10) : null; };
        const sample = { booking: firstOf('booking'), milestone: firstOf('milestone') };

        browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'], executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined });
        for (const [vp, w, h] of [['desktop', 1440, 900], ['laptop', 1100, 720], ['tablet', 820, 1100], ['phone', 390, 844]]) {
            const p = await (await browser.createBrowserContext()).newPage();
            await p.setViewport({ width: w, height: h });
            const errs = [], deletes = [];
            p.on('pageerror', e => errs.push(e.message.slice(0, 200)));
            p.on('request', r => { if (r.method() === 'DELETE' && /calendar\/hold/.test(r.url())) deletes.push(r.url()); });
            const [name, ...rest] = String(raw).split(';')[0].split('=');
            await p.setCookie({ name, value: rest.join('='), url: BASE });
            await p.setRequestInterception(true);
            p.on('request', r => /\/api\/admin\/maps-config/.test(r.url()) ? r.respond({ status: 200, contentType: 'application/json', body: '{"success":true,"key":""}' }) : r.continue());
            await p.goto(BASE + '/admin.html', { waitUntil: 'domcontentloaded', timeout: 90000 });
            await sleep(3500);
            await p.evaluate(() => window.switchTab('calendarAdmin'));
            await p.waitForFunction(() => typeof adminCalendar !== 'undefined' && adminCalendar, { timeout: 20000 });
            await p.evaluate((m) => { _calFilterState.milestones = true; adminCalendar.changeView(window.innerWidth < 576 ? 'listMonth' : 'dayGridMonth', m); adminCalendar.refetchEvents(); }, month);
            await sleep(2500);

            const open = async (kind, date) => {
                // each kind is looked for in the month it lives in (a booking from the copied data is not in the month of the test's holds)
                await p.evaluate((d) => adminCalendar.gotoDate(d), date || month);
                await sleep(900);
                const found = await p.evaluate((kind) => {
                    const els = [...document.querySelectorAll('#calendar .fc-event')].filter(e => e.offsetParent && !e.classList.contains('fc-bg-event'));
                    const t = (e) => (e.className.match(/fc-event--type-(\w+)/) || [])[1];
                    const el = kind === 'long' ? els.find(e => /Recording the audiobook/.test(e.textContent)) : kind === 'timed' ? els.find(e => /Dentist/.test(e.textContent)) : els.find(e => t(e) === kind);
                    if (!el) return false;
                    el.scrollIntoView({ block: 'center' }); el.setAttribute('data-pick', kind); return true;
                }, kind);
                if (!found) return null;
                await sleep(250);
                await (await p.$(`[data-pick="${kind}"]`)).click();
                await sleep(450);
                return p.evaluate(() => {
                    const pop = document.getElementById('calEventPopup');
                    if (!pop) return null;
                    const r = pop.getBoundingClientRect(), body = pop.querySelector('.cal-pop__body'), foot = pop.querySelector('.cal-pop__foot');
                    const fr = foot && foot.getBoundingClientRect();
                    return {
                        text: pop.innerText, inside: r.top >= 0 && r.left >= 0 && r.bottom <= window.innerHeight + 0.5 && r.right <= window.innerWidth + 0.5,
                        footInside: !foot || (fr.bottom <= window.innerHeight + 0.5 && fr.top >= 0), scrolls: body.scrollHeight > body.clientHeight + 1,
                        buttons: [...pop.querySelectorAll('.cal-pop__btn')].map(x => x.textContent.trim()), closeBox: (() => { const c = pop.querySelector('.cal-pop__close'); const cb = c && c.getBoundingClientRect(); return cb ? [Math.round(cb.width), Math.round(cb.height)] : null; })(),
                        sheet: r.bottom >= window.innerHeight - 1 && r.left <= 1 && r.right >= window.innerWidth - 1
                    };
                });
            };
            const closeWithEsc = async () => { await p.keyboard.press('Escape'); await sleep(200); return p.evaluate(() => !document.getElementById('calEventPopup')); };

            const long = await open('long');
            ok(!!long, `${vp}: clicking a hold opens its details`, 'no popup');
            if (long) {
                ok(deletes.length === 0, `${vp}: ...and nothing was removed by the click`, deletes.join());
                ok(long.text.includes(LONG), `${vp}: the full description is shown, not cut off`, long.text);
                ok(/All day/.test(long.text) && /The whole day/.test(long.text) && /Added in the admin portal/.test(long.text), `${vp}: an all-day hold says all day, the whole day and where it came from`, long.text);
                ok(long.inside && long.footInside, `${vp}: the view is completely inside the window, with its actions in view`, JSON.stringify(long));
                ok(long.buttons.includes('Remove hold'), `${vp}: removal is a separate, labelled button`, long.buttons.join());
                if (vp === 'phone') ok(long.sheet && long.closeBox && long.closeBox[0] >= 44, 'phone: a bottom sheet with a 44px close button', JSON.stringify(long));
                ok(await closeWithEsc(), `${vp}: Escape closes it`, '');
            }
            const timed = await open('timed');
            ok(!!timed && /2:00 PM/.test(timed.text) && /4:30 PM/.test(timed.text) && /2 h 30 min/.test(timed.text), `${vp}: a timed hold shows start, end and duration`, timed && timed.text);
            if (timed) await closeWithEsc();
            const booking = await open('booking', sample.booking);
            if (booking) {
                ok(booking.inside && booking.footInside, `${vp}: a booking's details are completely inside the window`, JSON.stringify(booking));
                ok(/Client/.test(booking.text) && /Date/.test(booking.text) && /Time|Payment/.test(booking.text) && booking.buttons.includes('View booking'), `${vp}: ...with client, date, payment and a View booking button`, booking.text);
                await closeWithEsc();
            } else ok(!sample.booking, `${vp}: a booking was on screen to click`, 'none');
            const ms = await open('milestone', sample.milestone);
            if (ms) {
                ok(ms.inside && /(Amount|Quote)/.test(ms.text) && /(Payment due|Quote expiry)/.test(ms.text), `${vp}: a milestone's details are inside the window and show its type`, ms.text);
                await closeWithEsc();
            }

            // Remove hold: asks first; cancelling keeps the hold
            await open('timed');
            await p.evaluate(() => [...document.querySelectorAll('#calEventPopup .cal-pop__btn')].find(b => /Remove hold/.test(b.textContent)).click());
            await sleep(700);
            const asked = await p.evaluate(() => /Remove this hold/.test(document.body.innerText));
            ok(asked && deletes.length === 0, `${vp}: Remove hold asks for confirmation before anything is deleted`, `asked=${asked} deletes=${deletes.length}`);
            await p.evaluate(() => { const c = [...document.querySelectorAll('button')].find(b => /^\s*cancel\s*$/i.test(b.textContent) && b.offsetParent); if (c) c.click(); });
            await sleep(500);
            ok(deletes.length === 0, `${vp}: cancelling the confirmation deletes nothing`, deletes.join());
            ok(errs.length === 0, `${vp}: no page errors`, errs.join(' | '));
            await p.close();
        }
        // and the confirmed removal really does remove it
        const holds = await api('GET', '/api/admin/calendar/events');
        const dentist = (holds.body || []).find(e => e.title === 'Dentist');
        ok(!!dentist, 'the hold is still there after every cancelled confirmation', '');
        const del = await api('DELETE', '/api/admin/calendar/hold/' + dentist.extendedProps.dbId);
        ok(del.status === 200, 'removing a hold still works through the API', del.status);
    } finally {
        if (browser) await browser.close();
        await support.stop();
    }
    console.log(fails ? `\n${fails} calendar-details check(s) FAILED` : '\nAll calendar details browser checks passed');
    process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
