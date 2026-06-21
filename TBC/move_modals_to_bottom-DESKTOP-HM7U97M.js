const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '..', 'admin.html');
let content = fs.readFileSync(filePath, 'utf8');

// Let's locate the modal block to move
const startStr = '<div class="modal fade" id="blockOutModal"';
const endStr = `            <!-- Services Catalogue -->`;

const startIndex = content.indexOf(startStr);
const endIndex = content.indexOf(endStr);

if (startIndex === -1 || endIndex === -1) {
    console.error("Could not find start or end index of the modals block.");
    process.exit(1);
}

// Extract the modals content
const modalsContent = content.slice(startIndex, endIndex).trim();

// Remove the modals content from the current position
content = content.slice(0, startIndex) + '\n' + content.slice(endIndex);

// Let's place the modals content right before the manual booking modal
const insertionPointStr = '<!-- ── Manual Booking Modal ─────────────────────────────────────────────── -->';
const insertionIndex = content.indexOf(insertionPointStr);

if (insertionIndex === -1) {
    console.error("Could not find insertion point for manual booking modal.");
    process.exit(1);
}

content = content.slice(0, insertionIndex) + modalsContent + '\n\n' + content.slice(insertionIndex);

// Write back to admin.html
fs.writeFileSync(filePath, content, 'utf8');
console.log("SUCCESS: Modals relocated to the bottom of admin.html!");
