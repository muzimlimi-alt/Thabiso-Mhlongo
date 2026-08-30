// Phase 5 (HOUSEKEEPING-NOTES.md): relocated from app.js verbatim. The Google Calendar sync/
// booking-conflict engine — deliberately deferred until last in the bookings/events pass (real
// external API calls, booking-conflict business rules with financial consequences). Every
// dependency traced individually before this file was written: all five functions turned out to be
// fully self-contained once assembled — Phase 4's `calendar` repository domain had already pulled
// every DB access out from underneath them, leaving only orchestration logic against already-leaf
// modules (lib/google-calendar.js, lib/time-utils.js, lib/booking-config.js) and existing Phase 4
// repository functions (bookings.repository.js, calendar.repository.js). No new repository work
// needed. Every one of these five has remaining callers scattered across the still-deferred
// bookings/events routes and app.js's own startup wiring (syncCalendarHolds) — app.js re-imports
// all five.
const db = require('../database');
const moment = require('moment-timezone');
const { calendar, CALENDAR_ID } = require('./google-calendar');
const { addMinutesToTime, timeRangesOverlap, parseDurationToMinutes } = require('./time-utils');
const { bookingConfig } = require('./booking-config');
const {
    getBookingsOnDateForCalendarConflict, setBookingGoogleEventId, getBookingsWithGoogleEventIdAsync
} = require('../database/repositories/bookings.repository');
const {
    getDateHoldTimesForDay, getCalendarSyncHoldIds, deleteDateHoldByGoogleEventId,
    getCalendarSyncHoldDetails, getEventGoogleCalendarIdsForSync, updateDateHoldFromGoogleSync,
    insertDateHoldFromGoogleSync, setEventGoogleCalendarId, getEventById
} = require('../database/repositories/calendar.repository');

/**
 * Check whether a timed booking falls within configured working hours for that day.
 * Fails open (allows) if no working_hours row exists for that day.
 */
async function isWithinWorkingHours(dateStr, startHHMM, endHHMM) {
    const dayOfWeek = new Date(dateStr + 'T12:00:00').getDay();
    return new Promise((resolve) => {
        db.get(
            'SELECT start_time, end_time, is_working_day FROM working_hours WHERE day_of_week = ?',
            [dayOfWeek],
            (err, wh) => {
                if (err || !wh) return resolve({ allowed: true }); // fail open if no config
                const DAY_NAMES = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
                if (!wh.is_working_day) {
                    return resolve({ allowed: false, reason: `Bookings are not available on ${DAY_NAMES[dayOfWeek]}.` });
                }
                const toMins = (timeStr) => {
                    const [h, m] = timeStr.split(':').map(Number);
                    return h * 60 + m;
                };
                const startMins = toMins(startHHMM);
                let endMins = toMins(endHHMM);
                if (endMins < startMins) {
                    endMins += 1440;
                }
                const whStartMins = toMins(wh.start_time);
                const whEndMins = wh.end_time === '00:00' ? 1440 : toMins(wh.end_time);

                if (startMins < whStartMins) {
                    return resolve({ allowed: false, reason: `Bookings cannot start before ${wh.start_time}.` });
                }
                if (endMins > whEndMins) {
                    return resolve({ allowed: false, reason: `Bookings must end by ${wh.end_time === '00:00' ? '00:00' : wh.end_time}.` });
                }
                resolve({ allowed: true });
            }
        );
    });
}

