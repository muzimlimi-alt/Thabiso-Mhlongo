// Shared server-side Google Places service (2026-10 Places audit).
//
// The ONE place this project talks to Google Places. Every venue / location search on the site goes through
// it: the public booking drawer (routes/public/availability.js -> /api/public/places/*) and every admin
// surface (routes/admin/places.js -> /api/admin/places/*: Manual Booking, Deal View "Link a venue", Events
// venue search, Accolades location). Before this file, the public proxy called Google inline and the admin
// loaded Google's browser widget with a second key, so the two halves failed differently and silently.
//
// Why a server proxy for the admin too: it needs no browser key, no Maps JavaScript download, and no
// "is google loaded yet?" timing - a drawer can attach search the moment it opens.
//
// API version: Places API (New) - places.googleapis.com/v1 - is tried first. Google froze the legacy
// Places API on 1 March 2025: "Legacy services are not available in new Cloud projects" (a key from a
// project created after that date gets REQUEST_DENIED). Older projects may still have ONLY the legacy API
// enabled, so when Google says the New API isn't enabled for this key, the service falls back to the legacy
// endpoints automatically and remembers which one works. PLACES_API_MODE=new|legacy pins one.
//
// Every result is normalised to one shape (see toLocation) and every failure to one small set of codes
// (ERROR_CODES), so callers never parse Google's two different response formats or error styles.
// Nothing here logs the API key or what a visitor typed.
'use strict';

const NEW_BASE = 'https://places.googleapis.com/v1';
const LEGACY_BASE = 'https://maps.googleapis.com/maps/api/place';
const TIMEOUT_MS = 6000;
const PROVIDER_MEMORY_MS = 10 * 60 * 1000;     // re-probe the New API every 10 min after falling back
const LOG_REPEAT_MS = 5 * 60 * 1000;           // the same failure code is logged at most once per 5 min

// code -> [HTTP status our API answers with, safe message for the UI, hint for the admin/server log]
const ERROR_CODES = {
    NO_KEY:          [503, 'Location search is not configured.', 'GOOGLE_MAPS_API_KEY is not set in the server environment (.env).'],
    KEY_INVALID:     [503, 'Location search is unavailable right now.', 'Google rejected GOOGLE_MAPS_API_KEY as invalid. Check the key value in .env.'],
    KEY_RESTRICTED:  [503, 'Location search is unavailable right now.', 'GOOGLE_MAPS_API_KEY\'s application restriction blocks this server. Server requests carry no referrer, so the key must not use "Websites" restrictions; use "IP addresses" listing this server\'s outbound IPs (or "None"), and limit the key to Places API (New). Google\'s message below names what was blocked.'],
    // Google's bare 403 "The caller does not have permission" (no ErrorInfo reason). Google names referrer, IP,
    // API-list and billing blocks explicitly, so a bare one is a project/key-level refusal, not a restriction.
    ACCESS_DENIED:   [503, 'Location search is unavailable right now.', 'Google refused GOOGLE_MAPS_API_KEY without giving a reason. The key is valid and Places API (New) answered, so check the key\'s Google Cloud project: billing must be linked and active, and the key must be a plain API key - not one created with "Authenticate API calls through a service account".'],
    KEY_API_BLOCKED: [503, 'Location search is unavailable right now.', 'GOOGLE_MAPS_API_KEY has API restrictions that do not include Places API (New). In Google Cloud Console > Credentials, add "Places API (New)" to the key\'s allowed APIs.'],
    API_NOT_ENABLED: [503, 'Location search is unavailable right now.', 'Places API (New) is not enabled for the key\'s Google Cloud project. Enable "Places API (New)" in Google Cloud Console > APIs & Services.'],
    BILLING:         [503, 'Location search is unavailable right now.', 'Google refused the request for billing reasons. Check that billing is enabled on the Google Cloud project.'],
    QUOTA:           [429, 'Too many location searches just now. Please try again shortly or enter the address manually.', 'Google Places quota exceeded (or per-minute limit hit).'],
    NETWORK:         [503, 'Location search is unavailable right now.', 'Could not reach Google Places (network error or timeout).'],
    UPSTREAM:        [502, 'Location search is unavailable right now.', 'Google Places returned an unexpected error.'],
    INVALID_INPUT:   [400, 'That search could not be run.', 'Invalid search input or place id.'],
    NOT_FOUND:       [404, 'That place could not be found.', 'Google has no place with that id.'],
};

