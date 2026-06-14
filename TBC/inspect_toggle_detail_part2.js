const fs = require('fs');
const path = require('path');

const adminHtmlPath = path.resolve(__dirname, '..', 'admin.html');
const content = fs.readFileSync(adminHtmlPath, 'utf8');

const start = 373700;
const end = 378700;
console.log("=== window.toggleBookingDetail Part 2 ===");
console.log(content.slice(start, end));
