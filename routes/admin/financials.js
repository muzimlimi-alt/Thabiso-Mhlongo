const express = require('express');
const db = require('../../database');
const { requireAdmin } = require('../../middleware/auth');
const { requireRole } = require('../../middleware/rbac');
const { getTransactionRevenueTrend, getExpenseTrend, getPeriodRevenue, getPeriodExpenses, getTotalTransactionCount } = require('../../database/repositories/finance.repository');
const { getInvoiceAgingSummary, getOverdueInvoicesSummary, getDueSoonInvoicesSummary } = require('../../database/repositories/invoices-quotations.repository');
const { getOutstandingTotal, getBookingStatusCounts } = require('../../database/repositories/bookings.repository');
const router = express.Router();

// 3.7 Financial Analytics API (Admin)
// GET /api/admin/financials/analytics
router.get('/api/admin/financials/analytics', requireAdmin, requireRole(['administrator', 'manager']), (req, res) => {
    const clientQuery = `
        SELECT c.id AS client_id, COALESCE(c.full_name, b.name) AS client_name, c.company_name,
               SUM(t.amount) AS total_spent, COUNT(DISTINCT b.id) AS booking_count
        FROM transactions t
        JOIN bookings b ON t.booking_id = b.id
        LEFT JOIN clients c ON b.client_id = c.id
        WHERE t.status = 'completed' AND COALESCE(t.is_duplicate, 0) = 0
        GROUP BY client_id, client_name
        ORDER BY total_spent DESC
        LIMIT 5
    `;
    
    const overdueListQuery = `
        SELECT i.*, b.name AS client_name, b.event_name,
               CAST(julianday('now') - julianday(i.due_date) AS INTEGER) AS days_overdue
        FROM invoices i
        JOIN bookings b ON i.booking_id = b.id
        WHERE i.status IN ('SENT', 'OVERDUE')
          AND i.due_date < DATE('now')
        ORDER BY days_overdue DESC
    `;

    // Revenue grouped by booking event/service type — reveals which kinds of
    // engagements (live shows, corporate, comedy, virtual …) earn the most.
    const categoryQuery = `
        SELECT COALESCE(NULLIF(b.event_type, ''), 'Other') AS category,
               SUM(t.amount)          AS revenue,
               COUNT(DISTINCT b.id)   AS bookings
        FROM transactions t
        JOIN bookings b ON t.booking_id = b.id
        WHERE t.status = 'completed' AND COALESCE(t.is_duplicate, 0) = 0
        GROUP BY category
        ORDER BY revenue DESC
        LIMIT 8
    `;

    // Monthly expenses over the same 12-month window used by the revenue trend,
    // so the two can be combined into a cash-flow (money in vs money out) view.

    getTransactionRevenueTrend((err, trend) => {
        if (err) return res.status(500).json({ success: false, message: err.message });

        db.all(clientQuery, [], (e2, clients) => {
            if (e2) return res.status(500).json({ success: false, message: e2.message });

            getInvoiceAgingSummary((e3, aging) => {
                if (e3) return res.status(500).json({ success: false, message: e3.message });

                db.all(overdueListQuery, [], (e4, overdueInvoices) => {
                    if (e4) return res.status(500).json({ success: false, message: e4.message });

                    db.all(categoryQuery, [], (e5, categories) => {
                        if (e5) return res.status(500).json({ success: false, message: e5.message });

                        getExpenseTrend((e6, expenseTrend) => {
                            if (e6) return res.status(500).json({ success: false, message: e6.message });

                            // Merge revenue trend + expense trend into a unified
                            // cash-flow series keyed by month.
                            const cf = {};
                            (trend || []).forEach(r => {
                                cf[r.month] = { month: r.month, revenue: parseFloat(r.total_revenue || 0), expenses: 0 };
                            });
                            (expenseTrend || []).forEach(x => {
                                if (!cf[x.month]) cf[x.month] = { month: x.month, revenue: 0, expenses: 0 };
                                cf[x.month].expenses = parseFloat(x.total_expenses || 0);
                            });
                            const cashFlow = Object.values(cf)
                                .map(r => ({ ...r, net: r.revenue - r.expenses }))
                                .sort((a, b) => (a.month < b.month ? -1 : 1));

                            res.json({
                                success: true,
                                revenueTrend: trend || [],
                                topClients: clients || [],
                                debtAging: aging || {},
                                overdueInvoices: overdueInvoices || [],
                                revenueByCategory: categories || [],
                                cashFlow: cashFlow
                            });
                        });
                    });
                });
            });
        });
    });
});

