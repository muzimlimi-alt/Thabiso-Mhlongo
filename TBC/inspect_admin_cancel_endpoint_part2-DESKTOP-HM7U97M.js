const fs = require('fs');
const path = require('path');

const serverJsPath = path.resolve(__dirname, '..', 'server.js');
const content = fs.readFileSync(serverJsPath, 'utf8');

const start = 201500;
const end = 203500;
console.log("=== /api/admin/bookings/:id/cancel Part 2 (Admin) ===");
console.log(content.slice(start, end));
