const db = require('../database');

const trendQuery = `
    SELECT strftime('%Y-%m', transaction_date) AS month, SUM(amount) AS total_revenue
    FROM transactions
    WHERE status = 'completed' AND COALESCE(is_duplicate, 0) = 0
      AND transaction_date >= DATE('now', '-12 months')
    GROUP BY month
    ORDER BY month ASC
`;

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

const agingQuery = `
    SELECT 
        COUNT(CASE WHEN (julianday('now') - julianday(due_date)) <= 0 THEN 1 END) AS current_count,
        COALESCE(SUM(CASE WHEN (julianday('now') - julianday(due_date)) <= 0 THEN total_amount ELSE 0 END), 0) AS current_value,
        
        COUNT(CASE WHEN (julianday('now') - julianday(due_date)) > 0 AND (julianday('now') - julianday(due_date)) <= 30 THEN 1 END) AS age_30_count,
        COALESCE(SUM(CASE WHEN (julianday('now') - julianday(due_date)) > 0 AND (julianday('now') - julianday(due_date)) <= 30 THEN total_amount ELSE 0 END), 0) AS age_30_value,
        
        COUNT(CASE WHEN (julianday('now') - julianday(due_date)) > 30 AND (julianday('now') - julianday(due_date)) <= 60 THEN 1 END) AS age_60_count,
        COALESCE(SUM(CASE WHEN (julianday('now') - julianday(due_date)) > 30 AND (julianday('now') - julianday(due_date)) <= 60 THEN total_amount ELSE 0 END), 0) AS age_60_value,
        
        COUNT(CASE WHEN (julianday('now') - julianday(due_date)) > 60 AND (julianday('now') - julianday(due_date)) <= 90 THEN 1 END) AS age_90_count,
        COALESCE(SUM(CASE WHEN (julianday('now') - julianday(due_date)) > 60 AND (julianday('now') - julianday(due_date)) <= 90 THEN total_amount ELSE 0 END), 0) AS age_90_value,
        
        COUNT(CASE WHEN (julianday('now') - julianday(due_date)) > 90 THEN 1 END) AS age_over_90_count,
        COALESCE(SUM(CASE WHEN (julianday('now') - julianday(due_date)) > 90 THEN total_amount ELSE 0 END), 0) AS age_over_90_value
    FROM invoices
    WHERE status IN ('SENT', 'OVERDUE')
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

console.log("Running trendQuery...");
db.all(trendQuery, [], (err, res) => {
    if (err) console.error("trendQuery Error:", err);
    else console.log("trendQuery Success:", res);

    console.log("Running clientQuery...");
    db.all(clientQuery, [], (err2, res2) => {
        if (err2) console.error("clientQuery Error:", err2);
        else console.log("clientQuery Success:", res2);

        console.log("Running agingQuery...");
        db.get(agingQuery, [], (err3, res3) => {
            if (err3) console.error("agingQuery Error:", err3);
            else console.log("agingQuery Success:", res3);

            console.log("Running overdueListQuery...");
            db.all(overdueListQuery, [], (err4, res4) => {
                if (err4) console.error("overdueListQuery Error:", err4);
                else console.log("overdueListQuery Success:", res4);
                db.close();
            });
        });
    });
});
