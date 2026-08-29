// Calendar domain repository — Phase 4 of the housekeeping effort (HOUSEKEEPING-NOTES.md).
// Covers date_holds, events. Every SQL string below is byte-identical (content-wise; indentation is
// re-flowed to this file, never the SQL keywords/columns/literals) to where it lived in server.js
// before this move. No req/res, no email sending, no PDF generation, no direct Google Calendar API
// calls (those stay in server.js — this file only ever touches the two local tables).
//
// `venues` and `policies` are NOT part of this domain — neither is one of the plan's 8 named
// domains, so every date_holds/events statement that JOINs venues (or sits next to a `policies`
// read) was left in server.js untouched, same treatment bookings/clients JOINs got in earlier
// domains. See HOUSEKEEPING-NOTES.md "calendar" write-up for the full reasoning.
//
// BOOKING_DELETE_PURGE (server.js, DELETE /api/admin/bookings/:id) deletes date_holds and events
// rows by booking_id as part of its hand-ordered, FK-constraint-sensitive cascade array — left
// untouched there, same exclusion as every other domain that array reaches into.
const db = require('../../database');

function promised(sql, params) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function (err) { err ? reject(err) : resolve(this); });
    });
}
function promisedGet(sql, params) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => err ? reject(err) : resolve(row));
    });
}

// =====================================================================================
// date_holds
// =====================================================================================

// ── Availability / conflict checks ──
// hasCalendarConflict()'s local-hold check. Two columns only — checkDateAvailability's near-twin
// below additionally selects block_type, so the two are NOT byte-identical and stay separate.
function getDateHoldTimesForDay(dateStr, callback) {
    db.all(
        `SELECT start_time, end_time FROM date_holds
         WHERE hold_date = ? AND status = 'active'
         AND (hold_expires_at IS NULL OR hold_expires_at > datetime('now'))`,
        [dateStr], callback
    );
}
function getDateHoldsForAvailabilityCheck(dateStr, callback) {
    db.all("SELECT start_time, end_time, block_type FROM date_holds WHERE hold_date = ? AND status = 'active' AND (hold_expires_at IS NULL OR hold_expires_at > datetime('now'))", [dateStr], callback);
}
function getActiveHoldDatesForMonth(likePrefix, callback) {
    db.all("SELECT hold_date FROM date_holds WHERE hold_date LIKE ? AND status = 'active' AND start_time IS NULL", [likePrefix], callback);
}
function getActiveDateHoldsForEventConflict(dateStr, excludeId, callback) {
    db.all(
        `SELECT id, start_time, end_time FROM date_holds
         WHERE hold_date = ? AND status = 'active' AND (event_id IS NULL OR event_id != ?)`,
        [dateStr, excludeId], callback
    );
}
// Shared by findHoldDateConflict() for both a brand-new hold (no exclude clause) and a hold being
// dragged to a new date (excludes its own row) — excludeSql is the pre-built ' AND id != ?' suffix
// (or '' ), matching the dynamic-clause pattern already used for similar functions in other domains.
function getDateHoldsForDateConflict(excludeSql, params, callback) {
    db.all(`SELECT id, start_time, end_time FROM date_holds WHERE hold_date = ? AND status = 'active'${excludeSql}`, params, callback);
}

// ── Google Calendar hold sync (syncCalendarHolds) ──
function getCalendarSyncHoldIds(callback) {
    db.all("SELECT google_event_id FROM date_holds WHERE block_type = 'calendar_sync' AND google_event_id IS NOT NULL", [], callback);
}
function deleteDateHoldByGoogleEventId(googleEventId, callback) {
    db.run("DELETE FROM date_holds WHERE google_event_id = ?", [googleEventId], callback);
}
function getCalendarSyncHoldDetails(callback) {
    db.all("SELECT google_event_id, hold_date, start_time, end_time FROM date_holds WHERE google_event_id IS NOT NULL AND block_type = 'calendar_sync'", [], callback);
}
function updateDateHoldFromGoogleSync(date, startTime, endTime, summary, googleEventId, callback) {
    db.run(
        "UPDATE date_holds SET hold_date = ?, start_time = ?, end_time = ?, notes = ? WHERE google_event_id = ?",
        [date, startTime, endTime, summary, googleEventId], callback
    );
}
function insertDateHoldFromGoogleSync(date, summary, startTime, endTime, googleEventId, callback) {
    db.run(
        `INSERT INTO date_holds (hold_date, notes, status, hold_expires_at, start_time, end_time, block_type, google_event_id)
         VALUES (?, ?, 'active', '9999-12-31 23:59:59', ?, ?, 'calendar_sync', ?)`,
        [date, summary, startTime, endTime, googleEventId], callback
    );
}

