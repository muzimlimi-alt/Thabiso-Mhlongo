const fs = require('fs');
const path = require('path');

const scriptPath = path.join(__dirname, '..', 'js', 'myscript.js');
if (fs.existsSync(scriptPath)) {
    const content = fs.readFileSync(scriptPath, 'utf8');
    const lines = content.split('\n');
    console.log("=== SCANNING js/myscript.js ===");
    lines.forEach((line, index) => {
        if (line.includes('href="#') || line.includes('click') || line.includes('scroll')) {
            console.log(`L${index + 1}: ${line.trim()}`);
        }
    });
} else {
    console.log("js/myscript.js does not exist!");
}
