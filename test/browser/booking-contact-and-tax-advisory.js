// Through the REAL pages in headless Chrome on an isolated DB copy (test/support.js - the real database is never touched):
//   the Client card's Edit control in the Deal View (routes/admin/bookings.js PUT :id/contact) - view, edit, validation error, save,
//     who may see the button at all;
//   the Quote Builder's tax-invoice advisory (js/admin/bookings-quote.js, fed by /api/admin/services/meta's full_tax_invoice_over) -
//     appears only once VAT would actually be charged over the threshold and something is missing, never blocks Send Quote;
//   the booking pipeline's canned inquiry-reply sign-off (js/admin/bookings-pipeline.js), which now follows Business Profile's
//     trading name instead of being independently hard-coded;
//   and the quote/invoice detail panel's VAT percentage label, which now reads the rate actually stored instead of a fixed 15%.
// The rules themselves (what counts as a match, validation, role gating) are proven against the API in
// test/booking-contact-and-tax-advisory.test.js; this file proves the pages actually offer it and say the right things.
// Not part of `npm test`: run it with `npm run test:browser` (needs PUPPETEER_EXECUTABLE_PATH on this machine).
const sqlite3 = require('sqlite3');
const bcrypt = require('bcrypt');
const support = require('../support');
const puppeteer = require('puppeteer');
const { BASE, sleep, api, one, q, future, TEST_DB } = support;
let fails = 0;
const ok = (c, n, detail) => { if (!c) fails++; console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '\n        -> ' + String(detail).slice(0, 400))); };
const ADMIN = { email: 'test.runner@example.invalid', password: 'TestRunnerPass1!' };
let day = 1880;   // date offsets 1880-1889 belong to this file (1850-1879 is test/booking-contact-and-tax-advisory.test.js)
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
// Same seeding test/support.js's own loginAs() does (not reusable here as-is - it returns a request wrapper, not the raw cookie
// p.setCookie needs), kept local since no other browser test file has needed a non-admin role yet.
async function assistantCookie() {
    const email = 'test.assistant@example.invalid', password = 'TestRunnerPass1!';
    const hash = await bcrypt.hash(password, 10);
    const db = new sqlite3.Database(TEST_DB);
    await new Promise((resolve, reject) => db.run(
        `INSERT INTO admins (username, email, password_hash, role, is_active, must_change_password) VALUES (?, ?, ?, 'assistant', 1, 0)
         ON CONFLICT(username) DO UPDATE SET role = 'assistant', is_active = 1, password_hash = excluded.password_hash`,
        [email, email, hash], (e) => (e ? reject(e) : resolve())));
    await new Promise((resolve) => db.close(resolve));
    const r = await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
    const sc = r.headers.get('set-cookie');
    return (r.status === 200 && sc) ? sc.split(';')[0] : null;
}

