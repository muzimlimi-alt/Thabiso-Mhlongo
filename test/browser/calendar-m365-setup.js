// Calendar -> Settings -> Microsoft 365 Calendar card carries the same Outgoing Mail form as Email -> Inquiries -> Setup
// (js/admin/system-settings.js; ids <prefix>Smtp..., prefix st = Email Setup, cm = Calendar settings):
//   * the card is there for an administrator and shows what is saved, the same as Email Setup;
//   * the sign-in method switches the password box / the three OAuth fields;
//   * field checks use the card's own error lines; Test Connection sends exactly what is typed to the same endpoint as Email Setup;
//   * Save sends the one PUT /api/admin/settings the Setup card sends, and afterwards BOTH copies show the saved values.
// Boots the real app on an isolated database copy (test/support.js). Not part of `npm test`: run with `npm run test:browser`.
const support = require('../support');
const puppeteer = require('puppeteer');
const { BASE, sleep } = support;
let fails = 0;
const ok = (c, n, detail) => { if (!c) fails++; console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '\n        -> ' + String(detail).slice(0, 500))); };

(async () => {
    await support.start();
    let browser;
    try {
        await support.loginAs('administrator');
        const lr = await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'test.administrator@example.invalid', password: 'TestRunnerPass1!' }) });
        const raw = lr.headers.get('set-cookie');
        browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'], executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined });
        const p = await (await browser.createBrowserContext()).newPage();
        await p.setViewport({ width: 1440, height: 1000 });
        const errs = [], posts = [], puts = [];
        p.on('pageerror', e => errs.push(e.message.slice(0, 200)));
        const [name, ...rest] = String(raw).split(';')[0].split('=');
        await p.setCookie({ name, value: rest.join('='), url: BASE });
        await p.setRequestInterception(true);
        p.on('request', r => {
            const u = r.url();
            if (/\/api\/admin\/maps-config/.test(u)) return r.respond({ status: 200, contentType: 'application/json', body: '{"success":true,"key":""}' });
            if (/settings\/smtp\/test-connection/.test(u) && r.method() === 'POST') {   // never open a real mail connection from a test
                posts.push(JSON.parse(r.postData() || '{}'));
                return r.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, result: { ok: true, message: 'Connected as test (stub)' }, warnings: [] }) });
            }
            if (/\/api\/admin\/settings$/.test(u) && r.method() === 'PUT') {
                puts.push(JSON.parse(r.postData() || '{}'));
                return r.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, smtp: { host: 'smtp.office365.com', port: 587, secure: 'starttls', user: 'bookings@example.invalid', from: 'bookings@example.invalid', fromName: 'Test Sender', auth: 'oauth', oauthTenant: '11111111-2222-3333-4444-555555555555', oauthClient: '66666666-7777-8888-9999-000000000000', secretSet: true, passwordSet: false, source: 'settings', secretSource: 'settings', active: { host: 'smtp.office365.com', port: 587, user: 'bookings@example.invalid' }, ok: true, problems: [], incomplete: [], warnings: [] }, warnings: [] }) });
            }
            r.continue();
        });
        await p.goto(BASE + '/admin.html', { waitUntil: 'domcontentloaded', timeout: 90000 });
        await sleep(3500);
        await p.evaluate(() => window.switchTab('calendarAdmin'));
        await sleep(1500);
        await p.evaluate(() => { const b = document.getElementById('calSettingsTabBtn'); if (b) b.style.display = ''; b && b.click(); });
        await sleep(2500);

        ok(await p.evaluate(() => !!document.getElementById('cmSmtpCard') && document.getElementById('cmSmtpCard').offsetParent !== null), 'the Microsoft 365 Calendar card is on the Calendar settings page with the mail form', 'card missing or hidden');
        ok(await p.evaluate(() => !!document.querySelector('#cmSmtpCard #cmSmtpHost') && !!document.querySelector('#cmSmtpCard #cmSmtpAuth') && !!document.querySelector('#cmSmtpCard #btnSaveSmtpCm') && !!document.querySelector('#cmSmtpCard #cmSmtpTestBtn')), 'host, sign-in method, Test Connection and Save are all in the card', '');
        const same = await p.evaluate(() => ['Host', 'Port', 'Secure', 'Auth', 'User', 'From', 'FromName'].every(n => document.getElementById('cmSmtp' + n).value === document.getElementById('stSmtp' + n).value));
        ok(same, 'it shows the same saved values as Email Setup', '');
        ok(await p.evaluate(() => /Active|Not fully|legacy|server/i.test(document.getElementById('cmSmtpStatus').textContent)), 'its status line is filled in', await p.evaluate(() => document.getElementById('cmSmtpStatus').textContent));

        await sleep(2500);   // the form is filled by an async settings load: let every load finish before typing
        // switching sign-in method
        await p.select('#cmSmtpAuth', 'oauth'); await sleep(200);
        const vis = await p.evaluate(() => ({ oauth: document.getElementById('cmSmtpOauthGroup').offsetParent !== null, pass: document.getElementById('cmSmtpPassGroup').offsetParent !== null, stOauthUntouched: document.getElementById('stSmtpOauthGroup').style.display }));
        ok(vis.oauth && !vis.pass, 'choosing OAuth shows the tenant / client / secret fields and hides the password', JSON.stringify(vis));
        ok(vis.stOauthUntouched !== 'block', "...and does not change Email Setup's own form", JSON.stringify(vis));

        // validation lines belong to this card
        await p.evaluate(() => { document.getElementById('cmSmtpTenant').value = 'not a guid'; document.getElementById('cmSmtpClient').value = 'nope'; });
        await p.click('#cmSmtpTestBtn'); await sleep(400);
        const errsShown = await p.evaluate(() => ({ t: document.getElementById('errCmTenant').textContent, c: document.getElementById('errCmClient').textContent, st: document.getElementById('errStTenant').textContent }));
        ok(/tenant/i.test(errsShown.t) && /GUID/i.test(errsShown.c) && errsShown.st === '', 'bad tenant / client ids are flagged on this card only', JSON.stringify(errsShown));
        ok(posts.length === 0, 'nothing is sent while a field is invalid', posts.length);

        // Test Connection sends what is typed
        const T = '11111111-2222-3333-4444-555555555555', C = '66666666-7777-8888-9999-000000000000';
        await p.evaluate((T, C) => { document.getElementById('cmSmtpTenant').value = T; document.getElementById('cmSmtpClient').value = C; document.getElementById('cmSmtpSecret').value = 'sEcretVALUE~1'; document.getElementById('cmSmtpUser').value = 'bookings@example.invalid'; }, T, C);
        await p.click('#cmSmtpTestBtn'); await sleep(900);
        ok(posts.length === 1 && posts[0].smtp_auth === 'oauth' && posts[0].smtp_oauth_tenant === T && posts[0].smtp_oauth_client === C && posts[0].smtp_oauth_secret === 'sEcretVALUE~1' && posts[0].smtp_user === 'bookings@example.invalid', 'Test Connection sends the typed OAuth details to the same endpoint', JSON.stringify(posts));
        ok(await p.evaluate(() => /Connected as test/.test(document.getElementById('cmSmtpTestResult').textContent)), 'and shows the result under the button', await p.evaluate(() => document.getElementById('cmSmtpTestResult').textContent));

        // Save: same PUT, then both copies show the saved values
        await p.click('#btnSaveSmtpCm'); await sleep(1200);
        ok(puts.length === 1 && puts[0].settings && puts[0].settings.smtp_oauth_tenant === T && puts[0].settings.smtp_auth === 'oauth', 'Save sends the same settings request as Email Setup', JSON.stringify(puts));
        const after = await p.evaluate(() => ({ cm: document.getElementById('cmSmtpFromName').value, st: document.getElementById('stSmtpFromName').value, stAuth: document.getElementById('stSmtpAuth').value, secretCleared: document.getElementById('cmSmtpSecret').value === '' }));
        ok(after.cm === 'Test Sender' && after.st === 'Test Sender' && after.stAuth === 'oauth' && after.secretCleared, 'afterwards both copies show the saved values and the secret box is cleared', JSON.stringify(after));
        ok(errs.length === 0, 'no page errors', errs.join(' | '));
    } finally {
        if (browser) await browser.close();
        await support.stop();
    }
    console.log(fails ? `\n${fails} calendar-m365-setup check(s) FAILED` : '\nAll Microsoft 365 calendar setup checks passed');
    process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
