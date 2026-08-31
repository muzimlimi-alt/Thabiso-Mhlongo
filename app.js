// Phase 5 (HOUSEKEEPING-NOTES.md): final route-split cleanup — app.js now holds only the
// background cron jobs, session/middleware/static setup, and the one order-sensitive route
// (robots.txt) left after every other route moved to its own file. multer/PDFDocument/pdfService/
// emailTemplates/transporter (and dozens of repository/lib re-imports further below) have no
// remaining caller here — each was already re-imported directly by whichever route file its last
// caller moved into. Verified via an AST-based check (every remaining destructured `require`
// checked for a real `name(` call site elsewhere in the file, cross-checked against bare
// property-access references before removal) rather than by memory.
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const emailService = require('./js/emailService');
const sendEmail = emailService.sendEmail;
const emailComponents = require('./js/emailComponents');
const bannerRegistry = require('./js/bannerRegistry');
const crypto = require('crypto');
const db = require('./database');
// Phase 4 (HOUSEKEEPING-NOTES.md): settings-domain data access moved to a repository. Destructured
// here so every existing call site throughout this file keeps working unchanged.
const { getAllSettings, getNotificationEmail } = require('./database/repositories/settings.repository');
// Phase 4: newsletter-domain data access moved to a repository — same destructure-in pattern.
const {
    getPendingScheduledNewsletters,
    deleteOldUnsubscribedSubscribers,
} = require('./database/repositories/newsletter.repository');
// Phase 4: inquiries-domain data access moved to a repository — same destructure-in pattern.
const { anonymizeOldInquiries } = require('./database/repositories/inquiries.repository');
// Phase 4: bookings-domain data access moved to a repository (staged extraction — see
// HOUSEKEEPING-NOTES.md for the sub-pass plan; this import grows as later stages land).
const {
    getBookingById,
    getStaleNewBookings, promoteBookingToPending, getConfirmedPaidPastEvents, markBookingAutoCompleted,
    getStalePendingBookings, expirePendingBooking, getOverdueQuotedBookings, expireQuotedBooking,
    clearBookingGoogleEventId, getQuotesExpiringTomorrow, markQuoteExpiryWarned,
    getPendingEnquiriesNearingExpiry, markPendingExpiryWarned, markBookingOverdueReminded,
    getBookingsForQuoteFollowUp, markQuoteFollowUpSent, findActiveBookingByEmailAndDate,
    getBookingsForDepositBalanceReminder, markDepositBalanceReminded,
    getConfirmedBookingsOnDate, markEventReminderSent, getCompletedBookingsAwaitingReview,
    stampReviewEmailSent,
} = require('./database/repositories/bookings.repository');
// Phase 4: invoices+quotations-domain data access moved to a repository (HOUSEKEEPING-NOTES.md).
const {
    markInvoicePaidForAutoComplete,
    flagOverdueInvoices,
    markInvoicePreDueReminded, markInvoiceOverdueReminded,
} = require('./database/repositories/invoices-quotations.repository');
// Phase 4: finance-domain data access moved to a repository (HOUSEKEEPING-NOTES.md).
const { flagOverduePaymentSchedules } = require('./database/repositories/finance.repository');
// Phase 4: calendar-domain (date_holds, events) data access moved to a repository (HOUSEKEEPING-NOTES.md).
const {
    advanceAutoCompletedEventS6, getPastStandaloneEventsForAutoComplete, advanceStandaloneEventCompleted,
} = require('./database/repositories/calendar.repository');
// Phase 4: auth+users-domain (admins, admin_login_logs, password_reset_tokens) data access moved
// to a repository (HOUSEKEEPING-NOTES.md).
const { countAllAdmins, insertBootstrapAdmin } = require('./database/repositories/auth-users.repository');
require('dotenv').config();

// Ensure scratch directory exists
const scratchDir = path.join(__dirname, 'scratch');
if (!fs.existsSync(scratchDir)) {
    fs.mkdirSync(scratchDir, { recursive: true });
}

// Phase 5 (HOUSEKEEPING-NOTES.md): runtime storage locations (Phase 3 originally) moved to
// lib/runtime-paths.js — needed by route files being split out of this one, not just app.js.
// DOCS_PATH/BACKUPS_PATH/LEGACY_DOCS_DIR/ensureDir/docsWriteDir/resolveDocsPath have no remaining
// caller here — every route that used them has moved to its own route file, each importing
// whichever of these it still needs directly. Only UPLOADS_PATH still has real callers here.
const { UPLOADS_PATH } = require('./lib/runtime-paths');


// Phase 5 (HOUSEKEEPING-NOTES.md): parseDurationMins moved to routes/public/bookings.js —
// single-consumer (the booking-intake route moved with it).

// Still needed directly in this file for runDailyOverdueFlaggingSweep's and the analytics-rollup
// cron's own schedule.scheduleJob(...) registrations below (unrelated to newsletter/birthday
// scheduling) — scheduledJobs and birthdayJob themselves moved to lib/newsletter-scheduling.js and
// lib/newsletter-birthday.js respectively.
const schedule = require('node-schedule');

// Phase 5 (HOUSEKEEPING-NOTES.md): geoip/UAParser (geo + UA parsing for the first-party page-view
// tracker) have no remaining caller here — their only call site, POST /api/public/analytics/track,
// moved to routes/public/misc.js, which imports both directly.

