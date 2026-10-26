// A small fake SMTP server for the e-mail transport tests: speaks EHLO / STARTTLS / AUTH PLAIN+LOGIN / MAIL / RCPT /
// DATA, records what each client did, and can be told to misbehave (wrong password, no STARTTLS, refuse the sender).
// Not a mail server - it never relays anything and only listens on 127.0.0.1.
//
// The TLS certificate is minted in memory per run (hand-built X.509 via node:crypto), so the repository never contains a
// private key. makeSelfSignedCert() also returns the PEM so a test can write it to disk for NODE_EXTRA_CA_CERTS.
'use strict';
const net = require('net');
const tls = require('tls');
const crypto = require('crypto');

// ── minimal DER / X.509 ────────────────────────────────────────────────────────────────────────────────────────
const dLen = (n) => n < 128 ? Buffer.from([n]) : n < 256 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 255]);
const tlv = (tag, ...parts) => { const body = Buffer.concat(parts); return Buffer.concat([Buffer.from([tag]), dLen(body.length), body]); };
const seq = (...p) => tlv(0x30, ...p);
const setOf = (...p) => tlv(0x31, ...p);
const derInt = (buf) => tlv(0x02, buf[0] & 0x80 ? Buffer.concat([Buffer.from([0]), buf]) : buf);
const derOid = (s) => {
    const p = s.split('.').map(Number);
    const bytes = [p[0] * 40 + p[1]];
    for (const n of p.slice(2)) { const st = [n & 0x7f]; let v = n >> 7; while (v > 0) { st.unshift((v & 0x7f) | 0x80); v >>= 7; } bytes.push(...st); }
    return tlv(0x06, Buffer.from(bytes));
};
const utcTime = (d) => tlv(0x17, Buffer.from(d.toISOString().replace(/[-:T]/g, '').slice(2, 14) + 'Z'));
const NULL = Buffer.from([0x05, 0x00]);

