const fs = require('fs');
const path = require('path');

const adminPath = path.join(__dirname, '..', 'admin.html');
const content = fs.readFileSync(adminPath, 'utf8');

// 1. Find all sidebar links and their href values
const sidebarRegex = /href="(#\w+)"[^>]*class="tm-nav-link"/g;
const links = [];
let match;
while ((match = sidebarRegex.exec(content)) !== null) {
    links.push(match[1]);
}

console.log('Sidebar links found:', links);

// 2. Find all section divs and check their classes
const sectionRegex = /<div\s+[^>]*id="(\w+)"/g;
const sections = [];
const lines = content.split('\n');

lines.forEach((line, idx) => {
    if (line.includes('id=') && (line.includes('Admin') || line.includes('admin-section'))) {
        const idMatch = line.match(/id="(\w+)"/);
        const classMatch = line.match(/class="([^"]+)"/);
        if (idMatch) {
            console.log(`L${idx + 1}: Element id="${idMatch[1]}" has class="${classMatch ? classMatch[1] : 'NONE'}"`);
        }
    }
});
