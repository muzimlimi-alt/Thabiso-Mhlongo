// Run by ledger-adjustments.test.js in its OWN process (it opens the database): the REAL findLedgerDiscrepancies() - the query behind the
// nightly ledger check - against a throwaway DB. A manual ADJUSTMENT (credit / debit) changes what a client OWES; it is not money received,
// so it must neither count as a payment nor hide a payment shortfall. Prints one "CHECK:{...}" line per assertion.
const rec = (name, pass, detail) => console.log('CHECK:' + JSON.stringify({ name, pass: !!pass, detail: pass ? '' : String(detail === undefined ? '' : detail).slice(0, 700) }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    const db = require('../database');
    const q = (sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => e ? rej(e) : res(r)));
    const run = (sql, p = []) => new Promise((res, rej) => db.run(sql, p, function (e) { e ? rej(e) : res(this.lastID); }));

    // init of a brand-new database runs for a few seconds (and rebuilds the banners table); wait until it is really done
    for (let i = 0; i < 200; i++) {
        const t = await q("SELECT name FROM sqlite_master WHERE name IN ('bookings','transactions','settings','services','banners')").catch(() => []);
        const b = await q("SELECT sql FROM sqlite_master WHERE name = 'banners'").catch(() => []);
        const m = await q('SELECT 1 AS x FROM schema_migrations WHERE version = 106').catch(() => []);
        if (t.length === 5 && b[0] && /Birthday/.test(b[0].sql) && m.length) break;
        await sleep(250);
    }
    await sleep(500);

    const eventDate = new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10);
    // a booking whose recorded amount_paid is `paid`, with the given transactions: [type, amount, notes?]
    const mk = async (label, paid, txs) => {
        const id = await run(
            `INSERT INTO bookings (name, email, cell, event_name, event_type, event_location, date, message, status, total_amount, amount_paid, payment_status)
             VALUES (?, ?, '+27821234567', ?, 'Corporate', 'Hall', ?, 'Ledger job child test booking.', 'CONFIRMED', 5000, ?, 'DEPOSIT_PAID')`,
            [`Ledger ${label}`, `${label}@example.invalid`, `Ledger ${label}`, eventDate, paid]);
        for (const [type, amount, notes] of txs) {
            await run(`INSERT INTO transactions (booking_id, amount, transaction_type, status, source, notes, created_at) VALUES (?, ?, ?, 'completed', 'manual', ?, datetime('now'))`, [id, amount, type, notes || null]);
        }
        return id;
    };
    const credit = ['adjustment', 500, '[Adjustment: credit] goodwill'];

    const aOnly   = await mk('adjustment-only', 2000, [['payment', 2000], credit]);                            // recorded 2000 = payments 2000; the credit is not money
    const aDebit  = await mk('debit-only', 2000, [['payment', 2000], ['adjustment', 300, '[Adjustment: debit] extra hour']]);
    const refund  = await mk('refund', 1500, [['payment', 2000], ['refund', 500]]);                            // 2000 - 500 = 1500 = recorded
    const drift   = await mk('real-drift', 1000, [['payment', 2000]]);                                         // recorded 1000, payments 2000: a genuine mismatch
    const driftRf = await mk('drift-with-refund', 1000, [['payment', 2000], ['refund', 500]]);                 // payments 1500 net vs recorded 1000
    const masked  = await mk('masked-shortfall', 2000, [['payment', 1500], credit]);                           // recorded 2000 but only 1500 was paid: the credit must not cover it

    const { findLedgerDiscrepancies } = require('../lib/ledger-reconciliation-job');
    const rows = await findLedgerDiscrepancies();
    const byId = new Map(rows.map((r) => [r.id, r]));

    rec('a booking whose only extra transaction is a credit adjustment is NOT flagged (the credit is not a payment)', !byId.has(aOnly), JSON.stringify(byId.get(aOnly)));
    rec('a debit adjustment is not a payment either', !byId.has(aDebit), JSON.stringify(byId.get(aDebit)));
    rec('a refund is still netted off - recorded R1,500 = R2,000 paid - R500 refunded is not flagged', !byId.has(refund), JSON.stringify(byId.get(refund)));
    rec('a genuine mismatch is still flagged (recorded R1,000, payments R2,000) and the alert quotes the real figure', byId.has(drift) && Number(byId.get(drift).actual) === 2000, JSON.stringify(byId.get(drift)));
    rec('the alert\'s "transaction sum" is signed like the check itself: R2,000 paid - R500 refunded = R1,500 (it printed R2,500)', byId.has(driftRf) && Number(byId.get(driftRf).actual) === 1500, JSON.stringify(byId.get(driftRf)));
    rec('an adjustment cannot HIDE a payment shortfall: recorded R2,000 against R1,500 actually paid is flagged', byId.has(masked) && Number(byId.get(masked).actual) === 1500, JSON.stringify(byId.get(masked)));
    rec('only the three real mismatches are flagged', rows.length === 3, JSON.stringify(rows.map((r) => [r.id, r.recorded, r.actual])));
    process.exit(0);
})().catch((e) => { console.log('CHECK:' + JSON.stringify({ name: 'child crashed', pass: false, detail: String(e && e.stack || e).slice(0, 700) })); process.exit(0); });
