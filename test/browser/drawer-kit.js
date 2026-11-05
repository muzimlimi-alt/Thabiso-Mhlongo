// Admin Drawer Kit (css/admin/drawer-kit.css, .atl-drawer--dk) under EVERY Appearance setting the admin supports (js/appearance.js):
//   Finish x Accent = 3 x 4 = 12 combinations, then the 3 Presence settings. For each it opens a converted drawer and measures, in a real browser:
//     readable text (ink, muted, accent, badges), cards distinguishable from the drawer body, visible borders, button contrast, a visible focus ring;
//   and proves the rules in the Appearance brief: an OPEN drawer re-themes the moment the setting changes (no reload), the kit holds NO colour literal,
//   and a converted drawer's markup carries no hardcoded colour.
// Drawers covered: every id listed in CONVERTED below (add each drawer here as it is converted).
// Not part of `npm test`: `npm run test:browser` (needs PUPPETEER_EXECUTABLE_PATH). DRAWER_SHOTS=<dir> saves a screenshot per Finish/Accent.
const fs = require('fs');
const path = require('path');
const support = require('../support');
const puppeteer = require('puppeteer');
const { BASE, sleep } = support;
let fails = 0;
const ok = (c, n, detail) => { if (!c) fails++; console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '\n        -> ' + String(detail).slice(0, 600))); };
const SHOTS = process.env.DRAWER_SHOTS || null;
const ROOT = path.join(__dirname, '..', '..');
const CONVERTED = ['bookingInfoDrawer'];

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
function readDrawer(id) {
    const d = document.getElementById(id);
    const cs = (el, p) => getComputedStyle(el)[p];
    // the colour an element is actually painted on: walk up until a non-transparent background
    const bgOf = (el) => { for (let e = el; e; e = e.parentElement) { const c = cs(e, 'backgroundColor'); if (c && !/rgba\(\s*0,\s*0,\s*0,\s*0\)|transparent/.test(c)) return c; } return cs(document.body, 'backgroundColor'); };
    const q = (s) => d.querySelector(s);
    const pick = (s) => { const el = q(s); return el ? { color: cs(el, 'color'), bg: bgOf(el), border: cs(el, 'borderTopColor'), borderW: cs(el, 'borderTopWidth'), outline: cs(el, 'outlineStyle') } : null; };
    const body = q('.atl-drawer__body');
    const out = {
        body: { bg: cs(body, 'backgroundColor') },
        card: pick('.dk-card'), cardTitle: pick('.dk-card__title'), cardIcon: pick('.dk-card__icon'), label: pick('.dk-k'), value: pick('.dk-v'),
        link: pick('.dk-v a'), fact: pick('.dk-fact'), factK: pick('.dk-fact__k'), factV: pick('#bi-location'), factAccent: pick('.dk-fact__v--accent'), factOk: pick('.dk-fact__v--ok'),
        badge: pick('.dk-badge'), title: pick('.dk-title'), sub: pick('.dk-sub'), icon: pick('.dk-icon'), close: pick('.atl-drawer__close'),
        inset: pick('#bi-message'), footerBtn: pick('.atl-drawer__footer .atl-btn'), header: pick('.atl-drawer__header'), footer: pick('.atl-drawer__footer'),
        backdrop: (() => { const b = document.getElementById(id + 'Backdrop'); return b ? cs(b, 'backgroundColor') : null; })(),
        gap: cs(body, 'rowGap'), pad: cs(body, 'paddingTop')
    };
    return out;
}

