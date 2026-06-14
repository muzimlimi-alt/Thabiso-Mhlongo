const fs = require('fs');
const path = require('path');

const adminPath = path.join(__dirname, '..', 'admin.html');
const content = fs.readFileSync(adminPath, 'utf8');
const lines = content.split('\n');

console.log('Searching for click event listeners...');

lines.forEach((line, idx) => {
    if (line.includes("click") && (line.includes("addEventListener") || line.includes(".on(")) && (idx + 1) > 1000) {
        console.log(`L${idx + 1}: ${line.trim()}`);
    }
});
