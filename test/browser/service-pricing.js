// Rate card 2026 (Phase 4): the admin Services screen, the public booking form's service list and the Quote Builder, driven
// through the REAL pages in headless Chrome on an isolated DB copy (test/support.js - SMTP mocked, the real database is never touched).
//   admin Services: price labels, group pills, Most Booked, filters, search, the validity banner, edit/save for every price type,
//                   the hourly minimum (1 hour), converting a priced-individually service to fixed, and that Save works at all
//                   (it used to throw on the commented-out Advanced panel);
//   public form:    services grouped as on the rate card ("Corporate & Events - Most Booked"), no price anywhere, no stored price on a row;
//   Quote Builder:  a range service's line starts with no amount + a published-band hint and cannot be sent until the agreed amount is entered.
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
    p.on('request', r => { if (/\/api\/admin\/(services|bookings\/\d+\/quote)/.test(r.url()) && r.method() !== 'GET') p._reqs.push({ method: r.method(), url: r.url().replace(BASE, ''), body: r.postData() || '' }); });
    const [name, ...rest] = cookie.split('=');
    await p.setCookie({ name, value: rest.join('='), url: BASE });
    await p.setRequestInterception(true);
    p.on('request', r => {
        if (/\/api\/admin\/maps-config/.test(r.url())) return r.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, key: '' }) });
        r.continue();
    });
    await p.goto(BASE + '/admin.html', { waitUntil: 'networkidle0', timeout: 90000 });
    await p.waitForFunction(() => typeof window.switchTab === 'function' && typeof window.loadAdminServices === 'function', { timeout: 30000 });
    // record every toast the page raises
    await p.evaluate(() => {
        window.__toasts = [];
        ['showError', 'showSuccess', 'showWarning', 'showInfo'].forEach(k => {
            const o = window.notificationService[k];
            window.notificationService[k] = function () { window.__toasts.push(k + ': ' + Array.prototype.join.call(arguments, ' | ')); return o.apply(this, arguments); };
        });
    });
    return p;
}

const shot = async (p, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await p.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: false }); } };
const set = (p, sel, val) => p.evaluate((s, v) => { const e = document.querySelector(s); e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); }, sel, val);
const toasts = (p) => p.evaluate(() => window.__toasts.slice());
const clearToasts = (p) => p.evaluate(() => { window.__toasts.length = 0; });
const cardCount = (p) => p.evaluate(() => document.querySelectorAll('#svcCardGrid .svc-card').length);
const cardByName = (p, name) => p.evaluate((n) => { const c = [...document.querySelectorAll('#svcCardGrid .svc-card')].find(x => x.querySelector('.svc-card__name').textContent.trim() === n); return c ? { id: c.getAttribute('data-id'), price: c.querySelector('.svc-card__price').textContent.replace(/\s+/g, ' ').trim(), text: c.textContent.replace(/\s+/g, ' ') } : null; }, name);
const idOf = async (name) => (await one('SELECT id FROM services WHERE name = ?', [name])).id;

async function gotoServices(p) {
    await p.evaluate(() => window.switchTab('servicesAdmin'));
    await sleep(400);
    await p.evaluate(() => window.loadAdminServices());
    await p.waitForFunction(() => document.querySelectorAll('#svcCardGrid .svc-card').length > 0, { timeout: 20000 });
    await sleep(300);
}

