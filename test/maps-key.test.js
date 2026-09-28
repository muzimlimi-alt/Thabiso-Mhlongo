// The Google Maps BROWSER key (admin Places autocomplete / events map) must live in .env, not in any tracked
// file - admin.html is a public static file and this repository is public. The admin gets the key from
// GET /api/admin/maps-config, which requires a signed-in admin. This test guards both halves: the endpoint's
// access control, and that no Google API key is written into anything we serve or commit.
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
    // ── access control ──
    const anon = await pub('GET', '/api/admin/maps-config');
    check('maps-config requires a signed-in admin (401 anonymously)', anon.status === 401, `status=${anon.status}`);
    check('...and does not leak a key in the 401 body', !KEY_RE.test(JSON.stringify(anon.body || {})), JSON.stringify(anon.body));
    const authed = await api('GET', '/api/admin/maps-config');
    check('a signed-in admin gets { success: true, key: <string> }', authed.status === 200 && authed.body && authed.body.success === true && typeof authed.body.key === 'string', JSON.stringify(authed.body).replace(KEY_RE, 'AIza…'));

    // ── the served admin page carries no key ──
    const adminHtml = await (await fetch(`${support.BASE}/admin.html`)).text();
    check('the admin.html the server actually serves contains no Google API key', !KEY_RE.test(adminHtml), 'a key-shaped string is present in the served admin.html');
    check('...and no maps/api/js?key=<value> URL with a literal key (the loader appends it at runtime)', !/maps\/api\/js\?key=[A-Za-z0-9_-]{10,}/.test(adminHtml), '');
    check('...but does define the loader that fetches it', /window\.loadGoogleMaps\s*=/.test(adminHtml) && /\/api\/admin\/maps-config/.test(adminHtml), '');

    // ── nothing key-shaped in tracked source, docs or the env template ──
    const hits = [];
    const scan = (dir, exts) => { for (const f of walk(dir, exts)) { if (KEY_RE.test(fs.readFileSync(f, 'utf8'))) hits.push(path.relative(ROOT, f)); } };
    scan(ROOT, ['.html']);                                        // pages
    for (const d of ['js', 'routes', 'lib', 'middleware', 'database', 'css', 'scripts', 'docs-internal']) scan(path.join(ROOT, d), ['.js', '.html', '.md', '.css', '.json']);
    for (const f of ['app.js', 'server.js', 'database.js', '.env.example', 'README.md', 'ADMIN_GUIDE.md']) {
        const p = path.join(ROOT, f);
        if (fs.existsSync(p) && KEY_RE.test(fs.readFileSync(p, 'utf8'))) hits.push(f);
    }
    check('no Google API key is written into any page, script, doc or the env template', hits.length === 0, hits.join(', '));
    const example = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
    check('.env.example documents GOOGLE_MAPS_BROWSER_KEY (placeholder only)', /^GOOGLE_MAPS_BROWSER_KEY=your_/m.test(example), '');
};
