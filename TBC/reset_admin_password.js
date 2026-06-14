const db = require('../database');
const bcrypt = require('bcrypt');

bcrypt.hash('password123', 10, (err, hash) => {
    if (err) throw err;
    db.run("UPDATE admins SET password_hash = ? WHERE username = 'admin'", [hash], function(err) {
        if (err) {
            console.error("Error resetting password:", err);
        } else {
            console.log(`Password reset successfully for 'admin'. Changes: ${this.changes}`);
        }
        db.close();
    });
});
