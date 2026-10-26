// Manual ADJUSTMENTS (credit / debit) survive the invoice being rebuilt.
//
// Before this change a logged adjustment lowered (or raised) the booking total and then immediately triggered the invoice rebuild, which
// rebuilt the invoice from the approved quotation ALONE and wrote that total straight back - so the adjustment vanished the moment it was
// made (a R1,000 credit on a R5,000 booking: total R4,000, then R5,000 again, the payment schedule left at R5,000). Now:
//   - the rebuilt invoice is the approved quotation PLUS the adjustments logged since that quotation was issued (shown as their own lines
//     and totals rows, never folded into a quote line), and the invoice total, the booking total and the payment schedule agree;
//   - VAT is NOT recalculated for an adjustment (the ledger never did; it is shown as a separate amount) - the VAT of the approved
//     quotation stays exactly as quoted;
//   - a NEW quotation starts fresh: adjustments made under the earlier one do not carry over;
//   - an adjustment flagged as a duplicate no longer counts;
//   - the approved quotation, the voided invoices and the payments are never touched.
//
//   A. a credit, then a debit, then a manual rebuild: totals, lines, schedule, PDF, nothing historical moved
//   B. VAT stays as quoted
//   C. a new quotation supersedes earlier adjustments; later ones apply
//   D. an adjustment made BEFORE the client accepts is honoured by the first invoice and the schedule
//   E. a duplicate-flagged adjustment is ignored
//   F. a credit bigger than what is still owed: the balance stops at R0 (never negative), the schedule is left to the admin
//   G. the pure helpers (adjustment maths, schedule rebalance) incl. parity with the real rebalance route
//
// Date offsets 1300-1319 are reserved for this file (grep the WHOLE test folder before picking: service-visibility books through a helper,
// `mk(1200, ...)`, which a search for `future(` misses).
const sqlite3 = require('sqlite3');

