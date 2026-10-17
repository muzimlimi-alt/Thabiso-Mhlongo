// The pure rules of the Admin Calendar <-> Microsoft 365 integration (lib/calendar-m365-model.js): what is published and how, time zones / all-day / overnight,
// reading a Microsoft event back, recognising a change, and which days a foreign event blocks. No database, no network.
const path = require('path');
const { execFileSync } = require('child_process');
const model = require('../lib/calendar-m365-model');

const ROOT = path.join(__dirname, '..');

module.exports = async function ({ check }) {
    const booking = (o) => ({
        id: 41, status: 'CONFIRMED', date: '2026-12-25', event_start_time: '18:00', performance_end_time: '20:30', performance_duration: null, event_name: 'Year End Gala',
        event_type: 'Corporate', event_location: 'Sandton Convention Centre', city: 'Johannesburg', name: 'Ann Lee', client_name: 'Ann Lee', venue_name: null,
        email: 'ann.lee@client.example', cell: '+27821234567', message: 'Bring the long set. Gate code 1234.', ...(o || {})
    });

    // ══════════ what is published ══════════
    const rule = (s) => model.bookingRule(s);
    check('CONFIRMED -> busy, ACCEPTED -> tentative', rule('CONFIRMED').showAs === 'busy' && rule('ACCEPTED').showAs === 'tentative', JSON.stringify([rule('CONFIRMED'), rule('ACCEPTED')]));
    check('enquiries are never published (NEW, PENDING, REVIEWED, QUOTED)', ['NEW', 'PENDING', 'REVIEWED', 'QUOTED'].every((s) => !rule(s).showAs && !rule(s).keep), '');
    check('CANCELLED / EXPIRED / unknown publish nothing and keep nothing (an existing entry is removed)', ['CANCELLED', 'EXPIRED', 'WHATEVER', '', null].every((s) => !rule(s).showAs && !rule(s).keep), '');
    check('COMPLETED publishes nothing new but keeps what exists', !rule('COMPLETED').showAs && rule('COMPLETED').keep === true, '');
    check('status is matched case-insensitively', rule('confirmed').showAs === 'busy', '');
    check('public events: upcoming / live / sold_out are published; draft / cancelled / postponed are not; completed is kept',
        ['upcoming', 'live', 'sold_out'].every((s) => model.eventRule(s, null).showAs === 'busy') && ['draft', 'cancelled', 'postponed'].every((s) => !model.eventRule(s, null).showAs && !model.eventRule(s, null).keep) && model.eventRule('completed', null).keep, '');
    check('the shadow event of a booking is never published on its own (no duplicate of the booking\'s entry)', ['upcoming', 'live', 'sold_out', 'completed'].every((s) => !model.eventRule(s, 41).showAs && !model.eventRule(s, 41).keep), '');

    // ══════════ the entry itself ══════════
    const d = model.desiredForBooking(booking());
    check('a CONFIRMED booking becomes a busy, timed event in the business zone', d && d.showAs === 'busy' && d.isAllDay === false && d.start.dateTime === '2026-12-25T18:00:00' && d.end.dateTime === '2026-12-25T20:30:00' && d.start.timeZone === 'South Africa Standard Time' && d.end.timeZone === d.start.timeZone, JSON.stringify(d));
    check('...titled "event - client", located at the venue text and city, marked with the Website category, no reminder', d.subject === 'Year End Gala - Ann Lee' && d.location.displayName === 'Sandton Convention Centre, Johannesburg' && d.categories.join() === 'Website' && d.isReminderOn === false, JSON.stringify(d));
    const dump = JSON.stringify(d);
    check('PRIVACY: no client e-mail, phone or notes anywhere in what is sent to the shared calendar', !/ann\.lee@|\+2782|Gate code|long set/i.test(dump), dump);
    check('...and no attendees, so Microsoft never e-mails anybody', !('attendees' in d), '');
    check('the body points back to the admin and says the entry is managed by the website', /Website booking #41/.test(d.body.content) && /\/admin#bookingsAdmin/.test(d.body.content) && /managed by the website/.test(d.body.content), d.body.content);
    const t = model.desiredForBooking(booking({ status: 'ACCEPTED' }));
    check('an ACCEPTED booking is tentative and says so in the title', t.showAs === 'tentative' && t.subject === '[Tentative] Year End Gala - Ann Lee', t.subject);
    check('an enquiry / cancelled booking has no entry', !model.desiredForBooking(booking({ status: 'QUOTED' })) && !model.desiredForBooking(booking({ status: 'CANCELLED' })), '');
    check('stored (entity-encoded) text is decoded for the calendar: Tom &amp; Jerry&#x27;s -> Tom & Jerry\'s', model.desiredForBooking(booking({ client_name: 'Tom &amp; Jerry&#x27;s', event_name: 'A &lt;b&gt; show' })).subject === "A <b> show - Tom & Jerry's", model.desiredForBooking(booking({ client_name: 'Tom &amp; Jerry&#x27;s', event_name: 'A &lt;b&gt; show' })).subject);
    check('a venue name wins over the free-text location and is not repeated when it equals the city', model.desiredForBooking(booking({ venue_name: 'Sun Arena', event_location: 'x', city: 'sun arena' })).location.displayName === 'Sun Arena', '');

    // all-day / overnight / duration
    const noTime = model.desiredForBooking(booking({ event_start_time: null, performance_end_time: null }));
    check('a booking with NO start time is an ALL-DAY event (end = next midnight), never silently timed', noTime.isAllDay === true && noTime.start.dateTime === '2026-12-25T00:00:00' && noTime.end.dateTime === '2026-12-26T00:00:00', JSON.stringify([noTime.isAllDay, noTime.start, noTime.end]));
    const dur = (x) => model.desiredForBooking(booking({ performance_end_time: null, ...x }));
    check('no end time: the stored duration decides, the way the booking calendar reads it (180 / "90 min" / none -> 2 h default)', dur({ performance_duration: '180' }).end.dateTime === '2026-12-25T21:00:00' && dur({ performance_duration: '90 min' }).end.dateTime === '2026-12-25T19:30:00' && dur({ performance_duration: null }).end.dateTime === '2026-12-25T20:00:00', '');
    const night = model.desiredForBooking(booking({ event_start_time: '22:00', performance_end_time: '01:00' }));
    check('an end time before the start time means after midnight (ends the next day)', night.start.dateTime === '2026-12-25T22:00:00' && night.end.dateTime === '2026-12-26T01:00:00', JSON.stringify(night.end));
    check('a malformed date publishes nothing (no crash, no bogus event)', model.desiredForBooking(booking({ date: 'not-a-date' })) === null && model.desiredForBooking(booking({ date: '2026-02-30' })) === null, '');
    check('single-digit hours are accepted ("9:00")', model.desiredForBooking(booking({ event_start_time: '9:00', performance_end_time: '10:00' })).start.dateTime === '2026-12-25T09:00:00', '');

    // events
    const ev = (o) => ({ event_id: 7, event_title: 'Comedy Night', event_datetime: '2026-11-20T19:30', event_start_time: null, event_end_time: '21:00', event_status: 'upcoming', booking_id: null, venue_name: 'The Lyric', ticket_sales_link: 'https://tickets.example/x', ...(o || {}) });
    const e1 = model.desiredForEvent(ev());
    check('a public event becomes a busy event from its date-time to its end time, with the ticket link in the body', e1 && e1.start.dateTime === '2026-11-20T19:30:00' && e1.end.dateTime === '2026-11-20T21:00:00' && e1.location.displayName === 'The Lyric' && /Tickets: https:\/\/tickets\.example\/x/.test(e1.body.content), JSON.stringify(e1));
    check('an event with only a date is all-day; a booking\'s shadow event or a draft has no entry', model.desiredForEvent(ev({ event_datetime: '2026-11-20' })).isAllDay === true && model.desiredForEvent(ev({ booking_id: 5 })) === null && model.desiredForEvent(ev({ event_status: 'draft' })) === null, '');

    // ══════════ time zone independence ══════════
    const expr = 'process.stdout.write(JSON.stringify([require("./lib/calendar-m365-model").scheduleOf({date:"2026-12-25",startTime:"18:00",minutes:90}), require("./lib/calendar-m365-model").localParts({dateTime:"2026-12-25T23:30:00.0000000",timeZone:"UTC"})]))';
    const here = execFileSync(process.execPath, ['-e', expr], { cwd: ROOT, env: { ...process.env, TZ: 'Africa/Johannesburg' } }).toString();
    const la = execFileSync(process.execPath, ['-e', expr], { cwd: ROOT, env: { ...process.env, TZ: 'America/Los_Angeles' } }).toString();
    const utc = execFileSync(process.execPath, ['-e', expr], { cwd: ROOT, env: { ...process.env, TZ: 'UTC' } }).toString();
    check('the results do NOT depend on the host machine\'s time zone (Johannesburg, Los Angeles and UTC hosts agree)', here === la && la === utc, JSON.stringify([here, la, utc]));
    check('the business zone is verified: Africa/Johannesburg is a constant UTC+2 (no daylight saving) in the zone data', model.assertBusinessZone() === true && model.BUSINESS_TZ === 'Africa/Johannesburg', '');
    check('...and its Windows name for Graph is "South Africa Standard Time"', model.GRAPH_TZ === 'South Africa Standard Time', '');

    // ══════════ reading Microsoft's answer ══════════
    const lp = (dateTime, timeZone) => model.localParts({ dateTime, timeZone });
    check('Graph answering in the business zone is taken as it is', JSON.stringify(lp('2026-12-25T18:00:00.0000000', 'South Africa Standard Time')) === '{"date":"2026-12-25","time":"18:00"}', '');
    check('UTC is converted into the business zone, across midnight too (23:30Z -> 01:30 next day)', JSON.stringify(lp('2026-12-25T16:00:00.0000000', 'UTC')) === '{"date":"2026-12-25","time":"18:00"}' && JSON.stringify(lp('2026-12-25T23:30:00.0000000', 'UTC')) === '{"date":"2026-12-26","time":"01:30"}', '');
    check('another IANA zone is converted (New York 12:00 on 25 Dec = 19:00 Johannesburg)', JSON.stringify(lp('2026-12-25T12:00:00', 'America/New_York')) === '{"date":"2026-12-25","time":"19:00"}', '');
    check('a zone name that cannot be resolved is refused, never guessed', lp('2026-12-25T12:00:00', 'Atlantis Standard Time') === null && lp('', 'UTC') === null && model.localParts(null) === null, '');

    const remote = (o) => ({ id: 'AAMk1=', subject: ' Dentist ', isAllDay: false, showAs: 'busy', start: { dateTime: '2026-12-01T09:00:00.0000000', timeZone: 'South Africa Standard Time' }, end: { dateTime: '2026-12-01T10:00:00.0000000', timeZone: 'South Africa Standard Time' }, location: { displayName: ' Clinic ' }, changeKey: 'ck1', ...(o || {}) });
    const nr = model.normalizeRemote(remote());
    check('normalizeRemote: trims text, splits date / time, keeps the change key', nr.subject === 'Dentist' && nr.location === 'Clinic' && nr.startDate === '2026-12-01' && nr.startTime === '09:00' && nr.endTime === '10:00' && nr.changeKey === 'ck1' && nr.showAs === 'busy', JSON.stringify(nr));
    const nad = model.normalizeRemote(remote({ isAllDay: true, start: { dateTime: '2026-12-01T00:00:00.0000000', timeZone: 'South Africa Standard Time' }, end: { dateTime: '2026-12-02T00:00:00.0000000', timeZone: 'South Africa Standard Time' } }));
    check('an all-day event has no times', nad.isAllDay && nad.startTime === null && nad.endTime === null && nad.startDate === '2026-12-01' && nad.endDate === '2026-12-02', JSON.stringify(nad));
    check('an event whose time cannot be read is skipped (null), not guessed', model.normalizeRemote(remote({ start: { dateTime: 'garbage', timeZone: 'UTC' } })) === null, '');

    // ══════════ recognising a change ══════════
    const base = model.desiredForBooking(booking());
    const asRemote = (x) => model.remoteComparable(model.normalizeRemote({ id: 'x', subject: x.subject, isAllDay: x.isAllDay, showAs: x.showAs, start: { dateTime: x.start.dateTime + '.0000000', timeZone: 'South Africa Standard Time' }, end: { dateTime: x.end.dateTime + '.0000000', timeZone: 'South Africa Standard Time' }, location: x.location }));
    check('what we sent, read back from Microsoft (sub-second padding, same zone), compares equal - no false "changed in Outlook"', model.sameSchedule(asRemote(base), model.comparable(base)), JSON.stringify([asRemote(base), model.comparable(base)]));
    const changed = (patch) => !model.sameSchedule(asRemote({ ...base, ...patch }), model.comparable(base));
    check('a moved start, moved end, other title, other place, other availability or all-day flag IS a change', changed({ start: { dateTime: '2026-12-25T19:00:00' } }) && changed({ end: { dateTime: '2026-12-25T21:00:00' } }) && changed({ subject: 'Other' }) && changed({ location: { displayName: 'Elsewhere' } }) && changed({ showAs: 'free' }) && changed({ isAllDay: true }), '');
    check('...but whitespace, seconds and a body / category edit are not', !changed({ subject: ' Year End Gala - Ann Lee ' }) && !changed({ start: { dateTime: '2026-12-25T18:00:30' } }), '');
    const h = model.hashDesired(base);
    check('hashDesired is stable and changes with every field that is sent (title, time, place, availability, body)', h === model.hashDesired(model.desiredForBooking(booking())) && h !== model.hashDesired(model.desiredForBooking(booking({ event_name: 'Other' }))) && h !== model.hashDesired(model.desiredForBooking(booking({ date: '2026-12-26' }))) && h !== model.hashDesired(model.desiredForBooking(booking({ status: 'ACCEPTED' }))) && h !== model.hashDesired(model.desiredForBooking(booking({ id: 42 }))), '');

    // ══════════ which days a foreign event blocks ══════════
    const cov = (o) => JSON.stringify(model.daysCovered({ isAllDay: false, startDate: '2026-12-01', startTime: '09:00', endDate: '2026-12-01', endTime: '10:00', ...o }));
    check('a one-hour appointment blocks that hour only', cov({}) === '[{"date":"2026-12-01","start":"09:00","end":"10:00"}]', cov({}));
    check('a timed event across three days: first day from its start, whole middle day, last day until its end', cov({ endDate: '2026-12-03', endTime: '12:00' }) === '[{"date":"2026-12-01","start":"09:00","end":"23:59"},{"date":"2026-12-02","start":null,"end":null},{"date":"2026-12-03","start":"00:00","end":"12:00"}]', cov({ endDate: '2026-12-03', endTime: '12:00' }));
    check('an event ending exactly at midnight does not spill onto the next day', cov({ endDate: '2026-12-02', endTime: '00:00' }) === '[{"date":"2026-12-01","start":"09:00","end":"23:59"}]', cov({ endDate: '2026-12-02', endTime: '00:00' }));
    check('an all-day event: its own day(s) only (Graph\'s end is the next midnight, exclusive)', cov({ isAllDay: true, startTime: null, endTime: null, endDate: '2026-12-02' }) === '[{"date":"2026-12-01","start":null,"end":null}]' && cov({ isAllDay: true, startTime: null, endTime: null, endDate: '2026-12-04' }).split('"date"').length === 4, cov({ isAllDay: true, startTime: null, endTime: null, endDate: '2026-12-04' }));
    check('a very long event blocks only its first ' + model.MAX_BLOCK_DAYS + ' days', JSON.parse(cov({ isAllDay: true, startTime: null, endTime: null, endDate: '2027-12-01' })).length === model.MAX_BLOCK_DAYS, '');
    const blk = (showAs, extra) => model.blocksAvailability({ showAs, isCancelled: false, ...(extra || {}) });
    check('busy and out-of-office block the public booking form; tentative, free, working-elsewhere and cancelled do not', blk('busy') && blk('oof') && !blk('tentative') && !blk('free') && !blk('workingElsewhere') && !blk('busy', { isCancelled: true }), '');
};
