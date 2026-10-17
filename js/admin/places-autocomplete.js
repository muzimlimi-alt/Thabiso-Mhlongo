/*
 * Shared admin location search - window.AdminPlacesAutocomplete (2026-09-29 consolidation; rebuilt in the
 * 2026-10 Places audit).
 *
 * Used by every admin surface that searches for a place: the Manual Booking drawer (#mbLocation, admin.html),
 * the Booking Pipeline's "Link a venue" (#venueLinkGoogle-{id}, js/admin/bookings-dealview.js), the Events
 * drawer's venue search (#eventsVenueSearch, js/admin/events.js) and the Accolades location (#aclLocation,
 * js/admin/accolades.js). Callers keep the same API as before - init(input, opts) / reset(input) - and
 * receive the same standardised location object.
 *
 * What changed underneath: this used to build Google's browser widget (google.maps.places.Autocomplete),
 * which needed the Maps JavaScript script and a separate browser key loaded after login. If a drawer opened
 * before that script arrived, the field silently stayed a plain text box until a page reload; and that widget
 * is a legacy product Google no longer offers to new Cloud projects (since 1 March 2025). It now uses
 * js/shared/places-client.js (TMPlaces), which searches through this site's own server (/api/admin/places/*,
 * lib/places.js) - the same service as the public booking drawer - so it works the moment a drawer opens.
 *
 * Requires js/shared/places-client.js to be loaded first.
 */
(function (global) {
    'use strict';

    // input: the text <input> to attach to. opts:
    //   detail       'full' (default - address, coordinates, map link) or 'basic' (name + address only).
    //   fields       accepted for backward compatibility: a list without 'geometry' and without 'place_id'
    //                means 'basic' (that was the Accolades call); anything else is 'full'.
    //   onPlace(loc) called with { placeId, name, formattedAddress, city, state, postalCode, country,
    //                countryCode, latitude, longitude, mapUrl } once a suggestion is picked.
    //   onInput()    called on every keystroke - callers use it to clear the place data they hold, because
    //                once the text changes, the previously picked place no longer describes the field.
    // Returns the attached controller, or null. Calling it again for the same input is a no-op (no duplicate
    // listeners), so it is safe to call on every drawer open.
    function init(input, opts) {
        opts = opts || {};
        if (!input) return null;
        if (!global.TMPlaces) { console.warn('[AdminPlacesAutocomplete] js/shared/places-client.js is not loaded.'); return null; }
        if (input._tmPlaces) return null;
        var detail = opts.detail;
        if (!detail && Array.isArray(opts.fields)) {
            detail = (opts.fields.indexOf('geometry') === -1 && opts.fields.indexOf('place_id') === -1) ? 'basic' : 'full';
        }
        return global.TMPlaces.attach(input, {
            endpoint: '/api/admin/places',
            detail: detail || 'full',
            onPlace: opts.onPlace,
            onInput: opts.onInput
        });
    }

    // Detaches so the next init() re-attaches cleanly - callers call this when their drawer closes.
    function reset(input) { if (input && global.TMPlaces) global.TMPlaces.detach(input); }

    global.AdminPlacesAutocomplete = { init: init, reset: reset };
})(window);