async function openAdmin(browser, cookie) {
    const ctx = await browser.createBrowserContext();
    const p = await ctx.newPage();
    await p.setViewport({ width: 1440, height: 1100 });
    p._errs = [];
    p.on('pageerror', e => p._errs.push(e.message.slice(0, 200)));
    const [name, ...rest] = cookie.split('=');
    await p.setCookie({ name, value: rest.join('='), url: BASE });
    await p.setRequestInterception(true);
    p.on('request', r => {
        if (/\/api\/admin\/maps-config/.test(r.url())) return r.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, key: '' }) });
        r.continue();
    });
    await p.goto(BASE + '/admin.html', { waitUntil: 'networkidle0', timeout: 90000 });
    // window.currentUserRole is set asynchronously by the session check (admin.html applyRoleGating) - the Client card's Edit
    // control (js/admin/bookings-pipeline.js) is gated on it, so it must be in before any Deal View is opened.
    await p.waitForFunction(() => typeof window.switchTab === 'function' && typeof window.loadBookings === 'function' && !!window.currentUserRole, { timeout: 30000 });
    return p;
}
async function openDealView(p, id) {
    await p.evaluate(() => window.switchTab('bookingsAdmin'));
    await sleep(300);
    await p.evaluate(() => window.loadBookings());
    // allBookingsCache is a top-level `let` (js/admin/bookings-pipeline.js) - visible as the bare identifier in the page's own
    // evaluation context, but `let`/`const` never attach to `window`, so `window.allBookingsCache` is always undefined.
    await p.waitForFunction((id) => (typeof allBookingsCache !== 'undefined' ? allBookingsCache : []).some(b => b.id === id), { timeout: 20000 }, id);
    await p.evaluate((id) => window.toggleBookingDetail(id), id);
    await p.waitForFunction(() => /atl-drawer--open/.test((document.getElementById('dealViewDrawer') || {}).className || ''), { timeout: 20000 });
    await sleep(400);
}
async function openBuilder(p, id) {
    await p.evaluate(() => { window.closeQuoteDrawer && window.closeQuoteDrawer(); $('#qbItemsBody').empty(); const o = document.getElementById('zzOpenQuote'); if (o) o.remove(); });
    await p.evaluate((id) => { const b = document.createElement('button'); b.className = 'bk-action-quote'; b.setAttribute('data-id', id); b.id = 'zzOpenQuote'; document.body.appendChild(b); b.click(); }, id);
    await p.waitForFunction(() => document.querySelectorAll('.qb-item-row').length >= 1 && /qb-drawer--open/.test((document.getElementById('quoteDrawer') || {}).className || ''), { timeout: 25000 });
    await sleep(400);
}
const idOf = async (name) => (await one('SELECT id FROM services WHERE name = ?', [name])).id;
const mkBooking = async (label, { company, unit_price } = {}) => {
    const sClub = await idOf('Club – 10 min Set (Guest Spot)');
    const r = await api('POST', '/api/admin/bookings', {
        name: `BTA ${label}`, email: `bta.${label.replace(/\W/g, '')}.${Date.now()}@example.invalid`, cell: '+27821234567', company: company || undefined,
        event_date: future(day++), event_name: `BTA ${label}`, event_type: 'Corporate', event_location: 'Hall',
        message: 'Booking contact/advisory browser test, over ten characters.', services: [{ service_id: sClub }], status: 'NEW', override_working_hours: true, override_conflict: true
    });
    const id = r.body && r.body.booking_id;
    if (!id) throw new Error(`could not create booking "${label}": ${r.status} ${JSON.stringify(r.body)}`);
    if (unit_price) await write('UPDATE booking_services SET unit_price = ? WHERE booking_id = ?', [unit_price, id]);
    return id;
};

