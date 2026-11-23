// Dynamic RBAC permission system schema — migration 123.
// Tables: rbac_roles, rbac_permissions, rbac_role_permissions, rbac_user_overrides.
// Applied via require('./lib/rbac-schema').apply(db) in database.js.
//
// Seed data (system roles + default permission grants) runs ONCE, gated on migration 123 not
// yet recorded. An admin revoking a permission via the matrix will never have it silently
// re-granted by a server restart.

const registry = require('./rbac-registry');

const MIGRATION_VERSION = 123;
const MIGRATION_NAME = 'rbac_dynamic_permissions';

// DDL only — idempotent CREATE TABLE / INDEX statements.
const STATEMENTS = [
    // System and custom roles.
    `CREATE TABLE IF NOT EXISTS rbac_roles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        description TEXT,
        base_role TEXT NOT NULL DEFAULT 'assistant' CHECK (base_role IN ('administrator', 'manager', 'assistant')),
        is_system INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0, 1)),
        is_protected INTEGER NOT NULL DEFAULT 0 CHECK (is_protected IN (0, 1)),
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
        created_at TEXT NOT NULL,
        created_by INTEGER REFERENCES admins(id) ON DELETE SET NULL,
        modified_at TEXT,
        modified_by INTEGER REFERENCES admins(id) ON DELETE SET NULL
    )`,

    // Every possible <module>.<action> pair, with optional sensitivity flag.
    `CREATE TABLE IF NOT EXISTS rbac_permissions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT NOT NULL UNIQUE,
        module TEXT NOT NULL,
        action TEXT NOT NULL,
        label TEXT NOT NULL,
        description TEXT,
        is_sensitive INTEGER NOT NULL DEFAULT 0 CHECK (is_sensitive IN (0, 1))
    )`,
    `CREATE INDEX IF NOT EXISTS idx_rbac_permissions_module ON rbac_permissions(module)`,

    // Role → permission grant matrix. Absence = deny.
    `CREATE TABLE IF NOT EXISTS rbac_role_permissions (
        role_id INTEGER NOT NULL REFERENCES rbac_roles(id) ON DELETE CASCADE,
        permission_id INTEGER NOT NULL REFERENCES rbac_permissions(id) ON DELETE CASCADE,
        PRIMARY KEY (role_id, permission_id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_rbac_role_perms_role ON rbac_role_permissions(role_id)`,

    // Per-user allow/deny overrides. Precedence (high→low): protected restriction →
    // user deny → user grant → role allow → default deny.
    `CREATE TABLE IF NOT EXISTS rbac_user_overrides (
        admin_id INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
        permission_id INTEGER NOT NULL REFERENCES rbac_permissions(id) ON DELETE CASCADE,
        effect TEXT NOT NULL CHECK (effect IN ('allow', 'deny')),
        granted_by INTEGER REFERENCES admins(id) ON DELETE SET NULL,
        granted_at TEXT NOT NULL,
        reason TEXT,
        PRIMARY KEY (admin_id, permission_id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_rbac_user_overrides_admin ON rbac_user_overrides(admin_id)`,
];

function apply(db) {
    // Create tables (always idempotent)
    for (const sql of STATEMENTS) db.run(sql);

    // Seed data: gated on migration 123 not yet recorded. This prevents re-seeding after an
    // admin revokes a default permission — only runs on first ever boot after this deploy.
    db.get('SELECT 1 FROM schema_migrations WHERE version = ?', [MIGRATION_VERSION], (err, row) => {
        if (row) return; // already migrated

        const now = new Date().toISOString();

        db.serialize(() => {
            // 1. System roles
            const systemRoles = [
                {
                    key: 'administrator',
                    name: 'Administrator',
                    description: 'Full system access. Protected: cannot be deleted or demoted.',
                    base_role: 'administrator',
                    is_protected: 1,
                },
                {
                    key: 'manager',
                    name: 'Manager',
                    description: 'Operations access: bookings, finance, inquiries, content.',
                    base_role: 'manager',
                    is_protected: 0,
                },
                {
                    key: 'assistant',
                    name: 'Assistant',
                    description: 'Limited access: view and create on day-to-day sections.',
                    base_role: 'assistant',
                    is_protected: 0,
                },
            ];
            for (const r of systemRoles) {
                db.run(
                    `INSERT OR IGNORE INTO rbac_roles
                     (key, name, description, base_role, is_system, is_protected, status, created_at)
                     VALUES (?, ?, ?, ?, 1, ?, 'active', ?)`,
                    [r.key, r.name, r.description, r.base_role, r.is_protected, now]
                );
            }

            // 2. Permissions (one row per <module>.<action>)
            const { MODULES, SENSITIVE_PERMISSIONS } = registry;
            for (const [mod, def] of Object.entries(MODULES)) {
                for (const action of def.actions) {
                    const key = `${mod}.${action}`;
                    const label = `${def.label}: ${action.charAt(0).toUpperCase() + action.slice(1)}`;
                    const isSensitive = SENSITIVE_PERMISSIONS.has(key) ? 1 : 0;
                    db.run(
                        `INSERT OR IGNORE INTO rbac_permissions (key, module, action, label, is_sensitive)
                         VALUES (?, ?, ?, ?, ?)`,
                        [key, mod, action, label, isSensitive]
                    );
                }
            }

            // 3. Role → permission grants (sub-SELECT avoids needing to fetch IDs first)
            const { allPermissionsForRole } = registry;
            for (const roleKey of ['administrator', 'manager', 'assistant']) {
                for (const permKey of allPermissionsForRole(roleKey)) {
                    db.run(
                        `INSERT OR IGNORE INTO rbac_role_permissions (role_id, permission_id)
                         SELECT r.id, p.id
                         FROM rbac_roles r, rbac_permissions p
                         WHERE r.key = ? AND p.key = ?`,
                        [roleKey, permKey]
                    );
                }
            }

            // Record migration last — this is the gate that prevents re-seeding on restart.
            db.run(
                'INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (?, ?)',
                [MIGRATION_VERSION, MIGRATION_NAME]
            );

            console.log('[migration 123] Dynamic RBAC permission system installed.');
        });
    });
}

module.exports = { MIGRATION_VERSION, MIGRATION_NAME, STATEMENTS, apply };
