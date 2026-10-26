// Admin Calendar <-> Microsoft 365, Phase 6: a calendar entry is NOT a booking and NOT an open slot. On the real server (isolated DB):
//   * somebody else's BUSY appointment (mirrored as an 'm365_sync' hold by lib/calendar-m365.js) blocks the public booking form - the whole day, or just its hour;
//   * it blocks nothing it does not occupy (another time the same day stays bookable), and it never turns into a booking, an event or an open slot;
//   * the website's own iCalendar feed does not re-export those mirrored appointments;
//   * a Microsoft sync entry for a booking changes nothing about the booking's availability or status.
// Date offsets 1010-1019 are reserved for this file (see calendar.test.js on why offsets must not collide across files).
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3');
const support = require('./support');

module.exports = async function ({ check, api, pub, one, q, future }) {
    const rw = new sqlite3.Database(support.TEST_DB);
    const run = (sql, params = []) => new Promise((res, rej) => rw.run(sql, params, function (e) { e ? rej(e) : res(this); }));
    const perDate = async (ds) => (await pub('GET', `/api/public/availability?date=${ds}`)).body;
    const monthData = async (ds) => (await pub('GET', `/api/public/availability/month?year=${+ds.slice(0, 4)}&month=${+ds.slice(5, 7)}`)).body;
    const outlookHold = (date, start, end, id) => run(
        `INSERT INTO date_holds (hold_date, notes, status, hold_expires_at, start_time, end_time, block_type, m365_event_id) VALUES (?, 'Microsoft 365 calendar', 'active', '9999-12-31 23:59:59', ?, ?, 'm365_sync', ?)`, [date, start, end, id]);

    try {
        // ── a whole-day busy appointment (Out of office) ──
        const dayOff = future(1010);
        await outlookHold(dayOff, null, null, 'OUTLOOK-ALLDAY');
        const aDay = await perDate(dayOff), mDay = await monthData(dayOff);
        check('an Outlook all-day busy appointment makes that date unavailable on the public form ("held")', aDay.available === false && aDay.reason === 'held', JSON.stringify(aDay));
        check('...and the month view agrees (it is listed as held)', (mDay.held || []).includes(dayOff), JSON.stringify(mDay.held));

        // ── a timed busy appointment ──
        const timedDay = future(1011);
        await outlookHold(timedDay, '10:00', '11:00', 'OUTLOOK-TIMED');
        const aTimed = await perDate(timedDay);
        check('a timed Outlook appointment leaves the date open but marks its hour busy', aTimed.available === true && (aTimed.busy_ranges || []).some((r) => r.start === '10:00'), JSON.stringify(aTimed));
        const mk = (date, start, tag) => api('POST', '/api/admin/bookings', {
            name: 'M365 Availability', email: `m365.avail.${tag}.${Date.now()}@example.invalid`, cell: '+27821234567', event_date: date, event_start_time: start, event_name: 'M365 Availability Event',
            event_type: 'Corporate', event_location: 'Test Hall', message: 'Availability test booking, over ten characters.', services: [{ service_id: 15 }], status: 'NEW', override_working_hours: true
        });
        const clash = await mk(timedDay, '10:30', 'clash');
        check('a booking that overlaps that appointment is refused (the slot is not free)', clash.status === 409 || (clash.body && clash.body.success === false), JSON.stringify([clash.status, clash.body]));
        const fine = await mk(timedDay, '15:00', 'fine');
        check('...while a booking at another time the same day is accepted (nothing else is blocked)', fine.status === 200 && fine.body && fine.body.success && !!fine.body.booking_id, JSON.stringify([fine.status, fine.body]));

        // ── an appointment is not a booking, an event, or a slot ──
        const asBooking = await one(`SELECT COUNT(*) AS n FROM bookings WHERE date IN (?, ?) AND name != 'M365 Availability'`, [dayOff, timedDay]);
        const asEvent = await one(`SELECT COUNT(*) AS n FROM events WHERE substr(event_datetime, 1, 10) IN (?, ?)`, [dayOff, timedDay]);
        check('mirroring an appointment never creates a booking or an event', asBooking.n === 0 && asEvent.n === 0, JSON.stringify([asBooking, asEvent]));
        const feed = await api('GET', '/api/admin/calendar/events');
        const ofType = (t) => (feed.body || []).filter((e) => e.extendedProps && e.extendedProps.type === t && String(e.start).startsWith(dayOff));
        check('the admin calendar shows no booking / event / hold for it (the mirror hold is hidden; the appointment itself shows as read-only "external" once it is read from Outlook)', ofType('booking').length === 0 && ofType('public_event').length === 0 && ofType('hold').length === 0, JSON.stringify(feed.body.filter((e) => String(e.start).startsWith(dayOff))));

        // ── a lapsed / released mirror stops blocking, like any hold ──
        await run(`UPDATE date_holds SET status = 'cancelled' WHERE m365_event_id = 'OUTLOOK-ALLDAY'`);
        const aFree = await perDate(dayOff);
        check('when the appointment is removed (its hold released), the date opens again', aFree.available === true, JSON.stringify(aFree));

        // ── the website's iCalendar feed does not re-export Outlook appointments ──
        let secret = null;
        try { secret = require('dotenv').parse(fs.readFileSync(path.join(__dirname, '..', '.env'))).CALENDAR_FEED_SECRET || null; } catch (e) { secret = null; }
        if (secret) {
            const res = await fetch(`${support.BASE}/api/calendar/feed.ics?token=${encodeURIComponent(secret)}`);
            const ics = await res.text();
            check('the iCalendar feed answers with a calendar', res.status === 200 && /BEGIN:VCALENDAR/.test(ics), String(res.status));
            check('...and contains none of the mirrored Outlook appointments (they would leak colleagues\' slots and echo back if subscribed)', !/Microsoft 365 calendar/.test(ics), ics.slice(0, 300));
        } else {
            check('the iCalendar feed check needs CALENDAR_FEED_SECRET in .env (not set here) - skipped', true, '');
        }

        // ── a sync entry changes nothing about a booking ──
        const bid = fine.body.booking_id;
        const before = JSON.stringify(await one('SELECT * FROM bookings WHERE id = ?', [bid]));
        await run(`INSERT INTO calendar_links (source_type, source_id, graph_event_id, create_token, sync_status) VALUES ('booking', ?, 'G-AVAIL', 'tok-avail', 'conflict')`, [bid]);
        const stats = await api('GET', '/api/admin/calendar-sync');
        const after = JSON.stringify(await one('SELECT * FROM bookings WHERE id = ?', [bid]));
        check('a conflict flagged on a booking changes nothing in the booking (status, date, payments)', before === after && stats.status === 200 && stats.body.links.conflict === 1, JSON.stringify(stats.body.links));
        const avail = await perDate(timedDay);
        check('...nor in the availability the public sees', avail.available === true && (avail.busy_ranges || []).some((r) => r.start === '10:00') && (avail.busy_ranges || []).some((r) => r.start === '15:00'), JSON.stringify(avail));
    } finally {
        rw.close();
    }
};
