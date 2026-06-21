const fs = require('fs');
const path = require('path');

const adminPath = path.join(__dirname, '..', 'admin.html');
const content = fs.readFileSync(adminPath, 'utf8');
const lines = content.split('\n');

console.log('Searching for CSS rules targeting .admin-section ...');

lines.forEach((line, idx) => {
    if (line.includes('admin-section') && (idx + 1) < 2900) {
        console.log(`L${idx + 1}: ${line.trim()}`);
    }
});
