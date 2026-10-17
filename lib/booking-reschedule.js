// The one place a booking's date / start time (and, optionally, end time) is moved. The logic is the body of PATCH /api/admin/bookings/:id/date, moved here unchanged so that
// the calendar drag-and-drop and "use the Microsoft 365 time" (lib/calendar-m365.js, resolving an edit made in Outlook) apply exactly the same rules: conflict check against
// other bookings / holds / events, quote-expiry adjustment, hold + linked-event follow the date, audit row, calendar re-sync, client e-mail. Nothing here is specific to Microsoft.
'use strict';
const moment = require('moment-timezone');
const db = require('../database');
const { hasCalendarConflict, syncBookingToCalendar, checkDateAvailability } = require('./calendar-sync');
const { addMinutesToTime, parseDurationToMinutes } = require('./time-utils');
const { sendDateChangedEmail } = require('./booking-notifications');
const { getBookingByIdAsync, updateBookingDateAndTimeFields, getBookingById } = require('../database/repositories/bookings.repository');
const { updateDateHoldDateForBooking, updateEventDatetime } = require('../database/repositories/calendar.repository');

const minutesOf = (hhmm) => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + m; };

/**
 * Moves a booking to `date` (YYYY-MM-DD). `time` (HH:MM, '' = no start time / all day) is optional: left undefined, the time is untouched.
 * `endTime` is optional and only the Microsoft 365 path passes it: when given, it becomes the booking's end time as it is (the drag path keeps the old duration).
 * `notifyWhenDateUnchanged` (default true, the original behaviour) - false skips the client "date changed" e-mail when only the time moved.
 * Resolves { ok:true, newDate, newTime } or { ok:false, status, message }. Throws on a database failure (callers answer 500).
 */
async function rescheduleBooking({ bookingId, date, time, endTime, actorId = null, notifyWhenDateUnchanged = true }) {
    const row = await getBookingByIdAsync(bookingId);
    if (!row) return { ok: false, status: 404, message: 'Booking not found.' };

    const oldDate = row.date;
    const oldTime = row.event_start_time;

    // Determine effective start/end times for conflict checking
    const effectiveTime = time !== undefined ? time : row.event_start_time;
    if (effectiveTime) {
        let durationMins;
        if (endTime) {
            const span = minutesOf(endTime) - minutesOf(effectiveTime);
            durationMins = Math.max(span > 0 ? span : span + 24 * 60, 30);          // an end before the start means after midnight
        } else if (row.performance_end_time) {
            const [eh, em] = row.performance_end_time.split(':').map(Number);
            const [sh, sm] = row.event_start_time.split(':').map(Number);
            durationMins = Math.max((eh * 60 + em) - (sh * 60 + sm), 30);
        } else {
            durationMins = parseDurationToMinutes(row.performance_duration);
        }
        const newStartISO = moment(`${date} ${effectiveTime}`).toISOString();
        const newEndISO   = moment(newStartISO).add(durationMins, 'minutes').toISOString();
        const busy = await hasCalendarConflict(newStartISO, newEndISO, parseInt(bookingId));
        if (busy) {
            return { ok: false, status: 409, message: `The new time slot on ${date} conflicts with an existing booking or block. Choose a different date/time.` };
        }
    } else {
        // No time on this booking (an "All Day / Custom Hours" request) and none supplied in
        // the move — it occupies the whole destination day, so ANY existing hold/event/booking
        // there is a conflict. This branch used to be skipped entirely whenever effectiveTime
        // was falsy, so an untimed booking could be dragged onto an already-fully-booked day
        // with no warning.
        const destAvail = await new Promise((resolve, reject) =>
            checkDateAvailability(date, (e, r) => e ? reject(e) : resolve(r), parseInt(bookingId)));
        if (!destAvail.available || (destAvail.busy_ranges && destAvail.busy_ranges.length > 0)) {
            return { ok: false, status: 409, message: `${date} already has a booking or block on it and is not available for a full-day booking. Choose a different date.` };
        }
    }

    // Build update
    let newQuoteExpiry = row.quote_expiry_date;
    if (row.quote_expiry_date) {
        const eventMoment = moment(date);
        const currentExpiry = moment(row.quote_expiry_date);
        if (currentExpiry.isSameOrAfter(eventMoment)) {
            const proposed = eventMoment.clone().subtract(14, 'days');
            const minExpiry = moment().add(3, 'days');
            if (proposed.isBefore(minExpiry)) {
                newQuoteExpiry = eventMoment.diff(moment(), 'days') > 3 ? minExpiry.format('YYYY-MM-DD') : null;
            } else {
                newQuoteExpiry = proposed.format('YYYY-MM-DD');
            }
        }
    }

    // Compute new performance_end_time if time changed
    let newPerfEnd = row.performance_end_time;
    if (endTime !== undefined) {
        newPerfEnd = endTime || null;
    } else if (time !== undefined && time) {
        const dMins = parseDurationToMinutes(row.performance_duration) || 120;
        newPerfEnd = addMinutesToTime(time, dMins);
    }

    const setClauses = ['date = ?', 'quote_expiry_date = ?', 'modified_on = CURRENT_TIMESTAMP'];
    const params = [date, newQuoteExpiry];
    if (time !== undefined) {
        setClauses.push('event_start_time = ?');
        params.push(time || null);
        setClauses.push('performance_start_time = ?');
        params.push(time || null);
        setClauses.push('performance_end_time = ?');
        params.push(newPerfEnd || null);
    }
    params.push(bookingId);

    await updateBookingDateAndTimeFields(setClauses.join(', '), params);

    db.run(`INSERT INTO audit_log (table_name, record_id, action, old_values, new_values, changed_by) VALUES ('bookings', ?, 'UPDATE', ?, ?, ?)`,
        [bookingId, JSON.stringify({ date: oldDate, time: oldTime }), JSON.stringify({ date, time }), actorId ? String(actorId) : 'system']);
    updateDateHoldDateForBooking(date, bookingId);

    // Sync linked event datetime when booking date changes
    if (row.event_id) {
        const effectiveStartTime = (time !== undefined ? time : row.event_start_time) || '00:00';
        const newEventDatetime = date + 'T' + effectiveStartTime;
        updateEventDatetime(newEventDatetime, row.event_id,
            (evErr) => { if (evErr) console.error('[Date Change] Event datetime sync failed:', evErr.message); }
        );
    }

    getBookingById(bookingId, async (e, updated) => {
        if (!e && updated) syncBookingToCalendar(updated).catch(e2 => console.error('[Date Change] Calendar sync failed:', e2.message));
    });

    if (notifyWhenDateUnchanged || oldDate !== date) {
        sendDateChangedEmail(row, oldDate, date).catch(e => console.error('[Date Change] Client email failed:', e.message));
    }

    return { ok: true, newDate: date, newTime: time !== undefined ? time : row.event_start_time };
}