function makeSelfSignedCert() {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const name = seq(setOf(seq(derOid('2.5.4.3'), tlv(0x0c, Buffer.from('localhost')))));
    const sigAlg = seq(derOid('1.2.840.113549.1.1.11'), NULL);                        // sha256WithRSAEncryption
    const san = seq(tlv(0x82, Buffer.from('localhost')), tlv(0x87, Buffer.from([127, 0, 0, 1])));
    const exts = tlv(0xa3, seq(seq(derOid('2.5.29.17'), tlv(0x04, san))));            // subjectAltName
    const now = Date.now();
    const tbs = seq(
        tlv(0xa0, derInt(Buffer.from([2]))),                                          // v3
        derInt(crypto.randomBytes(8).map((b, i) => i === 0 ? b & 0x7f : b)),
        sigAlg, name,
        seq(utcTime(new Date(now - 86400000)), utcTime(new Date(now + 30 * 86400000))),
        name,
        publicKey.export({ type: 'spki', format: 'der' }),
        exts
    );
    const sig = crypto.sign('sha256', tbs, privateKey);
    const der = seq(tbs, sigAlg, tlv(0x03, Buffer.concat([Buffer.from([0]), sig])));
    const pem = '-----BEGIN CERTIFICATE-----\n' + der.toString('base64').match(/.{1,64}/g).join('\n') + '\n-----END CERTIFICATE-----\n';
    return { cert: pem, key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
}

// ── the server ─────────────────────────────────────────────────────────────────────────────────────────────────
// opts: user, pass            credentials the server accepts
//       advertiseStartTls     false = EHLO never offers STARTTLS (a downgrade attempt)
//       authFailMessage       when set, every AUTH is refused with 535 + this text
//       allowedFrom           when set, MAIL FROM any other address gets 550 5.7.60 SendAsDenied
// Resolves to { port, sessions, close() }. Each session records: tlsActive, authAttempts, authOk, mailFrom, rcpt, data.
async function startFakeSmtp(opts = {}) {
    const { cert, key } = opts.tlsMaterial || makeSelfSignedCert();
    const sessions = [];
    const sockets = new Set();
    const server = net.createServer((raw) => {
        sockets.add(raw); raw.on('close', () => sockets.delete(raw));
        const s ={ tlsActive: false, authAttempts: 0, authOk: false, authUser: null, mailFrom: null, rcpt: [], data: null };
        sessions.push(s);
        let sock = raw;
        let buf = '';
        let state = 'cmd';          // cmd | data | auth-plain | auth-user | auth-pass
        let pendingUser = null;
        const send = (line) => sock.write(line + '\r\n');
        const checkCreds = (u, p) => {
            s.authAttempts++; s.authMethod = s.authMethod || 'PASSWORD';
            if (opts.authFailMessage) return false;
            return u === opts.user && p === opts.pass;
        };
        const finishAuth = (u, p) => {
            const ok = checkCreds(u, p);
            if (ok) { s.authOk = true; s.authUser = u; send('235 2.7.0 Authentication successful'); }
            else send('535 5.7.139 ' + (opts.authFailMessage || 'Authentication unsuccessful, user credentials were incorrect'));
        };
        // SASL XOAUTH2: base64("user=" + mailbox + "\x01auth=Bearer " + token + "\x01\x01"). opts.oauthUser = the mailbox; opts.acceptToken(token) decides.
        const finishXoauth = (b64) => {
            s.authAttempts++; s.authMethod = 'XOAUTH2';
            const m = /^user=(.*)\x01auth=Bearer (.*)\x01\x01$/.exec(Buffer.from(b64, 'base64').toString('latin1'));
            s.oauthUser = m ? m[1] : null; s.oauthToken = m ? m[2] : null;
            const ok = !!m && m[1] === opts.oauthUser && typeof opts.acceptToken === 'function' && opts.acceptToken(m[2]);
            if (ok) { s.authOk = true; s.authUser = m[1]; send('235 2.7.0 Authentication successful'); }
            else { state = 'xoauth-fail'; send('334 ' + Buffer.from(JSON.stringify({ status: '401', schemes: 'Bearer', scope: 'https://outlook.office.com/' })).toString('base64')); }
        };
        const onData = (chunk) => {
            buf += chunk.toString('binary');
            for (;;) {
                if (state === 'data') {
                    const end = buf.indexOf('\r\n.\r\n');
                    if (end === -1) return;
                    s.data = buf.slice(0, end);
                    buf = buf.slice(end + 5);
                    state = 'cmd';
                    send('250 2.6.0 <fake-' + sessions.length + '@fake.test> [InternalId=1] Queued mail for delivery');
                    continue;
                }
                const nl = buf.indexOf('\r\n');
                if (nl === -1) return;
                const line = buf.slice(0, nl);
                buf = buf.slice(nl + 2);
                if (state === 'xoauth-wait') { state = 'cmd'; finishXoauth(line); continue; }
                if (state === 'xoauth-fail') { state = 'cmd'; send('535 5.7.3 Authentication unsuccessful [FAKE.PROD.OUTLOOK.COM 2026-10-12T18:00:00.000Z 0000000000000000]'); continue; }
                if (state === 'auth-plain') { state = 'cmd'; const [, u, p] = Buffer.from(line, 'base64').toString().split('\0'); finishAuth(u, p); continue; }
                if (state === 'auth-user') { pendingUser = Buffer.from(line, 'base64').toString(); state = 'auth-pass'; send('334 UGFzc3dvcmQ6'); continue; }
                if (state === 'auth-pass') { state = 'cmd'; finishAuth(pendingUser, Buffer.from(line, 'base64').toString()); continue; }
                const cmd = line.toUpperCase();
                if (cmd.startsWith('EHLO') || cmd.startsWith('HELO')) {
                    send('250-fake.test greets you');
                    send('250-SIZE 35882577');
                    if (!s.tlsActive && opts.advertiseStartTls !== false) send('250-STARTTLS');
                    send('250-AUTH PLAIN LOGIN XOAUTH2');
                    send('250 8BITMIME');
                } else if (cmd === 'STARTTLS') {
                    if (opts.advertiseStartTls === false || s.tlsActive) { send('502 5.5.1 STARTTLS not supported'); continue; }
                    send('220 2.0.0 SMTP server ready');
                    raw.removeAllListeners('data');
                    sock = new tls.TLSSocket(raw, { isServer: true, key, cert });
                    s.tlsActive = true;
                    sock.on('data', onData);
                    sock.on('error', () => {});
                    buf = '';
                } else if (cmd.startsWith('AUTH PLAIN')) {
                    const arg = line.slice(10).trim();
                    if (arg) { const [, u, p] = Buffer.from(arg, 'base64').toString().split('\0'); finishAuth(u, p); }
                    else { state = 'auth-plain'; send('334 '); }
                } else if (cmd.startsWith('AUTH XOAUTH2')) {
                    const arg = line.slice(12).trim();
                    if (arg) finishXoauth(arg); else { state = 'xoauth-wait'; send('334 '); }
                } else if (cmd.startsWith('AUTH LOGIN')) {
                    state = 'auth-user'; send('334 VXNlcm5hbWU6');
                } else if (cmd.startsWith('MAIL FROM')) {
                    if (!s.authOk) { send('530 5.7.57 Client not authenticated to send mail'); continue; }
                    const m = /<([^>]*)>/.exec(line);
                    s.mailFrom = m ? m[1] : null;
                    if (opts.allowedFrom && s.mailFrom !== opts.allowedFrom) send('550 5.7.60 SMTP; Client does not have permissions to send as this sender');
                    else send('250 2.1.0 Sender OK');
                } else if (cmd.startsWith('RCPT TO')) {
                    const m = /<([^>]*)>/.exec(line); s.rcpt.push(m ? m[1] : null);
                    // opts.rejectRcpt(address) => true makes the server refuse that recipient the way Exchange does for an unknown mailbox
                    if (typeof opts.rejectRcpt === 'function' && opts.rejectRcpt(m ? m[1] : null)) send('550 5.1.1 RESOLVER.ADR.RecipNotFound; not found');
                    else send('250 2.1.5 Recipient OK');
                } else if (cmd === 'DATA') {
                    state = 'data'; send('354 Start mail input; end with <CRLF>.<CRLF>');
                } else if (cmd === 'QUIT') {
                    send('221 2.0.0 Service closing transmission channel'); sock.end();
                } else if (cmd === 'RSET' || cmd === 'NOOP') {
                    send('250 2.0.0 OK');
                } else send('502 5.5.2 Command not recognized');
            }
        };
        raw.on('data', onData);
        raw.on('error', () => {});
        send('220 fake.test Microsoft ESMTP MAIL Service ready (test double)');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return {
        port: server.address().port, sessions, cert,
        close: () => new Promise((resolve) => { server.close(() => resolve()); sockets.forEach(s => s.destroy()); })
    };
}

// ── a fake Microsoft identity platform token endpoint (client-credentials grant) ───────────────────────────────────────
// Serves https://127.0.0.1:<port>/<tenant>/oauth2/v2.0/token with the SAME self-signed certificate as the fake SMTP server.
// Tokens are JWT-shaped on purpose so the redaction tests are realistic. opts: tenant, clientId, secret, tlsMaterial, expiresIn.
// Records every request (never the secret itself - only whether it was right) and the set of tokens it has issued.
// Error bodies copy Microsoft's real wording for: wrong secret (AADSTS7000215), unknown app (AADSTS700016), unknown tenant (AADSTS90002).
async function startFakeTokenServer(opts = {}) {
    const https = require('https');
    const { cert, key } = opts.tlsMaterial || makeSelfSignedCert();
    const requests = [], issued = new Set();
    let n = 0;
    // opts.plain = serve plain http on loopback (independent of any TLS interception on the machine running the tests)
    const mkServer = (handler) => opts.plain ? require('http').createServer(handler) : https.createServer({ key, cert }, handler);
    const server = mkServer((req, res) => {
        let body = '';
        req.on('data', (d) => { body += d; });
        req.on('end', () => {
            const form = Object.fromEntries(new URLSearchParams(body));
            const rec = { method: req.method, path: req.url, grant_type: form.grant_type, scope: form.scope, client_id: form.client_id, secretOk: form.client_secret === opts.secret, contentType: req.headers['content-type'] };
            requests.push(rec);
            const send = (status, json) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(json)); };
            const trace = ' Trace ID: 00000000-aaaa-bbbb-cccc-000000000000 Correlation ID: 11111111-aaaa-bbbb-cccc-111111111111 Timestamp: 2026-10-12 18:00:00Z';
            if (req.method !== 'POST' || req.url !== '/' + opts.tenant + '/oauth2/v2.0/token')
                return send(400, { error: 'invalid_request', error_description: "AADSTS90002: Tenant '" + req.url.split('/')[1] + "' not found. Check to make sure you have the correct tenant ID and are signing into the correct cloud." + trace, error_codes: [90002] });
            if (form.grant_type !== 'client_credentials' || form.scope !== 'https://outlook.office365.com/.default')
                return send(400, { error: 'invalid_scope', error_description: 'AADSTS70011: The provided request must include a valid scope.' + trace, error_codes: [70011] });
            if (form.client_id !== opts.clientId)
                return send(400, { error: 'unauthorized_client', error_description: "AADSTS700016: Application with identifier '" + form.client_id + "' was not found in the directory '" + opts.tenant + "'." + trace, error_codes: [700016] });
            if (form.client_secret !== opts.secret)
                return send(401, { error: 'invalid_client', error_description: "AADSTS7000215: Invalid client secret provided. Ensure the secret being sent in the request is the client secret value, not the client secret ID, for a secret added to app '" + opts.clientId + "'." + trace, error_codes: [7000215] });
            n++;
            const token = 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.' + Buffer.from(JSON.stringify({ aud: 'https://outlook.office365.com', n })).toString('base64url') + '.fakeSignature' + n;
            issued.add(token);
            send(200, { token_type: 'Bearer', expires_in: opts.expiresIn || 3599, ext_expires_in: 3599, access_token: token });
        });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const sockets = new Set();
    server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
    return {
        port: server.address().port, url: (opts.plain ? 'http' : 'https') + '://127.0.0.1:' + server.address().port, requests, issued,
        close: () => new Promise((resolve) => { server.close(() => resolve()); sockets.forEach(s => s.destroy()); })
    };
}

module.exports = { startFakeSmtp, makeSelfSignedCert, startFakeTokenServer };
