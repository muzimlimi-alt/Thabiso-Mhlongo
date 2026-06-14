const fs = require('fs');
const path = require('path');

const adminPath = path.join(__dirname, '..', 'admin.html');
const content = fs.readFileSync(adminPath, 'utf8');
const lines = content.split('\n');

console.log('Searching for sidebar links (class="admin-sidebar" or ".tm-nav-link" or ".admin-nav-link")...');

let foundSidebar = false;
let linesToPrint = [];

lines.forEach((line, idx) => {
    const lineNum = idx + 1;
    if (line.includes('admin-sidebar') || line.includes('class="sidebar"') || line.includes('class="admin-nav"')) {
        foundSidebar = true;
        console.log(`L${lineNum}: ${line.trim()}`);
    }
    if (foundSidebar && lineNum >= 2950 && lineNum <= 3150) {
        linesToPrint.push(`L${lineNum}: ${line.trim()}`);
    }
});

console.log('\n--- Sidebar HTML excerpt (Lines 2950 to 3150) ---');
console.log(linesToPrint.join('\n'));
