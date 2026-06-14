const fs = require('fs');
const path = require('path');

const adminHtml = fs.readFileSync(path.join(__dirname, '../admin.html'), 'utf8');
const redesignCss = fs.readFileSync(path.join(__dirname, '../css/redesign.css'), 'utf8');

console.log("atl-section-hd in admin.html:", adminHtml.includes('atl-section-hd'));
console.log("atl-section-hd in redesign.css:", redesignCss.includes('atl-section-hd'));
console.log("atl-section-rule in admin.html:", adminHtml.includes('atl-section-rule'));
console.log("atl-section-rule in redesign.css:", redesignCss.includes('atl-section-rule'));
