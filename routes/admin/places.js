// Admin venue / location search (2026-10 Places audit). Every admin surface that searches Google for a place -
// Manual Booking (#mbLocation), Deal View "Link a venue", the Events venue search and the Accolades location -
// calls these through js/admin/places-autocomplete.js. They share lib/places.js with the public booking drawer,
// so there is one Google key (GOOGLE_MAPS_API_KEY, server-side only), one API version policy and one set of
// error codes. This replaced the browser-side google.maps.places.Autocomplete widget and its separate browser
// key (GOOGLE_MAPS_BROWSER_KEY, GET /api/admin/maps-config) - see lib/places.js for why.
const express = require('express');
const { requireAdmin } = require('../../middleware/auth');
const { requireRole } = require('../../middleware/rbac');
const places = require('../../lib/places');
const { sendPlacesError } = places;
const router = express.Router();

router.get('/api/admin/places/autocomplete', requireAdmin, async (req, res) => {
    try {
        const predictions = await places.autocomplete(req.query.input, { sessionToken: req.query.sessionToken });
        res.json({ success: true, predictions });
    } catch (e) {
        sendPlacesError(res, e, { predictions: [] });
    }
});

// detail=basic asks Google for name + address only (the Accolades location needs no coordinates), which is
// billed at a lower tier than the full set.
router.get('/api/admin/places/details', requireAdmin, async (req, res) => {
    if (!req.query.place_id) return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: 'place_id required' } });
    try {
        const d = await places.details(req.query.place_id, { sessionToken: req.query.sessionToken, basic: req.query.detail === 'basic' });
        res.json({ success: true, location: d.location });
    } catch (e) {
        sendPlacesError(res, e);
    }
});

// "Test Google Places" (System Settings): runs one real search and reports what Google answered - the
// configuration problem in plain words, never the key. Administrator-only, since it spends a Google request.
router.get('/api/admin/places/status', requireAdmin, requireRole(['administrator']), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
        res.json(Object.assign({ success: true }, await places.diagnose()));
    } catch (e) {
        console.error('[places] diagnose failed:', e);
        res.status(500).json({ success: false, message: 'Could not run the Google Places check.' });
    }
});

module.exports = router;