// ── Admin dashboard / grid reads ──
function getActiveDateHoldsForToday(dateStr, callback) {
    db.all(
        `SELECT COALESCE(NULLIF(notes, ''), block_type, 'Hold') AS title,
                start_time,
                NULL          AS location,
                block_type    AS type,
                'hold'        AS source,
                NULL          AS client_name
         FROM date_holds
         WHERE hold_date = ? AND status = 'active'`,
        [dateStr], callback
    );
}
function getActiveDateHoldsForCalendarGrid(callback) {
    db.all(`SELECT id, hold_date, notes, start_time, end_time, block_type FROM date_holds WHERE status = 'active'`, [], callback);
}
function getActiveDateHoldsForIcsFeed(callback) {
    db.all(`SELECT hold_date, notes, start_time, end_time FROM date_holds WHERE status = 'active'`, [], callback);
}

// ── Admin hold CRUD (POST/DELETE/PATCH /api/admin/calendar/hold...) ──
function insertDateHold(date, notes, expiresStr, startTime, endTime, blockType, adminId, callback) {
    db.run(
        `INSERT INTO date_holds (hold_date, notes, status, hold_expires_at, start_time, end_time, block_type, created_by)
         VALUES (?, ?, 'active', ?, ?, ?, ?, ?)`,
        [date, notes, expiresStr, startTime || null, endTime || null, blockType || null, adminId], callback
    );
}
function deleteDateHoldById(id, callback) {
    db.run("DELETE FROM date_holds WHERE id = ?", [id], callback);
}
function getDateHoldTimesById(holdId, callback) {
    db.get("SELECT start_time, end_time FROM date_holds WHERE id = ?", [holdId], callback);
}
function updateDateHoldDate(date, adminId, role, holdId, callback) {
    db.run(
        "UPDATE date_holds SET hold_date = ?, hold_expires_at = datetime(?, '+1 day'), updated_by = ?, updated_by_role = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        [date, date, adminId, role || null, holdId], callback
    );
}

// ── Booking-driven hold changes ──
function insertDateHoldForNewEvent(dateStr, notes, eventId, callback) {
    db.run("INSERT INTO date_holds (hold_date, hold_expires_at, status, notes, event_id) VALUES (?, datetime('now', '+30 days'), 'active', ?, ?)", [dateStr, notes, eventId], callback);
}
function clearDateHoldEventId(eventId, callback) {
    db.run("UPDATE date_holds SET event_id = NULL WHERE event_id = ?", [eventId], callback);
}
function updateDateHoldDateForBooking(date, bookingId, callback) {
    db.run("UPDATE date_holds SET hold_date = ? WHERE converted_to_booking_id = ?", [date, bookingId], callback);
}
// 4 byte-identical call sites: POPIA erasure cascade, the dedicated admin cancel route, the generic
// applyStatusChange CANCELLED branch, and the public self-cancel route. Three await this as a
// promise; applyStatusChange fires it with an error-logging callback — two thin siblings over the
// same SQL, not a style conversion either way.
function releaseDateHoldsForBooking(bookingId, callback) {
    db.run("UPDATE date_holds SET status = 'released' WHERE converted_to_booking_id = ?", [bookingId], callback);
}
function releaseDateHoldsForBookingAsync(bookingId) {
    return promised("UPDATE date_holds SET status = 'released' WHERE converted_to_booking_id = ?", [bookingId]);
}

// =====================================================================================
// events
// =====================================================================================

