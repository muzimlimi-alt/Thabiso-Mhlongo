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
const { applyMergeFields } = require('./js/mergeFields');
const { SAMPLES_BY_CATEGORY } = require('./js/emailPreviewSamples');
const { imageSize } = require('image-size');
const crypto = require('crypto');
const PDFDocument = require('pdfkit');
const db = require('./database');
const pdfService = require('./js/pdfService');
// Phase 4 (HOUSEKEEPING-NOTES.md): settings-domain data access moved to a repository. Destructured
// here so every existing call site throughout this file keeps working unchanged.
const {
    getAllSettings, getNotificationEmail, getSettingsByKeys, getBirthdaySettings: repoGetBirthdaySettings,
    getMinBookingGapSetting, getTypeBuffersSetting, saveMinBookingGapMinutes, saveTypeBuffers,
    upsertSettingWithConflictClause, upsertSetting, getSettingVal,
} = require('./database/repositories/settings.repository');
// Phase 4: newsletter-domain data access moved to a repository — same destructure-in pattern.
const {
    insertPendingSubscriber, getSubscriberDuplicateCheck, touchSubscriberCooldown, reactivateSubscriber,
    getSubscriberForConfirm, confirmSubscriber, getSubscriberForUnsubscribe, unsubscribeSubscriber,
    countSubscribers, listSubscribers, getSubscriberStats, insertSubscriberManual, updateSubscriberProfile,
    getSubscriberForStatusToggle, updateSubscriberStatus, deleteSubscriber, bulkUpdateSubscriberStatus,
    bulkConfirmPendingSubscribers, getPendingSubscribersForBulkActivate, bulkDeleteSubscribers,
    updateSubscriberFromCsvRow, insertSubscriberFromCsvRow,
    insertDraft, updateDraft, listDrafts, getDraft, deleteDraft,
    getPendingScheduledNewsletters, claimScheduledNewsletterForSending, getActiveSubscribersForSegment,
    markScheduledNewsletterFailed, markScheduledNewsletterSkipped, markScheduledNewsletterSent, insertCampaignLog,
    insertScheduledNewsletter, getScheduledNewsletterById, listScheduledNewsletters,
    getScheduledNewsletterAttachmentsIfPending, cancelScheduledNewsletter, updateScheduledNewsletter,
    getAudienceCount,
    getSubscriberBirthdayFields, getSubscribersWithBirthdayToday,
    deleteCampaign, countUnifiedCampaigns, listUnifiedCampaigns, bulkDeleteCampaigns,
    getScheduledAttachmentsForIds, bulkDeleteScheduled,
    deleteOldUnsubscribedSubscribers, deleteSubscriberForErasure,
} = require('./database/repositories/newsletter.repository');
// Phase 4: inquiries-domain data access moved to a repository — same destructure-in pattern.
const {
    anonymizeOldInquiries, getInquiryIdsForEmail, anonymizeInquiriesForErasure, redactInquiryNotesForErasure,
    countInquiryNotesForIds, getInquiriesForEmail, insertInquiry, linkInquiryToBooking, markInquiryReplied,
    countInquiries, countInquiriesByStatus, countMyInquiries,
    updateInquiryStatus, unassignInquiry, assignInquiry, updateInquiryPriority, listInquiryCategories, updateInquiryCategory,
    listInquiryNotes, insertInquiryNote, getInquiryNoteById, deleteInquiryNote,
    bulkUpdateInquiryStatus, bulkDeleteInquiries, deleteInquiry,
} = require('./database/repositories/inquiries.repository');
// Phase 4: bookings-domain data access moved to a repository (staged extraction — see
// HOUSEKEEPING-NOTES.md for the sub-pass plan; this import grows as later stages land).
const {
    getBookingById, getBookingByIdAsync,
    getBookingsTrend, stampReviewEmailSent, unlinkBookingClient, getBookingTotalAmount,
    getOutstandingTotal, getBookingStatusCounts,
    getStaleNewBookings, promoteBookingToPending, getConfirmedPaidPastEvents, markBookingAutoCompleted,
    getStalePendingBookings, expirePendingBooking, getOverdueQuotedBookings, expireQuotedBooking,
    clearBookingGoogleEventId, getQuotesExpiringTomorrow, markQuoteExpiryWarned,
    getPendingEnquiriesNearingExpiry, markPendingExpiryWarned, markBookingOverdueReminded,
    getBookingsForQuoteFollowUp, markQuoteFollowUpSent, findActiveBookingByEmailAndDate,
    getBookingsForDepositBalanceReminder, markDepositBalanceReminded,
    getConfirmedBookingsOnDate, markEventReminderSent, getCompletedBookingsAwaitingReview,
    getActiveDuplicateBookingForEmailDate, getActiveDuplicateBookingForEmailDateAsync, insertAdminBooking,
    getBookingStatusNameEmail, reopenBooking, markBookingCompletedManual,
    updateBookingBuffer, getBookingDisposition, updateBookingDisposition, markBookingPendingAfterRespond,
    insertLegacyBookingFromContactForm, getAllBookingsForMigration, getAllBookingsFull,
    updateBookingClientVenue, deleteBookingById,
    setBookingClientId, updateBookingLedgerAfterInvoice,
    insertBookingLineItem, insertBookingService, getBookingStatus, getBookingForContractRemind,
    getBookingIdStatusAsync,
    getBookingsOnDateForHoldConflict,
    setBookingPublicWithNewEvent, setBookingPublicTicketLink, clearBookingPublicWithEvent, clearBookingPublicTicketLink,
    setBookingEventId,
    getBookingIdsForEmail, anonymizeBookingsForErasure, deleteBookingAccessCodesForErasure,
    deleteBookingAccessTokensForErasure, redactBookingNotesForErasure, countBookingNotesForIds,
    insertBookingNoteFromTracker,
    getBookingNotesForBooking, insertBookingNote, getBookingNoteById, deleteBookingNote,
    applyPayfastPaymentToBooking, markBookingPaymentFailedIfUnpaid,
    applyManualPaymentToBooking, getBookingForAutoEventOnPayment, getBookingAmountPaid,
    getBookingsByIds, cancelBookingForErasureAsync, clearBookingPublicAndEventIdAsync, clearBookingGoogleEventIdAsync,
    cancelBookingAsync, setBookingPaymentStatus, updateBookingLedgerFromReconcile,
    applyManualTransactionPaymentToBooking, updateBookingLedgerAfterManualRefund, updateBookingLedgerAfterAdjustment,
    getBookingOutstandingForCompleteGuard, updateBookingStatusCore, clearBookingPublicAndEventId,
    setBookingCancellationAttribution,
} = require('./database/repositories/bookings.repository');
// Phase 4: invoices+quotations-domain data access moved to a repository (HOUSEKEEPING-NOTES.md).
const {
    getInvoiceForPaidCheck, getActiveQuoteForInvoiceGen, getQuoteLineItems, getInvoiceNumberCollisionCount,
    voidSupersededInvoiceForRegen, insertInvoice, insertInvoiceLineItem, markInvoiceSent,
    markInvoicePaidForAutoComplete, markInvoicePaidOnStatusComplete,
    flagOverdueInvoices,
    getInvoiceForPaidReceipt,
    getInvoiceTaxAmountForBooking, getQuoteTaxAmountForBooking,
    getQuoteFilesForBookingIds, getQuoteFilesForClientIds, clearQuoteFilePathsForErasure, clearQuoteFilePathsForClientErasure,
    markInvoicePaidIfOpen, markInvoicePaidIfOpenAsync,
    getOpenInvoiceIdForReceiptCheck,
    voidInvoicesForCancelledBooking, voidInvoicesForCancelledBookingAsync,
    markQuotationAccepted, markQuotationAcceptedAsync, revertQuotationToSent,
    getActiveQuoteForContractFeeData,
    getLatestQuoteFileForResend, markQuotationResent,
    getQuoteHistoryForBooking, getActiveQuoteStatusForInvoiceGuard,
    getInvoiceFileForAdminDownload, getQuoteFileForAdminDownload,
    getQuoteForBookingFinancials, getInvoiceForBookingFinancials,
    getOpenInvoiceIdForAdjustmentRegen,
    countQuotationsForIds, countQuotationsForClientIds,
    markInvoicePreDueReminded, markInvoiceOverdueReminded,
    getInvoiceAgingSummary, getOverdueInvoicesSummary, getDueSoonInvoicesSummary,
} = require('./database/repositories/invoices-quotations.repository');
// Phase 4: finance-domain data access moved to a repository (HOUSEKEEPING-NOTES.md).
const {
    getLivePaymentScheduleCount, getPaidPaymentScheduleSum, insertPaymentScheduleMilestone,
    getPaymentSchedulesForDocument, flagOverduePaymentSchedules,
    getActiveScheduleRowsForAlignment, markScheduleRowsPaid, markScheduleRowsPending,
    getActivePaymentSchedules, deletePaymentSchedulesForBooking,
    prepareInsertPaymentSchedule, prepareUpdatePaymentScheduleAmount,
    cancelPendingPaymentSchedules, cancelPendingPaymentSchedulesAsync,
    getPaymentSchedulesForPayfastInit,

    getPayfastTransactionByReference, insertPayfastTransaction,
    insertPaymentLogEntry, insertLoggedPaymentTransaction, getPaymentLogsForBooking,
    getRecentPayfastTransactionForBooking, getCancellationsWithRefundedTotals,
    getTransactionsForBooking, getAlreadyRefundedAmount, insertRefundTransaction,
    getTransactionsPaidSumForReconcile, insertManualTransaction,
    getTransactionRevenueTrend, getTransactionRevenueByPeriod, getPeriodRevenue, getTotalTransactionCount,
    getCompletedTransactionsForReconciliation, setTransactionDuplicateFlag, countTransactionsForIds,
    redactTransactionForErasure,

    redactCancellationForErasure, insertCancellationForErasure, insertCancellationForAdminCancel,
    insertCancellationForStatusChange,
    getCancellationDetailForBooking,
    getCancellationForRefund, updateCancellationRefund, countCancellationsForIds,

    redactPaymentLogsForErasure, countPaymentLogsForIds,

    getExpensesForBookingEmail,
    getExpensesForBooking, getExpensesByPeriod, getExpenseTrend, getPeriodExpenses,
} = require('./database/repositories/finance.repository');
// Phase 4: calendar-domain (date_holds, events) data access moved to a repository (HOUSEKEEPING-NOTES.md).
const {
    getActiveHoldDatesForMonth,
    getDateHoldsForDateConflict,
    getActiveDateHoldsForToday, getActiveDateHoldsForCalendarGrid, getActiveDateHoldsForIcsFeed,
    insertDateHold, deleteDateHoldById, getDateHoldTimesById, updateDateHoldDate,
    releaseDateHoldsForBooking, releaseDateHoldsForBookingAsync,

    clearEventGoogleCalendarId, clearEventGoogleCalendarIdAsync, getEventGoogleCalendarId,
    advanceAutoCompletedEventS6, getPastStandaloneEventsForAutoComplete, advanceStandaloneEventCompleted,
    advanceEventToCompleted, insertAutoCreatedEvent,
    getEventByBookingId, demoteEventForCancelledBooking, demoteEventForCancelledBookingAsync,
    demoteEventForCancelledBookingByBookingIdAsync,
    updateEventDatetime,
    insertPublicEvent, checkEventExistsById, updatePublicEvent, deleteEventById,
    getEventsForSitemap,
} = require('./database/repositories/calendar.repository');
// Phase 4: auth+users-domain (admins, admin_login_logs, password_reset_tokens) data access moved
// to a repository (HOUSEKEEPING-NOTES.md).
const {
    getAdminActiveStatus, getAdminByEmailFull, updateAdminLastLogin, getActiveAdministratorCountExcluding,
    updateAdminPassword,
    getAdminSessionProfileById, getAdminSessionProfileByUsername,
    getAdminIdAndUsernameByEmail, getAdminIdByEmail, getAdminNameRoleById, getAdminEmailById,
    getAdminsListWithCreatorModifier, insertAdminUser, getAdminForInvite, getAdminForEditById,
    getAdminPasswordHashById, updateAdminUserFields, getAdminRoleActiveById, deleteAdminUser,
    getAssignableAdmins, checkAdminActiveById, getAdminDisplayNameById,
    countAllAdmins, insertBootstrapAdmin,

    insertAdminLoginLog, finalizeAdminLoginLogOnLogout, updateAdminLoginLogHeartbeat,
    getAdminLoginLogsWithNames,

    insertPasswordResetToken, getUnexpiredPasswordResetTokens,
    deletePasswordResetTokenById, deletePasswordResetTokensForAdmin,
} = require('./database/repositories/auth-users.repository');
require('dotenv').config();

// Ensure scratch directory exists
const scratchDir = path.join(__dirname, 'scratch');
if (!fs.existsSync(scratchDir)) {
    fs.mkdirSync(scratchDir, { recursive: true });
}

// Phase 5 (HOUSEKEEPING-NOTES.md): runtime storage locations (Phase 3 originally) moved to
// lib/runtime-paths.js — needed by route files being split out of this one, not just app.js.
const {
    DOCS_PATH, UPLOADS_PATH, BACKUPS_PATH, LEGACY_DOCS_DIR,
    ensureDir, docsWriteDir, resolveDocsPath, uploadsWriteDir,
} = require('./lib/runtime-paths');


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

// Still needed directly in this file for runDailyOverdueFlaggingSweep's and the analytics-rollup
// cron's own schedule.scheduleJob(...) registrations below (unrelated to newsletter/birthday
// scheduling) — scheduledJobs and birthdayJob themselves moved to lib/newsletter-scheduling.js and
// lib/newsletter-birthday.js respectively.
const schedule = require('node-schedule');

// Analytics: geo + UA parsing for the first-party page-view tracker
const geoip    = require('geoip-lite');
const UAParser = require('ua-parser-js');

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
// moved to lib/google-calendar.js, verbatim, at this exact point in the file's execution order.
const { calendar, CALENDAR_ID } = require('./lib/google-calendar');

const helmet = require('helmet');

// Phase 5 (HOUSEKEEPING-NOTES.md): every rate limiter moved to middleware/rate-limiters.js, so
// route files extracted into routes/admin/ and routes/public/ have one place to import whichever
// limiter their route used. Destructured here so every existing call site keeps working unchanged.
const {
    bookingRateLimiter, exportRateLimiter, sitemapRateLimiter, trackRateLimiter,
    otpRequestRateLimiter, mutateRateLimiter, adminRateLimiter, adminLoginRateLimiter,
    lookupRateLimiter, analyticsTrackLimiter, ipRateLimiter,
    PAYFAST_VALID_IPS, payfastItnRateLimiter,
} = require('./middleware/rate-limiters');

