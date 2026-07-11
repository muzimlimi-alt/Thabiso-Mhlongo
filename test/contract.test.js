// Integration tests for the new workflow features: contract send + client e-signature (two-party),
// state-aware bulk reminders, and the reconciliation overview. Runs against the isolated test DB.
const { api, pub, one, q, future, sleep } = require('./support');

const SVC = 15;
let seq = 0;
const email = () => `ct.${Date.now()}.${seq++}@example.invalid`;

async function makeBooking(em, days, { accept = false, amount = 1000 } = {}) {
    const id = (await api('POST', '/api/admin/bookings', {
        name: 'CT', email: em, cell: '+27821234567', event_date: future(days),
        event_name: 'CT Event', event_type: 'Corporate', event_location: 'Hall',
        message: 'Contract feature integration test booking.',
        services: [{ service_id: SVC }], status: 'NEW', override_working_hours: true,
    })).body.booking_id;
    await sleep(40);
    const bk = await one('SELECT date FROM bookings WHERE id=?', [id]);
    const expiry = new Date(Date.parse(bk.date) - 10 * 86400000).toISOString().slice(0, 10);
    await api('POST', `/api/admin/bookings/${id}/quote`, {
        quote_expiry_date: expiry, terms: 'T', apply_vat: false, discount: 0,
        items: [{ service_id: SVC, description: 'Travel Buyout – Gauteng', quantity: 1, unit_price: amount }],
    });
    if (accept) await pub('POST', `/api/public/bookings/${id}/accept-quote`, { email: em, terms_agreed: true });
    return id;
}

