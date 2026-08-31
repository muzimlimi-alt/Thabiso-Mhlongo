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
// Phase 4 (HOUSEKEEPING-NOTES.md): settings-domain data access moved to a repository. getAllSettings
// is still used by the startup settings-load block below; getNotificationEmail's last remaining
// callers in this file (the Background Clerk sweep and 2 of the standalone job functions) have all
// since moved to their own lib/*.js files (Phase 5), each importing it directly — no remaining
// caller here.
const { getAllSettings } = require('./database/repositories/settings.repository');
// Phase 4: newsletter-domain data access moved to a repository — same destructure-in pattern.
// getPendingScheduledNewsletters's only caller (loadPendingScheduledJobs) moved to
// lib/newsletter-scheduling.js, which imports it directly; deleteOldUnsubscribedSubscribers's only
// caller (startDataRetentionCaretaker) moved to lib/data-retention-caretaker.js, same pattern —
// no remaining caller here.
// Phase 4: inquiries-domain data access moved to a repository — same destructure-in pattern.
// anonymizeOldInquiries's only caller (startDataRetentionCaretaker) moved to
// lib/data-retention-caretaker.js, which imports it directly — no remaining caller here.

// Phase 4: bookings-domain data access moved to a repository (staged extraction — see
// HOUSEKEEPING-NOTES.md for the sub-pass plan). Every name that used to be destructured here
// (getBookingById and the 14 S0/S6/S7/expiry/reminder helpers) had its only remaining caller in
// the Background Clerk's hourly sweep or the standalone job functions — all moved to their own
// lib/*.js files (Phase 5), each importing directly whichever of these it still needs. No
// remaining caller here.

// Phase 4: invoices+quotations-domain data access moved to a repository (HOUSEKEEPING-NOTES.md).
// markInvoicePaidForAutoComplete and flagOverdueInvoices both had their only remaining caller move
// to lib/background-clerk.js / lib/overdue-flagging-sweep.js respectively — no remaining caller here.

// Phase 4: finance-domain data access moved to a repository (HOUSEKEEPING-NOTES.md).
// flagOverduePaymentSchedules's only remaining caller moved to lib/overdue-flagging-sweep.js,
// which imports it directly — no remaining caller here.

// Phase 4: calendar-domain (date_holds, events) data access moved to a repository
// (HOUSEKEEPING-NOTES.md). advanceAutoCompletedEventS6/getPastStandaloneEventsForAutoComplete/
// advanceStandaloneEventCompleted's only remaining caller (the Background Clerk sweep) moved to
// lib/background-clerk.js, which imports all three directly — no remaining caller here.

// Phase 4: auth+users-domain (admins, admin_login_logs, password_reset_tokens) data access moved
// to a repository (HOUSEKEEPING-NOTES.md). countAllAdmins/insertBootstrapAdmin are still used by
// the bootstrap-admin startup check below.
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
// scheduleNewsletterSend, itself in that same module). scheduleNewsletterSend's own last remaining
// caller (loadPendingScheduledJobs) has since moved into the same module — loadPendingScheduledJobs
// is re-imported here only to re-export it below for server.js; nothing in app.js calls
// scheduleNewsletterSend directly any more.
const { loadPendingScheduledJobs } = require('./lib/newsletter-scheduling');

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
// along with them — their subject functions no longer live in this file.) syncCalendarHolds's own
// last remaining caller (the nightly hold-sync interval) has since moved to
// lib/background-clerk.js, which imports it directly — none of the six has a remaining caller in
// app.js any more.

// Phase 5 (HOUSEKEEPING-NOTES.md): deleteGoogleEvent moved to lib/google-calendar.js, alongside
// the calendar client it wraps. Its last remaining caller (the Background Clerk sweep) has since
// moved to lib/background-clerk.js, which imports it directly — no remaining caller here.


