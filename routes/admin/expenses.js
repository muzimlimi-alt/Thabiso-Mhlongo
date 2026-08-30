const express = require('express');
const multer = require('multer');
const path = require('path');
const db = require('../../database');
const { requireAdmin } = require('../../middleware/auth');
const { requireRole } = require('../../middleware/rbac');
const { uploadsWriteDir } = require('../../lib/runtime-paths');
const { insertExpense, getActiveExpenseById, softDeleteExpense, updateExpense } = require('../../database/repositories/finance.repository');
const router = express.Router();

const VALID_EXPENSE_CATEGORIES = ['mileage','airfare','accommodation','meals','per_diem','parking_tolls','marketing','props','misc'];

// Receipt file storage for expenses
const receiptStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadsWriteDir('receipts'));
    },
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        cb(null, 'receipt-' + Date.now() + ext);
    }
});
const uploadReceipt = multer({
    storage: receiptStorage,
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const ok = /\.(jpg|jpeg|png|gif|webp|pdf)$/i.test(path.extname(file.originalname));
        ok ? cb(null, true) : cb(new Error('Only images and PDFs allowed.'));
    }
});

// GET /api/admin/expenses — list with optional filters
router.get('/api/admin/expenses', requireAdmin, requireRole(['administrator', 'manager']), (req, res) => {
    const { booking_id, category, date_from, date_to, limit, offset } = req.query;
    let query = `SELECT e.*, b.event_name, b.name AS client_name
                 FROM expenses e
                 LEFT JOIN bookings b ON e.booking_id = b.id
                 WHERE e.deleted_at IS NULL`;
    const params = [];
    if (booking_id) { query += ' AND e.booking_id = ?'; params.push(booking_id); }
    if (category)   { query += ' AND e.category = ?';   params.push(category); }
    if (date_from)  { query += ' AND e.expense_date >= ?'; params.push(date_from); }
    if (date_to)    { query += ' AND e.expense_date <= ?'; params.push(date_to); }
    query += ' ORDER BY e.expense_date DESC LIMIT ? OFFSET ?';
    params.push(Math.min(parseInt(limit) || 500, 1000), parseInt(offset) || 0);

    db.all(query, params, (err, rows) => {
        if (err) return res.status(500).json({ success: false, message: err.message });
        res.json({ success: true, expenses: rows || [] });
    });
});

// POST /api/admin/expenses — create a new expense
router.post('/api/admin/expenses', requireAdmin, requireRole(['administrator', 'manager']), (req, res) => {
    const { booking_id, category, amount, description, expense_date, receipt_url,
            start_odometer, end_odometer, rate_per_km,
            per_diem_days, per_diem_rate,
            vat_paid, vat_rate, vendor } = req.body;
    if (!category || !VALID_EXPENSE_CATEGORIES.includes(category)) {
        return res.status(400).json({ success: false, message: `Invalid category. Must be one of: ${VALID_EXPENSE_CATEGORIES.join(', ')}.` });
    }
    if (!amount || isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) {
        return res.status(400).json({ success: false, message: 'A valid positive amount is required.' });
    }
    if (!description || !description.trim()) {
        return res.status(400).json({ success: false, message: 'Description is required.' });
    }
    if (!expense_date) {
        return res.status(400).json({ success: false, message: 'Expense date is required.' });
    }
    const addedBy = req.session.username || 'system';

    insertExpense(
        [booking_id || null, category, parseFloat(amount).toFixed(2), description.trim(), expense_date, receipt_url || null,
         start_odometer ? parseInt(start_odometer) : null, end_odometer ? parseInt(end_odometer) : null,
         rate_per_km ? parseFloat(rate_per_km) : null,
         per_diem_days ? parseFloat(per_diem_days) : null, per_diem_rate ? parseFloat(per_diem_rate) : null,
         vat_paid ? parseFloat(vat_paid) : null, vat_rate ? parseFloat(vat_rate) : null,
         vendor ? vendor.trim() : null],
        function(err) {
            if (err) return res.status(500).json({ success: false, message: err.message });
            const expenseId = this.lastID;

            // Audit logs
            db.run(
                `INSERT INTO audit_log (table_name, record_id, action, changed_by, changes_json)
                 VALUES ('expenses', ?, 'CREATE', ?, ?)`,
                [expenseId, addedBy, JSON.stringify({ category, amount, description, booking_id: booking_id || null })],
                () => {}
            );
            db.run(
                `INSERT INTO financial_audit_log (event_type, entity_type, entity_id, amount, changed_by, notes)
                 VALUES ('EXPENSE_LOGGED', 'expense', ?, ?, ?, ?)`,
                [expenseId, parseFloat(amount), addedBy, `Category: ${category}, Description: ${description}`],
                () => {}
            );

            res.json({ success: true, id: expenseId, message: 'Expense logged successfully.' });
        }
    );
});

