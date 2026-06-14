const fs = require('fs');
const path = require('path');

const adminPath = path.join(__dirname, '..', 'admin.html');
let content = fs.readFileSync(adminPath, 'utf8');

const replacements = [
    // 1. Database Sync & Security Badges
    {
        search: `background: rgba(76,175,80,0.1); border: 1px solid rgba(76,175,80,0.2);`,
        replace: `background: rgba(52,211,153,0.1); border: 1px solid rgba(52,211,153,0.2);`
    },
    {
        search: `color: #4CAF50; font-size: 11px; font-weight: bold; background: rgba(76,175,80,0.1);`,
        replace: `color: var(--atl-green); font-size: 11px; font-weight: bold; background: rgba(52,211,153,0.15);`
    },
    {
        search: `background: rgba(255,152,0,0.1); border: 1px solid rgba(255,152,0,0.2);`,
        replace: `background: rgba(251,146,60,0.1); border: 1px solid rgba(251,146,60,0.2);`
    },
    {
        search: `color: #FF9800; font-size: 11px; font-weight: bold; background: rgba(255,152,0,0.1);`,
        replace: `color: var(--atl-orange); font-size: 11px; font-weight: bold; background: rgba(251,146,60,0.15);`
    },
    // 2. Audit filter border-colors
    {
        search: `id="auditTableFilter" class="form-control" style="width:auto;background: var(--atl-card);color: var(--atl-ink);border-color:#333;`,
        replace: `id="auditTableFilter" class="form-control" style="width:auto;background: var(--atl-card);color: var(--atl-ink);border-color:var(--atl-line);`
    },
    {
        search: `id="auditDateFrom" class="form-control" style="width:auto;background: var(--atl-card);color: var(--atl-ink);border-color:#333;`,
        replace: `id="auditDateFrom" class="form-control" style="width:auto;background: var(--atl-card);color: var(--atl-ink);border-color:var(--atl-line);`
    },
    {
        search: `id="auditDateTo" class="form-control" style="width:auto;background: var(--atl-card);color: var(--atl-ink);border-color:#333;`,
        replace: `id="auditDateTo" class="form-control" style="width:auto;background: var(--atl-card);color: var(--atl-ink);border-color:var(--atl-line);`
    },
    // 3. Status column badges in tables (Active / Inactive)
    {
        search: `background:rgba(76,175,80,0.15);color:#4CAF50;`,
        replace: `background:rgba(52,211,153,0.15);color:var(--atl-green);`
    },
    {
        search: `background:rgba(244,67,54,0.15);color:#F44336;`,
        replace: `background:rgba(248,113,113,0.15);color:var(--atl-clay);`
    },
    {
        search: `background:rgba(255,152,0,0.15);color:#ff9800;`,
        replace: `background:rgba(251,146,60,0.15);color:var(--atl-orange);`
    },
    {
        search: `background:rgba(136,136,136,0.15);color:#888;`,
        replace: `background:rgba(148,148,148,0.15);color:var(--atl-muted);`
    },
    // 4. Login Card Background & Border (replacing legacy references)
    {
        search: `background: #121210; padding: 40px; border: 1px solid var(--tm-gold);`,
        replace: `background: var(--atl-card); padding: 40px; border: 1px solid var(--atl-amber-border);`
    },
    // 5. Modal Footer border
    {
        search: `border-top:1px solid #1e1e1e;padding:14px 20px;display:flex;justify-content:flex-end;gap:10px;`,
        replace: `border-top:1px solid var(--atl-line);padding:14px 20px;display:flex;justify-content:flex-end;gap:10px;background:var(--atl-topbar-bg);`
    },
    // 6. Double-check generic table backgrounds in newsletter campaigns list
    {
        search: `style="background:rgba(255,255,255,0.03);border:1px solid #252525;`,
        replace: `style="background:var(--atl-card);border:1px solid var(--atl-line);`
    },
    {
        search: `style="border-bottom:1px solid #252525;"`,
        replace: `style="border-bottom:1px solid var(--atl-line);"`
    }
];

let replacedCount = 0;
let details = [];

replacements.forEach((rep, index) => {
    if (content.includes(rep.search)) {
        const occurrences = content.split(rep.search).length - 1;
        content = content.split(rep.search).join(rep.replace);
        replacedCount += occurrences;
        details.push(`- Success: Replaced "${rep.search.substring(0, 50)}..." with "${rep.replace.substring(0, 50)}..." (${occurrences} occurrences)`);
    } else {
        details.push(`- Warning: Target not found: "${rep.search.substring(0, 50)}..."`);
    }
});

fs.writeFileSync(adminPath, content, 'utf8');
console.log(`Successfully completed second-pass refactoring! Replaced ${replacedCount} elements in total.\n`);
console.log(details.join('\n'));
