const express = require('express');
const db = require('../../database');
const { requireAdmin } = require('../../middleware/auth');
const { requireRole } = require('../../middleware/rbac');
const { getAllBookingsForMigration, updateBookingClientVenue } = require('../../database/repositories/bookings.repository');
const { upsertSetting } = require('../../database/repositories/settings.repository');
const { findOrCreateClient, findOrCreateVenueFromPlace } = require('../../lib/client-venue');
const { unescapeHtml, sanitizeAboutHtml, SECTION_KEYS } = require('../../lib/html-sanitize');
const { resolveActor } = require('../../lib/actor');
const { logAudit } = require('../../lib/audit-log');
const router = express.Router();

router.post('/api/admin/migrate', requireAdmin, async (req, res) => {
    try {
        getAllBookingsForMigration((err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!rows || rows.length === 0) return res.json({ success: true, message: 'No records to migrate.' });

            let clientsMigrated = 0;
            let venuesMigrated = 0;

            const processRow = (index) => {
                if (index >= rows.length) {
                    return res.json({ success: true, clientsMigrated, venuesMigrated, message: 'Migration complete.' });
                }
                const row = rows[index];
                
                findOrCreateClient(row.name, row.email, row.cell, row.company)
                    .then(clientId => {
                        clientsMigrated++;
                        findOrCreateVenueFromPlace(row.event_location, row.venue_address)
                            .then(venueId => {
                                venuesMigrated++;
                                // Update bookings table with new foreign keys
                                updateBookingClientVenue(clientId, venueId, row.id, () => {
                                    processRow(index + 1);
                                });
                            });
                    }).catch(e => {
                        console.error('Migration error on row', row.id, e);
                        processRow(index + 1);
                    });
            };
            processRow(0); // Start processing sequentially
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ─── Branding ───────────────────────────────────────────────────────────────
router.put('/api/admin/branding', requireAdmin, requireRole(['administrator']), (req, res) => {
    const { settings } = req.body;
    if (!settings || typeof settings !== 'object')
        return res.status(400).json({ error: 'settings object required.' });
    const envMap = { email_banner: 'EMAIL_BANNER' };
    const keys = Object.keys(settings);
    let pending = keys.length;
    if (pending === 0) return res.json({ success: true });
    let failed = false;
    keys.forEach(key => {
        const val = String(settings[key]);
        if (envMap[key]) process.env[envMap[key]] = val;
        upsertSetting(key, val, (err) => {
                if (err && !failed) { failed = true; console.error('save branding failed:', err); return res.status(500).json({ success: false, message: 'Could not save branding. Please try again.' }); }
                if (--pending === 0 && !failed) res.json({ success: true });
            }
        );
    });
});

// --- Venues list for admin dropdowns ---
router.get('/api/admin/venues', requireAdmin, (req, res) => {
    db.all(`SELECT v.id, v.name, v.city, v.state, v.address, v.capacity,
                   v.contact_name, v.contact_phone, v.green_room_notes,
                   (SELECT COUNT(*) FROM bookings b WHERE b.venue_id = v.id) AS booking_count
            FROM venues v ORDER BY v.name`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// Admin: list reviews
router.get('/api/admin/reviews', requireAdmin, (req, res) => {
    db.all(
        `SELECT r.*, b.event_name, b.event_type, b.date AS event_date
         FROM service_reviews r
         JOIN bookings b ON r.booking_id = b.id
         ORDER BY r.submitted_at DESC`,
        [],
        (err, rows) => err ? res.status(500).json({ error: err.message }) : res.json(rows)
    );
});

router.put('/api/admin/manager', requireAdmin, (req, res) => {
    const { name, cell_number, whatsapp_number, email, whatsapp_link } = req.body;
    const adminId = req.session.adminId;

    // Server-side validation (D3) — never trust the client. Phone *format* stays client-side (intl-tel-input).
    if (!name || !String(name).trim() || !email || !String(email).trim() ||
        !cell_number || !String(cell_number).trim() || !whatsapp_number || !String(whatsapp_number).trim()) {
        return res.status(400).json({ success: false, message: 'Name, email, cell number, and WhatsApp number are all required.' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email).trim())) {
        return res.status(400).json({ success: false, message: 'Enter a valid manager email address.' });
    }

    const cleanLink = whatsapp_link ? String(whatsapp_link).trim() : null;

    db.get("SELECT manager_id FROM manager_details ORDER BY manager_id ASC LIMIT 1", [], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        
        if (row) {
            db.run(`UPDATE manager_details
                    SET name = ?, cell_number = ?, whatsapp_number = ?, email = ?, whatsapp_link = ?, modified_on = CURRENT_TIMESTAMP, modified_by = ?
                    WHERE manager_id = ?`,
                [name, cell_number, whatsapp_number, email, cleanLink, adminId, row.manager_id], async function(err) {
                if (err) return res.status(500).json({ error: err.message });
                const actor = await resolveActor(adminId);
                res.json({ success: true, message: 'Manager details updated successfully.', last_updated: { name: actor.name, role: actor.role, at: new Date().toISOString() } });
            });
        } else {
            db.run(`INSERT INTO manager_details (name, cell_number, whatsapp_number, email, whatsapp_link, created_by)
                    VALUES (?, ?, ?, ?, ?, ?)`,
                [name, cell_number, whatsapp_number, email, cleanLink, adminId], async function(err) {
                if (err) return res.status(500).json({ error: err.message });
                const actor = await resolveActor(adminId);
                res.json({ success: true, message: 'Manager details created successfully.', last_updated: { name: actor.name, role: actor.role, at: new Date().toISOString() } });
            });
        }
    });
});

router.delete('/api/admin/manager', requireAdmin, requireRole(['administrator']), (req, res) => {
    db.run("DELETE FROM manager_details", [], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, message: 'Manager details cleared successfully.' });
    });
});

router.post('/api/admin/contact_info', requireAdmin, (req, res) => {
    // Note: The frontend sends { data: { email, quote, sig } }
    const { email, quote, sig: signature } = req.body.data || {};
    const adminId = req.session.adminId;

    if (!email || !quote || !signature) {
        return res.status(400).json({ success: false, message: 'Missing required contact info fields.' });
    }

    db.get("SELECT quote_id FROM contact_info ORDER BY quote_id ASC LIMIT 1", [], (err, row) => {
        if (err) {
            console.error("[DEBUG] DB GET Error:", err);
            return res.status(500).json({ error: err.message });
        }
        
        if (row) {
            db.run(`UPDATE contact_info
                    SET email = ?, quote = ?, signature = ?, modified_on = CURRENT_TIMESTAMP, modified_by = ?
                    WHERE quote_id = ?`,
                [email, quote, signature, adminId, row.quote_id], async function(err) {
                if (err) {
                     console.error("[DEBUG] UPDATE Error:", err);
                     return res.status(500).json({ error: err.message });
                }
                const actor = await resolveActor(adminId);
                res.json({ success: true, message: 'Contact info updated successfully.', last_updated: { name: actor.name, role: actor.role, at: new Date().toISOString() } });
            });
        } else {
            db.run(`INSERT INTO contact_info (email, quote, signature, created_by)
                    VALUES (?, ?, ?, ?)`,
                [email, quote, signature, adminId], async function(err) {
                if (err) return res.status(500).json({ error: err.message });
                const actor = await resolveActor(adminId);
                res.json({ success: true, message: 'Contact info created successfully.', last_updated: { name: actor.name, role: actor.role, at: new Date().toISOString() } });
            });
        }
    });
});

router.get('/api/admin/about-me', requireAdmin, (req, res) => {
    db.get("SELECT * FROM about_me WHERE id = 1", (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (row) {
            row.paragraph1 = unescapeHtml(row.paragraph1);
            row.paragraph2 = unescapeHtml(row.paragraph2);
            row.paragraph3 = unescapeHtml(row.paragraph3);
        }
        res.json(row || null);
    });
});

router.post('/api/admin/about-me', requireAdmin, (req, res) => {
    const { image_path, paragraph1, paragraph2, paragraph3 } = req.body;
    const username = req.session.username || String(req.session.adminId || 'admin');
    const p1 = sanitizeAboutHtml(paragraph1);
    const p2 = sanitizeAboutHtml(paragraph2);
    const p3 = sanitizeAboutHtml(paragraph3);
    const imgPath = image_path || '';

    db.get("SELECT * FROM about_me WHERE id = 1", (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        const newValues = { image_path: imgPath, paragraph1: p1, paragraph2: p2, paragraph3: p3 };
        if (row) {
            db.run(
                `UPDATE about_me SET image_path=?, paragraph1=?, paragraph2=?, paragraph3=?, updated_at=CURRENT_TIMESTAMP, updated_by=? WHERE id=1`,
                [imgPath, p1, p2, p3, username],
                (e) => {
                    if (e) return res.status(500).json({ error: e.message });
                    logAudit({ tableName: 'about_me', recordId: 1, action: 'update', req, oldValues: row, newValues }).catch(err2 => console.error('logAudit failed:', err2));
                    res.json({ success: true, message: 'About Me content updated.' });
                }
            );
        } else {
            db.run(
                `INSERT INTO about_me (id, image_path, paragraph1, paragraph2, paragraph3, created_by, updated_by) VALUES (1,?,?,?,?,?,?)`,
                [imgPath, p1, p2, p3, username, username],
                (e) => {
                    if (e) return res.status(500).json({ error: e.message });
                    logAudit({ tableName: 'about_me', recordId: 1, action: 'create', req, oldValues: null, newValues }).catch(err2 => console.error('logAudit failed:', err2));
                    res.json({ success: true, message: 'About Me content saved.' });
                }
            );
        }
    });
});

router.put('/api/admin/site-content', requireAdmin, (req, res) => {
    const b = req.body || {};
    const updates = {};
    if (typeof b.announcement_text === 'string') updates.announcement_text = sanitizeAboutHtml(b.announcement_text).slice(0, 300);
    if (typeof b.announcement_enabled !== 'undefined') updates.announcement_enabled = b.announcement_enabled ? '1' : '0';
    if (typeof b.announcement_rotate !== 'undefined') updates.announcement_rotate = b.announcement_rotate ? '1' : '0';
    if (b.section_visibility && typeof b.section_visibility === 'object') {
        // Whitelist keys + coerce to booleans so only known sections are ever stored.
        const clean = {};
        SECTION_KEYS.forEach(k => { if (k in b.section_visibility) clean[k] = !!b.section_visibility[k]; });
        updates.section_visibility = JSON.stringify(clean);
    }
    if (typeof b.hero_subtitle === 'string') updates.hero_subtitle = sanitizeAboutHtml(b.hero_subtitle).slice(0, 1500);
    if (typeof b.services_eyebrow === 'string') updates.services_eyebrow = b.services_eyebrow.replace(/<[^>]*>/g, '').slice(0, 120);
    if (typeof b.services_heading === 'string') updates.services_heading = sanitizeAboutHtml(b.services_heading).slice(0, 300);
    if (Array.isArray(b.services_items)) {
        const clean = b.services_items.slice(0, 12).map(it => ({
            title: String((it && it.title) || '').replace(/<[^>]*>/g, '').slice(0, 120),
            description: String((it && it.description) || '').replace(/<[^>]*>/g, '').slice(0, 300),
            image: String((it && it.image) || '').slice(0, 500)
        }));
        updates.services_items = JSON.stringify(clean);
    }
    if (typeof b.hero_tagline === 'string') updates.hero_tagline = b.hero_tagline.replace(/<[^>]*>/g, '').slice(0, 160);
    if (Array.isArray(b.features_items)) {
        const cf = b.features_items.slice(0, 12).map(it => ({
            title: String((it && it.title) || '').replace(/<[^>]*>/g, '').slice(0, 60),
            description: String((it && it.description) || '').replace(/<[^>]*>/g, '').slice(0, 120)
        }));
        updates.features_items = JSON.stringify(cf);
    }
    const keys = Object.keys(updates);
    if (!keys.length) return res.json({ success: true });
    let pending = keys.length, failed = false;
    keys.forEach(key => {
        upsertSetting(key, updates[key], (err) => {
                if (err && !failed) { failed = true; console.error('save site-content failed:', err); return res.status(500).json({ success: false, message: 'Could not save homepage content. Please try again.' }); }
                if (--pending === 0 && !failed) res.json({ success: true, message: 'Homepage content updated.' });
            });
    });
});

module.exports = router;
