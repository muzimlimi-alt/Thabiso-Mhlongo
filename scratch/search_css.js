const fs = require('fs');

const cssContent = fs.readFileSync('css/redesign.css', 'utf8');
const lines = cssContent.split('\n');

console.log('=== CSS Button Styles in redesign.css ===');
lines.forEach((line, idx) => {
    if (line.includes('.um-btn') || line.includes('.btn-admin') || line.includes('.atl-btn')) {
        console.log(`${idx + 1}: ${line.trim()}`);
    }
});
