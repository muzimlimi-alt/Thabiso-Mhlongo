/* Phase 6 (HOUSEKEEPING-NOTES.md): relocated from admin.html verbatim — Dashboard, two pieces
   concatenated: (1) loadDashboardKPIs (the small overview tiles) and (2) the full "Dashboard
   Analytics" module (KPI summary, visitor/traffic/device/bookings charts, today's schedule,
   social-visibility toggle). Both are plain top-level code, not inside any IIFE.

   Cross-references verified in both directions before this move: the anonymous mega-closure's
   switchTab (admin.html, see the Unified Calendar entry) calls loadDashboardKPIs/
   loadAnalyticsDashboard/loadTodaysSchedule bare on tab-show; a static onclick="" in markup
   calls loadAnalyticsDashboard() directly; and Social Media's own saveSocialKpiSettings (in
   js/admin/social.js) calls loadAnalyticsDashboard() bare too. None needed a new window
   attachment — all are plain function declarations, which (like var) become window properties
   automatically at the top level of any non-module script, reachable from anywhere regardless
   of which physical file they end up in. */

    async function loadDashboardKPIs() {
        const tiles = {
            homeAdmin:         { endpoint: '/api/admin/home-slider',              handler: arr => arr.length },
            aboutAdmin:        { endpoint: '/api/admin/about-me',                handler: obj => obj && obj.image_path ? 'Set' : '—' },
            careerAdmin:       { endpoint: '/api/public/highlights',             handler: arr => arr.length },
            galleryAdmin:      { endpoint: '/api/public/gallery',                handler: arr => arr.length },
            socialAdmin:       { endpoint: '/api/admin/social_links',            handler: arr => arr.filter(s => s.is_active).length },
            eventsAdmin:       { endpoint: '/api/admin/events',                  handler: arr => arr.filter(e => e.event_status === 'upcoming').length },
            contactAdmin:      { endpoint: '/api/public/contact_info',           handler: obj => (obj && obj.email) ? 'Configured' : '—' },
            inquiriesAdmin:    { endpoint: '/api/admin/inquiries',               handler: d => (d && d.counts) ? d.counts.unread : 0 },
            bookingsAdmin:     { endpoint: '/api/admin/bookings/full',           handler: arr => arr.filter(b => b.status === 'PENDING').length },
            calendarAdmin:     { endpoint: '/api/admin/calendar/events',         handler: arr => arr.filter(ev => ev.start && new Date(ev.start) > new Date()).length },
            financeAdmin:      { endpoint: '/api/admin/financials/stats',        handler: res => res.stats ? 'R ' + (res.stats.revenue / 1000).toFixed(0) + 'k' : '—' },
            servicesAdmin:     { endpoint: '/api/admin/services',                handler: arr => arr.filter(s => s.is_active !== 0).length },
            policiesAdmin:     { endpoint: '/api/admin/policies',                handler: obj => (obj && obj.policies && Object.keys(obj.policies).length) ? 'Active' : '—' },
            emailLogsAdmin:    { endpoint: '/api/admin/email-logs?limit=1',      handler: res => res.total || 0 },
            securityAdmin:     { endpoint: '/api/admin/audit_log?limit=500',     handler: res => (res.logs || []).length },
            preferencesAdmin:  { endpoint: '/api/admin/settings',                handler: obj => (obj && obj.settings && Object.keys(obj.settings).length) ? 'Customised' : 'Default' },
            usersAdmin:        { endpoint: '/api/admin/users',                   handler: arr => arr.length },
            brandingAdmin:     { endpoint: '/api/public/branding',               handler: b => (b && (b.primary_color || b.site_logo)) ? 'Custom' : 'Default' }
        };

        const fetchPromises = Object.entries(tiles).map(async ([id, { endpoint, handler }]) => {
            try {
                const res = await fetch(endpoint, { credentials: 'same-origin' });
                if (!res.ok) throw new Error('Failed');
                const data = await res.json();
                const value = handler(data);
                const el = document.getElementById('dashStat-' + id);
                if (el) el.textContent = value;
                // Update aria label
                const tile = el && el.closest('.dashboard-tile');
                if (tile) {
                    const label = tile.querySelector('h4').textContent + ' — ' + value;
                    tile.setAttribute('aria-label', label);
                }
            } catch (e) {
                const el = document.getElementById('dashStat-' + id);
                if (el) el.textContent = '—';
            }
        });

        await Promise.allSettled(fetchPromises);

        // Needs Action count
        fetch('/api/admin/bookings/full', { credentials: 'same-origin' }).then(r => r.json()).then(data => {
            const count = Array.isArray(data) ? data.filter(bookingNeedsAction).length : 0;
            const el = document.getElementById('dashNeedsActionCount');
            if (el) el.textContent = count > 0 ? count + ' need action' : 'All clear';
        }).catch(() => {});
    }

    var _dbPeriod      = '30d';
    var _dbChartVisitors = null;
    var _dbChartSources  = null;
    var _dbChartDevices  = null;
    var _dbChartBookings = null;
    var _dbSparkUsers    = null;
    var _dbSparkViews    = null;
    var _dbCountryMap    = null;

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

    function dbLoadSocialKPIs() {
        fetch('/api/admin/dashboard/social_kpis', { credentials: 'same-origin' })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (data) {
                if (!data || !data.success || !data.kpis) return;
                
                const platformIdMap = {
                    'Facebook': 'fb',
                    'Instagram': 'ig',
                    'X (Twitter)': 'x',
                    'YouTube': 'yt',
                    'TikTok': 'tt'
                };

                data.kpis.forEach(function (kpi) {
                    const idPrefix = platformIdMap[kpi.platform_name];
                    if (!idPrefix) return;

                    // Update count
                    const countEl = document.getElementById('dbSocial-' + idPrefix + '-count');
                    if (countEl) {
                        countEl.textContent = kpi.follower_count.toLocaleString();
                    }

                    // Update trend percentage and class — direction is the single
                    // source of truth for both the sign and the colour so they always agree.
                    const trendEl = document.getElementById('dbSocial-' + idPrefix + '-trend');
                    if (trendEl) {
                        const isDown = kpi.trend_direction === 'down';
                        const sign = isDown ? '−' : '+'; // minus sign / plus
                        trendEl.textContent = sign + Math.abs(kpi.trend_percentage).toFixed(1) + '%';

                        // Remove existing trend classes
                        trendEl.classList.remove('trend-up', 'trend-down');
                        trendEl.classList.add(isDown ? 'trend-down' : 'trend-up');
                    }

                    // Update progress bar against the admin-configured goal
                    const progressEl = document.getElementById('dbSocial-' + idPrefix + '-progress');
                    if (progressEl) {
                        const fallbackGoals = {
                            'Facebook': 20000,
                            'Instagram': 25000,
                            'X (Twitter)': 20000,
                            'YouTube': 25000,
                            'TikTok': 100000
                        };
                        const goal = (kpi.goal_target && kpi.goal_target > 0)
                            ? kpi.goal_target
                            : (fallbackGoals[kpi.platform_name] || 50000);
                        const percent = Math.min(100, Math.round((kpi.follower_count / goal) * 100));

                        progressEl.setAttribute('data-percent', percent);
                        progressEl.style.setProperty('--db-pct', percent + '%');
                    }
                });
            })
            .catch(function (e) {
                console.error('Failed to load social KPIs', e);
            });
    }

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
                var base = dbApexBase();
                if (_dbChartVisitors) { _dbChartVisitors.destroy(); _dbChartVisitors = null; }
                if (!d || !d.success || !d.rows.length) {
                    _dbChartVisitors = new ApexCharts(el, Object.assign({}, base, {
                        series: [{ name: 'Page Views', data: [] }, { name: 'Unique Visitors', data: [] }],
                        chart: Object.assign({}, base.chart, { type: 'area', height: 260 }),
                        noData: { text: 'No visits tracked yet — embed tracker.js to start collecting data.', style: { color: 'var(--atl-muted)', fontSize: '13px' } },
                        xaxis: { labels: { show: false } }, yaxis: { min: 0 },
                        stroke: { curve: 'smooth', width: 2 }, dataLabels: { enabled: false }
                    }));
                    _dbChartVisitors.render();
                    return;
                }
                var labels = d.rows.map(function (r) { return r.label; });
                var pvs    = d.rows.map(function (r) { return r.pageviews || 0; });
                var uvs    = d.rows.map(function (r) { return r.unique_visitors || 0; });
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
                var base = dbApexBase();
                if (_dbChartSources) { _dbChartSources.destroy(); _dbChartSources = null; }
                if (!d || !d.success || !d.rows.length) {
                    _dbChartSources = new ApexCharts(el, Object.assign({}, base, {
                        series: [1], labels: ['No data yet'],
                        chart: Object.assign({}, base.chart, { type: 'donut', height: 240 }),
                        plotOptions: { pie: { donut: { size: '68%', labels: { show: true, total: { show: true, label: 'Sources', formatter: function() { return '—'; } } } } } },
                        colors: ['var(--atl-line)'],
                        dataLabels: { enabled: false },
                        legend: { show: false },
                        tooltip: { enabled: false }
                    }));
                    _dbChartSources.render();
                    return;
                }
                var labels = d.rows.map(function (r) { return r.channel; });
                var vals   = d.rows.map(function (r) { return r.pageviews; });
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
                var base = dbApexBase();
                if (_dbChartDevices) { _dbChartDevices.destroy(); _dbChartDevices = null; }
                if (!d || !d.success || !d.rows.length) {
                    _dbChartDevices = new ApexCharts(el, Object.assign({}, base, {
                        series: [1], labels: ['No data yet'],
                        chart: Object.assign({}, base.chart, { type: 'donut', height: 240 }),
                        plotOptions: { pie: { donut: { size: '68%', labels: { show: true, total: { show: true, label: 'Devices', formatter: function() { return '—'; } } } } } },
                        colors: ['var(--atl-line)'],
                        dataLabels: { enabled: false },
                        legend: { show: false },
                        tooltip: { enabled: false }
                    }));
                    _dbChartDevices.render();
                    return;
                }
                var labels = d.rows.map(function (r) { return r.device_type || 'Unknown'; });
                var vals   = d.rows.map(function (r) { return r.pageviews; });
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

    // ── 7b. Ranked-list helpers + Top Locations / Top Pages ───────────────────
    function dbEsc(s) {
        return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
        });
    }
    // ISO 3166 alpha-2 → regional-indicator flag emoji (globe for unknown/non-geo codes)
    function dbCountryFlag(code) {
        if (!code || typeof code !== 'string') return '🌐';
        var cc = code.trim().toUpperCase();
        if (!/^[A-Z]{2}$/.test(cc) || cc === 'ZZ' || cc === 'XX') return '🌐';
        return String.fromCodePoint(0x1F1E6 + (cc.charCodeAt(0) - 65))
             + String.fromCodePoint(0x1F1E6 + (cc.charCodeAt(1) - 65));
    }
    // Turn a raw page path into a friendly label (Home, Events, Gallery, …)
    function dbPrettyPage(p) {
        if (!p) return 'Home';
        var path = String(p).split('?')[0].split('#')[0];
        var frag = String(p).indexOf('#') > -1 ? String(p).split('#')[1] : '';
        if (frag) return frag.charAt(0).toUpperCase() + frag.slice(1);
        if (path === '/' || path === '' || /\/index(\.html)?$/i.test(path)) return 'Home';
        return path.replace(/\.html?$/i, '').replace(/^\//, '').replace(/\/$/, '')
                   .replace(/[-_]/g, ' ')
                   .replace(/\b\w/g, function (c) { return c.toUpperCase(); }) || 'Home';
    }
    function dbRenderRankList(elId, rows, opts) {
        var el = document.getElementById(elId);
        if (!el) return;
        if (!rows || !rows.length) {
            el.innerHTML = '<div class="db-rank-empty">' + (opts.empty || 'No data tracked yet.') + '</div>';
            return;
        }
        var max = rows.reduce(function (m, r) { return Math.max(m, opts.value(r)); }, 0) || 1;
        el.innerHTML = rows.map(function (r, i) {
            var val = opts.value(r);
            var pct = Math.max(4, Math.round((val / max) * 100));
            return '<div class="db-rank-item">' +
                    '<span class="db-rank-idx">' + (i + 1) + '</span>' +
                    '<span class="db-rank-main">' +
                        '<span class="db-rank-label">' + opts.label(r) + '</span>' +
                        '<span class="db-rank-bar" style="--db-rank-pct:' + pct + '%"></span>' +
                    '</span>' +
                    '<span class="db-rank-value">' + dbFmtNum(val) +
                        (opts.sub ? '<small>' + opts.sub(r) + '</small>' : '') +
                    '</span>' +
                '</div>';
        }).join('');
    }
    function dbLoadCountries() {
        if (!document.getElementById('db-listCountries')) return;
        fetch('/api/admin/analytics/countries?period=' + _dbPeriod, { credentials: 'same-origin' })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (d) {
                dbRenderRankList('db-listCountries', d && d.success ? d.rows : [], {
                    empty: 'No location data tracked yet.',
                    value: function (r) { return r.visitors || 0; },
                    label: function (r) { return dbCountryFlag(r.code) + ' ' + dbEsc(r.country || 'Unknown'); },
                    sub:   function (r) { return dbFmtNum(r.pageviews) + ' views'; }
                });
            })
            .catch(function () {});
    }
    function dbLoadTopPages() {
        if (!document.getElementById('db-listPages')) return;
        fetch('/api/admin/analytics/top-pages?period=' + _dbPeriod, { credentials: 'same-origin' })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (d) {
                dbRenderRankList('db-listPages', d && d.success ? d.rows : [], {
                    empty: 'No page-view data tracked yet.',
                    value: function (r) { return r.pageviews || 0; },
                    label: function (r) { return dbEsc(dbPrettyPage(r.page)); },
                    sub:   function (r) { return dbFmtNum(r.visitors) + ' visitors'; }
                });
            })
            .catch(function () {});
    }

    // ── 7c. Visits-by-country world map (jsVectorMap choropleth) ──────────────
    function dbLoadCountryMap() {
        var el = document.getElementById('db-mapCountries');
        if (!el || typeof jsVectorMap === 'undefined') return;
        fetch('/api/admin/analytics/countries?period=' + _dbPeriod, { credentials: 'same-origin' })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (d) {
                var rows = (d && d.success && d.rows) ? d.rows : [];
                // Build {ISO-alpha2: visitors}, skipping non-geographic codes (ZZ/XX/Unknown)
                var values = {}, maxV = 0;
                rows.forEach(function (r) {
                    var cc = (r.code || '').toString().trim().toUpperCase();
                    if (!/^[A-Z]{2}$/.test(cc) || cc === 'ZZ' || cc === 'XX') return;
                    var v = r.visitors || 0;
                    values[cc] = v;
                    if (v > maxV) maxV = v;
                });

                var light      = document.documentElement.getAttribute('data-theme') === 'light';
                var regionBase = light ? '#e4e4e4' : '#333b4d';
                var regionLine = light ? '#ffffff' : '#1c2230';
                // Map a 0..1 intensity to a dark→bright amber shade (smallest count stays visibly amber)
                function amberShade(t) {
                    t = Math.max(0, Math.min(1, t));
                    var u = 0.40 + 0.60 * t;
                    return 'rgb(' + Math.round(74 + 138 * u) + ',' + Math.round(58 + 117 * u) + ',' + Math.round(15 + 40 * u) + ')';
                }

                // Recreate cleanly (jsVectorMap appends an SVG on each init)
                if (_dbCountryMap) { try { _dbCountryMap.destroy(); } catch (e) {} _dbCountryMap = null; }
                el.innerHTML = '';

                try {
                    _dbCountryMap = new jsVectorMap({
                        selector: '#db-mapCountries',
                        map: 'world_merc',
                        backgroundColor: 'transparent',
                        zoomOnScroll: false,
                        zoomButtons: true,
                        regionStyle: {
                            initial: { fill: regionBase, stroke: regionLine, strokeWidth: 0.4, fillOpacity: 1 },
                            hover:   { fill: '#e0c04a' }
                        },
                        // jsVectorMap's numeric scale renders unreliably (and breaks for a
                        // single country), so we paint each visited region directly instead.
                        onLoaded: function (map) {
                            Object.keys(values).forEach(function (cc) {
                                var reg = map.regions[cc];
                                if (reg && reg.element) {
                                    reg.element.setStyle('fill', amberShade(maxV > 0 ? values[cc] / maxV : 1));
                                }
                            });
                        },
                        onRegionTooltipShow: function (event, tooltip, code) {
                            var v = values[code];
                            tooltip.text(
                                '<div style="font-weight:700;">' + tooltip.text() + '</div>' +
                                '<div style="font-size:11px;opacity:.85;">' +
                                    (v ? (v.toLocaleString('en-ZA') + ' visitor' + (v === 1 ? '' : 's')) : 'No visits tracked') +
                                '</div>',
                                true
                            );
                        }
                    });
                } catch (e) {
                    // If the map engine/data failed to load, leave the ranked list as the fallback.
                    el.innerHTML = '<div class="db-rank-empty">Map unavailable.</div>';
                }
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

    // ── 9. Today's schedule (bookings + date holds + public events) ─────────────
    function loadTodaysSchedule() {
        var list    = document.getElementById('dbScheduleList');
        var spinner = document.getElementById('dbScheduleSpinner');
        var empty   = document.getElementById('dbScheduleEmpty');
        if (!list) return;

        if (spinner) spinner.style.display = '';
        if (empty)   empty.style.display   = 'none';
        list.querySelectorAll('.db-schedule-item').forEach(function (el) { el.remove(); });

        fetch('/api/admin/analytics/todays-schedule', { credentials: 'same-origin' })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (d) {
                if (spinner) spinner.style.display = 'none';
                if (!d || !d.success || !d.rows.length) {
                    if (empty) empty.style.display = 'flex';
                    return;
                }
                var iconMap  = { booking: 'fa-calendar-check', hold: 'fa-ban', event: 'fa-star' };
                var colorMap = { booking: 'var(--atl-amber)', hold: 'var(--atl-clay)', event: 'var(--atl-sage)' };
                d.rows.forEach(function (ev) {
                    var icon  = iconMap[ev.source]  || 'fa-calendar';
                    var color = colorMap[ev.source] || 'var(--atl-amber)';
                    var desc  = ev.location || ev.client_name || '';
                    var item  = document.createElement('div');
                    item.className = 'db-schedule-item';
                    item.innerHTML =
                        '<div class="db-schedule-time"></div>' +
                        '<i class="fa-solid ' + icon + '" style="color:' + color + ';font-size:13px;flex-shrink:0;margin-right:6px;"></i>' +
                        '<div class="db-schedule-title" style="flex:1;"></div>' +
                        '<div class="db-schedule-desc"></div>';
                    item.querySelector('.db-schedule-time').textContent  = ev.start_time || '—';
                    item.querySelector('.db-schedule-title').textContent = ev.title || 'Untitled';
                    item.querySelector('.db-schedule-desc').textContent  = desc;
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
        dbLoadCountries();
        dbLoadCountryMap();
        dbLoadTopPages();
        dbLoadBookingsChart();
        dbLoadSocialKPIs();
        applyDashboardSocialVisibility();
        // Schedule is loaded separately via loadTodaysSchedule() hook in switchTab
    }

    // ── Dashboard "Social Media cards" show/hide preference (Social → Dashboard KPIs) ──
    // Persisted in the generic settings KV so it survives reloads; applied to the
    // dashboard's .db-social-grid. Default: shown.
    window.__dashShowSocial = (window.__dashShowSocial !== false);
    function applyDashboardSocialVisibility() {
        var show = window.__dashShowSocial !== false;
        document.querySelectorAll('#dashboardAdmin .db-social-grid').forEach(function (el) {
            el.style.display = show ? '' : 'none';
        });
    }
    async function initDashboardSocialPref() {
        try {
            const r = await apiCall('/api/admin/settings');
            if (r && r.settings && typeof r.settings.dashboard_show_social_cards !== 'undefined') {
                window.__dashShowSocial = String(r.settings.dashboard_show_social_cards) !== '0';
            }
        } catch (e) { /* keep default (shown) on failure */ }
        var cb = document.getElementById('dashSocialCardsToggle');
        if (cb) cb.checked = (window.__dashShowSocial !== false);
        applyDashboardSocialVisibility();
    }
    $(document).on('change', '#dashSocialCardsToggle', async function () {
        var show = this.checked;
        window.__dashShowSocial = show;
        applyDashboardSocialVisibility();
        try {
            await apiCall('/api/admin/settings', 'PUT', { settings: { dashboard_show_social_cards: show ? '1' : '0' } });
            if (window.notificationService) {
                window.notificationService.showSuccess(show ? 'Social Media cards shown on the dashboard.' : 'Social Media cards hidden from the dashboard.');
            }
        } catch (e) {
            if (window.notificationService) window.notificationService.showError('Could not save the setting. Please try again.');
        }
    });

    // Init on DOMContentLoaded in case dashboard is the default active section
    document.addEventListener('DOMContentLoaded', function () {
        // Short delay so auth check (async) can complete and show dashboardSection
        // dashboardAdmin is always display:block — check dashboardSection instead,
        // which starts display:none and is set to flex only after successful login.
        setTimeout(function () {
            var sect = document.getElementById('dashboardSection');
            if (sect && sect.style.display !== 'none') {
                loadAnalyticsDashboard();
                loadTodaysSchedule();
            }
            // Load the saved "show Social Media cards" preference and apply it (also syncs the toggle).
            if (typeof initDashboardSocialPref === 'function') initDashboardSocialPref();
        }, 400);

        // Social progress bars: set CSS custom property from data-percent
        document.querySelectorAll('.db-social-progress[data-percent]').forEach(function (el) {
            el.style.setProperty('--db-pct', el.getAttribute('data-percent') + '%');
        });
    });
