// Admin Drawer Kit (css/admin/drawer-kit.css, .atl-drawer--dk) under EVERY Appearance setting the admin supports (js/appearance.js):
//   Finish x Accent = 3 x 4 = 12 combinations, then the 3 Presence settings. For each it opens a converted drawer and measures, in a real browser:
//     readable text (ink, muted, accent, badges), cards distinguishable from the drawer body, visible borders, button contrast, a visible focus ring;
//   and proves the rules in the Appearance brief: an OPEN drawer re-themes the moment the setting changes (no reload), the kit holds NO colour literal,
//   and a converted drawer's markup carries no hardcoded colour.
// Drawers covered: every id listed in CONVERTED below (add each drawer here as it is converted).
// Not part of `npm test`: `npm run test:browser` (needs PUPPETEER_EXECUTABLE_PATH). DRAWER_SHOTS=<dir> saves a screenshot per Finish/Accent.
const fs = require('fs');
const sqlite3 = require('sqlite3');
const path = require('path');
const support = require('../support');
const puppeteer = require('puppeteer');
const { BASE, sleep } = support;
let fails = 0;
const ok = (c, n, detail) => { if (!c) fails++; console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '\n        -> ' + String(detail).slice(0, 600))); };
const SHOTS = process.env.DRAWER_SHOTS || null;
const ROOT = path.join(__dirname, '..', '..');
const CONVERTED = ['bookingInfoDrawer', 'bookingFinancialsDrawer', 'eftReviewDrawer', 'recordPaymentDrawer', 'expenseDrawer', 'manualTxDrawer'];

const FINISH = ['dark', 'light', 'ember'];
const ACCENT = ['gold', 'vetiver', 'cassis', 'cuivre'];
const PRESENCE = ['editorial', 'boutique', 'operations'];

