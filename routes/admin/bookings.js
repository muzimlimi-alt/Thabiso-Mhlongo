const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const moment = require('moment-timezone');
const db = require('../../database');
const { requireAdmin } = require('../../middleware/auth');
const { requireRole } = require('../../middleware/rbac');
const { mutateRateLimiter } = require('../../middleware/rate-limiters');
const { resolveDocsPath, docsWriteDir, PROJECT_ROOT } = require('../../lib/runtime-paths');
// Phase 5 housekeeping fix: dbGet was called at 5 sites below (all in the contract cluster moved in
// sub-batch C) with no import anywhere in this file — a missing re-import from that move, not a
// pre-existing app bug (app.js itself has always imported these from lib/db-helpers). Restores the
// original working behaviour; no logic changed.
const { dbRun, dbGet, dbAll } = require('../../lib/db-helpers');
// Phase 5: MUST stay the exact same singleton module.exports app.js and every other route file
// import — see lib/db-transaction.js's own header comment.
const { withDbTransaction } = require('../../lib/db-transaction');
const { calculateCancellationRefund } = require('../../lib/cancellation-refund');
const { escapeEmailFields } = require('../../lib/email-escape');
const { getEmailFooterContext } = require('../../lib/email-context');
const { findOrCreateClient } = require('../../lib/client-venue');
const { resolveLineTaxClasses, getVatRate, computeDocumentTotals } = require('../../lib/document-totals');
const {
    DEFAULT_CONTRACT_CLAUSES, CONTRACT_ELIGIBLE_STATUSES,
    resolveContractFeeData, assembleContractHtml, generateContract
} = require('../../lib/contracts');
const {
    sendQuoteEmail, sendBookingConfirmedEmail, sendReviewRequestEmail, remindBooking, sendDateChangedEmail,
    sendAdminQuoteSentNotification
} = require('../../lib/booking-notifications');
const {
    hasCalendarConflict, syncBookingToCalendar, checkDateAvailability
} = require('../../lib/calendar-sync');
const { addMinutesToTime, parseDurationToMinutes } = require('../../lib/time-utils');
const bannerRegistry = require('../../js/bannerRegistry');
const emailComponents = require('../../js/emailComponents');
const { sendEmail } = require('../../js/emailService');
const pdfService = require('../../js/pdfService');
const {
    getBookingNotesForBooking, insertBookingNote, getBookingNoteById, deleteBookingNote,
    unlinkBookingClient, getBookingStatusNameEmail, reopenBooking, getBookingStatus, getBookingForContractRemind,
    stampReviewEmailSent, getBookingById, getBookingByIdAsync, insertBookAgainBooking, getBookingEventId,
    updateBookingVenueUnlink, updateBookingVenueLinkLegacy, updateBookingVenueGoogle, updateBookingVenueFreeText,
    updateBookingDateAndTimeFields, setBookingClientId, updateBookingAfterQuote, deleteBookingLineItems,
    deleteBookingServices, insertBookingLineItem, insertBookingService
} = require('../../database/repositories/bookings.repository');
const {
    getQuoteHistoryForBooking, getQuoteForBookingFinancials, getInvoiceForBookingFinancials,
    getInvoiceFileForAdminDownload, getQuoteFileForAdminDownload, getLatestQuoteFileForResend, markQuotationResent,
    getQuoteNumberCollisionCount, voidInvoiceForRequote, archivePreviousQuotations, getNextQuoteVersion,
    insertQuotation, insertQuoteLineItem
} = require('../../database/repositories/invoices-quotations.repository');
const {
    getExpensesForBooking, getCancellationDetailForBooking, getTransactionsForBooking,
    supersedePaymentSchedulesForRequote
} = require('../../database/repositories/finance.repository');
const {
    unlinkEventVenue, updateEventVenueLegacyLink, updateEventVenueGoogleLink, updateEventVenueFreeText,
    updateDateHoldDateForBooking, updateEventDatetime
} = require('../../database/repositories/calendar.repository');
const router = express.Router();

// P2.6 — Contract management (admin)
const contractUpload = multer({
    storage: multer.diskStorage({
        destination: function(req, file, cb) {
            cb(null, docsWriteDir('contracts'));
        },
        filename: function(req, file, cb) {
            cb(null, `contract-${req.params.id}-${Date.now()}${path.extname(file.originalname)}`);
        }
    }),
    fileFilter: function(req, file, cb) {
        if (file.mimetype === 'application/pdf') {
            cb(null, true);
        } else {
            cb(new Error('Only PDF files are accepted for contract uploads.'), false);
        }
    },
    limits: { fileSize: 10 * 1024 * 1024 }
});

// Emails the generated contract PDF to the client with a link to the tracking page, where they can
// review and sign it online. Mirrors sendInvoicePreDueEmail's structure.
async function sendContractEmail(booking, contractPdfPath) {
    booking = escapeEmailFields(booking);
    const { id, name, email, event_name, event_type, date } = booking;
    const baseUrl = process.env.BASE_URL || 'https://www.thabisomhlongo.com';
    const signUrl = `${baseUrl}/?track=${id}&email=${encodeURIComponent(email)}`;

    const attachments = [];
    if (contractPdfPath && fs.existsSync(contractPdfPath)) {
        attachments.push({ filename: `Contract_${id}_Thabiso_Mhlongo.pdf`, path: contractPdfPath, contentType: 'application/pdf' });
    }

    const { socialLinks } = await getEmailFooterContext();
    const banner = await bannerRegistry.resolveBanner('contract_sent');
    const htmlContent = emailComponents.renderPremiumEmail({
        preheaderText: `Your booking contract for #${id} is ready to review and sign.`,
        bannerSrc: banner?.src, bannerAlt: banner?.alt, subtitle: banner?.subtitle,
        headline: banner?.headline || 'Your Booking Contract',
        greeting: `Hi ${name},`,
        bodyHtml:
            `Your booking contract for <strong style="color:#FAFAFA;">${event_name || event_type}</strong> on <strong style="color:#FAFAFA;">${date}</strong> is ready. Please review the attached PDF and sign it online at your convenience.` +
            `<p style="margin:10px 0 0; color:#B0B0B0; font-size:12px;">Once you've signed, our team will countersign to finalise the agreement. If you have any questions about the terms, just reply to this email. (Booking reference #${id})</p>`,
        cta: { label: 'Review & Sign Contract', url: signUrl },
        socialLinks
    });

    const result = await sendEmail({
        to: email,
        subject: `Your booking contract — ${event_name || event_type} (Booking #${id})`,
        htmlContent,
        preWrapped: true,
        attachments,
        titleOverride: 'Your Booking Contract',
        trigger_event: 'Booking: Contract Sent'
    });
    return result.success;
}

// Gap 10: GET — fetch outgoing communication log for a booking
router.get('/api/admin/bookings/:id/communications', requireAdmin, (req, res) => {
    db.all(
        `SELECT id, direction, channel, subject, content_snippet, sent_at, created_at
         FROM communication_log WHERE booking_id = ? ORDER BY created_at DESC LIMIT 50`,
        [req.params.id],
        (err, rows) => res.json({ success: !err, logs: rows || [] })
    );
});

// Unlink a booking from its client record so COALESCE falls back to the booking's own name/email.
// Use when client_id was incorrectly assigned (e.g. email collision in findOrCreateClient).
router.post('/api/admin/bookings/:id/unlink-client', requireAdmin, (req, res) => {
    unlinkBookingClient(req.params.id, function(err) {
        if (err) return res.status(500).json({ success: false, error: err.message });
        if (this.changes === 0) return res.status(404).json({ success: false, message: 'Booking not found.' });
        res.json({ success: true, message: `client_id cleared for booking #${req.params.id}` });
    });
});

// S5-4: Threaded booking notes — replaces the single admin_notes text blob.
router.get('/api/admin/bookings/:id/notes', requireAdmin, (req, res) => {
    getBookingNotesForBooking(
        req.params.id,
        (err, rows) => {
            if (err) return res.status(500).json({ success: false, error: err.message });
            res.json({ success: true, notes: rows || [] });
        }
    );
});

router.post('/api/admin/bookings/:id/notes', requireAdmin, (req, res) => {
    const { note, author } = req.body;
    if (!note || !note.trim()) return res.status(400).json({ success: false, message: 'Note text is required.' });
    insertBookingNote(
        req.params.id, note.trim(), (author || 'Admin').trim(),
        function(err) {
            if (err) return res.status(500).json({ success: false, error: err.message });
            getBookingNoteById(this.lastID, (e, row) => {
                res.json({ success: true, note: row });
            });
        }
    );
});

router.delete('/api/admin/bookings/:id/notes/:noteId', requireAdmin, (req, res) => {
    deleteBookingNote(
        req.params.noteId, req.params.id,
        function(err) {
            if (err) return res.status(500).json({ success: false, error: err.message });
            if (this.changes === 0) return res.status(404).json({ success: false, message: 'Note not found.' });
            res.json({ success: true });
        }
    );
});

// --- Booking Line Items + Transactions (lazy detail) ---
router.get('/api/admin/bookings/:id/details', requireAdmin, (req, res) => {
    const id = req.params.id;
    // Prefer booking_services if available, fallback to booking_line_items for legacy data
    db.all(`SELECT bs.*, bs.quantity_minutes as quantity, s.name as service_name, s.display_unit 
            FROM booking_services bs 
            LEFT JOIN services s ON bs.service_id = s.id 
            WHERE bs.booking_id = ?`, [id], (e1, servicesItems) => {
        
        getCancellationDetailForBooking(id, (e3, cancellation) => {
            const sendResponse = (items, txs) => {
                res.json({
                    line_items: items || [],
                    transactions: txs || [],
                    cancellation: cancellation || null
                });
            };

            if (servicesItems && servicesItems.length > 0) {
                getTransactionsForBooking(id, (e2, transactions) => {
                    sendResponse(servicesItems, transactions);
                });
            } else {
                // Legacy fallback
                db.all("SELECT bli.*, s.name as service_name FROM booking_line_items bli LEFT JOIN services s ON bli.service_id = s.id WHERE bli.booking_id = ?", [id], (e1, lineItems) => {
                    getTransactionsForBooking(id, (e2, transactions) => {
                        sendResponse(lineItems, transactions);
                    });
                });
            }
        });
    });
});

