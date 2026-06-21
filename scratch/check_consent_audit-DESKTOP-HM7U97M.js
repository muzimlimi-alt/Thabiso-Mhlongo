const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const dbPath = path.resolve(__dirname, '..', 'database.sqlite');

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) console.error(err);
    db.serialize(() => {
        db.all("PRAGMA table_info(consent_audit)", [], (err, columns) => {
            console.log("consent_audit columns:", columns);
            db.all("SELECT * FROM consent_audit ORDER BY id DESC LIMIT 5", [], (err2, rows) => {
                console.log("consent_audit rows:", rows);
                db.close();
            });
        });
    });
});