// Single-flight guard: a batch (attachments / slow SMTP) can take longer than the 20s
// setInterval, and two overlapping sweeps would double-send the same 'pending' rows. We serialize
// in-process because an intra-DB claim isn't available — the notifications.status CHECK constraint
// only permits ('pending','sent','failed','read','dismissed'), so the previous
// `SET status='sending'` flip always failed the CHECK (its error was ignored), leaving the
// double-send guard non-functional and sent_at never written.
// Phase 5 (HOUSEKEEPING-NOTES.md): processNotificationQueue, checkStuckNotifications, and
// startBackgroundClerk (which wires both, plus the Google Calendar hold sync and the giant hourly
// booking-lifecycle sweep, onto their intervals) all moved to lib/background-clerk.js — they share
// the _notificationSweepRunning single-flight guard and startBackgroundClerk calls the other two
// directly, so all three moved together. See further below for the startBackgroundClerk() call,
// at the same module-load-time position it always sat at.

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

// Phase 5 (HOUSEKEEPING-NOTES.md): checkStuckNotifications and startBackgroundClerk moved to
// lib/background-clerk.js alongside processNotificationQueue (see the comment above). Called once
// here, at the same module-load-time position.
const { startBackgroundClerk } = require('./lib/background-clerk');
startBackgroundClerk();

// Phase 5 (HOUSEKEEPING-NOTES.md): startDataRetentionCaretaker moved to
// lib/data-retention-caretaker.js. Called once here, at the same module-load-time position.
const { startDataRetentionCaretaker } = require('./lib/data-retention-caretaker');
startDataRetentionCaretaker();

// Quote expiry lives in step 2 of the hourly Background Clerk cron (lib/background-clerk.js), which
// flips QUOTED → EXPIRED *and* emails the client *and* releases the Google Calendar event.
//
// A second sweep used to live here. It ran at module load — i.e. on every single server start — and
// flipped QUOTED → EXPIRED with no email and no calendar cleanup. Because the hourly cron only
// matches `status = 'QUOTED'`, anything this sweep had already expired became invisible to it, so the
// client was never told their quote had lapsed. Removed; the hourly cron is the sole owner.

// Phase 5 (HOUSEKEEPING-NOTES.md): runDailyOverdueFlaggingSweep (Phase 4) moved to
// lib/overdue-flagging-sweep.js, alongside its own immediate-run + schedule.scheduleJob wiring,
// wrapped into registerOverdueFlaggingSweep() to match every other scheduled job's convention.
// Called once here, at the same module-load-time position the inline pair used to sit at.
const { registerOverdueFlaggingSweep } = require('./lib/overdue-flagging-sweep');
registerOverdueFlaggingSweep();

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










// Phase 5 (HOUSEKEEPING-NOTES.md): the daily analytics roll-up (runs at 00:06 each day, staggered
// after the 00:05 overdue-flagging sweep) moved to lib/analytics-daily-rollup.js, wrapped into
// registerAnalyticsDailyRollup() to match every other scheduled job's convention. Called once
// here, at the same module-load-time position the inline schedule.scheduleJob(...) used to sit at.
const { registerAnalyticsDailyRollup } = require('./lib/analytics-daily-rollup');
registerAnalyticsDailyRollup();









// ==========================================
// Nodemailer Email Route
// Integrated Email Service (from ./js/emailService)
// ==========================================

// ==========================================
// Email Service Functions
// ==========================================

// EMAIL-1: HTML-escape user-controlled free-text before it is interpolated into email HTML,
// Phase 5 (HOUSEKEEPING-NOTES.md): escapeEmailHtml/EMAIL_ESCAPE_FIELDS/escapeEmailFields moved to
// lib/email-escape.js. escapeEmailFields's last remaining callers in this file (the 5 email
// helpers that used to sit here) moved to lib/scheduled-job-emails.js, which imports it directly —
// no remaining caller in app.js.

// Phase 5 (HOUSEKEEPING-NOTES.md): moved to lib/html-sanitize.js, alongside unescapeHtml/
// sanitizeAboutHtml/SECTION_KEYS (same file, all pure content-sanitization helpers). None of those
// has a remaining caller in app.js — their call sites (GET /api/public/about-me and GET
// /api/public/site-content, plus /send-email for encodeUserHtml) moved out, each importing
// directly from lib/html-sanitize.js.

