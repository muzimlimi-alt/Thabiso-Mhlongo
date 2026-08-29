// Phase 5 of the housekeeping effort (HOUSEKEEPING-NOTES.md). Originally two module-scoped `let`
// variables in app.js (defaults overridden from the settings table at startup, and again whenever
// PUT /api/admin/working-hours saves new values). CommonJS requires copy primitive values at
// import time, not live bindings, so plain `let` exports would silently desync the moment the
// write and a read of it live in different files — this wraps both in one object instead,
// specifically so mutating a property (not reassigning the export) stays visible everywhere that
// imports it, in app.js and in any route file. Values and behavior are unchanged; only the
// let-variable -> shared-object shape changed to survive being split across files.
const bookingConfig = {
    minGapMins: 30,   // global buffer minutes between consecutive bookings
    typeBuffers: {},  // per-event-type buffer overrides; falls back to minGapMins
};

module.exports = { bookingConfig };
