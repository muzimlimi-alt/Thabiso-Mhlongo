// Dynamic RBAC management API — Phase 3.
// Roles CRUD, permission matrix read/write, per-role grant management.
// All routes require roles.manage (administrator-only in the seed).
const express = require('express');
const db = require('../../database');
const { requireAdmin } = require('../../middleware/auth');
const { requirePermission } = require('../../middleware/rbac');
const { logAudit } = require('../../lib/audit-log');
const { getEffectivePermissions, invalidatePermissionsCache } = require('../../lib/rbac-engine');
const { MODULES } = require('../../lib/rbac-registry');
const router = express.Router();

const GUARD = [requireAdmin, requirePermission('roles.manage')];

// ── Roles ────────────────────────────────────────────────────────────────────

// List all roles with active-user count, permission count, and last-modified.
router.get('/api/admin/roles', ...GUARD, (req, res) => {
    db.all(
        `SELECT r.id, r.key, r.name, r.description, r.base_role,
                r.is_system, r.is_protected, r.status, r.created_at, r.modified_at,
                (SELECT COUNT(*) FROM admins a WHERE a.role = r.key AND a.is_active = 1) AS active_user_count,
                (SELECT COUNT(*) FROM rbac_role_permissions rp WHERE rp.role_id = r.id) AS permission_count
         FROM rbac_roles r ORDER BY r.is_system DESC, r.name ASC`,
        [],
        (err, rows) => {
            if (err) { console.error('[roles] list failed:', err); return res.status(500).json({ success: false, message: 'Could not load roles.' }); }
            res.json({ success: true, roles: rows || [] });
        }
    );
});

// Get one role with its full permission list.
router.get('/api/admin/roles/:id', ...GUARD, (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ success: false, message: 'Invalid role ID.' });
    db.get('SELECT * FROM rbac_roles WHERE id = ?', [id], (err, role) => {
        if (err || !role) return res.status(404).json({ success: false, message: 'Role not found.' });
        db.all(
            `SELECT p.key, p.module, p.action, p.label, p.is_sensitive
             FROM rbac_role_permissions rp
             JOIN rbac_permissions p ON p.id = rp.permission_id
             WHERE rp.role_id = ? ORDER BY p.module, p.action`,
            [id],
            (err2, perms) => {
                if (err2) return res.status(500).json({ success: false, message: 'Could not load permissions.' });
                res.json({ success: true, role, permissions: perms || [] });
            }
        );
    });
});

// Create a custom role, seeded by cloning a base role's current permission set.
router.post('/api/admin/roles', ...GUARD, (req, res) => {
    const { key, name, description, base_role } = req.body;
    if (!key || !name || !base_role) return res.status(400).json({ success: false, message: 'key, name and base_role are required.' });
    if (!/^[a-z0-9_-]+$/.test(key)) return res.status(400).json({ success: false, message: 'key must be lowercase letters, digits, hyphens and underscores only.' });
    if (!['administrator', 'manager', 'assistant'].includes(base_role)) return res.status(400).json({ success: false, message: 'base_role must be administrator, manager or assistant.' });

    const now = new Date().toISOString();
    db.run(
        `INSERT INTO rbac_roles (key, name, description, base_role, is_system, is_protected, status, created_at, created_by)
         VALUES (?, ?, ?, ?, 0, 0, 'active', ?, ?)`,
        [key, name.trim(), description || null, base_role, now, req.session.adminId],
        function(err) {
            if (err) {
                if (err.message && err.message.includes('UNIQUE')) return res.status(409).json({ success: false, message: `A role with key '${key}' already exists.` });
                console.error('[roles] create failed:', err);
                return res.status(500).json({ success: false, message: 'Could not create role.' });
            }
            const newRoleId = this.lastID;
            // Clone the base role's current permission set so the new role works from day one
            db.run(
                `INSERT INTO rbac_role_permissions (role_id, permission_id)
                 SELECT ?, rp.permission_id FROM rbac_role_permissions rp
                 JOIN rbac_roles r ON r.id = rp.role_id WHERE r.key = ?`,
                [newRoleId, base_role],
                (cloneErr) => {
                    if (cloneErr) console.error('[roles] clone perms failed:', cloneErr);
                    logAudit({
                        tableName: 'rbac_roles', recordId: newRoleId, action: 'create', req,
                        newValues: { key, name, description, base_role },
                        reason: `Custom role created by ${req.session.username}`,
                    }).catch(e => console.error('logAudit failed:', e));
                    res.status(201).json({ success: true, message: 'Role created.', id: newRoleId });
                }
            );
        }
    );
});