// Phase 5 (HOUSEKEEPING-NOTES.md): moved to lib/email-context.js. getEmailFooterContext's last
// remaining callers in this file (the same 5 email helpers) moved to lib/scheduled-job-emails.js,
// which imports it directly; emailBaseUrl's call sites moved out with their routes even earlier.
// Neither has a remaining caller in app.js.

// Phase 5 (HOUSEKEEPING-NOTES.md): sendBookingReceivedEmail moved to lib/booking-notifications.js
// — its only remaining caller (the public booking-intake route) moved with it, so app.js has no
// reason to re-import it.

// S2-1: Notify client when their booking moves to PENDING (under review)
// Phase 5 (HOUSEKEEPING-NOTES.md): generateBookingICS/sendQuoteEmail/sendAdminQuoteSentNotification/
// sendBookingConfirmedEmail/sendDepositBalanceDueEmail/sendQuoteExpiryWarningEmail/
// sendReviewRequestEmail/remindBooking/sendDateChangedEmail/sendBookingUnderReviewEmail/
// sendPaymentReceivedEmail/sendPaidReceiptEmail/sendBookingCompletedEmail/
// sendAdminPaymentNotification/sendAdminCompletionSummaryEmail/sendRefundProcessedEmail/
// sendInvoiceEmail (lib/invoice-email.js) all moved out. The remaining 5
// (sendDepositBalanceDueEmail/sendQuoteExpiryWarningEmail/sendBookingUnderReviewEmail/
// sendBookingCompletedEmail/sendAdminCompletionSummaryEmail) had their last real caller — the
// Background Clerk's hourly sweep — move to lib/background-clerk.js, which imports all 5 directly.
// No remaining caller in app.js.

// S2-2: Notify all admin users when a quote has been dispatched to a client

// Phase 5 (HOUSEKEEPING-NOTES.md): sendInvoicePreDueEmail/sendEventReminderEmail/
// sendOverdueInvoiceEmail/sendQuoteExpiredEmail/sendPendingExpiredEmail — the 5 email helpers used
// only by the background scheduled-job functions — moved to lib/scheduled-job-emails.js. All 5 now
// have their only remaining caller in one of the lib/*.js job files, each importing directly
// whichever it needs (sendQuoteExpiredEmail/sendPendingExpiredEmail's last caller, the Background
// Clerk sweep, moved to lib/background-clerk.js). No remaining caller in app.js.

// Phase 5 (HOUSEKEEPING-NOTES.md): sendContractEmail (single-consumer) moved into
// routes/admin/bookings.js alongside the contract/send route.

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

// Phase 5 (HOUSEKEEPING-NOTES.md): sendPaymentFailedEmail moved to routes/public/payment.js as a
// single-consumer local alongside its only caller, the PayFast ITN webhook.


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
// lib/abandoned-booking-email.js. Its last remaining caller in this file (runAbandonedBookingReminderJob)
// has since moved to lib/abandoned-booking-jobs.js, which imports it directly — no remaining
// caller in app.js.



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



















// Phase 5 (HOUSEKEEPING-NOTES.md): loadPendingScheduledJobs moved to lib/newsletter-scheduling.js,
// alongside scheduleNewsletterSend and getPendingScheduledNewsletters it calls — re-imported below
// (see the require near scheduleNewsletterSend) and re-exported at the bottom of this file, since
// server.js still calls it directly from its own app.listen() callback.




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
// lib/direct-emails.js. loadPendingDirectEmails (their only remaining caller here) moved with
// them, into the same file — re-imported below and re-exported at the bottom of this file, since
// server.js still calls it directly from its own app.listen() callback. Neither
// scheduleDirectEmailSend nor sendDirectEmail has a remaining caller in app.js any more.
const { loadPendingDirectEmails } = require('./lib/direct-emails');




















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