module.exports = async function ({ check, api, pub, one, q, future, sleep, apiBinary, getTrackingToken, extractPdfText, TEST_DB }) {
    const money = (n) => Math.round(Number(n) * 100) / 100;
    const same = (a, b) => money(a) === money(b);
    let seq = 0, day = 1300;
    const emails = new Map();
    const createdIds = [];

    const mkSvc = async (over) => {
        const r = await api('POST', '/api/admin/services', { name: `ZZ-ADJ ${Date.now().toString(36)}${seq++}`, category: 'Other', is_taxable: true, is_active: true, pricing_model: 'flat_fee', ...over });
        if (r.body && r.body.id) createdIds.push(r.body.id);
        return r.body && r.body.id;
    };
    const manual = async (services, label) => {
        const email = `adj.${Date.now()}.${seq++}@example.invalid`;
        const r = await api('POST', '/api/admin/bookings', {
            name: `Adj ${label}`, email, cell: '+27821234567', event_date: future(day++), event_name: `ADJ ${label}`, event_type: 'Corporate', event_location: 'Adjustment Hall',
            message: 'Adjustment integration test booking, over ten characters.', services, status: 'NEW', override_working_hours: true
        });
        if (r.body && r.body.booking_id) emails.set(r.body.booking_id, email);
        return r.body && r.body.booking_id;
    };
    const quote = async (id, items, over = {}) => {
        const bk = await one('SELECT date FROM bookings WHERE id = ?', [id]);
        const expiry = new Date(Date.parse(bk.date) - 10 * 86400000).toISOString().slice(0, 10);
        return api('POST', `/api/admin/bookings/${id}/quote`, { quote_expiry_date: expiry, terms: 'Adjustment terms apply.', apply_vat: false, discount: 0, items, ...over });
    };
    const accept = async (id) => pub('POST', `/api/public/bookings/${id}/accept-quote`, { access_token: await getTrackingToken(id, emails.get(id)), terms_agreed: true, installment_count: 2 });
    const adjust = (id, direction, amount, notes) => api('POST', '/api/admin/transactions/manual', { booking_id: id, amount, transaction_type: 'adjustment', direction, notes });
    const live = (id) => q("SELECT id, invoice_number, subtotal, tax_amount, total_amount, status FROM invoices WHERE booking_id = ? AND UPPER(status) <> 'VOID' ORDER BY id DESC", [id]);
    const allInv = (id) => q('SELECT id, invoice_number, subtotal, tax_amount, total_amount, status FROM invoices WHERE booking_id = ? ORDER BY id', [id]);
    // the rebuild after an adjustment runs AFTER the response, so poll for it (never sleep a fixed time for async work)
    const waitLive = async (id, pred, ms = 20000) => {
        const t0 = Date.now(); let last = [];
        for (;;) {
            last = await live(id);
            if (last.length && pred(last[0])) return last[0];
            if (Date.now() - t0 > ms) return null;
            await sleep(200);
        }
    };
    const lines = (invId) => q('SELECT description, quantity, unit_price FROM invoice_line_items WHERE invoice_id = ? ORDER BY id', [invId]);
    const sched = (id) => q("SELECT expected_amount, status FROM payment_schedules WHERE booking_id = ? AND LOWER(COALESCE(status,'pending')) NOT IN ('superseded','cancelled') ORDER BY due_date, id", [id]);
    const schedSum = async (id) => money((await sched(id)).reduce((s, x) => s + x.expected_amount, 0));
    const ledger = (id) => one('SELECT total_amount, amount_outstanding, amount_paid, payment_status, quote_amount, status FROM bookings WHERE id = ?', [id]);
    const poll = async (fn, ms = 15000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return v; await sleep(200); } };
    const pdf = async (id) => {
        const d = await apiBinary('GET', `/api/admin/bookings/${id}/invoice/download`);
        return { status: d.status, pages: (d.buffer.toString('latin1').match(/\/Type \/Page\b/g) || []).length, text: extractPdfText(d.buffer).replace(/\s+/g, ' ') };
    };
    const quoteState = async (id) => JSON.stringify({
        qt: await q('SELECT id, version, total_amount, status, archived FROM quotations WHERE booking_id = ? ORDER BY id', [id]),
        ql: await q('SELECT service_id, quantity, unit_price FROM quote_line_items WHERE quotation_id IN (SELECT id FROM quotations WHERE booking_id = ?) ORDER BY id', [id]),
        qa: (await one('SELECT quote_amount FROM bookings WHERE id = ?', [id])).quote_amount
    });
    const rw = new sqlite3.Database(TEST_DB);
    rw.configure('busyTimeout', 5000);
    const run = (sql, params = []) => new Promise((res, rej) => rw.run(sql, params, function (e) { e ? rej(e) : res(this); }));

    const sClub = (await one("SELECT id FROM services WHERE name = 'Club – 10 min Set (Guest Spot)'")).id;   // fixed R5,000
    const item5000 = { service_id: sClub, description: 'Club set', quantity: 1, unit_price: 5000, pricing_model: 'flat_fee' };

    try {
        // ═══ A. A credit, a debit and a manual rebuild ═══
        const bA = await manual([{ service_id: sClub }], 'credit-debit');
        let r = await quote(bA, [item5000]);
        const acc = await accept(bA);
        const inv1 = await waitLive(bA, x => same(x.total_amount, 5000));
        check('fixture: quoted R5,000.00 and accepted - one live invoice of R5,000.00 and two milestones of R2,500.00',
            r.status === 200 && acc.status === 200 && !!inv1 && (await schedSum(bA)) === 5000 && (await sched(bA)).length === 2, JSON.stringify({ q: r.status, a: acc.status, inv1, s: await sched(bA) }));
        const quoteBefore = await quoteState(bA);

        r = await adjust(bA, 'credit', 1000, 'goodwill discount');
        check('the R1,000 credit is recorded', r.status === 200 && r.body.success === true, `${r.status} ${JSON.stringify(r.body)}`);
        const inv2 = await waitLive(bA, x => x.id !== inv1.id);
        check('the invoice is rebuilt WITH the credit: R4,000.00 (it used to be rebuilt from the quotation alone and snap back to R5,000.00)', !!inv2 && same(inv2.total_amount, 4000), JSON.stringify(await allInv(bA)));
        let lg = await ledger(bA);
        check('the booking total stays R4,000.00 and the balance R4,000.00', same(lg.total_amount, 4000) && same(lg.amount_outstanding, 4000), JSON.stringify(lg));
        const l2 = inv2 ? await lines(inv2.id) : [];
        check('the invoice lines are the quoted line and the adjustment, as its own negative line',
            l2.length === 2 && l2[0].description === 'Club set' && same(l2[0].unit_price, 5000) && /^Adjustment \(credit\)/.test(l2[1].description) && /goodwill discount/.test(l2[1].description) && same(l2[1].quantity * l2[1].unit_price, -1000), JSON.stringify(l2));
        check('the lines add up to the invoice: subtotal R4,000.00, VAT R0.00, total R4,000.00', !!inv2 && same(inv2.subtotal, 4000) && same(inv2.tax_amount, 0) && same(inv2.total_amount, 4000) && same(l2.reduce((s, x) => s + x.quantity * x.unit_price, 0), inv2.subtotal), JSON.stringify({ inv2, l2 }));
        check('the payment schedule follows the new total: two milestones of R2,000.00 (it was left at R5,000.00)', (await schedSum(bA)) === 4000 && (await sched(bA)).map(x => x.expected_amount).join() === '2000,2000', JSON.stringify(await sched(bA)));
        let p = await pdf(bA);
        check('the invoice PDF shows the adjustment, its reason and the adjusted total, on one page',
            p.status === 200 && p.pages === 1 && /Adjustment \(credit\) - R 1000\.00/.test(p.text) && /goodwill discount/.test(p.text) && /TOTAL AMOUNT R 4000\.00/.test(p.text), `${p.status} pages=${p.pages} ${p.text.slice(-700)}`);
        check('...and its payment schedule agrees with that total (2 x R2,000.00)', /50% Deposit \S+ \S+ \S+ R 2000\.00/.test(p.text) || (p.text.match(/R 2000\.00/g) || []).length >= 2, p.text.slice(-500));
        check('the approved quotation is untouched (same version, total R5,000.00, same lines)', await quoteState(bA) === quoteBefore, `${quoteBefore}\n${await quoteState(bA)}`);
        const hist = await allInv(bA);
        check('the superseded invoice is VOID and keeps its R5,000.00; exactly one invoice is live', hist.filter(x => x.status !== 'VOID').length === 1 && hist.find(x => x.id === inv1.id).status === 'VOID' && same(hist.find(x => x.id === inv1.id).total_amount, 5000), JSON.stringify(hist));
        check('exactly one transaction exists for the booking - the adjustment itself (no payment, no duplicate)', JSON.stringify(await q('SELECT transaction_type, amount FROM transactions WHERE booking_id = ?', [bA])) === JSON.stringify([{ transaction_type: 'adjustment', amount: 1000 }]));

        r = await adjust(bA, 'debit', 500, 'extra hour');
        const inv3 = await waitLive(bA, x => x.id !== inv2.id);
        const l3 = inv3 ? await lines(inv3.id) : [];
        check('a later R500 debit is added on top: R4,500.00, three lines (quote, credit, debit), schedule 2 x R2,250.00',
            r.status === 200 && !!inv3 && same(inv3.total_amount, 4500) && l3.length === 3 && same(l3[2].quantity * l3[2].unit_price, 500) && /^Adjustment \(debit\)/.test(l3[2].description) && (await sched(bA)).map(x => x.expected_amount).join() === '2250,2250',
            JSON.stringify({ r: r.status, inv3, l3, s: await sched(bA) }));
        lg = await ledger(bA);
        check('the booking total is R4,500.00 and the balance R4,500.00', same(lg.total_amount, 4500) && same(lg.amount_outstanding, 4500), JSON.stringify(lg));

        // an admin "Generate Invoice" afterwards used to wipe every adjustment
        r = await api('POST', `/api/admin/bookings/${bA}/invoice/generate`, {});
        const liveAfter = await live(bA);
        const l4 = liveAfter.length ? await lines(liveAfter[0].id) : [];
        lg = await ledger(bA);
        check('a manual "Generate Invoice" keeps both adjustments: still R4,500.00, one live invoice, same three lines, ledger R4,500.00',
            r.status === 200 && liveAfter.length === 1 && same(liveAfter[0].total_amount, 4500) && l4.length === 3 && same(lg.total_amount, 4500), JSON.stringify({ r: r.status, liveAfter, l4, lg }));
        p = await pdf(bA);
        check('the rebuilt PDF lists both adjustments and totals R4,500.00', /Adjustment \(credit\) - R 1000\.00/.test(p.text) && /Adjustment \(debit\) \+ R 500\.00/.test(p.text) && /TOTAL AMOUNT R 4500\.00/.test(p.text) && /extra hour/.test(p.text), p.text.slice(-700));
        check('the quotation is still untouched after all of it', await quoteState(bA) === quoteBefore);
        // the contract states the fee as it now stands, so its fee, its deposit / balance wording and its schedule rows agree
        const cf = ((await api('GET', `/api/admin/bookings/${bA}/contract/builder-data`)).body || {}).fee || {};
        check('the contract states the fee as it now stands (R4,500.00) and its schedule rows add up to it',
            same(cf.total, 4500) && (cf.schedules || []).length === 2 && same((cf.schedules || []).reduce((s, x) => s + x.expected_amount, 0), 4500), JSON.stringify(cf));

        // ═══ B. VAT stays as quoted ═══
        const zStd = await mkSvc({ default_price: 1000, tax_class: 'standard' });
        const bV = await manual([{ service_id: zStd }], 'vat');
        r = await quote(bV, [{ service_id: zStd, description: 'Taxable set', quantity: 1, unit_price: 1000, pricing_model: 'flat_fee' }], { apply_vat: true });
        await accept(bV);
        const v1 = await waitLive(bV, x => same(x.total_amount, 1150));
        check('fixture: a VAT-inclusive quotation of R1,150.00 (R1,000.00 + R150.00 VAT), accepted and invoiced', r.status === 200 && !!v1 && same(v1.tax_amount, 150), JSON.stringify({ q: r.status, v1 }));
        await adjust(bV, 'credit', 100, 'courtesy');
        const v2 = await waitLive(bV, x => x.id !== v1.id);
        lg = await ledger(bV);
        check('a R100 credit lowers the total to R1,050.00 but leaves the quoted VAT alone: VAT R150.00, subtotal R900.00',
            !!v2 && same(v2.total_amount, 1050) && same(v2.tax_amount, 150) && same(v2.subtotal, 900) && same(lg.total_amount, 1050), JSON.stringify({ v2, lg }));
        p = await pdf(bV);
        check('the PDF keeps "VAT (15%) R 150.00", shows the credit, and totals R1,050.00 (incl. VAT)',
            /VAT \(15%\) R 150\.00/.test(p.text) && /Adjustment \(credit\) - R 100\.00/.test(p.text) && /TOTAL \(incl\. VAT\) R 1050\.00/.test(p.text), p.text.slice(-700));

        // ═══ C. A new quotation supersedes the adjustments made under the earlier one ═══
        const bN = await manual([{ service_id: sClub }], 'requote');
        await quote(bN, [item5000]);
        await accept(bN);
        const n1 = await waitLive(bN, x => same(x.total_amount, 5000));
        await adjust(bN, 'credit', 1000, 'first-quote goodwill');
        const n2 = await waitLive(bN, x => !!n1 && x.id !== n1.id);
        check('fixture: the credit applies to the first quotation (R4,000.00)', !!n2 && same(n2.total_amount, 4000), JSON.stringify(await allInv(bN)));
        await sleep(1300);   // timestamps resolve to the second: the new quotation must be issued after the adjustment
        r = await quote(bN, [{ ...item5000, unit_price: 6000 }]);
        check('re-quoting at R6,000.00 returns the booking to QUOTED', r.status === 200 && (await ledger(bN)).status === 'QUOTED', `${r.status} ${JSON.stringify(await ledger(bN))}`);
        await accept(bN);
        const n3 = await waitLive(bN, x => same(x.total_amount, 6000), 25000);
        const n3lines = n3 ? await lines(n3.id) : [];
        lg = await ledger(bN);
        check('the new quotation stands on its own: the invoice is R6,000.00 with the quoted line only (the old credit does not carry over)',
            !!n3 && n3lines.length === 1 && same(lg.total_amount, 6000) && (await schedSum(bN)) === 6000, JSON.stringify({ n3, n3lines, lg, s: await sched(bN) }));
        check('...while the old adjustment stays in the books as history', (await q("SELECT id FROM transactions WHERE booking_id = ? AND transaction_type = 'adjustment'", [bN])).length === 1);
        await adjust(bN, 'debit', 250, 'after the new quote');
        const n4 = await waitLive(bN, x => !!n3 && x.id !== n3.id);
        check('an adjustment made after the new quotation applies to it: R6,250.00', !!n4 && same(n4.total_amount, 6250) && same((await ledger(bN)).total_amount, 6250), JSON.stringify(await allInv(bN)));

        // ═══ D. An adjustment made before the client accepts ═══
        const bD = await manual([{ service_id: sClub }], 'pre-accept');
        await quote(bD, [item5000]);
        r = await adjust(bD, 'credit', 500, 'early-bird');
        check('fixture: a R500 credit is logged while the quotation is still waiting for the client (no invoice yet)', r.status === 200 && (await live(bD)).length === 0 && same((await ledger(bD)).total_amount, 4500), JSON.stringify({ r: r.status, inv: await live(bD), lg: await ledger(bD) }));
        const acD = await accept(bD);
        const d1 = await waitLive(bD, () => true);
        lg = await ledger(bD);
        check('the first invoice honours it: R4,500.00, booking total R4,500.00', acD.status === 200 && !!d1 && same(d1.total_amount, 4500) && same(lg.total_amount, 4500), JSON.stringify({ acD: acD.status, d1, lg }));
        check('...and the payment schedule the client was given adds up to it (2 x R2,250.00)', (await schedSum(bD)) === 4500 && (await sched(bD)).map(x => x.expected_amount).join() === '2250,2250', JSON.stringify(await sched(bD)));

        // ═══ E. A duplicate-flagged adjustment is ignored ═══
        const bE = await manual([{ service_id: sClub }], 'duplicate');
        await quote(bE, [{ ...item5000, unit_price: 2000 }]);
        await accept(bE);
        const e1 = await waitLive(bE, x => same(x.total_amount, 2000));
        const adjE = await adjust(bE, 'credit', 300, 'entered twice');
        const e2 = await waitLive(bE, x => !!e1 && x.id !== e1.id);
        check('fixture: the credit lowers the invoice to R1,700.00', !!e2 && same(e2.total_amount, 1700), JSON.stringify(await allInv(bE)));
        const flag = await api('PATCH', `/api/admin/transactions/${adjE.body.transaction_id}/reconcile`, { is_duplicate: true, reconcile_note: 'duplicate entry' });
        r = await api('POST', `/api/admin/bookings/${bE}/invoice/generate`, {});
        const e3 = (await live(bE))[0];
        check('flagged as a duplicate, the adjustment no longer counts: the rebuilt invoice is back to R2,000.00 with no adjustment line',
            flag.status === 200 && r.status === 200 && !!e3 && same(e3.total_amount, 2000) && (await lines(e3.id)).length === 1 && same((await ledger(bE)).total_amount, 2000), JSON.stringify({ flag: flag.status, r: r.status, e3, l: e3 ? await lines(e3.id) : null }));
        await api('PATCH', `/api/admin/transactions/${adjE.body.transaction_id}/reconcile`, { is_duplicate: false });
        r = await api('POST', `/api/admin/bookings/${bE}/invoice/generate`, {});
        check('un-flagged, it counts again: R1,700.00', r.status === 200 && same((await live(bE))[0].total_amount, 1700), JSON.stringify(await allInv(bE)));

        // ═══ F. A credit bigger than what is still owed ═══
        const bG = await manual([{ service_id: sClub }], 'over-credit');
        await quote(bG, [item5000]);
        await accept(bG);
        const g1 = await waitLive(bG, x => same(x.total_amount, 5000));
        const gPay = await api('POST', '/api/admin/transactions/manual', { booking_id: bG, amount: 2500, transaction_type: 'payment', payment_method: 'eft', reference: 'ZZ-ADJ deposit' });
        await poll(async () => { const s = await sched(bG); return s.length && s[0].status === 'paid'; });   // the milestone is marked paid just after the response
        r = await adjust(bG, 'credit', 3000, 'bigger than what is left to pay');
        const g2 = await waitLive(bG, x => !!g1 && x.id !== g1.id);
        lg = await ledger(bG);
        check('a credit bigger than what is still owed: total R2,000.00 against R2,500.00 paid - the balance stops at R0.00, never negative, and the booking reads PAID',
            gPay.status === 200 && r.status === 200 && !!g2 && same(g2.total_amount, 2000) && same(lg.total_amount, 2000) && same(lg.amount_paid, 2500) && same(lg.amount_outstanding, 0) && lg.payment_status === 'PAID', JSON.stringify({ pay: gPay.status, adj: r.status, g2, lg }));
        check('...the invoice shows the full R3,000.00 credit, and the schedule is left as it was (paid milestones already exceed the new total - a refund decision, not a rescale)',
            !!g2 && (await lines(g2.id)).length === 2 && same((await lines(g2.id))[1].unit_price, -3000) && (await sched(bG)).map(x => x.expected_amount).join() === '2500,2500', JSON.stringify({ l: g2 ? await lines(g2.id) : null, s: await sched(bG) }));

        // ═══ G. The pure helpers ═══
        let pure = null;
        try { pure = { ...require('../lib/booking-adjustments'), ...require('../lib/schedule-rebalance') }; } catch (e) { check('the adjustment and schedule-rebalance helpers exist', false, e.message.split('\n')[0]); }
        if (pure) {
            const row = (id, direction, amount, note) => ({ id, amount, notes: note === undefined ? `[Adjustment: ${direction}]` : `[Adjustment: ${direction}] ${note}` });
            let a = pure.applyAdjustments(5000, [row(1, 'credit', 1000, 'goodwill discount')]);
            check('maths: a R1,000 credit on R5,000 -> R4,000, one line, signed -1000', a.total === 4000 && a.net === -1000 && a.lines.length === 1 && a.lines[0].signed === -1000 && a.lines[0].label === 'Adjustment (credit)' && a.lines[0].description === 'Adjustment (credit) – goodwill discount', JSON.stringify(a));
            a = pure.applyAdjustments(5000, [row(1, 'credit', 1000, 'a'), row(2, 'debit', 500, 'b')]);
            check('maths: credit then debit -> R4,500, lines in the order they were logged', a.total === 4500 && a.net === -500 && a.lines.map(x => x.signed).join() === '-1000,500', JSON.stringify(a));
            a = pure.applyAdjustments(500, [row(1, 'credit', 800, 'too big'), row(2, 'debit', 300, 'back up')]);
            check('maths: a credit bigger than the total stops at R0 (the line shows what was really taken off, -500), then a debit builds from R0 - exactly what the ledger does', a.total === 300 && a.lines[0].signed === -500 && a.lines[0].applied === 500 && a.lines[0].requested === 800 && a.lines[1].signed === 300, JSON.stringify(a));
            a = pure.applyAdjustments(100.10, [row(1, 'credit', 0.05, 'cents')]);
            check('maths: amounts are kept to the cent', a.total === 100.05, JSON.stringify(a));
            a = pure.applyAdjustments(1000, [{ id: 1, amount: 50, notes: 'no direction recorded' }, { id: 2, amount: 0, notes: '[Adjustment: credit] zero' }, { id: 3, amount: -20, notes: '[Adjustment: debit] negative' }, row(4, 'debit', 10)]);
            check('maths: a row with no recorded direction, a zero and a negative amount are ignored; a note-less adjustment still reads "Adjustment (debit)"',
                a.total === 1010 && a.lines.length === 1 && a.lines[0].description === 'Adjustment (debit)', JSON.stringify(a));
            check('maths: nothing logged -> the base total, unchanged', pure.applyAdjustments(1234.5, []).total === 1234.5 && pure.applyAdjustments(1234.5, null).lines.length === 0);

            const S = (id, amt, status = 'pending') => ({ id, expected_amount: amt, status });
            let pl = pure.planScheduleRebalance([S(1, 2500), S(2, 2500)], 4000);
            check('rebalance: two pending milestones scale proportionally to the new total (2 x R2,000)', pl.ok && pl.updates.map(u => `${u.id}:${u.amount}`).join() === '1:2000,2:2000', JSON.stringify(pl));
            pl = pure.planScheduleRebalance([S(1, 2500, 'paid'), S(2, 2500)], 4000);
            check('rebalance: a paid milestone is kept; the pending one takes the rest (R1,500)', pl.ok && pl.updates.length === 1 && pl.updates[0].id === 2 && pl.updates[0].amount === 1500, JSON.stringify(pl));
            pl = pure.planScheduleRebalance([S(1, 1500), S(2, 1500), S(3, 2000)], 4000);
            check('rebalance: a 30/30/40 plan keeps its proportions', pl.ok && pl.updates.map(u => u.amount).join() === '1200,1200,1600', JSON.stringify(pl));
            pl = pure.planScheduleRebalance([S(1, 1000), S(2, 1000), S(3, 1000)], 1000.01);
            check('rebalance: rounding drift is absorbed so the milestones add up exactly', pl.ok && money(pl.updates.reduce((s, u) => s + u.amount, 0)) === 1000.01, JSON.stringify(pl));
            pl = pure.planScheduleRebalance([S(1, 2500, 'paid'), S(2, 2500)], 2000);
            check('rebalance: refuses when the paid milestones already exceed the new total (a refund decision, not a rescale)', !pl.ok && pl.reason === 'paid-exceeds-total' && pl.updates.length === 0, JSON.stringify(pl));
            pl = pure.planScheduleRebalance([S(1, 2000, 'paid'), S(2, 2000, 'paid')], 4000);
            check('rebalance: everything paid and already matching -> nothing to do', pl.ok && pl.updates.length === 0, JSON.stringify(pl));
            pl = pure.planScheduleRebalance([], 4000);
            check('rebalance: no schedule -> nothing to do', !pl.ok && pl.reason === 'no-schedule', JSON.stringify(pl));

            // parity with the real rebalance route: manufacture a mismatch on a fresh booking and let both rescale it
            const bP = await manual([{ service_id: sClub }], 'parity');
            await quote(bP, [{ ...item5000, unit_price: 5000 }]);
            await accept(bP);
            await waitLive(bP, x => same(x.total_amount, 5000));
            const before = await sched(bP);
            await run('UPDATE bookings SET total_amount = 3999.99 WHERE id = ?', [bP]);
            r = await api('POST', `/api/admin/bookings/${bP}/payment-schedules/rebalance`, {});
            const viaRoute = (await sched(bP)).map(x => x.expected_amount);
            const viaPlan = pure.planScheduleRebalance(before.map((x, i) => ({ id: i + 1, expected_amount: x.expected_amount, status: x.status })), 3999.99).updates.map(u => u.amount);
            check('parity: the real "Rebalance" route and the planner produce the same milestones', r.status === 200 && viaRoute.join() === viaPlan.join(), JSON.stringify({ route: viaRoute, plan: viaPlan, status: r.status }));
        }

        // ═══ H. An adjustment is never money received ═══
        // A credit / debit changes what is OWED. Several places summed every completed transaction as money in, so an adjustment was counted
        // as revenue (dashboard, 12-month trend, revenue by category, the P&L), as a payment when a cancellation refund recomputed what was
        // paid, and inflated "Effective_Received" - with a false overpayment warning - in the accountant's reconciliation CSV.
        const csv = (s) => s.split(/\r?\n/).filter(Boolean).map(line => { const out = []; let cur = '', inQ = false; for (let i = 0; i < line.length; i++) { const c = line[i]; if (inQ) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') inQ = false; else cur += c; } else if (c === '"') inQ = true; else if (c === ',') { out.push(cur); cur = ''; } else cur += c; } out.push(cur); return out; });
        const month = new Date().toISOString().slice(0, 7);
        const metric = async () => {
            const st = ((await api('GET', '/api/admin/financials/stats')).body || {}).stats || {};
            const an = (await api('GET', '/api/admin/financials/analytics')).body || {};
            const pl = (await api('GET', '/api/admin/finance/pl?period=month')).body || {};
            const trend = (an.revenueTrend || []).find(x => x.month === month);
            return { dashboard: Number(st.revenue) || 0, trend: trend ? Number(trend.total_revenue) : 0, plRevenue: Number((pl.totals || {}).revenue) || 0 };
        };
        // A payment is recorded through PUT .../manual-payment here, which writes ONE transaction row. (POST /api/admin/transactions/manual
        // with type "payment" writes TWO for the same payment - a separate, pre-existing defect that is reported, not part of this change -
        // so it would double every figure below and test that bug instead of the adjustments.)
        const payOnce = async (id, amount) => {
            const resp = await api('PUT', `/api/admin/bookings/${id}/manual-payment`, { amount_paid: amount });
            await poll(async () => (await one("SELECT COUNT(*) c FROM transactions WHERE booking_id = ? AND transaction_type = 'payment'", [id])).c >= 1);   // the row is written just after the response
            return resp;
        };
        const bH = await manual([{ service_id: sClub }], 'not-money');
        await quote(bH, [item5000]);
        await accept(bH);
        await waitLive(bH, x => same(x.total_amount, 5000));
        const m0 = await metric();
        const payH = await payOnce(bH, 2000);
        const m1 = await metric();
        await adjust(bH, 'credit', 2800, 'large credit');
        await adjust(bH, 'debit', 100, 'small debit');
        const m2 = await metric();
        const delta = (b, a) => ({ dashboard: money(a.dashboard - b.dashboard), trend: money(a.trend - b.trend), plRevenue: money(a.plRevenue - b.plRevenue) });
        check('the R2,000 payment is revenue exactly once everywhere: dashboard, 12-month trend and the P&L each go up by R2,000.00',
            payH.status === 200 && JSON.stringify(delta(m0, m1)) === JSON.stringify({ dashboard: 2000, trend: 2000, plRevenue: 2000 }), JSON.stringify({ pay: payH.status, delta: delta(m0, m1) }));
        check('...and a R2,800 credit plus a R100 debit add NOTHING to revenue anywhere (they used to add R2,900)',
            JSON.stringify(delta(m0, m2)) === JSON.stringify({ dashboard: 2000, trend: 2000, plRevenue: 2000 }), JSON.stringify({ afterPayment: delta(m0, m1), afterAdjustments: delta(m0, m2) }));
        const an0 = ((await api('GET', '/api/admin/financials/analytics')).body || {});
        const cat = (an0.revenueByCategory || []).find(x => x.category === 'Corporate');
        const catRows = (await q("SELECT COALESCE(SUM(t.amount), 0) AS s FROM transactions t JOIN bookings b ON t.booking_id = b.id WHERE t.status = 'completed' AND COALESCE(t.is_duplicate, 0) = 0 AND COALESCE(NULLIF(b.event_type, ''), 'Other') = 'Corporate' AND t.transaction_type = 'adjustment'"))[0].s;
        check('revenue by category and top clients leave adjustments out as well (the "Corporate" row equals its payments, none of the R2,900 of adjustments)',
            !!cat && catRows >= 2900 && money(cat.revenue) === money((await q("SELECT COALESCE(SUM(t.amount), 0) AS s FROM transactions t JOIN bookings b ON t.booking_id = b.id WHERE t.status = 'completed' AND COALESCE(t.is_duplicate, 0) = 0 AND COALESCE(NULLIF(b.event_type, ''), 'Other') = 'Corporate' AND COALESCE(t.transaction_type, '') <> 'adjustment'"))[0].s),
            JSON.stringify({ category: cat, adjustmentsInCorporate: catRows }));

        const recCsv = csv((await apiBinary('GET', '/api/admin/reconciliation/export/csv')).buffer.toString('utf8'));
        const rh = recCsv[0], rIdx = (n) => rh.indexOf(n);
        const rowH = recCsv.find(x => x[0] === String(bH));
        check("the accountant's reconciliation CSV: Manual_Received and Effective_Received are the R2,000.00 actually paid, and there is no false overpayment warning",
            !!rowH && same(rowH[rIdx('Manual_Received')], 2000) && same(rowH[rIdx('Effective_Received')], 2000) && rowH[rIdx('OverpaymentWarning')] === 'NO', JSON.stringify(rowH));

        // What the client is asked to PAY must follow the adjustment. The "pay in full" amount was taken from the quotation (quote_amount), so
        // after a R1,000 credit the client would still have been sent to PayFast for R5,000 - and the booking then overpaid by the credit.
        const bPay = await manual([{ service_id: sClub }], 'pay-amount');
        await quote(bPay, [item5000]);
        await accept(bPay);
        await waitLive(bPay, x => same(x.total_amount, 5000));
        await adjust(bPay, 'credit', 1000, 'goodwill before payment');
        await waitLive(bPay, x => same(x.total_amount, 4000));
        const payToken = await getTrackingToken(bPay, emails.get(bPay));
        const payFull = await pub('POST', `/api/public/bookings/${bPay}/pay`, { payment_type: 'FULL', access_token: payToken });
        const payDep = await pub('POST', `/api/public/bookings/${bPay}/pay`, { payment_type: 'DEPOSIT', access_token: payToken });
        check('after a R1,000 credit the client is asked to pay R4,000.00 in full - not the R5,000.00 that was quoted',
            payFull.status === 200 && payFull.body && payFull.body.pfData && payFull.body.pfData.amount === '4000.00', JSON.stringify({ s: payFull.status, amount: payFull.body && payFull.body.pfData && payFull.body.pfData.amount }));
        check('...and the deposit is the rescaled first milestone, R2,000.00 (guard)', payDep.status === 200 && payDep.body && payDep.body.pfData && payDep.body.pfData.amount === '2000.00', JSON.stringify({ s: payDep.status, amount: payDep.body && payDep.body.pfData && payDep.body.pfData.amount }));

        // a cancellation refund recomputes what was paid from the transactions: payments minus refunds, never adjustments
        const bR = await manual([{ service_id: sClub }], 'cancel-refund');
        await quote(bR, [item5000]);
        await accept(bR);
        await waitLive(bR, x => same(x.total_amount, 5000));
        await payOnce(bR, 2000);
        await poll(async () => { const s = await sched(bR); return s.length && s[0].status === 'paid'; });
        await adjust(bR, 'credit', 500, 'before cancelling');
        const cancelR = await api('POST', `/api/admin/bookings/${bR}/cancel`, { reason: 'adjustment test', cancelled_by: 'mutual' });
        const refundR = await api('PUT', `/api/admin/bookings/${bR}/refund`, { refund_amount: 300, refund_reference: 'ZZ-ADJ-REFUND-1' });
        lg = await ledger(bR);
        check('a cancellation refund recomputes what was paid from payments and refunds only: R2,000 - R300 = R1,700 (the R500 credit is not a payment; it used to read R2,200)',
            cancelR.status === 200 && refundR.status === 200 && same(lg.amount_paid, 1700), JSON.stringify({ cancel: cancelR.status, refund: refundR.status, lg }));
    } finally {
        await new Promise(res => rw.close(res));
        for (const id of createdIds) await api('DELETE', `/api/admin/services/${id}`);
    }
};