router.get('/api/admin/bookings/:id/quote-history', requireAdmin, (req, res) => {
    getQuoteHistoryForBooking(
        req.params.id, (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json((rows || []).map(r => ({
                ...r,
                pdf_url: r.file_path ? `/docs/quotes/${r.file_path}` : null
            })));
        }
    );
});

// GET /api/admin/bookings/:id/expenses — expenses for a specific booking + P&L
router.get('/api/admin/bookings/:id/expenses', requireAdmin, requireRole(['administrator', 'manager']), (req, res) => {
    const bookingId = req.params.id;
    getExpensesForBooking(bookingId, (err, expenses) => {
        if (err) return res.status(500).json({ success: false, message: err.message });
        const totalExpenses = (expenses || []).reduce((sum, e) => sum + parseFloat(e.amount || 0), 0);
        // Fetch the booking's quote total for P&L
        db.get(
            `SELECT COALESCE(q.total, b.total_amount, 0) AS gross
             FROM bookings b
             LEFT JOIN quotations q ON q.booking_id = b.id
             WHERE b.id = ?
             ORDER BY q.created_at DESC LIMIT 1`,
            [bookingId], (e2, fin) => {
                const gross = fin ? parseFloat(fin.gross || 0) : 0;
                res.json({
                    success: true,
                    expenses: expenses || [],
                    total_expenses: totalExpenses,
                    gross_revenue: gross,
                    net_profit: gross - totalExpenses
                });
            }
        );
    });
});

// 5. Booking-Specific Financial Details (Admin)

router.get('/api/admin/bookings/:id/financials', requireAdmin, requireRole(['administrator', 'manager']), (req, res) => {
    const bookingId = req.params.id;
    const result = { quote: null, invoice: null };

    getQuoteForBookingFinancials(bookingId, (err, quote) => {
        if (quote) {
            result.quote = {
                id: quote.id,
                quote_number: quote.quote_number,
                pdf_url: `/docs/quotes/${quote.file_path}`,
                created_at: quote.created_at
            };
        }

        getInvoiceForBookingFinancials(bookingId, (err, invoice) => {
            if (invoice) {
                result.invoice = {
                    id: invoice.id,
                    invoice_number: invoice.invoice_number,
                    pdf_url: `/docs/invoices/${invoice.file_path}`,
                    status: invoice.status,
                    total_amount: invoice.total_amount
                };
            }
            res.json(result);
        });
    });
});

// P2.0 — Cancellation Preview
router.get('/api/admin/bookings/:id/cancellation-preview', requireAdmin, (req, res) => {
    const bookingId = req.params.id;
    db.get("SELECT * FROM bookings WHERE id = ?", [bookingId], (err, booking) => {
        if (err || !booking) return res.status(404).json({ success: false, message: 'Booking not found.' });
        if (['COMPLETED', 'CANCELLED'].includes((booking.status || '').toUpperCase())) {
            return res.status(400).json({ success: false, message: `Booking already ${booking.status}` });
        }
        
        db.get("SELECT policy_value FROM policies WHERE policy_key = 'cancellation_policy'", (err, policy) => {
            const policyStr = policy ? policy.policy_value : "";
            const calc = calculateCancellationRefund(booking, policyStr);
            res.json({ success: true, preview: calc });
        });
    });
});

// P2.0 — Reopen an EXPIRED booking — resets to PENDING so admin can issue a new quote
router.post('/api/admin/bookings/:id/reopen', requireAdmin, (req, res) => {
    const bookingId = parseInt(req.params.id, 10);
    getBookingStatusNameEmail(bookingId, (err, booking) => {
        if (err || !booking) return res.status(404).json({ success: false, message: 'Booking not found.' });
        if ((booking.status || '').toUpperCase() !== 'EXPIRED') {
            return res.status(400).json({ success: false, message: `Only EXPIRED bookings can be reopened. Current status: ${booking.status}.` });
        }
        reopenBooking(
            bookingId,
            function(upErr) {
                if (upErr) return res.status(500).json({ success: false, message: upErr.message });
                db.run(
                    `INSERT INTO audit_log (table_name, record_id, action, old_values, new_values, changed_by, change_timestamp)
                     VALUES ('bookings', ?, 'REOPEN', ?, ?, ?, CURRENT_TIMESTAMP)`,
                    [bookingId,
                     JSON.stringify({ status: 'EXPIRED' }),
                     JSON.stringify({ status: 'PENDING', note: 'Reopened by admin — previous quote cleared' }),
                     req.session.adminId || 'admin']
                );
                res.json({ success: true, message: 'Booking reopened and returned to PENDING.' });
            }
        );
    });
});

// 2. Ledger reconciliation — compares booking's denormalised ledger against transaction sum.
router.get('/api/admin/bookings/:id/reconcile', requireAdmin, (req, res) => {
    const bookingId = req.params.id;
    db.get(
        `SELECT
            b.id, b.amount_paid AS ledger_paid, b.amount_outstanding AS ledger_outstanding, b.total_amount AS ledger_total,
            COALESCE(SUM(CASE WHEN (t.source != 'payfast' OR t.is_verified = 1) AND COALESCE(t.is_duplicate, 0) = 0 AND t.status = 'completed' THEN (CASE WHEN t.transaction_type = 'refund' THEN -t.amount WHEN t.transaction_type = 'adjustment' THEN 0 ELSE t.amount END) ELSE 0 END), 0) AS tx_paid,
            COUNT(t.id) AS tx_count
         FROM bookings b
         LEFT JOIN transactions t ON t.booking_id = b.id
         WHERE b.id = ?
         GROUP BY b.id`,
        [bookingId],
        (err, row) => {
            if (err || !row) return res.status(404).json({ success: false, message: 'Booking not found.' });
            const drift = Math.abs((row.ledger_paid || 0) - (row.tx_paid || 0)) > 0.01;
            res.json({
                success: true,
                booking_id: row.id,
                ledger: { total: row.ledger_total, paid: row.ledger_paid, outstanding: row.ledger_outstanding },
                transactions: { total_paid: row.tx_paid, count: row.tx_count },
                drift,
                drift_amount: drift ? ((row.ledger_paid || 0) - (row.tx_paid || 0)).toFixed(2) : '0.00'
            });
        }
    );
});

// 2b. Download Invoice (Admin Authorized)
router.get('/api/admin/bookings/:id/invoice/download', requireAdmin, (req, res) => {
    // Same as the public route: serve the live invoice, never a superseded VOID revision.
    getInvoiceFileForAdminDownload(req.params.id, (err, row) => {

        if (err || !row) return res.status(404).send('Invoice not found');

        const filePath = resolveDocsPath('invoices', row.file_path);
        if (fs.existsSync(filePath)) {
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `attachment; filename=Invoice_${row.invoice_number}.pdf`);
            res.sendFile(filePath);
        } else {
            res.status(404).send('Physical PDF file not found on server.');
        }
    });
});

// 2c. Download Quote (Admin Authorized)
router.get('/api/admin/bookings/:id/quote/download', requireAdmin, (req, res) => {
    getQuoteFileForAdminDownload(req.params.id, (err, row) => {

        if (err || !row) return res.status(404).send('Quotation not found');

        const filePath = resolveDocsPath('quotes', row.file_path);
        if (fs.existsSync(filePath)) {
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `attachment; filename=Quote_${row.quote_number}.pdf`);
            res.sendFile(filePath);
        } else {
            res.status(404).send('Physical PDF file not found on server.');
        }
    });
});

// POST — generate a booking contract PDF (admin, on demand). `{ clauses }` in the body drives the
// Contract Builder path; an empty/absent body keeps today's zero-customization auto-generate
// behavior. Signed contracts are protected.
router.post('/api/admin/bookings/:id/contract/generate', requireAdmin, async (req, res) => {
    try {
        const result = await generateContract(req.params.id, (req.body && req.body.clauses) || null);
        if (result.skipped) {
            const msg = result.reason === 'not_accepted'
                ? 'A contract can only be generated once the quote has been accepted. Accept the quote first.'
                : 'This contract has already been signed and cannot be regenerated. Create a separate amendment instead.';
            return res.status(400).json({ success: false, message: msg });
        }
        res.json({ success: true, message: 'Contract generated.', contract: result.contract });
    } catch (e) {
        console.error('[Contract Generate] Failed for booking #' + req.params.id + ':', e.message);
        res.status(500).json({ success: false, message: 'Failed to generate contract: ' + e.message });
    }
});

