// Homepage content editor (js/admin/about.js, routes/{admin,public}/site-content.js, js/myscript.js):
//   * announcement bar: the two check boxes line up with the same left edge and sit level with their text; a scroll-speed slider (1-10)
//     is saved, comes back from the public API, is clamped, and sets the bar's animation time on the public page (90 / speed seconds);
//   * "Most Booked": the owner picks one service card (or none); the public page moves the badge accordingly; only one card ever keeps it.
// Boots the real app on an isolated database copy (test/support.js). Not part of `npm test`: run with `npm run test:browser`.
const support = require('../support');
const puppeteer = require('puppeteer');
const { BASE, sleep, api, pub } = support;
let fails = 0;
const ok = (c, n, detail) => { if (!c) fails++; console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '\n        -> ' + String(detail).slice(0, 400))); };

(async () => {
    await support.start();
    let browser;
    try {
        await support.loginAs('administrator');
        const lr = await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'test.administrator@example.invalid', password: 'TestRunnerPass1!' }) });
        const raw = lr.headers.get('set-cookie');

        // ---- API
        const before = (await pub('GET', '/api/public/site-content')).body;
        ok(before.announcement && before.announcement.speed === 5, 'the public API reports speed 5 until one is chosen', JSON.stringify(before.announcement));
        await api('PUT', '/api/admin/site-content', { announcement_speed: 9 });
        ok((await pub('GET', '/api/public/site-content')).body.announcement.speed === 9, 'a saved speed comes back', '');
        await api('PUT', '/api/admin/site-content', { announcement_speed: 99 });
        ok((await pub('GET', '/api/public/site-content')).body.announcement.speed === 9, 'a speed outside 1-10 is ignored', '');
        const items = ['A', 'B', 'C', 'D', 'E'].map((t, i) => ({ title: 'Card ' + t, description: 'd', image: '', featured: i < 2 }));   // two flagged: only the first may keep it
        await api('PUT', '/api/admin/site-content', { services_items: items });
        const got = (await pub('GET', '/api/public/site-content')).body.services.items;
        ok(got.filter(x => x.featured).length === 1 && got[0].featured, 'only one card keeps the "Most Booked" flag', JSON.stringify(got.map(x => x.featured)));

        browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'], executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined });

        // ---- public page
        {
            await api('PUT', '/api/admin/site-content', { announcement_speed: 10, announcement_rotate: true, announcement_enabled: true, announcement_text: '<strong>Speed</strong> test' });
            const p = await browser.newPage(); await p.setViewport({ width: 1440, height: 900 });
            const errs = []; p.on('pageerror', e => errs.push(e.message.slice(0, 200)));
            await p.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 }); await sleep(3000);
            const r = await p.evaluate(() => ({
                dur: getComputedStyle(document.querySelector('.tm-announce-marquee')).animationDuration,
                tags: [...document.querySelectorAll('.tm-services__grid .tm-service')].map(c => !!c.querySelector('.tm-service__tag'))
            }));
            ok(r.dur === '9s', 'public page: speed 10 -> the bar crosses in 9 s', r.dur);
            ok(JSON.stringify(r.tags) === JSON.stringify([true, false, false, false, false]), 'public page: the "Most Booked" badge is on card 1 only', JSON.stringify(r.tags));
            await api('PUT', '/api/admin/site-content', { announcement_speed: 1, services_items: items.map(x => ({ ...x, featured: false })) });
            await p.reload({ waitUntil: 'domcontentloaded' }); await sleep(3000);
            const r2 = await p.evaluate(() => ({ dur: getComputedStyle(document.querySelector('.tm-announce-marquee')).animationDuration, tags: document.querySelectorAll('.tm-services__grid .tm-service__tag').length }));
            ok(r2.dur === '90s', 'public page: speed 1 -> 90 s', r2.dur);
            ok(r2.tags === 0, 'public page: "No card" removes the badge', r2.tags);
            ok(errs.length === 0, 'public page: no page errors', errs.join(' | '));
            await p.close();
        }

        // ---- admin drawer
        for (const [vp, w, h] of [['desktop', 1440, 900], ['phone', 390, 844]]) {
            const p = await (await browser.createBrowserContext()).newPage(); await p.setViewport({ width: w, height: h });
            const errs = []; p.on('pageerror', e => errs.push(e.message.slice(0, 200)));
            const [name, ...rest] = String(raw).split(';')[0].split('=');
            await p.setCookie({ name, value: rest.join('='), url: BASE });
            await p.setRequestInterception(true);
            p.on('request', r => /\/api\/admin\/maps-config/.test(r.url()) ? r.respond({ status: 200, contentType: 'application/json', body: '{"success":true,"key":""}' }) : r.continue());
            await p.goto(BASE + '/admin.html', { waitUntil: 'domcontentloaded', timeout: 90000 }); await sleep(3500);
            await p.evaluate(() => window.switchTab('aboutAdmin')); await sleep(2500);
            await p.evaluate(() => window.openAtlDrawer('announceDrawer')); await sleep(900);
            const g = await p.evaluate(() => {
                const box = (id) => { const i = document.getElementById(id), r = i.getBoundingClientRect(), l = i.closest('label').querySelector('span').getBoundingClientRect(); return { x: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height), boxMid: Math.round(r.top + r.height / 2), textTop: Math.round(l.top), textMid: Math.round(l.top + l.height / 2) }; };
                return { a: box('announceEnabled'), b: box('announceRotate'), slider: !!document.getElementById('announceSpeed'), val: document.getElementById('announceSpeed').value };
            });
            ok(g.a.x === g.b.x, `${vp}: both check boxes share one left edge`, JSON.stringify(g));
            ok(g.a.w === 16 && g.b.w === 16 && g.a.h === 16 && g.b.h === 16, `${vp}: both boxes are the same 16px size (none squeezed)`, JSON.stringify(g));
            ok(Math.abs(g.a.boxMid - g.a.textMid) <= 4 && Math.abs(g.b.boxMid - g.b.textMid) <= 4, `${vp}: each box sits level with its text`, JSON.stringify(g));
            ok(g.slider, `${vp}: the scroll-speed slider is there`, '');
            // save a speed through the form, check it reached the server
            await p.evaluate(() => { const s = document.getElementById('announceSpeed'); s.value = 3; s.dispatchEvent(new Event('input', { bubbles: true })); });
            await p.click('#announceSubmitBtn'); await sleep(1500);
            ok((await pub('GET', '/api/public/site-content')).body.announcement.speed === 3, `${vp}: saving the drawer stores the chosen speed`, '');
            // chooser
            await p.evaluate(() => window.closeAtlDrawer && closeAtlDrawer('announceDrawer'));
            await p.evaluate(() => { const b = document.querySelector('[data-um-tab="aboutServicesPanel"]'); if (b) b.click(); }); await sleep(800);
            await p.evaluate(() => window.openAtlDrawer('servicesDrawer')); await sleep(900);
            const ch = await p.evaluate(() => ({ n: document.querySelectorAll('#homeFeaturedCard option').length, val: document.getElementById('homeFeaturedCard').value }));
            ok(ch.n === 6, `${vp}: the chooser lists "No card" and the five cards`, JSON.stringify(ch));
            await p.select('#homeFeaturedCard', '3');
            const sv = p.waitForResponse(r => /\/api\/admin\/site-content/.test(r.url()) && r.request().method() === 'PUT', { timeout: 8000 }).catch(() => null); await p.evaluate(() => document.getElementById('servicesSubmitBtn').click()); const svr = await sv; await sleep(1200); if (!svr) console.log('   (no save request seen)');
            const saved = (await pub('GET', '/api/public/site-content')).body.services.items;
            ok(saved.length >= 4 && saved[3].featured === true && saved.filter(x => x.featured).length === 1, `${vp}: choosing card 4 and saving puts the badge there alone`, JSON.stringify(saved.map(x => x.featured)));
            ok(errs.length === 0, `${vp}: no page errors`, errs.join(' | '));
            await p.close();
        }
    } finally {
        if (browser) await browser.close();
        await support.stop();
    }
    console.log(fails ? `\n${fails} homepage-content check(s) FAILED` : '\nAll homepage content checks passed');
    process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
