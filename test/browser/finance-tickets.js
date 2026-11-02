// Finance <- Event ticketing in the admin (js/admin/finance-tickets.js, css/admin/14-finance.css):
//   * the "where the money came from" strip shows client bookings, event tickets and other payments, with the ticket figure equal to what the
//     server says (net of refunds), and the total equal to the sum of its parts;
//   * the Ticket Sales tab shows gross / refunds / fees / net, the category table, the show table, the upcoming projection (labelled as
//     NOT revenue) and the reconciliation;
//   * a show opens to its orders, an order to its PayFast money trail (amount, fee, verified notification);
//   * nothing overflows sideways at desktop, tablet and phone widths and there are no page errors.
// Boots the real app on an isolated database copy (test/support.js). Not part of `npm test`: run with `npm run test:browser`.
const support = require('../support');
const puppeteer = require('puppeteer');
const { generatePayFastItnSignature } = require('../../lib/payfast-signature');
const { BASE, sleep, api, pub, future, one } = support;
let fails = 0;
const ok = (c, n, detail) => { if (!c) fails++; console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '\n        -> ' + String(detail).slice(0, 500))); };
const waitFor = async (fn, ms = 20000) => { const t = Date.now(); let v; while (Date.now() - t < ms) { v = await fn(); if (v) return v; await sleep(200); } return v; };
const num = (s) => { const t = String(s).replace(/[^\d,.-]/g, ''); return parseFloat(/,\d{2}$/.test(t) ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '')); };   // en-ZA writes R 1 234,50

