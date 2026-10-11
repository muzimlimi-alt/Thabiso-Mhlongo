// Career highlights text round-trip + the public page's reading of stored (entity-encoded) text — browser test.
// Boots the app on an isolated DB copy (test/support.js) and uses rows of its own, removed at the end.
//
//   admin editor loads the text AS TYPED (not the stored &amp;/&quot; form) -> saving adds no encoding layer, and
//   a row already carrying stacked layers loads clean and is healed by the save
//   public Milestones: the aria-label is decoded (an attribute does not get HTML-decoded like element text does)
//   public Events: the schema.org Event JSON-LD carries decoded text, an absolute poster image and a decoded ticket URL
//
// Why it exists: the editor used to put the stored, already-encoded text into its form boxes, so every edit encoded
// it again and the live page showed "&amp;quot;Celeste &amp;amp; Da Big Dudes&amp;quot;" (lib/html-sanitize.js
// normalizeEncodedText, test/career-highlights.test.js). Not part of `npm test`: run it with `npm run test:browser`.
const sqlite3 = require('sqlite3');
const support = require('../support');
const puppeteer = require('puppeteer');
const { BASE, sleep } = support;
let fails = 0;
const ok = (c, n, detail) => { if (!c) fails++; console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '\n        -> ' + detail)); };

const PASSWORD = 'TestRunnerPass1!';
// The encoding app.js's deepEscapeBody applies to every request-body string.
const enc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');

const CLEAN_TITLE = 'Zed Test & "Show"';
const CLEAN_DESC = 'Tom\'s "big" night & more';
const LEGACY_TITLE = 'Legacy Stack & "Co"';
const LEGACY_DESC = '"Legacy" row & its description';

function sqlRun(sql, params = []) {
    return new Promise((res, rej) => {
        const db = new sqlite3.Database(support.TEST_DB);
        db.run(sql, params, function (e) { db.close(); e ? rej(e) : res(this); });
    });
}

async function adminCookie() {
    const r = await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'test.runner@example.invalid', password: PASSWORD }) });
    const sc = r.headers.get('set-cookie');
    if (r.status !== 200 || !sc) throw new Error('admin login failed: ' + r.status);
    return sc.split(';')[0];
}

function watchErrors(p) {
    p._errs = [];
    p.on('pageerror', e => p._errs.push(e.message.slice(0, 200)));
    // Pre-existing noise unrelated to this feature: failed image loads, a malformed data: URI font in admin CSS, and the
    // placehold.co fallback that a missing image's onerror swaps in (the throwaway DB copy references uploads that
    // don't exist here) being refused by the CSP's img-src.
    p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|Loading the font|Loading the image 'https:\/\/placehold\.co\//.test(m.text())) p._errs.push('console: ' + m.text().slice(0, 200)); });
}

const publicHighlights = async () => (await (await fetch(`${BASE}/api/public/highlights`)).json());
const domClick = (p, sel) => p.$eval(sel, e => e.click());

