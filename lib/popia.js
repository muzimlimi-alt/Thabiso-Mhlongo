// Phase 5 (HOUSEKEEPING-NOTES.md): POPIA/GDPR data-erasure subsystem, relocated from app.js
// verbatim (batch 14). Everything here is shared by three entry points: the admin request-
// management routes (routes/admin/popia.js — list/detail/approve/reject/process/complete/create,
// plus the legacy /api/admin/gdpr/delete one-click wrapper), and the not-yet-moved public
// self-service flow (POST /api/public/popia/erasure-requests, /api/public/popia/preview, and the
// legacy /api/public/compliance/request-forget) — app.js re-imports resolvePopiaTargets,
// getBookingErasureImpact, createPopiaRequest and POPIA_REASONS from here for that public flow.
// Only the functions with an external caller are exported; popiaReferenceNumber and
// isBookingInPopiaErasureScope stay private to this file.
const fs = require('fs');
const { withDbTransaction } = require('./db-transaction');
const { dbRun, dbGet, dbAll } = require('./db-helpers');
const { resolveDocsPath } = require('./runtime-paths');
const { calculateCancellationRefund } = require('./cancellation-refund');
const { deleteGoogleEvent } = require('./google-calendar');
const { sendCancellationEmail } = require('./booking-cancellation-email');

const {
    getBookingByIdAsync, getBookingIdsForEmail, anonymizeBookingsForErasure,
    deleteBookingAccessCodesForErasure, deleteBookingAccessTokensForErasure, redactBookingNotesForErasure,
    getBookingsByIds, cancelBookingForErasureAsync, clearBookingPublicAndEventIdAsync, clearBookingGoogleEventIdAsync
} = require('../database/repositories/bookings.repository');
const {
    cancelPendingPaymentSchedulesAsync, getCancellationsWithRefundedTotals, redactTransactionForErasure,
    redactCancellationForErasure, insertCancellationForErasure, redactPaymentLogsForErasure
} = require('../database/repositories/finance.repository');
const {
    getQuoteFilesForBookingIds, getQuoteFilesForClientIds, clearQuoteFilePathsForErasure,
    clearQuoteFilePathsForClientErasure, voidInvoicesForCancelledBookingAsync
} = require('../database/repositories/invoices-quotations.repository');
const { getInquiryIdsForEmail, anonymizeInquiriesForErasure, redactInquiryNotesForErasure } = require('../database/repositories/inquiries.repository');
const {
    releaseDateHoldsForBookingAsync, clearEventGoogleCalendarIdAsync, getEventByBookingId, demoteEventForCancelledBookingAsync
} = require('../database/repositories/calendar.repository');
const { deleteSubscriberForErasure } = require('../database/repositories/newsletter.repository');

// Resolves the id sets an erasure for `email` will touch — shared by anonymizeClientData (which
// runs the actual UPDATEs against these ids) and the admin preview endpoint (which only counts
// against them), so the two can never drift apart.
async function resolvePopiaTargets(email) {
    const clientIds = (await dbAll(`SELECT id FROM clients WHERE LOWER(email) = LOWER(?)`, [email])).map(r => r.id);
    const bookingIds = (await getBookingIdsForEmail(email)).map(r => r.id);
    const inquiryIds = (await getInquiryIdsForEmail(email)).map(r => r.inquiry_id);
    return {
        clientIds, bookingIds, inquiryIds,
        bookingPh: bookingIds.map(() => '?').join(','),
        clientPh: clientIds.map(() => '?').join(','),
        inquiryPh: inquiryIds.map(() => '?').join(',')
    };
}

