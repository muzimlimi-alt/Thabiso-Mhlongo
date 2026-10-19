// Manual EFT - admin API (docs-internal/eft-payments.md).
//   banking details + switches : administrators only
//   review queue + decisions   : administrators and managers (the roles that may already record a payment)
// Banking details are returned in full only to an administrator, and an account number is masked in every audit row and log line.
const express = require('express');
const { requireAdmin } = require('../../middleware/auth');
const { requireRole } = require('../../middleware/rbac');
const { logAudit } = require('../../lib/audit-log');
const core = require('../../lib/eft-core');
const eft = require('../../lib/eft');
const approval = require('../../lib/eft-approval');
const router = express.Router();

const ADMIN_ONLY = requireRole(['administrator']);
const FINANCE = requireRole(['administrator', 'manager']);
const err500 = (res, e) => { console.error('[EFT admin]', e.message); return res.status(500).json({ success: false, message: 'Something went wrong. Please try again.' }); };

// ---------------------------------------------------------------- switches and banking details (administrators)

router.get('/api/admin/eft/settings', requireAdmin, FINANCE, async (req, res) => {
    try {
        const settings = await eft.getEftSettings();
        res.json({ success: true, settings, has_bank_details: !!(await eft.getActiveBankDetails()), pending_count: await eft.pendingCount(),
            accepted_types: Object.values(core.PROOF_TYPES).map(t => t.label), max_upload_mb_limit: core.MAX_UPLOAD_MB_LIMIT });
    } catch (e) { err500(res, e); }
});

router.put('/api/admin/eft/settings', requireAdmin, ADMIN_ONLY, async (req, res) => {
    try {
        const body = req.body || {};
        const result = await eft.saveEftSettings({ enabled: body.enabled, maxUploadMb: body.max_upload_mb }, req.session.adminId);
        if (result.error) return res.status(400).json({ success: false, message: result.error });
        await logAudit({ tableName: 'eft_settings', recordId: 1, action: 'EFT_SETTINGS_CHANGED', req, oldValues: result.before, newValues: result.after });
        res.json({ success: true, settings: result.after, message: result.after.enabled ? 'Manual EFT is on.' : 'Manual EFT is off.' });
    } catch (e) { err500(res, e); }
});

router.get('/api/admin/eft/bank-details', requireAdmin, ADMIN_ONLY, async (req, res) => {
    try {
        const active = await eft.getActiveBankDetails();
        const versions = (await eft.listBankDetailsVersions()).map(v => ({ ...v, account_number: undefined, account_number_masked: core.maskAccountNumber(v.account_number), is_active: !!v.is_active }));
        res.json({
            success: true,
            active: active ? { ...active, account_type_label: core.ACCOUNT_TYPES[active.account_type] || active.account_type } : null,
            versions, account_types: core.ACCOUNT_TYPES
        });
    } catch (e) { err500(res, e); }
});

// A change creates a NEW version. Invoices already issued keep the version they carry; the response says how many open ones now show older details.
router.put('/api/admin/eft/bank-details', requireAdmin, ADMIN_ONLY, async (req, res) => {
    try {
        const { clean, errors } = core.validateBankDetails(req.body);
        if (Object.keys(errors).length) return res.status(400).json({ success: false, message: Object.values(errors)[0], errors });
        const result = await eft.saveBankDetails(clean, req.session.adminId);
        if (result.unchanged) return res.json({ success: true, unchanged: true, message: 'Nothing changed - these are already the current banking details.' });
        await logAudit({
            tableName: 'bank_details', recordId: result.created.id, action: 'BANK_DETAILS_CHANGED', req,
            oldValues: core.auditViewOfBankDetails(result.previous), newValues: core.auditViewOfBankDetails(result.created),
            reason: result.previous ? `Changed: ${core.changedBankFields(result.previous, result.created).join(', ')}` : 'Banking details added'
        });
        const openOnOld = result.previous ? await eft.openInvoicesOnVersion(result.previous.id) : 0;
        res.json({
            success: true, version: result.created.version, open_invoices_on_previous_version: openOnOld,
            message: result.previous
                ? `Banking details updated (version ${result.created.version}). New invoices carry them from now on; invoices already sent are unchanged.` + (openOnOld ? ` ${openOnOld} unpaid invoice${openOnOld === 1 ? '' : 's'} still show the previous details - consider re-sending them.` : '')
                : `Banking details saved (version ${result.created.version}).`
        });
    } catch (e) { err500(res, e); }
});

// ---------------------------------------------------------------- the review queue (administrators and managers)

router.get('/api/admin/eft/submissions', requireAdmin, FINANCE, async (req, res) => {
    try {
        const { rows, total } = await eft.listSubmissions({ status: req.query.status, bookingId: req.query.booking_id, limit: req.query.limit, offset: req.query.offset });
        res.json({ success: true, submissions: rows, total, pending_count: await eft.pendingCount() });
    } catch (e) { err500(res, e); }
});

router.get('/api/admin/eft/submissions/:id', requireAdmin, FINANCE, async (req, res) => {
    try {
        const detail = await eft.getSubmissionDetail(req.params.id);
        if (!detail) return res.status(404).json({ success: false, message: 'Proof of payment not found.' });
        res.json({ success: true, ...detail });
    } catch (e) { err500(res, e); }
});

// The file itself, for the reviewer. Never cached, never sniffed, never given a script context.
router.get('/api/admin/eft/submissions/:id/proof', requireAdmin, FINANCE, async (req, res) => {
    try {
        const sub = await eft.getSubmission(req.params.id);
        if (!sub) return res.status(404).json({ success: false, message: 'Proof of payment not found.' });
        const doc = await eft.openProofFile(sub);
        if (!doc) return res.status(404).json({ success: false, message: 'The proof of payment file was not found on the server.' });
        const ext = (core.PROOF_TYPES[sub.proof_mime] || {}).ext || 'bin';
        res.setHeader('Content-Type', sub.proof_mime);
        res.setHeader('Content-Disposition', `${req.query.inline === '1' ? 'inline' : 'attachment'}; filename="proof-of-payment-${sub.id}.${ext}"`);
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Cache-Control', 'private, no-store');
        res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; sandbox");
        if (doc.stream) doc.stream.pipe(res); else res.sendFile(doc.diskPath);
    } catch (e) { err500(res, e); }
});

const respond = (res, r) => {
    const { ok, status, ...rest } = r;
    res.status(status).json({ success: !!ok, ...rest });
};

router.post('/api/admin/eft/submissions/:id/approve', requireAdmin, FINANCE, async (req, res) => {
    try { respond(res, await approval.approveSubmission(req.params.id, req.body || {}, req)); } catch (e) { err500(res, e); }
});
router.post('/api/admin/eft/submissions/:id/reject', requireAdmin, FINANCE, async (req, res) => {
    try { respond(res, await approval.rejectSubmission(req.params.id, (req.body || {}).note, req)); } catch (e) { err500(res, e); }
});
router.post('/api/admin/eft/submissions/:id/request-replacement', requireAdmin, FINANCE, async (req, res) => {
    try { respond(res, await approval.requestReplacement(req.params.id, (req.body || {}).note, req)); } catch (e) { err500(res, e); }
});

// A booking's own proofs, for its Deal View.
router.get('/api/admin/bookings/:id/eft-submissions', requireAdmin, FINANCE, async (req, res) => {
    try {
        const { rows } = await eft.listSubmissions({ bookingId: req.params.id, limit: 50 });
        res.json({ success: true, submissions: rows });
    } catch (e) { err500(res, e); }
});

module.exports = router;
