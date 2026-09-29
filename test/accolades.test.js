// Accolades & Recognition — the full lifecycle through the real API, against the isolated test DB:
// create -> validate -> upload media -> publish -> reorder -> feature -> edit -> bulk -> unpublish ->
// delete, plus duplicates, RBAC, audit logging and the one invariant everything hangs off: the public
// API (what index.html renders) is exactly the admin list filtered to is_public, in the same order,
// with only the published fields. Both come from lib/accolades.js.
const sqlite3 = require('sqlite3');
const support = require('./support');

// Direct handle to the isolated TEST_DB — for rows the API refuses to create (unknown status, unsafe
// links), which the public projection must still handle safely.
const rw = new sqlite3.Database(support.TEST_DB);
const run = (sql, params = []) => new Promise((res, rej) => rw.run(sql, params, function (e) { e ? rej(e) : res(this); }));

const P = 'ACL-TEST ';   // every row this suite creates starts with this, so cleanup can find it
const Y = new Date().getFullYear();
const MIN_PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj '
    + '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n', 'latin1');

module.exports = async function ({ check, api, pub, upload, loginAs, q, one, makeTestPng, BASE }) {
    const adminView = async () => (await api('GET', '/api/admin/accolades')).body;
    const publicList = async () => (await pub('GET', '/api/public/accolades')).body;
    const mine = list => (list || []).filter(a => (a.title || '').startsWith(P));
    const byTitle = (list, t) => (list || []).find(a => a.title === P + t);
    const create = body => api('POST', '/api/admin/accolades', Object.assign({ category: 'win', year: Y - 1 }, body, { title: P + body.title }));

    async function assertParity(label) {
        const admin = await adminView();
        const pubs = await publicList();
        const expected = admin.accolades.filter(a => a.is_public).map(a => a.id);
        check(`${label}: public list == admin list filtered to is_public, same order`,
            JSON.stringify(pubs.map(a => a.id)) === JSON.stringify(expected),
            `public=${JSON.stringify(pubs.map(a => a.id))} admin=${JSON.stringify(expected)}`);
        const positions = admin.accolades.filter(a => a.is_public).map(a => a.public_position);
        check(`${label}: public_position is 1..n in website order`,
            JSON.stringify(positions) === JSON.stringify(expected.map((_, i) => i + 1)), JSON.stringify(positions));
        return { admin, pubs };
    }

    // ── Auth ──
    const anonCalls = [
        ['GET', '/api/admin/accolades'], ['POST', '/api/admin/accolades', { title: 'x', category: 'win', year: Y }],
        ['PUT', '/api/admin/accolades/1', { title: 'x' }], ['DELETE', '/api/admin/accolades/1'],
        ['PUT', '/api/admin/accolades/reorder', { order: [1] }], ['POST', '/api/admin/accolades/bulk', { action: 'publish', ids: [1] }]
    ];
    for (const [m, u, b] of anonCalls) {
        const r = await pub(m, u, b);
        check(`anonymous ${m} ${u} is refused (401)`, r.status === 401, `status=${r.status}`);
    }

    // ── Shape ──
    const first = await adminView();
    check('admin API returns { accolades, section_visible, public_fields, categories, limits }',
        first && Array.isArray(first.accolades) && typeof first.section_visible === 'boolean' && Array.isArray(first.public_fields)
        && JSON.stringify(first.categories) === JSON.stringify(['win', 'nomination', 'accolade']) && first.limits && first.limits.title === 160,
        JSON.stringify(Object.keys(first || {})));
    check('published fields include the display fields and exclude internal ones',
        ['title', 'category', 'year', 'organisation', 'result', 'description', 'image', 'organisation_logo', 'certificate_file', 'external_url', 'source_url', 'featured'].every(k => first.public_fields.includes(k))
        && !['status', 'display_order', 'created_by', 'updated_by', 'created_at', 'updated_at'].some(k => first.public_fields.includes(k)),
        JSON.stringify(first.public_fields));
    const cacheRes = await fetch(`${BASE}/api/public/accolades`);
    check('public API revalidates on every load (Cache-Control: no-cache)', /no-cache/.test(cacheRes.headers.get('cache-control') || ''), cacheRes.headers.get('cache-control'));
    const sections = (await pub('GET', '/api/public/site-content')).body.sections;
    check('Website Sections knows the accolades section (visible by default)', sections && sections.accolades === true, JSON.stringify(sections));
    await assertParity('baseline');

    // ── Validation: every bad input is a 400 with a message, and nothing is stored ──
    const bad = [
        ['missing title', { title: undefined, category: 'win', year: Y }],
        ['whitespace title', { title: '   ', category: 'win', year: Y }],
        ['missing category', { title: P + 'v1', year: Y }],
        ['unknown category', { title: P + 'v2', category: 'trophy', year: Y }],
        ['missing year', { title: P + 'v3', category: 'win' }],
        ['non-numeric year', { title: P + 'v4', category: 'win', year: '20x5' }],
        ['fractional year', { title: P + 'v5', category: 'win', year: 2020.5 }],
        ['year too early', { title: P + 'v6', category: 'win', year: 1800 }],
        ['year too far ahead', { title: P + 'v7', category: 'win', year: Y + 2 }],
        ['impossible date', { title: P + 'v8', category: 'win', year: Y - 1, achievement_date: `${Y - 1}-02-30` }],
        ['non-ISO date', { title: P + 'v9', category: 'win', year: Y - 1, achievement_date: '12/03/2025' }],
        ['date years away from the year', { title: P + 'v10', category: 'win', year: Y - 1, achievement_date: `${Y - 6}-05-01` }],
        ['javascript: external URL', { title: P + 'v11', category: 'win', year: Y, external_url: 'javascript:alert(1)' }],
        ['ftp source URL', { title: P + 'v12', category: 'win', year: Y, source_url: 'ftp://example.com/file' }],
        ['over-long URL', { title: P + 'v13', category: 'win', year: Y, external_url: 'https://example.com/' + 'a'.repeat(500) }],
        ['title over 160 characters', { title: P + 'x'.repeat(160), category: 'win', year: Y }],
        ['description over 2000 characters', { title: P + 'v14', category: 'win', year: Y, description: 'd'.repeat(2001) }],
        ['path-traversal image', { title: P + 'v15', category: 'win', year: Y, image: 'images/accolades/../../database.sqlite' }],
        ['image from another section', { title: P + 'v16', category: 'win', year: Y, image: 'images/gallery/photo.png' }],
        ['remote image URL', { title: P + 'v17', category: 'win', year: Y, organisation_logo: 'https://evil.example/logo.png' }],
        ['executable certificate', { title: P + 'v18', category: 'win', year: Y, certificate_file: 'images/accolades/cert.exe' }],
        ['well-formed but missing file', { title: P + 'v19', category: 'win', year: Y, image: 'images/accolades/does-not-exist.png' }],
        ['unknown status', { title: P + 'v20', category: 'win', year: Y, status: 'published' }],
        ['non-boolean featured', { title: P + 'v21', category: 'win', year: Y, featured: 'maybe' }],
        ['negative display order', { title: P + 'v22', category: 'win', year: Y, display_order: -1 }],
        ['non-numeric display order', { title: P + 'v23', category: 'win', year: Y, display_order: 'first' }],
        ['title given as an object', { title: { $gt: '' }, category: 'win', year: Y }]
    ];
    for (const [label, body] of bad) {
        const r = await api('POST', '/api/admin/accolades', body);
        check(`validation: ${label} -> 400 with a message`, r.status === 400 && r.body && r.body.success === false && typeof r.body.message === 'string' && r.body.message.length > 5,
            `${r.status} ${JSON.stringify(r.body)}`);
    }
    const ghosts = mine((await adminView()).accolades);
    check('rejected creates left nothing behind', ghosts.length === 0, JSON.stringify(ghosts.map(a => a.title)));

    // ── Media: the shared /upload route, accolades folder, PDF allowed only here ──
    const png = makeTestPng(40, 30);
    const imgUp = await upload('POST', '/upload', { section: 'accolades' }, { buffer: png, filename: 'award photo.png', contentType: 'image/png' }, 'file');
    check('upload an achievement image -> images/accolades/…', imgUp.status === 200 && imgUp.body.success && /^images\/accolades\/\d{13}-award_photo\.png$/.test(imgUp.body.filePath), JSON.stringify(imgUp.body));
    const logoUp = await upload('POST', '/upload', { section: 'accolades' }, { buffer: png, filename: 'org-logo.png', contentType: 'image/png' }, 'file');
    check('upload an organisation logo -> images/accolades/…', logoUp.status === 200 && /^images\/accolades\//.test(logoUp.body.filePath), JSON.stringify(logoUp.body));
    const pdfUp = await upload('POST', '/upload', { section: 'accolades' }, { buffer: MIN_PDF, filename: 'certificate.pdf', contentType: 'application/pdf' }, 'file');
    check('upload a PDF certificate -> images/accolades/….pdf', pdfUp.status === 200 && /^images\/accolades\/.+\.pdf$/.test(pdfUp.body.filePath), JSON.stringify(pdfUp.body));
    const pdfElsewhere = await upload('POST', '/upload', { section: 'gallery' }, { buffer: MIN_PDF, filename: 'sneaky.pdf', contentType: 'application/pdf' }, 'file');
    check('a PDF is still refused for every other section (gallery)', !(pdfElsewhere.body && pdfElsewhere.body.success), `${pdfElsewhere.status} ${JSON.stringify(pdfElsewhere.body)}`);
    const exeUp = await upload('POST', '/upload', { section: 'accolades' }, { buffer: Buffer.from('MZ'), filename: 'evil.exe', contentType: 'application/octet-stream' }, 'file');
    check('a non-image, non-PDF file is refused for accolades', !(exeUp.body && exeUp.body.success), `${exeUp.status} ${JSON.stringify(exeUp.body)}`);
    const anonUp = await fetch(`${BASE}/upload`, { method: 'POST', body: (() => { const f = new FormData(); f.append('section', 'accolades'); f.append('file', new Blob([png], { type: 'image/png' }), 'x.png'); return f; })() });
    check('anonymous upload is refused (401)', anonUp.status === 401, `status=${anonUp.status}`);
    const served = await fetch(`${BASE}/${pdfUp.body.filePath}`);
    check('the uploaded certificate is served as application/pdf', served.status === 200 && /application\/pdf/.test(served.headers.get('content-type') || ''), `${served.status} ${served.headers.get('content-type')}`);
    const IMG = imgUp.body.filePath, LOGO = logoUp.body.filePath, PDF = pdfUp.body.filePath;

    // ── Create ──
    const tricky = `Comics' Choice & "Best" <Newcomer>`;
    const full = await create({
        title: 'Alpha', category: 'win', year: Y - 1, achievement_date: `${Y - 1}-03-12`,
        organisation: 'South African Comedy Awards', event_name: 'Annual Gala', result: 'Winner',
        description: 'Recognised for outstanding stand-up.\nSecond line.', location: 'Johannesburg',
        image: IMG, organisation_logo: LOGO, certificate_file: PDF,
        external_url: 'https://example.com/awards?year=1&cat=2', source_url: 'https://news.example.com/story'
    });
    check('create a full accolade -> 200 with an id and last_updated', full.status === 200 && full.body.success && Number.isInteger(full.body.id) && full.body.last_updated && full.body.last_updated.name, JSON.stringify(full.body));
    const idA = full.body.id;
    let admin = await adminView();
    let a = admin.accolades.find(x => x.id === idA);
    check('a new accolade defaults to Inactive (a draft), so it is NOT on the website yet',
        a && a.status === 'inactive' && a.is_public === false && a.public_position === null && !(await publicList()).some(x => x.id === idA), JSON.stringify(a));
    check('every field is stored as entered (media paths, links with & and query strings, line breaks)',
        a.image === IMG && a.organisation_logo === LOGO && a.certificate_file === PDF && a.external_url === 'https://example.com/awards?year=1&cat=2'
        && a.description === 'Recognised for outstanding stand-up.\nSecond line.' && a.achievement_date === `${Y - 1}-03-12` && a.year === Y - 1,
        JSON.stringify(a));
    check('created_by is recorded and named for the card', !!a.created_by && typeof a.created_by_name === 'string' && a.created_by_name.length > 0, JSON.stringify({ by: a.created_by, name: a.created_by_name }));
    const createAudit = await one("SELECT * FROM audit_log WHERE table_name = 'accolades' AND record_id = ? AND action = 'create'", [idA]);
    check('create is written to the audit log with the new values', !!createAudit && /South African Comedy Awards/.test(createAudit.new_values || '') && createAudit.changed_by !== 'system', JSON.stringify(createAudit));

    const trickyRes = await create({ title: tricky, category: 'nomination', year: Y - 1, organisation: 'Savanna & Friends' });
    const idT = trickyRes.body && trickyRes.body.id;
    const tRow = (await adminView()).accolades.find(x => x.id === idT);
    check(`apostrophes, quotes, & and < > round-trip exactly as typed (not HTML-entity-encoded)`,
        trickyRes.status === 200 && tRow && tRow.title === P + tricky && tRow.organisation === 'Savanna & Friends', JSON.stringify(tRow));

    // ── Duplicate submissions ──
    const dup = await api('POST', '/api/admin/accolades', { title: '  ' + P.toLowerCase() + 'ALPHA ', category: 'win', year: Y - 1, organisation: 'south african comedy awards' });
    check('the same award again (any case / spacing) -> 409 naming the existing record', dup.status === 409 && dup.body.duplicate_id === idA, `${dup.status} ${JSON.stringify(dup.body)}`);
    const sameTitleOtherCat = await create({ title: 'Alpha', category: 'nomination', year: Y - 1, organisation: 'South African Comedy Awards' });
    check('same title as a different category is a different record (200)', sameTitleOtherCat.status === 200, JSON.stringify(sameTitleOtherCat.body));
    const idAn = sameTitleOtherCat.body.id;
    const racers = await Promise.all([1, 2, 3].map(() => create({ title: 'Race', category: 'accolade', year: Y - 2, organisation: 'Race Org' })));
    const raceOk = racers.filter(r => r.status === 200).length, race409 = racers.filter(r => r.status === 409).length;
    const raceRows = await q(`SELECT id FROM accolades WHERE title = ?`, [P + 'Race']);
    check('three simultaneous identical submissions store exactly one record (others 409)', raceOk === 1 && race409 === 2 && raceRows.length === 1, JSON.stringify({ raceOk, race409, rows: raceRows.length }));
    const idR = raceRows[0] && raceRows[0].id;
    const collide = await api('PUT', `/api/admin/accolades/${idAn}`, { category: 'win' });
    check('an edit that would duplicate another record -> 409, record unchanged', collide.status === 409
        && (await one('SELECT category FROM accolades WHERE id = ?', [idAn])).category === 'nomination', `${collide.status} ${JSON.stringify(collide.body)}`);

    // ── Publish ──
    const pubA = await api('PUT', `/api/admin/accolades/${idA}`, { status: 'active' });
    check('publish (status active) -> 200', pubA.status === 200 && pubA.body.success && pubA.body.last_updated, JSON.stringify(pubA.body));
    let pubs;
    ({ admin, pubs } = await assertParity('after publishing'));
    const liveA = pubs.find(x => x.id === idA);
    check('the published accolade is on the website', !!liveA, JSON.stringify(pubs.map(x => x.id)));
    check('the website gets exactly the published fields, nothing internal',
        JSON.stringify(Object.keys(liveA).sort()) === JSON.stringify(admin.public_fields.slice().sort()), JSON.stringify(Object.keys(liveA).sort()));
    const adminA = admin.accolades.find(x => x.id === idA);
    check('every published value matches the admin record', admin.public_fields.every(k => (k === 'featured' ? liveA[k] === (adminA[k] == 1 ? 1 : 0) : liveA[k] === adminA[k])),
        JSON.stringify({ pub: liveA, admin: adminA }));
    check('drafts stay off the website', !pubs.some(x => x.id === idT || x.id === idAn || x.id === idR), JSON.stringify(pubs.map(x => x.id)));

    // ── Order: newest year first, then the admin's own order within a year ──
    const c1 = await create({ title: 'Bravo', category: 'nomination', year: Y, status: 'active' });
    const c2 = await create({ title: 'Charlie', category: 'accolade', year: Y, status: 'active' });
    const c3 = await create({ title: 'Delta', category: 'win', year: Y - 3, status: 'active' });
    const idB = c1.body.id, idC = c2.body.id, idD = c3.body.id;
    check('create three published accolades -> 200', [c1, c2, c3].every(r => r.status === 200), JSON.stringify([c1.body, c2.body, c3.body]));
    ({ pubs } = await assertParity('after adding more'));
    const order = () => mine(pubs).map(x => x.title.slice(P.length));
    check('website order: newest year first, creation order within a year (Bravo, Charlie, Alpha, Delta)',
        JSON.stringify(order()) === JSON.stringify(['Bravo', 'Charlie', 'Alpha', 'Delta']), JSON.stringify(order()));

    const allIds = (await adminView()).accolades.map(x => x.id);
    const wanted = [idD, idC, idB].concat(allIds.filter(id => ![idD, idC, idB].includes(id)));
    const re = await api('PUT', '/api/admin/accolades/reorder', { order: wanted });
    check('reorder with every id -> 200', re.status === 200 && re.body.success, JSON.stringify(re.body));
    ({ pubs } = await assertParity('after reorder'));
    check('reorder changes the order WITHIN a year (Charlie now before Bravo) but never breaks the year order (Delta stays last)',
        JSON.stringify(order()) === JSON.stringify(['Charlie', 'Bravo', 'Alpha', 'Delta']), JSON.stringify(order()));
    const reorderAudit = await one("SELECT * FROM audit_log WHERE table_name = 'accolades' AND action = 'reorder' ORDER BY id DESC LIMIT 1");
    check('reorder is written to the audit log', !!reorderAudit && JSON.parse(reorderAudit.new_values).order.length === wanted.length, JSON.stringify(reorderAudit));
    const stale = await api('PUT', '/api/admin/accolades/reorder', { order: wanted.slice(1) });
    check('a reorder that leaves an accolade out (stale list) -> 409, nothing half-applied', stale.status === 409, `${stale.status} ${JSON.stringify(stale.body)}`);
    for (const [label, body] of [['empty', { order: [] }], ['duplicate ids', { order: [idA, idA] }], ['non-numeric ids', { order: ['x'] }], ['not an array', { order: 'all' }]]) {
        const r = await api('PUT', '/api/admin/accolades/reorder', body);
        check(`reorder with ${label} -> 400`, r.status === 400, `${r.status}`);
    }
    const direct = await api('PUT', `/api/admin/accolades/${idB}`, { display_order: 0 });
    ({ pubs } = await assertParity('after setting a display order directly'));
    check('setting Display Order in the drawer moves it within its year too (Bravo first again)', direct.status === 200 && order()[0] === 'Bravo', JSON.stringify(order()));

    // ── Feature ──
    const feat = await api('PUT', `/api/admin/accolades/${idA}`, { featured: true });
    ({ pubs } = await assertParity('after featuring'));
    check('feature -> the website marks it featured (1); others stay 0', feat.status === 200 && pubs.find(x => x.id === idA).featured === 1 && pubs.find(x => x.id === idB).featured === 0,
        JSON.stringify(pubs.map(x => [x.id, x.featured])));

    // ── Edit, partial edit, clear a field ──
    const ed = await api('PUT', `/api/admin/accolades/${idA}`, { result: 'Winner — Best Newcomer', external_url: '', location: '' });
    ({ admin, pubs } = await assertParity('after edit'));
    const edPub = pubs.find(x => x.id === idA), edAdmin = admin.accolades.find(x => x.id === idA);
    check('edited result shows on both sides', ed.status === 200 && edPub.result === 'Winner — Best Newcomer' && edAdmin.result === 'Winner — Best Newcomer', JSON.stringify(edPub));
    check('a cleared link / location becomes null on both sides', edPub.external_url === null && edAdmin.external_url === null && edPub.location === null, JSON.stringify(edPub));
    check('a partial edit keeps every untouched field (organisation, media, featured, status)',
        edAdmin.organisation === 'South African Comedy Awards' && edAdmin.image === IMG && edAdmin.certificate_file === PDF && edAdmin.featured === 1 && edAdmin.status === 'active', JSON.stringify(edAdmin));
    check('updated_by / updated_at are stamped and named', !!edAdmin.updated_by && !!edAdmin.updated_at && !!edAdmin.updated_by_name, JSON.stringify({ by: edAdmin.updated_by, at: edAdmin.updated_at, name: edAdmin.updated_by_name }));
    const updAudit = await one("SELECT * FROM audit_log WHERE table_name = 'accolades' AND record_id = ? AND action = 'update' ORDER BY id DESC LIMIT 1", [idA]);
    const updNew = updAudit ? JSON.parse(updAudit.new_values) : {}, updOld = updAudit ? JSON.parse(updAudit.old_values) : {};
    check('edit is audited with old AND new values (same columns on both sides)',
        updOld.result === 'Winner' && updNew.result === 'Winner — Best Newcomer' && JSON.stringify(Object.keys(updOld)) === JSON.stringify(Object.keys(updNew)), JSON.stringify({ updOld, updNew }));
    const clearMedia = await api('PUT', `/api/admin/accolades/${idA}`, { organisation_logo: '' });
    check('removing a media file clears it (and nothing else)', clearMedia.status === 200 && (await publicList()).find(x => x.id === idA).organisation_logo === null
        && (await publicList()).find(x => x.id === idA).image === IMG, JSON.stringify(clearMedia.body));
    for (const [label, url] of [['unknown id', '/api/admin/accolades/999999'], ['non-numeric id', '/api/admin/accolades/abc'], ['negative id', '/api/admin/accolades/-4']]) {
        const r = await api('PUT', url, { result: 'x' });
        check(`edit of an ${label} -> 404`, r.status === 404, `${r.status}`);
    }
    const badEdit = await api('PUT', `/api/admin/accolades/${idA}`, { year: 1700 });
    check('an invalid edit -> 400 and the record is unchanged', badEdit.status === 400 && (await one('SELECT year FROM accolades WHERE id = ?', [idA])).year === Y - 1, `${badEdit.status}`);

    // ── Bulk actions (all-or-nothing) ──
    const bu = await api('POST', '/api/admin/accolades/bulk', { action: 'unpublish', ids: [idB, idC] });
    ({ pubs } = await assertParity('after bulk unpublish'));
    check('bulk unpublish -> both leave the website', bu.status === 200 && bu.body.changed === 2 && !pubs.some(x => x.id === idB || x.id === idC), JSON.stringify(bu.body));
    const bulkAudit = await q("SELECT * FROM audit_log WHERE table_name = 'accolades' AND reason = 'Bulk action: unpublish' AND record_id IN (?, ?)", [idB, idC]);
    check('each bulk change is audited with its reason', bulkAudit.length === 2, JSON.stringify(bulkAudit.map(r => r.record_id)));
    const bp = await api('POST', '/api/admin/accolades/bulk', { action: 'publish', ids: [idB, idC, idA] });
    ({ pubs } = await assertParity('after bulk publish'));
    check('bulk publish -> only the two hidden ones change (the live one is a no-op)', bp.status === 200 && bp.body.changed === 2 && pubs.some(x => x.id === idB) && pubs.some(x => x.id === idC), JSON.stringify(bp.body));
    const bf = await api('POST', '/api/admin/accolades/bulk', { action: 'feature', ids: [idB, idC] });
    const buf = await api('POST', '/api/admin/accolades/bulk', { action: 'unfeature', ids: [idC] });
    pubs = await publicList();
    check('bulk feature / unfeature', bf.status === 200 && buf.status === 200 && pubs.find(x => x.id === idB).featured === 1 && pubs.find(x => x.id === idC).featured === 0, JSON.stringify(pubs.filter(x => [idB, idC].includes(x.id))));
    const missingBulk = await api('POST', '/api/admin/accolades/bulk', { action: 'unpublish', ids: [idB, 999999] });
    check('bulk with an id that does not exist -> 404 and NOTHING changes', missingBulk.status === 404 && (await publicList()).some(x => x.id === idB), `${missingBulk.status}`);
    for (const [label, body] of [['unknown action', { action: 'archive', ids: [idB] }], ['an inherited property name as the action', { action: 'constructor', ids: [idB] }],
        ['an array as the action', { action: ['delete'], ids: [idB] }], ['no ids', { action: 'publish', ids: [] }], ['bad ids', { action: 'publish', ids: ['x'] }], ['no action', { ids: [idB] }]]) {
        const r = await api('POST', '/api/admin/accolades/bulk', body);
        check(`bulk with ${label} -> 400`, r.status === 400, `${r.status}`);
    }

    // ── RBAC: managers and assistants manage content; only administrators delete ──
    for (const role of ['manager', 'assistant']) {
        const as = await loginAs(role);
        const list = await as('GET', '/api/admin/accolades');
        const made = await as('POST', '/api/admin/accolades', { title: P + role, category: 'accolade', year: Y - 2 });
        const edited = made.body && made.body.id ? await as('PUT', `/api/admin/accolades/${made.body.id}`, { status: 'active', featured: true }) : { status: 0 };
        const bulked = made.body && made.body.id ? await as('POST', '/api/admin/accolades/bulk', { action: 'unpublish', ids: [made.body.id] }) : { status: 0 };
        const del = made.body && made.body.id ? await as('DELETE', `/api/admin/accolades/${made.body.id}`) : { status: 0 };
        const bulkDel = made.body && made.body.id ? await as('POST', '/api/admin/accolades/bulk', { action: 'delete', ids: [made.body.id] }) : { status: 0 };
        check(`${role}: can list, create, edit, publish/feature and bulk-unpublish`, list.status === 200 && made.status === 200 && edited.status === 200 && bulked.status === 200,
            JSON.stringify([list.status, made.status, edited.status, bulked.status]));
        check(`${role}: cannot delete (403), singly or in bulk — the record survives`, del.status === 403 && bulkDel.status === 403
            && !!(await one('SELECT id FROM accolades WHERE id = ?', [made.body.id])), JSON.stringify([del.status, bulkDel.status]));
    }

    // ── Section switch (Settings → Website Sections) ──
    const before = (await pub('GET', '/api/public/site-content')).body.sections;
    const off = await api('PUT', '/api/admin/site-content', { section_visibility: Object.assign({}, before, { accolades: false }) });
    const offAdmin = await adminView();
    const offSite = (await pub('GET', '/api/public/site-content')).body.sections;
    check('switching the section off: admin reports section_visible=false exactly when the site hides it',
        off.status === 200 && offAdmin.section_visible === false && offSite.accolades === false, JSON.stringify({ admin: offAdmin.section_visible, site: offSite.accolades }));
    await api('PUT', '/api/admin/site-content', { section_visibility: before });
    check('switching it back on is reflected by both', (await adminView()).section_visible === true && (await pub('GET', '/api/public/site-content')).body.sections.accolades === true, '');

    // ── Hostile content is stored literally and rows the API would refuse are handled safely ──
    const inj = await create({ title: `Robert'); DROP TABLE accolades;--`, category: 'accolade', year: Y - 2, status: 'active' });
    const xss = await create({ title: '<img src=x onerror=alert(1)>', category: 'accolade', year: Y - 2, status: 'active' });
    const stillThere = await one("SELECT COUNT(*) AS c FROM accolades");
    pubs = await publicList();
    check('SQL-looking text is stored literally (parameterised queries — the table is intact)', inj.status === 200 && stillThere.c > 0 && !!byTitle(pubs, `Robert'); DROP TABLE accolades;--`), JSON.stringify(inj.body));
    check('markup in a title is returned as the literal text (the view renders it as text, never HTML)', xss.status === 200 && !!byTitle(pubs, '<img src=x onerror=alert(1)>'), JSON.stringify(xss.body));
    await run(`INSERT INTO accolades (title, category, year, status, external_url, image, display_order) VALUES (?, 'win', ?, 'active', 'javascript:alert(1)', '../../database.sqlite', 999)`, [P + 'Unsafe Row', Y - 2]);
    await run(`INSERT INTO accolades (title, category, year, status, display_order) VALUES (?, 'win', ?, 'published', 999)`, [P + 'Odd Status', Y - 2]);
    await run(`INSERT INTO accolades (title, category, year, display_order) VALUES (?, 'win', ?, 999)`, [P + 'Default Status', Y - 2]);
    ({ admin, pubs } = await assertParity('with rows the API would refuse'));
    const unsafe = byTitle(pubs, 'Unsafe Row');
    check('a stored non-http(s) link and a path outside images/accolades/ are withheld from the website', !!unsafe && unsafe.external_url === null && unsafe.image === null, JSON.stringify(unsafe));
    check('an unknown status is hidden on BOTH sides', !byTitle(pubs, 'Odd Status') && byTitle(admin.accolades, 'Odd Status').is_public === false, '');
    check('the column default is Inactive — a row inserted without a status is never published', !byTitle(pubs, 'Default Status') && byTitle(admin.accolades, 'Default Status').status === 'inactive', '');

    // ── Unpublish removes it from the website; delete removes it everywhere (administrator) ──
    await api('PUT', `/api/admin/accolades/${idA}`, { status: 'inactive' });
    ({ pubs } = await assertParity('after unpublishing'));
    check('unpublished -> gone from the website, still in the admin', !pubs.some(x => x.id === idA) && (await adminView()).accolades.some(x => x.id === idA), '');
    const del = await api('DELETE', `/api/admin/accolades/${idA}`);
    check('delete (administrator) -> 200', del.status === 200 && del.body.success, JSON.stringify(del.body));
    check('deleted -> gone from the admin and the website', !(await adminView()).accolades.some(x => x.id === idA) && !(await publicList()).some(x => x.id === idA), '');
    const delAudit = await one("SELECT * FROM audit_log WHERE table_name = 'accolades' AND record_id = ? AND action = 'delete'", [idA]);
    check('the deleted record is preserved in the audit log (old values)', !!delAudit && JSON.parse(delAudit.old_values).title === P + 'Alpha', JSON.stringify(delAudit));
    const delAgain = await api('DELETE', `/api/admin/accolades/${idA}`);
    check('deleting it again -> 404', delAgain.status === 404, `${delAgain.status}`);

    // ── Cleanup (throwaway DB, but leave it as found) ──
    const leftovers = mine((await adminView()).accolades).map(x => x.id);
    const bd = await api('POST', '/api/admin/accolades/bulk', { action: 'delete', ids: leftovers });
    check('bulk delete (administrator) -> 200', bd.status === 200 && bd.body.changed === leftovers.length, JSON.stringify(bd.body));
    check('cleanup: no test accolades left', mine((await adminView()).accolades).length === 0, '');
    await assertParity('after cleanup');
};
