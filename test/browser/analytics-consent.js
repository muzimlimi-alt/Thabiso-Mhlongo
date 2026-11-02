// The public site's own analytics (tracker.js) follow the cookie pop-up's Analytics choice, on the real homepage in headless Chrome:
//   * "Reject non-essential": nothing is sent and no visitor cookie is set, however long the visitor stays or scrolls;
//   * switching Analytics on in Cookie Settings starts tracking at once (no reload): a visit, then the sections looked at and the
//     things done (an event opened) - as their own events, not extra page views;
//   * switching it off again stops it and deletes the visitor cookie; nothing more is sent;
//   * "Accept all" on a first visit tracks from the start.
// Chrome does not show a beacon's body to the test, so the page keeps a copy of each beacon it sends (window.__beacons) and still sends it.
// Not part of `npm test`: run with `npm run test:browser` (needs PUPPETEER_EXECUTABLE_PATH).
const support = require('../support');
const puppeteer = require('puppeteer');
const { BASE, sleep } = support;
let fails = 0;
const ok = (c, n, detail) => { if (!c) fails++; console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '\n        -> ' + String(detail).slice(0, 500))); };

function recordBeacons() {
    window.__beacons = [];
    const orig = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function (url, data) {
        if (String(url).indexOf('analytics/track') !== -1 && data && data.text) {
            data.text().then(function (t) { try { window.__beacons.push(JSON.parse(t)); } catch (e) {} });
        }
        // the cookie pop-up's own anonymous note of the answer, kept apart
        if (String(url).indexOf('analytics/consent') !== -1 && data && data.text) {
            data.text().then(function (t) { try { (window.__choices = window.__choices || []).push(JSON.parse(t)); } catch (e) {} });
        }
        return orig(url, data);
    };
}

(async () => {
    await support.start();
    let browser;
    try {
        browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'], executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined });
        const open = async () => {
            const ctx = await browser.createBrowserContext();
            const page = await ctx.newPage();
            await page.setViewport({ width: 1280, height: 900 });
            page.errs = [];
            page.on('pageerror', e => page.errs.push(e.message.slice(0, 200)));
            await page.evaluateOnNewDocument(recordBeacons);
            await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
            await page.waitForSelector('#cookieModal.is-visible', { timeout: 15000 });
            await sleep(400);
            return page;
        };
        const sent = async (page) => { await sleep(150); return page.evaluate(() => window.__beacons.slice()); };
        const cookie = async (page) => (await page.cookies()).find(c => c.name === '_tm_vid');
        const scrollTo = async (page, sel) => { await page.evaluate((s) => { const el = document.querySelector(s); if (el) el.scrollIntoView({ block: 'start' }); }, sel); await sleep(1800); };
        const settings = async (page, analytics) => {
            await page.evaluate(() => document.getElementById('openCookieSettings').click());
            await page.waitForSelector('#cookieModal.is-visible', { timeout: 5000 });
            await sleep(300);
            await page.evaluate((on) => { const cb = document.getElementById('prefAnalytics'); if (cb.checked !== on) cb.click(); }, analytics);
            await page.evaluate(() => document.getElementById('cookieSavePrefs').click());
            await sleep(800);
        };

        // ── said no ──
        const p = await open();
        await p.evaluate(() => document.getElementById('cookieRejectAll').click());
        await sleep(500);
        await scrollTo(p, '#events');
        await scrollTo(p, '#contact');
        let s = await sent(p);
        ok(s.length === 0 && !(await cookie(p)), 'Reject non-essential: nothing sent and no visitor cookie, even after scrolling the page', JSON.stringify([s, await cookie(p)]));
        const choices = await p.evaluate(() => window.__choices || []);
        ok(choices.length === 1 && choices[0].choice === 'reject_all' && choices[0].analytics === false && choices[0].change === false &&
            !Object.keys(choices[0]).some(k => /visitor|session/.test(k)),
            '...but the answer itself is noted anonymously (reject, analytics no, first answer - no visitor or session id)', JSON.stringify(choices));

        // ── switched on later: starts at once ──
        await scrollTo(p, '#hero');
        await settings(p, true);
        s = await sent(p);
        const changed = (await p.evaluate(() => window.__choices || [])).slice(-1)[0];
        ok(!!changed && changed.choice === 'custom' && changed.analytics === true && changed.change === true, 'changing the answer in Cookie Settings is noted as a change (own choice, analytics yes)', JSON.stringify(changed));
        const vidCookie = await cookie(p);
        const pv = s.filter(b => b.event === 'pageview');
        ok(pv.length === 1 && !!vidCookie && pv[0].visitor_id === vidCookie.value, 'Analytics switched on in Cookie Settings: the visit is counted straight away (no reload) and the visitor cookie is set', JSON.stringify(s));
        await p.waitForSelector('#upcomingEventsGrid .live-event-card', { timeout: 20000 });
        await scrollTo(p, '#events');
        // the section must stay on screen for a second, and the beacon copy is read back asynchronously: allow up to 5 s
        for (let i = 0; i < 25 && !(await sent(p)).some(b => b.event === 'section_view' && b.name === 'events'); i++) await sleep(200);
        s = await sent(p);
        ok(s.some(b => b.event === 'section_view' && b.name === 'events'), 'a section on screen for a second is sent as a section view (Events)', JSON.stringify(s.filter(b => b.event === 'section_view')));
        await p.evaluate(() => document.querySelector('#upcomingEventsGrid .live-event-card').click());
        await sleep(600);
        s = await sent(p);
        const opened = s.filter(b => b.event === 'interaction' && b.name === 'event_opened');
        ok(opened.length === 1 && /^\d+$/.test(opened[0].detail), 'opening an event is sent as an action with the event id', JSON.stringify(opened));
        ok(s.filter(b => b.event === 'pageview').length === 1, 'section views and actions never count as extra page views (still 1)', JSON.stringify(s.map(b => b.event)));
        await p.evaluate(() => { if (window.jQuery) window.jQuery('#eventDetailsModal').modal('hide'); });
        await sleep(600);

        // ── switched off again: stops and forgets ──
        await settings(p, false);
        s = await sent(p);
        const before = s.length, last = s[s.length - 1];
        await scrollTo(p, '#contact');
        await scrollTo(p, '#gallery');
        s = await sent(p);
        ok(!(await cookie(p)) && s.length === before, 'Analytics switched off: the visitor cookie is deleted and nothing more is sent', JSON.stringify([await cookie(p), s.slice(before)]));
        ok(!!last && last.event === 'page_exit', '...the visit is closed with a last "page exit" before it stops', JSON.stringify(last));
        ok(p.errs.length === 0, 'no script errors', p.errs.join(' | '));

        // ── "Accept all" on a first visit ──
        const q = await open();
        await q.evaluate(() => document.getElementById('cookieAcceptAll').click());
        await sleep(800);
        const qs = await sent(q);
        ok(qs.some(b => b.event === 'pageview') && !!(await cookie(q)), 'Accept all: the visit is tracked from the start', JSON.stringify(qs));
        ok(q.errs.length === 0, 'no script errors (accept all)', q.errs.join(' | '));
    } catch (e) {
        fails++;
        console.log('FAIL unexpected error: ' + (e && e.stack || e));
    } finally {
        if (browser) await browser.close();
        await support.stop();
    }
    console.log(fails ? `${fails} analytics consent check(s) failed` : 'All analytics consent browser checks passed');
    process.exit(fails ? 1 : 0);
})();
