const express = require('express');
const multer = require('multer');
const db = require('../../database');
const { requireAdmin } = require('../../middleware/auth');
const { requireRole } = require('../../middleware/rbac');
const {
    getBankStatementImportBatches, matchBankStatementLine,
    deleteBankStatementLine, deleteBankStatementBatch
} = require('../../database/repositories/finance.repository');
const { withDbTransaction } = require('../../lib/db-transaction');
const { dbRun } = require('../../lib/db-helpers');
const router = express.Router();

const csvUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// POST /api/admin/bank-statement/import — parse and store a CSV bank statement
//
// FIX (HOUSEKEEPING-NOTES.md, Deferred fix #4): this used to wrap the insert loop in
// `db.transaction(() => {...})` over a `db.prepare(...)` statement — both better-sqlite3 APIs that
// don't exist on this app's plain sqlite3.Database, so every import threw a synchronous TypeError
// before a single row was inserted; the route has never worked. Rewritten to use this app's own
// transaction primitives (withDbTransaction + dbRun — the same pattern used throughout
// lib/popia.js) so the insert loop is still atomic (one bad CSV can't leave a half-imported batch
// behind) but now actually runs on the driver this app uses. Parsing/validation (line format,
// header-row skip, the parts.length/amount checks) is unchanged from the original.
router.post('/api/admin/bank-statement/import', requireAdmin, requireRole(['administrator', 'manager']), csvUpload.single('statement'), async (req, res) => {
    if (!req.file) return res.status(400).json({ success: false, message: 'No file received.' });
    const batchId = 'BS-' + Date.now();
    const importDate = new Date().toISOString().split('T')[0];
    const text = req.file.buffer.toString('utf8');
    const rawLines = text.split('\n').map(l => l.trim()).filter(l => l);
    // Skip header row if first cell looks like 'date' or 'Date'
    const lines = rawLines.filter(l => !/^["']?date["']?[,;]/i.test(l));

    let imported = 0;
    try {
        await withDbTransaction(async () => {
            await dbRun('BEGIN IMMEDIATE');
            try {
                for (const line of lines) {
                    const parts = (line.match(/(".*?"|[^,;]+)(?:[,;]|$)/g) || []).map(p => p.replace(/^[",;]+|[",;]+$/g, '').trim());
                    if (parts.length < 3) continue;
                    const [stmtDate, description, rawAmount, reference] = parts;
                    const amount = parseFloat((rawAmount || '').replace(/[^0-9.\-]/g, ''));
                    if (isNaN(amount) || !stmtDate) continue;
                    await dbRun(
                        `INSERT INTO bank_statement_lines (import_batch, import_date, statement_date, description, amount, reference)
                         VALUES (?, ?, ?, ?, ?, ?)`,
                        [batchId, importDate, stmtDate, description || '', amount, reference || null]
                    );
                    imported++;
                }
                await dbRun('COMMIT');
            } catch (e) {
                await dbRun('ROLLBACK').catch(() => {});
                throw e;
            }
        });
    } catch (e) {
        return res.status(500).json({ success: false, message: e.message });
    }
    res.json({ success: true, batch_id: batchId, imported });
});

// GET /api/admin/bank-statement/lines — list imported lines with optional batch filter
router.get('/api/admin/bank-statement/lines', requireAdmin, requireRole(['administrator', 'manager']), (req, res) => {
    const { batch_id, unmatched_only } = req.query;
    let sql = `SELECT bsl.*, b.name AS matched_client
               FROM bank_statement_lines bsl
               LEFT JOIN bookings b ON bsl.matched_booking_id = b.id
               WHERE 1=1`;
    const params = [];
    if (batch_id)       { sql += ' AND bsl.import_batch = ?'; params.push(batch_id); }
    if (unmatched_only === '1') { sql += ' AND bsl.matched_transaction_id IS NULL AND bsl.matched_booking_id IS NULL'; }
    sql += ' ORDER BY bsl.statement_date DESC';
    db.all(sql, params, (err, rows) => {
        if (err) return res.status(500).json({ success: false, message: err.message });
        getBankStatementImportBatches(
            (e2, batches) => {
                res.json({ success: true, lines: rows || [], batches: batches || [] });
            }
        );
    });
});

// PATCH /api/admin/bank-statement/lines/:id/match — link a line to a booking
router.patch('/api/admin/bank-statement/lines/:id/match', requireAdmin, requireRole(['administrator', 'manager']), (req, res) => {
    const { booking_id, transaction_id, match_note } = req.body;
    matchBankStatementLine(
        booking_id || null, transaction_id || null, (match_note || '').trim() || null, req.params.id,
        function(err) {
            if (err || this.changes === 0) return res.status(err ? 500 : 404).json({ success: false, message: err?.message || 'Line not found.' });
            res.json({ success: true });
        }
    );
});

// DELETE /api/admin/bank-statement/lines/:id — remove a single imported line
router.delete('/api/admin/bank-statement/lines/:id', requireAdmin, requireRole(['administrator', 'manager']), (req, res) => {
    deleteBankStatementLine(req.params.id, function(err) {
        if (err || this.changes === 0) return res.status(err ? 500 : 404).json({ success: false });
        res.json({ success: true });
    });
});

// DELETE /api/admin/bank-statement/batch/:batchId — delete an entire import batch
router.delete('/api/admin/bank-statement/batch/:batchId', requireAdmin, requireRole(['administrator', 'manager']), (req, res) => {
    deleteBankStatementBatch(req.params.batchId, function(err) {
        if (err) return res.status(500).json({ success: false, message: err.message });
        res.json({ success: true, deleted: this.changes });
    });
});

module.exports = router;
