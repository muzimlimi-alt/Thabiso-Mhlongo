const fs = require('fs');
const path = require('path');

const filePath = path.resolve(__dirname, '..', 'artist-booking-dashboard-obsidian.html');
const content = fs.readFileSync(filePath, 'utf8');

// Find all css blocks or styles that contain h1, h2, h3, h4, h5, or h6
const lines = content.split('\n');
lines.forEach((line, idx) => {
    if (line.match(/\b(h1|h2|h3|h4|h5|h6)\b/i) && (line.includes('{') || line.includes(':') || line.includes(','))) {
        console.log(`Line ${idx + 1}: ${line.trim()}`);
    }
});
