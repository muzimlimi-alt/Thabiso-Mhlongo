// System > Integrations -> Google Calendar (the card) and Admin -> Calendar (the Google strip), driven through the REAL admin.html on an isolated DB copy
// (test/support.js: SMTP mocked, the real database and Google are never touched). The server's answers are SIMULATED per scenario (puppeteer request interception on
// /api/admin/google-calendar*) so every connection state can be shown; the real routes and libraries are covered by test/google-calendar.test.js against a fake Google.
// This test is about what the administrator sees and can do: each state's wording and buttons, validation, saving + connecting, a failed save keeping what was typed,
// Test connection, Disconnect (with its confirmation), coming back from Google, what other roles see, untrusted text staying text, and the phone layout.
//
// Not part of `npm test`: run it with `npm run test:browser` (needs PUPPETEER_EXECUTABLE_PATH on this machine, see test-suite notes).
const support = require('../support');
const puppeteer = require('puppeteer');
const { BASE, sleep } = support;
let fails = 0;
const ok = (c, n, detail) => { if (!c) fails++; console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '\n        -> ' + detail)); };
const PASSWORD = 'TestRunnerPass1!';
const SHOTS = process.env.GCAL_SHOTS_DIR || null;
const CB = '/api/admin/google-calendar/callback';
const CID = '555555555555-browsertestclient0000' + '.apps.googleusercontent.com';

async function cookieFor(email) {
    const r = await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: PASSWORD }) });
    const sc = r.headers.get('set-cookie');
    if (r.status !== 200 || !sc) throw new Error('login failed for ' + email + ': ' + r.status);
    return sc.split(';')[0];
}

// The status the server would give, per state. `over` overrides single fields.
const view = (state, over = {}) => Object.assign({
    success: true, canManage: true, redirectUri: BASE + CB, problems: [],
    state, connected: state === 'connected', clientId: state === 'none' ? '' : CID, secretSet: state !== 'none',
    idSource: state === 'none' ? null : 'settings', secretSource: state === 'none' ? null : 'settings', tokenSource: state === 'connected' ? 'settings' : null,
    account: state === 'connected' ? 'owner@example.test' : null, connectedAt: state === 'connected' ? '2026-10-01T08:00:00.000Z' : null
}, over);

