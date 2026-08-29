const express = require('express');
const db = require('../../database');
const { requireAdmin } = require('../../middleware/auth');
const { requireRole } = require('../../middleware/rbac');
const { upload } = require('../../lib/uploads');
const { logAudit } = require('../../lib/audit-log');
const { resolveActor } = require('../../lib/actor');
const router = express.Router();

// Admin route — same data/ordering as the public route, but session-gated for the dashboard
router.get('/api/admin/highlights', requireAdmin, (req, res) => {
    db.all("SELECT * FROM career_highlights ORDER BY display_order ASC, created_at DESC", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// Using Multer array middleware we defined earlier, or single file handler
router.post('/api/admin/highlights', requireAdmin, upload.single('file'), (req, res) => {
    const { year, title, badge, location, description, display_order, fallback_url, icon } = req.body;
    // Prioritize uploaded file over the fallback URL
    const imagePath = req.file ? `images/${req.file.filename}` : (fallback_url || null);

    db.run("INSERT INTO career_highlights (year, title, badge, location, description, image_path, display_order, icon) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [year, title, badge, location, description, imagePath, display_order || 0, icon || null], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        const newId = this.lastID;
        logAudit({ tableName: 'career_highlights', recordId: newId, action: 'create', req, oldValues: null, newValues: { year, title, badge, location, description, image_path: imagePath, display_order: display_order || 0, icon } }).catch(e => console.error('logAudit failed:', e));
        res.json({ success: true, id: newId });
    });
});

router.put('/api/admin/highlights/:id', requireAdmin, (req, res) => {
    const { year, title, badge, location, description, display_order, fallback_url, clear_image, icon } = req.body;
    db.get("SELECT * FROM career_highlights WHERE id = ?", [req.params.id], (selErr, existing) => {
        const done = function(err) {
            if (err) return res.status(500).json({ error: err.message });
            const newImagePath = (clear_image === true || clear_image === 'true') ? null : (fallback_url || (existing && existing.image_path));
            logAudit({ tableName: 'career_highlights', recordId: req.params.id, action: 'update', req, oldValues: existing || null, newValues: { year, title, badge, location, description, image_path: newImagePath, display_order, icon } }).catch(e => console.error('logAudit failed:', e));
            res.json({ success: true });
        };
        if (clear_image === true || clear_image === 'true') {
            // Clear the image path entirely
            db.run("UPDATE career_highlights SET year = ?, title = ?, badge = ?, location = ?, description = ?, image_path = NULL, display_order = ?, icon = ? WHERE id = ?",
                [year, title, badge, location, description, display_order, icon || null, req.params.id], done);
        } else if (fallback_url) {
            // A new media URL was supplied on edit — update image_path too.
            db.run("UPDATE career_highlights SET year = ?, title = ?, badge = ?, location = ?, description = ?, image_path = ?, display_order = ?, icon = ? WHERE id = ?",
                [year, title, badge, location, description, fallback_url, display_order, icon || null, req.params.id], done);
        } else {
            // No new media — leave the existing image_path untouched.
            db.run("UPDATE career_highlights SET year = ?, title = ?, badge = ?, location = ?, description = ?, display_order = ?, icon = ? WHERE id = ?",
                [year, title, badge, location, description, display_order, icon || null, req.params.id], done);
        }
    });
});

router.delete('/api/admin/highlights/:id', requireAdmin, requireRole(['administrator']), (req, res) => {
    db.get("SELECT * FROM career_highlights WHERE id = ?", [req.params.id], (selErr, existing) => {
        db.run("DELETE FROM career_highlights WHERE id = ?", req.params.id, function(err) {
            if (err) return res.status(500).json({ error: err.message });
            logAudit({ tableName: 'career_highlights', recordId: req.params.id, action: 'delete', req, oldValues: existing || null, newValues: null }).catch(e => console.error('logAudit failed:', e));
            res.json({ success: true });
        });
    });
});

router.get('/api/admin/footprint', requireAdmin, (req, res) => {
    db.all("SELECT * FROM footprint_countries ORDER BY display_order ASC, created_at DESC", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

router.post('/api/admin/footprint', requireAdmin, upload.single('file'), (req, res) => {
    const { country_name, display_order, fallback_url } = req.body;
    const imagePath = req.file ? `images/footprint/${req.file.filename}` : (fallback_url || null);
    if (!country_name || !imagePath) {
        return res.status(400).json({ success: false, message: 'Country name and a flag image are required.' });
    }
    db.run("INSERT INTO footprint_countries (country_name, flag_image_path, display_order) VALUES (?, ?, ?)",
        [country_name, imagePath, display_order || 0], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        const newId = this.lastID;
        logAudit({ tableName: 'footprint_countries', recordId: newId, action: 'create', req, oldValues: null, newValues: { country_name, flag_image_path: imagePath, display_order: display_order || 0 } }).catch(e => console.error('logAudit failed:', e));
        res.json({ success: true, id: newId });
    });
});

router.put('/api/admin/footprint/:id', requireAdmin, (req, res) => {
    const { country_name, display_order, fallback_url } = req.body;
    db.get("SELECT * FROM footprint_countries WHERE id = ?", [req.params.id], (selErr, existing) => {
        const done = function(err) {
            if (err) return res.status(500).json({ error: err.message });
            const newFlagPath = fallback_url || (existing && existing.flag_image_path);
            logAudit({ tableName: 'footprint_countries', recordId: req.params.id, action: 'update', req, oldValues: existing || null, newValues: { country_name, flag_image_path: newFlagPath, display_order } }).catch(e => console.error('logAudit failed:', e));
            res.json({ success: true });
        };
        if (fallback_url) {
            // A new flag image was supplied on edit.
            db.run("UPDATE footprint_countries SET country_name = ?, flag_image_path = ?, display_order = ? WHERE id = ?",
                [country_name, fallback_url, display_order, req.params.id], done);
        } else {
            // No new image — flag_image_path is required, so it's never cleared, only replaced.
            db.run("UPDATE footprint_countries SET country_name = ?, display_order = ? WHERE id = ?",
                [country_name, display_order, req.params.id], done);
        }
    });
});

router.delete('/api/admin/footprint/:id', requireAdmin, requireRole(['administrator']), (req, res) => {
    db.get("SELECT * FROM footprint_countries WHERE id = ?", [req.params.id], (selErr, existing) => {
        db.run("DELETE FROM footprint_countries WHERE id = ?", req.params.id, function(err) {
            if (err) return res.status(500).json({ error: err.message });
            logAudit({ tableName: 'footprint_countries', recordId: req.params.id, action: 'delete', req, oldValues: existing || null, newValues: null }).catch(e => console.error('logAudit failed:', e));
            res.json({ success: true });
        });
    });
});

// Admin: every status, so the moderation queue can show pending/approved/rejected.
router.get('/api/admin/testimonials', requireAdmin, (req, res) => {
    const status = req.query.status;
    const where = status ? "WHERE status = ?" : "";
    const params = status ? [status] : [];
    db.all(`SELECT * FROM testimonials ${where} ORDER BY display_order ASC, created_at DESC`, params, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// Admin-authored testimonial — the site owner's own content skips the review queue.
router.post('/api/admin/testimonials', requireAdmin, upload.single('file'), (req, res) => {
    const { name, designation, quote, display_order, fallback_url } = req.body;
    if (!name || !quote) {
        return res.status(400).json({ success: false, message: 'Name and testimonial text are required.' });
    }
    const imagePath = req.file ? `images/testimonials/${req.file.filename}` : (fallback_url || null);
    db.run("INSERT INTO testimonials (name, designation, quote, image_path, display_order, status, submitted_by) VALUES (?, ?, ?, ?, ?, 'approved', 'admin')",
        [name, designation || null, quote, imagePath, display_order || 0], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        const newId = this.lastID;
        logAudit({ tableName: 'testimonials', recordId: newId, action: 'create', req, oldValues: null, newValues: { name, designation, quote, image_path: imagePath, display_order: display_order || 0, status: 'approved' } }).catch(e => console.error('logAudit failed:', e));
        res.json({ success: true, id: newId });
    });
});

// Edit — also how Approve/Reject work (a status-only PUT from the admin moderation queue).
router.put('/api/admin/testimonials/:id', requireAdmin, (req, res) => {
    const { name, designation, quote, display_order, fallback_url, clear_image, status } = req.body;
    db.get("SELECT * FROM testimonials WHERE id = ?", [req.params.id], (selErr, existing) => {
        if (selErr) return res.status(500).json({ error: selErr.message });
        if (!existing) return res.status(404).json({ success: false, message: 'Testimonial not found' });

        const newName = name !== undefined ? name : existing.name;
        const newDesignation = designation !== undefined ? designation : existing.designation;
        const newQuote = quote !== undefined ? quote : existing.quote;
        const newDisplayOrder = display_order !== undefined ? display_order : existing.display_order;
        const newStatus = status !== undefined ? status : existing.status;
        let newImagePath = existing.image_path;
        if (clear_image === true || clear_image === 'true') newImagePath = null;
        else if (fallback_url) newImagePath = fallback_url;

        db.run("UPDATE testimonials SET name = ?, designation = ?, quote = ?, image_path = ?, display_order = ?, status = ? WHERE id = ?",
            [newName, newDesignation, newQuote, newImagePath, newDisplayOrder, newStatus, req.params.id], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            logAudit({ tableName: 'testimonials', recordId: req.params.id, action: 'update', req, oldValues: existing, newValues: { name: newName, designation: newDesignation, quote: newQuote, image_path: newImagePath, display_order: newDisplayOrder, status: newStatus } }).catch(e => console.error('logAudit failed:', e));
            res.json({ success: true });
        });
    });
});

router.delete('/api/admin/testimonials/:id', requireAdmin, requireRole(['administrator']), (req, res) => {
    db.get("SELECT * FROM testimonials WHERE id = ?", [req.params.id], (selErr, existing) => {
        db.run("DELETE FROM testimonials WHERE id = ?", req.params.id, function(err) {
            if (err) return res.status(500).json({ error: err.message });
            logAudit({ tableName: 'testimonials', recordId: req.params.id, action: 'delete', req, oldValues: existing || null, newValues: null }).catch(e => console.error('logAudit failed:', e));
            res.json({ success: true });
        });
    });
});

router.put('/api/admin/gallery/reorder', requireAdmin, (req, res) => {
    const { order } = req.body; // Array of IDs in new order
    db.serialize(() => {
        const stmt = db.prepare("UPDATE gallery_images SET display_order = ? WHERE id = ?");
        order.forEach((id, index) => {
            stmt.run(index, id);
        });
        stmt.finalize((err) => {
            if (err) return res.status(500).json({ error: err.message });
            logAudit({ tableName: 'gallery_images', recordId: 0, action: 'reorder', req, oldValues: null, newValues: { order } }).catch(e => console.error('logAudit failed:', e));
            res.json({ success: true });
        });
    });
});

router.post('/api/admin/gallery', requireAdmin, upload.single('file'), (req, res) => {
    const { title, fallback_url, uploader_name, location } = req.body;
    const imagePath = req.file ? `images/gallery/${req.file.filename}` : (fallback_url || null);
    if (!imagePath) return res.status(400).json({ success: false, message: 'Image file required' });

    db.run("INSERT INTO gallery_images (title, image_path, uploader_name, location, created_by, display_order) VALUES (?, ?, ?, ?, ?, (SELECT IFNULL(MAX(display_order), 0) + 1 FROM gallery_images))",
        [title, imagePath, uploader_name || null, location || null, req.session.adminId], async function(err) {
        if (err) return res.status(500).json({ error: err.message });
        const newId = this.lastID;
        logAudit({ tableName: 'gallery_images', recordId: newId, action: 'create', req, oldValues: null, newValues: { title, image_path: imagePath, uploader_name, location } }).catch(e => console.error('logAudit failed:', e));
        const actor = await resolveActor(req.session.adminId);
        res.json({ success: true, id: newId, imagePath, last_updated: { name: actor.name, role: actor.role, at: new Date().toISOString() } });
    });
});

router.put('/api/admin/gallery/:id', requireAdmin, (req, res) => {
    const { title, fallback_url, uploader_name, location } = req.body;
    const galleryId = req.params.id;
    db.get("SELECT * FROM gallery_images WHERE id = ?", [galleryId], (selErr, existing) => {
        const done = async function(err) {
            if (err) return res.status(500).json({ error: err.message });
            logAudit({ tableName: 'gallery_images', recordId: galleryId, action: 'update', req, oldValues: existing || null, newValues: { title, uploader_name, location, image_path: fallback_url || (existing && existing.image_path) } }).catch(e => console.error('logAudit failed:', e));
            const actor = await resolveActor(req.session.adminId);
            res.json({ success: true, last_updated: { name: actor.name, role: actor.role, at: new Date().toISOString() } });
        };
        if (fallback_url) {
            // A new media URL was supplied — update image_path too.
            db.run("UPDATE gallery_images SET title = ?, image_path = ?, uploader_name = ?, location = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                [title, fallback_url, uploader_name || null, location || null, req.session.adminId, galleryId], done);
        } else {
            // Title-only edit — leave the existing image untouched.
            db.run("UPDATE gallery_images SET title = ?, uploader_name = ?, location = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                [title, uploader_name || null, location || null, req.session.adminId, galleryId], done);
        }
    });
});

router.delete('/api/admin/gallery/:id', requireAdmin, requireRole(['administrator']), (req, res) => {
    db.get("SELECT * FROM gallery_images WHERE id = ?", [req.params.id], (selErr, existing) => {
        db.run("DELETE FROM gallery_images WHERE id = ?", req.params.id, function(err) {
            if (err) return res.status(500).json({ error: err.message });
            logAudit({ tableName: 'gallery_images', recordId: req.params.id, action: 'delete', req, oldValues: existing || null, newValues: null }).catch(e => console.error('logAudit failed:', e));
            res.json({ success: true });
        });
    });
});

module.exports = router;