// ── Google Calendar sync (syncCalendarHolds / syncEventToCalendar) ──
function getEventGoogleCalendarIdsForSync(callback) {
    db.all("SELECT google_calendar_event_id FROM events WHERE google_calendar_event_id IS NOT NULL", [], callback);
}
// 2 byte-identical call sites: syncEventToCalendar's own read, and the duplicate-event route's
// source-row read. Both plain callback style.
function getEventById(eventId, callback) {
    db.get("SELECT * FROM events WHERE event_id = ?", [eventId], callback);
}
function setEventGoogleCalendarId(gcalId, eventId, callback) {
    db.run("UPDATE events SET google_calendar_event_id = ? WHERE event_id = ?", [gcalId, eventId], callback);
}
// 4 byte-identical call sites clearing a stale/deleted GCal reference: POPIA cascade and the
// dedicated admin cancel route both await this as a promise; applyStatusChange's CANCELLED branch
// and PUT /api/admin/events/:id's cancel-on-edit branch both fire it fire-and-forget with a
// callback. Two thin siblings over the same SQL.
function clearEventGoogleCalendarId(eventId, callback) {
    db.run("UPDATE events SET google_calendar_event_id = NULL WHERE event_id = ?", [eventId], callback);
}
function clearEventGoogleCalendarIdAsync(eventId) {
    return promised("UPDATE events SET google_calendar_event_id = NULL WHERE event_id = ?", [eventId]);
}
// 2 byte-identical call sites: applyStatusChange's CANCELLED branch and DELETE /api/admin/events/:id,
// both reading the GCal id before clearing/deleting so the Google-side event can be removed too.
function getEventGoogleCalendarId(eventId, callback) {
    db.get("SELECT google_calendar_event_id FROM events WHERE event_id = ?", [eventId], callback);
}

// ── Background-clerk cron (S6/S7 auto-complete sweeps) ──
// S6: booking-linked events. Deliberately distinct from advanceEventToCompleted below — no space
// after the comma in ('cancelled','completed'), a genuine original difference, not reformatted away.
function advanceAutoCompletedEventS6(eventId, callback) {
    db.run("UPDATE events SET event_status = 'completed', modified_on = CURRENT_TIMESTAMP WHERE event_id = ? AND event_status NOT IN ('cancelled','completed')", [eventId], callback);
}
// S7: standalone public events (no linked booking) — had no auto-complete sweep at all until this
// was added, so a past-dated standalone event could sit at "Upcoming" indefinitely.
function getPastStandaloneEventsForAutoComplete(nowLocal, callback) {
    db.all(
        `SELECT event_id FROM events
         WHERE booking_id IS NULL
         AND event_status IN ('upcoming', 'live')
         AND event_datetime < ?`,
        [nowLocal], callback
    );
}
function advanceStandaloneEventCompleted(eventId, callback) {
    db.run(`UPDATE events SET event_status = 'completed', modified_on = CURRENT_TIMESTAMP WHERE event_id = ?`, [eventId], callback);
}
// 2 byte-identical call sites (WITH a space in 'cancelled', 'completed', unlike S6 above): the
// dedicated POST /:id/complete route and applyStatusChange's COMPLETED branch.
function advanceEventToCompleted(eventId, callback) {
    db.run("UPDATE events SET event_status = 'completed', modified_on = CURRENT_TIMESTAMP WHERE event_id = ? AND event_status NOT IN ('cancelled', 'completed')", [eventId], callback);
}

// ── Auto-create-event-on-confirmation (PayFast ITN / manual payment / applyStatusChange) ──
// 3 byte-identical call sites — gating logic differs at each caller (deposit vs full payment vs
// generic status change) but the INSERT itself is identical everywhere a CONFIRMED booking needs an
// events row. created_by is NULL (not 'system'): it's an INTEGER FK to admins(id).
function insertAutoCreatedEvent(eventTitle, eventDatetime, venueName, venueId, bookingId, callback) {
    db.run(
        `INSERT INTO events (event_title, event_datetime, venue_name, venue_id, booking_id, event_status, created_by)
         VALUES (?, ?, ?, ?, ?, 'upcoming', NULL)`,
        [eventTitle, eventDatetime, venueName, venueId, bookingId], callback
    );
}

