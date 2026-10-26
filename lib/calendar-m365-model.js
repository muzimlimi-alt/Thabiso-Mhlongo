// The pure half of the Admin Calendar <-> Microsoft 365 integration (no database, no network): WHAT should be on the shared calendar, how a Microsoft event is
// read back, and how a change is recognised. lib/calendar-m365.js does the talking. Rules and reasons: docs-internal/calendar-m365.md.
//
// Time zone: the site stores booking times as WALL-CLOCK strings in the business zone (no offset). They are sent to Microsoft as wall-clock strings together with
// the zone NAME and read back the same way (Prefer: outlook.timezone), so nothing here ever goes through the host machine's time zone (a Render server runs in UTC).
// South Africa has no daylight saving, but every conversion below goes through a named zone, not a fixed "+02:00".
'use strict';
const crypto = require('crypto');
const moment = require('moment-timezone');
const { decodeStoredText } = require('./html-sanitize');
const { parseDurationToMinutes } = require('./time-utils');

const BUSINESS_TZ = 'Africa/Johannesburg';          // verified against moment's zone data at load (see assertBusinessZone)
const GRAPH_TZ = 'South Africa Standard Time';       // the Windows name of the same zone: what Graph / Exchange use natively
const ORIGIN_CATEGORY = 'Website';                   // the Outlook category every published event carries, so people can see (and filter) where it came from
const DEFAULT_MINUTES = 120;                         // an event with a start time but no end / duration (same default the booking calendar uses)
const MAX_BLOCK_DAYS = 60;                           // a foreign event longer than this blocks only its first 60 days

// ── what is published ──────────────────────────────────────────────────────────────
// The existing rule for "what may appear in an external calendar" is the ICS feed (routes/public/misc.js): ACCEPTED / CONFIRMED / COMPLETED bookings.
// ACCEPTED (client accepted the quote, deposit pending) is shown as TENTATIVE, CONFIRMED as BUSY. COMPLETED keeps an event that already exists but never creates one.
// NEW / PENDING / QUOTED are enquiries and are never published. CANCELLED / EXPIRED (and anything unknown) remove the event.
const BOOKING_SHOW_AS = { ACCEPTED: 'tentative', CONFIRMED: 'busy' };
const BOOKING_KEEP = new Set(['COMPLETED']);
// Standalone public events (not the shadow row a confirmed booking creates - the booking's own event already represents that show).
const EVENT_PUBLISHED = new Set(['upcoming', 'live', 'sold_out']);
const EVENT_KEEP = new Set(['completed']);

const bookingRule = (status) => {
    const s = String(status || '').toUpperCase();
    return { showAs: BOOKING_SHOW_AS[s] || null, keep: BOOKING_KEEP.has(s) };
};
const eventRule = (status, bookingId) => {
    const s = String(status || '').toLowerCase();
    if (bookingId) return { showAs: null, keep: false };      // a booking's shadow event is never published on its own
    return { showAs: EVENT_PUBLISHED.has(s) ? 'busy' : null, keep: EVENT_KEEP.has(s) };
};

// ── time ────────────────────────────────────────────────────────────────────────
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function cleanDate(v) { const s = String(v || '').slice(0, 10); return DATE_RE.test(s) && moment.utc(s, 'YYYY-MM-DD', true).isValid() ? s : null; }
function cleanTime(v) {
    const m = /^(\d{1,2}):(\d{2})/.exec(String(v || '').trim());
    if (!m) return null;
    const h = Number(m[1]), mi = Number(m[2]);
    return h < 24 && mi < 60 ? String(h).padStart(2, '0') + ':' + m[2] : null;
}
const iso = (m) => m.format('YYYY-MM-DDTHH:mm:ss');

// date + optional start / end / duration  ->  { allDay, start, end }  as wall-clock ISO strings (end of an all-day event = the next midnight, as Graph wants)
function scheduleOf({ date, startTime, endTime, minutes }) {
    const d = cleanDate(date);
    if (!d) return null;
    const st = cleanTime(startTime);
    if (!st) {
        const day = moment.utc(d, 'YYYY-MM-DD');
        return { allDay: true, start: iso(day), end: iso(day.clone().add(1, 'day')) };
    }
    const start = moment.utc(`${d} ${st}`, 'YYYY-MM-DD HH:mm');
    const et = cleanTime(endTime);
    let end;
    if (et) {
        end = moment.utc(`${d} ${et}`, 'YYYY-MM-DD HH:mm');
        if (!end.isAfter(start)) end.add(1, 'day');                 // ends after midnight
    } else {
        const mins = Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_MINUTES;
        end = start.clone().add(mins, 'minutes');
    }
    return { allDay: false, start: iso(start), end: iso(end) };
}

