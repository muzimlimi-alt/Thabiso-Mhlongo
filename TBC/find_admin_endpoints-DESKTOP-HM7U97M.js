const fs = require('fs');
const path = require('path');

const serverJsPath = path.resolve(__dirname, '..', 'server.js');
const content = fs.readFileSync(serverJsPath, 'utf8');

const keywords = ['/api/admin/bookings/', 'cancellations', 'line_items', '/details'];
keywords.forEach(keyword => {
    let idx = 0;
    console.log(`\n--- SEARCHING FOR "${keyword}" ---`);
    while ((idx = content.indexOf(keyword, idx)) !== -1) {
        const start = Math.max(0, idx - 100);
        const end = Math.min(content.length, idx + 300);
        console.log(`Found: [Pos ${idx}]`);
        console.log(content.slice(start, end));
        console.log('--------------------------------');
        idx += keyword.length;
    }
});
