const fs = require('fs');
const path = require('path');

const adminHtmlPath = path.resolve(__dirname, '..', 'admin.html');
const content = fs.readFileSync(adminHtmlPath, 'utf8');

// Search for any CSS rule containing h5 or headings inside style tags
const styleStart = content.indexOf('<style>');
const styleEnd = content.indexOf('</style>');
const styleContent = content.slice(styleStart, styleEnd);

const keywords = ['h5', 'h4', '.atl-det-card'];
keywords.forEach(keyword => {
    let idx = 0;
    console.log(`\n--- SEARCH STYLES FOR "${keyword}" ---`);
    while ((idx = styleContent.indexOf(keyword, idx)) !== -1) {
        const start = Math.max(0, idx - 100);
        const end = Math.min(styleContent.length, idx + 200);
        console.log(`Found: [Pos ${start + styleStart}]`);
        console.log(styleContent.slice(start, end));
        console.log('--------------------------------');
        idx += keyword.length;
    }
});
