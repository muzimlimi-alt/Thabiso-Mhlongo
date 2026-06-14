const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '../admin.html');
const html = fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');

const sections = [
    "dashboardAdmin", "usersAdmin", "inquiriesAdmin", "bookingsAdmin", "calendarAdmin", 
    "financeAdmin", "servicesAdmin", "policiesAdmin", "homeAdmin", "aboutAdmin", 
    "careerAdmin", "galleryAdmin", "socialAdmin", "eventsAdmin", "contactAdmin", 
    "newsletterAdmin", "preferencesAdmin", "brandingAdmin", "emailLogsAdmin", "securityAdmin"
];

console.log("--- Section Headers Exact Content ---");
const lines = html.split('\n');
sections.forEach(sec => {
    const idx = lines.findIndex(l => l.includes(`id="${sec}"`));
    if (idx !== -1) {
        console.log(`\n=== ${sec} ===`);
        for (let i = idx; i < idx + 20; i++) {
            if (lines[i].includes('admin-section') && i > idx) break;
            console.log(`${i+1}: ${lines[i]}`);
        }
    } else {
        console.log(`Section ${sec} not found`);
    }
});
