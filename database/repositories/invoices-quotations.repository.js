// Invoices+Quotations domain repository — Phase 4 of the housekeeping effort (HOUSEKEEPING-NOTES.md).
// Covers invoices, invoice_line_items, quotations, quote_line_items. Every SQL string below is
// byte-identical to where it lived in server.js before this move. No req/res, no email sending,
// no PDF generation, no calendar calls.
//
// Every statement here was found by a live grep sweep of server.js, not a stale line-numbered
// catalog. Two full reporting/dashboard routes (GET /api/admin/financials/analytics and the
// finance-KPI dashboard route) each mix a single-table `invoices` aggregate in with several
// transactions/bookings-joined queries computing one cohesive report — deliberately left whole
// for a future `finance` domain session rather than fragmented. A handful of routes in other
// domains (accept-quote, quote-revision-request, quote/download, the public self-cancel route)
// also contain an un-migrated `bookings`-domain statement of their own — not touched here, since
// `bookings` is already done and these weren't part of that session.
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

// ── generateInvoice() — the booking+clients fetch and the payment_schedules/contracts lookups
// stay in server.js (cross-domain); these are its own invoices/quotations/line-item statements ──
function getInvoiceForPaidCheck(bookingId, callback) {
    db.get("SELECT id, file_path FROM invoices WHERE booking_id = ? AND status = 'PAID' LIMIT 1", [bookingId], callback);
}
// Byte-distinct from getActiveQuoteForContractFeeData below (multi-line vs single-line — different
// call sites, nested at different depths in the original file).
function getActiveQuoteForInvoiceGen(bookingId) {
    return new Promise(resolve => {
        db.get(
            `SELECT * FROM quotations WHERE booking_id = ? AND archived = 0 AND status NOT IN ('void','archived')
             ORDER BY version DESC LIMIT 1`,
            [bookingId], (err, row) => resolve(err ? null : row)
        );
    });
}
// Shared by generateInvoice() and resolveContractFeeData() — byte-identical single-line SQL at
// both call sites (never-rejects, resolves [] on error).
function getQuoteLineItems(quotationId) {
    return new Promise(resolve => {
        db.all("SELECT * FROM quote_line_items WHERE quotation_id = ? ORDER BY id ASC",
            [quotationId], (err, rows) => resolve(err ? [] : (rows || [])));
    });
}
function getInvoiceNumberCollisionCount(bookingId, baseNumber, likePattern) {
    return new Promise((resolve, reject) =>
        db.get(
            `SELECT COUNT(*) AS c FROM invoices
             WHERE booking_id = ? AND (invoice_number = ? OR invoice_number LIKE ?)`,
            [bookingId, baseNumber, likePattern],
            (e, r) => e ? reject(e) : resolve(r ? r.c : 0)
        ));
}
function voidSupersededInvoiceForRegen(bookingId) {
    return promised("UPDATE invoices SET status='VOID', void_reason='superseded', voided_at=CURRENT_TIMESTAMP WHERE booking_id=? AND UPPER(status) NOT IN ('VOID','PAID')", [bookingId]);
}
function insertInvoice(bookingId, clientId, invNumber, subtotal, tax, total, status, pdfFileName) {
    return promised(
        `INSERT INTO invoices (booking_id, client_id, invoice_number, invoice_date, due_date, subtotal, tax_amount, total_amount, status, file_path)
                VALUES (?, ?, ?, CURRENT_DATE, date('now', '+7 days'), ?, ?, ?, ?, ?)`,
        [bookingId, clientId, invNumber, subtotal, tax, total, status, pdfFileName]);
}
function insertInvoiceLineItem(invoiceId, description, quantity, unitPrice) {
    return promised(
        `INSERT INTO invoice_line_items (invoice_id, description, quantity, unit_price)
                             VALUES (?, ?, ?, ?)`,
        [invoiceId, description, quantity, unitPrice]);
}
// Shared by generateInvoice() (autoSend branch) and the bulk-send-unsent route below — byte-identical.
function markInvoiceSent(invoiceId, callback) {
    db.run("UPDATE invoices SET sent_at = CURRENT_TIMESTAMP WHERE id = ?", [invoiceId], callback);
}

