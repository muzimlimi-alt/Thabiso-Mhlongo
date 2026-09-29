/*
 * Shared location-search utilities (2026-09-29 consolidation audit).
 *
 * Google Places' `address_components` array has the IDENTICAL shape ({ long_name, short_name,
 * types }) whether it came back from the server-side Places REST API (the public booking wizard's
 * proxy, js/myscript.js) or the client-side Maps JavaScript SDK (the admin portal's
 * google.maps.places.Autocomplete, js/admin/places-autocomplete.js) — so the parsing logic can be
 * (and, before this file existed, wasn't) genuinely one function shared by both, not three
 * similar-but-different hand-rolled versions.
 *
 * Loaded by both index.html and admin.html. No DOM, no Google objects, no jQuery — pure data in,
 * data out, so it's trivial to unit-test and safe to load on either side.
 */
(function (global) {
    'use strict';

    // Standardised shape every location-search implementation in this project now returns:
    //   { city, state, postalCode, country }
    // city prefers a true locality, but several South African places only geocode to a
    // sublocality (sublocality_level_1/sublocality) or no locality at all — falls back to
    // administrative_area_level_2 (the closest thing to "city" left) rather than leaving it
    // blank. state/postalCode/country are each taken from their own component type and never
    // used to fill in for a missing city — a caller that wants "city, else province" (the public
    // combobox's existing, tested display behaviour) builds that itself from the two separate
    // fields, so this function never blurs the two together.
    function parseAddressComponents(components) {
        var out = { city: '', state: '', postalCode: '', country: '' };
        (components || []).forEach(function (c) {
            var types = c.types || [];
            if (!out.city && (types.indexOf('locality') !== -1 || types.indexOf('sublocality_level_1') !== -1 || types.indexOf('sublocality') !== -1)) {
                out.city = c.long_name;
            } else if (!out.city && types.indexOf('administrative_area_level_2') !== -1) {
                out.city = c.long_name;
            }
            if (!out.state && types.indexOf('administrative_area_level_1') !== -1) out.state = c.long_name;
            if (!out.postalCode && types.indexOf('postal_code') !== -1) out.postalCode = c.long_name;
            if (!out.country && types.indexOf('country') !== -1) out.country = c.long_name;
        });
        return out;
    }

    // The public combobox's existing (tested) display rule: show a true city, else fall back to
    // the province/state name rather than leave the field blank. Kept as its own function so that
    // fallback policy — a UI choice, not a parsing fact — lives in exactly one place too.
    function cityOrState(parsed) {
        return parsed.city || parsed.state || '';
    }

    global.TMLocation = { parseAddressComponents: parseAddressComponents, cityOrState: cityOrState };
})(window);
