const fs = require('fs');
const path = require('path');

const dbPath = path.join(__dirname, '../database.js');
if (fs.existsSync(dbPath)) {
    const content = fs.readFileSync(dbPath, 'utf8');
    const lines = content.split('\n');

    console.log('Matches for quote_amount in database.js:');
    lines.forEach((line, index) => {
        if (line.toLowerCase().includes('quote_amount')) {
            console.log(`${index + 1}: ${line.trim()}`);
        }
    });
} else {
    console.log('database.js does not exist.');
}
