const express = require('express');
const db = require('../../database');
const { requireAdmin } = require('../../middleware/auth');
const { requireRole } = require('../../middleware/rbac');
const { exportRateLimiter } = require('../../middleware/rate-limiters');
const { dbGet, dbAll } = require('../../lib/db-helpers');
const { encodeUserHtml } = require('../../lib/html-sanitize');
const {
    resolvePopiaTargets, getBookingErasureImpact, POPIA_REASONS,
    createPopiaRequest, approvePopiaRequest, rejectPopiaRequest,
    processPopiaRequest, completePopiaAnonymization, deletePopiaFiles, notifyPopiaCancellations
} = require('../../lib/popia');
const { countBookingNotesForIds } = require('../../database/repositories/bookings.repository');
const { countTransactionsForIds, countCancellationsForIds, countPaymentLogsForIds } = require('../../database/repositories/finance.repository');
const { countQuotationsForIds, countQuotationsForClientIds } = require('../../database/repositories/invoices-quotations.repository');
const { countInquiryNotesForIds } = require('../../database/repositories/inquiries.repository');
const router = express.Router();

// ==========================================
// POPIA Data Erasure — admin request management
// ==========================================

// List/search/filter/paginate — mirrors GET /api/admin/audit_log's query-param shape.
router.get('/api/admin/popia/requests', requireAdmin, (req, res) => {
    const limit = parseInt(req.query.limit) || 25;
    const page = parseInt(req.query.page) || 1;
    const offset = (page - 1) * limit;
    const status = req.query.status || null;
    const source = req.query.source || null;
    const search = req.query.search || '';
    const dateFrom = req.query.date_from || null;
    const dateTo = req.query.date_to || null;

    let conditions = [];
    let params = [];
    if (status) { conditions.push("status = ?"); params.push(status); }
    if (source) { conditions.push("source = ?"); params.push(source); }
    if (dateFrom) { conditions.push("date(requested_at) >= ?"); params.push(dateFrom); }
    if (dateTo) { conditions.push("date(requested_at) <= ?"); params.push(dateTo); }
    if (search) { conditions.push("(email LIKE ? OR reference_number LIKE ?)"); params.push(`%${search}%`, `%${search}%`); }
    const whereString = conditions.length ? " WHERE " + conditions.join(" AND ") : "";

    db.all(`SELECT * FROM popia_erasure_requests${whereString} ORDER BY requested_at DESC LIMIT ? OFFSET ?`, [...params, limit, offset], (err, rows) => {
        if (err) { console.error('[POPIA] list query failed:', err.message); return res.status(500).json({ success: false, message: 'Could not load erasure requests.' }); }
        db.get(`SELECT COUNT(*) AS total FROM popia_erasure_requests${whereString}`, params, (cErr, cRow) => {
            const total = cErr ? (rows || []).length : (parseInt(cRow && cRow.total) || 0);
            res.json({ success: true, requests: rows || [], total, page, totalPages: Math.ceil(total / limit) || 1 });
        });
    });
});

