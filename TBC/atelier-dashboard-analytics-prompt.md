# AI Agent Prompt: Upgrade #dashboardAdmin to a Live Analytics Command Center

> **Context.** The `admin.html` `#dashboardAdmin` section currently renders a mix of live CRM
> stat tiles (wired to real API data) and static placeholder widgets (hardcoded sparklines,
> a hardcoded ApexCharts area chart, a hardcoded schedule list, and a broken CRM card showing
> `$70,00,000`). This prompt transforms the dashboard into a genuine analytics command center:
> real visitor tracking on `index.html` (the public page), live bookings trend charting,
> a live today's-schedule panel, and a full suite of web analytics widgets — all themed
> in the Atelier Obsidian / Editorial-Luxe design system.

---

## NON-NEGOTIABLE RULES

1. **Backend (`server.js`) and database (`database.js`) logic are in scope** for this prompt only.
   Add new code; never remove or alter existing routes, middleware, or DB init blocks.

2. **All existing JS-bound IDs survive byte-for-byte.** The IDs `dashStat-bookingsAdmin`,
   `dashStat-inquiriesAdmin`, `dashStat-financeAdmin`, `dashStat-eventsAdmin`,
   `dashNeedsActionCount`, `bookingsChart`, `sparkTotalUsers`, and `sparkPageViews` must remain
   in the DOM at their existing positions and keep their existing roles. New charts receive
   new IDs prefixed `db-`.

3. **`loadDashboardKPIs()` is not modified.** It continues to hydrate the five CRM stat tiles
   exactly as it does today. New analytics loaders are separate functions.

4. **Use `sqlite3` callback pattern throughout** (`db.run`, `db.get`, `db.all` with callbacks).
   `better-sqlite3` is not installed and must not be used.

5. **Use ApexCharts for all charts.** It is already loaded via CDN at line 28 of `admin.html`
   (`https://cdn.jsdelivr.net/npm/apexcharts`). Do not add Chart.js.

6. **All CSS inside `#dashboardAdmin` must consume `--atl-*` tokens.** The 10 hardcoded hex
   values in the existing inline `<style>` block (`#151515`, `#181818`, `#222`, `#666`,
   `#2ecc71`, `#e74c3c`, `#1877F2`, `#E4405F`, `#FF0000`, `#fe2c55`) are confirmed dead-code
   candidates. Platform brand colours (FB, IG, TT, YT) may remain as named variables
   (`--db-fb-blue`, `--db-ig-pink`, etc.) defined inside the section style block.

7. **`tracker.js` is a public file** served at `GET /tracker.js` via the existing
   `express.static(path.join(__dirname, '/'))` handler. It must be self-contained and not
   import any npm modules.

8. **Do not store raw IP addresses.** Discard the IP immediately after the geo lookup.

9. **Light + Dark theme must work on all new widgets.** ApexCharts colour palettes must
   branch on `document.documentElement.getAttribute('data-theme') === 'light'` before render.

10. **Validate each phase before proceeding to the next.** Do not batch all changes into one
    edit; work section → section as ordered below.

---

## OBJECTIVE

Transform `#dashboardAdmin` into a live Command Center that shows:

- **Web analytics** for `index.html` (page views, unique visitors, session duration, traffic
  sources, device breakdown, top referrers) — powered by a new lightweight first-party
  tracker embedded in the public page.
- **Live Bookings Trend** chart (`#bookingsChart`) replacing the current hardcoded series.
- **Live Today's Schedule** replacing the hardcoded schedule list items.
- **Live sparklines** (`#sparkTotalUsers`, `#sparkPageViews`) wired to real analytics counts.
- **Token-compliant CSS** eliminating all hardcoded hex from the section's inline `<style>`.

---

## FULL-STACK IMPACT ANALYSIS

| Layer | What changes |
|---|---|
| **`database.js`** | Add 3 new tables: `analytics_pageviews`, `analytics_sessions`, `analytics_daily`. Add indexes. |
| **`server.js`** | Add `POST /api/public/analytics/track` (public, rate-limited). Add 6 protected `GET /api/admin/analytics/*` endpoints. Add midnight aggregation cron. Require 2 new npm packages. |
| **`tracker.js`** (new file) | Client-side script embedded on `index.html`. Sends page-view events, heartbeats, and exit beacons to `/api/public/analytics/track`. |
| **`index.html`** | One new `<script>` tag before `</body>` to load `tracker.js`. |
| **`admin.html` — HTML** | Replace `.db-crm-grid` block (broken placeholder) with period selector + 4 analytics KPI cards. Add 3 new chart containers. Replace hardcoded `.db-schedule-list` items with an empty list populated by JS. Keep all other existing HTML unchanged. |
| **`admin.html` — CSS** | Replace the inline `<style>` block inside `#dashboardAdmin` with a token-compliant version that adds styles for all new elements. |
| **`admin.html` — JS** | Add `loadAnalyticsDashboard()`, `initDashboardCharts()`, and `loadTodaysSchedule()` functions in the `<script>` block after the existing sparkline init. Wire to `switchTab` hook. |

---

## CURRENT STATE — CONFIRMED AUDIT FINDINGS

