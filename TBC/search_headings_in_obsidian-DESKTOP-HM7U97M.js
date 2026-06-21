const fs = require('fs');
const path = require('path');

const filePath = path.resolve(__dirname, '..', 'artist-booking-dashboard-obsidian.html');
const content = fs.readFileSync(filePath, 'utf8');

const headings = ['Client', 'Ledger', 'Venue', 'Quote', 'Client message', 'Transactions'];
headings.forEach(heading => {
    let idx = 0;
    console.log(`\n--- SEARCHING FOR HEADING "${heading}" ---`);
    while ((idx = content.indexOf(heading, idx)) !== -1) {
        const start = Math.max(0, idx - 150);
        const end = Math.min(content.length, idx + 150);
        console.log(`Found near position ${idx}:`);
        console.log(content.slice(start, end));
        console.log('--------------------------------');
        idx += heading.length;
    }
});
