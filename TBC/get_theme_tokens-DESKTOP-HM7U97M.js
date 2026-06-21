const fs = require('fs');
const path = require('path');

const adminPath = path.join(__dirname, '..', 'admin.html');
const content = fs.readFileSync(adminPath, 'utf8');
const lines = content.split('\n');

console.log('Extracting CSS variables...\n');
let insideRoot = false;
lines.forEach((line, idx) => {
    if (line.includes(':root') || line.includes('[data-theme="dark"]') || line.includes('[data-theme="light"]')) {
        console.log(`L${idx + 1}: ${line.trim()}`);
        insideRoot = true;
    }
    if (insideRoot) {
        if (line.trim().startsWith('--atl-')) {
            console.log(`  ${line.trim()}`);
        }
        if (line.trim() === '}' || line.trim() === '/*') {
            insideRoot = false;
        }
    }
});
