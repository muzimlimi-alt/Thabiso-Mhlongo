const path = require('path');
const db = require(path.join(__dirname, '..', 'database'));
const assert = require('assert');

function runTest() {
    const query = `
      SELECT b.id,
        CASE WHEN lq.total_amount IS NOT NULL
             THEN printf('%.2f', lq.total_amount)
             ELSE b.quote_amount
        END AS quote_amount
      FROM bookings b
      LEFT JOIN quotations lq ON lq.id = (SELECT MAX(id) FROM quotations WHERE booking_id = b.id)
      WHERE b.id = 78
    `;
    
    db.get(query, (err, row) => {
        if (err) {
            console.error("Database query failed:", err);
            process.exit(1);
        }
        
        console.log("SQL projection output for Booking 78:", row);
        assert(row, "Booking 78 row should exist.");
        assert.strictEqual(row.quote_amount, "21275.00", "Returned quote_amount must be a raw float string (e.g. 21275.00), not prefixed with R.");
        console.log("✓ Test Passed: quote_amount is returned as raw float string.");
        process.exit(0);
    });
}

runTest();
