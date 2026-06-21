const fs = require('fs');
const path = require('path');

const adminPath = path.join(__dirname, '..', 'admin.html');
let content = fs.readFileSync(adminPath, 'utf8');

const replacements = [
    {
        search: `: '#ff9800';`,
        replace: `: 'var(--atl-orange)';`
    },
    {
        search: `border:1px solid #FF9800;`,
        replace: `border:1px solid var(--atl-orange);`
    },
    {
        search: `style="background:linear-gradient(135deg,#ef5350,#b71c1c);color: var(--atl-ink);border:none;border-radius:6px;font-weight:600;"`,
        replace: `class="atl-btn atl-btn--danger-solid" style="padding: 8px 18px;"`
    },
    {
        search: `style="flex:1;background:#17a2b8;color: var(--atl-ink);border:none;border-radius:6px;padding:7px;font-size:12px;font-weight:700;cursor:pointer;"`,
        replace: `style="flex:1;background:var(--atl-amber);color:var(--atl-on-amber);border:none;border-radius:6px;padding:7px;font-size:12px;font-weight:700;cursor:pointer;"`
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
        console.log(`Skip: Target not found "${rep.search}"`);
    }
});

fs.writeFileSync(adminPath, content, 'utf8');
console.log(`Completed refactoring! Replaced ${replacedCount} elements.`);