// Opens admin.html as `cookie`. p.google is the table of simulated answers: { 'GET ': {status, json} | fn, 'PUT /credentials': ..., 'POST /connect': ..., 'POST /test': ..., 'DELETE ': ... }.
async function openAdmin(browser, cookie, { width = 1440, height = 1100, query = '', google = {} } = {}) {
    const ctx = await browser.createBrowserContext();
    const p = await ctx.newPage();
    await p.setViewport({ width, height });
    p.errs = []; p.google = google; p.calls = []; p.navigations = [];
    p.on('pageerror', e => p.errs.push(e.message.slice(0, 200)));
    p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|Loading the font|API Error|google-consent-stub/.test(m.text())) p.errs.push('console: ' + m.text().slice(0, 200)); });
    const [name, ...rest] = cookie.split('=');
    await p.setCookie({ name, value: rest.join('='), url: BASE });
    await p.setRequestInterception(true);
    p.on('request', r => {
        const u = new URL(r.url());
        if (/\/api\/admin\/maps-config/.test(u.pathname)) return r.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, key: '' }) });
        if (u.pathname.startsWith('/api/admin/google-calendar') && u.pathname !== CB) {
            const key = r.method() + ' ' + u.pathname.slice('/api/admin/google-calendar'.length);
            p.calls.push({ key, body: r.postData() || null });
            const h = p.google[key];
            if (h) { const v = typeof h === 'function' ? h(r) : h; return r.respond({ status: v.status || 200, contentType: 'application/json', body: JSON.stringify(v.json) }); }
        }
        if (r.isNavigationRequest() && /google-consent-stub/.test(u.pathname)) { p.navigations.push(r.url()); return r.respond({ status: 200, contentType: 'text/html', body: '<p>stub</p>' }); }
        r.continue();
    });
    await p.goto(BASE + '/admin.html' + query, { waitUntil: 'networkidle0', timeout: 90000 });
    await p.waitForFunction(() => typeof window.switchTab === 'function' && !!window.currentUserRole, { timeout: 30000 });
    return p;
}
const goSettings = async (p) => { await p.evaluate(() => window.admNav.go('integrationsAdmin', { tab: 'intPanelGoogle' })); await p.waitForFunction(() => { const c = document.getElementById('stGoogleCard'); return c && getComputedStyle(c).display !== 'none'; }, { timeout: 15000 }); await p.evaluate(() => document.getElementById('stGoogleCard').scrollIntoView({ block: 'start' })); await sleep(300); };
const goCalendar = async (p) => { await p.evaluate(() => window.switchTab('calendarAdmin')); await p.waitForFunction(() => { const s = document.getElementById('calGoogleStrip'); return s && !s.hidden; }, { timeout: 30000 }); await sleep(200); };
const reload = async (p) => { await p.evaluate(() => window.loadGoogleCalendarCard()); await sleep(250); };
const card = (p) => p.evaluate(() => {
    const g = (id) => document.getElementById(id);
    const cs = (e) => e ? getComputedStyle(e) : {};
    return {
        shown: getComputedStyle(g('stGoogleCard')).display !== 'none',
        status: g('stGoogleStatus').textContent, statusColor: cs(g('stGoogleStatus')).color,
        id: g('stGoogleClientId').value, secret: g('stGoogleSecret').value, secretPh: g('stGoogleSecret').getAttribute('placeholder'), redirect: g('stGoogleRedirect').value,
        connectLabel: g('stGoogleConnectBtn').textContent.trim(), connectDisabled: g('stGoogleConnectBtn').disabled, testDisabled: g('stGoogleTestBtn').disabled, disconnectDisabled: g('stGoogleDisconnectBtn').disabled,
        result: g('stGoogleResult').textContent, resultColor: cs(g('stGoogleResult')).color,
        errClient: cs(g('errStGoogleClient')).display === 'none' ? '' : g('errStGoogleClient').textContent, errSecret: cs(g('errStGoogleSecret')).display === 'none' ? '' : g('errStGoogleSecret').textContent
    };
});
const strip = (p) => p.evaluate(() => {
    const s = document.getElementById('calGoogleStrip'), b = document.getElementById('calGoogleSetup');
    return { hidden: s.hidden, cls: s.className, text: document.getElementById('calGoogleText').textContent, btnShown: !b.hidden && getComputedStyle(b).display !== 'none', btn: b.textContent.trim() };
});
const typeInto = async (p, sel, text) => { await p.click(sel, { clickCount: 3 }); await p.keyboard.press('Backspace'); if (text) await p.type(sel, text); };