const FALLBACK_CODES = ['API_NOT_ENABLED', 'KEY_API_BLOCKED'];
const PLACE_ID_RE = /^[A-Za-z0-9_-]{10,400}$/;
const SESSION_RE = /^[A-Za-z0-9_-]{8,100}$/;
const MAX_INPUT = 200;

class PlacesError extends Error {
    constructor(code, detail) {
        super(ERROR_CODES[code] ? ERROR_CODES[code][2] : code);
        this.code = ERROR_CODES[code] ? code : 'UPSTREAM';
        this.detail = detail ? String(detail).slice(0, 300) : '';
        this.status = ERROR_CODES[this.code][0];
        this.userMessage = ERROR_CODES[this.code][1];
    }
}

// --- address parsing (the server twin of js/shared/location-utils.js parseAddressComponents) --------------
// Accepts both component shapes: legacy { long_name, short_name, types } and New { longText, shortText, types }.
function parseAddressComponents(components) {
    const out = { city: '', state: '', postalCode: '', country: '', countryCode: '' };
    (components || []).forEach(c => {
        const types = c.types || [];
        const long = c.long_name != null ? c.long_name : (c.longText || '');
        const short = c.short_name != null ? c.short_name : (c.shortText || '');
        if (!out.city && (types.includes('locality') || types.includes('sublocality_level_1') || types.includes('sublocality'))) out.city = long;
        else if (!out.city && types.includes('administrative_area_level_2')) out.city = long;
        if (!out.state && types.includes('administrative_area_level_1')) out.state = long;
        if (!out.postalCode && types.includes('postal_code')) out.postalCode = long;
        if (!out.country && types.includes('country')) { out.country = long; out.countryCode = short; }
    });
    return out;
}

// The one location shape every caller gets back (matches js/shared/places-client.js and the hidden fields
// the booking / event forms already post). Any field Google didn't return is '' or null - never invented.
function toLocation({ placeId, name, formattedAddress, components, lat, lng, mapUrl }) {
    const a = parseAddressComponents(components);
    const num = v => (typeof v === 'number' && isFinite(v) ? v : null);
    return {
        placeId: placeId || '',
        name: name || '',
        formattedAddress: formattedAddress || '',
        city: a.city, state: a.state, postalCode: a.postalCode, country: a.country, countryCode: a.countryCode,
        latitude: num(lat), longitude: num(lng),
        mapUrl: mapUrl || (placeId ? 'https://www.google.com/maps/place/?q=place_id:' + encodeURIComponent(placeId) : null),
    };
}

// The legacy REST "result" shape the public booking drawer (js/myscript.js venueChoose) already reads, so that
// tested front-end code keeps working unchanged whichever Google API answered.
function toLegacyResult(loc, components) {
    return {
        place_id: loc.placeId,
        name: loc.name,
        formatted_address: loc.formattedAddress,
        address_components: (components || []).map(c => ({
            long_name: c.long_name != null ? c.long_name : (c.longText || ''),
            short_name: c.short_name != null ? c.short_name : (c.shortText || ''),
            types: c.types || [],
        })),
        geometry: loc.latitude != null ? { location: { lat: loc.latitude, lng: loc.longitude } } : undefined,
        url: loc.mapUrl,
    };
}

// --- error classification -----------------------------------------------------------------------------------
function classifyNewError(httpStatus, body) {
    const err = (body && body.error) || {};
    const status = err.status || '';
    const msg = (err.message || '').toLowerCase();
    const reasons = (err.details || []).map(d => d && d.reason).filter(Boolean);
    const has = r => reasons.includes(r);
    if (has('SERVICE_DISABLED') || /has not been used in project|is disabled|not been enabled|api not enabled/.test(msg)) return 'API_NOT_ENABLED';
    if (has('API_KEY_INVALID') || /api key not valid|api_key_invalid/.test(msg)) return 'KEY_INVALID';
    if (has('API_KEY_SERVICE_BLOCKED') || /requests to this api .* are blocked/.test(msg)) return 'KEY_API_BLOCKED';
    if (has('API_KEY_HTTP_REFERRER_BLOCKED') || has('API_KEY_IP_ADDRESS_BLOCKED') || has('API_KEY_ANDROID_APP_BLOCKED') || has('API_KEY_IOS_APP_BLOCKED') || /referer|referrer|are blocked|ip address/.test(msg)) return 'KEY_RESTRICTED';
    if (has('BILLING_DISABLED') || /billing/.test(msg)) return 'BILLING';
    if (httpStatus === 429 || status === 'RESOURCE_EXHAUSTED' || has('RATE_LIMIT_EXCEEDED')) return 'QUOTA';
    if (httpStatus === 404 || status === 'NOT_FOUND') return 'NOT_FOUND';
    if (httpStatus === 400 || status === 'INVALID_ARGUMENT') return 'INVALID_INPUT';
    if (httpStatus === 403 || status === 'PERMISSION_DENIED') return 'ACCESS_DENIED';
    return 'UPSTREAM';
}

