// Inquiries domain repository — Phase 4 of the housekeeping effort (HOUSEKEEPING-NOTES.md).
// Covers inquiries, inquiry_notes. Every SQL string below is byte-identical to where it lived in
// server.js before this move. No req/res, no email sending, no PDF generation, no calendar calls.
//
// One statement was deliberately NOT moved: GET /api/admin/inquiries' main data query does a real
// `FROM inquiries LEFT JOIN admins ON admins.id = inquiries.assigned_to` — a genuine cross-table
// join with the auth+users domain. Per the plan's rule, a statement touching another domain's
// table does not move; it stays in server.js. See HOUSEKEEPING-NOTES.md "Cross-domain statements".
const db = require('../../database');

function promised(sql, params) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function (err) { err ? reject(err) : resolve(this); });
    });
}
function promisedGet(sql, params) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => err ? reject(err) : resolve(row));
    });
}
function promisedAll(sql, params) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows));
    });
}

// ── Single statements extracted out of multi-domain functions (only this table's statement
// moved; the surrounding orchestration — newsletter/bookings/clients POPIA erasure, the
// direct_emails reply flow, the public contact-form's sibling `bookings` INSERT, etc. — stays in
// server.js exactly where it was) ──
function anonymizeOldInquiries(callback) {
    db.run(`UPDATE inquiries
            SET sender_name = '[ANONYMIZED]', sender_email = 'deleted@po-pia.com', sender_phone = '0000000000', message_body = '[REDACTED]'
            WHERE submitted_at < date('now', '-2 years') AND sender_email != 'deleted@po-pia.com'`, callback);
}
function getInquiryIdsForEmail(email) {
    return promisedAll(`SELECT inquiry_id FROM inquiries WHERE LOWER(sender_email) = LOWER(?)`, [email]);
}
function anonymizeInquiriesForErasure(email) {
    return promised(`UPDATE inquiries SET
            sender_name = 'POPIA ANONYMIZED', sender_email = 'deleted-' || inquiry_id || '@po-pia.com',
            sender_phone = '0000000000', message_body = 'Content removed per deletion request.'
            WHERE LOWER(sender_email) = LOWER(?)`, [email]);
}
function redactInquiryNotesForErasure(inquiryPh, inquiryIds) {
    return promised(`UPDATE inquiry_notes SET note = '[Redacted per POPIA erasure request]' WHERE inquiry_id IN (${inquiryPh})`, inquiryIds);
}
function countInquiryNotesForIds(inquiryPh, inquiryIds) {
    return promisedGet(`SELECT COUNT(*) AS c FROM inquiry_notes WHERE inquiry_id IN (${inquiryPh})`, inquiryIds);
}
function getInquiriesForEmail(email, callback) {
    db.all("SELECT * FROM inquiries WHERE LOWER(sender_email) = LOWER(?)", [email], callback);
}
function insertInquiry(sender_name, sender_email, receiver_email, sender_phone, category, subject, message_body, routing_path, ip_address, user_agent, callback) {
    db.run(`INSERT INTO inquiries (sender_name, sender_email, receiver_email, sender_phone, category, subject, message_body, status, routing_path, ip_address, user_agent, popia_consent, consent_timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, 'unread', ?, ?, ?, 1, CURRENT_TIMESTAMP)`,
        [sender_name, sender_email, receiver_email, sender_phone, category, subject, message_body, routing_path, ip_address, user_agent], callback);
}
// Caller (admin booking creation) already has an open transaction — this uses the same shared
// `db` connection, so it participates in that transaction unchanged.
function linkInquiryToBooking(bookingId, sourceInquiryId) {
    return promised("UPDATE inquiries SET converted_booking_id = ? WHERE inquiry_id = ?", [bookingId, sourceInquiryId]);
}
function markInquiryReplied(inquiryId) {
    db.run("UPDATE inquiries SET status = 'replied', responded_at = COALESCE(responded_at, CURRENT_TIMESTAMP) WHERE inquiry_id = ?", [inquiryId]);
}

