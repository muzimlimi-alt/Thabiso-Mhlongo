const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { imageSize } = require('image-size');
const db = require('../../database');
const { requireAdmin } = require('../../middleware/auth');
const { requireRole } = require('../../middleware/rbac');
const { uploadsWriteDir } = require('../../lib/runtime-paths');
const bannerRegistry = require('../../js/bannerRegistry');
const router = express.Router();

const bannerUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 500 * 1024 } // hard ceiling; the real <=100KB check below gives a clear message
}).single('image');

const BANNER_MIN_WIDTH = 1200;
const BANNER_MAX_WIDTH = 1400;
const BANNER_MAX_BYTES = 100 * 1024;

// Validates an in-memory upload against the pack's spec: JPG/PNG only, <=100KB, width 1200-1400px.
// Returns { ok:true } or { ok:false, message } — never throws.
function validateBannerImageBuffer(file) {
    if (!file) return { ok: false, message: 'No image file was uploaded.' };
    const ext = path.extname(file.originalname).toLowerCase().replace('.', '');
    const mimeOk = ['image/jpeg', 'image/png'].includes(file.mimetype);
    if (!['jpg', 'jpeg', 'png'].includes(ext) || !mimeOk) {
        return { ok: false, message: 'Only JPG or PNG images are allowed.' };
    }
    if (file.size > BANNER_MAX_BYTES) {
        return { ok: false, message: `Image must be ${Math.round(BANNER_MAX_BYTES / 1024)}KB or smaller (received ${Math.round(file.size / 1024)}KB). Compress and try again.` };
    }
    let dims;
    try { dims = imageSize(file.buffer); } catch (e) {
        return { ok: false, message: 'Could not read the image — the file may be corrupt.' };
    }
    if (dims.width < BANNER_MIN_WIDTH || dims.width > BANNER_MAX_WIDTH) {
        return { ok: false, message: `Image width must be between ${BANNER_MIN_WIDTH} and ${BANNER_MAX_WIDTH}px for retina display (received ${dims.width}px).` };
    }
    return { ok: true };
}

// Writes a validated buffer to the banners upload dir and returns its web-servable /images/... path.
function saveBannerImage(file) {
    const ext = path.extname(file.originalname).toLowerCase();
    const filename = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`;
    fs.writeFileSync(path.join(uploadsWriteDir('banners'), filename), file.buffer);
    return `/images/banners/${filename}`;
}

const BANNER_CATEGORIES = [
    'Booking Requests', 'Quotes & Proposals', 'Contracts & Signatures', 'Payments & Invoices',
    'Booking Confirmations', 'Event Reminders', 'Thank You & Reviews', 'Booking Recovery',
    'Contact & Support', 'Newsletters & Marketing', 'User Accounts & Security', 'Birthday'
];

// ── List (paginated, with usage counts) ──
router.get('/api/admin/banners', requireAdmin, requireRole(['administrator', 'manager']), (req, res) => {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(Math.max(1, parseInt(req.query.limit) || 50), 200);
    const offset = (page - 1) * limit;
    const conditions = [];
    const qp = [];
    if (req.query.category && BANNER_CATEGORIES.includes(req.query.category)) {
        conditions.push('b.category = ?'); qp.push(req.query.category);
    }
    if (['active', 'archived'].includes(req.query.status)) {
        conditions.push('b.status = ?'); qp.push(req.query.status);
    }
    if (req.query.search) {
        conditions.push('LOWER(b.name) LIKE LOWER(?)'); qp.push(`%${req.query.search}%`);
    }
    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    db.get(`SELECT COUNT(*) AS total FROM banners b ${whereClause}`, qp, (err, countRow) => {
        if (err) return res.status(500).json({ success: false, message: err.message });
        db.all(
            `SELECT b.*, COUNT(etb.template_key) AS usage_count
             FROM banners b
             LEFT JOIN email_template_banners etb ON etb.banner_id = b.id
             ${whereClause}
             GROUP BY b.id
             ORDER BY b.updated_at DESC
             LIMIT ? OFFSET ?`,
            [...qp, limit, offset],
            (err2, rows) => {
                if (err2) return res.status(500).json({ success: false, message: err2.message });
                const total = countRow.total;
                res.json({ success: true, banners: rows, total, page, pages: Math.ceil(total / limit) || 1 });
            }
        );
    });
});

// ── Get one, with its "used by" list ──
router.get('/api/admin/banners/:id', requireAdmin, requireRole(['administrator', 'manager']), (req, res) => {
    db.get('SELECT * FROM banners WHERE id = ?', [req.params.id], (err, banner) => {
        if (err) return res.status(500).json({ success: false, message: err.message });
        if (!banner) return res.status(404).json({ success: false, message: 'Banner not found.' });
        db.all('SELECT template_key, category FROM email_template_banners WHERE banner_id = ? ORDER BY category, template_key',
            [req.params.id], (err2, used_by) => {
                if (err2) return res.status(500).json({ success: false, message: err2.message });
                res.json({ success: true, banner, used_by });
            });
    });
});

// ── Create ──
router.post('/api/admin/banners', requireAdmin, requireRole(['administrator', 'manager']), (req, res) => {
    bannerUpload(req, res, (uploadErr) => {
        if (uploadErr) return res.status(400).json({ success: false, message: uploadErr.message || 'Upload failed.' });

        const { name, category, alt_text, headline, subtitle } = req.body;
        if (!name || !String(name).trim()) return res.status(400).json({ success: false, message: 'Banner name is required.' });
        if (!BANNER_CATEGORIES.includes(category)) return res.status(400).json({ success: false, message: 'A valid category is required.' });
        if (!alt_text || !String(alt_text).trim()) return res.status(400).json({ success: false, message: 'Alt text is required (accessibility + deliverability).' });

        const validation = validateBannerImageBuffer(req.file);
        if (!validation.ok) return res.status(400).json({ success: false, message: validation.message });

        const imageUrl = saveBannerImage(req.file);
        db.run(
            `INSERT INTO banners (name, category, image_url, alt_text, headline, subtitle, created_by)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [name.trim(), category, imageUrl, alt_text.trim(), headline || null, subtitle || null, req.session.adminId],
            function (err) {
                if (err) return res.status(500).json({ success: false, message: err.message });
                db.get('SELECT * FROM banners WHERE id = ?', [this.lastID], (e2, banner) => {
                    if (e2) return res.status(500).json({ success: false, message: e2.message });
                    res.json({ success: true, banner });
                });
            }
        );
    });
});

