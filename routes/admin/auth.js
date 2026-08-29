const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const emailComponents = require('../../js/emailComponents');
const { sendEmail } = require('../../js/emailService');
const { requireAdmin } = require('../../middleware/auth');
const { adminLoginRateLimiter } = require('../../middleware/rate-limiters');
const {
    getAdminByEmailFull, updateAdminLastLogin, insertAdminLoginLog, updateAdminPassword,
    finalizeAdminLoginLogOnLogout, getAdminSessionProfileById, getAdminSessionProfileByUsername,
    getAdminIdAndUsernameByEmail, insertPasswordResetToken, getAdminIdByEmail,
    getUnexpiredPasswordResetTokens, deletePasswordResetTokenById, updateAdminLoginLogHeartbeat,
} = require('../../database/repositories/auth-users.repository');
const router = express.Router();

// Admin Login Route — P3-13: protected by tight brute-force rate limiter (5 attempts / 10 min)
router.post('/api/admin/login', adminLoginRateLimiter, (req, res) => {
    const { email, password, remember_me } = req.body;

    if (!email || !password) {
        return res.status(400).json({ success: false, message: 'Email and password are required.' });
    }
    const normalizedEmail = String(email).trim().toLowerCase();

    getAdminByEmailFull(normalizedEmail, (err, row) => {
        if (err) return res.status(500).json({ success: false, message: 'Database error' });
        if (!row) return res.status(401).json({ success: false, message: 'Invalid credentials' });

        bcrypt.compare(password, row.password_hash, (err, isMatch) => {
            if (err) return res.status(500).json({ success: false, message: 'Error checking password' });
            if (isMatch) {
                if (row.is_active === 0) {
                    return res.status(403).json({ success: false, message: 'This account has been suspended. Contact an administrator.' });
                }
                req.session.adminId = row.id;
                req.session.username = row.username;
                req.session.role = row.role || 'manager';
                req.session.must_change_password = row.must_change_password ? true : false;
                // Remember me: 30-day persistent cookie; otherwise session-only (expires on browser close)
                req.session.cookie.maxAge = remember_me ? 1000 * 60 * 60 * 24 * 30 : null;
                
                updateAdminLastLogin(row.id, () => {});

                const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
                const ua = req.headers['user-agent'] || '';

                insertAdminLoginLog(
                    row.id, ip, ua,
                    function(insertErr) {
                        if (!insertErr) {
                            req.session.loginLogId = this.lastID;
                        }
                        req.session.save((saveErr) => {
                            if (saveErr) console.error('Error saving session after login:', saveErr);
                            return res.json({ success: true, message: 'Login successful', role: row.role || 'manager', must_change_password: row.must_change_password ? true : false });
                        });
                    }
                );
            } else {
                return res.status(401).json({ success: false, message: 'Invalid credentials' });
            }
        });
    });
});

// Force Password Change Route
router.post('/api/admin/force-change-password', requireAdmin, (req, res) => {
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 8) {
        return res.status(400).json({ success: false, message: 'Password must be at least 8 characters long.' });
    }
    bcrypt.hash(newPassword, 10, (err, hash) => {
        if (err) return res.status(500).json({ success: false, message: 'Server error hashing password.' });
        updateAdminPassword(hash, req.session.adminId, (updateErr) => {
            if (updateErr) return res.status(500).json({ success: false, message: 'Failed to update password.' });
            req.session.must_change_password = false;
            return res.json({ success: true, message: 'Password successfully updated. Access restored.' });
        });
    });
});

// Admin Logout Route
router.post('/api/admin/logout', (req, res) => {
    const loginLogId = req.session ? req.session.loginLogId : null;
    const finalizeLogout = () => {
        req.session.destroy((err) => {
            if (err) {
                return res.status(500).json({ success: false, message: 'Error during logout' });
            }
            res.clearCookie('connect.sid'); // default cookie name
            return res.json({ success: true, message: 'Logged out successfully' });
        });
    };

    if (loginLogId) {
        finalizeAdminLoginLogOnLogout(
            loginLogId,
            (err) => {
                if (err) console.error('Error finalising login log on logout:', err.message);
                finalizeLogout();
            }
        );
    } else {
        finalizeLogout();
    }
});

