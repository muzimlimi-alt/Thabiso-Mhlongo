const fs = require('fs');
const path = require('path');

const logPath = 'C:\\Users\\muzim\\.gemini\\antigravity-ide\\brain\\9ef78ee4-c302-4a8e-9d7e-499b880f1fc1\\.system_generated\\logs\\transcript.jsonl';

if (fs.existsSync(logPath)) {
    const content = fs.readFileSync(logPath, 'utf8');
    const lines = content.split('\n');
    
    const targets = [89, 91, 95, 174];
    targets.forEach(step => {
        const line = lines.find(l => {
            if (!l) return false;
            try {
                const o = JSON.parse(l);
                return o.step_index === step && o.tool_calls && JSON.stringify(o.tool_calls).includes('admin.html');
            } catch(e) { return false; }
        });
        if (line) {
            const obj = JSON.parse(line);
            console.log(`\n==================================================`);
            console.log(`STEP INDEX: ${step}`);
            console.log(`==================================================`);
            obj.tool_calls.forEach(tc => {
                if (tc.name === 'replace_file_content' || tc.name === 'multi_replace_file_content') {
                    console.log("TOOL:", tc.name);
                    console.log(JSON.stringify(tc.args, null, 2));
                }
            });
        }
    });
} else {
    console.log("Log file not found");
}
