// Public homepage sections: Footprint / Management Team centering, Gallery / Past Shows pagination
// Browser test for index.html's Footprint, Management Team, Gallery and Events sections. Boots the real
// app on an isolated database copy (test/support.js), seeds through the real admin APIs, and drives real
// Chrome via puppeteer. Not part of `npm test`: run it with `npm run test:browser`.
const d = require('./drive');
const { api, pub, sleep } = d.support;
// A 1x1 transparent pixel as a data: URI — the app's CSP img-src allows data: but not arbitrary third-party
// hosts, so seeded test photos must be self-contained rather than e.g. a placehold.co URL.
const PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
let fails = 0;
const ok = (c, n, detail) => { if (!c) fails++; console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '\n        -> ' + detail)); };

async function openHome(browser, vp) {
    const ctx = await browser.createBrowserContext();
    const p = await ctx.newPage();
    await p.setViewport(Object.assign({ width: 1440, height: 1000 }, vp));
    p._errs = [];
    p.on('pageerror', e => p._errs.push(e.message.slice(0, 160)));
    p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) p._errs.push('console: ' + m.text().slice(0, 140)); });
    await p.goto(d.BASE + '/', { waitUntil: 'networkidle0', timeout: 60000 });
    await sleep(1200);
    await p.evaluate(() => { const x = document.getElementById('cookieRejectAll'); if (x) x.click(); });
    await sleep(300);
    return p;
}

// The View More / View Less buttons stay in the DOM the whole time (tmPaginateGrid toggles a class,
// not their presence) — so an existence check (page.$) can't tell "visible" from "hidden". This is
// the one true visibility test: exists AND actually rendered (not display:none, whichever CSS put it
// there). Puppeteer's own page.click() would otherwise happily "succeed" clicking a display:none
// button (dispatches the event without ever needing a real, visible target), silently doing nothing
// forever — this is what turned a real bug (below) into an infinite loop the first time around.
async function visible(p, sel) {
    return p.evaluate(sel => { const e = document.querySelector(sel); return !!e && !!e.offsetParent && getComputedStyle(e).display !== 'none'; }, sel);
}

// Horizontal centering, measured on the ACTUAL rendered content, not a wrapping element. A grid or
// flex container that isn't full of content still reports its OWN box as spanning 100% of its parent
// (1fr tracks / flex-basis:auto both do that by default) even when what's visibly inside it sits off
// to one side — so measuring the container itself would pass even with the centering bug still
// present. `itemsSel` is a selector matching every item to include (comma-separated for more than
// one, e.g. the team's photo cluster AND its member list); the check is the gap on each side between
// the union of their bounding boxes and `withinSel`.
async function centering(p, itemsSel, withinSel) {
    return p.evaluate((itemsSel, withinSel) => {
        const els = Array.from(document.querySelectorAll(itemsSel));
        const box = document.querySelector(withinSel);
        if (!els.length || !box) return null;
        const rects = els.map(e => e.getBoundingClientRect());
        const left = Math.min.apply(null, rects.map(r => r.left));
        const right = Math.max.apply(null, rects.map(r => r.right));
        const b = box.getBoundingClientRect();
        return { leftGap: left - b.left, rightGap: b.right - right, contentWidth: right - left, boxWidth: b.width };
    }, itemsSel, withinSel);
}