// POPIA/GDPR erasure: anonymizes every table carrying this client's personal data, preserving
// financial/business records (amounts, dates, reference numbers, invoices) untouched. Issues no
// BEGIN/COMMIT/ROLLBACK of its own — callers must already be inside an open transaction (see the
// CAS-guarded /api/admin/popia/requests/:id/process route and the legacy /api/admin/gdpr/delete
// wrapper). Dependent id/file-path sets are resolved BEFORE any UPDATE runs, since the updates
// below overwrite the very email columns those lookups join on.
async function anonymizeClientData(email) {
    const affected = {};
    const filesToDelete = { contracts: [], quotations: [] };

    const { clientIds, bookingIds, inquiryIds, bookingPh, clientPh, inquiryPh } = await resolvePopiaTargets(email);

    if (bookingIds.length) {
        const contractFiles = await dbAll(`SELECT pdf_url FROM contracts WHERE booking_id IN (${bookingPh}) AND pdf_url IS NOT NULL`, bookingIds);
        filesToDelete.contracts.push(...contractFiles.map(r => r.pdf_url));
        const quoteFiles = await getQuoteFilesForBookingIds(bookingPh, bookingIds);
        filesToDelete.quotations.push(...quoteFiles.map(r => r.file_path));
    }
    if (clientIds.length) {
        const quoteFilesByClient = await getQuoteFilesForClientIds(clientPh, clientIds);
        filesToDelete.quotations.push(...quoteFilesByClient.map(r => r.file_path));
    }

    let r;

    // 1. Clients — carried over from the legacy /api/admin/gdpr/delete route.
    r = await dbRun(`UPDATE clients SET
            full_name = 'POPIA ANONYMIZED', company_name = NULL, phone = '0000000000',
            billing_address = NULL, tax_id = NULL, vat_number = NULL,
            email = 'deleted-' || id || '@po-pia.com', updated_at = CURRENT_TIMESTAMP
            WHERE LOWER(email) = LOWER(?)`, [email]);
    affected.clients = r.changes;

    // 2. Bookings — per-row-unique placeholder email (the legacy route used one flat literal,
    // which made two different erased clients indistinguishable on the same booking list).
    r = await anonymizeBookingsForErasure(email);
    affected.bookings = r.changes;

    // 3. Inquiries
    r = await anonymizeInquiriesForErasure(email);
    affected.inquiries = r.changes;

    // 4. Newsletter subscription — no historical value once erased.
    r = await deleteSubscriberForErasure(email);
    affected.newsletter_subscribers = r.changes;

    // 5. Communication log
    r = await dbRun(`UPDATE communication_log SET
            subject = '[DELETED]', content_snippet = '[DELETED]', user_email = 'deleted@po-pia.com'
            WHERE LOWER(user_email) = LOWER(?)`, [email]);
    affected.communication_log = r.changes;

    // Abandoned booking drafts
    r = await dbRun(`UPDATE abandoned_bookings SET
            name = 'POPIA ANONYMIZED', company = NULL, email = 'deleted-' || id || '@po-pia.com',
            cell = NULL, message = NULL, ip_address = NULL, user_agent = NULL
            WHERE LOWER(email) = LOWER(?)`, [email]);
    affected.abandoned_bookings = r.changes;

    // Short-lived tracker OTP/session secrets — nothing to preserve, hard delete.
    r = await deleteBookingAccessCodesForErasure(email);
    affected.booking_access_codes = r.changes;
    r = await deleteBookingAccessTokensForErasure(email);
    affected.booking_access_tokens = r.changes;

    r = await dbRun(`DELETE FROM popia_verification_codes WHERE LOWER(email) = LOWER(?)`, [email]);
    affected.popia_verification_codes = r.changes;

    r = await dbRun(`UPDATE email_logs SET recipient_email = 'deleted@po-pia.com', subject = '[DELETED]'
            WHERE LOWER(recipient_email) = LOWER(?)`, [email]);
    affected.email_logs = r.changes;

    r = await dbRun(`UPDATE reminders_log SET recipient_email = 'deleted@po-pia.com' WHERE LOWER(recipient_email) = LOWER(?)`, [email]);
    affected.reminders_log = r.changes;

    r = await dbRun(`UPDATE notifications SET
            recipient_email = 'deleted@po-pia.com', recipient_name = 'POPIA ANONYMIZED',
            subject = '[DELETED]', body = '[DELETED]'
            WHERE LOWER(recipient_email) = LOWER(?)`, [email]);
    affected.notifications = r.changes;

    r = await dbRun(`UPDATE advancing_contacts SET name = 'POPIA ANONYMIZED', phone = NULL, email = NULL
            WHERE LOWER(email) = LOWER(?)`, [email]);
    affected.advancing_contacts = r.changes;

    // Venues: contact fields only, direct match — a venue's listed contact isn't necessarily the
    // requesting client, so this never matches on booking/client id, only an exact email hit.
    r = await dbRun(`UPDATE venues SET contact_name = NULL, contact_phone = NULL, contact_email = NULL
            WHERE LOWER(contact_email) = LOWER(?)`, [email]);
    affected.venues = r.changes;

    // Direct emails: redact the target address wherever it appears in an address list; leave any
    // other recipients on the same thread untouched. subject/body free text is a documented,
    // disclosed gap — rewriting composed email content risks corruption for uncertain benefit.
    const likeEmail = `%${email}%`;
    r = await dbRun(`UPDATE direct_emails SET
            to_emails = REPLACE(to_emails, ?, 'deleted@po-pia.com'),
            cc_emails = REPLACE(cc_emails, ?, 'deleted@po-pia.com'),
            bcc_emails = REPLACE(bcc_emails, ?, 'deleted@po-pia.com'),
            reply_to = CASE WHEN LOWER(reply_to) = LOWER(?) THEN 'deleted@po-pia.com' ELSE reply_to END
            WHERE LOWER(to_emails) LIKE LOWER(?) OR LOWER(cc_emails) LIKE LOWER(?)
               OR LOWER(bcc_emails) LIKE LOWER(?) OR LOWER(reply_to) = LOWER(?)`,
            [email, email, email, email, likeEmail, likeEmail, likeEmail, email]);
    affected.direct_emails = r.changes;

    affected.contracts = 0;
    affected.booking_notes = 0;
    affected.quotations = 0;
    affected.transactions = 0;
    affected.cancellations = 0;
    affected.service_reviews = 0;
    affected.payment_logs = 0;
    if (bookingIds.length) {
        // Contract: null signature/IP/signed-by/builder_clauses, redact the rendered HTML, defer
        // physical PDF deletion until after COMMIT (a mid-transaction unlink can't be undone by a
        // rollback). contract_number/amount/status/signing timestamps survive — business record.
        r = await dbRun(`UPDATE contracts SET
                signed_by = NULL, client_ip_address = NULL, client_signature_data = NULL,
                builder_clauses = NULL, content_html = '[Content redacted per POPIA erasure request]',
                pdf_url = NULL
                WHERE booking_id IN (${bookingPh})`, bookingIds);
        affected.contracts = r.changes;

        r = await redactBookingNotesForErasure(bookingPh, bookingIds);
        affected.booking_notes = r.changes;

        r = await clearQuoteFilePathsForErasure(bookingPh, bookingIds);
        affected.quotations = r.changes;

        // Transactions: only ip_address/notes/reconcile_note are cleared — amount, dates, and
        // reference are left untouched (SARS financial-record retention).
        r = await redactTransactionForErasure(bookingPh, bookingIds);
        affected.transactions = r.changes;

        r = await redactCancellationForErasure(bookingPh, bookingIds);
        affected.cancellations = r.changes;

        r = await dbRun(`UPDATE service_reviews SET client_name = 'Anonymized Client' WHERE booking_id IN (${bookingPh})`, bookingIds);
        affected.service_reviews = r.changes;

        r = await redactPaymentLogsForErasure(bookingPh, bookingIds);
        affected.payment_logs = r.changes;
    }
    // Quotations can exist for a client with no booking yet (pre-booking quote) — caught separately.
    if (clientIds.length) {
        r = await clearQuoteFilePathsForClientErasure(clientPh, clientIds);
        affected.quotations += r.changes;
    }

    affected.inquiry_notes = 0;
    if (inquiryIds.length) {
        r = await redactInquiryNotesForErasure(inquiryPh, inquiryIds);
        affected.inquiry_notes = r.changes;
    }

    return { affected, filesToDelete };
}

