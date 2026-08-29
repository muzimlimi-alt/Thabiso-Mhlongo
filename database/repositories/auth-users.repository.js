// Auth+users domain repository — Phase 4 of the housekeeping effort (HOUSEKEEPING-NOTES.md).
// Covers admins, admin_login_logs, password_reset_tokens. Every SQL string below is byte-identical
// (content-wise; indentation is re-flowed to this file, never the SQL keywords/columns/literals) to
// where it lived in server.js before this move. No req/res, no bcrypt/crypto, no email sending,
// no session handling — those all stay in server.js, exactly where they were.
//
// This is the last of the plan's 8 named Phase 4 domains, and the smallest/most contained. No
// separate `sessions` table exists to extract — session persistence is entirely connect-sqlite3/
// express-session middleware against sessions.sqlite, outside the app's own SQL layer. No 2FA/TOTP
// tables either.
//
// Two of the admins statements below (getAdminsListWithCreatorModifier, getAdminLoginLogsWithNames)
// are genuine same-domain self-JOINs (admins-to-admins, admin_login_logs-to-admins) — not
// cross-domain, so unlike every JOIN found in earlier domains, these moved in full.
//
// `audit_log`'s actor-name-resolution LEFT JOIN admins (server.js, GET /api/admin/audit_log) stays
// in server.js untouched — audit_log is the same permanently-excluded generic infra table
// established in `finance`/`invoices+quotations`, so the whole statement stays regardless of it
// also touching admins. `inquiries`' assigned_to LEFT JOIN admins likewise stays exactly where
// inquiries.repository.js's own header already documented it.
//
// Three admins-only statements were found living inside already-completed `inquiries`-domain
// routes (assignable-admins list, the assign-route active-admin check, the note-author lookup) —
// extracted here; the surrounding inquiries.repository.js calls in those same routes are untouched.
const db = require('../../database');

function promisedGet(sql, params) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => err ? reject(err) : resolve(row));
    });
}

// =====================================================================================
// admins
// =====================================================================================

// ── Session / login-flow reads ──
// Re-checked on every admin request (requireAdmin middleware) so a suspension takes effect
// immediately rather than waiting for the admin's next login.
function getAdminActiveStatus(adminId, callback) {
    db.get("SELECT is_active FROM admins WHERE id = ?", [adminId], callback);
}
function getAdminByEmailFull(email, callback) {
    db.get("SELECT * FROM admins WHERE email = ?", [email], callback);
}
function updateAdminLastLogin(adminId, callback) {
    db.run("UPDATE admins SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?", [adminId], callback);
}
// Backs countOtherActiveAdministrators() (the last-administrator guard shared by the /:id PUT and
// DELETE routes below) — that small JS wrapper stays in server.js, only its SQL moves here.
function getActiveAdministratorCountExcluding(excludeUserId, callback) {
    db.get(
        "SELECT COUNT(*) AS count FROM admins WHERE role = 'administrator' AND is_active = 1 AND id != ?",
        [excludeUserId], callback
    );
}
// 2 byte-identical call sites: the force-change-password route and the token-verified
// reset-password route, both callback style.
function updateAdminPassword(hash, adminId, callback) {
    db.run("UPDATE admins SET password_hash = ?, must_change_password = 0 WHERE id = ?", [hash, adminId], callback);
}
// GET /api/admin/session's primary lookup (by session.adminId) and its username-based fallback —
// same column projection, different WHERE column, so kept as two functions, not one.
function getAdminSessionProfileById(adminId, callback) {
    db.get("SELECT id, username, email, full_name, phone, role, is_active, last_login_at, created_at FROM admins WHERE id = ?", [adminId], callback);
}
function getAdminSessionProfileByUsername(username, callback) {
    db.get("SELECT id, username, email, full_name, phone, role, is_active, last_login_at, created_at FROM admins WHERE username = ?", [username], callback);
}
function getAdminIdAndUsernameByEmail(email, callback) {
    db.get("SELECT id, username FROM admins WHERE email = ?", [email], callback);
}
function getAdminIdByEmail(email, callback) {
    db.get("SELECT id FROM admins WHERE email = ?", [email], callback);
}
// resolveActor() — called from nearly every other domain's routes to resolve an admins.id into a
// display name + role for `last_updated` response fields. The helper itself stays in server.js;
// only its one SELECT moves here, same treatment checkDateAvailability/hasCalendarConflict got
// in the calendar domain. Promise-returning: the original was already `await dbGet(...)`.
function getAdminNameRoleById(adminId) {
    return promisedGet(`SELECT full_name, username, role FROM admins WHERE id = ?`, [adminId]);
}
// The newsletter send-test route's own admin-email lookup. Originally an inline
// `await new Promise((resolve, reject) => db.get(...))` — folded into the shared promisedGet
// helper here, same reject/resolve behavior, not a style change.
function getAdminEmailById(adminId) {
    return promisedGet("SELECT email FROM admins WHERE id = ?", [adminId]);
}

