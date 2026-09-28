// Management Team admin CRUD — mirrors the gallery_images route shape in routes/admin/content.js
// (same requireAdmin/requireRole split, logAudit + resolveActor last_updated pattern).
const express = require('express');
const db = require('../../database');
const { requireAdmin } = require('../../middleware/auth');
const { requireRole } = require('../../middleware/rbac');
const { upload } = require('../../lib/uploads');
const { logAudit } = require('../../lib/audit-log');
const { resolveActor } = require('../../lib/actor');
const { getAdminTeamView, validateTeamInput, cleanText } = require('../../lib/team');
const router = express.Router();

// Admin: every status (active + inactive), so hidden members can still be managed — in the SAME
// order the website uses, each annotated with what the website does with it (is_public,
// public_position) plus whether the whole section is switched on. Built by lib/team.js, which the
// public API also uses, so the two views cannot drift apart.
router.get('/api/admin/team', requireAdmin, async (req, res) => {
    try {
        res.set('Cache-Control', 'no-store');
        res.json(await getAdminTeamView());
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
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
    const cleanName = typeof name === 'string' ? name.trim() : '';
    if (!cleanName) return res.status(400).json({ success: false, message: 'Name is required.' });
    const invalid = validateTeamInput({ status: status || undefined, biography, website, twitter, linkedin, instagram, behance });
    if (invalid) return res.status(400).json({ success: false, message: invalid });
    const imagePath = req.file ? `images/team/${req.file.filename}` : (fallback_url || null);
    const newValues = {
        name: cleanName, role: cleanText(role), biography: cleanText(biography), image_path: imagePath,
        email: cleanText(email), phone: cleanText(phone), website: cleanText(website),
        twitter: cleanText(twitter), linkedin: cleanText(linkedin), instagram: cleanText(instagram), behance: cleanText(behance),
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

        const newName = name !== undefined ? (typeof name === 'string' ? name.trim() : '') : existing.name;
        if (!newName) return res.status(400).json({ success: false, message: 'Name is required.' });
        const invalid = validateTeamInput({ status, biography, website, twitter, linkedin, instagram, behance });
        if (invalid) return res.status(400).json({ success: false, message: invalid });
        if (display_order !== undefined && !Number.isInteger(Number(display_order))) {
            return res.status(400).json({ success: false, message: 'Display order must be a whole number.' });
        }
        let newImagePath = existing.image_path;
        if (clear_image === true || clear_image === 'true') newImagePath = null;
        else if (fallback_url) newImagePath = fallback_url;

        const newValues = {
            name: newName,
            role: role !== undefined ? cleanText(role) : existing.role,
            biography: biography !== undefined ? cleanText(biography) : existing.biography,
            image_path: newImagePath,
            email: email !== undefined ? cleanText(email) : existing.email,
            phone: phone !== undefined ? cleanText(phone) : existing.phone,
            website: website !== undefined ? cleanText(website) : existing.website,
            twitter: twitter !== undefined ? cleanText(twitter) : existing.twitter,
            linkedin: linkedin !== undefined ? cleanText(linkedin) : existing.linkedin,
            instagram: instagram !== undefined ? cleanText(instagram) : existing.instagram,
            behance: behance !== undefined ? cleanText(behance) : existing.behance,
            status: status !== undefined ? status : existing.status,
            featured: featured !== undefined ? ((featured === true || featured === 'true') ? 1 : 0) : existing.featured,
            display_order: display_order !== undefined ? Number(display_order) : existing.display_order
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
