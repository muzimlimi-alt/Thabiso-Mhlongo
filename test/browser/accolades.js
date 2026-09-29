// Accolades & Recognition — browser test: the admin lifecycle driven through the REAL admin.html UI,
// verified on the REAL index.html. Boots the app on an isolated DB copy (test/support.js — SMTP mocked,
// the real database is never touched) and owns the accolades table of that copy for the run.
//
//   empty state -> validation -> create (real image/logo/PDF uploads, triple-clicked Save) -> duplicate
//   -> preview -> edit -> publish (keyboard, More menu) -> public ledger / featured / filters / detail
//   drawer (focus in + back) / text-only rendering -> mobile -> reorder (keyboard + drag, within a year
//   only) -> bulk unpublish -> unpublish -> delete (confirm) -> manager sees no delete -> light theme ->
//   mobile admin -> Settings section switch.
//
// Not part of `npm test`: run it with `npm run test:browser`.
const fs = require('fs');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3');
const support = require('../support');
const puppeteer = require('puppeteer');
const { BASE, sleep } = support;
let fails = 0;
const ok = (c, n, detail) => { if (!c) fails++; console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '\n        -> ' + detail)); };

const Y = new Date().getFullYear();
const PASSWORD = 'TestRunnerPass1!';
const MIN_PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj '
    + '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n', 'latin1');

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

function apiWith(cookie) {
    return async (method, url, body) => {
        const r = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body ? JSON.stringify(body) : undefined });
        let json = null; try { json = await r.json(); } catch (e) { /* no body */ }
        return { status: r.status, body: json };
    };
}

function watchErrors(p) {
    p._errs = [];
    p.on('pageerror', e => p._errs.push(e.message.slice(0, 200)));
    // Pre-existing admin.html noise unrelated to this feature (a malformed data: URI font in admin CSS).
    // apiCall() (admin.html) logs every refused request with console.error — including the duplicate this
    // test provokes on purpose (a handled 409), which is expected rather than an error.
    p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|Loading the font|API Error: .*already recorded/.test(m.text())) p._errs.push('console: ' + m.text().slice(0, 200)); });
}

async function openAdmin(browser, cookie, { width = 1440, height = 1000 } = {}) {
    const ctx = await browser.createBrowserContext();
    const p = await ctx.newPage();
    await p.setViewport({ width, height });
    watchErrors(p);
    const [name, ...rest] = cookie.split('=');
    await p.setCookie({ name, value: rest.join('='), url: BASE });
    await p.setRequestInterception(true);
    // Never load the real Google Maps script (deterministic; same approach as admin-venue-autocomplete.js).
    p.on('request', r => /\/api\/admin\/maps-config/.test(r.url())
        ? r.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, key: '' }) })
        : r.continue());
    await p.goto(BASE + '/admin.html', { waitUntil: 'networkidle0', timeout: 90000 });
    await p.waitForFunction(() => typeof window.loadAccolades === 'function' && document.querySelector('#adminAccoladesList > *'), { timeout: 30000 });
    await p.evaluate(() => window.switchTab('accoladesAdmin'));
    await sleep(300);
    return p;
}

async function openPublic(browser, { width = 1440, height = 900 } = {}) {
    const ctx = await browser.createBrowserContext();
    const p = await ctx.newPage();
    await p.setViewport({ width, height, isMobile: width < 500, hasTouch: width < 500 });
    watchErrors(p);
    const done = p.waitForResponse(r => r.url().includes('/api/public/accolades'), { timeout: 60000 });
    await p.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await done;
    await sleep(700);   // let renderAccolades() finish with the response it just got
    await p.evaluate(() => { const x = document.getElementById('cookieRejectAll'); if (x && x.offsetParent) x.click(); });
    return p;
}

// Clicks through the DOM rather than at screen coordinates: the admin's toasts sit bottom-right, exactly
// over a drawer's Save button, and a coordinate click would land on the toast instead.
const domClick = (p, sel) => p.$eval(sel, e => e.click());
// Opening a drawer moves focus twice on timers (the shared drawer component focuses its close button
// after ~50ms; the Add drawer then focuses Title) — typing before that settles would be split between
// fields. Wait for focus to land inside the drawer, and on Title for a new accolade.
async function drawerSettled(p, focusId) {
    await p.waitForFunction(fid => {
        const d = document.getElementById('aclDrawer');
        if (!d.classList.contains('atl-drawer--open')) return false;
        const a = document.activeElement;
        return fid ? !!a && a.id === fid : !!a && d.contains(a);
    }, { timeout: 10000 }, focusId || null);
    await sleep(150);
}
const reloadList = p => p.evaluate(() => window.loadAccolades());
const cardIds = p => p.evaluate(() => Array.from(document.querySelectorAll('#adminAccoladesList .acl-card')).map(c => Number(c.getAttribute('data-id'))));
const toastText = p => p.evaluate(() => Array.from(document.querySelectorAll('.tm-toast__message')).map(t => t.textContent).join(' | '));
const drawerOpen = (p, id) => p.evaluate(i => document.getElementById(i).classList.contains('atl-drawer--open'), id);

