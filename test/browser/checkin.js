// Event ticketing - the DOOR and the OFFICE through the real pages in headless Chrome on an isolated DB copy (test/support.js):
//   * /t/<token>: a stranger sees only "Valid ticket for <show>"; signed-in staff get holder / tier / status and a Check In button,
//     and opening the page never checks anyone in;
//   * /checkin at phone width: the event, the live counter, find-by-name, Check In -> green "Admitted", a second scan -> red
//     "Already scanned at HH:MM", a ticket for another show -> "Wrong show", and "Sign in first" for a stranger;
//   * the scanner's decoder: the QR code the server puts on a ticket, decoded by the bundled jsQR, gives back that ticket's token;
//   * the admin portal: Events -> Ticket Sales (figures, the order list, the order drawer) and the event drawer's Tickets tab.
// Not part of `npm test`: run with `npm run test:browser` (needs PUPPETEER_EXECUTABLE_PATH). Date offsets 1960-1969.
const fs = require('fs');
const path = require('path');
const support = require('../support');
const puppeteer = require('puppeteer');
const { generatePayFastItnSignature } = require('../../lib/payfast-signature');
const { BASE, sleep, api, pub, one, q, future } = support;
let fails = 0;
const ok = (c, n, detail) => { if (!c) fails++; console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '\n        -> ' + String(detail).slice(0, 500))); };
const SHOTS = process.env.TICKET_SHOTS_DIR || null;
const shot = async (page, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, name + '.png') }); } };
const waitFor = async (fn, ms = 15000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(150); } return v; };

async function adminCookie() {
    const r = await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'test.runner@example.invalid', password: 'TestRunnerPass1!' }) });
    const sc = r.headers.get('set-cookie');
    if (r.status !== 200 || !sc) throw new Error('admin login failed: ' + r.status);
    return sc.split(';')[0];
}

// a paid order with n tickets for an event, the way production makes one (reserve -> checkout -> PayFast's signed notification)
async function paidOrder(eventId, tierId, n, buyerName) {
    const o = (await pub('POST', '/api/public/ticket-orders', { event_id: eventId, items: [{ ticket_type_id: tierId, quantity: n }] })).body.order;
    await pub('POST', `/api/public/ticket-orders/${o.reference}/checkout`, { buyer_name: buyerName, buyer_email: `door.${Date.now()}.${n}@example.invalid`, buyer_phone: '0821234567', popia_consent: true, terms_accepted: true });
    const row = await one('SELECT * FROM ticket_orders WHERE public_reference = ?', [o.reference]);
    const m = { m_payment_id: row.m_payment_id, pf_payment_id: `DOOR-PF-${Date.now()}-${n}`, payment_status: 'COMPLETE', item_name: 'x', item_description: '', amount_gross: (row.total_cents / 100).toFixed(2), amount_fee: '-1.00', amount_net: '1.00',
        custom_str1: '', custom_str2: '', custom_str3: '', custom_str4: '', custom_str5: '', custom_int1: '', custom_int2: '', custom_int3: '', custom_int4: '', custom_int5: '', name_first: 'D', name_last: 'B', email_address: row.buyer_email, merchant_id: '10000100' };
    m.signature = generatePayFastItnSignature(m, null);
    await pub('POST', '/api/payment/webhook/payfast', m);
    await waitFor(async () => (await one('SELECT status FROM ticket_orders WHERE id = ?', [row.id])).status === 'paid');
    return { order: row, reference: o.reference, tickets: await q('SELECT * FROM tickets WHERE order_id = ? ORDER BY id', [row.id]) };
}

