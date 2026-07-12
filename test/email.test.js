// Figure-guard for the Prompt-3 payment-critical email rebuild (Batch 3+).
// Asserts, against the ISOLATED test app's notifications queue, that the rebuilt emails
// (a) carry their full pre-wrapped shell exactly once, and (b) render every amount /
// reference string VERBATIM. Styling may change; figures may not.
const { api, pub, one, q, future, sleep } = require('./support');

const SVC = 15;
const email = () => `eg.${Date.now()}.${Math.floor(Math.random() * 1e4)}@example.invalid`;

// Latest queued email whose subject matches (the queue keeps every send).
async function queued(subjectLike) {
    const row = await one(
        "SELECT subject, recipient_email, body FROM notifications WHERE type='email' AND subject LIKE ? ORDER BY id DESC LIMIT 1",
        [subjectLike]
    );
    if (!row) return null;
    let details = {};
    try { details = JSON.parse(row.body || '{}'); } catch (e) {}
    return { subject: row.subject, to: row.recipient_email, html: details.htmlContent || '', preWrapped: !!details.preWrapped };
}
const count = (hay, needle) => (hay || '').split(needle).length - 1;

module.exports = async function ({ check }) {
    // ── Fixture: R1000 booking, accepted (auto-invoice + 50/50 schedule) ──
    const em = email();
    const id = (await api('POST', '/api/admin/bookings', {
        name: 'EG', email: em, cell: '+27821234567', event_date: future(240),
        event_name: 'EG Event', event_type: 'Corporate', event_location: 'Hall',
        message: 'Email figure-guard integration test booking.',
        services: [{ service_id: SVC }], status: 'NEW', override_working_hours: true,
    })).body.booking_id;
    await sleep(40);
    const bk = await one('SELECT date FROM bookings WHERE id=?', [id]);
    const expiry = new Date(Date.parse(bk.date) - 10 * 86400000).toISOString().slice(0, 10);
    await api('POST', `/api/admin/bookings/${id}/quote`, {
        quote_expiry_date: expiry, terms: 'T', apply_vat: false, discount: 0,
        items: [{ service_id: SVC, description: 'Travel Buyout – Gauteng', quantity: 1, unit_price: 1000 }],
    });
    await pub('POST', `/api/public/bookings/${id}/accept-quote`, { email: em, terms_agreed: true });
    await sleep(150);

    // ── Guard 1: acceptance email ('Invoice Issued') — schedule figures verbatim ──
    const acc = await queued(`Invoice Issued – Booking #${id}`);
    check('acceptance email queued pre-wrapped', !!acc && acc.preWrapped === true && acc.to === em, acc && `${acc.preWrapped} ${acc.to}`);
    if (acc) {
        check('acceptance shell: exactly one <!DOCTYPE + dark color-scheme meta',
            count(acc.html, '<!DOCTYPE') === 1 && /name="color-scheme" content="dark"/.test(acc.html),
            `doctypes=${count(acc.html, '<!DOCTYPE')}`);
        check('acceptance schedule figures verbatim (2× R 500.00)', count(acc.html, 'R 500.00') >= 2, `found=${count(acc.html, 'R 500.00')}`);
    }

    // ── Guard 2: invoice email via POST /api/admin/invoices/:id/send ──
    const inv = await one('SELECT id, invoice_number FROM invoices WHERE booking_id=? ORDER BY id DESC LIMIT 1', [id]);
    check('fixture invoice exists', !!inv, JSON.stringify(inv));
    if (inv) {
        const sendRes = await api('POST', `/api/admin/invoices/${inv.id}/send`, {});
        check('invoice send endpoint 200', sendRes.status === 200, `${sendRes.status}`);
        await sleep(150);
        const invMail = await queued(`Invoice for Booking #${id}`);
        check('invoice email queued pre-wrapped to client', !!invMail && invMail.preWrapped === true && invMail.to === em, invMail && `${invMail.preWrapped} ${invMail.to}`);
        if (invMail) {
            check('invoice email: schedule amount + reference verbatim',
                count(invMail.html, 'R 500.00') >= 2 && invMail.html.includes(`#${id}`), `R500s=${count(invMail.html, 'R 500.00')}`);
            check('invoice email: bulletproof VML button present', /v:roundrect/.test(invMail.html), 'no VML');
            check('invoice email: single shell (no double-wrap)', count(invMail.html, '<!DOCTYPE') === 1, `doctypes=${count(invMail.html, '<!DOCTYPE')}`);
        }
    }

    // ── Guard 3: partial payment (R400 of R1000) — exact no-space figure strings ──
    await api('PUT', `/api/admin/bookings/${id}/manual-payment`, { amount_paid: 400 });
    await sleep(150);
    const pay = await queued(`Partial Payment Received – Booking #${id}`);
    check('partial-payment email queued pre-wrapped', !!pay && pay.preWrapped === true, pay && `${pay.preWrapped}`);
    if (pay) {
        check('payment figures verbatim (R1000.00 / R400.00 / R600.00, no space)',
            pay.html.includes('R1000.00') && pay.html.includes('R400.00') && pay.html.includes('R600.00'),
            `1000=${pay.html.includes('R1000.00')} 400=${pay.html.includes('R400.00')} 600=${pay.html.includes('R600.00')}`);
    }

    // ── Guard 4: isolation — un-migrated (SYSTEM) emails are NOT pre-wrapped ──
    const adminMail = await queued('NEW BOOKING REQUEST:%');
    check('un-migrated admin email stays legacy (no preWrapped, no full shell)',
        !!adminMail && adminMail.preWrapped === false && count(adminMail.html, '<!DOCTYPE') === 0,
        adminMail && `pre=${adminMail.preWrapped} doctypes=${count(adminMail.html, '<!DOCTYPE')}`);

    // ── Fixture 2: separate R1000 booking, for the DEPOSIT_PAID and refund guards ──
    const em2 = email();
    const id2 = (await api('POST', '/api/admin/bookings', {
        name: 'EG2', email: em2, cell: '+27821234567', event_date: future(241),
        event_name: 'EG2 Event', event_type: 'Corporate', event_location: 'Hall',
        message: 'Email figure-guard integration test booking, deposit path.',
        services: [{ service_id: SVC }], status: 'NEW', override_working_hours: true,
    })).body.booking_id;
    await sleep(40);
    const bk2 = await one('SELECT date FROM bookings WHERE id=?', [id2]);
    const expiry2 = new Date(Date.parse(bk2.date) - 10 * 86400000).toISOString().slice(0, 10);
    await api('POST', `/api/admin/bookings/${id2}/quote`, {
        quote_expiry_date: expiry2, terms: 'T', apply_vat: false, discount: 0,
        items: [{ service_id: SVC, description: 'Travel Buyout – Gauteng', quantity: 1, unit_price: 1000 }],
    });
    await pub('POST', `/api/public/bookings/${id2}/accept-quote`, { email: em2, terms_agreed: true });
    await sleep(150);

    // ── Guard 5: exact 50% deposit -> DEPOSIT_PAID -> sendDepositBalanceDueEmail, R500.00 verbatim ──
    await api('PUT', `/api/admin/bookings/${id2}/manual-payment`, { amount_paid: 500 });
    await sleep(150);
    const deposit = await queued(`Deposit Received – Balance Due R500.00 | Booking #${id2}`);
    check('deposit-balance-due email queued pre-wrapped with exact-figure subject',
        !!deposit && deposit.preWrapped === true && deposit.to === em2,
        deposit && `${deposit.preWrapped} ${deposit.to}`);
    if (deposit) {
        check('deposit-balance-due: R500.00 outstanding verbatim in body', deposit.html.includes('R500.00'), 'not found');
        check('deposit-balance-due: single shell', count(deposit.html, '<!DOCTYPE') === 1, `doctypes=${count(deposit.html, '<!DOCTYPE')}`);
    }

    // ── Guard 6: cancellation + refund — refund figure + reference verbatim ──
    const cancelRes = await api('POST', `/api/admin/bookings/${id2}/cancel`, { reason: 'Test cancellation', cancelled_by: 'force_majeure' });
    check('cancel endpoint 200 (force majeure -> full refund due)', cancelRes.status === 200, `${cancelRes.status}`);
    await sleep(150);
    const cancelMail = await queued(`Booking Cancelled – Reference #${id2}`);
    check('cancellation email queued pre-wrapped, refund figure verbatim (R 500.00)',
        !!cancelMail && cancelMail.preWrapped === true && cancelMail.html.includes('R 500.00'),
        cancelMail && `pre=${cancelMail.preWrapped} has500=${cancelMail.html.includes('R 500.00')}`);

    const refundRes = await api('PUT', `/api/admin/bookings/${id2}/refund`, { refund_amount: 500, refund_reference: 'TESTREF-9001' });
    check('refund endpoint 200', refundRes.status === 200, `${refundRes.status} ${JSON.stringify(refundRes.body).slice(0,120)}`);
    await sleep(150);
    const refundMail = await queued(`Refund Processed – Booking #${id2}`);
    check('refund email queued pre-wrapped', !!refundMail && refundMail.preWrapped === true && refundMail.to === em2,
        refundMail && `${refundMail.preWrapped} ${refundMail.to}`);
    if (refundMail) {
        check('refund email: amount "R 500.00" and reference "TESTREF-9001" verbatim',
            refundMail.html.includes('R 500.00') && refundMail.html.includes('TESTREF-9001'),
            `amt=${refundMail.html.includes('R 500.00')} ref=${refundMail.html.includes('TESTREF-9001')}`);
        check('refund email: single shell (no double-wrap)', count(refundMail.html, '<!DOCTYPE') === 1, `doctypes=${count(refundMail.html, '<!DOCTYPE')}`);
    }
};
