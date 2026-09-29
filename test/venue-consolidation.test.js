// Location-search consolidation (2026-09-29 audit)
// Before this, every venue-creating path upserted `venues` a slightly different way: the shared
// helper (lib/client-venue.js, used by public booking creation and admin manual-booking creation)
// only ever filled in fields that were still blank and didn't know about state/postal_code/lat/lng
// at all, while the admin "Link a venue to an existing booking" endpoint ran its own inline copy of
// the same upsert that always overwrote (even with blanks) and DID capture those richer fields. The
// Events venue search never created/linked a venues row at all. This file exercises the one shared
// upsert (lib/client-venue.js findOrCreateVenueFromPlace, now with the full field set) through every
// caller — the point being that two different callers pointing at the SAME real place (same
// place_id) end up sharing ONE venues row, and that a caller with less information than a previous
// one doesn't blank out what's already there.
// Date offsets live in the 920-949 range, clear of every other file's claimed ranges.
module.exports = async function ({ check, api, pub, one, q, future }) {
    const rand = () => Math.random().toString(36).slice(2, 10);

    // ── Public booking creation: the richer venue fields (state/postal/lat/lng) reach `venues` ──
    {
        const placeId = 'ChIJ-public-' + rand();
        const r = await pub('POST', '/api/public/bookings', {
            name: 'Venue IT Public', email: `venue.pub.${Date.now()}@example.invalid`, cell: '+27821234567',
            event_name: 'Venue Consolidation Test', event_date: future(920), event_type: 'Corporate',
            event_location: 'Public Test Hall', venue_address: '1 Public Rd', city: 'Johannesburg', country: 'South Africa',
            venuePlaceId: placeId, venue_state: 'Gauteng', venue_postal_code: '2000', venue_latitude: '-26.2041', venue_longitude: '28.0473',
            message: 'Venue consolidation integration test booking, over ten characters.',
            services: [{ service_id: 15 }], popia_consent: true
        });
        check('public booking with full venue fields: 201/200', [200, 201].includes(r.status) && r.body.success !== false, JSON.stringify(r.body));
        const venue = await one('SELECT * FROM venues WHERE place_id = ?', [placeId]);
        check('the linked venues row exists', !!venue, JSON.stringify(venue));
        check('...with the state/postal_code/lat/lng the public form now carries through (were previously always dropped)',
            venue && venue.state === 'Gauteng' && venue.postal_code === '2000' && Math.abs(venue.latitude - -26.2041) < 1e-6 && Math.abs(venue.longitude - 28.0473) < 1e-6,
            JSON.stringify(venue));
        check('...and the plain fields too', venue && venue.city === 'Johannesburg' && venue.country === 'South Africa' && venue.address === '1 Public Rd', JSON.stringify(venue));
    }

    // ── Admin manual booking creation: same shared helper, same full field set ──
    {
        const placeId = 'ChIJ-manual-' + rand();
        const r = await api('POST', '/api/admin/bookings', {
            name: 'Venue IT Manual', email: `venue.manual.${Date.now()}@example.invalid`, cell: '+27821234567',
            event_date: future(921), event_name: 'Manual Venue Test', event_type: 'Corporate',
            event_location: 'Manual Test Hall', venue_address: '2 Manual Rd', city: 'Cape Town', country: 'South Africa',
            venue_place_id: placeId, venue_state: 'Western Cape', venue_postal_code: '8001', venue_latitude: -33.9249, venue_longitude: 18.4241,
            message: 'Venue consolidation manual booking test.', services: [{ service_id: 15 }], status: 'NEW'
        });
        check('manual booking with full venue fields: 200', r.status === 200 && r.body.success, JSON.stringify(r.body));
        const venue = await one('SELECT * FROM venues WHERE place_id = ?', [placeId]);
        check('the linked venues row carries state/postal/lat/lng from the manual-booking form', venue && venue.state === 'Western Cape' && venue.postal_code === '8001' && Math.abs(venue.latitude - -33.9249) < 1e-6, JSON.stringify(venue));
    }

    // ── Two different bookings, the SAME real place_id -> ONE shared venues row (the point of consolidating) ──
    {
        const sharedPlaceId = 'ChIJ-shared-' + rand();
        const mk = async (offset, name) => api('POST', '/api/admin/bookings', {
            name, email: `venue.shared.${offset}.${Date.now()}@example.invalid`, cell: '+27821234567',
            event_date: future(offset), event_name: 'Shared Venue Test ' + offset, event_type: 'Corporate',
            event_location: 'Shared Arena', venue_place_id: sharedPlaceId,
            message: 'Venue consolidation shared-venue test.', services: [{ service_id: 15 }], status: 'NEW'
        });
        const r1 = await mk(922, 'Venue IT Shared A');
        const r2 = await mk(923, 'Venue IT Shared B');
        check('both bookings created', r1.status === 200 && r2.status === 200, JSON.stringify([r1.body, r2.body]));
        const rows = await q('SELECT id FROM venues WHERE place_id = ?', [sharedPlaceId]);
        check('exactly one venues row exists for the shared place_id (not two)', rows.length === 1, JSON.stringify(rows));
        const b1 = await one('SELECT venue_id FROM bookings WHERE event_location = ?', ['Shared Arena']);
        check('both bookings point at that one venue_id', !!b1 && !!rows[0] && b1.venue_id === rows[0].id, JSON.stringify({ b1, rows }));
    }

    // ── Merge semantics: COALESCE(new, old) — a later call with LESS info doesn't blank fields the first call set ──
    {
        const placeId = 'ChIJ-merge-' + rand();
        await api('POST', '/api/admin/bookings', {
            name: 'Venue IT Merge 1', email: `venue.merge1.${Date.now()}@example.invalid`, cell: '+27821234567',
            event_date: future(924), event_name: 'Merge Test 1', event_type: 'Corporate',
            event_location: 'Merge Hall', venue_address: 'Original Address', city: 'Durban', country: 'South Africa',
            venue_place_id: placeId, venue_state: 'KwaZulu-Natal', venue_postal_code: '4000', venue_latitude: -29.8587, venue_longitude: 31.0218,
            message: 'Venue consolidation merge test one.', services: [{ service_id: 15 }], status: 'NEW'
        });
        const before = await one('SELECT * FROM venues WHERE place_id = ?', [placeId]);
        check('seed: first call captured the full set', before && before.state === 'KwaZulu-Natal' && before.latitude != null, JSON.stringify(before));

        // Second call: only a name/address change, no state/postal/lat/lng at all — must refresh the
        // name/address (the deliberately-changed fields) without erasing what wasn't sent this time.
        await api('POST', '/api/admin/bookings', {
            name: 'Venue IT Merge 2', email: `venue.merge2.${Date.now()}@example.invalid`, cell: '+27821234567',
            event_date: future(925), event_name: 'Merge Test 2', event_type: 'Corporate',
            event_location: 'Merge Hall Renamed', venue_address: 'Updated Address', city: 'Durban', country: 'South Africa',
            venue_place_id: placeId,
            message: 'Venue consolidation merge test two.', services: [{ service_id: 15 }], status: 'NEW'
        });
        const after = await one('SELECT * FROM venues WHERE place_id = ?', [placeId]);
        check('a later call with fresh name/address overwrites them', after && after.name === 'Merge Hall Renamed' && after.address === 'Updated Address', JSON.stringify(after));
        check('...but does NOT blank state/postal/lat/lng it was never given this time (COALESCE, not always-overwrite)',
            after && after.state === 'KwaZulu-Natal' && after.postal_code === '4000' && after.latitude != null && Math.abs(after.latitude - -29.8587) < 1e-6,
            JSON.stringify(after));
    }

    // ── The venue-google endpoint (Booking Pipeline "Link a venue") now routes through the SAME shared helper ──
    {
        const bk = await api('POST', '/api/admin/bookings', {
            name: 'Venue IT Link', email: `venue.link.${Date.now()}@example.invalid`, cell: '+27821234567',
            event_date: future(926), event_name: 'Link Test', event_type: 'Corporate',
            event_location: 'Unlinked Venue', message: 'Venue consolidation link test.', services: [{ service_id: 15 }], status: 'NEW'
        });
        const bookingId = bk.body.booking_id;
        const placeId = 'ChIJ-link-' + rand();
        const link = await api('PUT', `/api/admin/bookings/${bookingId}/venue-google`, {
            place_id: placeId, name: 'Linked Venue Name', address: 'Linked Address', city: 'Pretoria', state: 'Gauteng', country: 'South Africa', latitude: -25.7479, longitude: 28.2293
        });
        check('venue-google link: 200', link.status === 200 && link.body.success, JSON.stringify(link.body));
        const venue = await one('SELECT * FROM venues WHERE place_id = ?', [placeId]);
        check('venue-google created a venues row via the shared helper (full field set)', venue && venue.name === 'Linked Venue Name' && venue.state === 'Gauteng' && venue.latitude != null, JSON.stringify(venue));
        const bkRow = await one('SELECT venue_id FROM bookings WHERE id = ?', [bookingId]);
        check('the booking is linked to that venue_id', bkRow && bkRow.venue_id === venue.id, JSON.stringify({ bkRow, venue }));

        // Re-linking to the SAME real place with an additional field must refresh, not duplicate.
        const relink = await api('PUT', `/api/admin/bookings/${bookingId}/venue-google`, {
            place_id: placeId, name: 'Linked Venue Name', address: 'Linked Address', city: 'Pretoria', country: 'South Africa', latitude: -25.7479, longitude: 28.2293, state: 'Gauteng'
        });
        check('re-linking the same place: 200', relink.status === 200, JSON.stringify(relink.body));
        const rows = await q('SELECT id FROM venues WHERE place_id = ?', [placeId]);
        check('still exactly one venues row for that place_id (upsert, not a duplicate insert)', rows.length === 1, JSON.stringify(rows));
    }

    // ── Events: parity fix — the venue search now creates/links a real venues row, not just a name + map link ──
    {
        const placeId = 'ChIJ-event-' + rand();
        const ev = await api('POST', '/api/admin/events', {
            event_title: 'Venue IT Event', event_datetime: `${future(927)}T18:00`, event_type: 'Corporate Event',
            venue_name: 'Event Venue Name', venue_map_link: 'https://maps.google.com/?q=-26,28',
            venue_place_id: placeId, venue_address: 'Event Address', venue_city: 'Sandton', venue_state: 'Gauteng',
            venue_country: 'South Africa', venue_postal_code: '2196', venue_latitude: -26.1076, venue_longitude: 28.0567,
            sync_to_gcal: false
        });
        check('event creation with a Google place: 200', ev.status === 200 && ev.body.success, JSON.stringify(ev.body));
        const venue = await one('SELECT * FROM venues WHERE place_id = ?', [placeId]);
        check('a venues row was created for the event (this never happened before the consolidation)', venue && venue.name === 'Event Venue Name' && venue.city === 'Sandton', JSON.stringify(venue));
        const evRow = await one('SELECT venue_id, venue_name, venue_map_link FROM events WHERE event_title = ?', ['Venue IT Event']);
        check('the event is linked to that venue_id, and the existing venue_name/map_link behaviour is unchanged', evRow && evRow.venue_id === venue.id && evRow.venue_name === 'Event Venue Name' && evRow.venue_map_link === 'https://maps.google.com/?q=-26,28', JSON.stringify(evRow));

        // Editing the event with a DIFFERENT place must re-resolve to a different (or updated) venue.
        const placeId2 = 'ChIJ-event2-' + rand();
        const upd = await api('PUT', `/api/admin/events/${ev.body.id}`, {
            event_title: 'Venue IT Event', event_datetime: `${future(928)}T18:00`, event_type: 'Corporate Event',
            venue_name: 'Event Venue Renamed', venue_map_link: 'https://maps.google.com/?q=-25,28',
            venue_place_id: placeId2, venue_address: 'New Address', venue_city: 'Midrand', venue_country: 'South Africa',
            sync_to_gcal: false
        });
        check('event edit with a new Google place: 200', upd.status === 200 && upd.body.success, JSON.stringify(upd.body));
        const venue2 = await one('SELECT * FROM venues WHERE place_id = ?', [placeId2]);
        const evRow2 = await one('SELECT venue_id FROM events WHERE event_title = ?', ['Venue IT Event']);
        check('the event now points at the new venue', venue2 && evRow2 && evRow2.venue_id === venue2.id, JSON.stringify({ venue2, evRow2 }));
    }

    // ── Coordinate validation (public route): garbage/out-of-range input becomes null, never a wrong "real" value ──
    {
        const placeId = 'ChIJ-badcoord-' + rand();
        const r = await pub('POST', '/api/public/bookings', {
            name: 'Venue IT Bad Coords', email: `venue.badcoord.${Date.now()}@example.invalid`, cell: '+27821234567',
            event_name: 'Bad Coords Test', event_date: future(929), event_type: 'Corporate',
            event_location: 'Bad Coords Hall', venuePlaceId: placeId, venue_latitude: 'not-a-number', venue_longitude: '999',
            message: 'Venue consolidation bad-coordinate test, over ten characters.',
            services: [{ service_id: 15 }], popia_consent: true
        });
        check('booking with garbage/out-of-range coordinates still succeeds (they are just dropped)', [200, 201].includes(r.status) && r.body.success !== false, JSON.stringify(r.body));
        const venue = await one('SELECT * FROM venues WHERE place_id = ?', [placeId]);
        check('...and the venue is created with latitude/longitude left null, not a wrong number', venue && venue.latitude === null && venue.longitude === null, JSON.stringify(venue));
    }
};
