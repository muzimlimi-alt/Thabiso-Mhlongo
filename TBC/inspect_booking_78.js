const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, '../database.sqlite');
const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (err) => {
    if (err) {
        console.error('Error opening database:', err);
        process.exit(1);
    }
});

db.all('SELECT * FROM quotations WHERE booking_id = ?', [78], (err, rows) => {
    if (err) {
        console.error('Error querying database:', err);
    } else {
        console.log('Quotations for Booking 78:');
        console.log(JSON.stringify(rows, null, 2));
    }
    db.close();
});
