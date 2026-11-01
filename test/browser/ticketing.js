// Event ticketing through the REAL homepage in headless Chrome on an isolated DB copy (test/support.js - the real database is never touched):
// the Events section's Get Tickets button -> the drawer (focus trap, Esc / backdrop, focus back to the button) -> choose tickets -> details
// with the countdown -> the PayFast hand-off (intercepted: nothing reaches PayFast) -> PayFast's notification (signed, sent by this test)
// -> back on /?tickets=<ref>&payment=success the drawer shows the tickets. Also: the phone bottom sheet, sold out mid-checkout, a cancelled
// payment, the event pop-up's button, and an event without tiers keeping its external link.
// The money / oversell / notification rules are proven against the API in test/ticketing-*.test.js; this file proves the page offers them.
// Not part of `npm test`: run with `npm run test:browser` (needs PUPPETEER_EXECUTABLE_PATH on this machine). Date offsets 1950-1959.
const fs = require('fs');
const path = require('path');
const support = require('../support');
const puppeteer = require('puppeteer');
const { generatePayFastItnSignature } = require('../../lib/payfast-signature');
const { BASE, sleep, api, pub, one, future } = support;
let fails = 0;
const ok = (c, n, detail) => { if (!c) fails++; console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '\n        -> ' + String(detail).slice(0, 500))); };
const SHOTS = process.env.TICKET_SHOTS_DIR || null;      // set to a folder to keep screenshots for a visual review
const shot = async (page, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, name + '.png') }); } };
const waitFor = async (fn, ms = 15000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(150); } return v; };

function itnFor(o) {
    const m = { m_payment_id: o.m_payment_id, pf_payment_id: `UI-PF-${Date.now()}`, payment_status: 'COMPLETE', item_name: 'x', item_description: '', amount_gross: (o.total_cents / 100).toFixed(2), amount_fee: '-1.00', amount_net: '1.00',
        custom_str1: '', custom_str2: '', custom_str3: '', custom_str4: '', custom_str5: '', custom_int1: '', custom_int2: '', custom_int3: '', custom_int4: '', custom_int5: '',
        name_first: 'UI', name_last: 'Buyer', email_address: o.buyer_email, merchant_id: '10000100' };
    m.signature = generatePayFastItnSignature(m, null);
    return m;
}