(async () => {
    await support.start();
    let browser;
    try {
        browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-quic'], executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined });
        const cookie = await adminCookie();
        const p = await openAdmin(browser, cookie);

        // ═══ the Client card: view + edit ═══
        const A = await mkBooking('A', { company: 'Acme Events' });
        await openDealView(p, A);
        const before = await p.evaluate((id) => document.getElementById('bk-client-card-' + id).innerText.replace(/\s+/g, ' '), A);
        ok(/Acme Events/.test(before) && !/VAT No/.test(before) && !before.includes('Main Road'), 'the Client card shows the company, and nothing for VAT/address when none is on file', before);
        ok(await p.evaluate((id) => document.querySelector('#bk-client-card-' + id + ' .bk-client-edit-toggle') !== null, A), 'an administrator sees the Edit control on the Client card', '');
        ok(await p.evaluate((id) => document.querySelector('#bk-client-card-' + id + ' .bk-client-edit-form').style.display === 'none', A), '...the edit form starts hidden', '');

        await p.evaluate((id) => document.querySelector('#bk-client-card-' + id + ' .bk-client-edit-toggle').click(), A);
        await p.waitForFunction((id) => document.querySelector('#bk-client-card-' + id + ' .bk-client-edit-form').style.display !== 'none', { timeout: 5000 }, A);
        ok(true, 'clicking Edit reveals the form', '');

        // a bad VAT number is refused inline, and saves nothing
        await p.evaluate((id) => { document.querySelector('#bk-client-card-' + id + ' .bk-ce-vat').value = '1234567890'; }, A);
        await p.evaluate((id) => document.querySelector('#bk-client-card-' + id + ' .bk-client-edit-save').click(), A);
        await p.waitForFunction((id) => { const e = document.getElementById('bk-client-edit-err-' + id); return e && e.offsetParent !== null && e.textContent.length > 3; }, { timeout: 10000 }, A);
        ok(true, 'a malformed VAT number is refused in the page, inline under the form (no toast interrupts editing)', '');
        ok((await one('SELECT vat_number FROM bookings WHERE id = ?', [A])).vat_number == null, 'and nothing was saved', '');

        // the real correction
        await p.evaluate((id) => {
            document.querySelector('#bk-client-card-' + id + ' .bk-ce-cell').value = '+27 83 555 7890';
            document.querySelector('#bk-client-card-' + id + ' .bk-ce-vat').value = '4010123456';
            document.querySelector('#bk-client-card-' + id + ' .bk-ce-address').value = '12 Main Road, Sandton, 2196';
        }, A);
        await p.evaluate((id) => document.querySelector('#bk-client-card-' + id + ' .bk-client-edit-save').click(), A);
        await p.waitForFunction((id) => { const t = document.getElementById('bk-client-card-' + id); return t && /Main Road/.test(t.innerText) && /VAT No/.test(t.innerText); }, { timeout: 15000 }, A);
        const afterRow = await one('SELECT cell, vat_number, billing_address FROM bookings WHERE id = ?', [A]);
        ok(afterRow.cell === '+27 83 555 7890' && afterRow.vat_number === '4010123456' && afterRow.billing_address === '12 Main Road, Sandton, 2196', 'saved: the booking now holds the corrected cell, VAT number and billing address', JSON.stringify(afterRow));
        const afterCard = await p.evaluate((id) => document.getElementById('bk-client-card-' + id).innerText.replace(/\s+/g, ' '), A);
        ok(/4010123456/.test(afterCard) && /Main Road/.test(afterCard) && /555 7890/.test(afterCard), '...and the Client card itself (back in its read view) shows all three', afterCard);
        ok(await p.evaluate((id) => document.querySelector('#bk-client-card-' + id + ' .bk-client-edit-form').style.display === 'none', A), '...the form closed itself again', '');

        // ═══ who may see it ═══
        const asstCookie = await assistantCookie();
        if (asstCookie) {
            const p2 = await openAdmin(browser, asstCookie);
            await openDealView(p2, A);
            ok(await p2.evaluate((id) => document.querySelector('#bk-client-card-' + id + ' .bk-client-edit-toggle') === null, A), 'an assistant never sees the Edit control at all', '');
            await p2.close();
        } else {
            ok(false, 'could not sign in as the assistant test account to check it is denied the Edit control', '');
        }

        // ═══ the Quote Builder's tax-invoice advisory ═══
        const B = await mkBooking('B', { company: 'No Address Co' });   // VAT on, over R5,000, nothing on record - should warn
        await openBuilder(p, B);
        await p.evaluate(() => { $('#qbApplyVat').prop('checked', true); $('.qb-price').val('8000').trigger('input'); });
        await p.waitForFunction(() => document.getElementById('qbTaxInvoiceAdvice').style.display !== 'none', { timeout: 10000 });
        const advice = await p.evaluate(() => document.getElementById('qbTaxInvoiceAdvice').innerText);
        ok(/address/i.test(advice) && /VAT number/i.test(advice), 'ticking Apply VAT on a quote over R5,000 for a company with nothing on file warns about both the address and the VAT number', advice);
        await p.evaluate(() => $('.qb-price').val('1000').trigger('input'));
        await p.waitForFunction(() => document.getElementById('qbTaxInvoiceAdvice').style.display === 'none', { timeout: 10000 });
        ok(true, 'and drops away again once the total is back under R5,000 - it never blocks the quote either way', '');

        const C = await mkBooking('C', { company: 'Complete Co' });   // everything already on file
        await api('PUT', `/api/admin/bookings/${C}/contact`, { vat_number: '4010123456', billing_address: '1 Complete Street' });
        await openBuilder(p, C);
        await p.evaluate(() => { $('#qbApplyVat').prop('checked', true); $('.qb-price').val('8000').trigger('input'); });
        await sleep(600);
        ok(await p.evaluate(() => document.getElementById('qbTaxInvoiceAdvice').style.display === 'none'), 'no advisory at all once the address and VAT number are already on file - even over R5,000 with VAT applied', await p.evaluate(() => document.getElementById('qbTaxInvoiceAdvice').outerHTML));

        // ═══ the canned reply sign-off follows Business Profile ═══
        await openDealView(p, A);   // ensures allBookingsCache holds A - .bk-action-email's handler looks it up there
        // The real open path (.bk-action-email) - needed so beQuillInstance actually exists before the template switcher tries to use it.
        await p.evaluate((id) => { const b = document.createElement('button'); b.className = 'bk-action-email'; b.setAttribute('data-id', id); b.id = 'zzOpenEmail'; document.body.appendChild(b); b.click(); }, A);
        await p.waitForFunction(() => /atl-drawer--open/.test((document.getElementById('bookingEmailDrawer') || {}).className || '') && document.querySelector('#be-quill-container .ql-editor'), { timeout: 15000 });
        await p.evaluate(() => { $('#be-template').val('available').trigger('change'); });
        await p.waitForFunction(() => (document.querySelector('#be-quill-container .ql-editor') || {}).innerText.length > 10, { timeout: 10000 });
        const signedDefault = await p.evaluate(() => (document.querySelector('#be-quill-container .ql-editor') || {}).innerText || '');
        ok(/Thabiso Mhlongo Management\s*$/.test(signedDefault.trim()), 'with no trading name set, the canned reply signs off exactly as it always has', signedDefault);

        const put = await fetch(`${BASE}/api/admin/business-profile`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ trading_name: 'Thabiso Comedy Bookings' }) });
        ok(put.status === 200, 'setup: gave the business a trading name', await put.text());
        await p.evaluate(() => { $('#be-template').val(''); $('#be-template').val('available').trigger('change'); });   // re-pick the same template - nothing is cached, so this alone must pick up the new name
        await p.waitForFunction(() => /Thabiso Comedy Bookings/.test((document.querySelector('#be-quill-container .ql-editor') || {}).innerText || ''), { timeout: 10000 });
        const signedAfter = await p.evaluate(() => (document.querySelector('#be-quill-container .ql-editor') || {}).innerText || '');
        ok(/Thabiso Comedy Bookings\s*$/.test(signedAfter.trim()) && !/Thabiso Mhlongo Management/.test(signedAfter), 'once a trading name is set, picking the SAME template again now signs off with it instead - one source of truth, no page reload needed', signedAfter);
        ok(!/R 35,000|R 20,000|R 15,000/.test(signedDefault) && !/R 35,000|R 20,000|R 15,000/.test(signedAfter), '...and the old, stale rate-card prices are gone from the pricing reply', signedDefault);
        await fetch(`${BASE}/api/admin/business-profile`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ trading_name: '' }) });   // restore - shared across every other test file

        // ═══ the stored VAT rate, not a fixed 15% ═══
        const D = await mkBooking('D');
        await api('POST', `/api/admin/bookings/${D}/quote`, { quote_expiry_date: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10), terms: 'T', apply_vat: true, discount: 0,
            items: [{ service_id: await idOf('Club – 10 min Set (Guest Spot)'), description: 'Club set', quantity: 1, unit_price: 5000, pricing_model: 'flat_fee' }] });
        // quote_details lives on bookings only (the Offer panel's own source - routes/admin/bookings.js GET :id); quotations has no
        // such column (its line items live in quote_line_items instead).
        await write("UPDATE bookings SET quote_details = json_set(quote_details, '$.vat_rate', 0.16) WHERE id = ?", [D]);
        await openDealView(p, D);
        const offerText = await p.evaluate((id) => (document.getElementById('dv-panel-offer') || {}).innerText || '', D);
        ok(/VAT \(16%\)/.test(offerText) && !/VAT \(15%\)/.test(offerText), 'a quote stored with a 16% VAT rate is labelled "VAT (16%)" in the Deal View, not a fixed 15%', offerText.replace(/\s+/g, ' ').slice(0, 300));

        ok(p._errs.length === 0, 'no page errors across all of the above', p._errs.join(' | '));
    } catch (e) {
        fails++;
        console.log('FAIL browser test crashed: ' + (e.stack || e.message).slice(0, 700));
    } finally {
        try { if (browser) await browser.close(); } catch (e) {}
        await support.stop();
    }
    console.log(fails ? `\n${fails} check(s) FAILED` : '\nAll checks passed');
    process.exit(fails ? 1 : 0);
})();
