const fs = require('fs');
const path = require('path');

const adminPath = path.join(__dirname, '..', 'admin.html');
const content = fs.readFileSync(adminPath, 'utf8');
const lines = content.split('\n');

const sectionIds = [
    'dashboardAdmin',
    'usersAdmin',
    'inquiriesAdmin',
    'bookingsAdmin',
    'calendarAdmin',
    'financeAdmin',
    'servicesAdmin',
    'policiesAdmin',
    'homeAdmin',
    'aboutAdmin',
    'careerAdmin',
    'galleryAdmin',
    'socialAdmin',
    'eventsAdmin',
    'contactAdmin',
    'newsletterAdmin',
    'preferencesAdmin',
    'brandingAdmin',
    'emailLogsAdmin',
    'securityAdmin'
];

sectionIds.forEach(id => {
    const startIndex = lines.findIndex(l => l.includes(`id="${id}"`));
    if (startIndex !== -1) {
        // Let's inspect from startIndex to search for the heading markup
        let foundHd = false;
        let hdLine = '';
        for (let i = 0; i < 15; i++) {
            const line = lines[startIndex + i];
            if (line && line.includes('atl-section-hd')) {
                foundHd = true;
                hdLine = line.trim();
                break;
            }
        }
        if (foundHd) {
            console.log(`[OK] Section ${id} has header: ${hdLine}`);
        } else {
            console.log(`[NEED REFACTOR] Section ${id} does NOT have atl-section-hd! Here is the markup near start:`);
            for (let i = 0; i < 10; i++) {
                console.log(`  L${startIndex + i + 1}: ${lines[startIndex + i].trim()}`);
            }
        }
    }
});
