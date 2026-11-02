// Which Google Calendar events should hold a date on the public booking form (lib/calendar-sync.js, syncCalendarHolds).
// Pure - no database - so it can be tested on its own.
//
// An all-day entry such as a birthday, an anniversary or a public holiday says nothing about whether Thabiso is working that day, yet an
// untimed hold closes the whole date to clients. So an event does NOT hold a date when:
//   1. Google marks it as a birthday or working-location entry (eventType), or
//   2. it is set to "Show as free" (transparency 'transparent') - Google's own way of saying "this does not make me busy", or
//   3. it is an all-day entry whose title says it is a birthday, anniversary or holiday.
// A timed event (a gig, a meeting) always holds its time window - rule 3 never applies to it, so "Holiday Gala 19:00" still blocks.
// A cancelled event is ignored by Google's own listing; it is also refused here so a stale item cannot hold a date.

const NON_BUSY_TYPES = new Set(['birthday', 'workingLocation']);
const NON_BUSY_TITLE = /\b(birthday|b-?day|anniversary|public holiday|bank holiday|holiday)\b|[’']s\s+birthday/i;

function blocksDate(event) {
    if (!event || !event.start) return false;
    if (event.status === 'cancelled') return false;
    if (NON_BUSY_TYPES.has(event.eventType)) return false;
    if (event.transparency === 'transparent') return false;
    const allDay = !event.start.dateTime;
    if (allDay && NON_BUSY_TITLE.test(String(event.summary || ''))) return false;
    return true;
}

module.exports = { blocksDate };
