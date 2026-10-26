// A booking's Profit & Loss card (Deal View > Financial Controls): a refund leaves the account, so it comes OFF the net. The card shows the agreed
// amount as Revenue, a "Refunded" row ONLY when something was refunded, and Net Profit = Revenue - Refunded - Expenses. Driven through the REAL
// admin page in headless Chrome on an isolated DB copy (test/support.js - the real database is never touched). The refund itself is made through
// the real admin API. Not part of `npm test`: run it with `npm run test:browser` (needs PUPPETEER_EXECUTABLE_PATH on this machine).
const support = require('../support');
const puppeteer = require('puppeteer');
const { BASE, sleep, api, pub, one, future, getTrackingToken } = support;
let fails = 0;
const ok = (c, n, detail) => { if (!c) fails++; console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '\n        -> ' + detail)); };
const ADMIN = { email: 'test.runner@example.invalid', password: 'TestRunnerPass1!' };

async function adminCookie() {
    const r = await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ADMIN) });
    const sc = r.headers.get('set-cookie');
    if (r.status !== 200 || !sc) throw new Error('admin login failed: ' + r.status);
    return sc.split(';')[0];
}

// An accepted R120,000 booking with `paid` received and `refund` paid back (0 = none).
async function booking(tag, days, paid, refund) {
    const service = await one("SELECT id FROM services WHERE name = 'Writing – Head Writer (per month)'");
    const email = `refund.pl.${tag}.${Date.now()}@example.invalid`;
    const created = await api('POST', '/api/admin/bookings', { name: `ZZ Refund PL ${tag}`, email, cell: '+27821234567', event_date: future(days), event_name: 'Refund P&L test', event_type: 'Corporate Event',
        event_location: 'Test Hall', message: 'Refund P&L browser test, over ten characters.', services: [{ service_id: service.id }], status: 'NEW', override_working_hours: true });
    const id = created.body.booking_id;
    const bk = await one('SELECT date FROM bookings WHERE id = ?', [id]);
    const expiry = new Date(Date.parse(bk.date) - 10 * 86400000).toISOString().slice(0, 10);
    await api('POST', `/api/admin/bookings/${id}/quote`, { quote_expiry_date: expiry, terms: 'Standard terms apply.', apply_vat: false, discount: 0, items: [{ service_id: service.id, description: 'Head writer - one month', quantity: 1, unit_price: 120000 }] });
    await pub('POST', `/api/public/bookings/${id}/accept-quote`, { access_token: await getTrackingToken(id, email), terms_agreed: true });
    await api('PUT', `/api/admin/bookings/${id}/manual-payment`, { amount_paid: paid });
    await sleep(1200);
    if (refund) { await api('POST', '/api/admin/transactions/manual', { booking_id: id, amount: refund, transaction_type: 'refund', payment_method: 'eft', reference: `ZZ-PLR-${tag}` }); await sleep(800); }
    return id;
}

(async () => {
    await support.start();
    let browser;
    try {
        const refunded = await booking('a', 1660, 100000, 20000);
        const plain = await booking('b', 1661, 50000, 0);
        browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-quic'], executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined });
        const cookie = await adminCookie();
        const ctx = await browser.createBrowserContext();
        const p = await ctx.newPage();
        await p.setViewport({ width: 1440, height: 1000 });
        const errs = [];
        p.on('pageerror', e => errs.push(e.message.slice(0, 200)));
        const [name, ...rest] = cookie.split('=');
        await p.setCookie({ name, value: rest.join('='), url: BASE });
        await p.setRequestInterception(true);
        p.on('request', r => {
            if (/\/api\/admin\/maps-config/.test(r.url())) return r.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, key: '' }) });
            r.continue();
        });
        await p.goto(BASE + '/admin.html', { waitUntil: 'networkidle0', timeout: 90000 });
        await p.waitForFunction(() => typeof window.closeAtlDrawer === 'function' && typeof $ === 'function', { timeout: 30000 });

        const plCard = async (id) => {
            await p.evaluate((id) => { const b = document.createElement('button'); b.className = 'bk-action-financials'; b.setAttribute('data-id', id); document.body.appendChild(b); b.click(); b.remove(); }, id);
            await p.waitForFunction(() => /Net Profit/.test((document.getElementById('bf-pl-card') || {}).textContent || ''), { timeout: 20000 });
            const text = await p.evaluate(() => document.getElementById('bf-pl-card').textContent.replace(/\s+/g, ' ').trim());
            await p.evaluate(() => window.closeAtlDrawer && window.closeAtlDrawer('bookingFinancialsDrawer'));
            await sleep(300);
            return text;
        };
        const money = (text, label) => { const m = new RegExp(label + '\\s*(-\\s*)?R\\s*([\\d.,\\s]+)').exec(text); return m ? (m[1] ? '-' : '') + m[2].replace(/[\s,]/g, '') : null; };

        let t = await plCard(refunded);
        ok(money(t, 'Revenue') === '120000.00', 'a refunded booking: Revenue is the agreed R120,000.00', t);
        ok(money(t, 'Refunded') === '-20000.00', 'a refunded booking: a "Refunded" row shows - R 20000.00', t);
        ok(money(t, 'Net Profit') === '100000.00', 'a refunded booking: Net Profit is R100,000.00 (the refund comes off)', t);
        t = await plCard(plain);
        ok(!/Refunded/.test(t), 'a booking with nothing refunded shows no "Refunded" row', t);
        ok(money(t, 'Revenue') === '120000.00' && money(t, 'Net Profit') === '120000.00', 'ordinary booking: Net Profit equals Revenue (no expenses)', t);
        ok(errs.length === 0, 'no page errors', errs.join(' | '));
    } catch (e) {
        fails++;
        console.log('FAIL browser test crashed: ' + e.message.slice(0, 300));
    } finally {
        if (browser) await browser.close();
        await support.stop();
    }
    console.log(fails ? `\n${fails} FAILED` : '\nAll checks passed');
    process.exit(fails ? 1 : 0);
})();
