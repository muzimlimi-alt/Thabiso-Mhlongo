const fs = require('fs');
const path = require('path');

const dbPath = path.join(__dirname, '../database.js');
const content = fs.readFileSync(dbPath, 'utf8');
const lines = content.split('\n');

console.log('Matches for database connection in database.js:');
lines.forEach((line, index) => {
    if (line.includes('new sqlite3') || line.includes('Database(')) {
        console.log(`${index + 1}: ${line.trim()}`);
    }
});
