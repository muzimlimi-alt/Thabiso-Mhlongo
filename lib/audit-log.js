// Phase 5 of the housekeeping effort (HOUSEKEEPING-NOTES.md). Moved out of the app.js monolith
// byte-identical. Writes to audit_log, the permanently-excluded generic infra table established in
// Phase 4 (HOUSEKEEPING-NOTES.md) — never claimed by any single domain repository, so this lives
// here as a shared leaf helper instead.
const { dbRun } = require('./db-helpers');

// Shared audit_log writer for tables with NO existing DB trigger (Gallery, Users) — these have
// direct access to req.session here in Node, so role/ip are written straight into the row rather
// than needing the scratch-column-through-a-trigger trick the 4 trigger-covered tables use (see
// the extended audit_bookings_update/audit_events_update/audit_inquiries_update/
// audit_date_holds_update triggers in database.js). Do NOT call this for bookings/events/inquiries/
// date_holds — those already auto-write via their trigger on every UPDATE, and a second explicit
// insert here would duplicate the row.
async function logAudit({ tableName, recordId, action, req, oldValues, newValues, reason }) {
    const adminId = req?.session?.adminId || null;
    const role = req?.session?.role || null;
    const ip = req?.ip || null;
    await dbRun(
        `INSERT INTO audit_log (table_name, record_id, action, old_values, new_values, changed_by, actor_role, ip_address, changes_json, change_timestamp, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)`,
        [
            tableName, recordId, action,
            oldValues ? JSON.stringify(oldValues) : null,
            newValues ? JSON.stringify(newValues) : null,
            adminId ? String(adminId) : 'system',
            role, ip,
            (oldValues || newValues) ? JSON.stringify({ old: oldValues || null, new: newValues || null }) : null,
            reason || null
        ]
    );
}

module.exports = { logAudit };
