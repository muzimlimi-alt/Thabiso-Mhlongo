const db = require('../database');

console.log('--- Phase 3: Email Logs Migration ---');

const sql = `
CREATE TABLE IF NOT EXISTS email_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    recipient TEXT NOT NULL,
    subject TEXT NOT NULL,
    status TEXT NOT NULL,
    error_message TEXT,
    sent_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`;

db.run(sql, (err) => {
    if (err) {
        console.error('❌ Error creating email_logs table:', err.message);
        process.exit(1);
    } else {
        console.log('✅ Table "email_logs" is ready.');
        // Brief delay to allow DB writing before closing
        setTimeout(() => {
            db.close(() => {
                console.log('Database connection closed.');
                process.exit(0);
            });
        }, 500);
    }
});
