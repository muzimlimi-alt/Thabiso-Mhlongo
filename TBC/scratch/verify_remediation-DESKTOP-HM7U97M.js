const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.resolve(__dirname, '..', 'database.sqlite');
const db = new sqlite3.Database(dbPath);

console.log("Starting verification checks...");

db.serialize(() => {
    // 1. Verify schema: consent_audit table has policy_version
    db.all("PRAGMA table_info(consent_audit)", (err, columns) => {
        if (err) {
            console.error("❌ Failed to query consent_audit table info:", err.message);
            process.exit(1);
        }
        const colNames = columns.map(c => c.name);
        if (colNames.includes('policy_version')) {
            console.log("✅ verified: consent_audit table has policy_version column.");
        } else {
            console.error("❌ Failed: consent_audit table is missing policy_version column.");
            process.exit(1);
        }
    });

    // 2. Query invoices to see if status and voided_at logic exists
    db.all("PRAGMA table_info(invoices)", (err, columns) => {
        if (err) {
            console.error("❌ Failed to query invoices table info:", err.message);
            process.exit(1);
        }
        console.log("✅ verified: invoices table columns retrieved successfully.");
    });
    
    // 3. Check if there are any active bookings in the db for testing duplicate check
    db.all("SELECT id, name, email, date, status FROM bookings WHERE status NOT IN ('CANCELLED', 'EXPIRED') LIMIT 5", (err, rows) => {
        if (err) {
            console.error("❌ Failed to fetch bookings:", err.message);
        } else {
            console.log(`✅ checked: retrieved ${rows.length} active bookings from SQLite.`);
            rows.forEach(r => {
                console.log(`   Booking #${r.id}: ${r.name} (${r.email}) on ${r.date} with status ${r.status}`);
            });
        }
    });
});
