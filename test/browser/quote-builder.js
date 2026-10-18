// Rate card 2026 (Phase 5): the admin Bookings screen, the Deal View, the Quote Builder and the public homepage cards, driven through
// the REAL pages in headless Chrome on an isolated DB copy (test/support.js - SMTP mocked, the real database is never touched).
//   Bookings / Deal View: a booking that has only the catalogue ESTIMATE is not shown as quoted ("Send Quote", not "Revise"; the Fee column
//                         says "est."; an individually priced line is "To be quoted", never R0.00 / R NaN);
//   Quote Builder:        no "already has a quote" prompt for a first quote; the line amount comes from the SAVED quote when one exists and from
//                         the CURRENT catalogue when none does; a range line starts empty; the live preview is the number the server stores
//                         (VAT on taxable lines only, exempt lines, discount, qty 2); a service retired since the booking still behaves;
//   Homepage:             five rate-card cards, "Most Booked" on Corporate & Events, no prices, sensible at phone / tablet / desktop widths,
//                         and a card opens the booking drawer with its source recorded.
//
// Not part of `npm test`: run it with `npm run test:browser` (needs PUPPETEER_EXECUTABLE_PATH on this machine, see test-suite notes).
const fs = require('fs');
const path = require('path');
const support = require('../support');
const puppeteer = require('puppeteer');
const { BASE, sleep, api, one, q, future } = support;
let fails = 0;
const ok = (c, n, detail) => { if (!c) fails++; console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '\n        -> ' + detail)); };
const SHOTS = process.env.SVC_SHOTS_DIR || null;     // optional: directory for screenshots
const ADMIN = { email: 'test.runner@example.invalid', password: 'TestRunnerPass1!' };

async function adminCookie() {
    const r = await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ADMIN) });
    const sc = r.headers.get('set-cookie');
    if (r.status !== 200 || !sc) throw new Error('admin login failed: ' + r.status);
    return sc.split(';')[0];
}

async function openAdmin(browser, cookie, { width = 1440, height = 1100 } = {}) {
    const ctx = await browser.createBrowserContext();
    const p = await ctx.newPage();
    await p.setViewport({ width, height });
    p._errs = []; p._reqs = [];
    p.on('pageerror', e => p._errs.push(e.message.slice(0, 200)));
    p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|Loading the font|API Error/.test(m.text())) p._errs.push('console: ' + m.text().slice(0, 200)); });
    p.on('request', r => { if (/\/api\/admin\/bookings\/\d+\/quote$/.test(r.url()) && r.method() === 'POST') p._reqs.push({ url: r.url().replace(BASE, ''), body: r.postData() || '' }); });
    const [name, ...rest] = cookie.split('=');
    await p.setCookie({ name, value: rest.join('='), url: BASE });
    await p.setRequestInterception(true);
    p.on('request', r => {
        if (/\/api\/admin\/maps-config/.test(r.url())) return r.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, key: '' }) });
        r.continue();
    });
    await p.goto(BASE + '/admin.html', { waitUntil: 'networkidle0', timeout: 90000 });
    await p.waitForFunction(() => typeof window.switchTab === 'function' && typeof window.loadBookings === 'function' && !!window.DocumentTotals, { timeout: 30000 });
    // Record every confirm dialog; answer Yes to everything except "recover a draft" (a stale draft must never replace a fresh prefill).
    await p.evaluate(() => {
        window.__confirms = [];
        window.notificationService.showConfirm = async (o) => { window.__confirms.push((o && o.title) || ''); return !/Recover Unsaved Draft/.test((o && o.title) || ''); };
    });
    return p;
}

const shot = async (p, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await p.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: false }); } };
const idOf = async (name) => (await one('SELECT id FROM services WHERE name = ?', [name])).id;
const mkBooking = async (label, services, extra = {}) => {
    const r = await api('POST', '/api/admin/bookings', {
        name: `BQ ${label}`, email: `bq.${label.replace(/\W/g, '')}.${Date.now()}@example.invalid`, cell: '+27821234567', event_date: future(day++), event_name: `BQ ${label}`,
        event_type: 'Corporate', event_location: 'Builder Hall', message: 'Quote builder browser test, over ten characters.', services, status: 'NEW', override_working_hours: true, ...extra
    });
    return r.body && r.body.booking_id;
};
let day = 1400;   // date offsets 1400-1449 belong to this file
const expiryFor = async (id) => new Date(Date.parse((await one('SELECT date FROM bookings WHERE id=?', [id])).date) - 10 * 86400000).toISOString().slice(0, 10);

async function gotoBookings(p, search) {
    await p.evaluate(() => window.switchTab('bookingsAdmin'));
    await sleep(300);
    await p.evaluate(() => window.loadBookings());
    await p.waitForFunction(() => document.querySelectorAll('#bookingsListContainer tr.atl-bk-row').length > 0, { timeout: 30000 });
    await p.evaluate((s) => { $('#bkSearchInput').val(s); window.applyBookingFilter(); }, search || '');
    await sleep(400);
}
const rowInfo = (p, id) => p.evaluate((id) => {
    const tr = document.querySelector(`#bookingsListContainer tr.atl-bk-row[data-id="${id}"]`);
    if (!tr) return null;
    const bar = tr.querySelector('.atl-card-actions-bar');
    return { fee: tr.querySelector('.atl-bk-fee').textContent.replace(/\s+/g, ' ').trim(), actions: bar ? bar.textContent.replace(/\s+/g, ' ').trim() : '' };
}, id);

async function openBuilder(p, id, nRows) {
    await p.evaluate(() => { window.closeQuoteDrawer && window.closeQuoteDrawer(); $('#qbItemsBody').empty(); window.__confirms.length = 0; const o = document.getElementById('zzOpenQuote'); if (o) o.remove(); try { localStorage.clear(); } catch (e) { /* ignore */ } });
    await p.evaluate((id) => { const b = document.createElement('button'); b.className = 'bk-action-quote'; b.setAttribute('data-id', id); b.id = 'zzOpenQuote'; document.body.appendChild(b); b.click(); }, id);
    await p.waitForFunction((n) => document.querySelectorAll('.qb-item-row').length >= n && /qb-drawer--open/.test((document.getElementById('quoteDrawer') || {}).className || ''), { timeout: 25000 }, nRows);
    await sleep(500);
}
const builderRows = (p) => p.evaluate(() => [...document.querySelectorAll('.qb-item-row')].map(r => ({
    desc: r.querySelector('.qb-desc').value, qty: r.querySelector('.qb-qty').value, price: r.querySelector('.qb-price').value, taxClass: r.getAttribute('data-tax-class'),
    qr: r.getAttribute('data-quote-required'), hint: (r.querySelector('.qb-quote-hint') || {}).textContent || '', total: r.querySelector('.qb-row-total').textContent.trim(), placeholder: r.querySelector('.qb-price').placeholder })));
