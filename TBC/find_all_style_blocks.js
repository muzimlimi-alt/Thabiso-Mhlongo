const fs = require('fs');
const path = require('path');

const adminHtmlPath = path.resolve(__dirname, '..', 'admin.html');
const content = fs.readFileSync(adminHtmlPath, 'utf8');

const regex = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
let match;
let count = 0;
while ((match = regex.exec(content)) !== null) {
    count++;
    const styleContent = match[1];
    console.log(`\n=== Style block ${count} ===`);
    // Search for h5, headings, or .atl-det-title inside this block
    const lines = styleContent.split('\n');
    lines.forEach((line, idx) => {
        if (line.includes('h5') || line.includes('atl-det') || line.includes('font-family')) {
            console.log(`  Line ${idx + 1}: ${line.trim()}`);
        }
    });
}
