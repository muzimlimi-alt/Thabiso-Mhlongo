const express = require('express');
const db = require('../../database');
const { requireAdmin } = require('../../middleware/auth');
const { requireRole } = require('../../middleware/rbac');
const { getCompletedTransactionsForReconciliation, setTransactionDuplicateFlag } = require('../../database/repositories/finance.repository');
const router = express.Router();

// ========================================
// RECONCILIATION ENDPOINTS (Admin)
// ========================================
// PATCH /api/admin/transactions/:id/reconcile folded in here too — it's the "flag/unflag as
// duplicate" action for this same reconciliation matrix, not a separate transactions-domain
// concern (POST /api/admin/transactions/manual is the real transactions domain, not yet moved).

// GET /api/admin/reconciliation — full reconciliation matrix per booking
router.get('/api/admin/reconciliation', requireAdmin, requireRole(['administrator', 'manager']), (req, res) => {
    const query = `
        SELECT
            b.id AS booking_id,
            b.name AS client_name,
            b.event_name,
            b.date AS event_date,
            b.status,
            b.payment_status,
            COALESCE(b.total_amount, 0) AS quoted_amount,
            COALESCE(b.amount_paid, 0)  AS amount_paid,
            COALESCE(b.amount_outstanding, 0) AS outstanding,

            -- PayFast transactions (non-duplicate)
            COALESCE(SUM(CASE WHEN t.source = 'payfast' AND COALESCE(t.is_duplicate, 0) = 0 THEN (CASE WHEN t.transaction_type = 'refund' THEN -t.amount WHEN t.transaction_type = 'adjustment' THEN 0 ELSE t.amount END) ELSE 0 END), 0) AS payfast_total,
            -- Manual transactions (non-duplicate)
            COALESCE(SUM(CASE WHEN t.source = 'manual' AND COALESCE(t.is_duplicate, 0) = 0 THEN (CASE WHEN t.transaction_type = 'refund' THEN -t.amount WHEN t.transaction_type = 'adjustment' THEN 0 ELSE t.amount END) ELSE 0 END), 0) AS manual_total,
            -- All flagged duplicates
            COALESCE(SUM(CASE WHEN COALESCE(t.is_duplicate, 0) = 1 THEN (CASE WHEN t.transaction_type = 'refund' THEN -t.amount WHEN t.transaction_type = 'adjustment' THEN 0 ELSE t.amount END) ELSE 0 END), 0) AS duplicate_total,

            -- Effective received = payfast + manual (excluding duplicates)
            COALESCE(SUM(CASE WHEN COALESCE(t.is_duplicate, 0) = 0 THEN (CASE WHEN t.transaction_type = 'refund' THEN -t.amount WHEN t.transaction_type = 'adjustment' THEN 0 ELSE t.amount END) ELSE 0 END), 0) AS effective_received,

            -- Warning flags
            -- 'duplicate': both payfast and manual entries exist for same booking
            CASE
                WHEN SUM(CASE WHEN t.source = 'payfast' THEN 1 ELSE 0 END) > 0
                 AND SUM(CASE WHEN t.source = 'manual'  THEN 1 ELSE 0 END) > 0
                THEN 1 ELSE 0
            END AS has_both_sources,

            -- 'overpayment': effective received > quoted amount (and quoted > 0)
            CASE
                WHEN COALESCE(b.total_amount, 0) > 0
                 AND COALESCE(SUM(CASE WHEN COALESCE(t.is_duplicate, 0) = 0 THEN (CASE WHEN t.transaction_type = 'refund' THEN -t.amount WHEN t.transaction_type = 'adjustment' THEN 0 ELSE t.amount END) ELSE 0 END), 0) > COALESCE(b.total_amount, 0) + 1.0
                THEN 1 ELSE 0
            END AS is_overpaid

        FROM bookings b
        LEFT JOIN transactions t ON t.booking_id = b.id AND t.status = 'completed'
        WHERE b.status != 'CANCELLED'
        GROUP BY b.id
        ORDER BY b.date DESC
    `;
    db.all(query, [], (err, rows) => {
        if (err) return res.status(500).json({ success: false, message: err.message });

        // Summary footer
        const totalQuoted   = rows.reduce((s, r) => s + parseFloat(r.quoted_amount   || 0), 0);
        const totalReceived = rows.reduce((s, r) => s + parseFloat(r.effective_received || 0), 0);
        const totalDupes    = rows.reduce((s, r) => s + parseFloat(r.duplicate_total  || 0), 0);

        res.json({
            success: true,
            rows,
            summary: { total_quoted: totalQuoted, total_received: totalReceived, total_duplicates_flagged: totalDupes }
        });
    });
});

