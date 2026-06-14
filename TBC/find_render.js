const fs = require('fs');
const path = require('path');

const adminPath = path.join(__dirname, '../admin.html');
const content = fs.readFileSync(adminPath, 'utf8');
const lines = content.split('\n');

console.log('Matches for renderBookingsTable in admin.html:');
lines.forEach((line, index) => {
    if (line.toLowerCase().includes('renderbookingstable')) {
        console.log(`${index + 1}: ${line.trim()}`);
    }
});
