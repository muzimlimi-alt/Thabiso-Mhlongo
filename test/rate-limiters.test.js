// The tracking limiter allows 10 lookups per 15 minutes per address. In production that is real protection (it stops anyone walking through
// booking ids), so it stays. Under NODE_ENV=test it has to be OFF like every other limiter in middleware/rate-limiters.js: all test files share
// ONE server and ONE address, and a full run makes more than 10 tracking / quote-download calls. The 11th was answered 429, which crashed
// service-visibility.test.js with "Cannot read properties of undefined" and silently skipped every test file after it.
// The real limiter runs in a child process (test/rate-limiters.child.js) under each NODE_ENV; nothing but the limiter module is loaded.
const { spawn } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function runChild(nodeEnv) {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [path.join(__dirname, 'rate-limiters.child.js')], { cwd: ROOT, env: { ...process.env, NODE_ENV: nodeEnv } });
        let out = '';
        child.stdout.on('data', (d) => { out += d; });
        child.stderr.on('data', (d) => { out += d; });
        const timer = setTimeout(() => child.kill(), 60000);
        child.on('close', () => {
            clearTimeout(timer);
            const line = out.split('\n').find((l) => l.startsWith('STATUSES:'));
            const popLine = out.split('\n').find((l) => l.startsWith('POP_STATUSES:'));
            resolve({ statuses: line ? JSON.parse(line.slice(9)) : null, pop: popLine ? JSON.parse(popLine.slice(13)) : null, out });
        });
    });
}

module.exports = async function ({ check }) {
    const prod = await runChild('production');
    check('production: the first 10 tracking lookups from one address pass and the 11th and 12th are refused (429)',
        !!prod.statuses && prod.statuses.slice(0, 10).every((s) => s === 200) && prod.statuses.slice(10).every((s) => s === 429), prod.statuses ? JSON.stringify(prod.statuses) : prod.out.slice(-800));

    check('production: proof-of-payment uploads are limited too - the first 10 from one address pass, the 11th and 12th are refused (429)',
        !!prod.pop && prod.pop.slice(0, 10).every((s) => s === 200) && prod.pop.slice(10).every((s) => s === 429), prod.pop ? JSON.stringify(prod.pop) : prod.out.slice(-800));

    const test = await runChild('test');
    check('test mode: the tracking limiter is switched off - 12 lookups from one address all pass (the suite shares one address)',
        !!test.statuses && test.statuses.length === 12 && test.statuses.every((s) => s === 200), test.statuses ? JSON.stringify(test.statuses) : test.out.slice(-800));
    check('test mode: the upload limiter is off as well (the suite shares one address; the per-booking caps are enforced in the database)',
        !!test.pop && test.pop.length === 12 && test.pop.every((s) => s === 200), test.pop ? JSON.stringify(test.pop) : test.out.slice(-800));
};
