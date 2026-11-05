// Notification Centre through the REAL admin.html (js/admin/notifications.js) on an isolated DB copy (test/support.js - SMTP mocked, nothing
// real is touched). Covers: the bell badge (red when something critical is unread) and its dropdown; Insight -> Notifications with the three
// views; acknowledge / resolve (note required) moving an item to Resolved; deep links opening the right page and record; the Activity feed;
// Preferences (administrator-only cards hidden for a manager); the live System Integrity panel; a manager not seeing administrator-only
// alerts; phone width (bottom-sheet dropdown, no sideways scroll); and no script errors throughout.
//
// Not part of `npm test`: run it with `npm run test:browser` (needs PUPPETEER_EXECUTABLE_PATH on this machine). NTF_SHOTS=<dir> saves screenshots.
const path = require('path');
const sqlite3 = require('sqlite3');
const support = require('../support');
const puppeteer = require('puppeteer');
const { BASE, sleep } = support;
let fails = 0;
const ok = (c, n, detail) => { if (!c) fails++; console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '\n        -> ' + detail)); };
const SHOTS = process.env.NTF_SHOTS || null;
const MARK = 'NTFUI' + Date.now().toString(36);

function sqlRun(sql, params = []) {
    return new Promise((res, rej) => {
        const db = new sqlite3.Database(support.TEST_DB);
        db.run(sql, params, function (e) { db.close(); e ? rej(e) : res(this); });
    });
}
async function seed(o) {
    const ts = new Date().toISOString();
    const r = await sqlRun(
        `INSERT INTO admin_notifications (dedupe_key, event_type, category, priority, kind, title, body, status, occurrence_count, first_seen_at, last_seen_at, mandatory, link_json, actions_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?)`,
        [`${o.event}|${MARK}-${Math.random()}`, o.event, o.category, o.priority, o.kind, `${MARK} ${o.title}`, o.body || 'Seeded for the browser test.', o.count || 1, ts, ts, o.mandatory ? 1 : 0,
            JSON.stringify(o.link || null), JSON.stringify(o.actions || [])]);
    return r.lastID;
}
async function cookieFor(email, password) {
    const r = await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
    const sc = r.headers.get('set-cookie');
    if (r.status !== 200 || !sc) throw new Error('login failed for ' + email + ': ' + r.status);
    return sc.split(';')[0];
}
async function openAdmin(browser, cookie, { width = 1440, height = 1000 } = {}) {
    const ctx = await browser.createBrowserContext();
    const p = await ctx.newPage();
    await p.setViewport({ width, height });
    p._errs = [];
    p.on('pageerror', e => p._errs.push(e.message.slice(0, 200)));
    p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|Loading the font|API Error|404/.test(m.text())) p._errs.push('console: ' + m.text().slice(0, 200)); });
    const [name, ...rest] = cookie.split('=');
    await p.setCookie({ name, value: rest.join('='), url: BASE });
    await p.setRequestInterception(true);
    p.on('request', r => {
        if (/\/api\/admin\/maps-config/.test(r.url())) return r.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, key: '' }) });
        r.continue();
    });
    await p.goto(BASE + '/admin.html', { waitUntil: 'networkidle0', timeout: 90000 });
    await p.waitForFunction(() => typeof window.switchTab === 'function' && typeof window.ntfRefreshSummary === 'function', { timeout: 30000 });
    return p;
}
const shot = async (p, name) => { if (SHOTS) await p.screenshot({ path: path.join(SHOTS, name + '.png') }); };
const visible = (p, sel) => p.evaluate((s) => { const e = document.querySelector(s); return !!(e && e.offsetParent !== null); }, sel);
const goCentre = async (p, tab) => { await p.evaluate((t) => window.admNav.go('notificationsAdmin', { tab: t }), tab); await sleep(900); };

