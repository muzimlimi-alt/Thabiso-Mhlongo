const fs = require('fs');
const path = require('path');

const serverPath = path.join(__dirname, '../server.js');
const content = fs.readFileSync(serverPath, 'utf8');
const lines = content.split('\n');

console.log('Matches for quote_amount in server.js:');
lines.forEach((line, index) => {
    if (line.toLowerCase().includes('quote_amount')) {
        console.log(`${index + 1}: ${line.trim()}`);
    }
});
