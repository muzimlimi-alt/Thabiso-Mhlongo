const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const dbPath = path.resolve(__dirname, '../database.sqlite');
const db = new sqlite3.Database(dbPath);

console.log('--- Admins Table ---');
db.all('SELECT * FROM admins', (err, rows) => {
    if (err) console.error(err);
    else console.log(rows);
    
    console.log('--- Password Reset Tokens ---');
    db.all('SELECT * FROM password_reset_tokens', (err, rows) => {
        if (err) console.error(err);
        else console.log(rows);
        db.close();
    });
});
