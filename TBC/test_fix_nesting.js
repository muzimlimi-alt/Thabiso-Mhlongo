const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '..', 'admin.html');
let content = fs.readFileSync(filePath, 'utf8');

const targetBeforeModal = '<!-- Block-Out Modal -->';
const replacementBeforeModal = '</div></div>\n            <!-- Block-Out Modal -->';

content = content.replace(targetBeforeModal, replacementBeforeModal);

// Replace both closing divs at the end of the modals
const targetEndModals = `            </div>
            </div>

            <!-- Services Catalogue -->`;
const replacementEndModals = `\n            <!-- Services Catalogue -->`;

content = content.replace(targetEndModals, replacementEndModals);

const modalIds = [
  'blockOutModal',
  'adminBookingModal',
  'bookingInfoModal',
  'bookingFinancialsModal',
  'bookingEmailModal'
];

let success = true;
modalIds.forEach(modalId => {
    const modalIndex = content.indexOf(`id="${modalId}"`);
    if (modalIndex === -1) {
        console.log(`Failed to find ${modalId}`);
        success = false;
        return;
    }
    
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
        
        console.log(`[TESTED] Modal #${modalId} starts inside section #${lastSection} at nesting depth ${depth}`);
        if (depth !== 0) {
            success = false;
        }
    }
});

const servicesIndex = content.indexOf('<div class="admin-section" id="servicesAdmin"');
const sectionRegex = /<div class="admin-section" id="([^"]+)"/g;
let secMatch;
let lastSection = null;
let lastSectionIndex = -1;

while ((secMatch = sectionRegex.exec(content)) !== null) {
    const secIndex = secMatch.index;
    if (secIndex < servicesIndex && secIndex > lastSectionIndex) {
        lastSection = secMatch[1];
        lastSectionIndex = secIndex;
    }
}

if (lastSection) {
    const slice = content.slice(lastSectionIndex, servicesIndex);
    const openDivs = (slice.match(/<div\b/g) || []).length;
    const closeDivs = (slice.match(/<\/div>/g) || []).length;
    const depth = openDivs - closeDivs;
    console.log(`[TESTED] Section #servicesAdmin starts inside section #${lastSection} at nesting depth ${depth}`);
    if (depth !== 0) {
        success = false;
    }
}

if (success) {
    console.log("\nTEST PASSED: Nesting is perfect!");
} else {
    console.log("\nTEST FAILED: Nesting is still incorrect.");
}