// startBackgroundClerk()'s S6 cron (auto-complete past CONFIRMED paid bookings) — mark the linked
// invoice paid, in parity with manual completion. Byte-distinct from markInvoicePaidOnStatusComplete
// below (differs only in whitespace around "="), and from markInvoicePaidIfOpen/…Async above
// (this one has no UPPER() on status) — three separate statements, not one.
function markInvoicePaidForAutoComplete(bookingId, callback) {
    db.run("UPDATE invoices SET status='PAID', updated_at=CURRENT_TIMESTAMP WHERE booking_id=? AND status NOT IN ('VOID','PAID')", [bookingId], callback);
}
// applyStatusChange()'s COMPLETED branch — see markInvoicePaidForAutoComplete above re: why this
// isn't consolidated with it despite being the same rule.
function markInvoicePaidOnStatusComplete(bookingId) {
    db.run("UPDATE invoices SET status = 'PAID', updated_at = CURRENT_TIMESTAMP WHERE booking_id = ? AND status NOT IN ('VOID','PAID')", [bookingId]);
}

// runDailyOverdueFlaggingSweep() — inside a db.serialize() alongside a payment_schedules UPDATE
// that stays in server.js (cross-domain), same as settings' working_hours case.
function flagOverdueInvoices(todayLocal, callback) {
    db.run(
        `UPDATE invoices
             SET status = 'OVERDUE', updated_at = CURRENT_TIMESTAMP
             WHERE status = 'SENT'
               AND due_date IS NOT NULL
               AND due_date < ?`,
        [todayLocal], callback);
}

// sendPaidReceiptEmail() — finds the paid invoice PDF to resend as a receipt.
function getInvoiceForPaidReceipt(bookingId) {
    return new Promise(resolve => {
        db.get("SELECT file_path, invoice_number FROM invoices WHERE booking_id = ? AND status = 'PAID' ORDER BY id DESC LIMIT 1",
            [bookingId], (e, row) => resolve(e ? null : row));
    });
}

// sendBookingCompletedEmail() — VAT lookup with a quotations fallback when no invoice exists yet.
function getInvoiceTaxAmountForBooking(bookingId, callback) {
    db.get(`SELECT tax_amount FROM invoices WHERE booking_id = ? AND UPPER(status) != 'VOID' ORDER BY id DESC LIMIT 1`, [bookingId], callback);
}
function getQuoteTaxAmountForBooking(bookingId, callback) {
    db.get(`SELECT tax_amount FROM quotations WHERE booking_id = ? AND status != 'void' ORDER BY id DESC LIMIT 1`, [bookingId], callback);
}

// anonymizeClientData() / resolvePopiaTargets() — file-cleanup lookups and the file_path scrub.
// invoices are deliberately NOT touched anywhere in POPIA erasure (financial/tax records survive,
// per that function's own header comment) — only quotations' file_path (not a financial figure).
function getQuoteFilesForBookingIds(bookingPh, bookingIds) {
    return promisedAll(`SELECT file_path FROM quotations WHERE booking_id IN (${bookingPh}) AND file_path IS NOT NULL`, bookingIds);
}
function getQuoteFilesForClientIds(clientPh, clientIds) {
    return promisedAll(`SELECT file_path FROM quotations WHERE client_id IN (${clientPh}) AND booking_id IS NULL AND file_path IS NOT NULL`, clientIds);
}
function clearQuoteFilePathsForErasure(bookingPh, bookingIds) {
    return promised(`UPDATE quotations SET file_path = NULL WHERE booking_id IN (${bookingPh})`, bookingIds);
}
function clearQuoteFilePathsForClientErasure(clientPh, clientIds) {
    return promised(`UPDATE quotations SET file_path = NULL WHERE client_id IN (${clientPh}) AND booking_id IS NULL`, clientIds);
}

// Shared by the PayFast ITN handler (await, inside its transaction), processManualPayment(),
// the reconcile/sync route, and the transactions/manual payment branch — 4 byte-identical call
// sites, split into two functions by sync style (same reasoning as getBookingById/…Async).
function markInvoicePaidIfOpen(bookingId) {
    db.run("UPDATE invoices SET status='PAID', updated_at=CURRENT_TIMESTAMP WHERE booking_id=? AND UPPER(status) NOT IN ('VOID','PAID')", [bookingId]);
}
function markInvoicePaidIfOpenAsync(bookingId) {
    return promised("UPDATE invoices SET status='PAID', updated_at=CURRENT_TIMESTAMP WHERE booking_id=? AND UPPER(status) NOT IN ('VOID','PAID')", [bookingId]);
}

