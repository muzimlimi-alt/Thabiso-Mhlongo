const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('database.sqlite');

db.all('SELECT * FROM services', (err, rows) => {
    if (err) {
        console.error(err);
    } else {
        console.log(JSON.stringify(rows));
    }
    db.close();
});
