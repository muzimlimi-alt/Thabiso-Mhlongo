const fs = require('fs');
const path = require('path');

const databaseJsPath = "c:/Users/muzim/OneDrive/Muzi's Office/Dev-Beast/Thabiso Mhlongo Official Website/Thabiso Mhlongo Offcial Website/database.js";
const content = fs.readFileSync(databaseJsPath, 'utf8');
const lines = content.split('\n');

const query = 'consent_audit';
console.log(`\n--- Searching for "${query}" ---`);
lines.forEach((line, index) => {
    if (line.includes(query)) {
        console.log(`Line ${index + 1}: ${line.trim()}`);
    }
});
