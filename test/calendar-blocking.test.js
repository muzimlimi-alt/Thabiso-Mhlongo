// Which Google Calendar events hold a date (lib/calendar-blocking.js). Pure - nothing here touches a database or Google.
const { blocksDate } = require('../lib/calendar-blocking');

module.exports = async function ({ check }) {
    const allDay = (summary, extra) => ({ id: 'x', summary, start: { date: '2026-11-26' }, end: { date: '2026-11-27' }, ...extra });
    const timed = (summary, extra) => ({ id: 'x', summary, start: { dateTime: '2026-11-26T19:00:00+02:00' }, end: { dateTime: '2026-11-26T21:00:00+02:00' }, ...extra });

    check('the birthday that was blocking 26 Nov (all-day, typed by hand) no longer blocks', blocksDate(allDay("Phindile Hlazane-Shabangu's birthday")) === false);
    check('"Birthday", "bday" and a curly-apostrophe birthday are all recognised', [allDay('Birthday: Sam'), allDay('Mom bday'), allDay('Thandi’s Birthday')].every(e => blocksDate(e) === false));
    check('anniversaries and holidays (all-day) do not block', [allDay('Wedding anniversary'), allDay('Public Holiday'), allDay('Heritage Day - holiday'), allDay('Bank holiday')].every(e => blocksDate(e) === false));
    check("Google's own birthday / working-location entries do not block, whatever they are called", blocksDate(allDay('Sam', { eventType: 'birthday' })) === false && blocksDate(allDay('Office', { eventType: 'workingLocation' })) === false);
    check('"Show as free" does not block - even for an entry with an ordinary title', blocksDate(allDay('Out of town', { transparency: 'transparent' })) === false && blocksDate(timed('Gym', { transparency: 'transparent' })) === false);
    check('a cancelled event does not block', blocksDate(timed('Gig', { status: 'cancelled' })) === false);

    check('a timed gig still blocks, even with "holiday" or "birthday" in the title', blocksDate(timed('Holiday Gala')) === true && blocksDate(timed("Jo's birthday party gig")) === true);
    check('an ordinary all-day entry (a festival, a trip) still blocks the whole day', blocksDate(allDay('Comedy Festival')) === true && blocksDate(allDay('Travel to Cape Town', { transparency: 'opaque' })) === true);
    check('an all-day entry with default event type and no transparency blocks (the previous behaviour for everything else)', blocksDate(allDay('Rehearsals', { eventType: 'default' })) === true);
    check('"holidays" inside another word is not mistaken for a holiday ("Hollidaysburg" style names)', blocksDate(allDay('Hollidaysburg trip')) === true);
    check('a malformed event never blocks and never throws', blocksDate(null) === false && blocksDate({}) === false);
};
