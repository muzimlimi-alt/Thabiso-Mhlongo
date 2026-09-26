// Management Team admin CRUD — mirrors the gallery_images route shape in routes/admin/content.js
// (same requireAdmin/requireRole split, logAudit + resolveActor last_updated pattern).
const express = require('express');
const db = require('../../database');
const { requireAdmin } = require('../../middleware/auth');
const { requireRole } = require('../../middleware/rbac');
const { upload } = require('../../lib/uploads');
const { logAudit } = require('../../lib/audit-log');
const { resolveActor } = require('../../lib/actor');
const router = express.Router();

// Admin: every status (active + inactive), so hidden members can still be managed.
router.get('/api/admin/team', requireAdmin, (req, res) => {
    db.all("SELECT * FROM team_members ORDER BY display_order ASC, id ASC", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

router.put('/api/admin/team/reorder', requireAdmin, (req, res) => {
    const { order } = req.body; // Array of IDs in new order
    if (!Array.isArray(order)) return res.status(400).json({ success: false, message: 'order must be an array of IDs' });
    db.serialize(() => {
        const stmt = db.prepare("UPDATE team_members SET display_order = ? WHERE id = ?");
        order.forEach((id, index) => { stmt.run(index, id); });
        stmt.finalize((err) => {
            if (err) return res.status(500).json({ error: err.message });
            logAudit({ tableName: 'team_members', recordId: 0, action: 'reorder', req, oldValues: null, newValues: { order } }).catch(e => console.error('logAudit failed:', e));
            res.json({ success: true });
        });
    });
});

router.post('/api/admin/team', requireAdmin, upload.single('file'), (req, res) => {
    const { name, role, biography, email, phone, website, twitter, linkedin, instagram, behance, fallback_url, status, featured } = req.body;
    if (!name) return res.status(400).json({ success: false, message: 'Name is required.' });
    const imagePath = req.file ? `images/team/${req.file.filename}` : (fallback_url || null);
    const newValues = {
        name, role: role || null, biography: biography || null, image_path: imagePath,
        email: email || null, phone: phone || null, website: website || null,
        twitter: twitter || null, linkedin: linkedin || null, instagram: instagram || null, behance: behance || null,
        status: status || 'active', featured: (featured === true || featured === 'true') ? 1 : 0
    };

    db.run(`INSERT INTO team_members (name, role, biography, image_path, email, phone, website, twitter, linkedin, instagram, behance, status, featured, created_by, display_order)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT IFNULL(MAX(display_order), 0) + 1 FROM team_members))`,
        [newValues.name, newValues.role, newValues.biography, newValues.image_path, newValues.email, newValues.phone, newValues.website,
         newValues.twitter, newValues.linkedin, newValues.instagram, newValues.behance, newValues.status, newValues.featured, req.session.adminId],
        async function (err) {
            if (err) return res.status(500).json({ error: err.message });
            const newId = this.lastID;
            logAudit({ tableName: 'team_members', recordId: newId, action: 'create', req, oldValues: null, newValues }).catch(e => console.error('logAudit failed:', e));
            const actor = await resolveActor(req.session.adminId);
            res.json({ success: true, id: newId, imagePath, last_updated: { name: actor.name, role: actor.role, at: new Date().toISOString() } });
        });
});

router.put('/api/admin/team/:id', requireAdmin, (req, res) => {
    const { name, role, biography, email, phone, website, twitter, linkedin, instagram, behance, fallback_url, clear_image, status, featured, display_order } = req.body;
    const teamId = req.params.id;
    db.get("SELECT * FROM team_members WHERE id = ?", [teamId], (selErr, existing) => {
        if (selErr) return res.status(500).json({ error: selErr.message });
        if (!existing) return res.status(404).json({ success: false, message: 'Team member not found' });

        const newName = name !== undefined ? name : existing.name;
        if (!newName) return res.status(400).json({ success: false, message: 'Name is required.' });
        let newImagePath = existing.image_path;
        if (clear_image === true || clear_image === 'true') newImagePath = null;
        else if (fallback_url) newImagePath = fallback_url;

        const newValues = {
            name: newName,
            role: role !== undefined ? (role || null) : existing.role,
            biography: biography !== undefined ? (biography || null) : existing.biography,
            image_path: newImagePath,
            email: email !== undefined ? (email || null) : existing.email,
            phone: phone !== undefined ? (phone || null) : existing.phone,
            website: website !== undefined ? (website || null) : existing.website,
            twitter: twitter !== undefined ? (twitter || null) : existing.twitter,
            linkedin: linkedin !== undefined ? (linkedin || null) : existing.linkedin,
            instagram: instagram !== undefined ? (instagram || null) : existing.instagram,
            behance: behance !== undefined ? (behance || null) : existing.behance,
            status: status !== undefined ? status : existing.status,
            featured: featured !== undefined ? ((featured === true || featured === 'true') ? 1 : 0) : existing.featured,
            display_order: display_order !== undefined ? display_order : existing.display_order
        };

        db.run(`UPDATE team_members SET name=?, role=?, biography=?, image_path=?, email=?, phone=?, website=?, twitter=?, linkedin=?, instagram=?, behance=?, status=?, featured=?, display_order=?, updated_by=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`,
            [newValues.name, newValues.role, newValues.biography, newValues.image_path, newValues.email, newValues.phone, newValues.website,
             newValues.twitter, newValues.linkedin, newValues.instagram, newValues.behance, newValues.status, newValues.featured, newValues.display_order,
             req.session.adminId, teamId],
            async function (err) {
                if (err) return res.status(500).json({ error: err.message });
                logAudit({ tableName: 'team_members', recordId: teamId, action: 'update', req, oldValues: existing, newValues }).catch(e => console.error('logAudit failed:', e));
                const actor = await resolveActor(req.session.adminId);
                res.json({ success: true, last_updated: { name: actor.name, role: actor.role, at: new Date().toISOString() } });
            });
    });
});

router.delete('/api/admin/team/:id', requireAdmin, requireRole(['administrator']), (req, res) => {
    db.get("SELECT * FROM team_members WHERE id = ?", [req.params.id], (selErr, existing) => {
        db.run("DELETE FROM team_members WHERE id = ?", req.params.id, function(err) {
            if (err) return res.status(500).json({ error: err.message });
            logAudit({ tableName: 'team_members', recordId: req.params.id, action: 'delete', req, oldValues: existing || null, newValues: null }).catch(e => console.error('logAudit failed:', e));
            res.json({ success: true });
        });
    });
});

module.exports = router;
