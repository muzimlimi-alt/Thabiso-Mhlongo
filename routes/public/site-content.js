const express = require('express');
const path = require('path');
const multer = require('multer');
const db = require('../../database');
const { ipRateLimiter } = require('../../middleware/rate-limiters');
const { uploadsWriteDir } = require('../../lib/runtime-paths');
const { safeUploadFilename } = require('../../lib/uploads');
const { unescapeHtml, SECTION_KEYS } = require('../../lib/html-sanitize');
const { getSettingsByKeys } = require('../../database/repositories/settings.repository');
const router = express.Router();

// Uses its own fixed-destination storage (not the shared `storage` in app.js, which picks a folder
// from req.body.section) because this route only ever handles testimonial photos and the public
// submission form has no reason to send a `section` field — relying on it silently misfiled
// uploads into images/ instead of images/testimonials/ while the DB kept the intended path.
const publicImageUploadStorage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, uploadsWriteDir('testimonials'));
    },
    filename: function (req, file, cb) {
        cb(null, safeUploadFilename(file.originalname));
    }
});
const publicImageUpload = multer({
    storage: publicImageUploadStorage,
    fileFilter: function(req, file, cb) {
        const allowed = /jpeg|jpg|png|webp/;
        const ext = path.extname(file.originalname).toLowerCase().replace('.', '');
        if (allowed.test(ext)) return cb(null, true);
        cb(new Error('Only JPG, PNG or WEBP images are allowed.'));
    },
    limits: { fileSize: 8 * 1024 * 1024 }
});

// ─── Editable homepage content: Hero paragraph + "What I Do" section ──────────
// Stored as key-value rows in `settings`. hero_subtitle + services_heading may contain simple
// admin-authored HTML (e.g. <em>) and are sanitised; eyebrow + card fields are plain text
// (rendered client-side via .text()). Values fall back to the static index.html when unset.
const SITE_CONTENT_KEYS = ['announcement_text', 'announcement_enabled', 'announcement_rotate', 'hero_tagline', 'hero_subtitle', 'services_eyebrow', 'services_heading', 'services_items', 'features_items', 'section_visibility'];

// Phase 5 (HOUSEKEEPING-NOTES.md): sendAdminPaymentNotification/sendAdminCompletionSummaryEmail
// moved to lib/booking-notifications.js — see the require near the top of this file for the
// re-import.

// Phase 5 (HOUSEKEEPING-NOTES.md): sendAdminQuoteAcceptedNotification moved directly into
// routes/public/bookings.js — single-consumer (the accept-quote route moved with it).

// Phase 5 (HOUSEKEEPING-NOTES.md): sendRefundProcessedEmail moved to lib/booking-notifications.js
// — see the require near the top of this file for the re-import.

// Phase 5 (HOUSEKEEPING-NOTES.md): sendDateChangedEmail moved to lib/booking-notifications.js —
// see the require near the top of this file for the re-import.

