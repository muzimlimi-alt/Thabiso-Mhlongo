// scripts/dev-itn-forwarder.js - the local-development forwarder that lets PayFast's sandbox notification reach a site on this PC WITHOUT exposing the rest of it.
// What matters: exactly PayFast's request (a form POST to the webhook path) reaches the local site, byte for byte; EVERYTHING else is answered 404 and never
// reaches it (a tunnel to the whole local site would expose the admin login and customer pages); a failure is reported, never silent; and the payer's
// details never reach the log. The module opens no database, so it is safe to load here; its servers are in-process on ephemeral ports.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createForwarder, writeEnvLine, WEBHOOK_PATH, MAX_BODY_BYTES } = require('../scripts/dev-itn-forwarder');

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = (server) => new Promise((resolve) => server.close(() => resolve()));

module.exports = async function ({ check }) {
    // a stand-in for the local site: records everything it is sent, answers with a status we choose
    const seen = [];
    let upstreamStatus = 200;
    const site = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            seen.push({ method: req.method, url: req.url, type: req.headers['content-type'], xff: req.headers['x-forwarded-for'], body: Buffer.concat(chunks).toString() });
            res.writeHead(upstreamStatus, { 'Content-Type': 'text/plain' });
            res.end('site says hi');
        });
    });
    const sitePort = await listen(site);
    const logs = [];
    const forwarder = createForwarder({ target: `http://127.0.0.1:${sitePort}`, log: (l) => logs.push(l) });
    const fwdPort = await listen(forwarder);
    const base = `http://127.0.0.1:${fwdPort}`;
    const FORM = 'application/x-www-form-urlencoded';
    const itn = 'm_payment_id=100054_SCHED88&pf_payment_id=1234567&payment_status=COMPLETE&amount_gross=10350.00&email_address=payer.secret%40example.invalid&signature=abc';

    try {
        // ═══ PayFast's own request is forwarded exactly ═══
        const ok = await fetch(base + WEBHOOK_PATH, { method: 'POST', headers: { 'Content-Type': FORM, 'X-Forwarded-For': '197.97.145.144' }, body: itn });
        check('PayFast\'s request (form POST to the webhook path) reaches the site and the site\'s answer comes back', ok.status === 200 && (await ok.text()) === 'site says hi' && seen.length === 1, `${ok.status} seen=${seen.length}`);
        check('...method, path, content type and every byte of the body arrive unchanged (the signature is computed over them)', seen[0].method === 'POST' && seen[0].url === WEBHOOK_PATH && seen[0].type === FORM && seen[0].body === itn, JSON.stringify(seen[0]));
        check('...with PayFast\'s source address passed along', seen[0].xff === '197.97.145.144', seen[0].xff);

        seen.length = 0;
        await fetch(base + WEBHOOK_PATH + '?debug=1&x=y', { method: 'POST', headers: { 'Content-Type': FORM }, body: itn });
        check('a query string on the way in is dropped, not forwarded', seen.length === 1 && seen[0].url === WEBHOOK_PATH, JSON.stringify(seen));

        upstreamStatus = 500;
        seen.length = 0;
        const fail = await fetch(base + WEBHOOK_PATH, { method: 'POST', headers: { 'Content-Type': FORM }, body: itn });
        check('when the site answers an error, that error is passed back to PayFast as it is (not turned into a success)', fail.status === 500 && seen.length === 1, String(fail.status));
        upstreamStatus = 200;

        // ═══ everything else never reaches the site ═══
        seen.length = 0;
        const refused = [];
        const tryOne = async (label, url, init) => { const r = await fetch(base + url, init); refused.push([label, r.status]); };
        await tryOne('GET the webhook', WEBHOOK_PATH, {});
        await tryOne('HEAD the webhook', WEBHOOK_PATH, { method: 'HEAD' });
        await tryOne('PUT the webhook', WEBHOOK_PATH, { method: 'PUT', headers: { 'Content-Type': FORM }, body: itn });
        await tryOne('DELETE the webhook', WEBHOOK_PATH, { method: 'DELETE' });
        await tryOne('PATCH the webhook', WEBHOOK_PATH, { method: 'PATCH', headers: { 'Content-Type': FORM }, body: itn });
        for (const p of ['/', '/admin.html', '/index.html', '/api/admin/login', '/api/admin/bookings', '/api/public/bookings/lookup', '/api/public/booking-config', '/database.sqlite', '/.env',
            WEBHOOK_PATH + '/', WEBHOOK_PATH + '/..', WEBHOOK_PATH + '/../../admin/login', '/' + WEBHOOK_PATH, WEBHOOK_PATH.toUpperCase(), WEBHOOK_PATH + '%2F..%2Fadmin', '/x' + WEBHOOK_PATH]) {
            await tryOne('POST ' + p, p, { method: 'POST', headers: { 'Content-Type': FORM }, body: 'a=b' });
        }
        check('GET / HEAD / PUT / DELETE / PATCH of the webhook and POSTs to the site, the admin, the API, files and look-alike paths are all answered 404', refused.every(([, s]) => s === 404), JSON.stringify(refused.filter(([, s]) => s !== 404)));
        check('...and NONE of them reached the site', seen.length === 0, JSON.stringify(seen));

        for (const [label, type] of [['JSON', 'application/json'], ['plain text', 'text/plain'], ['multipart', 'multipart/form-data; boundary=x']]) {
            const r = await fetch(base + WEBHOOK_PATH, { method: 'POST', headers: { 'Content-Type': type }, body: itn });
            check(`a POST to the webhook that is not a form (${label}) is refused (404) and not forwarded`, r.status === 404 && seen.length === 0, String(r.status));
        }
        const noType = await new Promise((resolve) => {
            const r = http.request({ hostname: '127.0.0.1', port: fwdPort, path: WEBHOOK_PATH, method: 'POST' }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
            r.end(itn);
        });
        check('...and so is one with no content type at all', noType === 404 && seen.length === 0, String(noType));

        // ═══ limits ═══
        const big = await fetch(base + WEBHOOK_PATH, { method: 'POST', headers: { 'Content-Type': FORM }, body: 'x=' + 'a'.repeat(MAX_BODY_BYTES + 10) }).then((r) => r.status).catch(() => 'closed');
        check('an oversized body is refused (413 or the connection is cut) and never forwarded', (big === 413 || big === 'closed') && seen.length === 0, String(big));
        seen.length = 0;
        const justUnder = await fetch(base + WEBHOOK_PATH, { method: 'POST', headers: { 'Content-Type': FORM }, body: 'x=' + 'a'.repeat(MAX_BODY_BYTES - 10) });
        check('a body just under the limit is forwarded normally', justUnder.status === 200 && seen.length === 1, String(justUnder.status));

        // ═══ the log ═══
        check('the log says each notification was forwarded and what the site answered', logs.some((l) => /forwarded -> site answered 200/.test(l)) && logs.some((l) => /site answered 500/.test(l)), JSON.stringify(logs));
        check('...and never contains the payer\'s e-mail, the payment ids or the signature (the body is not logged)', !logs.some((l) => /payer\.secret|1234567|signature|100054/.test(l)), JSON.stringify(logs));

        // ═══ the site is not running ═══
        const dead = createForwarder({ target: 'http://127.0.0.1:1', log: (l) => logs.push(l) });
        const deadPort = await listen(dead);
        const down = await fetch(`http://127.0.0.1:${deadPort}${WEBHOOK_PATH}`, { method: 'POST', headers: { 'Content-Type': FORM }, body: itn });
        check('when the local site is not running PayFast gets 502 (so it knows delivery failed) - not a false success', down.status === 502, String(down.status));
        check('...and the log says plainly that the notification was NOT delivered and asks whether the site is running', logs.some((l) => /NOT delivered/.test(l) && /Is it running/.test(l)), JSON.stringify(logs.slice(-2)));
        await close(dead);
    } finally {
        await close(forwarder);
        await close(site);
    }

    // ═══ writing the tunnel address into .env ═══
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'itn-env-'));
    const envFile = path.join(dir, '.env');
    try {
        fs.writeFileSync(envFile, 'A=1\r\nPAYFAST_BASE_URL=http://localhost:3000\r\nB=two words\r\n');
        writeEnvLine(envFile, 'PAYFAST_NOTIFY_BASE_URL', 'https://abc.ngrok-free.app');
        check('a missing line is appended, every other line untouched, Windows line endings kept', fs.readFileSync(envFile, 'utf8') === 'A=1\r\nPAYFAST_BASE_URL=http://localhost:3000\r\nB=two words\r\nPAYFAST_NOTIFY_BASE_URL=https://abc.ngrok-free.app\r\n', JSON.stringify(fs.readFileSync(envFile, 'utf8')));
        writeEnvLine(envFile, 'PAYFAST_NOTIFY_BASE_URL', 'https://new.ngrok-free.app');
        const after = fs.readFileSync(envFile, 'utf8');
        check('an existing line is replaced in place - never duplicated, never anything else changed', (after.match(/PAYFAST_NOTIFY_BASE_URL/g) || []).length === 1 && after.includes('https://new.ngrok-free.app') && !after.includes('abc.ngrok') && after.startsWith('A=1\r\nPAYFAST_BASE_URL=http://localhost:3000\r\nB=two words\r\n'), JSON.stringify(after));
        fs.writeFileSync(envFile, 'A=1\nPAYFAST_NOTIFY_BASE_URL=https://old.example\nB=2\n');
        writeEnvLine(envFile, 'PAYFAST_NOTIFY_BASE_URL', 'https://abc.ngrok-free.app');
        check('Unix line endings are kept too', fs.readFileSync(envFile, 'utf8') === 'A=1\nPAYFAST_NOTIFY_BASE_URL=https://abc.ngrok-free.app\nB=2\n', JSON.stringify(fs.readFileSync(envFile, 'utf8')));
        fs.rmSync(envFile);
        writeEnvLine(envFile, 'PAYFAST_NOTIFY_BASE_URL', 'https://abc.ngrok-free.app');
        check('a missing .env file is created with just that line', fs.readFileSync(envFile, 'utf8') === 'PAYFAST_NOTIFY_BASE_URL=https://abc.ngrok-free.app\n', JSON.stringify(fs.readFileSync(envFile, 'utf8')));
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
};