const totals = (p) => p.evaluate(() => ({ sub: document.getElementById('qbSubtotal').textContent, vat: document.getElementById('qbVatAmount').textContent, total: document.getElementById('qbFinalTotal').textContent }));
const setRow = (p, i, field, v) => p.evaluate((i, field, v) => { const e = document.querySelectorAll('.qb-item-row')[i].querySelector(field); e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); }, i, field, v);
const setField = (p, sel, v) => p.evaluate((s, v) => { const e = document.querySelector(s); e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); }, sel, v);
async function sendQuote(p, expiry) {
    await setField(p, '#quoteModalExpiry', expiry);
    p._reqs.length = 0;
    await p.evaluate(() => document.getElementById('quoteModalSendBtn').click());
    await p.waitForFunction(() => /Quote sent successfully|Enter the agreed|Failed|error/i.test(document.getElementById('quoteModalMsg').textContent), { timeout: 30000 }).catch(() => {});
    const msg = await p.evaluate(() => document.getElementById('quoteModalMsg').textContent);
    // After a successful send the builder closes itself and reloads the list 1.5s later; let that finish, or it would close the NEXT
    // scenario's freshly opened builder under the test.
    if (/Quote sent successfully/.test(msg)) await sleep(2000);
    return msg;
}
const confirms = (p) => p.evaluate(() => window.__confirms.slice());

