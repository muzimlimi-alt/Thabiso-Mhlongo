const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', 'scratch', 'modal_visual_debug.png');
const dest = 'C:\\Users\\muzim\\.gemini\\antigravity-ide\\brain\\e9621751-6397-4751-aac3-f5cb542a1d3a\\media_modal_visual_debug.png';

if (fs.existsSync(src)) {
    fs.copyFileSync(src, dest);
    console.log("Screenshot copied to brain directory successfully!");
} else {
    console.log("Source screenshot not found.");
}
