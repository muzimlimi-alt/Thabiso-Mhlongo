// admin.html, sent with the admin's chosen loading screen already written into it (lib/preloader-choice.js).
//
// Why this exists: admin.html used to be served straight off disk by express.static, so the only way it could learn which loading
// screen to show was this browser's own cached copy of the answer - which meant every administrator except the one who saved the change
// kept seeing the old screen until their SECOND page load (the first refreshed the cache, the next one used it). Filling the page on the
// way out removes that lag: the very next load of the admin, on any machine, shows the screen that is actually set.
//
// This is the homepage's arrangement (lib/homepage-render.js) cut down to the one token the admin page has: the admin page has no other
// admin-editable content in its markup - everything else it shows is fetched after it loads.
//
// Rules, the same ones the homepage fill follows:
//   - never breaks the page: any error, or a database slower than FILL_TIMEOUT_MS, serves the file unchanged, exactly as before;
//   - admin.html stays a valid page on its own, so serving it plainly only costs the one-load lag described above.
const fs = require('fs');
const path = require('path');
const { fillPreloaderToken } = require('./preloader-choice');

const ADMIN_FILE = path.join(__dirname, '..', 'admin.html');
const FILL_TIMEOUT_MS = 1500;

// admin.html is ~1.3 MB, so neither the read nor the fill may happen per request: the file is re-read only when it changes on disk, and
// the filled copy is rebuilt only when the file or the chosen screen changes. In the steady state a request costs one settings query.
let cache = { mtimeMs: -1, html: null };
let last = { key: null, html: null };

function template() {
    const st = fs.statSync(ADMIN_FILE);
    if (cache.html === null || cache.mtimeMs !== st.mtimeMs) cache = { mtimeMs: st.mtimeMs, html: fs.readFileSync(ADMIN_FILE, 'utf8') };
    return cache.html;
}

async function renderAdminPage() {
    const tpl = template();
    try {
        const content = require('./homepage-content');   // lazy, so requiring this file does not open the database
        const site = await Promise.race([
            content.getSiteContent().then((v) => v, () => null),
            new Promise((resolve) => setTimeout(() => resolve(null), FILL_TIMEOUT_MS).unref())
        ]);
        if (!site || !site.preloader) return tpl;
        const key = cache.mtimeMs + '|' + JSON.stringify(site.preloader);
        if (last.key !== key) {
            const filled = fillPreloaderToken(tpl, site.preloader);
            if (filled === null) return tpl;             // the page no longer has the token
            last = { key, html: filled };
        }
        return last.html;
    } catch (e) {
        console.error('[admin page] preloader fill failed, serving the plain page:', e && e.message);
        return tpl;
    }
}

module.exports = { renderAdminPage, ADMIN_FILE };
