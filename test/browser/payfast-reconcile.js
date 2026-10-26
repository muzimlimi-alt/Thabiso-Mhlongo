// The PayFast safety net through the REAL pages in headless Chrome on an isolated DB copy (test/support.js - the real database is never touched), with PayFast's
// merchant API played by test/fake-payfast-api.js:
//   the buyer who returns from PayFast to their booking page (index.html ?payment=success) - the page asks the server to confirm with PayFast and says so,
//   and the administrator's panel at the top of Finance -> Reconciliation (status, preview, "Check PayFast now", the findings and resolving one).
// The behaviour that matters (only an exact match is recorded, never twice, nothing is credited on a failure) is proven against the API in
// test/payfast-reconcile.test.js; this file proves the pages actually do it, say the right things and fit a phone.
// Not part of `npm test`: run it with `npm run test:browser` (needs PUPPETEER_EXECUTABLE_PATH on this machine).
const support = require('../support');
const puppeteer = require('puppeteer');
const { createFakePayFastApi, row, sastNow } = require('../fake-payfast-api');
const sqlite3 = require('sqlite3');
const { BASE, sleep, api, pub, one, q, future, getTrackingToken, TEST_DB } = support;
let fails = 0;
const ok = (c, n, detail) => { if (!c) fails++; console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '\n        -> ' + String(detail).slice(0, 400))); };
const ADMIN = { email: 'test.runner@example.invalid', password: 'TestRunnerPass1!' };
const write = (sql, params = []) => new Promise((resolve, reject) => {
    const d = new sqlite3.Database(TEST_DB);
    d.configure('busyTimeout', 8000);
    d.run(sql, params, function (e) { d.close(() => (e ? reject(e) : resolve(this))); });
});

async function adminCookie() {
    const r = await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ADMIN) });
    const sc = r.headers.get('set-cookie');
    if (r.status !== 200 || !sc) throw new Error('admin login failed: ' + r.status);
    return sc.split(';')[0];
}

let seq = 0, pf = 8000000 + Math.floor(Math.random() * 100000);
async function bookingWithPendingPayment(tag, days) {
    const service = await one("SELECT id FROM services WHERE name = 'Club – 10 min Set (Guest Spot)'");
    const email = `pfrec.ui.${tag}.${Date.now()}.${seq++}@example.invalid`;
    const created = await api('POST', '/api/admin/bookings', { name: `ZZ PFREC UI ${tag}`, email, cell: '+27821234567', event_date: future(days), event_name: `PFREC UI ${tag}`, event_type: 'Corporate Event',
        event_location: 'Test Hall', message: 'PayFast safety net browser test, over ten characters.', services: [{ service_id: service.id }], status: 'NEW', override_working_hours: true, override_conflict: true });   // calendar availability is not what this file tests
    const id = created.body && created.body.booking_id;
    if (!id) throw new Error(`could not create booking ${tag}: ${created.status} ${JSON.stringify(created.body)}`);
    const bk = await one('SELECT date FROM bookings WHERE id = ?', [id]);
    if (!bk) throw new Error(`booking ${tag} (#${id}) is not in the database after creating it: ${created.status} ${JSON.stringify(created.body)} / max id ${JSON.stringify(await one('SELECT MAX(id) m, COUNT(*) c FROM bookings'))}`);
    const expiry = new Date(Date.parse(bk.date) - 10 * 86400000).toISOString().slice(0, 10);
    await api('POST', `/api/admin/bookings/${id}/quote`, { quote_expiry_date: expiry, terms: 'Standard terms apply.', apply_vat: false, discount: 0, items: [{ service_id: service.id, description: 'Club set', quantity: 1, unit_price: 5000, pricing_model: 'flat_fee' }] });
    const token = await getTrackingToken(id, email);
    await pub('POST', `/api/public/bookings/${id}/accept-quote`, { access_token: token, terms_agreed: true });
    for (let i = 0; i < 60 && !(await one('SELECT id FROM invoices WHERE booking_id = ?', [id])); i++) await sleep(150);
    await write("UPDATE payment_schedules SET due_date = '2099-01-01' WHERE booking_id = ?", [id]);       // keep the reminder jobs away from it
    const sched = (await q('SELECT id FROM payment_schedules WHERE booking_id = ? ORDER BY sequence, due_date, id', [id]))[0];
    await pub('POST', `/api/public/bookings/${id}/pay`, { access_token: token, schedule_id: sched.id });
    let intent; for (let i = 0; i < 60 && !intent; i++) { intent = await one('SELECT * FROM payfast_payment_intents WHERE booking_id = ?', [id]); if (!intent) await sleep(150); }
    return { id, email, token, intent };
}
const payfastRow = (b, over = {}) => row({ date: sastNow(5), grossCents: Math.round(b.intent.expected_amount * 100), mPaymentId: b.intent.m_payment_id, pfPaymentId: String(++pf), name: `Booking ${b.id} - test`, ...over });
const ageIntent = (b) => write("UPDATE payfast_payment_intents SET created_at = datetime('now', '-3 minutes') WHERE id = ?", [b.intent.id]);
const txCount = async (id) => (await q("SELECT id FROM transactions WHERE booking_id = ? AND source = 'payfast'", [id])).length;

