const fs = require('fs');
const path = require('path');

const filePath = path.resolve(__dirname, '..', 'artist-booking-dashboard-obsidian.html');
if (!fs.existsSync(filePath)) {
    console.log("Mockup file not found!");
    process.exit(1);
}
const content = fs.readFileSync(filePath, 'utf8');

// Let's search for "Cormorant" or "Outfit" or "font-family" or headings in CSS
const keywords = ['font-family', 'Cormorant', 'title', '.atl-det-title', 'color:'];
keywords.forEach(keyword => {
    let idx = 0;
    console.log(`\n--- SEARCHING FOR "${keyword}" ---`);
    while ((idx = content.indexOf(keyword, idx)) !== -1) {
        const start = Math.max(0, idx - 80);
        const end = Math.min(content.length, idx + 180);
        console.log(`Found: [Pos ${idx}]`);
        console.log(content.slice(start, end));
        console.log('--------------------------------');
        idx += keyword.length;
        if (idx > 20000) break; // Limit searching
    }
});
