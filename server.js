// Process entry point — Phase 5 of the housekeeping effort (HOUSEKEEPING-NOTES.md). app.js now
// owns config, middleware and routes; this file's job is just requiring it and listening.
// PORT is read after requiring ./app (not before) because app.js's own require('dotenv').config()
// call needs to run first — same ordering the old monolith had, just split across two files now.
const { app, loadPendingScheduledJobs, loadPendingDirectEmails } = require('./app');
const db = require('./database');

// Production-readiness pass (2026-10-12): without these, a single uncaught throw or unhandled
// promise rejection anywhere in this process — a route, a scheduled job, a fire-and-forget email
// send that was missed — either crashes the whole server silently (older Node default for
// unhandledRejection) or, for a true uncaughtException, leaves the process in a now-undefined
// state while Express keeps accepting new requests against it. Log loudly either way so it's never
// silently lost; exit(1) only for uncaughtException, so whatever's hosting this (Render) restarts a
// clean process rather than this one limping on half-broken. No deploy config in this repo sets up
// a separate process manager, so "the platform restarts on exit" is the actual safety net here.
process.on('unhandledRejection', (reason) => {
    console.error('🚨 UNHANDLED REJECTION — this indicates a missing .catch() somewhere:', reason);
});
process.on('uncaughtException', (err) => {
    console.error('🚨 UNCAUGHT EXCEPTION — process will exit for a clean restart:', err);
    process.exit(1);
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`✅ File Upload Server running at http://localhost:${PORT}`);
    console.log(`✅ Email Dispatcher running at POST /send-email`);
    console.log(`✅ Newsletter Server running at POST /send-newsletter`);
    console.log(`Admin page will now save files physically to your images/ folder structure.`);

    // Load pending scheduled newsletter jobs
    setTimeout(loadPendingScheduledJobs, 1000);

    // Load pending scheduled direct emails
    setTimeout(loadPendingDirectEmails, 1500);

    // Quote Amount Consistency Check
    setTimeout(() => {
        db.all(`
            SELECT b.id, b.quote_amount as legacy_amount, lq.total_amount as real_amount
            FROM bookings b
            JOIN quotations lq ON lq.id = (SELECT MAX(id) FROM quotations WHERE booking_id = b.id AND status != 'void')
        `, [], (err, rows) => {
            if (!err && rows) {
                let inconsistencies = 0;
                rows.forEach(r => {
                    const legacy = parseFloat((r.legacy_amount || '0').replace(/[^0-9.]/g, '')) || 0;
                    const real = parseFloat(r.real_amount) || 0;
                    if (Math.abs(legacy - real) > 0.01) {
                        console.warn(`[Quote Mismatch] Booking #${r.id} legacy string is ${r.legacy_amount} but real quote total is R ${real.toFixed(2)}`);
                        inconsistencies++;
                    }
                });
                if (inconsistencies > 0) {
                    console.log(`[Consistency Check] Found ${inconsistencies} bookings with legacy quote mismatches. Display logic will use real quote amounts.`);
                }
            }
        });
    }, 5000);
});