// ── Availability checks ──
function getUpcomingStandaloneEventOnDate(dateStr, callback) {
    db.all("SELECT event_datetime FROM events WHERE date(event_datetime) = ? AND booking_id IS NULL", [dateStr], callback);
}
function getOtherEventsOnDate(dateStr, excludeId, callback) {
    db.all(
        `SELECT event_id, event_datetime, event_end_time FROM events
         WHERE date(event_datetime) = ? AND event_id != ? AND booking_id IS NULL
           AND event_status NOT IN ('cancelled', 'draft')`,
        [dateStr, excludeId], callback
    );
}

// ── Booking cancellation cascade (POPIA erasure / dedicated cancel route / applyStatusChange) ──
// 2 byte-identical call sites, both awaited as promises: POPIA erasure and the dedicated admin
// cancel route both look up the linked event's GCal id before demoting it.
function getEventByBookingId(bookingId) {
    return promisedGet(`SELECT event_id, google_calendar_event_id FROM events WHERE booking_id = ?`, [bookingId]);
}
// 2 byte-identical call sites (WHERE event_id = ?): POPIA erasure awaits this as a promise;
// applyStatusChange's CANCELLED branch fires it fire-and-forget with a callback. Two thin siblings.
function demoteEventForCancelledBooking(reason, eventId, callback) {
    db.run(
        "UPDATE events SET booking_id = NULL, event_status = 'draft', cancelled_at = CURRENT_TIMESTAMP, cancellation_reason = ? WHERE event_id = ?",
        [reason, eventId], callback
    );
}
function demoteEventForCancelledBookingAsync(reason, eventId) {
    return promised(
        "UPDATE events SET booking_id = NULL, event_status = 'draft', cancelled_at = CURRENT_TIMESTAMP, cancellation_reason = ? WHERE event_id = ?",
        [reason, eventId]
    );
}
// The dedicated admin cancel route's own variant — filters WHERE booking_id = ? instead of
// WHERE event_id = ?, a genuine difference (it matches by the event's own pointer so a pre-existing
// orphaned cross-reference still gets cleaned up), NOT consolidated with the pair above.
function demoteEventForCancelledBookingByBookingIdAsync(reason, bookingId) {
    return promised(
        "UPDATE events SET booking_id = NULL, event_status = 'draft', cancelled_at = CURRENT_TIMESTAMP, cancellation_reason = ? WHERE booking_id = ?",
        [reason, bookingId]
    );
}

// ── Venue editing (three independent endpoints touch events.venue_*) ──
// Unlink branch of PUT /api/admin/bookings/:id/venue.
function unlinkEventVenue(eventId, callback) {
    db.run(
        `UPDATE events SET
            venue_id = NULL, venue_map_link = NULL,
            modified_on = CURRENT_TIMESTAMP
         WHERE event_id = ?`,
        [eventId], callback
    );
}
// Legacy venue_id-link branch of PUT /api/admin/bookings/:id/venue. Same field list as
// updateEventVenueGoogleLink below but originally nested one indentation level deeper in
// server.js — per the whitespace-as-byte-identity precedent (bookings Stage 3), that in-situ
// difference means the two were NOT force-consolidated; kept as separate functions here too.
function updateEventVenueLegacyLink(venueName, venueId, mapLink, eventId, callback) {
    db.run(
        `UPDATE events SET
            venue_name = ?, venue_id = ?, venue_map_link = ?,
            modified_on = CURRENT_TIMESTAMP
         WHERE event_id = ?`,
        [venueName, venueId, mapLink, eventId], callback
    );
}
// PUT /api/admin/bookings/:id/venue-google's equivalent — see note on updateEventVenueLegacyLink.
function updateEventVenueGoogleLink(venueName, venueId, mapLink, eventId, callback) {
    db.run(
        `UPDATE events SET
            venue_name = ?, venue_id = ?, venue_map_link = ?,
            modified_on = CURRENT_TIMESTAMP
         WHERE event_id = ?`,
        [venueName, venueId, mapLink, eventId], callback
    );
}
// PATCH /api/admin/bookings/:id/venue (the free-text venue editor) — only 2 fields, no venue_id at
// all, a genuinely different column set from the two link functions above.
function updateEventVenueFreeText(venueName, mapLink, eventId, callback) {
    db.run(
        `UPDATE events SET venue_name = ?, venue_map_link = ?, modified_on = CURRENT_TIMESTAMP WHERE event_id = ?`,
        [venueName, mapLink, eventId], callback
    );
}

