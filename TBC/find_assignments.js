const fs = require('fs');
const path = require('path');

const adminPath = path.join(__dirname, '../admin.html');
const content = fs.readFileSync(adminPath, 'utf8');
const lines = content.split('\n');

console.log('Assignments/manipulations of quote_amount in admin.html:');
lines.forEach((line, index) => {
    if (line.includes('quote_amount') && (line.includes('=') || line.includes('replace') || line.includes('parseFloat'))) {
        console.log(`${index + 1}: ${line.trim()}`);
    }
});
