// Finance domain repository — Phase 4 of the housekeeping effort (HOUSEKEEPING-NOTES.md).
// Covers transactions, payment_schedules, cancellations, payment_logs, expenses,
// bank_statement_lines. Every SQL string below is byte-identical to where it lived in server.js
// before this move. No req/res, no email sending, no PDF generation, no calendar calls.
//
// `financial_audit_log` is deliberately NOT part of this domain — like the generic `audit_log`
// table, it's written from services/invoices/payment routes alike (SERVICE_ARCHIVED,
// INVOICE_VOIDED, MANUAL_PAYMENT, EXPENSE_LOGGED, …) and has never been pulled into any single
// domain's repository. `BOOKING_DELETE_PURGE`/`BOOKING_DELETE_UNLINK` (server.js) are, as always,
// permanently excluded — their `payment_schedules`/`transactions`/`payment_logs`/`cancellations`/
// `expenses`/`bank_statement_lines` entries are never touched.
//
// Found by a live grep sweep of every FROM/INTO/UPDATE hit against these six tables in
// server.js — no prior catalog existed for this domain.
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

// ══════════════════════════════════════════════════════════════════════════
// payment_schedules
// ══════════════════════════════════════════════════════════════════════════

// autoBuildDepositBalanceSchedule()
function getLivePaymentScheduleCount(bookingId) {
    return promisedGet(
        "SELECT COUNT(*) AS cnt FROM payment_schedules WHERE booking_id = ? AND LOWER(COALESCE(status,'pending')) NOT IN ('superseded','cancelled','paid')",
        [bookingId]);
}
function getPaidPaymentScheduleSum(bookingId) {
    return promisedGet(
        "SELECT COALESCE(SUM(expected_amount),0) AS paidSum FROM payment_schedules WHERE booking_id = ? AND LOWER(COALESCE(status,'pending')) = 'paid'",
        [bookingId]);
}
// Called twice in a row (deposit + balance) with the exact same SQL — one function, two calls,
// same as the original.
function insertPaymentScheduleMilestone(bookingId, description, dueDate, amount) {
    return promised("INSERT INTO payment_schedules (booking_id, description, due_date, expected_amount) VALUES (?, ?, ?, ?)",
        [bookingId, description, dueDate, amount]);
}

// Shared by generateInvoice(), sendInvoiceEmail(), sendQuoteAcceptedEmail(), and
// resolveContractFeeData() — 4 byte-identical call sites (never-rejects, resolves [] on error).
function getPaymentSchedulesForDocument(bookingId) {
    return new Promise(resolve => {
        db.all(
            "SELECT description, due_date, expected_amount FROM payment_schedules WHERE booking_id = ? AND LOWER(COALESCE(status,'pending')) NOT IN ('superseded','cancelled') ORDER BY due_date ASC",
            [bookingId],
            (err, rows) => resolve(err ? [] : (rows || []))
        );
    });
}

// runDailyOverdueFlaggingSweep() — inside a db.serialize() alongside flagOverdueInvoices() (the
// invoices-domain half); this is the payment_schedules half.
function flagOverduePaymentSchedules(todayLocal, callback) {
    db.run(
        `UPDATE payment_schedules
             SET status = 'overdue', updated_at = CURRENT_TIMESTAMP
             WHERE status = 'pending'
               AND due_date IS NOT NULL
               AND due_date < ?`,
        [todayLocal], callback);
}

// alignMilestonePayments() — the greedy waterfall.
function getActiveScheduleRowsForAlignment(bookingId, callback) {
    db.all(
        `SELECT id, expected_amount, status FROM payment_schedules
         WHERE booking_id = ? AND LOWER(COALESCE(status,'pending')) NOT IN ('superseded','cancelled')
         ORDER BY due_date ASC, id ASC`,
        [bookingId], callback);
}
// ids come from getActiveScheduleRowsForAlignment above, never from user input.
function markScheduleRowsPaid(placeholders, ids, next) {
    db.run(`UPDATE payment_schedules SET status = 'paid', updated_at = CURRENT_TIMESTAMP
                        WHERE id IN (${placeholders})
                          AND LOWER(COALESCE(status,'pending')) <> 'paid'`, ids, next);
}
function markScheduleRowsPending(placeholders, ids, next) {
    db.run(`UPDATE payment_schedules SET status = 'pending', updated_at = CURRENT_TIMESTAMP
                        WHERE id IN (${placeholders})
                          AND LOWER(COALESCE(status,'pending')) = 'paid'`, ids, next);
}

