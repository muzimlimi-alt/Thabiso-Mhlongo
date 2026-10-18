// Rate card 2026, Phase 6: the downstream money. An approved quotation's amounts never move when the catalogue or the VAT rate does,
// and no report or export counts the catalogue ESTIMATE of an unquoted enquiry as money.
//
//   A. invoices and contracts keep the APPROVED amounts: regenerating them after a service changed its tax class, price, name and
//      active flag - and after the national VAT rate changed - gives the quoted VAT and total, once, and nothing historical moves
//   B. a quotation issued before this change (no stored VAT rate) still regenerates correctly
//   C. reports / exports: an enquiry that was never quoted carries an estimate in total_amount / amount_outstanding; it must not
//      appear as "quoted" or "outstanding" money in the finance export, the reconciliation screen and CSV, or the calendar
//   D. a service rate change leaves every report row of an existing booking exactly as it was
//   E. no duplicate live invoice, milestone or transaction is created by any of it
//   F. a renamed service does not re-title a past booking
//   G. the figures that asked for a column that does not exist (dashboard "Pending quotes", the per-booking Profit & Loss revenue), and
//      the finance export repeating a booking once per invoice it ever had (voided ones included)
//
// Date offsets 1285-1299 are reserved for this file (grep the WHOLE test folder before picking: service-visibility books through a
// helper, `mk(1200, ...)`, which a search for `future(` misses).
const sqlite3 = require('sqlite3');

