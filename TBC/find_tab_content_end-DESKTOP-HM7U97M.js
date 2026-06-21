const fs = require('fs');
const path = require('path');

const adminPath = path.join(__dirname, '..', 'admin.html');
const content = fs.readFileSync(adminPath, 'utf8');
const lines = content.split('\n');

console.log('Searching for tab-content closing tags or nesting...');

lines.forEach((line, idx) => {
    if (line.includes('tab-content')) {
        console.log(`L${idx + 1}: ${line.trim()}`);
    }
});
