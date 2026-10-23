// Business profile admin API - who issues our documents and which SARS registrations apply. Rules: lib/business-profile-core.js;
// storage: lib/business-profile.js; design + legal notes: docs-internal/business-profile-2026.md.
//
// Roles: administrators read and change everything; managers may READ (income-tax reference masked) and preview; assistants get nothing.
// The settings page is never the only guard - every rule here is enforced by the server, including the explicit confirmation a change to a
// registration switch needs (409 CONFIRM_REQUIRED until the request says confirm_registration_change: true).
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { requireAdmin } = require('../../middleware/auth');
const { requireRole } = require('../../middleware/rbac');
const profile = require('../../lib/business-profile');
const core = require('../../lib/business-profile-core');
const pdfService = require('../../js/pdfService');
const router = express.Router();

const readers = [requireAdmin, requireRole(['administrator', 'manager'])];
const writers = [requireAdmin, requireRole(['administrator'])];

router.get('/api/admin/business-profile', readers, async (req, res) => {
    try {
        res.set('Cache-Control', 'no-store');
        res.json(await profile.adminView(req.session.role || 'assistant'));
    } catch (e) {
        console.error('business profile load failed:', e);
        res.status(500).json({ success: false, message: 'Could not load the business profile. Please try again.' });
    }
});

router.put('/api/admin/business-profile', writers, async (req, res) => {
    try {
        const r = await profile.saveProfile(req.body || {}, req);
        res.status(r.status).json(r.body);
    } catch (e) {
        console.error('business profile save failed:', e);
        res.status(500).json({ success: false, message: 'Could not save the business profile. Please try again.' });
    }
});

// The director's ID number is stored encrypted and never travels with the profile; this is the one deliberate, audited way to see it.
router.post('/api/admin/business-profile/reveal-director-id', writers, async (req, res) => {
    try {
        const r = await profile.revealDirectorId(req);
        res.set('Cache-Control', 'no-store');
        res.status(r.status).json(r.body);
    } catch (e) {
        console.error('director id reveal failed:', e);
        res.status(500).json({ success: false, message: 'Could not read the ID number.' });
    }
});

// A real quotation / invoice PDF on made-up data, rendered by the same generator the live documents use, from the form's UNSAVED values
// (nothing is stored). `document`: 'quote' | 'invoice'.
router.post('/api/admin/business-profile/preview', readers, async (req, res) => {
    const kind = (req.body || {}).document === 'invoice' ? 'Invoice' : 'Quote';
    let tmp;
    try {
        const stored = await profile.getRow();
        if (!stored) return res.status(500).json({ success: false, message: 'The business profile is not set up yet.' });
        const draft = Object.assign({}, stored, core.normalizeInput((req.body || {}).profile || {}));
        for (const f of core.BOOL_FIELDS) draft[f] = draft[f] ? 1 : 0;
        const { errors } = core.validateProfile(draft);
        if (Object.keys(errors).length) return res.status(400).json({ success: false, message: 'Fix these first: ' + Object.values(errors).join(' '), errors });
        const issuer = core.issuerView(draft);
        const vatOn = issuer.vatRegistered;   // the preview shows the VAT layout whenever the draft would really charge VAT
        const items = [
            { description: 'Sample service - keynote performance', quantity: 1, unit_price: 10000, total_price: 10000, pricing_model: 'flat_fee', tax_class: 'standard' },
            { description: 'Sample service - travel (VAT exempt)', quantity: 1, unit_price: 1500, total_price: 1500, pricing_model: 'flat_fee', tax_class: 'exempt' }
        ];
        const booking = { id: 0, name: 'Sample Client', company: 'Sample Client (Pty) Ltd', email: 'client@example.com', cell: '+27 82 000 0000', event_name: 'Sample event', date: '2026-12-01',
            event_location: 'Sample venue, Johannesburg', apply_vat: vatOn, discount: 0, vat_rate: 0.15, terms: 'Sample terms - preview only.' };
        tmp = path.join(os.tmpdir(), `bp-preview-${process.pid}-${Date.now()}.pdf`);
        const due = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
        const expiry = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);
        await pdfService.generateDocument(kind, booking, items, tmp, [], kind === 'Invoice' ? 'INV-PREVIEW-0000' : 'QT-PREVIEW-0000',
            { issuer, quoteExpiry: expiry, dueDate: due, quoteNumber: 'QT-PREVIEW-0000', pricingConditions: kind === 'Quote' ? ['Sample conditions - preview only.'] : undefined });
        res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="Letterhead_preview_${kind}.pdf"`, 'Cache-Control': 'no-store' });
        const stream = fs.createReadStream(tmp);
        stream.on('close', () => fs.unlink(tmp, () => {}));
        stream.pipe(res);
    } catch (e) {
        console.error('letterhead preview failed:', e);
        if (tmp) fs.unlink(tmp, () => {});
        if (!res.headersSent) res.status(500).json({ success: false, message: 'Could not build the preview.' });
    }
});

module.exports = router;
