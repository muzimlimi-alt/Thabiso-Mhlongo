const fs = require('fs');
const path = require('path');

const adminHtmlPath = path.resolve(__dirname, '..', 'admin.html');
const content = fs.readFileSync(adminHtmlPath, 'utf8');

// Find occurrences of cancellation or cancelReasonInput or renderInlineCancellationPanel
const keywords = ['renderInlineCancellationPanel', 'cancellation', 'cancelReasonInput', 'validateCancelForm'];
keywords.forEach(keyword => {
    console.log(`\n--- SEARCHING FOR "${keyword}" ---`);
    let idx = 0;
    while ((idx = content.indexOf(keyword, idx)) !== -1) {
        // print 200 chars before and 400 chars after
        const start = Math.max(0, idx - 200);
        const end = Math.min(content.length, idx + 500);
        console.log(`[Pos ${idx}]`);
        console.log(content.slice(start, end));
        console.log('----------------------------------------------------');
        idx += keyword.length;
    }
});