// Bypass local antivirus/proxy self-signed certificates
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// Phase 5 (HOUSEKEEPING-NOTES.md): moved to lib/validation.js.
const { sanitizeEmailInput, EMAIL_FORMAT_RE, isValidBirthday } = require('./lib/validation');

// Phase 5 (HOUSEKEEPING-NOTES.md): moved to lib/newsletter-scheduling.js, alongside
// scheduledJobs/scheduleNewsletterSend below (same file — all part of the same scheduling
// subsystem, and buildSegmentCondition is called from inside scheduleNewsletterSend).
const { scheduledJobs, buildSegmentCondition, scheduleNewsletterSend } = require('./lib/newsletter-scheduling');

const app = express();
const PORT = process.env.PORT || 3000;

// The privacy-policy version consent is recorded against. Server-owned on purpose: the public
// booking form used to send this value and it was written verbatim into bookings.policy_version
// AND consent_audit.policy_version, so a stale cached page — or a crafted request — could record
// consent against a policy the user never saw. Bump this whenever the published policy changes.
const CURRENT_POLICY_VERSION = 'v2.2';

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

// Phase 5 (HOUSEKEEPING-NOTES.md): moved to lib/uploads.js — needed by the ~20 admin upload
// routes being split into routes/, not just this file.
const { safeUploadFilename, upload, newsletterUpload } = require('./lib/uploads');

// Restricted variant of `upload` for the one PUBLIC, unauthenticated upload route (testimonial
// photo submission) — deliberately excludes .svg. SEC-1 (see the /upload route below) already
// established that allowing SVG through an unauthenticated upload path is a stored-XSS vector;
// `upload` above stays SVG-permissive because every other route using it is requireAdmin-gated.
// Uses its own fixed-destination storage (not the shared `storage` above, which picks a folder
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

// receiptStorage/uploadReceipt/VALID_EXPENSE_CATEGORIES's only callers were the /api/admin/expenses
// routes, which now define their own local copies in routes/admin/expenses.js (same single-consumer
// pattern as subscriberCsvUpload below).

// newsletterAttachStorage/newsletterUpload moved to lib/uploads.js — added to the same import
// destructured near the top of this file (alongside safeUploadFilename/upload).

// subscriberCsvUpload's only call site (the CSV-import route) already moved to
// routes/admin/newsletter-subscribers.js, which defines its own local copy (see that file) — no
// longer needed here.

// emailAttachStorage/emailAttachUpload moved to lib/uploads.js (added to the existing import
// destructured near the top of this file).


// Phase 5 (HOUSEKEEPING-NOTES.md): bookingAttachUpload moved to routes/public/bookings.js —
// single-consumer (the attachments route moved with it).

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
    else if (section === 'footprint') folderPath = 'images/footprint/';
    else if (section === 'testimonials') folderPath = 'images/testimonials/';

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

// Phase 5 (HOUSEKEEPING-NOTES.md): timeRangesOverlap/addMinutesToTime/parseDurationToMinutes
// moved to lib/time-utils.js.
const { timeRangesOverlap, addMinutesToTime, parseDurationToMinutes } = require('./lib/time-utils');

// Phase 5 (HOUSEKEEPING-NOTES.md): the Google Calendar sync/booking-conflict engine —
// isWithinWorkingHours/hasCalendarConflict/syncBookingToCalendar/syncCalendarHolds/
// syncEventToCalendar/checkDateAvailability — all moved to lib/calendar-sync.js. (The two orphaned
// JSDoc comments that used to precede isWithinWorkingHours/hasCalendarConflict here were removed
// along with them — their subject functions no longer live in this file.)
const {
    isWithinWorkingHours, hasCalendarConflict, syncBookingToCalendar, syncCalendarHolds, syncEventToCalendar,
    checkDateAvailability
} = require('./lib/calendar-sync');



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
// FIN-1: the tax_rates table has no tax_type/is_active columns (real columns: name, rate,
// is_default, effective_from, effective_to), so the original query always errored and
// silently returned the 0.15 fallback — meaning a reconfigured VAT rate was never picked up.
// Phase 5 (HOUSEKEEPING-NOTES.md): getVatRate/resolveLineTaxClasses/computeDocumentTotals moved to
// lib/document-totals.js.
const { getVatRate, resolveLineTaxClasses, computeDocumentTotals } = require('./lib/document-totals');

/**
 * Auto-builds the default 50/50 deposit+balance payment schedule for a booking, unless the admin
 * has already configured live (non-superseded/cancelled/paid) milestones — in which case it leaves
 * them alone. Idempotent and safe to re-run. Shared by BOTH acceptance paths (client self-accept
 * and admin QUOTED→ACCEPTED) so the milestone behaviour can never diverge between them again.
 * Uses the ambient dbRun, so the caller controls transactionality: call it inside an open
 * BEGIN IMMEDIATE (client path) or wrap it in withDbTransaction (admin path).
 *
 * Invariant: SUM(expected_amount) over live rows == totalAmount. The split covers the OUTSTANDING
 * balance (total − already-paid milestones), so a re-quote after a deposit schedules only what's left.
 * @param {number|string} bookingId
 * @param {number} totalAmount
 * @param {string|null} eventDate  YYYY-MM-DD; balance falls due 2 days before, else +30 days.
 */
async function autoBuildDepositBalanceSchedule(bookingId, totalAmount, eventDate) {
    if (!(totalAmount > 0)) return;
    const liveRow = await getLivePaymentScheduleCount(bookingId);
    if ((liveRow ? liveRow.cnt : 0) > 0) return; // admin-configured milestones exist — don't touch
    const paidRow = await getPaidPaymentScheduleSum(bookingId);
    const paidSum = paidRow ? (parseFloat(paidRow.paidSum) || 0) : 0;
    const remaining = Math.round((totalAmount - paidSum) * 100) / 100;
    if (remaining <= 0.009) {
        console.warn(`[Auto-Schedule] Booking #${bookingId}: paid milestones (R${paidSum.toFixed(2)}) already cover the total (R${totalAmount.toFixed(2)}) — no new milestones created.`);
        return;
    }
    const depositAmount = Math.round((remaining * 0.5) * 100) / 100;
    const balanceAmount = Math.round((remaining - depositAmount) * 100) / 100;
    const depositDue = moment().add(7, 'days').format('YYYY-MM-DD');
    const balanceDue = eventDate
        ? moment(eventDate).subtract(2, 'days').format('YYYY-MM-DD')
        : moment().add(30, 'days').format('YYYY-MM-DD');
    // Distinct labels once a payment exists, so the invoice PDF never shows two rows both called
    // "50% Deposit" for different amounts.
    const depositLabel = paidSum > 0 ? 'Outstanding Balance – Deposit (50%)' : '50% Deposit';
    const balanceLabel = paidSum > 0 ? 'Outstanding Balance – Final (50%)'   : '50% Balance';
    await insertPaymentScheduleMilestone(bookingId, depositLabel, depositDue, depositAmount);
    await insertPaymentScheduleMilestone(bookingId, balanceLabel, balanceDue, balanceAmount);
}

/**
 * Generates an invoice for a booking and saves it to the DB.
 * Draft-then-send model: by default the invoice is created as a reviewable DRAFT and NO email is
 * sent — the admin reviews it, then explicitly Sends (POST /invoices/:id/send flips DRAFT→SENT and
 * emails). Pass { autoSend: true } to create it as SENT and email immediately in one step — used by
 * the public accept-quote flow, where the client is actively expecting the invoice.
 * @param {number|string} bookingId
 * @param {{autoSend?: boolean}} [opts]
 * @returns {Promise<Object>}
 */
async function generateInvoice(bookingId, opts = {}) {
    const autoSend = !!opts.autoSend;
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
                        setBookingClientId(clientId, bookingId, upErr => upErr ? rejVal(upErr) : resVal());
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
            getInvoiceForPaidCheck(bookingId, async (e, inv) => {
                if (inv) return resolve({ success: true, message: 'Invoice already paid — no regeneration needed.', invoice_id: inv.id, pdfUrl: `/docs/invoices/${inv.file_path}` });

                try {
                    const vatRate = await getVatRate();

                    // P3-10: Prefer quote_line_items from active quotations row over legacy quote_details JSON
                    const activeQuote = await getActiveQuoteForInvoiceGen(bookingId);

                    let items = [];
                    let quoteData = {};
                    // apply_vat + discount live reliably in booking.quote_details JSON — the quotations
                    // table has no such columns, so reading activeQuote.apply_vat/discount always yielded
                    // undefined (FIN-3: invoices via the quotations path silently dropped VAT + discount).
                    // Source them from quote_details; use the relational rows only for the line items.
                    try { quoteData = JSON.parse(booking.quote_details || '{}'); } catch(ex) {}

                    if (activeQuote) {
                        const qLines = await getQuoteLineItems(activeQuote.id);
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
                    const priorIssued = await getInvoiceNumberCollisionCount(bookingId, baseNumber, `${baseNumber}-R%`);
                    const invNumber = priorIssued === 0 ? baseNumber : `${baseNumber}-R${priorIssued + 1}`;

                    // Enrich booking with VAT flag and discount from quote
                    booking.apply_vat = applyVat;
                    booking.discount = discount;
                    booking.vat_rate = vatRate; // FIN-1/2: PDF uses the same rate as the server calc

                    // Generate PDF
                    const pdfFileName = `${invNumber}-${moment().format('YYYYMMDDHHmmss')}.pdf`;
                    const invoicesDir = docsWriteDir('invoices');
                    const pdfPath = path.join(invoicesDir, pdfFileName);

                    const paymentSchedules = await getPaymentSchedulesForDocument(bookingId);
                    // Cite the related contract if one already exists at invoice-generation time (it
                    // often doesn't — accept-parity generates the invoice before the contract — so this
                    // is opportunistic, same as the contract PDF's optional "Per accepted quote" line).
                    const existingContract = await new Promise(resolve => {
                        db.get("SELECT contract_number FROM contracts WHERE booking_id = ?", [bookingId], (e, r) => resolve(e ? null : r));
                    });
                    // invNumber is passed through so the number on the client's PDF is the number in
                    // the ledger. generateDocument() otherwise derives `INV-<bookingId>-<YYMM>`, which
                    // has never matched invoices.invoice_number.
                    const pdfResult = await pdfService.generateDocument('Invoice', booking, items, pdfPath, paymentSchedules, invNumber,
                        { contractNumber: existingContract ? existingContract.contract_number : null });

                    // Create the invoice record. Voiding the superseded invoice, inserting the new
                    // invoice and its line items, and updating the booking are one atomic unit,
                    // queued behind every other guarded transaction on the shared connection.
                    const invoiceId = await withDbTransaction(async () => {
                        await dbRun("BEGIN IMMEDIATE");
                        try {
                            await voidSupersededInvoiceForRegen(bookingId);

                            // Draft-then-send: created as DRAFT for admin review unless autoSend
                            // (client accept-quote) asks to publish + email immediately as SENT.
                            const ins = await insertInvoice(bookingId, booking.client_id, invNumber, subtotal, tax, total, autoSend ? 'SENT' : 'DRAFT', pdfFileName);
                            const newInvoiceId = ins.lastID;

                            // Sequential and error-checked. These previously ran as a parallel forEach
                            // whose error argument was ignored, so a failed line item still committed an
                            // invoice whose total no line item supported.
                            for (const item of items) {
                                await insertInvoiceLineItem(newInvoiceId, item.description, item.quantity, item.unit_price);
                            }

                            await updateBookingLedgerAfterInvoice(total, total - (booking.amount_paid || 0), bookingId);

                            await dbRun("COMMIT");
                            return newInvoiceId;
                        } catch (txErr) {
                            await dbRun("ROLLBACK").catch(() => {});
                            throw txErr;
                        }
                    });

                    // Side effects only after the commit. A draft is NOT emailed — the admin reviews
                    // it and sends explicitly. Only autoSend (client accept-quote) emails here.
                    if (autoSend) {
                        try {
                            await sendInvoiceEmail(booking, pdfPath);
                            markInvoiceSent(invoiceId, () => {});
                        } catch (emErr) { console.error("Invoice Email Error:", emErr); }
                    }

                    resolve({ success: true, message: autoSend ? 'Invoice generated and emailed.' : 'Invoice generated as a draft.', invoice_id: invoiceId, status: autoSend ? 'SENT' : 'DRAFT', pdfUrl: `/docs/invoices/${pdfFileName}` });
                } catch (ex) {
                    console.error("Invoice Gen Error:", ex);
                    reject(ex);
                }
            });
        });
    });
}

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
// middleware/rbac.js. requireAdmin is the exact same [adminRateLimiter, checkFn] array it always
// was — middleware/auth.js builds it from the same rate-limiters module this file imports from.
const { requireAdmin } = require('./middleware/auth');
const { requireRole, requireRoleForInquiryEmail } = require('./middleware/rbac');

// Phase 5 (HOUSEKEEPING-NOTES.md): moved to lib/admin-users.js, alongside createAndSendInvite
// below, which shares this same concern.
const { VALID_ADMIN_ROLES, countOtherActiveAdministrators, createAndSendInvite } = require('./lib/admin-users');

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
// sanitizeAboutHtml/SECTION_KEYS (same file, all pure content-sanitization helpers).
const { encodeUserHtml, unescapeHtml, sanitizeAboutHtml, SECTION_KEYS } = require('./lib/html-sanitize');

// Phase 5 (HOUSEKEEPING-NOTES.md): moved to lib/email-context.js.
const { getEmailFooterContext, emailBaseUrl } = require('./lib/email-context');

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

// Phase 5 (HOUSEKEEPING-NOTES.md): generateBookingICS/sendQuoteEmail/sendAdminQuoteSentNotification/
// sendBookingConfirmedEmail/sendDepositBalanceDueEmail/sendQuoteExpiryWarningEmail/
// sendReviewRequestEmail/remindBooking/sendDateChangedEmail all moved to lib/booking-notifications.js.
// remindBooking, sendAdminQuoteSentNotification, and sendQuoteEmail have no remaining caller in
// app.js (their routes — bulk-remind/remind, and the admin quote route — moved with them).
const {
    generateBookingICS, sendBookingConfirmedEmail,
    sendDepositBalanceDueEmail, sendQuoteExpiryWarningEmail, sendReviewRequestEmail, sendDateChangedEmail
} = require('./lib/booking-notifications');


// S2-2: Notify all admin users when a quote has been dispatched to a client

