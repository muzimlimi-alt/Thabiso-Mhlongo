// RBAC middleware — Phase 5 of the housekeeping effort (HOUSEKEEPING-NOTES.md). Moved out of the
// server.js monolith byte-identical.
const db = require('../database');

// Middleware to enforce role restrictions (RBAC)
const requireRole = (allowedRoles) => {
    return (req, res, next) => {
        const userRole = req.session.role || 'assistant';
        if (allowedRoles.includes(userRole)) {
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
    if (role === 'administrator' || role === 'manager') return next();
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

module.exports = { requireRole, requireRoleForInquiryEmail };
