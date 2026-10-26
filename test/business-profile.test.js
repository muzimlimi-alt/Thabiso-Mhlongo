// Business profile, tax / VAT registration and the shared letterhead (docs-internal/business-profile-2026.md).
//
//   A. access: who may read / change the profile, and what never travels (director ID, raw income-tax reference for managers)
//   B. backend validation: every rule the form mirrors is enforced by the server
//   C. a change to a registration switch needs an explicit confirmation; saved values persist; unticking deletes nothing; stale edits are refused
//   D. the four registration configurations -> quotation PDF, VAT gate, invoice title (QUOTATION / INVOICE / TAX INVOICE), totals, snapshot
//   E. history: changing the registration afterwards never changes an issued quotation, an issued invoice or an accepted amount
//   F. company <-> individual, letterhead preview, legacy generator fallback, banking untouched, pure rules
//
// The throwaway test DB is a VAT vendor (test/support.js) so the other suites can quote with VAT; this file changes the profile on purpose and
// puts it back at the end. Date offsets 1460-1479 are reserved for this file.
const crypto = require('crypto');
const sqlite3 = require('sqlite3');
const support = require('./support');
const core = require('../lib/business-profile-core');
const pdfService = require('../js/pdfService');
const { computeDocumentTotals } = require('../js/shared/document-totals');
const fs = require('fs');
const os = require('os');
const path = require('path');

const rw = new sqlite3.Database(support.TEST_DB);
const run = (sql, params = []) => new Promise((res, rej) => rw.run(sql, params, function (e) { e ? rej(e) : res(this); }));

