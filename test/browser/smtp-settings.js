// Admin -> System Settings -> Email (SMTP): the card driven through the REAL admin.html UI on an isolated DB copy (test/support.js -
// SMTP mocked, the real database and mail server are never touched). Covers: the card renders with the Microsoft 365 fields,
// the password is masked and never comes back from the server, inline validation, Test Connection, Save, Send Test, reload,
// and the card being hidden for non-administrators.
//
// Not part of `npm test`: run it with `npm run test:browser` (needs PUPPETEER_EXECUTABLE_PATH on this machine, see test-suite notes).
const fs = require('fs');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3');
const support = require('../support');
const puppeteer = require('puppeteer');
const { BASE, sleep } = support;
let fails = 0;
const ok = (c, n, detail) => { if (!c) fails++; console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '\n        -> ' + detail)); };

const PASSWORD = 'TestRunnerPass1!';
const SECRET = 'Zq9&Mx"7<p>w\'Rt/k';
const SHOTS = process.env.SMTP_SHOTS_DIR || null;     // optional: directory for screenshots

function sqlRun(sql, params = []) {
    return new Promise((res, rej) => {
        const db = new sqlite3.Database(support.TEST_DB);
        db.run(sql, params, function (e) { db.close(); e ? rej(e) : res(this); });
    });
}
async function cookieFor(email) {
    const r = await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: PASSWORD }) });
    const sc = r.headers.get('set-cookie');
    if (r.status !== 200 || !sc) throw new Error('login failed for ' + email + ': ' + r.status);
    return sc.split(';')[0];
}

async function openAdmin(browser, cookie, { width = 1440, height = 1100, rewriteSettings = null } = {}) {
    const ctx = await browser.createBrowserContext();
    const p = await ctx.newPage();
    await p.setViewport({ width, height });
    p._errs = []; p._bodies = [];
    p.on('pageerror', e => p._errs.push(e.message.slice(0, 200)));
    p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|Loading the font|API Error/.test(m.text())) p._errs.push('console: ' + m.text().slice(0, 200)); });
    p.on('response', async r => { if (/\/api\/admin\/settings/.test(r.url())) { try { p._bodies.push(await r.text()); } catch (e) { /* redirect / no body */ } } });
    const [name, ...rest] = cookie.split('=');
    await p.setCookie({ name, value: rest.join('='), url: BASE });
    await p.setRequestInterception(true);
    p.on('request', async r => {
        if (/\/api\/admin\/maps-config/.test(r.url())) return r.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, key: '' }) });
        // Simulates another server version answering GET /api/admin/settings (e.g. one that was not restarted after an update).
        if (rewriteSettings && r.method() === 'GET' && /\/api\/admin\/settings$/.test(r.url())) {
            const real = await (await fetch(r.url(), { headers: { Cookie: cookie } })).json();
            return r.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(rewriteSettings(real)) });
        }
        r.continue();
    });
    await p.goto(BASE + '/admin.html', { waitUntil: 'networkidle0', timeout: 90000 });
    await p.waitForFunction(() => typeof window.loadSystemSettings === 'function' && typeof window.switchTab === 'function', { timeout: 30000 });
    await p.evaluate(() => window.switchTab('preferencesAdmin'));
    await sleep(300);
    await p.evaluate(() => window.loadSystemSettings());
    await sleep(600);
    return p;
}

const domClick = (p, sel) => p.$eval(sel, e => e.click());
const toastText = p => p.evaluate(() => Array.from(document.querySelectorAll('.tm-toast__message')).map(t => t.textContent).join(' | '));
const setVal = (p, sel, v) => p.$eval(sel, (e, val) => { e.value = val; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); }, v);
const shot = async (p, name) => { if (!SHOTS) return; await p.evaluate(() => { const c = document.getElementById('stSmtpCard'); if (c) c.scrollIntoView({ block: 'start' }); }); await sleep(250); await p.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: false }); };

