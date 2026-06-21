const fs = require('fs');
const path = require('path');

const serverPath = path.join(__dirname, '../server.js');
const content = fs.readFileSync(serverPath, 'utf8');
const lines = content.split('\n');

console.log('Matches for wildcards/fallbacks in server.js:');
lines.forEach((line, index) => {
    if (line.includes("app.get('*") || line.includes('app.get("/*') || line.includes("app.use('*") || line.includes("res.sendFile") || line.includes("redirect('/error")) {
        console.log(`${index + 1}: ${line.trim()}`);
    }
});
