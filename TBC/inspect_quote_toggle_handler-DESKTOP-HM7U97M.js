const fs = require('fs');
const path = require('path');

const adminHtmlPath = path.resolve(__dirname, '..', 'admin.html');
const content = fs.readFileSync(adminHtmlPath, 'utf8');

const start = 913400;
const end = 916000;
console.log("=== bk-action-quote handler ===");
console.log(content.slice(start, end));
