const fs = require('fs');
const path = require('path');

const adminHtmlPath = path.resolve(__dirname, '..', 'admin.html');
const content = fs.readFileSync(adminHtmlPath, 'utf8');

const start = 526500;
const end = 528500;
console.log("=== HTML structure around atl-expand-btn ===");
console.log(content.slice(start, end));