(async () => {
    await support.start();
    const fake = createFakePayFastApi({ port: 3198, merchantId: '10000100', passphrase: '' });
    await fake.start();
    let browser;
    try {
        browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-quic'], executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined });

        // ═══ the buyer comes back from PayFast ═══
        const openReturn = async (b, query, w = 1280) => {
            const ctx = await browser.createBrowserContext();
            const p = await ctx.newPage();
            await p.setViewport({ width: w, height: 1000, isMobile: w < 500, hasTouch: w < 500 });
            p._errs = [];
            p.on('pageerror', e => p._errs.push(e.message.slice(0, 200)));
            // the page waits 35 s and 90 s between its looks at PayFast; a hundredth of that keeps the test short (the server still throttles per booking)
            await p.evaluateOnNewDocument(() => { const st = window.setTimeout; window.setTimeout = (f, ms, ...a) => st(f, ms >= 30000 ? ms / 100 : ms, ...a); });
            await p.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
            await p.evaluate((id, token, email) => {
                sessionStorage.setItem('trkToken_' + id, JSON.stringify({ token, expires_at: Date.now() + 3600000 }));
                localStorage.setItem('trkEmailCache', email);
            }, String(b.id), b.token, b.email);
            await p.goto(BASE + `/?track=${b.id}${query}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
            await p.waitForFunction(() => window.openAtlDrawer && document.getElementById('trackBtn'), { timeout: 20000 });
            await p.evaluate(() => { const x = document.getElementById('cookieRejectAll'); if (x && x.offsetParent) x.click(); });
            return p;
        };
        const alertText = (p) => p.evaluate(() => { const a = document.querySelector('.trk-return-alert'); return a ? a.innerText.replace(/\s+/g, ' ').trim() : ''; });

        // 1. the notification was lost: the page confirms with PayFast and the booking shows the payment
        const A = await bookingWithPendingPayment('a', 1830);
        await ageIntent(A);
        fake.reset(); fake.addRow(payfastRow(A));
        const pa = await openReturn(A, '&payment=success');
        await pa.waitForFunction(() => document.querySelector('.trk-return-alert'), { timeout: 20000 });
        const first = await alertText(pa);
        ok(/Payment submitted|confirming it with PayFast/i.test(first), 'returning from PayFast shows the "payment submitted" message straight away', first);
        await pa.waitForFunction(() => /Payment received/i.test((document.querySelector('.trk-return-alert') || {}).innerText || ''), { timeout: 30000 });
        ok(await alertText(pa) === 'Payment received. Thank you! Your booking has been updated.', 'then the page confirms the payment with PayFast and says it was received', await alertText(pa));
        ok((await pa.evaluate(() => document.querySelectorAll('.trk-return-alert').length)) === 1, 'exactly one message is shown (a reload of the details never stacks a second one)', await pa.evaluate(() => document.querySelectorAll('.trk-return-alert').length));
        const bkA = await one('SELECT amount_paid, amount_outstanding, payment_status, status FROM bookings WHERE id = ?', [A.id]);
        ok(bkA.amount_paid === 2500 && bkA.payment_status === 'DEPOSIT_PAID' && bkA.status === 'CONFIRMED' && (await txCount(A.id)) === 1, 'the booking holds exactly one R2,500.00 payment, DEPOSIT_PAID, CONFIRMED', JSON.stringify(bkA));
        ok(await pa.evaluate(() => /DEPOSIT/i.test(document.getElementById('tdPaymentStatus').textContent)), 'and the booking page itself now shows the deposit as paid', await pa.evaluate(() => document.getElementById('tdPaymentStatus').textContent));
        ok(fake.state.calls.length === 1 && fake.state.calls[0].sigOk, 'PayFast was asked once, correctly signed', JSON.stringify(fake.state.calls.length));
        ok(!(await pa.evaluate(() => location.search.includes('payment='))), 'the ?payment= parameter is removed from the address bar', await pa.evaluate(() => location.search));
        ok(pa._errs.length === 0, 'no page errors on the booking page', pa._errs.join(' | '));
        await pa.close();

        // 2. PayFast has not reported anything: the page keeps asking a couple of times, then settles on the neutral message and credits nothing
        const B = await bookingWithPendingPayment('b', 1831);
        await ageIntent(B);
        fake.reset();
        const pb = await openReturn(B, '&payment=success');
        await pb.waitForFunction(() => /It may take a moment/i.test((document.querySelector('.trk-return-alert') || {}).innerText || ''), { timeout: 30000 });
        ok(/Refresh to see the latest status/i.test(await alertText(pb)) && (await txCount(B.id)) === 0 && (await one('SELECT amount_paid FROM bookings WHERE id = ?', [B.id])).amount_paid === 0, 'when PayFast reports nothing the page says it may take a moment, and nothing is credited', await alertText(pb));
        ok(fake.state.calls.length >= 1 && fake.state.calls.length <= 3, 'it asked PayFast only a few times (the server throttles a booking to one look per 30 seconds)', String(fake.state.calls.length));
        await pb.close();

        // 3. the buyer cancelled at PayFast: no question is put to PayFast at all
        const C = await bookingWithPendingPayment('c', 1832);
        await ageIntent(C);
        fake.reset();
        const pc = await openReturn(C, '&payment=cancel');
        await pc.waitForFunction(() => document.querySelector('.trk-return-alert.cancel'), { timeout: 20000 });
        await sleep(600);
        ok(/cancelled/i.test(await alertText(pc)) && fake.state.calls.length === 0, 'a cancelled payment shows the cancelled message and PayFast is not asked anything', `${await alertText(pc)} calls=${fake.state.calls.length}`);
        await pc.close();

        // 4. phone width: the message fits, nothing scrolls sideways
        const D = await bookingWithPendingPayment('d', 1833);
        await ageIntent(D);
        fake.reset(); fake.addRow(payfastRow(D));
        const pd = await openReturn(D, '&payment=success', 390);
        await pd.waitForFunction(() => /Payment received/i.test((document.querySelector('.trk-return-alert') || {}).innerText || ''), { timeout: 30000 });
        ok(await pd.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'on a phone the booking page does not scroll sideways', await pd.evaluate(() => document.documentElement.scrollWidth + ' > ' + window.innerWidth));
        await pd.close();

        // ═══ the administrator ═══
        // booking E: PayFast shows a different amount (a finding); booking F: a match that has not been recorded yet
        const E = await bookingWithPendingPayment('e', 1834);
        const F = await bookingWithPendingPayment('f', 1835);
        fake.reset();
        const rowE = fake.addRow(payfastRow(E, { grossCents: 240000 }));
        const rowF = fake.addRow(payfastRow(F));
        const seed = await api('POST', '/api/admin/payfast/reconcile/run', { booking_id: E.id });
        ok(seed.status === 200 && seed.body.findings.length === 1, 'setup: a payment that does not match is on the record as a finding', JSON.stringify(seed.body));

        const cookie = await adminCookie();
        const ctx = await browser.createBrowserContext();
        const p = await ctx.newPage();
        await p.setViewport({ width: 1440, height: 1000 });
        const errs = [];
        p.on('pageerror', e => errs.push(e.message.slice(0, 200)));
        const [cname, ...crest] = cookie.split('=');
        await p.setCookie({ name: cname, value: crest.join('='), url: BASE });
        await p.setRequestInterception(true);
        p.on('request', r => {
            if (/\/api\/admin\/maps-config/.test(r.url())) return r.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, key: '' }) });
            r.continue();
        });
        await p.goto(BASE + '/admin.html', { waitUntil: 'networkidle0', timeout: 90000 });
        await p.waitForFunction(() => typeof window.closeAtlDrawer === 'function' && typeof $ === 'function' && window.payfastReconcile, { timeout: 30000 });
        await p.evaluate(() => $('a[href="#financeAdmin"]').first().tab('show'));
        await sleep(600);
        await p.evaluate(() => $('#finTabBar .atl-tab-btn[data-um-tab="finReconciliation"]').click());
        await p.waitForFunction(() => document.querySelectorAll('#pfsFindings tbody tr').length >= 1, { timeout: 20000 });

        const status = await p.evaluate(() => document.getElementById('pfsStatus').innerText.replace(/\s+/g, ' '));
        ok(await p.evaluate(() => document.getElementById('pfsMode').textContent === 'Sandbox'), 'the panel says the site is on PayFast\'s Sandbox', await p.evaluate(() => document.getElementById('pfsMode').textContent));
        ok(/Last checked/.test(status) && /Payments waiting to be confirmed: \d+/.test(status) && /Needing attention: [1-9]/.test(status), 'it shows when PayFast was last checked, how many payments are waiting and how many need attention', status);
        const table = await p.evaluate(() => document.getElementById('pfsFindings').innerText.replace(/\s+/g, ' '));
        ok(new RegExp(`#${E.id}`).test(table) && /Does not match/.test(table) && /R\s?2\s?400/.test(table) && /R\s?2\s?500/.test(table) && table.includes(rowE.pfPaymentId), 'the finding is listed with the booking, the PayFast payment id, the amount and what was expected', table);
        ok(await p.evaluate(() => document.getElementById('pfSafetyPanel').offsetParent !== null && document.getElementById('pfsRunBtn').offsetParent !== null && !document.getElementById('pfsRunBtn').disabled), 'the "Check PayFast now" button is there and enabled', '');

        // preview: says what would happen, changes nothing
        await p.evaluate(() => document.getElementById('pfsDryBtn').click());
        await p.waitForFunction(() => /Preview:/.test(document.getElementById('pfsResult').innerText), { timeout: 20000 });
        const prev = await p.evaluate(() => document.getElementById('pfsResult').innerText.replace(/\s+/g, ' '));
        ok(new RegExp(`Would record R\\s?2\\s?500[.,]00 on booking #${F.id}`).test(prev) && (await txCount(F.id)) === 0 && (await one('SELECT amount_paid FROM bookings WHERE id = ?', [F.id])).amount_paid === 0, 'Preview says it WOULD record R2,500.00 on that booking and changes nothing', prev);

        // a PayFast outage: the page says so plainly and nothing is recorded
        fake.setMode('auth');
        await p.evaluate(() => document.getElementById('pfsRunBtn').click());
        await p.waitForFunction(() => document.querySelector('#pfsResult.is-bad'), { timeout: 20000 });
        const bad = await p.evaluate(() => document.getElementById('pfsResult').innerText.replace(/\s+/g, ' '));
        ok(/merchant id and passphrase/i.test(bad) && (await txCount(F.id)) === 0, 'when PayFast refuses the credentials the panel says so, and nothing is recorded', bad);
        await p.waitForFunction(() => /PayFast could not be read \(AUTH\)/.test(document.getElementById('pfsStatus').innerText), { timeout: 15000 });
        ok(/failed 1 time/.test(await p.evaluate(() => document.getElementById('pfsStatus').innerText)), 'the status line now shows the failure, how often and when it will try again', await p.evaluate(() => document.getElementById('pfsStatus').innerText));
        fake.setMode('ok');

        // check now: records the matching payment
        await p.evaluate(() => document.getElementById('pfsRunBtn').click());
        await p.waitForFunction(() => /Recorded R/.test(document.getElementById('pfsResult').innerText), { timeout: 20000 });
        const done = await p.evaluate(() => document.getElementById('pfsResult').innerText.replace(/\s+/g, ' '));
        ok(new RegExp(`Recorded R\\s?2\\s?500[.,]00 on booking #${F.id}`).test(done) && (await txCount(F.id)) === 1 && (await one('SELECT amount_paid FROM bookings WHERE id = ?', [F.id])).amount_paid === 2500, '"Check PayFast now" records the matching payment, once', done);
        ok(await p.evaluate(() => [...document.querySelectorAll('.tm-toast')].some(t => /payment\(s\) recorded/i.test(t.textContent))), 'with a toast (not a browser alert)', '');
        await p.waitForFunction(() => !/PayFast could not be read/.test(document.getElementById('pfsStatus').innerText), { timeout: 15000 });
        ok(!/PayFast could not be read/.test(await p.evaluate(() => document.getElementById('pfsStatus').innerText)), 'and the failure message is gone from the status line now that PayFast answered', '');
        ok(await p.evaluate((pfid) => { const r = [...document.querySelectorAll('#pfsFindings tbody tr')].find(x => x.textContent.includes(pfid)); return !!r && /Recovered automatically/.test(r.innerText) && !r.querySelector('.pfs-resolve-open'); }, rowF.pfPaymentId),
            'the recovered payment is listed as "Recovered automatically" (a record, nothing for anyone to do)', await p.evaluate(() => document.getElementById('pfsFindings').innerText.replace(/\s+/g, ' ')));

        // resolve the finding
        await p.evaluate((id) => { [...document.querySelectorAll('#pfsFindings tbody tr')].find(r => r.textContent.includes('#' + id) && /Does not match/.test(r.textContent)).querySelector('.pfs-resolve-open').click(); }, E.id);
        await p.waitForSelector('.pfs-note', { timeout: 5000 });
        await p.evaluate(() => document.querySelector('.pfs-resolve-save').click());
        await sleep(500);
        ok((await one('SELECT status FROM payfast_reconcile_findings WHERE pf_payment_id = ?', [rowE.pfPaymentId])).status === 'open' && await p.evaluate(() => [...document.querySelectorAll('.tm-toast')].some(t => /few words/i.test(t.textContent))), 'saving without a note is refused in the page with a toast, and nothing changes', '');
        await p.type('.pfs-note', 'Client paid R2,400 by mistake; refunded by hand.');
        await p.evaluate(() => document.querySelector('.pfs-resolve-save').click());
        await p.waitForFunction((id) => { const r = [...document.querySelectorAll('#pfsFindings tbody tr')].find(x => x.textContent.includes('#' + id) && /Does not match/.test(x.textContent)); return r && /Dealt with/.test(r.innerText) && !r.querySelector('.pfs-resolve-open'); }, { timeout: 15000 }, E.id);
        const fe = await one('SELECT status, resolution_note, resolved_by FROM payfast_reconcile_findings WHERE pf_payment_id = ?', [rowE.pfPaymentId]);
        ok(fe.status === 'resolved' && /refunded by hand/.test(fe.resolution_note) && fe.resolved_by, 'with a note the finding is marked dealt with, recording who and why', JSON.stringify(fe));
        ok((await txCount(E.id)) === 0, 'and resolving a finding never credits the booking', '');

        // phone width: the panel fits
        await p.setViewport({ width: 390, height: 900, isMobile: true, hasTouch: true });
        await sleep(400);
        const fit = await p.evaluate(() => { const el = document.getElementById('pfSafetyPanel'); const r = el.getBoundingClientRect(); return { right: Math.round(r.right), vw: window.innerWidth, over: [...el.querySelectorAll('*')].filter(n => n.getBoundingClientRect().right > window.innerWidth + 1 && !n.closest('.table-responsive')).length }; });
        ok(fit.right <= fit.vw + 1 && fit.over === 0, 'on a phone the panel stays inside the screen (the table scrolls inside its own box)', JSON.stringify(fit));
        ok(errs.length === 0, 'no page errors on the admin page', errs.join(' | '));
    } catch (e) {
        fails++;
        console.log('FAIL browser test crashed: ' + (e.stack || e.message).slice(0, 700));
    } finally {
        try { if (browser) await browser.close(); } catch (e) {}
        try { fake.setMode('ok'); await fake.stop(); } catch (e) {}
        await support.stop();
    }
    console.log(fails ? `\n${fails} check(s) FAILED` : '\nAll checks passed');
    process.exit(fails ? 1 : 0);
})();
