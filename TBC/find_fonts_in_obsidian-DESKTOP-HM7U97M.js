const fs = require('fs');
const path = require('path');

const filePath = path.resolve(__dirname, '..', 'artist-booking-dashboard-obsidian.html');
const content = fs.readFileSync(filePath, 'utf8');

// Find all link tags or @import with fonts, and any font-family declarations
const lines = content.split('\n');
lines.forEach((line, idx) => {
    if (line.includes('fonts.googleapis.com') || line.includes('font-family') || line.includes('font-display')) {
        console.log(`Line ${idx + 1}: ${line.trim()}`);
    }
});
