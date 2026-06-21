const fs = require('fs');
const path = require('path');

const adminPath = path.join(__dirname, '../admin.html');
const content = fs.readFileSync(adminPath, 'utf8');
const lines = content.split('\n');

console.log('Matches for api/admin/bookings or apiCall in admin.html:');
lines.forEach((line, index) => {
    if (line.includes('api/admin/bookings') || line.includes('/api/bookings') || line.includes('apiCall')) {
        console.log(`${index + 1}: ${line.trim()}`);
    }
});
