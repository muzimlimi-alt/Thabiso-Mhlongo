// The PayFast safety net - admin API (lib/payfast-reconcile.js, docs-internal/payfast.md): how it is doing, the payments it could not record by itself,
// "check PayFast now", and marking a finding dealt with. Administrators and managers, like the rest of Finance.
const express = require('express');
const { requireAdmin } = require('../../middleware/auth');
const { requireRole } = require('../../middleware/rbac');
const reconcile = require('../../lib/payfast-reconcile');
const router = express.Router();

const FINANCE = requireRole(['administrator', 'manager']);
const err500 = (res, e) => { console.error('[PayFast safety net admin]', e.message); return res.status(500).json({ success: false, message: 'Something went wrong. Please try again.' }); };

router.get('/api/admin/payfast/reconcile', requireAdmin, FINANCE, async (req, res) => {
    try {
        const [status, findings] = await Promise.all([reconcile.getStatus(), reconcile.listFindings({ limit: 50 })]);
        res.json({ success: true, status, findings });
    } catch (e) { err500(res, e); }
});

// Runs a check right now (ignores the ten-minute wait the background run observes, still never credits anything that does not match exactly).
router.post('/api/admin/payfast/reconcile/run', requireAdmin, FINANCE, async (req, res) => {
    try {
        // dry_run: look at PayFast and say what WOULD be recorded, change nothing (no credit, no finding, no state, no e-mail)
        // booking_id: check just that booking's waiting payments
        const bookingId = parseInt(req.body && req.body.booking_id, 10) || undefined;
        const r = await reconcile.reconcileNow({ reason: 'admin', req, bookingId, dryRun: !!(req.body && req.body.dry_run) });
        if (r.skipped === 'busy') return res.status(409).json({ success: false, message: r.message });
        if (r.ok === false) return res.status(502).json({ success: false, message: r.message, error: r.error });
        res.json({ success: true, checked: r.checked || 0, recovered: r.recovered || [], findings: r.findings || [], skipped: r.skipped || null, message: r.message });
    } catch (e) { err500(res, e); }
});

router.post('/api/admin/payfast/reconcile/findings/:id/resolve', requireAdmin, FINANCE, async (req, res) => {
    try {
        const r = await reconcile.resolveFinding(req.params.id, req.session.adminId, (req.body || {}).note, req);
        res.status(r.status).json({ success: r.ok, message: r.message });
    } catch (e) { err500(res, e); }
});

module.exports = router;