// ── Admin inquiries list (the join-bearing data query stays in server.js — see file header) ──
function countInquiries(whereClause, qp, callback) {
    db.get(`SELECT COUNT(*) AS total FROM inquiries ${whereClause}`, qp, callback);
}
function countInquiriesByStatus(callback) {
    db.all("SELECT status, COUNT(*) AS c FROM inquiries GROUP BY status", [], callback);
}
function countMyInquiries(adminId, callback) {
    db.get("SELECT COUNT(*) AS c FROM inquiries WHERE assigned_to = ?", [adminId], callback);
}

// ── Status / assign / priority / category ──
function updateInquiryStatus(status, id, callback) {
    db.run("UPDATE inquiries SET status = ? WHERE inquiry_id = ?", [status, id], callback);
}
function unassignInquiry(adminId, role, id, callback) {
    db.run("UPDATE inquiries SET assigned_to = NULL, assigned_at = NULL, updated_by = ?, updated_by_role = ?, updated_at = CURRENT_TIMESTAMP WHERE inquiry_id = ?", [adminId, role, id], callback);
}
function assignInquiry(targetId, adminId, role, id, callback) {
    db.run("UPDATE inquiries SET assigned_to = ?, assigned_at = CURRENT_TIMESTAMP, updated_by = ?, updated_by_role = ?, updated_at = CURRENT_TIMESTAMP WHERE inquiry_id = ?", [targetId, adminId, role, id], callback);
}
function updateInquiryPriority(priority, adminId, role, id, callback) {
    db.run("UPDATE inquiries SET priority = ?, updated_by = ?, updated_by_role = ?, updated_at = CURRENT_TIMESTAMP WHERE inquiry_id = ?", [priority, adminId, role, id], callback);
}
function listInquiryCategories(callback) {
    db.all("SELECT DISTINCT category FROM inquiries WHERE category IS NOT NULL AND category != '' ORDER BY category", [], callback);
}
function updateInquiryCategory(category, adminId, role, id, callback) {
    db.run("UPDATE inquiries SET category = ?, updated_by = ?, updated_by_role = ?, updated_at = CURRENT_TIMESTAMP WHERE inquiry_id = ?", [category, adminId, role, id], callback);
}

// ── Notes CRUD ──
function listInquiryNotes(inquiryId, callback) {
    db.all("SELECT id, note, author, created_at FROM inquiry_notes WHERE inquiry_id = ? ORDER BY created_at ASC", [inquiryId], callback);
}
function insertInquiryNote(inquiryId, note, author, createdBy, callback) {
    db.run("INSERT INTO inquiry_notes (inquiry_id, note, author, created_by) VALUES (?, ?, ?, ?)", [inquiryId, note, author, createdBy], callback);
}
function getInquiryNoteById(id, callback) {
    db.get("SELECT id, note, author, created_at FROM inquiry_notes WHERE id = ?", [id], callback);
}
function deleteInquiryNote(noteId, inquiryId, callback) {
    db.run("DELETE FROM inquiry_notes WHERE id = ? AND inquiry_id = ?", [noteId, inquiryId], callback);
}

// ── Bulk / single status-status delete ──
function bulkUpdateInquiryStatus(ph, status, cleanIds, callback) {
    db.run(`UPDATE inquiries SET status = ? WHERE inquiry_id IN (${ph})`, [status, ...cleanIds], callback);
}
function bulkDeleteInquiries(ph, cleanIds, callback) {
    db.run(`DELETE FROM inquiries WHERE inquiry_id IN (${ph})`, cleanIds, callback);
}
function deleteInquiry(id, callback) {
    db.run("DELETE FROM inquiries WHERE inquiry_id = ?", id, callback);
}

module.exports = {
    anonymizeOldInquiries, getInquiryIdsForEmail, anonymizeInquiriesForErasure, redactInquiryNotesForErasure,
    countInquiryNotesForIds, getInquiriesForEmail, insertInquiry, linkInquiryToBooking, markInquiryReplied,
    countInquiries, countInquiriesByStatus, countMyInquiries,
    updateInquiryStatus, unassignInquiry, assignInquiry, updateInquiryPriority, listInquiryCategories, updateInquiryCategory,
    listInquiryNotes, insertInquiryNote, getInquiryNoteById, deleteInquiryNote,
    bulkUpdateInquiryStatus, bulkDeleteInquiries, deleteInquiry,
};
