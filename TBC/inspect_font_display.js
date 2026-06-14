const fs = require('fs');
const path = require('path');

const filePath = path.resolve(__dirname, '..', 'artist-booking-dashboard-obsidian.html');
const content = fs.readFileSync(filePath, 'utf8');

const keyword = '.font-display';
let idx = 0;
while ((idx = content.indexOf(keyword, idx)) !== -1) {
    const start = Math.max(0, idx - 100);
    const end = Math.min(content.length, idx + 200);
    console.log(`Found .font-display near ${idx}:`);
    console.log(content.slice(start, end));
    console.log('--------------------------------');
    idx += keyword.length;
}
