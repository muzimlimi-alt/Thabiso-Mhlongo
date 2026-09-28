// Venue search, dropdowns, persistence, submit
// Browser test for the public booking drawer (index.html). Boots the real app on an isolated database copy
// (test/support.js - SMTP mocked, never touches the real database), drives the REAL wizard in headless Chrome
// via puppeteer, and prints PASS/FAIL per check. Places endpoints and the final submit are mocked.
// Not part of `npm test` (that runner only loads test/*.test.js): run it with `npm run test:browser`.
const path = require('path');
const d = require('./drive');
let fails = 0;
const ok = (c, n, detail) => { if (!c) fails++; console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '\n        -> ' + detail)); };
const json = (r, status, body) => r.respond({ status, contentType: 'application/json', body: JSON.stringify(body) });

const PLACE = { result: { name: 'Khabo Hall', formatted_address: '12 Main Rd, Sandton, Johannesburg, 2196, South Africa',
    address_components: [{ long_name: 'Johannesburg', types: ['locality'] }, { long_name: 'Gauteng', types: ['administrative_area_level_1'] }, { long_name: 'South Africa', types: ['country'] }] } };

(async () => {
    await d.support.start();
    const browser = await d.launch();
    let acCalls = [], submitted = null;
    const mocks = [
        { test: /\/api\/public\/places\/autocomplete/, respond: r => {
            const q = new URL(r.url()).searchParams.get('input'); acCalls.push(q);
            if (q.startsWith('zzz')) return json(r, 200, { predictions: [] });
            if (q.startsWith('limit')) return json(r, 429, { error: 'rate' });
            return json(r, 200, { predictions: [{ place_id: 'p1', main_text: 'Khabo Hall', secondary_text: 'Sandton, Johannesburg' }, { place_id: 'p2', main_text: 'Khabo Arena', secondary_text: 'Soweto' }] });
        } },
        { test: /\/api\/public\/places\/details/, respond: r => json(r, 200, PLACE) },
    ];
    const p = await d.openDrawer(browser, { w: 1440, h: 900, mocks, onSubmit: b => { submitted = b; } });
    await d.toStep3(p);
    const val = sel => p.$eval(sel, e => e.value);
    const vis = sel => p.evaluate(s => { const e = document.querySelector(s); return !!(e && e.offsetParent); }, sel);

    // ── Enter advances the wizard instead of firing a hidden submit ──
    {
        const q = await d.openDrawer(browser, { w: 1440, h: 900, mocks });
        await d.completeStep1(q);
        await q.type('#bookName', 'Enter Tester'); await q.type('#bookEmail', 'enter.test@example.invalid'); await q.type('#bookCell', '0821234567');
        await q.keyboard.press('Enter'); await d.sleep(1800);
        const st = await q.evaluate(() => ({ step3: document.getElementById('bookStep3').classList.contains('active'), err: !!document.getElementById('bookingFormError').offsetParent }));
        ok(st.step3 && !st.err, 'Enter in a step-2 field advances to step 3 (no hidden submit)', JSON.stringify(st));
        await q.close();
    }

    // ── venue combobox ──
    const attrs = await p.$eval('#bookLocation', e => ({ role: e.getAttribute('role'), exp: e.getAttribute('aria-expanded'), ctl: e.getAttribute('aria-controls'), label: !!document.querySelector('label[for="bookLocation"]') }));
    ok(attrs.role === 'combobox' && attrs.exp === 'false' && attrs.ctl === 'venueDropdown' && attrs.label, 'venue field is a labelled combobox controlling the list', JSON.stringify(attrs));
    await p.type('#bookLocation', 'kh');
    await d.sleep(700);
    ok(acCalls.length === 0 && /Keep typing/.test(await p.$eval('#venueStatus', e => e.textContent)), 'under 3 characters: no request, a hint instead', JSON.stringify(acCalls));
    await p.type('#bookLocation', 'a');                           // "kha"
    await d.sleep(1200);
    const dd = await p.evaluate(() => { const l = document.getElementById('venueDropdown'); const cs = getComputedStyle(l); const r = l.getBoundingClientRect();
        return { shown: !!l.offsetParent, opts: [...l.querySelectorAll('[role=option]')].length, pos: cs.position, bg: cs.backgroundColor, z: cs.zIndex, exp: document.getElementById('bookLocation').getAttribute('aria-expanded'), inViewport: r.left >= 0 && r.right <= innerWidth };
    });
    ok(dd.shown && dd.opts === 2 && dd.exp === 'true', 'suggestions appear as role=option items; aria-expanded true', JSON.stringify(dd));
    ok(dd.pos === 'absolute' && dd.bg !== 'rgba(0, 0, 0, 0)' && Number(dd.z) > 10 && dd.inViewport, 'suggestion list is styled (absolute, opaque, above the sticky footer, on screen)', JSON.stringify(dd));
    await p.keyboard.press('ArrowDown'); await p.keyboard.press('ArrowDown');
    let ad = await p.evaluate(() => ({ active: document.querySelector('.vdd-active') && document.querySelector('.vdd-active').textContent, ref: document.getElementById('bookLocation').getAttribute('aria-activedescendant'), id: (document.querySelector('.vdd-active') || {}).id }));
    ok(/Arena/.test(ad.active) && ad.ref === ad.id, 'ArrowDown moves the highlight and updates aria-activedescendant', JSON.stringify(ad));
    await p.keyboard.press('ArrowUp');
    await p.keyboard.press('Enter'); await d.sleep(900);
    ok(await val('#bookLocation') === 'Khabo Hall' && await val('#venuePlaceId') === 'p1', 'Enter chooses the highlighted venue (name + place id stored)', `${await val('#bookLocation')} / ${await val('#venuePlaceId')}`);
    ok(await val('#bookAddress') === '12 Main Rd, Sandton, Johannesburg, 2196, South Africa' && await val('#bookCity') === 'Johannesburg' && await val('#bookCountry') === 'South Africa', 'address, city and country filled from the place', `${await val('#bookAddress')} | ${await val('#bookCity')} | ${await val('#bookCountry')}`);
    const sel = await p.evaluate(() => ({ shown: !!document.getElementById('venueSelected').offsetParent, text: document.getElementById('venueSelected').textContent.trim(), listShown: !!document.getElementById('venueDropdown').offsetParent, toggle: !!document.querySelector('.manual-address-toggle-wrap').offsetParent, step3: document.getElementById('bookStep3').classList.contains('active') }));
    ok(sel.shown && /12 Main Rd/.test(sel.text) && !sel.listShown && sel.toggle && sel.step3, 'chosen address is confirmed on screen; list closed; Enter did NOT submit/advance the wizard', JSON.stringify(sel));
    ok(submitted === null, 'no booking was submitted by pressing Enter in the venue field', JSON.stringify(submitted));

    // cache: retyping the same query does not spend another request
    const callsBefore = acCalls.length;
    await p.click('#bookLocation', { clickCount: 3 }); await p.keyboard.press('Backspace');
    await d.sleep(300);
    const cleared = await p.evaluate(() => ({ place: document.getElementById('venuePlaceId').value, addr: document.getElementById('bookAddress').value, city: document.getElementById('bookCity').value, box: !!document.getElementById('venueSelected').offsetParent }));
    ok(cleared.place === '' && cleared.addr === '' && cleared.city === '' && !cleared.box, 'editing the venue clears the place id and the address IT filled in', JSON.stringify(cleared));
    await p.type('#bookLocation', 'kha'); await d.sleep(900);
    ok(acCalls.length === callsBefore + 0 || acCalls.slice(callsBefore).every(q => q.length < 3), 'a repeated search is served from the cache (no new request)', JSON.stringify(acCalls.slice(callsBefore)));
    ok((await p.$$eval('#venueDropdown [role=option]', n => n.length)) === 2, 'cached suggestions still render', '');

    // what the visitor typed themselves must survive a venue edit
    await p.keyboard.press('Enter'); await d.sleep(900);            // pick Khabo Hall again
    await p.click('#toggleManualAddress'); await d.sleep(500);        // open the manual-address row (the visitor's route to editing it)
    await p.type('#bookAddress', ' Unit 4');                        // visitor amends the address
    await p.type('#bookLocation', 'X'); await d.sleep(200);
    const kept = await p.evaluate(() => ({ addr: document.getElementById('bookAddress').value, city: document.getElementById('bookCity').value }));
    ok(/Unit 4/.test(kept.addr) && kept.city === '' , 'a hand-edited address survives a venue edit (auto-filled city is cleared)', JSON.stringify(kept));

    // no results / rate limited: explained inline, no toast
    await p.click('#bookLocation', { clickCount: 3 }); await p.keyboard.press('Backspace'); await p.type('#bookLocation', 'zzzz'); await d.sleep(1300);
    ok(/No matching venues/.test(await p.$eval('#venueStatus', e => e.textContent)) && await vis('.manual-address-toggle-wrap'), 'no results: says so and offers manual entry', await p.$eval('#venueStatus', e => e.textContent));
    await p.click('#bookLocation', { clickCount: 3 }); await p.keyboard.press('Backspace'); await p.type('#bookLocation', 'limit'); await d.sleep(1300);
    const lim = await p.evaluate(() => ({ status: document.getElementById('venueStatus').textContent, toasts: document.querySelectorAll('.tm-toast').length }));
    ok(/Too many searches/.test(lim.status) && lim.toasts === 0, 'rate limited (429): explained inline with no extra error toast', JSON.stringify(lim));

    // set a real venue for the rest of the flow
    await p.click('#bookLocation', { clickCount: 3 }); await p.keyboard.press('Backspace'); await p.type('#bookLocation', 'kha'); await d.sleep(900);
    await p.keyboard.press('Enter'); await d.sleep(900);
    await p.select('#bookVenueType', 'Outdoor');

    // ── How did you hear about us ──
    const ha = await p.evaluate(() => { const e = document.getElementById('bookHeardAbout'); return { tag: e.tagName, opts: e.options.length, first: e.options[0].textContent, label: !!document.querySelector('label[for="bookHeardAbout"]'), wrap: !!document.getElementById('bookHeardAboutOtherWrap').offsetParent }; });
    ok(ha.tag === 'SELECT' && ha.opts === 13 && ha.first === 'Select...' && ha.label && !ha.wrap, 'How did you hear about us is a labelled dropdown with a placeholder; text box hidden', JSON.stringify(ha));
    const haStyle = await p.evaluate(() => { const a = getComputedStyle(document.getElementById('bookHeardAbout')), b = getComputedStyle(document.getElementById('bookBudget')); return { h: [a.height, b.height], bg: [a.backgroundColor, b.backgroundColor], pad: [a.paddingLeft, b.paddingLeft], font: [a.fontSize, b.fontSize] }; });
    ok(haStyle.h[0] === haStyle.h[1] && haStyle.bg[0] === haStyle.bg[1] && haStyle.pad[0] === haStyle.pad[1] && haStyle.font[0] === haStyle.font[1], 'styled identically to the other dropdowns (Budget)', JSON.stringify(haStyle));
    await p.select('#bookHeardAbout', 'Instagram');
    ok(!(await vis('#bookHeardAboutOtherWrap')), 'a normal choice keeps the text box hidden', '');
    await p.select('#bookHeardAbout', 'Other'); await d.sleep(200);
    ok((await vis('#bookHeardAboutOtherWrap')) && await p.evaluate(() => document.activeElement.id) === 'bookHeardAboutOther', '"Other" reveals a text box and focuses it', await p.evaluate(() => document.activeElement.id));
    await p.type('#bookHeardAboutOther', 'a radio ad');

    // ── slot + sticky footer overlap ──
    await p.evaluate(() => { document.querySelector('.bk-time-slot:not(.busy)[data-time="10:00"]').click(); });
    await d.sleep(300);
    const ov = await p.evaluate(async () => {
        const body = document.querySelector('#bookingDrawer .atl-drawer__body'); const foot = document.querySelector('#bookStep3 .bk-nav-row');
        const fz = getComputedStyle(foot).zIndex, iz = getComputedStyle(document.querySelector('#bookStep3 .bk-field-ico')).zIndex;
        let leaks = 0, samples = 0;
        for (let y = 0; y < body.scrollHeight; y += 60) {
            body.scrollTop = y; await new Promise(r => setTimeout(r, 25));
            const fr = foot.getBoundingClientRect();
            for (let x = fr.left + 8; x < fr.right - 8; x += 24) {
                const e = document.elementFromPoint(x, fr.top + fr.height / 2); samples++;
                if (e && !foot.contains(e) && e !== foot) leaks++;
            }
        }
        body.scrollTop = 0;
        return { fz, iz, leaks, samples };
    });
    ok(Number(ov.fz) > Number(ov.iz) && ov.leaks === 0, 'sticky footer stays above the field icons while scrolling (nothing paints over it)', JSON.stringify(ov));

    // ── validation on step 3: missing venue ──
    await p.evaluate(() => { $('#bookLocation').val('').trigger('input'); });
    await d.sleep(300);
    await p.click('#bookNext3'); await d.sleep(600);
    const v3 = await p.evaluate(() => ({ err: !!document.getElementById('err-bookLocation').offsetParent, invalid: document.getElementById('bookLocation').getAttribute('aria-invalid'), focus: document.activeElement.id }));
    ok(v3.err && v3.invalid === 'true' && v3.focus === 'bookLocation', 'missing venue: inline error, aria-invalid, focus moves to the field', JSON.stringify(v3));
    // choose the venue again (also restores place id)
    await p.type('#bookLocation', 'kha'); await d.sleep(900); await p.keyboard.press('Enter'); await d.sleep(900);

    // ── draft persistence: close, reopen ──
    const beforeClose = await p.evaluate(() => ({ from: document.getElementById('bkSlotFrom').value, to: document.getElementById('bkSlotTo').value, vt: document.getElementById('bookVenueType').value, pid: document.getElementById('venuePlaceId').value, ha: document.getElementById('bookHeardAbout').value, hao: document.getElementById('bookHeardAboutOther').value }));
    ok(beforeClose.from === '10:00' && beforeClose.pid === 'p1' && beforeClose.vt === 'Outdoor' && beforeClose.ha === 'Other', 'state before closing the drawer', JSON.stringify(beforeClose));
    await p.evaluate(() => window.closeAtlDrawer('bookingDrawer')); await d.sleep(1500);
    await p.evaluate(() => window.openAtlDrawer('bookingDrawer')); await d.sleep(2500);
    const after = await p.evaluate(() => ({ from: document.getElementById('bkSlotFrom').value, to: document.getElementById('bkSlotTo').value, slot: document.getElementById('bookSlot').value,
        chip: (document.querySelector('.bk-time-slot.selected') || {}).dataset && document.querySelector('.bk-time-slot.selected').dataset.time,
        vt: document.getElementById('bookVenueType').value, pid: document.getElementById('venuePlaceId').value, ha: document.getElementById('bookHeardAbout').value, hao: document.getElementById('bookHeardAboutOther').value,
        haWrap: getComputedStyle(document.getElementById('bookHeardAboutOtherWrap')).display !== 'none', sel: document.getElementById('venueSelected').textContent.trim(), loc: document.getElementById('bookLocation').value }));
    ok(after.from === '10:00' && after.to === '11:00' && /10:00/.test(after.slot) && after.chip === '10:00', 'reopened drawer restores the chosen slot (fields AND highlighted chip)', JSON.stringify(after));
    ok(after.vt === 'Outdoor' && after.pid === 'p1' && /12 Main Rd/.test(after.sel) && after.loc === 'Khabo Hall', 'reopened drawer restores venue type, place id and the confirmed address', JSON.stringify(after));
    ok(after.ha === 'Other' && after.hao === 'a radio ad' && after.haWrap, 'reopened drawer restores "Other" + its text', JSON.stringify(after));

    // a draft saved before the dropdown existed (free text) is not lost
    await p.evaluate(() => { const dr = JSON.parse(localStorage.getItem('bkDraft')); dr.fields.bookHeardAbout = 'a friend at church'; dr.fields.bookHeardAboutOther = ''; localStorage.setItem('bkDraft', JSON.stringify(dr)); });
    await p.evaluate(() => window.closeAtlDrawer('bookingDrawer')); await d.sleep(1200);
    await p.evaluate(() => { const dr = JSON.parse(localStorage.getItem('bkDraft') || '{}'); dr.fields = dr.fields || {}; dr.fields.bookHeardAbout = 'a friend at church'; dr.fields.bookHeardAboutOther = ''; localStorage.setItem('bkDraft', JSON.stringify(dr)); });
    await p.evaluate(() => window.openAtlDrawer('bookingDrawer')); await d.sleep(2500);
    const legacy = await p.evaluate(() => ({ ha: document.getElementById('bookHeardAbout').value, hao: document.getElementById('bookHeardAboutOther').value }));
    ok(legacy.ha === 'Other' && legacy.hao === 'a friend at church', 'an old free-text draft answer is kept under "Other"', JSON.stringify(legacy));
    await p.evaluate(() => { $('#bookHeardAbout').val('Other').trigger('change'); $('#bookHeardAboutOther').val('a radio ad'); });

    // ── review + submit ──
    await p.evaluate(() => { document.getElementById('bookStep3').classList.contains('active') || window._bkGoTo(3); });
    await p.evaluate(() => window._bkGoTo(3)); await d.sleep(500);
    await p.click('#bookNext3'); await d.sleep(800);
    const review = await p.evaluate(() => { const rows = {}; document.querySelectorAll('.book-review-row').forEach(r => { rows[r.children[0].textContent.trim()] = r.children[1].textContent.trim(); }); return { step4: document.getElementById('bookStep4').classList.contains('active'), rows }; });
    ok(review.step4, 'valid step 3 advances to the review step', JSON.stringify(review).slice(0, 200));
    ok(/^\w+day, \d{1,2} \w+ \d{4}$/.test(review.rows['Event Date'] || ''), 'review shows the date in words, not ISO', review.rows['Event Date']);
    ok(review.rows['How You Heard About Us'] === 'Other: a radio ad' && review.rows['Performance Slot'] === '10:00–11:00' && review.rows['Venue / Location'] === 'Khabo Hall', 'review shows heard-about, slot and venue as entered', JSON.stringify(review.rows));
    await p.click('#bookPopia');
    await p.click('#bookSubmitBtn');
    await p.waitForFunction(() => document.getElementById('bookSuccessScreen') && document.getElementById('bookSuccessScreen').offsetParent, { timeout: 20000 });
    ok(submitted && submitted.heard_about === 'Other: a radio ad' && submitted.venue_type === 'Outdoor' && submitted.venuePlaceId === 'p1' && /^10:00.11:00$/.test(submitted.performance_slot) && submitted.venue_address.includes('12 Main Rd') && submitted.event_location === 'Khabo Hall',
        'submitted payload carries heard_about, venue type, place id, slot, address and venue name', JSON.stringify(submitted));
    ok(await p.$eval('#bookSuccessId', e => /#4242/.test(e.textContent)), 'success screen shows the booking reference', '');
    const draftGone = await p.evaluate(() => localStorage.getItem('bkDraft'));
    ok(draftGone === null, 'draft is cleared after a successful submission', String(draftGone).slice(0, 80));
    ok(p._errs.length === 0, 'no page errors during the whole flow', p._errs.join(' | '));
    await p.close();

    // ── mobile ──
    const m = await d.openDrawer(browser, { w: 390, h: 844, mocks });
    await d.toStep3(m);
    await m.type('#bookLocation', 'kha'); await d.sleep(1300);
    const mob = await m.evaluate(() => { const l = document.getElementById('venueDropdown').getBoundingClientRect(); const dr = document.getElementById('bookingDrawer').getBoundingClientRect();
        return { listInside: l.left >= dr.left - 1 && l.right <= dr.right + 1, opts: document.querySelectorAll('#venueDropdown [role=option]').length, overflowX: document.documentElement.scrollWidth - innerWidth, drawerScrollX: document.querySelector('#bookingDrawer .atl-drawer__body').scrollWidth - document.querySelector('#bookingDrawer .atl-drawer__body').clientWidth,
            cols: getComputedStyle(document.querySelector('.bk-slot-group__grid')).gridTemplateColumns.split(' ').length, chipH: Math.round(document.querySelector('.bk-time-slot').getBoundingClientRect().height),
            tap: [...document.querySelectorAll('#venueDropdown .vdd-item')].map(e => Math.round(e.getBoundingClientRect().height)) }; });
    ok(mob.listInside && mob.opts === 2 && mob.overflowX <= 0 && mob.drawerScrollX <= 0, 'phone: suggestions fit inside the drawer, no horizontal scroll', JSON.stringify(mob));
    ok(mob.cols === 3 && mob.chipH >= 44 && mob.tap.every(h => h >= 40), 'phone: 3-column slot grid, chips >= 44px tall, suggestion rows are comfortable to tap', JSON.stringify(mob));
    await m.close();

    await browser.close(); await d.support.stop();
    console.log(fails ? `\n${fails} FAILURE(S)` : '\nALL PASS'); process.exit(fails ? 1 : 0);
})().catch(async e => { console.error('ERR', e.stack || e.message); try { await d.support.stop(); } catch (_) {} process.exit(2); });