// ==========================================
// POPIA Data Erasure — request lifecycle
// ==========================================
// A request is never actioned instantly from a public, unauthenticated call — it is recorded as
// a 'pending' row and only anonymized once an administrator reviews and approves it (see the
// /api/admin/popia/requests/:id/approve and /:id/process routes below). Every entry point below —
// the public form, the legacy public compat route, and the legacy admin one-click route — funnels
// through createPopiaRequest() so every erasure ends up as one fully audited request record.

const POPIA_REASONS = ['no_longer_a_client', 'privacy_concerns', 'no_longer_wish_to_be_contacted', 'duplicate_or_test_submission', 'incorrect_information_on_file', 'other'];

function popiaReferenceNumber(id) {
    return `POPIA-${new Date().getFullYear()}-${String(id).padStart(5, '0')}`;
}

async function createPopiaRequest({ email, reason, reasonOtherText, additionalComments, source, ip, userAgent, actorEmail }) {
    return withDbTransaction(async () => {
        try {
            await dbRun("BEGIN IMMEDIATE");
        } catch (beginErr) {
            console.error('[POPIA] createPopiaRequest BEGIN IMMEDIATE failed:', beginErr.message);
            return { status: 503, body: { success: false, message: 'We could not record your request just now. Please try again in a moment.' } };
        }
        try {
            const ins = await dbRun(
                `INSERT INTO popia_erasure_requests
                    (email, reason, reason_other_text, additional_comments, consequences_acknowledged, source, status, requested_ip, requested_user_agent)
                 VALUES (?, ?, ?, ?, 1, ?, 'pending', ?, ?)`,
                [email, reason, reasonOtherText || null, additionalComments || null, source, ip || null, userAgent || null]
            );
            const id = ins.lastID;
            const reference = popiaReferenceNumber(id);
            await dbRun(`UPDATE popia_erasure_requests SET reference_number = ? WHERE id = ?`, [reference, id]);
            await dbRun(
                `INSERT INTO audit_log (table_name, record_id, action, user_email, ip_address, changed_by, changes_json, change_timestamp)
                 VALUES ('popia_erasure_requests', ?, 'POPIA_ERASURE_REQUESTED', ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
                [id, email, ip || null, actorEmail || source, JSON.stringify({ reference_number: reference, reason, source })]
            );
            await dbRun("COMMIT");
            return { ok: true, id, reference_number: reference };
        } catch (txErr) {
            await dbRun("ROLLBACK").catch(() => {});
            console.error('[POPIA] createPopiaRequest failed:', txErr.message);
            return { status: 500, body: { success: false, message: 'Could not record your request. Please try again.' } };
        }
    });
}

async function approvePopiaRequest(id, adminId, adminName) {
    return withDbTransaction(async () => {
        try {
            await dbRun("BEGIN IMMEDIATE");
        } catch (e) {
            return { status: 503, body: { success: false, message: 'Database busy. Please retry.' } };
        }
        try {
            const upd = await dbRun(
                `UPDATE popia_erasure_requests SET status = 'approved', reviewed_by = ?, reviewed_by_name = ?, reviewed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
                 WHERE id = ? AND status = 'pending'`,
                [adminId, adminName, id]
            );
            if (upd.changes === 0) {
                await dbRun("ROLLBACK").catch(() => {});
                return { status: 409, body: { success: false, message: 'This request is not pending — it may have already been actioned.' } };
            }
            await dbRun(
                `INSERT INTO audit_log (table_name, record_id, action, changed_by, change_timestamp)
                 VALUES ('popia_erasure_requests', ?, 'POPIA_ERASURE_APPROVED', ?, CURRENT_TIMESTAMP)`,
                [id, adminName]
            );
            await dbRun("COMMIT");
            return { ok: true };
        } catch (txErr) {
            await dbRun("ROLLBACK").catch(() => {});
            console.error('[POPIA] approvePopiaRequest failed:', txErr.message);
            return { status: 500, body: { success: false, message: 'Approval failed. Transaction rolled back.' } };
        }
    });
}

async function rejectPopiaRequest(id, adminId, adminName, notes) {
    return withDbTransaction(async () => {
        try {
            await dbRun("BEGIN IMMEDIATE");
        } catch (e) {
            return { status: 503, body: { success: false, message: 'Database busy. Please retry.' } };
        }
        try {
            const upd = await dbRun(
                `UPDATE popia_erasure_requests SET status = 'rejected', reviewed_by = ?, reviewed_by_name = ?, reviewed_at = CURRENT_TIMESTAMP, review_notes = ?, updated_at = CURRENT_TIMESTAMP
                 WHERE id = ? AND status = 'pending'`,
                [adminId, adminName, notes, id]
            );
            if (upd.changes === 0) {
                await dbRun("ROLLBACK").catch(() => {});
                return { status: 409, body: { success: false, message: 'This request is not pending — it may have already been actioned.' } };
            }
            await dbRun(
                `INSERT INTO audit_log (table_name, record_id, action, changed_by, changes_json, change_timestamp)
                 VALUES ('popia_erasure_requests', ?, 'POPIA_ERASURE_REJECTED', ?, ?, CURRENT_TIMESTAMP)`,
                [id, adminName, JSON.stringify({ review_notes: notes })]
            );
            await dbRun("COMMIT");
            return { ok: true };
        } catch (txErr) {
            await dbRun("ROLLBACK").catch(() => {});
            console.error('[POPIA] rejectPopiaRequest failed:', txErr.message);
            return { status: 500, body: { success: false, message: 'Rejection failed. Transaction rolled back.' } };
        }
    });
}

// The CAS on status='approved' is what makes double-processing impossible even under a race —
// same pattern as the existing quote-acceptance CAS. On failure the anonymization itself rolls
// back, but the request is still durably marked 'failed' via a separate, un-rolled-back statement
// so the failure stays traceable.
async function processPopiaRequest(id, adminId, adminName) {
    return withDbTransaction(async () => {
        try {
            await dbRun("BEGIN IMMEDIATE");
        } catch (e) {
            return { status: 503, body: { success: false, message: 'Database busy. Please retry.' } };
        }
        try {
            const upd = await dbRun(
                `UPDATE popia_erasure_requests SET status = 'processing', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'approved'`,
                [id]
            );
            if (upd.changes === 0) {
                await dbRun("ROLLBACK").catch(() => {});
                return { status: 409, body: { success: false, message: 'This request is not approved — it may already be processing, processed, or was never approved.' } };
            }
            const requestRow = await dbGet(`SELECT email FROM popia_erasure_requests WHERE id = ?`, [id]);
            const targets = await resolvePopiaTargets(requestRow.email);
            const { cancelledBookingIds, calendarIdsToDelete, notificationSnapshots } = await cancelActiveBookingsForErasure(targets.bookingIds);

            // "All financial obligations resolved" is checked against every booking this email has —
            // not just the ones cancelled just now — so a refund left outstanding from an earlier,
            // unrelated cancellation also gates completion.
            const unresolvedBookingIds = await getUnresolvedRefundBookingIds(targets.bookingIds);
            if (unresolvedBookingIds.length > 0) {
                await dbRun(
                    `UPDATE popia_erasure_requests SET status = 'awaiting_refund', affected_tables_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
                    [JSON.stringify({ pending_refund_booking_ids: unresolvedBookingIds }), id]
                );
                await dbRun(
                    `INSERT INTO audit_log (table_name, record_id, action, changed_by, changes_json, change_timestamp)
                     VALUES ('popia_erasure_requests', ?, 'POPIA_ERASURE_AWAITING_REFUND', ?, ?, CURRENT_TIMESTAMP)`,
                    [id, adminName, JSON.stringify({ email: requestRow.email, pending_refund_booking_ids: unresolvedBookingIds })]
                );
                await dbRun("COMMIT");
                return { ok: true, awaitingRefund: true, pendingBookingIds: unresolvedBookingIds, cancelledBookingIds, calendarIdsToDelete, notificationSnapshots };
            }

            const { affected, filesToDelete } = await anonymizeClientData(requestRow.email);
            await dbRun(
                `UPDATE popia_erasure_requests SET status = 'processed', processed_by = ?, processed_by_name = ?, processed_at = CURRENT_TIMESTAMP, affected_tables_json = ?, updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?`,
                [adminId, adminName, JSON.stringify(affected), id]
            );
            await dbRun(
                `INSERT INTO audit_log (table_name, record_id, action, changed_by, changes_json, change_timestamp)
                 VALUES ('popia_erasure_requests', ?, 'DATA_ANONYMIZATION', ?, ?, CURRENT_TIMESTAMP)`,
                [id, adminName, JSON.stringify({ email: requestRow.email, affected })]
            );
            await dbRun("COMMIT");
            return { ok: true, affected, filesToDelete, cancelledBookingIds, calendarIdsToDelete, notificationSnapshots };
        } catch (txErr) {
            await dbRun("ROLLBACK").catch(() => {});
            console.error('[POPIA] processPopiaRequest failed:', txErr.message);
            try {
                await dbRun(`UPDATE popia_erasure_requests SET status = 'failed', error_message = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [txErr.message, id]);
                await dbRun(
                    `INSERT INTO audit_log (table_name, record_id, action, changed_by, changes_json, change_timestamp)
                     VALUES ('popia_erasure_requests', ?, 'POPIA_ERASURE_FAILED', ?, ?, CURRENT_TIMESTAMP)`,
                    [id, adminName, JSON.stringify({ error: txErr.message })]
                );
            } catch (followUpErr) {
                console.error('[POPIA] Failed to record failure state:', followUpErr.message);
            }
            return { status: 500, body: { success: false, message: 'Anonymization failed. Transaction rolled back; the request has been marked failed for review.' } };
        }
    });
}

// Called once an admin has manually recorded a sufficient refund (via the existing
// PUT /api/admin/bookings/:id/refund route) for every booking this request's processing flagged as
// awaiting_refund. Re-checks the exact same gate processPopiaRequest used — never trusts that the
// refunds are actually resolved just because this endpoint was called — before anonymizing.
async function completePopiaAnonymization(id, adminId, adminName) {
    return withDbTransaction(async () => {
        try {
            await dbRun("BEGIN IMMEDIATE");
        } catch (e) {
            return { status: 503, body: { success: false, message: 'Database busy. Please retry.' } };
        }
        try {
            const upd = await dbRun(
                `UPDATE popia_erasure_requests SET status = 'processing', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'awaiting_refund'`,
                [id]
            );
            if (upd.changes === 0) {
                await dbRun("ROLLBACK").catch(() => {});
                return { status: 409, body: { success: false, message: 'This request is not awaiting refund resolution — it may already be processed or was never in that state.' } };
            }
            const requestRow = await dbGet(`SELECT email, affected_tables_json FROM popia_erasure_requests WHERE id = ?`, [id]);
            let pendingBookingIds = [];
            try { pendingBookingIds = JSON.parse(requestRow.affected_tables_json || '{}').pending_refund_booking_ids || []; } catch (e) {}

            const stillUnresolved = await getUnresolvedRefundBookingIds(pendingBookingIds);
            if (stillUnresolved.length > 0) {
                // Rolls the transient 'processing' CAS write back to 'awaiting_refund' automatically —
                // nothing else needs to be undone since no other statement has run yet.
                await dbRun("ROLLBACK").catch(() => {});
                return { status: 409, body: { success: false, message: 'Some bookings still have an unresolved refund.', pendingBookingIds: stillUnresolved } };
            }

            const { affected, filesToDelete } = await anonymizeClientData(requestRow.email);
            await dbRun(
                `UPDATE popia_erasure_requests SET status = 'processed', processed_by = ?, processed_by_name = ?, processed_at = CURRENT_TIMESTAMP, affected_tables_json = ?, updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?`,
                [adminId, adminName, JSON.stringify(affected), id]
            );
            await dbRun(
                `INSERT INTO audit_log (table_name, record_id, action, changed_by, changes_json, change_timestamp)
                 VALUES ('popia_erasure_requests', ?, 'DATA_ANONYMIZATION', ?, ?, CURRENT_TIMESTAMP)`,
                [id, adminName, JSON.stringify({ email: requestRow.email, affected })]
            );
            await dbRun("COMMIT");
            return { ok: true, affected, filesToDelete };
        } catch (txErr) {
            await dbRun("ROLLBACK").catch(() => {});
            console.error('[POPIA] completePopiaAnonymization failed:', txErr.message);
            try {
                await dbRun(`UPDATE popia_erasure_requests SET status = 'failed', error_message = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [txErr.message, id]);
                await dbRun(
                    `INSERT INTO audit_log (table_name, record_id, action, changed_by, changes_json, change_timestamp)
                     VALUES ('popia_erasure_requests', ?, 'POPIA_ERASURE_FAILED', ?, ?, CURRENT_TIMESTAMP)`,
                    [id, adminName, JSON.stringify({ error: txErr.message })]
                );
            } catch (followUpErr) {
                console.error('[POPIA] Failed to record failure state:', followUpErr.message);
            }
            return { status: 500, body: { success: false, message: 'Anonymization failed. Transaction rolled back; the request has been marked failed for review.' } };
        }
    });
}

