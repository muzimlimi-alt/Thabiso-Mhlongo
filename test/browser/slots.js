// Performance slot picker
// Browser test for the public booking drawer (index.html). Boots the real app on an isolated database copy
// (test/support.js - SMTP mocked, never touches the real database), drives the REAL wizard in headless Chrome
// via puppeteer, and prints PASS/FAIL per check. Checks grouping, button semantics, roving tabindex, arrow keys, selection, duration changes and invalidated selections.
// Not part of `npm test` (that runner only loads test/*.test.js): run it with `npm run test:browser`.
const d = require('./drive');
let fails = 0;
const ok = (c, n, detail) => { if (!c) fails++; console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '\n        -> ' + detail)); };
(async () => {
    await d.support.start();
    const browser = await d.launch();
    const p = await d.openDrawer(browser, { w: 1440, h: 900 });
    await d.toStep3(p);
    const st = () => p.evaluate(() => ({
        from: document.getElementById('bkSlotFrom').value, to: document.getElementById('bkSlotTo').value, slot: document.getElementById('bookSlot').value,
        readout: document.getElementById('bkReadoutText').textContent.trim(),
        focus: document.activeElement && document.activeElement.getAttribute && document.activeElement.getAttribute('data-time'),
        selected: [...document.querySelectorAll('.bk-time-slot.selected')].map(c => c.dataset.time),
        msg: [...document.querySelectorAll('.bk-slot-msg')].map(m => m.textContent.trim()).join(' | ')
    }));

    const info = await p.evaluate(() => {
        const chips = [...document.querySelectorAll('#bkTimeSlotsGrid .bk-time-slot')];
        return { n: chips.length, allButtons: chips.every(c => c.tagName === 'BUTTON'),
            tab0: chips.filter(c => c.getAttribute('tabindex') === '0').map(c => c.dataset.time),
            groups: [...document.querySelectorAll('.bk-slot-group__title')].map(g => g.textContent),
            busyDisabled: chips.filter(c => c.classList.contains('busy')).every(c => c.disabled),
            firstLabel: chips[0].getAttribute('aria-label'), busyLabel: (chips.find(c => c.classList.contains('busy')) || {}).getAttribute && chips.find(c => c.classList.contains('busy')).getAttribute('aria-label'),
            legend: !!document.querySelector('.bk-slot-legend') };
    });
    ok(info.n > 10 && info.allButtons, 'slots are real <button>s', JSON.stringify(info));
    ok(info.groups.join() === 'Morning,Afternoon,Evening', 'grouped Morning / Afternoon / Evening', info.groups.join());
    ok(info.tab0.length === 1, 'roving tabindex: exactly one Tab stop for the picker', JSON.stringify(info.tab0));
    ok(/^09:00 to 10:00$/.test(info.firstLabel), 'chip label announces the time range', info.firstLabel);
    ok(info.busyDisabled && /unavailable/.test(info.busyLabel || ''), 'unavailable slots are disabled and say why', info.busyLabel);

    // keyboard
    await p.focus('#bkTimeSlotsGrid .bk-time-slot[data-time="09:00"]');
    await p.keyboard.press('ArrowRight');
    let s = await st(); ok(s.focus === '09:30', 'ArrowRight moves to the next start time', JSON.stringify(s));
    await p.keyboard.press('ArrowDown');
    s = await st(); ok(s.focus && s.focus >= '12:00', 'ArrowDown moves to the row below (next group)', JSON.stringify(s));
    await p.keyboard.press('End');
    s = await st(); ok(s.focus === '23:00', 'End goes to the last FREE slot (23:30 is after hours)', JSON.stringify(s));
    await p.keyboard.press('Home');
    s = await st(); ok(s.focus === '09:00', 'Home goes to the first slot', JSON.stringify(s));
    await p.keyboard.press('ArrowRight'); await p.keyboard.press('ArrowRight'); // 10:00
    await p.keyboard.press('Enter');
    s = await st();
    ok(s.from === '10:00' && s.to === '11:00' && s.slot === '10:00–11:00' && s.selected.join() === '10:00' && /10:00 to 11:00/.test(s.readout), 'Enter selects: hidden fields, readout and highlight agree', JSON.stringify(s));

    // duration change keeps a still-valid selection and updates the end
    await p.select('#bkReadoutDurSelect', '120'); await d.sleep(900);
    s = await st();
    ok(s.selected.join() === '10:00' && s.to === '12:00' && /10:00 to 12:00/.test(s.readout), 'changing duration keeps the selected start and moves the end', JSON.stringify(s));
    const endTxt = await p.evaluate(() => document.querySelector('.bk-time-slot[data-time="10:00"] .bk-time-slot__end').textContent);
    ok(endTxt === 'to 12:00', 'chip end times follow the duration', endTxt);

    // a selection that no longer fits is cleared, with an explanation
    await p.click('#bkTimeSlotsGrid .bk-time-slot[data-time="22:00"]');
    s = await st(); ok(s.from === '22:00' && s.to === '23:59', 'late slot selected at 2h (end clamps at 23:59 as before)', JSON.stringify(s));
    await p.select('#bkReadoutDurSelect', '60'); await d.sleep(900);
    await p.click('#bkTimeSlotsGrid .bk-time-slot[data-time="22:30"]');
    s = await st(); ok(s.from === '22:30' && s.to === '23:30', '22:30 selected at 1h', JSON.stringify(s));
    await p.select('#bkReadoutDurSelect', '120'); await d.sleep(900);   // 22:30 + 2h runs past working hours
    s = await st();
    ok(s.from === '' && s.slot === '' && s.selected.length === 0 && /doesn't fit/.test(s.msg), 'selection that stops fitting is cleared and explained', JSON.stringify(s));
    ok(/Select a time slot below/.test(s.readout), 'readout returns to the hint', s.readout);

    // pressing Next with no slot: error state reaches the grid
    await p.click('#bookNext3'); await d.sleep(600);
    const err = await p.evaluate(() => ({ err: !!document.getElementById('err-bookSlot').offsetParent, invalid: document.getElementById('bkTimeSlotsGrid').getAttribute('aria-invalid') }));
    ok(err.err && err.invalid === 'true', 'no slot -> inline error + aria-invalid on the picker', JSON.stringify(err));

    // all-day / custom
    await p.select('#bkReadoutDurSelect', '1440'); await d.sleep(900);
    const allday = await p.evaluate(() => { const c = document.querySelector('.bk-time-slot--allday'); return c ? { tag: c.tagName, text: c.textContent.trim() } : null; });
    ok(allday && allday.tag === 'BUTTON', 'Custom duration shows the full-day confirm button', JSON.stringify(allday));
    await p.click('.bk-time-slot--allday'); await d.sleep(300);
    s = await st(); ok(s.slot === 'All Day / Custom Hours' && s.selected.join() === 'All Day', 'full-day selection recorded', JSON.stringify(s));

    ok(p._errs.length === 0, 'no page errors', p._errs.join(' | '));
    await browser.close(); await d.support.stop();
    console.log(fails ? `\n${fails} FAILURE(S)` : '\nALL PASS'); process.exit(fails ? 1 : 0);
})().catch(async e => { console.error('ERR', e.stack || e.message); try { await d.support.stop(); } catch (_) {} process.exit(2); });