function classifyLegacyError(body) {
    const status = (body && body.status) || '';
    const msg = ((body && body.error_message) || '').toLowerCase();
    if (status === 'OVER_QUERY_LIMIT') return /billing/.test(msg) ? 'BILLING' : 'QUOTA';
    if (status === 'INVALID_REQUEST') return 'INVALID_INPUT';
    if (status === 'NOT_FOUND') return 'NOT_FOUND';
    if (status === 'REQUEST_DENIED') {
        if (/legacy api|not enabled|not activated|not authorized to use this api/.test(msg)) return 'API_NOT_ENABLED';
        if (/invalid/.test(msg)) return 'KEY_INVALID';
        if (/billing/.test(msg)) return 'BILLING';
        if (/referer|referrer|ip address|restrict/.test(msg)) return 'KEY_RESTRICTED';
        return 'KEY_RESTRICTED';
    }
    return 'UPSTREAM';
}

function createPlacesService(deps = {}) {
    const doFetch = deps.fetch || ((...a) => fetch(...a));
    const env = deps.env || process.env;
    const log = deps.logger || console;
    const now = deps.now || Date.now;

    let preferred = null;          // 'new' | 'legacy' - which API last answered for this key
    let preferredAt = 0;
    const lastLogged = new Map();  // code -> timestamp
    let lastStatus = null;         // { ok, code, provider, at } - the most recent outcome, for the admin diagnostic

    const key = () => String(env.GOOGLE_MAPS_API_KEY || '').trim();
    const mode = () => { const m = String(env.PLACES_API_MODE || 'auto').toLowerCase(); return m === 'new' || m === 'legacy' ? m : 'auto'; };

    function logFailure(e, provider) {
        const t = now();
        const prev = lastLogged.get(e.code) || 0;
        if (t - prev < LOG_REPEAT_MS) return;
        lastLogged.set(e.code, t);
        // Google's own message helps diagnose (it never contains the key); the visitor's search text is not logged.
        log.warn(`[places] ${e.code} via ${provider || 'n/a'}: ${ERROR_CODES[e.code][2]}${e.detail ? ' (Google: ' + e.detail + ')' : ''}`);
    }

    async function request(url, init) {
        const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
        const timer = ctrl ? setTimeout(() => ctrl.abort(), TIMEOUT_MS) : null;
        try {
            const r = await doFetch(url, Object.assign({}, init, ctrl ? { signal: ctrl.signal } : {}));
            let body = null;
            try { body = await r.json(); } catch (_) { body = null; }
            return { status: r.status, ok: r.ok, body };
        } catch (e) {
            throw new PlacesError('NETWORK', e && e.name === 'AbortError' ? 'timeout' : (e && e.message));
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    // ---- Places API (New) ----
    async function newAutocomplete(input, opts) {
        const body = { input, languageCode: opts.languageCode || 'en' };
        if (opts.sessionToken) body.sessionToken = opts.sessionToken;
        if (opts.regionCodes && opts.regionCodes.length) body.includedRegionCodes = opts.regionCodes.slice(0, 15);
        const r = await request(`${NEW_BASE}/places:autocomplete`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Goog-Api-Key': key(),
                'X-Goog-FieldMask': 'suggestions.placePrediction.placeId,suggestions.placePrediction.text.text,suggestions.placePrediction.structuredFormat',
            },
            body: JSON.stringify(body),
        });
        if (!r.ok) throw new PlacesError(classifyNewError(r.status, r.body), r.body && r.body.error && r.body.error.message);
        return ((r.body && r.body.suggestions) || [])
            .map(s => s && s.placePrediction)
            .filter(p => p && p.placeId)
            .map(p => {
                const sf = p.structuredFormat || {};
                const full = (p.text && p.text.text) || '';
                return {
                    place_id: p.placeId,
                    main_text: (sf.mainText && sf.mainText.text) || full,
                    secondary_text: (sf.secondaryText && sf.secondaryText.text) || '',
                    formatted_address: full,
                };
            });
    }

    async function newDetails(placeId, opts) {
        const mask = opts.basic
            ? 'id,displayName,formattedAddress,addressComponents'
            : 'id,displayName,formattedAddress,addressComponents,location,googleMapsUri';
        const qs = new URLSearchParams({ languageCode: opts.languageCode || 'en' });
        if (opts.sessionToken) qs.set('sessionToken', opts.sessionToken);
        const r = await request(`${NEW_BASE}/places/${encodeURIComponent(placeId)}?${qs}`, {
            method: 'GET',
            headers: { 'X-Goog-Api-Key': key(), 'X-Goog-FieldMask': mask },
        });
        if (!r.ok) throw new PlacesError(classifyNewError(r.status, r.body), r.body && r.body.error && r.body.error.message);
        const p = r.body || {};
        const components = p.addressComponents || [];
        const loc = toLocation({
            placeId: p.id || placeId,
            name: p.displayName && p.displayName.text,
            formattedAddress: p.formattedAddress,
            components,
            lat: p.location && p.location.latitude,
            lng: p.location && p.location.longitude,
            mapUrl: p.googleMapsUri,
        });
        return { location: loc, result: toLegacyResult(loc, components) };
    }

    // ---- legacy Places API (fallback) ----
    async function legacyAutocomplete(input, opts) {
        const qs = new URLSearchParams({ input, key: key(), language: opts.languageCode || 'en' });
        if (opts.sessionToken) qs.set('sessiontoken', opts.sessionToken);
        if (opts.regionCodes && opts.regionCodes.length) qs.set('components', opts.regionCodes.slice(0, 5).map(c => 'country:' + c).join('|'));
        const r = await request(`${LEGACY_BASE}/autocomplete/json?${qs}`, { method: 'GET' });
        const b = r.body || {};
        if (b.status === 'ZERO_RESULTS') return [];
        if (b.status !== 'OK') throw new PlacesError(r.body ? classifyLegacyError(b) : 'UPSTREAM', b.error_message || b.status);
        return (b.predictions || []).map(p => ({
            place_id: p.place_id,
            main_text: p.structured_formatting ? p.structured_formatting.main_text : p.description,
            secondary_text: p.structured_formatting ? (p.structured_formatting.secondary_text || '') : '',
            formatted_address: p.description,
        }));
    }

    async function legacyDetails(placeId, opts) {
        const fields = opts.basic ? 'place_id,name,formatted_address,address_components' : 'place_id,name,formatted_address,address_components,geometry/location,url';
        const qs = new URLSearchParams({ place_id: placeId, fields, key: key(), language: opts.languageCode || 'en' });
        if (opts.sessionToken) qs.set('sessiontoken', opts.sessionToken);
        const r = await request(`${LEGACY_BASE}/details/json?${qs}`, { method: 'GET' });
        const b = r.body || {};
        if (b.status !== 'OK' || !b.result) throw new PlacesError(r.body ? classifyLegacyError(b) : 'UPSTREAM', b.error_message || b.status);
        const p = b.result;
        const g = p.geometry && p.geometry.location;
        const loc = toLocation({
            placeId: p.place_id || placeId, name: p.name, formattedAddress: p.formatted_address,
            components: p.address_components, lat: g && g.lat, lng: g && g.lng, mapUrl: p.url,
        });
        return { location: loc, result: toLegacyResult(loc, p.address_components) };
    }

    // Runs `op` against the preferred API; in auto mode, a "New API not enabled" answer falls back to legacy
    // (and vice versa), remembering whichever worked so the next request goes straight there.
    async function run(op) {
        if (!key()) { const e = new PlacesError('NO_KEY'); logFailure(e, null); lastStatus = { ok: false, code: e.code, provider: null, at: now() }; throw e; }
        const m = mode();
        let order;
        if (m !== 'auto') order = [m];
        else if (preferred && now() - preferredAt < PROVIDER_MEMORY_MS) order = preferred === 'new' ? ['new', 'legacy'] : ['legacy', 'new'];
        else order = ['new', 'legacy'];

        let firstErr = null;
        for (let i = 0; i < order.length; i++) {
            const provider = order[i];
            try {
                const value = await op[provider]();
                if (preferred !== provider) { preferred = provider; preferredAt = now(); if (provider === 'legacy') log.warn('[places] using the LEGACY Places API: Places API (New) is not enabled for this key. Enable "Places API (New)" in Google Cloud Console; legacy has no shutdown date yet but is frozen.'); }
                else preferredAt = now();
                lastStatus = { ok: true, code: null, provider, at: now() };
                return value;
            } catch (e) {
                const err = e instanceof PlacesError ? e : new PlacesError('UPSTREAM', e && e.message);
                if (!firstErr) firstErr = err;
                // Only "this API isn't enabled / allowed for the key" is worth retrying on the other API - every other
                // failure (bad key, quota, network, not found) would fail the same way there.
                if (!FALLBACK_CODES.includes(err.code) || i === order.length - 1) {
                    // Report the most useful error: when BOTH APIs refused for enablement reasons, the actionable fix is
                    // the one for Places API (New) - the first one tried in auto mode.
                    const report = (FALLBACK_CODES.includes(firstErr.code) && FALLBACK_CODES.includes(err.code) && order[0] === 'new') ? firstErr : err;
                    if (!['NOT_FOUND', 'INVALID_INPUT'].includes(report.code)) logFailure(report, provider);
                    lastStatus = { ok: false, code: report.code, provider, at: now() };
                    throw report;
                }
            }
        }
        throw firstErr;
    }

    async function autocomplete(rawInput, opts = {}) {
        const input = String(rawInput || '').replace(/\s+/g, ' ').trim().slice(0, MAX_INPUT);
        if (input.length < 2) return [];
        const o = sanitizeOpts(opts);
        const preds = await run({ new: () => newAutocomplete(input, o), legacy: () => legacyAutocomplete(input, o) });
        return preds.slice(0, 6);
    }

    async function details(rawPlaceId, opts = {}) {
        const placeId = String(rawPlaceId || '').trim();
        if (!PLACE_ID_RE.test(placeId)) throw new PlacesError('INVALID_INPUT', 'bad place id');
        const o = sanitizeOpts(opts);
        return run({ new: () => newDetails(placeId, o), legacy: () => legacyDetails(placeId, o) });
    }

    function sanitizeOpts(opts) {
        const o = {};
        if (opts.sessionToken && SESSION_RE.test(String(opts.sessionToken))) o.sessionToken = String(opts.sessionToken);
        if (opts.basic) o.basic = true;
        const region = String(env.PLACES_REGION_CODES || '').toLowerCase().split(',').map(s => s.trim()).filter(s => /^[a-z]{2}$/.test(s));
        if (region.length) o.regionCodes = region;
        return o;
    }

    // Admin diagnostic: runs one real search and reports exactly what Google said (never the key).
    async function diagnose() {
        const configured = !!key();
        const result = { configured, mode: mode(), provider: null, ok: false, code: null, hint: null, detail: null, sample: 0 };
        if (!configured) { result.code = 'NO_KEY'; result.hint = ERROR_CODES.NO_KEY[2]; return result; }
        try {
            preferred = null;                                   // probe from scratch: New first
            const preds = await autocomplete('Johannesburg');
            result.ok = true; result.provider = preferred; result.sample = preds.length;
            if (preferred === 'legacy') result.hint = 'Working through the LEGACY Places API. Enable "Places API (New)" for this key so it keeps working when Google retires legacy.';
        } catch (e) {
            result.code = e.code; result.hint = ERROR_CODES[e.code] ? ERROR_CODES[e.code][2] : null; result.detail = e.detail || null;
        }
        return result;
    }

    return { autocomplete, details, diagnose, lastStatus: () => lastStatus, _reset: () => { preferred = null; lastLogged.clear(); } };
}

// Turns a PlacesError (or anything else) into an HTTP answer. `extra` is merged into the body so each route
// keeps its existing response shape (e.g. the public autocomplete always carries `predictions`).
function sendPlacesError(res, e, extra = {}) {
    const err = e instanceof PlacesError ? e : new PlacesError('UPSTREAM', e && e.message);
    if (!(e instanceof PlacesError)) console.error('[places] unexpected error:', e);
    res.status(err.status).json(Object.assign({}, extra, { success: false, error: { code: err.code, message: err.userMessage } }));
}

const defaultService = createPlacesService();

module.exports = {
    createPlacesService,
    autocomplete: (...a) => defaultService.autocomplete(...a),
    details: (...a) => defaultService.details(...a),
    diagnose: () => defaultService.diagnose(),
    lastStatus: () => defaultService.lastStatus(),
    sendPlacesError,
    parseAddressComponents,
    PlacesError,
    ERROR_CODES,
};