// ── static checks ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
function staticChecks() {
    const css = fs.readFileSync(path.join(ROOT, 'css/admin/drawer-kit.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const hex = css.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
    const fn = (css.match(/\b(?:rgba?|hsla?|hwb|lab|lch|oklch|oklab)\(\s*\d/g) || []);
    ok(hex.length === 0 && fn.length === 0, 'kit CSS: no colour literal (#hex, rgb(), hsl()...): only --atl-* tokens', JSON.stringify({ hex, fn }));
    const vars = [...css.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]);
    const tokens = fs.readFileSync(path.join(ROOT, 'css/core/tokens.css'), 'utf8') + fs.readFileSync(path.join(ROOT, 'css/core/themes.css'), 'utf8');
    const unknown = [...new Set(vars)].filter((v) => !new RegExp(v.replace(/[-]/g, '\\-') + '\\s*:').test(tokens));
    ok(unknown.length === 0, 'kit CSS: every variable it reads is an existing token (no new tokens invented)', JSON.stringify(unknown));
    const decl = [...css.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map((m) => m[1]);
    ok(decl.length === 0, 'kit CSS: declares no variables of its own', JSON.stringify(decl));
    {   // the handlers that fill the converted drawers must not write colours of their own either
        const js = fs.readFileSync(path.join(ROOT, 'js/admin/bookings-pipeline.js'), 'utf8');
        const a = js.indexOf('MODAL 1 — BOOKING INFO'), b = js.indexOf('Generate Invoice CTA');
        const seg = (a > 0 && b > a ? js.slice(a, b) : '').replace(/\/\/[^\n]*/g, '');
        const lit = seg.match(/#[0-9a-fA-F]{3,6}\b(?![\w-])|rgba?\(\s*\d|hsla?\(/g) || [];
        ok(seg.length > 2000 && lit.length === 0, 'bookings-pipeline.js: the Booking Info + Financial Controls handlers write no colour literal', JSON.stringify({ len: seg.length, lit }));
    }
    {   // the money-form handlers (Expense, Manual Transaction) in bookings-finance.js
        const js = fs.readFileSync(path.join(ROOT, 'js/admin/bookings-finance.js'), 'utf8');
        const a = js.indexOf('Open expense modal pre-filled'), b = js.indexOf("Save transaction')") + 40;
        const seg = (a > 0 && b > a ? js.slice(a, b) : '').replace(/\/\/[^\n]*/g, '');
        const lit = seg.match(/#[0-9a-fA-F]{3,6}\b(?![\w-])|rgba?\(\s*\d|hsla?\(|\.css\('color'/g) || [];
        ok(seg.length > 3000 && lit.length === 0 && /dkMessage\('#expenseModalMsg'/.test(seg) && /dkMessage\('#manualTxMsg'/.test(seg), 'bookings-finance.js: the Expense + Manual Transaction handlers set no colour; messages go through dkMessage()', JSON.stringify({ len: seg.length, lit }));
    }
    {   // Deal View (light kit): its own handler file and the panel builders in bookings-pipeline.js
        const dv = fs.readFileSync(path.join(ROOT, 'js/admin/bookings-dealview.js'), 'utf8').replace(/\/\/[^\n]*/g, '');
        const lit = dv.match(/#[0-9a-fA-F]{3,6}\b(?![\w-])|rgba?\(\s*\d|hsla?\(/g) || [];
        ok(dv.length > 20000 && lit.length === 1 && lit[0] === '#fff' && /background:#fff;"><\/iframe>/.test(dv), 'bookings-dealview.js: no colour literal except the contract preview paper (#fff, on purpose)', JSON.stringify({ lit }));
        const pl = fs.readFileSync(path.join(ROOT, 'js/admin/bookings-pipeline.js'), 'utf8');
        const a = pl.indexOf('function buildProgressPanel'), b = pl.indexOf('function buildAdvancingPanel');
        const seg = (a > 0 && b > a ? pl.slice(a, b) : '').replace(/\/\/[^\n]*/g, '');
        const lit2 = seg.match(/#[0-9a-fA-F]{3,6}\b(?![\w-])|rgba?\(\s*\d|hsla?\(/g) || [];
        ok(seg.length > 10000 && lit2.length === 0, 'bookings-pipeline.js: the Deal View panel builders (progress ... files) write no colour literal', JSON.stringify({ len: seg.length, lit2 }));
    }
    {   // the EFT review renderer
        const js = fs.readFileSync(path.join(ROOT, 'js/admin/eft.js'), 'utf8');
        const a = js.indexOf('the review drawer, in the admin drawer kit'), b = js.indexOf('function loadProof');
        const seg = (a > 0 && b > a ? js.slice(a, b) : '').replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
        const lit = seg.match(/#[0-9a-fA-F]{3,6}\b(?![\w-])|rgba?\(\s*\d|hsla?\(|[^-]color\s*:/g) || [];
        ok(seg.length > 2000 && lit.length === 0, 'eft.js: the review renderer writes no colour (no literal, no inline color:)', JSON.stringify({ len: seg.length, lit }));
    }
    const html = fs.readFileSync(path.join(ROOT, 'admin.html'), 'utf8');
    CONVERTED.forEach((id) => {
        const a = html.indexOf('id="' + id + '"');
        const seg = html.slice(a, html.indexOf('id="' + id + '"', a + 10) > 0 ? undefined : undefined).slice(0, 60000);
        // the drawer's own markup: up to the next top-level drawer
        const next = seg.search(/<div id="\w+DrawerBackdrop"/);
        const own = next > 0 ? seg.slice(0, next) : seg.slice(0, 12000);
        const lit = (own.match(/style="[^"]*(#[0-9a-fA-F]{3,8}\b|rgba?\(\s*\d|hsla?\()[^"]*"/g) || []);
        ok(lit.length === 0, `${id}: no hardcoded colour in its markup`, JSON.stringify(lit));
        ok(/atl-drawer--dk/.test(own.slice(0, 200)), `${id}: opted in with .atl-drawer--dk`, own.slice(0, 160));
    });
}

// ── colour maths (computed styles come back as rgb()/rgba()) ──────────────────────────────────────────────────────────────────
const parse = (c) => {
    c = c || '';
    let m = /color\(srgb\s+([^)]+)\)/.exec(c);   // what the browser reports for a colour made with color-mix()
    if (m) { const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r: p[0] * 255, g: p[1] * 255, b: p[2] * 255, a: p[3] == null ? 1 : p[3] }; }
    m = /rgba?\(([^)]+)\)/.exec(c);
    if (!m) return null;
    const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p[3] == null ? 1 : p[3] };
};
const over = (top, bottom) => ({ r: top.r * top.a + bottom.r * (1 - top.a), g: top.g * top.a + bottom.g * (1 - top.a), b: top.b * top.a + bottom.b * (1 - top.a), a: 1 });
const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

// reads, for one open drawer, the resolved colours of the parts that matter
function readDrawer(id, sel) {
    const d = document.getElementById(id);
    const cs = (el, p) => getComputedStyle(el)[p];
    // the colour an element is actually painted on: walk up until a non-transparent background
    const bgOf = (el) => { for (let e = el; e; e = e.parentElement) { const c = cs(e, 'backgroundColor'); if (c && !/rgba\(\s*0,\s*0,\s*0,\s*0\)|transparent/.test(c)) return c; } return cs(document.body, 'backgroundColor'); };
    const q = (s) => (s ? d.querySelector(s) : null);
    const pick = (s) => { const el = q(s); return el ? { color: cs(el, 'color'), bg: bgOf(el), border: cs(el, 'borderTopColor'), borderW: cs(el, 'borderTopWidth'), outline: cs(el, 'outlineStyle'), transform: cs(el, 'textTransform'), opacity: cs(el, 'opacity'), size: cs(el, 'fontSize') } : null; };
    // each drawer may point a role at a specific element (null = that drawer has none)
    const S = Object.assign({ inset: '.dk-inset:not(.dk-inset--flag)', factV: '.dk-fact__v:not([class*="dk-fact__v--"])', factAccent: '.dk-fact__v--accent', factOk: '.dk-fact__v--ok', factWarn: '.dk-fact__v--warn',
        link: '.dk-v a', badge: '.dk-badge', valOk: '.dk-rows .dk-v--ok', valBad: '.dk-rows .dk-v--bad',
        notice: '.dk-notice:not([style*="display: none"])', input: '.dk-field .atl-input', btnPrimary: '.dk-actions .atl-btn--primary', btnDanger: '.dk-actions .atl-btn--danger' }, sel || {});
    const body = q('.atl-drawer__body');
    return {
        body: { bg: cs(body, 'backgroundColor') },
        card: pick('.dk-card, .dk-panel'), cardTitle: pick('.dk-card__title'), cardIcon: pick('.dk-card__icon'), label: pick('.dk-k'), value: pick('.dk-v'),
        link: pick(S.link), fact: pick('.dk-fact'), factK: pick('.dk-fact__k'), factV: pick(S.factV), factAccent: pick(S.factAccent), factOk: pick(S.factOk), factWarn: pick(S.factWarn),
        valOk: pick(S.valOk), valBad: pick(S.valBad), notice: pick(S.notice), input: pick(S.input), fieldLabel: pick('.dk-label'), hint: pick('.dk-hint'), req: pick('.atl-req'), btnPrimary: pick(S.btnPrimary), btnDanger: pick(S.btnDanger),
        badge: pick(S.badge), title: pick('.dk-title'), sub: pick('.dk-sub'), icon: pick('.dk-icon'), close: pick('.atl-drawer__close'),
        inset: pick(S.inset), footerBtn: pick('.atl-drawer__footer .atl-btn'), header: pick('.atl-drawer__header'), footer: pick('.atl-drawer__footer'),
        backdrop: (() => { const b = document.getElementById(id + 'Backdrop'); return b ? cs(b, 'backgroundColor') : null; })(),
        gap: cs(body, 'rowGap'), pad: cs(body, 'paddingTop')
    };
}

function judge(label, r) {
    const bad = [];
    const need = (name, fg, bgc, min) => { const f = parse(fg), b = parse(bgc); if (!f || !b) { bad.push(name + ': unreadable colour ' + fg + ' / ' + bgc); return; } const bb = b.a < 1 ? over(b, { r: 128, g: 128, b: 128, a: 1 }) : b; const ff = f.a < 1 ? over(f, bb) : f; const x = ratio(ff, bb); if (x < min) bad.push(`${name} ${x.toFixed(2)} < ${min}`); };
    // a role a drawer does not have (null) is skipped; one it has is always measured
    const on = (name, el, bgc, min) => { if (el) need(name, el.color, bgc, min); };
    const card = r.card && r.card.bg;
    on('card title on card', r.cardTitle, card, 7);
    on('row value on card', r.value, card, 7);
    on('row label (muted) on card', r.label, card, 4.5);
    on('field label on card', r.fieldLabel, card, 4.5);
    if (r.fieldLabel && (r.fieldLabel.transform !== 'none' || parseFloat(r.fieldLabel.size) < 13)) bad.push('field label is ' + r.fieldLabel.size + ' ' + r.fieldLabel.transform + ' (needs sentence case, 13px+)');
    if (r.input && parseFloat(r.input.opacity) < 1) bad.push('input is dimmed to ' + r.input.opacity);
    on('hint (muted) on card', r.hint, card, 4.5);
    on('required star on card', r.req, card, 4.5);
    on('link (accent) on card', r.link || r.cardIcon, card, 4.5);
    on('card icon (accent) on card', r.cardIcon, card, 3);
    on('inset text on inset', r.inset, r.inset && r.inset.bg, 4.5);
    on('fact label on fact', r.factK, r.fact && r.fact.bg, 4.5);
    on('fact value on fact', r.factV, r.fact && r.fact.bg, 7);
    on('fact accent on fact', r.factAccent, r.fact && r.fact.bg, 4.5);
    on('fact ok (green) on fact', r.factOk, r.fact && r.fact.bg, 4.5);
    on('fact warn (orange) on fact', r.factWarn, r.fact && r.fact.bg, 4.5);
    on('money ok on card', r.valOk, card, 4.5);
    on('money bad on card', r.valBad, card, 4.5);
    if (r.notice) { const nb = parse(r.notice.bg), bb = parse(r.body.bg); if (nb && bb) { const fill = over(nb, bb); need('notice text on its tint', r.notice.color, `rgb(${fill.r},${fill.g},${fill.b})`, 7); } }
    if (r.input) {
        on('input text on input', r.input, r.input.bg, 7);
        const ib = parse(r.input.border), cc = parse(card);
        if (ib && cc) { const x = ratio(over(ib, cc), cc); if (x < 2) bad.push('input border not clearly visible on the card ' + x.toFixed(2)); }   /* a field's edge must reach 2:1 */
    }
    on('primary button text on its fill', r.btnPrimary, r.btnPrimary && r.btnPrimary.bg, 4.5);
    on('danger button text on the card', r.btnDanger, card, 4.5);
    on('title on header', r.title, r.header.bg, 7);
    on('sub on header', r.sub, r.header.bg, 4.5);
    on('close button', r.close, r.header.bg, 4.5);
    on('footer button text', r.footerBtn, r.footer && r.footer.bg, 4.5);   // a drawer may have no footer bar
    // the badge: text on its own tinted fill over the card
    if (r.badge) { const b = parse(r.badge.bg), c = parse(card); if (b && c) { const fill = over(b, c); need('badge text on its fill', r.badge.color, `rgb(${fill.r},${fill.g},${fill.b})`, 4.5); } }
    // cards read as cards: either the surface differs from the drawer body, or the border does, or both
    const body = parse(r.body.bg), cardC = parse(card), brd = parse(r.card.border);
    if (body && cardC && brd) {
        const surface = ratio(cardC, body);
        const borderOnBody = ratio(over(brd, over(cardC, body)), body);
        if (surface < 1.05 && borderOnBody < 1.3) bad.push(`card not distinguishable (surface ${surface.toFixed(2)}, border ${borderOnBody.toFixed(2)})`);
        if (parseFloat(r.card.borderW) < 1) bad.push('card border width ' + r.card.borderW);
    }
    return bad;
}

(async () => {
    staticChecks();
    await support.start();
    await support.loginAs('administrator');
    const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'], executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined });
    try {
        const p = await browser.newPage();
        await p.setViewport({ width: 1440, height: 900 });
        const errs = []; p.on('pageerror', (e) => errs.push(e.message.slice(0, 200)));
        await p.goto(BASE + '/admin.html', { waitUntil: 'networkidle0', timeout: 90000 });
        await p.evaluate(() => { const b = document.getElementById('cookieAcceptAll'); if (b) b.click(); });
        await p.waitForSelector('#adminEmail', { visible: true, timeout: 20000 });
        await p.type('#adminEmail', 'test.administrator@example.invalid');
        await p.type('#adminPassword', 'TestRunnerPass1!');
        await p.evaluate(() => { const f = document.getElementById('adminEmail').form; if (f.requestSubmit) f.requestSubmit(); else f.submit(); });
        await p.waitForFunction(() => document.getElementById('dashboardSection').style.display === 'flex', { timeout: 30000 });
        await p.waitForFunction(() => !document.getElementById('tmPreloader'), { timeout: 15000 }).catch(() => {});

        // a booking to show: the test database is a copy of the real one; make one if it has none
        const has = await p.evaluate(async () => { const r = await fetch('/api/admin/bookings/full', { credentials: 'same-origin' }); const d = await r.json(); return Array.isArray(d) ? d.length : 0; });
        ok(has > 0, 'setup: the test database has a booking to open', String(has));
        await p.evaluate(() => { if (window.loadBookings) return window.loadBookings(); });
        await p.waitForFunction(() => typeof allBookingsCache !== 'undefined' && allBookingsCache.length > 0, { timeout: 30000 }).catch(() => {});
        const bid = await p.evaluate(() => { try { return allBookingsCache[0].id; } catch (e) { return null; } });
        ok(bid != null, 'setup: bookings are loaded in the admin', String(bid));

        // ── the converted drawers: how to open each (the real admin buttons, via the real handlers) and what "loaded" means ─────────
        const DRAWERS = [
            { id: 'bookingInfoDrawer', btn: 'bk-action-info', ready: '#bi-name', sel: { inset: '#bi-message', factV: '#bi-location' } },
            { id: 'bookingFinancialsDrawer', btn: 'bk-action-financials', ready: '#bf-pl-card .dk-rows, #bf-pl-card .dk-empty--bad', sel: { inset: null, factV: '#bf-total', badge: '#bf-pay-status' } },
            { id: 'eftReviewDrawer', call: 'openEftReview', arg: null, ready: '#eftDecision, #eftReviewBody .dk-notice--bad', sel: { inset: null, badge: '.dk-fact .dk-badge' } },
            { id: 'recordPaymentDrawer', btn: 'bk-action-record-payment', ready: '#rpAmountPaid', sel: {} },
            { id: 'expenseDrawer', call: 'openExpenseModal', arg: bid, ready: '#expenseCategory', sel: {} },
            { id: 'manualTxDrawer', btnId: 'logAdjustmentBtn', ready: '#manualTxAmount', sel: {} }
        ];
        let D = DRAWERS[0];
        const tag = () => '[' + D.id.replace('Drawer', '') + '] ';
        const open = async (setting) => {
            await p.evaluate((s) => { if (s) ['theme', 'accent', 'presence'].forEach((a) => { if (s[a]) window.atlAppearance.set(a, s[a]); }); }, setting || null);
            if (D.call) await p.evaluate((fn, arg) => window[fn](arg), D.call, D.arg);
            else if (D.btnId) await p.evaluate((bid2) => { const b = document.createElement('button'); b.id = bid2; b.style.display = 'none'; document.body.appendChild(b); b.click(); b.remove(); }, D.btnId);
            else await p.evaluate((id, cls) => { const b = document.createElement('button'); b.className = cls; b.setAttribute('data-id', id); b.style.display = 'none'; document.body.appendChild(b); b.click(); b.remove(); }, bid, D.btn);
            await p.waitForFunction((id) => document.getElementById(id).classList.contains('atl-drawer--open'), { timeout: 10000 }, D.id);
            await p.waitForFunction((sel) => !!document.querySelector(sel), { timeout: 15000 }, D.ready);
            await sleep(450); // its slide-in
        };
        const close = async () => { await p.evaluate((id) => closeAtlDrawer(id), D.id); await sleep(350); };
        const read = () => p.evaluate(readDrawer, D.id, D.sel);

        // ══ the generic suite: everything every converted drawer must do ═══════════════════════════════════════════════════════
        let allBad = [];
        const suite = async () => {
            // structure, layout (nothing collapsed, crushed or spilling - a squashed card still has perfect contrast), no sideways scroll
            await open({ theme: 'dark', accent: 'gold', presence: 'editorial' });
            const lay = await p.evaluate((id) => {
                const d = document.getElementById(id);
                const facts = d.querySelector('.dk-facts');
                const out = { facts: facts ? Math.round(facts.getBoundingClientRect().height) : null, spill: [], short: [], dupIds: [], cards: d.querySelectorAll('.dk-card, .dk-panel').length, rows: d.querySelectorAll('.dk-row, .dk-field').length };
                d.querySelectorAll('.dk-card:not([hidden]), .dk-panel').forEach((c, i) => {
                    if (c.offsetParent === null) return;                       // a panel the form has hidden on purpose (the mileage / per diem calculators)
                    const cb = c.getBoundingClientRect(), head = c.querySelector('summary, .dk-panel__head').getBoundingClientRect();
                    c.querySelectorAll('.dk-row, .dk-inset, .dk-actions, .dk-field').forEach((k) => { if (k.offsetParent !== null && k.getBoundingClientRect().bottom > cb.bottom + 1) out.spill.push(i + ':' + (k.id || k.className)); });
                    if ((c.tagName !== 'DETAILS' || c.open) && cb.height < head.height + 40) out.short.push(i);
                });
                const ids = [...d.querySelectorAll('[id]')].map((e) => e.id); out.dupIds = ids.filter((x, i) => ids.indexOf(x) !== i);
                const t = d.querySelector('.dk-title'), cs = getComputedStyle(t);
                out.title = { size: cs.fontSize, family: cs.fontFamily.split(',')[0] };
                const chevEl = d.querySelector('.dk-card__chev');
                if (chevEl) { const chev = chevEl.getBoundingClientRect(), card = d.querySelector('.dk-card').getBoundingClientRect(); out.chevRight = Math.round(card.right - chev.right); } else out.chevRight = 16;   // no chevrons in a form drawer
                out.modal = d.getAttribute('aria-modal'); out.labelled = !!document.getElementById(d.getAttribute('aria-labelledby') || '_none');
                const body = d.querySelector('.atl-drawer__body'); out.sideways = body.scrollWidth > body.clientWidth + 1 || d.scrollWidth > d.clientWidth + 1;
                return out;
            }, D.id);
            ok((lay.facts === null || lay.facts >= 60) && lay.spill.length === 0 && lay.short.length === 0, tag() + 'layout: the facts band and every open card keep their full height; nothing spills out of its card', JSON.stringify(lay));
            ok(parseFloat(lay.title.size) >= 20 && /Cormorant/.test(lay.title.family), tag() + 'layout: the title is the 22px serif', JSON.stringify(lay.title));
            ok(lay.chevRight >= 8 && lay.chevRight <= 24, tag() + 'layout: card chevrons sit at the right edge of their header', String(lay.chevRight));
            ok(lay.dupIds.length === 0 && lay.modal === 'true' && lay.labelled && !lay.sideways, tag() + 'accessibility + fit: unique ids, aria-modal, labelled by its title, no sideways scroll', JSON.stringify(lay));
            const toggle = await p.evaluate((id) => { const c = document.querySelector('#' + id + ' details.dk-card'); if (!c) return { focused: true, was: true, now: false, back: true, none: true }; const s = c.querySelector('summary'); s.focus(); const focused = document.activeElement === s; const was = c.open; s.click(); const now = c.open; s.click(); return { focused, was, now, back: c.open }; }, D.id);
            ok(toggle.focused && toggle.was === true && toggle.now === false && toggle.back === true, tag() + 'a card collapses and re-opens from its header (keyboard-focusable)', JSON.stringify(toggle));
            await close();

            // every Finish x Accent
            for (const f of FINISH) for (const a of ACCENT) {
                const label = `${f}/${a}`;
                await open({ theme: f, accent: a, presence: 'editorial' });
                const r = await read();
                const bad = judge(label, r);
                ok(bad.length === 0, tag() + `${label}: readable text, visible cards/borders, button + badge contrast`, bad.join(' | '));
                if (bad.length) allBad = allBad.concat(bad.map((x) => tag() + label + ' ' + x));
                const focus = await p.evaluate((id) => { const s = document.querySelector('#' + id + ' .dk-card > summary') || document.querySelector('#' + id + ' .dk-field .atl-input'); s.focus(); const cs = getComputedStyle(s); return { style: cs.outlineStyle, w: cs.outlineWidth, color: cs.outlineColor, shadow: cs.boxShadow, border: cs.borderTopColor }; }, D.id);
                ok((focus.style !== 'none' && parseFloat(focus.w) >= 2 && !/rgba\(0, 0, 0, 0\)/.test(focus.color)) || (focus.shadow && focus.shadow !== 'none'), tag() + `${label}: keyboard focus is visible (outline on a card header, ring on a field)`, JSON.stringify(focus));
                if (SHOTS && (a === 'gold' || f === 'light')) await p.screenshot({ path: path.join(SHOTS, `${D.id}-${f}-${a}.png`) });
                await close();
            }

            // Presence: spacing follows it, colours do not break
            const gaps = {};
            for (const pr of PRESENCE) {
                await open({ theme: 'dark', accent: 'gold', presence: pr });
                const r = await read();
                gaps[pr] = r.pad;
                const bad = judge('presence/' + pr, r);
                ok(bad.length === 0, tag() + `presence ${pr}: still readable (body padding ${r.pad})`, bad.join(' | '));
                await close();
            }
            ok(parseFloat(gaps.boutique) > parseFloat(gaps.editorial) && parseFloat(gaps.editorial) > parseFloat(gaps.operations), tag() + 'Presence changes the drawer spacing (boutique > editorial > operations)', JSON.stringify(gaps));

            // an OPEN drawer re-themes live, with no reload
            await open({ theme: 'dark', accent: 'gold', presence: 'editorial' });
            await p.evaluate(() => { window.__noReload = 1; });
            const s1 = await read();
            await p.evaluate(() => window.atlAppearance.set('theme', 'light'));
            await sleep(450); // the admin's own colour transition
            const s2 = await read();
            ok(s1.card.bg !== s2.card.bg && s1.body.bg !== s2.body.bg && s1.cardTitle.color !== s2.cardTitle.color, tag() + 'Finish dark -> light: the OPEN drawer card, body and text colours all change', JSON.stringify({ a: s1.card.bg, b: s2.card.bg }));
            await p.evaluate(() => window.atlAppearance.set('accent', 'cassis'));
            await sleep(450);
            const s3 = await read();
            ok(s2.cardIcon.color !== s3.cardIcon.color && s2.icon.border !== s3.icon.border, tag() + 'Accent gold -> cassis: icons and the header tile change with it', JSON.stringify({ a: s2.cardIcon.color, b: s3.cardIcon.color }));
            await p.evaluate(() => window.atlAppearance.set('presence', 'boutique'));
            await sleep(200);
            const s4 = await read();
            ok(parseFloat(s4.pad) > parseFloat(s3.pad), tag() + 'Presence editorial -> boutique: the open drawer spacing changes', JSON.stringify({ a: s3.pad, b: s4.pad }));
            ok(await p.evaluate((id) => window.__noReload === 1 && document.getElementById(id).classList.contains('atl-drawer--open'), D.id), tag() + 'all of that happened with no page reload, drawer still open', '');
            ok(s1.backdrop !== s2.backdrop, tag() + 'the backdrop follows the Finish too (no hardcoded black)', JSON.stringify([s1.backdrop, s2.backdrop]));
            await close();
            await open();
            const s5 = await read();
            ok(s5.cardIcon.color === s3.cardIcon.color && s5.card.bg === s3.card.bg, tag() + 'a drawer opened after the change uses the selected look at once', JSON.stringify({ a: s5.card.bg, b: s3.card.bg }));
            await close();
            await p.evaluate(() => { ['theme', 'accent', 'presence'].forEach((a) => window.atlAppearance.set(a, { theme: 'dark', accent: 'gold', presence: 'editorial' }[a])); });

            // phone width
            await p.setViewport({ width: 390, height: 844 });
            await open({ theme: 'dark', accent: 'gold', presence: 'editorial' });
            const ph = await p.evaluate((id) => { const d = document.getElementById(id); const r = d.getBoundingClientRect(); const f = d.querySelector('.dk-facts') || d.querySelector('.dk-form'); const b = d.querySelector('.atl-drawer__body'); return { w: Math.round(r.width), vw: innerWidth, cols: getComputedStyle(f).gridTemplateColumns.split(' ').length, over: b.scrollWidth <= b.clientWidth + 1, closeW: Math.round(d.querySelector('.atl-drawer__close').getBoundingClientRect().width) }; }, D.id);
            ok(ph.w === ph.vw && ph.over && ph.cols === 1 && ph.closeW >= 40, tag() + 'phone (390px): full-width, single-column facts, no sideways scroll, a 40px+ close button', JSON.stringify(ph));
            if (SHOTS) await p.screenshot({ path: path.join(SHOTS, `${D.id}-phone.png`) });
            await close();
            await p.setViewport({ width: 1440, height: 900 });
        };

        // ══ Booking Info: specifics ═══════════════════════════════════════════════════════════════════════════════════════════
        D = DRAWERS[0];
        await open({ theme: 'dark', accent: 'gold', presence: 'editorial' });
        const shape = await p.evaluate(() => {
            const d = document.getElementById('bookingInfoDrawer');
            const t = (id) => (document.getElementById(id) || {}).textContent;
            return { title: t('bi-modal-title'), name: t('bi-name'), date: t('bi-date'), cards: d.querySelectorAll('details.dk-card').length,
                facts: d.querySelectorAll('.dk-fact').length, rows: d.querySelectorAll('.dk-row').length, empties: [...d.querySelectorAll('[id^="bi-"]')].filter((e) => !e.children.length && !(e.textContent || '').trim() && !/start-time|venue-notes|email/.test(e.id)).map((e) => e.id) };
        });
        ok(/^Booking #\d+/.test(shape.title) && shape.name && shape.date, tag() + 'the drawer is filled from the booking (title, name, date)', JSON.stringify(shape));
        ok(shape.facts === 4 && shape.rows >= 12 && shape.cards >= 4 && shape.empties.length === 0, tag() + 'summary facts + label/value rows + cards are all there, nothing left empty', JSON.stringify(shape));
        await close();
        await suite();

        await p.evaluate((id) => { const b = allBookingsCache.find((x) => x.id == id); b.venue_notes = 'Load-in via the side door'; b.venue_negotiated_rates = 'R500 off'; }, bid);
        await open({ theme: 'light', accent: 'gold', presence: 'editorial' });
        const vn = await p.evaluate(() => { const c = document.getElementById('bi-venue-card'); const i = document.getElementById('bi-venue-notes'); return { hidden: c.hidden, text: i.textContent, color: getComputedStyle(i.querySelector('.dk-inset__line')).color, bg: getComputedStyle(i).backgroundColor }; });
        ok(vn.hidden === false && /Load-in/.test(vn.text) && /Negotiated rates/.test(vn.text), tag() + 'venue notes: the card shows when the booking has notes', JSON.stringify(vn));
        const vbad = (() => { const f = parse(vn.color), b = parse(vn.bg); if (!f || !b) return 'unparsed'; const x = ratio(f, over(b, { r: 255, g: 253, b: 248, a: 1 })); return x >= 4.5 ? '' : 'contrast ' + x.toFixed(2); })();
        ok(vbad === '', tag() + 'venue notes: readable in the Ivory Finish (it was a fixed #aaa before)', vbad);
        if (SHOTS) await p.screenshot({ path: path.join(SHOTS, 'bookingInfoDrawer-light-gold-notes.png') });
        await close();
        await p.evaluate((id) => { const b = allBookingsCache.find((x) => x.id == id); b.venue_notes = ''; b.venue_negotiated_rates = ''; b.green_room_notes = ''; }, bid);
        await open();
        ok(await p.evaluate(() => document.getElementById('bi-venue-card').hidden === true), tag() + 'venue notes: the card hides again when there are none', '');
        await close();

        // ══ Financial Controls: specifics ═════════════════════════════════════════════════════════════════════════════════════
        D = DRAWERS[1];
        const statuses = [['PAID', 'ok'], ['PARTIALLY_PAID', 'warn'], ['DEPOSIT_PAID', 'info'], ['UNPAID', 'bad'], ['FAILED', 'bad']];
        const origStatus = await p.evaluate((id) => allBookingsCache.find((x) => x.id == id).payment_status, bid);
        for (const [st, variant] of statuses) {
            await p.evaluate((id, s) => { allBookingsCache.find((x) => x.id == id).payment_status = s; }, bid, st);
            await open({ theme: 'dark', accent: 'gold', presence: 'editorial' });
            const b = await p.evaluate(() => { const e = document.getElementById('bf-pay-status'); return { text: e.textContent, cls: e.className }; });
            ok(b.cls === 'dk-badge dk-badge--' + variant && !/_/.test(b.text) && b.text.charAt(0) === b.text.charAt(0).toUpperCase(), tag() + `status ${st}: badge "${b.text}" uses the ${variant} variant (no raw colour, readable words)`, JSON.stringify(b));
            await close();
        }
        await p.evaluate((id, s) => { allBookingsCache.find((x) => x.id == id).payment_status = s; }, bid, origStatus);
        await open({ theme: 'dark', accent: 'gold', presence: 'editorial' });
        const fin = await p.evaluate(() => {
            const t = (id) => (document.getElementById(id) || {}).textContent;
            return { title: t('bf-modal-title'), total: t('bf-total'), paid: t('bf-paid'), due: t('bf-outstanding'), last: t('bf-last-payment'),
                labels: [...document.querySelectorAll('#bf-pl-card .dk-k')].map((e) => e.textContent), docs: (document.getElementById('bf-doc-links') || {}).textContent.trim().slice(0, 60),
                btns: ['bf-btn-quote', 'bf-btn-invoice', 'bf-btn-expense'].map((id) => !!document.getElementById(id)), facts: document.querySelectorAll('#bookingFinancialsDrawer .dk-fact').length,
                loadingLeft: document.querySelectorAll('#bookingFinancialsDrawer .fa-spin').length };
        });
        ok(/^Booking #\d+/.test(fin.title) && fin.total && /^R |Not yet|-/.test(fin.paid + fin.total) && fin.facts === 3, tag() + 'the three amounts and the title are filled', JSON.stringify(fin));
        ok(fin.labels.includes('Revenue') && fin.labels.includes('Expenses') && fin.labels[fin.labels.length - 1] === 'Net profit', tag() + 'profit & loss rows: Revenue, Expenses, ... Net profit last', JSON.stringify(fin.labels));
        ok(fin.btns.every(Boolean) && fin.loadingLeft === 0 && fin.last.length > 0, tag() + 'the action buttons exist, nothing is stuck loading, last-payment line is filled', JSON.stringify(fin));
        // an expense with markup in it is shown as text, never run
        await close();
        const evil = '<img src=x onerror="window.__finXss=1">';
        await p.evaluate(async (id, txt) => { await fetch('/api/admin/expenses', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ booking_id: id, category: 'misc', description: txt, amount: 12.5, expense_date: '2026-11-05' }) }); }, bid, evil);
        await open({ theme: 'dark', accent: 'gold', presence: 'editorial' });
        const xss = await p.evaluate(() => ({ fired: window.__finXss === 1, imgs: document.querySelectorAll('#bf-pl-card img').length, subs: document.querySelectorAll('#bf-pl-card .dk-row--sub').length, text: ((document.querySelector('#bf-pl-card .dk-row--sub .dk-k') || {}).textContent || '').slice(0, 40) }));
        ok(!xss.fired && xss.imgs === 0 && xss.subs >= 1, tag() + 'an expense containing markup is shown as plain text, never run', JSON.stringify(xss));
        if (SHOTS) await p.screenshot({ path: path.join(SHOTS, 'bookingFinancialsDrawer-dark-gold-expense.png') });
        await close();
        // ══ EFT Review: specifics ═════════════════════════════════════════════════════════════════════════════════════════════
        // Proofs of payment are inserted straight into the isolated test database (the public upload flow is covered by test/browser/eft.js).
        const rw = new sqlite3.Database(support.TEST_DB);
        const run = (sql, params) => new Promise((resolve, reject) => rw.run(sql, params, function (e) { return e ? reject(e) : resolve(this.lastID); }));
        const stamp = Date.now().toString(36);
        const mk = (status, claimed, extra) => run(`INSERT INTO eft_payment_submissions (booking_id, claimed_amount, claimed_date, claimed_reference, client_note, proof_filename, proof_original_name, proof_mime, proof_size, proof_sha256, status, verified_amount, verified_reference, verified_date, review_note, reviewed_at)
            VALUES (?, ?, '2026-11-04', ?, ?, ?, 'proof.png', 'image/png', 2048, ?, ?, ?, ?, ?, ?, ?)`,
            [bid, claimed, 'REF-' + stamp, 'Paid by EFT this morning', 'missing-' + stamp + status + '.png', 'sha-' + stamp + status, status,
                extra ? extra.va : null, extra ? extra.vr : null, extra ? extra.vd : null, extra ? extra.note : null, extra ? '2026-11-05 09:00:00' : null]);
        const pendingId = await mk('pending', 99999.5);          // more than the booking owes: triggers the "more than it owes" notice
        const approvedId = await mk('approved', 2500, { va: 2500, vr: 'BANK-REF-1', vd: '2026-11-04', note: 'Matched on the statement' });
        const rejectedId = await mk('rejected', 1000, { va: null, vr: null, vd: null, note: 'No such deposit on our statement' });
        D = DRAWERS[2];
        D.arg = pendingId;
        await open({ theme: 'dark', accent: 'gold', presence: 'editorial' });
        await p.waitForFunction(() => !/Loading the file/.test((document.getElementById('eftProofPreview') || {}).textContent || ''), { timeout: 10000 }).catch(() => {});   // the proof request has answered
        const eft = await p.evaluate(() => {
            const d = document.getElementById('eftReviewDrawer');
            const t = (s) => (d.querySelector(s) || {}).textContent;
            const labelled = [...d.querySelectorAll('.dk-field input:not([type=checkbox]), .dk-field textarea')].map((i) => !!d.querySelector('label[for="' + i.id + '"]'));
            return {
                facts: [...d.querySelectorAll('.dk-fact__v')].map((e) => e.textContent.trim()), notices: [...d.querySelectorAll('.dk-notice')].map((e) => e.textContent.trim().slice(0, 60)),
                cards: [...d.querySelectorAll('.dk-card__title')].map((e) => e.textContent), open: [...d.querySelectorAll('details.dk-card')].map((c) => c.open),
                amount: (d.querySelector('#eftVerAmount') || {}).value, btns: ['eftApproveBtn', 'eftAskBtn', 'eftRejectBtn'].map((id) => !!d.querySelector('#' + id)),
                reasonHidden: getComputedStyle(d.querySelector('#eftReasonBox')).display === 'none', msgHidden: getComputedStyle(d.querySelector('#eftReviewMsg')).display === 'none',
                labelled, proof: (d.querySelector('#eftProofPreview') || {}).textContent.trim().slice(0, 40)
            };
        });
        ok(/^R 99,999\.50$/.test(eft.facts[0]) && /^R [\d,]+\.\d\d$/.test(eft.facts[1]) && /Waiting for review/.test(eft.facts[2]), tag() + 'the three facts: what they claim, what is owed (grouped thousands), the status in words', JSON.stringify(eft.facts));
        ok(eft.notices.some((n) => /more than the booking still owes/.test(n)), tag() + 'a claim above the balance shows a warning notice before the decision', JSON.stringify(eft.notices));
        ok(JSON.stringify(eft.cards.slice(0, 4)) === JSON.stringify(['Proof of payment', 'What the client says', 'Check it against the bank statement', 'Booking']) && eft.cards[4] === 'History' && eft.open[4] === false && eft.open.slice(0, 4).every(Boolean),
            tag() + 'cards run proof -> claim -> decision -> booking, with History folded away', JSON.stringify({ cards: eft.cards, open: eft.open }));
        ok(eft.amount === '99999.50' && eft.btns.every(Boolean) && eft.reasonHidden && eft.msgHidden && eft.labelled.length === 5 && eft.labelled.every(Boolean), tag() + 'the form: amount prefilled, three actions, reason box + error hidden, every field has a label', JSON.stringify(eft));
        ok(/file could not be loaded/i.test(eft.proof), tag() + 'a missing proof file says so plainly (no broken image)', eft.proof);
        // Reject opens the reason box, Cancel closes it, and nothing is sent
        const reason = await p.evaluate(async () => { const d = document.getElementById('eftReviewDrawer'); d.querySelector('#eftRejectBtn').click(); const shown = getComputedStyle(d.querySelector('#eftReasonBox')).display !== 'none'; const focused = document.activeElement && document.activeElement.id === 'eftReasonText'; const label = d.querySelector('#eftReasonLabel').textContent; d.querySelector('#eftReasonCancel').click(); return { shown, focused, label, hidden: getComputedStyle(d.querySelector('#eftReasonBox')).display === 'none' }; });
        ok(reason.shown && reason.focused && /rejected/.test(reason.label) && reason.hidden, tag() + 'Reject opens the reason box with the cursor in it; Cancel closes it', JSON.stringify(reason));
        // an invalid amount is refused by the server and shown in the drawer's own error notice, with nothing recorded
        await p.evaluate(() => { document.getElementById('eftVerAmount').value = 'abc'; document.getElementById('eftApproveBtn').click(); });
        await p.waitForFunction(() => getComputedStyle(document.getElementById('eftReviewMsg')).display !== 'none' && document.getElementById('eftReviewMsg').textContent.length > 5, { timeout: 10000 }).catch(() => {});
        const err = await p.evaluate(() => ({ msg: document.getElementById('eftReviewMsg').textContent.slice(0, 80), role: document.getElementById('eftReviewMsg').getAttribute('role'), btn: !document.getElementById('eftApproveBtn').disabled }));
        const paid = (await support.q('SELECT status, transaction_id FROM eft_payment_submissions WHERE id = ?', [pendingId]))[0];
        ok(err.msg.length > 5 && err.role === 'alert' && err.btn && paid.status === 'pending' && !paid.transaction_id, tag() + 'a bad amount shows an error in the drawer (role=alert), the button comes back, nothing is recorded', JSON.stringify({ err, paid }));
        if (SHOTS) await p.screenshot({ path: path.join(SHOTS, 'eftReviewDrawer-dark-gold-pending.png') });
        await close();
        // approved / rejected: a read-only decision, no form
        for (const [id, status, words] of [[approvedId, 'approved', /Verified amount[\s\S]*R 2,500\.00[\s\S]*BANK-REF-1/], [rejectedId, 'rejected', /No such deposit/]]) {
            D.arg = id;
            await open({ theme: 'light', accent: 'gold', presence: 'editorial' });
            const ro = await p.evaluate(() => { const d = document.getElementById('eftReviewDrawer'); const dec = d.querySelector('#eftDecision'); return { text: dec.textContent.replace(/\s+/g, ' '), form: !!d.querySelector('#eftApproveBtn, #eftVerAmount'), badge: (dec.querySelector('.dk-badge') || {}).className }; });
            ok(!ro.form && words.test(ro.text) && /dk-badge--(ok|bad)/.test(ro.badge), tag() + `${status}: a read-only decision (no form), with what was decided and the note`, JSON.stringify(ro));
            if (SHOTS && status === 'approved') await p.screenshot({ path: path.join(SHOTS, 'eftReviewDrawer-light-gold-approved.png') });
            await close();
        }
        D.arg = pendingId;
        await suite();
        await new Promise((resolve) => rw.close(() => resolve()));
        // ══ the three money forms: specifics ══════════════════════════════════════════════════════════════════════════════════
        const stampF = Date.now().toString(36);
        const toastText = () => p.evaluate(() => [...document.querySelectorAll('.tm-toast')].map((t) => t.textContent.replace(/\s+/g, ' ')).join(' | '));
        const msgOf = (id) => p.evaluate((i) => { const e = document.getElementById(i); return { cls: e.className, role: e.getAttribute('role'), text: e.textContent.trim(), shown: e.offsetParent !== null }; }, id);
        const labelled = (id) => p.evaluate((i) => [...document.querySelectorAll('#' + i + ' .dk-field input:not([type=checkbox]):not([type=hidden]), #' + i + ' .dk-field select, #' + i + ' .dk-field textarea')].map((e) => !!document.querySelector('label[for="' + e.id + '"]')), id);

        // Record Payment
        D = DRAWERS[3];
        await open({ theme: 'dark', accent: 'gold', presence: 'editorial' });
        const rp = await p.evaluate(() => ({ label: document.getElementById('rpBookingLabel').textContent, opts: [...document.querySelectorAll('#rpPaymentStatus option')].map((o) => o.textContent), accept: document.getElementById('rpProofOfPayment').accept, stars: document.querySelectorAll('#recordPaymentDrawer .atl-req').length, panels: [...document.querySelectorAll('#recordPaymentDrawer .dk-panel .dk-card__title')].map((e) => e.textContent) }));
        ok(/^Booking #\d+/.test(rp.label) && rp.opts.length === 3 && !/[^\x00-\x7F]/.test(rp.opts.join('')) && /\.pdf/.test(rp.accept) && rp.stars === 2 && rp.panels.join('|') === 'Payment|Proof of payment', tag() + 'filled from the booking; plain-word status options (no emoji); proof is required (2 stars); two titled panels', JSON.stringify(rp));
        ok((await labelled('recordPaymentDrawer')).every(Boolean), tag() + 'every field has a label', JSON.stringify(await labelled('recordPaymentDrawer')));
        await p.evaluate(() => { window.__mpCalls = 0; const of = window.fetch; window.fetch = function (u) { if (/manual-payment/.test(String(u))) window.__mpCalls++; return of.apply(this, arguments); }; document.getElementById('rpAmountPaid').value = '100'; document.getElementById('rpSaveBtn').click(); });
        await p.waitForFunction(() => [...document.querySelectorAll('.tm-toast')].some((t) => /proof of payment/i.test(t.textContent)), { timeout: 8000 }).catch(() => {});
        const rp2 = await p.evaluate(() => ({ calls: window.__mpCalls, btn: document.getElementById('rpSaveBtn').disabled }));
        ok(/proof of payment/i.test(await toastText()) && rp2.calls === 0 && rp2.btn === false, tag() + 'saving without a proof is refused with a clear message and nothing is sent', JSON.stringify({ rp2, toast: (await toastText()).slice(0, 120) }));
        await close();

        // Expense
        D = DRAWERS[4];
        await open({ theme: 'dark', accent: 'gold', presence: 'editorial' });
        const vis = (id) => p.evaluate((i) => getComputedStyle(document.getElementById(i)).display !== 'none', id);
        const calc = {};
        for (const cat of ['mileage', 'per_diem', 'misc']) { await p.select('#expenseCategory', cat); await sleep(150); calc[cat] = [await vis('expMileageBlock'), await vis('expPerDiemBlock')]; }
        ok(JSON.stringify(calc) === JSON.stringify({ mileage: [true, false], per_diem: [false, true], misc: [false, false] }), tag() + 'the mileage / per diem calculators appear only for their category', JSON.stringify(calc));
        await p.select('#expenseCategory', 'mileage'); await sleep(150);
        const look = await p.evaluate(() => { const cs = (e, k) => getComputedStyle(e)[k]; const d = document.getElementById('expenseDate'), t = document.getElementById('expTotalKm'), n = document.getElementById('expStartOdo'), u = document.querySelector('label[for="expenseReceiptFile"]');
            return { dateOpacity: cs(d, 'opacity'), dateReadonly: d.readOnly, totalOpacity: cs(t, 'opacity'), totalBg: cs(t, 'backgroundColor'), normalBg: cs(n, 'backgroundColor'), totalColor: cs(t, 'color'), uploadTransform: cs(u, 'textTransform'), uploadSize: cs(u, 'fontSize') }; });
        ok(look.dateOpacity === '1' && look.totalOpacity === '1' && look.totalBg !== look.normalBg && look.uploadTransform === 'none' && parseFloat(look.uploadSize) >= 13,
            tag() + 'a date picker is fully opaque (not dimmed like a disabled field), the computed Total km looks read-only, the Upload button is not forced into capitals', JSON.stringify(look));
        await p.select('#expenseCategory', '');
        await p.evaluate(() => document.getElementById('expenseSaveBtn').click());
        let em = await msgOf('expenseModalMsg');
        ok(/dk-notice--bad/.test(em.cls) && em.role === 'alert' && /select a category/i.test(em.text) && em.shown, tag() + 'a missing category shows an error notice (role=alert) in the drawer', JSON.stringify(em));
        await p.select('#expenseCategory', 'misc');
        await p.evaluate(() => { document.getElementById('expenseAmount').value = '0'; document.getElementById('expenseSaveBtn').click(); });
        em = await msgOf('expenseModalMsg');
        ok(/dk-notice--bad/.test(em.cls) && /valid amount/i.test(em.text), tag() + 'a zero amount is refused with the amount message', JSON.stringify(em));
        const expDesc = `ExpDK ${stampF} <b>Tom's</b> & co`;
        await p.evaluate((d2) => { document.getElementById('expenseAmount').value = '12.34'; document.getElementById('expenseDescription').value = d2; document.getElementById('expenseSaveBtn').click(); }, expDesc);
        await p.waitForFunction(() => /dk-notice--ok/.test(document.getElementById('expenseModalMsg').className), { timeout: 10000 }).catch(() => {});
        em = await msgOf('expenseModalMsg');
        ok(/dk-notice--ok/.test(em.cls) && /Expense saved/.test(em.text), tag() + 'a valid expense saves and says so in a success notice', JSON.stringify(em));
        await p.waitForFunction(() => !document.getElementById('expenseDrawer').classList.contains('atl-drawer--open'), { timeout: 10000 }).catch(() => {});
        const exp = (await support.q("SELECT id, amount, description FROM expenses WHERE description LIKE ?", ['%ExpDK ' + stampF + '%']))[0];
        ok(exp && Math.abs(exp.amount - 12.34) < 0.001, tag() + 'the drawer closed itself and the expense is in the books', JSON.stringify(exp));
        if (exp) {
            await p.evaluate((id) => window.editExpense(id), exp.id);
            await p.waitForFunction(() => document.getElementById('expenseDrawer').classList.contains('atl-drawer--open'), { timeout: 10000 });
            await sleep(450);
            const ed = await p.evaluate(() => ({ title: document.getElementById('expenseDrawerLabel').textContent, amount: document.getElementById('expenseAmount').value, desc: document.getElementById('expenseDescription').value }));
            ok(ed.title === 'Edit expense' && ed.amount === '12.34' && /ExpDK/.test(ed.desc), tag() + 'Edit opens the same drawer titled "Edit expense" with the values filled', JSON.stringify(ed));
            await close();
            await sleep(200);
            ok(await p.evaluate(() => document.getElementById('expenseDrawerLabel').textContent === 'Log expense' && document.getElementById('expenseDrawerLabel').children.length === 0), tag() + 'closing resets the title back to "Log expense"', await p.evaluate(() => document.getElementById('expenseDrawerLabel').textContent));
            // REGRESSION: the reset used to be dead code (its element did not exist yet when the script ran), so after an Edit the next "Log expense" Save
            // overwrote the edited expense. A new expense logged right after an edit must be a NEW row and leave the edited one untouched.
            await p.evaluate((id) => window.openExpenseModal(id), bid);
            await p.waitForFunction(() => document.getElementById('expenseDrawer').classList.contains('atl-drawer--open'), { timeout: 10000 });
            await sleep(450);
            const clean = await p.evaluate(() => ({ edit: document.getElementById('expenseEditId').value, title: document.getElementById('expenseDrawerLabel').textContent, amount: document.getElementById('expenseAmount').value, desc: document.getElementById('expenseDescription').value }));
            ok(clean.edit === '' && clean.title === 'Log expense' && clean.amount === '' && clean.desc === '', tag() + 'opening "Log expense" after an Edit starts clean (no edit id, no old values)', JSON.stringify(clean));
            await p.select('#expenseCategory', 'misc');
            await p.evaluate((st) => { document.getElementById('expenseAmount').value = '20'; document.getElementById('expenseDescription').value = 'ExpDK2 ' + st; document.getElementById('expenseSaveBtn').click(); }, stampF);
            await p.waitForFunction(() => /dk-notice--(ok|bad)/.test(document.getElementById('expenseModalMsg').className), { timeout: 10000 }).catch(() => {});
            await p.waitForFunction(() => !document.getElementById('expenseDrawer').classList.contains('atl-drawer--open'), { timeout: 10000 }).catch(() => {});
            const rows = await support.q("SELECT id, amount, description FROM expenses WHERE description LIKE ? OR description LIKE ? ORDER BY id", ['%ExpDK ' + stampF + '%', '%ExpDK2 ' + stampF + '%']);
            const orig = rows.find((r) => r.id === exp.id), added = rows.find((r) => /ExpDK2/.test(r.description));
            ok(rows.length === 2 && orig && Math.abs(orig.amount - 12.34) < 0.001 && added && Math.abs(added.amount - 20) < 0.001, tag() + 'a new expense after an Edit is a NEW row; the edited one is unchanged (it used to be overwritten)', JSON.stringify(rows));
        }
        await open({ theme: 'dark', accent: 'gold', presence: 'editorial' });
        if (SHOTS) { await p.select('#expenseCategory', 'mileage'); await p.evaluate(() => { document.getElementById('expenseCategory').dispatchEvent(new Event('change', { bubbles: true })); document.getElementById('expenseSaveBtn').click(); }); await sleep(500); await p.screenshot({ path: path.join(SHOTS, 'expenseDrawer-dark-gold-error.png') }); }
        await close();

        // Manual Transaction
        D = DRAWERS[5];
        await open({ theme: 'dark', accent: 'gold', presence: 'editorial' });
        const dirShown = async () => [await vis('manualTxDirBlock'), await vis('manualTxMethodBlock')];
        const mt = {};
        mt.payment = await dirShown();
        await p.select('#manualTxType', 'adjustment'); await sleep(150); mt.adjustment = await dirShown();
        await p.select('#manualTxType', 'refund'); await sleep(150); mt.refund = await dirShown();
        ok(JSON.stringify(mt) === JSON.stringify({ payment: [false, true], adjustment: [true, false], refund: [false, true] }), tag() + 'the direction field shows for an Adjustment and the method field for the others', JSON.stringify(mt));
        ok((await labelled('manualTxDrawer')).length >= 8 && (await labelled('manualTxDrawer')).every(Boolean), tag() + 'every field has a label', JSON.stringify(await labelled('manualTxDrawer')));
        await p.select('#manualTxType', 'payment');
        await p.evaluate(() => { document.getElementById('manualTxAmount').value = ''; document.getElementById('manualTxSaveBtn').click(); });
        let mm = await msgOf('manualTxMsg');
        ok(/dk-notice--bad/.test(mm.cls) && mm.role === 'alert' && /valid amount/i.test(mm.text) && mm.shown, tag() + 'a missing amount shows an error notice (role=alert)', JSON.stringify(mm));
        // the server needs a booking: leaving it out is refused in the drawer, before anything is sent
        await p.evaluate(() => { document.getElementById('manualTxAmount').value = '75.50'; document.getElementById('manualTxBooking').value = ''; document.getElementById('manualTxSaveBtn').click(); });
        mm = await msgOf('manualTxMsg');
        ok(/dk-notice--bad/.test(mm.cls) && /booking/i.test(mm.text), tag() + 'no booking chosen: asked for it in the drawer (the server refuses a transaction without one)', JSON.stringify(mm));
        await p.evaluate(() => window.dkMessage('#manualTxMsg', '', ''));   // the previous error must not satisfy the wait below
        await p.evaluate((st, b) => { document.getElementById('manualTxBooking').value = String(b); document.getElementById('manualTxAmount').value = '75.50'; document.getElementById('manualTxReference').value = 'MTDK' + st; document.getElementById('manualTxSaveBtn').click(); }, stampF, bid);
        await p.waitForFunction(() => /dk-notice--(ok|bad)/.test(document.getElementById('manualTxMsg').className), { timeout: 10000 }).catch(() => {});
        mm = await msgOf('manualTxMsg');
        ok(/dk-notice--ok/.test(mm.cls) && /Transaction logged/.test(mm.text), tag() + 'a valid transaction saves and says so in a success notice', JSON.stringify(mm));
        await p.waitForFunction(() => !document.getElementById('manualTxDrawer').classList.contains('atl-drawer--open'), { timeout: 10000 }).catch(() => {});
        const tx = (await support.q("SELECT id, amount FROM transactions WHERE reference = ?", ['MTDK' + stampF]))[0];
        ok(tx && Math.abs(tx.amount - 75.5) < 0.001, tag() + 'the drawer closed itself and the transaction is in the ledger', JSON.stringify(tx));
        await close();
        // both message kinds in every Finish: ink text on the tint stays readable
        for (const f of FINISH) {
            await p.evaluate((t) => window.atlAppearance.set('theme', t), f);
            await p.evaluate(() => { window.dkMessage('#manualTxMsg', 'ok', 'Saved.'); });
            const okc = await p.evaluate(() => { const e = document.getElementById('manualTxMsg'); const cs = getComputedStyle(e); return { color: cs.color, bg: cs.backgroundColor, body: getComputedStyle(document.querySelector('#manualTxDrawer .atl-drawer__body')).backgroundColor }; });
            const fill = over(parse(okc.bg), parse(okc.body));
            const x = ratio(parse(okc.color), fill);
            ok(x >= 7, tag() + `${f}: a success notice is ink on its tint (${x.toFixed(1)}:1) - the old coloured line was 3.9:1 in Ivory`, JSON.stringify(okc));
        }
        await p.evaluate(() => { ['theme', 'accent', 'presence'].forEach((a) => window.atlAppearance.set(a, { theme: 'dark', accent: 'gold', presence: 'editorial' }[a])); window.dkMessage('#manualTxMsg', '', ''); });
        for (const di of [3, 4, 5]) { D = DRAWERS[di]; await suite(); }

        // ══ Deal View (light kit): structure untouched, finish matches the kit ════════════════════════════════════════════════
        const dvSet = (s) => p.evaluate((x) => { ['theme', 'accent', 'presence'].forEach((a) => { if (x && x[a]) window.atlAppearance.set(a, x[a]); }); }, s || null);
        const dvOpen = async (setting) => {
            await dvSet(setting);
            await p.evaluate((id) => window.toggleBookingDetail(id), bid);
            await p.waitForFunction(() => /atl-drawer--open/.test(document.getElementById('dealViewDrawer').className), { timeout: 20000 });
            await p.waitForFunction(() => document.querySelectorAll('#dv-panel-overview .atl-det-title').length > 0, { timeout: 20000 });
            await sleep(500);
        };
        const dvClose = async () => { await p.evaluate(() => window.closeAtlDrawer('dealViewDrawer')); await sleep(350); };
        const dvRead = () => p.evaluate(() => {
            const d = document.getElementById('dealViewDrawer'), cs = (e, k) => getComputedStyle(e)[k];
            const bgOf = (el) => { for (let e = el; e; e = e.parentElement) { const c = cs(e, 'backgroundColor'); if (c && !/rgba\(\s*0,\s*0,\s*0,\s*0\)|transparent/.test(c)) return c; } return cs(document.body, 'backgroundColor'); };
            const CARD = '#dv-panel-overview .atl-det-card:has(.atl-det-title)';   // the first card that has a title (the green "Next step" banner is a tinted card without one)
            const pick = (sel) => { const e = d.querySelector(sel); return e ? { color: cs(e, 'color'), bg: bgOf(e), border: cs(e, 'borderTopColor'), borderW: cs(e, 'borderTopWidth'), size: cs(e, 'fontSize'), weight: cs(e, 'fontWeight'), w: Math.round(e.getBoundingClientRect().width), radius: cs(e, 'borderRadius') } : null; };
            const t = d.querySelector('#dv-panel-overview .atl-det-title i'), tt = d.querySelector('#dv-panel-overview .atl-det-title');
            const gap = (() => { const ic = d.querySelector('#dv-panel-overview .atl-det-title > span > i, #dv-panel-overview .atl-det-title > i'); const tx = ic && (ic.nextSibling && ic.nextSibling.nodeType === 3 ? ic.nextSibling : ic.parentElement); if (!ic) return null; const r1 = ic.getBoundingClientRect(); const range = document.createRange(); const txt = [...ic.parentElement.childNodes].find((n) => n.nodeType === 3 && n.textContent.trim()); if (!txt) return null; range.selectNodeContents(txt); return Math.round(range.getBoundingClientRect().left - r1.right); })();
            return { card: pick(CARD), title: pick(CARD + ' .atl-det-title'), icon: pick(CARD + ' .atl-det-title i'), btn: pick(CARD + ' .atl-btn'),
                chip: pick('.dv-chip'), close: pick('.atl-drawer__close'), header: pick('.atl-drawer__header'), bodyBg: cs(d.querySelector('.atl-drawer__body'), 'backgroundColor'), gap, backdrop: cs(document.getElementById('dealViewDrawerBackdrop') || d, 'backgroundColor'),
                titleFamily: tt ? cs(tt, 'fontFamily').split(',')[0] : null };
        });
        const dvJudge = (r) => {
            const bad = [];
            const need = (name, fg, bgc, min) => { const f = parse(fg), b = parse(bgc); if (!f || !b) { bad.push(name + ': unreadable ' + fg + ' / ' + bgc); return; } const bb = b.a < 1 ? over(b, { r: 128, g: 128, b: 128, a: 1 }) : b; const ff = f.a < 1 ? over(f, bb) : f; const x = ratio(ff, bb); if (x < min) bad.push(`${name} ${x.toFixed(2)} < ${min}`); };
            need('card title on card', r.title.color, r.card.bg, 7);
            need('card icon on card', r.icon.color, r.card.bg, 3);
            if (r.btn) need('card button text', r.btn.color, r.btn.bg, 4.5);
            if (r.chip) need('chip text', r.chip.color, r.chip.bg, 4.5);
            need('close button', r.close.color, r.header.bg, 4.5);
            if (parseFloat(r.title.size) < 14 || parseFloat(r.title.weight) < 600) bad.push('card title is ' + r.title.size + '/' + r.title.weight + ', not 14px bold');
            if (!/50%|^2[0-9]px/.test(r.close.radius) || r.close.w < 40) bad.push('close button not round 40px: ' + r.close.radius + ' ' + r.close.w);
            if (r.gap != null && r.gap < 6) bad.push('icon is ' + r.gap + 'px from its title text');
            const bodyC = parse(r.bodyBg), cardC = parse(r.card.bg), brd = parse(r.card.border);
            if (bodyC && cardC && brd) { const surface = ratio(cardC, bodyC), edge = ratio(over(brd, cardC), bodyC); if (surface < 1.03 && edge < 1.3) bad.push(`cards not distinguishable (surface ${surface.toFixed(2)}, edge ${edge.toFixed(2)})`); if (parseFloat(r.card.borderW) < 1) bad.push('card has no border'); }
            return bad;
        };
        await dvOpen({ theme: 'dark', accent: 'gold', presence: 'editorial' });
        const dvShape = await p.evaluate(() => { const d = document.getElementById('dealViewDrawer'); return { tabs: d.querySelectorAll('.dv-tab').length, panels: d.querySelectorAll('.dv-panel').length, cls: d.className, titles: [...d.querySelectorAll('#dv-panel-overview .atl-det-title')].map((e) => e.textContent.trim().slice(0, 24)), sideways: d.querySelector('.atl-drawer__body').scrollWidth > d.querySelector('.atl-drawer__body').clientWidth + 1 }; });
        ok(dvShape.tabs === 7 && dvShape.panels === 7 && /atl-drawer--dk-lite/.test(dvShape.cls) && dvShape.titles.length >= 3 && !dvShape.sideways, '[dealView] structure untouched: 7 tabs, 7 panels, card titles present, no sideways scroll, light kit on', JSON.stringify(dvShape));
        // every tab still opens and shows content (the restyle must not have broken a panel)
        const tabsOk = await p.evaluate(async () => { const out = {}; for (const t of ['overview', 'progress', 'offer', 'invoices', 'advancing', 'timeline', 'files']) { document.getElementById('dv-tab-' + t).click(); await new Promise((r) => setTimeout(r, 350)); const panel = document.getElementById('dv-panel-' + t); out[t] = !panel.hidden && panel.textContent.trim().length > 20; } document.getElementById('dv-tab-overview').click(); return out; });
        ok(Object.values(tabsOk).every(Boolean), '[dealView] all seven tabs open and have content', JSON.stringify(tabsOk));
        await dvClose();
        let dvBad = [];
        for (const f of FINISH) for (const a of ACCENT) {
            const label = `${f}/${a}`;
            await dvOpen({ theme: f, accent: a, presence: 'editorial' });
            const r = await dvRead();
            const bad = dvJudge(r);
            ok(bad.length === 0, `[dealView] ${label}: titles, icons, buttons, chips, close button readable; cards distinguishable`, bad.join(' | '));
            if (bad.length) dvBad = dvBad.concat(bad.map((x) => label + ' ' + x));
            if (SHOTS && (a === 'gold' || a === 'cuivre') && f !== 'ember') await p.screenshot({ path: path.join(SHOTS, `dealViewDrawer-${f}-${a}.png`) });
            await dvClose();
        }
        // an OPEN Deal View re-themes live
        await dvOpen({ theme: 'dark', accent: 'gold', presence: 'editorial' });
        const dv1 = await dvRead();
        await p.evaluate(() => window.atlAppearance.set('theme', 'light')); await sleep(450);
        const dv2 = await dvRead();
        await p.evaluate(() => window.atlAppearance.set('accent', 'cassis')); await sleep(450);
        const dv3 = await dvRead();
        ok(dv1.card.bg !== dv2.card.bg && dv1.title.color !== dv2.title.color && dv1.backdrop !== dv2.backdrop, '[dealView] Finish dark -> light: the OPEN drawer card, title and backdrop all change, no reload', JSON.stringify([dv1.card.bg, dv2.card.bg]));
        ok(dv2.icon.color !== dv3.icon.color && dv2.close.border !== dv3.close.border || dv2.icon.color !== dv3.icon.color, '[dealView] Accent gold -> cassis: the icons change with it', JSON.stringify([dv2.icon.color, dv3.icon.color]));
        await dvClose();
        await dvSet({ theme: 'dark', accent: 'gold', presence: 'editorial' });
        // phone
        await p.setViewport({ width: 390, height: 844 });
        await dvOpen();
        const dvPh = await p.evaluate(() => { const d = document.getElementById('dealViewDrawer'); const b = d.querySelector('.atl-drawer__body'); return { w: Math.round(d.getBoundingClientRect().width), vw: innerWidth, over: b.scrollWidth > b.clientWidth + 1, close: Math.round(d.querySelector('.atl-drawer__close').getBoundingClientRect().width) }; });
        ok(dvPh.w === dvPh.vw && !dvPh.over && dvPh.close >= 40, '[dealView] phone (390px): full width, no sideways scroll in the body, a 40px+ close button', JSON.stringify(dvPh));
        if (SHOTS) await p.screenshot({ path: path.join(SHOTS, 'dealViewDrawer-phone.png') });
        await dvClose();
        await p.setViewport({ width: 1440, height: 900 });
        if (dvBad.length) console.log('\nDeal View contrast detail:\n  ' + dvBad.join('\n  '));
        ok(errs.length === 0, 'no script errors', errs.join(' | '));
        if (allBad.length) console.log('\nContrast detail:\n  ' + allBad.join('\n  '));
    } catch (e) {
        ok(false, 'browser test crashed', e && e.stack);
    } finally {
        await browser.close();
        await support.stop();
    }
    console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
    process.exit(fails ? 1 : 0);
})();
