const fs = require('fs');
const path = require('path');

const serverPath = path.join(__dirname, '../server.js');
const content = fs.readFileSync(serverPath, 'utf8');
const lines = content.split('\n');

console.log('Matches for R currency formatting/concatenation in server.js:');
lines.forEach((line, index) => {
    if (line.includes("'R '") || line.includes('"R "') || line.includes("R ") || line.includes("R ${")) {
        console.log(`${index + 1}: ${line.trim()}`);
    }
});
