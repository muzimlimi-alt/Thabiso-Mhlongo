// Page preloader (#tmPreloader, ONE shared copy: js/tm-preloader.js, loaded first in <body> by index.html AND admin.html) through a real
// browser on the test server. Proves its rules:
//   - a normal load: gone once the page has loaded (and it is never in the way: pointer-events none)
//   - a slow load (an image held back 2 s): it shows (after its 350 ms grace) and leaves when loading finishes
//   - a page that never finishes loading (an image held 12 s): it still leaves - by 3.5 s via the script
//   - its script timer stopped (a later error): the CSS fail-safe still hides it by about 4.5 s
//   - JavaScript switched off: no preloader at all (nothing that could get stuck)
//   - the admin page (/admin.html) shows the same preloader and it leaves the same way
//   - signing in to the admin (no page reload): the preloader comes straight back and stays until the dashboard cards are filled
//   - it shows THABISO with the animated gold final "O" (the Cupcake loader, no image to download)
//   - reduced motion: the O does not pulse
// Timing: a browser paints nothing in <body> until the stylesheets in <head> have loaded, so every time here is measured from when the page
// is first able to appear (DOMContentLoaded), not from the request - the same limit any preloader has.
// Not part of `npm test`: `npm run test:browser` (needs PUPPETEER_EXECUTABLE_PATH). PRELOADER_SHOTS=<dir> saves a screenshot of it showing.
const path = require('path');
const support = require('../support');
const puppeteer = require('puppeteer');
const { BASE, sleep } = support;
let fails = 0;
const ok = (c, n, detail) => { if (!c) fails++; console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '\n        -> ' + detail)); };
const SHOTS = process.env.PRELOADER_SHOTS || null;

// holdMs: delay ONE homepage image this long (0 = none) so the window "load" event waits for it
async function open(browser, { holdMs = 0, js = true, reducedMotion = false, url = '/', breakTimer = false } = {}) {
    const ctx = await browser.createBrowserContext();
    const p = await ctx.newPage();
    await p.setViewport({ width: 1280, height: 860 });
    p._errs = [];
    p.on('pageerror', (e) => p._errs.push(e.message.slice(0, 200)));
    await p.setJavaScriptEnabled(js);
    if (reducedMotion) await p.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    await p.setRequestInterception(true);
    let held = false;
    p.on('request', (r) => {
        const u = r.url();
        if (/googletagmanager|google-analytics|challenges\.cloudflare|maps\.googleapis/.test(u)) return r.respond({ status: 204, body: '' });
        if (holdMs && !held && /^(image|font)$/.test(r.resourceType()) && (u.startsWith(BASE) || /fonts\.gstatic/.test(u))) {
            held = true;
            setTimeout(() => { r.continue().catch(() => {}); }, holdMs);
            return;
        }
        r.continue();
    });
    if (breakTimer) await p.evaluateOnNewDocument(() => { const real = window.setTimeout; window.setTimeout = (f, ms, ...a) => (ms === 3500 ? 0 : real(f, ms, ...a)); });
    if (js) {
        await p.evaluateOnNewDocument(() => {
            // the veil's opacity on the first frame it exists: a page that is quick never shows it
            const look = () => {
                const v = document.querySelector('.tm-preloader__veil');
                if (!v) return requestAnimationFrame(look);
                requestAnimationFrame(() => { window.__preFirstOpacity = Number(getComputedStyle(v).opacity); });
            };
            requestAnimationFrame(look);
        });
    }
    await p.goto(BASE + url, { waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {});
    return { p, t0: Date.now() };
}
const state = (p) => p.evaluate(() => {
    const el = document.getElementById('tmPreloader');
    if (!el) return { exists: false };
    const veil = el.querySelector('.tm-preloader__veil');
    return {
        exists: true,
        // what a visitor sees: the outer layer's opacity times the veil's
        shown: Number(getComputedStyle(el).opacity) * Number(getComputedStyle(veil).opacity),
        hiddenVis: getComputedStyle(el).visibility === 'hidden',
        pointer: getComputedStyle(el).pointerEvents,
        ring: getComputedStyle(el.querySelector('.tm-preloader__inner')).animationName + '/' + getComputedStyle(el.querySelector('.tm-preloader__core')).animationName
    };
});
const waitUntil = async (p, fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(100); } return false; };