// ── Admin user management (/api/admin/users CRUD) ──
// Self-JOIN (admins to admins twice, aliased creator/modifier) — both sides of this JOIN belong to
// this domain, so unlike every cross-domain JOIN found in earlier phases, this moves in full.
function getAdminsListWithCreatorModifier(callback) {
    db.all(`SELECT
                a.id,
                a.username,
                a.email,
                a.full_name,
                a.phone,
                a.role,
                a.is_active,
                a.must_change_password,
                a.last_login_at,
                a.created_at,
                a.created_by,
                a.created_on,
                a.modified_by,
                a.modified_on,
                creator.email AS creator_email,
                creator.full_name AS creator_name,
                modifier.email AS modifier_email,
                modifier.full_name AS modifier_name
            FROM admins a
            LEFT JOIN admins creator ON a.created_by = creator.id
            LEFT JOIN admins modifier ON a.modified_by = modifier.id
            ORDER BY a.created_at DESC`, [], callback);
}
function insertAdminUser(username, email, passwordHash, role, fullName, phone, createdBy, callback) {
    db.run(
        "INSERT INTO admins (username, email, password_hash, role, full_name, phone, is_active, must_change_password, created_by, created_on) VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, CURRENT_TIMESTAMP)",
        [username, email, passwordHash, role, fullName, phone, createdBy], callback
    );
}
function getAdminForInvite(adminId, callback) {
    db.get("SELECT id, email, full_name, role FROM admins WHERE id = ?", [adminId], callback);
}
function getAdminForEditById(adminId, callback) {
    db.get("SELECT role, is_active, full_name, phone FROM admins WHERE id = ?", [adminId], callback);
}
function getAdminPasswordHashById(adminId, callback) {
    db.get("SELECT password_hash FROM admins WHERE id = ?", [adminId], callback);
}
// setPwdSql is the pre-built ", password_hash = ?, must_change_password = 0" suffix (or '' when no
// password change), and params is pre-built to match — same dynamic-clause pattern as
// getDateHoldsForDateConflict in the calendar domain. All the business logic that builds either one
// stays in server.js; this just runs the resulting statement.
function updateAdminUserFields(setPwdSql, params, callback) {
    db.run(
        `UPDATE admins SET username = ?, email = ?, full_name = ?, phone = ?, role = ?, is_active = ?, modified_by = ?, modified_on = CURRENT_TIMESTAMP${setPwdSql} WHERE id = ?`,
        params, callback
    );
}
function getAdminRoleActiveById(adminId, callback) {
    db.get("SELECT role, is_active FROM admins WHERE id = ?", [adminId], callback);
}
function deleteAdminUser(adminId, callback) {
    db.run("DELETE FROM admins WHERE id = ?", adminId, callback);
}

// ── Admins reached from other domains' routes (inquiries assignment/notes) ──
function getAssignableAdmins(callback) {
    db.all("SELECT id, full_name, username, role FROM admins WHERE is_active = 1 ORDER BY full_name, username", [], callback);
}
function checkAdminActiveById(adminId, callback) {
    db.get("SELECT id FROM admins WHERE id = ? AND is_active = 1", [adminId], callback);
}
function getAdminDisplayNameById(adminId, callback) {
    db.get("SELECT COALESCE(full_name, username) AS name FROM admins WHERE id = ?", [adminId], callback);
}

// ── First-run bootstrap ──
function countAllAdmins(callback) {
    db.get("SELECT COUNT(*) AS count FROM admins", callback);
}
function insertBootstrapAdmin(username, email, passwordHash, callback) {
    db.run("INSERT INTO admins (username, email, password_hash, must_change_password) VALUES (?, ?, ?, 1)", [username, email, passwordHash], callback);
}

// =====================================================================================
// admin_login_logs
// =====================================================================================

