// Coverage for the Testimonials CRUD + moderation pipeline. Visitor submissions must never be
// publicly visible until an admin approves them; admin-authored testimonials skip review entirely.
const support = require('./support');
const { api, pub, loginAs } = support;

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

module.exports = async function ({ check }) {
    // ── Public GET returns only approved rows (the 3 seeded ones are pre-approved) ──
    const publicRes = await pub('GET', '/api/public/testimonials');
    check('public testimonials endpoint: 200, bare array', publicRes.status === 200 && Array.isArray(publicRes.body), '');
    check('public testimonials endpoint: seeded testimonials present', publicRes.body.length >= 3, String(publicRes.body.length));
    // image_path is intentionally NOT asserted here: it's a real admin-editable field (the
    // seed row started with image_path=null, but the live site owner can and does upload a
    // real photo through the admin edit drawer, and this test runs against a copy of live data).
    const naledi = publicRes.body.find(t => t.name === 'Naledi Khumalo');
    check('seed data: Naledi Khumalo present, approved, admin-submitted', !!naledi && naledi.status === 'approved' && naledi.submitted_by === 'admin', JSON.stringify(naledi));

    // ── THE MODERATION PIPELINE: public submission never appears publicly until approved ──
    const submitForm = new FormData();
    submitForm.append('name', 'Test Visitor');
    submitForm.append('designation', 'Test Attendee');
    submitForm.append('quote', 'This is a test testimonial submission.');
    const submitRes = await fetch(support.BASE + '/api/public/testimonials', { method: 'POST', body: submitForm });
    const submitBody = await submitRes.json();
    check('public submission: 200 success, pending-review message', submitRes.status === 200 && submitBody.success && /review/i.test(submitBody.message), JSON.stringify(submitBody));

    const afterSubmit = await pub('GET', '/api/public/testimonials');
    check('MODERATION: pending submission does NOT appear on the public endpoint', !afterSubmit.body.find(t => t.name === 'Test Visitor'), '');

    const adminList = await api('GET', '/api/admin/testimonials');
    const pendingRow = (Array.isArray(adminList.body) ? adminList.body : []).find(t => t.name === 'Test Visitor');
    check('MODERATION: admin list shows it as status=pending, submitted_by=visitor', !!pendingRow && pendingRow.status === 'pending' && pendingRow.submitted_by === 'visitor', JSON.stringify(pendingRow));

    // Approve it — should now appear publicly.
    const approveRes = await api('PUT', `/api/admin/testimonials/${pendingRow.id}`, { status: 'approved' });
    check('approve: 200', approveRes.status === 200 && approveRes.body.success, JSON.stringify(approveRes.body));
    const afterApprove = await pub('GET', '/api/public/testimonials');
    check('MODERATION: approved submission now appears on the public endpoint', !!afterApprove.body.find(t => t.name === 'Test Visitor'), '');

    // ── Reject a second submission — should never appear publicly ──
    const rejectForm = new FormData();
    rejectForm.append('name', 'Reject Me');
    rejectForm.append('quote', 'Testing the reject path.');
    await fetch(support.BASE + '/api/public/testimonials', { method: 'POST', body: rejectForm });
    const adminList2 = await api('GET', '/api/admin/testimonials');
    const rejectRow = (Array.isArray(adminList2.body) ? adminList2.body : []).find(t => t.name === 'Reject Me');
    await api('PUT', `/api/admin/testimonials/${rejectRow.id}`, { status: 'rejected' });
    const afterReject = await pub('GET', '/api/public/testimonials');
    check('MODERATION: rejected submission never appears on the public endpoint', !afterReject.body.find(t => t.name === 'Reject Me'), '');
    const statusFilterRes = await api('GET', '/api/admin/testimonials?status=rejected');
    check('admin status filter: ?status=rejected returns the rejected row', (Array.isArray(statusFilterRes.body) ? statusFilterRes.body : []).some(t => t.name === 'Reject Me'), '');

    // ── Admin-authored testimonial is immediately approved (no review needed) ──
    const cookie = await getAdminCookie();
    const adminCreateForm = new FormData();
    adminCreateForm.append('name', 'Admin Authored');
    adminCreateForm.append('quote', 'Written directly by the admin.');
    adminCreateForm.append('section', 'testimonials');
    const adminCreateRes = await fetch(support.BASE + '/api/admin/testimonials', { method: 'POST', headers: { Cookie: cookie }, body: adminCreateForm });
    const adminCreateBody = await adminCreateRes.json();
    check('admin-direct create: 200 + id', adminCreateRes.status === 200 && adminCreateBody.success, JSON.stringify(adminCreateBody));
    const afterAdminCreate = await pub('GET', '/api/public/testimonials');
    check('admin-direct create: immediately visible publicly (no moderation needed)', !!afterAdminCreate.body.find(t => t.name === 'Admin Authored'), '');

    // ── Validation: missing name or quote rejected on the public endpoint ──
    const badForm = new FormData();
    badForm.append('quote', 'Missing a name.');
    const badRes = await fetch(support.BASE + '/api/public/testimonials', { method: 'POST', body: badForm });
    check('public submission without name: 400', badRes.status === 400, String(badRes.status));

    // ── Edit: rename + change quote, image untouched (image was already null) ──
    const editRes = await api('PUT', `/api/admin/testimonials/${adminCreateBody.id}`, { name: 'Admin Authored Renamed', quote: 'Updated quote text.' });
    check('edit: 200', editRes.status === 200, '');
    const afterEdit = await pub('GET', '/api/public/testimonials');
    const edited = afterEdit.body.find(t => t.id === adminCreateBody.id);
    check('edit persisted: name and quote updated', edited && edited.name === 'Admin Authored Renamed' && edited.quote === 'Updated quote text.', JSON.stringify(edited));

    // ── RBAC: manager can create, assistant cannot delete, only administrator can delete ──
    await loginAs('manager');
    const managerCookie = await getRoleCookie('manager');
    const managerForm = new FormData();
    managerForm.append('name', 'Manager Created');
    managerForm.append('quote', 'Created by a manager.');
    managerForm.append('section', 'testimonials');
    const managerCreateRes = await fetch(support.BASE + '/api/admin/testimonials', { method: 'POST', headers: { Cookie: managerCookie }, body: managerForm });
    check('RBAC: manager can create a testimonial -> 200', managerCreateRes.status === 200, String(managerCreateRes.status));

    const assistantApi = await loginAs('assistant');
    const assistantDeleteRes = await assistantApi('DELETE', `/api/admin/testimonials/${adminCreateBody.id}`);
    check('RBAC: assistant blocked from deleting a testimonial -> 403', assistantDeleteRes.status === 403, String(assistantDeleteRes.status));

    // ── Delete (administrator) actually removes it ──
    const deleteRes = await api('DELETE', `/api/admin/testimonials/${adminCreateBody.id}`);
    check('delete: 200', deleteRes.status === 200 && deleteRes.body.success, JSON.stringify(deleteRes.body));
    const afterDelete = await pub('GET', '/api/public/testimonials');
    check('deleted testimonial no longer appears publicly', !afterDelete.body.find(t => t.id === adminCreateBody.id), '');
};