(async () => {
    await support.start();
    let browser;
    const made = [];
    try {
        const mk = async (offset, title) => {
            const when = `${future(offset)}T19:30`;
            const ev = (await api('POST', '/api/admin/events', { event_title: title, event_datetime: when, venue_name: 'Door Test Venue', event_status: 'upcoming', sync_to_gcal: false })).body;
            made.push({ id: ev.id, title, when });
            const tier = (await api('POST', `/api/admin/events/${ev.id}/ticket-types`, { name: 'General', price: '120', capacity: 30, max_per_order: 4, is_active: true })).body.tier;
            return { id: ev.id, tier };
        };
        const show = await mk(1960, 'ZZ Door Show');
        const other = await mk(1961, 'ZZ Other Night');
        const A = await paidOrder(show.id, show.tier.id, 2, 'Ayanda Door');
        const B = await paidOrder(show.id, show.tier.id, 1, 'Bongani Door');
        const X = await paidOrder(other.id, other.tier.id, 1, 'Xolani Other');
        ok(A.tickets.length === 2 && B.tickets.length === 1 && X.tickets.length === 1, 'setup: two paid orders for the show (3 tickets) and one for another night', JSON.stringify([A.tickets.length, B.tickets.length, X.tickets.length]));
        const cookie = await adminCookie();
        browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-quic'], executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined });
        const newPage = async (w, h, withCookie) => {
            const ctx = await browser.createBrowserContext();
            const p = await ctx.newPage();
            await p.setViewport({ width: w, height: h });
            p.errs = [];
            p.on('pageerror', e => p.errs.push(e.message.slice(0, 200)));
            if (withCookie) { const [name, ...rest] = cookie.split('='); await p.setCookie({ name, value: rest.join('='), url: BASE }); }
            await p.setRequestInterception(true);
            p.on('request', r => {
                const u = r.url();
                if (/\/api\/admin\/maps-config/.test(u)) return r.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, key: '' }) });
                if (/placehold\.co|googletagmanager|google-analytics/.test(u)) return r.respond({ status: 200, contentType: 'text/plain', body: '' });
                r.continue();
            });
            return p;
        };
        const text = (p, sel) => p.$eval(sel, el => el.innerText).catch(() => '');

        // ═══ /t/<token> ═══
        const [a1, a2] = A.tickets;
        const anon = await newPage(390, 844, false);
        await anon.goto(`${BASE}/t/${a1.token}`, { waitUntil: 'networkidle0' });
        await sleep(400);
        const anonText = await anon.evaluate(() => document.body.innerText);
        const staffHidden = await anon.$eval('#ckStaff', el => el.hidden);
        ok(/Valid ticket for ZZ Door Show/.test(anonText) && !/Ayanda/.test(anonText) && !/Check In/i.test(anonText) && staffHidden,
            '/t/<token> for a stranger: "Valid ticket for ZZ Door Show" - no name, no Check In button', anonText);
        await shot(anon, 'door-1-public');
        await anon.close();

        const staffT = await newPage(390, 844, true);
        await staffT.goto(`${BASE}/t/${a1.token}`, { waitUntil: 'networkidle0' });
        await staffT.waitForSelector('#ckStaff [data-checkin]', { timeout: 10000 });
        const staffText = await text(staffT, '#ckStaff');
        ok(/Ayanda Door/.test(staffText) && /General/.test(staffText) && /Valid - not yet in/.test(staffText), 'the same link for signed-in staff: holder, ticket type, status and a Check In button', staffText);
        ok(!(await one('SELECT checked_in_at FROM tickets WHERE id = ?', [a1.id])).checked_in_at, 'opening the ticket page (even as staff) checked nobody in', '');
        await shot(staffT, 'door-2-staff');
        await staffT.click('#ckStaff [data-checkin]');
        await staffT.waitForSelector('#ckStaff .ck-banner', { timeout: 10000 });
        const admitted = await text(staffT, '#ckStaff .ck-banner');
        ok(admitted === 'Admitted' && !!(await one('SELECT checked_in_at FROM tickets WHERE id = ?', [a1.id])).checked_in_at, 'one tap on Check In: a green "Admitted" and the ticket is checked in', admitted);
        await shot(staffT, 'door-3-admitted');
        await staffT.reload({ waitUntil: 'networkidle0' });
        await staffT.waitForSelector('#ckStaff:not([hidden])', { timeout: 10000 });
        const again = await text(staffT, '#ckStaff');
        ok(/Checked in at \d{2}:\d{2}/.test(again) && !(await staffT.$('#ckStaff [data-checkin]')), 'scanning it again shows when it was checked in, and no Check In button', again);
        await staffT.close();

        // ═══ /checkin (phone) ═══
        const door = await newPage(390, 844, true);
        await door.goto(`${BASE}/checkin?event=${show.id}`, { waitUntil: 'networkidle0' });
        await door.waitForSelector('#ckManual:not([hidden])', { timeout: 10000 });
        const sel = await door.$eval('#ckEvent', el => Number(el.value));
        await waitFor(async () => /checked in/.test(await text(door, '#ckCount')));
        ok(sel === show.id && /^1 of 3 checked in$/.test(await text(door, '#ckCount')), 'the scanner opens on the show from the link, with the live counter (1 of 3 in)', await text(door, '#ckCount'));
        const camButtons = await door.evaluate(() => ({ start: getComputedStyle(document.getElementById('ckStart')).display, stop: getComputedStyle(document.getElementById('ckStop')).display }));
        ok(camButtons.start !== 'none' && camButtons.stop === 'none', 'a Start scanning button for the camera (and no Stop button until the camera is on)', JSON.stringify(camButtons));
        await shot(door, 'door-4-scanner');
        // find by name -> Check In
        await door.type('#ckSearch', 'Bongani');
        await door.click('#ckSearchForm .ck-btn');
        await door.waitForSelector('#ckFound [data-checkin]', { timeout: 10000 });
        await door.click('#ckFound [data-checkin]');
        await door.waitForSelector('#ckResult .ck-banner', { timeout: 10000 });
        const r1 = await text(door, '#ckResult .ck-banner');
        await waitFor(async () => /^2 of 3/.test(await text(door, '#ckCount')));
        ok(r1 === 'Admitted' && /^2 of 3 checked in$/.test(await text(door, '#ckCount')), 'find by name -> Check In: "Admitted", and the counter moves to 2 of 3', r1 + ' / ' + await text(door, '#ckCount'));
        await shot(door, 'door-5-admitted');
        // the same ticket's code typed in: already in
        await door.click('#ckNext');
        await door.$eval('#ckSearch', el => { el.value = ''; });
        await door.type('#ckSearch', B.tickets[0].token.match(/.{1,4}/g).join(' '));      // as printed on the PDF
        await door.click('#ckSearchForm .ck-btn');
        await door.waitForSelector('#ckResult .ck-banner', { timeout: 10000 });
        const r2 = await text(door, '#ckResult .ck-banner');
        const r2Class = await door.$eval('#ckResult .ck-banner', el => el.className);
        ok(/^Already scanned at \d{2}:\d{2}$/.test(r2) && /ck-banner--bad/.test(r2Class), 'the printed code of a ticket that is already in: a red "Already scanned at HH:MM"', r2);
        await shot(door, 'door-6-already');
        // a ticket for another night
        await door.click('#ckNext');
        await door.$eval('#ckSearch', el => { el.value = ''; });
        await door.type('#ckSearch', X.tickets[0].token);
        await door.click('#ckSearchForm .ck-btn');
        await door.waitForSelector('#ckResult .ck-banner', { timeout: 10000 });
        const r3 = await text(door, '#ckResult .ck-banner');
        ok(/^Wrong show/.test(r3) && !(await door.$('#ckResult [data-checkin]')) && !(await one('SELECT checked_in_at FROM tickets WHERE id = ?', [X.tickets[0].id])).checked_in_at,
            'a ticket for ANOTHER show: "Wrong show", no Check In, not checked in', r3);
        // the signal drops while Check In is pressed: the phone must SAY so (never silently re-enable), and when the check-in did reach the
        // server, "Check again" must show this phone's own admission in green - not a red "Already scanned" that would turn the guest away
        await door.click('#ckNext');
        await door.$eval('#ckSearch', el => { el.value = ''; });
        await door.type('#ckSearch', a2.token);
        await door.click('#ckSearchForm .ck-btn');
        await door.waitForSelector('#ckResult [data-checkin]', { timeout: 10000 });
        await door.setOfflineMode(true);
        await door.click('#ckResult [data-checkin]');
        await door.waitForSelector('#ckResult [data-recheck]', { timeout: 10000 });
        const lost = await text(door, '#ckResult');
        ok(/Connection lost/.test(lost) && /Check this ticket again before letting the guest in/.test(lost), 'signal lost during Check In: the phone says so and offers Check again (no silent retry button)', lost);
        await shot(door, 'door-7-lost');
        await api('POST', `/api/admin/ticketing/tickets/${a2.token}/check-in`);           // ...but the phone's request had reached the server
        await door.setOfflineMode(false);
        await door.click('#ckResult [data-recheck]');
        await door.waitForFunction(() => /went through/.test((document.querySelector('#ckResult .ck-banner') || {}).innerText || ''), { timeout: 10000 });
        const mine = await door.$eval('#ckResult .ck-banner', el => ({ t: el.innerText, c: el.className }));
        ok(/this phone's check-in went through/.test(mine.t) && /ck-banner--ok/.test(mine.c), '...Check again: green "Admitted - this phone\'s check-in went through", not "Already scanned"', JSON.stringify(mine));
        await shot(door, 'door-8-mine');
        // another phone scanning that same ticket (a copied QR code) still gets the red refusal
        const otherPhone = await newPage(390, 844, true);
        await otherPhone.goto(`${BASE}/checkin?event=${show.id}`, { waitUntil: 'networkidle0' });
        await otherPhone.waitForSelector('#ckManual:not([hidden])', { timeout: 10000 });
        await otherPhone.type('#ckSearch', a2.token);
        await otherPhone.click('#ckSearchForm .ck-btn');
        await otherPhone.waitForSelector('#ckResult .ck-banner', { timeout: 10000 });
        const otherBanner = await otherPhone.$eval('#ckResult .ck-banner', el => ({ t: el.innerText, c: el.className }));
        ok(/^Already scanned at \d{2}:\d{2}$/.test(otherBanner.t) && /ck-banner--bad/.test(otherBanner.c), '...while ANOTHER phone scanning the same ticket still gets a red "Already scanned"', JSON.stringify(otherBanner));
        await otherPhone.close();
        // the decoder: the server's QR for a ticket, read back by the bundled jsQR, gives the token
        const qr = (await pub('GET', `/api/public/ticket-orders/${A.reference}`)).body.order.tickets[1].qr;
        const decoded = await door.evaluate(async (src) => {
            const img = new Image(); img.src = src; await img.decode();
            const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
            const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0);
            const code = window.jsQR(ctx.getImageData(0, 0, c.width, c.height).data, c.width, c.height);
            return code ? code.data : null;
        }, qr);
        ok(!!decoded && new RegExp(`/t/${a2.token}$`).test(decoded), 'the scanner\'s decoder (bundled jsQR) reads a real ticket QR back to that ticket\'s /t/<token> link', decoded);
        ok(door.errs.length === 0, 'no script errors on the scanner page', door.errs.join(' | '));
        await door.close();

        const stranger = await newPage(390, 844, false);
        await stranger.goto(`${BASE}/checkin`, { waitUntil: 'networkidle0' });
        await stranger.waitForSelector('#ckSignin:not([hidden])', { timeout: 10000 });
        ok(/Sign in first/.test(await text(stranger, '#ckSignin')) && await stranger.$eval('#ckCameraBox', el => el.hidden), 'the scanner for someone not signed in: "Sign in first", no camera, no search', '');
        await stranger.close();

        // ═══ the admin portal ═══
        const adm = await newPage(1440, 1000, true);
        await adm.goto(BASE + '/admin.html', { waitUntil: 'networkidle0', timeout: 90000 });
        await adm.waitForFunction(() => typeof window.switchTab === 'function' && !!window.currentUserRole && typeof window.openEvtEditDrawer === 'function', { timeout: 30000 });
        await adm.evaluate(() => window.switchTab('eventsAdmin'));
        await sleep(800);
        await adm.click('#eventsAdmin [data-um-tab="evtPanelTickets"]');
        // the tab opens on the soonest ticketed show - the dev DB copy may hold a real one sooner than ours - so pick ours first
        await adm.waitForFunction((id) => !!document.querySelector(`#tktSalesEvent option[value="${id}"]`), { timeout: 15000 }, show.id);
        await adm.select('#tktSalesEvent', String(show.id));
        await adm.waitForFunction((id) => [...document.querySelectorAll('#tktOrdersBody .tkt-order-row')].length === 2 && document.getElementById('tktSalesEvent').value === String(id), { timeout: 15000 }, show.id);
        await adm.waitForFunction(() => /of\s*30/.test((document.getElementById('tktStatGrid') || {}).innerText || ''), { timeout: 15000 });
        const tiles = await text(adm, '#tktStatGrid');
        const toolbarHidden = await adm.$eval('#eventsAdmin .evt-controls-row', el => getComputedStyle(el).display === 'none');
        ok(/R\s?360[.,]00/.test(tiles.replace(/ | /g, ' ').replace(/(\d) (\d)/g, '$1$2')) && /3\s*of 30/.test(tiles) && /3\s*of 3\b/.test(tiles) && toolbarHidden,
            'Events -> Ticket Sales: revenue R360, 3 of 30 sold, 3 of 3 checked in - and the event search bar is out of the way', tiles);
        await shot(adm, 'admin-1-sales');
        await adm.click('#tktOrdersBody .tkt-order-row');
        await adm.waitForSelector('#tktOrderDrawerBody .tkt-order', { timeout: 10000 });
        const drawer = await text(adm, '#tktOrderDrawerBody');
        ok(/Resend tickets/i.test(drawer) && /Mark as refunded/i.test(drawer) && /POPIA consent/.test(drawer), 'the order drawer: buyer, tickets with check-ins, consent, PayFast notifications, Resend and Mark as refunded', drawer);
        await shot(adm, 'admin-2-order');
        await adm.evaluate(() => window.closeAtlDrawer('tktOrderDrawer'));
        await sleep(400);
        // the event drawer's Tickets tab
        await adm.$eval('#eventsAdmin [data-um-tab="evtPanelUpcoming"]', el => el.click());
        await sleep(600);
        await adm.evaluate((id) => window.openEvtEditDrawer(id), show.id);
        await adm.waitForSelector('#evt-tab-tickets', { visible: true, timeout: 10000 });
        await adm.waitForFunction(() => document.getElementById('evtDrawer').classList.contains('atl-drawer--open'), { timeout: 10000 });
        await sleep(600);                                                     // the slide-in (as test/browser/events-google.js waits)
        await adm.click('#evt-tab-tickets');
        await adm.waitForSelector('#tktEventMount .tkt-tier', { timeout: 10000 });
        const tab = await text(adm, '#tktEventMount');
        ok(/Sales open/.test(tab) && /General/.test(tab) && /3 sold/.test(tab) && /Close sales/i.test(tab) && /View orders/i.test(tab), 'the event drawer\'s Tickets tab: sales open, the tier with 3 sold, Close sales, View orders', tab);
        await shot(adm, 'admin-3-event-tab');
        ok(adm.errs.length === 0, 'no script errors in the admin portal', adm.errs.join(' | '));
        await adm.close();

        // ═══ door links: made in Ticket Sales, opened on a volunteer's phone with no portal account ═══
        const vol = await mk(1962, 'ZZ Volunteer Show');
        const V = await paidOrder(vol.id, vol.tier.id, 1, 'Vusi Volunteer');
        const adm2 = await newPage(1440, 1000, true);
        await adm2.goto(BASE + '/admin.html', { waitUntil: 'networkidle0', timeout: 90000 });
        await adm2.waitForFunction(() => typeof window.switchTab === 'function' && !!window.currentUserRole, { timeout: 30000 });
        await adm2.evaluate(() => window.switchTab('eventsAdmin'));
        await sleep(800);
        await adm2.click('#eventsAdmin [data-um-tab="evtPanelTickets"]');
        await adm2.waitForFunction((id) => !!document.querySelector(`#tktSalesEvent option[value="${id}"]`), { timeout: 15000 }, vol.id);
        await adm2.select('#tktSalesEvent', String(vol.id));
        await adm2.waitForFunction(() => /No door links/.test((document.getElementById('tktDoorPassList') || {}).innerText || ''), { timeout: 15000 });
        await adm2.type('#tktDoorPassLabel', 'Side entrance');
        await adm2.$eval('#tktDoorPassForm button[type=submit]', el => el.click());
        await adm2.waitForSelector('#tktDoorPassUrl', { visible: true, timeout: 10000 });
        const link = await adm2.$eval('#tktDoorPassUrl', el => el.value);
        await adm2.waitForFunction(() => /Side entrance/.test(document.getElementById('tktDoorPassList').innerText), { timeout: 10000 });
        const listText = await text(adm2, '#tktDoorPassList');
        ok(/\/checkin\?pass=[A-Za-z0-9_-]{24}$/.test(link) && await adm2.$eval('.tkt-doorpass-new__qr', el => el.complete && el.naturalWidth > 0) && /Works until/.test(listText) && /0 checked in/.test(listText),
            'Ticket Sales -> Door links: "Create door link" shows the link and its QR code once, and lists it as working with 0 checked in', link + ' / ' + listText);
        await adm2.$eval('#tktDoorPasses', el => el.scrollIntoView());
        await shot(adm2, 'admin-4-door-link');

        // guest list: complimentary tickets through the form, then void & reissue one from the order drawer
        await adm2.waitForFunction(() => document.querySelectorAll('#tktCompTier option').length > 0, { timeout: 10000 });
        await adm2.type('#tktCompName', 'Gugu Guest');
        await adm2.type('#tktCompNote', 'Press - test');
        await adm2.$eval('#tktCompQty', el => { el.value = '2'; });
        await adm2.$eval('#tktCompForm button[type=submit]', el => el.click());
        await adm2.waitForFunction(() => [...document.querySelectorAll('#tktOrdersBody .tkt-order-row')].some(r => /Gugu Guest/.test(r.innerText) && /Complimentary/i.test(r.innerText)), { timeout: 15000 });
        const compTile = await text(adm2, '#tktStatGrid');
        ok(/2 complimentary/.test(compTile), 'Guest list: "Issue complimentary tickets" adds an order marked Complimentary, and the figures say 2 complimentary', compTile);
        await adm2.$eval('#tktComps', el => el.scrollIntoView());
        await shot(adm2, 'admin-5-guest-list');
        await adm2.evaluate(() => [...document.querySelectorAll('#tktOrdersBody .tkt-order-row')].find(r => /Gugu Guest/.test(r.innerText)).click());
        await adm2.waitForSelector('#tktOrderDrawerBody .tkt-reissue', { timeout: 10000 });
        await sleep(600);
        const compDrawer = await text(adm2, '#tktOrderDrawerBody');
        ok(/Complimentary/.test(compDrawer) && /Press - test/.test(compDrawer) && /Cancel these tickets/.test(compDrawer) && !/Mark as refunded/.test(compDrawer),
            'the complimentary order\'s drawer: who / why, "Cancel these tickets" (not "Mark as refunded")', compDrawer);
        await adm2.$eval('#tktOrderDrawerBody .tkt-reissue', el => el.click());
        await adm2.waitForSelector('#tktReissueReason', { visible: true, timeout: 5000 });
        await adm2.type('#tktReissueReason', 'Lost phone');
        await adm2.$eval('#tktReissueName', el => { el.value = ''; });
        await adm2.type('#tktReissueName', 'Gugu Plus One');
        await adm2.$eval('#tktReissueGo', el => el.click());
        await adm2.waitForFunction(() => /voided .* Lost phone/.test((document.getElementById('tktOrderDrawerBody') || {}).innerText || ''), { timeout: 15000 });
        const afterRe = await text(adm2, '#tktOrderDrawerBody');
        ok(/Gugu Plus One/.test(afterRe) && /Void/.test(afterRe) && /reissued/.test(afterRe), 'Void & reissue from the drawer: the old ticket shows Void with why and "reissued", the new one carries the new name', afterRe);
        await shot(adm2, 'admin-6-reissued');
        await adm2.evaluate(() => window.closeAtlDrawer('tktOrderDrawer'));
        await sleep(400);

        const phone = await newPage(390, 844, false);                            // the volunteer: NOT signed in
        await phone.goto(link.replace(/^https?:\/\/[^/]+/, BASE), { waitUntil: 'networkidle0' });
        await phone.waitForSelector('#ckManual:not([hidden])', { timeout: 10000 });
        await waitFor(async () => /checked in/.test(await text(phone, '#ckCount')));
        const head = await phone.evaluate(() => ({ url: location.href, select: document.getElementById('ckEvent').hidden, name: document.getElementById('ckEventName').innerText, label: document.getElementById('ckPassLabel').innerText, ph: document.getElementById('ckSearch').placeholder }));
        ok(!/pass=/.test(head.url) && head.select && /ZZ Volunteer Show/.test(head.name) && /Side entrance/.test(head.label) && /^0 of 3 checked in$/.test(await text(phone, '#ckCount'))   /* 1 bought + 2 guest-list */ && !/e-mail/i.test(head.ph),
            'the door link on a phone with no sign-in: the scanner opens for THAT show (no show picker), names the link, takes the secret out of the address bar, and search offers no e-mail', JSON.stringify(head));
        await shot(phone, 'door-9-link-scanner');
        await phone.type('#ckSearch', 'Vusi');
        await phone.click('#ckSearchForm .ck-btn');
        await phone.waitForSelector('#ckFound [data-checkin]', { timeout: 10000 });
        await phone.click('#ckFound [data-checkin]');
        await phone.waitForSelector('#ckResult .ck-banner', { timeout: 10000 });
        const vr = await text(phone, '#ckResult .ck-banner');
        await waitFor(async () => /^1 of 3/.test(await text(phone, '#ckCount')));
        ok(vr === 'Admitted' && /^1 of 3 checked in$/.test(await text(phone, '#ckCount')) && (await one('SELECT checked_in_via FROM tickets WHERE id = ?', [V.tickets[0].id])).checked_in_via === 'Side entrance',
            'through the door link: find by name -> Check In -> "Admitted", the counter moves, and the check-in is recorded as "Side entrance"', vr);
        await phone.click('#ckNext');
        await phone.$eval('#ckSearch', el => { el.value = ''; });
        await phone.type('#ckSearch', X.tickets[0].token);
        await phone.click('#ckSearchForm .ck-btn');
        await phone.waitForSelector('#ckResult .ck-banner', { timeout: 10000 });
        const vw = await text(phone, '#ckResult');
        ok(/Wrong show - this ticket is for ZZ Other Night/.test(vw) && !/Xolani/.test(vw), 'another show\'s ticket through the door link: "Wrong show" - and not the guest\'s name', vw);

        const pass = (await q('SELECT id FROM ticket_door_passes WHERE event_id = ?', [vol.id]))[0];
        await api('DELETE', `/api/admin/ticketing/events/${vol.id}/door-passes/${pass.id}`);
        await phone.reload({ waitUntil: 'networkidle0' });
        await phone.waitForSelector('#ckSignin:not([hidden])', { timeout: 10000 });
        const offText = await text(phone, '#ckSignin');
        ok(/stopped working/.test(offText) && /new door link/.test(offText) && await phone.$eval('#ckCameraBox', el => el.hidden) && await phone.$eval('#ckSigninLink', el => el.hidden),
            'once the link is switched off, the phone says so ("ask the organiser for a new door link") - no camera, no search', offText);
        await shot(phone, 'door-10-link-off');
        ok(phone.errs.length === 0 && adm2.errs.length === 0, 'no script errors on the door-link pages', phone.errs.concat(adm2.errs).join(' | '));
        await phone.close();
        await adm2.close();
    } catch (e) {
        fails++;
        console.log('FAIL unexpected error: ' + (e && e.stack || e));
    } finally {
        for (const m of made) await api('PUT', `/api/admin/events/${m.id}`, { event_title: m.title, event_datetime: m.when, event_status: 'cancelled', sync_to_gcal: false }).catch(() => {});
        if (browser) await browser.close().catch(() => {});
        await support.stop();
    }
    console.log(fails ? `\n${fails} check(s) FAILED` : '\nAll door / admin ticketing browser checks passed');
    process.exit(fails ? 1 : 0);
})();
