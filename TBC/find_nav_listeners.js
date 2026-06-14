const fs = require('fs');
const path = require('path');

const adminPath = path.join(__dirname, '..', 'admin.html');
const content = fs.readFileSync(adminPath, 'utf8');
const lines = content.split('\n');

console.log("=== SCANNING FOR SIDEBAR/NAV LISTENER SELECTORS ===");
lines.forEach((line, index) => {
    if (line.includes('admin-sidebar') || line.includes('tm-nav-link') || line.includes('nav-link')) {
        // Only print if inside a script block
        // (A simple heuristic: we know where scripts are, but let's just print all occurrences in JS style)
        if (!line.trim().startsWith('<') && !line.trim().startsWith('*') && !line.trim().startsWith('/') && !line.trim().startsWith('.')) {
            console.log(`L${index + 1}: ${line.trim()}`);
        }
    }
});
