const fs = require('fs');
const path = require('path');

const serverJsPath = path.resolve(__dirname, '..', 'server.js');
const content = fs.readFileSync(serverJsPath, 'utf8');

const lines = content.split('\n');
let foundLineIdx = -1;
lines.forEach((line, idx) => {
    if (line.includes("Direct Email Responder")) {
        foundLineIdx = idx;
    }
});

if (foundLineIdx !== -1) {
    console.log(`Found Direct Email Responder around line ${foundLineIdx + 1}`);
    for (let i = foundLineIdx; i < foundLineIdx + 50; i++) {
        console.log(`${i+1}: ${lines[i]}`);
    }
} else {
    console.log("Not found.");
}
