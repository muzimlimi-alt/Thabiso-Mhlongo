const fs = require('fs');
const path = require('path');

const adminHtml = fs.readFileSync(path.join(__dirname, '../admin.html'), 'utf8').replace(/\r\n/g, '\n');
const lines = adminHtml.split('\n');

const remaining = ["calendarAdmin", "policiesAdmin", "aboutAdmin", "careerAdmin", "galleryAdmin", "socialAdmin", "eventsAdmin", "contactAdmin"];

remaining.forEach(sec => {
    const idx = lines.findIndex(l => l.includes(`id="${sec}"`));
    if (idx !== -1) {
        console.log(`\n=== ${sec} ===`);
        for (let i = idx; i < idx + 10; i++) {
            console.log(`${i+1}: ${lines[i]}`);
        }
    }
});