async function setDateViaPicker(p, iso) {
    await p.evaluate(v => { const i = document.getElementById('aclDate'); i._flatpickr.setDate(v, true); }, iso);
}

async function menuAction(p, cardId, labelStart, { keyboard = false } = {}) {
    const btn = `#adminAccoladesList .acl-card[data-id="${cardId}"] .acl-more-btn`;
    if (keyboard) { await p.focus(btn); await p.keyboard.press('Enter'); }
    else await domClick(p, btn);
    await p.waitForFunction(() => { const m = document.getElementById('aclMoreMenu'); return m && !m.hidden; }, { timeout: 5000 });
    const clicked = await p.evaluate(l => {
        const it = Array.from(document.querySelectorAll('#aclMoreMenu [role="menuitem"]')).find(b => b.textContent.trim().startsWith(l));
        if (!it || it.disabled) return false;
        it.click();
        return true;
    }, labelStart);
    return clicked;
}

// Synthetic HTML5 drag-and-drop (real OS drags cannot be driven headless): the same event sequence a
// browser fires — dragstart on the handle, dragover/drop on the target, dragend on the handle.
async function dragCard(p, srcId, dstId, above) {
    await p.evaluate((s, d, up) => {
        const list = document.getElementById('adminAccoladesList');
        const src = list.querySelector('.acl-card[data-id="' + s + '"]');
        const dst = list.querySelector('.acl-card[data-id="' + d + '"]');
        const handle = src.querySelector('.acl-drag');
        const dt = new DataTransfer();
        const r = dst.getBoundingClientRect();
        const y = up ? r.top + 3 : r.bottom - 3;
        handle.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
        dst.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + 20, clientY: y }));
        dst.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + 20, clientY: y }));
        handle.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt }));
    }, srcId, dstId, above);
}

async function waitForApi(fn, what, ms = 15000) {
    const end = Date.now() + ms;
    let last;
    while (Date.now() < end) {
        last = await fn();
        if (last) return last;
        await sleep(250);
    }
    return last;
}