// Deletes contract/quotation PDFs left behind by a successful anonymization. Called only after
// processPopiaRequest's COMMIT succeeds — a file removed mid-transaction can't be restored by a
// rollback, so file deletion is deliberately kept outside the DB transaction entirely. Synchronous
// so the route's response only goes out once the files are actually gone (this fires on a rare,
// admin-triggered action — not a hot path — so blocking briefly here is the right tradeoff).
function deletePopiaFiles(filesToDelete) {
    const jobs = [
        ...(filesToDelete?.contracts || []).map(f => resolveDocsPath('contracts', f)),
        ...(filesToDelete?.quotations || []).map(f => resolveDocsPath('quotes', f))
    ];
    jobs.forEach(p => {
        try { fs.unlinkSync(p); } catch (err) { if (err.code !== 'ENOENT') console.error('[POPIA] Failed to delete file:', p, err.message); }
    });
}

// A booking is "active or partially paid" — in scope for erasure-driven cancellation — unless it's
// already CANCELLED or COMPLETED (retroactively "cancelling" a delivered event would falsify
// history), or it's EXPIRED with nothing paid (a lapsed quote with no money on the table needs no
// cancellation/refund handling at all).
function isBookingInPopiaErasureScope(booking) {
    if (['CANCELLED', 'COMPLETED'].includes(booking.status)) return false;
    if (booking.status === 'EXPIRED' && !(parseFloat(booking.amount_paid) > 0)) return false;
    return true;
}

