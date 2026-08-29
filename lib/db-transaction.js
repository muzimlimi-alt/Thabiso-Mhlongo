// Transaction serialization queue — Phase 5 of the housekeeping effort (HOUSEKEEPING-NOTES.md).
// Moved out of the app.js monolith byte-identical. ~21 call sites throughout app.js. MUST stay a
// true singleton: dbTxnQueue is the one shared chain every BEGIN/COMMIT/ROLLBACK section queues
// behind, so every caller — app.js and any route file — has to import this exact module rather
// than each getting its own copy, or the whole point (making concurrent guarded sections atomic
// with respect to each other) silently stops working. CommonJS's module cache guarantees that as
// long as everyone requires this same file.
//
// Concurrent independent writes (e.g. simultaneous booking submissions) used to interleave their
// own BEGIN/COMMIT/ROLLBACK with each other — the losing requests returned HTTP 500 and the lead
// was dropped. Worse, statements from an unrelated request that interleaved with an open
// transaction got swept into it and discarded by its ROLLBACK.
//
// Queuing guarded sections behind one another makes BEGIN → COMMIT/ROLLBACK atomic with respect
// to other guarded sections. Every `BEGIN TRANSACTION` site in this file should migrate onto this
// helper; the public booking intake was the first.
let dbTxnQueue = Promise.resolve();
function withDbTransaction(fn) {
    const result = dbTxnQueue.then(fn, fn);
    // Keep the chain alive regardless of how `fn` settled, so one failed transaction
    // does not wedge every subsequent one.
    dbTxnQueue = result.then(() => {}, () => {});
    return result;
}

module.exports = { withDbTransaction };
