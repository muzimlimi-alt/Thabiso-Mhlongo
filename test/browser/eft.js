// Manual EFT through the REAL pages in headless Chrome on an isolated DB copy (test/support.js - the real database is never touched):
//   the client's "Pay by EFT" panel in the tracking drawer (banking details, reference, upload, status) and
//   the administrator's side - the Bank Transfer & Banking Details tab in Revenue > Payment Setup, the EFT Payments queue in Finance, and the review drawer.
// The behaviour that matters (an upload never credits anything, one approval = one ledger payment, versioning) is proven against the API in
// test/eft-flow.test.js; this file proves the pages actually offer it, say the right things, and fit a phone.
// Not part of `npm test`: run it with `npm run test:browser` (needs PUPPETEER_EXECUTABLE_PATH on this machine).
const fs = require('fs');
const os = require('os');
const path = require('path');
const support = require('../support');
const puppeteer = require('puppeteer');
const { BASE, sleep, api, pub, one, future, getTrackingToken, makeTestPng } = support;
let fails = 0;
const ok = (c, n, detail) => { if (!c) fails++; console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '\n        -> ' + String(detail).slice(0, 400))); };
const ADMIN = { email: 'test.runner@example.invalid', password: 'TestRunnerPass1!' };
const ACCT = '62001234567';

async function adminCookie() {
    const r = await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ADMIN) });
    const sc = r.headers.get('set-cookie');
    if (r.status !== 200 || !sc) throw new Error('admin login failed: ' + r.status);
    return sc.split(';')[0];
}

async function acceptedBooking(tag, days) {
    const service = await one("SELECT id FROM services WHERE name = 'Club – 10 min Set (Guest Spot)'");
    const email = `eft.ui.${tag}.${Date.now()}@example.invalid`;
    const created = await api('POST', '/api/admin/bookings', { name: `ZZ EFT UI ${tag}`, email, cell: '+27821234567', event_date: future(days), event_name: `EFT UI ${tag}`, event_type: 'Corporate Event',
        event_location: 'Test Hall', message: 'EFT browser test, over ten characters.', services: [{ service_id: service.id }], status: 'NEW', override_working_hours: true });
    const id = created.body.booking_id;
    const bk = await one('SELECT date FROM bookings WHERE id = ?', [id]);
    const expiry = new Date(Date.parse(bk.date) - 10 * 86400000).toISOString().slice(0, 10);
    await api('POST', `/api/admin/bookings/${id}/quote`, { quote_expiry_date: expiry, terms: 'Standard terms apply.', apply_vat: false, discount: 0, items: [{ service_id: service.id, description: 'Club set', quantity: 1, unit_price: 5000, pricing_model: 'flat_fee' }] });
    const token = await getTrackingToken(id, email);
    await pub('POST', `/api/public/bookings/${id}/accept-quote`, { access_token: token, terms_agreed: true });
    for (let i = 0; i < 60 && !(await one('SELECT id FROM invoices WHERE booking_id = ?', [id])); i++) await sleep(150);
    return { id, email, token };
}