module.exports = async function ({ check, api, pub, one, q, future, sleep, apiBinary, getTrackingToken, TEST_DB }) {
    const money = (n) => Math.round(Number(n) * 100) / 100;
    const same = (a, b) => money(a) === money(b);
    let seq = 0, day = 1285;
    const emails = new Map();
    const createdIds = [];   // service fixtures, archived at the end so they do not linger in the shared test DB

    const mkSvc = async (over) => {
        const r = await api('POST', '/api/admin/services', { name: `ZZ-FH ${Date.now().toString(36)}${seq++}`, category: 'Other', is_taxable: true, is_active: true, pricing_model: 'flat_fee', ...over });
        if (r.body && r.body.id) createdIds.push(r.body.id);
        return r.body && r.body.id;
    };
    const fetchSvc = async (id) => ((await api('GET', '/api/admin/services')).body || []).find(s => s.id === id);
    const putSvc = async (id, over) => api('PUT', `/api/admin/services/${id}`, { ...(await fetchSvc(id)), is_deleted: 0, ...over });
    const manual = async (services, label) => {
        const email = `finhist.${Date.now()}.${seq++}@example.invalid`;
        const r = await api('POST', '/api/admin/bookings', {
            name: `FinHist ${label}`, email, cell: '+27821234567', event_date: future(day++), event_name: `FINHIST ${label}`, event_type: 'Corporate', event_location: 'Hist Hall',
            message: 'Financial history integration test booking, over ten characters.', services, status: 'NEW', override_working_hours: true
        });
        if (r.body && r.body.booking_id) emails.set(r.body.booking_id, email);
        return r.body && r.body.booking_id;
    };
    const quote = async (id, items, over = {}) => {
        const bk = await one('SELECT date FROM bookings WHERE id = ?', [id]);
        const expiry = new Date(Date.parse(bk.date) - 10 * 86400000).toISOString().slice(0, 10);
        return api('POST', `/api/admin/bookings/${id}/quote`, { quote_expiry_date: expiry, terms: 'Hist terms apply.', apply_vat: false, discount: 0, items, ...over });
    };
    const accept = async (id) => pub('POST', `/api/public/bookings/${id}/accept-quote`, { access_token: await getTrackingToken(id, emails.get(id)), terms_agreed: true, installment_count: 2 });
    const invoices = (id) => q('SELECT id, invoice_number, subtotal, tax_amount, total_amount, status FROM invoices WHERE booking_id = ? ORDER BY id', [id]);
    const liveInvoices = async (id) => (await invoices(id)).filter(i => String(i.status).toUpperCase() !== 'VOID');
    const regenerate = (id) => api('POST', `/api/admin/bookings/${id}/invoice/generate`, {});
    const contractFee = async (id) => ((await api('GET', `/api/admin/bookings/${id}/contract/builder-data`)).body || {}).fee || {};
    const text = async (urlPath) => { const d = await apiBinary('GET', urlPath); return { status: d.status, text: d.buffer.toString('utf8') }; };
    // minimal CSV reader (handles "quoted, fields" and doubled quotes)
    const csv = (s) => s.split(/\r?\n/).filter(Boolean).map(line => { const out = []; let cur = '', inQ = false; for (let i = 0; i < line.length; i++) { const c = line[i]; if (inQ) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') inQ = false; else cur += c; } else if (c === '"') inQ = true; else if (c === ',') { out.push(cur); cur = ''; } else cur += c; } out.push(cur); return out; });
    const approved = async (id) => JSON.stringify({
        bk: await one('SELECT total_amount, amount_outstanding, amount_paid, payment_status, quote_amount FROM bookings WHERE id = ?', [id]),
        qt: await q('SELECT id, version, total_amount, status FROM quotations WHERE booking_id = ? ORDER BY id', [id]),
        ql: await q('SELECT service_id, quantity, unit_price FROM quote_line_items WHERE quotation_id IN (SELECT id FROM quotations WHERE booking_id = ?) ORDER BY id', [id]),
        ps: await q('SELECT description, expected_amount, status FROM payment_schedules WHERE booking_id = ? ORDER BY sequence, id', [id]),
        tx: (await one('SELECT COUNT(*) c FROM transactions WHERE booking_id = ?', [id])).c
    });

    const rw = new sqlite3.Database(TEST_DB);
    rw.configure('busyTimeout', 5000);
    const run = (sql, params = []) => new Promise((res, rej) => rw.run(sql, params, function (e) { e ? rej(e) : res(this); }));
    let vatRowId = null;

    try {
        // ═══ A. Invoices and contracts keep the approved amounts ═══
        const zStd = await mkSvc({ default_price: 1000, tax_class: 'standard' });
        const zEx = await mkSvc({ default_price: 500, tax_class: 'exempt' });
        let s1 = await fetchSvc(zStd), s2 = await fetchSvc(zEx);
        check('fixture: one VAT-standard and one VAT-exempt service', !!zStd && !!zEx && s1.tax_class === 'standard' && s2.tax_class === 'exempt', JSON.stringify([s1 && s1.tax_class, s2 && s2.tax_class]));

        const bA = await manual([{ service_id: zStd }, { service_id: zEx }], 'approved');
        let r = await quote(bA, [
            { service_id: zStd, description: 'Standard line', quantity: 1, unit_price: 1000, pricing_model: 'flat_fee' },
            { service_id: zEx, description: 'Exempt line', quantity: 1, unit_price: 500, pricing_model: 'flat_fee' }], { apply_vat: true });
        check('quote with VAT on the taxable line only: R1,000 + R500 exempt + R150 VAT = R1,650', r.status === 200 && same((await one('SELECT total_amount FROM quotations WHERE booking_id = ?', [bA])).total_amount, 1650), `${r.status} ${JSON.stringify(r.body)}`);
        const qd = JSON.parse((await one('SELECT quote_details FROM bookings WHERE id = ?', [bA])).quote_details);
        check('the quotation records the VAT rate it was issued at (and each line\'s tax class)', qd.vat_rate === 0.15 && qd.items.map(i => i.tax_class).join() === 'standard,exempt', JSON.stringify({ rate: qd.vat_rate, cls: qd.items.map(i => i.tax_class) }));
        r = await accept(bA);
        check('the client accepts: invoice generated', r.status === 200 && r.body.success && r.body.invoice_generated, `${r.status} ${JSON.stringify(r.body)}`);
        let inv = await liveInvoices(bA);
        check('invoice 1: R1,650.00 with R150.00 VAT', inv.length === 1 && same(inv[0].total_amount, 1650) && same(inv[0].tax_amount, 150) && same(inv[0].subtotal, 1500), JSON.stringify(inv));
        check('contract amount: R1,650.00', same((await one('SELECT contract_amount FROM contracts WHERE booking_id = ?', [bA])).contract_amount, 1650) && same((await contractFee(bA)).total, 1650));
        const S0 = await approved(bA);
        const inv1 = inv[0];

        // the catalogue changes in every way a rate-card update can: tax class swapped, price changed, renamed, switched off
        r = await putSvc(zStd, { tax_class: 'exempt', default_price: 9999, name: `ZZ-FH renamed ${Date.now().toString(36)}`, is_active: false });
        const r2 = await putSvc(zEx, { tax_class: 'standard', default_price: 1, is_active: false });
        s1 = await fetchSvc(zStd); s2 = await fetchSvc(zEx);
        check('precondition: the services now carry the SWAPPED tax classes, new prices, and are inactive',
            r.status === 200 && r2.status === 200 && s1.tax_class === 'exempt' && s2.tax_class === 'standard' && Number(s1.default_price) === 9999 && !s1.is_active && !s2.is_active, `${r.status}/${r2.status} ${JSON.stringify([s1 && s1.tax_class, s2 && s2.tax_class, s1 && s1.default_price])}`);

        r = await regenerate(bA);
        check('admin regenerates the invoice after the catalogue change', r.status === 200 && r.body.success, `${r.status} ${JSON.stringify(r.body)}`);
        inv = await invoices(bA);
        let live = inv.filter(i => i.status !== 'VOID');
        check('the regenerated invoice still carries the APPROVED R1,650.00 / R150.00 VAT (it used to re-read each line\'s CURRENT tax class)',
            live.length === 1 && same(live[0].total_amount, 1650) && same(live[0].tax_amount, 150), JSON.stringify(inv));
        const old1 = inv.find(i => i.id === inv1.id);
        check('the superseded invoice is VOID and keeps its recorded amounts', old1 && old1.status === 'VOID' && same(old1.total_amount, 1650) && same(old1.tax_amount, 150) && same(old1.subtotal, 1500), JSON.stringify(old1));
        const lines = await q('SELECT description, quantity, unit_price FROM invoice_line_items WHERE invoice_id = ? ORDER BY id', [live[0].id]);
        check('its line items are the quoted lines (R1,000 and R500), not today\'s prices', lines.length === 2 && same(lines[0].unit_price, 1000) && same(lines[1].unit_price, 500), JSON.stringify(lines));
        r = await api('POST', `/api/admin/bookings/${bA}/contract/generate`, {});
        check('the contract is regenerated at the approved R1,650.00', r.status === 200 && same((await one('SELECT contract_amount FROM contracts WHERE booking_id = ?', [bA])).contract_amount, 1650) && same((await contractFee(bA)).total, 1650), `${r.status} ${JSON.stringify(r.body)}`);

        // the national VAT rate changes after the quotation was approved
        const ins = await run("INSERT INTO tax_rates (name, rate, effective_from, is_default) VALUES ('ZZ test VAT 16', 0.16, date('now','-1 day'), 1)");
        vatRowId = ins.lastID;
        const zNew = await mkSvc({ default_price: 1000, tax_class: 'standard' });
        const bB = await manual([{ service_id: zNew }], 'vat16');
        r = await quote(bB, [{ service_id: zNew, description: 'Standard line', quantity: 1, unit_price: 1000, pricing_model: 'flat_fee' }], { apply_vat: true });
        const qdB = JSON.parse((await one('SELECT quote_details FROM bookings WHERE id = ?', [bB])).quote_details);
        check('a NEW quotation uses the CURRENT VAT rate (16%): R1,160.00, and records it', r.status === 200 && same((await one('SELECT total_amount FROM quotations WHERE booking_id = ?', [bB])).total_amount, 1160) && qdB.vat_rate === 0.16, JSON.stringify({ s: r.status, rate: qdB.vat_rate }));
        r = await regenerate(bA);
        live = (await invoices(bA)).filter(i => i.status !== 'VOID');
        check('with VAT now 16%, the approved 15% quotation still regenerates at R1,650.00 / R150.00 VAT (it used to give R1,660.00)',
            r.status === 200 && live.length === 1 && same(live[0].total_amount, 1650) && same(live[0].tax_amount, 150), JSON.stringify(await invoices(bA)));
        check('...and so does its contract (R1,650.00)', same((await contractFee(bA)).total, 1650));
        // restore the VAT rate; the 16% quotation is then accepted: its invoice must carry the rate it was approved at
        await run('DELETE FROM tax_rates WHERE id = ?', [vatRowId]); vatRowId = null;
        r = await accept(bB);
        const invB = await liveInvoices(bB);
        const schedB = await q("SELECT expected_amount FROM payment_schedules WHERE booking_id = ? AND LOWER(COALESCE(status,'pending')) NOT IN ('superseded','cancelled')", [bB]);
        check('the 16% quotation, accepted after the rate went back to 15%, is invoiced at ITS approved R1,160.00 / R160.00 VAT (it used to give R1,150.00)',
            r.status === 200 && invB.length === 1 && same(invB[0].total_amount, 1160) && same(invB[0].tax_amount, 160), JSON.stringify(invB));
        check('...and its payment milestones add up to the same R1,160.00', same(schedB.reduce((s, x) => s + x.expected_amount, 0), 1160), JSON.stringify(schedB));

        // ═══ B. A quotation issued before this change (no stored VAT rate) ═══
        const legacy = JSON.parse((await one('SELECT quote_details FROM bookings WHERE id = ?', [bA])).quote_details);
        delete legacy.vat_rate;
        await run('UPDATE bookings SET quote_details = ? WHERE id = ?', [JSON.stringify(legacy), bA]);
        r = await regenerate(bA);
        live = (await invoices(bA)).filter(i => i.status !== 'VOID');
        check('a legacy quotation with no stored VAT rate regenerates at its stored tax classes and today\'s rate (15%): R1,650.00', r.status === 200 && live.length === 1 && same(live[0].total_amount, 1650) && same(live[0].tax_amount, 150), JSON.stringify(live));

        // ═══ D (first half) + E. Nothing historical moved, nothing duplicated ═══
        check('every approved record of the booking is exactly as it was: ledger, quotation, quote lines, milestones, transactions', await approved(bA) === S0, `${S0}\n${await approved(bA)}`);
        const allInv = await invoices(bA);
        check('exactly ONE live invoice; every other one is VOID (so VAT is charged once)', allInv.filter(i => i.status !== 'VOID').length === 1 && allInv.length >= 4 && allInv.every(i => i.status === 'VOID' || i.id === allInv[allInv.length - 1].id), JSON.stringify(allInv.map(i => [i.invoice_number, i.status])));
        check('the booking has exactly two live milestones totalling R1,650.00 and no stray transactions', (await q("SELECT expected_amount FROM payment_schedules WHERE booking_id = ? AND LOWER(COALESCE(status,'pending')) NOT IN ('superseded','cancelled')", [bA])).length === 2 && (await one('SELECT COUNT(*) c FROM transactions WHERE booking_id = ?', [bA])).c === 0);

        // ═══ C. Reports and exports: an unquoted enquiry's estimate is not money ═══
        const sClub = (await one("SELECT id FROM services WHERE name = 'Club – 10 min Set (Guest Spot)'")).id;   // fixed R5,000
        const recBefore = (await api('GET', '/api/admin/reconciliation')).body;
        const statsBefore = (await api('GET', '/api/admin/financials/stats')).body;
        const bE = await manual([{ service_id: sClub }], 'enquiry');
        const estimate = await one('SELECT quote_amount, total_amount, amount_outstanding FROM bookings WHERE id = ?', [bE]);
        check('fixture: an enquiry that was never quoted carries the catalogue estimate (R5,000) in total_amount and amount_outstanding', same(estimate.total_amount, 5000) && same(estimate.amount_outstanding, 5000) && !(await one('SELECT 1 x FROM quotations WHERE booking_id = ?', [bE])), JSON.stringify(estimate));

        // G. Per-booking Profit & Loss. It asked for quotations.total (the column is total_amount) and so always read R0.00. Renaming the
        // column alone would have swung the other way - the fallback to bookings.total_amount would print an unquoted enquiry's ESTIMATE as
        // its revenue - so both directions are pinned.
        let pl = (await api('GET', `/api/admin/bookings/${bE}/expenses`)).body;
        check('Profit & Loss: an enquiry that was never quoted has NO revenue (its R5,000 catalogue estimate is not revenue)', !!pl && pl.success === true && same(pl.gross_revenue, 0) && same(pl.net_profit, 0), JSON.stringify(pl));
        const plA = (await api('GET', `/api/admin/bookings/${bA}/expenses`)).body;
        check('Profit & Loss: the accepted booking\'s revenue is its approved quotation, R1,650.00 (it always read R0.00)', !!plA && same(plA.gross_revenue, 1650) && same(plA.net_profit, 1650), JSON.stringify(plA));
        const exAdd = await api('POST', '/api/admin/expenses', { booking_id: bA, category: 'misc', amount: 400, description: 'ZZ-FH expense', expense_date: new Date().toISOString().slice(0, 10) });
        const plA2 = (await api('GET', `/api/admin/bookings/${bA}/expenses`)).body;
        check('Profit & Loss: an expense of R400 comes off it - net profit R1,250.00', exAdd.status === 200 && !!plA2 && same(plA2.total_expenses, 400) && same(plA2.gross_revenue, 1650) && same(plA2.net_profit, 1250), JSON.stringify({ add: exAdd.status, plA2 }));
        if (exAdd.body && exAdd.body.id) await api('DELETE', `/api/admin/expenses/${exAdd.body.id}`);   // leave no expense behind in the shared test DB

        const rec = (await api('GET', '/api/admin/reconciliation')).body;
        const rowE = rec.rows.find(x => x.booking_id === bE), rowA = rec.rows.find(x => x.booking_id === bA);
        check('reconciliation: the enquiry shows NO quoted amount and NO outstanding balance, and says why',
            rowE && same(rowE.quoted_amount, 0) && same(rowE.outstanding, 0) && rowE.amount_basis === 'none', JSON.stringify(rowE));
        check('reconciliation: the accepted booking shows its quoted R1,650.00', rowA && same(rowA.quoted_amount, 1650) && rowA.amount_basis === 'quoted', JSON.stringify(rowA));
        check('reconciliation summary: "Total quoted" is unchanged by the enquiry (an estimate is not a quotation)', same(rec.summary.total_quoted, recBefore.summary.total_quoted), `${recBefore.summary.total_quoted} -> ${rec.summary.total_quoted}`);
        const statsEnquiry = (await api('GET', '/api/admin/financials/stats')).body.stats;
        check('dashboard: receivables ("outstanding") are unchanged by the enquiry (an estimate is not money owed)',
            same(statsEnquiry.outstanding, statsBefore.stats.outstanding), JSON.stringify({ before: statsBefore.stats.outstanding, after: statsEnquiry.outstanding }));
        check('dashboard: "Pending quotes" ignores an enquiry that has no quotation (an estimate is not a pending quote)',
            statsEnquiry.pending_quotes_count === statsBefore.stats.pending_quotes_count && same(statsEnquiry.pending_quotes_value, statsBefore.stats.pending_quotes_value),
            JSON.stringify({ before: [statsBefore.stats.pending_quotes_count, statsBefore.stats.pending_quotes_value], after: [statsEnquiry.pending_quotes_count, statsEnquiry.pending_quotes_value] }));

        const fin = csv((await text('/api/admin/finance/export')).text);
        const head = fin[0], iTotal = head.indexOf('Total Amount'), iOut = head.indexOf('Outstanding'), iBasis = head.indexOf('Amount Basis');
        const finE = fin.find(x => x[0] === String(bE)), finA = fin.find(x => x[0] === String(bA));
        check('finance export: the enquiry\'s Total Amount and Outstanding are 0, basis "No quotation yet"', !!finE && iBasis > -1 && same(finE[iTotal], 0) && same(finE[iOut], 0) && finE[iBasis] === 'No quotation yet', JSON.stringify([head, finE]));
        check('finance export: the accepted booking keeps its R1,650.00, basis "Quoted"', !!finA && same(finA[iTotal], 1650) && finA[iBasis] === 'Quoted', JSON.stringify(finA));
        // G. The export joined every invoice the booking ever had, so a booking whose invoice was regenerated (the old ones are VOID) came out once
        // per invoice - and a total over the file counted its R1,650.00 four times.
        const iInv = head.indexOf('Invoice Number');
        const rowsA = fin.filter(x => x[0] === String(bA));
        const liveNoA = (await liveInvoices(bA))[0].invoice_number;
        check('finance export: a booking is ONE row, carrying its live invoice number - the invoices it voided add no rows',
            iInv > -1 && rowsA.length === 1 && rowsA[0][iInv] === liveNoA, JSON.stringify({ rows: rowsA.length, live: liveNoA, got: rowsA.map(x => x[iInv]) }));
        check('finance export: nothing is double counted - exactly one row per booking in the whole file', new Set(fin.slice(1).map(x => x[0])).size === fin.length - 1, `${fin.length - 1} rows, ${new Set(fin.slice(1).map(x => x[0])).size} distinct bookings`);

        const recCsv = csv((await text('/api/admin/reconciliation/export/csv')).text);
        const rh = recCsv[0], rQuoted = rh.indexOf('Quoted'), rOut = rh.indexOf('Outstanding'), rBasis = rh.indexOf('AmountBasis');
        const rcE = recCsv.find(x => x[0] === String(bE)), rcA = recCsv.find(x => x[0] === String(bA));
        check('reconciliation CSV (for the accountant): the enquiry is Quoted 0.00 / Outstanding 0.00, basis "No quotation yet"', !!rcE && rBasis > -1 && same(rcE[rQuoted], 0) && same(rcE[rOut], 0) && rcE[rBasis] === 'No quotation yet', JSON.stringify([rh, rcE]));
        check('reconciliation CSV: the accepted booking keeps Quoted 1650.00', !!rcA && same(rcA[rQuoted], 1650) && rcA[rBasis] === 'Quoted', JSON.stringify(rcA));

        const cal = (await api('GET', '/api/admin/calendar/events')).body;
        const evs = Array.isArray(cal) ? cal : (cal.events || []);
        const evE = evs.find(e => e.id === `b-${bE}`), evA = evs.find(e => e.id === `b-${bA}`);
        check('calendar: the enquiry carries no outstanding amount (the popover would have read "Outstanding R5,000")', !!evE && (evE.extendedProps.amountOutstanding === null || evE.extendedProps.amountOutstanding === undefined), JSON.stringify(evE && evE.extendedProps));
        check('calendar: the accepted booking still shows what is outstanding (R1,650)', !!evA && same(evA.extendedProps.amountOutstanding, 1650), JSON.stringify(evA && evA.extendedProps));

        // once the enquiry is quoted its figures count
        r = await quote(bE, [{ service_id: sClub, description: 'Club set', quantity: 1, unit_price: 5000, pricing_model: 'flat_fee' }]);
        const rec2 = (await api('GET', '/api/admin/reconciliation')).body;
        const rowE2 = rec2.rows.find(x => x.booking_id === bE);
        check('after the quotation is issued the same booking shows its quoted R5,000.00 and the total grows by exactly that',
            r.status === 200 && rowE2 && same(rowE2.quoted_amount, 5000) && rowE2.amount_basis === 'quoted' && same(rec2.summary.total_quoted, rec.summary.total_quoted + 5000), JSON.stringify({ s: r.status, row: rowE2, a: rec.summary.total_quoted, b: rec2.summary.total_quoted }));
        const statsQuoted = (await api('GET', '/api/admin/financials/stats')).body.stats;
        check('dashboard: receivables still do not count a quotation that has not been accepted', same(statsQuoted.outstanding, statsEnquiry.outstanding), JSON.stringify({ before: statsEnquiry.outstanding, after: statsQuoted.outstanding }));

        // G. "Pending quotes" asked for quotations.total, so it read 0 quotes / R0.00 whatever was awaiting a client.
        check('fixture: sending the quotation moved the booking to QUOTED', (await one('SELECT status FROM bookings WHERE id = ?', [bE])).status === 'QUOTED');
        check('dashboard: "Pending quotes" counts the quotation just sent and adds its value (R5,000.00)',
            statsQuoted.pending_quotes_count === statsEnquiry.pending_quotes_count + 1 && same(statsQuoted.pending_quotes_value, statsEnquiry.pending_quotes_value + 5000),
            JSON.stringify({ before: [statsEnquiry.pending_quotes_count, statsEnquiry.pending_quotes_value], after: [statsQuoted.pending_quotes_count, statsQuoted.pending_quotes_value] }));
        const plQ = (await api('GET', `/api/admin/bookings/${bE}/expenses`)).body;
        check('Profit & Loss: once the quotation is issued the booking\'s revenue is that quotation, R5,000.00', !!plQ && same(plQ.gross_revenue, 5000), JSON.stringify(plQ));
        // A revision archives the earlier quotation: the pending figure follows the CURRENT quotation and never counts both.
        r = await quote(bE, [{ service_id: sClub, description: 'Club set (revised)', quantity: 1, unit_price: 5500, pricing_model: 'flat_fee' }]);
        const statsRevised = (await api('GET', '/api/admin/financials/stats')).body.stats;
        check('dashboard: revising the quotation replaces its value in "Pending quotes" - R5,500.00, still one quote, never counted twice',
            r.status === 200 && statsRevised.pending_quotes_count === statsEnquiry.pending_quotes_count + 1 && same(statsRevised.pending_quotes_value, statsEnquiry.pending_quotes_value + 5500),
            JSON.stringify({ s: r.status, base: [statsEnquiry.pending_quotes_count, statsEnquiry.pending_quotes_value], revised: [statsRevised.pending_quotes_count, statsRevised.pending_quotes_value] }));
        const plR = (await api('GET', `/api/admin/bookings/${bE}/expenses`)).body;
        check('Profit & Loss: after the revision the revenue is the standing quotation, R5,500.00 (not the superseded R5,000.00)', !!plR && same(plR.gross_revenue, 5500), JSON.stringify(plR));

        // ═══ D (second half). A rate change leaves a booking's report rows alone ═══
        const rowABefore = JSON.stringify(rowA);
        await putSvc(zStd, { default_price: 123456, tax_class: 'zero-rated' });
        const recAfter = (await api('GET', '/api/admin/reconciliation')).body;
        const finAfter = csv((await text('/api/admin/finance/export')).text).find(x => x[0] === String(bA));
        check('after yet another rate / tax-class change the booking\'s reconciliation row and finance-export row are identical', JSON.stringify(recAfter.rows.find(x => x.booking_id === bA)) === rowABefore && JSON.stringify(finAfter) === JSON.stringify(finA), `${rowABefore}\n${JSON.stringify(recAfter.rows.find(x => x.booking_id === bA))}`);
        const plAfter = (await api('GET', `/api/admin/bookings/${bA}/expenses`)).body;
        check('...and so is its Profit & Loss revenue (R1,650.00): a rate change never moves historical revenue', !!plAfter && same(plAfter.gross_revenue, 1650) && same(plAfter.net_profit, 1650), JSON.stringify(plAfter));

        // ═══ F. A renamed service does not re-title a past booking ═══
        // The rate card renamed three re-used services. booking_services keeps only the service id, so every live JOIN would show the NEW
        // name beside the OLD amount; the stored line description (what the line was called when booked / quoted) is used instead.
        const oldName = `ZZ-FH Old Name ${Date.now().toString(36)}`;
        const zNm = await mkSvc({ name: oldName, default_price: 1000, tax_class: 'standard' });
        const bP = await manual([{ service_id: zNm }], 'never-quoted');            // never quoted: its line carries the service name at booking time
        const bN = await manual([{ service_id: zNm }], 'quoted-as');
        r = await quote(bN, [{ service_id: zNm, description: 'Headline set as quoted', quantity: 1, unit_price: 1000, pricing_model: 'flat_fee' }]);
        check('fixture: a booking quoted under its own description, one never quoted, both on the same service', r.status === 200 && !!bP, `${r.status} ${JSON.stringify(r.body)}`);
        r = await accept(bN);
        const dep = await api('POST', '/api/admin/transactions/manual', { booking_id: bN, amount: 500, transaction_type: 'payment', payment_method: 'eft', reference: 'ZZ-FH deposit' });
        check('the client accepted and paid the deposit: the booking is CONFIRMED', r.status === 200 && dep.status === 200 && (await one('SELECT status FROM bookings WHERE id = ?', [bN])).status === 'CONFIRMED', `${r.status}/${dep.status} ${JSON.stringify(dep.body)}`);
        const bal = await api('POST', '/api/admin/transactions/manual', { booking_id: bN, amount: 500, transaction_type: 'payment', payment_method: 'eft', reference: 'ZZ-FH balance' });
        const paidRow = await one('SELECT payment_status, amount_paid, amount_outstanding, total_amount FROM bookings WHERE id = ?', [bN]);
        check('...and the balance: PAID in full, nothing outstanding, total unchanged at R1,000', bal.status === 200 && paidRow.payment_status === 'PAID' && same(paidRow.amount_paid, 1000) && same(paidRow.amount_outstanding, 0) && same(paidRow.total_amount, 1000), JSON.stringify(paidRow));
        const txBefore = JSON.stringify(await q('SELECT amount, transaction_type, status FROM transactions WHERE booking_id = ? ORDER BY id', [bN]));
        const newName = `ZZ-FH New Name ${Date.now().toString(36)}`;
        r = await putSvc(zNm, { name: newName });
        check('the service is renamed (as the rate card renamed three legacy services)', r.status === 200 && (await fetchSvc(zNm)).name === newName, `${r.status}`);

        let det = (await api('GET', `/api/admin/bookings/${bN}`)).body;
        check('booking detail: the line keeps the description it was quoted under; the live name is the new one',
            det.services[0].line_description === 'Headline set as quoted' && det.services[0].service_name === newName, JSON.stringify(det.services[0]));
        det = (await api('GET', `/api/admin/bookings/${bP}`)).body;
        check('booking detail, never quoted: the line keeps the name it was booked under (the service\'s name at the time)', det.services[0].line_description === oldName && det.services[0].service_name === newName, JSON.stringify(det.services[0]));
        const li = ((await api('GET', `/api/admin/bookings/${bN}/details`)).body || {}).line_items || [];
        check('Deal View line items: described as quoted, at the quoted R1,000', li.length === 1 && li[0].line_description === 'Headline set as quoted' && same(li[0].unit_price, 1000), JSON.stringify(li));

        r = await api('POST', `/api/admin/bookings/${bN}/complete`, {});
        let done = null;
        for (let i = 0; i < 60 && !done; i++) {
            done = await one("SELECT body FROM notifications WHERE type='email' AND subject = ? AND recipient_email = ? ORDER BY id DESC LIMIT 1", [`Thank You – Event Completed! Booking #${bN}`, emails.get(bN)]);
            if (!done) await sleep(100);
        }
        const doneHtml = done ? (() => { try { return JSON.parse(done.body).htmlContent || done.body; } catch (e) { return done.body; } })() : '';
        const doneText = doneHtml.replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
        check('the client\'s "Event Completed" email lists the service as it was quoted, not under its new name', r.status === 200 && !!done && doneText.includes('Headline set as quoted') && !doneText.includes(newName), `${r.status} ${doneText.slice(0, 600)}`);
        check('...with the booked amount (R1,000.00), unaffected by the rename', /Services Delivered[\s\S]*R 1000\.00/.test(doneText), doneText.slice(0, 700));
        check('the payments recorded on that booking are exactly as they were (no transaction added, none changed) after the rename and completion', JSON.stringify(await q('SELECT amount, transaction_type, status FROM transactions WHERE booking_id = ? ORDER BY id', [bN])) === txBefore, txBefore);
    } finally {
        if (vatRowId) await run('DELETE FROM tax_rates WHERE id = ?', [vatRowId]).catch(() => {});   // never leave a test VAT rate behind
        await new Promise(res => rw.close(res));
        for (const id of createdIds) await api('DELETE', `/api/admin/services/${id}`);
    }
};
