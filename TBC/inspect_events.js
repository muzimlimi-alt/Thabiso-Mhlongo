const fs = require('fs');
const path = require('path');

const adminPath = path.join(__dirname, '..', 'admin.html');
const content = fs.readFileSync(adminPath, 'utf8');

const lines = content.split('\n');

// Find the line index of be-template change handler
let targetLineIdx = 12429 - 1; // 0-indexed

// Search upwards for the opening <script> tag
let scriptStartLine = -1;
for (let i = targetLineIdx; i >= 0; i--) {
    if (lines[i].includes('<script')) {
        scriptStartLine = i + 1;
        break;
    }
}

console.log(`Script tag starts on line: ${scriptStartLine}`);
for (let i = scriptStartLine - 1; i < scriptStartLine + 20; i++) {
    console.log(`${i+1}: ${lines[i]}`);
}
