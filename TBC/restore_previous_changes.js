const fs = require('fs');
const path = require('path');

const logPath = 'C:\\Users\\muzim\\.gemini\\antigravity-ide\\brain\\9ef78ee4-c302-4a8e-9d7e-499b880f1fc1\\.system_generated\\logs\\transcript.jsonl';

if (fs.existsSync(logPath)) {
    const content = fs.readFileSync(logPath, 'utf8');
    const lines = content.split('\n');
    
    for (let i = 0; i < lines.length; i++) {
        if (!lines[i]) continue;
        try {
            const obj = JSON.parse(lines[i]);
            if (obj.step_index < 192 && obj.tool_calls) {
                for (const call of obj.tool_calls) {
                    if (JSON.stringify(call.args).includes('admin.html')) {
                        console.log(`\n==================================================`);
                        console.log(`STEP INDEX: ${obj.step_index} | TOOL: ${call.name}`);
                        console.log(`==================================================`);
                        console.log(JSON.stringify(call.args, null, 2));
                    }
                }
            }
        } catch(e) {}
    }
} else {
    console.log("Log file not found");
}