// Booking scheduling config — defaults overridden by settings table at startup. Phase 5
// (HOUSEKEEPING-NOTES.md): moved to lib/booking-config.js as a shared mutable object so the write
// in routes/admin/settings.js and the reads still in this file stay in sync — see that file for why.
const { bookingConfig } = require('./lib/booking-config');

// Load settings from database into process.env
getAllSettings((err, rows) => {
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
                    if (!isNaN(parsed)) bookingConfig.minGapMins = parsed;
                } else if (key === 'type_buffers') {
                    try { bookingConfig.typeBuffers = JSON.parse(val) || {}; } catch(e) {}
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
const moment = require('moment-timezone');
moment.tz.setDefault('Africa/Johannesburg');

// Phase 5 (HOUSEKEEPING-NOTES.md): Google Calendar client (oauth2Client/calendar/CALENDAR_ID)
// moved to lib/google-calendar.js. calendar/CALENDAR_ID have no remaining caller in app.js — per
// that module's own header comment, their construction has no order dependency beyond "requires
// somewhere during startup," which the later deleteGoogleEvent import below still satisfies.

const helmet = require('helmet');

// Phase 5 (HOUSEKEEPING-NOTES.md): every rate limiter moved to middleware/rate-limiters.js. This
// re-import has no remaining caller in app.js — every route that used to call one of these directly
// has now moved to its own route file (the final standalone/webhook batch closed out the last of
// them), each importing whichever limiter it needs from middleware/rate-limiters.js directly.
// middleware/auth.js still builds requireAdmin from adminRateLimiter via its own independent import
// of that module — unaffected by removing this one.

// Bypass local antivirus/proxy self-signed certificates
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// Phase 5 (HOUSEKEEPING-NOTES.md): sanitizeEmailInput (lib/validation.js) has no remaining caller
// here — its last call site, /send-email, moved to routes/public/misc.js, which imports it
// directly.

// Phase 5 (HOUSEKEEPING-NOTES.md): moved to lib/newsletter-scheduling.js. scheduledJobs and
// buildSegmentCondition have no remaining caller here (buildSegmentCondition is called from inside
// scheduleNewsletterSend, itself in that same module) — only scheduleNewsletterSend is still
// called directly from this file.
const { scheduleNewsletterSend } = require('./lib/newsletter-scheduling');

const app = express();
const PORT = process.env.PORT || 3000;

// Phase 5 (HOUSEKEEPING-NOTES.md): CURRENT_POLICY_VERSION and MIN_ADVANCE_HOURS both moved to
// lib/booking-policy.js. Neither has a remaining caller here — every call site (the public
// availability route, the public booking-intake route, the newsletter subscribe route, the admin
// manual-booking-creation route) has moved to its own route file, each importing directly whichever
// of the two it needs.

app.use(helmet({
    // Helmet's default Referrer-Policy is "no-referrer", which strips the Referer header from
    // cross-origin requests. YouTube's embedded player uses that header to verify the embedding
    // domain and returns "Error 153" (video player configuration error) when it's absent, so no
    // milestone/social video could ever play. "strict-origin-when-cross-origin" (the modern browser
    // default) sends only the origin — never the path or query — cross-origin over equal-or-better
    // transport, which is enough for YouTube/Vimeo to validate the domain without leaking anything.
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
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
                "https://unpkg.com",
                "https://flagcdn.com"
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
    if (req.body && req.path !== '/api/admin/about-me' && req.path !== '/api/admin/site-content' && req.path !== '/api/admin/newsletter/birthday-settings') deepEscapeBody(req.body);
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
// Phase 5 (HOUSEKEEPING-NOTES.md): deliberately NOT moved to a route file, unlike every other
// route in the final standalone/webhook batch. This handler is registered before the blanket
// static-file server further below (`express.static(path.join(__dirname, '/'))`), and a physical
// `robots.txt` file exists at the project root with genuinely different content (confirmed via
// diff) — Express matches routes/middleware in registration order, so moving this into the
// `app.use(require(...))` mount block (itself registered after that static server) would let the
// physical file silently shadow this dynamic handler, a real behaviour change. Left in place here
// to preserve the exact registration order the plan's own middleware-ordering rule requires.
app.get('/robots.txt', (req, res) => {
    res.type('text/plain');
    res.send('User-agent: *\nDisallow: /admin\nDisallow: /api\n');
});

// Protect sensitive files and directories from static exposure
app.use((req, res, next) => {
    const url = req.path.toLowerCase();
    const normalizedUrl = url.replace(/\\/g, '/');

    if (
        normalizedUrl.includes('/.git/') ||
        normalizedUrl.includes('/.agents/') ||
        normalizedUrl.includes('/tbc/') ||
        normalizedUrl.includes('/backups/') ||
        normalizedUrl.includes('/db-backups/') ||
        normalizedUrl.includes('/scratch/') ||
        normalizedUrl.includes('/test/') ||
        normalizedUrl.includes('/scripts/') ||
        normalizedUrl.includes('/docs/') ||
        normalizedUrl.endsWith('.sqlite') ||
        normalizedUrl.endsWith('.sqlite-shm') ||
        normalizedUrl.endsWith('.sqlite-wal') ||
        normalizedUrl.endsWith('.env') ||
        normalizedUrl.endsWith('.env.example') ||
        normalizedUrl.endsWith('.json') ||
        normalizedUrl.endsWith('.md') ||
        (normalizedUrl.endsWith('.js') && !normalizedUrl.endsWith('/tracker.js') && !normalizedUrl.includes('/js/'))
    ) {
        return res.status(403).send('Forbidden: Direct access to this file/directory is restricted.');
    }
    next();
});

// Serves newly-uploaded images from the external UPLOADS_PATH (Phase 3, HOUSEKEEPING-NOTES.md).
// Mounted before the blanket repo-root static server below so a request for e.g.
// /images/gallery/x.jpg is tried against the new external location first; express.static calls
// next() on a miss, which falls through to the blanket mount and serves it from the legacy
// in-repo images/ folder if that's where the file actually is. Nothing here changes which URL an
// image is served at — only where the bytes are read from.
app.use('/images', express.static(UPLOADS_PATH));
// Receipts were previously served from the in-repo uploads/ folder the same way (no dedicated
// auth-gated download route) — same external-first, legacy-fallback pattern as /images above.
app.use('/uploads', express.static(UPLOADS_PATH));

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

// The dashboard fires dozens of concurrent authenticated requests on load. express-session calls
// store.touch() (an UPDATE) on every one of them even with resave:false, and connect-sqlite3's
// underlying sqlite3.Database has no busy timeout by default — in SQLite's default rollback-journal
// mode, concurrent writers/readers collide and throw SQLITE_BUSY immediately, which express-session
// treats as "no session", producing a burst of spurious 401 "Unauthorized" responses right after
// login. concurrentDb enables WAL (readers no longer block on writers) and the busy timeout below
// makes any remaining writer-vs-writer contention wait/retry instead of failing outright.
const _sessionStore = new SQLiteStore({ db: 'sessions.sqlite', dir: './', concurrentDb: true });
if (_sessionStore.db && typeof _sessionStore.db.configure === 'function') {
    _sessionStore.db.configure('busyTimeout', 5000);
}

app.set('trust proxy', 1); // Trust first proxy (ngrok)
app.use(session({
    store: _sessionStore,
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

// Phase 5 (HOUSEKEEPING-NOTES.md): routes extracted into routes/admin/ and routes/public/ are
// mounted here, after session/body-parsing/sanitisation are all in place and before any
// not-yet-extracted route below. Each router keeps its routes' full original paths (e.g.
// '/api/admin/users'), so mounting with no base path is exactly equivalent to the inline
// app.get/post/... registrations these replaced — this list grows one batch at a time.
app.use(require('./routes/admin/users'));
app.use(require('./routes/admin/auth'));
app.use(require('./routes/admin/settings'));
app.use(require('./routes/admin/site-content'));
app.use(require('./routes/admin/content'));
app.use(require('./routes/admin/home-social'));
app.use(require('./routes/admin/newsletter-subscribers'));
app.use(require('./routes/admin/newsletter-campaigns'));
app.use(require('./routes/admin/inquiries'));
app.use(require('./routes/admin/direct-emails'));
app.use(require('./routes/admin/analytics'));
app.use(require('./routes/admin/legal'));
app.use(require('./routes/admin/popia'));
app.use(require('./routes/admin/abandoned-bookings'));
app.use(require('./routes/admin/expenses'));
app.use(require('./routes/admin/banners'));
app.use(require('./routes/admin/campaigns'));
app.use(require('./routes/admin/services'));
app.use(require('./routes/admin/invoices'));
app.use(require('./routes/admin/bank-statement'));
app.use(require('./routes/admin/reconciliation'));
app.use(require('./routes/admin/advancing'));
app.use(require('./routes/admin/calendar'));
app.use(require('./routes/admin/email-templates'));
app.use(require('./routes/admin/reminders'));
app.use(require('./routes/admin/finance'));
app.use(require('./routes/admin/financials'));
app.use(require('./routes/admin/dashboard'));
app.use(require('./routes/admin/bookings'));
app.use(require('./routes/admin/events'));
app.use(require('./routes/public/bookings'));
app.use(require('./routes/public/site-content'));
app.use(require('./routes/public/availability'));
app.use(require('./routes/admin/misc'));
app.use(require('./routes/admin/transactions'));
app.use(require('./routes/public/popia'));
app.use(require('./routes/public/newsletter'));
app.use(require('./routes/public/payment'));
app.use(require('./routes/public/misc'));

// Phase 5 (HOUSEKEEPING-NOTES.md): moved to lib/uploads.js. None of safeUploadFilename/upload/
// newsletterUpload has a remaining caller in app.js — every admin upload route that used one has
// moved to its own route file, each importing directly whichever of the three it needs.





// ==========================================
// ==========================================
// CALENDAR SYNC HELPERS
// ==========================================

// Phase 5 (HOUSEKEEPING-NOTES.md): timeRangesOverlap/addMinutesToTime/parseDurationToMinutes
// moved to lib/time-utils.js. None has a remaining caller in app.js — their last call sites
// (the calendar/feed.ics route and the availability route) moved to their own route files, each
// importing directly whichever of the three it needs.

// Phase 5 (HOUSEKEEPING-NOTES.md): the Google Calendar sync/booking-conflict engine —
// isWithinWorkingHours/hasCalendarConflict/syncBookingToCalendar/syncCalendarHolds/
// syncEventToCalendar/checkDateAvailability — all moved to lib/calendar-sync.js. (The two orphaned
// JSDoc comments that used to precede isWithinWorkingHours/hasCalendarConflict here were removed
// along with them — their subject functions no longer live in this file.) Of the six,
// syncCalendarHolds is the only one still called directly from app.js (the nightly hold-sync cron);
// isWithinWorkingHours/hasCalendarConflict/checkDateAvailability/syncBookingToCalendar/
// syncEventToCalendar all had their last real call site move to a route file, each importing
// directly whichever of these it still needs.
const { syncCalendarHolds } = require('./lib/calendar-sync');



/**
 * Creates or updates a Google Calendar event for a booking
 * @param {number|object} bookingOrId - Booking ID or booking object
 * @returns {Promise<string|null>} - The Google Event ID
 */

// Phase 5 (HOUSEKEEPING-NOTES.md): deleteGoogleEvent moved to lib/google-calendar.js, alongside
// the calendar client it wraps.
const { deleteGoogleEvent } = require('./lib/google-calendar');


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


// P2-3: Returns the active VAT rate from tax_rates table (falls back to 0.15 / 15%).
// Phase 5 (HOUSEKEEPING-NOTES.md): getVatRate/resolveLineTaxClasses/computeDocumentTotals moved to
// lib/document-totals.js (the FIN-1 tax-rate-fallback fix documented there and in lib/invoicing.js
// carries over). autoBuildDepositBalanceSchedule/generateInvoice moved to lib/invoicing.js.
// logPaymentEvent/alignMilestonePayments/updateBookingMilestones/deriveBookingStatusAfterPayment/
// processManualPayment moved to lib/payment-processing.js. None of these has a remaining caller
// here — all of their call sites moved out with the routes that used them, and each of those
// route files imports directly from the relevant lib.
// processManualPayment has no remaining caller in app.js — its only call site
// (PUT .../manual-payment) moved to routes/admin/bookings.js, which imports it directly.
// Phase 5 (HOUSEKEEPING-NOTES.md): applyStatusChange moved to lib/booking-status.js. Its two
// remaining callers (PUT /api/admin/bookings/:id and PUT .../status) both moved to
// routes/admin/bookings.js in the same batch, which imports it directly — no remaining caller here.

// Phase 5 (HOUSEKEEPING-NOTES.md): autoBuildDepositBalanceSchedule and generateInvoice both moved
// to lib/invoicing.js, along with their own doc comments — see the require near the top of this
// file for the re-import.

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
        getStaleNewBookings(nowLocal, (err, rows) => {
            if (rows && rows.length > 0) {
                rows.forEach(row => {
                    promoteBookingToPending(row.id);
                    sendBookingUnderReviewEmail(row).catch(e => console.error(`[S0] Under-review email failed for #${row.id}:`, e.message));
                });
                console.log(`✓ [S0] Promoted ${rows.length} NEW booking(s) to PENDING after 24h.`);
            }
        });

        // S6: Auto-complete CONFIRMED fully-paid bookings whose event date has passed
        getConfirmedPaidPastEvents(todayLocal, (err, rows) => {
            if (rows && rows.length > 0) {
                rows.forEach(row => {
                    markBookingAutoCompleted(row.id);
                    if (row.event_id) {
                        advanceAutoCompletedEventS6(row.event_id, (e) => { if (e) console.error('[AutoComplete] Event advance failed:', e.message); });
                    }
                    // Parity with manual completion (applyStatusChange): also mark the linked invoice PAID
                    // and send the admin completion summary — not just the client completion email.
                    markInvoicePaidForAutoComplete(row.id,
                        (e) => { if (e) console.error('[S6] Invoice mark-paid failed:', e.message); });
                    sendBookingCompletedEmail(row).catch(e =>
                        console.error(`[S6] Completion email failed for #${row.id}:`, e.message)
                    );
                    getBookingById(row.id, (e, full) => {
                        if (!e && full) sendAdminCompletionSummaryEmail(full).catch(err => console.error(`[S6] Admin completion summary failed for #${row.id}:`, err.message));
                    });
                });
                console.log(`✓ [S6] Auto-completed ${rows.length} fully-paid past-event booking(s) (completion + admin summary emails sent).`);
            }
        });

        // S7: Auto-complete standalone public events (no linked booking) whose date has passed.
        // Booking-linked events already advance via S6 above - a standalone event (created directly
        // in the Events module) had no equivalent, so it could sit at "Upcoming" indefinitely after
        // the show had already happened, until an admin noticed and fixed it manually.
        getPastStandaloneEventsForAutoComplete(nowLocal, (err, rows) => {
            if (rows && rows.length > 0) {
                rows.forEach(row => {
                    advanceStandaloneEventCompleted(row.event_id);
                });
                console.log(`✓ [S7] Auto-completed ${rows.length} past standalone event(s).`);
            }
        });

        // 1. Expire unquoted PENDING bookings after 48 hours of inactivity
        getStalePendingBookings(nowLocal, (err, rows) => {
            if (rows && rows.length > 0) {
                rows.forEach(row => {
                    expirePendingBooking(row.id);
                    sendPendingExpiredEmail(row).catch(e => console.error(`Expiry email failed for booking #${row.id}:`, e.message));
                });
                console.log(`✓ Expired ${rows.length} inactive pending requests (clients notified).`);
            }
        });

        // 2. Expire QUOTED bookings after quote_expiry_date
        getOverdueQuotedBookings(todayLocal, (err, rows) => {
            if (rows && rows.length > 0) {
                rows.forEach(row => {
                    expireQuotedBooking(row.id);
                    // Null the local ID once we've asked Google to delete it — otherwise every future
                    // syncBookingToCalendar() for this booking takes the "already synced" update branch
                    // against an event that no longer exists on Google, fails, and never re-creates it.
                    if (row.google_event_id) {
                        deleteGoogleEvent(row.google_event_id);
                        clearBookingGoogleEventId(row.id);
                    }
                    sendQuoteExpiredEmail(row).catch(e => console.error(`Quote expiry email failed for booking #${row.id}:`, e.message));
                });
                console.log(`✓ Expired ${rows.length} overdue quotes (clients notified).`);
            }
        });

        // 3. Warn clients 24h before quote expires
        getQuotesExpiringTomorrow(tomorrowLocal, (err, rows) => {
            if (rows && rows.length > 0) {
                rows.forEach(row => {
                    markQuoteExpiryWarned(row.id);
                    sendQuoteExpiryWarningEmail(row).catch(e => console.error('Quote warning email failed:', e.message));
                });
            }
        });

        // 3b. Warn the ADMIN about PENDING enquiries about to auto-expire — the final window
        // before step 1 auto-EXPIRES them at 48h from creation. Prevents leads being silently
        // lost. One digest per enquiry (pending_expiry_warned flag stops hourly re-spam).
        getPendingEnquiriesNearingExpiry(nowLocal, async (err, rows) => {
            if (rows && rows.length > 0) {
                const notifEmail = await getNotificationEmail();
                rows.forEach(row => {
                    markPendingExpiryWarned(row.id);
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
                    markBookingOverdueReminded(row.id);
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
        deleteOldUnsubscribedSubscribers(function(err) {
            if (this.changes > 0) console.log(`✓ POPIA: Removed ${this.changes} long-unsubscribed newsletter records.`);
        });

        // 2. Anonymize old inquiries (2 years)
        // We keep the record for stats but wipe PII
        anonymizeOldInquiries(function(err) {
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
        flagOverdueInvoices(
            todayLocal,
            function(err) {
                if (err) {
                    console.error('[cron] Invoice overdue flagging error:', err.message);
                } else if (this.changes > 0) {
                    console.log(`[cron] Flagged ${this.changes} invoice(s) as OVERDUE.`);
                }
            }
        );

        // 2. Flag payment schedules as overdue
        flagOverduePaymentSchedules(
            todayLocal,
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

// Phase 5 (HOUSEKEEPING-NOTES.md): auth/RBAC middleware moved to middleware/auth.js and
// middleware/rbac.js (requireAdmin/requireRole/requireRoleForInquiryEmail). Admin-user management
// (VALID_ADMIN_ROLES/countOtherActiveAdministrators/createAndSendInvite) moved to lib/admin-users.js.
// None of these five has a remaining caller here — all their call sites (the admin-users routes,
// and every admin route that used requireAdmin/requireRole as middleware) moved out with the
// routes, each importing directly from the relevant module.

// ════════════════════════════════════════════════════════════════════════════
// ANALYTICS — first-party visitor tracking + dashboard endpoints
// ════════════════════════════════════════════════════════════════════════════

// Phase 5 (HOUSEKEEPING-NOTES.md): classifyChannel moved to routes/public/misc.js as a
// single-consumer local alongside its only caller, POST /api/public/analytics/track.

// getAnalyticsDates moved to routes/admin/analytics.js — its only caller.










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









// ==========================================
// Nodemailer Email Route
// Integrated Email Service (from ./js/emailService)
// ==========================================

// ==========================================
// Email Service Functions
// ==========================================

// EMAIL-1: HTML-escape user-controlled free-text before it is interpolated into email HTML,
// Phase 5 (HOUSEKEEPING-NOTES.md): escapeEmailHtml/EMAIL_ESCAPE_FIELDS/escapeEmailFields moved to
// lib/email-escape.js.
const { escapeEmailFields } = require('./lib/email-escape');

// Phase 5 (HOUSEKEEPING-NOTES.md): moved to lib/html-sanitize.js, alongside unescapeHtml/
// sanitizeAboutHtml/SECTION_KEYS (same file, all pure content-sanitization helpers). None of those
// has a remaining caller in app.js — their call sites (GET /api/public/about-me and GET
// /api/public/site-content, plus /send-email for encodeUserHtml) moved out, each importing
// directly from lib/html-sanitize.js.

// Phase 5 (HOUSEKEEPING-NOTES.md): moved to lib/email-context.js. getEmailFooterContext is still
// called directly from app.js (the surviving background cron jobs' emails); emailBaseUrl has no
// remaining caller here — its call sites moved out with their routes, each importing it directly.
const { getEmailFooterContext } = require('./lib/email-context');

// Phase 5 (HOUSEKEEPING-NOTES.md): sendBookingReceivedEmail moved to lib/booking-notifications.js
// — its only remaining caller (the public booking-intake route) moved with it, so app.js has no
// reason to re-import it.

// S2-1: Notify client when their booking moves to PENDING (under review)
// Phase 5 (HOUSEKEEPING-NOTES.md): generateBookingICS/sendQuoteEmail/sendAdminQuoteSentNotification/
// sendBookingConfirmedEmail/sendDepositBalanceDueEmail/sendQuoteExpiryWarningEmail/
// sendReviewRequestEmail/remindBooking/sendDateChangedEmail/sendBookingUnderReviewEmail/
// sendPaymentReceivedEmail/sendPaidReceiptEmail/sendBookingCompletedEmail/
// sendAdminPaymentNotification/sendAdminCompletionSummaryEmail/sendRefundProcessedEmail/
// sendInvoiceEmail (lib/invoice-email.js) all moved out. Now that the PayFast ITN webhook has also
// moved to routes/public/payment.js (which imports directly whichever of these it needs), only the
// 6 background cron jobs' calls below are still real remaining callers in app.js:
// sendDepositBalanceDueEmail, sendQuoteExpiryWarningEmail, sendReviewRequestEmail,
// sendBookingUnderReviewEmail, sendBookingCompletedEmail, sendAdminCompletionSummaryEmail.
const {
    sendDepositBalanceDueEmail, sendQuoteExpiryWarningEmail, sendReviewRequestEmail,
    sendBookingUnderReviewEmail, sendBookingCompletedEmail, sendAdminCompletionSummaryEmail
} = require('./lib/booking-notifications');


// S2-2: Notify all admin users when a quote has been dispatched to a client

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

// Pre-event logistics reminder — a friendly countdown, not a payment nudge (that's the separate
// balance-due reminder). Mirrors sendInvoicePreDueEmail's structure.
async function sendEventReminderEmail(booking, daysBefore) {
    booking = escapeEmailFields(booking);
    const { id, name, email, event_name, event_type, date, event_location } = booking;

    const { socialLinks } = await getEmailFooterContext();
    const banner = await bannerRegistry.resolveBanner('event_reminder');
    const html = emailComponents.renderPremiumEmail({
        preheaderText: `Your event is in ${daysBefore} day${daysBefore !== 1 ? 's' : ''} — ${event_name || event_type}.`,
        bannerSrc: banner?.src, bannerAlt: banner?.alt, subtitle: banner?.subtitle,
        headline: banner?.headline || 'Your Event Is Coming Up',
        greeting: `Hi ${name},`,
        bodyHtml:
            `Just a friendly reminder that <strong style="color:#FAFAFA;">${event_name || event_type}</strong> is coming up in <strong style="color:#D4AF37;">${daysBefore} day${daysBefore !== 1 ? 's' : ''}</strong>! We're looking forward to it.` +
            `<p style="margin:10px 0 0; color:#B0B0B0; font-size:12px;">If anything about your booking has changed, just reply to this email. (Booking reference #${id})</p>`,
        cards: [{
            title: 'Event Details',
            rows: [
                { label: 'Event', value: event_name || event_type },
                { label: 'Date', value: date },
                { label: 'Venue', value: event_location || 'TBD' }
            ]
        }],
        socialLinks
    });

    const result = await sendEmail({
        to: email,
        subject: `Your Event Is in ${daysBefore} Day${daysBefore !== 1 ? 's' : ''} — ${event_name || event_type} (Booking #${id})`,
        htmlContent: html,
        preWrapped: true,
        titleOverride: 'Your Event Is Coming Up',
        trigger_event: 'Booking: Event Reminder'
    });
    return result.success;
}

// Phase 5 (HOUSEKEEPING-NOTES.md): sendContractEmail (single-consumer) moved into
// routes/admin/bookings.js alongside the contract/send route.

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
// Phase 5 (HOUSEKEEPING-NOTES.md): sendQuoteAcceptedEmail moved to lib/booking-notifications.js —
// see the require near the top of this file for the re-import.

// Phase 5 (HOUSEKEEPING-NOTES.md): sendCancellationEmail moved to lib/booking-cancellation-email.js.
// No remaining caller in app.js — its two call sites (applyStatusChange and POST .../cancel) both
// moved to lib/booking-status.js / routes/admin/bookings.js, each importing it directly.

// Phase 5 (HOUSEKEEPING-NOTES.md): sendPaymentReceivedEmail/sendPaidReceiptEmail/
// sendBookingCompletedEmail moved to lib/booking-notifications.js — see the require near the top
// of this file for the re-import.

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

// Phase 5 (HOUSEKEEPING-NOTES.md): sendPaymentFailedEmail moved to routes/public/payment.js as a
// single-consumer local alongside its only caller, the PayFast ITN webhook.


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


// ==========================================
// Phase 5 (HOUSEKEEPING-NOTES.md): moved to lib/db-helpers.js — used pervasively (~190 call
// sites) by business logic not owned by any single Phase 4 domain repository. Now that every
// route touching the shared connection has moved out (each importing dbRun/dbGet/dbAll directly
// where it still needs them), none of the three has a remaining caller in app.js.

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
// to other guarded sections.
// Phase 5 (HOUSEKEEPING-NOTES.md): moved to lib/db-transaction.js — MUST stay a singleton (see
// that file's header comment), so route files import the exact same module rather than each
// getting their own dbTxnQueue. No remaining caller in app.js — the public booking intake (the
// first, and only, `BEGIN TRANSACTION` site to migrate onto this helper) moved out with its route.

// "Last Updated By" feature — shared audit/actor helpers.
// ============================================================

// Phase 5 (HOUSEKEEPING-NOTES.md): resolveActor moved to lib/actor.js, logAudit to
// lib/audit-log.js. Neither has a remaining caller in app.js — their only call site
// (applyStatusChange) moved to lib/booking-status.js, which imports both directly.

// Phase 5 (HOUSEKEEPING-NOTES.md): the entire POPIA/GDPR erasure subsystem — resolvePopiaTargets,
// anonymizeClientData, and the request-lifecycle block further below (POPIA_REASONS through
// notifyPopiaCancellations) — moved to lib/popia.js (batch 14). The public self-service routes that
// used to re-import resolvePopiaTargets/getBookingErasureImpact/createPopiaRequest/POPIA_REASONS
// here (POST /api/public/popia/preview, /erasure-requests, and the legacy
// /api/public/compliance/request-forget) have all since moved to routes/public/popia.js, which
// imports these four directly — no remaining caller here.

// anonymizeClientData(email) also moved to lib/popia.js as part of the same relocation — it has
// no caller left in app.js (only lib/popia.js's own processPopiaRequest/completePopiaAnonymization
// call it), so it is not re-imported here.

// Phase 5 (HOUSEKEEPING-NOTES.md): BOOKING_TEXT_LIMITS moved to routes/public/bookings.js —
// single-consumer (the booking-intake route moved with it).

// Phase 5 (HOUSEKEEPING-NOTES.md): asBookingText moved to lib/booking-tracking.js, alongside the
// tracker OTP helpers/constants it's grouped with there. No remaining caller in app.js.


// ============================================================================
// BOOKING RECOVERY — abandoned booking drafts (abandoned-cart style)
//  • Public: autosave drafts, resume a draft, opt out of reminders.
//  • Admin:  list / stats / export / detail / manual resend / status.
//  • Reminder + purge jobs live near the other scheduled jobs (end of file).
//  POPIA: capture is minimised to email-present drafts, auto-emails are
//  consent-gated, every reminder carries an opt-out link, and stale rows are
//  purged after 30 days.
// ============================================================================

// Phase 5 (HOUSEKEEPING-NOTES.md): estimateDraftValue moved to routes/public/bookings.js —
// single-consumer (the draft-autosave route moved with it).

// Branded recovery reminder email with a one-click resume link + opt-out.
// Phase 5 (HOUSEKEEPING-NOTES.md): sendAbandonedBookingReminderEmail moved to
// lib/abandoned-booking-email.js.
const { sendAbandonedBookingReminderEmail } = require('./lib/abandoned-booking-email');



// Phase 5 (HOUSEKEEPING-NOTES.md): _abOptOutPage moved to routes/public/bookings.js —
// single-consumer (both opt-out routes moved with it).









// Phase 5 (HOUSEKEEPING-NOTES.md): generatePayFastSignature moved to lib/payfast-signature.js —
// shared by the public pay route and the PayFast ITN webhook, both of which have since moved to
// routes/public/payment.js, which imports it directly. No remaining caller in app.js.


















// P3-8: Helper to calculate refund based on policy.
// Reads thresholds from policyStr JSON ({tiers:[{days_min,retention_pct,label},...]} sorted desc).
// Falls back to hardcoded 30/14/0-day tiers if no valid policy is provided.
// Phase 5 (HOUSEKEEPING-NOTES.md): calculateCancellationRefund moved to lib/cancellation-refund.js.
// No remaining caller in app.js — its two call sites (applyStatusChange and POST .../cancel) both
// moved to lib/booking-status.js / routes/admin/bookings.js, each importing it directly.







// Phase 5 (HOUSEKEEPING-NOTES.md): contractUpload (single-consumer) moved into
// routes/admin/bookings.js alongside the contract routes.

// Phase 5 (HOUSEKEEPING-NOTES.md): DEFAULT_CONTRACT_CLAUSES, CONTRACT_ELIGIBLE_STATUSES,
// resolveContractFeeData, assembleContractHtml, and generateContract all moved to lib/contracts.js.
// None has a remaining caller in app.js — the contract routes moved to routes/admin/bookings.js,
// which imports directly whichever of these it needs.



















// Phase 5 (HOUSEKEEPING-NOTES.md): the public newsletter subscribe/confirm/unsubscribe routes,
// NEWSLETTER_PENDING_MESSAGE, and sendNewsletterConfirmationEmail all moved to
// routes/public/newsletter.js. sendNewsletterWelcomeEmail (lib/newsletter-emails.js) has no
// remaining caller here — its only call site (newsletter/confirm) moved too, and imports it
// directly.



















// --- Newsletter Scheduling ---

function loadPendingScheduledJobs() {
    // Fetch ALL pending rows and partition future-vs-overdue in JS rather than filtering with SQL's
    // `scheduled_at > datetime('now')` — that comparison is a byte-for-byte TEXT compare, and
    // scheduled_at is stored as an ISO instant ("...T06:25:42.296Z") while datetime('now') returns
    // "...08:25:42" (space, no T) — 'T' (0x54) sorts after ' ' (0x20) at that byte offset
    // UNCONDITIONALLY, so the old SQL filter treated every same-day-overdue row as "still pending"
    // and handed it to scheduleNewsletterSend(), which then silently dropped it via its own
    // fireDate <= new Date() guard. This table is low-volume (one comedian's newsletter, not a
    // mass-mailer), so fetching everything and partitioning in JS is simpler and correct.
    getPendingScheduledNewsletters((err, rows) => {
        if (err) return console.error('Failed to load scheduled jobs:', err);
        let recovered = 0;
        rows.forEach(row => {
            const rawDt = row.scheduled_at;
            const fireDate = new Date(rawDt.includes('T') ? rawDt : rawDt.replace(' ', 'T') + 'Z');
            if (isNaN(fireDate.getTime())) return; // corrupt row — leave for manual review, don't guess
            if (fireDate.getTime() <= Date.now()) {
                recovered++;
                scheduleNewsletterSend(row, { fireImmediately: true });
            } else {
                scheduleNewsletterSend(row);
            }
        });
        if (recovered > 0) console.log(`[Newsletter] Recovering ${recovered} overdue scheduled campaign(s) after restart`);
    });
}




// ==========================================
// Newsletter — Birthday Automation (Phase 3)
// ==========================================
// Phase 5 (HOUSEKEEPING-NOTES.md): moved to lib/newsletter-birthday.js. registerBirthdayJob() is
// still called here, at the same module-load-time position, to register the initial cron job on
// startup — only the function bodies moved, not this call site. Nothing else in this file still
// references BIRTHDAY_SETTING_DEFAULTS/KEYS, mergeBirthdayOverrides, getBirthdaySettings,
// renderBirthdayEmail, or runBirthdayAutomationSweep — every other call site moved to
// routes/admin/newsletter-campaigns.js.
const { registerBirthdayJob } = require('./lib/newsletter-birthday');
registerBirthdayJob();








































































































// =========================================================================
// --- Direct Emails Upgrade: Scheduled sends and drafts ---
// =========================================================================

// Phase 5 (HOUSEKEEPING-NOTES.md): scheduleDirectEmailSend/sendDirectEmail moved to
// lib/direct-emails.js.
const { scheduleDirectEmailSend, sendDirectEmail } = require('./lib/direct-emails');

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




















// --- Custom Error Handling ---
// Phase 5 (HOUSEKEEPING-NOTES.md): moved to middleware/error-handler.js. __dirname here is still
// the project root (app.js sits where server.js used to), so passing it through keeps error.html's
// path resolving exactly as before.
const { createNotFoundHandler, createServerErrorHandler } = require('./middleware/error-handler');
// 404 - Not Found
app.use(createNotFoundHandler(__dirname));

// 500 - Server Error
app.use(createServerErrorHandler(__dirname));


// Start Data Retention Check
setTimeout(() => {
    countAllAdmins((err, row) => {
        if (row && row.count === 0) {
            const generatedPassword = crypto.randomBytes(8).toString('hex'); // 16 chars
            const defaultEmail = 'admin@thabisomhlongo.com';
            bcrypt.hash(generatedPassword, 10, (err, hash) => {
                if (!err) {
                    insertBootstrapAdmin('admin', defaultEmail, hash, (err) => {
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

// Phase 5 (HOUSEKEEPING-NOTES.md): runPaymentReminderJob moved to lib/payment-reminders.js.
const { runPaymentReminderJob } = require('./lib/payment-reminders');

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
        getBookingsForQuoteFollowUp(cutoffStr, (err, rows) => resolve(err ? [] : (rows || [])))
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
                markQuoteFollowUpSent(b.id);
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
            const existing = await new Promise(resolve => findActiveBookingByEmailAndDate(d.email, d.event_date, (e, row) => resolve(row)));
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
        getBookingsForDepositBalanceReminder(targetDate, (err, rows) => resolve(err ? [] : (rows || [])))
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
            markDepositBalanceReminded(b.id);
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
            markInvoicePreDueReminded(inv.id);
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

// Pre-event reminder — a logistics/countdown nudge for every CONFIRMED booking 3 days before its
// event, regardless of payment status (that's the separate balance-due reminder's job). Mirrors
// runInvoicePreDueReminderJob's exact-date-match + dedup-column pattern.
async function runEventReminderJob() {
    const daysBefore = 3;
    const targetDate = new Date();
    targetDate.setDate(targetDate.getDate() + daysBefore);
    const targetStr = targetDate.toISOString().split('T')[0];

    const bookings = await new Promise(resolve =>
        getConfirmedBookingsOnDate(targetStr, (err, rows) => resolve(err ? [] : (rows || [])))
    );

    let sent = 0, errors = 0;
    for (const b of bookings) {
        try {
            await sendEventReminderEmail(b, daysBefore);
            markEventReminderSent(b.id);
            sent++;
            console.log(`[Event Reminder] Sent to booking #${b.id} (${b.email})`);
        } catch (e) {
            console.error(`[Event Reminder] Failed for booking #${b.id}:`, e.message);
            errors++;
        }
    }
    console.log(`[Event Reminder Job] Done — sent: ${sent}, errors: ${errors}`);
}

setTimeout(() => {
    runEventReminderJob().catch(err => console.error('[Event Reminder Job] Startup run failed:', err.message));
    setInterval(() => {
        runEventReminderJob().catch(err => console.error('[Event Reminder Job] Scheduled run failed:', err.message));
    }, 24 * 60 * 60 * 1000);
}, 44000);

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
            markInvoiceOverdueReminded(inv.id);
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
    // Bug fix: this previously selected c.name/b.client_name and c.email/b.client_email — none of
    // which exist (bookings.name/email are the real columns; clients has full_name, not name). The
    // query threw "no such column" on every run, silently swallowed by the resolve(err ? [] : ...)
    // below, so this job — the only automatic trigger for review-request emails — never fired.
    const bookings = await new Promise(resolve => {
        getCompletedBookingsAwaitingReview((err, rows) => { if (err) console.error('[Post-Event Followup] query failed:', err.message); resolve(err ? [] : (rows || [])); });
    });

    let sent = 0, errors = 0;
    for (const b of bookings) {
        try {
            // Send the review request (function already exists)
            await sendReviewRequestEmail(b);
            stampReviewEmailSent(b.id);
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

// Phase 5 (HOUSEKEEPING-NOTES.md): server.js is now the process entry point — it requires this
// module and calls app.listen() itself. loadPendingScheduledJobs/loadPendingDirectEmails are
// exported alongside app because server.js's listen callback (moved there verbatim) calls them.
module.exports = { app, loadPendingScheduledJobs, loadPendingDirectEmails };
