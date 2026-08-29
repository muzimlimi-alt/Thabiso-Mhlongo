// Shared helpers for the /api/admin/users routes — Phase 5 of the housekeeping effort
// (HOUSEKEEPING-NOTES.md). Moved out of the app.js monolith byte-identical.
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const emailComponents = require('../js/emailComponents');
const { sendEmail } = require('../js/emailService');
const { insertPasswordResetToken, getActiveAdministratorCountExcluding } = require('../database/repositories/auth-users.repository');

// Admin role constants + last-administrator guard helper (shared by /api/admin/users CRUD)
const VALID_ADMIN_ROLES = ['administrator', 'manager', 'assistant'];

function countOtherActiveAdministrators(excludeUserId, callback) {
    getActiveAdministratorCountExcluding(excludeUserId, callback);
}

// Generate a set-password token and queue a branded invitation email for a new/pending admin user.
// Reuses the password_reset_tokens table + sendEmail pipeline. callback receives the sendEmail result.
function createAndSendInvite(user, expiresHours, callback) {
    callback = callback || function () {};
    const rawToken = crypto.randomBytes(32).toString('hex');
    bcrypt.hash(rawToken, 10, (err, hash) => {
        if (err) { console.error('Invite token hash error:', err); return callback({ success: false, error: err.message }); }
        const expiresAt = new Date(Date.now() + (expiresHours || 72) * 3600000).toISOString();
        insertPasswordResetToken(
            user.id, hash, expiresAt,
            function (insertErr) {
                if (insertErr) { console.error('Invite token store error:', insertErr); return callback({ success: false, error: insertErr.message }); }

                const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
                const inviteLink = `${baseUrl}/reset-password.html?token=${rawToken}&email=${encodeURIComponent(user.email)}&welcome=1`;
                const roleLabel = (user.role || 'manager').charAt(0).toUpperCase() + (user.role || 'manager').slice(1);
                const greetName = (user.full_name && String(user.full_name).trim()) ? user.full_name : 'there';

                // SECURITY-CRITICAL (HIGH): inviteLink, expiry hours and user.email kept verbatim.
                // The old class="btn-luxe"/class="text-muted" only resolve via the legacy wrapper's
                // <style> block, absent on the live raw path — the button/muted text render unstyled
                // today. Uses the bulletproof ctaButton component directly (works in Outlook too).
                const emailBody = emailComponents.renderSystemEmail({
                    preheaderText: `You've been added as a ${roleLabel} to the Thabiso Mhlongo dashboard.`,
                    category: 'User Accounts & Security',
                    severity: 'action',
                    leadFact: `Hello <strong style="color:#FAFAFA;">${greetName}</strong> — you've been added as a <strong style="color:#FAFAFA;">${roleLabel}</strong> to the Thabiso Mhlongo management dashboard.`,
                    bodyHtml:
                        `<p style="margin:0 0 18px; color:#E6E6E6;">To activate your account, set your password using the secure link below. This link will safely expire in ${expiresHours || 72} hours.</p>` +
                        emailComponents.ctaButton({ label: 'Set Your Password', url: inviteLink }) +
                        `<p style="margin:18px 0 0; color:#E6E6E6;">Your sign-in email is <strong style="color:#FAFAFA;">${user.email}</strong>.</p>` +
                        `<p style="margin:10px 0 0; color:#B0B0B0; font-size:12px;">If you weren't expecting this invitation, you can safely ignore this automated message.</p>`
                });

                sendEmail({
                    to: user.email,
                    subject: "You're invited to the Thabiso Mhlongo Management Dashboard",
                    htmlContent: emailBody,
                    preWrapped: true,
                    titleOverride: 'Management Dashboard',
                    trigger_event: 'Admin: User Invitation'
                }).then(result => {
                    if (!result.success) console.error('Email Service Error sending invite email:', result.error);
                    callback(result);
                }).catch(e => { console.error('Panic in sendEmail (Invite):', e); callback({ success: false, error: String(e) }); });
            }
        );
    });
}

module.exports = { VALID_ADMIN_ROLES, countOtherActiveAdministrators, createAndSendInvite };
