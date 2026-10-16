// lib/places.js - the shared Google Places service (2026-10 Places audit). Pure unit tests: Google is replaced
// by a fake fetch, so this never touches the network or needs a real key. Covers both Google API generations
// (Places API (New) first, legacy fallback), the normalised location shape, every error code, and that
// neither the key nor the visitor's search text ever reaches a log line.
const { createPlacesService, parseAddressComponents } = require('../lib/places');

const KEY = 'test-server-key-123';
const NEW_SUGGESTIONS = { suggestions: [{ placePrediction: { placeId: 'ChIJnewplace0001', text: { text: 'Sandton Convention Centre, Maude Street, Sandton, South Africa' }, structuredFormat: { mainText: { text: 'Sandton Convention Centre' }, secondaryText: { text: 'Maude Street, Sandton, South Africa' } } } }, { queryPrediction: { text: { text: 'sandton hotels' } } }] };
const NEW_PLACE = {
    id: 'ChIJnewplace0001', displayName: { text: 'Sandton Convention Centre', languageCode: 'en' },
    formattedAddress: '161 Maude St, Sandown, Sandton, 2196, South Africa',
    addressComponents: [
        { longText: 'Sandton', shortText: 'Sandton', types: ['sublocality_level_1', 'sublocality', 'political'] },
        { longText: 'Johannesburg', shortText: 'JHB', types: ['locality', 'political'] },
        { longText: 'Gauteng', shortText: 'GP', types: ['administrative_area_level_1', 'political'] },
        { longText: 'South Africa', shortText: 'ZA', types: ['country', 'political'] },
        { longText: '2196', shortText: '2196', types: ['postal_code'] },
    ],
    location: { latitude: -26.1066, longitude: 28.0567 }, googleMapsUri: 'https://maps.google.com/?cid=1',
};
const LEGACY_PREDICTIONS = { status: 'OK', predictions: [{ place_id: 'ChIJlegacy000001', description: 'Durban ICC, Durban, South Africa', structured_formatting: { main_text: 'Durban ICC', secondary_text: 'Durban, South Africa' } }] };
const LEGACY_DETAILS = { status: 'OK', result: { place_id: 'ChIJlegacy000001', name: 'Durban ICC', formatted_address: '45 Bram Fischer Rd, Durban, 4001, South Africa', address_components: [{ long_name: 'Durban', short_name: 'Durban', types: ['locality'] }, { long_name: 'KwaZulu-Natal', short_name: 'KZN', types: ['administrative_area_level_1'] }, { long_name: 'South Africa', short_name: 'ZA', types: ['country'] }], geometry: { location: { lat: -29.85, lng: 31.03 } }, url: 'https://maps.google.com/?cid=2' } };
const NEW_DISABLED = { error: { code: 403, status: 'PERMISSION_DENIED', message: 'Places API (New) has not been used in project 123 before or it is disabled.', details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'SERVICE_DISABLED' }] } };
const LEGACY_DISABLED = { status: 'REQUEST_DENIED', error_message: "You're calling a legacy API, which is not enabled for your project. To get newer features and more functionality, switch to the Places API (New)." };

function fakeGoogle(handlers) {
    const calls = [];
    const fetch = async (url, init = {}) => {
        calls.push({ url, init });
        const isNew = url.startsWith('https://places.googleapis.com/');
        const kind = (isNew ? 'new' : 'legacy') + (/autocomplete/.test(url) ? 'Auto' : 'Details');
        const h = handlers[kind];
        if (!h) throw new Error('unexpected call ' + kind);
        if (h === 'NETWORK') throw new TypeError('fetch failed');
        const [status, body] = typeof h === 'function' ? h(url, init) : h;
        return { status, ok: status >= 200 && status < 300, json: async () => body };
    };
    return { fetch, calls };
}
function mkLogger() { const lines = []; return { lines, warn: (...a) => lines.push(a.join(' ')), error: (...a) => lines.push(a.join(' ')) }; }
async function codeOf(p) { try { await p; return 'resolved'; } catch (e) { return e.code; } }

