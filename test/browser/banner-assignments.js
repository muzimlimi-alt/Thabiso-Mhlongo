// Email > Banners > Library: each banner card says WHICH outgoing emails use it (readable names, with their category), a banner with none says so,
// and a strip above the cards counts the emails that have a banner and names the ones that do not.
//   * GET /api/admin/banners carries used_by for every banner (the same rows the single-banner route returns);
//   * the card lists the assigned emails as chips; clicking one opens that banner's assign drawer; an unassigned banner offers "Assign";
//   * the coverage strip matches /api/admin/email-templates.
// Boots the real app on an isolated database copy (test/support.js). Not part of `npm test`: run with `npm run test:browser`.
const support = require('../support');
const puppeteer = require('puppeteer');
const { BASE, sleep, api, upload, makeTestPng } = support;
let fails = 0;
const ok = (c, n, detail) => { if (!c) fails++; console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '\n        -> ' + String(detail).slice(0, 500))); };
const png = () => ({ buffer: makeTestPng(1300, 60), filename: 'banner.png', contentType: 'image/png' });
const pretty = (k) => { const s = String(k).replace(/^admin_/i, 'Admin: ').replace(/[_-]+/g, ' ').trim(); return s.charAt(0).toUpperCase() + s.slice(1); };

(async () => {
    await support.start();
    let browser;
    try {
        await support.loginAs('administrator');
        const lr = await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'test.administrator@example.invalid', password: 'TestRunnerPass1!' }) });
        const raw = lr.headers.get('set-cookie');

        const stamp = Date.now();
        const used = (await upload('POST', '/api/admin/banners', { name: 'ZZ Used ' + stamp, category: 'Booking Confirmations', alt_text: 'used' }, png())).body;
        const idle = (await upload('POST', '/api/admin/banners', { name: 'ZZ Idle ' + stamp, category: 'Birthday', alt_text: 'idle' }, png())).body;
        const usedId = used.banner && used.banner.id, idleId = idle.banner && idle.banner.id;
        ok(!!usedId && !!idleId, 'setup: two banners created', JSON.stringify([used, idle]).slice(0, 200));

        const tpl = (await api('GET', '/api/admin/email-templates')).body.templates;
        const keys = tpl.slice(0, 3).map(t => t.template_key);
        const a = await api('PUT', '/api/admin/email-templates/assign', { template_keys: keys, banner_id: usedId });
        ok(a.status === 200 && keys.length === 3, 'setup: three outgoing emails assigned to the first banner', JSON.stringify(a.body));

        // ---- API
        const list = (await api('GET', '/api/admin/banners?limit=200')).body.banners;
        const u = list.find(b => b.id === usedId), i = list.find(b => b.id === idleId);
        ok(u && Array.isArray(u.used_by) && u.used_by.length === 3 && keys.every(k => u.used_by.some(x => x.template_key === k)), 'API: the list carries the banner\'s used_by (the three emails)', JSON.stringify(u && u.used_by));
        ok(i && Array.isArray(i.used_by) && i.used_by.length === 0, 'API: a banner with none has an empty used_by', JSON.stringify(i && i.used_by));
        ok(u.usage_count === 3, 'API: usage_count is unchanged', u.usage_count);

        // ---- page
        browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'], executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined });
        for (const [vp, w, h] of [['desktop', 1440, 1000], ['phone', 390, 844]]) {
            const p = await (await browser.createBrowserContext()).newPage();
            await p.setViewport({ width: w, height: h });
            const errs = []; p.on('pageerror', e => errs.push(e.message.slice(0, 200)));
            const [name, ...rest] = String(raw).split(';')[0].split('=');
            await p.setCookie({ name, value: rest.join('='), url: BASE });
            await p.setRequestInterception(true);
            p.on('request', r => /\/api\/admin\/maps-config/.test(r.url()) ? r.respond({ status: 200, contentType: 'application/json', body: '{"success":true,"key":""}' }) : r.continue());
            await p.goto(BASE + '/admin.html', { waitUntil: 'domcontentloaded', timeout: 90000 });
            await sleep(3500);
            await p.evaluate(() => window.switchTab('emailBannersAdmin'));
            await p.waitForFunction((id) => document.querySelector('#bnrCardGrid article[data-id="' + id + '"]'), { timeout: 20000 }, usedId).catch(() => {});
            await sleep(1200);

            const card = await p.evaluate((id) => {
                const c = document.querySelector('#bnrCardGrid article[data-id="' + id + '"]');
                return c ? { chips: [...c.querySelectorAll('.bnr-chip__name')].map(x => x.textContent), head: (c.querySelector('.bnr-used__head') || {}).textContent, visible: c.querySelector('.bnr-chip') ? c.querySelector('.bnr-chip').offsetParent !== null : false } : null;
            }, usedId);
            ok(card && keys.every(k => card.chips.includes(pretty(k))), `${vp}: the card lists the three assigned emails by readable name`, JSON.stringify(card));
            ok(card && /Used in 3 outgoing emails/i.test(card.head || ''), `${vp}: ...under "Used in 3 outgoing emails"`, card && card.head);
            const idleCard = await p.evaluate((id) => { const c = document.querySelector('#bnrCardGrid article[data-id="' + id + '"]'); return c ? { text: c.querySelector('.bnr-used--none') ? c.querySelector('.bnr-used--none').textContent : null, hasChips: !!c.querySelector('.bnr-chip') } : null; }, idleId);
            ok(idleCard && /not assigned/i.test(idleCard.text || '') && !idleCard.hasChips, `${vp}: a banner with no emails says so and offers "Assign"`, JSON.stringify(idleCard));
            const cov = await p.evaluate(() => (document.getElementById('bnrCoverage') || {}).innerText || '');
            const withBanner = tpl.filter(t => t.banner_id).length + 3 - tpl.slice(0, 3).filter(t => t.banner_id).length;
            ok(new RegExp(`${withBanner} of ${tpl.length} outgoing emails have a banner`).test(cov), `${vp}: the coverage strip counts ${withBanner} of ${tpl.length}`, cov.slice(0, 200));
            const overflow = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
            ok(overflow <= 1, `${vp}: no sideways scrolling`, overflow);

            // a chip opens the assign drawer for its banner
            await p.evaluate((id) => document.querySelector('#bnrCardGrid article[data-id="' + id + '"] .bnr-chip').click(), usedId);
            await sleep(1500);
            const drawer = await p.evaluate(() => { const d = document.getElementById('bnrAssignDrawer'); return d ? (d.classList.contains('atl-drawer--open')) : null; });
            ok(drawer === true, `${vp}: clicking a chip opens the assign drawer`, String(drawer));
            // every email can be assigned, including the ticket confirmation (category "Event Tickets", which the list used to leave out)
            await p.evaluate(() => { const d = document.getElementById('bnrAssignDrawer'); d.querySelector('.atl-drawer__close').click(); });
            await sleep(400);
            await p.evaluate((id) => window.openBnrAssignDrawer(id), idleId);
            await sleep(1500);
            const keysShown = await p.evaluate(() => [...document.querySelectorAll('#bnrAssignList .bnr-assign-checkbox')].map(c => c.getAttribute('data-key')));
            const allKeys = tpl.map(x => x.template_key);
            ok(allKeys.length > 0 && allKeys.every(k => keysShown.includes(k)), `${vp}: the assign list offers every outgoing email (${keysShown.length} of ${allKeys.length}), ticket_confirmation included`, JSON.stringify(allKeys.filter(k => !keysShown.includes(k))));
            ok(errs.length === 0, `${vp}: no page errors`, errs.join(' | '));
            await p.close();
        }
        // tidy: archive the test banners' assignments (leave the data as it was)
        await api('PUT', '/api/admin/email-templates/assign', { template_keys: keys, banner_id: null });
    } finally {
        if (browser) await browser.close();
        await support.stop();
    }
    console.log(fails ? `\n${fails} banner-assignments check(s) FAILED` : '\nAll banner assignment checks passed');
    process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
