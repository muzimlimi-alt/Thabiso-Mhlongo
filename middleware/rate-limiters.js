// Rate limiters — Phase 5 of the housekeeping effort (HOUSEKEEPING-NOTES.md). Moved out of the
// server.js/app.js monolith byte-identical. Centralised here (rather than left inline in app.js)
// specifically so route files extracted into routes/admin/ and routes/public/ have one place to
// import whichever limiter their route used to be defined next to — app.js was the only place any
// of these could be reached from before this file existed.
let rateLimit;
try { rateLimit = require('express-rate-limit'); } catch(e) { rateLimit = null; }

// Rate limiter for public booking submissions (5 per 15 minutes per IP)
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

// Limiter for requesting a tracking verification code — guards against using it to email-bomb a
// client's inbox, and against using response timing/shape to probe id/email combinations.
const otpRequestRateLimiter = (rateLimit && process.env.NODE_ENV !== 'test') ? rateLimit({
    windowMs: 15 * 60 * 1000, // 15 mins
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: 'Too many code requests. Please wait 15 minutes and try again.' }
}) : (req, res, next) => next();

// Strict limiter for state-mutating public endpoints (accept-quote, cancel) — email-only auth
const mutateRateLimiter = (rateLimit && process.env.NODE_ENV !== 'test') ? rateLimit({
    windowMs: 15 * 60 * 1000, // 15 mins
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: 'Too many attempts. Please wait 15 minutes and try again.' }
}) : (req, res, next) => next();

// Limiter for all authenticated admin routes (per IP) — bypassed in test mode, matching
// bookingRateLimiter/mutateRateLimiter above: the integration suite runs many admin requests from
// one IP across dozens of test files in the same 1-minute window, well beyond real admin usage.
// 120 turned out too tight for real usage: a single dashboard load fires ~32 concurrent admin-gated
// requests (loadDashboardKPIs + the dozen per-section loaders in the login-success handler), plus a
// heartbeat every 60s — so 2-3 reloads/section switches within one minute already exceeded 120.
const adminRateLimiter = (rateLimit && process.env.NODE_ENV !== 'test') ? rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 400,
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

// --- Phase 6 (original numbering — a pre-existing in-app comment, not this housekeeping effort's
// phases): Security & Rate Limiting ---
const rateLimits = new Map();
const RATE_LIMIT_WINDOW = 3600000; // 1 hour
const MAX_REQUESTS = 100; // Increased for test suite automation

const ipRateLimiter = (req, res, next) => {
    // Every other hand-tuned limiter in this file (bookingRateLimiter, otpRequestRateLimiter,
    // mutateRateLimiter, adminRateLimiter) already bypasses entirely under NODE_ENV=test — this one
    // predates that convention and instead just had MAX_REQUESTS bumped to 100 "for test suite
    // automation". That shared, IP-keyed budget is spent across every *.test.js file in one npm test
    // run (they all share one server boot), so as the suite grows, legitimate requests in later files
    // get 429'd and crash on the assumption they succeeded — not an actual abuse case to guard against
    // in test env at all.
    if (process.env.NODE_ENV === 'test') return next();
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

module.exports = {
    bookingRateLimiter, exportRateLimiter, sitemapRateLimiter, trackRateLimiter,
    otpRequestRateLimiter, mutateRateLimiter, adminRateLimiter, adminLoginRateLimiter,
    lookupRateLimiter, analyticsTrackLimiter, ipRateLimiter,
    PAYFAST_VALID_IPS, payfastItnRateLimiter,
};
