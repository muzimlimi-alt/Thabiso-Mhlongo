// Coverage for the #inquiriesAdmin overhaul: DB-level status trigger + audit trail (CP1), POPIA
// compliance fixes (CP2), endpoint consistency/validation (CP3), RBAC scoping of status-change and
// inquiry-linked email sends to administrator/manager (CP6). CP7-CP12 (CRM fields) are appended as
// they land.
const support = require('./support');
const { api, pub, one, loginAs } = support;
const sqlite3 = require('sqlite3');

// Direct read-write handle to the isolated TEST_DB, so the DB-level trigger can be asserted
// independently of the route-level validation that duplicates the same rule.
const rw = new sqlite3.Database(support.TEST_DB);
const run = (sql, params = []) => new Promise((res, rej) => rw.run(sql, params, function (e) { e ? rej(e) : res(this); }));

module.exports = async function ({ check }) {
    // ── Seed a real inquiry via the public contact endpoint ──
    const senderEmail = 'inq.test.sender@example.invalid';
    const submit = await pub('POST', '/send-email', {
        name: 'Inq Test Sender', email: senderEmail, message: 'Hello, testing inquiries.',
        subject: 'Test Subject', category: 'General', popia_consent: true,
    });
    check('seed: public inquiry submitted -> 200', submit.status === 200 && submit.body.success, JSON.stringify(submit.body));

    const seeded = await one("SELECT * FROM inquiries WHERE sender_email = ? ORDER BY inquiry_id DESC LIMIT 1", [senderEmail]);
    check('seed: inquiry row exists with status unread', !!seeded && seeded.status === 'unread', JSON.stringify(seeded));
    const inquiryId = seeded && seeded.inquiry_id;

    // ── CP1: DB-level status trigger rejects invalid values ──
    let triggerRejected = false;
    try { await run("UPDATE inquiries SET status = 'bogus_status' WHERE inquiry_id = ?", [inquiryId]); }
    catch (e) { triggerRejected = /Invalid inquiries\.status/.test(e.message); }
    check('CP1: BEFORE UPDATE trigger rejects invalid status', triggerRejected, 'expected RAISE(ABORT) from chk_inquiries_status_update');

    // ── CP1: audit_log row written on insert ──
    const auditInsert = await one("SELECT * FROM audit_log WHERE table_name = 'inquiries' AND record_id = ? AND action = 'INSERT'", [inquiryId]);
    check('CP1: audit_log INSERT row written for new inquiry', !!auditInsert, JSON.stringify(auditInsert));

    // ── CP3: route-level status validation + envelope shape ──
    const badStatus = await api('PUT', `/api/admin/inquiries/${inquiryId}/status`, { status: 'not_a_real_status' });
    check('CP3: PUT .../status rejects invalid enum -> 400 {success:false}', badStatus.status === 400 && badStatus.body.success === false, JSON.stringify(badStatus.body));

    const goodStatus = await api('PUT', `/api/admin/inquiries/${inquiryId}/status`, { status: 'read' });
    check('CP3: PUT .../status accepts valid enum -> 200 {success:true}', goodStatus.status === 200 && goodStatus.body.success === true, JSON.stringify(goodStatus.body));

    // ── CP1: audit_log row written on update ──
    const auditUpdate = await one("SELECT * FROM audit_log WHERE table_name = 'inquiries' AND record_id = ? AND action = 'UPDATE' ORDER BY id DESC LIMIT 1", [inquiryId]);
    check('CP1: audit_log UPDATE row written on status change', !!auditUpdate, JSON.stringify(auditUpdate));

    // ── CP3: category filter + bounded limit ──
    const byCategory = await api('GET', `/api/admin/inquiries?category=${encodeURIComponent('General')}`);
    check('CP3: category filter returns only matching rows', byCategory.status === 200 && byCategory.body.inquiries.length > 0 && byCategory.body.inquiries.every(r => r.category === 'General'), JSON.stringify(byCategory.body.inquiries.map(r => r.category)));

    const clampedLimit = await api('GET', '/api/admin/inquiries?limit=9999');
    check('CP3: limit is clamped to <=100', clampedLimit.status === 200 && clampedLimit.body.inquiries.length <= 100, clampedLimit.body.inquiries.length);

    // ── CP3: dead legacy reply endpoint removed ──
    const deadReply = await api('POST', `/api/admin/inquiries/${inquiryId}/reply`, { replyMessage: 'x' });
    check('CP3: legacy POST .../reply endpoint removed (404)', deadReply.status === 404, deadReply.status);

    // ── CP2: POPIA request-forget actually anonymizes real columns ──
    const forgetEmail = 'popia.forget.target@example.invalid';
    const forgetSubmit = await pub('POST', '/send-email', {
        name: 'Forget Me', email: forgetEmail, message: 'please forget me', subject: 'POPIA test', category: 'General', popia_consent: true,
    });
    check('seed: second inquiry for POPIA forget test -> 200', forgetSubmit.status === 200 && forgetSubmit.body.success, JSON.stringify(forgetSubmit.body));

    const forgetReq = await pub('POST', '/api/public/compliance/request-forget', { email: forgetEmail });
    check('CP2: request-forget -> 200 success', forgetReq.status === 200 && forgetReq.body.success, JSON.stringify(forgetReq.body));

    const afterForget = await one("SELECT sender_email, sender_name FROM inquiries WHERE sender_name = '[FORGOTTEN]' AND sender_email = 'deleted@po-pia.com' ORDER BY inquiry_id DESC LIMIT 1");
    check('CP2: request-forget actually anonymized sender_name/sender_email (real columns, not stale name/email)', !!afterForget, JSON.stringify(afterForget));

    // ── CP2: POPIA export-data returns the caller's inquiry history ──
    const exportEmail = 'popia.export.target@example.invalid';
    await pub('POST', '/send-email', { name: 'Export Me', email: exportEmail, message: 'export test', subject: 'Export test', category: 'General', popia_consent: true });
    const exportReq = await pub('POST', '/api/public/compliance/export-data', { email: exportEmail });
    check('CP2: export-data includes this inquiry (not silently empty from stale column query)',
        exportReq.status === 200 && Array.isArray(exportReq.body.data && exportReq.body.data.inquiries) && exportReq.body.data.inquiries.some(i => i.sender_email === exportEmail),
        JSON.stringify(exportReq.body.data && exportReq.body.data.inquiries));

    // ── CP6: RBAC — administrator/manager can change status & send inquiry-linked email; assistant cannot ──
    const asManager = await loginAs('manager');
    const asAssistant = await loginAs('assistant');

    const mgrStatus = await asManager('PUT', `/api/admin/inquiries/${inquiryId}/status`, { status: 'archived' });
    check('CP6: manager can change inquiry status -> 200', mgrStatus.status === 200 && mgrStatus.body.success, JSON.stringify(mgrStatus.body));

    const asstStatus = await asAssistant('PUT', `/api/admin/inquiries/${inquiryId}/status`, { status: 'read' });
    check('CP6: assistant blocked from changing inquiry status -> 403', asstStatus.status === 403, JSON.stringify(asstStatus.body));

    const asstBulk = await asAssistant('PUT', '/api/admin/inquiries/bulk-status', { ids: [inquiryId], status: 'read' });
    check('CP6: assistant blocked from bulk-status -> 403', asstBulk.status === 403, JSON.stringify(asstBulk.body));

    // direct_emails: assistant blocked only when inquiry_id is set; freeform compose stays open
    const asstInquiryEmail = await asAssistant('POST', '/api/admin/direct-emails', { inquiry_id: inquiryId, to_emails: 'someone@example.invalid', subject: 'Re: test', body: 'reply body' });
    check('CP6: assistant blocked from creating an inquiry-linked email -> 403', asstInquiryEmail.status === 403, JSON.stringify(asstInquiryEmail.body));

    const asstFreeformEmail = await asAssistant('POST', '/api/admin/direct-emails', { to_emails: 'someone-else@example.invalid', subject: 'Freeform', body: 'freeform body' });
    check('CP6: assistant CAN create a freeform (non-inquiry) draft email -> 200', asstFreeformEmail.status === 200 && asstFreeformEmail.body.success, JSON.stringify(asstFreeformEmail.body));
    const freeformId = asstFreeformEmail.body && asstFreeformEmail.body.email && asstFreeformEmail.body.email.id;

    if (freeformId) {
        const asstFreeformUpdate = await asAssistant('PUT', `/api/admin/direct-emails/${freeformId}`, { to_emails: 'someone-else@example.invalid', subject: 'Freeform edited', body: 'freeform body edited' });
        check('CP6: assistant CAN update their own freeform draft -> 200', asstFreeformUpdate.status === 200 && asstFreeformUpdate.body.success, JSON.stringify(asstFreeformUpdate.body));
    }

    const mgrInquiryEmail = await asManager('POST', '/api/admin/direct-emails', { inquiry_id: inquiryId, to_emails: seeded.sender_email, subject: 'Re: test', body: 'manager reply body' });
    check('CP6: manager CAN create an inquiry-linked email -> 200', mgrInquiryEmail.status === 200 && mgrInquiryEmail.body.success, JSON.stringify(mgrInquiryEmail.body));
    const mgrEmailId = mgrInquiryEmail.body && mgrInquiryEmail.body.email && mgrInquiryEmail.body.email.id;

    if (mgrEmailId) {
        const asstSendInquiryEmail = await asAssistant('POST', `/api/admin/direct-emails/${mgrEmailId}/send`, {});
        check('CP6: assistant blocked from sending an inquiry-linked email even by id lookup -> 403', asstSendInquiryEmail.status === 403, JSON.stringify(asstSendInquiryEmail.body));
    }
};
