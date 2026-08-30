const express = require('express');
const db = require('../../database');
const { requireAdmin } = require('../../middleware/auth');
const { requireRole } = require('../../middleware/rbac');
const { exportRateLimiter } = require('../../middleware/rate-limiters');
const { getTransactionRevenueByPeriod, getExpensesByPeriod } = require('../../database/repositories/finance.repository');
const router = express.Router();

// --- Financial CSV Export ---
router.get('/api/admin/finance/export', exportRateLimiter, requireAdmin, requireRole(['administrator', 'manager']), (req, res) => {
    const query = `
        SELECT 
            b.id AS booking_id, 
            b.name AS client_name, 
            b.email, 
            b.date, 
            b.event_type, 
            b.total_amount, 
            b.amount_paid, 
            b.amount_outstanding, 
            b.payment_status,
            COALESCE(i.invoice_number, 'N/A') AS invoice_no
        FROM bookings b
        LEFT JOIN invoices i ON b.id = i.booking_id
        ORDER BY b.date DESC
    `;

    db.all(query, [], (err, rows) => {
        if (err) return res.status(500).json({ success: false, message: 'Failed to fetch financial data' });

        const headers = ["Booking ID", "Client Name", "Email", "Date", "Event Type", "Total Amount", "Amount Paid", "Outstanding", "Payment Status", "Invoice Number"];
        let csv = headers.join(",") + "\n";

        rows.forEach(row => {
            const rowData = [
                row.booking_id,
                `"${row.client_name}"`,
                row.email,
                row.date,
                `"${row.event_type}"`,
                row.total_amount || 0,
                row.amount_paid || 0,
                row.amount_outstanding || 0,
                row.payment_status,
                row.invoice_no
            ];
            csv += rowData.join(",") + "\n";
        });

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename=thabiso_finance_export_${new Date().toISOString().split('T')[0]}.csv`);
        res.status(200).send(csv);
    });
});

// 4. Financial Statistics (Admin)

// P3-11: Profit & Loss endpoint — aggregates revenue (transactions) vs costs (expenses) by period.
router.get('/api/admin/finance/pl', requireAdmin, requireRole(['administrator', 'manager']), (req, res) => {
    const { period = 'month', date_from, date_to } = req.query;
    const groupFormat = period === 'year' ? '%Y' : (period === 'week' ? '%Y-W%W' : '%Y-%m');
    const fromFilter = date_from ? `AND date >= ${db.prepare ? '?' : JSON.stringify(date_from)}` : '';
    const toFilter   = date_to   ? `AND date <= ${db.prepare ? '?' : JSON.stringify(date_to)}`   : '';
    const revenueParams = []; const expenseParams = [];
    let revWhere = 'WHERE t.status = \'completed\' AND (t.transaction_type IS NULL OR t.transaction_type NOT IN (\'refund\',\'chargeback\'))';
    let expWhere = 'WHERE 1=1';
    if (date_from) { revWhere += ' AND t.transaction_date >= ?'; revenueParams.push(date_from); expWhere += ' AND e.expense_date >= ?'; expenseParams.push(date_from); }
    if (date_to)   { revWhere += ' AND t.transaction_date <= ?'; revenueParams.push(date_to);   expWhere += ' AND e.expense_date <= ?'; expenseParams.push(date_to);   }

    getTransactionRevenueByPeriod(
        groupFormat, revWhere, revenueParams,
        (rErr, revenueRows) => {
            if (rErr) return res.status(500).json({ success: false, error: rErr.message });
            getExpensesByPeriod(
                groupFormat, expWhere, expenseParams,
                (eErr, expenseRows) => {
                    if (eErr) return res.status(500).json({ success: false, error: eErr.message });

                    // Merge into unified P&L by period
                    const pl = {};
                    (revenueRows || []).forEach(r => { pl[r.period] = { period: r.period, revenue: parseFloat(r.revenue), expenses: 0, profit: 0 }; });
                    (expenseRows || []).forEach(e => {
                        if (!pl[e.period]) pl[e.period] = { period: e.period, revenue: 0, expenses: 0, profit: 0 };
                        pl[e.period].expenses = parseFloat(e.expenses);
                    });
                    const rows = Object.values(pl).map(r => ({ ...r, profit: r.revenue - r.expenses }));
                    rows.sort((a, b) => a.period < b.period ? -1 : 1);

                    const totals = rows.reduce((acc, r) => ({
                        revenue: acc.revenue + r.revenue,
                        expenses: acc.expenses + r.expenses,
                        profit: acc.profit + r.profit
                    }), { revenue: 0, expenses: 0, profit: 0 });

                    res.json({ success: true, period_type: period, rows, totals });
                }
            );
        }
    );
});

module.exports = router;