// Update a role's name, description, or status (not key — keys are permanent identifiers).
router.put('/api/admin/roles/:id', ...GUARD, (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ success: false, message: 'Invalid role ID.' });
    db.get('SELECT * FROM rbac_roles WHERE id = ?', [id], (err, role) => {
        if (err || !role) return res.status(404).json({ success: false, message: 'Role not found.' });
        const newName = (req.body.name != null) ? String(req.body.name).trim() : role.name;
        const newDesc = (req.body.description != null) ? req.body.description : role.description;
        const newStatus = (['active', 'inactive'].includes(req.body.status)) ? req.body.status : role.status;

        const doUpdate = () => {
            const now = new Date().toISOString();
            db.run(
                'UPDATE rbac_roles SET name=?, description=?, status=?, modified_at=?, modified_by=? WHERE id=?',
                [newName, newDesc, newStatus, now, req.session.adminId, id],
                (upErr) => {
                    if (upErr) { console.error('[roles] update failed:', upErr); return res.status(500).json({ success: false, message: 'Could not update role.' }); }
                    logAudit({
                        tableName: 'rbac_roles', recordId: id, action: 'update', req,
                        oldValues: { name: role.name, description: role.description, status: role.status },
                        newValues: { name: newName, description: newDesc, status: newStatus },
                    }).catch(e => console.error('logAudit failed:', e));
                    res.json({ success: true, message: 'Role updated.' });
                }
            );
        };

        // Deactivating a role with live users is blocked (must reassign first)
        if (newStatus === 'inactive' && role.status === 'active') {
            db.get('SELECT COUNT(*) AS cnt FROM admins WHERE role = ? AND is_active = 1', [role.key], (cntErr, cntRow) => {
                if (!cntErr && cntRow && cntRow.cnt > 0) {
                    return res.status(409).json({ success: false, message: `Cannot deactivate: ${cntRow.cnt} active user(s) still assigned this role. Reassign them first.` });
                }
                doUpdate();
            });
        } else {
            doUpdate();
        }
    });
});

// Delete a custom role. Blocked when: system/protected, or any user (active or not) is assigned it.
router.delete('/api/admin/roles/:id', ...GUARD, (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ success: false, message: 'Invalid role ID.' });
    db.get('SELECT * FROM rbac_roles WHERE id = ?', [id], (err, role) => {
        if (err || !role) return res.status(404).json({ success: false, message: 'Role not found.' });
        if (role.is_system || role.is_protected) return res.status(403).json({ success: false, message: 'System and protected roles cannot be deleted.' });
        db.get('SELECT COUNT(*) AS cnt FROM admins WHERE role = ?', [role.key], (cntErr, cntRow) => {
            if (!cntErr && cntRow && cntRow.cnt > 0) {
                return res.status(409).json({ success: false, message: `Reassign ${cntRow.cnt} user(s) before deleting this role.` });
            }
            db.run('DELETE FROM rbac_roles WHERE id = ?', [id], (delErr) => {
                if (delErr) { console.error('[roles] delete failed:', delErr); return res.status(500).json({ success: false, message: 'Could not delete role.' }); }
                logAudit({ tableName: 'rbac_roles', recordId: id, action: 'delete', req, oldValues: role }).catch(e => console.error('logAudit failed:', e));
                res.json({ success: true, message: 'Role deleted.' });
            });
        });
    });
});

// ── Permission matrix ─────────────────────────────────────────────────────────

// All permission metadata + current role→permission matrix, structured for the matrix UI.
router.get('/api/admin/permissions', ...GUARD, (req, res) => {
    db.all('SELECT * FROM rbac_roles ORDER BY is_system DESC, name ASC', [], (err, roles) => {
        if (err) return res.status(500).json({ success: false, message: 'Could not load roles.' });
        db.all(
            `SELECT rp.role_id, p.key FROM rbac_role_permissions rp
             JOIN rbac_permissions p ON p.id = rp.permission_id`,
            [],
            (err2, grants) => {
                if (err2) return res.status(500).json({ success: false, message: 'Could not load grants.' });
                db.all('SELECT * FROM rbac_permissions ORDER BY module, action', [], (err3, perms) => {
                    if (err3) return res.status(500).json({ success: false, message: 'Could not load permissions.' });
                    const matrix = {};
                    for (const g of (grants || [])) {
                        if (!matrix[g.role_id]) matrix[g.role_id] = [];
                        matrix[g.role_id].push(g.key);
                    }
                    res.json({
                        success: true,
                        permissions: perms || [],
                        roles: (roles || []).map(r => ({ ...r, grants: matrix[r.id] || [] })),
                        modules: Object.entries(MODULES).map(([k, def]) => ({ key: k, label: def.label, actions: def.actions })),
                    });
                });
            }
        );
    });
});

