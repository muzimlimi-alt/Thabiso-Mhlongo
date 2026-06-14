const fs = require('fs');
const path = require('path');

const serverJsPath = path.resolve(__dirname, '..', 'server.js');
const content = fs.readFileSync(serverJsPath, 'utf8');

const keyword = '/cancel';
let idx = 0;
while ((idx = content.indexOf(keyword, idx)) !== -1) {
    const start = Math.max(0, idx - 100);
    const end = Math.min(content.length, idx + 400);
    console.log(`Found /cancel at [Pos ${idx}]:`);
    console.log(content.slice(start, end));
    console.log('--------------------------------');
    idx += keyword.length;
}
