const fs = require('fs');
const path = require('path');

const filePath = path.resolve(__dirname, '..', 'artist-booking-dashboard-obsidian.html');
const content = fs.readFileSync(filePath, 'utf8');

// Find all h5 elements and print their exact HTML tags
const regex = /<h5\b[^>]*>([\s\S]*?)<\/h5>/gi;
let match;
while ((match = regex.exec(content)) !== null) {
    console.log(`Found h5 tag: ${match[0]}`);
}
