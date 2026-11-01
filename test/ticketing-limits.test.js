// Event ticketing rate limits (middleware/rate-limiters.js): reserving / starting a checkout is limited to 40 per 10 minutes per address and
// looking up an order / ticket / PDF to 120 per 10 minutes - enforced in production, off under NODE_ENV=test like every sibling limiter (the
// suite shares one address). The real limiters run in a child process (test/ticketing-limits.child.js) under each NODE_ENV.
const { spawn } = require('child_process');
const path = require('path');

function runChild(nodeEnv) {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [path.join(__dirname, 'ticketing-limits.child.js')], { cwd: path.join(__dirname, '..'), env: { ...process.env, NODE_ENV: nodeEnv } });
        let out = '';
        child.stdout.on('data', (d) => { out += d; });
        child.stderr.on('data', (d) => { out += d; });
        const timer = setTimeout(() => child.kill(), 90000);
        child.on('close', () => {
            clearTimeout(timer);
            const pick = (p) => { const l = out.split('\n').find((x) => x.startsWith(p)); return l ? JSON.parse(l.slice(p.length)) : null; };
            resolve({ reserve: pick('RESERVE:'), lookup: pick('LOOKUP:'), out });
        });
    });
}

module.exports = async function ({ check }) {
    const prod = await runChild('production');
    check('production: 40 ticket reservations / checkouts from one address pass (about 20 buyers sharing a network), the 41st and 42nd are refused (429)',
        !!prod.reserve && prod.reserve.length === 42 && prod.reserve.slice(0, 40).every((s) => s === 200) && prod.reserve.slice(40).every((s) => s === 429), prod.reserve ? JSON.stringify(prod.reserve) : prod.out.slice(-600));
    check('production: 120 order / ticket lookups pass (the return page polls), the 121st and 122nd are refused (429)',
        !!prod.lookup && prod.lookup.slice(0, 120).every((s) => s === 200) && prod.lookup.slice(120).every((s) => s === 429), prod.lookup ? JSON.stringify(prod.lookup.slice(115)) : prod.out.slice(-600));
    const test = await runChild('test');
    check('test mode: both ticketing limiters are off (the suite shares one address)',
        !!test.reserve && test.reserve.every((s) => s === 200) && !!test.lookup && test.lookup.every((s) => s === 200), test.out.slice(-300));
};
