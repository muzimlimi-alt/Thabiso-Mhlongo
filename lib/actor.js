// Phase 5 of the housekeeping effort (HOUSEKEEPING-NOTES.md). Moved out of the app.js monolith
// byte-identical.
const { getAdminNameRoleById } = require('../database/repositories/auth-users.repository');

// Single lookup, resolving an admins.id into a display name + role. Used to build every in-scope
// route's `last_updated` response field, and to populate audit_log for the tables with no existing
// trigger (Gallery, Users) where role can be passed straight into the insert.
async function resolveActor(adminId) {
    if (!adminId) return { name: 'System', role: null };
    const row = await getAdminNameRoleById(adminId);
    if (!row) return { name: 'System', role: null };
    return { name: row.full_name || row.username || 'System', role: row.role || null };
}

module.exports = { resolveActor };
