// Integration-test support: boot the real app against a throwaway copy of the database, on a private
// port, with a seeded administrator — then tear it all down. The real database.sqlite is never touched.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { spawn } = require('child_process');
const sqlite3 = require('sqlite3');
const bcrypt = require('bcrypt');

const ROOT = path.resolve(__dirname, '..');
const TEST_DB = path.join(__dirname, '.test.sqlite');
// Phase 3 (HOUSEKEEPING-NOTES.md) pointed the app's default DOCS_PATH/UPLOADS_PATH at a directory
// outside the repo. Tests need their own throwaway versions of those, same idea as TEST_DB, or
// every run would write real-looking PDFs/uploads into that shared external default location with
// nothing to clean them up.
//
// NOT dot-prefixed (unlike .test.sqlite) — Express's `send` module (behind res.sendFile, used by
// every PDF download route) refuses to serve a path with ANY dotfile-like segment by default
// (dotfiles:'ignore'), returning a bare 404 even though fs.existsSync sees the file fine. A
// `.test-docs` folder name silently 500'd every quote/invoice download here; discovered by
// pdf-golden.test.js failing, root-caused by comparing the working pre-Phase-3 path
// (docs/quotes/... — no dot segments) against this one.
const TEST_DOCS_DIR = path.join(__dirname, 'test-docs');
const TEST_UPLOADS_DIR = path.join(__dirname, 'test-uploads');
const PORT = process.env.TEST_PORT || 3199;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = { email: 'test.runner@example.invalid', password: 'TestRunnerPass1!' };

