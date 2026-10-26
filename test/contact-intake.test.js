// Public Contact form intake (POST /send-email -> lib/contact-intake.js). Phase 3 of the Contact/Inquiries <-> Microsoft 365 work.
//   A. the pure validation rules (lib/contact-validation.js), directly;
//   B. the HTTP endpoint on the running (SMTP_MOCK) test server: persist-first, server-decided recipients, injection / spam / duplicate /
//      per-address limits, the Booking Inquiry link, escaping, no personal data in the server log;
//   C. failure injection in a child process with a throwaway DB: the database fails, the outbox fails, Microsoft 365 is unreachable;
//   D. source scans: the browser sends no recipient any more, the honeypot is in the page.
// Nothing here talks to a real mail server.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3');
const support = require('./support');
const validation = require('../lib/contact-validation');

const ROOT = path.join(__dirname, '..');
const writeDb = (sql, params = []) => new Promise((resolve, reject) => {
    const db = new sqlite3.Database(support.TEST_DB);
    db.run(sql, params, (e) => db.close(() => e ? reject(e) : resolve()));
});

// Asynchronous on purpose: a blocking spawnSync would starve the runner's event loop while the shared HTTP keep-alive sockets time out,
// and the next suite's first fetch() would then fail on a dead socket.
function runChild(mode) {
    const tmpDb = path.join(os.tmpdir(), `contact-child-${process.pid}-${Date.now()}-${mode}.sqlite`);
    const env = {
        ...process.env, DB_PATH: tmpDb, NODE_ENV: 'test', R2_ENDPOINT: '', R2_BUCKET: '', R2_ACCESS_KEY_ID: '', R2_SECRET_ACCESS_KEY: '',
        GOOGLE_REFRESH_TOKEN: 'test-mode-invalid-refresh-token', EMAIL_OVERHAUL_ENABLED: '', SETTINGS_ENCRYPTION_KEY: 'test-only-settings-encryption-key', MODE: mode,
        SMTP_MOCK: mode === 'outage' ? 'false' : 'true'
    };
    if (mode === 'outage') Object.assign(env, { SMTP_HOST: '127.0.0.1', SMTP_PORT: '1', SMTP_SECURE: 'starttls', SMTP_USER: 'bookings@example.invalid', SMTP_PASS: 'not-a-real-password', SMTP_FROM: 'bookings@example.invalid', SMTP_AUTH: '' });
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [path.join(__dirname, 'contact-intake.child.js')], { cwd: ROOT, env });
        let out = '';
        child.stdout.on('data', (d) => { out += d; });
        child.stderr.on('data', (d) => { out += d; });
        const timer = setTimeout(() => child.kill(), 180000);
        child.on('close', () => {
            clearTimeout(timer);
            for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + suffix); } catch (e) {} }
            const line = out.split('\n').find((l) => l.startsWith('RESULT:'));
            resolve({ out, data: line ? JSON.parse(line.slice(7)) : null });
        });
    });
}

