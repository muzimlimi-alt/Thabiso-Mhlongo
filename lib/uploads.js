// Shared multer upload instance for admin (requireAdmin-gated) image uploads — Phase 5 of the
// housekeeping effort (HOUSEKEEPING-NOTES.md). Moved out of the app.js monolith byte-identical.
// Used across ~20 admin routes (gallery, testimonials, footprint, highlights, home-slider,
// branding backgrounds, etc.), all picking their destination subfolder from req.body.section.
const path = require('path');
const multer = require('multer');
const { uploadsWriteDir, docsWriteDir } = require('./runtime-paths');

// Avoids stacking a new Date.now() prefix onto a filename that already has one — matters when a
// file already stored under its prefixed name gets fed back through the same upload flow (e.g.
// re-submitting an already-uploaded image without changing it). Phase 3 item 4, HOUSEKEEPING-NOTES.md.
function safeUploadFilename(originalname) {
    const cleaned = originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    return /^\d{13}-/.test(cleaned) ? cleaned : `${Date.now()}-${cleaned}`;
}

// Set up storage engine
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        // Look at the 'section' field in the form data to determine the subfolder. `subfolder` is
        // the segment under UPLOADS_PATH (== the old images/<subfolder>/); empty means the bare
        // images/ root.
        let subfolder = '';
        const section = req.body.section; // e.g., 'home', 'gallery', 'events', 'about'

        if (section === 'gallery') {
            subfolder = 'gallery';
        } else if (section === 'events') {
            subfolder = 'events';
        } else if (section === 'home') {
            subfolder = 'carousel';
        } else if (section === 'about') {
            subfolder = 'about';
        } else if (section === 'backgrounds') {
             subfolder = 'backgrounds';
        } else if (section === 'branding') {
             subfolder = 'branding';
        } else if (section === 'footprint') {
             subfolder = 'footprint';
        } else if (section === 'testimonials') {
             subfolder = 'testimonials';
        }

        cb(null, uploadsWriteDir(subfolder));
    },
    filename: function (req, file, cb) {
        cb(null, safeUploadFilename(file.originalname));
    }
});

const upload = multer({
    storage: storage,
    fileFilter: function(req, file, cb) {
        const allowed = /jpeg|jpg|png|gif|webp|svg/;
        const ext = path.extname(file.originalname).toLowerCase().replace('.', '');
        if (allowed.test(ext)) return cb(null, true);
        cb(new Error('Only image files are allowed.'));
    },
    limits: { fileSize: 15 * 1024 * 1024 }
});

// Newsletter attachment storage — persists until scheduled job fires or is cancelled
const newsletterAttachStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, docsWriteDir('newsletter_attachments'));
    },
    filename: (req, file, cb) => { cb(null, `${Date.now()}-${file.originalname}`); }
});
const newsletterUpload = multer({ storage: newsletterAttachStorage, limits: { fileSize: 10 * 1024 * 1024 } });

// Direct email attachment storage
const emailAttachStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, docsWriteDir('email_attachments'));
    },
    filename: (req, file, cb) => { cb(null, `${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`); }
});
const emailAttachUpload = multer({
    storage: emailAttachStorage,
    limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

module.exports = { safeUploadFilename, upload, newsletterUpload, emailAttachUpload };
