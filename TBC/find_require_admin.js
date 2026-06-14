const fs = require('fs');
const path = require('path');

const serverPath = path.join(__dirname, '../server.js');
const content = fs.readFileSync(serverPath, 'utf8');
const lines = content.split('\n');

console.log('Matches for requireAdmin definition:');
lines.forEach((line, index) => {
    if (line.includes('function requireAdmin') || line.includes('const requireAdmin')) {
        console.log(`${index + 1}: ${line.trim()}`);
    }
});
