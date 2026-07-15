// Coverage for the newsletter scheduling reliability fixes: atomic claim before send (no
// double-processing of a pending row), the PUT-edit validation companion fix, the birthday
// sort column, the preview-endpoint banner host fix, and the boot-time overdue-recovery sweep.
const support = require('./support');
const { api, pub, one, sleep } = support;
const sqlite3 = require('sqlite3');

const rw = new sqlite3.Database(support.TEST_DB);
const run = (sql, params = []) => new Promise((res, rej) => rw.run(sql, params, function (e) { e ? rej(e) : res(this); }));

async function getAdminCookie() {
    const r = await fetch(support.BASE + '/api/admin/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'test.runner@example.invalid', password: 'TestRunnerPass1!' }),
    });
    return r.headers.get('set-cookie').split(';')[0];
}

async function scheduleCampaign(subject, content, scheduledAtIso) {
    const cookie = await getAdminCookie();
    const form = new FormData();
    form.append('subject', subject);
    form.append('content', content);
    form.append('scheduled_at', scheduledAtIso);
    const r = await fetch(support.BASE + '/api/admin/newsletter/schedule', { method: 'POST', headers: { Cookie: cookie }, body: form });
    return { status: r.status, body: await r.json() };
}

module.exports = async function ({ check }) {
    // ── B2: atomic claim — full pending -> sent lifecycle completes, counts populate ──
    const fireIn5s = new Date(Date.now() + 5000).toISOString();
    const sched = await scheduleCampaign('Scheduling test A', '<p>Hi</p>', fireIn5s);
    check('schedule create: 200 + id returned', sched.status === 200 && sched.body.success && !!sched.body.id, JSON.stringify(sched.body));
    const schedId = sched.body.id;

    let finalRow = null;
    for (let i = 0; i < 30; i++) { // up to ~15s
        await sleep(500);
        finalRow = await one('SELECT status, success_count, fail_count FROM scheduled_newsletters WHERE id = ?', [schedId]);
        if (finalRow && finalRow.status !== 'pending' && finalRow.status !== 'sending') break;
    }
    check('atomic claim: schedule reaches a terminal status (sent) after firing', !!finalRow && finalRow.status === 'sent', JSON.stringify(finalRow));
    check('atomic claim: success_count/fail_count populated (not null)', !!finalRow && finalRow.success_count !== null && finalRow.fail_count !== null, JSON.stringify(finalRow));

    // Once a row has moved past 'pending' (claimed/sent), the cancel endpoint's own
    // WHERE status='pending' guard must reject it — this is the same protective mechanism the
    // atomic claim relies on, exercised at a deterministic point instead of racing the transient
    // 'sending' window.
    const cancelAfterSent = await api('DELETE', `/api/admin/newsletter/schedule/${schedId}`);
    check('atomic claim: cancelling an already-sent schedule is rejected (not pending)', cancelAfterSent.status === 400, JSON.stringify(cancelAfterSent.body));

    // B2 ripple fix: campaigns/unified must not show a completed send as "Failed".
    const unified = await api('GET', '/api/admin/campaigns/unified?limit=50');
    const unifiedRow = (unified.body.campaigns || []).find(c => c.source === 'schedule' && c.id === schedId);
    check('campaigns/unified ripple fix: sent schedule shows display_status=sent, not failed', !!unifiedRow && unifiedRow.display_status === 'sent', JSON.stringify(unifiedRow));

    // ── PUT validation companion fix: editing a schedule to a past date is rejected ──
    const fireIn30s = new Date(Date.now() + 30000).toISOString();
    const sched2 = await scheduleCampaign('Scheduling test B', '<p>Hi</p>', fireIn30s);
    check('schedule create (for PUT test): 200', sched2.status === 200 && sched2.body.success, JSON.stringify(sched2.body));
    const pastDate = new Date(Date.now() - 60000).toISOString();
    const cookie2 = await getAdminCookie();
    const editForm = new FormData();
    editForm.append('subject', 'Scheduling test B edited');
    editForm.append('content', '<p>Hi</p>');
    editForm.append('scheduled_at', pastDate);
    const editRes = await fetch(support.BASE + '/api/admin/newsletter/schedule/' + sched2.body.id, { method: 'PUT', headers: { Cookie: cookie2 }, body: editForm });
    check('PUT validation: editing to a past date is rejected -> 400', editRes.status === 400, String(editRes.status));
    // Clean up: cancel the still-pending B test row so it doesn't fire during the rest of the suite.
    await api('DELETE', `/api/admin/newsletter/schedule/${sched2.body.id}`);

    // ── A3: Birthday column sort, NULLs last both directions ──
    const bdayPrefix = `bdaysort.${Date.now()}`;
    async function seedSub(n, day, month) {
        const add = await api('POST', '/api/admin/newsletter/subscribers', { email: `${bdayPrefix}.${n}@example.invalid`, first_name: `B${n}` });
        if (day && month) await api('PUT', `/api/admin/newsletter/subscribers/${add.body.subscriber_id}`, { birthday_day: day, birthday_month: month });
        return add.body.subscriber_id;
    }
    await seedSub(1, 20, 6);  // 20 Jun
    await seedSub(2, 5, 3);   // 5 Mar
    await seedSub(3, null, null); // no birthday
    await seedSub(4, 15, 1);  // 15 Jan

    const ascRes = await api('GET', `/api/admin/newsletter/subscribers?search=${bdayPrefix}&sort=birthday&order=ASC&limit=50`);
    const ascEmails = (ascRes.body.subscribers || []).map(s => s.email);
    check('birthday sort ASC: Jan < Mar < Jun, NULL last', JSON.stringify(ascEmails) === JSON.stringify([
        `${bdayPrefix}.4@example.invalid`, `${bdayPrefix}.2@example.invalid`, `${bdayPrefix}.1@example.invalid`, `${bdayPrefix}.3@example.invalid`
    ]), JSON.stringify(ascEmails));

    const descRes = await api('GET', `/api/admin/newsletter/subscribers?search=${bdayPrefix}&sort=birthday&order=DESC&limit=50`);
    const descEmails = (descRes.body.subscribers || []).map(s => s.email);
    check('birthday sort DESC: Jun > Mar > Jan, NULL still last', JSON.stringify(descEmails) === JSON.stringify([
        `${bdayPrefix}.1@example.invalid`, `${bdayPrefix}.2@example.invalid`, `${bdayPrefix}.4@example.invalid`, `${bdayPrefix}.3@example.invalid`
    ]), JSON.stringify(descEmails));

    // ── A5: preview banner renders against the request host, not the hardcoded production domain ──
    const cookie3 = await getAdminCookie();
    const previewForm = new FormData();
    previewForm.append('subject', 'Preview host test');
    previewForm.append('content', '<p>Hi {{first_name}}</p>');
    const previewRes = await fetch(support.BASE + '/api/admin/newsletter/preview', { method: 'POST', headers: { Cookie: cookie3 }, body: previewForm });
    const previewBody = await previewRes.json();
    check('preview endpoint: 200 success', previewRes.status === 200 && previewBody.success, JSON.stringify(previewBody).slice(0, 200));
    const bannerMatch = previewBody.html && previewBody.html.match(/<img[^>]+src="([^"]*\/images\/banners\/[^"]*)"/);
    if (bannerMatch) {
        check('preview banner img uses the request host, not the hardcoded production domain', bannerMatch[1].startsWith(support.BASE), bannerMatch[1]);
    } else {
        check('preview banner check skipped (no newsletter_campaign banner assigned in this DB copy)', true, '');
    }
    check('preview HTML never references the hardcoded production domain', !!previewBody.html && !previewBody.html.includes('www.thabisomhlongo.com'), '');

    // ── B1: boot-recovery sweep — an overdue row from before a restart gets fired, not orphaned ──
    const overdueAt = new Date(Date.now() - 60000).toISOString(); // 1 min in the past
    const overdueInsert = await run(
        "INSERT INTO scheduled_newsletters (subject, content, scheduled_at, status) VALUES (?, ?, ?, 'pending')",
        ['Overdue recovery test', '<p>Hi</p>', overdueAt]
    );
    const overdueId = overdueInsert.lastID;
    const beforeRestart = await one('SELECT status FROM scheduled_newsletters WHERE id = ?', [overdueId]);
    check('boot-recovery setup: overdue row seeded as pending', beforeRestart && beforeRestart.status === 'pending', JSON.stringify(beforeRestart));

    await support.restart();

    let recoveredRow = null;
    for (let i = 0; i < 20; i++) { // up to ~10s
        await sleep(500);
        recoveredRow = await one('SELECT status FROM scheduled_newsletters WHERE id = ?', [overdueId]);
        if (recoveredRow && recoveredRow.status !== 'pending') break;
    }
    check('boot-recovery: overdue row no longer stuck at pending after restart', !!recoveredRow && recoveredRow.status !== 'pending', JSON.stringify(recoveredRow));
    check('boot-recovery: recovery log line present in server output', support.getChildLog().includes('[Newsletter] Recovering'), '');
};