router.get('/api/admin/financials/stats', requireAdmin, requireRole(['administrator', 'manager']), (req, res) => {
    // Support optional date range for period-scoped stats
    const { date_from, date_to } = req.query;

    // Period boundaries: default to first of current month → today
    const now = new Date();
    const defaultFrom = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
    const defaultTo   = now.toISOString().split('T')[0];
    const periodFrom  = date_from || defaultFrom;
    const periodTo    = date_to   || defaultTo;

    // 1. Period-scoped revenue (completed transactions in range)

    // 2. All-time outstanding.
    //    Allowlist, not a denylist. Booking intake writes amount_outstanding = the service
    //    catalogue estimate on a NEW booking that has never been quoted, so a bare
    //    "NOT IN ('CANCELLED','EXPIRED')" counted every unsubmitted enquiry as a receivable —
    //    an hourly MC enquiry silently added R2 950. A quote that has been sent but not accepted
    //    (QUOTED) is not a receivable either. Only an accepted commitment is money owed.
    // 3. Booking status counts
    // Soft-declined leads (disposition 'not_a_fit'/'archived') are excluded from the active
    // pipeline funnel — they were never a live deal, so counting them would inflate/distort
    // conversion math the same way a raw status overload would have (see BOOKING_DISPOSITIONS).

    getPeriodRevenue(periodFrom, periodTo, (err, revRow) => {
        if (err) return res.status(500).json({ error: err.message });
        const periodRevenue = parseFloat(revRow ? revRow.period_revenue : 0);

        getOutstandingTotal((e2, outRow) => {
            if (e2) return res.status(500).json({ error: e2.message });
            const totalOutstanding = parseFloat(outRow ? outRow.total_outstanding : 0);

            getBookingStatusCounts((e3, counts) => {
                // Period-scoped expenses
                getPeriodExpenses(
                    periodFrom, periodTo,
                    (e4, expRow) => {
                        const periodExpenses = parseFloat(expRow ? expRow.period_expenses : 0);

                        // Pending quotes value — real data from quotations table (SENT/unsent, not yet accepted)
                        db.get(
                            `SELECT COALESCE(SUM(q.total), 0) AS pending_quotes_value,
                                    COUNT(*) AS pending_quotes_count
                             FROM quotations q
                             JOIN bookings b ON q.booking_id = b.id
                             WHERE q.archived = 0
                               AND b.status = 'QUOTED'`,
                            [],
                            (e5, qRow) => {
                                // Overdue invoices (SENT status with a due_date in the past)
                                getOverdueInvoicesSummary(
                                    (e6, overdueRow) => {
                                        // Invoices due within next 7 days (SENT, not yet past due)
                                        getDueSoonInvoicesSummary(
                                            (e7, dueSoonRow) => {
                                                // Invoices generated but never sent for CONFIRMED bookings
                                                db.get(
                                                    `SELECT COUNT(*) AS cnt
                                                     FROM invoices i
                                                     JOIN bookings b ON b.id = i.booking_id
                                                     WHERE i.sent_at IS NULL
                                                       AND i.status NOT IN ('void', 'VOID')
                                                       AND b.status = 'CONFIRMED'`,
                                                    [],
                                                    (e8, unsentRow) => {
                                                        // Recent transactions with client name (200 rows so client-side filter has full history)
                                                        db.all(
                                                            `SELECT t.*, b.name AS client_name
                                                             FROM transactions t
                                                             LEFT JOIN bookings b ON t.booking_id = b.id
                                                             ORDER BY t.created_at DESC LIMIT 200`,
                                                            [],
                                                            (e9, transactions) => {
                                                                getTotalTransactionCount((e10, countRow) => {
                                                                    res.json({
                                                                        success: true,
                                                                        period: { from: periodFrom, to: periodTo },
                                                                        stats: {
                                                                            revenue: periodRevenue,
                                                                            outstanding: totalOutstanding,
                                                                            monthly_expenses: periodExpenses,
                                                                            net_profit_month: periodRevenue - periodExpenses,
                                                                            pending_quotes_value: parseFloat(qRow ? qRow.pending_quotes_value : 0),
                                                                            pending_quotes_count: parseInt(qRow ? qRow.pending_quotes_count : 0),
                                                                            overdue_invoices_count: parseInt(overdueRow ? overdueRow.overdue_count : 0),
                                                                            overdue_invoices_value: parseFloat(overdueRow ? overdueRow.overdue_value : 0),
                                                                            due_soon_invoices_count: parseInt(dueSoonRow ? dueSoonRow.cnt : 0),
                                                                            due_soon_invoices_value: parseFloat(dueSoonRow ? dueSoonRow.val : 0),
                                                                            unsent_invoices_count: parseInt(unsentRow ? unsentRow.cnt : 0),
                                                                            total_transaction_count: countRow ? countRow.total : 0,
                                                                            counts: {
                                                                                pending:   counts ? counts.pending_count   : 0,
                                                                                quoted:    counts ? counts.quoted_count    : 0,
                                                                                confirmed: counts ? counts.confirmed_count : 0
                                                                            }
                                                                        },
                                                                        recentTransactions: transactions || []
                                                                    });
                                                                });
                                                            }
                                                        );
                                                    }
                                                );
                                            }
                                        );
                                    }
                                );
                            }
                        );
                    }
                );
            });
        });
    });
});

module.exports = router;
