// Admin appearance (Finish / House accent / Presence - js/appearance.js) is remembered per ACCOUNT on the server:
//   * choosing a look on one machine is saved for the account; a different machine (a browser with its own, empty storage) that signs in as the
//     same account gets that look; another account is not affected;
//   * a look chosen before this existed (only in one browser's storage) is given to the account by that browser, so other machines learn it;
//   * "Reset to house default" is remembered the same way; values the server does not know are refused.
// Boots the real app on an isolated database copy (test/support.js). Not part of `npm test`: run with `npm run test:browser`.
const support = require('../support');
const puppeteer = require('puppeteer');
const { BASE, sleep, loginAs } = support;
let fails = 0;
const ok = (c, n, detail) => { if (!c) fails++; console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '\n        -> ' + String(detail).slice(0, 400))); };

async function signIn(role) {
    const r = await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: `test.${role}@example.invalid`, password: 'TestRunnerPass1!' }) });
    return String(r.headers.get('set-cookie')).split(';')[0];
}
async function openAdmin(browser, cookie, prep) {
    const p = await (await browser.createBrowserContext()).newPage();   // its own storage = its own machine
    await p.setViewport({ width: 1440, height: 1000 });
    const errs = []; p.on('pageerror', e => errs.push(e.message.slice(0, 200)));
    const [name, ...rest] = cookie.split('=');
    await p.setCookie({ name, value: rest.join('='), url: BASE });
    if (prep) await p.evaluateOnNewDocument(prep);
    await p.setRequestInterception(true);
    p.on('request', r => /\/api\/admin\/maps-config/.test(r.url()) ? r.respond({ status: 200, contentType: 'application/json', body: '{"success":true,"key":""}' }) : r.continue());
    await p.goto(BASE + '/admin.html', { waitUntil: 'domcontentloaded', timeout: 90000 });
    await sleep(4500);
    p._errs = errs;
    return p;
}
const look = (p) => p.evaluate(() => { const e = document.documentElement; return [e.getAttribute('data-theme'), e.getAttribute('data-accent'), e.getAttribute('data-presence')].join('/'); });
const stored = (p) => p.evaluate(() => [localStorage.getItem('atl-theme'), localStorage.getItem('atl-accent'), localStorage.getItem('atl-presence')].join('/'));

(async () => {
    await support.start();
    let browser;
    try {
        await loginAs('administrator'); await loginAs('manager');
        const adminCookie = await signIn('administrator'), mgrCookie = await signIn('manager');
        browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'], executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined });
        const get = (c) => fetch(BASE + '/api/admin/preferences/appearance', { headers: { Cookie: c } }).then(r => r.json());
        const put = (c, body) => fetch(BASE + '/api/admin/preferences/appearance', { method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: c }, body: JSON.stringify(body) });

        // ---- API
        ok((await get(adminCookie)).appearance === null, 'API: nothing is saved until the account chooses', '');
        ok((await put(adminCookie, { theme: 'neon', accent: 'gold', presence: 'editorial' })).status === 400, 'API: an unknown value is refused', '');
        ok((await fetch(BASE + '/api/admin/preferences/appearance')).status === 401, 'API: signed-out visitors cannot read it', '');

        // ---- machine A: choose a look in the real panel
        const a = await openAdmin(browser, adminCookie);
        ok((await look(a)) === 'dark/gold/editorial', 'machine A starts on the house look', await look(a));
        await a.evaluate(() => { window.atlAppearance.set('theme', 'light'); window.atlAppearance.set('accent', 'cassis'); window.atlAppearance.set('presence', 'boutique'); });
        await sleep(1200);
        const saved = (await get(adminCookie)).appearance;
        ok(saved && saved.theme === 'light' && saved.accent === 'cassis' && saved.presence === 'boutique', 'the look is saved for the account on the server', JSON.stringify(saved));

        // ---- machine B: same account, nothing in its storage
        const b = await openAdmin(browser, adminCookie);
        ok((await look(b)) === 'light/cassis/boutique', 'machine B (same account, empty storage) gets the account\'s look', await look(b));
        ok((await stored(b)) === 'light/cassis/boutique', 'machine B keeps it in its own storage for the next paint', await stored(b));
        ok(await b.evaluate(() => [...document.querySelectorAll('.atl-appearance__input:checked')].every(i => ['light', 'cassis', 'boutique'].includes(i.value)) || !document.querySelector('.atl-appearance__input')), 'machine B: the picker shows the same choices', '');

        // ---- another account is unaffected
        const m = await openAdmin(browser, mgrCookie);
        ok((await look(m)) === 'dark/gold/editorial', 'another account (manager) still has the house look', await look(m));
        ok((await get(mgrCookie)).appearance === null, "the manager's saved look is untouched", '');

        // ---- a change on B reaches a third machine
        await b.evaluate(() => window.atlAppearance.set('accent', 'vetiver')); await sleep(1200);
        const c = await openAdmin(browser, adminCookie);
        ok((await look(c)) === 'light/vetiver/boutique', 'a change on machine B shows up on machine C', await look(c));

        // ---- reset is remembered too
        await c.evaluate(() => window.atlAppearance.reset()); await sleep(1200);
        const d = await openAdmin(browser, adminCookie);
        ok((await look(d)) === 'dark/gold/editorial', 'Reset to house default is remembered by another machine', await look(d));

        // ---- an older, browser-only look is given to the account (manager has none saved; their browser already has one)
        const e = await openAdmin(browser, mgrCookie, () => { try { localStorage.setItem('atl-theme', 'ember'); localStorage.setItem('atl-accent', 'cuivre'); localStorage.setItem('atl-presence', 'operations'); } catch (x) {} });
        await sleep(1500);
        ok((await look(e)) === 'ember/cuivre/operations', 'a browser that already had its own look keeps it', await look(e));
        const mg = (await get(mgrCookie)).appearance;
        ok(mg && mg.theme === 'ember' && mg.accent === 'cuivre' && mg.presence === 'operations', 'and gives it to the account, so other machines learn it', JSON.stringify(mg));
        const f = await openAdmin(browser, mgrCookie);
        ok((await look(f)) === 'ember/cuivre/operations', "the manager's other machine gets it", await look(f));

        for (const [n, p] of [['A', a], ['B', b], ['manager', m], ['C', c], ['D', d], ['E', e], ['F', f]]) ok(p._errs.length === 0, `no page errors (${n})`, p._errs.join(' | '));
    } finally {
        if (browser) await browser.close();
        await support.stop();
    }
    console.log(fails ? `\n${fails} appearance-persist check(s) FAILED` : '\nAll appearance persistence checks passed');
    process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