module.exports = async function ({ check }) {
    // ── Contract: generate → send → client sign → countersign (two-party) ──
    const em = email();
    const id = await makeBooking(em, 200, { accept: true });
    // accept-quote auto-generates a draft contract; ensure one exists.
    await api('POST', `/api/admin/bookings/${id}/contract/generate`, {});
    let c = await one('SELECT status, pdf_url FROM contracts WHERE booking_id=?', [id]);
    check('contract exists as draft with a PDF', c && c.status === 'draft' && !!c.pdf_url, JSON.stringify(c));

    const send = await api('POST', `/api/admin/bookings/${id}/contract/send`, {});
    check('contract send succeeds', send.status === 200 && send.body.success, `${send.status}`);
    c = await one('SELECT status, sent_to_client_at FROM contracts WHERE booking_id=?', [id]);
    check('contract advanced to sent with sent_to_client_at', c.status === 'sent' && !!c.sent_to_client_at, JSON.stringify(c));

    // Countersign must be blocked before the client signs.
    const early = await api('PUT', `/api/admin/bookings/${id}/contract/sign`, { signatory_name: 'Thabiso Mhlongo' });
    check('admin countersign blocked before client signs', early.status === 400 && early.body.requires_client_signature === true, `${early.status}`);

    // Wrong email rejected.
    const wrong = await pub('POST', `/api/public/bookings/${id}/contract/sign`, { email: 'nope@example.invalid', signatory_name: 'X Y', agreed: true });
    check('client sign with wrong email -> 401', wrong.status === 401, `${wrong.status}`);

    // Client signs.
    const sign = await pub('POST', `/api/public/bookings/${id}/contract/sign`, { email: em, signatory_name: 'Jane Client', agreed: true });
    check('client sign succeeds', sign.status === 200 && sign.body.success, `${sign.status} ${sign.body && sign.body.message}`);
    c = await one('SELECT status, signed_by_client_at, client_signature_data, client_ip_address FROM contracts WHERE booking_id=?', [id]);
    check('client signature recorded, status still sent', c.status === 'sent' && !!c.signed_by_client_at, JSON.stringify({ s: c.status, at: c.signed_by_client_at }));
    let sigOk = false; try { const d = JSON.parse(c.client_signature_data); sigOk = d.name === 'Jane Client' && !!d.signed_at && !!d.ip; } catch (e) {}
    check('client_signature_data holds name + timestamp + ip', sigOk, c.client_signature_data);

    // Double sign is idempotent (409).
    const again = await pub('POST', `/api/public/bookings/${id}/contract/sign`, { email: em, signatory_name: 'Jane Client', agreed: true });
    check('re-sign by client -> 409 already signed', again.status === 409, `${again.status}`);

    // Admin countersign now succeeds and freezes.
    const counter = await api('PUT', `/api/admin/bookings/${id}/contract/sign`, { signatory_name: 'Thabiso Mhlongo' });
    check('admin countersign succeeds after client signed', counter.status === 200 && counter.body.success, `${counter.status}`);
    c = await one('SELECT status, is_frozen, signed_by_comedian_at FROM contracts WHERE booking_id=?', [id]);
    check('contract finalised: signed + frozen', c.status === 'signed' && c.is_frozen === 1, JSON.stringify(c));

    // Client sign after finalise is rejected.
    const late = await pub('POST', `/api/public/bookings/${id}/contract/sign`, { email: em, signatory_name: 'Jane Client', agreed: true });
    check('client sign after finalise -> 400', late.status === 400, `${late.status}`);

    // ── State-aware reminders ──
    const qId = await makeBooking(email(), 210, { accept: false }); // stays QUOTED
    const remQuote = await api('POST', `/api/admin/bookings/${qId}/remind`, {});
    check('remind on QUOTED -> quote type', remQuote.body.sent === true && remQuote.body.type === 'quote', JSON.stringify(remQuote.body));

    const balEmail = email();
    const balId = await makeBooking(balEmail, 220, { accept: true });
    await api('PUT', `/api/admin/bookings/${balId}/manual-payment`, { amount_paid: 500 }); // deposit -> CONFIRMED, balance owing
    await sleep(120);
    const remBal = await api('POST', `/api/admin/bookings/${balId}/remind`, {});
    check('remind on CONFIRMED-with-balance -> balance type', remBal.body.sent === true && remBal.body.type === 'balance', JSON.stringify(remBal.body));
    const remBal2 = await api('POST', `/api/admin/bookings/${balId}/remind`, {});
    check('balance reminder is throttled within 24h', remBal2.body.sent === false, JSON.stringify(remBal2.body));

    const paidId = await makeBooking(email(), 230, { accept: true });
    await api('PUT', `/api/admin/bookings/${paidId}/manual-payment`, { amount_paid: 1000, payment_status: 'PAID', force: true });
    await sleep(120);
    const remPaid = await api('POST', `/api/admin/bookings/${paidId}/remind`, {});
    check('remind on fully-paid booking -> skipped', remPaid.body.sent === false, JSON.stringify(remPaid.body));

    // ── Bulk reminder over mixed states ──
    const bulk = await api('POST', '/api/admin/bookings/bulk-remind', { ids: [qId, balId, paidId] });
    check('bulk-remind returns a summary', bulk.status === 200 && typeof bulk.body.sent === 'number', `${bulk.status} ${JSON.stringify(bulk.body).slice(0,80)}`);
    check('bulk-remind counts skips (balId throttled, paidId nothing due)', bulk.body.skipped >= 2, JSON.stringify(bulk.body));

    // ── Reconciliation view (pre-existing /api/admin/reconciliation — the endpoint the UI uses) ──
    const recon = await api('GET', '/api/admin/reconciliation');
    check('reconciliation view returns rows + summary', recon.status === 200 && Array.isArray(recon.body.rows) && !!recon.body.summary, `${recon.status}`);
    const balRow = recon.body.rows.find(x => x.booking_id === balId);
    check('a manually-paid booking appears with its manual total', balRow && parseFloat(balRow.manual_total) >= 500, JSON.stringify(balRow && { manual: balRow.manual_total, eff: balRow.effective_received }));
    check('reconciliation flags source overlap (has_both_sources)', balRow && (balRow.has_both_sources === 0 || balRow.has_both_sources === 1), JSON.stringify({ hbs: balRow && balRow.has_both_sources }));

    // Schedule-mismatch reconciliation (the payment_schedules dimension) — pre-existing endpoint.
    const sched = await api('GET', '/api/admin/payment-schedules/mismatches');
    check('schedule-mismatch reconciliation endpoint responds', sched.status === 200, `${sched.status}`);
};
