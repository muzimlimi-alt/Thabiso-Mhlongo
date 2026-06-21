const fs = require('fs');
const path = require('path');

const adminHtmlPath = path.resolve(__dirname, '..', 'admin.html');
const content = fs.readFileSync(adminHtmlPath, 'utf8');

// Find all event listeners matching "cancel" or "click" and "cancel" in script tags
// Let's print out the script block around Pos 575805
const start = 574800;
const end = 577000;
console.log("=== SCRIPT AREA AROUND 575805 ===");
console.log(content.slice(start, end));

console.log("\n=== SCRIPT AREA AROUND 917184 ===");
console.log(content.slice(917000, 921000));
