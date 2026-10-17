#!/usr/bin/env node
// Controlled removal of TEST transactional data (Bookings, Calendar/Events, Finance, Logs) from a
// SQLite database - built for the production clean-up of Oct 2026. Full runbook:
// docs-internal/production-test-data-cleanup.md
//
// Safe by construction:
//   * DRY-RUN BY DEFAULT. Without --execute the source database is opened read-only. The dry run still
//     performs a full REHEARSAL: it copies the database to a private temp file, runs the exact same delete
//     code there, verifies it, prints the before/after numbers and throws the copy away.
//   * Rule-driven, not ID-driven (production may hold rows the dev copy never had). A mandatory --cutoff
//     keeps everything created after it, plus anything those newer rows depend on.
//   * --execute needs --plan <fingerprint> printed by the dry run. The plan is recomputed inside the write
//     lock; if the data moved since you reviewed it, nothing runs.
//   * Under that same write lock it takes a verified online backup (SQLite backup API - WAL-safe, unlike a
//     file copy), then deletes in ONE transaction and rolls back on any anomaly: a row count that differs
//     from the plan, a new foreign-key violation, a leftover reference, or any change to a table the tool
//     must not touch (proved with a before/after content hash of every untouched table).
//   * It never drops or disables a trigger, never touches users, clients, settings, services, venues,
//     inquiries (beyond clearing the converted_booking_id link), newsletter, site content or public web
//     analytics, never calls a payment provider or Google, and never deletes files on disk.
//   * PayFast-originated records are HELD (kept, with everything attached to them) until the owner has
//     checked them against the PayFast dashboard and re-runs with --payfast-hold release.
//
// It opens SQLite directly - it must NOT require('../database'), which runs migrations on open.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const sqlite3 = require('sqlite3');

const TOOL_VERSION = '1.0.0';
const PROJECT_ROOT = path.resolve(__dirname, '..');

// ──────────────────────────────── CLI ────────────────────────────────

const LOG_SCOPES = ['booking-finance', 'all', 'everything'];
const ACK_TOKENS = ['public-events', 'future-blocks', 'upcoming-bookings'];

function usage() {
    return `
Usage: node scripts/cleanup-test-data.js --db <file> --cutoff <ISO date-time> --out-dir <dir> [options]

Required
  --db <file>             SQLite database to clean (no default - this is deliberate)
  --cutoff <ISO>          only rows created on/before this instant are in scope, e.g. 2026-10-17T23:59:59Z
  --out-dir <dir>         where the manifest and (with --execute) the backup are written. Must be OUTSIDE
                          the project folder (the repository is public).

Modes
  (default)               dry run + rehearsal on a throwaway copy; prints the plan fingerprint
  --execute --plan <fp>   really delete. <fp> is the fingerprint printed by the matching dry run.

Scope options
  --payfast-hold keep|release   keep (default): PayFast-originated records and everything attached to them
                                are retained. release: treat them as test data (needs --confirm-payfast-verified).
  --confirm-payfast-verified    you have checked the PayFast dashboard and no real money is involved.
  --logs-scope booking-finance|all|everything
                                booking-finance (default): logs tied to the removed records.
                                all: every email/audit/payment/financial log (not login logs).
                                everything: as 'all' plus admin login-activity logs.
  --include-standalone-events   also delete events with no booking (the public tour dates). Default: keep.
  --include-calendar-sync       also delete date_holds mirrored from Google Calendar. Default: keep.
  --post-check <manifest.json>  read-only follow-up after a real run (needs only --db): confirms the cleanup marker,
                                that no removed Google event came back as a hold, and what changed since.
  --acknowledge <list>          comma list of: ${ACK_TOKENS.join(', ')} - required when the plan would remove
                                public-site events, future date blocks or upcoming bookings.
`;
}

function parseArgs(argv) {
    const o = { payfastHold: 'keep', logsScope: 'booking-finance', acks: [] };
    const need = (i, name) => { if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new UsageError(`${name} needs a value`); return argv[i + 1]; };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        switch (a) {
            case '--db': o.db = need(i, a); i++; break;
            case '--cutoff': o.cutoffRaw = need(i, a); i++; break;
            case '--out-dir': o.outDir = need(i, a); i++; break;
            case '--plan': o.plan = need(i, a); i++; break;
            case '--payfast-hold': o.payfastHold = need(i, a); i++; break;
            case '--logs-scope': o.logsScope = need(i, a); i++; break;
            case '--acknowledge': o.acks = need(i, a).split(',').map(s => s.trim()).filter(Boolean); i++; break;
            case '--execute': o.execute = true; break;
            case '--confirm-payfast-verified': o.confirmPayfast = true; break;
            case '--include-standalone-events': o.includeStandaloneEvents = true; break;
            case '--include-calendar-sync': o.includeCalendarSync = true; break;
            case '--no-rehearsal': o.noRehearsal = true; break;
            case '--post-check': o.postCheck = need(i, a); i++; break;
            case '--help': case '-h': o.help = true; break;
            default: throw new UsageError(`unknown option ${a}`);
        }
    }
    if (o.help) return o;
    if (!o.db) throw new UsageError('--db is required');
    if (o.postCheck) return o;                                   // read-only follow-up: needs nothing else
    if (!o.cutoffRaw) throw new UsageError('--cutoff is required');
    if (!o.outDir) throw new UsageError('--out-dir is required');
    const d = new Date(o.cutoffRaw);
    if (isNaN(d.getTime())) throw new UsageError(`--cutoff "${o.cutoffRaw}" is not a valid date-time`);
    o.cutoffIso = d.toISOString();
    o.cutoff = o.cutoffIso.replace('T', ' ').slice(0, 19);           // SQLite datetime() text, UTC
    if (!['keep', 'release'].includes(o.payfastHold)) throw new UsageError('--payfast-hold must be keep or release');
    if (!LOG_SCOPES.includes(o.logsScope)) throw new UsageError(`--logs-scope must be one of ${LOG_SCOPES.join(', ')}`);
    if (o.payfastHold === 'release' && !o.confirmPayfast) throw new UsageError('--payfast-hold release also needs --confirm-payfast-verified');
    for (const t of o.acks) if (!ACK_TOKENS.includes(t)) throw new UsageError(`unknown --acknowledge token "${t}"`);
    if (o.execute && !o.plan) throw new UsageError('--execute needs --plan <fingerprint> from a dry run');
    return o;
}

class UsageError extends Error {}
class Refusal extends Error {}   // a safety guard said no (exit 2)

// ──────────────────────────────── sqlite helpers ────────────────────────────────

const open = (file, mode) => new Promise((res, rej) => {
    const db = new sqlite3.Database(file, mode, (e) => e ? rej(e) : res(db));
});
const close = (db) => new Promise((res) => db.close(() => res()));
const needsCutoff = (sql) => sql.includes('$cutoff');
function bindFor(sql, ctx) {
    const p = {};
    if (needsCutoff(sql)) p.$cutoff = ctx.cutoff;
    return p;
}
const run = (db, sql, ctx) => new Promise((res, rej) => db.run(sql, ctx ? bindFor(sql, ctx) : {}, function (e) { e ? rej(new Error(`${e.message}\n  while running: ${sql.replace(/\s+/g, ' ').slice(0, 300)}`)) : res(this.changes); }));
const all = (db, sql, ctx) => new Promise((res, rej) => db.all(sql, ctx ? bindFor(sql, ctx) : {}, (e, r) => e ? rej(new Error(`${e.message}\n  while running: ${sql.replace(/\s+/g, ' ').slice(0, 300)}`)) : res(r)));
const get = async (db, sql, ctx) => (await all(db, sql, ctx))[0];
const scalar = async (db, sql, ctx) => { const r = await get(db, sql, ctx); return r ? Object.values(r)[0] : undefined; };
const exec = (db, sql) => new Promise((res, rej) => db.exec(sql, (e) => e ? rej(e) : res()));

// Snapshot of the database file via the SQLite online-backup API (consistent even while the app writes).
async function backupTo(sourceFile, destFile) {
    const src = await open(sourceFile, sqlite3.OPEN_READONLY);
    try {
        await new Promise((resolve, reject) => {
            const b = src.backup(destFile, (e) => { if (e) reject(e); });
            b.step(-1, (e) => {
                if (e) return b.finish(() => reject(e));
                b.finish((e2) => e2 ? reject(e2) : resolve());
            });
        });
    } finally { await close(src); }
}

const sha256File = (file) => new Promise((res, rej) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', d => h.update(d)).on('error', rej).on('end', () => res(h.digest('hex')));
});

// ──────────────────────────────── the rules ────────────────────────────────

// "created on or before the cutoff". An unparsable / missing date is NOT old: the row stays and is reported.
const OLD = (col) => `(datetime(${col}) IS NOT NULL AND datetime(${col}) <= datetime($cutoff))`;

// What counts as evidence that a record came from PayFast (the live gateway). The gateway always assigns a
// NUMERIC pf_payment_id and sends a NUMERIC merchant_id; the hand-made ITNs in the data ('TEST', 'TEST_MERCHANT',
// 'test' merchants; 'PF-TEST-FULL-001', 'PF-FINAL-001' payment ids) are fixtures and prove nothing about real money.
// A bare payment_signature on a booking row is deliberately NOT evidence: fixture ITNs write it too, and a genuine
// payment always also leaves a numeric pf_payment_id in a payment log and/or a source='payfast' transaction.
const TX_PF = (a) => `(lower(coalesce(${a}.payment_method,''))='payfast' OR lower(coalesce(${a}.source,''))='payfast'
    OR coalesce(${a}.pf_payment_id,'')<>'' OR coalesce(${a}.pf_signature,'')<>'' OR coalesce(${a}.pf_status,'')<>'')`;
