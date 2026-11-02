const express = require('express');
const db = require('../../database');
const { requireAdmin } = require('../../middleware/auth');
const { getBookingsTrend } = require('../../database/repositories/bookings.repository');
const { getActiveDateHoldsBetween } = require('../../database/repositories/calendar.repository');
const moment = require('moment-timezone');
const { resolveRange } = require('../../lib/insights-range');
const router = express.Router();

// ── Helper: parse ?period= query param into a [start, end] date range ────────
// The Dashboard's date selector sends ?range=<preset>|custom&from=&to= (lib/insights-range.js resolves it the same way as the Overview
// and Finance tabs); ?period=7d|30d|90d still works for any older caller.
function getAnalyticsDates(query) {
    if (query.range) {
        const r = resolveRange(query);
        if (!r.error) return { start: r.from, end: r.to };
    }
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
router.get('/api/admin/analytics/summary', requireAdmin, (req, res) => {
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
router.get('/api/admin/analytics/visits-over-time', requireAdmin, (req, res) => {
    const { start, end } = getAnalyticsDates(req.query);
    // by hour for a day or two, by day up to about a quarter, by week beyond (the old ?period=90d kept its weekly view)
    const spanDays = Math.round((Date.parse(end) - Date.parse(start)) / 864e5) + 1;
    const groupFmt = spanDays <= 2 ? `strftime('%Y-%m-%d %H:00', viewed_at)`
        : (spanDays > 92 || req.query.period === '90d') ? `strftime('%Y-W%W', viewed_at)` : `date(viewed_at)`;
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
router.get('/api/admin/analytics/traffic-sources', requireAdmin, (req, res) => {
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
router.get('/api/admin/analytics/top-referrers', requireAdmin, (req, res) => {
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
router.get('/api/admin/analytics/devices', requireAdmin, (req, res) => {
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
router.get('/api/admin/analytics/countries', requireAdmin, (req, res) => {
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
            // total visitors in the range, for each country's share
            db.get(`SELECT COUNT(DISTINCT visitor_id) AS n FROM analytics_pageviews WHERE date(viewed_at) BETWEEN ? AND ?`, [start, end], (e2, t) => {
                res.json({ success: true, rows: rows || [], totalVisitors: (t && t.n) || 0 });
            });
        }
    );
});

// GET /api/admin/analytics/top-pages?period=7d|30d|90d
// Most-viewed pages — reveals which content (events, gallery, booking) resonates
router.get('/api/admin/analytics/top-pages', requireAdmin, (req, res) => {
    const { start, end } = getAnalyticsDates(req.query);
    db.all(`
        SELECT
            CASE WHEN page IN ('/index.html', '/index') THEN '/' ELSE page END AS page,   -- the same home page
            COUNT(*)                    AS pageviews,
            COUNT(DISTINCT visitor_id)  AS visitors
        FROM analytics_pageviews
        WHERE date(viewed_at) BETWEEN ? AND ?
          AND page IS NOT NULL AND page != ''
        GROUP BY 1
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
router.get('/api/admin/analytics/bookings-trend', requireAdmin, (req, res) => {
    const { start, end } = getAnalyticsDates(req.query);
    getBookingsTrend(start, end,
        (err, rows) => {
            if (err) return res.status(500).json({ success: false });
            res.json({ success: true, rows: rows || [] });
        }
    );
});

// GET /api/admin/analytics/todays-schedule[?days=7]
// The Dashboard's schedule: confirmed bookings + active holds + public events for today and the days after it (?days=1..14, default 1 =
// today only), each row with its date. Days are South African calendar days (the UTC date was the wrong day from midnight to 02:00).
router.get('/api/admin/analytics/todays-schedule', requireAdmin, (req, res) => {
    const days = Math.min(14, Math.max(1, parseInt(req.query.days, 10) || 1));
    const today = moment.tz('Africa/Johannesburg').format('YYYY-MM-DD');
    const last = moment.tz(today, 'Africa/Johannesburg').add(days - 1, 'days').format('YYYY-MM-DD');
    const results = [];

    db.serialize(() => {
        // 1. Confirmed/accepted/completed bookings (with client + venue names)
        db.all(`
            SELECT b.event_name                         AS title,
                   b.event_start_time                   AS start_time,
                   COALESCE(v.name, b.event_location)   AS location,
                   b.status                             AS type,
                   'booking'                            AS source,
                   COALESCE(c.full_name, b.name)        AS client_name,
                   b.date                               AS date
            FROM bookings b
            LEFT JOIN clients c ON b.client_id = c.id
            LEFT JOIN venues  v ON b.venue_id  = v.id
            WHERE b.date BETWEEN ? AND ? AND b.status IN ('CONFIRMED','ACCEPTED','COMPLETED')`,
            [today, last],
            (err, rows) => { if (!err && rows) results.push(...rows); }
        );

        // 2. Active date holds / manual calendar blocks
        getActiveDateHoldsBetween(
            today, last,
            (err, rows) => { if (!err && rows) results.push(...rows); }
        );

        // 3. Public events (not drafts, not cancelled); the time comes from event_datetime when no separate start time is set
        db.all(`
            SELECT e.event_title      AS title,
                   COALESCE(NULLIF(e.event_start_time, ''), NULLIF(strftime('%H:%M', e.event_datetime), '00:00')) AS start_time,
                   COALESCE(v.name, e.venue_name) AS location,
                   e.event_status     AS type,
                   'event'            AS source,
                   NULL               AS client_name,
                   date(e.event_datetime) AS date
            FROM events e
            LEFT JOIN venues v ON e.venue_id = v.id
            WHERE date(e.event_datetime) BETWEEN ? AND ? AND e.event_status NOT IN ('draft', 'cancelled')`,
            [today, last],
            (err, rows) => {
                if (!err && rows) results.push(...rows);
                // By day, then start time (no time last)
                results.sort((a, b) => {
                    if (a.date !== b.date) return String(a.date).localeCompare(String(b.date));
                    if (!a.start_time) return 1;
                    if (!b.start_time) return -1;
                    return a.start_time.localeCompare(b.start_time);
                });
                res.json({ success: true, from: today, to: last, rows: results.slice(0, 40) });
            }
        );
    });
});

// ── What visitors look at and do on the one-page site (tracker.js -> analytics_events; consenting visitors only) ──────────────────

// The page's sections, top to bottom (tracker.js SECTIONS) and what the dashboard calls them.
const SECTION_LABELS = {
    hero: 'Home (top of the page)', features: 'Highlights strip', services: 'What I do (services)', about: 'About', career: 'Career milestones',
    accolades: 'Accolades & Recognition', footprint: 'Footprint (countries)', team: 'Management Team', gallery: 'Gallery', social: 'Social videos',
    events: 'Events', newsletter: 'Newsletter', testimonials: 'Testimonials', contact: 'Contact'
};
const SECTION_ORDER = Object.keys(SECTION_LABELS);
const allQ = (sql, p) => new Promise((resolve, reject) => db.all(sql, p, (e, r) => e ? reject(e) : resolve(r || [])));
const getQ = (sql, p) => new Promise((resolve, reject) => db.get(sql, p, (e, r) => e ? reject(e) : resolve(r || {})));

// GET /api/admin/analytics/sections?range=... - for each section: visits that reached it, and the share of all tracked visits
router.get('/api/admin/analytics/sections', requireAdmin, async (req, res) => {
    const { start, end } = getAnalyticsDates(req.query);
    try {
        const visits = await getQ(`SELECT COUNT(*) AS n FROM analytics_sessions WHERE date(started_at) BETWEEN ? AND ?`, [start, end]);
        const rows = await allQ(`SELECT name, COUNT(DISTINCT session_id) AS visits, COUNT(DISTINCT visitor_id) AS visitors
                                 FROM analytics_events WHERE event_type = 'section_view' AND date(occurred_at) BETWEEN ? AND ? GROUP BY name`, [start, end]);
        const total = Number(visits.n) || 0;
        const out = SECTION_ORDER.map(k => {
            const r = rows.find(x => x.name === k) || {};
            return { key: k, label: SECTION_LABELS[k], visits: Number(r.visits) || 0, visitors: Number(r.visitors) || 0, share: total ? Math.round(((Number(r.visits) || 0) / total) * 1000) / 10 : null };
        });
        res.json({ success: true, totalVisits: total, rows: out });
    } catch (e) { res.status(500).json({ success: false }); }
});

// GET /api/admin/analytics/interactions?range=... - what people did, and two journeys counted in visits:
// booking (form opened -> step 2 -> 3 -> 4 -> sent) and tickets (event opened -> Get Tickets -> tickets held -> sent to PayFast)
const INTERACTION_LABELS = {
    event_opened: 'Event details opened', get_tickets: 'Get Tickets pressed', tickets_reserved: 'Tickets held', tickets_checkout: 'Sent to PayFast',
    event_shared: 'Show shared', booking_opened: 'Booking form opened', booking_submitted: 'Booking request sent', contact_sent: 'Contact message sent',
    newsletter_signup: 'Newsletter sign-up', gallery_photo: 'Gallery photo opened', video_played: 'Video played'
};
const BK_SOURCE_LABELS = {
    'header-cta': 'Top menu "Book Me"', 'mobile-nav': 'Phone menu "Book Me"', 'hero-cta': 'Hero "Make Booking"', footer: 'Footer "Book Me"',
    'service-club-theatre': 'Service: club & theatre', 'service-corporate-events': 'Service: corporate events', 'service-private-functions': 'Service: private functions',
    'service-writing-creative': 'Service: writing & creative', 'service-acting-voice-brand': 'Service: acting, voice & brand'
};
router.get('/api/admin/analytics/interactions', requireAdmin, async (req, res) => {
    const { start, end } = getAnalyticsDates(req.query);
    try {
        const counts = await allQ(`SELECT name, COUNT(*) AS n, COUNT(DISTINCT session_id) AS visits FROM analytics_events
                                   WHERE event_type = 'interaction' AND date(occurred_at) BETWEEN ? AND ? GROUP BY name`, [start, end]);
        const steps = await allQ(`SELECT detail, COUNT(DISTINCT session_id) AS visits FROM analytics_events
                                  WHERE event_type = 'interaction' AND name = 'booking_step' AND date(occurred_at) BETWEEN ? AND ? GROUP BY detail`, [start, end]);
        const sources = await allQ(`SELECT COALESCE(detail, 'other') AS detail, COUNT(*) AS n FROM analytics_events
                                    WHERE event_type = 'interaction' AND name = 'booking_opened' AND date(occurred_at) BETWEEN ? AND ? GROUP BY 1 ORDER BY n DESC`, [start, end]);
        const visitsOf = (name) => Number((counts.find(c => c.name === name) || {}).visits) || 0;
        const stepVisits = (n) => Number((steps.find(s => String(s.detail) === String(n)) || {}).visits) || 0;
        res.json({
            success: true,
            rows: Object.keys(INTERACTION_LABELS).map(k => { const c = counts.find(x => x.name === k) || {}; return { key: k, label: INTERACTION_LABELS[k], count: Number(c.n) || 0, visits: Number(c.visits) || 0 }; }),
            booking: [
                { label: 'Opened the booking form', visits: visitsOf('booking_opened') },
                { label: 'Reached step 2 (your details)', visits: stepVisits(2) },
                { label: 'Reached step 3 (venue)', visits: stepVisits(3) },
                { label: 'Reached step 4 (review)', visits: stepVisits(4) },
                { label: 'Sent the request', visits: visitsOf('booking_submitted') }
            ],
            tickets: [
                { label: 'Opened an event', visits: visitsOf('event_opened') },
                { label: 'Pressed Get Tickets', visits: visitsOf('get_tickets') },
                { label: 'Held tickets', visits: visitsOf('tickets_reserved') },
                { label: 'Went to PayFast', visits: visitsOf('tickets_checkout') }
            ],
            bookingSources: sources.map(s => ({ label: BK_SOURCE_LABELS[s.detail] || s.detail, count: Number(s.n) || 0 }))
        });
    } catch (e) { res.status(500).json({ success: false }); }
});

// GET /api/admin/analytics/visitor-mix?range=... - new vs returning visitors, engagement, browsers
router.get('/api/admin/analytics/visitor-mix', requireAdmin, async (req, res) => {
    const { start, end } = getAnalyticsDates(req.query);
    try {
        // returning = first seen before the range began (on this browser - a cleared cookie or another device counts as new)
        const mix = await getQ(`SELECT COUNT(*) AS visitors,
                                       COUNT(CASE WHEN first_seen < ? THEN 1 END) AS returning_n
                                FROM (SELECT p.visitor_id, (SELECT MIN(date(p2.viewed_at)) FROM analytics_pageviews p2 WHERE p2.visitor_id = p.visitor_id) AS first_seen
                                      FROM analytics_pageviews p WHERE date(p.viewed_at) BETWEEN ? AND ? GROUP BY p.visitor_id)`, [start, start, end]);
        const eng = await getQ(`SELECT COUNT(*) AS visits, AVG(total_dwell_seconds) AS avg_secs,
                                       COUNT(CASE WHEN total_dwell_seconds >= 30 THEN 1 END) AS engaged
                                FROM analytics_sessions WHERE date(started_at) BETWEEN ? AND ?`, [start, end]);
        const pv = await getQ(`SELECT COUNT(*) AS pageviews FROM analytics_pageviews WHERE date(viewed_at) BETWEEN ? AND ?`, [start, end]);
        const browsers = await allQ(`SELECT TRIM(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(browser,'0',''),'1',''),'2',''),'3',''),'4',''),'5',''),'6',''),'7',''),'8',''),'9','')) AS name,
                                            COUNT(*) AS visits
                                     FROM analytics_sessions WHERE date(started_at) BETWEEN ? AND ? GROUP BY 1 ORDER BY visits DESC LIMIT 6`, [start, end]);
        const visitors = Number(mix.visitors) || 0, returning = Number(mix.returning_n) || 0, visits = Number(eng.visits) || 0;
        res.json({
            success: true,
            visitors, returning, new: visitors - returning,
            pageViews: Number(pv.pageviews) || 0,
            visits, avgVisitSeconds: visits ? Math.round(Number(eng.avg_secs) || 0) : null,
            engagedVisits: Number(eng.engaged) || 0, engagedShare: visits ? Math.round(((Number(eng.engaged) || 0) / visits) * 1000) / 10 : null,
            browsers: browsers.map(b => ({ name: b.name || 'Unknown', visits: Number(b.visits) || 0 }))
        });
    } catch (e) { res.status(500).json({ success: false }); }
});

// GET /api/admin/analytics/consent?range=... - answers to the cookie pop-up (anonymous, everyone): analytics yes / no, by button, changes
router.get('/api/admin/analytics/consent', requireAdmin, async (req, res) => {
    const { start, end } = getAnalyticsDates(req.query);
    try {
        const r = await getQ(`SELECT COUNT(*) AS answers,
                                     COUNT(CASE WHEN analytics = 1 THEN 1 END) AS yes,
                                     COUNT(CASE WHEN choice = 'accept_all' THEN 1 END) AS accept_all,
                                     COUNT(CASE WHEN choice = 'reject_all' THEN 1 END) AS reject_all,
                                     COUNT(CASE WHEN choice = 'custom' THEN 1 END) AS custom,
                                     COUNT(CASE WHEN is_change = 1 THEN 1 END) AS changes,
                                     COUNT(CASE WHEN is_change = 1 AND analytics = 0 THEN 1 END) AS changed_to_no
                              FROM analytics_consent_choices WHERE date(occurred_at) BETWEEN ? AND ?`, [start, end]);
        const answers = Number(r.answers) || 0, yes = Number(r.yes) || 0;
        res.json({
            success: true, answers, analyticsYes: yes, analyticsNo: answers - yes,
            yesShare: answers ? Math.round((yes / answers) * 1000) / 10 : null,
            byChoice: { accept_all: Number(r.accept_all) || 0, reject_all: Number(r.reject_all) || 0, custom: Number(r.custom) || 0 },
            changes: Number(r.changes) || 0, changedToNo: Number(r.changed_to_no) || 0
        });
    } catch (e) { res.status(500).json({ success: false }); }
});

// GET /api/admin/analytics/cities?range=... - top cities (geoip; recorded since migration 117, so older visits have none)
router.get('/api/admin/analytics/cities', requireAdmin, async (req, res) => {
    const { start, end } = getAnalyticsDates(req.query);
    try {
        const rows = await allQ(`SELECT city, MAX(country_code) AS code, COUNT(DISTINCT visitor_id) AS visitors, COUNT(*) AS visits
                                 FROM analytics_sessions WHERE city IS NOT NULL AND city <> '' AND date(started_at) BETWEEN ? AND ?
                                 GROUP BY city ORDER BY visitors DESC, visits DESC LIMIT 10`, [start, end]);
        res.json({ success: true, rows });
    } catch (e) { res.status(500).json({ success: false }); }
});

module.exports = router;
