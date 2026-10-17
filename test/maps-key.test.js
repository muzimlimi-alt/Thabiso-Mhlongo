// Google key hygiene + access control for location search (rewritten in the 2026-10 Places audit).
// Since that audit there is ONE Google key, GOOGLE_MAPS_API_KEY, used only server-side by lib/places.js: the admin's
// browser-side Maps script and its browser key (GET /api/admin/maps-config, GOOGLE_MAPS_BROWSER_KEY) were removed.
// This test guards: no Google key in anything we serve or commit, no Maps JavaScript loader left on the admin page,
// the admin Places routes require a signed-in admin, and the public routes validate input before calling Google.
// None of these requests reach Google: each is rejected or short-circuited first (no key needed, no cost).
const fs = require('fs');
const path = require('path');
const support = require('./support');

const ROOT = path.resolve(__dirname, '..');
const KEY_RE = /AIza[0-9A-Za-z_-]{35}/;          // the shape of every Google API key
const SKIP = new Set(['node_modules', '.git', 'TBC', 'thabiso-mhlongo-runtime-data', '_quarantine', 'images', 'test-docs', 'test-uploads']);

function* walk(dir, exts) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (SKIP.has(e.name)) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) yield* walk(p, exts);
        else if (exts.some(x => e.name.endsWith(x))) yield p;
    }
}

module.exports = async function ({ check, api, pub }) {
    // ── admin Places routes: signed-in admins only ──
    for (const url of ['/api/admin/places/autocomplete?input=Sandton', '/api/admin/places/details?place_id=ChIJabcdefghij', '/api/admin/places/status']) {
        const anon = await pub('GET', url);
        check(`${url.split('?')[0]} requires a signed-in admin (401 anonymously)`, anon.status === 401, `status=${anon.status}`);
    }
    const short = await api('GET', '/api/admin/places/autocomplete?input=a');
    check('admin autocomplete: a 1-character search returns no predictions without calling Google', short.status === 200 && Array.isArray(short.body.predictions) && short.body.predictions.length === 0, JSON.stringify(short.body));
    const badId = await api('GET', '/api/admin/places/details?place_id=' + encodeURIComponent('x&key=y'));
    check('admin details: a malformed place id is rejected (400 INVALID_INPUT) before calling Google', badId.status === 400 && badId.body.error && badId.body.error.code === 'INVALID_INPUT', JSON.stringify(badId.body));

    // ── public routes: same validation, unchanged response shapes ──
    const pShort = await pub('GET', '/api/public/places/autocomplete?input=a');
    check('public autocomplete keeps its { predictions: [] } shape for a too-short search', pShort.status === 200 && Array.isArray(pShort.body.predictions), JSON.stringify(pShort.body));
    const pNoId = await pub('GET', '/api/public/places/details');
    check('public details without place_id -> 400', pNoId.status === 400, `status=${pNoId.status}`);
    const pBad = await pub('GET', '/api/public/places/details?place_id=' + encodeURIComponent('../../x'));
    check('public details with a malformed place id -> 400 (it is no longer pasted into Google\'s URL unencoded)', pBad.status === 400, `status=${pBad.status}`);

    // ── the retired browser-key endpoint is gone ──
    const old = await api('GET', '/api/admin/maps-config');
    check('GET /api/admin/maps-config no longer exists (no key is handed to any browser)', old.status === 404, `status=${old.status}`);

    // ── the served admin page carries no key and no Maps JavaScript loader ──
    const adminHtml = await (await fetch(`${support.BASE}/admin.html`)).text();
    check('the admin.html the server actually serves contains no Google API key', !KEY_RE.test(adminHtml), 'a key-shaped string is present in the served admin.html');
    check('...and no longer loads the Google Maps JavaScript API', !/maps\.googleapis\.com\/maps\/api\/js/.test(adminHtml) && !/window\.loadGoogleMaps\s*=/.test(adminHtml), '');
    check('...but loads the shared location-search client before the admin helper', /js\/shared\/places-client\.js[\s\S]*js\/admin\/places-autocomplete\.js/.test(adminHtml), '');

    // ── nothing key-shaped in tracked source, docs or the env template ──
    const hits = [];
    const scan = (dir, exts) => { for (const f of walk(dir, exts)) { if (KEY_RE.test(fs.readFileSync(f, 'utf8'))) hits.push(path.relative(ROOT, f)); } };
    scan(ROOT, ['.html']);                                        // pages
    for (const d of ['js', 'routes', 'lib', 'middleware', 'database', 'css', 'scripts', 'docs-internal']) {
        if (fs.existsSync(path.join(ROOT, d))) scan(path.join(ROOT, d), ['.js', '.html', '.md', '.css', '.json']);
    }
    for (const f of ['app.js', 'server.js', 'database.js', '.env.example', 'README.md', 'ADMIN_GUIDE.md']) {
        const p = path.join(ROOT, f);
        if (fs.existsSync(p) && KEY_RE.test(fs.readFileSync(p, 'utf8'))) hits.push(f);
    }
    check('no Google API key is written into any page, script, doc or the env template', hits.length === 0, hits.join(', '));
    const example = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
    check('.env.example documents GOOGLE_MAPS_API_KEY (placeholder only) and the "Places API (New)" setup', /^GOOGLE_MAPS_API_KEY=your_/m.test(example) && /Places API \(New\)/.test(example), '');
};