(async () => {
    await support.start();
    await sqlRun("DELETE FROM settings WHERE setting_key LIKE 'smtp\\_%' ESCAPE '\\'");
    await support.loginAs('manager');
    const adminCookie = await cookieFor('test.runner@example.invalid');
    const managerCookie = await cookieFor('test.manager@example.invalid');
    const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-quic'] });

    const p = await openAdmin(browser, adminCookie);

    // ── 1. the card renders with every Microsoft 365 field ──
    const card = await p.evaluate(() => {
        const vis = (id) => { const e = document.getElementById(id); return !!e && e.offsetParent !== null; };
        const pw = document.getElementById('stSmtpPass');
        return {
            cardShown: vis('stSmtpCard'), fields: ['stSmtpHost', 'stSmtpPort', 'stSmtpSecure', 'stSmtpUser', 'stSmtpPass', 'stSmtpFrom', 'stSmtpFromName', 'stSmtpTestBtn'].map(i => [i, vis(i)]),
            pwType: pw.type, pwAuto: pw.autocomplete, secureOpts: Array.from(document.getElementById('stSmtpSecure').options).map(o => o.value), status: document.getElementById('stSmtpStatus').textContent
        };
    });
    ok(card.cardShown && card.fields.every(f => f[1]), 'the Email (SMTP) card shows host, port, encryption, user, password, sender, sender name and Test Connection', JSON.stringify(card));
    ok(card.pwType === 'password' && card.pwAuto === 'new-password', 'the password box is masked and told not to autofill the admin\'s own login', JSON.stringify({ t: card.pwType, a: card.pwAuto }));
    ok(card.secureOpts.join() === 'starttls,ssl', 'encryption offers only STARTTLS and SSL (no "none")', card.secureOpts.join());
    ok(/Not fully configured|legacy|Active/.test(card.status), 'a status line says what is currently in effect', card.status);
    await shot(p, 'smtp-card-empty');

    // ── 2. inline validation, nothing sent ──
    await setVal(p, '#stSmtpHost', 'smtp.office365.com');
    await setVal(p, '#stSmtpPort', '70000');
    await domClick(p, '#stSmtpTestBtn'); await sleep(300);
    let v = await p.evaluate(() => { const e = document.getElementById('errStPort'); return { shown: e.style.display !== 'none', text: e.textContent }; });
    ok(v.shown && /1 and 65535/.test(v.text), 'Test Connection refuses an out-of-range port with an inline message', JSON.stringify(v));
    await setVal(p, '#stSmtpPort', '587'); await p.select('#stSmtpSecure', 'ssl');
    await domClick(p, '#stSmtpTestBtn'); await sleep(300);
    v = await p.evaluate(() => ({ text: document.getElementById('errStSecure').textContent, shown: document.getElementById('errStSecure').style.display !== 'none' }));
    ok(v.shown && /587 uses STARTTLS/.test(v.text), 'port 587 with SSL is rejected inline', JSON.stringify(v));
    await p.select('#stSmtpSecure', 'starttls');
    await setVal(p, '#stSmtpHost', 'http://smtp.office365.com');
    await domClick(p, '#stSmtpTestBtn'); await sleep(300);
    v = await p.evaluate(() => ({ text: document.getElementById('errStHost').textContent }));
    ok(/just the server name/.test(v.text), 'a host typed as a URL is rejected inline', JSON.stringify(v));

    // ── 3. Test Connection with unsaved values ──
    await setVal(p, '#stSmtpHost', 'smtp.office365.com');
    await setVal(p, '#stSmtpUser', 'bookings@thabisomhlongo.com');
    await setVal(p, '#stSmtpPass', SECRET);
    await setVal(p, '#stSmtpFrom', 'bookings@thabisomhlongo.com');
    await setVal(p, '#stSmtpFromName', 'Thabiso Mhlongo');
    await domClick(p, '#stSmtpTestBtn');
    await p.waitForFunction(() => document.getElementById('stSmtpTestResult').textContent.length > 0, { timeout: 15000 });
    const tr = await p.evaluate(() => { const e = document.getElementById('stSmtpTestResult'); return { text: e.textContent, color: e.style.color }; });
    ok(/^✓/.test(tr.text) && /mock/i.test(tr.text), 'Test Connection reports its result next to the button (mock server in this test)', JSON.stringify(tr));
    ok(!tr.text.includes(SECRET), 'the test result never contains the password', tr.text);

    // ── 4. Save ──
    await shot(p, 'smtp-card-filled');
    await domClick(p, '#btnSaveSystemSettings');
    await p.waitForFunction(() => /saved successfully/i.test(Array.from(document.querySelectorAll('.tm-toast__message')).map(t => t.textContent).join(' ')), { timeout: 20000 });
    const after = await p.evaluate(() => ({
        pw: document.getElementById('stSmtpPass').value, ph: document.getElementById('stSmtpPass').placeholder,
        status: document.getElementById('stSmtpStatus').textContent, host: document.getElementById('stSmtpHost').value, name: document.getElementById('stSmtpFromName').value
    }));
    ok(after.pw === '' && /saved/.test(after.ph) && after.host === 'smtp.office365.com' && after.name === 'Thabiso Mhlongo', 'after saving, the password box is cleared and says a password is saved; other values stay', JSON.stringify(after));
    ok(/Active: bookings@thabisomhlongo\.com via smtp\.office365\.com:587 \(STARTTLS\).*encrypted/.test(after.status), 'the status line reflects the saved configuration', after.status);

    // ── 5. reload: values come back, the password never does ──
    await p.reload({ waitUntil: 'networkidle0' });
    await p.waitForFunction(() => typeof window.switchTab === 'function', { timeout: 30000 });
    await p.evaluate(() => window.switchTab('preferencesAdmin')); await sleep(300);
    await p.evaluate(() => window.loadSystemSettings()); await sleep(800);
    const re = await p.evaluate(() => ({ host: document.getElementById('stSmtpHost').value, user: document.getElementById('stSmtpUser').value, pw: document.getElementById('stSmtpPass').value, ph: document.getElementById('stSmtpPass').placeholder, html: document.documentElement.outerHTML }));
    ok(re.host === 'smtp.office365.com' && re.user === 'bookings@thabisomhlongo.com' && re.pw === '' && /saved/.test(re.ph), 'after a reload the saved values load and the password box stays empty', JSON.stringify({ h: re.host, u: re.user, pw: re.pw, ph: re.ph }));
    ok(!re.html.includes(SECRET), 'the password appears nowhere in the page DOM', '');
    ok(p._bodies.length >= 2 && p._bodies.every(b => !b.includes(SECRET) && !b.includes('enc:v1')), 'no /api/admin/settings response in this session ever carried the password (or its ciphertext)', `${p._bodies.length} responses`);

    // ── 6. editing without retyping the password keeps it ──
    await setVal(p, '#stSmtpFromName', 'Thabiso M.');
    await domClick(p, '#btnSaveSystemSettings');
    await p.waitForFunction(() => /saved successfully/i.test(Array.from(document.querySelectorAll('.tm-toast__message')).map(t => t.textContent).join(' ')), { timeout: 20000 });
    const kept = await p.evaluate(() => document.getElementById('stSmtpStatus').textContent);
    ok(/encrypted/.test(kept), 'saving with the password box blank keeps the stored password', kept);

    // ── 6b. Microsoft 365 OAuth: the card swaps fields, validates, tests, saves - and never shows or returns the secret ──
    const OSECRET = 'Qx8~Zr3.fakeClientSecret_VALUE-7';
    await p.select('#stSmtpAuth', 'oauth');
    const tg = await p.evaluate(() => ({
        pass: document.getElementById('stSmtpPassGroup').offsetParent !== null,
        oauth: document.getElementById('stSmtpOauthGroup').offsetParent !== null,
        tenant: document.getElementById('stSmtpTenant').offsetParent !== null, secretType: document.getElementById('stSmtpSecret').type
    }));
    ok(!tg.pass && tg.oauth && tg.tenant && tg.secretType === 'password', 'choosing "Microsoft 365 OAuth" hides the password box and shows tenant ID, application ID and a masked client secret', JSON.stringify(tg));
    await setVal(p, '#stSmtpTenant', 'not a tenant!'); await setVal(p, '#stSmtpClient', 'abc'); await setVal(p, '#stSmtpSecret', '11111111-2222-3333-4444-555555555555');
    await domClick(p, '#stSmtpTestBtn'); await sleep(300);
    const oe = await p.evaluate(() => ['errStTenant', 'errStClient', 'errStSecret'].map(id => { const e = document.getElementById(id); return e.style.display !== 'none' ? e.textContent : ''; }));
    ok(oe.every(t => t.length > 0) && /Secret ID/.test(oe[2]), 'a bad tenant, a bad application ID and a pasted Secret ID are all caught inline before anything is sent', JSON.stringify(oe));
    await setVal(p, '#stSmtpTenant', 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'); await setVal(p, '#stSmtpClient', '11111111-2222-3333-4444-555555555555'); await setVal(p, '#stSmtpSecret', OSECRET);
    await domClick(p, '#stSmtpTestBtn');
    await p.waitForFunction(() => /^\u2713/.test(document.getElementById('stSmtpTestResult').textContent), { timeout: 15000 });
    const otr = await p.$eval('#stSmtpTestResult', e => e.textContent);
    ok(/mock/i.test(otr) && !otr.includes(OSECRET), 'Test Connection works with the OAuth fields (mock server here) and never echoes the secret', otr);
    await shot(p, 'smtp-card-oauth');
    await domClick(p, '#btnSaveSystemSettings');
    // wait for the save's own effect (not for a toast: the previous save's toast can still be on screen)
    await p.waitForFunction(() => document.getElementById('stSmtpSecret').value === '' && /using Microsoft 365 OAuth/.test(document.getElementById('stSmtpStatus').textContent), { timeout: 20000 });
    const oafter = await p.evaluate(() => ({ secret: document.getElementById('stSmtpSecret').value, ph: document.getElementById('stSmtpSecret').placeholder, status: document.getElementById('stSmtpStatus').textContent }));
    ok(oafter.secret === '' && /saved/.test(oafter.ph) && /using Microsoft 365 OAuth/.test(oafter.status) && /client secret saved \(encrypted\)/.test(oafter.status), 'after saving, the secret box is cleared and the status line says OAuth with a saved (encrypted) secret', JSON.stringify(oafter));
    await p.reload({ waitUntil: 'networkidle0' });
    await p.waitForFunction(() => typeof window.switchTab === 'function', { timeout: 30000 });
    await p.evaluate(() => window.switchTab('preferencesAdmin')); await sleep(300);
    await p.evaluate(() => window.loadSystemSettings()); await sleep(800);
    const ore = await p.evaluate(() => ({
        auth: document.getElementById('stSmtpAuth').value, tenant: document.getElementById('stSmtpTenant').value, client: document.getElementById('stSmtpClient').value,
        secret: document.getElementById('stSmtpSecret').value, oauthShown: document.getElementById('stSmtpOauthGroup').offsetParent !== null,
        passShown: document.getElementById('stSmtpPassGroup').offsetParent !== null, html: document.documentElement.outerHTML
    }));
    ok(ore.auth === 'oauth' && ore.tenant === 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' && ore.client === '11111111-2222-3333-4444-555555555555' && ore.secret === '' && ore.oauthShown && !ore.passShown, 'after a reload the OAuth method, tenant and application ID come back, and the secret box stays empty', JSON.stringify({ a: ore.auth, t: ore.tenant, c: ore.client, s: ore.secret }));
    ok(!ore.html.includes(OSECRET), 'the client secret appears nowhere in the page DOM', '');
    ok(p._bodies.every(b => !b.includes(OSECRET) && !b.includes('enc:v1')), 'no settings response ever carried the client secret (or its ciphertext)', p._bodies.length + ' responses');
    await p.select('#stSmtpAuth', 'password');
    const back = await p.evaluate(() => ({ pass: document.getElementById('stSmtpPassGroup').offsetParent !== null, oauth: document.getElementById('stSmtpOauthGroup').offsetParent !== null }));
    ok(back.pass && !back.oauth, 'switching back to "Mailbox password" shows the password box again', JSON.stringify(back));

    // ── 7. Send Test ──
    await sleep(500);
    await domClick(p, '#testNotifBtn');
    await p.waitForFunction(() => /accepted/i.test(Array.from(document.querySelectorAll('.tm-toast__message')).map(t => t.textContent).join(' ')), { timeout: 20000 });
    const tt = await toastText(p);
    ok(/accepted the test email/.test(tt) && !/email sent to/i.test(tt), 'Send Test says the mail server ACCEPTED the message (not "sent")', tt);
    await shot(p, 'smtp-card-saved');

    // ── 7b. the Email Logs page shows that attempt, and says "accepted" rather than implying inbox delivery ──
    await p.evaluate(() => window.switchTab('emailLogsAdmin'));
    await p.evaluate(() => window.loadEmailLogs());
    await p.waitForFunction(() => document.querySelector('#emailLogsAdmin tbody tr td span[title]'), { timeout: 15000 }).catch(() => {});
    const logRow = await p.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('#emailLogsAdmin tbody tr')).filter(r => /Admin: Test Notification/.test(r.textContent));
        const span = rows[0] && rows[0].querySelector('span[title]');
        return rows.length ? { status: span && span.textContent.trim(), tip: span && span.getAttribute('title') } : null;
    });
    ok(!!logRow && /success/i.test(logRow.status) && /Accepted by the mail server/.test(logRow.tip) && /inbox delivery is not confirmed/.test(logRow.tip), 'Email Logs lists the Send Test attempt and its status tooltip says "accepted ... inbox delivery is not confirmed"', JSON.stringify(logRow));

    ok(p._errs.length === 0, 'no page errors during the whole flow', p._errs.join(' | '));
    await p.close();

    // ── 8. non-administrators do not see the card ──
    const m = await openAdmin(browser, managerCookie);
    const mgr = await m.evaluate(() => { const c = document.getElementById('stSmtpCard'); return { shown: !!c && c.offsetParent !== null, pw: !!document.getElementById('stSmtpPass') && document.getElementById('stSmtpPass').offsetParent !== null }; });
    ok(!mgr.shown && !mgr.pw, 'a manager does not see the Email (SMTP) card at all', JSON.stringify(mgr));
    ok(m._bodies.every(b => !/smtp/i.test(b)), 'and the settings API sent that manager no smtp data', m._bodies.join(' ').slice(0, 200));
    await m.close();

    // ── 8b. an administrator keeps the card when the server answers in a different shape ──
    // (a) an older server: SMTP fields inside the settings map, no smtp section
    const legacy = await openAdmin(browser, adminCookie, { rewriteSettings: (j) => { const { smtp, ...rest } = j; return { ...rest, settings: { ...rest.settings, smtp_host: 'smtp.example.invalid', smtp_port: '587', smtp_user: 'old@example.invalid', smtp_from: 'old@example.invalid', smtp_pass: 'x' } }; } });
    const lg = await legacy.evaluate(() => ({ shown: document.getElementById('stSmtpCard').offsetParent !== null, host: document.getElementById('stSmtpHost').value, user: document.getElementById('stSmtpUser').value, pw: document.getElementById('stSmtpPass').value, status: document.getElementById('stSmtpStatus').textContent }));
    ok(lg.shown && lg.host === 'smtp.example.invalid' && lg.user === 'old@example.invalid' && lg.pw === '' && /previous version/.test(lg.status), 'an administrator still sees the card, filled from an older server\'s response, with a restart notice (the password is never shown)', JSON.stringify(lg));
    await legacy.close();
    // (b) the server could not build the smtp status
    const broken = await openAdmin(browser, adminCookie, { rewriteSettings: (j) => { const { smtp, ...rest } = j; return { ...rest, smtpError: true }; } });
    const bk = await broken.evaluate(() => ({ shown: document.getElementById('stSmtpCard').offsetParent !== null, status: document.getElementById('stSmtpStatus').textContent }));
    ok(bk.shown && /could not be loaded/.test(bk.status), 'an administrator still sees the card, with a clear message, when the email status could not be loaded', JSON.stringify(bk));
    await broken.close();

    // ── 9. phone width ──
    const ph = await openAdmin(browser, adminCookie, { width: 390, height: 900 });
    const overflow = await ph.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, cardW: document.getElementById('stSmtpCard').getBoundingClientRect().width }));
    ok(overflow.sw <= overflow.cw + 1, 'at phone width the page does not scroll sideways', JSON.stringify(overflow));
    await ph.evaluate(() => document.getElementById('stSmtpCard').scrollIntoView());
    await shot(ph, 'smtp-card-phone');
    await ph.close();

    await sqlRun("DELETE FROM settings WHERE setting_key LIKE 'smtp\\_%' ESCAPE '\\'");
    await browser.close();
    await support.stop();
    console.log(fails ? `\n${fails} FAILURE(S)` : '\nALL PASS');
    process.exit(fails ? 1 : 0);
})().catch(async e => { console.error('ERR', e.stack || e.message); try { await support.stop(); } catch (_) {} process.exit(2); });