// ── what the calendar entry should look like ─────────────────────────────────────────
// Plain text only, decoded from the stored (entity-encoded) form. NO client e-mail, phone or notes: the calendar is shared, the booking record stays in the site.
const plain = (v) => decodeStoredText(v == null ? '' : String(v)).replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
const baseUrl = () => String(process.env.BASE_URL || 'https://www.thabisomhlongo.com').replace(/\/+$/, '');

function buildDesired({ subject, schedule, location, showAs, noteLines }) {
    return {
        subject: subject.slice(0, 250),
        body: { contentType: 'text', content: noteLines.join('\n') },
        start: { dateTime: schedule.start, timeZone: GRAPH_TZ },
        end: { dateTime: schedule.end, timeZone: GRAPH_TZ },
        isAllDay: schedule.allDay,
        location: { displayName: String(location || '').slice(0, 250) },
        showAs,
        categories: [ORIGIN_CATEGORY],
        isReminderOn: false
    };
}

// booking row (+ joined venue name / client display name) -> desired Microsoft event, or null when the booking is not published
function desiredForBooking(b) {
    const rule = bookingRule(b.status);
    if (!rule.showAs) return null;
    const schedule = scheduleOf({
        date: b.date, startTime: b.event_start_time, endTime: b.performance_end_time,
        minutes: b.performance_end_time ? undefined : parseDurationToMinutes(b.performance_duration)
    });
    if (!schedule) return null;
    const title = plain(b.event_name) || plain(b.event_type) || 'Booking';
    const client = plain(b.client_name || b.name);
    const subject = (rule.showAs === 'tentative' ? '[Tentative] ' : '') + title + (client ? ' - ' + client : '');
    const place = plain(b.venue_name) || plain(b.event_location) || '';
    const location = [place, plain(b.city)].filter(Boolean).filter((v, i, a) => a.findIndex((x) => x.toLowerCase() === v.toLowerCase()) === i).join(', ');
    return buildDesired({
        subject, schedule, location, showAs: rule.showAs,
        noteLines: [
            `Website booking #${b.id} - ${String(b.status).toUpperCase()}`,
            `Open in the admin: ${baseUrl()}/admin#bookingsAdmin`,
            '',
            'This entry is managed by the website. A change made here is flagged for an administrator; it does not change the booking.'
        ]
    });
}

// standalone public event row (+ joined venue name) -> desired Microsoft event, or null
function desiredForEvent(e) {
    const rule = eventRule(e.event_status, e.booking_id);
    if (!rule.showAs) return null;
    const dt = String(e.event_datetime || '');
    const schedule = scheduleOf({ date: dt.slice(0, 10), startTime: e.event_start_time || (dt.length > 10 ? dt.slice(11, 16) : null), endTime: e.event_end_time });
    if (!schedule) return null;
    const lines = [`Website event #${e.event_id}`, `Open in the admin: ${baseUrl()}/admin#eventsAdmin`];
    if (e.ticket_sales_link) lines.push('Tickets: ' + plain(e.ticket_sales_link));
    lines.push('', 'This entry is managed by the website. A change made here is flagged for an administrator; it does not change the event.');
    return buildDesired({ subject: plain(e.event_title) || 'Event', schedule, location: plain(e.venue_name), showAs: rule.showAs, noteLines: lines });
}

// What the sync compares to decide "has this changed / did somebody else change it": only the fields the website owns, at minute precision.
function comparable(x) {
    const minute = (s) => String(s || '').slice(0, 16);
    return {
        subject: String(x.subject || '').trim(),
        start: minute(x.start && x.start.dateTime !== undefined ? x.start.dateTime : x.start),
        end: minute(x.end && x.end.dateTime !== undefined ? x.end.dateTime : x.end),
        isAllDay: !!x.isAllDay,
        location: String((x.location && x.location.displayName !== undefined ? x.location.displayName : x.location) || '').trim(),
        showAs: String(x.showAs || '').toLowerCase()
    };
}
const sameSchedule = (a, b) => JSON.stringify(comparable(a)) === JSON.stringify(comparable(b));
const sha = (v) => crypto.createHash('sha256').update(typeof v === 'string' ? v : JSON.stringify(v)).digest('hex');
// the whole desired entry (body included): when this changes, the entry is re-sent
const hashDesired = (d) => sha({ c: comparable(d), body: d.body && d.body.content, categories: d.categories });

// ── reading a Microsoft event back ───────────────────────────────────────────────────
// {dateTime, timeZone} -> { date, time } as wall-clock in the business zone. Graph answers in the zone we ask for (Prefer: outlook.timezone); anything else is converted
// through its NAMED zone; a zone name we cannot resolve returns null (the caller skips the event rather than guessing).
function localParts(dt) {
    if (!dt || !dt.dateTime) return null;
    const s = String(dt.dateTime).replace(/\.\d+$/, '').replace(/Z$/i, '');
    const tz = String(dt.timeZone || 'UTC');
    let m;
    if (tz === GRAPH_TZ || tz === BUSINESS_TZ) m = moment.utc(s, 'YYYY-MM-DDTHH:mm:ss');
    else if (/^(utc|gmt|etc\/utc)$/i.test(tz)) m = moment.utc(s, 'YYYY-MM-DDTHH:mm:ss').tz(BUSINESS_TZ);
    else if (moment.tz.zone(tz)) m = moment.tz(s, 'YYYY-MM-DDTHH:mm:ss', tz).tz(BUSINESS_TZ);
    else return null;
    if (!m.isValid()) return null;
    return { date: m.format('YYYY-MM-DD'), time: m.format('HH:mm') };
}

