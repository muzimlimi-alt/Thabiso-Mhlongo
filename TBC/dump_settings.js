const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, '../database.sqlite');
console.log('Opening database at:', dbPath);

const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (err) => {
    if (err) {
        console.error('Error opening database:', err);
        process.exit(1);
    }
});

db.all('SELECT setting_key, setting_value FROM settings', [], (err, rows) => {
    if (err) {
        console.error('Error querying settings:', err);
    } else {
        console.log('Database Settings found:');
        rows.forEach(row => {
            // Mask sensitive-looking settings (like passwords/secrets)
            const isSensitive = ['pass', 'secret', 'key'].some(kw => row.setting_key.toLowerCase().includes(kw));
            const displayVal = isSensitive ? '********' : row.setting_value;
            console.log(`- ${row.setting_key}: ${displayVal}`);
        });
    }
    db.close();
});
