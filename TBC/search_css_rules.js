const fs = require('fs');
const path = require('path');

const content = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');

// Find all <style> blocks and extract styles containing atl-btn, modal, etc.
const styleRegex = /<style[^>]*>([\s\S]*?)<\/style>/gi;
let match;
let count = 0;

console.log("Searching style tags inside admin.html...");
while ((match = styleRegex.exec(content)) !== null) {
    count++;
    const styleText = match[1];
    const lines = styleText.split('\n');
    lines.forEach((line, idx) => {
        if (line.includes('atl-btn') || line.includes('.modal') || line.includes('backdrop') || line.includes('filter')) {
            console.log(`Block ${count}, Line ${idx + 1}: ${line.trim()}`);
        }
    });
}