// Read-only: for each of the given bookingIds, reports whether it's in scope and — if so — the
// same calculateCancellationRefund() figures the actual cancellation step will apply. Shared by the
// public pre-submission preview, the admin request-detail preview, and cancelActiveBookingsForErasure
// itself, so none of the three can silently drift from what really happens.
async function getBookingErasureImpact(bookingIds) {
    if (!bookingIds.length) return [];
    const ph = bookingIds.map(() => '?').join(',');
    const bookings = await getBookingsByIds(ph, bookingIds);
    const policyRow = await dbGet(`SELECT policy_value FROM policies WHERE policy_key = 'cancellation_policy'`);
    const policyStr = policyRow ? policyRow.policy_value : '';
    const impact = [];
    for (const booking of bookings) {
        if (!isBookingInPopiaErasureScope(booking)) continue;
        const calc = calculateCancellationRefund(booking, policyStr);
        impact.push({
            booking_id: booking.id, event_name: booking.event_name, event_type: booking.event_type,
            date: booking.date, status: booking.status, amount_paid: calc.totalPaid,
            estimated_refund_due: calc.refund, estimated_retention: calc.retention,
            policy_rule: calc.rule, days_until_event: calc.daysUntilEvent
        });
    }
    return impact;
}

// Cancels every in-scope booking for this erasure request, applying the same tiered refund/
// retention calculation and cascade (void invoices, cancel pending payment schedules, release date
// holds, demote/unlink the linked events row) as the existing manual cancel routes (admin /cancel,
// applyStatusChange's CANCELLED branch) — copying only their inner UPDATE/INSERT statements, never
// their own transaction wrapper, since this must run INSIDE the caller's already-open transaction
// (withDbTransaction is a non-reentrant promise-chain queue; nesting a second BEGIN IMMEDIATE inside
// it would deadlock). No network I/O happens here — Google Calendar deletes and the cancellation-
// notification email are deferred to the caller, to fire post-commit via notifyPopiaCancellations().
async function cancelActiveBookingsForErasure(bookingIds) {
    const impact = await getBookingErasureImpact(bookingIds);
    const cancelledBookingIds = [];
    const calendarIdsToDelete = [];
    const notificationSnapshots = [];
    const cancelReason = 'Booking cancelled as a consequence of a POPIA data erasure request.';

    for (const item of impact) {
        const booking = await getBookingByIdAsync(item.booking_id);
        if (!booking || !isBookingInPopiaErasureScope(booking)) continue;

        notificationSnapshots.push({
            bookingId: booking.id, name: booking.name, email: booking.email,
            eventName: booking.event_name, eventType: booking.event_type, date: booking.date,
            refundDue: item.estimated_refund_due, rule: item.policy_rule, daysUntilEvent: item.days_until_event
        });

        await cancelBookingForErasureAsync(cancelReason, booking.id);
        await insertCancellationForErasure(booking.id, cancelReason, item.amount_paid, item.estimated_refund_due, item.estimated_retention);
        await releaseDateHoldsForBookingAsync(booking.id);
        await voidInvoicesForCancelledBookingAsync(booking.id);
        await cancelPendingPaymentSchedulesAsync(booking.id);

        const linkedEvent = await getEventByBookingId(booking.id);
        if (linkedEvent) {
            await demoteEventForCancelledBookingAsync(cancelReason, linkedEvent.event_id);
            if (linkedEvent.google_calendar_event_id) {
                calendarIdsToDelete.push(linkedEvent.google_calendar_event_id);
                await clearEventGoogleCalendarIdAsync(linkedEvent.event_id);
            }
        }
        if (booking.event_id) {
            await clearBookingPublicAndEventIdAsync(booking.id);
        }
        if (booking.google_event_id) {
            calendarIdsToDelete.push(booking.google_event_id);
            await clearBookingGoogleEventIdAsync(booking.id);
        }

        await dbRun(
            `INSERT INTO audit_log (table_name, record_id, action, new_values, changed_by, change_timestamp)
             VALUES ('bookings', ?, 'CANCEL', ?, 'popia_erasure', CURRENT_TIMESTAMP)`,
            [booking.id, JSON.stringify({ reason: 'popia_erasure', refund_due: item.estimated_refund_due })]
        );
        cancelledBookingIds.push(booking.id);
    }

    return { cancelledBookingIds, calendarIdsToDelete, notificationSnapshots };
}