(async () => {
    await support.start();
    let browser;
    const createdSvc = [];
    try {
        browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-quic'], executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined });
        const cookie = await adminCookie();
        for (let i = 0; i < 100; i++) { if (await one('SELECT 1 AS x FROM schema_migrations WHERE version = 106')) break; await sleep(100); }

        const sClub = await idOf('Club – 10 min Set (Guest Spot)');                 // fixed R5,000
        const sHead = await idOf('Writing – Head Writer (per month)');              // range R90,000 – R140,000 per month
        const sCombo = await idOf('Private – Performance + MC Combo');              // from R50,000
        const sTravel = await idOf('Travel Buyout – Gauteng');                      // exempt flat
        const sNight = await idOf('Accommodation – Single Night');                  // exempt flat, no max quantity
        const mkSvc = async (over) => { const r = await api('POST', '/api/admin/services', { name: `ZZ-QB ${Date.now().toString(36)}${createdSvc.length}`, category: 'Other', is_taxable: true, is_active: true, pricing_model: 'flat_fee', ...over }); if (r.body && r.body.id) createdSvc.push(r.body.id); return r.body.id; };

        // ═══════════ Admin Bookings screen + Deal View, before any quote ═══════════
        const bF = await mkBooking('QS Fixed', [{ service_id: sClub }]);
        const bR = await mkBooking('QS Range', [{ service_id: sHead }]);
        const bM = await mkBooking('QS Mixed', [{ service_id: sClub }, { service_id: sCombo }]);
        ok(!!bF && !!bR && !!bM, 'fixture: a fixed, a range and a mixed booking, none quoted', JSON.stringify([bF, bR, bM]));
        const p = await openAdmin(browser, cookie);
        await gotoBookings(p, 'BQ QS');
        await shot(p, '01-bookings-before-quote');
        const rf = await rowInfo(p, bF), rr = await rowInfo(p, bR), rm = await rowInfo(p, bM);
        ok(rf && /R 5000\.00/.test(rf.fee) && /est\./.test(rf.fee), 'Fee column: a fixed booking with no quote shows the catalogue ESTIMATE marked "est."', JSON.stringify(rf));
        ok(rr && rr.fee === 'To be quoted' && rm && rm.fee === 'To be quoted', 'Fee column: an individually priced booking says "To be quoted" (not a dash, not R0.00)', JSON.stringify({ rr, rm }));
        ok([rf, rr, rm].every(x => x && /Send Quote/.test(x.actions) && !/Revise/.test(x.actions)), 'the primary action is "Send Quote" - never "Revise & Send Quote" - for a booking that has never been quoted', JSON.stringify({ rf, rr, rm }));
        const fns = await p.evaluate(() => ({
            a: bkHasQuote({ has_quote: 0, quote_amount: 'R 5000.00' }), b: bkHasQuote({ has_quote: 1, quote_amount: '5000.00' }), c: bkHasQuote({ quoted_at: '2026-10-01', quote_amount: '10.00' }),
            d: bookingNeedsAction({ status: 'PENDING', has_quote: 0, quote_amount: 'R 5000.00' }), e: bookingNeedsAction({ status: 'PENDING', has_quote: 1, quote_amount: '5000.00' }),
            f: bkMoney('R 5,000.00'), g: bkMoney('5000.00'), h: bkMoney(null) }));
        ok(fns.a === false && fns.b === true && fns.c === true, 'bkHasQuote: the estimate alone is not a quote; has_quote / quoted_at are', JSON.stringify(fns));
        ok(fns.d === true && fns.e === false, 'Needs Action: a PENDING booking with only an estimate needs action; one with a quote does not', JSON.stringify(fns));
        ok(fns.f === 5000 && fns.g === 5000 && fns.h === null, 'bkMoney reads "R 5,000.00" and "5000.00" (parseFloat gave NaN for the first)', JSON.stringify(fns));

        // Deal View for the individually priced booking
        await p.evaluate((id) => window.toggleBookingDetail(id), bR);
        await p.waitForFunction(() => /atl-drawer--open/.test((document.getElementById('dealViewDrawer') || {}).className || ''), { timeout: 20000 });
        await p.waitForFunction((id) => { const e = document.getElementById('atl-lineitems-' + id); return e && /Line items/.test(e.textContent) && !/Loading/i.test(e.textContent); }, { timeout: 20000 }, bR);
        await sleep(400);
        const dvR = await p.evaluate((id) => ({
            chips: document.getElementById('dvChips').textContent.replace(/\s+/g, ' ').trim(),
            lines: document.getElementById('atl-lineitems-' + id).textContent.replace(/\s+/g, ' ').trim(),
            overview: document.getElementById('dv-panel-overview').textContent.replace(/\s+/g, ' '),
            offer: document.getElementById('dv-panel-offer').textContent.replace(/\s+/g, ' '),
            actions: document.getElementById('dvActions').textContent.replace(/\s+/g, ' ').trim()
        }), bR);
        ok(/To be quoted/.test(dvR.chips) && !/R\s?NaN|R 0\.00/.test(dvR.chips), 'Deal View header chip: "To be quoted" (no R NaN, no R 0.00)', dvR.chips);
        ok(/To be quoted/.test(dvR.lines) && /R90,000 – R140,000 per month/.test(dvR.lines) && !/R 0\.00/.test(dvR.lines), 'Deal View line items: the unpriced line is "To be quoted" with the published band beside it, not R 0.00', dvR.lines);
        ok(/Quoted total\s*Not yet quoted/.test(dvR.overview) && !/R\s?NaN/.test(dvR.overview), 'Deal View ledger: "Quoted total - Not yet quoted" (it used to read R NaN for the estimate)', dvR.overview.slice(0, 400));
        ok(/No quote prepared yet/.test(dvR.offer) && /Prepare Quote/.test(dvR.offer), 'Deal View, Quote & Contract tab: "No quote prepared yet" + Prepare Quote', dvR.offer.slice(0, 300));
        ok(/Send Quote/.test(dvR.actions) && !/Revise/.test(dvR.actions), 'Deal View action bar: Send Quote', dvR.actions);
        await shot(p, '02-dealview-unpriced');
        await p.evaluate(() => window.closeAtlDrawer('dealViewDrawer'));

        await p.evaluate((id) => window.toggleBookingDetail(id), bF);
        await p.waitForFunction((id) => /atl-drawer--open/.test((document.getElementById('dealViewDrawer') || {}).className || '') && $('#dealViewDrawer').data('bookingId') == id, { timeout: 20000 }, bF);
        await sleep(500);
        const dvF = await p.evaluate(() => ({ chips: document.getElementById('dvChips').textContent.replace(/\s+/g, ' ').trim(), overview: document.getElementById('dv-panel-overview').textContent.replace(/\s+/g, ' ') }));
        ok(/Est\. R 5000\.00/.test(dvF.chips) && !/R\s?NaN/.test(dvF.chips), 'Deal View header chip: a fixed booking with no quote shows "Est. R 5000.00"', dvF.chips);
        ok(/Quoted total\s*Not yet quoted/.test(dvF.overview), 'Deal View ledger: not yet quoted', dvF.overview.slice(0, 300));
        // Phase 6: an estimate is a published rate, not money owed - no "Outstanding" chip, no Outstanding balance, before a quotation exists
        ok(!/Outstanding/.test(dvF.chips), 'Deal View header: no "Outstanding R 5000.00" chip for a booking that was never quoted', dvF.chips);
        ok(/Outstanding\s*—/.test(dvF.overview) && !/Outstanding\s*R\s*5000/.test(dvF.overview), 'Deal View ledger: Outstanding is "—", not the R5,000 estimate', dvF.overview.slice(0, 500));
        await p.evaluate(() => window.closeAtlDrawer('dealViewDrawer'));

        // Financial Controls (More menu): Total / Outstanding must not be the estimate either
        const openFinancials = async (id) => { await p.evaluate((id) => { const b = document.createElement('button'); b.className = 'bk-action-financials'; b.setAttribute('data-id', id); document.body.appendChild(b); b.click(); b.remove(); }, id); await sleep(500); return p.evaluate(() => ({ total: $('#bf-total').text(), paid: $('#bf-paid').text(), out: $('#bf-outstanding').text() })); };
        let fin = await openFinancials(bF);
        ok(fin.total === 'Not yet quoted' && fin.out === '—' && fin.paid === 'R 0.00', 'Financial Controls: an unquoted booking shows "Not yet quoted" and "—" (not R5,000 total / R5,000 outstanding)', JSON.stringify(fin));
        await p.evaluate(() => window.closeAtlDrawer && window.closeAtlDrawer('bookingFinancialsDrawer'));

        // Bulk CSV export from the pipeline: estimates are blank, with the basis stated
        const csvOf = async (ids) => p.evaluate(async (ids) => {
            let blob = null; const orig = URL.createObjectURL; URL.createObjectURL = (b) => { blob = b; return orig.call(URL, b); }; HTMLAnchorElement.prototype.click = function () { /* the export's download link: no file is written in a test */ };
            $('#bookingsListContainer .bk-select-cb').prop('checked', false);
            ids.forEach(id => $('#bookingsListContainer .bk-select-cb[data-id="' + id + '"]').prop('checked', true));
            document.getElementById('bkBulkExport').click();
            URL.createObjectURL = orig; delete HTMLAnchorElement.prototype.click;
            return blob ? await blob.text() : null;
        }, ids);
        const parseCsv = (s) => s.trim().split('\n').map(l => l.split(','));
        let csvText = await csvOf([bF, bR]);
        let rowsCsv = csvText ? parseCsv(csvText) : [];
        const hdr = rowsCsv[0] || [], iT = hdr.indexOf('total_amount'), iO = hdr.indexOf('amount_outstanding'), iB = hdr.indexOf('amount_basis');
        const cF = rowsCsv.find(r => r[0] === String(bF)), cR = rowsCsv.find(r => r[0] === String(bR));
        ok(!!cF && !!cR && iB > -1 && cF[iT] === '' && cF[iO] === '' && cF[iB] === 'No quotation yet' && cR[iT] === '' && cR[iB] === 'No quotation yet', 'bulk CSV: unquoted bookings export blank total / outstanding and the basis "No quotation yet"', JSON.stringify([hdr, cF, cR]));

        // Reconciliation screen: the enquiry is "Not quoted", not a R5,000 quotation
        await p.evaluate(() => window.loadReconciliation());
        await p.waitForFunction((id) => !!document.querySelector('#reconTableBody tr[data-booking-id="' + id + '"]'), { timeout: 20000 }, bF);
        const reconF = await p.evaluate((id) => { const tr = document.querySelector('#reconTableBody tr[data-booking-id="' + id + '"]'); return { quoted: tr.querySelector('[data-label="Quoted"]').textContent.trim(), out: tr.querySelector('[data-label="Outstanding"]').textContent.trim() }; }, bF);
        ok(reconF.quoted === 'Not quoted' && reconF.out === '—', 'Reconciliation: an unquoted booking reads "Not quoted" / "—", not R5,000.00', JSON.stringify(reconF));

        // ═══════════ Quote Builder: where each amount comes from ═══════════
        // (a) NEVER quoted + rate raised after the booking was made -> the CURRENT catalogue fee, and no "already has a quote" prompt
        const zz = await mkSvc({ default_price: 1000 });
        const bP = await mkBooking('QB Prefill', [{ service_id: zz }]);
        const zzRow = ((await api('GET', '/api/admin/services')).body || []).find(s => s.id === zz);
        await api('PUT', `/api/admin/services/${zz}`, { ...zzRow, default_price: 1500, is_deleted: 0, is_active: true });
        await openBuilder(p, bP, 1);
        let rows = await builderRows(p);
        ok(rows.length === 1 && rows[0].price === '1500' && rows[0].qr === '0', 'builder (never quoted): the line is pre-filled with the CURRENT catalogue fee (R1,500), not the R1,000 estimate taken at booking time', JSON.stringify(rows));
        let msg = await sendQuote(p, await expiryFor(bP));
        ok(/Quote sent successfully/.test(msg) && p._reqs.length === 1, 'builder (never quoted): the quote is sent', JSON.stringify({ msg, r: p._reqs.length }));
        ok((await confirms(p)).length === 0, 'builder (never quoted): NO "already has a quote" prompt for a first quote (it used to fire for every booking that held the estimate)', JSON.stringify(await confirms(p)));
        let ql = await q('SELECT unit_price FROM quote_line_items WHERE quotation_id = (SELECT id FROM quotations WHERE booking_id = ? ORDER BY id DESC LIMIT 1)', [bP]);
        ok(ql.length === 1 && ql[0].unit_price === 1500, 'builder (never quoted): the saved quote line is R1,500', JSON.stringify(ql));

        // (b) HAS a quote + rate raised again -> the SAVED quote amount, and the "new version" prompt does appear
        const zzRow2 = ((await api('GET', '/api/admin/services')).body || []).find(s => s.id === zz);
        await api('PUT', `/api/admin/services/${zz}`, { ...zzRow2, default_price: 2000, is_deleted: 0, is_active: true });
        await openBuilder(p, bP, 1);
        rows = await builderRows(p);
        ok(rows.length === 1 && rows[0].price === '1500', 'builder (already quoted): a revision starts from the SAVED quote (R1,500), not today\'s catalogue fee (R2,000)', JSON.stringify(rows));
        msg = await sendQuote(p, await expiryFor(bP));
        ok(/Quote sent successfully/.test(msg) && (await confirms(p)).includes('Create New Quote Version?'), 'builder (already quoted): the "Create New Quote Version?" prompt appears, and the revision is sent', JSON.stringify({ msg, c: await confirms(p) }));
        const versions = await q('SELECT version, archived, total_amount FROM quotations WHERE booking_id = ? ORDER BY version', [bP]);
        ok(versions.map(v => `${v.version}:${v.archived}:${v.total_amount}`).join(',') === '1:1:1500,2:0:1500', 'builder (already quoted): version 2 supersedes version 1, both at R1,500', JSON.stringify(versions));

        // (c) a range service: empty, hinted, blocked until an amount is typed - and no prompt
        await openBuilder(p, bR, 1);
        rows = await builderRows(p);
        ok(rows.length === 1 && rows[0].price === '' && rows[0].qr === '1' && /R90,000 – R140,000 per month/.test(rows[0].hint) && rows[0].placeholder === 'Agreed amount', 'builder (range): the line has NO amount, shows the published band and asks for the agreed amount', JSON.stringify(rows));
        msg = await sendQuote(p, await expiryFor(bR));
        ok(/Enter the agreed amount for: .*Head Writer/.test(msg) && p._reqs.length === 0, 'builder (range): sending is blocked with a clear message and nothing is posted', JSON.stringify({ msg, r: p._reqs.length }));
        await setRow(p, 0, '.qb-price', '100000');
        msg = await sendQuote(p, await expiryFor(bR));
        ok(/Quote sent successfully/.test(msg) && (await confirms(p)).length === 0, 'builder (range): with the agreed amount the quote is sent (and there was no "already has a quote" prompt)', JSON.stringify({ msg, c: await confirms(p) }));
        ok((await q('SELECT total_amount FROM quotations WHERE booking_id = ?', [bR]))[0].total_amount === 100000, 'builder (range): the quote total is exactly the agreed R100,000', '');

        // (d) the mixed booking: the fixed line pre-filled, the "from" line empty
        await openBuilder(p, bM, 2);
        rows = await builderRows(p);
        const mClub = rows.find(r => /10 min Set/.test(r.desc)), mCombo = rows.find(r => /Combo/.test(r.desc));
        ok(mClub && mClub.price === '5000' && mCombo && mCombo.price === '' && mCombo.qr === '1' && /From R50,000/.test(mCombo.hint), 'builder (mixed): the fixed line carries R5,000, the "from" line is empty with its published "From R50,000" hint', JSON.stringify(rows));
        await shot(p, '03-builder-mixed');
        await p.evaluate(() => window.closeQuoteDrawer());

        // (e) preview == the number the server stores: taxable + exempt lines, qty 2, discount, VAT
        const bV = await mkBooking('QB Totals', [{ service_id: sClub }, { service_id: sTravel }, { service_id: sNight }]);
        await openBuilder(p, bV, 3);
        rows = await builderRows(p);
        ok(rows.map(r => r.taxClass).join(',') === 'standard,exempt,exempt' && rows.map(r => r.price).join(',') === '5000,2500,2200', 'builder (totals): lines carry their tax class (standard, exempt, exempt) and catalogue fees', JSON.stringify(rows));
        await setRow(p, 2, '.qb-qty', '2');
        await setField(p, '#qbDiscount', '900');
        await p.evaluate(() => { const c = document.getElementById('qbApplyVat'); c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); });
        await sleep(300);
        let t = await totals(p);
        ok(t.sub === '11900.00' && t.vat === '693.28' && t.total === '11693.28', 'builder (totals): live preview = subtotal 11900.00, VAT 693.28 (taxable line only), total 11693.28', JSON.stringify(t));
        rows = await builderRows(p);
        ok(/^4[\s  ,.]?400[,.]00$/.test(rows[2].total), 'builder (totals): the accommodation line x2 shows R4,400.00 (row totals use the en-ZA format, "4 400,00")', JSON.stringify(rows[2]));
        await p.evaluate(() => { const c = document.getElementById('qbApplyVat'); c.checked = false; c.dispatchEvent(new Event('change', { bubbles: true })); });
        await sleep(200);
        t = await totals(p);
        ok(t.vat === '0.00' && t.total === '11000.00', 'builder (totals): with VAT off the preview is 11000.00 and VAT 0.00', JSON.stringify(t));
        await p.evaluate(() => { const c = document.getElementById('qbApplyVat'); c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); });
        await sleep(200);
        await shot(p, '04-builder-totals');
        msg = await sendQuote(p, await expiryFor(bV));
        const stored = await one('SELECT total_amount FROM quotations WHERE booking_id = ?', [bV]);
        const sd = JSON.parse((await one('SELECT quote_details FROM bookings WHERE id = ?', [bV])).quote_details);
        ok(/Quote sent successfully/.test(msg) && stored.total_amount === 11693.28 && sd.vat === 693.28 && sd.subtotal === 11900, 'builder (totals): the server stored EXACTLY what the preview showed (R11,693.28, VAT 693.28)', JSON.stringify({ msg, stored, v: sd.vat }));
        ok(JSON.stringify(JSON.parse(p._reqs[0].body).items.map(i => Object.keys(i).includes('tax_class'))) === '[false,false,false]', 'builder (totals): the browser does not send a tax class - the server decides it from the catalogue', p._reqs[0].body.slice(0, 300));

        // The Deal View's Quote card and Invoice card show the VAT the server STORED with the quotation (R693.28), not a flat 15% of
        // everything rounded to whole rand (R1,650) - which contradicted the stored total printed beneath it whenever a line was exempt.
        const storedQd = (await one('SELECT quote_details FROM bookings WHERE id = ?', [bV])).quote_details;
        const cardText = await p.evaluate((qd) => {
            const text = (html) => $('<div>').html(html).text().replace(/\s+/g, ' ');
            return { quote: text(formatQuoteDetailsAtelier(qd, '11693.28', '2030-01-01', 0, null)), invoice: text(formatInvoiceDetailsAtelier(qd, '11693.28', 'INV-X', 'SENT', 0, 0, null, 'UNPAID')),
                     panel: text(formatQuoteDetails(qd)),
                     legacy: text(formatQuoteDetailsAtelier(JSON.stringify({ items: [{ description: 'Old', quantity: 1, unit_price: 1000, tax_class: 'standard' }], apply_vat: true, discount: 0 }), '1150.00', '', 0, null)),
                     // manual adjustments logged since the quotation: the booking total differs from the quoted total by exactly that
                     credit: text(formatInvoiceDetailsAtelier(qd, '10693.28', 'INV-X', 'DRAFT', 0, 0, null, 'UNPAID')),
                     debit: text(formatInvoiceDetailsAtelier(qd, '12193.28', 'INV-X', 'DRAFT', 0, 0, null, 'UNPAID')) };
        }, storedQd);
        // (table cells are read without separators, so "VAT (15%)R 693.28")
        ok(/VAT \(15%\)\s*R 693\.28/.test(cardText.quote) && /Total\s*R 11693\.28/.test(cardText.quote) && !/1650/.test(cardText.quote), 'Deal View Quote card: VAT is the stored R693.28 beside the stored total R11693.28 (no recomputed R1650)', cardText.quote);
        ok(/VAT \(15%\)\s*R 693\.28/.test(cardText.invoice) && !/1650/.test(cardText.invoice), 'Deal View Invoice card: the same stored VAT', cardText.invoice);
        ok(/VAT \(15%\): R 693\.28/.test(cardText.panel), 'the "Quote Sent" panel agrees', cardText.panel);
        ok(/VAT \(15%\)\s*R 150\.00/.test(cardText.legacy), 'a legacy record with no stored VAT is recomputed with the shared function (R150.00, cents kept)', cardText.legacy);
        // Manual adjustments: the card's lines are the approved quotation, the Total is what the booking now carries - so the difference is
        // its own row (and no row at all when they agree), and VAT stays as quoted.
        ok(/VAT \(15%\)\s*R 693\.28\s*Manual adjustments\s*–R 1000\.00\s*Total\s*R 10693\.28/.test(cardText.credit), 'Deal View Invoice card: a R1,000 credit logged since the quotation is its own "Manual adjustments" row between VAT and the Total, so the card still adds up (VAT unchanged at R693.28)', cardText.credit);
        ok(/Manual adjustments\s*\+R 500\.00\s*Total\s*R 12193\.28/.test(cardText.debit), 'Deal View Invoice card: a R500 debit shows as "+R 500.00"', cardText.debit);
        ok(!/Manual adjustments/.test(cardText.invoice), 'Deal View Invoice card: no adjustments row when the booking total is the quoted total', cardText.invoice);

        // (f) quick-add uses the catalogue fee (base_price override included); a range service added by quick-add starts empty
        const zzBase = await mkSvc({ default_price: 1000, base_price: 1200 });
        const bQ = await mkBooking('QB QuickAdd', [{ service_id: sClub }]);
        await openBuilder(p, bQ, 1);
        await p.evaluate((id) => { const s = document.getElementById('qbServiceSelector'); s.value = String(id); s.dispatchEvent(new Event('change', { bubbles: true })); }, zzBase);
        await sleep(500);
        rows = await builderRows(p);
        ok(rows.length === 2 && rows[1].price === '1200', 'quick add: a service with a booking-rate override (base_price R1,200) is added at R1,200, not the R1,000 default', JSON.stringify(rows));
        await p.evaluate((id) => { const s = document.getElementById('qbServiceSelector'); s.value = String(id); s.dispatchEvent(new Event('change', { bubbles: true })); }, sHead);
        await sleep(500);
        rows = await builderRows(p);
        ok(rows.length === 3 && rows[2].price === '' && rows[2].qr === '1', 'quick add: a range service is added with NO amount', JSON.stringify(rows[2]));
        const optLabel = await p.evaluate(() => [...document.querySelectorAll('#qbServiceSelector option')].find(o => /10 min Set/.test(o.textContent)).textContent);
        ok(/R5,000/.test(optLabel), 'quick add: the selector shows the published price label', optLabel);
        await p.evaluate(() => window.closeQuoteDrawer());

        // (f2) the terms text. The builder keeps a "50% Deposit (R ...) required ... / Balance Due: R ..." summary at the top and rebuilds it on
        // every change. It used to strip only the first three words of the old summary ("50% Deposit"), so each edit left a fragment behind
        // (six after four edits) - and, because the owner's own payment-terms policy usually begins with the same words, it ate those too.
        // The terms go on the quotation PDF and the client's email.
        const POLICY_PAYMENT = '50% Deposit required to secure the booking. Balance due 48 hours prior to the event.';
        await p.evaluate((pay) => { $('#polDeposit').val('50'); $('#polPaymentTerms').val(pay); $('#polCancellation').val('Cancellations less than 14 days before the event forfeit the deposit.'); }, POLICY_PAYMENT);
        const bT = await mkBooking('QB Terms', [{ service_id: sClub }]);
        await openBuilder(p, bT, 1);
        const policyOnly = (await p.evaluate(() => $('#quoteDrawer').data('qb-global-terms'))).trim();
        const termsNow = () => p.evaluate(() => document.getElementById('quoteModalDetails').value);
        const nDeposit = (s) => (s.match(/% Deposit \(R/g) || []).length, nBalance = (s) => (s.match(/Balance Due:/g) || []).length;
        const SUMMARY = /^50% Deposit \(R [^)\n]+\) required to secure the booking\.\nBalance Due: R [^\n]+\n\n/;
        let terms = await termsNow();
        const opening = terms;
        ok(SUMMARY.test(terms) && nDeposit(terms) === 1 && nBalance(terms) === 1, 'terms: the deposit / balance summary appears once when the builder opens', JSON.stringify(terms.slice(0, 260)));
        ok(terms.replace(SUMMARY, '') === policyOnly, 'terms: everything after the summary is exactly the owner\'s policy wording - nothing is stripped out of it', JSON.stringify({ got: terms.replace(SUMMARY, ''), want: policyOnly }));
        // four rounds of edits: amounts, then the deposit percentage
        let piled = [];
        for (const [field, sel, v] of [['row', '.qb-price', '6000'], ['row', '.qb-price', '7000'], ['field', '#qbDepositPercentage', '30'], ['field', '#qbDepositPercentage', '40']]) {
            if (field === 'row') await setRow(p, 0, sel, v); else await setField(p, sel, v);
            const s = await termsNow();
            piled.push([nDeposit(s), nBalance(s), (s.match(/required to secure the booking/g) || []).length]);
        }
        terms = await termsNow();
        ok(piled.every(x => x[0] === 1 && x[1] === 1 && x[2] === 2), 'terms: after four edits there is still ONE summary (one "Deposit", one "Balance Due") and the policy\'s own sentence - no fragments left behind', JSON.stringify(piled) + ' ' + JSON.stringify(terms));
        ok(/^40% Deposit \(R [^)\n]+\)/.test(terms) && terms.replace(/^40% Deposit \(R [^)\n]+\) required to secure the booking\.\nBalance Due: R [^\n]+\n\n/, '') === policyOnly, 'terms: the summary shows the CURRENT percentage (40%) and the policy beneath it is still exactly as the owner wrote it', JSON.stringify(terms));
        await setRow(p, 0, '.qb-price', '5000'); await setField(p, '#qbDepositPercentage', '50');
        ok(await termsNow() === opening, 'terms: back at the starting amount and percentage the text is IDENTICAL to when the builder opened (same inputs, same text, however many edits came between)', JSON.stringify(await termsNow()));
        await setField(p, '#qbDepositPercentage', '0');
        ok(await termsNow() === policyOnly, 'terms: with no deposit the summary goes and only the owner\'s policy remains', JSON.stringify(await termsNow()));
        await setField(p, '#qbDepositPercentage', '50');
        ok(await termsNow() === opening, 'terms: and it comes back, once, when a deposit is set again', JSON.stringify(await termsNow()));
        // text the owner typed into the terms box survives the rebuild
        await p.evaluate(() => { const e = document.getElementById('quoteModalDetails'); e.value = e.value + '\n\nSpecial clause: load-in from 14:00.'; });
        await setRow(p, 0, '.qb-price', '5500');
        terms = await termsNow();
        ok(nDeposit(terms) === 1 && nBalance(terms) === 1 && (terms.match(/Special clause: load-in from 14:00\./g) || []).length === 1 && terms.endsWith('Special clause: load-in from 14:00.'), 'terms: a clause the owner typed is kept, once, and the summary is still single', JSON.stringify(terms));
        // switching the terms source to the milestones and back rebuilds from the stored text, not from a mangled one
        await p.evaluate(() => { const r = document.getElementById('qbRadioLocal'); r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); });
        await p.evaluate(() => { const r = document.getElementById('qbRadioGlobal'); r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); });
        await setRow(p, 0, '.qb-price', '5000');
        ok(await termsNow() === opening, 'terms: switching to the payment-milestone terms and back gives the original text again', JSON.stringify(await termsNow()));
        await shot(p, '03b-builder-terms');
        await p.evaluate(() => window.closeQuoteDrawer());

        // (g) a service retired since the booking was made still behaves (price, tax class, no quote-required flag)
        const zzOld = await mkSvc({ default_price: 800, tax_class: 'exempt' });
        const bO = await mkBooking('QB Retired', [{ service_id: zzOld }]);
        const zzOldRow = ((await api('GET', '/api/admin/services')).body || []).find(s => s.id === zzOld);
        await api('PUT', `/api/admin/services/${zzOld}`, { ...zzOldRow, is_active: false, is_deleted: 0 });
        ok(!((await api('GET', '/api/admin/services?active_only=1')).body || []).some(s => s.id === zzOld), 'fixture: the service is no longer in the active catalogue', '');
        await openBuilder(p, bO, 1);
        rows = await builderRows(p);
        ok(rows.length === 1 && rows[0].price === '800' && rows[0].taxClass === 'exempt' && rows[0].qr === '0', 'builder (retired service): the line keeps its fee (R800) and its VAT-exempt class from the booking\'s own service row', JSON.stringify(rows));
        await p.evaluate(() => { const c = document.getElementById('qbApplyVat'); c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); });
        await sleep(200);
        t = await totals(p);
        ok(t.vat === '0.00' && t.total === '800.00', 'builder (retired service): VAT is not added to the exempt line (total stays 800.00)', JSON.stringify(t));
        await p.evaluate(() => window.closeQuoteDrawer());

        // (h) a service renamed since the booking: a REVISION keeps the description the client was quoted under, a first quote uses today's name
        const nmOld = `ZZ-QB Old ${Date.now().toString(36)}`, nmNew = `ZZ-QB Renamed ${Date.now().toString(36)}`;
        const zzRename = await mkSvc({ name: nmOld, default_price: 700 });
        const bRq = await mkBooking('QB Renamed Quoted', [{ service_id: zzRename }]);
        const bRn = await mkBooking('QB Renamed Never', [{ service_id: zzRename }]);
        await api('POST', `/api/admin/bookings/${bRq}/quote`, { quote_expiry_date: await expiryFor(bRq), terms: 'T', apply_vat: false, discount: 0, items: [{ service_id: zzRename, description: 'Headline set as quoted', quantity: 1, unit_price: 700, pricing_model: 'flat_fee' }] });
        const rnRow = ((await api('GET', '/api/admin/services')).body || []).find(s => s.id === zzRename);
        await api('PUT', `/api/admin/services/${zzRename}`, { ...rnRow, name: nmNew, is_deleted: 0, is_active: true });
        await openBuilder(p, bRq, 1);
        rows = await builderRows(p);
        ok(rows.length === 1 && rows[0].desc === 'Headline set as quoted' && rows[0].price === '700', 'builder (revision after a rename): the line keeps the description it was quoted under, at the quoted R700', JSON.stringify(rows));
        await p.evaluate(() => window.closeQuoteDrawer());
        await openBuilder(p, bRn, 1);
        rows = await builderRows(p);
        ok(rows.length === 1 && rows[0].desc === nmNew && rows[0].price === '700', 'builder (first quote after a rename): the line uses the service\'s current name and current fee', JSON.stringify(rows));
        await p.evaluate(() => window.closeQuoteDrawer());
        await gotoBookings(p, 'BQ QB Renamed');
        await p.evaluate((id) => window.toggleBookingDetail(id), bRq);
        await p.waitForFunction((id) => { const e = document.getElementById('atl-lineitems-' + id); return e && /Line items/.test(e.textContent) && !/Loading/i.test(e.textContent); }, { timeout: 20000 }, bRq);
        const dvLines = await p.evaluate((id) => document.getElementById('atl-lineitems-' + id).textContent.replace(/\s+/g, ' '), bRq);
        ok(/Headline set as quoted/.test(dvLines) && !dvLines.includes(nmNew), 'Deal View line items after a rename: the booking is described as it was quoted, never under the new name', dvLines);
        await p.evaluate(() => window.closeAtlDrawer('dealViewDrawer'));

        // The quote links the Deal View shows must OPEN. The Files tab chip ("Quote v2 - Active") and the history list's "View PDF" used to
        // point at /docs/quotes/<file>.pdf - a path the site refuses outright ("Forbidden: Direct access to this file/directory is
        // restricted."). bP has two quotation versions, so the history list is shown as well as the chip.
        await gotoBookings(p, 'BQ QB Prefill');
        await p.evaluate((id) => window.toggleBookingDetail(id), bP);
        await p.waitForFunction((id) => !!document.querySelector('#atl-filedocs-qc-' + id + ' a.dv-file') && !!document.querySelector('#atl-history-' + id + ' a'), { timeout: 25000 }, bP);
        const quoteLinks = await p.evaluate(async () => {
            const hrefs = [...new Set([...document.querySelectorAll('#dealViewDrawer a[href*="/quote"]')].map(a => a.getAttribute('href')))];
            const out = [];
            for (const h of hrefs) { const r = await fetch(h, { credentials: 'same-origin' }); out.push({ href: h, status: r.status, type: r.headers.get('content-type') || '' }); }
            return out;
        });
        ok(quoteLinks.length >= 3 && quoteLinks.every(l => !/^\/docs\//.test(l.href) && l.status === 200 && /^application\/pdf/.test(l.type)),
            'Deal View: every quote link it shows (the Files tab chip, both versions in the history list, the quote card) opens a PDF - none points at the blocked /docs/ path', JSON.stringify(quoteLinks));
        await p.evaluate(() => window.closeAtlDrawer('dealViewDrawer'));

        // ═══════════ The Bookings screen after quoting ═══════════
        await gotoBookings(p, 'BQ QS');
        await api('POST', `/api/admin/bookings/${bF}/quote`, { quote_expiry_date: await expiryFor(bF), terms: 'T', apply_vat: false, discount: 0, items: [{ service_id: sClub, description: 'Club set', quantity: 1, unit_price: 5000, pricing_model: 'flat_fee' }] });
        await p.evaluate(() => window.loadBookings()); await sleep(1500);
        await p.evaluate(() => { $('#bkSearchInput').val('BQ QS'); window.applyBookingFilter(); }); await sleep(300);
        const after = await rowInfo(p, bF);
        ok(after && after.fee === 'R 5000.00' && !/est\./.test(after.fee) && /Accept/.test(after.actions), 'after quoting: the Fee column shows the quoted total with no "est.", and the action moves on to Accept', JSON.stringify(after));
        // ...and once quoted, the very same screens show the amounts
        const openFin2 = async (id) => { await p.evaluate((id) => { const b = document.createElement('button'); b.className = 'bk-action-financials'; b.setAttribute('data-id', id); document.body.appendChild(b); b.click(); b.remove(); }, id); await sleep(500); return p.evaluate(() => ({ total: $('#bf-total').text(), out: $('#bf-outstanding').text() })); };
        const fin2 = await openFin2(bF);
        ok(fin2.total === 'R 5000.00' && fin2.out === 'R 5000.00', 'Financial Controls: once quoted, Total and Outstanding show R5,000.00', JSON.stringify(fin2));
        const csv2 = await p.evaluate(async (id) => {
            let blob = null; const orig = URL.createObjectURL; URL.createObjectURL = (b) => { blob = b; return orig.call(URL, b); }; HTMLAnchorElement.prototype.click = function () { /* the export's download link: no file is written in a test */ };
            $('#bookingsListContainer .bk-select-cb').prop('checked', false);
            $('#bookingsListContainer .bk-select-cb[data-id="' + id + '"]').prop('checked', true);
            document.getElementById('bkBulkExport').click();
            URL.createObjectURL = orig; delete HTMLAnchorElement.prototype.click;
            return blob ? await blob.text() : null;
        }, bF);
        const rows2 = csv2 ? csv2.trim().split('\n').map(l => l.split(',')) : [];
        const h2 = rows2[0] || [], c2 = rows2.find(r => r[0] === String(bF)) || [];
        ok(c2[h2.indexOf('total_amount')] === '5000' && c2[h2.indexOf('amount_basis')] === 'Quoted', 'bulk CSV: once quoted the booking exports its 5000 with the basis "Quoted"', JSON.stringify([h2, c2]));
        await p.evaluate(() => window.loadReconciliation());
        await p.waitForFunction((id) => { const tr = document.querySelector('#reconTableBody tr[data-booking-id="' + id + '"]'); return tr && !/Not quoted/.test(tr.textContent); }, { timeout: 20000 }, bF);
        const reconF2 = await p.evaluate((id) => document.querySelector('#reconTableBody tr[data-booking-id="' + id + '"] [data-label="Quoted"]').textContent.replace(/\s+/g, ' ').trim(), bF);
        ok(/5\s?000/.test(reconF2), 'Reconciliation: once quoted the booking shows its R5,000.00', reconF2);
        ok(p._errs.length === 0, 'no page errors on the admin screens', JSON.stringify(p._errs));
        await p.close();

        // ═══════════ Public homepage: five cards ═══════════
        const site = await (await fetch(`${BASE}/api/public/site-content`)).json();
        const storedCards = (site.services && site.services.items) || [];
        const widths = [[1440, 900, 'desktop-wide'], [1100, 900, 'desktop-small'], [820, 900, 'tablet'], [390, 844, 'phone']];
        const pubErrs = [];
        for (const [w, h, label] of widths) {
            const ctx = await browser.createBrowserContext();
            const pp = await ctx.newPage();
            await pp.setViewport({ width: w, height: h });
            pp.on('pageerror', e => pubErrs.push(label + ': ' + e.message.slice(0, 160)));
            pp.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) pubErrs.push(label + ': console: ' + m.text().slice(0, 140)); });
            await pp.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
            await sleep(2500);
            await pp.evaluate(() => { const x = document.getElementById('cookieRejectAll'); if (x && x.offsetParent) x.click(); });
            // Unrelated to the cards: this machine's database points the branding favicon at a file that is not in images/branding, and
            // applyBranding's probe of it (a fetch, 404) makes the site's global fetch wrapper raise its full-page "404 Page Not Found"
            // overlay on every load. Dismissed here so the screenshots and click tests see the page itself.
            await pp.evaluate(() => { const r = window.notificationService && window.notificationService.httpErrorRoot; if (r) r.classList.remove('is-active'); document.body.style.overflow = ''; });
            await pp.evaluate(() => { document.querySelector('.tm-services').scrollIntoView(); document.querySelectorAll('.tm-reveal').forEach(e => e.classList.add('is-visible', 'in-view', 'visible', 'tm-reveal--in')); });
            await sleep(1200);
            const g = await pp.evaluate(() => {
                const cards = [...document.querySelectorAll('.tm-services__grid .tm-service')];
                const rects = cards.map(c => { const r = c.getBoundingClientRect(); return { l: Math.round(r.left), t: Math.round(r.top + window.scrollY), w: Math.round(r.width), h: Math.round(r.height), b: Math.round(r.bottom + window.scrollY) }; });
                return {
                    n: cards.length, rects, overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
                    titles: cards.map(c => c.querySelector('.tm-service__title').textContent.trim()),
                    descs: cards.map(c => c.querySelector('.tm-service__desc').textContent.trim()),
                    tags: cards.map(c => (c.querySelector('.tm-service__tag') || {}).textContent || ''),
                    contentFits: cards.map(c => { const cr = c.getBoundingClientRect(), t = c.querySelector('.tm-service__content').getBoundingClientRect(); return t.top >= cr.top - 1 && t.bottom <= cr.bottom + 1; }),
                    tagVisible: cards.map(c => { const tg = c.querySelector('.tm-service__tag'); if (!tg) return null; const tr = tg.getBoundingClientRect(), cr = c.getBoundingClientRect(); return tr.left >= cr.left && tr.right <= cr.right && tr.width > 0; }),
                    text: document.querySelector('.tm-services').textContent
                };
            });
            ok(g.n === 5 && !g.overflowX, `homepage ${label} (${w}px): five cards, no horizontal scroll`, JSON.stringify({ n: g.n, ox: g.overflowX }));
            const expectTitles = [0, 1, 2, 3, 4].map(i => (storedCards[i] && storedCards[i].title) || null);
            ok(JSON.stringify(g.titles) === JSON.stringify(expectTitles.map((t, i) => t || g.titles[i])) && g.titles.length === 5, `homepage ${label}: card titles are the stored/shipped rate-card category names`, JSON.stringify({ t: g.titles, s: expectTitles }));
            ok(g.tags.filter(Boolean).length === 1 && g.tags[1] === 'Most Booked' && g.tagVisible[1] === true, `homepage ${label}: "Most Booked" sits on Corporate & Events only and fits inside its card`, JSON.stringify({ tags: g.tags, v: g.tagVisible }));
            ok(!/R\s?\d|\bZAR\b|from R|enquire/i.test(g.text), `homepage ${label}: no price or price word anywhere in the section`, g.text.replace(/\s+/g, ' ').slice(0, 300));
            ok(g.contentFits.every(Boolean), `homepage ${label}: every card's title and text fit inside the card`, JSON.stringify({ f: g.contentFits, r: g.rects }));
            const R = g.rects;
            if (label === 'desktop-wide') ok(R.every(r => Math.abs(r.t - R[0].t) <= 2), 'homepage desktop-wide: all five cards in ONE row', JSON.stringify(R));
            if (label === 'desktop-small') ok(Math.abs(R[0].t - R[1].t) <= 2 && Math.abs(R[1].t - R[2].t) <= 2 && R[3].t > R[0].t + 50 && Math.abs(R[3].t - R[4].t) <= 2 && R[3].l > R[0].l && R[4].l + R[4].w < R[2].l + R[2].w + 2, 'homepage desktop-small: 3 + 2 with the second row centred', JSON.stringify(R));
            if (label === 'tablet') ok(R[1].t === R[0].t && R[2].t > R[0].t && R[3].t === R[2].t && R[4].t > R[3].t && R[4].w > R[0].w * 1.8, 'homepage tablet: two columns with the fifth card full width', JSON.stringify(R));
            if (label === 'phone') ok(R.every((r, i) => i === 0 || r.t > R[i - 1].t) && R.every(r => r.w > 300), 'homepage phone: one card per row', JSON.stringify(R));
            await shot(pp, `05-homepage-${label}`);
            if (label === 'desktop-wide') {
                // a card opens the booking drawer, records its source and preselects nothing
                const srcs = await pp.evaluate(() => [...document.querySelectorAll('.tm-services__grid .tm-service')].map(c => c.getAttribute('data-bk-source')));
                await pp.evaluate(() => document.querySelectorAll('.tm-services__grid .tm-service')[3].click());
                await sleep(1200);
                const opened = await pp.evaluate(() => ({ open: /atl-drawer--open|open/.test((document.getElementById('bookingDrawer') || {}).className || ''), src: window._bkSource, rows: document.querySelectorAll('#bkServicesTableBody tr').length }));
                ok(opened.open && opened.src === srcs[3] && opened.src === 'service-writing-creative' && opened.rows === 0, 'homepage: clicking "Writing & Creative Services" opens the booking drawer with that source recorded and no service pre-selected', JSON.stringify({ opened, srcs }));
            }
            await ctx.close();
        }
        ok(pubErrs.length === 0, 'no page errors on the public homepage at any width', JSON.stringify(pubErrs));
    } catch (e) {
        fails++;
        console.log('FAIL browser test crashed: ' + (e && e.stack || e));
    } finally {
        try { for (const id of createdSvc) await api('DELETE', `/api/admin/services/${id}`); } catch (e) { /* ignore */ }
        if (browser) await browser.close();
        await support.stop();
    }
    console.log(fails ? `\n${fails} check(s) FAILED` : '\nAll checks passed');
    process.exit(fails ? 1 : 0);
})();
