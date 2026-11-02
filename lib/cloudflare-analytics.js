// Cloudflare's own traffic figures for the admin Dashboard (Overview, Geography, Performance & Security) - everything that reaches the site
// through Cloudflare, counted without cookies, so it includes visitors who decline analytics and the automated traffic the site's own
// tracker never sees.
//
// Needs two settings on the server (Render > Environment), never sent to a browser:
//   CLOUDFLARE_API_TOKEN - a READ-ONLY API token with the single permission "Zone > Analytics > Read" for this site's zone
//   CLOUDFLARE_ZONE_ID   - the zone's ID (Cloudflare dashboard > the domain's Overview page, right-hand column)
// Without them every call answers { connected: false } and the Dashboard shows how to connect.
//
// Data: Cloudflare's GraphQL Analytics API, httpRequests1dGroups (daily) or httpRequests1hGroups (hourly, for a day or two). Answers are
// kept for 10 minutes per range, so opening and refreshing the Dashboard does not keep calling Cloudflare. Cloudflare limits how far back
// each plan may look; a refused range comes back as { error } with Cloudflare's own reason, shown on the Dashboard.
// No database here: pure fetch + reshaping (test/cloudflare-analytics.test.js drives it with a stand-in for Cloudflare).

const API = 'https://api.cloudflare.com/client/v4/graphql';
const CACHE_MS = 10 * 60 * 1000;
const TIMEOUT_MS = 12000;
const cache = new Map();

function config(env) {
    const e = env || process.env;
    const token = String(e.CLOUDFLARE_API_TOKEN || '').trim();
    const zone = String(e.CLOUDFLARE_ZONE_ID || '').trim();
    return { configured: !!(token && /^[a-f0-9]{32}$/i.test(zone)), token, zone, partial: !!(token || zone) && !(token && zone) };
}

// Cloudflare's IP classes, split into people and automated / suspicious traffic
const AUTOMATED = new Set(['searchEngine', 'monitoringService', 'backupService', 'scan', 'badHost', 'tor', 'noRecord']);
const IP_CLASS_LABEL = {
    clean: 'People (ordinary connections)', mobilePlatform: 'People on mobile networks', whitelist: 'Allow-listed', searchEngine: 'Search-engine crawlers',
    monitoringService: 'Uptime / monitoring services', backupService: 'Backup services', scan: 'Scanners', badHost: 'Known bad hosts', tor: 'Tor network', unknown: 'Unknown', noRecord: 'No record'
};
// what a content type counts as (for "what uses the bandwidth")
function resourceCategory(ct) {
    const t = String(ct || '').toLowerCase();
    if (/^(jpeg|jpg|png|gif|webp|avif|svg|ico|bmp|image)/.test(t)) return 'Images';
    if (/^(mp4|webm|mov|video|ogg|mpeg)/.test(t)) return 'Video';
    if (/^(woff|woff2|ttf|otf|font)/.test(t)) return 'Fonts';
    if (/^(js|mjs|javascript)$/.test(t)) return 'Scripts';                 // exact: "json" is data, not a script
    if (/^css/.test(t)) return 'Stylesheets';
    if (/^html/.test(t)) return 'Pages (HTML)';
    if (/^(json|xml|txt|plain)/.test(t)) return 'Data (API)';
    if (/^pdf/.test(t)) return 'Documents (PDF)';
    if (!t || t === 'empty') return 'No body (redirects, empty replies)';
    return 'Other';
}

const FIELDS = `
    sum {
        requests cachedRequests bytes cachedBytes threats pageViews
        countryMap { clientCountryName requests bytes threats }
        responseStatusMap { edgeResponseStatus requests }
        contentTypeMap { edgeResponseContentTypeName requests bytes }
        ipClassMap { ipType requests }
    }
    uniq { uniques }`;

function buildQuery(range) {
    const hourly = range.granularity === 'hour';
    if (hourly) {
        // the last 24 hours (or the two days) in UTC instants
        return {
            hourly,
            query: `query($zone: String!, $from: Time!, $to: Time!) { viewer { zones(filter: { zoneTag: $zone }) {
                httpRequests1hGroups(limit: 200, orderBy: [datetime_ASC], filter: { datetime_geq: $from, datetime_lt: $to }) { dimensions { datetime } ${FIELDS} } } } }`
        };
    }
    return {
        hourly,
        query: `query($zone: String!, $from: Date!, $to: Date!) { viewer { zones(filter: { zoneTag: $zone }) {
            httpRequests1dGroups(limit: 1000, orderBy: [date_ASC], filter: { date_geq: $from, date_leq: $to }) { dimensions { date } ${FIELDS} } } } }`
    };
}

