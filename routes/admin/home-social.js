const express = require('express');
const fs = require('fs');
const path = require('path');
const db = require('../../database');
const { requireAdmin } = require('../../middleware/auth');
const { requireRole } = require('../../middleware/rbac');
const { logAudit } = require('../../lib/audit-log');
const { PROJECT_ROOT } = require('../../lib/runtime-paths');
const router = express.Router();

router.get('/api/admin/home-slider', requireAdmin, (req, res) => {
    db.all("SELECT * FROM home_slider ORDER BY display_order ASC", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

router.post('/api/admin/home-slider', requireAdmin, (req, res) => {
    const { url, alt, file_name, file_size } = req.body;
    if (!url) return res.status(400).json({ success: false, message: 'URL is required' });
    const uploader_name = req.session.username || 'admin';
    db.run("INSERT INTO home_slider (url, alt, file_name, file_size, uploader_name, display_order) VALUES (?, ?, ?, ?, ?, (SELECT IFNULL(MAX(display_order), 0) + 1 FROM home_slider))",
        [url, alt || null, file_name || null, file_size || null, uploader_name], function(err) {
            if (err) return res.status(500).json({ success: false, error: err.message });
            const newId = this.lastID;
            logAudit({ tableName: 'home_slider', recordId: newId, action: 'create', req, oldValues: null, newValues: { url, alt, file_name, file_size } }).catch(e => console.error('logAudit failed:', e));
            res.json({ success: true, id: newId });
        });
});

router.delete('/api/admin/home-slider/:id', requireAdmin, requireRole(['administrator']), (req, res) => {
    db.get("SELECT * FROM home_slider WHERE id = ?", [req.params.id], (selErr, existing) => {
        db.run("DELETE FROM home_slider WHERE id = ?", [req.params.id], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            logAudit({ tableName: 'home_slider', recordId: req.params.id, action: 'delete', req, oldValues: existing || null, newValues: null }).catch(e => console.error('logAudit failed:', e));
            res.json({ success: true });
        });
    });
});

router.put('/api/admin/home-slider/reorder', requireAdmin, (req, res) => {
    const { order } = req.body; // Array of IDs in new order
    db.serialize(() => {
        const stmt = db.prepare("UPDATE home_slider SET display_order = ? WHERE id = ?");
        order.forEach((id, index) => {
            stmt.run(index, id);
        });
        stmt.finalize((err) => {
            if (err) return res.status(500).json({ error: err.message });
            // One summary row rather than one per slide — this is a bulk reorder, not a single
            // record's change, so it's not tied to any one slide's Change History card, only
            // the global Audit Trail (record_id 0 has no matching individual record).
            logAudit({ tableName: 'home_slider', recordId: 0, action: 'reorder', req, oldValues: null, newValues: { order } }).catch(e => console.error('logAudit failed:', e));
            res.json({ success: true });
        });
    });
});

// NB: registered AFTER /home-slider/reorder so "reorder" is not captured as :id.
router.put('/api/admin/home-slider/:id', requireAdmin, (req, res) => {
    const { alt, url, file_name } = req.body;
    db.get("SELECT * FROM home_slider WHERE id = ?", [req.params.id], (selErr, existing) => {
        const done = function(err) {
            if (err) return res.status(500).json({ success: false, error: err.message });
            logAudit({ tableName: 'home_slider', recordId: req.params.id, action: 'update', req, oldValues: existing || null, newValues: { alt, url: url || (existing && existing.url), file_name: file_name || (existing && existing.file_name) } }).catch(e => console.error('logAudit failed:', e));
            res.json({ success: true });
        };
        if (url) {
            // A new image URL was supplied — update url/file_name + alt.
            db.run("UPDATE home_slider SET alt = ?, url = ?, file_name = ? WHERE id = ?",
                [alt || null, url, file_name || null, req.params.id], done);
        } else {
            // Alt-text-only edit — leave the image untouched.
            db.run("UPDATE home_slider SET alt = ? WHERE id = ?",
                [alt || null, req.params.id], done);
        }
    });
});

router.get('/api/admin/social_links', requireAdmin, (req, res) => {
    db.all("SELECT * FROM social_links ORDER BY display_order ASC", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

router.post('/api/admin/social_links', requireAdmin, (req, res) => {
    const { id, platform_name, platform_url, icon_class, display_order, is_active } = req.body;
    const adminId = req.session.adminId;
    const ip = req.ip;
    const ua = req.headers['user-agent'] || '';
    const path = req.originalUrl;
    
    if (!platform_name || !platform_url) return res.status(400).json({ success: false, message: 'Platform name and URL are required.' });

    if (id) {
        db.run(`UPDATE social_links 
                SET platform_name = ?, platform_url = ?, icon_class = ?, display_order = ?, is_active = ?, modified_at = CURRENT_TIMESTAMP, modified_by = ?, ip_address = ?, user_agent = ?, routing_path = ?
                WHERE id = ?`, 
            [platform_name, platform_url, icon_class, display_order || 0, is_active !== false ? 1 : 0, adminId, ip, ua, path, id], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, message: 'Social link updated successfully.', id: id });
        });
    } else {
        db.run(`INSERT INTO social_links (platform_name, platform_url, icon_class, display_order, is_active, created_by, ip_address, user_agent, routing_path) 
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, 
            [platform_name, platform_url, icon_class, display_order || 0, is_active !== false ? 1 : 0, adminId, ip, ua, path], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, message: 'Social link added successfully.', id: this.lastID });
        });
    }
});

router.delete('/api/admin/social_links/:id', requireAdmin, requireRole(['administrator']), (req, res) => {
    db.run("DELETE FROM social_links WHERE id = ?", [req.params.id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, message: 'Social link deleted successfully.' });
    });
});

router.get('/api/admin/social_embeds', requireAdmin, (req, res) => {
    db.all("SELECT * FROM social_embeds ORDER BY display_order ASC", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

router.post('/api/admin/social_embeds', requireAdmin, (req, res) => {
    const { id, platform_name, embed_code, platform_api_key, metadata, display_order, is_active } = req.body;
    const adminId = req.session.adminId;
    const ip = req.ip;
    const ua = req.headers['user-agent'] || '';
    const path = req.originalUrl;
    
    // Store metadata as JSON string if it's an object
    const metaString = (metadata && typeof metadata === 'object') ? JSON.stringify(metadata) : metadata;

    if (!platform_name || !embed_code) return res.status(400).json({ success: false, message: 'Platform name and embed code are required.' });

    if (id) {
        db.run(`UPDATE social_embeds 
                SET platform_name = ?, embed_code = ?, platform_api_key = ?, metadata = ?, display_order = ?, is_active = ?, modified_at = CURRENT_TIMESTAMP, modified_by = ?, ip_address = ?, user_agent = ?, routing_path = ?
                WHERE id = ?`, 
            [platform_name, embed_code, platform_api_key || '', metaString || '', display_order || 0, is_active !== false ? 1 : 0, adminId, ip, ua, path, id], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, message: 'Social embed updated successfully.', id: id });
        });
    } else {
        db.run(`INSERT INTO social_embeds (platform_name, embed_code, platform_api_key, metadata, display_order, is_active, created_by, ip_address, user_agent, routing_path) 
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, 
            [platform_name, embed_code, platform_api_key || '', metaString || '', display_order || 0, is_active !== false ? 1 : 0, adminId, ip, ua, path], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, message: 'Social embed added successfully.', id: this.lastID });
        });
    }
});

