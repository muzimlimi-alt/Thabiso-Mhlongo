const fs = require('fs');
const path = require('path');

const serverJsPath = path.resolve(__dirname, '..', 'server.js');
const content = fs.readFileSync(serverJsPath, 'utf8');

const start = 203000;
const end = 205000;
console.log("=== /api/admin/bookings/:id/cancel Part 3 (Admin) ===");
console.log(content.slice(start, end));
