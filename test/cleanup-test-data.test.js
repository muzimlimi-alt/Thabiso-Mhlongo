// scripts/cleanup-test-data.js - the controlled production clean-up of test data (Bookings / Calendar / Finance /
// Events / Logs). The tool is destructive by design, so this suite proves the things that make it safe:
//
//   1. the guards      refuses without a cutoff, a reviewed plan fingerprint, acknowledgements, a safe out-dir
//   2. dry run         changes nothing, and tells the truth about what a real run would do
//   3. a real run      deletes exactly the test records and everything attached to them, keeps everything else
//                      (held PayFast records, post-cutoff records, public tour dates, Google-mirrored holds,
//                      inquiries, clients ...), takes a verified backup, leaves no orphan and no new FK violation
//   4. the options     PayFast release, logs scope, standalone events, Google-mirrored holds
//   5. atomicity       a failure part-way through rolls the whole thing back; a stale plan never runs
//   6. post-check      spots a removed Google event that came back as a blocking hold
//
// It never touches the shared test database: it takes a snapshot of its schema (tables + triggers), empties the
// in-scope tables, loads a small synthetic fixture and runs the CLI against throwaway copies in the OS temp dir.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync, execFileSync } = require('child_process');
const sqlite3 = require('sqlite3');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'cleanup-test-data.js');
const CUTOFF = '2026-06-30T23:59:59Z';
const OLD = '2026-05-10 10:00:00';        // before the cutoff
const NEW = '2026-08-01 10:00:00';        // after the cutoff

const ymd = (daysAhead) => new Date(Date.now() + daysAhead * 86400000).toISOString().slice(0, 10);
const FUT = ymd(45), FUT2 = ymd(60), PAST = '2026-05-12';

const open = (f, mode) => new Promise((res, rej) => { const d = new sqlite3.Database(f, mode || sqlite3.OPEN_READWRITE, e => e ? rej(e) : res(d)); });
const close = (d) => new Promise(res => d.close(() => res()));
const run = (d, sql, p = []) => new Promise((res, rej) => d.run(sql, p, function (e) { e ? rej(new Error(e.message + ' :: ' + sql.slice(0, 160))) : res(this); }));
const all = (d, sql, p = []) => new Promise((res, rej) => d.all(sql, p, (e, r) => e ? rej(e) : res(r)));
async function qdb(file, sql, p = []) { const d = await open(file, sqlite3.OPEN_READONLY); try { return await all(d, sql, p); } finally { await close(d); } }
const n = async (file, sql, p = []) => Object.values((await qdb(file, sql, p))[0])[0];
const has = async (file, table, where) => (await n(file, `SELECT count(*) FROM ${table} WHERE ${where}`)) > 0;

