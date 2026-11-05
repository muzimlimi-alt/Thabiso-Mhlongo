// Event ticketing - the Manage Tickets drawer in a real browser (desktop 1440 px and a 390 px phone), on an isolated DB copy:
//   * the event card shows "x of y sold" and Manage tickets / Sales / Attendees;
//   * the drawer shows sales status, inventory, revenue, the category table and the category cards;
//   * +10 / Save places raises a category's places (server agrees); Pause asks first and then shows "Paused"; Resume;
//   * the Edit Event drawer asks before saving a date change on a show that has sold tickets (and Cancel saves nothing);
//   * on a phone the drawer is full width, nothing scrolls sideways, and Save places stays reachable.
// Not part of `npm test`: run with `npm run test:browser` (needs PUPPETEER_EXECUTABLE_PATH). Date offset 2065.
const support = require('../support');
const puppeteer = require('puppeteer');
const { generatePayFastItnSignature } = require('../../lib/payfast-signature');
const { BASE, sleep, api, pub, one, future } = support;
let fails = 0;
const ok = (c, n, detail) => { if (!c) fails++; console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '\n        -> ' + String(detail).slice(0, 1500))); };
const waitFor = async (fn, ms = 15000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(150); } return v; };

async function adminCookie() {
    const r = await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'test.runner@example.invalid', password: 'TestRunnerPass1!' }) });
    return r.headers.get('set-cookie').split(';')[0];
}
async function paidOrder(eventId, tierId, n) {
    const o = (await pub('POST', '/api/public/ticket-orders', { event_id: eventId, items: [{ ticket_type_id: tierId, quantity: n }] })).body.order;
    await pub('POST', `/api/public/ticket-orders/${o.reference}/checkout`, { buyer_name: 'Browser Buyer', buyer_email: `mng.${Date.now()}@example.invalid`, buyer_phone: '0821234567', popia_consent: true, terms_accepted: true });
    const row = await one('SELECT * FROM ticket_orders WHERE public_reference = ?', [o.reference]);
    const m = { m_payment_id: row.m_payment_id, pf_payment_id: `MNGB-${Date.now()}`, payment_status: 'COMPLETE', item_name: 'x', item_description: '', amount_gross: (row.total_cents / 100).toFixed(2), amount_fee: '-1.00', amount_net: '1.00',
        custom_str1: '', custom_str2: '', custom_str3: '', custom_str4: '', custom_str5: '', custom_int1: '', custom_int2: '', custom_int3: '', custom_int4: '', custom_int5: '', name_first: 'B', name_last: 'B', email_address: 'b@example.invalid', merchant_id: '10000100' };
    m.signature = generatePayFastItnSignature(m, null);
    await pub('POST', '/api/payment/webhook/payfast', m);
    await waitFor(async () => (await one('SELECT status FROM ticket_orders WHERE id = ?', [row.id])).status === 'paid');
}

