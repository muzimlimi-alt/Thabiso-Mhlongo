// Coverage for the POPIA Data Erasure feature: OTP email-ownership verification, public request
// submission + validation, the admin review/approve/reject/process lifecycle (with its CAS
// double-processing guards), booking cancellation + refund-gated completion (awaiting_refund),
// the core anonymizeClientData() correctness across every carrier table (with financial/audit
// records confirmed UNTOUCHED and no orphaned FKs), RBAC, and the legacy compatibility wrappers.
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3');
const support = require('./support');
const { api, pub, loginAs, one, getPopiaOtpCode } = support;

const rw = new sqlite3.Database(support.TEST_DB);
const run = (sql, params = []) => new Promise((res, rej) => rw.run(sql, params, function (e) { e ? rej(e) : res(this); }));

let seq = 0;
const email = () => `popia.test.${Date.now()}.${seq++}@example.invalid`;

module.exports = async function ({ check }) {
    // ── Public submission: validation (all fail before the OTP check runs, so no code is needed) ──
    const missingEmail = await pub('POST', '/api/public/popia/erasure-requests', { reason: 'privacy_concerns', consequences_acknowledged: true });
    check('public submit: missing email -> 400', missingEmail.status === 400, JSON.stringify(missingEmail.body));

    const testEmail1 = email();
    const missingAck = await pub('POST', '/api/public/popia/erasure-requests', { email: testEmail1, reason: 'privacy_concerns' });
    check('public submit: missing consequences_acknowledged -> 400', missingAck.status === 400, JSON.stringify(missingAck.body));

    const otherNoText = await pub('POST', '/api/public/popia/erasure-requests', { email: testEmail1, reason: 'other', consequences_acknowledged: true });
    check('public submit: reason=other with no reason_other_text -> 400', otherNoText.status === 400, JSON.stringify(otherNoText.body));

    const badReason = await pub('POST', '/api/public/popia/erasure-requests', { email: testEmail1, reason: 'not_a_real_reason', consequences_acknowledged: true });
    check('public submit: invalid reason -> 400', badReason.status === 400, JSON.stringify(badReason.body));

    // ── Public submission: missing/wrong OTP code ──
    const missingOtp = await pub('POST', '/api/public/popia/erasure-requests', { email: testEmail1, reason: 'privacy_concerns', consequences_acknowledged: true });
    check('public submit: missing otp_code -> 400', missingOtp.status === 400, JSON.stringify(missingOtp.body));

    const noCodeRequested = await pub('POST', '/api/public/popia/erasure-requests', { email: testEmail1, otp_code: '000000', reason: 'privacy_concerns', consequences_acknowledged: true });
    check('public submit: otp_code with none ever requested -> 400', noCodeRequested.status === 400, JSON.stringify(noCodeRequested.body));

    // ── OTP mechanics: request -> wrong code decrements attempts -> correct code works, preview
    // doesn't consume it, submit does ──
    const otpEmail = email();
    const requestOtpRes = await pub('POST', '/api/public/popia/request-otp', { email: otpEmail });
    check('OTP: request-otp -> 200', requestOtpRes.status === 200 && requestOtpRes.body.success, JSON.stringify(requestOtpRes.body));

    const realCode = await one('SELECT code_hash FROM popia_verification_codes WHERE email = ? ORDER BY id DESC LIMIT 1', [otpEmail]);
    check('OTP: a code row was created', !!realCode, '');

    const wrongAttempt1 = await pub('POST', '/api/public/popia/preview', { email: otpEmail, otp_code: '000000' });
    check('OTP: wrong code -> 400 with remaining-attempts message', wrongAttempt1.status === 400 && /attempt/i.test(wrongAttempt1.body.message), JSON.stringify(wrongAttempt1.body));

    const codeRow = await one('SELECT attempts FROM popia_verification_codes WHERE email = ? ORDER BY id DESC LIMIT 1', [otpEmail]);
    check('OTP: attempts incremented after a wrong guess', codeRow.attempts === 1, JSON.stringify(codeRow));

    // Exhaust the remaining attempts (4 more wrong guesses -> 5 total -> locked out)
    for (let i = 0; i < 4; i++) {
        await pub('POST', '/api/public/popia/preview', { email: otpEmail, otp_code: '111111' });
    }
    const lockedOutAttempt = await pub('POST', '/api/public/popia/preview', { email: otpEmail, otp_code: '222222' });
    check('OTP: 6th wrong attempt is locked out, forcing a fresh code', lockedOutAttempt.status === 400 && /new code/i.test(lockedOutAttempt.body.message), JSON.stringify(lockedOutAttempt.body));

    const afterLockout = await one('SELECT consumed FROM popia_verification_codes WHERE email = ? ORDER BY id DESC LIMIT 1', [otpEmail]);
    check('OTP: locked-out code is marked consumed', afterLockout.consumed === 1, JSON.stringify(afterLockout));

    // Fresh code: correct on the preview endpoint does NOT consume it
    const otpCode2 = await getPopiaOtpCode(otpEmail);
    check('OTP: fresh code readable from the queued email', !!otpCode2 && /^\d{6}$/.test(otpCode2), String(otpCode2));

    const previewOk = await pub('POST', '/api/public/popia/preview', { email: otpEmail, otp_code: otpCode2 });
    check('OTP: correct code on /preview -> 200', previewOk.status === 200 && previewOk.body.success && Array.isArray(previewOk.body.bookings), JSON.stringify(previewOk.body));

    const stillUnconsumed = await one('SELECT consumed FROM popia_verification_codes WHERE email = ? ORDER BY id DESC LIMIT 1', [otpEmail]);
    check('OTP: preview does NOT consume the code', stillUnconsumed.consumed === 0, JSON.stringify(stillUnconsumed));

    // Same code now used on the real submit -> succeeds AND consumes it
    const otpSubmit = await pub('POST', '/api/public/popia/erasure-requests', {
        email: otpEmail, otp_code: otpCode2, reason: 'privacy_concerns', consequences_acknowledged: true
    });
    check('OTP: same (still-valid) code accepted by /erasure-requests', otpSubmit.status === 200 && otpSubmit.body.success, JSON.stringify(otpSubmit.body));

    const nowConsumed = await one('SELECT consumed FROM popia_verification_codes WHERE email = ? ORDER BY id DESC LIMIT 1', [otpEmail]);
    check('OTP: submit DOES consume the code', nowConsumed.consumed === 1, JSON.stringify(nowConsumed));

    const otpReuse = await pub('POST', '/api/public/popia/erasure-requests', {
        email: otpEmail, otp_code: otpCode2, reason: 'privacy_concerns', consequences_acknowledged: true
    });
    check('OTP: consumed code cannot be reused for a second submit -> 400', otpReuse.status === 400, JSON.stringify(otpReuse.body));

    // ── Legacy /api/public/compliance/request-forget also requires OTP now ──
    const forgetEmail = email();
    const forgetNoOtp = await pub('POST', '/api/public/compliance/request-forget', { email: forgetEmail });
    check('request-forget: missing otp_code -> 400', forgetNoOtp.status === 400, JSON.stringify(forgetNoOtp.body));
    const forgetOtp = await getPopiaOtpCode(forgetEmail);
    const forgetOk = await pub('POST', '/api/public/compliance/request-forget', { email: forgetEmail, otp_code: forgetOtp });
    check('request-forget: valid otp_code -> 200', forgetOk.status === 200 && forgetOk.body.success, JSON.stringify(forgetOk.body));

    // ── Public submission: happy path (with a real OTP code) ──
    const testEmail1Otp = await getPopiaOtpCode(testEmail1);
    const happyRes = await pub('POST', '/api/public/popia/erasure-requests', {
        email: testEmail1, otp_code: testEmail1Otp, reason: 'no_longer_a_client', additional_comments: 'Test comment', consequences_acknowledged: true
    });
    check('public submit: happy path -> 200 with reference number', happyRes.status === 200 && happyRes.body.success && /^POPIA-\d{4}-\d{5}$/.test(happyRes.body.reference_number), JSON.stringify(happyRes.body));
    const refNumber1 = happyRes.body.reference_number;

    const seededRow = await one('SELECT * FROM popia_erasure_requests WHERE email = ?', [testEmail1]);
    check('DB: request row created as pending/source=public', !!seededRow && seededRow.status === 'pending' && seededRow.source === 'public', JSON.stringify(seededRow));

    // ── Admin list/search/filter finds the seeded request ──
    const listRes = await api('GET', '/api/admin/popia/requests?search=' + encodeURIComponent(refNumber1));
    check('admin list: search by reference finds the request', listRes.status === 200 && listRes.body.success && listRes.body.requests.some(r => r.reference_number === refNumber1), JSON.stringify(listRes.body).slice(0, 200));

    const statusFilterRes = await api('GET', '/api/admin/popia/requests?status=pending');
    check('admin list: status=pending filter includes the request', statusFilterRes.body.requests.some(r => r.id === seededRow.id), '');

    // ── Detail + preview ──
    const detailRes = await api('GET', `/api/admin/popia/requests/${seededRow.id}`);
    check('admin detail: 200, includes preview counts + booking_impact array', detailRes.status === 200 && detailRes.body.success && detailRes.body.preview && typeof detailRes.body.preview.bookings === 'number' && Array.isArray(detailRes.body.booking_impact), JSON.stringify(detailRes.body).slice(0, 200));

    // ── CAS: can't process a request that's still pending (never approved) ──
    const processPending = await api('POST', `/api/admin/popia/requests/${seededRow.id}/process`);
    check('CAS: process on a pending (not-yet-approved) request -> 409', processPending.status === 409, JSON.stringify(processPending.body));

    // ── Reject path ──
    const rejectNoNotes = await api('PUT', `/api/admin/popia/requests/${seededRow.id}/reject`, {});
    check('reject: missing review_notes -> 400', rejectNoNotes.status === 400, JSON.stringify(rejectNoNotes.body));

    const rejectRes = await api('PUT', `/api/admin/popia/requests/${seededRow.id}/reject`, { review_notes: 'Test rejection reason' });
    check('reject: 200', rejectRes.status === 200 && rejectRes.body.success, JSON.stringify(rejectRes.body));

    const afterReject = await one('SELECT status, reviewed_by_name, review_notes FROM popia_erasure_requests WHERE id = ?', [seededRow.id]);
    check('DB: status flipped to rejected with review_notes recorded', afterReject.status === 'rejected' && afterReject.review_notes === 'Test rejection reason', JSON.stringify(afterReject));

    // CAS: double-reject / approve-after-reject / process-after-reject -> all 409 (rejected is terminal)
    const doubleReject = await api('PUT', `/api/admin/popia/requests/${seededRow.id}/reject`, { review_notes: 'Second attempt' });
    check('CAS: double-reject on an already-rejected request -> 409', doubleReject.status === 409, JSON.stringify(doubleReject.body));
    const approveAfterReject = await api('PUT', `/api/admin/popia/requests/${seededRow.id}/approve`);
    check('CAS: approve on an already-rejected request -> 409', approveAfterReject.status === 409, JSON.stringify(approveAfterReject.body));
    const processAfterReject = await api('POST', `/api/admin/popia/requests/${seededRow.id}/process`);
    check('CAS: process on a rejected request -> 409', processAfterReject.status === 409, JSON.stringify(processAfterReject.body));

    // ── Core correctness: deep fixture across every carrier table, approve -> process -> verify ──
    // Booking status is COMPLETED (a delivered, historical event) so this fixture is decoupled from
    // the new cancelActiveBookingsForErasure step (out of scope by design) — this block tests
    // anonymizeClientData()'s per-table correctness in isolation; the booking-cancellation/refund-
    // gating behaviour has its own dedicated fixture further below.
    const testEmail2 = email();
    const clientIns = await run(
        `INSERT INTO clients (full_name, company_name, email, phone, billing_address, tax_id, vat_number) VALUES (?,?,?,?,?,?,?)`,
        ['Deep Fixture Client', 'Fixture Co', testEmail2, '0821234567', '1 Test St', 'TAX123', 'VAT123']
    );
    const clientId = clientIns.lastID;

    const bookingIns = await run(
        `INSERT INTO bookings (name, company, email, cell, event_name, date, event_location, event_type, message, status, client_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        ['Deep Fixture Client', 'Fixture Co', testEmail2, '0821234567', 'Fixture Event', support.future(-400), 'Test Venue', 'Corporate', 'This is a POPIA erasure fixture booking message.', 'COMPLETED', clientId]
    );
    const bookingId = bookingIns.lastID;

    await run(`INSERT INTO inquiries (sender_name, sender_email, sender_phone, message_body) VALUES (?,?,?,?)`,
        ['Deep Fixture Client', testEmail2, '0821234567', 'Fixture inquiry message body.']);
    const inquiryRow = await one('SELECT inquiry_id FROM inquiries WHERE sender_email = ?', [testEmail2]);

    await run(`INSERT INTO inquiry_notes (inquiry_id, note, author) VALUES (?,?,?)`, [inquiryRow.inquiry_id, 'Internal note about fixture client.', 'Admin']);
    await run(`INSERT INTO newsletter_subscribers (email, status) VALUES (?, 'active')`, [testEmail2]);
    await run(`INSERT INTO communication_log (booking_id, client_id, direction, channel, subject, content_snippet, user_email) VALUES (?,?,?,?,?,?,?)`,
        [bookingId, clientId, 'outgoing', 'email', 'Test Subject', 'Test snippet', testEmail2]);
    await run(`INSERT INTO booking_notes (booking_id, note, author) VALUES (?,?,?)`, [bookingId, 'Spoke to the fixture client on the phone.', 'Admin']);

    // Contract + quotation with REAL files on disk so we can assert they're deleted after processing.
    const contractsDirPath = path.join(__dirname, '..', 'docs', 'contracts');
    const quotesDirPath = path.join(__dirname, '..', 'docs', 'quotes');
    fs.mkdirSync(contractsDirPath, { recursive: true });
    fs.mkdirSync(quotesDirPath, { recursive: true });
    const contractFileName = `fixture-contract-${Date.now()}.pdf`;
    const quoteFileName = `fixture-quote-${Date.now()}.pdf`;
    fs.writeFileSync(path.join(contractsDirPath, contractFileName), 'fake pdf content');
    fs.writeFileSync(path.join(quotesDirPath, quoteFileName), 'fake pdf content');

    await run(
        `INSERT INTO contracts (booking_id, template_version, content_html, pdf_url, signed_by, client_ip_address, client_signature_data, builder_clauses, status)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [bookingId, 'v1', '<p>Fixture contract content</p>', contractFileName, 'Deep Fixture Client', '10.0.0.1', 'signature-data', '[]', 'signed']
    );
    await run(`INSERT INTO quotations (booking_id, quote_number, client_id, file_path, status) VALUES (?,?,?,?,?)`,
        [bookingId, `QT-FIXTURE-${Date.now()}`, clientId, quoteFileName, 'sent']);
    await run(`INSERT INTO transactions (booking_id, amount, transaction_date, payment_method, notes, ip_address, reconcile_note, status) VALUES (?,?,datetime('now'),?,?,?,?,?)`,
        [bookingId, 1000, 'bank_transfer', 'A note about this payment', '10.0.0.2', 'Reconciled manually', 'completed']);
    await run(`INSERT INTO cancellations (booking_id, cancelled_by, reason, notes, total_paid_to_date, refund_due) VALUES (?,?,?,?,?,?)`,
        [bookingId, 'client', 'Client changed their mind', 'Some internal note', 500, 0]);
    await run(`INSERT INTO service_reviews (booking_id, client_name, rating, review_text, is_approved) VALUES (?,?,?,?,?)`,
        [bookingId, 'Deep Fixture Client', 5, 'Great service!', 1]);
    await run(`INSERT INTO payment_logs (booking_id, event_type, raw_payload, amount) VALUES (?,?,?,?)`,
        [bookingId, 'ITN_RECEIVED', JSON.stringify({ email_address: testEmail2 }), 1000]);
    await run(`INSERT INTO abandoned_bookings (draft_token, name, email, cell, message, ip_address, user_agent, status) VALUES (?,?,?,?,?,?,?,?)`,
        [`draft-${Date.now()}`, 'Deep Fixture Client', testEmail2, '0821234567', 'Abandoned message', '10.0.0.3', 'test-agent', 'ABANDONED']);
    await run(`INSERT INTO booking_access_codes (booking_id, email, code_hash, expires_at) VALUES (?,?,?,datetime('now','+1 hour'))`,
        [bookingId, testEmail2, 'fake-hash']);
    await run(`INSERT INTO booking_access_tokens (booking_id, email, token_hash, expires_at) VALUES (?,?,?,datetime('now','+1 hour'))`,
        [bookingId, testEmail2, `fake-token-hash-${Date.now()}`]);
    const emailLogIns = await run(`INSERT INTO email_logs (recipient_email, subject, trigger_event, status) VALUES (?,?,?,?)`, [testEmail2, 'Fixture Email Subject', 'Test', 'success']);
    await run(`INSERT INTO reminders_log (booking_id, days_before, due_date, recipient_email) VALUES (?,?,?,?)`,
        [bookingId, 3, support.future(3), testEmail2]);
    const notifIns = await run(`INSERT INTO notifications (type, channel, status, priority, recipient_email, recipient_name, subject, body) VALUES (?,?,?,?,?,?,?,?)`,
        ['test', 'email', 'sent', 'normal', testEmail2, 'Deep Fixture Client', 'Fixture Notification Subject', 'Fixture body content']);
    await run(`INSERT INTO venues (name, contact_name, contact_phone, contact_email) VALUES (?,?,?,?)`,
        ['Fixture Venue', 'Deep Fixture Client', '0821234567', testEmail2]);
    await run(`INSERT INTO direct_emails (inquiry_id, to_emails, subject, body) VALUES (?,?,?,?)`,
        [inquiryRow.inquiry_id, testEmail2, 'Fixture Direct Email', 'Body content mentioning ' + testEmail2]);

    // Untouched controls: invoices (SARS retention) + consent_audit (compliance evidence) + audit_log
    await run(`INSERT INTO invoices (booking_id, client_id, invoice_number, due_date, subtotal, total_amount, status) VALUES (?,?,?,?,?,?,?)`,
        [bookingId, clientId, `INV-FIXTURE-${Date.now()}`, support.future(10), 1000, 1000, 'SENT']);
    await run(`INSERT INTO consent_audit (booking_id, ip_address, policy_version) VALUES (?,?,?)`, [bookingId, '10.0.0.4', 'v1']);

    // ── Submit + preview + approve + process ──
    const testEmail2Otp = await getPopiaOtpCode(testEmail2);
    const req2 = await pub('POST', '/api/public/popia/erasure-requests', { email: testEmail2, otp_code: testEmail2Otp, reason: 'privacy_concerns', consequences_acknowledged: true });
    check('deep fixture: public submit -> 200', req2.status === 200 && req2.body.success, JSON.stringify(req2.body));
    const req2Row = await one('SELECT id FROM popia_erasure_requests WHERE email = ?', [testEmail2]);

    const preview = await api('GET', `/api/admin/popia/requests/${req2Row.id}`);
    check('deep fixture: preview shows non-zero counts across carrier tables', preview.body.preview.contracts >= 1 && preview.body.preview.booking_notes >= 1 && preview.body.preview.quotations >= 1 && preview.body.preview.transactions >= 1 && preview.body.preview.inquiry_notes >= 1, JSON.stringify(preview.body.preview));
    check('deep fixture: COMPLETED booking has no booking_impact (out of cancellation scope)', preview.body.booking_impact.length === 0, JSON.stringify(preview.body.booking_impact));

    const approveRes2 = await api('PUT', `/api/admin/popia/requests/${req2Row.id}/approve`);
    check('deep fixture: approve -> 200', approveRes2.status === 200, JSON.stringify(approveRes2.body));

    const processRes = await api('POST', `/api/admin/popia/requests/${req2Row.id}/process`);
    check('deep fixture: process -> 200 with affected counts (immediate, no refund owed)', processRes.status === 200 && processRes.body.success && processRes.body.affected && !processRes.body.awaiting_refund, JSON.stringify(processRes.body).slice(0, 300));

    // ── Assert every carrier table changed correctly ──
    const clientAfter = await one('SELECT * FROM clients WHERE id = ?', [clientId]);
    check('ANONYMIZED: clients row', clientAfter.full_name === 'POPIA ANONYMIZED' && clientAfter.email === `deleted-${clientId}@po-pia.com` && clientAfter.phone === '0000000000' && clientAfter.company_name === null, JSON.stringify(clientAfter));

    const bookingAfter = await one('SELECT * FROM bookings WHERE id = ?', [bookingId]);
    check('ANONYMIZED: bookings row (status untouched — was already COMPLETED)', bookingAfter.name === 'POPIA ANONYMIZED' && bookingAfter.email === `deleted-${bookingId}@po-pia.com` && bookingAfter.cell === '0000000000' && bookingAfter.status === 'COMPLETED', JSON.stringify(bookingAfter));

    const inquiryAfter = await one('SELECT * FROM inquiries WHERE inquiry_id = ?', [inquiryRow.inquiry_id]);
    check('ANONYMIZED: inquiries row', inquiryAfter.sender_name === 'POPIA ANONYMIZED' && inquiryAfter.sender_email === `deleted-${inquiryRow.inquiry_id}@po-pia.com`, JSON.stringify(inquiryAfter));

    const newsletterAfter = await one('SELECT * FROM newsletter_subscribers WHERE email = ?', [testEmail2]);
    check('ANONYMIZED: newsletter subscription deleted', !newsletterAfter, '');

    const commAfter = await one('SELECT * FROM communication_log WHERE booking_id = ?', [bookingId]);
    check('ANONYMIZED: communication_log row', commAfter.subject === '[DELETED]' && commAfter.user_email === 'deleted@po-pia.com', JSON.stringify(commAfter));

    const contractAfter = await one('SELECT * FROM contracts WHERE booking_id = ?', [bookingId]);
    check('ANONYMIZED: contract signature/IP/signed_by/builder_clauses nulled, content redacted, pdf_url nulled', contractAfter.signed_by === null && contractAfter.client_ip_address === null && contractAfter.client_signature_data === null && contractAfter.builder_clauses === null && contractAfter.pdf_url === null && /redacted/i.test(contractAfter.content_html), JSON.stringify(contractAfter));
    check('ANONYMIZED: contract PDF file deleted from disk', !fs.existsSync(path.join(contractsDirPath, contractFileName)), '');

    const bookingNoteAfter = await one('SELECT * FROM booking_notes WHERE booking_id = ?', [bookingId]);
    check('ANONYMIZED: booking_notes redacted', bookingNoteAfter.note === '[Redacted per POPIA erasure request]', JSON.stringify(bookingNoteAfter));

    const inquiryNoteAfter = await one('SELECT * FROM inquiry_notes WHERE inquiry_id = ?', [inquiryRow.inquiry_id]);
    check('ANONYMIZED: inquiry_notes redacted', inquiryNoteAfter.note === '[Redacted per POPIA erasure request]', JSON.stringify(inquiryNoteAfter));

    const quotationAfter = await one('SELECT * FROM quotations WHERE booking_id = ?', [bookingId]);
    check('ANONYMIZED: quotation file_path nulled', quotationAfter.file_path === null, JSON.stringify(quotationAfter));
    check('ANONYMIZED: quotation PDF file deleted from disk', !fs.existsSync(path.join(quotesDirPath, quoteFileName)), '');

    const txnAfter = await one('SELECT * FROM transactions WHERE booking_id = ?', [bookingId]);
    check('ANONYMIZED: transaction ip/notes/reconcile_note nulled, AMOUNT UNCHANGED (SARS retention)', txnAfter.ip_address === null && txnAfter.notes === null && txnAfter.reconcile_note === null && Number(txnAfter.amount) === 1000, JSON.stringify(txnAfter));

    const cancelAfter = await one('SELECT * FROM cancellations WHERE booking_id = ?', [bookingId]);
    check('ANONYMIZED: cancellation reason redacted, notes nulled, amounts unchanged (COMPLETED booking untouched by the new cancellation step)', /Redacted/.test(cancelAfter.reason) && cancelAfter.notes === null && Number(cancelAfter.total_paid_to_date) === 500, JSON.stringify(cancelAfter));

    const reviewAfter = await one('SELECT * FROM service_reviews WHERE booking_id = ?', [bookingId]);
    check('ANONYMIZED: service_reviews client_name anonymized', reviewAfter.client_name === 'Anonymized Client', JSON.stringify(reviewAfter));

    const payLogAfter = await one('SELECT * FROM payment_logs WHERE booking_id = ?', [bookingId]);
    check('ANONYMIZED: payment_logs raw_payload nulled', payLogAfter.raw_payload === null, JSON.stringify(payLogAfter));

    const abandonedByOldName = await one('SELECT * FROM abandoned_bookings WHERE name = ?', ['Deep Fixture Client']);
    check('ANONYMIZED: abandoned_bookings no longer matches the original name', !abandonedByOldName, '');

    const accessCodesAfter = await one('SELECT * FROM booking_access_codes WHERE booking_id = ?', [bookingId]);
    check('ANONYMIZED: booking_access_codes hard-deleted', !accessCodesAfter, '');
    const accessTokensAfter = await one('SELECT * FROM booking_access_tokens WHERE booking_id = ?', [bookingId]);
    check('ANONYMIZED: booking_access_tokens hard-deleted', !accessTokensAfter, '');

    const emailLogAfter = await one('SELECT * FROM email_logs WHERE id = ?', [emailLogIns.lastID]);
    check('ANONYMIZED: email_logs recipient + subject anonymized', !!emailLogAfter && emailLogAfter.recipient_email === 'deleted@po-pia.com' && emailLogAfter.subject === '[DELETED]', JSON.stringify(emailLogAfter));

    const reminderAfter = await one('SELECT * FROM reminders_log WHERE booking_id = ?', [bookingId]);
    check('ANONYMIZED: reminders_log recipient anonymized', reminderAfter.recipient_email === 'deleted@po-pia.com', JSON.stringify(reminderAfter));

    const notifAfter = await one('SELECT * FROM notifications WHERE id = ?', [notifIns.lastID]);
    check('ANONYMIZED: notifications recipient/subject/body anonymized', !!notifAfter && notifAfter.recipient_email === 'deleted@po-pia.com' && notifAfter.subject === '[DELETED]' && notifAfter.body === '[DELETED]', JSON.stringify(notifAfter));

    const venueAfter = await one("SELECT * FROM venues WHERE name = 'Fixture Venue'");
    check('ANONYMIZED: venue contact fields nulled', venueAfter.contact_name === null && venueAfter.contact_email === null, JSON.stringify(venueAfter));

    const directEmailAfter = await one('SELECT * FROM direct_emails WHERE inquiry_id = ?', [inquiryRow.inquiry_id]);
    check('ANONYMIZED: direct_emails to_emails redacted', directEmailAfter.to_emails === 'deleted@po-pia.com', JSON.stringify(directEmailAfter));

    // ── Retained/untouched controls ──
    const invoiceAfter = await one('SELECT * FROM invoices WHERE booking_id = ?', [bookingId]);
    check('RETAINED: invoice fully untouched (SARS)', !!invoiceAfter && Number(invoiceAfter.total_amount) === 1000 && invoiceAfter.client_id === clientId, JSON.stringify(invoiceAfter));

    const consentAfter = await one('SELECT * FROM consent_audit WHERE booking_id = ?', [bookingId]);
    check('RETAINED: consent_audit untouched', !!consentAfter && consentAfter.ip_address === '10.0.0.4', JSON.stringify(consentAfter));

    const auditRow = await one("SELECT * FROM audit_log WHERE table_name = 'popia_erasure_requests' AND record_id = ? AND action = 'DATA_ANONYMIZATION'", [req2Row.id]);
    check('AUDIT: DATA_ANONYMIZATION audit_log row exists with the correct record_id', !!auditRow, JSON.stringify(auditRow));

    // ── No orphaned FKs: the invoice's client_id/booking_id still resolve (rows updated in place, never deleted) ──
    const clientStillExists = await one('SELECT id FROM clients WHERE id = ?', [clientId]);
    check('NO ORPHANS: invoice client_id still resolves to a client row', !!clientStillExists, '');
    const bookingStillExists = await one('SELECT id FROM bookings WHERE id = ?', [bookingId]);
    check('NO ORPHANS: invoice booking_id still resolves to a booking row', !!bookingStillExists, '');

    // ── Double-processing guard ──
    const secondProcess = await api('POST', `/api/admin/popia/requests/${req2Row.id}/process`);
    check('CAS: double-process on an already-processed request -> 409', secondProcess.status === 409, JSON.stringify(secondProcess.body));

    const clientStillAnonymized = await one('SELECT * FROM clients WHERE id = ?', [clientId]);
    check('CAS: client row unchanged after the rejected second process attempt', clientStillAnonymized.full_name === 'POPIA ANONYMIZED', '');

    // ═══════════════════════════════════════════════════════════════════════════════════════
    // Booking cancellation + refund-gated completion (awaiting_refund)
    // ═══════════════════════════════════════════════════════════════════════════════════════
    const testEmail5 = email();

    // bookingA: CONFIRMED, partially paid, far enough out that any sane retention policy leaves a
    // real refund owing — this is the one that should get cancelled and block completion. Linked to
    // a real `events` row with a Google Calendar id, so the fuller cascade (demote + null both
    // calendar-id columns) can be verified, not just the slimmer public-self-cancel shape.
    const bookingAIns = await run(
        `INSERT INTO bookings (name, company, email, cell, event_name, date, event_location, event_type, message, status, total_amount, amount_paid, google_event_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        ['Refund Fixture Client', null, testEmail5, '0827654321', 'Refund Fixture Event', support.future(60), 'Test Venue', 'Corporate', 'Refund gating fixture booking.', 'CONFIRMED', 2000, 1000, 'fake-google-event-id-A']
    );
    const bookingAId = bookingAIns.lastID;
    const eventAIns = await run(
        `INSERT INTO events (event_title, event_datetime, event_status, booking_id, google_calendar_event_id) VALUES (?,?,?,?,?)`,
        ['Refund Fixture Event', support.future(60), 'upcoming', bookingAId, 'fake-google-calendar-id-A']
    );
    const eventAId = eventAIns.lastID;

    // bookingB: COMPLETED with real money on it — must NOT be cancelled or gain a cancellations row.
    const bookingBIns = await run(
        `INSERT INTO bookings (name, company, email, cell, event_name, date, event_location, event_type, message, status, total_amount, amount_paid)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        ['Refund Fixture Client', null, testEmail5, '0827654321', 'Past Delivered Event', support.future(-30), 'Test Venue', 'Corporate', 'Already delivered, fully paid.', 'COMPLETED', 5000, 5000]
    );
    const bookingBId = bookingBIns.lastID;

    // bookingC: already CANCELLED independently, before this erasure request even existed, with its
    // own still-unresolved refund — proves the gate scans ALL of the email's bookings, not just the
    // ones this run cancels.
    const bookingCIns = await run(
        `INSERT INTO bookings (name, company, email, cell, event_name, date, event_location, event_type, message, status, total_amount, amount_paid)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        ['Refund Fixture Client', null, testEmail5, '0827654321', 'Independently Cancelled Event', support.future(-5), 'Test Venue', 'Corporate', 'Cancelled before the erasure request.', 'CANCELLED', 300, 300]
    );
    const bookingCId = bookingCIns.lastID;
    await run(`INSERT INTO cancellations (booking_id, cancelled_by, reason, total_paid_to_date, refund_due, retention_amount, refund_status) VALUES (?,?,?,?,?,?,?)`,
        [bookingCId, 'client', 'Pre-existing unrelated cancellation.', 300, 300, 0, 'pending']);

    const testEmail5Otp = await getPopiaOtpCode(testEmail5);
    const req5 = await pub('POST', '/api/public/popia/erasure-requests', { email: testEmail5, otp_code: testEmail5Otp, reason: 'privacy_concerns', consequences_acknowledged: true });
    check('refund-gate fixture: public submit -> 200', req5.status === 200 && req5.body.success, JSON.stringify(req5.body));
    const req5Row = await one('SELECT id FROM popia_erasure_requests WHERE email = ?', [testEmail5]);

    const preview5 = await api('GET', `/api/admin/popia/requests/${req5Row.id}`);
    check('refund-gate: booking_impact lists only bookingA (CONFIRMED, in scope)', preview5.body.booking_impact.length === 1 && preview5.body.booking_impact[0].booking_id === bookingAId && preview5.body.booking_impact[0].estimated_refund_due > 0, JSON.stringify(preview5.body.booking_impact));

    await api('PUT', `/api/admin/popia/requests/${req5Row.id}/approve`);
    const process5 = await api('POST', `/api/admin/popia/requests/${req5Row.id}/process`);
    check('refund-gate: process lands at awaiting_refund (money still owed)', process5.status === 200 && process5.body.success && process5.body.awaiting_refund === true, JSON.stringify(process5.body));
    check('refund-gate: pending_booking_ids includes both bookingA (new) and bookingC (pre-existing)', Array.isArray(process5.body.pending_booking_ids) && process5.body.pending_booking_ids.includes(bookingAId) && process5.body.pending_booking_ids.includes(bookingCId), JSON.stringify(process5.body.pending_booking_ids));

    const req5AfterProcess = await one('SELECT status FROM popia_erasure_requests WHERE id = ?', [req5Row.id]);
    check('DB: request status is awaiting_refund', req5AfterProcess.status === 'awaiting_refund', JSON.stringify(req5AfterProcess));

    // Regression: the admin detail endpoint must show the ALREADY-cancelled booking's real
    // cancellation record here — bookingA's status is now 'CANCELLED', which the hypothetical
    // getBookingErasureImpact() preview (used for pending/approved requests) would treat as out of
    // scope and silently return empty for, leaving the drawer's "Booking Impact" card blank.
    const detailAwaitingRefund = await api('GET', `/api/admin/popia/requests/${req5Row.id}`);
    check('admin detail (awaiting_refund): booking_impact is NOT empty and includes bookingA', detailAwaitingRefund.body.booking_impact.length >= 1 && detailAwaitingRefund.body.booking_impact.some(b => b.booking_id === bookingAId), JSON.stringify(detailAwaitingRefund.body.booking_impact));
    check('admin detail (awaiting_refund): pending_refund_booking_ids includes both bookingA and bookingC', detailAwaitingRefund.body.pending_refund_booking_ids.includes(bookingAId) && detailAwaitingRefund.body.pending_refund_booking_ids.includes(bookingCId), JSON.stringify(detailAwaitingRefund.body.pending_refund_booking_ids));

    const bookingAAfter = await one('SELECT * FROM bookings WHERE id = ?', [bookingAId]);
    check('CANCELLED: bookingA status flipped to CANCELLED, google_event_id nulled', bookingAAfter.status === 'CANCELLED' && bookingAAfter.google_event_id === null, JSON.stringify(bookingAAfter));
    check('NOT YET ANONYMIZED: bookingA name/email still intact (anonymization deferred until refund resolved)', bookingAAfter.name === 'Refund Fixture Client' && bookingAAfter.email === testEmail5, JSON.stringify(bookingAAfter));

    const cancelAAfter = await one('SELECT * FROM cancellations WHERE booking_id = ?', [bookingAId]);
    check('CANCELLED: bookingA has a cancellations row with a real positive refund_due', !!cancelAAfter && cancelAAfter.refund_status === 'pending' && Number(cancelAAfter.refund_due) > 0, JSON.stringify(cancelAAfter));

    const eventAAfter = await one('SELECT * FROM events WHERE event_id = ?', [eventAId]);
    check('CANCELLED: linked events row demoted, unlinked, calendar id nulled', eventAAfter.event_status === 'draft' && eventAAfter.booking_id === null && eventAAfter.google_calendar_event_id === null, JSON.stringify(eventAAfter));

    const bookingBAfter = await one('SELECT * FROM bookings WHERE id = ?', [bookingBId]);
    check('NOT TOUCHED: COMPLETED bookingB (with money owed) stays COMPLETED', bookingBAfter.status === 'COMPLETED', JSON.stringify(bookingBAfter));
    const cancelBAfter = await one('SELECT * FROM cancellations WHERE booking_id = ?', [bookingBId]);
    check('NOT TOUCHED: COMPLETED bookingB never gets a cancellations row', !cancelBAfter, '');

    const cancelCAfter = await one('SELECT * FROM cancellations WHERE booking_id = ?', [bookingCId]);
    check('UNTOUCHED BY CANCELLATION STEP: bookingC (already CANCELLED) cancellations row unchanged', cancelCAfter.refund_due === 300 && cancelCAfter.reason === 'Pre-existing unrelated cancellation.', JSON.stringify(cancelCAfter));

    // ── complete-anonymization: 409 while refunds are outstanding, RBAC, then succeeds once resolved ──
    const completeTooEarly = await api('POST', `/api/admin/popia/requests/${req5Row.id}/complete-anonymization`);
    check('complete-anonymization: 409 while bookingA + bookingC refunds are both outstanding', completeTooEarly.status === 409, JSON.stringify(completeTooEarly.body));

    const assistantApi5 = await loginAs('assistant');
    const assistantComplete = await assistantApi5('POST', `/api/admin/popia/requests/${req5Row.id}/complete-anonymization`);
    check('RBAC: assistant blocked from complete-anonymization -> 403', assistantComplete.status === 403, String(assistantComplete.status));
    const managerApi5 = await loginAs('manager');
    const managerComplete = await managerApi5('POST', `/api/admin/popia/requests/${req5Row.id}/complete-anonymization`);
    check('RBAC: manager blocked from complete-anonymization -> 403', managerComplete.status === 403, String(managerComplete.status));

    // Resolve bookingA's refund only — bookingC's is still outstanding, so the gate must still hold.
    const refundA = await api('PUT', `/api/admin/bookings/${bookingAId}/refund`, {
        refund_amount: cancelAAfter.refund_due, refund_reference: 'TEST-REF-A', notes: 'Test refund for bookingA'
    });
    check('refund route: recording bookingA refund -> 200', refundA.status === 200 && refundA.body.success, JSON.stringify(refundA.body));

    // Regression: pending_refund_booking_ids must be re-derived from current reality (actual
    // refunded-so-far vs refund_due), not echoed from the stale snapshot stored when processing
    // first ran — otherwise the admin UI's "Complete Anonymization" button stays disabled forever
    // even after the refund has been recorded.
    const detailAfterPartialRefund = await api('GET', `/api/admin/popia/requests/${req5Row.id}`);
    check('admin detail: pending_refund_booking_ids drops bookingA (refunded) but keeps bookingC (not yet)', !detailAfterPartialRefund.body.pending_refund_booking_ids.includes(bookingAId) && detailAfterPartialRefund.body.pending_refund_booking_ids.includes(bookingCId), JSON.stringify(detailAfterPartialRefund.body.pending_refund_booking_ids));

    const completeStillBlocked = await api('POST', `/api/admin/popia/requests/${req5Row.id}/complete-anonymization`);
    check('complete-anonymization: still 409 — bookingC refund still outstanding', completeStillBlocked.status === 409, JSON.stringify(completeStillBlocked.body));

    const refundC = await api('PUT', `/api/admin/bookings/${bookingCId}/refund`, {
        refund_amount: 300, refund_reference: 'TEST-REF-C', notes: 'Test refund for pre-existing bookingC'
    });
    check('refund route: recording bookingC refund -> 200', refundC.status === 200 && refundC.body.success, JSON.stringify(refundC.body));

    const completeNow = await api('POST', `/api/admin/popia/requests/${req5Row.id}/complete-anonymization`);
    check('complete-anonymization: succeeds once every refund is resolved', completeNow.status === 200 && completeNow.body.success && completeNow.body.affected, JSON.stringify(completeNow.body).slice(0, 300));

    const req5Final = await one('SELECT status FROM popia_erasure_requests WHERE id = ?', [req5Row.id]);
    check('DB: request finally reaches processed', req5Final.status === 'processed', JSON.stringify(req5Final));

    const bookingAFinal = await one('SELECT * FROM bookings WHERE id = ?', [bookingAId]);
    check('ANONYMIZED (deferred): bookingA name/email now scrubbed', bookingAFinal.name === 'POPIA ANONYMIZED' && bookingAFinal.email === `deleted-${bookingAId}@po-pia.com`, JSON.stringify(bookingAFinal));

    const auditRow5 = await one("SELECT * FROM audit_log WHERE table_name = 'popia_erasure_requests' AND record_id = ? AND action = 'DATA_ANONYMIZATION'", [req5Row.id]);
    check('AUDIT: DATA_ANONYMIZATION row exists for the deferred-completion request', !!auditRow5, '');

    // ── RBAC (general) ──
    const testEmail3 = email();
    const testEmail3Otp = await getPopiaOtpCode(testEmail3);
    await pub('POST', '/api/public/popia/erasure-requests', { email: testEmail3, otp_code: testEmail3Otp, reason: 'privacy_concerns', consequences_acknowledged: true });
    const req3Row = await one('SELECT id FROM popia_erasure_requests WHERE email = ?', [testEmail3]);

    const assistantApi = await loginAs('assistant');
    const assistantApprove = await assistantApi('PUT', `/api/admin/popia/requests/${req3Row.id}/approve`);
    check('RBAC: assistant blocked from approving -> 403', assistantApprove.status === 403, String(assistantApprove.status));
    const assistantReject = await assistantApi('PUT', `/api/admin/popia/requests/${req3Row.id}/reject`, { review_notes: 'x' });
    check('RBAC: assistant blocked from rejecting -> 403', assistantReject.status === 403, String(assistantReject.status));
    const assistantExport = await assistantApi('GET', '/api/admin/popia/requests/export');
    check('RBAC: assistant blocked from export -> 403', assistantExport.status === 403, String(assistantExport.status));
    const assistantList = await assistantApi('GET', '/api/admin/popia/requests');
    check('RBAC: assistant CAN list requests -> 200', assistantList.status === 200, String(assistantList.status));

    const managerApi = await loginAs('manager');
    const managerApprove = await managerApi('PUT', `/api/admin/popia/requests/${req3Row.id}/approve`);
    check('RBAC: manager blocked from approving -> 403', managerApprove.status === 403, String(managerApprove.status));
    const managerProcess = await managerApi('POST', `/api/admin/popia/requests/${req3Row.id}/process`);
    check('RBAC: manager blocked from processing -> 403', managerProcess.status === 403, String(managerProcess.status));
    const managerExport = await managerApi('GET', '/api/admin/popia/requests/export');
    check('RBAC: manager CAN export -> 200', managerExport.status === 200, String(managerExport.status));

    // Administrator cleans up req3 so it doesn't dangle.
    await api('PUT', `/api/admin/popia/requests/${req3Row.id}/approve`);
    await api('POST', `/api/admin/popia/requests/${req3Row.id}/process`);

    // ── Legacy /api/admin/gdpr/delete compatibility wrapper ──
    const testEmail4 = email();
    await run(`INSERT INTO clients (full_name, email, phone) VALUES (?,?,?)`, ['Legacy Client', testEmail4, '0821112222']);
    const legacyRes = await api('POST', '/api/admin/gdpr/delete', { email: testEmail4 });
    check('legacy /gdpr/delete: 200, success, reference_number', legacyRes.status === 200 && legacyRes.body.success && !!legacyRes.body.reference_number, JSON.stringify(legacyRes.body));

    const legacyRequestRow = await one('SELECT * FROM popia_erasure_requests WHERE email = ?', [testEmail4]);
    check('legacy /gdpr/delete: produced a source=admin, status=processed request row', !!legacyRequestRow && legacyRequestRow.source === 'admin' && legacyRequestRow.status === 'processed', JSON.stringify(legacyRequestRow));

    const legacyClientAfter = await one('SELECT full_name, email, phone FROM clients WHERE full_name = ? AND phone = ? ORDER BY id DESC LIMIT 1', ['POPIA ANONYMIZED', '0000000000']);
    check('legacy /gdpr/delete: client actually anonymized', !!legacyClientAfter, JSON.stringify(legacyClientAfter));

    // ── Legacy /api/admin/gdpr/delete correctly reports awaiting_refund instead of false success ──
    const testEmail6 = email();
    const bookingDIns = await run(
        `INSERT INTO bookings (name, company, email, cell, event_name, date, event_location, event_type, message, status, total_amount, amount_paid)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        ['Legacy Refund Client', null, testEmail6, '0821112223', 'Legacy Refund Event', support.future(60), 'Test Venue', 'Corporate', 'Legacy gdpr/delete refund-gating fixture.', 'CONFIRMED', 2000, 1000]
    );
    const legacyRefundRes = await api('POST', '/api/admin/gdpr/delete', { email: testEmail6 });
    check('legacy /gdpr/delete: reports awaiting_refund instead of claiming full success', legacyRefundRes.status === 200 && legacyRefundRes.body.success && legacyRefundRes.body.awaiting_refund === true, JSON.stringify(legacyRefundRes.body));
    const bookingDAfter = await one('SELECT status FROM bookings WHERE id = ?', [bookingDIns.lastID]);
    check('legacy /gdpr/delete: the booking was still actually cancelled', bookingDAfter.status === 'CANCELLED', JSON.stringify(bookingDAfter));
};
