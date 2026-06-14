const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const dbPath = path.resolve(__dirname, 'database.sqlite');
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
    db.all("PRAGMA table_info(quotations)", (err, rows) => {
        if (err) {
            console.error(err);
            return;
        }
        console.log("Quotations columns:");
        rows.forEach(r => console.log(`- ${r.name} (${r.type})`));
        
        db.run("INSERT INTO quotations (booking_id, quote_number, client_id, status) VALUES (1, 'TEST-123', 1, 'draft')", function(err) {
            if (err) {
                console.error("Insert error:", err.message);
            } else {
                console.log("Insert success, row ID:", this.lastID);
                db.run("DELETE FROM quotations WHERE id = ?", this.lastID);
            }
            db.close();
        });
    });
});