```
admin.html
  #dashboardAdmin  (line 4077)
  ├── .atl-section-hd              – Section header with eyebrow + heading  [KEEP]
  ├── .atl-section-rule            – Decorative rule                         [KEEP]
  └── .db-container
      ├── .db-social-grid          – 5 social platform cards (hardcoded)     [KEEP structure / CLEAN css]
      ├── .db-summary-grid         – 5 live CRM stat tiles                   [KEEP exactly]
      │     IDs: dashStat-bookingsAdmin, dashStat-inquiriesAdmin,
      │           dashStat-financeAdmin, dashStat-eventsAdmin,
      │           dashNeedsActionCount
      ├── .db-crm-grid             – 1 broken placeholder card ("$70,00,000") [REPLACE]
      ├── .db-spark-grid           – 2 ApexCharts sparklines (hardcoded data) [KEEP IDs / REWIRE js]
      │     IDs: sparkTotalUsers, sparkPageViews
      └── .db-main-grid            – bookingsChart (hardcoded) + schedule (hardcoded)  [KEEP IDs / REWIRE]
            IDs: bookingsChart, .db-schedule-list

Inline <style> block – bottom of #dashboardAdmin (lines ~4244–4536)
  Contains: .db-container, .db-summary-grid, .db-stat-card, .db-main-grid,
            .db-schedule-*, .db-social-*, .db-crm-*, .db-spark-*
  Hardcoded hex values to eliminate:
    #151515 → var(--atl-surface2)
    #181818 → var(--atl-card)
    #222    → var(--atl-line)
    #666    → var(--atl-muted)
    #2ecc71 → var(--atl-sage)
    #e74c3c → var(--atl-clay)
    Platform brand colours (FB/IG/TT/YT) → local named vars inside the style block

switchTab() hook (line 15833):
  if (sectionId === 'dashboardAdmin' && typeof loadDashboardKPIs === 'function') {
      loadDashboardKPIs();    ← DO NOT TOUCH THIS LINE
  }
  ← ADD: if (typeof loadAnalyticsDashboard === 'function') loadAnalyticsDashboard();
  ← ADD: if (typeof loadTodaysSchedule      === 'function') loadTodaysSchedule();

loadDashboardKPIs() (line 14529) — DO NOT MODIFY. 18 tile endpoints. Already live.

Existing ApexCharts init (DOMContentLoaded block near line 19271):
  • #bookingsChart — hardcoded 7-day area chart  → REWIRE to live API
  • #sparkTotalUsers — hardcoded bar sparkline   → REWIRE to live analytics
  • #sparkPageViews — hardcoded line sparkline   → REWIRE to live analytics
  This entire DOMContentLoaded block is REPLACED by the new initDashboardCharts().
```

---

## JS-BOUND IDs THAT MUST SURVIVE

| ID / selector | Role | Action |
|---|---|---|
| `#dashStat-bookingsAdmin` | Live CRM KPI | Preserve |
| `#dashStat-inquiriesAdmin` | Live CRM KPI | Preserve |
| `#dashStat-financeAdmin` | Live CRM KPI | Preserve |
| `#dashStat-eventsAdmin` | Live CRM KPI | Preserve |
| `#dashNeedsActionCount` | Live needs-action count | Preserve |
| `#bookingsChart` | ApexCharts mount point | Preserve — rewire data source |
| `#sparkTotalUsers` | ApexCharts mount point | Preserve — rewire data source |
| `#sparkPageViews` | ApexCharts mount point | Preserve — rewire data source |
| `.db-schedule-list` | Schedule list container | Preserve — clear and repopulate |
| `loadDashboardKPIs()` | Function | Do not modify signature or body |

---

## NEW PACKAGES TO INSTALL

Run before any code changes:

```bash
npm install geoip-lite ua-parser-js
```

- **`geoip-lite`** — Bundles MaxMind GeoLite2 Country data. No `.mmdb` file needed.
  Usage: `const geoip = require('geoip-lite'); const geo = geoip.lookup(ip); // { country: 'ZA' }`
- **`ua-parser-js`** — Parses User-Agent header into browser / OS / device.
  Usage: `const UAParser = require('ua-parser-js'); const ua = new UAParser(req.headers['user-agent']).getResult();`

---

## PHASE 1 — DATABASE (add to `database.js`)

Inside the `initializeDatabase()` → `db.serialize()` block, append the following **after** all
existing `db.run(...)` calls:

