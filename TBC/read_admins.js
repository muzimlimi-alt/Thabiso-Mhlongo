const db = require('../database');

db.all("SELECT id, username, password_hash, must_change_password FROM admins", [], (err, rows) => {
    if (err) {
        console.error("Error reading admins:", err);
    } else {
        console.log("Admins found in database:", rows);
    }
    db.close();
});