// Shared by GET .../payment-schedules, POST .../payment-schedules/rebalance (twice) — 3
// byte-identical call sites.
function getActivePaymentSchedules(bookingId, callback) {
    db.all("SELECT * FROM payment_schedules WHERE booking_id = ? AND LOWER(COALESCE(status,'pending')) NOT IN ('superseded','cancelled') ORDER BY due_date ASC, id ASC", [bookingId], callback);
}
// POST /api/admin/bookings/:id/payment-schedules — replace-all.
function deletePaymentSchedulesForBooking(bookingId, callback) {
    db.run('DELETE FROM payment_schedules WHERE booking_id = ?', [bookingId], callback);
}
// The route's own db.prepare()/forEach/finalize dance stays in server.js unchanged — only the
// prepared statement's SQL text is relocated here.
function prepareInsertPaymentSchedule() {
    return db.prepare(`INSERT INTO payment_schedules (booking_id, description, due_date, expected_amount, status) VALUES (?, ?, ?, ?, 'pending')`);
}
// POST .../payment-schedules/rebalance — same "relocate the prepare() call only" treatment.
function prepareUpdatePaymentScheduleAmount() {
    return db.prepare("UPDATE payment_schedules SET expected_amount = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?");
}

// Shared by cancelActiveBookingsForErasure() (POPIA), the admin cancel route, applyStatusChange()'s
// CANCELLED branch, and the public self-cancel route — 4 byte-identical call sites (3 await a
// promise with no callback, 1 uses an error-logging callback) — same split as the invoices/
// quotations domain's analogous "cancelled booking cascade" consolidations.
function cancelPendingPaymentSchedules(bookingId, callback) {
    db.run("UPDATE payment_schedules SET status='cancelled', updated_at=CURRENT_TIMESTAMP WHERE booking_id=? AND status='pending'", [bookingId], callback);
}
function cancelPendingPaymentSchedulesAsync(bookingId) {
    return promised("UPDATE payment_schedules SET status='cancelled', updated_at=CURRENT_TIMESTAMP WHERE booking_id=? AND status='pending'", [bookingId]);
}
// Admin quote-generation route — re-quoting an ACCEPTED/CONFIRMED booking supersedes its stale
// unpaid milestones. Byte-distinct from the cancel-cascade statement above (different status
// literal, different WHERE).
function supersedePaymentSchedulesForRequote(bookingId) {
    return promised("UPDATE payment_schedules SET status = 'superseded' WHERE booking_id = ? AND LOWER(COALESCE(status,'pending')) != 'paid'", [bookingId]);
}
// POST /api/public/bookings/:id/track — client-facing schedule view. Distinct column list
// (adds status/updated_at) from getPaymentSchedulesForDocument above.
function getPaymentSchedulesForTracking(bookingId, callback) {
    db.all("SELECT description, due_date, expected_amount, status, updated_at FROM payment_schedules WHERE booking_id = ? AND LOWER(COALESCE(status,'pending')) NOT IN ('superseded','cancelled') ORDER BY due_date ASC", [bookingId], callback);
}
// PayFast payment-initiation route — distinct column list/WHERE from getPaymentSchedulesForDocument.
function getPaymentSchedulesForPayfastInit(bookingId, callback) {
    db.all(
        "SELECT description, expected_amount FROM payment_schedules WHERE booking_id = ? AND status != 'paid' AND LOWER(COALESCE(status,'pending')) NOT IN ('superseded','cancelled') ORDER BY due_date ASC",
        [bookingId], callback);
}

