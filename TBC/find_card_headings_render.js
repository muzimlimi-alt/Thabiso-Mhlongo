const fs = require('fs');
const path = require('path');

const adminHtmlPath = path.resolve(__dirname, '..', 'admin.html');
const content = fs.readFileSync(adminHtmlPath, 'utf8');

// Find all h5 elements in the js template string between lines 525000 and 548000
const start = 525000;
const end = 548000;
const jsSegment = content.slice(start, end);

let idx = 0;
while ((idx = jsSegment.indexOf('<h5', idx)) !== -1) {
    const s = Math.max(0, idx - 100);
    const e = Math.min(jsSegment.length, idx + 300);
    console.log(`Found h5 inside js segment around char index ${start + idx}:`);
    console.log(jsSegment.slice(s, e));
    console.log('--------------------------------');
    idx += 3;
}
