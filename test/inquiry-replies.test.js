// Admin reply workflow (Phase 4 of the Contact/Inquiries <-> Microsoft 365 work).
//   A. delivery truth, in a child process with a throwaway DB, the real worker and a fake SMTP server (test/inquiry-replies.child.js):
//      a reply is "accepted" - and the inquiry "replied" - only when Microsoft 365 took it; a failed one never marks anything replied;
//   B. the HTTP layer on the running (SMTP_MOCK) server: recipients bound to the inquiry, forged ids, address validation, RBAC on every new
//      endpoint, the conversation + retry endpoints, the list flag, the data-subject export.
// Nothing here talks to a real mail server.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3');
const support = require('./support');
const { makeSelfSignedCert } = require('./fake-smtp');

const ROOT = path.join(__dirname, '..');
const writeDb = (sql, params = []) => new Promise((resolve, reject) => {
    const db = new sqlite3.Database(support.TEST_DB);
    db.run(sql, params, function (e) { const id = this && this.lastID; db.close(() => e ? reject(e) : resolve(id)); });
});

// Asynchronous on purpose (see contact-intake.test.js): a blocking spawnSync would let the shared keep-alive sockets die under the next fetch().
function runChild(certFile, keyFile) {
    const tmpDb = path.join(os.tmpdir(), `replies-child-${process.pid}-${Date.now()}.sqlite`);
    const env = {
        ...process.env, DB_PATH: tmpDb, NODE_ENV: 'test', R2_ENDPOINT: '', R2_BUCKET: '', R2_ACCESS_KEY_ID: '', R2_SECRET_ACCESS_KEY: '',
        GOOGLE_REFRESH_TOKEN: 'test-mode-invalid-refresh-token', SMTP_MOCK: 'false', EMAIL_OVERHAUL_ENABLED: '', SETTINGS_ENCRYPTION_KEY: 'test-only-settings-encryption-key',
        FAKE_TLS_CERT: certFile, FAKE_TLS_KEY: keyFile, NODE_EXTRA_CA_CERTS: certFile
    };
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [path.join(__dirname, 'inquiry-replies.child.js')], { cwd: ROOT, env });
        let out = '';
        child.stdout.on('data', (d) => { out += d; });
        child.stderr.on('data', (d) => { out += d; });
        const timer = setTimeout(() => child.kill(), 240000);
        child.on('close', () => {
            clearTimeout(timer);
            for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + suffix); } catch (e) {} }
            resolve(out);
        });
    });
}

