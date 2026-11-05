// Event ticketing - table definitions (migration 112). Ticketing EXTENDS the existing events table: every tier, order and ticket hangs
// off events(event_id). The PayFast ledger tables (transactions, payfast_payment_intents, payment_logs) all require a booking, so ticket
// orders carry their own payment facts here instead; the safety net (lib/payfast-reconcile.js) reads both. docs-internal/ticketing.md.
//
// Relationship rules:
//   * money records never cascade: an event, tier or order that has orders/tickets cannot be deleted (RESTRICT) - it is closed or
//     cancelled instead. Only an order's own line items follow it (CASCADE), and nothing deletes a paid order.
//   * the database itself refuses to oversell: CHECK (sold + reserved <= capacity) on every tier, on top of the conditional UPDATE the
//     reservation runs (lib/ticketing.js).
//   * tokens and references are UNIQUE random values (lib/ticketing-core.js), never derived from an id.
//   * a PayFast payment is processed once: ticket_orders.gateway_payment_id is UNIQUE, and a VERIFIED notification is stored once per
//     (payment, status) - an unverified post is logged but can never occupy that slot ahead of the genuine one.
// All timestamps are ISO-8601 UTC strings written by the application (new Date().toISOString()), so they compare as text.

const MIGRATION_VERSION = 112;
const MIGRATION_NAME = 'event_ticketing';

const STATEMENTS = [
    `CREATE TABLE IF NOT EXISTS ticket_types (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id INTEGER NOT NULL REFERENCES events(event_id) ON DELETE RESTRICT,
        name TEXT NOT NULL,
        description TEXT,
        price_cents INTEGER NOT NULL CHECK (price_cents >= 500),
        capacity INTEGER NOT NULL CHECK (capacity >= 0),
        sold INTEGER NOT NULL DEFAULT 0 CHECK (sold >= 0),
        reserved INTEGER NOT NULL DEFAULT 0 CHECK (reserved >= 0),
        sales_start TEXT,
        sales_end TEXT,
        max_per_order INTEGER NOT NULL DEFAULT 10 CHECK (max_per_order BETWEEN 1 AND 20),
        is_active INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0, 1)),
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_by INTEGER REFERENCES admins(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (sold + reserved <= capacity),
        UNIQUE (event_id, name)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_ticket_types_event ON ticket_types(event_id)`,

    `CREATE TABLE IF NOT EXISTS ticket_orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        public_reference TEXT NOT NULL UNIQUE,
        event_id INTEGER NOT NULL REFERENCES events(event_id) ON DELETE RESTRICT,
        m_payment_id TEXT UNIQUE,
        buyer_name TEXT,
        buyer_email TEXT,
        buyer_phone TEXT,
        holder_names TEXT,
        total_cents INTEGER NOT NULL CHECK (total_cents >= 0),
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'failed', 'expired', 'refunded')),
        gateway_payment_id TEXT UNIQUE,
        reserved_until TEXT NOT NULL,
        checkout_started_at TEXT,
        refund_required INTEGER NOT NULL DEFAULT 0 CHECK (refund_required IN (0, 1)),
        refund_reason TEXT,
        consent_at TEXT,
        consent_policy_version TEXT,
        created_at TEXT NOT NULL,
        paid_at TEXT,
        expired_at TEXT,
        failed_at TEXT,
        refunded_at TEXT,
        refunded_by INTEGER REFERENCES admins(id) ON DELETE SET NULL,
        refund_note TEXT,
        tickets_emailed_at TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_ticket_orders_event_status ON ticket_orders(event_id, status)`,
    `CREATE INDEX IF NOT EXISTS idx_ticket_orders_hold ON ticket_orders(status, reserved_until)`,
    `CREATE INDEX IF NOT EXISTS idx_ticket_orders_email ON ticket_orders(buyer_email)`,

    `CREATE TABLE IF NOT EXISTS ticket_order_items (
        order_id INTEGER NOT NULL REFERENCES ticket_orders(id) ON DELETE CASCADE,
        ticket_type_id INTEGER NOT NULL REFERENCES ticket_types(id) ON DELETE RESTRICT,
        quantity INTEGER NOT NULL CHECK (quantity > 0),
        unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0),
        PRIMARY KEY (order_id, ticket_type_id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_ticket_order_items_type ON ticket_order_items(ticket_type_id)`,

    `CREATE TABLE IF NOT EXISTS tickets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id INTEGER NOT NULL REFERENCES ticket_orders(id) ON DELETE RESTRICT,
        ticket_type_id INTEGER NOT NULL REFERENCES ticket_types(id) ON DELETE RESTRICT,
        holder_name TEXT,
        token TEXT NOT NULL UNIQUE,
        checked_in_at TEXT,
        checked_in_by INTEGER REFERENCES admins(id) ON DELETE SET NULL,
        voided_at TEXT,
        created_at TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_tickets_order ON tickets(order_id)`,
    `CREATE INDEX IF NOT EXISTS idx_tickets_type ON tickets(ticket_type_id)`,

    // Every PayFast notification (and every safety-net recovery) for a ticket order, verified or not - the audit trail and the ONLY
    // place a full payload (which carries the buyer's name and email) is kept.
    `CREATE TABLE IF NOT EXISTS ticket_webhook_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id INTEGER REFERENCES ticket_orders(id) ON DELETE SET NULL,
        gateway_payment_id TEXT,
        m_payment_id TEXT,
        payment_status TEXT,
        amount_cents INTEGER,
        source TEXT NOT NULL CHECK (source IN ('itn', 'reconcile')),
        verified INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0, 1)),
        outcome TEXT,
        raw_payload TEXT,
        received_at TEXT NOT NULL
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_ticket_webhook_verified ON ticket_webhook_events(gateway_payment_id, payment_status)
        WHERE verified = 1 AND gateway_payment_id IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS idx_ticket_webhook_order ON ticket_webhook_events(order_id)`,

    // The tickets e-mail gets a banner slot in the existing Email Banners screen (js/bannerRegistry.js), like every other template.
    `INSERT OR IGNORE INTO email_template_banners (template_key, category) VALUES ('ticket_confirmation', 'Event Tickets')`
];

