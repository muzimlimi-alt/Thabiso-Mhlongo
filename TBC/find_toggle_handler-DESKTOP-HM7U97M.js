const fs = require('fs');
const path = require('path');

const adminHtml = fs.readFileSync(path.join(__dirname, '../admin.html'), 'utf8');
const lines = adminHtml.split(/\r?\n/);

console.log("--- Theme Toggle Handler Search ---");
for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('atlThemeToggle') && lines[i].includes('click')) {
        console.log(`Match at line ${i + 1}: ${lines[i]}`);
        for (let j = i; j < i + 15; j++) {
            console.log(`  ${j+1}: ${lines[j]}`);
        }
    }
}
