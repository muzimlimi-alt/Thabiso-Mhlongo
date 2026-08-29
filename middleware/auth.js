// Auth middleware — Phase 5 of the housekeeping effort (HOUSEKEEPING-NOTES.md). Moved out of the
// server.js monolith byte-identical; the check function's body is untouched character-for-character.
//
// requireAdmin was originally `const requireAdmin = [adminRateLimiter, checkFn]` — an array pairing
// a rate limiter (defined alongside every other rate limiter in app.js, not named as an extraction
// target by the plan) with this session-check function. createRequireAdmin(adminRateLimiter)
// reconstructs that exact same array from app.js, so requireAdmin is still literally
// [adminRateLimiter, checkFn] at runtime — only the check function's definition moved.
const { getAdminActiveStatus } = require('../database/repositories/auth-users.repository');

function createRequireAdmin(adminRateLimiter) {
    return [
        adminRateLimiter,
        (req, res, next) => {
            if (req.session && req.session.adminId) {
                if (req.session.must_change_password) {
                    const allowedRoutes = ['/force-change-password', '/logout', '/session'];
                    const isAllowed = allowedRoutes.some(route => req.path.endsWith(route));
                    if (!isAllowed) {
                        return res.status(403).json({ success: false, message: 'Password change required.', must_change_password: true });
                    }
                }
                // Re-check suspension on every request so a suspension takes effect immediately,
                // not just on the next login. One extra indexed lookup per admin request (accepted cost).
                getAdminActiveStatus(req.session.adminId, (err, row) => {
                    if (err) return res.status(500).json({ success: false, message: 'Database error.' });
                    if (!row || row.is_active === 0) {
                        return req.session.destroy(() => {
                            res.status(403).json({ success: false, message: 'This account has been suspended. Contact an administrator.' });
                        });
                    }
                    return next();
                });
                return;
            }
            return res.status(401).json({ success: false, message: 'Unauthorized. Please log in.' });
        }
    ];
}

module.exports = { createRequireAdmin };
