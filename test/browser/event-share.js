// Share a show with friends (js/event-share.js) through the real homepage in headless Chrome on an isolated DB copy (test/support.js):
//   * every upcoming event card has a round Share button on its poster (past shows none); on a phone it opens the system share sheet with
//     the show's short link /e/<id> - and does NOT open the details pop-up;
//   * without a system share sheet (most desktops): a menu - WhatsApp / Facebook / X / Copy link - Esc closes it and focus goes back;
//   * the details pop-up and the Get Tickets drawer have a "Share with friends" button too;
//   * a friend arriving from the link: /e/<id> -> /?event=<id> opens that show's Get Tickets drawer; a show without tickets sold here
//     opens its details pop-up; the ?event= goes from the address bar.
// Not part of `npm test`: run with `npm run test:browser` (needs PUPPETEER_EXECUTABLE_PATH). Date offsets 1993-1994.
const fs = require('fs');
const path = require('path');
const support = require('../support');
const puppeteer = require('puppeteer');
const { BASE, sleep, api, future } = support;
let fails = 0;
const ok = (c, n, detail) => { if (!c) fails++; console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '\n        -> ' + String(detail).slice(0, 500))); };
const SHOTS = process.env.TICKET_SHOTS_DIR || null;
// polls through page changes (the share page hands over to the homepage with a meta refresh, which can strand a waitForFunction)
const until = async (page, fn, ms = 20000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await page.evaluate(fn).catch(() => false); if (v) return v; await sleep(200); } return false; };
const shot = async (page, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, name + '.png') }); } };