// ==========================================
// PUBLIC GET SERVICES
// ==========================================
router.get('/api/public/services', (req, res) => {
    db.all(`SELECT id, name, description, pricing_model, default_price,
                   COALESCE(base_price, default_price) as base_price,
                   min_quantity, max_quantity, display_unit,
                   (pricing_model = 'flat' OR pricing_model = 'flat_fee') AS is_flat,
                   setup_time_minutes, performance_length_minutes, service_type,
                   pricing_group, travel_included, availability_rule, booking_lead_time_days,
                   financial_category, revenue_gl_code, crew_required,
                   fulfillment_type, tax_category, external_note
            FROM services
            WHERE COALESCE(is_active, 1) = 1
              AND COALESCE(is_deleted, 0) = 0
              AND (valid_from IS NULL OR valid_from <= date('now'))
              AND (valid_to   IS NULL OR valid_to   >= date('now'))
            ORDER BY category, name`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// ==========================================
// Public Events Route
// ==========================================
// (Consolidated into the events module below)

// ==========================================
// Admin CRUD Routes (Protected)
// ==========================================

// Phase 5 (HOUSEKEEPING-NOTES.md): findOrCreateClient/findOrCreateVenueFromPlace moved to
// lib/client-venue.js. Neither has a remaining caller in app.js — their only call site (the admin
// manual-booking-creation route) moved to routes/admin/bookings.js, which imports both directly.













// ============================================================
// Legal & Compliance Centre — /api/admin/legal/*
// Reads use requireAdmin; writes (draft/publish/restore) require the administrator role (Gate 4).
// computeNextLegalVersion moved to routes/admin/legal.js — its only caller.
// ============================================================










// Public — cookie policy wording for the public site's cookie banner (Gate 5 live sync)
router.get('/api/public/legal/cookie-policy', (req, res) => {
    db.get(`SELECT lv.content_html, lv.version_number, lv.published_at
            FROM legal_documents ld
            JOIN legal_document_versions lv ON lv.id = ld.current_version_id
            WHERE ld.document_type = 'cookie_policy'`, [], (err, row) => {
        if (err || !row) return res.json({ success: false });
        res.json({ success: true, content_html: row.content_html, version_number: row.version_number, published_at: row.published_at });
    });
});

router.get('/api/public/branding', (req, res) => {
    const keys = ['site_logo', 'favicon', 'primary_color', 'theme_font', 'email_banner', 'login_background'];
    getSettingsByKeys(keys,
        (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            const branding = {};
            (rows || []).forEach(r => { branding[r.setting_key] = r.setting_value; });
            res.json({ success: true, branding });
        }
    );
});

// --- Public Events ---
router.get('/api/public/events', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 100, 200);
    const offset = parseInt(req.query.offset) || 0;
    // Every CONFIRMED private booking auto-creates an events row (event_status='upcoming') purely so
    // it shows on the admin calendar — those are NOT meant to be public. The only reliable signal that
    // a booking-linked event should actually be listed here is bookings.is_public=1 (set only by the
    // explicit "Promote to public" action); the status filter alone let every private client's booking
    // details (event title, venue) leak onto the public tour-dates page.
    db.all(
        `SELECT e.* FROM events e
         LEFT JOIN bookings b ON b.id = e.booking_id
         WHERE e.event_status NOT IN ('cancelled', 'draft')
           AND (e.booking_id IS NULL OR b.is_public = 1)
         ORDER BY e.event_datetime ASC LIMIT ? OFFSET ?`,
        [limit, offset], (err, siteEvents) => {
        if (err) return res.status(500).json({ error: err.message });
        const mapped = (siteEvents || []).map(e => ({...e, source: 'event'}));
        res.json(mapped);
    });
});

// --- Career Highlights ---
router.get('/api/public/highlights', (req, res) => { // Public route for index.html
    db.all("SELECT * FROM career_highlights ORDER BY display_order ASC, created_at DESC", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// --- Footprint (countries performed in) — mirrors Career Highlights' route shape exactly ---
router.get('/api/public/footprint', (req, res) => { // Public route for index.html
    db.all("SELECT * FROM footprint_countries ORDER BY display_order ASC, created_at DESC", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// --- Testimonials (visitor-submitted, admin-moderated) ---
router.get('/api/public/testimonials', (req, res) => { // Public: approved only
    db.all("SELECT * FROM testimonials WHERE status = 'approved' ORDER BY display_order ASC, created_at DESC", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// Public submission — rate-limited, restricted (non-SVG) upload, always starts pending review.
router.post('/api/public/testimonials', ipRateLimiter, publicImageUpload.single('file'), (req, res) => {
    const { name, designation, quote } = req.body;
    if (!name || !quote) {
        return res.status(400).json({ success: false, message: 'Name and testimonial text are required.' });
    }
    const imagePath = req.file ? `images/testimonials/${req.file.filename}` : null;
    db.run("INSERT INTO testimonials (name, designation, quote, image_path, status, submitted_by) VALUES (?, ?, ?, ?, 'pending', 'visitor')",
        [name, designation || null, quote, imagePath], function(err) {
        if (err) return res.status(500).json({ success: false, message: err.message });
        res.json({ success: true, message: 'Thank you! Your testimonial has been submitted for review.' });
    });
});

// --- Home Slider Routes ---
router.get('/api/public/home-slider', (req, res) => {
    db.all("SELECT * FROM home_slider ORDER BY display_order ASC", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// --- Gallery Images ---
router.get('/api/public/gallery', (req, res) => { // Public route for index.html
    db.all("SELECT * FROM gallery_images ORDER BY display_order ASC, created_at DESC", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// Phase 5 (HOUSEKEEPING-NOTES.md): the email-templates admin routes (and SYSTEM_TRACK_TEMPLATE_KEYS)
// moved to routes/admin/email-templates.js.












// --- Manager Details ---
router.get('/api/public/manager', (req, res) => {
    db.get("SELECT * FROM manager_details ORDER BY manager_id ASC LIMIT 1", [], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(row || null);
    });
});

// --- Contact Info ---
router.get('/api/public/contact_info', (req, res) => {
    db.get("SELECT * FROM contact_info ORDER BY quote_id ASC LIMIT 1", [], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(row || { email: '', quote: '', signature: '' }); // Safety fallback obj 
    });
});

// --- Social Links ---
router.get('/api/public/social_links', (req, res) => {
    db.all("SELECT * FROM social_links WHERE is_active = 1 ORDER BY display_order ASC", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// --- Social Embeds ---
// =============================================
// About Me API
// =============================================

router.get('/api/public/about-me', (req, res) => {
    db.get("SELECT image_path, paragraph1, paragraph2, paragraph3 FROM about_me WHERE id = 1", (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (row) {
            row.paragraph1 = unescapeHtml(row.paragraph1);
            row.paragraph2 = unescapeHtml(row.paragraph2);
            row.paragraph3 = unescapeHtml(row.paragraph3);
        }
        res.json(row || { image_path: 'images/image-slider-1.jpg', paragraph1: '', paragraph2: '', paragraph3: '' });
    });
});

router.get('/api/public/social_embeds', (req, res) => {
    db.all("SELECT * FROM social_embeds WHERE is_active = 1 ORDER BY display_order ASC", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// SECTION_KEYS moved to lib/html-sanitize.js (imported near the top of this file already).

router.get('/api/public/site-content', (req, res) => {
    getSettingsByKeys(SITE_CONTENT_KEYS, (err, rows) => {
        if (err) return res.status(500).json({ success: false, error: err.message });
        const map = {};
        (rows || []).forEach(r => { map[r.setting_key] = r.setting_value; });
        let items = [], features = [], sectionVis = {};
        try { items = map.services_items ? JSON.parse(map.services_items) : []; } catch (e) { items = []; }
        try { features = map.features_items ? JSON.parse(map.features_items) : []; } catch (e) { features = []; }
        try { sectionVis = map.section_visibility ? JSON.parse(map.section_visibility) : {}; } catch (e) { sectionVis = {}; }
        // Resolve to an explicit map: every known section defaults to visible unless stored false.
        const sections = {};
        SECTION_KEYS.forEach(k => { sections[k] = sectionVis[k] !== false; });
        res.json({
            success: true,
            announcement: { text: map.announcement_text || '', enabled: map.announcement_enabled !== '0', rotate: map.announcement_rotate !== '0' },
            hero_tagline: map.hero_tagline || '',
            hero_subtitle: map.hero_subtitle || '',
            services: {
                eyebrow: map.services_eyebrow || '',
                heading: map.services_heading || '',
                items: Array.isArray(items) ? items : []
            },
            features: { items: Array.isArray(features) ? features : [] },
            sections: sections
        });
    });
});

module.exports = router;