async function ins(d, table, obj) {
    const cols = Object.keys(obj);
    await run(d, `INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, cols.map(c => obj[c]));
}

// Per-table content hash, written independently of the tool so it can referee it.
async function tableHashes(file) {
    const d = await open(file, sqlite3.OPEN_READONLY);
    try {
        const out = {};
        for (const { name } of await all(d, "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")) {
            const rows = await all(d, `SELECT * FROM "${name}"`);
            const lines = rows.map(r => JSON.stringify(Object.keys(r).sort().map(k => [k, Buffer.isBuffer(r[k]) ? crypto.createHash('md5').update(r[k]).digest('hex') : r[k]]))).sort();
            out[name] = { n: rows.length, h: crypto.createHash('sha256').update(lines.join('\n')).digest('hex') };
        }
        return out;
    } finally { await close(d); }
}
const sameTable = (a, b, t) => a[t] && b[t] && a[t].h === b[t].h;

async function snapshot(src, dest) {
    const s = await open(src, sqlite3.OPEN_READONLY);
    try {
        await new Promise((resolve, reject) => {
            const b = s.backup(dest, e => { if (e) reject(e); });
            b.step(-1, e => e ? b.finish(() => reject(e)) : b.finish(e2 => e2 ? reject(e2) : resolve()));
        });
    } finally { await close(s); }
}

// Builds the template: the real schema + triggers, in-scope tables emptied, then the synthetic fixture.
async function buildTemplate(schemaSource, file) {
    await snapshot(schemaSource, file);
    const d = await open(file);
    try {
        await run(d, 'PRAGMA foreign_keys = OFF');
        // children first (bookings has BEFORE DELETE guards), audit_log last (delete triggers write to it)
        for (const t of ['run_of_show_items', 'advancing_contacts', 'advancing_packs', 'service_reviews', 'booking_notes', 'booking_services', 'booking_line_items',
            'booking_access_codes', 'booking_access_tokens', 'communication_log', 'consent_audit', 'reminders_log', 'payfast_payment_intents', 'cancellations', 'contracts',
            'transactions', 'payment_schedules', 'invoice_line_items', 'invoices', 'quote_line_items', 'quotations', 'expenses', 'payment_logs', 'date_holds', 'events',
            'abandoned_bookings', 'bookings', 'financial_audit_log', 'email_logs', 'notifications', 'admin_login_logs', 'inquiry_messages', 'audit_log']) await run(d, `DELETE FROM ${t}`);
        await run(d, 'UPDATE inquiries SET converted_booking_id = NULL');
        await run(d, 'UPDATE bank_statement_lines SET matched_booking_id = NULL, matched_transaction_id = NULL');
        await run(d, 'DELETE FROM bank_statement_lines');

        let client = (await all(d, 'SELECT id FROM clients LIMIT 1'))[0];
        if (!client) { await ins(d, 'clients', { full_name: 'Fixture Client', email: 'fixture.client@example.invalid' }); client = (await all(d, 'SELECT id FROM clients LIMIT 1'))[0]; }
        const cid = client.id;
        const admin = (await all(d, 'SELECT id FROM admins LIMIT 1'))[0].id;
        let svc = (await all(d, 'SELECT id FROM services LIMIT 1'))[0];
        if (!svc) throw new Error('fixture needs at least one services row in the schema source');
        const sid = svc.id;

        const booking = (id, o = {}) => ins(d, 'bookings', Object.assign({ id, name: `Fixture ${id}`, email: `fx${id}@example.invalid`, date: PAST, message: 'fixture', status: 'COMPLETED',
            payment_status: 'UNPAID', created_at: OLD, client_id: cid, is_public: 0, google_event_id: null }, o));
        await booking(1001, { google_event_id: 'gcal-b1001' });
        await booking(1002, { status: 'CONFIRMED', date: FUT, is_public: 1 });
        await booking(1003, { status: 'NEW', date: FUT2, created_at: NEW });
        await booking(1004);
        await booking(1005);
        await booking(1006, { payment_signature: 'fixture-signature' });
        await booking(1007);
        await booking(1008, { status: 'CANCELLED' });

        // B1001: one of everything that hangs off a booking
        await ins(d, 'booking_notes', { booking_id: 1001, note: 'n' });
        await ins(d, 'booking_services', { booking_id: 1001, service_id: sid });
        await ins(d, 'booking_line_items', { booking_id: 1001, description: 'li', unit_price: 10 });
        await ins(d, 'booking_access_codes', { booking_id: 1001, email: 'a@example.invalid', code_hash: 'h', expires_at: NEW });
        await ins(d, 'booking_access_tokens', { booking_id: 1001, email: 'a@example.invalid', token_hash: 'h', expires_at: NEW });
        await ins(d, 'communication_log', { booking_id: 1001, client_id: cid, direction: 'outgoing', channel: 'email', subject: 's' });
        await ins(d, 'consent_audit', { booking_id: 1001, consented_at: OLD });
        await ins(d, 'cancellations', { booking_id: 1001, cancelled_at: OLD });
        await ins(d, 'contracts', { id: 1, booking_id: 1001, template_version: 'v1', status: 'draft', created_at: OLD });
        await ins(d, 'expenses', { id: 1, booking_id: 1001, expense_date: PAST, description: 'fuel', amount: 100, created_at: OLD });
        await ins(d, 'advancing_packs', { id: 1, booking_id: 1001 });
        await ins(d, 'advancing_contacts', { pack_id: 1 });
        await ins(d, 'run_of_show_items', { pack_id: 1, title: 'doors' });
        await ins(d, 'service_reviews', { booking_id: 1001, rating: 5 });
        await ins(d, 'quotations', { id: 1, client_id: cid, booking_id: 1001, quote_number: 'Q-T-1', status: 'draft', created_at: OLD });
        await ins(d, 'quote_line_items', { quotation_id: 1, description: 'x', unit_price: 5 });
        await ins(d, 'invoices', { id: 1, booking_id: 1001, client_id: cid, invoice_number: 'INV-T-1', due_date: PAST, subtotal: 100, total_amount: 115, status: 'DRAFT', created_at: OLD });
        await ins(d, 'invoice_line_items', { invoice_id: 1, description: 'x', unit_price: 5 });
        await ins(d, 'payment_schedules', { id: 1, booking_id: 1001, invoice_id: 1, description: 'deposit', due_date: PAST, expected_amount: 50, status: 'pending', created_at: OLD });
        await ins(d, 'reminders_log', { booking_id: 1001, schedule_id: 1, days_before: 3, due_date: PAST, recipient_email: 'a@example.invalid' });
        await ins(d, 'transactions', { id: 1, booking_id: 1001, invoice_id: 1, amount: 50, transaction_date: PAST, payment_method: 'cash', transaction_type: 'payment', status: 'completed', source: 'manual', created_at: OLD });
        await ins(d, 'payment_logs', { booking_id: 1001, event_type: 'MANUAL_PAYMENT_RECORDED', timestamp: OLD, raw_payload: '{}' });
        await ins(d, 'events', { event_id: 1, event_title: 'Fixture linked event', event_datetime: PAST + ' 18:00', event_status: 'upcoming', booking_id: 1001, created_on: OLD });
        await ins(d, 'date_holds', { id: 1, hold_date: PAST, hold_expires_at: NEW, status: 'converted', converted_to_booking_id: 1001, event_id: 1, created_at: OLD });
        await run(d, 'UPDATE bookings SET event_id = 1, quotation_id = 1 WHERE id = 1001');       // the booking <-> event/quotation cycle
        await ins(d, 'bank_statement_lines', { id: 1, import_batch: 'b', import_date: OLD, statement_date: PAST, amount: 50, matched_booking_id: 1001, matched_transaction_id: 1 });
        await ins(d, 'inquiries', { sender_name: 'Fixture Sender', sender_email: 'sender@example.invalid', message_body: 'hello', converted_booking_id: 1001 });
        await ins(d, 'abandoned_bookings', { id: 1, draft_token: 'd1', converted_booking_id: 1001, created_at: OLD });
        await ins(d, 'notifications', { id: 1, type: 'email', status: 'sent', related_entity: 'booking', related_id: 1001, created_at: OLD });

        // B1002: public, confirmed, in the future  -> needs the public-events / upcoming-bookings acknowledgements
        await ins(d, 'events', { event_id: 2, event_title: 'Fixture public event', event_datetime: FUT + ' 19:00', event_status: 'upcoming', booking_id: 1002, created_on: OLD, google_calendar_event_id: 'gcal-e2' });
        // B1004: old, but a transaction was recorded after the cutoff -> kept
        await ins(d, 'transactions', { id: 4, booking_id: 1004, amount: 10, transaction_date: PAST, payment_method: 'cash', transaction_type: 'payment', status: 'completed', source: 'manual', created_at: NEW });
        // B1005: real-looking PayFast payment (numeric gateway id + merchant) -> HELD with everything on it
        await ins(d, 'transactions', { id: 5, booking_id: 1005, amount: 1000, transaction_date: PAST, payment_method: 'payfast', transaction_type: 'payment', status: 'completed', source: 'payfast', pf_payment_id: '3000001', created_at: OLD });
        await ins(d, 'payment_logs', { booking_id: 1005, event_type: 'VERIFIED_OK', timestamp: OLD, raw_payload: JSON.stringify({ merchant_id: '10012345', pf_payment_id: '3000001', amount_gross: '1000.00' }) });
        await ins(d, 'invoices', { id: 5, booking_id: 1005, client_id: cid, invoice_number: 'INV-T-5', due_date: PAST, subtotal: 1000, total_amount: 1000, status: 'PAID', created_at: OLD });
        // B1006: only hand-made PayFast fixtures (merchant 'TEST', payment id 'PF-TEST-001') -> NOT held, deleted
        await ins(d, 'payment_logs', { booking_id: 1006, event_type: 'ITN_RECEIVED', timestamp: OLD, raw_payload: JSON.stringify({ merchant_id: 'TEST', pf_payment_id: 'PF-TEST-001' }) });
        await ins(d, 'payment_logs', { booking_id: 1006, event_type: 'VERIFIED_OK', timestamp: OLD, raw_payload: JSON.stringify({ pf_payment_id: 'PF-FINAL-001' }) });
        // B1007: an unresolved PayFast payment intent -> held (conservative)
        await ins(d, 'payfast_payment_intents', { m_payment_id: 'mp-1', booking_id: 1007, expected_amount: 100 });

        // standalone / dangling records (finance rows cannot exist without a booking_id, so "standalone" = dangling)
        await ins(d, 'quotations', { id: 20, client_id: cid, quote_number: 'Q-T-20', status: 'draft', created_at: OLD });
        await ins(d, 'quotations', { id: 9, client_id: cid, quote_number: 'Q-T-9', status: 'draft', created_at: OLD });
        await run(d, 'UPDATE bookings SET quotation_id = 9, event_id = 9 WHERE id = 1003');       // a kept booking depends on an old quotation + event
        await ins(d, 'expenses', { id: 20, expense_date: PAST, description: 'standalone', amount: 5, created_at: OLD });
        await ins(d, 'transactions', { id: 20, booking_id: 99001, amount: 7, transaction_date: PAST, payment_method: 'cash', transaction_type: 'payment', status: 'completed', source: 'manual', created_at: OLD });
        await ins(d, 'transactions', { id: 21, booking_id: 99002, amount: 8, transaction_date: PAST, payment_method: 'payfast', transaction_type: 'payment', status: 'completed', source: 'payfast', created_at: OLD });
        await ins(d, 'payment_logs', { booking_id: 99001, event_type: 'MANUAL_PAYMENT_RECORDED', timestamp: OLD, raw_payload: '{}' });
        await ins(d, 'payment_logs', { booking_id: 99002, event_type: 'ITN_RECEIVED', timestamp: OLD, raw_payload: JSON.stringify({ merchant_id: '10012345', pf_payment_id: '3000002' }) });
        await ins(d, 'events', { event_id: 20, event_title: 'Fixture public tour date', event_datetime: FUT2 + ' 20:00', event_status: 'upcoming', created_on: OLD });
        await ins(d, 'events', { event_id: 9, event_title: 'Fixture standalone referenced by a kept booking', event_datetime: PAST + ' 20:00', event_status: 'completed', created_on: OLD });
        await ins(d, 'events', { event_id: 21, event_title: 'Fixture orphan event', event_datetime: PAST + ' 20:00', event_status: 'completed', booking_id: 99003, created_on: OLD });
        await ins(d, 'date_holds', { id: 20, hold_date: ymd(10), hold_expires_at: NEW, status: 'active', block_type: 'calendar_sync', google_event_id: 'gcal-mirror-1', created_at: OLD });
        await ins(d, 'date_holds', { id: 21, hold_date: PAST, hold_expires_at: NEW, status: 'active', block_type: 'unavailable', created_at: OLD });
        await ins(d, 'date_holds', { id: 22, hold_date: ymd(20), hold_expires_at: NEW, status: 'active', block_type: 'unavailable', created_at: OLD });

        // logs
        for (const [subject, trig] of [['a', 'Booking: Quote Generated'], ['b', 'Contact Form: Visitor Receipt'], ['c', 'Newsletter: Scheduled Campaign']]) {
            await ins(d, 'email_logs', { recipient_email: 'r@example.invalid', subject, status: 'sent', trigger_event: trig, sent_at: OLD });
        }
        await ins(d, 'admin_login_logs', { admin_id: admin, login_at: OLD });
        await ins(d, 'admin_login_logs', { admin_id: admin, login_at: OLD });
        await ins(d, 'notifications', { id: 2, type: 'email', status: 'sent', created_at: OLD });
        await ins(d, 'notifications', { id: 3, type: 'email', status: 'pending', created_at: OLD });
        await ins(d, 'notifications', { id: 4, type: 'email', status: 'sent', created_at: OLD });
        await ins(d, 'inquiries', { inquiry_id: 9001, sender_name: 'Second Sender', sender_email: 's2@example.invalid', message_body: 'hi' });
        await ins(d, 'inquiry_messages', { inquiry_id: 9001, direction: 'out', notification_id: 4 });
        await run(d, 'DELETE FROM audit_log');           // fixture inserts fired the audit triggers - start the audit log from a known state
        await ins(d, 'audit_log', { table_name: 'bookings', record_id: 1001, action: 'UPDATE', change_timestamp: OLD });
        await ins(d, 'audit_log', { table_name: 'bookings', record_id: 1005, action: 'UPDATE', change_timestamp: OLD });
        await ins(d, 'audit_log', { table_name: 'gallery_images', record_id: 5, action: 'UPDATE', change_timestamp: OLD });
        await ins(d, 'financial_audit_log', { event_type: 'LEDGER_SYNC', entity_type: 'booking', entity_id: 1001, changed_by: 'system', timestamp: OLD });
        await ins(d, 'financial_audit_log', { event_type: 'LEDGER_SYNC', entity_type: 'booking', entity_id: 1005, changed_by: 'system', timestamp: OLD });
        await ins(d, 'financial_audit_log', { event_type: 'SERVICE_UPDATED', entity_type: 'service', entity_id: sid, changed_by: 'admin', timestamp: OLD });
        await run(d, 'PRAGMA wal_checkpoint(TRUNCATE)');
    } finally { await close(d); }
}

module.exports = async function ({ check, TEST_DB }) {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-suite-'));
    const template = path.join(work, 'template.sqlite');
    let seq = 0;
    const fresh = (setup) => {                                  // a throwaway copy of the fixture database
        const dir = path.join(work, 's' + (++seq));
        fs.mkdirSync(dir);
        const db = path.join(dir, 'db.sqlite');
        fs.copyFileSync(template, db);
        return { dir, db, out: path.join(dir, 'out') };
    };
    const cli = (args) => {
        const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8', timeout: 180000, env: { ...process.env, NODE_ENV: 'test' } });
        return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
    };
    const base = (s, extra = []) => ['--db', s.db, '--cutoff', CUTOFF, '--out-dir', s.out, ...extra];
    const fingerprint = (r) => (r.out.match(/PLAN FINGERPRINT: (\w+)/) || [])[1];
    const ACKS = 'public-events,upcoming-bookings,future-blocks';
    const manifestOf = (r) => JSON.parse(fs.readFileSync((r.out.match(/Manifest : (.+)/) || [])[1].trim(), 'utf8'));
    // plan -> run for real, as an operator would
    const runForReal = (s, extra = [], acks = ACKS, cliExtra = []) => {
        const dry = cli(base(s, extra));
        const fp = fingerprint(dry);
        const real = cli([...base(s, extra), '--execute', '--plan', fp, '--acknowledge', acks, ...cliExtra]);
        return { dry, real, fp };
    };

    try {
        await buildTemplate(TEST_DB, template);
        const baseline = await tableHashes(template);
        check('fixture: the template holds the fixture bookings and a copy of the real schema/triggers',
            (await n(template, 'SELECT count(*) FROM bookings')) === 8 && (await n(template, "SELECT count(*) FROM sqlite_master WHERE type='trigger'")) > 40, '');

        // ══════════ 1. the guards ══════════
        const g = fresh();
        const before = await tableHashes(g.db);
        let r = cli(['--db', g.db, '--out-dir', g.out]);
        check('guard: refuses to run without --cutoff (usage error 64)', r.code === 64 && /--cutoff is required/.test(r.out), r.out.slice(0, 200));
        r = cli(['--cutoff', CUTOFF, '--out-dir', g.out]);
        check('guard: --db has no default (a forgotten flag can never hit the dev or live database)', r.code === 64 && /--db is required/.test(r.out), r.out.slice(0, 200));
        r = cli(['--db', g.db, '--cutoff', 'not-a-date', '--out-dir', g.out]);
        check('guard: refuses an unparsable cutoff', r.code === 64, r.out.slice(0, 200));
        r = cli(['--db', g.db, '--cutoff', CUTOFF, '--out-dir', path.join(ROOT, 'leak-test-out')]);
        check('guard: refuses an --out-dir inside the (public) project folder, and creates nothing there', r.code === 2 && /inside the project folder/.test(r.out) && !fs.existsSync(path.join(ROOT, 'leak-test-out')), r.out.slice(0, 200));
        const junk = path.join(g.dir, 'junk.sqlite'); fs.writeFileSync(junk, 'this is not a database');
        r = cli(['--db', junk, '--cutoff', CUTOFF, '--out-dir', g.out]);
        check('guard: refuses a file that is not a SQLite database', r.code === 2 && /not a SQLite database/.test(r.out), r.out.slice(0, 200));
        r = cli(base(g, ['--payfast-hold', 'release']));
        check('guard: releasing the PayFast hold needs the explicit --confirm-payfast-verified', r.code === 64 && /confirm-payfast-verified/.test(r.out), r.out.slice(0, 200));
        r = cli([...base(g), '--execute']);
        check('guard: --execute without a reviewed --plan is refused', r.code === 64 && /--plan/.test(r.out), r.out.slice(0, 200));
        r = cli([...base(g), '--execute', '--plan', 'deadbeef', '--acknowledge', ACKS]);
        check('guard: a --plan that does not match the current data is refused', r.code === 2 && /does not match the current plan/.test(r.out), r.out.slice(0, 200));
        const dry0 = cli(base(g));
        r = cli([...base(g), '--execute', '--plan', fingerprint(dry0)]);
        check('guard: public-site / upcoming-booking / future-block removal needs explicit acknowledgement',
            r.code === 2 && /this plan needs --acknowledge/.test(r.out) && ['public-events', 'upcoming-bookings', 'future-blocks'].every(t => r.out.includes(t)), r.out.slice(-300));
        const afterGuards = await tableHashes(g.db);
        check('guard: every refusal left the database byte-identical', Object.keys(before).every(t => sameTable(before, afterGuards, t)), '');

        // ══════════ 2. dry run ══════════
        check('dry run: exits 0, prints the plan fingerprint, writes a manifest and changes nothing',
            dry0.code === 0 && /PLAN FINGERPRINT: \w+/.test(dry0.out) && /Nothing was changed/.test(dry0.out) && Object.keys(before).every(t => sameTable(before, afterGuards, t)), dry0.out.slice(-300));
        check('dry run: rehearses on a private copy first - the rehearsal passed', /Rehearsal passed/.test(dry0.out), dry0.out.slice(-400));
        const m0 = manifestOf(dry0);
        const idsOf = (k) => m0.plan.sets[k].slice().sort((a, b) => a - b).join(',');
        check('dry run plan: removes B1001, B1002, B1006, B1008', idsOf('cl_del_booking') === '1001,1002,1006,1008', idsOf('cl_del_booking'));
        check('dry run plan: keeps B1003 (created after the cutoff) and B1004 (a transaction after the cutoff)',
            m0.plan.kept.bookingsAfterCutoffOrUndated.join() === '1003' && m0.plan.kept.bookingsWithNewerRecords.join() === '1004', JSON.stringify(m0.plan.kept.bookingsAfterCutoffOrUndated) + JSON.stringify(m0.plan.kept.bookingsWithNewerRecords));
        check('dry run plan: holds B1005 (numeric PayFast id) and B1007 (payment intent) but NOT B1006 (hand-made PF-TEST ids)',
            m0.plan.kept.payfastHeldBookings.join() === '1005,1007', m0.plan.kept.payfastHeldBookings.join());
        check('dry run plan: lists the gateway ids to check on the PayFast dashboard, fixtures excluded',
            m0.plan.kept.payfastToVerify.map(p => p.pf_payment_id).sort().join() === '3000001,3000002', JSON.stringify(m0.plan.kept.payfastToVerify));
        check('dry run plan: flags public events, future blocks and upcoming bookings for acknowledgement',
            m0.plan.requiredAcks.join() === 'public-events,future-blocks,upcoming-bookings', m0.plan.requiredAcks.join());
        check('dry run plan: lists the Google event ids that must be removed from Google Calendar by hand',
            ['gcal-b1001', 'gcal-e2'].every(id => m0.plan.googleEvents.some(e => e.gid === id)) && !m0.plan.googleEvents.some(e => e.gid === 'gcal-mirror-1'), JSON.stringify(m0.plan.googleEvents));

        // ══════════ 3. a real run, default options ══════════
        const s1 = fresh();
        const pre1 = await tableHashes(s1.db);
        const preFk = (await qdb(s1.db, 'PRAGMA foreign_key_check')).length;
        const run1 = runForReal(s1);
        const D = s1.db;
        const outListing = fs.readdirSync(s1.out);          // taken before this test opens the backup itself (which would create -wal/-shm)
        check('real run: exits 0 and says COMMITTED', run1.real.code === 0 && /COMMITTED/.test(run1.real.out), run1.real.out.slice(-600));
        const man1 = manifestOf(run1.real);
        const bk = man1.backup;
        check('backup: a verified backup file exists with a matching sha256 sidecar and passes integrity_check',
            bk && fs.existsSync(bk.file) && fs.readFileSync(bk.file + '.sha256', 'utf8').startsWith(bk.sha256) &&
            crypto.createHash('sha256').update(fs.readFileSync(bk.file)).digest('hex') === bk.sha256 && (await qdb(bk.file, 'PRAGMA integrity_check'))[0].integrity_check === 'ok', JSON.stringify(bk));
        const bkHashes = await tableHashes(bk.file);
        check('backup: it is a faithful copy of the database as it was before the run (every table identical)', Object.keys(pre1).every(t => sameTable(pre1, bkHashes, t)), Object.keys(pre1).filter(t => !sameTable(pre1, bkHashes, t)).join());
        check('backup: no stray -wal/-shm files are left beside it', !outListing.some(f => /-(wal|shm)$/.test(f)), outListing.join());

        check('bookings: the test bookings (1001, 1002, 1006, 1008) are gone',
            (await n(D, 'SELECT count(*) FROM bookings WHERE id IN (1001,1002,1006,1008)')) === 0, '');
        check('bookings: held (1005, 1007), post-cutoff (1003) and newer-record (1004) bookings survive intact',
            (await qdb(D, 'SELECT id FROM bookings ORDER BY id')).map(x => x.id).join() === '1003,1004,1005,1007', '');
        check('bookings: everything that hung off a removed booking is gone (notes, services, lines, codes, tokens, comms, consent, cancellations, contracts, expenses, advancing, reviews, schedules, reminders)',
            (await Promise.all(['booking_notes', 'booking_services', 'booking_line_items', 'booking_access_codes', 'booking_access_tokens', 'communication_log', 'consent_audit', 'cancellations', 'contracts',
                'expenses', 'advancing_packs', 'advancing_contacts', 'run_of_show_items', 'service_reviews', 'payment_schedules', 'reminders_log', 'quote_line_items', 'invoice_line_items'].map(t => n(D, `SELECT count(*) FROM ${t}`)))).every(c => c === 0)
            || (await n(D, 'SELECT count(*) FROM expenses')) === 0, '');
        check('bookings: the abandoned-booking lead tied to a removed booking is gone', (await n(D, 'SELECT count(*) FROM abandoned_bookings')) === 0, '');
        check('finance: the test quotation/invoice/transaction are gone, the held PayFast ones are kept',
            !(await has(D, 'quotations', 'id IN (1,20)')) && !(await has(D, 'invoices', 'id = 1')) && !(await has(D, 'transactions', 'id IN (1,20)')) &&
            (await has(D, 'invoices', 'id = 5')) && (await has(D, 'transactions', 'id IN (4,5,21)')), '');
        check('finance: a quotation still used by a kept booking (Q9) survives although it is old', await has(D, 'quotations', 'id = 9'), '');
        check('finance: standalone expense and dangling test payment log are gone; the dangling PayFast log is held',
            !(await has(D, 'expenses', 'id = 20')) && (await n(D, 'SELECT count(*) FROM payment_logs WHERE booking_id = 99001')) === 0 && (await n(D, 'SELECT count(*) FROM payment_logs WHERE booking_id = 99002')) === 1, '');
        check('finance: the hand-made PF-TEST payment logs of B1006 are removed with it; the numeric PayFast log of B1005 stays',
            (await n(D, 'SELECT count(*) FROM payment_logs WHERE booking_id = 1006')) === 0 && (await n(D, 'SELECT count(*) FROM payment_logs WHERE booking_id = 1005')) === 1, '');
        check('calendar: linked events and test holds are gone; the public tour date and the event a kept booking uses survive',
            !(await has(D, 'events', 'event_id IN (1,2,21)')) && (await has(D, 'events', 'event_id IN (20,9)')) && !(await has(D, 'date_holds', 'id IN (1,21,22)')), '');
        check('calendar: the Google-mirrored hold survives by default', await has(D, 'date_holds', "id = 20 AND block_type = 'calendar_sync'"), '');
        const inq = (await qdb(D, 'SELECT converted_booking_id, sender_name, message_body FROM inquiries WHERE sender_email = ?', ['sender@example.invalid']))[0];
        check('inquiries: the client-facing inquiry survives; only its link to the removed booking is cleared', inq && inq.converted_booking_id === null && inq.sender_name === 'Fixture Sender' && inq.message_body === 'hello', JSON.stringify(inq));
        const bl = (await qdb(D, 'SELECT matched_booking_id, matched_transaction_id, amount FROM bank_statement_lines WHERE id = 1'))[0];
        check('bank statement: the imported bank line is NOT deleted, just unmatched', bl && bl.matched_booking_id === null && bl.matched_transaction_id === null && bl.amount === 50, JSON.stringify(bl));
        check('logs (booking-finance scope): booking emails go; contact-form and newsletter history stays',
            (await qdb(D, 'SELECT trigger_event FROM email_logs ORDER BY id')).map(x => x.trigger_event).join('|') === 'Contact Form: Visitor Receipt|Newsletter: Scheduled Campaign', '');
        check('logs (booking-finance scope): the booking-linked notification goes; unrelated, pending and inquiry-linked ones stay',
            (await qdb(D, 'SELECT id FROM notifications ORDER BY id')).map(x => x.id).join() === '2,3,4', '');
        check('logs (booking-finance scope): login activity is untouched', (await n(D, 'SELECT count(*) FROM admin_login_logs')) === 2, '');
        check('audit: rows about removed bookings are gone, rows about a held booking and unrelated records stay, and one cleanup marker is added',
            !(await has(D, 'audit_log', "table_name='bookings' AND record_id=1001")) && (await has(D, 'audit_log', "table_name='bookings' AND record_id=1005")) &&
            (await has(D, 'audit_log', "table_name='gallery_images'")) && (await n(D, "SELECT count(*) FROM audit_log WHERE action='TEST_DATA_CLEANUP'")) === 1, '');
        check('audit: the DELETE triggers on events/date_holds left no audit rows holding the removed content',
            (await n(D, "SELECT count(*) FROM audit_log WHERE table_name IN ('events','date_holds') AND record_id IN (1,2,21)")) === 0 && (await n(D, "SELECT count(*) FROM audit_log WHERE table_name='date_holds' AND action='DELETE'")) === 0, '');
        check('audit: financial log rows of the removed booking are gone; held and catalogue rows stay in this scope',
            !(await has(D, 'financial_audit_log', "entity_type='booking' AND entity_id=1001")) && (await has(D, 'financial_audit_log', "entity_type='booking' AND entity_id=1005")) && (await has(D, 'financial_audit_log', "entity_type='service'")), '');
        const post1 = await tableHashes(D);
        const touched = new Set(Object.keys(require('../scripts/cleanup-test-data').TOUCHED_TABLES));
        const unexpected = Object.keys(pre1).filter(t => !sameTable(pre1, post1, t) && !touched.has(t));
        check('preservation: every table the tool is not allowed to touch is byte-identical (users, clients, settings, services, venues, newsletter, site content, public analytics ...)', unexpected.length === 0, unexpected.join());
        check('preservation: ' + Object.keys(pre1).filter(t => sameTable(pre1, post1, t)).length + ' tables identical, including admins, clients, settings, services, venues, analytics_pageviews',
            ['admins', 'clients', 'settings', 'services', 'venues', 'analytics_pageviews', 'newsletter_subscribers', 'team_members', 'testimonials'].every(t => sameTable(pre1, post1, t)), '');
        check('integrity: integrity_check ok, no new foreign-key violations',
            (await qdb(D, 'PRAGMA integrity_check'))[0].integrity_check === 'ok' && (await qdb(D, 'PRAGMA foreign_key_check')).length <= preFk, '');
        check('integrity: no row still points at a removed booking', (await n(D, `SELECT
            (SELECT count(*) FROM transactions WHERE booking_id NOT IN (SELECT id FROM bookings) AND booking_id IN (1001,1002,1006,1008)) +
            (SELECT count(*) FROM events WHERE booking_id IN (1001,1002,1006,1008)) + (SELECT count(*) FROM date_holds WHERE converted_to_booking_id IN (1001,1002,1006,1008)) +
            (SELECT count(*) FROM inquiries WHERE converted_booking_id IN (1001,1002,1006,1008))`)) === 0, '');
        check('sequence: ids are never reused (no AUTOINCREMENT counter goes backwards), so a removed id cannot resurface on a new row',
            (await (async () => { const a = await qdb(template, 'SELECT name, seq FROM sqlite_sequence'), b = Object.fromEntries((await qdb(D, 'SELECT name, seq FROM sqlite_sequence')).map(x => [x.name, x.seq])); return a.every(x => b[x.name] >= x.seq) && a.filter(x => x.name !== 'audit_log').every(x => b[x.name] === x.seq); })()), '');

        // ══════════ 4. the options ══════════
        // 4a. logs scope "all" and "everything"
        const sa = fresh(); const ra = runForReal(sa, ['--logs-scope', 'all']);
        check('logs scope "all": every email log goes (contact form + newsletter too), old notifications and catalogue financial-log rows go, login logs stay, pending/inquiry-linked/held stay',
            ra.real.code === 0 && (await n(sa.db, 'SELECT count(*) FROM email_logs')) === 0 && (await qdb(sa.db, 'SELECT id FROM notifications ORDER BY id')).map(x => x.id).join() === '3,4' &&
            !(await has(sa.db, 'financial_audit_log', "entity_type='service'")) && (await has(sa.db, 'financial_audit_log', "entity_type='booking' AND entity_id=1005")) &&
            !(await has(sa.db, 'audit_log', "table_name='gallery_images'")) && (await has(sa.db, 'audit_log', "table_name='bookings' AND record_id=1005")) && (await n(sa.db, 'SELECT count(*) FROM admin_login_logs')) === 2, ra.real.out.slice(-400));
        const se = fresh(); const re = runForReal(se, ['--logs-scope', 'everything']);
        check('logs scope "everything": login-activity logs go too', re.real.code === 0 && (await n(se.db, 'SELECT count(*) FROM admin_login_logs')) === 0, re.real.out.slice(-300));

        // 4b. releasing the PayFast hold
        const sr = fresh(); const rr = runForReal(sr, ['--payfast-hold', 'release', '--confirm-payfast-verified']);
        check('PayFast released: the held bookings, transactions and logs are removed like any other test data',
            rr.real.code === 0 && (await qdb(sr.db, 'SELECT id FROM bookings ORDER BY id')).map(x => x.id).join() === '1003,1004' &&
            (await n(sr.db, 'SELECT count(*) FROM transactions WHERE id IN (5,21)')) === 0 && (await n(sr.db, 'SELECT count(*) FROM payment_logs WHERE booking_id IN (1005,99002)')) === 0 &&
            (await n(sr.db, 'SELECT count(*) FROM payfast_payment_intents')) === 0, rr.real.out.slice(-400));

        // 4c. standalone events + Google-mirrored holds on request
        const so = fresh(); const ro = runForReal(so, ['--include-standalone-events', '--include-calendar-sync']);
        check('--include-standalone-events: the public tour date goes, but an event a kept booking still uses is protected',
            ro.real.code === 0 && !(await has(so.db, 'events', 'event_id = 20')) && (await has(so.db, 'events', 'event_id = 9')), ro.real.out.slice(-300));
        check('--include-calendar-sync: the Google-mirrored hold goes too', !(await has(so.db, 'date_holds', 'id = 20')), '');

        // 4d. a cutoff earlier than everything keeps everything
        const sc = fresh();
        const rc = cli(['--db', sc.db, '--cutoff', '2020-01-01T00:00:00Z', '--out-dir', sc.out, '--logs-scope', 'everything']);
        const mc = manifestOf(rc);
        check('cutoff: a cutoff before every record puts nothing in scope (bookings, finance, calendar, logs)',
            rc.code === 0 && mc.plan.sets.cl_del_booking.length === 0 && mc.plan.sets.cl_del_tx.length === 0 && mc.plan.sets.cl_del_event.length === 0 && mc.plan.sets.cl_del_email.length === 0 && mc.plan.sets.cl_del_login.length === 0, JSON.stringify(Object.fromEntries(Object.entries(mc.plan.sets).map(([k, v]) => [k, v.length]))));

        // 4e. an older database layout: production runs the deployed code, which predates the Microsoft 365 contact-form
        // work, so it has no inquiry_messages table. The tool once failed there ("no such table") - it must cope.
        const so2 = fresh();
        const dbo = await open(so2.db);
        await run(dbo, 'DROP TABLE inquiry_messages');
        await close(dbo);
        const ro2 = runForReal(so2);
        check('older layout: a database without inquiry_messages is planned and cleaned normally (and says so)',
            ro2.dry.code === 0 && /older version of the app/.test(ro2.dry.out) && ro2.real.code === 0 && /COMMITTED/.test(ro2.real.out) &&
            (await qdb(so2.db, 'SELECT id FROM bookings ORDER BY id')).map(x => x.id).join() === '1003,1004,1005,1007', ro2.dry.out.slice(0, 300) + ro2.real.out.slice(-300));
        check('older layout: the stand-in for the missing table is never written into the database file',
            (await n(so2.db, "SELECT count(*) FROM sqlite_master WHERE name = 'inquiry_messages'")) === 0, '');
        check('older layout: protections that do not depend on that table still hold (inquiry-related notification rules, held PayFast bookings)',
            (await has(so2.db, 'bookings', 'id IN (1005,1007)')) && (await has(so2.db, 'inquiries', "sender_email = 'sender@example.invalid'")), '');

        // ══════════ 5. atomicity ══════════
        const sx = fresh();
        const preX = await tableHashes(sx.db);
        const dbx = await open(sx.db);
        await run(dbx, "CREATE TRIGGER zz_block_quotation_delete BEFORE DELETE ON quotations BEGIN SELECT RAISE(ABORT, 'blocked by test'); END");
        await close(dbx);
        const preX2 = await tableHashes(sx.db);
        const dryX = cli(base(sx, ['--no-rehearsal']));
        const realX = cli([...base(sx, ['--no-rehearsal']), '--execute', '--plan', fingerprint(dryX), '--acknowledge', ACKS]);
        const postX = await tableHashes(sx.db);
        check('atomicity: a failure part-way through (a trigger that blocks one delete) exits non-zero and ROLLS BACK',
            realX.code === 1 && /ROLLED BACK/.test(realX.out), realX.out.slice(-400));
        check('atomicity: after the rollback every table is byte-identical - nothing was half-deleted', Object.keys(preX2).every(t => sameTable(preX2, postX, t)), Object.keys(preX2).filter(t => !sameTable(preX2, postX, t)).join());
        const dryX2 = cli(base(sx));
        check('atomicity: the dry-run rehearsal reports the same failure and prints no fingerprint to execute with', dryX2.code === 1 && /REHEARSAL FAILED/.test(dryX2.out) && !fingerprint(dryX2), dryX2.out.slice(-300));
        const realX2 = cli([...base(sx), '--execute', '--plan', fingerprint(dryX), '--acknowledge', ACKS]);
        const postX2 = await tableHashes(sx.db);
        check('atomicity: --execute rehearses first, so the failure is caught before the live database is even locked', realX2.code === 1 && /REHEARSAL FAILED/.test(realX2.out) && !/Taking the write lock/.test(realX2.out) && Object.keys(preX2).every(t => sameTable(preX2, postX2, t)), realX2.out.slice(-300));

        const sy = fresh();
        const dryY = cli(base(sy));
        const dby = await open(sy.db);
        await ins(dby, 'bookings', { id: 1099, name: 'Late arrival', email: 'late@example.invalid', date: PAST, message: 'x', status: 'NEW', payment_status: 'UNPAID', created_at: OLD, is_public: 0 });
        await close(dby);
        const preY = await tableHashes(sy.db);
        const realY = cli([...base(sy), '--execute', '--plan', fingerprint(dryY), '--acknowledge', ACKS]);
        const postY = await tableHashes(sy.db);
        check('stale plan: data that changed after the dry run makes --execute refuse, and nothing is deleted',
            realY.code === 2 && /does not match the current plan/.test(realY.out) && Object.keys(preY).every(t => sameTable(preY, postY, t)), realY.out.slice(-300));

        // ══════════ 6. post-check ══════════
        const pc1 = cli(['--db', D, '--post-check', run1.real.out.match(/Manifest : (.+)/)[1].trim()]);
        check('post-check: passes right after a clean run', pc1.code === 0 && /PASS  cleanup marker present/.test(pc1.out) && !/FAIL/.test(pc1.out), pc1.out.slice(-500));
        const dbg = await open(D);
        await ins(dbg, 'date_holds', { hold_date: ymd(12), hold_expires_at: NEW, status: 'active', block_type: 'calendar_sync', google_event_id: 'gcal-b1001' });
        await close(dbg);
        const pc2 = cli(['--db', D, '--post-check', run1.real.out.match(/Manifest : (.+)/)[1].trim()]);
        check('post-check: spots a removed booking\'s Google event that the calendar sync re-imported as a blocking hold',
            pc2.code === 1 && /FAIL.*came back as date_holds/.test(pc2.out), pc2.out.slice(-500));
        const pc3 = cli(['--db', D, '--post-check', manifestOf(dry0) && path.join(s1.out, fs.readdirSync(s1.out).filter(f => f.endsWith('.json')).sort()[0])]);
        check('post-check: refuses a dry-run manifest (it only makes sense after a real run)', pc3.code !== 0, pc3.out.slice(-200));

        // ══════════ 7. the root cause stays fixed ══════════
        let tracked = null;
        try { tracked = execFileSync('git', ['ls-files', '*.sqlite', '*.sqlite3', '*.db'], { cwd: ROOT, encoding: 'utf8', timeout: 20000 }).trim(); } catch (e) { /* no git here */ }
        check('prevention: no SQLite database file is tracked by git (a tracked dev database was deployed over production before)', tracked === null || tracked === '', tracked || '');
        check('prevention: the cleanup tool never loads the app database module (opening it would run migrations)', !/require\(['"]\.\.\/database['"]\)/.test(fs.readFileSync(SCRIPT, 'utf8').replace(/\/\/[^\n]*/g, '')), '');
    } finally {
        try { fs.rmSync(work, { recursive: true, force: true }); } catch (e) { /* best effort */ }
    }
};
