const fs = require('fs');
const path = require('path');

const adminPath = path.join(__dirname, '..', 'admin.html');
const content = fs.readFileSync(adminPath, 'utf8');
const lines = content.split('\n');

console.log('Searching for sidebar click listeners or selector mappings...');

lines.forEach((line, idx) => {
    if (line.includes('sidebar') && line.includes('click') && (idx + 1) > 1000) {
        console.log(`L${idx + 1}: ${line.trim().substring(0, 150)}`);
    }
});
