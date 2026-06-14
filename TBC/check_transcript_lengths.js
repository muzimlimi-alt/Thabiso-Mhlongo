const fs = require('fs');
const path = require('path');

const logPath = 'C:\\Users\\muzim\\.gemini\\antigravity-ide\\brain\\9ef78ee4-c302-4a8e-9d7e-499b880f1fc1\\.system_generated\\logs\\transcript.jsonl';

if (fs.existsSync(logPath)) {
    const content = fs.readFileSync(logPath, 'utf8');
    const lines = content.split('\n');
    
    const steps = [89, 91, 95, 174];
    steps.forEach(stepNum => {
        const lineIndex = lines.findIndex(l => {
            if (!l) return false;
            try {
                const o = JSON.parse(l);
                return o.step_index === stepNum && o.tool_calls && JSON.stringify(o.tool_calls).includes('admin.html');
            } catch(e) { return false; }
        });
        
        if (lineIndex !== -1) {
            const rawLine = lines[lineIndex];
            console.log(`Step ${stepNum}: Line Index ${lineIndex}, Raw Length ${rawLine.length}, Ends with '}'? ${rawLine.endsWith('}') || rawLine.endsWith('}\r')}`);
            // Let's print the last 100 characters of the line
            console.log("Last 100 chars:", rawLine.substring(rawLine.length - 100));
        } else {
            console.log(`Step ${stepNum} not found in log`);
        }
    });
} else {
    console.log("Log file not found");
}