// Phase 5 (HOUSEKEEPING-NOTES.md): runPaymentReminderJob moved to lib/payment-reminders.js in an
// earlier batch; its startup/scheduling wiring (a bare setTimeout+setInterval, previously still
// inline here) has now been wrapped into that same module's registerPaymentReminderJob(), matching
// every other scheduled job's convention.
const { registerPaymentReminderJob } = require('./lib/payment-reminders');
registerPaymentReminderJob();

// Phase 5 (HOUSEKEEPING-NOTES.md): runQuoteFollowUpJob (S2-6) moved to lib/quote-follow-up-job.js,
// runStalledBookingAdminAlertJob (S3) to lib/stalled-booking-alert-job.js,
// runAbandonedBookingReminderJob/runAbandonedBookingPurgeJob (Booking Recovery) to
// lib/abandoned-booking-jobs.js, and runDepositBalanceReminderJob (S4-1) to
// lib/deposit-balance-reminder-job.js — each byte-identical, alongside its own startup/scheduling
// wiring, exporting a registerXJob() called once here at the same module-load-time position.
const { registerQuoteFollowUpJob } = require('./lib/quote-follow-up-job');
registerQuoteFollowUpJob();
const { registerStalledBookingAlertJob } = require('./lib/stalled-booking-alert-job');
registerStalledBookingAlertJob();
const { registerAbandonedBookingJobs } = require('./lib/abandoned-booking-jobs');
registerAbandonedBookingJobs();
const { registerDepositBalanceReminderJob } = require('./lib/deposit-balance-reminder-job');
registerDepositBalanceReminderJob();

// Phase 5 (HOUSEKEEPING-NOTES.md): runInvoicePreDueReminderJob (S4-2) moved to
// lib/invoice-pre-due-reminder-job.js, runEventReminderJob to lib/event-reminder-job.js,
// runOverdueInvoiceSweepJob (S4-3) to lib/overdue-invoice-sweep-job.js, runPostEventFollowupJob
// (S6-1) to lib/post-event-followup-job.js, runLedgerReconciliationJob (P2-10) to
// lib/ledger-reconciliation-job.js, and runPayFastPendingTimeoutJob (P3-14) to
// lib/payfast-pending-timeout-job.js — each byte-identical, alongside its own startup/scheduling
// wiring, exporting a registerXJob() called once here at the same module-load-time position.
const { registerInvoicePreDueReminderJob } = require('./lib/invoice-pre-due-reminder-job');
registerInvoicePreDueReminderJob();
const { registerEventReminderJob } = require('./lib/event-reminder-job');
registerEventReminderJob();
const { registerOverdueInvoiceSweepJob } = require('./lib/overdue-invoice-sweep-job');
registerOverdueInvoiceSweepJob();
const { registerPostEventFollowupJob } = require('./lib/post-event-followup-job');
registerPostEventFollowupJob();
const { registerLedgerReconciliationJob } = require('./lib/ledger-reconciliation-job');
registerLedgerReconciliationJob();
const { registerPayFastPendingTimeoutJob } = require('./lib/payfast-pending-timeout-job');
registerPayFastPendingTimeoutJob();

// C9: Prevent sandbox PayFast config from silently disabling payment validation in production
if (process.env.NODE_ENV === 'production' && (process.env.PAYFAST_URL || '').includes('sandbox')) {
    console.error('🚨 STARTUP ABORTED: PAYFAST_URL contains "sandbox" while NODE_ENV is "production". Payment signature and IP validation are disabled. Fix .env before restarting.');
    process.exit(1);
}

// Phase 5 (HOUSEKEEPING-NOTES.md): server.js is now the process entry point — it requires this
// module and calls app.listen() itself. loadPendingScheduledJobs/loadPendingDirectEmails are
// exported alongside app because server.js's listen callback (moved there verbatim) calls them.
module.exports = { app, loadPendingScheduledJobs, loadPendingDirectEmails };
