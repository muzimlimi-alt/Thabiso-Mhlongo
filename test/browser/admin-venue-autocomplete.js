// Admin location-search consolidation (2026-09-29 audit)
// Browser test for admin.html's Google Places wiring — the first admin-portal browser test in this
// project (test/browser/* so far only covers the public site). Real `google.maps.places.Autocomplete`
// can't be driven deterministically in CI (it talks to Google's own servers and renders a UI outside
// our page's control) — so /api/admin/maps-config is intercepted to return no key (the real Maps
// script never loads; this is the same "key not configured: quiet degradation" path
// test/maps-key.test.js already covers) and window.google.maps.places.Autocomplete is replaced with a
// fake BEFORE any page script runs, exactly the way this project mocks every other external boundary.
// This proves OUR code — AdminPlacesAutocomplete + TMLocation + each drawer's onPlace callback —
// wires a selected place into the right hidden fields; it is not a test of Google's own widget.
// Not part of `npm test`: run it with `npm run test:browser`.
const path = require('path');
const support = require('../support');
const puppeteer = require('puppeteer');
const { BASE, sleep } = support;
let fails = 0;
const ok = (c, n, detail) => { if (!c) fails++; console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '\n        -> ' + detail)); };

// A Google Place fixture with every field type this project's shared parser reads, in the JS SDK's
// own shape (address_components identical to the REST API's; geometry.location.lat()/lng() as
// FUNCTIONS — the one thing that differs from the public site's server-proxied REST response).
// Plain-data only (no functions) — this crosses the Puppeteer <-> browser boundary as a JSON
// argument to page.evaluateOnNewDocument(), which silently drops any function property instead of
// preserving it. The lat()/lng() methods the JS SDK's real LatLng exposes are reconstructed from
// latitude/longitude INSIDE the injected script itself, never passed in as part of this object.
const FAKE_PLACE_DATA = {
    place_id: 'fake-place-id-123',
    name: 'Fake Venue Hall',
    formatted_address: '1 Fake Street, Cape Town, Western Cape, 8001, South Africa',
    address_components: [
        { long_name: '1', short_name: '1', types: ['street_number'] },
        { long_name: 'Fake Street', short_name: 'Fake St', types: ['route'] },
        { long_name: 'Cape Town', short_name: 'Cape Town', types: ['locality'] },
        { long_name: 'Western Cape', short_name: 'WC', types: ['administrative_area_level_1'] },
        { long_name: '8001', short_name: '8001', types: ['postal_code'] },
        { long_name: 'South Africa', short_name: 'ZA', types: ['country'] }
    ],
    latitude: -33.9249, longitude: 18.4241,
    url: 'https://maps.google.com/?cid=999888777'
};

async function openAdmin(browser) {
    const lr = await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'test.runner@example.invalid', password: 'TestRunnerPass1!' }) });
    const [ckN, ...ckR] = lr.headers.get('set-cookie').split(';')[0].split('=');
    const ctx = await browser.createBrowserContext();
    const p = await ctx.newPage();
    p._errs = [];
    p.on('pageerror', e => p._errs.push(e.message.slice(0, 200)));
    // Pre-existing, unrelated to this change: a malformed data: URI font in admin's own CSS fails to
    // decode (same noise on every admin.html load, nothing to do with location search).
    p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text()) && !/Loading the font/.test(m.text())) p._errs.push('console: ' + m.text().slice(0, 200)); });
    await p.setCookie({ name: ckN, value: ckR.join('='), url: BASE });
    // Never let the real Maps script load — deterministic, no network dependency (see file header).
    await p.setRequestInterception(true);
    p.on('request', r => /\/api\/admin\/maps-config/.test(r.url())
        ? r.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, key: '' }) })
        : r.continue());
    // Runs before ANY page script (including admin.html's own inline scripts), so window.google
    // already exists — with OUR fake Autocomplete — by the time AdminPlacesAutocomplete.init() ever
    // checks for it, and the (never-loading, per above) real script has nothing to overwrite.
    await p.evaluateOnNewDocument((placeData) => {
        window.__autocompletes = [];
        function FakeAutocomplete(input, opts) {
            this._input = input; this._opts = opts; this._listeners = {};
            window.__autocompletes.push(this);
        }
        FakeAutocomplete.prototype.addListener = function (evt, cb) { this._listeners[evt] = cb; };
        FakeAutocomplete.prototype.getPlace = function () { return this._place; };
        window.__fireFakePlace = function (autocomplete) {
            // Reconstructs the JS SDK's real shape — geometry.location.lat()/lng() as METHODS, not
            // plain numbers (that's the REST API's shape, the public site's, not this one's) —
            // fresh each call, since function properties don't survive the evaluateOnNewDocument
            // argument boundary (only placeData's plain fields did).
            autocomplete._place = Object.assign({}, placeData, { geometry: { location: { lat: () => placeData.latitude, lng: () => placeData.longitude } } });
            autocomplete._listeners.place_changed();
        };
        window.google = { maps: { places: { Autocomplete: FakeAutocomplete } } };
    }, FAKE_PLACE_DATA);
    await p.goto(BASE + '/admin.html', { waitUntil: 'networkidle0', timeout: 60000 });
    await sleep(1500);
    return p;
}