let child = null;
let cookie = '';
let childLog = ''; // accumulated stdout+stderr of the current child, reset on start()/restart()

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Read-only query against the test DB (opens its own handle so it never fights the server's).
function q(sql, params = []) {
    return new Promise((res, rej) => {
        const db = new sqlite3.Database(TEST_DB, sqlite3.OPEN_READONLY);
        db.all(sql, params, (e, rows) => { db.close(); e ? rej(e) : res(rows); });
    });
}
const one = async (sql, params = []) => (await q(sql, params))[0];

async function seedAdmin() {
    const db = new sqlite3.Database(TEST_DB);
    const hash = await bcrypt.hash(ADMIN.password, 10);
    await new Promise((res, rej) => db.run(
        `INSERT INTO admins (username, email, password_hash, role, is_active, must_change_password)
         VALUES (?, ?, ?, 'administrator', 1, 0)`,
        [ADMIN.email, ADMIN.email, hash], e => e ? rej(e) : res()));
    await new Promise(res => db.close(res));
}

// Spawns server.js against TEST_DB and waits for readiness. Shared by start() (fresh DB + login)
// and restart() (same DB, no re-login needed — sessions live in the real sessions.sqlite, which
// isn't DB_PATH-redirected, so an existing cookie survives a respawn untouched).
async function spawnAndWait() {
    childLog = '';
    child = spawn(process.execPath, ['server.js'], {
        cwd: ROOT,
        env: {
            ...process.env,
            NODE_ENV: 'test',
            PORT: String(PORT),
            DB_PATH: TEST_DB,
            DOCS_PATH: TEST_DOCS_DIR,
            UPLOADS_PATH: TEST_UPLOADS_DIR,
            // Sandbox so the PayFast ITN accepts synthetic notifications (lenient signature/IP).
            PAYFAST_URL: 'https://sandbox.payfast.co.za',
            PAYFAST_MERCHANT_ID: '10000100',
            // Real EMAIL_USER/PASS and GOOGLE_REFRESH_TOKEN now both work (2026-07-16) — without these
            // overrides, every test run would send real Gmail messages to the business's real inbox
            // and write real events onto its real Google Calendar for every fake test booking. SMTP_MOCK
            // makes emailService.js use its stub transporter (still queues into `notifications` exactly
            // as before, so every email.test.js assertion is unaffected). The bogus refresh token makes
            // syncBookingToCalendar() fail exactly the way it already did before re-auth — caught
            // internally, resolves null, no test depends on a real calendar write succeeding.
            SMTP_MOCK: 'true',
            GOOGLE_REFRESH_TOKEN: 'test-mode-invalid-refresh-token',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', d => { childLog += d; });
    child.stderr.on('data', d => { childLog += d; });

    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
        try {
            const r = await fetch(`${BASE}/api/public/booking-config`);
            if (r.ok) return;
        } catch (e) { /* not up yet */ }
        if (child.exitCode !== null) throw new Error('server exited during startup:\n' + childLog.slice(-2000));
        await sleep(250);
    }
    throw new Error('server did not become ready within 30s:\n' + childLog.slice(-2000));
}

async function start() {
    // Clear any leftover throwaway docs/uploads from a previous run that didn't shut down cleanly
    // (e.g. a crashed process) — same reasoning as always re-copying a fresh TEST_DB below.
    for (const dir of [TEST_DOCS_DIR, TEST_UPLOADS_DIR]) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
    }
    // Fresh throwaway DB from the current schema+data.
    for (const suffix of ['', '-wal', '-shm']) {
        const src = path.join(ROOT, 'database.sqlite' + suffix);
        if (fs.existsSync(src)) {
            try {
                fs.copyFileSync(src, TEST_DB + suffix);
            } catch (e) {
                if (suffix === '') throw e;
                // Ignore lock failures on WAL/SHM helper files
            }
        }
    }
    await seedAdmin();
    await spawnAndWait();

    const lr = await fetch(`${BASE}/api/admin/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ADMIN),
    });
    const sc = lr.headers.get('set-cookie');
    if (lr.status !== 200 || !sc) throw new Error('admin login failed: ' + lr.status);
    cookie = sc.split(';')[0];
}

// Kills the current child WITHOUT touching TEST_DB (unlike start(), which always re-copies the
// live DB) and respawns against the same DB file — for tests that need to simulate a server
// restart against deliberately-seeded state (e.g. an overdue scheduled_newsletters row).
async function restart() {
    if (child && child.exitCode === null) {
        child.kill();
        await sleep(300);
    }
    await spawnAndWait();
}

// Current accumulated stdout+stderr of the running child, reset on the last start()/restart().
function getChildLog() { return childLog; }

async function stop() {
    if (child && child.exitCode === null) {
        child.kill();
        await sleep(300);
    }
    for (const suffix of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(TEST_DB + suffix); } catch (e) {}
    }
    // Quote/invoice/contract PDFs and uploaded images now write to TEST_DOCS_DIR/TEST_UPLOADS_DIR
    // (see spawnAndWait()'s DOCS_PATH/UPLOADS_PATH env overrides) instead of the app's real
    // external default location, so the whole throwaway tree can just be removed — no per-subfolder
    // mtime bookkeeping needed any more.
    for (const dir of [TEST_DOCS_DIR, TEST_UPLOADS_DIR]) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
    }
}

// Authenticated JSON request.
async function api(method, urlPath, body) {
    const r = await fetch(BASE + urlPath, {
        method,
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: body ? JSON.stringify(body) : undefined,
    });
    let json = null; try { json = await r.json(); } catch (e) {}
    return { status: r.status, body: json };
}

// Authenticated request expecting a binary body (PDF downloads etc), returned as a Buffer.
async function apiBinary(method, urlPath) {
    const r = await fetch(BASE + urlPath, { method, headers: { Cookie: cookie } });
    const buffer = Buffer.from(await r.arrayBuffer());
    return { status: r.status, buffer, contentType: r.headers.get('content-type') };
}

// PDF string escapes: \n \r \t \( \) \\ and up to 3-digit octal (PDF spec 7.3.4.2).
function unescapePdfString(s) {
    return s.replace(/\\(\d{1,3}|.)/g, (_, esc) => {
        if (/^\d{1,3}$/.test(esc)) return String.fromCharCode(parseInt(esc, 8));
        if (esc === 'n') return '\n';
        if (esc === 'r') return '\r';
        if (esc === 't') return '\t';
        return esc;
    });
}

// PDFKit shows text as hex strings (<4869>Tj), not literal (Hi)Tj strings — confirmed by
// generating a sample doc and inspecting its decompressed content stream directly.
function hexToStr(hex) {
    const clean = hex.replace(/\s+/g, '');
    let out = '';
    for (let i = 0; i + 1 < clean.length; i += 2) out += String.fromCharCode(parseInt(clean.substr(i, 2), 16));
    return out;
}

// Minimal PDF text extractor — good enough to substring-match reference numbers, amounts and
// client names inside PDFs generated by pdfService.js (plain PDFKit output, standard Helvetica
// fonts, no embedded custom-encoded glyphs). Decompresses each Flate content stream and reads the
// text-showing operators directly (both literal `(...)` and hex `<...>` string forms); this is
// not a general-purpose PDF parser.
function extractPdfText(buffer) {
    const raw = buffer.toString('latin1');
    const streamRe = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
    let text = '';
    let m;
    while ((m = streamRe.exec(raw))) {
        let decoded;
        try { decoded = zlib.inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1'); }
        catch (e) { continue; } // not Flate-compressed (e.g. an embedded image/font) — skip
        const tjRe = /(\(((?:\\.|[^()\\])*)\)|<([0-9A-Fa-f\s]*)>)\s*Tj/g;
        let t;
        while ((t = tjRe.exec(decoded))) text += (t[2] !== undefined ? unescapePdfString(t[2]) : hexToStr(t[3])) + ' ';
        const tjArrRe = /\[((?:[^\[\]])*)\]\s*TJ/g;
        let arr;
        while ((arr = tjArrRe.exec(decoded))) {
            const partRe = /\(((?:\\.|[^()\\])*)\)|<([0-9A-Fa-f\s]*)>/g;
            let p;
            while ((p = partRe.exec(arr[1]))) text += (p[1] !== undefined ? unescapePdfString(p[1]) : hexToStr(p[2]));
            text += ' ';
        }
    }
    return text;
}

// Creates (or reuses) an admin account with the given role and returns an authenticated request
// function scoped to that role's session cookie — independent of the module-level `cookie` used by
// `api()`, so a test can hold an administrator cookie and e.g. an assistant cookie side by side.
async function loginAs(role) {
    const email = `test.${role}@example.invalid`;
    const password = 'TestRunnerPass1!';
    const db = new sqlite3.Database(TEST_DB);
    const hash = await bcrypt.hash(password, 10);
    await new Promise((res, rej) => db.run(
        `INSERT INTO admins (username, email, password_hash, role, is_active, must_change_password)
         VALUES (?, ?, ?, ?, 1, 0)
         ON CONFLICT(username) DO UPDATE SET role = excluded.role, is_active = 1, password_hash = excluded.password_hash`,
        [email, email, hash, role], e => e ? rej(e) : res()));
    await new Promise(res => db.close(res));

    const lr = await fetch(`${BASE}/api/admin/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
    });
    const sc = lr.headers.get('set-cookie');
    if (lr.status !== 200 || !sc) throw new Error(`loginAs(${role}) failed: ${lr.status}`);
    const roleCookie = sc.split(';')[0];

    return async (method, urlPath, body) => {
        const r = await fetch(BASE + urlPath, {
            method,
            headers: { 'Content-Type': 'application/json', Cookie: roleCookie },
            body: body ? JSON.stringify(body) : undefined,
        });
        let json = null; try { json = await r.json(); } catch (e) {}
        return { status: r.status, body: json };
    };
}

// Unauthenticated request (public endpoints).
async function pub(method, urlPath, body) {
    const r = await fetch(BASE + urlPath, {
        method, headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
    });
    let json = null; try { json = await r.json(); } catch (e) {}
    return { status: r.status, body: json };
}

// Runs the public tracker's email-verification flow (request-code -> read the queued email ->
// verify-code) and returns the resulting access_token, or null if the flow didn't succeed. Every
// mutating/tracking public route now requires this token instead of a bare email — see
// requireBookingAccessToken in server.js. sendEmail() queues into `notifications` synchronously,
// before any actual SMTP dispatch happens, so the code is readable straight from the test DB
// without waiting for (or caring whether) real delivery ever occurs.
async function getTrackingToken(bookingId, email) {
    const reqRes = await pub('POST', `/api/public/bookings/${bookingId}/track/request-code`, { email });
    if (!reqRes.body || !reqRes.body.success) return null;
    const notif = await one(
        `SELECT body FROM notifications WHERE recipient_email = ? AND subject LIKE 'Your verification code:%' ORDER BY id DESC LIMIT 1`,
        [email]
    );
    if (!notif) return null;
    let html = '';
    try { html = JSON.parse(notif.body).htmlContent || ''; } catch (e) { return null; }
    const m = html.match(/\b(\d{6})\b/);
    if (!m) return null;
    const verifyRes = await pub('POST', `/api/public/bookings/${bookingId}/track/verify-code`, { email, code: m[1] });
    return (verifyRes.body && verifyRes.body.access_token) || null;
}

// Requests a POPIA erasure OTP and reads the 6-digit code straight out of the queued email — same
// shape as getTrackingToken, but a distinct subject prefix ("Your POPIA verification code:") so it
// can never collide with the tracker's own query against the same notifications table. Does NOT
// verify the code (POPIA verification only happens as part of /preview or /erasure-requests) —
// callers pass the returned code to whichever of those two endpoints they're testing.
async function getPopiaOtpCode(email) {
    const reqRes = await pub('POST', '/api/public/popia/request-otp', { email });
    if (!reqRes.body || !reqRes.body.success) return null;
    const notif = await one(
        `SELECT body FROM notifications WHERE recipient_email = ? AND subject LIKE 'Your POPIA verification code:%' ORDER BY id DESC LIMIT 1`,
        [email]
    );
    if (!notif) return null;
    let html = '';
    try { html = JSON.parse(notif.body).htmlContent || ''; } catch (e) { return null; }
    const m = html.match(/\b(\d{6})\b/);
    return m ? m[1] : null;
}

// Authenticated multipart/form-data request (banner image upload etc). `fields` are string form
// fields; `file` is { buffer, filename, contentType } or omitted.
async function upload(method, urlPath, fields = {}, file, fieldName = 'image') {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) {
        if (v !== undefined && v !== null) form.append(k, String(v));
    }
    if (file) form.append(fieldName, new Blob([file.buffer], { type: file.contentType }), file.filename);
    // Do not set Content-Type manually — fetch derives the multipart boundary from the FormData body.
    const r = await fetch(BASE + urlPath, { method, headers: { Cookie: cookie }, body: form });
    let json = null; try { json = await r.json(); } catch (e) {}
    return { status: r.status, body: json };
}

