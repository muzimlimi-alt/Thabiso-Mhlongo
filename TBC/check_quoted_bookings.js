const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, '../database.sqlite');
const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (err) => {
    if (err) {
        console.error('Error opening database:', err);
        process.exit(1);
    }
});

db.all('SELECT id, status, quote_amount, total_amount, amount_outstanding, amount_paid FROM bookings WHERE status = "QUOTED"', [], (err, rows) => {
    if (err) {
        console.error('Error querying bookings:', err);
    } else {
        console.log('Quoted bookings in database:');
        console.log(JSON.stringify(rows, null, 2));
    }
    db.close();
});