// ══════════════════════════════════════════════════════════════════════════
// transactions
// ══════════════════════════════════════════════════════════════════════════

// PayFast ITN handler — idempotency pre-check (before the atomic transaction insert below).
function getPayfastTransactionByReference(reference, bookingId) {
    return new Promise(resolve => {
        db.get("SELECT id FROM transactions WHERE reference = ? AND booking_id = ? AND source = 'payfast'",
            [reference, bookingId], (e, row) => resolve(!!row));
    });
}
// PayFast ITN handler — the atomic credit's own transactions row, inside withDbTransaction().
function insertPayfastTransaction(bookingId, itnAmount, mappedMethod, itnRef, pfPaymentId, pfStatus, receivedSignature) {
    return promised(
        `INSERT INTO transactions (booking_id, amount, transaction_type, payment_method, reference,
                             transaction_date, status, source, pf_payment_id, pf_status, pf_signature, is_verified)
                         VALUES (?, ?, 'payment', ?, ?, CURRENT_TIMESTAMP, 'completed', 'payfast', ?, ?, ?, 1)`,
        [bookingId, itnAmount, mappedMethod, itnRef, pfPaymentId, pfStatus, receivedSignature]);
}
// logPaymentEvent() — generic ITN/manual-payment audit trail (payment_logs half).
function insertPaymentLogEntry(bookingId, eventType, rawPayloadJson, sigValid, amount, callback) {
    db.run(
        `INSERT INTO payment_logs (booking_id, event_type, raw_payload, signature_valid, amount) VALUES (?, ?, ?, ?, ?)`,
        [bookingId, eventType, rawPayloadJson, sigValid, amount], callback);
}
// logPaymentEvent() — the transactions half, only written for VERIFIED_OK/MANUAL_PAYMENT_RECORDED.
function insertLoggedPaymentTransaction(bookingId, amount, mappedMethod, txReference, txSource, callback) {
    db.run(`INSERT INTO transactions (booking_id, amount, transaction_type, payment_method, reference, transaction_date, status, source)
                VALUES (?, ?, 'payment', ?, ?, CURRENT_TIMESTAMP, 'completed', ?)`,
        [bookingId, amount, mappedMethod, txReference, txSource], callback);
}
// GET /api/bookings/:id/payment-logs
function getPaymentLogsForBooking(bookingId, callback) {
    db.all("SELECT * FROM payment_logs WHERE booking_id = ? ORDER BY timestamp DESC", [bookingId], callback);
}
// PUT .../manual-payment — duplicate-credit warning check.
function getRecentPayfastTransactionForBooking(bookingId, callback) {
    db.get(
        `SELECT id, amount, created_at FROM transactions
                 WHERE booking_id = ? AND source = 'payfast' AND status = 'completed'
                   AND created_at >= datetime('now', '-2 hours')
                 ORDER BY created_at DESC LIMIT 1`,
        [bookingId], callback);
}
// getUnresolvedRefundBookingIds() — a genuine in-domain query: both `cancellations` and
// `transactions` belong to this domain, so the correlated subquery is not cross-domain here
// (unlike the refund route's `UPDATE bookings ... (SELECT ... FROM transactions)`, whose OUTER
// table is `bookings` — that one stays in server.js, documented in the `bookings` domain's
// Stage 6 notes, and is unaffected by this domain's work).
function getCancellationsWithRefundedTotals(placeholders, bookingIds) {
    return new Promise((resolve, reject) => {
        db.all(
            `SELECT c.booking_id, c.refund_due,
                COALESCE((SELECT SUM(t.amount) FROM transactions t WHERE t.booking_id = c.booking_id AND t.transaction_type = 'refund' AND t.status = 'completed'), 0) AS refunded
         FROM cancellations c WHERE c.booking_id IN (${placeholders}) AND c.refund_due > 0`,
            bookingIds, (err, rows) => err ? reject(err) : resolve(rows)
        );
    });
}
// GET /api/admin/bookings/:id/details — 2 byte-identical call sites (services-present branch and
// the legacy booking_line_items fallback branch).
function getTransactionsForBooking(bookingId, callback) {
    db.all("SELECT * FROM transactions WHERE booking_id = ? ORDER BY created_at DESC", [bookingId], callback);
}
// PUT .../refund — how much has actually been refunded so far.
function getAlreadyRefundedAmount(bookingId) {
    return promisedGet(
        `SELECT COALESCE(SUM(amount), 0) AS already_refunded FROM transactions
             WHERE booking_id = ? AND transaction_type = 'refund' AND is_duplicate = 0 AND (status = 'completed' OR status IS NULL)`,
        [bookingId]);
}
// PUT .../refund — records the refund itself.
function insertRefundTransaction(bookingId, amt, refundReference, notes) {
    return promised(
        `INSERT INTO transactions (booking_id, amount, transaction_date, payment_method, reference, transaction_type, status, notes, source)
             VALUES (?, ?, DATE('now'), 'bank_transfer', ?, 'refund', 'completed', ?, 'admin_refund')`,
        [bookingId, amt, refundReference, notes]);
}
// POST .../reconcile/sync — the transaction-ledger total this route reconciles the booking to.
function getTransactionsPaidSumForReconcile(bookingId, callback) {
    db.get(
        `SELECT
            COALESCE(SUM(CASE WHEN (t.source != 'payfast' OR t.is_verified = 1) AND COALESCE(t.is_duplicate, 0) = 0 AND t.status = 'completed' THEN (CASE WHEN t.transaction_type = 'refund' THEN -t.amount WHEN t.transaction_type = 'adjustment' THEN 0 ELSE t.amount END) ELSE 0 END), 0) AS tx_paid
         FROM transactions t
         WHERE t.booking_id = ?`,
        [bookingId], callback);
}
// POST /api/admin/transactions/manual — the core transaction record (payment/refund/adjustment
// all share this one INSERT; only the booking-ledger UPDATE afterwards differs by branch, and
// those already live in the bookings repository).
function insertManualTransaction(bookingId, amt, transactionType, normalizedMethod, reference, finalNotes, txDate, callback) {
    db.run(
        `INSERT INTO transactions (booking_id, amount, transaction_type, payment_method, reference, notes, transaction_date, source, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'manual', 'completed', CURRENT_TIMESTAMP)`,
        [bookingId, amt, transactionType, normalizedMethod, reference, finalNotes, txDate], callback);
}
// GET /api/admin/financials/analytics — 12-month revenue trend (deferred whole from the
// invoices+quotations domain; its invoices-only aging query is now in that repository, and its
// bookings/clients-joined queries stay in server.js — this is its one finance-only statement).
function getTransactionRevenueTrend(callback) {
    db.all(
        `
        SELECT strftime('%Y-%m', transaction_date) AS month, SUM(amount) AS total_revenue
        FROM transactions
        WHERE status = 'completed' AND COALESCE(is_duplicate, 0) = 0
          AND transaction_date >= DATE('now', '-12 months')
        GROUP BY month
        ORDER BY month ASC
    `,
        [], callback);
}
// GET /api/admin/finance/pl — revWhere/params are assembled in server.js from query-string date
// filters (business logic, not data access); only the final db.all call, with groupFormat and the
// already-built clause, moved.
function getTransactionRevenueByPeriod(groupFormat, whereClause, params, callback) {
    db.all(
        `SELECT strftime('${groupFormat}', transaction_date) AS period,
                COALESCE(SUM(amount), 0) AS revenue
         FROM transactions t
         ${whereClause}
         GROUP BY period ORDER BY period ASC`,
        params, callback);
}
// GET /api/admin/financials/stats — period-scoped revenue.
function getPeriodRevenue(periodFrom, periodTo, callback) {
    db.get(
        `
        SELECT COALESCE(SUM(t.amount), 0) AS period_revenue
        FROM transactions t
        WHERE t.status = 'completed'
          AND COALESCE(t.is_duplicate, 0) = 0
          AND DATE(t.transaction_date) >= ?
          AND DATE(t.transaction_date) <= ?
    `,
        [periodFrom, periodTo], callback);
}
function getTotalTransactionCount(callback) {
    db.get('SELECT COUNT(*) AS total FROM transactions', [], callback);
}
// GET /api/admin/reconciliation/:bookingId/transactions
function getCompletedTransactionsForReconciliation(bookingId, callback) {
    db.all(
        `SELECT id, amount, source, payment_method, reference, transaction_date, status, is_duplicate, reconcile_note
         FROM transactions WHERE booking_id = ? AND status = 'completed' ORDER BY transaction_date DESC`,
        [bookingId], callback);
}
// PATCH /api/admin/transactions/:id/reconcile
function setTransactionDuplicateFlag(flag, note, id, callback) {
    db.run(
        `UPDATE transactions SET is_duplicate = ?, reconcile_note = ? WHERE id = ?`,
        [flag, note, id], callback);
}
// anonymizeClientData() (POPIA) — only ip_address/notes/reconcile_note are cleared; amount,
// dates, and reference are left untouched (SARS financial-record retention).
function redactTransactionForErasure(bookingPh, bookingIds) {
    return promised(`UPDATE transactions SET ip_address = NULL, notes = NULL, reconcile_note = NULL WHERE booking_id IN (${bookingPh})`, bookingIds);
}
// GET /api/admin/popia/requests/:id preview
function countTransactionsForIds(bookingPh, bookingIds) {
    return promisedGet(`SELECT COUNT(*) AS c FROM transactions WHERE booking_id IN (${bookingPh})`, bookingIds);
}