router.delete('/api/admin/social_embeds/:id', requireAdmin, requireRole(['administrator']), (req, res) => {
    db.run("DELETE FROM social_embeds WHERE id = ?", [req.params.id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, message: 'Social embed deleted successfully.' });
    });
});

router.post('/api/admin/publish-home-slider', requireAdmin, (req, res) => {
    db.all("SELECT url, alt FROM home_slider ORDER BY display_order ASC", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });

        try {
            // Phase 5 (HOUSEKEEPING-NOTES.md): __dirname here now resolves relative to this file's
            // own directory (routes/admin/), not the project root as it did in app.js — same
            // __dirname-relative-path hazard caught in earlier route moves. Fixed via PROJECT_ROOT
            // (lib/runtime-paths.js) rather than a bare __dirname, no other logic changed.
            const indexPath = path.join(PROJECT_ROOT, 'index.html');
            let content = fs.readFileSync(indexPath, 'utf8');

            // Find the carousel-inner section
            // <div class="carousel-inner"> ... </div>
            const regex = /(<div class="carousel-inner">)([\s\S]*?)(<\/div>)/;
            
            let sliderHtml = '\n';
            rows.forEach((row, index) => {
                const isActive = index === 0 ? ' active' : '';
                sliderHtml += `                <div class="item${isActive}"><img src="${row.url}" alt="${row.alt || ''}"></div>\n`;
            });
            sliderHtml += '            ';

            content = content.replace(regex, `$1${sliderHtml}$3`);

            // Also update indicators
            // <ol class="carousel-indicators"> ... </ol>
            const indicatorRegex = /(<ol class="carousel-indicators">)([\s\S]*?)(<\/ol>)/;
            let indicatorHtml = '\n';
            rows.forEach((_, index) => {
                const isActive = index === 0 ? ' class="active"' : '';
                indicatorHtml += `                <li data-target="#featured" data-slide-to="${index}"${isActive}></li>\n`;
            });
            indicatorHtml += '            ';

            content = content.replace(indicatorRegex, `$1${indicatorHtml}$3`);

            fs.writeFileSync(indexPath, content, 'utf8');
            res.json({ success: true, message: 'Homepage slider updated successfully' });
        } catch (e) {
            console.error("Publish error:", e);
            res.status(500).json({ error: 'Failed to update index.html' });
        }
    });
});

module.exports = router;
