const fs = require('fs');
const path = require('path');

const serverJsPath = "c:/Users/muzim/OneDrive/Muzi's Office/Dev-Beast/Thabiso Mhlongo Official Website/Thabiso Mhlongo Offcial Website/server.js";
const content = fs.readFileSync(serverJsPath, 'utf8');
const lines = content.split('\n');

const query = 'requireRole';
console.log(`\n--- Searching for "${query}" ---`);
lines.forEach((line, index) => {
    if (line.includes(query)) {
        console.log(`Line ${index + 1}: ${line.trim()}`);
    }
});