const LOG_FIXTURE = (a) => `(json_valid(${a}.raw_payload) AND (
    (json_extract(${a}.raw_payload,'$.merchant_id') IS NOT NULL AND json_extract(${a}.raw_payload,'$.merchant_id') GLOB '*[^0-9]*')
    OR (coalesce(json_extract(${a}.raw_payload,'$.pf_payment_id'),'') <> '' AND json_extract(${a}.raw_payload,'$.pf_payment_id') GLOB '*[^0-9]*')))`;
const LOG_PF = (a) => `(NOT ${LOG_FIXTURE(a)} AND (${a}.event_type IN ('ITN_RECEIVED','FAILED_SIGNATURE','VERIFIED_OK','CRITICAL_ERROR','LEDGER_UPDATED_COMPLETE')
    OR (json_valid(${a}.raw_payload) AND coalesce(json_extract(${a}.raw_payload,'$.pf_payment_id'),'')<>'')))`;

const BOOKING_FAMILY_EMAIL = `(trigger_event LIKE 'Booking:%' OR trigger_event LIKE 'Admin: Ledger%' OR trigger_event LIKE 'Admin: Stalled%'
    OR trigger_event LIKE 'Admin: Quote%' OR trigger_event LIKE 'Admin: Payment%' OR trigger_event LIKE 'Admin: Overdue%'
    OR trigger_event LIKE 'Admin: Booking%' OR trigger_event LIKE 'Payment%' OR trigger_event LIKE 'Invoice%'
    OR trigger_event LIKE 'Quote%' OR trigger_event LIKE 'Contract%' OR trigger_event LIKE 'Refund%')`;

const TERMINAL_NOTIFICATION = `('sent','failed','cancelled','canceled','delivered','bounced','skipped')`;

// Tables the tool is allowed to change. Every OTHER table must hash identically before and after.
// value = columns that may change on rows that survive (excluded from that table's hash), or null.
const TOUCHED_TABLES = {
    bookings: null, booking_notes: null, booking_services: null, booking_line_items: null,
    booking_access_codes: null, booking_access_tokens: null, advancing_packs: null, advancing_contacts: null,
    run_of_show_items: null, service_reviews: null, cancellations: null, communication_log: null,
    consent_audit: null, contracts: null, expenses: null, reminders_log: null, payfast_payment_intents: null,
    payment_logs: null, payment_schedules: null, transactions: null, invoices: null, invoice_line_items: null,
    quotations: null, quote_line_items: null, events: null, date_holds: null, abandoned_bookings: null,
    email_logs: null, notifications: null, audit_log: null, financial_audit_log: null, admin_login_logs: null,
    inquiries: ['converted_booking_id'],
    bank_statement_lines: ['matched_booking_id', 'matched_transaction_id', 'match_note'],
};