(async () => {
    await support.start();
    const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
    try {
        // normal load
        let { p } = await open(browser);
        await p.waitForFunction(() => document.readyState === 'complete', { timeout: 60000 });
        const s0 = await state(p);
        ok(!s0.exists || s0.pointer === 'none', 'normal load: it never blocks clicks (pointer-events none)', JSON.stringify(s0));
        ok(await waitUntil(p, async () => !(await state(p)).exists, 2000), 'normal load: removed from the page once loading has finished', JSON.stringify(await state(p)));
        ok(p._errs.length === 0, 'normal load: no script errors', p._errs.join(' | '));
        await p.close();

        // slow load: an image held back 2 s
        ({ p } = await open(browser, { holdMs: 4000 }));
        const first = await p.evaluate(() => window.__preFirstOpacity);
        ok(first !== undefined && first < 0.05, 'slow load: invisible on its first frame (a page that loads quickly never shows it)', String(first));
        const showed = await waitUntil(p, async () => (await state(p)).shown > 0.95, 2500);
        ok(showed && (await p.evaluate(() => document.readyState)) !== 'complete', 'slow load: shows while the page is still loading', JSON.stringify(await state(p)));
        const word = await p.evaluate(() => {
            const w = document.querySelector('#tmPreloader .tm-preloader__word'), o = w && w.querySelector('.tm-preloader__o');
            if (!w || !o) return null;
            const ob = o.getBoundingClientRect(), wb = w.getBoundingClientRect();
            return { text: w.textContent, o: Math.round(ob.width), round: getComputedStyle(o).borderRadius, centred: Math.abs((wb.left + wb.right) / 2 - innerWidth / 2) < 4,
                pulse: getComputedStyle(o.querySelector('.tm-preloader__inner')).animationName, imgs: document.querySelectorAll('#tmPreloader img').length };
        });
        ok(word && word.text === 'THABIS' && word.o > 20 && word.round === '50%' && word.centred, 'slow load: it shows THABISO with the round gold "O", centred', JSON.stringify(word));
        ok(word && word.pulse === 'tmPreBreathe' && word.imgs === 0, 'slow load: the "O" pulses, and there is no image to download', JSON.stringify(word));
        if (SHOTS) await p.screenshot({ path: path.join(SHOTS, 'preloader-showing.png') });
        ok(await waitUntil(p, async () => !(await state(p)).exists, 5000), 'slow load: leaves when loading finishes (or at its cap)', JSON.stringify(await state(p)));
        await p.close();

        // never-finishing load: an image held 12 s - the script's 3.5 s cap
        ({ p } = await open(browser, { holdMs: 12000 }));
        ok(await waitUntil(p, async () => (await state(p)).shown > 0.95, 2500), 'stuck load: shows while waiting', JSON.stringify(await state(p)));
        ok(await waitUntil(p, async () => { const s = await state(p); return !s.exists || s.shown < 0.05; }, 3200), 'stuck load: gone by about 3.5-4 s even though the page never finished loading', JSON.stringify(await state(p)));
        ok(await p.evaluate(() => document.readyState !== 'complete'), '(the page really was still loading)', '');
        await p.close();

        // the script's 3.5 s timer never fires and the page never finishes loading: the CSS fail-safe alone
        ({ p } = await open(browser, { holdMs: 12000, breakTimer: true }));
        ok(await waitUntil(p, async () => (await state(p)).shown > 0.95, 2500), 'timer stopped: it shows on a slow page', JSON.stringify(await state(p)));
        ok(await waitUntil(p, async () => { const s = await state(p); return s.hiddenVis && s.shown < 0.05; }, 5000), 'timer stopped: the CSS fail-safe hides it by about 4.5 s', JSON.stringify(await state(p)));
        await p.close();

        // JavaScript off: nothing is built, so nothing can cover the page
        ({ p } = await open(browser, { holdMs: 3000, js: false }));
        await sleep(1200);
        ok(!(await state(p)).exists, 'JavaScript off: no preloader at all', JSON.stringify(await state(p)));
        await p.close();

        // the admin page: the same preloader, leaving the same way
        ({ p } = await open(browser, { url: '/admin.html', holdMs: 4000 }));
        ok(await waitUntil(p, async () => (await state(p)).shown > 0.95, 3000), 'admin: shows while the admin page is still loading', JSON.stringify(await state(p)));
        const aw = await p.evaluate(() => { const w = document.querySelector('#tmPreloader .tm-preloader__word'); return { text: w && w.textContent, first: document.body.firstElementChild && document.body.firstElementChild.id, pointer: getComputedStyle(document.getElementById('tmPreloader')).pointerEvents }; });
        ok(aw.text === 'THABIS' && aw.pointer === 'none', 'admin: the same THABISO preloader, never blocking clicks', JSON.stringify(aw));
        if (SHOTS) await p.screenshot({ path: path.join(SHOTS, 'preloader-admin.png') });
        ok(await waitUntil(p, async () => !(await state(p)).exists, 6000), 'admin: leaves when loading finishes (or at its cap)', JSON.stringify(await state(p)));
        ok(await p.evaluate(() => !document.getElementById('tmPreloaderStyle')), 'admin: it tidies its style away too', '');
        ok(p._errs.length === 0, 'admin: no script errors', p._errs.join(' | '));
        await p.close();

        // signing in: the dashboard is swapped in with no reload, so the preloader is brought back until its cards are in
        await support.loginAs('administrator'); // makes sure the test administrator exists
        ({ p } = await open(browser, { url: '/admin.html' }));
        await p.waitForFunction(() => document.readyState === 'complete', { timeout: 60000 });
        await waitUntil(p, async () => !(await state(p)).exists, 5000);   // the page-load preloader has gone: whatever shows next is the sign-in one
        await p.evaluate(() => { const b = document.getElementById('cookieAcceptAll'); if (b) b.click(); });
        await p.waitForSelector('#adminEmail', { visible: true, timeout: 20000 });
        await p.type('#adminEmail', 'test.administrator@example.invalid');
        await p.type('#adminPassword', 'TestRunnerPass1!');
        // slow the dashboard's own data so there is something to wait for (replaces open()'s request handler)
        p.removeAllListeners('request');
        p.on('request', (r) => { if (/\/api\/admin\/(insights\/overview|analytics\/todays-schedule)/.test(r.url())) setTimeout(() => r.continue().catch(() => {}), 1500); else r.continue().catch(() => {}); });
        await p.evaluate(() => { const f = document.getElementById('adminEmail').form; if (f.requestSubmit) f.requestSubmit(); else f.submit(); });
        ok(await waitUntil(p, async () => { const s = await state(p); return s.exists && s.shown > 0.95; }, 6000), 'sign-in: the preloader comes back at once, over the dashboard', JSON.stringify(await state(p)));
        const during = await p.evaluate(() => ({ dash: document.getElementById('dashboardSection').style.display, overview: (document.getElementById('dbOverview') || {}).textContent.slice(0, 20), pointer: getComputedStyle(document.getElementById('tmPreloader')).pointerEvents }));
        ok(during.dash === 'flex' && /Loading/.test(during.overview) && during.pointer === 'none', 'sign-in: it is up while the cards are still loading, and never blocks clicks', JSON.stringify(during));
        ok(await waitUntil(p, async () => !(await state(p)).exists, 9000), 'sign-in: it leaves once the dashboard cards are in', JSON.stringify(await state(p)));
        const after = await p.evaluate(() => ({ overview: (document.getElementById('dbOverview') || {}).textContent.slice(0, 40), tiles: [...document.querySelectorAll('[id^="dashStat-"]')].filter((e) => e.textContent.trim() && e.textContent.trim() !== '...').length, style: !!document.getElementById('tmPreloaderStyle') }));
        ok(!/^Loading/.test(after.overview) && after.tiles >= 5 && !after.style, 'sign-in: the cards are filled (Overview and tiles) and its style is tidied away', JSON.stringify(after));
        ok(p._errs.length === 0, 'sign-in: no script errors', p._errs.join(' | '));
        await p.close();

        // reduced motion
        ({ p } = await open(browser, { holdMs: 4000, reducedMotion: true }));
        await sleep(900);
        const rm = await state(p);
        ok(rm.exists && rm.ring === 'none/none', 'reduced motion: the "O" does not pulse', JSON.stringify(rm));
        await p.close();
    } catch (e) {
        ok(false, 'browser test crashed', e && e.stack);
    } finally {
        await browser.close();
        await support.stop();
    }
    console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
    process.exit(fails ? 1 : 0);
})();