module.exports = async function ({ check, api, pub, one, q, future, sleep, apiBinary, extractPdfText, loginAs, getTrackingToken }) {
    // audit rows are written just after the response is sent, so look for them for a moment instead of once
    const auditCount = async (sql) => { let n = 0; for (let i = 0; i < 30 && !n; i++) { n = (await one(sql)).n; if (!n) await sleep(100); } return n; };
    const eq = (name, got, want) => check(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    const money = (n) => Math.round(Number(n) * 100) / 100;
    const URL = '/api/admin/business-profile';
    const original = await one('SELECT * FROM business_profile WHERE id = 1');
    check('migration 110 created the profile row', !!original, 'no business_profile row');

    const view = async () => (await api('GET', URL)).body;
    // PUT with the current version (so the optimistic-concurrency check passes) and, by default, the confirmation a registration change needs
    const put = async (patch, { confirm = true, version } = {}) => {
        const cur = await view();
        return api('PUT', URL, Object.assign({}, patch, { version: version !== undefined ? version : cur.profile.version }, confirm ? { confirm_registration_change: true } : {}));
    };
    const reset = async () => {   // back to a clean, known baseline between scenarios: company, tax on with a reference, VAT off
        const r = await put({ business_type: 'company', legal_name: 'MTV CREATIVES (PTY) LTD', registration_number: '2025/575967/07', is_tax_registered: true, income_tax_reference: '9000000001', is_vat_registered: false, vat_number_verified: false });
        return r;
    };

    // ── fixtures ──
    let seq = 0, day = 1460;
    const idOf = async (name) => (await one('SELECT id FROM services WHERE name = ?', [name])).id;
    const sClub = await idOf('Club – 10 min Set (Guest Spot)');     // fixed R5,000, standard-rated
    const sTravel = await idOf('Travel Buyout – Gauteng');           // VAT-exempt flat fee
    const emails = new Map();
    const manual = async (label) => {
        const email = `bprof.${Date.now()}.${seq++}@example.invalid`;
        const r = await api('POST', '/api/admin/bookings', {
            name: `BProf ${label}`, email, cell: '+27821234567', event_date: future(day++), event_name: `BPROF ${label}`, company: 'BProf Client (Pty) Ltd',
            event_type: 'Corporate', event_location: 'Profile Hall', message: 'Business profile integration test booking, over ten characters.',
            services: [{ service_id: sClub }, { service_id: sTravel }], status: 'NEW', override_working_hours: true
        });
        emails.set(r.body.booking_id, email);
        return r.body.booking_id;
    };
    const items = [
        { service_id: sClub, description: 'Club set', quantity: 1, unit_price: 5000, pricing_model: 'flat_fee' },
        { service_id: sTravel, description: 'Travel buyout', quantity: 1, unit_price: 1500, pricing_model: 'flat_fee' }
    ];
    const quote = async (bookingId, applyVat) => {
        const bk = await one('SELECT date FROM bookings WHERE id = ?', [bookingId]);
        const expiry = new Date(Date.parse(bk.date) - 10 * 86400000).toISOString().slice(0, 10);
        return api('POST', `/api/admin/bookings/${bookingId}/quote`, { quote_expiry_date: expiry, terms: 'Profile test terms.', apply_vat: applyVat, discount: 0, items });
    };
    const pdfOf = async (url) => { const d = await apiBinary('GET', url); return { status: d.status, buf: d.buffer, text: extractPdfText(d.buffer) }; };
    const quotePdf = (id) => pdfOf(`/api/admin/bookings/${id}/quote/download`);
    const invoicePdf = (id) => pdfOf(`/api/admin/bookings/${id}/invoice/download`);
    const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

    try {
        // ═══ A. access ═══
        const anon = await pub('GET', URL);
        eq('anonymous GET is refused (401)', anon.status, 401);
        eq('anonymous PUT is refused (401)', (await pub('PUT', URL, { legal_name: 'x' })).status, 401);
        const asManager = await loginAs('manager');
        const asAssistant = await loginAs('assistant');
        eq('an assistant cannot read the profile (403)', (await asAssistant('GET', URL)).status, 403);
        eq('an assistant cannot change the profile (403)', (await asAssistant('PUT', URL, { legal_name: 'Hacked' })).status, 403);
        eq('an assistant cannot preview (403)', (await asAssistant('POST', URL + '/preview', { document: 'quote' })).status, 403);
        const mv = await asManager('GET', URL);
        check('a manager can READ the profile', mv.status === 200 && mv.body.profile && mv.body.can_edit === false, `${mv.status} can_edit=${mv.body && mv.body.can_edit}`);
        check('...but the income-tax reference reaches a manager masked', /^•+\d{3}$/.test(mv.body.profile.income_tax_reference) && !JSON.stringify(mv.body).includes('9000000001'), String(mv.body.profile.income_tax_reference));
        eq('a manager cannot change the profile (403)', (await asManager('PUT', URL, { trading_name: 'Nope' })).status, 403);
        eq('a manager cannot reveal the director ID (403)', (await asManager('POST', URL + '/reveal-director-id', {})).status, 403);

        const admin = await view();
        check('an administrator sees the profile with can_edit', admin.success && admin.can_edit === true && String(admin.profile.legal_name).toUpperCase() === 'MTV CREATIVES (PTY) LTD', JSON.stringify(admin.profile && admin.profile.legal_name));
        check('the CIPC facts were seeded: reg no, enterprise no, tracking no, registration date, FYE, director',
            admin.profile.registration_number === '2025/575967/07' && admin.profile.enterprise_number === 'K2025575967' && admin.profile.cipc_tracking_number === '9439823846'
            && admin.profile.registration_date === '2025-07-19' && admin.profile.financial_year_end === 'July' && admin.profile.directors[0].name === 'Thabiso Mhlongo' && admin.profile.directors[0].appointed === '2025-07-19',
            JSON.stringify(admin.profile));
        check('B-BBEE certificate details were seeded, kept apart from the CIPC numbers',
            admin.profile.bbbee_certificate_number === '9439823846' && admin.profile.bbbee_issue_date === '2025-11-19' && admin.profile.bbbee_expiry_date === '2026-11-18', JSON.stringify([admin.profile.bbbee_certificate_number, admin.profile.bbbee_issue_date, admin.profile.bbbee_expiry_date]));
        check('the seed carried no secrets: no director ID, no encrypted blob in the API output', !('director_id_enc' in admin.profile) && admin.profile.director_id_set === false, JSON.stringify(Object.keys(admin.profile)));
        check('SARS facts from the registration notice were seeded (name, taxpayer number, provisional-tax period)', admin.profile.sars_registered_name === 'MTV CREATIVES' && admin.profile.sars_taxpayer_number === '2025/575967/07' && admin.profile.provisional_tax_period === '202508', '');
        check('the view says what VAT rate is in force and carries banking from the existing bank_details table', admin.computed.vat_rate.rate === 0.15 && 'banking' in admin.computed, JSON.stringify(admin.computed.vat_rate));

        // ═══ B. validation (the server is the judge) ═══
        const bad = async (name, patch, field) => {
            const r = await put(patch);
            check(`validation: ${name} -> 400 with an error on "${field}"`, r.status === 400 && r.body.errors && field in r.body.errors, `${r.status} ${JSON.stringify(r.body && (r.body.errors || r.body.message))}`);
        };
        await reset();
        await bad('"registered for tax" with no income-tax reference', { is_tax_registered: true, income_tax_reference: '' }, 'income_tax_reference');
        await bad('a malformed income-tax reference', { income_tax_reference: '12345' }, 'income_tax_reference');
        await bad('VAT ticked while tax registration is off', { is_tax_registered: false, is_vat_registered: true, vat_number: '4123456789' }, 'is_vat_registered');
        await bad('VAT ticked with no VAT number', { is_vat_registered: true, vat_number: '', vat_number_verified: true }, 'vat_number');
        await bad('a VAT number that fails the format (does not start with 4)', { is_vat_registered: true, vat_number: '1234567890', vat_number_verified: true }, 'vat_number');
        await bad('a VAT number of the wrong length', { is_vat_registered: true, vat_number: '41234567', vat_number_verified: true }, 'vat_number');
        await bad('a company with no registration number', { business_type: 'company', registration_number: '' }, 'registration_number');
        await bad('a malformed registration number', { registration_number: '2025-575967-07' }, 'registration_number');
        await bad('a malformed enterprise number', { enterprise_number: '2025575967' }, 'enterprise_number');
        await bad('an unknown business type', { business_type: 'partnership' }, 'business_type');
        await bad('no legal name', { legal_name: '' }, 'legal_name');
        await bad('a director ID that fails the check digit', { director_id_number: '8812275400084' }, 'director_id_number');
        await bad('a B-BBEE expiry before its issue date', { bbbee_issue_date: '2025-11-19', bbbee_expiry_date: '2025-01-01' }, 'bbbee_expiry_date');
        await bad('an impossible date', { registration_date: '2025-02-30' }, 'registration_date');
        await bad('a bad contact email', { contact_email: 'not-an-email' }, 'contact_email');
        await bad('a director with no name', { directors: [{ name: '', status: 'active' }] }, 'directors');
        let r = await put({ business_type: 'individual', legal_name: 'Thabiso Mhlongo', registration_number: '', is_tax_registered: true, income_tax_reference: '9000000001' });
        check('an INDIVIDUAL needs no CIPC registration number', r.status === 200, `${r.status} ${JSON.stringify(r.body && r.body.message)}`);
        await reset();
        check('nothing from the rejected saves reached the database', (await view()).profile.legal_name === 'MTV CREATIVES (PTY) LTD', '');

        // ═══ C. confirmation, persistence, stale edits, audit ═══
        const before = await view();
        r = await put({ is_vat_registered: true, vat_number: '4123456789', vat_number_verified: true }, { confirm: false });
        check('a registration change WITHOUT confirmation is refused (409 CONFIRM_REQUIRED) and lists what changes',
            r.status === 409 && r.body.code === 'CONFIRM_REQUIRED' && r.body.changes.some(c => c.field === 'is_vat_registered'), `${r.status} ${JSON.stringify(r.body)}`);
        check('...and nothing was saved', (await view()).profile.version === before.profile.version && (await view()).profile.is_vat_registered === 0, '');
        r = await put({ trading_name: 'Funny Business' }, { confirm: false });
        check('a change that is NOT a registration change needs no confirmation', r.status === 200 && r.body.saved === true, `${r.status} ${JSON.stringify(r.body && r.body.message)}`);
        r = await put({ is_vat_registered: true, vat_number: '4123456789', vat_number_verified: true });
        check('with the confirmation the change is saved', r.status === 200 && r.body.profile.is_vat_registered === 1 && r.body.computed.vat_active === true, `${r.status} ${JSON.stringify(r.body && r.body.message)}`);
        const reopened = await view();
        check('reopening the page returns the saved values (persistence)', reopened.profile.is_vat_registered === 1 && reopened.profile.vat_number === '4123456789' && reopened.profile.trading_name === 'Funny Business' && reopened.profile.is_tax_registered === 1, JSON.stringify(reopened.profile));
        check('the VAT confirmation is recorded (who / when)', !!reopened.profile.vat_verified_at && !!reopened.profile.vat_verified_by, JSON.stringify([reopened.profile.vat_verified_at, reopened.profile.vat_verified_by]));
        r = await put({ is_vat_registered: false });
        const unticked = await view();
        check('UNTICKING VAT deletes nothing: the VAT number and the SARS reference stay on file', unticked.profile.vat_number === '4123456789' && unticked.profile.income_tax_reference === '9000000001' && unticked.computed.vat_active === false, JSON.stringify(unticked.computed));
        r = await put({ is_tax_registered: false, is_vat_registered: false });
        check('UNTICKING tax registration keeps the stored reference too', (await view()).profile.income_tax_reference === '9000000001', '');
        // a save that names only one card's fields (what each card's Save button sends) changes only those fields
        const beforePartial = (await view()).profile;
        r = await put({ bbbee_level: 'Level 1 (EME) - partial save test' }, { confirm: false });
        const afterPartial = (await view()).profile;
        check("a save naming only the B-BBEE card's fields changes only those fields", r.status === 200 && afterPartial.bbbee_level === 'Level 1 (EME) - partial save test'
            && ['legal_name', 'registration_number', 'income_tax_reference', 'is_tax_registered', 'contact_email', 'registered_address', 'vat_number', 'directors'].every(k => JSON.stringify(afterPartial[k]) === JSON.stringify(beforePartial[k])), JSON.stringify(afterPartial));
        await put({ bbbee_level: beforePartial.bbbee_level }, { confirm: false });
        const v0 = (await view()).profile.version;
        r = await put({ trading_name: 'Stale' }, { version: v0 - 1 });
        check('an edit made on an out-of-date copy is refused (409 STALE)', r.status === 409 && r.body.code === 'STALE', `${r.status} ${JSON.stringify(r.body)}`);
        let audit = [];
        for (let i = 0; i < 30 && audit.length < 6; i++) {   // rows land just after each response
            audit = await q("SELECT action, old_values, new_values, reason FROM audit_log WHERE table_name = 'business_profile' ORDER BY id DESC LIMIT 20");
            if (audit.length < 6) await sleep(100);
        }
        check('every save is audit-logged with the old and the new values', audit.length >= 4 && audit.some(a => a.action === 'update' && /is_vat_registered/.test(a.new_values)), JSON.stringify(audit.slice(0, 2)));
        check('...a confirmed registration change says so in the audit reason', audit.some(a => /registration change confirmed/.test(a.reason || '')), '');
        check('...and the audit log never holds the raw income-tax reference', !audit.some(a => /9000000001/.test((a.old_values || '') + (a.new_values || ''))), '');

        // director ID: encrypted, hidden, revealable by an administrator only, audited
        r = await put({ director_id_number: '8812275400083' });
        const withId = await view();
        check('a director ID number is accepted, and the API only says "on file"', r.status === 200 && withId.profile.director_id_set === true && !JSON.stringify(withId).includes('8812275400083'), JSON.stringify(withId.profile.director_id_set));
        const raw = await one('SELECT director_id_enc FROM business_profile WHERE id = 1');
        check('...it is stored encrypted, not as the digits', /^enc:v1:/.test(raw.director_id_enc) && !raw.director_id_enc.includes('8812275400083'), String(raw.director_id_enc).slice(0, 12));
        r = await api('POST', URL + '/reveal-director-id', {});
        check('an administrator can reveal it on request', r.status === 200 && r.body.director_id_number === '8812275400083', `${r.status}`);
        check('...and the reveal is audit-logged', (await auditCount("SELECT COUNT(*) n FROM audit_log WHERE table_name = 'business_profile' AND action = 'reveal_director_id'")) >= 1, '');
        r = await put({ clear_director_id: true });
        check('the ID number can be removed', r.status === 200 && (await view()).profile.director_id_set === false, '');

        // ═══ D. the registration configurations and what each one produces ═══
        // 1. tax OFF + VAT OFF
        await put({ is_tax_registered: false, is_vat_registered: false, vat_number_verified: false, business_type: 'company', trading_name: '' });
        let ex = (await view());
        check('config 1 (tax off, VAT off): VAT is not active', ex.computed.vat_active === false && ex.computed.titles.invoice_with_vat === 'INVOICE' && ex.computed.titles.quote === 'QUOTATION', JSON.stringify(ex.computed.titles));
        const b1 = await manual('cfg1');
        r = await quote(b1, true);
        check('config 1: a quotation WITH VAT is refused (400 VAT_NOT_ACTIVE) - the server, not just the greyed-out box', r.status === 400 && r.body.code === 'VAT_NOT_ACTIVE', `${r.status} ${JSON.stringify(r.body)}`);
        check('...and no quotation was written by the refused call', (await one('SELECT COUNT(*) n FROM quotations WHERE booking_id = ?', [b1])).n === 0, '');
        r = await quote(b1, false);
        check('config 1: a quotation WITHOUT VAT is issued as before', r.status === 200, `${r.status} ${JSON.stringify(r.body)}`);
        let qp = await quotePdf(b1);
        check('config 1: the quotation reads QUOTATION, shows the company name and registration number, charges no VAT',
            /QUOTATION/.test(qp.text) && !/\bQUOTE\b(?! DATE| REF)/.test(qp.text) && /MTV CREATIVES \(PTY\) LTD/.test(qp.text) && /Reg No:\s*2025\/575967\/07/.test(qp.text) && !/VAT \(15%\)/.test(qp.text) && !/VAT No:/.test(qp.text), qp.text.slice(0, 700));
        check('config 1: the footer says plainly that the business is not registered for VAT', /Not registered for VAT/.test(qp.text), qp.text.slice(-400));
        check('config 1: registered office and contact are on the document', /Registered office:\s*59 Stone Crest, Frederick Street, Kengies \/ Stone Crest, Fourways, Gauteng, 0059/.test(qp.text) && /bookings@thabisomhlongo\.com/.test(qp.text), qp.text.slice(-500));
        check('config 1: the quotation says how to accept and how long it is valid, with an explicit expiry date', /To accept this quotation, choose Accept/.test(qp.text) && /VALID UNTIL/.test(qp.text) && /QUOTE DATE/.test(qp.text), qp.text.slice(0, 900));
        const qrow1 = await one('SELECT issuer_snapshot, total_amount FROM quotations WHERE booking_id = ?', [b1]);
        const snap1 = JSON.parse(qrow1.issuer_snapshot);
        check('config 1: the issuer is frozen onto the quotation (not VAT-registered)', snap1.legalName === 'MTV CREATIVES (PTY) LTD' && snap1.vatRegistered === false && snap1.registrationNumber === '2025/575967/07', JSON.stringify(snap1));
        check('config 1: the total is the plain sum (R6,500, no VAT)', money(qrow1.total_amount) === 6500, String(qrow1.total_amount));

        // 2. tax ON + VAT OFF
        await put({ is_tax_registered: true, income_tax_reference: '9000000001', is_vat_registered: false });
        ex = await view();
        check('config 2 (tax on, VAT off): income-tax registration does NOT switch VAT on', ex.profile.is_tax_registered === 1 && ex.computed.vat_active === false, JSON.stringify(ex.computed.vat_active));
        const b2 = await manual('cfg2');
        r = await quote(b2, true);
        check('config 2: a quotation with VAT is still refused', r.status === 400 && r.body.code === 'VAT_NOT_ACTIVE', `${r.status}`);
        r = await quote(b2, false);
        qp = await quotePdf(b2);
        check('config 2: documents never print the income-tax reference or a VAT number', r.status === 200 && !/9000000001/.test(qp.text) && !/VAT No:/.test(qp.text) && /Not registered for VAT/.test(qp.text), qp.text.slice(0, 600));
        const meta2 = (await api('GET', '/api/admin/services/meta')).body;
        check('config 2: the Quote Builder is told VAT is not available', meta2.vat_active === false, JSON.stringify(meta2.vat_active));

        // 3. tax ON + VAT ON + number confirmed
        r = await put({ is_vat_registered: true, vat_number: '4123456789', vat_number_verified: true });
        ex = await view();
        check('config 3 (tax on, VAT on, number confirmed): VAT is active', r.status === 200 && ex.computed.vat_active === true && ex.computed.titles.invoice_with_vat === 'TAX INVOICE' && ex.computed.titles.invoice_without_vat === 'INVOICE', JSON.stringify(ex.computed.titles));
        check('config 3: the Quote Builder is told VAT is available', (await api('GET', '/api/admin/services/meta')).body.vat_active === true, '');
        const b3 = await manual('cfg3');
        r = await quote(b3, true);
        check('config 3: a quotation with VAT is issued', r.status === 200, `${r.status} ${JSON.stringify(r.body)}`);
        const qrow3 = await one('SELECT id, issuer_snapshot, total_amount, tax_amount FROM quotations WHERE booking_id = ?', [b3]);
        const want3 = computeDocumentTotals([{ ...items[0], tax_class: 'standard', total_price: 5000 }, { ...items[1], tax_class: 'exempt', total_price: 1500 }], { discount: 0, applyVat: true, vatRate: 0.15 });
        check('config 3: the existing tax engine did the arithmetic (R5,000 taxable + R1,500 exempt -> VAT R750, total R7,250)', money(qrow3.total_amount) === money(want3.total) && money(want3.total) === 7250, `${qrow3.total_amount} vs ${want3.total}`);
        qp = await quotePdf(b3);
        check('config 3: the quotation shows our VAT number (header and footer), VAT line and totals', (qp.text.match(/VAT No:?\s*4123456789/g) || []).length >= 1 && /VAT \(15%\)/.test(qp.text) && /7250\.00/.test(qp.text) && /QUOTATION/.test(qp.text) && !/Not registered for VAT/.test(qp.text), qp.text.slice(0, 900));
        check('config 3: the frozen issuer carries the VAT status', JSON.parse(qrow3.issuer_snapshot).vatRegistered === true && JSON.parse(qrow3.issuer_snapshot).vatNumber === '4123456789', qrow3.issuer_snapshot);

        // accept -> invoice
        const token3 = await getTrackingToken(b3, emails.get(b3));
        const acc = await pub('POST', `/api/public/bookings/${b3}/accept-quote`, { access_token: token3, terms_agreed: true, installment_count: 2 });
        check('config 3: the client can accept the quotation (existing flow)', acc.status === 200, `${acc.status} ${JSON.stringify(acc.body)}`);
        const inv3 = await one("SELECT id, invoice_number, subtotal, tax_amount, total_amount, due_date, issuer_snapshot FROM invoices WHERE booking_id = ? AND status <> 'VOID' ORDER BY id DESC", [b3]);
        check('config 3: an invoice exists with the quotation\'s amounts (VAT R750, total R7,250)', inv3 && money(inv3.tax_amount) === 750 && money(inv3.total_amount) === 7250, JSON.stringify(inv3));
        let ip = await invoicePdf(b3);
        check('config 3: the invoice is titled TAX INVOICE and carries our VAT number, the VAT row and the total',
            /TAX INVOICE/.test(ip.text) && /VAT No:?\s*4123456789/.test(ip.text) && /Subtotal \(excl\. VAT\)/.test(ip.text) && /VAT \(15%\)/.test(ip.text) && /7250\.00/.test(ip.text), ip.text.slice(0, 900));
        check('config 3: the invoice shows invoice date, payment due date and the quotation it came from', /INVOICE DATE/.test(ip.text) && /PAYMENT DUE/.test(ip.text) && ip.text.includes((await one('SELECT quote_number FROM quotations WHERE booking_id = ?', [b3])).quote_number), ip.text.slice(0, 900));
        const dueTxt = new Date(inv3.due_date + 'T00:00:00Z');
        const dueFmt = `${String(dueTxt.getUTCDate()).padStart(2, '0')} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][dueTxt.getUTCMonth()]} ${dueTxt.getUTCFullYear()}`;
        check('config 3: the due date printed is the one stored on the invoice', ip.text.includes(dueFmt), `looking for ${dueFmt}`);
        check('config 3: the invoice carries the frozen issuer too', JSON.parse(inv3.issuer_snapshot).vatRegistered === true, inv3.issuer_snapshot);
        check('config 3: Bill-To shows the company the client typed (customer details on the document)', /BProf Client \(Pty\) Ltd/.test(ip.text), ip.text.slice(0, 600));

        // 4. VAT ticked but the number is not confirmed -> OFF
        r = await put({ vat_number_verified: false });
        ex = await view();
        check('config 4 (VAT ticked, number NOT confirmed): saved, with a warning, and VAT stays OFF', r.status === 200 && ex.computed.vat_active === false && (r.body.warnings || []).some(w => /not yet confirmed/.test(w)), JSON.stringify(r.body && r.body.warnings));
        const b4 = await manual('cfg4');
        r = await quote(b4, true);
        check('config 4: a VAT quotation is refused until the number is confirmed', r.status === 400 && r.body.code === 'VAT_NOT_ACTIVE', `${r.status}`);
        // a NEW number must be re-confirmed
        await put({ vat_number_verified: true });
        r = await put({ vat_number: '4987654321' });
        ex = await view();
        check('config 4: changing the VAT number resets the confirmation (VAT off until it is confirmed again)', ex.profile.vat_number_verified === 0 && ex.computed.vat_active === false, JSON.stringify([ex.profile.vat_number_verified, ex.computed.vat_active]));
        r = await put({ vat_number: '4123456789', vat_number_verified: true });
        check('config 4: confirming the number in the same save switches VAT back on', (await view()).computed.vat_active === true, '');

        // ═══ E. history is never rewritten ═══
        const qBytes = (await quotePdf(b3)).buf, iBytes = (await invoicePdf(b3)).buf;
        const qHash = sha(qBytes), iHash = sha(iBytes);
        const qTotalBefore = (await one('SELECT total_amount, tax_amount FROM quotations WHERE booking_id = ?', [b3]));
        const bookingBefore = (await one('SELECT total_amount, amount_outstanding, quote_details FROM bookings WHERE id = ?', [b3]));
        r = await put({ is_vat_registered: false, vat_number_verified: false });
        check('E: VAT is switched OFF after a quotation and an invoice were issued with VAT', r.status === 200 && (await view()).computed.vat_active === false, '');
        check('E: the issued quotation PDF is byte-for-byte the same', sha((await quotePdf(b3)).buf) === qHash, '');
        check('E: the issued invoice PDF is byte-for-byte the same', sha((await invoicePdf(b3)).buf) === iHash, '');
        const qTotalAfter = (await one('SELECT total_amount, tax_amount FROM quotations WHERE booking_id = ?', [b3]));
        const bookingAfter = (await one('SELECT total_amount, amount_outstanding, quote_details FROM bookings WHERE id = ?', [b3]));
        check('E: the accepted quotation\'s total, VAT and the booking amounts did not move', JSON.stringify(qTotalAfter) === JSON.stringify(qTotalBefore) && JSON.stringify(bookingAfter) === JSON.stringify(bookingBefore), JSON.stringify({ qTotalBefore, qTotalAfter }));
        // regenerating the invoice (a NEW revision) still follows what the client approved, with the identity the quotation was issued under
        r = await api('POST', `/api/admin/bookings/${b3}/invoice/generate`, {});
        check('E: the invoice can still be regenerated (existing flow)', r.status === 200 && r.body.success, `${r.status} ${JSON.stringify(r.body)}`);
        const invAfter = await one("SELECT invoice_number, tax_amount, total_amount FROM invoices WHERE booking_id = ? AND status <> 'VOID' ORDER BY id DESC", [b3]);
        ip = await invoicePdf(b3);
        check('E: ...the new revision keeps the approved VAT and total (R750 / R7,250) although VAT is now OFF', money(invAfter.tax_amount) === 750 && money(invAfter.total_amount) === 7250 && /-R2$/.test(invAfter.invoice_number), JSON.stringify(invAfter));
        check('E: ...and is still a TAX INVOICE under the quotation\'s frozen issuer (number never reused)', /TAX INVOICE/.test(ip.text) && /VAT No:?\s*4123456789/.test(ip.text), ip.text.slice(0, 500));
        check('E: the first invoice is VOID but still on file with its number', (await one("SELECT status FROM invoices WHERE invoice_number = ?", [inv3.invoice_number])).status === 'VOID', '');
        // a NEW quotation after VAT went off follows the new status
        const b5 = await manual('after-off');
        r = await quote(b5, true);
        check('E: a NEW quotation after VAT went off cannot charge VAT', r.status === 400, `${r.status}`);

        // ═══ F. business type, preview, legacy generator, banking, pure rules ═══
        await put({ business_type: 'individual', legal_name: 'Thabiso Mhlongo', is_tax_registered: true, income_tax_reference: '9000000001', is_vat_registered: false });
        const b6 = await manual('individual');
        await quote(b6, false);
        qp = await quotePdf(b6);
        check('F: an individual is represented by name, with no CIPC registration number on the document', /Thabiso Mhlongo/.test(qp.text) && !/Reg No/.test(qp.text) && !/\(PTY\) LTD/.test(qp.text.split('BILL TO')[0]), qp.text.slice(0, 500));
        const stillStored = await view();
        check('F: switching to individual kept the company registration details on file (nothing deleted)', stillStored.profile.registration_number === '2025/575967/07' && stillStored.profile.enterprise_number === 'K2025575967', '');
        await put({ business_type: 'company', legal_name: 'MTV CREATIVES (PTY) LTD' });
        const b7 = await manual('back-to-company');
        await quote(b7, false);
        qp = await quotePdf(b7);
        check('F: switching back to company prints the registration number again', /Reg No:\s*2025\/575967\/07/.test(qp.text) && /MTV CREATIVES \(PTY\) LTD/.test(qp.text), qp.text.slice(0, 400));
        r = await put({ legal_name: "Smith & Sons' Creatives (PTY) LTD" });
        check('F: names with & and \' are stored as typed (not entity-encoded) and print as typed', (await one('SELECT legal_name FROM business_profile')).legal_name === "Smith & Sons' Creatives (PTY) LTD", '');
        await put({ legal_name: 'MTV CREATIVES (PTY) LTD' });

        // letterhead preview
        const vPre = (await view()).profile.version;
        let pv = await apiBinary('POST', URL + '/preview', { document: 'quote', profile: { legal_name: 'Preview Co (PTY) LTD', is_vat_registered: true, vat_number: '4111111111', vat_number_verified: true } });
        let pvText = extractPdfText(pv.buffer);
        check('F: the quotation preview is a real PDF built from the UNSAVED form values', pv.status === 200 && /application\/pdf/.test(pv.contentType) && /Preview Co \(PTY\) LTD/.test(pvText) && /QUOTATION/.test(pvText) && /4111111111/.test(pvText), `${pv.status} ${pvText.slice(0, 300)}`);
        pv = await apiBinary('POST', URL + '/preview', { document: 'invoice', profile: { is_vat_registered: true, vat_number: '4111111111', vat_number_verified: true } });
        check('F: the invoice preview of a VAT-registered draft reads TAX INVOICE', pv.status === 200 && /TAX INVOICE/.test(extractPdfText(pv.buffer)), `${pv.status}`);
        pv = await apiBinary('POST', URL + '/preview', { document: 'invoice', profile: { is_vat_registered: false } });
        check('F: ...and of an unregistered draft reads INVOICE', pv.status === 200 && !/TAX INVOICE/.test(extractPdfText(pv.buffer)) && /INVOICE/.test(extractPdfText(pv.buffer)), `${pv.status}`);
        pv = await apiBinary('POST', URL + '/preview', { document: 'quote', profile: { is_vat_registered: true, vat_number: 'bad' } });
        check('F: a preview of an invalid draft is refused (400)', pv.status === 400, `${pv.status}`);
        const afterPreview = await view();
        check('F: previews never save anything', afterPreview.profile.version === vPre && afterPreview.profile.legal_name === 'MTV CREATIVES (PTY) LTD', '');

        // the generator on its own, with no issuer (older call sites): identity as before the profile existed, title never TAX INVOICE
        const tmp = path.join(os.tmpdir(), `bp-legacy-${process.pid}.pdf`);
        await pdfService.generateDocument('Invoice', { id: 1, name: 'Legacy', email: 'l@example.invalid', cell: '0', event_name: 'x', date: '2026-12-01', event_location: 'y', apply_vat: false, terms: 't' },
            [{ description: 'Line', quantity: 1, unit_price: 9000, total_price: 9000, pricing_model: 'flat_fee' }], tmp, [], 'INV-LEGACY-1', {});
        const legacyText = extractPdfText(fs.readFileSync(tmp)); fs.unlinkSync(tmp);
        check('F: a generator call with no issuer keeps the legacy identity and reads INVOICE, even for R9,000 (no amount-based TAX INVOICE)', /Thabiso Mhlongo Management/.test(legacyText) && /INVOICE/.test(legacyText) && !/TAX INVOICE/.test(legacyText), legacyText.slice(0, 300));

        // banking: this feature reads it, never writes it
        const bankBefore = (await one('SELECT COUNT(*) n FROM bank_details')).n;
        await put({ trading_name: 'Bank check' });
        eq('F: banking details are untouched by profile saves', (await one('SELECT COUNT(*) n FROM bank_details')).n, bankBefore);
        r = await api('PUT', '/api/admin/settings', { settings: { business_vat_number: '4999999999', vat_number: '4999999999' } });
        check('F: the generic settings route cannot reach the profile', (await one('SELECT vat_number FROM business_profile')).vat_number !== '4999999999', '');
        await put({ trading_name: '' });

        // pure rules
        const iss = (over) => core.issuerView(Object.assign({}, original, { is_tax_registered: 1, is_vat_registered: 1, vat_number: '4123456789', vat_number_verified: 1 }, over));
        check('rules: documentTitle - quotation is always QUOTATION', core.documentTitle('Quote', iss({}), true) === 'QUOTATION' && core.documentTitle('Quote', iss({ is_vat_registered: 0 }), false) === 'QUOTATION', '');
        check('rules: TAX INVOICE needs registered + confirmed + VAT charged on that document',
            core.documentTitle('Invoice', iss({}), true) === 'TAX INVOICE' && core.documentTitle('Invoice', iss({}), false) === 'INVOICE'
            && core.documentTitle('Invoice', iss({ vat_number_verified: 0 }), true) === 'INVOICE' && core.documentTitle('Invoice', iss({ is_vat_registered: 0 }), true) === 'INVOICE'
            && core.documentTitle('Invoice', iss({ is_tax_registered: 0 }), true) === 'INVOICE' && core.documentTitle('Invoice', iss({ vat_number: '1234567890' }), true) === 'INVOICE', '');
        check('rules: a VAT number never reaches a document unless VAT is active', iss({ vat_number_verified: 0 }).vatNumber === '' && iss({}).vatNumber === '4123456789', '');
        const advice = core.taxInvoiceAdvice(iss({}), { total: 7250, vatCharged: true, clientName: 'A', clientAddress: '', clientVat: '', clientCompany: 'Acme' });
        check('rules: over R5,000 a VAT-registered issuer is ADVISED (not blocked) to capture the customer address and VAT number', advice.length === 2, JSON.stringify(advice));
        check('client VAT number: spaces/dashes ignored, empty = none, anything but 10 digits starting with 4 is refused', core.normaliseClientVat(' 4010 123-456 ') === '4010123456' && core.normaliseClientVat('') === '' && core.normaliseClientVat(null) === '' && core.normaliseClientVat('3010123456') === null && core.normaliseClientVat('401012345') === null && core.normaliseClientVat('40101234567') === null && core.normaliseClientVat('4O10123456') === null, '');
        // The quotation/invoice header's business name (2026-10-25): trading name when meaningfully set, else the legal name - never
        // both, never a placeholder, never mangled (no auto "(PTY) LTD").
        check('rules: documentBusinessName - the trading name leads when set (trimmed); the legal name is untouched either way',
            core.documentBusinessName(iss({ trading_name: '  Thabiso Comedy  ' })) === 'Thabiso Comedy'
            && core.documentBusinessName(iss({ trading_name: '' })) === 'MTV CREATIVES (PTY) LTD'
            && core.documentBusinessName(iss({ trading_name: '   ' })) === 'MTV CREATIVES (PTY) LTD'   // whitespace-only counts as not set
            && core.documentBusinessName({ tradingName: '', legalName: '' }) === null, '');            // neither configured - never invented
        // A fixture of our own, never the live `original` row - an admin can (and, mid-session, did) retype the stored address as a
        // single line through Settings, which would make this assert on whatever the owner currently has on file rather than on the rule.
        const multiLineAddr = '59 Stone Crest, Frederick Street\nKengies / Stone Crest, Fourways\nGauteng, 0059';
        check('rules: addressLines - the stored address split one component per line (never comma-joined, unlike registeredOffice), capped at 4',
            JSON.stringify(core.issuerView(Object.assign({}, original, { registered_address: multiLineAddr, physical_address: '', postal_address: '' })).addressLines) === JSON.stringify(['59 Stone Crest, Frederick Street', 'Kengies / Stone Crest, Fourways', 'Gauteng, 0059'])
            // registered/physical/postal all empty - the same fallback chain registeredOffice already uses - gives no lines, never a blank one
            && JSON.stringify(core.issuerView(Object.assign({}, original, { registered_address: '', physical_address: '', postal_address: '' })).addressLines) === '[]'
            && core.issuerView(Object.assign({}, original, { registered_address: 'a\nb\nc\nd\ne\nf' })).addressLines.length === 4, '');
        check('rules: no advice for small invoices, for non-VAT issuers or when VAT is not charged', core.taxInvoiceAdvice(iss({}), { total: 4000, vatCharged: true }).length === 0 && core.taxInvoiceAdvice(iss({ is_vat_registered: 0 }), { total: 9000, vatCharged: true }).length === 0 && core.taxInvoiceAdvice(iss({}), { total: 9000, vatCharged: false }).length === 0, '');
        check('rules: B-BBEE expiry states (valid / expiring in 60 days / expired / none)', core.bbbeeStatus({ bbbee_expiry_date: '2026-12-31' }, '2026-10-23').state === 'valid' && core.bbbeeStatus({ bbbee_expiry_date: '2026-11-18' }, '2026-10-23').state === 'expiring'
            && core.bbbeeStatus({ bbbee_expiry_date: '2026-10-22' }, '2026-10-23').state === 'expired' && core.bbbeeStatus({}, '2026-10-23').state === 'none', '');
        const warn = core.validateProfile(core.normalizeInput({ business_type: 'company', legal_name: 'X', registration_number: '2025/575967/07', bbbee_expiry_date: '2026-11-18' }), '2026-10-23');
        check('rules: an expiring B-BBEE certificate produces a warning', warn.warnings.some(w => /expires in 26 days/.test(w)), JSON.stringify(warn.warnings));
        check('rules: the registration / enterprise / tax / VAT / certificate numbers are validated separately, never interchangeably',
            core.PATTERNS.registration_number.test('2025/575967/07') && !core.PATTERNS.registration_number.test('K2025575967') && core.PATTERNS.enterprise_number.test('K2025575967') && !core.PATTERNS.vat_number.test('9000000001') && !core.PATTERNS.income_tax_reference.test('2025/575967/07'), '');
        // SARS number families are told apart by their first digit (VAT 4, PAYE 7, income tax 0/1/2/3/9) - only the clear mix-ups are refused
        const base = { business_type: 'company', legal_name: 'X', registration_number: '2025/575967/07' };
        const errOf = (patch, field) => core.validateProfile(core.normalizeInput(Object.assign({}, base, patch))).errors[field];
        check('rules: an income-tax reference that starts with 4 is refused and pointed at VAT', /looks like a VAT number/.test(errOf({ is_tax_registered: true, income_tax_reference: '4123456789' }, 'income_tax_reference') || ''), String(errOf({ income_tax_reference: '4123456789' }, 'income_tax_reference')));
        check('rules: one that starts with 7 is refused and pointed at PAYE', /PAYE/.test(errOf({ income_tax_reference: '7123456789' }, 'income_tax_reference') || ''), '');
        check('rules: genuine income-tax references are accepted - the owner\'s own (9...), 0 / 1 / 2 / 3, and other first digits (the published prefix lists are secondary sources)',
            ['9000000001', '0123456789', '1123456789', '2123456789', '3123456789', '5123456789'].every(n => !errOf({ income_tax_reference: n }, 'income_tax_reference')), '');
        check('rules: a VAT number that is really an income-tax reference (starts 0/1/2/3/9) is refused with that explanation', /looks like an income-tax reference/.test(errOf({ is_tax_registered: true, is_vat_registered: true, vat_number: '9000000001' }, 'vat_number') || '') && /looks like an income-tax reference/.test(errOf({ vat_number: '0123456789' }, 'vat_number') || ''), String(errOf({ vat_number: '9000000001' }, 'vat_number')));
        check('rules: other bad VAT numbers get the plain message; a good one passes', errOf({ vat_number: '5123456789' }, 'vat_number') === 'A South African VAT number is 10 digits and starts with 4.' && errOf({ vat_number: '41234567' }, 'vat_number') === 'A South African VAT number is 10 digits and starts with 4.' && !errOf({ vat_number: '4123456789' }, 'vat_number'), '');
        check('rules: the seed carries no secrets and both switches OFF', (() => { const s = require('../lib/business-profile-schema').seedRow({}); return !s.income_tax_reference && !s.director_id_enc && !s.is_tax_registered && !s.is_vat_registered; })(), '');
        check('rules: an existing COMPANY_VAT_NUMBER is carried over once (it already made the old PDF code add VAT), and nothing else switches VAT on', (() => { const s = require('../lib/business-profile-schema').seedRow({ COMPANY_VAT_NUMBER: '4 123 456 789' }); return s.is_vat_registered === 1 && s.vat_number === '4123456789'; })(), '');
    } finally {
        // put the throwaway DB back as support.js made it (VAT vendor), whatever happened above
        const o = original || {};
        await run(`UPDATE business_profile SET business_type=?, legal_name=?, trading_name=?, is_tax_registered=1, income_tax_reference='9000000001', is_vat_registered=1, vat_number='4123456789', vat_number_verified=1,
                   registration_number=?, director_id_enc=NULL WHERE id = 1`, [o.business_type || 'company', o.legal_name || 'MTV CREATIVES (PTY) LTD', o.trading_name || '', o.registration_number || '2025/575967/07']).catch(() => {});
        await new Promise(res => rw.close(res));
    }
};