async function hasCalendarConflict(startTime, endTime, excludeBookingId, skipGoogle) {
    try {
        const targetDate = startTime.split('T')[0];
        const reqStart = moment(startTime).format('HH:mm'); // Local time formatting (HH:MM)
        const reqEnd   = moment(endTime).format('HH:mm');

        // 1. Check local date_holds — time-aware, respects hold_expires_at
        const holdConflict = await new Promise((resolve) => {
            getDateHoldTimesForDay(
                targetDate,
                (err, holds) => {
                    // Fail-open on a DB error, but no longer SILENTLY — a failed holds read means the
                    // hold half of conflict detection didn't run, so a double-booking could slip through.
                    if (err) { console.error(`[hasCalendarConflict] date_holds read failed for ${targetDate} — conflict check degraded (failing open):`, err.message); return resolve(false); }
                    if (!holds) return resolve(false);
                    for (const h of holds) {
                        if (!h.start_time) return resolve(true); // all-day hold blocks entire day
                        const hEnd = h.end_time || addMinutesToTime(h.start_time, 60);
                        if (timeRangesOverlap(reqStart, reqEnd, h.start_time, hEnd)) return resolve(true);
                    }
                    resolve(false);
                }
            );
        });
        if (holdConflict) return true;

        // 2. Check existing bookings on the same day for time overlap
        const bookingConflict = await new Promise((resolve) => {
            const excludeClause = excludeBookingId ? ' AND id != ?' : '';
            const params = excludeBookingId
                ? [targetDate, excludeBookingId]
                : [targetDate];
            getBookingsOnDateForCalendarConflict(
                excludeClause,
                params,
                (err, bookings) => {
                    // Same fail-open, now logged: a failed bookings read means the booking-overlap half
                    // of conflict detection didn't run.
                    if (err) { console.error(`[hasCalendarConflict] bookings read failed for ${targetDate} — conflict check degraded (failing open):`, err.message); return resolve(false); }
                    if (!bookings) return resolve(false);
                    for (const b of bookings) {
                        // A booking with no recorded start time (e.g. an "All Day / Custom Hours"
                        // request) occupies the whole day — treat it the same as an untimed hold
                        // above rather than silently skipping it.
                        if (!b.event_start_time) return resolve(true);
                        const bEnd = b.performance_end_time ||
                            addMinutesToTime(b.event_start_time, parseDurationToMinutes(b.performance_duration));
                        const gap = (b.buffer_minutes != null) ? b.buffer_minutes
                            : (b.event_type && bookingConfig.typeBuffers[b.event_type] !== undefined) ? bookingConfig.typeBuffers[b.event_type]
                            : bookingConfig.minGapMins;
                        const bufferedEnd = addMinutesToTime(bEnd, gap);
                        if (timeRangesOverlap(reqStart, reqEnd, b.event_start_time, bufferedEnd)) return resolve(true);
                    }
                    resolve(false);
                }
            );
        });
        if (bookingConflict) return true;

        // 3. Check Google Calendar (if configured).
        // skipGoogle=true is used for the in-transaction re-check so we don't hold a
        // BEGIN IMMEDIATE write lock open during a network round-trip; the local
        // holds+bookings checks above are sufficient to close the concurrent-booking race.
        if (!skipGoogle && typeof calendar !== 'undefined' && CALENDAR_ID) {
            try {
                const response = await calendar.freebusy.query({
                    requestBody: {
                        timeMin: startTime,
                        timeMax: endTime,
                        items: [{ id: CALENDAR_ID }]
                    }
                }, {
                    timeout: 1500
                });
                const busy = response.data.calendars[CALENDAR_ID].busy;
                if (busy && busy.length > 0) return true;
            } catch (gcalErr) {
                console.error('[hasCalendarConflict] Google Calendar check failed (non-blocking):', gcalErr.message);
            }
        }

        return false;
    } catch (error) {
        // Fail open, but loudly: an unexpected error here means NO conflict check ran, so the caller
        // will treat the slot as free. Better to occasionally double-book than to block all bookings,
        // but the operator needs to know conflict detection degraded.
        console.error('[hasCalendarConflict] check failed entirely — treating slot as FREE (failing open). Double-booking possible until resolved:', error && error.message);
        return false;
    }
}

/**
 * Creates or updates a Google Calendar event for a booking
 * @param {number|object} bookingOrId - Booking ID or booking object
 * @returns {Promise<string|null>} - The Google Event ID
 */
