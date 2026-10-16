const express = require('express');
const moment = require('moment-timezone');
const geoip = require('geoip-lite');
const UAParser = require('ua-parser-js');
const db = require('../../database');
const {
    ipRateLimiter, contactRateLimiter, analyticsTrackLimiter, sitemapRateLimiter
} = require('../../middleware/rate-limiters');
const { upload } = require('../../lib/uploads');
const { addMinutesToTime, parseDurationToMinutes } = require('../../lib/time-utils');
const { submitContact } = require('../../lib/contact-intake');
const {
    getActiveDateHoldsForIcsFeed, getEventsForSitemap
} = require('../../database/repositories/calendar.repository');
const router = express.Router();

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

// Phase 5 (HOUSEKEEPING-NOTES.md): publicImageUploadStorage/publicImageUpload (the restricted,
// SVG-excluding upload variant for the public testimonial-submission route — see SEC-1 near the
// /upload route below for why SVG is excluded here but not from `upload` above) moved into
// routes/public/site-content.js as single-consumer locals alongside POST /api/public/testimonials.

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

router.post('/upload', (req, res, next) => {
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
    else if (section === 'team') folderPath = 'images/team/';
    else if (section === 'accolades') folderPath = 'images/accolades/';

    const relativePath = folderPath + req.file.filename;

    res.json({
        success: true,
        message: 'File uploaded successfully',
        filePath: relativePath,
        filename: req.file.filename
    });
});

// POST /api/public/analytics/track — no auth required; IP discarded after geo lookup
router.post('/api/public/analytics/track', analyticsTrackLimiter, (req, res) => {
    // Respond immediately so the beacon gets a fast 204
    res.status(204).end();

    try {
        const { event, visitor_id, session_id, page, referrer,
                utm_source, utm_medium, utm_campaign, dwell } = req.body || {};

        if (!visitor_id || !session_id || !event) return;

        // Geo — extract country from IP then discard the IP
        const ip  = req.ip || '';
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

// Public Contact form. All the work (validation, spam traps, duplicate and per-address limits, persisting the inquiry BEFORE any e-mail,
// server-decided recipients, queued notification + visitor receipt) lives in lib/contact-intake.js; see its header.
router.post('/send-email', ipRateLimiter, contactRateLimiter, async (req, res) => {
    const result = await submitContact({
        body: req.body, ip: req.ip || req.connection.remoteAddress || '', userAgent: req.get('User-Agent') || '', referrer: req.get('Referrer') || ''
    });
    res.status(result.status).json(result.body);
});

// Phase 5 (HOUSEKEEPING-NOTES.md): the entire Advancing Pack feature (all 12 routes plus
// sendAdvancingPackEmail/ensureAdvancingPack/verifyRosOwnership/verifyAdvancingContactOwnership/
// resolveAdvancingContacts, all single-consumer) moved to routes/admin/advancing.js.


/**
 * GET /api/calendar/feed.ics
 * Public (signed) ICS feed for external calendar sync
 */
router.get('/api/calendar/feed.ics', async (req, res) => {
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

// --- Dynamic Sitemap ---
router.get('/sitemap.xml', sitemapRateLimiter, (req, res) => {
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

module.exports = router;
