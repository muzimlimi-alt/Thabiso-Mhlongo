const fs = require('fs');
const path = require('path');

const adminPath = path.join(__dirname, '..', 'admin.html');
const content = fs.readFileSync(adminPath, 'utf8');
const lines = content.split('\n');

console.log("=== ALL CLICK LISTENERS AND SELECTIONS ===");
lines.forEach((line, index) => {
    if (line.includes('click') || line.includes('addEventListener') || line.includes('on(')) {
        if (!line.trim().startsWith('*') && !line.trim().startsWith('//') && !line.trim().startsWith('/*') && !line.trim().startsWith('<')) {
            console.log(`L${index + 1}: ${line.trim()}`);
        }
    }
});