// GET /api/admin/reconciliation/:bookingId/transactions — full tx list for one booking (expandable row)
router.get('/api/admin/reconciliation/:bookingId/transactions', requireAdmin, requireRole(['administrator', 'manager']), (req, res) => {
    getCompletedTransactionsForReconciliation(
        req.params.bookingId, (err, rows) => {
            if (err) return res.status(500).json({ success: false, message: err.message });
            res.json({ success: true, transactions: rows || [] });
        }
    );
});

// PATCH /api/admin/transactions/:id/reconcile — flag/unflag as duplicate (audit-safe, no delete)
router.patch('/api/admin/transactions/:id/reconcile', requireAdmin, requireRole(['administrator', 'manager']), (req, res) => {
    const { is_duplicate, reconcile_note } = req.body;
    const flag = is_duplicate ? 1 : 0;
    const note = (reconcile_note || '').trim().substring(0, 255);
    const adminUser = req.session.username || 'system';

    setTransactionDuplicateFlag(
        flag, note || null, req.params.id,
        function(err) {
            if (err || this.changes === 0) {
                return res.status(err ? 500 : 404).json({ success: false, message: err ? err.message : 'Transaction not found.' });
            }
            // Audit trail — never delete, just log the flag change
            db.run(
                `INSERT INTO audit_log (table_name, record_id, action, changed_by, changes_json)
                 VALUES ('transactions', ?, ?, ?, ?)`,
                [req.params.id, flag ? 'FLAG_DUPLICATE' : 'UNFLAG_DUPLICATE', adminUser,
                 JSON.stringify({ is_duplicate: flag, reconcile_note: note })],
                () => {}
            );
            res.json({ success: true, message: flag ? 'Flagged as duplicate.' : 'Unflagged.' });
        }
    );
});


// GET /api/admin/reconciliation/export/csv — CSV export for accountant
router.get('/api/admin/reconciliation/export/csv', requireAdmin, requireRole(['administrator', 'manager']), (req, res) => {
    const query = `
        SELECT
            b.id, b.name AS client, b.event_name, b.date AS event_date, b.status, b.payment_status,
            COALESCE(b.total_amount,0) AS quoted,
            COALESCE(SUM(CASE WHEN COALESCE(t.is_duplicate,0)=0 AND t.source='payfast' THEN t.amount ELSE 0 END),0) AS payfast_received,
            COALESCE(SUM(CASE WHEN COALESCE(t.is_duplicate,0)=0 AND t.source='manual'  THEN t.amount ELSE 0 END),0) AS manual_received,
            COALESCE(SUM(CASE WHEN COALESCE(t.is_duplicate,0)=1 THEN t.amount ELSE 0 END),0) AS duplicates_flagged,
            COALESCE(SUM(CASE WHEN COALESCE(t.is_duplicate,0)=0 THEN t.amount ELSE 0 END),0) AS effective_received,
            COALESCE(b.amount_outstanding,0) AS outstanding,
            CASE
                WHEN SUM(CASE WHEN t.source='payfast' THEN 1 ELSE 0 END)>0
                 AND SUM(CASE WHEN t.source='manual'  THEN 1 ELSE 0 END)>0 THEN 'YES' ELSE 'NO'
            END AS dual_source_warning,
            CASE
                WHEN COALESCE(b.total_amount,0)>0
                 AND COALESCE(SUM(CASE WHEN COALESCE(t.is_duplicate,0)=0 THEN t.amount ELSE 0 END),0) > COALESCE(b.total_amount,0)+1.0 THEN 'YES' ELSE 'NO'
            END AS overpayment_warning
        FROM bookings b
        LEFT JOIN transactions t ON t.booking_id=b.id AND t.status='completed'
        WHERE b.status != 'CANCELLED'
        GROUP BY b.id ORDER BY b.date DESC
    `;
    db.all(query, [], (err, rows) => {
        if (err) return res.status(500).json({ success: false, message: err.message });

        const headers = ['BookingID','Client','Event','Date','Status','PaymentStatus','Quoted','PayFast_Received','Manual_Received','Duplicates_Flagged','Effective_Received','Outstanding','DualSourceWarning','OverpaymentWarning'];
        const csvRows = rows.map(r => [
            r.id, `"${(r.client||'').replace(/"/g,'""')}"`, `"${(r.event_name||'').replace(/"/g,'""')}"`,
            r.event_date, r.status, r.payment_status,
            parseFloat(r.quoted).toFixed(2), parseFloat(r.payfast_received).toFixed(2),
            parseFloat(r.manual_received).toFixed(2), parseFloat(r.duplicates_flagged).toFixed(2),
            parseFloat(r.effective_received).toFixed(2), parseFloat(r.outstanding).toFixed(2),
            r.dual_source_warning, r.overpayment_warning
        ].join(','));

        const csv = [headers.join(','), ...csvRows].join('\r\n');
        const date = new Date().toISOString().split('T')[0];
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="reconciliation-${date}.csv"`);
        res.send(csv);
    });
});

module.exports = router;
