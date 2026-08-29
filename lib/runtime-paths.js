// Runtime storage locations — Phase 3 of the housekeeping effort (HOUSEKEEPING-NOTES.md),
// relocated here in Phase 5 since upload-handling routes being split into routes/ need
// uploadsWriteDir(). Originally used __dirname (of server.js/app.js, sitting at the project root)
// to anchor these paths — __dirname inside lib/ would instead resolve one level too deep, so this
// anchors off path.resolve(__dirname, '..') instead, matching the same one-level-deep assumption
// database/repositories/*.js already rely on (their `require('../../database')`).
//
// Generated PDFs and uploaded images used to live inside the repo (docs/, images/), which meant
// they could accidentally re-enter git. DOCS_PATH/UPLOADS_PATH/BACKUPS_PATH default to a sibling
// directory OUTSIDE the repo; override any of them in .env for a different deployment layout.
// Same pattern database.js already uses for DB_PATH.
//
// Files written before this config existed remain at their old in-repo location — nothing here
// migrates them. docs/ reads go through resolveDocsPath() below, which tries the new external
// location first and falls back to the legacy in-repo one if not found there. images/uploads have
// no equivalent internal fs-read resolver: every read of that tree happens over HTTP (a browser or
// email client fetching a URL), so the /images and /uploads static mounts (app.js) — new location
// first, falling through to the blanket static server for the legacy in-repo copy — are the only
// read-side piece needed; there's no server-side fs.readFile of an uploaded image anywhere.
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const RUNTIME_DATA_DEFAULT_ROOT = path.resolve(PROJECT_ROOT, '..', 'thabiso-mhlongo-runtime-data');
const DOCS_PATH = process.env.DOCS_PATH ? path.resolve(process.env.DOCS_PATH) : path.join(RUNTIME_DATA_DEFAULT_ROOT, 'docs');
const UPLOADS_PATH = process.env.UPLOADS_PATH ? path.resolve(process.env.UPLOADS_PATH) : path.join(RUNTIME_DATA_DEFAULT_ROOT, 'uploads');
const BACKUPS_PATH = process.env.BACKUPS_PATH ? path.resolve(process.env.BACKUPS_PATH) : path.join(RUNTIME_DATA_DEFAULT_ROOT, 'backups');
const LEGACY_DOCS_DIR = path.join(PROJECT_ROOT, 'docs');

function ensureDir(dir) { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); return dir; }

// Destination for a brand-new file under docs/<...segments> — always the new external location.
function docsWriteDir(...segments) { return ensureDir(path.join(DOCS_PATH, ...segments)); }
// Resolves an existing docs/<...segments> path for reading: new location first, then the
// pre-Phase-3 in-repo docs/ folder, since files already there were never moved.
function resolveDocsPath(...segments) {
    const fresh = path.join(DOCS_PATH, ...segments);
    return fs.existsSync(fresh) ? fresh : path.join(LEGACY_DOCS_DIR, ...segments);
}
// Destination for a brand-new file under the images/uploads tree — always the new external
// location (see the images/uploads read-side note above for why there's no matching resolver).
function uploadsWriteDir(...segments) { return ensureDir(path.join(UPLOADS_PATH, ...segments)); }

module.exports = {
    DOCS_PATH, UPLOADS_PATH, BACKUPS_PATH, LEGACY_DOCS_DIR,
    ensureDir, docsWriteDir, resolveDocsPath, uploadsWriteDir,
};