function insertAdminLoginLog(adminId, ipAddress, userAgent, callback) {
    db.run(
        `INSERT INTO admin_login_logs (admin_id, ip_address, user_agent) VALUES (?, ?, ?)`,
        [adminId, ipAddress, userAgent], callback
    );
}
// Logout route's finalizer — sets 3 columns (logout_at + last_activity_at + duration_seconds).
// Distinct from updateAdminLoginLogHeartbeat below, which sets only 2 — a genuinely different
// column set, not a whitespace difference, so kept as two functions.
function finalizeAdminLoginLogOnLogout(loginLogId, callback) {
    db.run(
        `UPDATE admin_login_logs
         SET logout_at = CURRENT_TIMESTAMP,
             last_activity_at = CURRENT_TIMESTAMP,
             duration_seconds = CAST((strftime('%s', 'now') - strftime('%s', login_at)) AS INTEGER)
         WHERE id = ?`,
        [loginLogId], callback
    );
}
function updateAdminLoginLogHeartbeat(loginLogId, callback) {
    db.run(
        `UPDATE admin_login_logs
         SET last_activity_at = CURRENT_TIMESTAMP,
             duration_seconds = CAST((strftime('%s', 'now') - strftime('%s', login_at)) AS INTEGER)
         WHERE id = ?`,
        [loginLogId], callback
    );
}
// Same-domain JOIN (admin_login_logs to admins) — both tables belong to this domain, moves in full.
function getAdminLoginLogsWithNames(callback) {
    db.all(`
        SELECT
            l.id,
            l.admin_id,
            l.login_at,
            l.logout_at,
            l.last_activity_at,
            l.duration_seconds,
            l.ip_address,
            l.user_agent,
            a.username,
            a.email,
            a.full_name
        FROM admin_login_logs l
        JOIN admins a ON l.admin_id = a.id
        ORDER BY l.login_at DESC
    `, [], callback);
}

// =====================================================================================
// password_reset_tokens
// =====================================================================================

// 2 byte-identical call sites: createAndSendInvite() (used for both new-user invites and
// resend-invite) and the forgot-password route's own token issuance. Both callback style.
function insertPasswordResetToken(adminId, tokenHash, expiresAt, callback) {
    db.run(
        "INSERT INTO password_reset_tokens (admin_id, token_hash, expires_at) VALUES (?, ?, ?)",
        [adminId, tokenHash, expiresAt], callback
    );
}
function getUnexpiredPasswordResetTokens(adminId, callback) {
    db.all(
        "SELECT id, token_hash FROM password_reset_tokens WHERE admin_id = ? AND expires_at > CURRENT_TIMESTAMP",
        [adminId], callback
    );
}
// Consumes a single used token by its own id (reset-password route, post-verification).
function deletePasswordResetTokenById(tokenId, callback) {
    db.run("DELETE FROM password_reset_tokens WHERE id = ?", [tokenId], callback);
}
// Invalidates ALL outstanding tokens for an admin (resend-invite route, before issuing a fresh
// one) — a different WHERE column from deletePasswordResetTokenById above, not consolidated.
function deletePasswordResetTokensForAdmin(adminId, callback) {
    db.run("DELETE FROM password_reset_tokens WHERE admin_id = ?", [adminId], callback);
}

module.exports = {
    // admins
    getAdminActiveStatus, getAdminByEmailFull, updateAdminLastLogin, getActiveAdministratorCountExcluding,
    updateAdminPassword,
    getAdminSessionProfileById, getAdminSessionProfileByUsername,
    getAdminIdAndUsernameByEmail, getAdminIdByEmail, getAdminNameRoleById, getAdminEmailById,
    getAdminsListWithCreatorModifier, insertAdminUser, getAdminForInvite, getAdminForEditById,
    getAdminPasswordHashById, updateAdminUserFields, getAdminRoleActiveById, deleteAdminUser,
    getAssignableAdmins, checkAdminActiveById, getAdminDisplayNameById,
    countAllAdmins, insertBootstrapAdmin,

    // admin_login_logs
    insertAdminLoginLog, finalizeAdminLoginLogOnLogout, updateAdminLoginLogHeartbeat,
    getAdminLoginLogsWithNames,

    // password_reset_tokens
    insertPasswordResetToken, getUnexpiredPasswordResetTokens,
    deletePasswordResetTokenById, deletePasswordResetTokensForAdmin,
};
