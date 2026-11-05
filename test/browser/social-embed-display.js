// Media Embeds: the admin chooses, per embed, what the public Social card shows (channel / views / upload date / description).
//   * the drawer has four checkboxes, all ticked for a new embed and for an embed saved before the options existed;
//   * saving stores the choice with the embed (metadata.display) and reopening the embed shows it again;
//   * the public card shows exactly what is ticked and nothing else, and an embed with no choice shows everything.
// Boots the real app on an isolated database copy (test/support.js); the embeds it creates are removed at the end.
// Not part of `npm test`: run with `npm run test:browser` (needs PUPPETEER_EXECUTABLE_PATH).
const support = require('../support');
const puppeteer = require('puppeteer');
const { BASE, sleep, api } = support;
let fails = 0;
const ok = (c, n, detail) => { if (!c) fails++; console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '\n        -> ' + String(detail).slice(0, 500))); };

const meta = (title, display) => {
    const m = { title, channelName: 'Chan ' + title, publishDate: '2024-08-02T10:00:00.000Z', viewCount: 12345, description: 'Desc of ' + title, thumbnail: 'https://i.ytimg.com/vi/poE8pLWaLPY/hqdefault.jpg', statsFetchedAt: new Date().toISOString() };
    if (display) m.display = display;
    return m;
};
const yt = (id) => `<iframe src="https://www.youtube.com/embed/${id}"></iframe>`;

(async () => {
    await support.start();
    const ids = [];
    let browser;
    try {
        await support.loginAs('administrator');
        const lr = await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'test.administrator@example.invalid', password: 'TestRunnerPass1!' }) });
        const raw = lr.headers.get('set-cookie');

        const mk = async (title, display, code) => {
            const r = await api('POST', '/api/admin/social_embeds', { platform_name: 'YouTube', embed_code: code, metadata: meta(title, display), is_active: true });
            if (r.body && r.body.id) ids.push(r.body.id);
            return r.body && r.body.id;
        };
        const idAll = await mk('ZAllShown', null, yt('aaaaaaaaaaa'));
        const idSome = await mk('ZSomeShown', { channel: true, views: false, date: true, description: false }, yt('bbbbbbbbbbb'));
        const idNone = await mk('ZNoneShown', { channel: false, views: false, date: false, description: false }, yt('ccccccccccc'));
        ok(idAll && idSome && idNone, 'setup: three embeds with different choices', JSON.stringify([idAll, idSome, idNone]));

        browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'], executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined });

        // ══════════ the public card ══════════
        {
            const p = await browser.newPage();
            await p.setViewport({ width: 1400, height: 1000 });
            await p.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 90000 });
            await p.evaluate(() => { const x = document.getElementById('cookieRejectAll'); if (x) x.click(); });
            await p.waitForFunction(() => [...document.querySelectorAll('#dynamicEmbedsRow .sm-card__title')].some(t => t.textContent === 'ZNoneShown'), { timeout: 20000 });
            const card = (title) => p.evaluate((t) => {
                const c = [...document.querySelectorAll('#dynamicEmbedsRow .sm-card')].find(e => e.querySelector('.sm-card__title').textContent === t);
                return c ? { channel: !!c.querySelector('.sm-card__channel'), stats: (c.querySelector('.sm-card__stats') || {}).textContent || '', desc: !!c.querySelector('.sm-card__desc') } : null;
            }, title);
            const all = await card('ZAllShown'), some = await card('ZSomeShown'), none = await card('ZNoneShown');
            ok(all && all.channel && /12K views/.test(all.stats) && /Uploaded 2 Aug 2024/.test(all.stats) && all.desc, 'no choice saved: channel, views, upload date and description are all shown', JSON.stringify(all));
            ok(some && some.channel && !/views/.test(some.stats) && /Uploaded 2 Aug 2024/.test(some.stats) && !some.desc, 'channel + date ticked, views + description not: only channel and date show', JSON.stringify(some));
            ok(none && !none.channel && none.stats === '' && !none.desc, 'nothing ticked: no channel line, no stats line, no description (title and picture remain)', JSON.stringify(none));
            await p.close();
        }

        // ══════════ the admin drawer ══════════
        {
            const p = await (await browser.createBrowserContext()).newPage();
            await p.setViewport({ width: 1440, height: 1000 });
            const [name, ...rest] = String(raw).split(';')[0].split('=');
            await p.setCookie({ name, value: rest.join('='), url: BASE });
            await p.setRequestInterception(true);
            p.on('request', r => /\/api\/admin\/maps-config/.test(r.url()) ? r.respond({ status: 200, contentType: 'application/json', body: '{"success":true,"key":""}' }) : r.continue());
            await p.goto(BASE + '/admin.html', { waitUntil: 'domcontentloaded', timeout: 90000 });
            await sleep(3000);
            await p.evaluate(() => window.switchTab('socialAdmin'));
            await p.waitForFunction((id) => typeof globalEmbedData !== 'undefined' && globalEmbedData.some(e => e.id === id), { timeout: 20000 }, idSome);

            const states = () => p.evaluate(() => { const o = {}; document.querySelectorAll('#embedShowOptions input[data-show]').forEach(i => { o[i.dataset.show] = i.checked; }); return o; });
            const openEdit = (id) => p.evaluate((id) => { const i = globalEmbedData.findIndex(e => e.id === id); $('.edit-embed-action[data-index="' + i + '"]').trigger('click'); }, id);

            await p.evaluate(() => window.openSocialEmbedDrawer());
            const fresh = await states();
            ok(['channel', 'views', 'date', 'description'].every(k => fresh[k] === true), 'a new embed: all four options ticked', JSON.stringify(fresh));

            await openEdit(idAll);
            const s1 = await states();
            ok(['channel', 'views', 'date', 'description'].every(k => s1[k] === true), 'an embed saved with no choice opens with all four ticked', JSON.stringify(s1));

            await openEdit(idSome);
            const s2 = await states();
            ok(s2.channel === true && s2.views === false && s2.date === true && s2.description === false, 'reopening an embed shows the saved choice', JSON.stringify(s2));

            // change the choice in the drawer and save
            await p.evaluate(() => { document.querySelector('#embedShowOptions [data-show="views"]').click(); document.querySelector('#embedShowOptions [data-show="channel"]').click(); });
            await p.evaluate(() => document.getElementById('socialEmbedForm').requestSubmit());
            let saved = null;
            for (let i = 0; i < 60 && !saved; i++) {
                await sleep(500);
                const r = await api('GET', '/api/admin/social_embeds');
                const row = (r.body || []).find(e => e.id === idSome);
                let m = null; try { m = JSON.parse(row.metadata); } catch (e) {}
                if (m && m.display && m.display.views === true && m.display.channel === false) saved = m.display;
            }
            ok(saved && saved.date === true && saved.description === false, 'saving stores the new choice with the embed (views on, channel off, date on, description off)', JSON.stringify(saved));
            await p.close();
        }
    } finally {
        for (const id of ids) { try { await api('DELETE', '/api/admin/social_embeds/' + id); } catch (e) {} }
        if (browser) await browser.close();
        await support.stop();
    }
    console.log(fails ? `\n${fails} FAILURE(S)` : '\nAll passed');
    process.exit(fails ? 1 : 0);
})().catch(async e => { console.error('ERR', e.stack || e.message); try { await support.stop(); } catch (_) {} process.exit(2); });