// Admin session check
router.get('/api/admin/session', (req, res) => {
    if (req.session && req.session.adminId) {
        // Try ID first
        getAdminSessionProfileById(req.session.adminId, (err, row) => {
            if (!err && row) {
                req.session.role = row.role || 'manager'; // sync in session
                return res.json({ success: true, id: row.id, username: row.username, email: row.email || '', full_name: row.full_name || '', phone: row.phone || '', role: row.role || 'manager', is_active: row.is_active, last_login_at: row.last_login_at, created_at: row.created_at });
            }
            // Fallback to username if ID failed but username exists in session
            if (req.session.username) {
                getAdminSessionProfileByUsername(req.session.username, (err2, row2) => {
                    if (!err2 && row2) {
                        // Refresh session ID while we're at it
                        req.session.adminId = row2.id;
                        req.session.role = row2.role || 'manager';
                        return res.json({ success: true, id: row2.id, username: row2.username, email: row2.email || '', full_name: row2.full_name || '', phone: row2.phone || '', role: row2.role || 'manager', is_active: row2.is_active, last_login_at: row2.last_login_at, created_at: row2.created_at });
                    }
                    return res.json({ success: true, id: req.session.adminId, username: req.session.username || '', role: req.session.role || 'manager' });
                });
            } else {
                return res.json({ success: true, id: req.session.adminId, username: req.session.username || '', role: req.session.role || 'manager' });
            }
        });
    } else {
        return res.status(401).json({ success: false, message: 'Not logged in.' });
    }
});

// Admin Forgot Password
router.post('/api/admin/forgot-password', (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, message: "Email is required." });

    // 1. Check if the email exists in the admins table
    getAdminIdAndUsernameByEmail(email, (err, admin) => {
        if (err) {
            console.error("Database error looking up admin email:", err);
            // Generic message for security
            return res.json({ success: true, message: "If your email is registered, you will receive a reset link shortly." });
        }

        if (!admin) {
            // Do not leak email existence.
            return res.json({ success: true, message: "If your email is registered, you will receive a reset link shortly." });
        }

        // 2. Generate secure token
        const rawToken = crypto.randomBytes(32).toString('hex');
        
        // 3. Hash the token for database storage
        bcrypt.hash(rawToken, 10, (err, hash) => {
            if (err) {
                console.error("Error hashing reset token:", err);
                return res.status(500).json({ success: false, message: "Internal server error." });
            }

            // 4. Store the hash in password_reset_tokens table (expires in 1 hour)
            const expiresAt = new Date(Date.now() + 3600000).toISOString(); // 1 hour from now

            insertPasswordResetToken(
                admin.id, hash, expiresAt,
                function(insertErr) {
                    if (insertErr) {
                        console.error("Error storing reset token:", insertErr);
                        return res.status(500).json({ success: false, message: "Internal server error." });
                    }

                    // 5. Build and send the premium email with the RAW token
                    const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
                    const resetLink = `${baseUrl}/reset-password.html?token=${rawToken}&email=${encodeURIComponent(email)}`;
                    
                    // SECURITY-CRITICAL (HIGH): resetLink and the 1-hour expiry wording kept verbatim.
                    // Same dead class="btn-luxe"/class="text-muted" defect as the invite email.
                    const emailBody = emailComponents.renderSystemEmail({
                        preheaderText: 'A password reset was requested for your dashboard account.',
                        category: 'User Accounts & Security',
                        severity: 'action',
                        leadFact: `Hello <strong style="color:#FAFAFA;">${admin.username}</strong> — we received a request to reset the administrative password associated with this email address.`,
                        bodyHtml:
                            `<p style="margin:0 0 18px; color:#E6E6E6;">You can reset your password by clicking the secure link below. This link will safely expire in 1 hour.</p>` +
                            emailComponents.ctaButton({ label: 'Reset Password', url: resetLink }) +
                            `<p style="margin:18px 0 0; color:#B0B0B0; font-size:12px;">If you did not request a password reset, you can safely ignore this automated message.</p>`
                    });

                    sendEmail({
                        to: email,
                        subject: 'Password Reset Request - Thabiso Mhlongo Dashboard',
                        htmlContent: emailBody,
                        preWrapped: true,
                        titleOverride: 'Management Dashboard',
                        trigger_event: 'Admin: Password Reset Request'
                    }).then(result => {
                        if (!result.success) console.error('Email Service Error sending reset email:', result.error);
                    }).catch(e => console.error('Panic in sendEmail (Reset):', e));

                    // Generic success to prevent user enumeration
                    return res.json({ success: true, message: "If your email is registered, you will receive a reset link shortly." });
                }
            );
        });
    });
});