(async () => {
    await support.start();
    const eftId = await seed({ event: 'finance.eft_proof_submitted', category: 'finance', priority: 'high', kind: 'action', mandatory: true, title: 'EFT awaiting verification - booking #1',
        link: { section: 'financeAdmin', tab: 'finEft', record: { type: 'eft_submission', id: 999999 } }, actions: [{ label: 'Review proof of payment', primary: true }] });
    const critId = await seed({ event: 'finance.payment_amount_mismatch', category: 'finance', priority: 'critical', kind: 'action', mandatory: true, title: 'Payment amount does not match', link: { section: 'financeAdmin', tab: 'finReconciliation' }, count: 3 });
    const attId = await seed({ event: 'compliance.expiring', category: 'compliance', priority: 'high', kind: 'attention', mandatory: true, title: 'B-BBEE certificate expires in 16 day(s)', link: { section: 'businessAdmin' } });
    const sysId = await seed({ event: 'system.client_error', category: 'system', priority: 'medium', kind: 'attention', title: 'Browser error on admin', link: { section: 'securityAdmin', tab: 'secPanelIntegrity' } });
    await sqlRun("INSERT INTO activity_log (occurred_at, event_type, category, severity, actor_type, actor_label, entity_type, entity_id, summary) VALUES (?, 'finance.payment_received', 'finance', 'info', 'gateway', 'PayFast', 'booking', '1', ?)", [new Date().toISOString(), `${MARK} Payment received - booking #1`]);

    const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
    try {
        const admin = await openAdmin(browser, await cookieFor('test.runner@example.invalid', 'TestRunnerPass1!'));

        // ── the bell ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
        await admin.evaluate(() => window.ntfRefreshSummary());
        await sleep(600);
        const badge = await admin.evaluate(() => { const b = document.getElementById('ntfBellBadge'); return { hidden: b.hidden, text: b.textContent, critical: b.classList.contains('ntf-bell__badge--critical') }; });
        ok(!badge.hidden && Number(String(badge.text).replace('+', '')) >= 4, 'the bell shows an unread count', JSON.stringify(badge));
        ok(badge.critical, 'the badge is red because a critical alert is unread', JSON.stringify(badge));
        ok(await admin.evaluate(() => !document.getElementById('ntfNavCount').hidden), 'the sidebar "Notifications" link carries the action-required count', '');
        await admin.click('#ntfBellBtn');
        await sleep(700);
        const menu = await admin.evaluate((m) => {
            const el = document.getElementById('ntfBellMenu');
            const items = Array.from(el.querySelectorAll('.ntf-bell-item')).map(b => b.textContent);
            return { open: el.classList.contains('open'), items, counts: document.getElementById('ntfBellCounts').textContent, inBody: el.parentElement === document.body, mine: items.filter(t => t.includes(m)).length };
        }, MARK);
        ok(menu.open && menu.inBody, 'clicking the bell opens the dropdown (moved to <body> so nothing clips it)', JSON.stringify(menu));
        ok(menu.mine >= 3 && /action required/.test(menu.counts) && /attention/.test(menu.counts), 'the dropdown lists the latest items with action / attention counts', JSON.stringify(menu));
        await shot(admin, 'ntf-01-bell');
        await admin.keyboard.press('Escape');
        await sleep(200);
        ok(await admin.evaluate(() => !document.getElementById('ntfBellMenu').classList.contains('open')), 'Escape closes the dropdown', '');
        await admin.click('#ntfBellBtn'); await sleep(400);
        await admin.evaluate(() => document.querySelector('#ntfBellMenu [data-ntf-go]').click());
        await sleep(1200);
        ok(await visible(admin, '#notificationsAdmin') && await visible(admin, '#ntfPanelAction'), '"Open Notification Centre" lands on Action required', '');

        // ── Action required ─────────────────────────────────────────────────────────────────────────────────────────────────────────
        const actionIds = await admin.evaluate(() => Array.from(document.querySelectorAll('#ntfList-action .ntf-item')).map(e => +e.getAttribute('data-ntf-id')));
        ok(actionIds.includes(eftId) && actionIds.includes(critId) && !actionIds.includes(attId), 'Action required shows the action items, not the attention one', JSON.stringify(actionIds));
        ok(actionIds.indexOf(critId) < actionIds.indexOf(eftId), 'critical is listed before high', JSON.stringify(actionIds));
        const card = await admin.evaluate((id) => { const c = document.querySelector(`.ntf-item[data-ntf-id="${id}"]`); return c ? c.textContent : ''; }, critId);
        ok(/3×/.test(card) && /Mandatory/.test(card), 'a card shows how often it happened and that it is mandatory', card.slice(0, 300));
        await shot(admin, 'ntf-02-action');

        await admin.evaluate((id) => document.querySelector(`.ntf-item[data-ntf-id="${id}"] [data-ntf-act="ack"]`).click(), eftId);
        await sleep(900);
        ok(/Acknowledged/.test(await admin.evaluate((id) => document.querySelector(`.ntf-item[data-ntf-id="${id}"] .ntf-status`).textContent, eftId)), 'Acknowledge marks it acknowledged and keeps it in the list', '');
        await admin.evaluate((id) => document.querySelector(`.ntf-item[data-ntf-id="${id}"] [data-ntf-act="resolve"]`).click(), eftId);
        await sleep(200);
        await admin.evaluate((id) => document.querySelector(`.ntf-item[data-ntf-id="${id}"] [data-ntf-act="resolve-confirm"]`).click(), eftId);
        await sleep(500);
        ok(await admin.evaluate((id) => !!document.querySelector(`.ntf-item[data-ntf-id="${id}"]`), eftId), 'resolving an action item without a note is refused (it stays)', '');
        await admin.$eval(`#ntfNote${eftId}`, (e) => { e.value = 'Checked the bank statement - approved.'; });
        await admin.evaluate((id) => document.querySelector(`.ntf-item[data-ntf-id="${id}"] [data-ntf-act="resolve-confirm"]`).click(), eftId);
        await sleep(1200);
        ok(await admin.evaluate((id) => !document.querySelector(`#ntfList-action .ntf-item[data-ntf-id="${id}"]`), eftId), 'with a note it is resolved and leaves the Open list', '');
        await admin.evaluate(() => document.querySelector('#ntfPanelAction [data-ntf-filter="resolved"]').click());
        await sleep(1000);
        const resolvedCard = await admin.evaluate((id) => { const c = document.querySelector(`.ntf-item[data-ntf-id="${id}"]`); return c ? c.textContent : ''; }, eftId);
        ok(/Resolved/.test(resolvedCard) && /Checked the bank statement/.test(resolvedCard) && /resolved by/.test(resolvedCard), 'the Resolved filter shows it with the note and who resolved it', resolvedCard.slice(0, 300));
        await admin.evaluate(() => document.querySelector('#ntfPanelAction [data-ntf-filter="open"]').click());
        await sleep(800);

        // ── deep link: Open -> the right page and record ─────────────────────────────────────────────────────────────────────────────
        await sqlRun("UPDATE admin_notifications SET status = 'open' WHERE id = ?", [eftId]);
        await admin.evaluate(() => document.querySelector('#ntfPanelAction [data-ntf-filter="all"]').click());
        await sleep(900);
        await admin.evaluate((id) => document.querySelector(`.ntf-item[data-ntf-id="${id}"] [data-ntf-act="open"]`).click(), eftId);
        await sleep(1800);
        const landed = await admin.evaluate(() => ({ finance: !!(document.getElementById('financeAdmin') && document.getElementById('financeAdmin').offsetParent !== null), eftTab: !!document.querySelector('#finEft.active, #finEft[style*="block"]') || (document.getElementById('finEft') && document.getElementById('finEft').offsetParent !== null), drawer: !!document.querySelector('#eftReviewDrawer.atl-drawer--open') }));
        ok(landed.finance && landed.eftTab, '"Review proof of payment" opens Finance -> EFT Payments', JSON.stringify(landed));
        ok(landed.drawer, '...and opens the proof-of-payment review drawer for that record', JSON.stringify(landed));
        await admin.evaluate(() => { if (window.closeAtlDrawer) window.closeAtlDrawer('eftReviewDrawer'); });
        await sleep(300);

        // ── Attention, Activity, Preferences ───────────────────────────────────────────────────────────────────────────────────────
        await goCentre(admin, 'ntfPanelAttention');
        const attIds = await admin.evaluate(() => Array.from(document.querySelectorAll('#ntfList-attention .ntf-item')).map(e => +e.getAttribute('data-ntf-id')));
        ok(attIds.includes(attId) && attIds.includes(sysId) && !attIds.includes(critId), 'Attention shows the expiry and the browser error', JSON.stringify(attIds));
        await shot(admin, 'ntf-03-attention');
        await goCentre(admin, 'ntfPanelActivity');
        const actText = await admin.evaluate(() => document.getElementById('ntfActivityBody').textContent);
        ok(actText.includes(MARK) && /PayFast/.test(actText), 'the Activity feed lists what happened and who started it', actText.slice(0, 300));
        await shot(admin, 'ntf-04-activity');
        await goCentre(admin, 'ntfPanelPrefs');
        await sleep(600);
        const prefs = await admin.evaluate(() => ({ n: document.querySelectorAll('[data-ntf-pref]').length, adminCards: !document.getElementById('ntfAdminSettings').hidden, rules: document.querySelectorAll('#ntfRulesBody tr').length, primary: document.getElementById('ntfSetPrimary').value }));
        ok(prefs.n >= 8 && prefs.adminCards && prefs.rules >= 20, 'Preferences: my category switches + (administrator) recipients and the rules table', JSON.stringify(prefs));
        await shot(admin, 'ntf-05-prefs');

        // ── Expiry dates ──
        await goCentre(admin, 'ntfPanelExpiry');
        await sleep(600);
        await admin.$eval('#ntfExpName', (e) => { e.value = 'Browser test domain'; });
        await admin.$eval('#ntfExpKind', (e) => { e.value = 'domain'; });
        await admin.$eval('#ntfExpDate', (e) => { e.value = new Date(Date.now() + 20 * 86400000).toISOString().slice(0, 10); });
        await admin.evaluate(() => document.getElementById('ntfExpSave').click());
        await sleep(1200);
        const exp = await admin.evaluate(() => document.getElementById('ntfExpiryBody').textContent);
        ok(/B-BBEE certificate/.test(exp) && /Browser test domain/.test(exp) && /day\(s\) left/.test(exp), 'Expiry dates lists the B-BBEE certificate and a newly added item with days left', exp.slice(0, 300));
        await sqlRun("DELETE FROM compliance_items WHERE name = 'Browser test domain'");

        // ── System Integrity ────────────────────────────────────────────────────────────────────────────────────────────────────────
        await admin.evaluate(() => window.admNav.go('securityAdmin', { tab: 'secPanelIntegrity' }));
        await sleep(400);
        await admin.evaluate(() => window.ntfLoadHealth());
        await sleep(1200);
        const health = await admin.evaluate(() => ({ rows: document.querySelectorAll('#ntfHealthPanel tbody tr').length, tiles: document.querySelectorAll('#ntfHealthPanel .ntf-tile').length, fake: /OPERATIONAL|ENFORCED/.test(document.getElementById('secPanelIntegrity').textContent), timer: !!document.getElementById('sessionTimerBadge') }));
        ok(health.rows >= 5 && health.tiles >= 3, 'System Integrity shows the live job table and status tiles', JSON.stringify(health));
        ok(!health.fake && health.timer, 'the hard-coded "OPERATIONAL / ENFORCED" badges are gone; the session timer stays', JSON.stringify(health));
        await shot(admin, 'ntf-06-health');
        ok(admin._errs.length === 0, 'no script errors as an administrator', admin._errs.join(' | '));

        // ── phone ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
        const phone = await openAdmin(browser, await cookieFor('test.runner@example.invalid', 'TestRunnerPass1!'), { width: 390, height: 844 });
        await goCentre(phone, 'ntfPanelAction');
        const noScroll = await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
        ok(noScroll, 'phone: the Notification Centre has no sideways scroll', await phone.evaluate(() => document.documentElement.scrollWidth + ' > ' + window.innerWidth));
        await shot(phone, 'ntf-07-phone-centre');
        await phone.evaluate(() => document.getElementById('ntfBellBtn').click());
        await sleep(700);
        const sheet = await phone.evaluate(() => { const r = document.getElementById('ntfBellMenu').getBoundingClientRect(); return { l: r.left, r: r.right, b: r.bottom, w: window.innerWidth, h: window.innerHeight, open: document.getElementById('ntfBellMenu').classList.contains('open') }; });
        ok(sheet.open && sheet.l >= 0 && sheet.r <= sheet.w && sheet.b <= sheet.h, 'phone: the dropdown is a bottom sheet inside the screen', JSON.stringify(sheet));
        await shot(phone, 'ntf-08-phone-bell');
        ok(phone._errs.length === 0, 'no script errors on a phone', phone._errs.join(' | '));

        // ── manager ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
        await support.loginAs('manager');
        const manager = await openAdmin(browser, await cookieFor('test.manager@example.invalid', 'TestRunnerPass1!'));
        await goCentre(manager, 'ntfPanelAttention');
        const mAtt = await manager.evaluate(() => Array.from(document.querySelectorAll('#ntfList-attention .ntf-item')).map(e => +e.getAttribute('data-ntf-id')));
        ok(mAtt.includes(attId) && !mAtt.includes(sysId), 'a manager sees the compliance alert but not the administrator-only system error', JSON.stringify(mAtt));
        await goCentre(manager, 'ntfPanelPrefs');
        await sleep(500);
        ok(await manager.evaluate(() => document.getElementById('ntfAdminSettings').hidden), 'a manager does not get the recipients / rules cards', '');
        ok(manager._errs.length === 0, 'no script errors as a manager', manager._errs.join(' | '));
    } catch (e) {
        ok(false, 'browser test crashed', e && e.stack);
    } finally {
        await browser.close();
        await sqlRun('DELETE FROM admin_notifications WHERE title LIKE ?', [`${MARK}%`]).catch(() => {});
        await support.stop();
    }
    console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
    process.exit(fails ? 1 : 0);
})();
