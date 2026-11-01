// Cloudflare Turnstile in the real Get Tickets drawer, headless Chrome, isolated DB copy (test/support.js). The test server runs WITH
// Turnstile switched on using Cloudflare's published TEST keys (site key 1x00000000000000000000AA always passes, secret
// 1x0000000000000000000000000000000AA always verifies) - so the real widget script, the real CSP and the real siteverify call are exercised.
//   * Continue -> the "are you human?" check appears in the drawer, passes, and the tickets are held (step 2);
//   * the server refuses a reservation without a token (403) - the check cannot be skipped by calling the API directly.
// Not part of `npm test`: run with `npm run test:browser` (needs PUPPETEER_EXECUTABLE_PATH and internet). Date offset 1999.
process.env.TEST_TURNSTILE_SITE_KEY = '1x00000000000000000000AA';
process.env.TEST_TURNSTILE_SECRET_KEY = '1x0000000000000000000000000000000AA';
const fs = require('fs');
const path = require('path');
const support = require('../support');
const puppeteer = require('puppeteer');
const { BASE, sleep, api, pub, future } = support;
let fails = 0;
const ok = (c, n, detail) => { if (!c) fails++; console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '\n        -> ' + String(detail).slice(0, 600))); };
const SHOTS = process.env.TICKET_SHOTS_DIR || null;
const shot = async (page, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, name + '.png') }); } };
const until = async (page, fn, ms = 30000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await page.evaluate(fn).catch(() => false); if (v) return v; await sleep(250); } return false; };

(async () => {
    await support.start();
    let browser;
    const made = [];
    try {
        const when = `${future(1999)}T21:00`;
        const ev = (await api('POST', '/api/admin/events', { event_title: 'ZZ Human Check Show', event_datetime: when, venue_name: 'Bot Hall', event_status: 'upcoming', sync_to_gcal: false })).body;
        made.push({ id: ev.id, title: 'ZZ Human Check Show', when });
        const tier = (await api('POST', `/api/admin/events/${ev.id}/ticket-types`, { name: 'General', price: '120', capacity: 10, max_per_order: 4, is_active: true })).body.tier;

        const info = await pub('GET', `/api/public/events/${ev.id}/tickets`);
        const direct = await pub('POST', '/api/public/ticket-orders', { event_id: ev.id, items: [{ ticket_type_id: tier.id, quantity: 1 }] });
        ok(info.body.bot_check === '1x00000000000000000000AA' && direct.status === 403 && direct.body.code === 'BOT_CHECK_FAILED',
            'switched on: the drawer gets the site key, and a reservation WITHOUT the check is refused by the server (403)', JSON.stringify([info.body.bot_check, direct.status, direct.body]));

        browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-quic'], executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined });
        const ctx = await browser.createBrowserContext();
        const page = await ctx.newPage();
        await page.setViewport({ width: 390, height: 844 });
        const errs = [], csp = [];
        page.on('pageerror', e => errs.push(e.message.slice(0, 200)));
        page.on('console', m => { if (/Content Security Policy/i.test(m.text())) csp.push(m.text().slice(0, 200)); });
        await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector(`.tk-open[data-ticket-event="${ev.id}"]`, { timeout: 20000 });
        await sleep(300);
        await page.evaluate(() => { const x = document.getElementById('cookieRejectAll'); if (x && x.offsetParent) x.click(); });
        await sleep(300);
        await page.$eval(`.tk-open[data-ticket-event="${ev.id}"]`, el => el.click());
        await page.waitForSelector('#ticketDrawer .tk-tier', { timeout: 15000 });
        await sleep(500);
        await page.$eval(`#ticketDrawer .tk-step[data-tier="${tier.id}"][data-d="1"]`, el => el.click());
        await page.$eval('#ticketDrawer .tk-continue', el => el.click());
        const widget = await until(page, () => !!document.querySelector('#ticketDrawer .tk-bot__widget iframe, #ticketDrawer .tk-bot__widget input[name="cf-turnstile-response"]'), 20000);
        await shot(page, 'turnstile-1-check');
        ok(!!widget, 'Continue shows the "are you human?" check inside the drawer (Cloudflare\'s widget loaded - the CSP allows it)', JSON.stringify({ csp, errs }));
        const held = await until(page, () => !!document.querySelector('#ticketDrawer .tk-pay'), 30000);
        await shot(page, 'turnstile-2-held');
        const order = await support.one('SELECT status, public_reference FROM ticket_orders WHERE event_id = ? ORDER BY id DESC LIMIT 1', [ev.id]);
        ok(!!held && !!order && order.status === 'pending', 'the check passes (Cloudflare test key), the server verifies it with Cloudflare, and the tickets are held - on to "Your details"', JSON.stringify(order));
        ok(errs.length === 0 && csp.length === 0, 'no script errors and no Content-Security-Policy blocks', JSON.stringify({ errs, csp }));
        await page.close();
    } catch (e) {
        fails++;
        console.log('FAIL unexpected error: ' + (e && e.stack || e));
    } finally {
        for (const m of made) await api('PUT', `/api/admin/events/${m.id}`, { event_title: m.title, event_datetime: m.when, event_status: 'cancelled', sync_to_gcal: false }).catch(() => {});
        if (browser) await browser.close().catch(() => {});
        await support.stop();
    }
    console.log(fails ? `\n${fails} check(s) FAILED` : '\nAll Turnstile browser checks passed');
    process.exit(fails ? 1 : 0);
})();
