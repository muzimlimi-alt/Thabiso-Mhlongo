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
const { resolveDocsPath, docsWriteDir } = require('../../lib/runtime-paths');
const { calculateCancellationRefund } = require('../../lib/cancellation-refund');
const { escapeEmailFields } = require('../../lib/email-escape');
const { getEmailFooterContext } = require('../../lib/email-context');
const {
    DEFAULT_CONTRACT_CLAUSES, CONTRACT_ELIGIBLE_STATUSES,
    resolveContractFeeData, assembleContractHtml, generateContract
} = require('../../lib/contracts');
const bannerRegistry = require('../../js/bannerRegistry');
const emailComponents = require('../../js/emailComponents');
const { sendEmail } = require('../../js/emailService');
const {
    getBookingNotesForBooking, insertBookingNote, getBookingNoteById, deleteBookingNote,
    unlinkBookingClient, getBookingStatusNameEmail, reopenBooking, getBookingStatus, getBookingForContractRemind
} = require('../../database/repositories/bookings.repository');
const {
    getQuoteHistoryForBooking, getQuoteForBookingFinancials, getInvoiceForBookingFinancials,
    getInvoiceFileForAdminDownload, getQuoteFileForAdminDownload
} = require('../../database/repositories/invoices-quotations.repository');
const { getExpensesForBooking, getCancellationDetailForBooking, getTransactionsForBooking } = require('../../database/repositories/finance.repository');
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

module.exports = router;
