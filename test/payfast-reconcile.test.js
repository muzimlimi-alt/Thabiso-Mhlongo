// The PayFast safety net end to end (lib/payfast-reconcile.js): a buyer paid at PayFast, PayFast's notification never reached us, and the booking must still end
// up correctly paid - once, exactly, and only when PayFast's OWN records say so. The real server runs against test/fake-payfast-api.js (PayFast's merchant API,
// as strict as PayFast about the signature), so nothing here can touch the real PayFast.
//
// What must hold:
//   * a payment is recorded ONLY when it matches a pending attempt exactly (reference, amount to the cent, rand, after the attempt began, not already recorded);
//   * recording is one ordinary PayFast ledger payment (same row shape, same booking credit, invoice settled when paid in full), never twice - not by two
//     checks, not by a check and a late notification, in either order;
//   * anything that does not match is NEVER credited: an administrator is told once and can resolve it;
//   * when PayFast cannot be reached nothing is changed, the failure is visible, and it backs off;
//   * a buyer can only ever ask about their own booking, and learns nothing but a status word.
// Date offsets 1800-1829 are reserved for this file.
const fs = require('fs');
const sqlite3 = require('sqlite3');
const { api, pub, q, one, future, sleep, getTrackingToken, loginAs, TEST_DB, BASE } = require('./support');
const { createFakePayFastApi, row, sastNow } = require('./fake-payfast-api');

const write = (sql, params = []) => new Promise((resolve, reject) => {
    const d = new sqlite3.Database(TEST_DB);
    d.configure('busyTimeout', 8000);
    d.run(sql, params, function (e) { d.close(() => (e ? reject(e) : resolve(this))); });
});

