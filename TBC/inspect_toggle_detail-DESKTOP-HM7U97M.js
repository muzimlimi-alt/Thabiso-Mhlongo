const fs = require('fs');
const path = require('path');

const adminHtmlPath = path.resolve(__dirname, '..', 'admin.html');
const content = fs.readFileSync(adminHtmlPath, 'utf8');

const start = 371800;
const end = 375800;
console.log("=== window.toggleBookingDetail ===");
console.log(content.slice(start, end));
