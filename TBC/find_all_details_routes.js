const fs = require('fs');
const path = require('path');

const serverJsPath = path.resolve(__dirname, '..', 'server.js');
const content = fs.readFileSync(serverJsPath, 'utf8');

const regex = /\/details/gi;
let match;
while ((match = regex.exec(content)) !== null) {
    const idx = match.index;
    const start = Math.max(0, idx - 150);
    const end = Math.min(content.length, idx + 350);
    console.log(`Found "/details" at [Pos ${idx}]:`);
    console.log(content.slice(start, end));
    console.log('----------------------------------------------------');
}
