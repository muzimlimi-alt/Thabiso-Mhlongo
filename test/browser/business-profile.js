// Business > Business Profile (own page, six tabs) and the Quote Builder's VAT box, driven through the REAL admin page in headless Chrome on an isolated DB copy
// (test/support.js - the real database is never touched).
//   - the tab builds from the saved profile; the two registration tick boxes show / hide / disable the right fields; the "what this means"
//     panel tells the truth about VAT; unsaved-change handling; the confirmation on a registration change; server errors appear beside the field;
//     company <-> individual; persistence after a reload
//   - phone width (390px): no sideways scroll, 44px controls, the save bar stays reachable
//   - a manager sees it read-only with the reference masked; an assistant never sees the tab
//   - the Quote Builder's "Apply VAT" box follows the profile (greyed out + explained while VAT is off, usable but unticked by default while it is on)
// Not part of `npm test`: run it with `npm run test:browser` (needs PUPPETEER_EXECUTABLE_PATH on this machine, see test-suite notes).
// Date offsets 1450-1459 belong to this file.
const fs = require('fs');
const path = require('path');
const support = require('../support');
const puppeteer = require('puppeteer');
const { BASE, sleep, api, one, future, loginAs } = support;
let fails = 0;
const ok = (c, n, detail) => { if (!c) fails++; console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '\n        -> ' + detail)); };
const SHOTS = process.env.BP_SHOTS_DIR || null;
let LAST_PAGE = null;   // for the crash report
const shot = async (p, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await p.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: false }); } };

async function cookieFor(email, password) {
    const r = await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
    const sc = r.headers.get('set-cookie');
    if (r.status !== 200 || !sc) throw new Error('login failed: ' + email + ' ' + r.status);
    return sc.split(';')[0];
}

async function openAdmin(browser, cookie, { width = 1440, height = 1000 } = {}) {
    const ctx = await browser.createBrowserContext();
    const p = await ctx.newPage();
    await p.setViewport({ width, height });
    p._errs = []; LAST_PAGE = p;
    p.on('pageerror', e => p._errs.push(e.message.slice(0, 200)));
    p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|Loading the font|API Error/.test(m.text())) p._errs.push('console: ' + m.text().slice(0, 200)); });
    const [name, ...rest] = cookie.split('=');
    await p.setCookie({ name, value: rest.join('='), url: BASE });
    await p.setRequestInterception(true);
    p.on('request', r => {
        if (/\/api\/admin\/maps-config/.test(r.url())) return r.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, key: '' }) });
        r.continue();
    });
    await p.goto(BASE + '/admin.html', { waitUntil: 'networkidle0', timeout: 90000 });
    await p.waitForFunction(() => typeof window.switchTab === 'function' && typeof window.loadBusinessProfile === 'function', { timeout: 30000 });
    // record every confirmation dialog and answer Yes
    await p.evaluate(() => { window.__confirms = []; window.notificationService.showConfirm = async (o) => { window.__confirms.push({ title: (o && o.title) || '', message: (o && o.message) || '' }); return !/Recover Unsaved Draft/.test((o && o.title) || ''); }; });
    return p;
}
async function openTab(p) {
    await p.evaluate(() => window.switchTab('businessAdmin'));   // opening the page loads the profile (a sidebar link, not a tab inside Settings)
    await p.waitForFunction(() => !!document.getElementById('bp_legal_name') && document.getElementById('bp_legal_name').value !== '', { timeout: 20000 });
    await sleep(250);
}
const val = (p, id) => p.evaluate((id) => document.getElementById(id).value, id);
const vis = (p, sel) => p.evaluate((sel) => { const e = document.querySelector(sel); return !!e && e.offsetParent !== null; }, sel);
const checked = (p, id) => p.evaluate((id) => document.getElementById(id).checked, id);
const disabled = (p, id) => p.evaluate((id) => document.getElementById(id).disabled, id);
const text = (p, sel) => p.evaluate((sel) => { const e = document.querySelector(sel); return e ? e.textContent.replace(/\s+/g, ' ').trim() : ''; }, sel);
const setVal = (p, id, v) => p.evaluate((id, v) => { const e = document.getElementById(id); e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); }, id, v);
const tab = (p, panelId) => p.evaluate((id) => document.querySelector('[data-um-tab="' + id + '"]').click(), panelId);   // a real click on the tab button
const click = (p, id) => p.evaluate((id) => document.getElementById(id).click(), id);   // a native click: fires the change event and toggles a checkbox like a user's click