// processManualPayment() — "does an invoice already exist" check before sending the paid receipt.
// Byte-distinct from getOpenInvoiceIdForAdjustmentRegen below (different NOT IN list, has ORDER BY).
function getOpenInvoiceIdForReceiptCheck(bookingId, callback) {
    db.get(
        "SELECT id FROM invoices WHERE booking_id = ? AND UPPER(status) NOT IN ('VOID') ORDER BY id DESC LIMIT 1",
        [bookingId], callback);
}

// Shared by cancelActiveBookingsForErasure() (POPIA), the admin cancel route, applyStatusChange()'s
// CANCELLED branch, and the public self-cancel route — 4 byte-identical call sites (3 await a
// promise with no callback, 1 uses an error-logging callback), split the same way as above.
function voidInvoicesForCancelledBooking(bookingId, callback) {
    db.run("UPDATE invoices SET status='VOID', void_reason='booking_cancelled', voided_at=CURRENT_TIMESTAMP WHERE booking_id=? AND status NOT IN ('VOID','PAID')", [bookingId], callback);
}
function voidInvoicesForCancelledBookingAsync(bookingId) {
    return promised("UPDATE invoices SET status='VOID', void_reason='booking_cancelled', voided_at=CURRENT_TIMESTAMP WHERE booking_id=? AND status NOT IN ('VOID','PAID')", [bookingId]);
}

// POST /api/public/bookings/:id/track — invoice + quote-version summary for the client tracker.
function getInvoiceForTracking(bookingId, callback) {
    db.get("SELECT file_path, invoice_number, status FROM invoices WHERE booking_id = ? AND status != 'VOID' ORDER BY created_at DESC LIMIT 1", [bookingId], callback);
}
function getQuoteVersionInfoForTracking(bookingId, callback) {
    db.get(
        `SELECT version, (SELECT COUNT(*) FROM quotations WHERE booking_id = ?) AS total_versions
         FROM quotations WHERE booking_id = ? AND archived = 0 ORDER BY version DESC LIMIT 1`,
        [bookingId, bookingId], callback);
}

// Shared by the client accept-quote route (await, no callback) and applyStatusChange()'s ACCEPTED
// branch (callback) — 2 byte-identical call sites.
function markQuotationAccepted(bookingId, callback) {
    db.run("UPDATE quotations SET status = 'accepted' WHERE booking_id = ? AND archived = 0", [bookingId], callback);
}
function markQuotationAcceptedAsync(bookingId) {
    return promised("UPDATE quotations SET status = 'accepted' WHERE booking_id = ? AND archived = 0", [bookingId]);
}
// applyStatusChange()'s QUOTED branch (revert-to-sent) — distinct status literal, standalone.
function revertQuotationToSent(bookingId, callback) {
    db.run("UPDATE quotations SET status = 'sent' WHERE booking_id = ? AND archived = 0", [bookingId], callback);
}

// resolveContractFeeData() — see getActiveQuoteForInvoiceGen above re: why this isn't consolidated
// with it despite being conceptually the same lookup.
function getActiveQuoteForContractFeeData(bookingId) {
    return new Promise(r => db.get(
        `SELECT * FROM quotations WHERE booking_id = ? AND archived = 0 AND status NOT IN ('void','archived') ORDER BY version DESC LIMIT 1`,
        [bookingId], (e, row) => r(e ? null : row)));
}

// GET /api/admin/services/:id/usage — a genuine in-domain JOIN (quotations + quote_line_items,
// both this domain's own tables; only the WHERE filters on a services.id value, it never touches
// the services table itself).
function getServiceDraftQuoteUsage(serviceId, callback) {
    const sql = `
        SELECT COUNT(DISTINCT q.id) AS draft_count
        FROM quotations q
        JOIN quote_line_items qli ON q.id = qli.quotation_id
        WHERE qli.service_id = ? AND q.status = 'draft' AND COALESCE(q.archived, 0) = 0
    `;
    db.get(sql, [serviceId], callback);
}
// DELETE /api/admin/services/:id (hard-delete guard) — quote_line_items half; the sibling
// booking_line_items check is countBookingLineItemsForService() in the bookings repository.
function countQuoteLineItemsForService(serviceId, callback) {
    db.get("SELECT COUNT(*) as cnt FROM quote_line_items WHERE service_id=?", [serviceId], callback);
}

