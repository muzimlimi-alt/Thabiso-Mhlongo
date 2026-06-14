const sqlite = require('sqlite3').verbose();
const path = require('path');

const db = new sqlite.Database(path.join(__dirname, '../database.sqlite'));

db.all("SELECT * FROM settings WHERE setting_key LIKE 'payfast%'", (err, rows) => {
    if (err) {
        console.error(err);
        return;
    }
    console.log("PayFast Settings in DB:", rows);
    db.close();
});