async function callCloudflare(cfg, query, variables, fetchImpl) {
    const f = fetchImpl || fetch;
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), TIMEOUT_MS) : null;
    try {
        const r = await f(process.env.CLOUDFLARE_API_BASE || API, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.token },
            body: JSON.stringify({ query, variables }),
            signal: ctl ? ctl.signal : undefined
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || (j.errors && j.errors.length)) {
            const msg = (j.errors && j.errors[0] && j.errors[0].message) || ('Cloudflare answered ' + r.status);
            const err = new Error(msg);
            err.auth = r.status === 401 || r.status === 403 || /authenticat|permission|not authorized/i.test(msg);
            throw err;
        }
        const zones = j.data && j.data.viewer && j.data.viewer.zones;
        if (!zones || !zones.length) { const err = new Error('Cloudflare did not return this zone - check CLOUDFLARE_ZONE_ID.'); err.auth = true; throw err; }
        return zones[0];
    } finally { if (timer) clearTimeout(timer); }
}

// Turns Cloudflare's groups into the Dashboard's figures.
function summarise(groups, hourly) {
    const t = { requests: 0, cachedRequests: 0, bytes: 0, cachedBytes: 0, threats: 0, pageViews: 0, uniques: 0 };
    const countries = {}, statuses = {}, types = {}, ipClasses = {};
    const series = [];
    (groups || []).forEach(g => {
        const s = g.sum || {};
        t.requests += s.requests || 0; t.cachedRequests += s.cachedRequests || 0; t.bytes += s.bytes || 0; t.cachedBytes += s.cachedBytes || 0;
        t.threats += s.threats || 0; t.pageViews += s.pageViews || 0;
        // unique IPs cannot be added across days (the same visitor on two days); the sum is an upper bound, labelled as such
        t.uniques += (g.uniq && g.uniq.uniques) || 0;
        series.push({ bucket: hourly ? g.dimensions.datetime : g.dimensions.date, requests: s.requests || 0, cachedRequests: s.cachedRequests || 0, bytes: s.bytes || 0, cachedBytes: s.cachedBytes || 0, threats: s.threats || 0, uniques: (g.uniq && g.uniq.uniques) || 0 });
        (s.countryMap || []).forEach(c => { const k = c.clientCountryName || 'XX'; const o = countries[k] = countries[k] || { code: k, requests: 0, bytes: 0, threats: 0 }; o.requests += c.requests || 0; o.bytes += c.bytes || 0; o.threats += c.threats || 0; });
        (s.responseStatusMap || []).forEach(r => { const k = String(r.edgeResponseStatus); statuses[k] = (statuses[k] || 0) + (r.requests || 0); });
        (s.contentTypeMap || []).forEach(c => { const k = resourceCategory(c.edgeResponseContentTypeName); const o = types[k] = types[k] || { label: k, requests: 0, bytes: 0 }; o.requests += c.requests || 0; o.bytes += c.bytes || 0; });
        (s.ipClassMap || []).forEach(c => { const k = c.ipType || 'unknown'; ipClasses[k] = (ipClasses[k] || 0) + (c.requests || 0); });
    });
    const classes = { 'Successful (2xx)': 0, 'Redirects (3xx)': 0, 'Not found / refused (4xx)': 0, 'Server errors (5xx)': 0, Other: 0 };
    Object.keys(statuses).forEach(code => {
        const n = statuses[code], c = Number(code);
        if (c >= 200 && c < 300) classes['Successful (2xx)'] += n; else if (c >= 300 && c < 400) classes['Redirects (3xx)'] += n;
        else if (c >= 400 && c < 500) classes['Not found / refused (4xx)'] += n; else if (c >= 500) classes['Server errors (5xx)'] += n; else classes.Other += n;
    });
    const automated = Object.keys(ipClasses).filter(k => AUTOMATED.has(k)).reduce((a, k) => a + ipClasses[k], 0);
    const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);
    return {
        totals: {
            requests: t.requests, cachedRequests: t.cachedRequests, uncachedRequests: t.requests - t.cachedRequests,
            bytes: t.bytes, cachedBytes: t.cachedBytes, originBytes: Math.max(0, t.bytes - t.cachedBytes),
            cacheHitRatio: pct(t.cachedRequests, t.requests), bandwidthSavedRatio: pct(t.cachedBytes, t.bytes),
            threats: t.threats, pageViews: t.pageViews, uniquesSum: t.uniques,
            errors4xx: classes['Not found / refused (4xx)'], errors5xx: classes['Server errors (5xx)'],
            errorRate: pct(classes['Not found / refused (4xx)'] + classes['Server errors (5xx)'], t.requests),
            automatedRequests: automated, automatedShare: pct(automated, Object.values(ipClasses).reduce((a, b) => a + b, 0))
        },
        series,
        countries: Object.values(countries).sort((a, b) => b.requests - a.requests).slice(0, 12),
        statusClasses: Object.keys(classes).filter(k => classes[k]).map(k => ({ label: k, requests: classes[k] })),
        topStatuses: Object.keys(statuses).map(k => ({ code: Number(k), requests: statuses[k] })).sort((a, b) => b.requests - a.requests).slice(0, 8),
        resources: Object.values(types).sort((a, b) => b.bytes - a.bytes),
        traffic: Object.keys(ipClasses).map(k => ({ type: k, label: IP_CLASS_LABEL[k] || k, automated: AUTOMATED.has(k), requests: ipClasses[k] })).sort((a, b) => b.requests - a.requests)
    };
}

