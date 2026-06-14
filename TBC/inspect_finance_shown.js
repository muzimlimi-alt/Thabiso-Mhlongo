const fs = require('fs');
const path = require('path');

const adminPath = path.join(__dirname, '..', 'admin.html');
const content = fs.readFileSync(adminPath, 'utf8');
const lines = content.split('\n');

for (let i = 16170; i < 16205; i++) {
    console.log(`L${i + 1}: ${lines[i]}`);
}