(async () => {
    await support.start();
    let browser;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eft-ui-'));
    try {
        // ── setup: banking details on, two accepted bookings ──
        const saved = await api('PUT', '/api/admin/eft/bank-details', { account_holder: 'Thabiso Mhlongo Entertainment', bank_name: 'First National Bank', account_number: ACCT, account_type: 'cheque', branch_code: '250655', reference_note: 'Use your invoice number as the reference' });
        await api('PUT', '/api/admin/eft/settings', { enabled: true, max_upload_mb: 5 });
        ok(saved.status === 200, 'setup: banking details saved and EFT switched on', JSON.stringify(saved.body));
        const A = await acceptedBooking('a', 1790);
        const B = await acceptedBooking('b', 1791);
        const inv = await one('SELECT invoice_number FROM invoices WHERE booking_id = ?', [A.id]);
        const png = path.join(tmp, 'proof.png'); fs.writeFileSync(png, makeTestPng(32, 32, { random: true }));
        const png2 = path.join(tmp, 'proof2.png'); fs.writeFileSync(png2, makeTestPng(32, 32, { random: true }));
        const txt = path.join(tmp, 'notes.txt'); fs.writeFileSync(txt, 'not a proof of payment');

        browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-quic'], executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined });

        // ═══ the client ═══
        const openTracker = async (b, w) => {
            const ctx = await browser.createBrowserContext();
            const p = await ctx.newPage();
            await p.setViewport({ width: w, height: 1000, isMobile: w < 500, hasTouch: w < 500 });
            p._errs = [];
            p.on('pageerror', e => p._errs.push(e.message.slice(0, 200)));
            await p.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
            await p.evaluate((id, token, email) => {
                sessionStorage.setItem('trkToken_' + id, JSON.stringify({ token, expires_at: Date.now() + 3600000 }));
                localStorage.setItem('trkEmailCache', email);
            }, String(b.id), b.token, b.email);
            await p.goto(BASE + '/?track=' + b.id, { waitUntil: 'domcontentloaded', timeout: 60000 });
            await p.waitForFunction(() => window.openAtlDrawer && document.getElementById('trackBtn'), { timeout: 20000 });
            await p.evaluate(() => { const x = document.getElementById('cookieRejectAll'); if (x && x.offsetParent) x.click(); });
            await p.evaluate(() => document.getElementById('trackBtn').click());
            // Paying offers two tabs, Pay online / Bank transfer: the client chooses Bank transfer to see this panel.
            await p.waitForFunction(() => { const e = document.getElementById('eftSection'); return e && e.style.display !== 'none' && document.getElementById('trackingDetails').style.display !== 'none'; }, { timeout: 20000 });
            await p.evaluate(() => { const t = document.getElementById('trkPayTabEft'); if (t && t.offsetParent) t.click(); });
            await p.waitForFunction(() => { const e = document.getElementById('eftSection'); return e && e.offsetParent !== null; }, { timeout: 20000 });
            return p;
        };
        const pc = await openTracker(A, 1280);
        // The whole "Bank transfer (EFT)" option card: when online payment is offered too, its heading names the method.
        const panel = await pc.evaluate(() => (document.getElementById('trkPayOptEft') || document.getElementById('eftSection')).innerText.replace(/\s+/g, ' '));
        ok(/Pay by EFT|Bank transfer \(EFT\)/i.test(panel) && /Thabiso Mhlongo Entertainment/.test(panel) && /First National Bank/.test(panel) && panel.includes(ACCT) && /250655/.test(panel), 'the tracking page shows the banking details', panel);
        ok(panel.includes(inv.invoice_number) && /Payment reference/i.test(panel), 'it shows the reference to quote - the invoice number', panel);
        ok(/confirmed only once we have checked it/i.test(panel) && /does not confirm your payment/i.test(panel), 'and says a proof does NOT confirm the payment', panel);
        ok(await pc.evaluate(() => !!document.querySelector('#eftUploadForm input[type=file][name=proof]') && document.querySelector('#eftAmount').value === '2500.00'), 'the upload form offers the next instalment (R2,500.00) as the amount', '');
        ok(await pc.evaluate(() => document.querySelector('#eftFile').accept.includes('.pdf') && !document.querySelector('#eftFile').accept.includes('webp')), 'the file picker is limited to PDF, JPG and PNG', '');

        // a wrong type is stopped before anything is sent
        await (await pc.$('#eftFile')).uploadFile(txt);
        await pc.evaluate(() => document.getElementById('eftUploadBtn').click());
        await sleep(700);
        ok((await support.q('SELECT id FROM eft_payment_submissions WHERE booking_id = ?', [A.id])).length === 0 && await pc.evaluate(() => [...document.querySelectorAll('.tm-toast')].some(t => /Wrong file type/i.test(t.textContent))),
            'a .txt file is refused in the page with a clear message and nothing is sent', '');

        // the real thing
        await (await pc.$('#eftFile')).uploadFile(png);
        await pc.type('#eftReference', 'FNB app ref 123');
        await pc.evaluate(() => document.getElementById('eftUploadBtn').click());
        await pc.waitForFunction(() => document.querySelectorAll('.trk-eft-list li').length === 1, { timeout: 20000 });
        const afterUpload = await pc.evaluate(() => ({ list: document.querySelector('.trk-eft-list').innerText.replace(/\s+/g, ' '), pay: document.getElementById('tdPaymentStatus').textContent.trim(), page: document.getElementById('trackingDetails').innerText }));
        ok(/Awaiting verification/i.test(afterUpload.list) && /Proof of payment submitted/i.test(afterUpload.list) && /R\s?2500\.00/.test(afterUpload.list), 'after sending, the proof is listed as "Proof of payment submitted - awaiting verification" for R2,500.00', afterUpload.list);
        ok(/proof\.png/.test(afterUpload.list) && /sent \d{4}-\d{2}-\d{2}/.test(afterUpload.list), 'the list shows the name of the file they sent and the date they sent it', afterUpload.list);
        ok(/UNPAID/i.test(afterUpload.pay) && !/payment (received|confirmed|successful)/i.test(afterUpload.page), 'the booking still reads UNPAID and the page never claims a payment was received', afterUpload.pay);
        ok(await pc.evaluate(() => [...document.querySelectorAll('.tm-toast')].some(t => /received your proof of payment|Proof of payment received/i.test(t.textContent) && /not yet a confirmation/i.test(t.textContent))), 'the toast says it was received and is not yet a confirmation of payment', '');
        const row = await one('SELECT status, claimed_amount, claimed_reference, schedule_id FROM eft_payment_submissions WHERE booking_id = ?', [A.id]);
        ok(row && row.status === 'pending' && row.claimed_amount === 2500 && row.claimed_reference === 'FNB app ref 123' && row.schedule_id, 'the server holds it as pending, with the reference and the instalment', JSON.stringify(row));
        ok((await one('SELECT amount_paid, payment_status FROM bookings WHERE id = ?', [A.id])).amount_paid === 0, 'and nothing was credited', '');
        ok(pc._errs.length === 0, 'no page errors on the public page', pc._errs.join(' | '));
        await pc.close();

        // phone width: the panel fits, nothing scrolls sideways
        const pm = await openTracker(B, 390);
        const fit = await pm.evaluate(() => {
            const s = document.getElementById('eftSection').getBoundingClientRect();
            const drawer = document.getElementById('trackingDrawer').getBoundingClientRect();
            const wide = [...document.querySelectorAll('#eftSection *')].filter(e => e.getBoundingClientRect().right > drawer.right + 1).map(e => e.tagName + '.' + e.className).slice(0, 5);
            return { overflowX: document.documentElement.scrollWidth - window.innerWidth, panelRight: Math.round(s.right), drawerRight: Math.round(drawer.right), wide };
        });
        ok(fit.overflowX <= 1 && fit.wide.length === 0, 'on a 390px phone the EFT panel fits inside the drawer, no sideways scroll', JSON.stringify(fit));
        ok(await pm.evaluate(() => [...document.querySelectorAll('#eftUploadForm input:not([type=hidden]), #eftUploadBtn')].every(e => e.getBoundingClientRect().height >= 36)), 'its inputs and the button are comfortably tappable (at least 36px tall)', '');
        await pm.close();

        // ═══ the administrator ═══
        // B uploads through the API so the queue has a second proof to reject
        const formB = new FormData(); formB.append('amount', '1000'); formB.append('payment_date', future(-1)); formB.append('proof', new Blob([fs.readFileSync(png2)], { type: 'image/png' }), 'second.png');
        const upB = await fetch(`${BASE}/api/public/bookings/${B.id}/eft/proof`, { method: 'POST', headers: { 'x-booking-access-token': B.token }, body: formB });
        ok(upB.status === 200, 'setup: a second client sent a proof', upB.status);

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
        await p.waitForFunction(() => typeof window.closeAtlDrawer === 'function' && typeof $ === 'function' && typeof window.loadEftQueue === 'function', { timeout: 30000 });

        // Finance -> EFT Payments
        await p.evaluate(() => $('a[href="#financeAdmin"]').first().tab('show'));
        await sleep(600);
        await p.evaluate(() => $('#finTabBar .atl-tab-btn[data-um-tab="finEft"]').click());
        await p.waitForFunction(() => document.querySelectorAll('#eftQueueBody tr .eft-open').length >= 2, { timeout: 20000 });
        const queue = await p.evaluate(() => document.getElementById('eftQueueBody').innerText.replace(/\s+/g, ' '));
        ok(/ZZ EFT UI a/.test(queue) && /ZZ EFT UI b/.test(queue) && /Waiting for review/.test(queue) && /R\s?2\s?500/.test(queue), 'the EFT Payments tab lists both pending proofs with the client, amount and status', queue);
        ok(await p.evaluate(() => { const b = document.getElementById('eftPendingBadge'); return b.offsetParent !== null && parseInt(b.textContent, 10) >= 2; }), 'the tab carries a badge with the number waiting', '');

        // review A and approve
        await p.evaluate((id) => { [...document.querySelectorAll('.eft-open')].find(b => b.closest('tr').textContent.includes('Booking #' + id)).click(); }, A.id);
        await p.waitForFunction(() => document.getElementById('eftReviewDrawer').classList.contains('atl-drawer--open') && document.querySelector('#eftProofPreview img'), { timeout: 20000 });
        const review = await p.evaluate(() => document.getElementById('eftReviewBody').innerText.replace(/\s+/g, ' '));
        ok(/ZZ EFT UI a/.test(review) && /FNB app ref 123/.test(review) && /Check it against the bank statement/i.test(review) && /Still outstanding/i.test(review), 'the review drawer shows the booking, what the client said and the verification form', review);
        ok(await p.evaluate(() => { const i = document.querySelector('#eftProofPreview img'); return i && i.naturalWidth > 0 && i.src.startsWith('blob:'); }), 'the proof image is shown (loaded through the authenticated route)', '');
        ok(await p.evaluate(() => document.querySelector('#eftVerAmount').value === '2500.00' && document.querySelector('#eftVerRef').value === 'FNB app ref 123'), 'the form starts with what the client claimed, to be corrected against the statement', '');
        await p.evaluate(() => { document.getElementById('eftVerRef').value = ''; });
        await p.evaluate(() => document.getElementById('eftApproveBtn').click());
        await p.waitForFunction(() => { const m = document.getElementById('eftReviewMsg'); return m && m.offsetParent !== null && m.textContent.trim().length > 3; }, { timeout: 10000 });
        ok(/reference/i.test(await p.evaluate(() => document.getElementById('eftReviewMsg').textContent)) && (await one('SELECT amount_paid FROM bookings WHERE id = ?', [A.id])).amount_paid === 0, 'approving without the bank reference is refused in the drawer and records nothing', '');
        await p.type('#eftVerRef', 'FNB-STMT-77');
        await p.evaluate(() => document.getElementById('eftApproveBtn').click());
        await p.waitForFunction(() => !document.getElementById('eftReviewDrawer').classList.contains('atl-drawer--open'), { timeout: 20000 });
        await sleep(800);
        const bkA = await one('SELECT amount_paid, amount_outstanding, payment_status, status FROM bookings WHERE id = ?', [A.id]);
        ok(bkA.amount_paid === 2500 && bkA.amount_outstanding === 2500 && bkA.payment_status === 'DEPOSIT_PAID' && bkA.status === 'CONFIRMED', 'approving records the R2,500.00 payment on the booking (DEPOSIT_PAID, CONFIRMED)', JSON.stringify(bkA));
        ok(await p.evaluate(() => [...document.querySelectorAll('.tm-toast')].some(t => /recorded for booking/i.test(t.textContent))), 'the administrator gets a toast (not a browser alert) confirming it', '');
        ok(await p.evaluate((id) => ![...document.querySelectorAll('#eftQueueBody tr')].some(r => r.textContent.includes('Booking #' + id) && /Waiting/.test(r.textContent)), A.id), 'the approved proof leaves the waiting list', '');

        // reject B
        await p.evaluate((id) => { [...document.querySelectorAll('.eft-open')].find(b => b.closest('tr').textContent.includes('Booking #' + id)).click(); }, B.id);
        await p.waitForFunction(() => document.getElementById('eftReviewDrawer').classList.contains('atl-drawer--open') && document.getElementById('eftRejectBtn'), { timeout: 20000 });
        await p.evaluate(() => document.getElementById('eftRejectBtn').click());
        await p.waitForFunction(() => document.getElementById('eftReasonBox').offsetParent !== null, { timeout: 5000 });
        await p.evaluate(() => document.getElementById('eftReasonSend').click());
        await p.waitForFunction(() => { const m = document.getElementById('eftReviewMsg'); return m && m.offsetParent !== null && /reason/i.test(m.textContent); }, { timeout: 10000 });
        ok((await one('SELECT status FROM eft_payment_submissions WHERE booking_id = ?', [B.id])).status === 'pending', 'rejecting without a reason is refused and the proof stays pending', '');
        await p.type('#eftReasonText', 'We cannot see a R1,000.00 deposit on our statement.');
        await p.evaluate(() => document.getElementById('eftReasonSend').click());
        await p.waitForFunction(() => !document.getElementById('eftReviewDrawer').classList.contains('atl-drawer--open'), { timeout: 20000 });
        await sleep(500);
        const subB = await one('SELECT status, review_note FROM eft_payment_submissions WHERE booking_id = ?', [B.id]);
        ok(subB.status === 'rejected' && /R1,000\.00 deposit/.test(subB.review_note) && (await one('SELECT amount_paid FROM bookings WHERE id = ?', [B.id])).amount_paid === 0, 'a rejection with a reason is saved, the client is told why and nothing is credited', JSON.stringify(subB));
        await p.select('#eftStatusFilter', '');
        await p.waitForFunction(() => /Rejected/.test(document.getElementById('eftQueueBody').innerText) && /Approved/.test(document.getElementById('eftQueueBody').innerText), { timeout: 10000 });
        ok(true, 'the "All proofs" filter shows the approved and the rejected proof', '');

        // Revenue > Payment Setup > Bank Transfer & Banking Details
        await p.evaluate(() => { window.switchTab('paymentSetupAdmin'); document.querySelector('[data-um-tab="payPanelBank"]').click(); });
        await p.waitForFunction(() => { const c = document.getElementById('stEftCard'); return c && c.offsetParent !== null && document.getElementById('eftHolder').value && document.getElementById('eftCardStatus').textContent; }, { timeout: 20000 });
        const card = await p.evaluate(() => ({ holder: document.getElementById('eftHolder').value, bank: document.getElementById('eftBank').value, acct: document.getElementById('eftAccount').value, type: document.getElementById('eftType').value, on: document.getElementById('eftEnabled').checked, status: document.getElementById('eftCardStatus').textContent }));
        ok(card.holder === 'Thabiso Mhlongo Entertainment' && card.bank === 'First National Bank' && card.acct === ACCT && card.type === 'current' && card.on === true && /ON/.test(card.status), 'the Payment Setup card loads the current banking details and the switch', JSON.stringify(card));
        const preview1 = await p.evaluate(() => document.getElementById('eftPreviewBody').innerText.replace(/\s+/g, ' '));
        ok(/First National Bank/.test(preview1) && preview1.includes(ACCT) && /Invoice number\s+INV-2026-0042/.test(preview1) && /Amount payable/.test(preview1) && /Payment reference\s+INV-2026-0042/.test(preview1) && /cleared funds/.test(preview1),
            'the card previews exactly how the details appear on an invoice (sample invoice number and amount, the verification note)', preview1);
        await p.evaluate(() => { const i = document.getElementById('eftBank'); i.value = 'Capitec Business'; i.dispatchEvent(new Event('input', { bubbles: true })); });
        ok(await p.evaluate(() => /Capitec Business/.test(document.getElementById('eftPreviewBody').innerText)), 'the preview updates as the administrator types, before anything is saved', await p.evaluate(() => document.getElementById('eftPreviewBody').innerText));
        ok((await one('SELECT bank_name FROM bank_details WHERE is_active = 1')).bank_name === 'First National Bank', 'and typing alone saved nothing', '');
        await p.evaluate(() => { const i = document.getElementById('eftBank'); i.value = 'First National Bank'; i.dispatchEvent(new Event('input', { bubbles: true })); });
        await p.evaluate(() => { document.getElementById('eftAccount').value = '12'; });
        await p.evaluate(() => document.getElementById('eftSaveDetailsBtn').click());
        await p.waitForFunction(() => { const e = document.getElementById('errEftAccount'); return e && e.offsetParent !== null && e.textContent.length > 3; }, { timeout: 10000 });
        ok((await one('SELECT COUNT(*) c FROM bank_details')).c === 1, 'a bad account number shows its error under the field and saves nothing', '');
        await p.evaluate((acct) => { document.getElementById('eftAccount').value = acct; document.getElementById('eftBank').value = 'Nedbank'; }, '10098765432');
        await p.evaluate(() => document.getElementById('eftSaveDetailsBtn').click());
        await p.waitForFunction(() => document.querySelectorAll('#eftVersionsBody tr').length === 2, { timeout: 15000 });
        const versions = await p.evaluate(() => document.getElementById('eftVersionsBody').innerText.replace(/\s+/g, ' '));
        ok(/v2/.test(versions) && /v1/.test(versions) && /Nedbank/.test(versions) && !versions.includes('10098765432') && !versions.includes(ACCT), 'saving a change adds version 2; the history lists both with the account numbers masked', versions);
        ok(await p.evaluate(() => /unchanged|new invoices|version 2/i.test(document.getElementById('eftDetailsMsg').textContent)), 'and tells the administrator what the change does (invoices already sent keep their details)', await p.evaluate(() => document.getElementById('eftDetailsMsg').textContent));
        ok(errs.length === 0, 'no page errors on the admin page', errs.join(' | '));
    } catch (e) {
        fails++;
        console.log('FAIL browser test crashed: ' + (e.stack || e.message).slice(0, 600));
    } finally {
        try { if (browser) await browser.close(); } catch (e) {}
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
        await support.stop();
    }
    console.log(fails ? `\n${fails} check(s) FAILED` : '\nAll checks passed');
    process.exit(fails ? 1 : 0);
})();
