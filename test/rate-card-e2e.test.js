// Rate card 2026 - Phase 7: the END-TO-END gate. One synthetic client journey, driven through the real routes on an isolated database copy
// (test/support.js: SMTP mocked, PayFast pinned to the SANDBOX merchant, the real database never touched), every record tagged with the unique
// reference SERVICE-RATE-E2E-2026:
//   E1  customer request through the public booking route, for a FIXED-price rate-card service
//   E2  admin review: the booking shows the service, its price type and no quotation yet; the customer sees no price
//   E3  the quotation, through the Quote Builder route: stored row, PDF, e-mail, customer view, re-download
//   E4  the customer accepts: status, payment plan, contract, ONE invoice that carries the approved amounts and VAT once, no duplicate on repeat
//   E5  payment: deposit then balance through the payment route + a SIMULATED PayFast notification; bad notifications are not credited
//   E6  the whole chain traces back consistently (service -> booking -> acceptance -> quotation -> invoice -> payment -> financial records)
//   E7  pre-existing records are exactly as they were
//   E8  a RANGE, a "FROM" and an ENQUIRY-ONLY service are never presented or charged as a fixed price
//   E9  clean-up: nothing outside the throwaway database was touched, and the project's clean-up tool plans to remove exactly these records
//
// IMPORTANT, and the report must say it: the PayFast notification here is a SIMULATION posted to our own webhook (the sandbox lets a bad
// signature through, but still checks merchant id, booking, amount against the payment intent, and replays). It is NOT a confirmed gateway
// sandbox transaction - that needs PayFast sandbox credentials, a public notify URL and a buyer checkout, none of which exist in a test run.
// No real charge is possible: no code path here talks to PayFast's payment pages.
//
// Date offsets 1360-1399 are reserved for this file (grep the WHOLE test folder before picking: service-visibility books through a helper,
// `mk(1200, ...)`, which a search for `future(` misses).
const crypto = require('crypto');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3');

const REF = 'SERVICE-RATE-E2E-2026';
const MERCHANT_ID = '10000100';   // the sandbox merchant test/support.js pins in the server environment

