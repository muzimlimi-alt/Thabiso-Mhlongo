// Admin location search - browser test (rewritten in the 2026-10 Places audit).
// Every admin venue/location field now searches through this server (js/shared/places-client.js ->
// /api/admin/places/* -> lib/places.js) instead of Google's browser widget. Google itself is never contacted:
// the two /api/admin/places/* endpoints are answered by request interception with fixed fixtures (or with an
// error, for the failure cases), so this proves OUR code - the widget, AdminPlacesAutocomplete and each drawer's
// onPlace / onInput callbacks - end to end in the real admin.html, deterministically and at no cost.
// lib/places.js itself (Google's two API generations, error codes) is unit-tested in test/places-service.test.js.
// Not part of `npm test`: run it with `npm run test:browser`.
const support = require('../support');
const puppeteer = require('puppeteer');
const { BASE, sleep } = support;
let fails = 0;
const ok = (c, n, detail) => { if (!c) fails++; console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '\n        -> ' + detail)); };

const PREDICTIONS = [
    { place_id: 'fake-place-id-123', main_text: 'Fake Venue Hall', secondary_text: 'Fake Street, Cape Town, South Africa', formatted_address: 'Fake Venue Hall, Fake Street, Cape Town, South Africa' },
    { place_id: 'fake-place-id-456', main_text: 'Other Venue', secondary_text: 'Durban, South Africa', formatted_address: 'Other Venue, Durban, South Africa' },
];
const LOCATION = {
    placeId: 'fake-place-id-123', name: 'Fake Venue Hall',
    formattedAddress: '1 Fake Street, Cape Town, Western Cape, 8001, South Africa',
    city: 'Cape Town', state: 'Western Cape', postalCode: '8001', country: 'South Africa', countryCode: 'ZA',
    latitude: -33.9249, longitude: 18.4241, mapUrl: 'https://maps.google.com/?cid=999888777',
};

async function openAdmin(browser, mode) {
    const lr = await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'test.runner@example.invalid', password: 'TestRunnerPass1!' }) });
    const [ckN, ...ckR] = lr.headers.get('set-cookie').split(';')[0].split('=');
    const ctx = await browser.createBrowserContext();
    const p = await ctx.newPage();
    p._errs = [];
    p._placesCalls = [];
    p.on('pageerror', e => p._errs.push(e.message.slice(0, 200)));
    // Pre-existing noise unrelated to location search: admin CSS has a data: URI font the CSP refuses, and the
    // "No Image" placeholders come from placehold.co, which the CSP's img-src does not list.
    p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text()) && !/(Loading|load) the font/.test(m.text()) && !/placehold\.co/.test(m.text())) p._errs.push('console: ' + m.text().slice(0, 200)); });
    await p.setCookie({ name: ckN, value: ckR.join('='), url: BASE });
    await p.setRequestInterception(true);
    p.on('request', r => {
        const u = r.url();
        if (/maps\.googleapis\.com|places\.googleapis\.com/.test(u)) { p._errs.push('page contacted Google directly: ' + u.slice(0, 80)); return r.abort(); }
        if (r.method() === 'PUT' && /\/api\/admin\/events\/987654$/.test(u)) return r.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) });
        if (!/\/api\/admin\/places\/(autocomplete|details)/.test(u)) return r.continue();
        p._placesCalls.push(u);
        const json = (status, body) => r.respond({ status, contentType: 'application/json', body: JSON.stringify(body) });
        if (mode === 'down') return json(503, { success: false, predictions: [], error: { code: 'API_NOT_ENABLED', message: 'Location search is unavailable right now.' } });
        if (/autocomplete/.test(u)) return json(200, { success: true, predictions: PREDICTIONS });
        return json(200, { success: true, location: LOCATION });
    });
    await p.goto(BASE + '/admin.html', { waitUntil: 'networkidle0', timeout: 60000 });
    await sleep(1200);
    return p;
}

// A drawer moves focus to its first field once its open transition ends - let that settle before typing.
async function waitAttached(p, id) {
    await p.waitForFunction(i => { const el = document.getElementById(i); return el && el._tmPlaces; }, { timeout: 15000 }, id);
    await sleep(800);
}

