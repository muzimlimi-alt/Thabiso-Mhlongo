// Runs every browser test in sequence (each boots and stops its own isolated server).
// Usage: npm run test:browser
const { spawnSync } = require('child_process');
const path = require('path');
const files = ['slots.js', 'calendar.js', 'date-status.js', 'form.js', 'public-sections.js', 'admin-venue-autocomplete.js', 'accolades.js'];
let failed = 0;
for (const f of files) {
    console.log('\nâ•â•â•â•â•â• ' + f + ' â•â•â•â•â•â•');
    const r = spawnSync(process.execPath, [path.join(__dirname, f)], { stdio: 'inherit' });
    if (r.status !== 0) failed++;
}
console.log(failed ? '\n' + failed + ' browser test file(s) FAILED' : '\nAll browser tests passed');
process.exit(failed ? 1 : 0);