module.exports = async function ({ check, pub, api, q, one, sleep }) {
    // ══════════ A. validation rules ══════════
    const v = (over, now) => validation.validateSubmission({ name: 'Thando Smith', email: 'thando@example.com', cell: '+27821234567', category: 'General Inquiry', subject: '', message: 'A perfectly fine message.', popia_consent: true, ...over }, now);
    check('a normal submission has no errors and no spam flag', Object.keys(v({}).errors).length === 0 && v({}).spam === null, JSON.stringify(v({})));
    for (const bad of ['a@x.com,b@y.com', 'a@x.com;b@y.com', 'a@x.com b@y.com', 'x@example.com\r\nBcc: v@example.com', '<a@example.com>', '"a b"@example.com', 'a@@example.com', 'a@example', '.a@example.com', 'a..b@example.com', 'a@example.com.', '']) {
        check(`email ${JSON.stringify(bad)} is refused`, !!v({ email: bad }).errors.email, '');
    }
    for (const good of ['thando@example.com', "o'brien@example.co.za", 'first.last+tag@sub.example.org']) {
        check(`email ${good} is accepted`, !v({ email: good }).errors.email, '');
    }
    check('a very long email is refused', !!v({ email: 'a'.repeat(250) + '@example.com' }).errors.email, '');
    check('a text field sent as an object/array is treated as empty (refused), not as a crash', !!v({ name: { $gt: '' } }).errors.name && !!v({ message: ['x'] }).errors.message, '');
    check('name: 1 character refused, 101 refused, 2..100 accepted', !!v({ name: 'A' }).errors.name && !!v({ name: 'A'.repeat(101) }).errors.name && !v({ name: 'Al' }).errors.name && !v({ name: 'A'.repeat(100) }).errors.name, '');
    check('message: 9 characters refused, 5001 refused, 10..5000 accepted', !!v({ message: '123456789' }).errors.message && !!v({ message: 'x'.repeat(5001) }).errors.message && !v({ message: '1234567890' }).errors.message && !v({ message: 'x'.repeat(5000) }).errors.message, '');
    check('subject: empty fine, 2 characters refused, 3..150 accepted, 151 refused', !v({ subject: '' }).errors.subject && !!v({ subject: 'ab' }).errors.subject && !v({ subject: 'abc' }).errors.subject && !!v({ subject: 'x'.repeat(151) }).errors.subject, '');
    check('phone: empty fine; +27 82 123 4567 / 082-123-4567 accepted; letters / too short / too long refused', !v({ cell: '' }).errors.cell && !v({ cell: '+27 82 123 4567' }).errors.cell && !v({ cell: '082-123-4567' }).errors.cell && !!v({ cell: 'call me' }).errors.cell && !!v({ cell: '12345' }).errors.cell && !!v({ cell: '1'.repeat(16) }).errors.cell, '');
    check('phone is normalised to digits (and a leading +)', v({ cell: '+27 (82) 123-4567' }).clean.cell === '+27821234567', v({ cell: '+27 (82) 123-4567' }).clean.cell);
    check('POPIA consent is required (false / missing / "false" refused; true / "true" / "on" accepted)', !!v({ popia_consent: false }).errors.popia_consent && !!v({ popia_consent: undefined }).errors.popia_consent && !!v({ popia_consent: 'false' }).errors.popia_consent && !v({ popia_consent: 'true' }).errors.popia_consent && !v({ popia_consent: 'on' }).errors.popia_consent, '');
    check('CR/LF in single-line fields cannot survive (no header injection)', !/[\r\n]/.test(v({ name: 'A\r\nBcc: x@y.z', subject: 'Hello\r\nBcc: x@y.z', category: 'a\nb' }).clean.name + v({ subject: 'Hello\r\nBcc: x@y.z' }).clean.subject + v({ category: 'a\nb' }).clean.category), '');
    check('already-encoded text (what app.js deepEscapeBody delivers) is judged as the plain text', v({ name: 'O&#x27;Brien &amp; Sons' }).clean.name === "O'Brien & Sons", v({ name: 'O&#x27;Brien &amp; Sons' }).clean.name);
    check('an empty category means General Inquiry; a long one is cut to 60', v({ category: '' }).clean.category === 'General Inquiry' && v({ category: 'x'.repeat(200) }).clean.category.length === 60, '');
    check('honeypot filled -> spam "honeypot"; whitespace-only is not a hit', v({ contact_hp: 'http://spam.example' }).spam === 'honeypot' && v({ contact_hp: '   ' }).spam === null && v({ contact_hp: '' }).spam === null, '');
    const now = Date.now();
    check('submitted 1 s after the form rendered -> "too-fast"; after 5 s / no timestamp / a nonsense timestamp -> fine', v({ form_started_at: now - 1000 }, now).spam === 'too-fast' && v({ form_started_at: now - 5000 }, now).spam === null && v({}, now).spam === null && v({ form_started_at: 'abc' }, now).spam === null && v({ form_started_at: now + 10 * 60000 }, now).spam === null, '');
    check('references: INQ-000042 <-> 42', validation.referenceFor(42) === 'INQ-000042' && validation.idFromReference('INQ-000042') === 42 && validation.idFromReference('inq-7') === 7 && validation.idFromReference('nope') === null, '');

    // ══════════ B. the endpoint ══════════
    await writeDb("UPDATE contact_info SET email = 'bookings@test.invalid'");
    const stamp = Date.now();
    const unique = (tag) => `intake.${tag}.${stamp}@example.invalid`;
    const form = (over) => ({ name: 'Intake Tester', email: unique('base'), cell: '+27821234567', category: 'General Inquiry', subject: 'Intake subject', message: 'This is an intake test message.', popia_consent: true, ...over });
    const countInq = async (email) => (await one('SELECT COUNT(*) AS n FROM inquiries WHERE LOWER(sender_email) = LOWER(?)', [email])).n;
    const notesFor = (id) => q(`SELECT * FROM notifications WHERE related_id = ? AND related_entity IN ('inquiry_intake','inquiry_receipt') ORDER BY id`, [id]);

    // happy path
    const e1 = unique('happy');
    const r1 = await pub('POST', '/send-email', form({ email: e1, message: 'Line one of my message.\nLine two.' }));
    check('a valid submission -> 200 success with a reference', r1.status === 200 && r1.body.success === true && /^INQ-\d{6}$/.test(r1.body.reference || ''), JSON.stringify(r1.body));
    const row1 = await one('SELECT * FROM inquiries WHERE LOWER(sender_email) = LOWER(?)', [e1]);
    check('...the inquiry is saved (unread) and the reference matches its id', !!row1 && row1.status === 'unread' && validation.referenceFor(row1.inquiry_id) === r1.body.reference, JSON.stringify(row1));
    check('...the sender, category, phone and subject are stored', row1.sender_name === 'Intake Tester' && row1.category === 'General Inquiry' && row1.sender_phone === '+27821234567' && row1.subject === 'Intake subject', JSON.stringify(row1));
    check('...the receiver recorded on the inquiry is the configured Contact Details address', row1.receiver_email === 'bookings@test.invalid', row1.receiver_email);
    check('...consent and technical context are recorded', row1.popia_consent === 1 && !!row1.consent_timestamp && !!row1.user_agent, JSON.stringify([row1.popia_consent, row1.consent_timestamp, row1.user_agent]));
    const n1 = await notesFor(row1.inquiry_id);
    const adminMail = n1.find((n) => n.related_entity === 'inquiry_intake'), receipt = n1.find((n) => n.related_entity === 'inquiry_receipt');
    check('...exactly two mails are queued: the notification and the visitor receipt', n1.length === 2 && !!adminMail && !!receipt, JSON.stringify(n1.map((n) => [n.related_entity, n.recipient_email])));
    check('...the notification goes to the configured address, never to the visitor', adminMail.recipient_email === 'bookings@test.invalid', adminMail.recipient_email);
    const adminBody = JSON.parse(adminMail.body);
    check('...the visitor appears only as Reply-To on the notification', adminBody.replyTo === e1 && !JSON.stringify(adminBody).includes('"to"') && adminMail.recipient_email !== e1, JSON.stringify({ replyTo: adminBody.replyTo }));
    check('...the notification subject carries the reference; the receipt goes only to the visitor', adminMail.subject === `Website Inquiry: Intake subject [${r1.body.reference}]` && receipt.recipient_email === e1 && /Thank you for your message/.test(receipt.subject), JSON.stringify([adminMail.subject, receipt.subject]));
    check('...the notification shows the reference and both message lines', adminBody.htmlContent.includes(r1.body.reference) && adminBody.htmlContent.includes('Line one of my message.<br>Line two.'), '');
    check('...the mails are linked to the inquiry through the outbox (queued for delivery; the 20-second sweep may already have taken them, but never failed)', n1.every((n) => ['pending', 'sent'].includes(n.status) && n.related_id === row1.inquiry_id), JSON.stringify(n1.map((n) => n.status)));

    // persistence and delivery are separate facts: the admin sees the inquiry AND the state of the two mails it queued
    const conv = await api('GET', `/api/admin/inquiries/${row1.inquiry_id}/messages`);
    const ik = conv.body && conv.body.intake;
    check('the conversation endpoint reports the delivery state of the two intake mails (alert to the booking mailbox, confirmation to the sender)', conv.status === 200 && !!ik && ['queued', 'attempted', 'accepted'].includes(ik.notification.state) && ik.notification.to === 'bookings@test.invalid' && ['queued', 'attempted', 'accepted'].includes(ik.receipt.state) && ik.receipt.to === e1, JSON.stringify(conv.body));
    await writeDb("UPDATE notifications SET status = 'failed', retry_count = 3, error_message = 'Mailbox unavailable' WHERE id = ?", [adminMail.id]);
    const conv2 = await api('GET', `/api/admin/inquiries/${row1.inquiry_id}/messages`);
    check('...a failed alert shows as failed with its reason while the inquiry itself is untouched', conv2.body.intake.notification.state === 'failed' && conv2.body.intake.notification.error === 'Mailbox unavailable' && (await one('SELECT status FROM inquiries WHERE inquiry_id = ?', [row1.inquiry_id])).status === 'unread', JSON.stringify(conv2.body.intake));

    // the browser cannot choose the recipient
    const e2 = unique('recipient');
    const r2 = await pub('POST', '/send-email', form({ email: e2, recipientEmail: 'attacker@evil.invalid', to: 'attacker@evil.invalid', cc: 'attacker@evil.invalid' }));
    const row2 = await one('SELECT * FROM inquiries WHERE LOWER(sender_email) = LOWER(?)', [e2]);
    const n2 = await notesFor(row2.inquiry_id);
    check('a recipient supplied by the browser is ignored (inquiry + both mails)', r2.status === 200 && row2.receiver_email === 'bookings@test.invalid' && n2.every((n) => !/evil/.test(n.recipient_email + n.body)), JSON.stringify(n2.map((n) => n.recipient_email)));

    // injection attempts: nothing may be saved or sent
    const e3 = unique('inject');
    const before = (await one("SELECT COUNT(*) AS n FROM notifications WHERE related_entity IN ('inquiry_intake','inquiry_receipt')")).n;
    for (const bad of [`${e3},second.${stamp}@example.invalid`, `${e3}\r\nBcc: victim@example.invalid`, `<${e3}>`, `"x y"@example.invalid`]) {
        const r = await pub('POST', '/send-email', form({ email: bad }));
        check(`email ${JSON.stringify(bad).slice(0, 60)} -> 400 with an email error, nothing saved`, r.status === 400 && r.body.success === false && !!(r.body.errors && r.body.errors.email), JSON.stringify(r.body));
    }
    const after = (await one("SELECT COUNT(*) AS n FROM notifications WHERE related_entity IN ('inquiry_intake','inquiry_receipt')")).n;
    check('...and not one mail was queued by those attempts', before === after && (await countInq(e3)) === 0, `${before} -> ${after}`);

    // header injection through single-line fields
    const e4 = unique('headers');
    const r4 = await pub('POST', '/send-email', form({ email: e4, subject: 'Hello\r\nBcc: victim@example.invalid', name: 'Eve\r\nBcc: victim@example.invalid' }));
    const row4 = await one('SELECT * FROM inquiries WHERE LOWER(sender_email) = LOWER(?)', [e4]);
    const n4 = await notesFor(row4.inquiry_id);
    check('line breaks in subject / name are flattened: no header can be smuggled into a mail subject', r4.status === 200 && n4.every((nn) => !/[\r\n]/.test(nn.subject)) && !/[\r\n]/.test(row4.subject + row4.sender_name), JSON.stringify(n4.map((nn) => nn.subject)));

    // HTML in free text: stored encoded once, escaped (not interpreted) in the mails, no double encoding
    const e5 = unique('html');
    const r5 = await pub('POST', '/send-email', form({ email: e5, name: '<img src=x onerror=alert(1)>', subject: "Tom & Jerry's <b>show</b>", message: '<script>alert(1)</script> and some words' }));
    const row5 = await one('SELECT * FROM inquiries WHERE LOWER(sender_email) = LOWER(?)', [e5]);
    const n5 = await notesFor(row5.inquiry_id);
    const html5 = n5.map((nn) => JSON.parse(nn.body).htmlContent).join('\n');
    check('markup in name / subject / message is stored entity-encoded (the stored-text convention)', r5.status === 200 && row5.sender_name.startsWith('&lt;img') && !/[<>]/.test(row5.sender_name + row5.subject + row5.message_body) && row5.message_body.includes('&lt;script&gt;'), JSON.stringify([row5.sender_name, row5.subject]));
    check('...and no raw tag reaches either e-mail body', !/<img src=x|<script>alert|<b>show/.test(html5), '');
    check('...the notification SUBJECT line is plain text (decoded, not entity-encoded)', n5.find((nn) => nn.related_entity === 'inquiry_intake').subject === `Website Inquiry: Tom & Jerry's <b>show</b> [${r5.body.reference}]`, n5.map((nn) => nn.subject).join(' | '));
    const e6 = unique('apos');
    const r6 = await pub('POST', '/send-email', form({ email: e6, name: "O'Brien & Sons" }));
    const row6 = await one('SELECT * FROM inquiries WHERE LOWER(sender_email) = LOWER(?)', [e6]);
    const html6 = (await notesFor(row6.inquiry_id)).map((nn) => JSON.parse(nn.body).htmlContent).join('\n');
    check('"O\'Brien & Sons" is stored once-encoded and rendered in the mails without double encoding', row6.sender_name === 'O&#x27;Brien &amp; Sons' && html6.includes('O&#39;Brien &amp; Sons') && !/&amp;amp;|&amp;#/.test(html6), row6.sender_name);

    // validation failures never create anything
    const e7 = unique('invalid');
    for (const [label, over, field] of [['no name', { name: '' }, 'name'], ['short message', { message: 'short' }, 'message'], ['no consent', { popia_consent: false }, 'popia_consent'], ['bad phone', { cell: 'call me' }, 'cell'], ['too long a message', { message: 'x'.repeat(5001) }, 'message'], ['1-2 character subject', { subject: 'ab' }, 'subject']]) {
        const r = await pub('POST', '/send-email', form({ email: e7, ...over }));
        check(`${label} -> 400 naming the field`, r.status === 400 && r.body.success === false && !!(r.body.errors && r.body.errors[field]) && typeof r.body.message === 'string', JSON.stringify(r.body));
    }
    check('...and none of them saved an inquiry', (await countInq(e7)) === 0, '');
    const rObj = await pub('POST', '/send-email', { name: { x: 1 }, email: ['a@b.co'], message: 12345, popia_consent: true });
    check('a body of the wrong types is a clean 400, not a server error', rObj.status === 400 && rObj.body.success === false, JSON.stringify(rObj));

    // silent traps
    const e8 = unique('honeypot');
    const nBefore = (await one('SELECT COUNT(*) AS n FROM notifications')).n;
    const r8 = await pub('POST', '/send-email', form({ email: e8, contact_hp: 'http://spam.example' }));
    check('honeypot filled -> answered like a success (bots learn nothing) but nothing is saved or queued', r8.status === 200 && r8.body.success === true && !r8.body.reference && (await countInq(e8)) === 0 && (await one('SELECT COUNT(*) AS n FROM notifications')).n === nBefore, JSON.stringify(r8.body));
    const e9 = unique('fast');
    const r9 = await pub('POST', '/send-email', form({ email: e9, form_started_at: Date.now() }));
    check('a submit within a second of the form appearing is dropped the same way', r9.status === 200 && r9.body.success === true && !r9.body.reference && (await countInq(e9)) === 0, JSON.stringify(r9.body));
    const e10 = unique('slow');
    const r10 = await pub('POST', '/send-email', form({ email: e10, form_started_at: Date.now() - 60000 }));
    check('a normal-speed submit with the timestamp is accepted', r10.status === 200 && !!r10.body.reference && (await countInq(e10)) === 1, JSON.stringify(r10.body));

    // duplicates
    const e11 = unique('dup');
    const first = await pub('POST', '/send-email', form({ email: e11, message: 'Please send me your rider and rates.' }));
    const queuedAfterFirst = (await one("SELECT COUNT(*) AS n FROM notifications WHERE related_entity IN ('inquiry_intake','inquiry_receipt')")).n;
    const second = await pub('POST', '/send-email', form({ email: e11.toUpperCase(), message: 'Please send me your rider and rates.' }));
    check('the same message again (any letter case in the address) -> success with the ORIGINAL reference, flagged duplicate', second.status === 200 && second.body.duplicate === true && second.body.reference === first.body.reference, JSON.stringify([first.body, second.body]));
    check('...still ONE inquiry and no new e-mail', (await countInq(e11)) === 1 && (await one("SELECT COUNT(*) AS n FROM notifications WHERE related_entity IN ('inquiry_intake','inquiry_receipt')")).n === queuedAfterFirst, '');
    const e12 = unique('race');
    const same = form({ email: e12, message: 'Three clicks at the same instant.' });
    const burst = await Promise.all([pub('POST', '/send-email', same), pub('POST', '/send-email', same), pub('POST', '/send-email', same)]);
    check('three identical submissions at the same instant -> ONE inquiry, one reference', burst.every((b) => b.status === 200 && b.body.success) && new Set(burst.map((b) => b.body.reference)).size === 1 && (await countInq(e12)) === 1, JSON.stringify(burst.map((b) => b.body)));

    // per-address cap
    const e13 = unique('cap');
    const caps = [];
    for (let i = 1; i <= 4; i++) caps.push(await pub('POST', '/send-email', form({ email: e13, message: `Distinct message number ${i} for the cap test.` })));
    check('one address may send 3 different messages per hour; the 4th -> 429 with a friendly message', caps.slice(0, 3).every((c) => c.status === 200) && caps[3].status === 429 && caps[3].body.success === false && /wait/i.test(caps[3].body.message), JSON.stringify(caps.map((c) => c.status)));
    check('...the refused one saved nothing', (await countInq(e13)) === 3, '');

    // Booking Inquiry keeps its legacy booking row AND now appears in Inquiries, linked
    const e14 = unique('booking');
    const bookingsBefore = (await one("SELECT COUNT(*) AS n FROM bookings WHERE email = ?", [e14])).n;
    const r14 = await pub('POST', '/send-email', form({ email: e14, category: 'Booking Inquiry', subject: 'Wedding in June', message: 'We would like to book you for our wedding.' }));
    const row14 = await one('SELECT * FROM inquiries WHERE LOWER(sender_email) = LOWER(?)', [e14]);
    const bk14 = await one('SELECT * FROM bookings WHERE email = ?', [e14]);
    check('"Booking Inquiry" -> an INQUIRY now exists (it used to bypass Inquiries entirely)', r14.status === 200 && !!row14 && row14.category === 'Booking Inquiry', JSON.stringify(r14.body));
    check('...and the legacy PENDING booking row is still created (booking workflow preserved)', bookingsBefore === 0 && !!bk14 && bk14.status === 'PENDING' && bk14.date === 'TBD' && bk14.event_type === 'Booking Inquiry' && bk14.message.includes('Wedding in June') && !bk14.message.includes('undefined'), JSON.stringify(bk14));
    check('...the two are linked both ways, so Convert-to-Booking is not offered twice', bk14.source_inquiry_id === row14.inquiry_id && row14.converted_booking_id === bk14.id, JSON.stringify([bk14.source_inquiry_id, row14.converted_booking_id]));
    const list = await api('GET', `/api/admin/inquiries?search=${encodeURIComponent(e14)}`);
    check('...and the admin Inquiries list shows it', list.status === 200 && list.body.inquiries.some((i) => i.inquiry_id === row14.inquiry_id), JSON.stringify(list.body.inquiries && list.body.inquiries.length));
    const e15 = unique('notbooking');
    await pub('POST', '/send-email', form({ email: e15, category: 'Not a booking at all' }));
    check('a category that merely CONTAINS "booking" no longer creates a booking row', (await one('SELECT COUNT(*) AS n FROM bookings WHERE email = ?', [e15])).n === 0 && (await countInq(e15)) === 1, '');

    // no personal data in the server log
    const log = support.getChildLog();
    check('the server log no longer prints the submitted body (it used to dump name, email, phone and message on every submission)', !log.includes('Line one of my message') && !log.includes('This is an intake test message') && !log.includes('[DEBUG] /send-email'), 'found submitted text in the log');
    await writeDb("UPDATE contact_info SET email = 'admin@thabisomhlongo.com' WHERE email = 'bookings@test.invalid'");
    // The ~60 mails this suite queued would sit in front of every later suite that waits for ITS mail (the worker sends 10 every 20 s): they were only
    // ever needed as rows to inspect, so remove the ones still waiting.
    await writeDb("DELETE FROM notifications WHERE related_entity IN ('inquiry_intake', 'inquiry_receipt') AND status = 'pending'");

    // ══════════ C. failure injection (child process, throwaway DB) ══════════
    const pf = await runChild('persist-fail');
    check('database failure: the visitor gets a 503 and an honest message (no success claimed)', !!pf.data && pf.data.result.status === 503 && pf.data.result.body.success === false, pf.out.slice(-600));
    check('...nothing was saved or queued, and the internal error text does not leak', !!pf.data && pf.data.after.inquiries.length === 0 && pf.data.after.notificationsBefore === 0 && !JSON.stringify(pf.data.result).includes('SQLITE') && !JSON.stringify(pf.data.result).includes('C:'), JSON.stringify(pf.data && pf.data.after));
    const qf = await runChild('queue-fail');
    check('outbox failure: the inquiry is STILL saved and the form succeeds with a reference', !!qf.data && qf.data.result.status === 200 && qf.data.result.body.success === true && /^INQ-\d{6}$/.test(qf.data.result.body.reference) && qf.data.after.inquiries.length === 1, qf.out.slice(-600));
    check('...and the visitor is not promised a confirmation e-mail that was never queued', !!qf.data && !/confirmation is on its way/i.test(qf.data.result.body.message), qf.data && qf.data.result.body.message);
    const og = await runChild('outage');
    check('Microsoft 365 unreachable: the form still succeeds, the inquiry is saved and both mails are queued', !!og.data && og.data.result.status === 200 && og.data.after.inquiries.length === 1 && og.data.after.notificationsBefore === 2, og.out.slice(-800));
    check('...the sweep fails to deliver but loses nothing: both mails stay pending (recoverable), the reason is recorded, the inquiry is untouched', !!og.data && og.data.after.notificationsAfter.length === 2 && og.data.after.notificationsAfter.every((n) => n.status === 'pending') && og.data.after.notificationsAfter.some((n) => !!n.error_message) && og.data.after.inquiriesAfter[0].status === 'unread', JSON.stringify(og.data && og.data.after));
    check('...each attempt is recorded as failed (never as success) in email_logs', !!og.data && og.data.after.logs.length >= 1 && og.data.after.logs.every((l) => l.status === 'failed'), JSON.stringify(og.data && og.data.after.logs));

    // ══════════ D. source scans ══════════
    const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
    check('the browser no longer sends a recipient or reads a delivery address from localStorage', !/recipientEmail/.test(read('js/myscript.js')) && !/tm_contact_data/.test(read('js/myscript.js')) && !/thabiso@example\.com/.test(read('js/myscript.js')), '');
    check('the route no longer reads a recipient from the body, logs the body, or builds mail itself', !/recipientEmail/.test(read('routes/public/misc.js')) && !/\[DEBUG\] \/send-email/.test(read('routes/public/misc.js')) && !/renderSystemEmail/.test(read('routes/public/misc.js')), '');
    const indexHtml = read('index.html');
    check('the page carries the honeypot (hidden, not tab-reachable, not auto-filled) and the booking category matches the server constant', /id="contactHp"[^>]*tabindex="-1"[^>]*autocomplete="off"/.test(indexHtml) && indexHtml.includes(`<option value="${validation.BOOKING_CATEGORY}">`), '');
};
