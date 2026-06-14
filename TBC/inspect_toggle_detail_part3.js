const fs = require('fs');
const path = require('path');

const adminHtmlPath = path.resolve(__dirname, '..', 'admin.html');
const content = fs.readFileSync(adminHtmlPath, 'utf8');

const start = 378500;
const end = 383500;
console.log("=== window.toggleBookingDetail Part 3 ===");
console.log(content.slice(start, end));