// Variables for a range: dates for daily groups, UTC instants for hourly ones (the last 24 hours ending now, for the '24h' preset).
function variablesFor(range, now) {
    if (range.granularity === 'hour') {
        const end = new Date(now || Date.now());
        end.setUTCMinutes(0, 0, 0);
        end.setUTCHours(end.getUTCHours() + 1);
        const start = new Date(end.getTime() - 24 * 3600e3);
        return { from: start.toISOString(), to: end.toISOString() };
    }
    return { from: range.from, to: range.to };
}

// zoneAnalytics(range, { env, fetchImpl, now }) -> { connected: false } | { connected: true, ...summary, previous: totals } | { connected: true, error }
async function zoneAnalytics(range, opts) {
    const o = opts || {};
    const cfg = config(o.env);
    if (!cfg.configured) return { connected: false, partial: cfg.partial };
    const key = `${cfg.zone}|${range.granularity}|${range.from}|${range.to}|${range.prevFrom}|${range.granularity === 'hour' ? Math.floor((o.now || Date.now()) / CACHE_MS) : ''}`;
    const hit = cache.get(key);
    if (!o.fetchImpl && hit && Date.now() - hit.at < CACHE_MS) return hit.value;
    let value;
    try {
        const { query, hourly } = buildQuery(range);
        const cur = await callCloudflare(cfg, query, { zone: cfg.zone, ...variablesFor(range, o.now) }, o.fetchImpl);
        const groups = hourly ? cur.httpRequests1hGroups : cur.httpRequests1dGroups;
        const summary = summarise(groups, hourly);
        // the previous equivalent period, totals only (for the % change on each card)
        let previous = null;
        if (!hourly) {
            try {
                const prev = await callCloudflare(cfg, query, { zone: cfg.zone, from: range.prevFrom, to: range.prevTo }, o.fetchImpl);
                previous = summarise(prev.httpRequests1dGroups, false).totals;
            } catch (e) { previous = null; }          // older than the plan allows: no comparison
        }
        value = { connected: true, hourly, ...summary, previous };
    } catch (e) {
        value = { connected: true, error: e.auth ? 'Cloudflare refused the API key: ' + e.message : 'Cloudflare could not be reached or refused this range: ' + e.message };
    }
    if (!o.fetchImpl) { cache.set(key, { at: Date.now(), value }); if (cache.size > 100) cache.delete(cache.keys().next().value); }
    return value;
}

module.exports = { config, summarise, resourceCategory, buildQuery, variablesFor, zoneAnalytics, AUTOMATED };