// --- Admin invoice actions ---
function markInvoiceSentAndPublished(invoiceId, callback) {
    db.run("UPDATE invoices SET sent_at = CURRENT_TIMESTAMP, status = CASE WHEN status = 'DRAFT' THEN 'SENT' ELSE status END WHERE id = ?", [invoiceId], callback);
}
// Shared by the void route and the mark-paid route — byte-identical single-quoted SQL.
function getInvoiceById(id, callback) {
    db.get('SELECT * FROM invoices WHERE id = ?', [id], callback);
}
function voidInvoiceWithReason(reason, invoiceId, callback) {
    db.run(
        "UPDATE invoices SET status='VOID', void_reason=?, voided_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?",
        [reason, invoiceId], callback);
}
function markInvoicePaidById(invoiceId, callback) {
    db.run(
        "UPDATE invoices SET status='PAID', updated_at=CURRENT_TIMESTAMP WHERE id=?",
        [invoiceId], callback);
}

// POST /api/admin/bookings/:id/resend-quote
function getLatestQuoteFileForResend(bookingId, callback) {
    db.get("SELECT file_path FROM quotations WHERE booking_id = ? AND archived=0 ORDER BY version DESC LIMIT 1", [bookingId], callback);
}
function markQuotationResent(bookingId, callback) {
    db.run("UPDATE quotations SET sent_at = CURRENT_TIMESTAMP WHERE booking_id = ? AND archived = 0", [bookingId], callback);
}

// --- POST /api/admin/bookings/:id/quote (admin quote generation) ---
// The booking+clients fetch, the services/booking_services conflict checks, the payment_schedules
// supersede, and every contracts/audit_log statement in this route's transaction all stay in
// server.js (cross-domain); these are its own quotations/quote_line_items/invoices statements.
function getQuoteNumberCollisionCount(baseQuoteNumber, likePattern) {
    return new Promise((resolve, reject) =>
        db.get(
            `SELECT COUNT(*) AS c FROM quotations
                     WHERE quote_number = ? OR quote_number LIKE ?`,
            [baseQuoteNumber, likePattern],
            (e, r) => e ? reject(e) : resolve(r ? r.c : 0)
        ));
}
function voidInvoiceForRequote(bookingId) {
    return promised("UPDATE invoices SET status = 'VOID', void_reason = 'superseded_by_requote', voided_at = CURRENT_TIMESTAMP WHERE booking_id = ? AND UPPER(status) NOT IN ('VOID','PAID')", [bookingId]);
}
function archivePreviousQuotations(bookingId) {
    return promised(
        "UPDATE quotations SET archived = 1, status = CASE WHEN status = 'sent' THEN 'archived' ELSE status END WHERE booking_id = ? AND archived = 0",
        [bookingId]);
}
function getNextQuoteVersion(bookingId) {
    return promisedGet("SELECT COALESCE(MAX(version), 0) + 1 AS next_version FROM quotations WHERE booking_id = ?", [bookingId]);
}
function insertQuotation(bookingId, quoteNumber, clientId, expiryDate, finalTotal, pdfFileName, nextVersion) {
    return promised(
        "INSERT INTO quotations (booking_id, quote_number, client_id, quote_date, expiry_date, total_amount, status, file_path, version, archived, sent_at) VALUES (?, ?, ?, CURRENT_DATE, ?, ?, 'sent', ?, ?, 0, CURRENT_TIMESTAMP)",
        [bookingId, quoteNumber, clientId, expiryDate, finalTotal, pdfFileName, nextVersion]);
}
function insertQuoteLineItem(quotationId, serviceId, description, quantity, unitPrice) {
    return promised("INSERT INTO quote_line_items (quotation_id, service_id, description, quantity, unit_price) VALUES (?, ?, ?, ?, ?)",
        [quotationId, serviceId, description, quantity, unitPrice]);
}

function getQuoteHistoryForBooking(bookingId, callback) {
    db.all(
        `SELECT id, quote_number, version, total_amount, status, created_at, file_path, archived
         FROM quotations WHERE booking_id = ? ORDER BY version DESC`,
        [bookingId], callback);
}
// POST /api/admin/bookings/:id/invoice/generate — the acceptance guard. The call site chains
// `.catch(() => null)` onto this — that stays in server.js, not baked into the function, since it's
// call-site error-swallowing rather than this statement's own contract.
function getActiveQuoteStatusForInvoiceGuard(bookingId) {
    return new Promise((resolve, reject) => {
        db.get(
            `SELECT id, status FROM quotations WHERE booking_id = ? AND archived = 0 ORDER BY version DESC LIMIT 1`,
            [bookingId],
            (err, row) => { if (err) reject(err); else resolve(row); }
        );
    });
}