// GET — pre-fill data for the Contract Builder editor: booking/party facts, resolved fee/schedule,
// policy defaults, and (if a draft already exists) the last-submitted clause text so re-opening
// the editor restores prior edits instead of resetting to raw defaults.
router.get('/api/admin/bookings/:id/contract/builder-data', requireAdmin, async (req, res) => {
    try {
        const bookingId = req.params.id;
        const booking = await dbGet(
            `SELECT b.*, c.vat_number AS client_vat_number FROM bookings b LEFT JOIN clients c ON b.client_id = c.id WHERE b.id = ?`,
            [bookingId]);
        if (!booking) return res.status(404).json({ success: false, message: 'Booking not found.' });

        const feeData = await resolveContractFeeData(bookingId, booking);

        const policyRows = await new Promise(r => db.all("SELECT policy_key, policy_value FROM policies", [], (e, rows) => r(e ? [] : (rows || []))));
        const policies = {};
        policyRows.forEach(p => { policies[p.policy_key] = p.policy_value; });

        const artist = await dbGet("SELECT stage_name AS name, email, phone FROM comedians WHERE id = 1");
        const manager = await dbGet("SELECT name, email, cell_number AS phone FROM manager_details ORDER BY manager_id ASC LIMIT 1");

        const existingContract = await dbGet("SELECT status, is_frozen, builder_clauses FROM contracts WHERE booking_id = ?", [bookingId]);
        let savedClauses = null;
        if (existingContract && existingContract.builder_clauses) {
            try { savedClauses = JSON.parse(existingContract.builder_clauses); } catch (e) {}
        }
        const clauses = savedClauses || {
            paymentTerms: policies.payment_terms || '',
            cancellation: policies.cancellation_policy || DEFAULT_CONTRACT_CLAUSES.cancellation,
            forceMajeure: DEFAULT_CONTRACT_CLAUSES.forceMajeure,
            travelHospitality: DEFAULT_CONTRACT_CLAUSES.travelHospitality,
            rightsRecording: DEFAULT_CONTRACT_CLAUSES.rightsRecording,
            additionalClauses: DEFAULT_CONTRACT_CLAUSES.additionalClauses
        };

        res.json({
            success: true,
            booking: { name: booking.name, company: booking.company, email: booking.email, cell: booking.cell,
                       vat_number: booking.vat_number || booking.client_vat_number, event_name: booking.event_name,
                       event_type: booking.event_type, date: booking.date, event_location: booking.event_location },
            artist: artist || null,
            manager: manager || null,
            fee: { total: feeData.total, applyVat: feeData.applyVat, schedules: feeData.schedules },
            clauses,
            locked: !!(existingContract && (existingContract.status === 'signed' || existingContract.is_frozen === 1))
        });
    } catch (e) {
        console.error('[Contract Builder Data] Failed for booking #' + req.params.id + ':', e.message);
        res.status(500).json({ success: false, message: 'Could not load contract builder data.' });
    }
});

// POST — stateless HTML preview of the contract as currently drafted in the Builder. No DB write,
// no PDF/file write — just runs the same assembly function generate() uses, so preview always
// matches what Generate would actually produce.
router.post('/api/admin/bookings/:id/contract/preview', requireAdmin, async (req, res) => {
    try {
        const bookingId = req.params.id;
        const booking = await dbGet(
            `SELECT b.*, c.vat_number AS client_vat_number FROM bookings b LEFT JOIN clients c ON b.client_id = c.id WHERE b.id = ?`,
            [bookingId]);
        if (!booking) return res.status(404).json({ success: false, message: 'Booking not found.' });

        const feeData = await resolveContractFeeData(bookingId, booking);
        const policyRows = await new Promise(r => db.all("SELECT policy_key, policy_value FROM policies", [], (e, rows) => r(e ? [] : (rows || []))));
        const policies = {};
        policyRows.forEach(p => { policies[p.policy_key] = p.policy_value; });

        const submitted = (req.body && req.body.clauses) || {};
        const finalClauses = {
            paymentTerms: submitted.paymentTerms || policies.payment_terms || '',
            cancellation: submitted.cancellation || policies.cancellation_policy || DEFAULT_CONTRACT_CLAUSES.cancellation,
            forceMajeure: submitted.forceMajeure || DEFAULT_CONTRACT_CLAUSES.forceMajeure,
            travelHospitality: submitted.travelHospitality || DEFAULT_CONTRACT_CLAUSES.travelHospitality,
            rightsRecording: submitted.rightsRecording || DEFAULT_CONTRACT_CLAUSES.rightsRecording,
            additionalClauses: submitted.additionalClauses || DEFAULT_CONTRACT_CLAUSES.additionalClauses,
            depositPercentage: policies.deposit_percentage || '50'
        };

        const contractNo = `AGR-${moment().format('YYYY')}-${String(bookingId).padStart(4, '0')}`;
        const contentHtml = assembleContractHtml(booking, feeData, finalClauses, contractNo);
        res.json({ success: true, content_html: contentHtml });
    } catch (e) {
        console.error('[Contract Preview] Failed for booking #' + req.params.id + ':', e.message);
        res.status(500).json({ success: false, message: 'Could not render preview.' });
    }
});

// GET — fetch contract details for a booking
router.get('/api/admin/bookings/:id/contract', requireAdmin, (req, res) => {
    db.get("SELECT * FROM contracts WHERE booking_id = ?", [req.params.id], (err, row) => {
        if (err) return res.status(500).json({ success: false, message: err.message });
        res.json({ success: true, contract: row || null });
    });
});

// POST — upload a contract PDF
router.post('/api/admin/bookings/:id/contract', requireAdmin, (req, res, next) => {
    contractUpload.single('contract_file')(req, res, function(err) {
        if (err) {
            // multer fileFilter error — return clear 400
            return res.status(400).json({ success: false, message: err.message || 'Invalid file. Only PDF files are accepted.' });
        }
        next();
    });
}, (req, res) => {
    if (!req.file) return res.status(400).json({ success: false, message: 'A PDF file is required. Only .pdf files are accepted.' });
    const bookingId = req.params.id;
    const pdfUrl = req.file.filename;
    const templateVersion = (req.body.template_version || '1.0').substring(0, 20);
    const uploadedBy = req.session.username || 'system';

    getBookingStatus(bookingId, (bErr, bk) => {
        if (bErr || !bk) return res.status(404).json({ success: false, message: 'Booking not found.' });
        // Acceptance-before-contract: don't attach a contract to a booking that hasn't accepted its quote.
        if (!CONTRACT_ELIGIBLE_STATUSES.includes((bk.status || '').toUpperCase())) {
            return res.status(400).json({ success: false, message: 'The quote must be accepted before a contract can be added.' });
        }
    db.get("SELECT status, is_frozen, signed_by, signed_date FROM contracts WHERE booking_id = ?", [bookingId], (selErr, existing) => {
        if (existing && (existing.status === 'signed' || existing.is_frozen === 1)) {
            return res.status(400).json({
                success: false,
                message: `Cannot overwrite: this contract was already signed by "${existing.signed_by}" on ${existing.signed_date}. You cannot replace a signed contract — create a separate amendment instead.`
            });
        }

        const previousStatus = existing ? existing.status : null;

        db.run(
            `INSERT INTO contracts (booking_id, template_version, pdf_url, status, uploaded_by, updated_at)
             VALUES (?, ?, ?, 'draft', ?, CURRENT_TIMESTAMP)
             ON CONFLICT(booking_id) DO UPDATE SET
                pdf_url = excluded.pdf_url,
                template_version = excluded.template_version,
                status = 'draft',
                uploaded_by = excluded.uploaded_by,
                is_frozen = 0,
                updated_at = CURRENT_TIMESTAMP`,
            [bookingId, templateVersion, pdfUrl, uploadedBy], function(err) {
                if (err) return res.status(500).json({ success: false, message: err.message });

                db.run(
                    `INSERT INTO audit_log (table_name, record_id, action, changed_by, changes_json)
                     VALUES ('contracts', ?, 'UPLOAD', ?, ?)`,
                    [bookingId, uploadedBy, JSON.stringify({ file: pdfUrl, status: 'draft', previous_status: previousStatus })],
                    () => {}
                );

                res.json({ success: true, message: 'Contract uploaded successfully.', filename: pdfUrl, uploaded_by: uploadedBy });
            }
        );
    });
    });
});

