const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, '..', 'database.sqlite');
console.log('Connecting to database at:', dbPath);

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Error opening database:', err);
        return;
    }
    db.all("SELECT * FROM social_links", [], (err, rows) => {
        if (err) {
            console.error('Error running query:', err);
        } else {
            console.log('Social Links:');
            console.log(JSON.stringify(rows, null, 2));
        }
        db.close();
    });
});