(async () => {
    await support.start();
    // The test owns this table on its throwaway copy — whatever the copied DB held is cleared first.
    await sqlRun('DELETE FROM accolades');
    const adminCookie = await cookieFor('test.runner@example.invalid');
    const api = apiWith(adminCookie);
    const pubList = async () => (await (await fetch(`${BASE}/api/public/accolades`)).json());
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acl-browser-'));
    const photo = path.join(tmp, 'award-photo.png'); fs.writeFileSync(photo, support.makeTestPng(120, 80));
    const logo = path.join(tmp, 'org-logo.png'); fs.writeFileSync(logo, support.makeTestPng(60, 30));
    const cert = path.join(tmp, 'certificate.pdf'); fs.writeFileSync(cert, MIN_PDF);
    const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-quic'] });

    // ══════════ 1. Nothing published: the public section and its nav links stay hidden ══════════
    {
        const p = await openPublic(browser);
        const st = await p.evaluate(() => {
            const s = document.getElementById('accolades');
            const li = document.querySelector('.tm-navlinks a[href="#accolades"]').closest('li');
            const mob = document.querySelector('.tm-mobile-menu a[href="#accolades"]');
            return { hidden: s.hidden, shown: !!s.offsetParent, liDisplay: getComputedStyle(li).display, mobDisplay: getComputedStyle(mob).display, entries: document.querySelectorAll('#accoladesLedger .acc-entry').length };
        });
        ok(st.hidden && !st.shown && st.entries === 0, 'public: with nothing published the section stays hidden (no placeholder content)', JSON.stringify(st));
        ok(st.liDisplay === 'none' && st.mobDisplay === 'none', 'public: its desktop and mobile nav links are hidden too', JSON.stringify(st));
        ok(p._errs.length === 0, 'public (empty): no page errors', p._errs.join(' | '));
        await p.close();
    }

    const admin = await openAdmin(browser, adminCookie);

    // ══════════ 2. Admin empty state ══════════
    ok(/No accolades have been added yet\./.test(await admin.$eval('#adminAccoladesList', e => e.textContent)), 'admin: empty state says "No accolades have been added yet."', await admin.$eval('#adminAccoladesList', e => e.textContent.trim().slice(0, 120)));

    // ══════════ 3. Validation: nothing is sent while the form is invalid ══════════
    await domClick(admin, '#accoladesAddNewBtn');
    await drawerSettled(admin, 'aclTitle');
    await admin.type('#aclYear', String(Y - 1));
    await admin.type('#aclExternalUrl', 'javascript:alert(1)');
    await domClick(admin, '#aclSubmitBtn');
    await sleep(400);
    const v = await admin.evaluate(() => ({
        titleErr: document.getElementById('aclTitleErr').textContent, titleInvalid: document.getElementById('aclTitle').getAttribute('aria-invalid'),
        urlErr: document.getElementById('aclExternalUrlErr').textContent, focused: document.activeElement && document.activeElement.id
    }));
    ok(!!v.titleErr && v.titleInvalid === 'true' && v.focused === 'aclTitle', 'validation: a missing title is flagged inline (aria-invalid) and focused', JSON.stringify(v));
    ok(/https/.test(v.urlErr), 'validation: a javascript: link is refused inline', JSON.stringify(v));
    ok((await support.q('SELECT COUNT(*) AS c FROM accolades'))[0].c === 0 && await drawerOpen(admin, 'aclDrawer'), 'validation: nothing was saved and the drawer stays open', '');
    await admin.evaluate(() => { document.getElementById('aclExternalUrl').value = ''; document.getElementById('aclYear').value = ''; });

    // ══════════ 4. Create through the drawer — real uploads, Year filled from the date, triple-clicked Save ══════════
    await admin.type('#aclTitle', "Comics' Choice Award");
    await admin.select('#aclCategory', 'win');
    await setDateViaPicker(admin, `${Y - 1}-03-12`);
    ok(await admin.$eval('#aclYear', e => e.value) === String(Y - 1), 'drawer: picking a date fills an empty Year', await admin.$eval('#aclYear', e => e.value));
    await admin.type('#aclResult', 'Winner');
    await admin.type('#aclOrganisation', 'Comics & Co Awards');
    await admin.type('#aclEvent', 'Annual Gala');
    await admin.type('#aclLocation', 'Johannesburg');
    await admin.type('#aclDescription', 'Recognised for an outstanding year of stand-up.');
    await (await admin.$('#aclImageFile')).uploadFile(photo);
    await (await admin.$('#aclLogoFile')).uploadFile(logo);
    await (await admin.$('#aclCertFile')).uploadFile(cert);
    await domClick(admin, '#aclFeaturedSwitch');
    await sleep(400);
    const pv = await admin.evaluate(() => ({
        ledger: document.getElementById('aclPreviewLedger').textContent,
        featured: !!document.querySelector('#aclPreviewLedger .acc-entry--featured'),
        state: document.getElementById('aclPreviewState').textContent,
        detail: document.getElementById('aclPreviewDetail').textContent,
        img: !!document.querySelector('#aclPreviewDetail .acc-detail__media img'),
        media: ['aclImagePreview', 'aclLogoPreview', 'aclCertPreview'].map(id => !document.getElementById(id).hidden)
    }));
    ok(/Comics' Choice Award/.test(pv.ledger) && pv.featured, 'preview: renders the entry with the website\'s renderer (featured panel)', JSON.stringify(pv));
    ok(/Inactive/.test(pv.state), 'preview: says a new accolade will be a hidden draft until made Active', pv.state);
    ok(/View Certificate \(PDF\)/.test(pv.detail) && pv.img && /12 March/.test(pv.detail), 'preview: the "View" panel shows the new image, the PDF certificate link and the date', pv.detail.slice(0, 200));
    ok(pv.media.every(Boolean), 'drawer: each chosen file shows as a pending upload', JSON.stringify(pv.media));
    await admin.evaluate(() => { const b = document.getElementById('aclSubmitBtn'); b.click(); b.click(); document.getElementById('aclForm').requestSubmit(); });
    await admin.waitForFunction(() => !document.getElementById('aclDrawer').classList.contains('atl-drawer--open'), { timeout: 30000 });
    await admin.waitForFunction(() => document.querySelectorAll('#adminAccoladesList .acl-card').length === 1, { timeout: 15000 });
    const rows = await support.q('SELECT * FROM accolades');
    ok(rows.length === 1, 'a triple-clicked Save stores exactly ONE accolade', `rows=${rows.length}`);
    const A = rows[0];
    ok(A.title === "Comics' Choice Award" && A.organisation === 'Comics & Co Awards' && A.status === 'inactive' && A.featured === 1 && A.achievement_date === `${Y - 1}-03-12`,
        'the record is stored exactly as typed (apostrophe, &), Inactive by default, Featured', JSON.stringify({ title: A.title, org: A.organisation, status: A.status, featured: A.featured, date: A.achievement_date }));
    ok(/^images\/accolades\/.+\.png$/.test(A.image || '') && /^images\/accolades\/.+\.png$/.test(A.organisation_logo || '') && /^images\/accolades\/.+\.pdf$/.test(A.certificate_file || ''),
        'the three files were uploaded to images/accolades/', JSON.stringify([A.image, A.organisation_logo, A.certificate_file]));
    const served = await Promise.all([A.image, A.certificate_file].map(pth => fetch(`${BASE}/${pth}`).then(r => r.status + ' ' + r.headers.get('content-type'))));
    ok(/^200 image\/png/.test(served[0]) && /^200 application\/pdf/.test(served[1]), 'the uploaded image and certificate are served', JSON.stringify(served));
    const card = await admin.$eval(`#adminAccoladesList .acl-card[data-id="${A.id}"]`, e => e.textContent.replace(/\s+/g, ' '));
    ok(/Hidden · Inactive/.test(card) && /Featured/.test(card) && /Win/i.test(card) && /Not on site/.test(card), 'card: shows category, Featured, and Hidden · Inactive', card.slice(0, 200));

    // ══════════ 5. The same award again: the server's duplicate check (409) keeps it to one ══════════
    await domClick(admin, '#accoladesAddNewBtn');
    await drawerSettled(admin, 'aclTitle');
    await admin.type('#aclTitle', "comics' choice award");
    await admin.select('#aclCategory', 'win');
    await admin.type('#aclYear', String(Y - 1));
    await admin.type('#aclOrganisation', 'COMICS & CO AWARDS');
    await domClick(admin, '#aclSubmitBtn');
    await admin.waitForFunction(() => /already recorded/.test(Array.from(document.querySelectorAll('.tm-toast__message')).map(t => t.textContent).join(' ')), { timeout: 15000 });
    ok(await drawerOpen(admin, 'aclDrawer') && (await support.q('SELECT COUNT(*) AS c FROM accolades'))[0].c === 1, 'duplicate: explained in a toast, drawer stays open, still one record', await toastText(admin));
    await domClick(admin, '#aclCancelBtn');
    await sleep(400);

    // ══════════ 6. Edit ══════════
    await domClick(admin, `#adminAccoladesList .acl-card[data-id="${A.id}"] .acl-edit-btn`);
    await drawerSettled(admin);
    const loaded = await admin.evaluate(() => ({ title: document.getElementById('aclTitle').value, year: document.getElementById('aclYear').value, date: document.getElementById('aclDate').value, hist: getComputedStyle(document.getElementById('acl-tab-history')).display !== 'none', media: !document.getElementById('aclCertPreview').hidden }));
    ok(loaded.title === "Comics' Choice Award" && loaded.year === String(Y - 1) && loaded.date === `${Y - 1}-03-12` && loaded.hist && loaded.media,
        'edit: the drawer loads the record (text, date, current media) and offers Change History', JSON.stringify(loaded));
    await admin.evaluate(() => { const r = document.getElementById('aclResult'); r.value = ''; });
    await admin.type('#aclResult', 'Winner — Best Newcomer');
    await domClick(admin, '#aclSubmitBtn');
    await admin.waitForFunction(() => !document.getElementById('aclDrawer').classList.contains('atl-drawer--open'), { timeout: 20000 });
    await admin.waitForFunction(id => /Best Newcomer/.test((document.querySelector('#adminAccoladesList .acl-card[data-id="' + id + '"]') || {}).textContent || ''), { timeout: 10000 }, A.id);
    ok(true, 'edit: the card shows the new result after saving', '');

    // ══════════ 7. Publish from the keyboard (More menu) ══════════
    await admin.focus(`#adminAccoladesList .acl-card[data-id="${A.id}"] .acl-more-btn`);
    await admin.keyboard.press('Enter');
    await admin.waitForFunction(() => { const m = document.getElementById('aclMoreMenu'); return m && !m.hidden; }, { timeout: 5000 });
    const m1 = await admin.evaluate(() => ({ focused: document.activeElement && document.activeElement.textContent.trim(), role: document.activeElement && document.activeElement.getAttribute('role'), expanded: document.querySelector('.acl-more-btn').getAttribute('aria-expanded') }));
    ok(/^Publish/.test(m1.focused) && m1.role === 'menuitem' && m1.expanded === 'true', 'More menu: opens from the keyboard with focus on its first item', JSON.stringify(m1));
    await admin.keyboard.press('Escape');
    await sleep(200);
    const m2 = await admin.evaluate(() => ({ hidden: document.getElementById('aclMoreMenu').hidden, focusIsTrigger: document.activeElement && document.activeElement.classList.contains('acl-more-btn') }));
    ok(m2.hidden && m2.focusIsTrigger, 'More menu: Escape closes it and returns focus to its button', JSON.stringify(m2));
    await admin.keyboard.press('Enter');
    await admin.waitForFunction(() => { const m = document.getElementById('aclMoreMenu'); return m && !m.hidden; }, { timeout: 5000 });
    await admin.keyboard.press('Enter');   // "Publish (show on the website)" is the focused first item
    await admin.waitForFunction(id => /Live on site/.test((document.querySelector('#adminAccoladesList .acl-card[data-id="' + id + '"]') || {}).textContent || ''), { timeout: 15000 }, A.id);
    ok((await support.q('SELECT status FROM accolades WHERE id = ?', [A.id]))[0].status === 'active', 'publish: the card says Live on site and the record is Active', '');

    // ══════════ 8. More entries (API) — an ordering, filters, and a hostile title ══════════
    const mk = async body => (await api('POST', '/api/admin/accolades', Object.assign({ status: 'active' }, body))).body.id;
    const B = await mk({ title: 'Best Newcomer', category: 'nomination', year: Y - 1, result: 'Nominee', organisation: 'SA Comedy Awards', description: 'Shortlisted.' });
    const C = await mk({ title: 'Festival Showcase', category: 'accolade', year: Y - 1, organisation: 'Festival Committee' });
    const D = await mk({ title: 'Audience Favourite', category: 'win', year: Y - 3, result: 'Winner', source_url: 'https://news.example.com/story' });
    const X = await mk({ title: '<img src=x onerror="window.__accXss=1">', category: 'accolade', year: Y - 4, description: 'Markup must render as text.' });
    ok([B, C, D, X].every(Number.isInteger), 'setup: four more published accolades created', JSON.stringify([B, C, D, X]));

    // ══════════ 9. The public page ══════════
    {
        const p = await openPublic(browser);
        await p.waitForFunction(() => !document.getElementById('accolades').hidden && document.querySelectorAll('#accoladesLedger .acc-entry').length > 0, { timeout: 15000 });
        const expected = (await pubList()).map(a => a.id);
        const shown = await p.evaluate(() => Array.from(document.querySelectorAll('#accoladesLedger .acc-entry')).map(e => Number(e.getAttribute('data-id'))));
        ok(JSON.stringify(shown) === JSON.stringify(expected) && shown.length === 5, 'public: the ledger lists exactly the published accolades in the server\'s order', JSON.stringify({ shown, expected }));
        const years = await p.evaluate(() => Array.from(document.querySelectorAll('#accoladesLedger .acc-entry')).map(e => Number(e.getAttribute('data-year'))));
        ok(years.every((y, i) => i === 0 || years[i - 1] >= y), 'public: newest year first', JSON.stringify(years));
        const feat = await p.evaluate(id => { const e = document.querySelector('#accoladesLedger .acc-entry[data-id="' + id + '"]'); return e && { featured: e.classList.contains('acc-entry--featured'), year: (e.querySelector('.acc-feature__year') || {}).textContent, label: (e.querySelector('.acc-feature__label') || {}).textContent }; }, A.id);
        ok(feat && feat.featured && feat.year === String(Y - 1) && /Winner — Best Newcomer/.test(feat.label), 'public: the Featured accolade is a framed panel with its year and result inside', JSON.stringify(feat));
        const nav = await p.evaluate(() => ({ li: document.querySelector('.tm-navlinks a[href="#accolades"]').closest('li').classList.contains('tm-nav-empty'), mob: getComputedStyle(document.querySelector('.tm-mobile-menu a[href="#accolades"]')).display }));
        ok(!nav.li && nav.mob === 'block', 'public: the nav links return once something is published', JSON.stringify(nav));
        const xss = await p.evaluate(id => ({ fired: window.__accXss === 1, text: (document.querySelector('#accoladesLedger .acc-entry[data-id="' + id + '"] .acc-entry__title') || {}).textContent, imgs: document.querySelectorAll('#accoladesLedger .acc-entry[data-id="' + id + '"] img').length }), X);
        ok(!xss.fired && xss.text === '<img src=x onerror="window.__accXss=1">' && xss.imgs === 0, 'public: a title containing markup is shown as plain text, never run', JSON.stringify(xss));

        const f0 = await p.evaluate(() => Array.from(document.querySelectorAll('#accoladesFilters .acc-filter')).map(b => b.getAttribute('data-filter') + ':' + b.getAttribute('aria-pressed')));
        ok(JSON.stringify(f0) === JSON.stringify(['all:true', 'win:false', 'nomination:false', 'accolade:false']), 'public: All / Wins / Nominations / Accolades filters appear (5 entries, 3 categories)', JSON.stringify(f0));
        await p.evaluate(() => { window.__noReload = true; });
        await p.click('.acc-filter[data-filter="nomination"]');
        await sleep(500);
        const f1 = await p.evaluate(() => ({ ids: Array.from(document.querySelectorAll('#accoladesLedger .acc-entry')).map(e => e.getAttribute('data-category')), pressed: document.querySelector('.acc-filter[data-filter="nomination"]').getAttribute('aria-pressed'), status: document.getElementById('accoladesStatus').textContent, same: window.__noReload === true }));
        ok(f1.ids.length === 1 && f1.ids[0] === 'nomination' && f1.pressed === 'true' && f1.same, 'public: a filter narrows the ledger in place (no reload), aria-pressed follows', JSON.stringify(f1));
        ok(/Showing 1 nomination/.test(f1.status), 'public: the filter result is announced (live region)', f1.status);
        await p.click('.acc-filter[data-filter="all"]');
        await sleep(400);

        const ctaSel = `#accoladesLedger .acc-entry[data-id="${A.id}"] .acc-cta`;
        const ctaName = await p.$eval(ctaSel, b => b.textContent.replace(/\s+/g, ' ').trim());
        ok(/View Achievement/.test(ctaName) && /Comics' Choice Award/.test(ctaName), 'public: each "View" button\'s accessible name includes the accolade\'s title', ctaName);
        await p.focus(ctaSel);
        await p.keyboard.press('Enter');
        await p.waitForFunction(() => document.getElementById('accoladeDrawer').classList.contains('atl-drawer--open'), { timeout: 10000 });
        await sleep(400);
        const d = await p.evaluate(() => {
            const dr = document.getElementById('accoladeDrawer');
            const certA = Array.from(dr.querySelectorAll('.acc-detail__links a')).find(a => /Certificate/.test(a.textContent));
            return { title: document.getElementById('accoladeDrawerTitle').textContent, focusInside: dr.contains(document.activeElement), img: !!dr.querySelector('.acc-detail__media img'), cert: certA && { href: certA.getAttribute('href'), target: certA.target, rel: certA.rel }, text: dr.textContent.replace(/\s+/g, ' ') };
        });
        ok(d.title === "Comics' Choice Award" && d.focusInside, 'public: "View Achievement" opens the detail drawer and moves focus into it', JSON.stringify({ title: d.title, focusInside: d.focusInside }));
        ok(d.img && d.cert && /\.pdf$/.test(d.cert.href) && d.cert.target === '_blank' && /noopener/.test(d.cert.rel) && /Comics & Co Awards/.test(d.text) && /Johannesburg/.test(d.text),
            'public: the drawer shows the image, organisation, location and a safe new-tab certificate link', JSON.stringify({ img: d.img, cert: d.cert }));
        await p.keyboard.press('Escape');
        await p.waitForFunction(() => !document.getElementById('accoladeDrawer').classList.contains('atl-drawer--open'), { timeout: 10000 });
        await sleep(300);
        ok(await p.evaluate(sel => document.activeElement === document.querySelector(sel), ctaSel), 'public: Escape closes it and focus returns to the button that opened it', await p.evaluate(() => document.activeElement && document.activeElement.outerHTML.slice(0, 80)));
        ok(p._errs.length === 0, 'public: no page errors', p._errs.join(' | '));
        await p.close();
    }

    // ══════════ 9b. The extra nav link never collides with the centred logo ══════════
    // (It overlapped by 38px at 1900px before it got its own tier — .tm-nav-lowest, shown from 2100px.)
    for (const w of [1400, 1900, 2099, 2100, 2560]) {
        const p = await openPublic(browser, { width: w, height: 900 });
        const nav = await p.evaluate(() => {
            const shown = Array.from(document.querySelectorAll('.tm-navlinks li')).filter(li => getComputedStyle(li).display !== 'none');
            const acc = document.querySelector('.tm-navlinks a[href="#accolades"]').closest('li');
            return { gap: document.querySelector('.tm-navbar__logo').getBoundingClientRect().left - shown[shown.length - 1].getBoundingClientRect().right, acc: getComputedStyle(acc).display !== 'none' };
        });
        ok(nav.gap > 16 && nav.acc === (w >= 2100), `public ${w}px: nav clears the logo (${Math.round(nav.gap)}px) and shows Accolades only from 2100px`, JSON.stringify(nav));
        await p.close();
    }

    // ══════════ 10. Public, mobile: a single-column timeline, no sideways scrolling ══════════
    {
        const p = await openPublic(browser, { width: 390, height: 844 });
        await p.waitForFunction(() => !document.getElementById('accolades').hidden, { timeout: 15000 });
        const mob = await p.evaluate(() => {
            const e = document.querySelector('#accoladesLedger .acc-entry:not(.acc-entry--featured)');
            const l = document.getElementById('accoladesLedger');
            return { overflow: document.documentElement.scrollWidth - window.innerWidth, cols: getComputedStyle(e).gridTemplateColumns.split(' ').length, rail: getComputedStyle(l).borderLeftWidth };
        });
        ok(mob.overflow <= 0 && mob.cols === 1 && mob.rail === '1px', 'public mobile: single column with a timeline rail and no horizontal overflow', JSON.stringify(mob));
        ok(p._errs.length === 0, 'public mobile: no page errors', p._errs.join(' | '));
        await p.close();
    }

    // ══════════ 11. Reorder: keyboard "Move up", then drag — always within a year ══════════
    await reloadList(admin);
    await admin.waitForFunction(() => document.querySelectorAll('#adminAccoladesList .acl-card').length === 5, { timeout: 10000 });
    const yearOrder = async () => (await pubList()).filter(a => a.year === Y - 1).map(a => a.id);
    ok(JSON.stringify(await yearOrder()) === JSON.stringify([A.id, B, C]), `reorder: ${Y - 1} starts in creation order`, JSON.stringify(await yearOrder()));
    ok(await admin.evaluate(id => { const h = document.querySelector('#adminAccoladesList .acl-card[data-id="' + id + '"] .acl-drag'); return getComputedStyle(h).display !== 'none'; }, C), 'reorder: drag handles show in website order', '');
    ok(await menuAction(admin, C, 'Move up within', { keyboard: true }), 'reorder: "Move up within <year>" is offered in the More menu', '');
    const afterMove = await waitForApi(async () => { const o = await yearOrder(); return JSON.stringify(o) === JSON.stringify([A.id, C, B]) && o; }, 'move');
    ok(!!afterMove, 'reorder: Move up swaps it with its neighbour in the same year', JSON.stringify(await yearOrder()));
    const focusKept = await admin.waitForFunction(id => { const c = document.querySelector('#adminAccoladesList .acl-card[data-id="' + id + '"]'); return !!c && c.contains(document.activeElement); }, { timeout: 8000 }, C).then(() => true, () => false);
    ok(focusKept, 'reorder: keyboard focus stays on the moved card', await admin.evaluate(() => document.activeElement && document.activeElement.className));
    await dragCard(admin, B, A.id, true);
    const afterDrag = await waitForApi(async () => { const o = await yearOrder(); return JSON.stringify(o) === JSON.stringify([B, A.id, C]) && o; }, 'drag');
    ok(!!afterDrag, 'reorder: dragging a card above another in the same year saves the new order', JSON.stringify(await yearOrder()));
    const beforeCross = JSON.stringify((await pubList()).map(a => a.id));
    await dragCard(admin, D, B, true);   // D is from an older year
    await sleep(1500);
    ok(JSON.stringify((await pubList()).map(a => a.id)) === beforeCross, 'reorder: a card cannot be dragged into another year (the website is newest-year-first)', beforeCross);
    await admin.select('#aclSort', 'title');
    await sleep(200);
    ok(await admin.evaluate(() => getComputedStyle(document.querySelector('#adminAccoladesList .acl-drag')).display === 'none'), 'reorder: drag handles hide when sorted by anything but website order', '');
    await admin.select('#aclSort', 'site');

    // ══════════ 12. Search, filters, pagination-safe selection, bulk unpublish ══════════
    await admin.type('#aclSearch', 'festival');
    await admin.waitForFunction(() => document.querySelectorAll('#adminAccoladesList .acl-card').length === 1, { timeout: 5000 });
    ok(JSON.stringify(await cardIds(admin)) === JSON.stringify([C]), 'admin: search finds by title/organisation', JSON.stringify(await cardIds(admin)));
    await admin.evaluate(() => { const s = document.getElementById('aclSearch'); s.value = ''; s.dispatchEvent(new Event('input', { bubbles: true })); });
    await admin.select('#aclFilterCategory', 'win');
    await sleep(300);
    ok(JSON.stringify((await cardIds(admin)).sort()) === JSON.stringify([A.id, D].sort()), 'admin: the category filter narrows to wins', JSON.stringify(await cardIds(admin)));
    await admin.select('#aclFilterCategory', '');
    await admin.select('#aclFilterYear', String(Y - 3));
    await sleep(300);
    ok(JSON.stringify(await cardIds(admin)) === JSON.stringify([D]), 'admin: the year filter narrows to that year', JSON.stringify(await cardIds(admin)));
    await admin.select('#aclFilterYear', '');
    await sleep(300);
    await domClick(admin, '#aclBulkToggle');
    await admin.waitForFunction(() => getComputedStyle(document.getElementById('aclBulkBar')).display !== 'none', { timeout: 5000 });
    await domClick(admin, `#adminAccoladesList .acl-card[data-id="${B}"] .acl-select-cb`);
    await domClick(admin, `#adminAccoladesList .acl-card[data-id="${C}"] .acl-select-cb`);
    ok(/2 selected/.test(await admin.$eval('#aclBulkCount', e => e.textContent)), 'bulk: the bar counts the selection', await admin.$eval('#aclBulkCount', e => e.textContent));
    await domClick(admin, '.acl-bulk-btn[data-bulk="unpublish"]');
    const bulkGone = await waitForApi(async () => { const ids = (await pubList()).map(a => a.id); return !ids.includes(B) && !ids.includes(C) && ids; }, 'bulk');
    ok(!!bulkGone && bulkGone.includes(A.id), 'bulk unpublish: both leave the website, the rest stay', JSON.stringify(bulkGone));
    await domClick(admin, '#aclBulkCancel');

    // ══════════ 13. Unpublish one (More menu) — then verify it left the website; delete another ══════════
    await admin.waitForFunction(() => !document.getElementById('accoladesAdmin').classList.contains('acl-selectable'), { timeout: 5000 });
    ok(await menuAction(admin, A.id, 'Unpublish'), 'unpublish: offered in the More menu for a live accolade', '');
    const aGone = await waitForApi(async () => !(await pubList()).some(a => a.id === A.id), 'unpublish');
    ok(!!aGone, 'unpublish: gone from the public API', '');
    {
        const p = await openPublic(browser);
        const ids = await p.evaluate(() => Array.from(document.querySelectorAll('#accoladesLedger .acc-entry')).map(e => Number(e.getAttribute('data-id'))));
        ok(!ids.includes(A.id) && !ids.includes(B) && !ids.includes(C) && ids.includes(D), 'unpublish: the public page no longer shows the unpublished accolades', JSON.stringify(ids));
        ok(await p.evaluate(() => document.getElementById('accoladesFilters').hidden), 'public: with fewer than four entries the filters step aside', '');
        await p.close();
    }
    ok(await menuAction(admin, D, 'Delete'), 'delete: offered to an administrator', '');
    await admin.waitForSelector('#tm-modal-confirm', { visible: true, timeout: 5000 });
    await domClick(admin, '#tm-modal-confirm');
    await admin.waitForFunction(id => !document.querySelector('#adminAccoladesList .acl-card[data-id="' + id + '"]'), { timeout: 15000 }, D);
    ok((await support.q('SELECT COUNT(*) AS c FROM accolades WHERE id = ?', [D]))[0].c === 0 && !!(await support.q("SELECT id FROM audit_log WHERE table_name = 'accolades' AND record_id = ? AND action = 'delete'", [D]))[0],
        'delete: confirmed, removed, and kept in the audit log', '');
    ok(admin._errs.length === 0, 'admin: no page errors through the whole lifecycle', admin._errs.join(' | '));

    // ══════════ 14. A manager can manage but never sees Delete ══════════
    {
        await support.loginAs('manager');   // creates / resets the manager account on the test DB
        const mp = await openAdmin(browser, await cookieFor('test.manager@example.invalid'));
        await mp.waitForFunction(() => document.querySelectorAll('#adminAccoladesList .acl-card').length > 0, { timeout: 15000 });
        await domClick(mp, '#adminAccoladesList .acl-more-btn');
        await mp.waitForFunction(() => { const m = document.getElementById('aclMoreMenu'); return m && !m.hidden; }, { timeout: 5000 });
        const items = await mp.evaluate(() => Array.from(document.querySelectorAll('#aclMoreMenu [role="menuitem"]')).map(b => b.textContent.trim()));
        ok(items.length > 0 && !items.some(t => /Delete/.test(t)), 'manager: the More menu has no Delete', JSON.stringify(items));
        await mp.keyboard.press('Escape');
        await domClick(mp, '#aclBulkToggle');
        ok(await mp.evaluate(() => getComputedStyle(document.getElementById('aclBulkDelete')).display === 'none'), 'manager: the bulk Delete button is hidden', '');
        ok(mp._errs.length === 0, 'manager: no page errors', mp._errs.join(' | '));
        await mp.close();
    }

    // ══════════ 15. Light theme + mobile admin ══════════
    await admin.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
    await domClick(admin, `#adminAccoladesList .acl-card[data-id="${A.id}"] .acl-edit-btn`);
    await drawerSettled(admin);
    const light = await admin.evaluate(() => {
        const lum = c => { const m = c.match(/\d+(\.\d+)?/g).map(Number); const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(m[0]) + 0.7152 * f(m[1]) + 0.0722 * f(m[2]); };
        const h = document.querySelector('#aclDrawer .atl-drawer__header h5');
        const a = lum(getComputedStyle(h).color), b = lum(getComputedStyle(document.getElementById('aclDrawer')).backgroundColor);
        return { ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05), font: getComputedStyle(document.querySelector('#aclPreviewLedger .acc-feature__title, #aclPreviewLedger .acc-entry__title')).fontFamily };
    });
    ok(light.ratio >= 4.5, 'light theme: the drawer title is readable (contrast >= 4.5:1)', JSON.stringify(light));
    ok(/Cormorant/.test(light.font), 'preview: keeps the website\'s Cormorant title font inside the admin', light.font);
    await domClick(admin, '#aclCancelBtn');
    await admin.evaluate(() => document.documentElement.removeAttribute('data-theme'));
    await admin.setViewport({ width: 390, height: 844 });
    await sleep(500);
    const madm = await admin.evaluate(() => { const s = document.getElementById('accoladesAdmin'); return { overflow: s.scrollWidth - s.clientWidth, cards: document.querySelectorAll('#adminAccoladesList .acl-card').length }; });
    ok(madm.overflow <= 0 && madm.cards > 0, 'admin mobile: the section fits without sideways scrolling', JSON.stringify(madm));
    await admin.setViewport({ width: 1440, height: 1000 });

    // ══════════ 16. Settings → Website Sections switch hides the whole section ══════════
    const before = (await (await fetch(`${BASE}/api/public/site-content`)).json()).sections;
    await api('PUT', `/api/admin/accolades/${B}`, { status: 'active' });
    // Through the real Settings UI: the new row exists, is on, and switching it off + saving works.
    await admin.evaluate(() => window.switchTab('preferencesAdmin'));
    await domClick(admin, '[data-um-tab="prefPanelSections"]');
    const rowOn = await admin.waitForFunction(() => { const t = document.getElementById('secToggle-accolades'); return t && t.getAttribute('aria-checked') === 'true'; }, { timeout: 15000 }).then(() => true, () => false);
    ok(rowOn, 'Settings → Website Sections lists "Accolades & Recognition", on by default', '');
    await domClick(admin, '#secToggle-accolades');
    await domClick(admin, '#btnSaveSections');
    await admin.waitForSelector('#tm-modal-confirm', { visible: true, timeout: 5000 });
    await domClick(admin, '#tm-modal-confirm');
    const saved = await waitForApi(async () => (await (await fetch(`${BASE}/api/public/site-content`)).json()).sections.accolades === false, 'sections');
    ok(!!saved, 'Website Sections: switching it off and saving stores accolades=false', '');
    await admin.evaluate(() => window.switchTab('accoladesAdmin'));
    {
        const p = await openPublic(browser);
        await sleep(800);
        const off = await p.evaluate(() => ({ shown: !!document.getElementById('accolades').offsetParent, cls: document.getElementById('accolades').classList.contains('tm-section-hidden'), mob: getComputedStyle(document.querySelector('.tm-mobile-menu a[href="#accolades"]')).display }));
        ok(!off.shown && off.cls && off.mob === 'none', 'section switched off in Settings: hidden on the website even with accolades published', JSON.stringify(off));
        await p.close();
    }
    await reloadList(admin);
    const notice = await admin.evaluate(() => { const n = document.getElementById('aclSectionNotice'); return !n.hidden && n.textContent; });
    ok(/switched off/.test(notice || ''), 'section switched off: the admin says so above the list', String(notice));
    await api('PUT', '/api/admin/site-content', { section_visibility: before });

    await browser.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    await support.stop();
    console.log(fails ? `\n${fails} FAILURE(S)` : '\nALL PASS');
    process.exit(fails ? 1 : 0);
})().catch(async e => { console.error('ERR', e.stack || e.message); try { await support.stop(); } catch (_) {} process.exit(2); });
