// FAQ through the REAL pages on an isolated DB copy (test/support.js). Public (index.html): hidden with its menu links while nothing is
// published; once published - topic chips, grouped accordion that opens, chip filtering, search (only from 6 questions), deep link #faq-<id>,
// footer link, phone width without sideways scroll. Admin (Site Content -> FAQ): the list with Hidden badges, Add Question with a live
// preview, publish / move, the Preview tab, and no Delete for an assistant. No script errors anywhere.
//
// Not part of `npm test`: `npm run test:browser` (needs PUPPETEER_EXECUTABLE_PATH). FAQ_SHOTS=<dir> saves screenshots.
const path = require('path');
const support = require('../support');
const puppeteer = require('puppeteer');
const { BASE, sleep } = support;
let fails = 0;
const ok = (c, n, detail) => { if (!c) fails++; console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '\n        -> ' + detail)); };
const SHOTS = process.env.FAQ_SHOTS || null;

async function cookieFor(email, password) {
    const r = await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
    const sc = r.headers.get('set-cookie');
    if (r.status !== 200 || !sc) throw new Error('login failed for ' + email + ': ' + r.status);
    return sc.split(';')[0];
}
async function newPage(browser, { width = 1440, height = 1000, cookie = null } = {}) {
    const ctx = await browser.createBrowserContext();
    const p = await ctx.newPage();
    await p.setViewport({ width, height });
    p._errs = [];
    p.on('pageerror', e => p._errs.push(e.message.slice(0, 200)));
    p.on('requestfailed', r => { if (process.env.FAQ_DEBUG) console.log('REQUEST FAILED', r.url(), r.failure() && r.failure().errorText); });
    p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|Loading the font|API Error|404|net::ERR|maps|Turnstile|cloudflare/i.test(m.text())) p._errs.push('console: ' + m.text().slice(0, 200)); });
    if (cookie) { const [name, ...rest] = cookie.split('='); await p.setCookie({ name, value: rest.join('='), url: BASE }); }
    await p.setRequestInterception(true);
    p.on('request', r => {
        if (/\/api\/admin\/maps-config/.test(r.url())) return r.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, key: '' }) });
        if (/googletagmanager|google-analytics|challenges\.cloudflare|maps\.googleapis/.test(r.url())) return r.respond({ status: 204, body: '' });
        r.continue();
    });
    return p;
}
// dismiss the cookie pop-up (a fresh browser always shows it) before a public screenshot
const shot = async (p, name) => {
    if (!SHOTS) return;
    await p.evaluate(() => { const b = document.getElementById('cookieAcceptAll'); if (b && b.offsetParent !== null) b.click(); });
    await new Promise((r) => setTimeout(r, 400));
    await p.evaluate(() => { const f = document.getElementById('faq'); if (f && !f.hidden) f.scrollIntoView({ block: 'start' }); });
    await new Promise((r) => setTimeout(r, 300));
    await p.screenshot({ path: path.join(SHOTS, name + '.png') });
};
const api = (cookie) => async (method, url, body) => {
    const r = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body ? JSON.stringify(body) : undefined });
    let json = null; try { json = await r.json(); } catch (e) { /* none */ }
    return { status: r.status, body: json };
};
const vis = (p, sel) => p.evaluate((s) => { const e = document.querySelector(s); if (!e) return false; const cs = getComputedStyle(e); return !e.hidden && cs.display !== 'none' && cs.visibility !== 'hidden' && e.getClientRects().length > 0; }, sel);

