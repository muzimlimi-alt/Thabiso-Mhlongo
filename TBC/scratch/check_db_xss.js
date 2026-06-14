const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('database.sqlite');

db.get("SELECT message_body FROM inquiries WHERE sender_name = 'XSS Tester' ORDER BY inquiry_id DESC LIMIT 1", [], (err, row) => {
    if (err) {
        console.error(err);
    } else if (row) {
        console.log('Sanitized Message Body:', row.message_body);
    } else {
        console.log('No record found for XSS Tester.');
    }
    db.close();
});