// Every set is a TEMP table, so the source database stays untouched (even when opened read-only).
async function buildSets(db, o) {
    const ctx = { cutoff: o.cutoff };
    const hold = o.payfastHold === 'keep';
    const sets = [
        'cl_pf_booking', 'cl_pf_tx', 'cl_held_booking', 'cl_held_tx', 'cl_held_invoice', 'cl_del_booking', 'cl_del_invoice',
        'cl_del_tx', 'cl_del_quotation', 'cl_del_contract', 'cl_del_cancellation', 'cl_del_schedule', 'cl_del_expense',
        'cl_del_event', 'cl_del_hold', 'cl_del_abandoned', 'cl_del_paylog', 'cl_del_finlog', 'cl_del_email', 'cl_del_notif',
        'cl_del_login', 'cl_del_audit', 'cl_entity', 'cl_held_entity'];
    for (const s of sets) await run(db, `DROP TABLE IF EXISTS temp.${s}`);
    const idTable = (name) => run(db, `CREATE TEMP TABLE ${name} (id INTEGER PRIMARY KEY)`);
    for (const s of sets.filter(s => !['cl_entity', 'cl_held_entity'].includes(s))) await idTable(s);
    await run(db, `CREATE TEMP TABLE cl_entity (tbl TEXT NOT NULL, id INTEGER NOT NULL, PRIMARY KEY (tbl, id))`);
    await run(db, `CREATE TEMP TABLE cl_held_entity (tbl TEXT NOT NULL, id INTEGER NOT NULL, PRIMARY KEY (tbl, id))`);

    const real = `(SELECT id FROM bookings)`;                         // a booking that exists
    const standalone = (col) => `(${col} IS NULL OR ${col} NOT IN ${real})`;

    // ── PayFast evidence (always computed, so the report can show it) ──
    await run(db, `INSERT OR IGNORE INTO cl_pf_tx SELECT t.id FROM transactions t WHERE ${TX_PF('t')}`, ctx);
    await run(db, `INSERT OR IGNORE INTO cl_pf_booking SELECT b.id FROM bookings b WHERE lower(coalesce(b.payment_method,''))='payfast'`, ctx);
    await run(db, `INSERT OR IGNORE INTO cl_pf_booking SELECT t.booking_id FROM transactions t WHERE t.id IN (SELECT id FROM cl_pf_tx) AND t.booking_id IN ${real}`, ctx);
    await run(db, `INSERT OR IGNORE INTO cl_pf_booking SELECT p.booking_id FROM payfast_payment_intents p WHERE p.booking_id IN ${real}`, ctx);
    await run(db, `INSERT OR IGNORE INTO cl_pf_booking SELECT l.booking_id FROM payment_logs l WHERE l.booking_id IN ${real} AND ${LOG_PF('l')}`, ctx);
    await run(db, `INSERT OR IGNORE INTO cl_pf_booking SELECT i.booking_id FROM invoices i WHERE i.booking_id IN ${real}
                   AND i.id IN (SELECT invoice_id FROM transactions WHERE id IN (SELECT id FROM cl_pf_tx) AND invoice_id IS NOT NULL)`, ctx);
    if (hold) {
        await run(db, `INSERT INTO cl_held_booking SELECT id FROM cl_pf_booking`, ctx);
        await run(db, `INSERT INTO cl_held_tx SELECT id FROM cl_pf_tx`, ctx);
    }
    await run(db, `INSERT OR IGNORE INTO cl_held_invoice SELECT i.id FROM invoices i WHERE i.booking_id IN (SELECT id FROM cl_held_booking)
                   OR i.id IN (SELECT invoice_id FROM transactions WHERE id IN (SELECT id FROM cl_held_tx) AND invoice_id IS NOT NULL)`, ctx);

    // ── bookings: old, not held, and no transactional record of theirs was created after the cutoff ──
    await run(db, `INSERT INTO cl_del_booking SELECT b.id FROM bookings b
        WHERE ${OLD('b.created_at')}
          AND b.id NOT IN (SELECT id FROM cl_held_booking)
          AND NOT EXISTS (SELECT 1 FROM transactions x WHERE x.booking_id=b.id AND NOT ${OLD('x.created_at')})
          AND NOT EXISTS (SELECT 1 FROM invoices x     WHERE x.booking_id=b.id AND NOT ${OLD('x.created_at')})
          AND NOT EXISTS (SELECT 1 FROM quotations x   WHERE x.booking_id=b.id AND NOT ${OLD('x.created_at')})
          AND NOT EXISTS (SELECT 1 FROM contracts x    WHERE x.booking_id=b.id AND NOT ${OLD('x.created_at')})
          AND NOT EXISTS (SELECT 1 FROM cancellations x WHERE x.booking_id=b.id AND NOT ${OLD('x.cancelled_at')})`, ctx);

    // ── finance ──
    await run(db, `INSERT INTO cl_del_invoice SELECT i.id FROM invoices i
        WHERE (i.booking_id IN (SELECT id FROM cl_del_booking) OR (${standalone('i.booking_id')} AND ${OLD('i.created_at')}))
          AND i.id NOT IN (SELECT id FROM cl_held_invoice)`, ctx);
    await run(db, `INSERT INTO cl_del_tx SELECT t.id FROM transactions t
        WHERE (t.booking_id IN (SELECT id FROM cl_del_booking)
               OR (${standalone('t.booking_id')} AND ${OLD('t.created_at')} AND t.id NOT IN (SELECT id FROM cl_held_tx)))`, ctx);
    await run(db, `INSERT INTO cl_del_schedule SELECT s.id FROM payment_schedules s
        WHERE s.booking_id IN (SELECT id FROM cl_del_booking)
           OR (${standalone('s.booking_id')} AND ${OLD('s.created_at')} AND (s.invoice_id IS NULL OR s.invoice_id NOT IN (SELECT id FROM cl_held_invoice)))`, ctx);
    // An invoice survives if any surviving transaction or schedule still points at it (one pass is enough:
    // keeping an invoice never adds a transaction or schedule to the delete sets).
    await run(db, `DELETE FROM cl_del_invoice WHERE id IN (
        SELECT invoice_id FROM transactions WHERE invoice_id IS NOT NULL AND id NOT IN (SELECT id FROM cl_del_tx)
        UNION SELECT invoice_id FROM payment_schedules WHERE invoice_id IS NOT NULL AND id NOT IN (SELECT id FROM cl_del_schedule))`, ctx);
    await run(db, `INSERT INTO cl_del_quotation SELECT q.id FROM quotations q
        WHERE (q.booking_id IN (SELECT id FROM cl_del_booking) OR (${standalone('q.booking_id')} AND ${OLD('q.created_at')}))
          AND q.id NOT IN (SELECT quotation_id FROM bookings WHERE quotation_id IS NOT NULL AND id NOT IN (SELECT id FROM cl_del_booking))`, ctx);
    await run(db, `INSERT INTO cl_del_contract SELECT id FROM contracts WHERE booking_id IN (SELECT id FROM cl_del_booking)`, ctx);
    await run(db, `INSERT INTO cl_del_cancellation SELECT id FROM cancellations WHERE booking_id IN (SELECT id FROM cl_del_booking)`, ctx);
    await run(db, `INSERT INTO cl_del_expense SELECT e.id FROM expenses e
        WHERE e.booking_id IN (SELECT id FROM cl_del_booking) OR (${standalone('e.booking_id')} AND ${OLD('e.created_at')})`, ctx);

    // ── calendar / events ──
    await run(db, `INSERT INTO cl_del_event SELECT e.event_id FROM events e
        WHERE (e.booking_id IN (SELECT id FROM cl_del_booking)
               OR (e.booking_id IS NOT NULL AND e.booking_id NOT IN ${real} AND ${OLD('e.created_on')})
               ${o.includeStandaloneEvents ? `OR (e.booking_id IS NULL AND ${OLD('e.created_on')})` : ''})
          AND e.event_id NOT IN (SELECT event_id FROM bookings WHERE event_id IS NOT NULL AND id NOT IN (SELECT id FROM cl_del_booking))`, ctx);
    await run(db, `INSERT INTO cl_del_hold SELECT h.id FROM date_holds h
        WHERE ${o.includeCalendarSync ? '1=1' : `coalesce(h.block_type,'') <> 'calendar_sync'`}
          AND (h.converted_to_booking_id IN (SELECT id FROM cl_del_booking)
               OR h.event_id IN (SELECT id FROM cl_del_event)
               OR (${standalone('h.converted_to_booking_id')}
                   AND (h.event_id IS NULL OR h.event_id NOT IN (SELECT event_id FROM events))
                   AND ${OLD('h.created_at')}))`, ctx);
    await run(db, `INSERT INTO cl_del_abandoned SELECT a.id FROM abandoned_bookings a
        WHERE ${OLD('a.created_at')}
          AND (a.converted_booking_id IS NULL OR a.converted_booking_id IN (SELECT id FROM cl_del_booking) OR a.converted_booking_id NOT IN ${real})`, ctx);

    // ── logs ──
    const broad = o.logsScope !== 'booking-finance';
    await run(db, `INSERT INTO cl_del_paylog SELECT l.id FROM payment_logs l
        WHERE l.booking_id IN (SELECT id FROM cl_del_booking)
           OR (${standalone('l.booking_id')} AND ${OLD('l.timestamp')} AND NOT (${hold ? LOG_PF('l') : '0'}))`, ctx);

    // entity registry: what is being removed / what is held (audit rows about them are keyed off this)
    const reg = (tbl, set) => run(db, `INSERT OR IGNORE INTO cl_entity SELECT '${tbl}', id FROM ${set}`, ctx);
    for (const [tbl, set] of [['bookings', 'cl_del_booking'], ['invoices', 'cl_del_invoice'], ['transactions', 'cl_del_tx'],
        ['quotations', 'cl_del_quotation'], ['contracts', 'cl_del_contract'], ['cancellations', 'cl_del_cancellation'],
        ['payment_schedules', 'cl_del_schedule'], ['expenses', 'cl_del_expense'], ['events', 'cl_del_event'], ['date_holds', 'cl_del_hold']]) await reg(tbl, set);
    await run(db, `INSERT OR IGNORE INTO cl_held_entity SELECT 'bookings', id FROM cl_held_booking`, ctx);
    await run(db, `INSERT OR IGNORE INTO cl_held_entity SELECT 'invoices', id FROM cl_held_invoice`, ctx);
    await run(db, `INSERT OR IGNORE INTO cl_held_entity SELECT 'transactions', id FROM transactions WHERE booking_id IN (SELECT id FROM cl_held_booking) OR id IN (SELECT id FROM cl_held_tx)`, ctx);
    await run(db, `INSERT OR IGNORE INTO cl_held_entity SELECT 'quotations', id FROM quotations WHERE booking_id IN (SELECT id FROM cl_held_booking)`, ctx);
    await run(db, `INSERT OR IGNORE INTO cl_held_entity SELECT 'contracts', id FROM contracts WHERE booking_id IN (SELECT id FROM cl_held_booking)`, ctx);
    await run(db, `INSERT OR IGNORE INTO cl_held_entity SELECT 'cancellations', id FROM cancellations WHERE booking_id IN (SELECT id FROM cl_held_booking)`, ctx);
    await run(db, `INSERT OR IGNORE INTO cl_held_entity SELECT 'payment_schedules', id FROM payment_schedules WHERE booking_id IN (SELECT id FROM cl_held_booking)`, ctx);
    await run(db, `INSERT OR IGNORE INTO cl_held_entity SELECT 'events', event_id FROM events WHERE booking_id IN (SELECT id FROM cl_held_booking)`, ctx);

    const FIN_TYPE = `CASE f.entity_type WHEN 'booking' THEN 'bookings' WHEN 'invoice' THEN 'invoices' WHEN 'quotation' THEN 'quotations'
        WHEN 'transaction' THEN 'transactions' WHEN 'payment' THEN 'transactions' WHEN 'expense' THEN 'expenses'
        WHEN 'contract' THEN 'contracts' WHEN 'event' THEN 'events' ELSE f.entity_type END`;
    await run(db, `INSERT INTO cl_del_finlog SELECT f.id FROM financial_audit_log f
        WHERE EXISTS (SELECT 1 FROM cl_entity e WHERE e.tbl = ${FIN_TYPE} AND e.id = f.entity_id)
        ${broad ? `OR (${OLD('f.timestamp')} AND NOT EXISTS (SELECT 1 FROM cl_held_entity h WHERE h.tbl = ${FIN_TYPE} AND h.id = f.entity_id))` : ''}`, ctx);
    await run(db, `INSERT INTO cl_del_email SELECT id FROM email_logs
        WHERE ${OLD('sent_at')} ${broad ? '' : `AND ${BOOKING_FAMILY_EMAIL}`}`, ctx);
    await run(db, `INSERT INTO cl_del_notif SELECT n.id FROM notifications n
        WHERE n.id NOT IN (SELECT notification_id FROM inquiry_messages WHERE notification_id IS NOT NULL)
          AND coalesce(n.related_entity,'') NOT LIKE 'inquiry%'
          AND (  (n.related_entity = 'booking' AND n.related_id IN (SELECT id FROM cl_del_booking))
               ${broad ? `OR (${OLD('n.created_at')} AND n.status IN ${TERMINAL_NOTIFICATION})` : ''})`, ctx);
    if (o.logsScope === 'everything') {
        await run(db, `INSERT INTO cl_del_login SELECT id FROM admin_login_logs WHERE ${OLD('login_at')}`, ctx);
    }
    // audit_log is purged LAST in the run; the set is computed against the registry (any time) plus, in the
    // broad scopes, everything at/below the cutoff that is not about a held entity. Our own marker is kept.
    await run(db, `INSERT INTO cl_del_audit SELECT a.id FROM audit_log a
        WHERE coalesce(a.action,'') <> 'TEST_DATA_CLEANUP'
          AND (EXISTS (SELECT 1 FROM cl_entity e WHERE e.tbl = a.table_name AND e.id = a.record_id)
               ${broad ? `OR (${OLD('a.change_timestamp')} AND NOT EXISTS (SELECT 1 FROM cl_held_entity h WHERE h.tbl = a.table_name AND h.id = a.record_id))` : ''})`, ctx);
}