// Types into an input like a person, waits for the dropdown, and picks the first suggestion with the keyboard.
async function searchAndPick(p, id, text) {
    await p.focus('#' + id);
    await p.evaluate(i => { document.getElementById(i).value = ''; }, id);
    await p.type('#' + id, text, { delay: 20 });
    await p.waitForFunction(i => {
        const dd = document.getElementById(document.getElementById(i).getAttribute('aria-controls'));
        return dd && !dd.hidden && dd.querySelector('.tm-places-opt');
    }, { timeout: 5000 }, id);
    await p.keyboard.press('ArrowDown');
    await p.keyboard.press('Enter');
    await sleep(400);
}

(async () => {
    await support.start();
    const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-quic'], executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined });

    // ══════════ MANUAL BOOKING drawer: #mbLocation ══════════
    {
        const p = await openAdmin(browser);
        await p.waitForSelector('#btnNewManualBooking', { timeout: 20000 });
        await p.evaluate(() => document.getElementById('btnNewManualBooking').click());
        await waitAttached(p, 'mbLocation');
        ok(await p.evaluate(() => document.getElementById('mbLocation').getAttribute('role') === 'combobox'), 'Manual Booking: #mbLocation becomes an accessible combobox as soon as the drawer opens (no waiting for Google\'s script)', '');

        await searchAndPick(p, 'mbLocation', 'Fake Ven');
        const got = await p.evaluate(() => ({
            location: document.getElementById('mbLocation').value,
            placeId: document.getElementById('mbPlaceId').value, city: document.getElementById('mbCity').value,
            country: document.getElementById('mbCountry').value, address: document.getElementById('mbAddress').value,
            state: document.getElementById('mbState').value, postal: document.getElementById('mbPostalCode').value,
            lat: document.getElementById('mbLatitude').value, lng: document.getElementById('mbLongitude').value,
        }));
        ok(got.location === 'Fake Venue Hall' && got.placeId === 'fake-place-id-123', 'Manual Booking: picking a suggestion fills the venue name + place id', JSON.stringify(got));
        ok(got.city === 'Cape Town' && got.country === 'South Africa' && /Fake Street/.test(got.address) && got.state === 'Western Cape' && got.postal === '8001', 'Manual Booking: city/country/address/state/postcode filled', JSON.stringify(got));
        ok(Math.abs(parseFloat(got.lat) - -33.9249) < 1e-6 && Math.abs(parseFloat(got.lng) - 18.4241) < 1e-6, 'Manual Booking: coordinates now filled (the old field list never asked Google for them)', JSON.stringify(got));
        const detailsUrl = p._placesCalls.find(u => /details/.test(u)) || '';
        ok(/sessionToken=[a-f0-9]{8,}/.test(detailsUrl) && !/detail=basic/.test(detailsUrl), 'Manual Booking: details requested at full detail with a billing session token', detailsUrl);

        // Retyping the venue after a pick must drop the picked place's data (it no longer describes the field).
        await p.focus('#mbLocation');
        await p.keyboard.type(' (moved)');
        const after = await p.evaluate(() => ({ placeId: document.getElementById('mbPlaceId').value, address: document.getElementById('mbAddress').value, lat: document.getElementById('mbLatitude').value, text: document.getElementById('mbLocation').value }));
        ok(after.placeId === '' && after.address === '' && after.lat === '' && /moved/.test(after.text), 'Manual Booking: retyping clears the stale place id/address/coordinates and keeps the typed text', JSON.stringify(after));

        // Close and reopen: one fresh widget, no leftover dropdowns / duplicate listeners.
        await p.evaluate(() => window.closeAtlDrawer('manualBookingDrawer'));
        await sleep(400);
        const closed = await p.evaluate(() => ({ attached: !!document.getElementById('mbLocation')._tmPlaces, dds: document.querySelectorAll('.tm-places-dd').length }));
        await p.evaluate(() => document.getElementById('btnNewManualBooking').click());
        await waitAttached(p, 'mbLocation');
        const reopened = await p.evaluate(() => ({ live: window.TMPlaces._live(), dds: document.querySelectorAll('.tm-places-dd').length }));
        ok(!closed.attached && reopened.dds === closed.dds + 1, 'Manual Booking: closing detaches the search, reopening attaches exactly one fresh one', JSON.stringify({ closed, reopened }));
        const callsBefore = p._placesCalls.length;
        await p.focus('#mbLocation'); await p.keyboard.type('Oth');
        await sleep(900);
        ok(p._placesCalls.length - callsBefore === 1, 'Manual Booking: after reopening, one search per pause in typing (no duplicate listeners firing twice)', String(p._placesCalls.length - callsBefore));
        ok(p._errs.length === 0, 'Manual Booking: no page errors and no direct calls to Google', p._errs.join(' | '));
        await p.close();
    }

    // ══════════ EVENTS drawer: #eventsVenueSearch ══════════
    {
        const p = await openAdmin(browser);
        await p.waitForSelector('#eventsAddNewBtn', { timeout: 20000 });
        await p.evaluate(() => document.getElementById('eventsAddNewBtn').click());
        await waitAttached(p, 'eventsVenueSearch');
        await searchAndPick(p, 'eventsVenueSearch', 'Fake Ven');
        const got = await p.evaluate(() => ({
            venue: document.getElementById('eventsVenue').value, mapLink: document.getElementById('eventsVenueMapLink').value,
            placeId: document.getElementById('eventsVenuePlaceId').value, address: document.getElementById('eventsVenueAddress').value,
            city: document.getElementById('eventsVenueCity').value, state: document.getElementById('eventsVenueState').value,
            country: document.getElementById('eventsVenueCountry').value, postal: document.getElementById('eventsVenuePostalCode').value,
            lat: document.getElementById('eventsVenueLatitude').value,
        }));
        ok(got.venue === 'Fake Venue Hall' && got.mapLink === 'https://maps.google.com/?cid=999888777', 'Events: picking a place fills the venue name and map link (unchanged behaviour)', JSON.stringify(got));
        ok(got.placeId === 'fake-place-id-123' && got.city === 'Cape Town' && got.state === 'Western Cape' && got.country === 'South Africa' && got.postal === '8001' && Math.abs(parseFloat(got.lat) - -33.9249) < 1e-6, 'Events: place id/address/coordinates captured', JSON.stringify(got));

        // A new event in the same session must not inherit the previous pick (form.reset() leaves hidden inputs).
        await p.evaluate(() => window.openEvtCreateDrawer());
        await sleep(800);
        const fresh = await p.evaluate(() => ({ placeId: document.getElementById('eventsVenuePlaceId').value, lat: document.getElementById('eventsVenueLatitude').value, mapLink: document.getElementById('eventsVenueMapLink').value }));
        ok(fresh.placeId === '' && fresh.lat === '' && fresh.mapLink === '', 'Events: "New Event" starts with no leftover place data from the previous pick', JSON.stringify(fresh));

        // A map URL typed by hand survives retyping the search; a picked one does not.
        await searchAndPick(p, 'eventsVenueSearch', 'Fake Ven');
        await p.focus('#eventsVenueSearch'); await p.keyboard.type('x');
        const cleared = await p.evaluate(() => ({ placeId: document.getElementById('eventsVenuePlaceId').value, mapLink: document.getElementById('eventsVenueMapLink').value }));
        ok(cleared.placeId === '' && cleared.mapLink === '', 'Events: retyping the search clears the picked place and its auto-filled map link', JSON.stringify(cleared));
        await p.evaluate(() => { const m = document.getElementById('eventsVenueMapLink'); m.value = 'https://maps.google.com/?q=manual'; m.dispatchEvent(new Event('input', { bubbles: true })); });
        await p.focus('#eventsVenueSearch'); await p.keyboard.type('y');
        ok(await p.evaluate(() => document.getElementById('eventsVenueMapLink').value) === 'https://maps.google.com/?q=manual', 'Events: a hand-typed map URL is left alone', '');

        // Editing an existing event without searching again must keep its venue link. The edit form never re-loads the
        // Google place, so the save used to send no venue at all and the update set events.venue_id to NULL.
        const saved = [];
        p.on('request', r => { if (r.method() === 'PUT' && /\/api\/admin\/events\/987654$/.test(r.url())) saved.push(JSON.parse(r.postData() || '{}')); });
        const editAndSave = async (rename) => {
            await p.evaluate(() => {
                window.openEvtCreateDrawer();
                applyEventToEditor({ event_id: 987654, event_title: 'Linked Venue Show', event_datetime: '2027-03-06T18:00:00', venue_name: 'Old Hall', venue_id: 42, event_status: 'upcoming' });
            });
            await sleep(500);
            if (rename) await p.evaluate(() => { document.getElementById('eventsVenue').value = 'New Hall'; });
            await p.evaluate(() => document.getElementById('eventsSubmitBtn').click());
            await sleep(1500);
        };
        await editAndSave(false);
        ok(saved[0] && saved[0].venue_id === 42 && !saved[0].venue_place_id, 'Events: saving an edit without a new venue search keeps the existing venue link (venue_id sent)', JSON.stringify(saved[0] && { venue_id: saved[0].venue_id, venue_place_id: saved[0].venue_place_id }));
        await editAndSave(true);
        ok(saved[1] && saved[1].venue_id === null && saved[1].venue_name === 'New Hall', 'Events: renaming the venue by hand drops the old link instead of attaching the new name to the old venue', JSON.stringify(saved[1] && { venue_id: saved[1].venue_id, venue_name: saved[1].venue_name }));
        ok(p._errs.length === 0, 'Events: no page errors and no direct calls to Google', p._errs.join(' | '));
        await p.close();
    }

    // ══════════ ACCOLADES drawer: #aclLocation (basic detail, plain text field) ══════════
    {
        const p = await openAdmin(browser);
        await p.waitForSelector('#accoladesAddNewBtn', { timeout: 20000 });
        await p.evaluate(() => document.getElementById('accoladesAddNewBtn').click());
        await waitAttached(p, 'aclLocation');
        await searchAndPick(p, 'aclLocation', 'Fake Ven');
        ok(await p.evaluate(() => document.getElementById('aclLocation').value) === 'Cape Town', 'Accolades: picking a place fills "city, else province"', await p.evaluate(() => document.getElementById('aclLocation').value));
        ok(/detail=basic/.test(p._placesCalls.find(u => /details/.test(u)) || ''), 'Accolades: asks for the cheaper name+address-only details', p._placesCalls.join(' '));
        await p.evaluate(() => { const i = document.getElementById('aclLocation'); i.value = 'Cape Town, custom note'; i.dispatchEvent(new Event('input', { bubbles: true })); });
        ok(await p.evaluate(() => document.getElementById('aclLocation').value) === 'Cape Town, custom note', 'Accolades: the field stays freely editable', '');
        await p.evaluate(() => document.getElementById('aclCancelBtn').click());
        await p.waitForFunction(() => !document.getElementById('aclDrawer').classList.contains('atl-drawer--open'), { timeout: 10000 });
        await p.evaluate(() => document.getElementById('accoladesAddNewBtn').click());
        const reinited = await p.waitForFunction(() => document.getElementById('aclLocation')._tmPlaces, { timeout: 10000 }).then(() => true, () => false);
        ok(reinited, 'Accolades: reopening the drawer re-attaches the search', '');
        ok(p._errs.length === 0, 'Accolades: no page errors and no direct calls to Google', p._errs.join(' | '));
        await p.close();
    }

    // ══════════ FAILURE: Google/configuration down -> clear message, manual entry still works ══════════
    {
        const p = await openAdmin(browser, 'down');
        await p.waitForSelector('#btnNewManualBooking', { timeout: 20000 });
        await p.evaluate(() => document.getElementById('btnNewManualBooking').click());
        await waitAttached(p, 'mbLocation');
        await p.focus('#mbLocation'); await p.type('#mbLocation', 'Sandton Convention', { delay: 15 });
        await p.waitForFunction(() => { const dd = document.querySelector('#' + document.getElementById('mbLocation').getAttribute('aria-controls')); return dd && !dd.hidden && dd.querySelector('.tm-places-msg.is-warn'); }, { timeout: 5000 }).catch(() => {});
        const msg = await p.evaluate(() => { const dd = document.querySelector('#' + document.getElementById('mbLocation').getAttribute('aria-controls')); return dd ? dd.textContent : ''; });
        ok(/isn.t available right now/i.test(msg) && /manually/i.test(msg), 'Search down: the dropdown says search is unavailable and to type the location manually (not "no matches")', msg);
        ok(p._placesCalls.length === 1, 'Search down: exactly one request (the global fetch wrapper\'s automatic retries are switched off for search)', String(p._placesCalls.length));
        await p.keyboard.press('Enter');   // with no suggestions, Enter must not pick anything
        const v = await p.evaluate(() => ({ text: document.getElementById('mbLocation').value, placeId: document.getElementById('mbPlaceId').value }));
        ok(v.text === 'Sandton Convention' && v.placeId === '', 'Search down: the typed text stays as a manual entry with no place data', JSON.stringify(v));
        ok(p._errs.length === 0, 'Search down: no page errors', p._errs.join(' | '));
        await p.close();
    }

    await browser.close(); await support.stop();
    console.log(fails ? `\n${fails} FAILURE(S)` : '\nALL PASS'); process.exit(fails ? 1 : 0);
})().catch(async e => { console.error('ERR', e.stack || e.message); try { await support.stop(); } catch (_) {} process.exit(2); });
