const fs = require('fs');
const path = require('path');

const adminPath = path.join(__dirname, '..', 'admin.html');
const content = fs.readFileSync(adminPath, 'utf8');
const lines = content.split('\n');

console.log("=== SEARCHING FOR STYLE TAGS IN admin.html ===");
lines.forEach((line, index) => {
    if (line.includes('<style')) {
        console.log(`L${index + 1}: ${line.trim()}`);
    }
});
