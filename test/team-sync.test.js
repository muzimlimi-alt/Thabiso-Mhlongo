// Management Team — one source of truth. The public API (GET /api/public/team, what index.html
// renders) and the admin API (GET /api/admin/team, what admin.html renders) must always describe the
// SAME team: same members, same order, same published fields, with the admin additionally told
// exactly what the website does with each member. Both are built by lib/team.js; these tests fail if
// either side ever starts deriving visibility, order or fields on its own.
const sqlite3 = require('sqlite3');
const support = require('./support');

// Direct handle to the isolated TEST_DB — for rows the API refuses to create (NULL status, unsafe
// links), which the public projection must still handle identically to the admin view.
const rw = new sqlite3.Database(support.TEST_DB);
const run = (sql, params = []) => new Promise((res, rej) => rw.run(sql, params, function (e) { e ? rej(e) : res(this); }));

module.exports = async function ({ check, api, pub }) {
    const adminView = async () => (await api('GET', '/api/admin/team')).body;
    const publicList = async () => (await pub('GET', '/api/public/team')).body;
    const byName = (list, name) => (list || []).find(m => m.name === name);

    // The one invariant everything else hangs off: the website's list is exactly the admin's list
    // filtered to is_public, in the same order, and every public member's position matches.
    async function assertParity(label) {
        const admin = await adminView();
        const pubs = await publicList();
        const expectedIds = admin.members.filter(m => m.is_public).map(m => m.id);
        check(`${label}: public list == admin list filtered to is_public, same order`,
            JSON.stringify(pubs.map(m => m.id)) === JSON.stringify(expectedIds),
            `public=${JSON.stringify(pubs.map(m => m.id))} admin(is_public)=${JSON.stringify(expectedIds)}`);
        const positions = admin.members.filter(m => m.is_public).map(m => m.public_position);
        check(`${label}: public_position is 1..n in website order`,
            JSON.stringify(positions) === JSON.stringify(expectedIds.map((_, i) => i + 1)), JSON.stringify(positions));
        check(`${label}: hidden members have no public_position`,
            admin.members.filter(m => !m.is_public).every(m => m.public_position === null), '');
        return { admin, pubs };
    }

    // ── Auth + shape ──
    const anon = await pub('GET', '/api/admin/team');
    check('admin team API requires a login (401)', anon.status === 401, `status=${anon.status}`);
    const first = await adminView();
    check('admin team API returns { members, section_visible, public_fields }',
        first && Array.isArray(first.members) && typeof first.section_visible === 'boolean' && Array.isArray(first.public_fields), JSON.stringify(Object.keys(first || {})));
    check('published-field list names the display fields and excludes internal ones',
        ['name', 'role', 'biography', 'image_path', 'website', 'featured'].every(k => first.public_fields.includes(k))
        && !['email', 'phone', 'created_by', 'updated_by', 'status', 'display_order'].some(k => first.public_fields.includes(k)),
        JSON.stringify(first.public_fields));
    const cacheRes = await fetch(`${support.BASE}/api/public/team`);
    check('public team API revalidates on every load (Cache-Control: no-cache)', /no-cache/.test(cacheRes.headers.get('cache-control') || ''), cacheRes.headers.get('cache-control'));
    await assertParity('baseline');

    // ── Create members ──
    const full = {
        name: 'TS Alpha', role: 'Tour Manager', biography: 'Alpha bio line one.\nLine two.',
        email: 'alpha@example.invalid', phone: '+27110000001',
        website: 'https://alpha.example.invalid', twitter: 'https://x.com/alpha', linkedin: 'https://linkedin.com/in/alpha',
        instagram: 'https://instagram.com/alpha', behance: 'https://behance.net/alpha', featured: true, status: 'active'
    };
    const a = await api('POST', '/api/admin/team', full);
    const b = await api('POST', '/api/admin/team', { name: 'TS Bravo', role: 'Hidden One', status: 'inactive' });
    const c = await api('POST', '/api/admin/team', { name: 'TS Charlie', role: 'Publicist', status: 'active' });
    check('create three members -> 200', [a, b, c].every(r => r.status === 200 && r.body.success), JSON.stringify([a.body, b.body, c.body]));
    const idA = a.body.id, idB = b.body.id, idC = c.body.id;

    // ── Write-side validation (single rule set, lib/team.js) ──
    const badStatus = await api('POST', '/api/admin/team', { name: 'TS Bad Status', status: 'banana' });
    check('unknown status is rejected (400), not stored', badStatus.status === 400, `${badStatus.status} ${JSON.stringify(badStatus.body)}`);
    const badLink = await api('POST', '/api/admin/team', { name: 'TS Bad Link', website: 'javascript:alert(1)' });
    check('non-http(s) link is rejected (400)', badLink.status === 400, `${badLink.status} ${JSON.stringify(badLink.body)}`);
    const longBio = await api('POST', '/api/admin/team', { name: 'TS Long Bio', biography: 'x'.repeat(601) });
    check('biography over the limit is rejected (400)', longBio.status === 400, `${longBio.status}`);
    const blankName = await api('POST', '/api/admin/team', { name: '   ' });
    check('whitespace-only name is rejected (400)', blankName.status === 400, `${blankName.status}`);
    const badUpdate = await api('PUT', `/api/admin/team/${idC}`, { status: 'banana' });
    check('update with an unknown status is rejected (400)', badUpdate.status === 400, `${badUpdate.status}`);
    const badOrder = await api('PUT', `/api/admin/team/${idC}`, { display_order: 'first' });
    check('update with a non-integer display_order is rejected (400)', badOrder.status === 400, `${badOrder.status}`);
    const ghosts = (await adminView()).members.filter(m => /^TS (Bad|Long)/.test(m.name));
    check('rejected creates left nothing behind', ghosts.length === 0, JSON.stringify(ghosts.map(m => m.name)));

    // ── Same people ──
    let { admin, pubs } = await assertParity('after create');
    check('active members are on the website, the inactive one is not',
        !!byName(pubs, 'TS Alpha') && !!byName(pubs, 'TS Charlie') && !byName(pubs, 'TS Bravo'), JSON.stringify(pubs.map(m => m.name)));
    const adminB = byName(admin.members, 'TS Bravo');
    check('admin still lists the inactive member, flagged not public', !!adminB && adminB.is_public === false && adminB.public_position === null, JSON.stringify(adminB));

    // ── Same fields, same values ──
    const pubA = byName(pubs, 'TS Alpha'), adminA = byName(admin.members, 'TS Alpha');
    check('public member exposes exactly the published fields, nothing else',
        JSON.stringify(Object.keys(pubA).sort()) === JSON.stringify(admin.public_fields.slice().sort()), JSON.stringify(Object.keys(pubA).sort()));
    check('email, phone and audit columns never reach the public API',
        !('email' in pubA) && !('phone' in pubA) && !('created_by' in pubA) && !('updated_by' in pubA) && !('status' in pubA), JSON.stringify(Object.keys(pubA)));
    check('every published field matches the admin record (name, role, biography, links, featured)',
        admin.public_fields.every(k => k === 'featured' ? pubA[k] === 1 && adminA[k] === 1 : pubA[k] === adminA[k]),
        JSON.stringify({ pub: pubA, admin: adminA }));
    check('biography keeps its line break', pubA.biography === 'Alpha bio line one.\nLine two.', JSON.stringify(pubA.biography));
    const pubC = byName(pubs, 'TS Charlie');
    check('unset optional fields are null on the website (not empty strings)',
        pubC.biography === null && pubC.website === null && pubC.twitter === null && pubC.image_path === null && pubC.featured === 0, JSON.stringify(pubC));

    // ── Same order ──
    const pos = list => ['TS Alpha', 'TS Charlie'].map(n => list.findIndex(m => m.name === n));
    check('creation order is the display order on both sides (Alpha before Charlie)',
        pos(pubs)[0] < pos(pubs)[1] && pos(admin.members)[0] < pos(admin.members)[1], JSON.stringify([pos(pubs), pos(admin.members)]));
    const re = await api('PUT', '/api/admin/team/reorder', { order: [idC, idB, idA] });
    check('reorder -> 200', re.status === 200 && re.body.success, JSON.stringify(re.body));
    ({ admin, pubs } = await assertParity('after reorder'));
    check('after reordering, Charlie is before Alpha on the website AND in the admin',
        pos(pubs)[1] < pos(pubs)[0] && pos(admin.members)[1] < pos(admin.members)[0], JSON.stringify([pos(pubs), pos(admin.members)]));

    // ── Visibility flips take effect on both sides at once ──
    const on = await api('PUT', `/api/admin/team/${idB}`, { status: 'active' });
    check('reactivate the hidden member -> 200', on.status === 200 && on.body.success, JSON.stringify(on.body));
    ({ admin, pubs } = await assertParity('after activating Bravo'));
    check('Bravo now appears on the website, in its ordered slot (between Charlie and Alpha)',
        !!byName(pubs, 'TS Bravo') && pubs.findIndex(m => m.name === 'TS Charlie') < pubs.findIndex(m => m.name === 'TS Bravo')
        && pubs.findIndex(m => m.name === 'TS Bravo') < pubs.findIndex(m => m.name === 'TS Alpha'), JSON.stringify(pubs.map(m => m.name)));
    await api('PUT', `/api/admin/team/${idB}`, { status: 'inactive' });
    await assertParity('after deactivating Bravo');

    // ── Edits show up on both sides, and blank fields are cleared everywhere ──
    const edit = await api('PUT', `/api/admin/team/${idA}`, { role: 'Head of Tours', twitter: '', biography: 'Updated bio.' });
    check('edit -> 200', edit.status === 200 && edit.body.success, JSON.stringify(edit.body));
    ({ admin, pubs } = await assertParity('after edit'));
    const pubA2 = byName(pubs, 'TS Alpha'), adminA2 = byName(admin.members, 'TS Alpha');
    check('edited role/biography match on both sides', pubA2.role === 'Head of Tours' && adminA2.role === 'Head of Tours' && pubA2.biography === 'Updated bio.', JSON.stringify(pubA2));
    check('a cleared link is gone from both sides', pubA2.twitter === null && adminA2.twitter === null, JSON.stringify([pubA2.twitter, adminA2.twitter]));

    // ── Awkward rows the API would refuse but the DB can hold: both sides must still agree ──
    await run("INSERT INTO team_members (name, status, display_order) VALUES ('TS Null Status', NULL, 9990)");
    await run("INSERT INTO team_members (name, status, display_order, website, twitter) VALUES ('TS Unsafe Link', 'active', 9991, 'javascript:alert(1)', 'https://x.com/ok')");
    await run("INSERT INTO team_members (name, status, display_order) VALUES ('TS Empty Status', '', 9992)");
    ({ admin, pubs } = await assertParity('with NULL / empty status rows'));
    const nullRow = byName(admin.members, 'TS Null Status');
    check('NULL status counts as active on BOTH sides (column default)', !!nullRow && nullRow.is_public === true && !!byName(pubs, 'TS Null Status'), JSON.stringify(nullRow));
    const emptyRow = byName(admin.members, 'TS Empty Status');
    check('an empty status is hidden on BOTH sides (never "active" in the admin but missing on the site)',
        !!emptyRow && emptyRow.is_public === false && !byName(pubs, 'TS Empty Status'), JSON.stringify(emptyRow));
    const unsafe = byName(pubs, 'TS Unsafe Link');
    check('a stored non-http(s) link is withheld from the website, safe links kept',
        !!unsafe && unsafe.website === null && unsafe.twitter === 'https://x.com/ok', JSON.stringify(unsafe));

    // ── Section switch: the admin must say so when the whole section is off ──
    const before = (await pub('GET', '/api/public/site-content')).body.sections;
    const off = await api('PUT', '/api/admin/site-content', { section_visibility: Object.assign({}, before, { team: false }) });
    check('switch the Team section off -> 200', off.status === 200, JSON.stringify(off.body));
    const offAdmin = await adminView();
    const offSite = (await pub('GET', '/api/public/site-content')).body.sections;
    check('admin reports section_visible=false exactly when the site hides the section',
        offAdmin.section_visible === false && offSite.team === false, JSON.stringify({ admin: offAdmin.section_visible, site: offSite.team }));
    await api('PUT', '/api/admin/site-content', { section_visibility: before });
    const onAdmin = await adminView();
    const onSite = (await pub('GET', '/api/public/site-content')).body.sections;
    check('switching it back on is reflected by both', onAdmin.section_visible === true && onSite.team === true, JSON.stringify({ admin: onAdmin.section_visible, site: onSite.team }));

    // ── Cleanup (throwaway DB, but leave it as found) ──
    await run("DELETE FROM team_members WHERE name IN ('TS Null Status', 'TS Unsafe Link', 'TS Empty Status')");
    for (const id of [idA, idB, idC]) await api('DELETE', `/api/admin/team/${id}`);
    const left = (await adminView()).members.filter(m => /^TS /.test(m.name));
    check('cleanup: no test members left', left.length === 0, JSON.stringify(left.map(m => m.name)));
    await assertParity('after cleanup');
};
