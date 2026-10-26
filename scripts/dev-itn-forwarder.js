// Local-development helper: lets PayFast's SANDBOX notification (the ITN) reach a site running on this PC, without exposing the rest of it.
//
// Why: after a buyer pays, PayFast tells the website (a server-to-server POST to notify_url) that the money arrived; that is what marks the booking paid.
// PayFast's servers cannot reach http://localhost:3000, so on a local run the buyer sees "payment successful" at PayFast and the booking stays UNPAID.
//
// This script runs a tiny forwarder that accepts ONE thing - PayFast's form POST to /api/payment/webhook/payfast - and hands it to the local site;
// every other request (the site, the admin, the customer pages, any API) is answered 404 here and never reaches the site. It then opens an ngrok
// tunnel to the forwarder only. Put the tunnel's address in PAYFAST_NOTIFY_BASE_URL (that overrides the notification URL alone; the buyer's return
// and cancel pages keep using PAYFAST_BASE_URL = http://localhost:3000, which the buyer's own browser can reach). docs-internal/payfast.md.
//
//   node scripts/dev-itn-forwarder.js                 start the forwarder + ngrok, print the line to add to .env
//   node scripts/dev-itn-forwarder.js --write-env     ...and write PAYFAST_NOTIFY_BASE_URL into .env for you (then restart the site)
//   node scripts/dev-itn-forwarder.js --no-ngrok      forwarder only (you run your own tunnel to --port)
//   options: --port 3001   --target http://127.0.0.1:3000
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const WEBHOOK_PATH = '/api/payment/webhook/payfast';
const MAX_BODY_BYTES = 64 * 1024;          // an ITN is a few hundred bytes of form fields
const UPSTREAM_TIMEOUT_MS = 20000;

// target: where the local site listens. log(line): receives one line per forwarded notification (never its body - it carries the payer's e-mail).
function createForwarder({ target = 'http://127.0.0.1:3000', log = () => {} } = {}) {
    const t = new URL(target);
    return http.createServer((req, res) => {
        const pathOnly = String(req.url || '').split('?')[0];
        const type = String(req.headers['content-type'] || '').toLowerCase();
        // exactly PayFast's request: POST, this path, a form body. Anything else is "not found" - no hint that a site is behind this.
        if (req.method !== 'POST' || pathOnly !== WEBHOOK_PATH || !type.startsWith('application/x-www-form-urlencoded')) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            return res.end('Not found');
        }
        const chunks = [];
        let size = 0;
        let refused = false;
        req.on('data', (c) => {
            if (refused) return;
            size += c.length;
            if (size > MAX_BODY_BYTES) { refused = true; res.writeHead(413, { 'Content-Type': 'text/plain' }); res.end('Too large'); req.destroy(); return; }
            chunks.push(c);
        });
        req.on('end', () => {
            if (refused) return;
            const body = Buffer.concat(chunks);
            const started = Date.now();
            const up = http.request({
                hostname: t.hostname, port: t.port, path: WEBHOOK_PATH, method: 'POST', timeout: UPSTREAM_TIMEOUT_MS,
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': body.length,
                    'User-Agent': req.headers['user-agent'] || 'dev-itn-forwarder',
                    'X-Forwarded-For': req.headers['x-forwarded-for'] || req.socket.remoteAddress || ''
                }
            }, (ur) => {
                const out = [];
                ur.on('data', (c) => out.push(c));
                ur.on('end', () => {
                    log(`PayFast notification forwarded -> site answered ${ur.statusCode} (${Date.now() - started} ms)`);
                    res.writeHead(ur.statusCode || 502, { 'Content-Type': ur.headers['content-type'] || 'text/plain' });
                    res.end(Buffer.concat(out));
                });
            });
            up.on('timeout', () => up.destroy(new Error('the site did not answer in time')));
            up.on('error', (e) => {
                log(`PayFast notification NOT delivered - the local site did not answer (${e.message}). Is it running on ${target}?`);
                if (!res.headersSent) { res.writeHead(502, { 'Content-Type': 'text/plain' }); res.end('Local site unavailable'); }
            });
            up.end(body);
        });
        req.on('error', () => { /* the sender went away */ });
    });
}

