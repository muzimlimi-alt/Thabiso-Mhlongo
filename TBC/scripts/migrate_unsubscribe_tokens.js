const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const crypto = require('crypto');

const dbPath = path.join(__dirname, '..', 'database.sqlite');
const db = new sqlite3.Database(dbPath);

console.log('--- Phase 5: Unsubscribe Token Migration ---');

db.serialize(() => {
    // 1. Add column if it doesn't exist
    db.run("ALTER TABLE newsletter_subscribers ADD COLUMN unsubscribe_token TEXT", (err) => {
        if (err) {
            if (err.message.includes('duplicate column name')) {
                console.log('Column "unsubscribe_token" already exists.');
            } else {
                console.error('Error adding column:', err.message);
            }
        } else {
            console.log('Column "unsubscribe_token" added successfully.');
        }
    });

    // 2. Generate tokens for existing subscribers who don't have one
    db.all("SELECT subscriber_id, email FROM newsletter_subscribers WHERE unsubscribe_token IS NULL", [], (err, rows) => {
        if (err) {
            console.error('Error fetching subscribers:', err.message);
            return;
        }

        if (rows.length === 0) {
            console.log('No existing subscribers need tokens.');
            return;
        }

        console.log(`Generating tokens for ${rows.length} subscribers...`);
        
        const stmt = db.prepare("UPDATE newsletter_subscribers SET unsubscribe_token = ? WHERE subscriber_id = ?");
        
        rows.forEach(row => {
            const token = crypto.randomBytes(16).toString('hex');
            stmt.run(token, row.subscriber_id);
        });

        stmt.finalize(() => {
            console.log('Token generation complete.');
        });
    });
});