module.exports = async function ({ check }) {
    // ---- happy path, Places API (New) ----
    {
        const g = fakeGoogle({ newAuto: [200, NEW_SUGGESTIONS], newDetails: [200, NEW_PLACE] });
        const log = mkLogger();
        const svc = createPlacesService({ fetch: g.fetch, env: { GOOGLE_MAPS_API_KEY: KEY }, logger: log });
        const preds = await svc.autocomplete('  Sandton   Convention ', { sessionToken: 'sess_ABCDEFGH12' });
        check('New API: autocomplete maps placePrediction to {place_id, main_text, secondary_text, formatted_address}', preds.length === 1 && preds[0].place_id === 'ChIJnewplace0001' && preds[0].main_text === 'Sandton Convention Centre' && preds[0].secondary_text === 'Maude Street, Sandton, South Africa' && /Sandton Convention Centre, Maude/.test(preds[0].formatted_address), JSON.stringify(preds));
        const req = g.calls[0];
        const body = JSON.parse(req.init.body);
        check('New API: key goes in the X-Goog-Api-Key header, never the URL', req.init.headers['X-Goog-Api-Key'] === KEY && !req.url.includes(KEY), req.url);
        check('New API: a field mask is sent and the input is whitespace-normalised', !!req.init.headers['X-Goog-FieldMask'] && body.input === 'Sandton Convention', JSON.stringify(body));
        check('New API: the session token is forwarded', body.sessionToken === 'sess_ABCDEFGH12', JSON.stringify(body));
        const d = await svc.details('ChIJnewplace0001', { sessionToken: 'sess_ABCDEFGH12' });
        const L = d.location;
        check('New API: details normalise to the standard location shape', L.placeId === 'ChIJnewplace0001' && L.name === 'Sandton Convention Centre' && L.city === 'Sandton' && L.state === 'Gauteng' && L.country === 'South Africa' && L.countryCode === 'ZA' && L.postalCode === '2196' && L.latitude === -26.1066 && L.longitude === 28.0567 && L.mapUrl === 'https://maps.google.com/?cid=1', JSON.stringify(L));
        check('New API: details also return the legacy "result" shape the public drawer reads', d.result.address_components[0].long_name === 'Sandton' && d.result.geometry.location.lat === -26.1066 && d.result.formatted_address === L.formattedAddress, JSON.stringify(d.result));
        check('New API: session token reaches Place Details too', /sessionToken=sess_ABCDEFGH12/.test(g.calls[1].url), g.calls[1].url);
        check('nothing was logged on success', log.lines.length === 0, log.lines.join('|'));
    }

    // ---- basic detail level (accolades) asks Google for fewer fields ----
    {
        const g = fakeGoogle({ newDetails: [200, NEW_PLACE] });
        const svc = createPlacesService({ fetch: g.fetch, env: { GOOGLE_MAPS_API_KEY: KEY }, logger: mkLogger() });
        await svc.details('ChIJnewplace0001', { basic: true });
        check('basic details request omits location/googleMapsUri from the field mask', !/location|googleMapsUri/.test(g.calls[0].init.headers['X-Goog-FieldMask']), g.calls[0].init.headers['X-Goog-FieldMask']);
    }

    // ---- fallback to legacy when New isn't enabled, and it is remembered ----
    {
        const g = fakeGoogle({ newAuto: [403, NEW_DISABLED], legacyAuto: [200, LEGACY_PREDICTIONS], legacyDetails: [200, LEGACY_DETAILS] });
        const log = mkLogger();
        const svc = createPlacesService({ fetch: g.fetch, env: { GOOGLE_MAPS_API_KEY: KEY }, logger: log });
        const preds = await svc.autocomplete('Durban ICC');
        check('auto mode: "Places API (New) not enabled" falls back to the legacy API', preds.length === 1 && preds[0].place_id === 'ChIJlegacy000001' && preds[0].main_text === 'Durban ICC', JSON.stringify(preds));
        check('...and logs a warning that legacy is in use', log.lines.some(l => /LEGACY Places API/.test(l)), log.lines.join('|'));
        const before = g.calls.length;
        await svc.autocomplete('Durban beach');
        check('...the next search goes straight to legacy (one call, no failed New attempt)', g.calls.length === before + 1 && /maps\.googleapis\.com/.test(g.calls[before].url), g.calls.slice(before).map(c => c.url).join(' '));
        const d = await svc.details('ChIJlegacy000001');
        check('legacy details normalise to the same shape', d.location.city === 'Durban' && d.location.state === 'KwaZulu-Natal' && d.location.latitude === -29.85 && d.location.mapUrl === 'https://maps.google.com/?cid=2', JSON.stringify(d.location));
        check('the server key never appears in any log line', !log.lines.some(l => l.includes(KEY)), log.lines.join('|'));
        check('the search text never appears in any log line', !log.lines.some(l => /Durban/i.test(l)), log.lines.join('|'));
    }

    // ---- both refuse for enablement: report the New-API fix (the likely live failure) ----
    {
        const g = fakeGoogle({ newAuto: [403, NEW_DISABLED], legacyAuto: [200, LEGACY_DISABLED] });
        const log = mkLogger();
        const svc = createPlacesService({ fetch: g.fetch, env: { GOOGLE_MAPS_API_KEY: KEY }, logger: log });
        let err = null; try { await svc.autocomplete('Sandton'); } catch (e) { err = e; }
        check('neither API enabled -> API_NOT_ENABLED (503) with the "enable Places API (New)" hint', err && err.code === 'API_NOT_ENABLED' && err.status === 503 && /Places API \(New\)/.test(err.message), err && (err.code + ' ' + err.message));
        check('...the failure is logged once with Google\'s own message', log.lines.length === 1 && /API_NOT_ENABLED/.test(log.lines[0]) && /has not been used/.test(log.lines[0]), log.lines.join('|'));
        try { await svc.autocomplete('Sandton again'); } catch (_) {}
        check('...and not re-logged on every keystroke', log.lines.length === 1, String(log.lines.length));
    }

    // ---- the exact legacy-only failure mode the old proxy hid: legacy REQUEST_DENIED, PLACES_API_MODE=legacy ----
    {
        const g = fakeGoogle({ legacyAuto: [200, LEGACY_DISABLED] });
        const svc = createPlacesService({ fetch: g.fetch, env: { GOOGLE_MAPS_API_KEY: KEY, PLACES_API_MODE: 'legacy' }, logger: mkLogger() });
        check('legacy "You\'re calling a legacy API, which is not enabled" -> API_NOT_ENABLED (was silently [] before)', await codeOf(svc.autocomplete('Sandton')) === 'API_NOT_ENABLED', '');
        check('PLACES_API_MODE=legacy never calls the New API', g.calls.every(c => !/places\.googleapis/.test(c.url)), '');
    }

    // ---- error classification ----
    const cases = [
        ['no key', { env: {} }, {}, 'NO_KEY'],
        ['invalid key', {}, { newAuto: [400, { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'API key not valid. Please pass a valid API key.', details: [{ reason: 'API_KEY_INVALID' }] } }] }, 'KEY_INVALID'],
        ['referrer-restricted key used server-side', {}, { newAuto: [403, { error: { code: 403, status: 'PERMISSION_DENIED', message: 'Requests from referer <empty> are blocked.', details: [{ reason: 'API_KEY_HTTP_REFERRER_BLOCKED' }] } }] }, 'KEY_RESTRICTED'],
        ['billing disabled', {}, { newAuto: [403, { error: { code: 403, status: 'PERMISSION_DENIED', message: 'This API method requires billing to be enabled.', details: [{ reason: 'BILLING_DISABLED' }] } }] }, 'BILLING'],
        ['quota', {}, { newAuto: [429, { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded' } }] }, 'QUOTA'],
        ['network down', {}, { newAuto: 'NETWORK' }, 'NETWORK'],
        ['Google 500', {}, { newAuto: [500, { error: { code: 500, status: 'INTERNAL', message: 'boom' } }] }, 'UPSTREAM'],
        ['non-JSON answer', {}, { newAuto: [502, null] }, 'UPSTREAM'],
    ];
    for (const [name, o, handlers, want] of cases) {
        const g = fakeGoogle(handlers);
        const svc = createPlacesService({ fetch: g.fetch, env: o.env || { GOOGLE_MAPS_API_KEY: KEY }, logger: mkLogger() });
        const got = await codeOf(svc.autocomplete('Sandton'));
        check(`error: ${name} -> ${want}`, got === want, 'got ' + got);
    }
    {
        // key restricted to legacy-only APIs: New refuses with API_KEY_SERVICE_BLOCKED, legacy works -> fallback
        const g = fakeGoogle({ newAuto: [403, { error: { code: 403, status: 'PERMISSION_DENIED', message: 'Requests to this API places.googleapis.com method google.maps.places.v1.Places.AutocompletePlaces are blocked.', details: [{ reason: 'API_KEY_SERVICE_BLOCKED' }] } }], legacyAuto: [200, LEGACY_PREDICTIONS] });
        const svc = createPlacesService({ fetch: g.fetch, env: { GOOGLE_MAPS_API_KEY: KEY }, logger: mkLogger() });
        const preds = await svc.autocomplete('Durban');
        check('key whose API list allows only the legacy API still works (falls back)', preds.length === 1, JSON.stringify(preds));
    }

    // ---- input validation / edge cases ----
    {
        const g = fakeGoogle({ newAuto: [200, { }], newDetails: [404, { error: { code: 404, status: 'NOT_FOUND', message: 'not found' } }] });
        const svc = createPlacesService({ fetch: g.fetch, env: { GOOGLE_MAPS_API_KEY: KEY }, logger: mkLogger() });
        check('1-character input returns [] without calling Google', (await svc.autocomplete('a')).length === 0 && g.calls.length === 0, String(g.calls.length));
        check('Google answering with no suggestions -> [] (not an error)', (await svc.autocomplete('zzzzqqqq')).length === 0, '');
        check('malformed place id is rejected before calling Google', await codeOf(svc.details('bad id&key=x')) === 'INVALID_INPUT' && g.calls.length === 1, String(g.calls.length));
        check('unknown place -> NOT_FOUND', await codeOf(svc.details('ChIJdoesnotexist0')) === 'NOT_FOUND', '');
        const long = 'x'.repeat(500);
        await svc.autocomplete(long);
        check('very long input is truncated to 200 characters', JSON.parse(g.calls[g.calls.length - 1].init.body).input.length === 200, '');
        await svc.autocomplete('Sandton', { sessionToken: 'bad token!' });
        check('a malformed session token is dropped, not forwarded', !('sessionToken' in JSON.parse(g.calls[g.calls.length - 1].init.body)), '');
    }

    // ---- missing optional address parts ----
    {
        const p = parseAddressComponents([{ longText: 'Gauteng', types: ['administrative_area_level_1'] }]);
        check('place with no city/postcode/country -> empty strings, never undefined', p.city === '' && p.postalCode === '' && p.country === '' && p.state === 'Gauteng', JSON.stringify(p));
        const p2 = parseAddressComponents([{ long_name: 'City of Tshwane', types: ['administrative_area_level_2'] }]);
        check('city falls back to administrative_area_level_2 (same rule as js/shared/location-utils.js)', p2.city === 'City of Tshwane', JSON.stringify(p2));
        const g = fakeGoogle({ newDetails: [200, { id: 'ChIJbare00000001', displayName: { text: 'Bare' } }] });
        const svc = createPlacesService({ fetch: g.fetch, env: { GOOGLE_MAPS_API_KEY: KEY }, logger: mkLogger() });
        const d = await svc.details('ChIJbare00000001');
        check('a place with no address/location still normalises (nulls for coordinates)', d.location.name === 'Bare' && d.location.latitude === null && d.location.formattedAddress === '' && d.result.geometry === undefined, JSON.stringify(d));
    }

    // ---- diagnose (admin "Test Google Places" button) ----
    {
        const g = fakeGoogle({ newAuto: [403, NEW_DISABLED], legacyAuto: [200, LEGACY_DISABLED] });
        const svc = createPlacesService({ fetch: g.fetch, env: { GOOGLE_MAPS_API_KEY: KEY }, logger: mkLogger() });
        const r = await svc.diagnose();
        check('diagnose reports the failure code + hint + Google detail, and never the key', r.ok === false && r.code === 'API_NOT_ENABLED' && /Places API \(New\)/.test(r.hint) && !JSON.stringify(r).includes(KEY), JSON.stringify(r));
        const ok = createPlacesService({ fetch: fakeGoogle({ newAuto: [200, NEW_SUGGESTIONS] }).fetch, env: { GOOGLE_MAPS_API_KEY: KEY }, logger: mkLogger() });
        const r2 = await ok.diagnose();
        check('diagnose on a working key reports ok via the New API', r2.ok === true && r2.provider === 'new' && r2.sample === 1, JSON.stringify(r2));
        const none = await createPlacesService({ env: {}, logger: mkLogger() }).diagnose();
        check('diagnose with no key says NO_KEY without calling Google', none.ok === false && none.code === 'NO_KEY' && none.configured === false, JSON.stringify(none));
    }
};

// Allow running stand-alone: `node test/places-service.test.js`
if (require.main === module) {
    let failed = 0, total = 0;
    module.exports({ check: (n, pass, d) => { total++; if (!pass) failed++; console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${n}${pass ? '' : `\n          -> ${d}`}`); } })
        .then(() => { console.log(`${total - failed}/${total} passed`); process.exit(failed ? 1 : 0); })
        .catch(e => { console.error(e); process.exit(2); });
}