// Update a role's full permission set. Accepts the desired complete list of permission keys.
// Computes add/remove diff, enforces privilege-escalation guard, audits changes, invalidates cache.
router.put('/api/admin/roles/:id/permissions', ...GUARD, (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ success: false, message: 'Invalid role ID.' });
    if (!Array.isArray(req.body.permissions)) return res.status(400).json({ success: false, message: 'permissions must be an array.' });
    const desiredKeys = req.body.permissions;

    db.get('SELECT * FROM rbac_roles WHERE id = ?', [id], (err, role) => {
        if (err || !role) return res.status(404).json({ success: false, message: 'Role not found.' });

        // Protected administrator role: may never lose roles.manage
        if (role.is_protected && !desiredKeys.includes('roles.manage')) {
            return res.status(403).json({ success: false, message: "Cannot remove 'roles.manage' from the protected administrator role." });
        }

        const actorRoleKey = req.session.role || 'assistant';
        getEffectivePermissions(req.session.adminId, actorRoleKey).then(actorPerms => {
            // Privilege escalation: actor cannot grant what they don't hold (skip for administrator)
            if (actorRoleKey !== 'administrator') {
                const escalated = desiredKeys.filter(k => !actorPerms.has(k));
                if (escalated.length) {
                    return res.status(403).json({ success: false, message: `Cannot grant permissions you do not hold: ${escalated.slice(0, 3).join(', ')}${escalated.length > 3 ? '…' : ''}` });
                }
            }

            // Load the current grant set for this role
            db.all(
                `SELECT p.key FROM rbac_role_permissions rp
                 JOIN rbac_permissions p ON p.id = rp.permission_id WHERE rp.role_id = ?`,
                [id],
                (curErr, curRows) => {
                    if (curErr) return res.status(500).json({ success: false, message: 'Could not load current permissions.' });
                    const current = new Set((curRows || []).map(r => r.key));
                    const desired = new Set(desiredKeys);
                    const toGrant = [...desired].filter(k => !current.has(k));
                    const toRevoke = [...current].filter(k => !desired.has(k));

                    if (toGrant.length === 0 && toRevoke.length === 0) {
                        return res.json({ success: true, message: 'No changes.', diff: { granted: [], revoked: [] } });
                    }

                    // Apply grant/revoke operations, track completion count for the final response
                    const total = toGrant.length + toRevoke.length;
                    let done = 0;
                    const onDone = (opErr) => {
                        if (opErr) console.error('[roles] permission op failed:', opErr);
                        done++;
                        if (done < total) return;
                        // All ops complete — invalidate cache for affected users and audit
                        db.all('SELECT id FROM admins WHERE role = ?', [role.key], (uErr, users) => {
                            if (!uErr && users) users.forEach(u => invalidatePermissionsCache(u.id));
                        });
                        logAudit({
                            tableName: 'rbac_role_permissions', recordId: id, action: 'update', req,
                            oldValues: { granted: [...current] },
                            newValues: { granted: [...desired], added: toGrant, removed: toRevoke },
                            reason: `Permission matrix updated for role '${role.key}' by ${req.session.username}`,
                        }).catch(e => console.error('logAudit failed:', e));
                        res.json({ success: true, message: `+${toGrant.length} granted, −${toRevoke.length} revoked.`, diff: { granted: toGrant, revoked: toRevoke } });
                    };

                    for (const key of toGrant) {
                        db.run(
                            `INSERT OR IGNORE INTO rbac_role_permissions (role_id, permission_id)
                             SELECT ?, id FROM rbac_permissions WHERE key = ?`,
                            [id, key], onDone
                        );
                    }
                    for (const key of toRevoke) {
                        db.run(
                            `DELETE FROM rbac_role_permissions WHERE role_id = ? AND permission_id = (SELECT id FROM rbac_permissions WHERE key = ?)`,
                            [id, key], onDone
                        );
                    }
                }
            );
        }).catch(engErr => {
            console.error('[roles] escalation check failed:', engErr);
            res.status(500).json({ success: false, message: 'Could not verify permissions.' });
        });
    });
});

module.exports = router;
