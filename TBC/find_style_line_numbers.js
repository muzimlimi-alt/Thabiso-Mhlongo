const fs = require('fs');
const path = require('path');

const adminHtmlPath = path.resolve(__dirname, '..', 'admin.html');
const lines = fs.readFileSync(adminHtmlPath, 'utf8').split('\n');

lines.forEach((line, idx) => {
    if (line.includes('.atl-det-title') || line.includes('font-family: \'Outfit\', sans-serif;') && lines[idx - 1] && lines[idx - 1].includes('.atl-det-title')) {
        console.log(`Line ${idx + 1}: ${line}`);
    }
    if (line.includes('Panel title')) {
        console.log(`Line ${idx + 1}: ${line}`);
    }
});
