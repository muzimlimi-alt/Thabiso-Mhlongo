const fs = require('fs');
const path = require('path');

const adminPath = path.join(__dirname, '..', 'admin.html');
const content = fs.readFileSync(adminPath, 'utf8');

const lines = content.split('\n');
console.log(`Total lines: ${lines.length}`);

const query = 'Working Hours';
let count = 0;
lines.forEach((line, idx) => {
    if (line.includes(query)) {
        count++;
        console.log(`Line ${idx + 1}: ${line.trim().slice(0, 150)}`);
    }
});
