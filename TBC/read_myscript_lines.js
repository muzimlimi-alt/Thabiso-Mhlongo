const fs = require('fs');
const path = require('path');

const scriptPath = path.join(__dirname, '..', 'js', 'myscript.js');
if (fs.existsSync(scriptPath)) {
    const content = fs.readFileSync(scriptPath, 'utf8');
    const lines = content.split('\n');
    console.log("=== js/myscript.js lines 2510 to 2550 ===");
    for (let i = 2510; i < 2550; i++) {
        if (lines[i]) console.log(`${i + 1}: ${lines[i]}`);
    }
}