// Delete steps in dependency order. `table` is what the step changes; `expect` counts the rows it must change.
function steps() {
    const B = `(SELECT id FROM cl_del_booking)`;
    const del = (table, where, expect, note) => ({ kind: 'delete', table, sql: `DELETE FROM ${table} WHERE ${where}`, expect: `SELECT count(*) FROM ${table} WHERE ${where}`, note });
    const upd = (table, set, where, note) => ({ kind: 'update', table, sql: `UPDATE ${table} SET ${set} WHERE ${where}`, expect: `SELECT count(*) FROM ${table} WHERE ${where}`, note });
    return [
        upd('inquiries', 'converted_booking_id = NULL', `converted_booking_id IN ${B}`, 'client-facing row kept; only the link to a removed booking is cleared'),
        upd('bank_statement_lines', `matched_booking_id = CASE WHEN matched_booking_id IN ${B} THEN NULL ELSE matched_booking_id END, matched_transaction_id = CASE WHEN matched_transaction_id IN (SELECT id FROM cl_del_tx) THEN NULL ELSE matched_transaction_id END, match_note = 'unmatched by test-data cleanup'`,
            `matched_booking_id IN ${B} OR matched_transaction_id IN (SELECT id FROM cl_del_tx)`, 'imported bank lines are real bank data: unmatched, never deleted'),
        upd('bookings', 'event_id = NULL, quotation_id = NULL', `id IN ${B} AND (event_id IS NOT NULL OR quotation_id IS NOT NULL)`, 'breaks the booking<->event/quotation cycle before deleting'),
        upd('date_holds', 'event_id = NULL', `event_id IN (SELECT id FROM cl_del_event) AND id NOT IN (SELECT id FROM cl_del_hold)`, 'kept holds lose their link to a removed event'),
        upd('date_holds', 'converted_to_booking_id = NULL', `converted_to_booking_id IN ${B} AND id NOT IN (SELECT id FROM cl_del_hold)`, 'kept holds lose their link to a removed booking'),
        upd('abandoned_bookings', 'converted_booking_id = NULL', `converted_booking_id IN ${B} AND id NOT IN (SELECT id FROM cl_del_abandoned)`, 'kept recovery leads lose their link to a removed booking'),
        del('run_of_show_items', `pack_id IN (SELECT id FROM advancing_packs WHERE booking_id IN ${B})`),
        del('advancing_contacts', `pack_id IN (SELECT id FROM advancing_packs WHERE booking_id IN ${B})`),
        del('advancing_packs', `booking_id IN ${B}`),
        del('service_reviews', `booking_id IN ${B}`),
        del('booking_notes', `booking_id IN ${B}`),
        del('booking_services', `booking_id IN ${B}`),
        del('booking_line_items', `booking_id IN ${B}`),
        del('booking_access_codes', `booking_id IN ${B}`),
        del('booking_access_tokens', `booking_id IN ${B}`),
        del('communication_log', `booking_id IN ${B}`),
        del('consent_audit', `booking_id IN ${B}`),
        del('reminders_log', `booking_id IN ${B} OR schedule_id IN (SELECT id FROM cl_del_schedule)`),
        del('payfast_payment_intents', `booking_id IN ${B}`),
        del('cancellations', `id IN (SELECT id FROM cl_del_cancellation)`),
        del('contracts', `id IN (SELECT id FROM cl_del_contract)`),
        del('transactions', `id IN (SELECT id FROM cl_del_tx)`),
        del('payment_schedules', `id IN (SELECT id FROM cl_del_schedule)`),
        del('invoice_line_items', `invoice_id IN (SELECT id FROM cl_del_invoice)`),
        del('invoices', `id IN (SELECT id FROM cl_del_invoice)`),
        del('quote_line_items', `quotation_id IN (SELECT id FROM cl_del_quotation)`),
        del('quotations', `id IN (SELECT id FROM cl_del_quotation)`),
        del('expenses', `id IN (SELECT id FROM cl_del_expense)`),
        del('payment_logs', `id IN (SELECT id FROM cl_del_paylog)`),
        del('date_holds', `id IN (SELECT id FROM cl_del_hold)`),
        del('events', `event_id IN (SELECT id FROM cl_del_event)`),
        del('abandoned_bookings', `id IN (SELECT id FROM cl_del_abandoned)`),
        del('bookings', `id IN ${B}`),
        del('financial_audit_log', `id IN (SELECT id FROM cl_del_finlog)`),
        del('email_logs', `id IN (SELECT id FROM cl_del_email)`),
        del('notifications', `id IN (SELECT id FROM cl_del_notif)`),
        del('admin_login_logs', `id IN (SELECT id FROM cl_del_login)`),
        // LAST: the DELETE triggers on events/date_holds just wrote audit rows holding the removed content.
        { kind: 'audit-purge', table: 'audit_log', sql: null },
    ];
}

const MODULE_OF = {
    bookings: 'Bookings', booking_notes: 'Bookings', booking_services: 'Bookings', booking_line_items: 'Bookings',
    booking_access_codes: 'Bookings', booking_access_tokens: 'Bookings', advancing_packs: 'Bookings', advancing_contacts: 'Bookings',
    run_of_show_items: 'Bookings', service_reviews: 'Bookings', communication_log: 'Bookings', consent_audit: 'Bookings',
    abandoned_bookings: 'Bookings', inquiries: 'Bookings (link only)', events: 'Calendar & Events', date_holds: 'Calendar & Events',
    cancellations: 'Finance', contracts: 'Finance', transactions: 'Finance', payment_schedules: 'Finance', invoices: 'Finance',
    invoice_line_items: 'Finance', quotations: 'Finance', quote_line_items: 'Finance', expenses: 'Finance',
    reminders_log: 'Finance', payfast_payment_intents: 'Finance', bank_statement_lines: 'Finance (unmatch only)',
    payment_logs: 'Logs', financial_audit_log: 'Logs', email_logs: 'Logs', notifications: 'Logs', admin_login_logs: 'Logs', audit_log: 'Logs',
};

// ──────────────────────────────── measurement ────────────────────────────────

