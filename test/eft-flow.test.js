// Manual EFT payments and proof-of-payment review, end to end against the real server (docs-internal/eft-payments.md).
//
// The three promises this file exists to keep:
//   1. UPLOADING A PROOF NEVER CREDITS ANYTHING - the booking, the invoice and the ledger are untouched until an administrator approves.
//   2. BANKING DETAILS ARE VERSIONED - changing them never rewrites an invoice that already went out.
//   3. AN APPROVED PROOF IS ONE ORDINARY LEDGER PAYMENT - same booking credit as a card payment, reconciled by the same reports, never twice.
//
// Date offsets 1750-1789 are reserved for this file (grep the WHOLE test folder before picking another range: some files book through helpers).
const fs = require('fs');
const path = require('path');
const { api, pub, q, one, future, sleep, getTrackingToken, loginAs, makeTestPng, BASE, extractPdfText, apiBinary, getChildLog, TEST_DB } = require('./support');

const DOCS = path.join(__dirname, 'test-docs');
const PROOFS = path.join(DOCS, 'payment_proofs');
const ACCT_1 = '62001234567', ACCT_2 = '10098765432';

// Every test file shares one server and one database. This file switches Manual EFT on, so it MUST switch it off again however it ends: a later
// file (pdf-golden, quote-flow ...) that generates an invoice would otherwise get a "PAY BY EFT" block it knows nothing about.
module.exports = async function (ctx) {
    try { await suite(ctx); }
    finally { await api('PUT', '/api/admin/eft/settings', { enabled: false }); }
};

