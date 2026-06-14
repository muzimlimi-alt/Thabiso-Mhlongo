const fs = require('fs');
const path = require('path');

const cssDir = path.join(__dirname, '..', 'css');
const files = ['redesign.css', 'style.css'];

files.forEach(filename => {
    const filePath = path.join(cssDir, filename);
    if (!fs.existsSync(filePath)) return;
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');
    console.log(`\n--- Keywords in ${filename} ---`);
    lines.forEach((line, idx) => {
        const lower = line.toLowerCase();
        if (lower.includes('opacity') || lower.includes('filter')) {
            console.log(`Line ${idx + 1}: ${line.trim()}`);
        }
    });
});