function judge(label, r) {
    const bad = [];
    const need = (name, fg, bgc, min) => { const f = parse(fg), b = parse(bgc); if (!f || !b) { bad.push(name + ': unreadable colour ' + fg + ' / ' + bgc); return; } const bb = b.a < 1 ? over(b, { r: 128, g: 128, b: 128, a: 1 }) : b; const ff = f.a < 1 ? over(f, bb) : f; const x = ratio(ff, bb); if (x < min) bad.push(`${name} ${x.toFixed(2)} < ${min}`); };
    const card = r.card && r.card.bg;
    need('card title on card', r.cardTitle.color, card, 7);
    need('row value on card', r.value.color, card, 7);
    need('row label (muted) on card', r.label.color, card, 4.5);
    need('link (accent) on card', r.link ? r.link.color : r.cardIcon.color, card, 4.5);
    need('card icon (accent) on card', r.cardIcon.color, card, 3);
    need('inset text on inset', r.inset.color, r.inset.bg, 4.5);
    need('fact label on fact', r.factK.color, r.fact.bg, 4.5);
    need('fact value on fact', r.factV.color, r.fact.bg, 7);
    need('fact accent on fact', r.factAccent.color, r.fact.bg, 4.5);
    need('fact ok on fact', r.factOk.color, r.fact.bg, 4.5);
    need('title on header', r.title.color, r.header.bg, 7);
    need('sub on header', r.sub.color, r.header.bg, 4.5);
    need('close button', r.close.color, r.header.bg, 4.5);
    need('footer button text', r.footerBtn.color, r.footer.bg, 4.5);
    // the badge: text on its own tinted fill over the card
    { const b = parse(r.badge.bg), c = parse(card); if (b && c) { const fill = over(b, c); need('badge text on its fill', r.badge.color, `rgb(${fill.r},${fill.g},${fill.b})`, 4.5); } }
    // cards read as cards: either the surface differs from the drawer body, or the border does, or both
    const body = parse(r.body.bg), cardC = parse(card), brd = parse(r.card.border);
    if (body && cardC && brd) {
        const surface = ratio(cardC, body);
        const borderOnBody = ratio(over(brd, over(cardC, body)), body);
        if (surface < 1.05 && borderOnBody < 1.3) bad.push(`card not distinguishable (surface ${surface.toFixed(2)}, border ${borderOnBody.toFixed(2)})`);
        if (parseFloat(r.card.borderW) < 1) bad.push('card border width ' + r.card.borderW);
    }
    if (r.backdrop && /rgba\(\s*0,\s*0,\s*0,\s*0\.5[0-9]*\)/.test(r.backdrop) && label.indexOf('light') >= 0 && label.indexOf('ember') < 0 && false) bad.push('backdrop');
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

        const open = async (setting) => {
            await p.evaluate((s) => { if (s) ['theme', 'accent', 'presence'].forEach((a) => { if (s[a]) window.atlAppearance.set(a, s[a]); }); }, setting || null);
            await p.evaluate((id) => { const b = document.createElement('button'); b.className = 'bk-action-info'; b.setAttribute('data-id', id); b.style.display = 'none'; document.body.appendChild(b); b.click(); b.remove(); }, bid);
            await p.waitForFunction(() => document.getElementById('bookingInfoDrawer').classList.contains('atl-drawer--open'), { timeout: 10000 });
            await sleep(450); // its slide-in
        };
        const close = async () => { await p.evaluate(() => closeAtlDrawer('bookingInfoDrawer')); await sleep(350); };

        // ── structure: the data is where the admin expects it ─────────────────────────────────────────────────────────────────
        await open({ theme: 'dark', accent: 'gold', presence: 'editorial' });
        const shape = await p.evaluate(() => {
            const d = document.getElementById('bookingInfoDrawer');
            const t = (id) => (document.getElementById(id) || {}).textContent;
            return { title: t('bi-modal-title'), name: t('bi-name'), date: t('bi-date'), cards: d.querySelectorAll('details.dk-card').length, openCards: d.querySelectorAll('details.dk-card[open]:not([hidden])').length,
                facts: d.querySelectorAll('.dk-fact').length, rows: d.querySelectorAll('.dk-row').length, empties: [...d.querySelectorAll('[id^="bi-"]')].filter((e) => !e.children.length && !(e.textContent || '').trim() && !/start-time|venue-notes|email/.test(e.id)).map((e) => e.id),
                dupIds: (() => { const ids = [...d.querySelectorAll('[id]')].map((e) => e.id); return ids.filter((x, i) => ids.indexOf(x) !== i); })(),
                modal: d.getAttribute('aria-modal'), label: d.getAttribute('aria-labelledby'), scrollY: d.querySelector('.atl-drawer__body').scrollHeight > 0 };
        });
        ok(/^Booking #\d+/.test(shape.title) && shape.name && shape.date, 'the drawer is filled from the booking (title, name, date)', JSON.stringify(shape));
        ok(shape.facts === 4 && shape.rows >= 12 && shape.cards >= 4 && shape.empties.length === 0, 'summary facts + label/value rows + cards are all there, nothing left empty', JSON.stringify(shape));
        ok(shape.dupIds.length === 0 && shape.modal === 'true' && shape.label === 'bookingInfoDrawerLabel', 'accessibility: unique ids, aria-modal, labelled by its title', JSON.stringify(shape));
        const noScroll = await p.evaluate(() => { const d = document.getElementById('bookingInfoDrawer'); return { x: d.scrollWidth <= d.clientWidth + 1, bodyX: d.querySelector('.atl-drawer__body').scrollWidth <= d.querySelector('.atl-drawer__body').clientWidth + 1 }; });
        ok(noScroll.x && noScroll.bodyX, 'no sideways scrolling inside the drawer', JSON.stringify(noScroll));

        // layout: nothing collapsed, crushed or spilling (the contrast numbers cannot see this - a squashed card still has perfect contrast)
        const lay = await p.evaluate(() => {
            const d = document.getElementById('bookingInfoDrawer');
            const out = { facts: Math.round(d.querySelector('.dk-facts').getBoundingClientRect().height), spill: [], short: [] };
            d.querySelectorAll('details.dk-card:not([hidden])').forEach((c, i) => {
                const cb = c.getBoundingClientRect(), sum = c.querySelector('summary').getBoundingClientRect();
                const kids = c.querySelectorAll('.dk-row, .dk-inset');
                kids.forEach((k) => { if (k.getBoundingClientRect().bottom > cb.bottom + 1) out.spill.push(i + ':' + (k.id || k.className)); });
                if (c.open && cb.height < sum.height + 40) out.short.push(i);
            });
            const t = d.querySelector('.dk-title'), cs = getComputedStyle(t);
            out.title = { size: cs.fontSize, family: cs.fontFamily.split(',')[0], weight: cs.fontWeight, h: Math.round(t.getBoundingClientRect().height) };
            const chev = d.querySelector('.dk-card__chev').getBoundingClientRect(), card = d.querySelector('.dk-card').getBoundingClientRect();
            out.chevRight = Math.round(card.right - chev.right);
            return out;
        });
        ok(lay.facts >= 100 && lay.spill.length === 0 && lay.short.length === 0, 'layout: the facts band and every open card keep their full height; no row spills out of its card', JSON.stringify(lay));
        ok(parseFloat(lay.title.size) >= 20 && /Cormorant/.test(lay.title.family), 'layout: the title is the 22px serif (not shrunk to the shell 15px sans)', JSON.stringify(lay.title));
        ok(lay.chevRight >= 8 && lay.chevRight <= 24, 'layout: the card chevron sits at the right edge of its header', JSON.stringify(lay.chevRight));

        // collapsing a card works and is keyboard friendly
        const toggle = await p.evaluate(() => { const c = document.querySelector('#bookingInfoDrawer details.dk-card'); const s = c.querySelector('summary'); s.focus(); const focused = document.activeElement === s; const was = c.open; s.click(); const now = c.open; s.click(); return { focused, was, now, back: c.open, h: c.getBoundingClientRect().height }; });
        ok(toggle.focused && toggle.was === true && toggle.now === false && toggle.back === true, 'a card collapses and re-opens from its header (keyboard-focusable)', JSON.stringify(toggle));
        await close();

        // ── every Finish x Accent ──────────────────────────────────────────────────────────────────────────────────────────────
        let allBad = [];
        for (const f of FINISH) for (const a of ACCENT) {
            const label = `${f}/${a}`;
            await open({ theme: f, accent: a, presence: 'editorial' });
            const r = await p.evaluate(readDrawer, 'bookingInfoDrawer');
            const bad = judge(label, r);
            ok(bad.length === 0, `${label}: readable text, visible cards/borders, button + badge contrast`, bad.join(' | '));
            if (bad.length) allBad = allBad.concat(bad.map((x) => label + ' ' + x));
            // keyboard focus is visible
            const focus = await p.evaluate(() => { const s = document.querySelector('#bookingInfoDrawer .dk-card > summary'); s.focus(); const cs = getComputedStyle(s); return { style: cs.outlineStyle, w: cs.outlineWidth, color: cs.outlineColor }; });
            ok(focus.style !== 'none' && parseFloat(focus.w) >= 2 && !/rgba\(0, 0, 0, 0\)/.test(focus.color), `${label}: keyboard focus ring is visible`, JSON.stringify(focus));
            if (SHOTS && (a === 'gold' || f === 'light')) await p.screenshot({ path: path.join(SHOTS, `drawer-${f}-${a}.png`) });
            await close();
        }

        // ── Presence: spacing follows it, colours do not break ────────────────────────────────────────────────────────────────
        const gaps = {};
        for (const pr of PRESENCE) {
            await open({ theme: 'dark', accent: 'gold', presence: pr });
            const r = await p.evaluate(readDrawer, 'bookingInfoDrawer');
            gaps[pr] = r.pad;
            gaps[pr + '_dbg'] = await p.evaluate(() => { const b = document.querySelector('#bookingInfoDrawer .atl-drawer__body'); return [document.documentElement.getAttribute('data-presence'), getComputedStyle(document.documentElement).getPropertyValue('--atl-sp-lg').trim(), getComputedStyle(b).getPropertyValue('--atl-sp-lg').trim(), getComputedStyle(b).paddingTop, b.parentElement.className].join(' | '); });
            const bad = judge('presence/' + pr, r);
            ok(bad.length === 0, `presence ${pr}: still readable (body padding ${r.pad})`, bad.join(' | '));
            await close();
        }
        ok(parseFloat(gaps.boutique) > parseFloat(gaps.editorial) && parseFloat(gaps.editorial) > parseFloat(gaps.operations), 'Presence changes the drawer\'s spacing (boutique > editorial > operations)', JSON.stringify(gaps));

        // ── an OPEN drawer re-themes live, with no reload ─────────────────────────────────────────────────────────────────────
        await open({ theme: 'dark', accent: 'gold', presence: 'editorial' });
        await p.evaluate(() => { window.__noReload = 1; });
        const snap = () => p.evaluate(readDrawer, 'bookingInfoDrawer');
        const s1 = await snap();
        await p.evaluate(() => window.atlAppearance.set('theme', 'light'));
        await sleep(450); // the admin's own colour transition
        const s2 = await snap();
        ok(s1.card.bg !== s2.card.bg && s1.body.bg !== s2.body.bg && s1.cardTitle.color !== s2.cardTitle.color, 'Finish dark -> light: the OPEN drawer\'s card, body and text colours all change', JSON.stringify({ a: s1.card.bg, b: s2.card.bg }));
        await p.evaluate(() => window.atlAppearance.set('accent', 'cassis'));
        await sleep(450);
        const s3 = await snap();
        ok(s2.cardIcon.color !== s3.cardIcon.color && s2.icon.border !== s3.icon.border && s2.link.color !== s3.link.color, 'Accent gold -> cassis: icons, links and the header tile change with it', JSON.stringify({ a: s2.cardIcon.color, b: s3.cardIcon.color }));
        await p.evaluate(() => window.atlAppearance.set('presence', 'boutique'));
        await sleep(200);
        const s4 = await snap();
        ok(parseFloat(s4.pad) > parseFloat(s3.pad), 'Presence editorial -> boutique: the open drawer spacing changes', JSON.stringify({ a: s3.pad, b: s4.pad }));
        ok(await p.evaluate(() => window.__noReload === 1 && document.getElementById('bookingInfoDrawer').classList.contains('atl-drawer--open')), 'all of that happened with no page reload, drawer still open', '');
        ok(s1.backdrop !== s2.backdrop, 'the backdrop follows the Finish too (no hardcoded black)', JSON.stringify([s1.backdrop, s2.backdrop]));
        await close();
        // a drawer opened AFTER the change uses the new look at once
        await open();
        const s5 = await snap();
        ok(s5.cardIcon.color === s3.cardIcon.color && s5.card.bg === s3.card.bg, 'a drawer opened after the change uses the selected look at once', JSON.stringify({ a: s5.card.bg, b: s3.card.bg }));
        await close();

        // ── the venue-notes card appears only when there are notes, in the theme's colours ───────────────────────────────────
        await p.evaluate((id) => { const b = allBookingsCache.find((x) => x.id == id); b.venue_notes = 'Load-in via the side door'; b.venue_negotiated_rates = 'R500 off'; }, bid);
        await open({ theme: 'light', accent: 'gold', presence: 'editorial' });
        const vn = await p.evaluate(() => { const c = document.getElementById('bi-venue-card'); const i = document.getElementById('bi-venue-notes'); return { hidden: c.hidden, text: i.textContent, color: getComputedStyle(i.querySelector('.dk-inset__line')).color, bg: getComputedStyle(i).backgroundColor }; });
        ok(vn.hidden === false && /Load-in/.test(vn.text) && /Negotiated rates/.test(vn.text), 'venue notes: the card shows when the booking has notes', JSON.stringify(vn));
        const vbad = (() => { const f = parse(vn.color), b = parse(vn.bg); if (!f || !b) return 'unparsed'; const x = ratio(f, over(b, { r: 255, g: 253, b: 248, a: 1 })); return x >= 4.5 ? '' : 'contrast ' + x.toFixed(2); })();
        ok(vbad === '', 'venue notes: readable in the Ivory Finish (it was a fixed #aaa before)', vbad);
        if (SHOTS) await p.screenshot({ path: path.join(SHOTS, 'drawer-light-gold-notes.png') });
        await close();
        await p.evaluate((id) => { const b = allBookingsCache.find((x) => x.id == id); b.venue_notes = ''; b.venue_negotiated_rates = ''; b.green_room_notes = ''; }, bid);
        await open();
        ok(await p.evaluate(() => document.getElementById('bi-venue-card').hidden === true), 'venue notes: the card hides again when there are none', '');
        await close();

        // ── phone width ───────────────────────────────────────────────────────────────────────────────────────────────────────
        await p.setViewport({ width: 390, height: 844 });
        await open({ theme: 'dark', accent: 'gold', presence: 'editorial' });
        const ph = await p.evaluate(() => { const d = document.getElementById('bookingInfoDrawer'); const r = d.getBoundingClientRect(); const f = d.querySelector('.dk-facts'); return { w: Math.round(r.width), vw: innerWidth, fx: f.scrollWidth <= f.clientWidth + 1, cols: getComputedStyle(f).gridTemplateColumns.split(' ').length, over: d.querySelector('.atl-drawer__body').scrollWidth <= d.querySelector('.atl-drawer__body').clientWidth + 1, closeW: Math.round(d.querySelector('.atl-drawer__close').getBoundingClientRect().width) }; });
        ok(ph.w === ph.vw && ph.over && ph.cols === 1 && ph.closeW >= 40, 'phone (390px): full-width, single-column facts, no sideways scroll, a 40px+ close button', JSON.stringify(ph));
        if (SHOTS) await p.screenshot({ path: path.join(SHOTS, 'drawer-phone.png') });
        await close();
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
