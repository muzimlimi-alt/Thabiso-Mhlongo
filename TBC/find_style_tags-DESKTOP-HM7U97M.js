const fs = require('fs');
const path = require('path');

const adminHtml = fs.readFileSync(path.join(__dirname, '../admin.html'), 'utf8');
const lines = adminHtml.split(/\r?\n/);

console.log("--- Style Tag Locations ---");
for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('<style>')) {
        console.log(`Open <style> at line ${i + 1}`);
    }
    if (lines[i].includes('</style>')) {
        console.log(`Close </style> at line ${i + 1}`);
    }
}