// ── Booking date-change propagation ──
// 2 byte-identical call sites: the booking date-change route and the event drag-reschedule route
// both sync an event's own datetime, both plain callback style.
function updateEventDatetime(newDatetime, eventId, callback) {
    db.run("UPDATE events SET event_datetime = ?, modified_on = CURRENT_TIMESTAMP WHERE event_id = ?", [newDatetime, eventId], callback);
}
function getEventForDragReschedule(eventId, callback) {
    db.get("SELECT event_datetime, booking_id FROM events WHERE event_id = ?", [eventId], callback);
}

// ── PUT /api/admin/bookings/:id/public (promote/demote a booking's public event listing) ──
function insertPublicEvent(eventTitle, eventDesc, eventDatetime, venueName, venueId, mapLink, ticketLink, bookingId, adminId, ipAddress, userAgent, callback) {
    db.run(
        `INSERT INTO events (
            event_title, event_description, event_datetime,
            venue_name, venue_id, venue_map_link, ticket_sales_link,
            booking_id, event_status, created_by,
            ip_address, user_agent
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)`,
        [eventTitle, eventDesc, eventDatetime, venueName, venueId, mapLink, ticketLink, bookingId, adminId, ipAddress, userAgent],
        callback
    );
}
function checkEventExistsById(eventId, callback) {
    db.get("SELECT event_id FROM events WHERE event_id = ?", [eventId], callback);
}
function updatePublicEvent(eventTitle, eventDesc, eventDatetime, venueName, venueId, mapLink, ticketLink, adminId, ipAddress, userAgent, eventId, callback) {
    db.run(
        `UPDATE events SET
            event_title = ?, event_description = ?, event_datetime = ?,
            venue_name = ?, venue_id = ?, venue_map_link = ?, ticket_sales_link = ?,
            modified_by = ?, modified_on = CURRENT_TIMESTAMP,
            ip_address = ?, user_agent = ?
         WHERE event_id = ?`,
        [eventTitle, eventDesc, eventDatetime, venueName, venueId, mapLink, ticketLink, adminId, ipAddress, userAgent, eventId],
        callback
    );
}
// 2 byte-identical call sites: this route's "toggle off" branch, and DELETE /api/admin/events/:id.
function deleteEventById(eventId, callback) {
    db.run("DELETE FROM events WHERE event_id = ?", [eventId], callback);
}

