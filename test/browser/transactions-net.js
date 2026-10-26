// The admin Transactions tab ends with "Showing N transaction(s) · Net: R x". Net is money RECEIVED: payments less refunds. A manual
// adjustment (credit / debit) changes what a client OWES, it is not money received - it was summed as if it were a payment. Driven through
// the REAL admin page in headless Chrome on an isolated DB copy (test/support.js - the real database is never touched).
// Not part of `npm test`: run it with `npm run test:browser` (needs PUPPETEER_EXECUTABLE_PATH on this machine, see test-suite notes).
const support = require('../support');
const puppeteer = require('puppeteer');
const { BASE } = support;
let fails = 0;
const ok = (c, n, detail) => { if (!c) fails++; console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '\n        -> ' + detail)); };
const ADMIN = { email: 'test.runner@example.invalid', password: 'TestRunnerPass1!' };

async function adminCookie() {
    const r = await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ADMIN) });
    const sc = r.headers.get('set-cookie');
    if (r.status !== 200 || !sc) throw new Error('admin login failed: ' + r.status);
    return sc.split(';')[0];
}

(async () => {
    await support.start();
    let browser;
    try {
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
        await p.waitForFunction(() => typeof window.filterTransactions === 'function' && typeof renderTransactions === 'function', { timeout: 30000 });

        const tx = (type, amount) => ({ transaction_type: type, amount, status: 'completed', transaction_date: '2026-10-01', reference: 'T-' + type, booking_id: 1, client_name: 'Net Test', payment_method: 'eft' });
        const footer = (list) => p.evaluate((list) => { renderTransactions(list); return document.getElementById('txGrandTotal').textContent.replace(/\s+/g, ' ').trim(); }, list);
        const net = (s) => (s.match(/Net: R\s?([\d\s ,.]+)/) || [])[1];
        const norm = (s) => String(s || '').replace(/[\s ]/g, '').replace(',', '.');

        let s = await footer([tx('payment', 1000), tx('adjustment', 500), tx('adjustment', 300), tx('refund', 200)]);
        ok(/Showing 4 transaction/.test(s) && norm(net(s)) === '800.00', 'Net = R1,000 paid - R200 refunded = R800.00; a R500 credit and a R300 debit adjustment add nothing (it read R1,600.00)', s);
        s = await footer([tx('payment', 1000), tx('refund', 200)]);
        ok(norm(net(s)) === '800.00', 'payments less refunds still gives R800.00 without any adjustment', s);
        s = await footer([tx('payment', 1500), tx('payment', 500)]);
        ok(norm(net(s)) === '2000.00', 'two payments add up to R2,000.00', s);
        s = await footer([tx('adjustment', 750)]);
        ok(/Showing 1 transaction/.test(s) && norm(net(s)) === '0.00', 'a list holding only an adjustment nets to R0.00 - the row is still listed, it just is not money', s);
        ok(errs.length === 0, 'no page errors', errs.join(' | '));
    } catch (e) {
        fails++;
        console.log('FAIL browser test crashed: ' + e.message.slice(0, 300));
    } finally {
        if (browser) await browser.close();
        await support.stop();
    }
    console.log(fails ? `\n${fails} check(s) FAILED` : '\nAll checks passed');
    process.exit(fails ? 1 : 0);
})();
