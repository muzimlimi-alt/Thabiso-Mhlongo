const express = require('express');
const moment = require('moment-timezone');
const db = require('../../database');
const { requireAdmin } = require('../../middleware/auth');
const { requireRole } = require('../../middleware/rbac');
const { addMinutesToTime, parseDurationToMinutes, timeRangesOverlap } = require('../../lib/time-utils');
const { resolveActor } = require('../../lib/actor');
const { deleteGoogleEvent } = require('../../lib/google-calendar');
const {
    hasCalendarConflict, syncBookingToCalendar, syncEventToCalendar
} = require('../../lib/calendar-sync');
const { sendDateChangedEmail } = require('../../lib/booking-notifications');
const {
    getBookingsOnDateForEventConflict, insertPlaceholderBookingForEvent,
    setBookingEventId, getBookingByIdSafeAsync, updateBookingDateFromEventEdit, clearBookingEventIdWhereEventId,
    setBookingDateAndStartTimeFromEvent, getBookingById
} = require('../../database/repositories/bookings.repository');
const {
    getActiveDateHoldsForEventConflict, getOtherEventsOnDate, insertEventFull, insertDateHoldForNewEvent,
    linkEventToPlaceholderBooking, getEventForConflictEdit,
    updateEventFull, clearEventGoogleCalendarId, getEventGoogleCalendarId, clearDateHoldEventId,
    deleteEventById, getEventForDragReschedule, updateEventDatetime, getEventById, insertEventForDuplicate
} = require('../../database/repositories/calendar.repository');
const router = express.Router();

// Phase 5 (HOUSEKEEPING-NOTES.md): moved from app.js verbatim, byte-identical — single-consumer
// within this file (nothing else in app.js referenced any of the three).
const VALID_EVENT_STATUSES = ['upcoming', 'draft', 'live', 'completed', 'cancelled', 'postponed', 'sold_out'];
const VALID_EVENT_TYPES = ['Corporate Event', 'Festival / Concert', 'Private Function', 'Comedy Club', 'University / College', 'Charity / Fundraiser', 'Virtual Event', 'Other', ''];

function checkEventConflicts(event_datetime, booking_id, excludeEventId, callback) {
    const eventDateStr = (event_datetime || '').split('T')[0];
    if (!eventDateStr || booking_id) return callback(null, false);
    // Extract event time if present (ISO datetime "YYYY-MM-DDTHH:MM...")
    const eventTime = (event_datetime && event_datetime.length > 10) ? event_datetime.substring(11, 16) : null;
    const eventEndTime = eventTime ? addMinutesToTime(eventTime, 60) : null; // assume 1-hour event duration
    const excludeId = excludeEventId || -1;

    getBookingsOnDateForEventConflict(eventDateStr, excludeId, (err, bRows) => {
            if (err) return callback(err);
            let conflict = false;
            if (bRows && bRows.length > 0) {
                if (!eventTime) {
                    conflict = true; // all-day event — any booking on same day is a conflict
                } else {
                    for (const b of bRows) {
                        if (!b.event_start_time) { conflict = true; break; }
                        const bEnd = b.performance_end_time ||
                            addMinutesToTime(b.event_start_time, parseDurationToMinutes(b.performance_duration));
                        if (timeRangesOverlap(eventTime, eventEndTime, b.event_start_time, bEnd)) { conflict = true; break; }
                    }
                }
            }
            if (conflict) return callback(null, true);

            getActiveDateHoldsForEventConflict(
                eventDateStr, excludeId, (err2, hRows) => {
                    if (err2) return callback(err2);
                    if (hRows && hRows.length > 0) {
                        if (!eventTime) {
                            conflict = true; // all-day event — any hold blocks
                        } else {
                            for (const h of hRows) {
                                if (!h.start_time) { conflict = true; break; }
                                const hEnd = h.end_time || addMinutesToTime(h.start_time, 60);
                                if (timeRangesOverlap(eventTime, eventEndTime, h.start_time, hEnd)) { conflict = true; break; }
                            }
                        }
                    }
                    if (conflict) return callback(null, true);

                    // Standalone events were never checked against each other here — only against
                    // bookings and holds — so two public events could silently double-book the same
                    // slot. Booking-linked events are excluded since the bookings query above already
                    // covers them (their date/time always mirrors their booking).
                    getOtherEventsOnDate(
                        eventDateStr, excludeId, (err3, eRows) => {
                            if (err3) return callback(err3);
                            if (eRows && eRows.length > 0) {
                                if (!eventTime) {
                                    conflict = true; // all-day event — any other event on the same day blocks
                                } else {
                                    for (const ev of eRows) {
                                        const evTime = ev.event_datetime && ev.event_datetime.length > 10 ? ev.event_datetime.substring(11, 16) : null;
                                        if (!evTime) { conflict = true; break; }
                                        // event_end_time is stored as a full "YYYY-MM-DDTHH:MM" datetime
                                        // (or a legacy bare "HH:MM") - timeRangesOverlap needs HH:MM only.
                                        let evEnd = ev.event_end_time;
                                        if (evEnd && evEnd.includes('T')) evEnd = evEnd.substring(11, 16);
                                        if (!evEnd || !/^\d{2}:\d{2}$/.test(evEnd)) evEnd = addMinutesToTime(evTime, 60);
                                        if (timeRangesOverlap(eventTime, eventEndTime, evTime, evEnd)) { conflict = true; break; }
                                    }
                                }
                            }
                            callback(null, conflict);
                        }
                    );
                }
            );
        }
    );
}

