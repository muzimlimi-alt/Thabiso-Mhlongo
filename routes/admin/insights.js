// The admin Dashboard's tabs (js/admin/dashboard.js): Overview and Finance figures for one date range. Figures come from lib/insights.js,
// which reuses the existing money rules; the range (and its previous equivalent period) from lib/insights-range.js.
// Money is for administrators and managers only (the same line as the rest of the portal): an assistant's Overview shows the website and
// booking counts, and Finance answers 403.
// Answers are kept for a minute per range + role, so switching tabs or pressing Refresh twice does not re-run every query.
const express = require('express');
const { requireAdmin } = require('../../middleware/auth');
const { requireRole } = require('../../middleware/rbac');
const { resolveRange } = require('../../lib/insights-range');
const insights = require('../../lib/insights');
const businessProfile = require('../../lib/business-profile');
const cloudflare = require('../../lib/cloudflare-analytics');
const router = express.Router();

const CACHE_MS = 60 * 1000;
const cache = new Map();
const MONEY_ROLES = ['administrator', 'manager'];

async function rangeFor(req) {
    const profile = await businessProfile.getRow().catch(() => null);
    return resolveRange(req.query, { yearEndMonth: profile && profile.financial_year_end });
}

function cached(key, fn) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.promise;
    const promise = fn();
    cache.set(key, { at: Date.now(), promise });
    promise.catch(() => cache.delete(key));
    if (cache.size > 200) cache.delete(cache.keys().next().value);
    return promise;
}

router.get('/api/admin/insights/overview', requireAdmin, async (req, res) => {
    const range = await rangeFor(req);
    if (range.error) return res.status(400).json({ success: false, error: range.error });
    const seesMoney = MONEY_ROLES.includes(req.session.role);
    try {
        const data = await cached(`overview|${range.from}|${range.to}|${range.prevFrom}`, () => insights.overview(range));
        const business = { ...data.business };
        if (!seesMoney) { delete business.revenue; delete business.payments; delete business.outstanding; }
        res.json({ success: true, range, website: data.website, business, seesMoney });
    } catch (e) {
        console.error('[insights] overview failed:', e.message);
        res.status(500).json({ success: false, error: 'The overview could not be worked out just now.' });
    }
});

router.get('/api/admin/insights/finance', requireAdmin, requireRole(MONEY_ROLES), async (req, res) => {
    const range = await rangeFor(req);
    if (range.error) return res.status(400).json({ success: false, error: range.error });
    try {
        const data = await cached(`finance|${range.from}|${range.to}|${range.prevFrom}|${range.granularity}`, () => insights.finance(range));
        res.json({ success: true, range, ...data });
    } catch (e) {
        console.error('[insights] finance failed:', e.message);
        res.status(500).json({ success: false, error: 'The finance figures could not be worked out just now.' });
    }
});

// Cloudflare's traffic figures (all traffic, no cookies): bandwidth, caching, requests, status codes, countries, people vs automated.
// Not money, so every admin role sees them. { connected: false } until CLOUDFLARE_API_TOKEN + CLOUDFLARE_ZONE_ID are set on the server.
router.get('/api/admin/insights/cloudflare', requireAdmin, async (req, res) => {
    const range = await rangeFor(req);
    if (range.error) return res.status(400).json({ success: false, error: range.error });
    try {
        res.json({ success: true, range, ...(await cloudflare.zoneAnalytics(range)) });
    } catch (e) {
        console.error('[insights] cloudflare failed:', e.message);
        res.status(500).json({ success: false, error: 'The Cloudflare figures could not be loaded just now.' });
    }
});

module.exports = router;
