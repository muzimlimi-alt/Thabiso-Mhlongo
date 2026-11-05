// Server-filled homepage through a real browser (lib/homepage-render.js + the head script #tmSectionsBoot + tmSectionOff() in js/myscript.js).
// A FIRST visit (fresh browser profile: no cached section map) must never show the file's built-in text or a switched-off section:
//   - at the first moment the page can appear (DOMContentLoaded) the hero, cards and manager details already show the admin's content,
//     and they are unchanged once the page has fully loaded (nothing visibly swaps);
//   - switched-off sections and their nav links are hidden from the start, and their content is never fetched;
//   - a section switched back on shows and loads again.
// Boots the real app on an isolated database copy (test/support.js). Not part of `npm test`: run with `npm run test:browser`.
const sqlite3 = require('sqlite3');
const support = require('../support');
const puppeteer = require('puppeteer');
const { BASE, sleep, api, q, TEST_DB } = support;
let fails = 0;
const ok = (c, n, detail) => { if (!c) fails++; console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '\n        -> ' + String(detail).slice(0, 400))); };
const KEYS = ['hero_tagline', 'hero_subtitle', 'services_items', 'section_visibility'];
const OFF_APIS = /\/api\/public\/(events|team|testimonials)(\?|$)/;

// what a visitor sees, read in the page
function look() {
    const vis = (sel) => { const el = document.querySelector(sel); return !!el && getComputedStyle(el).display !== 'none'; };
    const txt = (sel) => { const el = document.querySelector(sel); return el ? el.textContent.replace(/\s+/g, ' ').trim() : null; };
    const navLi = document.querySelector('.tm-navlinks a[href="#events"]');
    return {
        tagline: txt('.tm-hero__tagline'),
        subtitle: txt('.tm-hero__subtitle'),
        cards: [...document.querySelectorAll('.tm-services__grid .tm-service__title')].map((e) => e.textContent.trim()),
        managerEmail: txt('#dynamicManagerEmail'),
        events: vis('#events'), team: vis('#team'), testimonials: vis('#testimonials'), gallery: vis('#gallery'),
        eventsNav: navLi ? getComputedStyle(navLi.closest('li') || navLi).display !== 'none' : null,
        serverMap: !!window.__tmSections
    };
}

async function visit(browser) {
    const ctx = await browser.createBrowserContext(); // a fresh profile: no localStorage, like a first visit
    const p = await ctx.newPage();
    await p.setViewport({ width: 1440, height: 900 });
    const errs = [], fetched = [];
    p.on('pageerror', (e) => errs.push(e.message.slice(0, 200)));
    p.on('request', (r) => { if (OFF_APIS.test(r.url())) fetched.push(r.url().replace(BASE, '')); });
    await p.evaluateOnNewDocument(`(${function (lookSrc) {
        const fn = new Function('return (' + lookSrc + ')')();
        document.addEventListener('DOMContentLoaded', () => { window.__atFirstPaint = fn(); });
    }})(${JSON.stringify(look.toString())})`);
    await p.goto(BASE + '/', { waitUntil: 'networkidle0', timeout: 90000 }).catch(() => {});
    await sleep(2500); // every renderer has answered
    const first = await p.evaluate(() => window.__atFirstPaint);
    const after = await p.evaluate(look);
    await ctx.close();
    return { first, after, errs, fetched };
}

(async () => {
    await support.start();
    const saved = await q(`SELECT setting_key, setting_value FROM settings WHERE setting_key IN (${KEYS.map(() => '?').join(',')})`, KEYS);
    const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'], executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined });
    try {
        await support.loginAs('administrator');
        const mark = 'PF' + Date.now().toString(36);
        const cards = ['One', 'Two', 'Three', 'Four', 'Five'].map((t) => ({ title: `${mark} ${t}`, description: 'd', image: '' }));
        await api('PUT', '/api/admin/site-content', {
            hero_tagline: `${mark} tagline`, hero_subtitle: `${mark} subtitle`, services_items: cards,
            section_visibility: { events: false, team: false, testimonials: false, gallery: true }
        });
        const mgr = (await support.pub('GET', '/api/public/manager')).body;

        let v = await visit(browser);
        ok(v.first && v.first.serverMap, 'the page arrives with the server\'s section map', JSON.stringify(v.first));
        ok(v.first.tagline === `${mark} tagline` && v.first.subtitle === `${mark} subtitle`, 'first paint: the hero already shows the admin\'s text (not the built-in one)', JSON.stringify([v.first.tagline, v.first.subtitle]));
        ok(v.first.cards.join('|') === cards.map((c) => c.title).join('|'), 'first paint: the "What I do" cards already show the admin\'s titles', JSON.stringify(v.first.cards));
        ok(!mgr || !mgr.email || v.first.managerEmail === mgr.email, 'first paint: the manager email is the stored one', v.first.managerEmail + ' vs ' + (mgr && mgr.email));
        ok(!v.first.events && !v.first.team && !v.first.testimonials, 'first paint: switched-off sections are already hidden (first visit, nothing cached)', JSON.stringify(v.first));
        ok(v.first.eventsNav === false, 'first paint: the nav link to a switched-off section is hidden too', String(v.first.eventsNav));
        ok(v.first.gallery === true, 'a switched-on section shows', '');
        const same = ['tagline', 'subtitle', 'managerEmail', 'events', 'team', 'testimonials', 'gallery', 'eventsNav'].every((k) => v.first[k] === v.after[k]) && v.first.cards.join('|') === v.after.cards.join('|');
        ok(same, 'nothing visibly changes after the page has loaded', JSON.stringify({ first: v.first, after: v.after }));
        ok(v.fetched.length === 0, 'the content of switched-off sections is never fetched', JSON.stringify(v.fetched));
        ok(v.errs.length === 0, 'no script errors', v.errs.join(' | '));

        await api('PUT', '/api/admin/site-content', { section_visibility: { events: true, team: false, testimonials: false, gallery: true } });
        v = await visit(browser);
        ok(v.first.events === true && v.after.events === true && v.first.eventsNav === true, 'switched back on: the section and its nav link show from the start', JSON.stringify(v.first));
        ok(v.fetched.some((u) => /\/api\/public\/events/.test(u)) && !v.fetched.some((u) => /team|testimonials/.test(u)), 'switched back on: its content loads again (the others still do not)', JSON.stringify(v.fetched));
    } catch (e) {
        ok(false, 'browser test crashed', e && e.stack);
    } finally {
        await browser.close();
        // put the shared test database back exactly as it was
        const rw = new sqlite3.Database(TEST_DB);
        const run = (sql, params) => new Promise((resolve, reject) => rw.run(sql, params, (e) => (e ? reject(e) : resolve())));
        try {
            await run(`DELETE FROM settings WHERE setting_key IN (${KEYS.map(() => '?').join(',')})`, KEYS);
            for (const r of saved) await run('INSERT INTO settings (setting_key, setting_value) VALUES (?, ?)', [r.setting_key, r.setting_value]);
        } catch (e) { console.error('restore failed', e.message); }
        await new Promise((resolve) => rw.close(() => resolve()));
        await support.stop();
    }
    console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
    process.exit(fails ? 1 : 0);
})();
