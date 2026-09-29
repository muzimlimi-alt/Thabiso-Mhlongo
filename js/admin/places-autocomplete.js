/*
 * Shared admin Google Places Autocomplete initializer (2026-09-29 consolidation audit).
 *
 * Before this file existed, three admin surfaces each constructed their own
 * `new google.maps.places.Autocomplete(...)` by hand, each with its own slightly different
 * address-component parsing and its own double-init guard: the Manual Booking drawer
 * (#mbLocation, admin.html), the Booking Pipeline's "Link a venue" search
 * (#venueLinkGoogle-{id}, js/admin/bookings-dealview.js) and the Events drawer's venue search
 * (#eventsVenueSearch, js/admin/events.js — the thinnest of the three: it never captured a
 * place_id or created/linked a `venues` row at all). All three now call this instead, supplying
 * only what THEY need (which `fields` to request from Google, what to do with the result) — the
 * Google init, the "don't double-init the same input" guard, and address parsing are shared.
 *
 * Requires js/shared/location-utils.js to be loaded first (for TMLocation.parseAddressComponents).
 */
(function (global) {
    'use strict';

    // The standardised location shape every consumer gets back from a selection, regardless of
    // which admin surface asked for it (project-wide alongside js/shared/location-utils.js):
    //   { placeId, name, formattedAddress, city, state, postalCode, country, latitude, longitude, mapUrl }
    // Only `fields` actually requested from Google come back populated — the rest are '' / null,
    // same as any other optional field elsewhere in this project's location handling.
    function toStandardLocation(place) {
        var addr = global.TMLocation
            ? global.TMLocation.parseAddressComponents(place.address_components)
            : { city: '', state: '', postalCode: '', country: '' };
        var loc = place.geometry && place.geometry.location;
        return {
            placeId: place.place_id || '',
            name: place.name || '',
            formattedAddress: place.formatted_address || '',
            city: addr.city, state: addr.state, postalCode: addr.postalCode, country: addr.country,
            latitude: loc ? loc.lat() : null,
            longitude: loc ? loc.lng() : null,
            mapUrl: place.url || null
        };
    }

    // input: the text <input> to attach to. opts:
    //   fields       - which Google Place fields to request (defaults to the full set every
    //                  current caller needs between them: place_id/name/formatted_address/
    //                  address_components/geometry/url — Places bills per field requested, so a
    //                  caller that only needs a subset, like the Events venue search's map link
    //                  and name, can trim this).
    //   onPlace(loc, rawPlace) - called with the standardised location object once the visitor
    //                  picks a suggestion. Not called if Google returns no place (e.g. the visitor
    //                  pressed Enter without picking one).
    //   onUnavailable() - called instead of initializing if window.google.maps.places isn't loaded
    //                  yet (the admin's Maps script loads once, after login — see
    //                  window.loadGoogleMaps in admin.html — so this can legitimately run before
    //                  it's ready). Optional; the default is just a console warning, matching what
    //                  every one of the three call sites already did on its own before this file.
    //   onInput()    - called on every keystroke in the field (all three current callers use this
    //                  to invalidate/disable whatever "confirm this place" affordance they show
    //                  next to the field once the visitor starts typing something different).
    // Returns the google.maps.places.Autocomplete instance, or null if it wasn't (re-)initialized.
    function init(input, opts) {
        opts = opts || {};
        if (!input || input._placesInited) return null;
        if (!global.google || !global.google.maps || !global.google.maps.places) {
            console.warn('[AdminPlacesAutocomplete] Google Maps Places library is not loaded yet.');
            if (typeof opts.onUnavailable === 'function') opts.onUnavailable();
            return null;
        }
        input._placesInited = true;
        var fields = opts.fields || ['place_id', 'name', 'formatted_address', 'address_components', 'geometry', 'url'];
        var autocomplete = new global.google.maps.places.Autocomplete(input, { fields: fields });
        autocomplete.addListener('place_changed', function () {
            var place = autocomplete.getPlace();
            if (place && typeof opts.onPlace === 'function') opts.onPlace(toStandardLocation(place), place);
        });
        if (typeof opts.onInput === 'function') input.addEventListener('input', opts.onInput);
        return autocomplete;
    }

    // Clears the double-init guard so a later init() call re-attaches — every current caller resets
    // this when its drawer closes (the field, and any Autocomplete bound to it, gets torn down with
    // the rest of the drawer's DOM; a fresh one is needed next time it opens).
    function reset(input) { if (input) input._placesInited = false; }

    global.AdminPlacesAutocomplete = { init: init, reset: reset, toStandardLocation: toStandardLocation };
})(window);
