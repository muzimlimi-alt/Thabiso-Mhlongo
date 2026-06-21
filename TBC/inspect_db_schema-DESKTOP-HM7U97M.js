const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const dbPath = path.resolve(__dirname, '..', 'database.sqlite');
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
    db.all("SELECT name FROM sqlite_master WHERE type='table'", (err, tables) => {
        if (err) {
            console.error("Error fetching tables:", err);
            db.close();
            return;
        }
        console.log("Database Tables:");
        tables.forEach(t => console.log(`- ${t.name}`));

        // Let's inspect cancellations table specifically
        db.all("PRAGMA table_info(cancellations)", (err, columns) => {
            if (err) {
                console.error("Error inspecting cancellations:", err);
            } else {
                console.log("\nCancellations table schema:");
                columns.forEach(c => console.log(`  - ${c.name} (${c.type})`));
            }
            db.close();
        });
    });
});
