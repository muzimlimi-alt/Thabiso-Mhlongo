const fs = require('fs');
const path = require('path');

const adminHtmlPath = path.resolve(__dirname, '..', 'admin.html');
const content = fs.readFileSync(adminHtmlPath, 'utf8');

const regex = /<link[^>]*fonts\.googleapis\.com[^>]*>/gi;
let match;
while ((match = regex.exec(content)) !== null) {
    console.log(`Found Font Import:\n${match[0]}\n`);
}