async function syncBookingToCalendar(bookingOrId) {
    return new Promise((resolve, reject) => {
        const getBooking = (id) => new Promise((res, rej) => {
            db.get("SELECT * FROM bookings WHERE id = ?", [id], (err, row) => err ? rej(err) : res(row));
        });

        const processSync = async (booking) => {
            if (!booking) return resolve(null);

            // Fetch services to calculate duration
            const bookingServices = await new Promise((res, rej) => {
                db.all(`SELECT bs.*, s.setup_time_minutes, s.performance_length_minutes
                        FROM booking_services bs
                        JOIN services s ON bs.service_id = s.id
                        WHERE bs.booking_id = ?`, [booking.id], (err, rows) => err ? rej(err) : res(rows));
            });

            let totalMins = 0;
            if (bookingServices && bookingServices.length > 0) {
                bookingServices.forEach(bs => {
                    totalMins += (bs.setup_time_minutes || 0) + (bs.performance_length_minutes || 0);
                });
            }
            if (totalMins === 0) totalMins = 120; // Fallback to 2 hours

            const start = moment(`${booking.date} ${booking.event_start_time || '18:00'}`).toISOString();
            const end = moment(start).add(totalMins, 'minutes').toISOString();

            const eventData = {
                summary: `[${booking.status.toUpperCase()}] Thabiso Mhlongo: ${booking.event_type || 'Performance'}`,
                location: booking.event_location || booking.venue_address || 'TBD',
                description: `Client: ${booking.name}\nEmail: ${booking.email}\nPhone: ${booking.cell}\n\nNotes: ${booking.message || 'No notes'}`,
                start: { dateTime: start, timeZone: 'Africa/Johannesburg' },
                end: { dateTime: end, timeZone: 'Africa/Johannesburg' },
                colorId: booking.status === 'Confirmed' ? '10' : '5' // Green for confirmed, Yellow for pending/hold
            };

            try {
                if (booking.google_event_id) {
                    await calendar.events.update({
                        calendarId: CALENDAR_ID,
                        eventId: booking.google_event_id,
                        requestBody: eventData
                    });
                    console.log(`✓ Updated GCal Event for Booking #${booking.id}`);
                    resolve(booking.google_event_id);
                } else {
                    const response = await calendar.events.insert({
                        calendarId: CALENDAR_ID,
                        requestBody: eventData
                    });
                    const eventId = response.data.id;
                    setBookingGoogleEventId(eventId, booking.id);
                    console.log(`✓ Created GCal Event for Booking #${booking.id}: ${eventId}`);
                    resolve(eventId);
                }
            } catch (error) {
                console.error(`Error syncing booking #${booking.id} to GCal:`, error);
                resolve(null);
            }
        };

        if (typeof bookingOrId === 'object') {
            processSync(bookingOrId);
        } else {
            getBooking(bookingOrId).then(processSync).catch(reject);
        }
    });
}