module.exports = async function ({ check, pub, api, loginAs, q, one }) {
    // ══════════ A. delivery truth (child process) ══════════
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replies-test-'));
    const { cert, key } = makeSelfSignedCert();
    const certFile = path.join(dir, 'cert.pem'), keyFile = path.join(dir, 'key.pem');
    fs.writeFileSync(certFile, cert); fs.writeFileSync(keyFile, key);
    const out = await runChild(certFile, keyFile);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
    const checks = out.split('\n').filter((l) => l.startsWith('CHECK:')).map((l) => JSON.parse(l.slice(6)));
    check('the delivery scenarios ran to the end (S1 happy, S2 refused, S3 send again, S4 outage + recovery, S5 expiry, S6 reconcile, S7 POPIA)', checks.length >= 20 && !checks.some((c) => c.name === 'child crashed'), out.slice(-1200));
    for (const c of checks) check(c.name, c.pass, c.detail);

    // ══════════ B. HTTP layer ══════════
    const asManager = await loginAs('manager');
    const asAssistant = await loginAs('assistant');
    const manager = await one("SELECT id FROM admins WHERE username = 'test.manager@example.invalid'");
    const stamp = Date.now();
    const sender = `replies.sender.${stamp}@example.invalid`;
    const seed = await pub('POST', '/send-email', { name: 'Replies Tester', email: sender, cell: '+27821234567', category: 'General Inquiry', subject: 'Replies subject', message: 'A message to answer in the replies test.', popia_consent: true });
    const inquiry = await one('SELECT * FROM inquiries WHERE LOWER(sender_email) = LOWER(?)', [sender]);
    check('seed: an inquiry exists and records where it came from (website form)', seed.status === 200 && !!inquiry && (inquiry.source === 'web_form' || inquiry.source === null), JSON.stringify(inquiry));
    const iid = inquiry.inquiry_id;

    // forged ids
    const body = (over) => ({ inquiry_id: iid, to_emails: [sender], subject: 'Re: Replies subject', body: '<p>Thanks for your message.</p>', ...over });
    check('a reply to an inquiry that does not exist -> 404', (await asManager('POST', '/api/admin/direct-emails', body({ inquiry_id: 987654321 }))).status === 404, '');
    check('a non-numeric inquiry id -> 400', (await asManager('POST', '/api/admin/direct-emails', body({ inquiry_id: 'abc' }))).status === 400, '');
    check('an object as inquiry id -> 400, not a crash', (await asManager('POST', '/api/admin/direct-emails', body({ inquiry_id: { $gt: 0 } }))).status === 400, '');

    // recipients bound to the inquiry
    const forged = await asManager('POST', '/api/admin/direct-emails', body({ to_emails: ['attacker@evil.invalid'], cc_emails: ['colleague@example.invalid'] }));
    const draft = forged.body && forged.body.email;
    check('a reply draft with a FORGED recipient is saved - addressed to the inquiry\'s sender, not the attacker', forged.status === 200 && !!draft && JSON.parse(draft.to_emails).join() === sender && !/evil/.test(draft.to_emails), JSON.stringify(forged.body));
    check('...the cc stays (validated) and the author is recorded', JSON.parse(draft.cc_emails).join() === 'colleague@example.invalid' && draft.created_by === manager.id && draft.inquiry_id === iid, JSON.stringify(draft));
    const edited = await asManager('PUT', `/api/admin/direct-emails/${draft.id}`, { to_emails: ['attacker@evil.invalid'], subject: 'Re: Replies subject\r\nBcc: victim@example.invalid', body: '<p>Edited.</p>' });
    check('editing the draft cannot redirect it either; line breaks in the subject are flattened', edited.status === 200 && JSON.parse(edited.body.email.to_emails).join() === sender && !/[\r\n]/.test(edited.body.email.subject), JSON.stringify(edited.body));

    // address validation (any compose, not just replies)
    for (const [label, over] of [['a comma list in cc', { cc_emails: ['a@example.invalid,b@example.invalid'] }], ['a line break in bcc', { bcc_emails: ['a@example.invalid\r\nBcc: z@example.invalid'] }], ['a display name', { cc_emails: ['Boss <boss@example.invalid>'] }], ['an object as cc', { cc_emails: { $ne: '' } }], ['a bad Reply-To', { reply_to: 'not an address' }], ['21 recipients', { cc_emails: Array.from({ length: 20 }, (_, i) => `c${i}@example.invalid`) }]]) {
        const r = await asManager('POST', '/api/admin/direct-emails', body(over));
        check(`${label} -> 400 with a clear message`, r.status === 400 && typeof r.body.error === 'string' && r.body.error.length > 5, JSON.stringify(r.body));
    }
    const freeBad = await asAssistant('POST', '/api/admin/direct-emails', { to_emails: 'one@example.invalid, two@example.invalid', subject: 'Freeform', body: '<p>Hi</p>' });
    check('freeform compose: a comma-joined "address" is refused too', freeBad.status === 400, JSON.stringify(freeBad.body));
    const freeOk = await asAssistant('POST', '/api/admin/direct-emails', { to_emails: ['one@example.invalid'], subject: 'Freeform', body: '<p>Hi</p>' });
    check('freeform compose with a valid address still works for an assistant', freeOk.status === 200 && freeOk.body.success, JSON.stringify(freeOk.body));
    check('PUT on an unknown draft -> 404', (await asManager('PUT', '/api/admin/direct-emails/987654321', { to_emails: [sender], body: '<p>x</p>' })).status === 404, '');
    check('a draft cannot be sent by anyone without a session', (await pub('POST', `/api/admin/direct-emails/${draft.id}/send`, {})).status === 401, '');

    // send -> queued; the conversation shows the state; nothing is claimed beyond what is known
    const sent = await asManager('POST', `/api/admin/direct-emails/${draft.id}/send`, {});
    check('sending answers QUEUED (not "sent")', sent.status === 200 && sent.body.success === true && sent.body.queued === true && /queued/i.test(sent.body.message), JSON.stringify(sent.body));
    const msgRow = await one('SELECT * FROM inquiry_messages WHERE inquiry_id = ?', [iid]);
    check('the reply is in the conversation, tied to its outbox row, credited to the manager', !!msgRow && msgRow.direction === 'out' && msgRow.source === 'admin_reply' && !!msgRow.notification_id && msgRow.sent_by === manager.id && /^<inq-\d+-/.test(msgRow.message_id) && msgRow.subject.includes(`[INQ-${String(iid).padStart(6, '0')}]`), JSON.stringify(msgRow));
    const note = await one('SELECT recipient_email, related_entity, related_id, body FROM notifications WHERE id = ?', [msgRow.notification_id]);
    const noteBody = JSON.parse(note.body);
    check('...the outbox row goes to the inquiry sender with threading markers (Message-ID, X-TM-Inquiry-Id) and the shared mailbox as Reply-To', note.recipient_email === sender && note.related_entity === 'inquiries' && note.related_id === iid && noteBody.messageId === msgRow.message_id && noteBody.headers['X-TM-Inquiry-Id'] === String(iid) && !!noteBody.replyTo, JSON.stringify(noteBody).slice(0, 400));
    check('sending the same item twice is refused (409), not queued twice', (await asManager('POST', `/api/admin/direct-emails/${draft.id}/send`, {})).status === 409 && (await one('SELECT COUNT(*) AS n FROM inquiry_messages WHERE inquiry_id = ?', [iid])).n === 1, '');
    check('a sent item cannot be edited back into a draft (409)', (await asManager('PUT', `/api/admin/direct-emails/${draft.id}`, { to_emails: [sender], body: '<p>again</p>' })).status === 409, '');

    // the conversation endpoint
    const convo = await asAssistant('GET', `/api/admin/inquiries/${iid}/messages`);
    check('GET conversation (an assistant may read it) -> messages with a delivery state and parsed recipients', convo.status === 200 && convo.body.success && convo.body.source === 'web_form' && convo.body.messages.length === 1 && ['queued', 'attempted', 'accepted'].includes(convo.body.messages[0].delivery_status) && convo.body.messages[0].to_addresses[0] === sender && typeof convo.body.pending === 'boolean', JSON.stringify(convo.body));
    check('GET conversation unauthenticated -> 401; bad id -> 400; unknown inquiry -> 404', (await pub('GET', `/api/admin/inquiries/${iid}/messages`)).status === 401 && (await api('GET', '/api/admin/inquiries/abc/messages')).status === 400 && (await api('GET', '/api/admin/inquiries/987654321/messages')).status === 404, '');

    // retry endpoint: RBAC, forged pairs, state rules
    const failedDraft = await writeDb(`INSERT INTO direct_emails (inquiry_id, to_emails, cc_emails, bcc_emails, subject, body, status, created_by) VALUES (?, ?, '[]', '[]', 'Re: failed one', '<p>retry me</p>', 'failed', ?)`, [iid, JSON.stringify([sender]), manager.id]);
    const failedMsg = await writeDb(`INSERT INTO inquiry_messages (inquiry_id, direction, source, message_id, subject, body_html, direct_email_id, delivery_status, attempts, last_error, sent_by_name) VALUES (?, 'out', 'admin_reply', ?, 'Re: failed one', '<p>retry me</p>', ?, 'failed', 3, '550 5.1.1 not found', 'Test Manager')`, [iid, `<inq-${iid}-retry-test-${stamp}@example.invalid>`, failedDraft]);
    const retryUrl = (i, m) => `/api/admin/inquiries/${i}/messages/${m}/retry`;
    check('retry: unauthenticated -> 401, assistant -> 403', (await pub('POST', retryUrl(iid, failedMsg), {})).status === 401 && (await asAssistant('POST', retryUrl(iid, failedMsg), {})).status === 403, '');
    const other = await pub('POST', '/send-email', { name: 'Other Person', email: `replies.other.${stamp}@example.invalid`, category: 'General Inquiry', subject: 'Other subject', message: 'Another inquiry for the forged-pair test.', popia_consent: true });
    const otherInq = await one('SELECT inquiry_id FROM inquiries WHERE LOWER(sender_email) = LOWER(?)', [`replies.other.${stamp}@example.invalid`]);
    check('retry with a forged inquiry/message pair -> 404 (the message belongs to another inquiry)', other.status === 200 && (await asManager('POST', retryUrl(otherInq.inquiry_id, failedMsg), {})).status === 404, '');
    const acceptedMsg = await writeDb(`INSERT INTO inquiry_messages (inquiry_id, direction, source, subject, body_html, delivery_status, accepted_at) VALUES (?, 'out', 'admin_reply', 'Re: delivered', '<p>x</p>', 'accepted', CURRENT_TIMESTAMP)`, [iid]);
    check('retry of a message that did not fail (already accepted) -> 409', (await asManager('POST', retryUrl(iid, acceptedMsg), {})).status === 409, '');
    check('retry with junk ids -> 400', (await asManager('POST', retryUrl('x', 'y'), {})).status === 400, '');
    const retried = await asManager('POST', retryUrl(iid, failedMsg), {});
    const requeued = await one('SELECT delivery_status, attempts, last_error, notification_id, message_id FROM inquiry_messages WHERE id = ?', [failedMsg]);
    check('retry of a failed reply by a manager -> 200: the SAME row is queued again against a new outbox row, error cleared, same Message-ID', retried.status === 200 && retried.body.queued === true && requeued.delivery_status !== 'failed' && !!requeued.notification_id && requeued.message_id === `<inq-${iid}-retry-test-${stamp}@example.invalid>`, JSON.stringify([retried.body, requeued]));
    const orphan = await writeDb(`INSERT INTO inquiry_messages (inquiry_id, direction, source, subject, body_html, direct_email_id, delivery_status, last_error) VALUES (?, 'out', 'admin_reply', 'Re: no draft', '<p>x</p>', NULL, 'failed', 'boom')`, [iid]);
    check('retry when the original draft is gone -> 409 with a clear reason', (await asManager('POST', retryUrl(iid, orphan), {})).status === 409, '');

    // the list carries the reply state and source
    const failedFlag = await writeDb(`INSERT INTO inquiry_messages (inquiry_id, direction, source, subject, body_html, delivery_status, last_error) VALUES (?, 'out', 'admin_reply', 'Re: flag', '<p>x</p>', 'failed', 'boom')`, [otherInq.inquiry_id]);
    const list = await api('GET', `/api/admin/inquiries?search=${encodeURIComponent('replies.other.' + stamp)}`);
    const row = list.body.inquiries && list.body.inquiries.find((r) => r.inquiry_id === otherInq.inquiry_id);
    check('the inquiry list reports the newest reply\'s delivery state (so a failed reply can be flagged) and the inbound count', list.status === 200 && !!row && row.last_reply_status === 'failed' && row.inbound_count === 0, JSON.stringify(row));
    check('...and the source (website form)', !!row && (row.source === 'web_form' || row.source === null), JSON.stringify(row && row.source));

    // data-subject export carries the conversation, without staff-side fields
    const exp = await pub('POST', '/api/public/compliance/export-data', { email: sender });
    const exported = exp.body && exp.body.data && exp.body.data.inquiry_messages;
    check('the POPIA data export includes the conversation on the person\'s inquiries', exp.status === 200 && Array.isArray(exported) && exported.length >= 1 && exported.every((m) => m.inquiry_id === iid), JSON.stringify(exp.body && exp.body.data && Object.keys(exp.body.data)));
    check('...without internal fields (who sent it, outbox ids)', (exported || []).length > 0 && exported.every((m) => !('sent_by' in m) && !('sent_by_name' in m) && !('notification_id' in m)), JSON.stringify(exported[0]));

    // Not left in the mail queue for the worker (they would delay later suites that wait for their own mail): these were only needed as rows to inspect.
    // (This raw handle has foreign keys off, so the links are cleared first - the app's own connection would null them by itself.)
    await writeDb("UPDATE inquiry_messages SET notification_id = NULL WHERE notification_id IN (SELECT id FROM notifications WHERE related_entity IN ('inquiry_intake', 'inquiry_receipt', 'inquiries') AND status = 'pending')");
    await writeDb("DELETE FROM notifications WHERE related_entity IN ('inquiry_intake', 'inquiry_receipt', 'inquiries') AND status = 'pending'");

    // source scan: the composer locks the To field for replies and never puts an address into markup raw
    const ui = fs.readFileSync(path.join(ROOT, 'js/admin/inquiries.js'), 'utf8');
    check('the composer locks the recipient for a reply and escapes addresses in chips', /setInqToLocked\(!!defaults\.isReply\)/.test(ui) && /<span>\$\{inqEsc\(email\)\}<\/span>/.test(ui), '');
    check('the reply toast no longer claims "sent"', !/Message sent successfully/.test(ui), '');
};