// a Graph event -> the normalised shape the sync works with (or null if it cannot be read safely)
function normalizeRemote(e) {
    const s = localParts(e.start), en = localParts(e.end);
    if (!s || !en) return null;
    const allDay = !!e.isAllDay;
    return {
        id: e.id, subject: String(e.subject || '').trim(), isAllDay: allDay, showAs: String(e.showAs || 'busy').toLowerCase(),
        isCancelled: !!e.isCancelled, type: e.type || 'singleInstance', seriesMasterId: e.seriesMasterId || null,
        startDate: s.date, startTime: allDay ? null : s.time, endDate: en.date, endTime: allDay ? null : en.time,
        location: String((e.location && e.location.displayName) || '').trim(),
        isOnline: !!e.isOnlineMeeting, joinUrl: (e.onlineMeeting && e.onlineMeeting.joinUrl) || null,
        webLink: e.webLink || null, changeKey: e.changeKey || null, modifiedAt: e.lastModifiedDateTime || null,
        categories: Array.isArray(e.categories) ? e.categories : []
    };
}
// the same shape comparable() works on, from a normalised remote
const remoteComparable = (r) => comparable({
    subject: r.subject, start: `${r.startDate}T${r.startTime || '00:00'}`, end: `${r.endDate}T${r.endTime || '00:00'}`, isAllDay: r.isAllDay, location: r.location, showAs: r.showAs
});

// Which days a foreign event occupies, as availability holds: [{ date, start, end }] (start / end null = the whole day).
//   all-day: first day .. last day (Graph's end is the next midnight, exclusive).
//   timed:   first day from its start time, last day until its end time, whole days between; an end at exactly 00:00 on a later day belongs to the day before.
function daysCovered(r) {
    const first = moment.utc(r.startDate, 'YYYY-MM-DD');
    const endDay = moment.utc(r.endDate, 'YYYY-MM-DD');
    if (!first.isValid() || !endDay.isValid()) return [];
    let last = endDay.clone();
    if (r.isAllDay || (r.endTime === '00:00' && endDay.isAfter(first))) last = endDay.clone().subtract(1, 'day');
    if (last.isBefore(first)) last = first.clone();
    const out = [];
    for (let d = first.clone(), n = 0; !d.isAfter(last) && n < MAX_BLOCK_DAYS; d.add(1, 'day'), n++) {
        const date = d.format('YYYY-MM-DD');
        if (r.isAllDay) { out.push({ date, start: null, end: null }); continue; }
        const start = date === r.startDate ? r.startTime : '00:00';
        const end = date === r.endDate ? r.endTime : '23:59';
        out.push(start === '00:00' && end === '23:59' ? { date, start: null, end: null } : { date, start, end });
    }
    return out;
}

// busy / out-of-office hold the date for the public booking form; tentative, free and working-elsewhere are shown but do not block.
const blocksAvailability = (r) => !r.isCancelled && (r.showAs === 'busy' || r.showAs === 'oof');

// ── zone sanity (called at start-up and in tests) ───────────────────────────────────────
function assertBusinessZone() {
    const z = moment.tz.zone(BUSINESS_TZ);
    if (!z) throw new Error(`time zone ${BUSINESS_TZ} is unknown to moment-timezone`);
    // South Africa Standard Time is UTC+2 all year round; if tz data ever changes that, the sync must be reviewed rather than silently drift.
    const offsets = new Set([moment.tz('2026-01-15 12:00', BUSINESS_TZ).utcOffset(), moment.tz('2026-07-15 12:00', BUSINESS_TZ).utcOffset()]);
    if (offsets.size !== 1 || !offsets.has(120)) throw new Error(`${BUSINESS_TZ} is expected to be a constant UTC+2; got ${[...offsets].join(', ')} minutes`);
    return true;
}

module.exports = {
    BUSINESS_TZ, GRAPH_TZ, ORIGIN_CATEGORY, DEFAULT_MINUTES, MAX_BLOCK_DAYS,
    bookingRule, eventRule, scheduleOf, cleanDate, cleanTime, desiredForBooking, desiredForEvent,
    comparable, sameSchedule, hashDesired, sha, localParts, normalizeRemote, remoteComparable, daysCovered, blocksAvailability, assertBusinessZone
};
