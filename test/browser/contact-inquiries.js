// Contact form -> Inquiries -> reply, driven through the REAL public page and admin.html on an isolated DB copy (test/support.js: mail is mocked,
// the real database and mail server are never touched). Covers: the public form submits and shows the reference, the hidden spam-trap field is
// really hidden, the inquiry (Booking Inquiry keeps its linked booking) appears in the admin list with its source, the conversation panel, the
// reply composer's locked recipient, the honest "queued -> accepted" life of a reply, a failed reply with its reason and "Send again" (managers
// only), the list flag, and no layout overflow at phone width.
//
// Not part of `npm test`: run it with `npm run test:browser` (needs PUPPETEER_EXECUTABLE_PATH on this machine, see test-suite notes).
const sqlite3 = require('sqlite3');
const support = require('../support');
const puppeteer = require('puppeteer');
const { BASE, sleep } = support;
let fails = 0;
const ok = (c, n, detail) => { if (!c) fails++; console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '\n        -> ' + detail)); };
const PASSWORD = 'TestRunnerPass1!';

function sql(statement, params = []) {
    return new Promise((res, rej) => {
        const db = new sqlite3.Database(support.TEST_DB);
        db.run(statement, params, function (e) { const id = this && this.lastID; db.close(() => e ? rej(e) : res(id)); });
    });
}
async function cookieFor(email) {
    const r = await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: PASSWORD }) });
    const sc = r.headers.get('set-cookie');
    if (r.status !== 200 || !sc) throw new Error('login failed for ' + email + ': ' + r.status);
    return sc.split(';')[0];
}
const SHOTS = process.env.CONTACT_SHOTS_DIR || null;     // optional: directory for screenshots
const shot = async (p, name) => { if (SHOTS) { await sleep(300); await p.screenshot({ path: require('path').join(SHOTS, name + '.png') }); } };
const toasts = (p) => p.evaluate(() => Array.from(document.querySelectorAll('.tm-toast__message')).map((t) => t.textContent).join(' | '));
async function waitFor(fn, ms = 30000, step = 300) { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(step); } return null; }

async function openAdmin(browser, cookie, { width = 1440, height = 1000 } = {}) {
    const ctx = await browser.createBrowserContext();
    const p = await ctx.newPage();
    await p.setViewport({ width, height });
    p._errs = [];
    p.on('pageerror', (e) => p._errs.push(e.message.slice(0, 200)));
    const [name, ...rest] = cookie.split('=');
    await p.setCookie({ name, value: rest.join('='), url: BASE });
    await p.setRequestInterception(true);
    p.on('request', (r) => /\/api\/admin\/maps-config/.test(r.url()) ? r.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, key: '' }) }) : r.continue());
    await p.goto(BASE + '/admin.html', { waitUntil: 'networkidle0', timeout: 90000 });
    await p.waitForFunction(() => typeof window.switchTab === 'function' && typeof window.openInquiry === 'function', { timeout: 30000 });
    await p.evaluate(() => window.switchTab('inquiriesAdmin'));
    await waitFor(() => p.$('.inq-row, .inq-empty-state'));
    return p;
}
const openRow = async (p, id) => {
    await p.evaluate(() => window.loadInquiries(true));
    await waitFor(() => p.$(`.inq-row[data-id="${id}"]`));
    await p.evaluate((i) => window.openInquiry(i), id);
    await waitFor(() => p.$('#inqThread'));
    await sleep(500);
};

