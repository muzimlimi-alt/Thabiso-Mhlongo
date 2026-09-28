// Where admin-uploaded images live. They belong in the project's images/ folder - one place to look, next to the
// site's other images, served at the same /images/<section>/<file> URLs - not in a separate runtime-data/uploads
// folder. Expense receipts are the one upload that must stay out of the public repo, so images/receipts/ is gitignored.
// (The test server overrides UPLOADS_PATH to a throwaway folder, so this checks the DEFAULT in a fresh process and
// then that an upload is stored under its section folder and served back over HTTP.)
const path = require('path');
const { execFileSync } = require('child_process');
const support = require('./support');

const ROOT = path.resolve(__dirname, '..');
const gitIgnored = (p) => {
    try { execFileSync('git', ['check-ignore', '-q', p], { cwd: ROOT, stdio: 'ignore' }); return true; }
    catch (e) { return e.status === 1 ? false : null; }       // null: git unavailable / not a repo - can't tell
};

module.exports = async function ({ check, api, upload, makeTestPng }) {
    // ── the default location ──
    const printed = execFileSync(process.execPath, ['-e', "process.stdout.write(require('./lib/runtime-paths').UPLOADS_PATH)"],
        { cwd: ROOT, env: Object.assign({}, process.env, { UPLOADS_PATH: '' }) }).toString();
    check('with no UPLOADS_PATH override, uploads go to the project images/ folder', path.resolve(printed) === path.join(ROOT, 'images'), printed);

    // ── the default DOCS_PATH / BACKUPS_PATH locations (no thabiso-mhlongo-runtime-data/ wrapper) ──
    const others = execFileSync(process.execPath, ['-e', "const p=require('./lib/runtime-paths'); process.stdout.write(JSON.stringify({docs:p.DOCS_PATH,backups:p.BACKUPS_PATH}))"],
        { cwd: ROOT, env: Object.assign({}, process.env, { DOCS_PATH: '', BACKUPS_PATH: '' }) }).toString();
    const { docs, backups } = JSON.parse(others);
    check('with no DOCS_PATH override, generated PDFs go to the project docs/ folder', path.resolve(docs) === path.join(ROOT, 'docs'), docs);
    check('with no BACKUPS_PATH override, DB snapshots go to the project backups/ folder (not a runtime-data wrapper)', path.resolve(backups) === path.join(ROOT, 'backups'), backups);

    // ── git: receipts (financial documents) never enter the public repo; other uploads are ordinary site content ──
    const receipts = gitIgnored('images/receipts/receipt-1.pdf'), team = gitIgnored('images/team/1-photo.png');
    const docsIgnored = gitIgnored('docs/invoices/x.pdf'), backupsIgnored = gitIgnored('backups/x.sqlite');
    check('images/receipts/ is gitignored (expense receipts must not be committed)', receipts === null || receipts === true, String(receipts));
    check('images/team/ is not gitignored (team photos are public site content)', team === null || team === false, String(team));
    check('docs/ (generated PDFs) stays gitignored', docsIgnored === null || docsIgnored === true, String(docsIgnored));
    check('backups/ (DB snapshots) stays gitignored', backupsIgnored === null || backupsIgnored === true, String(backupsIgnored));

    // ── a team photo is stored under its section folder, referenced as images/team/<file>, and served at that URL ──
    const png = makeTestPng(20, 20);
    const created = await upload('POST', '/api/admin/team', { name: 'Uploads Location Test', role: 'Tester', section: 'team' }, { buffer: png, filename: 'where-am-i.png', contentType: 'image/png' }, 'file');
    check('team member with a photo: 200', created.status === 200 && created.body && created.body.success, JSON.stringify(created.body));
    const imagePath = created.body && created.body.imagePath;
    check('the photo is referenced as images/team/<timestamped file>', /^images\/team\/\d{13}-where-am-i\.png$/.test(imagePath || ''), String(imagePath));
    const served = await fetch(`${support.BASE}/${imagePath}`);
    check('...and served back at /images/team/<file> as an image', served.status === 200 && /image\/png/.test(served.headers.get('content-type') || ''), `${served.status} ${served.headers.get('content-type')}`);
    if (created.body && created.body.id) await api('DELETE', `/api/admin/team/${created.body.id}`);   // leave no test member behind

    // ── receipts keep their /uploads/receipts/<file> URL ──
    const rc = await upload('POST', '/api/admin/expenses/upload-receipt', {}, { buffer: png, filename: 'receipt.png', contentType: 'image/png' }, 'receipt');
    check('receipt upload: 200 with a /uploads/receipts/ URL', rc.status === 200 && /^\/uploads\/receipts\/receipt-\d+\.png$/.test((rc.body && rc.body.url) || ''), JSON.stringify(rc.body));
    const rs = await fetch(`${support.BASE}${rc.body && rc.body.url}`);
    check('...and that URL serves the file', rs.status === 200, String(rs.status));
};
