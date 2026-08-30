const express = require('express');
const db = require('../../database');
const { requireAdmin } = require('../../middleware/auth');
const { requireRole } = require('../../middleware/rbac');
const bannerRegistry = require('../../js/bannerRegistry');
const emailComponents = require('../../js/emailComponents');
const { SAMPLES_BY_CATEGORY } = require('../../js/emailPreviewSamples');
const { getEmailFooterContext } = require('../../lib/email-context');
const router = express.Router();

// System-track template_keys have no banner concept (renderSystemEmail has no banner slot) — the
// Banner Centre's preview picker excludes these client-side; this is defense in depth.
const SYSTEM_TRACK_TEMPLATE_KEYS = ['dashboard_invite', 'password_reset'];

// ── Email templates: list (grouped by category client-side) + bulk assign/unassign ──
router.get('/api/admin/email-templates', requireAdmin, requireRole(['administrator', 'manager']), (req, res) => {
    db.all(
        `SELECT etb.template_key, etb.category, etb.banner_id, b.name AS banner_name
         FROM email_template_banners etb
         LEFT JOIN banners b ON b.id = etb.banner_id
         ORDER BY etb.category, etb.template_key`,
        [], (err, templates) => {
            if (err) return res.status(500).json({ success: false, message: err.message });
            res.json({ success: true, templates });
        }
    );
});

router.put('/api/admin/email-templates/assign', requireAdmin, requireRole(['administrator', 'manager']), (req, res) => {
    const { template_keys, banner_id } = req.body;
    if (!Array.isArray(template_keys) || template_keys.length === 0) {
        return res.status(400).json({ success: false, message: 'template_keys must be a non-empty array.' });
    }
    const assign = (cb) => {
        const placeholders = template_keys.map(() => '?').join(',');
        db.run(
            `UPDATE email_template_banners SET banner_id=?, updated_at=CURRENT_TIMESTAMP WHERE template_key IN (${placeholders})`,
            [banner_id || null, ...template_keys],
            function (err) { cb(err, this ? this.changes : 0); }
        );
    };
    if (banner_id) {
        db.get("SELECT id FROM banners WHERE id = ? AND status = 'active'", [banner_id], (err, row) => {
            if (err) return res.status(500).json({ success: false, message: err.message });
            if (!row) return res.status(400).json({ success: false, message: 'Banner not found or not active.' });
            assign((aErr, changes) => {
                if (aErr) return res.status(500).json({ success: false, message: aErr.message });
                template_keys.forEach(k => bannerRegistry.invalidateCache(k));
                res.json({ success: true, updated: changes });
            });
        });
    } else {
        assign((aErr, changes) => {
            if (aErr) return res.status(500).json({ success: false, message: aErr.message });
            template_keys.forEach(k => bannerRegistry.invalidateCache(k));
            res.json({ success: true, updated: changes });
        });
    }
});

// Live preview: renders a template's category-generic sample body with its REAL currently-assigned
// banner (or the text-headline fallback, matching exactly what a real send would look like).
router.get('/api/admin/email-templates/:key/preview', requireAdmin, requireRole(['administrator', 'manager']), async (req, res) => {
    const key = req.params.key;
    if (SYSTEM_TRACK_TEMPLATE_KEYS.includes(key)) {
        return res.status(400).json({ success: false, message: 'This template uses the SYSTEM track — banners are not used; there is no banner preview for it.' });
    }
    db.get('SELECT category FROM email_template_banners WHERE template_key = ?', [key], async (err, row) => {
        if (err) return res.status(500).json({ success: false, message: err.message });
        if (!row) return res.status(404).json({ success: false, message: 'Unknown template_key.' });

        const sample = SAMPLES_BY_CATEGORY[row.category] || { headline: row.category, bodyHtml: 'Sample preview content.' };
        const banner = await bannerRegistry.resolveBanner(key);
        const { socialLinks } = await getEmailFooterContext();
        // Real sends need bannerSrc as an absolute URL (email clients have no "same origin"), but this
        // preview renders inside an admin.html iframe, which enforces its own img-src CSP that doesn't
        // allowlist the production domain — use a same-origin relative path here instead.
        const previewBannerSrc = banner ? banner.src.replace(bannerRegistry.emailBaseUrl(), '') : null;

        const html = emailComponents.renderPremiumEmail(Object.assign({}, sample, {
            preheaderText: `Preview: ${row.category} — ${key}`,
            bannerSrc: previewBannerSrc,
            bannerAlt: banner && banner.alt,
            subtitle: (banner && banner.subtitle) || sample.subtitle,
            headline: (banner && banner.headline) || sample.headline,
            socialLinks
        }));
        res.json({ success: true, html, category: row.category, banner_assigned: !!banner });
    });
});

module.exports = router;
