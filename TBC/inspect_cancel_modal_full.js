const fs = require('fs');
const path = require('path');

const adminHtmlPath = path.resolve(__dirname, '..', 'admin.html');
const content = fs.readFileSync(adminHtmlPath, 'utf8');

const start = 911000;
const end = 917200;
console.log("=== cancelModal Full HTML ===");
console.log(content.slice(start, end));
