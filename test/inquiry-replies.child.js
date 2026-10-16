// Run by inquiry-replies.test.js in its OWN process (it opens the database): drives the REAL lib/direct-emails.js + lib/inquiry-messages.js +
// the notification-queue worker + the SMTP transport against a fake SMTP server, and prints one "CHECK:{...}" line per assertion.
// The question every scenario answers: is an inquiry reported as replied / a reply reported as delivered ONLY when Microsoft 365 really took it?
//   S1 happy path          S2 recipient refused -> retries exhausted     S3 "Send again" on the failed reply
//   S4 outage, then recovery with no user action      S5 24-hour expiry      S6 overlapping reconciles act once
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';          // exactly what app.js does process-wide: the transport must still verify

const fs = require('fs');
const { startFakeSmtp } = require('./fake-smtp');
const tlsMaterial = { cert: fs.readFileSync(process.env.FAKE_TLS_CERT, 'utf8'), key: fs.readFileSync(process.env.FAKE_TLS_KEY, 'utf8') };
const rec = (name, pass, detail) => console.log('CHECK:' + JSON.stringify({ name, pass: !!pass, detail: pass ? '' : String(detail === undefined ? '' : detail).slice(0, 600) }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SMTP_VARS = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'SMTP_FROM_NAME', 'EMAIL_USER', 'EMAIL_PASS', 'SMTP_AUTH'];
function useEnv(port) {
    SMTP_VARS.forEach((k) => delete process.env[k]);
    Object.assign(process.env, { SMTP_HOST: '127.0.0.1', SMTP_PORT: String(port), SMTP_SECURE: 'starttls', SMTP_USER: 'bookings@test.invalid', SMTP_PASS: 'child-test-password', SMTP_FROM: 'bookings@test.invalid', SMTP_FROM_NAME: 'Thabiso Mhlongo' });
    emailService.resetTransport();
}

const emailService = require('../js/emailService');
const db = require('../database');
const { processNotificationQueue } = require('../lib/background-clerk');
const { sendDirectEmail } = require('../lib/direct-emails');
const inquiryMessages = require('../lib/inquiry-messages');

const q = (sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => e ? rej(e) : res(r)));
const one = async (sql, p = []) => (await q(sql, p))[0];
const run = (sql, p = []) => new Promise((res, rej) => db.run(sql, p, function (e) { e ? rej(e) : res(this.lastID); }));

let adminId;
let counter = 0;
async function newReply(senderEmail, forgedTo) {
    counter++;
    const inquiryId = await run(`INSERT INTO inquiries (sender_name, sender_email, receiver_email, category, subject, message_body, status) VALUES ('Child Sender', ?, 'bookings@test.invalid', 'General Inquiry', 'Subject ${counter}', 'A message body that is long enough.', 'unread')`, [senderEmail]);
    const draftId = await run(`INSERT INTO direct_emails (inquiry_id, to_emails, cc_emails, bcc_emails, subject, body, status, created_by) VALUES (?, ?, '[]', '[]', ?, '<p>Hello, thanks for getting in touch.</p>', 'draft', ?)`,
        [inquiryId, JSON.stringify([forgedTo || senderEmail]), `Re: Subject ${counter}`, adminId]);
    return { inquiryId, draftId };
}
const inquiryRow = (id) => one('SELECT status, responded_at, updated_by FROM inquiries WHERE inquiry_id = ?', [id]);
const messageRow = (inquiryId) => one('SELECT * FROM inquiry_messages WHERE inquiry_id = ? ORDER BY id DESC LIMIT 1', [inquiryId]);

