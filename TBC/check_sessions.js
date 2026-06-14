const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, '../sessions.sqlite');
const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (err) => {
    if (err) {
        console.error('Error opening sessions database:', err);
        process.exit(1);
    }
});

db.all('SELECT * FROM sessions', [], (err, rows) => {
    if (err) {
        console.error('Error querying sessions:', err);
    } else {
        console.log(`Active Sessions count: ${rows.length}`);
        rows.forEach(r => {
            console.log(`SID: ${r.sid}`);
            console.log(`Session: ${r.sess}`);
        });
    }
    db.close();
});