```javascript
// ── Analytics Tables ──────────────────────────────────────────────────────────

// Individual page-view events (one row per visit to index.html)
db.run(`CREATE TABLE IF NOT EXISTS analytics_pageviews (
    id              INTEGER  PRIMARY KEY AUTOINCREMENT,
    session_id      TEXT     NOT NULL,
    visitor_id      TEXT     NOT NULL,
    page            TEXT     NOT NULL DEFAULT '/',
    referrer        TEXT,
    referrer_host   TEXT,
    channel         TEXT,
    utm_source      TEXT,
    utm_medium      TEXT,
    utm_campaign    TEXT,
    country_code    TEXT,
    country_name    TEXT,
    device_type     TEXT,
    browser         TEXT,
    os              TEXT,
    dwell_seconds   INTEGER  DEFAULT 0,
    viewed_at       DATETIME DEFAULT CURRENT_TIMESTAMP
)`, () => {
    db.run(`CREATE INDEX IF NOT EXISTS idx_apv_session  ON analytics_pageviews(session_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_apv_visitor  ON analytics_pageviews(visitor_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_apv_date     ON analytics_pageviews(viewed_at)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_apv_channel  ON analytics_pageviews(channel)`);
});

// One row per visitor session (30-minute inactivity window)
db.run(`CREATE TABLE IF NOT EXISTS analytics_sessions (
    id                   INTEGER  PRIMARY KEY AUTOINCREMENT,
    session_id           TEXT     NOT NULL UNIQUE,
    visitor_id           TEXT     NOT NULL,
    started_at           DATETIME DEFAULT CURRENT_TIMESTAMP,
    ended_at             DATETIME,
    entry_page           TEXT,
    exit_page            TEXT,
    page_count           INTEGER  DEFAULT 1,
    total_dwell_seconds  INTEGER  DEFAULT 0,
    is_bounce            INTEGER  DEFAULT 1,
    country_code         TEXT,
    country_name         TEXT,
    device_type          TEXT,
    browser              TEXT,
    os                   TEXT,
    channel              TEXT,
    referrer_host        TEXT,
    utm_source           TEXT,
    utm_medium           TEXT,
    utm_campaign         TEXT
)`, () => {
    db.run(`CREATE INDEX IF NOT EXISTS idx_as_visitor ON analytics_sessions(visitor_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_as_date    ON analytics_sessions(started_at)`);
});

// Daily pre-aggregated summary for fast dashboard queries
db.run(`CREATE TABLE IF NOT EXISTS analytics_daily (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    date             TEXT    NOT NULL UNIQUE,
    pageviews        INTEGER DEFAULT 0,
    unique_visitors  INTEGER DEFAULT 0,
    sessions         INTEGER DEFAULT 0,
    bounced_sessions INTEGER DEFAULT 0,
    total_dwell_secs INTEGER DEFAULT 0
)`);
```

---

## PHASE 2 — `tracker.js` (new file at project root)

Create `/tracker.js`. This file is served statically by Express as `GET /tracker.js`
(the existing `express.static(path.join(__dirname, '/'))` handler at server.js line 304
already covers it).

Embed in `index.html` immediately before `</body>`:
```html
<script src="/tracker.js" data-site="thabiso" async></script>
```

```javascript
/* tracker.js — Thabiso Mhlongo public page analytics
 * Self-contained. No external dependencies.
 * Sends events to POST /api/public/analytics/track
 */
(function () {
    'use strict';

    var TRACK_URL  = '/api/public/analytics/track';
    var HEARTBEAT  = 20;   // seconds between heartbeat pings
    var SESSION_TTL = 30 * 60 * 1000; // 30-minute inactivity window

    // ── 1. visitor_id — persistent 1-year first-party cookie ─────────────
    function getCookie(name) {
        var match = document.cookie.match(new RegExp('(^| )' + name + '=([^;]+)'));
        return match ? match[2] : null;
    }
    function setCookie(name, value, days) {
        var exp = new Date(Date.now() + days * 864e5).toUTCString();
        document.cookie = name + '=' + value + '; expires=' + exp + '; path=/; SameSite=Lax';
    }
    function uuid() {
        if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
            var r = Math.random() * 16 | 0;
            return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
        });
    }

    var visitorId = getCookie('_tm_vid');
    if (!visitorId) {
        visitorId = uuid();
        setCookie('_tm_vid', visitorId, 365);
    }

    // ── 2. session_id — per-tab, expires after 30-min inactivity ─────────
    function getOrCreateSession() {
        var stored    = sessionStorage.getItem('_tm_sid');
        var lastSeen  = parseInt(sessionStorage.getItem('_tm_last') || '0', 10);
        var now       = Date.now();
        if (!stored || (now - lastSeen) > SESSION_TTL) {
            stored = uuid();
            sessionStorage.setItem('_tm_sid', stored);
        }
        sessionStorage.setItem('_tm_last', String(now));
        return stored;
    }
    var sessionId = getOrCreateSession();

    // ── 3. UTM & referrer extraction ──────────────────────────────────────
    function getUtm() {
        var params = new URLSearchParams(window.location.search);
        return {
            utm_source:   params.get('utm_source')   || '',
            utm_medium:   params.get('utm_medium')   || '',
            utm_campaign: params.get('utm_campaign') || ''
        };
    }

    // ── 4. Page dwell time ────────────────────────────────────────────────
    var pageLoadTime = Date.now();

    // ── 5. Beacon helper ──────────────────────────────────────────────────
    function send(payload) {
        var body = JSON.stringify(Object.assign({
            visitor_id: visitorId,
            session_id: sessionId,
            page:       window.location.pathname || '/'
        }, payload));

        if (navigator.sendBeacon) {
            navigator.sendBeacon(TRACK_URL, new Blob([body], { type: 'application/json' }));
        } else {
            // Fallback: synchronous XHR (acceptable; only for very old browsers)
            var xhr = new XMLHttpRequest();
            xhr.open('POST', TRACK_URL, false);
            xhr.setRequestHeader('Content-Type', 'application/json');
            try { xhr.send(body); } catch (e) {}
        }
    }

    // ── 6. Fire pageview on load ──────────────────────────────────────────
    var utmData = getUtm();
    send(Object.assign({ event: 'pageview', referrer: document.referrer || '' }, utmData));

    // ── 7. Heartbeat every 20 s to record ongoing dwell time ─────────────
    var heartbeatTimer = setInterval(function () {
        sessionStorage.setItem('_tm_last', String(Date.now()));
        send({ event: 'heartbeat', dwell: Math.round((Date.now() - pageLoadTime) / 1000) });
    }, HEARTBEAT * 1000);

    // ── 8. Exit beacon via beforeunload ───────────────────────────────────
    window.addEventListener('beforeunload', function () {
        clearInterval(heartbeatTimer);
        send({ event: 'page_exit', dwell: Math.round((Date.now() - pageLoadTime) / 1000) });
    });

    // ── 9. Scroll depth (25 / 50 / 75 / 100%) — once per threshold ───────
    var scrollSent = {};
    window.addEventListener('scroll', function () {
        var pct = Math.round(
            ((window.scrollY + window.innerHeight) / document.body.scrollHeight) * 100
        );
        [25, 50, 75, 100].forEach(function (threshold) {
            if (pct >= threshold && !scrollSent[threshold]) {
                scrollSent[threshold] = true;
                send({ event: 'scroll_depth', depth: threshold });
            }
        });
    }, { passive: true });

    // ── 10. Click tracking on booking CTA ────────────────────────────────
    document.addEventListener('click', function (e) {
        var el = e.target.closest('[data-track]');
        if (!el) return;
        send({ event: 'click', label: el.getAttribute('data-track') });
    });

    // Add data-track="book_now" to the booking CTA button(s) in index.html:
    // <a href="#booking" data-track="book_now" class="...">Book Now</a>
})();
```

---

## PHASE 3 — SERVER ROUTES (add to `server.js`)

### 3A — npm requires (add near top with other requires)

```javascript
const geoip    = require('geoip-lite');
const UAParser = require('ua-parser-js');
```

### 3B — Rate limiter for analytics track endpoint (add near existing rate limiters)

```javascript
const analyticsTrackLimiter = rateLimit ? rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 200,                  // generous — legit users send heartbeats
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: 'Analytics rate limit reached.' }
}) : (req, res, next) => next();
```

### 3C — Channel classification helper (add near the route block)

```javascript
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
```

### 3D — Public tracking endpoint

```javascript
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
```

### 3E — Protected dashboard endpoints

All six routes below require `requireAdmin`.

```javascript
// ── Helper: parse ?period= query param into date range ───────────────────────
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
            // Avg dwell + bounce rate from sessions table
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
// Returns today's calendar events sorted by start time
app.get('/api/admin/analytics/todays-schedule', requireAdmin, (req, res) => {
    const today = new Date().toISOString().split('T')[0];
    db.all(`
        SELECT title, start, end, description, type
        FROM calendar_events
        WHERE date(start) = ?
        ORDER BY start ASC
        LIMIT 10`,
        [today],
        (err, rows) => {
            // calendar_events may not exist yet — fall back gracefully
            if (err) return res.json({ success: true, rows: [] });
            res.json({ success: true, rows: rows || [] });
        }
    );
});
```

### 3F — Midnight aggregation cron (add near existing `node-schedule` jobs)

```javascript
// Aggregate yesterday's analytics into analytics_daily (runs at 00:05 each day)
schedule.scheduleJob('5 0 * * *', function () {
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
```

---

## PHASE 4 — `#dashboardAdmin` HTML CHANGES

### 4A — Replace `.db-crm-grid` block

**REMOVE** the entire `.db-crm-grid` div (the single broken "New Users: $70,00,000" card).

**INSERT** in its place (immediately before `.db-spark-grid`):

```html
<!-- Analytics Period Selector -->
<div class="db-period-bar" role="group" aria-label="Analytics period">
    <button class="db-period-btn active" data-period="7d"  id="dbPeriod-7d">7 days</button>
    <button class="db-period-btn"        data-period="30d" id="dbPeriod-30d">30 days</button>
    <button class="db-period-btn"        data-period="90d" id="dbPeriod-90d">90 days</button>
</div>

<!-- Web Analytics KPI Cards -->
<div class="db-analytics-kpi-grid">
    <div class="db-analytics-kpi-card">
        <i class="fa-solid fa-eye db-analytics-kpi-icon"></i>
        <div class="db-analytics-kpi-content">
            <span class="db-stat-label">Page Views</span>
            <span class="db-stat-value" id="dbKpi-pageViews">—</span>
        </div>
    </div>
    <div class="db-analytics-kpi-card">
        <i class="fa-solid fa-users db-analytics-kpi-icon"></i>
        <div class="db-analytics-kpi-content">
            <span class="db-stat-label">Unique Visitors</span>
            <span class="db-stat-value" id="dbKpi-uniqueVisitors">—</span>
        </div>
    </div>
    <div class="db-analytics-kpi-card">
        <i class="fa-solid fa-clock db-analytics-kpi-icon"></i>
        <div class="db-analytics-kpi-content">
            <span class="db-stat-label">Avg. Time on Page</span>
            <span class="db-stat-value" id="dbKpi-avgDuration">—</span>
        </div>
    </div>
    <div class="db-analytics-kpi-card">
        <i class="fa-solid fa-arrow-turn-up db-analytics-kpi-icon" style="color:var(--atl-clay);"></i>
        <div class="db-analytics-kpi-content">
            <span class="db-stat-label">Bounce Rate</span>
            <span class="db-stat-value" id="dbKpi-bounceRate">—</span>
        </div>
    </div>
</div>

<!-- Visitors Over Time Chart (full width) -->
<div class="atl-card atl-card--flush">
    <div class="atl-card-header">
        <h3>Visitors Over Time</h3>
    </div>
    <div class="atl-card-body" style="padding: 0 12px 12px;">
        <div id="db-chartVisitors"></div>
    </div>
</div>

<!-- Traffic Sources + Device Breakdown (2-col) -->
<div class="db-analytics-pair-grid">
    <div class="atl-card atl-card--flush">
        <div class="atl-card-header"><h3>Traffic Sources</h3></div>
        <div class="atl-card-body"><div id="db-chartSources"></div></div>
    </div>
    <div class="atl-card atl-card--flush">
        <div class="atl-card-header"><h3>Devices</h3></div>
        <div class="atl-card-body"><div id="db-chartDevices"></div></div>
    </div>
</div>
```

### 4B — Add `db-analytics-pair-grid` before `.db-spark-grid`

(Already positioned correctly in 4A above; confirm it precedes `.db-spark-grid`.)

### 4C — Wire `.db-schedule-list` for JS population

**In the existing schedule card**, replace the two hardcoded `.db-schedule-item` divs with an empty container and a loading state:

```html
<div class="db-schedule-list" id="dbScheduleList">
    <div class="db-schedule-empty" id="dbScheduleEmpty" style="display:none;">
        <i class="fa-regular fa-calendar-xmark" style="font-size:24px; color:var(--atl-muted); margin-bottom:8px;"></i>
        <p style="color:var(--atl-muted); font-size:13px; margin:0;">No events scheduled for today</p>
    </div>
    <div class="atl-spinner" id="dbScheduleSpinner" aria-label="Loading schedule..."></div>
</div>
```

---

## PHASE 5 — `#dashboardAdmin` CSS CHANGES

**Replace the entire `<style>` block** at the bottom of `#dashboardAdmin` with the following.
All `#222` → `var(--atl-line)`, `#181818` → `var(--atl-card)`, `#151515` → `var(--atl-surface2)`,
`#666` → `var(--atl-muted)`, `#2ecc71` → `var(--atl-sage)`, `#e74c3c` → `var(--atl-clay)`.
Platform brand colours are kept as local vars.

```css
<style>
/* ── Dashboard local brand colours ──────────────────────────────── */
#dashboardAdmin {
    --db-fb-blue:  #1877F2;
    --db-ig-pink:  #E4405F;
    --db-x-ink:    var(--atl-ink);
    --db-yt-red:   #FF0000;
    --db-tt-red:   #FE2C55;
}

/* ── Layout container ─────────────────────────────────────────────── */
.db-container {
    display: flex;
    flex-direction: column;
    gap: 20px;
    padding: 0 4px;
}

/* ── Period selector ─────────────────────────────────────────────── */
.db-period-bar {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
}
.db-period-btn {
    padding: 7px 18px;
    border-radius: var(--atl-r-md);
    border: 1px solid var(--atl-line);
    background: transparent;
    color: var(--atl-muted);
    font-family: 'Outfit', sans-serif;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    transition: border-color var(--atl-t-fast), color var(--atl-t-fast), background var(--atl-t-fast);
}
.db-period-btn:hover    { border-color: var(--atl-amber); color: var(--atl-amber); }
.db-period-btn.active   { border-color: var(--atl-amber); background: var(--atl-amber-dim); color: var(--atl-amber); }

/* ── Analytics KPI cards (4-col strip) ─────────────────────────── */
.db-analytics-kpi-grid {
    display: grid;
    grid-template-columns: 1fr;
    gap: 12px;
}
@media (min-width: 576px) { .db-analytics-kpi-grid { grid-template-columns: repeat(2,1fr); } }
@media (min-width: 992px) { .db-analytics-kpi-grid { grid-template-columns: repeat(4,1fr); } }

.db-analytics-kpi-card {
    background: var(--atl-card);
    border: 1px solid var(--atl-line);
    border-radius: var(--atl-r-xl);
    padding: 18px 20px;
    display: flex;
    align-items: center;
    gap: 14px;
    transition: border-color var(--atl-t-fast);
}
.db-analytics-kpi-card:hover { border-color: var(--atl-amber); }
.db-analytics-kpi-icon {
    font-size: 22px;
    color: var(--atl-amber);
    flex-shrink: 0;
}
.db-analytics-kpi-content {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
}

/* ── CRM Summary stat cards (existing) ───────────────────────────── */
.db-summary-grid {
    display: grid;
    grid-template-columns: 1fr;
    gap: 12px;
}
@media (min-width: 576px) { .db-summary-grid { grid-template-columns: repeat(2,1fr); } }
@media (min-width: 992px) { .db-summary-grid { grid-template-columns: repeat(5,1fr); } }

.db-stat-card {
    background: var(--atl-card);
    border: 1px solid var(--atl-line);
    border-radius: var(--atl-r-xl);
    padding: 18px 20px;
    display: flex;
    align-items: center;
    gap: 14px;
    cursor: pointer;
    transition: transform var(--atl-t-fast), border-color var(--atl-t-fast), box-shadow var(--atl-t-fast);
}
.db-stat-card:hover {
    transform: translateY(-3px);
    border-color: var(--atl-amber);
    box-shadow: var(--atl-shadow-card);
}
.db-stat-icon {
    width: 44px;
    height: 44px;
    background: var(--atl-amber-dim);
    border-radius: var(--atl-r-md);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 20px;
    color: var(--atl-amber);
    flex-shrink: 0;
}
.db-stat-content { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.db-stat-label {
    font-family: 'Outfit', sans-serif;
    font-size: 11px;
    color: var(--atl-muted);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}
.db-stat-value {
    font-family: 'JetBrains Mono', monospace;
    font-size: 20px;
    font-weight: 700;
    color: var(--atl-ink);
}

/* ── Paired chart grid (2-col: traffic sources + devices) ─────── */
.db-analytics-pair-grid {
    display: grid;
    grid-template-columns: 1fr;
    gap: 20px;
}
@media (min-width: 900px) { .db-analytics-pair-grid { grid-template-columns: repeat(2,1fr); } }

/* ── Main 2-col grid (bookings chart + schedule) ─────────────── */
.db-main-grid {
    display: grid;
    grid-template-columns: 1fr;
    gap: 20px;
}
@media (min-width: 992px) { .db-main-grid { grid-template-columns: 2fr 1fr; } }

/* ── Schedule list ────────────────────────────────────────────── */
.db-schedule-list   { display: flex; flex-direction: column; gap: 10px; }
.db-schedule-item {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 10px 14px;
    background: var(--atl-surface2);
    border-radius: var(--atl-r-md);
    border-left: 3px solid var(--atl-amber);
}
.db-schedule-time {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    color: var(--atl-amber);
    min-width: 68px;
    flex-shrink: 0;
}
.db-schedule-title {
    font-family: 'Outfit', sans-serif;
    font-size: 13px;
    color: var(--atl-ink);
    font-weight: 500;
    flex: 1;
}
.db-schedule-desc {
    font-family: 'Outfit', sans-serif;
    font-size: 12px;
    color: var(--atl-muted);
    white-space: nowrap;
}
.db-schedule-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 32px 0;
    text-align: center;
}

/* ── Sparklines strip ─────────────────────────────────────────── */
.db-spark-grid {
    display: grid;
    grid-template-columns: 1fr;
    gap: 12px;
}
@media (min-width: 768px) { .db-spark-grid { grid-template-columns: repeat(2,1fr); } }
.db-spark-card { padding: 4px 0; }
.db-spark-value {
    font-family: 'JetBrains Mono', monospace;
    font-size: 18px;
    font-weight: 700;
    color: var(--atl-ink);
}

/* ── Social media cards ───────────────────────────────────────── */
.db-social-grid {
    display: grid;
    grid-template-columns: 1fr;
    gap: 12px;
}
@media (min-width: 576px)  { .db-social-grid { grid-template-columns: repeat(2,1fr); } }
@media (min-width: 992px)  { .db-social-grid { grid-template-columns: repeat(3,1fr); } }
@media (min-width: 1200px) { .db-social-grid { grid-template-columns: repeat(5,1fr); } }

.db-social-card {
    background: var(--atl-card);
    border: 1px solid var(--atl-line);
    border-radius: var(--atl-r-xl);
    padding: 14px 16px;
    display: flex;
    flex-direction: column;
    gap: 8px;
}
.db-social-header { display: flex; align-items: center; gap: 10px; }
.db-social-header i  { font-size: 18px; }
.db-social-name  { font-family: 'Outfit', sans-serif; font-size: 13px; color: var(--atl-ink); font-weight: 500; flex: 1; }
.db-social-trend { font-family: 'Outfit', sans-serif; font-size: 11px; font-weight: 600; }
.db-social-body  { display: flex; flex-direction: column; gap: 3px; }
.db-social-count { font-family: 'JetBrains Mono', monospace; font-size: 18px; font-weight: 700; color: var(--atl-ink); }
.db-social-label { font-family: 'Outfit', sans-serif; font-size: 11px; color: var(--atl-muted); }
.db-social-progress { height: 3px; background: var(--atl-line); border-radius: 2px; margin-top: 4px; position: relative; overflow: hidden; }
.db-social-progress::after {
    content: '';
    position: absolute;
    inset: 0;
    width: var(--db-pct, 0%);
    background: var(--atl-amber);
    border-radius: 2px;
}

/* ── Trend indicators ─────────────────────────────────────────── */
.trend-up   { color: var(--atl-sage);  }
.trend-down { color: var(--atl-clay);  }

/* ── Platform icon colours ────────────────────────────────────── */
.db-icon-fb { color: var(--db-fb-blue); }
.db-icon-ig { color: var(--db-ig-pink); }
.db-icon-x  { color: var(--db-x-ink);  }
.db-icon-yt { color: var(--db-yt-red); }
.db-icon-tt { color: var(--db-tt-red); }
</style>
```

---

## PHASE 6 — `#dashboardAdmin` JAVASCRIPT

**Locate** the existing `DOMContentLoaded` block that initialises the three hardcoded ApexCharts
instances (beginning near line 19271: `if (!document.querySelector("#bookingsChart")) return;`).
**Remove that entire block.**

**Replace with** the following script block, added within the main `<script>` section of
`admin.html`, after `loadDashboardKPIs()` definition:

```javascript
// ────────────────────────────────────────────────────────────────────────────
// DASHBOARD ANALYTICS — v2 live data
// ────────────────────────────────────────────────────────────────────────────

var _dbPeriod      = '30d';
var _dbChartVisitors = null;
var _dbChartSources  = null;
var _dbChartDevices  = null;
var _dbChartBookings = null;
var _dbSparkUsers    = null;
var _dbSparkViews    = null;

// ── 1. Theme-aware ApexCharts base options ────────────────────────────────
function dbApexBase() {
    var light = document.documentElement.getAttribute('data-theme') === 'light';
    return {
        chart:       { background: 'transparent', foreColor: light ? '#333' : '#aaa',
                       toolbar: { show: false }, animations: { enabled: true, speed: 600 } },
        theme:       { mode: light ? 'light' : 'dark' },
        colors:      ['#D4AF37', '#e0c04a', '#b08800'],
        grid:        { borderColor: light ? '#e0e0e0' : '#222' },
        tooltip:     { theme: light ? 'light' : 'dark' },
        legend:      { labels: { colors: light ? '#333' : '#ccc' } }
    };
}

// ── 2. Format helpers ─────────────────────────────────────────────────────
function dbFmtDuration(secs) {
    if (!secs || secs < 1) return '—';
    var m = Math.floor(secs / 60);
    var s = secs % 60;
    return m > 0 ? m + 'm ' + s + 's' : s + 's';
}
function dbFmtNum(n) {
    return n === undefined || n === null ? '—' : Number(n).toLocaleString('en-ZA');
}

// ── 3. Period selector wiring ─────────────────────────────────────────────
function dbSetPeriod(period) {
    _dbPeriod = period;
    document.querySelectorAll('.db-period-btn').forEach(function (btn) {
        btn.classList.toggle('active', btn.dataset.period === period);
    });
    loadAnalyticsDashboard();
}

document.addEventListener('click', function (e) {
    var btn = e.target.closest('.db-period-btn');
    if (!btn) return;
    dbSetPeriod(btn.dataset.period);
});

// ── 4. KPI summary ───────────────────────────────────────────────────────
function dbLoadKpiSummary() {
    fetch('/api/admin/analytics/summary?period=' + _dbPeriod, { credentials: 'same-origin' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) {
            if (!d || !d.success) return;
            var el = function (id) { return document.getElementById(id); };
            if (el('dbKpi-pageViews'))      el('dbKpi-pageViews').textContent      = dbFmtNum(d.pageviews);
            if (el('dbKpi-uniqueVisitors')) el('dbKpi-uniqueVisitors').textContent = dbFmtNum(d.unique_visitors);
            if (el('dbKpi-avgDuration'))    el('dbKpi-avgDuration').textContent    = dbFmtDuration(d.avg_dwell_secs);
            if (el('dbKpi-bounceRate'))     el('dbKpi-bounceRate').textContent     = (d.bounce_rate || 0) + '%';

            // Wire sparklines with real data from this same response cycle
            dbUpdateSparklines(d);
        })
        .catch(function () {});
}

function dbUpdateSparklines(summary) {
    // Sparklines show a conceptual bar from 0..max using the summary count
    var pv  = [0, summary.pageviews  || 0];
    var uv  = [0, summary.unique_visitors || 0];
    var base = dbApexBase();

    if (_dbSparkUsers) { _dbSparkUsers.destroy(); _dbSparkUsers = null; }
    if (_dbSparkViews) { _dbSparkViews.destroy(); _dbSparkViews = null; }

    if (document.querySelector('#sparkTotalUsers')) {
        _dbSparkUsers = new ApexCharts(document.querySelector('#sparkTotalUsers'), Object.assign({}, base, {
            series: [{ data: uv }],
            chart: Object.assign({}, base.chart, { type: 'bar', height: 60, sparkline: { enabled: true } }),
            plotOptions: { bar: { columnWidth: '80%' } }
        }));
        _dbSparkUsers.render();
    }
    if (document.querySelector('#sparkPageViews')) {
        _dbSparkViews = new ApexCharts(document.querySelector('#sparkPageViews'), Object.assign({}, base, {
            series: [{ data: pv }],
            chart: Object.assign({}, base.chart, { type: 'line', height: 60, sparkline: { enabled: true } }),
            stroke: { curve: 'smooth', width: 2 },
            tooltip: { fixed: { enabled: false }, x: { show: false }, marker: { show: false } }
        }));
        _dbSparkViews.render();
    }

    // Update spark card header values
    var svu = document.querySelector('#sparkTotalUsers')
        && document.querySelector('#sparkTotalUsers').closest('.db-spark-card')
        && document.querySelector('#sparkTotalUsers').closest('.db-spark-card').querySelector('.db-spark-value');
    if (svu) svu.innerHTML = dbFmtNum(summary.unique_visitors) + ' <span class="trend-up">visitors</span>';

    var svp = document.querySelector('#sparkPageViews')
        && document.querySelector('#sparkPageViews').closest('.db-spark-card')
        && document.querySelector('#sparkPageViews').closest('.db-spark-card').querySelector('.db-spark-value');
    if (svp) svp.innerHTML = dbFmtNum(summary.pageviews) + ' <span class="trend-up">views</span>';
}

// ── 5. Visitors over time chart ───────────────────────────────────────────
function dbLoadVisitorsChart() {
    var el = document.getElementById('db-chartVisitors');
    if (!el) return;
    fetch('/api/admin/analytics/visits-over-time?period=' + _dbPeriod, { credentials: 'same-origin' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) {
            if (!d || !d.success) return;
            var labels = d.rows.map(function (r) { return r.label; });
            var pvs    = d.rows.map(function (r) { return r.pageviews || 0; });
            var uvs    = d.rows.map(function (r) { return r.unique_visitors || 0; });
            var base   = dbApexBase();

            if (_dbChartVisitors) { _dbChartVisitors.destroy(); _dbChartVisitors = null; }
            _dbChartVisitors = new ApexCharts(el, Object.assign({}, base, {
                series: [
                    { name: 'Page Views',       data: pvs },
                    { name: 'Unique Visitors',  data: uvs }
                ],
                chart: Object.assign({}, base.chart, { type: 'area', height: 260 }),
                xaxis: { categories: labels, tickAmount: 7, labels: { rotate: -30 } },
                yaxis: { min: 0 },
                fill:  { type: 'gradient', gradient: { opacityFrom: 0.4, opacityTo: 0.05 } },
                stroke: { curve: 'smooth', width: 2 },
                dataLabels: { enabled: false }
            }));
            _dbChartVisitors.render();
        })
        .catch(function () {});
}

// ── 6. Traffic sources donut ──────────────────────────────────────────────
function dbLoadSourcesChart() {
    var el = document.getElementById('db-chartSources');
    if (!el) return;
    fetch('/api/admin/analytics/traffic-sources?period=' + _dbPeriod, { credentials: 'same-origin' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) {
            if (!d || !d.success || !d.rows.length) return;
            var base = dbApexBase();
            var labels = d.rows.map(function (r) { return r.channel; });
            var vals   = d.rows.map(function (r) { return r.pageviews; });

            if (_dbChartSources) { _dbChartSources.destroy(); _dbChartSources = null; }
            _dbChartSources = new ApexCharts(el, Object.assign({}, base, {
                series: vals,
                labels: labels,
                chart: Object.assign({}, base.chart, {
                    type: 'donut', height: 240
                }),
                plotOptions: { pie: { donut: { size: '68%' } } },
                dataLabels: { enabled: false },
                legend: Object.assign({}, base.legend, { position: 'bottom', fontSize: '11px' }),
                colors: ['#D4AF37','#e0c04a','#b08800','#7c5f00','#4a3800','#2a2000']
            }));
            _dbChartSources.render();
        })
        .catch(function () {});
}

// ── 7. Device breakdown donut ─────────────────────────────────────────────
function dbLoadDevicesChart() {
    var el = document.getElementById('db-chartDevices');
    if (!el) return;
    fetch('/api/admin/analytics/devices?period=' + _dbPeriod, { credentials: 'same-origin' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) {
            if (!d || !d.success || !d.rows.length) return;
            var base   = dbApexBase();
            var labels = d.rows.map(function (r) { return r.device_type || 'Unknown'; });
            var vals   = d.rows.map(function (r) { return r.pageviews; });

            if (_dbChartDevices) { _dbChartDevices.destroy(); _dbChartDevices = null; }
            _dbChartDevices = new ApexCharts(el, Object.assign({}, base, {
                series: vals,
                labels: labels,
                chart: Object.assign({}, base.chart, {
                    type: 'donut', height: 240
                }),
                plotOptions: { pie: { donut: { size: '68%' } } },
                dataLabels: { enabled: false },
                legend: Object.assign({}, base.legend, { position: 'bottom', fontSize: '11px' }),
                colors: ['#D4AF37','#e0c04a','#8a6d00']
            }));
            _dbChartDevices.render();
        })
        .catch(function () {});
}

// ── 8. Bookings trend chart (replaces hardcoded #bookingsChart) ───────────
function dbLoadBookingsChart() {
    var el = document.querySelector('#bookingsChart');
    if (!el) return;
    fetch('/api/admin/analytics/bookings-trend?period=' + _dbPeriod, { credentials: 'same-origin' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) {
            if (!d || !d.success) return;
            var labels    = d.rows.map(function (r) { return r.label; });
            var all       = d.rows.map(function (r) { return r.bookings   || 0; });
            var confirmed = d.rows.map(function (r) { return r.confirmed  || 0; });
            var base      = dbApexBase();

            if (_dbChartBookings) { _dbChartBookings.destroy(); _dbChartBookings = null; }
            _dbChartBookings = new ApexCharts(el, Object.assign({}, base, {
                series: [
                    { name: 'All Bookings',       data: all },
                    { name: 'Confirmed / Quoted', data: confirmed }
                ],
                chart: Object.assign({}, base.chart, { type: 'area', height: 300 }),
                xaxis: { categories: labels, tickAmount: 7 },
                fill:  { type: 'gradient', gradient: { opacityFrom: 0.4, opacityTo: 0.05 } },
                stroke: { curve: 'smooth', width: 2 },
                dataLabels: { enabled: false },
                yaxis: { min: 0, forceNiceScale: true, labels: { formatter: function (v) { return Math.round(v); } } }
            }));
            _dbChartBookings.render();
        })
        .catch(function () {
            // Fall back to empty chart on error so the mount point is never blank
            if (_dbChartBookings) return;
            var base = dbApexBase();
            _dbChartBookings = new ApexCharts(document.querySelector('#bookingsChart'), Object.assign({}, base, {
                series: [{ name: 'Bookings', data: [] }],
                chart: Object.assign({}, base.chart, { type: 'area', height: 300 }),
                noData: { text: 'No booking data yet', style: { color: '#888' } }
            }));
            _dbChartBookings.render();
        });
}

// ── 9. Today's schedule (live from calendar API) ──────────────────────────
function loadTodaysSchedule() {
    var list    = document.getElementById('dbScheduleList');
    var spinner = document.getElementById('dbScheduleSpinner');
    var empty   = document.getElementById('dbScheduleEmpty');
    if (!list) return;

    if (spinner) spinner.style.display = '';
    if (empty)   empty.style.display   = 'none';
    // Remove existing items (keep spinner + empty)
    list.querySelectorAll('.db-schedule-item').forEach(function (el) { el.remove(); });

    fetch('/api/admin/analytics/todays-schedule', { credentials: 'same-origin' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) {
            if (spinner) spinner.style.display = 'none';
            if (!d || !d.success || !d.rows.length) {
                if (empty) empty.style.display = 'flex';
                return;
            }
            d.rows.forEach(function (ev) {
                var startTime = ev.start ? new Date(ev.start).toLocaleTimeString('en-ZA', {
                    hour: '2-digit', minute: '2-digit', hour12: true
                }) : '—';
                var item = document.createElement('div');
                item.className = 'db-schedule-item';
                item.innerHTML =
                    '<div class="db-schedule-time">' + startTime + '</div>' +
                    '<div class="db-schedule-title">' + (ev.title || 'Event') + '</div>' +
                    '<div class="db-schedule-desc">'  + (ev.description || '') + '</div>';
                list.insertBefore(item, spinner || null);
            });
        })
        .catch(function () {
            if (spinner) spinner.style.display = 'none';
            if (empty)   empty.style.display   = 'flex';
        });
}

// ── 10. Master loader ─────────────────────────────────────────────────────
function loadAnalyticsDashboard() {
    // Only run if the dashboard section is visible
    var dash = document.getElementById('dashboardAdmin');
    if (!dash || dash.style.display === 'none') return;

    dbLoadKpiSummary();
    dbLoadVisitorsChart();
    dbLoadSourcesChart();
    dbLoadDevicesChart();
    dbLoadBookingsChart();
    // Schedule is loaded separately via loadTodaysSchedule() hook in switchTab
}

// Init on DOMContentLoaded in case dashboard is the default active section
document.addEventListener('DOMContentLoaded', function () {
    // Short delay so the DOM is settled and ApexCharts CDN has loaded
    setTimeout(function () {
        if (document.getElementById('dashboardAdmin')
            && document.getElementById('dashboardAdmin').style.display !== 'none') {
            loadAnalyticsDashboard();
            loadTodaysSchedule();
        }
    }, 400);

    // Social progress bars: set CSS custom property from data-percent
    document.querySelectorAll('.db-social-progress[data-percent]').forEach(function (el) {
        el.style.setProperty('--db-pct', el.getAttribute('data-percent') + '%');
    });
});
```

### 6A — Extend `switchTab` hook

**Locate** (line ~15833):
```javascript
if (sectionId === 'dashboardAdmin' && typeof loadDashboardKPIs === 'function') {
    loadDashboardKPIs();
}
```

**Replace with:**
```javascript
if (sectionId === 'dashboardAdmin' && typeof loadDashboardKPIs === 'function') {
    loadDashboardKPIs();
    if (typeof loadAnalyticsDashboard === 'function') loadAnalyticsDashboard();
    if (typeof loadTodaysSchedule      === 'function') loadTodaysSchedule();
}
```

---

## PHASE 7 — `index.html` — ADD TRACKER

Immediately before `</body>` in `index.html`, add:

```html
<!-- First-party analytics tracker -->
<script src="/tracker.js" data-site="thabiso" async></script>
```

Also add `data-track="book_now"` to all primary booking CTA buttons/links in `index.html`:

```html
<!-- Example (find the actual booking anchor/button and add the attribute) -->
<a href="#booking" class="..." data-track="book_now">Book Now</a>
```

---

## ACCEPTANCE CRITERIA

| # | Criterion | Pass condition |
|---|---|---|
| 1 | Tracker fires on `index.html` load | Network tab shows `POST /api/public/analytics/track` with `event: pageview` |
| 2 | Row appears in `analytics_pageviews` after visit | SQLite query returns ≥1 row |
| 3 | Period selector changes all dashboard charts | Clicking 7d/30d/90d triggers new API calls and re-renders charts |
| 4 | `#bookingsChart` shows real data | Chart series not identical to the old hardcoded `[31,40,28,51,42,109,100]` series |
| 5 | Today's schedule is live | Items match `/api/admin/calendar/events` for today's date |
| 6 | `#sparkTotalUsers` and `#sparkPageViews` show real analytics counts | Values change when new analytics_pageviews rows exist |
| 7 | All existing CRM KPI tiles still load | `dashStat-bookingsAdmin` etc. populate as before |
| 8 | `loadDashboardKPIs()` signature unchanged | Function works identically to the pre-change version |
| 9 | No hardcoded hex in dashboard `<style>` block | `grep '#[0-9a-f]\{3,6\}' dashboardAdmin-style-block` returns only brand colour vars |
| 10 | Light theme: all dashboard elements readable | Toggle to `data-theme=light`; no invisible text or white-on-white surfaces |
| 11 | Rate limiter on tracker endpoint | 201+ rapid POSTs from same IP return 429 |
| 12 | No raw IP stored | `SELECT * FROM analytics_pageviews LIMIT 1` shows no IP column |

---

## TEST PLAN

### Normal flow
1. Open `index.html` in a browser → wait 5s → check `analytics_pageviews`: 1 row present.
2. Stay on page 25s → check `analytics_pageviews.dwell_seconds` > 0 (heartbeat fired).
3. Close tab → check `dwell_seconds` increased (exit beacon).
4. Open `admin.html` → navigate to Dashboard → confirm charts render and KPI cards show real numbers.
5. Click 7d / 30d / 90d period buttons → confirm API calls change `?period=` param and charts update.

### Edge cases
- Visit from mobile: `device_type` column = `mobile` in DB.
- Visit via `?utm_source=instagram`: `channel` = `Social` in DB.
- Visit with no referrer: `channel` = `Direct`.
- `analytics_sessions` table empty: charts show empty state (`noData` text in ApexCharts); no JS error.
- `calendar_events` table does not exist yet: `todays-schedule` returns `{ success: true, rows: [] }` without crashing; schedule shows empty state icon.

### Regression
- All 18 existing `loadDashboardKPIs()` endpoints still return data.
- `bookingsAdmin`, `financeAdmin`, `calendarAdmin` sections unaffected.
- Existing modals (`adminBookingModal`, `quoteModal`, etc.) open correctly.
- Login / logout flow unchanged.

---

## IMPLEMENTATION ORDER

Execute phases in strict sequence. Validate the database tables exist (SQLite CLI or logs)
before proceeding to server routes. Validate the tracking endpoint with `curl` before building
the dashboard frontend. Never batch multiple phases into one edit.

```
Phase 1: database.js — add 3 tables + indexes
Phase 2: tracker.js — create file at project root
Phase 3A: server.js — npm requires (geoip-lite, ua-parser-js)
Phase 3B: server.js — analyticsTrackLimiter
Phase 3C: server.js — classifyChannel() helper
Phase 3D: server.js — POST /api/public/analytics/track
Phase 3E: server.js — 6 protected GET endpoints
Phase 3F: server.js — midnight aggregation cron
Phase 4: admin.html HTML — replace .db-crm-grid, add chart containers, wire schedule list
Phase 5: admin.html CSS — replace entire inline <style> block
Phase 6: admin.html JS — add all dashboard functions, remove old DOMContentLoaded block
Phase 6A: admin.html — extend switchTab hook
Phase 7: index.html — add tracker <script> tag + data-track attributes
```