// PUT — mark a contract as signed
router.put('/api/admin/bookings/:id/contract/sign', requireAdmin, (req, res) => {
    const bookingId = req.params.id;
    const signatoryName = (req.body.signatory_name || '').trim().substring(0, 120);
    const signedDate = (req.body.signed_date || new Date().toISOString().split('T')[0]);
    const signedBy = req.session.username || 'system';

    if (!signatoryName) {
        return res.status(400).json({ success: false, message: 'Signatory name is required to mark as signed.' });
    }

    const forceCountersign = req.body && req.body.force === true;
    db.get("SELECT status, is_frozen, signed_by_client_at, pdf_url, client_signature_data FROM contracts WHERE booking_id = ?", [bookingId], (checkErr, existing) => {
        if (checkErr) return res.status(500).json({ success: false, message: checkErr.message });
        if (!existing) return res.status(404).json({ success: false, message: 'No contract found for this booking. Upload a PDF first.' });
        if (existing.is_frozen === 1 || existing.status === 'signed') {
            return res.status(400).json({ success: false, message: 'This contract has already been signed and cannot be re-signed.' });
        }
        // Two-party model: the client signs online first, then the admin/comedian countersigns to
        // finalise. Block the countersign until the client has signed, unless explicitly overridden.
        if (!existing.signed_by_client_at && !forceCountersign) {
            return res.status(400).json({
                success: false,
                requires_client_signature: true,
                message: 'The client has not signed this contract yet. Send it for signing first, or pass { force: true } to countersign anyway.'
            });
        }

        // Integrity check: re-hash the PDF now and compare against the hash captured when the client
        // signed. A mismatch means the document changed between the client's signature and this
        // countersignature — surfaced in the audit trail (not hard-blocked; the admin is finalising).
        let integrityVerified = null;
        try {
            let clientHash = null;
            if (existing.client_signature_data) {
                try { clientHash = (JSON.parse(existing.client_signature_data) || {}).signed_file_sha256 || null; } catch (pe) {}
            }
            if (clientHash && existing.pdf_url) {
                const cpath = resolveDocsPath('contracts', existing.pdf_url);
                if (fs.existsSync(cpath)) {
                    const nowHash = crypto.createHash('sha256').update(fs.readFileSync(cpath)).digest('hex');
                    integrityVerified = (nowHash === clientHash);
                    if (integrityVerified === false) console.warn(`[Contract Countersign] PDF hash changed since client signed (booking #${bookingId}) — possible tamper.`);
                }
            }
        } catch (hErr) { console.error('[Contract Countersign] Integrity check failed for booking #' + bookingId + ':', hErr.message); }

        db.run(
            `UPDATE contracts
             SET signed_by_comedian_at = CURRENT_TIMESTAMP,
                 signed_by = ?,
                 signed_date = ?,
                 status = 'signed',
                 is_frozen = 1,
                 integrity_verified = ?,
                 updated_at = CURRENT_TIMESTAMP
             WHERE booking_id = ?`,
            [signatoryName, signedDate, integrityVerified === null ? null : (integrityVerified ? 1 : 0), bookingId], function(err) {
                if (err || this.changes === 0) {
                    return res.status(404).json({ success: false, message: err ? err.message : 'No contract found for this booking. Upload a PDF first.' });
                }

                // Audit log (previously passed 5 params to a 3-placeholder INSERT — the extra literals
                // meant the row silently failed to write; corrected to match the columns).
                db.run(
                    `INSERT INTO audit_log (table_name, record_id, action, changed_by, changes_json)
                     VALUES ('contracts', ?, 'SIGN', ?, ?)`,
                    [bookingId, signedBy, JSON.stringify({ signed_by: signatoryName, signed_date: signedDate, integrity_verified: integrityVerified })],
                    () => {}
                );

                res.json({ success: true, message: 'Contract marked as signed.', signed_by: signatoryName, signed_date: signedDate, integrity_verified: integrityVerified });
            }
        );
    });
});

// GET — download the contract PDF
router.get('/api/admin/bookings/:id/contract/download', requireAdmin, (req, res) => {
    db.get("SELECT pdf_url FROM contracts WHERE booking_id = ?", [req.params.id], (err, row) => {
        if (err || !row || !row.pdf_url) return res.status(404).json({ success: false, message: 'No contract on file for this booking.' });
        const filePath = resolveDocsPath('contracts', row.pdf_url);
        if (!fs.existsSync(filePath)) return res.status(404).json({ success: false, message: 'Contract file not found on server. It may have been deleted.' });
        res.download(filePath, row.pdf_url, (dlErr) => {
            if (dlErr) console.error('[Contract Download Error]', dlErr.message);
        });
    });
});

// POST — send the generated contract to the client for online signing.
// Draft-only generation means this is the explicit "deliver it" step; it stamps sent_to_client_at
// and advances draft -> sent so the client tracking page exposes the review-and-sign flow.
router.post('/api/admin/bookings/:id/contract/send', requireAdmin, mutateRateLimiter, (req, res) => {
    const bookingId = req.params.id;
    db.get(`SELECT b.id, b.name, b.status, COALESCE(c.email, b.email) AS email, b.event_name, b.event_type, b.date
            FROM bookings b LEFT JOIN clients c ON b.client_id = c.id WHERE b.id = ?`, [bookingId], (err, booking) => {
        if (err || !booking) return res.status(404).json({ success: false, message: 'Booking not found.' });
        // Acceptance-before-contract: a contract may not be sent for signing before the quote is accepted.
        if (!CONTRACT_ELIGIBLE_STATUSES.includes((booking.status || '').toUpperCase())) {
            return res.status(400).json({ success: false, message: 'The quote must be accepted before a contract can be sent to the client.' });
        }
        db.get("SELECT pdf_url, status, is_frozen FROM contracts WHERE booking_id = ?", [bookingId], async (cErr, contract) => {
            if (cErr) return res.status(500).json({ success: false, message: cErr.message });
            if (!contract || !contract.pdf_url) return res.status(404).json({ success: false, message: 'No contract on file. Generate or upload one first.' });
            if (contract.status === 'signed' || contract.is_frozen === 1) {
                return res.status(400).json({ success: false, message: 'This contract is already signed and finalised.' });
            }
            const pdfPath = resolveDocsPath('contracts', contract.pdf_url);
            if (!fs.existsSync(pdfPath)) return res.status(404).json({ success: false, message: 'Contract file not found on server. Regenerate it first.' });

            try {
                await sendContractEmail(booking, pdfPath);
            } catch (e) {
                console.error('[Contract Send] email failed for booking #' + bookingId + ':', e.message);
                return res.status(500).json({ success: false, message: 'Could not email the contract: ' + e.message });
            }
            // Only advance a draft to sent; a re-send of an already-sent (possibly client-signed)
            // contract just refreshes the timestamp without downgrading its status.
            db.run(
                `UPDATE contracts SET status = CASE WHEN status = 'draft' THEN 'sent' ELSE status END,
                        sent_to_client_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
                 WHERE booking_id = ?`,
                [bookingId],
                (uErr) => {
                    if (uErr) console.error('[Contract Send] status update failed:', uErr.message);
                    db.run(`INSERT INTO audit_log (table_name, record_id, action, changed_by, changes_json)
                            VALUES ('contracts', ?, 'SENT', ?, ?)`,
                        [bookingId, req.session.username || 'admin', JSON.stringify({ to: booking.email })], () => {});
                    res.json({ success: true, message: 'Contract sent to the client for signing.' });
                }
            );
        });
    });
});

// Gap 8: POST — send contract signature reminder email to client
router.post('/api/admin/bookings/:id/contract/remind', requireAdmin, mutateRateLimiter, (req, res) => {
    const bookingId = req.params.id;
    getBookingForContractRemind(bookingId, (err, b) => {
        if (err || !b) return res.status(404).json({ success: false, message: 'Booking not found.' });

        // Idempotency: this route wrote nothing and had no throttle, so the reminder could be sent
        // repeatedly. contracts.sent_to_client_at is the natural "last contacted about signing"
        // timestamp and was never populated; use it to refuse a repeat within 24h and to record sends.
        db.get("SELECT sent_to_client_at FROM contracts WHERE booking_id = ?", [bookingId], (cErr, contract) => {
            const lastSent = contract && contract.sent_to_client_at ? moment(contract.sent_to_client_at) : null;
            if (lastSent && moment().diff(lastSent, 'hours') < 24 && !(req.body && req.body.force === true)) {
                return res.status(429).json({
                    success: false,
                    message: `A contract reminder was already sent on ${lastSent.format('YYYY-MM-DD HH:mm')}. Wait 24 hours, or resend with { force: true }.`,
                    last_sent_at: contract.sent_to_client_at
                });
            }

            getEmailFooterContext().then(async ({ socialLinks }) => {
                const banner = await bannerRegistry.resolveBanner('contract_sign_reminder');
                return sendEmail({
                    to: b.email,
                    subject: `Action Required: Please sign your booking contract — ${b.event_name}`,
                    htmlContent: emailComponents.renderPremiumEmail({
                        preheaderText: `Your booking contract for ${b.event_name} is awaiting your signature.`,
                        bannerSrc: banner?.src, bannerAlt: banner?.alt, subtitle: banner?.subtitle,
                        headline: banner?.headline || 'Contract Signature Reminder',
                        greeting: `Hi ${b.name},`,
                        bodyHtml:
                            `A friendly reminder that your booking contract for <strong style="color:#FAFAFA;">${b.event_name}</strong> on ${b.date} is awaiting your signature.` +
                            `<p style="margin:10px 0 0; color:#E6E6E6;">Please contact us at your earliest convenience to arrange signing.</p>`,
                        socialLinks
                    }),
                    preWrapped: true,
                    titleOverride: 'Contract Signature Reminder',
                    trigger_event: 'Admin: Contract Remind'
                });
            }).then(() => {
                // Only stamp a contract row that already exists; the reminder can predate the upload.
                db.run("UPDATE contracts SET sent_to_client_at = CURRENT_TIMESTAMP WHERE booking_id = ?", [bookingId],
                    (uErr) => { if (uErr) console.error('[Contract Remind] timestamp update failed:', uErr.message); });
                res.json({ success: true, message: 'Reminder sent.' });
            }).catch(e => res.status(500).json({ success: false, message: e.message }));
        });
    });
});

// State-aware per-booking reminder. Picks the reminder appropriate to where the booking is in the
// lifecycle and returns what it did. Shared by the single-booking route and the bulk action.
// Throttling reuses existing state: the contract reminder is gated by contracts.sent_to_client_at,
// the balance reminder by a reminders_log row (schedule_id NULL, days_before=0 sentinel — distinct
// from the 7/3/1 pre-event reminders and the milestone reminders which carry a non-NULL schedule_id).
// Phase 5 (HOUSEKEEPING-NOTES.md): remindBooking moved to lib/booking-notifications.js — no
// remaining caller in app.js.

// POST — send the state-appropriate reminder for one booking.
router.post('/api/admin/bookings/:id/remind', requireAdmin, async (req, res) => {
    try {
        const result = await remindBooking(req.params.id);
        res.json({ success: true, ...result });
    } catch (e) {
        console.error('[Remind] failed for booking #' + req.params.id + ':', e.message);
        res.status(500).json({ success: false, message: e.message });
    }
});