// ── Admin Events module CRUD (POST/PUT/DELETE /api/admin/events...) ──
function insertEventFull(eventTitle, eventDescription, eventDatetime, eventEndTime, eventType, venueName, venueId, venueMapLink, ticketSalesLink, posterImagePath, eventStatus, eventCapacity, bookingId, createdBy, ipAddress, userAgent, callback) {
    db.run(
        "INSERT INTO events (event_title, event_description, event_datetime, event_end_time, event_type, venue_name, venue_id, venue_map_link, ticket_sales_link, poster_image_path, event_status, event_capacity, booking_id, created_by, ip_address, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [eventTitle, eventDescription, eventDatetime, eventEndTime, eventType, venueName, venueId, venueMapLink, ticketSalesLink, posterImagePath, eventStatus, eventCapacity, bookingId, createdBy, ipAddress, userAgent],
        callback
    );
}
function linkEventToPlaceholderBooking(bookingId, eventId, callback) {
    db.run("UPDATE events SET booking_id = ? WHERE event_id = ?", [bookingId, eventId], callback);
}
function getEventForConflictEdit(eventId, callback) {
    db.get("SELECT event_datetime, booking_id AS old_booking_id, google_calendar_event_id FROM events WHERE event_id = ?", [eventId], callback);
}
function updateEventFull(eventTitle, eventDescription, eventDatetime, eventEndTime, eventType, venueName, venueId, venueMapLink, ticketSalesLink, posterImagePath, eventStatus, eventCapacity, cancellationReason, bookingId, modifiedBy, modifiedByRole, ipAddress, userAgent, eventId, callback) {
    db.run(
        "UPDATE events SET event_title = ?, event_description = ?, event_datetime = ?, event_end_time = ?, event_type = ?, venue_name = ?, venue_id = ?, venue_map_link = ?, ticket_sales_link = ?, poster_image_path = ?, event_status = ?, event_capacity = ?, cancellation_reason = ?, booking_id = ?, modified_by = ?, modified_by_role = ?, modified_on = CURRENT_TIMESTAMP, ip_address = ?, user_agent = ? WHERE event_id = ?",
        [eventTitle, eventDescription, eventDatetime, eventEndTime, eventType, venueName, venueId, venueMapLink, ticketSalesLink, posterImagePath, eventStatus, eventCapacity, cancellationReason, bookingId, modifiedBy, modifiedByRole, ipAddress, userAgent, eventId],
        callback
    );
}
function insertEventForDuplicate(eventTitle, eventDescription, eventDatetime, eventEndTime, eventType, venueName, venueId, venueMapLink, ticketSalesLink, posterImagePath, eventCapacity, createdBy, ipAddress, userAgent, callback) {
    db.run(
        `INSERT INTO events (event_title, event_description, event_datetime, event_end_time, event_type, venue_name,
            venue_id, venue_map_link, ticket_sales_link, poster_image_path, event_status, event_capacity,
            created_by, ip_address, user_agent)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)`,
        [eventTitle, eventDescription, eventDatetime, eventEndTime, eventType, venueName, venueId, venueMapLink, ticketSalesLink, posterImagePath, eventCapacity, createdBy, ipAddress, userAgent],
        callback
    );
}

// ── Public sitemap ──
// Pre-existing bug, relocated as-is (not fixed, per "housekeeping not improvement"): the real
// events columns are event_id/event_datetime, not id/date, so this has always errored and the
// sitemap route has always silently omitted events (its `if (!err && events)` guard just no-ops).
function getEventsForSitemap(callback) {
    db.all("SELECT id, created_at FROM events ORDER BY date DESC", [], callback);
}

module.exports = {
    // date_holds
    getDateHoldTimesForDay, getDateHoldsForAvailabilityCheck, getActiveHoldDatesForMonth,
    getActiveDateHoldsForEventConflict, getDateHoldsForDateConflict,
    getCalendarSyncHoldIds, deleteDateHoldByGoogleEventId, getCalendarSyncHoldDetails,
    updateDateHoldFromGoogleSync, insertDateHoldFromGoogleSync,
    getActiveDateHoldsForToday, getActiveDateHoldsForCalendarGrid, getActiveDateHoldsForIcsFeed,
    insertDateHold, deleteDateHoldById, getDateHoldTimesById, updateDateHoldDate,
    insertDateHoldForNewEvent, clearDateHoldEventId, updateDateHoldDateForBooking,
    releaseDateHoldsForBooking, releaseDateHoldsForBookingAsync,

    // events
    getEventGoogleCalendarIdsForSync, getEventById, setEventGoogleCalendarId,
    clearEventGoogleCalendarId, clearEventGoogleCalendarIdAsync, getEventGoogleCalendarId,
    advanceAutoCompletedEventS6, getPastStandaloneEventsForAutoComplete, advanceStandaloneEventCompleted,
    advanceEventToCompleted, insertAutoCreatedEvent,
    getUpcomingStandaloneEventOnDate, getOtherEventsOnDate,
    getEventByBookingId, demoteEventForCancelledBooking, demoteEventForCancelledBookingAsync,
    demoteEventForCancelledBookingByBookingIdAsync,
    unlinkEventVenue, updateEventVenueLegacyLink, updateEventVenueGoogleLink, updateEventVenueFreeText,
    updateEventDatetime, getEventForDragReschedule,
    insertPublicEvent, checkEventExistsById, updatePublicEvent, deleteEventById,
    insertEventFull, linkEventToPlaceholderBooking, getEventForConflictEdit, updateEventFull,
    insertEventForDuplicate,
    getEventsForSitemap,
};