// Admin Verify and Reset Password 
router.post('/api/admin/reset-password', (req, res) => {
    const { email, token, newPassword } = req.body;

    if (!email || !token || !newPassword) {
        return res.status(400).json({ success: false, message: "Missing required fields." });
    }

    if (newPassword.length < 8) {
        return res.status(400).json({ success: false, message: "Password must be at least 8 characters long." });
    }

    // 1. Lookup the admin to get their ID
    getAdminIdByEmail(email, (err, admin) => {
        if (err || !admin) {
            return res.status(400).json({ success: false, message: "Invalid request sequence." });
        }

        // 2. Lookup unexpired tokens for this admin
        getUnexpiredPasswordResetTokens(
            admin.id,
            (err, tokens) => {
                if (err) return res.status(500).json({ success: false, message: "Database error." });
                if (!tokens || tokens.length === 0) {
                    return res.status(400).json({ success: false, message: "Invalid or expired reset token." });
                }

                // 3. Verify the token using bcrypt.compare against active rows
                let validTokenRow = null;
                let checksPending = tokens.length;
                let responseSent = false;

                tokens.forEach(row => {
                    bcrypt.compare(token, row.token_hash, (err, isMatch) => {
                        if (responseSent) return;

                        if (err) {
                            console.error("Bcrypt compare error:", err);
                        } else if (isMatch) {
                            validTokenRow = row;
                        }

                        checksPending--;
                        if (checksPending === 0) {
                            if (!validTokenRow) {
                                responseSent = true;
                                return res.status(400).json({ success: false, message: "Invalid or expired reset token." });
                            }

                            // 4. Token Valid! Hash new password and update admins table
                            bcrypt.hash(newPassword, 10, (err, newHash) => {
                                if (err) {
                                    responseSent = true;
                                    return res.status(500).json({ success: false, message: "Error securely hashing new password." });
                                }

                                updateAdminPassword(
                                    newHash, admin.id,
                                    function(updateErr) {
                                        if (updateErr) {
                                            responseSent = true;
                                            return res.status(500).json({ success: false, message: "Error updating password." });
                                        }

                                        // 5. Consume/Delete the used token
                                        deletePasswordResetTokenById(validTokenRow.id, () => {
                                            responseSent = true;
                                            return res.json({ success: true, message: "Password has been reset successfully." });
                                        });
                                    }
                                );
                            });
                        }
                    });
                });
            }
        );
    });
});

// Admin Session Heartbeat Route
router.post('/api/admin/session/heartbeat', requireAdmin, (req, res) => {
    const loginLogId = req.session.loginLogId;
    if (!loginLogId) {
        return res.json({ success: true, message: 'No active login log ID' });
    }
    updateAdminLoginLogHeartbeat(
        loginLogId,
        (err) => {
            if (err) {
                console.error('[heartbeat] Failed to update login log:', err.message);
                return res.status(500).json({ success: false });
            }
            res.json({ success: true });
        }
    );
});

module.exports = router;