// POST — bulk "Send reminder": each selected booking gets the reminder appropriate to its state.
router.post('/api/admin/bookings/bulk-remind', requireAdmin, requireRole(['administrator', 'manager']), async (req, res) => {
    const ids = Array.isArray(req.body.ids) ? req.body.ids.map(n => parseInt(n, 10)).filter(n => !isNaN(n)) : [];
    if (ids.length === 0) return res.status(400).json({ success: false, message: 'No bookings selected.' });
    if (ids.length > 200) return res.status(400).json({ success: false, message: 'Too many bookings selected (max 200).' });

    let sent = 0, skipped = 0, failed = 0;
    const breakdown = { quote: 0, contract: 0, balance: 0 };
    const errors = [];
    for (const id of ids) {
        try {
            const r = await remindBooking(id);
            if (r.sent) { sent++; if (breakdown[r.type] !== undefined) breakdown[r.type]++; }
            else skipped++;
        } catch (e) { failed++; errors.push(`#${id}: ${e.message}`); }
    }
    res.json({ success: true, sent, skipped, failed, breakdown, errors: errors.length ? errors : undefined });
});

// --- Booking Email Actions ---
router.post('/api/admin/bookings/:id/resend-quote', requireAdmin, async (req, res) => {
    db.get(`SELECT b.*, COALESCE(c.full_name, b.name) as client_name, COALESCE(c.email, b.email) as client_email
            FROM bookings b LEFT JOIN clients c ON b.client_id = c.id WHERE b.id = ?`,
        [req.params.id], async (err, b) => {
            if (err || !b) return res.status(404).json({ success: false });
            b.name = b.client_name || b.name; b.email = b.client_email || b.email;
            getLatestQuoteFileForResend(
                req.params.id, async (e, q) => {
                    if (!q) return res.status(404).json({ success: false, message: 'No quote found for this booking. Generate a quote first.' });
                    const pdfPath = resolveDocsPath('quotes', q.file_path);
                    await sendQuoteEmail(b, b.quote_amount, pdfPath, q.file_path);
                    markQuotationResent(req.params.id, () => {});
                    res.json({ success: true, message: 'Quote email resent.' });
                });
        });
});

router.post('/api/admin/bookings/:id/resend-confirmation', requireAdmin, async (req, res) => {
    db.get(`SELECT b.*, COALESCE(c.full_name, b.name) as client_name, COALESCE(c.email, b.email) as client_email
            FROM bookings b LEFT JOIN clients c ON b.client_id = c.id WHERE b.id = ?`,
        [req.params.id], async (err, b) => {
            if (err || !b) return res.status(404).json({ success: false });
            if (['CANCELLED', 'EXPIRED'].includes(b.status)) {
                return res.status(400).json({ success: false, message: `Cannot resend confirmation for a ${b.status} booking.` });
            }
            b.name = b.client_name || b.name; b.email = b.client_email || b.email;
            await sendBookingConfirmedEmail(b);
            res.json({ success: true, message: 'Confirmation email resent.' });
        });
});

router.post('/api/admin/bookings/:id/review-request', requireAdmin, (req, res) => {
    db.get(`SELECT b.*, COALESCE(c.full_name, b.name) as name, COALESCE(c.email, b.email) as email
            FROM bookings b LEFT JOIN clients c ON b.client_id = c.id WHERE b.id = ?`,
        [req.params.id], async (err, b) => {
            if (err || !b) return res.status(404).json({ success: false });
            if (b.status !== 'COMPLETED') return res.status(400).json({ success: false, message: 'Booking not completed.' });
            await sendReviewRequestEmail(b);
            // The cron (runPostEventFollowupJob) only sends when review_email_sent_at IS NULL — this
            // manual trigger never stamped it, so an admin clicking "Request Review" the same day an
            // event completes would get a second, duplicate auto-send from the cron the next day.
            stampReviewEmailSent(b.id);
            res.json({ success: true });
        });
});

// P2.0b — Book Again — creates a new PENDING booking pre-filled from a CANCELLED booking
router.post('/api/admin/bookings/:id/book-again', requireAdmin, async (req, res) => {
    const originalId = parseInt(req.params.id, 10);
    getBookingById(originalId, async (err, orig) => {
        if (err || !orig) return res.status(404).json({ success: false, message: 'Booking not found.' });
        if ((orig.status || '').toUpperCase() !== 'CANCELLED') {
            return res.status(400).json({ success: false, message: `Only CANCELLED bookings can be rebooked. Current status: ${orig.status}.` });
        }

        // The original date is only free because this booking is CANCELLED — it's excluded from
        // every conflict query. Someone else may have taken it since. Re-check before recreating a
        // live NEW booking on it, the same way every other booking-creation path does.
        if (!(req.body && req.body.override_conflict === true)) {
            try {
                let conflict;
                if (orig.event_start_time) {
                    const durationMins = (orig.performance_end_time && orig.event_start_time)
                        ? (() => {
                            const [eh, em] = orig.performance_end_time.split(':').map(Number);
                            const [sh, sm] = orig.event_start_time.split(':').map(Number);
                            return Math.max((eh * 60 + em) - (sh * 60 + sm), 30);
                          })()
                        : (parseDurationToMinutes(orig.performance_duration) || 120);
                    const startISO = moment(`${orig.date} ${orig.event_start_time}`).toISOString();
                    const endISO = moment(startISO).add(durationMins, 'minutes').toISOString();
                    conflict = await hasCalendarConflict(startISO, endISO);
                } else {
                    const avail = await new Promise((resolve, reject) =>
                        checkDateAvailability(orig.date, (e, r) => e ? reject(e) : resolve(r)));
                    conflict = !avail.available || (avail.busy_ranges && avail.busy_ranges.length > 0);
                }
                if (conflict) {
                    return res.status(409).json({
                        success: false,
                        conflict: true,
                        message: `${orig.date} is no longer free — it has since been booked or blocked. Choose a different date, or pass override_conflict:true to rebook on this date anyway.`
                    });
                }
            } catch (availErr) {
                console.error('[Book Again] Availability check failed:', availErr.message);
                return res.status(503).json({ success: false, message: 'Could not confirm availability just now. Please try again.' });
            }
        }

        // Copy client + event fields; reset all financial and lifecycle fields
        insertBookAgainBooking(
            [
                orig.name, orig.company || null, orig.email, orig.cell,
                orig.event_name || null, orig.date, orig.event_start_time || null, orig.performance_slot || null, orig.performance_duration || null,
                orig.event_location, orig.venue_address || null, orig.city || null, orig.country || null, orig.venue_type || null,
                orig.event_type, orig.audience_size || null, orig.audience_demographic || null, orig.budget_range || null,
                orig.travel_accommodation || 0, orig.message || '',
                originalId
            ],
            function(insErr) {
                if (insErr) return res.status(500).json({ success: false, message: insErr.message });
                const newId = this.lastID;
                // Audit on old booking
                db.run(
                    `INSERT INTO audit_log (table_name, record_id, action, new_values, changed_by, change_timestamp)
                     VALUES ('bookings', ?, 'REBOOKED', ?, ?, CURRENT_TIMESTAMP)`,
                    [originalId,
                     JSON.stringify({ new_booking_id: newId, note: 'Client rebooked — new booking created from this cancelled record' }),
                     req.session.adminId || 'admin']
                );
                // Audit on new booking
                db.run(
                    `INSERT INTO audit_log (table_name, record_id, action, new_values, changed_by, change_timestamp)
                     VALUES ('bookings', ?, 'CREATE', ?, ?, CURRENT_TIMESTAMP)`,
                    [newId,
                     JSON.stringify({ status: 'NEW', rebooked_from_id: originalId, note: 'Created via Book Again from cancelled booking' }),
                     req.session.adminId || 'admin']
                );
                res.json({ success: true, message: `New booking #${newId} created from cancelled booking #${originalId}.`, new_booking_id: newId });
            }
        );
    });
});

// Gap 11: POST — manually re-sync a booking to Google Calendar
router.post('/api/admin/bookings/:id/sync-calendar', requireAdmin, async (req, res) => {
    try {
        await syncBookingToCalendar(parseInt(req.params.id, 10));
        res.json({ success: true, message: 'Booking synced to Google Calendar.' });
    } catch (err) {
        console.error('[Calendar Sync]', err.message);
        res.status(500).json({ success: false, message: err.message });
    }
});

// --- Link a booking to a venue ---
router.put('/api/admin/bookings/:id/venue', requireAdmin, (req, res) => {
    const { venue_id } = req.body;
    const bookingId = req.params.id;

    if (!venue_id) {
        // Unlinking
        updateBookingVenueUnlink(
            bookingId,
            function(err) {
                if (err) return res.status(500).json({ error: err.message });
                if (this.changes === 0) return res.status(404).json({ error: 'Booking not found.' });

                // Update associated event to remove venue link
                getBookingEventId(bookingId, (eErr, bookingRow) => {
                    if (!eErr && bookingRow && bookingRow.event_id) {
                        unlinkEventVenue(bookingRow.event_id);
                    }
                });

                // Sync to calendar
                getBookingById(bookingId, (e, updated) => {
                    if (!e && updated) {
                        syncBookingToCalendar(updated).catch(ce => console.error('[Venue Unlink] Calendar sync failed:', ce.message));
                    }
                });

                res.json({ success: true, message: 'Venue unlinked.' });
            }
        );
    } else {
        // Linking by venue_id (legacy)
        db.get("SELECT * FROM venues WHERE id = ?", [venue_id], (vErr, venue) => {
            if (vErr || !venue) return res.status(400).json({ success: false, message: 'Venue not found.' });

            updateBookingVenueLinkLegacy(
                venue.id, venue.place_id, venue.name, venue.address, venue.city, venue.country, bookingId,
                function(err) {
                    if (err) return res.status(500).json({ error: err.message });
                    if (this.changes === 0) return res.status(404).json({ error: 'Booking not found.' });

                    // Update associated event
                    getBookingEventId(bookingId, (eErr, bookingRow) => {
                        if (!eErr && bookingRow && bookingRow.event_id) {
                            const mapLink = `https://maps.google.com/?q=${encodeURIComponent(venue.name + ' ' + (venue.address || ''))}`;
                            updateEventVenueLegacyLink(venue.name, venue.id, mapLink, bookingRow.event_id);
                        }
                    });

                    // Sync to calendar
                    getBookingById(bookingId, (e, updated) => {
                        if (!e && updated) {
                            syncBookingToCalendar(updated).catch(ce => console.error('[Venue Link] Calendar sync failed:', ce.message));
                        }
                    });

                    res.json({ success: true, message: 'Venue linked successfully.' });
                }
            );
        });
    }
});

