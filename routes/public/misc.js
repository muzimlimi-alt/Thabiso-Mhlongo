const express = require('express');
const path = require('path');
const moment = require('moment-timezone');
const geoip = require('geoip-lite');
const UAParser = require('ua-parser-js');
const db = require('../../database');
const {
    ipRateLimiter, bookingRateLimiter, analyticsTrackLimiter, sitemapRateLimiter
} = require('../../middleware/rate-limiters');
const { upload } = require('../../lib/uploads');
const { PROJECT_ROOT } = require('../../lib/runtime-paths');
const { addMinutesToTime, parseDurationToMinutes } = require('../../lib/time-utils');
const { sanitizeEmailInput } = require('../../lib/validation');
const { encodeUserHtml } = require('../../lib/html-sanitize');
const { getEmailFooterContext } = require('../../lib/email-context');
const bannerRegistry = require('../../js/bannerRegistry');
const emailComponents = require('../../js/emailComponents');
const { sendEmail } = require('../../js/emailService');
const { insertLegacyBookingFromContactForm } = require('../../database/repositories/bookings.repository');
const { insertInquiry } = require('../../database/repositories/inquiries.repository');
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

router.post('/send-email', ipRateLimiter, bookingRateLimiter, async (req, res) => {
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
    // Phase 5 (HOUSEKEEPING-NOTES.md): __dirname here now resolves relative to this file's own
    // directory (routes/public/), not the project root as it did in app.js — same __dirname-
    // relative-path hazard caught in earlier route moves. Fixed via PROJECT_ROOT
    // (lib/runtime-paths.js). This variable is unused below (dead even in the original app.js), so
    // the fix has no behavioural effect either way — applied anyway for consistency, matching the
    // same defensive fix already made to sendBookingReceivedEmail's identical dead logoFilePath.
    const logoFilePath = path.join(PROJECT_ROOT, 'images', 'logo4.png');

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