function crc32(buf) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) {
        crc ^= buf[i];
        for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
}
function pngChunk(type, data) {
    const typeBuf = Buffer.from(type, 'ascii');
    const lenBuf = Buffer.alloc(4); lenBuf.writeUInt32BE(data.length, 0);
    const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
    return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}
// Builds a minimal valid 8-bit RGB PNG at the given pixel dimensions, with no external image
// library. `random: true` fills pixel rows with crypto randomness (incompressible — for exercising
// the ≤100KB rejection path); otherwise rows are solid black, which deflates to near-nothing
// regardless of width (for the width-only validation tests, so file size never confounds them).
function makeTestPng(width, height, { random = false } = {}) {
    const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    const ihdrData = Buffer.alloc(13);
    ihdrData.writeUInt32BE(width, 0);
    ihdrData.writeUInt32BE(height, 4);
    ihdrData[8] = 8;  // bit depth
    ihdrData[9] = 2;  // color type: truecolor (RGB, no alpha)
    ihdrData[10] = 0; ihdrData[11] = 0; ihdrData[12] = 0; // compression, filter, interlace
    const ihdr = pngChunk('IHDR', ihdrData);

    const rowBytes = 1 + width * 3; // leading filter-type byte (0 = none) + RGB pixels
    const raw = Buffer.alloc(rowBytes * height);
    if (random) {
        crypto.randomFillSync(raw);
        for (let y = 0; y < height; y++) raw[y * rowBytes] = 0; // filter byte must stay 0
    }
    const idat = pngChunk('IDAT', zlib.deflateSync(raw));
    const iend = pngChunk('IEND', Buffer.alloc(0));
    return Buffer.concat([sig, ihdr, idat, iend]);
}

const future = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);

module.exports = { start, stop, restart, getChildLog, api, pub, apiBinary, upload, loginAs, q, one, future, makeTestPng, TEST_DB, BASE, sleep, getTrackingToken, getPopiaOtpCode, extractPdfText };
