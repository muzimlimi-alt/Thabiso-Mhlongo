const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('../database.sqlite');
db.run('BEGIN TRANSACTION', (err) => {
    if (err) {
        console.error("Begin err:", err);
    } else {
        db.run('UPDATE bookings SET status="QUOTED" WHERE id=45', (e) => {
            if(e) console.error("Update err:", e);
            else console.log('DB write successful');
            db.run('ROLLBACK');
        });
    }
});
