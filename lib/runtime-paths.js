// Runtime storage locations — Phase 3 of the housekeeping effort (HOUSEKEEPING-NOTES.md),
// relocated here in Phase 5 since upload-handling routes being split into routes/ need
// uploadsWriteDir(). Originally used __dirname (of server.js/app.js, sitting at the project root)
// to anchor these paths — __dirname inside lib/ would instead resolve one level too deep, so this
// anchors off path.resolve(__dirname, '..') instead, matching the same one-level-deep assumption
// database/repositories/*.js already rely on (their `require('../../database')`).
//
// Three separate gitignored folders at the project root (2026-09-28: dropped the
// thabiso-mhlongo-runtime-data/ wrapper that used to hold docs/ and backups/ — one extra layer of
// nesting with no purpose once uploads moved out of it, see below): DOCS_PATH -> docs/ (generated
// PDFs: invoices, quotes, contracts, attachments — this was already docs/'s legacy pre-Phase-3
// location, so nothing had to move), BACKUPS_PATH -> backups/ (DB snapshots), UPLOADS_PATH ->
// images/ (2026-09-28: admin uploads - team, gallery, testimonials, ... - sit next to the site's own
// images, one place to look, same /images/<section>/<file> URLs as before). The one upload that
// must never be committed, expense receipts, is gitignored on its own (images/receipts/) rather than
// the whole images/ tree. Override any of the three in .env for a different deployment layout — same
// pattern database.js already uses for DB_PATH. app.js's deny-list middleware blocks direct HTTP
// access to docs/ and backups/ regardless of where they point.
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DOCS_PATH = process.env.DOCS_PATH ? path.resolve(process.env.DOCS_PATH) : path.join(PROJECT_ROOT, 'docs');
const UPLOADS_PATH = process.env.UPLOADS_PATH ? path.resolve(process.env.UPLOADS_PATH) : path.join(PROJECT_ROOT, 'images');
const BACKUPS_PATH = process.env.BACKUPS_PATH ? path.resolve(process.env.BACKUPS_PATH) : path.join(PROJECT_ROOT, 'backups');
// Kept as its own name (rather than just reusing DOCS_PATH) for callers that want "the in-repo docs/
// folder specifically" even if DOCS_PATH is overridden elsewhere — resolveDocsPath()'s fallback below.
const LEGACY_DOCS_DIR = path.join(PROJECT_ROOT, 'docs');

function ensureDir(dir) { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); return dir; }

// Destination for a brand-new file under docs/<...segments>.
function docsWriteDir(...segments) { return ensureDir(path.join(DOCS_PATH, ...segments)); }
// Resolves an existing docs/<...segments> path for reading: DOCS_PATH first, then the plain in-repo
// docs/ folder (a no-op unless DOCS_PATH is overridden — with the default, the two are the same path).
function resolveDocsPath(...segments) {
    const fresh = path.join(DOCS_PATH, ...segments);
    return fs.existsSync(fresh) ? fresh : path.join(LEGACY_DOCS_DIR, ...segments);
}
// Destination for a brand-new file under the images/uploads tree.
function uploadsWriteDir(...segments) { return ensureDir(path.join(UPLOADS_PATH, ...segments)); }

module.exports = {
    PROJECT_ROOT,
    DOCS_PATH, UPLOADS_PATH, BACKUPS_PATH, LEGACY_DOCS_DIR,
    ensureDir, docsWriteDir, resolveDocsPath, uploadsWriteDir,
};
