const fs = require('fs');
const path = require('path');

const adminPath = path.join(__dirname, '..', 'admin.html');
let content = fs.readFileSync(adminPath, 'utf8');

const replacements = [
    // Red/Clay Replacements
    { search: `color:#ef5350;`, replace: `color:var(--atl-clay);` },
    { search: `color: #ef5350;`, replace: `color: var(--atl-clay);` },
    { search: `color:'#ef5350'`, replace: `color:'var(--atl-clay)'` },
    { search: `color: '#ef5350'`, replace: `color: 'var(--atl-clay)'` },
    { search: `color:"#ef5350"`, replace: `color:"var(--atl-clay)"` },
    { search: `color: "#ef5350"`, replace: `color: "var(--atl-clay)"` },
    { search: `background:rgba(239,83,80,0.2);`, replace: `background:rgba(248,113,113,0.15);` },
    { search: `background:rgba(239,83,80,0.15);`, replace: `background:rgba(248,113,113,0.15);` },
    { search: `border:1px solid rgba(239,83,80,0.3);`, replace: `border:1px solid rgba(248,113,113,0.3);` },
    { search: `border:1px solid rgba(239,83,80,0.4);`, replace: `border:1px solid rgba(248,113,113,0.3);` },
    { search: `border:1px solid rgba(244,67,54,0.3);`, replace: `border:1px solid rgba(248,113,113,0.3);` },
    { search: `border:1px solid rgba(244,67,54,0.5);`, replace: `border:1px solid rgba(248,113,113,0.3);` },
    { search: `border:1px solid #ef5350;`, replace: `border:1px solid var(--atl-clay);` },
    { search: `border:1px solid #ef5350`, replace: `border:1px solid var(--atl-clay)` },
    { search: `color:#F44336`, replace: `color:var(--atl-clay)` },
    { search: `color:'#F44336'`, replace: `color:'var(--atl-clay)'` },
    { search: `color: '#F44336'`, replace: `color: 'var(--atl-clay)'` },
    { search: `color:"#F44336"`, replace: `color:"var(--atl-clay)"` },
    { search: `color: "#F44336"`, replace: `color: "var(--atl-clay)"` },
    { search: `background:rgba(244,67,54,0.2);`, replace: `background:rgba(248,113,113,0.15);` },
    { search: `background:rgba(244,67,54,0.1);`, replace: `background:rgba(248,113,113,0.10);` },
    
    // Green/Sage/Google Calendar Replacements
    { search: `color:#4CAF50;`, replace: `color:var(--atl-green);` },
    { search: `color: #4CAF50;`, replace: `color: var(--atl-green);` },
    { search: `color:'#4CAF50'`, replace: `color:'var(--atl-green)'` },
    { search: `color: '#4CAF50'`, replace: `color: 'var(--atl-green)'` },
    { search: `color:"#4CAF50"`, replace: `color:"var(--atl-green)"` },
    { search: `color: "#4CAF50"`, replace: `color: "var(--atl-green)"` },
    { search: `color:#4CAF50`, replace: `color:var(--atl-green)` },
    { search: `background:rgba(76,175,80,0.2);`, replace: `background:rgba(52,211,153,0.15);` },
    { search: `background:rgba(76,175,80,0.1);`, replace: `background:rgba(52,211,153,0.10);` },
    { search: `border:1px solid rgba(76,175,80,0.4);`, replace: `border:1px solid rgba(52,211,153,0.3);` },
    { search: `border:1px solid rgba(76,175,80,0.3);`, replace: `border:1px solid rgba(52,211,153,0.3);` },

    // Orange Replacements
    { search: `color:#FF9800;`, replace: `color:var(--atl-orange);` },
    { search: `color: #FF9800;`, replace: `color: var(--atl-orange);` },
    { search: `color:'#FF9800'`, replace: `color:'var(--atl-orange)'` },
    { search: `color: '#FF9800'`, replace: `color: 'var(--atl-orange)'` },
    { search: `color:"#FF9800"`, replace: `color:"var(--atl-orange)"` },
    { search: `color: "#FF9800"`, replace: `color: "var(--atl-orange)"` },
    { search: `border-color:#FF9800;`, replace: `border-color:var(--atl-orange);` },
    { search: `background:rgba(255,152,0,0.2);`, replace: `background:rgba(251,146,60,0.15);` },
    { search: `background:rgba(255,152,0,0.1);`, replace: `background:rgba(251,146,60,0.10);` },
    
    // Gold/Amber Button Replacements
    { search: `background:#D4AF37;color:#111;`, replace: `background:var(--atl-amber);color:var(--atl-on-amber);` },
    { search: `background:#D4AF37; color:#111;`, replace: `background:var(--atl-amber);color:var(--atl-on-amber);` },
    { search: `background: #D4AF37; color: #111;`, replace: `background:var(--atl-amber);color:var(--atl-on-amber);` },
    { search: `background:#D4AF37;`, replace: `background:var(--atl-amber);` },
    { search: `borderColor = '#D4AF37';`, replace: `borderColor = 'var(--atl-amber)';` },
    { search: `zone.style.borderColor = '#D4AF37';`, replace: `zone.style.borderColor = 'var(--atl-amber)';` },
    
    // Grey and Miscellaneous
    { search: `border:2px dashed #333;`, replace: `border:2px dashed var(--atl-line-strong);` },
    { search: `border:1px solid #333;`, replace: `border:1px solid var(--atl-line);` },
    { search: `border: 1px solid #333;`, replace: `border: 1px solid var(--atl-line);` },
    { search: `border:1px solid var(--tm-gold);`, replace: `border:1px solid var(--atl-amber-border);` },
    { search: `border-color:#333;`, replace: `border-color:var(--atl-line);` },
    
    // Category colors
    { search: `mileage: '#2196F3', airfare: '#9C27B0', accommodation: '#FF9800',`, replace: `mileage: 'var(--atl-blue)', airfare: 'var(--atl-purple)', accommodation: 'var(--atl-orange)',` },
    { search: `meals: '#4CAF50', per_diem: '#00BCD4', parking_tolls: '#795548',`, replace: `meals: 'var(--atl-sage)', per_diem: 'var(--atl-blue)', parking_tolls: 'var(--atl-muted-dim)',` },

    // Modal PDF icon and Signature
    { search: `style="color:#ef5350;margin-right:8px;"`, replace: `style="color:var(--atl-clay);margin-right:8px;"` },
    { search: `style="margin-right:6px;color:#4CAF50;"`, replace: `style="margin-right:6px;color:var(--atl-sage);"` },

    // Cancel modal footer button background
    {
        search: `style="background:rgba(244,67,54,0.2);color:#ef5350;border:1px solid rgba(244,67,54,0.5);"`,
        replace: `style="background:rgba(248,113,113,0.15);color:var(--atl-clay);border:1px solid rgba(248,113,113,0.3);"`
    },
    // Contract confirm sign button
    {
        search: `style="background:rgba(76,175,80,0.2);color:#4CAF50;border:1px solid rgba(76,175,80,0.4);"`,
        replace: `style="background:rgba(52,211,153,0.15);color:var(--atl-green);border:1px solid rgba(52,211,153,0.3);"`
    },
    // Expense Save button linear-gradient
    {
        search: `style="background:linear-gradient(135deg,#ef5350,#b71c1c);color: var(--atl-ink);border:none;border-radius:6px;font-size:12px;font-weight:700;white-space:nowrap;cursor:pointer;"`,
        replace: `class="atl-btn atl-btn--danger-solid" style="font-size:12px;white-space:nowrap;padding:8px 18px;"`
    },
    // View booking button (L14141)
    {
        search: `class="btn btn-xs" style="background:#D4AF37;color:#111;border:none;font-weight:700;"`,
        replace: `class="atl-btn atl-btn--primary" style="padding:4px 8px;font-size:11px;"`
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
    } else {
        // Log it as warning only if it's not a common variant that may have already been replaced
        details.push(`- Skip: Target not found "${rep.search.substring(0, 40)}..."`);
    }
});

fs.writeFileSync(adminPath, content, 'utf8');
console.log(`Successfully refactored remaining hexes! Replaced ${replacedCount} elements in total.\n`);
console.log(details.join('\n'));
