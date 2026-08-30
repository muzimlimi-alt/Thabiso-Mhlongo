// Regression test for the bug fixed in routes/admin/bank-statement.js (HOUSEKEEPING-NOTES.md,
// Deferred fix #4): POST /api/admin/bank-statement/import used to wrap its insert loop in
// `db.transaction(() => {...})` over a `db.prepare(...)` statement — both better-sqlite3 APIs that
// don't exist on this app's plain sqlite3.Database — so every import threw before a single row was
// inserted. No test exercised this route before, which is exactly how the bug went unnoticed; this
// file exists so it can't regress silently again.
const { upload, api, q } = require('./support');

module.exports = async function ({ check }) {
    const csv = [
        'Date,Description,Amount,Reference',
        '2026-01-15,Client Payment,1500.00,REF001',
        '2026-01-16,"Bank charges, monthly",-50.00,REF002',
        'onlytwo,fields',
        '2026-01-18,Bad amount row,notanumber,REF003',
    ].join('\n');

    const res = await upload(
        'POST', '/api/admin/bank-statement/import', {},
        { buffer: Buffer.from(csv, 'utf8'), filename: 'statement.csv', contentType: 'text/csv' },
        'statement'
    );
    check('import: 200, not a 500 from the old db.transaction crash', res.status === 200 && res.body.success, JSON.stringify(res.body));
    check('import: batch_id returned', typeof res.body?.batch_id === 'string' && res.body.batch_id.startsWith('BS-'), JSON.stringify(res.body));
    check('import: header row skipped, malformed/non-numeric rows skipped -> imported=2', res.body?.imported === 2, JSON.stringify(res.body));

    const rows = await q('SELECT * FROM bank_statement_lines WHERE import_batch = ? ORDER BY statement_date', [res.body.batch_id]);
    check('import: exactly 2 rows actually persisted', rows.length === 2, JSON.stringify(rows));
    check('import: first row fields (date/description/amount/reference) correct', rows[0] && rows[0].statement_date === '2026-01-15' && rows[0].description === 'Client Payment' && Math.abs(rows[0].amount - 1500) < 0.001 && rows[0].reference === 'REF001', JSON.stringify(rows[0]));
    check('import: quoted comma inside description parsed as one field, negative amount preserved', rows[1] && rows[1].description === 'Bank charges, monthly' && Math.abs(rows[1].amount - (-50)) < 0.001, JSON.stringify(rows[1]));
    check('import: rows start unmatched', rows.every(r => r.matched_booking_id === null && r.matched_transaction_id === null), JSON.stringify(rows));

    // ── The already-working list route reflects the now-successfully-imported batch ──
    const listRes = await api('GET', `/api/admin/bank-statement/lines?batch_id=${res.body.batch_id}`);
    check('list: 200, sees both imported lines for this batch', listRes.status === 200 && listRes.body.lines?.length === 2, JSON.stringify(listRes.body?.lines?.length));
    check('list: batches summary includes this batch', (listRes.body.batches || []).some(b => b.import_batch === res.body.batch_id), JSON.stringify(listRes.body.batches));

    const unmatchedRes = await api('GET', `/api/admin/bank-statement/lines?batch_id=${res.body.batch_id}&unmatched_only=1`);
    check('list: unmatched_only=1 still includes both fresh rows', unmatchedRes.body.lines?.length === 2, JSON.stringify(unmatchedRes.body?.lines?.length));

    // ── An all-blank/all-header file imports zero rows without erroring ──
    const emptyRes = await upload(
        'POST', '/api/admin/bank-statement/import', {},
        { buffer: Buffer.from('Date,Description,Amount,Reference\n', 'utf8'), filename: 'empty.csv', contentType: 'text/csv' },
        'statement'
    );
    check('import: header-only file -> 200, imported=0', emptyRes.status === 200 && emptyRes.body.success && emptyRes.body.imported === 0, JSON.stringify(emptyRes.body));

    // ── cleanup: delete the batch this test created ──
    const delRes = await api('DELETE', `/api/admin/bank-statement/batch/${res.body.batch_id}`);
    check('cleanup: batch delete succeeds', delRes.status === 200 && delRes.body.success, JSON.stringify(delRes.body));
    const afterDelete = await q('SELECT * FROM bank_statement_lines WHERE import_batch = ?', [res.body.batch_id]);
    check('cleanup: no rows remain for the deleted batch', afterDelete.length === 0, JSON.stringify(afterDelete));
};
