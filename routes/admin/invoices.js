const express = require('express');
const fs = require('fs');
const db = require('../../database');
const { requireAdmin } = require('../../middleware/auth');
const { requireRole } = require('../../middleware/rbac');
const { resolveDocsPath } = require('../../lib/runtime-paths');
const { sendInvoiceEmail } = require('../../lib/invoice-email');
const {
    markInvoiceSent, markInvoiceSentAndPublished, getInvoiceById, voidInvoiceWithReason, markInvoicePaidById
} = require('../../database/repositories/invoices-quotations.repository');
const router = express.Router();

// --- Invoice Actions ---
router.post('/api/admin/invoices/:id/send', requireAdmin, requireRole(['administrator', 'manager']), (req, res) => {
    db.get(`SELECT i.*, b.id as booking_id_num, b.email, b.name, b.event_name, b.event_type, b.date
            FROM invoices i JOIN bookings b ON i.booking_id = b.id WHERE i.id = ?`, [req.params.id], async (err, inv) => {
        if (err || !inv) return res.status(404).json({ error: 'Invoice not found.' });
        const invoiceFilePath = inv.file_path ? resolveDocsPath('invoices', inv.file_path) : null;
        if (!invoiceFilePath || !fs.existsSync(invoiceFilePath)) {
            return res.status(400).json({ error: 'Invoice PDF not found. Please regenerate the invoice first.' });
        }
        if ((inv.status || '').toUpperCase() === 'VOID') {
            return res.status(400).json({ error: 'This invoice is void and cannot be sent.' });
        }
        try {
            const bookingObj = { id: inv.booking_id, name: inv.name, email: inv.email, event_name: inv.event_name, event_type: inv.event_type, date: inv.date };
            await sendInvoiceEmail(bookingObj, invoiceFilePath);
            // Draft-then-send: first send publishes the draft (DRAFT→SENT). A later resend leaves an
            // already-advanced status (SENT/OVERDUE/PAID) untouched — only sent_at refreshes.
            const wasDraft = (inv.status || '').toUpperCase() === 'DRAFT';
            markInvoiceSentAndPublished(req.params.id, () => {});
            res.json({ success: true, message: `Invoice ${inv.invoice_number} ${wasDraft ? 'sent' : 'resent'} to ${inv.email}.` });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
});

// POST /api/admin/invoices/bulk-send-unsent — email all generated-but-unsent invoices
router.post('/api/admin/invoices/bulk-send-unsent', requireAdmin, requireRole(['administrator', 'manager']), (req, res) => {
    db.all(
        `SELECT i.*, b.id AS booking_id_num, b.email, b.name, b.event_name, b.event_type, b.date
         FROM invoices i
         JOIN bookings b ON i.booking_id = b.id
         WHERE i.sent_at IS NULL AND i.status NOT IN ('VOID') AND b.status = 'CONFIRMED'`,
        [],
        async (err, rows) => {
            if (err) return res.status(500).json({ success: false, message: err.message });
            if (!rows.length) return res.json({ success: true, sent: 0, message: 'No unsent invoices.' });
            let sent = 0, failed = 0, errors = [];
            for (const inv of rows) {
                const invoiceFilePath = inv.file_path ? resolveDocsPath('invoices', inv.file_path) : null;
                if (!invoiceFilePath || !fs.existsSync(invoiceFilePath)) { failed++; errors.push(inv.invoice_number + ': PDF missing'); continue; }
                try {
                    const bookingObj = { id: inv.booking_id, name: inv.name, email: inv.email, event_name: inv.event_name, event_type: inv.event_type, date: inv.date };
                    await sendInvoiceEmail(bookingObj, invoiceFilePath);
                    markInvoiceSent(inv.id, () => {});
                    sent++;
                } catch(e) { failed++; errors.push(inv.invoice_number + ': ' + e.message); }
            }
            res.json({ success: true, sent, failed, errors: errors.length ? errors : undefined });
        }
    );
});

router.post('/api/admin/invoices/:id/void', requireAdmin, requireRole(['administrator']), (req, res) => {
    const { reason } = req.body;
    if (!reason || !reason.trim()) {
        return res.status(400).json({ error: 'Void reason is required.' });
    }
    const adminUser = req.session.username || 'system';
    getInvoiceById(req.params.id, (err, inv) => {
        if (err || !inv) return res.status(404).json({ error: 'Invoice not found.' });
        voidInvoiceWithReason(
            reason.trim(), req.params.id,
            function(e2) {
                if (e2) return res.status(500).json({ error: e2.message });
                if (this.changes === 0) return res.status(404).json({ error: 'Invoice not found.' });
                // Audit log the void with mandatory reason
                db.run(
                    `INSERT INTO audit_log (table_name, record_id, action, changed_by, changes_json)
                     VALUES ('invoices', ?, 'VOID', ?, ?)`,
                    [req.params.id, adminUser, JSON.stringify({ reason: reason.trim(), invoice_number: inv.invoice_number })],
                    () => {}
                );
                // Log to financial_audit_log
                db.run(
                    `INSERT INTO financial_audit_log (event_type, entity_type, entity_id, amount, changed_by, notes)
                     VALUES ('INVOICE_VOIDED', 'invoice', ?, ?, ?, ?)`,
                    [req.params.id, parseFloat(inv.total_amount || 0), adminUser, `Reason: ${reason.trim()}, Invoice Number: ${inv.invoice_number}`],
                    () => {}
                );
                res.json({ success: true, message: `Invoice ${inv.invoice_number} voided.` });
            }
        );
    });
});

// POST /api/admin/invoices/:id/mark-paid — quick-mark an invoice as PAID
router.post('/api/admin/invoices/:id/mark-paid', requireAdmin, requireRole(['administrator', 'manager']), (req, res) => {
    const adminUser = req.session.username || 'system';
    getInvoiceById(req.params.id, (err, inv) => {
        if (err || !inv) return res.status(404).json({ success: false, error: 'Invoice not found.' });
        if (inv.status === 'VOID') {
            return res.status(400).json({ success: false, error: 'Cannot mark a voided invoice as paid.' });
        }
        if (inv.status === 'PAID') {
            return res.json({ success: true, message: 'Invoice is already marked as paid.' });
        }
        markInvoicePaidById(
            req.params.id,
            function(e2) {
                if (e2) return res.status(500).json({ success: false, error: e2.message });
                // Audit log
                db.run(
                    `INSERT INTO audit_log (table_name, record_id, action, changed_by, changes_json)
                     VALUES ('invoices', ?, 'MARK_PAID', ?, ?)`,
                    [req.params.id, adminUser, JSON.stringify({ invoice_number: inv.invoice_number, previous_status: inv.status })],
                    () => {}
                );
                // Log to financial_audit_log
                db.run(
                    `INSERT INTO financial_audit_log (event_type, entity_type, entity_id, amount, changed_by, notes)
                     VALUES ('INVOICE_MARKED_PAID', 'invoice', ?, ?, ?, ?)`,
                    [req.params.id, parseFloat(inv.total_amount || 0), adminUser, `Invoice Number: ${inv.invoice_number}`],
                    () => {}
                );
                res.json({ success: true, message: `Invoice ${inv.invoice_number} marked as PAID.` });
            }
        );
    });
});

// 3. Admin Invoice View
router.get('/api/admin/invoices', requireAdmin, requireRole(['administrator', 'manager']), (req, res) => {
    db.all(`SELECT i.*, b.name as client_name, b.event_name, b.date as event_date 
            FROM invoices i 
            JOIN bookings b ON i.booking_id = b.id 
            ORDER BY i.invoice_date DESC`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

module.exports = router;