async function syncCalendarHolds() {
    if (typeof calendar === 'undefined' || !CALENDAR_ID) return;

    try {
        const response = await calendar.events.list({
            calendarId: CALENDAR_ID,
            timeMin: new Date().toISOString(),
            timeMax: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(), // 3 months
            singleEvents: true,
            orderBy: 'startTime',
        });

        const events = response.data.items || [];

        // 1. Construct a set of active Google Calendar event IDs
        const gcalEventIds = new Set(events.map(e => e.id));

        // 2. Fetch all calendar sync holds from the database
        const calendarSyncHolds = await new Promise((resolve) => {
            getCalendarSyncHoldIds((err, rows) => resolve(rows || []));
        });

        // 3. Delete any local holds that are no longer present on Google Calendar
        for (const hold of calendarSyncHolds) {
            if (!gcalEventIds.has(hold.google_event_id)) {
                await new Promise((res) => {
                    deleteDateHoldByGoogleEventId(hold.google_event_id, () => res());
                });
                console.log(`✓ Deleted orphaned calendar hold for GCal event ${hold.google_event_id}`);
            }
        }

        if (events.length === 0) return;

        // Fetch existing IDs to avoid duplicates
        const existingHolds = await new Promise((resolve) => {
            getCalendarSyncHoldDetails((err, rows) => resolve(rows || []));
        });
        const existingBookings = await getBookingsWithGoogleEventIdAsync();
        const existingEvs = await new Promise((resolve) => {
            getEventGoogleCalendarIdsForSync((err, rows) => resolve(rows || []));
        });

        const localSyncedIds = new Set([
            ...existingBookings.map(r => r.google_event_id),
            ...existingEvs.map(r => r.google_calendar_event_id)
        ]);
        const existingHoldsMap = new Map(existingHolds.map(h => [h.google_event_id, h]));

        for (const event of events) {
            if (localSyncedIds.has(event.id)) continue;

            const start = event.start.dateTime || event.start.date;
            const end = event.end.dateTime || event.end.date;

            const date = start.slice(0, 10);
            let startTime = null;
            let endTime = null;

            if (event.start.dateTime) {
                startTime = start.slice(11, 16);
                endTime = end.slice(11, 16);
            }

            if (existingHoldsMap.has(event.id)) {
                // If it exists, check if details changed and update if they have
                const dbHold = existingHoldsMap.get(event.id);
                if (dbHold.hold_date !== date || dbHold.start_time !== startTime || dbHold.end_time !== endTime) {
                    updateDateHoldFromGoogleSync(
                        date, startTime, endTime, event.summary || 'Google Calendar Event', event.id,
                        (err) => {
                            if (err) console.error(`Failed to update calendar hold for event ${event.id}:`, err.message);
                            else console.log(`✓ Updated local calendar hold for event ${event.id}: ${date} ${startTime || ''}-${endTime || ''}`);
                        }
                    );
                }
            } else {
                // It's a new foreign event!
                insertDateHoldFromGoogleSync(
                    date, event.summary || 'Google Calendar Event', startTime, endTime, event.id,
                    (err) => {
                        if (err) console.error(`Failed to insert calendar hold for event ${event.id}:`, err.message);
                        else console.log(`✓ Synced GCal event ${event.id} as hold on ${date}`);
                    }
                );
            }
        }
    } catch (error) {
        console.error('Error syncing calendar holds:', error);
    }
}

async function syncEventToCalendar(eventId) {
    return new Promise((resolve) => {
        getEventById(eventId, async (err, ev) => {
            if (err || !ev) return resolve(null);

            const startDt = ev.event_datetime
                ? moment(ev.event_datetime).tz('Africa/Johannesburg')
                : moment().tz('Africa/Johannesburg');
            const endDt = startDt.clone().add(2, 'hours');

            const eventData = {
                summary: `[PUBLIC] ${ev.event_title || 'Event'}`,
                location: ev.venue_name || '',
                description: [
                    ev.event_description || '',
                    ev.ticket_sales_link ? `Tickets: ${ev.ticket_sales_link}` : '',
                    ev.venue_map_link ? `Map: ${ev.venue_map_link}` : ''
                ].filter(Boolean).join('\n'),
                start: { dateTime: startDt.toISOString(), timeZone: 'Africa/Johannesburg' },
                end:   { dateTime: endDt.toISOString(),   timeZone: 'Africa/Johannesburg' },
                colorId: '11'
            };

            try {
                if (ev.google_calendar_event_id) {
                    await calendar.events.update({
                        calendarId: CALENDAR_ID,
                        eventId: ev.google_calendar_event_id,
                        requestBody: eventData
                    });
                    console.log(`✓ Updated GCal Event for Event #${eventId}`);
                    resolve(ev.google_calendar_event_id);
                } else {
                    const response = await calendar.events.insert({
                        calendarId: CALENDAR_ID,
                        requestBody: eventData
                    });
                    const gcalId = response.data.id;
                    setEventGoogleCalendarId(gcalId, eventId);
                    console.log(`✓ Created GCal Event for Event #${eventId}: ${gcalId}`);
                    resolve(gcalId);
                }
            } catch (error) {
                console.error(`Error syncing event #${eventId} to GCal:`, error);
                resolve(null);
            }
        });
    });
}

module.exports = {
    isWithinWorkingHours, hasCalendarConflict, syncBookingToCalendar, syncCalendarHolds, syncEventToCalendar
};
