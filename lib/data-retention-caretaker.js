// Phase 5 (HOUSEKEEPING-NOTES.md): relocated from app.js verbatim. app.js still calls
// startDataRetentionCaretaker() once, at the same module-load-time position.
const db = require('../database');
const { deleteOldUnsubscribedSubscribers } = require('../database/repositories/newsletter.repository');
const { anonymizeOldInquiries } = require('../database/repositories/inquiries.repository');
const { dbRun } = require('./db-helpers');
const jobMonitor = require('./job-monitor');

// Notification Centre retention (docs-internal/notifications.md). An UNRESOLVED incident is never deleted, whatever its age - only closed
// ones, and info-priority ones sooner. The Activity Log keeps 13 months; job_heartbeats and the audit trail of who resolved what stay in audit_log.
async function pruneNotificationData() {
    const a = await dbRun(`DELETE FROM activity_log WHERE occurred_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-13 months')`);
    const b = await dbRun(`DELETE FROM admin_notifications WHERE status IN ('resolved','archived') AND COALESCE(resolved_at, archived_at, last_seen_at) < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-12 months')`);
    const c = await dbRun(`DELETE FROM admin_notifications WHERE status IN ('resolved','archived') AND priority = 'info' AND COALESCE(resolved_at, archived_at, last_seen_at) < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-90 days')`);
    const d = await dbRun(`DELETE FROM expiry_reminders_sent WHERE sent_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-3 years')`);
    return { activity: a.changes || 0, notifications: (b.changes || 0) + (c.changes || 0), reminders: d.changes || 0 };
}
const monitoredPrune = jobMonitor.monitored('notification-retention', 'Notification & activity log retention', 24 * 60 * 60 * 1000, pruneNotificationData);

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

        monitoredPrune().catch((e) => console.error('✗ Cleanup: notification retention failed:', e.message));

    }, 86400000); // Run once every 24 hours
    setTimeout(() => monitoredPrune().catch((e) => console.error('✗ Cleanup: notification retention failed:', e.message)), 120000);   // and once shortly after boot (a frequently-restarted host may never reach 24 h)
}

module.exports = { startDataRetentionCaretaker, pruneNotificationData };
