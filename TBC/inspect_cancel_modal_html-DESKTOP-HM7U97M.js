const fs = require('fs');
const path = require('path');

const adminHtmlPath = path.resolve(__dirname, '..', 'admin.html');
const content = fs.readFileSync(adminHtmlPath, 'utf8');

const start = 911300;
const end = 913600;
console.log("=== cancelModal HTML structure ===");
console.log(content.slice(start, end));
