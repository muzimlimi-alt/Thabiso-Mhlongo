// "What I Do" cards: the owner adds and deletes cards in the admin drawer (js/admin/about.js, admin.html #servicesDrawer), the server keeps
// 1-12 (routes/admin/site-content.js), and the public page shows exactly that many (lib/homepage-render.js on the server, js/myscript.js in
// the browser), laid out in even, centred rows (css/public/redesign.css --svc-cols-lg / --svc-cols-xl).
// Boots the real app on an isolated database copy (test/support.js). Not part of `npm test`: run with `npm run test:browser`.
const fs = require('fs');
const path = require('path');
const support = require('../support');
const puppeteer = require('puppeteer');
const { BASE, sleep, api, pub } = support;
let fails = 0;
const ok = (c, n, detail) => { if (!c) fails++; console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '\n        -> ' + String(detail).slice(0, 500))); };
const LOCAL_JQUERY = fs.readFileSync(path.join(__dirname, '..', '..', 'js', 'jquery-2.1.1.min.js'), 'utf8');

(async () => {
    await support.start();
    let browser;
    try {
        await support.loginAs('administrator');
        const lr = await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'test.administrator@example.invalid', password: 'TestRunnerPass1!' }) });
        const raw = lr.headers.get('set-cookie');
        const five = ['A', 'B', 'C', 'D', 'E'].map((t, i) => ({ title: 'Card ' + t, description: 'd' + t, image: '', featured: i === 1 }));
        await api('PUT', '/api/admin/site-content', { services_items: five });

        browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'], executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined });

        // ---- admin drawer: add, delete, limits, save
        const p = await (await browser.createBrowserContext()).newPage(); await p.setViewport({ width: 1440, height: 900 });
        const errs = []; p.on('pageerror', e => errs.push(e.message.slice(0, 200)));
        const [name, ...rest] = String(raw).split(';')[0].split('=');
        await p.setCookie({ name, value: rest.join('='), url: BASE });
        await p.setRequestInterception(true);
        p.on('request', r => {
            if (/\/api\/admin\/maps-config/.test(r.url())) return r.respond({ status: 200, contentType: 'application/json', body: '{"success":true,"key":""}' });
            if (/ajax\.googleapis\.com\/ajax\/libs\/jquery\//.test(r.url())) return r.respond({ status: 200, contentType: 'application/javascript', body: LOCAL_JQUERY }); // offline-safe
            return r.continue();
        });
        await p.goto(BASE + '/admin.html', { waitUntil: 'domcontentloaded', timeout: 90000 }); await sleep(3500);
        await p.evaluate(() => window.switchTab('aboutAdmin')); await sleep(2000);
        await p.evaluate(() => { const b = document.querySelector('[data-um-tab="aboutServicesPanel"]'); if (b) b.click(); }); await sleep(1500);
        await p.evaluate(() => window.openAtlDrawer('servicesDrawer')); await sleep(900);
        const state = () => p.evaluate(() => ({
            n: document.querySelectorAll('#svcCardsEditor .svc-card-editor').length,
            nums: [...document.querySelectorAll('#svcCardsEditor .svc-card-num')].map(e => e.textContent),
            titles: [...document.querySelectorAll('#svcCardsEditor .svc-card-title')].map(e => e.value),
            opts: [...document.querySelectorAll('#homeFeaturedCard option')].map(o => o.textContent),
            chosen: document.querySelector('#homeFeaturedCard option:checked') && document.querySelector('#homeFeaturedCard option:checked').textContent,
            preview: document.querySelectorAll('#svcPrevGrid > div').length,
            addOff: document.getElementById('svcAddCard').disabled,
            delOff: [...document.querySelectorAll('#svcCardsEditor .svc-card-delete')].map(b => b.disabled),
            count: document.getElementById('svcCardCount').textContent
        }));
        let s = await state();
        ok(s.n === 5 && s.count === '5 of 12 cards' && !s.addOff && s.delOff.every(d => !d), 'the drawer lists the five saved cards, each deletable, with "Add card" on', JSON.stringify(s));

        await p.click('#svcAddCard'); await sleep(200);
        if (process.env.SHOT_DIR) await p.screenshot({ path: path.join(process.env.SHOT_DIR, 'admin-drawer.png') });
        s = await state();
        ok(s.n === 6 && s.nums[5] === 'Card 6' && s.titles[5] === '' && s.preview === 6 && s.opts.length === 7, '"Add card" adds an empty sixth card (editor, preview and badge chooser)', JSON.stringify(s));
        ok(await p.evaluate(() => document.activeElement && document.activeElement.classList.contains('svc-card-title')), 'the new card\'s title has focus', '');
        await p.keyboard.type('Card F');
        s = await state();
        ok(s.opts[6] === 'Card 6 — Card F', 'the badge chooser follows the typed title', JSON.stringify(s.opts));

        // delete card 1 ("Card A"): the rest renumber, the badge stays on "Card B"
        await p.click('#svcCardsEditor .svc-card-editor:first-child .svc-card-delete'); await sleep(200);
        s = await state();
        ok(s.n === 5 && s.titles[0] === 'Card B' && s.nums.join() === 'Card 1,Card 2,Card 3,Card 4,Card 5' && s.preview === 5, 'Delete removes the card and renumbers the rest', JSON.stringify(s));
        ok(s.chosen === 'Card 1 — Card B', 'the "Most Booked" choice stays with its card after a delete', s.chosen);

        // save -> server -> public API
        await p.click('#servicesSubmitBtn'); await sleep(2000);
        let got = (await pub('GET', '/api/public/site-content')).body.services.items;
        ok(got.length === 5 && got.map(x => x.title).join() === 'Card B,Card C,Card D,Card E,Card F' && got[0].featured && got.filter(x => x.featured).length === 1, 'Save & Publish stores the new set (count, order, badge)', JSON.stringify(got));

        // an empty title is refused, nothing saved
        await p.evaluate(() => window.openAtlDrawer('servicesDrawer')); await sleep(700);
        await p.click('#svcAddCard'); await sleep(150);
        await p.click('#servicesSubmitBtn'); await sleep(1200);
        got = (await pub('GET', '/api/public/site-content')).body.services.items;
        ok(got.length === 5, 'a card without a title is not saved (the owner is told every card needs one)', got.length);
        await p.click('#svcCardsEditor .svc-card-editor:last-child .svc-card-delete'); await sleep(150);

        // limits: never fewer than one, never more than 12
        for (let i = 0; i < 4; i++) { await p.click('#svcCardsEditor .svc-card-editor:first-child .svc-card-delete'); await sleep(100); }
        s = await state();
        ok(s.n === 1 && s.delOff.length === 1 && s.delOff[0] === true, 'the last card cannot be deleted', JSON.stringify(s));
        for (let i = 0; i < 14; i++) { await p.$eval('#svcAddCard', b => b.click()); await sleep(60); } // a disabled button ignores the click
        s = await state();
        ok(s.n === 12 && s.addOff && s.count === '12 of 12 cards', '"Add card" stops at 12 (the server\'s cap)', JSON.stringify(s));
        const own = errs.filter(e => !/intlTelInput|ApexCharts|FullCalendar|Quill|flatpickr/.test(e)); // third-party CDN libraries, absent offline
        ok(own.length === 0, 'admin: no page errors from the editor', own.join(' | '));
        await p.close();

        // ---- public page: exactly the stored count, in even centred rows
        const layout = async (items, width) => {
            await api('PUT', '/api/admin/site-content', { services_items: items });
            const pg = await browser.newPage(); await pg.setViewport({ width, height: 900 });
            const perr = []; pg.on('pageerror', e => perr.push(e.message.slice(0, 200)));
            await pg.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 }); await sleep(2500);
            if (process.env.SHOT_DIR) { await pg.evaluate(() => document.querySelector('.tm-services').scrollIntoView()); await sleep(1200); await pg.screenshot({ path: path.join(process.env.SHOT_DIR, 'public-' + items.length + '-' + width + '.png') }); }
            const r = await pg.evaluate(() => {
                const cards = [...document.querySelectorAll('.tm-services__grid .tm-service')];
                const rows = {};
                cards.forEach(c => { const b = c.getBoundingClientRect(); const k = Math.round(b.top + window.scrollY); rows[k] = (rows[k] || 0) + 1; });
                const grid = document.querySelector('.tm-services__grid').getBoundingClientRect();
                const first = cards[0].getBoundingClientRect(), last = cards[cards.length - 1].getBoundingClientRect();
                return { n: cards.length, rows: Object.keys(rows).sort((a, b) => a - b).map(k => rows[k]), titles: cards.map(c => c.querySelector('.tm-service__title').textContent),
                    labels: cards.map(c => c.querySelector('.tm-service__label').textContent), tags: cards.map(c => !!c.querySelector('.tm-service__tag')),
                    w: Math.round(first.width), lastCentred: Math.abs((last.left + last.right) / 2 - (grid.left + grid.right) / 2) < 3 || cards.length > 1 };
            });
            await pg.close();
            return Object.assign(r, { errs: perr });
        };
        const mk = (n) => Array.from({ length: n }, (_, i) => ({ title: 'Svc ' + (i + 1), description: 'x', image: '', featured: i === n - 1 }));
        let r = await layout(mk(5), 1440);
        ok(r.n === 5 && JSON.stringify(r.rows) === '[5]' && r.tags[4] && r.tags.filter(Boolean).length === 1, 'public 1440px: five cards in one row (as before)', JSON.stringify(r));
        r = await layout(mk(5), 1100);
        ok(JSON.stringify(r.rows) === '[3,2]', 'public 1100px: five cards as 3 + 2 (as before)', JSON.stringify(r.rows));
        r = await layout(mk(7), 1440);
        ok(r.n === 7 && JSON.stringify(r.rows) === '[4,3]' && r.labels[6] === '07' && r.titles[6] === 'Svc 7' && r.tags[6], 'public 1440px: seven cards as 4 + 3, the added ones numbered and badged', JSON.stringify(r));
        r = await layout(mk(6), 1100);
        ok(JSON.stringify(r.rows) === '[3,3]', 'public 1100px: six cards as 3 + 3', JSON.stringify(r.rows));
        r = await layout(mk(3), 1440);
        ok(r.n === 3 && JSON.stringify(r.rows) === '[3]' && r.titles.join() === 'Svc 1,Svc 2,Svc 3', 'public 1440px: deleting down to three shows three', JSON.stringify(r));
        r = await layout(mk(1), 1440);
        ok(r.n === 1 && r.w <= 420 && r.lastCentred, 'public 1440px: a single card stays card-sized and centred', JSON.stringify(r));
        r = await layout(mk(4), 390);
        ok(r.n === 4 && JSON.stringify(r.rows) === '[1,1,1,1]', 'public phone: one card per row', JSON.stringify(r.rows));
        ok(r.errs.length === 0, 'public: no page errors', r.errs.join(' | '));

        // the browser script builds / drops cards too (a page served without the server fill)
        const pg = await browser.newPage(); await pg.setViewport({ width: 1440, height: 900 });
        await api('PUT', '/api/admin/site-content', { services_items: mk(7) });
        await pg.setRequestInterception(true);
        pg.on('request', rq => (new URL(rq.url()).pathname === '/' && rq.resourceType() === 'document')
            ? rq.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: fs.readFileSync(path.join(__dirname, '..', '..', 'index.html'), 'utf8') }) : rq.continue());
        await pg.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 }); await sleep(3000);
        const c = await pg.evaluate(() => [...document.querySelectorAll('.tm-services__grid .tm-service')].map(e => ({ t: e.querySelector('.tm-service__title').textContent, l: e.querySelector('.tm-service__label').textContent, o: getComputedStyle(e).opacity })));
        ok(c.length === 7 && c[6].t === 'Svc 7' && c[6].l === '07' && c[6].o === '1', 'browser fallback: the unfilled template grows to the stored seven cards (visible, numbered)', JSON.stringify(c));
        await pg.close();
    } catch (e) {
        fails++; console.log('ERROR', e && e.stack);
    } finally {
        if (browser) await browser.close();
        await support.stop();
        console.log(fails ? fails + ' failure(s)' : 'all passed');
        process.exit(fails ? 1 : 0);
    }
})();
