const fs = require('fs');
const path = require('path');

const serverJsPath = path.resolve(__dirname, '..', 'server.js');
const content = fs.readFileSync(serverJsPath, 'utf8');

const start = 288000;
const end = 290500;
console.log("=== /api/admin/bookings/:id/details ===");
console.log(content.slice(start, end));
