const fs = require('fs');
const path = require('path');

const logPath = 'C:\\Users\\muzim\\.gemini\\antigravity-ide\\brain\\9ef78ee4-c302-4a8e-9d7e-499b880f1fc1\\.system_generated\\logs\\transcript.jsonl';

if (fs.existsSync(logPath)) {
    const content = fs.readFileSync(logPath, 'utf8');
    const lines = content.split('\n');
    const lineIndex = 85; // Step 89
    const rawLine = lines[lineIndex];
    
    console.log("Character at 2048:", JSON.stringify(rawLine.substring(2040, 2060)));
    console.log("CharCodes around 2048:", rawLine.substring(2040, 2060).split('').map(c => c.charCodeAt(0)));
}
