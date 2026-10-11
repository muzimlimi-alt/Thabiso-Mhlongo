// Career highlights text is stored entity-encoded ONCE (app.js's deepEscapeBody) and shown as HTML on the public
// page. The admin editor used to load that stored text back into its form boxes, so every edit stacked another
// layer - the live page showed "&amp;quot;Celeste &amp;amp; Da Big Dudes&amp;quot;". Guards three things: the shared
// normaliser, the save routes (a save is idempotent even for a stale client that still sends encoded text), and the
// boot-time repair of rows that were already affected.
const sqlite3 = require('sqlite3');
const support = require('./support');
const { normalizeEncodedText } = require('../lib/html-sanitize');

const rw = new sqlite3.Database(support.TEST_DB);
const run = (sql, params = []) => new Promise((res, rej) => rw.run(sql, params, function (e) { e ? rej(e) : res(this); }));

// The encoding deepEscapeBody applies to every request-body string.
const enc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');

const RAW_TITLE = 'Celeste & "Da Big Dudes"';
const RAW_DESC = '"Celeste & Da Big Dudes" isn\'t <b>small</b>.\nSecond line, Mr & Miss 2015';

module.exports = async function ({ check, api, pub, one, sleep }) {
    const ONCE_TITLE = enc(RAW_TITLE), ONCE_DESC = enc(RAW_DESC);

    // ── the normaliser ──
    check('normalizeEncodedText: raw text is encoded once', normalizeEncodedText(RAW_DESC) === ONCE_DESC, normalizeEncodedText(RAW_DESC));
    check('...a single-layer value is left alone', normalizeEncodedText(ONCE_DESC) === ONCE_DESC, normalizeEncodedText(ONCE_DESC));
    check('...stacked layers (the live "&amp;amp;quot;" case) collapse to one', normalizeEncodedText(enc(enc(ONCE_DESC))) === ONCE_DESC, normalizeEncodedText(enc(enc(ONCE_DESC))));
    check('...six layers (a real row in the DB copy) collapse to one', normalizeEncodedText('Mr &amp;amp;amp;amp;amp;amp; Miss') === 'Mr &amp; Miss', normalizeEncodedText('Mr &amp;amp;amp;amp;amp;amp; Miss'));
    check('...it is idempotent', normalizeEncodedText(normalizeEncodedText(enc(enc(RAW_DESC)))) === ONCE_DESC, '');
    check('...plain text, empty string and null pass through', normalizeEncodedText('Plain text 2014') === 'Plain text 2014' && normalizeEncodedText('') === '' && normalizeEncodedText(null) === null, '');

    // ── save routes ──
    const created = await api('POST', '/api/admin/highlights', { year: '2024', title: RAW_TITLE, badge: '', location: 'Jozi & Co', description: RAW_DESC, display_order: 0 });
    check('POST /api/admin/highlights creates the row', created.status === 200 && created.body && created.body.success, JSON.stringify(created.body));
    const id = created.body && created.body.id;
    const getRow = async () => (await pub('GET', '/api/public/highlights')).body.find(r => r.id === id);

    let row = await getRow();
    check('the row is stored with exactly one encoding layer', !!row && row.title === ONCE_TITLE && row.description === ONCE_DESC && row.location === 'Jozi &amp; Co', JSON.stringify(row));

    // What the OLD editor did: load the stored (encoded) text into the boxes and save it unchanged.
    const stale = await api('PUT', `/api/admin/highlights/${id}`, { year: '2024', title: row.title, badge: row.badge || '', location: row.location, description: row.description, display_order: 0 });
    check('PUT with the stored text echoed back (a stale client) succeeds', stale.status === 200, JSON.stringify(stale.body));
    row = await getRow();
    check('...and adds no encoding layer', row.title === ONCE_TITLE && row.description === ONCE_DESC && row.location === 'Jozi &amp; Co', JSON.stringify(row));

    // What the NEW editor does: send the text as typed.
    const typed = await api('PUT', `/api/admin/highlights/${id}`, { year: '2024', title: RAW_TITLE + ' II', badge: '', location: 'Jozi & Co', description: RAW_DESC, display_order: 0 });
    row = await getRow();
    check('PUT with text as typed (what the fixed editor sends) stores one layer', typed.status === 200 && row.title === enc(RAW_TITLE + ' II') && row.description === ONCE_DESC, JSON.stringify(row));

    // A client that sends an already-stacked value (three layers) is collapsed too.
    await api('PUT', `/api/admin/highlights/${id}`, { year: '2024', title: enc(enc(ONCE_TITLE)), badge: '', location: 'Jozi', description: enc(enc(ONCE_DESC)), display_order: 0 });
    row = await getRow();
    check('PUT with stacked layers collapses them to one', row.title === ONCE_TITLE && row.description === ONCE_DESC, JSON.stringify(row));

    // ── boot-time repair of rows already affected ──
    const legacy = await run("INSERT INTO career_highlights (year, title, badge, location, description) VALUES (?, ?, ?, ?, ?)",
        ['2025', enc(enc(ONCE_TITLE)), '', 'Nationwide', enc(enc(ONCE_DESC))]);
    const clean = await run("INSERT INTO career_highlights (year, title, badge, location, description) VALUES (?, ?, ?, ?, ?)",
        ['2023', ONCE_TITLE, '', 'Jozi &amp; Co', ONCE_DESC]);
    await support.restart();

    let legacyRow = null;
    for (let i = 0; i < 20; i++) {                       // the repair runs asynchronously during boot - poll, never sleep a fixed time
        legacyRow = await one('SELECT title, description FROM career_highlights WHERE id = ?', [legacy.lastID]);
        if (legacyRow && legacyRow.description === ONCE_DESC) break;
        await sleep(250);
    }
    check('boot repair collapses a stacked row to one layer', !!legacyRow && legacyRow.title === ONCE_TITLE && legacyRow.description === ONCE_DESC, JSON.stringify(legacyRow));
    const cleanRow = await one('SELECT title, location, description FROM career_highlights WHERE id = ?', [clean.lastID]);
    check('...and leaves an already-clean row untouched', !!cleanRow && cleanRow.title === ONCE_TITLE && cleanRow.location === 'Jozi &amp; Co' && cleanRow.description === ONCE_DESC, JSON.stringify(cleanRow));
    check('...logging which row it repaired', support.getChildLog().includes(`career_highlights id ${legacy.lastID}: collapsed stacked HTML-entity encoding`), '');
    check('...and not the clean one', !support.getChildLog().includes(`career_highlights id ${clean.lastID}:`), '');

    // ── tidy up (the DB is a throwaway copy, but later suites count highlights) ──
    for (const rid of [id, legacy.lastID, clean.lastID]) await run('DELETE FROM career_highlights WHERE id = ?', [rid]);
    rw.close();
};