(async () => {
    await support.start();
    let browser;
    const made = [];
    try {
        const when = `${future(2065)}T20:00`;
        const title = 'ZZ Manage Browser Show';
        const ev = (await api('POST', '/api/admin/events', { event_title: title, event_datetime: when, venue_name: 'Browser Hall', event_status: 'upcoming', sync_to_gcal: false })).body;
        made.push({ id: ev.id, title, when });
        const ga = (await api('POST', `/api/admin/events/${ev.id}/ticket-types`, { name: 'General', price: '150', capacity: 100, is_active: true })).body.tier;
        await api('POST', `/api/admin/events/${ev.id}/ticket-types`, { name: 'VIP', price: '500', capacity: 20, is_active: true });
        await paidOrder(ev.id, ga.id, 3);
        const cookie = await adminCookie();

        browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-quic'], executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined });
        const open = async (w, h) => {
            const ctx = await browser.createBrowserContext();
            const p = await ctx.newPage();
            p.errs = [];
            p.on('pageerror', e => p.errs.push(e.message));
            p.on('dialog', d => d.dismiss());
            await p.setViewport({ width: w, height: h });
            const [name, ...rest] = cookie.split('=');
            await p.setCookie({ name, value: rest.join('='), url: BASE });
            await p.setRequestInterception(true);
            p.on('request', r => {
                const u = r.url();
                if (/\/api\/admin\/maps-config/.test(u)) return r.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, key: '' }) });
                if (/placehold\.co|googletagmanager|google-analytics|payfast\.co\.za/.test(u)) return r.respond({ status: 200, contentType: 'text/plain', body: '' });
                r.continue();
            });
            await p.goto(BASE + '/admin.html', { waitUntil: 'networkidle0', timeout: 90000 });
            await p.waitForFunction(() => typeof window.switchTab === 'function' && !!window.currentUserRole && typeof window.tktOpenManage === 'function', { timeout: 30000 });
            await p.evaluate(() => window.switchTab('eventsAdmin'));
            return p;
        };
        const text = (p, sel) => p.$eval(sel, el => el.innerText).catch(() => '');
        // the app's own confirm dialog: answer it (yes / no)
        const answerConfirm = (p, yes) => waitFor(() => p.evaluate((y) => {
            const box = document.querySelector('.tm-modal-container');
            if (!box) return false;
            const msg = (box.querySelector('.tm-modal__body') || box).innerText;
            const b = y ? box.querySelector('#tm-modal-confirm') : box.querySelector('#tm-modal-cancel, .tm-modal__footer button:not(#tm-modal-confirm)');
            if (!b) return false;
            b.click(); return msg || 'asked';
        }, yes), 6000);

        // ═══ desktop ═══
        const d = await open(1440, 1000);
        const card = `.atl-event-card[data-id="${ev.id}"]`;
        await d.waitForSelector(card, { timeout: 15000 });
        await waitFor(() => d.$eval(`${card} .evt-tkt-line`, el => !el.hidden).catch(() => false));
        const cardText = await text(d, `${card} .evt-card-actions`);
        ok(/3\s*of 120 sold/.test(cardText) && /Manage tickets/.test(cardText) && /Sales/.test(cardText) && /Attendees/.test(cardText) && /View/.test(cardText),
            'event card: "3 of 120 sold" and View / Manage tickets / Sales / Attendees', cardText);

        await d.click(`${card} .evt-tkt-manage`);
        await d.waitForSelector('#tktManageDrawerBody .tkt-cap', { timeout: 15000 });
        await sleep(600);
        const body = await text(d, '#tktManageDrawerBody');
        ok(/Selling/i.test(body) && /Ticket inventory/i.test(body) && /Allocated/i.test(body) && /Revenue/i.test(body) && /Gross ticket sales/i.test(body) && /Net ticket revenue/i.test(body) && /Ticket categories/i.test(body),
            'drawer: sales status, inventory, revenue and categories', body.slice(0, 900));
        const table = await d.$$eval('#tktManageDrawerBody .tkt-table--cats tbody tr', rows => rows.map(r => r.innerText.replace(/\s+/g, ' ').trim()));
        ok(table.length === 2 && /General R 150[.,]00 100 3 0 97/.test(table[0]), 'category table: Category / Price / Allocated / Sold / Reserved / Available from the database', JSON.stringify(table));

        // +10, Save places
        const capSel = `#tktManageDrawerBody .tkt-cap[data-id="${ga.id}"]`;
        await d.click(`${capSel} .tkt-cap-step[data-step="10"]`);
        await d.click(`${capSel} .tkt-cap-save`);
        const raised = await waitFor(async () => (await one('SELECT capacity FROM ticket_types WHERE id = ?', [ga.id])).capacity === 110);
        await d.waitForSelector(`${capSel} .tkt-cap__input[value="110"]`, { timeout: 10000 }).catch(() => {});
        ok(raised, '+10 then Save places: General has 110 places in the database', String((await one('SELECT capacity FROM ticket_types WHERE id = ?', [ga.id])).capacity));

        // pause (asks first), then resume
        await d.click('#tktManageDrawerBody .tkt-sales-act[data-sales-action="pause"]');
        const asked = await answerConfirm(d, true);
        const paused = await waitFor(async () => /Paused/.test(await text(d, '#tktManageDrawerBody .tkt-panel')));
        ok(!!asked && paused && (await one('SELECT sales_control FROM ticket_event_sales WHERE event_id = ?', [ev.id])).sales_control === 'paused', 'Pause: asks first, then the drawer says Paused and the server agrees', asked);
        await d.click('#tktManageDrawerBody .tkt-sales-act[data-sales-action="resume"]');
        ok(!!(await waitFor(async () => /Selling/.test(await text(d, '#tktManageDrawerBody .tkt-panel')))), 'Resume: back to Selling', await text(d, '#tktManageDrawerBody .tkt-panel'));

        // Edit Event from the drawer: a date change on a show with sold tickets asks first; answering no saves nothing
        await d.click('#tktMgEditEvent');
        await d.waitForFunction(() => document.getElementById('evtDrawer').classList.contains('atl-drawer--open'), { timeout: 10000 });
        await sleep(800);
        await d.evaluate(() => { const v = document.getElementById('eventsVenue'); v.value = 'Another Hall'; v.dispatchEvent(new Event('input', { bubbles: true })); });
        await d.click('#eventsSubmitBtn');
        const editAsk = await answerConfirm(d, false);
        await sleep(800);
        ok(!!editAsk && (await one('SELECT venue_name FROM events WHERE event_id = ?', [ev.id])).venue_name === 'Browser Hall', 'Edit Event: changing the venue of a show with sold tickets asks first; "Cancel" leaves the event as it was', editAsk);
        await d.evaluate(() => window.cancelEventEdit && window.cancelEventEdit());
        ok(d.errs.length === 0, 'desktop: no script errors', d.errs.join(' | '));
        await d.close();

        // ═══ phone ═══
        const m = await open(390, 844);
        await m.waitForSelector(card, { timeout: 15000 });
        await m.evaluate((id) => window.tktOpenManage(id), ev.id);
        await m.waitForSelector('#tktManageDrawerBody .tkt-cap', { timeout: 15000 });
        await sleep(700);
        const geo = await m.evaluate(() => {
            const dr = document.getElementById('tktManageDrawer').getBoundingClientRect();
            const body = document.getElementById('tktManageDrawerBody');
            const save = document.querySelector('#tktManageDrawerBody .tkt-cap-save').getBoundingClientRect();
            return { left: Math.round(dr.left), width: Math.round(dr.width), vw: window.innerWidth, sideScroll: body.scrollWidth - body.clientWidth, saveRight: Math.round(save.right) };
        });
        ok(geo.left === 0 && geo.width === geo.vw && geo.sideScroll <= 1 && geo.saveRight <= geo.vw, 'phone: the drawer fills the screen, nothing scrolls sideways, Save places is fully on screen', JSON.stringify(geo));
        ok(m.errs.length === 0, 'phone: no script errors', m.errs.join(' | '));
        await m.close();
    } catch (e) {
        fails++;
        console.log('FAIL unexpected error: ' + (e && e.stack || e));
    } finally {
        for (const x of made) await api('PUT', `/api/admin/events/${x.id}`, { event_title: x.title, event_datetime: x.when, event_status: 'cancelled', sync_to_gcal: false }).catch(() => {});
        if (browser) await browser.close().catch(() => {});
        await support.stop();
    }
    console.log(fails ? `\n${fails} check(s) FAILED` : '\nAll Manage Tickets browser checks passed');
    process.exit(fails ? 1 : 0);
})();
