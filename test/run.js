// Integration test runner: boot the app on an isolated DB copy, run every *.test.js against it,
// tear down, report, and exit non-zero on any failure. Run with `npm test`.
const fs = require('fs');
const path = require('path');
const support = require('./support');

async function main() {
    const files = fs.readdirSync(__dirname).filter(f => f.endsWith('.test.js')).sort();
    const results = [];
    const check = (name, pass, detail) => {
        results.push({ name, pass, detail });
        console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${pass ? '' : `\n          -> ${detail}`}`);
    };

    console.log('Booting app on isolated test DB...');
    await support.start();
    console.log('Ready.\n');

    try {
        for (const f of files) {
            console.log(`── ${f} ──`);
            const suite = require(path.join(__dirname, f));
            await suite({ check, ...support });
            console.log('');
        }
    } finally {
        await support.stop();
    }

    const failed = results.filter(r => !r.pass).length;
    console.log('='.repeat(72));
    console.log(`${results.length - failed}/${results.length} passed`);
    process.exit(failed ? 1 : 0);
}

main().catch(async (e) => {
    console.error('\nTEST RUN ERROR:', e.message);
    try {
        console.error('\n--- SERVER LOGS START ---');
        console.error(support.getChildLog());
        console.error('--- SERVER LOGS END ---');
    } catch (_) {}
    try { await support.stop(); } catch (_) {}
    process.exit(2);
});
