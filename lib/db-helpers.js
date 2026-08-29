// Generic promise wrappers over the shared sqlite connection — Phase 5 of the housekeeping effort
// (HOUSEKEEPING-NOTES.md). Moved out of the app.js monolith byte-identical. Used pervasively
// (~190 call sites) by business-logic code that hasn't been claimed by any Phase 4 domain
// repository — mostly multi-domain orchestration (POPIA erasure, applyStatusChange, the
// background-clerk cron, etc.) and shared helpers like logAudit/resolveActor. Extracted to its own
// leaf module (no dependency on app.js) so both app.js and any route file extracted out of it can
// import these without a circular require.
const db = require('../database');

// dbRun resolves with the sqlite3 statement context, so `.lastID` / `.changes` stay available.
const dbRun = (sql, params = []) => new Promise((resolve, reject) => {
    db.run(sql, params, function (err) { err ? reject(err) : resolve(this); });
});
const dbGet = (sql, params = []) => new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => err ? reject(err) : resolve(row));
});
const dbAll = (sql, params = []) => new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows));
});

module.exports = { dbRun, dbGet, dbAll };