// DELETE /api/admin/expenses/:id — delete (soft-delete) an expense
router.delete('/api/admin/expenses/:id', requireAdmin, requireRole(['administrator']), (req, res) => {
    const addedBy = req.session.username || 'system';
    getActiveExpenseById(req.params.id, (err, row) => {
        if (err || !row) return res.status(404).json({ success: false, message: 'Expense not found.' });
        softDeleteExpense(req.params.id, function(e2) {
            if (e2) return res.status(500).json({ success: false, message: e2.message });
            db.run(
                `INSERT INTO audit_log (table_name, record_id, action, changed_by, changes_json)
                 VALUES ('expenses', ?, 'DELETE', ?, ?)`,
                [req.params.id, addedBy, JSON.stringify({ deleted: row })],
                () => {}
            );
            db.run(
                `INSERT INTO financial_audit_log (event_type, entity_type, entity_id, amount, changed_by, notes)
                 VALUES ('EXPENSE_DELETED', 'expense', ?, ?, ?, ?)`,
                [req.params.id, parseFloat(row.amount || 0), addedBy, `Deleted description: ${row.description}`],
                () => {}
            );
            res.json({ success: true, message: 'Expense deleted.' });
        });
    });
});

// PUT /api/admin/expenses/:id — edit an existing expense
router.put('/api/admin/expenses/:id', requireAdmin, requireRole(['administrator', 'manager']), (req, res) => {
    const expenseId = req.params.id;
    const addedBy = req.session.username || 'system';
    getActiveExpenseById(expenseId, (err, existing) => {
        if (err || !existing) return res.status(404).json({ success: false, message: 'Expense not found.' });
        const { booking_id, category, amount, description, expense_date, receipt_url,
                start_odometer, end_odometer, rate_per_km,
                per_diem_days, per_diem_rate, vat_paid, vat_rate, vendor } = req.body;
        if (category && !VALID_EXPENSE_CATEGORIES.includes(category))
            return res.status(400).json({ success: false, message: 'Invalid category.' });
        if (amount && (isNaN(parseFloat(amount)) || parseFloat(amount) <= 0))
            return res.status(400).json({ success: false, message: 'Amount must be greater than zero.' });
        updateExpense(
            [
                booking_id !== undefined ? (booking_id || null) : existing.booking_id,
                category || existing.category,
                amount ? parseFloat(amount).toFixed(2) : existing.amount,
                description ? description.trim() : existing.description,
                expense_date || existing.expense_date,
                receipt_url !== undefined ? (receipt_url || null) : existing.receipt_url,
                start_odometer !== undefined ? (start_odometer ? parseInt(start_odometer) : null) : existing.start_odometer,
                end_odometer !== undefined ? (end_odometer ? parseInt(end_odometer) : null) : existing.end_odometer,
                rate_per_km !== undefined ? (rate_per_km ? parseFloat(rate_per_km) : null) : existing.rate_per_km,
                per_diem_days !== undefined ? (per_diem_days ? parseFloat(per_diem_days) : null) : existing.per_diem_days,
                per_diem_rate !== undefined ? (per_diem_rate ? parseFloat(per_diem_rate) : null) : existing.per_diem_rate,
                vat_paid !== undefined ? (vat_paid ? parseFloat(vat_paid) : null) : existing.vat_paid,
                vat_rate !== undefined ? (vat_rate ? parseFloat(vat_rate) : null) : existing.vat_rate,
                vendor !== undefined ? (vendor ? vendor.trim() : null) : existing.vendor,
                expenseId
            ],
            function(e2) {
                if (e2) return res.status(500).json({ success: false, message: e2.message });
                db.run(
                    `INSERT INTO audit_log (table_name, record_id, action, changed_by, changes_json)
                     VALUES ('expenses', ?, 'UPDATE', ?, ?)`,
                    [expenseId, addedBy, JSON.stringify({ before: existing, after: req.body })],
                    () => {}
                );
                db.run(
                    `INSERT INTO financial_audit_log (event_type, entity_type, entity_id, amount, changed_by, notes)
                     VALUES ('EXPENSE_EDITED', 'expense', ?, ?, ?, ?)`,
                    [expenseId, amount ? parseFloat(amount) : parseFloat(existing.amount), addedBy, `Edited description: ${description || existing.description}`],
                    () => {}
                );
                res.json({ success: true, message: 'Expense updated.' });
            }
        );
    });
});

