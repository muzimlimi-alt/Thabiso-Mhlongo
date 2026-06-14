const fs = require('fs');
const path = require('path');

const adminPath = path.join(__dirname, '..', 'admin.html');
const content = fs.readFileSync(adminPath, 'utf8');
const lines = content.split('\n');

const searchTerms = [
    'auditTableFilter',
    'auditDateFrom',
    'gdprDeleteEmail',
    'Database Sync',
    'Session Expiry',
    'campaigns',
    'financeAdmin',
    'is_active',
    'login-card-wrapped',
    'modal-footer'
];

searchTerms.forEach(term => {
    console.log(`\n=== Matches for "${term}" ===`);
    lines.forEach((line, idx) => {
        if (line.includes(term)) {
            console.log(`  L${idx + 1}: ${line.trim()}`);
        }
    });
});
