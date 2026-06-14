const fs = require('fs');
const path = require('path');

const dashPath = path.join(__dirname, '../artist-booking-dashboard.html');
if (fs.existsSync(dashPath)) {
    const content = fs.readFileSync(dashPath, 'utf8');
    const lines = content.split('\n');

    console.log('Matches for quote_amount in artist-booking-dashboard.html:');
    lines.forEach((line, index) => {
        if (line.toLowerCase().includes('quote_amount')) {
            console.log(`${index + 1}: ${line.trim()}`);
        }
    });
} else {
    console.log('artist-booking-dashboard.html does not exist.');
}
