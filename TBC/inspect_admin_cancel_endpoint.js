const fs = require('fs');
const path = require('path');

const serverJsPath = path.resolve(__dirname, '..', 'server.js');
const content = fs.readFileSync(serverJsPath, 'utf8');

const start = 199000;
const end = 202000;
console.log("=== /api/admin/bookings/:id/cancel (Admin) ===");
console.log(content.slice(start, end));
