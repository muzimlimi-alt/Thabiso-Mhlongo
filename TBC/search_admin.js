const fs = require('fs');
const path = require('path');

const adminPath = path.join(__dirname, '..', 'admin.html');
const content = fs.readFileSync(adminPath, 'utf8');

const lines = content.split('\n');
console.log(`Total lines: ${lines.length}`);

// Search for allBookingsCache occurrences
const query = 'allBookingsCache';
let found = 0;
lines.forEach((line, idx) => {
    if (line.toLowerCase().includes(query.toLowerCase())) {
        found++;
        if (found <= 50) {
            console.log(`Line ${idx + 1}: ${line.trim().slice(0, 120)}`);
        }
    }
});
console.log(`Found ${found} occurrences of "${query}"`);
