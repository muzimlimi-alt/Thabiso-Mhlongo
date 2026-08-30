// Phase 5 (HOUSEKEEPING-NOTES.md): relocated from app.js verbatim. Pure time-arithmetic helpers,
// no I/O, no other dependencies — used pervasively (~40 call sites) across the booking-conflict
// engine, calendar-hold routes, and the not-yet-moved bookings cluster. Extracted as a leaf module
// specifically so routes/admin/calendar.js could use them without a circular require back into
// app.js; app.js re-imports them at the same point they used to be defined.
function timeRangesOverlap(s1, e1, s2, e2) {
    // HH:MM strings are always zero-padded so lexicographic comparison is correct
    return s1 < e2 && s2 < e1;
}

function addMinutesToTime(timeStr, minutes) {
    const [h, m] = timeStr.split(':').map(Number);
    const total = h * 60 + m + minutes;
    const hh = Math.floor(total / 60) % 24;
    const mm = total % 60;
    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function parseDurationToMinutes(dur) {
    if (!dur) return 120;
    const n = parseInt(dur);
    if (!isNaN(n)) return n; // frontend sends numeric minutes
    const mh = String(dur).match(/(\d+)\s*(h|hour|hr)/i);
    if (mh) return parseInt(mh[1]) * 60;
    const mm = String(dur).match(/(\d+)\s*(m|min)/i);
    if (mm) return parseInt(mm[1]);
    return 120;
}

module.exports = { timeRangesOverlap, addMinutesToTime, parseDurationToMinutes };