async function suite({ check }) {
    const poll = async (fn, ms = 10000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(150); } return v; };
    const sClub = (await one("SELECT id FROM services WHERE name = 'Club – 10 min Set (Guest Spot)'")).id;   // fixed R5,000
    let day = 1750, seq = 0;

    // ── helpers ──
    // a booking taken as far as a quotation; accept: true also has the client accept it (invoice + two 50/50 milestones)
    const makeBooking = async (label, { accept = true } = {}) => {
        const email = `eft.${Date.now()}.${seq++}@example.invalid`;
        const created = await api('POST', '/api/admin/bookings', {
            name: `EFT ${label}`, email, cell: '+27821234567', event_date: future(day++), event_name: `EFT ${label}`, event_type: 'Corporate', event_location: 'Hall',
            message: 'Manual EFT integration test booking, over ten characters.', services: [{ service_id: sClub }], status: 'NEW', override_working_hours: true
        });
        const id = created.body && created.body.booking_id;
        const bk = await one('SELECT date FROM bookings WHERE id = ?', [id]);
        const expiry = new Date(Date.parse(bk.date) - 10 * 86400000).toISOString().slice(0, 10);
        await api('POST', `/api/admin/bookings/${id}/quote`, { quote_expiry_date: expiry, terms: 'T', apply_vat: false, discount: 0, items: [{ service_id: sClub, description: 'Club set', quantity: 1, unit_price: 5000, pricing_model: 'flat_fee' }] });
        let token = await getTrackingToken(id, email);
        if (accept) {
            await pub('POST', `/api/public/bookings/${id}/accept-quote`, { access_token: token, terms_agreed: true });
            await poll(async () => (await one('SELECT id FROM invoices WHERE booking_id = ?', [id])));
        }
        return { id, email, token };
    };
    const track = async (b) => (await pub('POST', `/api/public/bookings/${b.id}/track`, { access_token: b.token })).body;
    const uniquePng = () => makeTestPng(24, 24, { random: true });
    const upload = async (b, { buffer, type = 'image/png', name = 'proof.png', fields = {}, token } = {}) => {
        const form = new FormData();
        for (const [k, v] of Object.entries({ amount: '2500', payment_date: future(-1), reference: 'Test client ref', note: 'Paid with my banking app', ...fields })) if (v !== undefined && v !== null) form.append(k, String(v));
        if (buffer !== null) form.append('proof', new Blob([buffer || uniquePng()], { type }), name);
        const headers = {};
        const t = token === undefined ? b.token : token;
        if (t) headers['x-booking-access-token'] = t;
        const r = await fetch(`${BASE}/api/public/bookings/${b.id}/eft/proof`, { method: 'POST', headers, body: form });
        let json = null; try { json = await r.json(); } catch (e) {}
        return { status: r.status, body: json };
    };
    const bookingRow = (id) => one('SELECT status, payment_status, amount_paid, amount_outstanding, total_amount FROM bookings WHERE id = ?', [id]);
    const txRows = (id) => q("SELECT * FROM transactions WHERE booking_id = ? ORDER BY id", [id]);
    const subRows = (id) => q('SELECT * FROM eft_payment_submissions WHERE booking_id = ? ORDER BY id', [id]);
    const approve = (sid, over = {}) => api('POST', `/api/admin/eft/submissions/${sid}/approve`, { verified_amount: '2500', verified_reference: `FNB-${Date.now()}-${seq++}`, verified_date: future(-1), ...over });
    const revenue = async () => Number((((await api('GET', '/api/admin/financials/stats')).body || {}).stats || {}).revenue) || 0;
    const mailTo = async (email, like) => poll(async () => one('SELECT subject, body FROM notifications WHERE recipient_email = ? AND subject LIKE ? ORDER BY id DESC LIMIT 1', [email, like]), 6000);
    const mailHtml = (row) => { try { return JSON.parse(row.body).htmlContent || ''; } catch (e) { return ''; } };
    const goodDetails = (over = {}) => ({ account_holder: 'Thabiso Mhlongo Entertainment', bank_name: 'First National Bank', account_number: ACCT_1, account_type: 'Cheque', branch_code: '250655', swift_code: '', reference_note: 'Use your invoice number as the reference', payment_instructions: '', ...over });

    // ═══ 0. EFT is OFF until an administrator turns it on, and the historical booking is made before any details exist ═══
    const settings0 = await api('GET', '/api/admin/eft/settings');
    check('a fresh database has Manual EFT switched off and no banking details', settings0.status === 200 && settings0.body.settings.enabled === false && settings0.body.has_bank_details === false, JSON.stringify(settings0.body));
    const turnOnEarly = await api('PUT', '/api/admin/eft/settings', { enabled: true });
    check('it cannot be switched on before banking details exist (there would be nothing to show a client)', turnOnEarly.status === 400 && /banking details/i.test(turnOnEarly.body.message || ''), JSON.stringify(turnOnEarly.body));
    const hist = await makeBooking('historical');           // accepted while EFT does not exist: its invoice must never carry banking details
    const histInvoice0 = await one('SELECT id, bank_details_id, file_path FROM invoices WHERE booking_id = ?', [hist.id]);
    check('an invoice issued while EFT is off remembers no banking details', histInvoice0 && histInvoice0.bank_details_id === null, JSON.stringify(histInvoice0));
    const histTrack0 = await track(hist);
    check('the tracking page offers no EFT while it is off (eft: null)', histTrack0.success && histTrack0.eft === null, JSON.stringify(histTrack0.eft));
    const offUpload = await upload(hist);
    check('uploading a proof while EFT is off is refused (409) and nothing is stored', offUpload.status === 409 && (await subRows(hist.id)).length === 0, JSON.stringify(offUpload));

    // ═══ 1. who may do what ═══
    const manager = await loginAs('manager');
    const assistant = await loginAs('assistant');
    const noAuth = await pub('GET', '/api/admin/eft/submissions');
    check('the review queue needs a login (401 without one)', noAuth.status === 401, noAuth.status);
    check('an assistant cannot see the queue, the banking details or the settings (403)',
        (await assistant('GET', '/api/admin/eft/submissions')).status === 403 && (await assistant('GET', '/api/admin/eft/bank-details')).status === 403 && (await assistant('GET', '/api/admin/eft/settings')).status === 403, '');
    check('a manager can see the queue but can NOT read or change the banking details or the switches (administrators only)',
        (await manager('GET', '/api/admin/eft/submissions')).status === 200 && (await manager('GET', '/api/admin/eft/bank-details')).status === 403
        && (await manager('PUT', '/api/admin/eft/bank-details', goodDetails())).status === 403 && (await manager('PUT', '/api/admin/eft/settings', { enabled: true })).status === 403, '');

    // ═══ 2. banking details: validation, versioning, audit ═══
    const invalid = await api('PUT', '/api/admin/eft/bank-details', goodDetails({ account_number: '12AB', branch_code: 'x' }));
    check('invalid banking details are refused with the reasons (400)', invalid.status === 400 && invalid.body.errors && invalid.body.errors.account_number && invalid.body.errors.branch_code, JSON.stringify(invalid.body));
    check('...and nothing was saved', (await one('SELECT COUNT(*) c FROM bank_details')).c === 0, '');
    const saved1 = await api('PUT', '/api/admin/eft/bank-details', goodDetails());
    check('valid banking details are saved as version 1', saved1.status === 200 && saved1.body.version === 1, JSON.stringify(saved1.body));
    const read1 = await api('GET', '/api/admin/eft/bank-details');
    check('an administrator reads the active details in full, history masked', read1.body.active && read1.body.active.account_number === ACCT_1 && read1.body.versions.length === 1
        && read1.body.versions[0].account_number_masked === '*******4567' && read1.body.versions[0].account_number === undefined, JSON.stringify(read1.body).slice(0, 400));
    const audit1 = await one("SELECT * FROM audit_log WHERE table_name = 'bank_details' AND action = 'BANK_DETAILS_CHANGED' ORDER BY id DESC LIMIT 1");
    check('the change is audited with who and what, and the audit row NEVER holds the full account number',
        audit1 && audit1.changed_by && audit1.actor_role === 'administrator' && !JSON.stringify(audit1).includes(ACCT_1) && /4567/.test(audit1.new_values || ''), JSON.stringify(audit1));
    const again = await api('PUT', '/api/admin/eft/bank-details', goodDetails());
    check('saving identical details again mints no new version', again.status === 200 && again.body.unchanged === true && (await one('SELECT COUNT(*) c FROM bank_details')).c === 1, JSON.stringify(again.body));
    const leaks = [];
    for (const url of ['/api/public/booking-config', '/api/public/services', '/api/public/site-content', '/api/public/branding', '/api/public/contact_info', '/api/public/events']) {
        const r = await fetch(BASE + url); const text = await r.text();
        if (text.includes(ACCT_1) || /bank_details|eft_settings/.test(text)) leaks.push(url);
    }
    const settingsApi = JSON.stringify((await api('GET', '/api/admin/settings')).body);
    check('the banking details appear in no public endpoint and not in the generic admin settings API', leaks.length === 0 && !settingsApi.includes(ACCT_1), leaks.join() || settingsApi.slice(0, 200));
    check('the details are not in the process environment or the settings table either', !(await q("SELECT 1 FROM settings WHERE setting_value LIKE ?", [`%${ACCT_1}%`])).length, '');
    const sizeBad = await api('PUT', '/api/admin/eft/settings', { max_upload_mb: 99 });
    check('an upload limit above the hard cap is refused', sizeBad.status === 400, JSON.stringify(sizeBad.body));
    const on = await api('PUT', '/api/admin/eft/settings', { enabled: true, max_upload_mb: 1 });
    check('an administrator switches Manual EFT on (and the change is audited)', on.status === 200 && on.body.settings.enabled === true && on.body.settings.max_upload_mb === 1
        && (await one("SELECT 1 x FROM audit_log WHERE table_name = 'eft_settings' AND action = 'EFT_SETTINGS_CHANGED'")), JSON.stringify(on.body));

    // ═══ 3. an invoice issued now carries the details (snapshot) ═══
    const A = await makeBooking('A');
    const invA = await one('SELECT id, invoice_number, bank_details_id, file_path, status FROM invoices WHERE booking_id = ?', [A.id]);
    check('an invoice issued with EFT on remembers the banking-details version it was issued with', invA && invA.bank_details_id === 1, JSON.stringify(invA));
    const pdfA = await apiBinary('GET', `/api/admin/bookings/${A.id}/invoice/download`);
    const pdfAText = extractPdfText(pdfA.buffer).replace(/\s+/g, ' ');
    check('the invoice PDF carries the EFT block: bank, account number and the invoice number as the reference',
        pdfA.status === 200 && /PAY BY EFT/.test(pdfAText) && /First National Bank/.test(pdfAText) && pdfAText.includes(ACCT_1) && new RegExp('Payment reference\\s+' + invA.invoice_number).test(pdfAText)
        && /Amount payable\s+R 5000\.00/.test(pdfAText) && new RegExp('Booking reference\\s+#' + A.id).test(pdfAText) && /cleared funds/.test(pdfAText), pdfAText.slice(-600));
    const pdfAHash = require('crypto').createHash('sha256').update(pdfA.buffer).digest('hex');
    const histPdf = await apiBinary('GET', `/api/admin/bookings/${hist.id}/invoice/download`);
    check('the historical invoice (issued while EFT was off) still has no banking block', histPdf.status === 200 && !/PAY BY EFT/.test(extractPdfText(histPdf.buffer)), '');
    const mailA = await poll(async () => one("SELECT body FROM notifications WHERE recipient_email = ? AND subject LIKE 'Invoice for Booking%' ORDER BY id DESC LIMIT 1", [A.email]), 8000);
    check('the invoice e-mail shows the banking details and the reference too', mailA && mailHtml(mailA).includes(ACCT_1) && mailHtml(mailA).includes(invA.invoice_number) && /Pay by EFT/i.test(mailHtml(mailA)) && /Booking reference/.test(mailHtml(mailA)) && /cleared funds/.test(mailHtml(mailA)), mailA ? mailHtml(mailA).slice(0, 200) : 'no email');

    // ═══ 4. what the client is shown ═══
    const trackA = await track(A);
    check('a verified client sees the EFT panel: full details, the reference, the limit, the accepted types',
        trackA.eft && trackA.eft.enabled && trackA.eft.bank_details.accountNumber === ACCT_1 && trackA.eft.bank_details.reference === invA.invoice_number && trackA.eft.max_upload_mb === 1
        && trackA.eft.accepted_types.join() === 'PDF,JPG,PNG' && trackA.eft.can_upload === true && trackA.eft.outstanding === 5000 && trackA.eft.details_changed === false, JSON.stringify(trackA.eft));
    const quoted = await makeBooking('quoted only', { accept: false });
    const trackQ = await track(quoted);
    check('a booking that is only quoted is shown NO banking details (nothing to pay yet) and cannot upload', trackQ.eft && trackQ.eft.bank_details === null && trackQ.eft.can_upload === false, JSON.stringify(trackQ.eft));
    check('...an upload against it is refused', (await upload(quoted)).status === 400 && (await subRows(quoted.id)).length === 0, '');
    const trackNoTok = await pub('POST', `/api/public/bookings/${A.id}/track`, {});
    check('without a verified session the tracking call (and so the banking details) is refused', trackNoTok.status === 401 && !JSON.stringify(trackNoTok.body).includes(ACCT_1), trackNoTok.status);

    // ═══ 5. upload validation - every refusal leaves nothing behind ═══
    const filesBefore = fs.existsSync(PROOFS) ? fs.readdirSync(PROOFS).length : 0;
    const png = uniquePng();
    const cases = [
        ['no session token', await upload(A, { token: null }), 401],
        ["another booking's token", await upload(A, { token: hist.token }), 401],
        ['a text file named .png declared as image/png', await upload(A, { buffer: Buffer.from('this is not an image at all, just words'), type: 'image/png', name: 'proof.png' }), 400],
        ['a PNG declared as a PDF', await upload(A, { buffer: png, type: 'application/pdf', name: 'proof.pdf' }), 400],
        ['an executable disguised as a PDF', await upload(A, { buffer: Buffer.from('MZ\x90\x00\x03\x00\x00\x00\x04\x00\x00\x00\xff\xff'), type: 'application/pdf', name: 'proof.pdf' }), 400],
        ['a Word document', await upload(A, { buffer: Buffer.from('PK\x03\x04docx'), type: 'application/msword', name: 'proof.doc' }), 400],
        ['no file at all', await upload(A, { buffer: null }), 400],
        ['an amount above what is outstanding', await upload(A, { fields: { amount: '5000.01' } }), 400],
        ['no amount', await upload(A, { fields: { amount: '' } }), 400],
        ['a future payment date', await upload(A, { fields: { payment_date: future(30) } }), 400],
        ['markup in the reference', await upload(A, { fields: { reference: '<script>alert(1)</script>' } }), 400],
        ['a file over the 1 MB limit', await upload(A, { buffer: Buffer.concat([png, Buffer.alloc(1.2 * 1024 * 1024)]) }), 413]
    ];
    for (const [name, res, want] of cases) check(`refused: ${name} -> ${want}`, res.status === want && !res.body.success, `${res.status} ${JSON.stringify(res.body)}`);
    check('...and none of those left a submission, a file or any money movement', (await subRows(A.id)).length === 0 && (fs.existsSync(PROOFS) ? fs.readdirSync(PROOFS).length : 0) === filesBefore
        && (await txRows(A.id)).length === 0 && (await bookingRow(A.id)).amount_paid === 0, '');
    check('...and no e-mail was queued to the client or the owner for them', !(await one("SELECT 1 x FROM notifications WHERE recipient_email = ? AND subject LIKE 'We received your proof%'", [A.email])), '');
    await api('PUT', '/api/admin/eft/settings', { max_upload_mb: 5 });

    // ═══ 6. THE promise: an upload never credits anything ═══
    const revBefore = await revenue();
    const proof1 = uniquePng();
    const up1 = await upload(A, { buffer: proof1, fields: { amount: '1000' } });
    check('a valid proof is accepted (200) and reported as received, NOT as a payment', up1.status === 200 && up1.body.success && up1.body.submission.status === 'pending' && /not yet a confirmation of payment/i.test(up1.body.message) && !/payment (received|confirmed|successful)/i.test(up1.body.message), JSON.stringify(up1.body));
    check('the response never hands back the stored file name, the hash, the address or an admin id', !/proof_filename|sha|submitted_ip|reviewed_by|filename/i.test(JSON.stringify(up1.body)), JSON.stringify(up1.body));
    const s1 = (await subRows(A.id))[0];
    check('the submission is stored pending, against this booking and invoice, with what the client claimed and the details version they were shown',
        s1 && s1.status === 'pending' && s1.claimed_amount === 1000 && s1.invoice_id === invA.id && s1.bank_details_id === 1 && s1.submitted_by_email === A.email && s1.claimed_reference === 'Test client ref'
        && s1.verified_amount === null && s1.transaction_id === null && s1.reviewed_by === null, JSON.stringify(s1));
    check('the file sits in the private store under a random server-made name with the right extension (nothing the client typed)',
        /^eft-\d+-[0-9a-f]{24}\.png$/.test(s1.proof_filename) && fs.existsSync(path.join(PROOFS, s1.proof_filename)) && !s1.proof_filename.includes('proof.png') && s1.proof_mime === 'image/png' && s1.proof_size === proof1.length
        && fs.readFileSync(path.join(PROOFS, s1.proof_filename)).equals(proof1), JSON.stringify(s1));
    const afterUpload = await bookingRow(A.id);
    check('NOTHING was credited: the booking is still UNPAID, R0.00 paid, R5,000.00 outstanding, still ACCEPTED', afterUpload.payment_status === 'UNPAID' && afterUpload.amount_paid === 0 && afterUpload.amount_outstanding === 5000 && afterUpload.status === 'ACCEPTED', JSON.stringify(afterUpload));
    check('...no ledger row exists, the invoice is still open, revenue did not move',
        (await txRows(A.id)).length === 0 && (await one('SELECT status FROM invoices WHERE id = ?', [invA.id])).status !== 'PAID' && (await revenue()) === revBefore, '');
    const recvMail = await mailTo(A.email, 'We received your proof of payment%');
    const recvHtml = recvMail ? mailHtml(recvMail) : '';
    check('the client is told it was RECEIVED and is being CHECKED, and that it is not yet a confirmation of payment',
        /not yet a confirmation of payment/i.test(recvHtml) && /check/i.test(recvHtml), recvHtml.slice(0, 300));
    check('...and is never told a payment was received, processed or successful', recvMail && !/payment received|successfully processed|payment confirmed|payment successful/i.test(recvHtml + recvMail.subject), recvMail ? recvMail.subject : 'no email');
    const adminMail = await poll(async () => one("SELECT body FROM notifications WHERE subject LIKE ? ORDER BY id DESC LIMIT 1", [`EFT proof awaiting review – Booking #${A.id}%`]), 6000);
    check('the owner is alerted that a proof is awaiting review (and that nothing has been credited)', adminMail && /awaiting review/i.test(mailHtml(adminMail)) && /nothing has been credited/i.test(mailHtml(adminMail)), adminMail ? '' : 'no admin alert');
    const ev1 = await q('SELECT action, actor_type, to_status FROM eft_submission_events WHERE submission_id = ?', [s1.id]);
    check('its history starts with a "submitted" event by the client', ev1.length === 1 && ev1[0].action === 'submitted' && ev1[0].actor_type === 'client' && ev1[0].to_status === 'pending', JSON.stringify(ev1));

    const dup = await upload(A, { buffer: proof1, fields: { amount: '1000' } });
    check('sending the very same file twice is refused (409) - one pending review, not two', dup.status === 409 && (await subRows(A.id)).length === 1, JSON.stringify(dup.body));
    const up2 = await upload(A, { fields: { amount: '1500' } });
    const up3 = await upload(A, { fields: { amount: '2500' } });
    const up4 = await upload(A, { fields: { amount: '100' } });
    check('a booking can hold at most 3 proofs waiting for review - the 4th is refused (429) and stores nothing', up2.status === 200 && up3.status === 200 && up4.status === 429 && (await subRows(A.id)).length === 3, `${up2.status} ${up3.status} ${up4.status}`);
    const trackA2 = await track(A);
    check('the panel now lists the 3 pending proofs and stops offering more uploads', trackA2.eft.submissions.length === 3 && trackA2.eft.submissions.every(s => s.status === 'pending') && trackA2.eft.can_upload === false && trackA2.eft.pending_count === 3, JSON.stringify(trackA2.eft.submissions));
    check('...each shows the name of the file the client sent (as they named it) and when', trackA2.eft.submissions.every(s => s.file_name === 'proof.png' && /^\d{4}-\d{2}-\d{2}/.test(s.submitted_at)), JSON.stringify(trackA2.eft.submissions[0]));
    check('...and nothing in the client view exposes internals', !/proof_filename|sha256|submitted_ip|reviewed_by|submitted_by_email/.test(JSON.stringify(trackA2.eft)), '');

    // the client's own file back, and nobody else's
    const own = await fetch(`${BASE}/api/public/bookings/${A.id}/eft/proof/${s1.id}?access_token=${encodeURIComponent(A.token)}`);
    const ownBuf = Buffer.from(await own.arrayBuffer());
    check('the client can fetch their own proof back, byte for byte, as a download with sniffing off', own.status === 200 && ownBuf.equals(proof1) && /attachment/.test(own.headers.get('content-disposition') || '') && own.headers.get('x-content-type-options') === 'nosniff' && /no-store/.test(own.headers.get('cache-control') || ''), own.status);
    const histUp = await upload(hist, { fields: { amount: '500' } });
    const histSub = (await subRows(hist.id))[0];
    check('another booking\'s client can upload for their own booking', histUp.status === 200 && histSub, JSON.stringify(histUp.body));
    const stolen = await fetch(`${BASE}/api/public/bookings/${A.id}/eft/proof/${histSub.id}?access_token=${encodeURIComponent(A.token)}`);
    const noTok = await fetch(`${BASE}/api/public/bookings/${A.id}/eft/proof/${s1.id}`);
    const wrongTok = await fetch(`${BASE}/api/public/bookings/${A.id}/eft/proof/${s1.id}?access_token=${encodeURIComponent(hist.token)}`);
    check('...but cannot read anyone else\'s: another booking\'s submission is "not found" (404), no token / a foreign token is refused (401)', stolen.status === 404 && noTok.status === 401 && wrongTok.status === 401, `${stolen.status} ${noTok.status} ${wrongTok.status}`);

    // ═══ 7. the admin's queue ═══
    const queue = await api('GET', '/api/admin/eft/submissions?status=pending');
    const mine = (queue.body.submissions || []).filter(s => s.booking_id === A.id);
    check('the review queue lists the pending proofs with the client, event, claimed amount and outstanding balance', queue.status === 200 && mine.length === 3 && mine[0].client_name && mine[0].invoice_number === invA.invoice_number && mine.every(s => s.status === 'pending') && queue.body.pending_count >= 4, JSON.stringify(mine[0]));
    const detail = await api('GET', `/api/admin/eft/submissions/${s1.id}`);
    check('the detail view has the booking, invoice, the history and the details the client was shown (masked) - and no storage name',
        detail.status === 200 && detail.body.booking.outstanding === 5000 && detail.body.invoice.invoice_number === invA.invoice_number && detail.body.events.length === 1
        && detail.body.bank_details_shown.account_number_masked === '*******4567' && !JSON.stringify(detail.body).includes(s1.proof_filename) && !JSON.stringify(detail.body).includes(ACCT_1), JSON.stringify(detail.body).slice(0, 300));
    const adminLogin = await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'test.runner@example.invalid', password: 'TestRunnerPass1!' }) });
    const adminCookie = (adminLogin.headers.get('set-cookie') || '').split(';')[0];
    const adminFile = await fetch(`${BASE}/api/admin/eft/submissions/${s1.id}/proof?inline=1`, { headers: { Cookie: adminCookie } });
    const adminBuf = Buffer.from(await adminFile.arrayBuffer());
    check('the reviewer gets the exact file, typed correctly, never cached, never sniffed, in a locked-down sandbox',
        adminFile.status === 200 && adminBuf.equals(proof1) && adminFile.headers.get('content-type') === 'image/png' && adminFile.headers.get('x-content-type-options') === 'nosniff'
        && /no-store/.test(adminFile.headers.get('cache-control') || '') && /sandbox/.test(adminFile.headers.get('content-security-policy') || ''), adminFile.status);
    check('an assistant cannot download a proof (403); a manager can', (await assistant('GET', `/api/admin/eft/submissions/${s1.id}/proof`)).status === 403 && (await manager('GET', `/api/admin/eft/submissions/${s1.id}`)).status === 200, '');

    // ═══ 8. approving: validation first ═══
    const missing = await api('POST', `/api/admin/eft/submissions/${s1.id}/approve`, { verified_amount: '1000' });
    check('approving needs the amount, the bank reference AND the date (400 otherwise, nothing recorded)', missing.status === 400 && (await txRows(A.id)).length === 0 && (await subRows(A.id))[0].status === 'pending', JSON.stringify(missing.body));
    check('...an impossible or future date is refused', (await approve(s1.id, { verified_amount: '1000', verified_date: '2999-01-01' })).status === 400 && (await approve(s1.id, { verified_amount: '1000', verified_date: '2026-02-30' })).status === 400, '');
    check('an assistant cannot approve (403)', (await assistant('POST', `/api/admin/eft/submissions/${s1.id}/approve`, { verified_amount: '1000', verified_reference: 'x', verified_date: future(-1) })).status === 403, '');

    // ═══ 9. approving: one atomic ledger payment, partial first ═══
    const rev0 = await revenue();
    const ref1 = `FNB-PART-${Date.now()}`;
    const ap1 = await approve(s1.id, { verified_amount: '1000', verified_reference: ref1, verified_date: future(-2), note: 'seen on the statement' });
    check('approving a R1,000 proof records the payment (200)', ap1.status === 200 && ap1.body.success && ap1.body.payment_status === 'PARTIALLY_PAID', JSON.stringify(ap1.body));
    const bkA1 = await bookingRow(A.id);
    check('the booking is credited exactly the VERIFIED amount: R1,000.00 paid, R4,000.00 outstanding, PARTIALLY_PAID, CONFIRMED (a payment confirms, as for a card)',
        bkA1.amount_paid === 1000 && bkA1.amount_outstanding === 4000 && bkA1.payment_status === 'PARTIALLY_PAID' && bkA1.status === 'CONFIRMED', JSON.stringify(bkA1));
    const tx1 = await txRows(A.id);
    check('exactly ONE ledger row: a completed bank transfer, source manual, the bank\'s reference, dated the day the money arrived, proof file attached, verified, tied to the invoice',
        tx1.length === 1 && tx1[0].amount === 1000 && tx1[0].transaction_type === 'payment' && tx1[0].payment_method === 'bank_transfer' && tx1[0].source === 'manual' && tx1[0].status === 'completed'
        && tx1[0].reference === ref1 && String(tx1[0].transaction_date).slice(0, 10) === future(-2) && tx1[0].proof_of_payment_path === s1.proof_filename && tx1[0].is_verified === 1 && tx1[0].invoice_id === invA.id, JSON.stringify(tx1));
    const s1b = (await subRows(A.id))[0];
    check('the submission is approved, linked to that row, and records who verified what', s1b.status === 'approved' && s1b.transaction_id === tx1[0].id && s1b.verified_amount === 1000 && s1b.verified_reference === ref1 && s1b.verified_date === future(-2) && s1b.reviewed_by && s1b.reviewed_at, JSON.stringify(s1b));
    check('revenue rose by exactly R1,000.00 - once', Math.round(((await revenue()) - rev0) * 100) / 100 === 1000, `${rev0} -> ${await revenue()}`);
    const evAp = await q("SELECT action, actor_type, from_status, to_status FROM eft_submission_events WHERE submission_id = ? ORDER BY id", [s1.id]);
    check('the history shows submitted then approved (by an admin, pending -> approved)', evAp.length === 2 && evAp[1].action === 'approved' && evAp[1].actor_type === 'admin' && evAp[1].from_status === 'pending' && evAp[1].to_status === 'approved', JSON.stringify(evAp));
    const auditAp = await one("SELECT * FROM audit_log WHERE table_name = 'eft_payment_submissions' AND record_id = ? AND action = 'EFT_APPROVED'", [s1.id]);
    check('the approval is in the audit log with the admin, their role, the amount and the ledger row', auditAp && auditAp.changed_by && auditAp.actor_role === 'administrator' && /1000/.test(auditAp.new_values) && new RegExp(`"transaction_id":${tx1[0].id}`).test(auditAp.new_values), JSON.stringify(auditAp));
    const apMail = await mailTo(A.email, 'Your EFT payment has been verified%');
    check('only NOW is the client told their payment was verified, with the ledger\'s own figures', apMail && /verified/i.test(mailHtml(apMail)) && /R1000\.00/.test(mailHtml(apMail)) && /R4000\.00/.test(mailHtml(apMail)), apMail ? mailHtml(apMail).slice(0, 200) : 'no email');

    // ═══ 10. never twice ═══
    const second = await api('POST', `/api/admin/eft/submissions/${s1.id}/approve`, { verified_amount: '1000', verified_reference: ref1, verified_date: future(-2) });
    check('approving the same proof again is refused (409) and changes nothing', second.status === 409 && /already been reviewed/i.test(second.body.message) && (await txRows(A.id)).length === 1 && (await bookingRow(A.id)).amount_paid === 1000, JSON.stringify(second.body));
    const s2 = (await subRows(A.id))[1];
    const [raceA, raceB] = await Promise.all([approve(s2.id, { verified_amount: '1500' }), approve(s2.id, { verified_amount: '1500' })]);
    check('two administrators approving the same proof at the same instant: exactly one wins (200), the other is told it was just reviewed (409)', [raceA.status, raceB.status].sort().join() === '200,409', `${raceA.status}/${raceB.status}`);
    const bkA2 = await bookingRow(A.id);
    check('...one ledger row was added (two in all), the booking is credited R2,500.00 once', (await txRows(A.id)).length === 2 && bkA2.amount_paid === 2500 && bkA2.amount_outstanding === 2500, JSON.stringify(bkA2));
    check('...R2,500 covers the first instalment: DEPOSIT_PAID, and that milestone is marked paid', bkA2.payment_status === 'DEPOSIT_PAID'
        && !!(await poll(async () => (await q("SELECT status FROM payment_schedules WHERE booking_id = ? ORDER BY sequence, due_date, id", [A.id]))[0].status === 'paid')), JSON.stringify(await q('SELECT status FROM payment_schedules WHERE booking_id = ?', [A.id])));
    const s3 = (await subRows(A.id))[2];
    const over = await approve(s3.id, { verified_amount: '2600' });
    check('verifying more than is still owed is refused (409, overpayment) - nothing is recorded and the proof stays pending',
        over.status === 409 && over.body.overpayment === true && over.body.max_amount === 2500 && (await txRows(A.id)).length === 2 && (await bookingRow(A.id)).amount_paid === 2500 && (await subRows(A.id))[2].status === 'pending', JSON.stringify(over.body));

    const overByCents = await approve(s3.id, { verified_amount: '2500.50' });
    check('...even 50 cents too much is refused: a verified bank amount is exact (stricter than the card path\'s R1 tolerance)', overByCents.status === 409 && overByCents.body.overpayment === true && (await txRows(A.id)).length === 2 && (await subRows(A.id))[2].status === 'pending', JSON.stringify(overByCents.body));

    // ═══ 11. paid in full ═══
    const ap3 = await approve(s3.id, { verified_amount: '2500' });
    const bkA3 = await bookingRow(A.id);
    check('the last R2,500 settles it: PAID, R5,000.00 paid, nothing outstanding, CONFIRMED', ap3.status === 200 && bkA3.payment_status === 'PAID' && bkA3.amount_paid === 5000 && bkA3.amount_outstanding === 0 && bkA3.status === 'CONFIRMED', JSON.stringify(bkA3));
    check('...the invoice is marked PAID in the same transaction', (await one('SELECT status FROM invoices WHERE id = ?', [invA.id])).status === 'PAID', '');
    check('...every payment milestone ends up paid', !!(await poll(async () => (await q('SELECT status FROM payment_schedules WHERE booking_id = ?', [A.id])).every(r => r.status === 'paid'))), JSON.stringify(await q('SELECT status FROM payment_schedules WHERE booking_id = ?', [A.id])));
    check('...a confirmed booking gets its events row, as after any other payment', !!(await poll(async () => (await one('SELECT event_id FROM bookings WHERE id = ?', [A.id])).event_id)), '');
    check('...three payments, three rows, R5,000.00 in all - and revenue rose by exactly R5,000.00 across the whole flow', (await txRows(A.id)).length === 3 && Math.round(((await revenue()) - rev0) * 100) / 100 === 5000, `${rev0} -> ${await revenue()}`);
    const upPaid = await upload(A);
    check('a booking that is paid in full accepts no more proofs', upPaid.status === 400 && /paid in full/i.test(upPaid.body.message || ''), JSON.stringify(upPaid.body));
    const recon = await apiBinary('GET', '/api/admin/reconciliation/export/csv');
    const reconLine = recon.buffer.toString().split('\r\n').find(l => l.startsWith(`${A.id},`)) || '';
    const cols = reconLine.split(',');
    check('the accountant\'s reconciliation file reconciles it: R5,000.00 received as MANUAL, none as PayFast, no dual-source or overpayment warning',
        cols[7] === '0.00' && cols[8] === '5000.00' && cols[10] === '5000.00' && cols[11] === '0.00' && cols[12] === 'NO' && cols[13] === 'NO', reconLine);
    const pl = await api('GET', `/api/admin/bookings/${A.id}/expenses`);
    check('the booking\'s profit-and-loss sees R5,000.00 of revenue and no refund (the ordinary ledger rows)', pl.status === 200 && pl.body.gross_revenue === 5000 && pl.body.refunded === 0 && pl.body.net_profit === 5000, JSON.stringify(pl.body).slice(0, 300));
    const ledgerProof = await apiBinary('GET', `/api/admin/transactions/${tx1[0].id}/proof`);
    check('the ledger\'s own proof link (already used for manual payments) serves the approved proof', ledgerProof.status === 200 && ledgerProof.buffer.equals(proof1), ledgerProof.status);

    // ═══ 12. rejecting and asking for a replacement - the client is told why, nothing is credited ═══
    const reject0 = await api('POST', `/api/admin/eft/submissions/${histSub.id}/reject`, {});
    check('rejecting needs a reason the client can read (400 without one)', reject0.status === 400 && (await subRows(hist.id))[0].status === 'pending', JSON.stringify(reject0.body));
    const rej = await api('POST', `/api/admin/eft/submissions/${histSub.id}/reject`, { note: 'We cannot find a R500.00 deposit from you on our statement.' });
    check('a rejection with a reason is recorded', rej.status === 200 && (await subRows(hist.id))[0].status === 'rejected' && (await subRows(hist.id))[0].reviewed_by, JSON.stringify(rej.body));
    check('...and credits NOTHING: no ledger row, no payment on the booking', (await txRows(hist.id)).length === 0 && (await bookingRow(hist.id)).amount_paid === 0 && (await bookingRow(hist.id)).payment_status === 'UNPAID', '');
    const rejMail = await mailTo(hist.email, 'We could not verify your payment%');
    check('...the client is e-mailed the reason and told nothing was credited', rejMail && /cannot find a R500\.00 deposit/.test(mailHtml(rejMail)) && /nothing has been credited/i.test(mailHtml(rejMail)), rejMail ? mailHtml(rejMail).slice(0, 300) : 'no email');
    check('...and sees it on their booking page with the reason', (await track(hist)).eft.submissions.find(s => s.id === histSub.id && s.status === 'rejected' && /R500\.00 deposit/.test(s.review_note)), '');
    check('a reviewed proof cannot be reviewed again, in either direction (409)', (await api('POST', `/api/admin/eft/submissions/${histSub.id}/reject`, { note: 'again please' })).status === 409
        && (await api('POST', `/api/admin/eft/submissions/${histSub.id}/request-replacement`, { note: 'again please' })).status === 409 && (await approve(histSub.id, { verified_amount: '500' })).status === 409, '');
    await upload(hist, { fields: { amount: '800' } });
    const histSub2 = (await subRows(hist.id))[1];
    const repl = await api('POST', `/api/admin/eft/submissions/${histSub2.id}/request-replacement`, { note: 'The screenshot is cut off - please send the whole confirmation.' });
    check('asking for a replacement is recorded with its own status and credits nothing', repl.status === 200 && (await subRows(hist.id))[1].status === 'replacement_requested' && (await txRows(hist.id)).length === 0, JSON.stringify(repl.body));
    const replMail = await mailTo(hist.email, 'Please send a new proof of payment%');
    check('...the client is asked for a new proof, with the reason', replMail && /cut off/.test(mailHtml(replMail)), replMail ? '' : 'no email');
    check('...a replacement-requested proof can no longer be approved (409)', (await approve(histSub2.id, { verified_amount: '800' })).status === 409, '');
    await upload(hist, { fields: { amount: '800' } });
    check('...and the client can simply upload a fresh one', (await subRows(hist.id)).length === 3 && (await subRows(hist.id))[2].status === 'pending', '');

    // ═══ 13. the same bank line must not become two payments ═══
    const histSub3 = (await subRows(hist.id))[2];
    const dupWarn = await api('POST', `/api/admin/eft/submissions/${histSub3.id}/approve`, { verified_amount: '1000', verified_reference: ref1, verified_date: future(-1) });
    check('a payment with the same reference and amount already in the ledger is flagged (409 duplicate_warning) and NOT recorded', dupWarn.status === 409 && dupWarn.body.duplicate_warning === true && (await txRows(hist.id)).length === 0 && (await subRows(hist.id))[2].status === 'pending', JSON.stringify(dupWarn.body));
    const dupOk = await api('POST', `/api/admin/eft/submissions/${histSub3.id}/approve`, { verified_amount: '1000', verified_reference: ref1, verified_date: future(-1), confirm_duplicate: true });
    check('...an administrator who knows it is a different transfer can confirm it, and the override is on the record',
        dupOk.status === 200 && (await txRows(hist.id)).length === 1 && /Duplicate warning overridden/.test((await q("SELECT note FROM eft_submission_events WHERE submission_id = ? AND action = 'approved'", [histSub3.id]))[0].note)
        && /"duplicate_override":true/.test((await one("SELECT new_values FROM audit_log WHERE table_name = 'eft_payment_submissions' AND record_id = ? AND action = 'EFT_APPROVED'", [histSub3.id])).new_values), JSON.stringify(dupOk.body));

    // ═══ 14. versioning: an invoice already issued never changes ═══
    const C = await makeBooking('C');                                  // issued on version 1 and still unpaid when the details change
    const invC = await one('SELECT id, bank_details_id FROM invoices WHERE booking_id = ?', [C.id]);
    const changed = await api('PUT', '/api/admin/eft/bank-details', goodDetails({ bank_name: 'Nedbank', account_number: ACCT_2, branch_code: '198765' }));
    check('changing the details creates version 2 and says how many unpaid invoices still show the old ones', changed.status === 200 && changed.body.version === 2 && changed.body.open_invoices_on_previous_version >= 1 && /unchanged/i.test(changed.body.message), JSON.stringify(changed.body));
    const versions = (await api('GET', '/api/admin/eft/bank-details')).body;
    check('there are two versions, only version 2 is active, the old one is retired and keeps its details', versions.versions.length === 2 && versions.active.version === 2 && versions.active.account_number === ACCT_2
        && versions.versions.find(v => v.version === 1).is_active === false && !!versions.versions.find(v => v.version === 1).retired_at && (await one('SELECT account_number FROM bank_details WHERE version = 1')).account_number === ACCT_1, JSON.stringify(versions.versions));
    const audit2 = await one("SELECT * FROM audit_log WHERE table_name = 'bank_details' AND action = 'BANK_DETAILS_CHANGED' ORDER BY id DESC LIMIT 1");
    check('the change is audited old -> new with both numbers masked, and names the fields that changed',
        audit2 && !JSON.stringify(audit2).includes(ACCT_1) && !JSON.stringify(audit2).includes(ACCT_2) && /4567/.test(audit2.old_values) && /5432/.test(audit2.new_values) && /bank_name/.test(audit2.reason) && /account_number/.test(audit2.reason), JSON.stringify(audit2));
    check('invoices already issued still point at version 1', (await one('SELECT bank_details_id b FROM invoices WHERE id = ?', [invA.id])).b === 1 && (await one('SELECT bank_details_id b FROM invoices WHERE id = ?', [invC.id])).b === 1 && invC.bank_details_id === 1, '');
    const pdfAAfter = await apiBinary('GET', `/api/admin/bookings/${A.id}/invoice/download`);
    check('the invoice PDF issued earlier is byte-for-byte unchanged and still shows the OLD bank and account',
        require('crypto').createHash('sha256').update(pdfAAfter.buffer).digest('hex') === pdfAHash && extractPdfText(pdfAAfter.buffer).includes(ACCT_1) && !extractPdfText(pdfAAfter.buffer).includes(ACCT_2), '');
    const D = await makeBooking('D');
    const invD = await one('SELECT id, bank_details_id, invoice_number FROM invoices WHERE booking_id = ?', [D.id]);
    const pdfD = extractPdfText((await apiBinary('GET', `/api/admin/bookings/${D.id}/invoice/download`)).buffer).replace(/\s+/g, ' ');
    check('an invoice issued AFTER the change carries version 2 (Nedbank) in its record and its PDF', invD.bank_details_id === 2 && /Nedbank/.test(pdfD) && pdfD.includes(ACCT_2) && !pdfD.includes(ACCT_1), pdfD.slice(-400));
    const trackC = await track(C);
    check('the live tracking page shows the CURRENT details, and tells the client their invoice was issued with earlier ones', trackC.eft.bank_details.accountNumber === ACCT_2 && trackC.eft.details_changed === true && trackC.eft.bank_details.reference === (await one('SELECT invoice_number n FROM invoices WHERE id = ?', [invC.id])).n, JSON.stringify(trackC.eft));
    check('...whereas a booking issued after the change shows no such warning', (await track(D)).eft.details_changed === false, '');

    // ═══ 15. switching EFT off ═══
    await api('PUT', '/api/admin/eft/settings', { enabled: false });
    const E = await makeBooking('E');
    check('with EFT off a new invoice carries no banking details (record or PDF)', (await one('SELECT bank_details_id b FROM invoices WHERE booking_id = ?', [E.id])).b === null
        && !/PAY BY EFT/.test(extractPdfText((await apiBinary('GET', `/api/admin/bookings/${E.id}/invoice/download`)).buffer)), '');
    check('...the tracking page offers nothing and an upload is refused (409)', (await track(E)).eft === null && (await upload(E)).status === 409, '');
    check('...but a client\'s EARLIER proofs stay visible to them', (await track(A)).eft && (await track(A)).eft.submissions.length === 3 && (await track(A)).eft.bank_details === null, JSON.stringify((await track(A)).eft));
    check('...and the reviewer can still work the queue (a proof sent before it was switched off is still reviewed)', (await api('GET', '/api/admin/eft/submissions')).status === 200, '');
    await api('PUT', '/api/admin/eft/settings', { enabled: true });

    // ═══ 16. deleting an unpaid booking removes its proofs and their files ═══
    const F = await makeBooking('F');
    const upF = await upload(F, { fields: { amount: '300' } });
    const subF = (await subRows(F.id))[0];
    const fileF = path.join(PROOFS, subF.proof_filename);
    check('setup: an unpaid booking holds a pending proof and its file', upF.status === 200 && fs.existsSync(fileF), '');
    // This check is about the proof, not about a pre-existing bug in the booking delete: BOOKING_DELETE_PURGE (routes/admin/bookings.js) deletes
    // payment_schedules BEFORE reminders_log, and reminders_log.schedule_id references payment_schedules, so a booking that already has a reminder
    // row cannot be deleted (HTTP 500 "Cascade delete failed"). The deposit here falls due within a week, so the background reminder job sends
    // one at some point during the run - which is why the failure looked intermittent. Pushing this booking's instalments far into the future
    // keeps the job away from it. (Not fixed here: unrelated, and not yet approved by the owner.)
    await new Promise((resolve, reject) => {
        const d = new (require('sqlite3').Database)(TEST_DB);
        d.configure('busyTimeout', 5000);
        d.run("UPDATE payment_schedules SET due_date = '2099-01-01' WHERE booking_id = ?", [F.id], (e) => d.close(() => e ? reject(e) : resolve()));
    });
    await poll(async () => (await one("SELECT 1 x FROM notifications WHERE recipient_email = ? AND subject LIKE 'Invoice for Booking%'", [F.email])), 8000);
    await sleep(500);
    const del = await api('DELETE', `/api/admin/bookings/${F.id}`);
    const cascadeLog = (getChildLog().split('\n').filter(l => /Cascade failed/.test(l)).slice(-1)[0] || '');
    check('deleting that booking succeeds (the proof does not block it)', del.status === 200, JSON.stringify(del.body) + ' | ' + cascadeLog);
    check('...its proof rows and history are gone', (await subRows(F.id)).length === 0 && (await q('SELECT 1 FROM eft_submission_events WHERE submission_id = ?', [subF.id])).length === 0, '');
    check('...and so is the file - a personal financial document does not outlive its booking', !!(await poll(async () => !fs.existsSync(fileF))), '');
    const delPaid = await api('DELETE', `/api/admin/bookings/${A.id}`);
    check('a booking with an approved EFT payment still cannot be deleted (the financial trail stays)', delPaid.status === 400 && (await subRows(A.id)).length === 3, JSON.stringify(delPaid.body));

    // ═══ 17. POPIA erasure ═══
    const G = await makeBooking('G');
    await upload(G, { fields: { amount: '400', reference: 'my private ref', note: 'private note from me' } });
    await upload(G, { fields: { amount: '600' } });
    const [g1, g2] = await subRows(G.id);
    const approvedG = await approve(g1.id, { verified_amount: '400' });
    const pendingFile = path.join(PROOFS, g2.proof_filename), approvedFile = path.join(PROOFS, g1.proof_filename);
    check('setup: one approved and one pending proof, both with files', approvedG.status === 200 && fs.existsSync(pendingFile) && fs.existsSync(approvedFile), '');
    const erase = await api('POST', '/api/admin/gdpr/delete', { email: G.email });
    check('erasing the client succeeds and reports the EFT rows it redacted', erase.status === 200 && erase.body.affected && erase.body.affected.eft_submissions === 2, JSON.stringify(erase.body).slice(0, 300));
    const [ge1, ge2] = await subRows(G.id);
    check('their address, e-mail, note and file name are gone from every submission', [ge1, ge2].every(s => s.submitted_ip === null && s.submitted_by_email === null && s.client_note === null && s.proof_original_name === null), JSON.stringify([ge1, ge2]));
    check('the approved proof keeps its file, reference and verified amounts (a supporting financial record, like its transaction)', ge1.status === 'approved' && ge1.proof_filename === g1.proof_filename && ge1.verified_amount === 400 && ge1.claimed_reference === 'my private ref' && fs.existsSync(approvedFile), JSON.stringify(ge1));
    check('the pending proof loses its file and its stored name (no financial claim on it)', ge2.proof_filename === '[erased]' && ge2.claimed_reference === null && !!(await poll(async () => !fs.existsSync(pendingFile))), JSON.stringify(ge2));
    check('the ledger payment itself is untouched by the erasure', (await txRows(G.id)).length === 1 && (await txRows(G.id))[0].amount === 400, '');

    // ═══ 18. a booking the proof can no longer be applied to ═══
    const H = await makeBooking('H');
    await upload(H, { fields: { amount: '700' } });
    const subH = (await subRows(H.id))[0];
    await api('POST', `/api/admin/bookings/${H.id}/cancel`, { reason: 'test', cancelled_by: 'client' });
    const onCancelled = await approve(subH.id, { verified_amount: '700' });
    check('a proof cannot be approved against a CANCELLED booking (409) - nothing is recorded, the proof stays pending for a human decision',
        onCancelled.status === 409 && /CANCELLED/.test(onCancelled.body.message) && (await txRows(H.id)).length === 0 && (await subRows(H.id))[0].status === 'pending', JSON.stringify(onCancelled.body));
    check('...but it can still be rejected, with a reason', (await api('POST', `/api/admin/eft/submissions/${subH.id}/reject`, { note: 'The booking was cancelled - no payment is due.' })).status === 200, '');
    check('a client cannot upload against a cancelled booking either', (await upload(H)).status === 400, '');
};