// --- Link booking to a venue using Google Place details ---
router.put('/api/admin/bookings/:id/venue-google', requireAdmin, async (req, res) => {
    const { place_id, name, address, city, state, country, latitude, longitude } = req.body;
    const bookingId = req.params.id;

    if (!place_id || !name) {
        return res.status(400).json({ success: false, message: 'place_id and name are required.' });
    }

    try {
        const venueId = await new Promise((resolve, reject) => {
            db.get("SELECT id FROM venues WHERE place_id = ?", [place_id], (err, row) => {
                if (err) return reject(err);
                if (row) {
                    db.run(
                        `UPDATE venues SET 
                            name = ?, address = ?, city = ?, state = ?, country = ?, 
                            latitude = ?, longitude = ?, updated_at = CURRENT_TIMESTAMP 
                         WHERE id = ?`,
                        [name, address || null, city || null, state || null, country || null, latitude || null, longitude || null, row.id],
                        (upErr) => {
                            if (upErr) reject(upErr);
                            else resolve(row.id);
                        }
                    );
                } else {
                    db.run(
                        `INSERT INTO venues (name, address, city, state, country, place_id, latitude, longitude) 
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                        [name, address || null, city || null, state || null, country || null, place_id, latitude || null, longitude || null],
                        function(insErr) {
                            if (insErr) reject(insErr);
                            else resolve(this.lastID);
                        }
                    );
                }
            });
        });

        updateBookingVenueGoogle(
            venueId, place_id, name, address || null, city || null, country || null, bookingId,
            function(err) {
                if (err) return res.status(500).json({ success: false, message: err.message });
                if (this.changes === 0) return res.status(404).json({ success: false, message: 'Booking not found.' });

                getBookingEventId(bookingId, (eErr, bookingRow) => {
                    if (!eErr && bookingRow && bookingRow.event_id) {
                        const mapLink = `https://maps.google.com/?q=${encodeURIComponent(name + ' ' + (address || ''))}`;
                        updateEventVenueGoogleLink(name, venueId, mapLink, bookingRow.event_id);
                    }
                });

                getBookingById(bookingId, (e, updated) => {
                    if (!e && updated) {
                        syncBookingToCalendar(updated).catch(ce => console.error('[Venue Link] Calendar sync failed:', ce.message));
                    }
                });

                res.json({ success: true, message: 'Venue linked successfully.' });
            }
        );
    } catch(err) {
        console.error('[Link Google Venue Error]', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

// Phase 5 (HOUSEKEEPING-NOTES.md): findHoldDateConflict (single-consumer for the calendar hold
// create/move routes) moved to routes/admin/calendar.js.




/**
 * PATCH /api/admin/bookings/:id/date
 * Update booking event date and optionally time (used by FullCalendar eventDrop).
 * Accepts: { date: "YYYY-MM-DD", time?: "HH:MM" }
 */
router.patch('/api/admin/bookings/:id/date', requireAdmin, async (req, res) => {
    const { date, time } = req.body;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return res.status(400).json({ success: false, message: 'Valid date (YYYY-MM-DD) required.' });
    }
    if (time && !/^\d{2}:\d{2}$/.test(time)) {
        return res.status(400).json({ success: false, message: 'time must be HH:MM.' });
    }
    try {
        const row = await getBookingByIdAsync(req.params.id);
        if (!row) return res.status(404).json({ success: false, message: 'Booking not found.' });

        const oldDate = row.date;
        const oldTime = row.event_start_time;

        // Determine effective start/end times for conflict checking
        const effectiveTime = time !== undefined ? time : row.event_start_time;
        if (effectiveTime) {
            const durationMins = row.performance_end_time
                ? (() => {
                    const [eh, em] = row.performance_end_time.split(':').map(Number);
                    const [sh, sm] = row.event_start_time.split(':').map(Number);
                    return Math.max((eh * 60 + em) - (sh * 60 + sm), 30);
                  })()
                : parseDurationToMinutes(row.performance_duration);
            const newStartISO = moment(`${date} ${effectiveTime}`).toISOString();
            const newEndISO   = moment(newStartISO).add(durationMins, 'minutes').toISOString();
            const busy = await hasCalendarConflict(newStartISO, newEndISO, parseInt(req.params.id));
            if (busy) {
                return res.status(409).json({ success: false, message: `The new time slot on ${date} conflicts with an existing booking or block. Choose a different date/time.` });
            }
        } else {
            // No time on this booking (an "All Day / Custom Hours" request) and none supplied in
            // the move — it occupies the whole destination day, so ANY existing hold/event/booking
            // there is a conflict. This branch used to be skipped entirely whenever effectiveTime
            // was falsy, so an untimed booking could be dragged onto an already-fully-booked day
            // with no warning.
            const destAvail = await new Promise((resolve, reject) =>
                checkDateAvailability(date, (e, r) => e ? reject(e) : resolve(r), parseInt(req.params.id)));
            if (!destAvail.available || (destAvail.busy_ranges && destAvail.busy_ranges.length > 0)) {
                return res.status(409).json({ success: false, message: `${date} already has a booking or block on it and is not available for a full-day booking. Choose a different date.` });
            }
        }

        // Build update
        let newQuoteExpiry = row.quote_expiry_date;
        if (row.quote_expiry_date) {
            const eventMoment = moment(date);
            const currentExpiry = moment(row.quote_expiry_date);
            if (currentExpiry.isSameOrAfter(eventMoment)) {
                const proposed = eventMoment.clone().subtract(14, 'days');
                const minExpiry = moment().add(3, 'days');
                if (proposed.isBefore(minExpiry)) {
                    newQuoteExpiry = eventMoment.diff(moment(), 'days') > 3 ? minExpiry.format('YYYY-MM-DD') : null;
                } else {
                    newQuoteExpiry = proposed.format('YYYY-MM-DD');
                }
            }
        }

        // Compute new performance_end_time if time changed
        let newPerfEnd = row.performance_end_time;
        if (time !== undefined && time) {
            const dMins = parseDurationToMinutes(row.performance_duration) || 120;
            newPerfEnd = addMinutesToTime(time, dMins);
        }

        const setClauses = ['date = ?', 'quote_expiry_date = ?', 'modified_on = CURRENT_TIMESTAMP'];
        const params = [date, newQuoteExpiry];
        if (time !== undefined) {
            setClauses.push('event_start_time = ?');
            params.push(time || null);
            setClauses.push('performance_start_time = ?');
            params.push(time || null);
            setClauses.push('performance_end_time = ?');
            params.push(newPerfEnd || null);
        }
        params.push(req.params.id);

        await updateBookingDateAndTimeFields(setClauses.join(', '), params);

        db.run(`INSERT INTO audit_log (table_name, record_id, action, old_values, new_values) VALUES ('bookings', ?, 'UPDATE', ?, ?)`,
            [req.params.id, JSON.stringify({ date: oldDate, time: oldTime }), JSON.stringify({ date, time })]);
        updateDateHoldDateForBooking(date, req.params.id);

        // Sync linked event datetime when booking date changes
        if (row.event_id) {
            const effectiveStartTime = (time !== undefined ? time : row.event_start_time) || '00:00';
            const newEventDatetime = date + 'T' + effectiveStartTime;
            updateEventDatetime(newEventDatetime, row.event_id,
                (evErr) => { if (evErr) console.error('[Date Change] Event datetime sync failed:', evErr.message); }
            );
        }

        getBookingById(req.params.id, async (e, updated) => {
            if (!e && updated) syncBookingToCalendar(updated).catch(e => console.error('[Date Change] Calendar sync failed:', e.message));
        });

        sendDateChangedEmail(row, oldDate, date).catch(e => console.error('[Date Change] Client email failed:', e.message));

        res.json({ success: true, newDate: date, newTime: time !== undefined ? time : row.event_start_time });
    } catch (err) {
        console.error('[PATCH booking date]', err);
        res.status(500).json({ success: false, message: 'Server error updating booking date.' });
    }
});

/**
 * PATCH /api/admin/bookings/:id/venue
 * S5-2: Update booking location/venue details without regenerating the full quote.
 */
router.patch('/api/admin/bookings/:id/venue', requireAdmin, (req, res) => {
    const { event_location, venue_address, city, country, venue_type } = req.body;
    if (!event_location || !event_location.trim()) {
        return res.status(400).json({ success: false, message: 'event_location is required.' });
    }
    getBookingById(req.params.id, (err, row) => {
        if (err || !row) return res.status(404).json({ success: false, message: 'Booking not found.' });
        const oldLocation = row.event_location;
        updateBookingVenueFreeText(
            event_location.trim(), venue_address || null, city || null, country || null, venue_type || null, req.params.id,
            function(upErr) {
                if (upErr) return res.status(500).json({ success: false, error: upErr.message });
                db.run(
                    `INSERT INTO audit_log (table_name, record_id, action, old_values, new_values) VALUES ('bookings', ?, 'UPDATE', ?, ?)`,
                    [req.params.id, JSON.stringify({ event_location: oldLocation }), JSON.stringify({ event_location: event_location.trim() })]
                );
                // Propagate to the linked event's venue fields — this free-text venue editor was the
                // only one of the three venue-editing endpoints (PUT .../venue, PUT .../venue-google
                // both already do this) that left events.venue_name/venue_map_link stale after a change.
                if (row.event_id) {
                    const mapLink = `https://maps.google.com/?q=${encodeURIComponent(event_location.trim() + ' ' + (venue_address || ''))}`;
                    updateEventVenueFreeText(event_location.trim(), mapLink, row.event_id);
                }
                getBookingById(req.params.id, (e, updated) => {
                    if (!e && updated) {
                        syncBookingToCalendar(updated).catch(ce => console.error('[Venue Change] Calendar sync failed:', ce.message));
                    }
                });
                res.json({ success: true, message: 'Venue updated.' });
            }
        );
    });
});

router.post('/api/admin/bookings/:id/quote', requireAdmin, requireRole(['administrator', 'manager']), async (req, res) => {
    const bookingId = req.params.id;
    const isStructured = Array.isArray(req.body.items);
    
    db.get(`
        SELECT b.*, c.full_name as client_name, c.email as client_email, c.phone as client_phone, c.company_name as client_company
        FROM bookings b
        LEFT JOIN clients c ON b.client_id = c.id
        WHERE b.id = ?
    `, [bookingId], async (err, booking) => {
        try {
            if (err || !booking) return res.status(404).json({ success: false, message: 'Booking not found' });

            // Name/company stay as THIS booking's own values for the document — the shared clients
            // row can silently diverge from what this specific booking recorded (e.g. a later,
            // differently-named booking under the same email updates the one shared clients row),
            // which used to make a re-quoted PDF show a different name than the booking itself.
            // generateInvoice()/generateContract() already get this right by never overwriting it.
            booking.email = booking.client_email || booking.email;
            booking.cell = booking.client_phone || booking.cell;

            // Ensure client_id is resolved and updated in booking record if missing
            let clientId = booking.client_id;
            if (!clientId) {
                clientId = await findOrCreateClient(booking.name, booking.email, booking.cell, booking.company, booking.vat_number);
                await new Promise((resolve, reject) => {
                    setBookingClientId(clientId, bookingId, err => err ? reject(err) : resolve());
                });
                booking.client_id = clientId;
            }


            let quote_amount, quote_details, quote_expiry_date, finalTotal = 0;
            let items = [];

            if (isStructured) {
                const { quote_expiry_date: expiry, terms, items: bodyItems, discount, apply_vat } = req.body;
                if (!expiry || !bodyItems || bodyItems.length === 0) {
                    return res.status(400).json({ success: false, message: 'Missing required quote fields' });
                }
                if (booking.date && expiry >= booking.date) {
                    return res.status(400).json({ success: false, message: `Quote expiry date must be before the event date (${booking.date}).` });
                }
                if (expiry < new Date().toISOString().split('T')[0]) {
                    return res.status(400).json({ success: false, message: 'Quote expiry date cannot be in the past.' });
                }
                const minExpiry = new Date();
                minExpiry.setDate(minExpiry.getDate() + 3);
                if (expiry < minExpiry.toISOString().split('T')[0]) {
                    return res.status(400).json({ success: false, message: 'Quote expiry must be at least 3 days from today to give the client adequate time to respond.' });
                }
                
                bodyItems.forEach(i => {
                    i.quantity_minutes = parseFloat(i.quantity_minutes) || parseFloat(i.quantity) || 1; // normalization
                });

                // Conflict check
                if (!req.body.override_conflict && booking.date) {
                    const serviceIds = bodyItems.filter(i => i.service_id).map(i => i.service_id);
                    if (serviceIds.length) {
                        const dbServices = await new Promise((resolve) => {
                            db.all(`SELECT * FROM services WHERE id IN (${serviceIds.map(() => '?').join(',')})`, serviceIds, (err, rows) => resolve(rows || []));
                        });
                        
                        const maxServiceMins = dbServices.reduce((max, srv) => {
                            const rowInput = bodyItems.find(s => s.service_id == srv.id);
                            const isDurationBased = srv.pricing_model === 'per_minute' || srv.pricing_model === 'per_hour';
                            const qtyMins = rowInput ? (parseFloat(rowInput.quantity_minutes) || parseFloat(rowInput.quantity) || 0) : 0;
                            const length = isDurationBased && qtyMins > 0 ? qtyMins : (parseInt(srv.performance_length_minutes) || 0);
                            const total = length + (parseInt(srv.setup_time_minutes) || 0);
                            return Math.max(max, total);
                        }, 0);
                        
                        const durationMins = maxServiceMins > 0 ? maxServiceMins : 120;
                        const event_start_time = booking.event_start_time || '18:00';
                        const startTime = moment(`${booking.date} ${event_start_time}`).toISOString();
                        const endTime   = moment(startTime).add(durationMins, 'minutes').toISOString();
                        
                        // 1. Calendar conflict check
                        const isBusy = await hasCalendarConflict(startTime, endTime, bookingId);
                        if (isBusy) {
                            return res.status(409).json({
                                success: false,
                                conflict: true,
                                message: "Scheduling Conflict Detected: Thabiso is busy or holds exist during this slot. Do you want to override and send this quote anyway?"
                            });
                        }
                        
                        // 2. per_day availability rule check
                        const hasPerDayService = dbServices.some(s => s.availability_rule === 'per_day');
                        if (hasPerDayService) {
                            const conflictingBooking = await new Promise((resolve) => {
                                db.get(`
                                    SELECT b.id, b.event_name, s.name AS service_name
                                    FROM booking_services bs
                                    JOIN services s ON bs.service_id = s.id
                                    JOIN bookings b ON bs.booking_id = b.id
                                    WHERE b.date = ? 
                                      AND b.id != ? 
                                      AND b.status NOT IN ('CANCELLED', 'EXPIRED')
                                      AND s.availability_rule = 'per_day'
                                    LIMIT 1
                                `, [booking.date, bookingId], (err, row) => resolve(row));
                            });
                            if (conflictingBooking) {
                                return res.status(409).json({
                                    success: false,
                                    conflict: true,
                                    message: `Scheduling Conflict Detected: "${conflictingBooking.service_name}" is already booked on this day (Booking #${conflictingBooking.id}: "${conflictingBooking.event_name}"). Do you want to override and send this quote anyway?`
                                });
                            }
                        }
                    }
                }

                // FIN-2: tag each line's tax_class from the services catalog, then compute totals with
                // the shared helper so VAT is charged only on taxable lines and the quote total, the
                // stored invoice, and the PDF all agree.
                await resolveLineTaxClasses(bodyItems);
                let dp = parseFloat(discount) || 0;
                const vatRate = await getVatRate();
                const totals = computeDocumentTotals(bodyItems, { discount: dp, applyVat: !!apply_vat, vatRate });
                let subtotal = totals.subtotal;
                let vat = totals.vat;
                finalTotal = totals.total;
                items = bodyItems;

                quote_amount = finalTotal.toFixed(2);
                quote_details = JSON.stringify({ terms, items, discount: dp, apply_vat, finalTotal, subtotal, vat });
                quote_expiry_date = expiry;
                booking.discount = dp;
                booking.vat_rate = vatRate; // FIN-1/2: quote PDF uses the same rate as the calc
                booking.terms = terms;
            } else {
                // Unstructured fallback (legacy) — normalize to plain numeric string
                quote_amount = parseFloat((req.body.quote_amount || '0').replace(/[^0-9.]/g, '')).toFixed(2);
                quote_details = req.body.quote_details;
                quote_expiry_date = req.body.quote_expiry_date;
                finalTotal = parseFloat((quote_amount || '0').replace(/[^0-9.]/g, '')) || 0;
                items = [{ description: quote_details || 'Booking Service', quantity_minutes: 0, unit_price: finalTotal }];
                
                if (!quote_amount || !quote_details || !quote_expiry_date) {
                    return res.status(400).json({ success: false, message: 'Missing required quote fields' });
                }
            }

            const currentStatus = (booking.status || '').toUpperCase();
            // Gap 3 (Phase 2): re-quoting a booking the client has already committed to returns it to
            // QUOTED, supersedes its unpaid milestones and voids its live invoice, so the client must
            // consent to the new total. Paid milestones and any PAID invoice survive — that money moved.
            //
            // "Committed" means ACCEPTED *or* CONFIRMED. A deposit confirms a booking, and CONFIRMED
            // used to be excluded here: total_amount silently moved to the new figure while the invoice
            // and the payment plan still described the old one, and the client could not re-accept
            // (accept-quote requires QUOTED), so the booking was stranded mid-negotiation.
            //
            // The writes this implies live INSIDE the transaction below — they used to run here, before
            // it opened, fire-and-forget with no error callback, so a rolled-back quote left the booking
            // committed with its schedules superseded and its invoice VOID.
            const reQuotingCommitted = currentStatus === 'ACCEPTED' || currentStatus === 'CONFIRMED';
            let nextStatus = ['NEW', 'PENDING', 'REVIEWED', 'ACCEPTED', 'CONFIRMED'].includes(currentStatus) ? 'QUOTED' : currentStatus;

            // Ensure directory exists
            const quotesDir = docsWriteDir('quotes');

            // Allocate the quote number the same way generateInvoice() allocates an invoice number.
            // `quotations.quote_number` is UNIQUE and the timestamp only resolves to the second, so two
            // quotes for one booking inside the same second — a double-click on Generate Quote — used to
            // collide and roll the second one back with a 500. A revision suffix disambiguates them, and
            // an archived quote keeps its number.
            //   first:  QT-44-260710143012
            //   again:  QT-44-260710143012-R2, -R3, …
            const baseQuoteNumber = `QT-${bookingId}-${moment().format('YYMMDDHHmmss')}`;
            const priorQuotes = await getQuoteNumberCollisionCount(baseQuoteNumber, `${baseQuoteNumber}-R%`);
            const quoteNumber = priorQuotes === 0 ? baseQuoteNumber : `${baseQuoteNumber}-R${priorQuotes + 1}`;

            // Generate PDF
            const pdfFileName = `${quoteNumber}.pdf`;
            const pdfPath = path.join(quotesDir, pdfFileName);

            // Pass apply_vat to booking object for pdfService
            booking.apply_vat = req.body.apply_vat;

            try {
                // quoteNumber is passed through so the number on the client's PDF is the number stored in
                // `quotations.quote_number`, as invoices now do.
                const pdfResult = await pdfService.generateDocument('Quote', booking, items, pdfPath, [], quoteNumber);
                
                // Archive the old quotation, restamp the booking, insert the new versioned quotation
                // and rebuild its line-item snapshot — one atomic unit, queued behind every other
                // guarded transaction on the shared connection.
                //
                // The two DELETEs below previously ran with their error callbacks issuing a ROLLBACK
                // and a 500 while the insertNext() chain carried on regardless, so a failed clear
                // could produce a second response on the same request.
                const quoteResult = await withDbTransaction(async () => {
                    try {
                        await dbRun("BEGIN IMMEDIATE");
                    } catch (beginErr) {
                        console.error('[Quote] BEGIN IMMEDIATE failed:', beginErr.message);
                        return { status: 500, body: { success: false, message: 'Database busy. Please retry.' } };
                    }
                    try {
                        // Re-quoting an ACCEPTED booking: supersede its stale schedules and void its
                        // live invoice, atomically with the new quote. If the quote fails, none of
                        // this happens and the booking keeps the plan the client already accepted.
                        if (reQuotingCommitted) {
                            await supersedePaymentSchedulesForRequote(bookingId);
                            await voidInvoiceForRequote(bookingId);
                            // A contract embodies the amount the client accepted; a re-quote changes that
                            // amount, so any existing contract — draft, sent, or even signed/frozen — is
                            // superseded and reset to draft. This clears the client's signature and the
                            // freeze so a fresh contract must be generated and re-signed at the new figure,
                            // preventing an old-amount (possibly already-signed) contract from surviving a
                            // re-quote. A SUPERSEDED_BY_REQUOTE audit row records the invalidation.
                            const supersededContract = await dbGet("SELECT status, is_frozen, contract_amount FROM contracts WHERE booking_id = ?", [bookingId]);
                            await dbRun(
                                `UPDATE contracts SET status = 'draft', is_frozen = 0,
                                        sent_to_client_at = NULL, signed_by_client_at = NULL, signed_by_comedian_at = NULL,
                                        client_signature_data = NULL, client_ip_address = NULL, signed_by = NULL, signed_date = NULL,
                                        content_hash = NULL, updated_at = CURRENT_TIMESTAMP
                                 WHERE booking_id = ?`,
                                [bookingId]);
                            if (supersededContract) {
                                await dbRun(`INSERT INTO audit_log (table_name, record_id, action, new_values, changed_by, change_timestamp)
                                        VALUES ('contracts', ?, 'SUPERSEDED_BY_REQUOTE', ?, ?, CURRENT_TIMESTAMP)`,
                                    [bookingId, JSON.stringify({ previous_status: supersededContract.status, was_frozen: supersededContract.is_frozen === 1, previous_amount: supersededContract.contract_amount }), req.session.adminId || 'admin']);
                            }
                            await dbRun(`INSERT INTO audit_log (table_name, record_id, action, new_values, changed_by, change_timestamp)
                                    VALUES ('bookings', ?, 'REQUOTE_AFTER_ACCEPTED', ?, ?, CURRENT_TIMESTAMP)`,
                                [bookingId, JSON.stringify({ previous_status: currentStatus, new_status: 'QUOTED' }), req.session.adminId || 'admin']);
                        }

                        // Archive all previous active quotations for this booking
                        await archivePreviousQuotations(bookingId);

                        // 1. Update Booking.
                        // quote_amount is kept on bookings for backward-compat (legacy email templates + admin UI
                        // fallback). The bookings SELECT query prefers quotations.total_amount when a quotations
                        // row exists. We also update quote_details JSON for fallback/caching on details/invoice generation.
                        const currentPaid = parseFloat(booking.amount_paid) || 0;
                        const newOutstanding = Math.max(0, finalTotal - currentPaid);
                        await updateBookingAfterQuote(quote_amount, quote_details, quote_expiry_date, nextStatus, finalTotal, newOutstanding, bookingId);

                        // 2. Next version
                        const vRow = await getNextQuoteVersion(bookingId);
                        const nextVersion = vRow ? vRow.next_version : 1;

                        // 3. Insert new versioned Quotation
                        const qIns = await insertQuotation(bookingId, quoteNumber, booking.client_id, quote_expiry_date, finalTotal, pdfFileName, nextVersion);
                        const quotationId = qIns.lastID;

                        // 4. Refresh line items (current snapshot)
                        await deleteBookingLineItems(bookingId);
                        await deleteBookingServices(bookingId);

                        for (const it of items) {
                            const q = parseFloat(it.quantity_minutes) || parseFloat(it.quantity) || 0;
                            const p = parseFloat(it.unit_price) || 0;
                            const desc = it.description || it.service_name || 'Service';
                            await insertBookingLineItem(bookingId, it.service_id || null, desc, q || 1, p);
                            if (it.service_id) {
                                await insertBookingService(bookingId, it.service_id, q, p, q * p);
                            }
                            await insertQuoteLineItem(quotationId, it.service_id || null, desc, q, p);
                        }

                        // P3-3: Audit log for quote generation — inside the transaction, so a rollback
                        // never leaves a log entry for a quote that was not issued.
                        await dbRun(`INSERT INTO audit_log (table_name, record_id, action, new_values, changed_by, change_timestamp)
                                     VALUES ('quotations', ?, 'QUOTE_GENERATED', ?, ?, CURRENT_TIMESTAMP)`,
                            [bookingId, JSON.stringify({ version: nextVersion, amount: finalTotal, expiry: quote_expiry_date }), req.session.adminId || 'admin']);

                        await dbRun("COMMIT");
                        return { ok: true, nextVersion };
                    } catch (txErr) {
                        await dbRun("ROLLBACK").catch(() => {});
                        console.error("[Quote] Generation failed — rolled back, quote not issued:", txErr.message);
                        // The structured branch takes items[].service_id on trust, and
                        // booking_services.service_id carries a foreign key. An unknown id therefore
                        // aborts the insert; that is the admin's mistake, not a server fault.
                        if (/SQLITE_CONSTRAINT/i.test(txErr.message || '') && /FOREIGN KEY/i.test(txErr.message || '')) {
                            return { status: 400, body: { success: false, message: 'One or more selected services no longer exist. Refresh the service list and rebuild the quote.' } };
                        }
                        return { status: 500, body: { success: false, message: 'Database error: ' + txErr.message } };
                    }
                });

                if (!quoteResult.ok) return res.status(quoteResult.status).json(quoteResult.body);
                const nextVersion = quoteResult.nextVersion;

                // ---- Side effects, after the commit ----
                syncBookingToCalendar(booking).catch(e => console.error('[Quote] Calendar sync failed:', e.message));
                sendQuoteEmail(booking, quote_amount, pdfPath, pdfFileName, items).catch(e => console.error("Quote email error:", e));
                sendAdminQuoteSentNotification(booking, quote_amount).catch(e => console.error('[Quote] Admin notif failed:', e.message));

                // Per-day availability warning (non-blocking for admins)
                const perDaySvcIds = items.filter(i => i.service_id).map(i => i.service_id);
                const sendResponse = (warnings) => res.json({ success: true, message: 'Quote generated and sent.', status: nextStatus, pdfUrl: `/docs/quotes/${pdfFileName}`, version: nextVersion, warnings: warnings.length ? warnings : undefined });
                if (perDaySvcIds.length && !req.body.override_conflict) {
                    db.all(`SELECT name FROM services WHERE id IN (${perDaySvcIds.map(() => '?').join(',')}) AND availability_rule = 'per_day'`, perDaySvcIds, (_, perDayRows) => {
                        sendResponse((perDayRows || []).map(s => `"${s.name}" is limited to one booking per day — verify no date conflicts exist.`));
                    });
                } else {
                    sendResponse([]);
                }
        } catch (pdfErr) {
            console.error("PDF/Quote Error:", pdfErr);
            res.status(500).json({ success: false, message: 'Failed to generate quote PDF.' });
        }
        } catch (topLevelError) {
            console.error("Unhandled Top Level Error in Quote Generation:", topLevelError);
            // Phase 5 housekeeping: __dirname here would resolve to routes/admin (this file's own
            // location), not the project root as it did in app.js — PROJECT_ROOT preserves the
            // original target path (<root>/scratch/quote-error-toplevel.log) exactly.
            fs.writeFileSync(path.join(PROJECT_ROOT, 'scratch', 'quote-error-toplevel.log'), topLevelError.stack || topLevelError.message);
            if (!res.headersSent) {
                res.status(500).json({ success: false, message: 'Internal server error during quote generation: ' + topLevelError.message });
            }
        }
    });
});

module.exports = router;