(async () => {
    await support.start();
    const cookie = await adminCookie();

    // Rows of this test's own. clean = one layer (what the server stores); legacy = three stacked layers (what the old editor produced).
    const clean = await sqlRun('INSERT INTO career_highlights (year, title, badge, location, description) VALUES (?, ?, ?, ?, ?)', ['2024', enc(CLEAN_TITLE), '', enc('Jozi & Co'), enc(CLEAN_DESC)]);
    const legacy = await sqlRun('INSERT INTO career_highlights (year, title, badge, location, description) VALUES (?, ?, ?, ?, ?)', ['2025', enc(enc(enc(LEGACY_TITLE))), '', 'Nationwide', enc(enc(enc(LEGACY_DESC)))]);
    // An upcoming public event stored the way the admin saves it (entity-encoded), with a poster.
    const FUTURE = new Date(Date.now() + 40 * 864e5).toISOString().slice(0, 16);
    const ev = await sqlRun('INSERT INTO events (event_title, event_description, event_datetime, venue_name, ticket_sales_link, poster_image_path, event_status) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [enc("Mother's Day & Friends"), enc('A "big" show'), FUTURE, enc("Tom & Jerry's Arena"), enc('https://tickets.example.test/e?a=1&b=2'), 'images/events/zz-browser-test.jpg', 'upcoming']);

    const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-quic'] });

    // ══════════ 1. Public page: Milestones aria-label + Event JSON-LD ══════════
    {
        const ctx = await browser.createBrowserContext();
        const p = await ctx.newPage();
        await p.setViewport({ width: 1440, height: 900 });
        watchErrors(p);
        const done = Promise.all([
            p.waitForResponse(r => r.url().includes('/api/public/highlights'), { timeout: 60000 }),
            p.waitForResponse(r => r.url().includes('/api/public/events'), { timeout: 60000 }),
        ]);
        await p.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
        await done;
        await p.waitForFunction(() => document.getElementById('events-jsonld'), { timeout: 20000 }).catch(() => {});
        await p.waitForFunction(() => document.querySelector('#milestonesRow .ms-option'), { timeout: 20000 });
        await sleep(300);

        const ms = await p.evaluate((t) => {
            const h = Array.from(document.querySelectorAll('#milestonesRow .ms-option__title')).find(e => e.textContent.trim() === t);
            const opt = h && h.closest('.ms-option');
            return { found: !!opt, label: opt && opt.getAttribute('aria-label'), text: h && h.textContent };
        }, CLEAN_TITLE);
        ok(ms.found, 'public: the clean highlight shows its title as typed (one encoding layer is decoded once)', JSON.stringify(ms));
        ok(ms.label === '2024 — ' + CLEAN_TITLE, 'public: its aria-label is the decoded title, not "&amp;" / "&quot;" text', JSON.stringify(ms));

        const ld = await p.evaluate(() => { const s = document.getElementById('events-jsonld'); return s ? JSON.parse(s.textContent) : null; });
        const e = ld && ld['@graph'] && ld['@graph'].find(x => x.name === "Mother's Day & Friends");
        ok(!!e, 'public: the event JSON-LD names the event as typed (apostrophe/ampersand decoded)', JSON.stringify(ld && ld['@graph'] && ld['@graph'].map(x => x.name)));
        ok(e && e.description === 'A "big" show' && e.location && e.location.name === "Tom & Jerry's Arena", 'public: ...with decoded description and venue', JSON.stringify(e));
        ok(e && e.offers && e.offers.url === 'https://tickets.example.test/e?a=1&b=2', 'public: ...and a decoded ticket URL (no "&amp;" in the query string)', JSON.stringify(e && e.offers));
        ok(e && e.image === BASE + '/images/events/zz-browser-test.jpg', 'public: ...and the poster as an absolute image URL', JSON.stringify(e && e.image));
        ok(p._errs.length === 0, 'public: no page errors', p._errs.join(' | '));
        await ctx.close();
    }

    // ══════════ 2. Admin editor: loads the text as typed, saving adds no layer ══════════
    {
        const ctx = await browser.createBrowserContext();
        const p = await ctx.newPage();
        await p.setViewport({ width: 1440, height: 1000 });
        watchErrors(p);
        const [name, ...rest] = cookie.split('=');
        await p.setCookie({ name, value: rest.join('='), url: BASE });
        await p.setRequestInterception(true);
        p.on('request', r => /\/api\/admin\/maps-config/.test(r.url())
            ? r.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, key: '' }) })
            : r.continue());
        await p.goto(BASE + '/admin.html', { waitUntil: 'networkidle0', timeout: 90000 });
        await p.waitForFunction(() => typeof window.loadHighlights === 'function' && typeof window.openCareerEditDrawer === 'function', { timeout: 30000 });
        await p.evaluate(() => window.switchTab('careerAdmin'));
        await p.evaluate(() => window.loadHighlights());
        await p.waitForSelector(`#adminCareerList .atl-edit-card[data-id="${clean.lastID}"]`, { timeout: 15000 });

        const values = () => p.evaluate(() => ({ title: document.getElementById('careerTitle').value, loc: document.getElementById('careerLocation').value, desc: document.getElementById('careerDesc').value }));
        const save = async () => { await domClick(p, '#careerSubmitBtn'); await p.waitForFunction(() => !document.getElementById('careerDrawer').classList.contains('atl-drawer--open'), { timeout: 15000 }); await sleep(400); };
        const stored = async (id) => (await publicHighlights()).find(r => r.id === id);

        // clean row: the edit boxes hold the text as typed
        await p.evaluate(id => window.openCareerEditDrawer(id), clean.lastID);
        await p.waitForFunction(() => document.getElementById('careerDrawer').classList.contains('atl-drawer--open'), { timeout: 10000 });
        let v = await values();
        ok(v.title === CLEAN_TITLE && v.loc === 'Jozi & Co' && v.desc === CLEAN_DESC, 'admin: editing a highlight shows its text as typed, not "&amp;" / "&quot;" / "&#x27;"', JSON.stringify(v));
        await save();
        let row = await stored(clean.lastID);
        ok(row && row.title === enc(CLEAN_TITLE) && row.location === enc('Jozi & Co') && row.description === enc(CLEAN_DESC), 'admin: saving it unchanged adds no encoding layer', JSON.stringify(row));
        // ...and doing it again is still stable (the old editor added a layer per save)
        await p.evaluate(() => window.loadHighlights());
        await p.waitForSelector(`#adminCareerList .atl-edit-card[data-id="${clean.lastID}"]`, { timeout: 15000 });
        await p.evaluate(id => window.openCareerEditDrawer(id), clean.lastID);
        await p.waitForFunction(() => document.getElementById('careerDrawer').classList.contains('atl-drawer--open'), { timeout: 10000 });
        await save();
        row = await stored(clean.lastID);
        ok(row && row.title === enc(CLEAN_TITLE) && row.description === enc(CLEAN_DESC), 'admin: a second unchanged save is still stable', JSON.stringify(row));

        // legacy row (three stacked layers): loads clean, and saving heals it
        await p.evaluate(() => window.loadHighlights());
        await p.waitForSelector(`#adminCareerList .atl-edit-card[data-id="${legacy.lastID}"]`, { timeout: 15000 });
        await p.evaluate(id => window.openCareerEditDrawer(id), legacy.lastID);
        await p.waitForFunction(() => document.getElementById('careerDrawer').classList.contains('atl-drawer--open'), { timeout: 10000 });
        v = await values();
        ok(v.title === LEGACY_TITLE && v.desc === LEGACY_DESC, 'admin: a row with stacked encoding layers still loads as the clean text', JSON.stringify(v));
        await save();
        row = await stored(legacy.lastID);
        ok(row && row.title === enc(LEGACY_TITLE) && row.description === enc(LEGACY_DESC), 'admin: saving that row heals it to a single layer', JSON.stringify(row));
        ok(p._errs.length === 0, 'admin: no page errors', p._errs.join(' | '));
        await ctx.close();
    }

    // ── tidy up (the DB is a throwaway copy) ──
    await sqlRun('DELETE FROM career_highlights WHERE id IN (?, ?)', [clean.lastID, legacy.lastID]);
    await sqlRun('DELETE FROM events WHERE event_id = ?', [ev.lastID]);
    await browser.close();
    await support.stop();
    console.log(fails ? `\n${fails} FAILED` : '\nAll passed');
    process.exit(fails ? 1 : 0);
})().catch(async e => { console.error('ERR', e.stack || e.message); try { await support.stop(); } catch (_) {} process.exit(2); });
