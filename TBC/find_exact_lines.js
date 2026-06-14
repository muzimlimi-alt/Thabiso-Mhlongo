const fs = require('fs');
const path = require('path');

const content = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');
const lines = content.split('\n');

const query = '/* ── UNIVERSAL MODAL SYSTEM ── */';
let found = -1;

lines.forEach((line, idx) => {
    if (line.includes(query)) {
        found = idx;
    }
});

if (found !== -1) {
    console.log(`Found query on line ${found + 1}:`);
    for (let i = found; i < Math.min(lines.length, found + 45); i++) {
        console.log(`${i + 1}: ${lines[i]}`);
    }
} else {
    console.log("Query not found.");
}
