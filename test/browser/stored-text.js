// Stored text, shown as text - browser test. The database holds user text entity-encoded once ("Tom &amp; Jerry&#x27;s",
// app.js deepEscapeBody); js/shared/stored-text.js makes jQuery's .val() / .text() decode it so forms and text nodes show
// what was typed. Boots the app on an isolated DB copy (test/support.js); owns the rows it creates. Not part of
// `npm test`: run it with `npm run test:browser`.
//
//   admin: the Testimonials and Events editors load the text as typed, and saving it unchanged adds no encoding layer;
//          the booking deal view title and the Users list show the text, not "&amp;" / "&#x27;"
//   public: the testimonial carousel and the manager name show the text, not entities; no page errors
const sqlite3 = require('sqlite3');
const support = require('../support');
const puppeteer = require('puppeteer');
const { BASE, sleep } = support;
let fails = 0;
const ok = (c, n, detail) => { if (!c) fails++; console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '\n        -> ' + detail)); };

const PASSWORD = 'TestRunnerPass1!';
const enc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
const RAW = 'Tom\'s "big" & loud';           // no markup: keeps the visible-text comparisons simple
const ONCE = enc(RAW);

const sqlRun = (sql, params = []) => new Promise((res, rej) => { const db = new sqlite3.Database(support.TEST_DB); db.run(sql, params, function (e) { db.close(); e ? rej(e) : res(this); }); });
const sqlAll = (sql, params = []) => new Promise((res, rej) => { const db = new sqlite3.Database(support.TEST_DB, sqlite3.OPEN_READONLY); db.all(sql, params, (e, r) => { db.close(); e ? rej(e) : res(r); }); });
const noise = /Failed to load resource|Loading the font|Loading the image 'https:\/\/placehold\.co\//;
function watchErrors(p) {
    p._errs = [];
    p.on('pageerror', e => p._errs.push(e.message.slice(0, 200)));
    p.on('console', m => { if (m.type() === 'error' && !noise.test(m.text())) p._errs.push('console: ' + m.text().slice(0, 200)); });
}
const domClick = (p, sel) => p.$eval(sel, e => e.click());

