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

    // ── CP7: assignment ──
    const assignableRes = await api('GET', '/api/admin/inquiries/assignable-admins');
    check('CP7: assignable-admins returns active admin roster', assignableRes.status === 200 && assignableRes.body.success && Array.isArray(assignableRes.body.admins) && assignableRes.body.admins.length > 0, JSON.stringify(assignableRes.body));

    const managerRow = await one("SELECT id FROM admins WHERE username = 'test.manager@example.invalid'");
    const managerId = managerRow && managerRow.id;

    const asstAssign = await asAssistant('PUT', `/api/admin/inquiries/${inquiryId}/assign`, { assigned_to: managerId });
    check('CP7: assistant blocked from assigning an inquiry -> 403', asstAssign.status === 403, JSON.stringify(asstAssign.body));

    const badAssign = await asManager('PUT', `/api/admin/inquiries/${inquiryId}/assign`, { assigned_to: 999999 });
    check('CP7: assign rejects a nonexistent admin id -> 400', badAssign.status === 400 && badAssign.body.success === false, JSON.stringify(badAssign.body));

    const goodAssign = await asManager('PUT', `/api/admin/inquiries/${inquiryId}/assign`, { assigned_to: managerId });
    check('CP7: manager can assign an inquiry to an active admin -> 200', goodAssign.status === 200 && goodAssign.body.success, JSON.stringify(goodAssign.body));

    const afterAssign = await one("SELECT assigned_to, assigned_at, assigned_to_name FROM (SELECT inquiries.*, admins.full_name AS assigned_to_name FROM inquiries LEFT JOIN admins ON admins.id = inquiries.assigned_to) WHERE inquiry_id = ?", [inquiryId]);
    check('CP7: assigned_to/assigned_at persisted', !!afterAssign && afterAssign.assigned_to === managerId && !!afterAssign.assigned_at, JSON.stringify(afterAssign));

    const mineList = await asManager('GET', '/api/admin/inquiries?mine=1');
    check('CP7: GET ?mine=1 returns the newly-assigned inquiry with assigned_to_name', mineList.status === 200 && mineList.body.inquiries.some(r => r.inquiry_id === inquiryId && !!r.assigned_to_name), JSON.stringify(mineList.body.inquiries.map(r => ({ id: r.inquiry_id, name: r.assigned_to_name }))));

    const unassign = await asManager('PUT', `/api/admin/inquiries/${inquiryId}/assign`, { assigned_to: null });
    check('CP7: assign with null clears assignment -> 200', unassign.status === 200 && unassign.body.success, JSON.stringify(unassign.body));
    const afterUnassign = await one("SELECT assigned_to, assigned_at FROM inquiries WHERE inquiry_id = ?", [inquiryId]);
    check('CP7: assigned_to/assigned_at cleared to NULL', !!afterUnassign && afterUnassign.assigned_to === null && afterUnassign.assigned_at === null, JSON.stringify(afterUnassign));

    // ── CP8: priority ──
    let priorityTriggerRejected = false;
    try { await run("UPDATE inquiries SET priority = 'critical' WHERE inquiry_id = ?", [inquiryId]); }
    catch (e) { priorityTriggerRejected = /Invalid inquiries\.priority/.test(e.message); }
    check('CP8: BEFORE UPDATE trigger rejects invalid priority', priorityTriggerRejected, 'expected RAISE(ABORT) from chk_inquiries_priority_update');

    const defaultPriority = await one("SELECT priority FROM inquiries WHERE inquiry_id = ?", [inquiryId]);
    check('CP8: new inquiries default to normal priority', !!defaultPriority && defaultPriority.priority === 'normal', JSON.stringify(defaultPriority));

    const asstPriority = await asAssistant('PUT', `/api/admin/inquiries/${inquiryId}/priority`, { priority: 'high' });
    check('CP8: assistant blocked from changing priority -> 403', asstPriority.status === 403, JSON.stringify(asstPriority.body));

    const badPriority = await asManager('PUT', `/api/admin/inquiries/${inquiryId}/priority`, { priority: 'critical' });
    check('CP8: route rejects invalid priority enum -> 400', badPriority.status === 400 && badPriority.body.success === false, JSON.stringify(badPriority.body));

    const goodPriority = await asManager('PUT', `/api/admin/inquiries/${inquiryId}/priority`, { priority: 'urgent' });
    check('CP8: manager can set a valid priority -> 200', goodPriority.status === 200 && goodPriority.body.success, JSON.stringify(goodPriority.body));

    const afterPriority = await one("SELECT priority FROM inquiries WHERE inquiry_id = ?", [inquiryId]);
    check('CP8: priority persisted', !!afterPriority && afterPriority.priority === 'urgent', JSON.stringify(afterPriority));

    const byPriority = await api('GET', '/api/admin/inquiries?priority=urgent');
    check('CP8: priority filter returns only matching rows', byPriority.status === 200 && byPriority.body.inquiries.length > 0 && byPriority.body.inquiries.every(r => r.priority === 'urgent'), JSON.stringify(byPriority.body.inquiries.map(r => r.priority)));

    // ── CP9: internal notes (not manager+-gated, mirrors booking_notes) ──
    const emptyNotes = await api('GET', `/api/admin/inquiries/${inquiryId}/notes`);
    check('CP9: GET notes -> 200 empty list initially', emptyNotes.status === 200 && emptyNotes.body.success && Array.isArray(emptyNotes.body.notes) && emptyNotes.body.notes.length === 0, JSON.stringify(emptyNotes.body));

    const emptyNote = await api('POST', `/api/admin/inquiries/${inquiryId}/notes`, { note: '   ' });
    check('CP9: empty/whitespace-only note rejected -> 400', emptyNote.status === 400 && emptyNote.body.success === false, JSON.stringify(emptyNote.body));

    const asstNote = await asAssistant('POST', `/api/admin/inquiries/${inquiryId}/notes`, { note: 'Assistant left a note.' });
    check('CP9: assistant CAN add a note (not manager+-gated)', asstNote.status === 200 && asstNote.body.success && asstNote.body.note && asstNote.body.note.author === 'test.assistant@example.invalid', JSON.stringify(asstNote.body));
    const asstNoteId = asstNote.body && asstNote.body.note && asstNote.body.note.id;
    check('CP9: note author derives from session, not client input', asstNote.body.note.author !== 'Client Supplied Name', JSON.stringify(asstNote.body.note));

    const mgrNote = await asManager('POST', `/api/admin/inquiries/${inquiryId}/notes`, { note: 'Manager follow-up note.' });
    check('CP9: manager can add a note -> 200', mgrNote.status === 200 && mgrNote.body.success, JSON.stringify(mgrNote.body));

    const listNotes = await api('GET', `/api/admin/inquiries/${inquiryId}/notes`);
    check('CP9: notes list returns both notes, oldest first', listNotes.status === 200 && listNotes.body.notes.length === 2 && listNotes.body.notes[0].id === asstNoteId, JSON.stringify(listNotes.body.notes));

    if (asstNoteId) {
        const delOther = await api('DELETE', `/api/admin/inquiries/${inquiryId}/notes/999999`);
        check('CP9: delete nonexistent note -> 404', delOther.status === 404, JSON.stringify(delOther.body));

        const delNote = await asAssistant('DELETE', `/api/admin/inquiries/${inquiryId}/notes/${asstNoteId}`);
        check('CP9: assistant can delete a note (not manager+-gated) -> 200', delNote.status === 200 && delNote.body.success, JSON.stringify(delNote.body));

        const afterDelete = await api('GET', `/api/admin/inquiries/${inquiryId}/notes`);
        check('CP9: deleted note no longer present', afterDelete.status === 200 && afterDelete.body.notes.length === 1 && !afterDelete.body.notes.some(n => n.id === asstNoteId), JSON.stringify(afterDelete.body.notes));
    }

    // ── CP10: tags (reuse category), not manager+-gated ──
    const categoriesBefore = await api('GET', '/api/admin/inquiries/categories');
    check('CP10: categories endpoint returns distinct values incl. General', categoriesBefore.status === 200 && categoriesBefore.body.success && categoriesBefore.body.categories.includes('General'), JSON.stringify(categoriesBefore.body));

    const asstCategory = await asAssistant('PUT', `/api/admin/inquiries/${inquiryId}/category`, { category: 'Corporate Event' });
    check('CP10: assistant CAN edit category (not manager+-gated) -> 200', asstCategory.status === 200 && asstCategory.body.success, JSON.stringify(asstCategory.body));

    const afterCategory = await one("SELECT category FROM inquiries WHERE inquiry_id = ?", [inquiryId]);
    check('CP10: category persisted', !!afterCategory && afterCategory.category === 'Corporate Event', JSON.stringify(afterCategory));

    const categoriesAfter = await api('GET', '/api/admin/inquiries/categories');
    check('CP10: new category value appears in the distinct list', categoriesAfter.status === 200 && categoriesAfter.body.categories.includes('Corporate Event'), JSON.stringify(categoriesAfter.body.categories));

    const clearCategory = await api('PUT', `/api/admin/inquiries/${inquiryId}/category`, { category: '' });
    check('CP10: empty category clears to NULL -> 200', clearCategory.status === 200 && clearCategory.body.success, JSON.stringify(clearCategory.body));
    const afterClear = await one("SELECT category FROM inquiries WHERE inquiry_id = ?", [inquiryId]);
    check('CP10: category cleared to NULL', !!afterClear && afterClear.category === null, JSON.stringify(afterClear));
};