(async () => {
    await support.start();
    await support.loginAs('manager');
    await support.loginAs('assistant');
    const adminCookie = await cookieFor('test.runner@example.invalid');
    const assistantCookie = await cookieFor('test.assistant@example.invalid');
    const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-quic'] });

    // ═══════════ the real server, nothing simulated ═══════════
    {
        const p = await openAdmin(browser, adminCookie);
        await goSettings(p);
        await sleep(600);
        const c = await card(p);
        ok(c.shown && c.status.length > 20 && !/could not be loaded/.test(c.status) && c.redirect === BASE + CB, 'against the real server the administrator gets the card with a real status and the exact redirect address', JSON.stringify(c));
        ok(await p.evaluate(() => !!document.querySelector('#stGoogleCard .fa-google') && document.querySelectorAll('#stGoogleCard button').length === 4), 'the card has its Google mark and its four buttons (Copy, Connect, Test, Disconnect)', '');
        await goCalendar(p);
        const s = await strip(p);
        ok(!s.hidden && s.text.length > 20 && s.btnShown, 'against the real server the Calendar shows the Google strip with a button for the administrator', JSON.stringify(s));
        ok(p.errs.length === 0, 'no script errors on the real pages', p.errs.join(' | '));
        await p.close();
    }

    // ═══════════ the Calendar strip, administrator ═══════════
    {
        const p = await openAdmin(browser, adminCookie, { google: { 'GET ': { json: view('none') } } });
        await goCalendar(p);
        let s = await strip(p);
        ok(/not connected/i.test(s.text) && /--off/.test(s.cls) && s.btnShown && s.btn === 'Set up', 'strip, nothing set up: says Google is not connected, neutral colour, offers "Set up"', JSON.stringify(s));
        p.google['GET '] = { json: view('incomplete') };
        await p.evaluate(() => window.calGoogleRefreshStrip()); await sleep(300);
        s = await strip(p);
        ok(/not connected/i.test(s.text) && /--warn/.test(s.cls) && s.btn === 'Connect', 'strip, client saved but no sign-in: warning colour, offers "Connect"', JSON.stringify(s));
        p.google['GET '] = { json: view('connected') };
        await p.evaluate(() => window.calGoogleRefreshStrip()); await sleep(300);
        s = await strip(p);
        ok(/connected as owner@example\.test/i.test(s.text) && /--ok/.test(s.cls) && s.btn === 'Settings', 'strip, connected: names the account, green, offers "Settings"', JSON.stringify(s));
        if (SHOTS) await p.screenshot({ path: SHOTS + '/google-strip-connected.png' });
        p.google['GET '] = { json: view('none') };
        await p.evaluate(() => window.calGoogleRefreshStrip()); await sleep(300);
        await p.click('#calGoogleSetup');
        await p.waitForFunction(() => { const c = document.getElementById('stGoogleCard'); return c && getComputedStyle(c).display !== 'none' && c.getBoundingClientRect().height > 100; }, { timeout: 15000 });
        const onSettings = await p.evaluate(() => { const sec = document.getElementById('integrationsAdmin'); return !!sec && getComputedStyle(sec).display !== 'none'; });
        ok(onSettings, '"Set up" on the strip takes the administrator straight to System > Integrations with the Google card showing', '');
        await p.close();
    }

    // ═══════════ the Calendar strip, other roles ═══════════
    {
        const p = await openAdmin(browser, assistantCookie, { google: { 'GET ': { json: { success: true, canManage: false, state: 'none', connected: false, account: null } } } });
        await goCalendar(p);
        const s = await strip(p);
        ok(/administrator/i.test(s.text) && !s.btnShown, 'an assistant sees the Google strip, is told an administrator can connect it, and is offered no button', JSON.stringify(s));
        await p.evaluate(() => window.switchTab('integrationsAdmin')); await sleep(600);
        ok(await p.evaluate(() => getComputedStyle(document.getElementById('stGoogleCard')).display === 'none'), 'an assistant never sees the Google settings card', '');
        ok(p.errs.length === 0, 'no script errors for an assistant', p.errs.join(' | '));
        await p.close();
    }

    // ═══════════ the card: each state ═══════════
    const pa = await openAdmin(browser, adminCookie, { google: { 'GET ': { json: view('none') } } });
    await goSettings(pa);
    let c = await card(pa);
    ok(/Not set up/.test(c.status) && c.connectLabel === 'Save & connect Google' && c.testDisabled && c.disconnectDisabled && !c.connectDisabled && c.id === '' && c.redirect === BASE + CB, 'card, nothing set up: explains what to do, "Save & connect Google" is the action, Test and Disconnect are off, the redirect address is shown', JSON.stringify(c));
    ok(c.secretPh === 'GOCSPX-…', 'card, nothing set up: the secret box invites a secret (no "saved" mask)', c.secretPh);
    if (SHOTS) await pa.screenshot({ path: SHOTS + '/google-card-none.png' });

    pa.google['GET '] = { json: view('incomplete') };
    await reload(pa); c = await card(pa);
    ok(/not connected yet/.test(c.status) && c.connectLabel === 'Connect Google' && !c.testDisabled && c.disconnectDisabled && c.id === CID && /saved/.test(c.secretPh) && c.secret === '', 'card, client saved: "Connect Google"; the client ID is filled in, the secret box shows a "saved" mask and is empty; Test on, Disconnect off', JSON.stringify(c));

    pa.google['GET '] = { json: view('incomplete', { secretSet: false, secretSource: null }) };
    await reload(pa); c = await card(pa);
    ok(/secret is missing/.test(c.status) && c.connectLabel === 'Save & connect Google', 'card, client ID saved but no secret: says the secret is missing', JSON.stringify(c));

    pa.google['GET '] = { json: view('connected') };
    await reload(pa); c = await card(pa);
    ok(/Connected as owner@example\.test since [\w ,.]*2026/.test(c.status) && c.connectLabel === 'Reconnect Google' && !c.testDisabled && !c.disconnectDisabled, 'card, connected: names the account and the date, offers "Reconnect Google"; Test and Disconnect are on', JSON.stringify(c));
    if (SHOTS) await pa.screenshot({ path: SHOTS + '/google-card-connected.png' });

    pa.google['GET '] = { json: view('connected', { tokenSource: 'environment', idSource: 'environment', secretSource: 'environment', account: null, connectedAt: null }) };
    await reload(pa); c = await card(pa);
    ok(/server environment/.test(c.status) && c.connectLabel === 'Reconnect Google' && c.disconnectDisabled && !c.testDisabled, 'card, connected through the server environment: says so; Disconnect is off (there is nothing saved to forget); Test is on', JSON.stringify(c));

    pa.google['GET '] = { json: view('incomplete', { problems: ['The saved Google client secret cannot be decrypted (the server encryption key changed) - enter it again'] }) };
    await reload(pa); c = await card(pa);
    ok(/cannot be decrypted/.test(c.status) && c.statusColor !== (await pa.evaluate(() => getComputedStyle(document.getElementById('stGoogleResult')).color)), 'card, a problem the server reports (changed encryption key): shown in the warning colour', JSON.stringify(c));

    // ═══════════ validation: nothing is sent for bad input ═══════════
    pa.google['GET '] = { json: view('none') };
    await reload(pa);
    pa.calls.length = 0;
    await pa.click('#stGoogleConnectBtn'); await sleep(200);
    c = await card(pa);
    ok(/Enter the OAuth client ID/.test(c.errClient) && !pa.calls.some(x => x.key !== 'GET '), 'connect with nothing entered: asks for the client ID, sends nothing', JSON.stringify({ c, calls: pa.calls }));
    await typeInto(pa, '#stGoogleClientId', 'not-a-client-id');
    await pa.click('#stGoogleConnectBtn'); await sleep(200);
    c = await card(pa);
    ok(/apps\.googleusercontent\.com/.test(c.errClient) && !pa.calls.some(x => x.key !== 'GET '), 'connect with a malformed client ID: says what a client ID looks like, sends nothing', JSON.stringify(c));
    await typeInto(pa, '#stGoogleClientId', CID);
    await typeInto(pa, '#stGoogleSecret', '{"web":{"client_secret":"abc"}}');
    await pa.click('#stGoogleConnectBtn'); await sleep(200);
    c = await card(pa);
    ok(/not the downloaded JSON/.test(c.errSecret) && c.errClient === '' && !pa.calls.some(x => x.key !== 'GET '), 'connect with the downloaded JSON pasted as the secret: refused on the spot, nothing sent, the client ID error is cleared', JSON.stringify(c));
    await typeInto(pa, '#stGoogleSecret', 'has a space in it');
    await pa.click('#stGoogleConnectBtn'); await sleep(200);
    c = await card(pa);
    ok(/no spaces/.test(c.errSecret) && !pa.calls.some(x => x.key !== 'GET '), 'a secret with spaces is refused on the spot', JSON.stringify(c));

    // ═══════════ a failed save keeps what was typed ═══════════
    const SECRET = 'GOCSPX' + '-typed_Secret-VALUE-12345';
    await typeInto(pa, '#stGoogleSecret', SECRET);
    pa.google['PUT /credentials'] = { status: 400, json: { success: false, message: 'Google settings not saved: That does not look like a Google OAuth client ID.' } };
    pa.calls.length = 0;
    await pa.click('#stGoogleConnectBtn'); await sleep(500);
    c = await card(pa);
    ok(c.id === CID && c.secret === SECRET && /not saved/.test(c.result) && pa.calls.map(x => x.key).join() === 'PUT /credentials' && !c.connectDisabled && pa.navigations.length === 0,
        'a rejected save keeps the client ID AND the secret exactly as typed, shows the server\'s reason, does not go on to Google, and gives the button back', JSON.stringify({ c, calls: pa.calls.map(x => x.key) }));

    // ═══════════ saving + connecting ═══════════
    pa.google['PUT /credentials'] = { json: Object.assign(view('incomplete'), { signInCleared: false }) };
    pa.google['POST /connect'] = { json: { success: true, url: BASE + '/google-consent-stub?client_id=' + encodeURIComponent(CID) } };
    pa.calls.length = 0;
    await pa.click('#stGoogleConnectBtn');
    await pa.waitForFunction(() => true); await sleep(900);
    const keys = pa.calls.map(x => x.key);
    const put = pa.calls.find(x => x.key === 'PUT /credentials');
    ok(keys.join() === 'PUT /credentials,POST /connect', 'Save & connect: saves the client first, then asks for the Google address - in that order, once each', keys.join());
    ok(put && JSON.parse(put.body).clientId === CID && JSON.parse(put.body).clientSecret === SECRET, 'Save & connect: the client ID and the secret reach the server exactly as typed', put && put.body);
    ok(pa.navigations.length === 1 && pa.navigations[0].includes('google-consent-stub'), 'Save & connect: the browser is then sent to the Google address the server returned', JSON.stringify(pa.navigations));
    await pa.close();

    // ═══════════ connecting again with nothing new typed ═══════════
    {
        const p = await openAdmin(browser, adminCookie, { google: { 'GET ': { json: view('incomplete') }, 'POST /connect': { json: { success: true, url: BASE + '/google-consent-stub?again=1' } } } });
        await goSettings(p); p.calls.length = 0;
        await p.click('#stGoogleConnectBtn'); await sleep(800);
        ok(p.calls.map(x => x.key).join() === 'POST /connect' && p.navigations.length === 1, '"Connect Google" with the saved client and nothing typed goes straight to Google without re-saving anything', p.calls.map(x => x.key).join());
        await p.close();
    }

    // ═══════════ Test connection ═══════════
    {
        const HOSTILE = '<img src=x onerror="window.__xss=1"> Google said <b>no</b>';
        const p = await openAdmin(browser, adminCookie, { google: { 'GET ': { json: view('connected') }, 'POST /test': { json: { success: true, ok: false, steps: [{ key: 'credentials', label: 'Credentials saved', ok: true, message: 'Fine.' }, { key: 'signin', label: 'Sign in to Google', ok: false, message: HOSTILE }] } } } });
        await goSettings(p);
        await p.click('#stGoogleTestBtn'); await sleep(700);
        const r = await p.evaluate(() => { const e = document.getElementById('stGoogleResult'); return { text: e.textContent, color: getComputedStyle(e).color, kids: e.children.length, xss: window.__xss === 1 }; });
        ok(r.text === '✓ Credentials saved: Fine.\n✗ Sign in to Google: ' + HOSTILE && r.kids === 0 && !r.xss, 'Test connection: one line per step with a tick or a cross, and what Google said is shown as plain text (no markup is created)', JSON.stringify(r));
        const green = await (async () => { p.google['POST /test'] = { json: { success: true, ok: true, steps: [{ ok: true, label: 'Credentials saved', message: 'ok' }, { ok: true, label: 'Sign in to Google', message: 'ok' }, { ok: true, label: 'Read and change the calendar', message: 'Connected to owner@example.test' }] } }; await p.click('#stGoogleTestBtn'); await sleep(700); return p.evaluate(() => getComputedStyle(document.getElementById('stGoogleResult')).color); })();
        ok(green !== r.color, 'Test connection: a fully green result is shown in a different colour from a failed one', green + ' vs ' + r.color);
        const btnBack = await p.evaluate(() => { const b = document.getElementById('stGoogleTestBtn'); return { disabled: b.disabled, text: b.textContent.trim() }; });
        ok(!btnBack.disabled && btnBack.text === 'Test connection', 'Test connection: the button is given back with its own label', JSON.stringify(btnBack));
        await p.close();
    }

    // ═══════════ Disconnect ═══════════
    {
        const p = await openAdmin(browser, adminCookie, { google: { 'GET ': { json: view('connected') }, 'DELETE ': { json: Object.assign(view('incomplete'), { revoked: true, stillConnectedViaEnvironment: false }) } } });
        await goSettings(p);
        p.calls.length = 0;
        await p.click('#stGoogleDisconnectBtn');
        await p.waitForSelector('#tm-modal-confirm', { visible: true, timeout: 5000 });
        const modalText = await p.evaluate(() => document.querySelector('.tm-modal-container').textContent);
        ok(/stop being copied/.test(modalText) && /stay saved/.test(modalText), 'Disconnect asks first, and says what stops and that the client stays saved', modalText.slice(0, 300));
        await p.click('#tm-modal-cancel'); await sleep(400);
        ok(!p.calls.some(x => x.key === 'DELETE '), 'cancelling the question disconnects nothing', JSON.stringify(p.calls));
        await p.click('#stGoogleDisconnectBtn');
        await p.waitForSelector('#tm-modal-confirm', { visible: true, timeout: 5000 });
        await p.click('#tm-modal-confirm'); await sleep(800);
        c = await card(p);
        ok(p.calls.some(x => x.key === 'DELETE ') && !/^Connected/.test(c.status) && /revoke/.test(c.result) && c.disconnectDisabled && c.connectLabel === 'Connect Google', 'confirming disconnects: the card drops back to "not connected", says Google was asked to revoke, and Disconnect turns off', JSON.stringify({ c, calls: p.calls.map(x => x.key) }));
        p.google['DELETE '] = { json: Object.assign(view('connected', { tokenSource: 'environment', account: null }), { revoked: true, stillConnectedViaEnvironment: true }) };
        p.google['GET '] = { json: view('connected') }; await reload(p);
        await p.click('#stGoogleDisconnectBtn'); await p.waitForSelector('#tm-modal-confirm', { visible: true, timeout: 5000 }); await p.click('#tm-modal-confirm'); await sleep(800);
        c = await card(p);
        ok(/server still has its own Google sign-in/.test(c.result), 'disconnecting while the server environment still holds a sign-in says the calendar stays connected through that', JSON.stringify(c));
        await p.close();
    }

    // ═══════════ coming back from Google ═══════════
    {
        const p = await openAdmin(browser, adminCookie, { query: '?google=connected', google: { 'GET ': { json: view('connected') } } });
        await p.waitForFunction(() => { const c = document.getElementById('stGoogleCard'); return c && getComputedStyle(c).display !== 'none' && /connected/i.test(document.getElementById('stGoogleResult').textContent); }, { timeout: 20000 });
        c = await card(p);
        ok(c.result === 'Google Calendar is connected.' && /Connected as owner@example\.test/.test(c.status), 'returning from Google with success lands on the Google card, says it is connected, and shows the account', JSON.stringify(c));
        ok(!/google=/.test(await p.evaluate(() => location.href)), 'the ?google= marker is removed from the address bar', await p.evaluate(() => location.href));
        const toast = await p.evaluate(() => (document.body.textContent.match(/Google Calendar is connected\./g) || []).length);
        ok(toast >= 2, 'a success message also pops up', String(toast));
        await p.close();
    }
    for (const [outcome, expect] of [['redirect', /Authorized redirect URIs/], ['denied', /Access was not granted/], ['state', /expired|already been used/], ['api', /Calendar API is switched off/]]) {
        const p = await openAdmin(browser, adminCookie, { query: '?google=' + outcome, google: { 'GET ': { json: view('incomplete') } } });
        await p.waitForFunction(() => /\S/.test(document.getElementById('stGoogleResult').textContent), { timeout: 20000 });
        c = await card(p);
        const normal = await p.evaluate(() => getComputedStyle(document.getElementById('stGoogleStatus')).color);
        ok(expect.test(c.result) && c.resultColor !== normal && c.shown, `returning from Google with "${outcome}" explains it in plain words, in the warning colour, on the Google card`, JSON.stringify(c));
        await p.close();
    }
    {
        const p = await openAdmin(browser, adminCookie, { query: '?google=%3Cscript%3E', google: { 'GET ': { json: view('none') } } });
        await sleep(1500);
        ok(p.errs.length === 0 && await p.evaluate(() => !/script/.test(document.getElementById('stGoogleResult').textContent)), 'a hostile ?google= value changes nothing and is never echoed into the page', p.errs.join(' | '));
        await p.close();
    }

    // ═══════════ phone ═══════════
    {
        const p = await openAdmin(browser, adminCookie, { width: 390, height: 844, google: { 'GET ': { json: view('connected') } } });
        await goSettings(p);
        const m = await p.evaluate(() => {
            const card = document.getElementById('stGoogleCard').getBoundingClientRect();
            const btns = [...document.querySelectorAll('#stGoogleCard button')].map(b => b.getBoundingClientRect());
            return { overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth, cardW: card.width, vw: window.innerWidth, minBtnH: Math.min(...btns.map(b => b.height)), maxBtnRight: Math.max(...btns.map(b => b.right)) };
        });
        ok(m.overflow <= 1 && m.maxBtnRight <= m.vw && m.minBtnH >= 40, 'on a phone the card does not scroll sideways, every button fits the screen and is at least 40px tall', JSON.stringify(m));
        if (SHOTS) { await p.evaluate(() => document.getElementById('stGoogleCard').scrollIntoView()); await p.screenshot({ path: SHOTS + '/google-card-phone.png' }); }
        await goCalendar(p);
        const ms = await p.evaluate(() => ({ overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth, w: document.getElementById('calGoogleStrip').getBoundingClientRect().width, vw: window.innerWidth, btnH: document.getElementById('calGoogleSetup').getBoundingClientRect().height }));
        ok(ms.overflow <= 1 && ms.w <= ms.vw && ms.btnH >= 43, 'on a phone the Google strip fits the screen and its button is at least 44px tall', JSON.stringify(ms));
        if (SHOTS) await p.screenshot({ path: SHOTS + '/google-strip-phone.png' });
        ok(p.errs.length === 0, 'no script errors on a phone', p.errs.join(' | '));
        await p.close();
    }

    await browser.close();
    await support.stop();
    console.log(fails ? `\n${fails} FAILED` : '\nAll Google Calendar browser checks passed');
    process.exit(fails ? 1 : 0);
})().catch(async (e) => { console.error('BROWSER TEST ERROR', e); try { console.error(support.getChildLog().slice(-1500)); await support.stop(); } catch (_) {} process.exit(2); });
