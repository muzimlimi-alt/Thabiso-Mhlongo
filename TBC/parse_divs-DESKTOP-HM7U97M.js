const fs = require('fs');
const path = require('path');

const content = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');

// Find all modal IDs
const modalRegex = /id="([^"]+Modal)"/g;
let match;
const modals = [];
while ((match = modalRegex.exec(content)) !== null) {
    modals.push(match[1]);
}

// Also add blockOutModal specifically
if (!modals.includes('blockOutModal')) {
    modals.push('blockOutModal');
}

console.log("Found modals:", modals);

modals.forEach(modalId => {
    const modalIndex = content.indexOf(`id="${modalId}"`);
    if (modalIndex === -1) return;
    
    // Find all admin sections that start before this modal
    const sectionRegex = /<div class="admin-section" id="([^"]+)"/g;
    let secMatch;
    let lastSection = null;
    let lastSectionIndex = -1;
    
    while ((secMatch = sectionRegex.exec(content)) !== null) {
        const secIndex = secMatch.index;
        if (secIndex < modalIndex && secIndex > lastSectionIndex) {
            lastSection = secMatch[1];
            lastSectionIndex = secIndex;
        }
    }
    
    if (lastSection) {
        const slice = content.slice(lastSectionIndex, modalIndex);
        const openDivs = (slice.match(/<div\b/g) || []).length;
        const closeDivs = (slice.match(/<\/div>/g) || []).length;
        const depth = openDivs - closeDivs;
        
        console.log(`Modal #${modalId} starts inside section #${lastSection} at nesting depth ${depth}`);
    } else {
        console.log(`Modal #${modalId} is defined before any admin section.`);
    }
});