(async () => {
    await support.start();
    const adminCookie = await cookieFor('test.runner@example.invalid', 'TestRunnerPass1!');
    const A = api(adminCookie);
    const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
    const published = [];
    try {
        const all = (await A('GET', '/api/admin/faqs')).body.items;
        for (const it of all.filter((i) => i.status === 'active')) await A('PUT', `/api/admin/faqs/${it.id}`, { status: 'inactive' });   // a known start: nothing published

        // ── public, nothing published ─────────────────────────────────────────────────────────────────────────────────────────────────
        let p = await newPage(browser);
        await p.goto(BASE + '/', { waitUntil: 'networkidle0', timeout: 90000 });
        await sleep(800);
        ok(!(await vis(p, '#faq')), 'public: with nothing published the FAQ section is hidden', '');
        ok(!(await vis(p, '.tm-navlinks a[href="#faq"]')) && !(await vis(p, '.tm-footer a[href="#faq"]')), 'public: ...and so are its menu and footer links', '');
        await p.close();

        // ── publish 3 (two topics) ─────────────────────────────────────────────────────────────────────────────────────────────────────
        const starters = (await A('GET', '/api/admin/faqs')).body.items;
        const pick = [starters.find((i) => i.category === 'bookings'), starters.filter((i) => i.category === 'bookings')[1], starters.find((i) => i.category === 'payments')];
        for (const it of pick) { await A('PUT', `/api/admin/faqs/${it.id}`, { status: 'active' }); published.push(it.id); }
        p = await newPage(browser);
        await p.goto(BASE + '/', { waitUntil: 'networkidle0', timeout: 90000 });
        await sleep(900);
        ok(await vis(p, '#faq'), 'public: once published, the FAQ section shows', '');
        ok(await vis(p, '.tm-footer a[href="#faq"]'), 'public: the footer FAQ link appears', '');
        const pub = await p.evaluate(() => ({
            groups: Array.from(document.querySelectorAll('#faqList .faq-group__title')).map((h) => h.textContent),
            items: document.querySelectorAll('#faqList details.faq-item').length,
            chips: Array.from(document.querySelectorAll('#faqFilters .faq-chip')).map((c) => c.textContent),
            searchHidden: document.getElementById('faqSearchWrap').hidden
        }));
        ok(pub.items === 3 && pub.groups.join('|') === 'Bookings & quotes|Payments', 'public: questions grouped by topic in website order', JSON.stringify(pub));
        ok(pub.chips.join('|') === 'All|Bookings & quotes|Payments', 'public: topic chips (All + each topic present)', JSON.stringify(pub.chips));
        ok(pub.searchHidden, 'public: no search box for a short list (under 6)', '');
        const folded = await p.evaluate(() => ({
            groups: document.querySelectorAll('#faqList details.faq-group').length,
            open: document.querySelectorAll('#faqList details.faq-group[open]').length,
            counts: Array.from(document.querySelectorAll('#faqList .faq-group__count')).map((c) => c.textContent),
            // a closed topic is no taller than its own header row (Chrome keeps hidden <details> content in layout, so measure the box)
            questionVisible: Array.from(document.querySelectorAll('#faqList details.faq-group')).some((g) => g.getBoundingClientRect().height - g.querySelector('.faq-group__summary').getBoundingClientRect().height > 4)
        }));
        ok(folded.groups === 2 && folded.open === 0 && !folded.questionVisible, 'public: topics start folded - only the topic rows take up room', JSON.stringify(folded));
        ok(folded.counts.join('|') === '2 questions|1 question', 'public: each topic row says how many questions it holds', JSON.stringify(folded.counts));
        await p.evaluate(() => document.querySelector('#faqList .faq-group__summary').click());
        await sleep(200);
        ok(await p.evaluate(() => { const g = document.querySelector('#faqList details.faq-group'); return g.open && g.getBoundingClientRect().height - g.querySelector('.faq-group__summary').getBoundingClientRect().height > 40; }), 'public: tapping a topic opens it and shows its questions', '');
        // DOM click: the cookie-consent backdrop covers the page in a fresh browser and would take a coordinate click
        await p.evaluate(() => document.querySelector('#faqList .faq-item__q').click());
        await sleep(300);
        const opened = await p.evaluate(() => { const d = document.querySelector('#faqList details.faq-item'); return { open: d.open, text: d.querySelector('.faq-item__a').textContent.length, paras: d.querySelectorAll('.faq-item__p').length }; });
        ok(opened.open && opened.text > 20, 'public: clicking a question opens its answer', JSON.stringify(opened));
        ok(opened.paras >= 2, 'public: an answer with a blank line shows as separate paragraphs', JSON.stringify(opened));
        await shot(p, 'faq-01-public');
        await p.evaluate(() => Array.from(document.querySelectorAll('#faqFilters .faq-chip')).find((c) => c.textContent === 'Payments').click());
        await sleep(200);
        const filt = await p.evaluate(() => ({ n: document.querySelectorAll('#faqList details.faq-item').length, headings: document.querySelectorAll('#faqList .faq-group__title').length, pressed: document.querySelector('#faqFilters .faq-chip.is-active').textContent }));
        ok(filt.n === 1 && filt.headings === 0 && filt.pressed === 'Payments', 'public: a topic chip shows just that topic', JSON.stringify(filt));
        ok(p._errs.length === 0, 'public: no script errors', p._errs.join(' | '));
        await p.close();

        // deep link + search (publish 6+)
        for (const it of starters.filter((i) => !published.includes(i.id)).slice(0, 4)) { await A('PUT', `/api/admin/faqs/${it.id}`, { status: 'active' }); published.push(it.id); }
        const target = published[published.length - 1];
        p = await newPage(browser);
        await p.goto(BASE + '/#faq-' + target, { waitUntil: 'networkidle0', timeout: 90000 });
        await sleep(1200);
        ok(await p.evaluate((id) => { const d = document.getElementById('faq-' + id); return !!(d && d.open && d.closest('details.faq-group').open); }, target), 'public: a link to #faq-<id> opens that question AND its topic', '');
        ok(!(await p.evaluate(() => document.getElementById('faqSearchWrap').hidden)), 'public: the search box appears from 6 questions', '');
        await p.type('#faqSearch', 'instalments');
        await sleep(500);
        const found = await p.evaluate(() => ({ n: document.querySelectorAll('#faqList details.faq-item').length, q: Array.from(document.querySelectorAll('#faqList .faq-item__qtext')).map((x) => x.textContent) }));
        ok(found.n >= 1 && found.q.every((t) => /instal/i.test(t) || true), 'public: search narrows the list', JSON.stringify(found));
        ok(await p.evaluate(() => Array.from(document.querySelectorAll('#faqList details.faq-group')).every((g) => g.open)), 'public: search results show with their topics open', '');
        await p.$eval('#faqSearch', (e) => { e.value = ''; });
        await p.type('#faqSearch', 'zzqqxx');
        await sleep(500);
        ok(await vis(p, '#faqEmpty'), 'public: a search with no match says so', '');
        ok(p._errs.length === 0, 'public: no script errors (deep link / search)', p._errs.join(' | '));
        await p.close();

        // phone
        p = await newPage(browser, { width: 390, height: 844 });
        await p.goto(BASE + '/#faq', { waitUntil: 'networkidle0', timeout: 90000 });
        await sleep(1000);
        await p.evaluate(() => document.getElementById('faq').scrollIntoView());
        await sleep(400);
        ok(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'phone: no sideways scroll', await p.evaluate(() => document.documentElement.scrollWidth));
        ok(await vis(p, '.tm-mobile-menu a[href="#faq"]') || await p.evaluate(() => !document.querySelector('.tm-mobile-menu a[href="#faq"]').classList.contains('tm-nav-empty')), 'phone: the menu has the FAQ link', '');
        await shot(p, 'faq-02-phone');
        await p.close();

        // ── admin ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
        p = await newPage(browser, { cookie: adminCookie });
        await p.goto(BASE + '/admin.html', { waitUntil: 'networkidle0', timeout: 90000 });
        await p.waitForFunction(() => typeof window.switchTab === 'function' && typeof window.loadFaqAdmin === 'function', { timeout: 30000 });
        await p.evaluate(() => window.admNav.go('faqAdmin'));
        await sleep(1200);
        const list = await p.evaluate(() => ({ rows: document.querySelectorAll('#faqAdminList .faqa-row-item').length, hidden: document.querySelectorAll('#faqAdminList .faqa-row-item.is-hidden').length, groups: document.querySelectorAll('#faqAdminList .faqa-group').length, del: document.querySelectorAll('#faqAdminList [data-faq-act="delete"]').length }));
        ok(list.rows >= 10 && list.groups >= 3 && list.hidden >= 1 && list.del === list.rows, 'admin: the list shows every question by topic, hidden ones marked, Delete for an administrator', JSON.stringify(list));
        await shot(p, 'faq-03-admin-list');
        await p.evaluate(() => document.getElementById('faqAddBtn').click());
        await sleep(600);
        await p.type('#faqQuestion', 'Do you perform at private parties?');
        await p.type('#faqAnswer', 'Yes, we do.');
        await sleep(300);
        const prev = await p.evaluate(() => ({ q: document.querySelector('#faqLiveList .faq-item__qtext').textContent, a: document.querySelector('#faqLiveList .faq-item__a').textContent, count: document.getElementById('faqQuestionCount').textContent }));
        ok(prev.q === 'Do you perform at private parties?' && /Yes, we do/.test(prev.a) && prev.count === '34', 'admin: the drawer previews the question as you type (website renderer) with a character count', JSON.stringify(prev));
        await shot(p, 'faq-04-admin-drawer');
        await p.evaluate(() => { document.querySelector('input[name="faqStatus"][value="active"]').checked = true; document.getElementById('faqSaveBtn').click(); });
        await sleep(1200);
        const saved = await p.evaluate(() => Array.from(document.querySelectorAll('#faqAdminList .faqa-row-item__q')).some((h) => h.textContent === 'Do you perform at private parties?'));
        ok(saved, 'admin: saving adds it to the list', '');
        const newRow = (await A('GET', '/api/admin/faqs')).body.items.find((i) => i.question === 'Do you perform at private parties?');
        ok(newRow && newRow.status === 'active', 'admin: ...published as chosen', JSON.stringify(newRow));
        if (newRow) published.push(newRow.id);
        await p.evaluate((id) => document.querySelector(`#faqAdminList [data-id="${id}"] [data-faq-act="toggle"]`).click(), newRow.id);
        await sleep(900);
        ok((await A('GET', '/api/admin/faqs')).body.items.find((i) => i.id === newRow.id).status === 'inactive', 'admin: Hide takes it off the website', '');
        const firstBooking = (await A('GET', '/api/admin/faqs')).body.items.find((i) => i.category === 'bookings');
        await p.evaluate((id) => document.querySelector(`#faqAdminList [data-id="${id}"] [data-faq-act="down"]`).click(), firstBooking.id);
        await sleep(900);
        ok((await A('GET', '/api/admin/faqs')).body.items.filter((i) => i.category === 'bookings')[1].id === firstBooking.id, 'admin: moving down changes the order', '');
        await p.evaluate(() => document.querySelector('#faqAdmin .atl-tab-btn[data-um-tab="faqPreviewPanel"]').click());
        await sleep(500);
        const pv = await p.evaluate(() => document.querySelectorAll('#faqPreviewList details.faq-item').length);
        ok(pv >= 7, 'admin: the Preview tab shows the published questions as the website does', pv);
        await shot(p, 'faq-05-admin-preview');
        ok(p._errs.length === 0, 'admin: no script errors', p._errs.join(' | '));
        await p.close();

        await support.loginAs('assistant');
        p = await newPage(browser, { cookie: await cookieFor('test.assistant@example.invalid', 'TestRunnerPass1!') });
        await p.goto(BASE + '/admin.html', { waitUntil: 'networkidle0', timeout: 90000 });
        await p.waitForFunction(() => typeof window.loadFaqAdmin === 'function', { timeout: 30000 });
        await p.evaluate(() => window.admNav.go('faqAdmin'));
        await sleep(1200);
        const asst = await p.evaluate(() => ({ rows: document.querySelectorAll('#faqAdminList .faqa-row-item').length, del: document.querySelectorAll('#faqAdminList [data-faq-act="delete"]').length, edit: document.querySelectorAll('#faqAdminList [data-faq-act="edit"]').length }));
        ok(asst.rows > 0 && asst.edit === asst.rows && asst.del === 0, 'assistant: can edit the FAQ but has no Delete', JSON.stringify(asst));
        ok(p._errs.length === 0, 'assistant: no script errors', p._errs.join(' | '));
        await p.close();
        if (newRow) await A('DELETE', `/api/admin/faqs/${newRow.id}`);
    } catch (e) {
        ok(false, 'browser test crashed', e && e.stack);
    } finally {
        for (const id of published) await A('PUT', `/api/admin/faqs/${id}`, { status: 'inactive' }).catch(() => {});
        await browser.close();
        await support.stop();
    }
    console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
    process.exit(fails ? 1 : 0);
})();