// --- Download routes ---
function getInvoiceFileForAdminDownload(bookingId, callback) {
    db.get(`SELECT i.file_path, i.invoice_number
            FROM invoices i
            WHERE i.booking_id = ? AND UPPER(i.status) <> 'VOID'
            ORDER BY i.created_at DESC, i.id DESC
            LIMIT 1`, [bookingId], callback);
}
function getQuoteFileForAdminDownload(bookingId, callback) {
    db.get(`SELECT q.file_path, q.quote_number
            FROM quotations q
            WHERE q.booking_id = ?`, [bookingId], callback);
}
// Public self-download route — byte-distinct from getLatestQuoteFileForResend above (adds
// quote_number to the column list, different "archived" spacing).
function getLatestQuoteFileForPublicDownload(bookingId, callback) {
    db.get("SELECT file_path, quote_number FROM quotations WHERE booking_id = ? AND archived = 0 ORDER BY version DESC LIMIT 1", [bookingId], callback);
}

// GET /api/admin/bookings/:id/financials — a small booking-scoped quote+invoice summary (not the
// cross-domain finance dashboards deferred above).
function getQuoteForBookingFinancials(bookingId, callback) {
    db.get("SELECT * FROM quotations WHERE booking_id = ? ORDER BY created_at DESC LIMIT 1", [bookingId], callback);
}
function getInvoiceForBookingFinancials(bookingId, callback) {
    db.get("SELECT * FROM invoices WHERE booking_id = ? ORDER BY invoice_date DESC LIMIT 1", [bookingId], callback);
}

// POST /api/admin/transactions/manual (adjustment branch) — "does an invoice need regenerating"
// check. See getOpenInvoiceIdForReceiptCheck above re: why this isn't consolidated with it.
function getOpenInvoiceIdForAdjustmentRegen(bookingId, callback) {
    db.get("SELECT id FROM invoices WHERE booking_id = ? AND UPPER(status) NOT IN ('VOID','PAID') LIMIT 1", [bookingId], callback);
}

// GET /api/admin/popia/requests/:id preview — the sibling of countBookingNotesForIds() etc.,
// called from the same Promise.all().
function countQuotationsForIds(bookingPh, bookingIds) {
    return promisedGet(`SELECT COUNT(*) AS c FROM quotations WHERE booking_id IN (${bookingPh})`, bookingIds);
}
function countQuotationsForClientIds(clientPh, clientIds) {
    return promisedGet(`SELECT COUNT(*) AS c FROM quotations WHERE client_id IN (${clientPh}) AND booking_id IS NULL`, clientIds);
}

// runInvoicePreDueReminderJob() / runOverdueInvoiceSweepJob() — the cross-domain (invoices JOIN
// bookings) candidate-selection SELECTs stay in server.js; these are each job's own mark-handled
// UPDATE, same pattern as the bookings-domain reminder crons.
function markInvoicePreDueReminded(invoiceId) {
    db.run("UPDATE invoices SET pre_due_reminded_at = CURRENT_TIMESTAMP WHERE id = ?", [invoiceId]);
}
function markInvoiceOverdueReminded(invoiceId) {
    db.run("UPDATE invoices SET overdue_reminded_at = CURRENT_TIMESTAMP WHERE id = ?", [invoiceId]);
}

