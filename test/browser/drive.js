// Shared driver
// Browser test for the public booking drawer (index.html). Boots the real app on an isolated database copy
// (test/support.js - SMTP mocked, never touches the real database), drives the REAL wizard in headless Chrome
// via puppeteer, and prints PASS/FAIL per check. Provides launch(), openDrawer() (with optional request mocks) and completeStep1/2/toStep3().
// Not part of `npm test` (that runner only loads test/*.test.js): run it with `npm run test:browser`.
const path = require('path');
const support = require('../support');
const puppeteer = require('puppeteer');
const sleep = ms => new Promise(r => setTimeout(r, ms));
exports.support = support;
exports.sleep = sleep;
exports.BASE = support.BASE;

exports.launch = async () => puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-quic'] });

// Opens the site + booking drawer. `mocks` lets a script intercept extra URLs: [{ test: RegExp, respond: fn(req) }].
exports.openDrawer = async (browser, { w = 1440, h = 900, mocks = [], onSubmit } = {}) => {
    const ctx = await browser.createBrowserContext();   // clean localStorage per page (drafts persist per browser)
    const p = await ctx.newPage();
    await p.setViewport({ width: w, height: h, isMobile: w < 500, hasTouch: w < 500 });
    p._errs = []; p._reqs = [];
    p.on('pageerror', e => p._errs.push(e.message.slice(0, 160)));
    p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) p._errs.push('console: ' + m.text().slice(0, 140)); });
    await p.setRequestInterception(true);
    p.on('request', async r => {
        const u = r.url();
        p._reqs.push(r.method() + ' ' + u.replace(exports.BASE, ''));
        for (const m of mocks) if (m.test.test(u)) return m.respond(r);
        if (r.method() === 'POST' && /\/api\/public\/bookings$/.test(u)) {
            if (onSubmit) onSubmit(JSON.parse(r.postData() || '{}'));
            return r.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, booking_id: 4242 }) });
        }
        r.continue();
    });
    await p.goto(exports.BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(2500);
    await p.evaluate(() => { const x = document.getElementById('cookieRejectAll'); if (x && x.offsetParent) x.click(); });
    await p.evaluate(() => window.openAtlDrawer('bookingDrawer'));
    await sleep(900);
    return p;
};

const visible = (p, sel) => p.evaluate(s => { const e = document.querySelector(s); return !!(e && e.offsetParent); }, sel);

// Step 1: service + date + event details, then Next. `pick(page)` may choose the date cell itself.
exports.completeStep1 = async (p, { svcId = '15', eventName = 'Gala Dinner', type = 'Corporate Event', pick } = {}) => {
    await p.waitForFunction(() => document.querySelectorAll('#bkServiceDropdown option').length > 1, { timeout: 20000 });
    await p.select('#bkServiceDropdown', svcId);
    await p.click('#bkAddServiceBtn');
    await sleep(300);
    if (pick) await pick(p);
    else {
        // First clickable available date at least 7 days out (the server enforces 48h notice).
        const pickable = () => p.evaluate(() => {
            const min = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);
            const c = [...document.querySelectorAll('.tm-cal-cell--avail.tm-cal-cell--clickable')].find(x => x.getAttribute('data-date') >= min);
            return c ? c.getAttribute('data-date') : null;
        });
        for (let i = 0; i < 4 && !(await pickable()); i++) { await p.click('#calNext'); await sleep(1200); }
        // find + click in ONE evaluate (the grid re-renders on month load, so a separate find/click can race)
        for (let i = 0; i < 5; i++) {
            const clicked = await p.evaluate(() => { const min = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10); const c = [...document.querySelectorAll('.tm-cal-cell--avail.tm-cal-cell--clickable')].find(x => x.getAttribute('data-date') >= min); if (c) { c.click(); return true; } return false; });
            if (clicked) break; await sleep(800);
        }
    }
    await p.waitForFunction(() => !document.getElementById('bookNext1').disabled, { timeout: 15000 });
    await p.type('#bookEventName', eventName);
    await p.select('#bookType', type);
    await p.click('#bookNext1'); await sleep(600);
};
exports.completeStep2 = async (p, { name = 'Test Client Person', email = `bk.${Date.now()}@example.invalid`, cell = '0821234567' } = {}) => {
    await p.type('#bookName', name); await p.type('#bookEmail', email); await p.type('#bookCell', cell);
    await p.click('#bookNext2');
    await p.waitForFunction(() => document.getElementById('bookStep3').classList.contains('active'), { timeout: 15000 });
    await sleep(700);
};
exports.toStep3 = async (p, o = {}) => { await exports.completeStep1(p, o.step1); await exports.completeStep2(p, o.step2); };
exports.visible = visible;