async function tableNames(db) {
    return (await all(db, `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)).map(r => r.name);
}

async function counts(db) {
    const out = {};
    for (const t of await tableNames(db)) out[t] = await scalar(db, `SELECT count(*) FROM "${t}"`);
    return out;
}

// Content hash of a table (optionally ignoring some columns) - the proof that an untouched table is untouched.
function hashTable(db, table, ignore, ordered = true) {
    return new Promise((resolve, reject) => {
        const h = crypto.createHash('sha256');
        let n = 0;
        db.each(`SELECT * FROM "${table}"${ordered ? ' ORDER BY rowid' : ''}`, (e, row) => {
            if (e) return;
            n++;
            const keys = Object.keys(row).filter(k => !(ignore || []).includes(k)).sort();
            h.update(keys.map(k => { const v = row[k]; return Buffer.isBuffer(v) ? 'b:' + crypto.createHash('sha1').update(v).digest('hex') : JSON.stringify(v); }).join('\u0001') + '\n');
        }, (e) => {
            if (e && ordered) return resolve(hashTable(db, table, ignore, false));   // WITHOUT ROWID table
            e ? reject(e) : resolve({ rows: n, sha: h.digest('hex') });
        });
    });
}

async function hashAll(db, tables) {
    const out = {};
    for (const t of tables) out[t] = await hashTable(db, t, TOUCHED_TABLES[t]);
    return out;
}

async function fkViolations(db) {
    return new Set((await all(db, 'PRAGMA foreign_key_check')).map(r => `${r.table}|${r.rowid}|${r.parent}|${r.fkid}`));
}

const money = (n) => Math.round((n || 0) * 100) / 100;
// The figures the dashboards and Finance screens are computed from (they are live queries - nothing is cached).
async function metrics(db) {
    const m = {};
    const row = async (k, sql) => { m[k] = await get(db, sql); };
    await row('bookings', `SELECT count(*) n, round(coalesce(sum(total_amount),0),2) total, round(coalesce(sum(amount_paid),0),2) paid, round(coalesce(sum(amount_outstanding),0),2) outstanding FROM bookings`);
    m.bookingsByStatus = Object.fromEntries((await all(db, `SELECT status, count(*) n FROM bookings GROUP BY status ORDER BY status`)).map(r => [r.status, r.n]));
    await row('quotations', `SELECT count(*) n, round(coalesce(sum(total_amount),0),2) total FROM quotations`);
    await row('invoices', `SELECT count(*) n, round(coalesce(sum(total_amount),0),2) total, round(coalesce(sum(CASE WHEN upper(status)='PAID' THEN total_amount END),0),2) paid FROM invoices`);
    await row('payments', `SELECT count(*) n, round(coalesce(sum(amount),0),2) total FROM transactions WHERE transaction_type='payment' AND status='completed'`);
    await row('refunds', `SELECT count(*) n, round(coalesce(sum(amount),0),2) total FROM transactions WHERE transaction_type='refund' AND status='completed'`);
    await row('expenses', `SELECT count(*) n, round(coalesce(sum(amount),0),2) total FROM expenses WHERE deleted_at IS NULL`);
    await row('events', `SELECT count(*) n FROM events`);
    await row('dateHolds', `SELECT count(*) n, sum(coalesce(block_type,'')='calendar_sync') googleMirror FROM date_holds`);
    await row('abandoned', `SELECT count(*) n FROM abandoned_bookings`);
    await row('logs', `SELECT (SELECT count(*) FROM email_logs) email, (SELECT count(*) FROM audit_log) audit, (SELECT count(*) FROM payment_logs) payment, (SELECT count(*) FROM financial_audit_log) financial, (SELECT count(*) FROM admin_login_logs) login, (SELECT count(*) FROM notifications) notifications`);
    return m;
}

// ──────────────────────────────── the plan ────────────────────────────────

async function ids(db, set) { return (await all(db, `SELECT id FROM ${set} ORDER BY id`)).map(r => r.id); }

async function buildPlan(db, o, dbRealPath) {
    await buildSets(db, o);
    const plan = { tool: TOOL_VERSION, db: dbRealPath, cutoff: o.cutoffIso, options: {
        payfastHold: o.payfastHold, logsScope: o.logsScope, includeStandaloneEvents: !!o.includeStandaloneEvents, includeCalendarSync: !!o.includeCalendarSync } };
    const sets = {};
    for (const s of ['cl_del_booking', 'cl_del_invoice', 'cl_del_tx', 'cl_del_quotation', 'cl_del_contract', 'cl_del_cancellation', 'cl_del_schedule', 'cl_del_expense',
        'cl_del_event', 'cl_del_hold', 'cl_del_abandoned', 'cl_del_paylog', 'cl_del_finlog', 'cl_del_email', 'cl_del_notif', 'cl_del_login', 'cl_del_audit']) sets[s] = await ids(db, s);
    plan.sets = sets;

    plan.steps = [];
    for (const s of steps()) {
        const expect = s.kind === 'audit-purge' ? sets.cl_del_audit.length : await scalar(db, s.expect, { cutoff: o.cutoff });
        plan.steps.push({ kind: s.kind, table: s.table, module: MODULE_OF[s.table] || '', expect, note: s.note || '' });
    }

    // Things the owner must see and consciously accept.
    const q = (sql) => all(db, sql, { cutoff: o.cutoff });
    plan.publicEvents = await q(`SELECT e.event_id id, e.event_title title, substr(e.event_datetime,1,10) date, e.booking_id FROM events e LEFT JOIN bookings b ON b.id=e.booking_id
        WHERE e.event_id IN (SELECT id FROM cl_del_event) AND e.event_status NOT IN ('cancelled','draft') AND (e.booking_id IS NULL OR b.is_public=1) ORDER BY e.event_datetime`);
    plan.futureBlocks = await q(`SELECT id, hold_date date, coalesce(block_type,'hold') type FROM date_holds WHERE id IN (SELECT id FROM cl_del_hold) AND hold_date >= date('now') ORDER BY hold_date`);
    plan.upcomingBookings = await q(`SELECT id, date, status, event_name FROM bookings WHERE id IN (SELECT id FROM cl_del_booking) AND status IN ('ACCEPTED','CONFIRMED') AND date >= date('now') ORDER BY date`);
    plan.requiredAcks = [];
    if (plan.publicEvents.length) plan.requiredAcks.push('public-events');
    if (plan.futureBlocks.length) plan.requiredAcks.push('future-blocks');
    if (plan.upcomingBookings.length) plan.requiredAcks.push('upcoming-bookings');

    // What is deliberately kept, and why.
    const k = {};
    k.payfastHeldBookings = await ids(db, 'cl_held_booking');
    k.payfastHeldTx = await ids(db, 'cl_held_tx');
    k.payfastEvidenceBookings = await ids(db, 'cl_pf_booking');
    // The list to check against the PayFast dashboard: one line per distinct gateway payment id.
    k.payfastToVerify = await q(`SELECT json_extract(l.raw_payload,'$.pf_payment_id') pf_payment_id, l.booking_id, json_extract(l.raw_payload,'$.merchant_id') merchant_id,
            max(l.amount) amount, min(substr(l.timestamp,1,16)) first_seen,
            max(CASE l.event_type WHEN 'LEDGER_UPDATED_COMPLETE' THEN 3 WHEN 'VERIFIED_OK' THEN 2 ELSE 1 END) rank
        FROM payment_logs l WHERE ${LOG_PF('l')} AND coalesce(json_extract(l.raw_payload,'$.pf_payment_id'),'')<>''
        GROUP BY 1,2,3 ORDER BY CAST(json_extract(l.raw_payload,'$.pf_payment_id') AS INTEGER)`);
    for (const p of k.payfastToVerify) {
        p.status = { 3: 'money recorded in the ledger', 2: 'signature ok, ledger not updated', 1: 'REJECTED by the app (not in your books)' }[p.rank];
        delete p.rank;
    }
    k.payfastTxNoGatewayId = (await q(`SELECT id, booking_id, amount, substr(created_at,1,10) date FROM transactions WHERE id IN (SELECT id FROM cl_pf_tx) AND coalesce(pf_payment_id,'')='' ORDER BY id`));
    k.bookingsAfterCutoffOrUndated = (await q(`SELECT id FROM bookings WHERE NOT ${OLD('created_at')} ORDER BY id`)).map(r => r.id);
    k.bookingsWithNewerRecords = (await q(`SELECT b.id FROM bookings b WHERE ${OLD('b.created_at')} AND b.id NOT IN (SELECT id FROM cl_held_booking) AND b.id NOT IN (SELECT id FROM cl_del_booking) ORDER BY b.id`)).map(r => r.id);
    k.standaloneEventsKept = (await q(`SELECT event_id id, event_title title, substr(event_datetime,1,10) date FROM events WHERE booking_id IS NULL AND event_id NOT IN (SELECT id FROM cl_del_event) ORDER BY event_datetime`));
    k.googleMirrorHoldsKept = await scalar(db, `SELECT count(*) FROM date_holds WHERE coalesce(block_type,'')='calendar_sync' AND id NOT IN (SELECT id FROM cl_del_hold)`);
    k.pendingNotificationsKept = await scalar(db, `SELECT count(*) FROM notifications WHERE status NOT IN ${TERMINAL_NOTIFICATION}`);
    k.inquiryLinkedNotificationsKept = await scalar(db, `SELECT count(*) FROM notifications WHERE id IN (SELECT notification_id FROM inquiry_messages WHERE notification_id IS NOT NULL) OR coalesce(related_entity,'') LIKE 'inquiry%'`);
    k.clientsKept = await scalar(db, `SELECT count(*) FROM clients`);
    k.clientsLeftWithoutAnyRecord = await scalar(db, `SELECT count(*) FROM clients c WHERE c.id IN (SELECT client_id FROM bookings WHERE client_id IS NOT NULL AND id IN (SELECT id FROM cl_del_booking))
        AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.client_id=c.id AND b.id NOT IN (SELECT id FROM cl_del_booking))`);
    plan.kept = k;

    // Things outside the database that the cleanup cannot and does not touch.
    plan.googleEvents = [
        ...(await q(`SELECT 'bookings' tbl, id, date, google_event_id gid FROM bookings WHERE id IN (SELECT id FROM cl_del_booking) AND coalesce(google_event_id,'')<>''`)),
        ...(await q(`SELECT 'events' tbl, event_id id, substr(event_datetime,1,10) date, google_calendar_event_id gid FROM events WHERE event_id IN (SELECT id FROM cl_del_event) AND coalesce(google_calendar_event_id,'')<>''`)),
        ...(await q(`SELECT 'date_holds' tbl, id, hold_date date, google_event_id gid FROM date_holds WHERE id IN (SELECT id FROM cl_del_hold) AND coalesce(google_event_id,'')<>''`)),
    ];
    const fileCols = [['invoices', 'file_path', 'id IN (SELECT id FROM cl_del_invoice)'], ['quotations', 'file_path', 'id IN (SELECT id FROM cl_del_quotation)'],
        ['contracts', 'pdf_url', 'id IN (SELECT id FROM cl_del_contract)'], ['transactions', 'proof_of_payment_path', 'id IN (SELECT id FROM cl_del_tx)'],
        ['expenses', 'receipt_url', 'id IN (SELECT id FROM cl_del_expense)'], ['advancing_packs', 'pdf_url', 'booking_id IN (SELECT id FROM cl_del_booking)'],
        ['bookings', 'attachment_files', `id IN (SELECT id FROM cl_del_booking) AND attachment_files <> '[]'`], ['notifications', 'attachment_paths', `id IN (SELECT id FROM cl_del_notif) AND attachment_paths <> '[]'`]];
    plan.filesLeftInPlace = [];
    for (const [t, c, w] of fileCols) {
        for (const r of await q(`SELECT ${c} AS ref FROM ${t} WHERE coalesce(${c},'')<>'' AND ${w}`)) plan.filesLeftInPlace.push({ table: t, column: c, ref: r.ref });
    }

    // Manual money (cash / EFT / refunds) in the delete set - the owner said test, but it is shown, not hidden.
    plan.manualMoneyInScope = await q(`SELECT transaction_type type, payment_method method, count(*) n, round(sum(amount),2) total FROM transactions
        WHERE id IN (SELECT id FROM cl_del_tx) AND lower(coalesce(payment_method,'')) <> 'payfast' GROUP BY 1,2 ORDER BY 1,2`);
    plan.newest = {
        bookings: await scalar(db, `SELECT max(created_at) FROM bookings WHERE id IN (SELECT id FROM cl_del_booking)`),
        transactions: await scalar(db, `SELECT max(created_at) FROM transactions WHERE id IN (SELECT id FROM cl_del_tx)`),
        invoices: await scalar(db, `SELECT max(created_at) FROM invoices WHERE id IN (SELECT id FROM cl_del_invoice)`),
        events: await scalar(db, `SELECT max(created_on) FROM events WHERE event_id IN (SELECT id FROM cl_del_event)`),
    };
    plan.fingerprint = crypto.createHash('sha256').update(JSON.stringify({
        v: plan.tool, db: plan.db, cutoff: plan.cutoff, options: plan.options, sets: plan.sets, acks: plan.requiredAcks,
        expect: plan.steps.map(s => [s.table, s.kind, s.expect])
    })).digest('hex').slice(0, 20);
    return plan;
}

// ──────────────────────────────── applying it ────────────────────────────────

// Runs inside a transaction the caller owns. Throws (=> caller rolls back) on any anomaly.
async function applyPlan(db, plan, o) {
    const tables = await tableNames(db);
    const untouched = tables.filter(t => !(t in TOUCHED_TABLES));
    const before = { counts: await counts(db), hashes: await hashAll(db, [...untouched, 'inquiries', 'bank_statement_lines']), fk: await fkViolations(db), metrics: await metrics(db) };
    const results = [];
    const list = steps();                                  // plan.steps was built from this same list, in this order
    for (let i = 0; i < list.length; i++) {
        const s = list[i], planned = plan.steps[i];
        if (planned.table !== s.table || planned.kind !== s.kind) throw new Error(`plan/step mismatch at #${i}: ${planned.table}/${planned.kind} vs ${s.table}/${s.kind}`);
        if (s.kind === 'audit-purge') {
            const changes = await run(db, `DELETE FROM audit_log WHERE id IN (SELECT id FROM cl_del_audit)
                OR (coalesce(action,'') <> 'TEST_DATA_CLEANUP' AND EXISTS (SELECT 1 FROM cl_entity e WHERE e.tbl = audit_log.table_name AND e.id = audit_log.record_id))`, { cutoff: o.cutoff });
            // Rows the DELETE triggers on events/date_holds wrote during this very run are extra by design - never fewer.
            if (changes < planned.expect) throw new Error(`audit_log purge removed ${changes} rows, plan expected at least ${planned.expect}`);
            results.push({ table: s.table, kind: s.kind, planned: planned.expect, changed: changes, note: `${changes - planned.expect} rows written by this run's own delete triggers were removed as well` });
            continue;
        }
        const changes = await run(db, s.sql, { cutoff: o.cutoff });
        if (changes !== planned.expect) throw new Error(`${s.kind} ${s.table}: changed ${changes} rows but the plan expected ${planned.expect} - aborting`);
        results.push({ table: s.table, kind: s.kind, planned: planned.expect, changed: changes, note: s.note || '' });
    }

    // A single marker row so Security & Audit shows that (and when) this happened. Counts only, no content.
    const marker = JSON.stringify({ tool: TOOL_VERSION, fingerprint: plan.fingerprint, cutoff: plan.cutoff, deleted: Object.fromEntries(Object.entries(results.filter(r => r.kind === 'delete').reduce((m, r) => { m[r.table] = (m[r.table] || 0) + r.changed; return m; }, {})).filter(([, n]) => n)) });
    await new Promise((res, rej) => db.run(`INSERT INTO audit_log (table_name, record_id, action, new_values, changed_by, change_timestamp, reason)
        VALUES ('system', 0, 'TEST_DATA_CLEANUP', ?, 'cleanup-test-data', CURRENT_TIMESTAMP, 'Removal of test data from Bookings, Calendar, Finance, Events, Logs')`, [marker], (e) => e ? rej(e) : res()));

    // ── verification ──
    const problems = [];
    const afterFk = await fkViolations(db);
    const newFk = [...afterFk].filter(v => !before.fk.has(v));
    if (newFk.length) problems.push(`new foreign-key violations: ${newFk.slice(0, 5).join('; ')}`);

    const leftovers = [
        ['bookings still present', `SELECT count(*) FROM bookings WHERE id IN (SELECT id FROM cl_del_booking)`],
        ...['booking_notes', 'booking_services', 'booking_line_items', 'booking_access_codes', 'booking_access_tokens', 'cancellations', 'communication_log', 'consent_audit', 'contracts',
            'expenses', 'invoices', 'payfast_payment_intents', 'payment_logs', 'payment_schedules', 'quotations', 'reminders_log', 'transactions', 'advancing_packs', 'service_reviews']
            .map(t => [`${t} still pointing at a removed booking`, `SELECT count(*) FROM ${t} WHERE booking_id IN (SELECT id FROM cl_del_booking)`]),
        ['events still pointing at a removed booking', `SELECT count(*) FROM events WHERE booking_id IN (SELECT id FROM cl_del_booking)`],
        ['date_holds still pointing at a removed booking/event', `SELECT count(*) FROM date_holds WHERE converted_to_booking_id IN (SELECT id FROM cl_del_booking) OR event_id IN (SELECT id FROM cl_del_event)`],
        ['inquiries still linked to a removed booking', `SELECT count(*) FROM inquiries WHERE converted_booking_id IN (SELECT id FROM cl_del_booking)`],
        ['audit rows about removed records', `SELECT count(*) FROM audit_log a WHERE a.action <> 'TEST_DATA_CLEANUP' AND EXISTS (SELECT 1 FROM cl_entity e WHERE e.tbl=a.table_name AND e.id=a.record_id)`],
    ];
    for (const [label, sql] of leftovers) { const n = await scalar(db, sql); if (n) problems.push(`${label}: ${n}`); }

    const after = { counts: await counts(db), hashes: await hashAll(db, [...untouched, 'inquiries', 'bank_statement_lines']), metrics: await metrics(db) };
    const unchanged = [];
    for (const t of [...untouched, 'inquiries', 'bank_statement_lines']) {
        const a = before.hashes[t], b = after.hashes[t];
        if (a.sha !== b.sha || a.rows !== b.rows) problems.push(`table ${t} changed but must not (${a.rows} -> ${b.rows} rows)`);
        else unchanged.push(t);
    }
    const deletedPerTable = {};
    for (const r of results) if (r.kind === 'delete') deletedPerTable[r.table] = (deletedPerTable[r.table] || 0) + r.changed;
    for (const [t, n] of Object.entries(deletedPerTable)) {
        // audit_log is checked by the "audit rows about removed records" leftover test instead: the DELETE triggers
        // and the unlink of inquiries legitimately add rows to it during the run.
        if (t === 'audit_log') continue;
        const expected = before.counts[t] - n;
        if (after.counts[t] !== expected) problems.push(`${t}: ${before.counts[t]} rows - ${n} deleted should leave ${expected}, found ${after.counts[t]}`);
    }
    const integrity = await scalar(db, 'PRAGMA integrity_check');
    if (integrity !== 'ok') problems.push(`integrity_check: ${integrity}`);
    if (problems.length) { const e = new Error('verification failed:\n  - ' + problems.join('\n  - ')); e.problems = problems; throw e; }
    return { results, before, after, unchanged, deletedPerTable, fkBaselineViolations: before.fk.size, integrity };
}

