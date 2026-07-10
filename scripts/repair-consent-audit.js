#!/usr/bin/env node
/*
 * One-time consent_audit integrity repair. IDEMPOTENT — safe to re-run.
 *
 * Two legacy problems (the current code no longer produces either: new bookings write the audit row
 * inside the intake transaction, and the booking-delete route now purges consent_audit):
 *
 *   1. Consented bookings with NO consent_audit row. The booking itself is evidence of consent
 *      (popia_consent = 1 + consent_timestamp), but the detailed audit row was never written. We
 *      reconstruct one from the booking's own consent fields, marked consent_source =
 *      'reconstructed_from_booking' so it is never mistaken for an original capture-time record.
 *      ip_address / user_agent are left NULL — they were not stored on these legacy bookings.
 *
 *   2. Orphaned consent_audit rows pointing at booking_ids that no longer exist. These are debris
 *      from deletes that predate consent_audit being added to the delete-cascade. They cannot be
 *      tied to any booking or client. Removed only with --purge-orphans (off by default, so the
 *      default run is purely additive).
 *
 * Usage:
 *   node scripts/repair-consent-audit.js                # dry run — reports only
 *   node scripts/repair-consent-audit.js --apply        # backfill missing rows (additive)
 *   node scripts/repair-consent-audit.js --apply --purge-orphans   # also delete orphaned rows
 *
 * Always back up database.sqlite before --apply.
 */
const path = require('path');
const sqlite3 = require('sqlite3');
const DB = path.resolve(__dirname, '..', 'database.sqlite');
const APPLY = process.argv.includes('--apply');
const PURGE = process.argv.includes('--purge-orphans');

const db = new sqlite3.Database(DB);
const all = (sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => e ? rej(e) : res(r)));
const run = (sql, p = []) => new Promise((res, rej) => db.run(sql, p, function (e) { e ? rej(e) : res(this); }));

(async () => {
    await run('PRAGMA foreign_keys = ON');

    const missing = await all(`
        SELECT b.id, b.consent_timestamp, b.created_at, b.policy_version, b.email
        FROM bookings b
        WHERE b.popia_consent = 1
          AND NOT EXISTS (SELECT 1 FROM consent_audit c WHERE c.booking_id = b.id)
        ORDER BY b.id`);
    const orphans = await all(`
        SELECT c.id, c.booking_id FROM consent_audit c
        WHERE NOT EXISTS (SELECT 1 FROM bookings b WHERE b.id = c.booking_id)
        ORDER BY c.id`);

    console.log(`consented bookings missing an audit row : ${missing.length}`);
    console.log(`orphaned consent_audit rows             : ${orphans.length}`);
    if (!APPLY) {
        console.log('\nDry run. Re-run with --apply to backfill the missing rows' + (PURGE ? '' : ' (add --purge-orphans to also remove orphans).'));
        process.exit(0);
    }

    let inserted = 0;
    for (const b of missing) {
        await run(
            `INSERT INTO consent_audit (booking_id, ip_address, user_agent, consented_at, policy_version, consent_source, consent_type, source_email)
             VALUES (?, NULL, NULL, ?, ?, 'reconstructed_from_booking', 'booking', ?)`,
            [b.id, b.consent_timestamp || b.created_at, b.policy_version || 'unknown', b.email || null]);
        inserted++;
    }
    console.log(`\nbackfilled ${inserted} consent_audit row(s) (source='reconstructed_from_booking').`);

    let purged = 0;
    if (PURGE) {
        for (const o of orphans) { await run('DELETE FROM consent_audit WHERE id = ?', [o.id]); purged++; }
        console.log(`purged ${purged} orphaned consent_audit row(s).`);
    } else if (orphans.length) {
        console.log(`left ${orphans.length} orphaned row(s) in place (pass --purge-orphans to remove).`);
    }

    const stillMissing = (await all(`SELECT COUNT(*) c FROM bookings b WHERE b.popia_consent=1 AND NOT EXISTS(SELECT 1 FROM consent_audit c WHERE c.booking_id=b.id)`))[0].c;
    console.log(`\nremaining consented bookings without an audit row: ${stillMissing} (expect 0).`);
    process.exit(0);
})().catch(e => { console.error('repair failed:', e.message); process.exit(1); });
