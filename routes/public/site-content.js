const express = require('express');
const path = require('path');
const multer = require('multer');
const db = require('../../database');
const { ipRateLimiter } = require('../../middleware/rate-limiters');
const { uploadsWriteDir } = require('../../lib/runtime-paths');
const objectStorage = require('../../lib/object-storage');
const { safeUploadFilename } = require('../../lib/uploads');
const { unescapeHtml } = require('../../lib/html-sanitize');
const homepageContent = require('../../lib/homepage-content');
const { listPublicMembers } = require('../../lib/team');
const { listPublicAccolades } = require('../../lib/accolades');
const { listPublicFaqs } = require('../../lib/faq');
const { getSettingsByKeys } = require('../../database/repositories/settings.repository');
const { PUBLIC_SERVICE_COLUMNS, publicServiceList } = require('../../lib/service-pricing');
const ticketing = require('../../lib/ticketing');
const ticketingCore = require('../../lib/ticketing-core');
const { emailBaseUrl } = require('../../lib/email-context');
const { enrichEmbeds } = require('../../lib/social-stats');
const router = express.Router();

// Uses its own fixed-destination storage (not the shared `storage` in app.js, which picks a folder
// from req.body.section) because this route only ever handles testimonial photos and the public
// submission form has no reason to send a `section` field — relying on it silently misfiled
// uploads into images/ instead of images/testimonials/ while the DB kept the intended path.
const publicImageUploadStorage = objectStorage.multerStorage({
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
// Read through lib/homepage-content.js, which the server-side homepage fill (lib/homepage-render.js) uses too.

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
// NO PRICES: a client first sees an amount in the quotation. The payload is an allowlist (lib/service-pricing.js
// PUBLIC_SERVICE_COLUMNS) in rate-card order with the group label, so the booking drawer can show the services
// grouped as on the rate card with "Most Booked" on Corporate & Events - and never learns what anything costs.
router.get('/api/public/services', (req, res) => {
    db.all(`SELECT ${PUBLIC_SERVICE_COLUMNS.join(', ')}
            FROM services
            WHERE COALESCE(is_active, 1) = 1
              AND COALESCE(is_deleted, 0) = 0
              AND (valid_from IS NULL OR valid_from <= date('now'))
              AND (valid_to   IS NULL OR valid_to   >= date('now'))`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(publicServiceList(rows));
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
    // venue_city / venue_province: the town and province of the venue picked in the admin's venue search (venues row) for the
    // card's location line. Only those two columns - a venues row also holds private contacts, notes and negotiated rates.
    db.all(
        `SELECT e.*, v.city AS venue_city, v.state AS venue_province FROM events e
         LEFT JOIN bookings b ON b.id = e.booking_id
         LEFT JOIN venues v ON v.id = e.venue_id
         WHERE e.event_status NOT IN ('cancelled', 'draft')
           AND (e.booking_id IS NULL OR b.is_public = 1)
         ORDER BY e.event_datetime ASC LIMIT ? OFFSET ?`,
        [limit, offset], async (err, siteEvents) => {
        if (err) return res.status(500).json({ error: err.message });
        // Event ticketing (lib/ticketing.js): an event with ticket types gets `ticketing` = { state, from_cents, opens_at } so its card
        // shows Get Tickets / Sold Out / Sales Closed. Events without tiers get null and keep their ticket_sales_link exactly as before.
        // A failure here must never take the events list down - the cards just fall back to the old behaviour.
        const summaries = await ticketing.summariesForEvents(siteEvents || []).catch(e => { console.error('[Ticketing] event summaries failed:', e.message); return {}; });
        const mapped = (siteEvents || []).map(e => ({...e, source: 'event', ticketing: summaries[e.event_id] || null}));
        res.json(mapped);
    });
});

// --- Share link for one show: /e/<event_id> (the Share buttons, js/event-share.js) ---
// WhatsApp / Facebook / X read the Open Graph tags here to show the poster, title and date in the chat; people are sent straight on to
// /?event=<id>, where the homepage opens that show's Get Tickets drawer (or its details pop-up). Same visibility rule as the list above:
// a draft, cancelled or private-booking event is not shareable and the link just opens the homepage.
const shareEsc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
router.get('/e/:id', async (req, res) => {
    const id = /^\d{1,9}$/.test(req.params.id) ? Number(req.params.id) : null;
    const ev = id && await new Promise((resolve) => db.get(
        `SELECT e.* FROM events e LEFT JOIN bookings b ON b.id = e.booking_id
         WHERE e.event_id = ? AND e.event_status NOT IN ('cancelled', 'draft') AND (e.booking_id IS NULL OR b.is_public = 1)`,
        [id], (err, row) => resolve(err ? null : row)));
    if (!ev) return res.redirect(302, '/#events');
    const base = emailBaseUrl();
    const title = unescapeHtml(ev.event_title || 'Live show');
    const start = ticketingCore.eventStart(ev);
    const summary = (await ticketing.summariesForEvents([ev]).catch(() => ({})))[ev.event_id];
    const description = [start ? ticketingCore.formatSast(start) : '', unescapeHtml(ev.venue_name || ''), summary && summary.state === 'on_sale' ? 'Tickets on sale now' : '']
        .filter(Boolean).join(' · ');
    let image = `${base}/images/image-slider-1.jpg`;
    try { if (ev.poster_image_path) image = new URL(unescapeHtml(ev.poster_image_path), base + '/').href; } catch (e) { /* keep the default */ }
    const shareUrl = `${base}/e/${ev.event_id}`;
    const target = `/?event=${ev.event_id}`;
    res.set('Cache-Control', 'public, max-age=300');
    res.type('html').send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, follow">
<title>${shareEsc(title)} · Thabiso Mhlongo</title>
<meta name="description" content="${shareEsc(description)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Thabiso Mhlongo">
<meta property="og:title" content="${shareEsc(title)}">
<meta property="og:description" content="${shareEsc(description)}">
<meta property="og:image" content="${shareEsc(image)}">
<meta property="og:image:alt" content="Poster for ${shareEsc(title)}">
<meta property="og:url" content="${shareEsc(shareUrl)}">
<meta name="twitter:card" content="summary_large_image">
<link rel="canonical" href="${shareEsc(base + target)}">
<meta http-equiv="refresh" content="0; url=${shareEsc(target)}">
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0a0a0a;color:#eee;font:16px/1.5 system-ui,sans-serif}a{color:#d4a017}</style>
</head>
<body><p><a href="${shareEsc(target)}">Open ${shareEsc(title)}</a></p></body>
</html>`);
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

// --- Management Team (active members only) ---
// Visibility, ordering and the published field list all come from lib/team.js, the same module the
// admin API uses — so the public site and the admin portal cannot disagree. Revalidated on every
// request (ETag, no max-age) so an admin edit shows up on the next page load.
router.get('/api/public/team', async (req, res) => { // Public route for index.html
    try {
        res.set('Cache-Control', 'no-cache');
        res.json(await listPublicMembers());
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- Accolades & Recognition (published only) ---
// Same single-source design as the team route above: lib/accolades.js decides visibility, order and
// the published field list for this route AND GET /api/admin/accolades. Revalidated on every load,
// so publishing / unpublishing in the admin shows on the next page view.
router.get('/api/public/accolades', async (req, res) => { // Public route for index.html
    try {
        res.set('Cache-Control', 'no-cache');
        res.json(await listPublicAccolades());
    } catch (err) {
        console.error('[Accolades] public list failed:', err.message);
        res.status(500).json({ success: false, message: 'Could not load accolades.' });
    }
});

// --- FAQ (published only) --- lib/faq.js decides visibility, order and the published fields for this route AND GET /api/admin/faqs.
router.get('/api/public/faqs', async (req, res) => {
    try {
        res.set('Cache-Control', 'no-cache');
        res.json(await listPublicFaqs());
    } catch (err) {
        console.error('[FAQ] public list failed:', err.message);
        res.status(500).json({ success: false, message: 'Could not load the FAQ.' });
    }
});

// Phase 5 (HOUSEKEEPING-NOTES.md): the email-templates admin routes (and SYSTEM_TRACK_TEMPLATE_KEYS)
// moved to routes/admin/email-templates.js.












// --- Manager Details ---
router.get('/api/public/manager', (req, res) => {
    homepageContent.getManager().then((row) => res.json(row), (err) => res.status(500).json({ error: err.message }));
});

// --- Contact Info ---
router.get('/api/public/contact_info', (req, res) => {
    homepageContent.getContactInfo().then((row) => res.json(row), (err) => res.status(500).json({ error: err.message }));
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
    homepageContent.getAboutMe().then((row) => res.json(row), (err) => res.status(500).json({ error: err.message }));
});

router.get('/api/public/social_embeds', (req, res) => {
    db.all("SELECT * FROM social_embeds WHERE is_active = 1 ORDER BY display_order ASC", [], async (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        // Real upload date / channel / views are filled in server-side (lib/social-stats.js). The stored API key is the admin's, never the public's.
        const enriched = await enrichEmbeds(rows).catch(() => rows);
        res.json(enriched.map(({ platform_api_key, ...pub }) => pub));
    });
});

// SECTION_KEYS moved to lib/html-sanitize.js (imported near the top of this file already).

router.get('/api/public/site-content', (req, res) => {
    homepageContent.getSiteContent().then((data) => res.json(data), (err) => res.status(500).json({ success: false, error: err.message }));
});

// Standalone /privacy and /terms pages (text comes from the homepage pop-ups).
router.use(require('./legal-pages'));

module.exports = router;