(async () => {
    await support.start();
    let browser;
    try {
        browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-quic'], executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined });
        const cookie = await adminCookie();
        // the boot-time rate-card migration may still be running when the server first answers
        for (let i = 0; i < 100; i++) { if (await one('SELECT 1 AS x FROM schema_migrations WHERE version = 106')) break; await sleep(100); }

        // ═══════════ Admin → Services ═══════════
        const p = await openAdmin(browser, cookie);
        await gotoServices(p);
        await shot(p, '01-services-list');

        ok((await cardCount(p)) >= 29, 'Services list renders the catalogue (23 rate-card services + add-ons)', String(await cardCount(p)));
        const banner = await p.evaluate(() => { const b = document.getElementById('svcRateCardBanner'); return { shown: !!(b && b.offsetParent), title: (document.getElementById('svcRcTitle') || {}).textContent, status: (document.getElementById('svcRcStatus') || {}).textContent, date: (document.getElementById('svcRcValidUntil') || {}).value, cls: b ? b.className : '' }; });
        ok(banner.shown && /Booking Kit 2026/.test(banner.title) && /Valid until 31 December 2026/.test(banner.status) && banner.date === '2026-12-31', 'rate-card banner shows the card, its validity and the editable date', JSON.stringify(banner));

        const pills = await p.evaluate(() => [...document.querySelectorAll('#svcCategoryPipeline .svc-cat-pill')].map(b => ({ g: b.getAttribute('data-group'), t: b.textContent.replace(/\s+/g, ' ').trim() })));
        ok(pills.length === 7 && pills[0].t.startsWith('All') && /Club & Theatre 4/.test(pills[1].t) && /Corporate & Events 7/.test(pills[2].t) && /Private Functions, Weddings & Year-End Events 3/.test(pills[3].t)
            && /Writing & Creative Services 6/.test(pills[4].t) && /Acting, Voice-Over & Brand Campaigns 3/.test(pills[5].t) && /Add-ons & other/.test(pills[6].t), 'group pills: All + the five rate-card groups with their counts + Add-ons & other', JSON.stringify(pills));
        ok(await p.evaluate(() => !!document.querySelector('#svcCategoryPipeline .svc-cat-pill[data-group="corporate_events"] .fa-star')), 'the Corporate & Events pill carries the Most Booked star', '');

        // price labels exactly as the rate card publishes them
        const expectLabels = {
            'Club – 10 min Set (Guest Spot)': 'R5,000', 'Corporate – 45–60 min Comedic Performance': 'R55,000', 'Private – Performance + MC Combo': 'From R50,000',
            'Writing – Copywriting / Roast Writing / Joke Pack': 'R12,000 – R25,000', 'Writing – Head Writer (per month)': 'R90,000 – R140,000 per month',
            'Writing – Film / Telenovela Script (per draft)': 'Enquire', 'Writing – Consultation': 'R2,500 per hour',
            'Acting – Per SAGA': 'Enquire – minimum R15,000 per session', 'Brand Campaign / Content Day Rate + Usage': 'From R60,000'
        };
        for (const [name, label] of Object.entries(expectLabels)) {
            const c = await cardByName(p, name);
            ok(!!c && c.price.startsWith(label), `card "${name}" shows ${label}`, c && c.price);
        }
        const quoted = await cardByName(p, 'Writing – Head Writer (per month)');
        ok(/Priced individually/.test(quoted.text), 'a range service says it is priced individually', quoted.text);
        ok(!/Priced individually/.test((await cardByName(p, 'Club – 10 min Set (Guest Spot)')).text), 'a fixed service does not', '');
        ok((await p.evaluate(() => document.querySelectorAll('#svcCardGrid .svc-tag--featured').length)) === 7, 'exactly 7 cards carry the Most Booked tag (Corporate & Events)', '');
        ok(!/R\s?0\.00/.test(await p.evaluate(() => document.getElementById('svcCardGrid').textContent)), 'no card shows a misleading "R 0.00"', '');

        // filters + search + sort
        await p.evaluate(() => document.querySelector('#svcCategoryPipeline .svc-cat-pill[data-group="corporate_events"]').click()); await sleep(200);
        ok((await cardCount(p)) === 7, 'Corporate & Events pill shows 7 services', String(await cardCount(p)));
        const names = await p.evaluate(() => [...document.querySelectorAll('#svcCardGrid .svc-card__name')].map(x => x.textContent.trim()));
        ok(names[0] === 'Corporate – 15 min Comedic Performance' && names[6].startsWith('Corporate – MC Duties Full Day'), 'cards are sorted by name within the group', JSON.stringify(names));
        await p.evaluate(() => window.clearSvcFilters()); await sleep(200);
        await set(p, '#svcPriceTypeFilter', 'range'); await sleep(200);
        ok((await cardCount(p)) === 4, 'price-type filter "Price range" shows the 4 ranges (copywriting, TV script, head writer, script editor)', String(await cardCount(p)));
        await set(p, '#svcPriceTypeFilter', 'enquire_min'); await sleep(200);
        ok((await cardCount(p)) === 2, 'price-type filter "Enquire, with minimum fee" shows the 2 minimum-fee services', String(await cardCount(p)));
        await p.evaluate(() => window.clearSvcFilters()); await sleep(200);
        await set(p, '#svcSearchInput', 'From R50,000'); await sleep(250);
        ok((await cardCount(p)) === 1 && (await cardByName(p, 'Private – Performance + MC Combo')) !== null, 'searching the price as shown ("From R50,000") finds the service', String(await cardCount(p)));
        await p.evaluate(() => window.clearSvcFilters()); await sleep(200);
        await p.evaluate(() => document.querySelector('#svcCategoryPipeline .svc-cat-pill[data-group="__none"]').click()); await sleep(200);
        const addons = await p.evaluate(() => [...document.querySelectorAll('#svcCardGrid .svc-card__name')].map(x => x.textContent.trim()));
        ok(addons.some(n => /Travel Buyout/.test(n)) && !addons.some(n => /^(Club|Corporate|Writing)/.test(n)), '"Add-ons & other" shows the travel / accommodation / rider add-ons only', JSON.stringify(addons));
        await p.evaluate(() => window.clearSvcFilters()); await sleep(200);

        // ── edit + save: a FIXED service (this used to throw "Cannot read properties of undefined (reading 'trim')") ──
        const fixedId = await idOf('Club – 10 min Set (Guest Spot)');
        await p.evaluate(id => window.editService(id), fixedId); await sleep(500);
        let st = await p.evaluate(() => ({ type: document.getElementById('svcPriceType').value, price: document.getElementById('svcPrice').value, fixedShown: !!document.getElementById('svcFixedPriceField').offsetParent,
            minShown: !!document.getElementById('svcPriceMinField').offsetParent, maxShown: !!document.getElementById('svcPriceMaxField').offsetParent, hint: document.getElementById('svcPriceTypeHint').textContent, group: document.getElementById('svcGroup').value }));
        ok(st.type === 'fixed' && st.price === '5000' && st.fixedShown && !st.minShown && !st.maxShown && /One catalogue fee/.test(st.hint) && st.group === 'club_theatre', 'editing a fixed service: type, price, group and only the price field shown', JSON.stringify(st));
        await shot(p, '02-edit-fixed');
        await set(p, '#svcPrice', '5100');
        const errsBefore = p._errs.length; p._reqs.length = 0; await clearToasts(p);
        await p.evaluate(() => window.saveService()); await sleep(1200);
        ok(p._reqs.some(r => r.method === 'PUT' && new RegExp('/api/admin/services/' + fixedId + '$').test(r.url)), 'Save sends the PUT (it used to throw before sending anything)', JSON.stringify(p._reqs));
        ok(p._errs.length === errsBefore, 'Save raises no page error', JSON.stringify(p._errs.slice(errsBefore)));
        ok((await toasts(p)).some(t => /showSuccess: Service saved successfully/.test(t)), 'success toast shown', JSON.stringify(await toasts(p)));
        ok((await cardByName(p, 'Club – 10 min Set (Guest Spot)')).price.startsWith('R5,100'), 'the card now shows the new price', '');
        ok(Number((await one('SELECT default_price FROM services WHERE id = ?', [fixedId])).default_price) === 5100, 'and it is saved in the database', '');
        ok(!(await p.evaluate(() => document.getElementById('svcDrawer').classList.contains('svc-drawer--open'))), 'the drawer closed after a successful save', '');

        // ── a RANGE service: both amounts shown, validation, save ──
        const rangeId = await idOf('Writing – Copywriting / Roast Writing / Joke Pack');
        await p.evaluate(id => window.editService(id), rangeId); await sleep(500);
        st = await p.evaluate(() => ({ type: document.getElementById('svcPriceType').value, price: document.getElementById('svcPrice').value, min: document.getElementById('svcPriceMin').value, max: document.getElementById('svcPriceMax').value,
            fixedShown: !!document.getElementById('svcFixedPriceField').offsetParent, minShown: !!document.getElementById('svcPriceMinField').offsetParent, maxShown: !!document.getElementById('svcPriceMaxField').offsetParent,
            modelDisabled: document.getElementById('svcPricingModel').disabled, minLabel: document.getElementById('svcPriceMinLabel').textContent }));
        ok(st.type === 'range' && st.price === '' && st.min === '12000' && st.max === '25000' && !st.fixedShown && st.minShown && st.maxShown && st.modelDisabled && /^From/.test(st.minLabel), 'editing a range service: no fixed price, From/To amounts shown, quantity basis locked', JSON.stringify(st));
        await shot(p, '03-edit-range');
        await set(p, '#svcPriceMin', '26000'); p._reqs.length = 0; await clearToasts(p);
        await p.evaluate(() => window.saveService()); await sleep(600);
        ok(p._reqs.length === 0 && (await toasts(p)).some(t => /first amount must be less than the second/.test(t)), 'a range whose first amount is not below the second is refused in the form (nothing sent)', JSON.stringify({ r: p._reqs, t: await toasts(p) }));
        await set(p, '#svcPriceMin', '13000'); await set(p, '#svcPriceMax', '26000'); await clearToasts(p);
        await p.evaluate(() => window.saveService()); await sleep(1200);
        ok((await cardByName(p, 'Writing – Copywriting / Roast Writing / Joke Pack')).price.startsWith('R13,000 – R26,000'), 'a valid range saves and the card shows the new band', '');
        const rr = await one('SELECT default_price, price_type, price_min, price_max FROM services WHERE id = ?', [rangeId]);
        ok(rr.price_type === 'range' && rr.price_min === 13000 && rr.price_max === 26000 && Number(rr.default_price) === 0, 'the database holds the band and NO fixed price', JSON.stringify(rr));

        // ── converting a priced-individually service to fixed needs a real price ──
        await p.evaluate(id => window.editService(id), rangeId); await sleep(400);
        await set(p, '#svcPriceType', 'fixed'); await sleep(100);
        ok(await p.evaluate(() => !!document.getElementById('svcFixedPriceField').offsetParent && document.getElementById('svcPrice').value === ''), 'switching the type to Fixed price shows an empty price field', '');
        p._reqs.length = 0; await clearToasts(p);
        await p.evaluate(() => window.saveService()); await sleep(500);
        ok(p._reqs.length === 0 && (await toasts(p)).some(t => /Enter the price/.test(t)), 'saving without naming the price is refused (nothing sent)', JSON.stringify({ r: p._reqs, t: await toasts(p) }));
        await p.evaluate(() => window.cancelServiceForm()); await sleep(300);

        // ── a NEW "starting price" service ──
        await p.evaluate(() => window.toggleServiceForm()); await sleep(500);
        await set(p, '#svcName', 'ZZ Browser From Service');
        await set(p, '#svcPriceType', 'from'); await sleep(100);
        st = await p.evaluate(() => ({ fixed: !!document.getElementById('svcFixedPriceField').offsetParent, min: !!document.getElementById('svcPriceMinField').offsetParent, max: !!document.getElementById('svcPriceMaxField').offsetParent, label: document.getElementById('svcPriceMinLabel').textContent }));
        ok(!st.fixed && st.min && !st.max && /Starting Price/.test(st.label), 'choosing "Starting price" shows one amount labelled Starting Price', JSON.stringify(st));
        await set(p, '#svcPriceMin', '3000'); await set(p, '#svcGroup', 'writing_creative');
        p._reqs.length = 0;
        await p.evaluate(() => window.saveService()); await sleep(1200);
        ok(p._reqs.some(r => r.method === 'POST') && (await cardByName(p, 'ZZ Browser From Service')).price.startsWith('From R3,000'), 'a new starting-price service is created and listed as "From R3,000"', JSON.stringify(p._reqs));

        // ── HOURLY: a 1 hour minimum saves (the old form forced 15) ──
        await p.evaluate(() => window.toggleServiceForm()); await sleep(500);
        await set(p, '#svcName', 'ZZ Browser Hourly Service');
        await set(p, '#svcPrice', '1800');
        await set(p, '#svcPricingModel', 'per_hour'); await sleep(150);
        st = await p.evaluate(() => ({ min: document.getElementById('svcMinQty').value, max: document.getElementById('svcMaxQty').value, minLabel: document.getElementById('svcMinQtyLabel').textContent, unit: document.getElementById('svcPriceUnit').value,
            unitDisabled: document.getElementById('svcPriceUnit').disabled, priceLabel: document.getElementById('svcPriceLabel').textContent }));
        ok(st.min === '1' && st.max === '8' && /hours/.test(st.minLabel) && st.unit === 'hour' && st.unitDisabled && /Rate per Hour/.test(st.priceLabel), 'choosing Per hour switches the limits to hours (1 / 8), fixes the unit to "per hour" and relabels the price', JSON.stringify(st));
        await shot(p, '04-new-hourly');
        p._reqs.length = 0; await clearToasts(p);
        await p.evaluate(() => window.saveService()); await sleep(1200);
        const hourly = await one("SELECT pricing_model, min_quantity, max_quantity, price_unit, display_unit FROM services WHERE name = 'ZZ Browser Hourly Service'");
        ok(p._reqs.some(r => r.method === 'POST') && hourly && hourly.pricing_model === 'per_hour' && hourly.min_quantity === 1 && hourly.max_quantity === 8 && hourly.price_unit === 'hour', 'an hourly service with a 1 hour minimum saves (previously blocked: "must be at least 15 minutes")', JSON.stringify({ r: p._reqs, hourly, t: await toasts(p) }));
        ok((await cardByName(p, 'ZZ Browser Hourly Service')).price.startsWith('R1,800 per hour'), 'and shows "R1,800 per hour"', '');
        const hid = await idOf('ZZ Browser Hourly Service');
        await p.evaluate(id => window.editService(id), hid); await sleep(500);
        st = await p.evaluate(() => ({ min: document.getElementById('svcMinQty').value, max: document.getElementById('svcMaxQty').value, model: document.getElementById('svcPricingModel').value }));
        ok(st.model === 'per_hour' && st.min === '1' && st.max === '8', 'reopening the hourly service shows its limits in hours', JSON.stringify(st));
        p._reqs.length = 0;
        await p.evaluate(() => window.saveService()); await sleep(1000);
        ok(p._reqs.some(r => r.method === 'PUT'), 'and it can be saved again without touching anything', JSON.stringify(p._reqs));
        // per-minute still needs 15
        await p.evaluate(() => window.toggleServiceForm()); await sleep(400);
        await set(p, '#svcName', 'ZZ Browser Per-Minute'); await set(p, '#svcPrice', '40'); await set(p, '#svcPricingModel', 'per_minute'); await set(p, '#svcMinQty', '5'); await sleep(100);
        p._reqs.length = 0; await clearToasts(p);
        await p.evaluate(() => window.saveService()); await sleep(500);
        ok(p._reqs.length === 0 && (await toasts(p)).some(t => /at least 15 minutes/.test(t)), 'a per-minute service still needs a 15 minute minimum', JSON.stringify({ r: p._reqs, t: await toasts(p) }));
        await p.evaluate(() => window.cancelServiceForm()); await sleep(300);

        // ── the rate-card validity date ──
        await set(p, '#svcRcValidUntil', '2027-12-31'); await clearToasts(p);
        await p.evaluate(() => window.saveRateCardValidity()); await sleep(900);
        const bn = await p.evaluate(() => ({ status: document.getElementById('svcRcStatus').textContent, cls: document.getElementById('svcRateCardBanner').className }));
        ok(/Valid until 31 December 2027/.test(bn.status) && !/expired|soon/.test(bn.cls) && (await toasts(p)).some(t => /Rate-card validity saved/.test(t)), 'saving a new validity date updates the banner and confirms', JSON.stringify(bn));
        await set(p, '#svcRcValidUntil', '2020-01-01');
        await p.evaluate(() => window.saveRateCardValidity()); await sleep(900);
        const bx = await p.evaluate(() => ({ status: document.getElementById('svcRcStatus').textContent, cls: document.getElementById('svcRateCardBanner').className }));
        ok(/svc-ratecard--expired/.test(bx.cls) && /Expired on/.test(bx.status), 'a validity date in the past turns the banner to "Expired"', JSON.stringify(bx));
        await shot(p, '05-banner-expired');
        await set(p, '#svcRcValidUntil', '2026-12-31'); await p.evaluate(() => window.saveRateCardValidity()); await sleep(600);

        // narrow screen: the cards and banner still fit
        await p.setViewport({ width: 390, height: 900 });
        await sleep(300);
        const fit = await p.evaluate(() => ['svcCardGrid', 'svcRateCardBanner'].map(id => { const e = document.getElementById(id); return e.scrollWidth <= e.clientWidth + 2; }));
        ok(fit.every(Boolean), 'phone width (390px): the service cards and the rate-card banner fit without sideways scrolling', JSON.stringify(fit));
        await shot(p, '06-services-390');
        await p.setViewport({ width: 1440, height: 1100 });
        ok(p._errs.length === 0, 'no page errors on the Services screen', JSON.stringify(p._errs));

        // ═══════════ Quote Builder: a range service has no amount until you enter one ═══════════
        const fixedSvc = await idOf('Club – 20 min Set (Support)');           // fixed R10,000
        const em = `svcbrowser.${Date.now()}@example.invalid`;
        const created = await api('POST', '/api/admin/bookings', {
            name: 'Browser QB', email: em, cell: '+27821234567', event_date: future(1300), event_name: 'QB Browser Event', event_type: 'Corporate', event_location: 'Test Hall',
            message: 'Quote builder browser test, over ten characters.', services: [{ service_id: fixedSvc }, { service_id: rangeId }], status: 'NEW', override_working_hours: true
        });
        const bid = created.body && created.body.booking_id;
        ok(!!bid, 'fixture: a booking with a fixed and a range service', JSON.stringify(created));
        const expiry = new Date(Date.parse(future(1300)) - 10 * 86400000).toISOString().slice(0, 10);
        p._reqs.length = 0;
        await p.evaluate((id) => { const b = document.createElement('button'); b.className = 'bk-action-quote'; b.setAttribute('data-id', id); b.id = 'zzOpenQuote'; document.body.appendChild(b); b.click(); }, bid);
        await p.waitForFunction(() => document.querySelectorAll('.qb-item-row').length >= 2, { timeout: 20000 });
        await sleep(600);
        const rows = await p.evaluate(() => [...document.querySelectorAll('.qb-item-row')].map(r => ({ desc: r.querySelector('.qb-desc').value, price: r.querySelector('.qb-price').value, qr: r.getAttribute('data-quote-required'),
            hint: (r.querySelector('.qb-quote-hint') || {}).textContent || '', placeholder: r.querySelector('.qb-price').placeholder })));
        const fixedRow = rows.find(r => /20 min Set/.test(r.desc)), rangeRow = rows.find(r => /Copywriting/.test(r.desc));
        ok(fixedRow && fixedRow.price === '10000' && fixedRow.qr === '0' && !fixedRow.hint, 'Quote Builder: the fixed service line is pre-filled with its fee', JSON.stringify(rows));
        ok(rangeRow && rangeRow.price === '' && rangeRow.qr === '1' && /R13,000 – R26,000/.test(rangeRow.hint) && /Enter the agreed amount/.test(rangeRow.hint) && rangeRow.placeholder === 'Agreed amount',
            'Quote Builder: the range service line has NO amount, shows its published band and asks for the agreed amount', JSON.stringify(rangeRow));
        await shot(p, '07-quote-builder');
        await set(p, '#quoteModalExpiry', expiry);
        p._reqs.length = 0;
        await p.evaluate(() => document.getElementById('quoteModalSendBtn').click()); await sleep(700);
        const msg1 = await p.evaluate(() => document.getElementById('quoteModalMsg').textContent);
        ok(/Enter the agreed amount for: .*Copywriting/.test(msg1) && p._reqs.length === 0, 'sending is blocked with a clear message while the range line has no amount (nothing posted)', JSON.stringify({ msg1, r: p._reqs }));
        await p.evaluate(() => { const row = [...document.querySelectorAll('.qb-item-row')].find(r => r.getAttribute('data-quote-required') === '1'); const i = row.querySelector('.qb-price'); i.value = '15000'; i.dispatchEvent(new Event('input', { bubbles: true })); });
        await sleep(200);
        // A booking that has never been quoted must NOT ask to confirm a new version (the old code did, because the catalogue estimate sat in
        // quote_amount). If that prompt ever comes back this stub records it and the check after the send fails.
        await p.evaluate(() => { window.__confirmTitles = []; window.notificationService.showConfirm = async (o) => { window.__confirmTitles.push((o && o.title) || ''); return true; }; });
        await p.evaluate(() => document.getElementById('quoteModalSendBtn').click());
        await p.waitForFunction(() => /Quote sent successfully/.test(document.getElementById('quoteModalMsg').textContent), { timeout: 30000 }).catch(() => {});
        const msg2 = await p.evaluate(() => document.getElementById('quoteModalMsg').textContent);
        ok(/Quote sent successfully/.test(msg2) && p._reqs.some(r => r.method === 'POST' && /\/quote$/.test(r.url)), 'with the agreed amount entered the quotation is sent', JSON.stringify({ msg2, r: p._reqs.map(x => x.url) }));
        ok((await p.evaluate(() => window.__confirmTitles)).length === 0, 'a first quote raises no "already has a quote" prompt', JSON.stringify(await p.evaluate(() => window.__confirmTitles)));
        const ql = await q('SELECT service_id, unit_price FROM quote_line_items WHERE quotation_id = (SELECT id FROM quotations WHERE booking_id = ? ORDER BY id DESC LIMIT 1) ORDER BY id', [bid]);
        ok(ql.length === 2 && ql.find(x => x.service_id === rangeId).unit_price === 15000 && ql.find(x => x.service_id === fixedSvc).unit_price === 10000, 'the saved quote lines are the fee (R10,000) and the agreed amount (R15,000) - nothing guessed', JSON.stringify(ql));
        await p.close();

        // ═══════════ Public booking form: grouped, Most Booked, and never a price ═══════════
        const ctx = await browser.createBrowserContext();
        const pp = await ctx.newPage();
        await pp.setViewport({ width: 1440, height: 900 });
        const pubErrs = [], svcBodies = [];
        pp.on('pageerror', e => pubErrs.push(e.message.slice(0, 160)));
        pp.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) pubErrs.push('console: ' + m.text().slice(0, 140)); });
        pp.on('response', async r => { if (/\/api\/public\/services$/.test(r.url())) { try { svcBodies.push(await r.text()); } catch (e) { /* ignore */ } } });
        // The booking POST is answered here (nothing is created) so the submit handler can be exercised end to end.
        const posted = [];
        await pp.setRequestInterception(true);
        pp.on('request', r => {
            if (r.method() === 'POST' && r.url().endsWith('/api/public/bookings')) { posted.push(JSON.parse(r.postData() || '{}')); return r.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, booking_id: 4242 }) }); }
            r.continue();
        });
        await pp.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
        await sleep(2500);
        await pp.evaluate(() => { const x = document.getElementById('cookieRejectAll'); if (x && x.offsetParent) x.click(); });
        await pp.evaluate(() => window.openAtlDrawer('bookingDrawer'));
        await pp.waitForFunction(() => document.querySelectorAll('#bkServiceDropdown option').length > 5, { timeout: 20000 });
        await sleep(900);
        const dd = await pp.evaluate(() => ({
            groups: [...document.querySelectorAll('#bkServiceDropdown optgroup')].map(g => ({ label: g.label, n: g.querySelectorAll('option').length })),
            optionText: [...document.querySelectorAll('#bkServiceDropdown option')].map(o => o.textContent).join(' | ')
        }));
        ok(dd.groups.length === 6 && dd.groups[0].label === 'Club & Theatre' && dd.groups[1].label === 'Corporate & Events — Most Booked' && dd.groups[1].n === 7 && dd.groups[4].label === 'Acting, Voice-Over & Brand Campaigns' && /Add-ons/.test(dd.groups[5].label),
            'public form: services are grouped as on the rate card, Corporate & Events marked "Most Booked"', JSON.stringify(dd.groups));
        ok(!/R\s?\d|price|from r|enquire/i.test(dd.optionText), 'public form: not one option shows a price or a price word', dd.optionText.slice(0, 300));
        ok(svcBodies.length > 0 && !/default_price|base_price|price_type|price_min|revenue_gl_code|financial_category/.test(svcBodies[0]), 'public form: the services response carries no price or accounting field', (svcBodies[0] || '').slice(0, 200));
        await pp.select('#bkServiceDropdown', '15');
        await pp.evaluate(() => document.getElementById('bkAddServiceBtn').click()); await sleep(500);
        const row = await pp.evaluate(() => { const r = document.querySelector('#bkServicesTableBody tr'); return r ? { price: r.getAttribute('data-unit-price'), text: r.textContent.replace(/\s+/g, ' ').trim(), attrs: [...r.attributes].map(a => a.name) } : null; });
        ok(row && row.price === null && !/R\s?\d/.test(row.text), 'public form: a chosen service row stores no price and shows none', JSON.stringify(row));
        const draft = await pp.evaluate(() => { try { return localStorage.getItem('bkDraft') || ''; } catch (e) { return ''; } });
        await pp.evaluate(() => { document.getElementById('bookName') && $('#bookName').val('Draft Test').trigger('input'); });
        await sleep(500);
        const draft2 = await pp.evaluate(() => { try { return localStorage.getItem('bkDraft') || ''; } catch (e) { return ''; } });
        ok(!/unitPrice/.test(draft + draft2), 'public form: the saved draft holds no price', (draft + draft2).slice(0, 200));
        // Submit through the real handler. Real mouse clicks cannot reach the lower steps of this tall drawer in headless Chrome
        // (the long-standing reason form.js / slots.js stop at step 2), so the form's own submit event is fired.
        await pp.evaluate(() => { window.__pubToasts = []; ['showError', 'showWarning', 'showSuccess', 'showInfo'].forEach(k => { const o = window.notificationService && window.notificationService[k]; if (o) window.notificationService[k] = function () { window.__pubToasts.push(k + ': ' + Array.prototype.join.call(arguments, ' | ')); return o.apply(this, arguments); }; }); $('#bookPopia').prop('checked', true); });
        await pp.evaluate(() => { $('#dedicatedBookingForm').trigger('submit'); });
        await sleep(2000);
        const pubToasts = await pp.evaluate(() => window.__pubToasts || []);
        ok(posted.length === 1, 'public form: submitting reaches the server (the old "Prices Updated" check no longer blocks it)', JSON.stringify({ posted: posted.length, toasts: pubToasts }));
        ok(posted.length === 1 && JSON.stringify(posted[0].services) === JSON.stringify([{ service_id: 15, quantity_minutes: 1 }]), 'public form: the booking request carries only each service id and quantity - no price', JSON.stringify(posted[0] && posted[0].services));
        ok(posted.length === 1 && !/price|amount|fee|total|cost/i.test(JSON.stringify(posted[0])), 'public form: nothing in the booking request mentions a price, amount, fee or total', JSON.stringify(posted[0] || {}).slice(0, 300));
        ok(!pubToasts.some(t => /Prices Updated/.test(t)), 'public form: no "Prices Updated" warning is raised', JSON.stringify(pubToasts));
        ok(pubErrs.length === 0, 'public form: no page errors', JSON.stringify(pubErrs));
        await pp.close();
    } finally {
        if (browser) await browser.close();
        await support.stop();
    }
    console.log(fails ? `\n${fails} browser check(s) FAILED` : '\nAll service-pricing browser checks passed');
    process.exit(fails ? 1 : 0);
})().catch(e => { console.error('BROWSER TEST CRASHED', e); process.exit(1); });
