// Runtime RBAC engine — Phase 2.
// Resolves effective permissions for a user: role grants ∪ user-allow overrides − user-deny overrides.
// Precedence: protected restriction (administrator = all) → user deny → user grant → role allow → default deny.
//
// Results are cached in-process (30s TTL per admin) and explicitly invalidated on any RBAC write
// so there is no stale access window longer than 30 seconds even under rapid concurrent changes.

const db = require('../database');

const SYSTEM_ROLES = new Set(['administrator', 'manager', 'assistant']);
const CACHE_TTL_MS = 30 * 1000;
const _cache = new Map(); // adminId → { perms: Set<string>, expires: number }

// Invalidate the cache for a specific admin (or all admins when adminId is omitted).
// Called by any route that writes to rbac_role_permissions or rbac_user_overrides.
function invalidatePermissionsCache(adminId) {
    if (adminId != null) _cache.delete(Number(adminId));
    else _cache.clear();
}

// Resolve the system base_role for any role key (synchronous for the 3 system roles, one DB
// lookup for custom roles). Falls back to 'assistant' (least-privilege) on error or missing row.
function resolveBaseRole(roleKey, callback) {
    if (SYSTEM_ROLES.has(roleKey)) return callback(roleKey);
    db.get('SELECT base_role FROM rbac_roles WHERE key = ?', [roleKey], (err, row) => {
        callback((row && row.base_role) ? row.base_role : 'assistant');
    });
}

// Return a Promise<Set<string>> of every permission key the admin currently holds.
// administrator always gets the full set (never locked out).
// All other roles: role grants ∪ user-allow − user-deny.
function getEffectivePermissions(adminId, roleKey) {
    const cached = _cache.get(adminId);
    if (cached && cached.expires > Date.now()) return Promise.resolve(cached.perms);

    // Administrator short-circuit — build from registry (no DB round-trip needed for the matrix)
    if (roleKey === 'administrator') {
        const { allPermissionKeys } = require('./rbac-registry');
        const perms = new Set(allPermissionKeys());
        _cache.set(adminId, { perms, expires: Date.now() + CACHE_TTL_MS });
        return Promise.resolve(perms);
    }

    return new Promise((resolve, reject) => {
        // Load role-level grants (handles custom roles: their own rbac_role_permissions rows)
        db.all(
            `SELECT p.key
             FROM rbac_role_permissions rp
             JOIN rbac_roles r ON r.id = rp.role_id
             JOIN rbac_permissions p ON p.id = rp.permission_id
             WHERE r.key = ?`,
            [roleKey],
            (err, rolePerms) => {
                if (err) return reject(err);

                // Load per-user allow/deny overrides
                db.all(
                    `SELECT p.key, uo.effect
                     FROM rbac_user_overrides uo
                     JOIN rbac_permissions p ON p.id = uo.permission_id
                     WHERE uo.admin_id = ?`,
                    [adminId],
                    (err2, overrides) => {
                        if (err2) return reject(err2);

                        const perms = new Set((rolePerms || []).map(r => r.key));
                        for (const ov of (overrides || [])) {
                            if (ov.effect === 'allow') perms.add(ov.key);
                            else if (ov.effect === 'deny') perms.delete(ov.key);
                        }

                        _cache.set(adminId, { perms, expires: Date.now() + CACHE_TTL_MS });
                        resolve(perms);
                    }
                );
            }
        );
    });
}

// Express middleware: check a named permission key.
// 403 on deny, mirroring requireRole's response shape.
// Always passes for administrator (never-lockout safeguard).
function requirePermission(key) {
    return (req, res, next) => {
        const adminId = req.session && req.session.adminId;
        const roleKey = (req.session && req.session.role) || 'assistant';

        if (!adminId) {
            return res.status(401).json({ success: false, message: 'Unauthorized. Please log in.' });
        }
        // Administrator can never be blocked by a permission check
        if (roleKey === 'administrator') return next();

        getEffectivePermissions(adminId, roleKey)
            .then(perms => {
                if (perms.has(key)) return next();
                return res.status(403).json({ success: false, message: 'Forbidden: Insufficient permissions.' });
            })
            .catch(err => {
                // Fail closed on engine error; never silently permit
                console.error('[rbac-engine] Permission check error:', err.message);
                return res.status(403).json({ success: false, message: 'Forbidden: Permission check failed.' });
            });
    };
}

module.exports = { resolveBaseRole, getEffectivePermissions, invalidatePermissionsCache, requirePermission };