/**
 * "Use the Microsoft 365 time": makes a booking's schedule match what somebody set in Outlook, through rescheduleBooking (so the same conflict check, hold
 * movement, quote-expiry rule and client notice apply). `remote` is the comparable shape stored on the sync entry:
 * { subject, start: 'YYYY-MM-DDTHH:mm', end: 'YYYY-MM-DDTHH:mm', isAllDay, location, showAs }. Only date and times are applied - never the title, the place, or the
 * availability: those stay the website's, and the next sync sends them again.
 */
async function applyExternalSchedule({ link, remote, adminId }) {
    if (!link || link.source_type !== 'booking') {
        return { ok: false, status: 422, message: 'For a public event, change the date on the Events screen, then choose "Keep the website version".' };
    }
    const startDate = String(remote.start || '').slice(0, 10), endDate = String(remote.end || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) return { ok: false, status: 422, message: 'The Microsoft 365 time could not be read.' };
    const days = moment.utc(endDate).diff(moment.utc(startDate), 'days');
    if (remote.isAllDay) {
        if (days > 1) return { ok: false, status: 422, message: 'In Microsoft 365 this now spans several days; a booking is one day. Change the booking by hand.' };
        return rescheduleBooking({ bookingId: link.source_id, date: startDate, time: '', endTime: '', actorId: adminId, notifyWhenDateUnchanged: false });
    }
    if (days > 1 || (days === 1 && String(remote.end).slice(11, 16) > String(remote.start).slice(11, 16))) {
        return { ok: false, status: 422, message: 'In Microsoft 365 this now runs past the next day; a booking is one day (or overnight). Change the booking by hand.' };
    }
    return rescheduleBooking({ bookingId: link.source_id, date: startDate, time: String(remote.start).slice(11, 16), endTime: String(remote.end).slice(11, 16), actorId: adminId, notifyWhenDateUnchanged: false });
}

module.exports = { rescheduleBooking, applyExternalSchedule };