// Fires a fake place selection on the Autocomplete attached to a specific input id.
async function selectFakePlaceOn(p, inputId) {
    await p.evaluate((id) => {
        const ac = window.__autocompletes.find(a => a._input && a._input.id === id);
        if (!ac) throw new Error('no fake Autocomplete found for #' + id);
        window.__fireFakePlace(ac);
    }, inputId);
    await sleep(150);
}

(async () => {
    await support.start();
    const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-quic'] });

    // ══════════ MANUAL BOOKING drawer: #mbLocation ══════════
    {
        const p = await openAdmin(browser);
        await p.waitForSelector('#btnNewManualBooking', { timeout: 20000 });
        await p.evaluate(() => document.getElementById('btnNewManualBooking').click());
        await p.waitForSelector('#mbLocation', { timeout: 15000 });
        // The drawer's atl:drawerOpened handler is async (loads services, etc.) before it reaches the
        // Places init — poll for it rather than a fixed sleep, which flaked under load (6 browser
        // suites back to back) when the handler simply took longer than the sleep allowed.
        await p.waitForFunction(() => window.__autocompletes && window.__autocompletes.some(a => a._input && a._input.id === 'mbLocation'), { timeout: 15000 });

        // Two by now, not one: #eventsVenueSearch's Autocomplete is (deliberately, per its own
        // comment in js/admin/events.js) constructed once on every admin.html page-ready, "in case
        // the drawer is already in the DOM by ready" — independent of this Manual Booking drawer.
        const ids = await p.evaluate(() => window.__autocompletes.map(a => a._input && a._input.id));
        ok(ids.includes('mbLocation'), 'Manual Booking: an Autocomplete was constructed for #mbLocation', JSON.stringify(ids));
        const fields = await p.evaluate(() => window.__autocompletes.find(a => a._input.id === 'mbLocation')._opts.fields);
        ok(Array.isArray(fields) && fields.includes('address_components') && fields.includes('place_id'), 'Manual Booking: requests place_id + address_components from Google', JSON.stringify(fields));

        await selectFakePlaceOn(p, 'mbLocation');
        const got = await p.evaluate(() => ({
            location: document.getElementById('mbLocation').value,
            placeId: document.getElementById('mbPlaceId').value,
            city: document.getElementById('mbCity').value,
            country: document.getElementById('mbCountry').value,
            address: document.getElementById('mbAddress').value,
            state: document.getElementById('mbState').value,
            postal: document.getElementById('mbPostalCode').value,
            lat: document.getElementById('mbLatitude').value,
            lng: document.getElementById('mbLongitude').value
        }));
        ok(got.location === 'Fake Venue Hall' && got.placeId === 'fake-place-id-123', 'Manual Booking: selecting a place fills the venue name + place id', JSON.stringify(got));
        ok(got.city === 'Cape Town' && got.country === 'South Africa' && /Fake Street/.test(got.address), 'Manual Booking: city/country/address extracted via the shared parser', JSON.stringify(got));
        ok(got.state === 'Western Cape' && got.postal === '8001', 'Manual Booking: the additive state/postal-code fields are captured (previously discarded entirely)', JSON.stringify(got));
        ok(Math.abs(parseFloat(got.lat) - -33.9249) < 1e-6 && Math.abs(parseFloat(got.lng) - 18.4241) < 1e-6, 'Manual Booking: lat/lng read correctly from the JS SDK\'s lat()/lng() FUNCTIONS (not the REST API\'s plain-number shape)', JSON.stringify(got));

        // Typing in the field afterwards must not retain a stale place id from before the edit — same
        // "editing clears what the place filled in" rule the public combobox already enforces
        // (test/browser/form.js) - here just of the Autocomplete widget's own remit: nothing besides
        // the widget itself watches #mbLocation for manual edits, so only re-selecting (or the drawer
        // resetting) changes these hidden fields; typing alone intentionally leaves them as-is.
        ok(p._errs.length === 0, 'Manual Booking: no page errors', p._errs.join(' | '));
        await p.close();
    }

    // ══════════ EVENTS drawer: #eventsVenueSearch (parity fix — used to capture almost nothing) ══════════
    {
        const p = await openAdmin(browser);
        await p.waitForSelector('#eventsAddNewBtn', { timeout: 20000 });
        await p.evaluate(() => document.getElementById('eventsAddNewBtn').click());
        await p.waitForSelector('#eventsVenueSearch', { timeout: 15000 });
        await p.waitForFunction(() => window.__autocompletes && window.__autocompletes.some(a => a._input && a._input.id === 'eventsVenueSearch'), { timeout: 15000 });

        await selectFakePlaceOn(p, 'eventsVenueSearch');
        const got = await p.evaluate(() => ({
            venue: document.getElementById('eventsVenue').value,
            mapLink: document.getElementById('eventsVenueMapLink').value,
            placeId: document.getElementById('eventsVenuePlaceId').value,
            address: document.getElementById('eventsVenueAddress').value,
            city: document.getElementById('eventsVenueCity').value,
            state: document.getElementById('eventsVenueState').value,
            country: document.getElementById('eventsVenueCountry').value,
            postal: document.getElementById('eventsVenuePostalCode').value,
            lat: document.getElementById('eventsVenueLatitude').value,
            lng: document.getElementById('eventsVenueLongitude').value
        }));
        ok(got.venue === 'Fake Venue Hall', 'Events: selecting a place still auto-fills the (required, read-only) venue name box — unchanged behaviour', JSON.stringify(got));
        ok(got.mapLink === 'https://maps.google.com/?cid=999888777', 'Events: still prefers place.url for the map link — unchanged behaviour', got.mapLink);
        ok(got.placeId === 'fake-place-id-123' && got.address && got.city === 'Cape Town' && got.state === 'Western Cape' && got.country === 'South Africa' && got.postal === '8001',
            'Events: NOW also captures place_id/address/city/state/country/postal (parity fix — this drawer used to capture none of it)', JSON.stringify(got));
        ok(Math.abs(parseFloat(got.lat) - -33.9249) < 1e-6, 'Events: latitude captured too', got.lat);
        ok(p._errs.length === 0, 'Events: no page errors', p._errs.join(' | '));
        await p.close();
    }

    // ══════════ ACCOLADES drawer: #aclLocation (a plain text field — no venues row, unlike above) ══════════
    {
        const p = await openAdmin(browser);
        await p.waitForSelector('#accoladesAddNewBtn', { timeout: 20000 });
        await p.evaluate(() => document.getElementById('accoladesAddNewBtn').click());
        await p.waitForSelector('#aclLocation', { timeout: 15000 });
        await p.waitForFunction(() => window.__autocompletes && window.__autocompletes.some(a => a._input && a._input.id === 'aclLocation'), { timeout: 15000 });

        await selectFakePlaceOn(p, 'aclLocation');
        const got = await p.evaluate(() => document.getElementById('aclLocation').value);
        ok(got === 'Cape Town', 'Accolades: selecting a place fills Location with "city, else province" (TMLocation.cityOrState) — same display rule as Manual Booking/Events', got);

        // Typing after a selection is still free text (no re-lookup forced) — the field stays editable.
        await p.evaluate(() => { const i = document.getElementById('aclLocation'); i.value = 'Cape Town, custom note'; i.dispatchEvent(new Event('input', { bubbles: true })); });
        const edited = await p.evaluate(() => document.getElementById('aclLocation').value);
        ok(edited === 'Cape Town, custom note', 'Accolades: the field stays freely editable after a place is picked', edited);

        // Closing the drawer resets the double-init guard, so a fresh Add/Edit gets a fresh Autocomplete.
        await p.evaluate(() => document.getElementById('aclCancelBtn').click());
        await p.waitForFunction(() => !document.getElementById('aclDrawer').classList.contains('atl-drawer--open'), { timeout: 10000 });
        await p.evaluate(() => document.getElementById('accoladesAddNewBtn').click());
        await p.waitForSelector('#aclLocation', { timeout: 15000 });
        const reinited = await p.waitForFunction(() => window.__autocompletes.filter(a => a._input && a._input.id === 'aclLocation').length === 2, { timeout: 10000 }).then(() => true, () => false);
        ok(reinited, 'Accolades: reopening the drawer re-attaches Places (the guard was reset on close)', JSON.stringify(await p.evaluate(() => window.__autocompletes.filter(a => a._input && a._input.id === 'aclLocation').length)));

        ok(p._errs.length === 0, 'Accolades: no page errors', p._errs.join(' | '));
        await p.close();
    }

    await browser.close(); await support.stop();
    console.log(fails ? `\n${fails} FAILURE(S)` : '\nALL PASS'); process.exit(fails ? 1 : 0);
})().catch(async e => { console.error('ERR', e.stack || e.message); try { await support.stop(); } catch (_) {} process.exit(2); });
