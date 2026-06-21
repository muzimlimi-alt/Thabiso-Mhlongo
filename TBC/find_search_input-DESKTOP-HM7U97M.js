const fs = require('fs');
const path = require('path');

const adminPath = path.join(__dirname, '..', 'admin.html');
const content = fs.readFileSync(adminPath, 'utf8');
const lines = content.split('\n');

console.log("=== SEARCHING FOR SEARCH INPUT ===");
lines.forEach((line, index) => {
    if (line.includes('placeholder="Search bookings') || line.includes('placeholder="Search') || line.includes('id="globalSearch"')) {
        console.log(`L${index + 1}: ${line.trim()}`);
        console.log("--- Surrounding lines ---");
        for (let i = -5; i <= 5; i++) {
            if (lines[index + i]) console.log(`${index + i + 1}: ${lines[index + i]}`);
        }
    }
});