(async () => {
    await d.support.start();
    const browser = await d.launch();

    // ══════════ FOOTPRINT: centered regardless of how many flags there are ══════════
    // The checked-in DB always has a handful of countries (well under a full row at 1440px) — exactly
    // the "fewer items than fit one row" case the fix targets.
    {
        const p = await openHome(browser, { width: 1440, height: 1000 });
        await p.waitForSelector('#footprintGrid .fp-card', { timeout: 15000 });
        const c = await centering(p, '#footprintGrid .fp-card', '#footprint .tm-container');
        ok(!!c && Math.abs(c.leftGap - c.rightGap) <= 2, 'Footprint: flag cards sit centered as a group (equal left/right margins)', JSON.stringify(c));
        const cs = await p.evaluate(() => getComputedStyle(document.getElementById('footprintGrid')).justifyContent);
        ok(cs === 'center', 'Footprint: grid centers its row of tracks (justify-content: center)', cs);
        ok(p._errs.length === 0, 'Footprint: no page errors', p._errs.join(' | '));
        await p.close();
    }

    // ══════════ MANAGEMENT TEAM: centered at both the row (desktop) and stacked (mobile) layouts ══════════
    {
        const p = await openHome(browser, { width: 1440, height: 1000 });
        await p.waitForSelector('#teamList .team-row', { timeout: 15000 });
        // Against #teamLayout itself (not the wider .tm-container): #teamLayout's own box is ALWAYS
        // centered in the section (max-width + margin:auto, regardless of what's inside it), so
        // comparing the pair to .tm-container can't tell "the pair is a centered, compact cluster"
        // apart from "the list stretched with flex:1 all the way to #teamLayout's own edges, which
        // happens to make the union equal #teamLayout's box too" — the exact bug this guards against.
        // Requiring the gaps to be equal AND clearly non-zero rules that stretched case back out.
        const layout = await centering(p, '#teamPhotoGrid, #teamList', '#teamLayout');
        ok(!!layout && Math.abs(layout.leftGap - layout.rightGap) <= 2 && layout.leftGap > 15,
            'Team (desktop): photos+list pair sits centered as a compact cluster (not stretched edge-to-edge)', JSON.stringify(layout));
        const rowMode = await p.evaluate(() => { const cs = getComputedStyle(document.getElementById('teamLayout')); return { dir: cs.flexDirection, jc: cs.justifyContent }; });
        ok(rowMode.dir === 'row' && rowMode.jc === 'center', 'Team (desktop): row layout centers its content (not stretched to one side)', JSON.stringify(rowMode));
        // The list must NOT be claiming all the leftover width any more (that's what broke centering).
        const listGrow = await p.evaluate(() => getComputedStyle(document.getElementById('teamList')).flexGrow);
        ok(listGrow === '0', 'Team (desktop): the member list no longer stretches to fill the row (flex-grow: 0)', listGrow);
        ok(p._errs.length === 0, 'Team (desktop): no page errors', p._errs.join(' | '));
        await p.close();
    }
    {
        const p = await openHome(browser, { width: 390, height: 900 });
        await p.waitForSelector('#teamList .team-row', { timeout: 15000 });
        const photos = await centering(p, '#teamPhotoGrid', '#team .tm-container');
        ok(!!photos && Math.abs(photos.leftGap - photos.rightGap) <= 3, 'Team (mobile, stacked): photo cluster is centered', JSON.stringify(photos));
        ok(p._errs.length === 0, 'Team (mobile): no page errors', p._errs.join(' | '));
        await p.close();
    }

    // Drives a paginated grid through: reveal everything (More, clicked while VISIBLE — the button
    // stays in the DOM even once hidden, see `visible()` above, so every loop here bails on
    // visibility, never mere existence, or it would click a display:none button forever and do
    // nothing), collapse back to one page (Less), then reveal again. Shared by the Gallery and Past
    // Shows blocks below so both get identical coverage. Returns the final total item count.
    async function exhaustThenCollapse(p, sectionSel, countFn, label, pageSize) {
        pageSize = pageSize || 8;
        const moreSel = sectionSel + ' .tm-view-more', lessSel = sectionSel + ' .tm-view-less';

        ok(!(await visible(p, lessSel)), label + ': no "View Less" yet at the first page', '');
        var clicks = 0;
        while (await visible(p, moreSel)) {
            const before = await countFn();
            await p.click(moreSel);
            await sleep(300);
            const after = await countFn();
            ok(after > before && after - before <= pageSize, label + ': clicking More reveals up to ' + pageSize + ' more (' + before + ' -> ' + after + ')', String(after));
            clicks++;
            if (clicks > 10) { ok(false, label + ': View More did not exhaust after 10 clicks', ''); break; }
        }
        const total = await countFn();
        ok(clicks >= 1, label + ': took at least one click to reach the end', String(clicks));
        ok(await visible(p, lessSel), label + ': "View Less" is offered once more than one page is showing', '');
        const lessText = await p.$eval(lessSel, e => e.textContent.trim()).catch(() => '');
        ok(/view less/i.test(lessText), label + ': button says something like "View Less"', lessText);

        await p.click(lessSel);
        await sleep(300);
        const collapsed = await countFn();
        ok(collapsed === pageSize, label + ': "View Less" collapses straight back to ' + pageSize + ' (not one page back)', `${collapsed} (started from ${total})`);
        ok(await visible(p, moreSel), label + ': "View More" is back once collapsed (there\'s more to reveal again)', '');
        ok(!(await visible(p, lessSel)), label + ': "View Less" hides itself once back at the first page', '');

        // Resume revealing — More must carry on from the collapsed page, not from wherever it left off.
        await p.click(moreSel);
        await sleep(300);
        const resumed = await countFn();
        ok(resumed === Math.min(total, pageSize * 2), label + ': clicking More after collapsing resumes the next page normally', `${resumed}`);

        // Finish revealing everything again (bounded — see the comment on `visible()`), so callers can
        // rely on "every item shown" afterwards.
        for (let i = 0; i < 10 && (await visible(p, moreSel)); i++) { await p.click(moreSel); await sleep(300); }
        ok(!(await visible(p, moreSel)), label + ': "View More" is gone once every item is shown', '');
        ok(await countFn() === total, label + ': every item is shown once "View More" is gone', `${await countFn()} / ${total}`);

        return total;
    }

    // ══════════ GALLERY: 8 at a time, View More / View Less ══════════
    {
        // Seed well past one page regardless of how many the checked-in DB already has.
        for (let i = 0; i < 12; i++) {
            const r = await api('POST', '/api/admin/gallery', { title: 'PS test photo ' + i, fallback_url: PIXEL });
            ok(r.status === 200 && r.body.success, 'seed: gallery photo ' + i, JSON.stringify(r.body));
        }

        const p = await openHome(browser, { width: 1440, height: 1000 });
        await p.waitForSelector('#dynamicGalleryGrid .insta-item', { timeout: 15000 });
        const count = () => p.$$eval('#dynamicGalleryGrid .insta-item', els => els.length);

        ok(await count() === 8, 'Gallery: shows exactly 8 to start, however many photos exist', String(await count()));
        const btnText = await p.$eval('#gallery .tm-view-more', e => e.textContent.trim());
        ok(/view more/i.test(btnText), 'Gallery: button says something like "View More"', btnText);

        await exhaustThenCollapse(p, '#gallery', count, 'Gallery');

        // Lightbox re-scans the grid at click time — must see every revealed photo, not just the first 8.
        await p.click('#dynamicGalleryGrid .insta-item:last-child img');
        await sleep(200);
        const lbVisible = await p.evaluate(() => getComputedStyle(document.getElementById('lightboxOverlay')).display !== 'none');
        ok(lbVisible, 'Gallery: lightbox opens on a photo that only exists after "View More"', '');
        await p.click('.lightbox-close');
        ok(p._errs.length === 0, 'Gallery: no page errors', p._errs.join(' | '));
        await p.close();
    }

    // ══════════ PAST SHOWS: 8 at a time, View More / View Less; UPCOMING is never paginated ══════════
    {
        for (let i = 1; i <= 12; i++) {
            const ds = '2015-02-' + String(i).padStart(2, '0');
            const r = await api('POST', '/api/admin/events', { event_title: 'PS past show ' + i, event_datetime: ds + 'T19:00:00', venue_name: 'Test Hall', sync_to_gcal: false });
            ok(r.status === 200 && r.body.success, 'seed: past event ' + i, JSON.stringify(r.body));
        }
        for (let i = 1; i <= 10; i++) {
            const ds = '2099-03-' + String(i).padStart(2, '0');
            const r = await api('POST', '/api/admin/events', { event_title: 'PS upcoming show ' + i, event_datetime: ds + 'T19:00:00', venue_name: 'Test Hall', sync_to_gcal: false });
            ok(r.status === 200 && r.body.success, 'seed: upcoming event ' + i, JSON.stringify(r.body));
        }
        const all = (await pub('GET', '/api/public/events')).body;
        const now = Date.now();
        const totalPast = all.filter(e => e.event_datetime && !isNaN(new Date(e.event_datetime)) && new Date(e.event_datetime).getTime() < now).length;
        const totalUpcoming = all.length - totalPast;

        const p = await openHome(browser, { width: 1440, height: 1000 });
        await p.waitForSelector('#pastEventsGrid .ev-card', { timeout: 15000 });
        const pastCount = () => p.$$eval('#pastEventsGrid .ev-card', els => els.length);
        const upCount = () => p.$$eval('#upcomingEventsGrid .ev-card', els => els.length);

        ok(await pastCount() === 8, 'Past Shows: shows exactly 8 to start', String(await pastCount()));
        ok(await upCount() === totalUpcoming, 'Upcoming Shows: shows ALL of them, never paginated', `${await upCount()} / ${totalUpcoming}`);
        // populateGrid() only ever calls tmPaginateGrid (which creates the wrap) when opts.paginate is
        // set — Upcoming's call site never sets it, so no wrap should exist here at all.
        const upHasWrap = await p.evaluate(() => {
            const grid = document.getElementById('upcomingEventsGrid');
            return !!(grid.nextElementSibling && grid.nextElementSibling.classList.contains('tm-view-more-wrap'));
        });
        ok(!upHasWrap, 'Upcoming Shows: no View More/Less controls, even with ' + totalUpcoming + ' events', String(upHasWrap));

        const totalShownPast = await exhaustThenCollapse(p, '#events', pastCount, 'Past Shows');
        ok(totalShownPast === totalPast, 'Past Shows: the total matches every past show, not just what was seeded here', `${totalShownPast} / ${totalPast}`);
        ok(p._errs.length === 0, 'Events: no page errors', p._errs.join(' | '));
        await p.close();
    }

    // ══════════ focus: neither button leaves it stranded when it hides itself ══════════
    {
        // A fresh page open resets tmPaginateGrid's own `shown` counter to pageSize regardless of how
        // much the gallery has grown across earlier blocks in this run — so however large the total
        // now is, one click of "the button that's currently visible" always exercises exactly one
        // hand-off; this loops (bounded) rather than assuming a specific number of clicks.
        for (let i = 0; i < 3; i++) await api('POST', '/api/admin/gallery', { title: 'Focus test ' + i, fallback_url: PIXEL });
        const p = await openHome(browser, { width: 1440, height: 1000 });
        await p.waitForSelector('#gallery .tm-view-more', { timeout: 15000 });

        // Click More (via keyboard) until it hides — checking after EACH click that focus never
        // dangled on a now-hidden control along the way, not just at the very end.
        await p.focus('#gallery .tm-view-more');
        for (let i = 0; i < 10 && (await visible(p, '#gallery .tm-view-more')); i++) {
            await p.keyboard.press('Enter');
            await sleep(300);
            const active = await p.evaluate(() => document.activeElement && document.activeElement.className);
            const moreV = await visible(p, '#gallery .tm-view-more'), lessV = await visible(p, '#gallery .tm-view-less');
            ok(moreV ? /tm-view-more/.test(active || '') : /tm-view-less/.test(active || ''),
                'Focus test: focus is on whichever control is actually visible after a More click', JSON.stringify({ active, moreV, lessV }));
        }
        ok(!(await visible(p, '#gallery .tm-view-more')) && (await visible(p, '#gallery .tm-view-less')),
            'Focus test: "View More" hides and "View Less" appears once everything is shown', '');

        await p.keyboard.press('Enter'); // View Less is now focused — collapse back to the first page
        await sleep(300);
        const active = await p.evaluate(() => document.activeElement && document.activeElement.className);
        ok(!(await visible(p, '#gallery .tm-view-less')) && (await visible(p, '#gallery .tm-view-more')),
            'Focus test: "View Less" hides and "View More" reappears once collapsed', '');
        ok(/tm-view-more/.test(active || ''), 'Focus test: focus hands off from Less to More (not lost) when Less hides', String(active));

        ok(p._errs.length === 0, 'Focus test: no page errors', p._errs.join(' | '));
        await p.close();
    }

    await browser.close(); await d.support.stop();
    console.log(fails ? `\n${fails} FAILURE(S)` : '\nALL PASS'); process.exit(fails ? 1 : 0);
})().catch(async e => { console.error('ERR', e.stack || e.message); try { await d.support.stop(); } catch (_) {} process.exit(2); });
