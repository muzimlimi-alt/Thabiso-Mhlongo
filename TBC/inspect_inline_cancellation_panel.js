const fs = require('fs');
const path = require('path');

const adminHtmlPath = path.resolve(__dirname, '..', 'admin.html');
const content = fs.readFileSync(adminHtmlPath, 'utf8');

const start = 370800;
const end = 372300;
console.log("=== renderInlineCancellationPanel ===");
console.log(content.slice(start, end));