// Phase 5 (HOUSEKEEPING-NOTES.md): sendInvoiceEmail moved to lib/invoice-email.js.
const { sendInvoiceEmail } = require('./lib/invoice-email');

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
async function sendQuoteAcceptedEmail(booking, options = {}) {
    booking = escapeEmailFields(booking);
    const { invoiceGenerated = true } = options;
    const { id, name, email, event_name, event_type, date } = booking;

    // Fetch payment schedule to include in the confirmation email
    const schedules = await getPaymentSchedulesForDocument(id);

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

// Phase 5 (HOUSEKEEPING-NOTES.md): sendCancellationEmail moved to lib/booking-cancellation-email.js.
const { sendCancellationEmail } = require('./lib/booking-cancellation-email');

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



// P3-7: Resend the paid invoice PDF as a payment receipt when booking becomes fully PAID.
async function sendPaidReceiptEmail(booking) {
    booking = escapeEmailFields(booking);
    const inv = await getInvoiceForPaidReceipt(booking.id);
    if (!inv || !inv.file_path) return;
    const pdfPath = resolveDocsPath('invoices', inv.file_path);
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
        getInvoiceTaxAmountForBooking(id, (e, row) => {
            if (!e && row) return resolve(row);
            getQuoteTaxAmountForBooking(id, (e2, row2) => resolve(e2 ? null : row2));
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
    const expenseRows = await getExpensesForBookingEmail(id);
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

// Phase 5 (HOUSEKEEPING-NOTES.md): sendDateChangedEmail moved to lib/booking-notifications.js —
// see the require near the top of this file for the re-import.

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
// Phase 5 (HOUSEKEEPING-NOTES.md): moved to lib/db-helpers.js — used pervasively (~190 call
// sites) by business logic not owned by any single Phase 4 domain repository.
const { dbRun, dbGet, dbAll } = require('./lib/db-helpers');

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
// Phase 5 (HOUSEKEEPING-NOTES.md): moved to lib/db-transaction.js — MUST stay a singleton (see
// that file's header comment), so route files import the exact same module rather than each
// getting their own dbTxnQueue.
const { withDbTransaction } = require('./lib/db-transaction');

// "Last Updated By" feature — shared audit/actor helpers.
// ============================================================

// Phase 5 (HOUSEKEEPING-NOTES.md): resolveActor moved to lib/actor.js, logAudit to
// lib/audit-log.js.
const { resolveActor } = require('./lib/actor');
const { logAudit } = require('./lib/audit-log');

// Phase 5 (HOUSEKEEPING-NOTES.md): the entire POPIA/GDPR erasure subsystem — resolvePopiaTargets,
// anonymizeClientData, and the request-lifecycle block further below (POPIA_REASONS through
// notifyPopiaCancellations) — moved to lib/popia.js (batch 14). Re-imported here because the
// not-yet-moved public self-service routes (POST /api/public/popia/preview, /erasure-requests,
// and the legacy /api/public/compliance/request-forget) still call resolvePopiaTargets,
// getBookingErasureImpact, createPopiaRequest and POPIA_REASONS directly.
const { resolvePopiaTargets, getBookingErasureImpact, createPopiaRequest, POPIA_REASONS } = require('./lib/popia');

// anonymizeClientData(email) also moved to lib/popia.js as part of the same relocation — it has
// no caller left in app.js (only lib/popia.js's own processPopiaRequest/completePopiaAnonymization
// call it), so it is not re-imported here.

// Free-text columns that have no DB-level length limit. Anything not listed here is either
// validated by its own rule (email/cell/date) or is not a client-supplied string.
const BOOKING_TEXT_LIMITS = {
    company: 150, event_name: 200, event_location: 200, venue_address: 300,
    city: 100, country: 100, venue_type: 60, event_type: 60,
    audience_size: 40, audience_demographic: 120, budget_range: 60,
    performance_slot: 40, performance_duration: 40,
    vat_number: 30, source: 100, referrer: 500,
    // Was the one client-supplied free-text field with no cap (real Google Place IDs run
    // ~27-100 chars; 300 is generous headroom) — found in an end-to-end booking-flow audit.
    venuePlaceId: 300,
    // Alternative/backup dates, content-suitability note, optional self-reported lead source —
    // all optional, no required-field check added for any of them.
    alternative_dates: 300, content_notes: 500, heard_about: 200
};

// Phase 5 (HOUSEKEEPING-NOTES.md): asBookingText moved to lib/booking-tracking.js, alongside the
// tracker OTP helpers/constants it's grouped with there.
const { asBookingText } = require('./lib/booking-tracking');

app.post('/api/public/bookings', ipRateLimiter, bookingRateLimiter, async (req, res) => {
    let {
        name, company, email, cell,
        event_name, event_date, event_start_time, performance_slot, performance_duration,
        event_location, venue_address, city, country, venue_type,
        event_type, audience_size, audience_demographic, budget_range, travel_accommodation, message,
        alternative_dates, content_notes, heard_about,
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
    alternative_dates = asBookingText(alternative_dates);
    content_notes = asBookingText(content_notes);
    heard_about = asBookingText(heard_about);
    message = asBookingText(message);         vat_number = asBookingText(vat_number);
    venuePlaceId = asBookingText(venuePlaceId);

    // Bug fix: `message` ("Additional Notes") is explicitly labelled optional on the public form
    // (index.html) and the client-side validator deliberately never blocks on it — but this check
    // and the length-minimum below still required it server-side, so a client leaving it blank sailed
    // through all 4 steps and only got rejected at final submit with a generic, unrouted error.
    if (!name || !email || !cell || !event_date || !event_location || !event_type) {
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
    // Only enforce a minimum when something was actually typed — matches the "optional" label.
    if (message && message.length < 10)
        return res.status(400).json({ success: false, message: 'Please provide a message of at least 10 characters, or leave it blank.' });
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

    // Bug fix: MIN_ADVANCE_HOURS was previously enforced only by GET /api/public/availability (the
    // calendar's "too soon" warning) — never re-checked here, so a direct API call or an edited
    // hidden #bookDate value bypassed it entirely. Mirrors that endpoint's exact midnight-based
    // check (server.js ~6318) so a date the calendar already approved is never re-rejected here.
    const advanceHoursCheck = (new Date(event_date + 'T00:00:00') - new Date()) / (1000 * 60 * 60);
    if (advanceHoursCheck < MIN_ADVANCE_HOURS) {
        return res.status(400).json({ success: false, message: `Bookings require at least ${MIN_ADVANCE_HOURS} hours advance notice. Please choose a later date.` });
    }

    // event_start_time reaches moment(), addMinutesToTime() and the working-hours gate unvalidated.
    // A non-time value ("abc") produced "NaN:NaN" end times and an Invalid-date ISO conversion.
    if (event_start_time) {
        const tm = event_start_time.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
        if (!tm) return res.status(400).json({ success: false, message: 'Invalid event start time. Use HH:MM (24-hour), e.g. 19:30.' });
        event_start_time = `${tm[1].padStart(2, '0')}:${tm[2]}`; // zero-pad so string compares and moment() parsing are safe
    }

    // CRITICAL: the public form never sends event_start_time — it sends performance_slot
    // ("HH:MM–HH:MM", or the literal "All Day / Custom Hours"). Every conflict-detection query
    // (checkDateAvailability, hasCalendarConflict) keys off event_start_time, so leaving it null
    // made every public booking invisible to double-booking protection — two different clients
    // could book the same date/time, and the working-hours gate below (which only runs
    // `if (event_start_time)`) never ran at all. Derive it here, before any availability check,
    // so the booking's real window drives both the pre-check and the persisted row.
    let perfSlotStart = null, perfSlotEnd = null;
    if (performance_slot) {
        const slotMatch = performance_slot.match(/(\d{1,2}:\d{2})\s*[–\-]\s*(\d{1,2}:\d{2})/);
        if (slotMatch) {
            const padTime = (t) => { const [h, m] = t.split(':'); return `${h.padStart(2, '0')}:${m}`; };
            perfSlotStart = padTime(slotMatch[1]);
            perfSlotEnd = padTime(slotMatch[2]);
        }
    }
    if (!event_start_time && perfSlotStart) {
        event_start_time = perfSlotStart;
    }
    // A performance_slot that doesn't parse to a range (e.g. "All Day / Custom Hours") and no
    // explicit event_start_time means the client is asking to occupy the whole day — checked
    // against existing bookings/holds/events at step 3 below, same as any other all-day request.
    const isAllDayRequest = !event_start_time;

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
        // An all-day request ("All Day / Custom Hours", or no slot given) can't share a date with
        // any existing timed booking — checkDateAvailability() only rejects whole-day holds/events/
        // bookings above; a same-day timed booking still comes back as `available: true` with a
        // busy range, which is fine for another timed request but not for one asking for the whole day.
        if (isAllDayRequest && availableResult.busy_ranges && availableResult.busy_ranges.length > 0) {
            return res.status(409).json({ success: false, message: 'The selected date already has a booking on it and is not available for a full-day request.' });
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
                if (isAllDayRequest && lockedAvail.busy_ranges && lockedAvail.busy_ranges.length > 0) {
                    await dbRun("ROLLBACK").catch(() => {});
                    return { status: 409, body: { success: false, message: 'The selected date already has a booking on it and is not available for a full-day request.' } };
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

                // F3: re-run the same-email/same-date duplicate check inside the lock, closing the
                // same race window F1 closes for calendar conflicts.
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
                            alternative_dates, content_notes, heard_about,
                            client_id, venue_id, quote_amount, total_amount, amount_outstanding, payment_status, popia_consent, consent_timestamp, vat_number, venue_place_id, quote_expiry_date, policy_version, source, referrer, consent_source
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, "NEW", ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP, ?, ?, ?, ?, ?, ?, 'public_form')`,
                    [
                        encodeUserHtml(name), encodeUserHtml(company) || null, email, cell,
                        encodeUserHtml(event_name) || null, event_date, event_start_time || null, encodeUserHtml(performance_slot) || null, encodeUserHtml(performance_duration) || null,
                        encodeUserHtml(event_location), encodeUserHtml(venue_address) || null, encodeUserHtml(city) || null, encodeUserHtml(country) || null, encodeUserHtml(venue_type) || null,
                        encodeUserHtml(event_type), encodeUserHtml(audience_size) || null, encodeUserHtml(audience_demographic) || null, encodeUserHtml(budget_range) || null, travel_accommodation ? 1 : 0, encodeUserHtml(message),
                        encodeUserHtml(alternative_dates) || null, encodeUserHtml(content_notes) || null, encodeUserHtml(heard_about) || null,
                        clientId, venueId, initialQuoteAmountStr, initialTotalAmount, initialTotalAmount, paymentStatus, vat_number || null, encodeUserHtml(venuePlaceId) || null, defaultQuoteExpiry, CURRENT_POLICY_VERSION,
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
                // perfSlotStart/perfSlotEnd were already parsed from performance_slot above (they're
                // also what event_start_time was derived from, when it wasn't given explicitly).
                let perfStart = perfSlotStart, perfEnd = perfSlotEnd;
                if (!perfStart && event_start_time) {
                    perfStart = event_start_time;
                    perfEnd = addMinutesToTime(event_start_time, durationMins);
                }
                if (perfStart && perfEnd) {
                    await dbRun("UPDATE bookings SET performance_start_time = ?, performance_end_time = ? WHERE id = ?",
                        [perfStart, perfEnd, bookingId]);
                }

                // 10. INSERT BOOKING SERVICES (Relational)
                for (const srv of selectedServices) {
                    await insertBookingService(bookingId, srv.service_id, srv.quantity_minutes, srv.unit_price, srv.total_price);
                    await insertBookingLineItem(bookingId, srv.service_id, srv.name, srv.quantity_minutes, srv.unit_price);
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

// Phase 5 (HOUSEKEEPING-NOTES.md): estimateDraftValue moved to routes/public/bookings.js —
// single-consumer (the draft-autosave route moved with it).

// Branded recovery reminder email with a one-click resume link + opt-out.
// Phase 5 (HOUSEKEEPING-NOTES.md): sendAbandonedBookingReminderEmail moved to
// lib/abandoned-booking-email.js.
const { sendAbandonedBookingReminderEmail } = require('./lib/abandoned-booking-email');



// Phase 5 (HOUSEKEEPING-NOTES.md): _abOptOutPage moved to routes/public/bookings.js —
// single-consumer (both opt-out routes moved with it).









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
// PAYFAST_VALID_IPS and payfastItnRateLimiter moved to middleware/rate-limiters.js (Phase 5,
// HOUSEKEEPING-NOTES.md) — both destructured in with every other rate limiter near the top of
// this file now.

// ============================================================
// Public booking tracker — email-verification second factor.
//
// Previously, "booking id + the email on file" alone was accepted as proof of ownership across
// every public tracking route (/track, /pay, /accept-quote, /cancel, /contract/sign, downloads).
// Booking ids are sequential and easily guessed, and an email address is often knowable to a third
// party (a colleague, a shared inbox, a leak elsewhere) — so that pair falls short of proving the
// caller actually controls the client's inbox. This flow adds that proof:
//   1. POST /track/request-code  — emails a 6-digit code to the address on file.
//   2. POST /track/verify-code   — exchanges a correct code for a booking-scoped access_token.
// Every tracking route below now requires that access_token (via requireBookingAccessToken)
// instead of a bare client-supplied email.
// ============================================================
// Phase 5 (HOUSEKEEPING-NOTES.md): OTP_TTL_MINUTES/OTP_MAX_ATTEMPTS/ACCESS_TOKEN_TTL_MINUTES/
// generateOtpCode/hashAccessToken moved to lib/booking-tracking.js; requireBookingAccessToken
// (which depends on hashAccessToken) moved to middleware/booking-access.js, alongside requireAdmin.
const { OTP_TTL_MINUTES, OTP_MAX_ATTEMPTS, ACCESS_TOKEN_TTL_MINUTES, generateOtpCode, hashAccessToken } = require('./lib/booking-tracking');
const { requireBookingAccessToken } = require('./middleware/booking-access');



// ============================================================
// POPIA erasure request — email-ownership verification via OTP.
// Mirrors the tracker OTP mechanics directly above (same constants, same bcrypt/attempts/expiry
// shape) but keyed by email alone — there's no prior booking record to match against here; this
// proves mailbox ownership, not an existing account, so /request-otp always sends (no anti-
// enumeration silence needed/possible). No second session-token table: the raw code is re-verified
// (not re-consumed) across the read-only preview call below, then actually consumed only on the
// final POST /erasure-requests submit — there's only one subsequent authenticated action needed,
// unlike the tracker's multi-route session.
// ============================================================

// Looks up the latest unconsumed, unexpired code for `email` and checks it against `code`.
// `consume:false` (used by the preview endpoint) leaves the row alone on a correct match so the
// same code can still be used again by the final submit; `consume:true` marks it spent. The
// attempts budget is shared across every caller of this function, so hitting the preview endpoint
// doesn't grant extra guesses beyond OTP_MAX_ATTEMPTS.
async function verifyPopiaOtp(email, code, { consume }) {
    if (!code) return { ok: false, message: 'A verification code is required.' };
    const codeRow = await dbGet(
        `SELECT id, code_hash, attempts FROM popia_verification_codes
         WHERE lower(email) = lower(?) AND consumed = 0 AND expires_at > CURRENT_TIMESTAMP
         ORDER BY created_at DESC LIMIT 1`,
        [email]
    );
    if (!codeRow) {
        return { ok: false, message: 'That code is invalid or has expired. Please request a new one.' };
    }
    if (codeRow.attempts >= OTP_MAX_ATTEMPTS) {
        await dbRun("UPDATE popia_verification_codes SET consumed = 1 WHERE id = ?", [codeRow.id]);
        return { ok: false, message: 'Too many incorrect attempts. Please request a new code.' };
    }

    const match = await bcrypt.compare(code, codeRow.code_hash);
    if (!match) {
        await dbRun("UPDATE popia_verification_codes SET attempts = attempts + 1 WHERE id = ?", [codeRow.id]);
        const remaining = OTP_MAX_ATTEMPTS - (codeRow.attempts + 1);
        await dbRun(
            `INSERT INTO audit_log (table_name, record_id, action, user_email, change_timestamp) VALUES ('popia_verification_codes', ?, 'POPIA_OTP_FAILED', ?, CURRENT_TIMESTAMP)`,
            [codeRow.id, email]
        ).catch(() => {});
        return { ok: false, message: remaining > 0 ? `Incorrect code. ${remaining} attempt(s) remaining.` : 'Too many incorrect attempts. Please request a new code.' };
    }

    if (consume) {
        await dbRun("UPDATE popia_verification_codes SET consumed = 1 WHERE id = ?", [codeRow.id]);
    }
    return { ok: true, codeId: codeRow.id };
}

app.post('/api/public/popia/request-otp', ipRateLimiter, otpRequestRateLimiter, async (req, res) => {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
        return res.status(400).json({ success: false, message: 'A valid email address is required.' });
    }
    try {
        // Kill any earlier unconsumed code for this email so only the most recently sent one is live.
        await dbRun("UPDATE popia_verification_codes SET consumed = 1 WHERE lower(email) = lower(?) AND consumed = 0", [email]);
        const code = generateOtpCode();
        const codeHash = await bcrypt.hash(code, 10);
        const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60000).toISOString();
        const ins = await dbRun("INSERT INTO popia_verification_codes (email, code_hash, expires_at) VALUES (?, ?, ?)", [email, codeHash, expiresAt]);

        const banner = await bannerRegistry.resolveBanner('popia_verification_code');
        const { socialLinks } = await getEmailFooterContext();
        await sendEmail({
            to: email,
            subject: `Your POPIA verification code: ${code}`,
            htmlContent: emailComponents.renderPremiumEmail({
                preheaderText: `Your verification code is ${code}. It expires in ${OTP_TTL_MINUTES} minutes.`,
                bannerSrc: banner?.src, bannerAlt: banner?.alt, subtitle: banner?.subtitle,
                headline: banner?.headline || 'Verify Your Email',
                bodyHtml:
                    `<p style="margin:0 0 12px;">Use this code to verify your email address for your POPIA data erasure request:</p>` +
                    `<p style="margin:0; color:#B0B0B0; font-size:13px;">This code expires in ${OTP_TTL_MINUTES} minutes. If you didn't request this, you can safely ignore this email.</p>`,
                cards: [{ rows: [{ label: 'Verification code', value: code, mono: true, highlight: true }] }],
                socialLinks
            }),
            preWrapped: true,
            titleOverride: 'Verify Your Email',
            trigger_event: 'POPIA: Erasure Verification Code'
        });

        await dbRun(
            `INSERT INTO audit_log (table_name, record_id, action, user_email, ip_address, change_timestamp) VALUES ('popia_verification_codes', ?, 'POPIA_OTP_REQUESTED', ?, ?, CURRENT_TIMESTAMP)`,
            [ins.lastID, email, req.ip]
        ).catch(() => {});

        res.json({ success: true, message: 'A verification code has been sent to that email address.' });
    } catch (e) {
        console.error('[POPIA OTP] request-otp failed:', e.message);
        res.status(500).json({ success: false, message: 'Could not send a verification code. Please try again.' });
    }
});

// Read-only, pre-submission preview: verifies the code WITHOUT consuming it, then shows the client
// exactly which of their bookings are in scope for cancellation and the refund figures that will
// actually apply — reusing the same calculateCancellationRefund() the real cancellation step uses,
// via the shared getBookingErasureImpact() (defined further below, alongside the erasure lifecycle
// functions it's grouped with), so this preview can never drift from what processing will do.
app.post('/api/public/popia/preview', ipRateLimiter, mutateRateLimiter, async (req, res) => {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
    const otpCode = typeof req.body?.otp_code === 'string' ? req.body.otp_code.trim() : '';
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
        return res.status(400).json({ success: false, message: 'A valid email address is required.' });
    }
    const verify = await verifyPopiaOtp(email, otpCode, { consume: false });
    if (!verify.ok) return res.status(400).json({ success: false, message: verify.message });

    try {
        const { bookingIds } = await resolvePopiaTargets(email);
        const impact = await getBookingErasureImpact(bookingIds);
        res.json({ success: true, bookings: impact });
    } catch (e) {
        console.error('[POPIA] preview failed:', e.message);
        res.status(500).json({ success: false, message: 'Could not generate a preview. Please try again.' });
    }
});

// Hardened Payment Initiation Endpoint
// SEC: every other public /bookings/:id/* action (track, accept-quote, cancel, contract/sign)
// verifies the caller controls the booking's own email before returning anything. This route used
// to skip that check entirely, so POSTing a payment_type against any (sequential, easily-guessed)
// booking id returned the client's full name, email address and exact quoted amount — an
// unauthenticated PII leak — and produced a live, signed PayFast redirect for someone else's
// booking. Now gated behind the same access_token every other tracking route requires.
app.post('/api/public/bookings/:id/pay', ipRateLimiter, mutateRateLimiter, requireBookingAccessToken, (req, res) => {
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

            getPaymentSchedulesForPayfastInit(
                row.id,
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
        const booking = await getBookingByIdAsync(bookingId);

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
        const alreadyProcessed = await getPayfastTransactionByReference(itnRef, bookingId);
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
                    await insertPayfastTransaction(bookingId, itnAmount, mappedMethod, itnRef, pfData.pf_payment_id || null, pfData.payment_status, receivedSignature);

                    const credit = await applyPayfastPaymentToBooking(
                        itnAmount, currentTotal, paymentType,
                        pfData.pf_payment_id || null, receivedSignature, JSON.stringify(pfData), pfData.payment_method || 'payfast',
                        bookingId
                    );
                    if (credit.changes === 0) {
                        await dbRun("ROLLBACK").catch(() => {}); // overpayment guard blocked it — undo the tx insert too
                        return { overpayment: true };
                    }

                    const fresh = await getBookingByIdAsync(bookingId);
                    if (fresh && fresh.payment_status === 'PAID') {
                        await markInvoicePaidIfOpenAsync(bookingId);
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
                insertAutoCreatedEvent(
                    updatedRow.event_name || updatedRow.event_type || 'Booking Event', evDatetime,
                    updatedRow.event_location || null, updatedRow.venue_id || null, bookingId,
                    function(evErr) {
                        if (evErr) { console.error('[Auto-Event] PayFast: Insert failed for booking #' + bookingId + ':', evErr.message); return; }
                        setBookingEventId(this.lastID, bookingId);
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
                markBookingPaymentFailedIfUnpaid(bookingId);
            }
            getBookingById(bookingId, (e, failedRow) => {
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
    insertPaymentLogEntry(
        bookingId, eventType, JSON.stringify(pfData), sigValid, amount,
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
        insertLoggedPaymentTransaction(
            bookingId, amount, mappedMethod, txReference, txSource,
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
    getActiveScheduleRowsForAlignment(
        bookingId,
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
                markScheduleRowsPaid(toPaid.map(() => '?').join(','), toPaid, next);
            };
            const runPending = (next) => {
                if (toPending.length === 0) return next(null);
                markScheduleRowsPending(toPending.map(() => '?').join(','), toPending, next);
            };
            runPaid((e1) => runPending((e2) => { if (callback) callback(e1 || e2); }));
        }
    );
}

function updateBookingMilestones(bookingId, callback) {
    getBookingAmountPaid(bookingId, (err, row) => {
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
    getPaymentLogsForBooking(req.params.id, (err, rows) => {
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
    getBookingById(req.params.id, (err, row) => {
        if (err || !row) return res.status(404).json({ success: false, message: 'Booking not found.' });
        if (['CANCELLED', 'EXPIRED'].includes(row.status)) {
            return res.status(400).json({ success: false, message: `Cannot record payment on a ${row.status} booking.` });
        }

        // P2-5: Warn if a PayFast transaction was recorded for this booking within the last 2 hours —
        // recording a manual payment on top may create a duplicate credit.
        if (!force) {
            getRecentPayfastTransactionForBooking(
                req.params.id,
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

        applyManualPaymentToBooking(
            payment_status, paid, outstanding, total, newStatus, req.params.id,
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
                    getBookingForAutoEventOnPayment(req.params.id, (evSelErr, bRow) => {
                        if (evSelErr || !bRow || bRow.event_id) return;
                        const evDatetime = bRow.date + (bRow.event_start_time ? ' ' + bRow.event_start_time : ' 00:00:00');
                        insertAutoCreatedEvent(
                            bRow.event_name || bRow.event_type || 'Booking Event', evDatetime, bRow.event_location || null, bRow.venue_id || null, req.params.id,
                            function(evErr) {
                                if (evErr) { console.error('[Auto-Event] ManualPayment: Insert failed for booking #' + req.params.id + ':', evErr.message); return; }
                                setBookingEventId(this.lastID, req.params.id);
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
                            markInvoicePaidIfOpen(req.params.id);
                            getBookingById(req.params.id, (e, updated) => {
                                if (!e && updated) {
                                    sendBookingConfirmedEmail(updated).catch(e => console.error('Confirmed email after manual payment failed:', e.message));
                                    setTimeout(() => sendPaidReceiptEmail(updated).catch(e => console.error('Paid receipt email (manual) failed:', e.message)), 600);
                                }
                            });
                        };
                        // Ensure an invoice exists before sending the receipt — manual bookings that
                        // skipped quote acceptance have no invoice yet, so generate one on the spot.
                        getOpenInvoiceIdForReceiptCheck(
                            req.params.id,
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

// Phase 5 (HOUSEKEEPING-NOTES.md): the request-lifecycle block that used to run from here
// (POPIA_REASONS) through notifyPopiaCancellations() — popiaReferenceNumber, createPopiaRequest,
// approvePopiaRequest, rejectPopiaRequest, processPopiaRequest, completePopiaAnonymization,
// deletePopiaFiles, isBookingInPopiaErasureScope, cancelActiveBookingsForErasure,
// getUnresolvedRefundBookingIds, notifyPopiaCancellations — moved to lib/popia.js. Of these, only
// POPIA_REASONS and createPopiaRequest are re-imported above (alongside resolvePopiaTargets/
// getBookingErasureImpact) — the public routes immediately below only ever create a request, never
// approve/process/notify one; the rest have no remaining caller in app.js.

// Public request form (index.html footer -> #popiaErasureModal)
app.post('/api/public/popia/erasure-requests', ipRateLimiter, mutateRateLimiter, async (req, res) => {
    const { email, otp_code, reason, reason_other_text, additional_comments, consequences_acknowledged } = req.body || {};
    const emailNorm = typeof email === 'string' ? email.trim() : '';
    if (!emailNorm || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(emailNorm)) {
        return res.status(400).json({ success: false, message: 'A valid email address is required.' });
    }
    if (!POPIA_REASONS.includes(reason)) {
        return res.status(400).json({ success: false, message: 'Please select a valid reason for your request.' });
    }
    if (reason === 'other' && !String(reason_other_text || '').trim()) {
        return res.status(400).json({ success: false, message: 'Please describe your reason for the request.' });
    }
    if (!consequences_acknowledged) {
        return res.status(400).json({ success: false, message: 'Please confirm you understand the consequences of this request before submitting.' });
    }

    // Verify but don't consume yet — only mark the code spent once createPopiaRequest() has actually
    // succeeded, so a transient DB failure doesn't force the client to request an entirely new code
    // for a problem that wasn't theirs.
    const verify = await verifyPopiaOtp(emailNorm, typeof otp_code === 'string' ? otp_code.trim() : '', { consume: false });
    if (!verify.ok) return res.status(400).json({ success: false, message: verify.message });

    const outcome = await createPopiaRequest({
        email: emailNorm,
        reason,
        reasonOtherText: reason === 'other' ? encodeUserHtml(String(reason_other_text).trim().slice(0, 500)) : null,
        additionalComments: additional_comments ? encodeUserHtml(String(additional_comments).trim().slice(0, 2000)) : null,
        source: 'public',
        ip: req.ip,
        userAgent: req.get('User-Agent') || null,
        actorEmail: emailNorm
    });
    if (!outcome.ok) return res.status(outcome.status).json(outcome.body);

    await dbRun("UPDATE popia_verification_codes SET consumed = 1 WHERE id = ?", [verify.codeId]).catch(() => {});
    await dbRun(
        `INSERT INTO audit_log (table_name, record_id, action, user_email, change_timestamp) VALUES ('popia_erasure_requests', ?, 'POPIA_OTP_VERIFIED', ?, CURRENT_TIMESTAMP)`,
        [outcome.id, emailNorm]
    ).catch(() => {});

    try {
        const { socialLinks } = await getEmailFooterContext();
        const html = emailComponents.renderPremiumEmail({
            preheaderText: `We've received your data erasure request — Ref #${outcome.reference_number}.`,
            headline: 'Data Erasure Request Received',
            greeting: 'Hello,',
            bodyHtml: `We've received your request to have your personal information anonymised under POPIA. Your reference number is <strong style="color:#D4AF37;">${outcome.reference_number}</strong> — please keep this for your records.<br><br>Our team will review your request and process it in accordance with our data retention obligations. You'll receive a further email once it has been actioned.`,
            cards: [{
                title: 'Request Summary',
                rows: [
                    { label: 'Reference', value: outcome.reference_number },
                    { label: 'Email', value: emailNorm },
                    { label: 'Submitted', value: new Date().toLocaleDateString('en-ZA') }
                ]
            }],
            socialLinks
        });
        await sendEmail({
            to: emailNorm,
            subject: `Data Erasure Request Received — Ref #${outcome.reference_number}`,
            htmlContent: html,
            preWrapped: true,
            titleOverride: 'Data Erasure Request Received',
            trigger_event: 'POPIA: Erasure Request Received'
        });
    } catch (emailErr) {
        console.error('[POPIA] confirmation email failed:', emailErr.message);
    }

    res.json({ success: true, message: 'Your data erasure request has been received. Please check your email for confirmation.', reference_number: outcome.reference_number });
});

// Legacy public compat route — previously anonymized bookings/inquiries INSTANTLY, unauthenticated,
// for any email posted to it (no verification the caller owned the address, no review step, no
// audit trail). Rewritten to create a reviewable request like every other entry point instead, and
// now gated behind the same OTP verification as /erasure-requests — otherwise this would remain a
// way to bypass that requirement entirely. Callers must first hit /request-otp for the email, same
// as the primary flow.
app.post('/api/public/compliance/request-forget', ipRateLimiter, mutateRateLimiter, async (req, res) => {
    const emailNorm = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
    if (!emailNorm || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(emailNorm)) {
        return res.status(400).json({ success: false, message: 'A valid email address is required.' });
    }
    const otpCode = typeof req.body?.otp_code === 'string' ? req.body.otp_code.trim() : '';
    const verify = await verifyPopiaOtp(emailNorm, otpCode, { consume: false });
    if (!verify.ok) return res.status(400).json({ success: false, message: verify.message });

    const outcome = await createPopiaRequest({
        email: emailNorm, reason: 'other', reasonOtherText: 'Submitted via legacy /request-forget endpoint',
        source: 'public', ip: req.ip, userAgent: req.get('User-Agent') || null, actorEmail: emailNorm
    });
    if (!outcome.ok) return res.status(outcome.status).json(outcome.body);

    await dbRun("UPDATE popia_verification_codes SET consumed = 1 WHERE id = ?", [verify.codeId]).catch(() => {});
    await dbRun(
        `INSERT INTO audit_log (table_name, record_id, action, user_email, change_timestamp) VALUES ('popia_erasure_requests', ?, 'POPIA_OTP_VERIFIED', ?, CURRENT_TIMESTAMP)`,
        [outcome.id, emailNorm]
    ).catch(() => {});

    res.json({ success: true, message: 'Your data erasure request has been received and will be reviewed by our team.', reference_number: outcome.reference_number });
});

// 2. Data Portability (Export Request)
app.post('/api/public/compliance/export-data', ipRateLimiter, (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, message: 'Email required.' });

    const dataExport = {};
    
    db.all("SELECT * FROM bookings WHERE LOWER(email) = LOWER(?)", [email], (err, bookings) => {
        if (err) console.error('[POPIA] export-data bookings query failed:', err.message);
        dataExport.bookings = bookings || [];
        getInquiriesForEmail(email, (err, inquiries) => {
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



// Accept quote (public) — client formally accepts a sent quote
// Gap 1 (Phase 2, resolved 2026-07-16): acceptance used to be authenticated by matching the stored
// email address alone. Now gated behind requireBookingAccessToken — the caller must have already
// proven control of the booking's inbox via the /track/request-code + /track/verify-code OTP flow.
app.post('/api/public/bookings/:id/accept-quote', mutateRateLimiter, ipRateLimiter, requireBookingAccessToken, async (req, res) => {
    const { terms_agreed } = req.body;
    const email = req.trackingEmail;
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

                await markQuotationAcceptedAsync(bookingId);

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
                // Shared with the admin QUOTED→ACCEPTED path (applyStatusChange) so the two never diverge.
                const totalAmount = quotedTotal || parseFloat(row.total_amount) || 0;
                await autoBuildDepositBalanceSchedule(bookingId, totalAmount, row.date || row.event_date);

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
            // Client is actively expecting the invoice — generate AND email it (autoSend), unlike the
            // admin acceptance path which produces a DRAFT for review first.
            await generateInvoice(bookingId, { autoSend: true });
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
app.post('/api/public/bookings/:id/quote-revision-request', mutateRateLimiter, ipRateLimiter, requireBookingAccessToken, async (req, res) => {
    const { request_type, message } = req.body;
    const email = req.trackingEmail;
    if (!request_type || !['extension', 'revision'].includes(request_type)) {
        return res.status(400).json({ success: false, message: 'request_type must be "extension" or "revision".' });
    }
    if (!message || message.trim().length < 10) {
        return res.status(400).json({ success: false, message: 'Please provide more detail about your request (at least 10 characters).' });
    }

    db.get("SELECT * FROM bookings WHERE id = ?", [req.params.id], async (err, row) => {
        if (err || !row) return res.status(404).json({ success: false, message: 'Booking not found.' });
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
            await insertBookingNoteFromTracker(row.id, encodeUserHtml(noteText));

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

// Phase 5 (HOUSEKEEPING-NOTES.md): checkDateAvailability moved to lib/calendar-sync.js, alongside
// hasCalendarConflict (its Google-Calendar-aware sibling) — see the require near the top of this
// file for the re-import.

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
        getMinBookingGapSetting((err2, gapRow) => {
            res.json({
                working_hours_start:     (!err && wh) ? wh.start_time : '09:00',
                working_hours_end:       (!err && wh) ? wh.end_time   : '22:00',
                is_working_day:          (!err && wh) ? !!wh.is_working_day : true,
                min_booking_gap_minutes: (!err2 && gapRow) ? parseInt(gapRow.setting_value) || 30 : 30
            });
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

    getActiveHoldDatesForMonth(
        prefix + '%',
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
// Phase 5 (HOUSEKEEPING-NOTES.md): calculateCancellationRefund moved to lib/cancellation-refund.js.
const { calculateCancellationRefund } = require('./lib/cancellation-refund');




// P2.1 — Cancel booking (admin) — writes to cancellations table and notifies client
app.post('/api/admin/bookings/:id/cancel', requireAdmin, async (req, res) => {
    const bookingId = req.params.id;
    const { reason, cancelled_by, notes } = req.body;
    const validCancelledBy = ['client', 'comedian', 'mutual', 'force_majeure'];
    const cancelledBy = validCancelledBy.includes(cancelled_by) ? cancelled_by : 'comedian';

    getBookingById(bookingId, (err, booking) => {
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
            let linkedEventGoogleId = null;
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
                    await cancelBookingAsync(bookingId);

                    await insertCancellationForAdminCancel(bookingId, cancelledBy, reason || null, totalPaid, refundDue, retentionAmount, notes || null, req.session.adminId);

                    await dbRun(
                        `INSERT INTO audit_log (table_name, record_id, action, old_values, new_values, changed_by, change_timestamp)
                         VALUES ('bookings', ?, 'CANCEL', ?, ?, ?, CURRENT_TIMESTAMP)`,
                        [bookingId,
                         JSON.stringify({ status: booking.status, payment_status: booking.payment_status }),
                         JSON.stringify({ status: 'CANCELLED', cancelled_by: cancelledBy, reason: reason || null, refund_due: refundDue, retention: retentionAmount, policy_rule: policyRule }),
                         req.session.adminId || 'admin']);

                    // Release date holds
                    await releaseDateHoldsForBookingAsync(bookingId);
                    // Cascade: void open invoices so admin stops chasing payment
                    await voidInvoicesForCancelledBookingAsync(bookingId);
                    // Cascade: cancel pending payment schedule items
                    await cancelPendingPaymentSchedulesAsync(bookingId);
                    // Cascade: demote the linked event to draft/cancelled AND clear both cross-reference
                    // FKs (bookings.event_id <-> events.booking_id) — this used to only clear the event's
                    // side (booking_id=NULL) while applyStatusChange's CANCELLED branch only cleared the
                    // booking's side (event_id=NULL) and demoted the event, so depending on which of the
                    // two cancellation entry points fired, the pair ended up pointing at each other
                    // inconsistently and a publicly-listed show could keep showing 'upcoming' after its
                    // booking was cancelled. Matches by booking_id (the event's own pointer) rather than
                    // only booking.event_id, so a pre-existing orphaned cross-reference left by that
                    // inconsistency still gets cleaned up here rather than silently skipped.
                    const linkedEvent = await getEventByBookingId(bookingId);
                    if (linkedEvent) linkedEventGoogleId = linkedEvent.google_calendar_event_id || null;
                    await demoteEventForCancelledBookingByBookingIdAsync('Linked booking #' + bookingId + ' was cancelled', bookingId);
                    if (booking.event_id) {
                        await clearBookingPublicAndEventIdAsync(bookingId);
                    }
                    // The event may have its own separate Google Calendar entry (synced via
                    // syncEventToCalendar, independent of the booking's own google_event_id, handled as
                    // a post-commit side effect below alongside it) — without clearing it here too, it
                    // stays live/public on Google even though it's now locally demoted to draft.
                    if (linkedEventGoogleId) {
                        await clearEventGoogleCalendarIdAsync(linkedEvent.event_id);
                    }

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
                // Null it regardless of the delete's outcome above — deleteGoogleEvent() never rejects
                // (it swallows its own errors), and leaving a stale ID here permanently breaks any later
                // sync attempt for this booking (update-against-a-deleted-event fails silently forever).
                clearBookingGoogleEventId(bookingId);
            }
            // The linked event's own separate Google Calendar entry (if any) — already nulled in the DB
            // inside the transaction above; the actual Google delete call happens here, after commit,
            // same as the booking's own event above.
            if (linkedEventGoogleId) deleteGoogleEvent(linkedEventGoogleId);
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
    getBookingById(bookingId, (err, booking) => {
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
        markBookingCompletedManual(bookingId, async function(upErr) {
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
                advanceEventToCompleted(booking.event_id,
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
app.put('/api/admin/bookings/:id/refund', requireAdmin, requireRole(['administrator', 'manager']), async (req, res) => {
    const { refund_amount, refund_reference, notes } = req.body;
    const bookingId = req.params.id;
    const amt = parseFloat(refund_amount) || 0;

    if (amt < 0) {
        return res.status(400).json({ success: false, message: 'Refund amount cannot be negative.' });
    }
    if (amt > 0 && (!refund_reference || !refund_reference.trim())) {
        return res.status(400).json({ success: false, message: 'A payment reference (bank transaction ID or PayFast reference) is required when recording a refund. Process the bank/PayFast transfer first, then record the reference here.' });
    }

    try {
        const row = await getCancellationForRefund(bookingId);
        if (!row) return res.status(404).json({ success: false, message: 'No cancellation record found for this booking.' });

        // Validate against what has ACTUALLY been refunded so far (the transactions ledger — the
        // same source of truth the amount_paid recalculation below reads from), not just the single
        // amount submitted in this call. Comparing `amt` alone against total_paid_to_date let two
        // separate calls each pass the check individually and refund more than the client ever paid.
        const refRow = await getAlreadyRefundedAmount(bookingId);
        const alreadyRefunded = parseFloat(refRow && refRow.already_refunded) || 0;
        const remaining = row.total_paid_to_date - alreadyRefunded;

        if (amt > remaining) {
            return res.status(400).json({
                success: false,
                message: alreadyRefunded > 0
                    ? `Refund amount (R${amt.toFixed(2)}) exceeds the remaining refundable balance (R${remaining.toFixed(2)}). R${alreadyRefunded.toFixed(2)} of R${row.total_paid_to_date.toFixed(2)} paid has already been refunded.`
                    : `Refund amount (R${amt.toFixed(2)}) exceeds total paid (R${row.total_paid_to_date.toFixed(2)}).`
            });
        }

        // refund_amount/reference/notes reflect the running total across possibly multiple partial
        // refunds — overwriting them on each call erased the previous bank reference and understated
        // the total refunded on the client's public tracking page.
        const cumulativeRefund = alreadyRefunded + amt;
        const cumulativeReference = refund_reference
            ? (row.refund_reference ? `${row.refund_reference}; ${refund_reference}` : refund_reference)
            : row.refund_reference || null;
        const cumulativeNotes = notes
            ? (row.refund_notes ? `${row.refund_notes}\n${notes}` : notes)
            : row.refund_notes || null;

        await updateCancellationRefund(cumulativeRefund, cumulativeReference, cumulativeNotes, bookingId);

        // P2-11: Record refund transaction first, then recalculate amount_paid from
        // SUM(transactions) to avoid ledger drift from arithmetic operations.
        await insertRefundTransaction(bookingId, amt, refund_reference || null, notes || `Refund for cancellation of Booking #${bookingId}`)
            .catch(tErr => console.error('[Refund] Transaction log failed:', tErr.message));

        await dbRun(`UPDATE bookings SET
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
                WHERE id = ?`, [bookingId]
        ).catch(bErr => console.error('[Refund] Ledger recalculation failed:', bErr.message));

        db.run(`INSERT OR IGNORE INTO audit_log (table_name, record_id, action, new_values) VALUES ('cancellations', ?, 'REFUND_ISSUED', ?)`,
            [bookingId, JSON.stringify({ refund_amount: amt, refund_reference, cumulative_refund: cumulativeRefund })]);

        // Re-derive payment_status from the recomputed ledger. This route recomputed
        // amount_paid/amount_outstanding but left payment_status stale, so a fully
        // refunded booking stayed marked PAID. Same derivation the /transactions/manual
        // refund branch uses. (trg_auto_payment_status only ever forces PAID when
        // outstanding hits 0, so it cannot demote a refunded booking on its own.)
        const bRow = await getBookingByIdAsync(bookingId);
        if (!bRow) {
            return res.json({ success: true, message: `Refund of R${amt.toFixed(2)} recorded and transaction logged.` });
        }
        const total = parseFloat(bRow.total_amount) || 0;
        const newPaid = parseFloat(bRow.amount_paid) || 0;
        let payment_status;
        if (total > 0 && newPaid >= total)      payment_status = 'PAID';
        else if (newPaid <= 0)                   payment_status = 'UNPAID';
        else if (total > 0 && newPaid >= total * 0.5) payment_status = 'DEPOSIT_PAID';
        else                                     payment_status = 'PARTIALLY_PAID';
        setBookingPaymentStatus(payment_status, bookingId,
            (psErr) => { if (psErr) console.error('[Refund] payment_status re-derivation failed:', psErr.message); });
        // amount_paid dropped — re-run the milestone waterfall so covered rows
        // that are no longer covered fall back to pending.
        alignMilestonePayments(bookingId, newPaid, () => {});

        sendRefundProcessedEmail(bRow, amt, refund_reference)
            .catch(e => console.error('[Refund] Client email failed:', e.message));
        res.json({ success: true, message: `Refund of R${amt.toFixed(2)} recorded and transaction logged.`, payment_status });
    } catch (e) {
        console.error('[Refund] Failed:', e.message);
        res.status(500).json({ success: false, message: 'Server error recording refund.' });
    }
});

// Phase 5 (HOUSEKEEPING-NOTES.md): contractUpload (single-consumer) moved into
// routes/admin/bookings.js alongside the contract routes.

// Phase 5 (HOUSEKEEPING-NOTES.md): DEFAULT_CONTRACT_CLAUSES, CONTRACT_ELIGIBLE_STATUSES,
// resolveContractFeeData, assembleContractHtml, and generateContract all moved to lib/contracts.js.
const { DEFAULT_CONTRACT_CLAUSES, CONTRACT_ELIGIBLE_STATUSES, generateContract } = require('./lib/contracts');















// PUBLIC — client e-signs the contract online (typed-name acknowledgement, two-party model).
// Email-verified like accept-quote (Gap 1 accepted risk). Records the client signature; the admin
// then countersigns via PUT /contract/sign to finalise. The contract PDF is already served
// statically, so this endpoint only captures intent + attribution.
app.post('/api/public/bookings/:id/contract/sign', mutateRateLimiter, ipRateLimiter, requireBookingAccessToken, (req, res) => {
    const bookingId = req.params.id;
    const email = req.trackingEmail;
    const signatoryName = asBookingText(req.body.signatory_name);
    const agreed = req.body.agreed === true || req.body.agreed === 'true';

    if (!agreed) return res.status(400).json({ success: false, message: 'You must confirm your agreement to sign.' });
    if (signatoryName.length < 2 || signatoryName.length > 120) {
        return res.status(400).json({ success: false, message: 'Please enter your full legal name.' });
    }
    const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || 'unknown';

    db.get("SELECT id, email FROM bookings WHERE id = ?", [bookingId], (err, booking) => {
        if (err || !booking) return res.status(404).json({ success: false, message: 'Booking not found.' });
        db.get("SELECT status, is_frozen, signed_by_client_at, pdf_url, content_hash FROM contracts WHERE booking_id = ?", [bookingId], (cErr, contract) => {
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

            // Bind the signature to the exact document signed: hash the actual PDF bytes on disk (works
            // for both generated and uploaded contracts) so the signed version is provable and any later
            // change to the file is detectable. Stored inside client_signature_data alongside attribution.
            let signedFileHash = null;
            try {
                if (contract.pdf_url) {
                    const cpath = resolveDocsPath('contracts', contract.pdf_url);
                    if (fs.existsSync(cpath)) signedFileHash = crypto.createHash('sha256').update(fs.readFileSync(cpath)).digest('hex');
                }
            } catch (hErr) { console.error('[Contract Sign] Could not hash PDF for booking #' + bookingId + ':', hErr.message); }

            // Signature = intent + attribution, bound to the document. Store the typed name,
            // server-stamped time, IP, UA, the signed PDF's hash, and the content_hash of record.
            const signatureData = JSON.stringify({
                name: signatoryName,
                signed_at: new Date().toISOString(),
                ip: clientIp,
                user_agent: (req.headers['user-agent'] || '').slice(0, 300),
                signed_file_sha256: signedFileHash,
                content_hash_at_signing: contract.content_hash || null
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
            insertLegacyBookingFromContactForm(name, email, cell, category, `${subject}\n\n${message}`, function(err) {
                    if (err) console.error("DB Insert Error (Bookings):", err);
                });
        } else {
            const ip_address = req.ip || req.connection.remoteAddress || '';
            const user_agent = req.get('User-Agent') || '';
            const routing_path = req.get('Referrer') || req.originalUrl || '';
            
            insertInquiry(encodeUserHtml(name), email, receiver, cell || '', category || 'Contact Form', encodeUserHtml(subject) || 'No Subject', encodeUserHtml(message), routing_path, ip_address, user_agent, function(err) {
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
const NEWSLETTER_PENDING_MESSAGE = 'Almost there! Check your email to confirm your subscription.';

// Phase 5 (HOUSEKEEPING-NOTES.md): moved to lib/newsletter-emails.js.
const { sendNewsletterWelcomeEmail } = require('./lib/newsletter-emails');

// Fired at signup (and on a cooldown-gated resend) to gate the subscription behind double opt-in.
// Deliberately does NOT fall through to the banner's own headline/subtitle — a custom headline an
// admin later sets on the newsletter_welcome template key must never leak onto this pre-confirmation email.
async function sendNewsletterConfirmationEmail(email, first_name, unsubscribe_token) {
    const { socialLinks } = await getEmailFooterContext();
    const confirmUrl = `${emailBaseUrl()}/confirm-subscription.html?token=${unsubscribe_token}&email=${encodeURIComponent(email)}`;
    const banner = await bannerRegistry.resolveBanner('newsletter_welcome');
    const greeting = applyMergeFields('Hi {{first_name}},', { first_name }, confirmUrl);
    const emailBody = emailComponents.renderPremiumEmail({
        preheaderText: 'One more step — confirm your subscription.',
        bannerSrc: banner?.src, bannerAlt: banner?.alt,
        headline: 'Confirm Your Subscription',
        bodyHtml:
            `<p style="text-align:center;">${greeting}</p>` +
            `<p style="text-align:center;">Please confirm your email address to start receiving Thabiso Mhlongo's newsletter — tour dates, new releases, and exclusive content.</p>` +
            `<p style="text-align:center; color:#B0B0B0;">If you didn't request this, you can safely ignore this email — you won't be subscribed unless you confirm.</p>`,
        cta: { label: 'Confirm My Subscription', url: confirmUrl },
        socialLinks
    });
    return sendEmail({
        to: email,
        subject: "Confirm Your Subscription to Thabiso Mhlongo's Newsletter",
        htmlContent: emailBody,
        preWrapped: true,
        titleOverride: 'Confirm your subscription',
        trigger_event: 'Newsletter: Confirmation Request'
    });
}

app.post('/api/public/subscribe', ipRateLimiter, (req, res) => {
    let { email, popia_consent, first_name, birthday_day, birthday_month } = req.body;
    if (!email) {
        return res.status(400).json({ success: false, message: 'Email is required' });
    }
    email = sanitizeEmailInput(email);
    if (!EMAIL_FORMAT_RE.test(email)) {
        return res.status(400).json({ success: false, message: 'Please enter a valid email address.' });
    }
    first_name = (typeof first_name === 'string') ? sanitizeEmailInput(first_name).slice(0, 100) : '';
    if (!first_name) {
        return res.status(400).json({ success: false, message: 'First name is required.' });
    }

    // Validate POPIA consent
    if (!popia_consent) {
        return res.status(400).json({ success: false, message: 'POPIA consent is required to subscribe.' });
    }

    // Birthday is optional — day/month only, never a year (see newsletter_subscribers schema).
    let birthdayDayVal = null, birthdayMonthVal = null;
    const hasDay = birthday_day != null && birthday_day !== '';
    const hasMonth = birthday_month != null && birthday_month !== '';
    if (hasDay || hasMonth) {
        if (!hasDay || !hasMonth || !isValidBirthday(birthday_day, birthday_month)) {
            return res.status(400).json({ success: false, message: 'Please provide a valid birthday day and month.' });
        }
        birthdayDayVal = parseInt(birthday_day, 10);
        birthdayMonthVal = parseInt(birthday_month, 10);
    }

    const ip_address = req.ip || req.connection.remoteAddress || 'unknown';
    const user_agent = req.get('User-Agent') || 'unknown';
    const source = 'index.html';
    console.log(`[Newsletter] Attempting subscription for: ${email} from ${ip_address}`);

    const unsubscribe_token = crypto.randomBytes(16).toString('hex');

    // Double opt-in: new signups start pending, not active — they only count toward campaigns
    // (status='active' everywhere) and get the real welcome email once they confirm.
    insertPendingSubscriber(email, unsubscribe_token, ip_address, user_agent, source, CURRENT_POLICY_VERSION, first_name, birthdayDayVal, birthdayMonthVal, function(err) {
        if (err) {
            if (!err.message.includes('UNIQUE')) {
                console.error("Newsletter Subscription DB Error:", err.message);
                return res.status(500).json({ success: false, message: 'Server error: ' + err.message });
            }
            // Duplicate email — branch on the existing row's status rather than a flat reject.
            // All non-'active' branches return the SAME response body: differentiating "brand new"
            // vs. "resend" vs. "reactivating" in the response would let an attacker learn an
            // email's subscription history without ever proving they control that inbox.
            getSubscriberDuplicateCheck(email, (selErr, row) => {
                if (selErr || !row) return res.status(500).json({ success: false, message: 'Server error.' });

                if (row.status === 'active') {
                    return res.status(409).json({ success: false, message: 'You are already subscribed!' });
                }

                if (row.status === 'pending_confirmation') {
                    // Cooldown-gated resend (5 min, keyed off modified_on — no new column) so
                    // repeatedly resubmitting the same email can't be used to bomb an inbox.
                    touchSubscriberCooldown(row.subscriber_id, function(cooldownErr) {
                        if (!cooldownErr && this.changes > 0) {
                            sendNewsletterConfirmationEmail(email, first_name, row.unsubscribe_token).catch(e => console.error('Error resending confirmation email to ' + email + ':', e));
                        }
                        res.json({ success: true, message: NEWSLETTER_PENDING_MESSAGE });
                    });
                    return;
                }

                // status === 'unsubscribed' (the bug fix): a genuine resubscribe. Reuse the
                // existing unsubscribe_token (any unsubscribe link from a past campaign keeps working)
                // and re-capture consent/profile fields fresh from this submission.
                reactivateSubscriber(CURRENT_POLICY_VERSION, first_name, birthdayDayVal, birthdayMonthVal, ip_address, user_agent, source, row.subscriber_id, (reErr) => {
                    if (reErr) return res.status(500).json({ success: false, message: 'Server error.' });
                    sendNewsletterConfirmationEmail(email, first_name, row.unsubscribe_token).catch(e => console.error('Error sending confirmation email to ' + email + ':', e));
                    res.json({ success: true, message: NEWSLETTER_PENDING_MESSAGE });
                });
            });
            return;
        }
        console.log(`[Newsletter] DB Insert SUCCESS (pending confirmation) for: ${email}`);

        sendNewsletterConfirmationEmail(email, first_name, unsubscribe_token)
            .catch(e => console.error("Error sending confirmation email to " + email + ":", e));

        res.json({ success: true, message: NEWSLETTER_PENDING_MESSAGE });
    });
});

// Confirm a pending subscription (double opt-in).
app.post('/api/public/newsletter/confirm', ipRateLimiter, (req, res) => {
    const { email, token } = req.body;
    if (!email || !token) {
        return res.status(400).json({ success: false, message: 'Missing required parameters.' });
    }

    getSubscriberForConfirm(email, token, (err, row) => {
        if (err) return res.status(500).json({ success: false, error: err.message });
        if (!row) return res.status(404).json({ success: false, message: 'Invalid confirmation link or subscriber not found.' });

        if (row.status === 'active') {
            return res.json({ success: true, message: 'Your subscription is already confirmed!', alreadyConfirmed: true });
        }
        if (row.status !== 'pending_confirmation') {
            // e.g. 'unsubscribed' — a stale confirm link from before they unsubscribed must NOT
            // silently reactivate them; that would bypass the POPIA consent re-capture that a
            // genuine resubscribe through the public form always performs.
            return res.status(409).json({ success: false, message: 'This subscription is no longer active. Please sign up again to resubscribe.' });
        }

        confirmSubscriber(row.subscriber_id, (uErr) => {
            if (uErr) return res.status(500).json({ success: false, error: uErr.message });
            sendNewsletterWelcomeEmail(email, row.first_name, row.unsubscribe_token).catch(e => console.error('Error sending welcome email to ' + email + ':', e));
            res.json({ success: true, message: 'Subscription confirmed! Welcome aboard.' });
        });
    });
});

// Unsubscribe API
app.post('/api/public/newsletter/unsubscribe', ipRateLimiter, (req, res) => {
    const { email, token } = req.body;
    if (!email || !token) {
        return res.status(400).json({ success: false, message: 'Missing required parameters.' });
    }

    getSubscriberForUnsubscribe(email, token, (err, row) => {
        if (err) return res.status(500).json({ success: false, error: err.message });
        if (!row) return res.status(404).json({ success: false, message: 'Invalid unsubscription link or subscriber not found.' });

        unsubscribeSubscriber(row.subscriber_id, (uErr) => {
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

// ==========================================
// Public Events Route
// ==========================================
// (Consolidated into the events module below)

// ==========================================
// Admin CRUD Routes (Protected)
// ==========================================

// Phase 5 (HOUSEKEEPING-NOTES.md): findOrCreateClient/findOrCreateVenueFromPlace moved to
// lib/client-venue.js.
const { findOrCreateClient, findOrCreateVenueFromPlace } = require('./lib/client-venue');













// ============================================================
// Legal & Compliance Centre — /api/admin/legal/*
// Reads use requireAdmin; writes (draft/publish/restore) require the administrator role (Gate 4).
// computeNextLegalVersion moved to routes/admin/legal.js — its only caller.
// ============================================================










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



app.get('/api/public/branding', (req, res) => {
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
        COALESCE(b.name, c.full_name) AS name,
        COALESCE(b.email, c.email) AS email,
        COALESCE(b.cell, c.phone) AS cell,
        COALESCE(b.company, c.company_name) AS company,
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
        (SELECT id FROM bookings WHERE rebooked_from_id = b.id LIMIT 1) AS rebooked_as_id,
        ct.status AS contract_status,
        ct.is_frozen AS contract_is_frozen,
        ct.pdf_url AS contract_pdf_url,
        ct.sent_to_client_at AS contract_sent_at,
        ct.signed_by_client_at AS contract_signed_by_client_at,
        COALESCE(b.disposition, 'active') AS disposition
      FROM bookings b
      LEFT JOIN venues v ON b.venue_id = v.id
      LEFT JOIN clients c ON b.client_id = c.id
      LEFT JOIN quotations lq ON lq.id = (SELECT MAX(id) FROM quotations WHERE booking_id = b.id AND UPPER(status) != 'VOID')
      LEFT JOIN contracts ct ON ct.booking_id = b.id
      ${whereClause}
      ORDER BY b.created_at DESC LIMIT ? OFFSET ?`, params, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});





// --- Bookings ---

// Admin: manually create a booking (bypasses public rate limiter + POPIA form)
app.post('/api/admin/bookings', requireAdmin, requireRole(['administrator', 'manager']), async (req, res) => {
    const { name, email, cell, company, event_date, event_start_time,
            event_name, event_type, event_location, status, budget_range, message,
            venue_place_id, city, venue_address, country, services, override_conflict,
            override_duplicate, override_working_hours, popia_consent, source_inquiry_id } = req.body;

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
        getActiveDuplicateBookingForEmailDate(email, event_date, (_, row) => resolve(row))
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
                    const lockedDuplicate = await getActiveDuplicateBookingForEmailDateAsync(email, event_date);
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

                const sourceInquiryId = source_inquiry_id ? parseInt(source_inquiry_id) : null;

                const ins = await insertAdminBooking([
                    name, company || null, email, cell, event_name, event_date,
                    event_start_time || null, event_start_time || null,
                    perfEndTime, String(durationMins),
                    event_type, event_location,
                    city || null, venue_place_id || null,
                    budget_range || null, message, bookingStatus,
                    consentVal, clientId, venueId,
                    initialQuoteAmountStr, initialTotalAmount, initialTotalAmount, paymentStatus, defaultQuoteExpiry, CURRENT_POLICY_VERSION, 'admin',
                    sourceInquiryId && !isNaN(sourceInquiryId) ? sourceInquiryId : null
                ]);
                const bookingId = ins.lastID;

                if (sourceInquiryId && !isNaN(sourceInquiryId)) {
                    await linkInquiryToBooking(bookingId, sourceInquiryId);
                }

                // The consent record, the services and the audit row are part of the booking, not an
                // afterthought. These used to run AFTER `COMMIT` with their errors swallowed by a bare
                // console.error, so a failed insert left a committed booking with no services — and the
                // route still answered 200 success. They are now inside the transaction.
                await dbRun(
                    `INSERT INTO consent_audit (booking_id, ip_address, user_agent, policy_version, consent_source) VALUES (?, ?, ?, ?, 'admin_recorded')`,
                    [bookingId, req.ip || null, req.headers['user-agent'] || null, CURRENT_POLICY_VERSION]
                );

                for (const srv of selectedServices) {
                    await insertBookingService(bookingId, srv.service_id, srv.quantity_minutes, srv.unit_price, srv.total_price);
                    await insertBookingLineItem(bookingId, srv.service_id, srv.name, srv.quantity_minutes, srv.unit_price);
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
            COALESCE(b.name, c.full_name) AS name,
            COALESCE(b.email, c.email) AS email,
            COALESCE(b.cell, c.phone) AS cell,
            COALESCE(b.company, c.company_name) AS company,
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
            li.due_date AS invoice_due_date,
            ct.status AS contract_status,
            ct.is_frozen AS contract_is_frozen,
            ct.pdf_url AS contract_pdf_url,
            ct.sent_to_client_at AS contract_sent_at,
            ct.signed_by_client_at AS contract_signed_by_client_at
          FROM bookings b
          LEFT JOIN venues v ON b.venue_id = v.id
          LEFT JOIN clients c ON b.client_id = c.id
          LEFT JOIN quotations lq ON lq.id = (SELECT MAX(id) FROM quotations WHERE booking_id = b.id AND archived = 0)
          LEFT JOIN invoices li ON li.id = (SELECT MAX(id) FROM invoices WHERE booking_id = b.id AND status NOT IN ('void','VOID'))
          LEFT JOIN contracts ct ON ct.booking_id = b.id
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
        COALESCE(b.name, c.full_name) AS name,
        COALESCE(b.email, c.email) AS email,
        COALESCE(b.cell, c.phone) AS cell,
        COALESCE(b.company, c.company_name) AS company,
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
        li.due_date AS invoice_due_date,
        ct.status AS contract_status,
        ct.is_frozen AS contract_is_frozen,
        ct.pdf_url AS contract_pdf_url,
        ct.sent_to_client_at AS contract_sent_at,
        ct.signed_by_client_at AS contract_signed_by_client_at
      FROM bookings b
      LEFT JOIN venues v ON b.venue_id = v.id
      LEFT JOIN clients c ON b.client_id = c.id
      LEFT JOIN quotations lq ON lq.id = (SELECT MAX(id) FROM quotations WHERE booking_id = b.id AND archived = 0)
      LEFT JOIN cancellations cnl ON cnl.booking_id = b.id
      LEFT JOIN invoices li ON li.id = (SELECT MAX(id) FROM invoices WHERE booking_id = b.id AND status NOT IN ('void','VOID'))
      LEFT JOIN contracts ct ON ct.booking_id = b.id
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
        const chk = await getBookingOutstandingForCompleteGuard(bookingId);
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
    // modified_by/modified_by_role are set here in the same UPDATE so the audit_bookings_update
    // trigger can read them via NEW.modified_by(_role) into audit_log.actor_role — this replaces the
    // parallel explicit audit_log insert that used to sit below, which double-wrote a row for every
    // status change (once here, once from the trigger that already fires on any bookings UPDATE).
    updateBookingStatusCore(requestedStatus, tsField, options.adminId, options.role, bookingId, async function(upErr) {
        if (upErr) return res.status(500).json({ success: false, error: upErr.message });
        const actor = await resolveActor(options.adminId);
        getBookingById(bookingId, async (e, b) => {
            if (!e && b) {
                if (b.event_id && !['ACCEPTED', 'CONFIRMED', 'COMPLETED'].includes(requestedStatus)) {
                    clearBookingPublicAndEventId(bookingId);
                    // On cancellation, switch the linked public event to draft rather than deleting it.
                    // Also clears events.booking_id — matches POST /:id/cancel's identical cascade
                    // (see that route) so both cancellation entry points leave the same state instead of
                    // each clearing only one side of the bookings.event_id <-> events.booking_id pair.
                    if (requestedStatus === 'CANCELLED') {
                        getEventGoogleCalendarId(b.event_id, (evErr, evRow) => {
                            demoteEventForCancelledBooking('Linked booking #' + bookingId + ' was cancelled', b.event_id);
                            // The event may have its own separate Google Calendar entry (synced via
                            // syncEventToCalendar, independent of the booking's own google_event_id
                            // handled above) — without this it stays live/public on Google even though
                            // it's now locally demoted to draft.
                            if (!evErr && evRow && evRow.google_calendar_event_id) {
                                deleteGoogleEvent(evRow.google_calendar_event_id);
                                clearEventGoogleCalendarId(b.event_id);
                            }
                        });
                    }
                }

                if (requestedStatus === 'CANCELLED') {
                    const reason = options.reason || 'Booking cancelled by admin';
                    await deleteGoogleEvent(b.google_event_id);
                    // Null it now that we've asked Google to delete it, or any later sync attempt for
                    // this booking silently fails forever (update-against-a-deleted-event, never
                    // falls back to re-creating it — see the identical fix in POST /:id/cancel).
                    if (b.google_event_id) clearBookingGoogleEventId(bookingId);
                    // E1: store cancellation reason/attribution AND run the SAME financial + hold
                    // cascade as POST /api/admin/bookings/:id/cancel, so cancelling via the status
                    // API leaves an identical state (previously this path skipped payment_status,
                    // invoice void, schedule cancel and hold release).
                    // Same trigger constraint as the dedicated cancel route: 'CANCELLED' is not a legal
                    // payment_status, and this statement had no error callback — so the ABORT silently
                    // discarded cancellation_reason and cancelled_by along with it.
                    setBookingCancellationAttribution(reason, bookingId,
                        (e) => { if (e) console.error('[Status Cancel] Failed to record cancellation attribution:', e.message); });
                    releaseDateHoldsForBooking(bookingId,
                        (e) => { if (e) console.error('[Status Cancel] Hold release failed:', e.message); });
                    voidInvoicesForCancelledBooking(bookingId,
                        (e) => { if (e) console.error('[Status Cancel] Invoice void failed:', e.message); });
                    cancelPendingPaymentSchedules(bookingId,
                        (e) => { if (e) console.error('[Status Cancel] Payment schedule cancel failed:', e.message); });
                    // Apply the same refund policy calculator used by client self-cancellation
                    db.get("SELECT policy_value FROM policies WHERE policy_key = 'cancellation_policy'", [], (pErr, policy) => {
                        const calc = calculateCancellationRefund(b, policy ? policy.policy_value : '');
                        // D-1: cancellations.cancelled_by has a CHECK IN ('client','comedian','mutual','force_majeure')
                        // — 'admin' violated it, so this INSERT failed silently (no cancellation record via the
                        // status API). Use 'comedian' (business-initiated), matching the dedicated /cancel endpoint's
                        // default for admin-initiated cancellations. Attribution to admin stays on bookings.cancelled_by.
                        insertCancellationForStatusChange(bookingId, reason, calc.totalPaid, calc.refund, calc.retention,
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
                    markQuotationAccepted(bookingId, (err) => {
                        if (err) console.error('[Status Change] Failed to update quotation status to accepted:', err.message);
                    });
                    sendQuoteAcceptedEmail(b).catch(e => console.error('Invoiced email failed:', e.message));
                    // Parity with client self-acceptance: build the deposit/balance schedule + a DRAFT
                    // invoice (admin reviews & sends, unlike the client path which emails immediately) +
                    // a draft contract — so admin-accept and client-accept leave identical state instead
                    // of admin-accept leaving the booking bare. Fire-and-forget with logging, matching
                    // the other post-status side effects; a refresh reflects it.
                    (async () => {
                        try {
                            const total = parseFloat(b.total_amount) || 0;
                            await withDbTransaction(async () => {
                                await dbRun("BEGIN IMMEDIATE");
                                try {
                                    await autoBuildDepositBalanceSchedule(b.id, total, b.date);
                                    await dbRun("COMMIT");
                                } catch (schErr) { await dbRun("ROLLBACK").catch(() => {}); throw schErr; }
                            });
                            await generateInvoice(b.id, { autoSend: false }); // DRAFT — admin sends explicitly
                            await generateContract(b.id).catch(cErr => console.error('[Status Accept] Contract draft failed:', cErr.message));
                        } catch (finErr) {
                            console.error('[Status Accept] Auto-finalize failed for booking #' + b.id + ':', finErr.message);
                        }
                    })();
                }
                if (requestedStatus === 'QUOTED') {
                    // Revert active quotation's status to 'sent'
                    revertQuotationToSent(bookingId, (err) => {
                        if (err) console.error('[Status Change] Failed to revert quotation status to sent:', err.message);
                    });
                }
                if (requestedStatus === 'CONFIRMED') {
                    sendBookingConfirmedEmail(b).catch(e => console.error('Confirmed email failed:', e.message));
                    // Auto-create an events row if none exists yet for this booking
                    if (!b.event_id) {
                        const eventDatetime = b.date + (b.event_start_time ? ' ' + b.event_start_time : ' 00:00:00');
                        insertAutoCreatedEvent(
                            b.event_name || b.event_type || 'Booking Event', eventDatetime, b.event_location || null, b.venue_id || null, b.id,
                            function(evInsErr) {
                                if (evInsErr) { console.error('[Auto-Event] Insert failed for booking #' + b.id + ':', evInsErr.message); return; }
                                setBookingEventId(this.lastID, b.id,
                                    (evUpErr) => { if (evUpErr) console.error('[Auto-Event] Booking event_id link failed:', evUpErr.message); });
                            }
                        );
                    }
                }
                if (requestedStatus === 'COMPLETED') {
                    sendBookingCompletedEmail(b).catch(e => console.error('Completed email failed:', e.message));
                    sendAdminCompletionSummaryEmail(b).catch(e => console.error('Admin completion summary failed:', e.message));
                    // S6-4: Auto-mark invoice as paid when booking is completed with full payment
                    markInvoicePaidOnStatusComplete(b.id);
                    // Parity with the dedicated POST /:id/complete route and the hourly auto-complete
                    // sweep — both advance the linked event; this generic status path used to leave it
                    // stuck at 'upcoming' when completed via PUT /:id or /:id/status instead.
                    if (b.event_id) {
                        advanceEventToCompleted(b.event_id);
                    }
                }
            }
        });
        res.json({ success: true, newStatus: requestedStatus, last_updated: { name: actor.name, role: actor.role, at: new Date().toISOString() } });
    });
}

app.put('/api/admin/bookings/:id', requireAdmin, (req, res) => {
    const { status, reason } = req.body;
    if (!status) return res.status(400).json({ success: false, message: 'status field required.' });
    getBookingStatus(req.params.id, (err, row) => {
        if (err || !row) return res.status(404).json({ success: false, message: 'Booking not found.' });
        applyStatusChange(req.params.id, status.toUpperCase(), (row.status || '').toUpperCase(), res, { reason, adminId: req.session.adminId, role: req.session.role });
    });
});

app.patch('/api/admin/bookings/:id/buffer', requireAdmin, (req, res) => {
    const id = parseInt(req.params.id);
    const raw = req.body.buffer_minutes;
    const mins = (raw === null || raw === '') ? null : parseInt(raw);
    if (mins !== null && (isNaN(mins) || mins < 0 || mins > 480)) {
        return res.status(400).json({ success: false, message: 'Buffer must be 0–480 minutes or null.' });
    }
    updateBookingBuffer(mins, id, function(err) {
        if (err) return res.status(500).json({ success: false, error: err.message });
        if (this.changes === 0) return res.status(404).json({ success: false, message: 'Booking not found.' });
        res.json({ success: true, buffer_minutes: mins });
    });
});





// Phase 5 (HOUSEKEEPING-NOTES.md): the entire Advancing Pack feature (all 12 routes plus
// sendAdvancingPackEmail/ensureAdvancingPack/verifyRosOwnership/verifyAdvancingContactOwnership/
// resolveAdvancingContacts, all single-consumer) moved to routes/admin/advancing.js.


/**
 * GET /api/calendar/feed.ics
 * Public (signed) ICS feed for external calendar sync
 */
app.get('/api/calendar/feed.ics', async (req, res) => {
    const expectedToken = process.env.CALENDAR_FEED_SECRET;
    // Fail CLOSED, not open: this feed lists every client's name, event and location. An unset
    // secret previously made the whole feed public rather than blocking it.
    if (!expectedToken) {
        console.error('[Calendar Feed] CALENDAR_FEED_SECRET is not configured — refusing to serve the feed.');
        return res.status(503).type('text').send('Calendar feed is not configured.');
    }
    if (req.query.token !== expectedToken) {
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

        // ical-generator throws synchronously on an invalid date, and that throw was uncaught here
        // (inside a db.all callback, several stack frames from any try/catch) — one malformed
        // date/time value on a single row crashed the entire Node process, taking the whole site
        // down for every request, not just this feed. Each event is now isolated so a bad record
        // is skipped and logged instead.
        bookings.forEach(b => {
            try {
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
            } catch (evErr) {
                console.error(`[Calendar Feed] Skipped booking #${b.id} — invalid date/time on record:`, evErr.message);
            }
        });

        getActiveDateHoldsForIcsFeed((err, holds) => {
            if (!err) {
                holds.forEach(h => {
                    try {
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
                    } catch (hErr) {
                        console.error(`[Calendar Feed] Skipped hold on ${h.hold_date} — invalid date/time on record:`, hErr.message);
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
                    insertPublicEvent(
                        eventTitle, eventDesc, eventDatetime,
                        venueName, booking.venue_id || null, mapLink, cleanLink,
                        bookingId, req.session.adminId, ip_address, user_agent,
                        function(insertErr) {
                            if (insertErr) return res.status(500).json({ success: false, message: insertErr.message });
                            const newEventId = this.lastID;

                            setBookingPublicWithNewEvent(
                                cleanLink, newEventId, bookingId,
                                function(updateErr) {
                                    if (updateErr) return res.status(500).json({ success: false, message: updateErr.message });
                                    sendResponse();
                                }
                            );
                        }
                    );
                };

                if (booking.event_id) {
                    checkEventExistsById(booking.event_id, (checkErr, eventRow) => {
                        if (checkErr) return res.status(500).json({ success: false, message: checkErr.message });
                        if (eventRow) {
                            updatePublicEvent(
                                eventTitle, eventDesc, eventDatetime,
                                venueName, booking.venue_id || null, mapLink, cleanLink,
                                req.session.adminId, ip_address, user_agent,
                                booking.event_id,
                                function(updateEventErr) {
                                    if (updateEventErr) return res.status(500).json({ success: false, message: updateEventErr.message });
                                    
                                    setBookingPublicTicketLink(
                                        cleanLink, bookingId,
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
                    clearBookingPublicWithEvent(
                        bookingId,
                        function(updateErr) {
                            if (updateErr) return res.status(500).json({ success: false, message: updateErr.message });
                            
                            deleteEventById(booking.event_id, function(deleteErr) {
                                if (deleteErr) return res.status(500).json({ success: false, message: deleteErr.message });
                                sendResponse();
                            });
                        }
                    );
                } else {
                    clearBookingPublicTicketLink(
                        bookingId,
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
    getBookingStatus(req.params.id, (err, row) => {
        if (err || !row) return res.status(404).json({ success: false, message: 'Booking not found' });
        applyStatusChange(req.params.id, requestedStatus, (row.status || '').toUpperCase(), res, { reason, adminId: req.session.adminId, role: req.session.role });
    });
});

// PUT /api/admin/bookings/:id/disposition — booking triage (soft-decline). Deliberately NOT
// routed through applyStatusChange/ALLOWED_TRANSITIONS: disposition is an orthogonal axis (same
// pattern as payment_status alongside status) so declining a bad-fit lead as "not a fit" or
// shelving it as "archived" doesn't touch the pipeline state machine and doesn't read as a
// cancelled deal in the audit trail or conversion analytics.
const BOOKING_DISPOSITIONS = ['active', 'not_a_fit', 'archived'];
app.put('/api/admin/bookings/:id/disposition', requireAdmin, (req, res) => {
    const bookingId = req.params.id;
    const disposition = req.body.disposition;
    if (!BOOKING_DISPOSITIONS.includes(disposition)) {
        return res.status(400).json({ success: false, message: `disposition must be one of: ${BOOKING_DISPOSITIONS.join(', ')}` });
    }
    getBookingDisposition(bookingId, (err, row) => {
        if (err) return res.status(500).json({ success: false, message: err.message });
        if (!row) return res.status(404).json({ success: false, message: 'Booking not found' });
        const previous = row.disposition || 'active';
        updateBookingDisposition(disposition, bookingId, function(upErr) {
            if (upErr) return res.status(500).json({ success: false, message: upErr.message });
            db.run(`INSERT INTO audit_log (table_name, record_id, action, old_values, new_values, changed_by, change_timestamp)
                    VALUES ('bookings', ?, 'DISPOSITION', ?, ?, ?, CURRENT_TIMESTAMP)`,
                [bookingId, JSON.stringify({ disposition: previous }), JSON.stringify({ disposition }), req.session.adminId || 'admin'],
                (aErr) => { if (aErr) console.error('[Audit] Disposition change log failed:', aErr.message); });
            res.json({ success: true, disposition });
        });
    });
});


// ==========================================
// Financial & Invoicing Routes
// ==========================================

// 1. Generate Invoice from Booking (Admin)
app.post('/api/admin/bookings/:id/invoice/generate', requireAdmin, requireRole(['administrator', 'manager']), async (req, res) => {
    const bookingId = req.params.id;
    // Guard: if a quotation exists for this booking it must be in 'accepted' state
    const activeQuote = await getActiveQuoteStatusForInvoiceGuard(bookingId).catch(() => null);

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


// 2.5 Ledger reconciliation sync — force aligns bookings totals to transactions
app.post('/api/admin/bookings/:id/reconcile/sync', requireAdmin, requireRole(['administrator', 'manager']), (req, res) => {
    const bookingId = req.params.id;
    getTransactionsPaidSumForReconcile(
        bookingId,
        (err, row) => {
            if (err) return res.status(500).json({ success: false, message: 'Database error counting transactions: ' + err.message });
            
            const txPaid = parseFloat(row.tx_paid) || 0;
            
            getBookingById(bookingId, (bookErr, booking) => {
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
                
                updateBookingLedgerFromReconcile(
                    txPaid, outstanding, payment_status, newStatus, bookingId,
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
                                markInvoicePaidIfOpen(bookingId);
                            }
                        })();
                        
                        res.json({ success: true, message: 'Ledger aligned and booking synced successfully.', amount_paid: txPaid, amount_outstanding: outstanding, payment_status });
                    }
                );
            });
        }
    );
});








// Public: venue autocomplete via Google Places API proxy
app.get('/api/public/places/autocomplete', ipRateLimiter, (req, res) => {
    const input = (req.query.input || '').trim();
    if (input.length < 2) return res.json({ predictions: [] });
    const apiKey = process.env.GOOGLE_MAPS_API_KEY || '';
    if (!apiKey) {
        console.warn('[Places] GOOGLE_MAPS_API_KEY is not set — venue autocomplete will always return zero results until it is configured.');
        return res.json({ predictions: [] });
    }
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
                    if (data.status !== 'ZERO_RESULTS') console.warn('[Places] autocomplete returned', data.status, data.error_message || '');
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
    if (!apiKey) {
        console.warn('[Places] GOOGLE_MAPS_API_KEY is not set — venue details lookup cannot run.');
        return res.status(404).json({ error: 'Place not found' });
    }
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
                    if (data.status !== 'ZERO_RESULTS') console.warn('[Places] details returned', data.status, data.error_message || '');
                    res.status(404).json({ error: 'Place not found' });
                }
            } catch(e) { res.status(500).json({ error: 'Server error' }); }
        });
    }).on('error', () => res.status(500).json({ error: 'Network error' }));
});


// Admin: serve a booking attachment file
app.get('/api/admin/booking-attachments/:filename', requireAdmin, (req, res) => {
    const filePath = resolveDocsPath('booking_attachments', req.params.filename);
    if (!fs.existsSync(filePath)) return res.status(404).send('File not found.');
    res.sendFile(filePath);
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




// 3.6 Payment Schedules API (Admin)
// GET /api/admin/bookings/:id/payment-schedules — get schedules for a booking
app.get('/api/admin/bookings/:id/payment-schedules', requireAdmin, (req, res) => {
    const bookingId = req.params.id;
    db.get("SELECT total_amount, (SELECT COALESCE(SUM(expected_amount), 0) FROM payment_schedules WHERE booking_id = ? AND LOWER(COALESCE(status,'pending')) NOT IN ('superseded','cancelled')) AS scheduled_total FROM bookings WHERE id = ?", [bookingId, bookingId], (bErr, booking) => {
        if (bErr || !booking) return res.status(404).json({ success: false, message: 'Booking not found.' });
        
        getActivePaymentSchedules(bookingId, (err, rows) => {
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
    
    getBookingTotalAmount(bookingId, (bErr, booking) => {
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
            deletePaymentSchedulesForBooking(bookingId, (delErr) => {
                if (delErr) return res.status(500).json({ success: false, message: delErr.message });

                if (schedules.length === 0) {
                    return res.json({ success: true, message: 'Payment schedules cleared.' });
                }

                const stmt = prepareInsertPaymentSchedule();
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
    getBookingTotalAmount(bookingId, (bErr, booking) => {
        if (bErr || !booking) return res.status(404).json({ success: false, message: 'Booking not found.' });
        const total = parseFloat(booking.total_amount) || 0;
        if (total <= 0) return res.status(400).json({ success: false, message: 'Set a booking total before rebalancing the schedule.' });

        getActivePaymentSchedules(bookingId, (err, schedules) => {
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
                const stmt = prepareUpdatePaymentScheduleAmount();
                let upErr = null;
                newAmounts.forEach(u => stmt.run([u.amount, u.id], e => { if (e) upErr = e; }));
                stmt.finalize((finErr) => {
                    if (upErr || finErr) return res.status(500).json({ success: false, message: (upErr || finErr).message });

                    db.run(`INSERT INTO audit_log (table_name, record_id, action, changed_by, changes_json) VALUES ('payment_schedules', ?, 'REBALANCE_SCHEDULE', ?, ?)`,
                        [bookingId, req.session.adminId || req.session.username || 'admin', JSON.stringify({ total, paidSum, remaining, milestones: newAmounts })], () => {});

                    updateBookingMilestones(bookingId, () => {
                        getActivePaymentSchedules(bookingId, (e2, rows) => {
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



// Phase 5 (HOUSEKEEPING-NOTES.md): expense-tracking admin routes (and VALID_EXPENSE_CATEGORIES,
// receiptStorage/uploadReceipt above) moved to routes/admin/expenses.js.







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

    insertManualTransaction(
        booking_id || null, amt, transaction_type, normalizedMethod, reference || null, finalNotes, txDate,
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
                    getBookingById(booking_id, (bookErr, row) => {
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

                        applyManualTransactionPaymentToBooking(
                            payment_status, paid, outstanding, total, newStatus, booking_id,
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
                                        markInvoicePaidIfOpen(booking_id);
                                        getBookingById(booking_id, (e, updated) => {
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
                    getBookingById(booking_id, (bookErr, row) => {
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
                        updateBookingLedgerAfterManualRefund(
                            newPaid, outstanding, payment_status, booking_id, (upErr) => {
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
                    getBookingById(booking_id, (bookErr, row) => {
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

                        updateBookingLedgerAfterAdjustment(
                            payment_status, newTotal, outstanding, newStatus, booking_id,
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
                                    getOpenInvoiceIdForAdjustmentRegen(booking_id, async (invErr, invRow) => {
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
    "DELETE FROM reminders_log WHERE booking_id = ?",
    // Added after an end-to-end booking-flow audit found these missing — any booking a client had
    // tracked, or that had an Advancing Pack started, was undeletable (FK constraint failure).
    "DELETE FROM booking_access_codes WHERE booking_id = ?",
    "DELETE FROM booking_access_tokens WHERE booking_id = ?",
    // run_of_show_items / advancing_contacts cascade automatically via their own ON DELETE CASCADE
    // from advancing_packs(id) — only the parent row needs an explicit purge here.
    "DELETE FROM advancing_packs WHERE booking_id = ?"
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
        const booking = await getBookingByIdAsync(id);
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

                const del = await deleteBookingById(id);
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



// Phase 5 (HOUSEKEEPING-NOTES.md): the entire events cluster — VALID_EVENT_STATUSES,
// VALID_EVENT_TYPES, checkEventConflicts, and all 6 /api/admin/events/* routes — moved to
// routes/admin/events.js. Single-consumer within that cluster; nothing else in app.js referenced
// any of the three.




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
            markBookingPendingAfterRespond(bookingId, function(err) {
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

// --- Footprint (countries performed in) — mirrors Career Highlights' route shape exactly ---
app.get('/api/public/footprint', (req, res) => { // Public route for index.html
    db.all("SELECT * FROM footprint_countries ORDER BY display_order ASC, created_at DESC", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// --- Testimonials (visitor-submitted, admin-moderated) ---
app.get('/api/public/testimonials', (req, res) => { // Public: approved only
    db.all("SELECT * FROM testimonials WHERE status = 'approved' ORDER BY display_order ASC, created_at DESC", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});
// Public submission — rate-limited, restricted (non-SVG) upload, always starts pending review.
app.post('/api/public/testimonials', ipRateLimiter, publicImageUpload.single('file'), (req, res) => {
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
app.get('/api/public/home-slider', (req, res) => {
    db.all("SELECT * FROM home_slider ORDER BY display_order ASC", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
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
    db.all("SELECT * FROM gallery_images ORDER BY display_order ASC, created_at DESC", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
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



// Phase 5 (HOUSEKEEPING-NOTES.md): the email-templates admin routes (and SYSTEM_TRACK_TEMPLATE_KEYS)
// moved to routes/admin/email-templates.js.












// --- Manager Details ---
app.get('/api/public/manager', (req, res) => {
    db.get("SELECT * FROM manager_details ORDER BY manager_id ASC LIMIT 1", [], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(row || null);
    });
});



// --- Contact Info ---
app.get('/api/public/contact_info', (req, res) => {
    db.get("SELECT * FROM contact_info ORDER BY quote_id ASC LIMIT 1", [], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(row || { email: '', quote: '', signature: '' }); // Safety fallback obj 
    });
});



// --- Social Links ---
app.get('/api/public/social_links', (req, res) => {
    db.all("SELECT * FROM social_links WHERE is_active = 1 ORDER BY display_order ASC", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});




// --- Social Embeds ---
// =============================================
// About Me API
// =============================================

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
// SECTION_KEYS moved to lib/html-sanitize.js (imported near the top of this file already).

app.get('/api/public/site-content', (req, res) => {
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







// Phase 5 (HOUSEKEEPING-NOTES.md): legacy admin route POST /api/admin/gdpr/delete moved to
// routes/admin/popia.js (batch 14) — it's a one-click wrapper around createPopiaRequest/
// approvePopiaRequest/processPopiaRequest/notifyPopiaCancellations/deletePopiaFiles, all of which
// live there now alongside the rest of the POPIA admin surface.









// --- Migration & System ---
/**
 * Admin-Only: Data Migration Tool (Legacy Bookings -> New Relational Schema)
 * This tool scans existing flat 'bookings' records and creates unique 'clients' and 'venues' 
 * entries, then updates the booking record with foreign key references.
 */
app.post('/api/admin/system/migrate-legacy-data', requireAdmin, requireRole(['administrator']), async (req, res) => {
    getAllBookingsFull(async (err, bookings) => {
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
                updateBookingClientVenue(clientId, venueId, booking.id, () => resolve());
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
    
    getEventsForSitemap((err, events) => {
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
