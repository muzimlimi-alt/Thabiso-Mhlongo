const fs = require('fs');
const path = require('path');

const adminHtmlPath = path.resolve(__dirname, '..', 'admin.html');
const content = fs.readFileSync(adminHtmlPath, 'utf8');

const regex = /cancellation/gi;
let match;
while ((match = regex.exec(content)) !== null) {
    const idx = match.index;
    const start = Math.max(0, idx - 150);
    const end = Math.min(content.length, idx + 250);
    console.log(`[Pos ${idx}]`);
    console.log(content.slice(start, end));
    console.log('----------------------------------------------------');
}
