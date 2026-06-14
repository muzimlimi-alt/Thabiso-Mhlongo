const sqlite = require('sqlite3').verbose();
const path = require('path');

const db = new sqlite.Database(path.join(__dirname, '../database.sqlite'));

db.run("DELETE FROM settings WHERE setting_key = 'payfast_passphrase'", function(err) {
    if (err) {
        console.error(err);
        return;
    }
    console.log(`Deleted ${this.changes} row(s) from settings.`);
    db.close();
});
