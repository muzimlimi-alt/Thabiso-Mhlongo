const db = require('../database');

db.all('SELECT * FROM email_logs ORDER BY sent_at DESC LIMIT 5', (err, rows) => {
    if (err) {
        console.error(err);
    } else {
        console.log(JSON.stringify(rows, null, 2));
    }
    process.exit(0);
});
