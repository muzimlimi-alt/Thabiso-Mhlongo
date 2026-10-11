// Run by stored-text.test.js in its OWN process (never required by the test runner): captures what would reach
// SMTP and Google Calendar when they are handed stored, entity-encoded text, with both external services stubbed.
// DB_PATH points at a throwaway file the parent deletes - never the shared test database.
const nodemailer = require('nodemailer');
const sent = [];
nodemailer.createTransport = () => ({ sendMail: async (o) => { sent.push({ subject: o.subject, text: o.text, html: o.html }); return { messageId: 'stub' }; } });

const gc = require('../lib/google-calendar');
const events = [];
const capture = async (arg) => { events.push(arg.requestBody); return { data: { id: 'stub-event' } }; };
gc.calendar.events.insert = capture;
gc.calendar.events.update = capture;

const emailService = require('../js/emailService');
const calendarSync = require('../lib/calendar-sync');

(async () => {
    await new Promise(r => setTimeout(r, 4000));            // let the throwaway DB finish creating its tables
    await emailService.sendEmailDirectly({
        to: 'someone@example.invalid',
        subject: 'Re: Tom &amp; Jerry&#x27;s &quot;quote&quot;',
        htmlContent: '<p>Hi O&#x27;Brien &amp; Sons &lt;3</p>',
    });
    await calendarSync.syncBookingToCalendar({
        id: 987654, status: 'Confirmed', date: '2031-05-04', event_start_time: '18:00', event_type: 'Corporate',
        event_location: 'Tom &amp; Jerry&#x27;s Hall', name: 'O&#x27;Brien &amp; Sons', email: 'someone@example.invalid', cell: '+27821234567',
        message: 'Bring &quot;the A-team&quot; &amp; more',
    });
    console.log('RESULT:' + JSON.stringify({ sent, events }));
    process.exit(0);
})().catch(e => { console.error('CHILD ERROR', e); process.exit(1); });
