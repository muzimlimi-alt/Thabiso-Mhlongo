const fs = require('fs');
const path = require('path');

const logPath = 'C:\\Users\\muzim\\.gemini\\antigravity-ide\\brain\\9ef78ee4-c302-4a8e-9d7e-499b880f1fc1\\.system_generated\\logs\\transcript.jsonl';
const adminHtmlPath = path.join(__dirname, '../admin.html');

let html = fs.readFileSync(adminHtmlPath, 'utf8').replace(/\r\n/g, '\n');

if (fs.existsSync(logPath)) {
    const content = fs.readFileSync(logPath, 'utf8');
    const lines = content.split('\n');
    
    const steps = [89, 91, 95, 174];
    
    steps.forEach(stepNum => {
        const line = lines.find(l => {
            if (!l) return false;
            try {
                const o = JSON.parse(l);
                return o.step_index === stepNum && o.tool_calls && JSON.stringify(o.tool_calls).includes('admin.html');
            } catch(e) { return false; }
        });
        
        if (line) {
            console.log(`Processing step ${stepNum}...`);
            const obj = JSON.parse(line);
            obj.tool_calls.forEach(tc => {
                if (tc.name === 'replace_file_content') {
                    const args = tc.args;
                    let target = args.TargetContent;
                    let replacement = args.ReplacementContent;
                    
                    target = target.replace(/\r\n/g, '\n');
                    replacement = replacement.replace(/\r\n/g, '\n');
                    
                    if (html.includes(target)) {
                        html = html.replace(target, replacement);
                        console.log(`  replace_file_content success for step ${stepNum}`);
                    } else {
                        console.log(`  WARNING: TargetContent not found for step ${stepNum}`);
                    }
                } else if (tc.name === 'multi_replace_file_content') {
                    const args = tc.args;
                    let chunks = args.ReplacementChunks;
                    if (typeof chunks === 'string') {
                        // Escape raw newlines, carriage returns, and tabs before parsing double-serialized JSON
                        const sanitizedChunks = chunks
                            .replace(/\n/g, '\\n')
                            .replace(/\r/g, '\\r')
                            .replace(/\t/g, '\\t');
                        chunks = JSON.parse(sanitizedChunks);
                    }
                    
                    chunks.forEach((chunk, index) => {
                        let target = chunk.TargetContent;
                        let replacement = chunk.ReplacementContent;
                        
                        target = target.replace(/\r\n/g, '\n');
                        replacement = replacement.replace(/\r\n/g, '\n');
                        
                        if (html.includes(target)) {
                            html = html.replace(target, replacement);
                            console.log(`  multi_replace_file_content chunk ${index} success for step ${stepNum}`);
                        } else {
                            console.log(`  WARNING: chunk ${index} TargetContent not found for step ${stepNum}`);
                        }
                    });
                }
            });
        } else {
            console.log(`Step ${stepNum} not found in log`);
        }
    });
    
    // Save the restored html
    fs.writeFileSync(adminHtmlPath, html, 'utf8');
    console.log("Restored admin.html successfully!");
} else {
    console.log("Log file not found");
}