// ══════════════════════════════════════════════════════════════════════════
// cancellations
// ══════════════════════════════════════════════════════════════════════════

// anonymizeClientData() (POPIA) — redact free-text; amount/date/reference figures survive.
function redactCancellationForErasure(bookingPh, bookingIds) {
    return promised(`UPDATE cancellations SET reason = '[Redacted per POPIA erasure request]', notes = NULL WHERE booking_id IN (${bookingPh})`, bookingIds);
}
// cancelActiveBookingsForErasure() (POPIA) — distinct columns from the two admin-cancel-path
// variants below (hardcodes cancelled_by='client', no notes/admin_id).
function insertCancellationForErasure(bookingId, cancelReason, totalPaid, refundDue, retention) {
    return promised(
        `INSERT INTO cancellations (booking_id, cancelled_by, reason, total_paid_to_date, refund_due, retention_amount, refund_status)
             VALUES (?, 'client', ?, ?, ?, ?, 'pending')
             ON CONFLICT(booking_id) DO UPDATE SET
                cancelled_by = 'client', reason = excluded.reason, total_paid_to_date = excluded.total_paid_to_date,
                refund_due = excluded.refund_due, retention_amount = excluded.retention_amount, refund_status = 'pending', cancelled_at = CURRENT_TIMESTAMP`,
        [bookingId, cancelReason, totalPaid, refundDue, retention]);
}
// POST /api/admin/bookings/:id/cancel — distinct columns (adds notes/admin_id, cancelled_by is a
// parameter not a literal) from both other variants.
function insertCancellationForAdminCancel(bookingId, cancelledBy, reason, totalPaid, refundDue, retention, notes, adminId) {
    return promised(
        `INSERT INTO cancellations (booking_id, cancelled_by, reason, total_paid_to_date, refund_due, retention_amount, notes, admin_id, refund_status)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')
                        ON CONFLICT(booking_id) DO UPDATE SET
                            cancelled_by = excluded.cancelled_by, reason = excluded.reason,
                            total_paid_to_date = excluded.total_paid_to_date, refund_due = excluded.refund_due,
                            retention_amount = excluded.retention_amount, notes = excluded.notes,
                            admin_id = excluded.admin_id, refund_status = excluded.refund_status,
                            cancelled_at = CURRENT_TIMESTAMP`,
        [bookingId, cancelledBy, reason, totalPaid, refundDue, retention, notes, adminId]);
}
// applyStatusChange()'s CANCELLED branch — hardcodes cancelled_by='comedian' (the CHECK
// constraint doesn't allow 'admin'; attribution to the actual admin stays on bookings.cancelled_by).
function insertCancellationForStatusChange(bookingId, reason, totalPaid, refundDue, retention, callback) {
    db.run(`INSERT INTO cancellations (booking_id, cancelled_by, reason, total_paid_to_date, refund_due, retention_amount, refund_status)
                                VALUES (?, 'comedian', ?, ?, ?, ?, 'pending')
                                ON CONFLICT(booking_id) DO UPDATE SET
                                cancelled_by='comedian', reason=excluded.reason, total_paid_to_date=excluded.total_paid_to_date,
                                refund_due=excluded.refund_due, retention_amount=excluded.retention_amount, refund_status='pending'`,
        [bookingId, reason, totalPaid, refundDue, retention], callback);
}
// POST /api/public/bookings/:id/cancel — the public self-cancel route's own variant: adds
// reason_code, has no notes/admin_id, distinct from all 3 admin-side variants above.
function insertCancellationForPublicCancel(bookingId, reason, reasonCode, totalPaid, refundDue, retention) {
    return promised(
        `INSERT INTO cancellations (booking_id, cancelled_by, reason, reason_code, total_paid_to_date, refund_due, retention_amount, refund_status)
                            VALUES (?, 'client', ?, ?, ?, ?, ?, 'pending')
                            ON CONFLICT(booking_id) DO UPDATE SET cancelled_by='client', reason=excluded.reason, reason_code=excluded.reason_code, refund_status='pending'`,
        [bookingId, reason, reasonCode, totalPaid, refundDue, retention]);
}
// POST /api/public/bookings/:id/track — client-facing cancellation summary.
function getCancellationSummaryForTracking(bookingId, callback) {
    db.get("SELECT refund_due, refund_amount, refund_status, refunded_at, reason FROM cancellations WHERE booking_id = ?",
        [bookingId], callback);
}
// GET /api/admin/bookings/:id/details — full row for the admin deal-view.
function getCancellationDetailForBooking(bookingId, callback) {
    db.get("SELECT * FROM cancellations WHERE booking_id = ?", [bookingId], callback);
}
// PUT .../refund — reject on error (the route's own try/catch handles it).
function getCancellationForRefund(bookingId) {
    return promisedGet("SELECT * FROM cancellations WHERE booking_id = ?", [bookingId]);
}
function updateCancellationRefund(cumulativeRefund, cumulativeReference, cumulativeNotes, bookingId) {
    return promised(
        `UPDATE cancellations SET refund_status = 'processed', refund_amount = ?, refund_reference = ?, refund_notes = ?, refunded_at = CURRENT_TIMESTAMP WHERE booking_id = ?`,
        [cumulativeRefund, cumulativeReference, cumulativeNotes, bookingId]);
}
// GET /api/admin/popia/requests/:id preview
function countCancellationsForIds(bookingPh, bookingIds) {
    return promisedGet(`SELECT COUNT(*) AS c FROM cancellations WHERE booking_id IN (${bookingPh})`, bookingIds);
}

