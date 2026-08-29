const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { requireAdmin } = require('../../middleware/auth');
const { requireRole } = require('../../middleware/rbac');
const {
    getAdminsListWithCreatorModifier, getAdminLoginLogsWithNames, insertAdminUser,
    getAdminForInvite, deletePasswordResetTokensForAdmin, getAdminForEditById,
    getAdminPasswordHashById, updateAdminUserFields, getAdminRoleActiveById, deleteAdminUser,
} = require('../../database/repositories/auth-users.repository');
const { VALID_ADMIN_ROLES, countOtherActiveAdministrators, createAndSendInvite } = require('../../lib/admin-users');
const { resolveActor } = require('../../lib/actor');
const { logAudit } = require('../../lib/audit-log');
const router = express.Router();

// --- Users (Admins) ---
router.get('/api/admin/users', requireAdmin, requireRole(['administrator']), (req, res) => {
    getAdminsListWithCreatorModifier((err, rows) => {
        if (err) { console.error('list users failed:', err); return res.status(500).json({ success: false, message: 'Could not load users. Please try again.' }); }
        res.json(rows);
    });
});

// GET Admin Login Activity Logs
router.get('/api/admin/user-login-logs', requireAdmin, requireRole(['administrator']), (req, res) => {
    getAdminLoginLogsWithNames((err, rows) => {
        if (err) {
            console.error('Failed to fetch login logs:', err);
            return res.status(500).json({ success: false, message: 'Could not fetch login activity logs.' });
        }
        res.json(rows);
    });
});

router.post('/api/admin/users', requireAdmin, requireRole(['administrator']), (req, res) => {
    const { email, full_name, phone, role } = req.body;
    if (!email) {
        return res.status(400).json({ success: false, message: 'Email is required.' });
    }
    if (!full_name || !String(full_name).trim()) {
        return res.status(400).json({ success: false, message: 'Full name is required.' });
    }
    if (!phone || !String(phone).trim()) {
        return res.status(400).json({ success: false, message: 'Phone number is required.' });
    }
    const normalizedEmail = String(email).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
        return res.status(400).json({ success: false, message: 'Enter a valid email address.' });
    }
    const targetRole = VALID_ADMIN_ROLES.includes(role) ? role : 'manager';
    const cleanName = (full_name || '').trim() || null;
    const cleanPhone = (phone || '').trim() || null;

    // No admin-set password: the new user sets their own via the invitation link.
    // Insert an unusable random password so the row is well-formed but nobody can sign in until they accept the invite.
    const placeholderPassword = crypto.randomBytes(24).toString('hex');
    bcrypt.hash(placeholderPassword, 10, (err, hash) => {
        if (err) return res.status(500).json({ success: false, message: 'Error preparing the account.' });

        insertAdminUser(
            normalizedEmail, normalizedEmail, hash, targetRole, cleanName, cleanPhone, req.session.adminId,
            function (err) {
                if (err) {
                    if (err.message.includes('UNIQUE')) {
                        return res.status(400).json({ success: false, message: 'An account with that email already exists.' });
                    }
                    console.error('create user failed:', err);
                    return res.status(500).json({ success: false, message: 'Could not create the user. Please try again.' });
                }
                const newId = this.lastID;
                logAudit({ tableName: 'admins', recordId: newId, action: 'create', req, oldValues: null, newValues: { email: normalizedEmail, full_name: cleanName, phone: cleanPhone, role: targetRole } }).catch(e => console.error('logAudit failed:', e));
                // Queue the invitation email so the user can set their password.
                createAndSendInvite({ id: newId, email: normalizedEmail, full_name: cleanName, role: targetRole }, 72, async function (mail) {
                    const emailSent = !!(mail && mail.success);
                    let message = 'User created and invitation sent.';
                    if (!emailSent) {
                        const reason = (mail && mail.error) ? mail.error : 'Unknown SMTP error';
                        message = 'User created, but the invitation email could not be sent: ' + reason + '. Use "Resend invite".';
                    }
                    const actor = await resolveActor(req.session.adminId);
                    res.json({
                        success: true,
                        id: newId,
                        email_sent: emailSent,
                        message: message,
                        last_updated: { name: actor.name, role: actor.role, at: new Date().toISOString() }
                    });
                });
            }
        );
    });
});

// Resend the set-password invitation to an existing (typically pending) user.
router.post('/api/admin/users/:id/resend-invite', requireAdmin, requireRole(['administrator']), (req, res) => {
    const userId = parseInt(req.params.id, 10);
    getAdminForInvite(userId, (err, user) => {
        if (err || !user) return res.status(404).json({ success: false, message: 'User not found.' });
        // Invalidate any outstanding tokens, then issue a fresh one.
        deletePasswordResetTokensForAdmin(userId, () => {
            createAndSendInvite(user, 72, function (mail) {
                const emailSent = !!(mail && mail.success);
                let message = 'Invitation re-sent to ' + user.email + '.';
                if (!emailSent) {
                    const reason = (mail && mail.error) ? mail.error : 'Unknown SMTP error';
                    message = 'Could not send the invitation email: ' + reason + '. Please try again.';
                }
                res.json({
                    success: true,
                    email_sent: emailSent,
                    message: message
                });
            });
        });
    });
});

