// Integration-test support: boot the real app against a throwaway copy of the database, on a private
// port, with a seeded administrator — then tear it all down. The real database.sqlite is never touched.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const sqlite3 = require('sqlite3');
const bcrypt = require('bcrypt');

const ROOT = path.resolve(__dirname, '..');
const TEST_DB = path.join(__dirname, '.test.sqlite');
const PORT = process.env.TEST_PORT || 3199;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = { email: 'test.runner@example.invalid', password: 'TestRunnerPass1!' };

let child = null;
let cookie = '';
let runStartedAt = 0; // used to sweep docs/ PDFs this run generated

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

async function start() {
    runStartedAt = Date.now();
    // Fresh throwaway DB from the current schema+data.
    for (const suffix of ['', '-wal', '-shm']) {
        const src = path.join(ROOT, 'database.sqlite' + suffix);
        if (fs.existsSync(src)) fs.copyFileSync(src, TEST_DB + suffix);
    }
    await seedAdmin();

    child = spawn(process.execPath, ['server.js'], {
        cwd: ROOT,
        env: {
            ...process.env,
            NODE_ENV: 'test',
            PORT: String(PORT),
            DB_PATH: TEST_DB,
            // Sandbox so the PayFast ITN accepts synthetic notifications (lenient signature/IP).
            PAYFAST_URL: 'https://sandbox.payfast.co.za',
            PAYFAST_MERCHANT_ID: '10000100',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    child.stdout.on('data', d => { log += d; });
    child.stderr.on('data', d => { log += d; });

    // Wait for readiness.
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
        try {
            const r = await fetch(`${BASE}/api/public/booking-config`);
            if (r.ok) break;
        } catch (e) { /* not up yet */ }
        if (child.exitCode !== null) throw new Error('server exited during startup:\n' + log.slice(-2000));
        await sleep(250);
    }

    const lr = await fetch(`${BASE}/api/admin/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ADMIN),
    });
    const sc = lr.headers.get('set-cookie');
    if (lr.status !== 200 || !sc) throw new Error('admin login failed: ' + lr.status);
    cookie = sc.split(';')[0];
}

async function stop() {
    if (child && child.exitCode === null) {
        child.kill();
        await sleep(300);
    }
    for (const suffix of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(TEST_DB + suffix); } catch (e) {}
    }
    // The app writes quote/invoice/contract PDFs into docs/ regardless of DB_PATH, so the run leaves
    // artifacts there. Delete exactly the files this run created (mtime at/after run start).
    for (const dir of ['quotes', 'invoices', 'contracts']) {
        const d = path.join(ROOT, 'docs', dir);
        if (!fs.existsSync(d)) continue;
        for (const f of fs.readdirSync(d)) {
            const fp = path.join(d, f);
            try { if (fs.statSync(fp).mtimeMs >= runStartedAt) fs.unlinkSync(fp); } catch (e) {}
        }
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

// Unauthenticated request (public endpoints).
async function pub(method, urlPath, body) {
    const r = await fetch(BASE + urlPath, {
        method, headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
    });
    let json = null; try { json = await r.json(); } catch (e) {}
    return { status: r.status, body: json };
}

const future = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);

module.exports = { start, stop, api, pub, q, one, future, BASE, sleep };