// ──────────────────────────────── orchestration ────────────────────────────────

function assertSafeOutDir(outDir) {
    const abs = path.resolve(outDir);
    const rel = path.relative(PROJECT_ROOT, abs);
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
        throw new Refusal(`--out-dir ${abs} is inside the project folder. The manifest and backup contain personal data and the repository is public - choose a directory outside it (on Render: /var/data/...).`);
    }
    return abs;
}

function assertSqliteFile(file) {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(16);
    fs.readSync(fd, buf, 0, 16, 0);
    fs.closeSync(fd);
    if (buf.toString('latin1') !== 'SQLite format 3\u0000') throw new Refusal(`${file} is not a SQLite database`);
}

async function identity(db, file) {
    const st = fs.statSync(file);
    const id = { path: file, bytes: st.size, modified: st.mtime.toISOString() };
    id.sqlite = await scalar(db, 'select sqlite_version()');
    id.journalMode = await scalar(db, 'PRAGMA journal_mode');
    id.admins = await scalar(db, 'SELECT count(*) FROM admins');
    id.bookings = await scalar(db, 'SELECT count(*) FROM bookings');
    id.newestBooking = await scalar(db, 'SELECT max(created_at) FROM bookings');
    id.lastMigration = await scalar(db, `SELECT max(name) FROM schema_migrations`).catch(() => null);
    id.brand = await scalar(db, `SELECT setting_value FROM settings WHERE setting_key='site_name'`).catch(() => null);
    return id;
}

function say(...a) { console.log(...a); }

