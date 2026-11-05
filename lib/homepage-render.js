// Server-side fill of the public homepage. index.html ships built-in text (hero, "What I do" cards, manager details...) and every section, and
// js/myscript.js used to replace that text and hide the sections the admin switched off only AFTER the page appeared - so a visitor (and
// every first visit, private window and search-engine crawl, which have no cached section map) saw the old text or a hidden section first,
// then watched it change, and the hidden sections' content was still downloaded.
//
// Now the server writes the SAME values into the page before sending it, doing exactly what the browser script does with them (same data
// from lib/homepage-content.js, same fields, same text-vs-HTML handling), so what the script applies afterwards changes nothing visible.
//
// Rules:
//   - index.html stays the template and a valid page on its own: no placeholders in the visible markup. Elements are found by the same
//     ids / classes the browser script uses (skipping anything inside <!-- comments --> and <script>); one the template no longer has is
//     simply left alone, and the browser script still fills it (test/homepage-render.test.js pins that every one is found today).
//   - Never breaks the homepage: any data error or a slow database (> FILL_TIMEOUT_MS) serves the template unchanged, as before.
//   - Text fields are HTML-escaped (the browser uses .text()); the fields the browser inserts as HTML (.html()) are inserted as stored -
//     they are sanitised when the admin saves them, exactly the trust the browser script already gives them.
//   - Hidden sections: the section map is written into the head script (#tmSectionsBoot), which hides them and their nav links before first
//     paint and tells the browser script not to fetch their content; the section elements also get .tm-section-hidden (works without JS).
const fs = require('fs');
const path = require('path');

const INDEX_FILE = path.join(__dirname, '..', 'index.html');
const FILL_TIMEOUT_MS = 1500;
const SECTIONS_TOKEN = '/*TM_SECTIONS*/null';

// section key -> selector, the same map as SECTION_MAP in js/myscript.js and the head script in index.html
const SECTION_SELECTORS = { hero: '#hero', features: '.tm-features', services: '.tm-services', about: '#about', career: '#career', accolades: '#accolades', footprint: '#footprint', team: '#team', gallery: '#gallery', events: '#events', social: '#social', newsletter: '#newsletter', testimonials: '#testimonials', faq: '#faq', contact: '#contact', footer: '.tm-footer' };

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const filled = (v) => v != null && String(v).trim() !== '';

// ---- a tiny element finder over the template string -------------------------------------------------------------------------------
// True when position i is inside an HTML comment or a <script> block (a commented-out duplicate or a script string must not match).
function inert(html, i) {
    const c = html.lastIndexOf('<!--', i);
    if (c >= 0 && html.lastIndexOf('-->', i) < c) return true;
    const s = html.lastIndexOf('<script', i);
    return s >= 0 && html.lastIndexOf('</script>', i) < s;
}
function openTagRe(sel) {
    if (/^[a-z][a-z0-9]*$/.test(sel)) return new RegExp('<(' + sel + ')\\b[^>]*>', 'g'); // a bare tag name, used inside a known parent
    if (sel[0] === '#') return new RegExp('<([a-zA-Z][a-zA-Z0-9]*)\\b[^>]*\\bid="' + reEsc(sel.slice(1)) + '"[^>]*>', 'g');
    return new RegExp('<([a-zA-Z][a-zA-Z0-9]*)\\b[^>]*\\bclass="(?:[^"]*\\s)?' + reEsc(sel.slice(1)) + '(?:\\s[^"]*)?"[^>]*>', 'g');
}
// Every live element matching a simple selector (#id, .class or a bare tag name) within [from, to): { start, openEnd, closeStart, end, tag, open }.
function findAll(html, sel, from = 0, to = html.length) {
    const re = openTagRe(sel);
    re.lastIndex = from;
    const out = [];
    let m;
    while ((m = re.exec(html)) && m.index < to) {
        if (inert(html, m.index)) continue;
        const tag = m[1].toLowerCase();
        const openEnd = m.index + m[0].length;
        let closeStart = -1, end = -1;
        if (/^(img|br|hr|input|meta|link|source)$/.test(tag) || m[0].endsWith('/>')) { closeStart = end = openEnd; }
        else {
            const t = new RegExp('<\\/?' + tag + '\\b[^>]*>', 'gi');
            t.lastIndex = openEnd;
            let depth = 1, x;
            while ((x = t.exec(html))) {
                if (inert(html, x.index)) continue;
                depth += x[0][1] === '/' ? -1 : 1;
                if (depth === 0) { closeStart = x.index; end = x.index + x[0].length; break; }
            }
            if (end < 0) continue;
        }
        out.push({ start: m.index, openEnd, closeStart, end, tag, open: m[0] });
    }
    return out;
}

