// Phase 5 (HOUSEKEEPING-NOTES.md): relocated from app.js verbatim, alongside its own
// schedule.scheduleJob wiring — wrapped into registerAnalyticsDailyRollup() to match every other
// scheduled job's convention. app.js calls it once, at the same module-load-time position the
// inline schedule.scheduleJob('6 0 * * *', ...) call used to sit at.
const db = require('../database');
const schedule = require('node-schedule');

// Aggregate yesterday's analytics into analytics_daily (runs at 00:06 each day,
// staggered after the 00:05 overdue-flagging sweep)
function registerAnalyticsDailyRollup() {
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
}

module.exports = { registerAnalyticsDailyRollup };
