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

    // ══════════ GALLERY: 8 at a time, "View More" for the rest ══════════
    {
        // Seed well past one page regardless of how many the checked-in DB already has.
        for (let i = 0; i < 12; i++) {
            const r = await api('POST', '/api/admin/gallery', { title: 'PS test photo ' + i, fallback_url: PIXEL });
            ok(r.status === 200 && r.body.success, 'seed: gallery photo ' + i, JSON.stringify(r.body));
        }
        const total = (await pub('GET', '/api/public/gallery')).body.length;

        const p = await openHome(browser, { width: 1440, height: 1000 });
        await p.waitForSelector('#dynamicGalleryGrid .insta-item', { timeout: 15000 });
        const count = () => p.$$eval('#dynamicGalleryGrid .insta-item', els => els.length);
        const btn = () => p.$('#gallery .tm-view-more-wrap .tm-view-more');

        ok(await count() === 8, 'Gallery: shows exactly 8 to start, however many photos exist', String(await count()));
        let b = await btn();
        ok(!!b, 'Gallery: a "View More" button appears below the grid', '');
        const btnText = await p.$eval('#gallery .tm-view-more', e => e.textContent.trim());
        ok(/view more/i.test(btnText), 'Gallery: button says something like "View More"', btnText);

        var clicks = 0;
        while (await btn()) {
            const before = await count();
            await p.click('#gallery .tm-view-more');
            await sleep(300);
            const after = await count();
            ok(after > before && after - before <= 8, 'Gallery: clicking reveals up to 8 more (' + before + ' -> ' + after + ')', String(after));
            clicks++;
            if (clicks > 10) { ok(false, 'Gallery: View More did not exhaust after 10 clicks', ''); break; }
        }
        ok(await count() === total, 'Gallery: every photo is shown once the button is gone', `${await count()} / ${total}`);
        ok(clicks >= 2, 'Gallery: took more than one click (seeded well past a single page)', String(clicks));

        // Lightbox re-scans the grid at click time — must see every revealed photo, not just the first 8.
        await p.click('#dynamicGalleryGrid .insta-item:last-child img');
        await sleep(200);
        const lbVisible = await p.evaluate(() => getComputedStyle(document.getElementById('lightboxOverlay')).display !== 'none');
        ok(lbVisible, 'Gallery: lightbox opens on a photo that only exists after "View More"', '');
        await p.click('.lightbox-close');
        ok(p._errs.length === 0, 'Gallery: no page errors', p._errs.join(' | '));
        await p.close();
    }

    // ══════════ PAST SHOWS: 8 at a time, "View More" for the rest; UPCOMING is never paginated ══════════
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
        const upHasBtn = await p.evaluate(() => {
            const grid = document.getElementById('upcomingEventsGrid');
            return !!(grid.nextElementSibling && grid.nextElementSibling.classList.contains('tm-view-more-wrap'));
        });
        ok(!upHasBtn, 'Upcoming Shows: no "View More" button, even with ' + totalUpcoming + ' events', String(upHasBtn));

        var clicks = 0;
        while (await p.$('#events .tm-view-more-wrap .tm-view-more').then(h => h !== null)) {
            const before = await pastCount();
            await p.click('#events .tm-view-more');
            await sleep(300);
            const after = await pastCount();
            ok(after > before && after - before <= 8, 'Past Shows: clicking reveals up to 8 more (' + before + ' -> ' + after + ')', String(after));
            clicks++;
            if (clicks > 10) { ok(false, 'Past Shows: View More did not exhaust after 10 clicks', ''); break; }
        }
        ok(await pastCount() === totalPast, 'Past Shows: every past show is shown once the button is gone', `${await pastCount()} / ${totalPast}`);
        ok(clicks >= 1, 'Past Shows: needed at least one click (seeded past a single page)', String(clicks));
        ok(p._errs.length === 0, 'Events: no page errors', p._errs.join(' | '));
        await p.close();
    }

    // ══════════ focus after the button disappears (final click) lands somewhere sane, not lost ══════════
    {
        // Fresh small seed: exactly one page's worth of overflow, so one click empties the queue.
        for (let i = 0; i < 9; i++) await api('POST', '/api/admin/gallery', { title: 'Focus test ' + i, fallback_url: PIXEL });
        const p = await openHome(browser, { width: 1440, height: 1000 });
        await p.waitForSelector('#gallery .tm-view-more', { timeout: 15000 });
        await p.focus('#gallery .tm-view-more');
        // Click repeatedly (whatever the real remaining-page count is) until the button is gone.
        for (let i = 0; i < 10 && (await p.$('#gallery .tm-view-more')); i++) { await p.keyboard.press('Enter'); await sleep(250); if (await p.$('#gallery .tm-view-more')) await p.focus('#gallery .tm-view-more'); }
        const activeIsGrid = await p.evaluate(() => document.activeElement && document.activeElement.id === 'dynamicGalleryGrid');
        ok(!(await p.$('#gallery .tm-view-more')), 'Focus test: the button is gone once everything is shown', '');
        ok(activeIsGrid, 'Focus test: focus lands on the grid instead of vanishing when the button removes itself', String(activeIsGrid));
        ok(p._errs.length === 0, 'Focus test: no page errors', p._errs.join(' | '));
        await p.close();
    }

    await browser.close(); await d.support.stop();
    console.log(fails ? `\n${fails} FAILURE(S)` : '\nALL PASS'); process.exit(fails ? 1 : 0);
})().catch(async e => { console.error('ERR', e.stack || e.message); try { await d.support.stop(); } catch (_) {} process.exit(2); });
