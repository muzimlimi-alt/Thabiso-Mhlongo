const fs = require('fs');
const path = require('path');

const adminPath = path.join(__dirname, '..', 'admin.html');
let content = fs.readFileSync(adminPath, 'utf8');

const replacements = [
    {
        search: `border-color:#333;font-size:12px;`,
        replace: `border-color:var(--atl-line);font-size:12px;`
    }
];

let replacedCount = 0;
replacements.forEach(rep => {
    if (content.includes(rep.search)) {
        const occurrences = content.split(rep.search).length - 1;
        content = content.split(rep.search).join(rep.replace);
        replacedCount += occurrences;
        console.log(`Replaced ${occurrences} occurrences of "${rep.search}"`);
    } else {
        console.log(`Target not found: "${rep.search}"`);
    }
});

fs.writeFileSync(adminPath, content, 'utf8');
console.log(`Completed final corrections!`);
