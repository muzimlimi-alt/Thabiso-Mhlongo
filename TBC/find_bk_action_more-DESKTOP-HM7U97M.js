const fs = require('fs');
const path = require('path');

const adminHtmlPath = path.resolve(__dirname, '..', 'admin.html');
const content = fs.readFileSync(adminHtmlPath, 'utf8');

const keywords = ['bk-action-more', 'bkr-more-dropdown', 'cancel-booking-btn', 'click', 'submitCancelBtn'];
keywords.forEach(keyword => {
    let idx = 0;
    console.log(`\n--- SEARCH FOR "${keyword}" ---`);
    while ((idx = content.indexOf(keyword, idx)) !== -1) {
        const start = Math.max(0, idx - 100);
        const end = Math.min(content.length, idx + 250);
        console.log(`Found: [Pos ${idx}]`);
        console.log(content.slice(start, end));
        console.log('--------------------------------');
        idx += keyword.length;
        if (idx > 200000) break;
    }
});