// Applies edits ({ start, end, text }) from the back so earlier offsets stay valid.
function applyEdits(html, edits) {
    edits.sort((a, b) => b.start - a.start);
    edits.forEach((e) => { html = html.slice(0, e.start) + e.text + html.slice(e.end); });
    return html;
}
function setAttr(open, name, value) {
    const re = new RegExp('\\s' + name + '="[^"]*"');
    const attr = ' ' + name + '="' + esc(value) + '"';
    if (re.test(open)) return open.replace(re, attr);
    return open.replace(/\s*\/?>$/, (end) => attr + end);
}
function addClass(open, cls) {
    if (/\bclass="/.test(open)) return open.replace(/\bclass="([^"]*)"/, (m, v) => (new RegExp('(^|\\s)' + reEsc(cls) + '(\\s|$)').test(v) ? m : 'class="' + (v ? v + ' ' : '') + cls + '"'));
    return setAttr(open, 'class', cls);
}
function addStyle(open, decl) {
    const m = /\sstyle="([^"]*)"/.exec(open);
    if (!m) return setAttr(open, 'style', decl);
    const cur = m[1].trim();
    return setAttr(open, 'style', (cur ? cur.replace(/;?\s*$/, '; ') : '') + decl);
}

// ---- the fill: mirrors renderSiteContent / renderAboutMe / renderContactInfo / renderPublicManager in js/myscript.js ----------------
// Returns { html, missed } - `missed` lists the anchors the template no longer has (for the tests; the page still works).
function fill(template, data) {
    const missed = [];
    let html = template;
    const one = (sel, from, to) => {
        const all = findAll(html, sel, from, to);
        if (all.length !== 1) { missed.push(sel + (all.length ? ' (x' + all.length + ')' : '')); return null; }
        return all[0];
    };
    // one pass = find, then edit; re-finding after every pass keeps offsets honest
    const pass = (fn) => { const edits = []; fn(edits); html = applyEdits(html, edits); };
    const inner = (el, text) => ({ start: el.openEnd, end: el.closeStart, text });
    const reopen = (el, open) => ({ start: el.start, end: el.openEnd, text: open });

    const site = data.site;
    if (site) {
        const a = site.announcement || {};
        pass((ed) => {
            const bar = one('.tm-announcement');
            if (!bar) return;
            let open = bar.open;
            if (a.enabled === false) open = addStyle(open, 'display: none;');
            if (a.rotate === false) open = addClass(open, 'no-rotate');
            const mq = one('.tm-announce-marquee', bar.openEnd, bar.closeStart);
            if (mq) {
                let mqOpen = mq.open;
                if (a.speed >= 1 && a.speed <= 10) mqOpen = addStyle(mqOpen, 'animation-duration: ' + Math.round(90 / a.speed) + 's;');
                ed.push(reopen(mq, mqOpen));
                if (filled(a.text)) ed.push(inner(mq, a.text));
            }
            ed.push(reopen(bar, open));
        });
        pass((ed) => {
            const tag = filled(site.hero_tagline) && one('.tm-hero__tagline');
            if (tag) ed.push(inner(tag, esc(site.hero_tagline)));
            const sub = filled(site.hero_subtitle) && one('.tm-hero__subtitle');
            if (sub) ed.push(inner(sub, site.hero_subtitle));
        });

        const s = site.services || {};
        pass((ed) => {
            const sec = one('.tm-services');
            if (!sec) return;
            const eb = filled(s.eyebrow) && one('.tm-eyebrow', sec.openEnd, sec.closeStart);
            if (eb) ed.push(inner(eb, esc(s.eyebrow)));
            const h = filled(s.heading) && one('#servicesTitle', sec.openEnd, sec.closeStart);
            if (h) ed.push(inner(h, s.heading));
            const items = Array.isArray(s.items) ? s.items : [];
            if (!items.length) return;
            const grid = one('.tm-services__grid', sec.openEnd, sec.closeStart);
            if (!grid) return;
            const cards = findAll(html, '.tm-service', grid.openEnd, grid.closeStart);
            // "Most Booked": once the admin has chosen (a card, or none), the badge follows the choice; before that the page keeps its built-in one
            const chosen = items.some((it) => it && typeof it.featured === 'boolean');
            if (chosen) findAll(html, '.tm-service__tag', grid.openEnd, grid.closeStart).forEach((t) => ed.push({ start: t.start, end: t.end, text: '' })); // every card, as the browser does
            items.forEach((item, i) => {
                const c = cards[i];
                if (!c || !item) return;
                if (filled(item.title)) { const t = one('.tm-service__title', c.openEnd, c.closeStart); if (t) ed.push(inner(t, esc(item.title))); }
                if (filled(item.description)) { const d = one('.tm-service__desc', c.openEnd, c.closeStart); if (d) ed.push(inner(d, esc(item.description))); }
                if (filled(item.image)) {
                    const bg = one('.tm-service__bg', c.openEnd, c.closeStart);
                    if (bg) ed.push(reopen(bg, addStyle(bg.open, 'background-image: url("' + String(item.image).replace(/["\\\r\n]/g, '') + '");')));
                }
                if (chosen && item.featured) {
                    const ov = one('.tm-service__overlay', c.openEnd, c.closeStart);
                    if (ov) ed.push({ start: ov.end, end: ov.end, text: '<span class="tm-service__tag">Most Booked</span>' });
                }
            });
        });

        const f = (site.features && Array.isArray(site.features.items)) ? site.features.items : [];
        if (f.length) pass((ed) => {
            const grid = one('.tm-features__grid');
            if (!grid) return;
            const cards = findAll(html, '.tm-feature', grid.openEnd, grid.closeStart);
            f.forEach((item, i) => {
                const c = cards[i];
                if (!c || !item) return;
                if (filled(item.title)) { const t = one('.tm-feature__title', c.openEnd, c.closeStart); if (t) ed.push(inner(t, esc(item.title))); }
                if (filled(item.description)) { const d = one('.tm-feature__desc', c.openEnd, c.closeStart); if (d) ed.push(inner(d, esc(item.description))); }
            });
        });

        // sections the admin switched off: hidden in the markup itself, and the map handed to the head script
        const sections = site.sections || {};
        pass((ed) => {
            Object.keys(SECTION_SELECTORS).forEach((k) => {
                if (sections[k] !== false) return;
                const el = one(SECTION_SELECTORS[k]);
                if (el) ed.push(reopen(el, addClass(el.open, 'tm-section-hidden')));
            });
        });
        const at = html.indexOf(SECTIONS_TOKEN);
        if (at < 0) missed.push('#tmSectionsBoot token');
        else html = html.slice(0, at) + JSON.stringify(sections).replace(/</g, '\\u003c') + html.slice(at + SECTIONS_TOKEN.length);
    }

    const about = data.about;
    if (about) pass((ed) => {
        if (about.image_path) { const img = one('.about-img'); if (img) ed.push(reopen(img, setAttr(img.open, 'src', about.image_path))); }
        const body = (about.paragraph1 || '') + (about.paragraph2 || '') + (about.paragraph3 || '');
        if (body.trim()) { const card = one('.about-text-card'); if (card) ed.push(inner(card, body)); }
    });

    const contact = data.contact;
    if (contact) pass((ed) => {
        if (contact.quote) {
            const q = one('#dynamicContactQuote');
            const p = q && findAll(html, 'p', q.openEnd, q.closeStart)[0];
            if (p) ed.push(inner(p, contact.quote)); else missed.push('#dynamicContactQuote p');
        }
        if (contact.signature) { const n = one('#dynamicContactName'); if (n) ed.push(inner(n, esc(contact.signature))); }
    });

    const m = data.manager;
    if (m && m.name) pass((ed) => {
        const name = one('#dynamicManagerName'); if (name) ed.push(inner(name, esc(m.name || '')));
        const cell = one('#dynamicManagerCell'); if (cell) ed.push(inner(cell, esc(m.cell_number || '')));
        const wa = one('#dynamicManagerWhatsApp');
        if (wa) {
            let link = '';
            if (m.whatsapp_link) link = '<a href="' + esc(m.whatsapp_link) + '" target="_blank">' + esc(m.whatsapp_number || '') + '</a>';
            else if (m.whatsapp_number) link = '<a href="https://wa.me/' + String(m.whatsapp_number).replace(/\D/g, '') + '" target="_blank">' + esc(m.whatsapp_number) + '</a>';
            ed.push(inner(wa, link));
        }
        if (m.email) { const em = one('#dynamicManagerEmail'); if (em) { ed.push(reopen(em, setAttr(em.open, 'href', 'mailto:' + m.email))); ed.push(inner(em, esc(m.email))); } }
    });

    return { html, missed };
}

// ---- template + data ------------------------------------------------------------------------------------------------------------
let cache = { mtimeMs: -1, html: null };
function template() {
    const st = fs.statSync(INDEX_FILE);
    if (cache.html === null || cache.mtimeMs !== st.mtimeMs) cache = { mtimeMs: st.mtimeMs, html: fs.readFileSync(INDEX_FILE, 'utf8') };
    return cache.html;
}

async function loadData() {
    const content = require('./homepage-content'); // lazy: keeps fill() usable (and testable) without opening the database
    const settle = (p) => p.then((v) => v, () => null); // one missing piece never blocks the rest
    const [site, about, contact, manager] = await Promise.all([settle(content.getSiteContent()), settle(content.getAboutMe()), settle(content.getContactInfo()), settle(content.getManager())]);
    return { site, about, contact, manager };
}

// The last fill, reused while neither the template nor the content has changed (the fill walks a ~280 KB page; the data reads are cheap).
let last = { key: null, html: null };

// The homepage as it should be sent. Never throws and never waits longer than FILL_TIMEOUT_MS: falls back to the plain template.
async function renderHomepage() {
    const tpl = template();
    try {
        const data = await Promise.race([loadData(), new Promise((resolve) => setTimeout(() => resolve(null), FILL_TIMEOUT_MS).unref())]);
        if (!data) return tpl;
        const key = cache.mtimeMs + '|' + JSON.stringify(data);
        if (last.key !== key) last = { key, html: fill(tpl, data).html };
        return last.html;
    } catch (e) {
        console.error('[homepage] server-side fill failed, serving the plain page:', e && e.message);
        return tpl;
    }
}

module.exports = { renderHomepage, fill, findAll, SECTION_SELECTORS, SECTIONS_TOKEN, INDEX_FILE };
