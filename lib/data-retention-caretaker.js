// Phase 5 (HOUSEKEEPING-NOTES.md): relocated from app.js verbatim. app.js still calls
// startDataRetentionCaretaker() once, at the same module-load-time position.
const db = require('../database');
const { deleteOldUnsubscribedSubscribers } = require('../database/repositories/newsletter.repository');
const { anonymizeOldInquiries } = require('../database/repositories/inquiries.repository');

/**
 * Data Retention Caretaker (POPIA Compliance)
 * Ensures data is not kept longer than necessary.
 */
function startDataRetentionCaretaker() {
    console.log('Starting [Compliance Caretaker] - Managing record retention...');
    setInterval(() => {
        // 1. Delete inactive newsletter subscribers (unsubscribed for > 1 year)
        deleteOldUnsubscribedSubscribers(function(err) {
            if (this.changes > 0) console.log(`✓ POPIA: Removed ${this.changes} long-unsubscribed newsletter records.`);
        });

        // 2. Anonymize old inquiries (2 years)
        // We keep the record for stats but wipe PII
        anonymizeOldInquiries(function(err) {
            if (err) { console.error('✗ POPIA: Failed to anonymize stale inquiries:', err.message); return; }
            if (this.changes > 0) console.log(`✓ POPIA: Anonymized ${this.changes} stale inquiries.`);
        });

        // 3. Delete system logs (audit_log) older than 1 year
        db.run("DELETE FROM audit_log WHERE change_timestamp < date('now', '-1 year')", function(err) {
            if (this.changes > 0) console.log(`✓ Cleanup: Removed ${this.changes} old audit logs.`);
        });

    }, 86400000); // Run once every 24 hours
}

module.exports = { startDataRetentionCaretaker };
