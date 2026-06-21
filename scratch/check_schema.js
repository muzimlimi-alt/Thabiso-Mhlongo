const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('database.sqlite');
db.all("SELECT type, name, tbl_name, sql FROM sqlite_master", [], (err, rows) => {
    if (err) {
        console.error(err);
    } else {
        for (const row of rows) {
            if (row.sql && (row.sql.includes('CHECK') || row.type === 'trigger' || row.sql.includes('CONSTRAINT'))) {
                console.log(`--- ${row.type}: ${row.name} on ${row.tbl_name} ---`);
                console.log(row.sql);
            }
        }
    }
    db.close();
});