router.put('/api/admin/users/:id', requireAdmin, requireRole(['administrator']), (req, res) => {
    const { email, password, currentPassword, full_name, phone, role, is_active } = req.body;
    const userId = parseInt(req.params.id, 10);
    const isEditingSelf = userId === req.session.adminId;

    if (!email) return res.status(400).json({ success: false, message: 'Email is required.' });
    const normalizedEmail = String(email).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
        return res.status(400).json({ success: false, message: 'Enter a valid email address.' });
    }

    getAdminForEditById(userId, (selErr, existing) => {
        if (selErr || !existing) return res.status(404).json({ success: false, message: 'User not found.' });
        const hasKey = (k) => Object.prototype.hasOwnProperty.call(req.body, k);

        // Full name + phone are mandatory when supplied by a form edit. Inline role/status
        // toggles and password-only updates omit these keys and must keep working.
        if (hasKey('full_name') && !String(full_name || '').trim()) {
            return res.status(400).json({ success: false, message: 'Full name is required.' });
        }
        if (hasKey('phone') && !String(phone || '').trim()) {
            return res.status(400).json({ success: false, message: 'Phone number is required.' });
        }

        // Default role/status to the existing values when not explicitly provided, so a bare
        // profile/password save never demotes or deactivates the account.
        const targetRole = VALID_ADMIN_ROLES.includes(role) ? role : existing.role;
        const targetIsActive = (is_active === undefined || is_active === null)
            ? existing.is_active
            : ((is_active === false || is_active === 0) ? 0 : 1);

        // Last-administrator guard: never let the system reach zero active administrators.
        const wasActiveAdmin = existing.role === 'administrator' && existing.is_active !== 0;
        const willStopBeingActiveAdmin = targetRole !== 'administrator' || targetIsActive === 0;

        if (wasActiveAdmin && willStopBeingActiveAdmin) {
            countOtherActiveAdministrators(userId, (cntErr, cntRow) => {
                const otherAdmins = cntErr ? 1 : cntRow.count;
                if (otherAdmins === 0) {
                    return res.status(403).json({ success: false, message: 'Cannot remove the last remaining administrator account.' });
                }
                applyUpdate();
            });
        } else {
            applyUpdate();
        }

        function applyUpdate() {
            const fields = {
                username: normalizedEmail,
                email: normalizedEmail,
                // Only overwrite full_name/phone when the client actually sent the key,
                // so a bare password change doesn't wipe them.
                full_name: hasKey('full_name') ? ((full_name || '').trim() || null) : existing.full_name,
                phone: hasKey('phone') ? ((phone || '').trim() || null) : existing.phone,
                role: targetRole,
                is_active: targetIsActive
            };

            if (password && password.trim() !== '') {
                if (isEditingSelf) {
                    if (!currentPassword) {
                        return res.status(400).json({ success: false, message: 'Current password is required to set a new password.' });
                    }
                    return getAdminPasswordHashById(userId, (err, row) => {
                        if (err || !row) return res.status(404).json({ success: false, message: 'User not found.' });
                        bcrypt.compare(currentPassword, row.password_hash, (err, isMatch) => {
                            if (err) return res.status(500).json({ success: false, message: 'Error verifying password.' });
                            if (!isMatch) return res.status(401).json({ success: false, message: 'Current password is incorrect.' });
                            hashAndSave(fields, password);
                        });
                    });
                }
                // Administrator resetting another user's password — no currentPassword needed.
                return hashAndSave(fields, password);
            }
            saveFields(fields, null);
        }

        function hashAndSave(fields, newPassword) {
            bcrypt.hash(newPassword, 10, (err, hash) => {
                if (err) return res.status(500).json({ success: false, message: 'Error hashing password' });
                saveFields(fields, hash);
            });
        }

        function saveFields(fields, passwordHash) {
            const setPwd = passwordHash ? ", password_hash = ?, must_change_password = 0" : "";
            const params = [fields.username, fields.email, fields.full_name, fields.phone, fields.role, fields.is_active, req.session.adminId];
            if (passwordHash) params.push(passwordHash);
            params.push(userId);

            updateAdminUserFields(
                setPwd,
                params,
                async function (err) {
                    if (err) {
                        if (err.message.includes('UNIQUE')) {
                            return res.status(400).json({ success: false, message: 'An account with that email already exists.' });
                        }
                        console.error('update user failed:', err);
                        return res.status(500).json({ success: false, message: 'Could not update the user. Please try again.' });
                    }
                    logAudit({ tableName: 'admins', recordId: userId, action: 'update', req, oldValues: existing, newValues: fields }).catch(e => console.error('logAudit failed:', e));
                    const actor = await resolveActor(req.session.adminId);
                    res.json({ success: true, message: 'User updated successfully.', last_updated: { name: actor.name, role: actor.role, at: new Date().toISOString() } });
                }
            );
        }
    });
});

router.delete('/api/admin/users/:id', requireAdmin, requireRole(['administrator']), (req, res) => {
    const targetUserId = parseInt(req.params.id, 10);
    const currentUserId = req.session.adminId; // prevent self-deletion

    if (targetUserId === currentUserId) {
         return res.status(403).json({ success: false, message: 'You cannot delete your own account while logged in.' });
    }

    getAdminRoleActiveById(targetUserId, (selErr, existing) => {
        if (selErr || !existing) return res.status(404).json({ success: false, message: 'User not found.' });
        const isActiveAdmin = existing.role === 'administrator' && existing.is_active !== 0;

        const proceed = () => {
            deleteAdminUser(targetUserId, function (err) {
                if (err) { console.error('delete user failed:', err); return res.status(500).json({ success: false, message: 'Could not delete the user. Please try again.' }); }
                logAudit({ tableName: 'admins', recordId: targetUserId, action: 'delete', req, oldValues: existing, newValues: null }).catch(e => console.error('logAudit failed:', e));
                res.json({ success: true, message: 'User deleted.' });
            });
        };

        if (!isActiveAdmin) return proceed();
        countOtherActiveAdministrators(targetUserId, (cntErr, cntRow) => {
            if (!cntErr && cntRow.count === 0) {
                return res.status(403).json({ success: false, message: 'Cannot delete the last remaining administrator account.' });
            }
            proceed();
        });
    });
});

module.exports = router;
