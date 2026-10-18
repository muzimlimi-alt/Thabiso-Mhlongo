// Rate card 2026, Phase 5: the homepage "What I do" cards follow the five rate-card categories and show no prices.
//
// The default card text lives in three places that must agree - lib/homepage-service-cards.js (database seed + migration),
// index.html (what shows before the stored cards load) and js/admin/about.js (an empty editor) - and the booking drawer's
// preselect map must know every card's data-bk-source. The one-time migration is run here, as the exact SQL database.js runs,
// against throwaway in-memory databases (never the live settings).
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3');
const cards = require('../lib/homepage-service-cards');
const sp = require('../lib/service-pricing');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const decode = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');

module.exports = async function ({ check, pub }) {
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const GROUP_LABELS = Object.values(sp.GROUPS);   // the rate card's five categories, in the rate card's order

    // ── The static markup ──
    const html = read('index.html');
    const section = html.slice(html.indexOf('<section class="tm-section tm-services"'), html.indexOf('<!-- ============== ABOUT'));
    const cardRe = /<a [^>]*class="tm-service [^"]*"[^>]*data-bk-source="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    const htmlCards = [];
    for (let m; (m = cardRe.exec(section));) {
        htmlCards.push({
            source: m[1],
            title: decode((m[2].match(/<h3 class="tm-service__title">([\s\S]*?)<\/h3>/) || [])[1] || ''),
            description: decode((m[2].match(/<p class="tm-service__desc">([\s\S]*?)<\/p>/) || [])[1] || ''),
            tag: decode((m[2].match(/<span class="tm-service__tag">([\s\S]*?)<\/span>/) || [])[1] || '')
        });
    }
    check('index.html: five service cards, one per rate-card category', htmlCards.length === 5, `found ${htmlCards.length}`);
    check('index.html: the card titles ARE the five rate-card category names, in the rate card\'s order', same(htmlCards.map(c => c.title), GROUP_LABELS), JSON.stringify(htmlCards.map(c => c.title)));
    check('index.html: card titles and descriptions equal the shipped defaults in lib/homepage-service-cards.js',
        same(htmlCards.map(c => ({ title: c.title, description: c.description })), cards.NEW_DEFAULT_CARDS.map(c => ({ title: c.title, description: c.description }))), JSON.stringify(htmlCards));
    check('index.html: exactly one card carries "Most Booked", and it is Corporate & Events',
        htmlCards.filter(c => c.tag).length === 1 && htmlCards[1].tag === 'Most Booked' && htmlCards[1].title === sp.GROUPS[sp.FEATURED_GROUP], JSON.stringify(htmlCards.map(c => c.tag)));
    check('index.html: the cards say nothing about prices (a client first sees an amount in the quotation)',
        !/R\s?\d|\bZAR\b|\bfrom R\b|per hour|per month|minimum/i.test(htmlCards.map(c => c.title + ' ' + c.description).join(' ')), JSON.stringify(htmlCards));
    check('index.html: every card still opens the booking drawer and tracks the click',
        (section.match(/data-open-drawer="bookingDrawer" data-track="book_now"/g) || []).length === 5);
    check('index.html: five distinct card sources, none left from the old four-card layout',
        new Set(htmlCards.map(c => c.source)).size === 5 && !/service-(standup|mc-host|tv-film|voiceover)/.test(html), JSON.stringify(htmlCards.map(c => c.source)));

    // ── The other two copies of the default text ──
    const aboutSrc = read('js/admin/about.js');
    const m1 = aboutSrc.match(/var DEFAULT_SVC_ITEMS = (\[[\s\S]*?\n\]);/);
    let adminDefaults = null;
    try { adminDefaults = m1 ? new Function('return ' + m1[1])() : null; } catch (e) { adminDefaults = null; }
    check('admin editor defaults (js/admin/about.js) equal the shipped defaults', same(adminDefaults, cards.NEW_DEFAULT_CARDS), JSON.stringify(adminDefaults));
    check('the admin editor pads a stored four-card set with the defaults so the fifth card is editable too',
        /for \(var di = data\.services\.items\.length; di < DEFAULT_SVC_ITEMS\.length; di\+\+\)/.test(aboutSrc));
    check('the database seed uses the shared defaults (a fresh database gets five cards)', /services_items[\s\S]{0,120}NEW_DEFAULT_CARDS/.test(read('database.js')));
    check('the shared defaults are five cards named like the rate card, with no prices in them',
        same(cards.NEW_DEFAULT_CARDS.map(c => c.title), GROUP_LABELS) && cards.NEW_DEFAULT_CARDS.every(c => c.image === '' && !/R\s?\d|\bZAR\b/i.test(c.title + c.description)));

    // ── The booking drawer's source map ──
    const my = read('js/myscript.js');
    const mapSrc = (my.match(/var _bkSourceKeywords = (\{[\s\S]*?\n\s*\});/) || [])[1];
    let sourceMap = null;
    try { sourceMap = mapSrc ? new Function('return ' + mapSrc)() : null; } catch (e) { sourceMap = null; }
    check('booking drawer: the preselect map knows exactly the five card sources (every category has several services, so none preselects)',
        sourceMap && same(Object.keys(sourceMap).sort(), htmlCards.map(c => c.source).sort()) && Object.values(sourceMap).every(k => Array.isArray(k) && k.length === 0), JSON.stringify(sourceMap));

    // ── What the public API serves ──
    const site = await pub('GET', '/api/public/site-content');
    const items = site.body && site.body.services && site.body.services.items;
    check('public site-content: the card items are served as {title, description, image} text with no prices',
        site.status === 200 && Array.isArray(items) && items.length >= 1 && items.every(i => typeof i.title === 'string' && i.title && !/R\s?\d|\bZAR\b/i.test(i.title + ' ' + i.description)), `${site.status} ${JSON.stringify(items)}`);

    // ── The one-time migration, exactly as database.js runs it, on throwaway databases ──
    const opened = [];
    const mem = () => { const d = new sqlite3.Database(':memory:'); opened.push(d); return d; };
    const run = (d, sql, p = []) => new Promise((res, rej) => d.run(sql, p, function (e) { e ? rej(e) : res(this); }));
    const get = (d, sql, p = []) => new Promise((res, rej) => d.get(sql, p, (e, r) => e ? rej(e) : res(r)));
    const fresh = async (stored, { marker = false } = {}) => {
        const d = mem();
        await run(d, 'CREATE TABLE settings (setting_key TEXT PRIMARY KEY, setting_value TEXT)');
        await run(d, 'CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at DATETIME DEFAULT CURRENT_TIMESTAMP)');
        if (stored !== null) await run(d, "INSERT INTO settings (setting_key, setting_value) VALUES ('services_items', ?)", [stored]);
        if (marker) await run(d, 'INSERT INTO schema_migrations (version, name) VALUES (?, ?)', [cards.MIGRATION_VERSION, cards.MIGRATION_NAME]);
        return d;
    };
    const migrate = async (d) => { await run(d, cards.UPDATE_SQL, cards.updateParams()); await run(d, cards.MARKER_SQL); };
    const value = async (d) => { const r = await get(d, "SELECT setting_value v FROM settings WHERE setting_key = 'services_items'"); return r ? r.v : null; };
    const markers = async (d) => (await get(d, 'SELECT COUNT(*) c FROM schema_migrations WHERE version = ?', [cards.MIGRATION_VERSION])).c;
    const OLD = JSON.stringify(cards.OLD_DEFAULT_CARDS), NEW = JSON.stringify(cards.NEW_DEFAULT_CARDS);

    let d = await fresh(OLD);
    await migrate(d);
    check('migration: the four shipped cards become the five rate-card cards, and the marker is recorded', await value(d) === NEW && await markers(d) === 1);
    await migrate(d);
    check('migration: running it again changes nothing (idempotent)', await value(d) === NEW && await markers(d) === 1);

    const edited = JSON.stringify(cards.OLD_DEFAULT_CARDS.map((c, i) => i === 0 ? { ...c, title: 'Comedy Nights' } : c));
    d = await fresh(edited);
    await migrate(d);
    check('migration: cards the owner edited are NEVER overwritten (the marker is still recorded so this is decided once)', await value(d) === edited && await markers(d) === 1);

    const savedFromAdmin = JSON.stringify(cards.OLD_DEFAULT_CARDS.map(c => ({ ...c, description: c.description.replace(/&/g, '&amp;') })));
    d = await fresh(savedFromAdmin);
    await migrate(d);
    check('migration: a set saved through the admin editor (entity-encoded) counts as the owner\'s and is left alone', await value(d) === savedFromAdmin);

    d = await fresh(OLD, { marker: true });
    await migrate(d);
    check('migration: once the marker exists it never runs again (a deliberate edit back to the old text is not undone)', await value(d) === OLD);

    d = await fresh(null);
    await migrate(d);
    check('migration: no stored setting means nothing is created (a fresh database is seeded by database.js instead)', await value(d) === null && await markers(d) === 1);

    await Promise.all(opened.map(x => new Promise(res => x.close(() => res()))));
};