(async () => {
    await support.start();
    const loginRes = await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'test.runner@example.invalid', password: PASSWORD }) });
    const cookie = loginRes.headers.get('set-cookie').split(';')[0];
    const api = async (method, url, body) => { const r = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body ? JSON.stringify(body) : undefined }); let j = null; try { j = await r.json(); } catch (e) {} return { status: r.status, body: j }; };

    // Rows of this test's own. The carousel shows approved testimonials, so this test owns that table on its throwaway copy.
    await sqlRun('DELETE FROM testimonials');
    const t = await api('POST', '/api/admin/testimonials', { name: RAW, designation: RAW, quote: RAW });
    const tid = t.body.id;
    const future = new Date(Date.now() + 90 * 864e5).toISOString().slice(0, 10);
    const ev = await api('POST', '/api/admin/events', { event_title: RAW, event_description: RAW, event_datetime: future + 'T18:00', event_type: 'Corporate Event', venue_name: RAW, ticket_sales_link: 'https://t.example.test/e?a=1&b=2' });
    const evId = ev.body.event_id || (ev.body.event && ev.body.event.event_id) || ev.body.id;
    const bk = await api('POST', '/api/admin/bookings', { name: RAW, email: `st.${Date.now()}@example.invalid`, cell: '+27821234567', event_date: new Date(Date.now() + 150 * 864e5).toISOString().slice(0, 10), event_name: RAW, event_type: 'Corporate', event_location: 'Hall', message: 'Stored-text browser test booking.', services: [{ service_id: 15 }], status: 'NEW', override_working_hours: true });
    const bkId = bk.body.booking_id;
    const mgr = await api('PUT', '/api/admin/manager', { name: RAW, cell_number: '+27821234567', whatsapp_number: '+27821234567', email: 'mgr@example.invalid' });
    const usr = await api('POST', '/api/admin/users', { email: `st.user.${Date.now()}@example.invalid`, full_name: "Zed O'Neil & Co", phone: '+27821230000', role: 'manager' });

    const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-quic'] });

    // ══════════ public ══════════
    {
        const ctx = await browser.createBrowserContext();
        const p = await ctx.newPage();
        await p.setViewport({ width: 1440, height: 900 });
        watchErrors(p);
        const loaded = Promise.all([p.waitForResponse(r => r.url().includes('/api/public/testimonials'), { timeout: 60000 }), p.waitForResponse(r => r.url().includes('/api/public/manager'), { timeout: 60000 })]);
        await p.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
        await loaded;
        await p.waitForFunction(() => document.getElementById('ctQuote') && document.getElementById('ctQuote').textContent.trim(), { timeout: 20000 }).catch(() => {});
        await sleep(500);
        const v = await p.evaluate(() => ({ name: document.getElementById('ctName').textContent, designation: document.getElementById('ctDesignation').textContent, quote: document.getElementById('ctQuote').textContent, manager: document.getElementById('dynamicManagerName').textContent, alt: (document.querySelector('.ct-image-slot img') || {}).alt }));
        ok(v.name === RAW && v.designation === RAW && v.quote === RAW, 'public: the testimonial carousel shows name, designation and quote as typed (no "&#x27;" / "&amp;")', JSON.stringify(v));
        ok(v.manager === RAW, 'public: the manager name shows as typed', JSON.stringify(v.manager));
        ok(p._errs.length === 0, 'public: no page errors', p._errs.join(' | '));
        await ctx.close();
    }

    // ══════════ admin ══════════
    {
        const ctx = await browser.createBrowserContext();
        const p = await ctx.newPage();
        await p.setViewport({ width: 1500, height: 1000 });
        watchErrors(p);
        const [name, ...rest] = cookie.split('=');
        await p.setCookie({ name, value: rest.join('='), url: BASE });
        await p.setRequestInterception(true);
        p.on('request', r => /\/api\/admin\/maps-config/.test(r.url()) ? r.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, key: '' }) }) : r.continue());
        await p.goto(BASE + '/admin.html', { waitUntil: 'networkidle0', timeout: 90000 });
        await p.waitForFunction(() => typeof window.loadTestimonials === 'function' && typeof window.decodeStoredText === 'function', { timeout: 30000 });

        // Testimonials editor
        await p.evaluate(() => window.switchTab('testimonialsAdmin'));
        await p.evaluate(() => window.loadTestimonials());
        await p.waitForSelector(`#adminTestimonialsList .testimonial-edit-btn[data-id="${tid}"]`, { timeout: 15000 });
        const cardTitle = await p.$eval(`#adminTestimonialsList .atl-edit-card[data-id="${tid}"] .atl-edit-card__title`, e => e.textContent);
        ok(cardTitle === RAW, 'admin: the testimonial card title shows the name as typed', JSON.stringify(cardTitle));
        await domClick(p, `#adminTestimonialsList .testimonial-edit-btn[data-id="${tid}"]`);
        await p.waitForFunction(() => document.getElementById('testimonialName').value !== '', { timeout: 10000 });
        const tv = await p.evaluate(() => ({ n: document.getElementById('testimonialName').value, d: document.getElementById('testimonialDesignation').value, q: document.getElementById('testimonialQuote').value }));
        ok(tv.n === RAW && tv.d === RAW && tv.q === RAW, 'admin: the testimonial editor loads name/designation/quote as typed', JSON.stringify(tv));
        await domClick(p, '#testimonialsSubmitBtn');
        await sleep(1200);
        const tRow = (await sqlAll('SELECT name, designation, quote FROM testimonials WHERE id = ?', [tid]))[0];
        ok(tRow.name === ONCE && tRow.designation === ONCE && tRow.quote === ONCE, 'admin: saving the testimonial unchanged adds no encoding layer', JSON.stringify(tRow));

        // Events editor
        await p.evaluate(() => window.switchTab('eventsAdmin'));
        await p.evaluate(() => window.switchTab('eventsAdmin'));
        await p.waitForSelector(`.atl-event-card[data-id="${evId}"]`, { timeout: 20000 });
        await p.evaluate(id => window.openEvtEditDrawer(id), evId);
        await p.waitForFunction(() => document.getElementById('eventsTitle') && document.getElementById('eventsTitle').value !== '', { timeout: 10000 });
        const ev1 = await p.evaluate(() => ({ title: document.getElementById('eventsTitle').value, desc: document.getElementById('eventsDesc').value, venue: document.getElementById('eventsVenue').value, ticket: document.getElementById('eventsTicketUrl').value }));
        ok(ev1.title === RAW && ev1.desc === RAW && ev1.venue === RAW && ev1.ticket === 'https://t.example.test/e?a=1&b=2', 'admin: the event editor loads title/description/venue/ticket URL as typed', JSON.stringify(ev1));
        await domClick(p, '#eventsSubmitBtn');
        await sleep(1500);
        const evRow = (await sqlAll('SELECT event_title, event_description, venue_name, ticket_sales_link FROM events WHERE event_id = ?', [evId]))[0];
        ok(evRow.event_title === ONCE && evRow.event_description === ONCE && evRow.venue_name === ONCE && evRow.ticket_sales_link === 'https://t.example.test/e?a=1&amp;b=2', 'admin: saving the event unchanged adds no encoding layer', JSON.stringify(evRow));

        // Booking deal view title
        await p.evaluate(() => window.switchTab('bookingsAdmin'));
        await sleep(2500);
        const clicked = await p.evaluate(id => { const el = document.querySelector('[data-id="' + id + '"]'); if (el) { el.click(); return true; } return false; }, bkId);
        await sleep(2500);
        const dv = clicked ? await p.evaluate(() => (document.getElementById('dvTitle') || {}).textContent) : null;
        ok(clicked && dv === RAW, 'admin: the booking deal view title shows the event name as typed', JSON.stringify({ clicked, dv }));

        // Users list
        await p.evaluate(() => window.switchTab('usersAdmin'));
        await sleep(800);
        await domClick(p, '[data-um-tab="umPanelUsers"]');
        await p.waitForSelector('#umUserSearch', { visible: true, timeout: 10000 });
        await p.type('#umUserSearch', 'Zed');          // the list is paginated - search for this test's own user
        await sleep(1500);
        const users = await p.evaluate(() => document.body.innerText);
        ok(/Zed O'Neil & Co/.test(users) && !/O&#x27;Neil|&amp; Co/.test(users), 'admin: the Users list shows the full name as typed', JSON.stringify({ created: usr.status + ' ' + JSON.stringify(usr.body).slice(0, 140), snippet: (users.match(/Zed[^\n]{0,30}/) || ['(not found)'])[0], head: users.slice(0, 200) }));
        ok(p._errs.length === 0, 'admin: no page errors', p._errs.join(' | '));
        await ctx.close();
    }

    // ── tidy up (the DB is a throwaway copy) ──
    await api('DELETE', `/api/admin/testimonials/${tid}`); await api('DELETE', `/api/admin/events/${evId}`);
    await browser.close();
    await support.stop();
    console.log(fails ? `\n${fails} FAILED` : '\nAll passed');
    process.exit(fails ? 1 : 0);
})().catch(async e => { console.error('ERR', e.stack || e.message); try { await support.stop(); } catch (_) {} process.exit(2); });
