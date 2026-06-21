const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./database.sqlite');
db.get('SELECT id, status FROM bookings ORDER BY id DESC LIMIT 1', (err, row) => {
    console.log("Latest booking:", row);
});
