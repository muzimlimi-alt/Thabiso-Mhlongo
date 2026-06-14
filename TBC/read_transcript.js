const fs = require('fs');
const path = require('path');

const logPath = 'C:\\Users\\muzim\\.gemini\\antigravity-ide\\brain\\9ef78ee4-c302-4a8e-9d7e-499b880f1fc1\\.system_generated\\logs\\transcript.jsonl';

if (fs.existsSync(logPath)) {
    console.log("Log file exists!");
    const content = fs.readFileSync(logPath, 'utf8');
    const lines = content.split('\n');
    console.log(`Log file has ${lines.length} lines`);
    
    let foundCount = 0;
    for (let i = 0; i < lines.length; i++) {
        if (!lines[i]) continue;
        try {
            const obj = JSON.parse(lines[i]);
            // Filter to steps before step 192 (previous session)
            if (obj.step_index < 192 && obj.tool_calls) {
                for (const call of obj.tool_calls) {
                    if (call.name === 'replace_file_content' || call.name === 'write_to_file' || call.name === 'multi_replace_file_content') {
                        if (JSON.stringify(call.args).includes('admin.html')) {
                            console.log(`\n--- Match ${++foundCount} at line ${i} (Step Index: ${obj.step_index}) ---`);
                            console.log("Tool:", call.name);
                            console.log("Args:", JSON.stringify(call.args).substring(0, 1000));
                        }
                    }
                }
            }
        } catch(e) {
            // ignore
        }
    }
} else {
    console.log("Log file does not exist at:", logPath);
}