module.exports = async function ({ check, api, pub, one, q, future, sleep, apiBinary, getTrackingToken, extractPdfText, getChildLog, TEST_DB }) {
    const logStart = getChildLog().length;   // only what the server logs DURING this journey is inspected below
    const money = (n) => Math.round(Number(n) * 100) / 100;
    const same = (a, b) => money(a) === money(b);
    let offset = 1360, seq = 0;
    const emails = new Map();
    const text = (buf) => extractPdfText(buf).replace(/\s+/g, ' ');
    const poll = async (fn, ms = 30000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return v; await sleep(250); } };
    const isPdf = (d) => d.status === 200 && d.buffer.slice(0, 4).toString('latin1') === '%PDF';

    // ---- a fingerprint of everything that existed before the journeys: amounts only, so a background job flipping a status cannot trip it ----
    const fingerprint = async (maxBooking) => {
        const h = crypto.createHash('sha256');
        h.update(JSON.stringify(await q('SELECT id, total_amount, amount_paid, amount_outstanding, quote_amount FROM bookings WHERE id <= ? ORDER BY id', [maxBooking])));
        h.update(JSON.stringify(await q('SELECT id, booking_id, total_amount FROM quotations WHERE booking_id <= ? ORDER BY id', [maxBooking])));
        h.update(JSON.stringify(await q('SELECT id, booking_id, total_amount, subtotal, tax_amount FROM invoices WHERE booking_id <= ? ORDER BY id', [maxBooking])));
        h.update(JSON.stringify(await q('SELECT id, booking_id, amount, transaction_type FROM transactions WHERE booking_id <= ? ORDER BY id', [maxBooking])));
        return h.digest('hex');
    };
    const maxBookingBefore = (await one('SELECT COALESCE(MAX(id), 0) m FROM bookings')).m;
    const realDbWal = (() => { try { return fs.statSync(path.join(__dirname, '..', 'database.sqlite-wal')).mtimeMs; } catch (e) { return null; } })();
    const realDbSize = (() => { try { return fs.statSync(path.join(__dirname, '..', 'database.sqlite')).size; } catch (e) { return null; } })();
    const printBefore = await fingerprint(maxBookingBefore);
    const catalogue = await q('SELECT id, name, price_type, default_price, price_min, price_max, tax_class, is_active FROM services');
    const catalogueBefore = JSON.stringify(catalogue);

    const byName = async (name) => (await one('SELECT id, name, price_type, default_price, price_min, price_max, price_unit, tax_class, is_active FROM services WHERE name = ?', [name]));
    const fixed = await byName('Club – 10 min Set (Guest Spot)');                 // fixed R5,000
    const range = await byName('Writing – Head Writer (per month)');              // range R90,000 - R140,000 per month
    const from = await byName('Private – Performance + MC Combo');                // from R50,000
    const enquire = await one("SELECT id, name, price_type FROM services WHERE price_type = 'enquire' AND is_active = 1 AND COALESCE(is_deleted, 0) = 0 ORDER BY id LIMIT 1");
    const enquireMin = await one("SELECT id, name, price_type FROM services WHERE price_type = 'enquire_min' AND is_active = 1 AND COALESCE(is_deleted, 0) = 0 ORDER BY id LIMIT 1");
    check('E0 fixture: the rate-card services under test exist, active, with the price type the PDF gives them',
        !!fixed && fixed.price_type === 'fixed' && money(fixed.default_price) === 5000 && fixed.is_active === 1
        && !!range && range.price_type === 'range' && money(range.price_min) === 90000 && money(range.price_max) === 140000
        && !!from && from.price_type === 'from' && !!enquire, JSON.stringify({ fixed, range, from, enquire }));

    // ---- booking helpers ----
    const workingDate = async () => {
        for (let n = offset; n < offset + 60; n++) {
            const d = future(n);
            const dow = new Date(d + 'T12:00:00').getDay();
            const wh = await one('SELECT start_time, is_working_day FROM working_hours WHERE day_of_week = ?', [dow]);
            const busy = (await one("SELECT COUNT(*) c FROM bookings WHERE date = ? AND status NOT IN ('CANCELLED','EXPIRED')", [d])).c;
            if ((!wh || wh.is_working_day) && !busy) { offset = n + 1; return { date: d, start: (wh && wh.start_time) || '09:00' }; }
        }
        return null;
    };
    const submit = async (label, serviceId) => {
        let last = null;
        for (let attempt = 0; attempt < 6; attempt++) {
            const wd = await workingDate();
            if (!wd) break;
            const email = `rate-e2e.${Date.now()}.${seq++}@example.invalid`;
            const r = await pub('POST', '/api/public/bookings', {
                name: `E2E Client ${label}`, email, cell: '+27821234567', event_name: `${REF} ${label}`, event_date: wd.date, event_start_time: wd.start.replace(/^0/, ''),
                performance_duration: '60', event_location: 'E2E Hall', event_type: 'Corporate', message: `${REF} synthetic booking for the rate-card end-to-end test.`,
                services: [{ service_id: serviceId }], popia_consent: true
            });
            last = r;
            if (r.status === 200 && r.body && r.body.success) { emails.set(r.body.booking_id, email); return { id: r.body.booking_id, email, date: wd.date, resp: r }; }
        }
        return { id: null, resp: last };
    };
    const tokenOf = (id) => getTrackingToken(id, emails.get(id));
    const track = async (id) => (await pub('POST', `/api/public/bookings/${id}/track`, { access_token: await tokenOf(id) })).body || {};
    const quoteVia = async (id, items, over = {}) => {
        const bk = await one('SELECT date FROM bookings WHERE id = ?', [id]);
        const expiry = new Date(Date.parse(bk.date) - 10 * 86400000).toISOString().slice(0, 10);
        return api('POST', `/api/admin/bookings/${id}/quote`, { quote_expiry_date: expiry, terms: `${REF} terms apply.`, apply_vat: false, discount: 0, items, ...over });
    };
    const mailOf = async (subject, id) => {
        const row = await poll(async () => one("SELECT body FROM notifications WHERE type='email' AND subject = ? AND recipient_email = ? ORDER BY id DESC LIMIT 1", [subject, emails.get(id)]), 15000);
        if (!row) return '';
        let html = row.body; try { html = JSON.parse(row.body).htmlContent || row.body; } catch (e) { /* plain */ }
        return html.replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    };
    const itn = (fields) => pub('POST', '/api/payment/webhook/payfast', { merchant_id: MERCHANT_ID, payment_method: 'cc', signature: 'not-a-real-signature', ...fields });
    const logsOf = async (id) => (await q('SELECT event_type FROM payment_logs WHERE booking_id = ?', [id])).map(x => x.event_type);
    const ledger = (id) => one('SELECT status, payment_status, total_amount, amount_paid, amount_outstanding, quote_amount FROM bookings WHERE id = ?', [id]);

    // ══════════ E1. The customer's request, through the public booking route ══════════
    const A = await submit('fixed', fixed.id);
    check('E1 customer request for the fixed-price service is accepted by the public booking route', !!A.id, JSON.stringify(A.resp && { s: A.resp.status, b: A.resp.body }));
    if (!A.id) return;
    const bkA = await one('SELECT status, event_name FROM bookings WHERE id = ?', [A.id]);
    const svcA = await q('SELECT service_id, quantity_minutes, unit_price FROM booking_services WHERE booking_id = ?', [A.id]);
    check('E1 saved as NEW with the chosen service and its catalogue fee as an internal snapshot (R5,000.00), tagged ' + REF,
        bkA.status === 'NEW' && new RegExp(REF).test(bkA.event_name) && svcA.length === 1 && svcA[0].service_id === fixed.id && same(svcA[0].unit_price, 5000), JSON.stringify({ bkA, svcA }));

    // ══════════ E2. Admin review; what the customer can see before a quotation ══════════
    const detA = (await api('GET', `/api/admin/bookings/${A.id}`)).body || {};
    const lineA = (detA.services || [])[0] || {};
    check('E2 admin sees the service by its rate-card name, price type "fixed", no quotation yet',
        lineA.service_name === fixed.name && lineA.price_type === 'fixed' && !lineA.quote_required && detA.has_quote !== 1, JSON.stringify({ name: lineA.service_name, type: lineA.price_type, qr: lineA.quote_required, hq: detA.has_quote }));
    const trkA0 = await track(A.id);
    check('E2 the customer sees NO price before a quotation: no total, no quote amount, no line prices', !!trkA0.booking && trkA0.booking.total_amount === null && trkA0.booking.quote_amount === null
        && (trkA0.services || []).every(s => s.unit_price === undefined && s.line_total === undefined), JSON.stringify({ b: trkA0.booking, s: trkA0.services }));
    const pubList = (await pub('GET', '/api/public/services')).body;
    const pubJson = JSON.stringify(pubList);
    check('E2 the public service list carries no price fields at all', !!pubList && !/default_price|base_price|price_min|price_max|unitPrice|unit_price/.test(pubJson), pubJson.slice(0, 300));

    // ══════════ E3. The quotation, through the Quote Builder route ══════════
    const taxable = fixed.tax_class === 'standard';
    const qA = await quoteVia(A.id, [{ service_id: fixed.id, description: fixed.name, quantity: 1, unit_price: 5000, pricing_model: 'flat_fee' }], { apply_vat: true });
    const expectVat = taxable ? 750 : 0, expectTotal = 5000 + expectVat;
    const quoteRow = await one('SELECT id, version, total_amount, status, quote_number FROM quotations WHERE booking_id = ? ORDER BY id DESC', [A.id]);
    const qd = JSON.parse((await one('SELECT quote_details FROM bookings WHERE id = ?', [A.id])).quote_details || '{}');
    check('E3 the Quote Builder route issues version 1: R5,000.00 + VAT once = R' + expectTotal + '.00, VAT rate and tax class stored with it',
        qA.status === 200 && !!quoteRow && quoteRow.version === 1 && same(quoteRow.total_amount, expectTotal) && same(qd.vat, expectVat) && qd.vat_rate === 0.15 && (qd.items || [])[0].tax_class === fixed.tax_class,
        JSON.stringify({ s: qA.status, quoteRow, vat: qd.vat, rate: qd.vat_rate }));
    check('E3 the booking moved to QUOTED', (await ledger(A.id)).status === 'QUOTED');
    const qPdf = await apiBinary('GET', `/api/admin/bookings/${A.id}/quote/${quoteRow.id}/download`);
    const qTxt = isPdf(qPdf) ? text(qPdf.buffer) : '';
    check('E3 the quotation PDF carries the quote number, the line, the VAT once and the total, plus the pricing conditions (ZAR, VAT, travel / accommodation / rider)',
        isPdf(qPdf) && qTxt.includes(quoteRow.quote_number) && /R 5000\.00/.test(qTxt) && (taxable ? new RegExp(`VAT \\(15%\\) R 750\\.00`).test(qTxt) : true)
        && new RegExp(`TOTAL \\(incl\\. VAT\\) R ${expectTotal}\\.00`).test(qTxt) && /PRICING CONDITIONS/.test(qTxt) && /South African rand \(ZAR\)/.test(qTxt) && /travel, accommodation and rider/.test(qTxt), qTxt.slice(0, 600));
    const qMail = await mailOf(`Quotation for Booking #${A.id}`, A.id);
    check('E3 the quotation e-mail states the total and the same conditions', new RegExp(`R ?${expectTotal}\\.00`).test(qMail) && /South African rand/.test(qMail) && /travel, accommodation and rider/.test(qMail), qMail.slice(0, 500));
    const trkA1 = await track(A.id);
    check('E3 the customer now sees the quoted amount - and only now', !!trkA1.booking && same(trkA1.booking.quote_amount, expectTotal), JSON.stringify(trkA1.booking));
    const redl = await fetch(`${require('./support').BASE}/api/public/bookings/${A.id}/quote/download`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ access_token: await tokenOf(A.id) }) });
    const redlBuf = Buffer.from(await redl.arrayBuffer());
    check('E3 re-opening the quotation (the customer\'s own download) gives the same document', redl.status === 200 && redlBuf.slice(0, 4).toString('latin1') === '%PDF' && text(redlBuf).includes(quoteRow.quote_number), `${redl.status}`);

    // ══════════ E4. Acceptance, payment plan, contract, invoice ══════════
    const acc = await pub('POST', `/api/public/bookings/${A.id}/accept-quote`, { access_token: await tokenOf(A.id), terms_agreed: true, installment_count: 2 });
    const invA = await poll(async () => { const r = await q("SELECT id, invoice_number, subtotal, tax_amount, total_amount, status FROM invoices WHERE booking_id = ? AND UPPER(status) <> 'VOID'", [A.id]); return r.length ? r : null; });
    const schedA = await q("SELECT description, expected_amount, status FROM payment_schedules WHERE booking_id = ? AND LOWER(COALESCE(status,'pending')) NOT IN ('superseded','cancelled') ORDER BY due_date, id", [A.id]);
    check('E4 acceptance is recorded (200, ACCEPTED) with a 2-payment plan that adds up to the quotation', acc.status === 200 && (await ledger(A.id)).status === 'ACCEPTED' && schedA.length === 2 && same(schedA.reduce((s, x) => s + x.expected_amount, 0), expectTotal), JSON.stringify({ acc: acc.status, schedA }));
    check('E4 exactly ONE live invoice, carrying the approved amounts: subtotal R5,000.00, VAT R' + expectVat + '.00 (once), total R' + expectTotal + '.00',
        !!invA && invA.length === 1 && same(invA[0].subtotal, 5000) && same(invA[0].tax_amount, expectVat) && same(invA[0].total_amount, expectTotal), JSON.stringify(invA));
    const invLines = invA ? await q('SELECT description, quantity, unit_price FROM invoice_line_items WHERE invoice_id = ?', [invA[0].id]) : [];
    check('E4 the invoice lines are the quoted lines (same service name, R5,000.00), not recalculated from today\'s catalogue', invLines.length === 1 && invLines[0].description === fixed.name && same(invLines[0].unit_price, 5000), JSON.stringify(invLines));
    const iPdf = await apiBinary('GET', `/api/admin/bookings/${A.id}/invoice/download`);
    const iTxt = isPdf(iPdf) ? text(iPdf.buffer) : '';
    check('E4 the invoice PDF equals the record: number, total, VAT once, payment schedule rows, one page',
        isPdf(iPdf) && !!invA && iTxt.includes(invA[0].invoice_number) && new RegExp(`TOTAL \\(incl\\. VAT\\) R ${expectTotal}\\.00`).test(iTxt) && (iPdf.buffer.toString('latin1').match(/\/Type \/Page\b/g) || []).length === 1
        && schedA.every(s => iTxt.includes(`R ${money(s.expected_amount).toFixed(2)}`)), iTxt.slice(-500));
    const contractA = await poll(async () => one('SELECT status, contract_amount FROM contracts WHERE booking_id = ?', [A.id]), 15000);   // generated just after the acceptance response
    check('E4 a draft contract was generated for the accepted fee', !!contractA && contractA.status === 'draft' && same(contractA.contract_amount, expectTotal), JSON.stringify(contractA));
    const acc2 = await pub('POST', `/api/public/bookings/${A.id}/accept-quote`, { access_token: await tokenOf(A.id), terms_agreed: true });
    const regen = await api('POST', `/api/admin/bookings/${A.id}/invoice/generate`, {});
    const invAll = await q('SELECT id, status, total_amount FROM invoices WHERE booking_id = ? ORDER BY id', [A.id]);
    check('E4 repeating the acceptance is refused (400 "already accepted") and re-generating the invoice leaves ONE live invoice, the earlier one VOID with its amounts',
        [400, 409].includes(acc2.status) && regen.status === 200 && invAll.filter(x => x.status !== 'VOID').length === 1 && invAll.filter(x => x.status === 'VOID').length === 1 && invAll.every(x => same(x.total_amount, expectTotal)), JSON.stringify({ acc2: acc2.status, regen: regen.status, invAll }));

    // ══════════ E5. Payment: deposit, then balance, plus the notifications that must NOT be credited ══════════
    const revenue = async () => Number((((await api('GET', '/api/admin/financials/stats')).body || {}).stats || {}).revenue) || 0;
    const rev0 = await revenue();
    const half = money(expectTotal / 2);
    const payDep = await pub('POST', `/api/public/bookings/${A.id}/pay`, { payment_type: 'DEPOSIT', access_token: await tokenOf(A.id) });
    const pfDep = (payDep.body || {}).pfData || {};
    const intentDep = await poll(async () => one('SELECT expected_amount, status FROM payfast_payment_intents WHERE m_payment_id = ?', [pfDep.m_payment_id]), 10000);   // written just after the response
    check('E5 the payment route asks for the first milestone only (R' + half.toFixed(2) + '), with the sandbox merchant, and records a payment intent for it',
        payDep.status === 200 && pfDep.amount === half.toFixed(2) && pfDep.merchant_id === MERCHANT_ID && !!intentDep && same(intentDep.expected_amount, half), JSON.stringify({ s: payDep.status, pf: pfDep.amount, intent: intentDep }));
    const itnDep = await itn({ m_payment_id: pfDep.m_payment_id, pf_payment_id: `${REF}-DEP`, payment_status: 'COMPLETE', amount_gross: pfDep.amount });
    await poll(async () => (await one("SELECT COUNT(*) c FROM transactions WHERE booking_id = ? AND reference = ? AND source = 'payfast'", [A.id, `${REF}-DEP`])).c >= 1);
    const lgDep = await ledger(A.id);
    check('E5 [SIMULATED ITN] the deposit notification is credited once: DEPOSIT_PAID, CONFIRMED, R' + half.toFixed(2) + ' paid, one PayFast transaction',
        itnDep.status === 200 && lgDep.payment_status === 'DEPOSIT_PAID' && lgDep.status === 'CONFIRMED' && same(lgDep.amount_paid, half)
        && (await one("SELECT COUNT(*) c FROM transactions WHERE booking_id = ? AND source = 'payfast'", [A.id])).c === 1, JSON.stringify({ itn: itnDep.status, lgDep }));
    await itn({ m_payment_id: pfDep.m_payment_id, pf_payment_id: `${REF}-DEP`, payment_status: 'COMPLETE', amount_gross: pfDep.amount });
    await poll(async () => (await logsOf(A.id)).includes('IGNORED_DUPLICATE'));
    check('E5 [SIMULATED ITN] a replay of the same notification is ignored - no second credit', (await one("SELECT COUNT(*) c FROM transactions WHERE booking_id = ? AND source = 'payfast'", [A.id])).c === 1 && same((await ledger(A.id)).amount_paid, half), JSON.stringify(await logsOf(A.id)));
    check('E5 the first milestone is marked paid and the balance milestone is still due',
        (await q("SELECT status FROM payment_schedules WHERE booking_id = ? AND LOWER(COALESCE(status,'pending')) NOT IN ('superseded','cancelled') ORDER BY due_date, id", [A.id])).map(x => x.status.toLowerCase())[0] === 'paid', JSON.stringify(await q('SELECT description, status FROM payment_schedules WHERE booking_id = ?', [A.id])));

    const payBal = await pub('POST', `/api/public/bookings/${A.id}/pay`, { payment_type: 'FULL', access_token: await tokenOf(A.id) });
    const pfBal = (payBal.body || {}).pfData || {};
    check('E5 the balance request is the remaining R' + half.toFixed(2) + ' - not the whole quotation again', payBal.status === 200 && pfBal.amount === half.toFixed(2), JSON.stringify({ s: payBal.status, amount: pfBal.amount, body: payBal.body && payBal.body.message }));
    const txBefore = (await one("SELECT COUNT(*) c FROM transactions WHERE booking_id = ? AND source = 'payfast'", [A.id])).c;
    // NOT TESTED here, on purpose: a notification for the WRONG AMOUNT (and a bad signature, an unknown source address, a failed gateway
    // confirmation). routes/public/payment.js hard-rejects all of those in PRODUCTION only (`if (!isSandbox) return;`) and logs-and-continues in
    // PayFast sandbox mode, which is what every test server runs - so a wrong-amount notification IS credited here by design (found by an
    // earlier version of this test, which posted R1.00 against a R2,875.00 request and watched R1.00 land on the booking). It cannot be
    // demonstrated without a production-mode server, and a production-mode server also needs PayFast's own IP addresses.
    await itn({ m_payment_id: pfBal.m_payment_id, pf_payment_id: `${REF}-FAILED`, payment_status: 'FAILED', amount_gross: pfBal.amount });
    await poll(async () => (await logsOf(A.id)).includes('STATUS_FAILED'));
    await itn({ m_payment_id: pfBal.m_payment_id, pf_payment_id: `${REF}-CANCELLED`, payment_status: 'CANCELLED', amount_gross: pfBal.amount });
    await poll(async () => (await logsOf(A.id)).includes('STATUS_CANCELLED'));
    const lgBad = await ledger(A.id);
    check('E5 [SIMULATED ITN] a FAILED and a CANCELLED notification are logged but NEVER credited as a payment; the booking stays DEPOSIT_PAID',
        (await one("SELECT COUNT(*) c FROM transactions WHERE booking_id = ? AND source = 'payfast'", [A.id])).c === txBefore && same(lgBad.amount_paid, half) && lgBad.payment_status === 'DEPOSIT_PAID', JSON.stringify({ lgBad, logs: await logsOf(A.id) }));
    const itnBal = await itn({ m_payment_id: pfBal.m_payment_id, pf_payment_id: `${REF}-BAL`, payment_status: 'COMPLETE', amount_gross: pfBal.amount });
    await poll(async () => (await one("SELECT COUNT(*) c FROM transactions WHERE booking_id = ? AND reference = ? AND source = 'payfast'", [A.id, `${REF}-BAL`])).c >= 1);
    await poll(async () => (await ledger(A.id)).payment_status === 'PAID');
    const lgPaid = await ledger(A.id);
    check('E5 [SIMULATED ITN] the balance notification completes the payment: PAID, R' + expectTotal + '.00 paid, nothing outstanding',
        itnBal.status === 200 && lgPaid.payment_status === 'PAID' && same(lgPaid.amount_paid, expectTotal) && same(lgPaid.amount_outstanding, 0), JSON.stringify(lgPaid));
    const settledPaid = async () => {
        const inv = await one("SELECT status FROM invoices WHERE booking_id = ? AND UPPER(status) <> 'VOID'", [A.id]);
        const ms = await q("SELECT description, status FROM payment_schedules WHERE booking_id = ? AND LOWER(COALESCE(status,'pending')) NOT IN ('superseded','cancelled')", [A.id]);
        return { inv: inv && inv.status, ms: ms.map(x => String(x.status).toLowerCase()), ok: !!inv && inv.status === 'PAID' && ms.length > 0 && ms.every(x => String(x.status).toLowerCase() === 'paid') };
    };
    await poll(async () => (await settledPaid()).ok, 20000);
    const paidState = await settledPaid();
    check('E5 the live invoice is marked PAID and both milestones are paid', paidState.ok, JSON.stringify(paidState));

    // ══════════ E6. The whole chain agrees ══════════
    const txAll = await q("SELECT amount, transaction_type, source, status FROM transactions WHERE booking_id = ?", [A.id]);
    const live = await q("SELECT total_amount FROM invoices WHERE booking_id = ? AND UPPER(status) <> 'VOID'", [A.id]);
    const schedSum = (await q("SELECT expected_amount FROM payment_schedules WHERE booking_id = ? AND LOWER(COALESCE(status,'pending')) NOT IN ('superseded','cancelled')", [A.id])).reduce((s, x) => s + x.expected_amount, 0);
    const rev1 = await revenue();
    const recCsvText = (await apiBinary('GET', '/api/admin/reconciliation/export/csv')).buffer.toString('utf8').split(/\r?\n/);
    const recHead = recCsvText[0].split(','), recRow = recCsvText.find(l => l.startsWith(A.id + ',')); const rc = recRow ? recRow.split(',') : [];
    check('E6 quotation = invoice = booking total = payment plan = money received, to the cent, with exactly two payment rows and no duplicates',
        same(quoteRow.total_amount, expectTotal) && live.length === 1 && same(live[0].total_amount, expectTotal) && same(lgPaid.total_amount, expectTotal) && same(schedSum, expectTotal)
        && same(txAll.filter(x => x.transaction_type === 'payment').reduce((s, x) => s + x.amount, 0), expectTotal) && txAll.length === 2, JSON.stringify({ txAll, schedSum, live }));
    check('E6 the dashboard revenue rose by exactly what was paid, once (R' + expectTotal + '.00); the reconciliation row shows R' + expectTotal + '.00 received and no overpayment',
        same(rev1 - rev0, expectTotal) && same(rc[recHead.indexOf('Effective_Received')], expectTotal) && rc[recHead.indexOf('OverpaymentWarning')] === 'NO', JSON.stringify({ delta: rev1 - rev0, rc }));
    const audit = await q("SELECT action FROM audit_log WHERE record_id = ? AND table_name IN ('bookings','quotations','invoices')", [A.id]);
    check('E6 the audit trail recorded the quotation, the acceptance and the payments', ['QUOTE_GENERATED', 'QUOTE_ACCEPTED'].every(a => audit.some(x => x.action === a)), JSON.stringify(audit.map(x => x.action)));
    const done = await api('POST', `/api/admin/bookings/${A.id}/complete`, {});
    const lgDone = await ledger(A.id);
    check('E6 completing the booking changes no amount', done.status === 200 && lgDone.status === 'COMPLETED' && same(lgDone.total_amount, expectTotal) && same(lgDone.amount_paid, expectTotal), JSON.stringify({ done: done.status, lgDone }));

    // ══════════ E8. A range, a "from" and an enquiry-only service are never treated as a fixed price ══════════
    const probe = async (label, svc, agreed, outOfBand) => {
        const B = await submit(label, svc.id);
        if (!B.id) { check(`E8 ${label}: the customer request is accepted`, false, JSON.stringify(B.resp && B.resp.body)); return; }
        const snap = await q('SELECT unit_price FROM booking_services WHERE booking_id = ?', [B.id]);
        const bk = await one('SELECT quote_amount, total_amount FROM bookings WHERE id = ?', [B.id]);
        const trk = await track(B.id);
        const det = (await api('GET', `/api/admin/bookings/${B.id}`)).body || {};
        const ln = (det.services || [])[0] || {};
        check(`E8 ${label}: saved with NO price (snapshot R0.00, flagged "quote required"), and the customer sees no amount`,
            snap.length === 1 && same(snap[0].unit_price, 0) && !!ln.quote_required && !!trk.booking && trk.booking.total_amount === null && trk.booking.quote_amount === null, JSON.stringify({ snap, qr: ln.quote_required, est: bk.quote_amount, b: trk.booking }));
        const blank = await quoteVia(B.id, [{ service_id: svc.id, description: svc.name, quantity: 1, unit_price: 0, pricing_model: 'flat_fee' }]);
        check(`E8 ${label}: the Quote Builder route REFUSES the line without an agreed amount (400) - no minimum, maximum or midpoint is substituted`,
            blank.status === 400 && /agreed amount|individually|quote/i.test(String((blank.body || {}).message || '')) && !(await one('SELECT 1 x FROM quotations WHERE booking_id = ?', [B.id])), JSON.stringify({ s: blank.status, b: blank.body }));
        let warned = null;
        if (outOfBand) {
            warned = await quoteVia(B.id, [{ service_id: svc.id, description: svc.name, quantity: 1, unit_price: outOfBand, pricing_model: 'flat_fee' }]);
            const first = await one('SELECT id, total_amount FROM quotations WHERE booking_id = ? ORDER BY id DESC', [B.id]);
            check(`E8 ${label}: an amount outside the published band is allowed but WARNED about (a tailored quote may differ)`,
                warned.status === 200 && Array.isArray(warned.body.warnings) && warned.body.warnings.length >= 1 && !!first && same(first.total_amount, outOfBand), JSON.stringify({ s: warned.status, w: warned.body && warned.body.warnings }));
            await sleep(1100);
        }
        const ok = await quoteVia(B.id, [{ service_id: svc.id, description: svc.name, quantity: 1, unit_price: agreed, pricing_model: 'flat_fee' }]);
        const qr = await one('SELECT id, total_amount, quote_number FROM quotations WHERE booking_id = ? AND archived = 0', [B.id]);
        const ql = qr ? await q('SELECT unit_price, quantity FROM quote_line_items WHERE quotation_id = ?', [qr.id]) : [];
        check(`E8 ${label}: with an explicit agreed amount the quotation is exactly R${agreed}.00 (the typed amount, nothing derived)`,
            ok.status === 200 && !!qr && same(qr.total_amount, agreed) && ql.length === 1 && same(ql[0].unit_price, agreed), JSON.stringify({ s: ok.status, qr, ql }));
        const pdfB = qr ? await apiBinary('GET', `/api/admin/bookings/${B.id}/quote/${qr.id}/download`) : { status: 0, buffer: Buffer.alloc(0) };
        check(`E8 ${label}: the quotation PDF shows R${agreed}.00 and says the service is priced individually`, isPdf(pdfB) && new RegExp(`R ${agreed}\\.00`).test(text(pdfB.buffer)) && /priced individually/i.test(text(pdfB.buffer)), isPdf(pdfB) ? text(pdfB.buffer).slice(-700) : `${pdfB.status}`);
    };
    await probe('range', range, 100000, 150000);
    await probe('from', from, 60000, null);
    await probe('enquire-only', enquire, 8000, null);
    if (enquireMin) await probe('enquire-minimum', enquireMin, 9000, null);

    // ══════════ E7. Pre-existing records are exactly as they were; the rate card itself did not move ══════════
    check('E7 every booking, quotation, invoice and transaction that existed before the journeys has exactly the same amounts afterwards', (await fingerprint(maxBookingBefore)) === printBefore);
    check('E7 the service catalogue (names, price types, fees, bands, tax classes, active flags) is untouched by a whole customer journey', JSON.stringify(await q('SELECT id, name, price_type, default_price, price_min, price_max, tax_class, is_active FROM services')) === catalogueBefore);

    // ══════════ E9. Clean-up ══════════
    const walNow = (() => { try { return fs.statSync(path.join(__dirname, '..', 'database.sqlite-wal')).mtimeMs; } catch (e) { return null; } })();
    const sizeNow = (() => { try { return fs.statSync(path.join(__dirname, '..', 'database.sqlite')).size; } catch (e) { return null; } })();
    check('E9 the real database file was not written to while this test ran (it ran entirely on the throwaway copy)', walNow === realDbWal && sizeNow === realDbSize, JSON.stringify({ realDbWal, walNow, realDbSize, sizeNow }));
    const e2eIds = (await q("SELECT id FROM bookings WHERE event_name LIKE ?", [`${REF}%`])).map(r => r.id);
    check('E9 every record of this journey is tagged and findable by its reference (' + e2eIds.length + ' bookings)', e2eIds.length >= 4 && e2eIds.includes(A.id), JSON.stringify(e2eIds));

    const journeyLog = getChildLog().slice(logStart);
    const exceptions = journeyLog.split('\n').filter(l => /TypeError|ReferenceError|RangeError|UnhandledPromiseRejection|Unhandled rejection|uncaughtException|SQLITE_ERROR|SQLITE_CONSTRAINT|Cannot read prop/i.test(l));
    check('E9 the server logged no exception while the journey ran (no TypeError / ReferenceError / unhandled rejection / SQL error)', exceptions.length === 0, exceptions.slice(0, 5).join(' || ').slice(0, 900));

    // the project's clean-up tool, DRY RUN against a private copy of the throwaway database: it must plan to remove these bookings and verify its own rehearsal
    const cleanup = await new Promise((resolve) => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rate-e2e-cleanup-'));
        const copy = path.join(tmpDir, 'copy.sqlite');
        const src = new sqlite3.Database(TEST_DB);
        const finish = (out) => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* ignore */ } resolve(out); };
        // A snapshot of the throwaway DB for the tool to work on: fold the write-ahead log into the main file, then copy that file
        // (the journey has finished, so nothing is writing). VACUUM INTO is not used - it fails on this schema's generated columns.
        src.run('PRAGMA wal_checkpoint(TRUNCATE)', (err) => {
            src.close();
            if (err) return finish({ error: 'snapshot failed: ' + err.message });
            try { fs.copyFileSync(TEST_DB, copy); } catch (e) { return finish({ error: 'snapshot copy failed: ' + e.message }); }
            const outDir = path.join(tmpDir, 'out');
            const cutoff = new Date(Date.now() + 3600 * 1000).toISOString();
            const child = spawn(process.execPath, [path.join(__dirname, '..', 'scripts', 'cleanup-test-data.js'), '--db', copy, '--cutoff', cutoff, '--out-dir', outDir, '--payfast-hold', 'release', '--confirm-payfast-verified'], { cwd: path.join(__dirname, '..') });
            let out = ''; child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { out += d; });
            const timer = setTimeout(() => child.kill(), 120000);
            child.on('close', (code) => { clearTimeout(timer); finish({ code, out }); });
        });
    });
    if (process.env.E2E_VERBOSE) console.log('--- clean-up tool output ---\n' + (cleanup.out || cleanup.error));
    const planned = ((cleanup.out || '').match(/Bookings\s+bookings\s+delete\s+(\d+)/) || [])[1];
    const newestBooking = ((cleanup.out || '').match(/NEWEST ROW IN EACH DELETE SET[\s\S]*?bookings\s+(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/) || [])[1];
    const e2eNewest = (await one("SELECT MAX(created_at) m FROM bookings WHERE event_name LIKE ?", [`${REF}%`])).m;
    check('E9 the project\'s clean-up tool (dry run + rehearsal on a private copy) completes, its rehearsal passes (matches the plan, no new foreign-key violations, integrity ok), and the plan covers every booking of the journey',
        !cleanup.error && cleanup.code === 0 && /Rehearsal passed/.test(cleanup.out || '') && !/ROLLED BACK/.test(cleanup.out || '') && Number(planned) >= e2eIds.length && !!newestBooking && !!e2eNewest && newestBooking >= String(e2eNewest).slice(0, 19),
        JSON.stringify({ planned, e2e: e2eIds.length, newestBooking, e2eNewest }) + ' ' + (cleanup.error || (cleanup.out || '').slice(-600)));
};