(async () => {
    await support.start();
    let browser;
    const made = [];
    try {
        // ── setup: a ticketed show and one without tiers that still uses an external link ──
        const when = `${future(1950)}T20:00`;
        const ev = (await api('POST', '/api/admin/events', { event_title: 'ZZ Ticket UI Show', event_datetime: when, venue_name: 'Joburg Theatre', poster_image_path: 'images/events/1.jpg', event_status: 'upcoming', sync_to_gcal: false })).body;
        made.push({ id: ev.id, title: 'ZZ Ticket UI Show', when });
        const gen = (await api('POST', `/api/admin/events/${ev.id}/ticket-types`, { name: 'General', price: '150', capacity: 20, max_per_order: 4, is_active: true })).body.tier;
        const vip = (await api('POST', `/api/admin/events/${ev.id}/ticket-types`, { name: 'VIP', price: '450', capacity: 1, max_per_order: 1, is_active: true, description: 'Front rows + meet and greet' })).body.tier;
        const when2 = `${future(1951)}T19:00`;
        const ext = (await api('POST', '/api/admin/events', { event_title: 'ZZ External Link Show', event_datetime: when2, venue_name: 'Elsewhere', ticket_sales_link: 'https://tickets.example.invalid/show', event_status: 'upcoming', sync_to_gcal: false })).body;
        made.push({ id: ext.id, title: 'ZZ External Link Show', when: when2 });
        ok(!!(ev.id && gen && vip && ext.id), 'setup: a ticketed show (General + VIP) and a show with an external ticket link', JSON.stringify({ ev, gen, vip, ext }));

        browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-quic'], executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined });
        const newPage = async (w, h) => {
            const ctx = await browser.createBrowserContext();
            const page = await ctx.newPage();
            await page.setViewport({ width: w, height: h });
            // PayFast is never reached: the hand-off is answered here and the posted form is kept for inspection
            await page.setRequestInterception(true);
            page.pfPosts = [];
            page.on('request', (req) => {
                const u = req.url();
                if (/payfast\.co\.za/.test(u)) { page.pfPosts.push({ url: u, method: req.method(), body: req.postData() || '' }); return req.respond({ status: 200, contentType: 'text/html', body: '<html><body><h1>PayFast stub</h1></body></html>' }); }
                if (/placehold\.co|fonts\.g|googletagmanager|google-analytics/.test(u)) return req.respond({ status: 200, contentType: 'text/plain', body: '' });
                req.continue();
            });
            return page;
        };
        const cardBtn = (id) => `.tk-open[data-ticket-event="${id}"]`;
        const drawerOpen = (page) => page.$eval('#ticketDrawer', el => el.classList.contains('atl-drawer--open')).catch(() => false);
        const drawerText = (page) => page.$eval('#ticketDrawerBody', el => el.innerText).catch(() => '');
        const gotoHome = async (page, qs = '') => {
            await page.goto(`${BASE}/${qs}`, { waitUntil: 'domcontentloaded' });
            await page.waitForSelector('#upcomingEventsGrid .ev-card', { timeout: 20000 });
            // a fresh browser gets the cookie-choices pop-up over everything (as test/browser/accolades.js does: answer it first)
            await sleep(300);
            await page.evaluate(() => { const x = document.getElementById('cookieRejectAll'); if (x && x.offsetParent) x.click(); });
            await sleep(300);
        };

        // ═══ desktop ═══
        const page = await newPage(1440, 900);
        await gotoHome(page);
        await page.waitForSelector(cardBtn(ev.id), { timeout: 15000 });
        const btnText = await page.$eval(cardBtn(ev.id), el => el.innerText);
        ok(/GET TICKETS/i.test(btnText) && /R\s?150\.00/.test(btnText.replace(/ | /g, ' ')), 'the ticketed show\'s card says Get Tickets, from R 150.00', btnText);
        const extLink = await page.evaluate((title) => { const card = [...document.querySelectorAll('.ev-card')].find(c => c.innerText.includes(title)); const a = card && card.querySelector('a.ev-card__ticket-btn'); return a ? a.getAttribute('href') : null; }, 'ZZ External Link Show');
        ok(extLink === 'https://tickets.example.invalid/show', 'a show without ticket types keeps its external ticket link exactly as before', extLink);

        await page.focus(cardBtn(ev.id));
        await page.keyboard.press('Enter');
        await waitFor(() => drawerOpen(page));
        await page.waitForSelector('#ticketDrawer .tk-tier', { timeout: 10000 });
        await sleep(450);
        const focusInside = await page.evaluate(() => !!document.activeElement && !!document.activeElement.closest('#ticketDrawer'));
        ok(await drawerOpen(page) && focusInside, 'Get Tickets opens the drawer (no page change) and moves focus into it', await drawerText(page));
        await shot(page, 'desktop-1-choose');
        // focus trap: Tab many times, focus never leaves the drawer
        let escaped = false;
        for (let i = 0; i < 15; i++) { await page.keyboard.press('Tab'); if (!(await page.evaluate(() => !!document.activeElement.closest('#ticketDrawer')))) escaped = true; }
        ok(!escaped, 'focus is trapped inside the open drawer (Tab never reaches the page behind it)', '');
        await page.keyboard.press('Escape');
        await waitFor(async () => !(await drawerOpen(page)));
        await sleep(450);
        const backOnBtn = await page.evaluate((sel) => document.activeElement === document.querySelector(sel), cardBtn(ev.id));
        ok(!(await drawerOpen(page)) && backOnBtn, 'Esc closes it and focus goes back to the Get Tickets button', '');
        await page.click(cardBtn(ev.id));
        await waitFor(() => drawerOpen(page));
        await sleep(400);
        await page.mouse.click(40, 450);                                     // the backdrop, left of the 600px drawer
        await waitFor(async () => !(await drawerOpen(page)));
        ok(!(await drawerOpen(page)), 'clicking the backdrop closes it', '');

        // step 1 -> step 2 (wait out the slide-in: a click mid-animation lands where the button WAS)
        await sleep(450);
        await page.click(cardBtn(ev.id));
        await waitFor(() => drawerOpen(page));
        await page.waitForSelector('#ticketDrawer .tk-step[data-tier="' + gen.id + '"][data-d="1"]', { timeout: 10000 });
        await sleep(500);
        const contDisabled = await page.$eval('#ticketDrawer .tk-continue', el => el.disabled);
        await page.click('#ticketDrawer .tk-step[data-tier="' + gen.id + '"][data-d="1"]');
        await page.click('#ticketDrawer .tk-step[data-tier="' + gen.id + '"][data-d="1"]');
        const total = await page.$eval('#ticketDrawer .tk-total', el => el.innerText.replace(/ | /g, ' '));
        ok(contDisabled && /2 tickets/.test(total) && /R 300\.00/.test(total), 'choosing 2 General tickets shows a running total of R 300.00 (Continue starts disabled)', total);
        await page.click('#ticketDrawer .tk-continue');
        await page.waitForSelector('#tkBuyer', { timeout: 10000 });
        const t1 = await page.$eval('.tk-hold__time', el => el.textContent);
        await sleep(1300);
        const t2 = await page.$eval('.tk-hold__time', el => el.textContent);
        ok(/^(10:00|9:5\d)$/.test(t1) && t1 !== t2, 'Continue holds the tickets: "Tickets held for 9:59" counting down', `${t1} -> ${t2}`);
        ok((await one('SELECT reserved FROM ticket_types WHERE id = ?', [gen.id])).reserved === 2, '...and the server really holds 2 General tickets', '');
        const terms = await page.$eval('#ticketDrawer .tk-terms', el => ({ text: el.innerText, items: el.querySelectorAll('ul li').length, more: !!el.querySelector('details summary') })).catch(() => null);
        ok(!!terms && terms.items === 3 && /cancelled/.test(terms.text) && /postponed/.test(terms.text) && terms.more && /accept the ticket terms/.test(await page.$eval('.tk-consent', el => el.innerText)),
            'step 2 shows the ticket terms (3 key lines + "Read all ticket terms") and one checkbox for terms + Privacy Policy', JSON.stringify(terms));
        const poster = await page.$eval('#ticketDrawer .tk-event__poster img', img => ({ ok: img.complete && img.naturalWidth > 0, src: img.getAttribute('src'), alt: img.alt, h: img.getBoundingClientRect().height })).catch(() => null);
        ok(!!poster && poster.ok && poster.src === '/images/events/1.jpg' && /ZZ Ticket UI Show/.test(poster.alt) && poster.h >= 140, 'the "Your details" step shows the show\'s poster at the top, so the buyer knows which show they are paying for', JSON.stringify(poster));
        await shot(page, 'desktop-2-details');
        await page.click('#ticketDrawer .tk-pay');
        await sleep(200);
        const errs = await page.$$eval('#ticketDrawer .bk-step-err.show', els => els.map(e => e.textContent));
        ok(errs.length === 4 && await page.$eval('#tkName', el => el.getAttribute('aria-invalid') === 'true'), 'Pay with an empty form explains each missing field (name, email, phone, consent) next to it', JSON.stringify(errs));
        await page.type('#tkName', 'Lindiwe Ui');
        await page.type('#tkEmail', 'lindiwe.ui@example.invalid');
        await page.type('#tkPhone', '082 123 4567');
        await page.$eval('#ticketDrawer .tk-names-toggle', el => { el.scrollIntoView({ block: 'center' }); el.click(); });
        await page.waitForSelector('#tkHolder0', { visible: true });
        await page.type('#tkHolder0', 'Sipho Guest');
        await page.$eval('#tkPopia', el => { el.scrollIntoView({ block: 'center' }); el.click(); });
        const leftover = await page.$$eval('#ticketDrawer .bk-step-err.show', els => els.length);
        ok(leftover === 0, 'filling in a field clears its error message (no red text left once everything is filled)', leftover + ' still shown');
        await shot(page, 'desktop-3-filled');
        await Promise.all([page.waitForNavigation({ timeout: 15000 }).catch(() => null), page.click('#ticketDrawer .tk-pay')]);
        const post = page.pfPosts[0];
        ok(!!post && post.method === 'POST' && /m_payment_id=TKT_\d+/.test(post.body) && /amount=300\.00/.test(post.body) && /signature=[0-9a-f]{32}/.test(post.body),
            'Pay hands off to PayFast with a POST of the server-built, signed form (TKT_ id, R300.00) - through the shared tmPostToPayfast', post && post.body.slice(0, 300));
        const order = await one("SELECT * FROM ticket_orders WHERE event_id = ? AND buyer_email = 'lindiwe.ui@example.invalid'", [ev.id]);
        ok(order && order.status === 'pending' && order.holder_names === '["Sipho Guest",null]','the order is still PENDING after the hand-off - leaving for PayFast pays nothing', JSON.stringify(order));

        // PayFast's notification arrives (signed like PayFast), then the buyer comes back
        await pub('POST', '/api/payment/webhook/payfast', itnFor(order));
        await waitFor(async () => (await one('SELECT status FROM ticket_orders WHERE id = ?', [order.id])).status === 'paid');
        await gotoHome(page, `?tickets=${encodeURIComponent(order.public_reference)}&payment=success`);
        await waitFor(() => drawerOpen(page));
        await page.waitForSelector('#ticketDrawer .tk-ticket', { timeout: 20000 });
        const paidText = await drawerText(page);
        const qrs = await page.$$eval('#ticketDrawer .tk-ticket__qr', els => els.map(e => e.getAttribute('src').slice(0, 22)));
        const search = await page.evaluate(() => window.location.search);
        ok(/Payment received/.test(paidText) && qrs.length === 2 && qrs.every(s => s === 'data:image/png;base64,') && /Sipho Guest/.test(paidText) && /l\*+@example\.invalid/.test(paidText),
            'back from PayFast: the drawer reopens on the order and shows both tickets with QR codes, the names, and where they were e-mailed', paidText);
        ok(!/tickets=/.test(search), 'the order reference is removed from the address bar', search);
        const pdfHref = await page.$eval('#ticketDrawer .tk-pdf', el => el.getAttribute('href'));
        const pdf = await fetch(BASE + pdfHref);
        ok(pdf.status === 200 && /pdf/.test(pdf.headers.get('content-type')), 'Download PDF tickets works', `${pdf.status}`);
        await shot(page, 'desktop-4-tickets');

        // a cancelled payment: back on the cancel URL the tickets are still held, with Try again / Release
        const cx = (await pub('POST', '/api/public/ticket-orders', { event_id: ev.id, items: [{ ticket_type_id: gen.id, quantity: 1 }] })).body.order;
        await pub('POST', `/api/public/ticket-orders/${cx.reference}/checkout`, { buyer_name: 'Cancel Ui', buyer_email: 'cancel.ui@example.invalid', buyer_phone: '0821234567', popia_consent: true, terms_accepted: true });
        await gotoHome(page, `?tickets=${encodeURIComponent(cx.reference)}&payment=cancel`);
        await page.waitForSelector('#ticketDrawer .tk-retry-pay', { timeout: 15000 });
        const cxText = await drawerText(page);
        ok(/cancelled/i.test(cxText) && /nothing was charged/i.test(cxText) && /\d+:\d{2}/.test(cxText), 'payment cancelled: "nothing was charged", the tickets still held (countdown), Try paying again / Release', cxText);
        await shot(page, 'desktop-5-cancelled');
        await page.click('#ticketDrawer .tk-change');                        // Release my tickets
        await waitFor(async () => (await one('SELECT status FROM ticket_orders WHERE public_reference = ?', [cx.reference])).status === 'expired');
        ok((await one('SELECT status FROM ticket_orders WHERE public_reference = ?', [cx.reference])).status === 'expired', '...Release gives the tickets back at once', '');

        // the event pop-up: its button opens the same drawer
        await gotoHome(page);
        await page.evaluate((title) => { const card = [...document.querySelectorAll('.ev-card')].find(c => c.innerText.includes(title)); card.querySelector('.ev-card__poster').click(); }, 'ZZ Ticket UI Show');
        await page.waitForSelector('#eventDetailsModal.in, #eventDetailsModal.show', { timeout: 10000 });
        const modalBtn = await page.$eval('#modalEventTicketBtn', el => ({ text: el.innerText, ev: el.getAttribute('data-ticket-event'), target: el.getAttribute('target') }));
        ok(/Get Tickets/i.test(modalBtn.text) && Number(modalBtn.ev) === ev.id && !modalBtn.target, 'the event pop-up\'s ticket button says Get Tickets and opens the drawer (not a new tab)', JSON.stringify(modalBtn));
        await sleep(500);                                                     // the pop-up's fade-in
        await page.click('#modalEventTicketBtn');
        await waitFor(() => drawerOpen(page));
        const modalGone = await page.$eval('#eventDetailsModal', el => !el.classList.contains('in') && !el.classList.contains('show'));
        ok(await drawerOpen(page) && modalGone, '...the pop-up closes and the drawer opens', '');
        await page.close();

        // ═══ phone ═══
        const phone = await newPage(390, 844);
        await gotoHome(phone);
        await phone.waitForSelector(cardBtn(ev.id), { timeout: 15000 });
        const closedBox = await phone.$eval('#ticketDrawer', el => getComputedStyle(el).transform);
        // the page scrolls smoothly: let it settle, then press the button itself (a coordinate click mid-scroll can land on the card)
        await phone.evaluate((sel) => document.querySelector(sel).scrollIntoView({ block: 'center' }), cardBtn(ev.id));
        await sleep(900);
        await phone.$eval(cardBtn(ev.id), el => el.click());
        await waitFor(() => drawerOpen(phone));
        await phone.waitForSelector('#ticketDrawer .tk-tier', { timeout: 10000 });
        await sleep(600);
        const box = await phone.$eval('#ticketDrawer', el => { const r = el.getBoundingClientRect(); return { top: r.top, left: r.left, width: r.width, height: r.height, transform: getComputedStyle(el).transform }; });
        ok(/matrix\(1, 0, 0, 1, 0, [1-9]/.test(closedBox) && Math.round(box.width) === 390 && Math.round(box.top) === 0 && box.height >= 840,
            'on a phone it is a full-height bottom sheet: parked below the screen, then risen to fill it', JSON.stringify({ closedBox, box }));
        const targets = await phone.$$eval('#ticketDrawer .tk-step, #ticketDrawer .atl-drawer__close, #ticketDrawer .tk-continue', els => els.map(e => { const r = e.getBoundingClientRect(); return Math.min(r.width, r.height); }));
        ok(targets.length >= 5 && targets.every(s => s >= 44), 'every control in the sheet is at least 44px (steppers, close, Continue)', JSON.stringify(targets));
        const noScroll = await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
        ok(noScroll, 'no sideways page scroll at phone width', '');
        await shot(phone, 'phone-1-choose');
        // sold out mid-checkout: someone else takes the only VIP ticket while this buyer is choosing
        await phone.click('#ticketDrawer .tk-step[data-tier="' + vip.id + '"][data-d="1"]');
        await pub('POST', '/api/public/ticket-orders', { event_id: ev.id, items: [{ ticket_type_id: vip.id, quantity: 1 }] });
        await phone.click('#ticketDrawer .tk-continue');
        await phone.waitForSelector('#ticketDrawer .tk-tier--gone', { timeout: 10000 });
        const soldText = await drawerText(phone);
        ok(/just sold out/i.test(soldText) && /Sold out/.test(soldText) && !(await phone.$('#tkBuyer')), 'sold out mid-checkout: the buyer is told, the VIP row is marked Sold out, and they stay on step 1 to choose again', soldText);
        await shot(phone, 'phone-2-soldout');
        await phone.click('#ticketDrawer .tk-step[data-tier="' + gen.id + '"][data-d="1"]');
        await phone.click('#ticketDrawer .tk-continue');
        await phone.waitForSelector('#tkBuyer', { timeout: 10000 });
        await shot(phone, 'phone-3-details');
        const formFits = await phone.evaluate(() => document.querySelector('#ticketDrawer .atl-drawer__body').scrollWidth <= window.innerWidth);
        ok(formFits, 'the details step fits the phone width', '');
        await phone.close();
    } catch (e) {
        fails++;
        console.log('FAIL unexpected error: ' + (e && e.stack || e));
    } finally {
        for (const m of made) await api('PUT', `/api/admin/events/${m.id}`, { event_title: m.title, event_datetime: m.when, event_status: 'cancelled', sync_to_gcal: false }).catch(() => {});
        if (browser) await browser.close().catch(() => {});
        await support.stop();
    }
    console.log(fails ? `\n${fails} check(s) FAILED` : '\nAll ticketing browser checks passed');
    process.exit(fails ? 1 : 0);
})();
