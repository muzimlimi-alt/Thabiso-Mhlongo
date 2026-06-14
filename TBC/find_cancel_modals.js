const fs = require('fs');
const path = require('path');

const adminHtmlPath = path.resolve(__dirname, '..', 'admin.html');
const content = fs.readFileSync(adminHtmlPath, 'utf8');

const modalIds = ['cancelBookingModal', 'cancelModal'];
modalIds.forEach(id => {
    let idx = 0;
    console.log(`\n--- Searching for id="${id}" ---`);
    while ((idx = content.indexOf(`id="${id}"`, idx)) !== -1) {
        const start = Math.max(0, idx - 100);
        const end = Math.min(content.length, idx + 300);
        console.log(`Found: [Pos ${idx}]`);
        console.log(content.slice(start, end));
        console.log('--------------------------------');
        idx += id.length;
    }
});
