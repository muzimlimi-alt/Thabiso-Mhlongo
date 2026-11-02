// Cloudflare analytics for the Dashboard (lib/cloudflare-analytics.js) driven by a stand-in for Cloudflare's GraphQL API (no network):
// settings, the figures worked out from Cloudflare's daily groups, the previous-period comparison, a refused key, the hourly window - and
// the route answering "not connected" on a server without the settings (test servers never have them, test/support.js).
const cf = require('../lib/cloudflare-analytics');
const { api } = require('./support');

const ZONE = '0123456789abcdef0123456789abcdef';
const ENV = { CLOUDFLARE_API_TOKEN: 'test-token', CLOUDFLARE_ZONE_ID: ZONE };
const day = (date, n) => ({
    dimensions: { date },
    sum: {
        requests: 1000 * n, cachedRequests: 600 * n, bytes: 50e6 * n, cachedBytes: 30e6 * n, threats: 2 * n, pageViews: 100 * n,
        countryMap: [{ clientCountryName: 'ZA', requests: 700 * n, bytes: 35e6 * n, threats: 0 }, { clientCountryName: 'US', requests: 300 * n, bytes: 15e6 * n, threats: 2 * n }],
        responseStatusMap: [{ edgeResponseStatus: 200, requests: 800 * n }, { edgeResponseStatus: 301, requests: 100 * n }, { edgeResponseStatus: 404, requests: 80 * n }, { edgeResponseStatus: 502, requests: 20 * n }],
        contentTypeMap: [{ edgeResponseContentTypeName: 'jpeg', requests: 300 * n, bytes: 30e6 * n }, { edgeResponseContentTypeName: 'html', requests: 200 * n, bytes: 10e6 * n },
            { edgeResponseContentTypeName: 'js', requests: 300 * n, bytes: 8e6 * n }, { edgeResponseContentTypeName: 'json', requests: 200 * n, bytes: 2e6 * n }],
        ipClassMap: [{ ipType: 'clean', requests: 800 * n }, { ipType: 'searchEngine', requests: 150 * n }, { ipType: 'scan', requests: 50 * n }]
    },
    uniq: { uniques: 40 * n }
});

module.exports = async function ({ check }) {
    check('settings: off without them, "half set" with one, on with a token and a 32-hex zone id',
        !cf.config({}).configured && cf.config({ CLOUDFLARE_API_TOKEN: 'x' }).partial && cf.config(ENV).configured && !cf.config({ CLOUDFLARE_API_TOKEN: 'x', CLOUDFLARE_ZONE_ID: 'not-a-zone' }).configured, '');

    const calls = [];
    const fake = async (url, init) => {
        const body = JSON.parse(init.body);
        calls.push({ url, auth: init.headers.Authorization, vars: body.variables, daily: /httpRequests1dGroups/.test(body.query) });
        const prev = body.variables.from === '2026-10-01';
        const groups = prev ? [day('2026-10-01', 1)] : [day('2026-10-08', 1), day('2026-10-09', 2)];
        return { ok: true, status: 200, json: async () => ({ data: { viewer: { zones: [{ httpRequests1dGroups: groups }] } } }) };
    };
    const range = { granularity: 'day', from: '2026-10-08', to: '2026-10-09', prevFrom: '2026-10-01', prevTo: '2026-10-07' };
    const r = await cf.zoneAnalytics(range, { env: ENV, fetchImpl: fake });
    const t = r.totals || {};
    check('asks Cloudflare with the key as a Bearer token, for the zone and the dates of the range (then the previous period)',
        calls.length === 2 && calls[0].auth === 'Bearer test-token' && calls[0].vars.zone === ZONE && calls[0].vars.from === '2026-10-08' && calls[0].vars.to === '2026-10-09' && calls[0].daily && calls[1].vars.from === '2026-10-01', JSON.stringify(calls));
    check('totals over the days: 3 000 requests, 1 800 cached (60% cache hit), 150 MB of which 90 MB served from cache (60% saved), 60 MB from the server',
        t.requests === 3000 && t.cachedRequests === 1800 && t.cacheHitRatio === 60 && t.bytes === 150e6 && t.cachedBytes === 90e6 && t.bandwidthSavedRatio === 60 && t.originBytes === 60e6, JSON.stringify(t));
    check('errors: 240 not found / refused + 60 server errors = 10% error rate; 6 threats', t.errors4xx === 240 && t.errors5xx === 60 && t.errorRate === 10 && t.threats === 6, JSON.stringify(t));
    check('people vs automated: search crawlers + scanners are automated (20% of requests)', t.automatedRequests === 600 && t.automatedShare === 20 &&
        r.traffic.find(x => x.type === 'clean').automated === false && r.traffic.find(x => x.type === 'searchEngine').automated === true, JSON.stringify(r.traffic));
    check('what uses the bandwidth: images first, then pages, scripts, data', r.resources[0].label === 'Images' && r.resources[0].bytes === 90e6 &&
        r.resources.map(x => x.label).join(',') === 'Images,Pages (HTML),Scripts,Data (API)', JSON.stringify(r.resources));
    check('countries by requests (ZA first), status classes, a day-by-day series, and the previous period\'s totals for the comparison',
        r.countries[0].code === 'ZA' && r.countries[0].requests === 2100 && r.statusClasses.length === 4 && r.series.length === 2 && r.series[1].requests === 2000 &&
        r.previous && r.previous.requests === 1000, JSON.stringify([r.countries, r.statusClasses, r.previous]));
    check('content types are grouped into plain categories', cf.resourceCategory('png') === 'Images' && cf.resourceCategory('woff2') === 'Fonts' && cf.resourceCategory('css') === 'Stylesheets' && cf.resourceCategory('') === 'No body (redirects, empty replies)', '');

    const refused = await cf.zoneAnalytics(range, { env: ENV, fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({ errors: [{ message: 'not authorized for that zone' }] }) }) });
    check('a refused key comes back as a readable error (connected, but not working) - never a crash', refused.connected === true && /refused the API key/.test(refused.error), JSON.stringify(refused));
    const noZone = await cf.zoneAnalytics(range, { env: ENV, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ data: { viewer: { zones: [] } } }) }) });
    check('a zone id Cloudflare does not know is reported as such', /CLOUDFLARE_ZONE_ID/.test(noZone.error || ''), JSON.stringify(noZone));

    const v = cf.variablesFor({ granularity: 'hour' }, Date.parse('2026-11-02T10:20:00Z'));
    check('last 24 hours: hourly groups for the 24 whole hours ending with the current one', v.from === '2026-11-01T11:00:00.000Z' && v.to === '2026-11-02T11:00:00.000Z' && cf.buildQuery({ granularity: 'hour' }).hourly, JSON.stringify(v));

    const off = (await api('GET', '/api/admin/insights/cloudflare?range=7d')).body;
    check('the route answers "not connected" on a server without the settings (and test servers never call Cloudflare)', off.success && off.connected === false, JSON.stringify(off));
};