// --- Events ---
router.get('/api/admin/events', requireAdmin, (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 200, 500);
    const offset = parseInt(req.query.offset) || 0;
    const status = req.query.status || null;
    // Same public/private distinction as GET /api/public/events (see comment there) — without it,
    // this tab (and the dashboard KPI tile reading it) mixed every private CONFIRMED booking's
    // auto-generated calendar shadow row in with genuine public tour-date listings, so neither the
    // count nor the list actually reflected "public shows." Pass include_private=1 to see everything
    // (e.g. for troubleshooting a specific booking's shadow row).
    const includePrivate = req.query.include_private === '1';
    const conditions = includePrivate ? [] : ['(e.booking_id IS NULL OR b.is_public = 1)'];
    if (status) conditions.push('e.event_status = ?');
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const params = status ? [status, limit, offset] : [limit, offset];
    db.all(
        `SELECT e.* FROM events e LEFT JOIN bookings b ON b.id = e.booking_id
         ${where} ORDER BY e.event_datetime DESC LIMIT ? OFFSET ?`,
        params, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

router.post('/api/admin/events', requireAdmin, (req, res) => {
    const { event_title, event_description, event_datetime, event_end_time, event_type, venue_name, venue_id, venue_map_link, ticket_sales_link, poster_image_path, event_status, event_capacity, booking_id, block_type } = req.body;
    const ip_address = req.ip || req.connection.remoteAddress || 'unknown';
    const user_agent = req.get('User-Agent') || 'unknown';

    // Input validation
    if (!event_title || !event_title.trim()) return res.status(400).json({ success: false, error: 'event_title is required' });
    if (!event_datetime) return res.status(400).json({ success: false, error: 'event_datetime is required' });
    if (!/^\d{4}-\d{2}-\d{2}/.test(event_datetime)) return res.status(400).json({ success: false, error: 'event_datetime must be ISO format (YYYY-MM-DD...)' });
    if (event_status && !VALID_EVENT_STATUSES.includes(event_status)) return res.status(400).json({ success: false, error: 'Invalid event_status value' });
    if (event_type && !VALID_EVENT_TYPES.includes(event_type)) return res.status(400).json({ success: false, error: 'Invalid event_type value' });

    const eventDateStr = (event_datetime || '').split('T')[0];

    checkEventConflicts(event_datetime, booking_id, null, (err, hasConflict) => {
        if (err) return res.status(500).json({ success: false, error: 'Conflict check failed: ' + err.message });
        if (hasConflict) return res.status(409).json({ success: false, message: 'Calendar conflict: The selected date is already booked or held.' });

        insertEventFull(
            event_title, event_description, event_datetime, event_end_time || null, event_type || null, venue_name, venue_id || null, venue_map_link, ticket_sales_link, poster_image_path, event_status || 'upcoming', event_capacity || null, booking_id || null, req.session.adminId, ip_address, user_agent,
            async function(err) {
                if (err) return res.status(500).json({ success: false, error: err.message });
                const newEventId = this.lastID;

                if (booking_id) {
                    setBookingEventId(newEventId, booking_id);
                }

                if (block_type === 'hold') {
                    insertDateHoldForNewEvent(eventDateStr, `Hold for ${event_title}`, newEventId);
                } else if (block_type === 'booking') {
                    // cell/event_location/event_type/message are all NOT NULL with no default - the
                    // original INSERT omitted them, so this branch had silently thrown a NOT NULL
                    // constraint error and created no booking at all, every single time, since day one.
                    insertPlaceholderBookingForEvent(
                        ['Placeholder', 'placeholder@example.com', '0000000000', eventDateStr, event_title, venue_name || 'TBD', event_type || 'Other', `Calendar placeholder for event: ${event_title}`, 'PENDING', newEventId],
                        function(bkErr) {
                        if (bkErr) { console.error('[Events] Placeholder booking insert failed:', bkErr.message); return; }
                        // bookings.event_id was set above, but the reverse events.booking_id link was
                        // never written back - every later lookup that finds a booking FROM its event
                        // (cancel/complete/venue-sync cascades all do "WHERE booking_id = ?") silently
                        // found nothing for a placeholder created this way.
                        linkEventToPlaceholderBooking(this.lastID, newEventId);
                    });
                }

                let gcalSynced = false;
                if (req.body.sync_to_gcal !== false) {
                    try { gcalSynced = !!(await syncEventToCalendar(newEventId)); }
                    catch(e) { console.error('GCal sync error:', e); }
                }
                const actor = await resolveActor(req.session.adminId);
                res.json({ success: true, id: newEventId, message: 'Event added successfully', gcal_synced: gcalSynced, last_updated: { name: actor.name, role: actor.role, at: new Date().toISOString() } });
            });
    });
});

router.put('/api/admin/events/:id', requireAdmin, (req, res) => {
    const { event_title, event_description, event_datetime, event_end_time, event_type, venue_name, venue_id, venue_map_link, ticket_sales_link, poster_image_path, event_status, event_capacity, cancellation_reason, booking_id } = req.body;
    const ip_address = req.ip || req.connection.remoteAddress || 'unknown';
    const user_agent = req.get('User-Agent') || 'unknown';
    const eventId = req.params.id;

    if (!event_title || !event_title.trim()) return res.status(400).json({ success: false, error: 'event_title is required' });
    if (event_status && !VALID_EVENT_STATUSES.includes(event_status)) return res.status(400).json({ success: false, error: 'Invalid event_status value' });
    if (event_type && !VALID_EVENT_TYPES.includes(event_type)) return res.status(400).json({ success: false, error: 'Invalid event_type value' });

    // Read the old row first — checkEventConflicts() deliberately no-ops whenever booking_id is set
    // (on the assumption the booking's own creation path already checked), so a booking-linked event
    // edited through this full-edit form had NO conflict re-check at all if its date changed here.
    // Mirrors the same guard PATCH /api/admin/events/:id/date already applies for the drag-reschedule case.
    getEventForConflictEdit(eventId, async (selErr, oldRow) => {
        if (selErr || !oldRow) return res.status(404).json({ success: false, error: 'Event not found' });
        const resolvedBookingIdForCheck = booking_id || oldRow.old_booking_id;
        const dateChanged = event_datetime && event_datetime !== oldRow.event_datetime;

        if (resolvedBookingIdForCheck && dateChanged) {
            const booking = await getBookingByIdSafeAsync(resolvedBookingIdForCheck);
            if (booking && !['CANCELLED', 'EXPIRED', 'COMPLETED'].includes((booking.status || '').toUpperCase())) {
                const datePart = event_datetime.substring(0, 10);
                const timePart = event_datetime.length >= 16 ? event_datetime.substring(11, 16) : (booking.event_start_time || '00:00');
                const startISO = moment(`${datePart} ${timePart}`).toISOString();
                const durMins = (booking.performance_end_time && booking.event_start_time)
                    ? Math.max(30, moment(`2000-01-01 ${booking.performance_end_time}`).diff(moment(`2000-01-01 ${booking.event_start_time}`), 'minutes'))
                    : parseDurationToMinutes(booking.performance_duration);
                const endISO = moment(startISO).add(durMins, 'minutes').toISOString();
                const busy = await hasCalendarConflict(startISO, endISO, parseInt(resolvedBookingIdForCheck));
                if (busy) return res.status(409).json({ success: false, message: `That date/time conflicts with another booking or hold. Choose a different date/time.` });
            }
        } else if (!resolvedBookingIdForCheck) {
            const conflictCheck = await new Promise(r => checkEventConflicts(event_datetime, booking_id, eventId, (e, hasConflict) => r({ e, hasConflict })));
            if (conflictCheck.e) return res.status(500).json({ success: false, error: 'Conflict check failed: ' + conflictCheck.e.message });
            if (conflictCheck.hasConflict) return res.status(409).json({ success: false, message: 'Calendar conflict: The selected date is already booked or held.' });
        }

        updateEventFull(
            event_title, event_description, event_datetime, event_end_time || null, event_type || null, venue_name, venue_id || null, venue_map_link, ticket_sales_link, poster_image_path, event_status, event_capacity || null, cancellation_reason || null, booking_id || null, req.session.adminId, req.session.role || null, ip_address, user_agent, eventId,
            async function(err) {
                if (err) return res.status(500).json({ success: false, error: err.message });
                const actor = await resolveActor(req.session.adminId);
                const resolvedBookingId = booking_id || (oldRow && oldRow.old_booking_id);
                if (resolvedBookingId) {
                    setBookingEventId(eventId, resolvedBookingId);
                    // Sync booking date if event_datetime changed
                    if (event_datetime && oldRow && event_datetime !== oldRow.event_datetime) {
                        const datePart = event_datetime.substring(0, 10);
                        const timePart = event_datetime.length >= 16 ? event_datetime.substring(11, 16) : null;
                        updateBookingDateFromEventEdit(datePart, timePart, resolvedBookingId);
                    }
                }
                let gcalSynced = false;
                if (event_status === 'cancelled') {
                    // Cancelling should drop the calendar hold entirely, not leave a stale entry
                    // sitting on the calendar as if the event were still on. This runs regardless of
                    // sync_to_gcal - every cancel path (single edit, the Cancel-event modal, bulk
                    // cancel) previously passed sync_to_gcal:false specifically to skip a plain sync,
                    // which also skipped this cleanup since it lived inside that same branch.
                    if (oldRow.google_calendar_event_id) {
                        // Matches the booking-cancellation pattern: null the local tracking column
                        // unconditionally rather than gating it behind the network call's success, so
                        // our own state can't be left stale forever by a transient Google API failure.
                        deleteGoogleEvent(oldRow.google_calendar_event_id).catch(e => console.error('GCal delete error:', e));
                        clearEventGoogleCalendarId(eventId);
                    }
                } else if (req.body.sync_to_gcal !== false) {
                    try { gcalSynced = !!(await syncEventToCalendar(eventId)); }
                    catch(e) { console.error('GCal sync error:', e); }
                }
                res.json({ success: true, message: 'Event updated', gcal_synced: gcalSynced, last_updated: { name: actor.name, role: actor.role, at: new Date().toISOString() } });
            });
    });
});

router.delete('/api/admin/events/:id', requireAdmin, requireRole(['administrator']), (req, res) => {
    getEventGoogleCalendarId(req.params.id, (selErr, evRow) => {
        // Null out any booking that references this event before deleting to prevent dangling FK
        clearBookingEventIdWhereEventId(req.params.id, () => {
            // date_holds.event_id was left unhandled here - with foreign_keys=ON (see database.js),
            // deleting an event that still had a hold referencing it (from block_type:'hold' at
            // creation) threw a bare FOREIGN KEY constraint error instead of deleting.
            clearDateHoldEventId(req.params.id, () => {
                deleteEventById(req.params.id, function(err) {
                    if (err) return res.status(500).json({ success: false, error: err.message });
                    res.json({ success: true, message: 'Event deleted' });
                    if (evRow && evRow.google_calendar_event_id) {
                        deleteGoogleEvent(evRow.google_calendar_event_id).catch(e => console.error('GCal delete error:', e));
                    }
                });
            });
        });
    });
});

// Drag-drop date update for public events on the calendar
router.patch('/api/admin/events/:id/date', requireAdmin, async (req, res) => {
    const { date, time } = req.body;
    if (!date) return res.status(400).json({ success: false, message: 'date is required' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ success: false, message: 'date must be YYYY-MM-DD' });
    const eventId = req.params.id;
    const row = await new Promise(r => getEventForDragReschedule(eventId, (e, x) => r(e ? null : x)));
    if (!row) return res.status(404).json({ success: false, message: 'Event not found' });
    const existingTime = time || (row.event_datetime || '').split('T')[1] || '00:00';
    const newDatetime = date + 'T' + existingTime;

    // L1: for a booking-linked event, re-check calendar conflicts before moving it — the same
    // guard the booking date-change endpoint (PATCH /bookings/:id/date) applies — so dragging an
    // event on the calendar can't silently create a double-booking. Terminal bookings are skipped.
    if (row.booking_id) {
        const booking = await getBookingByIdSafeAsync(row.booking_id);
        if (booking && !['CANCELLED', 'EXPIRED', 'COMPLETED'].includes((booking.status || '').toUpperCase())) {
            const startISO = moment(`${date} ${existingTime.substring(0, 5)}`).toISOString();
            const durMins = (booking.performance_end_time && booking.event_start_time)
                ? Math.max(30, moment(`2000-01-01 ${booking.performance_end_time}`).diff(moment(`2000-01-01 ${booking.event_start_time}`), 'minutes'))
                : parseDurationToMinutes(booking.performance_duration);
            const endISO = moment(startISO).add(durMins, 'minutes').toISOString();
            const busy = await hasCalendarConflict(startISO, endISO, parseInt(row.booking_id));
            if (busy) return res.status(409).json({ success: false, message: `That slot on ${date} conflicts with another booking or hold. Choose a different date/time.` });
        }
    }

    {
        updateEventDatetime(
            newDatetime, eventId,
            function(updateErr) {
                if (updateErr) return res.status(500).json({ success: false, error: updateErr.message });
                const oldDate = (row.event_datetime || '').split('T')[0];
                if (row.booking_id) {
                    setBookingDateAndStartTimeFromEvent(
                        date, existingTime.substring(0, 5), row.booking_id,
                        () => {
                            // Notify booking client of date change
                            getBookingById(row.booking_id, (bErr, booking) => {
                                if (!bErr && booking) {
                                    if (booking.email && oldDate !== date) {
                                        sendDateChangedEmail(booking, oldDate, date)
                                            .catch(e => console.error('[Event Date Change] Client email failed:', e.message));
                                    }
                                    // E2: keep the booking's Google Calendar event in sync with the moved
                                    // date — the booking date changed above but its GCal event would
                                    // otherwise stay on the old date (calendar drift).
                                    syncBookingToCalendar(booking)
                                        .catch(e => console.error('[Event Date Change] Calendar sync failed:', e.message));
                                }
                            });
                        }
                    );
                }
                // The event's own google_calendar_event_id is a separate GCal entry from the
                // booking's (see events.google_calendar_event_id vs bookings.google_event_id) -
                // syncBookingToCalendar() above only refreshes the booking's copy. Without this,
                // every calendar-drag reschedule of a public event left its own GCal entry on the
                // old date, and a standalone (non-booking) event never got re-synced at all.
                syncEventToCalendar(eventId).catch(e => console.error('[Event Date Change] Event GCal sync failed:', e.message));
                res.json({ success: true, event_datetime: newDatetime });
            }
        );
    }
});

// Duplicate an event (copy all fields, reset status to draft, append " (Copy)" to title)
router.post('/api/admin/events/:id/duplicate', requireAdmin, (req, res) => {
    getEventById(req.params.id, (err, row) => {
        if (err) return res.status(500).json({ success: false, error: err.message });
        if (!row) return res.status(404).json({ success: false, message: 'Event not found' });
        const newTitle = (row.event_title || 'Event') + ' (Copy)';
        insertEventForDuplicate(
            newTitle, row.event_description, row.event_datetime, row.event_end_time, row.event_type,
            row.venue_name, row.venue_id, row.venue_map_link, row.ticket_sales_link, row.poster_image_path,
            row.event_capacity, req.session.adminId, req.ip || 'unknown', req.get('User-Agent') || 'unknown',
            function(insErr) {
                if (insErr) return res.status(500).json({ success: false, error: insErr.message });
                res.json({ success: true, id: this.lastID, message: 'Event duplicated as draft' });
            }
        );
    });
});

module.exports = router;
