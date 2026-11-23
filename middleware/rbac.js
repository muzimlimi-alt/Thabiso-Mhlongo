// RBAC middleware — Phase 5 of the housekeeping effort (HOUSEKEEPING-NOTES.md). Moved out of the
// server.js monolith byte-identical.
// Phase 2 upgrade: requireRole now also accepts session.baseRole so custom roles (which store
// their own key but inherit a system-role tier) pass all 132 legacy requireRole call sites
// without any change to those sites. requirePermission delegates to lib/rbac-engine for the
// converted sensitive routes.
const db = require('../database');
const { requirePermission: _requirePermission } = require('../lib/rbac-engine');

// Middleware to enforce role restrictions (RBAC).
// Passes when session.role OR session.baseRole (custom-role base) is in allowedRoles.
const requireRole = (allowedRoles) => {
    return (req, res, next) => {
        const userRole = req.session.role || 'assistant';
        const baseRole = req.session.baseRole || userRole;
        if (allowedRoles.includes(userRole) || allowedRoles.includes(baseRole)) {
            return next();
        }
        return res.status(403).json({ success: false, message: 'Forbidden: Insufficient permissions.' });
    };
};

// Restricts direct_emails mutations to administrator/manager only when the email is linked to an
// inquiry (reply-sending) — assistants keep freeform (non-inquiry) compose access. inquiry_id is
// immutable after creation (POST never lets it be changed by PUT), so update/send routes look it
// up from the existing row rather than trusting the request body.
const requireRoleForInquiryEmail = (req, res, next) => {
    const role = req.session.role || 'assistant';
    const baseRole = req.session.baseRole || role;
    const isOps = role === 'administrator' || role === 'manager' || baseRole === 'administrator' || baseRole === 'manager';
    if (isOps) return next();
    if (req.method === 'POST' && req.path === '/api/admin/direct-emails') {
        if (req.body && req.body.inquiry_id) {
            return res.status(403).json({ success: false, message: 'Forbidden: Insufficient permissions.' });
        }
        return next();
    }
    db.get("SELECT inquiry_id FROM direct_emails WHERE id = ?", [req.params.id], (err, row) => {
        if (row && row.inquiry_id) {
            return res.status(403).json({ success: false, message: 'Forbidden: Insufficient permissions.' });
        }
        return next();
    });
};

// Permission-based middleware for converted sensitive routes. Re-exported here so route files
// import from one place (middleware/rbac) rather than mixing middleware and lib imports.
const requirePermission = _requirePermission;

module.exports = { requireRole, requireRoleForInquiryEmail, requirePermission };
