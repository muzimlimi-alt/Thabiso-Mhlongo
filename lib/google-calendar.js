// Phase 5 (HOUSEKEEPING-NOTES.md): relocated from app.js verbatim — the module-scoped Google
// Calendar client singleton (oauth2Client/calendar/CALENDAR_ID) plus deleteGoogleEvent, its one
// small consumer that used to sit right below it. Pulled forward as a dependency of
// lib/popia.js's notifyPopiaCancellations() (batch 14), rather than waiting for a dedicated
// Google Calendar batch, since nothing else in app.js touches oauth2Client directly and calendar/
// CALENDAR_ID have no other construction-order dependency worth preserving beyond "requires at the
// same point in app.js's top-to-bottom execution that this code used to occupy" — which the
// require() replacing this block still does.
const { google } = require('googleapis');

// Google Calendar Configuration
const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.BASE_URL // Redirect URL used during setup, though refresh token is already obtained
);

oauth2Client.setCredentials({
    refresh_token: process.env.GOOGLE_REFRESH_TOKEN
});

const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
const CALENDAR_ID = 'primary'; // Using the primary calendar of the authenticated account

/**
 * Removes a Google Calendar event
 * @param {string} eventId
 */
async function deleteGoogleEvent(eventId) {
    if (!eventId) return;
    try {
        await calendar.events.delete({ calendarId: CALENDAR_ID, eventId: eventId });
        console.log(`✓ Deleted GCal Event: ${eventId}`);
    } catch (error) {
        console.error(`Error deleting GCal event ${eventId}:`, error);
    }
}

module.exports = { calendar, CALENDAR_ID, deleteGoogleEvent };
