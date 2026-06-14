const fs = require('fs');
const path = require('path');

const adminPath = path.join(__dirname, '..', 'admin.html');
const content = fs.readFileSync(adminPath, 'utf8');
const lines = content.split('\n');

for (let i = 13959; i < 14089; i++) {
    console.log(`L${i + 1}: ${lines[i]}`);
}
