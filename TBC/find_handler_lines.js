const fs = require('fs');
const path = require('path');

const adminHtmlPath = path.resolve(__dirname, '..', 'admin.html');
const lines = fs.readFileSync(adminHtmlPath, 'utf8').split('\n');

lines.forEach((line, idx) => {
    if (line.includes("click.bkrdet") || line.includes("atl-booking-card-header, .atl-expand-btn")) {
        console.log(`Line ${idx + 1}: ${line}`);
    }
});