(async () => {
    await support.start();
    let browser;
    const made = [];
    try {
        const mk = async (offset, title) => {
            const when = `${future(offset)}T20:00`;
            const ev = (await api('POST', '/api/admin/events', { event_title: title, event_datetime: when, venue_name: 'Share Hall', event_status: 'upcoming', sync_to_gcal: false })).body;
            made.push({ id: ev.id, title, when });
            return ev.id;
        };
        const tix = await mk(1993, 'ZZ Share Ticketed Show');
        await api('POST', `/api/admin/events/${tix}/ticket-types`, { name: 'General', price: '150', capacity: 20, max_per_order: 4, is_active: true });
        const plain = await mk(1994, 'ZZ Share Plain Show');

        browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-quic'], executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined });
        const newPage = async (w, h, withShareSheet) => {
            const ctx = await browser.createBrowserContext();
            const page = await ctx.newPage();
            await page.setViewport({ width: w, height: h });
            page.errs = [];
            page.on('pageerror', e => page.errs.push(e.message.slice(0, 200)));
            // a phone's share sheet is stood in for (it is the operating system's, not the page's); a desktop without one has none
            await page.evaluateOnNewDocument((sheet) => {
                if (sheet) { navigator.share = (d) => { window.__shared = d; return Promise.resolve(); }; }
                else { try { delete Navigator.prototype.share; } catch (e) {} try { delete navigator.share; } catch (e) {} }
            }, !!withShareSheet);
            await page.setRequestInterception(true);
            page.on('request', (req) => {
                if (/placehold\.co|fonts\.g|googletagmanager|google-analytics|wa\.me|facebook\.com|twitter\.com/.test(req.url())) return req.respond({ status: 200, contentType: 'text/plain', body: '' });
                req.continue();
            });
            return page;
        };
        const card = (id) => `#upcomingEventsGrid .live-event-card[data-payload*="%22event_id%22%3A${id}%2C"]`;
        const gotoHome = async (page, qs = '') => {
            await page.goto(`${BASE}/${qs}`, { waitUntil: 'domcontentloaded' });
            await page.waitForSelector('#upcomingEventsGrid .ev-card', { timeout: 20000 });
            await sleep(300);
            await page.evaluate(() => { const x = document.getElementById('cookieRejectAll'); if (x && x.offsetParent) x.click(); });
            await sleep(300);
        };
        const drawerOpen = (page) => page.$eval('#ticketDrawer', el => el.classList.contains('atl-drawer--open')).catch(() => false);
        const modalOpen = (page) => page.$eval('#eventDetailsModal', el => el.classList.contains('in') || el.classList.contains('show') || getComputedStyle(el).display === 'block').catch(() => false);

        // ═══ phone: the system share sheet ═══
        const phone = await newPage(390, 844, true);
        await gotoHome(phone);
        await phone.waitForSelector(card(tix) + ' .ev-card__share', { timeout: 10000 });
        const counts = await phone.evaluate(() => ({ up: document.querySelectorAll('#upcomingEventsGrid .live-event-card').length, upShare: document.querySelectorAll('#upcomingEventsGrid .ev-card__share').length, pastShare: document.querySelectorAll('#pastEventsGrid .ev-card__share').length }));
        const size = await phone.$eval(card(tix) + ' .ev-card__share', el => { const r = el.getBoundingClientRect(); return [r.width, r.height]; });
        ok(counts.upShare === counts.up && counts.pastShare === 0 && size[0] >= 44 && size[1] >= 44, 'every upcoming card has a Share button on its poster (44px, easy to tap); past shows have none', JSON.stringify([counts, size]));
        await phone.$eval(card(tix), el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
        await sleep(800);
        await shot(phone, 'share-1-card');
        await phone.$eval(card(tix) + ' .ev-card__share', el => el.click());          // a script click: the cards are still sliding in
        await sleep(400);
        const shared = await phone.evaluate(() => window.__shared || null);
        ok(!!shared && shared.url === `${BASE}/e/${tix}` && shared.title === 'ZZ Share Ticketed Show' && /Share Hall/.test(shared.text) && !(await modalOpen(phone)),
            'on a phone, Share opens the system share sheet with the show\'s short link, name, date and venue - and not the details pop-up', JSON.stringify(shared));
        ok(phone.errs.length === 0, 'no script errors on the phone', phone.errs.join(' | '));
        await phone.close();

        // ═══ desktop: the menu ═══
        const desk = await newPage(1440, 900, false);
        await gotoHome(desk);
        await desk.waitForSelector(card(plain) + ' .ev-card__share', { timeout: 10000 });
        await desk.$eval(card(plain), el => el.scrollIntoView({ block: 'center' }));
        await desk.click(card(plain) + ' .ev-card__share');
        await desk.waitForSelector('.tm-share-menu', { visible: true, timeout: 5000 });
        const m = await desk.evaluate(() => {
            const menu = document.querySelector('.tm-share-menu');
            const r = menu.getBoundingClientRect();
            return { items: [...menu.querySelectorAll('.tm-share-menu__item')].map(a => a.innerText.trim()), wa: menu.querySelector('a[href*="wa.me"]').href, fb: menu.querySelector('a[href*="facebook.com"]').href,
                focus: !!document.activeElement.closest('.tm-share-menu'), inView: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight };
        });
        ok(m.items.join('|') === 'WhatsApp|Facebook|X|Copy link' && decodeURIComponent(m.wa).includes(`/e/${plain}`) && decodeURIComponent(m.fb).includes(`/e/${plain}`) && m.focus && m.inView && !(await modalOpen(desk)),
            'without a share sheet: a menu - WhatsApp, Facebook, X, Copy link - each carrying the show\'s short link; focus moves into it; it fits on screen', JSON.stringify(m));
        await shot(desk, 'share-2-menu');
        await desk.click('.tm-share-menu [data-share-copy]');
        await desk.waitForFunction(() => { const n = document.querySelector('.tm-share-menu__note'); return n && n.textContent.length > 0; }, { timeout: 5000 });
        const note = await desk.$eval('.tm-share-menu__note', el => el.textContent);
        ok(/Link copied/.test(note) || note.includes(`/e/${plain}`), 'Copy link: "Link copied" (or the link itself to copy by hand, when the browser refuses the clipboard)', note);
        await desk.keyboard.press('Escape');
        await sleep(200);
        const afterEsc = await desk.evaluate(() => ({ menu: !!document.querySelector('.tm-share-menu'), focusOnShare: !!document.activeElement && document.activeElement.classList.contains('ev-card__share') }));
        ok(!afterEsc.menu && afterEsc.focusOnShare, 'Esc closes the menu and puts focus back on the Share button', JSON.stringify(afterEsc));

        // the details pop-up
        await desk.click(card(plain));
        await desk.waitForSelector('#modalEventShareBtn', { visible: true, timeout: 10000 });
        await sleep(500);
        await desk.click('#modalEventShareBtn');
        await desk.waitForSelector('.tm-share-menu', { visible: true, timeout: 5000 });
        const mm = await desk.$eval('.tm-share-menu a[href*="wa.me"]', a => decodeURIComponent(a.href));
        // every item really visible (not under the pop-up), and focus inside the menu (the pop-up's focus trap must not pull it back)
        const onTop = () => desk.evaluate(() => [...document.querySelectorAll('.tm-share-menu .tm-share-menu__item')].every(i => { const r = i.getBoundingClientRect(); const el = document.elementFromPoint(r.left + 10, r.top + r.height / 2); return !!el && !!el.closest('.tm-share-menu'); })
            && !!document.activeElement.closest('.tm-share-menu'));
        ok(mm.includes(`/e/${plain}`) && mm.includes('ZZ Share Plain Show') && await onTop(), 'the details pop-up has "Share with friends" - the menu opens ON TOP of the pop-up (every item visible, focus in it) with that show\'s link', mm);
        await shot(desk, 'share-3-modal');
        await desk.keyboard.press('Escape');
        await desk.evaluate(() => window.jQuery('#eventDetailsModal').modal('hide'));
        await sleep(600);

        // the Get Tickets drawer
        await desk.$eval(`.tk-open[data-ticket-event="${tix}"]`, el => el.click());
        await desk.waitForSelector('#ticketDrawer .tk-share', { visible: true, timeout: 10000 });
        await sleep(500);
        await desk.click('#ticketDrawer .tk-share');
        await desk.waitForSelector('.tm-share-menu', { visible: true, timeout: 5000 });
        const dm = await desk.$eval('.tm-share-menu a[href*="wa.me"]', a => decodeURIComponent(a.href));
        const menuOnTop = await onTop();
        const nearButton = await desk.evaluate(() => { const b = document.querySelector('#ticketDrawer .tk-share').getBoundingClientRect(); const m = document.querySelector('.tm-share-menu').getBoundingClientRect(); return Math.abs(m.top - b.bottom) < 12 || Math.abs(b.top - m.bottom) < 12; });
        ok(dm.includes(`/e/${tix}`) && dm.includes('ZZ Share Ticketed Show') && menuOnTop && nearButton, 'the Get Tickets drawer has "Share with friends" under the show\'s name; its menu sits on top of the drawer, right by the button, focus in it', JSON.stringify([dm, menuOnTop, nearButton]));
        await shot(desk, 'share-4-drawer');
        ok(desk.errs.length === 0, 'no script errors on the desktop', desk.errs.join(' | '));
        await desk.close();

        // ═══ a friend arrives from the link ═══
        const friend = await newPage(390, 844, true);
        await friend.goto(`${BASE}/e/${tix}`, { waitUntil: 'domcontentloaded' });
        await until(friend, () => location.pathname === '/' && !!document.querySelector('#ticketDrawer.atl-drawer--open .tk-tier'));
        await friend.evaluate(() => { const x = document.getElementById('cookieRejectAll'); if (x && x.offsetParent) x.click(); });
        await sleep(400);
        const fd = await friend.evaluate(() => ({ title: (document.querySelector('#ticketDrawer .tk-event__title') || {}).innerText, url: location.href }));
        ok(fd.title === 'ZZ Share Ticketed Show' && !/event=/.test(fd.url), 'the shared link (/e/<id>) opens the homepage with THAT show\'s Get Tickets drawer, and the address bar is clean again', JSON.stringify(fd));
        await shot(friend, 'share-5-arrived');
        await friend.close();

        const friend2 = await newPage(1440, 900, false);
        await gotoHome(friend2, `?event=${plain}`);
        await until(friend2, () => /ZZ Share Plain Show/.test((document.getElementById('modalEventTitle') || {}).innerText || ''));
        await sleep(500);
        ok(await modalOpen(friend2) && !(await drawerOpen(friend2)), 'a shared show without tickets sold here opens its details pop-up', '');
        ok(friend2.errs.length === 0, 'no script errors for the arriving friend', friend2.errs.join(' | '));
        await friend2.close();
    } catch (e) {
        fails++;
        console.log('FAIL unexpected error: ' + (e && e.stack || e));
    } finally {
        for (const m of made) await api('PUT', `/api/admin/events/${m.id}`, { event_title: m.title, event_datetime: m.when, event_status: 'cancelled', sync_to_gcal: false }).catch(() => {});
        if (browser) await browser.close().catch(() => {});
        await support.stop();
    }
    console.log(fails ? `\n${fails} check(s) FAILED` : '\nAll share browser checks passed');
    process.exit(fails ? 1 : 0);
})();
