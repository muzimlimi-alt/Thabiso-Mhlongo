// Coverage for the Footprint (countries performed in) CRUD endpoints — mirrors Career
// Highlights' own RBAC/upload/edit-branching shape, so these tests follow the same pattern.
const support = require('./support');
const { api, pub, loginAs } = support;

module.exports = async function ({ check }) {
    // ── Public GET returns real countries. Counts and flag paths are NOT asserted against the
    // original 6-country seed beyond "at least one exists with a real image reference" — the
    // whole point of the Footprint admin CRUD (incl. the country-dropdown flag auto-loader) is
    // that the live site owner freely adds/removes/edits countries and swaps flag sources
    // (local seed file vs. flagcdn.com URL), and this test runs against a copy of live data. ──
    const publicRes = await pub('GET', '/api/public/footprint');
    check('public footprint endpoint: 200, bare array', publicRes.status === 200 && Array.isArray(publicRes.body), JSON.stringify(publicRes.body).slice(0, 120));
    check('public footprint endpoint: at least one country present', publicRes.body.length >= 1, String(publicRes.body.length));
    const southAfrica = publicRes.body.find(c => c.country_name === 'South Africa');
    check('seed data: South Africa present with a flag image reference', !!southAfrica && !!southAfrica.flag_image_path, JSON.stringify(southAfrica));

    // ── Admin GET returns the same shape ──
    const adminListRes = await api('GET', '/api/admin/footprint');
    check('admin footprint list: 200, bare array', adminListRes.status === 200 && Array.isArray(adminListRes.body), '');

    // ── Create via fallback_url (no file upload needed for this test) ──
    const createForm = new FormData();
    createForm.append('country_name', 'Testlandia');
    createForm.append('fallback_url', 'https://example.invalid/flags/testlandia.png');
    createForm.append('section', 'footprint');
    const cookie = await getAdminCookie();
    const createRes = await fetch(support.BASE + '/api/admin/footprint', { method: 'POST', headers: { Cookie: cookie }, body: createForm });
    const createBody = await createRes.json();
    check('create country: 200 + id returned', createRes.status === 200 && createBody.success && !!createBody.id, JSON.stringify(createBody));
    const newId = createBody.id;

    const afterCreate = await pub('GET', '/api/public/footprint');
    const created = afterCreate.body.find(c => c.id === newId);
    check('created country appears on the public endpoint', !!created && created.country_name === 'Testlandia', JSON.stringify(created));

    // ── Validation: missing country_name or image is rejected ──
    const badForm = new FormData();
    badForm.append('fallback_url', 'https://example.invalid/flags/x.png');
    badForm.append('section', 'footprint');
    const badRes = await fetch(support.BASE + '/api/admin/footprint', { method: 'POST', headers: { Cookie: cookie }, body: badForm });
    check('create without country_name: 400', badRes.status === 400, String(badRes.status));

    // ── Edit: rename without changing the image ──
    const editRes = await api('PUT', `/api/admin/footprint/${newId}`, { country_name: 'Testlandia Renamed' });
    check('edit country: 200', editRes.status === 200 && editRes.body.success, JSON.stringify(editRes.body));
    const afterEdit = await pub('GET', '/api/public/footprint');
    const edited = afterEdit.body.find(c => c.id === newId);
    check('edit persisted: name changed, flag image untouched', edited && edited.country_name === 'Testlandia Renamed' && edited.flag_image_path === 'https://example.invalid/flags/testlandia.png', JSON.stringify(edited));

    // ── Edit: swap the flag image via fallback_url ──
    await api('PUT', `/api/admin/footprint/${newId}`, { country_name: 'Testlandia Renamed', fallback_url: 'https://example.invalid/flags/new-flag.png' });
    const afterImageSwap = await pub('GET', '/api/public/footprint');
    const swapped = afterImageSwap.body.find(c => c.id === newId);
    check('edit: new flag image persisted', swapped && swapped.flag_image_path === 'https://example.invalid/flags/new-flag.png', JSON.stringify(swapped));

    // ── RBAC: manager can create, assistant cannot delete, only administrator can delete ──
    await loginAs('manager'); // ensures the known-creds manager account exists
    const managerCreateForm = new FormData();
    managerCreateForm.append('country_name', 'ManagerCreated');
    managerCreateForm.append('fallback_url', 'https://example.invalid/flags/manager.png');
    managerCreateForm.append('section', 'footprint');
    const managerCookie = await getRoleCookie('manager');
    const managerCreateRes = await fetch(support.BASE + '/api/admin/footprint', { method: 'POST', headers: { Cookie: managerCookie }, body: managerCreateForm });
    check('RBAC: manager can create a country -> 200', managerCreateRes.status === 200, String(managerCreateRes.status));

    const assistantApi = await loginAs('assistant');
    const assistantDeleteRes = await assistantApi('DELETE', `/api/admin/footprint/${newId}`);
    check('RBAC: assistant blocked from deleting a country -> 403', assistantDeleteRes.status === 403, String(assistantDeleteRes.status));

    // ── Delete (administrator) actually removes it ──
    const deleteRes = await api('DELETE', `/api/admin/footprint/${newId}`);
    check('delete country: 200', deleteRes.status === 200 && deleteRes.body.success, JSON.stringify(deleteRes.body));
    const afterDelete = await pub('GET', '/api/public/footprint');
    check('deleted country no longer appears publicly', !afterDelete.body.find(c => c.id === newId), '');

    async function getAdminCookie() {
        const r = await fetch(support.BASE + '/api/admin/login', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: 'test.runner@example.invalid', password: 'TestRunnerPass1!' }),
        });
        return r.headers.get('set-cookie').split(';')[0];
    }
    async function getRoleCookie(role) {
        const email = `test.${role}@example.invalid`;
        const r = await fetch(support.BASE + '/api/admin/login', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password: 'TestRunnerPass1!' }),
        });
        return r.headers.get('set-cookie').split(';')[0];
    }
};
