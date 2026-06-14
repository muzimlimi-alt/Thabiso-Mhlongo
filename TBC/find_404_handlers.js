const fs = require('fs');
const path = require('path');

const serverPath = path.join(__dirname, '../server.js');
const content = fs.readFileSync(serverPath, 'utf8');
const lines = content.split('\n');

console.log('Matches for 404 or general middleware handlers in server.js:');
lines.forEach((line, index) => {
    if (line.includes('app.use(') || line.includes('status(404)') || line.includes('res.redirect(') || line.includes('error.html')) {
        console.log(`${index + 1}: ${line.trim()}`);
    }
});
