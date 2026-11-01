// Event ticketing - an ACCESSIBILITY scan of every ticketing screen with axe-core (the open-source checker browsers' own audits use),
// injected into the real pages in headless Chrome on an isolated DB copy (test/support.js). Nothing is installed: axe-core is fetched once
// from cdnjs and injected. Scanned (each scoped to the ticketing part of the page, so older parts of the site don't drown the result):
//   public - the Get Tickets drawer (choose tickets, your details, paid tickets), the event card + its Share menu, /t/<token>;
//   door   - the /checkin scanner opened from a door link;
//   admin  - Events -> Ticket Sales, the order drawer, the event drawer's Tickets tab.
// Fails on "critical" or "serious" findings (WCAG 2.1 A/AA rules); "moderate"/"minor" ones are listed for information.
// Not part of `npm test`: run with `npm run test:browser` (needs PUPPETEER_EXECUTABLE_PATH and internet for cdnjs). Date offset 1995.
const support = require('../support');
const puppeteer = require('puppeteer');
const { generatePayFastItnSignature } = require('../../lib/payfast-signature');
const { BASE, sleep, api, pub, one, q, future } = support;
const AXE_URL = 'https://cdnjs.cloudflare.com/ajax/libs/axe-core/4.10.2/axe.min.js';
let fails = 0;
const ok = (c, n, detail) => { if (!c) fails++; console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '\n        -> ' + String(detail).slice(0, 1500))); };
const waitFor = async (fn, ms = 15000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(150); } return v; };

async function adminCookie() {
    const r = await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'test.runner@example.invalid', password: 'TestRunnerPass1!' }) });
    return r.headers.get('set-cookie').split(';')[0];
}

async function paidOrder(eventId, tierId, n, buyerName) {
    const o = (await pub('POST', '/api/public/ticket-orders', { event_id: eventId, items: [{ ticket_type_id: tierId, quantity: n }] })).body.order;
    await pub('POST', `/api/public/ticket-orders/${o.reference}/checkout`, { buyer_name: buyerName, buyer_email: `a11y.${Date.now()}@example.invalid`, buyer_phone: '0821234567', popia_consent: true, terms_accepted: true });
    const row = await one('SELECT * FROM ticket_orders WHERE public_reference = ?', [o.reference]);
    const m = { m_payment_id: row.m_payment_id, pf_payment_id: `A11Y-${Date.now()}`, payment_status: 'COMPLETE', item_name: 'x', item_description: '', amount_gross: (row.total_cents / 100).toFixed(2), amount_fee: '-1.00', amount_net: '1.00',
        custom_str1: '', custom_str2: '', custom_str3: '', custom_str4: '', custom_str5: '', custom_int1: '', custom_int2: '', custom_int3: '', custom_int4: '', custom_int5: '', name_first: 'A', name_last: 'B', email_address: row.buyer_email, merchant_id: '10000100' };
    m.signature = generatePayFastItnSignature(m, null);
    await pub('POST', '/api/payment/webhook/payfast', m);
    await waitFor(async () => (await one('SELECT status FROM ticket_orders WHERE id = ?', [row.id])).status === 'paid');
    return { order: row, reference: o.reference, tickets: await q('SELECT * FROM tickets WHERE order_id = ? ORDER BY id', [row.id]) };
}

