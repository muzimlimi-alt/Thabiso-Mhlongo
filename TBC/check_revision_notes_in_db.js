const path = require('path');
const db = require(path.join(__dirname, '..', 'database'));

db.all("SELECT * FROM booking_notes ORDER BY id DESC", [], (err, rows) => {
    if (err) {
        console.error("Error reading booking_notes:", err);
    } else {
        console.log("All Booking Notes:", JSON.stringify(rows, null, 2));
    }
    process.exit(0);
});
