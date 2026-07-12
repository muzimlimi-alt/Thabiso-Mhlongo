// Figure-guard for the Prompt-3 payment-critical email rebuild (Batch 3+).
// Asserts, against the ISOLATED test app's notifications queue, that the rebuilt emails
// (a) carry their full pre-wrapped shell exactly once, and (b) render every amount /
// reference string VERBATIM. Styling may change; figures may not.
const { api, pub, one, q, future, sleep } = require('./support');
const emailComponents = require('../js/emailComponents');

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
    // Target rotates as Prompt 4 batches migrate more SYSTEM emails; currently the two security
    // emails (dashboard invite, password reset) are the last un-migrated ones (Batch 5).
    await pub('POST', '/api/admin/forgot-password', { email: 'test.runner@example.invalid' });
    await sleep(150);
    const adminMail = await queued('Password Reset Request%');
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

    // ── Guard 7 (Batch 6): newsletter welcome — real unsubscribe link, per-recipient token ──
    const subEmail = email();
    const subRes = await pub('POST', '/api/public/subscribe', { email: subEmail, popia_consent: true });
    check('newsletter subscribe endpoint 200', subRes.status === 200 && subRes.body.success, `${subRes.status}`);
    await sleep(150);
    const sub = await one('SELECT unsubscribe_token FROM newsletter_subscribers WHERE LOWER(email)=LOWER(?)', [subEmail]);
    check('subscriber row has an unsubscribe_token', !!(sub && sub.unsubscribe_token), JSON.stringify(sub));
    const welcomeMail = await queued("Welcome to Thabiso Mhlongo's Newsletter!");
    check('welcome email queued pre-wrapped to the new subscriber', !!welcomeMail && welcomeMail.preWrapped === true && welcomeMail.to === subEmail,
        welcomeMail && `${welcomeMail.preWrapped} ${welcomeMail.to}`);
    if (welcomeMail && sub) {
        check('welcome email: real unsubscribe link with this subscriber\'s token', welcomeMail.html.includes(sub.unsubscribe_token) && welcomeMail.html.includes('unsubscribe.html'),
            `hasToken=${welcomeMail.html.includes(sub.unsubscribe_token)} hasPath=${welcomeMail.html.includes('unsubscribe.html')}`);
    }

    // ── Guard 8 (Batch 3): SYSTEM digests render as tables, figures verbatim ──
    // Digests are cron-only (no admin-triggerable endpoint), so this renders through the exact
    // renderSystemEmail/infoCard row-shape used in server.js's digest rebuilds directly, proving
    // the real component pipeline turns digest rows into a table (not a <br>-joined list) and
    // keeps each item's exact figure string.
    const digestRows = [
        { id: 100050, name: 'Priya Naidoo', outstanding: 3250.5 },
        { id: 100051, name: 'Sipho Zulu', outstanding: 1899.99 }
    ];
    const digestHtml = emailComponents.renderSystemEmail({
        preheaderText: `${digestRows.length} overdue booking(s).`,
        category: 'Payments & Invoices',
        severity: 'alert',
        leadFact: 'The following confirmed bookings have unpaid balances with past event dates.',
        cards: [{
            title: 'Overdue Bookings',
            rows: digestRows.map(r => ({ label: `#${r.id} — ${r.name}`, value: `R${r.outstanding.toFixed(2)} outstanding`, mono: false }))
        }]
    });
    check('digest renders a real table (not a <br>-joined list)',
        /<table[^>]*role="presentation"/.test(digestHtml) && !digestHtml.includes('<br>'),
        `hasTable=${/<table/.test(digestHtml)} hasBr=${digestHtml.includes('<br>')}`);
    check('digest: every row figure renders verbatim',
        digestHtml.includes('R3250.50 outstanding') && digestHtml.includes('R1899.99 outstanding'),
        `r1=${digestHtml.includes('R3250.50 outstanding')} r2=${digestHtml.includes('R1899.99 outstanding')}`);
    check('digest: single shell, dark color-scheme meta', count(digestHtml, '<!DOCTYPE') === 1 && /name="color-scheme" content="dark"/.test(digestHtml),
        `doctypes=${count(digestHtml, '<!DOCTYPE')}`);

    // ── Guard 9 (Batch 4): PayFast ITN alerts — figures verbatim, severity alert, single shell ──
    // Each of the 4 failure paths (missing-total, ITN-failed, overpayment, balance-failed) requires
    // forcing a rare condition (a genuine DB error, a specific race) that isn't safely reproducible
    // as a black-box HTTP test without mocking the DB layer. As with the cron digests (Guard 8), this
    // renders through the exact renderSystemEmail call-shape used in each server.js rebuild and
    // proves the PayFast-critical figures/booking-IDs/error text render verbatim with no red-on-black.
    const itnCases = [
        {
            name: 'missing-total',
            html: emailComponents.renderSystemEmail({
                preheaderText: 'PayFast ITN for booking #100099 rejected — no total_amount set.',
                category: 'Payments & Invoices', severity: 'alert',
                leadFact: 'A PayFast ITN for booking <strong style="color:#FAFAFA;">#100099</strong> (R750.00) was <strong style="color:#E8A83E;">rejected</strong> because the booking has no total_amount set.',
                bodyHtml: '<p style="margin:0; color:#E6E6E6;">Set the booking total and replay the transaction manually.</p>'
            }),
            mustInclude: ['#100099', 'R750.00']
        },
        {
            name: 'itn-failed',
            html: emailComponents.renderSystemEmail({
                preheaderText: 'PayFast payment for booking #100099 could not be recorded.',
                category: 'Payments & Invoices', severity: 'alert',
                leadFact: 'A verified PayFast payment for booking <strong style="color:#FAFAFA;">#100099</strong> (R750.00) could not be recorded: SQLITE_BUSY: database is locked.',
                bodyHtml: '<p style="margin:0; color:#E6E6E6;">The booking ledger is unchanged. Replay manually.</p>'
            }),
            mustInclude: ['#100099', 'R750.00', 'SQLITE_BUSY: database is locked']
        },
        {
            name: 'overpayment',
            html: emailComponents.renderSystemEmail({
                preheaderText: 'Overpayment detected for booking #100099 — credit NOT applied.',
                category: 'Payments & Invoices', severity: 'alert',
                leadFact: 'PayFast sent <strong style="color:#FAFAFA;">R1200.00</strong> for booking <strong style="color:#FAFAFA;">#100099</strong> but crediting it would exceed the R750.00 booking total.',
                bodyHtml: '<p style="margin:0; color:#E6E6E6;">Credit was <strong style="color:#E8A83E;">NOT applied</strong>. Manual review required.</p>'
            }),
            mustInclude: ['R1200.00', 'R750.00', '#100099']
        },
        {
            name: 'balance-payment-failed',
            html: emailComponents.renderSystemEmail({
                preheaderText: 'Balance payment failed for booking #100099 — deposit remains on record.',
                category: 'Payments & Invoices', severity: 'alert',
                leadFact: 'A balance payment attempt by <strong style="color:#FAFAFA;">Priya Naidoo</strong> for Booking <strong style="color:#FAFAFA;">#100099</strong> has failed.',
                bodyHtml: '<p style="margin:0; color:#E6E6E6;">The booking still has a deposit on record. Payment status remains <strong style="color:#D4AF37;">DEPOSIT_PAID</strong>. Please follow up with the client.</p>',
                cards: [{ rows: [{ label: 'PayFast Status', value: 'FAILED', highlight: true }] }]
            }),
            mustInclude: ['Priya Naidoo', '#100099', 'FAILED']
        }
    ];
    for (const c of itnCases) {
        check(`PayFast alert (${c.name}): figures/IDs verbatim`, c.mustInclude.every(s => c.html.includes(s)),
            c.mustInclude.filter(s => !c.html.includes(s)).join(', ') || 'all present');
        check(`PayFast alert (${c.name}): single shell + amber alert (no red)`,
            count(c.html, '<!DOCTYPE') === 1 && c.html.includes('#E8A83E') && !/#ef4444|#ff0000|color:\s*red/i.test(c.html),
            `doctypes=${count(c.html, '<!DOCTYPE')} hasAmber=${c.html.includes('#E8A83E')}`);
    }
};