module.exports = async function ({ check }) {
    const poll = async (fn, ms = 12000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(150); } return v; };
    const sClub = (await one("SELECT id FROM services WHERE name = 'Club – 10 min Set (Guest Spot)'")).id;   // fixed R5,000
    let day = 1800, seq = 0, pf = 7000000 + Math.floor(Math.random() * 100000);
    const nextPf = () => String(++pf);
    const fake = createFakePayFastApi({ port: 3198, merchantId: '10000100', passphrase: '' });
    await fake.start();

    // an accepted R5,000 booking (invoice + two 50/50 instalments of R2,500)
    const makeBooking = async (label) => {
        const email = `pfrec.${Date.now()}.${seq++}@example.invalid`;
        const created = await api('POST', '/api/admin/bookings', {
            name: `PFREC ${label}`, email, cell: '+27821234567', event_date: future(day++), event_name: `PFREC ${label}`, event_type: 'Corporate', event_location: 'Hall',
            message: 'PayFast safety net integration test booking, over ten characters.', services: [{ service_id: sClub }], status: 'NEW', override_working_hours: true, override_conflict: true });   // calendar availability is not what this file tests
        const id = created.body && created.body.booking_id;
        if (!id) throw new Error(`could not create the "${label}" booking: ${created.status} ${JSON.stringify(created.body)}`);
        const bk = await one('SELECT date FROM bookings WHERE id = ?', [id]);
        if (!bk) throw new Error(`booking "${label}" (#${id}) is not in the database after creating it: ${created.status} ${JSON.stringify(created.body)} / max id ${JSON.stringify(await one('SELECT MAX(id) m, COUNT(*) c FROM bookings'))}`);
        const expiry = new Date(Date.parse(bk.date) - 10 * 86400000).toISOString().slice(0, 10);
        await api('POST', `/api/admin/bookings/${id}/quote`, { quote_expiry_date: expiry, terms: 'T', apply_vat: false, discount: 0, items: [{ service_id: sClub, description: 'Club set', quantity: 1, unit_price: 5000, pricing_model: 'flat_fee' }] });
        const token = await getTrackingToken(id, email);
        await pub('POST', `/api/public/bookings/${id}/accept-quote`, { access_token: token, terms_agreed: true });
        await poll(async () => one('SELECT id FROM invoices WHERE booking_id = ?', [id]));
        // keep the background reminder jobs away from this booking (they would write reminder rows mid-test)
        await write("UPDATE payment_schedules SET due_date = '2099-01-01' WHERE booking_id = ?", [id]);
        return { id, email, token };
    };
    // the buyer presses "Pay Now" on the first instalment: this is what records the payment ATTEMPT (the intent) and builds the PayFast form
    const startPayment = async (b) => {
        const sched = (await q('SELECT id, expected_amount FROM payment_schedules WHERE booking_id = ? ORDER BY sequence, due_date, id', [b.id]))[0];
        const pay = await pub('POST', `/api/public/bookings/${b.id}/pay`, { access_token: b.token, schedule_id: sched.id });
        const intent = await poll(async () => one('SELECT * FROM payfast_payment_intents WHERE booking_id = ?', [b.id]));
        return { sched, pay, intent };
    };
    const payfastRow = (intent, over = {}) => row({ date: sastNow(5), grossCents: Math.round(intent.expected_amount * 100), mPaymentId: intent.m_payment_id, pfPaymentId: nextPf(), name: `Booking ${intent.booking_id} - test`, ...over });
    const run = (b, extra = {}) => api('POST', '/api/admin/payfast/reconcile/run', { ...(b ? { booking_id: b.id } : {}), ...extra });
    const booking = (id) => one('SELECT status, payment_status, amount_paid, amount_outstanding, total_amount FROM bookings WHERE id = ?', [id]);
    const txs = (id) => q("SELECT * FROM transactions WHERE booking_id = ? AND source = 'payfast' ORDER BY id", [id]);
    const mails = (like) => q('SELECT subject, body FROM notifications WHERE subject LIKE ? ORDER BY id', [like]);
    const html = (r) => { try { return JSON.parse(r.body).htmlContent || ''; } catch (e) { return ''; } };
    const finding = (pfId) => one('SELECT * FROM payfast_reconcile_findings WHERE pf_payment_id = ?', [String(pfId)]);

    try {
        // ═══ nothing to do ═══
        const idle = await makeBooking('idle');
        fake.reset();
        const r0 = await run(idle);
        check('with no payment attempt waiting, a check does nothing and does not even ask PayFast', r0.status === 200 && r0.body.success && r0.body.checked === 0 && r0.body.recovered.length === 0 && fake.state.calls.length === 0, JSON.stringify(r0.body) + ' calls=' + fake.state.calls.length);

        // ═══ the notification never arrived: PayFast's own record recovers it ═══
        const A = await makeBooking('A');
        const a = await startPayment(A);
        check('setup: pressing Pay Now recorded a pending attempt for R2,500.00 under the reference <booking>_SCHED<instalment>', a.intent && a.intent.status === 'pending' && a.intent.expected_amount === 2500 && a.intent.m_payment_id === `${A.id}_SCHED${a.sched.id}`, JSON.stringify(a.intent));
        fake.reset();
        const rowA = fake.addRow(payfastRow(a.intent));
        const before = await booking(A.id);
        const resA = await run(A);
        check('the check asks PayFast (signed correctly), finds the payment and records it', resA.status === 200 && resA.body.success && resA.body.recovered.length === 1 && resA.body.recovered[0].pfPaymentId === rowA.pfPaymentId && resA.body.recovered[0].amount === 2500, JSON.stringify(resA.body));
        check('...PayFast was asked once, with a verified signature, the merchant id, API version v1 and ?testing=true (the site is on PayFast\'s sandbox)',
            fake.state.calls.length === 1 && fake.state.calls[0].sigOk && fake.state.calls[0].merchantId === '10000100' && fake.state.calls[0].version === 'v1' && fake.state.calls[0].query.testing === 'true' && fake.state.calls[0].query.limit === '1000', JSON.stringify(fake.state.calls));
        const afterA = await booking(A.id);
        check('the booking is credited exactly R2,500.00: R2,500.00 paid, R2,500.00 outstanding, DEPOSIT_PAID, and a payment CONFIRMS it', before.amount_paid === 0 && afterA.amount_paid === 2500 && afterA.amount_outstanding === 2500 && afterA.payment_status === 'DEPOSIT_PAID' && afterA.status === 'CONFIRMED', JSON.stringify(afterA));
        const txA = await txs(A.id);
        check('...as ONE ordinary PayFast ledger row keyed by PayFast\'s own payment id, verified, completed, for the exact amount',
            txA.length === 1 && txA[0].amount === 2500 && txA[0].pf_payment_id === rowA.pfPaymentId && txA[0].reference === rowA.pfPaymentId && txA[0].is_verified === 1 && txA[0].status === 'completed' && txA[0].transaction_type === 'payment' && txA[0].payment_method === 'payfast' && txA[0].pf_status === 'COMPLETE', JSON.stringify(txA));
        const intentA = await one('SELECT status, fulfilled_at FROM payfast_payment_intents WHERE id = ?', [a.intent.id]);
        check('...the attempt is marked fulfilled (the hourly "stuck payment" alert will not fire for it)', intentA.status === 'fulfilled' && intentA.fulfilled_at, JSON.stringify(intentA));
        check('...the first payment milestone is marked paid', !!(await poll(async () => (await q('SELECT status FROM payment_schedules WHERE booking_id = ? ORDER BY sequence, id', [A.id]))[0].status === 'paid')), JSON.stringify(await q('SELECT status FROM payment_schedules WHERE booking_id = ?', [A.id])));
        const fA = await finding(rowA.pfPaymentId);
        check('...and it is on the record as a recovered payment (resolved, linked to the ledger row)', fA && fA.kind === 'recovered' && fA.status === 'resolved' && fA.transaction_id === txA[0].id && fA.booking_id === A.id && fA.gross_amount === 2500, JSON.stringify(fA));
        check('...in the payment log and the audit trail, with who/what/why', (await q("SELECT event_type FROM payment_logs WHERE booking_id = ? AND event_type = 'RECONCILED_FROM_PAYFAST'", [A.id])).length === 1
            && !!(await one("SELECT * FROM audit_log WHERE table_name = 'bookings' AND record_id = ? AND action = 'PAYFAST_PAYMENT_RECOVERED'", [A.id])), '');
        const clientMail = await poll(async () => (await mails(`%Payment Received – Booking #${A.id}`))[0]);
        check('the client gets the same payment-received e-mail a card payment gives, with the figures', clientMail && /R2500\.00/.test(html(clientMail)) && /R5000\.00/.test(html(clientMail)), clientMail ? html(clientMail).slice(0, 200) : 'no e-mail');
        const ownerMail = await poll(async () => (await mails(`[PayFast] Recorded a payment whose notification never arrived - booking #${A.id}`))[0]);
        check('the OWNER is told a payment had to be recovered (a sign that PayFast\'s notifications are not arriving)', ownerMail && /never reached/.test(html(ownerMail)) && html(ownerMail).includes(rowA.pfPaymentId), ownerMail ? '' : 'no owner e-mail');

        // ═══ never twice ═══
        fake.state.calls.length = 0;
        const again = await run(A);
        check('running the check again records nothing more (the attempt is fulfilled, so PayFast is not even asked)', again.body.recovered.length === 0 && again.body.checked === 0 && (await txs(A.id)).length === 1 && (await booking(A.id)).amount_paid === 2500 && fake.state.calls.length === 0, JSON.stringify(again.body));
        const late = { m_payment_id: a.intent.m_payment_id, pf_payment_id: rowA.pfPaymentId, payment_status: 'COMPLETE', item_name: `Booking ${A.id} - test`, amount_gross: '2500.00', amount_fee: '-57.50', amount_net: '2442.50', merchant_id: '10000100', email_address: A.email };
        await pub('POST', '/api/payment/webhook/payfast', late);
        await sleep(1500);
        check('THEN the lost notification finally arrives: it is ignored as a duplicate (still one ledger row, still R2,500.00)', (await txs(A.id)).length === 1 && (await booking(A.id)).amount_paid === 2500 && (await q("SELECT event_type FROM payment_logs WHERE booking_id = ? AND event_type = 'IGNORED_DUPLICATE'", [A.id])).length >= 1, JSON.stringify(await q('SELECT event_type FROM payment_logs WHERE booking_id = ?', [A.id])));

        // the other order: the notification arrives first, the check finds nothing to do
        const A2 = await makeBooking('A2');
        const a2 = await startPayment(A2);
        const pf2 = nextPf();
        await pub('POST', '/api/payment/webhook/payfast', { m_payment_id: a2.intent.m_payment_id, pf_payment_id: pf2, payment_status: 'COMPLETE', item_name: `Booking ${A2.id} - test`, amount_gross: '2500.00', amount_fee: '-57.50', amount_net: '2442.50', merchant_id: '10000100', email_address: A2.email });
        await poll(async () => (await txs(A2.id)).length === 1);
        fake.reset(); fake.addRow(payfastRow(a2.intent, { pfPaymentId: pf2 }));
        const rA2 = await run(A2);
        check('and when the notification arrived FIRST, the check has nothing to do and nothing is recorded twice', rA2.body.recovered.length === 0 && (await txs(A2.id)).length === 1 && (await booking(A2.id)).amount_paid === 2500, JSON.stringify(rA2.body));

        // a payment recorded by hand / another path with the same PayFast id between the plan and the credit
        const A3 = await makeBooking('A3');
        const a3 = await startPayment(A3);
        fake.reset(); const rowA3 = fake.addRow(payfastRow(a3.intent));
        await write("INSERT INTO transactions (booking_id, amount, transaction_type, transaction_date, payment_method, reference, status, source, pf_payment_id, is_verified) VALUES (?, 2500, 'payment', datetime('now'), 'payfast', ?, 'completed', 'payfast', ?, 1)", [A3.id, rowA3.pfPaymentId, rowA3.pfPaymentId]);
        const rA3 = await run(A3);
        check('a PayFast payment whose id is already in the ledger is never credited again (the ledger\'s UNIQUE id and the check agree)', rA3.body.recovered.length === 0 && rA3.body.findings.length === 0 && (await txs(A3.id)).length === 1 && (await booking(A3.id)).amount_paid === 0, JSON.stringify(rA3.body));

        // ═══ it matches, or it is not credited ═══
        const B = await makeBooking('B-wrong-amount');
        const b = await startPayment(B);
        fake.reset(); const rowB = fake.addRow(payfastRow(b.intent, { grossCents: 240000 }));
        const resB = await run(B);
        check('PayFast shows R2,400 but the payment set up was R2,500: NOTHING is credited', resB.body.recovered.length === 0 && (await txs(B.id)).length === 0 && (await booking(B.id)).amount_paid === 0 && (await one('SELECT status FROM payfast_payment_intents WHERE id = ?', [b.intent.id])).status === 'pending', JSON.stringify(resB.body));
        const fB = await finding(rowB.pfPaymentId);
        check('...it is reported instead: an OPEN finding that says what was received and what was expected', fB && fB.kind === 'mismatch' && fB.status === 'open' && /R2400\.00/.test(fB.detail) && /R2500\.00/.test(fB.detail) && fB.booking_id === B.id, JSON.stringify(fB));
        const attn = await poll(async () => (await mails('[PayFast] % payment(s) need your attention')).find((m) => html(m).includes(rowB.pfPaymentId)));
        check('...and the owner is e-mailed about it', !!attn && /Nothing was credited/i.test(html(attn)), attn ? '' : 'no e-mail');
        const mailsBefore = (await mails('[PayFast] % payment(s) need your attention')).length;
        await run(B); await run(B);
        check('...running the check again reports it only ONCE (no repeat e-mail, no repeat finding)', (await mails('[PayFast] % payment(s) need your attention')).length === mailsBefore && (await q('SELECT id FROM payfast_reconcile_findings WHERE pf_payment_id = ?', [rowB.pfPaymentId])).length === 1, '');

        const C = await makeBooking('C-earlier-attempt');
        const c = await startPayment(C);
        fake.reset(); const rowC = fake.addRow(payfastRow(c.intent, { date: sastNow(-3600) }));   // same reference and amount, but an hour BEFORE this attempt began
        const resC = await run(C);
        check('a payment under the same reference made BEFORE the current attempt began belongs to an earlier attempt: not credited, reported', resC.body.recovered.length === 0 && (await txs(C.id)).length === 0 && (await finding(rowC.pfPaymentId)).kind === 'mismatch' && /BEFORE the current payment attempt/.test((await finding(rowC.pfPaymentId)).detail), JSON.stringify(resC.body));

        const D = await makeBooking('D-double');
        const d = await startPayment(D);
        fake.reset(); const rowD1 = fake.addRow(payfastRow(d.intent, { date: sastNow(5) })); const rowD2 = fake.addRow(payfastRow(d.intent, { date: sastNow(40) }));
        const resD = await run(D);
        check('the buyer paid TWICE: the first payment is recorded, the second is reported as a duplicate for a refund decision - the booking is credited once',
            resD.body.recovered.length === 1 && resD.body.recovered[0].pfPaymentId === rowD1.pfPaymentId && (await txs(D.id)).length === 1 && (await booking(D.id)).amount_paid === 2500
            && (await finding(rowD2.pfPaymentId)).kind === 'duplicate_payment' && (await finding(rowD2.pfPaymentId)).status === 'open', JSON.stringify(resD.body));

        const E = await makeBooking('E-noise');
        const e = await startPayment(E);
        fake.reset();
        fake.addRow(payfastRow(e.intent, { type: 'REFUND', sign: 'DEBIT' }));
        fake.addRow(payfastRow(e.intent, { currency: 'USD', pfPaymentId: nextPf() }));
        fake.addRow(row({ date: sastNow(5), grossCents: 250000, mPaymentId: `${E.id}_SCHED999999`, pfPaymentId: nextPf() }));
        fake.addRow(row({ date: sastNow(5), grossCents: 250000, mPaymentId: '999999_FULL', pfPaymentId: nextPf() }));
        const resE = await run(E);
        check('PayFast rows that are not money received, not rand, or under another reference are never credited', resE.body.recovered.length === 0 && (await txs(E.id)).length === 0 && (await booking(E.id)).amount_paid === 0, JSON.stringify(resE.body));
        check('...only the foreign-currency one concerns this attempt, and it is reported; rows for other references are ignored silently', resE.body.findings.length === 1 && /USD/.test(resE.body.findings[0].detail), JSON.stringify(resE.body.findings));

        // ═══ the booking is in a state the money cannot be applied to ═══
        const F = await makeBooking('F-cancelled');
        const f = await startPayment(F);
        await api('POST', `/api/admin/bookings/${F.id}/cancel`, { reason: 'test', cancelled_by: 'client' });
        fake.reset(); const rowF = fake.addRow(payfastRow(f.intent));
        const resF = await run(F);
        const bkF = await booking(F.id);
        check('a payment for a booking cancelled in the meantime is STILL recorded (it is real money in the account) - the booking stays CANCELLED', resF.body.recovered.length === 1 && bkF.status === 'CANCELLED' && bkF.amount_paid === 2500, JSON.stringify({ r: resF.body.recovered, bk: bkF }));
        const ownerF = await poll(async () => (await mails(`[PayFast] Recorded a payment whose notification never arrived - booking #${F.id}`))[0]);
        check('...and the owner is warned that the booking is cancelled so a refund may be due', ownerF && /CANCELLED/.test(html(ownerF)) && /refund/i.test(html(ownerF)), ownerF ? html(ownerF).slice(0, 200) : 'no e-mail');

        const G = await makeBooking('G-overpay');
        const g = await startPayment(G);
        await write('UPDATE bookings SET amount_paid = 4000, amount_outstanding = 1000 WHERE id = ?', [G.id]);
        fake.reset(); const rowG = fake.addRow(payfastRow(g.intent));
        const resG = await run(G);
        check('a payment that would take the booking above its total is NOT recorded (the shared overpayment guard), the attempt stays pending, and it is reported as blocked',
            resG.body.recovered.length === 0 && (await txs(G.id)).length === 0 && (await booking(G.id)).amount_paid === 4000 && (await one('SELECT status FROM payfast_payment_intents WHERE id = ?', [g.intent.id])).status === 'pending'
            && (await finding(rowG.pfPaymentId)).kind === 'blocked' && /above its total/.test((await finding(rowG.pfPaymentId)).detail), JSON.stringify(resG.body));

        // ═══ the instalment was already settled another way (an EFT approved, a payment recorded by hand) ═══
        const S = await makeBooking('S-already-paid');
        const s = await startPayment(S);
        await write("UPDATE payment_schedules SET status = 'paid' WHERE id = ?", [s.sched.id]);
        await write("UPDATE bookings SET amount_paid = 2500, amount_outstanding = 2500, payment_status = 'DEPOSIT_PAID' WHERE id = ?", [S.id]);
        await write("INSERT INTO transactions (booking_id, amount, transaction_type, transaction_date, payment_method, reference, status, source) VALUES (?, 2500, 'payment', datetime('now'), 'bank_transfer', 'EFT by hand', 'completed', 'manual')", [S.id]);
        fake.reset(); const rowS = fake.addRow(payfastRow(s.intent));
        const previewS = await run(S, { dry_run: true });
        check('a preview does not promise to record a payment for an instalment that is already settled: it reports a possible double payment', previewS.body.recovered.length === 0 && previewS.body.findings.length === 1 && previewS.body.findings[0].kind === 'duplicate_payment' && !(await finding(rowS.pfPaymentId)), JSON.stringify(previewS.body));
        const resS = await run(S);
        check('PayFast took R2,500 for an instalment already paid by EFT: NOT credited again (still R2,500.00 paid, one ledger row, none from PayFast)', resS.body.recovered.length === 0 && (await booking(S.id)).amount_paid === 2500 && (await txs(S.id)).length === 0, JSON.stringify(resS.body));
        const fS = await finding(rowS.pfPaymentId);
        check('...it is an OPEN "paid twice" finding that says the instalment was already paid by another payment, and the attempt stays pending', fS && fS.kind === 'duplicate_payment' && fS.status === 'open' && /already marked as paid by another payment/.test(fS.detail) && /refund/.test(fS.detail)
            && (await one('SELECT status FROM payfast_payment_intents WHERE id = ?', [s.intent.id])).status === 'pending', JSON.stringify(fS));
        const mailS = await poll(async () => (await mails('[PayFast] % payment(s) need your attention')).find((m) => html(m).includes(rowS.pfPaymentId)));
        check('...and the owner is e-mailed about it', !!mailS, 'no e-mail');
        const mailsS = (await mails('[PayFast] % payment(s) need your attention')).length;
        await run(S);
        check('...reported once only', (await mails('[PayFast] % payment(s) need your attention')).length === mailsS && (await q('SELECT id FROM payfast_reconcile_findings WHERE pf_payment_id = ?', [rowS.pfPaymentId])).length === 1, '');

        // ═══ paid in full: the invoice is settled too ═══
        const P = await makeBooking('P-full');
        await pub('POST', `/api/public/bookings/${P.id}/pay`, { access_token: P.token, payment_type: 'FULL' });
        const intentP = await poll(async () => one('SELECT * FROM payfast_payment_intents WHERE booking_id = ?', [P.id]));
        fake.reset(); fake.addRow(payfastRow(intentP, { fundingType: 'CREDIT_CARD' }));
        const resP = await run(P);
        const bkP = await booking(P.id);
        check('a payment in full is recorded: R5,000.00 paid, nothing outstanding, PAID, CONFIRMED', intentP.expected_amount === 5000 && resP.body.recovered.length === 1 && bkP.amount_paid === 5000 && bkP.amount_outstanding === 0 && bkP.payment_status === 'PAID' && bkP.status === 'CONFIRMED', JSON.stringify({ r: resP.body, bkP }));
        check('...and the invoice is marked PAID with it', (await one("SELECT status FROM invoices WHERE booking_id = ? AND UPPER(status) <> 'VOID'", [P.id])).status === 'PAID', '');
        check('...the way PayFast says the buyer paid is kept on the ledger row (card)', (await txs(P.id))[0].payment_method === 'credit_card', JSON.stringify(await txs(P.id)));

        // ═══ a payment attempt whose reference belongs to another booking is never applied ═══
        const Q = await makeBooking('Q-foreign-reference');
        const qq = await startPayment(Q);
        await write("UPDATE payfast_payment_intents SET m_payment_id = ? WHERE id = ?", [`${A.id}_SCHED${qq.sched.id}`, qq.intent.id]);     // forged / corrupted: says it is for booking A
        fake.reset(); const rowQ = fake.addRow(payfastRow({ ...qq.intent, m_payment_id: `${A.id}_SCHED${qq.sched.id}` }));
        const paidA = (await booking(A.id)).amount_paid;
        const resQ = await run(Q);
        check('an attempt whose reference names a different booking is NOT applied to either booking, and is reported as blocked', resQ.body.recovered.length === 0 && (await txs(Q.id)).length === 0 && (await booking(Q.id)).amount_paid === 0 && (await booking(A.id)).amount_paid === paidA
            && (await finding(rowQ.pfPaymentId)).kind === 'blocked', JSON.stringify(resQ.body));

        // ═══ PayFast cannot be reached ═══
        const H = await makeBooking('H-outage');
        const h = await startPayment(H);
        fake.reset(); fake.addRow(payfastRow(h.intent));
        fake.setMode('auth');
        const alertsBefore = (await mails('[PayFast] The safety net cannot reach PayFast')).length;
        const resH = await run(H);
        check('when PayFast refuses the credentials the check fails SAFELY: 502, nothing recorded, the reason given', resH.status === 502 && resH.body.success === false && resH.body.error === 'AUTH' && /merchant id and passphrase/i.test(resH.body.message) && (await txs(H.id)).length === 0, JSON.stringify(resH.body));
        const st1 = (await api('GET', '/api/admin/payfast/reconcile')).body.status;
        check('...the failure is visible on the admin status (category, count, when it will try again)', st1.lastErrorCategory === 'AUTH' && st1.consecutiveFailures >= 1 && !!st1.retryAfter && !!st1.lastError, JSON.stringify(st1));
        check('...and a credentials problem e-mails the owner straight away (once)', !!(await poll(async () => (await mails('[PayFast] The safety net cannot reach PayFast')).length > alertsBefore)), '');
        await run(H);
        check('...a second failure does not e-mail again', (await mails('[PayFast] The safety net cannot reach PayFast')).length === alertsBefore + 1, String((await mails('[PayFast] The safety net cannot reach PayFast')).length - alertsBefore));
        for (const mode of ['error', 'rate', 'garbage', 'down']) {
            fake.setMode(mode);
            const rr = await run(H);
            check(`PayFast ${mode === 'error' ? 'answering 500' : mode === 'rate' ? 'rate-limiting us (429)' : mode === 'garbage' ? 'sending the wrong columns' : 'dropping the connection'}: nothing recorded, a clear failure, no crash`,
                rr.status === 502 && rr.body.success === false && (await txs(H.id)).length === 0 && (await booking(H.id)).amount_paid === 0, `${rr.status} ${JSON.stringify(rr.body)}`);
        }
        const stRate = await one('SELECT last_error_category c FROM payfast_reconcile_state WHERE id = 1');
        check('...each is categorised for the admin screen (the last one, a dropped connection, is NETWORK)', stRate.c === 'NETWORK', JSON.stringify(stRate));
        fake.setMode('ok');
        const resH2 = await run(H);
        check('once PayFast answers again the very same payment is recorded', resH2.body.recovered.length === 1 && (await txs(H.id)).length === 1 && (await booking(H.id)).amount_paid === 2500, JSON.stringify(resH2.body));
        const st2 = (await api('GET', '/api/admin/payfast/reconcile')).body.status;
        check('...and the failure state is cleared (no error, zero failures, no waiting period)', !st2.lastError && st2.consecutiveFailures === 0 && !st2.retryAfter && !!st2.lastSuccessAt, JSON.stringify(st2));

        // ═══ several bookings in one check, and a dry run ═══
        const I1 = await makeBooking('I1'), I2 = await makeBooking('I2');
        const i1 = await startPayment(I1), i2 = await startPayment(I2);
        fake.reset(); fake.addRow(payfastRow(i1.intent)); fake.addRow(payfastRow(i2.intent));
        const I3 = await makeBooking('I3-dry-mismatch');
        const i3 = await startPayment(I3);
        const rowI3 = fake.addRow(payfastRow(i3.intent, { grossCents: 100000 }));          // a mismatch: a dry run must not even REPORT it
        const mailsBeforeDry = (await mails('[PayFast] % payment(s) need your attention')).length;
        const dry = await run(null, { dry_run: true });
        check('a dry run shows a mismatch but writes no finding and sends no e-mail', dry.body.findings.some((x) => x.pfPaymentId === rowI3.pfPaymentId) && !(await finding(rowI3.pfPaymentId))
            && (await mails('[PayFast] % payment(s) need your attention')).length === mailsBeforeDry, JSON.stringify(dry.body.findings));
        check('a DRY RUN says what would be recorded and changes nothing: no credit, no ledger row, no finding, the attempts stay pending', dry.status === 200 && dry.body.recovered.filter((r) => [I1.id, I2.id].includes(r.bookingId)).length === 2
            && (await txs(I1.id)).length === 0 && (await txs(I2.id)).length === 0 && (await booking(I1.id)).amount_paid === 0
            && (await q("SELECT status FROM payfast_payment_intents WHERE booking_id IN (?, ?)", [I1.id, I2.id])).every((x) => x.status === 'pending'), JSON.stringify(dry.body.recovered));
        const all = await run(null);
        check('a check over everything waiting records every matching payment in one pass', all.body.recovered.filter((r) => [I1.id, I2.id].includes(r.bookingId)).length === 2 && (await txs(I1.id)).length === 1 && (await txs(I2.id)).length === 1, JSON.stringify(all.body.recovered));

        // ═══ the buyer comes back from PayFast ═══
        const J = await makeBooking('J-buyer');
        const j = await startPayment(J);
        const other = await makeBooking('J-other');
        fake.reset(); const rowJ = fake.addRow(payfastRow(j.intent));
        const noTok = await pub('POST', `/api/public/bookings/${J.id}/payment-check`, {});
        const wrongTok = await pub('POST', `/api/public/bookings/${J.id}/payment-check`, { access_token: other.token });
        check('the buyer\'s check needs a verified session for THAT booking (none: 401; another booking\'s: 401) and asks PayFast nothing', noTok.status === 401 && wrongTok.status === 401 && fake.state.calls.length === 0, `${noTok.status} ${wrongTok.status} calls=${fake.state.calls.length}`);
        const tooSoon = await pub('POST', `/api/public/bookings/${J.id}/payment-check`, { access_token: J.token });
        check('a buyer who has JUST started paying: the notification is given a moment to arrive by itself first (status "nothing", PayFast not asked)', tooSoon.status === 200 && tooSoon.body.status === 'nothing' && fake.state.calls.length === 0 && (await txs(J.id)).length === 0, JSON.stringify(tooSoon.body));
        await write("UPDATE payfast_payment_intents SET created_at = datetime('now', '-3 minutes') WHERE id = ?", [j.intent.id]);
        const back = await pub('POST', `/api/public/bookings/${J.id}/payment-check`, { access_token: J.token });
        check('a minute or so later the buyer\'s own page confirms the payment with PayFast and the booking is recorded as paid', back.status === 200 && back.body.status === 'recorded' && (await txs(J.id)).length === 1 && (await booking(J.id)).amount_paid === 2500, JSON.stringify(back.body));
        check('...and the answer carries a status word only: no amount, no PayFast id, nothing from PayFast\'s records', Object.keys(back.body).sort().join() === 'status,success' && !JSON.stringify(back.body).includes(rowJ.pfPaymentId), JSON.stringify(back.body));
        const throttled = await pub('POST', `/api/public/bookings/${J.id}/payment-check`, { access_token: J.token });
        check('...asking again straight away is throttled (status "busy"), so a page cannot hammer PayFast', throttled.status === 200 && throttled.body.status === 'busy', JSON.stringify(throttled.body));
        const K = await makeBooking('K-waiting');
        const k = await startPayment(K);
        await write("UPDATE payfast_payment_intents SET created_at = datetime('now', '-3 minutes') WHERE id = ?", [k.intent.id]);
        fake.reset();
        const waiting = await pub('POST', `/api/public/bookings/${K.id}/payment-check`, { access_token: K.token });
        check('when PayFast has not reported a payment (yet) the buyer is told "waiting" and nothing is recorded', waiting.body.status === 'waiting' && (await txs(K.id)).length === 0 && fake.state.calls.length === 1, JSON.stringify(waiting.body));

        const K2 = await makeBooking('K2-email-changed');
        const k2 = await startPayment(K2);
        await write("UPDATE payfast_payment_intents SET created_at = datetime('now', '-3 minutes') WHERE id = ?", [k2.intent.id]);
        fake.reset(); fake.addRow(payfastRow(k2.intent));
        await write("UPDATE bookings SET email = ? WHERE id = ?", [`changed.${Date.now()}@example.invalid`, K2.id]);       // the session was proven for the OLD address
        const stale = await pub('POST', `/api/public/bookings/${K2.id}/payment-check`, { access_token: K2.token });
        check('a session proven for an e-mail address the booking no longer has is refused (401, verify again) and PayFast is not asked', stale.status === 401 && fake.state.calls.length === 0 && (await txs(K2.id)).length === 0, `${stale.status} ${JSON.stringify(stale.body)}`);

        // ═══ the old attempts are left alone ═══
        const L = await makeBooking('L-old');
        const l = await startPayment(L);
        await write("UPDATE payfast_payment_intents SET created_at = datetime('now', '-30 days') WHERE id = ?", [l.intent.id]);
        fake.reset(); fake.addRow(payfastRow(l.intent, { date: sastNow(-29 * 86400) }));
        const resL = await run(L);
        check('an attempt older than 21 days is not chased (it is the owner\'s call by then)', resL.body.checked === 0 && (await txs(L.id)).length === 0, JSON.stringify(resL.body));

        // ═══ who may use it ═══
        const manager = await loginAs('manager');
        const assistant = await loginAs('assistant');
        check('only administrators and managers may see or run it: no login is 401, an assistant is 403, a manager is allowed',
            (await pub('GET', '/api/admin/payfast/reconcile')).status === 401 && (await pub('POST', '/api/admin/payfast/reconcile/run', {})).status === 401
            && (await assistant('GET', '/api/admin/payfast/reconcile')).status === 403 && (await assistant('POST', '/api/admin/payfast/reconcile/run', {})).status === 403
            && (await manager('GET', '/api/admin/payfast/reconcile')).status === 200 && (await manager('POST', '/api/admin/payfast/reconcile/run', { booking_id: idle.id })).status === 200, '');
        const status = (await api('GET', '/api/admin/payfast/reconcile')).body;
        check('the status shows it is enabled and configured, that this is a sandbox, the open findings and how many attempts are waiting', status.status.enabled && status.status.configured && status.status.sandbox === true && status.status.openFindings >= 4 && Array.isArray(status.findings), JSON.stringify(status.status));
        check('...and the status never reveals the merchant id, passphrase or any signature', !/10000100|passphrase|signature|merchant/i.test(JSON.stringify(status.status)), JSON.stringify(status.status));

        // ═══ resolving a finding ═══
        const open = status.findings.find((x) => x.pf_payment_id === rowB.pfPaymentId);
        const noNote = await api('POST', `/api/admin/payfast/reconcile/findings/${open.id}/resolve`, {});
        check('resolving a finding needs a few words on what was done (400 without)', noNote.status === 400 && (await finding(rowB.pfPaymentId)).status === 'open', JSON.stringify(noNote.body));
        const asAssistant = await assistant('POST', `/api/admin/payfast/reconcile/findings/${open.id}/resolve`, { note: 'recorded by hand' });
        check('...an assistant cannot (403)', asAssistant.status === 403 && (await finding(rowB.pfPaymentId)).status === 'open', '');
        const resolved = await api('POST', `/api/admin/payfast/reconcile/findings/${open.id}/resolve`, { note: 'Client paid R2,400 by mistake; refunded the difference by hand.' });
        const fB2 = await finding(rowB.pfPaymentId);
        check('...with a note it is resolved, recording who and when', resolved.status === 200 && fB2.status === 'resolved' && fB2.resolved_by && fB2.resolved_at && /refunded/.test(fB2.resolution_note), JSON.stringify(fB2));
        check('...it is in the audit log', !!(await one("SELECT * FROM audit_log WHERE table_name = 'payfast_reconcile_findings' AND record_id = ? AND action = 'PAYFAST_FINDING_RESOLVED'", [open.id])), '');
        check('...and cannot be resolved twice (409)', (await api('POST', `/api/admin/payfast/reconcile/findings/${open.id}/resolve`, { note: 'again please' })).status === 409, '');
        check('...resolving it does NOT make the check credit it: the same PayFast payment is still never recorded automatically', (await run(B)).body.recovered.length === 0 && (await txs(B.id)).length === 0, '');
        check('an unknown finding is 404', (await api('POST', '/api/admin/payfast/reconcile/findings/99999999/resolve', { note: 'whatever it was' })).status === 404, '');
    } finally {
        fake.setMode('ok');
        await fake.stop();
    }
};