// ── Update (metadata; optional image replace) ──
router.put('/api/admin/banners/:id', requireAdmin, requireRole(['administrator', 'manager']), (req, res) => {
    bannerUpload(req, res, (uploadErr) => {
        if (uploadErr) return res.status(400).json({ success: false, message: uploadErr.message || 'Upload failed.' });

        db.get('SELECT * FROM banners WHERE id = ?', [req.params.id], (err, existing) => {
            if (err) return res.status(500).json({ success: false, message: err.message });
            if (!existing) return res.status(404).json({ success: false, message: 'Banner not found.' });

            const { name, category, alt_text, headline, subtitle } = req.body;
            if (category && !BANNER_CATEGORIES.includes(category)) {
                return res.status(400).json({ success: false, message: 'A valid category is required.' });
            }

            let imageUrl = existing.image_url;
            if (req.file) {
                const validation = validateBannerImageBuffer(req.file);
                if (!validation.ok) return res.status(400).json({ success: false, message: validation.message });
                imageUrl = saveBannerImage(req.file);
            }

            db.run(
                `UPDATE banners SET name=?, category=?, image_url=?, alt_text=?, headline=?, subtitle=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`,
                [
                    name ? name.trim() : existing.name,
                    category || existing.category,
                    imageUrl,
                    alt_text ? alt_text.trim() : existing.alt_text,
                    headline !== undefined ? (headline || null) : existing.headline,
                    subtitle !== undefined ? (subtitle || null) : existing.subtitle,
                    req.params.id
                ],
                function (uErr) {
                    if (uErr) return res.status(500).json({ success: false, message: uErr.message });
                    bannerRegistry.invalidateCache(); // this banner's image/copy may back several template_keys
                    db.get('SELECT * FROM banners WHERE id = ?', [req.params.id], (e2, banner) => {
                        if (e2) return res.status(500).json({ success: false, message: e2.message });
                        res.json({ success: true, banner });
                    });
                }
            );
        });
    });
});

// ── Archive / restore (status toggle — no hard delete, no version history: MVP per the pack) ──
function setBannerStatus(status) {
    return (req, res) => {
        db.run('UPDATE banners SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?', [status, req.params.id], function (err) {
            if (err) return res.status(500).json({ success: false, message: err.message });
            if (this.changes === 0) return res.status(404).json({ success: false, message: 'Banner not found.' });
            bannerRegistry.invalidateCache();
            db.get('SELECT COUNT(*) AS used_by_count FROM email_template_banners WHERE banner_id = ?', [req.params.id], (e2, row) => {
                res.json({ success: true, status, used_by_count: e2 ? 0 : row.used_by_count });
            });
        });
    };
}
router.patch('/api/admin/banners/:id/archive', requireAdmin, requireRole(['administrator', 'manager']), setBannerStatus('archived'));

router.patch('/api/admin/banners/:id/restore', requireAdmin, requireRole(['administrator', 'manager']), setBannerStatus('active'));

module.exports = router;
