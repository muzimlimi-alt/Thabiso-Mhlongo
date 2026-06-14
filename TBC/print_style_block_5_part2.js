const fs = require('fs');
const path = require('path');

const content = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');

const styleRegex = /<style[^>]*>([\s\S]*?)<\/style>/gi;
let match;
let count = 0;

while ((match = styleRegex.exec(content)) !== null) {
    count++;
    if (count === 5) {
        const styleText = match[1];
        const lines = styleText.split('\n');
        
        const start = 1610;
        const end = Math.min(lines.length, 1680);
        
        console.log(`--- Style Block 5, lines ${start + 1} to ${end} ---`);
        for (let i = start; i < end; i++) {
            console.log(`${i + 1}: ${lines[i]}`);
        }
        break;
    }
}