// ══════════════════════════════════════════════════════════════════════════
// payment_logs
// ══════════════════════════════════════════════════════════════════════════

// anonymizeClientData() (POPIA)
function redactPaymentLogsForErasure(bookingPh, bookingIds) {
    return promised(`UPDATE payment_logs SET raw_payload = NULL WHERE booking_id IN (${bookingPh})`, bookingIds);
}
// GET /api/admin/popia/requests/:id preview
function countPaymentLogsForIds(bookingPh, bookingIds) {
    return promisedGet(`SELECT COUNT(*) AS c FROM payment_logs WHERE booking_id IN (${bookingPh})`, bookingIds);
}

// ══════════════════════════════════════════════════════════════════════════
// expenses
// ══════════════════════════════════════════════════════════════════════════

// sendAdminCompletionSummaryEmail() — the P&L view on a booking-completed notification. Matches
// the original inline `new Promise(resolve => ...)` exactly: never rejects, resolves [] on error.
function getExpensesForBookingEmail(bookingId) {
    return new Promise(resolve => {
        db.all("SELECT description, amount FROM expenses WHERE booking_id = ? ORDER BY created_at ASC",
            [bookingId], (e, rows) => resolve(e ? [] : (rows || [])));
    });
}
// POST /api/admin/expenses
function insertExpense(values, callback) {
    db.run(
        `INSERT INTO expenses (booking_id, category, amount, description, expense_date, receipt_url,
            start_odometer, end_odometer, rate_per_km,
            per_diem_days, per_diem_rate,
            vat_paid, vat_rate, vendor, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        values, callback);
}
// Shared by DELETE and PUT /api/admin/expenses/:id — byte-identical single-quoted SQL.
function getActiveExpenseById(id, callback) {
    db.get('SELECT * FROM expenses WHERE id = ? AND deleted_at IS NULL', [id], callback);
}
function softDeleteExpense(id, callback) {
    db.run('UPDATE expenses SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?', [id], callback);
}
function updateExpense(values, callback) {
    db.run(
        `UPDATE expenses SET
                booking_id=?, category=?, amount=?, description=?, expense_date=?, receipt_url=?,
                start_odometer=?, end_odometer=?, rate_per_km=?,
                per_diem_days=?, per_diem_rate=?, vat_paid=?, vat_rate=?, vendor=?,
                updated_at=CURRENT_TIMESTAMP
             WHERE id=?`,
        values, callback);
}
// GET /api/admin/bookings/:id/expenses
function getExpensesForBooking(bookingId, callback) {
    db.all('SELECT * FROM expenses WHERE booking_id = ? AND deleted_at IS NULL ORDER BY expense_date DESC', [bookingId], callback);
}
// GET /api/admin/finance/pl — expWhere/params assembled in server.js (mirrors
// getTransactionRevenueByPeriod's treatment above).
function getExpensesByPeriod(groupFormat, whereClause, params, callback) {
    db.all(
        `SELECT strftime('${groupFormat}', expense_date) AS period,
                        COALESCE(SUM(amount), 0) AS expenses
                 FROM expenses e
                 ${whereClause}
                 GROUP BY period ORDER BY period ASC`,
        params, callback);
}
// GET /api/admin/financials/analytics — 12-month expense trend (deferred-route completion, see
// getTransactionRevenueTrend above).
function getExpenseTrend(callback) {
    db.all(
        `
        SELECT strftime('%Y-%m', expense_date) AS month, SUM(amount) AS total_expenses
        FROM expenses
        WHERE expense_date >= DATE('now', '-12 months')
        GROUP BY month
        ORDER BY month ASC
    `,
        [], callback);
}
// GET /api/admin/financials/stats — period-scoped expenses.
function getPeriodExpenses(periodFrom, periodTo, callback) {
    db.get(
        `SELECT COALESCE(SUM(amount), 0) AS period_expenses
                     FROM expenses
                     WHERE expense_date >= ? AND expense_date <= ? AND deleted_at IS NULL`,
        [periodFrom, periodTo], callback);
}

// ══════════════════════════════════════════════════════════════════════════
// bank_statement_lines
// ══════════════════════════════════════════════════════════════════════════

// UNUSED as of Phase 5 route batch 21 (HOUSEKEEPING-NOTES.md, Deferred fix #4). This backed
// POST /api/admin/bank-statement/import's insert loop, which wrapped this prepared statement in
// `db.transaction(() => {...})` — a better-sqlite3 API this app's plain sqlite3.Database doesn't
// have, so every import threw before a row was ever inserted. The route was rewritten to use
// withDbTransaction + dbRun instead (routes/admin/bank-statement.js), at the user's explicit
// request to fix this specific finding — an exception to the "housekeeping moves code, it doesn't
// fix bugs" rule that governed everything else in this effort. Left in place rather than deleted
// (no other caller) in case a future prepared-statement-based rewrite wants it back.
function prepareBankStatementLineInsert() {
    return db.prepare(
        `INSERT INTO bank_statement_lines (import_batch, import_date, statement_date, description, amount, reference)
         VALUES (?, ?, ?, ?, ?, ?)`
    );
}
// GET /api/admin/bank-statement/lines — the per-batch summary (the per-line list itself LEFT
// JOINs bookings and stays in server.js).
function getBankStatementImportBatches(callback) {
    db.all(
        `SELECT import_batch, import_date, COUNT(*) AS line_count,
                    SUM(CASE WHEN matched_booking_id IS NULL AND matched_transaction_id IS NULL THEN 1 ELSE 0 END) AS unmatched_count
             FROM bank_statement_lines GROUP BY import_batch ORDER BY import_date DESC`,
        [], callback);
}
// PATCH /api/admin/bank-statement/lines/:id/match
function matchBankStatementLine(bookingId, transactionId, matchNote, id, callback) {
    db.run(
        `UPDATE bank_statement_lines SET matched_booking_id=?, matched_transaction_id=?, match_note=? WHERE id=?`,
        [bookingId, transactionId, matchNote, id], callback);
}
// DELETE /api/admin/bank-statement/lines/:id
function deleteBankStatementLine(id, callback) {
    db.run('DELETE FROM bank_statement_lines WHERE id = ?', [id], callback);
}
// DELETE /api/admin/bank-statement/batch/:batchId
function deleteBankStatementBatch(batchId, callback) {
    db.run('DELETE FROM bank_statement_lines WHERE import_batch = ?', [batchId], callback);
}

module.exports = {
    getLivePaymentScheduleCount, getPaidPaymentScheduleSum, insertPaymentScheduleMilestone,
    getPaymentSchedulesForDocument, flagOverduePaymentSchedules,
    getActiveScheduleRowsForAlignment, markScheduleRowsPaid, markScheduleRowsPending,
    getActivePaymentSchedules, deletePaymentSchedulesForBooking,
    prepareInsertPaymentSchedule, prepareUpdatePaymentScheduleAmount,
    cancelPendingPaymentSchedules, cancelPendingPaymentSchedulesAsync,
    supersedePaymentSchedulesForRequote, getPaymentSchedulesForPayfastInit, getPaymentSchedulesForTracking,

    getPayfastTransactionByReference, insertPayfastTransaction,
    insertPaymentLogEntry, insertLoggedPaymentTransaction, getPaymentLogsForBooking,
    getRecentPayfastTransactionForBooking, getCancellationsWithRefundedTotals,
    getTransactionsForBooking, getAlreadyRefundedAmount, insertRefundTransaction,
    getTransactionsPaidSumForReconcile, insertManualTransaction,
    getTransactionRevenueTrend, getTransactionRevenueByPeriod, getPeriodRevenue, getTotalTransactionCount,
    getCompletedTransactionsForReconciliation, setTransactionDuplicateFlag, countTransactionsForIds,
    redactTransactionForErasure,

    redactCancellationForErasure, insertCancellationForErasure, insertCancellationForAdminCancel,
    insertCancellationForStatusChange, insertCancellationForPublicCancel,
    getCancellationSummaryForTracking, getCancellationDetailForBooking,
    getCancellationForRefund, updateCancellationRefund, countCancellationsForIds,

    redactPaymentLogsForErasure, countPaymentLogsForIds,

    getExpensesForBookingEmail, insertExpense, getActiveExpenseById, softDeleteExpense, updateExpense,
    getExpensesForBooking, getExpensesByPeriod, getExpenseTrend, getPeriodExpenses,

    prepareBankStatementLineInsert, getBankStatementImportBatches, matchBankStatementLine,
    deleteBankStatementLine, deleteBankStatementBatch,
};
