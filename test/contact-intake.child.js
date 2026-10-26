// Failure-injection for lib/contact-intake.js in a child process with a THROWAWAY database (DB_PATH) - the runner never opens a database itself.
// MODE=persist-fail | queue-fail | outage.   Prints one "RESULT:{json}" line. Nothing here reaches a real mail server: outage mode points the
// real SMTP transport at a closed loopback port.
const path = require('path');
const ROOT = path.join(__dirname, '..');
const mode = process.env.MODE;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    const db = require(path.join(ROOT, 'database'));
    const intake = require(path.join(ROOT, 'lib', 'contact-intake'));
    await sleep(3500);   // let the schema / migrations settle on the fresh database

    const all = (sql, p = []) => new Promise((res) => db.all(sql, p, (e, r) => res(e ? [{ error: e.message }] : r)));
    const body = {
        name: 'Child Tester', email: `child.${mode}@example.invalid`, cell: '+27821234567', category: 'General Inquiry',
        subject: 'Child subject', message: 'A message long enough to be valid.', popia_consent: true
    };
    const baseline = (await all('SELECT COALESCE(MAX(inquiry_id),0) AS m FROM inquiries'))[0].m;
    const deps = {};
    if (mode === 'persist-fail') deps.insertInquiry = (...a) => { const cb = a[a.length - 1]; cb.call({}, new Error('SQLITE_IOERR: disk I/O error (secret path C:\\data)')); };
    if (mode === 'queue-fail') deps.queueEmail = async () => ({ success: false, error: 'queue insert failed' });

    const result = await intake.submitContact({ body, ip: '203.0.113.9', userAgent: 'child-test', referrer: 'https://example.invalid/contact' }, deps);

    let after = {};
    const rows = await all('SELECT inquiry_id, status, receiver_email FROM inquiries WHERE inquiry_id > ?', [baseline]);
    after.inquiries = rows;
    const notes = await all(`SELECT id, status, retry_count, error_message, related_entity, related_id FROM notifications WHERE related_entity IN ('inquiry_intake','inquiry_receipt')`);
    after.notificationsBefore = notes.length;
    if (mode === 'outage') {
        await require(path.join(ROOT, 'lib', 'background-clerk')).processNotificationQueue();
        after.notificationsAfter = await all(`SELECT status, retry_count, error_message FROM notifications WHERE related_entity IN ('inquiry_intake','inquiry_receipt')`);
        after.inquiriesAfter = await all('SELECT inquiry_id, status FROM inquiries WHERE inquiry_id > ?', [baseline]);
        after.logs = await all(`SELECT status FROM email_logs WHERE trigger_event LIKE 'Contact Form:%'`);
    }
    console.log('RESULT:' + JSON.stringify({ mode, result, after }));
    process.exit(0);
})().catch((e) => { console.log('CHILD ERROR ' + (e && e.stack || e)); process.exit(1); });
