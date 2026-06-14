const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('database.sqlite');
const newHash = '$2b$10$iV/RODNXEI5N0PMoNeeKGOQ32I6U7bfCdUGEQ1c3grLb/2KFYviRC';
db.run("UPDATE admins SET password_hash = ? WHERE username = 'admin'", [newHash], (err) => {
    if (err) {
        console.error("Error updating:", err);
    } else {
        console.log("Successfully updated admin password hash!");
    }
    db.close();
});
