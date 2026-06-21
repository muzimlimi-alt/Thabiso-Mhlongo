const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const path = require('path');

const dbPath = path.join(__dirname, '..', 'database.sqlite');
const db = new sqlite3.Database(dbPath);

async function setPassword() {
    try {
        const newHash = await bcrypt.hash('password123', 10);
        db.run("UPDATE admins SET password_hash = ? WHERE username = 'admin'", [newHash], (err) => {
            if (err) {
                console.error("❌ Error updating password hash in database:", err);
            } else {
                console.log("✓ Successfully updated admin password hash to match 'password123'!");
            }
            db.close();
        });
    } catch (e) {
        console.error("❌ Error generating hash:", e.message);
        db.close();
    }
}

setPassword();