function printPlan(plan, ident) {
    say('');
    say(`Database : ${ident.path}  (${(ident.bytes / 1048576).toFixed(1)} MB, SQLite ${ident.sqlite}, ${ident.journalMode})`);
    say(`           ${ident.admins} admin user(s), ${ident.bookings} booking(s), newest booking created ${ident.newestBooking || 'n/a'}`);
    say(`Cutoff   : rows created on/before ${plan.cutoff} are in scope; anything newer is kept`);
    say(`Options  : PayFast hold=${plan.options.payfastHold}  logs-scope=${plan.options.logsScope}  standalone events=${plan.options.includeStandaloneEvents ? 'DELETE' : 'keep'}  Google-mirrored holds=${plan.options.includeCalendarSync ? 'DELETE' : 'keep'}`);
    say('');
    say('NEWEST ROW IN EACH DELETE SET (sanity check - these should all be old test data):');
    for (const [k, v] of Object.entries(plan.newest)) say(`  ${k.padEnd(13)} ${v || '-'}`);
    say('');
    say('PLAN');
    say('  ' + 'Module'.padEnd(24) + 'Table'.padEnd(26) + 'Action'.padEnd(12) + 'Rows');
    for (const s of plan.steps) {
        if (!s.expect && s.kind !== 'audit-purge') continue;
        say('  ' + (s.module || '').padEnd(24) + s.table.padEnd(26) + (s.kind === 'update' ? 'unlink' : s.kind === 'audit-purge' ? 'purge' : 'delete').padEnd(12) + String(s.expect).padStart(6) + (s.note ? '   ' + s.note : ''));
    }
    say('');
    say('KEPT ON PURPOSE');
    const k = plan.kept;
    say(`  PayFast hold (${plan.options.payfastHold}): ${k.payfastHeldBookings.length} booking(s) [${k.payfastHeldBookings.join(', ')}] and ${k.payfastHeldTx.length} PayFast transaction(s), with everything attached to them`);
    if (k.payfastToVerify.length || k.payfastTxNoGatewayId.length) {
        say('');
        say(plan.options.payfastHold === 'release'
            ? '  PAYFAST RECORDS THAT WILL BE DELETED - you confirmed none of this is real money (numeric gateway ids; hand-made PF-TEST-... fixtures are not listed):'
            : '  CHECK THESE ON THE PAYFAST DASHBOARD before releasing the hold (numeric gateway ids; fixtures like PF-TEST-... are excluded):');
        say('    ' + 'pf_payment_id'.padEnd(15) + 'booking'.padEnd(9) + 'merchant'.padEnd(11) + 'amount (R)'.padEnd(13) + 'first seen'.padEnd(18) + 'what the app did');
        for (const p of k.payfastToVerify) say('    ' + String(p.pf_payment_id).padEnd(15) + String(p.booking_id).padEnd(9) + String(p.merchant_id).padEnd(11) + String(p.amount).padEnd(13) + String(p.first_seen).padEnd(18) + p.status);
        if (k.payfastTxNoGatewayId.length) say(`    + ${k.payfastTxNoGatewayId.length} transaction row(s) marked source=payfast with no gateway id on the row itself (ids ${k.payfastTxNoGatewayId.map(t => '#' + t.id).join(', ')}; booking ${[...new Set(k.payfastTxNoGatewayId.map(t => t.booking_id))].join(', ')})`);
        say('');
    }
    say(`  Bookings created after the cutoff / undated: ${k.bookingsAfterCutoffOrUndated.length}   old bookings kept because of newer transactional records: ${k.bookingsWithNewerRecords.length}`);
    say(`  Public tour-date events (no booking): ${k.standaloneEventsKept.length}${k.standaloneEventsKept.length ? ' - ' + k.standaloneEventsKept.map(e => `#${e.id} ${e.title} (${e.date})`).join('; ') : ''}`);
    say(`  Google-Calendar-mirrored holds: ${k.googleMirrorHoldsKept}   queued/unsent notifications: ${k.pendingNotificationsKept}   inquiry-linked notifications: ${k.inquiryLinkedNotificationsKept}`);
    say(`  Client records: ${k.clientsKept} kept (${k.clientsLeftWithoutAnyRecord} will have no booking left - NOT deleted, review manually)`);
    if (plan.manualMoneyInScope.length) {
        say('');
        say('MANUAL / NON-PAYFAST MONEY RECORDS IN THE DELETE SET (treated as test data per your instruction - make sure that is right):');
        for (const m of plan.manualMoneyInScope) say(`  ${String(m.type).padEnd(8)} ${String(m.method).padEnd(14)} ${String(m.n).padStart(3)} record(s)  R${m.total}`);
    }
    say('');
    say('NEEDS YOUR ACKNOWLEDGEMENT');
    if (!plan.requiredAcks.length) say('  none');
    if (plan.publicEvents.length) say(`  public-events      ${plan.publicEvents.length} event(s) the PUBLIC website currently lists will disappear: ${plan.publicEvents.map(e => `#${e.id} ${e.title} (${e.date})`).join('; ')}`);
    if (plan.futureBlocks.length) say(`  future-blocks      ${plan.futureBlocks.length} future-dated calendar block(s) will be removed, re-opening those dates to the public: ${plan.futureBlocks.map(b => b.date).join(', ')}`);
    if (plan.upcomingBookings.length) say(`  upcoming-bookings  ${plan.upcomingBookings.length} ACCEPTED/CONFIRMED booking(s) dated in the future will be removed: ${plan.upcomingBookings.map(b => `#${b.id} ${b.date}`).join(', ')}`);
    say('');
    say('OUTSIDE THE DATABASE (not touched by this tool)');
    const today = new Date().toISOString().slice(0, 10);
    const upcomingG = plan.googleEvents.filter(g => g.date >= today).sort((a, b) => String(a.date).localeCompare(String(b.date)));
    say(`  Google Calendar: ${plan.googleEvents.length} removed row(s) have an event in Google Calendar (all ids are in the manifest). Only FUTURE-dated ones can come back:`);
    if (!upcomingG.length) say('    none are in the future - nothing to delete in Google Calendar.');
    for (const g of upcomingG) say(`    ${g.date}   ${g.tbl === 'bookings' ? `booking #${g.id}  (titled "[STATUS] Thabiso Mhlongo: <event type>")` : g.tbl === 'events' ? `public event #${g.id}  (titled "[PUBLIC] <event title>")` : `calendar block #${g.id}`}`);
    if (upcomingG.length) say('    Delete these in Google Calendar BEFORE the real run; otherwise the 15-minute calendar sync re-imports them as blocking holds.');
    say(`  Files: ${plan.filesLeftInPlace.length} document/attachment reference(s) will be left on disk/object storage (listed in the manifest).`);
}

function printComparison(r) {
    const b = r.before.metrics, a = r.after.metrics;
    const line = (label, x, y) => say('  ' + label.padEnd(34) + String(x).padStart(14) + String(y).padStart(16));
    say('');
    say('BEFORE -> AFTER  (what the admin screens will compute)');
    line('', 'before', 'after');
    line('bookings', b.bookings.n, a.bookings.n);
    for (const st of new Set([...Object.keys(b.bookingsByStatus), ...Object.keys(a.bookingsByStatus)])) line(`   ${st}`, b.bookingsByStatus[st] || 0, a.bookingsByStatus[st] || 0);
    line('bookings: contract value (R)', b.bookings.total, a.bookings.total);
    line('bookings: paid (R)', b.bookings.paid, a.bookings.paid);
    line('bookings: outstanding (R)', b.bookings.outstanding, a.bookings.outstanding);
    line('quotations', b.quotations.n, a.quotations.n);
    line('quotations: value (R)', b.quotations.total, a.quotations.total);
    line('invoices', b.invoices.n, a.invoices.n);
    line('invoices: value (R)', b.invoices.total, a.invoices.total);
    line('payments received', b.payments.n, a.payments.n);
    line('payments received (R)', b.payments.total, a.payments.total);
    line('refunds', b.refunds.n, a.refunds.n);
    line('refunds (R)', b.refunds.total, a.refunds.total);
    line('expenses', b.expenses.n, a.expenses.n);
    line('events', b.events.n, a.events.n);
    line('calendar holds / blocks', b.dateHolds.n, a.dateHolds.n);
    line('abandoned-booking leads', b.abandoned.n, a.abandoned.n);
    for (const k of Object.keys(b.logs)) line(`log: ${k}`, b.logs[k], a.logs[k]);
    say('');
    say(`  Integrity: PRAGMA integrity_check = ${r.integrity};  foreign-key violations: ${r.fkBaselineViolations} existed before this tool ran and none were added`);
    say(`  Untouched: ${r.unchanged.length} tables (users, clients, settings, services, venues, newsletter, site content, public web analytics ...) are byte-for-byte identical`);
}

// Read-only follow-up for AFTER a real run. The calendar sync re-imports any Google Calendar event that no local
// booking/event owns as a blocking date_hold, so a removed booking whose Google event still exists comes back as a
// "ghost" within 15 minutes. This lists those, plus anything that appeared since the cleanup.
async function postCheck(o) {
    if (!fs.existsSync(o.postCheck)) throw new Refusal(`manifest not found: ${o.postCheck}`);
    const manifest = JSON.parse(fs.readFileSync(o.postCheck, 'utf8'));
    if (manifest.mode !== 'execute') throw new Refusal('that manifest is from a dry run - pass the manifest written by the --execute run');
    const dbPath = fs.realpathSync(o.db);
    assertSqliteFile(dbPath);
    const db = await open(dbPath, sqlite3.OPEN_READONLY);
    let bad = 0;
    const line = (ok, text) => { if (!ok) bad++; say(`  ${ok ? 'PASS' : 'FAIL'}  ${text}`); };
    try {
        say(`Post-check of ${dbPath} against ${path.basename(o.postCheck)} (cleanup ran ${manifest.generated})`);
        const marker = await get(db, `SELECT change_timestamp FROM audit_log WHERE action='TEST_DATA_CLEANUP' ORDER BY id DESC LIMIT 1`);
        line(!!marker, `cleanup marker present in the audit log${marker ? ' (' + marker.change_timestamp + ')' : ''}`);
        const gids = [...new Set((manifest.plan.googleEvents || []).map(g => g.gid))];
        let ghosts = [];
        for (const g of gids) ghosts.push(...await all(db, `SELECT id, hold_date, block_type FROM date_holds WHERE google_event_id = '${String(g).replace(/'/g, "''")}'`));
        line(ghosts.length === 0, `${gids.length} removed Google event id(s): ${ghosts.length} came back as date_holds${ghosts.length ? ' -> ' + ghosts.map(h => `#${h.id} ${h.hold_date}`).join(', ') + ' (delete the event in Google Calendar, then the next sync drops the hold)' : ''}`);
        for (const [tbl, col] of [['bookings', 'google_event_id'], ['events', 'google_calendar_event_id']]) {
            const back = gids.length ? await scalar(db, `SELECT count(*) FROM ${tbl} WHERE ${col} IN (${gids.map(g => `'${String(g).replace(/'/g, "''")}'`).join(',')})`) : 0;
            line(back === 0, `no removed Google event id is attached to a ${tbl} row`);
        }
        const removed = (manifest.plan.sets.cl_del_booking || []);
        const back = removed.length ? await scalar(db, `SELECT count(*) FROM bookings WHERE id IN (${removed.join(',')})`) : 0;
        line(back === 0, `none of the ${removed.length} removed booking ids exists again`);
        const after = manifest.result && manifest.result.after;
        const nowB = await get(db, `SELECT count(*) n FROM bookings`);
        say(`  INFO  bookings now ${nowB.n} (right after the cleanup: ${after ? after.bookings.n : 'unknown'}); new rows since then are real activity, not leftovers`);
        const fk = await fkViolations(db);
        say(`  INFO  foreign-key violations now: ${fk.size} (the cleanup began with ${manifest.result && manifest.result.before ? 'a pre-existing baseline' : 'a baseline'} and added none)`);
    } finally { await close(db); }
    return bad ? 1 : 0;
}

async function main(argv) {
    const o = parseArgs(argv);
    if (o.help) { say(usage()); return 0; }
    if (o.postCheck) return postCheck(o);

    if (!fs.existsSync(o.db)) throw new Refusal(`database not found: ${o.db}`);
    const dbPath = fs.realpathSync(o.db);
    assertSqliteFile(dbPath);
    const outDir = assertSafeOutDir(o.outDir);
    fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');

    say(`Test-data cleanup v${TOOL_VERSION} - ${o.execute ? 'EXECUTE' : 'DRY RUN'}`);

    // 1. plan against the live file (read-only)
    const src = await open(dbPath, sqlite3.OPEN_READONLY);
    let plan, ident;
    try {
        await run(src, 'PRAGMA busy_timeout = 30000');
        ident = await identity(src, dbPath);
        plan = await buildPlan(src, o, dbPath);
    } finally { await close(src); }
    printPlan(plan, ident);

    // Refuse BEFORE doing any more work if the real run was asked for on stale or unacknowledged terms.
    if (o.execute) {
        if (o.plan !== plan.fingerprint) throw new Refusal(`--plan ${o.plan} does not match the current plan ${plan.fingerprint}. The data or the options changed since you reviewed it - run the dry run again.`);
        const missing = plan.requiredAcks.filter(t => !o.acks.includes(t));
        if (missing.length) throw new Refusal(`this plan needs --acknowledge ${missing.join(',')} (see "NEEDS YOUR ACKNOWLEDGEMENT" above)`);
    }

    // 2. rehearsal on a throwaway copy - identical code path to the real run
    let rehearsal = null;
    if (!o.noRehearsal) {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-rehearsal-'));
        try { fs.chmodSync(tmpDir, 0o700); } catch (e) { /* windows */ }
        const copy = path.join(tmpDir, 'rehearsal.sqlite');
        say('');
        say('Rehearsing on a private copy of the database (nothing real is touched)...');
        await backupTo(dbPath, copy);
        const rdb = await open(copy, sqlite3.OPEN_READWRITE);
        try {
            await run(rdb, 'PRAGMA foreign_keys = ON');
            await run(rdb, 'PRAGMA busy_timeout = 30000');
            await exec(rdb, 'BEGIN IMMEDIATE');
            const rplan = await buildPlan(rdb, o, dbPath);
            if (rplan.fingerprint !== plan.fingerprint) throw new Error('rehearsal plan differs from the live plan - the database changed while planning; try again');
            rehearsal = await applyPlan(rdb, rplan, o);
            await exec(rdb, 'ROLLBACK');
        } catch (e) {
            try { await exec(rdb, 'ROLLBACK'); } catch (_) { /* ignore */ }
            throw new Error(`REHEARSAL FAILED - nothing was changed. ${e.message}`);
        } finally {
            await close(rdb);
            try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
        }
        say('Rehearsal passed: every step matched the plan, no new foreign-key violations, integrity ok.');
        printComparison(rehearsal);
    }

    const manifestFile = path.join(outDir, `cleanup-manifest-${stamp}.json`);
    const manifest = { generated: new Date().toISOString(), mode: o.execute ? 'execute' : 'dry-run', database: ident, plan, rehearsal: rehearsal && { results: rehearsal.results, before: rehearsal.before.metrics, after: rehearsal.after.metrics, unchangedTables: rehearsal.unchanged } };
    fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 1), { mode: 0o600 });

    if (!o.execute) {
        say('');
        say(`Manifest : ${manifestFile}`);
        say(`PLAN FINGERPRINT: ${plan.fingerprint}`);
        say('');
        say('Nothing was changed. To run it for real, review the above, then re-run with:');
        say(`  --execute --plan ${plan.fingerprint}${plan.requiredAcks.length ? ` --acknowledge ${plan.requiredAcks.join(',')}` : ''}   (plus the same --db/--cutoff/--out-dir/scope options)`);
        return 0;
    }

    // 3. real run
    if (plan.options.payfastHold === 'release') say('PayFast hold RELEASED on your confirmation that the dashboard shows no real payments.');

    const live = await open(dbPath, sqlite3.OPEN_READWRITE);
    let committed = false;
    const backupFile = path.join(outDir, `pre-cleanup-${path.basename(dbPath).replace(/[^\w.-]/g, '_')}-${stamp}.sqlite`);
    try {
        await run(live, 'PRAGMA foreign_keys = ON');
        await run(live, 'PRAGMA busy_timeout = 60000');
        say('');
        say('Taking the write lock (the live site waits, it does not fail)...');
        await exec(live, 'BEGIN IMMEDIATE');

        // plan again, now that nobody else can write
        const lplan = await buildPlan(live, o, dbPath);
        if (lplan.fingerprint !== o.plan) throw new Refusal('the data changed between your dry run and now - nothing was deleted. Run the dry run again.');

        say(`Backing up to ${backupFile} ...`);
        const t0 = Date.now();
        await backupTo(dbPath, backupFile);
        try { fs.chmodSync(backupFile, 0o600); } catch (_) { /* windows */ }
        const backupSha = await sha256File(backupFile);               // hash the file exactly as written, before anything opens it
        // immutable=1: SQLite takes no locks and creates no -wal/-shm helper files, so verifying cannot alter the backup.
        const bdb = await open(`file:${backupFile.replace(/\\/g, '/').replace(/^([A-Za-z]):/, '/$1:')}?immutable=1`, sqlite3.OPEN_READONLY | sqlite3.OPEN_URI);
        let backupIntegrity, backupCounts;
        try { backupIntegrity = await scalar(bdb, 'PRAGMA integrity_check'); backupCounts = await counts(bdb); } finally { await close(bdb); }
        const liveCounts = await counts(live);
        const mismatched = Object.keys(liveCounts).filter(t => backupCounts[t] !== liveCounts[t]);
        if (backupIntegrity !== 'ok' || mismatched.length) throw new Error(`backup did not verify (integrity=${backupIntegrity}, differing tables: ${mismatched.join(', ') || 'none'}) - NOTHING deleted`);
        if (await sha256File(backupFile) !== backupSha) throw new Error('backup file changed while it was being verified - NOTHING deleted');
        fs.writeFileSync(backupFile + '.sha256', `${backupSha}  ${path.basename(backupFile)}\n`);
        say(`Backup verified in ${Date.now() - t0} ms: integrity_check ok, ${Object.keys(liveCounts).length} tables with identical row counts, sha256 ${backupSha.slice(0, 16)}...`);

        const result = await applyPlan(live, lplan, o);
        await exec(live, 'COMMIT');
        committed = true;
        say('COMMITTED.');
        printComparison(result);

        const final = { ...manifest, mode: 'execute', backup: { file: backupFile, sha256: backupSha, integrity: backupIntegrity }, result: { results: result.results, before: result.before.metrics, after: result.after.metrics } };
        fs.writeFileSync(manifestFile, JSON.stringify(final, null, 1), { mode: 0o600 });
        say('');
        say(`Manifest : ${manifestFile}`);
        say(`Backup   : ${backupFile}  (sha256 in ${path.basename(backupFile)}.sha256)`);
        say('');
        say('TO UNDO (only if something is wrong): on Render, copy the backup to a NEW file, e.g.');
        say(`  cp "${backupFile}" "${path.join(path.dirname(dbPath), 'restored-' + stamp + '.sqlite')}"`);
        say('then set DB_PATH to that new file in the service Environment and redeploy. The original backup stays untouched.');
        say('Then delete the listed Google Calendar events, wait ~20 minutes, and run the post-check from the runbook.');
        return 0;
    } catch (e) {
        if (!committed) { try { await exec(live, 'ROLLBACK'); say('ROLLED BACK - the database is exactly as it was.'); } catch (_) { /* nothing open */ } }
        throw e;
    } finally { await close(live); }
}

if (require.main === module) {
    main(process.argv.slice(2)).then((code) => process.exit(code), (e) => {
        if (e instanceof UsageError) { console.error(`\nUsage error: ${e.message}\n${usage()}`); process.exit(64); }
        if (e instanceof Refusal) { console.error(`\nREFUSED: ${e.message}`); process.exit(2); }
        console.error(`\nFAILED: ${e.message}`);
        process.exit(1);
    });
}

module.exports = { main, parseArgs, buildPlan, applyPlan, TOUCHED_TABLES, TOOL_VERSION };