// The safety net's findings may now point at a ticket order instead of a booking (booking_id there is already nullable).
const ALTERS = [
    'ALTER TABLE payfast_reconcile_findings ADD COLUMN ticket_order_id INTEGER REFERENCES ticket_orders(id) ON DELETE SET NULL'
];

// Migration 113 (additive): hold_key = a random key the buyer's BROWSER sends (not personal data, not an address) so a second hold for the
// same show from the same browser replaces the first instead of stacking; event_notice_sent_at = when the buyer was e-mailed that the show
// was cancelled / postponed (each buyer is told once).
const ALTERS_113 = [
    'ALTER TABLE ticket_orders ADD COLUMN hold_key TEXT',
    'ALTER TABLE ticket_orders ADD COLUMN event_notice_sent_at TEXT'
];
const AFTER_113 = ['CREATE INDEX IF NOT EXISTS idx_ticket_orders_hold_key ON ticket_orders(hold_key, event_id, status)'];

// Called from database.js inside initializeDatabase()'s db.serialize() block, after migration 111.
function apply(db) {
    const note = (err) => { if (err && !err.message.includes('duplicate column name')) console.log('Note: ticketing migration: ' + err.message); };
    for (const sql of STATEMENTS) db.run(sql);
    for (const sql of ALTERS) db.run(sql, note);
    db.run('INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (?, ?)', [MIGRATION_VERSION, MIGRATION_NAME]);
    for (const sql of ALTERS_113) db.run(sql, note);
    for (const sql of AFTER_113) db.run(sql);                 // serialize() runs these after the columns exist
    db.run("INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (113, 'ticketing_hold_key_and_event_notices')");
    // Migration 114 (additive): which version of the ticket terms the buyer accepted (next to consent_at / consent_policy_version).
    db.run('ALTER TABLE ticket_orders ADD COLUMN terms_version TEXT', note);
    db.run("INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (114, 'ticketing_terms_version')");
    // Migration 115 (additive): door links - a per-show, expiring, revocable link a volunteer opens on any phone to check tickets in for THAT
    // show only, without a portal account. Only a SHA-256 hash of the link's secret is stored. tickets.checked_in_via = which door link.
    db.run(`CREATE TABLE IF NOT EXISTS ticket_door_passes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id INTEGER NOT NULL REFERENCES events(event_id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        label TEXT NOT NULL,
        created_by INTEGER REFERENCES admins(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked_at TEXT,
        last_used_at TEXT
    )`);
    db.run('CREATE INDEX IF NOT EXISTS idx_ticket_door_passes_event ON ticket_door_passes(event_id)');
    db.run('ALTER TABLE tickets ADD COLUMN checked_in_via TEXT', note);
    db.run("INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (115, 'ticketing_door_passes')");
    // Migration 116 (additive): complimentary tickets (an order issued by an administrator / manager at R0 - guest list, press, sponsors -
    // counted against capacity, never as revenue) and void-and-reissue of ONE ticket (lost phone, forwarded QR, wrong name): the old ticket is
    // voided with a reason and who did it, the new one points back at it.
    db.run('ALTER TABLE ticket_orders ADD COLUMN complimentary INTEGER NOT NULL DEFAULT 0', note);
    db.run('ALTER TABLE ticket_orders ADD COLUMN issued_by INTEGER REFERENCES admins(id) ON DELETE SET NULL', note);
    db.run('ALTER TABLE ticket_orders ADD COLUMN comp_note TEXT', note);
    db.run('ALTER TABLE tickets ADD COLUMN replaces_ticket_id INTEGER REFERENCES tickets(id) ON DELETE SET NULL', note);
    db.run('ALTER TABLE tickets ADD COLUMN void_reason TEXT', note);
    db.run('ALTER TABLE tickets ADD COLUMN voided_by INTEGER REFERENCES admins(id) ON DELETE SET NULL', note);
    db.run("INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (116, 'ticketing_comps_and_reissue')");
    // Migration 117 (additive): the EVENT-level sales controls, kept apart from the categories' own on/off switch (ticket_types.is_active) so
    // pausing or closing a show never forgets which categories were enabled. No row = "follows the categories" (how every show behaved
    // before). sales_control NULL = open, 'paused' = temporarily stopped (Resume), 'closed' = stopped by the organiser (Reopen).
    // opens_at / closes_at = an optional event-wide sales window (ISO UTC). A settings row, not a money record, so it goes with its event.
    db.run(`CREATE TABLE IF NOT EXISTS ticket_event_sales (
        event_id INTEGER PRIMARY KEY REFERENCES events(event_id) ON DELETE CASCADE,
        sales_control TEXT CHECK (sales_control IN ('paused', 'closed')),
        opens_at TEXT,
        closes_at TEXT,
        changed_by INTEGER REFERENCES admins(id) ON DELETE SET NULL,
        changed_at TEXT NOT NULL
    )`);
    db.run("INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (117, 'ticketing_event_sales_controls')");
}

module.exports = { MIGRATION_VERSION, MIGRATION_NAME, STATEMENTS, ALTERS, ALTERS_113, apply };
