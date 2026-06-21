const fs = require('fs');
const path = require('path');

const adminPath = path.join(__dirname, '..', 'admin.html');
let content = fs.readFileSync(adminPath, 'utf8');

const replacements = [
    // 1. Exact Border Replacements
    { search: `border:1px solid #333`, replace: `border:1px solid var(--atl-line)` },
    { search: `border: 1px solid #333`, replace: `border: 1px solid var(--atl-line)` },
    { search: `border-color:#333`, replace: `border-color:var(--atl-line)` },
    { search: `border-color: #333`, replace: `border-color: var(--atl-line)` },
    { search: `border-top:1px solid #333`, replace: `border-top:1px solid var(--atl-line)` },
    { search: `border-top: 1px solid #333`, replace: `border-top: 1px solid var(--atl-line)` },
    { search: `border-bottom:1px solid #333`, replace: `border-bottom:1px solid var(--atl-line)` },
    { search: `border-bottom: 1px solid #333`, replace: `border-bottom: 1px solid var(--atl-line)` },
    { search: `border:2px dashed #333`, replace: `border:2px dashed var(--atl-line-strong)` },
    { search: `border: 1px dashed #333`, replace: `border: 1px dashed var(--atl-line-strong)` },
    
    // 2. Other solid grey borders
    { search: `border:1px solid #444`, replace: `border:1px solid var(--atl-line-strong)` },
    { search: `border:1px solid #555`, replace: `border:1px solid var(--atl-line-strong)` },
    { search: `border: 1px solid #555`, replace: `border: 1px solid var(--atl-line-strong)` },
    { search: `border-right:1px solid #222`, replace: `border-right:1px solid var(--atl-line)` },
    { search: `border:1px solid #1e1e1e`, replace: `border:1px solid var(--atl-line)` },
    { search: `border-top:1px solid #1e1e1e`, replace: `border-top:1px solid var(--atl-line)` },
    { search: `border-bottom:1px solid #1e1e1e`, replace: `border-bottom:1px solid var(--atl-line)` },

    // 3. Modals and elements using #222 backgrounds and #333 borders
    {
        search: `qlToolbar.style.background = '#222'; qlToolbar.style.borderColor = '#333';`,
        replace: `qlToolbar.style.background = 'var(--atl-surface2)'; qlToolbar.style.borderColor = 'var(--atl-line)';`
    },
    {
        search: `style="background:#222; padding:15px; border-radius:6px; border:1px solid #333;"`,
        replace: `style="background:var(--atl-surface2); padding:15px; border-radius:6px; border:1px solid var(--atl-line);"`
    },
    {
        search: `required style="background:#222; color: var(--atl-ink); border:#333; color-scheme: dark;"`,
        replace: `required style="background:var(--atl-input-bg); color: var(--atl-ink); border:1px solid var(--atl-line); color-scheme: dark;"`
    },
    {
        search: `required style="background:#222; color: var(--atl-ink); border:#333;"`,
        replace: `required style="background:var(--atl-input-bg); color: var(--atl-ink); border:1px solid var(--atl-line);"`
    },
    {
        search: `style="background:#222; color: var(--atl-ink); border:#333;"`,
        replace: `style="background:var(--atl-input-bg); color: var(--atl-ink); border:1px solid var(--atl-line);"`
    },
    {
        search: `style="background:transparent; color:#aaa; border:1px solid #333;"`,
        replace: `style="background:transparent; color:var(--atl-muted); border:1px solid var(--atl-line);"`
    },
    {
        search: `background: var(--atl-card); border: 1px solid #333; color: var(--atl-amber);`,
        replace: `background: var(--atl-card); border: 1px solid var(--atl-line); color: var(--atl-amber);`
    },
    {
        search: `background: var(--atl-card); border: 1px solid #333; color: var(--atl-amber);`,
        replace: `background: var(--atl-card); border: 1px solid var(--atl-line); color: var(--atl-amber);`
    },
    {
        search: `border-color: #333 !important;`,
        replace: `border-color: var(--atl-line) !important;`
    },
    {
        search: `border-bottom: 1px dashed #333;`,
        replace: `border-bottom: 1px dashed var(--atl-line);`
    },
    {
        search: `border:1px solid #333;padding:18px 20px;`,
        replace: `border:1px solid var(--atl-line);padding:18px 20px;`
    },
    {
        search: `progress style="background:#333; height:6px;`,
        replace: `progress style="background:var(--atl-surface2); height:6px;`
    }
];

let replacedCount = 0;
let details = [];

replacements.forEach(rep => {
    if (content.includes(rep.search)) {
        const occurrences = content.split(rep.search).length - 1;
        content = content.split(rep.search).join(rep.replace);
        replacedCount += occurrences;
        details.push(`- Success: Replaced "${rep.search}" with "${rep.replace}" (${occurrences} occurrences)`);
    }
});

fs.writeFileSync(adminPath, content, 'utf8');
console.log(`Border color refactoring complete! Replaced ${replacedCount} elements.`);
console.log(details.join('\n'));
