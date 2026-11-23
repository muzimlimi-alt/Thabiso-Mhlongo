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
            // A few files (ozow.test.js) are written against node:test and run themselves on require, exporting nothing. Requiring one
            // has already run it by this point; calling it would throw and, before this guard, took the whole run down with it - every
            // file after it in the alphabet was silently never run.
            if (typeof suite !== 'function') { console.log('  (self-running node:test file - results above)'); continue; }
            // One file that throws must not take the run down with it: a check that reads, say, rows[0].status after an earlier check
            // already failed and left rows empty used to abort everything, so every file after it in the alphabet went unreported and
            // the run printed server logs instead of a pass count. Record it as a failure of that file and carry on.
            try {
                await suite({ check, ...support });
            } catch (e) {
                check(`${f} threw part-way through (the checks after the throw did not run)`, false, (e && e.stack) || String(e));
            }
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
