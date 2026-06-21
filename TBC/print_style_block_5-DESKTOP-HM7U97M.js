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
        
        // Print lines 540 to 630 of this style block (1-indexed)
        const start = Math.max(0, 530);
        const end = Math.min(lines.length, 630);
        
        console.log(`--- Style Block 5, lines ${start + 1} to ${end} ---`);
        for (let i = start; i < end; i++) {
            console.log(`${i + 1}: ${lines[i]}`);
        }
        break;
    }
}
