const sqlite = require('sqlite3').verbose();
const path = require('path');

const db = new sqlite.Database(path.join(__dirname, '../database.sqlite'));

db.get("SELECT * FROM bookings WHERE id = 47", (err, booking) => {
    if (err) {
        console.error("Booking Error:", err);
        return;
    }
    console.log("Booking #47:", booking);
    
    if (booking) {
        db.all("SELECT * FROM quotations WHERE booking_id = 47", (err, quotes) => {
            if (err) {
                console.error("Quotation Error:", err);
            } else {
                console.log("Quotations for #47:", quotes);
            }
            
            db.all("SELECT * FROM audit_log WHERE (table_name = 'bookings' AND record_id = 47) OR changes_json LIKE '%\"id\":47%'", (err, logs) => {
                if (err) {
                    console.error("Audit Log Error:", err);
                } else {
                    console.log("Audit Logs for #47:", logs);
                }
                db.close();
            });
        });
    } else {
        console.log("Booking #47 not found.");
        db.close();
    }
});
