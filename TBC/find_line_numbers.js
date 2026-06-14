const fs = require('fs');
const path = require('path');

const serverJsPath = path.resolve(__dirname, '..', 'server.js');
const lines = fs.readFileSync(serverJsPath, 'utf8').split('\n');

lines.forEach((line, idx) => {
    if (line.includes('/api/admin/bookings/:id/details') || line.includes('cancellations WHERE booking_id')) {
        console.log(`Line ${idx + 1}: ${line}`);
    }
});