// GET /api/admin/expenses/export — CSV download for all expenses (respects same filters as list)
router.get('/api/admin/expenses/export', requireAdmin, requireRole(['administrator', 'manager']), (req, res) => {
    const { category, date_from, date_to, booking_id } = req.query;
    let sql = `SELECT e.*, b.event_name, b.name AS client_name
               FROM expenses e
               LEFT JOIN bookings b ON e.booking_id = b.id
               WHERE e.deleted_at IS NULL`;
    const params = [];
    if (category)   { sql += ' AND e.category = ?';       params.push(category); }
    if (date_from)  { sql += ' AND e.expense_date >= ?';  params.push(date_from); }
    if (date_to)    { sql += ' AND e.expense_date <= ?';  params.push(date_to); }
    if (booking_id) { sql += ' AND e.booking_id = ?';     params.push(booking_id); }
    sql += ' ORDER BY e.expense_date DESC';
    db.all(sql, params, (err, rows) => {
        if (err) return res.status(500).json({ success: false, message: err.message });
        const today = new Date().toISOString().split('T')[0];
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="expenses_export_${today}.csv"`);
        const header = 'ID,Date,Category,Description,Client,Event,Amount,VAT Paid,VAT Rate (%),KM Total,Rate/KM,Per Diem Days,Per Diem Rate,Receipt URL\n';
        const csv = (rows || []).map(r => [
            r.id,
            r.expense_date,
            r.category,
            '"' + (r.description || '').replace(/"/g, '""') + '"',
            '"' + (r.client_name || '').replace(/"/g, '""') + '"',
            '"' + (r.event_name || '').replace(/"/g, '""') + '"',
            r.amount,
            r.vat_paid || '',
            r.vat_rate || '',
            r.total_km || '',
            r.rate_per_km || '',
            r.per_diem_days || '',
            r.per_diem_rate || '',
            '"' + (r.receipt_url || '').replace(/"/g, '""') + '"'
        ].join(',')).join('\n');
        res.send(header + csv);
    });
});

// POST /api/admin/expenses/upload-receipt — upload a receipt file for an expense
router.post('/api/admin/expenses/upload-receipt', requireAdmin, requireRole(['administrator', 'manager']), uploadReceipt.single('receipt'), (req, res) => {
    if (!req.file) return res.status(400).json({ success: false, message: 'No file received.' });
    const url = '/uploads/receipts/' + req.file.filename;
    res.json({ success: true, url, filename: req.file.originalname });
});

module.exports = router;