// ---- command line ----
function arg(name, fallback) {
    const i = process.argv.indexOf(name);
    return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
}
const has = (name) => process.argv.includes(name);

function findNgrok() {
    for (const p of [process.env.NGROK_PATH, 'C:\\ngrok\\ngrok.exe']) if (p && fs.existsSync(p)) return p;
    return 'ngrok';   // on PATH
}

async function publicUrlFromNgrok(deadlineMs = 30000) {
    const end = Date.now() + deadlineMs;
    while (Date.now() < end) {
        try {
            const r = await fetch('http://127.0.0.1:4040/api/tunnels');
            const j = await r.json();
            const https = (j.tunnels || []).find((x) => /^https:/.test(x.public_url));
            if (https) return https.public_url;
        } catch (e) { /* not up yet */ }
        await new Promise((r) => setTimeout(r, 500));
    }
    return null;
}

// Replaces (or appends) one KEY=value line in the project's .env, keeping its line endings. Never prints other lines.
function writeEnvLine(envPath, key, value) {
    const raw = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
    const eol = raw.includes('\r\n') ? '\r\n' : '\n';
    const lines = raw.split(/\r?\n/);
    const re = new RegExp('^\\s*' + key + '\\s*=');
    let done = false;
    const out = lines.map((l) => (re.test(l) ? (done = true, `${key}=${value}`) : l));
    if (!done) { while (out.length && out[out.length - 1] === '') out.pop(); out.push(`${key}=${value}`, ''); }
    fs.writeFileSync(envPath, out.join(eol));
}

async function main() {
    const port = parseInt(arg('--port', '3001'), 10);
    const target = arg('--target', 'http://127.0.0.1:3000');
    const server = createForwarder({ target, log: (l) => console.log(`[${new Date().toTimeString().slice(0, 8)}] ${l}`) });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
    console.log(`Forwarder listening on 127.0.0.1:${port}; it passes ONLY POST ${WEBHOOK_PATH} to ${target} and answers 404 to everything else.`);
    if (has('--no-ngrok')) { console.log(`Point your own tunnel at port ${port}, then set PAYFAST_NOTIFY_BASE_URL to its https address.`); return; }

    const ngrok = spawn(findNgrok(), ['http', String(port), '--log=stdout'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let ngrokOutput = '';
    ngrok.stdout.on('data', (d) => { ngrokOutput += d; });
    ngrok.stderr.on('data', (d) => { ngrokOutput += d; });
    ngrok.on('error', (e) => { console.error('Could not start ngrok: ' + e.message); process.exit(1); });
    ngrok.on('exit', (code) => { if (code) { console.error(`ngrok stopped (exit ${code}). Output:\n${ngrokOutput.slice(-600)}`); process.exit(1); } });
    const shutdown = () => { try { ngrok.kill(); } catch (e) {} process.exit(0); };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    const url = await publicUrlFromNgrok();
    if (!url) { console.error('ngrok did not report a public address within 30 seconds.\n' + ngrokOutput.slice(-600)); shutdown(); return; }
    console.log(`\nTunnel up: ${url}  ->  forwarder  ->  ${target}${WEBHOOK_PATH}  (nothing else)`);
    console.log(`\nSet this in the local .env, then restart the site:\n\n    PAYFAST_NOTIFY_BASE_URL=${url}\n`);
    if (has('--write-env')) {
        writeEnvLine(path.join(__dirname, '..', '.env'), 'PAYFAST_NOTIFY_BASE_URL', url);
        console.log('Written to .env (only that one line was touched). Restart the site to pick it up.');
    }
    console.log('Leave this window open while you test; closing it closes the tunnel. The address changes each time it starts.');
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });

module.exports = { createForwarder, writeEnvLine, WEBHOOK_PATH, MAX_BODY_BYTES };