(async () => {
    await support.start();
    let browser;
    try {
        browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-quic'], executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined });
        // known baseline: company, tax registered with a reference, VAT OFF
        const base = { business_type: 'company', legal_name: 'MTV CREATIVES (PTY) LTD', registration_number: '2025/575967/07', is_tax_registered: true, income_tax_reference: '9000000001', is_vat_registered: false, vat_number: '', vat_number_verified: false, confirm_registration_change: true };
        const setBase = async () => { const v = (await api('GET', '/api/admin/business-profile')).body.profile.version; return api('PUT', '/api/admin/business-profile', Object.assign({}, base, { version: v })); };
        ok((await setBase()).status === 200, 'baseline saved through the API', '');

        const adminCk = await cookieFor('test.runner@example.invalid', 'TestRunnerPass1!');
        const p = await openAdmin(browser, adminCk);
        await openTab(p);
        await shot(p, '01-desktop-top');

        // ── 1. the form shows what is stored ──
        ok(await val(p, 'bp_legal_name') === 'MTV CREATIVES (PTY) LTD' && await val(p, 'bp_registration_number') === '2025/575967/07' && await val(p, 'bp_enterprise_number') === 'K2025575967', 'the form is filled from the saved profile (legal name, CIPC registration number, enterprise number)', '');
        ok(await val(p, 'bp_registration_date') === '2025-07-19' && await val(p, 'bp_financial_year_end') === 'July' && await val(p, 'bp_bbbee_expiry_date') === '2026-11-18', 'dates are real date pickers holding ISO dates; the year-end is a drop-down', '');
        ok((await p.evaluate(() => document.getElementById('bp_registration_date').type)) === 'date' && (await p.evaluate(() => document.getElementById('bp_financial_year_end').tagName)) === 'SELECT', 'date fields are type=date and drop-downs are <select>', '');
        {
            const where = await p.evaluate(() => ['bpCardProfile', 'bpCardCipc', 'bpCardBank', 'bpCardTax', 'bpCardAddr', 'bpCardBbbee', 'bpCardPreview'].map(id => [id, (document.getElementById(id).closest('.um-panel') || {}).id]));
            const want = { bpCardProfile: 'bpPanelCompany', bpCardCipc: 'bpPanelCompany', bpCardBank: 'bpPanelCompany', bpCardTax: 'bpPanelTax', bpCardAddr: 'bpPanelAddr', bpCardBbbee: 'bpPanelBbbee', bpCardPreview: 'bpPanelLetterhead' };
            ok(where.every(([id, panel]) => want[id] === panel), 'every card is on its own tab: Company (details, CIPC, banking summary), Tax & VAT, Addresses & Contact, B-BBEE & Compliance, Letterhead Preview', JSON.stringify(where));
            ok(await p.evaluate(() => [...document.querySelectorAll('#bpTabs > .atl-tab-bar [data-um-tab]')].length === 6) && await vis(p, '#bpCardProfile') && await vis(p, '#bpCardCipc') && !(await vis(p, '#bpCardTax')), 'six tabs; the Company tab is open first and the other tabs\' cards are not on screen', '');
        }
        await tab(p, 'bpPanelTax');
        ok(await vis(p, '#bpCardTax') && !(await vis(p, '#bpCardProfile')), 'opening the Tax & VAT tab shows its card and hides the Company cards', '');
        ok(await checked(p, 'bp_is_tax_registered') && !(await checked(p, 'bp_is_vat_registered')), 'the two registration boxes show the stored state (tax ticked, VAT unticked)', '');
        ok(await vis(p, '#bpTaxFields') && !(await vis(p, '#bpVatFields')), 'tax fields are visible while tax is ticked; VAT fields stay hidden while VAT is unticked', '');
        ok(await val(p, 'bp_income_tax_reference') === '9000000001', 'an administrator sees the income-tax reference', '');
        ok(/VAT is OFF/.test(await text(p, '#bpEffect')) && /INVOICE/.test(await text(p, '#bpEffect')) && /does not change this/.test(await text(p, '#bpEffect')), 'the "what this means" panel says VAT is OFF and that income-tax registration does not change it', await text(p, '#bpEffect'));
        ok(/MTV CREATIVES|Bank|bank/.test(await text(p, '#bpBank')) || /No bank details/.test(await text(p, '#bpBank')), 'the banking section is a read-only summary of the existing bank details', await text(p, '#bpBank'));
        ok(await p.evaluate(() => document.querySelectorAll('.bp-save').length === 5 && [...document.querySelectorAll('.bp-save, .bp-discard')].every(b => b.disabled)), 'every editable card has its own Save button (five) and all are disabled while nothing has changed', '');

        // ── 2. conditional fields ──
        await click(p, 'bp_is_tax_registered');
        ok(!(await vis(p, '#bpTaxFields')) && await disabled(p, 'bp_is_vat_registered') && !(await checked(p, 'bp_is_vat_registered')), 'unticking tax registration hides the tax fields and disables (and clears) the VAT box - VAT sits on top of SARS registration', '');
        ok(/VAT is OFF/.test(await text(p, '#bpEffect')) && !/does not change this/.test(await text(p, '#bpEffect')), 'the panel follows', await text(p, '#bpEffect'));
        await click(p, 'bp_is_tax_registered');
        ok(await vis(p, '#bpTaxFields') && !(await disabled(p, 'bp_is_vat_registered')) && await val(p, 'bp_income_tax_reference') === '9000000001', 'ticking it again brings the fields back with their stored values (nothing was erased)', '');
        await click(p, 'bp_is_vat_registered');
        ok(await vis(p, '#bpVatFields') && /VAT is still OFF/.test(await text(p, '#bpEffect')) && /Enter a valid VAT number/.test(await text(p, '#bpEffect')), 'ticking VAT shows the VAT fields; the panel says VAT is STILL off until a valid number is entered', await text(p, '#bpEffect'));
        await setVal(p, 'bp_vat_number', '4123456789');
        ok(/Tick "I have confirmed this VAT number with SARS"/.test(await text(p, '#bpEffect')), 'a valid number alone is not enough - the panel asks for the confirmation', await text(p, '#bpEffect'));
        await click(p, 'bp_vat_number_verified');
        ok(/VAT is ON/.test(await text(p, '#bpEffect')) && /TAX INVOICE/.test(await text(p, '#bpEffect')), 'number + confirmation: the panel says VAT is ON and invoices that charge it become TAX INVOICE', await text(p, '#bpEffect'));
        ok(/unsaved/i.test(await text(p, '#bpDirty_tax')) && !(await p.evaluate(() => document.getElementById('bpSave_tax').disabled)) && !(await p.evaluate(() => document.getElementById('bpDiscard_tax').disabled)), 'the Tax and VAT card shows "unsaved changes" and enables ITS Save / Discard', await text(p, '#bpDirty_tax'));
        ok(await p.evaluate(() => ['profile', 'cipc', 'addr', 'bbbee'].every(id => document.getElementById('bpSave_' + id).disabled && /Saved/.test(document.getElementById('bpDirty_' + id).textContent))), '...and the other four cards stay saved with their Save buttons disabled', '');
        await p.evaluate(() => document.getElementById('bpBar_tax').scrollIntoView({ block: 'end' })); await sleep(300);
        await shot(p, '02-desktop-vat-on-unsaved');

        // ── 3. discard ──
        await click(p, 'bpDiscard_tax');
        ok(!(await checked(p, 'bp_is_vat_registered')) && await val(p, 'bp_vat_number') === '' && /Saved/.test(await text(p, '#bpDirty_tax')), "the card's Discard puts its stored values back", await text(p, '#bpDirty_tax'));

        // ── 4. server errors appear next to the field and nothing is saved ──
        await click(p, 'bp_is_vat_registered');
        await setVal(p, 'bp_vat_number', '123');
        await click(p, 'bpSave_tax');
        await p.waitForFunction(() => { const e = document.getElementById('bpErr_vat_number'); return e && e.style.display !== 'none' && e.textContent.length > 0; }, { timeout: 15000 }).catch(() => {});
        ok(/10 digits and starts with 4/.test(await text(p, '#bpErr_vat_number')) && (await api('GET', '/api/admin/business-profile')).body.profile.is_vat_registered === 0, 'a bad VAT number: the server\'s message appears under the field and nothing is saved', await text(p, '#bpErr_vat_number'));
        ok(await p.evaluate(() => window.__confirms.length) >= 1, '(the confirmation was asked before the server was)', '');
        // the Tax card still holds that bad number: save it from another tab - the error is on a field the person cannot see, so its tab opens
        await tab(p, 'bpPanelCompany');
        ok(!(await vis(p, '#bpCardTax')), '(the Company tab is showing, the Tax card is not)', '');
        await click(p, 'bpSave_tax');
        await p.waitForFunction(() => document.getElementById('bpPanelTax').classList.contains('active'), { timeout: 15000, polling: 200 });
        ok(await vis(p, '#bpErr_vat_number') && /10 digits and starts with 4/.test(await text(p, '#bpErr_vat_number')), 'an error on a field that sits on another tab switches to that tab, with the message showing under the field', await text(p, '#bpErr_vat_number'));

        // ── 5. save a registration change: confirmation first, then persisted ──
        await setVal(p, 'bp_vat_number', '4123456789');
        await click(p, 'bp_vat_number_verified');
        await p.evaluate(() => { window.__confirms.length = 0; });
        await click(p, 'bpSave_tax');
        await p.waitForFunction(() => /Saved/.test(document.getElementById('bpDirty_tax').textContent), { timeout: 15000, polling: 200 });
        const conf = await p.evaluate(() => window.__confirms.slice());
        ok(conf.length === 1 && /Change registration settings/.test(conf[0].title) && !/[<>]/.test(conf[0].message) && /Registered for VAT: no/.test(conf[0].message) && /not changed/.test(conf[0].message), 'saving a registration change asks first, lists exactly what changes and says issued documents are untouched', JSON.stringify(conf));
        const saved = (await api('GET', '/api/admin/business-profile')).body;
        ok(saved.profile.is_vat_registered === 1 && saved.profile.vat_number === '4123456789' && saved.computed.vat_active === true, 'the change is persisted and VAT is now active', JSON.stringify(saved.computed.vat_active));
        await p.reload({ waitUntil: 'networkidle0' });
        await p.waitForFunction(() => typeof window.loadBusinessProfile === 'function', { timeout: 30000 });
        await openTab(p);
        ok(await checked(p, 'bp_is_vat_registered') && await val(p, 'bp_vat_number') === '4123456789' && await checked(p, 'bp_vat_number_verified') && /VAT is ON/.test(await text(p, '#bpEffect')), 'after a full page reload the saved values come back (persistence)', await text(p, '#bpEffect'));

        // ── 5b. every card saves on its own ──
        // (the reload above threw the page's confirmation recorder away: install it again)
        await p.evaluate(() => { window.__confirms = []; window.notificationService.showConfirm = async (o) => { window.__confirms.push({ title: (o && o.title) || '', message: (o && o.message) || '' }); return true; }; });
        ok(await p.evaluate(() => { const h = window.bpTestHooks; return [].concat.apply([], Object.keys(h.sections).map(k => h.sections[k].keys)).sort().join() === h.allKeys.slice().sort().join(); }), 'the five cards between them own every profile field exactly once', '');
        const dis = (id) => p.evaluate((id) => document.getElementById(id).disabled, id);
        await setVal(p, 'bp_trading_name', 'Funny Business');
        await setVal(p, 'bp_contact_phone', '+27 11 555 0100');
        ok(!(await dis('bpSave_profile')) && !(await dis('bpSave_addr')) && (await dis('bpSave_cipc')) && (await dis('bpSave_tax')) && (await dis('bpSave_bbbee')), "editing two cards wakes up exactly those two cards' Save buttons", '');
        ok(await p.evaluate(() => ['bpPanelCompany', 'bpPanelAddr'].every(t => document.querySelector('[data-um-tab="' + t + '"]').classList.contains('bp-tab-dirty')) && ['bpPanelTax', 'bpPanelBbbee'].every(t => !document.querySelector('[data-um-tab="' + t + '"]').classList.contains('bp-tab-dirty'))), 'the tabs that hold unsaved edits (Company, Addresses & Contact) carry a dot; the others do not', '');
        await click(p, 'bpSave_addr');
        await p.waitForFunction(() => /Saved/.test(document.getElementById('bpDirty_addr').textContent), { timeout: 15000, polling: 200 });
        let srv = (await api('GET', '/api/admin/business-profile')).body.profile;
        ok(srv.contact_phone === '+27 11 555 0100' && srv.trading_name === '', 'saving the Addresses card stores ITS fields only - the trading name typed in another card was not sent', JSON.stringify([srv.contact_phone, srv.trading_name]));
        ok(await val(p, 'bp_trading_name') === 'Funny Business' && !(await dis('bpSave_profile')) && /Unsaved/.test(await text(p, '#bpDirty_profile')) && /Saved/.test(await text(p, '#bpDirty_addr')), "...and that other card's edit is still on screen, still marked unsaved; the saved card shows Saved", '');
        await click(p, 'bpSave_profile');
        await p.waitForFunction(() => /Saved/.test(document.getElementById('bpDirty_profile').textContent), { timeout: 15000, polling: 200 });
        srv = (await api('GET', '/api/admin/business-profile')).body.profile;
        ok(srv.trading_name === 'Funny Business' && srv.contact_phone === '+27 11 555 0100', 'the second card then saves too (its version number was refreshed, so it is not refused as stale)', JSON.stringify([srv.contact_phone, srv.trading_name]));
        // a card's confirmation lists only the registration facts THAT card owns
        await p.evaluate(() => { window.__confirms.length = 0; });
        await setVal(p, 'bp_business_type', 'individual');
        await setVal(p, 'bp_vat_number', '4999999999');   // an unsaved edit in the Tax card must not leak into the Profile card's confirmation
        await click(p, 'bpSave_profile');
        await p.waitForFunction(() => /Saved/.test(document.getElementById('bpDirty_profile').textContent), { timeout: 15000, polling: 200 });
        const c2 = await p.evaluate(() => window.__confirms.slice());
        ok(c2.length === 1 && /Business type: company → individual/.test(c2[0].message) && !/VAT/.test(c2[0].message), 'the Business details card asks about the business type only (the unsaved VAT number in the Tax card is not mentioned or sent)', JSON.stringify(c2));
        srv = (await api('GET', '/api/admin/business-profile')).body.profile;
        ok(srv.business_type === 'individual' && srv.vat_number !== '4999999999', '...and the VAT number typed in the other card was not saved', JSON.stringify([srv.business_type, srv.vat_number]));
        await click(p, 'bpDiscard_tax');
        await setVal(p, 'bp_business_type', 'company');
        await click(p, 'bpSave_profile');
        await p.waitForFunction(() => /Saved/.test(document.getElementById('bpDirty_profile').textContent) && document.getElementById('bp_business_type').value === 'company', { timeout: 15000, polling: 200 });
        { const v = (await api('GET', '/api/admin/business-profile')).body.profile.version; await api('PUT', '/api/admin/business-profile', { trading_name: '', contact_phone: '', version: v }); }   // put the two edited values back

        // ── 6. company <-> individual ──
        await tab(p, 'bpPanelCompany');
        await setVal(p, 'bp_business_type', 'individual');
        ok(!(await vis(p, '#bpCardCipc')) && /Full legal name/.test(await text(p, '#bpLegalNameLabel')), 'choosing "Individual / sole proprietor" hides the CIPC card and relabels the name field', '');
        await setVal(p, 'bp_business_type', 'company');
        ok(await vis(p, '#bpCardCipc') && await val(p, 'bp_registration_number') === '2025/575967/07', 'switching back restores the CIPC card with its stored number', '');

        // ── 7. phone width ──
        await p.setViewport({ width: 390, height: 844 });
        await tab(p, 'bpPanelTax');
        await sleep(300);
        const m = await p.evaluate(() => {
            const inputs = [...document.querySelectorAll('#bpRoot .um-input')].filter(e => e.offsetParent !== null && e.type !== 'hidden');
            const small = inputs.filter(e => e.getBoundingClientRect().height < 43).map(e => e.id || e.className);
            return { sw: document.documentElement.scrollWidth, iw: window.innerWidth, small: small.slice(0, 5), n: inputs.length };
        });
        ok(m.sw <= m.iw + 1, 'phone width (390px): no sideways page scroll', JSON.stringify(m));
        ok(await p.evaluate(() => { const bar = document.querySelector('#bpTabs > .atl-tab-bar'); const wraps = [...bar.querySelectorAll('[data-um-tab]')].every(b => b.getBoundingClientRect().right <= window.innerWidth + 1); return wraps || ['auto', 'scroll'].includes(getComputedStyle(bar).overflowX); }), 'phone width: the six tabs either wrap inside the screen or scroll inside their own bar - they never widen the page', '');
        ok(m.n > 5 && m.small.length === 0, 'phone width: every visible control on the open tab is at least 44px tall', JSON.stringify(m));
        await p.evaluate(() => document.getElementById('bpBar_tax').scrollIntoView({ block: 'end' })); await sleep(300);
        await shot(p, '03-phone-tax');
        await p.evaluate(() => document.getElementById('bpBar_tax').scrollIntoView({ block: 'end' }));
        await sleep(300);
        const bar = await p.evaluate(() => { const r = document.getElementById('bpBar_tax').getBoundingClientRect(); return { top: r.top, bottom: r.bottom, vh: window.innerHeight }; });
        ok(bar.bottom <= bar.vh + 1 && bar.top >= 0, "phone width: the card's save bar fits on the screen when scrolled to", JSON.stringify(bar));
        const btn = await p.evaluate(() => [...document.querySelectorAll('.bp-save, .bp-discard')].filter(b => b.offsetParent !== null).map(b => Math.round(b.getBoundingClientRect().height)));
        ok(btn.length >= 2 && btn.every(h => h >= 43), 'phone width: the open card Save / Discard buttons are at least 44px tall', JSON.stringify(btn));
        await p.setViewport({ width: 1440, height: 1000 });

        // ── 8. previews ──
        // a half-typed VAT number left in a field that is now hidden (VAT unticked) must not block the previews or the card's save
        await setVal(p, 'bp_vat_number', '12');
        await click(p, 'bp_is_vat_registered');
        ok(!(await vis(p, '#bpVatFields')) && !(await checked(p, 'bp_is_vat_registered')), 'VAT unticked: its fields are hidden while the junk value is still sitting in the VAT number box', '');
        ok(await p.evaluate(() => JSON.stringify(window.bpTestHooks.collect(['vat_number', 'vat_number_verified'])) === JSON.stringify({ vat_number: window.bpTestHooks.state.loaded.vat_number, vat_number_verified: !!window.bpTestHooks.state.loaded.vat_number_verified })), "the hidden VAT fields are not sent: the stored values stand", '');
        await tab(p, 'bpPanelLetterhead');
        const pdfs = [];
        p.on('response', async (r) => { if (/business-profile\/preview/.test(r.url())) pdfs.push(r.status()); });
        await click(p, 'bpPreviewQuote'); await sleep(2500);
        await click(p, 'bpPreviewInvoice'); await sleep(2500);
        ok(pdfs.length === 2 && pdfs.every(s => s === 200), 'both letterhead previews are served as PDFs from the form values', JSON.stringify(pdfs));

        // ── 9. Quote Builder VAT box follows the profile ──
        const bk = (await api('POST', '/api/admin/bookings', { name: 'BP Builder', email: `bp.builder.${Date.now()}@example.invalid`, cell: '+27821234567', event_date: future(1450), event_name: 'BP builder', event_type: 'Corporate', event_location: 'Hall', message: 'Business profile builder test, over ten characters.', services: [{ service_id: (await one('SELECT id FROM services WHERE name = ?', ['Club – 10 min Set (Guest Spot)'])).id }], status: 'NEW', override_working_hours: true })).body.booking_id;
        const openBuilder = async (page) => {
            await page.evaluate(() => { window.closeQuoteDrawer && window.closeQuoteDrawer(); $('#qbItemsBody').empty(); const o = document.getElementById('zzOpenQuote'); if (o) o.remove(); });
            await page.evaluate((id) => { const b = document.createElement('button'); b.className = 'bk-action-quote'; b.setAttribute('data-id', id); b.id = 'zzOpenQuote'; document.body.appendChild(b); b.click(); }, bk);
            await page.waitForFunction(() => document.querySelectorAll('.qb-item-row').length >= 1 && /qb-drawer--open/.test((document.getElementById('quoteDrawer') || {}).className || ''), { timeout: 25000, polling: 200 })
                .catch(async e => { throw new Error('builder did not open: ' + JSON.stringify(await page.evaluate(() => ({ rows: document.querySelectorAll('.qb-item-row').length, cls: (document.getElementById('quoteDrawer') || {}).className, confirms: window.__confirms }))).slice(0, 300)); });
            await sleep(500);
        };
        await p.evaluate(() => window.switchTab('bookingsAdmin')); await sleep(300);
        await p.evaluate(() => window.loadBookings());
        await p.waitForFunction(() => document.querySelectorAll('#bookingsListContainer tr.atl-bk-row').length > 0, { timeout: 30000, polling: 200 }).catch(e => { throw new Error('bookings list did not render: ' + e.message.slice(0, 80)); });
        await openBuilder(p);
        let vb = await p.evaluate(() => ({ dis: document.getElementById('qbApplyVat').disabled, on: document.getElementById('qbApplyVat').checked, hint: (document.getElementById('qbVatHint').textContent || '').trim(), hintShown: document.getElementById('qbVatHint').style.display !== 'none' }));
        ok(!vb.dis && !vb.on && !vb.hint, 'VAT-registered business: the box is usable and, as before, a new quotation starts with VAT unticked (never switched on silently)', JSON.stringify(vb));
        await p.evaluate(() => window.closeQuoteDrawer());
        // switch VAT off through the API (as an administrator would on the Settings page) and reopen the builder
        const v = (await api('GET', '/api/admin/business-profile')).body.profile.version;
        await api('PUT', '/api/admin/business-profile', { is_vat_registered: false, version: v, confirm_registration_change: true });
        await openBuilder(p);
        vb = await p.evaluate(() => ({ dis: document.getElementById('qbApplyVat').disabled, on: document.getElementById('qbApplyVat').checked, hint: (document.getElementById('qbVatHint').textContent || '').trim(), hintShown: document.getElementById('qbVatHint').style.display !== 'none', cursor: document.getElementById('qbApplyVat').style.cursor }));
        ok(vb.dis && !vb.on && vb.hintShown && /not set up as VAT-registered/.test(vb.hint), 'VAT off: the box is greyed out, unticked and explains why (Business > Business Profile)', JSON.stringify(vb));
        await shot(p, '04-builder-vat-off');
        const qres = await p.evaluate(async (id) => {
            const exp = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
            const r = await fetch(`/api/admin/bookings/${id}/quote`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ quote_expiry_date: exp, terms: 't', apply_vat: true, discount: 0, items: [{ description: 'x', quantity: 1, unit_price: 100, pricing_model: 'flat_fee' }] }) });
            return { status: r.status, body: await r.json().catch(() => ({})) };
        }, bk);
        ok(qres.status === 400 && qres.body.code === 'VAT_NOT_ACTIVE', '...and a hand-made request for a VAT quotation is refused by the server anyway', JSON.stringify(qres));
        await p.evaluate(() => window.closeQuoteDrawer());
        ok(p._errs.length === 0, 'no page errors on the admin page', p._errs.join(' | '));

        // ── 9b. a server that does not have the feature yet (a dev server started before it existed answers 404) ──
        const old = await openAdmin(browser, adminCk);
        await old.evaluate(() => {   // make the profile API behave like that old server, for GET and for the preview
            window.__oldServer = true;
            const orig = window.fetch.bind(window);
            window.fetch = (u, o) => (window.__oldServer && String(u).indexOf('/api/admin/business-profile') === 0) ? Promise.resolve(new Response('Not Found', { status: 404 })) : orig(u, o);
        });
        await old.evaluate(() => window.switchTab('businessAdmin'));
        await old.waitForSelector('#bpRetry', { timeout: 15000 });
        ok(await old.evaluate(() => !document.getElementById('bp_legal_name') && !document.querySelector('.bp-save') && document.getElementById('bpTabs').style.display === 'none'), 'old server: no empty, editable form is left on screen (the tabs are hidden, no Save buttons that cannot work)', '');
        ok(/older version of the site/.test(await text(old, '#bpRoot')) && /npm start/.test(await text(old, '#bpRoot')), 'old server: the page says why and what to do (restart the server)', await text(old, '#bpRoot'));
        await shot(old, '05-old-server');
        await old.evaluate(() => { window.__oldServer = false; });
        await old.evaluate(() => document.getElementById('bpRetry').click());
        await old.waitForFunction(() => !!document.getElementById('bp_legal_name') && document.getElementById('bp_legal_name').value !== '', { timeout: 15000, polling: 200 });
        ok(await old.evaluate(() => document.querySelectorAll('.bp-save').length === 5 && document.getElementById('bpTabs').style.display !== 'none' && document.getElementById('bpFail').textContent === ''), 'old server: once the server is current, "Try again" brings the tabs back with the five Save buttons and clears the message', '');
        ok(old._errs.length === 0, 'old server: no page errors', old._errs.join(' | '));

        // ── 10. other roles ──
        await loginAs('manager'); await loginAs('assistant');
        const mgr = await openAdmin(browser, await cookieFor('test.manager@example.invalid', 'TestRunnerPass1!'));
        await openTab(mgr);
        const _mv = { barDisplay: await mgr.evaluate(() => [...document.querySelectorAll('.bp-cardbar')].map(b => getComputedStyle(b).display).join()) };
        ok(await mgr.evaluate(() => document.getElementById('businessAdmin').style.display === 'block' && !!document.querySelector('.admin-sidebar a[href="#businessAdmin"]') && document.querySelector('.admin-sidebar a[href="#businessAdmin"]').closest('li').style.display !== 'none'), 'a manager is offered Business Profile in the sidebar and it opens', '');
        ok(_mv.barDisplay.split(',').length === 5 && _mv.barDisplay.split(',').every(d => d === 'none') && (await mgr.evaluate(() => [...document.querySelectorAll('#bpRoot input, #bpRoot select, #bpRoot textarea')].every(e => e.disabled))), 'a manager gets a read-only profile: every field disabled, no Save bars', JSON.stringify(_mv) + JSON.stringify(await mgr.evaluate(() => [...document.querySelectorAll('#bpRoot input, #bpRoot select, #bpRoot textarea')].filter(e => !e.disabled).map(e => e.id || e.className))));
        ok(/^•+\d{3}$/.test(await val(mgr, 'bp_income_tax_reference')), 'a manager sees the income-tax reference masked', await val(mgr, 'bp_income_tax_reference'));
        ok(/View only/.test(await text(mgr, '#bpStatus')), 'and is told it is view-only', await text(mgr, '#bpStatus'));
        const asst = await openAdmin(browser, await cookieFor('test.assistant@example.invalid', 'TestRunnerPass1!')).catch(e => ({ _fail: e.message }));
        if (asst._fail) ok(false, 'assistant page opened', asst._fail);
        else {
            const hidden = await asst.evaluate(() => { const a = document.querySelector('.admin-sidebar a[href="#businessAdmin"]'); return !a || a.closest('li').style.display === 'none'; });
            ok(hidden, 'an assistant is not offered Business Profile in the sidebar', '');
            const denied = await asst.evaluate(() => { window.switchTab('businessAdmin'); return document.getElementById('businessAdmin').style.display !== 'block' && document.getElementById('dashboardAdmin').style.display === 'block'; });
            ok(denied, 'and opening it by id sends an assistant to the dashboard', '');
        }
    } catch (e) {
        fails++;
        console.log('FAIL browser test crashed: ' + (e.stack || e.message).slice(0, 600));
        if (LAST_PAGE) console.log('page errors: ' + JSON.stringify(LAST_PAGE._errs));
    } finally {
        if (browser) await browser.close();
        await support.stop();
    }
    console.log(fails ? `\n${fails} check(s) FAILED` : '\nAll checks passed');
    process.exit(fails ? 1 : 0);
})();
