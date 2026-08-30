const express = require('express');
const db = require('../../database');
const { requireAdmin } = require('../../middleware/auth');
const { getBookingsTrend } = require('../../database/repositories/bookings.repository');
const { getActiveDateHoldsForToday } = require('../../database/repositories/calendar.repository');
const router = express.Router();

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
            res.json({ success: true, rows: rows || [] });
        }
    );
});

// GET /api/admin/analytics/top-pages?period=7d|30d|90d
// Most-viewed pages — reveals which content (events, gallery, booking) resonates
router.get('/api/admin/analytics/top-pages', requireAdmin, (req, res) => {
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
router.get('/api/admin/analytics/bookings-trend', requireAdmin, (req, res) => {
    const { start, end } = getAnalyticsDates(req.query);
    getBookingsTrend(start, end,
        (err, rows) => {
            if (err) return res.status(500).json({ success: false });
            res.json({ success: true, rows: rows || [] });
        }
    );
});

// GET /api/admin/analytics/todays-schedule
// Returns today's full calendar: confirmed bookings + active holds + public events
router.get('/api/admin/analytics/todays-schedule', requireAdmin, (req, res) => {
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
        getActiveDateHoldsForToday(
            today,
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

module.exports = router;