// CSV export — same filter params as the list endpoint.
router.get('/api/admin/popia/requests/export', requireAdmin, requireRole(['administrator', 'manager']), exportRateLimiter, (req, res) => {
    const status = req.query.status || null;
    const source = req.query.source || null;
    const search = req.query.search || '';
    const dateFrom = req.query.date_from || null;
    const dateTo = req.query.date_to || null;

    let conditions = [];
    let params = [];
    if (status) { conditions.push("status = ?"); params.push(status); }
    if (source) { conditions.push("source = ?"); params.push(source); }
    if (dateFrom) { conditions.push("date(requested_at) >= ?"); params.push(dateFrom); }
    if (dateTo) { conditions.push("date(requested_at) <= ?"); params.push(dateTo); }
    if (search) { conditions.push("(email LIKE ? OR reference_number LIKE ?)"); params.push(`%${search}%`, `%${search}%`); }
    const whereString = conditions.length ? " WHERE " + conditions.join(" AND ") : "";

    const cols = ['id', 'reference_number', 'email', 'reason', 'reason_other_text', 'additional_comments', 'source', 'status', 'requested_at', 'requested_ip', 'reviewed_by_name', 'reviewed_at', 'review_notes', 'processed_by_name', 'processed_at', 'affected_tables_json', 'error_message'];
    db.all(`SELECT ${cols.join(', ')} FROM popia_erasure_requests${whereString} ORDER BY requested_at DESC`, params, (err, rows) => {
        if (err) return res.status(500).send('Export failed');
        const escapeCsv = (v) => { if (v == null) return ''; const s = String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
        const csv = [cols.join(',')].concat((rows || []).map(r => cols.map(c => escapeCsv(r[c])).join(','))).join('\n');
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="popia-erasure-requests-${new Date().toISOString().slice(0, 10)}.csv"`);
        res.send(csv);
    });
});

// Detail + a live COUNT-only preview of what processing would affect. The preview reuses
// resolvePopiaTargets so it can never drift from what anonymizeClientData would actually touch.
router.get('/api/admin/popia/requests/:id', requireAdmin, async (req, res) => {
    try {
        const row = await dbGet(`SELECT * FROM popia_erasure_requests WHERE id = ?`, [req.params.id]);
        if (!row) return res.status(404).json({ success: false, message: 'Request not found.' });

        const { clientIds, bookingIds, inquiryIds, bookingPh, clientPh, inquiryPh } = await resolvePopiaTargets(row.email);
        const preview = {
            clients: clientIds.length, bookings: bookingIds.length, inquiries: inquiryIds.length,
            contracts: 0, booking_notes: 0, quotations: 0, transactions: 0, cancellations: 0, service_reviews: 0, payment_logs: 0, inquiry_notes: 0
        };
        if (bookingIds.length) {
            const [contracts, notes, quotes, txns, cancels, reviews, payLogs] = await Promise.all([
                dbGet(`SELECT COUNT(*) AS c FROM contracts WHERE booking_id IN (${bookingPh})`, bookingIds),
                countBookingNotesForIds(bookingPh, bookingIds),
                countQuotationsForIds(bookingPh, bookingIds),
                countTransactionsForIds(bookingPh, bookingIds),
                countCancellationsForIds(bookingPh, bookingIds),
                dbGet(`SELECT COUNT(*) AS c FROM service_reviews WHERE booking_id IN (${bookingPh})`, bookingIds),
                countPaymentLogsForIds(bookingPh, bookingIds)
            ]);
            preview.contracts = contracts.c; preview.booking_notes = notes.c; preview.quotations = quotes.c;
            preview.transactions = txns.c; preview.cancellations = cancels.c; preview.service_reviews = reviews.c; preview.payment_logs = payLogs.c;
        }
        if (clientIds.length) {
            const extraQuotes = await countQuotationsForClientIds(clientPh, clientIds);
            preview.quotations += extraQuotes.c;
        }
        if (inquiryIds.length) {
            const notes = await countInquiryNotesForIds(inquiryPh, inquiryIds);
            preview.inquiry_notes = notes.c;
        }

        // Booking-impact: for a not-yet-processed request this is a hypothetical preview (same scope
        // rule and calculateCancellationRefund() figures the real processing step will apply). Once a
        // request reaches awaiting_refund the bookings have ALREADY been cancelled — their status is
        // now 'CANCELLED', which getBookingErasureImpact would (correctly, for a future cancellation)
        // treat as out of scope, silently going empty here. So this branch instead reads back the
        // real cancellations rows that were created, plus how much has actually been refunded so far.
        let pendingRefundBookingIds = [];
        let bookingImpact;
        if (row.status === 'awaiting_refund') {
            let storedBookingIds = [];
            try { storedBookingIds = JSON.parse(row.affected_tables_json || '{}').pending_refund_booking_ids || []; } catch (e) {}
            bookingImpact = storedBookingIds.length ? await dbAll(
                `SELECT b.id AS booking_id, b.event_name, b.event_type, b.date,
                        c.total_paid_to_date AS amount_paid, c.refund_due AS estimated_refund_due, c.retention_amount AS estimated_retention,
                        COALESCE((SELECT SUM(t.amount) FROM transactions t WHERE t.booking_id = b.id AND t.transaction_type = 'refund' AND t.status = 'completed'), 0) AS refunded_so_far
                 FROM bookings b JOIN cancellations c ON c.booking_id = b.id
                 WHERE b.id IN (${storedBookingIds.map(() => '?').join(',')})`,
                storedBookingIds
            ) : [];
            // Re-derive which of the originally-flagged bookings are STILL unresolved right now —
            // the stored list is a snapshot from when processing first ran, and would otherwise keep
            // the "Complete Anonymization" button disabled even after a refund has since been recorded.
            pendingRefundBookingIds = bookingImpact
                .filter(b => Number(b.refunded_so_far) < Number(b.estimated_refund_due))
                .map(b => b.booking_id);
        } else {
            bookingImpact = await getBookingErasureImpact(bookingIds);
        }

        res.json({ success: true, request: row, preview, booking_impact: bookingImpact, pending_refund_booking_ids: pendingRefundBookingIds });
    } catch (e) {
        console.error('[POPIA] detail query failed:', e.message);
        res.status(500).json({ success: false, message: 'Could not load request detail.' });
    }
});

router.put('/api/admin/popia/requests/:id/approve', requireAdmin, requireRole(['administrator']), async (req, res) => {
    const outcome = await approvePopiaRequest(req.params.id, req.session.adminId, req.session.username);
    if (!outcome.ok) return res.status(outcome.status).json(outcome.body);
    res.json({ success: true, message: 'Request approved.' });
});

router.put('/api/admin/popia/requests/:id/reject', requireAdmin, requireRole(['administrator']), async (req, res) => {
    const notes = String(req.body?.review_notes || '').trim();
    if (!notes) return res.status(400).json({ success: false, message: 'Review notes are required when rejecting a request.' });
    const outcome = await rejectPopiaRequest(req.params.id, req.session.adminId, req.session.username, encodeUserHtml(notes));
    if (!outcome.ok) return res.status(outcome.status).json(outcome.body);
    res.json({ success: true, message: 'Request rejected.' });
});

router.post('/api/admin/popia/requests/:id/process', requireAdmin, requireRole(['administrator']), async (req, res) => {
    const outcome = await processPopiaRequest(req.params.id, req.session.adminId, req.session.username);
    if (!outcome.ok) return res.status(outcome.status).json(outcome.body);
    notifyPopiaCancellations(outcome.calendarIdsToDelete, outcome.notificationSnapshots);
    if (outcome.awaitingRefund) {
        return res.json({
            success: true,
            message: 'An active/partially-paid booking was cancelled and a refund is now owing — anonymization will complete once that refund is recorded.',
            awaiting_refund: true,
            pending_booking_ids: outcome.pendingBookingIds
        });
    }
    deletePopiaFiles(outcome.filesToDelete);
    res.json({ success: true, message: 'Request processed — data anonymized.', affected: outcome.affected });
});

// Called once an admin has recorded a sufficient refund (via the existing PUT .../refund route) for
// every booking that blocked completion. Re-checks the refund gate server-side rather than trusting
// the click.
router.post('/api/admin/popia/requests/:id/complete-anonymization', requireAdmin, requireRole(['administrator']), async (req, res) => {
    const outcome = await completePopiaAnonymization(req.params.id, req.session.adminId, req.session.username);
    if (!outcome.ok) return res.status(outcome.status).json(outcome.body);
    deletePopiaFiles(outcome.filesToDelete);
    res.json({ success: true, message: 'Refund(s) resolved — data anonymized.', affected: outcome.affected });
});

// Admin-initiated create — this is what the request list's "Anonymize Now" quick action calls.
// With auto_process:true it chains create -> approve -> process inline in one request.
router.post('/api/admin/popia/requests', requireAdmin, requireRole(['administrator']), async (req, res) => {
    const { email, reason, additional_comments, auto_process } = req.body || {};
    const emailNorm = typeof email === 'string' ? email.trim() : '';
    if (!emailNorm || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(emailNorm)) {
        return res.status(400).json({ success: false, message: 'A valid email address is required.' });
    }
    const reasonNorm = POPIA_REASONS.includes(reason) ? reason : 'other';

    const created = await createPopiaRequest({
        email: emailNorm, reason: reasonNorm,
        reasonOtherText: reasonNorm === 'other' ? 'Submitted directly by an administrator' : null,
        additionalComments: additional_comments ? encodeUserHtml(String(additional_comments).trim().slice(0, 2000)) : null,
        source: 'admin', ip: req.ip, userAgent: req.get('User-Agent') || null, actorEmail: req.session.username
    });
    if (!created.ok) return res.status(created.status).json(created.body);

    if (!auto_process) {
        return res.json({ success: true, message: 'Request created.', id: created.id, reference_number: created.reference_number });
    }

    const approved = await approvePopiaRequest(created.id, req.session.adminId, req.session.username);
    if (!approved.ok) return res.status(approved.status).json(approved.body);
    const processed = await processPopiaRequest(created.id, req.session.adminId, req.session.username);
    if (!processed.ok) return res.status(processed.status).json(processed.body);

    notifyPopiaCancellations(processed.calendarIdsToDelete, processed.notificationSnapshots);

    if (processed.awaitingRefund) {
        return res.json({
            success: true,
            message: 'Request created. An active/partially-paid booking was cancelled and a refund is now owing — anonymization will complete once that refund is recorded.',
            id: created.id, reference_number: created.reference_number,
            awaiting_refund: true, pending_booking_ids: processed.pendingBookingIds
        });
    }

    deletePopiaFiles(processed.filesToDelete);

    res.json({ success: true, message: 'Request created and processed — data anonymized.', id: created.id, reference_number: created.reference_number, affected: processed.affected });
});

// --- GDPR / POPIA Data Deletion (Anonymization) ---
// Legacy one-click compatibility wrapper — kept so existing callers keep working, but now delegates
// into the same create -> approve -> process chain as every other erasure entry point, so this
// route produces a fully reviewable/auditable popia_erasure_requests row instead of a bare
// audit_log line, and reuses anonymizeClientData's full table coverage instead of its own
// 5-table subset. Response shape (success/message/affected) is preserved for existing callers.
router.post('/api/admin/gdpr/delete', requireAdmin, requireRole(['administrator']), async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, message: 'Email address is required for deletion.' });
    const emailNorm = String(email).trim();

    const adminId = req.session.adminId;
    const adminName = req.session.username;
    const ip = req.ip;

    console.log(`[GDPR] Deletion request for ${emailNorm} initiated by Admin ID: ${adminId}`);

    const created = await createPopiaRequest({
        email: emailNorm, reason: 'other', reasonOtherText: 'Submitted via legacy admin one-click GDPR delete tool',
        source: 'admin', ip, userAgent: req.get('User-Agent') || null, actorEmail: adminName
    });
    if (!created.ok) return res.status(created.status).json(created.body);

    const approved = await approvePopiaRequest(created.id, adminId, adminName);
    if (!approved.ok) return res.status(approved.status).json(approved.body);

    const processed = await processPopiaRequest(created.id, adminId, adminName);
    if (!processed.ok) return res.status(processed.status).json(processed.body);

    notifyPopiaCancellations(processed.calendarIdsToDelete, processed.notificationSnapshots);

    if (processed.awaitingRefund) {
        return res.json({
            success: true,
            message: `An active/partially-paid booking was cancelled for ${emailNorm} and a refund is now owing — anonymization will complete once that refund is recorded.`,
            reference_number: created.reference_number,
            awaiting_refund: true,
            pending_booking_ids: processed.pendingBookingIds
        });
    }

    deletePopiaFiles(processed.filesToDelete);

    console.log(`[GDPR] Anonymized for ${emailNorm} (request #${created.id}):`, processed.affected);
    res.json({
        success: true,
        message: `All data associated with ${emailNorm} has been anonymized/deleted successfully.`,
        reference_number: created.reference_number,
        affected: processed.affected
    });
});

module.exports = router;