(async () => {
    await support.start();
    await support.loginAs('manager');
    await support.loginAs('assistant');
    const managerCookie = await cookieFor('test.manager@example.invalid');
    const assistantCookie = await cookieFor('test.assistant@example.invalid');
    const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-quic'] });
    const stamp = Date.now();
    const email = `browser.visitor.${stamp}@example.invalid`;

    // ── 1. the public form ──
    const pub = await (await browser.createBrowserContext()).newPage();
    await pub.setViewport({ width: 1280, height: 900 });
    const pubErrs = []; pub.on('pageerror', (e) => pubErrs.push(e.message.slice(0, 160)));
    await pub.goto(BASE + '/', { waitUntil: 'networkidle2', timeout: 90000 });
    await pub.waitForSelector('#contactForm', { timeout: 30000 });
    const hp = await pub.evaluate(() => {
        const i = document.getElementById('contactHp'); const r = i.getBoundingClientRect();
        return { exists: !!i, offscreen: r.right <= 0 || r.left >= window.innerWidth || r.width <= 1, tab: i.tabIndex, auto: i.autocomplete, ariaHidden: i.closest('[aria-hidden="true"]') !== null };
    });
    ok(hp.exists && hp.offscreen && hp.tab === -1 && hp.auto === 'off' && hp.ariaHidden, 'the spam-trap field exists but is invisible, skipped by Tab, not auto-filled and hidden from screen readers', JSON.stringify(hp));
    await sleep(3200);                                   // a person needs a moment to fill the form: the server drops sub-2.5 s submits
    await pub.type('#contactName', 'Browser Visitor');
    await pub.type('#contactEmail', email);
    await pub.type('#contactCell', '084 323 5075');
    await pub.select('#contactCategory', 'Booking Inquiry');
    await pub.type('#contactSubject', 'Wedding enquiry');
    await pub.type('#contactMessage', 'We would love to book Thabiso for our wedding in June.');
    await pub.$eval('#contactPopia', (e) => e.click());
    await pub.$eval('#contactForm button[type="submit"]', (e) => e.click());
    const toast = await waitFor(async () => { const t = await toasts(pub); return /INQ-\d{6}/.test(t) ? t : null; }, 20000);
    ok(!!toast && /received/i.test(toast), 'submitting shows the success message with the inquiry reference', String(toast));
    const row = await waitFor(() => new Promise((res) => { const db = new sqlite3.Database(support.TEST_DB, sqlite3.OPEN_READONLY); db.get('SELECT * FROM inquiries WHERE LOWER(sender_email) = ?', [email], (e, r) => { db.close(); res(r || null); }); }), 10000);
    ok(!!row && row.category === 'Booking Inquiry' && row.status === 'unread' && !!row.converted_booking_id, 'the inquiry is saved (unread), and a Booking Inquiry is linked to its legacy booking row', JSON.stringify(row));
    ok(toast && toast.includes('INQ-' + String(row.inquiry_id).padStart(6, '0')), 'the reference shown to the visitor is the inquiry\'s own', String(toast));
    const formReset = await pub.evaluate(() => document.getElementById('contactName').value === '' && document.getElementById('contactMessage').value === '');
    ok(formReset, 'the form is cleared after a successful submit', '');
    ok(pubErrs.length === 0, 'no script errors on the public page', pubErrs.join(' | '));
    // a submission the SERVER refuses (the browser does not check the subject length) shows the server's reason, not a generic error
    await sleep(3200);
    await pub.type('#contactName', 'Short Subject');
    await pub.type('#contactEmail', `browser.short.${stamp}@example.invalid`);
    await pub.type('#contactCell', '084 323 5075');
    await pub.select('#contactCategory', 'General Inquiry');
    await pub.type('#contactSubject', 'ab');
    await pub.type('#contactMessage', 'Hello there, this is a perfectly long enough message.');
    await pub.$eval('#contactPopia', (e) => e.click());
    await pub.$eval('#contactForm button[type="submit"]', (e) => e.click());
    const refused = await waitFor(async () => { const t = await toasts(pub); return /subject must be at least 3/i.test(t) ? t : null; }, 15000);
    ok(!!refused, 'when the server refuses a submission the visitor is told why (here: the subject is too short)', String(await toasts(pub)));
    await pub.close();

    // ── 2. admin: the inquiry, its source, the empty conversation ──
    const m = await openAdmin(browser, managerCookie);
    await openRow(m, row.inquiry_id);
    const view = await m.evaluate(() => ({
        chips: document.getElementById('inqReadChips').textContent,
        thread: document.getElementById('inqThread') ? document.getElementById('inqThread').textContent : null,
        converted: document.getElementById('inqConvertedLink') && getComputedStyle(document.getElementById('inqConvertedLink')).display !== 'none' ? document.getElementById('inqConvertedLinkText').textContent : null
    }));
    ok(/Website form/.test(view.chips), 'the inquiry shows where it came from (Website form)', view.chips);
    ok(/No replies yet/.test(view.thread || ''), 'the conversation panel says there are no replies yet', String(view.thread));
    ok(/Alert to/.test(view.thread || '') && /Confirmation to the sender/.test(view.thread || '') && /(Queued|Retrying|Sent)/i.test(view.thread || ''), 'the panel also shows whether the alert to the booking mailbox and the confirmation to the sender were delivered (separate from the inquiry being saved)', String(view.thread));
    ok(/Converted/.test(view.converted || ''), 'a Booking Inquiry shows as converted to its booking (no second booking is offered)', String(view.converted));

    // ── 3. the reply composer: the recipient is the sender and cannot be changed ──
    await m.$eval('#inqReadReplyBtn', (e) => e.click());
    await waitFor(() => m.$('#inqComposeView'));
    await sleep(600);
    const comp = await m.evaluate(() => {
        const inp = document.getElementById('inqComposeToInput'), box = document.getElementById('inqToChipsContainer');
        const rm = box.querySelector('.inq-chip-remove');
        return { disabled: inp.disabled, locked: box.classList.contains('inq-chip-input-container--locked'), chips: Array.from(box.querySelectorAll('.inq-recipient-chip')).map((c) => c.textContent.trim()), removeShown: !!rm && getComputedStyle(rm).display !== 'none', title: document.getElementById('inqComposerTitle').textContent };
    });
    ok(comp.disabled && comp.locked && comp.chips.length === 1 && comp.chips[0] === email && !comp.removeShown && /Reply to Inquiry/.test(comp.title), 'a reply is addressed to the sender only: the To box is locked, the chip cannot be removed', JSON.stringify(comp));

    // ── 4. send -> honest toast -> the conversation shows the reply's real state ──
    await m.evaluate(() => { inqComposeQuill.root.innerHTML = '<p>Hi there, thank you for your message. We would be delighted.</p>'; });
    await m.$eval('#inqComposeSendBtn', (e) => e.click());
    const queuedToast = await waitFor(async () => { const t = await toasts(m); return /queued/i.test(t) ? t : null; }, 15000);
    ok(!!queuedToast && !/sent successfully/i.test(queuedToast), 'sending says the reply was QUEUED - it does not claim it was sent', String(queuedToast));
    await sleep(800);
    await openRow(m, row.inquiry_id);
    const first = await waitFor(() => m.evaluate(() => { const b = document.querySelector('#inqThread .inq-msg--out .inq-delivery'); return b ? b.textContent : null; }), 15000);
    ok(/Queued|Retrying|Sent/i.test(first || ''), 'the reply appears in the conversation with a delivery badge, credited to the manager', JSON.stringify(await m.evaluate(() => ({ cur: currentInqId, thread: (document.getElementById('inqThread') || {}).innerHTML, drawer: document.getElementById('inqDetailDrawer').className, errs: window.__errs }))).slice(0, 700));
    const meta = await m.evaluate(() => document.querySelector('#inqThread .inq-msg--out .inq-msg-meta').textContent);
    ok(/Reply by/.test(meta), 'the reply names who sent it', meta);
    const accepted = await waitFor(() => m.evaluate(() => { const b = document.querySelector('#inqThread .inq-msg--out .inq-delivery'); return b && /accepted by Microsoft 365/i.test(b.textContent) ? b.textContent : null; }), 70000, 1000);
    ok(!!accepted, 'once the outbox has delivered it the badge turns to "Sent (accepted by Microsoft 365)" without reloading the page', String(accepted));
    const statusNow = await waitFor(() => m.evaluate(() => /Replied/i.test(document.getElementById('inqReadStatusBadge').textContent) ? document.getElementById('inqReadStatusBadge').textContent : null), 15000);
    ok(!!statusNow, 'and only then does the inquiry show as Replied', String(statusNow));
    await shot(m, 'inquiry-conversation-accepted');

    // ── 4b. the customer's answer (read from the mailbox) is shown as plain text, never interpreted ──
    await sql(`INSERT INTO inquiry_messages (inquiry_id, direction, source, message_id, from_address, to_addresses, subject, body_text, delivery_status) VALUES (?, 'in', 'mailbox', ?, ?, '[]', 'Re: Wedding enquiry', ?, 'received')`, [row.inquiry_id, `<in-${stamp}@customer.test>`, email, 'Thank you! <img src=x onerror=alert(1)> see you there']);
    await m.$eval('#inqBackBtn', (e) => e.click()); await sleep(600);
    await openRow(m, row.inquiry_id);
    await waitFor(() => m.$('#inqThread .inq-msg--in'));
    const inbound = await m.evaluate(() => { const el = document.querySelector('#inqThread .inq-msg--in'); return el ? { text: el.textContent, img: !!document.querySelector('#inqThread img'), badge: (el.querySelector('.inq-delivery') || {}).textContent } : null; });
    ok(!!inbound && /Reply from/.test(inbound.text) && inbound.text.includes('<img src=x onerror=alert(1)>') && !inbound.img && /Received/.test(inbound.badge), 'a customer\'s answer appears in the conversation as plain text (markup shown literally, nothing executed)', JSON.stringify(inbound));

    // ── 5. a failed reply: the reason, and "Send again" for managers only ──
    const failInq = await sql(`INSERT INTO inquiries (sender_name, sender_email, receiver_email, category, subject, message_body, status) VALUES ('Failed Case', ?, 'bookings@test.invalid', 'General Inquiry', 'Failed case subject', 'A message whose reply failed.', 'unread')`, [`browser.failed.${stamp}@example.invalid`]);
    const failDraft = await sql(`INSERT INTO direct_emails (inquiry_id, to_emails, cc_emails, bcc_emails, subject, body, status) VALUES (?, ?, '[]', '[]', 'Re: Failed case subject', '<p>Reply that failed</p>', 'failed')`, [failInq, JSON.stringify([`browser.failed.${stamp}@example.invalid`])]);
    await sql(`INSERT INTO inquiry_messages (inquiry_id, direction, source, message_id, subject, body_html, direct_email_id, delivery_status, attempts, last_error, sent_by_name) VALUES (?, 'out', 'admin_reply', ?, 'Re: Failed case subject', '<p>Reply that failed</p>', ?, 'failed', 3, '550 5.1.1 The recipient address was not found', 'Test Manager')`, [failInq, `<inq-${failInq}-browser-${stamp}@example.invalid>`, failDraft]);
    await openRow(m, failInq);
    const failedView = await m.evaluate(() => ({
        badge: (document.querySelector('#inqThread .inq-delivery--failed') || {}).textContent || null,
        error: (document.querySelector('#inqThread .inq-msg-error') || {}).textContent || null,
        retry: !!document.querySelector('#inqThread .inq-msg-retry'),
        status: document.getElementById('inqReadStatusBadge').textContent
    }));
    ok(/Failed/i.test(failedView.badge || '') && /recipient address was not found/.test(failedView.error || '') && failedView.retry, 'a failed reply shows "Failed", the server\'s reason and a Send again button', JSON.stringify(failedView));
    ok(!/Replied/i.test(failedView.status), 'and the inquiry with a failed reply is NOT shown as Replied', failedView.status);
    await shot(m, 'inquiry-conversation-failed');
    const flag = await m.evaluate(async (id) => { await window.loadInquiries(true); const r = document.querySelector(`.inq-row[data-id="${id}"] .inq-reply-failed-flag`); return !!r; }, failInq);
    ok(flag, 'the inquiry list flags the inquiry whose last reply failed', '');
    await m.$eval('#inqThread .inq-msg-retry', (e) => e.click());
    const again = await waitFor(async () => { const t = await toasts(m); return /queued again/i.test(t) ? t : null; }, 15000);
    ok(!!again, 'Send again queues the reply again', String(again));
    const afterRetry = await waitFor(() => m.evaluate(() => { const b = document.querySelector('#inqThread .inq-delivery'); return b && !/Failed/i.test(b.textContent) ? b.textContent : null; }), 15000);
    ok(!!afterRetry, 'the badge leaves "Failed" (queued / retrying / sent)', String(afterRetry));
    ok(m._errs.length === 0, 'no script errors in the admin page', m._errs.join(' | '));

    // ── 6. an assistant sees the conversation but has no Send again ──
    await sql(`UPDATE inquiry_messages SET delivery_status = 'failed', last_error = 'again', notification_id = NULL WHERE inquiry_id = ?`, [failInq]);
    const a = await openAdmin(browser, assistantCookie);
    await openRow(a, failInq);
    const asst = await a.evaluate(() => ({ failed: !!document.querySelector('#inqThread .inq-delivery--failed'), retry: !!document.querySelector('#inqThread .inq-msg-retry') }));
    ok(asst.failed && !asst.retry, 'an assistant sees the failed reply but is not offered Send again', JSON.stringify(asst));

    // ── 6b. the Email (SMTP) card's "Customer replies (inbox)" controls (administrator only; mock mode, so the connection check cannot pass) ──
    const adminCookie = await cookieFor('test.runner@example.invalid');
    const ad = await openAdmin(browser, adminCookie);
    await ad.evaluate(() => window.switchTab('emailSetupAdmin'));
    await sleep(400);
    await ad.evaluate(() => window.loadEmailSetup());
    await waitFor(() => ad.evaluate(() => /Off\./.test(document.getElementById('stInboxStatus').textContent)), 15000);
    const inbox = await ad.evaluate(() => {
        const vis = (id) => { const e = document.getElementById(id); return !!e && e.offsetParent !== null; };
        return { block: vis('stInboxBlock'), status: document.getElementById('stInboxStatus').textContent, toggle: document.querySelector('#stInboxToggleBtn span').textContent, runDisabled: document.getElementById('stInboxRunBtn').disabled, test: vis('stInboxTestBtn') };
    });
    ok(inbox.block && /Off\./.test(inbox.status) && inbox.toggle === 'Switch on' && inbox.runDisabled && inbox.test, 'the Email card shows the Customer replies block: Off, "Switch on", "Check for replies now" disabled until it is on', JSON.stringify(inbox));
    await ad.$eval('#stInboxToggleBtn', (e) => e.click());
    const switchRefused = await waitFor(() => ad.evaluate(() => { const t = document.getElementById('stInboxResult').textContent; return /NOT switched on/.test(t) ? t : null; }), 15000);
    ok(!!switchRefused && /Settings/.test(switchRefused) && /mock mode/i.test(switchRefused), 'switching on is refused with the failed check spelled out (here: mock mode) - it is verify-before-enable', String(switchRefused));
    const afterToggle = await ad.evaluate(() => ({ toggle: document.querySelector('#stInboxToggleBtn span').textContent, status: document.getElementById('stInboxStatus').textContent, enabledBtn: !document.getElementById('stInboxToggleBtn').disabled }));
    ok(afterToggle.toggle === 'Switch on' && /Off\./.test(afterToggle.status) && afterToggle.enabledBtn, 'and the controls return to Off, usable again', JSON.stringify(afterToggle));
    await ad.$eval('#stInboxTestBtn', (e) => e.click());
    const tested = await waitFor(() => ad.evaluate(() => { const t = document.getElementById('stInboxResult').textContent; return /✗/.test(t) ? t : null; }), 15000);
    ok(!!tested && /mock mode/i.test(tested), 'Test inbox access reports each step in plain language (a failed step is marked)', String(tested));
    ok(ad._errs.length === 0, 'no script errors on the settings page', ad._errs.join(' | '));
    await ad.close();

    // ── 7. phone width ──
    const ph = await openAdmin(browser, managerCookie, { width: 390, height: 900 });
    await openRow(ph, failInq);
    const over = await ph.evaluate(() => { const d = document.querySelector('#inqDetailDrawer'); return { sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, drawerSw: d.scrollWidth, drawerCw: d.clientWidth }; });
    ok(over.sw <= over.cw + 1 && over.drawerSw <= over.drawerCw + 1, 'at phone width neither the page nor the conversation scrolls sideways', JSON.stringify(over));

    await browser.close();
    await support.stop();
    console.log(fails ? `\n${fails} FAILURE(S)` : '\nALL PASS');
    process.exit(fails ? 1 : 0);
})().catch(async (e) => { console.error('ERR', e.stack || e.message); try { await support.stop(); } catch (_) {} process.exit(2); });