// GET /api/admin/financials/analytics — deferred whole from this domain's own session (it mixes
// this aging query with several transactions/bookings-joined queries computing one cohesive
// report); completed now as part of the `finance` domain's session, which owns the sibling
// transactions/expenses statements in the same route. The route's other invoices/quotations
// statements (clientQuery, overdueListQuery, categoryQuery) all JOIN bookings and stay cross-domain.
function getInvoiceAgingSummary(callback) {
    db.get(
        `
        SELECT
            COUNT(CASE WHEN (julianday('now') - julianday(due_date)) <= 0 THEN 1 END) AS current_count,
            COALESCE(SUM(CASE WHEN (julianday('now') - julianday(due_date)) <= 0 THEN total_amount ELSE 0 END), 0) AS current_value,

            COUNT(CASE WHEN (julianday('now') - julianday(due_date)) > 0 AND (julianday('now') - julianday(due_date)) <= 30 THEN 1 END) AS age_30_count,
            COALESCE(SUM(CASE WHEN (julianday('now') - julianday(due_date)) > 0 AND (julianday('now') - julianday(due_date)) <= 30 THEN total_amount ELSE 0 END), 0) AS age_30_value,

            COUNT(CASE WHEN (julianday('now') - julianday(due_date)) > 30 AND (julianday('now') - julianday(due_date)) <= 60 THEN 1 END) AS age_60_count,
            COALESCE(SUM(CASE WHEN (julianday('now') - julianday(due_date)) > 30 AND (julianday('now') - julianday(due_date)) <= 60 THEN total_amount ELSE 0 END), 0) AS age_60_value,

            COUNT(CASE WHEN (julianday('now') - julianday(due_date)) > 60 AND (julianday('now') - julianday(due_date)) <= 90 THEN 1 END) AS age_90_count,
            COALESCE(SUM(CASE WHEN (julianday('now') - julianday(due_date)) > 60 AND (julianday('now') - julianday(due_date)) <= 90 THEN total_amount ELSE 0 END), 0) AS age_90_value,

            COUNT(CASE WHEN (julianday('now') - julianday(due_date)) > 90 THEN 1 END) AS age_over_90_count,
            COALESCE(SUM(CASE WHEN (julianday('now') - julianday(due_date)) > 90 THEN total_amount ELSE 0 END), 0) AS age_over_90_value
        FROM invoices
        WHERE status IN ('SENT', 'OVERDUE')
    `,
        [], callback);
}
// GET /api/admin/financials/stats — same deferred-route-completion story as above.
function getOverdueInvoicesSummary(callback) {
    db.get(
        `SELECT COUNT(*) AS overdue_count,
                                            COALESCE(SUM(total_amount), 0) AS overdue_value
                                     FROM invoices
                                     WHERE status = 'SENT'
                                       AND due_date IS NOT NULL
                                       AND due_date < DATE('now')`,
        [], callback);
}
function getDueSoonInvoicesSummary(callback) {
    db.get(
        `SELECT COUNT(*) AS cnt, COALESCE(SUM(total_amount), 0) AS val
                                             FROM invoices
                                             WHERE status = 'SENT'
                                               AND due_date IS NOT NULL
                                               AND due_date >= DATE('now')
                                               AND due_date <= DATE('now', '+7 days')`,
        [], callback);
}

module.exports = {
    getInvoiceForPaidCheck, getActiveQuoteForInvoiceGen, getQuoteLineItems, getInvoiceNumberCollisionCount,
    voidSupersededInvoiceForRegen, insertInvoice, insertInvoiceLineItem, markInvoiceSent,
    markInvoicePaidForAutoComplete, markInvoicePaidOnStatusComplete,
    flagOverdueInvoices,
    getInvoiceForPaidReceipt,
    getInvoiceTaxAmountForBooking, getQuoteTaxAmountForBooking,
    getQuoteFilesForBookingIds, getQuoteFilesForClientIds, clearQuoteFilePathsForErasure, clearQuoteFilePathsForClientErasure,
    markInvoicePaidIfOpen, markInvoicePaidIfOpenAsync,
    getOpenInvoiceIdForReceiptCheck,
    voidInvoicesForCancelledBooking, voidInvoicesForCancelledBookingAsync,
    getInvoiceForTracking, getQuoteVersionInfoForTracking,
    markQuotationAccepted, markQuotationAcceptedAsync, revertQuotationToSent,
    getActiveQuoteForContractFeeData,
    getServiceDraftQuoteUsage, countQuoteLineItemsForService,
    markInvoiceSentAndPublished, getInvoiceById, voidInvoiceWithReason, markInvoicePaidById,
    getLatestQuoteFileForResend, markQuotationResent,
    getQuoteNumberCollisionCount, voidInvoiceForRequote, archivePreviousQuotations, getNextQuoteVersion,
    insertQuotation, insertQuoteLineItem, getQuoteHistoryForBooking, getActiveQuoteStatusForInvoiceGuard,
    getInvoiceFileForAdminDownload, getQuoteFileForAdminDownload, getLatestQuoteFileForPublicDownload,
    getQuoteForBookingFinancials, getInvoiceForBookingFinancials,
    getOpenInvoiceIdForAdjustmentRegen,
    countQuotationsForIds, countQuotationsForClientIds,
    markInvoicePreDueReminded, markInvoiceOverdueReminded,
    getInvoiceAgingSummary, getOverdueInvoicesSummary, getDueSoonInvoicesSummary,
};