(async () => {
    await support.start();
    let browser;
    try {
        await support.loginAs('administrator');
        const lr = await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'test.administrator@example.invalid', password: 'TestRunnerPass1!' }) });
        const raw = lr.headers.get('set-cookie');
        const stamp = Date.now(), when = `${future(2051)}T20:00`;
        const ev = (await api('POST', '/api/admin/events', { event_title: 'ZZ Finance UI Show', event_datetime: when, venue_name: 'Hall', event_status: 'upcoming', sync_to_gcal: false })).body;
        const gen = (await api('POST', `/api/admin/events/${ev.id}/ticket-types`, { name: 'Early Bird', price: '150', is_active: true, max_per_order: 6, capacity: 12 })).body.tier;
        const o = (await pub('POST', '/api/public/ticket-orders', { event_id: ev.id, items: [{ ticket_type_id: gen.id, quantity: 2 }] })).body.order;
        await pub('POST', `/api/public/ticket-orders/${o.reference}/checkout`, { buyer_name: 'UI Buyer', buyer_email: `fin.ui.${stamp}@example.invalid`, buyer_phone: '0821110000', popia_consent: true, terms_accepted: true });
        const row = await one('SELECT * FROM ticket_orders WHERE public_reference = ?', [o.reference]);
        const m = { m_payment_id: row.m_payment_id, pf_payment_id: `FINUI-${stamp}`, payment_status: 'COMPLETE', item_name: 'x', item_description: '', amount_gross: (row.total_cents / 100).toFixed(2), amount_fee: '-6.90', amount_net: '293.10', name_first: 'U', name_last: 'B', email_address: row.buyer_email, merchant_id: '10000100' };
        m.signature = generatePayFastItnSignature(m, null);
        await pub('POST', '/api/payment/webhook/payfast', m);
        await waitFor(async () => (await one('SELECT status FROM ticket_orders WHERE id = ?', [row.id])).status === 'paid');

        const today = new Date().toISOString().slice(0, 10);
        const srv = (await api('GET', `/api/admin/ticketing/finance?date_from=${today}&date_to=${today}`)).body;
        ok(srv.success && srv.totals.net_revenue >= 300, 'setup: a confirmed R300 ticket order with a PayFast fee exists', JSON.stringify(srv.totals));

        browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'], executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined });
        for (const [vp, w, h] of [['desktop', 1440, 1000], ['tablet', 820, 1100], ['phone', 390, 844]]) {
            const p = await (await browser.createBrowserContext()).newPage();
            await p.setViewport({ width: w, height: h });
            const errs = [];
            p.on('pageerror', e => errs.push(e.message.slice(0, 200)));
            const [name, ...rest] = String(raw).split(';')[0].split('=');
            await p.setCookie({ name, value: rest.join('='), url: BASE });
            await p.setRequestInterception(true);
            p.on('request', r => /\/api\/admin\/maps-config/.test(r.url()) ? r.respond({ status: 200, contentType: 'application/json', body: '{"success":true,"key":""}' }) : r.continue());
            await p.goto(BASE + '/admin.html', { waitUntil: 'domcontentloaded', timeout: 90000 });
            await sleep(3500);
            await p.evaluate(() => window.switchTab('financeAdmin'));
            await p.waitForFunction(() => document.querySelector('#ftsSources .fts-total'), { timeout: 25000 }).catch(() => {});
            await sleep(800);

            const strip = await p.evaluate(() => ({
                total: (document.querySelector('#ftsSources .fts-total') || {}).textContent, labels: [...document.querySelectorAll('#ftsSources .fts-src__top span')].map(x => x.textContent),
                values: [...document.querySelectorAll('#ftsSources .fts-src__v')].map(x => x.textContent)
            }));
            ok(strip.total && /Client bookings/.test(strip.labels.join()) && /Event tickets/.test(strip.labels.join()) && /Other/.test(strip.labels.join()), `${vp}: the strip shows client bookings, event tickets and other payments`, JSON.stringify(strip));
            if (vp === 'desktop' && strip.values.length >= 3) {
                const parts = strip.values.slice(0, 3).map(num);
                ok(Math.abs(parts.reduce((a, b) => a + b, 0) - num(strip.total)) < 0.02, 'desktop: the total is the sum of the three sources', JSON.stringify(strip));
                const tk = num(strip.values[1]);
                const fresh = (await api('GET', `/api/admin/ticketing/finance?date_from=${new Date().toISOString().slice(0, 8)}01&date_to=${today}`)).body;
                ok(Math.abs(tk - fresh.totals.net_revenue) < 0.02, "desktop: the ticket figure is the server's net ticket revenue (no second calculation)", `${tk} vs ${fresh.totals.net_revenue}`);
            }

            if (process.env.FIN_SHOTS) { const el = await p.$('#ftsSources'); if (el) { await el.evaluate(x => x.scrollIntoView({ block: 'start' })); await sleep(300); await p.screenshot({ path: process.env.FIN_SHOTS + '/strip-' + vp + '.png' }); } }
            await p.evaluate(() => document.querySelector('#finTabBar .atl-tab-btn[data-um-tab="finTickets"]').click());
            await p.waitForFunction(() => document.querySelector('#finTickets .fin-card'), { timeout: 15000 }).catch(() => {});
            await sleep(1200);
            const tab = await p.evaluate(() => {
                const t = document.getElementById('finTickets');
                return { labels: [...t.querySelectorAll('.fin-card__label')].map(x => x.textContent), text: t.innerText, rows: t.querySelectorAll('.fts-ev').length, charts: t.querySelectorAll('.apexcharts-canvas').length, proj: !!t.querySelector('.fts-proj .atl-badge') && /not revenue/i.test(t.querySelector('.fts-proj').innerText) };
            });
            const want = ['Gross ticket sales', 'Refunds issued', 'Refunds outstanding', 'Net ticket revenue', 'PayFast fees', 'Net receipts', 'Tickets sold', 'Successful payments'];
            ok(want.every(l => tab.labels.includes(l)), `${vp}: the Ticket Sales tab carries every money indicator`, tab.labels.join(' | '));
            ok(/Early Bird/.test(tab.text) && /ZZ Finance UI Show/.test(tab.text), `${vp}: revenue by ticket category and by show are listed`, tab.text.slice(0, 300));
            ok(tab.proj, `${vp}: upcoming shows are labelled "Projection - not revenue"`, '');
            ok(/Not revenue/i.test(tab.text) && /Reconciliation/.test(tab.text), `${vp}: pending / failed / abandoned and the reconciliation are shown`, '');
            if (vp === 'desktop') ok(tab.charts >= 1, 'desktop: the charts draw', tab.charts);

            // drill down: show -> orders -> money trail
            const evRow = await p.evaluateHandle(() => [...document.querySelectorAll('#finTickets .fts-ev')].find(r => /ZZ Finance UI Show/.test(r.textContent)));
            if (evRow.asElement()) {
                await evRow.asElement().evaluate(el => el.scrollIntoView({ block: 'center' }));
                await evRow.asElement().click(); await sleep(1200);
                const ordRow = await p.$('#finTickets .fts-drill:not([hidden]) .fts-ord');
                ok(!!ordRow, `${vp}: selecting a show lists its orders`, '');
                if (ordRow) {
                    await ordRow.click(); await sleep(1200);
                    const trail = await p.evaluate(() => (document.querySelector('#finTickets .fts-trail:not([hidden])') || {}).innerText || '');
                    ok(/gross received/i.test(trail) && /R\s*300[.,]00/.test(trail) && /R\s*6[.,]90/.test(trail) && /verified/.test(trail) && /FINUI-/.test(trail), `${vp}: an order opens its PayFast money trail (gross, fee, verified notification)`, trail);
                }
            } else ok(false, `${vp}: the show is in the by-show table`, '');

            const overflow = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
            ok(overflow <= 1, `${vp}: no sideways scrolling`, overflow);
            if (process.env.FIN_SHOTS) { await p.evaluate(() => window.scrollTo(0, 0)); await p.screenshot({ path: `${process.env.FIN_SHOTS}/fin-${vp}.png`, fullPage: true }); }
            ok(errs.length === 0, `${vp}: no page errors`, errs.join(' | '));
            await p.close();
        }
        await api('PUT', `/api/admin/events/${ev.id}`, { event_title: 'ZZ Finance UI Show', event_datetime: when, event_status: 'cancelled', sync_to_gcal: false }).catch(() => {});
    } finally {
        if (browser) await browser.close();
        await support.stop();
    }
    console.log(fails ? `\n${fails} finance-tickets check(s) FAILED` : '\nAll finance ticket browser checks passed');
    process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
