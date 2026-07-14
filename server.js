const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const emailService = require('./js/emailService');
const sendEmail = emailService.sendEmail;
const transporter = emailService.transporter;
const emailTemplates = require('./js/emailTemplates');
const emailComponents = require('./js/emailComponents');
const bannerRegistry = require('./js/bannerRegistry');
const { SAMPLES_BY_CATEGORY } = require('./js/emailPreviewSamples');
const { imageSize } = require('image-size');
const crypto = require('crypto');
const PDFDocument = require('pdfkit');
const db = require('./database');
const pdfService = require('./js/pdfService');
require('dotenv').config();

// Ensure scratch directory exists
const scratchDir = path.join(__dirname, 'scratch');
if (!fs.existsSync(scratchDir)) {
    fs.mkdirSync(scratchDir, { recursive: true });
}


// --- Legacy Duration Parser ---
function parseDurationMins(durationRaw) {
    if (!durationRaw) return 60;
    if (typeof durationRaw === 'number') return durationRaw;
    const str = String(durationRaw).toLowerCase().trim();
    if (/^\d+$/.test(str)) return parseInt(str, 10);
    
    let mins = 0;
    const hrsMatch = str.match(/(\d+)\s*h/);
    if (hrsMatch) mins += parseInt(hrsMatch[1], 10) * 60;
    const minMatch = str.match(/(\d+)\s*m/);
    if (minMatch) mins += parseInt(minMatch[1], 10);
    
    return mins > 0 ? mins : 60;
}

const schedule = require('node-schedule');
const scheduledJobs = {}; // key: scheduled_newsletters.id → job object

// Analytics: geo + UA parsing for the first-party page-view tracker
const geoip    = require('geoip-lite');
const UAParser = require('ua-parser-js');

// Booking scheduling config — defaults overridden by settings table at startup
let MIN_BOOKING_GAP_MINS = 30; // global buffer minutes between consecutive bookings
let TYPE_BUFFERS = {};          // per-event-type buffer overrides; falls back to MIN_BOOKING_GAP_MINS

// Load settings from database into process.env
db.all("SELECT setting_key, setting_value FROM settings", [], (err, rows) => {
    if (err) console.error("Failed to load settings from DB:", err);
    else if (rows) {
        const envMap = {
            payfast_merchant_id: 'PAYFAST_MERCHANT_ID', payfast_merchant_key: 'PAYFAST_MERCHANT_KEY',
            payfast_passphrase: 'PAYFAST_PASSPHRASE', payfast_url: 'PAYFAST_URL',
            smtp_host: 'SMTP_HOST', smtp_port: 'SMTP_PORT', smtp_user: 'SMTP_USER',
            smtp_pass: 'SMTP_PASS', smtp_from: 'SMTP_FROM',
            email_banner: 'EMAIL_BANNER'
        };
        rows.forEach(r => {
            const key = r.setting_key;
            const val = r.setting_value;
            if (val !== null && val !== undefined && val !== '') {
                if (key === 'min_booking_gap_minutes') {
                    const parsed = parseInt(val);
                    if (!isNaN(parsed)) MIN_BOOKING_GAP_MINS = parsed;
                } else if (key === 'type_buffers') {
                    try { TYPE_BUFFERS = JSON.parse(val) || {}; } catch(e) {}
                } else if (envMap[key]) {
                    process.env[envMap[key]] = val;
                } else {
                    process.env[key.toUpperCase()] = val;
                }
            }
        });
        console.log("Settings loaded from database.");
    }
});
const { google } = require('googleapis');
const moment = require('moment-timezone');
moment.tz.setDefault('Africa/Johannesburg');

// Google Calendar Configuration
const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.BASE_URL // Redirect URL used during setup, though refresh token is already obtained
);

oauth2Client.setCredentials({
    refresh_token: process.env.GOOGLE_REFRESH_TOKEN
});

const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
const CALENDAR_ID = 'primary'; // Using the primary calendar of the authenticated account

const helmet = require('helmet');

// Rate limiter for public booking submissions (5 per 15 minutes per IP)
let rateLimit;
try { rateLimit = require('express-rate-limit'); } catch(e) { rateLimit = null; }
const bookingRateLimiter = (rateLimit && process.env.NODE_ENV !== 'test') ? rateLimit({ windowMs: 15 * 60 * 1000, max: 5, standardHeaders: true, legacyHeaders: false, message: { success: false, message: 'Too many booking submissions from this device. Please wait 15 minutes and try again.' } }) : (req, res, next) => next();

// Limits exports/sitemaps to prevent resource exhaustion
const exportRateLimiter = rateLimit ? rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 15, 
    message: { success: false, message: 'Export limit reached. Please try again in an hour.' }
}) : (req, res, next) => next();

const sitemapRateLimiter = rateLimit ? rateLimit({
    windowMs: 30 * 60 * 1000, // 30 mins
    max: 20,
    message: "Generating sitemaps too frequently. Please wait a while."
}) : (req, res, next) => next();

const trackRateLimiter = rateLimit ? rateLimit({
    windowMs: 15 * 60 * 1000, // 15 mins
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: 'Too many tracking lookups from this device. Please wait 15 minutes and try again.' }
}) : (req, res, next) => next();

// Strict limiter for state-mutating public endpoints (accept-quote, cancel) — email-only auth
const mutateRateLimiter = (rateLimit && process.env.NODE_ENV !== 'test') ? rateLimit({
    windowMs: 15 * 60 * 1000, // 15 mins
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: 'Too many attempts. Please wait 15 minutes and try again.' }
}) : (req, res, next) => next();

// Limiter for all authenticated admin routes (120 req/min per IP)
const adminRateLimiter = rateLimit ? rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: 'Too many requests. Please slow down.' }
}) : (req, res, next) => next();

// P3-13: Tighter limiter for admin login — 5 attempts per 10 minutes per IP (brute-force protection)
const adminLoginRateLimiter = rateLimit ? rateLimit({
    windowMs: 10 * 60 * 1000, // 10 minutes
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    message: { success: false, message: 'Too many login attempts. Please wait 10 minutes before trying again.' }
}) : (req, res, next) => next();

// Tight limiter for the email-lookup endpoint — reduces enumeration risk
const lookupRateLimiter = rateLimit ? rateLimit({
    windowMs: 10 * 60 * 1000, // 10 minutes
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: 'Too many lookup attempts. Please wait 10 minutes and try again.' }
}) : (req, res, next) => next();

// Generous limiter for the public analytics beacon — legit users send heartbeats
const analyticsTrackLimiter = rateLimit ? rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 200,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: 'Analytics rate limit reached.' }
}) : (req, res, next) => next();

// Bypass local antivirus/proxy self-signed certificates
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// --- Phase 6: Security & Rate Limiting ---
const rateLimits = new Map();
const RATE_LIMIT_WINDOW = 3600000; // 1 hour
const MAX_REQUESTS = 100; // Increased for test suite automation

const ipRateLimiter = (req, res, next) => {
    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    const now = Date.now();
    const limit = rateLimits.get(ip) || { count: 0, resetTime: now + RATE_LIMIT_WINDOW };

    if (now > limit.resetTime) {
        limit.count = 1;
        limit.resetTime = now + RATE_LIMIT_WINDOW;
    } else {
        limit.count++;
    }

    rateLimits.set(ip, limit);

    if (limit.count > MAX_REQUESTS) {
        return res.status(429).json({ success: false, message: 'Too many requests from this IP. Please try again in an hour.' });
    }
    next();
};

const sanitizeEmailInput = (input) => {
    if (typeof input !== 'string') return input;
    // Remove newlines to prevent header injection
    return input.replace(/[\r\n]/g, '').trim();
};

const app = express();
const PORT = process.env.PORT || 3000;

// The privacy-policy version consent is recorded against. Server-owned on purpose: the public
// booking form used to send this value and it was written verbatim into bookings.policy_version
// AND consent_audit.policy_version, so a stale cached page — or a crafted request — could record
// consent against a policy the user never saw. Bump this whenever the published policy changes.
const CURRENT_POLICY_VERSION = 'v2.2';

app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net", "https://maps.googleapis.com", "https://maps.gstatic.com", "https://www.payfast.co.za", "https://sandbox.payfast.co.za", "https://cdnjs.cloudflare.com", "https://unpkg.com", "https://ajax.googleapis.com", "https://cdn.quilljs.com"],
            scriptSrcAttr: ["'self'", "'unsafe-inline'"],
            scriptSrcElem: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net", "https://maps.googleapis.com", "https://maps.gstatic.com", "https://cdnjs.cloudflare.com", "https://unpkg.com", "https://ajax.googleapis.com"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net", "https://fonts.googleapis.com", "https://cdnjs.cloudflare.com", "https://maps.googleapis.com", "https://cdn.quilljs.com"],
            fontSrc: ["'self'", "https://fonts.gstatic.com", "https://cdnjs.cloudflare.com"],
            imgSrc: [
                "'self'", "data:", "blob:",
                "https://*.googleapis.com", "https://*.gstatic.com", "https://maps.gstatic.com",
                "https://img.youtube.com", "https://i.ytimg.com", "https://i3.ytimg.com",
                "https://upload.wikimedia.org",
                "https://cdn-icons-png.flaticon.com",
                "https://cdnjs.cloudflare.com",
                "https://unpkg.com"
            ],
            connectSrc: [
                "'self'",
                "https://*.payfast.co.za",
                "https://maps.googleapis.com", "https://maps.gstatic.com", "https://places.googleapis.com",
                "https://www.googleapis.com",
                "https://api.vimeo.com",
                "https://noembed.com",
                "https://api.microlink.io"
            ],
            frameSrc: [
                "'self'",
                "https://www.payfast.co.za", "https://sandbox.payfast.co.za",
                "https://www.google.com",
                "https://www.youtube.com",
                "https://player.vimeo.com",
                "https://www.facebook.com",
                "https://www.dailymotion.com",
                "https://player.twitch.tv", "https://clips.twitch.tv",
                "https://www.tiktok.com",
                "https://www.instagram.com",
                "https://twitter.com", "https://platform.twitter.com",
                "https://www.linkedin.com"
            ],
            formAction: ["'self'", "https://www.payfast.co.za", "https://sandbox.payfast.co.za"],
            upgradeInsecureRequests: null 
        }
    }
}));

app.use((req, res, next) => {
    if (process.env.NODE_ENV === 'production') {
        if (req.headers['x-forwarded-proto'] !== 'https') {
            return res.redirect(301, `https://${req.headers.host}${req.url}`);
        }
    }
    next();
});

// Middleware performance and security layering
app.use(cors());
app.use(express.json({ limit: '50kb' }));
app.use(express.urlencoded({ extended: true, limit: '50kb' }));

// XSS sanitisation — custom middleware compatible with Express 5.
// (express-mongo-sanitize and xss-clean both crash on Express 5's read-only req.query)
// NoSQL injection is handled by the custom sanitizer below; XSS by deepEscapeBody.
const escapeHtml = (str) => str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
const deepEscapeBody = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    Object.keys(obj).forEach(key => {
        if (typeof obj[key] === 'string') obj[key] = escapeHtml(obj[key]);
        else if (typeof obj[key] === 'object' && obj[key] !== null) deepEscapeBody(obj[key]);
    });
};
app.use((req, res, next) => {
    // about-me + site-content carry admin-authored rich text (e.g. <em>); they are sanitised
    // per-field in their handlers instead of being blanket entity-escaped here.
    if (req.body && req.path !== '/api/admin/about-me' && req.path !== '/api/admin/site-content') deepEscapeBody(req.body);
    next();
});

// Security Sanitzation (Custom implementation to avoid immutable property crashes)
app.use((req, res, next) => {
    // Basic NoSQL-style injection prevention (Targeting common patterns)
    const sanitize = (obj) => {
        if (obj && typeof obj === 'object') {
            Object.keys(obj).forEach(key => {
                if (key.startsWith('$') || key.includes('.')) {
                    delete obj[key];
                } else if (typeof obj[key] === 'object') {
                    sanitize(obj[key]);
                }
            });
        }
    };
    if (req.body) sanitize(req.body);
    if (req.params) sanitize(req.params);
    next();
});



// Log all requests for debugging
app.use((req, res, next) => {
    res.on('finish', () => {
        console.log(`[DEBUG] ${req.method} ${req.url} - Status: ${res.statusCode}`);
    });
    next();
});

// Disallow admin and API paths from search engine crawlers
app.get('/robots.txt', (req, res) => {
    res.type('text/plain');
    res.send('User-agent: *\nDisallow: /admin\nDisallow: /api\n');
});

// Enforce UTF-8 charset on all text-based static files + Cache Optimization
app.use(express.static(path.join(__dirname, '/'), {
    setHeaders(res, filePath) {
        const ext = path.extname(filePath).toLowerCase();
        
        // Performance Caching
        if (filePath.match(/\.(jpg|jpeg|png|gif|svg|webp|ico|woff|woff2|ttf|otf)$/i)) {
            // Immutable assets like images and fonts can be cached for 1 year
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        } else if (filePath.match(/\.(css|js)$/i)) {
            // CSS and JS - cache for 1 day
            res.setHeader('Cache-Control', 'public, max-age=86400');
        } else if (ext === '.html' || ext === '.htm') {
            // NEVER cache HTML files to ensure updates propagate immediately
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
        }
    }
}));

// Configure Session Middleware for Admin Authentication
const SQLiteStore = require('connect-sqlite3')(session);

if (process.env.NODE_ENV === 'production' && !process.env.SESSION_SECRET) {
    throw new Error('SESSION_SECRET environment variable must be set in production');
}
const _sessionSecret = process.env.SESSION_SECRET || 'dev-only-secret-change-before-deploy';

app.set('trust proxy', 1); // Trust first proxy (ngrok)
app.use(session({
    store: new SQLiteStore({ db: 'sessions.sqlite', dir: './' }),
    secret: _sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        sameSite: process.env.NODE_ENV === 'production' ? 'strict' : 'lax',
        maxAge: 1000 * 60 * 60 * 24 * 7 // 7 days default; overridden to 30d or null at login
    }
}));

// Set up storage engine
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        // Look at the 'section' field in the form data to determine the subfolder
        let folder = 'images/';
        const section = req.body.section; // e.g., 'home', 'gallery', 'events', 'about'

        if (section === 'gallery') {
            folder = 'images/gallery/';
        } else if (section === 'events') {
            folder = 'images/events/';
        } else if (section === 'home') {
            folder = 'images/carousel/';
        } else if (section === 'about') {
            folder = 'images/about/';
        } else if (section === 'backgrounds') {
             folder = 'images/backgrounds/';
        } else if (section === 'branding') {
             folder = 'images/branding/';
        }

        // Ensure directory exists
        const dir = path.join(__dirname, folder);
        if (!fs.existsSync(dir)){
            fs.mkdirSync(dir, { recursive: true });
        }
        cb(null, dir);
    },
    filename: function (req, file, cb) {
        const safe = Date.now() + '-' + file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
        cb(null, safe);
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

// Receipt file storage for expenses
const receiptStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = path.join(__dirname, 'uploads', 'receipts');
        fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        cb(null, 'receipt-' + Date.now() + ext);
    }
});
const uploadReceipt = multer({
    storage: receiptStorage,
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const ok = /\.(jpg|jpeg|png|gif|webp|pdf)$/i.test(path.extname(file.originalname));
        ok ? cb(null, true) : cb(new Error('Only images and PDFs allowed.'));
    }
});

// Newsletter attachment storage — persists until scheduled job fires or is cancelled
const newsletterAttachStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = path.join(__dirname, 'docs', 'newsletter_attachments');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => { cb(null, `${Date.now()}-${file.originalname}`); }
});
const newsletterUpload = multer({ storage: newsletterAttachStorage, limits: { fileSize: 10 * 1024 * 1024 } });

// Direct email attachment storage
const emailAttachStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = path.join(__dirname, 'docs', 'email_attachments');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => { cb(null, `${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`); }
});
const emailAttachUpload = multer({ 
    storage: emailAttachStorage, 
    limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});


// Booking client attachments (posters, briefs, programmes)
const bookingAttachUpload = multer({
    storage: multer.diskStorage({
        destination: function (req, file, cb) {
            const dir = path.join(__dirname, 'docs', 'booking_attachments');
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            cb(null, dir);
        },
        filename: function (req, file, cb) {
            const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
            cb(null, `booking-${req.params.id || 'new'}-${Date.now()}-${safe}`);
        }
    }),
    fileFilter: function (req, file, cb) {
        const allowedMimes = [
            'application/pdf',
            'application/msword',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'image/jpeg', 'image/png', 'image/webp'
        ];
        if (allowedMimes.includes(file.mimetype)) return cb(null, true);
        cb(new Error('Allowed types: PDF, Word, JPEG, PNG, WEBP'));
    },
    limits: { fileSize: 10 * 1024 * 1024 }
});

app.post('/upload', (req, res, next) => {
    // SEC-1: require an admin session BEFORE multer runs — this route is defined above the
    // requireAdmin const (~L1569) so it can't use that middleware, and gating pre-multer means an
    // unauthenticated request never writes a file. Previously anyone could upload into the
    // web-served images/* dirs (the filter allows .svg → stored-XSS vector, plus defacement/DoS).
    if (!req.session || !req.session.adminId) {
        return res.status(401).json({ success: false, message: 'Unauthorized. Please log in.' });
    }
    next();
}, upload.single('file'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ success: false, message: 'No file uploaded' });
    }
    
    // Construct the relative path string that the website expects (e.g. "images/gallery/photo.jpg")
    let folderPath = 'images/';
    const section = req.body.section;
    if (section === 'gallery') folderPath = 'images/gallery/';
    else if (section === 'events') folderPath = 'images/events/';
    else if (section === 'home') folderPath = 'images/carousel/';
    else if (section === 'about') folderPath = 'images/about/';
    else if (section === 'backgrounds') folderPath = 'images/backgrounds/';
    else if (section === 'branding') folderPath = 'images/branding/';

    const relativePath = folderPath + req.file.filename;

    res.json({
        success: true,
        message: 'File uploaded successfully',
        filePath: relativePath,
        filename: req.file.filename
    });
});




// ==========================================
// ==========================================
// CALENDAR SYNC HELPERS
// ==========================================

// --- Time utility helpers ---

function timeRangesOverlap(s1, e1, s2, e2) {
    // HH:MM strings are always zero-padded so lexicographic comparison is correct
    return s1 < e2 && s2 < e1;
}

function addMinutesToTime(timeStr, minutes) {
    const [h, m] = timeStr.split(':').map(Number);
    const total = h * 60 + m + minutes;
    const hh = Math.floor(total / 60) % 24;
    const mm = total % 60;
    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function parseDurationToMinutes(dur) {
    if (!dur) return 120;
    const n = parseInt(dur);
    if (!isNaN(n)) return n; // frontend sends numeric minutes
    const mh = String(dur).match(/(\d+)\s*(h|hour|hr)/i);
    if (mh) return parseInt(mh[1]) * 60;
    const mm = String(dur).match(/(\d+)\s*(m|min)/i);
    if (mm) return parseInt(mm[1]);
    return 120;
}

// --- End time utility helpers ---

/**
 * Checks for conflicts on Thabiso's Google Calendar
 * @param {string} startTime - ISO string
 * @param {string} endTime - ISO string
 * @returns {Promise<boolean>} - true if conflict exists
 */

/**
 * Check whether a timed booking falls within configured working hours for that day.
 * Fails open (allows) if no working_hours row exists for that day.
 */
async function isWithinWorkingHours(dateStr, startHHMM, endHHMM) {
    const dayOfWeek = new Date(dateStr + 'T12:00:00').getDay();
    return new Promise((resolve) => {
        db.get(
            'SELECT start_time, end_time, is_working_day FROM working_hours WHERE day_of_week = ?',
            [dayOfWeek],
            (err, wh) => {
                if (err || !wh) return resolve({ allowed: true }); // fail open if no config
                const DAY_NAMES = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
                if (!wh.is_working_day) {
                    return resolve({ allowed: false, reason: `Bookings are not available on ${DAY_NAMES[dayOfWeek]}.` });
                }
                const toMins = (timeStr) => {
                    const [h, m] = timeStr.split(':').map(Number);
                    return h * 60 + m;
                };
                const startMins = toMins(startHHMM);
                let endMins = toMins(endHHMM);
                if (endMins < startMins) {
                    endMins += 1440;
                }
                const whStartMins = toMins(wh.start_time);
                const whEndMins = wh.end_time === '00:00' ? 1440 : toMins(wh.end_time);

                if (startMins < whStartMins) {
                    return resolve({ allowed: false, reason: `Bookings cannot start before ${wh.start_time}.` });
                }
                if (endMins > whEndMins) {
                    return resolve({ allowed: false, reason: `Bookings must end by ${wh.end_time === '00:00' ? '00:00' : wh.end_time}.` });
                }
                resolve({ allowed: true });
            }
        );
    });
}

async function hasCalendarConflict(startTime, endTime, excludeBookingId, skipGoogle) {
    try {
        const targetDate = startTime.split('T')[0];
        const reqStart = moment(startTime).format('HH:mm'); // Local time formatting (HH:MM)
        const reqEnd   = moment(endTime).format('HH:mm');

        // 1. Check local date_holds — time-aware, respects hold_expires_at
        const holdConflict = await new Promise((resolve) => {
            db.all(
                `SELECT start_time, end_time FROM date_holds
                 WHERE hold_date = ? AND status = 'active'
                 AND (hold_expires_at IS NULL OR hold_expires_at > datetime('now'))`,
                [targetDate],
                (err, holds) => {
                    // Fail-open on a DB error, but no longer SILENTLY — a failed holds read means the
                    // hold half of conflict detection didn't run, so a double-booking could slip through.
                    if (err) { console.error(`[hasCalendarConflict] date_holds read failed for ${targetDate} — conflict check degraded (failing open):`, err.message); return resolve(false); }
                    if (!holds) return resolve(false);
                    for (const h of holds) {
                        if (!h.start_time) return resolve(true); // all-day hold blocks entire day
                        const hEnd = h.end_time || addMinutesToTime(h.start_time, 60);
                        if (timeRangesOverlap(reqStart, reqEnd, h.start_time, hEnd)) return resolve(true);
                    }
                    resolve(false);
                }
            );
        });
        if (holdConflict) return true;

        // 2. Check existing bookings on the same day for time overlap
        const bookingConflict = await new Promise((resolve) => {
            const excludeClause = excludeBookingId ? ' AND id != ?' : '';
            const params = excludeBookingId
                ? [targetDate, excludeBookingId]
                : [targetDate];
            db.all(
                `SELECT event_start_time, performance_end_time, performance_duration, event_type, buffer_minutes
                 FROM bookings
                 WHERE date = ? AND status NOT IN ('CANCELLED','EXPIRED')${excludeClause}`,
                params,
                (err, bookings) => {
                    // Same fail-open, now logged: a failed bookings read means the booking-overlap half
                    // of conflict detection didn't run.
                    if (err) { console.error(`[hasCalendarConflict] bookings read failed for ${targetDate} — conflict check degraded (failing open):`, err.message); return resolve(false); }
                    if (!bookings) return resolve(false);
                    for (const b of bookings) {
                        if (!b.event_start_time) continue;
                        const bEnd = b.performance_end_time ||
                            addMinutesToTime(b.event_start_time, parseDurationToMinutes(b.performance_duration));
                        const gap = (b.buffer_minutes != null) ? b.buffer_minutes
                            : (b.event_type && TYPE_BUFFERS[b.event_type] !== undefined) ? TYPE_BUFFERS[b.event_type]
                            : MIN_BOOKING_GAP_MINS;
                        const bufferedEnd = addMinutesToTime(bEnd, gap);
                        if (timeRangesOverlap(reqStart, reqEnd, b.event_start_time, bufferedEnd)) return resolve(true);
                    }
                    resolve(false);
                }
            );
        });
        if (bookingConflict) return true;

        // 3. Check Google Calendar (if configured).
        // skipGoogle=true is used for the in-transaction re-check so we don't hold a
        // BEGIN IMMEDIATE write lock open during a network round-trip; the local
        // holds+bookings checks above are sufficient to close the concurrent-booking race.
        if (!skipGoogle && typeof calendar !== 'undefined' && CALENDAR_ID) {
            try {
                const response = await calendar.freebusy.query({
                    requestBody: {
                        timeMin: startTime,
                        timeMax: endTime,
                        items: [{ id: CALENDAR_ID }]
                    }
                }, {
                    timeout: 1500
                });
                const busy = response.data.calendars[CALENDAR_ID].busy;
                if (busy && busy.length > 0) return true;
            } catch (gcalErr) {
                console.error('[hasCalendarConflict] Google Calendar check failed (non-blocking):', gcalErr.message);
            }
        }

        return false;
    } catch (error) {
        // Fail open, but loudly: an unexpected error here means NO conflict check ran, so the caller
        // will treat the slot as free. Better to occasionally double-book than to block all bookings,
        // but the operator needs to know conflict detection degraded.
        console.error('[hasCalendarConflict] check failed entirely — treating slot as FREE (failing open). Double-booking possible until resolved:', error && error.message);
        return false;
    }
}

/**
 * Creates or updates a Google Calendar event for a booking
 * @param {number|object} bookingOrId - Booking ID or booking object
 * @returns {Promise<string|null>} - The Google Event ID
 */
async function syncBookingToCalendar(bookingOrId) {
    return new Promise((resolve, reject) => {
        const getBooking = (id) => new Promise((res, rej) => {
            db.get("SELECT * FROM bookings WHERE id = ?", [id], (err, row) => err ? rej(err) : res(row));
        });

        const processSync = async (booking) => {
            if (!booking) return resolve(null);

            // Fetch services to calculate duration
            const bookingServices = await new Promise((res, rej) => {
                db.all(`SELECT bs.*, s.setup_time_minutes, s.performance_length_minutes 
                        FROM booking_services bs
                        JOIN services s ON bs.service_id = s.id
                        WHERE bs.booking_id = ?`, [booking.id], (err, rows) => err ? rej(err) : res(rows));
            });

            let totalMins = 0;
            if (bookingServices && bookingServices.length > 0) {
                bookingServices.forEach(bs => {
                    totalMins += (bs.setup_time_minutes || 0) + (bs.performance_length_minutes || 0);
                });
            }
            if (totalMins === 0) totalMins = 120; // Fallback to 2 hours

            const start = moment(`${booking.date} ${booking.event_start_time || '18:00'}`).toISOString();
            const end = moment(start).add(totalMins, 'minutes').toISOString();

            const eventData = {
                summary: `[${booking.status.toUpperCase()}] Thabiso Mhlongo: ${booking.event_type || 'Performance'}`,
                location: booking.event_location || booking.venue_address || 'TBD',
                description: `Client: ${booking.name}\nEmail: ${booking.email}\nPhone: ${booking.cell}\n\nNotes: ${booking.message || 'No notes'}`,
                start: { dateTime: start, timeZone: 'Africa/Johannesburg' },
                end: { dateTime: end, timeZone: 'Africa/Johannesburg' },
                colorId: booking.status === 'Confirmed' ? '10' : '5' // Green for confirmed, Yellow for pending/hold
            };

            try {
                if (booking.google_event_id) {
                    await calendar.events.update({
                        calendarId: CALENDAR_ID,
                        eventId: booking.google_event_id,
                        requestBody: eventData
                    });
                    console.log(`✓ Updated GCal Event for Booking #${booking.id}`);
                    resolve(booking.google_event_id);
                } else {
                    const response = await calendar.events.insert({
                        calendarId: CALENDAR_ID,
                        requestBody: eventData
                    });
                    const eventId = response.data.id;
                    db.run("UPDATE bookings SET google_event_id = ? WHERE id = ?", [eventId, booking.id]);
                    console.log(`✓ Created GCal Event for Booking #${booking.id}: ${eventId}`);
                    resolve(eventId);
                }
            } catch (error) {
                console.error(`Error syncing booking #${booking.id} to GCal:`, error);
                resolve(null);
            }
        };

        if (typeof bookingOrId === 'object') {
            processSync(bookingOrId);
        } else {
            getBooking(bookingOrId).then(processSync).catch(reject);
        }
    });
}

/**
 * Removes a Google Calendar event
 * @param {string} eventId 
 */
async function deleteGoogleEvent(eventId) {
    if (!eventId) return;
    try {
        await calendar.events.delete({ calendarId: CALENDAR_ID, eventId: eventId });
        console.log(`✓ Deleted GCal Event: ${eventId}`);
    } catch (error) {
        console.error(`Error deleting GCal event ${eventId}:`, error);
    }
}

async function syncCalendarHolds() {
    if (typeof calendar === 'undefined' || !CALENDAR_ID) return;
    
    try {
        const response = await calendar.events.list({
            calendarId: CALENDAR_ID,
            timeMin: new Date().toISOString(),
            timeMax: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(), // 3 months
            singleEvents: true,
            orderBy: 'startTime',
        });
        
        const events = response.data.items || [];
        
        // 1. Construct a set of active Google Calendar event IDs
        const gcalEventIds = new Set(events.map(e => e.id));
        
        // 2. Fetch all calendar sync holds from the database
        const calendarSyncHolds = await new Promise((resolve) => {
            db.all("SELECT google_event_id FROM date_holds WHERE block_type = 'calendar_sync' AND google_event_id IS NOT NULL", [], (err, rows) => resolve(rows || []));
        });
        
        // 3. Delete any local holds that are no longer present on Google Calendar
        for (const hold of calendarSyncHolds) {
            if (!gcalEventIds.has(hold.google_event_id)) {
                await new Promise((res) => {
                    db.run("DELETE FROM date_holds WHERE google_event_id = ?", [hold.google_event_id], () => res());
                });
                console.log(`✓ Deleted orphaned calendar hold for GCal event ${hold.google_event_id}`);
            }
        }

        if (events.length === 0) return;
        
        // Fetch existing IDs to avoid duplicates
        const existingHolds = await new Promise((resolve) => {
            db.all("SELECT google_event_id, hold_date, start_time, end_time FROM date_holds WHERE google_event_id IS NOT NULL AND block_type = 'calendar_sync'", [], (err, rows) => resolve(rows || []));
        });
        const existingBookings = await new Promise((resolve) => {
            db.all("SELECT google_event_id FROM bookings WHERE google_event_id IS NOT NULL", [], (err, rows) => resolve(rows || []));
        });
        const existingEvs = await new Promise((resolve) => {
            db.all("SELECT google_calendar_event_id FROM events WHERE google_calendar_event_id IS NOT NULL", [], (err, rows) => resolve(rows || []));
        });
        
        const localSyncedIds = new Set([
            ...existingBookings.map(r => r.google_event_id),
            ...existingEvs.map(r => r.google_calendar_event_id)
        ]);
        const existingHoldsMap = new Map(existingHolds.map(h => [h.google_event_id, h]));
        
        for (const event of events) {
            if (localSyncedIds.has(event.id)) continue;
            
            const start = event.start.dateTime || event.start.date;
            const end = event.end.dateTime || event.end.date;
            
            const date = start.slice(0, 10);
            let startTime = null;
            let endTime = null;
            
            if (event.start.dateTime) {
                startTime = start.slice(11, 16);
                endTime = end.slice(11, 16);
            }
            
            if (existingHoldsMap.has(event.id)) {
                // If it exists, check if details changed and update if they have
                const dbHold = existingHoldsMap.get(event.id);
                if (dbHold.hold_date !== date || dbHold.start_time !== startTime || dbHold.end_time !== endTime) {
                    db.run(
                        "UPDATE date_holds SET hold_date = ?, start_time = ?, end_time = ?, notes = ? WHERE google_event_id = ?",
                        [date, startTime, endTime, event.summary || 'Google Calendar Event', event.id],
                        (err) => {
                            if (err) console.error(`Failed to update calendar hold for event ${event.id}:`, err.message);
                            else console.log(`✓ Updated local calendar hold for event ${event.id}: ${date} ${startTime || ''}-${endTime || ''}`);
                        }
                    );
                }
            } else {
                // It's a new foreign event!
                db.run(
                    `INSERT INTO date_holds (hold_date, notes, status, hold_expires_at, start_time, end_time, block_type, google_event_id)
                     VALUES (?, ?, 'active', '9999-12-31 23:59:59', ?, ?, 'calendar_sync', ?)`,
                    [date, event.summary || 'Google Calendar Event', startTime, endTime, event.id],
                    (err) => {
                        if (err) console.error(`Failed to insert calendar hold for event ${event.id}:`, err.message);
                        else console.log(`✓ Synced GCal event ${event.id} as hold on ${date}`);
                    }
                );
            }
        }
    } catch (error) {
        console.error('Error syncing calendar holds:', error);
    }
}

// Single-flight guard: a batch (attachments / slow SMTP) can take longer than the 20s
// setInterval, and two overlapping sweeps would double-send the same 'pending' rows. We serialize
// in-process because an intra-DB claim isn't available — the notifications.status CHECK constraint
// only permits ('pending','sent','failed','read','dismissed'), so the previous
// `SET status='sending'` flip always failed the CHECK (its error was ignored), leaving the
// double-send guard non-functional and sent_at never written.
let _notificationSweepRunning = false;
async function processNotificationQueue() {
    if (_notificationSweepRunning) return; // a prior sweep is still draining the queue
    _notificationSweepRunning = true;
    try {
        // Process up to 10 pending notifications
        const rows = await new Promise((resolve) => {
            db.all(
                `SELECT * FROM notifications
                 WHERE status = 'pending' AND channel = 'email'
                 AND (scheduled_at IS NULL OR scheduled_at <= datetime('now'))
                 LIMIT 10`,
                [],
                (err, r) => {
                    if (err) { console.error('[Notification Queue] Error fetching pending emails:', err.message); return resolve([]); }
                    resolve(r || []);
                }
            );
        });
        if (rows.length === 0) return;

        const { sendEmailDirectly } = require('./js/emailService');

        for (const row of rows) {
            let emailDetails = {};
            try {
                emailDetails = JSON.parse(row.body || '{}');
            } catch (e) {
                console.error(`[Notification Queue] Failed to parse body for notification #${row.id}:`, e.message);
                db.run("UPDATE notifications SET status = 'failed', error_message = ? WHERE id = ?", ['JSON_PARSE_ERROR: ' + e.message, row.id]);
                continue;
            }

            // Map attachment paths to standard nodemailer attachments array
            const attachments = [];
            if (row.attachment_paths) {
                try {
                    const paths = JSON.parse(row.attachment_paths);
                    paths.forEach(p => {
                        if (typeof p === 'string') {
                            const pathModule = require('path');
                            const resolvedPath = pathModule.isAbsolute(p) ? p : pathModule.join(__dirname, p);
                            const filename = pathModule.basename(p);
                            attachments.push({ filename, path: resolvedPath });
                        }
                    });
                } catch(e) {
                    console.error(`[Notification Queue] Failed to parse attachments for #${row.id}:`, e.message);
                }
            }

            try {
                const result = await sendEmailDirectly({
                    to: row.recipient_email,
                    subject: row.subject,
                    htmlContent: emailDetails.htmlContent,
                    plainTextAlternative: emailDetails.plainTextAlternative,
                    attachments: attachments,
                    fromName: row.recipient_name || emailDetails.fromName || "Thabiso Mhlongo Management",
                    replyTo: emailDetails.replyTo,
                    skipBrandAttachments: emailDetails.skipBrandAttachments,
                    titleOverride: emailDetails.titleOverride,
                    trigger_event: emailDetails.trigger_event || 'Notification Queue Dispatch',
                    preWrapped: emailDetails.preWrapped,
                    cc: emailDetails.cc,
                    bcc: emailDetails.bcc,
                    branding: emailDetails.branding
                });

                if (result.success) {
                    db.run("UPDATE notifications SET status = 'sent', sent_at = CURRENT_TIMESTAMP WHERE id = ?", [row.id]);
                    console.log(`✓ [Notification Queue] Successfully sent email #${row.id} to ${row.recipient_email}`);
                } else {
                    throw new Error(result.error || 'SMTP_SEND_FAILED');
                }
            } catch (sendErr) {
                console.error(`❌ [Notification Queue] Failed to send email #${row.id} to ${row.recipient_email}:`, sendErr.message);
                const newRetryCount = (row.retry_count || 0) + 1;
                const nextStatus = newRetryCount >= 3 ? 'failed' : 'pending';
                db.run(
                    "UPDATE notifications SET status = ?, retry_count = ?, error_message = ? WHERE id = ?",
                    [nextStatus, newRetryCount, sendErr.message.substring(0, 255), row.id]
                );
            }
        }
    } finally {
        _notificationSweepRunning = false;
    }
}

async function syncEventToCalendar(eventId) {
    return new Promise((resolve) => {
        db.get("SELECT * FROM events WHERE event_id = ?", [eventId], async (err, ev) => {
            if (err || !ev) return resolve(null);

            const startDt = ev.event_datetime
                ? moment(ev.event_datetime).tz('Africa/Johannesburg')
                : moment().tz('Africa/Johannesburg');
            const endDt = startDt.clone().add(2, 'hours');

            const eventData = {
                summary: `[PUBLIC] ${ev.event_title || 'Event'}`,
                location: ev.venue_name || '',
                description: [
                    ev.event_description || '',
                    ev.ticket_sales_link ? `Tickets: ${ev.ticket_sales_link}` : '',
                    ev.venue_map_link ? `Map: ${ev.venue_map_link}` : ''
                ].filter(Boolean).join('\n'),
                start: { dateTime: startDt.toISOString(), timeZone: 'Africa/Johannesburg' },
                end:   { dateTime: endDt.toISOString(),   timeZone: 'Africa/Johannesburg' },
                colorId: '11'
            };

            try {
                if (ev.google_calendar_event_id) {
                    await calendar.events.update({
                        calendarId: CALENDAR_ID,
                        eventId: ev.google_calendar_event_id,
                        requestBody: eventData
                    });
                    console.log(`✓ Updated GCal Event for Event #${eventId}`);
                    resolve(ev.google_calendar_event_id);
                } else {
                    const response = await calendar.events.insert({
                        calendarId: CALENDAR_ID,
                        requestBody: eventData
                    });
                    const gcalId = response.data.id;
                    db.run("UPDATE events SET google_calendar_event_id = ? WHERE event_id = ?", [gcalId, eventId]);
                    console.log(`✓ Created GCal Event for Event #${eventId}: ${gcalId}`);
                    resolve(gcalId);
                }
            } catch (error) {
                console.error(`Error syncing event #${eventId} to GCal:`, error);
                resolve(null);
            }
        });
    });
}

function getNotificationEmail() {
    return new Promise((resolve) => {
        db.get("SELECT setting_value FROM settings WHERE setting_key = 'notification_email'", [], (err, row) => {
            if (!err && row && row.setting_value) return resolve(row.setting_value);
            resolve(process.env.NOTIFICATION_EMAIL || process.env.EMAIL_USER || 'muzi.mlimi@gmail.com');
        });
    });
}

// P2-3: Returns the active VAT rate from tax_rates table (falls back to 0.15 / 15%).
// FIN-1: the tax_rates table has no tax_type/is_active columns (real columns: name, rate,
// is_default, effective_from, effective_to), so the original query always errored and
// silently returned the 0.15 fallback — meaning a reconfigured VAT rate was never picked up.
// Now selects the current default rate by effective-date window.
function getVatRate() {
    return new Promise(resolve => {
        db.get(`SELECT rate FROM tax_rates
                WHERE COALESCE(is_default, 0) = 1
                  AND (effective_from IS NULL OR effective_from <= date('now'))
                  AND (effective_to   IS NULL OR effective_to   >= date('now'))
                ORDER BY effective_from DESC, id DESC LIMIT 1`,
            [], (err, row) => resolve((!err && row && row.rate != null) ? parseFloat(row.rate) : 0.15));
    });
}

// FIN-2: VAT applies only to taxable lines. Resolve each line's tax_class from the services
// catalog (lines without a service_id — e.g. custom quote lines — default to 'standard'/taxable).
// Mutates items in place, adding a tax_class where missing.
async function resolveLineTaxClasses(items) {
    if (!Array.isArray(items) || items.length === 0) return items;
    const ids = [...new Set(items.map(i => parseInt(i.service_id)).filter(n => !isNaN(n)))];
    const byId = {};
    if (ids.length) {
        const rows = await new Promise(res => db.all(
            `SELECT id, tax_class FROM services WHERE id IN (${ids.map(() => '?').join(',')})`, ids,
            (e, r) => res(e ? [] : (r || []))));
        rows.forEach(s => { byId[s.id] = s.tax_class; });
    }
    for (const it of items) {
        if (!it.tax_class) it.tax_class = byId[parseInt(it.service_id)] || 'standard';
    }
    return items;
}

// FIN-2: single source of truth for quote/invoice money math — mirrors pdfService's totals block
// so the stored total and the printed document always agree. VAT is charged only on taxable
// (non-exempt) lines; a discount is split across taxable/exempt in proportion to their subtotals.
function computeDocumentTotals(items, { discount = 0, applyVat = false, vatRate = 0.15 } = {}) {
    let vatableSubtotal = 0, exemptSubtotal = 0;
    for (const it of (items || [])) {
        const qty = parseFloat(it.quantity_minutes) || parseFloat(it.quantity) || 1;
        const price = parseFloat(it.unit_price) || 0;
        const amt = qty * price;
        const tc = it.tax_class || 'standard';
        if (tc === 'exempt' || tc === 'zero-rated') exemptSubtotal += amt; else vatableSubtotal += amt;
    }
    const subtotal = vatableSubtotal + exemptSubtotal;
    const dp = Math.max(0, parseFloat(discount) || 0);
    const ratio = subtotal > 0 ? vatableSubtotal / subtotal : 1;
    const vatableBase = Math.max(0, vatableSubtotal - dp * ratio);
    const exemptBase  = Math.max(0, exemptSubtotal - dp * (1 - ratio));
    const vat = applyVat ? Math.round(vatableBase * vatRate * 100) / 100 : 0;
    const total = Math.round((vatableBase + exemptBase + vat) * 100) / 100;
    return { subtotal, vatableBase, exemptBase, vat, total, discount: dp };
}

/**
 * Generates an invoice for a booking, saves to DB and sends email.
 * @param {number|string} bookingId
 * @returns {Promise<Object>}
 */
async function generateInvoice(bookingId) {
    return new Promise((resolve, reject) => {
        db.get(`SELECT b.*, c.vat_number AS client_vat_number
                FROM bookings b LEFT JOIN clients c ON b.client_id = c.id WHERE b.id = ?`, [bookingId], async (err, booking) => {
            if (err || !booking) return reject(new Error('Booking not found'));

            // Ensure client_id is resolved and updated in booking record if missing
            let clientId = booking.client_id;
            if (!clientId) {
                try {
                    clientId = await findOrCreateClient(booking.name, booking.email, booking.cell, booking.company, booking.vat_number);
                    await new Promise((resVal, rejVal) => {
                        db.run("UPDATE bookings SET client_id = ? WHERE id = ?", [clientId, bookingId], upErr => upErr ? rejVal(upErr) : resVal());
                    });
                    booking.client_id = clientId;
                } catch(e) {
                    console.error("[generateInvoice] Failed to resolve client:", e);
                    return reject(e);
                }
            }

            // Superseding the previous invoice now happens inside the write transaction below —
            // running it here voided the booking's existing invoice before the replacement was even
            // built, so any later failure (PDF, insert) left the booking with no live invoice at all.
            db.get("SELECT id, file_path FROM invoices WHERE booking_id = ? AND status = 'PAID' LIMIT 1", [bookingId], async (e, inv) => {
                if (inv) return resolve({ success: true, message: 'Invoice already paid — no regeneration needed.', invoice_id: inv.id, pdfUrl: `/docs/invoices/${inv.file_path}` });

                try {
                    const vatRate = await getVatRate();

                    // P3-10: Prefer quote_line_items from active quotations row over legacy quote_details JSON
                    const activeQuote = await new Promise(resolve => {
                        db.get(
                            `SELECT * FROM quotations WHERE booking_id = ? AND archived = 0 AND status NOT IN ('void','archived')
                             ORDER BY version DESC LIMIT 1`,
                            [bookingId], (qErr, qRow) => resolve(qErr ? null : qRow)
                        );
                    });

                    let items = [];
                    let quoteData = {};
                    // apply_vat + discount live reliably in booking.quote_details JSON — the quotations
                    // table has no such columns, so reading activeQuote.apply_vat/discount always yielded
                    // undefined (FIN-3: invoices via the quotations path silently dropped VAT + discount).
                    // Source them from quote_details; use the relational rows only for the line items.
                    try { quoteData = JSON.parse(booking.quote_details || '{}'); } catch(ex) {}

                    if (activeQuote) {
                        const qLines = await new Promise(resolve => {
                            db.all("SELECT * FROM quote_line_items WHERE quotation_id = ? ORDER BY id ASC",
                                [activeQuote.id], (liErr, rows) => resolve(liErr ? [] : (rows || [])));
                        });
                        if (qLines.length > 0) {
                            items = qLines.map(li => ({
                                description: li.description,
                                quantity: parseFloat(li.quantity) || 1,
                                unit_price: parseFloat(li.unit_price) || 0,
                                service_id: li.service_id
                            }));
                        }
                    }
                    if (items.length === 0 && Array.isArray(quoteData.items)) {
                        items = quoteData.items; // fallback item source (legacy quote_details)
                    }

                    // FIN-2: tag each line's tax_class so VAT is charged only on taxable lines and the PDF matches.
                    await resolveLineTaxClasses(items);

                    const applyVat = !!quoteData.apply_vat;
                    const discount = parseFloat(quoteData.discount) || 0;

                    let subtotal, tax, total;
                    if (items.length > 0) {
                        const t = computeDocumentTotals(items, { discount, applyVat, vatRate });
                        subtotal = t.subtotal; tax = t.vat; total = t.total;
                    } else {
                        console.warn(`[Invoice Warning] Booking #${bookingId}: no line items from quotations or quote_details — using fallback.`);
                        subtotal = quoteData.subtotal || parseFloat((booking.quote_amount || '0').replace(/[^0-9.]/g, '')) || 0;
                        const vatable = Math.max(0, subtotal - discount);
                        tax = applyVat ? (quoteData.vat || (vatable * vatRate)) : 0;
                        total = vatable + tax;
                        items = [{ description: 'Performance Booking Service', quantity: 1, unit_price: subtotal, tax_class: 'standard' }];
                    }

                    // Allocate the invoice number. `invoices.invoice_number` is UNIQUE and a voided
                    // invoice keeps its number forever (statutory: a number is never reused), so a
                    // regenerated invoice takes the next revision instead of colliding. Before this,
                    // re-quoting an ACCEPTED booking voided its invoice and the replacement could
                    // never be inserted — the booking was left with no live invoice for the rest of
                    // the year.
                    //   first issue:  INV-2026-0044
                    //   regenerated:  INV-2026-0044-R2, -R3, …
                    const baseNumber = `INV-${moment().format('YYYY')}-${bookingId.toString().padStart(4, '0')}`;
                    const priorIssued = await new Promise((resolve, reject) =>
                        db.get(
                            `SELECT COUNT(*) AS c FROM invoices
                             WHERE booking_id = ? AND (invoice_number = ? OR invoice_number LIKE ?)`,
                            [bookingId, baseNumber, `${baseNumber}-R%`],
                            (e, r) => e ? reject(e) : resolve(r ? r.c : 0)
                        ));
                    const invNumber = priorIssued === 0 ? baseNumber : `${baseNumber}-R${priorIssued + 1}`;

                    // Enrich booking with VAT flag and discount from quote
                    booking.apply_vat = applyVat;
                    booking.discount = discount;
                    booking.vat_rate = vatRate; // FIN-1/2: PDF uses the same rate as the server calc

                    // Generate PDF
                    const pdfFileName = `${invNumber}-${moment().format('YYYYMMDDHHmmss')}.pdf`;
                    const invoicesDir = path.join(__dirname, 'docs', 'invoices');
                    if (!fs.existsSync(invoicesDir)) fs.mkdirSync(invoicesDir, { recursive: true });
                    const pdfPath = path.join(invoicesDir, pdfFileName);

                    const paymentSchedules = await new Promise(resolve => {
                        db.all(
                            "SELECT description, due_date, expected_amount FROM payment_schedules WHERE booking_id = ? AND LOWER(COALESCE(status,'pending')) NOT IN ('superseded','cancelled') ORDER BY due_date ASC",
                            [bookingId],
                            (e, rows) => resolve(e ? [] : (rows || []))
                        );
                    });
                    // invNumber is passed through so the number on the client's PDF is the number in
                    // the ledger. generateDocument() otherwise derives `INV-<bookingId>-<YYMM>`, which
                    // has never matched invoices.invoice_number.
                    const pdfResult = await pdfService.generateDocument('Invoice', booking, items, pdfPath, paymentSchedules, invNumber);

                    // Create the invoice record. Voiding the superseded invoice, inserting the new
                    // invoice and its line items, and updating the booking are one atomic unit,
                    // queued behind every other guarded transaction on the shared connection.
                    const invoiceId = await withDbTransaction(async () => {
                        await dbRun("BEGIN IMMEDIATE");
                        try {
                            await dbRun("UPDATE invoices SET status='VOID', void_reason='superseded', voided_at=CURRENT_TIMESTAMP WHERE booking_id=? AND UPPER(status) NOT IN ('VOID','PAID')", [bookingId]);

                            const ins = await dbRun(`INSERT INTO invoices (booking_id, client_id, invoice_number, invoice_date, due_date, subtotal, tax_amount, total_amount, status, file_path)
                                    VALUES (?, ?, ?, CURRENT_DATE, date('now', '+7 days'), ?, ?, ?, 'SENT', ?)`,
                                [bookingId, booking.client_id, invNumber, subtotal, tax, total, pdfFileName]);
                            const newInvoiceId = ins.lastID;

                            // Sequential and error-checked. These previously ran as a parallel forEach
                            // whose error argument was ignored, so a failed line item still committed an
                            // invoice whose total no line item supported.
                            for (const item of items) {
                                await dbRun(`INSERT INTO invoice_line_items (invoice_id, description, quantity, unit_price)
                                             VALUES (?, ?, ?, ?)`,
                                    [newInvoiceId, item.description, item.quantity, item.unit_price]);
                            }

                            await dbRun("UPDATE bookings SET total_amount = ?, amount_outstanding = ?, payment_status = CASE WHEN payment_status IS NULL THEN 'UNPAID' ELSE payment_status END WHERE id = ?",
                                [total, total - (booking.amount_paid || 0), bookingId]);

                            await dbRun("COMMIT");
                            return newInvoiceId;
                        } catch (txErr) {
                            await dbRun("ROLLBACK").catch(() => {});
                            throw txErr;
                        }
                    });

                    // Side effects only after the commit.
                    try {
                        await sendInvoiceEmail(booking, pdfPath);
                        db.run("UPDATE invoices SET sent_at = CURRENT_TIMESTAMP WHERE id = ?", [invoiceId], () => {});
                    } catch (emErr) { console.error("Invoice Email Error:", emErr); }

                    resolve({ success: true, message: 'Invoice generated successfully', invoice_id: invoiceId, pdfUrl: `/docs/invoices/${pdfFileName}` });
                } catch (ex) {
                    console.error("Invoice Gen Error:", ex);
                    reject(ex);
                }
            });
        });
    });
}

app.get('/api/public/available-slots', async (req, res) => {
    const { start, end } = req.query; // YYYY-MM-DD
    if (!start || !end) return res.status(400).json({ success: false, message: 'Start and end dates required.' });

    try {
        const timeMin = moment(start).startOf('day').toISOString();
        const timeMax = moment(end).endOf('day').toISOString();

        // 1. Get Google Calendar Busy Slots
        const gcalResponse = await calendar.freebusy.query({
            requestBody: {
                timeMin,
                timeMax,
                items: [{ id: CALENDAR_ID }]
            }
        });
        const gcalBusy = gcalResponse.data.calendars[CALENDAR_ID].busy || [];

        // 2. Get Internal Bookings (already confirmed or quoted)
        db.all("SELECT date, event_start_time FROM bookings WHERE date >= ? AND date <= ? AND status NOT IN ('CANCELLED', 'REJECTED')", 
            [start, end], (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            
            const internalBusy = rows.map(r => ({
                start: moment(`${r.date} ${r.event_start_time || '18:00'}`).toISOString(),
                end: moment(`${r.date} ${r.event_start_time || '18:00'}`).add(2, 'hours').toISOString()
            }));

            res.json({
                success: true,
                busySlots: [...gcalBusy, ...internalBusy]
            });
        });
    } catch (error) {
        console.error('Error fetching availability:', error);
        res.status(500).json({ success: false, message: 'Could not fetch availability.' });
    }
});


// ==========================================
// BACKGROUND TASKS
// ==========================================

async function checkStuckNotifications() {
    db.get(
        `SELECT COUNT(*) AS count FROM notifications 
         WHERE status IN ('pending', 'sending') 
         AND datetime(created_at, '+10 minutes') < datetime('now')`,
        [],
        async (err, row) => {
            if (err) {
                console.error('[Background Clerk] Error checking stuck notifications:', err.message);
                return;
            }
            if (row && row.count > 0) {
                const count = row.count;
                db.all(
                    `SELECT id, recipient_email, subject, status, created_at FROM notifications 
                     WHERE status IN ('pending', 'sending') 
                     AND datetime(created_at, '+10 minutes') < datetime('now') 
                     ORDER BY created_at DESC LIMIT 5`,
                    [],
                    async (err2, details) => {
                        const notifEmail = await getNotificationEmail();
                        const { sendEmailDirectly } = require('./js/emailService');
                        const body = emailComponents.renderSystemEmail({
                            preheaderText: `${count} notification(s) stuck in the queue for over 10 minutes.`,
                            category: 'System',
                            severity: 'alert',
                            leadFact: `There are <strong style="color:#FAFAFA;">${count}</strong> notification(s) stuck in the queue for more than 10 minutes.`,
                            bodyHtml: `<p style="margin:0; color:#E6E6E6;">This may indicate that the background queue processor is down, experiencing high latency, or has crashed.</p>`,
                            cards: (details || []).length ? [{
                                title: 'Stuck Notifications',
                                rows: (details || []).map(d => ({ label: `#${d.id} — ${d.status}`, value: `To ${d.recipient_email} · ${d.created_at}`, mono: false }))
                            }] : []
                        });

                        await sendEmailDirectly({
                            to: notifEmail,
                            subject: `⚠️ Alert: ${count} Stuck Notification(s) in Queue`,
                            htmlContent: body,
                            preWrapped: true,
                            titleOverride: 'Stuck Notification Alert',
                            trigger_event: 'System: Stuck Notification Alert',
                            skipBrandAttachments: true
                        }).catch(sendErr => console.error('[Background Clerk] Failed to send stuck notifications alert:', sendErr.message));
                    }
                );
            }
        }
    );
}

/**
 * Periodically cleans up expired holds and pending bookings
 */
function startBackgroundClerk() {
    console.log('Starting [Background Clerk] - Monitoring holds and expirations...');
    
    // Sync Google Calendar holds every 15 minutes
    setInterval(syncCalendarHolds, 15 * 60 * 1000);
    // Also run it immediately on start
    syncCalendarHolds();

    // Sweep and process asynchronous email queue every 20 seconds
    setInterval(processNotificationQueue, 20 * 1000);
    processNotificationQueue();

    // Check for stuck email notifications every 10 minutes
    setInterval(checkStuckNotifications, 10 * 60 * 1000);
    // Run once on startup after 30 seconds
    setTimeout(checkStuckNotifications, 30 * 1000);

    setInterval(() => {
      try {
        const nowLocal = moment().tz('Africa/Johannesburg').format('YYYY-MM-DD HH:mm:ss');
        const todayLocal = moment().tz('Africa/Johannesburg').format('YYYY-MM-DD');
        const tomorrowLocal = moment().tz('Africa/Johannesburg').add(1, 'day').format('YYYY-MM-DD');
        const overdueLimitLocal = moment().tz('Africa/Johannesburg').subtract(7, 'days').format('YYYY-MM-DD HH:mm:ss');

        // S0: Promote stale NEW bookings to PENDING after 24 hours with no admin action
        db.all(`SELECT id, name, email, event_name, event_type, date FROM bookings
                WHERE status = 'NEW'
                AND datetime(created_at, '+24 hours') < ?`, [nowLocal], (err, rows) => {
            if (rows && rows.length > 0) {
                rows.forEach(row => {
                    db.run(`UPDATE bookings SET status='PENDING', pending_at=CURRENT_TIMESTAMP WHERE id=?`, [row.id]);
                    sendBookingUnderReviewEmail(row).catch(e => console.error(`[S0] Under-review email failed for #${row.id}:`, e.message));
                });
                console.log(`✓ [S0] Promoted ${rows.length} NEW booking(s) to PENDING after 24h.`);
            }
        });

        // S6: Auto-complete CONFIRMED fully-paid bookings whose event date has passed
        db.all(`SELECT id, event_id, name, email, event_name, event_type, date, event_location,
                       total_amount, amount_paid, quote_amount
                FROM bookings
                WHERE status = 'CONFIRMED'
                AND payment_status = 'PAID'
                AND date < ?`, [todayLocal], (err, rows) => {
            if (rows && rows.length > 0) {
                rows.forEach(row => {
                    db.run(`UPDATE bookings SET status='COMPLETED', completed_at=CURRENT_TIMESTAMP WHERE id=?`, [row.id]);
                    if (row.event_id) {
                        db.run("UPDATE events SET event_status = 'completed', modified_on = CURRENT_TIMESTAMP WHERE event_id = ? AND event_status NOT IN ('cancelled','completed')",
                            [row.event_id], (e) => { if (e) console.error('[AutoComplete] Event advance failed:', e.message); });
                    }
                    // Parity with manual completion (applyStatusChange): also mark the linked invoice PAID
                    // and send the admin completion summary — not just the client completion email.
                    db.run("UPDATE invoices SET status='PAID', updated_at=CURRENT_TIMESTAMP WHERE booking_id=? AND status NOT IN ('VOID','PAID')", [row.id],
                        (e) => { if (e) console.error('[S6] Invoice mark-paid failed:', e.message); });
                    sendBookingCompletedEmail(row).catch(e =>
                        console.error(`[S6] Completion email failed for #${row.id}:`, e.message)
                    );
                    db.get("SELECT * FROM bookings WHERE id = ?", [row.id], (e, full) => {
                        if (!e && full) sendAdminCompletionSummaryEmail(full).catch(err => console.error(`[S6] Admin completion summary failed for #${row.id}:`, err.message));
                    });
                });
                console.log(`✓ [S6] Auto-completed ${rows.length} fully-paid past-event booking(s) (completion + admin summary emails sent).`);
            }
        });

        // 1. Expire unquoted PENDING bookings after 48 hours of inactivity
        db.all(`SELECT id, name, email, event_name, event_type, date FROM bookings
                WHERE status = 'PENDING'
                AND datetime(created_at, '+48 hours') < ?`, [nowLocal], (err, rows) => {
            if (rows && rows.length > 0) {
                rows.forEach(row => {
                    db.run(`UPDATE bookings SET status = 'EXPIRED', message = COALESCE(message,'') || '\n[System: Expired due to 48h inactivity]' WHERE id = ?`, [row.id]);
                    sendPendingExpiredEmail(row).catch(e => console.error(`Expiry email failed for booking #${row.id}:`, e.message));
                });
                console.log(`✓ Expired ${rows.length} inactive pending requests (clients notified).`);
            }
        });

        // 2. Expire QUOTED bookings after quote_expiry_date
        db.all(`SELECT id, google_event_id, name, email, event_name, event_type, date FROM bookings
                WHERE status = 'QUOTED'
                AND quote_expiry_date < ?`, [todayLocal], (err, rows) => {
            if (rows && rows.length > 0) {
                rows.forEach(row => {
                    db.run("UPDATE bookings SET status = 'EXPIRED' WHERE id = ?", [row.id]);
                    if (row.google_event_id) deleteGoogleEvent(row.google_event_id);
                    sendQuoteExpiredEmail(row).catch(e => console.error(`Quote expiry email failed for booking #${row.id}:`, e.message));
                });
                console.log(`✓ Expired ${rows.length} overdue quotes (clients notified).`);
            }
        });

        // 3. Warn clients 24h before quote expires
        db.all(`SELECT id, name, email, event_name, event_type, date, quote_expiry_date
                FROM bookings WHERE status = 'QUOTED'
                AND date(quote_expiry_date) = ?
                AND quote_expiry_warned IS NULL`, [tomorrowLocal], (err, rows) => {
            if (rows && rows.length > 0) {
                rows.forEach(row => {
                    db.run("UPDATE bookings SET quote_expiry_warned = CURRENT_TIMESTAMP WHERE id = ?", [row.id]);
                    sendQuoteExpiryWarningEmail(row).catch(e => console.error('Quote warning email failed:', e.message));
                });
            }
        });

        // 3b. Warn the ADMIN about PENDING enquiries about to auto-expire — the final window
        // before step 1 auto-EXPIRES them at 48h from creation. Prevents leads being silently
        // lost. One digest per enquiry (pending_expiry_warned flag stops hourly re-spam).
        db.all(`SELECT id, name, email, event_name, event_type, date FROM bookings
                WHERE status = 'PENDING'
                AND datetime(created_at, '+24 hours') < ?
                AND datetime(created_at, '+48 hours') > ?
                AND pending_expiry_warned IS NULL`, [nowLocal, nowLocal], async (err, rows) => {
            if (rows && rows.length > 0) {
                const notifEmail = await getNotificationEmail();
                rows.forEach(row => {
                    db.run("UPDATE bookings SET pending_expiry_warned = CURRENT_TIMESTAMP WHERE id = ?", [row.id]);
                });
                const digestBody = emailComponents.renderSystemEmail({
                    preheaderText: `${rows.length} enquiry(ies) expiring within ~24 hours.`,
                    category: 'Booking Requests',
                    severity: 'action',
                    leadFact: `The following enquiries will <strong style="color:#FAFAFA;">auto-expire within the next ~24 hours</strong> unless a quote is sent — after which the client is notified their request lapsed.`,
                    bodyHtml: `<p style="margin:0; color:#E6E6E6;">Open the Bookings pipeline and send a quote to keep them alive.</p>`,
                    cards: [{
                        title: 'Expiring Enquiries',
                        rows: rows.map(r => ({ label: `#${r.id} — ${r.name}`, value: `${r.event_name || r.event_type || 'Event'}${r.date ? ' (event ' + r.date + ')' : ''}`, mono: false }))
                    }]
                });
                sendEmail({ to: notifEmail, subject: `Enquiries expiring soon – ${rows.length} pending request(s) need a quote`,
                    htmlContent: digestBody, preWrapped: true,
                    titleOverride: 'Enquiries Expiring Soon', trigger_event: 'Admin: Pending Expiry Warning' }).catch(() => {});
                console.log(`✓ [3b] Warned admin about ${rows.length} pending enquiry(ies) nearing auto-expiry.`);
            }
        });

        // 4. Overdue payment reminder (CONFIRMED, unpaid, event date passed)
        db.all(`SELECT b.*, COALESCE(c.email, b.email) as email, COALESCE(c.full_name, b.name) as name
                FROM bookings b LEFT JOIN clients c ON b.client_id = c.id
                WHERE b.status = 'CONFIRMED'
                AND b.payment_status NOT IN ('PAID')
                AND b.date < ?
                AND (b.overdue_reminded_at IS NULL OR b.overdue_reminded_at < ?)`, [todayLocal, overdueLimitLocal], async (err, rows) => {
            if (rows && rows.length > 0) {
                const notifEmail = await getNotificationEmail();
                rows.forEach(row => {
                    db.run("UPDATE bookings SET overdue_reminded_at = CURRENT_TIMESTAMP WHERE id = ?", [row.id]);
                });
                const totalOverdue = rows.reduce((sum, r) => sum + parseFloat(r.amount_outstanding || 0), 0);
                const digestBody = emailComponents.renderSystemEmail({
                    preheaderText: `${rows.length} overdue booking(s), R${totalOverdue.toFixed(2)} outstanding.`,
                    category: 'Payments & Invoices',
                    severity: 'alert',
                    leadFact: `The following confirmed bookings have unpaid balances with past event dates.`,
                    cards: [{
                        title: 'Overdue Bookings',
                        rows: rows.map(r => ({ label: `#${r.id} — ${r.name}`, value: `R${parseFloat(r.amount_outstanding || 0).toFixed(2)} outstanding`, mono: false }))
                    }]
                });
                sendEmail({ to: notifEmail, subject: `Overdue Payments – ${rows.length} booking(s), R${totalOverdue.toFixed(2)} due`,
                    htmlContent: digestBody, preWrapped: true,
                    titleOverride: 'Overdue Payment Alert', trigger_event: 'Admin: Overdue Payment Digest' }).catch(() => {});
            }
        });

        // 5. Pre-event balance reminders: 7, 3, 1 days before event for CONFIRMED bookings with outstanding balance
        for (const daysBefore of [7, 3, 1]) {
            const targetStr = moment().tz('Africa/Johannesburg').add(daysBefore, 'days').format('YYYY-MM-DD');

            db.all(`SELECT b.id, COALESCE(c.full_name, b.name) as name, COALESCE(c.email, b.email) as email,
                           b.event_name, b.event_type, b.date, b.amount_outstanding, b.total_amount
                    FROM bookings b LEFT JOIN clients c ON b.client_id = c.id
                    WHERE b.status = 'CONFIRMED'
                      AND b.date = ?
                      AND b.amount_outstanding > 0.01`,
                [targetStr], (err, rows) => {
                    if (err || !rows || rows.length === 0) return;
                    rows.forEach(row => {
                        // Idempotency keyed on the table's real columns. This used to SELECT and INSERT a
                        // `reminder_type` column that does not exist on reminders_log — the SELECT errored,
                        // its callback saw no prior row, so the reminder was RE-SENT every hour, and the
                        // INSERT errored too so nothing was ever recorded. These are event-based (not tied
                        // to a payment_schedules milestone), so schedule_id is NULL and days_before (7/3/1)
                        // distinguishes them; the milestone reminders (which always carry a non-NULL
                        // schedule_id) can never collide with this key.
                        db.get("SELECT id FROM reminders_log WHERE booking_id = ? AND schedule_id IS NULL AND days_before = ?",
                            [row.id, daysBefore], (e, existing) => {
                                if (e) { console.error(`Balance-due reminder lookup failed for #${row.id}:`, e.message); return; }
                                if (existing) return; // already sent this window — do not re-send
                                sendDepositBalanceDueEmail(row, row.amount_outstanding)
                                    .then(() => {
                                        db.run("INSERT OR IGNORE INTO reminders_log (booking_id, schedule_id, days_before, due_date, amount_due, recipient_email, status) VALUES (?, NULL, ?, ?, ?, ?, 'sent')",
                                            [row.id, daysBefore, row.date, row.amount_outstanding, row.email],
                                            (insErr) => { if (insErr) console.error(`Balance-due reminder log failed for #${row.id}:`, insErr.message); });
                                        console.log(`✓ Balance-due reminder (${daysBefore}d) sent for booking #${row.id}`);
                                    })
                                    .catch(e => console.error(`Balance-due reminder failed for #${row.id}:`, e.message));
                            });
                    });
                }
            );
        }

        // Google Calendar holds synchronization is run outside this interval to prevent duplicate timers

      } catch (clerkErr) {
          console.error('[Background Clerk] Unhandled error in interval:', clerkErr.message);
      }
    }, 3600000); // Run every hour
}

startBackgroundClerk();

/**
 * Data Retention Caretaker (POPIA Compliance)
 * Ensures data is not kept longer than necessary.
 */
function startDataRetentionCaretaker() {
    console.log('Starting [Compliance Caretaker] - Managing record retention...');
    setInterval(() => {
        // 1. Delete inactive newsletter subscribers (unsubscribed for > 1 year)
        db.run("DELETE FROM newsletter_subscribers WHERE status = 'unsubscribed' AND modified_on < date('now', '-1 year')", function(err) {
            if (this.changes > 0) console.log(`✓ POPIA: Removed ${this.changes} long-unsubscribed newsletter records.`);
        });

        // 2. Anonymize old inquiries (2 years)
        // We keep the record for stats but wipe PII
        db.run(`UPDATE inquiries
                SET sender_name = '[ANONYMIZED]', sender_email = 'deleted@po-pia.com', sender_phone = '0000000000', message_body = '[REDACTED]'
                WHERE submitted_at < date('now', '-2 years') AND sender_email != 'deleted@po-pia.com'`, function(err) {
            if (err) { console.error('✗ POPIA: Failed to anonymize stale inquiries:', err.message); return; }
            if (this.changes > 0) console.log(`✓ POPIA: Anonymized ${this.changes} stale inquiries.`);
        });

        // 3. Delete system logs (audit_log) older than 1 year
        db.run("DELETE FROM audit_log WHERE change_timestamp < date('now', '-1 year')", function(err) {
            if (this.changes > 0) console.log(`✓ Cleanup: Removed ${this.changes} old audit logs.`);
        });

    }, 86400000); // Run once every 24 hours
}

startDataRetentionCaretaker();

// Quote expiry lives in step 2 of the hourly Background Clerk cron (~line 1406), which flips
// QUOTED → EXPIRED *and* emails the client *and* releases the Google Calendar event.
//
// A second sweep used to live here. It ran at module load — i.e. on every single server start — and
// flipped QUOTED → EXPIRED with no email and no calendar cleanup. Because the hourly cron only
// matches `status = 'QUOTED'`, anything this sweep had already expired became invisible to it, so the
// client was never told their quote had lapsed. Removed; the hourly cron is the sole owner.

// Phase 4: Daily Overdue Auto-Flagging Cron Job (runs at 00:05 AM)
// Flag invoices and payment milestones as OVERDUE/overdue when past their due dates
function runDailyOverdueFlaggingSweep() {
    console.log('[cron] Starting daily overdue flagging sweep...');
    // Africa/Johannesburg, not UTC — SQLite's DATE('now') is UTC and SA is UTC+2, so an invoice due
    // "today" was flagged overdue up to two hours before the local business day ended.
    const todayLocal = moment().tz('Africa/Johannesburg').format('YYYY-MM-DD');
    db.serialize(() => {
        // 1. Flag invoices as OVERDUE
        db.run(
            `UPDATE invoices
             SET status = 'OVERDUE', updated_at = CURRENT_TIMESTAMP
             WHERE status = 'SENT'
               AND due_date IS NOT NULL
               AND due_date < ?`,
            [todayLocal],
            function(err) {
                if (err) {
                    console.error('[cron] Invoice overdue flagging error:', err.message);
                } else if (this.changes > 0) {
                    console.log(`[cron] Flagged ${this.changes} invoice(s) as OVERDUE.`);
                }
            }
        );

        // 2. Flag payment schedules as overdue
        db.run(
            `UPDATE payment_schedules
             SET status = 'overdue', updated_at = CURRENT_TIMESTAMP
             WHERE status = 'pending'
               AND due_date IS NOT NULL
               AND due_date < ?`,
            [todayLocal],
            function(err) {
                if (err) {
                    console.error('[cron] Payment schedule overdue flagging error:', err.message);
                } else if (this.changes > 0) {
                    console.log(`[cron] Flagged ${this.changes} payment schedule milestone(s) as overdue.`);
                }
            }
        );
    });
}
runDailyOverdueFlaggingSweep();
schedule.scheduleJob('5 0 * * *', runDailyOverdueFlaggingSweep);

// Admin: Generic Stats & System Monitor
// ==========================================

// Middleware to protect admin routes (rate-limited + session-checked)
const requireAdmin = [
    adminRateLimiter,
    (req, res, next) => {
        if (req.session && req.session.adminId) {
            if (req.session.must_change_password) {
                const allowedRoutes = ['/force-change-password', '/logout', '/session'];
                const isAllowed = allowedRoutes.some(route => req.path.endsWith(route));
                if (!isAllowed) {
                    return res.status(403).json({ success: false, message: 'Password change required.', must_change_password: true });
                }
            }
            // Re-check suspension on every request so a suspension takes effect immediately,
            // not just on the next login. One extra indexed lookup per admin request (accepted cost).
            db.get("SELECT is_active FROM admins WHERE id = ?", [req.session.adminId], (err, row) => {
                if (err) return res.status(500).json({ success: false, message: 'Database error.' });
                if (!row || row.is_active === 0) {
                    return req.session.destroy(() => {
                        res.status(403).json({ success: false, message: 'This account has been suspended. Contact an administrator.' });
                    });
                }
                return next();
            });
            return;
        }
        return res.status(401).json({ success: false, message: 'Unauthorized. Please log in.' });
    }
];

// Middleware to enforce role restrictions (RBAC)
const requireRole = (allowedRoles) => {
    return (req, res, next) => {
        const userRole = req.session.role || 'assistant';
        if (allowedRoles.includes(userRole)) {
            return next();
        }
        return res.status(403).json({ success: false, message: 'Forbidden: Insufficient permissions.' });
    };
};

// Restricts direct_emails mutations to administrator/manager only when the email is linked to an
// inquiry (reply-sending) — assistants keep freeform (non-inquiry) compose access. inquiry_id is
// immutable after creation (POST never lets it be changed by PUT), so update/send routes look it
// up from the existing row rather than trusting the request body.
const requireRoleForInquiryEmail = (req, res, next) => {
    const role = req.session.role || 'assistant';
    if (role === 'administrator' || role === 'manager') return next();
    if (req.method === 'POST' && req.path === '/api/admin/direct-emails') {
        if (req.body && req.body.inquiry_id) {
            return res.status(403).json({ success: false, message: 'Forbidden: Insufficient permissions.' });
        }
        return next();
    }
    db.get("SELECT inquiry_id FROM direct_emails WHERE id = ?", [req.params.id], (err, row) => {
        if (row && row.inquiry_id) {
            return res.status(403).json({ success: false, message: 'Forbidden: Insufficient permissions.' });
        }
        return next();
    });
};

// Admin role constants + last-administrator guard helper (shared by /api/admin/users CRUD)
const VALID_ADMIN_ROLES = ['administrator', 'manager', 'assistant'];

function countOtherActiveAdministrators(excludeUserId, callback) {
    db.get(
        "SELECT COUNT(*) AS count FROM admins WHERE role = 'administrator' AND is_active = 1 AND id != ?",
        [excludeUserId], callback
    );
}

// ════════════════════════════════════════════════════════════════════════════
// ANALYTICS — first-party visitor tracking + dashboard endpoints
// ════════════════════════════════════════════════════════════════════════════

// Classify a visit into a marketing channel from its referrer + UTM params
function classifyChannel(referrer, utmSource, utmMedium) {
    if (utmMedium === 'email' || utmSource === 'email') return 'Email';
    if (utmMedium === 'cpc' || utmMedium === 'ppc' || utmMedium === 'paid') return 'Paid Search';
    if (utmSource || utmMedium || utmMedium === 'social') {
        const socialHosts = ['facebook', 'instagram', 'twitter', 'x.com', 'tiktok', 'linkedin', 'youtube', 'wa.me'];
        if (socialHosts.some(h => (utmSource || '').toLowerCase().includes(h))) return 'Social';
        return 'Campaign';
    }
    if (!referrer) return 'Direct';
    try {
        const host = new URL(referrer).hostname.replace('www.', '');
        const searchEngines = ['google', 'bing', 'yahoo', 'duckduckgo', 'baidu', 'yandex'];
        if (searchEngines.some(e => host.includes(e))) return 'Organic Search';
        const socialDomains = ['facebook.com', 'instagram.com', 'twitter.com', 'x.com', 'tiktok.com',
                               'linkedin.com', 'youtube.com', 't.co', 'wa.me'];
        if (socialDomains.some(d => host.includes(d))) return 'Social';
        return 'Referral';
    } catch (_) {
        return 'Direct';
    }
}

// POST /api/public/analytics/track — no auth required; IP discarded after geo lookup
app.post('/api/public/analytics/track', analyticsTrackLimiter, (req, res) => {
    // Respond immediately so the beacon gets a fast 204
    res.status(204).end();

    try {
        const { event, visitor_id, session_id, page, referrer,
                utm_source, utm_medium, utm_campaign, dwell } = req.body || {};

        if (!visitor_id || !session_id || !event) return;

        // Geo — extract country from IP then discard the IP
        const ip  = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
        const geo = geoip.lookup(ip) || {};
        const countryCode = geo.country || 'ZZ';
        const countryName = geo.country || 'Unknown'; // geoip-lite returns ISO alpha-2

        // UA parsing — no raw storage of UA string
        const uaResult  = new UAParser(req.headers['user-agent']).getResult();
        const browser   = (uaResult.browser.name || 'Unknown') + ' ' + (uaResult.browser.major || '');
        const os        = uaResult.os.name || 'Unknown';
        const deviceType = (uaResult.device.type || 'desktop').toLowerCase();

        // Derived fields
        const referrerHost = (() => {
            try { return referrer ? new URL(referrer).hostname.replace('www.', '') : ''; } catch (_) { return ''; }
        })();
        const channel = classifyChannel(referrer || '', utm_source || '', utm_medium || '');

        if (event === 'pageview') {
            // Upsert session
            db.run(`INSERT INTO analytics_sessions
                        (session_id, visitor_id, started_at, entry_page, exit_page,
                         country_code, country_name, device_type, browser, os,
                         channel, referrer_host, utm_source, utm_medium, utm_campaign)
                    VALUES (?, ?, CURRENT_TIMESTAMP, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(session_id) DO UPDATE SET
                        exit_page   = excluded.entry_page,
                        page_count  = page_count + 1,
                        is_bounce   = 0,
                        ended_at    = CURRENT_TIMESTAMP`,
                [session_id, visitor_id, page || '/', page || '/',
                 countryCode, countryName, deviceType, browser.trim(), os,
                 channel, referrerHost, utm_source || '', utm_medium || '', utm_campaign || ''],
                (err) => { if (err) console.error('[analytics] session upsert:', err.message); }
            );

            // Insert page view
            db.run(`INSERT INTO analytics_pageviews
                        (session_id, visitor_id, page, referrer, referrer_host, channel,
                         utm_source, utm_medium, utm_campaign, country_code, country_name,
                         device_type, browser, os)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [session_id, visitor_id, page || '/', referrer || '', referrerHost, channel,
                 utm_source || '', utm_medium || '', utm_campaign || '',
                 countryCode, countryName, deviceType, browser.trim(), os],
                (err) => { if (err) console.error('[analytics] pageview insert:', err.message); }
            );

        } else if (event === 'heartbeat' || event === 'page_exit') {
            const dwellSecs = parseInt(dwell, 10) || 0;
            if (dwellSecs > 0 && dwellSecs < 7200) { // sanity cap: 2 hours
                db.run(`UPDATE analytics_pageviews
                        SET dwell_seconds = MAX(dwell_seconds, ?)
                        WHERE session_id = ? AND page = ?
                          AND id = (SELECT MAX(id) FROM analytics_pageviews
                                    WHERE session_id = ? AND page = ?)`,
                    [dwellSecs, session_id, page || '/', session_id, page || '/'],
                    (err) => { if (err) console.error('[analytics] dwell update:', err.message); }
                );
                db.run(`UPDATE analytics_sessions
                        SET total_dwell_seconds = ?, ended_at = CURRENT_TIMESTAMP
                        WHERE session_id = ?`,
                    [dwellSecs, session_id]
                );
            }
        }
    } catch (e) {
        console.error('[analytics] track handler error:', e.message);
    }
});

// ── Helper: parse ?period= query param into a [start, end] date range ────────
function getAnalyticsDates(query) {
    const period = query.period || '30d';
    const days   = period === '7d' ? 7 : period === '90d' ? 90 : 30;
    const end    = new Date();
    const start  = new Date(Date.now() - days * 864e5);
    return {
        start: start.toISOString().split('T')[0],
        end:   end.toISOString().split('T')[0]
    };
}

// GET /api/admin/analytics/summary?period=7d|30d|90d
app.get('/api/admin/analytics/summary', requireAdmin, (req, res) => {
    const { start, end } = getAnalyticsDates(req.query);
    db.get(`
        SELECT
            COUNT(*)                                        AS pageviews,
            COUNT(DISTINCT visitor_id)                      AS unique_visitors,
            COUNT(DISTINCT session_id)                      AS sessions
        FROM analytics_pageviews
        WHERE date(viewed_at) BETWEEN ? AND ?`,
        [start, end],
        (err, row) => {
            if (err) return res.status(500).json({ success: false });
            db.get(`
                SELECT
                    AVG(total_dwell_seconds)                    AS avg_dwell,
                    100.0 * SUM(is_bounce) / NULLIF(COUNT(*),0) AS bounce_rate
                FROM analytics_sessions
                WHERE date(started_at) BETWEEN ? AND ?`,
                [start, end],
                (err2, sess) => {
                    if (err2) return res.status(500).json({ success: false });
                    res.json({
                        success: true,
                        period: { start, end },
                        pageviews:        row ? row.pageviews        : 0,
                        unique_visitors:  row ? row.unique_visitors  : 0,
                        sessions:         row ? row.sessions         : 0,
                        avg_dwell_secs:   sess ? Math.round(sess.avg_dwell  || 0) : 0,
                        bounce_rate:      sess ? Math.round(sess.bounce_rate || 0) : 0
                    });
                }
            );
        }
    );
});

// GET /api/admin/analytics/visits-over-time?period=7d|30d|90d
app.get('/api/admin/analytics/visits-over-time', requireAdmin, (req, res) => {
    const { start, end } = getAnalyticsDates(req.query);
    const period = req.query.period || '30d';
    // 90-day view groups by week; otherwise by day
    const groupFmt = period === '90d' ? `strftime('%Y-W%W', viewed_at)` : `date(viewed_at)`;
    db.all(`
        SELECT
            ${groupFmt}                  AS label,
            COUNT(*)                     AS pageviews,
            COUNT(DISTINCT visitor_id)   AS unique_visitors
        FROM analytics_pageviews
        WHERE date(viewed_at) BETWEEN ? AND ?
        GROUP BY label
        ORDER BY label ASC`,
        [start, end],
        (err, rows) => {
            if (err) return res.status(500).json({ success: false });
            res.json({ success: true, rows: rows || [] });
        }
    );
});

// GET /api/admin/analytics/traffic-sources?period=7d|30d|90d
app.get('/api/admin/analytics/traffic-sources', requireAdmin, (req, res) => {
    const { start, end } = getAnalyticsDates(req.query);
    db.all(`
        SELECT channel, COUNT(*) AS pageviews
        FROM analytics_pageviews
        WHERE date(viewed_at) BETWEEN ? AND ? AND channel IS NOT NULL
        GROUP BY channel
        ORDER BY pageviews DESC
        LIMIT 10`,
        [start, end],
        (err, rows) => {
            if (err) return res.status(500).json({ success: false });
            res.json({ success: true, rows: rows || [] });
        }
    );
});

// GET /api/admin/analytics/top-referrers?period=7d|30d|90d
app.get('/api/admin/analytics/top-referrers', requireAdmin, (req, res) => {
    const { start, end } = getAnalyticsDates(req.query);
    db.all(`
        SELECT referrer_host AS host, COUNT(*) AS pageviews
        FROM analytics_pageviews
        WHERE date(viewed_at) BETWEEN ? AND ?
          AND referrer_host IS NOT NULL AND referrer_host != ''
        GROUP BY referrer_host
        ORDER BY pageviews DESC
        LIMIT 8`,
        [start, end],
        (err, rows) => {
            if (err) return res.status(500).json({ success: false });
            res.json({ success: true, rows: rows || [] });
        }
    );
});

// GET /api/admin/analytics/devices?period=7d|30d|90d
app.get('/api/admin/analytics/devices', requireAdmin, (req, res) => {
    const { start, end } = getAnalyticsDates(req.query);
    db.all(`
        SELECT device_type, COUNT(*) AS pageviews
        FROM analytics_pageviews
        WHERE date(viewed_at) BETWEEN ? AND ?
        GROUP BY device_type
        ORDER BY pageviews DESC`,
        [start, end],
        (err, rows) => {
            if (err) return res.status(500).json({ success: false });
            res.json({ success: true, rows: rows || [] });
        }
    );
});

// GET /api/admin/analytics/countries?period=7d|30d|90d
// Top visitor countries — gauges fanbase geography & prospective touring markets
app.get('/api/admin/analytics/countries', requireAdmin, (req, res) => {
    const { start, end } = getAnalyticsDates(req.query);
    db.all(`
        SELECT
            COALESCE(NULLIF(country_name, ''), 'Unknown') AS country,
            MAX(country_code)                             AS code,
            COUNT(*)                                      AS pageviews,
            COUNT(DISTINCT visitor_id)                    AS visitors
        FROM analytics_pageviews
        WHERE date(viewed_at) BETWEEN ? AND ?
        GROUP BY country
        ORDER BY visitors DESC, pageviews DESC
        LIMIT 8`,
        [start, end],
        (err, rows) => {
            if (err) return res.status(500).json({ success: false });
            res.json({ success: true, rows: rows || [] });
        }
    );
});

// GET /api/admin/analytics/top-pages?period=7d|30d|90d
// Most-viewed pages — reveals which content (events, gallery, booking) resonates
app.get('/api/admin/analytics/top-pages', requireAdmin, (req, res) => {
    const { start, end } = getAnalyticsDates(req.query);
    db.all(`
        SELECT
            page                        AS page,
            COUNT(*)                    AS pageviews,
            COUNT(DISTINCT visitor_id)  AS visitors
        FROM analytics_pageviews
        WHERE date(viewed_at) BETWEEN ? AND ?
          AND page IS NOT NULL AND page != ''
        GROUP BY page
        ORDER BY pageviews DESC
        LIMIT 8`,
        [start, end],
        (err, rows) => {
            if (err) return res.status(500).json({ success: false });
            res.json({ success: true, rows: rows || [] });
        }
    );
});

// GET /api/admin/analytics/bookings-trend?period=7d|30d|90d
// Uses existing bookings table — no tracker data required
app.get('/api/admin/analytics/bookings-trend', requireAdmin, (req, res) => {
    const { start, end } = getAnalyticsDates(req.query);
    db.all(`
        SELECT
            date(created_at)  AS label,
            COUNT(*)          AS bookings,
            SUM(CASE WHEN status IN ('CONFIRMED','COMPLETED','QUOTED','ACCEPTED') THEN 1 ELSE 0 END) AS confirmed
        FROM bookings
        WHERE date(created_at) BETWEEN ? AND ?
        GROUP BY label
        ORDER BY label ASC`,
        [start, end],
        (err, rows) => {
            if (err) return res.status(500).json({ success: false });
            res.json({ success: true, rows: rows || [] });
        }
    );
});

// GET /api/admin/analytics/todays-schedule
// Returns today's full calendar: confirmed bookings + active holds + public events
app.get('/api/admin/analytics/todays-schedule', requireAdmin, (req, res) => {
    const today = new Date().toISOString().split('T')[0];
    const results = [];

    db.serialize(() => {
        // 1. Confirmed/accepted/completed bookings (with client + venue names)
        db.all(`
            SELECT b.event_name                         AS title,
                   b.event_start_time                   AS start_time,
                   COALESCE(v.name, b.event_location)   AS location,
                   b.status                             AS type,
                   'booking'                            AS source,
                   COALESCE(c.full_name, b.name)        AS client_name
            FROM bookings b
            LEFT JOIN clients c ON b.client_id = c.id
            LEFT JOIN venues  v ON b.venue_id  = v.id
            WHERE b.date = ? AND b.status IN ('CONFIRMED','ACCEPTED','COMPLETED')`,
            [today],
            (err, rows) => { if (!err && rows) results.push(...rows); }
        );

        // 2. Active date holds / manual calendar blocks
        db.all(`
            SELECT COALESCE(NULLIF(notes, ''), block_type, 'Hold') AS title,
                   start_time,
                   NULL          AS location,
                   block_type    AS type,
                   'hold'        AS source,
                   NULL          AS client_name
            FROM date_holds
            WHERE hold_date = ? AND status = 'active'`,
            [today],
            (err, rows) => { if (!err && rows) results.push(...rows); }
        );

        // 3. Public events scheduled today (non-draft)
        db.all(`
            SELECT e.event_title      AS title,
                   e.event_start_time AS start_time,
                   v.name             AS location,
                   e.event_status     AS type,
                   'event'            AS source,
                   NULL               AS client_name
            FROM events e
            LEFT JOIN venues v ON e.venue_id = v.id
            WHERE date(e.event_datetime) = ? AND e.event_status != 'draft'`,
            [today],
            (err, rows) => {
                if (!err && rows) results.push(...rows);
                // Sort by start_time ASC, nulls last
                results.sort((a, b) => {
                    if (!a.start_time) return 1;
                    if (!b.start_time) return -1;
                    return a.start_time.localeCompare(b.start_time);
                });
                res.json({ success: true, rows: results.slice(0, 15) });
            }
        );
    });
});

// Aggregate yesterday's analytics into analytics_daily (runs at 00:06 each day,
// staggered after the 00:05 overdue-flagging sweep)
schedule.scheduleJob('6 0 * * *', function () {
    const yesterday = new Date(Date.now() - 864e5).toISOString().split('T')[0];
    db.get(`
        SELECT
            COUNT(*)                     AS pageviews,
            COUNT(DISTINCT visitor_id)   AS unique_visitors,
            COUNT(DISTINCT session_id)   AS sessions
        FROM analytics_pageviews
        WHERE date(viewed_at) = ?`, [yesterday],
        (err, row) => {
            if (err || !row) return;
            db.get(`
                SELECT
                    SUM(is_bounce)          AS bounced,
                    SUM(total_dwell_seconds) AS dwell_sum
                FROM analytics_sessions
                WHERE date(started_at) = ?`, [yesterday],
                (err2, sess) => {
                    if (err2) return;
                    db.run(`INSERT INTO analytics_daily (date, pageviews, unique_visitors, sessions, bounced_sessions, total_dwell_secs)
                            VALUES (?, ?, ?, ?, ?, ?)
                            ON CONFLICT(date) DO UPDATE SET
                                pageviews        = excluded.pageviews,
                                unique_visitors  = excluded.unique_visitors,
                                sessions         = excluded.sessions,
                                bounced_sessions = excluded.bounced_sessions,
                                total_dwell_secs = excluded.total_dwell_secs`,
                        [yesterday,
                         row.pageviews       || 0,
                         row.unique_visitors || 0,
                         row.sessions        || 0,
                         (sess && sess.bounced)    || 0,
                         (sess && sess.dwell_sum)  || 0]
                    );
                    console.log('[analytics] Daily roll-up complete for', yesterday);
                }
            );
        }
    );
});

// Admin Login Route — P3-13: protected by tight brute-force rate limiter (5 attempts / 10 min)
app.post('/api/admin/login', adminLoginRateLimiter, (req, res) => {
    const { email, password, remember_me } = req.body;

    if (!email || !password) {
        return res.status(400).json({ success: false, message: 'Email and password are required.' });
    }
    const normalizedEmail = String(email).trim().toLowerCase();

    db.get("SELECT * FROM admins WHERE email = ?", [normalizedEmail], (err, row) => {
        if (err) return res.status(500).json({ success: false, message: 'Database error' });
        if (!row) return res.status(401).json({ success: false, message: 'Invalid credentials' });

        bcrypt.compare(password, row.password_hash, (err, isMatch) => {
            if (err) return res.status(500).json({ success: false, message: 'Error checking password' });
            if (isMatch) {
                if (row.is_active === 0) {
                    return res.status(403).json({ success: false, message: 'This account has been suspended. Contact an administrator.' });
                }
                req.session.adminId = row.id;
                req.session.username = row.username;
                req.session.role = row.role || 'manager';
                req.session.must_change_password = row.must_change_password ? true : false;
                // Remember me: 30-day persistent cookie; otherwise session-only (expires on browser close)
                req.session.cookie.maxAge = remember_me ? 1000 * 60 * 60 * 24 * 30 : null;
                
                db.run("UPDATE admins SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?", [row.id], () => {});
                
                const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
                const ua = req.headers['user-agent'] || '';
                
                db.run(
                    `INSERT INTO admin_login_logs (admin_id, ip_address, user_agent) VALUES (?, ?, ?)`,
                    [row.id, ip, ua],
                    function(insertErr) {
                        if (!insertErr) {
                            req.session.loginLogId = this.lastID;
                        }
                        req.session.save((saveErr) => {
                            if (saveErr) console.error('Error saving session after login:', saveErr);
                            return res.json({ success: true, message: 'Login successful', role: row.role || 'manager', must_change_password: row.must_change_password ? true : false });
                        });
                    }
                );
            } else {
                return res.status(401).json({ success: false, message: 'Invalid credentials' });
            }
        });
    });
});

// Force Password Change Route
app.post('/api/admin/force-change-password', requireAdmin, (req, res) => {
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 8) {
        return res.status(400).json({ success: false, message: 'Password must be at least 8 characters long.' });
    }
    bcrypt.hash(newPassword, 10, (err, hash) => {
        if (err) return res.status(500).json({ success: false, message: 'Server error hashing password.' });
        db.run("UPDATE admins SET password_hash = ?, must_change_password = 0 WHERE id = ?", [hash, req.session.adminId], (updateErr) => {
            if (updateErr) return res.status(500).json({ success: false, message: 'Failed to update password.' });
            req.session.must_change_password = false;
            return res.json({ success: true, message: 'Password successfully updated. Access restored.' });
        });
    });
});

// Admin Logout Route
app.post('/api/admin/logout', (req, res) => {
    const loginLogId = req.session ? req.session.loginLogId : null;
    const finalizeLogout = () => {
        req.session.destroy((err) => {
            if (err) {
                return res.status(500).json({ success: false, message: 'Error during logout' });
            }
            res.clearCookie('connect.sid'); // default cookie name
            return res.json({ success: true, message: 'Logged out successfully' });
        });
    };

    if (loginLogId) {
        db.run(
            `UPDATE admin_login_logs 
             SET logout_at = CURRENT_TIMESTAMP, 
                 last_activity_at = CURRENT_TIMESTAMP,
                 duration_seconds = CAST((strftime('%s', 'now') - strftime('%s', login_at)) AS INTEGER)
             WHERE id = ?`,
            [loginLogId],
            (err) => {
                if (err) console.error('Error finalising login log on logout:', err.message);
                finalizeLogout();
            }
        );
    } else {
        finalizeLogout();
    }
});

// Admin session check
app.get('/api/admin/session', (req, res) => {
    if (req.session && req.session.adminId) {
        // Try ID first
        db.get("SELECT id, username, email, full_name, phone, role, is_active, last_login_at, created_at FROM admins WHERE id = ?", [req.session.adminId], (err, row) => {
            if (!err && row) {
                req.session.role = row.role || 'manager'; // sync in session
                return res.json({ success: true, id: row.id, username: row.username, email: row.email || '', full_name: row.full_name || '', phone: row.phone || '', role: row.role || 'manager', is_active: row.is_active, last_login_at: row.last_login_at, created_at: row.created_at });
            }
            // Fallback to username if ID failed but username exists in session
            if (req.session.username) {
                db.get("SELECT id, username, email, full_name, phone, role, is_active, last_login_at, created_at FROM admins WHERE username = ?", [req.session.username], (err2, row2) => {
                    if (!err2 && row2) {
                        // Refresh session ID while we're at it
                        req.session.adminId = row2.id;
                        req.session.role = row2.role || 'manager';
                        return res.json({ success: true, id: row2.id, username: row2.username, email: row2.email || '', full_name: row2.full_name || '', phone: row2.phone || '', role: row2.role || 'manager', is_active: row2.is_active, last_login_at: row2.last_login_at, created_at: row2.created_at });
                    }
                    return res.json({ success: true, id: req.session.adminId, username: req.session.username || '', role: req.session.role || 'manager' });
                });
            } else {
                return res.json({ success: true, id: req.session.adminId, username: req.session.username || '', role: req.session.role || 'manager' });
            }
        });
    } else {
        return res.status(401).json({ success: false, message: 'Not logged in.' });
    }
});



// Generate a set-password token and queue a branded invitation email for a new/pending admin user.
// Reuses the password_reset_tokens table + sendEmail pipeline. callback receives the sendEmail result.
function createAndSendInvite(user, expiresHours, callback) {
    callback = callback || function () {};
    const rawToken = crypto.randomBytes(32).toString('hex');
    bcrypt.hash(rawToken, 10, (err, hash) => {
        if (err) { console.error('Invite token hash error:', err); return callback({ success: false, error: err.message }); }
        const expiresAt = new Date(Date.now() + (expiresHours || 72) * 3600000).toISOString();
        db.run(
            "INSERT INTO password_reset_tokens (admin_id, token_hash, expires_at) VALUES (?, ?, ?)",
            [user.id, hash, expiresAt],
            function (insertErr) {
                if (insertErr) { console.error('Invite token store error:', insertErr); return callback({ success: false, error: insertErr.message }); }

                const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
                const inviteLink = `${baseUrl}/reset-password.html?token=${rawToken}&email=${encodeURIComponent(user.email)}&welcome=1`;
                const roleLabel = (user.role || 'manager').charAt(0).toUpperCase() + (user.role || 'manager').slice(1);
                const greetName = (user.full_name && String(user.full_name).trim()) ? user.full_name : 'there';

                // SECURITY-CRITICAL (HIGH): inviteLink, expiry hours and user.email kept verbatim.
                // The old class="btn-luxe"/class="text-muted" only resolve via the legacy wrapper's
                // <style> block, absent on the live raw path — the button/muted text render unstyled
                // today. Uses the bulletproof ctaButton component directly (works in Outlook too).
                const emailBody = emailComponents.renderSystemEmail({
                    preheaderText: `You've been added as a ${roleLabel} to the Thabiso Mhlongo dashboard.`,
                    category: 'User Accounts & Security',
                    severity: 'action',
                    leadFact: `Hello <strong style="color:#FAFAFA;">${greetName}</strong> — you've been added as a <strong style="color:#FAFAFA;">${roleLabel}</strong> to the Thabiso Mhlongo management dashboard.`,
                    bodyHtml:
                        `<p style="margin:0 0 18px; color:#E6E6E6;">To activate your account, set your password using the secure link below. This link will safely expire in ${expiresHours || 72} hours.</p>` +
                        emailComponents.ctaButton({ label: 'Set Your Password', url: inviteLink }) +
                        `<p style="margin:18px 0 0; color:#E6E6E6;">Your sign-in email is <strong style="color:#FAFAFA;">${user.email}</strong>.</p>` +
                        `<p style="margin:10px 0 0; color:#B0B0B0; font-size:12px;">If you weren't expecting this invitation, you can safely ignore this automated message.</p>`
                });

                sendEmail({
                    to: user.email,
                    subject: "You're invited to the Thabiso Mhlongo Management Dashboard",
                    htmlContent: emailBody,
                    preWrapped: true,
                    titleOverride: 'Management Dashboard',
                    trigger_event: 'Admin: User Invitation'
                }).then(result => {
                    if (!result.success) console.error('Email Service Error sending invite email:', result.error);
                    callback(result);
                }).catch(e => { console.error('Panic in sendEmail (Invite):', e); callback({ success: false, error: String(e) }); });
            }
        );
    });
}

// Admin Forgot Password
app.post('/api/admin/forgot-password', (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, message: "Email is required." });

    // 1. Check if the email exists in the admins table
    db.get("SELECT id, username FROM admins WHERE email = ?", [email], (err, admin) => {
        if (err) {
            console.error("Database error looking up admin email:", err);
            // Generic message for security
            return res.json({ success: true, message: "If your email is registered, you will receive a reset link shortly." });
        }

        if (!admin) {
            // Do not leak email existence.
            return res.json({ success: true, message: "If your email is registered, you will receive a reset link shortly." });
        }

        // 2. Generate secure token
        const rawToken = crypto.randomBytes(32).toString('hex');
        
        // 3. Hash the token for database storage
        bcrypt.hash(rawToken, 10, (err, hash) => {
            if (err) {
                console.error("Error hashing reset token:", err);
                return res.status(500).json({ success: false, message: "Internal server error." });
            }

            // 4. Store the hash in password_reset_tokens table (expires in 1 hour)
            const expiresAt = new Date(Date.now() + 3600000).toISOString(); // 1 hour from now
            
            db.run(
                "INSERT INTO password_reset_tokens (admin_id, token_hash, expires_at) VALUES (?, ?, ?)",
                [admin.id, hash, expiresAt],
                function(insertErr) {
                    if (insertErr) {
                        console.error("Error storing reset token:", insertErr);
                        return res.status(500).json({ success: false, message: "Internal server error." });
                    }

                    // 5. Build and send the premium email with the RAW token
                    const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
                    const resetLink = `${baseUrl}/reset-password.html?token=${rawToken}&email=${encodeURIComponent(email)}`;
                    
                    // SECURITY-CRITICAL (HIGH): resetLink and the 1-hour expiry wording kept verbatim.
                    // Same dead class="btn-luxe"/class="text-muted" defect as the invite email.
                    const emailBody = emailComponents.renderSystemEmail({
                        preheaderText: 'A password reset was requested for your dashboard account.',
                        category: 'User Accounts & Security',
                        severity: 'action',
                        leadFact: `Hello <strong style="color:#FAFAFA;">${admin.username}</strong> — we received a request to reset the administrative password associated with this email address.`,
                        bodyHtml:
                            `<p style="margin:0 0 18px; color:#E6E6E6;">You can reset your password by clicking the secure link below. This link will safely expire in 1 hour.</p>` +
                            emailComponents.ctaButton({ label: 'Reset Password', url: resetLink }) +
                            `<p style="margin:18px 0 0; color:#B0B0B0; font-size:12px;">If you did not request a password reset, you can safely ignore this automated message.</p>`
                    });

                    sendEmail({
                        to: email,
                        subject: 'Password Reset Request - Thabiso Mhlongo Dashboard',
                        htmlContent: emailBody,
                        preWrapped: true,
                        titleOverride: 'Management Dashboard',
                        trigger_event: 'Admin: Password Reset Request'
                    }).then(result => {
                        if (!result.success) console.error('Email Service Error sending reset email:', result.error);
                    }).catch(e => console.error('Panic in sendEmail (Reset):', e));

                    // Generic success to prevent user enumeration
                    return res.json({ success: true, message: "If your email is registered, you will receive a reset link shortly." });
                }
            );
        });
    });
});

// Admin Verify and Reset Password 
app.post('/api/admin/reset-password', (req, res) => {
    const { email, token, newPassword } = req.body;

    if (!email || !token || !newPassword) {
        return res.status(400).json({ success: false, message: "Missing required fields." });
    }

    if (newPassword.length < 8) {
        return res.status(400).json({ success: false, message: "Password must be at least 8 characters long." });
    }

    // 1. Lookup the admin to get their ID
    db.get("SELECT id FROM admins WHERE email = ?", [email], (err, admin) => {
        if (err || !admin) {
            return res.status(400).json({ success: false, message: "Invalid request sequence." });
        }

        // 2. Lookup unexpired tokens for this admin
        db.all(
            "SELECT id, token_hash FROM password_reset_tokens WHERE admin_id = ? AND expires_at > CURRENT_TIMESTAMP",
            [admin.id],
            (err, tokens) => {
                if (err) return res.status(500).json({ success: false, message: "Database error." });
                if (!tokens || tokens.length === 0) {
                    return res.status(400).json({ success: false, message: "Invalid or expired reset token." });
                }

                // 3. Verify the token using bcrypt.compare against active rows
                let validTokenRow = null;
                let checksPending = tokens.length;
                let responseSent = false;

                tokens.forEach(row => {
                    bcrypt.compare(token, row.token_hash, (err, isMatch) => {
                        if (responseSent) return;

                        if (err) {
                            console.error("Bcrypt compare error:", err);
                        } else if (isMatch) {
                            validTokenRow = row;
                        }

                        checksPending--;
                        if (checksPending === 0) {
                            if (!validTokenRow) {
                                responseSent = true;
                                return res.status(400).json({ success: false, message: "Invalid or expired reset token." });
                            }

                            // 4. Token Valid! Hash new password and update admins table
                            bcrypt.hash(newPassword, 10, (err, newHash) => {
                                if (err) {
                                    responseSent = true;
                                    return res.status(500).json({ success: false, message: "Error securely hashing new password." });
                                }

                                db.run(
                                    "UPDATE admins SET password_hash = ?, must_change_password = 0 WHERE id = ?",
                                    [newHash, admin.id],
                                    function(updateErr) {
                                        if (updateErr) {
                                            responseSent = true;
                                            return res.status(500).json({ success: false, message: "Error updating password." });
                                        }

                                        // 5. Consume/Delete the used token
                                        db.run("DELETE FROM password_reset_tokens WHERE id = ?", [validTokenRow.id], () => {
                                            responseSent = true;
                                            return res.json({ success: true, message: "Password has been reset successfully." });
                                        });
                                    }
                                );
                            });
                        }
                    });
                });
            }
        );
    });
});

// ==========================================
// Nodemailer Email Route
// Integrated Email Service (from ./js/emailService)
// ==========================================

// ==========================================
// Email Service Functions
// ==========================================

// EMAIL-1: HTML-escape user-controlled free-text before it is interpolated into email HTML,
// so a malicious booking (e.g. message = "<img src=x onerror=...>") can't inject markup into
// the admin's notification inbox or a client's mailbox. Escapes & < > " (not ' — avoids mangling
// apostrophes in the rare plain-text subject case). Only the whitelisted free-text fields are
// escaped; recipient emails, dates, amounts, ids and URLs are left untouched.
function escapeEmailHtml(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
const EMAIL_ESCAPE_FIELDS = ['name', 'client_name', 'company', 'company_name', 'client_company',
    'message', 'event_name', 'event_location', 'venue_address', 'venue_name', 'city', 'country',
    'event_type', 'venue_type', 'audience_demographic', 'budget_range', 'performance_slot',
    'performance_duration', 'cancellation_reason'];
function escapeEmailFields(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    const copy = { ...obj };
    for (const f of EMAIL_ESCAPE_FIELDS) {
        if (typeof copy[f] === 'string') copy[f] = escapeEmailHtml(copy[f]);
    }
    return copy;
}

// ADMIN-XSS: neutralize stored HTML at the input boundary. The admin panel renders many
// booking/client fields via innerHTML/.html() without escaping, so a malicious public
// submission (e.g. message = "<img src=x onerror=...>") would execute JS in the admin's
// authenticated session. Encoding < > " here means no tag/attribute can ever form from stored
// data, in the admin DOM, emails, or PDFs. '&' is deliberately left raw so output-layer
// escaping (EMAIL-1) handles it without double-encoding common values like "Tom & Jerry".
function encodeUserHtml(s) {
    if (s == null) return s;
    return String(s).replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Prompt 3 email rebuild: shared footer context ──
// Rebuilt PREMIUM emails render their own full shell (js/emailComponents.js) and are queued
// with preWrapped:true, so they resolve their own footer social links here rather than via the
// central createEmailWrapper path. Cached briefly (emails are low-frequency).
let _emailFooterCache = { at: 0, socialLinks: [] };
async function getEmailFooterContext() {
    if (Date.now() - _emailFooterCache.at < 60000) return { socialLinks: _emailFooterCache.socialLinks };
    const socialLinks = await new Promise((resolve) => {
        db.all("SELECT platform_name, platform_url FROM social_links WHERE is_active = 1 ORDER BY display_order ASC",
            [], (err, rows) => resolve(err ? [] : (rows || [])));
    });
    _emailFooterCache = { at: Date.now(), socialLinks };
    return { socialLinks };
}

// Base tracking/portal URL used by client email CTAs (matches the existing link defaults).
function emailBaseUrl() {
    return (process.env.BASE_URL || process.env.SITE_URL || 'https://www.thabisomhlongo.com').replace(/\/$/, '');
}

async function sendBookingReceivedEmail(bookingId, data) {
    data = escapeEmailFields(data);
    const { 
        name, company, email, cell, 
        event_name, event_date, event_start_time, performance_slot, performance_duration,
        event_location, venue_address, city, country, venue_type,
        event_type, audience_size, audience_demographic, budget_range, travel_accommodation, message 
    } = data;

    const logoFilePath = path.join(__dirname, 'images', 'logo4.png');
    const siteUrl = process.env.SITE_URL || 'https://www.thabisomhlongo.com';

    // SYSTEM (Prompt 4 rebuild): the travel/accommodation cell keeps its exact conditional wording.
    const travelValue = (!travel_accommodation || travel_accommodation === 0 || travel_accommodation === '0' || travel_accommodation === 'Not required')
        ? 'Not required'
        : (travel_accommodation === 1 || travel_accommodation === true ? 'Provided' : travel_accommodation);
    const adminHtmlTemplate = emailComponents.renderSystemEmail({
        preheaderText: `New booking request #${bookingId}: ${event_type} on ${event_date}.`,
        category: 'Booking Requests',
        severity: 'action',
        leadFact: `New booking request from <strong style="color:#FAFAFA;">${name}</strong> for <strong style="color:#FAFAFA;">${event_type}</strong> on <strong style="color:#FAFAFA;">${event_date}</strong>.`,
        bodyHtml: `<p style="margin:0 0 6px; color:#D4AF37; font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:0.7px;">Additional Notes</p><div style="padding:14px 16px; background:#1A1A1A; border-left:3px solid #D4AF37; white-space:pre-wrap; color:#E6E6E6; font-size:13px; line-height:1.6;">${message.replace(/\n/g, '<br>')}</div><p style="margin:12px 0 0; color:#B0B0B0; font-size:12px;">Log in to the Admin Dashboard to reply and manage this booking natively.</p><p style="margin:14px 0 0; text-align:center;"><a href="${siteUrl}/admin#bookingsAdmin" style="display:inline-block; background:#D4AF37; color:#0A0A0A; padding:10px 24px; border-radius:4px; text-decoration:none; font-weight:600; font-size:13px;">Open Booking #${bookingId} in Admin &rarr;</a></p>`,
        cards: [
            {
                title: 'Client & Event',
                rows: [
                    { label: 'Client Name', value: `${name} ${company ? `(${company})` : ''}`, mono: false },
                    { label: 'Email', rawValue: `<a href="mailto:${email}" style="color:#D4AF37; text-decoration:none;">${email}</a>` },
                    { label: 'Phone', value: cell },
                    { label: 'Event Name', value: event_name || 'N/A', mono: false },
                    { label: 'Event Date & Time', value: `${event_date} ${event_start_time ? `at ${event_start_time}` : ''}` },
                    { label: 'Performance Slot', value: performance_slot || 'N/A', mono: false },
                    { label: 'Duration', value: performance_duration || 'N/A', mono: false },
                    { label: 'Location Name', value: event_location, mono: false },
                    { label: 'Full Address', value: `${venue_address ? venue_address + ', ' : ''}${city ? city + ', ' : ''}${country || ''}`, mono: false },
                    { label: 'Type', value: `${event_type} (${venue_type || 'Unspecified Venue Type'})`, mono: false },
                    { label: 'Audience', value: `${audience_size || 'N/A'} ${audience_demographic ? `(${audience_demographic})` : ''}`, mono: false },
                    { label: 'Travel/Accommodation', value: travelValue, mono: false },
                    { label: 'Budget', value: budget_range || 'N/A', mono: false }
                ]
            }
        ]
    });

    // Client receipt (PREMIUM, Prompt 3 rebuild) — booking summary as an info card.
    const clientCardRows = [
        { label: 'Event Type', value: event_type, mono: false },
        { label: 'Event Date', value: `${event_date}${event_start_time ? ' at ' + event_start_time : ''}` }
    ];
    if (performance_slot) clientCardRows.push({ label: 'Performance Slot', value: performance_slot, mono: false });
    if (performance_duration) clientCardRows.push({ label: 'Duration', value: performance_duration, mono: false });
    clientCardRows.push({ label: 'Venue', value: `${event_location}${city ? ', ' + city : ''}`, mono: false });
    if (audience_size) clientCardRows.push({ label: 'Audience', value: `${audience_size}${audience_demographic ? ' (' + audience_demographic + ')' : ''}`, mono: false });
    if (budget_range) clientCardRows.push({ label: 'Budget Range', value: budget_range, mono: false });

    try {
        const notifEmail = await getNotificationEmail();

        // E2: ICS calendar invite for client (so they can reserve the date immediately)
        const icsBooking = {
            id: bookingId,
            name,
            date: event_date,
            event_name,
            event_type,
            event_location,
            event_start_time,
            performance_slot,
            performance_duration
        };
        const icsContent = generateBookingICS(icsBooking);
        const icsAttachments = icsContent ? [{
            filename: `Booking_${bookingId}_Thabiso_Mhlongo.ics`,
            content: Buffer.from(icsContent),
            contentType: 'text/calendar; method=REQUEST'
        }] : [];

        const { socialLinks } = await getEmailFooterContext();
        const banner = await bannerRegistry.resolveBanner('booking_received_client');
        const clientHtml = emailComponents.renderPremiumEmail({
            preheaderText: `We've received your booking request — Ref #${bookingId}.`,
            bannerSrc: banner?.src, bannerAlt: banner?.alt, subtitle: banner?.subtitle,
            headline: banner?.headline || "We've Received Your Request",
            greeting: `Hi ${name},`,
            bodyHtml: `Thank you for reaching out to book Thabiso Mhlongo for your upcoming <strong style="color:#D4AF37;">${event_type}</strong> on <strong style="color:#D4AF37;">${event_date}</strong>. Our management team has received your enquiry and will be in touch shortly to confirm availability and discuss pricing.<br><br><span style="color:#B0B0B0; font-size:13px;">Keep your booking reference <strong style="color:#D4AF37;">#${bookingId}</strong> safe — you'll need it to track your booking status.</span>`,
            cards: [{ title: `Booking Summary · Ref #${bookingId}`, rows: clientCardRows }],
            cta: { label: 'Track Your Booking', url: `${emailBaseUrl()}/?track=${bookingId}&email=${encodeURIComponent(email)}` },
            socialLinks
        });

        const [adminInfo, clientInfo] = await Promise.all([
            sendEmail({
                to: notifEmail,
                subject: `NEW BOOKING REQUEST: ${event_type} on ${event_date}`,
                htmlContent: adminHtmlTemplate,
                preWrapped: true,
                fromName: name,
                replyTo: email,
                titleOverride: `New Booking Request #${bookingId}`,
                trigger_event: 'Booking: Admin Notification'
            }),
            sendEmail({
                to: email,
                subject: `Booking Request Confirmation: Thabiso Mhlongo`,
                htmlContent: clientHtml,
                preWrapped: true,
                attachments: icsAttachments,
                titleOverride: "We've Received Your Booking Request!",
                trigger_event: 'Booking: Client Receipt'
            })
        ]);
        console.log(`Booking emails dispatched: Admin(${adminInfo.success}) Client(${clientInfo.success})`);
        return adminInfo.success && clientInfo.success;
    } catch (emailError) {
        console.error('Error dispatching dual booking emails:', emailError);
        return false;
    }
}

// S2-1: Notify client when their booking moves to PENDING (under review)
async function sendBookingUnderReviewEmail(booking) {
    booking = escapeEmailFields(booking);
    const { id, name, email, event_type, date, event_name } = booking;
    const eventLabel = event_name || event_type;
    const { socialLinks } = await getEmailFooterContext();
    const banner = await bannerRegistry.resolveBanner('booking_under_review');
    const html = emailComponents.renderPremiumEmail({
        preheaderText: `Ref #${id} — your booking is now with our management team.`,
        bannerSrc: banner?.src, bannerAlt: banner?.alt, subtitle: banner?.subtitle,
        headline: banner?.headline || 'Your Booking Is Under Review',
        greeting: `Hi ${name},`,
        bodyHtml: `Great news — your request for <strong style="color:#FAFAFA;">${eventLabel}</strong> on <strong style="color:#FAFAFA;">${date}</strong> is now being actively reviewed by our management team. We're confirming availability, going through your event details, and preparing a tailored quotation. You can expect to hear from us shortly.`,
        cards: [{
            title: `Booking · Ref #${id}`,
            rows: [
                { label: 'Event', value: eventLabel, mono: false },
                { label: 'Date', value: date },
                { label: 'Reference', value: `#${id}` }
            ]
        }],
        cta: { label: 'Track Your Booking', url: `${emailBaseUrl()}/?track=${id}&email=${encodeURIComponent(email)}` },
        socialLinks
    });
    const result = await sendEmail({
        to: email,
        subject: `Your Booking Is Under Review — Ref #${id}`,
        htmlContent: html,
        preWrapped: true,
        titleOverride: 'Booking Under Review',
        trigger_event: 'Booking: Under Review'
    });
    return result.success;
}

async function sendQuoteEmail(booking, amount, pdfPath, pdfFileName, items = []) {
    booking = escapeEmailFields(booking);
    const { id, name, email, event_name, event_type, date } = booking;
    
    let attachments = [];
    if (pdfPath && fs.existsSync(pdfPath)) {
        attachments.push({
            filename: pdfFileName || `Quote_${id}_Thabiso_Mhlongo.pdf`,
            path: pdfPath,
            contentType: 'application/pdf'
        });
    }

    let itemsHtml = '';
    if (items && items.length > 0) {
        itemsHtml = '<div style="margin: 20px 0; padding: 15px; background: #111; border-radius: 4px;">';
        itemsHtml += '<h3 style="margin-top:0; font-size:14px; color:#D4AF37;">Service Breakdown:</h3>';
        itemsHtml += '<table style="width:100%; font-size:13px; color:#ccc;">';
        let subtotal = 0;
        items.forEach(it => {
            const qty = parseFloat(it.quantity_minutes) || parseFloat(it.quantity) || 0;
            const p = parseFloat(it.unit_price) || 0;
            const model = it.pricing_model || 'flat';
            const total = (qty === 0 && (model === 'flat' || model === 'flat_fee')) ? p : (qty * p);
            const desc = it.description || it.service_name || it.name;
            subtotal += total;
            
            let qtyStr = '';
            if (model === 'per_minute') {
                qtyStr = `${qty} min × R ${p.toFixed(2)}`;
            } else if (model === 'per_hour') {
                qtyStr = `${qty} hr × R ${p.toFixed(2)}`;
            } else if (model === 'flat' || model === 'flat_fee') {
                qtyStr = qty > 1 ? `${qty} × R ${p.toFixed(2)}` : 'Flat Fee';
            } else {
                qtyStr = `${qty} × R ${p.toFixed(2)}`;
            }
            
            itemsHtml += `<tr>
                <td style="padding:4px 0;">${desc}</td>
                <td style="padding:4px 0; text-align:right;">${qtyStr}</td>
                <td style="padding:4px 0; text-align:right; color:#fff;">R ${total.toFixed(2)}</td>
            </tr>`;
        });
        
        const discount = parseFloat(booking.discount) || 0;
        const applyVat = booking.apply_vat;
        
        itemsHtml += `<tr style="border-top: 1px solid #333;">
            <td style="padding:4px 0;"><strong>Subtotal</strong></td>
            <td></td>
            <td style="padding:4px 0; text-align:right;"><strong>R ${subtotal.toFixed(2)}</strong></td>
        </tr>`;
        
        let vatable = subtotal;
        if (discount > 0) {
            itemsHtml += `<tr>
                <td style="padding:4px 0;">Discount</td>
                <td></td>
                <td style="padding:4px 0; text-align:right; color:#ff4d4d;">- R ${discount.toFixed(2)}</td>
            </tr>`;
            vatable = Math.max(0, subtotal - discount);
        }
        
        const vatRate = await getVatRate();
        if (applyVat) {
            const vat = vatable * vatRate;
            const total = vatable + vat;
            itemsHtml += `<tr>
                <td style="padding:4px 0;">VAT (${(vatRate * 100).toFixed(0)}%)</td>
                <td></td>
                <td style="padding:4px 0; text-align:right;">R ${vat.toFixed(2)}</td>
            </tr>`;
            itemsHtml += `<tr>
                <td style="padding:4px 0;"><strong style="color:#D4AF37;">Total (Incl. VAT)</strong></td>
                <td></td>
                <td style="padding:4px 0; text-align:right;"><strong style="color:#D4AF37;">R ${total.toFixed(2)}</strong></td>
            </tr>`;
        } else {
            itemsHtml += `<tr>
                <td style="padding:4px 0;"><strong style="color:#D4AF37;">Total</strong></td>
                <td></td>
                <td style="padding:4px 0; text-align:right;"><strong style="color:#D4AF37;">R ${vatable.toFixed(2)}</strong></td>
            </tr>`;
        }
        
        itemsHtml += '</table></div>';
    }

    // NOTE: itemsHtml + `${amount || booking.quote_amount}` carry computed figures — kept verbatim.
    const { socialLinks } = await getEmailFooterContext();
    const banner = await bannerRegistry.resolveBanner('quote');
    const acceptUrl = `${process.env.BASE_URL || 'https://www.thabisomhlongo.com'}/?track=${id}&email=${encodeURIComponent(email)}&action=accept`;
    const bodyHtml =
        `We've prepared a formal quotation for your upcoming event, <strong style="color:#FAFAFA;">${event_name || event_type}</strong> on <strong style="color:#FAFAFA;">${date}</strong>. The full breakdown of services and terms is attached as a PDF for your records.` +
        `<br><br><strong style="color:#D4AF37;">Terms &amp; Policies:</strong><br>${booking.terms || 'Standard cancellation policy applies.'}` +
        itemsHtml +
        `<p style="margin:14px 0 0;"><strong style="color:#FAFAFA;">Total Quote: ${amount || booking.quote_amount}</strong></p>` +
        `<p style="margin:10px 0 0; color:#E6E6E6;">To secure this date, please review and accept the quotation via your booking portal.</p>`;
    const html = emailComponents.renderPremiumEmail({
        preheaderText: `Your quotation for booking #${id} is ready to review.`,
        bannerSrc: banner?.src, bannerAlt: banner?.alt, subtitle: banner?.subtitle,
        headline: banner?.headline || 'Your Quotation',
        greeting: `Hi ${name},`,
        bodyHtml,
        cta: { label: 'Review & Accept Quote', url: acceptUrl },
        socialLinks
    });

    const result = await sendEmail({
        to: email,
        subject: `Quotation for Booking #${id}`,
        htmlContent: html,
        preWrapped: true,
        attachments: attachments,
        titleOverride: 'Your Quotation',
        trigger_event: 'Booking: Quote Generated'
    });

    return result.success;
}

// S2-2: Notify all admin users when a quote has been dispatched to a client
async function sendAdminQuoteSentNotification(booking, amount) {
    // event_name was used in the template below but never destructured, so this function threw
    // ReferenceError on every call. The throw was swallowed by the caller's .catch(), meaning the
    // admin has never actually received a "quote sent" notification.
    const { id, name, email, event_name, date } = booking;
    const notifEmail = await getNotificationEmail();
    const emailBody = emailComponents.renderSystemEmail({
        preheaderText: `Quote sent to ${name} for booking #${id}.`,
        category: 'Quotes & Proposals',
        severity: 'info',
        leadFact: `A quotation has been dispatched to the client for Booking <strong style="color:#FAFAFA;">#${id}</strong>.`,
        bodyHtml: `<p style="margin:0; color:#B0B0B0;">The client has been emailed their quote PDF and a direct link to accept it. Log in to the Admin Dashboard to track the response.</p>`,
        cards: [{
            title: 'Quote Details',
            rows: [
                { label: 'Client', value: name, mono: false },
                { label: 'Client Email', value: email },
                { label: 'Event', value: `${event_name} • ${date}`, mono: false },
                { label: 'Quote Amount', value: `${amount || booking.quote_amount}`, highlight: true }
            ]
        }]
    });
    return sendEmail({
        to: notifEmail,
        subject: `Quote Sent — Booking #${id} (${name})`,
        htmlContent: emailBody,
        preWrapped: true,
        titleOverride: `Quote Dispatched — #${id}`,
        trigger_event: 'Booking: Quote Sent (Admin Notification)'
    });
}

async function sendInvoiceEmail(booking, invoicePdfPath) {
    booking = escapeEmailFields(booking);
    const { id, name, email, event_name, event_type, date } = booking;

    let attachments = [];
    if (invoicePdfPath && fs.existsSync(invoicePdfPath)) {
        attachments.push({
            filename: `Invoice_${id}_Thabiso_Mhlongo.pdf`,
            path: invoicePdfPath,
            contentType: 'application/pdf'
        });
    }

    const schedules = await new Promise(resolve => {
        db.all(
            "SELECT description, due_date, expected_amount FROM payment_schedules WHERE booking_id = ? AND LOWER(COALESCE(status,'pending')) NOT IN ('superseded','cancelled') ORDER BY due_date ASC",
            [id],
            (err, rows) => resolve(err ? [] : (rows || []))
        );
    });

    const scheduleTableRows = schedules.length > 0
        ? schedules.map(s => `
            <tr>
                <td style="padding:8px 12px;border-bottom:1px solid #333;color:#ccc;">${s.description}</td>
                <td style="padding:8px 12px;border-bottom:1px solid #333;color:#ccc;">${s.due_date}</td>
                <td style="padding:8px 12px;border-bottom:1px solid #333;color:#D4AF37;font-weight:600;">R ${parseFloat(s.expected_amount).toFixed(2)}</td>
            </tr>`).join('')
        : `<tr><td colspan="3" style="padding:8px 12px;color:#888;text-align:center;">Payment details are in the attached invoice PDF.</td></tr>`;

    const paymentScheduleHtml = `
        <div style="margin:20px 0;">
            <h3 style="color:#D4AF37;font-size:14px;letter-spacing:1px;text-transform:uppercase;margin-bottom:10px;">Payment Schedule</h3>
            <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;background:#111;border:1px solid #333;border-radius:4px;">
                <thead>
                    <tr style="background:#1a1a1a;">
                        <th style="padding:8px 12px;text-align:left;color:#D4AF37;font-size:11px;text-transform:uppercase;letter-spacing:1px;">Description</th>
                        <th style="padding:8px 12px;text-align:left;color:#D4AF37;font-size:11px;text-transform:uppercase;letter-spacing:1px;">Due Date</th>
                        <th style="padding:8px 12px;text-align:left;color:#D4AF37;font-size:11px;text-transform:uppercase;letter-spacing:1px;">Amount</th>
                    </tr>
                </thead>
                <tbody>${scheduleTableRows}</tbody>
            </table>
        </div>`;

    // PAYMENT-CRITICAL: paymentScheduleHtml (amounts/due dates) kept verbatim; PDF + reference unchanged.
    const { socialLinks } = await getEmailFooterContext();
    const banner = await bannerRegistry.resolveBanner('invoice');
    const html = emailComponents.renderPremiumEmail({
        preheaderText: `Your invoice for booking #${id} is attached.`,
        bannerSrc: banner?.src, bannerAlt: banner?.alt, subtitle: banner?.subtitle,
        headline: banner?.headline || 'Your Invoice',
        greeting: `Hi ${name},`,
        bodyHtml:
            `Your formal invoice is ready for <strong style="color:#FAFAFA;">${event_name || event_type}</strong> on <strong style="color:#FAFAFA;">${date}</strong>. Please find the attached PDF for the full service breakdown.` +
            paymentScheduleHtml +
            `<p style="margin:12px 0 0;"><strong style="color:#D4AF37;">Terms &amp; Policies:</strong><br>${booking.terms || 'Standard cancellation policy applies.'}</p>` +
            `<p style="margin:10px 0 0; color:#E6E6E6;">Payment can be made via the secure link sent in our previous communications or via bank transfer using the details in the invoice.</p>` +
            `<p style="margin:10px 0 0; color:#B0B0B0; font-size:13px;">Invoice Reference: <strong style="color:#D4AF37;">#${id}</strong></p>`,
        cta: { label: 'View Your Booking', url: `${emailBaseUrl()}/?track=${id}&email=${encodeURIComponent(email)}` },
        socialLinks
    });

    const result = await sendEmail({
        to: email,
        subject: `Invoice for Booking #${id}`,
        htmlContent: html,
        preWrapped: true,
        attachments: attachments,
        titleOverride: 'Your Invoice',
        trigger_event: 'Booking: Invoice Generated'
    });

    return result.success;
}

async function sendInvoicePreDueEmail(booking, invoice, daysUntilDue) {
    booking = escapeEmailFields(booking);
    const { id, name, email, event_name, event_type, date } = booking;
    const baseUrl = process.env.BASE_URL || 'https://www.thabisomhlongo.com';
    const payUrl  = `${baseUrl}/?track=${id}&email=${encodeURIComponent(email)}`;
    const amount  = parseFloat(invoice.total_amount || 0).toFixed(2);
    const dueDate = invoice.due_date || '';

    // PAYMENT-CRITICAL: invoice number, due date, `R ${amount}` and payUrl kept verbatim.
    // (The old card used display:flex, which many email clients ignore — infoCard is table-based.)
    const { socialLinks } = await getEmailFooterContext();
    const banner = await bannerRegistry.resolveBanner('invoice_pre_due');
    const html = emailComponents.renderPremiumEmail({
        preheaderText: `Invoice ${invoice.invoice_number || id} is due in ${daysUntilDue} day${daysUntilDue !== 1 ? 's' : ''}.`,
        bannerSrc: banner?.src, bannerAlt: banner?.alt, subtitle: banner?.subtitle,
        headline: banner?.headline || 'Invoice Payment Reminder',
        greeting: `Hi ${name},`,
        bodyHtml:
            `This is a friendly reminder that your invoice for <strong style="color:#FAFAFA;">${event_name || event_type}</strong> on <strong style="color:#FAFAFA;">${date}</strong> is due in <strong style="color:#D4AF37;">${daysUntilDue} day${daysUntilDue !== 1 ? 's' : ''}</strong>.` +
            `<p style="margin:12px 0 0; color:#B0B0B0; font-size:12px;">If you have already arranged payment, please disregard this message. <span style="font-size:12px;">(Booking reference #${id})</span></p>`,
        cards: [{
            title: 'Payment Due',
            rows: [
                { label: 'Invoice #', value: `${invoice.invoice_number || id}` },
                { label: 'Due Date', value: dueDate },
                { label: 'Amount Due', value: `R ${amount}`, highlight: true }
            ]
        }],
        cta: { label: 'Pay Now', url: payUrl },
        socialLinks
    });

    const result = await sendEmail({
        to: email,
        subject: `Invoice Due in ${daysUntilDue} Day${daysUntilDue !== 1 ? 's' : ''} — Booking #${id}`,
        htmlContent: html,
        preWrapped: true,
        titleOverride: 'Invoice Payment Reminder',
        trigger_event: 'Booking: Invoice Pre-Due Reminder'
    });
    return result.success;
}

// Emails the generated contract PDF to the client with a link to the tracking page, where they can
// review and sign it online. Mirrors sendInvoicePreDueEmail's structure.
async function sendContractEmail(booking, contractPdfPath) {
    booking = escapeEmailFields(booking);
    const { id, name, email, event_name, event_type, date } = booking;
    const baseUrl = process.env.BASE_URL || 'https://www.thabisomhlongo.com';
    const signUrl = `${baseUrl}/?track=${id}&email=${encodeURIComponent(email)}`;

    const attachments = [];
    if (contractPdfPath && fs.existsSync(contractPdfPath)) {
        attachments.push({ filename: `Contract_${id}_Thabiso_Mhlongo.pdf`, path: contractPdfPath, contentType: 'application/pdf' });
    }

    const { socialLinks } = await getEmailFooterContext();
    const banner = await bannerRegistry.resolveBanner('contract_sent');
    const htmlContent = emailComponents.renderPremiumEmail({
        preheaderText: `Your booking contract for #${id} is ready to review and sign.`,
        bannerSrc: banner?.src, bannerAlt: banner?.alt, subtitle: banner?.subtitle,
        headline: banner?.headline || 'Your Booking Contract',
        greeting: `Hi ${name},`,
        bodyHtml:
            `Your booking contract for <strong style="color:#FAFAFA;">${event_name || event_type}</strong> on <strong style="color:#FAFAFA;">${date}</strong> is ready. Please review the attached PDF and sign it online at your convenience.` +
            `<p style="margin:10px 0 0; color:#B0B0B0; font-size:12px;">Once you've signed, our team will countersign to finalise the agreement. If you have any questions about the terms, just reply to this email. (Booking reference #${id})</p>`,
        cta: { label: 'Review & Sign Contract', url: signUrl },
        socialLinks
    });

    const result = await sendEmail({
        to: email,
        subject: `Your booking contract — ${event_name || event_type} (Booking #${id})`,
        htmlContent,
        preWrapped: true,
        attachments,
        titleOverride: 'Your Booking Contract',
        trigger_event: 'Booking: Contract Sent'
    });
    return result.success;
}

async function sendOverdueInvoiceEmail(booking, invoice) {
    booking = escapeEmailFields(booking);
    const { id, name, email, event_name, event_type, date } = booking;
    const baseUrl = process.env.BASE_URL || 'https://www.thabisomhlongo.com';
    const payUrl  = `${baseUrl}/?track=${id}&email=${encodeURIComponent(email)}`;
    const amount  = parseFloat(invoice.total_amount || 0).toFixed(2);
    const dueDate = invoice.due_date || '';

    // PAYMENT-CRITICAL: invoice number, due date, `R ${amount}` and payUrl kept verbatim.
    // Red (#ef4444) replaced with the design system's amber alert (no red-on-black per HARD RULES).
    const { socialLinks } = await getEmailFooterContext();
    const banner = await bannerRegistry.resolveBanner('invoice_overdue');
    const html = emailComponents.renderPremiumEmail({
        preheaderText: `Invoice ${invoice.invoice_number || id} is overdue — R ${amount} outstanding.`,
        bannerSrc: banner?.src, bannerAlt: banner?.alt, subtitle: banner?.subtitle,
        headline: banner?.headline || 'Invoice Overdue',
        greeting: `Hi ${name},`,
        bodyHtml:
            `Your invoice for <strong style="color:#FAFAFA;">${event_name || event_type}</strong> on <strong style="color:#FAFAFA;">${date}</strong> was due on <strong style="color:#E8A83E;">${dueDate}</strong> and is now <strong style="color:#E8A83E;">overdue</strong>.` +
            emailComponents.spacer(14) +
            emailComponents.alertStrip({ severity: 'alert', text: 'Please settle this payment at your earliest convenience to avoid any disruption to your booking.' }) +
            `<p style="margin:12px 0 0; color:#B0B0B0; font-size:12px;">If you believe this is an error or have already made payment, please contact us immediately and we will update your records. <span style="font-size:12px;">(Booking reference #${id})</span></p>`,
        cards: [{
            title: 'Outstanding Invoice',
            rows: [
                { label: 'Invoice #', value: `${invoice.invoice_number || id}` },
                { label: 'Was Due', value: dueDate },
                { label: 'Outstanding Amount', value: `R ${amount}`, highlight: true }
            ]
        }],
        cta: { label: 'Pay Now', url: payUrl },
        socialLinks
    });

    const result = await sendEmail({
        to: email,
        subject: `Invoice Overdue — Booking #${id}`,
        htmlContent: html,
        preWrapped: true,
        titleOverride: 'Invoice Overdue',
        trigger_event: 'Booking: Invoice Overdue Reminder'
    });
    return result.success;
}

// Gap 2 (Phase 2): accepts an options object { invoiceGenerated: bool } so that the email subject
// and title are honest — if invoice generation failed during acceptance, we don't claim it succeeded.
async function sendQuoteAcceptedEmail(booking, options = {}) {
    booking = escapeEmailFields(booking);
    const { invoiceGenerated = true } = options;
    const { id, name, email, event_name, event_type, date } = booking;

    // Fetch payment schedule to include in the confirmation email
    const schedules = await new Promise((resolve) => {
        db.all(
            "SELECT description, due_date, expected_amount FROM payment_schedules WHERE booking_id = ? AND LOWER(COALESCE(status,'pending')) NOT IN ('superseded','cancelled') ORDER BY due_date ASC",
            [id],
            (err, rows) => resolve(err ? [] : (rows || []))
        );
    });

    const scheduleTableRows = schedules.length > 0
        ? schedules.map(s => `
            <tr>
                <td style="padding:8px 12px;border-bottom:1px solid #333;color:#ccc;">${s.description}</td>
                <td style="padding:8px 12px;border-bottom:1px solid #333;color:#ccc;">${s.due_date}</td>
                <td style="padding:8px 12px;border-bottom:1px solid #333;color:#D4AF37;font-weight:600;">R ${parseFloat(s.expected_amount).toFixed(2)}</td>
            </tr>`
        ).join('')
        : `<tr><td colspan="3" style="padding:8px 12px;color:#888;text-align:center;">No schedule on record — our team will send payment details shortly.</td></tr>`;

    const paymentScheduleHtml = `
        <div style="margin:20px 0;">
            <h3 style="color:#D4AF37;font-size:14px;letter-spacing:1px;text-transform:uppercase;margin-bottom:10px;">Payment Schedule</h3>
            <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;background:#111;border:1px solid #333;border-radius:4px;">
                <thead>
                    <tr style="background:#1a1a1a;">
                        <th style="padding:8px 12px;text-align:left;color:#D4AF37;font-size:11px;text-transform:uppercase;letter-spacing:1px;">Description</th>
                        <th style="padding:8px 12px;text-align:left;color:#D4AF37;font-size:11px;text-transform:uppercase;letter-spacing:1px;">Due Date</th>
                        <th style="padding:8px 12px;text-align:left;color:#D4AF37;font-size:11px;text-transform:uppercase;letter-spacing:1px;">Amount</th>
                    </tr>
                </thead>
                <tbody>${scheduleTableRows}</tbody>
            </table>
        </div>`;

    // NOTE: paymentScheduleHtml carries the scheduled amounts — kept verbatim.
    const { socialLinks } = await getEmailFooterContext();
    const banner = await bannerRegistry.resolveBanner('quote_accepted');
    const html = emailComponents.renderPremiumEmail({
        preheaderText: invoiceGenerated ? `Booking #${id} accepted — invoice issued.` : `Booking #${id} — quote accepted.`,
        bannerSrc: banner?.src, bannerAlt: banner?.alt, subtitle: banner?.subtitle,
        headline: banner?.headline || (invoiceGenerated ? 'Invoice Sent — Awaiting Payment' : 'Quote Accepted'),
        greeting: `Hi ${name},`,
        bodyHtml:
            `We've received your acceptance of the quote for <strong style="color:#FAFAFA;">${event_name || event_type}</strong> on <strong style="color:#FAFAFA;">${date}</strong>. Your booking reference is <strong style="color:#D4AF37;">#${id}</strong>, and our team will formally confirm your booking shortly.` +
            paymentScheduleHtml +
            `<p style="font-size:12px; color:#B0B0B0; margin-top:8px;">Please ensure each payment is made by its due date to keep your booking active. Contact us if you have any questions.</p>`,
        cta: { label: 'View Your Booking', url: `${emailBaseUrl()}/?track=${id}&email=${encodeURIComponent(email)}` },
        socialLinks
    });

    // E3: ICS calendar invite attached to quote acceptance confirmation
    const icsContent = generateBookingICS(booking);
    const icsAttachments = icsContent ? [{
        filename: `Booking_${id}_Thabiso_Mhlongo.ics`,
        content: Buffer.from(icsContent),
        contentType: 'text/calendar; method=REQUEST'
    }] : [];

    const result = await sendEmail({
        to: email,
        // Gap 2: Subject and title reflect whether the invoice was actually generated (honest messaging).
        subject: invoiceGenerated ? `Invoice Issued – Booking #${id}` : `Quote Accepted – Booking #${id}`,
        htmlContent: html,
        preWrapped: true,
        attachments: icsAttachments,
        titleOverride: invoiceGenerated ? 'Invoice Sent – Awaiting Payment' : 'Quote Accepted – Awaiting Payment',
        trigger_event: 'Booking: Quote Accepted Receipt'
    });

    return result.success;
}

async function sendCancellationEmail(booking, cancellationData) {
    booking = escapeEmailFields(booking);
    const { id, name, email, event_name, event_type, date } = booking;
    const { reason, refund_due, rule, days_until_event, is_force_majeure } = cancellationData;

    // SC-3: Policy strip — always tells the client which rule was applied and the timing context.
    // Refund figure kept verbatim: R ${parseFloat(refund_due).toFixed(2)}.
    const { socialLinks } = await getEmailFooterContext();
    const policyStrip = rule ? emailComponents.alertStrip({
        severity: is_force_majeure ? 'action' : 'info',
        text: `<strong style="color:${is_force_majeure ? '#D4AF37' : '#B0B0B0'};">${is_force_majeure ? 'Force Majeure — Full Refund Granted' : 'Cancellation Policy Applied'}</strong><br>${rule}` +
              (days_until_event !== null && days_until_event !== undefined
                  ? `<br><span style="font-size:12px;color:#B0B0B0;">Days until event at time of cancellation: <strong>${days_until_event}</strong></span>` : '')
    }) : '';
    const refundHtml = parseFloat(refund_due) > 0
        ? `<p style="margin:14px 0 0;"><strong style="color:#D4AF37;">Refund Due: R ${parseFloat(refund_due).toFixed(2)}</strong><br><span style="color:#B0B0B0;">Your refund will be processed within 5&ndash;7 business days.</span></p>`
        : `<p style="margin:14px 0 0; color:#B0B0B0;">No refund is applicable for this cancellation per our cancellation policy.</p>`;
    const banner = await bannerRegistry.resolveBanner('booking_cancelled');
    const html = emailComponents.renderPremiumEmail({
        preheaderText: `Booking #${id} has been cancelled.`,
        bannerSrc: banner?.src, bannerAlt: banner?.alt, subtitle: banner?.subtitle,
        headline: banner?.headline || 'Booking Cancelled',
        greeting: `Hi ${name},`,
        bodyHtml:
            `We regret to inform you that your booking for <strong style="color:#FAFAFA;">${event_name || event_type}</strong> on <strong style="color:#FAFAFA;">${date}</strong> has been cancelled.` +
            (reason ? `<br><br><strong style="color:#FAFAFA;">Reason:</strong> ${reason}` : '') +
            (policyStrip ? emailComponents.spacer(14) + policyStrip : '') +
            refundHtml +
            `<p style="margin:12px 0 0; color:#B0B0B0;">If you have any questions, please contact us directly. <span style="font-size:13px;">(Booking reference #${id})</span></p>`,
        socialLinks
    });
    const result = await sendEmail({
        to: email,
        subject: `Booking Cancelled – Reference #${id}`,
        htmlContent: html,
        preWrapped: true,
        titleOverride: 'Booking Cancellation',
        trigger_event: 'Booking: Cancellation'
    });
    return result.success;
}

async function sendPaymentReceivedEmail(booking, newAmountPaid, newOutstanding, newPaymentStatus) {
    booking = escapeEmailFields(booking);
    const { id, name, email, event_name, event_type, date, total_amount, quote_amount } = booking;
    
    const isPartial = newPaymentStatus === 'PARTIALLY_PAID';
    const titleStatus = isPartial ? 'Partial Payment Received' : 'Full Payment Received';
    const displayTotal = total_amount || (quote_amount ? parseFloat(quote_amount.replace(/[^0-9.]/g, '')) : 0);

    // PAYMENT-CRITICAL: the exact figure strings (R${...} — no space, as before) are unchanged.
    const { socialLinks } = await getEmailFooterContext();
    const banner = await bannerRegistry.resolveBanner('payment_received');
    const html = emailComponents.renderPremiumEmail({
        preheaderText: `${titleStatus} for booking #${id} — R${newAmountPaid.toFixed(2)}.`,
        bannerSrc: banner?.src, bannerAlt: banner?.alt, subtitle: banner?.subtitle,
        headline: banner?.headline || titleStatus,
        greeting: `Hi ${name},`,
        bodyHtml:
            `We've successfully processed a payment for the booking of <strong style="color:#FAFAFA;">${event_name || event_type}</strong> on <strong style="color:#FAFAFA;">${date}</strong>.` +
            `<p style="margin:12px 0 0; color:#E6E6E6;">${isPartial ? 'Your booking will be fully confirmed once the remaining balance is settled.' : `Your booking is now <strong style="color:#D4AF37;">CONFIRMED</strong>. We look forward to performing at your event!`} <span style="color:#B0B0B0; font-size:13px;">(Booking reference #${id})</span></p>`,
        cards: [{
            title: 'Payment Summary',
            rows: [
                { label: 'Total Quote', value: `R${displayTotal.toFixed(2)}` },
                { label: 'Amount Paid', value: `R${newAmountPaid.toFixed(2)}`, highlight: true },
                { label: 'Remaining Balance', rawValue: `<span style="color:${newOutstanding > 0 ? '#E8A83E' : '#D4AF37'};">R${newOutstanding.toFixed(2)}</span>` }
            ]
        }],
        cta: { label: 'View Your Booking', url: `${emailBaseUrl()}/?track=${id}&email=${encodeURIComponent(email)}` },
        socialLinks
    });

    const result = await sendEmail({
        to: email,
        subject: `${titleStatus} – Booking #${id}`,
        htmlContent: html,
        preWrapped: true,
        titleOverride: titleStatus,
        trigger_event: 'Booking: Payment Received'
    });

    return result.success;
}

function generateBookingICS(booking) {
    try {
        const ical = require('ical-generator').default;
        const cal = ical({ name: 'Thabiso Mhlongo Event' });
        const startTime = booking.event_start_time || '18:00';
        const startDt = moment(`${booking.date}T${startTime}`);

        // Resolve end time (priority: slot range > duration > 2 h default)
        let endDt;
        const slotMatch = (booking.performance_slot || '').match(/(\d{1,2}:\d{2})\s*[–\-]\s*(\d{1,2}:\d{2})/);
        if (slotMatch) {
            endDt = moment(`${booking.date}T${slotMatch[2]}`);
            if (endDt.isSameOrBefore(startDt)) endDt.add(1, 'day'); // midnight crossover
        } else {
            const durStr = booking.performance_duration || '';
            const minMatch = durStr.match(/^(\d+)\s*min/i);               // "45 min"
            const hmMatch  = durStr.match(/^(\d+)h(?:\s*(\d+)m)?/i);     // "2h" / "1h 30m"
            const durationH = minMatch
                ? parseInt(minMatch[1]) / 60
                : hmMatch
                    ? parseInt(hmMatch[1]) + (hmMatch[2] ? parseInt(hmMatch[2]) / 60 : 0)
                    : (parseFloat(durStr) || 2);
            endDt = startDt.clone().add(durationH, 'hours');
        }

        cal.createEvent({
            uid: `booking-${booking.id}@thabisomhlongo.com`,
            start: startDt,
            end: endDt,
            summary: (booking.event_name || booking.event_type || 'Event') + ' – Thabiso Mhlongo',
            description: `Booking Reference: #${booking.id}\nClient: ${booking.name}`,
            location: booking.event_location || '',
            url: `${process.env.BASE_URL || 'https://www.thabisomhlongo.com'}/booking?id=${booking.id}`
        });
        return cal.toString();
    } catch (e) {
        console.error('ICS generation error:', e.message);
        return null;
    }
}

async function sendBookingConfirmedEmail(booking) {
    booking = escapeEmailFields(booking);
    const { id, name, email, event_name, event_type, date, event_location, performance_slot, performance_duration } = booking;

    const { socialLinks } = await getEmailFooterContext();
    const cardRows = [
        { label: 'Event', value: event_name || event_type, mono: false },
        { label: 'Date', value: date },
        { label: 'Venue', value: event_location || 'TBD', mono: false }
    ];
    if (performance_slot) cardRows.push({ label: 'Performance Slot', value: performance_slot, mono: false });
    if (performance_duration) cardRows.push({ label: 'Duration', value: performance_duration, mono: false });
    cardRows.push({ label: 'Reference', value: `#${id}` });

    const banner = await bannerRegistry.resolveBanner('booking_confirmed');
    const html = emailComponents.renderPremiumEmail({
        preheaderText: `Booking #${id} is confirmed — see you on ${date}!`,
        bannerSrc: banner?.src, bannerAlt: banner?.alt, subtitle: banner?.subtitle,
        headline: banner?.headline || 'Your Booking Is Confirmed',
        greeting: `Hi ${name},`,
        bodyHtml:
            `Wonderful news — your booking for <strong style="color:#FAFAFA;">${event_name || event_type}</strong> on <strong style="color:#FAFAFA;">${date}</strong> at <strong style="color:#FAFAFA;">${event_location || 'TBD'}</strong> is now fully <strong style="color:#D4AF37;">CONFIRMED</strong>.<br><br>Thabiso Mhlongo is excited to be part of your event, and our team will be in touch with any final logistics closer to the date.<br><br><span style="color:#B0B0B0; font-size:13px;">We've attached a calendar invite (.ics) so you can save the event to your calendar.</span>`,
        cards: [{ title: 'Confirmed Booking', rows: cardRows }],
        cta: { label: 'View Your Booking', url: `${emailBaseUrl()}/?track=${id}&email=${encodeURIComponent(email)}` },
        socialLinks
    });

    const icsContent = generateBookingICS(booking);
    const attachments = icsContent ? [{
        filename: `Booking_${id}_Thabiso_Mhlongo.ics`,
        content: Buffer.from(icsContent),
        contentType: 'text/calendar; method=REQUEST'
    }] : [];

    const result = await sendEmail({
        to: email,
        subject: `Booking Confirmed 🎉 – #${id}`,
        htmlContent: html,
        preWrapped: true,
        attachments,
        titleOverride: 'Booking Confirmed!',
        trigger_event: 'Booking: Final Confirmation'
    });

    return result.success;
}

// P3-7: Resend the paid invoice PDF as a payment receipt when booking becomes fully PAID.
async function sendPaidReceiptEmail(booking) {
    booking = escapeEmailFields(booking);
    const inv = await new Promise(resolve => {
        db.get("SELECT file_path, invoice_number FROM invoices WHERE booking_id = ? AND status = 'PAID' ORDER BY id DESC LIMIT 1",
            [booking.id], (e, row) => resolve(e ? null : row));
    });
    if (!inv || !inv.file_path) return;
    const pdfPath = path.join(__dirname, 'docs', 'invoices', inv.file_path);
    if (!fs.existsSync(pdfPath)) return;
    await sendInvoiceEmail(booking, pdfPath);
}

async function sendBookingCompletedEmail(booking) {
    booking = escapeEmailFields(booking);
    const { id, name, email, event_name, event_type, date, event_location,
            total_amount, amount_paid, quote_amount } = booking;

    // Fetch services delivered for the summary table
    const services = await new Promise(resolve => {
        db.all(`SELECT bs.quantity_minutes, bs.unit_price, bs.total_price, s.name as service_name, s.display_unit
                FROM booking_services bs
                LEFT JOIN services s ON bs.service_id = s.id
                WHERE bs.booking_id = ?`, [id], (e, rows) => resolve(e ? [] : (rows || [])));
    });

    // Fetch VAT from the latest non-voided invoice, then fall back to the latest quotation
    const vatRow = await new Promise(resolve => {
        db.get(`SELECT tax_amount FROM invoices WHERE booking_id = ? AND UPPER(status) != 'VOID' ORDER BY id DESC LIMIT 1`,
            [id], (e, row) => {
                if (!e && row) return resolve(row);
                db.get(`SELECT tax_amount FROM quotations WHERE booking_id = ? AND status != 'void' ORDER BY id DESC LIMIT 1`,
                    [id], (e2, row2) => resolve(e2 ? null : row2));
            });
    });
    const vatAmount = vatRow ? parseFloat(vatRow.tax_amount) || 0 : 0;
    const displayTotal = parseFloat(total_amount) || parseFloat((quote_amount || '0').replace(/[^0-9.]/g, '')) || 0;
    const paid = parseFloat(amount_paid) || 0;
    const subtotal = displayTotal - vatAmount;

    // Services + financial figures below are rendered with the exact same computed strings as before.
    const { socialLinks } = await getEmailFooterContext();
    const cards = [];
    if (services.length > 0) {
        cards.push({
            title: 'Services Delivered',
            rows: services.map(s => {
                const qty = s.quantity_minutes && s.display_unit ? ` (${s.quantity_minutes} ${s.display_unit})` : '';
                return { label: `${s.service_name || 'Service'}${qty}`, value: `R ${(parseFloat(s.total_price) || 0).toFixed(2)}` };
            })
        });
    }
    cards.push({
        title: 'Financial Summary',
        rows: [
            ...(vatAmount > 0 ? [{ label: 'Subtotal (excl. VAT)', value: `R ${subtotal.toFixed(2)}` }] : []),
            ...(vatAmount > 0 ? [{ label: 'VAT (15%)',            value: `R ${vatAmount.toFixed(2)}` }] : []),
            { label: 'Total',        value: `R ${displayTotal.toFixed(2)}` },
            { label: 'Amount Paid',  value: `R ${paid.toFixed(2)}`, highlight: true },
        ]
    });

    const banner = await bannerRegistry.resolveBanner('booking_completed');
    const html = emailComponents.renderPremiumEmail({
        preheaderText: `Thank you — booking #${id} is complete. We hope it was a blast!`,
        bannerSrc: banner?.src, bannerAlt: banner?.alt, subtitle: banner?.subtitle,
        headline: banner?.headline || 'Event Completed — Thank You!',
        greeting: `Hi ${name},`,
        bodyHtml:
            `We hope you had an absolutely wonderful time! Your event — <strong style="color:#FAFAFA;">${event_name || event_type}</strong> on <strong style="color:#FAFAFA;">${date}</strong> at <strong style="color:#FAFAFA;">${event_location || 'your venue'}</strong> — has been marked as completed.<br><br>It was a pleasure working with you. Here's a summary of your booking <span style="color:#B0B0B0; font-size:13px;">(reference #${id})</span>:`,
        cards,
        socialLinks
    });
    const result = await sendEmail({
        to: email, subject: `Thank You – Event Completed! Booking #${id}`,
        htmlContent: html, preWrapped: true, titleOverride: 'Event Completed – Thank You!',
        trigger_event: 'Booking: Completed'
    });
    return result.success;
}

async function sendQuoteExpiredEmail(booking) {
    booking = escapeEmailFields(booking);
    const { id, name, email, event_name, event_type, date } = booking;
    const { socialLinks } = await getEmailFooterContext();
    const banner = await bannerRegistry.resolveBanner('quote_expired');
    const html = emailComponents.renderPremiumEmail({
        preheaderText: `Your quote for booking #${id} has expired.`,
        bannerSrc: banner?.src, bannerAlt: banner?.alt, subtitle: banner?.subtitle,
        headline: banner?.headline || 'Your Quote Has Expired',
        greeting: `Hi ${name},`,
        bodyHtml: `Your quote for <strong style="color:#FAFAFA;">${event_name || event_type}</strong> on <strong style="color:#FAFAFA;">${date}</strong> has expired and is no longer valid.<br><br>If you're still interested in booking Thabiso Mhlongo for your event, we'd be glad to prepare a fresh quote — just submit a new enquiry and we'll take it from there. <span style="color:#B0B0B0; font-size:13px;">(Booking reference #${id})</span>`,
        cta: { label: 'Submit a New Enquiry', url: `${process.env.SITE_URL || ''}/index.html#booking` },
        socialLinks
    });
    const result = await sendEmail({
        to: email, subject: `Your Quote Has Expired – Booking #${id}`,
        htmlContent: html, preWrapped: true, titleOverride: 'Quote Expired',
        trigger_event: 'Booking: Quote Expired'
    });
    return result.success;
}

async function sendPaymentFailedEmail(booking) {
    booking = escapeEmailFields(booking);
    const { id, name, email, event_name, event_type, date, total_amount, quote_amount } = booking;
    const displayTotal = total_amount || (quote_amount ? parseFloat((quote_amount || '0').replace(/[^0-9.]/g, '')) : 0);
    // PAYMENT-CRITICAL: `R${...}` amount format kept verbatim (no space).
    const { socialLinks } = await getEmailFooterContext();
    const banner = await bannerRegistry.resolveBanner('payment_failed');
    const html = emailComponents.renderPremiumEmail({
        preheaderText: `We couldn't complete your payment for booking #${id}.`,
        bannerSrc: banner?.src, bannerAlt: banner?.alt, subtitle: banner?.subtitle,
        headline: banner?.headline || 'Payment Not Completed',
        greeting: `Hi ${name},`,
        bodyHtml:
            `We noticed that your payment for <strong style="color:#FAFAFA;">${event_name || event_type}</strong> on <strong style="color:#FAFAFA;">${date}</strong> was not completed successfully.` +
            (displayTotal > 0 ? `<p style="margin:12px 0 0;"><strong style="color:#D4AF37;">Amount Due:</strong> R${parseFloat(displayTotal).toFixed(2)}</p>` : '') +
            `<p style="margin:10px 0 0; color:#E6E6E6;">Please try again via your booking tracker, or contact us directly if you need assistance. <span style="color:#B0B0B0; font-size:13px;">(Booking reference #${id})</span></p>` +
            `<p style="margin:10px 0 0; color:#B0B0B0; font-size:13px;">If this was a mistake, no action is needed — your booking remains active.</p>`,
        cta: { label: 'Try Payment Again', url: `${emailBaseUrl()}/?track=${id}&email=${encodeURIComponent(email)}` },
        socialLinks
    });
    const result = await sendEmail({
        to: email, subject: `Payment Unsuccessful – Booking #${id}`,
        htmlContent: html, preWrapped: true, titleOverride: 'Payment Not Completed',
        trigger_event: 'Booking: Payment Failed'
    });
    return result.success;
}

async function sendDepositBalanceDueEmail(booking, outstanding) {
    booking = escapeEmailFields(booking);
    const { id, name, email, event_name, event_type, date, event_location } = booking;
    // PAYMENT-CRITICAL: `R${parseFloat(outstanding).toFixed(2)}` kept verbatim (subject + body).
    const { socialLinks } = await getEmailFooterContext();
    const banner = await bannerRegistry.resolveBanner('deposit_balance_due');
    const html = emailComponents.renderPremiumEmail({
        preheaderText: `Deposit received — balance of R${parseFloat(outstanding).toFixed(2)} due for booking #${id}.`,
        bannerSrc: banner?.src, bannerAlt: banner?.alt, subtitle: banner?.subtitle,
        headline: banner?.headline || 'Deposit Received',
        greeting: `Hi ${name},`,
        bodyHtml:
            `Thank you for your deposit payment for <strong style="color:#FAFAFA;">${event_name || event_type}</strong> on <strong style="color:#FAFAFA;">${date}</strong>. Your booking is confirmed.` +
            `<p style="margin:10px 0 0; color:#B0B0B0; font-size:13px;">Please ensure payment is received at least 48 hours before the event. <span>(Booking reference #${id})</span></p>`,
        cards: [{
            title: 'Balance Due',
            rows: [{ label: 'Remaining Balance', value: `R${parseFloat(outstanding).toFixed(2)}`, highlight: true }]
        }],
        cta: { label: 'Settle Your Balance', url: `${process.env.SITE_URL || ''}/index.html#track` },
        socialLinks
    });
    const result = await sendEmail({
        to: email, subject: `Deposit Received – Balance Due R${parseFloat(outstanding).toFixed(2)} | Booking #${id}`,
        htmlContent: html, preWrapped: true, titleOverride: 'Deposit Received – Balance Reminder',
        trigger_event: 'Booking: Deposit Received, Balance Due'
    });
    return result.success;
}

async function sendPendingExpiredEmail(booking) {
    booking = escapeEmailFields(booking);
    const { id, name, email, event_name, event_type, date } = booking;
    const { socialLinks } = await getEmailFooterContext();
    const banner = await bannerRegistry.resolveBanner('pending_expired');
    const html = emailComponents.renderPremiumEmail({
        preheaderText: `Enquiry #${id} has expired — you can submit a new one any time.`,
        bannerSrc: banner?.src, bannerAlt: banner?.alt, subtitle: banner?.subtitle,
        headline: banner?.headline || 'Your Enquiry Has Expired',
        greeting: `Hi ${name},`,
        bodyHtml: `Your booking enquiry for <strong style="color:#FAFAFA;">${event_name || event_type}</strong>${date ? ` on <strong style="color:#FAFAFA;">${date}</strong>` : ''} has expired due to inactivity.<br><br>If you're still interested, we'd love to help make your event special — just submit a new enquiry. <span style="color:#B0B0B0; font-size:13px;">(Original reference #${id})</span>`,
        cta: { label: 'Submit a New Enquiry', url: `${process.env.SITE_URL || ''}/index.html#booking` },
        socialLinks
    });
    const result = await sendEmail({
        to: email, subject: `Booking Enquiry Expired – Reference #${id}`,
        htmlContent: html, preWrapped: true, titleOverride: 'Enquiry Expired',
        trigger_event: 'Booking: Enquiry Expired'
    });
    return result.success;
}

async function sendAdminPaymentNotification(booking, amountPaid, paymentStatus) {
    const notifEmail = await getNotificationEmail();
    const { id, name, email, event_name, event_type, date } = booking;
    const body = emailComponents.renderSystemEmail({
        preheaderText: `Payment received for booking #${id} — R${parseFloat(amountPaid).toFixed(2)}.`,
        category: 'Payments & Invoices',
        severity: 'info',
        leadFact: `Payment received for booking <strong style="color:#FAFAFA;">#${id}</strong>.`,
        cards: [{
            rows: [
                { label: 'Client', rawValue: `${emailComponents.esc(name)} (<a href="mailto:${email}" style="color:#D4AF37; text-decoration:none;">${email}</a>)` },
                { label: 'Event', value: `${event_name || event_type} on ${date}`, mono: false },
                { label: 'Amount Paid', value: `R${parseFloat(amountPaid).toFixed(2)}`, highlight: true },
                { label: 'Payment Status', value: paymentStatus }
            ]
        }]
    });
    await sendEmail({ to: notifEmail, subject: `Payment Received – Booking #${id}`,
        htmlContent: body, preWrapped: true, replyTo: email, titleOverride: 'Payment Received',
        trigger_event: 'Admin: Payment Notification' });
}

async function sendAdminCompletionSummaryEmail(booking) {
    booking = escapeEmailFields(booking);
    const notifEmail = await getNotificationEmail();
    const { id, name, email, event_name, event_type, date, event_location,
            total_amount, amount_paid, quote_amount } = booking;

    const displayTotal = parseFloat(total_amount) || parseFloat((quote_amount || '0').replace(/[^0-9.]/g, '')) || 0;
    const paid = parseFloat(amount_paid) || 0;

    // Fetch services for the P&L view
    const services = await new Promise(resolve => {
        db.all(`SELECT bs.quantity_minutes, bs.unit_price, bs.total_price, s.name as service_name, s.display_unit
                FROM booking_services bs
                LEFT JOIN services s ON bs.service_id = s.id
                WHERE bs.booking_id = ?`, [id], (e, rows) => resolve(e ? [] : (rows || [])));
    });

    // Fetch expenses (table is named 'expenses')
    const expenseRows = await new Promise(resolve => {
        db.all("SELECT description, amount FROM expenses WHERE booking_id = ? ORDER BY created_at ASC",
            [id], (e, rows) => resolve(e ? [] : (rows || [])));
    });
    const totalExpenses = expenseRows.reduce((sum, ex) => sum + (parseFloat(ex.amount) || 0), 0);
    const netRevenue = paid - totalExpenses;

    const cards = [{
        rows: [
            { label: 'Client', rawValue: `${emailComponents.esc(name)} (<a href="mailto:${email}" style="color:#D4AF37; text-decoration:none;">${email}</a>)` },
            { label: 'Event', value: `${event_name || event_type} on ${date}`, mono: false },
            { label: 'Venue', value: event_location || '—', mono: false }
        ]
    }];
    if (services.length > 0) {
        cards.push({ title: 'Services', rows: services.map(s => ({ label: s.service_name || 'Service', value: `R ${(parseFloat(s.total_price) || 0).toFixed(2)}`, mono: false })) });
    }
    if (expenseRows.length > 0) {
        cards.push({ title: 'Expenses', rows: expenseRows.map(ex => ({ label: ex.description, value: `– R ${(parseFloat(ex.amount) || 0).toFixed(2)}`, mono: false })) });
    }
    cards.push({
        title: 'Profit & Loss',
        rows: [
            { label: 'Total Quoted',     value: `R ${displayTotal.toFixed(2)}` },
            { label: 'Amount Collected', value: `R ${paid.toFixed(2)}`, highlight: true },
            ...(expenseRows.length > 0 ? [{ label: 'Total Expenses', value: `– R ${totalExpenses.toFixed(2)}` }] : []),
            ...(expenseRows.length > 0 ? [{ label: 'Net Revenue',    value: `R ${netRevenue.toFixed(2)}`, highlight: netRevenue > 0 }] : [])
        ]
    });

    const body = emailComponents.renderSystemEmail({
        preheaderText: `Booking #${id} completed — ${event_name || event_type}.`,
        category: 'Booking Confirmations',
        severity: 'info',
        leadFact: `<strong style="color:#FAFAFA;">Booking #${id}</strong> has been marked as <strong style="color:#D4AF37;">COMPLETED</strong>.`,
        bodyHtml: `<p style="margin:0; color:#B0B0B0; font-size:12px;">Open the Financials modal for full transaction history and VAT breakdown.</p>`,
        cards
    });

    await sendEmail({
        to: notifEmail, subject: `Booking #${id} Completed — ${event_name || event_type}`,
        htmlContent: body, preWrapped: true, replyTo: email, titleOverride: 'Booking Completed',
        trigger_event: 'Admin: Booking Completed Summary'
    });
}

async function sendAdminQuoteAcceptedNotification(booking) {
    const notifEmail = await getNotificationEmail();
    const { id, name, email, event_name, event_type, date } = booking;
    const body = emailComponents.renderSystemEmail({
        preheaderText: `${name} accepted the quote for booking #${id} — invoice auto-generated.`,
        category: 'Quotes & Proposals',
        severity: 'action',
        leadFact: `<strong style="color:#FAFAFA;">${emailComponents.esc(name)}</strong> (${email}) has accepted the quote for booking <strong style="color:#FAFAFA;">#${id}</strong>.`,
        bodyHtml: `<p style="margin:0; color:#E6E6E6;">An invoice has been auto-generated. Log in to confirm the booking.</p>`,
        cards: [{ rows: [{ label: 'Event', value: `${event_name || event_type} on ${date}`, mono: false }] }]
    });
    await sendEmail({ to: notifEmail, subject: `Invoice Issued – Booking #${id} Awaiting Payment`,
        htmlContent: body, preWrapped: true, replyTo: email, titleOverride: 'Invoice Issued – Action Required',
        trigger_event: 'Admin: Quote Accepted Notification' });
}

async function sendQuoteExpiryWarningEmail(booking) {
    booking = escapeEmailFields(booking);
    const { id, name, email, event_name, event_type, date, quote_expiry_date } = booking;
    const { socialLinks } = await getEmailFooterContext();
    const banner = await bannerRegistry.resolveBanner('quote_expiry_warning');
    const html = emailComponents.renderPremiumEmail({
        preheaderText: `Your quote for booking #${id} expires tomorrow.`,
        bannerSrc: banner?.src, bannerAlt: banner?.alt, subtitle: banner?.subtitle,
        headline: banner?.headline || 'Your Quote Expires Tomorrow',
        greeting: `Hi ${name},`,
        bodyHtml: `Your quote for <strong style="color:#FAFAFA;">${event_name || event_type}</strong> on <strong style="color:#FAFAFA;">${date}</strong> expires <strong style="color:#D4AF37;">tomorrow (${quote_expiry_date})</strong>. Accept it now via your booking tracker before it lapses.`,
        cta: { label: 'Accept Your Quote', url: `${process.env.SITE_URL || ''}/index.html#track` },
        socialLinks
    });
    return sendEmail({ to: email, subject: `Your Quote Expires Tomorrow – Booking #${id}`,
        htmlContent: html, preWrapped: true, titleOverride: 'Quote Expiring Soon', trigger_event: 'Booking: Quote Expiry Warning' });
}

async function sendReviewRequestEmail(booking) {
    booking = escapeEmailFields(booking);
    const { id, name, email, event_name, event_type, date } = booking;
    const { socialLinks } = await getEmailFooterContext();
    const banner = await bannerRegistry.resolveBanner('review_request');
    const html = emailComponents.renderPremiumEmail({
        preheaderText: `How was your event? We'd love your feedback on booking #${id}.`,
        bannerSrc: banner?.src, bannerAlt: banner?.alt, subtitle: banner?.subtitle,
        headline: banner?.headline || "We'd Love Your Feedback",
        greeting: `Hi ${name},`,
        bodyHtml: `We hope your event — <strong style="color:#FAFAFA;">${event_name || event_type}</strong> on <strong style="color:#FAFAFA;">${date}</strong> — was everything you imagined!<br><br>If you enjoyed working with Thabiso, a short review or testimonial would mean the world to us.`,
        cta: { label: 'Send Your Review', url: `mailto:info@thabisomhlongo.com?subject=Review for Booking %23${id}` },
        socialLinks
    });
    return sendEmail({ to: email, subject: `How was your event? – Booking #${id}`,
        htmlContent: html, preWrapped: true, titleOverride: "We'd Love Your Feedback!", trigger_event: 'Booking: Review Request' });
}

async function sendRefundProcessedEmail(booking, refundAmount, refundReference) {
    booking = escapeEmailFields(booking);
    const { id, name, email, event_name, event_type, date } = booking;
    // PAYMENT-CRITICAL: amtFormatted (`R {amount}`, space kept) and refundReference verbatim.
    // (Old table used light-mode #f5f5f5 cells inside the dark email — same defect as date-changed.)
    const amtFormatted = `R ${parseFloat(refundAmount || 0).toFixed(2)}`;
    const { socialLinks } = await getEmailFooterContext();
    const rows = [{ label: 'Refund Amount', value: amtFormatted, highlight: true }];
    if (refundReference) rows.push({ label: 'Reference', value: `${refundReference}` });
    const banner = await bannerRegistry.resolveBanner('refund_processed');
    const html = emailComponents.renderPremiumEmail({
        preheaderText: `Your refund of ${amtFormatted} for booking #${id} has been processed.`,
        bannerSrc: banner?.src, bannerAlt: banner?.alt, subtitle: banner?.subtitle,
        headline: banner?.headline || 'Refund Confirmation',
        greeting: `Hi ${name},`,
        bodyHtml:
            `We are writing to confirm that your refund for Booking <strong style="color:#FAFAFA;">#${id}</strong> — <strong style="color:#FAFAFA;">${event_name || event_type}</strong> on <strong style="color:#FAFAFA;">${date}</strong> — has been processed.` +
            `<p style="margin:14px 0 0; color:#E6E6E6;">Please allow 3&ndash;5 business days for the funds to reflect in your account, depending on your bank or payment method.</p>` +
            `<p style="margin:10px 0 0; color:#B0B0B0; font-size:13px;">If you have any questions, please reply to this email or contact us at <a href="mailto:bookings@thabisomhlongo.com" style="color:#D4AF37;">bookings@thabisomhlongo.com</a>.</p>`,
        cards: [{ title: 'Refund Details', rows }],
        socialLinks
    });
    return sendEmail({ to: email, subject: `Refund Processed – Booking #${id}`,
        htmlContent: html, preWrapped: true, titleOverride: 'Refund Confirmation', trigger_event: 'Booking: Refund Processed' });
}

async function sendDateChangedEmail(booking, oldDate, newDate) {
    booking = escapeEmailFields(booking);
    const { id, name, email, event_name, event_type } = booking;
    const baseUrl = process.env.BASE_URL || 'https://www.thabisomhlongo.com';
    const trackUrl = `${baseUrl}/?track=${id}&email=${encodeURIComponent(email)}`;
    const { socialLinks } = await getEmailFooterContext();
    const banner = await bannerRegistry.resolveBanner('booking_date_changed');
    const html = emailComponents.renderPremiumEmail({
        preheaderText: `Booking #${id}: the event date changed to ${newDate}.`,
        bannerSrc: banner?.src, bannerAlt: banner?.alt, subtitle: banner?.subtitle,
        headline: banner?.headline || 'Event Date Updated',
        greeting: `Hi ${name},`,
        bodyHtml: `Please note that the date for your booking <strong style="color:#FAFAFA;">#${id}</strong> — <strong style="color:#FAFAFA;">${event_name || event_type}</strong> — has been updated. Please update your calendar accordingly.<br><br><span style="color:#B0B0B0; font-size:13px;">If this change was made in error or you have any concerns, please contact us immediately at <a href="mailto:bookings@thabisomhlongo.com" style="color:#D4AF37;">bookings@thabisomhlongo.com</a>.</span>`,
        cards: [{
            title: 'Date Change',
            rows: [
                { label: 'Previous Date', rawValue: `<span style="text-decoration:line-through; color:#707070;">${oldDate}</span>` },
                { label: 'New Date', value: newDate, highlight: true }
            ]
        }],
        cta: { label: 'View My Booking', url: trackUrl },
        socialLinks
    });
    return sendEmail({ to: email, subject: `Event Date Updated – Booking #${id}`,
        htmlContent: html, preWrapped: true, titleOverride: 'Event Date Changed', trigger_event: 'Booking: Date Changed' });
}

// ==========================================
// PUBLIC GET SERVICES
// ==========================================
app.get('/api/public/services', (req, res) => {
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
// Promise wrappers over the shared sqlite connection. dbRun resolves with the sqlite3
// statement context, so `.lastID` / `.changes` stay available.
const dbRun = (sql, params = []) => new Promise((resolve, reject) => {
    db.run(sql, params, function (err) { err ? reject(err) : resolve(this); });
});
const dbGet = (sql, params = []) => new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => err ? reject(err) : resolve(row));
});

// Serializes transactional sections that run on the shared sqlite connection.
//
// node-sqlite3 multiplexes every request over ONE connection, and a transaction is a property of
// the connection, not of the request. A second `BEGIN IMMEDIATE` issued while another request's
// transaction is still open fails with "cannot start a transaction within a transaction" — under
// concurrent booking submissions the losing requests returned HTTP 500 and the lead was dropped.
// Worse, statements from an unrelated request that interleave with an open transaction get
// swept into it and are discarded by its ROLLBACK.
//
// Queuing guarded sections behind one another makes BEGIN → COMMIT/ROLLBACK atomic with respect
// to other guarded sections. Every `BEGIN TRANSACTION` site in this file should migrate onto this
// helper; the public booking intake is the first.
let dbTxnQueue = Promise.resolve();
function withDbTransaction(fn) {
    const result = dbTxnQueue.then(fn, fn);
    // Keep the chain alive regardless of how `fn` settled, so one failed transaction
    // does not wedge every subsequent one.
    dbTxnQueue = result.then(() => {}, () => {});
    return result;
}

// Free-text columns that have no DB-level length limit. Anything not listed here is either
// validated by its own rule (email/cell/date) or is not a client-supplied string.
const BOOKING_TEXT_LIMITS = {
    company: 150, event_name: 200, event_location: 200, venue_address: 300,
    city: 100, country: 100, venue_type: 60, event_type: 60,
    audience_size: 40, audience_demographic: 120, budget_range: 60,
    performance_slot: 40, performance_duration: 40,
    vat_number: 30, source: 100, referrer: 500
};

// A JSON body may send a number, array or object where a string is expected. Calling
// .trim()/.replace() on those throws before any validation runs, so every scalar is coerced
// first; non-scalars collapse to '' and are then caught by the required-field check.
function asBookingText(v) {
    if (v == null) return '';
    if (typeof v === 'string') return v.trim();
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    return '';
}

app.post('/api/public/bookings', ipRateLimiter, bookingRateLimiter, async (req, res) => {
    let {
        name, company, email, cell,
        event_name, event_date, event_start_time, performance_slot, performance_duration,
        event_location, venue_address, city, country, venue_type,
        event_type, audience_size, audience_demographic, budget_range, travel_accommodation, message,
        services, venuePlaceId, popia_consent, vat_number
    } = req.body;
    // req.body.policy_version is deliberately ignored — see CURRENT_POLICY_VERSION.

    // Normalize every free-text field once, up-front. Downstream code (validation, the INSERT
    // params, findOrCreateClient) then works on trimmed strings only.
    name = asBookingText(name);               company = asBookingText(company);
    email = asBookingText(email);             cell = asBookingText(cell);
    event_name = asBookingText(event_name);   event_date = asBookingText(event_date);
    event_start_time = asBookingText(event_start_time);
    performance_slot = asBookingText(performance_slot);
    performance_duration = asBookingText(performance_duration);
    event_location = asBookingText(event_location); venue_address = asBookingText(venue_address);
    city = asBookingText(city);               country = asBookingText(country);
    venue_type = asBookingText(venue_type);   event_type = asBookingText(event_type);
    audience_size = asBookingText(audience_size);
    audience_demographic = asBookingText(audience_demographic);
    budget_range = asBookingText(budget_range);
    message = asBookingText(message);         vat_number = asBookingText(vat_number);
    venuePlaceId = asBookingText(venuePlaceId);

    if (!name || !email || !cell || !event_date || !event_location || !event_type || !message) {
        return res.status(400).json({ success: false, message: 'Missing required booking fields.' });
    }

    // Field length and format validation
    if (name.length < 2 || name.length > 150)
        return res.status(400).json({ success: false, message: 'Name must be between 2 and 150 characters.' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200)
        return res.status(400).json({ success: false, message: 'Invalid email address.' });
    const cleanCell = cell.replace(/[\s\-().]/g, '');
    if (!/^\+?[0-9]{7,15}$/.test(cleanCell))
        return res.status(400).json({ success: false, message: 'Please enter a valid phone number (e.g. +27821234567 or +442071234567).' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(event_date))
        return res.status(400).json({ success: false, message: 'Invalid event date format.' });
    if (message.length < 10)
        return res.status(400).json({ success: false, message: 'Please provide a message of at least 10 characters.' });
    if (message.length > 2000)
        return res.status(400).json({ success: false, message: 'Message must be under 2000 characters.' });

    // Cap every remaining free-text column. Without this a single request can write megabytes
    // into TEXT columns that have no length constraint.
    const overLimit = Object.entries(BOOKING_TEXT_LIMITS)
        .find(([field, max]) => asBookingText(req.body[field]).length > max);
    if (overLimit) {
        return res.status(400).json({ success: false, message: `The ${overLimit[0].replace(/_/g, ' ')} field must be under ${overLimit[1]} characters.` });
    }

    // Calendar-real date, and never in the past. Previously the only date sanity check was the
    // per-service lead time, which is skipped entirely for the 13 services with
    // booking_lead_time_days = 0 — so a backdated event_date was accepted and saved.
    const eventMoment = moment(event_date, 'YYYY-MM-DD', true);
    if (!eventMoment.isValid())
        return res.status(400).json({ success: false, message: 'Invalid event date format.' });
    if (eventMoment.isBefore(moment().startOf('day')))
        return res.status(400).json({ success: false, message: 'The event date cannot be in the past.' });
    if (eventMoment.isAfter(moment().add(5, 'years')))
        return res.status(400).json({ success: false, message: 'The event date is too far in the future. Please contact us directly for bookings more than 5 years ahead.' });

    // event_start_time reaches moment(), addMinutesToTime() and the working-hours gate unvalidated.
    // A non-time value ("abc") produced "NaN:NaN" end times and an Invalid-date ISO conversion.
    if (event_start_time) {
        const tm = event_start_time.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
        if (!tm) return res.status(400).json({ success: false, message: 'Invalid event start time. Use HH:MM (24-hour), e.g. 19:30.' });
        event_start_time = `${tm[1].padStart(2, '0')}:${tm[2]}`; // zero-pad so string compares and moment() parsing are safe
    }

    if (!popia_consent) {
        return res.status(400).json({ success: false, message: 'POPIA consent is required to submit a booking request.' });
    }


    try {
        // ── Read-only gates run first ─────────────────────────────────────────────────────
        // findOrCreateClient() / findOrCreateVenueFromPlace() are the first statements in this
        // handler that WRITE. They used to run before service validation, lead-time, per-day,
        // quantity and calendar-conflict checks — so every 400/409 raised by those gates left an
        // orphan clients row (email is UNIQUE, poisoning the next legitimate signup) and an orphan
        // venues row behind. All rejections now happen before the first write.

        // 1. SECURE SERVICE VALIDATION & SNAPSHOTTING
        if (!services || !Array.isArray(services) || services.length === 0) {
            return res.status(400).json({ success: false, message: 'At least one service must be selected.' });
        }

        const svcIds = services.map(s => parseInt(s.service_id)).filter(id => !isNaN(id));
        if (svcIds.length === 0) {
            return res.status(400).json({ success: false, message: 'Invalid services provided.' });
        }

        const placeholders = svcIds.map(() => '?').join(',');
        const query = `SELECT * FROM services WHERE id IN (${placeholders})`;
        const dbServices = await new Promise((resolve, reject) => {
            db.all(query, svcIds, (err, rows) => {
                if (err) reject(err); else resolve(rows);
            });
        });

        let selectedServices = [];
        let calculatedBaseScope = 0;

        for (const inputSvc of services) {
            const srv = dbServices.find(s => s.id === parseInt(inputSvc.service_id));
            if (!srv || (srv.is_active !== undefined && srv.is_active === 0) || srv.is_deleted === 1) {
                return res.status(400).json({ success: false, message: `Service ID ${inputSvc.service_id} is invalid or inactive.` });
            }

            // Lead Time Validation
            if (srv.booking_lead_time_days > 0) {
                const today = moment().startOf('day');
                const eventDate = moment(event_date).startOf('day');
                const diffDays = eventDate.diff(today, 'days');
                if (diffDays < srv.booking_lead_time_days) {
                    return res.status(400).json({ success: false, message: `Booking for ${srv.name} requires at least ${srv.booking_lead_time_days} days advance notice.` });
                }
            }

            // Availability Rule Validation (per_day)
            if (srv.availability_rule === 'per_day') {
                const alreadyBooked = await new Promise((resolve) => {
                    db.get(`SELECT bs.id FROM booking_services bs
                            JOIN bookings b ON bs.booking_id = b.id
                            WHERE bs.service_id = ? AND b.date = ? AND b.status IN ('CONFIRMED', 'ACCEPTED', 'QUOTED')`,
                        [srv.id, event_date], (err, row) => resolve(row));
                });
                if (alreadyBooked) {
                    return res.status(409).json({ success: false, message: `The service ${srv.name} is already booked for ${event_date}.` });
                }
            }

            const model = srv.pricing_model || 'flat';
            const isFlat = model === 'flat' || model === 'flat_fee';
            const isPerMinute = model === 'per_minute';
            const isPerHour = model === 'per_hour';
            
            const rawDur = parseDurationMins(performance_duration);
            let qtyMinutes = 1; // Used as billable quantity now
            
            if (isPerMinute) qtyMinutes = rawDur;
            else if (isPerHour) qtyMinutes = Math.ceil(rawDur / 60);
            else if (!isFlat) qtyMinutes = parseInt(inputSvc.quantity_minutes) || 1; // Fallback for other models

            if (!isFlat) {
                const minQ = srv.min_quantity || 1;
                const maxQ = srv.max_quantity || 999999;
                if (qtyMinutes < minQ || qtyMinutes > maxQ) {
                    return res.status(400).json({ success: false, message: `Quantity for ${srv.name} must be between ${minQ} and ${maxQ}.` });
                }
            } else {
                qtyMinutes = 1; // Default to 1 unit for flat fee if not specified
            }

            const unitPrice = parseFloat(srv.base_price != null ? srv.base_price : (srv.default_price ?? 0));
            const lineTotal = isFlat ? unitPrice : (unitPrice * qtyMinutes); 
            
            calculatedBaseScope += lineTotal;
            selectedServices.push({
                service_id: srv.id,
                name: srv.name,
                quantity_minutes: qtyMinutes,
                unit_price: unitPrice,
                total_price: lineTotal,
                pricing_model: model
            });
        }

        // 2. OCCUPANCY WINDOW — a single duration now drives the working-hours gate, the conflict
        //    window and the persisted performance_end_time. These used to disagree: working hours
        //    were checked against the form's performance_duration while the stored end time (which
        //    later bookings are conflict-checked against) used the service-catalogue duration, so a
        //    booking could pass the gate and then persist an end time outside working hours.
        const maxServiceMins = dbServices.reduce((max, srv) => {
            const total = (parseInt(srv.performance_length_minutes) || 0)
                        + (parseInt(srv.setup_time_minutes) || 0);
            return Math.max(max, total);
        }, 0);
        const formMins = performance_duration ? parseDurationToMinutes(performance_duration) : 0;
        const durationMins = Math.max(maxServiceMins, formMins) || 120;
        const startTime = moment(`${event_date} ${event_start_time || '18:00'}`, 'YYYY-MM-DD HH:mm', true).toISOString();
        const endTime   = moment(startTime).add(durationMins, 'minutes').toISOString();

        // 3. DATE AVAILABILITY — holds, standalone events, already-booked dates.
        //    checkDateAvailability() calls back with (err) and no result on a DB error; resolving
        //    that as `undefined` used to throw on `.available` a line later.
        const availableResult = await new Promise((resolve, reject) => {
            checkDateAvailability(event_date, (err, result) => err ? reject(err) : resolve(result));
        });
        if (!availableResult.available) {
            return res.status(409).json({ success: false, message: 'The selected date is no longer available.' });
        }

        // 4. DUPLICATE CHECK: same email + same date with an already-active booking
        const existingBooking = await new Promise((resolve, reject) =>
            db.get(
                `SELECT id FROM bookings
                 WHERE lower(email) = lower(?) AND date = ? AND status NOT IN ('CANCELLED','EXPIRED')
                 LIMIT 1`,
                [email, event_date],
                (err, row) => err ? reject(err) : resolve(row)
            )
        );
        if (existingBooking) {
            return res.status(409).json({
                success: false,
                existing_id: existingBooking.id,
                message: `You already have an active booking (#${existingBooking.id}) for this date. Please track that booking, or contact us if you need to make changes.`
            });
        }

        // 5. Server-side working hours enforcement (timed bookings only)
        if (event_start_time) {
            const endHHMM = addMinutesToTime(event_start_time, durationMins);
            const wh = await isWithinWorkingHours(event_date, event_start_time, endHHMM);
            if (!wh.allowed) {
                return res.status(400).json({ success: false, message: wh.reason });
            }
        }

        // 6. Time overlap against the busy ranges from the availability check
        if ((performance_slot || event_start_time) && availableResult.busy_ranges && availableResult.busy_ranges.length > 0) {
            // L2: compare by minutes, not lexically. performance_slot comes from the public form and
            // may be non-zero-padded (e.g. "9:00"), where the string compare "9:00" < "10:00" is false
            // and would miss a real overlap. toMin() normalizes both sides.
            const toMin = (t) => { const [h, m] = String(t).split(':').map(Number); return (h || 0) * 60 + (m || 0); };
            const overlap = (s1, e1, s2, e2) => (toMin(s1) < toMin(e2)) && (toMin(s2) < toMin(e1));
            let from, to;
            // Prefer performance_slot ("HH:MM–HH:MM") for the most accurate window
            if (performance_slot && performance_slot.includes('–')) {
                const slotParts = performance_slot.split('–');
                from = slotParts[0].trim();
                to = slotParts[1].trim();
            } else if (event_start_time) {
                from = event_start_time;
                to = addMinutesToTime(from, durationMins);
            }

            let conflict = false;
            if (from && to) {
                availableResult.busy_ranges.forEach(r => {
                    if (overlap(from, to, r.start, r.end)) {
                        conflict = true;
                    }
                });
            }

            if (conflict) {
                return res.status(409).json({ success: false, message: 'The selected time slot overlaps with a blocked period or another booking.' });
            }
        }

        // 7. CALENDAR CONFLICT DETECTION (local holds + bookings + Google free/busy)
        const isBusy = await hasCalendarConflict(startTime, endTime);
        if (isBusy) {
            return res.status(409).json({
                success: false,
                message: 'This date and time are currently unavailable on Thabiso\'s schedule. Please select another slot or contact us for special inquiries.'
            });
        }

        // 8. NORMALIZE RELATIONAL CORE ENTITIES — the first writes in this handler.
        const clientId = await findOrCreateClient(name, email, cell, company, vat_number);
        const venueId = await findOrCreateVenueFromPlace(event_location, venue_address, city, country, venuePlaceId);

        let initialQuoteAmountStr = `R ${calculatedBaseScope.toFixed(2)}`;
        let initialTotalAmount = calculatedBaseScope;
        let paymentStatus = 'UNPAID';

        // Default expiry: event date minus 14 days; overridden when admin generates the actual quote
        const defaultQuoteExpiry = moment(event_date).subtract(14, 'days').format('YYYY-MM-DD');

        // 9. SAVE TO DATABASE — booking + all child rows are committed atomically inside
        //    BEGIN IMMEDIATE, serialized against every other guarded transaction on the shared
        //    connection. Same-client multi-booking on the same day is allowed; date, time-overlap
        //    and duplicate rules are all re-checked inside the lock so two concurrent submissions
        //    cannot double-book a slot.
        const outcome = await withDbTransaction(async () => {
            try {
                await dbRun("BEGIN IMMEDIATE");
            } catch (beginErr) {
                console.error('[Booking] BEGIN IMMEDIATE failed:', beginErr.message);
                return { status: 500, body: { success: false, message: 'Database error while saving booking.' } };
            }

            try {
                // Re-check availability inside the lock to close the race window. A DB error here is
                // NOT the same as an unavailable date — reporting "no longer available" on a transient
                // SQLITE_BUSY sends the client away from a date that is in fact free.
                let lockedAvail;
                try {
                    lockedAvail = await new Promise((resolve, reject) =>
                        checkDateAvailability(event_date, (e, r) => e ? reject(e) : resolve(r)));
                } catch (availErr) {
                    await dbRun("ROLLBACK").catch(() => {});
                    console.error('[Booking] In-lock availability re-check failed:', availErr.message);
                    return { status: 503, body: { success: false, message: 'We could not confirm availability just now. Please try again in a moment.' } };
                }
                if (!lockedAvail.available) {
                    await dbRun("ROLLBACK").catch(() => {});
                    return { status: 409, body: { success: false, message: 'The selected date is no longer available.' } };
                }

                // F1: re-run the time-overlap check INSIDE the write lock. skipGoogle=true keeps it to
                // fast local reads (no network call while holding BEGIN IMMEDIATE). Because writers
                // serialize, a second concurrent submission now sees the first (committed) booking here
                // and is rejected instead of double-booking the slot.
                const lockedBusy = await hasCalendarConflict(startTime, endTime, null, true);
                if (lockedBusy) {
                    await dbRun("ROLLBACK").catch(() => {});
                    return { status: 409, body: { success: false, message: 'This date and time were just booked. Please select another slot or contact us for special inquiries.' } };
                }

                // F3: re-run the same-email/same-date duplicate check inside the lock. The pre-lock
                // check alone leaves a window: hasCalendarConflict() skips rows with a NULL
                // event_start_time, so two untimed submissions for the same date never collide there.
                const lockedDuplicate = await dbGet(
                    `SELECT id FROM bookings
                     WHERE lower(email) = lower(?) AND date = ? AND status NOT IN ('CANCELLED','EXPIRED')
                     LIMIT 1`,
                    [email, event_date]
                );
                if (lockedDuplicate) {
                    await dbRun("ROLLBACK").catch(() => {});
                    return {
                        status: 409,
                        body: {
                            success: false,
                            existing_id: lockedDuplicate.id,
                            message: `You already have an active booking (#${lockedDuplicate.id}) for this date. Please track that booking, or contact us if you need to make changes.`
                        }
                    };
                }

                // F2: write ALL child rows inside the transaction, then COMMIT. If any child insert
                // fails we ROLLBACK, so we never persist a booking without the services / line items
                // its quote_amount was calculated from.
                const insert = await dbRun(`INSERT INTO bookings (
                            name, company, email, cell,
                            event_name, date, event_start_time, performance_slot, performance_duration,
                            event_location, venue_address, city, country, venue_type,
                            event_type, audience_size, audience_demographic, budget_range, travel_accommodation, message, status,
                            client_id, venue_id, quote_amount, total_amount, amount_outstanding, payment_status, popia_consent, consent_timestamp, vat_number, venue_place_id, quote_expiry_date, policy_version, source, referrer, consent_source
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, "NEW", ?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP, ?, ?, ?, ?, ?, ?, 'public_form')`,
                    [
                        encodeUserHtml(name), encodeUserHtml(company) || null, email, cell,
                        encodeUserHtml(event_name) || null, event_date, event_start_time || null, encodeUserHtml(performance_slot) || null, encodeUserHtml(performance_duration) || null,
                        encodeUserHtml(event_location), encodeUserHtml(venue_address) || null, encodeUserHtml(city) || null, encodeUserHtml(country) || null, encodeUserHtml(venue_type) || null,
                        encodeUserHtml(event_type), encodeUserHtml(audience_size) || null, encodeUserHtml(audience_demographic) || null, encodeUserHtml(budget_range) || null, travel_accommodation ? 1 : 0, encodeUserHtml(message),
                        clientId, venueId, initialQuoteAmountStr, initialTotalAmount, initialTotalAmount, paymentStatus, vat_number || null, venuePlaceId || null, defaultQuoteExpiry, CURRENT_POLICY_VERSION,
                        encodeUserHtml(asBookingText(req.body.source)) || null, encodeUserHtml(asBookingText(req.body.referrer)) || null
                    ]
                );
                const bookingId = insert.lastID;

                // POPIA consent audit — immutable record of when/where consent was given
                await dbRun(
                    `INSERT INTO consent_audit (booking_id, ip_address, user_agent, policy_version, consent_source) VALUES (?, ?, ?, ?, 'public_form')`,
                    [bookingId, req.ip || null, req.headers['user-agent'] || null, CURRENT_POLICY_VERSION]
                );

                // Audit trail for booking creation (trigger only fires on UPDATE, not INSERT).
                // Records the normalized values that were actually persisted, plus the originating
                // IP — audit_log.ip_address was previously left NULL for every public submission.
                await dbRun(
                    `INSERT INTO audit_log (table_name, record_id, action, new_values, changed_by, ip_address) VALUES ('bookings', ?, 'CREATE', ?, 'public', ?)`,
                    [bookingId, JSON.stringify({ name, email, date: event_date, status: 'NEW' }), req.ip || null]
                );

                // X3: derive the performance window from performance_slot when it parses, otherwise
                // from event_start_time + the occupancy duration. Both the start and the end are
                // written: previously the event_start_time branches set only performance_end_time,
                // leaving performance_start_time NULL on every timed booking without a slot string.
                const slotM = performance_slot
                    ? performance_slot.match(/(\d{1,2}:\d{2})\s*[–\-]\s*(\d{1,2}:\d{2})/)
                    : null;
                const pad = (t) => { const [h, m] = t.split(':'); return `${h.padStart(2, '0')}:${m}`; };
                let perfStart = null, perfEnd = null;
                if (slotM) {
                    perfStart = pad(slotM[1]);
                    perfEnd = pad(slotM[2]);
                } else if (event_start_time) {
                    perfStart = event_start_time;
                    perfEnd = addMinutesToTime(event_start_time, durationMins);
                }
                if (perfStart && perfEnd) {
                    await dbRun("UPDATE bookings SET performance_start_time = ?, performance_end_time = ? WHERE id = ?",
                        [perfStart, perfEnd, bookingId]);
                }

                // 10. INSERT BOOKING SERVICES (Relational)
                for (const srv of selectedServices) {
                    await dbRun("INSERT INTO booking_services (booking_id, service_id, quantity_minutes, unit_price, total_price) VALUES (?, ?, ?, ?, ?)",
                        [bookingId, srv.service_id, srv.quantity_minutes, srv.unit_price, srv.total_price]);
                    await dbRun("INSERT INTO booking_line_items (booking_id, service_id, description, quantity, unit_price) VALUES (?, ?, ?, ?, ?)",
                        [bookingId, srv.service_id, srv.name, srv.quantity_minutes, srv.unit_price]);
                }

                // All child rows persisted — commit the whole booking atomically.
                await dbRun("COMMIT");
                return { ok: true, bookingId };
            } catch (dbErr) {
                await dbRun("ROLLBACK").catch(() => {});
                console.error("[Booking] Transactional insert failed — rolled back, no partial booking saved:", dbErr.message);
                return { status: 500, body: { success: false, message: 'Database error while saving booking.' } };
            }
        });

        if (!outcome.ok) {
            return res.status(outcome.status).json(outcome.body);
        }
        const bookingId = outcome.bookingId;

        // ---- Side effects run AFTER commit (non-blocking; must never roll back the booking) ----

        // 11. SYNC TO GOOGLE CALENDAR (Asynchronously/Non-blocking)
        syncBookingToCalendar(bookingId).catch(calErr => {
            console.error('[Booking] Google Calendar sync failed (booking still saved):', calErr.message);
            // Alert admin so the orphaned calendar slot can be fixed manually
            getNotificationEmail().then(notifEmail => sendEmail({
                to: notifEmail,
                subject: `⚠️ Google Calendar Sync Failed – New Booking #${bookingId}`,
                htmlContent: emailComponents.renderSystemEmail({
                    preheaderText: `Booking #${bookingId} saved but its Google Calendar event failed.`,
                    category: 'System',
                    severity: 'alert',
                    leadFact: `Booking <strong style="color:#FAFAFA;">#${bookingId}</strong> was saved successfully but the Google Calendar event could not be created.`,
                    bodyHtml: `<p style="margin:0 0 10px; color:#B0B0B0; font-size:12px;">Error: ${calErr.message}</p><p style="margin:0; color:#E6E6E6;">Please create the calendar entry manually to avoid a scheduling conflict.</p>`
                }),
                preWrapped: true,
                titleOverride: 'Calendar Sync Failed',
                trigger_event: 'System: Calendar Sync Failure',
                skipBrandAttachments: true
            })).catch(() => {});
        });

        // 12. DISPATCH EMAILS CONCURRENTLY (Asynchronously/Non-blocking)
        sendBookingReceivedEmail(bookingId, req.body).catch(e => console.error("Async email dispatch failed:", e));

        // Booking Recovery: mark any matching abandoned draft as recovered (non-blocking)
        if (req.body.draft_token) {
            db.run(`UPDATE abandoned_bookings SET status='RECOVERED', converted_booking_id=?, last_activity_at=CURRENT_TIMESTAMP
                    WHERE draft_token=? AND status NOT IN ('RECOVERED','WON')`,
                [bookingId, req.body.draft_token],
                (e) => { if (e) console.error('[Booking Recovery] convert-mark failed:', e.message); });
        }

        res.json({ success: true, message: 'Booking submitted successfully! Check your inbox for confirmation.', booking_id: bookingId });
    } catch (e) {
        console.error("[Booking] Intake failed before commit:", e);
        res.status(500).json({ success: false, message: "We could not process your booking request. Please try again, or contact us directly if the problem persists." });
    }
});

// ============================================================================
// BOOKING RECOVERY — abandoned booking drafts (abandoned-cart style)
//  • Public: autosave drafts, resume a draft, opt out of reminders.
//  • Admin:  list / stats / export / detail / manual resend / status.
//  • Reminder + purge jobs live near the other scheduled jobs (end of file).
//  POPIA: capture is minimised to email-present drafts, auto-emails are
//  consent-gated, every reminder carries an opt-out link, and stale rows are
//  purged after 30 days.
// ============================================================================

// Best-effort estimate of the value of selected services (lost-revenue analytics).
async function estimateDraftValue(services) {
    try {
        if (!Array.isArray(services) || services.length === 0) return 0;
        const ids = services.map(s => parseInt(s.service_id)).filter(n => !isNaN(n));
        if (!ids.length) return 0;
        const placeholders = ids.map(() => '?').join(',');
        const rows = await new Promise(resolve =>
            db.all(`SELECT id, base_price, default_price FROM services WHERE id IN (${placeholders})`, ids,
                (err, r) => resolve(err ? [] : (r || []))));
        let total = 0;
        for (const s of services) {
            const row = rows.find(r => r.id === parseInt(s.service_id));
            if (!row) continue;
            const price = parseFloat(row.base_price != null ? row.base_price : (row.default_price || 0)) || 0;
            const qty = parseInt(s.quantity || s.quantity_minutes || 1) || 1;
            total += price * qty;
        }
        return Math.round(total * 100) / 100;
    } catch (e) { return 0; }
}

// Branded recovery reminder email with a one-click resume link + opt-out.
async function sendAbandonedBookingReminderEmail(draft) {
    if (!draft || !draft.email || draft.opt_out) return false;
    const base = process.env.BASE_URL || 'https://www.thabisomhlongo.com';
    const resumeUrl = `${base}/?resume=${encodeURIComponent(draft.resume_token)}`;
    const optOutUrl = `${base}/api/public/bookings/draft/${encodeURIComponent(draft.resume_token)}/optout`;
    let services = [];
    try { services = draft.services_json ? JSON.parse(draft.services_json) : []; } catch (e) {}
    const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const summaryRows = [
        ['Event', draft.event_name],
        ['Date', draft.event_date],
        ['Type', draft.event_type],
        ['Venue', draft.event_location],
        ['Services', services.map(s => esc(s.name)).filter(Boolean).join(', ')]
    ].filter(r => r[1]).map(r => ({ label: r[0], value: r[1], mono: false }));

    const { socialLinks } = await getEmailFooterContext();
    const banner = await bannerRegistry.resolveBanner('abandoned_booking_recovery');
    const html = emailComponents.renderPremiumEmail({
        preheaderText: "You started a booking request — pick up right where you left off.",
        bannerSrc: banner?.src, bannerAlt: banner?.alt, subtitle: banner?.subtitle,
        headline: banner?.headline || 'Finish Your Booking Request',
        greeting: `Hi ${esc(draft.name || 'there')},`,
        bodyHtml:
            `It looks like you started a booking request for <strong style="color:#D4AF37;">Thabiso Mhlongo</strong> but didn't quite finish. Good news — your details are saved, so you can pick up right where you left off.` +
            `<p style="margin:12px 0 0; color:#B0B0B0; font-size:12px;">Submitting a request doesn't confirm a booking — our team reviews each one and sends a personalised quote, usually within 2 business days.</p>`,
        cards: summaryRows.length ? [{ title: 'Your Booking So Far', rows: summaryRows }] : [],
        cta: { label: 'Resume My Booking', url: resumeUrl },
        unsubscribeUrl: optOutUrl,
        socialLinks
    });
    try {
        const info = await sendEmail({
            to: draft.email,
            subject: 'Complete your booking request — Thabiso Mhlongo',
            htmlContent: html,
            preWrapped: true,
            titleOverride: 'Finish Your Booking Request',
            trigger_event: 'Booking: Recovery Reminder'
        });
        return !!(info && info.success);
    } catch (e) { console.error('[Booking Recovery] reminder email failed:', e.message); return false; }
}

// ---- Public: upsert a draft (autosave). Uses only ipRateLimiter (100/hr) so debounced autosaves aren't blocked. ----
app.post('/api/public/bookings/draft', ipRateLimiter, async (req, res) => {
    try {
        const b = req.body || {};
        const draftToken = (b.draft_token || '').toString().slice(0, 80);
        if (!draftToken) return res.status(400).json({ success: false, message: 'Missing draft token.' });

        const email = (b.email || '').toString().trim().slice(0, 200);
        // POPIA data minimisation: only persist once a valid email exists (Step 2+).
        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return res.json({ success: true, skipped: true });
        }

        const eventDate = (b.event_date || '').toString().slice(0, 20);
        // If a real booking already exists for this email+date, don't track it as abandoned.
        if (eventDate) {
            const existing = await new Promise(resolve => db.get(
                `SELECT id FROM bookings WHERE lower(email)=lower(?) AND date=? AND status NOT IN ('CANCELLED','EXPIRED') LIMIT 1`,
                [email, eventDate], (e, row) => resolve(row)));
            if (existing) return res.json({ success: true, converted: true });
        }

        const services = Array.isArray(b.services) ? b.services : [];
        const servicesJson = JSON.stringify(services.map(s => ({ service_id: s.service_id, name: s.name, quantity: s.quantity || s.quantity_minutes || 1 })));
        const estValue = await estimateDraftValue(services);
        const currentStep = Math.min(4, Math.max(1, parseInt(b.current_step) || 1));
        const consent = b.consent_given ? 1 : 0;
        const source = (b.source || '').toString().slice(0, 120);
        const ua = (req.headers['user-agent'] || '').toString().slice(0, 255);
        const ip = (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim();
        const msg = (b.message || '').toString().slice(0, 2000);

        const resumeToken = crypto.randomBytes(24).toString('hex');

        // Atomic UPSERT keyed by draft_token — race-safe (BUG-1). On conflict, resume_token/
        // created_at are preserved (not in the SET list), furthest_step stays monotonic, and
        // terminal statuses (RECOVERED/WON/LOST/CLOSED) are never downgraded back to ABANDONED.
        db.run(
            `INSERT INTO abandoned_bookings
                (draft_token, resume_token, name, company, email, cell, event_name, event_date, event_start_time,
                 performance_slot, performance_duration, event_location, venue_address, city, country, venue_type, event_type, message,
                 services_json, current_step, furthest_step, consent_given, est_value, source, ip_address, user_agent)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
             ON CONFLICT(draft_token) DO UPDATE SET
                name=excluded.name, company=excluded.company, email=excluded.email, cell=excluded.cell,
                event_name=excluded.event_name, event_date=excluded.event_date, event_start_time=excluded.event_start_time,
                performance_slot=excluded.performance_slot, performance_duration=excluded.performance_duration,
                event_location=excluded.event_location, venue_address=excluded.venue_address, city=excluded.city,
                country=excluded.country, venue_type=excluded.venue_type, event_type=excluded.event_type, message=excluded.message,
                services_json=excluded.services_json, current_step=excluded.current_step,
                furthest_step=MAX(abandoned_bookings.furthest_step, excluded.furthest_step),
                consent_given=excluded.consent_given, est_value=excluded.est_value,
                source=COALESCE(NULLIF(excluded.source, ''), abandoned_bookings.source),
                ip_address=excluded.ip_address, user_agent=excluded.user_agent, last_activity_at=CURRENT_TIMESTAMP,
                status=CASE WHEN abandoned_bookings.status IN ('RECOVERED','WON','LOST','CLOSED') THEN abandoned_bookings.status ELSE 'ABANDONED' END`,
            [draftToken, resumeToken, encodeUserHtml(b.name) || null, encodeUserHtml(b.company) || null, email, b.cell || null, encodeUserHtml(b.event_name) || null, eventDate || null, b.event_start_time || null,
             encodeUserHtml(b.performance_slot) || null, encodeUserHtml(b.performance_duration) || null, encodeUserHtml(b.event_location) || null, encodeUserHtml(b.venue_address) || null, encodeUserHtml(b.city) || null, encodeUserHtml(b.country) || null, encodeUserHtml(b.venue_type) || null, encodeUserHtml(b.event_type) || null, encodeUserHtml(msg),
             servicesJson, currentStep, currentStep, consent, estValue, source, ip, ua],
            (err) => {
                if (err) { console.error('[Booking Recovery] draft upsert failed:', err.message); return res.status(500).json({ success: false }); }
                // Return the row's resume_token (the original one if this was an update).
                db.get(`SELECT resume_token FROM abandoned_bookings WHERE draft_token=?`, [draftToken],
                    (e2, row) => res.json({ success: true, resume_token: row ? row.resume_token : resumeToken }));
            });
    } catch (e) { console.error('[Booking Recovery] draft endpoint error:', e.message); res.status(500).json({ success: false }); }
});

// ---- Public: fetch a draft for resume (prefill the wizard) ----
app.get('/api/public/bookings/draft/:resumeToken', ipRateLimiter, (req, res) => {
    db.get(`SELECT * FROM abandoned_bookings WHERE resume_token=?`, [req.params.resumeToken], (err, row) => {
        if (err || !row) return res.status(404).json({ success: false, message: 'Draft not found.' });
        if (row.opt_out || row.status === 'RECOVERED' || row.status === 'CLOSED') {
            return res.status(410).json({ success: false, message: 'This booking draft is no longer available.' });
        }
        let services = [];
        try { services = row.services_json ? JSON.parse(row.services_json) : []; } catch (e) {}
        res.json({ success: true, draft: {
            draft_token: row.draft_token,
            name: row.name, company: row.company, email: row.email, cell: row.cell,
            event_name: row.event_name, event_date: row.event_date, event_start_time: row.event_start_time,
            performance_slot: row.performance_slot, performance_duration: row.performance_duration,
            event_location: row.event_location, venue_address: row.venue_address, city: row.city, country: row.country, venue_type: row.venue_type,
            event_type: row.event_type, message: row.message, services,
            current_step: row.current_step, furthest_step: row.furthest_step
        }});
    });
});

// ---- Public: opt out of recovery reminders ----
// BUG-2: a GET must NOT mutate state — corporate email-security scanners pre-fetch links and would
// silently unsubscribe engaged users. The GET renders a confirmation page; the POST performs it.
function _abOptOutPage(inner) {
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Booking reminders</title></head>
        <body style="font-family:Arial,sans-serif;background:#0a0a0a;color:#e8e8e8;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px;">
        <div style="max-width:460px;text-align:center;border:1px solid rgba(255,255,255,0.12);border-radius:12px;padding:36px 28px;">
        ${inner}
        <p style="color:#888;font-size:13px;margin:22px 0 0;">Thabiso Mhlongo Management</p>
        </div></body></html>`;
}

app.get('/api/public/bookings/draft/:resumeToken/optout', ipRateLimiter, (req, res) => {
    const token = encodeURIComponent(req.params.resumeToken); // safe inside the form action attribute
    res.setHeader('Content-Type', 'text/html');
    res.send(_abOptOutPage(
        '<div style="font-size:34px;color:#D4AF37;margin-bottom:12px;">&#9993;</div>'
        + '<h2 style="font-weight:400;margin:0 0 10px;">Stop booking reminders?</h2>'
        + '<p style="color:#b0b0b0;font-size:14px;margin:0 0 22px;">You will no longer receive emails reminding you to finish your booking request.</p>'
        + '<form method="POST" action="/api/public/bookings/draft/' + token + '/optout" style="margin:0;">'
        + '<button type="submit" style="padding:12px 24px;background:#D4AF37;color:#000;border:none;border-radius:4px;font-weight:bold;font-size:14px;cursor:pointer;">Yes, stop reminders</button>'
        + '</form>'
        + '<a href="' + (process.env.BASE_URL || '') + '/" style="display:inline-block;margin-top:16px;color:#888;text-decoration:none;font-size:13px;">No, take me back to the site</a>'
    ));
});

app.post('/api/public/bookings/draft/:resumeToken/optout', ipRateLimiter, (req, res) => {
    db.run(`UPDATE abandoned_bookings SET opt_out=1, status=CASE WHEN status IN ('RECOVERED','WON') THEN status ELSE 'CLOSED' END WHERE resume_token=?`,
        [req.params.resumeToken], function (err) {
            res.setHeader('Content-Type', 'text/html');
            const back = '<a href="' + (process.env.BASE_URL || '') + '/" style="display:inline-block;margin-top:8px;color:#D4AF37;text-decoration:none;font-size:14px;">Return to the website &rarr;</a>';
            if (err) return res.status(500).send(_abOptOutPage('<div style="font-size:34px;color:#888;margin-bottom:12px;">&#9888;</div><h2 style="font-weight:400;margin:0 0 10px;">Something went wrong.</h2><p style="color:#b0b0b0;font-size:14px;">Please try again later.</p>' + back));
            res.send(_abOptOutPage('<div style="font-size:34px;color:#D4AF37;margin-bottom:12px;">&#10003;</div><h2 style="font-weight:400;margin:0 0 10px;">You have been unsubscribed.</h2><p style="color:#b0b0b0;font-size:14px;">You will not receive any more booking reminders.</p>' + back));
        });
});

// ---- Admin: list abandoned bookings (search / filter / sort / paginate) ----
app.get('/api/admin/abandoned-bookings', requireAdmin, (req, res) => {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 25));
    const offset = (page - 1) * limit;
    const status = (req.query.status || 'all').toString();
    const stage = (req.query.stage || 'all').toString();
    const search = (req.query.search || '').toString().trim();
    const sort = (req.query.sort || 'recent').toString();

    const where = [], params = [];
    if (status && status !== 'all') { where.push('status = ?'); params.push(status.toUpperCase()); }
    if (stage && stage !== 'all') { where.push('furthest_step = ?'); params.push(parseInt(stage) || 1); }
    if (search) { where.push('(name LIKE ? OR email LIKE ? OR event_name LIKE ? OR event_type LIKE ?)'); const s = `%${search}%`; params.push(s, s, s, s); }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const orderSql = sort === 'oldest' ? 'last_activity_at ASC'
        : sort === 'value' ? 'est_value DESC'
        : sort === 'reminders' ? 'reminders_sent DESC'
        : 'last_activity_at DESC';

    const cols = `id, name, company, email, cell, event_name, event_date, event_type, event_location, current_step, furthest_step,
                  consent_given, status, reminders_sent, last_reminder_at, last_activity_at, created_at, converted_booking_id, opt_out, source, est_value`;
    db.get(`SELECT COUNT(*) AS total FROM abandoned_bookings ${whereSql}`, params, (err, countRow) => {
        if (err) return res.status(500).json({ success: false, message: 'DB error' });
        const total = countRow ? countRow.total : 0;
        db.all(`SELECT ${cols} FROM abandoned_bookings ${whereSql} ORDER BY ${orderSql} LIMIT ? OFFSET ?`,
            [...params, limit, offset], (err2, rows) => {
                if (err2) return res.status(500).json({ success: false, message: 'DB error' });
                res.json({ success: true, items: rows || [], total, page, pages: Math.max(1, Math.ceil(total / limit)) });
            });
    });
});

// ---- Admin: recovery statistics (registered before /:id) ----
app.get('/api/admin/abandoned-bookings/stats', requireAdmin, (req, res) => {
    db.all(`SELECT status, COUNT(*) AS c, COALESCE(SUM(est_value),0) AS v FROM abandoned_bookings GROUP BY status`, [], (err, rows) => {
        if (err) return res.status(500).json({ success: false });
        const byStatus = {}; let total = 0, openValue = 0;
        (rows || []).forEach(r => { byStatus[r.status] = { count: r.c, value: r.v }; total += r.c; });
        const recovered = (byStatus.RECOVERED?.count || 0) + (byStatus.WON?.count || 0);
        ['ABANDONED', 'REMINDED'].forEach(s => { if (byStatus[s]) openValue += byStatus[s].value; });
        db.all(`SELECT furthest_step, COUNT(*) AS c FROM abandoned_bookings GROUP BY furthest_step`, [], (e2, frows) => {
            const funnel = { 1: 0, 2: 0, 3: 0, 4: 0 };
            (frows || []).forEach(r => { funnel[r.furthest_step] = r.c; });
            res.json({ success: true, stats: {
                total,
                abandoned: byStatus.ABANDONED?.count || 0,
                reminded: byStatus.REMINDED?.count || 0,
                recovered,
                won: byStatus.WON?.count || 0,
                lost: byStatus.LOST?.count || 0,
                closed: byStatus.CLOSED?.count || 0,
                conversion_rate: total > 0 ? Math.round((recovered / total) * 1000) / 10 : 0,
                est_lost_value: Math.round(openValue * 100) / 100,
                funnel
            }});
        });
    });
});

// ---- Admin: CSV export (registered before /:id) ----
app.get('/api/admin/abandoned-bookings/export', requireAdmin, exportRateLimiter, (req, res) => {
    const cols = ['id', 'name', 'company', 'email', 'cell', 'event_name', 'event_date', 'event_type', 'event_location', 'current_step', 'furthest_step', 'consent_given', 'status', 'reminders_sent', 'last_reminder_at', 'last_activity_at', 'created_at', 'converted_booking_id', 'opt_out', 'source', 'est_value'];
    db.all(`SELECT ${cols.join(', ')} FROM abandoned_bookings ORDER BY last_activity_at DESC`, [], (err, rows) => {
        if (err) return res.status(500).send('Export failed');
        const escapeCsv = (v) => { if (v == null) return ''; const s = String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
        const csv = [cols.join(',')].concat((rows || []).map(r => cols.map(c => escapeCsv(r[c])).join(','))).join('\n');
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="abandoned-bookings-${new Date().toISOString().slice(0, 10)}.csv"`);
        res.send(csv);
    });
});

// ---- Admin: single draft detail ----
app.get('/api/admin/abandoned-bookings/:id', requireAdmin, (req, res) => {
    db.get(`SELECT * FROM abandoned_bookings WHERE id=?`, [req.params.id], (err, row) => {
        if (err || !row) return res.status(404).json({ success: false, message: 'Not found' });
        try { row.services = row.services_json ? JSON.parse(row.services_json) : []; } catch (e) { row.services = []; }
        res.json({ success: true, item: row });
    });
});

// ---- Admin: manually resend a reminder (admin-initiated; respects opt-out) ----
app.post('/api/admin/abandoned-bookings/:id/resend-reminder', requireAdmin, requireRole(['administrator', 'manager']), (req, res) => {
    db.get(`SELECT * FROM abandoned_bookings WHERE id=?`, [req.params.id], async (err, row) => {
        if (err || !row) return res.status(404).json({ success: false, message: 'Not found' });
        if (row.opt_out) return res.status(400).json({ success: false, message: 'This contact has opted out of reminders.' });
        if (!row.email) return res.status(400).json({ success: false, message: 'No email on this draft.' });
        const ok = await sendAbandonedBookingReminderEmail(row);
        if (!ok) return res.status(502).json({ success: false, message: 'Email could not be sent.' });
        db.run(`UPDATE abandoned_bookings SET reminders_sent=reminders_sent+1, last_reminder_at=CURRENT_TIMESTAMP,
                    status=CASE WHEN status='ABANDONED' THEN 'REMINDED' ELSE status END WHERE id=?`,
            [req.params.id], () => res.json({ success: true, message: 'Reminder sent.' }));
    });
});

// ---- Admin: mark as won / lost / closed (or re-open to abandoned) ----
app.put('/api/admin/abandoned-bookings/:id/status', requireAdmin, requireRole(['administrator', 'manager']), (req, res) => {
    const allowed = ['WON', 'LOST', 'CLOSED', 'ABANDONED'];
    const status = (req.body.status || '').toString().toUpperCase();
    if (!allowed.includes(status)) return res.status(400).json({ success: false, message: 'Invalid status.' });
    db.run(`UPDATE abandoned_bookings SET status=? WHERE id=?`, [status, req.params.id], function (err) {
        if (err) return res.status(500).json({ success: false });
        res.json({ success: true, message: 'Status updated.' });
    });
});

function generatePayFastSignature(pfData, passPhrase = null) {
    let pfOutput = '';
    for (let key in pfData) {
        if (pfData.hasOwnProperty(key) && pfData[key] !== '') {
            const val = pfData[key].toString().trim();
            const encoded = encodeURIComponent(val).replace(/%20/g, "+");
            const upperEncoded = encoded.replace(/%[0-9a-fA-F]{2}/g, match => match.toUpperCase());
            pfOutput += `${key}=${upperEncoded}&`;
        }
    }
    let getString = pfOutput.slice(0, -1);
    if (passPhrase && passPhrase.trim() !== '') {
        const encodedPass = encodeURIComponent(passPhrase.trim()).replace(/%20/g, "+");
        const upperPass = encodedPass.replace(/%[0-9a-fA-F]{2}/g, match => match.toUpperCase());
        getString += `&passphrase=${upperPass}`;
    }
    return crypto.createHash("md5").update(getString).digest("hex");
}

// ==========================================
// PayFast Payment Gateway
// ==========================================

// PayFast valid IP ranges for ITN source validation
const PAYFAST_VALID_IPS = process.env.PAYFAST_VALID_IPS
    ? process.env.PAYFAST_VALID_IPS.split(',').map(ip => ip.trim())
    : [
        '197.97.145.144', '197.97.145.145', '197.97.145.146', '197.97.145.147',
        '197.97.145.148', '197.97.145.149', '197.97.145.150', '197.97.145.151',
        '197.97.145.152', '197.97.145.153', '197.97.145.154', '197.97.145.155',
        '197.97.145.156', '197.97.145.157', '197.97.145.158', '197.97.145.159',
        '41.74.179.192', '41.74.179.193', '41.74.179.194', '41.74.179.195',
        '41.74.179.196', '41.74.179.197', '41.74.179.198', '41.74.179.199',
        '41.74.179.200', '41.74.179.201', '41.74.179.202', '41.74.179.203',
        '41.74.179.204', '41.74.179.205', '41.74.179.206', '41.74.179.207',
        '41.74.179.208', '41.74.179.209', '41.74.179.210', '41.74.179.211',
        '41.74.179.212', '41.74.179.213', '41.74.179.214', '41.74.179.215',
        '41.74.179.216', '41.74.179.217', '41.74.179.218', '41.74.179.219',
        '41.74.179.220', '41.74.179.221', '41.74.179.222', '41.74.179.223'
    ];

// S4-4: Rate limiter for PayFast ITN — generous window to allow retries, but caps floods.
// Known PayFast IPs skip the limit entirely; unknown IPs (misconfigured proxies) are throttled.
const payfastItnRateLimiter = rateLimit ? rateLimit({
    windowMs: 60 * 1000, // 1-minute window
    max: 20,             // 20 ITNs/min is more than enough for all PayFast retry patterns
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => {
        const ip = (req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim().replace('::ffff:', '');
        return PAYFAST_VALID_IPS.includes(ip);
    },
    handler: (req, res) => {
        console.warn(`[PayFast ITN] Rate limit hit from IP: ${req.ip}`);
        res.sendStatus(200); // Always 200 to PayFast to prevent retries consuming the limit further
    }
}) : (req, res, next) => next();

// Hardened Payment Initiation Endpoint
app.post('/api/public/bookings/:id/pay', ipRateLimiter, (req, res) => {
    const { payment_type } = req.body; // Expects 'DEPOSIT' or 'FULL'
    console.log(`[DEBUG] POST /api/public/bookings/${req.params.id}/pay - Type: ${payment_type}`);
    
    if (!payment_type || !['DEPOSIT', 'FULL'].includes(payment_type)) {
        return res.status(400).json({ success: false, message: 'Invalid payment type. Must be DEPOSIT or FULL.' });
    }

    db.get("SELECT * FROM bookings WHERE id = ?", [req.params.id], (err, row) => {
        if (err || !row) return res.status(404).json({ success: false, message: 'Booking not found.' });
        
        try {
            // Status gate: only allow payment for ACCEPTED or CONFIRMED bookings
            const status = (row.status || '').toUpperCase();
            if (!['ACCEPTED', 'CONFIRMED'].includes(status)) {
                console.log(`[DEBUG] Pay failed: status is ${status}`);
                return res.status(400).json({ success: false, message: `Payment not available — booking status is ${status}. Quote must be accepted first.` });
            }

            // Duplicate payment guard
            const payStatus = (row.payment_status || 'UNPAID').toUpperCase();
            if (payStatus === 'PAID') {
                console.log(`[DEBUG] Pay failed: already paid`);
                return res.status(400).json({ success: false, message: 'This booking has already been fully paid.' });
            }
            // P2-14: Deposit can only be paid from UNPAID state. DEPOSIT_PAID, PARTIALLY_PAID etc.
            // should proceed to balance/full payment only — not re-pay the deposit.
            if (payment_type === 'DEPOSIT' && payStatus !== 'UNPAID') {
                console.log(`[DEBUG] Pay failed: deposit attempted when payStatus=${payStatus}`);
                return res.status(400).json({ success: false, message: payStatus === 'DEPOSIT_PAID'
                    ? 'A deposit has already been paid. You can only pay the remaining balance.'
                    : `Deposit payment is not available for a booking with status ${payStatus}.` });
            }

            // Server-side amount calculation — query payment_schedules for milestone-aware amounts
            let baseAmt = 0;
            if (row.quote_amount) {
                baseAmt = parseFloat(row.quote_amount.replace(/[^0-9.]/g, ''));
            }
            if (isNaN(baseAmt) || baseAmt <= 0) {
                console.log(`[DEBUG] Pay failed: invalid amount ${row.quote_amount}`);
                return res.status(400).json({ success: false, message: 'Invalid quote amount. Please contact management.' });
            }

            db.all(
                "SELECT description, expected_amount FROM payment_schedules WHERE booking_id = ? AND status != 'paid' AND LOWER(COALESCE(status,'pending')) NOT IN ('superseded','cancelled') ORDER BY due_date ASC",
                [row.id],
                (schedErr, schedules) => {
                try {
                    let amt = baseAmt;
                    let milestoneDesc = 'Full Payment';

                    if (!schedErr && schedules && schedules.length > 0) {
                        if (payment_type === 'DEPOSIT') {
                            amt = parseFloat(schedules[0].expected_amount);
                            milestoneDesc = schedules[0].description;
                        } else if (payStatus === 'DEPOSIT_PAID') {
                            amt = schedules.reduce((sum, s) => sum + parseFloat(s.expected_amount), 0);
                            milestoneDesc = 'Balance Payment';
                        }
                    } else {
                        if (payment_type === 'DEPOSIT') { amt = baseAmt / 2; milestoneDesc = 'Deposit'; }
                        else if (payStatus === 'DEPOSIT_PAID') { amt = baseAmt / 2; milestoneDesc = 'Balance'; }
                    }

                    // Derive the public base URL so PayFast's ITN callback always reaches this server.
                    // Set BASE_URL in .env for production (e.g. https://thabisomhlongo.com).
                    // When tunnelling locally (ngrok / cloudflared) the forwarded host header is used automatically.
                    const proto = req.get('x-forwarded-proto') || req.protocol;
                    const host  = req.get('x-forwarded-host')  || req.get('host');
                    const baseUrl = (process.env.BASE_URL || `${proto}://${host}`).replace(/\/$/, '');

                    const isPortal = req.body.return_path === 'portal';
                    const clientName = row.name || 'Client';

                    const pfData = {
                        merchant_id: process.env.PAYFAST_MERCHANT_ID || '10000100',
                        merchant_key: process.env.PAYFAST_MERCHANT_KEY || '46f0cd694581a',
                        return_url: isPortal ? `${baseUrl}/booking?id=${row.id}&payment=success` : `${baseUrl}/?track=${row.id}&payment=success`,
                        cancel_url: isPortal ? `${baseUrl}/booking?id=${row.id}&payment=cancel`  : `${baseUrl}/?track=${row.id}&payment=cancel`,
                        notify_url: `${baseUrl}/api/payment/webhook/payfast`,
                        name_first: (clientName.split(' ')[0] || '').substring(0, 100),
                        name_last: (clientName.split(' ').slice(1).join(' ') || '').substring(0, 100),
                        email_address: row.email,
                        m_payment_id: `${row.id}_${payment_type}`,
                        amount: amt.toFixed(2),
                        item_name: `Booking ${row.id} - ${row.event_name || row.event_type || 'Event'} - ${milestoneDesc}`.substring(0, 100).replace(/[^a-zA-Z0-9.\- ]/g, '').replace(/\s+/g, ' ')
                    };

                    // Remove empty or null values to ensure signature matches submitted form data
                    Object.keys(pfData).forEach(key => {
                        if (pfData[key] === '' || pfData[key] === null || pfData[key] === undefined) {
                            delete pfData[key];
                        }
                    });

                    const passphrase = process.env.PAYFAST_PASSPHRASE || null;
                    pfData.signature = generatePayFastSignature(pfData, passphrase);

                    const pfHost = process.env.PAYFAST_URL || 'https://sandbox.payfast.co.za/eng/process';

                    console.log(`[PayFast] Payment initiated: Booking #${row.id}, Type: ${payment_type}, Amount: R${amt.toFixed(2)}`);
                    res.json({ success: true, pfData: pfData, pfHost: pfHost });
                } catch (ex) {
                    console.error("Pay Route Error:", ex);
                    res.status(500).json({ success: false, message: 'Internal server error.' });
                }
            });
        } catch (ex) {
            console.error("Pay Route Error:", ex);
            res.status(500).json({ success: false, message: 'Internal server error.' });
        }
    });
});

// ==========================================
// PayFast ITN (Instant Transaction Notification) — SECURE
// ==========================================
app.post('/api/payment/webhook/payfast', payfastItnRateLimiter, async (req, res) => {
    // Step 1: Immediately acknowledge to PayFast
    res.sendStatus(200);
    
    const pfData = req.body;
    if (!pfData || !pfData.m_payment_id) {
        console.error('[PayFast ITN] Empty or malformed ITN received.');
        return;
    }

    console.log(`[PayFast ITN] Received notification for m_payment_id: ${pfData.m_payment_id}`);

    const parts = (pfData.m_payment_id || '').split('_');
    const bookingId = parseInt(parts[0], 10);
    const paymentType = parts[1] || 'FULL';

    if (isNaN(bookingId)) {
        console.error('[PayFast ITN] Invalid bookingId in m_payment_id:', pfData.m_payment_id);
        return;
    }

    try {
        // ── 0. Log & detect environment ──
        logPaymentEvent(bookingId, 'ITN_RECEIVED', pfData, false);
        const isSandbox = (process.env.PAYFAST_URL || '').includes('sandbox');

        // P3-15: Timestamp replay protection — reject ITNs older than 30 minutes in production.
        if (!isSandbox && pfData.timestamp) {
            const itnTime = new Date(pfData.timestamp);
            const ageMins = (Date.now() - itnTime.getTime()) / 60000;
            if (isNaN(itnTime.getTime()) || ageMins > 30) {
                console.error(`[PayFast ITN] STALE TIMESTAMP for booking #${bookingId}: timestamp=${pfData.timestamp}, age=${ageMins.toFixed(1)}m — rejecting as possible replay.`);
                logPaymentEvent(bookingId, 'FAILED_STALE_TIMESTAMP', pfData, false);
                return;
            }
        }

        // ── A. Signature Validation ──
        const passphrase = process.env.PAYFAST_PASSPHRASE || null;
        const receivedSignature = pfData.signature;

        // Reconstruct signature from all params EXCEPT 'signature'
        let sigData = {};
        for (let key in pfData) {
            if (key !== 'signature') sigData[key] = pfData[key];
        }
        const calculatedSignature = generatePayFastSignature(sigData, passphrase);

        if (calculatedSignature !== receivedSignature) {
            console.error(`[PayFast ITN] SIGNATURE MISMATCH booking #${bookingId} — expected: ${calculatedSignature}, received: ${receivedSignature}`);
            logPaymentEvent(bookingId, 'FAILED_SIGNATURE', pfData, false);
            if (!isSandbox) return; // Hard-fail in production only
            // In sandbox: log and continue — passphrase in .env may differ from sandbox account setting
            console.warn(`[PayFast ITN] Sandbox: proceeding despite mismatch. Verify PAYFAST_PASSPHRASE in .env matches your sandbox merchant account.`);
        } else {
            console.log(`[PayFast ITN] ✓ Signature valid for booking #${bookingId}`);
        }

        // ── B. Source IP Validation ──
        // Use req.ip, not the raw X-Forwarded-For header. `app.set('trust proxy', 1)` is configured,
        // so Express resolves req.ip from the trusted proxy hop. Reading X-Forwarded-For directly and
        // taking its leftmost value let a caller spoof an allowlisted PayFast IP with a header, which
        // would defeat this check entirely.
        const sourceIp = (req.ip || req.connection.remoteAddress || '').split(',')[0].trim().replace('::ffff:', '');

        if (!isSandbox && !PAYFAST_VALID_IPS.includes(sourceIp)) {
            console.error(`[PayFast ITN] INVALID SOURCE IP: ${sourceIp}`);
            logPaymentEvent(bookingId, 'FAILED_IP', pfData, true);
            return;
        }
        console.log(`[PayFast ITN] ✓ Source IP valid: ${sourceIp}`);

        // ── B2. Merchant ID Validation ──
        if (String(pfData.merchant_id) !== String(process.env.PAYFAST_MERCHANT_ID)) {
            console.error(`[PayFast ITN] MERCHANT ID MISMATCH booking #${bookingId}: got ${pfData.merchant_id}, expected ${process.env.PAYFAST_MERCHANT_ID}`);
            logPaymentEvent(bookingId, 'FAILED_MERCHANT_ID', pfData, false);
            return;
        }
        console.log(`[PayFast ITN] ✓ Merchant ID valid for booking #${bookingId}`);

        // ── C. Database Lookup ──
        const booking = await new Promise((resolve, reject) => {
            db.get("SELECT * FROM bookings WHERE id = ?", [bookingId], (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });

        if (!booking) {
            console.error(`[PayFast ITN] Booking #${bookingId} NOT FOUND.`);
            return;
        }

        if (booking.payment_status === 'PAID') {
            console.warn(`[PayFast ITN] Booking #${bookingId} already fully PAID. Ignoring duplicate ITN.`);
            logPaymentEvent(bookingId, 'IGNORED_DUPLICATE', pfData, true);
            return;
        }

        // ── D. PayFast Server Confirmation (POST BACK) ──
        const pfValidateHost = isSandbox
            ? 'https://sandbox.payfast.co.za/eng/query/validate'
            : 'https://www.payfast.co.za/eng/query/validate';
            
        // Include BOTH payload AND signature for validation POST per PayFast requirements
        let validateParams = [];
        for (let key in pfData) {
            validateParams.push(`${key}=${encodeURIComponent(pfData[key]).replace(/%20/g, '+')}`);
        }
        const validateBody = validateParams.join('&');
        
        let pfServerValid = false;
        try {
            const https = require('https');
            const urlModule = require('url');
            const parsedUrl = urlModule.parse(pfValidateHost);
            
            pfServerValid = await new Promise((resolve) => {
                const options = {
                    hostname: parsedUrl.hostname, port: 443, path: parsedUrl.path, method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(validateBody), 'connection': 'close' },
                    rejectUnauthorized: !isSandbox,
                    timeout: 8000
                };
                const request = https.request(options, (response) => {
                    let data = '';
                    response.on('data', (chunk) => data += chunk);
                    response.on('end', () => resolve(data.trim() === 'VALID'));
                });
                request.on('timeout', () => { request.destroy(); resolve(false); });
                request.on('error', () => resolve(false));
                request.write(validateBody);
                request.end();
            });
        } catch (serverErr) {
            console.error('[PayFast ITN] Server confirmation error:', serverErr.message);
        }

        if (!pfServerValid && !isSandbox) {
            console.error(`[PayFast ITN] SERVER CONFIRMATION FAILED for booking #${bookingId}`);
            logPaymentEvent(bookingId, 'FAILED_API_VALIDATION', pfData, true);
            return;
        }

        // Idempotency guard: check BEFORE inserting the transaction record.
        // In production, require pf_payment_id — synthetic keys based on amount+status can collide
        // on PayFast retries with rounding differences, creating duplicate transactions.
        if (!pfData.pf_payment_id && !isSandbox) {
            console.error(`[PayFast ITN] Missing pf_payment_id for booking #${bookingId} in production — rejecting to prevent synthetic-key dedup collision.`);
            logPaymentEvent(bookingId, 'FAILED_NO_PAYMENT_ID', pfData, false);
            return; // res already sent with 200 at top; return stops processing
        }
        const itnRef = pfData.pf_payment_id || `synthetic-${bookingId}-${pfData.amount_gross}-${pfData.payment_status}`;
        const alreadyProcessed = await new Promise(resolve => {
            db.get("SELECT id FROM transactions WHERE reference = ? AND booking_id = ? AND source = 'payfast'",
                [itnRef, bookingId], (e, row) => resolve(!!row));
        });
        if (alreadyProcessed) {
            console.warn(`[PayFast ITN] Duplicate ITN ignored for ref=${itnRef} booking #${bookingId}`);
            logPaymentEvent(bookingId, 'IGNORED_DUPLICATE', pfData, true);
            return;
        }

        // ══════════════════════════════════════════
        // Ledger Execution Engine
        // ══════════════════════════════════════════
        if (pfData.payment_status === 'COMPLETE') {
            const itnAmount = parseFloat(pfData.amount_gross) || 0;
            const currentTotal = parseFloat(booking.total_amount) || parseFloat((booking.quote_amount||'0').replace(/[^0-9.]/g, '')) || 0;
            // P2-13: If we still can't resolve a total, reject the ITN — overpayment guard cannot function without it.
            if (currentTotal === 0) {
                console.error(`[PayFast ITN] REJECTED: booking #${bookingId} has no resolvable total_amount. Cannot apply payment safely.`);
                logPaymentEvent(bookingId, 'FAILED_NO_TOTAL', pfData, true);
                getNotificationEmail().then(notifEmail => {
                    if (!notifEmail) return;
                    // PAYMENT-GATEWAY (HIGH): `R${itnAmount.toFixed(2)}` and the booking ID kept verbatim.
                    sendEmail({
                        to: notifEmail,
                        subject: `PayFast ITN Rejected – Missing Total – Booking #${bookingId}`,
                        htmlContent: emailComponents.renderSystemEmail({
                            preheaderText: `PayFast ITN for booking #${bookingId} rejected — no total_amount set.`,
                            category: 'Payments & Invoices',
                            severity: 'alert',
                            leadFact: `A PayFast ITN for booking <strong style="color:#FAFAFA;">#${bookingId}</strong> (R${itnAmount.toFixed(2)}) was <strong style="color:#E8A83E;">rejected</strong> because the booking has no total_amount set.`,
                            bodyHtml: `<p style="margin:0; color:#E6E6E6;">Set the booking total and replay the transaction manually.</p>`
                        }),
                        preWrapped: true,
                        titleOverride: 'ITN Rejected – Missing Total',
                        trigger_event: 'Admin: ITN No Total'
                    });
                }).catch(e => console.error('[ITN] Admin alert failed:', e.message));
                return;
            }

            const rawMethod = (pfData.payment_method || '').toLowerCase();
            const PF_METHOD_MAP = { cc: 'credit_card', dc: 'credit_card', ef: 'bank_transfer', mp: 'payfast',
                bc: 'payfast', payfast: 'payfast', mc: 'payfast', sc: 'payfast', cd: 'payfast', mt: 'payfast',
                cf: 'payfast', zp: 'payfast', rp: 'payfast' };
            const mappedMethod = PF_METHOD_MAP[rawMethod] || 'payfast';

            // The transactions row, the ledger credit and the invoice→PAID sync are ONE atomic unit.
            //
            // Idempotency is enforced by the DB, not by the check-then-act SELECT above. transactions
            // .pf_payment_id is UNIQUE and was never populated on this path, so a replayed or
            // concurrent duplicate ITN could pass the pre-check and credit twice. We now write
            // pf_payment_id inside the transaction; a duplicate ITN fails the UNIQUE constraint and
            // the whole credit rolls back. Legacy/manual rows have NULL pf_payment_id, and SQLite
            // permits many NULLs in a UNIQUE column, so no backfill is needed.
            //
            // F4: the credit is a single atomic UPDATE — increment, outstanding/status derivation and
            // the overpayment guard (WHERE new_total <= total + R1) in one statement. Column refs read
            // the pre-update row, so (amount_paid + ?) is the post-credit total across every clause.
            const outcome = await withDbTransaction(async () => {
                try {
                    await dbRun("BEGIN IMMEDIATE");
                } catch (beginErr) {
                    console.error(`[PayFast ITN] BEGIN IMMEDIATE failed for booking #${bookingId}:`, beginErr.message);
                    return { retry: true };
                }
                try {
                    await dbRun(
                        `INSERT INTO transactions (booking_id, amount, transaction_type, payment_method, reference,
                             transaction_date, status, source, pf_payment_id, pf_status, pf_signature, is_verified)
                         VALUES (?, ?, 'payment', ?, ?, CURRENT_TIMESTAMP, 'completed', 'payfast', ?, ?, ?, 1)`,
                        [bookingId, itnAmount, mappedMethod, itnRef, pfData.pf_payment_id || null, pfData.payment_status, receivedSignature]);

                    const credit = await dbRun(
                        `UPDATE bookings SET
                            amount_paid = COALESCE(amount_paid,0) + ?,
                            total_amount = ?,
                            amount_outstanding = MAX(0, ? - (COALESCE(amount_paid,0) + ?)),
                            payment_status = CASE
                                WHEN (COALESCE(amount_paid,0) + ?) >= ? THEN 'PAID'
                                WHEN ? = 'DEPOSIT' THEN 'DEPOSIT_PAID'
                                ELSE 'PARTIALLY_PAID' END,
                            status = CASE WHEN status IN ('ACCEPTED','CONFIRMED') THEN 'CONFIRMED' ELSE status END,
                            payment_reference = ?, payment_signature = ?, payment_raw_data = ?, payment_method = ?,
                            confirmed_at = CURRENT_TIMESTAMP, last_payment_date = CURRENT_TIMESTAMP, payment_date = CURRENT_TIMESTAMP
                        WHERE id = ? AND (COALESCE(amount_paid,0) + ?) <= ? + 1.0`,
                        [
                            itnAmount, currentTotal, currentTotal, itnAmount, itnAmount, currentTotal, paymentType,
                            pfData.pf_payment_id || null, receivedSignature, JSON.stringify(pfData), pfData.payment_method || 'payfast',
                            bookingId, itnAmount, currentTotal
                        ]);
                    if (credit.changes === 0) {
                        await dbRun("ROLLBACK").catch(() => {}); // overpayment guard blocked it — undo the tx insert too
                        return { overpayment: true };
                    }

                    const fresh = await dbGet("SELECT * FROM bookings WHERE id = ?", [bookingId]);
                    if (fresh && fresh.payment_status === 'PAID') {
                        await dbRun(`UPDATE invoices SET status='PAID', updated_at=CURRENT_TIMESTAMP WHERE booking_id=? AND UPPER(status) NOT IN ('VOID','PAID')`, [bookingId]);
                    }

                    await dbRun("COMMIT");
                    return { ok: true, fresh };
                } catch (txErr) {
                    await dbRun("ROLLBACK").catch(() => {});
                    if (/UNIQUE constraint/i.test(txErr.message || '')) return { duplicate: true };
                    return { error: txErr };
                }
            });

            // res.sendStatus(200) was already sent (correct for PayFast), so nothing can be returned to
            // the caller — every outcome is logged and, where it matters, an admin is alerted.
            if (outcome.retry) { logPaymentEvent(bookingId, 'DEFERRED_DB_BUSY', pfData, true); return; }
            if (outcome.duplicate) {
                console.warn(`[PayFast ITN] Duplicate pf_payment_id for booking #${bookingId} — rejected by UNIQUE constraint.`);
                logPaymentEvent(bookingId, 'IGNORED_DUPLICATE', pfData, true, itnRef, { auditOnly: true });
                return;
            }
            if (outcome.error) {
                console.error(`[PayFast ITN] Credit transaction failed for booking #${bookingId}:`, outcome.error.message);
                logPaymentEvent(bookingId, 'CRITICAL_ERROR', pfData, false);
                // PAYMENT-GATEWAY (HIGH): `R${itnAmount.toFixed(2)}`, booking ID and the error message
                // (outcome.error.message) are kept verbatim.
                getNotificationEmail().then(notifEmail => notifEmail && sendEmail({ to: notifEmail,
                    subject: `PayFast ITN Failed – Booking #${bookingId}`,
                    htmlContent: emailComponents.renderSystemEmail({
                        preheaderText: `PayFast payment for booking #${bookingId} could not be recorded.`,
                        category: 'Payments & Invoices',
                        severity: 'alert',
                        leadFact: `A verified PayFast payment for booking <strong style="color:#FAFAFA;">#${bookingId}</strong> (R${itnAmount.toFixed(2)}) could not be recorded: ${outcome.error.message}.`,
                        bodyHtml: `<p style="margin:0; color:#E6E6E6;">The booking ledger is unchanged. Replay manually.</p>`
                    }),
                    preWrapped: true,
                    titleOverride: 'ITN Processing Failed', trigger_event: 'Admin: ITN Failure' })).catch(() => {});
                return;
            }
            if (outcome.overpayment) {
                console.warn(`[PayFast ITN] OVERPAYMENT REJECTED for booking #${bookingId} (atomic guard). Total: ${currentTotal}, ITN amount: ${itnAmount}`);
                logPaymentEvent(bookingId, 'OVERPAYMENT_REJECTED', pfData, true);
                // PAYMENT-GATEWAY (HIGH): both `R${amount}` figures and the booking ID kept verbatim.
                getNotificationEmail().then(notifEmail => {
                    sendEmail({ to: notifEmail,
                        subject: `Overpayment Detected – Booking #${bookingId}`,
                        htmlContent: emailComponents.renderSystemEmail({
                            preheaderText: `Overpayment detected for booking #${bookingId} — credit NOT applied.`,
                            category: 'Payments & Invoices',
                            severity: 'alert',
                            leadFact: `PayFast sent <strong style="color:#FAFAFA;">R${itnAmount.toFixed(2)}</strong> for booking <strong style="color:#FAFAFA;">#${bookingId}</strong> but crediting it would exceed the R${currentTotal.toFixed(2)} booking total.`,
                            bodyHtml: `<p style="margin:0; color:#E6E6E6;">Credit was <strong style="color:#E8A83E;">NOT applied</strong>. Manual review required.</p>`
                        }),
                        preWrapped: true,
                        titleOverride: 'Overpayment Alert', trigger_event: 'Admin: Overpayment Alert' });
                }).catch((emailErr) => {
                    console.error(`[PayFast ITN] CRITICAL: Overpayment admin notification failed for booking #${bookingId}:`, emailErr.message);
                });
                return;
            }

            // ── Committed. The transactions row exists; log the payment_logs audit entries only. ──
            logPaymentEvent(bookingId, 'VERIFIED_OK', pfData, true, itnRef, { auditOnly: true });
            const updatedRow = outcome.fresh;
            const newAmountPaid = parseFloat(updatedRow.amount_paid) || 0;
            const newOutstanding = parseFloat(updatedRow.amount_outstanding) || 0;
            const newPaymentStatus = updatedRow.payment_status;

            console.log(`[PayFast ITN] ✅ Booking #${bookingId} Ledger Updated: Paid=R${newAmountPaid.toFixed(2)}, Remaining=R${newOutstanding.toFixed(2)}, Status=${newPaymentStatus}`);
            logPaymentEvent(bookingId, 'LEDGER_UPDATED_COMPLETE', pfData, true, itnRef, { auditOnly: true });

            // ── Side effects, all after the commit. None may re-enter the transaction queue. ──
            await syncBookingToCalendar(updatedRow).catch(e => console.error('[PayFast ITN] Calendar sync failed:', e.message));
            await sendPaymentReceivedEmail(updatedRow, newAmountPaid, newOutstanding, newPaymentStatus).catch(e => console.error('Payment-received email failed:', e.message));
            sendAdminPaymentNotification(updatedRow, newAmountPaid, newPaymentStatus)
                .catch(e => console.error('Admin payment notification failed:', e.message));
            if (newPaymentStatus === 'DEPOSIT_PAID' && newOutstanding > 0) {
                sendDepositBalanceDueEmail(updatedRow, newOutstanding).catch(e => console.error('Deposit balance-due email failed:', e.message));
            }
            if (newPaymentStatus === 'PAID') {
                sendBookingConfirmedEmail(updatedRow).catch(e => console.error('Confirmed email after payment failed:', e.message));
                // Invoice was set PAID inside the transaction; just send the receipt.
                sendPaidReceiptEmail(updatedRow).catch(e => console.error('Paid receipt email (ITN) failed:', e.message));
            }
            // Auto-create the events row whenever the payment CONFIRMED the booking — deposit or full.
            // This used to be gated on newPaymentStatus === 'PAID', so a PayFast deposit that confirmed
            // the booking got no events row, while the identical deposit recorded via the manual-payment
            // route (processManualPayment) and an admin status-change (applyStatusChange) both do create
            // one. Gating on the resulting CONFIRMED status makes all three paths consistent.
            // created_by is NULL, not 'system': events.created_by is an INTEGER FK to admins(id), so the
            // string 'system' failed the FK constraint every time — which is why this auto-create had
            // NEVER produced a row on any of the three paths. NULL is the system-created marker (existing
            // rows already use it) and is what admins(id) FK allows for an event no admin authored.
            if (updatedRow.status === 'CONFIRMED' && !updatedRow.event_id) {
                const evDatetime = updatedRow.date + (updatedRow.event_start_time ? ' ' + updatedRow.event_start_time : ' 00:00:00');
                db.run(
                    `INSERT INTO events (event_title, event_datetime, venue_name, venue_id, booking_id, event_status, created_by)
                     VALUES (?, ?, ?, ?, ?, 'upcoming', NULL)`,
                    [updatedRow.event_name || updatedRow.event_type || 'Booking Event', evDatetime,
                     updatedRow.event_location || null, updatedRow.venue_id || null, bookingId],
                    function(evErr) {
                        if (evErr) { console.error('[Auto-Event] PayFast: Insert failed for booking #' + bookingId + ':', evErr.message); return; }
                        db.run("UPDATE bookings SET event_id = ? WHERE id = ?", [this.lastID, bookingId]);
                    }
                );
            }
            // Mark payment schedule items as paid based on total amount now credited
            alignMilestonePayments(bookingId, newAmountPaid, (psErr) => {
                if (psErr) console.error(`[Payment Schedules] Update failed for booking #${bookingId}:`, psErr.message);
            });
        } else {
            console.warn(`[PayFast ITN] Payment status is "${pfData.payment_status}" (not COMPLETE) for booking #${bookingId}`);
            logPaymentEvent(bookingId, `STATUS_${pfData.payment_status.toUpperCase()}`, pfData, true);
            // CANCELLED: customer aborted — keep UNPAID (retryable); do not mark as FAILED
            // FAILED/other: set FAILED on UNPAID bookings; preserve DEPOSIT_PAID for balance-payment failures
            if (pfData.payment_status === 'CANCELLED') {
                console.log(`[PayFast ITN] Booking #${bookingId} payment cancelled by customer. Status unchanged (retryable).`);
            } else {
                db.run("UPDATE bookings SET payment_status = 'FAILED' WHERE id = ? AND payment_status = 'UNPAID'", [bookingId]);
            }
            db.get("SELECT * FROM bookings WHERE id = ?", [bookingId], (e, failedRow) => {
                if (!e && failedRow) {
                    if (pfData.payment_status !== 'CANCELLED') {
                        sendPaymentFailedEmail(failedRow).catch(e => console.error('Payment-failed email error:', e.message));
                    }
                    // C6: If a balance payment failed on a partially-paid booking, explicitly alert admin.
                    // PAYMENT-GATEWAY (HIGH): client name, booking ID and pfData.payment_status verbatim.
                    if (failedRow.payment_status === 'DEPOSIT_PAID') {
                        getNotificationEmail().then(notifEmail => sendEmail({
                            to: notifEmail,
                            subject: `⚠️ Balance Payment Failed – Booking #${bookingId}`,
                            htmlContent: emailComponents.renderSystemEmail({
                                preheaderText: `Balance payment failed for booking #${bookingId} — deposit remains on record.`,
                                category: 'Payments & Invoices',
                                severity: 'alert',
                                leadFact: `A balance payment attempt by <strong style="color:#FAFAFA;">${failedRow.name || failedRow.client_name}</strong> for Booking <strong style="color:#FAFAFA;">#${bookingId}</strong> has failed.`,
                                bodyHtml: `<p style="margin:0; color:#E6E6E6;">The booking still has a deposit on record. Payment status remains <strong style="color:#D4AF37;">DEPOSIT_PAID</strong>. Please follow up with the client.</p>`,
                                cards: [{ rows: [{ label: 'PayFast Status', value: pfData.payment_status, highlight: true }] }]
                            }),
                            preWrapped: true,
                            titleOverride: 'Balance Payment Failed',
                            trigger_event: 'Admin: Balance Payment Failed'
                        })).catch(err => console.error('Admin balance-failed email error:', err.message));
                    }
                }
            });
        }

    } catch (itnError) {
        console.error(`[PayFast ITN] Unhandled error processing ITN for booking #${bookingId}:`, itnError);
        logPaymentEvent(bookingId, `CRITICAL_ERROR`, pfData, false);
    }
});

// Helper for comprehensive audit logging into the payment_logs table.
// opts.auditOnly: write only the payment_logs row, not the transactions row. The PayFast ITN path
// inserts its transactions row itself, inside a transaction and with pf_payment_id set, so it passes
// auditOnly for its VERIFIED_OK audit entry to avoid a second, un-deduped transactions insert.
function logPaymentEvent(bookingId, eventType, pfData, sigValid = true, referenceOverride = null, opts = {}) {
    const amount = parseFloat(pfData.amount_gross) || 0;

    // 1. Log to generic payment_logs for ITN history
    db.run(
        `INSERT INTO payment_logs (booking_id, event_type, raw_payload, signature_valid, amount) VALUES (?, ?, ?, ?, ?)`,
        [bookingId, eventType, JSON.stringify(pfData), sigValid, amount],
        (err) => {
            if (err) console.error(`[Audit Log] Failed to insert log for booking #${bookingId}:`, err.message);
        }
    );

    // 2. If it's a successful verified payment, also log to the official transactions table
    if (!opts.auditOnly && (eventType === 'VERIFIED_OK' || eventType === 'MANUAL_PAYMENT_RECORDED')) {
        const pfMethodMap = {
            cc: 'credit_card', dc: 'credit_card',          // Visa/MC credit & debit
            ef: 'bank_transfer',                            // Instant EFT
            mp: 'payfast', bc: 'payfast', payfast: 'payfast', // Masterpass / Bitcoin (legacy)
            mc: 'payfast',   // MoreTyme credit
            sc: 'payfast',   // Scan to Pay
            cd: 'payfast',   // Capitec Pay
            mt: 'payfast',   // MobiCred
            cf: 'payfast',   // Payflex / PayJustNow
            zp: 'payfast',   // Zero Pay
            rp: 'payfast',   // RCS Pay
            cash: 'cash', check: 'check', bank_transfer: 'bank_transfer', manual: 'cash'
        };
        const rawMethod = (pfData.payment_method || '').toLowerCase();
        const mappedMethod = pfMethodMap[rawMethod] || 'payfast'; // default to gateway name, not 'other'
        const txSource = eventType === 'VERIFIED_OK' ? 'payfast' : 'manual';
        const txReference = referenceOverride || pfData.pf_payment_id || pfData.m_payment_id || 'manual';
        db.run(`INSERT INTO transactions (booking_id, amount, transaction_type, payment_method, reference, transaction_date, status, source)
                VALUES (?, ?, 'payment', ?, ?, CURRENT_TIMESTAMP, 'completed', ?)`,
            [bookingId, amount, mappedMethod, txReference, txSource],
            (err) => { if (err) console.error(`[Transactions] Insert failed for booking #${bookingId}:`, err.message); });
    }
}

// Helpers for payment schedules & milestones alignment
// Greedy waterfall: walk the booking's LIVE milestones in due order and mark each one the running
// payment total fully covers as 'paid'.
//
// Only live rows participate. This used to `SELECT *` — superseded and cancelled rows included — and
// rewrite every row's status, so any payment after an admin re-quote resurrected the superseded
// milestones and let them consume the paid budget. It also demoted 'overdue' rows to 'pending' on
// every call, silently undoing the overdue cron.
//
// Deliberately NOT wrapped in withDbTransaction: every caller runs this inside a post-commit
// side-effect block that issues further independent statements on the shared sqlite connection, and a
// BEGIN here would sweep those into this transaction. The two set-based UPDATEs below are each atomic
// on their own, and a partial failure is re-derived by the next align or cron run.
function alignMilestonePayments(bookingId, amountPaid, callback) {
    db.all(
        `SELECT id, expected_amount, status FROM payment_schedules
         WHERE booking_id = ? AND LOWER(COALESCE(status,'pending')) NOT IN ('superseded','cancelled')
         ORDER BY due_date ASC, id ASC`,
        [bookingId],
        (err, schedules) => {
            if (err || !schedules || schedules.length === 0) {
                if (callback) callback(err);
                return;
            }

            let remainingPaid = parseFloat(amountPaid) || 0;
            const toPaid = [];    // covered, not yet marked paid
            const toPending = []; // previously paid, no longer covered (a refund) — the cron re-flags overdue

            for (const s of schedules) {
                const expected = parseFloat(s.expected_amount) || 0;
                const current = String(s.status || 'pending').toLowerCase();
                if (remainingPaid + 0.009 >= expected) {
                    remainingPaid -= expected;
                    if (current !== 'paid') toPaid.push(s.id);
                } else {
                    remainingPaid = 0; // the first milestone we cannot fully cover stops the waterfall
                    // Leave pending/due_soon/overdue alone — only a previously-paid row is demoted.
                    if (current === 'paid') toPending.push(s.id);
                }
            }

            if (toPaid.length === 0 && toPending.length === 0) {
                if (callback) callback(null);
                return;
            }

            // ids come from the SELECT above, never from user input.
            const runPaid = (next) => {
                if (toPaid.length === 0) return next(null);
                db.run(`UPDATE payment_schedules SET status = 'paid', updated_at = CURRENT_TIMESTAMP
                        WHERE id IN (${toPaid.map(() => '?').join(',')})
                          AND LOWER(COALESCE(status,'pending')) <> 'paid'`, toPaid, next);
            };
            const runPending = (next) => {
                if (toPending.length === 0) return next(null);
                db.run(`UPDATE payment_schedules SET status = 'pending', updated_at = CURRENT_TIMESTAMP
                        WHERE id IN (${toPending.map(() => '?').join(',')})
                          AND LOWER(COALESCE(status,'pending')) = 'paid'`, toPending, next);
            };
            runPaid((e1) => runPending((e2) => { if (callback) callback(e1 || e2); }));
        }
    );
}

function updateBookingMilestones(bookingId, callback) {
    db.get(`SELECT amount_paid FROM bookings WHERE id = ?`, [bookingId], (err, row) => {
        if (err || !row) {
            if (callback) callback(err);
            return;
        }
        const paid = parseFloat(row.amount_paid) || 0;
        alignMilestonePayments(bookingId, paid, callback);
    });
}

// ==========================================
// Payment Return Pages (cosmetic — ITN is the real confirmation)
// ==========================================
// Fetch ITN Audit Logs for Admin
app.get('/api/bookings/:id/payment-logs', (req, res) => {
    if (!req.session || !req.session.admin) {
        return res.status(401).json({ success: false, message: 'Unauthorized' });
    }
    db.all("SELECT * FROM payment_logs WHERE booking_id = ? ORDER BY timestamp DESC", [req.params.id], (err, rows) => {
        if (err) return res.status(500).json({ success: false, message: 'Database error fetching logs' });
        res.json({ success: true, logs: rows });
    });
});

// Admin: manually record a payment when the PayFast ITN was not received
app.put('/api/admin/bookings/:id/manual-payment', requireAdmin, requireRole(['administrator', 'manager']), async (req, res) => {
    const { payment_status, amount_paid, force } = req.body;
    // payment_status is advisory now — processManualPayment derives the real value from the amount
    // (an admin could otherwise record R1 as PAID). Still reject a garbage value if one is supplied,
    // but do not require it.
    const valid = ['UNPAID', 'DEPOSIT_PAID', 'PARTIALLY_PAID', 'PAID', 'FAILED'];
    if (payment_status != null && payment_status !== '' && !valid.includes(payment_status)) {
        return res.status(400).json({ success: false, message: 'Invalid payment_status.' });
    }
    db.get("SELECT * FROM bookings WHERE id = ?", [req.params.id], (err, row) => {
        if (err || !row) return res.status(404).json({ success: false, message: 'Booking not found.' });
        if (['CANCELLED', 'EXPIRED'].includes(row.status)) {
            return res.status(400).json({ success: false, message: `Cannot record payment on a ${row.status} booking.` });
        }

        // P2-5: Warn if a PayFast transaction was recorded for this booking within the last 2 hours —
        // recording a manual payment on top may create a duplicate credit.
        if (!force) {
            db.get(
                `SELECT id, amount, created_at FROM transactions
                 WHERE booking_id = ? AND source = 'payfast' AND status = 'completed'
                   AND created_at >= datetime('now', '-2 hours')
                 ORDER BY created_at DESC LIMIT 1`,
                [req.params.id],
                (txErr, recentTx) => {
                    if (!txErr && recentTx) {
                        return res.status(409).json({
                            success: false,
                            duplicate_warning: true,
                            message: `A PayFast payment of R${parseFloat(recentTx.amount).toFixed(2)} was already recorded for this booking within the last 2 hours (at ${recentTx.created_at}). Recording a manual payment now may double-credit this booking. Send { force: true } to proceed anyway.`
                        });
                    }
                    // No recent PayFast tx — fall through to same-callback logic below
                    processManualPayment(req, res, row);
                }
            );
            return;
        }
        processManualPayment(req, res, row);
    });
});

// The single rule for how a recorded payment moves bookings.status. Owner decision (2026-07-10):
// a deposit confirms. Any real payment on a booking the client has committed to (ACCEPTED or
// CONFIRMED) moves it to CONFIRMED; a full payment on a booking that never got a formal acceptance
// advances it to ACCEPTED so the acceptance step isn't skipped; anything else leaves status alone.
//
// The PayFast ITN encodes the same rule as a race-free SQL CASE and is deliberately NOT routed
// through this helper — reading the status into JS first would reintroduce a read-then-write window.
// Keep the two in sync by meaning, not by shared code.
function deriveBookingStatusAfterPayment(currentStatus, paymentStatus) {
    const cur = String(currentStatus || '').toUpperCase();
    const pay = String(paymentStatus || '').toUpperCase();
    const isRealPayment = ['DEPOSIT_PAID', 'PARTIALLY_PAID', 'PAID'].includes(pay);
    if (isRealPayment && ['ACCEPTED', 'CONFIRMED'].includes(cur)) return 'CONFIRMED';
    if (pay === 'PAID') return 'ACCEPTED';
    return currentStatus;
}

function processManualPayment(req, res, row) {
    const { amount_paid } = req.body;

        const total = parseFloat(row.total_amount) ||
                      parseFloat((row.quote_amount || '0').replace(/[^0-9.]/g, '')) || 0;
        const paid  = Math.max(0, parseFloat(amount_paid) || 0);
        if (total > 0 && paid > total) {
            return res.status(400).json({ success: false, message: `Overpayment detected. Total is R${total.toFixed(2)} but you entered R${paid.toFixed(2)}.`, overpayment: true, max_amount: total });
        }
        const existingPaid = parseFloat(row.amount_paid) || 0;
        const delta = paid - existingPaid;
        if (paid < existingPaid) {
            // P2-4: Reducing amount_paid without a refund record creates ledger drift.
            // Force the admin to use the dedicated refund endpoint instead.
            return res.status(400).json({
                success: false,
                message: `Cannot reduce the recorded payment from R${existingPaid.toFixed(2)} to R${paid.toFixed(2)} via this form. Use the Refund endpoint to record a refund and update the ledger — this creates a proper audit trail and transaction record.`
            });
        }
        const outstanding = Math.max(0, total - paid);
        // Derive payment_status from the amount rather than trusting the request body. The body field
        // is now advisory — an admin could otherwise record R1 as 'PAID'. Same thresholds as
        // /transactions/manual: >= total → PAID, >= half → DEPOSIT_PAID, > 0 → PARTIALLY_PAID.
        let payment_status;
        if (total > 0 && paid >= total)        payment_status = 'PAID';
        else if (total > 0 && paid >= total * 0.5) payment_status = 'DEPOSIT_PAID';
        else if (paid > 0)                     payment_status = 'PARTIALLY_PAID';
        else                                   payment_status = 'UNPAID';

        const newStatus = deriveBookingStatusAfterPayment(row.status, payment_status);

        db.run(
            `UPDATE bookings SET
                payment_status = ?, amount_paid = ?, amount_outstanding = ?,
                total_amount = CASE WHEN COALESCE(total_amount, 0) = 0 THEN ? ELSE total_amount END,
                status = ?,
                last_payment_date = CURRENT_TIMESTAMP, payment_date = CURRENT_TIMESTAMP,
                confirmed_at = CASE WHEN ? = 'PAID' AND confirmed_at IS NULL THEN CURRENT_TIMESTAMP ELSE confirmed_at END
             WHERE id = ?`,
            [payment_status, paid, outstanding, total, newStatus, payment_status, req.params.id],
            function(err) {
                if (err) return res.status(500).json({ success: false, error: err.message });
                
                // Record in transactions table + audit log
                if (delta > 0) {
                    logPaymentEvent(req.params.id, 'MANUAL_PAYMENT_RECORDED', {
                        amount_gross: delta,
                        payment_method: 'manual',
                        pf_payment_id: null,
                        m_payment_id: `MANUAL-${req.params.id}-${Date.now()}`
                    }, true);
                } else if (delta < 0) {
                    logPaymentEvent(req.params.id, 'MANUAL_PAYMENT_REDUCED', {
                        amount_gross: Math.abs(delta),
                        old_amount: existingPaid,
                        payment_method: 'manual',
                        m_payment_id: `MANUAL-REDUCE-${req.params.id}-${Date.now()}`
                    }, true);
                }
                db.run(`INSERT INTO audit_log (table_name, record_id, action, new_values, changed_by, change_timestamp)
                        VALUES ('bookings', ?, 'PAYMENT', ?, ?, CURRENT_TIMESTAMP)`,
                    [req.params.id, JSON.stringify({ amount_paid: paid, payment_status, amount_outstanding: outstanding }), req.session.adminId || 'admin'],
                    (aErr) => { if (aErr) console.error('[Audit] Manual payment log failed:', aErr.message); });

                // Auto-create events row when manual payment results in CONFIRMED (mirrors PayFast ITN behaviour)
                if (newStatus === 'CONFIRMED') {
                    db.get("SELECT event_id, date, event_start_time, event_name, event_type, event_location, venue_id FROM bookings WHERE id = ?", [req.params.id], (evSelErr, bRow) => {
                        if (evSelErr || !bRow || bRow.event_id) return;
                        const evDatetime = bRow.date + (bRow.event_start_time ? ' ' + bRow.event_start_time : ' 00:00:00');
                        db.run(
                            `INSERT INTO events (event_title, event_datetime, venue_name, venue_id, booking_id, event_status, created_by)
                             VALUES (?, ?, ?, ?, ?, 'upcoming', NULL)`,
                            [bRow.event_name || bRow.event_type || 'Booking Event', evDatetime, bRow.event_location || null, bRow.venue_id || null, req.params.id],
                            function(evErr) {
                                if (evErr) { console.error('[Auto-Event] ManualPayment: Insert failed for booking #' + req.params.id + ':', evErr.message); return; }
                                db.run("UPDATE bookings SET event_id = ? WHERE id = ?", [this.lastID, req.params.id]);
                            }
                        );
                    });
                }

                (async () => {
                    await syncBookingToCalendar(req.params.id);
                    sendPaymentReceivedEmail(row, paid, outstanding, payment_status).catch(e => console.error('Manual payment email failed:', e));
                    sendAdminPaymentNotification(row, paid, payment_status).catch(e => console.error('Admin payment notification failed:', e.message));
                    // Update payment schedule: mark due items as paid
                    alignMilestonePayments(req.params.id, paid, (psErr) => {
                        if (psErr) console.error('[Payment] payment_schedules update failed:', psErr.message);
                    });
                    if (payment_status === 'DEPOSIT_PAID' && outstanding > 0) {
                        sendDepositBalanceDueEmail(row, outstanding).catch(e => console.error('Deposit balance-due email failed:', e.message));
                    }
                    if (payment_status === 'PAID') {
                        const markPaidAndNotify = () => {
                            db.run("UPDATE invoices SET status='PAID', updated_at=CURRENT_TIMESTAMP WHERE booking_id=? AND UPPER(status) NOT IN ('VOID','PAID')", [req.params.id]);
                            db.get("SELECT * FROM bookings WHERE id = ?", [req.params.id], (e, updated) => {
                                if (!e && updated) {
                                    sendBookingConfirmedEmail(updated).catch(e => console.error('Confirmed email after manual payment failed:', e.message));
                                    setTimeout(() => sendPaidReceiptEmail(updated).catch(e => console.error('Paid receipt email (manual) failed:', e.message)), 600);
                                }
                            });
                        };
                        // Ensure an invoice exists before sending the receipt — manual bookings that
                        // skipped quote acceptance have no invoice yet, so generate one on the spot.
                        db.get(
                            "SELECT id FROM invoices WHERE booking_id = ? AND UPPER(status) NOT IN ('VOID') ORDER BY id DESC LIMIT 1",
                            [req.params.id],
                            (invCheckErr, existingInv) => {
                                if (!existingInv) {
                                    generateInvoice(req.params.id)
                                        .then(markPaidAndNotify)
                                        .catch(genErr => {
                                            console.error('[ManualPayment] Invoice auto-generation failed:', genErr.message);
                                            markPaidAndNotify();
                                        });
                                } else {
                                    markPaidAndNotify();
                                }
                            }
                        );
                    }
                })();

                res.json({ success: true, message: `Payment recorded for booking #${req.params.id}.` });
            }
        );
}

app.get('/payment/success', (req, res) => {
    const bookingId = req.query.booking_id || '';
    res.send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Payment Successful | Thabiso Mhlongo</title>
<link rel="icon" href="images/icon.png" type="image/gif" sizes="16x16">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0e0e0e;color:#fff;font-family:Arial,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center;padding:20px}
.card{background:#161616;border:1px solid #2a2a2a;border-radius:16px;padding:50px 40px;max-width:480px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,0.5)}
.icon{font-size:64px;margin-bottom:20px;animation:pop 0.6s ease}
@keyframes pop{0%{transform:scale(0)}50%{transform:scale(1.2)}100%{transform:scale(1)}}
h2{color:#4CAF50;font-size:24px;margin-bottom:12px}
p{color:#aaa;font-size:15px;line-height:1.6;margin-bottom:8px}
.ref{color:#D4AF37;font-weight:bold;font-size:18px;margin:16px 0}
.note{color:#666;font-size:12px;margin-top:20px;padding-top:16px;border-top:1px solid #2a2a2a}
.btn{display:inline-block;margin-top:24px;padding:12px 30px;background:#D4AF37;color:#111;font-weight:bold;text-decoration:none;border-radius:6px;transition:all 0.2s}
.btn:hover{background:#d6d435;transform:translateY(-2px)}
</style></head><body>
<div class="card">
<div class="icon">✅</div>
<h2>Payment Received!</h2>
<p>Thank you for your payment. Your booking is being confirmed.</p>
${bookingId ? `<div class="ref">Booking #${bookingId.replace(/[^0-9]/g, '')}</div>` : ''}
<p>You will receive a confirmation email shortly with all the details.</p>
<a href="/index.html${bookingId ? '?track=' + bookingId.replace(/[^0-9]/g, '') + '&payment=success' : ''}" class="btn">Track My Booking</a>
<p class="note">This page is for your reference only. Payment verification happens securely in the background via PayFast.</p>
</div></body></html>`);
});

app.get('/payment/cancel', (req, res) => {
    const bookingId = req.query.booking_id || '';
    res.send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Payment Cancelled | Thabiso Mhlongo</title>
<link rel="icon" href="images/icon.png" type="image/gif" sizes="16x16">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0e0e0e;color:#fff;font-family:Arial,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center;padding:20px}
.card{background:#161616;border:1px solid #2a2a2a;border-radius:16px;padding:50px 40px;max-width:480px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,0.5)}
.icon{font-size:64px;margin-bottom:20px}
h2{color:#FF9800;font-size:24px;margin-bottom:12px}
p{color:#aaa;font-size:15px;line-height:1.6;margin-bottom:8px}
.btn{display:inline-block;margin-top:24px;padding:12px 30px;background:#D4AF37;color:#111;font-weight:bold;text-decoration:none;border-radius:6px;transition:all 0.2s;margin-right:10px}
.btn:hover{background:#d6d435;transform:translateY(-2px)}
.btn-outline{background:transparent;color:#D4AF37;border:2px solid #D4AF37}
.btn-outline:hover{background:#D4AF37;color:#111}
.note{color:#666;font-size:12px;margin-top:20px;padding-top:16px;border-top:1px solid #2a2a2a}
</style></head><body>
<div class="card">
<div class="icon">⚠️</div>
<h2>Payment Cancelled</h2>
<p>Your payment was not completed. No charges have been made.</p>
<p>You can try again at any time from the booking tracker.</p>
<div style="margin-top:24px">
<a href="/index.html${bookingId ? '?track=' + bookingId.replace(/[^0-9]/g, '') + '&payment=cancel' : ''}" class="btn">Try Again</a>
<a href="/index.html" class="btn btn-outline">Back to Homepage</a>
</div>
<p class="note">If you're experiencing issues with payment, please contact management directly.</p>
</div></body></html>`);
});

// ==========================================
// POPIA Compliance Routes
// ==========================================

// 1. Right to be Forgotten (Anonymization Request)
app.post('/api/public/compliance/request-forget', ipRateLimiter, (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, message: 'Email required.' });

    // Whitelist prevents SQL injection if this function is ever called with untrusted input.
    const ANONYMIZE_TARGETS = [
        { table: 'bookings',   emailCol: 'email', extraFields: "name = '[FORGOTTEN]', cell = '000000000', company = NULL" },
        { table: 'inquiries',  emailCol: 'sender_email', extraFields: "sender_name = '[FORGOTTEN]', sender_phone = '000000000'" },
    ];
    const anonymize = ({ table, emailCol, extraFields }) => {
        return new Promise((resolve) => {
            db.run(
                `UPDATE ${table} SET ${emailCol} = 'deleted@po-pia.com', ${extraFields} WHERE LOWER(${emailCol}) = LOWER(?)`,
                [email], (err) => {
                    if (err) console.error(`[POPIA] request-forget failed for table=${table}:`, err.message);
                    resolve();
                }
            );
        });
    };

    Promise.all(ANONYMIZE_TARGETS.map(anonymize)).then(() => {
        db.run("DELETE FROM newsletter_subscribers WHERE LOWER(email) = LOWER(?)", [email]);
        res.json({ success: true, message: 'Your personal data has been queued for anonymization and newsletter removal according to POPIA.' });
    });
});

// 2. Data Portability (Export Request)
app.post('/api/public/compliance/export-data', ipRateLimiter, (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, message: 'Email required.' });

    const dataExport = {};
    
    db.all("SELECT * FROM bookings WHERE LOWER(email) = LOWER(?)", [email], (err, bookings) => {
        if (err) console.error('[POPIA] export-data bookings query failed:', err.message);
        dataExport.bookings = bookings || [];
        db.all("SELECT * FROM inquiries WHERE LOWER(sender_email) = LOWER(?)", [email], (err, inquiries) => {
            if (err) console.error('[POPIA] export-data inquiries query failed:', err.message);
            dataExport.inquiries = inquiries || [];
            
            if (dataExport.bookings.length === 0 && dataExport.inquiries.length === 0) {
                return res.status(404).json({ success: false, message: 'No data found for this email address.' });
            }

            // In production, we'd email this as a secure ZIP/PDF.
            // For now, we return the JSON payload.
            res.json({
                success: true,
                message: 'Data export generated successfully.',
                data: dataExport
            });
        });
    });
});

// Email-only booking lookup with pagination (5 lookups per 10 min per IP)
app.post('/api/public/bookings/lookup', lookupRateLimiter, (req, res) => {
    const { email, page } = req.body;
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim())) {
        return res.status(400).json({ success: false, message: 'A valid email address is required.' });
    }
    const offset = ((parseInt(page) || 1) - 1) * 10;
    const emailNorm = email.trim();
    // First fetch total count so client can show "Load more"
    db.get(
        `SELECT COUNT(*) AS total FROM bookings
         WHERE lower(email) = lower(?) AND status NOT IN ('CANCELLED')`,
        [emailNorm],
        (cErr, countRow) => {
            const total = (countRow && !cErr) ? countRow.total : 0;
            db.all(
                `SELECT id, event_name, date, status, created_at FROM bookings
                 WHERE lower(email) = lower(?) AND status NOT IN ('CANCELLED')
                 ORDER BY created_at DESC LIMIT 10 OFFSET ?`,
                [emailNorm, offset],
                (err, rows) => {
                    if (err) return res.status(500).json({ success: false, message: 'Lookup failed.' });
                    if (!rows || !rows.length) return res.json({ success: false, message: 'No bookings found for that email address.' });
                    res.json({ success: true, bookings: rows, total, page: parseInt(page) || 1 });
                }
            );
        }
    );
});

app.post('/api/public/bookings/:id/track', ipRateLimiter, trackRateLimiter, (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, message: 'Email is required.' });

    db.get("SELECT * FROM bookings WHERE id = ?", [req.params.id], (err, row) => {
        if (err || !row) return res.status(404).json({ success: false, message: 'Booking not found.' });
        if (row.email.trim().toLowerCase() !== email.trim().toLowerCase()) {
            return res.status(401).json({ success: false, message: 'Email does not match our records.' });
        }
        
        // Include latest invoice if exists
        db.get("SELECT file_path, invoice_number, status FROM invoices WHERE booking_id = ? AND status != 'VOID' ORDER BY created_at DESC LIMIT 1", [row.id], (e, inv) => {
            db.all("SELECT description, due_date, expected_amount, status, updated_at FROM payment_schedules WHERE booking_id = ? AND LOWER(COALESCE(status,'pending')) NOT IN ('superseded','cancelled') ORDER BY due_date ASC", [row.id], (e2, schedule) => {
                db.all(`SELECT s.name AS service_name, s.pricing_model, bs.quantity_minutes, bs.unit_price,
                               (bs.unit_price * bs.quantity_minutes) AS line_total
                        FROM booking_services bs
                        JOIN services s ON bs.service_id = s.id
                        WHERE bs.booking_id = ?`, [row.id], (e3, services) => {
                    db.get(
                        `SELECT version, (SELECT COUNT(*) FROM quotations WHERE booking_id = ?) AS total_versions
                         FROM quotations WHERE booking_id = ? AND archived = 0 ORDER BY version DESC LIMIT 1`,
                        [row.id, row.id], (qvErr, qv) => {
                            db.get("SELECT refund_due, refund_amount, refund_status, refunded_at, reason FROM cancellations WHERE booking_id = ?",
                                [row.id], (cErr, cancRow) => {
                                    db.get("SELECT pdf_url, status, sent_to_client_at, signed_by_client_at, signed_by_comedian_at, is_frozen FROM contracts WHERE booking_id = ?", [row.id], (contractErr, contractRow) => {
                                        // Strip gateway-internal fields — not needed by the public tracker
                                        const publicBooking = { ...row };
                                        delete publicBooking.payment_raw_data;
                                        delete publicBooking.payment_signature;
                                        delete publicBooking.pf_payment_id;

                                        res.json({
                                            success: true,
                                            booking: publicBooking,
                                            invoice: inv || null,
                                            payment_schedule: schedule || [],
                                            services: services || [],
                                            quote_version: qv ? qv.version : null,
                                            quote_version_count: qv ? qv.total_versions : 0,
                                            cancellation: cancRow || null,
                                            contract: contractRow || null
                                        });
                                    });
                                });
                        }
                    );
                });
            });
        });
    });
});

// Accept quote (public) — client formally accepts a sent quote
// SECURITY NOTE (Gap 1 — accepted risk): Auth is email-match only. No OTP/token second factor is
// required. This is an intentional decision documented in the Phase 2 audit. If the risk profile
// changes, add a signed acceptance token embedded in the quote email.
app.post('/api/public/bookings/:id/accept-quote', mutateRateLimiter, ipRateLimiter, async (req, res) => {
    const { email, terms_agreed } = req.body;
    if (!email) return res.status(400).json({ success: false, message: 'Email is required.' });
    if (!terms_agreed) return res.status(400).json({ success: false, message: 'You must agree to the terms and conditions to accept this quote.' });

    // Client-supplied and written straight to bookings.vat_number, which the admin panel renders.
    // Same treatment as every other public free-text field: bounded and output-encoded.
    const vat_number = asBookingText(req.body.vat_number);
    if (vat_number.length > 30) return res.status(400).json({ success: false, message: 'VAT number must be under 30 characters.' });

    const bookingId = req.params.id;
    const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || 'unknown';

    try {
        const row = await dbGet("SELECT * FROM bookings WHERE id = ?", [bookingId]);
        if (!row) return res.status(404).json({ success: false, message: 'Booking not found.' });

        // Gap 1 (Phase 2): acceptance is authenticated by matching the stored email address alone.
        // Reviewed 2026-07-09 and accepted as risk — the blast radius is one booking marked ACCEPTED,
        // which an admin can reverse by re-quoting. Revisit if booking IDs ever stop being internal.
        if (row.email.trim().toLowerCase() !== email.trim().toLowerCase()) {
            return res.status(401).json({ success: false, message: 'Email does not match our records.' });
        }
        // Gap 4 (Phase 2): 'RESPONDED' was a legacy status retired in Phase 2 — only 'QUOTED' is valid here.
        if (row.status !== 'QUOTED') {
            return res.status(400).json({ success: false, message: `Cannot accept quote – current status is ${row.status}.` });
        }
        // quote_amount is written by the quote route as finalTotal.toFixed(2), so a zero quote is the
        // string "0.00" — the old `=== '0'` check never caught it.
        const quotedTotal = parseFloat(row.quote_amount);
        if (!Number.isFinite(quotedTotal) || quotedTotal <= 0) {
            return res.status(400).json({ success: false, message: 'No quote has been issued for this booking yet.' });
        }
        // Expiry is compared in the business's own timezone. This used to use the UTC date, so between
        // midnight and 02:00 SAST a quote that expired yesterday was still acceptable.
        if (row.quote_expiry_date) {
            const todayLocal = moment().tz('Africa/Johannesburg').format('YYYY-MM-DD');
            if (row.quote_expiry_date < todayLocal) {
                return res.status(410).json({ success: false, message: `This quote expired on ${row.quote_expiry_date}. Please contact us to request a revised quote.` });
            }
        }

        // Acceptance is one atomic unit: the status flip, the quotation stamp, the audit row and the
        // payment schedule. Previously these were four independent statements and two of them swallowed
        // their errors, so a schedule failure left an ACCEPTED booking with no payment plan — and
        // generateInvoice() then rendered an invoice PDF with no split.
        const outcome = await withDbTransaction(async () => {
            try {
                await dbRun("BEGIN IMMEDIATE");
            } catch (beginErr) {
                console.error('[Accept-Quote] BEGIN IMMEDIATE failed:', beginErr.message);
                return { status: 503, body: { success: false, message: 'We could not record your acceptance just now. Please try again in a moment.' } };
            }
            try {
                // Compare-and-swap on the status. The check above is a read, and the event loop yields
                // between it and this write, so two concurrent acceptances could both pass it. Guarding
                // the UPDATE with `AND status = 'QUOTED'` makes exactly one of them win.
                //
                // A deposit confirms a booking. Re-accepting after a re-quote therefore lands back on
                // CONFIRMED when money has already been paid, rather than demoting a part-paid booking
                // to ACCEPTED. Expressed as a CASE so the rule stays race-free inside the same statement.
                const upd = await dbRun(
                    `UPDATE bookings SET
                            status = CASE WHEN COALESCE(amount_paid, 0) > 0 THEN 'CONFIRMED' ELSE 'ACCEPTED' END,
                            accepted_at = CURRENT_TIMESTAMP, acceptance_ip = ?,
                            acceptance_agreed_at = CURRENT_TIMESTAMP, vat_number = COALESCE(?, vat_number)
                     WHERE id = ? AND status = 'QUOTED'`,
                    [clientIp, encodeUserHtml(vat_number) || null, bookingId]
                );
                if (upd.changes === 0) {
                    await dbRun("ROLLBACK").catch(() => {});
                    return { status: 409, body: { success: false, message: 'This quote has already been accepted.' } };
                }

                await dbRun("UPDATE quotations SET status = 'accepted' WHERE booking_id = ? AND archived = 0", [bookingId]);

                // P3-3: Audit log for quote acceptance
                await dbRun(`INSERT INTO audit_log (table_name, record_id, action, new_values, changed_by, change_timestamp, ip_address)
                        VALUES ('bookings', ?, 'QUOTE_ACCEPTED', ?, ?, CURRENT_TIMESTAMP, ?)`,
                    [bookingId, JSON.stringify({ accepted_by: email, ip: clientIp, amount: row.quote_amount }), email, clientIp]);

                // Auto-create the default 50/50 split only when there is no LIVE UNPAID plan.
                // F3: both rows must exist before generateInvoice() reads payment_schedules for the PDF.
                //
                // A surviving PAID row must NOT suppress creation. Re-quoting an ACCEPTED booking
                // supersedes every unpaid milestone but leaves the paid ones (the money moved), and the
                // old "does a plan exist?" count treated that paid deposit as an admin-configured plan —
                // so a client who paid R500 on a R1000 quote, re-quoted to R5000, ended up owing R4500
                // against no milestones at all. Detection therefore excludes 'paid' too.
                //
                // The split covers the OUTSTANDING balance, measured against the paid rows'
                // expected_amount rather than bookings.amount_paid: the invariant below is defined over
                // expected_amount, and expected_amount is what the invoice PDF renders.
                //
                // Invariant: SUM(expected_amount) over live (non-superseded, non-cancelled) rows == total_amount.
                const totalAmount = quotedTotal || parseFloat(row.total_amount) || 0;
                if (totalAmount > 0) {
                    const liveRow = await dbGet(
                        "SELECT COUNT(*) AS cnt FROM payment_schedules WHERE booking_id = ? AND LOWER(COALESCE(status,'pending')) NOT IN ('superseded','cancelled','paid')",
                        [bookingId]);
                    const hasLiveUnpaid = (liveRow ? liveRow.cnt : 0) > 0;
                    if (!hasLiveUnpaid) { // no admin-configured milestones — (re)build the auto split
                        const paidRow = await dbGet(
                            "SELECT COALESCE(SUM(expected_amount),0) AS paidSum FROM payment_schedules WHERE booking_id = ? AND LOWER(COALESCE(status,'pending')) = 'paid'",
                            [bookingId]);
                        const paidSum = paidRow ? (parseFloat(paidRow.paidSum) || 0) : 0;
                        const remaining = Math.round((totalAmount - paidSum) * 100) / 100;

                        if (remaining > 0.009) {
                            const depositAmount = Math.round((remaining * 0.5) * 100) / 100;
                            const balanceAmount = Math.round((remaining - depositAmount) * 100) / 100;
                            const depositDue = moment().add(7, 'days').format('YYYY-MM-DD');
                            const eventDate = row.date || row.event_date;
                            const balanceDue = eventDate
                                ? moment(eventDate).subtract(2, 'days').format('YYYY-MM-DD')
                                : moment().add(30, 'days').format('YYYY-MM-DD');
                            // Distinct labels once a payment exists, so the invoice PDF never shows two
                            // rows both called "50% Deposit" for different amounts.
                            const depositLabel = paidSum > 0 ? 'Outstanding Balance – Deposit (50%)' : '50% Deposit';
                            const balanceLabel = paidSum > 0 ? 'Outstanding Balance – Final (50%)'   : '50% Balance';
                            await dbRun("INSERT INTO payment_schedules (booking_id, description, due_date, expected_amount) VALUES (?, ?, ?, ?)",
                                [bookingId, depositLabel, depositDue, depositAmount]);
                            await dbRun("INSERT INTO payment_schedules (booking_id, description, due_date, expected_amount) VALUES (?, ?, ?, ?)",
                                [bookingId, balanceLabel, balanceDue, balanceAmount]);
                        } else {
                            // A re-quote to a lower total that payments already cover. Nothing left to schedule.
                            console.warn(`[Accept-Quote] Booking #${bookingId}: paid milestones (R${paidSum.toFixed(2)}) already cover the total (R${totalAmount.toFixed(2)}) — no new milestones created.`);
                        }
                    }
                }

                // Read back what the CASE above actually resolved to, so the response and the client
                // email report the real status rather than assuming ACCEPTED.
                const settled = await dbGet("SELECT status FROM bookings WHERE id = ?", [bookingId]);

                await dbRun("COMMIT");
                return { ok: true, newStatus: (settled && settled.status) || 'ACCEPTED' };
            } catch (txErr) {
                await dbRun("ROLLBACK").catch(() => {});
                console.error('[Accept-Quote] Failed — rolled back, booking still QUOTED (#' + bookingId + '):', txErr.message);
                return { status: 500, body: { success: false, message: 'We could not record your acceptance. Please try again.' } };
            }
        });

        if (!outcome.ok) return res.status(outcome.status).json(outcome.body);
        const newStatus = outcome.newStatus;

        // ---- Side effects, after the commit. None of these may prevent the response. ----
        // generateInvoice() and generateContract() open their own guarded transactions, so they must
        // run outside the one above or they would deadlock behind it in the queue.
        await syncBookingToCalendar(bookingId).catch(e => console.error('[Accept-Quote] Calendar sync failed:', e.message));

        // Gap 2 (Phase 2): Track whether invoice generation succeeds so we can give an honest
        // client-facing message. The acceptance is NOT rolled back if the invoice fails — the booking
        // is accepted; only the invoice email promise changes.
        let invoiceGenerated = false;
        try {
            await generateInvoice(bookingId);
            invoiceGenerated = true;
        } catch(invErr) {
            console.error('[Invoice] Auto-generation failed during acceptance (booking #' + bookingId + '):', invErr);
        }

        // Auto-generate a DRAFT booking contract alongside the invoice. Non-blocking —
        // acceptance must never fail because of contract generation; it's a draft for admin review.
        try { await generateContract(bookingId); }
        catch(cErr) { console.error('[Auto-Contract] Generation failed during acceptance (booking #' + bookingId + '):', cErr.message); }

        // Guarded: this used to be a bare `await` inside a sqlite3 callback, where a rejection became
        // an unhandled rejection and the client never received a response for a booking already accepted.
        await sendQuoteAcceptedEmail({ ...row, status: newStatus }, { invoiceGenerated })
            .catch(e => console.error('[Accept-Quote] Client confirmation email failed:', e.message));
        sendAdminQuoteAcceptedNotification({ ...row, status: newStatus })
            .catch(e => console.error('Admin quote-accepted notification failed:', e.message));

        // Gap 2: Conditionally tell the client about the invoice based on whether it was generated.
        const acceptMsg = invoiceGenerated
            ? 'Quote accepted successfully. Your invoice has been generated and emailed to you.'
            : 'Quote accepted successfully. Our team will be in touch shortly with your invoice details.';
        res.json({ success: true, message: acceptMsg, newStatus, invoice_generated: invoiceGenerated });
    } catch (e) {
        console.error('[Accept-Quote] Unexpected failure (booking #' + bookingId + '):', e);
        res.status(500).json({ success: false, message: 'We could not process your acceptance. Please contact us directly.' });
    }
});

// Quote revision request (public) — client requests extension or revision of a QUOTED booking
app.post('/api/public/bookings/:id/quote-revision-request', mutateRateLimiter, ipRateLimiter, async (req, res) => {
    const { email, request_type, message } = req.body;
    if (!email) return res.status(400).json({ success: false, message: 'Email is required.' });
    if (!request_type || !['extension', 'revision'].includes(request_type)) {
        return res.status(400).json({ success: false, message: 'request_type must be "extension" or "revision".' });
    }
    if (!message || message.trim().length < 10) {
        return res.status(400).json({ success: false, message: 'Please provide more detail about your request (at least 10 characters).' });
    }

    db.get("SELECT * FROM bookings WHERE id = ?", [req.params.id], async (err, row) => {
        if (err || !row) return res.status(404).json({ success: false, message: 'Booking not found.' });
        if (row.email.trim().toLowerCase() !== email.trim().toLowerCase()) {
            return res.status(401).json({ success: false, message: 'Email does not match our records.' });
        }
        // Gap 4 (Phase 2): 'RESPONDED' was a legacy status retired in Phase 2 — only 'QUOTED' is valid.
        if (row.status !== 'QUOTED') {
            return res.status(400).json({ success: false, message: 'Quote revision requests can only be made on bookings in QUOTED status.' });
        }

        const typeLabel = request_type === 'extension' ? 'Quote Expiry Extension' : 'Quote Revision';
        const notifEmail = await getNotificationEmail();

        const adminHtml = emailComponents.renderSystemEmail({
            preheaderText: `${typeLabel} request from ${row.name} for booking #${row.id}.`,
            category: 'Quotes & Proposals',
            severity: 'action',
            leadFact: `A client has submitted a <strong style="color:#D4AF37;">${typeLabel}</strong> request for booking <strong style="color:#FAFAFA;">#${row.id}</strong>.`,
            bodyHtml: `<p style="margin:0; color:#B0B0B0; font-size:12px;">Please review this request in the admin panel and respond to the client accordingly.</p>`,
            cards: [{
                rows: [
                    { label: 'Client', value: row.name, mono: false },
                    { label: 'Email', value: row.email },
                    { label: 'Event', value: `${row.event_name || row.event_type} on ${row.date}`, mono: false },
                    { label: 'Quote Amount', value: `R ${parseFloat(row.quote_amount || 0).toFixed(2)}`, highlight: true },
                    { label: 'Quote Expiry', value: row.quote_expiry_date || 'Not set' },
                    { label: 'Request Type', value: typeLabel, mono: false, highlight: true },
                    { label: 'Client Message', value: message.trim(), mono: false }
                ]
            }]
        });

        try {
            // Log the client's request as a booking note first (critical operation)
            const noteText = `[${typeLabel} Request]\n"${message.trim()}"`;
            await new Promise((resolveNote, rejectNote) => {
                db.run(
                    "INSERT INTO booking_notes (booking_id, note, author) VALUES (?, ?, 'Client')",
                    [row.id, encodeUserHtml(noteText)],
                    (noteErr) => noteErr ? rejectNote(noteErr) : resolveNote()
                );
            });

            // Send email notifications asynchronously in the background (no await)
            sendEmail({
                to: notifEmail,
                subject: `[ACTION REQUIRED] ${typeLabel} Request – Booking #${row.id}`,
                htmlContent: adminHtml,
                preWrapped: true,
                titleOverride: `${typeLabel} Request`,
                trigger_event: 'Booking: Quote Revision Request'
            }).catch(e => console.error('[Quote Revision Request] Admin email notification failed:', e.message));

            getEmailFooterContext().then(async ({ socialLinks }) => {
                const banner = await bannerRegistry.resolveBanner('custom_response');
                return sendEmail({
                    to: row.email,
                    subject: `We've Received Your Request – Booking #${row.id}`,
                    htmlContent: emailComponents.renderPremiumEmail({
                        preheaderText: `We've received your request for booking #${row.id}.`,
                        bannerSrc: banner?.src, bannerAlt: banner?.alt, subtitle: banner?.subtitle,
                        headline: banner?.headline || 'Request Received',
                        greeting: `Hi ${row.name},`,
                        bodyHtml:
                            `We've received your <strong style="color:#D4AF37;">${typeLabel.toLowerCase()}</strong> request for booking <strong style="color:#FAFAFA;">#${row.id}</strong>. Our team will review your request and get back to you shortly.` +
                            `<p style="margin:10px 0 0; color:#B0B0B0; font-size:12px;">Your request: "${message.trim()}"</p>`,
                        socialLinks
                    }),
                    preWrapped: true,
                    titleOverride: 'Request Received',
                    trigger_event: 'Booking: Quote Revision Acknowledgement'
                });
            }).catch(e => console.error('[Quote Revision Request] Client email acknowledgement failed:', e.message));

            res.json({ success: true, message: 'Your request has been recorded. We will be in touch shortly.' });
        } catch (dbErr) {
            console.error('[Quote Revision Request] DB insert failed:', dbErr.message);
            res.status(500).json({ success: false, message: 'Failed to record your request in the database.' });
        }
    });
});

// P2.4 — Date availability check (public, rate-limited)
const MIN_ADVANCE_HOURS = 48;

function checkDateAvailability(dateStr, callback) {
    db.all("SELECT start_time, end_time, block_type FROM date_holds WHERE hold_date = ? AND status = 'active' AND (hold_expires_at IS NULL OR hold_expires_at > datetime('now'))", [dateStr], (err, holds) => {
        if (err) return callback(err);
        
        let allDay = false;
        const busyRanges = [];
        
        if (holds) {
            holds.forEach(h => {
                if (!h.start_time) {
                    allDay = true;
                } else {
                    let hEnd = h.end_time;
                    if (!hEnd) {
                        // No end_time stored — default to 1 hour after start
                        const hp = h.start_time.split(':');
                        let hh = parseInt(hp[0]) + 1;
                        if (hh >= 24) hh = 23;
                        hEnd = `${String(hh).padStart(2, '0')}:${hp[1]}`;
                    }
                    busyRanges.push({ start: h.start_time, end: hEnd });
                }
            });
        }
        
        if (allDay) {
            return callback(null, { available: false, reason: 'held' });
        }
        
        // Also check standalone events
        db.all("SELECT event_datetime FROM events WHERE date(event_datetime) = ? AND booking_id IS NULL", [dateStr], (err, events) => {
            if (err) return callback(err);
            
            if (events) {
                events.forEach(e => {
                    if (e.event_datetime) {
                        const parts = e.event_datetime.split(/[T ]/);
                        const time = parts[1];
                        if (time) {
                            const t = time.slice(0, 5);
                            const tp = t.split(':');
                            let eh = parseInt(tp[0]) + 1;
                            if (eh >= 24) eh = 23;
                            const tEnd = `${String(eh).padStart(2, '0')}:${tp[1]}`;
                            busyRanges.push({ start: t, end: tEnd });
                        } else {
                            allDay = true;
                        }
                    } else {
                        allDay = true;
                    }
                });
            }
            
            if (allDay) {
                return callback(null, { available: false, reason: 'event' });
            }
            
            // Also check confirmed bookings (exclude terminal statuses that no longer hold the date)
            db.all(
                `SELECT event_start_time, performance_end_time, performance_duration
                 FROM bookings WHERE date = ? AND status NOT IN ('CANCELLED', 'EXPIRED')`,
                [dateStr],
                (err, bookings) => {
                    if (err) return callback(err);

                    if (bookings) {
                        bookings.forEach(b => {
                            if (!b.event_start_time) return;
                            let bEnd = b.performance_end_time;
                            if (!bEnd) {
                                const mins = parseDurationToMinutes(b.performance_duration);
                                bEnd = addMinutesToTime(b.event_start_time, mins);
                            }
                            // Extend end by buffer so next booking can't start immediately after
                            const bufferedEnd = addMinutesToTime(bEnd, MIN_BOOKING_GAP_MINS);
                            busyRanges.push({ start: b.event_start_time, end: bufferedEnd });
                        });
                    }

                    callback(null, { available: true, busy_ranges: busyRanges });
                }
            );
        });
    });
}

app.get('/api/public/availability', ipRateLimiter, trackRateLimiter, (req, res) => {
    const { date } = req.query;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return res.status(400).json({ available: false, message: 'Date parameter (YYYY-MM-DD) required.' });
    }

    // Minimum advance notice check
    const now = new Date();
    const chosen = new Date(date + 'T00:00:00');
    const diffHours = (chosen - now) / (1000 * 60 * 60);
    if (diffHours < MIN_ADVANCE_HOURS) {
        return res.json({
            available: false,
            reason: 'too_soon',
            message: `Bookings require at least ${MIN_ADVANCE_HOURS} hours advance notice. Please choose a later date.`
        });
    }

    checkDateAvailability(date, (err, result) => {
        if (err) return res.status(500).json({ available: false, message: 'Server error.' });

        if (result.available) {
            return res.json({ available: true, message: 'This date is available!', busy_ranges: result.busy_ranges || [] });
        }

        // Suggest nearest available date (scan forward up to 60 days)
        const reasonMsg = result.reason === 'held'
            ? 'This date is blocked by a schedule hold.'
            : 'This date is already booked.';

        let scanDate = new Date(chosen);
        let checked = 0;
        const maxDays = 60;

        function scanNext() {
            if (checked >= maxDays) {
                return res.json({ available: false, reason: result.reason, message: reasonMsg });
            }
            scanDate.setDate(scanDate.getDate() + 1);
            checked++;
            const scanStr = scanDate.toISOString().split('T')[0];
            const scanDiffH = (scanDate - now) / (1000 * 60 * 60);
            if (scanDiffH < MIN_ADVANCE_HOURS) { scanNext(); return; }
            checkDateAvailability(scanStr, (e2, r2) => {
                if (r2.available) {
                    const opts = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
                    const label = scanDate.toLocaleDateString('en-ZA', opts);
                    return res.json({
                        available: false,
                        reason: result.reason,
                        message: reasonMsg,
                        suggestion: scanStr,
                        suggestion_label: label
                    });
                }
                scanNext();
            });
        }
        scanNext();
    });
});

// Booking configuration — per-day working hours + gap for the frontend slot picker
app.get('/api/public/booking-config', ipRateLimiter, (req, res) => {
    const dayOfWeek = req.query.dow !== undefined ? parseInt(req.query.dow) : new Date().getDay();
    db.get("SELECT start_time, end_time, is_working_day FROM working_hours WHERE day_of_week = ?", [dayOfWeek], (err, wh) => {
        db.get("SELECT setting_value FROM settings WHERE setting_key = 'min_booking_gap_minutes'", [], (err2, gapRow) => {
            res.json({
                working_hours_start:     (!err && wh) ? wh.start_time : '09:00',
                working_hours_end:       (!err && wh) ? wh.end_time   : '22:00',
                is_working_day:          (!err && wh) ? !!wh.is_working_day : true,
                min_booking_gap_minutes: (!err2 && gapRow) ? parseInt(gapRow.setting_value) || 30 : 30
            });
        });
    });
});

// Admin — read per-day working hours
app.get('/api/admin/working-hours', requireAdmin, (req, res) => {
    db.all("SELECT day_of_week, start_time, end_time, is_working_day FROM working_hours ORDER BY day_of_week", [], (err, rows) => {
        if (err) return res.status(500).json({ success: false, error: err.message });
        db.get("SELECT setting_value FROM settings WHERE setting_key = 'min_booking_gap_minutes'", [], (err2, gapRow) => {
            db.get("SELECT setting_value FROM settings WHERE setting_key = 'type_buffers'", [], (err3, tbRow) => {
                let type_buffers = {};
                if (!err3 && tbRow) { try { type_buffers = JSON.parse(tbRow.setting_value) || {}; } catch(e) {} }
                res.json({
                    success: true,
                    schedule: rows || [],
                    min_booking_gap_minutes: (!err2 && gapRow) ? parseInt(gapRow.setting_value) || 30 : 30,
                    type_buffers
                });
            });
        });
    });
});

// Admin — save per-day working hours + gap
app.put('/api/admin/working-hours', requireAdmin, (req, res) => {
    const { schedule, min_booking_gap_minutes, type_buffers } = req.body;
    if (!Array.isArray(schedule) || schedule.length !== 7) {
        return res.status(400).json({ success: false, message: 'schedule must be an array of 7 day objects.' });
    }
    const timeRe = /^\d{2}:\d{2}$/;
    for (const d of schedule) {
        if (typeof d.day_of_week !== 'number' || d.day_of_week < 0 || d.day_of_week > 6) {
            return res.status(400).json({ success: false, message: `Invalid day_of_week: ${d.day_of_week}` });
        }
        if (!timeRe.test(d.start_time) || !timeRe.test(d.end_time)) {
            return res.status(400).json({ success: false, message: `start_time/end_time must be HH:MM for day ${d.day_of_week}` });
        }
    }
    const gap = parseInt(min_booking_gap_minutes);
    if (isNaN(gap) || gap < 0) {
        return res.status(400).json({ success: false, message: 'min_booking_gap_minutes must be a non-negative integer.' });
    }
    const safeTypeBuffers = (type_buffers && typeof type_buffers === 'object') ? type_buffers : {};
    db.serialize(() => {
        schedule.forEach(d => {
            db.run(
                `INSERT INTO working_hours (day_of_week, start_time, end_time, is_working_day)
                 VALUES (?, ?, ?, ?)
                 ON CONFLICT(day_of_week) DO UPDATE SET
                     start_time = excluded.start_time,
                     end_time   = excluded.end_time,
                     is_working_day = excluded.is_working_day`,
                [d.day_of_week, d.start_time, d.end_time, d.is_working_day ? 1 : 0]
            );
        });
        db.run(`INSERT INTO settings (setting_key, setting_value) VALUES ('min_booking_gap_minutes', ?)
                ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value`, [String(gap)]);
        db.run(`INSERT INTO settings (setting_key, setting_value) VALUES ('type_buffers', ?)
                ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value`,
            [JSON.stringify(safeTypeBuffers)], (err) => {
                if (err) return res.status(500).json({ success: false, error: err.message });
                MIN_BOOKING_GAP_MINS = gap;
                TYPE_BUFFERS = safeTypeBuffers;
                res.json({ success: true, message: 'Working hours saved.' });
            });
    });
});

// Month availability — returns held and booked dates for calendar widget
app.get('/api/public/availability/month', ipRateLimiter, (req, res) => {
    const year = parseInt(req.query.year);
    const month = parseInt(req.query.month); // 1-12
    if (!year || !month || month < 1 || month > 12 || year < 2020 || year > 2099) {
        return res.status(400).json({ held: [], booked: [], error: 'Invalid year/month.' });
    }
    const monthStr = String(month).padStart(2, '0');
    const prefix = `${year}-${monthStr}`;

    db.all(
        "SELECT hold_date FROM date_holds WHERE hold_date LIKE ? AND status = 'active' AND start_time IS NULL",
        [prefix + '%'],
        (err, holds) => {
            const heldDates = (holds || []).map(r => r.hold_date);
            db.all(
                "SELECT DISTINCT date FROM bookings WHERE date LIKE ? AND status IN ('CONFIRMED','ACCEPTED')",
                [prefix + '%'],
                (err2, bks) => {
                    // Only return dates with confirmed/accepted bookings, no client info
                    const bookedDates = (bks || []).map(r => r.date).filter(d => !heldDates.includes(d));
                    res.json({ held: heldDates, booked: bookedDates });
                }
            );
        }
    );
});

// P3-8: Helper to calculate refund based on policy.
// Reads thresholds from policyStr JSON ({tiers:[{days_min,retention_pct,label},...]} sorted desc).
// Falls back to hardcoded 30/14/0-day tiers if no valid policy is provided.
const calculateCancellationRefund = (booking, policyStr) => {
    const totalPaid = parseFloat(booking.amount_paid || 0);
    const totalFee = parseFloat(booking.total_amount || booking.amount_paid || 0);

    if (!booking.date) return { rule: "No event date set", retention: totalPaid, refund: 0, totalPaid, daysUntilEvent: null };

    const eventDate = new Date(booking.date);
    const now = new Date();
    const daysUntilEvent = Math.ceil((eventDate - now) / (1000 * 60 * 60 * 24));

    // Parse policy tiers from DB value, or use built-in defaults
    let tiers = null;
    if (policyStr) {
        try {
            const parsed = JSON.parse(policyStr);
            if (Array.isArray(parsed.tiers) && parsed.tiers.length > 0) tiers = parsed.tiers;
        } catch (_) {}
    }
    if (!tiers) {
        tiers = [
            { days_min: 30, retention_pct: 0.10, label: "30+ days (10% admin fee retained)" },
            { days_min: 14, retention_pct: 0.50, label: "14-29 days (50% fee retained)" },
            { days_min:  0, retention_pct: 1.00, label: "< 14 days (100% fee retained, non-refundable)" }
        ];
    }
    // Tiers must be sorted descending by days_min
    const sorted = [...tiers].sort((a, b) => b.days_min - a.days_min);
    const tier = sorted.find(t => daysUntilEvent >= t.days_min) || sorted[sorted.length - 1];

    const retention = totalFee * (parseFloat(tier.retention_pct) || 0);
    const rule = tier.label || `${tier.days_min}+ days (${(tier.retention_pct * 100).toFixed(0)}% retained)`;

    const actualRetention = Math.min(retention, totalPaid);
    const refundDue = Math.max(0, totalPaid - actualRetention);

    return { rule, retention: actualRetention, refund: refundDue, totalPaid, daysUntilEvent };
};

// P2.0 — Cancellation Preview
app.get('/api/admin/bookings/:id/cancellation-preview', requireAdmin, (req, res) => {
    const bookingId = req.params.id;
    db.get("SELECT * FROM bookings WHERE id = ?", [bookingId], (err, booking) => {
        if (err || !booking) return res.status(404).json({ success: false, message: 'Booking not found.' });
        if (['COMPLETED', 'CANCELLED'].includes((booking.status || '').toUpperCase())) {
            return res.status(400).json({ success: false, message: `Booking already ${booking.status}` });
        }
        
        db.get("SELECT policy_value FROM policies WHERE policy_key = 'cancellation_policy'", (err, policy) => {
            const policyStr = policy ? policy.policy_value : "";
            const calc = calculateCancellationRefund(booking, policyStr);
            res.json({ success: true, preview: calc });
        });
    });
});

// P2.0 — Reopen an EXPIRED booking — resets to PENDING so admin can issue a new quote
app.post('/api/admin/bookings/:id/reopen', requireAdmin, (req, res) => {
    const bookingId = parseInt(req.params.id, 10);
    db.get("SELECT id, status, name, email FROM bookings WHERE id = ?", [bookingId], (err, booking) => {
        if (err || !booking) return res.status(404).json({ success: false, message: 'Booking not found.' });
        if ((booking.status || '').toUpperCase() !== 'EXPIRED') {
            return res.status(400).json({ success: false, message: `Only EXPIRED bookings can be reopened. Current status: ${booking.status}.` });
        }
        db.run(
            `UPDATE bookings SET status = 'PENDING', quote_amount = NULL, quote_details = NULL, quote_expiry_date = NULL, quoted_at = NULL WHERE id = ?`,
            [bookingId],
            function(upErr) {
                if (upErr) return res.status(500).json({ success: false, message: upErr.message });
                db.run(
                    `INSERT INTO audit_log (table_name, record_id, action, old_values, new_values, changed_by, change_timestamp)
                     VALUES ('bookings', ?, 'REOPEN', ?, ?, ?, CURRENT_TIMESTAMP)`,
                    [bookingId,
                     JSON.stringify({ status: 'EXPIRED' }),
                     JSON.stringify({ status: 'PENDING', note: 'Reopened by admin — previous quote cleared' }),
                     req.session.adminId || 'admin']
                );
                res.json({ success: true, message: 'Booking reopened and returned to PENDING.' });
            }
        );
    });
});

// P2.0b — Book Again — creates a new PENDING booking pre-filled from a CANCELLED booking
app.post('/api/admin/bookings/:id/book-again', requireAdmin, async (req, res) => {
    const originalId = parseInt(req.params.id, 10);
    db.get("SELECT * FROM bookings WHERE id = ?", [originalId], (err, orig) => {
        if (err || !orig) return res.status(404).json({ success: false, message: 'Booking not found.' });
        if ((orig.status || '').toUpperCase() !== 'CANCELLED') {
            return res.status(400).json({ success: false, message: `Only CANCELLED bookings can be rebooked. Current status: ${orig.status}.` });
        }

        // Copy client + event fields; reset all financial and lifecycle fields
        db.run(
            `INSERT INTO bookings (
                name, company, email, cell,
                event_name, date, event_start_time, performance_slot, performance_duration,
                event_location, venue_address, city, country, venue_type,
                event_type, audience_size, audience_demographic, budget_range,
                travel_accommodation, message,
                status, payment_status, rebooked_from_id, created_at
             ) VALUES (
                ?, ?, ?, ?,
                ?, ?, ?, ?, ?,
                ?, ?, ?, ?, ?,
                ?, ?, ?, ?,
                ?, ?,
                'NEW', 'UNPAID', ?, CURRENT_TIMESTAMP
             )`,
            [
                orig.name, orig.company || null, orig.email, orig.cell,
                orig.event_name || null, orig.date, orig.event_start_time || null, orig.performance_slot || null, orig.performance_duration || null,
                orig.event_location, orig.venue_address || null, orig.city || null, orig.country || null, orig.venue_type || null,
                orig.event_type, orig.audience_size || null, orig.audience_demographic || null, orig.budget_range || null,
                orig.travel_accommodation || 0, orig.message || '',
                originalId
            ],
            function(insErr) {
                if (insErr) return res.status(500).json({ success: false, message: insErr.message });
                const newId = this.lastID;
                // Audit on old booking
                db.run(
                    `INSERT INTO audit_log (table_name, record_id, action, new_values, changed_by, change_timestamp)
                     VALUES ('bookings', ?, 'REBOOKED', ?, ?, CURRENT_TIMESTAMP)`,
                    [originalId,
                     JSON.stringify({ new_booking_id: newId, note: 'Client rebooked — new booking created from this cancelled record' }),
                     req.session.adminId || 'admin']
                );
                // Audit on new booking
                db.run(
                    `INSERT INTO audit_log (table_name, record_id, action, new_values, changed_by, change_timestamp)
                     VALUES ('bookings', ?, 'CREATE', ?, ?, CURRENT_TIMESTAMP)`,
                    [newId,
                     JSON.stringify({ status: 'NEW', rebooked_from_id: originalId, note: 'Created via Book Again from cancelled booking' }),
                     req.session.adminId || 'admin']
                );
                res.json({ success: true, message: `New booking #${newId} created from cancelled booking #${originalId}.`, new_booking_id: newId });
            }
        );
    });
});

// P2.1 — Cancel booking (admin) — writes to cancellations table and notifies client
app.post('/api/admin/bookings/:id/cancel', requireAdmin, async (req, res) => {
    const bookingId = req.params.id;
    const { reason, cancelled_by, notes } = req.body;
    const validCancelledBy = ['client', 'comedian', 'mutual', 'force_majeure'];
    const cancelledBy = validCancelledBy.includes(cancelled_by) ? cancelled_by : 'comedian';

    db.get("SELECT * FROM bookings WHERE id = ?", [bookingId], (err, booking) => {
        if (err || !booking) return res.status(404).json({ success: false, message: 'Booking not found.' });
        const currentStatus = (booking.status || '').toUpperCase();
        if (['COMPLETED', 'CANCELLED'].includes(currentStatus)) {
            return res.status(400).json({ success: false, message: `Cannot cancel a booking with status ${booking.status}.` });
        }
        
        db.get("SELECT policy_value FROM policies WHERE policy_key = 'cancellation_policy'", async (err, policy) => {
            // SC-2: Force majeure — full refund regardless of timeline
            const isForceMajeure = cancelledBy === 'force_majeure';
            const policyStr = policy ? policy.policy_value : "";
            const calc = calculateCancellationRefund(booking, policyStr);
            const totalPaid = calc.totalPaid;
            const refundDue       = isForceMajeure ? totalPaid : calc.refund;
            const retentionAmount = isForceMajeure ? 0          : calc.retention;
            const policyRule      = isForceMajeure ? 'Force Majeure — Full Refund Granted' : calc.rule;

            // Everything a cancellation implies is one atomic unit. The audit row and the four
            // cascades (holds, invoices, payment schedules, events) used to run AFTER `COMMIT` with
            // their errors logged and ignored, so a cancelled booking could keep an open invoice the
            // admin would go on chasing.
            const outcome = await withDbTransaction(async () => {
                try {
                    await dbRun("BEGIN IMMEDIATE");
                } catch (beginErr) {
                    console.error('[Cancel] BEGIN IMMEDIATE failed:', beginErr.message);
                    return { status: 500, body: { success: false, message: 'Database busy. Please retry.' } };
                }
                try {
                    // payment_status is deliberately NOT set to 'CANCELLED'. The
                    // chk_bookings_payment_status_update trigger only permits
                    // UNPAID|DEPOSIT_PAID|PARTIALLY_PAID|PAID|REFUNDED|FAILED, so writing 'CANCELLED'
                    // aborted the whole statement — this route returned 500 on every call. The real
                    // payment state must survive cancellation anyway: the refund owed is computed
                    // from what the client actually paid.
                    await dbRun("UPDATE bookings SET status = 'CANCELLED', cancelled_at = CURRENT_TIMESTAMP WHERE id = ?", [bookingId]);

                    await dbRun(`INSERT INTO cancellations (booking_id, cancelled_by, reason, total_paid_to_date, refund_due, retention_amount, notes, admin_id, refund_status)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')
                        ON CONFLICT(booking_id) DO UPDATE SET
                            cancelled_by = excluded.cancelled_by, reason = excluded.reason,
                            total_paid_to_date = excluded.total_paid_to_date, refund_due = excluded.refund_due,
                            retention_amount = excluded.retention_amount, notes = excluded.notes,
                            admin_id = excluded.admin_id, refund_status = excluded.refund_status,
                            cancelled_at = CURRENT_TIMESTAMP`,
                        [bookingId, cancelledBy, reason || null, totalPaid, refundDue, retentionAmount, notes || null, req.session.adminId]);

                    await dbRun(
                        `INSERT INTO audit_log (table_name, record_id, action, old_values, new_values, changed_by, change_timestamp)
                         VALUES ('bookings', ?, 'CANCEL', ?, ?, ?, CURRENT_TIMESTAMP)`,
                        [bookingId,
                         JSON.stringify({ status: booking.status, payment_status: booking.payment_status }),
                         JSON.stringify({ status: 'CANCELLED', cancelled_by: cancelledBy, reason: reason || null, refund_due: refundDue, retention: retentionAmount, policy_rule: policyRule }),
                         req.session.adminId || 'admin']);

                    // Release date holds
                    await dbRun("UPDATE date_holds SET status = 'released' WHERE converted_to_booking_id = ?", [bookingId]);
                    // Cascade: void open invoices so admin stops chasing payment
                    await dbRun("UPDATE invoices SET status='VOID', void_reason='booking_cancelled', voided_at=CURRENT_TIMESTAMP WHERE booking_id=? AND status NOT IN ('VOID','PAID')", [bookingId]);
                    // Cascade: cancel pending payment schedule items
                    await dbRun("UPDATE payment_schedules SET status='cancelled', updated_at=CURRENT_TIMESTAMP WHERE booking_id=? AND status='pending'", [bookingId]);
                    // Cascade: delink events so they don't appear as booking-linked
                    await dbRun("UPDATE events SET booking_id=NULL WHERE booking_id=?", [bookingId]);

                    await dbRun("COMMIT");
                    return { ok: true };
                } catch (txErr) {
                    await dbRun("ROLLBACK").catch(() => {});
                    console.error('[Cancel] Cancellation failed — rolled back, booking unchanged:', txErr.message);
                    return { status: 500, body: { success: false, message: txErr.message } };
                }
            });

            if (!outcome.ok) return res.status(outcome.status).json(outcome.body);

            // ---- Side effects, after the commit ----
            // Remove Google Calendar event so date shows as available
            if (booking.google_event_id) {
                deleteGoogleEvent(booking.google_event_id).catch(calErr => {
                    console.error(`[Cancel] Google Calendar event removal failed for booking #${bookingId}:`, calErr.message);
                });
            }
            booking.name = booking.client_name || booking.name;
            booking.email = booking.client_email || booking.email;
            // SC-3: Pass policy rule + timing so client knows what was applied
            try { await sendCancellationEmail(booking, { reason, refund_due: refundDue, rule: policyRule, days_until_event: calc.daysUntilEvent, is_force_majeure: isForceMajeure }); }
            catch (e) { console.error('Cancellation email failed:', e.message); }
            res.json({ success: true, message: 'Booking cancelled and client notified.', refund_due: refundDue, rule: policyRule });
        });
    });
});

/**
 * POST /api/admin/bookings/:id/complete
 * Mark a CONFIRMED booking as COMPLETED and notify the client.
 */
app.post('/api/admin/bookings/:id/complete', requireAdmin, (req, res) => {
    const bookingId = req.params.id;
    db.get("SELECT * FROM bookings WHERE id = ?", [bookingId], (err, booking) => {
        if (err || !booking) return res.status(404).json({ success: false, message: 'Booking not found.' });
        if (booking.status !== 'CONFIRMED') {
            return res.status(400).json({ success: false, message: `Only CONFIRMED bookings can be marked complete (current: ${booking.status}).` });
        }
        const outstanding = parseFloat(booking.amount_outstanding) || 0;
        const force = req.body && req.body.force === true;
        if (outstanding > 0 && !force) {
            return res.status(400).json({
                success: false,
                message: `Cannot complete: outstanding balance of R${outstanding.toFixed(2)} remains. Settle payment first, or pass force:true to override.`,
                amount_outstanding: outstanding
            });
        }
        db.run("UPDATE bookings SET status = 'COMPLETED', completed_at = CURRENT_TIMESTAMP WHERE id = ?", [bookingId], async function(upErr) {
            if (upErr) return res.status(500).json({ success: false, error: upErr.message });
            db.run(
                `INSERT INTO audit_log (table_name, record_id, action, old_values, new_values, changed_by, change_timestamp)
                 VALUES ('bookings', ?, 'COMPLETE', ?, ?, ?, CURRENT_TIMESTAMP)`,
                [bookingId,
                 JSON.stringify({ status: booking.status }),
                 JSON.stringify({ status: 'COMPLETED', forced: force || false }),
                 req.session.adminId || 'admin'],
                (aErr) => { if (aErr) console.error('[Audit] Completion log failed:', aErr.message); }
            );
            booking.name  = booking.client_name  || booking.name;
            booking.email = booking.client_email || booking.email;
            sendBookingCompletedEmail(booking).catch(e => console.error('Completed email failed:', e.message));
            // Advance linked event to 'completed' status
            if (booking.event_id) {
                db.run("UPDATE events SET event_status = 'completed', modified_on = CURRENT_TIMESTAMP WHERE event_id = ? AND event_status NOT IN ('cancelled', 'completed')",
                    [booking.event_id],
                    (evErr) => { if (evErr) console.error('[Complete] Event status advance failed:', evErr.message); }
                );
            }
            res.json({ success: true, message: 'Booking marked as completed and client notified.' });
        });
    });
});

/**
 * PUT /api/admin/bookings/:id/refund
 * Record that a refund has been issued for a cancelled booking.
 */
app.put('/api/admin/bookings/:id/refund', requireAdmin, requireRole(['administrator', 'manager']), (req, res) => {
    const { refund_amount, refund_reference, notes } = req.body;
    const bookingId = req.params.id;
    const amt = parseFloat(refund_amount) || 0;
    
    if (amt < 0) {
        return res.status(400).json({ success: false, message: 'Refund amount cannot be negative.' });
    }
    if (amt > 0 && (!refund_reference || !refund_reference.trim())) {
        return res.status(400).json({ success: false, message: 'A payment reference (bank transaction ID or PayFast reference) is required when recording a refund. Process the bank/PayFast transfer first, then record the reference here.' });
    }

    db.get("SELECT * FROM cancellations WHERE booking_id = ?", [bookingId], (err, row) => {
        if (err || !row) return res.status(404).json({ success: false, message: 'No cancellation record found for this booking.' });

        // Validation: Can't refund more than what was paid
        if (amt > row.total_paid_to_date) {
            return res.status(400).json({ success: false, message: `Refund amount (R${amt.toFixed(2)}) exceeds total paid (R${row.total_paid_to_date.toFixed(2)}).` });
        }

        db.run(
            `UPDATE cancellations SET refund_status = 'processed', refund_amount = ?, refund_reference = ?, refund_notes = ?, refunded_at = CURRENT_TIMESTAMP WHERE booking_id = ?`,
            [amt, refund_reference || null, notes || null, bookingId],
            function(upErr) {
                if (upErr) return res.status(500).json({ success: false, error: upErr.message });

                // P2-11: Record refund transaction first, then recalculate amount_paid from
                // SUM(transactions) to avoid ledger drift from arithmetic operations.
                db.run(`INSERT INTO transactions (booking_id, amount, transaction_date, payment_method, reference, transaction_type, status, notes, source)
                        VALUES (?, ?, DATE('now'), 'bank_transfer', ?, 'refund', 'completed', ?, 'admin_refund')`,
                    [bookingId, amt, refund_reference || null, notes || `Refund for cancellation of Booking #${bookingId}`],
                    function(tErr) {
                        if (tErr) console.error('[Refund] Transaction log failed:', tErr.message);

                        db.run(`UPDATE bookings SET
                            amount_paid = MAX(0, (
                                SELECT COALESCE(SUM(CASE WHEN t.transaction_type IN ('refund','chargeback') THEN -t.amount ELSE t.amount END), 0)
                                FROM transactions t WHERE t.booking_id = bookings.id
                                  AND t.is_duplicate = 0 AND (t.status = 'completed' OR t.status IS NULL)
                            )),
                            amount_outstanding = MAX(0, COALESCE(total_amount, 0) - MAX(0, (
                                SELECT COALESCE(SUM(CASE WHEN t.transaction_type IN ('refund','chargeback') THEN -t.amount ELSE t.amount END), 0)
                                FROM transactions t WHERE t.booking_id = bookings.id
                                  AND t.is_duplicate = 0 AND (t.status = 'completed' OR t.status IS NULL)
                            )))
                            WHERE id = ?`, [bookingId], function(bErr) {
                            if (bErr) console.error('[Refund] Ledger recalculation failed:', bErr.message);

                            db.run(`INSERT OR IGNORE INTO audit_log (table_name, record_id, action, new_values) VALUES ('cancellations', ?, 'REFUND_ISSUED', ?)`,
                                [bookingId, JSON.stringify({ refund_amount: amt, refund_reference })]);

                            // Re-derive payment_status from the recomputed ledger. This route recomputed
                            // amount_paid/amount_outstanding but left payment_status stale, so a fully
                            // refunded booking stayed marked PAID. Same derivation the /transactions/manual
                            // refund branch uses. (trg_auto_payment_status only ever forces PAID when
                            // outstanding hits 0, so it cannot demote a refunded booking on its own.)
                            db.get("SELECT * FROM bookings WHERE id = ?", [bookingId], (bErr2, bRow) => {
                                if (bErr2 || !bRow) {
                                    return res.json({ success: true, message: `Refund of R${amt.toFixed(2)} recorded and transaction logged.` });
                                }
                                const total = parseFloat(bRow.total_amount) || 0;
                                const newPaid = parseFloat(bRow.amount_paid) || 0;
                                let payment_status;
                                if (total > 0 && newPaid >= total)      payment_status = 'PAID';
                                else if (newPaid <= 0)                   payment_status = 'UNPAID';
                                else if (total > 0 && newPaid >= total * 0.5) payment_status = 'DEPOSIT_PAID';
                                else                                     payment_status = 'PARTIALLY_PAID';
                                db.run("UPDATE bookings SET payment_status = ? WHERE id = ?", [payment_status, bookingId],
                                    (psErr) => { if (psErr) console.error('[Refund] payment_status re-derivation failed:', psErr.message); });
                                // amount_paid dropped — re-run the milestone waterfall so covered rows
                                // that are no longer covered fall back to pending.
                                alignMilestonePayments(bookingId, newPaid, () => {});

                                sendRefundProcessedEmail(bRow, amt, refund_reference)
                                    .catch(e => console.error('[Refund] Client email failed:', e.message));
                                res.json({ success: true, message: `Refund of R${amt.toFixed(2)} recorded and transaction logged.`, payment_status });
                            });
                        });
                    });
            }
        );
    });
});

// P2.6 — Contract management (admin)
const contractUpload = multer({
    storage: multer.diskStorage({
        destination: function(req, file, cb) {
            const dir = path.join(__dirname, 'docs', 'contracts');
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            cb(null, dir);
        },
        filename: function(req, file, cb) {
            cb(null, `contract-${req.params.id}-${Date.now()}${path.extname(file.originalname)}`);
        }
    }),
    fileFilter: function(req, file, cb) {
        if (file.mimetype === 'application/pdf') {
            cb(null, true);
        } else {
            cb(new Error('Only PDF files are accepted for contract uploads.'), false);
        }
    },
    limits: { fileSize: 10 * 1024 * 1024 }
});

// Auto-generate a branded booking contract PDF from booking data (mirrors generateInvoice).
// Saves as a DRAFT; never overwrites a signed/frozen contract. Returns { success, contract } or { skipped }.
async function generateContract(bookingId) {
    const existing = await new Promise(r => db.get("SELECT status, is_frozen FROM contracts WHERE booking_id = ?", [bookingId], (e, row) => r(row || null)));
    if (existing && (existing.status === 'signed' || existing.is_frozen === 1)) {
        return { skipped: true, reason: 'signed' };
    }

    const booking = await new Promise((res, rej) => db.get(
        `SELECT b.*, c.vat_number AS client_vat_number FROM bookings b LEFT JOIN clients c ON b.client_id = c.id WHERE b.id = ?`,
        [bookingId], (e, row) => e ? rej(e) : (row ? res(row) : rej(new Error('Booking not found')))));

    const vatRate = await getVatRate();

    // Resolve line items + fee the same way generateInvoice does (quotations → quote_line_items, fallback quote_details).
    const activeQuote = await new Promise(r => db.get(
        `SELECT * FROM quotations WHERE booking_id = ? AND archived = 0 AND status NOT IN ('void','archived') ORDER BY version DESC LIMIT 1`,
        [bookingId], (e, row) => r(e ? null : row)));

    let items = [];
    let quoteData = {};
    try { quoteData = JSON.parse(booking.quote_details || '{}'); } catch (ex) {}
    if (activeQuote) {
        const qLines = await new Promise(r => db.all("SELECT * FROM quote_line_items WHERE quotation_id = ? ORDER BY id ASC",
            [activeQuote.id], (e, rows) => r(e ? [] : (rows || []))));
        if (qLines.length) items = qLines.map(li => ({ description: li.description, quantity: parseFloat(li.quantity) || 1, unit_price: parseFloat(li.unit_price) || 0, service_id: li.service_id }));
    }
    if (items.length === 0 && Array.isArray(quoteData.items)) items = quoteData.items;
    await resolveLineTaxClasses(items);
    const applyVat = !!quoteData.apply_vat;
    const discount = parseFloat(quoteData.discount) || 0;

    let total;
    if (items.length > 0) {
        total = computeDocumentTotals(items, { discount, applyVat, vatRate }).total;
    } else {
        const subtotal = parseFloat((booking.quote_amount || '0').replace(/[^0-9.]/g, '')) || parseFloat(booking.total_amount) || 0;
        total = subtotal;
        items = [{ description: 'Performance Booking Service', quantity: 1, unit_price: subtotal }];
    }

    const schedules = await new Promise(r => db.all(
        "SELECT description, due_date, expected_amount FROM payment_schedules WHERE booking_id = ? AND LOWER(COALESCE(status,'pending')) NOT IN ('superseded','cancelled') ORDER BY due_date ASC",
        [bookingId], (e, rows) => r(e ? [] : (rows || []))));

    const policyRows = await new Promise(r => db.all("SELECT policy_key, policy_value FROM policies", [], (e, rows) => r(e ? [] : (rows || []))));
    const policies = {};
    policyRows.forEach(p => { policies[p.policy_key] = p.policy_value; });

    const contractNo = `AGR-${moment().format('YYYY')}-${String(bookingId).padStart(4, '0')}`;
    const pdfFileName = `${contractNo}-${moment().format('YYYYMMDDHHmmss')}.pdf`;
    const contractsDir = path.join(__dirname, 'docs', 'contracts');
    if (!fs.existsSync(contractsDir)) fs.mkdirSync(contractsDir, { recursive: true });
    const pdfPath = path.join(contractsDir, pdfFileName);

    await pdfService.generateContract(booking, items, pdfPath, { policies, schedules, totals: { total, applyVat }, contractNo });

    const contentHash = crypto.createHash('sha256')
        .update(`${bookingId}|${total}|${contractNo}|${policies.cancellation_policy || ''}|${policies.payment_terms || ''}`)
        .digest('hex');

    await new Promise((res, rej) => db.run(
        `INSERT INTO contracts (booking_id, template_version, pdf_url, content_hash, status, uploaded_by, updated_at)
         VALUES (?, 'auto-v1', ?, ?, 'draft', 'system', CURRENT_TIMESTAMP)
         ON CONFLICT(booking_id) DO UPDATE SET
            pdf_url = excluded.pdf_url,
            template_version = excluded.template_version,
            content_hash = excluded.content_hash,
            status = 'draft',
            uploaded_by = 'system',
            is_frozen = 0,
            updated_at = CURRENT_TIMESTAMP`,
        [bookingId, pdfFileName, contentHash], (e) => e ? rej(e) : res()));

    db.run(`INSERT INTO audit_log (table_name, record_id, action, changed_by, changes_json) VALUES ('contracts', ?, 'GENERATE', 'system', ?)`,
        [bookingId, JSON.stringify({ file: pdfFileName, contract_no: contractNo, status: 'draft' })], () => {});

    const row = await new Promise(r => db.get("SELECT * FROM contracts WHERE booking_id = ?", [bookingId], (e, r2) => r(r2 || null)));
    return { success: true, contract: row };
}

// POST — auto-generate a booking contract PDF (admin, on demand). Signed contracts are protected.
app.post('/api/admin/bookings/:id/contract/generate', requireAdmin, async (req, res) => {
    try {
        const result = await generateContract(req.params.id);
        if (result.skipped) {
            return res.status(400).json({ success: false, message: 'This contract has already been signed and cannot be regenerated. Create a separate amendment instead.' });
        }
        res.json({ success: true, message: 'Contract generated.', contract: result.contract });
    } catch (e) {
        console.error('[Contract Generate] Failed for booking #' + req.params.id + ':', e.message);
        res.status(500).json({ success: false, message: 'Failed to generate contract: ' + e.message });
    }
});

// GET — fetch contract details for a booking
app.get('/api/admin/bookings/:id/contract', requireAdmin, (req, res) => {
    db.get("SELECT * FROM contracts WHERE booking_id = ?", [req.params.id], (err, row) => {
        if (err) return res.status(500).json({ success: false, message: err.message });
        res.json({ success: true, contract: row || null });
    });
});

// POST — upload a contract PDF
app.post('/api/admin/bookings/:id/contract', requireAdmin, (req, res, next) => {
    contractUpload.single('contract_file')(req, res, function(err) {
        if (err) {
            // multer fileFilter error — return clear 400
            return res.status(400).json({ success: false, message: err.message || 'Invalid file. Only PDF files are accepted.' });
        }
        next();
    });
}, (req, res) => {
    if (!req.file) return res.status(400).json({ success: false, message: 'A PDF file is required. Only .pdf files are accepted.' });
    const bookingId = req.params.id;
    const pdfUrl = req.file.filename;
    const templateVersion = (req.body.template_version || '1.0').substring(0, 20);
    const uploadedBy = req.session.username || 'system';

    db.get("SELECT status, is_frozen, signed_by, signed_date FROM contracts WHERE booking_id = ?", [bookingId], (selErr, existing) => {
        if (existing && (existing.status === 'signed' || existing.is_frozen === 1)) {
            return res.status(400).json({
                success: false,
                message: `Cannot overwrite: this contract was already signed by "${existing.signed_by}" on ${existing.signed_date}. You cannot replace a signed contract — create a separate amendment instead.`
            });
        }

        const previousStatus = existing ? existing.status : null;

        db.run(
            `INSERT INTO contracts (booking_id, template_version, pdf_url, status, uploaded_by, updated_at)
             VALUES (?, ?, ?, 'draft', ?, CURRENT_TIMESTAMP)
             ON CONFLICT(booking_id) DO UPDATE SET
                pdf_url = excluded.pdf_url,
                template_version = excluded.template_version,
                status = 'draft',
                uploaded_by = excluded.uploaded_by,
                is_frozen = 0,
                updated_at = CURRENT_TIMESTAMP`,
            [bookingId, templateVersion, pdfUrl, uploadedBy], function(err) {
                if (err) return res.status(500).json({ success: false, message: err.message });

                db.run(
                    `INSERT INTO audit_log (table_name, record_id, action, changed_by, changes_json)
                     VALUES ('contracts', ?, 'UPLOAD', ?, ?)`,
                    [bookingId, uploadedBy, JSON.stringify({ file: pdfUrl, status: 'draft', previous_status: previousStatus })],
                    () => {}
                );

                res.json({ success: true, message: 'Contract uploaded successfully.', filename: pdfUrl, uploaded_by: uploadedBy });
            }
        );
    });
});

// PUT — mark a contract as signed
app.put('/api/admin/bookings/:id/contract/sign', requireAdmin, (req, res) => {
    const bookingId = req.params.id;
    const signatoryName = (req.body.signatory_name || '').trim().substring(0, 120);
    const signedDate = (req.body.signed_date || new Date().toISOString().split('T')[0]);
    const signedBy = req.session.username || 'system';

    if (!signatoryName) {
        return res.status(400).json({ success: false, message: 'Signatory name is required to mark as signed.' });
    }

    const forceCountersign = req.body && req.body.force === true;
    db.get("SELECT status, is_frozen, signed_by_client_at FROM contracts WHERE booking_id = ?", [bookingId], (checkErr, existing) => {
        if (checkErr) return res.status(500).json({ success: false, message: checkErr.message });
        if (!existing) return res.status(404).json({ success: false, message: 'No contract found for this booking. Upload a PDF first.' });
        if (existing.is_frozen === 1 || existing.status === 'signed') {
            return res.status(400).json({ success: false, message: 'This contract has already been signed and cannot be re-signed.' });
        }
        // Two-party model: the client signs online first, then the admin/comedian countersigns to
        // finalise. Block the countersign until the client has signed, unless explicitly overridden.
        if (!existing.signed_by_client_at && !forceCountersign) {
            return res.status(400).json({
                success: false,
                requires_client_signature: true,
                message: 'The client has not signed this contract yet. Send it for signing first, or pass { force: true } to countersign anyway.'
            });
        }

        db.run(
            `UPDATE contracts
             SET signed_by_comedian_at = CURRENT_TIMESTAMP,
                 signed_by = ?,
                 signed_date = ?,
                 status = 'signed',
                 is_frozen = 1,
                 updated_at = CURRENT_TIMESTAMP
             WHERE booking_id = ?`,
            [signatoryName, signedDate, bookingId], function(err) {
                if (err || this.changes === 0) {
                    return res.status(404).json({ success: false, message: err ? err.message : 'No contract found for this booking. Upload a PDF first.' });
                }

                // Audit log
                db.run(
                    `INSERT INTO audit_log (table_name, record_id, action, changed_by, changes_json)
                     VALUES ('contracts', ?, 'SIGN', ?, ?)`,
                    ['contracts', bookingId, 'SIGN', signedBy, JSON.stringify({ signed_by: signatoryName, signed_date: signedDate })],
                    () => {}
                );

                res.json({ success: true, message: 'Contract marked as signed.', signed_by: signatoryName, signed_date: signedDate });
            }
        );
    });
});

// GET — download the contract PDF
app.get('/api/admin/bookings/:id/contract/download', requireAdmin, (req, res) => {
    db.get("SELECT pdf_url FROM contracts WHERE booking_id = ?", [req.params.id], (err, row) => {
        if (err || !row || !row.pdf_url) return res.status(404).json({ success: false, message: 'No contract on file for this booking.' });
        const filePath = path.join(__dirname, 'docs', 'contracts', row.pdf_url);
        if (!fs.existsSync(filePath)) return res.status(404).json({ success: false, message: 'Contract file not found on server. It may have been deleted.' });
        res.download(filePath, row.pdf_url, (dlErr) => {
            if (dlErr) console.error('[Contract Download Error]', dlErr.message);
        });
    });
});

// POST — send the generated contract to the client for online signing.
// Draft-only generation means this is the explicit "deliver it" step; it stamps sent_to_client_at
// and advances draft -> sent so the client tracking page exposes the review-and-sign flow.
app.post('/api/admin/bookings/:id/contract/send', requireAdmin, mutateRateLimiter, (req, res) => {
    const bookingId = req.params.id;
    db.get(`SELECT b.id, b.name, COALESCE(c.email, b.email) AS email, b.event_name, b.event_type, b.date
            FROM bookings b LEFT JOIN clients c ON b.client_id = c.id WHERE b.id = ?`, [bookingId], (err, booking) => {
        if (err || !booking) return res.status(404).json({ success: false, message: 'Booking not found.' });
        db.get("SELECT pdf_url, status, is_frozen FROM contracts WHERE booking_id = ?", [bookingId], async (cErr, contract) => {
            if (cErr) return res.status(500).json({ success: false, message: cErr.message });
            if (!contract || !contract.pdf_url) return res.status(404).json({ success: false, message: 'No contract on file. Generate or upload one first.' });
            if (contract.status === 'signed' || contract.is_frozen === 1) {
                return res.status(400).json({ success: false, message: 'This contract is already signed and finalised.' });
            }
            const pdfPath = path.join(__dirname, 'docs', 'contracts', contract.pdf_url);
            if (!fs.existsSync(pdfPath)) return res.status(404).json({ success: false, message: 'Contract file not found on server. Regenerate it first.' });

            try {
                await sendContractEmail(booking, pdfPath);
            } catch (e) {
                console.error('[Contract Send] email failed for booking #' + bookingId + ':', e.message);
                return res.status(500).json({ success: false, message: 'Could not email the contract: ' + e.message });
            }
            // Only advance a draft to sent; a re-send of an already-sent (possibly client-signed)
            // contract just refreshes the timestamp without downgrading its status.
            db.run(
                `UPDATE contracts SET status = CASE WHEN status = 'draft' THEN 'sent' ELSE status END,
                        sent_to_client_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
                 WHERE booking_id = ?`,
                [bookingId],
                (uErr) => {
                    if (uErr) console.error('[Contract Send] status update failed:', uErr.message);
                    db.run(`INSERT INTO audit_log (table_name, record_id, action, changed_by, changes_json)
                            VALUES ('contracts', ?, 'SENT', ?, ?)`,
                        [bookingId, req.session.username || 'admin', JSON.stringify({ to: booking.email })], () => {});
                    res.json({ success: true, message: 'Contract sent to the client for signing.' });
                }
            );
        });
    });
});

// Gap 8: POST — send contract signature reminder email to client
app.post('/api/admin/bookings/:id/contract/remind', requireAdmin, mutateRateLimiter, (req, res) => {
    const bookingId = req.params.id;
    db.get(`SELECT id, name, email, event_name, date FROM bookings WHERE id = ?`, [bookingId], (err, b) => {
        if (err || !b) return res.status(404).json({ success: false, message: 'Booking not found.' });

        // Idempotency: this route wrote nothing and had no throttle, so the reminder could be sent
        // repeatedly. contracts.sent_to_client_at is the natural "last contacted about signing"
        // timestamp and was never populated; use it to refuse a repeat within 24h and to record sends.
        db.get("SELECT sent_to_client_at FROM contracts WHERE booking_id = ?", [bookingId], (cErr, contract) => {
            const lastSent = contract && contract.sent_to_client_at ? moment(contract.sent_to_client_at) : null;
            if (lastSent && moment().diff(lastSent, 'hours') < 24 && !(req.body && req.body.force === true)) {
                return res.status(429).json({
                    success: false,
                    message: `A contract reminder was already sent on ${lastSent.format('YYYY-MM-DD HH:mm')}. Wait 24 hours, or resend with { force: true }.`,
                    last_sent_at: contract.sent_to_client_at
                });
            }

            getEmailFooterContext().then(async ({ socialLinks }) => {
                const banner = await bannerRegistry.resolveBanner('contract_sign_reminder');
                return sendEmail({
                    to: b.email,
                    subject: `Action Required: Please sign your booking contract — ${b.event_name}`,
                    htmlContent: emailComponents.renderPremiumEmail({
                        preheaderText: `Your booking contract for ${b.event_name} is awaiting your signature.`,
                        bannerSrc: banner?.src, bannerAlt: banner?.alt, subtitle: banner?.subtitle,
                        headline: banner?.headline || 'Contract Signature Reminder',
                        greeting: `Hi ${b.name},`,
                        bodyHtml:
                            `A friendly reminder that your booking contract for <strong style="color:#FAFAFA;">${b.event_name}</strong> on ${b.date} is awaiting your signature.` +
                            `<p style="margin:10px 0 0; color:#E6E6E6;">Please contact us at your earliest convenience to arrange signing.</p>`,
                        socialLinks
                    }),
                    preWrapped: true,
                    titleOverride: 'Contract Signature Reminder',
                    trigger_event: 'Admin: Contract Remind'
                });
            }).then(() => {
                // Only stamp a contract row that already exists; the reminder can predate the upload.
                db.run("UPDATE contracts SET sent_to_client_at = CURRENT_TIMESTAMP WHERE booking_id = ?", [bookingId],
                    (uErr) => { if (uErr) console.error('[Contract Remind] timestamp update failed:', uErr.message); });
                res.json({ success: true, message: 'Reminder sent.' });
            }).catch(e => res.status(500).json({ success: false, message: e.message }));
        });
    });
});

// State-aware per-booking reminder. Picks the reminder appropriate to where the booking is in the
// lifecycle and returns what it did. Shared by the single-booking route and the bulk action.
// Throttling reuses existing state: the contract reminder is gated by contracts.sent_to_client_at,
// the balance reminder by a reminders_log row (schedule_id NULL, days_before=0 sentinel — distinct
// from the 7/3/1 pre-event reminders and the milestone reminders which carry a non-NULL schedule_id).
async function remindBooking(bookingId) {
    const b = await dbGet(
        `SELECT b.id, COALESCE(c.full_name, b.name) AS name, COALESCE(c.email, b.email) AS email,
                b.event_name, b.event_type, b.date, b.status, b.amount_outstanding, b.quote_expiry_date
         FROM bookings b LEFT JOIN clients c ON b.client_id = c.id WHERE b.id = ?`, [bookingId]);
    if (!b) return { booking_id: bookingId, sent: false, skipped: 'not found' };

    const status = (b.status || '').toUpperCase();
    const todayLocal = moment().tz('Africa/Johannesburg').format('YYYY-MM-DD');

    // 1. QUOTED and not expired → quote follow-up.
    if (status === 'QUOTED' && (!b.quote_expiry_date || b.quote_expiry_date >= todayLocal)) {
        await sendQuoteExpiryWarningEmail(b);
        return { booking_id: bookingId, sent: true, type: 'quote' };
    }

    // 2. Committed with a contract sent but not yet client-signed → contract signing reminder.
    if (['ACCEPTED', 'CONFIRMED'].includes(status)) {
        const contract = await dbGet("SELECT status, is_frozen, sent_to_client_at, signed_by_client_at FROM contracts WHERE booking_id = ?", [bookingId]);
        if (contract && contract.status === 'sent' && !contract.signed_by_client_at && contract.is_frozen !== 1) {
            const last = contract.sent_to_client_at ? moment(contract.sent_to_client_at) : null;
            if (last && moment().diff(last, 'hours') < 24) return { booking_id: bookingId, sent: false, skipped: 'contract reminded <24h ago' };
            const { socialLinks: remindSocialLinks } = await getEmailFooterContext();
            const remindBanner = await bannerRegistry.resolveBanner('contract_sign_reminder');
            await sendEmail({
                to: b.email,
                subject: `Action Required: Please sign your booking contract — ${b.event_name || b.event_type}`,
                htmlContent: emailComponents.renderPremiumEmail({
                    preheaderText: `Your booking contract for ${b.event_name || b.event_type} is awaiting your signature.`,
                    bannerSrc: remindBanner?.src, bannerAlt: remindBanner?.alt, subtitle: remindBanner?.subtitle,
                    headline: remindBanner?.headline || 'Contract Signature Reminder',
                    greeting: `Hi ${b.name},`,
                    bodyHtml:
                        `A friendly reminder that your booking contract for <strong style="color:#FAFAFA;">${b.event_name || b.event_type}</strong> on ${b.date} is awaiting your signature. You can review and sign it from your booking page.`,
                    cta: { label: 'Review & Sign Contract', url: `${emailBaseUrl()}/?track=${bookingId}&email=${encodeURIComponent(b.email)}` },
                    socialLinks: remindSocialLinks
                }),
                preWrapped: true,
                titleOverride: 'Contract Signature Reminder',
                trigger_event: 'Admin: Contract Remind'
            });
            await dbRun("UPDATE contracts SET sent_to_client_at = CURRENT_TIMESTAMP WHERE booking_id = ?", [bookingId]);
            return { booking_id: bookingId, sent: true, type: 'contract' };
        }
    }

    // 3. CONFIRMED with an outstanding balance → balance-due reminder.
    if (status === 'CONFIRMED' && (parseFloat(b.amount_outstanding) || 0) > 0.01) {
        const recent = await dbGet(
            "SELECT id FROM reminders_log WHERE booking_id = ? AND schedule_id IS NULL AND days_before = 0 AND sent_at > datetime('now','-24 hours')",
            [bookingId]);
        if (recent) return { booking_id: bookingId, sent: false, skipped: 'balance reminded <24h ago' };
        await sendDepositBalanceDueEmail(b, b.amount_outstanding);
        await dbRun(
            "INSERT INTO reminders_log (booking_id, schedule_id, days_before, due_date, amount_due, recipient_email, status) VALUES (?, NULL, 0, ?, ?, ?, 'sent')",
            [bookingId, b.date || todayLocal, b.amount_outstanding, b.email]);
        return { booking_id: bookingId, sent: true, type: 'balance' };
    }

    return { booking_id: bookingId, sent: false, skipped: 'nothing due' };
}

// POST — send the state-appropriate reminder for one booking.
app.post('/api/admin/bookings/:id/remind', requireAdmin, async (req, res) => {
    try {
        const result = await remindBooking(req.params.id);
        res.json({ success: true, ...result });
    } catch (e) {
        console.error('[Remind] failed for booking #' + req.params.id + ':', e.message);
        res.status(500).json({ success: false, message: e.message });
    }
});

// POST — bulk "Send reminder": each selected booking gets the reminder appropriate to its state.
app.post('/api/admin/bookings/bulk-remind', requireAdmin, requireRole(['administrator', 'manager']), async (req, res) => {
    const ids = Array.isArray(req.body.ids) ? req.body.ids.map(n => parseInt(n, 10)).filter(n => !isNaN(n)) : [];
    if (ids.length === 0) return res.status(400).json({ success: false, message: 'No bookings selected.' });
    if (ids.length > 200) return res.status(400).json({ success: false, message: 'Too many bookings selected (max 200).' });

    let sent = 0, skipped = 0, failed = 0;
    const breakdown = { quote: 0, contract: 0, balance: 0 };
    const errors = [];
    for (const id of ids) {
        try {
            const r = await remindBooking(id);
            if (r.sent) { sent++; if (breakdown[r.type] !== undefined) breakdown[r.type]++; }
            else skipped++;
        } catch (e) { failed++; errors.push(`#${id}: ${e.message}`); }
    }
    res.json({ success: true, sent, skipped, failed, breakdown, errors: errors.length ? errors : undefined });
});

// PUBLIC — client e-signs the contract online (typed-name acknowledgement, two-party model).
// Email-verified like accept-quote (Gap 1 accepted risk). Records the client signature; the admin
// then countersigns via PUT /contract/sign to finalise. The contract PDF is already served
// statically, so this endpoint only captures intent + attribution.
app.post('/api/public/bookings/:id/contract/sign', mutateRateLimiter, ipRateLimiter, (req, res) => {
    const bookingId = req.params.id;
    const email = asBookingText(req.body.email);
    const signatoryName = asBookingText(req.body.signatory_name);
    const agreed = req.body.agreed === true || req.body.agreed === 'true';

    if (!email) return res.status(400).json({ success: false, message: 'Email is required.' });
    if (!agreed) return res.status(400).json({ success: false, message: 'You must confirm your agreement to sign.' });
    if (signatoryName.length < 2 || signatoryName.length > 120) {
        return res.status(400).json({ success: false, message: 'Please enter your full legal name.' });
    }
    const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || 'unknown';

    db.get("SELECT id, email FROM bookings WHERE id = ?", [bookingId], (err, booking) => {
        if (err || !booking) return res.status(404).json({ success: false, message: 'Booking not found.' });
        if ((booking.email || '').trim().toLowerCase() !== email.trim().toLowerCase()) {
            return res.status(401).json({ success: false, message: 'Email does not match our records.' });
        }
        db.get("SELECT status, is_frozen, signed_by_client_at FROM contracts WHERE booking_id = ?", [bookingId], (cErr, contract) => {
            if (cErr) return res.status(500).json({ success: false, message: cErr.message });
            if (!contract) return res.status(404).json({ success: false, message: 'No contract is available for this booking yet.' });
            if (contract.is_frozen === 1 || contract.status === 'signed') {
                return res.status(400).json({ success: false, message: 'This contract has already been finalised.' });
            }
            if (contract.status !== 'sent') {
                return res.status(400).json({ success: false, message: 'This contract is not ready for signing yet. Please wait for it to be sent to you.' });
            }
            if (contract.signed_by_client_at) {
                return res.status(409).json({ success: false, message: 'You have already signed this contract. It is now awaiting our countersignature.' });
            }

            // Signature = intent + attribution. Store the typed name, server-stamped time, IP and UA.
            const signatureData = JSON.stringify({
                name: signatoryName,
                signed_at: new Date().toISOString(),
                ip: clientIp,
                user_agent: (req.headers['user-agent'] || '').slice(0, 300)
            });
            db.run(
                `UPDATE contracts
                 SET client_signature_data = ?, signed_by_client_at = CURRENT_TIMESTAMP, client_ip_address = ?, updated_at = CURRENT_TIMESTAMP
                 WHERE booking_id = ? AND signed_by_client_at IS NULL`,
                [signatureData, clientIp, bookingId],
                function (uErr) {
                    if (uErr) return res.status(500).json({ success: false, message: uErr.message });
                    if (this.changes === 0) {
                        return res.status(409).json({ success: false, message: 'You have already signed this contract.' });
                    }
                    db.run(`INSERT INTO audit_log (table_name, record_id, action, new_values, changed_by, ip_address)
                            VALUES ('contracts', ?, 'CLIENT_SIGNED', ?, ?, ?)`,
                        [bookingId, JSON.stringify({ signatory_name: signatoryName }), email, clientIp], () => {});
                    // Notify the admin that the client signed and a countersignature is due.
                    getNotificationEmail().then(notifEmail => notifEmail && sendEmail({
                        to: notifEmail,
                        subject: `Contract signed by client — Booking #${bookingId}`,
                        htmlContent: emailComponents.renderSystemEmail({
                            preheaderText: `${signatoryName} signed the contract for booking #${bookingId} — countersignature due.`,
                            category: 'Contracts & Signatures',
                            severity: 'action',
                            leadFact: `<strong style="color:#FAFAFA;">${emailComponents.esc(signatoryName)}</strong> has signed the contract for booking <strong style="color:#FAFAFA;">#${bookingId}</strong> online.`,
                            bodyHtml: `<p style="margin:0; color:#E6E6E6;">Log in to the admin panel to countersign and finalise it.</p>`
                        }),
                        preWrapped: true,
                        titleOverride: 'Client Signed Contract',
                        trigger_event: 'Admin: Client Signed Contract'
                    })).catch(() => {});
                    res.json({ success: true, message: 'Thank you — your signature has been recorded. Our team will countersign to finalise the contract.' });
                }
            );
        });
    });
});

// Gap 10: GET — fetch outgoing communication log for a booking
app.get('/api/admin/bookings/:id/communications', requireAdmin, (req, res) => {
    db.all(
        `SELECT id, direction, channel, subject, content_snippet, sent_at, created_at
         FROM communication_log WHERE booking_id = ? ORDER BY created_at DESC LIMIT 50`,
        [req.params.id],
        (err, rows) => res.json({ success: !err, logs: rows || [] })
    );
});

// Gap 11: POST — manually re-sync a booking to Google Calendar
app.post('/api/admin/bookings/:id/sync-calendar', requireAdmin, async (req, res) => {
    try {
        await syncBookingToCalendar(parseInt(req.params.id, 10));
        res.json({ success: true, message: 'Booking synced to Google Calendar.' });
    } catch (err) {
        console.error('[Calendar Sync]', err.message);
        res.status(500).json({ success: false, message: err.message });
    }
});

app.post('/send-email', ipRateLimiter, bookingRateLimiter, async (req, res) => {
    console.log('[DEBUG] /send-email body:', req.body);
    let { name, email, cell, category, subject, message, recipientEmail, popia_consent } = req.body;

    
    // Sanitize subject and email to prevent header injection
    name = sanitizeEmailInput(name);
    email = sanitizeEmailInput(email);
    subject = sanitizeEmailInput(subject);
    recipientEmail = sanitizeEmailInput(recipientEmail);

    if (!name || !email || !message) {
        return res.status(400).json({ success: false, message: 'Name, email, and message are required.' });
    }
    if (subject && subject.trim().length < 3) {
        return res.status(400).json({ success: false, message: 'Subject must be at least 3 characters.' });
    }

    // Manual XSS Sanitization for Message (Strip HTML Tags)
    message = message.replace(/<[^>]*>?/gm, '');


    if (!popia_consent) {
        return res.status(400).json({ success: false, message: 'POPIA consent is required to submit an inquiry.' });
    }

    // Attempt to dynamically resolve the logo path to embed it.
    const logoFilePath = path.join(__dirname, 'images', 'logo4.png');

    // 0. FETCH CONFIGURED DELIVERY EMAIL FROM DB
    db.get("SELECT email FROM contact_info ORDER BY quote_id ASC LIMIT 1", [], async (err, contactRow) => {
        let configuredReceiverEmail = process.env.EMAIL_USER || 'admin@thabisomhlongo.com';
        if (!err && contactRow && contactRow.email) {
            configuredReceiverEmail = contactRow.email;
        }
        
        // Use explicitly forwarded recipientEmail from body, OR the DB configured one
        const receiver = recipientEmail || configuredReceiverEmail;

        // 1. SAVE TO DATABASE
        const isBooking = category && category.toLowerCase().includes('booking');
        
        if (isBooking) {
            // We lack specific date/event_type from the current frontend form, so we use placeholders or derivations
            db.run(`INSERT INTO bookings (name, email, cell, date, event_type, message, status, popia_consent, consent_timestamp) VALUES (?, ?, ?, ?, ?, ?, 'PENDING', 1, CURRENT_TIMESTAMP)`, 
                [name, email, cell, 'TBD', category, `${subject}\n\n${message}`], function(err) {
                    if (err) console.error("DB Insert Error (Bookings):", err);
                });
        } else {
            const ip_address = req.ip || req.connection.remoteAddress || '';
            const user_agent = req.get('User-Agent') || '';
            const routing_path = req.get('Referrer') || req.originalUrl || '';
            
            db.run(`INSERT INTO inquiries (sender_name, sender_email, receiver_email, sender_phone, category, subject, message_body, status, routing_path, ip_address, user_agent, popia_consent, consent_timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, 'unread', ?, ?, ?, 1, CURRENT_TIMESTAMP)`, 
                [encodeUserHtml(name), email, receiver, cell || '', category || 'Contact Form', encodeUserHtml(subject) || 'No Subject', encodeUserHtml(message), routing_path, ip_address, user_agent], function(err) {
                    if (err) console.error("DB Insert Error (Inquiries):", err);
                });
        }

    // 2. DISPATCH EMAIL
    const inquiryRows = [
        { label: 'Name', value: name, mono: false },
        { label: 'Email', rawValue: `<a href="mailto:${email}" style="color:#D4AF37; text-decoration:none;">${email}</a>` },
        { label: 'Phone', rawValue: cell ? `<a href="tel:${cell}" style="color:#D4AF37; text-decoration:none;">${cell}</a>` : 'N/A' },
        { label: 'Category', value: category || 'General Inquiry', mono: false, highlight: true },
        { label: 'Subject', value: subject || 'No Subject', mono: false }
    ];

    const emailBody = emailComponents.renderSystemEmail({
        preheaderText: `New website inquiry: ${subject || 'No Subject'}.`,
        category: 'Contact & Support',
        severity: 'action',
        leadFact: `You have received a new contact message through the Thabiso Mhlongo official website.`,
        bodyHtml:
            `<p style="margin:14px 0 6px; color:#D4AF37; font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:0.7px;">Message Body</p>` +
            `<div style="padding:16px; background:#1A1A1A; border-left:3px solid #D4AF37; white-space:pre-wrap; color:#E6E6E6; font-size:14px; line-height:1.6;">${message.replace(/\n/g, '<br>')}</div>` +
            `<p style="margin:16px 0 0; color:#707070; font-size:11px; text-align:center;">This email was securely dispatched and logged in the CRM database.</p>`,
        cards: [{ rows: inquiryRows }]
    });

    try {
        // 1. Notification to Admin
        await sendEmail({
            to: receiver,
            subject: `Website Inquiry: ${subject || 'No Subject'}`,
            htmlContent: emailBody,
            preWrapped: true,
            replyTo: email, // Allow admin to reply directly to the visitor
            titleOverride: 'New Website Inquiry',
            trigger_event: 'Contact Form: Admin Notification'
        });

        // 2. Receipt to Visitor
        const { socialLinks: contactSocialLinks } = await getEmailFooterContext();
        const contactBanner = await bannerRegistry.resolveBanner('contact_auto_reply');
        const visitorBody = emailComponents.renderPremiumEmail({
            preheaderText: `We've received your message — thanks for reaching out, ${name}!`,
            bannerSrc: contactBanner?.src, bannerAlt: contactBanner?.alt, subtitle: contactBanner?.subtitle,
            headline: contactBanner?.headline || "We've Received Your Message",
            greeting: `Hi ${name},`,
            bodyHtml:
                `Thank you for reaching out to Thabiso Mhlongo Management. We have successfully received your inquiry regarding <strong style="color:#D4AF37;">"${subject || 'General Inquiry'}"</strong> and our team will review it shortly.` +
                `<p style="margin:10px 0 0; color:#E6E6E6;">In the meantime, feel free to follow Thabiso on social media for the latest updates and tour dates.</p>` +
                `<p style="margin:18px 0 0; color:#B0B0B0;">Stay funny,<br><span style="font-family:'Cormorant Garamond',Georgia,serif; font-size:18px; color:#D4AF37;">Thabiso Mhlongo Management</span></p>`,
            socialLinks: contactSocialLinks
        });

        await sendEmail({
            to: email,
            subject: `Thank you for your message, ${name}!`,
            htmlContent: visitorBody,
            preWrapped: true,
            titleOverride: "We've Received Your Message!",
            trigger_event: 'Contact Form: Visitor Receipt'
        });

        console.log('Inquiry and Receipt sent successfully via Unified Service');
        res.json({ success: true, message: 'Form submitted and confirmation sent!' });
    } catch (error) {
        console.error('Error in contact form dispatch:', error);
        res.status(500).json({ success: false, message: 'Server error during dispatch.' });
    }
    }); // End DB Query Callback
});

// ==========================================
// Public Newsletter Subscribe Route
// ==========================================
app.post('/api/public/subscribe', ipRateLimiter, (req, res) => {
    const { email, popia_consent } = req.body;
    if (!email) {
        return res.status(400).json({ success: false, message: 'Email is required' });
    }
    
    // Validate POPIA consent
    if (!popia_consent) {
        return res.status(400).json({ success: false, message: 'POPIA consent is required to subscribe.' });
    }

    const ip_address = req.ip || req.connection.remoteAddress || 'unknown';
    const user_agent = req.get('User-Agent') || 'unknown';
    const source = 'index.html';
    console.log(`[Newsletter] Attempting subscription for: ${email} from ${ip_address}`);

    // Need to insert both 'status' and 'active' to maintain backwards compatibility with older schema DBs where active NOT NULL
    const unsubscribe_token = crypto.randomBytes(16).toString('hex');

    // Need to insert status, active, and unsubscribe_token
    db.run(`INSERT INTO newsletter_subscribers (email, status, active, unsubscribe_token, ip_address, user_agent, source, popia_consent, consent_timestamp, policy_version) VALUES (?, 'active', 1, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP, ?)`, 
    [email, unsubscribe_token, ip_address, user_agent, source, CURRENT_POLICY_VERSION], function(err) {
        if (err) {
            console.error("Newsletter Subscription DB Error:", err.message);
            // IF UNIQUE constraint failed, they are already subscribed. That's fine.
            if (err.message.includes('UNIQUE')) {
                 return res.status(409).json({ success: false, message: 'You are already subscribed!' });
            }
            return res.status(500).json({ success: false, message: 'Server error: ' + err.message });
        }
        console.log(`[Newsletter] DB Insert SUCCESS for: ${email}`);
        
        // --- Send Introductory Welcome Email ---
        // preWrapped bypasses sendEmailDirectly's own subscriber lookup, so build the unsubscribe
        // URL here from the token this insert just created (same host/format as the legacy path).
        (async () => {
            const { socialLinks } = await getEmailFooterContext();
            const unsubscribeUrl = `${emailBaseUrl()}/unsubscribe.html?token=${unsubscribe_token}&email=${encodeURIComponent(email)}`;
            const banner = await bannerRegistry.resolveBanner('newsletter_welcome');
            const emailBody = emailComponents.renderPremiumEmail({
                preheaderText: "You're on the list — welcome to the newsletter!",
                bannerSrc: banner?.src, bannerAlt: banner?.alt, subtitle: banner?.subtitle,
                headline: banner?.headline || "You're On The List!",
                bodyHtml:
                    `<p style="text-align:center;">Thank you for subscribing to my official newsletter. I truly appreciate your support. You will now be the first to know about my upcoming stand-up tour dates, new video releases, and exclusive content.</p>` +
                    `<p style="text-align:center; color:#B0B0B0;">Rest assured, your email address will be used responsibly and will never be shared with third parties.</p>` +
                    `<p style="text-align:center; margin-top:18px; color:#B0B0B0;">Stay funny,<br><span style="font-family:'Cormorant Garamond',Georgia,serif; font-size:18px; color:#D4AF37;">Thabiso Mhlongo</span></p>`,
                unsubscribeUrl,
                socialLinks
            });
            return sendEmail({
                to: email,
                subject: "Welcome to Thabiso Mhlongo's Newsletter!",
                htmlContent: emailBody,
                preWrapped: true,
                titleOverride: "You're on the list!",
                trigger_event: 'Newsletter: Welcome Receipt'
            });
        })().catch(e => console.error("Error sending welcome email to " + email + ":", e));

        res.json({ success: true, message: 'Subscribed successfully!' });
    });
});
// Unsubscribe API
app.post('/api/public/newsletter/unsubscribe', ipRateLimiter, (req, res) => {
    const { email, token } = req.body;
    if (!email || !token) {
        return res.status(400).json({ success: false, message: 'Missing required parameters.' });
    }

    db.get("SELECT subscriber_id FROM newsletter_subscribers WHERE LOWER(email) = LOWER(?) AND unsubscribe_token = ?", [email, token], (err, row) => {
        if (err) return res.status(500).json({ success: false, error: err.message });
        if (!row) return res.status(404).json({ success: false, message: 'Invalid unsubscription link or subscriber not found.' });

        db.run("UPDATE newsletter_subscribers SET status = 'unsubscribed', active = 0, modified_on = CURRENT_TIMESTAMP WHERE subscriber_id = ?", [row.subscriber_id], (uErr) => {
            if (uErr) return res.status(500).json({ success: false, error: uErr.message });
            res.json({ success: true, message: 'Successfully unsubscribed.' });
        });
    });
});

// GET Email Logs (Advanced: Sorting, Filtering, Searching, Pagination)
app.get('/api/admin/email-logs', requireAdmin, (req, res) => {
    const { 
        page = 1, 
        limit = 20, 
        search = '', 
        status = '', 
        trigger = '', 
        sort = 'sent_at', 
        order = 'DESC' 
    } = req.query;

    const offset = (page - 1) * limit;
    let whereClauses = [];
    let params = [];

    if (search) {
        whereClauses.push("(recipient_email LIKE ? OR subject LIKE ? OR trigger_event LIKE ?)");
        params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    if (status) {
        whereClauses.push("status = ?");
        params.push(status);
    }
    if (trigger) {
        whereClauses.push("trigger_event = ?");
        params.push(trigger);
    }

    const whereString = whereClauses.length > 0 ? "WHERE " + whereClauses.join(" AND ") : "";
    const allowedSortCols = ['sent_at', 'recipient_email', 'subject', 'status', 'trigger_event'];
    const safeSort = allowedSortCols.includes(sort) ? sort : 'sent_at';
    const safeOrder = order.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    const countQuery = `SELECT COUNT(*) as total FROM email_logs ${whereString}`;
    const dataQuery = `SELECT * FROM email_logs ${whereString} ORDER BY ${safeSort} ${safeOrder} LIMIT ? OFFSET ?`;
    
    const queryParams = [...params, parseInt(limit), parseInt(offset)];

    db.get(countQuery, params, (countErr, countRow) => {
        if (countErr) return res.status(500).json({ success: false, error: countErr.message });
        
        db.all(dataQuery, queryParams, (err, rows) => {
            if (err) return res.status(500).json({ success: false, error: err.message });
            
            // Defensive: Check both 'total' alias and default 'COUNT(*)' column names
            const rawTotal = countRow ? (countRow.total !== undefined ? countRow.total : countRow['COUNT(*)']) : 0;
            const total = parseInt(rawTotal) || 0;
            res.json({ 
                success: true, 
                logs: rows,
                total: total,
                page: parseInt(page),
                totalPages: Math.ceil(total / parseInt(limit))
            });
        });
    });
});

// Get all subscribers
app.get('/api/admin/newsletter/subscribers', requireAdmin, (req, res) => {
    const validSorts = ['newest', 'oldest', 'email_asc', 'status'];
    const page = Math.max(1, parseInt(req.query.page) || 1);
    // Honour a client-supplied limit (capped) so the "Export All" path can request the full list.
    const limit = Math.min(Math.max(1, parseInt(req.query.limit) || 50), 100000);
    const offset = (page - 1) * limit;
    const sortBy = validSorts.includes(req.query.sort) ? req.query.sort : 'newest';
    const search = (req.query.search || '').trim();

    const orderClause = sortBy === 'oldest' ? 'subscribed_at ASC' :
                        sortBy === 'email_asc' ? 'LOWER(email) ASC' :
                        sortBy === 'status' ? "status ASC, subscribed_at DESC" :
                        'subscribed_at DESC';

    const conditions = [];
    const qp = [];
    if (search) { conditions.push("LOWER(email) LIKE LOWER(?)"); qp.push(`%${search}%`); }
    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    db.get(`SELECT COUNT(*) AS total FROM newsletter_subscribers ${whereClause}`, qp, (err, countRow) => {
        if (err) return res.status(500).json({ success: false, message: err.message });
        db.all(`SELECT * FROM newsletter_subscribers ${whereClause} ORDER BY ${orderClause} LIMIT ? OFFSET ?`,
            [...qp, limit, offset], (err2, rows) => {
            if (err2) return res.status(500).json({ success: false, message: err2.message });
            const total = countRow.total;
            res.json({ success: true, subscribers: rows, total, page, pages: Math.ceil(total / limit) });
        });
    });
});

// Add a subscriber manually
app.post('/api/admin/newsletter/subscribers', requireAdmin, (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, message: 'Email is required' });

    const ip_address = req.ip || req.connection.remoteAddress || 'unknown';
    const user_agent = req.get('User-Agent') || 'unknown';
    const source = 'admin_dashboard';
    const adminId = req.session.adminId;

    const unsubscribe_token = crypto.randomBytes(16).toString('hex');

    // Need to insert both 'status' and 'active' to maintain backwards compatibility 
    db.run(`INSERT INTO newsletter_subscribers (email, status, active, unsubscribe_token, ip_address, user_agent, source, created_by) VALUES (?, 'active', 1, ?, ?, ?, ?, ?)`, 
    [email, unsubscribe_token, ip_address, user_agent, source, adminId], function(err) {
        if (err) {
            console.error("DEBUG ERROR ADDING SUBSCRIBER MANUAL:", err);
            if (err.message.includes('UNIQUE')) {
                 return res.status(409).json({ success: false, message: 'This email is already subscribed!' });
            }
            return res.status(500).json({ success: false, message: 'Server error adding subscriber' });
        }
        res.json({ success: true, message: 'Subscriber added successfully.', subscriber_id: this.lastID });
    });
});

// (D9) Removed duplicate DELETE /api/admin/newsletter/subscribers/:id — the canonical copy
// with the 404-on-no-change guard lives below ("Delete subscriber permanently").

// Toggle subscriber status (Active/Inactive)
app.put('/api/admin/newsletter/subscribers/:id/status', requireAdmin, (req, res) => {
    const subscriberId = req.params.id;
    const { status } = req.body; // Expects 'active' or 'inactive'
    const adminId = req.session.adminId;

    if (!status || (status !== 'active' && status !== 'inactive')) {
        return res.status(400).json({ success: false, message: 'Invalid status' });
    }

    db.run(`UPDATE newsletter_subscribers 
            SET status = ?, modified_on = CURRENT_TIMESTAMP, modified_by = ? 
            WHERE subscriber_id = ?`, 
        [status, adminId, subscriberId], function(err) {
        if (err) return res.status(500).json({ success: false, error: err.message });
        if (this.changes === 0) return res.status(404).json({ success: false, message: 'Subscriber not found' });
        res.json({ success: true, message: `Subscriber marked as ${status}` });
    });
});

// Delete subscriber permanently
app.delete('/api/admin/newsletter/subscribers/:id', requireAdmin, (req, res) => {
    const subscriberId = req.params.id;

    db.run(`DELETE FROM newsletter_subscribers WHERE subscriber_id = ?`, [subscriberId], function(err) {
        if (err) return res.status(500).json({ success: false, error: err.message });
        if (this.changes === 0) return res.status(404).json({ success: false, message: 'Subscriber not found' });
        res.json({ success: true, message: 'Subscriber deleted permanently' });
    });
});

// Bulk Toggle Subscriber Status
app.put('/api/admin/newsletter/subscribers/bulk-status', requireAdmin, (req, res) => {
    const { ids, status } = req.body;
    const adminId = req.session.adminId;

    if (!ids || !Array.isArray(ids) || !ids.length) {
        return res.status(400).json({ success: false, message: 'Invalid or empty IDs array' });
    }
    if (!status || (status !== 'active' && status !== 'inactive')) {
        return res.status(400).json({ success: false, message: 'Invalid status' });
    }

    const placeholders = ids.map(() => '?').join(',');
    const sql = `UPDATE newsletter_subscribers 
                 SET status = ?, modified_on = CURRENT_TIMESTAMP, modified_by = ? 
                 WHERE subscriber_id IN (${placeholders})`;
    
    db.run(sql, [status, adminId, ...ids], function(err) {
        if (err) return res.status(500).json({ success: false, error: err.message });
        res.json({ success: true, message: `${this.changes} subscribers marked as ${status}` });
    });
});

// Bulk Delete Subscribers
app.post('/api/admin/newsletter/subscribers/bulk-delete', requireAdmin, (req, res) => {
    const { ids } = req.body;

    if (!ids || !Array.isArray(ids) || !ids.length) {
        return res.status(400).json({ success: false, message: 'Invalid or empty IDs array' });
    }

    const placeholders = ids.map(() => '?').join(',');
    const sql = `DELETE FROM newsletter_subscribers WHERE subscriber_id IN (${placeholders})`;
    
    db.run(sql, ids, function(err) {
        if (err) return res.status(500).json({ success: false, error: err.message });
        res.json({ success: true, message: `${this.changes} subscribers deleted permanently` });
    });
});

// Bulk Import Subscribers via CSV
app.post('/api/admin/newsletter/subscribers/import', requireAdmin, upload.single('csv'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ success: false, message: 'No file uploaded' });
    }

    const filePath = req.file.path;
    const adminId = req.session.adminId;

    try {
        const fileContent = fs.readFileSync(filePath, 'utf-8');
        const lines = fileContent.split(/\r?\n/);
        
        if (lines.length < 2) {
             fs.unlinkSync(filePath);
             return res.json({ success: false, message: 'File is empty or has no data rows' });
        }

        const headers = lines[0].toLowerCase().split(',');
        const emailIdx = headers.indexOf('email');
        const statusIdx = headers.indexOf('status');

        if (emailIdx === -1) {
            fs.unlinkSync(filePath);
            return res.status(400).json({ success: false, message: 'Missing "email" column in header' });
        }

        let successCount = 0;
        let updateCount = 0;
        let errorCount = 0;
        let processedCount = 0;

        // Queued behind the other guarded transactions on the shared connection: a CSV import that
        // ran while a booking was mid-transaction used to fail with "cannot start a transaction
        // within a transaction", and its statements could be swept into the booking's rollback.
        const outcome = await withDbTransaction(async () => {
            try {
                await dbRun("BEGIN IMMEDIATE");
            } catch (beginErr) {
                console.error('[CSV Import] BEGIN IMMEDIATE failed:', beginErr.message);
                return { status: 500, body: { success: false, message: 'Database busy. Please retry.' } };
            }
            try {
                for (let i = 1; i < lines.length; i++) {
                    const line = lines[i].trim();
                    if (!line) continue;

                    const cols = line.split(',');
                    const email = (cols[emailIdx] || '').trim();
                    let status = statusIdx !== -1 ? (cols[statusIdx] || '').trim().toLowerCase() : 'active';

                    if (!status || (status !== 'active' && status !== 'inactive')) status = 'active';

                    if (!email || !email.includes('@')) {
                        errorCount++;
                        continue;
                    }

                    const unsubscribe_token = crypto.randomBytes(16).toString('hex');
                    const active = status === 'active' ? 1 : 0;

                    processedCount++;

                    // A malformed row is counted and skipped, as before — one bad line must not
                    // roll back an otherwise good import.
                    try {
                        const upd = await dbRun(
                            `UPDATE newsletter_subscribers
                             SET status = ?, modified_on = CURRENT_TIMESTAMP, modified_by = ?
                             WHERE LOWER(email) = LOWER(?)`,
                            [status, adminId, email]
                        );
                        if (upd.changes > 0) {
                            updateCount++;
                        } else {
                            await dbRun(
                                `INSERT INTO newsletter_subscribers (email, status, active, unsubscribe_token, source, created_by)
                                 VALUES (?, ?, ?, ?, 'csv_import', ?)`,
                                [email, status, active, unsubscribe_token, adminId]
                            );
                            successCount++;
                        }
                    } catch (rowErr) {
                        errorCount++;
                    }
                }

                await dbRun("COMMIT");
                return { ok: true };
            } catch (txErr) {
                await dbRun("ROLLBACK").catch(() => {});
                console.error('[CSV Import] Failed — rolled back, no subscribers imported:', txErr.message);
                return { status: 500, body: { success: false, message: 'Transaction failed: ' + txErr.message } };
            }
        });

        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        if (!outcome.ok) return res.status(outcome.status).json(outcome.body);

        res.json({
            success: true,
            message: `Import complete: ${successCount} added, ${updateCount} updated, ${errorCount} failed.`
        });

    } catch (e) {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        res.status(500).json({ success: false, message: 'Server error: ' + e.message });
    }
});

// --- Newsletter Drafts ---

// Save Draft
app.post('/api/admin/newsletter/drafts', requireAdmin, newsletterUpload.none(), (req, res) => {
    const { subject, content } = req.body;
    db.run("INSERT INTO newsletter_drafts (subject, content) VALUES (?, ?)", [subject, content], function(err) {
        if (err) {
            return res.status(500).json({ success: false, message: err.message });
        }
        res.json({ success: true, id: this.lastID });
    });
});

// Update Draft
app.put('/api/admin/newsletter/drafts/:id', requireAdmin, newsletterUpload.none(), (req, res) => {
    const { subject, content } = req.body;
    const { id } = req.params;
    db.run("UPDATE newsletter_drafts SET subject = ?, content = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [subject, content, id], function(err) {
        if (err) {
            return res.status(500).json({ success: false, message: err.message });
        }
        res.json({ success: true });
    });
});

// Get All Drafts
app.get('/api/admin/newsletter/drafts', requireAdmin, (req, res) => {
    db.all("SELECT id, subject, content, created_at, updated_at FROM newsletter_drafts ORDER BY updated_at DESC", [], (err, rows) => {
        if (err) {
            return res.status(500).json({ success: false, message: err.message });
        }
        res.json(rows);
    });
});

// Get Single Draft
app.get('/api/admin/newsletter/drafts/:id', requireAdmin, (req, res) => {
    const { id } = req.params;
    db.get("SELECT id, subject, content, created_at, updated_at FROM newsletter_drafts WHERE id = ?", [id], (err, row) => {
        if (err) {
            return res.status(500).json({ success: false, message: err.message });
        }
        res.json(row);
    });
});

// Delete Draft
app.delete('/api/admin/newsletter/drafts/:id', requireAdmin, (req, res) => {
    const { id } = req.params;
    db.run("DELETE FROM newsletter_drafts WHERE id = ?", [id], function(err) {
        if (err) {
            return res.status(500).json({ success: false, message: err.message });
        }
        res.json({ success: true });
    });
});

// --- Newsletter Scheduling ---

function loadPendingScheduledJobs() {
    db.all(
        "SELECT * FROM scheduled_newsletters WHERE status = 'pending' AND scheduled_at > datetime('now')",
        (err, rows) => {
            if (err) return console.error('Failed to load scheduled jobs:', err);
            rows.forEach(row => scheduleNewsletterSend(row));
        }
    );
}

function scheduleNewsletterSend(schedItem) {
    // Handle both ISO8601 ("2025-05-12T14:00:00.000Z") and SQLite datetime ("2025-05-12 14:00:00")
    const rawDt = schedItem.scheduled_at;
    const fireDate = new Date(rawDt.includes('T') ? rawDt : rawDt.replace(' ', 'T') + 'Z');
    if (isNaN(fireDate.getTime()) || fireDate <= new Date()) return;

    const job = schedule.scheduleJob(fireDate, function() {
        // Re-check DB status — guard against a cancel that races with the fire time
        db.get("SELECT status FROM scheduled_newsletters WHERE id = ?", [schedItem.id], async (err, row) => {
            if (err || !row || row.status !== 'pending') {
                delete scheduledJobs[schedItem.id];
                return;
            }

            db.all("SELECT email, unsubscribe_token FROM newsletter_subscribers WHERE status = 'active'", async (err2, subscribers) => {
                if (err2) {
                    db.run("UPDATE scheduled_newsletters SET status = 'failed' WHERE id = ?", [schedItem.id]);
                    delete scheduledJobs[schedItem.id];
                    return;
                }
                if (!subscribers || subscribers.length === 0) {
                    db.run("UPDATE scheduled_newsletters SET status = 'skipped' WHERE id = ?", [schedItem.id]);
                    delete scheduledJobs[schedItem.id];
                    return;
                }

                let jobAttachments = [];
                if (schedItem.attachment_paths) {
                    try {
                        jobAttachments = JSON.parse(schedItem.attachment_paths)
                            .filter(a => fs.existsSync(a.path))
                            .map(a => ({ filename: a.filename, path: a.path }));
                    } catch(e) {}
                }

                // Campaign content is the admin's own authored HTML — rendered verbatim as bodyHtml,
                // just wrapped with the brand shell + a per-recipient unsubscribe link (preWrapped
                // bypasses sendEmailDirectly's own subscriber lookup, so it's built here instead).
                const { socialLinks: schedSocialLinks } = await getEmailFooterContext();
                const campaignBanner = await bannerRegistry.resolveBanner('newsletter_campaign');
                let successCount = 0;
                let failCount = 0;
                for (const sub of subscribers) {
                    try {
                        const unsubscribeUrl = sub.unsubscribe_token
                            ? `${emailBaseUrl()}/unsubscribe.html?token=${sub.unsubscribe_token}&email=${encodeURIComponent(sub.email)}`
                            : null;
                        const html = emailComponents.renderPremiumEmail({
                            preheaderText: schedItem.subject,
                            bannerSrc: campaignBanner?.src, bannerAlt: campaignBanner?.alt, subtitle: campaignBanner?.subtitle,
                            headline: schedItem.subject,
                            bodyHtml: schedItem.content,
                            unsubscribeUrl,
                            socialLinks: schedSocialLinks
                        });
                        const result = await sendEmail({
                            to: sub.email,
                            subject: schedItem.subject,
                            htmlContent: html,
                            preWrapped: true,
                            titleOverride: schedItem.subject,
                            attachments: jobAttachments,
                            trigger_event: 'Newsletter: Scheduled Campaign'
                        });
                        if (result.success) { successCount++; } else { failCount++; }
                    } catch (e) {
                        failCount++;
                        console.error(`Scheduled newsletter [${schedItem.id}]: failed sending to ${sub.email}:`, e.message);
                    }
                    await new Promise(r => setTimeout(r, 200)); // anti-spam delay
                }

                const finalStatus = `sent (${successCount}/${subscribers.length})`;
                db.run("UPDATE scheduled_newsletters SET status = ? WHERE id = ?", [finalStatus, schedItem.id]);
                db.run("INSERT INTO newsletter_campaigns (subject, content) VALUES (?, ?)", [schedItem.subject, schedItem.content]);
                jobAttachments.forEach(a => fs.unlink(a.path, () => {}));
                delete scheduledJobs[schedItem.id];
                console.log(`✅ Scheduled newsletter [${schedItem.id}] dispatched: ${finalStatus}, failures: ${failCount}`);
            });
        });
    });
    scheduledJobs[schedItem.id] = job;
}

// Newsletter Preview — returns the exact branded HTML the recipient will see
app.post('/api/admin/newsletter/preview', requireAdmin, newsletterUpload.none(), (req, res) => {
    try {
        const { subject, content } = req.body;
        if (!content) return res.status(400).json({ success: false, message: 'Content is required.' });
        const html = emailTemplates.createEmailWrapper(content, subject || 'Newsletter Preview', '#', process.env.EMAIL_BANNER || null);
        res.json({ success: true, html });
    } catch(e) {
        console.error('[Preview] Error generating preview:', e.message);
        res.status(500).json({ success: false, message: 'Could not generate preview: ' + e.message });
    }
});

// Create Scheduled Newsletter
app.post('/api/admin/newsletter/schedule', requireAdmin, newsletterUpload.array('attachments', 10), (req, res) => {
    const { subject, content, scheduled_at } = req.body;
    if (!content) return res.status(400).json({ success: false, message: 'Content is required.' });
    if (!scheduled_at) return res.status(400).json({ success: false, message: 'scheduled_at is required.' });
    const fireDate = new Date(scheduled_at);
    if (isNaN(fireDate.getTime()) || fireDate <= new Date()) {
        return res.status(400).json({ success: false, message: 'scheduled_at must be a valid future date and time.' });
    }
    const attachmentPaths = JSON.stringify((req.files || []).map(f => ({ filename: f.originalname, path: f.path })));
    db.run("INSERT INTO scheduled_newsletters (subject, content, scheduled_at, attachment_paths) VALUES (?, ?, ?, ?)",
        [subject, content, scheduled_at, attachmentPaths], function(err) {
        if (err) {
            return res.status(500).json({ success: false, message: err.message });
        }
        const newId = this.lastID;
        db.get("SELECT * FROM scheduled_newsletters WHERE id = ?", [newId], (err, row) => {
            if (!err && row) {
                scheduleNewsletterSend(row);
            }
        });
        res.json({ success: true, id: newId });
    });
});

// Get All Scheduled Newsletters
app.get('/api/admin/newsletter/schedule', requireAdmin, (req, res) => {
    db.all("SELECT id, subject, content, scheduled_at, status, created_at FROM scheduled_newsletters ORDER BY scheduled_at DESC", [], (err, rows) => {
        if (err) {
            return res.status(500).json({ success: false, message: err.message });
        }
        res.json(rows);
    });
});

// Cancel Scheduled Newsletter
app.delete('/api/admin/newsletter/schedule/:id', requireAdmin, (req, res) => {
    const { id } = req.params;
    // Fetch attachment paths before cancelling so we can clean up files
    db.get("SELECT attachment_paths FROM scheduled_newsletters WHERE id = ? AND status = 'pending'", [id], (fetchErr, row) => {
        db.run("UPDATE scheduled_newsletters SET status = 'cancelled' WHERE id = ? AND status = 'pending'", [id], function(err) {
            if (err) return res.status(500).json({ success: false, message: err.message });
            if (this.changes === 0) {
                return res.status(400).json({ success: false, message: 'Newsletter is not pending and cannot be cancelled.' });
            }
            if (scheduledJobs[id]) {
                scheduledJobs[id].cancel();
                delete scheduledJobs[id];
            }
            if (!fetchErr && row && row.attachment_paths) {
                try { JSON.parse(row.attachment_paths).forEach(a => fs.unlink(a.path, () => {})); } catch(e) {}
            }
            res.json({ success: true });
        });
    });
});

// Update Scheduled Newsletter
app.put('/api/admin/newsletter/schedule/:id', requireAdmin, newsletterUpload.array('attachments', 10), (req, res) => {
    const { subject, content, scheduled_at } = req.body;
    const { id } = req.params;
    const newFiles = req.files || [];

    // Fetch existing row to handle attachment file management
    db.get("SELECT attachment_paths FROM scheduled_newsletters WHERE id = ? AND status = 'pending'", [id], (fetchErr, existing) => {
        let attachmentPaths;
        if (newFiles.length > 0) {
            // New files uploaded — delete old ones and replace
            if (!fetchErr && existing && existing.attachment_paths) {
                try { JSON.parse(existing.attachment_paths).forEach(a => fs.unlink(a.path, () => {})); } catch(e) {}
            }
            attachmentPaths = JSON.stringify(newFiles.map(f => ({ filename: f.originalname, path: f.path })));
        } else {
            // No new files — keep existing attachment_paths unchanged
            attachmentPaths = (existing && existing.attachment_paths) || '[]';
        }

        db.run("UPDATE scheduled_newsletters SET subject = ?, content = ?, scheduled_at = ?, attachment_paths = ? WHERE id = ? AND status = 'pending'",
            [subject, content, scheduled_at, attachmentPaths, id], function(err) {
            if (err) {
                newFiles.forEach(f => fs.unlink(f.path, () => {}));
                return res.status(500).json({ success: false, message: err.message });
            }
            if (this.changes === 0) {
                newFiles.forEach(f => fs.unlink(f.path, () => {}));
                return res.status(400).json({ success: false, message: 'Schedule not found or no longer pending.' });
            }
            if (scheduledJobs[id]) {
                scheduledJobs[id].cancel();
                delete scheduledJobs[id];
            }
            db.get("SELECT * FROM scheduled_newsletters WHERE id = ?", [id], (err, row) => {
                if (!err && row && row.status === 'pending') {
                    scheduleNewsletterSend(row);
                }
            });
            res.json({ success: true });
        });
    });
});

// ==========================================
// Admin Newsletter Dispatch Route
// ==========================================
app.post('/api/admin/campaigns', requireAdmin, newsletterUpload.array('attachments', 10), async (req, res) => {
    const { subject, message } = req.body;
    const uploadedFiles = req.files || [];

    if (!subject || !message) {
        uploadedFiles.forEach(f => fs.unlink(f.path, () => {}));
        return res.status(400).json({ success: false, message: 'Subject and message are required.' });
    }

    const attachments = uploadedFiles.map(f => ({ filename: f.originalname, path: f.path }));

    // First fetch all active subscribers
    db.all("SELECT email, unsubscribe_token FROM newsletter_subscribers WHERE status = 'active'", [], async (err, rows) => {
        if (err) {
            uploadedFiles.forEach(f => fs.unlink(f.path, () => {}));
            return res.status(500).json({ success: false, message: 'Database error fetching subscribers' });
        }

        if (!rows || rows.length === 0) {
            uploadedFiles.forEach(f => fs.unlink(f.path, () => {}));
            return res.status(400).json({ success: false, message: 'No active subscribers found.' });
        }

        let successCount = 0;
        let errors = [];

        console.log(`Starting premium newsletter dispatch to ${rows.length} recipients...`);

        // Campaign content is the admin's own authored HTML — rendered verbatim as bodyHtml, just
        // wrapped with the brand shell + a per-recipient unsubscribe link.
        const { socialLinks: campaignSocialLinks } = await getEmailFooterContext();
        const campaignBanner = await bannerRegistry.resolveBanner('newsletter_campaign');
        for (const sub of rows) {
            const recipientEmail = sub.email;
            try {
                const unsubscribeUrl = sub.unsubscribe_token
                    ? `${emailBaseUrl()}/unsubscribe.html?token=${sub.unsubscribe_token}&email=${encodeURIComponent(recipientEmail)}`
                    : null;
                const html = emailComponents.renderPremiumEmail({
                    preheaderText: subject,
                    bannerSrc: campaignBanner?.src, bannerAlt: campaignBanner?.alt, subtitle: campaignBanner?.subtitle,
                    headline: subject,
                    bodyHtml: message,
                    unsubscribeUrl,
                    socialLinks: campaignSocialLinks
                });
                const result = await sendEmail({
                    to: recipientEmail,
                    subject: subject,
                    htmlContent: html,
                    preWrapped: true,
                    titleOverride: subject,
                    attachments,
                    trigger_event: 'Newsletter: Campaign Dispatch'
                });

                if (result.success) {
                    successCount++;
                    if (successCount % 10 === 0) console.log(`Newsletter progress: ${successCount}/${rows.length} sent...`);
                } else {
                    throw result.error || new Error('Dispatch failed');
                }

                await new Promise(r => setTimeout(r, 200));
            } catch (error) {
                console.error(`ERROR: Failed sending to ${recipientEmail}:`, error.message);
                errors.push({ email: recipientEmail, error: error.message });
            }
        }

        // Log campaign to database then clean up temp attachment files
        db.run("INSERT INTO newsletter_campaigns (subject, content) VALUES (?, ?)", [subject, message], function(err) {
            if (err) console.error("CRITICAL: Error logging campaign to DB:", err);
            uploadedFiles.forEach(f => fs.unlink(f.path, () => {}));

            const finalMessage = `Newsletter dispatch complete. Successfully sent: ${successCount}/${rows.length}. Failures: ${errors.length}.`;
            console.log(`✅ ${finalMessage}`);

            res.json({
                success: true,
                message: finalMessage,
                stats: { total: rows.length, sent: successCount, failed: errors.length },
                failures: errors.slice(0, 50)
            });
        });
    });
});

// ==========================================
// Public Events Route
// ==========================================
// (Consolidated into the events module below)

// ==========================================
// Admin CRUD Routes (Protected)
// ==========================================

// --- Database Migration Helpers (Phase 2) ---
function findOrCreateClient(name, email, phone, company, vat_number) {
    // ADMIN-XSS: encode HTML in the stored client name/company (rendered unescaped in the admin
    // client views). No-op for normal names; email/phone are validated and left raw.
    name = encodeUserHtml(name);
    company = encodeUserHtml(company);
    return new Promise((resolve, reject) => {
        // INSERT OR IGNORE exploits the UNIQUE constraint on clients.email, eliminating the
        // SELECT-then-INSERT race that produced duplicate client rows under concurrent submissions.
        db.run(
            "INSERT OR IGNORE INTO clients (full_name, email, phone, company_name, vat_number) VALUES (?, ?, ?, ?, ?)",
            [name || 'Unknown', email, phone || '0000000000', company || null, vat_number || null],
            function(insertErr) {
                if (insertErr) return reject(insertErr);
                const wasInserted = this.changes > 0;
                db.get("SELECT id, full_name FROM clients WHERE LOWER(email) = LOWER(?)", [email], (err, row) => {
                    if (err || !row) return reject(err || new Error('Client record missing after upsert'));
                    if (!wasInserted && name && row.full_name &&
                        row.full_name.toLowerCase() !== name.toLowerCase()) {
                        console.warn(`[findOrCreateClient] Email collision: existing="${row.full_name}" new="${name}" email="${email}". Updating client name to "${name}" to resolve collision.`);
                        db.run("UPDATE clients SET full_name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [name, row.id]);
                        row.full_name = name;
                    }
                    if (company || vat_number) {
                        db.run("UPDATE clients SET company_name = COALESCE(?, company_name), vat_number = COALESCE(?, vat_number), updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                            [company, vat_number, row.id]);
                    }
                    resolve(row.id);
                });
            }
        );
    });
}

function findOrCreateVenueFromPlace(venueName, address, city, country, placeId) {
    // ADMIN-XSS: encode HTML in stored venue text (rendered unescaped in admin venue/booking views).
    venueName = encodeUserHtml(venueName);
    address = encodeUserHtml(address);
    city = encodeUserHtml(city);
    country = encodeUserHtml(country);
    return new Promise((resolve, reject) => {
        if (!venueName && !address) return resolve(null);
        const searchName = venueName || address;
        // Prefer matching by place_id when available for accuracy
        const query = placeId
            ? "SELECT id FROM venues WHERE place_id = ?"
            : "SELECT id FROM venues WHERE name = ? OR address = ?";
        const params = placeId ? [placeId] : [searchName, address];
        db.get(query, params, (err, row) => {
            if (err) return reject(err);
            if (row) {
                // Update any missing fields on the existing record
                db.run("UPDATE venues SET city = COALESCE(city, ?), country = COALESCE(country, ?), place_id = COALESCE(place_id, ?), updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                    [city || null, country || null, placeId || null, row.id]);
                return resolve(row.id);
            }
            db.run("INSERT INTO venues (name, address, city, country, place_id) VALUES (?, ?, ?, ?, ?)",
                [searchName || 'Unknown Venue', address || null, city || null, country || null, placeId || null], function(err) {
                    if (err) return reject(err);
                    resolve(this.lastID);
            });
        });
    });
}

app.post('/api/admin/migrate', requireAdmin, async (req, res) => {
    try {
        db.all("SELECT id, name, company, email, cell, event_location, venue_address, date FROM bookings", [], (err, rows) => {
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
                                db.run("UPDATE bookings SET client_id = ?, venue_id = ? WHERE id = ?", [clientId, venueId, row.id], () => {
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

// --- Users (Admins) ---
app.get('/api/admin/users', requireAdmin, requireRole(['administrator']), (req, res) => {
    db.all(`SELECT 
                a.id, 
                a.username, 
                a.email, 
                a.full_name, 
                a.phone, 
                a.role, 
                a.is_active,
                a.must_change_password,
                a.last_login_at,
                a.created_at,
                a.created_by,
                a.created_on,
                a.modified_by,
                a.modified_on,
                creator.email AS creator_email,
                creator.full_name AS creator_name,
                modifier.email AS modifier_email,
                modifier.full_name AS modifier_name
            FROM admins a
            LEFT JOIN admins creator ON a.created_by = creator.id
            LEFT JOIN admins modifier ON a.modified_by = modifier.id
            ORDER BY a.created_at DESC`, [], (err, rows) => {
        if (err) { console.error('list users failed:', err); return res.status(500).json({ success: false, message: 'Could not load users. Please try again.' }); }
        res.json(rows);
    });
});

// Admin Session Heartbeat Route
app.post('/api/admin/session/heartbeat', requireAdmin, (req, res) => {
    const loginLogId = req.session.loginLogId;
    if (!loginLogId) {
        return res.json({ success: true, message: 'No active login log ID' });
    }
    db.run(
        `UPDATE admin_login_logs 
         SET last_activity_at = CURRENT_TIMESTAMP,
             duration_seconds = CAST((strftime('%s', 'now') - strftime('%s', login_at)) AS INTEGER)
         WHERE id = ?`,
        [loginLogId],
        (err) => {
            if (err) {
                console.error('[heartbeat] Failed to update login log:', err.message);
                return res.status(500).json({ success: false });
            }
            res.json({ success: true });
        }
    );
});

// GET Admin Login Activity Logs
app.get('/api/admin/user-login-logs', requireAdmin, requireRole(['administrator']), (req, res) => {
    db.all(`
        SELECT 
            l.id,
            l.admin_id,
            l.login_at,
            l.logout_at,
            l.last_activity_at,
            l.duration_seconds,
            l.ip_address,
            l.user_agent,
            a.username,
            a.email,
            a.full_name
        FROM admin_login_logs l
        JOIN admins a ON l.admin_id = a.id
        ORDER BY l.login_at DESC
    `, [], (err, rows) => {
        if (err) {
            console.error('Failed to fetch login logs:', err);
            return res.status(500).json({ success: false, message: 'Could not fetch login activity logs.' });
        }
        res.json(rows);
    });
});
app.post('/api/admin/users', requireAdmin, requireRole(['administrator']), (req, res) => {
    const { email, full_name, phone, role } = req.body;
    if (!email) {
        return res.status(400).json({ success: false, message: 'Email is required.' });
    }
    if (!full_name || !String(full_name).trim()) {
        return res.status(400).json({ success: false, message: 'Full name is required.' });
    }
    if (!phone || !String(phone).trim()) {
        return res.status(400).json({ success: false, message: 'Phone number is required.' });
    }
    const normalizedEmail = String(email).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
        return res.status(400).json({ success: false, message: 'Enter a valid email address.' });
    }
    const targetRole = VALID_ADMIN_ROLES.includes(role) ? role : 'manager';
    const cleanName = (full_name || '').trim() || null;
    const cleanPhone = (phone || '').trim() || null;

    // No admin-set password: the new user sets their own via the invitation link.
    // Insert an unusable random password so the row is well-formed but nobody can sign in until they accept the invite.
    const placeholderPassword = crypto.randomBytes(24).toString('hex');
    bcrypt.hash(placeholderPassword, 10, (err, hash) => {
        if (err) return res.status(500).json({ success: false, message: 'Error preparing the account.' });

        db.run(
            "INSERT INTO admins (username, email, password_hash, role, full_name, phone, is_active, must_change_password, created_by, created_on) VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, CURRENT_TIMESTAMP)",
            [normalizedEmail, normalizedEmail, hash, targetRole, cleanName, cleanPhone, req.session.adminId],
            function (err) {
                if (err) {
                    if (err.message.includes('UNIQUE')) {
                        return res.status(400).json({ success: false, message: 'An account with that email already exists.' });
                    }
                    console.error('create user failed:', err);
                    return res.status(500).json({ success: false, message: 'Could not create the user. Please try again.' });
                }
                const newId = this.lastID;
                // Queue the invitation email so the user can set their password.
                createAndSendInvite({ id: newId, email: normalizedEmail, full_name: cleanName, role: targetRole }, 72, function (mail) {
                    const emailSent = !!(mail && mail.success);
                    res.json({
                        success: true,
                        id: newId,
                        email_sent: emailSent,
                        message: emailSent
                            ? 'User created and invitation sent.'
                            : 'User created, but the invitation email could not be sent. Use "Resend invite".'
                    });
                });
            }
        );
    });
});

// Resend the set-password invitation to an existing (typically pending) user.
app.post('/api/admin/users/:id/resend-invite', requireAdmin, requireRole(['administrator']), (req, res) => {
    const userId = parseInt(req.params.id, 10);
    db.get("SELECT id, email, full_name, role FROM admins WHERE id = ?", [userId], (err, user) => {
        if (err || !user) return res.status(404).json({ success: false, message: 'User not found.' });
        // Invalidate any outstanding tokens, then issue a fresh one.
        db.run("DELETE FROM password_reset_tokens WHERE admin_id = ?", [userId], () => {
            createAndSendInvite(user, 72, function (mail) {
                const emailSent = !!(mail && mail.success);
                res.json({
                    success: true,
                    email_sent: emailSent,
                    message: emailSent ? 'Invitation re-sent to ' + user.email + '.' : 'Could not send the invitation email. Please try again.'
                });
            });
        });
    });
});
app.put('/api/admin/users/:id', requireAdmin, requireRole(['administrator']), (req, res) => {
    const { email, password, currentPassword, full_name, phone, role, is_active } = req.body;
    const userId = parseInt(req.params.id, 10);
    const isEditingSelf = userId === req.session.adminId;

    if (!email) return res.status(400).json({ success: false, message: 'Email is required.' });
    const normalizedEmail = String(email).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
        return res.status(400).json({ success: false, message: 'Enter a valid email address.' });
    }

    db.get("SELECT role, is_active, full_name, phone FROM admins WHERE id = ?", [userId], (selErr, existing) => {
        if (selErr || !existing) return res.status(404).json({ success: false, message: 'User not found.' });
        const hasKey = (k) => Object.prototype.hasOwnProperty.call(req.body, k);

        // Full name + phone are mandatory when supplied by a form edit. Inline role/status
        // toggles and password-only updates omit these keys and must keep working.
        if (hasKey('full_name') && !String(full_name || '').trim()) {
            return res.status(400).json({ success: false, message: 'Full name is required.' });
        }
        if (hasKey('phone') && !String(phone || '').trim()) {
            return res.status(400).json({ success: false, message: 'Phone number is required.' });
        }

        // Default role/status to the existing values when not explicitly provided, so a bare
        // profile/password save never demotes or deactivates the account.
        const targetRole = VALID_ADMIN_ROLES.includes(role) ? role : existing.role;
        const targetIsActive = (is_active === undefined || is_active === null)
            ? existing.is_active
            : ((is_active === false || is_active === 0) ? 0 : 1);

        // Last-administrator guard: never let the system reach zero active administrators.
        const wasActiveAdmin = existing.role === 'administrator' && existing.is_active !== 0;
        const willStopBeingActiveAdmin = targetRole !== 'administrator' || targetIsActive === 0;

        if (wasActiveAdmin && willStopBeingActiveAdmin) {
            countOtherActiveAdministrators(userId, (cntErr, cntRow) => {
                const otherAdmins = cntErr ? 1 : cntRow.count;
                if (otherAdmins === 0) {
                    return res.status(403).json({ success: false, message: 'Cannot remove the last remaining administrator account.' });
                }
                applyUpdate();
            });
        } else {
            applyUpdate();
        }

        function applyUpdate() {
            const fields = {
                username: normalizedEmail,
                email: normalizedEmail,
                // Only overwrite full_name/phone when the client actually sent the key,
                // so a bare password change doesn't wipe them.
                full_name: hasKey('full_name') ? ((full_name || '').trim() || null) : existing.full_name,
                phone: hasKey('phone') ? ((phone || '').trim() || null) : existing.phone,
                role: targetRole,
                is_active: targetIsActive
            };

            if (password && password.trim() !== '') {
                if (isEditingSelf) {
                    if (!currentPassword) {
                        return res.status(400).json({ success: false, message: 'Current password is required to set a new password.' });
                    }
                    return db.get("SELECT password_hash FROM admins WHERE id = ?", [userId], (err, row) => {
                        if (err || !row) return res.status(404).json({ success: false, message: 'User not found.' });
                        bcrypt.compare(currentPassword, row.password_hash, (err, isMatch) => {
                            if (err) return res.status(500).json({ success: false, message: 'Error verifying password.' });
                            if (!isMatch) return res.status(401).json({ success: false, message: 'Current password is incorrect.' });
                            hashAndSave(fields, password);
                        });
                    });
                }
                // Administrator resetting another user's password — no currentPassword needed.
                return hashAndSave(fields, password);
            }
            saveFields(fields, null);
        }

        function hashAndSave(fields, newPassword) {
            bcrypt.hash(newPassword, 10, (err, hash) => {
                if (err) return res.status(500).json({ success: false, message: 'Error hashing password' });
                saveFields(fields, hash);
            });
        }

        function saveFields(fields, passwordHash) {
            const setPwd = passwordHash ? ", password_hash = ?, must_change_password = 0" : "";
            const params = [fields.username, fields.email, fields.full_name, fields.phone, fields.role, fields.is_active, req.session.adminId];
            if (passwordHash) params.push(passwordHash);
            params.push(userId);

            db.run(
                `UPDATE admins SET username = ?, email = ?, full_name = ?, phone = ?, role = ?, is_active = ?, modified_by = ?, modified_on = CURRENT_TIMESTAMP${setPwd} WHERE id = ?`,
                params,
                function (err) {
                    if (err) {
                        if (err.message.includes('UNIQUE')) {
                            return res.status(400).json({ success: false, message: 'An account with that email already exists.' });
                        }
                        console.error('update user failed:', err);
                        return res.status(500).json({ success: false, message: 'Could not update the user. Please try again.' });
                    }
                    res.json({ success: true, message: 'User updated successfully.' });
                }
            );
        }
    });
});
app.delete('/api/admin/users/:id', requireAdmin, requireRole(['administrator']), (req, res) => {
    const targetUserId = parseInt(req.params.id, 10);
    const currentUserId = req.session.adminId; // prevent self-deletion

    if (targetUserId === currentUserId) {
         return res.status(403).json({ success: false, message: 'You cannot delete your own account while logged in.' });
    }

    db.get("SELECT role, is_active FROM admins WHERE id = ?", [targetUserId], (selErr, existing) => {
        if (selErr || !existing) return res.status(404).json({ success: false, message: 'User not found.' });
        const isActiveAdmin = existing.role === 'administrator' && existing.is_active !== 0;

        const proceed = () => {
            db.run("DELETE FROM admins WHERE id = ?", targetUserId, function (err) {
                if (err) { console.error('delete user failed:', err); return res.status(500).json({ success: false, message: 'Could not delete the user. Please try again.' }); }
                res.json({ success: true, message: 'User deleted.' });
            });
        };

        if (!isActiveAdmin) return proceed();
        countOtherActiveAdministrators(targetUserId, (cntErr, cntRow) => {
            if (!cntErr && cntRow.count === 0) {
                return res.status(403).json({ success: false, message: 'Cannot delete the last remaining administrator account.' });
            }
            proceed();
        });
    });
});



// --- Audit Log Retrieval ---
// P3-16: Pass ?include_financial=true to merge financial_audit_log entries into the response.
app.get('/api/admin/audit_log', requireAdmin, (req, res) => {
    const limit = parseInt(req.query.limit) || 100;
    const page = req.query.page ? parseInt(req.query.page) : null;
    const offset = page ? (page - 1) * limit : (parseInt(req.query.offset) || 0);
    const table = req.query.table || null;
    const dateFrom = req.query.date_from || null;
    const dateTo = req.query.date_to || null;
    const search = req.query.search || '';
    const sort = req.query.sort || 'change_timestamp';
    const order = req.query.order || 'DESC';
    const includeFinancial = req.query.include_financial === 'true';

    let conditions = [];
    let params = [];
    if (table) { conditions.push("table_name = ?"); params.push(table); }
    if (dateFrom) { conditions.push("date(change_timestamp) >= ?"); params.push(dateFrom); }
    if (dateTo) { conditions.push("date(change_timestamp) <= ?"); params.push(dateTo); }
    if (search) { conditions.push("(table_name LIKE ? OR action LIKE ? OR changed_by LIKE ?)"); params.push(`%${search}%`, `%${search}%`, `%${search}%`); }
    const whereString = conditions.length ? " WHERE " + conditions.join(" AND ") : "";

    const allowedSortCols = ['change_timestamp', 'table_name', 'action'];
    const safeSort = allowedSortCols.includes(sort) ? sort : 'change_timestamp';
    const safeOrder = String(order).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    const dataQuery = "SELECT * FROM audit_log" + whereString + " ORDER BY " + safeSort + " " + safeOrder + " LIMIT ? OFFSET ?";
    const dataParams = params.concat([limit, offset]);

    db.all(dataQuery, dataParams, (err, rows) => {
        if (err) { console.error('audit_log query failed:', err); return res.status(500).json({ success: false, message: 'Could not load the audit trail. Please try again.' }); }
        if (!includeFinancial) {
            db.get("SELECT COUNT(*) AS total FROM audit_log" + whereString, params, (cErr, cRow) => {
                const total = cErr ? (rows || []).length : (parseInt(cRow && cRow.total) || 0);
                return res.json({ success: true, logs: rows || [], total: total, page: page || 1, totalPages: Math.ceil(total / limit) || 1 });
            });
            return;
        }

        // Merge financial_audit_log rows — normalise to same shape as audit_log
        let finConditions = [];
        let finParams = [];
        if (dateFrom) { finConditions.push("date(timestamp) >= ?"); finParams.push(dateFrom); }
        if (dateTo)   { finConditions.push("date(timestamp) <= ?"); finParams.push(dateTo); }
        const finQuery = `SELECT id, event_type AS action, entity_type AS table_name, entity_id AS record_id,
                                  NULL AS old_values, notes AS new_values, changed_by, timestamp AS change_timestamp,
                                  amount, 'financial' AS log_source
                          FROM financial_audit_log` +
            (finConditions.length ? ' WHERE ' + finConditions.join(' AND ') : '') +
            ' ORDER BY timestamp DESC LIMIT 500';

        db.all(finQuery, finParams, (fErr, finRows) => {
            const auditRows = (rows || []).map(r => ({ ...r, log_source: 'audit' }));
            const merged = [...auditRows, ...(fErr ? [] : (finRows || []))]
                .sort((a, b) => new Date(b.change_timestamp) - new Date(a.change_timestamp))
                .slice(0, limit);
            res.json({ success: true, logs: merged, financial_log_error: fErr ? fErr.message : null });
        });
    });
});

// P3-16: Dedicated financial_audit_log endpoint (separate from main audit_log)
app.get('/api/admin/financial_audit_log', requireAdmin, requireRole(['administrator', 'manager']), (req, res) => {
    const limit = parseInt(req.query.limit) || 100;
    const offset = parseInt(req.query.offset) || 0;
    const dateFrom = req.query.date_from || null;
    const dateTo   = req.query.date_to   || null;

    let conditions = [];
    let params = [];
    if (dateFrom) { conditions.push("date(timestamp) >= ?"); params.push(dateFrom); }
    if (dateTo)   { conditions.push("date(timestamp) <= ?"); params.push(dateTo); }
    params.push(limit, offset);

    db.all(
        `SELECT * FROM financial_audit_log${conditions.length ? ' WHERE ' + conditions.join(' AND ') : ''} ORDER BY timestamp DESC LIMIT ? OFFSET ?`,
        params,
        (err, rows) => {
            if (err) return res.status(500).json({ success: false, error: err.message });
            res.json({ success: true, logs: rows || [] });
        }
    );
});

// --- Financial CSV Export ---
app.get('/api/admin/finance/export', exportRateLimiter, requireAdmin, requireRole(['administrator', 'manager']), (req, res) => {
    const query = `
        SELECT 
            b.id AS booking_id, 
            b.name AS client_name, 
            b.email, 
            b.date, 
            b.event_type, 
            b.total_amount, 
            b.amount_paid, 
            b.amount_outstanding, 
            b.payment_status,
            COALESCE(i.invoice_number, 'N/A') AS invoice_no
        FROM bookings b
        LEFT JOIN invoices i ON b.id = i.booking_id
        ORDER BY b.date DESC
    `;

    db.all(query, [], (err, rows) => {
        if (err) return res.status(500).json({ success: false, message: 'Failed to fetch financial data' });

        const headers = ["Booking ID", "Client Name", "Email", "Date", "Event Type", "Total Amount", "Amount Paid", "Outstanding", "Payment Status", "Invoice Number"];
        let csv = headers.join(",") + "\n";

        rows.forEach(row => {
            const rowData = [
                row.booking_id,
                `"${row.client_name}"`,
                row.email,
                row.date,
                `"${row.event_type}"`,
                row.total_amount || 0,
                row.amount_paid || 0,
                row.amount_outstanding || 0,
                row.payment_status,
                row.invoice_no
            ];
            csv += rowData.join(",") + "\n";
        });

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename=thabiso_finance_export_${new Date().toISOString().split('T')[0]}.csv`);
        res.status(200).send(csv);
    });
});

// --- Services CRUD ---
app.get('/api/admin/services', requireAdmin, (req, res) => {
    const activeOnly = req.query.active_only === '1';
    const includeDeleted = req.query.include_deleted === '1';
    let query = "SELECT * FROM services WHERE COALESCE(is_deleted, 0) = 0";
    if (activeOnly) query += " AND COALESCE(is_active, 1) = 1";
    if (includeDeleted) query = "SELECT * FROM services";
    query += " ORDER BY category, name";
    db.all(query, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows || []);
    });
});
app.post('/api/admin/services', requireAdmin, (req, res) => {
    const {
        name, description, default_price, category, is_taxable, is_active,
        pricing_model, base_price, min_quantity, max_quantity, display_unit,
        service_type, base_uom, pricing_group, is_capital_asset, tax_class,
        sac_code, availability_rule, booking_lead_time_days, setup_time_minutes,
        performance_length_minutes, travel_included, preferred_resource_id,
        cost_center, profit_center, internal_note, external_note, valid_from, valid_to,
        crew_required, financial_category, legacy_code,
        revenue_gl_code, marketing_segment, item_category,
        tax_category, fulfillment_type
    } = req.body;
    if (!name || default_price === undefined || isNaN(parseFloat(default_price))) return res.status(400).json({ error: 'name and default_price are required.' });
    if (parseFloat(default_price) < 0) return res.status(400).json({ error: 'default_price cannot be negative.' });
    if (valid_from && valid_to && valid_from > valid_to)
        return res.status(400).json({ error: 'valid_from must be on or before valid_to.' });
    const validCats = ['Performance', 'Travel', 'Production', 'Other'];
    const cat = validCats.includes(category) ? category : 'Other';
    const isFlat = (pricing_model || 'flat_fee') === 'flat_fee';
    const normMinQty = isFlat ? 1 : (parseInt(min_quantity) || 1);
    const normMaxQty = isFlat ? null : (parseInt(max_quantity) || null);
    if (!isFlat) {
        if (normMinQty < 15) return res.status(400).json({ error: 'Minimum quantity for time-based services must be at least 15 minutes.' });
        if (normMinQty > (normMaxQty || Infinity)) return res.status(400).json({ error: 'Minimum quantity cannot exceed maximum quantity.' });
    }

    db.get("SELECT id FROM services WHERE name = ? AND COALESCE(is_deleted,0) = 0", [name.trim()], (dupErr, dup) => {
    if (dup) return res.status(409).json({ error: `A service named "${name.trim()}" already exists.` });

    db.run(`INSERT INTO services (
        name, description, default_price, category, is_taxable, is_active,
        pricing_model, base_price, min_quantity, max_quantity, display_unit,
        service_type, base_uom, pricing_group, is_capital_asset, tax_class,
        sac_code, availability_rule, booking_lead_time_days, setup_time_minutes,
        performance_length_minutes, travel_included, preferred_resource_id,
        cost_center, profit_center, internal_note, external_note, valid_from, valid_to,
        crew_required, financial_category, legacy_code,
        revenue_gl_code, marketing_segment, item_category,
        tax_category, fulfillment_type
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
            name, description || null, parseFloat(default_price), cat, is_taxable ? 1 : 0, is_active !== false ? 1 : 0,
            pricing_model || 'flat_fee', base_price ? parseFloat(base_price) : null, normMinQty, normMaxQty, display_unit || 'unit',
            service_type || 'core', base_uom || 'ea', pricing_group || 'Standard', is_capital_asset ? 1 : 0, tax_class || 'standard',
            sac_code || null, availability_rule || 'any_time', parseInt(booking_lead_time_days) || 0, parseInt(setup_time_minutes) || 0,
            parseInt(performance_length_minutes) || 0, travel_included ? 1 : 0, preferred_resource_id ? parseInt(preferred_resource_id) : null,
            cost_center || null, profit_center || null, internal_note || null, external_note || null, valid_from || null, valid_to || null,
            parseInt(crew_required) || 1, financial_category || null, legacy_code || null,
            revenue_gl_code || null, marketing_segment || null, item_category || 'DIEN',
            tax_category || null, fulfillment_type || 'on_site'
        ],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            
            const adminUser = req.session.username || 'system';
            db.run(
                `INSERT INTO audit_log (table_name, record_id, action, changed_by, new_values)
                 VALUES ('services', ?, 'CREATE', ?, ?)`,
                [this.lastID, adminUser, JSON.stringify({ name, default_price: parseFloat(default_price), pricing_model })],
                () => {}
            );
            db.run(
                `INSERT INTO financial_audit_log (event_type, entity_type, entity_id, amount, changed_by, notes)
                 VALUES ('SERVICE_CREATED', 'service', ?, ?, ?, ?)`,
                [this.lastID, parseFloat(default_price), adminUser, `Created service: ${name} (${pricing_model})`],
                () => {}
            );

            res.json({ success: true, id: this.lastID });
        });
    }); // end db.get duplicate check
});
app.put('/api/admin/services/:id', requireAdmin, (req, res) => {
    const {
        name, description, default_price, category, is_taxable, is_active,
        pricing_model, base_price, min_quantity, max_quantity, display_unit,
        service_type, base_uom, pricing_group, is_capital_asset, tax_class,
        sac_code, availability_rule, booking_lead_time_days, setup_time_minutes,
        performance_length_minutes, travel_included, preferred_resource_id,
        cost_center, profit_center, internal_note, external_note, valid_from, valid_to,
        crew_required, financial_category, legacy_code, is_deleted,
        revenue_gl_code, marketing_segment, item_category,
        tax_category, fulfillment_type
    } = req.body;
    if (!name || default_price === undefined || isNaN(parseFloat(default_price))) return res.status(400).json({ error: 'name and default_price are required.' });
    if (parseFloat(default_price) < 0) return res.status(400).json({ error: 'default_price cannot be negative.' });
    if (valid_from && valid_to && valid_from > valid_to)
        return res.status(400).json({ error: 'valid_from must be on or before valid_to.' });
    const validCats = ['Performance', 'Travel', 'Production', 'Other'];
    const cat = validCats.includes(category) ? category : 'Other';
    const isFlat = (pricing_model || 'flat_fee') === 'flat_fee';
    const normMinQty = isFlat ? 1 : (parseInt(min_quantity) || 1);
    const normMaxQty = isFlat ? null : (parseInt(max_quantity) || null);
    if (!isFlat) {
        if (normMinQty < 15) return res.status(400).json({ error: 'Minimum quantity for time-based services must be at least 15 minutes.' });
        if (normMinQty > (normMaxQty || Infinity)) return res.status(400).json({ error: 'Minimum quantity cannot exceed maximum quantity.' });
    }

    db.get("SELECT id FROM services WHERE name = ? AND id != ? AND COALESCE(is_deleted,0) = 0", [name.trim(), req.params.id], (dupErr, dup) => {
    if (dup) return res.status(409).json({ error: `Another service named "${name.trim()}" already exists.` });

    db.run(`UPDATE services SET
        name=?, description=?, default_price=?, category=?, is_taxable=?, is_active=?,
        pricing_model=?, base_price=?, min_quantity=?, max_quantity=?, display_unit=?,
        service_type=?, base_uom=?, pricing_group=?, is_capital_asset=?, tax_class=?,
        sac_code=?, availability_rule=?, booking_lead_time_days=?, setup_time_minutes=?,
        performance_length_minutes=?, travel_included=?, preferred_resource_id=?,
        cost_center=?, profit_center=?, internal_note=?, external_note=?, valid_from=?, valid_to=?,
        crew_required=?, financial_category=?, legacy_code=?, is_deleted=?,
        revenue_gl_code=?, marketing_segment=?, item_category=?,
        tax_category=?, fulfillment_type=?
        WHERE id=?`,
        [
            name, description || null, parseFloat(default_price), cat, is_taxable ? 1 : 0, is_active !== false ? 1 : 0,
            pricing_model || 'flat_fee', base_price ? parseFloat(base_price) : null, normMinQty, normMaxQty, display_unit || 'unit',
            service_type || 'core', base_uom || 'ea', pricing_group || 'Standard', is_capital_asset ? 1 : 0, tax_class || 'standard',
            sac_code || null, availability_rule || 'any_time', parseInt(booking_lead_time_days) || 0, parseInt(setup_time_minutes) || 0,
            parseInt(performance_length_minutes) || 0, travel_included ? 1 : 0, preferred_resource_id ? parseInt(preferred_resource_id) : null,
            cost_center || null, profit_center || null, internal_note || null, external_note || null, valid_from || null, valid_to || null,
            parseInt(crew_required) || 1, financial_category || null, legacy_code || null, is_deleted ? 1 : 0,
            revenue_gl_code || null, marketing_segment || null, item_category || 'DIEN',
            tax_category || null, fulfillment_type || 'on_site',
            req.params.id
        ],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            if (this.changes === 0) return res.status(404).json({ error: 'Service not found.' });
            
            const adminUser = req.session.username || 'system';
            db.run(
                `INSERT INTO audit_log (table_name, record_id, action, changed_by, new_values)
                 VALUES ('services', ?, 'UPDATE', ?, ?)`,
                [req.params.id, adminUser, JSON.stringify({ name, default_price: parseFloat(default_price), pricing_model, is_deleted })],
                () => {}
            );
            db.run(
                `INSERT INTO financial_audit_log (event_type, entity_type, entity_id, amount, changed_by, notes)
                 VALUES ('SERVICE_UPDATED', 'service', ?, ?, ?, ?)`,
                [req.params.id, parseFloat(default_price), adminUser, `Updated service: ${name}. Archived: ${is_deleted ? 'Yes' : 'No'}`],
                () => {}
            );

            res.json({ success: true });
        });
    }); // end db.get duplicate check
});
app.get('/api/admin/services/:id/usage', requireAdmin, (req, res) => {
    const serviceId = req.params.id;
    const sql = `
        SELECT COUNT(DISTINCT q.id) AS draft_count 
        FROM quotations q
        JOIN quote_line_items qli ON q.id = qli.quotation_id
        WHERE qli.service_id = ? AND q.status = 'draft' AND COALESCE(q.archived, 0) = 0
    `;
    db.get(sql, [serviceId], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ draft_quote_count: row ? row.draft_count : 0 });
    });
});
app.delete('/api/admin/services/:id', requireAdmin, (req, res) => {
    const force = req.query.force === '1';
    const adminUser = req.session.username || 'system';
    if (!force) {
        db.run("UPDATE services SET is_deleted=1 WHERE id=?", [req.params.id], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            if (this.changes === 0) return res.status(404).json({ error: 'Service not found.' });
            
            db.run(
                `INSERT INTO audit_log (table_name, record_id, action, changed_by)
                 VALUES ('services', ?, 'ARCHIVE', ?)`,
                [req.params.id, adminUser],
                () => {}
            );
            db.run(
                `INSERT INTO financial_audit_log (event_type, entity_type, entity_id, amount, changed_by, notes)
                 VALUES ('SERVICE_ARCHIVED', 'service', ?, 0, ?, 'Service marked as archived (soft-deleted)')`,
                [req.params.id, adminUser],
                () => {}
            );

            res.json({ success: true, soft_deleted: true });
        });
        return;
    }
    db.get("SELECT COUNT(*) as cnt FROM booking_line_items WHERE service_id=?", [req.params.id], (e1, r1) => {
        db.get("SELECT COUNT(*) as cnt FROM quote_line_items WHERE service_id=?", [req.params.id], (e2, r2) => {
            if ((r1 && r1.cnt > 0) || (r2 && r2.cnt > 0)) {
                return res.status(409).json({ error: 'Service is referenced by existing line items and cannot be hard-deleted.' });
            }
            db.run("DELETE FROM services WHERE id=?", [req.params.id], function(err) {
                if (err) return res.status(500).json({ error: err.message });
                if (this.changes === 0) return res.status(404).json({ error: 'Service not found.' });

                db.run(
                    `INSERT INTO audit_log (table_name, record_id, action, changed_by)
                     VALUES ('services', ?, 'HARD_DELETE', ?)`,
                    [req.params.id, adminUser],
                    () => {}
                );

                res.json({ success: true });
            });
        });
    });
});

// --- Policies ---
app.get('/api/admin/policies', requireAdmin, (req, res) => {
    db.all("SELECT policy_key, policy_value FROM policies", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        const obj = {};
        (rows || []).forEach(r => { obj[r.policy_key] = r.policy_value; });
        res.json({ success: true, policies: obj });
    });
});
app.put('/api/admin/policies', requireAdmin, (req, res) => {
    const { policies } = req.body;
    if (!policies || typeof policies !== 'object') return res.status(400).json({ error: 'policies object required.' });
    const keys = Object.keys(policies);
    let pending = keys.length;
    if (pending === 0) return res.json({ success: true });
    let failed = false;
    keys.forEach(key => {
        db.run("INSERT OR REPLACE INTO policies (policy_key, policy_value, updated_at) VALUES (?,?,CURRENT_TIMESTAMP)",
            [key, String(policies[key])], (err) => {
                if (err && !failed) { failed = true; return res.status(500).json({ error: err.message }); }
                if (--pending === 0 && !failed) res.json({ success: true });
            });
    });
});

// ============================================================
// Legal & Compliance Centre — /api/admin/legal/*
// Reads use requireAdmin; writes (draft/publish/restore) require the administrator role (Gate 4).
// ============================================================

// Next version number for a document: max numeric base + 0.1, with optional "-draft" suffix.
function computeNextLegalVersion(rows, isDraft) {
    let maxBase = 1.0;
    (rows || []).forEach(r => {
        const base = parseFloat(String(r.version_number).replace('-draft', ''));
        if (!isNaN(base) && base > maxBase) maxBase = base;
    });
    const s = ((Math.round(maxBase * 10) + 1) / 10).toFixed(1);
    return isDraft ? s + '-draft' : s;
}

// Route 1 — Overview stats + recent activity
app.get('/api/admin/legal/overview', requireAdmin, (req, res) => {
    const stats = {};
    db.get("SELECT COUNT(*) AS c FROM legal_documents WHERE status='published'", [], (e1, r1) => {
        stats.active_documents = r1 ? r1.c : 0;
        db.get("SELECT COUNT(*) AS c FROM legal_document_versions WHERE is_published=1", [], (e2, r2) => {
            stats.published_versions = r2 ? r2.c : 0;
            db.get("SELECT COUNT(*) AS c FROM consent_audit", [], (e3, r3) => {
                stats.total_consent_records = r3 ? r3.c : 0;
                db.get("SELECT COUNT(*) AS c FROM contracts WHERE status='signed'", [], (e4, r4) => {
                    stats.signed_contracts = r4 ? r4.c : 0;
                    db.get("SELECT COUNT(*) AS c FROM contracts WHERE status='draft'", [], (e5, r5) => {
                        stats.draft_contracts = r5 ? r5.c : 0;
                        db.all(`SELECT lv.id, lv.version_number, lv.change_summary, lv.is_published, lv.created_at, lv.published_by,
                                       ld.document_type, ld.title
                                FROM legal_document_versions lv
                                JOIN legal_documents ld ON ld.id = lv.document_id
                                ORDER BY lv.created_at DESC, lv.id DESC LIMIT 5`, [], (e6, recent) => {
                            res.json({ success: true, stats, recent_activity: recent || [] });
                        });
                    });
                });
            });
        });
    });
});

// Route 2 — All documents with current-version metadata
app.get('/api/admin/legal/documents', requireAdmin, (req, res) => {
    db.all(`SELECT ld.*, lv.version_number, lv.content_html, lv.published_at, lv.published_by, lv.change_summary
            FROM legal_documents ld
            LEFT JOIN legal_document_versions lv ON lv.id = ld.current_version_id
            ORDER BY ld.document_type`, [], (err, docs) => {
        if (err) return res.status(500).json({ success: false, message: err.message });
        res.json({ success: true, documents: docs || [] });
    });
});

// Route 9 — Full version history for one document type (registered before :type so the 3-segment path is explicit)
app.get('/api/admin/legal/documents/:type/history', requireAdmin, (req, res) => {
    db.get("SELECT id FROM legal_documents WHERE document_type = ?", [req.params.type], (err, doc) => {
        if (err) return res.status(500).json({ success: false, message: err.message });
        if (!doc) return res.status(404).json({ success: false, message: 'Unknown document type' });
        db.all("SELECT * FROM legal_document_versions WHERE document_id = ? ORDER BY created_at DESC, id DESC", [doc.id], (e2, versions) => {
            if (e2) return res.status(500).json({ success: false, message: e2.message });
            res.json({ success: true, document_type: req.params.type, versions: versions || [] });
        });
    });
});

// Route 4 — Save a new draft version (write)
app.post('/api/admin/legal/documents/:type/draft', requireAdmin, requireRole(['administrator']), (req, res) => {
    const type = req.params.type;
    let content = (req.body.content_html || '').toString();
    if (!content.trim()) return res.status(400).json({ success: false, message: 'Content cannot be empty.' });
    if (content.length > 500000) content = content.substring(0, 500000);
    const summary = ((req.body.change_summary || '').toString().substring(0, 500)) || null;
    db.get("SELECT id FROM legal_documents WHERE document_type = ?", [type], (err, doc) => {
        if (err) return res.status(500).json({ success: false, message: err.message });
        if (!doc) return res.status(400).json({ success: false, message: 'Unknown document type' });
        db.all("SELECT version_number FROM legal_document_versions WHERE document_id = ?", [doc.id], (e2, rows) => {
            const nextVer = computeNextLegalVersion(rows, true);
            db.run(`INSERT INTO legal_document_versions (document_id, version_number, content_html, change_summary, is_published)
                    VALUES (?,?,?,?,0)`, [doc.id, nextVer, content, summary], function (e3) {
                if (e3) return res.status(500).json({ success: false, message: e3.message });
                db.run("UPDATE legal_documents SET status='draft', updated_at=CURRENT_TIMESTAMP WHERE id=?", [doc.id]);
                res.json({ success: true, version: { id: this.lastID, version_number: nextVer } });
            });
        });
    });
});

// Route 5 — Publish a draft (latest, or a specific version_id) (write)
app.post('/api/admin/legal/documents/:type/publish', requireAdmin, requireRole(['administrator']), (req, res) => {
    const type = req.params.type;
    const by = req.session.username || 'admin';
    db.get("SELECT id FROM legal_documents WHERE document_type = ?", [type], (err, doc) => {
        if (err) return res.status(500).json({ success: false, message: err.message });
        if (!doc) return res.status(400).json({ success: false, message: 'Unknown document type' });
        const publishVersion = (versionId) => {
            db.get("SELECT * FROM legal_document_versions WHERE id = ? AND document_id = ?", [versionId, doc.id], (e2, ver) => {
                if (e2) return res.status(500).json({ success: false, message: e2.message });
                if (!ver) return res.status(404).json({ success: false, message: 'Version not found for this document.' });
                const cleanNum = String(ver.version_number).replace('-draft', '');
                db.run("UPDATE legal_document_versions SET is_published=1, version_number=?, published_at=CURRENT_TIMESTAMP, published_by=? WHERE id=?",
                    [cleanNum, by, ver.id], (e3) => {
                        if (e3) return res.status(500).json({ success: false, message: e3.message });
                        db.run(`UPDATE legal_documents SET status='published', current_version_id=?, last_published_at=CURRENT_TIMESTAMP,
                                last_published_by=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`, [ver.id, by, doc.id], () => {
                            res.json({ success: true, message: 'Document published.', version_number: cleanNum, published_at: new Date().toISOString() });
                        });
                    });
            });
        };
        if (req.body.version_id) {
            publishVersion(parseInt(req.body.version_id));
        } else {
            db.get("SELECT id FROM legal_document_versions WHERE document_id = ? ORDER BY created_at DESC, id DESC LIMIT 1", [doc.id], (e4, latest) => {
                if (e4) return res.status(500).json({ success: false, message: e4.message });
                if (!latest) return res.status(400).json({ success: false, message: 'No version to publish.' });
                publishVersion(latest.id);
            });
        }
    });
});

// Route 6 — Restore a previous version as a new draft (write)
app.post('/api/admin/legal/documents/:type/restore/:versionId', requireAdmin, requireRole(['administrator']), (req, res) => {
    const type = req.params.type;
    db.get("SELECT id FROM legal_documents WHERE document_type = ?", [type], (err, doc) => {
        if (err) return res.status(500).json({ success: false, message: err.message });
        if (!doc) return res.status(400).json({ success: false, message: 'Unknown document type' });
        db.get("SELECT * FROM legal_document_versions WHERE id = ? AND document_id = ?", [req.params.versionId, doc.id], (e2, old) => {
            if (e2) return res.status(500).json({ success: false, message: e2.message });
            if (!old) return res.status(404).json({ success: false, message: 'Version not found.' });
            db.all("SELECT version_number FROM legal_document_versions WHERE document_id = ?", [doc.id], (e3, rows) => {
                const nextVer = computeNextLegalVersion(rows, true);
                db.run(`INSERT INTO legal_document_versions (document_id, version_number, content_html, change_summary, is_published)
                        VALUES (?,?,?,?,0)`, [doc.id, nextVer, old.content_html, 'Restored from version ' + old.version_number], function (e4) {
                    if (e4) return res.status(500).json({ success: false, message: e4.message });
                    db.run("UPDATE legal_documents SET status='draft', updated_at=CURRENT_TIMESTAMP WHERE id=?", [doc.id]);
                    res.json({ success: true, message: 'Restored as new draft.', new_version_id: this.lastID });
                });
            });
        });
    });
});

// Route 3 — Single document + current content + all versions
app.get('/api/admin/legal/documents/:type', requireAdmin, (req, res) => {
    db.get("SELECT * FROM legal_documents WHERE document_type = ?", [req.params.type], (err, doc) => {
        if (err) return res.status(500).json({ success: false, message: err.message });
        if (!doc) return res.status(404).json({ success: false, message: 'Unknown document type' });
        db.all("SELECT * FROM legal_document_versions WHERE document_id = ? ORDER BY created_at DESC, id DESC", [doc.id], (e2, versions) => {
            if (e2) return res.status(500).json({ success: false, message: e2.message });
            const current = (versions || []).find(v => v.id === doc.current_version_id) || null;
            res.json({ success: true, document: Object.assign({}, doc, {
                versions: versions || [],
                current_content_html: current ? current.content_html : '',
                current_version_number: current ? current.version_number : null
            }) });
        });
    });
});

// Route 7 — Consent audit (paginated, joined with booking name/email)
app.get('/api/admin/legal/consent-audit', requireAdmin, (req, res) => {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    // Cap at 10000 so the "Export CSV" path (limit=10000) returns the full set; the UI page-size
    // select only offers 20/50, so normal paged reads stay naturally bounded.
    const limit = Math.min(10000, Math.max(1, parseInt(req.query.limit) || 20));
    const search = (req.query.search || '').trim().substring(0, 100);
    const type = req.query.type || 'all';
    const offset = (page - 1) * limit;
    const conds = [], qp = [];
    if (type !== 'all') { conds.push("ca.consent_type = ?"); qp.push(type); }
    if (search) { const t = '%' + search + '%'; conds.push("(b.name LIKE ? OR b.email LIKE ? OR ca.ip_address LIKE ? OR ca.source_email LIKE ?)"); qp.push(t, t, t, t); }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    db.get(`SELECT COUNT(*) AS total FROM consent_audit ca LEFT JOIN bookings b ON b.id = ca.booking_id ${where}`, qp, (e1, cnt) => {
        if (e1) return res.status(500).json({ success: false, message: e1.message });
        db.all(`SELECT ca.id, ca.booking_id, ca.ip_address, ca.consented_at, ca.consent_type, ca.policy_version, ca.source_email, ca.consent_source,
                       b.name AS booking_name, b.email AS booking_email
                FROM consent_audit ca LEFT JOIN bookings b ON b.id = ca.booking_id
                ${where} ORDER BY ca.consented_at DESC, ca.id DESC LIMIT ? OFFSET ?`, [...qp, limit, offset], (e2, records) => {
            if (e2) return res.status(500).json({ success: false, message: e2.message });
            const total = cnt.total;
            res.json({ success: true, records: records || [], total, page, limit, pages: Math.ceil(total / limit) });
        });
    });
});

// Route 8 — Contract registry (all contracts joined with booking)
app.get('/api/admin/legal/contracts', requireAdmin, (req, res) => {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, parseInt(req.query.limit) || 20);
    const status = req.query.status || 'all';
    const search = (req.query.search || '').trim().substring(0, 100);
    const offset = (page - 1) * limit;
    const conds = [], qp = [];
    if (status !== 'all') { conds.push("c.status = ?"); qp.push(status); }
    if (search) { const t = '%' + search + '%'; conds.push("(b.name LIKE ? OR b.email LIKE ? OR b.event_name LIKE ?)"); qp.push(t, t, t); }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    db.get(`SELECT COUNT(*) AS total FROM contracts c LEFT JOIN bookings b ON b.id = c.booking_id ${where}`, qp, (e1, cnt) => {
        if (e1) return res.status(500).json({ success: false, message: e1.message });
        db.all(`SELECT c.id, c.booking_id, c.template_version, c.status, c.is_frozen, c.pdf_url, c.uploaded_by, c.signed_by, c.signed_date,
                       c.sent_to_client_at, c.signed_by_client_at, c.created_at, c.updated_at,
                       b.name AS client_name, b.email AS client_email, b.event_name, b.date AS event_date
                FROM contracts c LEFT JOIN bookings b ON b.id = c.booking_id
                ${where} ORDER BY c.updated_at DESC, c.id DESC LIMIT ? OFFSET ?`, [...qp, limit, offset], (e2, contracts) => {
            if (e2) return res.status(500).json({ success: false, message: e2.message });
            const total = cnt.total;
            res.json({ success: true, contracts: contracts || [], total, page, limit, pages: Math.ceil(total / limit) });
        });
    });
});

// Public — cookie policy wording for the public site's cookie banner (Gate 5 live sync)
app.get('/api/public/legal/cookie-policy', (req, res) => {
    db.get(`SELECT lv.content_html, lv.version_number, lv.published_at
            FROM legal_documents ld
            JOIN legal_document_versions lv ON lv.id = ld.current_version_id
            WHERE ld.document_type = 'cookie_policy'`, [], (err, row) => {
        if (err || !row) return res.json({ success: false });
        res.json({ success: true, content_html: row.content_html, version_number: row.version_number, published_at: row.published_at });
    });
});

// --- Settings ---
app.get('/api/admin/settings', requireAdmin, (req, res) => {
    db.all("SELECT setting_key, setting_value FROM settings", [], (err, rows) => {
        if (err) { console.error('load settings failed:', err); return res.status(500).json({ success: false, message: 'Could not load settings. Please try again.' }); }
        const obj = {};
        (rows || []).forEach(r => { obj[r.setting_key] = r.setting_value; });
        // Merge env-only keys so the frontend can read them (read-only exposure)
        if (process.env.CALENDAR_FEED_SECRET) obj.CALENDAR_FEED_SECRET = process.env.CALENDAR_FEED_SECRET;
        res.json({ success: true, settings: obj });
    });
});
app.put('/api/admin/settings', requireAdmin, (req, res) => {
    const { settings } = req.body;
    if (!settings || typeof settings !== 'object') return res.status(400).json({ error: 'settings object required.' });
    const envMap = {
        payfast_merchant_id: 'PAYFAST_MERCHANT_ID', payfast_merchant_key: 'PAYFAST_MERCHANT_KEY',
        payfast_passphrase: 'PAYFAST_PASSPHRASE', payfast_url: 'PAYFAST_URL',
        smtp_host: 'SMTP_HOST', smtp_port: 'SMTP_PORT', smtp_user: 'SMTP_USER',
        smtp_pass: 'SMTP_PASS', smtp_from: 'SMTP_FROM',
        email_banner: 'EMAIL_BANNER'
    };
    const keys = Object.keys(settings);
    let pending = keys.length;
    if (pending === 0) return res.json({ success: true });
    let failed = false;
    keys.forEach(key => {
        const val = String(settings[key]);
        if (val !== null && val !== undefined && val !== '') {
            if (envMap[key]) process.env[envMap[key]] = val;
        }
        db.run("INSERT OR REPLACE INTO settings (setting_key, setting_value, updated_at) VALUES (?,?,CURRENT_TIMESTAMP)",
            [key, val], (err) => {
                if (err && !failed) { failed = true; console.error('save settings failed:', err); return res.status(500).json({ success: false, message: 'Could not save settings. Please try again.' }); }
                if (--pending === 0 && !failed) res.json({ success: true });
            });
    });
});

// ─── Branding ───────────────────────────────────────────────────────────────
app.put('/api/admin/branding', requireAdmin, requireRole(['administrator']), (req, res) => {
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
        db.run(
            "INSERT OR REPLACE INTO settings (setting_key, setting_value, updated_at) VALUES (?,?,CURRENT_TIMESTAMP)",
            [key, val],
            (err) => {
                if (err && !failed) { failed = true; console.error('save branding failed:', err); return res.status(500).json({ success: false, message: 'Could not save branding. Please try again.' }); }
                if (--pending === 0 && !failed) res.json({ success: true });
            }
        );
    });
});

app.get('/api/public/branding', (req, res) => {
    const keys = ['site_logo', 'favicon', 'primary_color', 'theme_font', 'email_banner', 'login_background'];
    const ph = keys.map(() => '?').join(',');
    db.all(`SELECT setting_key, setting_value FROM settings WHERE setting_key IN (${ph})`, keys,
        (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            const branding = {};
            (rows || []).forEach(r => { branding[r.setting_key] = r.setting_value; });
            res.json({ success: true, branding });
        }
    );
});

app.post('/api/admin/settings/test-notification', requireAdmin, requireRole(['administrator']), async (req, res) => {
    try {
        const to = await getNotificationEmail();
        await sendEmail({
            to,
            subject: 'Test Notification — Thabiso Mhlongo Admin',
            htmlContent: emailComponents.renderSystemEmail({
                preheaderText: `Test notification — confirming admin routing to ${to}.`,
                category: 'System',
                severity: 'info',
                leadFact: `This is a test email confirming that admin notifications are correctly routed to <strong style="color:#FAFAFA;">${to}</strong>.`,
                timestamp: new Date().toISOString()
            }),
            preWrapped: true,
            trigger_event: 'Admin: Test Notification'
        });
        res.json({ success: true, message: `Test email sent to ${to}` });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// --- Invoice Actions ---
app.post('/api/admin/invoices/:id/send', requireAdmin, requireRole(['administrator', 'manager']), (req, res) => {
    db.get(`SELECT i.*, b.id as booking_id_num, b.email, b.name, b.event_name, b.event_type, b.date
            FROM invoices i JOIN bookings b ON i.booking_id = b.id WHERE i.id = ?`, [req.params.id], async (err, inv) => {
        if (err || !inv) return res.status(404).json({ error: 'Invoice not found.' });
        const invoiceFilePath = inv.file_path ? path.join(__dirname, 'docs', 'invoices', inv.file_path) : null;
        if (!invoiceFilePath || !fs.existsSync(invoiceFilePath)) {
            return res.status(400).json({ error: 'Invoice PDF not found. Please regenerate the invoice first.' });
        }
        try {
            const bookingObj = { id: inv.booking_id, name: inv.name, email: inv.email, event_name: inv.event_name, event_type: inv.event_type, date: inv.date };
            await sendInvoiceEmail(bookingObj, invoiceFilePath);
            db.run("UPDATE invoices SET sent_at = CURRENT_TIMESTAMP WHERE id = ?", [req.params.id], () => {});
            res.json({ success: true, message: `Invoice ${inv.invoice_number} resent to ${inv.email}.` });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
});
// POST /api/admin/invoices/bulk-send-unsent — email all generated-but-unsent invoices
app.post('/api/admin/invoices/bulk-send-unsent', requireAdmin, requireRole(['administrator', 'manager']), (req, res) => {
    db.all(
        `SELECT i.*, b.id AS booking_id_num, b.email, b.name, b.event_name, b.event_type, b.date
         FROM invoices i
         JOIN bookings b ON i.booking_id = b.id
         WHERE i.sent_at IS NULL AND i.status NOT IN ('VOID') AND b.status = 'CONFIRMED'`,
        [],
        async (err, rows) => {
            if (err) return res.status(500).json({ success: false, message: err.message });
            if (!rows.length) return res.json({ success: true, sent: 0, message: 'No unsent invoices.' });
            let sent = 0, failed = 0, errors = [];
            for (const inv of rows) {
                const invoiceFilePath = inv.file_path ? path.join(__dirname, 'docs', 'invoices', inv.file_path) : null;
                if (!invoiceFilePath || !fs.existsSync(invoiceFilePath)) { failed++; errors.push(inv.invoice_number + ': PDF missing'); continue; }
                try {
                    const bookingObj = { id: inv.booking_id, name: inv.name, email: inv.email, event_name: inv.event_name, event_type: inv.event_type, date: inv.date };
                    await sendInvoiceEmail(bookingObj, invoiceFilePath);
                    db.run("UPDATE invoices SET sent_at = CURRENT_TIMESTAMP WHERE id = ?", [inv.id], () => {});
                    sent++;
                } catch(e) { failed++; errors.push(inv.invoice_number + ': ' + e.message); }
            }
            res.json({ success: true, sent, failed, errors: errors.length ? errors : undefined });
        }
    );
});

app.post('/api/admin/invoices/:id/void', requireAdmin, requireRole(['administrator']), (req, res) => {
    const { reason } = req.body;
    if (!reason || !reason.trim()) {
        return res.status(400).json({ error: 'Void reason is required.' });
    }
    const adminUser = req.session.username || 'system';
    db.get('SELECT * FROM invoices WHERE id = ?', [req.params.id], (err, inv) => {
        if (err || !inv) return res.status(404).json({ error: 'Invoice not found.' });
        db.run(
            "UPDATE invoices SET status='VOID', void_reason=?, voided_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?",
            [reason.trim(), req.params.id],
            function(e2) {
                if (e2) return res.status(500).json({ error: e2.message });
                if (this.changes === 0) return res.status(404).json({ error: 'Invoice not found.' });
                // Audit log the void with mandatory reason
                db.run(
                    `INSERT INTO audit_log (table_name, record_id, action, changed_by, changes_json)
                     VALUES ('invoices', ?, 'VOID', ?, ?)`,
                    [req.params.id, adminUser, JSON.stringify({ reason: reason.trim(), invoice_number: inv.invoice_number })],
                    () => {}
                );
                // Log to financial_audit_log
                db.run(
                    `INSERT INTO financial_audit_log (event_type, entity_type, entity_id, amount, changed_by, notes)
                     VALUES ('INVOICE_VOIDED', 'invoice', ?, ?, ?, ?)`,
                    [req.params.id, parseFloat(inv.total_amount || 0), adminUser, `Reason: ${reason.trim()}, Invoice Number: ${inv.invoice_number}`],
                    () => {}
                );
                res.json({ success: true, message: `Invoice ${inv.invoice_number} voided.` });
            }
        );
    });
});

// POST /api/admin/invoices/:id/mark-paid — quick-mark an invoice as PAID
app.post('/api/admin/invoices/:id/mark-paid', requireAdmin, requireRole(['administrator', 'manager']), (req, res) => {
    const adminUser = req.session.username || 'system';
    db.get('SELECT * FROM invoices WHERE id = ?', [req.params.id], (err, inv) => {
        if (err || !inv) return res.status(404).json({ success: false, error: 'Invoice not found.' });
        if (inv.status === 'VOID') {
            return res.status(400).json({ success: false, error: 'Cannot mark a voided invoice as paid.' });
        }
        if (inv.status === 'PAID') {
            return res.json({ success: true, message: 'Invoice is already marked as paid.' });
        }
        db.run(
            "UPDATE invoices SET status='PAID', updated_at=CURRENT_TIMESTAMP WHERE id=?",
            [req.params.id],
            function(e2) {
                if (e2) return res.status(500).json({ success: false, error: e2.message });
                // Audit log
                db.run(
                    `INSERT INTO audit_log (table_name, record_id, action, changed_by, changes_json)
                     VALUES ('invoices', ?, 'MARK_PAID', ?, ?)`,
                    [req.params.id, adminUser, JSON.stringify({ invoice_number: inv.invoice_number, previous_status: inv.status })],
                    () => {}
                );
                // Log to financial_audit_log
                db.run(
                    `INSERT INTO financial_audit_log (event_type, entity_type, entity_id, amount, changed_by, notes)
                     VALUES ('INVOICE_MARKED_PAID', 'invoice', ?, ?, ?, ?)`,
                    [req.params.id, parseFloat(inv.total_amount || 0), adminUser, `Invoice Number: ${inv.invoice_number}`],
                    () => {}
                );
                res.json({ success: true, message: `Invoice ${inv.invoice_number} marked as PAID.` });
            }
        );
    });
});


// --- Booking Email Actions ---
app.post('/api/admin/bookings/:id/resend-quote', requireAdmin, async (req, res) => {
    db.get(`SELECT b.*, COALESCE(c.full_name, b.name) as client_name, COALESCE(c.email, b.email) as client_email
            FROM bookings b LEFT JOIN clients c ON b.client_id = c.id WHERE b.id = ?`,
        [req.params.id], async (err, b) => {
            if (err || !b) return res.status(404).json({ success: false });
            b.name = b.client_name || b.name; b.email = b.client_email || b.email;
            db.get("SELECT file_path FROM quotations WHERE booking_id = ? AND archived=0 ORDER BY version DESC LIMIT 1",
                [req.params.id], async (e, q) => {
                    if (!q) return res.status(404).json({ success: false, message: 'No quote found for this booking. Generate a quote first.' });
                    const pdfPath = path.join(__dirname, 'docs', 'quotes', q.file_path);
                    await sendQuoteEmail(b, b.quote_amount, pdfPath, q.file_path);
                    db.run("UPDATE quotations SET sent_at = CURRENT_TIMESTAMP WHERE booking_id = ? AND archived = 0", [req.params.id], () => {});
                    res.json({ success: true, message: 'Quote email resent.' });
                });
        });
});

app.post('/api/admin/bookings/:id/resend-confirmation', requireAdmin, async (req, res) => {
    db.get(`SELECT b.*, COALESCE(c.full_name, b.name) as client_name, COALESCE(c.email, b.email) as client_email
            FROM bookings b LEFT JOIN clients c ON b.client_id = c.id WHERE b.id = ?`,
        [req.params.id], async (err, b) => {
            if (err || !b) return res.status(404).json({ success: false });
            if (['CANCELLED', 'EXPIRED'].includes(b.status)) {
                return res.status(400).json({ success: false, message: `Cannot resend confirmation for a ${b.status} booking.` });
            }
            b.name = b.client_name || b.name; b.email = b.client_email || b.email;
            await sendBookingConfirmedEmail(b);
            res.json({ success: true, message: 'Confirmation email resent.' });
        });
});

app.post('/api/admin/bookings/:id/review-request', requireAdmin, (req, res) => {
    db.get(`SELECT b.*, COALESCE(c.full_name, b.name) as name, COALESCE(c.email, b.email) as email
            FROM bookings b LEFT JOIN clients c ON b.client_id = c.id WHERE b.id = ?`,
        [req.params.id], async (err, b) => {
            if (err || !b) return res.status(404).json({ success: false });
            if (b.status !== 'COMPLETED') return res.status(400).json({ success: false, message: 'Booking not completed.' });
            await sendReviewRequestEmail(b);
            res.json({ success: true });
        });
});

// Unlink a booking from its client record so COALESCE falls back to the booking's own name/email.
// Use when client_id was incorrectly assigned (e.g. email collision in findOrCreateClient).
app.post('/api/admin/bookings/:id/unlink-client', requireAdmin, (req, res) => {
    db.run("UPDATE bookings SET client_id = NULL WHERE id = ?", [req.params.id], function(err) {
        if (err) return res.status(500).json({ success: false, error: err.message });
        if (this.changes === 0) return res.status(404).json({ success: false, message: 'Booking not found.' });
        res.json({ success: true, message: `client_id cleared for booking #${req.params.id}` });
    });
});

// P3-12: Client duplicate detection — finds clients with the same phone number
// or very similar name (within 2-char edit distance) but different emails.
app.get('/api/admin/clients/duplicates', requireAdmin, (req, res) => {
    // Phone-based duplicates: same non-null phone, different email
    db.all(
        `SELECT a.id AS id_a, a.full_name AS name_a, a.email AS email_a, a.phone AS phone,
                b.id AS id_b, b.full_name AS name_b, b.email AS email_b,
                'phone' AS match_type
         FROM clients a
         JOIN clients b ON a.phone = b.phone
           AND a.id < b.id
           AND LOWER(a.email) != LOWER(b.email)
           AND a.phone IS NOT NULL AND a.phone != ''
         ORDER BY a.phone`,
        [],
        (pErr, phoneRows) => {
            if (pErr) return res.status(500).json({ success: false, error: pErr.message });
            // Name-based duplicates: same name (case-insensitive), different email
            db.all(
                `SELECT a.id AS id_a, a.full_name AS name_a, a.email AS email_a, a.phone AS phone_a,
                        b.id AS id_b, b.full_name AS name_b, b.email AS email_b, b.phone AS phone_b,
                        'name' AS match_type
                 FROM clients a
                 JOIN clients b ON LOWER(TRIM(a.full_name)) = LOWER(TRIM(b.full_name))
                   AND a.id < b.id
                   AND LOWER(a.email) != LOWER(b.email)
                 ORDER BY a.full_name`,
                [],
                (nErr, nameRows) => {
                    if (nErr) return res.status(500).json({ success: false, error: nErr.message });
                    const all = [...(phoneRows || []), ...(nameRows || [])];
                    res.json({ success: true, count: all.length, duplicates: all });
                }
            );
        }
    );
});

// S5-4: Threaded booking notes — replaces the single admin_notes text blob.
app.get('/api/admin/bookings/:id/notes', requireAdmin, (req, res) => {
    db.all(
        "SELECT id, note, author, created_at FROM booking_notes WHERE booking_id = ? ORDER BY created_at ASC",
        [req.params.id],
        (err, rows) => {
            if (err) return res.status(500).json({ success: false, error: err.message });
            res.json({ success: true, notes: rows || [] });
        }
    );
});

app.post('/api/admin/bookings/:id/notes', requireAdmin, (req, res) => {
    const { note, author } = req.body;
    if (!note || !note.trim()) return res.status(400).json({ success: false, message: 'Note text is required.' });
    db.run(
        "INSERT INTO booking_notes (booking_id, note, author) VALUES (?, ?, ?)",
        [req.params.id, note.trim(), (author || 'Admin').trim()],
        function(err) {
            if (err) return res.status(500).json({ success: false, error: err.message });
            db.get("SELECT id, note, author, created_at FROM booking_notes WHERE id = ?", [this.lastID], (e, row) => {
                res.json({ success: true, note: row });
            });
        }
    );
});

app.delete('/api/admin/bookings/:id/notes/:noteId', requireAdmin, (req, res) => {
    db.run(
        "DELETE FROM booking_notes WHERE id = ? AND booking_id = ?",
        [req.params.noteId, req.params.id],
        function(err) {
            if (err) return res.status(500).json({ success: false, error: err.message });
            if (this.changes === 0) return res.status(404).json({ success: false, message: 'Note not found.' });
            res.json({ success: true });
        }
    );
});

// --- Enhanced Bookings (with venue + invoice) ---
app.get('/api/admin/bookings/full', requireAdmin, (req, res) => {
    const { search, status, limit, offset } = req.query;
    const params = [];
    let whereClause = 'WHERE 1=1';
    if (search) {
        whereClause += ` AND (LOWER(COALESCE(c.full_name, b.name)) LIKE LOWER(?) OR LOWER(COALESCE(c.email, b.email)) LIKE LOWER(?) OR LOWER(b.event_name) LIKE LOWER(?))`;
        const s = `%${search}%`;
        params.push(s, s, s);
    }
    if (status && status !== 'ALL') {
        whereClause += ' AND b.status = ?';
        params.push(status);
    }
    const pageLimit = Math.min(parseInt(limit) || 500, 1000);
    const pageOffset = parseInt(offset) || 0;
    params.push(pageLimit, pageOffset);

    db.all(`SELECT b.*,
        COALESCE(c.full_name, b.name) AS name,
        COALESCE(c.email, b.email) AS email,
        COALESCE(c.phone, b.cell) AS cell,
        COALESCE(c.company_name, b.company) AS company,
        COALESCE(v.name, b.event_location) AS event_location,
        COALESCE(v.address, b.venue_address) AS venue_address,
        COALESCE(v.city, b.city) AS city,
        COALESCE(v.country, b.country) AS country,
        v.name AS venue_name,
        v.city AS venue_city,
        v.capacity AS venue_capacity,
        v.contact_name AS venue_contact,
        v.contact_phone AS venue_contact_phone,
        v.green_room_notes AS venue_notes,
        CASE WHEN lq.total_amount IS NOT NULL
             THEN printf('%.2f', lq.total_amount)
             ELSE b.quote_amount
        END AS quote_amount,
        (SELECT status FROM invoices WHERE booking_id = b.id AND UPPER(status) != 'VOID'
         ORDER BY created_at DESC LIMIT 1) AS invoice_status,
        (SELECT invoice_number FROM invoices WHERE booking_id = b.id AND UPPER(status) != 'VOID'
         ORDER BY created_at DESC LIMIT 1) AS invoice_number,
        (SELECT id FROM invoices WHERE booking_id = b.id AND UPPER(status) != 'VOID'
         ORDER BY created_at DESC LIMIT 1) AS invoice_id,
        (SELECT sent_at FROM invoices WHERE booking_id = b.id AND UPPER(status) != 'VOID'
         ORDER BY created_at DESC LIMIT 1) AS invoice_sent_at,
        (SELECT due_date FROM invoices WHERE booking_id = b.id AND UPPER(status) != 'VOID'
         ORDER BY created_at DESC LIMIT 1) AS invoice_due_date,
        (SELECT id FROM bookings WHERE rebooked_from_id = b.id LIMIT 1) AS rebooked_as_id
      FROM bookings b
      LEFT JOIN venues v ON b.venue_id = v.id
      LEFT JOIN clients c ON b.client_id = c.id
      LEFT JOIN quotations lq ON lq.id = (SELECT MAX(id) FROM quotations WHERE booking_id = b.id AND UPPER(status) != 'VOID')
      ${whereClause}
      ORDER BY b.created_at DESC LIMIT ? OFFSET ?`, params, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// --- Venues list for admin dropdowns ---
app.get('/api/admin/venues', requireAdmin, (req, res) => {
    db.all(`SELECT v.id, v.name, v.city, v.state, v.address, v.capacity,
                   v.contact_name, v.contact_phone, v.green_room_notes,
                   (SELECT COUNT(*) FROM bookings b WHERE b.venue_id = v.id) AS booking_count
            FROM venues v ORDER BY v.name`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// --- Link a booking to a venue ---
app.put('/api/admin/bookings/:id/venue', requireAdmin, (req, res) => {
    const { venue_id } = req.body;
    const bookingId = req.params.id;

    if (!venue_id) {
        // Unlinking
        db.run(
            `UPDATE bookings SET 
                venue_id = NULL, venue_place_id = NULL, venue_address = NULL, 
                city = NULL, country = NULL, modified_on = CURRENT_TIMESTAMP 
             WHERE id = ?`,
            [bookingId],
            function(err) {
                if (err) return res.status(500).json({ error: err.message });
                if (this.changes === 0) return res.status(404).json({ error: 'Booking not found.' });

                // Update associated event to remove venue link
                db.get("SELECT event_id FROM bookings WHERE id = ?", [bookingId], (eErr, bookingRow) => {
                    if (!eErr && bookingRow && bookingRow.event_id) {
                        db.run(
                            `UPDATE events SET 
                                venue_id = NULL, venue_map_link = NULL, 
                                modified_on = CURRENT_TIMESTAMP 
                             WHERE event_id = ?`,
                            [bookingRow.event_id]
                        );
                    }
                });

                // Sync to calendar
                db.get("SELECT * FROM bookings WHERE id = ?", [bookingId], (e, updated) => {
                    if (!e && updated) {
                        syncBookingToCalendar(updated).catch(ce => console.error('[Venue Unlink] Calendar sync failed:', ce.message));
                    }
                });

                res.json({ success: true, message: 'Venue unlinked.' });
            }
        );
    } else {
        // Linking by venue_id (legacy)
        db.get("SELECT * FROM venues WHERE id = ?", [venue_id], (vErr, venue) => {
            if (vErr || !venue) return res.status(400).json({ success: false, message: 'Venue not found.' });
            
            db.run(
                `UPDATE bookings SET 
                    venue_id = ?, venue_place_id = ?, event_location = ?, 
                    venue_address = ?, city = ?, country = ?, 
                    modified_on = CURRENT_TIMESTAMP 
                 WHERE id = ?`,
                [venue.id, venue.place_id, venue.name, venue.address, venue.city, venue.country, bookingId],
                function(err) {
                    if (err) return res.status(500).json({ error: err.message });
                    if (this.changes === 0) return res.status(404).json({ error: 'Booking not found.' });

                    // Update associated event
                    db.get("SELECT event_id FROM bookings WHERE id = ?", [bookingId], (eErr, bookingRow) => {
                        if (!eErr && bookingRow && bookingRow.event_id) {
                            const mapLink = `https://maps.google.com/?q=${encodeURIComponent(venue.name + ' ' + (venue.address || ''))}`;
                            db.run(
                                `UPDATE events SET 
                                    venue_name = ?, venue_id = ?, venue_map_link = ?, 
                                    modified_on = CURRENT_TIMESTAMP 
                                 WHERE event_id = ?`,
                                [venue.name, venue.id, mapLink, bookingRow.event_id]
                            );
                        }
                    });

                    // Sync to calendar
                    db.get("SELECT * FROM bookings WHERE id = ?", [bookingId], (e, updated) => {
                        if (!e && updated) {
                            syncBookingToCalendar(updated).catch(ce => console.error('[Venue Link] Calendar sync failed:', ce.message));
                        }
                    });

                    res.json({ success: true, message: 'Venue linked successfully.' });
                }
            );
        });
    }
});

// --- Link booking to a venue using Google Place details ---
app.put('/api/admin/bookings/:id/venue-google', requireAdmin, async (req, res) => {
    const { place_id, name, address, city, state, country, latitude, longitude } = req.body;
    const bookingId = req.params.id;

    if (!place_id || !name) {
        return res.status(400).json({ success: false, message: 'place_id and name are required.' });
    }

    try {
        const venueId = await new Promise((resolve, reject) => {
            db.get("SELECT id FROM venues WHERE place_id = ?", [place_id], (err, row) => {
                if (err) return reject(err);
                if (row) {
                    db.run(
                        `UPDATE venues SET 
                            name = ?, address = ?, city = ?, state = ?, country = ?, 
                            latitude = ?, longitude = ?, updated_at = CURRENT_TIMESTAMP 
                         WHERE id = ?`,
                        [name, address || null, city || null, state || null, country || null, latitude || null, longitude || null, row.id],
                        (upErr) => {
                            if (upErr) reject(upErr);
                            else resolve(row.id);
                        }
                    );
                } else {
                    db.run(
                        `INSERT INTO venues (name, address, city, state, country, place_id, latitude, longitude) 
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                        [name, address || null, city || null, state || null, country || null, place_id, latitude || null, longitude || null],
                        function(insErr) {
                            if (insErr) reject(insErr);
                            else resolve(this.lastID);
                        }
                    );
                }
            });
        });

        db.run(
            `UPDATE bookings SET 
                venue_id = ?, venue_place_id = ?, event_location = ?, 
                venue_address = ?, city = ?, country = ?, 
                modified_on = CURRENT_TIMESTAMP 
             WHERE id = ?`,
            [venueId, place_id, name, address || null, city || null, country || null, bookingId],
            function(err) {
                if (err) return res.status(500).json({ success: false, message: err.message });
                if (this.changes === 0) return res.status(404).json({ success: false, message: 'Booking not found.' });

                db.get("SELECT event_id FROM bookings WHERE id = ?", [bookingId], (eErr, bookingRow) => {
                    if (!eErr && bookingRow && bookingRow.event_id) {
                        const mapLink = `https://maps.google.com/?q=${encodeURIComponent(name + ' ' + (address || ''))}`;
                        db.run(
                            `UPDATE events SET 
                                venue_name = ?, venue_id = ?, venue_map_link = ?, 
                                modified_on = CURRENT_TIMESTAMP 
                             WHERE event_id = ?`,
                            [name, venueId, mapLink, bookingRow.event_id]
                        );
                    }
                });

                db.get("SELECT * FROM bookings WHERE id = ?", [bookingId], (e, updated) => {
                    if (!e && updated) {
                        syncBookingToCalendar(updated).catch(ce => console.error('[Venue Link] Calendar sync failed:', ce.message));
                    }
                });

                res.json({ success: true, message: 'Venue linked successfully.' });
            }
        );
    } catch(err) {
        console.error('[Link Google Venue Error]', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

// --- Booking Line Items + Transactions (lazy detail) ---
app.get('/api/admin/bookings/:id/details', requireAdmin, (req, res) => {
    const id = req.params.id;
    // Prefer booking_services if available, fallback to booking_line_items for legacy data
    db.all(`SELECT bs.*, bs.quantity_minutes as quantity, s.name as service_name, s.display_unit 
            FROM booking_services bs 
            LEFT JOIN services s ON bs.service_id = s.id 
            WHERE bs.booking_id = ?`, [id], (e1, servicesItems) => {
        
        db.get("SELECT * FROM cancellations WHERE booking_id = ?", [id], (e3, cancellation) => {
            const sendResponse = (items, txs) => {
                res.json({ 
                    line_items: items || [], 
                    transactions: txs || [],
                    cancellation: cancellation || null
                });
            };

            if (servicesItems && servicesItems.length > 0) {
                db.all("SELECT * FROM transactions WHERE booking_id = ? ORDER BY created_at DESC", [id], (e2, transactions) => {
                    sendResponse(servicesItems, transactions);
                });
            } else {
                // Legacy fallback
                db.all("SELECT bli.*, s.name as service_name FROM booking_line_items bli LEFT JOIN services s ON bli.service_id = s.id WHERE bli.booking_id = ?", [id], (e1, lineItems) => {
                    db.all("SELECT * FROM transactions WHERE booking_id = ? ORDER BY created_at DESC", [id], (e2, transactions) => {
                        sendResponse(lineItems, transactions);
                    });
                });
            }
        });
    });
});

// --- Bookings ---

// Admin: manually create a booking (bypasses public rate limiter + POPIA form)
app.post('/api/admin/bookings', requireAdmin, requireRole(['administrator', 'manager']), async (req, res) => {
    const { name, email, cell, company, event_date, event_start_time,
            event_name, event_type, event_location, status, budget_range, message,
            venue_place_id, city, venue_address, country, services, override_conflict,
            override_duplicate, override_working_hours, popia_consent } = req.body;

    if (!name || !email || !cell || !event_date || !event_name || !event_type || !event_location || !message)
        return res.status(400).json({ success: false, message: 'Missing required fields.' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(event_date))
        return res.status(400).json({ success: false, message: 'Invalid event date format.' });

    if ((status || '').toUpperCase() === 'CONFIRMED') {
        return res.status(400).json({ success: false, message: 'Direct manual creation in CONFIRMED status is blocked. Bookings must start as PENDING, QUOTED, or NEW and require payment to be confirmed.' });
    }

    const validStatuses = ['NEW','PENDING','QUOTED'];
    const bookingStatus = validStatuses.includes((status || '').toUpperCase()) ? status.toUpperCase() : 'NEW';

    // Duplicate check: same email + same date with an already-active booking
    const existingBooking = await new Promise(resolve =>
        db.get(
            `SELECT id FROM bookings
             WHERE lower(email) = lower(?) AND date = ? AND status NOT IN ('CANCELLED','EXPIRED')
             LIMIT 1`,
            [email, event_date],
            (_, row) => resolve(row)
        )
    );
    if (existingBooking && !override_duplicate) {
        return res.status(409).json({
            success: false,
            duplicate: true,
            existing_id: existingBooking.id,
            message: `An active booking (#${existingBooking.id}) already exists for this client on this date. Do you want to override and create this booking anyway?`
        });
    }

    // 1. SECURE SERVICE VALIDATION & SNAPSHOTTING
    if (!services || !Array.isArray(services) || services.length === 0) {
        return res.status(400).json({ success: false, message: 'At least one service must be selected.' });
    }

    const svcIds = services.map(s => parseInt(s.service_id)).filter(id => !isNaN(id));
    if (svcIds.length === 0) {
        return res.status(400).json({ success: false, message: 'Invalid services provided.' });
    }

    try {
        const placeholders = svcIds.map(() => '?').join(',');
        const query = `SELECT * FROM services WHERE id IN (${placeholders})`;
        const dbServices = await new Promise((resolve, reject) => {
            db.all(query, svcIds, (err, rows) => {
                if (err) reject(err); else resolve(rows || []);
            });
        });

        let selectedServices = [];
        let calculatedBaseScope = 0;

        for (const inputSvc of services) {
            const srv = dbServices.find(s => s.id === parseInt(inputSvc.service_id));
            if (!srv) {
                return res.status(400).json({ success: false, message: `Service ID ${inputSvc.service_id} is invalid.` });
            }

            const model = srv.pricing_model || 'flat';
            const isFlat = model === 'flat' || model === 'flat_fee';
            const isPerMinute = model === 'per_minute';
            const isPerHour = model === 'per_hour';
            
            const qtyMinutes = parseInt(inputSvc.quantity_minutes) || 1;
            const unitPrice = parseFloat(srv.base_price != null ? srv.base_price : (srv.default_price ?? 0));
            let lineTotal = 0;
            
            if (isFlat) {
                lineTotal = unitPrice;
            } else if (isPerMinute) {
                lineTotal = unitPrice * qtyMinutes;
            } else if (isPerHour) {
                lineTotal = unitPrice * Math.ceil(qtyMinutes / 60);
            } else {
                lineTotal = unitPrice * qtyMinutes;
            }
            
            calculatedBaseScope += lineTotal;
            selectedServices.push({
                service_id: srv.id,
                name: srv.name,
                quantity_minutes: isFlat ? 1 : qtyMinutes,
                unit_price: unitPrice,
                total_price: lineTotal,
                pricing_model: model
            });
        }

        // Calculate event duration
        const maxServiceMins = dbServices.reduce((max, srv) => {
            const rowInput = services.find(s => s.service_id == srv.id);
            const isDurationBased = srv.pricing_model === 'per_minute' || srv.pricing_model === 'per_hour';
            const qtyMins = rowInput ? parseInt(rowInput.quantity_minutes) : 0;
            const length = isDurationBased && qtyMins > 0 ? qtyMins : (parseInt(srv.performance_length_minutes) || 0);
            const total = length + (parseInt(srv.setup_time_minutes) || 0);
            return Math.max(max, total);
        }, 0);
        
        const durationMins = maxServiceMins > 0 ? maxServiceMins : 120;
        const startTime = moment(`${event_date} ${event_start_time || '18:00'}`).toISOString();
        const endTime   = moment(startTime).add(durationMins, 'minutes').toISOString();
        const perfEndTime = event_start_time ? addMinutesToTime(event_start_time, durationMins) : null;

        // Working hours check
        if (event_start_time && !override_working_hours) {
            const endHHMM = addMinutesToTime(event_start_time, durationMins);
            const wh = await isWithinWorkingHours(event_date, event_start_time, endHHMM);
            if (!wh.allowed) {
                return res.status(400).json({
                    success: false,
                    working_hours_violation: true,
                    message: `${wh.reason} Do you want to override and create this booking anyway?`
                });
            }
        }

        // Conflict check
        const isBusy = await hasCalendarConflict(startTime, endTime);
        if (isBusy && !override_conflict) {
            return res.status(409).json({
                success: false,
                conflict: true,
                message: "Scheduling Conflict Detected: Thabiso is busy or holds exist during this slot. Do you want to override and create this booking anyway?"
            });
        }

        const clientId = await findOrCreateClient(name, email, cell, company, null);
        const venueId = await findOrCreateVenueFromPlace(event_location, venue_address || null, city || null, country || null, venue_place_id || null);

        const outcome = await withDbTransaction(async () => {
            try {
                await dbRun("BEGIN IMMEDIATE");
            } catch (beginErr) {
                console.error('[Admin] BEGIN IMMEDIATE failed:', beginErr.message);
                return { status: 500, body: { success: false, message: 'Database lock error: ' + beginErr.message } };
            }

            try {
                // skipGoogle=true: the pre-lock check above already consulted Google free/busy.
                // Repeating that network round-trip while holding the write lock would stall every
                // other transaction for as long as Google takes to answer.
                if (!override_conflict) {
                    const lockedBusy = await hasCalendarConflict(startTime, endTime, null, true);
                    if (lockedBusy) {
                        await dbRun("ROLLBACK").catch(() => {});
                        return {
                            status: 409,
                            body: {
                                success: false,
                                conflict: true,
                                message: "Scheduling Conflict Detected: Thabiso is busy or holds exist during this slot. Do you want to override and create this booking anyway?"
                            }
                        };
                    }
                }

                if (!override_duplicate) {
                    const lockedDuplicate = await dbGet(
                        `SELECT id FROM bookings
                         WHERE lower(email) = lower(?) AND date = ? AND status NOT IN ('CANCELLED','EXPIRED')
                         LIMIT 1`,
                        [email, event_date]
                    );
                    if (lockedDuplicate) {
                        await dbRun("ROLLBACK").catch(() => {});
                        return {
                            status: 409,
                            body: {
                                success: false,
                                duplicate: true,
                                existing_id: lockedDuplicate.id,
                                message: `An active booking (#${lockedDuplicate.id}) already exists for this client on this date. Do you want to override and create this booking anyway?`
                            }
                        };
                    }
                }

                const initialQuoteAmountStr = `R ${calculatedBaseScope.toFixed(2)}`;
                const initialTotalAmount = calculatedBaseScope;
                const paymentStatus = 'UNPAID';
                const defaultQuoteExpiry = moment(event_date).subtract(14, 'days').format('YYYY-MM-DD');
                const consentVal = popia_consent !== undefined ? (popia_consent ? 1 : 0) : 1;

                const ins = await dbRun(
                    `INSERT INTO bookings
                        (name, company, email, cell, event_name, date, event_start_time, performance_start_time,
                         performance_end_time, performance_duration,
                         event_type, event_location, city, venue_place_id, budget_range, message, status,
                         popia_consent, consent_timestamp, client_id, venue_id,
                         quote_amount, total_amount, amount_outstanding, payment_status, quote_expiry_date, policy_version, source, consent_source)
                     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP,?,?,?,?,?,?,?,?,?, 'admin_recorded')`,
                    [
                        name, company || null, email, cell, event_name, event_date,
                        event_start_time || null, event_start_time || null,
                        perfEndTime, String(durationMins),
                        event_type, event_location,
                        city || null, venue_place_id || null,
                        budget_range || null, message, bookingStatus,
                        consentVal, clientId, venueId,
                        initialQuoteAmountStr, initialTotalAmount, initialTotalAmount, paymentStatus, defaultQuoteExpiry, CURRENT_POLICY_VERSION, 'admin'
                    ]
                );
                const bookingId = ins.lastID;

                // The consent record, the services and the audit row are part of the booking, not an
                // afterthought. These used to run AFTER `COMMIT` with their errors swallowed by a bare
                // console.error, so a failed insert left a committed booking with no services — and the
                // route still answered 200 success. They are now inside the transaction.
                await dbRun(
                    `INSERT INTO consent_audit (booking_id, ip_address, user_agent, policy_version, consent_source) VALUES (?, ?, ?, ?, 'admin_recorded')`,
                    [bookingId, req.ip || null, req.headers['user-agent'] || null, CURRENT_POLICY_VERSION]
                );

                for (const srv of selectedServices) {
                    await dbRun("INSERT INTO booking_services (booking_id, service_id, quantity_minutes, unit_price, total_price) VALUES (?, ?, ?, ?, ?)",
                        [bookingId, srv.service_id, srv.quantity_minutes, srv.unit_price, srv.total_price]);
                    await dbRun("INSERT INTO booking_line_items (booking_id, service_id, description, quantity, unit_price) VALUES (?, ?, ?, ?, ?)",
                        [bookingId, srv.service_id, srv.name, srv.quantity_minutes, srv.unit_price]);
                }

                await dbRun(
                    `INSERT INTO audit_log (table_name, record_id, action, new_values, changed_by, ip_address)
                     VALUES ('bookings', ?, 'CREATE', ?, ?, ?)`,
                    [
                        bookingId,
                        JSON.stringify({
                            name, email, cell, event_name, event_type, date: event_date, budget_range, status: bookingStatus, client_id: clientId, venue_id: venueId,
                            overrides: {
                                conflict: !!override_conflict,
                                duplicate: !!override_duplicate,
                                working_hours: !!override_working_hours
                            }
                        }),
                        req.session.username || 'admin',
                        req.ip || null
                    ]
                );

                await dbRun("COMMIT");
                return { ok: true, bookingId };
            } catch (dbErr) {
                await dbRun("ROLLBACK").catch(() => {});
                console.error('[Admin] Manual booking insert failed — rolled back, no partial booking saved:', dbErr.message);
                return { status: 500, body: { success: false, message: 'Database error: ' + dbErr.message } };
            }
        });

        if (!outcome.ok) return res.status(outcome.status).json(outcome.body);
        const bookingId = outcome.bookingId;

        // Sync to Google Calendar (non-blocking, after commit)
        syncBookingToCalendar(bookingId).catch(calErr => {
            console.error(`[Admin] Google Calendar sync failed for booking #${bookingId}:`, calErr.message);
        });

        res.json({ success: true, booking_id: bookingId, message: 'Booking created.' });
    } catch (err) {
        console.error('[Admin] Manual booking error:', err);
        return res.status(500).json({ success: false, message: 'Failed to create manual booking: ' + err.message });
    }
});

app.get('/api/admin/bookings', requireAdmin, (req, res) => {
    const {
        status, paymentStatus, search,
        dateFrom, dateTo,
        sortBy = 'created_at', order = 'DESC',
        limit = 100, offset = 0
    } = req.query;

    const conditions = [];
    const params = [];

    if (status) {
        const statuses = status.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
        if (statuses.length) {
            conditions.push(`b.status IN (${statuses.map(() => '?').join(',')})`);
            params.push(...statuses);
        }
    }
    if (paymentStatus) {
        const ps = paymentStatus.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
        if (ps.length) {
            conditions.push(`b.payment_status IN (${ps.map(() => '?').join(',')})`);
            params.push(...ps);
        }
    }
    if (dateFrom) { conditions.push('b.date >= ?'); params.push(dateFrom); }
    if (dateTo)   { conditions.push('b.date <= ?'); params.push(dateTo); }
    if (search) {
        conditions.push(`(LOWER(COALESCE(c.full_name, b.name)) LIKE ? OR LOWER(COALESCE(c.email, b.email)) LIKE ? OR CAST(b.id AS TEXT) = ?)`);
        const s = `%${search.toLowerCase()}%`;
        params.push(s, s, search);
    }

    const allowedSort = ['created_at', 'date', 'total_amount', 'status', 'name'];
    const safeSortBy = allowedSort.includes(sortBy) ? `b.${sortBy}` : 'b.created_at';
    const safeOrder = order.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const lim = Math.min(Math.max(parseInt(limit) || 100, 1), 500);
    const off = Math.max(parseInt(offset) || 0, 0);

    const countSql = `SELECT COUNT(*) as total FROM bookings b LEFT JOIN clients c ON b.client_id = c.id ${whereClause}`;
    db.get(countSql, params, (cntErr, countRow) => {
        if (cntErr) return res.status(500).json({ error: cntErr.message });
        const total = countRow ? countRow.total : 0;

        const dataSql = `SELECT b.*,
            COALESCE(c.full_name, b.name) AS name,
            COALESCE(c.email, b.email) AS email,
            COALESCE(c.phone, b.cell) AS cell,
            COALESCE(c.company_name, b.company) AS company,
            COALESCE(v.name, b.event_location) AS event_location,
            COALESCE(v.address, b.venue_address) AS venue_address,
            COALESCE(v.city, b.city) AS city,
            COALESCE(v.country, b.country) AS country,
            CASE WHEN lq.total_amount IS NOT NULL
                 THEN printf('%.2f', lq.total_amount)
                 ELSE b.quote_amount
            END AS quote_amount,
            v.green_room_notes,
            v.notes AS venue_notes,
            v.negotiated_rates AS venue_negotiated_rates,
            lq.sent_at AS quote_sent_at,
            li.id AS invoice_id,
            li.sent_at AS invoice_sent_at,
            li.status AS invoice_status,
            li.due_date AS invoice_due_date
          FROM bookings b
          LEFT JOIN venues v ON b.venue_id = v.id
          LEFT JOIN clients c ON b.client_id = c.id
          LEFT JOIN quotations lq ON lq.id = (SELECT MAX(id) FROM quotations WHERE booking_id = b.id AND archived = 0)
          LEFT JOIN invoices li ON li.id = (SELECT MAX(id) FROM invoices WHERE booking_id = b.id AND status NOT IN ('void','VOID'))
          ${whereClause}
          ORDER BY ${safeSortBy} ${safeOrder}
          LIMIT ? OFFSET ?`;

        db.all(dataSql, [...params, lim, off], (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ bookings: rows, total, limit: lim, offset: off });
        });
    });
});
app.get('/api/admin/bookings/:id', requireAdmin, (req, res) => {
    db.get(`SELECT b.*,
        COALESCE(c.full_name, b.name) AS name,
        COALESCE(c.email, b.email) AS email,
        COALESCE(c.phone, b.cell) AS cell,
        COALESCE(c.company_name, b.company) AS company,
        COALESCE(v.name, b.event_location) AS event_location,
        COALESCE(v.address, b.venue_address) AS venue_address,
        COALESCE(v.city, b.city) AS city,
        COALESCE(v.country, b.country) AS country,
        CASE WHEN lq.total_amount IS NOT NULL
             THEN printf('%.2f', lq.total_amount)
             ELSE b.quote_amount
        END AS quote_amount,
        v.green_room_notes,
        v.notes AS venue_notes,
        v.negotiated_rates AS venue_negotiated_rates,
        cnl.refund_due,
        cnl.retention_amount,
        cnl.total_paid_to_date AS cancellation_paid_snapshot,
        lq.sent_at AS quote_sent_at,
        li.id AS invoice_id,
        li.sent_at AS invoice_sent_at,
        li.status AS invoice_status,
        li.due_date AS invoice_due_date
      FROM bookings b
      LEFT JOIN venues v ON b.venue_id = v.id
      LEFT JOIN clients c ON b.client_id = c.id
      LEFT JOIN quotations lq ON lq.id = (SELECT MAX(id) FROM quotations WHERE booking_id = b.id AND archived = 0)
      LEFT JOIN cancellations cnl ON cnl.booking_id = b.id
      LEFT JOIN invoices li ON li.id = (SELECT MAX(id) FROM invoices WHERE booking_id = b.id AND status NOT IN ('void','VOID'))
      WHERE b.id = ?`, [req.params.id], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: "Booking not found" });

        db.all(`SELECT s.id AS service_id, s.name AS service_name, s.pricing_model, s.default_price, bs.quantity_minutes, bs.unit_price,
                       (bs.unit_price * bs.quantity_minutes) AS line_total
                FROM booking_services bs
                JOIN services s ON bs.service_id = s.id
                WHERE bs.booking_id = ?`, [req.params.id], (err2, services) => {
            row.services = services || [];
            res.json(row);
        });
    });
});
// Shared status-change logic used by both PUT /bookings/:id and PUT /bookings/:id/status
// options.reason — optional cancellation reason string (admin-supplied)
async function applyStatusChange(bookingId, requestedStatus, currentStatus, res, options = {}) {
    const ALLOWED_TRANSITIONS = {
        'NEW': ['PENDING','QUOTED','CANCELLED'],
        'PENDING': ['QUOTED','CANCELLED'],
        'QUOTED': ['ACCEPTED','CANCELLED'],
        'ACCEPTED': ['QUOTED','CONFIRMED','CANCELLED'],
        'CONFIRMED': ['COMPLETED','CANCELLED'],
        'COMPLETED': ['CANCELLED'],
        'CANCELLED': [],
        'EXPIRED': ['CANCELLED','PENDING']
    };
    const allowed = ALLOWED_TRANSITIONS[currentStatus] || [];
    if (!allowed.includes(requestedStatus)) {
        return res.status(400).json({ success: false, message: `Invalid transition from ${currentStatus} to ${requestedStatus}` });
    }
    // Guard: block COMPLETED when any payment is still outstanding
    if (requestedStatus === 'COMPLETED') {
        const chk = await new Promise(r => db.get("SELECT amount_outstanding FROM bookings WHERE id = ?", [bookingId], (e, row) => r({ e, row })));
        if (!chk.e) {
            const outstanding = parseFloat(chk.row?.amount_outstanding) || 0;
            if (outstanding > 0.01) {
                return res.status(400).json({ success: false, message: `Cannot complete — R${outstanding.toFixed(2)} is still outstanding. Record full payment before completing.` });
            }
        }
    }
    // pending_at is now tracked; all other timestamps already mapped
    const tsFields = { PENDING: 'pending_at', QUOTED: 'quoted_at', ACCEPTED: 'accepted_at', CONFIRMED: 'confirmed_at', COMPLETED: 'completed_at', CANCELLED: 'cancelled_at' };
    const tsField = tsFields[requestedStatus];
    const sql = tsField
        ? `UPDATE bookings SET status = ?, ${tsField} = CURRENT_TIMESTAMP WHERE id = ?`
        : `UPDATE bookings SET status = ? WHERE id = ?`;
    db.run(sql, [requestedStatus, bookingId], async function(upErr) {
        if (upErr) return res.status(500).json({ success: false, error: upErr.message });
        db.run(`INSERT INTO audit_log (table_name, record_id, action, old_values, new_values, changed_by, change_timestamp)
                VALUES ('bookings', ?, 'UPDATE', ?, ?, ?, CURRENT_TIMESTAMP)`,
            [bookingId, JSON.stringify({ status: currentStatus }), JSON.stringify({ status: requestedStatus, reason: options.reason || null }), options.adminId || 'admin'],
            (aErr) => { if (aErr) console.error('[Audit] Status change log failed:', aErr.message); });
        db.get("SELECT * FROM bookings WHERE id = ?", [bookingId], async (e, b) => {
            if (!e && b) {
                if (b.event_id && !['ACCEPTED', 'CONFIRMED', 'COMPLETED'].includes(requestedStatus)) {
                    db.run("UPDATE bookings SET is_public = 0, event_id = NULL WHERE id = ?", [bookingId]);
                    // On cancellation, switch the linked public event to draft rather than deleting it
                    if (requestedStatus === 'CANCELLED') {
                        db.run("UPDATE events SET event_status = 'draft', cancelled_at = CURRENT_TIMESTAMP, cancellation_reason = ? WHERE event_id = ?",
                            ['Linked booking #' + bookingId + ' was cancelled', b.event_id]);
                    }
                }

                if (requestedStatus === 'CANCELLED') {
                    const reason = options.reason || 'Booking cancelled by admin';
                    await deleteGoogleEvent(b.google_event_id);
                    // E1: store cancellation reason/attribution AND run the SAME financial + hold
                    // cascade as POST /api/admin/bookings/:id/cancel, so cancelling via the status
                    // API leaves an identical state (previously this path skipped payment_status,
                    // invoice void, schedule cancel and hold release).
                    // Same trigger constraint as the dedicated cancel route: 'CANCELLED' is not a legal
                    // payment_status, and this statement had no error callback — so the ABORT silently
                    // discarded cancellation_reason and cancelled_by along with it.
                    db.run("UPDATE bookings SET cancellation_reason = ?, cancelled_by = 'admin' WHERE id = ?", [reason, bookingId],
                        (e) => { if (e) console.error('[Status Cancel] Failed to record cancellation attribution:', e.message); });
                    db.run("UPDATE date_holds SET status = 'released' WHERE converted_to_booking_id = ?", [bookingId],
                        (e) => { if (e) console.error('[Status Cancel] Hold release failed:', e.message); });
                    db.run("UPDATE invoices SET status='VOID', void_reason='booking_cancelled', voided_at=CURRENT_TIMESTAMP WHERE booking_id=? AND status NOT IN ('VOID','PAID')", [bookingId],
                        (e) => { if (e) console.error('[Status Cancel] Invoice void failed:', e.message); });
                    db.run("UPDATE payment_schedules SET status='cancelled', updated_at=CURRENT_TIMESTAMP WHERE booking_id=? AND status='pending'", [bookingId],
                        (e) => { if (e) console.error('[Status Cancel] Payment schedule cancel failed:', e.message); });
                    // Apply the same refund policy calculator used by client self-cancellation
                    db.get("SELECT policy_value FROM policies WHERE policy_key = 'cancellation_policy'", [], (pErr, policy) => {
                        const calc = calculateCancellationRefund(b, policy ? policy.policy_value : '');
                        // D-1: cancellations.cancelled_by has a CHECK IN ('client','comedian','mutual','force_majeure')
                        // — 'admin' violated it, so this INSERT failed silently (no cancellation record via the
                        // status API). Use 'comedian' (business-initiated), matching the dedicated /cancel endpoint's
                        // default for admin-initiated cancellations. Attribution to admin stays on bookings.cancelled_by.
                        db.run(`INSERT INTO cancellations (booking_id, cancelled_by, reason, total_paid_to_date, refund_due, retention_amount, refund_status)
                                VALUES (?, 'comedian', ?, ?, ?, ?, 'pending')
                                ON CONFLICT(booking_id) DO UPDATE SET
                                cancelled_by='comedian', reason=excluded.reason, total_paid_to_date=excluded.total_paid_to_date,
                                refund_due=excluded.refund_due, retention_amount=excluded.retention_amount, refund_status='pending'`,
                            [bookingId, reason, calc.totalPaid, calc.refund, calc.retention],
                            (cErr) => { if (cErr) console.error('[Status Cancel] Cancellation record insert failed:', cErr.message); });
                        // SC-3: Include policy rule + timing in cancellation email
                        sendCancellationEmail(b, { reason, refund_due: calc.refund, rule: calc.rule, days_until_event: calc.daysUntilEvent }).catch(e => console.error('Cancel email failed:', e.message));
                    });
                } else {
                    await syncBookingToCalendar(b);
                }
                if (requestedStatus === 'PENDING') sendBookingUnderReviewEmail(b).catch(e => console.error('Under-review email failed:', e.message));
                if (requestedStatus === 'ACCEPTED') {
                    // Update active quotation's status to 'accepted'
                    db.run("UPDATE quotations SET status = 'accepted' WHERE booking_id = ? AND archived = 0", [bookingId], (err) => {
                        if (err) console.error('[Status Change] Failed to update quotation status to accepted:', err.message);
                    });
                    sendQuoteAcceptedEmail(b).catch(e => console.error('Invoiced email failed:', e.message));
                }
                if (requestedStatus === 'QUOTED') {
                    // Revert active quotation's status to 'sent'
                    db.run("UPDATE quotations SET status = 'sent' WHERE booking_id = ? AND archived = 0", [bookingId], (err) => {
                        if (err) console.error('[Status Change] Failed to revert quotation status to sent:', err.message);
                    });
                }
                if (requestedStatus === 'CONFIRMED') {
                    sendBookingConfirmedEmail(b).catch(e => console.error('Confirmed email failed:', e.message));
                    // Auto-create an events row if none exists yet for this booking
                    if (!b.event_id) {
                        const eventDatetime = b.date + (b.event_start_time ? ' ' + b.event_start_time : ' 00:00:00');
                        db.run(
                            `INSERT INTO events (event_title, event_datetime, venue_name, venue_id, booking_id, event_status, created_by)
                             VALUES (?, ?, ?, ?, ?, 'upcoming', NULL)`,
                            [b.event_name || b.event_type || 'Booking Event', eventDatetime, b.event_location || null, b.venue_id || null, b.id],
                            function(evInsErr) {
                                if (evInsErr) { console.error('[Auto-Event] Insert failed for booking #' + b.id + ':', evInsErr.message); return; }
                                db.run("UPDATE bookings SET event_id = ? WHERE id = ?", [this.lastID, b.id],
                                    (evUpErr) => { if (evUpErr) console.error('[Auto-Event] Booking event_id link failed:', evUpErr.message); });
                            }
                        );
                    }
                }
                if (requestedStatus === 'COMPLETED') {
                    sendBookingCompletedEmail(b).catch(e => console.error('Completed email failed:', e.message));
                    sendAdminCompletionSummaryEmail(b).catch(e => console.error('Admin completion summary failed:', e.message));
                    // S6-4: Auto-mark invoice as paid when booking is completed with full payment
                    db.run("UPDATE invoices SET status = 'PAID', updated_at = CURRENT_TIMESTAMP WHERE booking_id = ? AND status NOT IN ('VOID','PAID')", [b.id]);
                }
            }
        });
        res.json({ success: true, newStatus: requestedStatus });
    });
}

app.put('/api/admin/bookings/:id', requireAdmin, (req, res) => {
    const { status, reason } = req.body;
    if (!status) return res.status(400).json({ success: false, message: 'status field required.' });
    db.get("SELECT status FROM bookings WHERE id = ?", [req.params.id], (err, row) => {
        if (err || !row) return res.status(404).json({ success: false, message: 'Booking not found.' });
        applyStatusChange(req.params.id, status.toUpperCase(), (row.status || '').toUpperCase(), res, { reason, adminId: req.session.adminId });
    });
});

app.patch('/api/admin/bookings/:id/buffer', requireAdmin, (req, res) => {
    const id = parseInt(req.params.id);
    const raw = req.body.buffer_minutes;
    const mins = (raw === null || raw === '') ? null : parseInt(raw);
    if (mins !== null && (isNaN(mins) || mins < 0 || mins > 480)) {
        return res.status(400).json({ success: false, message: 'Buffer must be 0–480 minutes or null.' });
    }
    db.run("UPDATE bookings SET buffer_minutes = ? WHERE id = ?", [mins, id], function(err) {
        if (err) return res.status(500).json({ success: false, error: err.message });
        if (this.changes === 0) return res.status(404).json({ success: false, message: 'Booking not found.' });
        res.json({ success: true, buffer_minutes: mins });
    });
});

// --- Unified Calendar APIs (Phase 9) ---

/**
 * GET /api/admin/calendar/events
 * Aggregates Bookings, Holds, and Sites Events for FullCalendar
 */
app.get('/api/admin/calendar/events', requireAdmin, (req, res) => {
    const events = [];
    
    db.serialize(() => {
        // 1. Get Bookings — include timing columns so FullCalendar can render timed bars
        db.all(`SELECT b.id, COALESCE(c.full_name, b.name) AS name, b.event_name, b.date,
                       b.event_start_time, b.performance_end_time, b.performance_duration,
                       b.status, b.total_amount, b.payment_status,
                       b.amount_paid, b.amount_outstanding, b.quote_expiry_date,
                       b.cell, COALESCE(v.name, b.event_location) AS venue_name, b.city,
                       e.event_title AS linked_event_title, b.event_id
                FROM bookings b
                LEFT JOIN clients c ON b.client_id = c.id
                LEFT JOIN events e ON b.event_id = e.event_id
                LEFT JOIN venues v ON b.venue_id = v.id
                WHERE b.status != 'CANCELLED'`, [], (err, bookings) => {
            if (err) return res.status(500).json({ success: false, error: err.message });
            
            bookings.forEach(b => {
                let color = '#666'; // PENDING / other — neutral
                if (b.status === 'CONFIRMED' || b.status === 'COMPLETED') color = '#D4AF37'; // Gold
                else if (b.status === 'ACCEPTED') color = '#4ade80'; // Sage green
                else if (b.status === 'QUOTED')   color = '#fb923c'; // Orange
                else if (b.status === 'NEW')      color = '#60a5fa'; // Blue

                const displayName = b.linked_event_title || b.event_name || b.event_type || 'Booking';
                const prefix = b.linked_event_title ? '★ ' : '';
                let title = prefix + displayName + ' (' + b.name + ')';

                const hasAttachments = (() => { try { return JSON.parse(b.attachment_files || '[]').length > 0; } catch(e) { return false; } })();
                const ev = {
                    id: 'b-' + b.id,
                    title: title,
                    color: color,
                    extendedProps: {
                        type: 'booking', dbId: b.id, status: b.status, payment: b.payment_status, event_id: b.event_id,
                        isCalSynced: !!b.google_event_id,
                        isAccepted:  !!b.accepted_at,
                        isPopiaDone: !!b.popia_consent,
                        hasAttachments: hasAttachments,
                        venueName: b.venue_name || null,
                        city: b.city || null,
                        clientPhone: b.cell || null,
                        amountOutstanding: b.amount_outstanding != null ? b.amount_outstanding : (b.total_amount != null ? b.total_amount - (b.amount_paid || 0) : null),
                        quoteExpiryDate: b.quote_expiry_date || null
                    }
                };

                if (b.event_start_time) {
                    ev.start = b.date + 'T' + b.event_start_time;
                    const endTime = b.performance_end_time ||
                        addMinutesToTime(b.event_start_time, parseDurationToMinutes(b.performance_duration));
                    ev.end = b.date + 'T' + endTime;
                    ev.allDay = false;
                } else {
                    ev.start = b.date;
                    ev.allDay = true;
                }

                events.push(ev);
            });

            // 2. Get Manual Holds
            db.all(`SELECT id, hold_date, notes, start_time, end_time, block_type FROM date_holds WHERE status = 'active'`, [], (err, holds) => {
                if (err) holds = [];
                const holdColorMap = { unavailable: '#EF5350', personal: '#42A5F5', travel: '#66BB6A', maintenance: '#FFA726' };
                holds.forEach(h => {
                    const color = holdColorMap[h.block_type] || '#777';
                    const ev = {
                        id: 'h-' + h.id,
                        title: h.notes || 'Blocked',
                        color,
                        extendedProps: { type: 'hold', dbId: h.id, blockType: h.block_type }
                    };
                    if (h.start_time) {
                        ev.start = h.hold_date + 'T' + h.start_time;
                        ev.end   = h.hold_date + 'T' + (h.end_time || addMinutesToTime(h.start_time, 60));
                        ev.allDay = false;
                    } else {
                        ev.start  = h.hold_date;
                        ev.allDay = true;
                    }
                    events.push(ev);
                });

                // 3. Get Public Site Events
                db.all(`SELECT e.event_id, e.event_title, e.event_datetime, e.event_start_time, e.event_end_time, e.booking_id, v.name AS venue_name
                        FROM events e
                        LEFT JOIN venues v ON e.venue_id = v.id
                        WHERE e.event_status != 'draft'`, [], (err, siteEvents) => {
                    if (err) { /* skip site events on error, still return */ siteEvents = []; }
                    (siteEvents || []).forEach(se => {
                        if (!se.booking_id) { // Only show standalone events, bookings are already pushed
                            events.push({
                                id: 'e-' + se.event_id,
                                title: '[EVENT] ' + se.event_title + (se.venue_name ? ` (${se.venue_name})` : ''),
                                start: se.event_start_time ? (se.event_datetime || '').split('T')[0] + 'T' + se.event_start_time : (se.event_datetime || '').split('T')[0],
                                end:   se.event_end_time   ? (se.event_datetime || '').split('T')[0] + 'T' + se.event_end_time   : undefined,
                                color: '#17a2b8', // Teal
                                allDay: !se.event_start_time,
                                extendedProps: { type: 'public_event', dbId: se.event_id, venue: se.venue_name }
                            });
                        }
                    });

                    // Optionally append milestone events (quote expiries + payment due dates)
                    function sendEvents() {
                        if (req.query.include !== 'milestones') return res.json(events);
                        db.all(`SELECT b.id, COALESCE(c.full_name, b.name) AS name, b.quote_expiry_date
                                FROM bookings b LEFT JOIN clients c ON b.client_id = c.id
                                WHERE b.status = 'QUOTED' AND b.quote_expiry_date IS NOT NULL`, [], (e2, quoteds) => {
                            if (!e2 && quoteds) quoteds.forEach(q => events.push({
                                id: 'qex-' + q.id, title: 'Quote expires: ' + (q.name || 'Booking #' + q.id),
                                start: q.quote_expiry_date, allDay: true, color: '#fb923c',
                                extendedProps: { type: 'milestone', milestoneType: 'quote_expiry', dbId: q.id }
                            }));
                            db.all(`SELECT ps.id, ps.booking_id, ps.description, ps.due_date, ps.expected_amount,
                                           COALESCE(c.full_name, b.name) AS client_name
                                    FROM payment_schedules ps JOIN bookings b ON ps.booking_id = b.id
                                    LEFT JOIN clients c ON b.client_id = c.id
                                    WHERE ps.status = 'pending' AND ps.due_date IS NOT NULL`, [], (e3, scheds) => {
                                if (!e3 && scheds) scheds.forEach(s => {
                                    const overdue = new Date(s.due_date + 'T00:00:00') < new Date();
                                    events.push({
                                        id: 'ps-' + s.id,
                                        title: s.description + ': ' + (s.client_name || 'Booking #' + s.booking_id),
                                        start: s.due_date, allDay: true, color: overdue ? '#f87171' : '#fb923c',
                                        extendedProps: { type: 'milestone', milestoneType: 'payment_due', dbId: s.booking_id, isOverdue: overdue, amount: s.expected_amount }
                                    });
                                });
                                res.json(events);
                            });
                        });
                    }
                    sendEvents();
                });
            });
        });
    });
});

/**
 * POST /api/admin/calendar/hold
 * Create a manual date block
 */
app.post('/api/admin/calendar/hold', requireAdmin, (req, res) => {
    const { date, reason, category, start_time, end_time, block_type } = req.body;
    const notes = reason || category || 'Admin hold';
    if (!date) return res.status(400).json({ success: false, message: 'Date required.' });

    // Compare by minutes, not lexically (consistent with the booking-submit overlap / timeRangesOverlap):
    // a non-zero-padded time like "9:00" would break a string compare ("9:00" < "10:00" is false).
    const toMin = (t) => { const [h, m] = String(t).split(':').map(Number); return (h || 0) * 60 + (m || 0); };
    const overlap = (s1, e1, s2, e2) => (toMin(s1) < toMin(e2)) && (toMin(s2) < toMin(e1));

    // Check for conflicts
    db.all("SELECT id, start_time, end_time FROM date_holds WHERE hold_date = ? AND status = 'active'", [date], (err, holds) => {
        if (err) return res.status(500).json({ success: false, error: err.message });
        
        db.all("SELECT id, event_start_time, performance_end_time, performance_duration, event_type, buffer_minutes FROM bookings WHERE date = ? AND status NOT IN ('CANCELLED', 'EXPIRED')", [date], (err, bookings) => {
            if (err) return res.status(500).json({ success: false, error: err.message });

            let conflict = false;
            let conflictReason = '';

            if (!start_time) {
                // New hold is all day
                if ((holds && holds.length > 0) || (bookings && bookings.length > 0)) {
                    conflict = true;
                    conflictReason = 'A block or booking already exists on this date.';
                }
            } else {
                // New hold is timed — default end to 1 hour after start if not provided
                let effectiveEndTime = end_time;
                if (!effectiveEndTime) {
                    const ep = start_time.split(':');
                    let eh = parseInt(ep[0]) + 1;
                    if (eh >= 24) eh = 23;
                    effectiveEndTime = `${String(eh).padStart(2, '0')}:${ep[1]}`;
                }
                
                if (holds) {
                    holds.forEach(h => {
                        if (!h.start_time) {
                            conflict = true;
                            conflictReason = 'An all-day block exists on this date.';
                        } else if (overlap(start_time, effectiveEndTime, h.start_time, h.end_time || h.start_time)) {
                            conflict = true;
                            conflictReason = 'Overlaps with an existing block.';
                        }
                    });
                }
                
                if (bookings && !conflict) {
                    bookings.forEach(b => {
                        if (!b.event_start_time) return;
                        let bEnd = b.performance_end_time;
                        if (!bEnd) {
                            const mins = parseDurationToMinutes(b.performance_duration);
                            bEnd = addMinutesToTime(b.event_start_time, mins);
                        }
                        const holdGap = (b.buffer_minutes != null) ? b.buffer_minutes
                            : (b.event_type && TYPE_BUFFERS[b.event_type] !== undefined) ? TYPE_BUFFERS[b.event_type]
                            : MIN_BOOKING_GAP_MINS;
                        const bufferedBEnd = addMinutesToTime(bEnd, holdGap);
                        if (overlap(start_time, effectiveEndTime, b.event_start_time, bufferedBEnd)) {
                            conflict = true;
                            conflictReason = 'Overlaps with an existing booking.';
                        }
                    });
                }
            }
            
            if (conflict) {
                return res.status(409).json({ success: false, message: conflictReason });
            }

            const expires = new Date(date); expires.setDate(expires.getDate() + 1);
            const expiresStr = expires.toISOString().slice(0, 19).replace('T', ' ');
            db.run(
                `INSERT INTO date_holds (hold_date, notes, status, hold_expires_at, start_time, end_time, block_type)
                 VALUES (?, ?, 'active', ?, ?, ?, ?)`,
                [date, notes, expiresStr, start_time || null, end_time || null, block_type || null],
                function(insertErr) {
                    if (insertErr) return res.status(500).json({ success: false, error: insertErr.message });
                    res.json({ success: true, hold: { id: this.lastID } });
                }
            );
        });
    });
});

/**
 * DELETE /api/admin/calendar/hold/:id
 */
app.delete('/api/admin/calendar/hold/:id', requireAdmin, (req, res) => {
    db.run("DELETE FROM date_holds WHERE id = ?", [req.params.id], (err) => {
        if (err) return res.status(500).json({ success: false, error: err.message });
        res.json({ success: true });
    });
});

app.patch('/api/admin/calendar/hold/:id/date', requireAdmin, (req, res) => {
    const { date } = req.body;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return res.status(400).json({ success: false, message: 'Valid date (YYYY-MM-DD) required.' });
    }
    db.run("UPDATE date_holds SET hold_date = ?, hold_expires_at = datetime(?, '+1 day') WHERE id = ?",
        [date, date, req.params.id],
        (err) => {
            if (err) return res.status(500).json({ success: false, error: err.message });
            res.json({ success: true, newDate: date });
        });
});

/**
 * PATCH /api/admin/bookings/:id/date
 * Update booking event date and optionally time (used by FullCalendar eventDrop).
 * Accepts: { date: "YYYY-MM-DD", time?: "HH:MM" }
 */
app.patch('/api/admin/bookings/:id/date', requireAdmin, async (req, res) => {
    const { date, time } = req.body;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return res.status(400).json({ success: false, message: 'Valid date (YYYY-MM-DD) required.' });
    }
    if (time && !/^\d{2}:\d{2}$/.test(time)) {
        return res.status(400).json({ success: false, message: 'time must be HH:MM.' });
    }
    try {
        const row = await new Promise((resolve, reject) =>
            db.get("SELECT * FROM bookings WHERE id = ?", [req.params.id], (err, r) => err ? reject(err) : resolve(r)));
        if (!row) return res.status(404).json({ success: false, message: 'Booking not found.' });

        const oldDate = row.date;
        const oldTime = row.event_start_time;

        // Determine effective start/end times for conflict checking
        const effectiveTime = time !== undefined ? time : row.event_start_time;
        if (effectiveTime) {
            const durationMins = row.performance_end_time
                ? (() => {
                    const [eh, em] = row.performance_end_time.split(':').map(Number);
                    const [sh, sm] = row.event_start_time.split(':').map(Number);
                    return Math.max((eh * 60 + em) - (sh * 60 + sm), 30);
                  })()
                : parseDurationToMinutes(row.performance_duration);
            const newStartISO = moment(`${date} ${effectiveTime}`).toISOString();
            const newEndISO   = moment(newStartISO).add(durationMins, 'minutes').toISOString();
            const busy = await hasCalendarConflict(newStartISO, newEndISO, parseInt(req.params.id));
            if (busy) {
                return res.status(409).json({ success: false, message: `The new time slot on ${date} conflicts with an existing booking or block. Choose a different date/time.` });
            }
        }

        // Build update
        let newQuoteExpiry = row.quote_expiry_date;
        if (row.quote_expiry_date) {
            const eventMoment = moment(date);
            const currentExpiry = moment(row.quote_expiry_date);
            if (currentExpiry.isSameOrAfter(eventMoment)) {
                const proposed = eventMoment.clone().subtract(14, 'days');
                const minExpiry = moment().add(3, 'days');
                if (proposed.isBefore(minExpiry)) {
                    newQuoteExpiry = eventMoment.diff(moment(), 'days') > 3 ? minExpiry.format('YYYY-MM-DD') : null;
                } else {
                    newQuoteExpiry = proposed.format('YYYY-MM-DD');
                }
            }
        }

        // Compute new performance_end_time if time changed
        let newPerfEnd = row.performance_end_time;
        if (time !== undefined && time) {
            const dMins = parseDurationToMinutes(row.performance_duration) || 120;
            newPerfEnd = addMinutesToTime(time, dMins);
        }

        const setClauses = ['date = ?', 'quote_expiry_date = ?', 'modified_on = CURRENT_TIMESTAMP'];
        const params = [date, newQuoteExpiry];
        if (time !== undefined) {
            setClauses.push('event_start_time = ?');
            params.push(time || null);
            setClauses.push('performance_start_time = ?');
            params.push(time || null);
            setClauses.push('performance_end_time = ?');
            params.push(newPerfEnd || null);
        }
        params.push(req.params.id);

        await new Promise((resolve, reject) =>
            db.run(`UPDATE bookings SET ${setClauses.join(', ')} WHERE id = ?`, params, err => err ? reject(err) : resolve()));

        db.run(`INSERT INTO audit_log (table_name, record_id, action, old_values, new_values) VALUES ('bookings', ?, 'UPDATE', ?, ?)`,
            [req.params.id, JSON.stringify({ date: oldDate, time: oldTime }), JSON.stringify({ date, time })]);
        db.run("UPDATE date_holds SET hold_date = ? WHERE converted_to_booking_id = ?", [date, req.params.id]);

        // Sync linked event datetime when booking date changes
        if (row.event_id) {
            const effectiveStartTime = (time !== undefined ? time : row.event_start_time) || '00:00';
            const newEventDatetime = date + 'T' + effectiveStartTime;
            db.run("UPDATE events SET event_datetime = ?, modified_on = CURRENT_TIMESTAMP WHERE event_id = ?",
                [newEventDatetime, row.event_id],
                (evErr) => { if (evErr) console.error('[Date Change] Event datetime sync failed:', evErr.message); }
            );
        }

        db.get("SELECT * FROM bookings WHERE id = ?", [req.params.id], async (e, updated) => {
            if (!e && updated) syncBookingToCalendar(updated).catch(e => console.error('[Date Change] Calendar sync failed:', e.message));
        });

        sendDateChangedEmail(row, oldDate, date).catch(e => console.error('[Date Change] Client email failed:', e.message));

        res.json({ success: true, newDate: date, newTime: time !== undefined ? time : row.event_start_time });
    } catch (err) {
        console.error('[PATCH booking date]', err);
        res.status(500).json({ success: false, message: 'Server error updating booking date.' });
    }
});


/**
 * PATCH /api/admin/bookings/:id/venue
 * S5-2: Update booking location/venue details without regenerating the full quote.
 */
app.patch('/api/admin/bookings/:id/venue', requireAdmin, (req, res) => {
    const { event_location, venue_address, city, country, venue_type } = req.body;
    if (!event_location || !event_location.trim()) {
        return res.status(400).json({ success: false, message: 'event_location is required.' });
    }
    db.get("SELECT * FROM bookings WHERE id = ?", [req.params.id], (err, row) => {
        if (err || !row) return res.status(404).json({ success: false, message: 'Booking not found.' });
        const oldLocation = row.event_location;
        db.run(
            `UPDATE bookings SET event_location = ?, venue_address = ?, city = ?, country = ?,
             venue_type = ?, modified_on = CURRENT_TIMESTAMP WHERE id = ?`,
            [event_location.trim(), venue_address || null, city || null, country || null, venue_type || null, req.params.id],
            function(upErr) {
                if (upErr) return res.status(500).json({ success: false, error: upErr.message });
                db.run(
                    `INSERT INTO audit_log (table_name, record_id, action, old_values, new_values) VALUES ('bookings', ?, 'UPDATE', ?, ?)`,
                    [req.params.id, JSON.stringify({ event_location: oldLocation }), JSON.stringify({ event_location: event_location.trim() })]
                );
                db.get("SELECT * FROM bookings WHERE id = ?", [req.params.id], (e, updated) => {
                    if (!e && updated) {
                        syncBookingToCalendar(updated).catch(ce => console.error('[Venue Change] Calendar sync failed:', ce.message));
                    }
                });
                res.json({ success: true, message: 'Venue updated.' });
            }
        );
    });
});

/**
 * GET /api/calendar/feed.ics
 * Public (signed) ICS feed for external calendar sync
 */
app.get('/api/calendar/feed.ics', async (req, res) => {
    const expectedToken = process.env.CALENDAR_FEED_SECRET;
    if (expectedToken && req.query.token !== expectedToken) {
        return res.status(401).type('text').send('Unauthorized: invalid or missing calendar token.');
    }

    const ical = require('ical-generator').default;
    const calendar = ical({ name: 'Thabiso Mhlongo Schedule' });

    db.all(`SELECT b.id, COALESCE(c.full_name, b.name) AS name, b.event_name, b.date,
                   b.event_start_time, b.performance_end_time, b.performance_duration,
                   COALESCE(v.name, b.event_location) AS event_location
            FROM bookings b
            LEFT JOIN clients c ON b.client_id = c.id
            LEFT JOIN venues v ON b.venue_id = v.id
            WHERE b.status IN ('ACCEPTED', 'CONFIRMED', 'COMPLETED')`, [], (err, bookings) => {
        if (err) return res.status(500).send('Error generating calendar.');

        bookings.forEach(b => {
            const bStart = moment(`${b.date}T${b.event_start_time || '18:00'}`);
            let bEnd;
            if (b.performance_end_time) {
                bEnd = moment(`${b.date}T${b.performance_end_time}`);
            } else {
                const mins = parseDurationToMinutes(b.performance_duration);
                bEnd = bStart.clone().add(mins, 'minutes');
            }
            calendar.createEvent({
                start: bStart,
                end: bEnd,
                summary: (b.event_name || 'Booking') + ' - ' + b.name,
                location: b.event_location,
                url: `https://www.thabisomhlongo.com/admin#bookingsAdmin`
            });
        });

        db.all(`SELECT hold_date, notes, start_time, end_time FROM date_holds WHERE status = 'active'`, [], (err, holds) => {
            if (!err) {
                holds.forEach(h => {
                    if (h.start_time) {
                        const hEnd = h.end_time || addMinutesToTime(h.start_time, 60);
                        calendar.createEvent({
                            start: moment(`${h.hold_date}T${h.start_time}`),
                            end:   moment(`${h.hold_date}T${hEnd}`),
                            summary: '[HOLD] ' + (h.notes || 'Blocked')
                        });
                    } else {
                        calendar.createEvent({
                            start: moment(h.hold_date),
                            allDay: true,
                            summary: '[HOLD] ' + (h.notes || 'Blocked')
                        });
                    }
                });
            }

            res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
            res.setHeader('Content-Disposition', 'attachment; filename="thabiso_schedule.ics"');
            res.send(calendar.toString());
        });
    });
});

// Update booking public promotion status
app.put('/api/admin/bookings/:id/public', requireAdmin, (req, res) => {
    const { is_public, ticket_link } = req.body;

    // Validate ticket_link if provided
    if (ticket_link && ticket_link.trim() !== '') {
        try { new URL(ticket_link.trim()); } catch(e) {
            return res.status(400).json({ success: false, message: 'Invalid ticket URL. Please include https://...' });
        }
    }

    const cleanLink = (ticket_link && ticket_link.trim() !== '') ? ticket_link.trim() : null;
    const bookingId = req.params.id;

    db.get(
        `SELECT b.*, v.name AS venue_name 
         FROM bookings b 
         LEFT JOIN venues v ON b.venue_id = v.id 
         WHERE b.id = ?`,
        [bookingId],
        (err, booking) => {
            if (err) return res.status(500).json({ success: false, message: err.message });
            if (!booking) return res.status(404).json({ success: false, message: 'Booking not found.' });

            const isPromote = is_public ? 1 : 0;

            if (isPromote) {
                // Toggling ON
                const eventTime = booking.event_start_time || '19:00:00';
                const formattedTime = eventTime.includes(':') ? (eventTime.split(':').length === 2 ? `${eventTime}:00` : eventTime) : `${eventTime}:00:00`;
                const eventDatetime = `${booking.date}T${formattedTime}`;
                const venueName = booking.venue_name || booking.event_location || 'TBA';
                const eventTitle = booking.event_name || booking.event_type || 'Comedy Show';
                const eventDesc = booking.admin_notes || booking.notes || 'Public show';
                const ip_address = req.ip || req.connection.remoteAddress || 'unknown';
                const user_agent = req.get('User-Agent') || 'unknown';

                const mapLink = (booking.event_location || booking.venue_address)
                    ? `https://maps.google.com/?q=${encodeURIComponent((booking.event_location || '') + ' ' + (booking.venue_address || ''))}`
                    : null;

                const performInsert = () => {
                    db.run(
                        `INSERT INTO events (
                            event_title, event_description, event_datetime, 
                            venue_name, venue_id, venue_map_link, ticket_sales_link, 
                            booking_id, event_status, created_by, 
                            ip_address, user_agent
                         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)`,
                        [
                            eventTitle, eventDesc, eventDatetime, 
                            venueName, booking.venue_id || null, mapLink, cleanLink, 
                            bookingId, req.session.adminId, ip_address, user_agent
                        ],
                        function(insertErr) {
                            if (insertErr) return res.status(500).json({ success: false, message: insertErr.message });
                            const newEventId = this.lastID;

                            db.run(
                                "UPDATE bookings SET is_public = 1, ticket_link = ?, event_id = ? WHERE id = ?",
                                [cleanLink, newEventId, bookingId],
                                function(updateErr) {
                                    if (updateErr) return res.status(500).json({ success: false, message: updateErr.message });
                                    sendResponse();
                                }
                            );
                        }
                    );
                };

                if (booking.event_id) {
                    db.get("SELECT event_id FROM events WHERE event_id = ?", [booking.event_id], (checkErr, eventRow) => {
                        if (checkErr) return res.status(500).json({ success: false, message: checkErr.message });
                        if (eventRow) {
                            db.run(
                                `UPDATE events SET 
                                    event_title = ?, event_description = ?, event_datetime = ?, 
                                    venue_name = ?, venue_id = ?, venue_map_link = ?, ticket_sales_link = ?, 
                                    modified_by = ?, modified_on = CURRENT_TIMESTAMP, 
                                    ip_address = ?, user_agent = ? 
                                 WHERE event_id = ?`,
                                [
                                    eventTitle, eventDesc, eventDatetime, 
                                    venueName, booking.venue_id || null, mapLink, cleanLink, 
                                    req.session.adminId, ip_address, user_agent, 
                                    booking.event_id
                                ],
                                function(updateEventErr) {
                                    if (updateEventErr) return res.status(500).json({ success: false, message: updateEventErr.message });
                                    
                                    db.run(
                                        "UPDATE bookings SET is_public = 1, ticket_link = ? WHERE id = ?",
                                        [cleanLink, bookingId],
                                        function(updateErr) {
                                            if (updateErr) return res.status(500).json({ success: false, message: updateErr.message });
                                            sendResponse();
                                        }
                                    );
                                }
                            );
                        } else {
                            performInsert();
                        }
                    });
                } else {
                    performInsert();
                }
            } else {
                // Toggling OFF
                if (booking.event_id) {
                    db.run(
                        "UPDATE bookings SET is_public = 0, ticket_link = NULL, event_id = NULL WHERE id = ?",
                        [bookingId],
                        function(updateErr) {
                            if (updateErr) return res.status(500).json({ success: false, message: updateErr.message });
                            
                            db.run("DELETE FROM events WHERE event_id = ?", [booking.event_id], function(deleteErr) {
                                if (deleteErr) return res.status(500).json({ success: false, message: deleteErr.message });
                                sendResponse();
                            });
                        }
                    );
                } else {
                    db.run(
                        "UPDATE bookings SET is_public = 0, ticket_link = NULL WHERE id = ?",
                        [bookingId],
                        function(updateErr) {
                            if (updateErr) return res.status(500).json({ success: false, message: updateErr.message });
                            sendResponse();
                        }
                    );
                }
            }

            function sendResponse() {
                db.get(`SELECT b.event_name, b.event_type, b.date, b.event_start_time, b.event_location,
                               COALESCE(v.name, b.event_location) AS venue_display, b.is_public, b.ticket_link, b.event_id
                        FROM bookings b LEFT JOIN venues v ON b.venue_id = v.id WHERE b.id = ?`, [bookingId], (e, row) => {
                    res.json({ success: true, message: 'Promotion status updated.', preview: row || null });
                });
            }
        }
    );
});

app.put('/api/admin/bookings/:id/status', requireAdmin, (req, res) => {
    const requestedStatus = (req.body.status || '').toUpperCase();
    const reason = req.body.reason;
    if (!requestedStatus) return res.status(400).json({ success: false, message: 'status field required.' });
    db.get("SELECT status FROM bookings WHERE id = ?", [req.params.id], (err, row) => {
        if (err || !row) return res.status(404).json({ success: false, message: 'Booking not found' });
        applyStatusChange(req.params.id, requestedStatus, (row.status || '').toUpperCase(), res, { reason, adminId: req.session.adminId });
    });
});
app.post('/api/admin/bookings/:id/quote', requireAdmin, requireRole(['administrator', 'manager']), async (req, res) => {
    const bookingId = req.params.id;
    const isStructured = Array.isArray(req.body.items);
    
    db.get(`
        SELECT b.*, c.full_name as client_name, c.email as client_email, c.phone as client_phone, c.company_name as client_company
        FROM bookings b
        LEFT JOIN clients c ON b.client_id = c.id
        WHERE b.id = ?
    `, [bookingId], async (err, booking) => {
        try {
            if (err || !booking) return res.status(404).json({ success: false, message: 'Booking not found' });

            // Ensure we handle both legacy and relational fields for compatibility with pdfService
            booking.name = booking.client_name || booking.name;
            booking.email = booking.client_email || booking.email;
            booking.cell = booking.client_phone || booking.cell;
            booking.company = booking.client_company || booking.company;

            // Ensure client_id is resolved and updated in booking record if missing
            let clientId = booking.client_id;
            if (!clientId) {
                clientId = await findOrCreateClient(booking.name, booking.email, booking.cell, booking.company, booking.vat_number);
                await new Promise((resolve, reject) => {
                    db.run("UPDATE bookings SET client_id = ? WHERE id = ?", [clientId, bookingId], err => err ? reject(err) : resolve());
                });
                booking.client_id = clientId;
            }


            let quote_amount, quote_details, quote_expiry_date, finalTotal = 0;
            let items = [];

            if (isStructured) {
                const { quote_expiry_date: expiry, terms, items: bodyItems, discount, apply_vat } = req.body;
                if (!expiry || !bodyItems || bodyItems.length === 0) {
                    return res.status(400).json({ success: false, message: 'Missing required quote fields' });
                }
                if (booking.date && expiry >= booking.date) {
                    return res.status(400).json({ success: false, message: `Quote expiry date must be before the event date (${booking.date}).` });
                }
                if (expiry < new Date().toISOString().split('T')[0]) {
                    return res.status(400).json({ success: false, message: 'Quote expiry date cannot be in the past.' });
                }
                const minExpiry = new Date();
                minExpiry.setDate(minExpiry.getDate() + 3);
                if (expiry < minExpiry.toISOString().split('T')[0]) {
                    return res.status(400).json({ success: false, message: 'Quote expiry must be at least 3 days from today to give the client adequate time to respond.' });
                }
                
                bodyItems.forEach(i => {
                    i.quantity_minutes = parseFloat(i.quantity_minutes) || parseFloat(i.quantity) || 1; // normalization
                });

                // Conflict check
                if (!req.body.override_conflict && booking.date) {
                    const serviceIds = bodyItems.filter(i => i.service_id).map(i => i.service_id);
                    if (serviceIds.length) {
                        const dbServices = await new Promise((resolve) => {
                            db.all(`SELECT * FROM services WHERE id IN (${serviceIds.map(() => '?').join(',')})`, serviceIds, (err, rows) => resolve(rows || []));
                        });
                        
                        const maxServiceMins = dbServices.reduce((max, srv) => {
                            const rowInput = bodyItems.find(s => s.service_id == srv.id);
                            const isDurationBased = srv.pricing_model === 'per_minute' || srv.pricing_model === 'per_hour';
                            const qtyMins = rowInput ? (parseFloat(rowInput.quantity_minutes) || parseFloat(rowInput.quantity) || 0) : 0;
                            const length = isDurationBased && qtyMins > 0 ? qtyMins : (parseInt(srv.performance_length_minutes) || 0);
                            const total = length + (parseInt(srv.setup_time_minutes) || 0);
                            return Math.max(max, total);
                        }, 0);
                        
                        const durationMins = maxServiceMins > 0 ? maxServiceMins : 120;
                        const event_start_time = booking.event_start_time || '18:00';
                        const startTime = moment(`${booking.date} ${event_start_time}`).toISOString();
                        const endTime   = moment(startTime).add(durationMins, 'minutes').toISOString();
                        
                        // 1. Calendar conflict check
                        const isBusy = await hasCalendarConflict(startTime, endTime, bookingId);
                        if (isBusy) {
                            return res.status(409).json({
                                success: false,
                                conflict: true,
                                message: "Scheduling Conflict Detected: Thabiso is busy or holds exist during this slot. Do you want to override and send this quote anyway?"
                            });
                        }
                        
                        // 2. per_day availability rule check
                        const hasPerDayService = dbServices.some(s => s.availability_rule === 'per_day');
                        if (hasPerDayService) {
                            const conflictingBooking = await new Promise((resolve) => {
                                db.get(`
                                    SELECT b.id, b.event_name, s.name AS service_name
                                    FROM booking_services bs
                                    JOIN services s ON bs.service_id = s.id
                                    JOIN bookings b ON bs.booking_id = b.id
                                    WHERE b.date = ? 
                                      AND b.id != ? 
                                      AND b.status NOT IN ('CANCELLED', 'EXPIRED')
                                      AND s.availability_rule = 'per_day'
                                    LIMIT 1
                                `, [booking.date, bookingId], (err, row) => resolve(row));
                            });
                            if (conflictingBooking) {
                                return res.status(409).json({
                                    success: false,
                                    conflict: true,
                                    message: `Scheduling Conflict Detected: "${conflictingBooking.service_name}" is already booked on this day (Booking #${conflictingBooking.id}: "${conflictingBooking.event_name}"). Do you want to override and send this quote anyway?`
                                });
                            }
                        }
                    }
                }

                // FIN-2: tag each line's tax_class from the services catalog, then compute totals with
                // the shared helper so VAT is charged only on taxable lines and the quote total, the
                // stored invoice, and the PDF all agree.
                await resolveLineTaxClasses(bodyItems);
                let dp = parseFloat(discount) || 0;
                const vatRate = await getVatRate();
                const totals = computeDocumentTotals(bodyItems, { discount: dp, applyVat: !!apply_vat, vatRate });
                let subtotal = totals.subtotal;
                let vat = totals.vat;
                finalTotal = totals.total;
                items = bodyItems;

                quote_amount = finalTotal.toFixed(2);
                quote_details = JSON.stringify({ terms, items, discount: dp, apply_vat, finalTotal, subtotal, vat });
                quote_expiry_date = expiry;
                booking.discount = dp;
                booking.vat_rate = vatRate; // FIN-1/2: quote PDF uses the same rate as the calc
                booking.terms = terms;
            } else {
                // Unstructured fallback (legacy) — normalize to plain numeric string
                quote_amount = parseFloat((req.body.quote_amount || '0').replace(/[^0-9.]/g, '')).toFixed(2);
                quote_details = req.body.quote_details;
                quote_expiry_date = req.body.quote_expiry_date;
                finalTotal = parseFloat((quote_amount || '0').replace(/[^0-9.]/g, '')) || 0;
                items = [{ description: quote_details || 'Booking Service', quantity_minutes: 0, unit_price: finalTotal }];
                
                if (!quote_amount || !quote_details || !quote_expiry_date) {
                    return res.status(400).json({ success: false, message: 'Missing required quote fields' });
                }
            }

            const currentStatus = (booking.status || '').toUpperCase();
            // Gap 3 (Phase 2): re-quoting a booking the client has already committed to returns it to
            // QUOTED, supersedes its unpaid milestones and voids its live invoice, so the client must
            // consent to the new total. Paid milestones and any PAID invoice survive — that money moved.
            //
            // "Committed" means ACCEPTED *or* CONFIRMED. A deposit confirms a booking, and CONFIRMED
            // used to be excluded here: total_amount silently moved to the new figure while the invoice
            // and the payment plan still described the old one, and the client could not re-accept
            // (accept-quote requires QUOTED), so the booking was stranded mid-negotiation.
            //
            // The writes this implies live INSIDE the transaction below — they used to run here, before
            // it opened, fire-and-forget with no error callback, so a rolled-back quote left the booking
            // committed with its schedules superseded and its invoice VOID.
            const reQuotingCommitted = currentStatus === 'ACCEPTED' || currentStatus === 'CONFIRMED';
            let nextStatus = ['NEW', 'PENDING', 'REVIEWED', 'ACCEPTED', 'CONFIRMED'].includes(currentStatus) ? 'QUOTED' : currentStatus;

            // Ensure directory exists
            const quotesDir = path.join(__dirname, 'docs', 'quotes');
            if (!fs.existsSync(quotesDir)) fs.mkdirSync(quotesDir, { recursive: true });

            // Allocate the quote number the same way generateInvoice() allocates an invoice number.
            // `quotations.quote_number` is UNIQUE and the timestamp only resolves to the second, so two
            // quotes for one booking inside the same second — a double-click on Generate Quote — used to
            // collide and roll the second one back with a 500. A revision suffix disambiguates them, and
            // an archived quote keeps its number.
            //   first:  QT-44-260710143012
            //   again:  QT-44-260710143012-R2, -R3, …
            const baseQuoteNumber = `QT-${bookingId}-${moment().format('YYMMDDHHmmss')}`;
            const priorQuotes = await new Promise((resolve, reject) =>
                db.get(
                    `SELECT COUNT(*) AS c FROM quotations
                     WHERE quote_number = ? OR quote_number LIKE ?`,
                    [baseQuoteNumber, `${baseQuoteNumber}-R%`],
                    (e, r) => e ? reject(e) : resolve(r ? r.c : 0)
                ));
            const quoteNumber = priorQuotes === 0 ? baseQuoteNumber : `${baseQuoteNumber}-R${priorQuotes + 1}`;

            // Generate PDF
            const pdfFileName = `${quoteNumber}.pdf`;
            const pdfPath = path.join(quotesDir, pdfFileName);

            // Pass apply_vat to booking object for pdfService
            booking.apply_vat = req.body.apply_vat;

            try {
                // quoteNumber is passed through so the number on the client's PDF is the number stored in
                // `quotations.quote_number`, as invoices now do.
                const pdfResult = await pdfService.generateDocument('Quote', booking, items, pdfPath, [], quoteNumber);
                
                // Archive the old quotation, restamp the booking, insert the new versioned quotation
                // and rebuild its line-item snapshot — one atomic unit, queued behind every other
                // guarded transaction on the shared connection.
                //
                // The two DELETEs below previously ran with their error callbacks issuing a ROLLBACK
                // and a 500 while the insertNext() chain carried on regardless, so a failed clear
                // could produce a second response on the same request.
                const quoteResult = await withDbTransaction(async () => {
                    try {
                        await dbRun("BEGIN IMMEDIATE");
                    } catch (beginErr) {
                        console.error('[Quote] BEGIN IMMEDIATE failed:', beginErr.message);
                        return { status: 500, body: { success: false, message: 'Database busy. Please retry.' } };
                    }
                    try {
                        // Re-quoting an ACCEPTED booking: supersede its stale schedules and void its
                        // live invoice, atomically with the new quote. If the quote fails, none of
                        // this happens and the booking keeps the plan the client already accepted.
                        if (reQuotingCommitted) {
                            await dbRun("UPDATE payment_schedules SET status = 'superseded' WHERE booking_id = ? AND LOWER(COALESCE(status,'pending')) != 'paid'", [bookingId]);
                            await dbRun("UPDATE invoices SET status = 'VOID', void_reason = 'superseded_by_requote', voided_at = CURRENT_TIMESTAMP WHERE booking_id = ? AND UPPER(status) NOT IN ('VOID','PAID')", [bookingId]);
                            await dbRun(`INSERT INTO audit_log (table_name, record_id, action, new_values, changed_by, change_timestamp)
                                    VALUES ('bookings', ?, 'REQUOTE_AFTER_ACCEPTED', ?, ?, CURRENT_TIMESTAMP)`,
                                [bookingId, JSON.stringify({ previous_status: currentStatus, new_status: 'QUOTED' }), req.session.adminId || 'admin']);
                        }

                        // Archive all previous active quotations for this booking
                        await dbRun(
                            "UPDATE quotations SET archived = 1, status = CASE WHEN status = 'sent' THEN 'archived' ELSE status END WHERE booking_id = ? AND archived = 0",
                            [bookingId]
                        );

                        // 1. Update Booking.
                        // quote_amount is kept on bookings for backward-compat (legacy email templates + admin UI
                        // fallback). The bookings SELECT query prefers quotations.total_amount when a quotations
                        // row exists. We also update quote_details JSON for fallback/caching on details/invoice generation.
                        const currentPaid = parseFloat(booking.amount_paid) || 0;
                        const newOutstanding = Math.max(0, finalTotal - currentPaid);
                        await dbRun(
                            "UPDATE bookings SET quote_amount = ?, quote_details = ?, quote_expiry_date = ?, status = ?, quoted_at = CURRENT_TIMESTAMP, total_amount = ?, amount_outstanding = ? WHERE id = ?",
                            [quote_amount, quote_details, quote_expiry_date, nextStatus, finalTotal, newOutstanding, bookingId]
                        );

                        // 2. Next version
                        const vRow = await dbGet("SELECT COALESCE(MAX(version), 0) + 1 AS next_version FROM quotations WHERE booking_id = ?", [bookingId]);
                        const nextVersion = vRow ? vRow.next_version : 1;

                        // 3. Insert new versioned Quotation
                        const qIns = await dbRun(
                            "INSERT INTO quotations (booking_id, quote_number, client_id, quote_date, expiry_date, total_amount, status, file_path, version, archived, sent_at) VALUES (?, ?, ?, CURRENT_DATE, ?, ?, 'sent', ?, ?, 0, CURRENT_TIMESTAMP)",
                            [bookingId, quoteNumber, booking.client_id, quote_expiry_date, finalTotal, pdfFileName, nextVersion]
                        );
                        const quotationId = qIns.lastID;

                        // 4. Refresh line items (current snapshot)
                        await dbRun("DELETE FROM booking_line_items WHERE booking_id = ?", [bookingId]);
                        await dbRun("DELETE FROM booking_services WHERE booking_id = ?", [bookingId]);

                        for (const it of items) {
                            const q = parseFloat(it.quantity_minutes) || parseFloat(it.quantity) || 0;
                            const p = parseFloat(it.unit_price) || 0;
                            const desc = it.description || it.service_name || 'Service';
                            await dbRun("INSERT INTO booking_line_items (booking_id, service_id, description, quantity, unit_price) VALUES (?, ?, ?, ?, ?)",
                                [bookingId, it.service_id || null, desc, q || 1, p]);
                            if (it.service_id) {
                                await dbRun("INSERT INTO booking_services (booking_id, service_id, quantity_minutes, unit_price, total_price) VALUES (?, ?, ?, ?, ?)",
                                    [bookingId, it.service_id, q, p, q * p]);
                            }
                            await dbRun("INSERT INTO quote_line_items (quotation_id, service_id, description, quantity, unit_price) VALUES (?, ?, ?, ?, ?)",
                                [quotationId, it.service_id || null, desc, q, p]);
                        }

                        // P3-3: Audit log for quote generation — inside the transaction, so a rollback
                        // never leaves a log entry for a quote that was not issued.
                        await dbRun(`INSERT INTO audit_log (table_name, record_id, action, new_values, changed_by, change_timestamp)
                                     VALUES ('quotations', ?, 'QUOTE_GENERATED', ?, ?, CURRENT_TIMESTAMP)`,
                            [bookingId, JSON.stringify({ version: nextVersion, amount: finalTotal, expiry: quote_expiry_date }), req.session.adminId || 'admin']);

                        await dbRun("COMMIT");
                        return { ok: true, nextVersion };
                    } catch (txErr) {
                        await dbRun("ROLLBACK").catch(() => {});
                        console.error("[Quote] Generation failed — rolled back, quote not issued:", txErr.message);
                        // The structured branch takes items[].service_id on trust, and
                        // booking_services.service_id carries a foreign key. An unknown id therefore
                        // aborts the insert; that is the admin's mistake, not a server fault.
                        if (/SQLITE_CONSTRAINT/i.test(txErr.message || '') && /FOREIGN KEY/i.test(txErr.message || '')) {
                            return { status: 400, body: { success: false, message: 'One or more selected services no longer exist. Refresh the service list and rebuild the quote.' } };
                        }
                        return { status: 500, body: { success: false, message: 'Database error: ' + txErr.message } };
                    }
                });

                if (!quoteResult.ok) return res.status(quoteResult.status).json(quoteResult.body);
                const nextVersion = quoteResult.nextVersion;

                // ---- Side effects, after the commit ----
                syncBookingToCalendar(booking).catch(e => console.error('[Quote] Calendar sync failed:', e.message));
                sendQuoteEmail(booking, quote_amount, pdfPath, pdfFileName, items).catch(e => console.error("Quote email error:", e));
                sendAdminQuoteSentNotification(booking, quote_amount).catch(e => console.error('[Quote] Admin notif failed:', e.message));

                // Per-day availability warning (non-blocking for admins)
                const perDaySvcIds = items.filter(i => i.service_id).map(i => i.service_id);
                const sendResponse = (warnings) => res.json({ success: true, message: 'Quote generated and sent.', status: nextStatus, pdfUrl: `/docs/quotes/${pdfFileName}`, version: nextVersion, warnings: warnings.length ? warnings : undefined });
                if (perDaySvcIds.length && !req.body.override_conflict) {
                    db.all(`SELECT name FROM services WHERE id IN (${perDaySvcIds.map(() => '?').join(',')}) AND availability_rule = 'per_day'`, perDaySvcIds, (_, perDayRows) => {
                        sendResponse((perDayRows || []).map(s => `"${s.name}" is limited to one booking per day — verify no date conflicts exist.`));
                    });
                } else {
                    sendResponse([]);
                }
        } catch (pdfErr) {
            console.error("PDF/Quote Error:", pdfErr);
            res.status(500).json({ success: false, message: 'Failed to generate quote PDF.' });
        }
        } catch (topLevelError) {
            console.error("Unhandled Top Level Error in Quote Generation:", topLevelError);
            require('fs').writeFileSync(__dirname + '/scratch/quote-error-toplevel.log', topLevelError.stack || topLevelError.message);
            if (!res.headersSent) {
                res.status(500).json({ success: false, message: 'Internal server error during quote generation: ' + topLevelError.message });
            }
        }
    });
});

app.get('/api/admin/bookings/:id/quote-history', requireAdmin, (req, res) => {
    db.all(
        `SELECT id, quote_number, version, total_amount, status, created_at, file_path, archived
         FROM quotations WHERE booking_id = ? ORDER BY version DESC`,
        [req.params.id], (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json((rows || []).map(r => ({
                ...r,
                pdf_url: r.file_path ? `/docs/quotes/${r.file_path}` : null
            })));
        }
    );
});

// ==========================================
// Financial & Invoicing Routes
// ==========================================

// 1. Generate Invoice from Booking (Admin)
app.post('/api/admin/bookings/:id/invoice/generate', requireAdmin, requireRole(['administrator', 'manager']), async (req, res) => {
    const bookingId = req.params.id;
    // Guard: if a quotation exists for this booking it must be in 'accepted' state
    const activeQuote = await new Promise((resolve, reject) => {
        db.get(
            `SELECT id, status FROM quotations WHERE booking_id = ? AND archived = 0 ORDER BY version DESC LIMIT 1`,
            [bookingId],
            (err, row) => { if (err) reject(err); else resolve(row); }
        );
    }).catch(() => null);

    if (activeQuote && activeQuote.status !== 'accepted') {
        return res.status(400).json({
            success: false,
            message: `Invoice cannot be generated: the active quote is in '${activeQuote.status}' status. The client must accept the quote first.`
        });
    }

    try {
        const result = await generateInvoice(bookingId);
        // P3-3: Audit log for invoice generation
        if (result && result.success) {
            db.run(`INSERT INTO audit_log (table_name, record_id, action, new_values, changed_by, change_timestamp)
                    VALUES ('invoices', ?, 'INVOICE_GENERATED', ?, ?, CURRENT_TIMESTAMP)`,
                [bookingId, JSON.stringify({ invoice_id: result.invoice_id }), req.session.adminId || 'admin'],
                (aErr) => { if (aErr) console.error('[Audit] Invoice generation log failed:', aErr.message); });
        }
        res.json(result);
    } catch (err) {
        console.error("Admin Invoice Generation Error:", err);
        res.status(500).json({ success: false, message: err.message || 'Failed to generate invoice.' });
    }
});

// 2. Ledger reconciliation — compares booking's denormalised ledger against transaction sum.
app.get('/api/admin/bookings/:id/reconcile', requireAdmin, (req, res) => {
    const bookingId = req.params.id;
    db.get(
        `SELECT
            b.id, b.amount_paid AS ledger_paid, b.amount_outstanding AS ledger_outstanding, b.total_amount AS ledger_total,
            COALESCE(SUM(CASE WHEN (t.source != 'payfast' OR t.is_verified = 1) AND COALESCE(t.is_duplicate, 0) = 0 AND t.status = 'completed' THEN (CASE WHEN t.transaction_type = 'refund' THEN -t.amount WHEN t.transaction_type = 'adjustment' THEN 0 ELSE t.amount END) ELSE 0 END), 0) AS tx_paid,
            COUNT(t.id) AS tx_count
         FROM bookings b
         LEFT JOIN transactions t ON t.booking_id = b.id
         WHERE b.id = ?
         GROUP BY b.id`,
        [bookingId],
        (err, row) => {
            if (err || !row) return res.status(404).json({ success: false, message: 'Booking not found.' });
            const drift = Math.abs((row.ledger_paid || 0) - (row.tx_paid || 0)) > 0.01;
            res.json({
                success: true,
                booking_id: row.id,
                ledger: { total: row.ledger_total, paid: row.ledger_paid, outstanding: row.ledger_outstanding },
                transactions: { total_paid: row.tx_paid, count: row.tx_count },
                drift,
                drift_amount: drift ? ((row.ledger_paid || 0) - (row.tx_paid || 0)).toFixed(2) : '0.00'
            });
        }
    );
});

// 2.5 Ledger reconciliation sync — force aligns bookings totals to transactions
app.post('/api/admin/bookings/:id/reconcile/sync', requireAdmin, requireRole(['administrator', 'manager']), (req, res) => {
    const bookingId = req.params.id;
    db.get(
        `SELECT
            COALESCE(SUM(CASE WHEN (t.source != 'payfast' OR t.is_verified = 1) AND COALESCE(t.is_duplicate, 0) = 0 AND t.status = 'completed' THEN (CASE WHEN t.transaction_type = 'refund' THEN -t.amount WHEN t.transaction_type = 'adjustment' THEN 0 ELSE t.amount END) ELSE 0 END), 0) AS tx_paid
         FROM transactions t
         WHERE t.booking_id = ?`,
        [bookingId],
        (err, row) => {
            if (err) return res.status(500).json({ success: false, message: 'Database error counting transactions: ' + err.message });
            
            const txPaid = parseFloat(row.tx_paid) || 0;
            
            db.get("SELECT * FROM bookings WHERE id = ?", [bookingId], (bookErr, booking) => {
                if (bookErr || !booking) return res.status(404).json({ success: false, message: 'Booking not found.' });
                
                const total = parseFloat(booking.total_amount) || 0;
                const outstanding = Math.max(0, total - txPaid);
                
                const isFullyPaid = total > 0 ? txPaid >= total : false;
                let payment_status = booking.payment_status;
                if (isFullyPaid) {
                    payment_status = 'PAID';
                } else if (total > 0) {
                    const depositThreshold = total * 0.5;
                    if (txPaid >= depositThreshold) {
                        payment_status = 'DEPOSIT_PAID';
                    } else if (txPaid > 0) {
                        payment_status = 'PARTIALLY_PAID';
                    } else {
                        payment_status = 'UNPAID';
                    }
                }
                
                // A deposit confirms, same as every other payment path.
                const newStatus = deriveBookingStatusAfterPayment(booking.status, payment_status);

                const adminUser = req.session.username || 'system';
                
                db.run(
                    `UPDATE bookings SET
                        amount_paid = ?, amount_outstanding = ?, payment_status = ?, status = ?,
                        confirmed_at = CASE WHEN ? = 'PAID' AND confirmed_at IS NULL THEN CURRENT_TIMESTAMP ELSE confirmed_at END
                     WHERE id = ?`,
                    [txPaid, outstanding, payment_status, newStatus, payment_status, bookingId],
                    (upErr) => {
                        if (upErr) return res.status(500).json({ success: false, message: 'Failed to update booking: ' + upErr.message });
                        
                        db.run(
                            `INSERT INTO audit_log (table_name, record_id, action, new_values, changed_by, change_timestamp)
                             VALUES ('bookings', ?, 'RECONCILE_SYNC', ?, ?, CURRENT_TIMESTAMP)`,
                            [bookingId, JSON.stringify({ amount_paid: txPaid, amount_outstanding: outstanding, payment_status }), adminUser],
                            () => {}
                        );
                        db.run(
                            `INSERT INTO financial_audit_log (event_type, entity_type, entity_id, amount, changed_by, notes)
                             VALUES ('LEDGER_SYNC', 'booking', ?, ?, ?, ?)`,
                            [bookingId, txPaid, adminUser, `Synced ledger paid to match transaction ledger. Outstanding: R${outstanding.toFixed(2)}`],
                            () => {}
                        );
                        
                        (async () => {
                            await syncBookingToCalendar(bookingId);
                            alignMilestonePayments(bookingId, txPaid, (psErr) => {
                                if (psErr) console.error('[Ledger Sync] Milestone alignment failed:', psErr.message);
                            });
                            
                            if (payment_status === 'PAID') {
                                db.run("UPDATE invoices SET status='PAID', updated_at=CURRENT_TIMESTAMP WHERE booking_id=? AND UPPER(status) NOT IN ('VOID','PAID')", [bookingId]);
                            }
                        })();
                        
                        res.json({ success: true, message: 'Ledger aligned and booking synced successfully.', amount_paid: txPaid, amount_outstanding: outstanding, payment_status });
                    }
                );
            });
        }
    );
});

// 3. Download Invoice (Public Secured)
app.get('/api/public/bookings/:id/invoice/download', async (req, res) => {
    const { email } = req.query;
    if (!email) return res.status(400).send('Email required for verification');

    // A booking accumulates one invoice per revision (INV-…, INV-…-R2, …), the superseded ones VOID.
    // Without the filter and ordering this `db.get` returned the lowest rowid — the VOID original —
    // and served the client a stale invoice after any re-quote.
    db.get(`SELECT b.email, i.file_path, i.invoice_number
            FROM bookings b
            JOIN invoices i ON b.id = i.booking_id
            WHERE b.id = ? AND UPPER(i.status) <> 'VOID'
            ORDER BY i.created_at DESC, i.id DESC
            LIMIT 1`, [req.params.id], async (err, row) => {

        if (err || !row) return res.status(404).send('Invoice not found');
        if (row.email.toLowerCase() !== email.toLowerCase()) return res.status(401).send('Unauthorized email');

        const filePath = path.join(__dirname, 'docs', 'invoices', row.file_path);
        if (fs.existsSync(filePath)) {
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `attachment; filename=Invoice_${row.invoice_number}.pdf`);
            res.sendFile(filePath);
        } else {
            res.status(404).send('Physical PDF file not found on server.');
        }
    });
});

// 2b. Download Invoice (Admin Authorized)
app.get('/api/admin/bookings/:id/invoice/download', requireAdmin, (req, res) => {
    // Same as the public route: serve the live invoice, never a superseded VOID revision.
    db.get(`SELECT i.file_path, i.invoice_number
            FROM invoices i
            WHERE i.booking_id = ? AND UPPER(i.status) <> 'VOID'
            ORDER BY i.created_at DESC, i.id DESC
            LIMIT 1`, [req.params.id], (err, row) => {

        if (err || !row) return res.status(404).send('Invoice not found');

        const filePath = path.join(__dirname, 'docs', 'invoices', row.file_path);
        if (fs.existsSync(filePath)) {
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `attachment; filename=Invoice_${row.invoice_number}.pdf`);
            res.sendFile(filePath);
        } else {
            res.status(404).send('Physical PDF file not found on server.');
        }
    });
});

// 2c. Download Quote (Admin Authorized)
app.get('/api/admin/bookings/:id/quote/download', requireAdmin, (req, res) => {
    db.get(`SELECT q.file_path, q.quote_number 
            FROM quotations q 
            WHERE q.booking_id = ?`, [req.params.id], (err, row) => {
        
        if (err || !row) return res.status(404).send('Quotation not found');

        const filePath = path.join(__dirname, 'docs', 'quotes', row.file_path);
        if (fs.existsSync(filePath)) {
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `attachment; filename=Quote_${row.quote_number}.pdf`);
            res.sendFile(filePath);
        } else {
            res.status(404).send('Physical PDF file not found on server.');
        }
    });
});

// Public: download own quote PDF (email-verified)
app.post('/api/public/bookings/:id/quote/download', ipRateLimiter, (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, message: 'Email required.' });
    db.get("SELECT * FROM bookings WHERE id = ?", [req.params.id], (err, booking) => {
        if (err || !booking) return res.status(404).json({ success: false, message: 'Booking not found.' });
        if (booking.email.trim().toLowerCase() !== email.trim().toLowerCase())
            return res.status(401).json({ success: false, message: 'Email does not match.' });
        if (!['QUOTED','ACCEPTED','CONFIRMED','COMPLETED'].includes(booking.status))
            return res.status(403).json({ success: false, message: 'No quote available for your booking.' });
        db.get("SELECT file_path, quote_number FROM quotations WHERE booking_id = ? AND archived = 0 ORDER BY version DESC LIMIT 1",
            [req.params.id], (e, q) => {
                if (e || !q) return res.status(404).json({ success: false, message: 'Quote PDF not found.' });
                const filePath = path.join(__dirname, 'docs', 'quotes', q.file_path);
                if (!fs.existsSync(filePath))
                    return res.status(404).json({ success: false, message: 'Quote file not found on server.' });
                res.setHeader('Content-Type', 'application/pdf');
                res.setHeader('Content-Disposition', `attachment; filename=Quote_${q.quote_number}.pdf`);
                res.sendFile(filePath);
            });
    });
});

// Public: client self-cancellation (PENDING/QUOTED/ACCEPTED only)
app.post('/api/public/bookings/:id/cancel', mutateRateLimiter, ipRateLimiter, async (req, res) => {
    const { email, reason, reason_code } = req.body;
    if (!email) return res.status(400).json({ success: false, message: 'Email required.' });
    db.get("SELECT * FROM bookings WHERE id = ?", [req.params.id], (err, booking) => {
        if (err || !booking) return res.status(404).json({ success: false, message: 'Booking not found.' });
        if (booking.email.trim().toLowerCase() !== email.trim().toLowerCase())
            return res.status(401).json({ success: false, message: 'Email does not match.' });
        const cancellable = ['PENDING','QUOTED','ACCEPTED'];
        if (!cancellable.includes(booking.status))
            return res.status(400).json({ success: false, message: `Booking cannot be cancelled at status ${booking.status}. Contact us directly.` });

        db.get("SELECT policy_value FROM policies WHERE policy_key = 'cancellation_policy'", [], async (e, policy) => {
            const calc = calculateCancellationRefund(booking, policy ? policy.policy_value : '');

            const outcome = await withDbTransaction(async () => {
                try {
                    await dbRun("BEGIN IMMEDIATE");
                } catch (beginErr) {
                    console.error('[Public Cancel] BEGIN IMMEDIATE failed:', beginErr.message);
                    return { status: 500, body: { success: false, message: 'Database busy. Please retry.' } };
                }
                try {
                    await dbRun("UPDATE bookings SET status = 'CANCELLED', cancelled_at = CURRENT_TIMESTAMP WHERE id = ?", [req.params.id]);
                    await dbRun(`INSERT INTO cancellations (booking_id, cancelled_by, reason, reason_code, total_paid_to_date, refund_due, retention_amount, refund_status)
                            VALUES (?, 'client', ?, ?, ?, ?, ?, 'pending')
                            ON CONFLICT(booking_id) DO UPDATE SET cancelled_by='client', reason=excluded.reason, reason_code=excluded.reason_code, refund_status='pending'`,
                        [req.params.id, reason || 'Client request', reason_code || null, calc.totalPaid, calc.refund, calc.retention]);
                    // Released with the cancellation, not after it: this ran post-COMMIT and could
                    // leave the date held against a booking that no longer holds it.
                    await dbRun("UPDATE date_holds SET status = 'released' WHERE converted_to_booking_id = ?", [req.params.id]);

                    await dbRun("COMMIT");
                    return { ok: true };
                } catch (txErr) {
                    await dbRun("ROLLBACK").catch(() => {});
                    console.error('[Public Cancel] Failed — rolled back, booking unchanged:', txErr.message);
                    return { status: 500, body: { success: false } };
                }
            });

            if (!outcome.ok) return res.status(outcome.status).json(outcome.body);

            booking.name = booking.client_name || booking.name;
            try { await sendCancellationEmail(booking, { reason: reason || 'Client request', refund_due: calc.refund, rule: calc.rule, days_until_event: calc.daysUntilEvent }); } catch(ce) {}
            getNotificationEmail().then(notifEmail => {
                sendEmail({ to: notifEmail, subject: `Client Cancelled – Booking #${req.params.id}`,
                    htmlContent: emailComponents.renderSystemEmail({
                        preheaderText: `${booking.name} cancelled booking #${req.params.id}.`,
                        category: 'Booking Requests',
                        severity: 'action',
                        leadFact: `<strong style="color:#FAFAFA;">${emailComponents.esc(booking.name)}</strong> cancelled booking <strong style="color:#FAFAFA;">#${req.params.id}</strong>.`,
                        cards: [{ rows: [
                            { label: 'Reason', value: reason || 'Not provided', mono: false },
                            { label: 'Refund Due', value: `R${calc.refund.toFixed(2)}`, highlight: true }
                        ] }]
                    }),
                    preWrapped: true,
                    titleOverride: 'Client Cancellation', trigger_event: 'Admin: Client Cancellation' }).catch(() => {});
            });
            res.json({ success: true, message: 'Booking cancelled.', refund_due: calc.refund, refund_policy: calc.rule });
        });
    });
});

// C7: Public — submit a post-event review (COMPLETED bookings only, email-verified)
app.post('/api/public/bookings/:id/review', mutateRateLimiter, ipRateLimiter, (req, res) => {
    const { email, rating, review_text } = req.body;
    const ratingNum = parseInt(rating, 10);
    if (!email) return res.status(400).json({ success: false, message: 'Email required.' });
    if (!ratingNum || ratingNum < 1 || ratingNum > 5) return res.status(400).json({ success: false, message: 'Rating must be between 1 and 5.' });

    db.get("SELECT * FROM bookings WHERE id = ?", [req.params.id], (err, booking) => {
        if (err || !booking) return res.status(404).json({ success: false, message: 'Booking not found.' });
        const clientEmail = (booking.email || '').trim().toLowerCase();
        if (clientEmail !== email.trim().toLowerCase())
            return res.status(401).json({ success: false, message: 'Email does not match this booking.' });
        if (booking.status !== 'COMPLETED')
            return res.status(400).json({ success: false, message: 'Reviews can only be submitted for completed bookings.' });

        const clientName = booking.client_name || booking.name || 'Anonymous';
        db.run(
            `INSERT INTO service_reviews (booking_id, client_name, rating, review_text)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(booking_id) DO UPDATE SET rating=excluded.rating, review_text=excluded.review_text, submitted_at=CURRENT_TIMESTAMP`,
            [req.params.id, encodeUserHtml(clientName), ratingNum, encodeUserHtml(review_text) || null],
            function(insErr) {
                if (insErr) return res.status(500).json({ success: false, message: 'Could not save review.' });
                // Notify admin of new review
                getNotificationEmail().then(notifEmail => sendEmail({
                    to: notifEmail,
                    subject: `New Review Submitted – Booking #${req.params.id} (${ratingNum}★)`,
                    htmlContent: emailComponents.renderSystemEmail({
                        preheaderText: `${clientName} left a ${ratingNum}/5 review for booking #${req.params.id}.`,
                        category: 'Thank You & Reviews',
                        severity: 'info',
                        leadFact: `<strong style="color:#FAFAFA;">${emailComponents.esc(clientName)}</strong> has submitted a <strong style="color:#D4AF37;">${ratingNum}/5</strong> review for Booking <strong style="color:#FAFAFA;">#${req.params.id}</strong>.`,
                        bodyHtml:
                            (review_text ? `<blockquote style="border-left:3px solid #D4AF37; padding:10px 16px; margin:0 0 12px; color:#E6E6E6; background:#1A1A1A;">${review_text}</blockquote>` : '') +
                            `<p style="margin:0; color:#B0B0B0;">Log in to the admin panel to approve or manage reviews.</p>`
                    }),
                    preWrapped: true,
                    titleOverride: 'New Client Review',
                    trigger_event: 'Admin: New Review Submitted'
                })).catch(() => {});
                res.json({ success: true, message: 'Thank you! Your review has been submitted.' });
            }
        );
    });
});

// Public: venue autocomplete via Google Places API proxy
app.get('/api/public/places/autocomplete', ipRateLimiter, (req, res) => {
    const input = (req.query.input || '').trim();
    if (input.length < 2) return res.json({ predictions: [] });
    const apiKey = process.env.GOOGLE_MAPS_API_KEY || '';
    const url = `https://maps.googleapis.com/maps/api/place/autocomplete/json?input=${encodeURIComponent(input)}&key=${apiKey}`;
    
    require('https').get(url, (r) => {
        let body = '';
        r.on('data', d => body += d);
        r.on('end', () => {
            try {
                const data = JSON.parse(body);
                if (data.status === 'OK') {
                    const predictions = data.predictions.map(p => ({
                        place_id: p.place_id,
                        main_text: p.structured_formatting ? p.structured_formatting.main_text : p.description,
                        secondary_text: p.structured_formatting ? p.structured_formatting.secondary_text : '',
                        formatted_address: p.description
                    }));
                    res.json({ predictions });
                } else {
                    res.json({ predictions: [] });
                }
            } catch(e) { res.json({ predictions: [] }); }
        });
    }).on('error', () => res.json({ predictions: [] }));
});

// Public: venue details via Google Places API proxy
app.get('/api/public/places/details', ipRateLimiter, (req, res) => {
    const place_id = req.query.place_id;
    if (!place_id) return res.status(400).json({ error: 'place_id required' });
    const apiKey = process.env.GOOGLE_MAPS_API_KEY || '';
    const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${place_id}&fields=address_components,formatted_address,name,geometry&key=${apiKey}`;
    
    require('https').get(url, (r) => {
        let body = '';
        r.on('data', d => body += d);
        r.on('end', () => {
            try {
                const data = JSON.parse(body);
                if (data.status === 'OK' && data.result) {
                    res.json({ result: data.result });
                } else {
                    res.status(404).json({ error: 'Place not found' });
                }
            } catch(e) { res.status(500).json({ error: 'Server error' }); }
        });
    }).on('error', () => res.status(500).json({ error: 'Network error' }));
});

// Public: upload supporting files after booking is created (max 5 × 10 MB)
app.post('/api/public/bookings/:id/attachments',
    mutateRateLimiter, ipRateLimiter,
    bookingAttachUpload.array('attachments', 5),
    (req, res) => {
        const { email } = req.body;
        if (!email) return res.status(400).json({ success: false, message: 'Email required.' });
        if (!req.files || req.files.length === 0)
            return res.status(400).json({ success: false, message: 'No files received.' });

        db.get("SELECT * FROM bookings WHERE id = ?", [req.params.id], (err, booking) => {
            if (err || !booking) return res.status(404).json({ success: false, message: 'Booking not found.' });
            if ((booking.email || '').trim().toLowerCase() !== email.trim().toLowerCase())
                return res.status(401).json({ success: false, message: 'Email does not match.' });

            const existing = JSON.parse(booking.attachment_files || '[]');
            const added = req.files.map(f => ({
                filename: f.filename,
                original_name: f.originalname,
                mime_type: f.mimetype,
                size: f.size
            }));
            const merged = [...existing, ...added].slice(0, 10);

            db.run("UPDATE bookings SET attachment_files = ? WHERE id = ?",
                [JSON.stringify(merged), req.params.id],
                (upErr) => {
                    if (upErr) return res.status(500).json({ success: false });
                    res.json({ success: true, files: added });
                }
            );
        });
    }
);

// Admin: serve a booking attachment file
app.get('/api/admin/booking-attachments/:filename', requireAdmin, (req, res) => {
    const filePath = path.join(__dirname, 'docs', 'booking_attachments', req.params.filename);
    if (!fs.existsSync(filePath)) return res.status(404).send('File not found.');
    res.sendFile(filePath);
});

// Admin: list reviews
app.get('/api/admin/reviews', requireAdmin, (req, res) => {
    db.all(
        `SELECT r.*, b.event_name, b.event_type, b.date AS event_date
         FROM service_reviews r
         JOIN bookings b ON r.booking_id = b.id
         ORDER BY r.submitted_at DESC`,
        [],
        (err, rows) => err ? res.status(500).json({ error: err.message }) : res.json(rows)
    );
});

// Admin: approve or delete a review
app.patch('/api/admin/reviews/:id', requireAdmin, (req, res) => {
    const { is_approved } = req.body;
    db.run("UPDATE service_reviews SET is_approved = ? WHERE id = ?", [is_approved ? 1 : 0, req.params.id],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true });
        }
    );
});



// 3. Admin Invoice View
app.get('/api/admin/invoices', requireAdmin, requireRole(['administrator', 'manager']), (req, res) => {
    db.all(`SELECT i.*, b.name as client_name, b.event_name, b.date as event_date 
            FROM invoices i 
            JOIN bookings b ON i.booking_id = b.id 
            ORDER BY i.invoice_date DESC`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// 3.6 Payment Schedules API (Admin)
// GET /api/admin/bookings/:id/payment-schedules — get schedules for a booking
app.get('/api/admin/bookings/:id/payment-schedules', requireAdmin, (req, res) => {
    const bookingId = req.params.id;
    db.get("SELECT total_amount, (SELECT COALESCE(SUM(expected_amount), 0) FROM payment_schedules WHERE booking_id = ? AND LOWER(COALESCE(status,'pending')) NOT IN ('superseded','cancelled')) AS scheduled_total FROM bookings WHERE id = ?", [bookingId, bookingId], (bErr, booking) => {
        if (bErr || !booking) return res.status(404).json({ success: false, message: 'Booking not found.' });
        
        db.all("SELECT * FROM payment_schedules WHERE booking_id = ? AND LOWER(COALESCE(status,'pending')) NOT IN ('superseded','cancelled') ORDER BY due_date ASC, id ASC", [bookingId], (err, rows) => {
            if (err) return res.status(500).json({ success: false, message: err.message });
            res.json({
                success: true,
                total_amount: booking.total_amount || 0,
                scheduled_total: booking.scheduled_total || 0,
                schedules: rows || []
            });
        });
    });
});

// POST /api/admin/bookings/:id/payment-schedules — create or replace schedules
app.post('/api/admin/bookings/:id/payment-schedules', requireAdmin, requireRole(['administrator', 'manager']), (req, res) => {
    const bookingId = req.params.id;
    const { schedules } = req.body;
    
    if (!Array.isArray(schedules)) {
        return res.status(400).json({ success: false, message: 'Schedules must be an array.' });
    }
    
    for (const item of schedules) {
        if (!item.description || !item.description.trim()) {
            return res.status(400).json({ success: false, message: 'Each schedule item must have a description.' });
        }
        if (!item.due_date) {
            return res.status(400).json({ success: false, message: 'Each schedule item must have a due date.' });
        }
        if (item.expected_amount === undefined || isNaN(parseFloat(item.expected_amount)) || parseFloat(item.expected_amount) < 0) {
            return res.status(400).json({ success: false, message: 'Each schedule item must have a valid non-negative expected amount.' });
        }
    }
    
    db.get('SELECT total_amount FROM bookings WHERE id = ?', [bookingId], (bErr, booking) => {
        if (bErr || !booking) return res.status(404).json({ success: false, message: 'Booking not found.' });

        // Validate that schedule amounts sum to total_amount (skip if total_amount not yet set)
        if (schedules.length > 0 && booking.total_amount > 0) {
            const scheduleSum = schedules.reduce((s, item) => s + parseFloat(item.expected_amount), 0);
            const diff = Math.abs(scheduleSum - parseFloat(booking.total_amount));
            if (diff > 0.01) {
                return res.status(400).json({
                    success: false,
                    message: `Schedule amounts sum to R${scheduleSum.toFixed(2)} but booking total is R${parseFloat(booking.total_amount).toFixed(2)}. Adjust amounts so they add up to the booking total.`
                });
            }
        }

        db.serialize(() => {
            db.run('DELETE FROM payment_schedules WHERE booking_id = ?', [bookingId], (delErr) => {
                if (delErr) return res.status(500).json({ success: false, message: delErr.message });
                
                if (schedules.length === 0) {
                    return res.json({ success: true, message: 'Payment schedules cleared.' });
                }
                
                const stmt = db.prepare(`INSERT INTO payment_schedules (booking_id, description, due_date, expected_amount, status) VALUES (?, ?, ?, ?, 'pending')`);
                let insertError = null;
                
                schedules.forEach(item => {
                    stmt.run([bookingId, item.description.trim(), item.due_date, parseFloat(item.expected_amount)], (runErr) => {
                        if (runErr) insertError = runErr;
                    });
                });
                
                stmt.finalize((finErr) => {
                    if (insertError || finErr) {
                        return res.status(500).json({ success: false, message: (insertError || finErr).message });
                    }
                    
                    updateBookingMilestones(bookingId, (alignErr) => {
                        if (alignErr) console.error('[Schedules] Milestone alignment failed:', alignErr.message);
                        res.json({ success: true, message: 'Payment schedules updated and aligned successfully.' });
                    });
                });
            });
        });
    });
});

// POST — reconcile a booking's payment schedule to its total by proportionally rescaling the
// PENDING milestones (paid milestones are preserved). Money only changes on this explicit action.
app.post('/api/admin/bookings/:id/payment-schedules/rebalance', requireAdmin, requireRole(['administrator', 'manager']), (req, res) => {
    const bookingId = req.params.id;
    db.get('SELECT total_amount FROM bookings WHERE id = ?', [bookingId], (bErr, booking) => {
        if (bErr || !booking) return res.status(404).json({ success: false, message: 'Booking not found.' });
        const total = parseFloat(booking.total_amount) || 0;
        if (total <= 0) return res.status(400).json({ success: false, message: 'Set a booking total before rebalancing the schedule.' });

        db.all("SELECT * FROM payment_schedules WHERE booking_id = ? AND LOWER(COALESCE(status,'pending')) NOT IN ('superseded','cancelled') ORDER BY due_date ASC, id ASC", [bookingId], (err, schedules) => {
            if (err) return res.status(500).json({ success: false, message: err.message });
            if (!schedules || schedules.length === 0) return res.status(400).json({ success: false, message: 'No payment schedule to rebalance — set up milestones first.' });

            const isPaid = s => String(s.status).toLowerCase() === 'paid';
            const paid = schedules.filter(isPaid);
            const pending = schedules.filter(s => !isPaid(s));
            const paidSum = paid.reduce((s, x) => s + (parseFloat(x.expected_amount) || 0), 0);
            const remaining = Math.round((total - paidSum) * 100) / 100;

            if (remaining < -0.01) {
                return res.status(400).json({ success: false, message: `Paid milestones (R${paidSum.toFixed(2)}) already exceed the booking total (R${total.toFixed(2)}). Record a refund or adjust the total instead.` });
            }
            if (pending.length === 0) {
                if (Math.abs(remaining) <= 0.01) return res.json({ success: true, message: 'Schedule already matches the booking total.' });
                return res.status(400).json({ success: false, message: 'All milestones are already paid — edit the booking total to reconcile.' });
            }

            // Proportional split of the remaining amount across pending milestones; the last row
            // absorbs the rounding drift so the sum is exact.
            const pendSum = pending.reduce((s, x) => s + (parseFloat(x.expected_amount) || 0), 0);
            const rounded = pending.map(s => {
                const prop = pendSum > 0 ? (parseFloat(s.expected_amount) || 0) / pendSum : 1 / pending.length;
                return Math.round(remaining * prop * 100) / 100;
            });
            const drift = Math.round((remaining - rounded.reduce((a, b) => a + b, 0)) * 100) / 100;
            rounded[rounded.length - 1] = Math.max(0, Math.round((rounded[rounded.length - 1] + drift) * 100) / 100);
            const newAmounts = pending.map((s, i) => ({ id: s.id, amount: rounded[i] }));

            db.serialize(() => {
                const stmt = db.prepare("UPDATE payment_schedules SET expected_amount = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?");
                let upErr = null;
                newAmounts.forEach(u => stmt.run([u.amount, u.id], e => { if (e) upErr = e; }));
                stmt.finalize((finErr) => {
                    if (upErr || finErr) return res.status(500).json({ success: false, message: (upErr || finErr).message });

                    db.run(`INSERT INTO audit_log (table_name, record_id, action, changed_by, changes_json) VALUES ('payment_schedules', ?, 'REBALANCE_SCHEDULE', ?, ?)`,
                        [bookingId, req.session.adminId || req.session.username || 'admin', JSON.stringify({ total, paidSum, remaining, milestones: newAmounts })], () => {});

                    updateBookingMilestones(bookingId, () => {
                        db.all("SELECT * FROM payment_schedules WHERE booking_id = ? AND LOWER(COALESCE(status,'pending')) NOT IN ('superseded','cancelled') ORDER BY due_date ASC, id ASC", [bookingId], (e2, rows) => {
                            const scheduled_total = (rows || []).reduce((s, x) => s + (parseFloat(x.expected_amount) || 0), 0);
                            res.json({ success: true, message: 'Schedule rebalanced to the booking total.', schedules: rows || [], scheduled_total, total_amount: total });
                        });
                    });
                });
            });
        });
    });
});

// GET — bookings whose ACTIVE schedule total diverges from the booking total (reconciliation sweep)
app.get('/api/admin/payment-schedules/mismatches', requireAdmin, requireRole(['administrator', 'manager']), (req, res) => {
    db.all(
        `SELECT b.id, b.name, b.event_name, b.event_type, b.date, b.status, b.total_amount,
                (SELECT COALESCE(SUM(expected_amount),0) FROM payment_schedules ps
                 WHERE ps.booking_id=b.id AND LOWER(COALESCE(ps.status,'pending')) NOT IN ('superseded','cancelled')) AS scheduled_total
         FROM bookings b
         WHERE b.status NOT IN ('CANCELLED')
           AND b.total_amount > 0
           AND EXISTS (SELECT 1 FROM payment_schedules ps2 WHERE ps2.booking_id=b.id AND LOWER(COALESCE(ps2.status,'pending')) NOT IN ('superseded','cancelled'))`,
        [], (err, rows) => {
            if (err) return res.status(500).json({ success: false, message: err.message });
            const mismatches = (rows || [])
                .map(r => {
                    const total_amount = parseFloat(r.total_amount) || 0;
                    const scheduled_total = parseFloat(r.scheduled_total) || 0;
                    return { ...r, total_amount, scheduled_total, diff: Math.round((scheduled_total - total_amount) * 100) / 100 };
                })
                .filter(r => Math.abs(r.diff) > 0.01)
                .sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
            res.json({ success: true, mismatches, count: mismatches.length });
        }
    );
});

// 3.7 Financial Analytics API (Admin)
// GET /api/admin/financials/analytics
app.get('/api/admin/financials/analytics', requireAdmin, requireRole(['administrator', 'manager']), (req, res) => {
    const trendQuery = `
        SELECT strftime('%Y-%m', transaction_date) AS month, SUM(amount) AS total_revenue
        FROM transactions
        WHERE status = 'completed' AND COALESCE(is_duplicate, 0) = 0
          AND transaction_date >= DATE('now', '-12 months')
        GROUP BY month
        ORDER BY month ASC
    `;
    
    const clientQuery = `
        SELECT c.id AS client_id, COALESCE(c.full_name, b.name) AS client_name, c.company_name,
               SUM(t.amount) AS total_spent, COUNT(DISTINCT b.id) AS booking_count
        FROM transactions t
        JOIN bookings b ON t.booking_id = b.id
        LEFT JOIN clients c ON b.client_id = c.id
        WHERE t.status = 'completed' AND COALESCE(t.is_duplicate, 0) = 0
        GROUP BY client_id, client_name
        ORDER BY total_spent DESC
        LIMIT 5
    `;
    
    const agingQuery = `
        SELECT 
            COUNT(CASE WHEN (julianday('now') - julianday(due_date)) <= 0 THEN 1 END) AS current_count,
            COALESCE(SUM(CASE WHEN (julianday('now') - julianday(due_date)) <= 0 THEN total_amount ELSE 0 END), 0) AS current_value,
            
            COUNT(CASE WHEN (julianday('now') - julianday(due_date)) > 0 AND (julianday('now') - julianday(due_date)) <= 30 THEN 1 END) AS age_30_count,
            COALESCE(SUM(CASE WHEN (julianday('now') - julianday(due_date)) > 0 AND (julianday('now') - julianday(due_date)) <= 30 THEN total_amount ELSE 0 END), 0) AS age_30_value,
            
            COUNT(CASE WHEN (julianday('now') - julianday(due_date)) > 30 AND (julianday('now') - julianday(due_date)) <= 60 THEN 1 END) AS age_60_count,
            COALESCE(SUM(CASE WHEN (julianday('now') - julianday(due_date)) > 30 AND (julianday('now') - julianday(due_date)) <= 60 THEN total_amount ELSE 0 END), 0) AS age_60_value,
            
            COUNT(CASE WHEN (julianday('now') - julianday(due_date)) > 60 AND (julianday('now') - julianday(due_date)) <= 90 THEN 1 END) AS age_90_count,
            COALESCE(SUM(CASE WHEN (julianday('now') - julianday(due_date)) > 60 AND (julianday('now') - julianday(due_date)) <= 90 THEN total_amount ELSE 0 END), 0) AS age_90_value,
            
            COUNT(CASE WHEN (julianday('now') - julianday(due_date)) > 90 THEN 1 END) AS age_over_90_count,
            COALESCE(SUM(CASE WHEN (julianday('now') - julianday(due_date)) > 90 THEN total_amount ELSE 0 END), 0) AS age_over_90_value
        FROM invoices
        WHERE status IN ('SENT', 'OVERDUE')
    `;
    
    const overdueListQuery = `
        SELECT i.*, b.name AS client_name, b.event_name,
               CAST(julianday('now') - julianday(i.due_date) AS INTEGER) AS days_overdue
        FROM invoices i
        JOIN bookings b ON i.booking_id = b.id
        WHERE i.status IN ('SENT', 'OVERDUE')
          AND i.due_date < DATE('now')
        ORDER BY days_overdue DESC
    `;

    // Revenue grouped by booking event/service type — reveals which kinds of
    // engagements (live shows, corporate, comedy, virtual …) earn the most.
    const categoryQuery = `
        SELECT COALESCE(NULLIF(b.event_type, ''), 'Other') AS category,
               SUM(t.amount)          AS revenue,
               COUNT(DISTINCT b.id)   AS bookings
        FROM transactions t
        JOIN bookings b ON t.booking_id = b.id
        WHERE t.status = 'completed' AND COALESCE(t.is_duplicate, 0) = 0
        GROUP BY category
        ORDER BY revenue DESC
        LIMIT 8
    `;

    // Monthly expenses over the same 12-month window used by the revenue trend,
    // so the two can be combined into a cash-flow (money in vs money out) view.
    const expenseTrendQuery = `
        SELECT strftime('%Y-%m', expense_date) AS month, SUM(amount) AS total_expenses
        FROM expenses
        WHERE expense_date >= DATE('now', '-12 months')
        GROUP BY month
        ORDER BY month ASC
    `;

    db.all(trendQuery, [], (err, trend) => {
        if (err) return res.status(500).json({ success: false, message: err.message });

        db.all(clientQuery, [], (e2, clients) => {
            if (e2) return res.status(500).json({ success: false, message: e2.message });

            db.get(agingQuery, [], (e3, aging) => {
                if (e3) return res.status(500).json({ success: false, message: e3.message });

                db.all(overdueListQuery, [], (e4, overdueInvoices) => {
                    if (e4) return res.status(500).json({ success: false, message: e4.message });

                    db.all(categoryQuery, [], (e5, categories) => {
                        if (e5) return res.status(500).json({ success: false, message: e5.message });

                        db.all(expenseTrendQuery, [], (e6, expenseTrend) => {
                            if (e6) return res.status(500).json({ success: false, message: e6.message });

                            // Merge revenue trend + expense trend into a unified
                            // cash-flow series keyed by month.
                            const cf = {};
                            (trend || []).forEach(r => {
                                cf[r.month] = { month: r.month, revenue: parseFloat(r.total_revenue || 0), expenses: 0 };
                            });
                            (expenseTrend || []).forEach(x => {
                                if (!cf[x.month]) cf[x.month] = { month: x.month, revenue: 0, expenses: 0 };
                                cf[x.month].expenses = parseFloat(x.total_expenses || 0);
                            });
                            const cashFlow = Object.values(cf)
                                .map(r => ({ ...r, net: r.revenue - r.expenses }))
                                .sort((a, b) => (a.month < b.month ? -1 : 1));

                            res.json({
                                success: true,
                                revenueTrend: trend || [],
                                topClients: clients || [],
                                debtAging: aging || {},
                                overdueInvoices: overdueInvoices || [],
                                revenueByCategory: categories || [],
                                cashFlow: cashFlow
                            });
                        });
                    });
                });
            });
        });
    });
});

// 4. Financial Statistics (Admin)

// P3-11: Profit & Loss endpoint — aggregates revenue (transactions) vs costs (expenses) by period.
app.get('/api/admin/finance/pl', requireAdmin, requireRole(['administrator', 'manager']), (req, res) => {
    const { period = 'month', date_from, date_to } = req.query;
    const groupFormat = period === 'year' ? '%Y' : (period === 'week' ? '%Y-W%W' : '%Y-%m');
    const fromFilter = date_from ? `AND date >= ${db.prepare ? '?' : JSON.stringify(date_from)}` : '';
    const toFilter   = date_to   ? `AND date <= ${db.prepare ? '?' : JSON.stringify(date_to)}`   : '';
    const revenueParams = []; const expenseParams = [];
    let revWhere = 'WHERE t.status = \'completed\' AND (t.transaction_type IS NULL OR t.transaction_type NOT IN (\'refund\',\'chargeback\'))';
    let expWhere = 'WHERE 1=1';
    if (date_from) { revWhere += ' AND t.transaction_date >= ?'; revenueParams.push(date_from); expWhere += ' AND e.expense_date >= ?'; expenseParams.push(date_from); }
    if (date_to)   { revWhere += ' AND t.transaction_date <= ?'; revenueParams.push(date_to);   expWhere += ' AND e.expense_date <= ?'; expenseParams.push(date_to);   }

    db.all(
        `SELECT strftime('${groupFormat}', transaction_date) AS period,
                COALESCE(SUM(amount), 0) AS revenue
         FROM transactions t
         ${revWhere}
         GROUP BY period ORDER BY period ASC`,
        revenueParams,
        (rErr, revenueRows) => {
            if (rErr) return res.status(500).json({ success: false, error: rErr.message });
            db.all(
                `SELECT strftime('${groupFormat}', expense_date) AS period,
                        COALESCE(SUM(amount), 0) AS expenses
                 FROM expenses e
                 ${expWhere}
                 GROUP BY period ORDER BY period ASC`,
                expenseParams,
                (eErr, expenseRows) => {
                    if (eErr) return res.status(500).json({ success: false, error: eErr.message });

                    // Merge into unified P&L by period
                    const pl = {};
                    (revenueRows || []).forEach(r => { pl[r.period] = { period: r.period, revenue: parseFloat(r.revenue), expenses: 0, profit: 0 }; });
                    (expenseRows || []).forEach(e => {
                        if (!pl[e.period]) pl[e.period] = { period: e.period, revenue: 0, expenses: 0, profit: 0 };
                        pl[e.period].expenses = parseFloat(e.expenses);
                    });
                    const rows = Object.values(pl).map(r => ({ ...r, profit: r.revenue - r.expenses }));
                    rows.sort((a, b) => a.period < b.period ? -1 : 1);

                    const totals = rows.reduce((acc, r) => ({
                        revenue: acc.revenue + r.revenue,
                        expenses: acc.expenses + r.expenses,
                        profit: acc.profit + r.profit
                    }), { revenue: 0, expenses: 0, profit: 0 });

                    res.json({ success: true, period_type: period, rows, totals });
                }
            );
        }
    );
});

// ========================================
// EXPENSE TRACKING ENDPOINTS (Admin)
// ========================================
const VALID_EXPENSE_CATEGORIES = ['mileage','airfare','accommodation','meals','per_diem','parking_tolls','marketing','props','misc'];

// GET /api/admin/expenses — list with optional filters
app.get('/api/admin/expenses', requireAdmin, requireRole(['administrator', 'manager']), (req, res) => {
    const { booking_id, category, date_from, date_to, limit, offset } = req.query;
    let query = `SELECT e.*, b.event_name, b.name AS client_name
                 FROM expenses e
                 LEFT JOIN bookings b ON e.booking_id = b.id
                 WHERE e.deleted_at IS NULL`;
    const params = [];
    if (booking_id) { query += ' AND e.booking_id = ?'; params.push(booking_id); }
    if (category)   { query += ' AND e.category = ?';   params.push(category); }
    if (date_from)  { query += ' AND e.expense_date >= ?'; params.push(date_from); }
    if (date_to)    { query += ' AND e.expense_date <= ?'; params.push(date_to); }
    query += ' ORDER BY e.expense_date DESC LIMIT ? OFFSET ?';
    params.push(Math.min(parseInt(limit) || 500, 1000), parseInt(offset) || 0);

    db.all(query, params, (err, rows) => {
        if (err) return res.status(500).json({ success: false, message: err.message });
        res.json({ success: true, expenses: rows || [] });
    });
});

// POST /api/admin/expenses — create a new expense
app.post('/api/admin/expenses', requireAdmin, requireRole(['administrator', 'manager']), (req, res) => {
    const { booking_id, category, amount, description, expense_date, receipt_url,
            start_odometer, end_odometer, rate_per_km,
            per_diem_days, per_diem_rate,
            vat_paid, vat_rate, vendor } = req.body;
    if (!category || !VALID_EXPENSE_CATEGORIES.includes(category)) {
        return res.status(400).json({ success: false, message: `Invalid category. Must be one of: ${VALID_EXPENSE_CATEGORIES.join(', ')}.` });
    }
    if (!amount || isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) {
        return res.status(400).json({ success: false, message: 'A valid positive amount is required.' });
    }
    if (!description || !description.trim()) {
        return res.status(400).json({ success: false, message: 'Description is required.' });
    }
    if (!expense_date) {
        return res.status(400).json({ success: false, message: 'Expense date is required.' });
    }
    const addedBy = req.session.username || 'system';

    db.run(
        `INSERT INTO expenses (booking_id, category, amount, description, expense_date, receipt_url,
            start_odometer, end_odometer, rate_per_km,
            per_diem_days, per_diem_rate,
            vat_paid, vat_rate, vendor, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [booking_id || null, category, parseFloat(amount).toFixed(2), description.trim(), expense_date, receipt_url || null,
         start_odometer ? parseInt(start_odometer) : null, end_odometer ? parseInt(end_odometer) : null,
         rate_per_km ? parseFloat(rate_per_km) : null,
         per_diem_days ? parseFloat(per_diem_days) : null, per_diem_rate ? parseFloat(per_diem_rate) : null,
         vat_paid ? parseFloat(vat_paid) : null, vat_rate ? parseFloat(vat_rate) : null,
         vendor ? vendor.trim() : null],
        function(err) {
            if (err) return res.status(500).json({ success: false, message: err.message });
            const expenseId = this.lastID;

            // Audit logs
            db.run(
                `INSERT INTO audit_log (table_name, record_id, action, changed_by, changes_json)
                 VALUES ('expenses', ?, 'CREATE', ?, ?)`,
                [expenseId, addedBy, JSON.stringify({ category, amount, description, booking_id: booking_id || null })],
                () => {}
            );
            db.run(
                `INSERT INTO financial_audit_log (event_type, entity_type, entity_id, amount, changed_by, notes)
                 VALUES ('EXPENSE_LOGGED', 'expense', ?, ?, ?, ?)`,
                [expenseId, parseFloat(amount), addedBy, `Category: ${category}, Description: ${description}`],
                () => {}
            );

            res.json({ success: true, id: expenseId, message: 'Expense logged successfully.' });
        }
    );
});

// DELETE /api/admin/expenses/:id — delete (soft-delete) an expense
app.delete('/api/admin/expenses/:id', requireAdmin, requireRole(['administrator']), (req, res) => {
    const addedBy = req.session.username || 'system';
    db.get('SELECT * FROM expenses WHERE id = ? AND deleted_at IS NULL', [req.params.id], (err, row) => {
        if (err || !row) return res.status(404).json({ success: false, message: 'Expense not found.' });
        db.run('UPDATE expenses SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?', [req.params.id], function(e2) {
            if (e2) return res.status(500).json({ success: false, message: e2.message });
            db.run(
                `INSERT INTO audit_log (table_name, record_id, action, changed_by, changes_json)
                 VALUES ('expenses', ?, 'DELETE', ?, ?)`,
                [req.params.id, addedBy, JSON.stringify({ deleted: row })],
                () => {}
            );
            db.run(
                `INSERT INTO financial_audit_log (event_type, entity_type, entity_id, amount, changed_by, notes)
                 VALUES ('EXPENSE_DELETED', 'expense', ?, ?, ?, ?)`,
                [req.params.id, parseFloat(row.amount || 0), addedBy, `Deleted description: ${row.description}`],
                () => {}
            );
            res.json({ success: true, message: 'Expense deleted.' });
        });
    });
});

// PUT /api/admin/expenses/:id — edit an existing expense
app.put('/api/admin/expenses/:id', requireAdmin, requireRole(['administrator', 'manager']), (req, res) => {
    const expenseId = req.params.id;
    const addedBy = req.session.username || 'system';
    db.get('SELECT * FROM expenses WHERE id = ? AND deleted_at IS NULL', [expenseId], (err, existing) => {
        if (err || !existing) return res.status(404).json({ success: false, message: 'Expense not found.' });
        const { booking_id, category, amount, description, expense_date, receipt_url,
                start_odometer, end_odometer, rate_per_km,
                per_diem_days, per_diem_rate, vat_paid, vat_rate, vendor } = req.body;
        if (category && !VALID_EXPENSE_CATEGORIES.includes(category))
            return res.status(400).json({ success: false, message: 'Invalid category.' });
        if (amount && (isNaN(parseFloat(amount)) || parseFloat(amount) <= 0))
            return res.status(400).json({ success: false, message: 'Amount must be greater than zero.' });
        db.run(
            `UPDATE expenses SET
                booking_id=?, category=?, amount=?, description=?, expense_date=?, receipt_url=?,
                start_odometer=?, end_odometer=?, rate_per_km=?,
                per_diem_days=?, per_diem_rate=?, vat_paid=?, vat_rate=?, vendor=?,
                updated_at=CURRENT_TIMESTAMP
             WHERE id=?`,
            [
                booking_id !== undefined ? (booking_id || null) : existing.booking_id,
                category || existing.category,
                amount ? parseFloat(amount).toFixed(2) : existing.amount,
                description ? description.trim() : existing.description,
                expense_date || existing.expense_date,
                receipt_url !== undefined ? (receipt_url || null) : existing.receipt_url,
                start_odometer !== undefined ? (start_odometer ? parseInt(start_odometer) : null) : existing.start_odometer,
                end_odometer !== undefined ? (end_odometer ? parseInt(end_odometer) : null) : existing.end_odometer,
                rate_per_km !== undefined ? (rate_per_km ? parseFloat(rate_per_km) : null) : existing.rate_per_km,
                per_diem_days !== undefined ? (per_diem_days ? parseFloat(per_diem_days) : null) : existing.per_diem_days,
                per_diem_rate !== undefined ? (per_diem_rate ? parseFloat(per_diem_rate) : null) : existing.per_diem_rate,
                vat_paid !== undefined ? (vat_paid ? parseFloat(vat_paid) : null) : existing.vat_paid,
                vat_rate !== undefined ? (vat_rate ? parseFloat(vat_rate) : null) : existing.vat_rate,
                vendor !== undefined ? (vendor ? vendor.trim() : null) : existing.vendor,
                expenseId
            ],
            function(e2) {
                if (e2) return res.status(500).json({ success: false, message: e2.message });
                db.run(
                    `INSERT INTO audit_log (table_name, record_id, action, changed_by, changes_json)
                     VALUES ('expenses', ?, 'UPDATE', ?, ?)`,
                    [expenseId, addedBy, JSON.stringify({ before: existing, after: req.body })],
                    () => {}
                );
                db.run(
                    `INSERT INTO financial_audit_log (event_type, entity_type, entity_id, amount, changed_by, notes)
                     VALUES ('EXPENSE_EDITED', 'expense', ?, ?, ?, ?)`,
                    [expenseId, amount ? parseFloat(amount) : parseFloat(existing.amount), addedBy, `Edited description: ${description || existing.description}`],
                    () => {}
                );
                res.json({ success: true, message: 'Expense updated.' });
            }
        );
    });
});

// GET /api/admin/expenses/export — CSV download for all expenses (respects same filters as list)
app.get('/api/admin/expenses/export', requireAdmin, requireRole(['administrator', 'manager']), (req, res) => {
    const { category, date_from, date_to, booking_id } = req.query;
    let sql = `SELECT e.*, b.event_name, b.name AS client_name
               FROM expenses e
               LEFT JOIN bookings b ON e.booking_id = b.id
               WHERE e.deleted_at IS NULL`;
    const params = [];
    if (category)   { sql += ' AND e.category = ?';       params.push(category); }
    if (date_from)  { sql += ' AND e.expense_date >= ?';  params.push(date_from); }
    if (date_to)    { sql += ' AND e.expense_date <= ?';  params.push(date_to); }
    if (booking_id) { sql += ' AND e.booking_id = ?';     params.push(booking_id); }
    sql += ' ORDER BY e.expense_date DESC';
    db.all(sql, params, (err, rows) => {
        if (err) return res.status(500).json({ success: false, message: err.message });
        const today = new Date().toISOString().split('T')[0];
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="expenses_export_${today}.csv"`);
        const header = 'ID,Date,Category,Description,Client,Event,Amount,VAT Paid,VAT Rate (%),KM Total,Rate/KM,Per Diem Days,Per Diem Rate,Receipt URL\n';
        const csv = (rows || []).map(r => [
            r.id,
            r.expense_date,
            r.category,
            '"' + (r.description || '').replace(/"/g, '""') + '"',
            '"' + (r.client_name || '').replace(/"/g, '""') + '"',
            '"' + (r.event_name || '').replace(/"/g, '""') + '"',
            r.amount,
            r.vat_paid || '',
            r.vat_rate || '',
            r.total_km || '',
            r.rate_per_km || '',
            r.per_diem_days || '',
            r.per_diem_rate || '',
            '"' + (r.receipt_url || '').replace(/"/g, '""') + '"'
        ].join(',')).join('\n');
        res.send(header + csv);
    });
});

// POST /api/admin/expenses/upload-receipt — upload a receipt file for an expense
app.post('/api/admin/expenses/upload-receipt', requireAdmin, requireRole(['administrator', 'manager']), uploadReceipt.single('receipt'), (req, res) => {
    if (!req.file) return res.status(400).json({ success: false, message: 'No file received.' });
    const url = '/uploads/receipts/' + req.file.filename;
    res.json({ success: true, url, filename: req.file.originalname });
});

// POST /api/admin/transactions/manual — log a manual payment, refund, or adjustment
app.post('/api/admin/transactions/manual', requireAdmin, requireRole(['administrator', 'manager']), (req, res) => {
    const { booking_id, amount, transaction_type, payment_method, reference, notes, transaction_date, direction } = req.body;
    if (!amount || isNaN(parseFloat(amount)) || parseFloat(amount) <= 0)
        return res.status(400).json({ success: false, message: 'A valid positive amount is required.' });
    const validTypes = ['payment', 'refund', 'adjustment'];
    if (!transaction_type || !validTypes.includes(transaction_type))
        return res.status(400).json({ success: false, message: 'Transaction type must be payment, refund, or adjustment.' });
    if (transaction_type === 'adjustment' && (!direction || !['credit', 'debit'].includes(direction)))
        return res.status(400).json({ success: false, message: 'Adjustment direction must be credit or debit.' });

    const amt = parseFloat(amount).toFixed(2);
    const txDate = transaction_date || new Date().toISOString().split('T')[0];
    const finalNotes = transaction_type === 'adjustment'
        ? (notes ? `[Adjustment: ${direction}] ${notes.trim()}` : `[Adjustment: ${direction}]`)
        : (notes ? notes.trim() : null);

    // D-2: normalize to a value the transactions.payment_method CHECK permits
    // ('cash','check','bank_transfer','credit_card','payfast','other'). The UI sends 'eft'/'card',
    // which the CHECK rejects — the INSERT then 500'd and the manual payment went unrecorded.
    const PM_MAP = { eft: 'bank_transfer', bank_transfer: 'bank_transfer', card: 'credit_card',
        credit_card: 'credit_card', cash: 'cash', check: 'check', cheque: 'check', payfast: 'payfast' };
    const normalizedMethod = (transaction_type === 'adjustment' || !payment_method)
        ? null
        : (PM_MAP[String(payment_method).toLowerCase().trim()] || 'other');

    db.run(
        `INSERT INTO transactions (booking_id, amount, transaction_type, payment_method, reference, notes, transaction_date, source, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'manual', 'completed', CURRENT_TIMESTAMP)`,
        [booking_id || null, amt, transaction_type, normalizedMethod, reference || null, finalNotes, txDate],
        function(err) {
            if (err) return res.status(500).json({ success: false, message: err.message });
            const txId = this.lastID;
            
            // Log to financial_audit_log
            const adminUser = req.session.username || 'system';
            db.run(
                `INSERT INTO financial_audit_log (event_type, entity_type, entity_id, amount, changed_by, notes)
                 VALUES ('MANUAL_PAYMENT', 'transaction', ?, ?, ?, ?)`,
                [txId, parseFloat(amt), adminUser, `Type: ${transaction_type}, Method: ${payment_method || 'N/A'}, Ref: ${reference || 'N/A'}, Notes: ${finalNotes || ''}`],
                () => {}
            );

            // Update booking financials if linked
            if (booking_id) {
                if (transaction_type === 'payment') {
                    // Fetch booking row to compute new outstanding balance and run notifications/sync
                    db.get("SELECT * FROM bookings WHERE id = ?", [booking_id], (bookErr, row) => {
                        if (bookErr || !row) {
                            console.error(`[Manual Transaction] Booking #${booking_id} not found:`, bookErr?.message);
                            return res.json({ success: true, transaction_id: txId, message: 'Transaction logged but booking not found.' });
                        }

                        const total = parseFloat(row.total_amount) ||
                                      parseFloat((row.quote_amount || '0').replace(/[^0-9.]/g, '')) || 0;
                        const existingPaid = parseFloat(row.amount_paid) || 0;
                        const paid = existingPaid + parseFloat(amt);
                        const outstanding = Math.max(0, total - paid);

                        // Determine correct payment status
                        const isFullyPaid = total > 0 ? paid >= total : false;
                        let payment_status = 'PARTIALLY_PAID';
                        if (isFullyPaid) {
                            payment_status = 'PAID';
                        } else {
                            const depositThreshold = total * 0.5;
                            if (paid >= depositThreshold) {
                                payment_status = 'DEPOSIT_PAID';
                            }
                        }

                        // A deposit confirms, same as every other payment path.
                        const newStatus = deriveBookingStatusAfterPayment(row.status, payment_status);

                        db.run(
                            `UPDATE bookings SET
                                payment_status = ?, amount_paid = ?, amount_outstanding = ?,
                                total_amount = CASE WHEN COALESCE(total_amount, 0) = 0 THEN ? ELSE total_amount END,
                                status = ?,
                                last_payment_date = CURRENT_TIMESTAMP, payment_date = CURRENT_TIMESTAMP,
                                confirmed_at = CASE WHEN ? = 'PAID' AND confirmed_at IS NULL THEN CURRENT_TIMESTAMP ELSE confirmed_at END
                             WHERE id = ?`,
                            [payment_status, paid, outstanding, total, newStatus, payment_status, booking_id],
                            (upErr) => {
                                if (upErr) {
                                    console.error('[Manual Transaction] Booking update failed:', upErr.message);
                                    return res.json({ success: true, transaction_id: txId, message: 'Transaction logged but booking update failed.' });
                                }

                                // Record payment event
                                logPaymentEvent(booking_id, 'MANUAL_PAYMENT_RECORDED', {
                                    amount_gross: parseFloat(amt),
                                    payment_method: payment_method || 'manual',
                                    pf_payment_id: null,
                                    m_payment_id: `MANUAL-${booking_id}-${Date.now()}`
                                }, true);

                                db.run(`INSERT INTO audit_log (table_name, record_id, action, new_values, changed_by, change_timestamp)
                                        VALUES ('bookings', ?, 'PAYMENT', ?, ?, CURRENT_TIMESTAMP)`,
                                    [booking_id, JSON.stringify({ amount_paid: paid, payment_status, amount_outstanding: outstanding }), adminUser],
                                    (aErr) => { if (aErr) console.error('[Audit] Manual payment transaction log failed:', aErr.message); });

                                (async () => {
                                    await syncBookingToCalendar(booking_id);
                                    sendPaymentReceivedEmail(row, parseFloat(amt), outstanding, payment_status).catch(e => console.error('Manual transaction payment email failed:', e));
                                    sendAdminPaymentNotification(row, parseFloat(amt), payment_status).catch(e => console.error('Admin payment notification failed:', e.message));

                                    alignMilestonePayments(booking_id, paid, (psErr) => {
                                        if (psErr) console.error('[Manual Transaction] payment_schedules update failed:', psErr.message);
                                    });

                                    if (payment_status === 'DEPOSIT_PAID' && outstanding > 0) {
                                        sendDepositBalanceDueEmail(row, outstanding).catch(e => console.error('Deposit balance-due email failed:', e.message));
                                    }

                                    if (payment_status === 'PAID') {
                                        db.run("UPDATE invoices SET status='PAID', updated_at=CURRENT_TIMESTAMP WHERE booking_id=? AND UPPER(status) NOT IN ('VOID','PAID')", [booking_id]);
                                        db.get("SELECT * FROM bookings WHERE id = ?", [booking_id], (e, updated) => {
                                            if (!e && updated) {
                                                sendBookingConfirmedEmail(updated).catch(e => console.error('Confirmed email failed:', e.message));
                                                setTimeout(() => sendPaidReceiptEmail(updated).catch(e => console.error('Paid receipt email failed:', e.message)), 600);
                                            }
                                        });
                                    }
                                })();

                                res.json({ success: true, transaction_id: txId, message: 'Transaction logged and booking updated.' });
                            }
                        );
                    });
                } else if (transaction_type === 'refund') {
                    db.get("SELECT * FROM bookings WHERE id = ?", [booking_id], (bookErr, row) => {
                        if (bookErr || !row) {
                            return res.json({ success: true, transaction_id: txId, message: 'Transaction logged but booking not found.' });
                        }
                        // FIN-4: recompute outstanding as (total - new paid), NOT additively — the old
                        // `amount_outstanding + amt` could push outstanding above total_amount (e.g. a
                        // refund larger than amount_paid) and never re-derived payment_status, leaving a
                        // refunded booking still marked PAID.
                        const total = parseFloat(row.total_amount) || parseFloat((row.quote_amount || '0').replace(/[^0-9.]/g, '')) || 0;
                        const newPaid = Math.max(0, (parseFloat(row.amount_paid) || 0) - parseFloat(amt));
                        const outstanding = Math.max(0, total - newPaid);
                        let payment_status;
                        if (total > 0 && newPaid >= total)      payment_status = 'PAID';
                        else if (newPaid <= 0)                   payment_status = 'UNPAID';
                        else if (newPaid >= total * 0.5)         payment_status = 'DEPOSIT_PAID';
                        else                                     payment_status = 'PARTIALLY_PAID';
                        db.run(`UPDATE bookings SET amount_paid = ?, amount_outstanding = ?, payment_status = ? WHERE id = ?`,
                            [newPaid, outstanding, payment_status, booking_id], (upErr) => {
                                if (upErr) {
                                    console.error('[Manual Transaction] Refund booking update failed:', upErr.message);
                                    return res.json({ success: true, transaction_id: txId, message: 'Transaction logged but booking update failed.' });
                                }
                                updateBookingMilestones(booking_id, (psErr) => {
                                    if (psErr) console.error('[Manual Transaction] Milestone update failed:', psErr.message);
                                });
                                db.run(`INSERT INTO audit_log (table_name, record_id, action, new_values, changed_by, change_timestamp)
                                        VALUES ('bookings', ?, 'REFUND', ?, ?, CURRENT_TIMESTAMP)`,
                                    [booking_id, JSON.stringify({ amount_paid: newPaid, amount_outstanding: outstanding, payment_status }), adminUser],
                                    (aErr) => { if (aErr) console.error('[Audit] Manual refund log failed:', aErr.message); });
                                res.json({ success: true, transaction_id: txId, message: 'Refund recorded and booking updated.' });
                            });
                    });
                } else if (transaction_type === 'adjustment') {
                    db.get("SELECT * FROM bookings WHERE id = ?", [booking_id], (bookErr, row) => {
                        if (bookErr || !row) {
                            console.error(`[Manual Transaction] Booking #${booking_id} not found:`, bookErr?.message);
                            return res.json({ success: true, transaction_id: txId, message: 'Transaction logged but booking not found.' });
                        }
                        const total = parseFloat(row.total_amount) || 0;
                        const newTotal = direction === 'credit' ? Math.max(0, total - parseFloat(amt)) : total + parseFloat(amt);
                        const paid = parseFloat(row.amount_paid) || 0;
                        const outstanding = Math.max(0, newTotal - paid);

                        // Determine correct payment status
                        const isFullyPaid = newTotal > 0 ? paid >= newTotal : false;
                        let payment_status = row.payment_status;
                        if (isFullyPaid) {
                            payment_status = 'PAID';
                        } else if (newTotal > 0) {
                            const depositThreshold = newTotal * 0.5;
                            if (paid >= depositThreshold) {
                                payment_status = 'DEPOSIT_PAID';
                            } else if (paid > 0) {
                                payment_status = 'PARTIALLY_PAID';
                            } else {
                                payment_status = 'UNPAID';
                            }
                        }

                        // A deposit confirms, same as every other payment path.
                        const newStatus = deriveBookingStatusAfterPayment(row.status, payment_status);

                        db.run(
                            `UPDATE bookings SET
                                payment_status = ?, total_amount = ?, amount_outstanding = ?,
                                status = ?,
                                confirmed_at = CASE WHEN ? = 'PAID' AND confirmed_at IS NULL THEN CURRENT_TIMESTAMP ELSE confirmed_at END
                             WHERE id = ?`,
                            [payment_status, newTotal, outstanding, newStatus, payment_status, booking_id],
                            (upErr) => {
                                if (upErr) {
                                    console.error('[Manual Transaction] Booking update failed:', upErr.message);
                                    return res.json({ success: true, transaction_id: txId, message: 'Transaction logged but booking update failed.' });
                                }

                                // Log audit trails
                                db.run(`INSERT INTO audit_log (table_name, record_id, action, new_values, changed_by, change_timestamp)
                                        VALUES ('bookings', ?, 'ADJUSTMENT', ?, ?, CURRENT_TIMESTAMP)`,
                                    [booking_id, JSON.stringify({ total_amount: newTotal, payment_status, amount_outstanding: outstanding }), adminUser],
                                    (aErr) => { if (aErr) console.error('[Audit] Manual adjustment log failed:', aErr.message); });

                                (async () => {
                                    await syncBookingToCalendar(booking_id);
                                    updateBookingMilestones(booking_id, (psErr) => {
                                        if (psErr) console.error('[Manual Transaction] Milestone update failed:', psErr.message);
                                    });

                                    // Void and regenerate invoice if one exists that is not paid/void
                                    db.get("SELECT id FROM invoices WHERE booking_id = ? AND UPPER(status) NOT IN ('VOID','PAID') LIMIT 1", [booking_id], async (invErr, invRow) => {
                                        if (!invErr && invRow) {
                                            try {
                                                await generateInvoice(booking_id);
                                            } catch (e) {
                                                console.error('[Manual Transaction] Auto-regeneration of invoice failed:', e.message);
                                            }
                                        }
                                    });
                                })();

                                res.json({ success: true, transaction_id: txId, message: 'Transaction logged and booking total adjusted.' });
                            }
                        );
                    });
                } else {
                    res.json({ success: true, transaction_id: txId, message: 'Transaction logged.' });
                }
            } else {
                res.json({ success: true, transaction_id: txId, message: 'Transaction logged.' });
            }
        }
    );
});

// GET /api/admin/bookings/:id/expenses — expenses for a specific booking + P&L
app.get('/api/admin/bookings/:id/expenses', requireAdmin, requireRole(['administrator', 'manager']), (req, res) => {
    const bookingId = req.params.id;
    db.all('SELECT * FROM expenses WHERE booking_id = ? AND deleted_at IS NULL ORDER BY expense_date DESC', [bookingId], (err, expenses) => {
        if (err) return res.status(500).json({ success: false, message: err.message });
        const totalExpenses = (expenses || []).reduce((sum, e) => sum + parseFloat(e.amount || 0), 0);
        // Fetch the booking's quote total for P&L
        db.get(
            `SELECT COALESCE(q.total, b.total_amount, 0) AS gross
             FROM bookings b
             LEFT JOIN quotations q ON q.booking_id = b.id
             WHERE b.id = ?
             ORDER BY q.created_at DESC LIMIT 1`,
            [bookingId], (e2, fin) => {
                const gross = fin ? parseFloat(fin.gross || 0) : 0;
                res.json({
                    success: true,
                    expenses: expenses || [],
                    total_expenses: totalExpenses,
                    gross_revenue: gross,
                    net_profit: gross - totalExpenses
                });
            }
        );
    });
});

app.get('/api/admin/financials/stats', requireAdmin, requireRole(['administrator', 'manager']), (req, res) => {
    // Support optional date range for period-scoped stats
    const { date_from, date_to } = req.query;

    // Period boundaries: default to first of current month → today
    const now = new Date();
    const defaultFrom = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
    const defaultTo   = now.toISOString().split('T')[0];
    const periodFrom  = date_from || defaultFrom;
    const periodTo    = date_to   || defaultTo;

    // 1. Period-scoped revenue (completed transactions in range)
    const revenueQuery = `
        SELECT COALESCE(SUM(t.amount), 0) AS period_revenue
        FROM transactions t
        WHERE t.status = 'completed'
          AND COALESCE(t.is_duplicate, 0) = 0
          AND DATE(t.transaction_date) >= ?
          AND DATE(t.transaction_date) <= ?
    `;

    // 2. All-time outstanding.
    //    Allowlist, not a denylist. Booking intake writes amount_outstanding = the service
    //    catalogue estimate on a NEW booking that has never been quoted, so a bare
    //    "NOT IN ('CANCELLED','EXPIRED')" counted every unsubmitted enquiry as a receivable —
    //    an hourly MC enquiry silently added R2 950. A quote that has been sent but not accepted
    //    (QUOTED) is not a receivable either. Only an accepted commitment is money owed.
    const outstandingQuery = `
        SELECT COALESCE(SUM(amount_outstanding), 0) AS total_outstanding
        FROM bookings
        WHERE status IN ('ACCEPTED', 'CONFIRMED', 'COMPLETED')
    `;

    // 3. Booking status counts
    const countsQuery = `
        SELECT
            COUNT(CASE WHEN status = 'PENDING'   THEN 1 END) AS pending_count,
            COUNT(CASE WHEN status = 'QUOTED'    THEN 1 END) AS quoted_count,
            COUNT(CASE WHEN status = 'CONFIRMED' THEN 1 END) AS confirmed_count
        FROM bookings
        WHERE status NOT IN ('CANCELLED', 'EXPIRED')
    `;

    db.get(revenueQuery, [periodFrom, periodTo], (err, revRow) => {
        if (err) return res.status(500).json({ error: err.message });
        const periodRevenue = parseFloat(revRow ? revRow.period_revenue : 0);

        db.get(outstandingQuery, [], (e2, outRow) => {
            if (e2) return res.status(500).json({ error: e2.message });
            const totalOutstanding = parseFloat(outRow ? outRow.total_outstanding : 0);

            db.get(countsQuery, [], (e3, counts) => {
                // Period-scoped expenses
                db.get(
                    `SELECT COALESCE(SUM(amount), 0) AS period_expenses
                     FROM expenses
                     WHERE expense_date >= ? AND expense_date <= ? AND deleted_at IS NULL`,
                    [periodFrom, periodTo],
                    (e4, expRow) => {
                        const periodExpenses = parseFloat(expRow ? expRow.period_expenses : 0);

                        // Pending quotes value — real data from quotations table (SENT/unsent, not yet accepted)
                        db.get(
                            `SELECT COALESCE(SUM(q.total), 0) AS pending_quotes_value,
                                    COUNT(*) AS pending_quotes_count
                             FROM quotations q
                             JOIN bookings b ON q.booking_id = b.id
                             WHERE q.archived = 0
                               AND b.status = 'QUOTED'`,
                            [],
                            (e5, qRow) => {
                                // Overdue invoices (SENT status with a due_date in the past)
                                db.get(
                                    `SELECT COUNT(*) AS overdue_count,
                                            COALESCE(SUM(total_amount), 0) AS overdue_value
                                     FROM invoices
                                     WHERE status = 'SENT'
                                       AND due_date IS NOT NULL
                                       AND due_date < DATE('now')`,
                                    [],
                                    (e6, overdueRow) => {
                                        // Invoices due within next 7 days (SENT, not yet past due)
                                        db.get(
                                            `SELECT COUNT(*) AS cnt, COALESCE(SUM(total_amount), 0) AS val
                                             FROM invoices
                                             WHERE status = 'SENT'
                                               AND due_date IS NOT NULL
                                               AND due_date >= DATE('now')
                                               AND due_date <= DATE('now', '+7 days')`,
                                            [],
                                            (e7, dueSoonRow) => {
                                                // Invoices generated but never sent for CONFIRMED bookings
                                                db.get(
                                                    `SELECT COUNT(*) AS cnt
                                                     FROM invoices i
                                                     JOIN bookings b ON b.id = i.booking_id
                                                     WHERE i.sent_at IS NULL
                                                       AND i.status NOT IN ('void', 'VOID')
                                                       AND b.status = 'CONFIRMED'`,
                                                    [],
                                                    (e8, unsentRow) => {
                                                        // Recent transactions with client name (200 rows so client-side filter has full history)
                                                        db.all(
                                                            `SELECT t.*, b.name AS client_name
                                                             FROM transactions t
                                                             LEFT JOIN bookings b ON t.booking_id = b.id
                                                             ORDER BY t.created_at DESC LIMIT 200`,
                                                            [],
                                                            (e9, transactions) => {
                                                                db.get('SELECT COUNT(*) AS total FROM transactions', [], (e10, countRow) => {
                                                                    res.json({
                                                                        success: true,
                                                                        period: { from: periodFrom, to: periodTo },
                                                                        stats: {
                                                                            revenue: periodRevenue,
                                                                            outstanding: totalOutstanding,
                                                                            monthly_expenses: periodExpenses,
                                                                            net_profit_month: periodRevenue - periodExpenses,
                                                                            pending_quotes_value: parseFloat(qRow ? qRow.pending_quotes_value : 0),
                                                                            pending_quotes_count: parseInt(qRow ? qRow.pending_quotes_count : 0),
                                                                            overdue_invoices_count: parseInt(overdueRow ? overdueRow.overdue_count : 0),
                                                                            overdue_invoices_value: parseFloat(overdueRow ? overdueRow.overdue_value : 0),
                                                                            due_soon_invoices_count: parseInt(dueSoonRow ? dueSoonRow.cnt : 0),
                                                                            due_soon_invoices_value: parseFloat(dueSoonRow ? dueSoonRow.val : 0),
                                                                            unsent_invoices_count: parseInt(unsentRow ? unsentRow.cnt : 0),
                                                                            total_transaction_count: countRow ? countRow.total : 0,
                                                                            counts: {
                                                                                pending:   counts ? counts.pending_count   : 0,
                                                                                quoted:    counts ? counts.quoted_count    : 0,
                                                                                confirmed: counts ? counts.confirmed_count : 0
                                                                            }
                                                                        },
                                                                        recentTransactions: transactions || []
                                                                    });
                                                                });
                                                            }
                                                        );
                                                    }
                                                );
                                            }
                                        );
                                    }
                                );
                            }
                        );
                    }
                );
            });
        });
    });
});


// ========================================
// RECONCILIATION ENDPOINTS (Admin)
// ========================================

// GET /api/admin/reconciliation — full reconciliation matrix per booking
app.get('/api/admin/reconciliation', requireAdmin, requireRole(['administrator', 'manager']), (req, res) => {
    const query = `
        SELECT
            b.id AS booking_id,
            b.name AS client_name,
            b.event_name,
            b.date AS event_date,
            b.status,
            b.payment_status,
            COALESCE(b.total_amount, 0) AS quoted_amount,
            COALESCE(b.amount_paid, 0)  AS amount_paid,
            COALESCE(b.amount_outstanding, 0) AS outstanding,

            -- PayFast transactions (non-duplicate)
            COALESCE(SUM(CASE WHEN t.source = 'payfast' AND COALESCE(t.is_duplicate, 0) = 0 THEN (CASE WHEN t.transaction_type = 'refund' THEN -t.amount WHEN t.transaction_type = 'adjustment' THEN 0 ELSE t.amount END) ELSE 0 END), 0) AS payfast_total,
            -- Manual transactions (non-duplicate)
            COALESCE(SUM(CASE WHEN t.source = 'manual' AND COALESCE(t.is_duplicate, 0) = 0 THEN (CASE WHEN t.transaction_type = 'refund' THEN -t.amount WHEN t.transaction_type = 'adjustment' THEN 0 ELSE t.amount END) ELSE 0 END), 0) AS manual_total,
            -- All flagged duplicates
            COALESCE(SUM(CASE WHEN COALESCE(t.is_duplicate, 0) = 1 THEN (CASE WHEN t.transaction_type = 'refund' THEN -t.amount WHEN t.transaction_type = 'adjustment' THEN 0 ELSE t.amount END) ELSE 0 END), 0) AS duplicate_total,

            -- Effective received = payfast + manual (excluding duplicates)
            COALESCE(SUM(CASE WHEN COALESCE(t.is_duplicate, 0) = 0 THEN (CASE WHEN t.transaction_type = 'refund' THEN -t.amount WHEN t.transaction_type = 'adjustment' THEN 0 ELSE t.amount END) ELSE 0 END), 0) AS effective_received,

            -- Warning flags
            -- 'duplicate': both payfast and manual entries exist for same booking
            CASE
                WHEN SUM(CASE WHEN t.source = 'payfast' THEN 1 ELSE 0 END) > 0
                 AND SUM(CASE WHEN t.source = 'manual'  THEN 1 ELSE 0 END) > 0
                THEN 1 ELSE 0
            END AS has_both_sources,

            -- 'overpayment': effective received > quoted amount (and quoted > 0)
            CASE
                WHEN COALESCE(b.total_amount, 0) > 0
                 AND COALESCE(SUM(CASE WHEN COALESCE(t.is_duplicate, 0) = 0 THEN (CASE WHEN t.transaction_type = 'refund' THEN -t.amount WHEN t.transaction_type = 'adjustment' THEN 0 ELSE t.amount END) ELSE 0 END), 0) > COALESCE(b.total_amount, 0) + 1.0
                THEN 1 ELSE 0
            END AS is_overpaid

        FROM bookings b
        LEFT JOIN transactions t ON t.booking_id = b.id AND t.status = 'completed'
        WHERE b.status != 'CANCELLED'
        GROUP BY b.id
        ORDER BY b.date DESC
    `;
    db.all(query, [], (err, rows) => {
        if (err) return res.status(500).json({ success: false, message: err.message });

        // Summary footer
        const totalQuoted   = rows.reduce((s, r) => s + parseFloat(r.quoted_amount   || 0), 0);
        const totalReceived = rows.reduce((s, r) => s + parseFloat(r.effective_received || 0), 0);
        const totalDupes    = rows.reduce((s, r) => s + parseFloat(r.duplicate_total  || 0), 0);

        res.json({
            success: true,
            rows,
            summary: { total_quoted: totalQuoted, total_received: totalReceived, total_duplicates_flagged: totalDupes }
        });
    });
});

// GET /api/admin/reconciliation/:bookingId/transactions — full tx list for one booking (expandable row)
app.get('/api/admin/reconciliation/:bookingId/transactions', requireAdmin, requireRole(['administrator', 'manager']), (req, res) => {
    db.all(
        `SELECT id, amount, source, payment_method, reference, transaction_date, status, is_duplicate, reconcile_note
         FROM transactions WHERE booking_id = ? AND status = 'completed' ORDER BY transaction_date DESC`,
        [req.params.bookingId], (err, rows) => {
            if (err) return res.status(500).json({ success: false, message: err.message });
            res.json({ success: true, transactions: rows || [] });
        }
    );
});

// PATCH /api/admin/transactions/:id/reconcile — flag/unflag as duplicate (audit-safe, no delete)
app.patch('/api/admin/transactions/:id/reconcile', requireAdmin, requireRole(['administrator', 'manager']), (req, res) => {
    const { is_duplicate, reconcile_note } = req.body;
    const flag = is_duplicate ? 1 : 0;
    const note = (reconcile_note || '').trim().substring(0, 255);
    const adminUser = req.session.username || 'system';

    db.run(
        `UPDATE transactions SET is_duplicate = ?, reconcile_note = ? WHERE id = ?`,
        [flag, note || null, req.params.id],
        function(err) {
            if (err || this.changes === 0) {
                return res.status(err ? 500 : 404).json({ success: false, message: err ? err.message : 'Transaction not found.' });
            }
            // Audit trail — never delete, just log the flag change
            db.run(
                `INSERT INTO audit_log (table_name, record_id, action, changed_by, changes_json)
                 VALUES ('transactions', ?, ?, ?, ?)`,
                [req.params.id, flag ? 'FLAG_DUPLICATE' : 'UNFLAG_DUPLICATE', adminUser,
                 JSON.stringify({ is_duplicate: flag, reconcile_note: note })],
                () => {}
            );
            res.json({ success: true, message: flag ? 'Flagged as duplicate.' : 'Unflagged.' });
        }
    );
});

// ─── BANK STATEMENT IMPORT & MATCHING ───────────────────────────────────────

const csvUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// POST /api/admin/bank-statement/import — parse and store a CSV bank statement
app.post('/api/admin/bank-statement/import', requireAdmin, requireRole(['administrator', 'manager']), csvUpload.single('statement'), (req, res) => {
    if (!req.file) return res.status(400).json({ success: false, message: 'No file received.' });
    const batchId = 'BS-' + Date.now();
    const importDate = new Date().toISOString().split('T')[0];
    const text = req.file.buffer.toString('utf8');
    const rawLines = text.split('\n').map(l => l.trim()).filter(l => l);
    // Skip header row if first cell looks like 'date' or 'Date'
    const lines = rawLines.filter(l => !/^["']?date["']?[,;]/i.test(l));
    const insertStmt = db.prepare(
        `INSERT INTO bank_statement_lines (import_batch, import_date, statement_date, description, amount, reference)
         VALUES (?, ?, ?, ?, ?, ?)`
    );
    let imported = 0;
    const insertMany = db.transaction(() => {
        for (const line of lines) {
            const parts = (line.match(/(".*?"|[^,;]+)(?:[,;]|$)/g) || []).map(p => p.replace(/^[",;]+|[",;]+$/g, '').trim());
            if (parts.length < 3) continue;
            const [stmtDate, description, rawAmount, reference] = parts;
            const amount = parseFloat((rawAmount || '').replace(/[^0-9.\-]/g, ''));
            if (isNaN(amount) || !stmtDate) continue;
            insertStmt.run(batchId, importDate, stmtDate, description || '', amount, reference || null);
            imported++;
        }
    });
    try { insertMany(); } catch(e) { return res.status(500).json({ success: false, message: e.message }); }
    res.json({ success: true, batch_id: batchId, imported });
});

// GET /api/admin/bank-statement/lines — list imported lines with optional batch filter
app.get('/api/admin/bank-statement/lines', requireAdmin, requireRole(['administrator', 'manager']), (req, res) => {
    const { batch_id, unmatched_only } = req.query;
    let sql = `SELECT bsl.*, b.name AS matched_client
               FROM bank_statement_lines bsl
               LEFT JOIN bookings b ON bsl.matched_booking_id = b.id
               WHERE 1=1`;
    const params = [];
    if (batch_id)       { sql += ' AND bsl.import_batch = ?'; params.push(batch_id); }
    if (unmatched_only === '1') { sql += ' AND bsl.matched_transaction_id IS NULL AND bsl.matched_booking_id IS NULL'; }
    sql += ' ORDER BY bsl.statement_date DESC';
    db.all(sql, params, (err, rows) => {
        if (err) return res.status(500).json({ success: false, message: err.message });
        db.all(
            `SELECT import_batch, import_date, COUNT(*) AS line_count,
                    SUM(CASE WHEN matched_booking_id IS NULL AND matched_transaction_id IS NULL THEN 1 ELSE 0 END) AS unmatched_count
             FROM bank_statement_lines GROUP BY import_batch ORDER BY import_date DESC`,
            [],
            (e2, batches) => {
                res.json({ success: true, lines: rows || [], batches: batches || [] });
            }
        );
    });
});

// PATCH /api/admin/bank-statement/lines/:id/match — link a line to a booking
app.patch('/api/admin/bank-statement/lines/:id/match', requireAdmin, requireRole(['administrator', 'manager']), (req, res) => {
    const { booking_id, transaction_id, match_note } = req.body;
    db.run(
        `UPDATE bank_statement_lines SET matched_booking_id=?, matched_transaction_id=?, match_note=? WHERE id=?`,
        [booking_id || null, transaction_id || null, (match_note || '').trim() || null, req.params.id],
        function(err) {
            if (err || this.changes === 0) return res.status(err ? 500 : 404).json({ success: false, message: err?.message || 'Line not found.' });
            res.json({ success: true });
        }
    );
});

// DELETE /api/admin/bank-statement/lines/:id — remove a single imported line
app.delete('/api/admin/bank-statement/lines/:id', requireAdmin, requireRole(['administrator', 'manager']), (req, res) => {
    db.run('DELETE FROM bank_statement_lines WHERE id = ?', [req.params.id], function(err) {
        if (err || this.changes === 0) return res.status(err ? 500 : 404).json({ success: false });
        res.json({ success: true });
    });
});

// DELETE /api/admin/bank-statement/batch/:batchId — delete an entire import batch
app.delete('/api/admin/bank-statement/batch/:batchId', requireAdmin, requireRole(['administrator', 'manager']), (req, res) => {
    db.run('DELETE FROM bank_statement_lines WHERE import_batch = ?', [req.params.batchId], function(err) {
        if (err) return res.status(500).json({ success: false, message: err.message });
        res.json({ success: true, deleted: this.changes });
    });
});

// GET /api/admin/reconciliation/export/csv — CSV export for accountant
app.get('/api/admin/reconciliation/export/csv', requireAdmin, requireRole(['administrator', 'manager']), (req, res) => {
    const query = `
        SELECT
            b.id, b.name AS client, b.event_name, b.date AS event_date, b.status, b.payment_status,
            COALESCE(b.total_amount,0) AS quoted,
            COALESCE(SUM(CASE WHEN COALESCE(t.is_duplicate,0)=0 AND t.source='payfast' THEN t.amount ELSE 0 END),0) AS payfast_received,
            COALESCE(SUM(CASE WHEN COALESCE(t.is_duplicate,0)=0 AND t.source='manual'  THEN t.amount ELSE 0 END),0) AS manual_received,
            COALESCE(SUM(CASE WHEN COALESCE(t.is_duplicate,0)=1 THEN t.amount ELSE 0 END),0) AS duplicates_flagged,
            COALESCE(SUM(CASE WHEN COALESCE(t.is_duplicate,0)=0 THEN t.amount ELSE 0 END),0) AS effective_received,
            COALESCE(b.amount_outstanding,0) AS outstanding,
            CASE
                WHEN SUM(CASE WHEN t.source='payfast' THEN 1 ELSE 0 END)>0
                 AND SUM(CASE WHEN t.source='manual'  THEN 1 ELSE 0 END)>0 THEN 'YES' ELSE 'NO'
            END AS dual_source_warning,
            CASE
                WHEN COALESCE(b.total_amount,0)>0
                 AND COALESCE(SUM(CASE WHEN COALESCE(t.is_duplicate,0)=0 THEN t.amount ELSE 0 END),0) > COALESCE(b.total_amount,0)+1.0 THEN 'YES' ELSE 'NO'
            END AS overpayment_warning
        FROM bookings b
        LEFT JOIN transactions t ON t.booking_id=b.id AND t.status='completed'
        WHERE b.status != 'CANCELLED'
        GROUP BY b.id ORDER BY b.date DESC
    `;
    db.all(query, [], (err, rows) => {
        if (err) return res.status(500).json({ success: false, message: err.message });

        const headers = ['BookingID','Client','Event','Date','Status','PaymentStatus','Quoted','PayFast_Received','Manual_Received','Duplicates_Flagged','Effective_Received','Outstanding','DualSourceWarning','OverpaymentWarning'];
        const csvRows = rows.map(r => [
            r.id, `"${(r.client||'').replace(/"/g,'""')}"`, `"${(r.event_name||'').replace(/"/g,'""')}"`,
            r.event_date, r.status, r.payment_status,
            parseFloat(r.quoted).toFixed(2), parseFloat(r.payfast_received).toFixed(2),
            parseFloat(r.manual_received).toFixed(2), parseFloat(r.duplicates_flagged).toFixed(2),
            parseFloat(r.effective_received).toFixed(2), parseFloat(r.outstanding).toFixed(2),
            r.dual_source_warning, r.overpayment_warning
        ].join(','));

        const csv = [headers.join(','), ...csvRows].join('\r\n');
        const date = new Date().toISOString().split('T')[0];
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="reconciliation-${date}.csv"`);
        res.send(csv);
    });
});

// 5. Booking-Specific Financial Details (Admin)

app.get('/api/admin/bookings/:id/financials', requireAdmin, requireRole(['administrator', 'manager']), (req, res) => {
    const bookingId = req.params.id;
    const result = { quote: null, invoice: null };

    db.get("SELECT * FROM quotations WHERE booking_id = ? ORDER BY created_at DESC LIMIT 1", [bookingId], (err, quote) => {
        if (quote) {
            result.quote = {
                id: quote.id,
                quote_number: quote.quote_number,
                pdf_url: `/docs/quotes/${quote.file_path}`,
                created_at: quote.created_at
            };
        }
        
        db.get("SELECT * FROM invoices WHERE booking_id = ? ORDER BY invoice_date DESC LIMIT 1", [bookingId], (err, invoice) => {
            if (invoice) {
                result.invoice = {
                    id: invoice.id,
                    invoice_number: invoice.invoice_number,
                    pdf_url: `/docs/invoices/${invoice.file_path}`,
                    status: invoice.status,
                    total_amount: invoice.total_amount
                };
            }
            res.json(result);
        });
    });
});

// Rows removed with the booking. `PRAGMA foreign_keys = ON` is set on the shared connection, and
// every one of these declares a FK to bookings(id) with ON DELETE NO ACTION — so any table missing
// from this list makes `DELETE FROM bookings` fail outright with FOREIGN KEY constraint failed.
// consent_audit, payment_logs and reminders_log were missing, which made 15 of the 33 bookings
// that business rules allow deleting undeletable (HTTP 500).
//
// consent_audit is purged deliberately: deleting a booking erases the personal data captured with
// it (IP, user agent), so retaining its consent proof would leave exactly the orphaned rows this
// route produced before FK enforcement. The audit_log DELETE entry remains as the record.
//
// Order matters — node-sqlite3 runs these sequentially on the one connection, so line-item children
// go before their parent invoice/quotation rows, and bookings.event_id is cleared before the events
// row it points at is removed (bookings.event_id and events.booking_id reference each other).
const BOOKING_DELETE_PURGE = [
    "UPDATE bookings SET event_id = NULL WHERE id = ?",
    "DELETE FROM invoice_line_items WHERE invoice_id IN (SELECT id FROM invoices WHERE booking_id = ?)",
    "DELETE FROM quote_line_items WHERE quotation_id IN (SELECT id FROM quotations WHERE booking_id = ?)",
    "DELETE FROM quotations WHERE booking_id = ?",
    "DELETE FROM invoices WHERE booking_id = ?",
    "DELETE FROM cancellations WHERE booking_id = ?",
    "DELETE FROM contracts WHERE booking_id = ?",
    "DELETE FROM payment_schedules WHERE booking_id = ?",
    "DELETE FROM booking_services WHERE booking_id = ?",
    "DELETE FROM booking_line_items WHERE booking_id = ?",
    "DELETE FROM service_reviews WHERE booking_id = ?",
    "DELETE FROM booking_notes WHERE booking_id = ?",
    "DELETE FROM communication_log WHERE booking_id = ?",
    "DELETE FROM transactions WHERE booking_id = ?",
    "DELETE FROM date_holds WHERE converted_to_booking_id = ?",
    "DELETE FROM events WHERE booking_id = ?",
    "DELETE FROM consent_audit WHERE booking_id = ?",
    "DELETE FROM payment_logs WHERE booking_id = ?",
    "DELETE FROM reminders_log WHERE booking_id = ?"
];

// Records that outlive the booking. An expense is a cost the business incurred and a bank statement
// line is a bank's record — neither stops existing because a booking was removed. Both columns are
// nullable, so the row is kept and only the link is dropped.
const BOOKING_DELETE_UNLINK = [
    "UPDATE expenses SET booking_id = NULL WHERE booking_id = ?",
    "UPDATE bank_statement_lines SET matched_booking_id = NULL WHERE matched_booking_id = ?"
];

app.delete('/api/admin/bookings/:id', requireAdmin, requireRole(['administrator']), async (req, res) => {
    const id = req.params.id;
    try {
        const booking = await dbGet("SELECT * FROM bookings WHERE id = ?", [id]);
        if (!booking) return res.status(404).json({ success: false, message: 'Booking not found.' });
        if (parseFloat(booking.amount_paid) > 0) {
            return res.status(400).json({ success: false, message: 'Cannot delete a booking with recorded payments. Cancel it instead to preserve the financial audit trail.' });
        }

        const outcome = await withDbTransaction(async () => {
            try {
                await dbRun("BEGIN IMMEDIATE");
            } catch (beginErr) {
                console.error('[Delete] BEGIN IMMEDIATE failed:', beginErr.message);
                return { status: 500, body: { success: false, error: 'Database busy. Please retry.' } };
            }
            try {
                for (const sql of BOOKING_DELETE_PURGE) await dbRun(sql, [id]);
                for (const sql of BOOKING_DELETE_UNLINK) await dbRun(sql, [id]);

                // Inside the transaction: a failed delete must not leave an audit_log row claiming
                // the booking was deleted. This previously ran before the transaction even opened.
                await dbRun(
                    `INSERT INTO audit_log (table_name, record_id, action, old_values, new_values, changed_by, ip_address) VALUES ('bookings', ?, 'DELETE', ?, '{}', 'admin', ?)`,
                    [id, JSON.stringify(booking), req.ip || null]
                );

                const del = await dbRun("DELETE FROM bookings WHERE id = ?", [id]);
                if (del.changes === 0) {
                    await dbRun("ROLLBACK").catch(() => {});
                    return { status: 404, body: { success: false, message: 'Booking not found.' } };
                }
                await dbRun("COMMIT");
                return { ok: true };
            } catch (dbErr) {
                await dbRun("ROLLBACK").catch(() => {});
                console.error('[Delete] Cascade failed — rolled back, booking left intact:', dbErr.message);
                return { status: 500, body: { success: false, error: 'Cascade delete failed.' } };
            }
        });

        if (!outcome.ok) return res.status(outcome.status).json(outcome.body);

        // Only once the booking is really gone. This used to run before the transaction, so a
        // failed delete still destroyed the Google Calendar event of a booking that still existed.
        if (booking.google_event_id) {
            deleteGoogleEvent(booking.google_event_id).catch(e => console.error('[Delete] GCal cleanup failed:', e.message));
        }
        res.json({ success: true });
    } catch (e) {
        console.error('[Delete] Booking delete failed:', e);
        res.status(500).json({ success: false, error: 'Failed to delete booking.' });
    }
});

// --- Public Events ---
app.get('/api/public/events', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 100, 200);
    const offset = parseInt(req.query.offset) || 0;
    db.all("SELECT * FROM events WHERE event_status NOT IN ('cancelled', 'draft') ORDER BY event_datetime ASC LIMIT ? OFFSET ?", [limit, offset], (err, siteEvents) => {
        if (err) return res.status(500).json({ error: err.message });
        const mapped = (siteEvents || []).map(e => ({...e, source: 'event'}));
        res.json(mapped);
    });
});

// ========================================
// PAYMENT REMINDERS LOG ENDPOINTS
// ========================================

app.get('/api/admin/reminders', requireAdmin, (req, res) => {
    const limit = parseInt(req.query.limit) || 100;
    const booking_id = req.query.booking_id ? parseInt(req.query.booking_id) : null;
    let query = `
        SELECT r.*, b.name AS client_name, b.event_name, b.email AS client_email
        FROM reminders_log r
        LEFT JOIN bookings b ON b.id = r.booking_id
        ${booking_id ? 'WHERE r.booking_id = ?' : ''}
        ORDER BY r.sent_at DESC LIMIT ?
    `;
    const params = booking_id ? [booking_id, limit] : [limit];
    db.all(query, params, (err, rows) => {
        if (err) return res.status(500).json({ success: false, message: err.message });
        res.json({ success: true, reminders: rows || [] });
    });
});

app.post('/api/admin/reminders/run', requireAdmin, async (req, res) => {
    try {
        const result = await runPaymentReminderJob();
        res.json({ success: true, sent: result.sent, skipped: result.skipped, errors: result.errors });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// --- Events ---
app.get('/api/admin/events', requireAdmin, (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 200, 500);
    const offset = parseInt(req.query.offset) || 0;
    const status = req.query.status || null;
    const params = status ? [status, limit, offset] : [limit, offset];
    const where = status ? "WHERE event_status = ?" : "";
    db.all(`SELECT * FROM events ${where} ORDER BY event_datetime DESC LIMIT ? OFFSET ?`, params, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});
const VALID_EVENT_STATUSES = ['upcoming', 'draft', 'live', 'completed', 'cancelled', 'postponed', 'sold_out'];
const VALID_EVENT_TYPES = ['Corporate Event', 'Festival / Concert', 'Private Function', 'Comedy Club', 'University / College', 'Charity / Fundraiser', 'Virtual Event', 'Other', ''];

function checkEventConflicts(event_datetime, booking_id, excludeEventId, callback) {
    const eventDateStr = (event_datetime || '').split('T')[0];
    if (!eventDateStr || booking_id) return callback(null, false);
    // Extract event time if present (ISO datetime "YYYY-MM-DDTHH:MM...")
    const eventTime = (event_datetime && event_datetime.length > 10) ? event_datetime.substring(11, 16) : null;
    const eventEndTime = eventTime ? addMinutesToTime(eventTime, 60) : null; // assume 1-hour event duration
    const excludeId = excludeEventId || -1;

    db.all(
        `SELECT id, event_start_time, performance_end_time, performance_duration
         FROM bookings 
         WHERE date = ? AND status != 'CANCELLED' AND (event_id IS NULL OR event_id != ?)`,
        [eventDateStr, excludeId], (err, bRows) => {
            if (err) return callback(err);
            let conflict = false;
            if (bRows && bRows.length > 0) {
                if (!eventTime) {
                    conflict = true; // all-day event — any booking on same day is a conflict
                } else {
                    for (const b of bRows) {
                        if (!b.event_start_time) { conflict = true; break; }
                        const bEnd = b.performance_end_time ||
                            addMinutesToTime(b.event_start_time, parseDurationToMinutes(b.performance_duration));
                        if (timeRangesOverlap(eventTime, eventEndTime, b.event_start_time, bEnd)) { conflict = true; break; }
                    }
                }
            }
            if (conflict) return callback(null, true);

            db.all(
                `SELECT id, start_time, end_time FROM date_holds 
                 WHERE hold_date = ? AND status = 'active' AND (event_id IS NULL OR event_id != ?)`,
                [eventDateStr, excludeId], (err2, hRows) => {
                    if (err2) return callback(err2);
                    if (hRows && hRows.length > 0) {
                        if (!eventTime) {
                            conflict = true; // all-day event — any hold blocks
                        } else {
                            for (const h of hRows) {
                                if (!h.start_time) { conflict = true; break; }
                                const hEnd = h.end_time || addMinutesToTime(h.start_time, 60);
                                if (timeRangesOverlap(eventTime, eventEndTime, h.start_time, hEnd)) { conflict = true; break; }
                            }
                        }
                    }
                    callback(null, conflict);
                }
            );
        }
    );
}

app.post('/api/admin/events', requireAdmin, (req, res) => {
    const { event_title, event_description, event_datetime, event_end_time, event_type, venue_name, venue_id, venue_map_link, ticket_sales_link, poster_image_path, event_status, event_capacity, booking_id, block_type } = req.body;
    const ip_address = req.ip || req.connection.remoteAddress || 'unknown';
    const user_agent = req.get('User-Agent') || 'unknown';

    // Input validation
    if (!event_title || !event_title.trim()) return res.status(400).json({ success: false, error: 'event_title is required' });
    if (!event_datetime) return res.status(400).json({ success: false, error: 'event_datetime is required' });
    if (!/^\d{4}-\d{2}-\d{2}/.test(event_datetime)) return res.status(400).json({ success: false, error: 'event_datetime must be ISO format (YYYY-MM-DD...)' });
    if (event_status && !VALID_EVENT_STATUSES.includes(event_status)) return res.status(400).json({ success: false, error: 'Invalid event_status value' });
    if (event_type && !VALID_EVENT_TYPES.includes(event_type)) return res.status(400).json({ success: false, error: 'Invalid event_type value' });

    const eventDateStr = (event_datetime || '').split('T')[0];

    checkEventConflicts(event_datetime, booking_id, null, (err, hasConflict) => {
        if (err) return res.status(500).json({ success: false, error: 'Conflict check failed: ' + err.message });
        if (hasConflict) return res.status(409).json({ success: false, message: 'Calendar conflict: The selected date is already booked or held.' });

        db.run("INSERT INTO events (event_title, event_description, event_datetime, event_end_time, event_type, venue_name, venue_id, venue_map_link, ticket_sales_link, poster_image_path, event_status, event_capacity, booking_id, created_by, ip_address, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [event_title, event_description, event_datetime, event_end_time || null, event_type || null, venue_name, venue_id || null, venue_map_link, ticket_sales_link, poster_image_path, event_status || 'upcoming', event_capacity || null, booking_id || null, req.session.adminId, ip_address, user_agent],
            async function(err) {
                if (err) return res.status(500).json({ success: false, error: err.message });
                const newEventId = this.lastID;

                if (booking_id) {
                    db.run("UPDATE bookings SET event_id = ? WHERE id = ?", [newEventId, booking_id]);
                }

                if (block_type === 'hold') {
                    db.run("INSERT INTO date_holds (hold_date, hold_expires_at, status, notes, event_id) VALUES (?, datetime('now', '+30 days'), 'active', ?, ?)", [eventDateStr, `Hold for ${event_title}`, newEventId]);
                } else if (block_type === 'booking') {
                    db.run("INSERT INTO bookings (name, email, date, event_name, status, event_id) VALUES (?, ?, ?, ?, ?, ?)", ['Placeholder', 'placeholder@example.com', eventDateStr, event_title, 'PENDING', newEventId]);
                }

                let gcalSynced = false;
                if (req.body.sync_to_gcal !== false) {
                    try { gcalSynced = !!(await syncEventToCalendar(newEventId)); }
                    catch(e) { console.error('GCal sync error:', e); }
                }
                res.json({ success: true, id: newEventId, message: 'Event added successfully', gcal_synced: gcalSynced });
            });
    });
});
app.put('/api/admin/events/:id', requireAdmin, (req, res) => {
    const { event_title, event_description, event_datetime, event_end_time, event_type, venue_name, venue_id, venue_map_link, ticket_sales_link, poster_image_path, event_status, event_capacity, cancellation_reason, booking_id } = req.body;
    const ip_address = req.ip || req.connection.remoteAddress || 'unknown';
    const user_agent = req.get('User-Agent') || 'unknown';
    const eventId = req.params.id;

    if (!event_title || !event_title.trim()) return res.status(400).json({ success: false, error: 'event_title is required' });
    if (event_status && !VALID_EVENT_STATUSES.includes(event_status)) return res.status(400).json({ success: false, error: 'Invalid event_status value' });
    if (event_type && !VALID_EVENT_TYPES.includes(event_type)) return res.status(400).json({ success: false, error: 'Invalid event_type value' });

    checkEventConflicts(event_datetime, booking_id, eventId, (conflictErr, hasConflict) => {
        if (conflictErr) return res.status(500).json({ success: false, error: 'Conflict check failed: ' + conflictErr.message });
        if (hasConflict) return res.status(409).json({ success: false, message: 'Calendar conflict: The selected date is already booked or held.' });

        // Read old datetime before updating so we can detect date changes
        db.get("SELECT event_datetime, booking_id AS old_booking_id FROM events WHERE event_id = ?", [eventId], (selErr, oldRow) => {
            db.run("UPDATE events SET event_title = ?, event_description = ?, event_datetime = ?, event_end_time = ?, event_type = ?, venue_name = ?, venue_id = ?, venue_map_link = ?, ticket_sales_link = ?, poster_image_path = ?, event_status = ?, event_capacity = ?, cancellation_reason = ?, booking_id = ?, modified_by = ?, modified_on = CURRENT_TIMESTAMP, ip_address = ?, user_agent = ? WHERE event_id = ?",
                [event_title, event_description, event_datetime, event_end_time || null, event_type || null, venue_name, venue_id || null, venue_map_link, ticket_sales_link, poster_image_path, event_status, event_capacity || null, cancellation_reason || null, booking_id || null, req.session.adminId, ip_address, user_agent, eventId],
                async function(err) {
                    if (err) return res.status(500).json({ success: false, error: err.message });
                    const resolvedBookingId = booking_id || (oldRow && oldRow.old_booking_id);
                    if (resolvedBookingId) {
                        db.run("UPDATE bookings SET event_id = ? WHERE id = ?", [eventId, resolvedBookingId]);
                        // Sync booking date if event_datetime changed
                        if (event_datetime && oldRow && event_datetime !== oldRow.event_datetime) {
                            const datePart = event_datetime.substring(0, 10);
                            const timePart = event_datetime.length >= 16 ? event_datetime.substring(11, 16) : null;
                            db.run("UPDATE bookings SET date = ?" + (timePart ? ", event_start_time = ?" : "") + " WHERE id = ?",
                                timePart ? [datePart, timePart, resolvedBookingId] : [datePart, resolvedBookingId]);
                        }
                    }
                    let gcalSynced = false;
                    if (req.body.sync_to_gcal !== false) {
                        try { gcalSynced = !!(await syncEventToCalendar(eventId)); }
                        catch(e) { console.error('GCal sync error:', e); }
                    }
                    res.json({ success: true, message: 'Event updated', gcal_synced: gcalSynced });
                });
        });
    });
});
app.delete('/api/admin/events/:id', requireAdmin, requireRole(['administrator']), (req, res) => {
    db.get("SELECT google_calendar_event_id FROM events WHERE event_id = ?", [req.params.id], (selErr, evRow) => {
        // Null out any booking that references this event before deleting to prevent dangling FK
        db.run("UPDATE bookings SET event_id = NULL WHERE event_id = ?", [req.params.id], () => {
            db.run("DELETE FROM events WHERE event_id = ?", [req.params.id], function(err) {
                if (err) return res.status(500).json({ success: false, error: err.message });
                res.json({ success: true, message: 'Event deleted' });
                if (evRow && evRow.google_calendar_event_id) {
                    deleteGoogleEvent(evRow.google_calendar_event_id).catch(e => console.error('GCal delete error:', e));
                }
            });
        });
    });
});

// Drag-drop date update for public events on the calendar
app.patch('/api/admin/events/:id/date', requireAdmin, async (req, res) => {
    const { date, time } = req.body;
    if (!date) return res.status(400).json({ success: false, message: 'date is required' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ success: false, message: 'date must be YYYY-MM-DD' });
    const eventId = req.params.id;
    const row = await new Promise(r => db.get("SELECT event_datetime, booking_id FROM events WHERE event_id = ?", [eventId], (e, x) => r(e ? null : x)));
    if (!row) return res.status(404).json({ success: false, message: 'Event not found' });
    const existingTime = time || (row.event_datetime || '').split('T')[1] || '00:00';
    const newDatetime = date + 'T' + existingTime;

    // L1: for a booking-linked event, re-check calendar conflicts before moving it — the same
    // guard the booking date-change endpoint (PATCH /bookings/:id/date) applies — so dragging an
    // event on the calendar can't silently create a double-booking. Terminal bookings are skipped.
    if (row.booking_id) {
        const booking = await new Promise(r => db.get("SELECT * FROM bookings WHERE id = ?", [row.booking_id], (e, x) => r(e ? null : x)));
        if (booking && !['CANCELLED', 'EXPIRED', 'COMPLETED'].includes((booking.status || '').toUpperCase())) {
            const startISO = moment(`${date} ${existingTime.substring(0, 5)}`).toISOString();
            const durMins = (booking.performance_end_time && booking.event_start_time)
                ? Math.max(30, moment(`2000-01-01 ${booking.performance_end_time}`).diff(moment(`2000-01-01 ${booking.event_start_time}`), 'minutes'))
                : parseDurationToMinutes(booking.performance_duration);
            const endISO = moment(startISO).add(durMins, 'minutes').toISOString();
            const busy = await hasCalendarConflict(startISO, endISO, parseInt(row.booking_id));
            if (busy) return res.status(409).json({ success: false, message: `That slot on ${date} conflicts with another booking or hold. Choose a different date/time.` });
        }
    }

    {
        db.run(
            "UPDATE events SET event_datetime = ?, modified_on = CURRENT_TIMESTAMP WHERE event_id = ?",
            [newDatetime, eventId],
            function(updateErr) {
                if (updateErr) return res.status(500).json({ success: false, error: updateErr.message });
                const oldDate = (row.event_datetime || '').split('T')[0];
                if (row.booking_id) {
                    db.run("UPDATE bookings SET date = ?, event_start_time = ? WHERE id = ?",
                        [date, existingTime.substring(0, 5), row.booking_id],
                        () => {
                            // Notify booking client of date change
                            db.get("SELECT * FROM bookings WHERE id = ?", [row.booking_id], (bErr, booking) => {
                                if (!bErr && booking) {
                                    if (booking.email && oldDate !== date) {
                                        sendDateChangedEmail(booking, oldDate, date)
                                            .catch(e => console.error('[Event Date Change] Client email failed:', e.message));
                                    }
                                    // E2: keep the booking's Google Calendar event in sync with the moved
                                    // date — the booking date changed above but its GCal event would
                                    // otherwise stay on the old date (calendar drift).
                                    syncBookingToCalendar(booking)
                                        .catch(e => console.error('[Event Date Change] Calendar sync failed:', e.message));
                                }
                            });
                        }
                    );
                }
                res.json({ success: true, event_datetime: newDatetime });
            }
        );
    }
});

// Duplicate an event (copy all fields, reset status to draft, append " (Copy)" to title)
app.post('/api/admin/events/:id/duplicate', requireAdmin, (req, res) => {
    db.get("SELECT * FROM events WHERE event_id = ?", [req.params.id], (err, row) => {
        if (err) return res.status(500).json({ success: false, error: err.message });
        if (!row) return res.status(404).json({ success: false, message: 'Event not found' });
        const newTitle = (row.event_title || 'Event') + ' (Copy)';
        db.run(
            `INSERT INTO events (event_title, event_description, event_datetime, event_end_time, event_type, venue_name,
                venue_id, venue_map_link, ticket_sales_link, poster_image_path, event_status, event_capacity,
                created_by, ip_address, user_agent)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)`,
            [newTitle, row.event_description, row.event_datetime, row.event_end_time, row.event_type,
             row.venue_name, row.venue_id, row.venue_map_link, row.ticket_sales_link, row.poster_image_path,
             row.event_capacity, req.session.adminId, req.ip || 'unknown', req.get('User-Agent') || 'unknown'],
            function(insErr) {
                if (insErr) return res.status(500).json({ success: false, error: insErr.message });
                res.json({ success: true, id: this.lastID, message: 'Event duplicated as draft' });
            }
        );
    });
});

// Admin Booking Direct Email Responder
app.post('/api/admin/bookings/:id/respond', requireAdmin, (req, res) => {
    const { email, subject, message } = req.body;
    const bookingId = req.params.id;

    if (!email || !subject || !message) {
        return res.status(400).json({ success: false, message: 'Missing email, subject, or message.' });
    }

    // Audit gap closed: this admin->client responder wasn't in the original email inventory.
    // It already used its own self-built shell correctly (unlike the dead-template bug found in
    // inquiry-reply/compose) — migrated to the shared component system for consistency.
    bannerRegistry.resolveBanner('booking_management_response').then(banner => {
    const htmlTemplate = emailComponents.renderPremiumEmail({
        preheaderText: `Re: Booking Request #${bookingId}`,
        bannerSrc: banner?.src, bannerAlt: banner?.alt, subtitle: banner?.subtitle,
        headline: banner?.headline || 'Management Response',
        bodyHtml: `<p style="color:#B0B0B0; font-size:13px; margin:0 0 12px;">In reference to Booking Request #${bookingId}</p>` + message.replace(/\n/g, '<br>')
    });

    sendEmail({
        to: email,
        subject: subject,
        htmlContent: htmlTemplate,
        preWrapped: true,
        replyTo: process.env.EMAIL_USER || process.env.NOTIFICATION_EMAIL || 'muzi.mlimi@gmail.com',
        titleOverride: 'Booking Management Response',
        trigger_event: 'Admin: Booking Respond'
    }).then(result => {
        if (result.success) {
            // Log outgoing communication for the booking's email history (store plain-text snippet)
            const textSnippet = message.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().substring(0, 1000);
            db.run(
                `INSERT INTO communication_log (booking_id, direction, channel, subject, content_snippet, sent_at)
                 VALUES (?, 'outgoing', 'email', ?, ?, CURRENT_TIMESTAMP)`,
                [bookingId, subject, textSnippet]
            );
            // Auto-update booking status upon send
            db.run("UPDATE bookings SET status = 'PENDING' WHERE id = ?", [bookingId], function(err) {
                if (err) console.error("Error auto-updating status to PENDING:", err);
                res.json({ success: true, message: 'Response dispatched successfully and status updated.' });
            });
        } else {
            throw new Error(result.error);
        }
    }).catch(error => {
        console.error('Error dispatching admin response email:', error);
        res.status(500).json({ success: false, message: 'Failed to dispatch email.', error: error.toString() });
    });
    });
});

// --- Career Highlights ---
app.get('/api/public/highlights', (req, res) => { // Public route for index.html
    db.all("SELECT * FROM career_highlights ORDER BY display_order ASC, created_at DESC", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});
// Admin route — same data/ordering as the public route, but session-gated for the dashboard
app.get('/api/admin/highlights', requireAdmin, (req, res) => {
    db.all("SELECT * FROM career_highlights ORDER BY display_order ASC, created_at DESC", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});
// Using Multer array middleware we defined earlier, or single file handler
app.post('/api/admin/highlights', requireAdmin, upload.single('file'), (req, res) => {
    const { year, title, badge, location, description, display_order, fallback_url } = req.body;
    // Prioritize uploaded file over the fallback URL
    const imagePath = req.file ? `images/${req.file.filename}` : (fallback_url || null);

    db.run("INSERT INTO career_highlights (year, title, badge, location, description, image_path, display_order) VALUES (?, ?, ?, ?, ?, ?, ?)", 
        [year, title, badge, location, description, imagePath, display_order || 0], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, id: this.lastID });
    });
});
app.put('/api/admin/highlights/:id', requireAdmin, (req, res) => {
    const { year, title, badge, location, description, display_order, fallback_url, clear_image } = req.body;
    const done = function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    };
    if (clear_image === true || clear_image === 'true') {
        // Clear the image path entirely
        db.run("UPDATE career_highlights SET year = ?, title = ?, badge = ?, location = ?, description = ?, image_path = NULL, display_order = ? WHERE id = ?",
            [year, title, badge, location, description, display_order, req.params.id], done);
    } else if (fallback_url) {
        // A new media URL was supplied on edit — update image_path too.
        db.run("UPDATE career_highlights SET year = ?, title = ?, badge = ?, location = ?, description = ?, image_path = ?, display_order = ? WHERE id = ?",
            [year, title, badge, location, description, fallback_url, display_order, req.params.id], done);
    } else {
        // No new media — leave the existing image_path untouched.
        db.run("UPDATE career_highlights SET year = ?, title = ?, badge = ?, location = ?, description = ?, display_order = ? WHERE id = ?",
            [year, title, badge, location, description, display_order, req.params.id], done);
    }
});
app.delete('/api/admin/highlights/:id', requireAdmin, requireRole(['administrator']), (req, res) => {
    db.run("DELETE FROM career_highlights WHERE id = ?", req.params.id, function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

// --- Home Slider Routes ---
app.get('/api/public/home-slider', (req, res) => {
    db.all("SELECT * FROM home_slider ORDER BY display_order ASC", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.get('/api/admin/home-slider', requireAdmin, (req, res) => {
    db.all("SELECT * FROM home_slider ORDER BY display_order ASC", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.post('/api/admin/home-slider', requireAdmin, (req, res) => {
    const { url, alt, file_name, file_size } = req.body;
    if (!url) return res.status(400).json({ success: false, message: 'URL is required' });
    const uploader_name = req.session.username || 'admin';
    db.run("INSERT INTO home_slider (url, alt, file_name, file_size, uploader_name, display_order) VALUES (?, ?, ?, ?, ?, (SELECT IFNULL(MAX(display_order), 0) + 1 FROM home_slider))",
        [url, alt || null, file_name || null, file_size || null, uploader_name], function(err) {
            if (err) return res.status(500).json({ success: false, error: err.message });
            res.json({ success: true, id: this.lastID });
        });
});

app.delete('/api/admin/home-slider/:id', requireAdmin, requireRole(['administrator']), (req, res) => {
    db.run("DELETE FROM home_slider WHERE id = ?", [req.params.id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

app.put('/api/admin/home-slider/reorder', requireAdmin, (req, res) => {
    const { order } = req.body; // Array of IDs in new order
    db.serialize(() => {
        const stmt = db.prepare("UPDATE home_slider SET display_order = ? WHERE id = ?");
        order.forEach((id, index) => {
            stmt.run(index, id);
        });
        stmt.finalize((err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true });
        });
    });
});

// NB: registered AFTER /home-slider/reorder so "reorder" is not captured as :id.
app.put('/api/admin/home-slider/:id', requireAdmin, (req, res) => {
    const { alt, url, file_name } = req.body;
    const done = function(err) {
        if (err) return res.status(500).json({ success: false, error: err.message });
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

app.post('/api/admin/publish-home-slider', requireAdmin, (req, res) => {
    db.all("SELECT url, alt FROM home_slider ORDER BY display_order ASC", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });

        try {
            const indexPath = path.join(__dirname, 'index.html');
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

// --- Gallery Images ---
app.get('/api/public/gallery', (req, res) => { // Public route for index.html
    db.all("SELECT * FROM gallery_images ORDER BY created_at DESC", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});
app.post('/api/admin/gallery', requireAdmin, upload.single('file'), (req, res) => {
    const { title, fallback_url, uploader_name, location } = req.body;
    const imagePath = req.file ? `images/gallery/${req.file.filename}` : (fallback_url || null);
    if (!imagePath) return res.status(400).json({ success: false, message: 'Image file required' });

    db.run("INSERT INTO gallery_images (title, image_path, uploader_name, location) VALUES (?, ?, ?, ?)", 
        [title, imagePath, uploader_name || null, location || null], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, id: this.lastID, imagePath });
    });
});
app.put('/api/admin/gallery/:id', requireAdmin, (req, res) => {
    const { title, fallback_url, uploader_name, location } = req.body;
    const done = function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    };
    if (fallback_url) {
        // A new media URL was supplied — update image_path too.
        db.run("UPDATE gallery_images SET title = ?, image_path = ?, uploader_name = ?, location = ? WHERE id = ?",
            [title, fallback_url, uploader_name || null, location || null, req.params.id], done);
    } else {
        // Title-only edit — leave the existing image untouched.
        db.run("UPDATE gallery_images SET title = ?, uploader_name = ?, location = ? WHERE id = ?",
            [title, uploader_name || null, location || null, req.params.id], done);
    }
});
app.delete('/api/admin/gallery/:id', requireAdmin, requireRole(['administrator']), (req, res) => {
    db.run("DELETE FROM gallery_images WHERE id = ?", req.params.id, function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

// --- Subscribers & Campaigns ---
app.get('/api/admin/subscribers', requireAdmin, (req, res) => {
    db.all("SELECT * FROM newsletter_subscribers ORDER BY subscribed_at DESC", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});
// (D11) Removed legacy GET /api/admin/campaigns — superseded by GET /api/admin/campaigns/unified
// (the only campaigns-list route the frontend calls). The POST /api/admin/campaigns send route is unaffected.
app.delete('/api/admin/campaigns/:id', requireAdmin, requireRole(['administrator']), (req, res) => {
    db.run("DELETE FROM newsletter_campaigns WHERE id = ?", [req.params.id], function(err) {
        if (err) return res.status(500).json({ success: false, message: err.message });
        if (this.changes === 0) return res.status(404).json({ success: false, message: 'Campaign not found.' });
        res.json({ success: true });
    });
});

app.get('/api/admin/campaigns/unified', requireAdmin, (req, res) => {
    const validStatuses = ['all', 'sent', 'scheduled', 'failed', 'cancelled'];
    const validSorts = ['date_desc', 'date_asc', 'subject_asc'];
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = 10;
    const offset = (page - 1) * limit;
    const statusFilter = validStatuses.includes(req.query.status) ? req.query.status : 'all';
    const sortBy = validSorts.includes(req.query.sort) ? req.query.sort : 'date_desc';
    const search = (req.query.search || '').trim();

    const orderClause = sortBy === 'date_asc' ? 'date ASC' :
                        sortBy === 'subject_asc' ? "LOWER(COALESCE(subject,'')) ASC" :
                        'date DESC';

    const conditions = [];
    const qp = [];
    if (statusFilter !== 'all') { conditions.push("display_status = ?"); qp.push(statusFilter); }
    if (search) { conditions.push("LOWER(COALESCE(subject,'')) LIKE LOWER(?)"); qp.push(`%${search}%`); }
    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const inner = `
        SELECT id, 'campaign' AS source, subject, content, 'sent' AS display_status, sent_at AS date
        FROM newsletter_campaigns
        UNION ALL
        SELECT id, 'schedule' AS source, subject, content,
            CASE WHEN status = 'pending' THEN 'scheduled'
                 WHEN status LIKE 'sent%' THEN 'sent'
                 WHEN status = 'cancelled' THEN 'cancelled'
                 ELSE 'failed' END AS display_status,
            COALESCE(scheduled_at, created_at) AS date
        FROM scheduled_newsletters`;

    const countSql = `SELECT COUNT(*) AS total FROM (${inner}) ${whereClause}`;
    const dataSql  = `SELECT * FROM (${inner}) ${whereClause} ORDER BY ${orderClause} LIMIT ? OFFSET ?`;

    db.get(countSql, qp, (err, countRow) => {
        if (err) return res.status(500).json({ success: false, message: err.message });
        db.all(dataSql, [...qp, limit, offset], (err2, rows) => {
            if (err2) return res.status(500).json({ success: false, message: err2.message });
            const total = countRow.total;
            res.json({ success: true, campaigns: rows, total, page, pages: Math.ceil(total / limit) });
        });
    });
});

app.post('/api/admin/campaigns/bulk-delete', requireAdmin, requireRole(['administrator']), (req, res) => {
    const { items } = req.body;
    if (!Array.isArray(items) || !items.length) {
        return res.status(400).json({ success: false, message: 'No items specified.' });
    }
    const campaignIds = items.filter(x => x.source === 'campaign' && x.id).map(x => parseInt(x.id));
    const scheduleIds = items.filter(x => x.source === 'schedule' && x.id).map(x => parseInt(x.id));

    scheduleIds.forEach(id => {
        if (scheduledJobs[id]) { scheduledJobs[id].cancel(); delete scheduledJobs[id]; }
    });

    let pending = 0;
    const done = () => { if (--pending === 0) res.json({ success: true }); };
    const fail = (err) => { if (!res.headersSent) res.status(500).json({ success: false, message: err.message }); };

    if (campaignIds.length) {
        pending++;
        const ph = campaignIds.map(() => '?').join(',');
        db.run(`DELETE FROM newsletter_campaigns WHERE id IN (${ph})`, campaignIds, err => { if (err) return fail(err); done(); });
    }
    if (scheduleIds.length) {
        pending++;
        const ph = scheduleIds.map(() => '?').join(',');
        db.all(`SELECT attachment_paths FROM scheduled_newsletters WHERE id IN (${ph})`, scheduleIds, (err, rows) => {
            if (!err && rows) {
                rows.forEach(r => {
                    if (r.attachment_paths) {
                        try { JSON.parse(r.attachment_paths).forEach(a => fs.unlink(a.path, () => {})); } catch(e) {}
                    }
                });
            }
            db.run(`DELETE FROM scheduled_newsletters WHERE id IN (${ph})`, scheduleIds, err2 => { if (err2) return fail(err2); done(); });
        });
    }
    if (pending === 0) res.json({ success: true });
});

// --- Inquiries ---
app.get('/api/admin/inquiries', requireAdmin, (req, res) => {
    const validStatuses = ['all', 'unread', 'read', 'replied', 'archived'];
    const validSorts = ['newest', 'oldest', 'name'];
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
    const offset = (page - 1) * limit;
    const statusFilter = validStatuses.includes(req.query.status) ? req.query.status : 'all';
    const sortBy = validSorts.includes(req.query.sort) ? req.query.sort : 'newest';
    const search = (req.query.search || '').trim();
    const category = (req.query.category || '').trim();

    const orderClause = sortBy === 'oldest' ? 'submitted_at ASC' :
                        sortBy === 'name' ? "LOWER(COALESCE(sender_name,'')) ASC" :
                        'submitted_at DESC';

    const conditions = [];
    const qp = [];
    if (statusFilter !== 'all') { conditions.push("status = ?"); qp.push(statusFilter); }
    if (category) { conditions.push("category = ?"); qp.push(category); }
    if (req.query.mine === '1') {
        conditions.push("assigned_to = ?"); qp.push(req.session.adminId);
    } else if (req.query.assigned_to) {
        const assignedTo = parseInt(req.query.assigned_to);
        if (!isNaN(assignedTo)) { conditions.push("assigned_to = ?"); qp.push(assignedTo); }
    }
    const validPriorities = ['low', 'normal', 'high', 'urgent'];
    if (validPriorities.includes(req.query.priority)) { conditions.push("priority = ?"); qp.push(req.query.priority); }
    if (search) {
        conditions.push("(LOWER(sender_name) LIKE LOWER(?) OR LOWER(sender_email) LIKE LOWER(?) OR LOWER(COALESCE(subject,'')) LIKE LOWER(?) OR LOWER(COALESCE(message_body,'')) LIKE LOWER(?))");
        const term = `%${search}%`;
        qp.push(term, term, term, term);
    }
    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const countSql = `SELECT COUNT(*) AS total FROM inquiries ${whereClause}`;
    const dataSql  = `SELECT inquiries.*, COALESCE(admins.full_name, admins.username) AS assigned_to_name
                       FROM inquiries LEFT JOIN admins ON admins.id = inquiries.assigned_to
                       ${whereClause} ORDER BY ${orderClause} LIMIT ? OFFSET ?`;

    // Folder badge counts are global totals (independent of current filter/search).
    db.all("SELECT status, COUNT(*) AS c FROM inquiries GROUP BY status", [], (errC, countRows) => {
        if (errC) return res.status(500).json({ success: false, message: errC.message });
        const counts = { all: 0, unread: 0, read: 0, replied: 0, archived: 0, drafts: 0, scheduled: 0, mine: 0 };
        (countRows || []).forEach(r => {
            if (counts.hasOwnProperty(r.status)) counts[r.status] = r.c;
            counts.all += r.c;
        });

        // Query direct_emails count for drafts & scheduled
        db.all("SELECT status, COUNT(*) AS c FROM direct_emails GROUP BY status", [], (errD, directRows) => {
            if (!errD && directRows) {
                directRows.forEach(r => {
                    if (r.status === 'draft') counts.drafts = r.c;
                    if (r.status === 'scheduled') counts.scheduled = r.c;
                });
            }

            db.get("SELECT COUNT(*) AS c FROM inquiries WHERE assigned_to = ?", [req.session.adminId], (errM, mineRow) => {
                if (!errM && mineRow) counts.mine = mineRow.c;

            db.get(countSql, qp, (err, countRow) => {
                if (err) return res.status(500).json({ success: false, message: err.message });
                db.all(dataSql, [...qp, limit, offset], (err2, rows) => {
                    if (err2) return res.status(500).json({ success: false, message: err2.message });
                    const total = countRow.total;
                    res.json({ success: true, inquiries: rows, counts, total, page, pages: Math.ceil(total / limit) });
                });
            });
            });
        });
    });
});

app.put('/api/admin/inquiries/:id/status', requireAdmin, requireRole(['administrator', 'manager']), (req, res) => {
    const { status } = req.body;
    const validStatuses = ['unread', 'read', 'replied', 'archived'];
    if (!validStatuses.includes(status)) {
        return res.status(400).json({ success: false, message: 'Invalid status.' });
    }
    db.run("UPDATE inquiries SET status = ? WHERE inquiry_id = ?", [status, req.params.id], function(err) {
        if (err) return res.status(500).json({ success: false, message: err.message });
        res.json({ success: true });
    });
});

// Active admins eligible to be assigned an inquiry (deliberately narrower than /api/admin/users,
// which is administrator-only and returns full PII) — any authenticated admin can view the list.
app.get('/api/admin/inquiries/assignable-admins', requireAdmin, (req, res) => {
    db.all("SELECT id, full_name, username, role FROM admins WHERE is_active = 1 ORDER BY full_name, username", [], (err, rows) => {
        if (err) return res.status(500).json({ success: false, message: err.message });
        res.json({ success: true, admins: rows });
    });
});

app.put('/api/admin/inquiries/:id/assign', requireAdmin, requireRole(['administrator', 'manager']), (req, res) => {
    const { assigned_to } = req.body;
    if (assigned_to === null || assigned_to === undefined || assigned_to === '') {
        return db.run("UPDATE inquiries SET assigned_to = NULL, assigned_at = NULL WHERE inquiry_id = ?", [req.params.id], function(err) {
            if (err) return res.status(500).json({ success: false, message: err.message });
            res.json({ success: true });
        });
    }
    const targetId = parseInt(assigned_to);
    if (isNaN(targetId)) return res.status(400).json({ success: false, message: 'Invalid assignee.' });
    db.get("SELECT id FROM admins WHERE id = ? AND is_active = 1", [targetId], (err, row) => {
        if (err) return res.status(500).json({ success: false, message: err.message });
        if (!row) return res.status(400).json({ success: false, message: 'Assignee must be an active admin.' });
        db.run("UPDATE inquiries SET assigned_to = ?, assigned_at = CURRENT_TIMESTAMP WHERE inquiry_id = ?", [targetId, req.params.id], function(err2) {
            if (err2) return res.status(500).json({ success: false, message: err2.message });
            res.json({ success: true });
        });
    });
});

app.put('/api/admin/inquiries/:id/priority', requireAdmin, requireRole(['administrator', 'manager']), (req, res) => {
    const { priority } = req.body;
    const validPriorities = ['low', 'normal', 'high', 'urgent'];
    if (!validPriorities.includes(priority)) {
        return res.status(400).json({ success: false, message: 'Invalid priority.' });
    }
    db.run("UPDATE inquiries SET priority = ? WHERE inquiry_id = ?", [priority, req.params.id], function(err) {
        if (err) return res.status(500).json({ success: false, message: err.message });
        res.json({ success: true });
    });
});

app.put('/api/admin/inquiries/bulk-status', requireAdmin, requireRole(['administrator', 'manager']), (req, res) => {
    const { ids, status } = req.body;
    const validStatuses = ['read', 'unread', 'replied', 'archived'];
    if (!Array.isArray(ids) || !ids.length) {
        return res.status(400).json({ success: false, message: 'No messages specified.' });
    }
    if (!validStatuses.includes(status)) {
        return res.status(400).json({ success: false, message: 'Invalid status.' });
    }
    const cleanIds = ids.map(x => parseInt(x)).filter(x => !isNaN(x));
    if (!cleanIds.length) {
        return res.status(400).json({ success: false, message: 'No valid message IDs.' });
    }
    const ph = cleanIds.map(() => '?').join(',');
    db.run(`UPDATE inquiries SET status = ? WHERE inquiry_id IN (${ph})`, [status, ...cleanIds], function(err) {
        if (err) return res.status(500).json({ success: false, message: err.message });
        const label = status.charAt(0).toUpperCase() + status.slice(1);
        res.json({ success: true, message: `${this.changes} message(s) marked as ${label}` });
    });
});

app.post('/api/admin/inquiries/bulk-delete', requireAdmin, requireRole(['administrator']), (req, res) => {
    const { ids } = req.body;
    if (!Array.isArray(ids) || !ids.length) {
        return res.status(400).json({ success: false, message: 'No messages specified.' });
    }
    const cleanIds = ids.map(x => parseInt(x)).filter(x => !isNaN(x));
    if (!cleanIds.length) {
        return res.status(400).json({ success: false, message: 'No valid message IDs.' });
    }
    const ph = cleanIds.map(() => '?').join(',');
    db.run(`DELETE FROM inquiries WHERE inquiry_id IN (${ph})`, cleanIds, function(err) {
        if (err) return res.status(500).json({ success: false, message: err.message });
        res.json({ success: true, message: `${this.changes} message(s) deleted` });
    });
});

app.delete('/api/admin/inquiries/:id', requireAdmin, requireRole(['administrator']), (req, res) => {
    db.run("DELETE FROM inquiries WHERE inquiry_id = ?", req.params.id, function(err) {
        if (err) return res.status(500).json({ success: false, message: err.message });
        res.json({ success: true });
    });
});

// Note: the legacy POST /:id/reply endpoint was removed — no longer called by any client code,
// superseded by the direct_emails composer (POST/PUT /api/admin/direct-emails, POST /:id/send).

// --- Admin Compose (freeform outbound email) ---
app.post('/api/admin/compose', requireAdmin, async (req, res) => {
    const { to, subject, body } = req.body;
    if (!to || !body) return res.status(400).json({ error: 'Recipient and message body are required.' });

    // Bug fixed in passing: htmlTemplate was built here but never used — the send below passed the
    // raw body, so composed messages went out with NO wrapper/logo/shell at all.
    const { socialLinks } = await getEmailFooterContext();
    const composeBanner = await bannerRegistry.resolveBanner('direct_compose');
    const htmlTemplate = emailComponents.renderPremiumEmail({
        preheaderText: subject || 'A message from Thabiso Mhlongo Management.',
        bannerSrc: composeBanner?.src, bannerAlt: composeBanner?.alt, subtitle: composeBanner?.subtitle,
        headline: composeBanner?.headline || 'Direct Message',
        bodyHtml: body.replace(/\n/g, '<br>'),
        socialLinks
    });

    try {
        await sendEmail({
            to: to,
            subject: subject || 'Message from Thabiso Mhlongo Management',
            htmlContent: htmlTemplate,
            preWrapped: true,
            replyTo: process.env.EMAIL_USER || 'admin@thabisomhlongo.com',
            titleOverride: 'Direct Message',
            trigger_event: 'Admin: Direct Compose'
        });
        res.json({ success: true, message: 'Message sent successfully.' });
    } catch (error) {
        console.error("Error sending composed email:", error);
        res.status(500).json({ error: error.message });
    }
});



// =========================================================================
// --- Direct Emails Upgrade: Scheduled sends and drafts ---
// =========================================================================

function scheduleDirectEmailSend(emailItem) {
    const rawDt = emailItem.scheduled_at;
    if (!rawDt) return;
    const fireDate = new Date(rawDt.includes('T') ? rawDt : rawDt.replace(' ', 'T') + 'Z');
    if (isNaN(fireDate.getTime())) return;
    
    if (fireDate <= new Date()) {
        // past date, send immediately
        sendDirectEmail(emailItem.id);
        return;
    }

    const jobKey = `direct_${emailItem.id}`;
    if (scheduledJobs[jobKey]) {
        scheduledJobs[jobKey].cancel();
    }

    scheduledJobs[jobKey] = schedule.scheduleJob(fireDate, function() {
        sendDirectEmail(emailItem.id);
    });
}

async function sendDirectEmail(id) {
    return new Promise((resolve, reject) => {
        db.get("SELECT * FROM direct_emails WHERE id = ?", [id], async (err, emailItem) => {
            if (err) return reject(err);
            if (!emailItem) return reject(new Error('Email item not found'));
            if (emailItem.status === 'sent') return resolve();

            let toList = [];
            try { toList = JSON.parse(emailItem.to_emails || '[]'); } catch(e) { toList = [emailItem.to_emails]; }
            let ccList = [];
            try { ccList = JSON.parse(emailItem.cc_emails || '[]'); } catch(e) { ccList = []; }
            let bccList = [];
            try { bccList = JSON.parse(emailItem.bcc_emails || '[]'); } catch(e) { bccList = []; }

            const to = toList.join(', ');
            const cc = ccList.length ? ccList.join(', ') : null;
            const bcc = bccList.length ? bccList.join(', ') : null;

            let attachments = [];
            if (emailItem.attachment_paths) {
                try {
                    const paths = JSON.parse(emailItem.attachment_paths);
                    paths.forEach(p => {
                        if (p && p.path) {
                            const resolvedPath = path.isAbsolute(p.path) ? p.path : path.join(__dirname, p.path);
                            attachments.push({ filename: p.filename || path.basename(p.path), path: resolvedPath });
                        }
                    });
                } catch (e) {
                    console.error('Failed to parse attachments for direct email:', e);
                }
            }

            try {
                // Route through the same registry-resolved rendering every other PREMIUM email uses —
                // branding_option/selected_banner_url are no longer read (see direct-emails/preview
                // below): they pointed at the legacy branded-logic branch in sendEmailDirectly(), which
                // never runs (EMAIL_OVERHAUL_ENABLED is unset in every deployment), so this email was
                // going out completely raw — no wrapper, no banner, no footer, no unsubscribe.
                const templateKey = emailItem.inquiry_id ? 'inquiry_reply' : 'direct_compose';
                const banner = await bannerRegistry.resolveBanner(templateKey);
                const { socialLinks } = await getEmailFooterContext();
                const html = emailComponents.renderPremiumEmail({
                    preheaderText: emailItem.subject || 'A message from Thabiso Mhlongo Management.',
                    bannerSrc: banner?.src, bannerAlt: banner?.alt, subtitle: banner?.subtitle,
                    headline: banner?.headline || (emailItem.inquiry_id ? 'Management Response' : 'Direct Message'),
                    bodyHtml: emailItem.body, // already real HTML from Quill's root.innerHTML — embed verbatim
                    socialLinks
                });

                const result = await sendEmail({
                    to,
                    subject: emailItem.subject || 'Message from Thabiso Mhlongo Management',
                    htmlContent: html,
                    preWrapped: true,
                    replyTo: emailItem.reply_to || process.env.EMAIL_USER || 'admin@thabisomhlongo.com',
                    cc,
                    bcc,
                    attachments,
                    trigger_event: emailItem.inquiry_id ? 'Admin: Inquiry Reply' : 'Admin: Direct Compose',
                    related_entity: emailItem.inquiry_id ? 'inquiries' : null,
                    related_id: emailItem.inquiry_id || null
                });

                if (result.success) {
                    db.run("UPDATE direct_emails SET status = 'sent', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [id], (updErr) => {
                        if (emailItem.inquiry_id) {
                            db.run("UPDATE inquiries SET status = 'replied' WHERE inquiry_id = ?", [emailItem.inquiry_id]);
                        }
                        resolve();
                    });
                } else {
                    db.run("UPDATE direct_emails SET status = 'failed', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [id], () => resolve());
                }
            } catch (error) {
                console.error(`Failed to send direct email #${id}:`, error);
                db.run("UPDATE direct_emails SET status = 'failed', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [id], () => reject(error));
            }

            const jobKey = `direct_${id}`;
            if (scheduledJobs[jobKey]) {
                delete scheduledJobs[jobKey];
            }
        });
    });
}

function loadPendingDirectEmails() {
    db.all(
        "SELECT * FROM direct_emails WHERE status = 'scheduled'",
        (err, rows) => {
            if (err) return console.error('Failed to load scheduled direct emails:', err);
            rows.forEach(row => {
                const rawDt = row.scheduled_at;
                const fireDate = new Date(rawDt.includes('T') ? rawDt : rawDt.replace(' ', 'T') + 'Z');
                if (isNaN(fireDate.getTime()) || fireDate <= new Date()) {
                    sendDirectEmail(row.id).catch(e => console.error('Error sending immediate/expired direct email:', e.message));
                } else {
                    scheduleDirectEmailSend(row);
                }
            });
        }
    );
}

// Banners listing
app.get('/api/admin/branding/banners', requireAdmin, (req, res) => {
    const bannerDir = path.join(__dirname, 'images', 'banner');
    if (!fs.existsSync(bannerDir)) {
        return res.json({ success: true, banners: [] });
    }
    fs.readdir(bannerDir, (err, files) => {
        if (err) return res.status(500).json({ error: err.message });
        const banners = files
            .filter(file => /\.(png|jpe?g|gif|svg|webp)$/i.test(file))
            .map(file => `/images/banner/${file}`);
        res.json({ success: true, banners });
    });
});

// ══════════════════════════════════════════════════════════════════════════
// EMAIL BANNER REGISTRY (Prompt 5) — CRUD + template assignment.
// Independent of the legacy /images/banner scan above and of direct_emails'
// own selected_banner_url. See js/bannerRegistry.js for the send-time resolver.
// ══════════════════════════════════════════════════════════════════════════

const BANNER_DIR = path.join(__dirname, 'images', 'banners');
const bannerUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 500 * 1024 } // hard ceiling; the real ≤100KB check below gives a clear message
}).single('image');

const BANNER_MIN_WIDTH = 1200;
const BANNER_MAX_WIDTH = 1400;
const BANNER_MAX_BYTES = 100 * 1024;

// Validates an in-memory upload against the pack's spec: JPG/PNG only, ≤100KB, width 1200-1400px.
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

// Writes a validated buffer to images/banners/ and returns its web-servable /images/... path.
function saveBannerImage(file) {
    if (!fs.existsSync(BANNER_DIR)) fs.mkdirSync(BANNER_DIR, { recursive: true });
    const ext = path.extname(file.originalname).toLowerCase();
    const filename = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`;
    fs.writeFileSync(path.join(BANNER_DIR, filename), file.buffer);
    return `/images/banners/${filename}`;
}

const BANNER_CATEGORIES = [
    'Booking Requests', 'Quotes & Proposals', 'Contracts & Signatures', 'Payments & Invoices',
    'Booking Confirmations', 'Event Reminders', 'Thank You & Reviews', 'Booking Recovery',
    'Contact & Support', 'Newsletters & Marketing', 'User Accounts & Security'
];

// ── List (paginated, with usage counts) ──
app.get('/api/admin/banners', requireAdmin, requireRole(['administrator', 'manager']), (req, res) => {
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
app.get('/api/admin/banners/:id', requireAdmin, requireRole(['administrator', 'manager']), (req, res) => {
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
app.post('/api/admin/banners', requireAdmin, requireRole(['administrator', 'manager']), (req, res) => {
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
app.put('/api/admin/banners/:id', requireAdmin, requireRole(['administrator', 'manager']), (req, res) => {
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
app.patch('/api/admin/banners/:id/archive', requireAdmin, requireRole(['administrator', 'manager']), setBannerStatus('archived'));
app.patch('/api/admin/banners/:id/restore', requireAdmin, requireRole(['administrator', 'manager']), setBannerStatus('active'));

// ── Email templates: list (grouped by category client-side) + bulk assign/unassign ──
app.get('/api/admin/email-templates', requireAdmin, requireRole(['administrator', 'manager']), (req, res) => {
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

app.put('/api/admin/email-templates/assign', requireAdmin, requireRole(['administrator', 'manager']), (req, res) => {
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

// System-track template_keys have no banner concept (renderSystemEmail has no banner slot) — the
// Banner Centre's preview picker excludes these client-side; this is defense in depth.
const SYSTEM_TRACK_TEMPLATE_KEYS = ['dashboard_invite', 'password_reset'];

// Live preview: renders a template's category-generic sample body with its REAL currently-assigned
// banner (or the text-headline fallback, matching exactly what a real send would look like).
app.get('/api/admin/email-templates/:key/preview', requireAdmin, requireRole(['administrator', 'manager']), async (req, res) => {
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

// Attachment upload for direct emails
app.post('/api/admin/direct-emails/upload', requireAdmin, emailAttachUpload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded' });
    res.json({
        success: true,
        filename: req.file.filename,
        originalName: req.file.originalname,
        size: req.file.size,
        path: `docs/email_attachments/${req.file.filename}`
    });
});

// List drafts and scheduled direct emails
app.get('/api/admin/direct-emails', requireAdmin, (req, res) => {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = 50;
    const offset = (page - 1) * limit;
    const statusFilter = req.query.status === 'scheduled' ? 'scheduled' : 'draft';
    const search = (req.query.search || '').trim();

    const conditions = ["status = ?"];
    const qp = [statusFilter];
    
    if (search) {
        conditions.push("(LOWER(to_emails) LIKE LOWER(?) OR LOWER(subject) LIKE LOWER(?) OR LOWER(body) LIKE LOWER(?))");
        const term = `%${search}%`;
        qp.push(term, term, term);
    }
    
    const whereClause = `WHERE ${conditions.join(' AND ')}`;
    const countSql = `SELECT COUNT(*) AS total FROM direct_emails ${whereClause}`;
    const dataSql  = `SELECT * FROM direct_emails ${whereClause} ORDER BY updated_at DESC LIMIT ? OFFSET ?`;

    db.get(countSql, qp, (err, countRow) => {
        if (err) return res.status(500).json({ error: err.message });
        db.all(dataSql, [...qp, limit, offset], (err2, rows) => {
            if (err2) return res.status(500).json({ error: err2.message });
            const total = countRow ? countRow.total : 0;
            res.json({
                success: true,
                emails: rows || [],
                total,
                page,
                pages: Math.ceil(total / limit)
            });
        });
    });
});

// Get detail of single direct email
app.get('/api/admin/direct-emails/:id', requireAdmin, (req, res) => {
    db.get("SELECT * FROM direct_emails WHERE id = ?", [req.params.id], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: 'Email item not found' });
        res.json({ success: true, email: row });
    });
});

// Create draft or scheduled direct email
app.post('/api/admin/direct-emails', requireAdmin, requireRoleForInquiryEmail, (req, res) => {
    const { inquiry_id, to_emails, cc_emails, bcc_emails, reply_to, subject, body, branding_option, selected_banner_url, attachment_paths, scheduled_at, status } = req.body;
    
    if (!to_emails || !body) {
        return res.status(400).json({ error: 'Recipient and body are required.' });
    }

    const emailStatus = status === 'scheduled' ? 'scheduled' : 'draft';
    const cleanTo = Array.isArray(to_emails) ? JSON.stringify(to_emails) : JSON.stringify([to_emails]);
    const cleanCc = cc_emails ? (Array.isArray(cc_emails) ? JSON.stringify(cc_emails) : JSON.stringify([cc_emails])) : '[]';
    const cleanBcc = bcc_emails ? (Array.isArray(bcc_emails) ? JSON.stringify(bcc_emails) : JSON.stringify([bcc_emails])) : '[]';
    const cleanAttachments = attachment_paths ? (typeof attachment_paths === 'string' ? attachment_paths : JSON.stringify(attachment_paths)) : '[]';

    db.run(
        `INSERT INTO direct_emails (inquiry_id, to_emails, cc_emails, bcc_emails, reply_to, subject, body, branding_option, selected_banner_url, attachment_paths, scheduled_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [inquiry_id || null, cleanTo, cleanCc, cleanBcc, reply_to || null, subject || '', body, branding_option || 'logo', selected_banner_url || null, cleanAttachments, scheduled_at || null, emailStatus],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            const newId = this.lastID;
            
            db.get("SELECT * FROM direct_emails WHERE id = ?", [newId], (err2, row) => {
                if (err2 || !row) return res.json({ success: true, id: newId });
                if (row.status === 'scheduled') {
                    scheduleDirectEmailSend(row);
                }
                res.json({ success: true, email: row });
            });
        }
    );
});

// Update draft or scheduled direct email
app.put('/api/admin/direct-emails/:id', requireAdmin, requireRoleForInquiryEmail, (req, res) => {
    const { to_emails, cc_emails, bcc_emails, reply_to, subject, body, branding_option, selected_banner_url, attachment_paths, scheduled_at, status } = req.body;
    const { id } = req.params;

    if (!to_emails || !body) {
        return res.status(400).json({ error: 'Recipient and body are required.' });
    }

    const emailStatus = status === 'scheduled' ? 'scheduled' : 'draft';
    const cleanTo = Array.isArray(to_emails) ? JSON.stringify(to_emails) : JSON.stringify([to_emails]);
    const cleanCc = cc_emails ? (Array.isArray(cc_emails) ? JSON.stringify(cc_emails) : JSON.stringify([cc_emails])) : '[]';
    const cleanBcc = bcc_emails ? (Array.isArray(bcc_emails) ? JSON.stringify(bcc_emails) : JSON.stringify([bcc_emails])) : '[]';
    const cleanAttachments = attachment_paths ? (typeof attachment_paths === 'string' ? attachment_paths : JSON.stringify(attachment_paths)) : '[]';

    // Cancel existing schedule if there is one
    const jobKey = `direct_${id}`;
    if (scheduledJobs[jobKey]) {
        scheduledJobs[jobKey].cancel();
        delete scheduledJobs[jobKey];
    }

    db.run(
        `UPDATE direct_emails 
         SET to_emails = ?, cc_emails = ?, bcc_emails = ?, reply_to = ?, subject = ?, body = ?, branding_option = ?, selected_banner_url = ?, attachment_paths = ?, scheduled_at = ?, status = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [cleanTo, cleanCc, cleanBcc, reply_to || null, subject || '', body, branding_option || 'logo', selected_banner_url || null, cleanAttachments, scheduled_at || null, emailStatus, id],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            
            db.get("SELECT * FROM direct_emails WHERE id = ?", [id], (err2, row) => {
                if (err2 || !row) return res.json({ success: true });
                if (row.status === 'scheduled') {
                    scheduleDirectEmailSend(row);
                }
                res.json({ success: true, email: row });
            });
        }
    );
});

// Delete draft or cancel scheduled email
app.delete('/api/admin/direct-emails/:id', requireAdmin, (req, res) => {
    const { id } = req.params;
    const jobKey = `direct_${id}`;
    if (scheduledJobs[jobKey]) {
        scheduledJobs[jobKey].cancel();
        delete scheduledJobs[jobKey];
    }

    db.get("SELECT attachment_paths FROM direct_emails WHERE id = ?", [id], (err, row) => {
        if (!err && row && row.attachment_paths) {
            try {
                const paths = JSON.parse(row.attachment_paths);
                paths.forEach(p => {
                    if (p && p.path && fs.existsSync(p.path)) {
                        fs.unlink(p.path, () => {});
                    }
                });
            } catch(e) {}
        }
        db.run("DELETE FROM direct_emails WHERE id = ?", [id], function(err2) {
            if (err2) return res.status(500).json({ error: err2.message });
            res.json({ success: true });
        });
    });
});

// Send direct email immediately
app.post('/api/admin/direct-emails/:id/send', requireAdmin, requireRoleForInquiryEmail, (req, res) => {
    const { id } = req.params;
    
    // Cancel schedule job if it exists
    const jobKey = `direct_${id}`;
    if (scheduledJobs[jobKey]) {
        scheduledJobs[jobKey].cancel();
        delete scheduledJobs[jobKey];
    }

    sendDirectEmail(id)
        .then(() => res.json({ success: true, message: 'Message sending initiated.' }))
        .catch(e => res.status(500).json({ error: e.message }));
});

// Preview direct email html
// Mirrors sendDirectEmail()'s rendering exactly (registry-resolved banner via renderPremiumEmail) so
// the preview shown here is byte-identical in shape to what actually sends — previously this called
// createEmailWrapper() unconditionally while the real send (gated by the always-off
// EMAIL_OVERHAUL_ENABLED flag) shipped raw HTML, so preview and reality had permanently diverged.
app.post('/api/admin/direct-emails/preview', requireAdmin, async (req, res) => {
    const { body, subject, inquiry_id } = req.body;
    const templateKey = inquiry_id ? 'inquiry_reply' : 'direct_compose';
    const banner = await bannerRegistry.resolveBanner(templateKey);
    const { socialLinks } = await getEmailFooterContext();

    const html = emailComponents.renderPremiumEmail({
        preheaderText: subject || 'A message from Thabiso Mhlongo Management.',
        bannerSrc: banner?.src, bannerAlt: banner?.alt, subtitle: banner?.subtitle,
        headline: banner?.headline || (inquiry_id ? 'Management Response' : 'Direct Message'),
        bodyHtml: body,
        socialLinks
    });
    res.json({ success: true, html });
});



// --- Manager Details ---
app.get('/api/public/manager', (req, res) => {
    db.get("SELECT * FROM manager_details ORDER BY manager_id ASC LIMIT 1", [], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(row || null);
    });
});

app.put('/api/admin/manager', requireAdmin, (req, res) => {
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
                [name, cell_number, whatsapp_number, email, cleanLink, adminId, row.manager_id], function(err) {
                if (err) return res.status(500).json({ error: err.message });
                res.json({ success: true, message: 'Manager details updated successfully.' });
            });
        } else {
            db.run(`INSERT INTO manager_details (name, cell_number, whatsapp_number, email, whatsapp_link, created_by) 
                    VALUES (?, ?, ?, ?, ?, ?)`, 
                [name, cell_number, whatsapp_number, email, cleanLink, adminId], function(err) {
                if (err) return res.status(500).json({ error: err.message });
                res.json({ success: true, message: 'Manager details created successfully.' });
            });
        }
    });
});

app.delete('/api/admin/manager', requireAdmin, requireRole(['administrator']), (req, res) => {
    db.run("DELETE FROM manager_details", [], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, message: 'Manager details cleared successfully.' });
    });
});

// --- Contact Info ---
app.get('/api/public/contact_info', (req, res) => {
    db.get("SELECT * FROM contact_info ORDER BY quote_id ASC LIMIT 1", [], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(row || { email: '', quote: '', signature: '' }); // Safety fallback obj 
    });
});

app.post('/api/admin/contact_info', requireAdmin, (req, res) => {
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
                [email, quote, signature, adminId, row.quote_id], function(err) {
                if (err) {
                     console.error("[DEBUG] UPDATE Error:", err);
                     return res.status(500).json({ error: err.message });
                }
                res.json({ success: true, message: 'Contact info updated successfully.' });
            });
        } else {
            db.run(`INSERT INTO contact_info (email, quote, signature, created_by) 
                    VALUES (?, ?, ?, ?)`, 
                [email, quote, signature, adminId], function(err) {
                if (err) return res.status(500).json({ error: err.message });
                res.json({ success: true, message: 'Contact info created successfully.' });
            });
        }
    });
});


// --- Social Links ---
app.get('/api/public/social_links', (req, res) => {
    db.all("SELECT * FROM social_links WHERE is_active = 1 ORDER BY display_order ASC", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.get('/api/admin/social_links', requireAdmin, (req, res) => {
    db.all("SELECT * FROM social_links ORDER BY display_order ASC", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.post('/api/admin/social_links', requireAdmin, (req, res) => {
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

app.delete('/api/admin/social_links/:id', requireAdmin, requireRole(['administrator']), (req, res) => {
    db.run("DELETE FROM social_links WHERE id = ?", [req.params.id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, message: 'Social link deleted successfully.' });
    });
});

// --- Social Embeds ---
// =============================================
// About Me API
// =============================================

const ALLOWED_ABOUT_TAGS = /<(script|style|iframe|object|embed|form|input|button)\b[^>]*>[\s\S]*?<\/\1>|<(script|style|iframe|object|embed|form|input|button)\b[^>]*\/?>/gi;
const STRIP_ON_ATTRS = /\s+on\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*)/gi;
const STRIP_JS_HREF = /href\s*=\s*(?:"javascript:[^"]*"|'javascript:[^']*')/gi;

function unescapeHtml(str) {
    if (!str || typeof str !== 'string') return '';
    return str
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#x27;/g, "'");
}

function sanitizeAboutHtml(html) {
    if (!html || typeof html !== 'string') return '';
    return html
        .replace(ALLOWED_ABOUT_TAGS, '')
        .replace(STRIP_ON_ATTRS, '')
        .replace(STRIP_JS_HREF, 'href="#"');
}

app.get('/api/public/about-me', (req, res) => {
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

app.get('/api/admin/about-me', requireAdmin, (req, res) => {
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

app.post('/api/admin/about-me', requireAdmin, (req, res) => {
    const { image_path, paragraph1, paragraph2, paragraph3 } = req.body;
    const username = req.session.username || String(req.session.adminId || 'admin');
    const p1 = sanitizeAboutHtml(paragraph1);
    const p2 = sanitizeAboutHtml(paragraph2);
    const p3 = sanitizeAboutHtml(paragraph3);
    const imgPath = image_path || '';

    db.get("SELECT id FROM about_me WHERE id = 1", (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (row) {
            db.run(
                `UPDATE about_me SET image_path=?, paragraph1=?, paragraph2=?, paragraph3=?, updated_at=CURRENT_TIMESTAMP, updated_by=? WHERE id=1`,
                [imgPath, p1, p2, p3, username],
                (e) => {
                    if (e) return res.status(500).json({ error: e.message });
                    res.json({ success: true, message: 'About Me content updated.' });
                }
            );
        } else {
            db.run(
                `INSERT INTO about_me (id, image_path, paragraph1, paragraph2, paragraph3, created_by, updated_by) VALUES (1,?,?,?,?,?,?)`,
                [imgPath, p1, p2, p3, username, username],
                (e) => {
                    if (e) return res.status(500).json({ error: e.message });
                    res.json({ success: true, message: 'About Me content saved.' });
                }
            );
        }
    });
});

app.get('/api/public/social_embeds', (req, res) => {
    db.all("SELECT * FROM social_embeds WHERE is_active = 1 ORDER BY display_order ASC", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// ─── Editable homepage content: Hero paragraph + "What I Do" section ──────────
// Stored as key-value rows in `settings`. hero_subtitle + services_heading may contain simple
// admin-authored HTML (e.g. <em>) and are sanitised; eyebrow + card fields are plain text
// (rendered client-side via .text()). Values fall back to the static index.html when unset.
const SITE_CONTENT_KEYS = ['announcement_text', 'announcement_enabled', 'announcement_rotate', 'hero_tagline', 'hero_subtitle', 'services_eyebrow', 'services_heading', 'services_items', 'features_items', 'section_visibility'];
// Public homepage sections whose visibility admins can toggle (stored as a JSON map in the
// `section_visibility` setting). A key absent/true = visible; only an explicit false hides it.
// `announcement` is intentionally NOT here — its visibility shares the `announcement_enabled` key.
const SECTION_KEYS = ['hero', 'features', 'services', 'about', 'career', 'gallery', 'events', 'social', 'newsletter', 'contact', 'footer'];

app.get('/api/public/site-content', (req, res) => {
    const ph = SITE_CONTENT_KEYS.map(() => '?').join(',');
    db.all(`SELECT setting_key, setting_value FROM settings WHERE setting_key IN (${ph})`, SITE_CONTENT_KEYS, (err, rows) => {
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

app.put('/api/admin/site-content', requireAdmin, (req, res) => {
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
        db.run("INSERT OR REPLACE INTO settings (setting_key, setting_value, updated_at) VALUES (?,?,CURRENT_TIMESTAMP)",
            [key, updates[key]], (err) => {
                if (err && !failed) { failed = true; console.error('save site-content failed:', err); return res.status(500).json({ success: false, message: 'Could not save homepage content. Please try again.' }); }
                if (--pending === 0 && !failed) res.json({ success: true, message: 'Homepage content updated.' });
            });
    });
});

app.get('/api/admin/social_embeds', requireAdmin, (req, res) => {
    db.all("SELECT * FROM social_embeds ORDER BY display_order ASC", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.post('/api/admin/social_embeds', requireAdmin, (req, res) => {
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

app.delete('/api/admin/social_embeds/:id', requireAdmin, requireRole(['administrator']), (req, res) => {
    db.run("DELETE FROM social_embeds WHERE id = ?", [req.params.id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, message: 'Social embed deleted successfully.' });
    });
});

// =============================================
// Helper to retrieve setting value dynamically from the database
const getSettingVal = (key) => {
    return new Promise(resolve => {
        db.get("SELECT setting_value FROM settings WHERE setting_key = ?", [key], (err, row) => {
            resolve(row ? row.setting_value : null);
        });
    });
};

app.get('/api/admin/dashboard/social_kpis', requireAdmin, (req, res) => {
    db.all("SELECT * FROM social_kpi_stats ORDER BY id ASC", [], async (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        
        let needsDbUpdate = false;
        const now = new Date();
        const updatedRows = [];

        for (const row of rows) {
            // Cache timeout is 1 hour
            const lastUpdated = new Date(row.last_updated);
            const isStale = (now - lastUpdated) > 60 * 60 * 1000;
            
            if (row.manual_override === 0 && isStale) {
                let liveFollowers = null;
                let liveLikes = null;
                
                try {
                    if (row.platform_name === 'YouTube') {
                        const ytApiKey = await getSettingVal('youtube_api_key') || process.env.YOUTUBE_API_KEY;
                        const ytChannelId = await getSettingVal('youtube_channel_id') || process.env.YOUTUBE_CHANNEL_ID;
                        if (ytApiKey && ytChannelId) {
                            const ytUrl = `https://www.googleapis.com/youtube/v3/channels?part=statistics&id=${ytChannelId}&key=${ytApiKey}`;
                            const apiRes = await fetch(ytUrl);
                            if (apiRes.ok) {
                                const data = await apiRes.json();
                                if (data.items && data.items.length > 0) {
                                    liveFollowers = parseInt(data.items[0].statistics.subscriberCount) || null;
                                    liveLikes = parseInt(data.items[0].statistics.viewCount) || null;
                                }
                            }
                        }
                    } else if (row.platform_name === 'Facebook') {
                        const fbAccessToken = await getSettingVal('facebook_page_access_token') || process.env.FACEBOOK_PAGE_ACCESS_TOKEN;
                        const fbPageId = await getSettingVal('facebook_page_id') || process.env.FACEBOOK_PAGE_ID;
                        if (fbAccessToken && fbPageId) {
                            const fbUrl = `https://graph.facebook.com/v19.0/${fbPageId}?fields=fan_count,talking_about_count&access_token=${fbAccessToken}`;
                            const apiRes = await fetch(fbUrl);
                            if (apiRes.ok) {
                                const data = await apiRes.json();
                                liveFollowers = data.fan_count || null;
                                liveLikes = data.fan_count || null;
                            }
                        }
                    } else if (row.platform_name === 'Instagram') {
                        const igAccessToken = await getSettingVal('instagram_access_token') || process.env.INSTAGRAM_ACCESS_TOKEN;
                        const igUserId = await getSettingVal('instagram_user_id') || process.env.INSTAGRAM_USER_ID;
                        if (igAccessToken && igUserId) {
                            const igUrl = `https://graph.facebook.com/v19.0/${igUserId}?fields=followers_count,media_count&access_token=${igAccessToken}`;
                            const apiRes = await fetch(igUrl);
                            if (apiRes.ok) {
                                const data = await apiRes.json();
                                liveFollowers = data.followers_count || null;
                                liveLikes = data.media_count || null;
                            }
                        }
                    } else if (row.platform_name === 'X (Twitter)') {
                        const twBearerToken = await getSettingVal('twitter_bearer_token') || process.env.TWITTER_BEARER_TOKEN;
                        const twUsername = await getSettingVal('twitter_username') || process.env.TWITTER_USERNAME;
                        if (twBearerToken && twUsername) {
                            const twUrl = `https://api.twitter.com/2/users/by/username/${twUsername}?user.fields=public_metrics`;
                            const apiRes = await fetch(twUrl, {
                                headers: {
                                    'Authorization': `Bearer ${twBearerToken}`
                                }
                            });
                            if (apiRes.ok) {
                                const data = await apiRes.json();
                                if (data.data && data.data.public_metrics) {
                                    liveFollowers = data.data.public_metrics.followers_count || null;
                                    liveLikes = data.data.public_metrics.tweet_count || null;
                                }
                            }
                        }
                    } else if (row.platform_name === 'TikTok') {
                        const ttAccessToken = await getSettingVal('tiktok_access_token') || process.env.TIKTOK_ACCESS_TOKEN;
                        if (ttAccessToken) {
                            const ttUrl = `https://open.tiktokapis.com/v2/user/info/?fields=follower_count,likes_count`;
                            const apiRes = await fetch(ttUrl, {
                                headers: {
                                    'Authorization': `Bearer ${ttAccessToken}`
                                }
                            });
                            if (apiRes.ok) {
                                const data = await apiRes.json();
                                if (data.data && data.data.user) {
                                    liveFollowers = data.data.user.follower_count || null;
                                    liveLikes = data.data.user.likes_count || null;
                                }
                            }
                        }
                    }
                } catch (e) {
                    console.error(`Failed to fetch live stats for ${row.platform_name}:`, e.message);
                }

                if (liveFollowers !== null) {
                    needsDbUpdate = true;
                    row.follower_count = liveFollowers;
                    if (liveLikes !== null) row.like_count = liveLikes;
                    row.last_updated = now.toISOString();
                    
                    // Run update to DB
                    db.run(
                        "UPDATE social_kpi_stats SET follower_count = ?, like_count = ?, last_updated = CURRENT_TIMESTAMP WHERE id = ?",
                        [row.follower_count, row.like_count, row.id]
                    );
                }
            }
            updatedRows.push(row);
        }

        const credentials = {
            youtube_api_key: await getSettingVal('youtube_api_key') || '',
            youtube_channel_id: await getSettingVal('youtube_channel_id') || '',
            facebook_page_access_token: await getSettingVal('facebook_page_access_token') || '',
            facebook_page_id: await getSettingVal('facebook_page_id') || '',
            instagram_access_token: await getSettingVal('instagram_access_token') || '',
            instagram_user_id: await getSettingVal('instagram_user_id') || '',
            twitter_bearer_token: await getSettingVal('twitter_bearer_token') || '',
            twitter_username: await getSettingVal('twitter_username') || '',
            tiktok_access_token: await getSettingVal('tiktok_access_token') || ''
        };

        res.json({ success: true, kpis: updatedRows, credentials: credentials });
    });
});

app.post('/api/admin/dashboard/social_kpis', requireAdmin, requireRole(['administrator', 'manager']), (req, res) => {
    const { platform_name, follower_count, like_count, trend_percentage, trend_direction, manual_override, goal_target } = req.body;

    if (!platform_name) {
        return res.status(400).json({ success: false, message: 'Platform name is required.' });
    }

    db.get("SELECT * FROM social_kpi_stats WHERE platform_name = ?", [platform_name], (err, row) => {
        if (err || !row) return res.status(404).json({ success: false, message: 'Platform stats not found.' });

        const updatedFollowers = follower_count !== undefined ? parseInt(follower_count) : row.follower_count;
        const updatedLikes = like_count !== undefined ? parseInt(like_count) : row.like_count;
        const updatedTrendPct = trend_percentage !== undefined ? parseFloat(trend_percentage) : row.trend_percentage;
        const updatedTrendDir = trend_direction !== undefined ? trend_direction : row.trend_direction;
        const updatedOverride = manual_override !== undefined ? (manual_override ? 1 : 0) : row.manual_override;
        const updatedGoal = goal_target !== undefined ? (parseInt(goal_target) || 0) : row.goal_target;

        db.run(
            `UPDATE social_kpi_stats
             SET follower_count = ?,
                 like_count = ?,
                 trend_percentage = ?,
                 trend_direction = ?,
                 manual_override = ?,
                 goal_target = ?,
                 last_updated = CURRENT_TIMESTAMP
             WHERE platform_name = ?`,
            [updatedFollowers, updatedLikes, updatedTrendPct, updatedTrendDir, updatedOverride, updatedGoal, platform_name],
            function(updateErr) {
                if (updateErr) return res.status(500).json({ success: false, error: updateErr.message });
                res.json({ success: true, message: `Social media stats updated for ${platform_name}.` });
            }
        );
    });
});

// --- GDPR / POPIA Data Deletion (Anonymization) ---
app.post('/api/admin/gdpr/delete', requireAdmin, requireRole(['administrator']), async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, message: 'Email address is required for deletion.' });

    const adminId = req.session.adminId;
    const ip = req.ip;

    console.log(`[GDPR] Deletion request for ${email} initiated by Admin ID: ${adminId}`);

    // Each step is awaited. The previous version wrapped callback-style db.run() calls in a
    // try/catch, which cannot observe an async sqlite error — every statement error was dropped
    // and the route reported success even when nothing was anonymized. `if (err) throw err` inside
    // the COMMIT callback likewise threw past every handler.
    const outcome = await withDbTransaction(async () => {
        try {
            await dbRun("BEGIN IMMEDIATE");
        } catch (beginErr) {
            console.error("[GDPR] BEGIN IMMEDIATE failed:", beginErr.message);
            return { status: 500, body: { success: false, message: "Database busy. Please retry." } };
        }
        try {
            // 1. Anonymize Client Record
            const clients = await dbRun(`UPDATE clients SET
                    full_name = 'POPIA ANONYMIZED',
                    company_name = NULL,
                    phone = '0000000000',
                    billing_address = NULL,
                    tax_id = NULL,
                    vat_number = NULL,
                    email = 'deleted-' || id || '@po-pia.com',
                    updated_at = CURRENT_TIMESTAMP
                    WHERE LOWER(email) = LOWER(?)`, [email]);

            // 2. Anonymize Bookings
            const bookings = await dbRun(`UPDATE bookings SET
                    name = 'POPIA ANONYMIZED',
                    company = NULL,
                    email = 'deleted@po-pia.com',
                    cell = '0000000000',
                    message = 'Content removed per deletion request.',
                    status = 'CANCELLED'
                    WHERE LOWER(email) = LOWER(?)`, [email]);

            // 3. Anonymize Inquiries
            const inquiries = await dbRun(`UPDATE inquiries SET
                    sender_name = 'POPIA ANONYMIZED',
                    sender_email = 'deleted@po-pia.com',
                    sender_phone = '0000000000',
                    message_body = 'Content removed per deletion request.'
                    WHERE LOWER(sender_email) = LOWER(?)`, [email]);

            // 4. Delete Newsletter Subscription
            const newsletter = await dbRun(`DELETE FROM newsletter_subscribers WHERE LOWER(email) = LOWER(?)`, [email]);

            // 5. Anonymize Communication Logs
            const comms = await dbRun(`UPDATE communication_log SET
                    subject = '[DELETED]',
                    content_snippet = '[DELETED]',
                    user_email = 'deleted@po-pia.com'
                    WHERE LOWER(user_email) = LOWER(?)`, [email]);

            // 6. Audit the deletion request itself
            await dbRun(`INSERT INTO audit_log (table_name, record_id, action, user_email, ip_address, reason)
                    VALUES ('system', 0, 'DATA_ANONYMIZATION', ?, ?, ?)`,
                    [req.session.username, ip, `Deleted all data for ${email}`]);

            await dbRun("COMMIT");
            return {
                ok: true,
                affected: {
                    clients: clients.changes, bookings: bookings.changes, inquiries: inquiries.changes,
                    newsletter_subscribers: newsletter.changes, communication_log: comms.changes
                }
            };
        } catch (txErr) {
            await dbRun("ROLLBACK").catch(() => {});
            console.error("[GDPR] Deletion failed — rolled back, no data anonymized:", txErr.message);
            return { status: 500, body: { success: false, message: "Anonymization failed. Transaction rolled back." } };
        }
    });

    if (!outcome.ok) return res.status(outcome.status).json(outcome.body);

    console.log(`[GDPR] Anonymized for ${email}:`, outcome.affected);
    res.json({
        success: true,
        message: `All data associated with ${email} has been anonymized/deleted successfully.`,
        affected: outcome.affected
    });
});

// --- Migration & System ---
/**
 * Admin-Only: Data Migration Tool (Legacy Bookings -> New Relational Schema)
 * This tool scans existing flat 'bookings' records and creates unique 'clients' and 'venues' 
 * entries, then updates the booking record with foreign key references.
 */
app.post('/api/admin/system/migrate-legacy-data', requireAdmin, requireRole(['administrator']), async (req, res) => {
    db.all("SELECT * FROM bookings", [], async (err, bookings) => {
        if (err) return res.status(500).json({ success: false, error: err.message });
        
        let stats = { processed: 0, clientsCreated: 0, venuesCreated: 0, updated: 0 };
        
        for (const booking of bookings) {
            stats.processed++;
            
            // 1. Resolve Client
            let clientId = await new Promise((resolve) => {
                db.get("SELECT id FROM clients WHERE LOWER(email) = LOWER(?)", [booking.email], (e, row) => resolve(row ? row.id : null));
            });
            
            if (!clientId) {
                clientId = await new Promise((resolve) => {
                    db.run("INSERT INTO clients (full_name, company_name, email, phone) VALUES (?, ?, ?, ?)",
                        [booking.name, booking.company, booking.email, booking.cell],
                        function() { resolve(this.lastID); }
                    );
                });
                stats.clientsCreated++;
            }
            
            // 2. Resolve Venue
            let venueId = null;
            if (booking.event_location || booking.venue_address) {
                const venueName = booking.event_location || 'Unknown Venue';
                venueId = await new Promise((resolve) => {
                    db.get("SELECT id FROM venues WHERE LOWER(name) = LOWER(?)", [venueName], (e, row) => resolve(row ? row.id : null));
                });
                
                if (!venueId) {
                    venueId = await new Promise((resolve) => {
                        db.run("INSERT INTO venues (name, address, city, country, capacity) VALUES (?, ?, ?, ?, ?)",
                            [venueName, booking.venue_address, booking.city, booking.country, booking.audience_size],
                            function() { resolve(this.lastID); }
                        );
                    });
                    stats.venuesCreated++;
                }
            }
            
            // 3. Update Booking with Foreign Keys
            await new Promise((resolve) => {
                db.run("UPDATE bookings SET client_id = ?, venue_id = ? WHERE id = ?", [clientId, venueId, booking.id], () => resolve());
            });
            stats.updated++;
        }
        
        res.json({ success: true, message: 'Migration completed successfully.', stats });
    });
});

// --- Dynamic Sitemap ---
app.get('/sitemap.xml', sitemapRateLimiter, (req, res) => {
    const baseUrl = 'https://www.thabisomhlongo.com';
    const staticPages = ['', '#about', '#gallery', '#events', '#contact'];
    
    db.all("SELECT id, created_at FROM events ORDER BY date DESC", [], (err, events) => {
        let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
        xml += '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';
        
        staticPages.forEach(p => {
            xml += `  <url>\n    <loc>${baseUrl}/${p}</loc>\n    <changefreq>weekly</changefreq>\n    <priority>0.8</priority>\n  </url>\n`;
        });

        if (!err && events) {
            events.forEach(ev => {
                const lastMod = ev.created_at ? new Date(ev.created_at).toISOString().split('T')[0] : new Date().toISOString().split('T')[0];
                xml += `  <url>\n    <loc>${baseUrl}/#events</loc>\n    <lastmod>${lastMod}</lastmod>\n    <changefreq>monthly</changefreq>\n    <priority>0.5</priority>\n  </url>\n`;
            });
        }
        xml += '</urlset>';
        res.header('Content-Type', 'application/xml');
        res.send(xml);
    });
});

// Dynamic admin backgrounds debug logger
app.post('/api/debug', requireAdmin, (req, res) => {
    // SEC-2: gated behind admin auth — it was an open endpoint that logged arbitrary request bodies.
    console.log('[DEBUG API] Background configuration trace:', req.body);
    return res.status(200).json({ success: true });
});

// --- Custom Error Handling ---
// 404 - Not Found
app.use((req, res) => {
    res.status(404).sendFile(path.join(__dirname, 'error.html'));
});

// 500 - Server Error
app.use((err, req, res, next) => {
    console.error(err.stack);
    if (req.path.startsWith('/api/')) {
        return res.status(500).json({ success: false, message: err.message || 'Internal server error' });
    }
    res.status(500).sendFile(path.join(__dirname, 'error.html'));
});


// Start Data Retention Check
setTimeout(() => {
    db.get("SELECT COUNT(*) AS count FROM admins", (err, row) => {
        if (row && row.count === 0) {
            const generatedPassword = crypto.randomBytes(8).toString('hex'); // 16 chars
            const defaultEmail = 'admin@thabisomhlongo.com';
            bcrypt.hash(generatedPassword, 10, (err, hash) => {
                if (!err) {
                    db.run("INSERT INTO admins (username, email, password_hash, must_change_password) VALUES (?, ?, ?, 1)", ['admin', defaultEmail, hash], (err) => {
                        if (!err) {
                            const dataDir = path.join(__dirname, 'data');
                            if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);
                            const credPath = path.join(dataDir, 'admin_credentials.txt');
                            fs.writeFileSync(credPath, `First-Run Admin Credentials:\nUsername: admin\nPassword: ${generatedPassword}\n\nPlease change this password immediately upon first login.\n`);
                            console.log('NOTICE: Default admin credentials generated and written to /data/admin_credentials.txt');
                        }
                    });
                }
            });
        }
    });
}, 2000);

// ========================================
// PAYMENT REMINDER JOB
// ========================================

async function runPaymentReminderJob() {
    const result = { sent: 0, skipped: 0, errors: 0 };

    const policyRow1 = await new Promise(resolve => db.get("SELECT policy_value FROM policies WHERE policy_key = 'reminder_days_1'", [], (err, row) => resolve(row)));
    const policyRow2 = await new Promise(resolve => db.get("SELECT policy_value FROM policies WHERE policy_key = 'reminder_days_2'", [], (err, row) => resolve(row)));
    const days1 = parseInt((policyRow1 && policyRow1.policy_value) || '7');
    const days2 = parseInt((policyRow2 && policyRow2.policy_value) || '2');

    const windows = [days1, days2].filter((d, i, a) => d > 0 && a.indexOf(d) === i);

    for (const daysBefore of windows) {
        const targetDate = new Date();
        targetDate.setDate(targetDate.getDate() + daysBefore);
        const targetStr = targetDate.toISOString().split('T')[0];

        const dueSched = await new Promise((resolve, reject) => {
            db.all(`
                SELECT ps.id AS schedule_id, ps.booking_id, ps.description, ps.due_date,
                       ps.expected_amount, ps.status,
                       b.name AS client_name, b.email AS client_email, b.event_name
                FROM payment_schedules ps
                JOIN bookings b ON b.id = ps.booking_id
                WHERE ps.due_date = ? AND ps.status = 'pending'
                  AND b.status NOT IN ('CANCELLED')
            `, [targetStr], (err, rows) => {
                if (err) reject(err); else resolve(rows || []);
            });
        });

        for (const sched of dueSched) {
            const alreadySent = await new Promise(resolve => {
                db.get("SELECT id FROM reminders_log WHERE booking_id = ? AND schedule_id = ? AND days_before = ?",
                    [sched.booking_id, sched.schedule_id, daysBefore], (err, row) => resolve(!!row));
            });
            if (alreadySent) { result.skipped++; continue; }

            const paymentUrl = `${process.env.SITE_URL || 'http://localhost:3000'}/?track=${sched.booking_id}&email=${encodeURIComponent(sched.client_email)}`;
            // PAYMENT-CRITICAL: `R ${parseFloat(sched.expected_amount).toFixed(2)}` kept verbatim.
            const { socialLinks: schedSocialLinks } = await getEmailFooterContext();
            const banner = await bannerRegistry.resolveBanner('schedule_payment_reminder');
            const htmlContent = emailComponents.renderPremiumEmail({
                preheaderText: `Payment reminder: ${sched.description} due ${sched.due_date}.`,
                bannerSrc: banner?.src, bannerAlt: banner?.alt, subtitle: banner?.subtitle,
                headline: banner?.headline || 'Payment Reminder',
                greeting: `Hi ${sched.client_name},`,
                bodyHtml: `This is a friendly reminder that a payment is due in <strong style="color:#D4AF37;">${daysBefore} day${daysBefore !== 1 ? 's' : ''}</strong> for your upcoming event booking.`,
                cards: [{
                    title: 'Payment Details',
                    rows: [
                        { label: 'Booking', value: sched.event_name || ('Booking #' + sched.booking_id), mono: false },
                        { label: 'Description', value: sched.description, mono: false },
                        { label: 'Due Date', value: sched.due_date },
                        { label: 'Amount', value: `R ${parseFloat(sched.expected_amount).toFixed(2)}`, highlight: true }
                    ]
                }],
                cta: { label: 'Make Payment Now', url: paymentUrl },
                socialLinks: schedSocialLinks
            });

            try {
                await sendEmail({
                    to: sched.client_email,
                    subject: `Payment Reminder — ${sched.description} due ${sched.due_date}`,
                    htmlContent,
                    preWrapped: true,
                    titleOverride: 'Payment Reminder',
                    trigger_event: 'Payment Reminder'
                });
                db.run("INSERT OR IGNORE INTO reminders_log (booking_id, schedule_id, days_before, due_date, amount_due, recipient_email, status) VALUES (?,?,?,?,?,?,'sent')",
                    [sched.booking_id, sched.schedule_id, daysBefore, sched.due_date, sched.expected_amount, sched.client_email]);
                result.sent++;
            } catch (emailErr) {
                console.error(`[Reminder Job] Failed to send reminder for schedule ${sched.schedule_id}:`, emailErr.message);
                db.run("INSERT OR IGNORE INTO reminders_log (booking_id, schedule_id, days_before, due_date, amount_due, recipient_email, status, error_message) VALUES (?,?,?,?,?,?,'failed',?)",
                    [sched.booking_id, sched.schedule_id, daysBefore, sched.due_date, sched.expected_amount, sched.client_email, emailErr.message]);
                result.errors++;
            }
        }
    }

    console.log(`[Reminder Job] Done — sent: ${result.sent}, skipped: ${result.skipped}, errors: ${result.errors}`);
    return result;
}

// Run reminder job daily at 09:00 local time (simplified: every 24h after first run at startup + 10s)
setTimeout(() => {
    runPaymentReminderJob().catch(err => console.error('[Reminder Job] Startup run failed:', err.message));
    setInterval(() => {
        runPaymentReminderJob().catch(err => console.error('[Reminder Job] Scheduled run failed:', err.message));
    }, 24 * 60 * 60 * 1000);
}, 10000);

// S2-6: Automated quote follow-up — sends a reminder to clients with open (QUOTED) quotes older than N days
async function runQuoteFollowUpJob() {
    const policyRow = await new Promise(resolve =>
        db.get("SELECT policy_value FROM policies WHERE policy_key = 'quote_followup_days'", [], (err, row) => resolve(row))
    );
    const followUpDays = parseInt(policyRow?.policy_value) || 5;

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - followUpDays);
    const cutoffStr = cutoff.toISOString().split('T')[0];
    const baseUrl = process.env.BASE_URL || 'https://www.thabisomhlongo.com';

    const bookings = await new Promise(resolve =>
        db.all(`SELECT id, name, email, event_type, date, quote_amount, quote_expiry_date
                FROM bookings
                WHERE status = 'QUOTED'
                  AND DATE(quoted_at) <= ?
                  AND quote_follow_up_sent_at IS NULL
                  AND (quote_expiry_date IS NULL OR quote_expiry_date > DATE('now'))`,
            [cutoffStr], (err, rows) => resolve(err ? [] : (rows || [])))
    );

    let sent = 0, errors = 0;
    for (const b of bookings) {
        try {
            // PAYMENT-CRITICAL: `R ${parseFloat(b.quote_amount || 0).toFixed(2)}` kept verbatim.
            const expiryNote = b.quote_expiry_date
                ? ` Please note your quote expires on <strong style="color:#D4AF37;">${b.quote_expiry_date}</strong>.`
                : '';
            const { socialLinks: followUpSocialLinks } = await getEmailFooterContext();
            const banner = await bannerRegistry.resolveBanner('quote_still_open');
            const emailBody = emailComponents.renderPremiumEmail({
                preheaderText: `Your quote for booking #${b.id} is still open.`,
                bannerSrc: banner?.src, bannerAlt: banner?.alt, subtitle: banner?.subtitle,
                headline: banner?.headline || 'Your Quote Awaits',
                greeting: `Hi ${b.name},`,
                bodyHtml:
                    `This is a friendly reminder that you have an open quotation for your upcoming <strong style="color:#FAFAFA;">${b.event_type}</strong> on <strong style="color:#FAFAFA;">${b.date}</strong>.` +
                    `<p style="margin:10px 0 0; color:#B0B0B0;">Your quote of <strong style="color:#D4AF37;">R ${parseFloat(b.quote_amount || 0).toFixed(2)}</strong> is still awaiting your response.${expiryNote}</p>` +
                    `<p style="margin:10px 0 0; color:#E6E6E6;">Use the button below to review and accept — the date is still available for you.</p>` +
                    `<p style="margin:10px 0 0; color:#707070; font-size:12px;">If you no longer wish to proceed, simply reply to this email or contact us directly and we will close the enquiry. (Booking reference #${b.id})</p>`,
                cta: { label: 'Review & Accept Quote', url: `${baseUrl}/?track=${b.id}&email=${encodeURIComponent(b.email)}&action=accept` },
                socialLinks: followUpSocialLinks
            });
            const result = await sendEmail({
                to: b.email,
                subject: `Reminder: Your Quote Is Still Open — Ref #${b.id}`,
                htmlContent: emailBody,
                preWrapped: true,
                titleOverride: 'Your Quote Awaits',
                trigger_event: 'Booking: Quote Follow-Up Reminder'
            });
            if (result.success) {
                db.run("UPDATE bookings SET quote_follow_up_sent_at = CURRENT_TIMESTAMP WHERE id = ?", [b.id]);
                sent++;
            } else {
                errors++;
            }
        } catch (e) {
            console.error(`[Quote Follow-Up] Failed for booking ${b.id}:`, e.message);
            errors++;
        }
    }
    console.log(`[Quote Follow-Up Job] Done — sent: ${sent}, errors: ${errors}`);
    return { sent, errors };
}

setTimeout(() => {
    runQuoteFollowUpJob().catch(err => console.error('[Quote Follow-Up Job] Startup run failed:', err.message));
    setInterval(() => {
        runQuoteFollowUpJob().catch(err => console.error('[Quote Follow-Up Job] Scheduled run failed:', err.message));
    }, 24 * 60 * 60 * 1000);
}, 20000);

// S3: Stalled-booking admin alert — ACCEPTED with no invoice after 3 days
async function runStalledBookingAdminAlertJob() {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 3);
    const cutoffStr = cutoff.toISOString().split('T')[0];

    const stalled = await new Promise(resolve =>
        db.all(
            `SELECT b.id, b.name, b.email, b.event_name, b.event_type, b.date, b.accepted_at
             FROM bookings b
             LEFT JOIN invoices i ON i.booking_id = b.id AND UPPER(i.status) != 'VOID'
             WHERE b.status = 'ACCEPTED'
               AND DATE(b.accepted_at) <= ?
               AND i.id IS NULL`,
            [cutoffStr], (err, rows) => resolve(err ? [] : (rows || []))
        )
    );

    if (stalled.length === 0) return;

    const adminEmail = await getNotificationEmail();
    if (!adminEmail) return;

    const body = emailComponents.renderSystemEmail({
        preheaderText: `${stalled.length} ACCEPTED booking(s) missing an invoice.`,
        category: 'Payments & Invoices',
        severity: 'action',
        leadFact: `The following bookings have been in <strong style="color:#D4AF37;">ACCEPTED</strong> status for more than 3 days with no invoice generated.`,
        bodyHtml: `<p style="margin:0; color:#B0B0B0; font-size:12px;">Log in to the admin portal to generate invoices for these bookings.</p>`,
        cards: [{
            title: 'Stalled Bookings',
            rows: stalled.map(b => ({
                label: `#${b.id} — ${b.name}`,
                value: `${b.event_name || b.event_type} · Event: ${b.date} · Accepted: ${b.accepted_at ? b.accepted_at.slice(0, 10) : 'N/A'}`,
                mono: false
            }))
        }]
    });

    await sendEmail({
        to: adminEmail,
        subject: `Action Required: ${stalled.length} ACCEPTED booking(s) missing invoice`,
        htmlContent: body,
        preWrapped: true,
        titleOverride: 'Stalled Bookings Alert',
        trigger_event: 'Admin: Stalled Booking Alert'
    }).catch(e => console.error('[Stalled Booking Alert] Email failed:', e.message));

    console.log(`[Stalled Booking Alert] Notified admin of ${stalled.length} stalled booking(s).`);
}

setTimeout(() => {
    runStalledBookingAdminAlertJob().catch(e => console.error('[Stalled Booking Alert] Startup run failed:', e.message));
    setInterval(() => {
        runStalledBookingAdminAlertJob().catch(e => console.error('[Stalled Booking Alert] Scheduled run failed:', e.message));
    }, 24 * 60 * 60 * 1000);
}, 30000);

// ============================================================================
// BOOKING RECOVERY — reminder + purge jobs
//  Reminder cadence: #1 at last_activity + 1h, #2 at last_reminder + 24h,
//  #3 at last_reminder + 72h. Consent-gated (consent_given=1), opt-out-aware,
//  capped at 3. Due-time selection is done in SQL to avoid TZ parsing issues.
// ============================================================================
async function runAbandonedBookingReminderJob() {
    const candidates = await new Promise(resolve =>
        db.all(`SELECT * FROM abandoned_bookings
                WHERE status IN ('ABANDONED','REMINDED') AND consent_given=1 AND opt_out=0
                  AND converted_booking_id IS NULL AND reminders_sent < 3 AND email IS NOT NULL
                  AND (
                    (reminders_sent = 0 AND last_activity_at <= datetime('now','-1 hour')) OR
                    (reminders_sent = 1 AND last_reminder_at <= datetime('now','-24 hours')) OR
                    (reminders_sent = 2 AND last_reminder_at <= datetime('now','-72 hours'))
                  )`, [], (err, rows) => resolve(err ? [] : (rows || []))));
    if (!candidates.length) return;

    for (const d of candidates) {
        // Defensive: if a real booking now exists for this email+date, mark recovered instead of emailing.
        if (d.event_date) {
            const existing = await new Promise(resolve => db.get(
                `SELECT id FROM bookings WHERE lower(email)=lower(?) AND date=? AND status NOT IN ('CANCELLED','EXPIRED') LIMIT 1`,
                [d.email, d.event_date], (e, row) => resolve(row)));
            if (existing) {
                await new Promise(r => db.run(`UPDATE abandoned_bookings SET status='RECOVERED', converted_booking_id=? WHERE id=?`, [existing.id, d.id], () => r()));
                continue;
            }
        }
        const ok = await sendAbandonedBookingReminderEmail(d);
        if (ok) {
            await new Promise(r => db.run(`UPDATE abandoned_bookings SET reminders_sent=reminders_sent+1, last_reminder_at=CURRENT_TIMESTAMP, status='REMINDED' WHERE id=?`, [d.id], () => r()));
            console.log(`[Booking Recovery] reminder #${d.reminders_sent + 1} sent for draft ${d.id}`);
        }
    }
}

// POPIA retention: purge stale, non-converted drafts after 30 days.
function runAbandonedBookingPurgeJob() {
    db.run(`DELETE FROM abandoned_bookings WHERE status NOT IN ('RECOVERED','WON') AND last_activity_at < datetime('now','-30 days')`, function (err) {
        if (err) return console.error('[Booking Recovery] purge failed:', err.message);
        if (this && this.changes > 0) console.log(`[Booking Recovery] POPIA purge removed ${this.changes} stale draft(s).`);
    });
}

setTimeout(() => {
    runAbandonedBookingReminderJob().catch(e => console.error('[Booking Recovery] reminder startup run failed:', e.message));
    setInterval(() => {
        runAbandonedBookingReminderJob().catch(e => console.error('[Booking Recovery] reminder run failed:', e.message));
    }, 15 * 60 * 1000);
    runAbandonedBookingPurgeJob();
    setInterval(runAbandonedBookingPurgeJob, 24 * 60 * 60 * 1000);
}, 30000);

// S4-1: DEPOSIT_PAID approaching-event reminder job
// Fires for DEPOSIT_PAID bookings whose event is within 14 days; deduplicates per booking using deposit_balance_reminded_at.
async function runDepositBalanceReminderJob() {
    const windowDays = 14; // start reminding when event is this many days away
    const targetDate = moment().add(windowDays, 'days').format('YYYY-MM-DD');
    const baseUrl = process.env.BASE_URL || 'https://www.thabisomhlongo.com';

    const bookings = await new Promise(resolve =>
        db.all(
            `SELECT id, name, email, event_name, event_type, date AS event_date,
                    amount_outstanding, total_amount, deposit_balance_reminded_at
             FROM bookings
             WHERE payment_status = 'DEPOSIT_PAID'
               AND status = 'CONFIRMED'
               AND date IS NOT NULL AND date <= ?
               AND (deposit_balance_reminded_at IS NULL
                    OR deposit_balance_reminded_at < DATE('now', '-7 days'))`,
            [targetDate],
            (err, rows) => resolve(err ? [] : (rows || []))
        )
    );

    let sent = 0, errors = 0;
    for (const b of bookings) {
        const outstanding = parseFloat(b.amount_outstanding) || 0;
        if (outstanding <= 0) continue; // already fully paid

        const daysUntilEvent = moment(b.event_date).diff(moment(), 'days');
        const payUrl = `${baseUrl}/?track=${b.id}&email=${encodeURIComponent(b.email)}`;

        // PAYMENT-CRITICAL: `R ${outstanding.toFixed(2)}` kept verbatim (both mentions).
        const { socialLinks: balanceSocialLinks } = await getEmailFooterContext();
        const banner = await bannerRegistry.resolveBanner('balance_payment_reminder');
        const emailBody = emailComponents.renderPremiumEmail({
            preheaderText: `Balance of R ${outstanding.toFixed(2)} due — event in ${daysUntilEvent} day${daysUntilEvent !== 1 ? 's' : ''}.`,
            bannerSrc: banner?.src, bannerAlt: banner?.alt, subtitle: banner?.subtitle,
            headline: banner?.headline || 'Balance Due — Event Approaching',
            greeting: `Hi ${b.name},`,
            bodyHtml:
                `Your event <strong style="color:#FAFAFA;">${b.event_name || b.event_type}</strong> is coming up in <strong style="color:#D4AF37;">${daysUntilEvent} day${daysUntilEvent !== 1 ? 's' : ''}</strong>!` +
                `<p style="margin:10px 0 0; color:#E6E6E6;">We wanted to remind you that a <strong style="color:#D4AF37;">balance payment of R ${outstanding.toFixed(2)}</strong> is still outstanding for your booking.</p>`,
            cards: [{
                title: 'Balance Due',
                rows: [
                    { label: 'Event Date', value: b.event_date },
                    { label: 'Balance Due', value: `R ${outstanding.toFixed(2)}`, highlight: true }
                ]
            }],
            cta: { label: 'Pay Balance Now', url: payUrl },
            socialLinks: balanceSocialLinks
        });

        try {
            await sendEmail({
                to: b.email,
                subject: `Balance Payment Reminder — ${b.event_date} Event (Booking #${b.id})`,
                htmlContent: emailBody,
                preWrapped: true,
                titleOverride: 'Balance Due — Event Approaching',
                trigger_event: 'Booking: Deposit Balance Approaching Event Reminder'
            });
            db.run("UPDATE bookings SET deposit_balance_reminded_at = CURRENT_TIMESTAMP WHERE id = ?", [b.id]);
            sent++;
            console.log(`[Deposit Balance Reminder] Sent to booking #${b.id} (${b.email})`);
        } catch (e) {
            console.error(`[Deposit Balance Reminder] Failed for booking #${b.id}:`, e.message);
            errors++;
        }
    }
    console.log(`[Deposit Balance Reminder Job] Done — sent: ${sent}, errors: ${errors}`);
}

setTimeout(() => {
    runDepositBalanceReminderJob().catch(err => console.error('[Deposit Balance Reminder Job] Startup run failed:', err.message));
    setInterval(() => {
        runDepositBalanceReminderJob().catch(err => console.error('[Deposit Balance Reminder Job] Scheduled run failed:', err.message));
    }, 24 * 60 * 60 * 1000);
}, 30000);

// S4-2: Invoice pre-due reminder — sends email 3 days before invoice due_date for SENT invoices
async function runInvoicePreDueReminderJob() {
    const daysBefore = 3;
    const targetDate = new Date();
    targetDate.setDate(targetDate.getDate() + daysBefore);
    const targetStr = targetDate.toISOString().split('T')[0];

    const invoices = await new Promise(resolve =>
        db.all(
            `SELECT i.id, i.invoice_number, i.due_date, i.total_amount,
                    b.id AS booking_id, b.name, b.email, b.event_name, b.event_type, b.date
             FROM invoices i
             JOIN bookings b ON b.id = i.booking_id
             WHERE UPPER(i.status) = 'SENT'
               AND i.due_date = ?
               AND i.pre_due_reminded_at IS NULL
               AND b.status = 'CONFIRMED'
               AND b.payment_status NOT IN ('PAID')`,
            [targetStr],
            (err, rows) => resolve(err ? [] : (rows || []))
        )
    );

    let sent = 0, errors = 0;
    for (const inv of invoices) {
        const booking = { id: inv.booking_id, name: inv.name, email: inv.email, event_name: inv.event_name, event_type: inv.event_type, date: inv.date };
        try {
            await sendInvoicePreDueEmail(booking, inv, daysBefore);
            db.run("UPDATE invoices SET pre_due_reminded_at = CURRENT_TIMESTAMP WHERE id = ?", [inv.id]);
            sent++;
            console.log(`[Invoice Pre-Due Reminder] Sent to booking #${inv.booking_id} (invoice #${inv.id})`);
        } catch (e) {
            console.error(`[Invoice Pre-Due Reminder] Failed for invoice #${inv.id}:`, e.message);
            errors++;
        }
    }
    console.log(`[Invoice Pre-Due Reminder Job] Done — sent: ${sent}, errors: ${errors}`);
}

setTimeout(() => {
    runInvoicePreDueReminderJob().catch(err => console.error('[Invoice Pre-Due Reminder Job] Startup run failed:', err.message));
    setInterval(() => {
        runInvoicePreDueReminderJob().catch(err => console.error('[Invoice Pre-Due Reminder Job] Scheduled run failed:', err.message));
    }, 24 * 60 * 60 * 1000);
}, 40000);

// S4-3: Overdue invoice sweep — sends the overdue notice for invoices past their due_date
async function runOverdueInvoiceSweepJob() {
    // Africa/Johannesburg, not UTC. SQLite's DATE('now') is UTC, and SA is UTC+2, so for the two
    // hours after local midnight an invoice due "today" was treated as already overdue.
    const todayLocal = moment().tz('Africa/Johannesburg').format('YYYY-MM-DD');
    const invoices = await new Promise(resolve =>
        db.all(
            // Match SENT *and* OVERDUE. runDailyOverdueFlaggingSweep() runs at startup + 00:05 and
            // flips SENT → OVERDUE, so by the time this reminder ran the invoices it should chase were
            // already OVERDUE and this WHERE — which only matched SENT — found nothing. The result was
            // that the overdue reminder had NEVER fired (measured: 7 OVERDUE invoices, 0 with
            // overdue_reminded_at set). overdue_reminded_at IS NULL keeps it idempotent.
            `SELECT i.id, i.invoice_number, i.due_date, i.total_amount,
                    b.id AS booking_id, b.name, b.email, b.event_name, b.event_type, b.date
             FROM invoices i
             JOIN bookings b ON b.id = i.booking_id
             WHERE UPPER(i.status) IN ('SENT','OVERDUE')
               AND i.due_date IS NOT NULL
               AND i.due_date < ?
               AND i.overdue_reminded_at IS NULL
               AND b.status = 'CONFIRMED'
               AND b.payment_status NOT IN ('PAID')`,
            [todayLocal],
            (err, rows) => resolve(err ? [] : (rows || []))
        )
    );

    let sent = 0, errors = 0;
    for (const inv of invoices) {
        const booking = { id: inv.booking_id, name: inv.name, email: inv.email, event_name: inv.event_name, event_type: inv.event_type, date: inv.date };
        try {
            await sendOverdueInvoiceEmail(booking, inv);
            db.run("UPDATE invoices SET overdue_reminded_at = CURRENT_TIMESTAMP WHERE id = ?", [inv.id]);
            sent++;
            console.log(`[Overdue Invoice Sweep] Sent to booking #${inv.booking_id} (invoice #${inv.id})`);
        } catch (e) {
            console.error(`[Overdue Invoice Sweep] Failed for invoice #${inv.id}:`, e.message);
            errors++;
        }
    }
    console.log(`[Overdue Invoice Sweep Job] Done — sent: ${sent}, errors: ${errors}`);
}

setTimeout(() => {
    runOverdueInvoiceSweepJob().catch(err => console.error('[Overdue Invoice Sweep Job] Startup run failed:', err.message));
    setInterval(() => {
        runOverdueInvoiceSweepJob().catch(err => console.error('[Overdue Invoice Sweep Job] Scheduled run failed:', err.message));
    }, 24 * 60 * 60 * 1000);
}, 45000);

// S6-1: Post-event follow-up job — sends review-request email the day after a COMPLETED event
async function runPostEventFollowupJob() {
    const baseUrl = process.env.SITE_URL || '';
    const bookings = await new Promise(resolve => {
        db.all(`SELECT b.*, COALESCE(c.name, b.client_name) as name, COALESCE(c.email, b.client_email) as email
                FROM bookings b
                LEFT JOIN clients c ON b.client_id = c.id
                WHERE b.status = 'COMPLETED'
                  AND b.review_email_sent_at IS NULL
                  AND date(b.date) <= date('now', '-1 day')`,
            [], (err, rows) => resolve(err ? [] : (rows || [])));
    });

    let sent = 0, errors = 0;
    for (const b of bookings) {
        try {
            // Send the review request (function already exists)
            await sendReviewRequestEmail(b);
            db.run("UPDATE bookings SET review_email_sent_at = CURRENT_TIMESTAMP WHERE id = ?", [b.id]);
            sent++;
            console.log(`[Post-Event Followup] Review request sent for booking #${b.id} (${b.email})`);
        } catch (e) {
            console.error(`[Post-Event Followup] Failed for booking #${b.id}:`, e.message);
            errors++;
        }
    }
    if (sent > 0 || errors > 0) {
        console.log(`[Post-Event Followup Job] Done — sent: ${sent}, errors: ${errors}`);
    }
}

setTimeout(() => {
    runPostEventFollowupJob().catch(err => console.error('[Post-Event Followup Job] Startup run failed:', err.message));
    setInterval(() => {
        runPostEventFollowupJob().catch(err => console.error('[Post-Event Followup Job] Scheduled run failed:', err.message));
    }, 24 * 60 * 60 * 1000);
}, 35000);

// P2-10: Daily ledger reconciliation — compare bookings.amount_paid vs SUM(verified transactions).
async function runLedgerReconciliationJob() {
    const discrepancies = await new Promise(resolve => {
        db.all(
            `SELECT b.id, b.name, b.event_name, b.amount_paid AS recorded,
                    COALESCE(SUM(t.amount), 0) AS actual
             FROM bookings b
             LEFT JOIN transactions t ON t.booking_id = b.id
               AND t.is_duplicate = 0
               AND (t.status = 'completed' OR t.status IS NULL)
             WHERE b.payment_status NOT IN ('UNPAID','CANCELLED')
             GROUP BY b.id
             HAVING ABS(b.amount_paid - COALESCE(SUM(CASE WHEN t.transaction_type IN ('refund','chargeback') THEN -t.amount ELSE t.amount END), 0)) > 1`,
            [],
            (err, rows) => resolve(err ? [] : (rows || []))
        );
    });

    if (discrepancies.length === 0) return;

    console.warn(`[Ledger Reconciliation] ${discrepancies.length} booking(s) have amount_paid vs transaction-sum discrepancy.`);

    const adminEmail = await getNotificationEmail();
    if (!adminEmail) return;

    const body = emailComponents.renderSystemEmail({
        preheaderText: `${discrepancies.length} booking(s) with a payment ledger discrepancy.`,
        category: 'Payments & Invoices',
        severity: 'alert',
        leadFact: `The following bookings have a mismatch between <strong style="color:#FAFAFA;">bookings.amount_paid</strong> and the <strong style="color:#FAFAFA;">sum of completed non-duplicate transactions</strong>. Please investigate and correct manually.`,
        cards: [{
            title: 'Payment Ledger Discrepancies',
            rows: discrepancies.map(d => ({
                label: `#${d.id} — ${d.name || ''}${d.event_name ? ' · ' + d.event_name : ''}`,
                value: `Recorded R ${parseFloat(d.recorded).toFixed(2)} · Tx Sum R ${parseFloat(d.actual).toFixed(2)} · Drift R ${(parseFloat(d.recorded) - parseFloat(d.actual)).toFixed(2)}`,
                mono: false
            }))
        }]
    });

    await sendEmail({
        to: adminEmail,
        subject: `[Ledger Alert] ${discrepancies.length} booking(s) with payment discrepancy`,
        htmlContent: body,
        preWrapped: true,
        titleOverride: 'Ledger Discrepancy Alert',
        trigger_event: 'Admin: Ledger Reconciliation'
    });
}

setTimeout(() => {
    runLedgerReconciliationJob().catch(err => console.error('[Ledger Reconciliation] Startup run failed:', err.message));
    setInterval(() => {
        runLedgerReconciliationJob().catch(err => console.error('[Ledger Reconciliation] Scheduled run failed:', err.message));
    }, 24 * 60 * 60 * 1000);
}, 55000);

// P3-14: Detect transactions stuck in pending PayFast status for >1 hour and alert admin.
async function runPayFastPendingTimeoutJob() {
    const stuckTx = await new Promise(resolve => {
        db.all(
            `SELECT t.id, t.booking_id, t.amount, t.created_at, b.name, b.email, b.event_name
             FROM transactions t
             JOIN bookings b ON b.id = t.booking_id
             WHERE t.source = 'payfast'
               AND (t.pf_status = 'PENDING' OR (t.status = 'pending' AND t.pf_status IS NULL))
               AND t.created_at <= datetime('now', '-1 hour')`,
            [],
            (err, rows) => resolve(err ? [] : (rows || []))
        );
    });

    if (stuckTx.length === 0) return;

    console.warn(`[PayFast Pending] ${stuckTx.length} transaction(s) stuck in PENDING for >1 hour.`);
    const adminEmail = await getNotificationEmail();
    if (!adminEmail) return;

    const body = emailComponents.renderSystemEmail({
        preheaderText: `${stuckTx.length} PayFast transaction(s) stuck in PENDING for over 1 hour.`,
        category: 'Payments & Invoices',
        severity: 'alert',
        leadFact: `The following PayFast transactions have been in <strong style="color:#FAFAFA;">PENDING</strong> status for more than 1 hour. PayFast may have not sent an ITN. Please check the PayFast dashboard and confirm or void manually.`,
        cards: [{
            title: 'Stuck PayFast Transactions',
            rows: stuckTx.map(t => ({
                label: `#${t.booking_id} — ${t.name || ''}`,
                value: `R${parseFloat(t.amount).toFixed(2)} · Started ${t.created_at}`,
                mono: false
            }))
        }]
    });

    await sendEmail({
        to: adminEmail,
        subject: `[PayFast Alert] ${stuckTx.length} transaction(s) stuck in PENDING for >1 hour`,
        htmlContent: body,
        preWrapped: true,
        titleOverride: 'PayFast Pending Timeout',
        trigger_event: 'Admin: PayFast Pending Timeout'
    });
}

setTimeout(() => {
    runPayFastPendingTimeoutJob().catch(e => console.error('[PayFast Pending Timeout] Startup run failed:', e.message));
    setInterval(() => {
        runPayFastPendingTimeoutJob().catch(e => console.error('[PayFast Pending Timeout] Scheduled run failed:', e.message));
    }, 60 * 60 * 1000); // check hourly
}, 65000);

// C9: Prevent sandbox PayFast config from silently disabling payment validation in production
if (process.env.NODE_ENV === 'production' && (process.env.PAYFAST_URL || '').includes('sandbox')) {
    console.error('🚨 STARTUP ABORTED: PAYFAST_URL contains "sandbox" while NODE_ENV is "production". Payment signature and IP validation are disabled. Fix .env before restarting.');
    process.exit(1);
}

app.listen(PORT, () => {
    console.log(`✅ File Upload Server running at http://localhost:${PORT}`);
    console.log(`✅ Email Dispatcher running at POST /send-email`);
    console.log(`✅ Newsletter Server running at POST /send-newsletter`);
    console.log(`Admin page will now save files physically to your images/ folder structure.`);

    // Load pending scheduled newsletter jobs
    setTimeout(loadPendingScheduledJobs, 1000);

    // Load pending scheduled direct emails
    setTimeout(loadPendingDirectEmails, 1500);

    // Quote Amount Consistency Check
    setTimeout(() => {
        db.all(`
            SELECT b.id, b.quote_amount as legacy_amount, lq.total_amount as real_amount
            FROM bookings b
            JOIN quotations lq ON lq.id = (SELECT MAX(id) FROM quotations WHERE booking_id = b.id AND status != 'void')
        `, [], (err, rows) => {
            if (!err && rows) {
                let inconsistencies = 0;
                rows.forEach(r => {
                    const legacy = parseFloat((r.legacy_amount || '0').replace(/[^0-9.]/g, '')) || 0;
                    const real = parseFloat(r.real_amount) || 0;
                    if (Math.abs(legacy - real) > 0.01) {
                        console.warn(`[Quote Mismatch] Booking #${r.id} legacy string is ${r.legacy_amount} but real quote total is R ${real.toFixed(2)}`);
                        inconsistencies++;
                    }
                });
                if (inconsistencies > 0) {
                    console.log(`[Consistency Check] Found ${inconsistencies} bookings with legacy quote mismatches. Display logic will use real quote amounts.`);
                }
            }
        });
    }, 5000);
});
