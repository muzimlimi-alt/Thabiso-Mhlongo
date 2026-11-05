// Business Activity & Alert Management System - table definitions (migration 119). docs-internal/notifications.md.
//
// NOT the `notifications` table: that name is the e-mail OUTBOX (database.js, drained by lib/background-clerk.js). The tables here are
// the admin's in-app notification centre, kept apart so the outbox's CHECK constraints and retry logic are never disturbed.
//
// Rules:
//   * activity_log is the permanent-ish record of "what happened" (everything important is written, nothing is read-state).
//   * admin_notifications is one row per INCIDENT. A repeat of an open problem bumps occurrence_count instead of adding a row; the
//     partial unique index below makes "at most one open incident per dedupe_key" a database guarantee, not just application logic.
//   * Reading a notification never resolves it: read state is per admin (admin_notification_reads), status is the incident's lifecycle
//     (open -> acknowledged -> resolved -> archived) with who/when/why recorded.
//   * The event registry (lib/notify-events.js) owns categories, default priorities and the mandatory flag; notification_rules and
//     notification_prefs only hold OVERRIDES, and code refuses overrides that would mute a mandatory event.
// All timestamps are ISO-8601 UTC strings written by the application (new Date().toISOString()), so they compare as text.

const MIGRATION_VERSION = 119;
const MIGRATION_NAME = 'notification_centre_and_activity_log';

