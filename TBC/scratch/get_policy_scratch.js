const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('database.sqlite');
db.all("SELECT policy_key, policy_value FROM policies", [], (err, rows) => {
    if (err) console.error(err);
    else console.log('Policies:', rows);
    db.close();
});