(async () => {
    await support.start();
    let browser;
    const made = [];
    const AXE = await (await fetch(AXE_URL)).text();
    try {
        const when = `${future(1995)}T20:00`;
        const ev = (await api('POST', '/api/admin/events', { event_title: 'ZZ Accessible Show', event_datetime: when, venue_name: 'A11y Hall', event_status: 'upcoming', sync_to_gcal: false })).body;
        made.push({ id: ev.id, title: 'ZZ Accessible Show', when });
        const tier = (await api('POST', `/api/admin/events/${ev.id}/ticket-types`, { name: 'General', price: '150', capacity: 30, max_per_order: 4, is_active: true })).body.tier;
        const P = await paidOrder(ev.id, tier.id, 2, 'Ayanda Access');
        const passLink = (await api('POST', `/api/admin/ticketing/events/${ev.id}/door-passes`, { label: 'A11y door' })).body.link;
        const cookie = await adminCookie();

        browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-quic'], executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined });
        const newPage = async (w, h, withCookie) => {
            const ctx = await browser.createBrowserContext();
            const p = await ctx.newPage();
            await p.setViewport({ width: w, height: h });
            await p.evaluateOnNewDocument(() => { try { delete Navigator.prototype.share; } catch (e) {} });
            if (withCookie) { const [name, ...rest] = cookie.split('='); await p.setCookie({ name, value: rest.join('='), url: BASE }); }
            await p.setRequestInterception(true);
            p.on('request', r => {
                const u = r.url();
                if (/\/api\/admin\/maps-config/.test(u)) return r.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, key: '' }) });
                if (/placehold\.co|googletagmanager|google-analytics|payfast\.co\.za/.test(u)) return r.respond({ status: 200, contentType: 'text/plain', body: '' });
                r.continue();
            });
            return p;
        };
        // Runs axe on one part of the page; returns the findings, worst first.
        const scan = async (page, name, include) => {
            if (!(await page.evaluate(() => !!window.axe))) await page.addScriptTag({ content: AXE });
            const res = await page.evaluate(async (sel) => {
                const r = await window.axe.run(sel ? { include: [sel] } : document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'] }, resultTypes: ['violations'] });
                return r.violations.map(v => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.slice(0, 4).map(n => n.target.join(' ') + ' :: ' + (n.failureSummary || '').split('\n').slice(1, 3).join(' ')) }));
            }, include || null);
            const bad = res.filter(v => v.impact === 'critical' || v.impact === 'serious');
            const info = res.filter(v => !bad.includes(v));
            if (info.length) console.log('  info (' + name + '): ' + info.map(v => v.impact + ' ' + v.id + ' [' + v.nodes.length + ']').join(', '));
            ok(bad.length === 0, 'accessibility: ' + name + ' - no critical / serious findings', JSON.stringify(bad, null, 1));
            return res;
        };
        const gotoHome = async (page, qs = '') => {
            await page.goto(`${BASE}/${qs}`, { waitUntil: 'domcontentloaded' });
            await page.waitForSelector('#upcomingEventsGrid .ev-card', { timeout: 20000 });
            await sleep(300);
            await page.evaluate(() => { const x = document.getElementById('cookieRejectAll'); if (x && x.offsetParent) x.click(); });
            await sleep(500);
        };
        const drawerOpen = (page) => page.$eval('#ticketDrawer', el => el.classList.contains('atl-drawer--open')).catch(() => false);

        // ═══ public ═══
        const pg = await newPage(390, 844, false);
        await gotoHome(pg);
        const cardSel = `#upcomingEventsGrid .live-event-card[data-payload*="%22event_id%22%3A${ev.id}%2C"]`;
        await pg.waitForSelector(cardSel + ' .ev-card__share', { timeout: 10000 });
        await pg.$eval(cardSel, el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
        await sleep(1200);                                                            // the cards' reveal animation (contrast is measured)
        await scan(pg, 'event card with price, View Event + Share', cardSel);
        await pg.$eval(cardSel + ' .ev-card__share', el => el.click());
        await pg.waitForSelector('.tm-share-menu', { visible: true, timeout: 5000 });
        await scan(pg, 'Share menu', '.tm-share-menu');
        await pg.keyboard.press('Escape');
        // View Event -> the details pop-up (scanned) -> its Get Tickets
        await pg.$eval(cardSel + ' .ev-card__view', el => el.click());
        await pg.waitForSelector('#modalEventTicketBtn', { visible: true, timeout: 10000 });
        await sleep(700);
        await scan(pg, 'event details pop-up', '#eventDetailsModal');
        await pg.$eval('#modalEventTicketBtn', el => el.click());
        await waitFor(() => drawerOpen(pg));
        await pg.waitForSelector('#ticketDrawer .tk-tier', { timeout: 10000 });
        await sleep(600);
        await scan(pg, 'Get Tickets drawer - choose tickets', '#ticketDrawer');
        await pg.$eval(`#ticketDrawer .tk-step[data-tier="${tier.id}"][data-d="1"]`, el => el.click());
        await pg.$eval('#ticketDrawer .tk-continue', el => el.click());
        await pg.waitForSelector('#ticketDrawer .tk-pay', { timeout: 10000 });
        await sleep(400);
        await scan(pg, 'Get Tickets drawer - your details', '#ticketDrawer');
        await pg.$eval('#ticketDrawer .tk-pay', el => el.click());                    // empty form: the error messages
        await sleep(400);
        await scan(pg, 'Get Tickets drawer - your details with field errors', '#ticketDrawer');
        await pg.close();

        const paid = await newPage(390, 844, false);
        await gotoHome(paid, `?tickets=${encodeURIComponent(P.reference)}`);
        await waitFor(() => drawerOpen(paid));
        await paid.waitForSelector('#ticketDrawer .tk-ticket', { timeout: 20000 });
        await sleep(600);
        await scan(paid, 'Get Tickets drawer - paid tickets with QR codes', '#ticketDrawer');
        await paid.close();

        const tp = await newPage(390, 844, false);
        await tp.goto(`${BASE}/t/${P.tickets[0].token}`, { waitUntil: 'networkidle0' });
        await scan(tp, '/t/<token> ticket page (public view)');
        await tp.close();

        // ═══ door ═══
        const door = await newPage(390, 844, false);
        await door.goto(passLink.replace(/^https?:\/\/[^/]+/, BASE), { waitUntil: 'networkidle0' });
        await door.waitForSelector('#ckManual:not([hidden])', { timeout: 10000 });
        await scan(door, '/checkin scanner (door link)');
        await door.type('#ckSearch', 'Ayanda');
        await door.click('#ckSearchForm .ck-btn');
        await door.waitForSelector('#ckFound [data-checkin]', { timeout: 10000 });
        await door.click('#ckFound [data-checkin]');
        await door.waitForSelector('#ckResult .ck-banner', { timeout: 10000 });
        await scan(door, '/checkin scanner - "Admitted" result');
        await door.close();

        // ═══ admin ═══
        const adm = await newPage(1440, 1000, true);
        await adm.goto(BASE + '/admin.html', { waitUntil: 'networkidle0', timeout: 90000 });
        await adm.waitForFunction(() => typeof window.switchTab === 'function' && !!window.currentUserRole && typeof window.openEvtEditDrawer === 'function', { timeout: 30000 });
        await adm.evaluate(() => window.switchTab('eventsAdmin'));
        await sleep(800);
        await adm.click('#eventsAdmin [data-um-tab="evtPanelTickets"]');
        await adm.waitForFunction((id) => !!document.querySelector(`#tktSalesEvent option[value="${id}"]`), { timeout: 15000 }, ev.id);
        await adm.select('#tktSalesEvent', String(ev.id));
        await adm.waitForFunction(() => document.querySelectorAll('#tktOrdersBody .tkt-order-row').length >= 1 && /A11y door/.test(document.getElementById('tktDoorPassList').innerText), { timeout: 15000 });
        await sleep(600);
        await scan(adm, 'admin Events -> Ticket Sales (figures, door links, orders)', '#evtPanelTickets');
        await adm.click('#tktOrdersBody .tkt-order-row');
        await adm.waitForSelector('#tktOrderDrawerBody .tkt-order', { timeout: 10000 });
        await sleep(600);
        await scan(adm, 'admin order drawer', '#tktOrderDrawer');
        await adm.evaluate(() => window.closeAtlDrawer('tktOrderDrawer'));
        await sleep(400);
        await adm.$eval('#eventsAdmin [data-um-tab="evtPanelUpcoming"]', el => el.click());
        await sleep(600);
        await adm.evaluate((id) => window.openEvtEditDrawer(id), ev.id);
        await adm.waitForSelector('#evt-tab-tickets', { visible: true, timeout: 10000 });
        await sleep(800);
        await adm.click('#evt-tab-tickets');
        await adm.waitForSelector('#tktEventMount .tkt-tier', { timeout: 10000 });
        await sleep(400);
        await scan(adm, 'admin event drawer - Tickets tab', '#tktEventMount');
        await adm.close();
    } catch (e) {
        fails++;
        console.log('FAIL unexpected error: ' + (e && e.stack || e));
    } finally {
        for (const m of made) await api('PUT', `/api/admin/events/${m.id}`, { event_title: m.title, event_datetime: m.when, event_status: 'cancelled', sync_to_gcal: false }).catch(() => {});
        if (browser) await browser.close().catch(() => {});
        await support.stop();
    }
    console.log(fails ? `\n${fails} check(s) FAILED` : '\nAll ticketing accessibility checks passed');
    process.exit(fails ? 1 : 0);
})();