const STATEMENTS = [
    `CREATE TABLE IF NOT EXISTS activity_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        occurred_at TEXT NOT NULL,
        event_type TEXT NOT NULL,
        category TEXT NOT NULL,
        severity TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('critical', 'high', 'medium', 'info')),
        actor_type TEXT NOT NULL DEFAULT 'system' CHECK (actor_type IN ('admin', 'client', 'system', 'gateway')),
        actor_id TEXT,
        actor_label TEXT,
        entity_type TEXT,
        entity_id TEXT,
        summary TEXT NOT NULL,
        details_json TEXT,
        correlation_id TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_activity_log_time ON activity_log(occurred_at)`,
    `CREATE INDEX IF NOT EXISTS idx_activity_log_category ON activity_log(category, occurred_at)`,
    `CREATE INDEX IF NOT EXISTS idx_activity_log_entity ON activity_log(entity_type, entity_id)`,

    `CREATE TABLE IF NOT EXISTS admin_notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        dedupe_key TEXT NOT NULL,
        event_type TEXT NOT NULL,
        category TEXT NOT NULL,
        priority TEXT NOT NULL CHECK (priority IN ('critical', 'high', 'medium', 'info')),
        kind TEXT NOT NULL CHECK (kind IN ('action', 'attention', 'activity')),
        title TEXT NOT NULL,
        body TEXT,
        entity_type TEXT,
        entity_id TEXT,
        link_json TEXT,
        actions_json TEXT,
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved', 'archived')),
        occurrence_count INTEGER NOT NULL DEFAULT 1,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        ack_by INTEGER REFERENCES admins(id) ON DELETE SET NULL,
        ack_at TEXT,
        resolved_by INTEGER REFERENCES admins(id) ON DELETE SET NULL,
        resolved_at TEXT,
        resolution_note TEXT,
        resolved_auto INTEGER NOT NULL DEFAULT 0 CHECK (resolved_auto IN (0, 1)),
        archived_at TEXT,
        mandatory INTEGER NOT NULL DEFAULT 0 CHECK (mandatory IN (0, 1)),
        email_state TEXT NOT NULL DEFAULT 'none' CHECK (email_state IN ('none', 'queued', 'skipped', 'error')),
        emailed_at TEXT,
        correlation_id TEXT,
        details_json TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_admin_notifications_status ON admin_notifications(status, kind, last_seen_at)`,
    `CREATE INDEX IF NOT EXISTS idx_admin_notifications_category ON admin_notifications(category, last_seen_at)`,
    `CREATE INDEX IF NOT EXISTS idx_admin_notifications_entity ON admin_notifications(entity_type, entity_id)`,
    // At most ONE open (or acknowledged) incident per key; a resolved/archived one frees the key for a genuinely new incident.
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_admin_notifications_open ON admin_notifications(dedupe_key) WHERE status IN ('open', 'acknowledged')`,

    `CREATE TABLE IF NOT EXISTS admin_notification_reads (
        notification_id INTEGER NOT NULL REFERENCES admin_notifications(id) ON DELETE CASCADE,
        admin_id INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
        read_at TEXT NOT NULL,
        PRIMARY KEY (notification_id, admin_id)
    )`,

    // Per-admin preference overrides, one row per (admin, category). NULL = "use the default".
    `CREATE TABLE IF NOT EXISTS notification_prefs (
        admin_id INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
        category TEXT NOT NULL,
        in_app INTEGER CHECK (in_app IN (0, 1)),
        email_min_priority TEXT CHECK (email_min_priority IN ('critical', 'high', 'medium', 'info', 'never')),
        updated_at TEXT NOT NULL,
        PRIMARY KEY (admin_id, category)
    )`,

    // Business-wide per-event overrides of the registry defaults (administrator only). NULL = "use the registry".
    `CREATE TABLE IF NOT EXISTS notification_rules (
        event_type TEXT PRIMARY KEY,
        enabled INTEGER CHECK (enabled IN (0, 1)),
        priority TEXT CHECK (priority IN ('critical', 'high', 'medium', 'info')),
        email INTEGER CHECK (email IN (0, 1)),
        updated_by INTEGER REFERENCES admins(id) ON DELETE SET NULL,
        updated_at TEXT NOT NULL
    )`,

    // A heartbeat per scheduled job (lib/job-monitor.js): the only way to notice a job that has silently stopped running.
    `CREATE TABLE IF NOT EXISTS job_heartbeats (
        job_name TEXT PRIMARY KEY,
        expected_interval_s INTEGER NOT NULL,
        started_at TEXT,
        last_run_at TEXT,
        last_success_at TEXT,
        last_error TEXT,
        last_error_at TEXT,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        missed_alerted_at TEXT
    )`,

    // Expiry reminders already sent, so a reminder stage fires once per (item, expiry date, stage) however often the monitor runs.
    `CREATE TABLE IF NOT EXISTS expiry_reminders_sent (
        item_key TEXT NOT NULL,
        expiry_date TEXT NOT NULL,
        stage TEXT NOT NULL,
        sent_at TEXT NOT NULL,
        PRIMARY KEY (item_key, expiry_date, stage)
    )`
];

// Migration 120 (additive): documents and registrations with an expiry date the owner wants reminders for (domain, SSL, Microsoft 365,
// API credentials, licences, tax documents ...). lib/compliance-monitor.js watches them next to the B-BBEE date in the business profile.
const STATEMENTS_120 = [
    `CREATE TABLE IF NOT EXISTS compliance_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL CHECK (kind IN ('licence', 'tax', 'vat', 'domain', 'ssl', 'm365', 'api', 'insurance', 'other')),
        name TEXT NOT NULL,
        reference TEXT,
        expiry_date TEXT NOT NULL,
        notes TEXT,
        is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
        created_by INTEGER REFERENCES admins(id) ON DELETE SET NULL,
        updated_by INTEGER REFERENCES admins(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_compliance_items_expiry ON compliance_items(is_active, expiry_date)`
];

function apply(db) {
    for (const sql of STATEMENTS) db.run(sql);
    db.run('INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (?, ?)', [MIGRATION_VERSION, MIGRATION_NAME]);
    for (const sql of STATEMENTS_120) db.run(sql);
    db.run("INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (120, 'compliance_items')");
}

module.exports = { MIGRATION_VERSION, MIGRATION_NAME, STATEMENTS, STATEMENTS_120, apply };
