const fs = require('fs');
const path = require('path');

const adminPath = path.join(__dirname, '..', 'admin.html');
const content = fs.readFileSync(adminPath, 'utf8');
const lines = content.split('\n');

const lineNumbers = [7168, 10901, 11313, 13491, 14161];
lineNumbers.forEach(num => {
    console.log(`L${num}: ${lines[num - 1].trim()}`);
});
