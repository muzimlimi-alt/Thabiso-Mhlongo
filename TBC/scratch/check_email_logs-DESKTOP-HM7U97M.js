const sqlite = require('sqlite3').verbose();
const path = require('path');

const db = new sqlite.Database(path.join(__dirname, '../database.sqlite'));

db.all("SELECT * FROM email_logs WHERE recipient_email = 'Simphiwemagaxeni26@gmail.com' OR subject LIKE '%47%'", (err, rows) => {
    if (err) {
        console.error("Email Logs Error:", err);
    } else {
        console.log("Email Logs for #47:", rows);
    }
    db.close();
});