// "All financial obligations resolved" is evaluated against every booking in `bookingIds` that
// currently carries an unresolved refund — not just ones cancelled in this run, since a booking
// could have been cancelled independently, earlier, and still owe money. Compares the actual
// cumulative refunded amount (the same SUM(transactions...) query the existing PUT .../refund route
// uses) against refund_due, rather than trusting cancellations.refund_status alone — that route
// allows a partial amount to be recorded, which would otherwise let a token refund satisfy this gate
// while most of the money is still owed.
async function getUnresolvedRefundBookingIds(bookingIds) {
    if (!bookingIds.length) return [];
    const ph = bookingIds.map(() => '?').join(',');
    const rows = await getCancellationsWithRefundedTotals(ph, bookingIds);
    return rows.filter(r => r.refunded < r.refund_due).map(r => r.booking_id);
}

// Fires the non-transactional side effects of an erasure-driven cancellation — Google Calendar
// deletes and a cancellation-notification email per booking — using the pre-cancellation name/email
// snapshot captured before any UPDATE ran (so this still works correctly even when anonymization
// committed in the very same call, after the real columns have already been scrubbed).
function notifyPopiaCancellations(calendarIdsToDelete, notificationSnapshots) {
    (calendarIdsToDelete || []).forEach(id => {
        deleteGoogleEvent(id).catch(e => console.error('[POPIA] Calendar event delete failed:', e.message));
    });
    (notificationSnapshots || []).forEach(snap => {
        sendCancellationEmail(
            { id: snap.bookingId, name: snap.name, email: snap.email, event_name: snap.eventName, event_type: snap.eventType, date: snap.date },
            { reason: 'Booking cancelled as a consequence of a POPIA data erasure request.', refund_due: snap.refundDue, rule: snap.rule, days_until_event: snap.daysUntilEvent, is_force_majeure: false }
        ).catch(e => console.error('[POPIA] Cancellation notification email failed for booking #' + snap.bookingId + ':', e.message));
    });
}

module.exports = {
    resolvePopiaTargets, getBookingErasureImpact,
    POPIA_REASONS, createPopiaRequest, approvePopiaRequest, rejectPopiaRequest,
    processPopiaRequest, completePopiaAnonymization, deletePopiaFiles, notifyPopiaCancellations
};