async function main() {
    // the throwaway DB must have finished creating its tables / migrations
    for (let i = 0; i < 80; i++) {
        const t = await q("SELECT name FROM sqlite_master WHERE name IN ('notifications','settings','inquiry_messages','inquiries','direct_emails')").catch(() => []);
        const cols = await q('PRAGMA table_info(direct_emails)').catch(() => []);
        const e = await q('PRAGMA table_info(email_logs)').catch(() => []);
        if (t.length === 5 && cols.some((c) => c.name === 'created_by') && e.some((c) => c.name === 'smtp_response')) break;
        await sleep(250);
    }
    adminId = await run(`INSERT INTO admins (username, email, password_hash, role, is_active, must_change_password) VALUES ('child.manager', 'child.manager@test.invalid', 'x', 'manager', 1, 0)`);

    // ── S1 happy path ──
    {
        const f = await startFakeSmtp({ user: 'bookings@test.invalid', pass: 'child-test-password', tlsMaterial });
        useEnv(f.port);
        const { inquiryId, draftId } = await newReply('customer.one@test.invalid', 'attacker@evil.invalid');
        await sendDirectEmail(draftId, { id: adminId, name: 'Child Manager' });
        const queued = await messageRow(inquiryId);
        rec('S1: queueing creates a conversation row in state QUEUED, tied to an outbox row, credited to the admin', !!queued && queued.delivery_status === 'queued' && !!queued.notification_id && queued.sent_by === adminId && queued.sent_by_name === 'Child Manager' && /^<inq-\d+-/.test(queued.message_id), JSON.stringify(queued));
        const before = await inquiryRow(inquiryId);
        rec('S1: the inquiry is NOT marked replied just because the reply was queued', before.status === 'unread' && !before.responded_at, JSON.stringify(before));
        const note = await one('SELECT * FROM notifications WHERE id = ?', [queued.notification_id]);
        rec('S1: the outbox row is for the inquiry\'s own sender - the forged To on the draft is ignored', note.recipient_email === 'customer.one@test.invalid' && note.related_entity === 'inquiries' && note.related_id === inquiryId, JSON.stringify(note));
        await processNotificationQueue();
        const s = f.sessions.find((x) => x.data) || {};
        rec('S1: Microsoft 365 (the fake) received it ONLY for the inquiry sender', s.rcpt && s.rcpt.length === 1 && s.rcpt[0] === 'customer.one@test.invalid' && !(s.data || '').includes('evil.invalid'), JSON.stringify(s.rcpt));
        rec('S1: the subject carries the reference and the pre-chosen Message-ID / X-TM-Inquiry-Id are on the wire', new RegExp('^Subject: Re: Subject \\d+ \\[INQ-0*' + inquiryId + '\\]', 'm').test(s.data || '') && (s.data || '').includes('Message-ID: ' + queued.message_id) && new RegExp('^X-TM-Inquiry-Id: ' + inquiryId + '\\s*$', 'im').test(s.data || ''), (s.data || '').slice(0, 500));   // header names are case-insensitive (nodemailer writes X-Tm-Inquiry-ID)
        rec('S1: Reply-To is the shared mailbox, so the customer\'s answer lands where the portal reads it; the sender is the configured name + mailbox', /^Reply-To: .*bookings@test\.invalid/m.test(s.data || '') && /^From: .*Thabiso Mhlongo.* <bookings@test\.invalid>/m.test(s.data || ''), (s.data || '').slice(0, 400));
        const after = await messageRow(inquiryId);
        const infoAfter = await inquiryRow(inquiryId);
        rec('S1: once the outbox reports it sent -> conversation row ACCEPTED (with the time) and ONLY NOW the inquiry is replied, credited to the admin', after.delivery_status === 'accepted' && !!after.accepted_at && after.attempts === 1 && infoAfter.status === 'replied' && !!infoAfter.responded_at && infoAfter.updated_by === adminId, JSON.stringify({ after, infoAfter }));
        const dsent = await one('SELECT status FROM direct_emails WHERE id = ?', [draftId]);
        rec('S1: the composer item is marked sent', dsent.status === 'sent', JSON.stringify(dsent));
        const log = await one("SELECT status FROM email_logs WHERE trigger_event = 'Admin: Inquiry Reply' ORDER BY id DESC LIMIT 1");
        rec('S1: email_logs records the attempt (accepted by the server)', log && log.status === 'success', JSON.stringify(log));
        // S6 piggybacks: reconcile again, twice, concurrently - the inquiry must not be re-marked
        await Promise.all([inquiryMessages.reconcileDelivery(), inquiryMessages.reconcileDelivery()]);
        const marks = await one(`SELECT COUNT(*) AS n FROM audit_log WHERE table_name = 'inquiries' AND record_id = ? AND action = 'UPDATE' AND new_values LIKE '%"status":"replied"%'`, [inquiryId]);
        rec('S6: overlapping reconciles act once - the inquiry was marked replied exactly once in the audit trail', marks.n === 1, JSON.stringify(marks));
        const thread = await inquiryMessages.listForInquiry(inquiryId);
        rec('S1: the thread lists the reply with parsed recipients', thread.length === 1 && thread[0].to_addresses[0] === 'customer.one@test.invalid' && thread[0].direction === 'out', JSON.stringify(thread));
        await f.close();
    }

    // ── S2 recipient refused, retries exhausted ── then S3 send again ──
    {
        let rejecting = true;
        const f = await startFakeSmtp({ user: 'bookings@test.invalid', pass: 'child-test-password', tlsMaterial, rejectRcpt: (a) => rejecting && a === 'nobody@test.invalid' });
        useEnv(f.port);
        const { inquiryId, draftId } = await newReply('nobody@test.invalid');
        await sendDirectEmail(draftId, { id: adminId, name: 'Child Manager' });
        const first = await messageRow(inquiryId);
        await processNotificationQueue();
        const m1 = await messageRow(inquiryId);
        rec('S2: after the first refusal the reply is ATTEMPTED (retrying), not sent, and the reason is kept', m1.delivery_status === 'attempted' && m1.attempts === 1 && /./.test(m1.last_error || ''), JSON.stringify(m1));
        await processNotificationQueue(); await processNotificationQueue();
        const m3 = await messageRow(inquiryId);
        const inq = await inquiryRow(inquiryId);
        const d = await one('SELECT status FROM direct_emails WHERE id = ?', [draftId]);
        rec('S2: retries exhausted -> the reply is FAILED with the server\'s reason', m3.delivery_status === 'failed' && m3.attempts === 3 && /5\.1\.1|recipient|not found/i.test(m3.last_error || ''), JSON.stringify(m3));
        rec('S2: a failed reply NEVER marks the inquiry replied (no responded_at, still unread)', inq.status === 'unread' && !inq.responded_at, JSON.stringify(inq));
        rec('S2: the composer item is flagged failed so it can be sent again', d.status === 'failed', JSON.stringify(d));
        const logs = await q("SELECT status FROM email_logs WHERE trigger_event = 'Admin: Inquiry Reply' AND recipient_email = 'nobody@test.invalid'");
        rec('S2: every attempt is in email_logs as failed - none as success', logs.length >= 3 && logs.every((l) => l.status === 'failed'), JSON.stringify(logs));

        // S3: the server now accepts; "Send again" re-queues the SAME conversation row
        rejecting = false;
        emailService.resetTransport();
        await sendDirectEmail(draftId, { id: adminId, name: 'Child Manager' }, { retryMessageId: first.id });
        const requeued = await messageRow(inquiryId);
        const count = await one('SELECT COUNT(*) AS n FROM inquiry_messages WHERE inquiry_id = ?', [inquiryId]);
        rec('S3: send again re-queues the SAME conversation row (state queued, attempts reset, error cleared, same Message-ID, new outbox row)', requeued.id === first.id && requeued.delivery_status === 'queued' && requeued.attempts === 0 && !requeued.last_error && requeued.message_id === first.message_id && requeued.notification_id !== first.notification_id && count.n === 1, JSON.stringify({ requeued, count }));
        await processNotificationQueue();
        const done = await messageRow(inquiryId);
        const inq2 = await inquiryRow(inquiryId);
        rec('S3: accepted this time -> the reply is accepted and the inquiry becomes replied', done.delivery_status === 'accepted' && inq2.status === 'replied' && !!inq2.responded_at, JSON.stringify({ done, inq2 }));
        await f.close();
    }

    // ── S4 outage, then recovery with no user action ──
    {
        const dead = await startFakeSmtp({ user: 'bookings@test.invalid', pass: 'child-test-password', tlsMaterial });
        const deadPort = dead.port;
        await dead.close();                                  // nothing listens there any more: connection refused
        useEnv(deadPort);
        const { inquiryId, draftId } = await newReply('customer.outage@test.invalid');
        await sendDirectEmail(draftId, { id: adminId, name: 'Child Manager' });
        await processNotificationQueue();
        const m = await messageRow(inquiryId);
        const inq = await inquiryRow(inquiryId);
        rec('S4: Microsoft 365 unreachable -> the reply stays pending as ATTEMPTED with the reason, the inquiry is untouched', m.delivery_status === 'attempted' && /./.test(m.last_error || '') && inq.status === 'unread', JSON.stringify({ m, inq }));
        const f = await startFakeSmtp({ user: 'bookings@test.invalid', pass: 'child-test-password', tlsMaterial });
        useEnv(f.port);                                       // the service comes back (also clears the queue pause, as saving settings would)
        await processNotificationQueue();
        const m2 = await messageRow(inquiryId);
        const inq2 = await inquiryRow(inquiryId);
        rec('S4: when the service is back the SAME queued reply goes out by itself -> accepted, inquiry replied', m2.delivery_status === 'accepted' && m2.id === m.id && inq2.status === 'replied', JSON.stringify({ m2, inq2 }));
        await f.close();
    }

    // ── S5 24-hour expiry ──
    {
        const f = await startFakeSmtp({ user: 'bookings@test.invalid', pass: 'child-test-password', tlsMaterial });
        useEnv(f.port);
        const { inquiryId, draftId } = await newReply('customer.stale@test.invalid');
        await sendDirectEmail(draftId, { id: adminId, name: 'Child Manager' });
        const m = await messageRow(inquiryId);
        await run("UPDATE notifications SET error_message = 'earlier failure', created_at = datetime('now', '-25 hours') WHERE id = ?", [m.notification_id]);
        await processNotificationQueue();
        const m2 = await messageRow(inquiryId);
        const inq = await inquiryRow(inquiryId);
        rec('S5: a reply that waited 24 hours behind a mail-server fault is FAILED (not sent a day late) and the inquiry stays unanswered', m2.delivery_status === 'failed' && /24 hours/.test(m2.last_error || '') && inq.status === 'unread' && !f.sessions.some((s) => s.data), JSON.stringify({ m2, inq }));
        await f.close();
    }

    // ── S7 POPIA: the conversation is personal data - erasure and the 2-year retention sweep redact it ──
    {
        const inqRepo = require('../database/repositories/inquiries.repository');
        const addMsg = (inquiryId) => run(`INSERT INTO inquiry_messages (inquiry_id, direction, source, subject, body_html, body_text, from_address, to_addresses, delivery_status) VALUES (?, 'out', 'admin_reply', 'Secret subject', '<p>Secret body</p>', 'Secret body', 'bookings@test.invalid', '["erase.me@test.invalid"]', 'accepted')`, [inquiryId]);
        const { inquiryId } = await newReply('erase.me@test.invalid');
        await addMsg(inquiryId);
        await inqRepo.redactInquiryMessagesForErasure('?', [inquiryId]);
        const r = await one('SELECT subject, body_html, body_text, to_addresses, from_address, direction, delivery_status FROM inquiry_messages WHERE inquiry_id = ?', [inquiryId]);
        rec('S7: an erasure request redacts the reply\'s subject, body and addresses (the row, direction and delivery state stay for the audit trail)', /Redacted/.test(r.subject) && /Redacted/.test(r.body_html) && /Redacted/.test(r.body_text) && r.to_addresses === null && r.from_address === null && r.direction === 'out' && r.delivery_status === 'accepted', JSON.stringify(r));
        const oldId = await run(`INSERT INTO inquiries (sender_name, sender_email, category, subject, message_body, status, submitted_at) VALUES ('Old Person', 'old.person@test.invalid', 'x', 's', 'a body that is long enough', 'read', datetime('now', '-3 years'))`);
        await addMsg(oldId);
        await new Promise((res) => inqRepo.anonymizeOldInquiries(function () { res(); }));
        const old = await one('SELECT subject, body_html, to_addresses FROM inquiry_messages WHERE inquiry_id = ?', [oldId]);
        const recent = await one('SELECT status FROM inquiries WHERE inquiry_id = ?', [inquiryId]);
        rec('S7: the retention sweep redacts the conversation of inquiries it anonymises', old.subject === '[REDACTED]' && old.body_html === '[REDACTED]' && old.to_addresses === null && !!recent, JSON.stringify(old));
    }
    process.exit(0);
}
main().catch((e) => { rec('child crashed', false, e && e.stack || e); process.exit(1); });
