// Phase 5 (HOUSEKEEPING-NOTES.md): relocated from app.js verbatim — the module-scoped Google
// Calendar client singleton (oauth2Client/calendar/CALENDAR_ID) plus deleteGoogleEvent, its one
// small consumer that used to sit right below it. Pulled forward as a dependency of
// lib/popia.js's notifyPopiaCancellations() (batch 14), rather than waiting for a dedicated
// Google Calendar batch, since nothing else in app.js touches oauth2Client directly and calendar/
// CALENDAR_ID have no other construction-order dependency worth preserving beyond "requires at the
// same point in app.js's top-to-bottom execution that this code used to occupy" — which the
// require() replacing this block still does.
//
// Oct 2026: the client is no longer fixed to the .env values. It starts from them exactly as before, then (a moment after load) is pointed at what an
// administrator saved in Admin -> System -> Integrations -> Google Calendar (lib/google-config.js) and is re-pointed whenever they connect, change or
// disconnect the account. It is reconfigured IN PLACE, so `calendar` and `oauth2Client` stay the same objects and no caller (lib/calendar-sync.js,
// lib/popia.js, ...) had to change.
const { google } = require('googleapis');

// Endpoint overrides in the style of M365_GRAPH_BASE_URL / SMTP_OAUTH_AUTHORITY: they let a test aim the sign-in and the Calendar API at a fake Google
// (test/fake-google.js). Unset in every real deployment.
function endpointOverrides() {
    const e = {};
    if (process.env.GOOGLE_OAUTH_TOKEN_URL) e.oauth2TokenUrl = process.env.GOOGLE_OAUTH_TOKEN_URL;
    if (process.env.GOOGLE_OAUTH_AUTH_URL) e.oauth2AuthBaseUrl = process.env.GOOGLE_OAUTH_AUTH_URL;
    if (process.env.GOOGLE_OAUTH_REVOKE_URL) e.oauth2RevokeUrl = process.env.GOOGLE_OAUTH_REVOKE_URL;
    return e;
}
function newOAuthClient(clientId, clientSecret, redirectUri) {
    return new google.auth.OAuth2({ clientId, clientSecret, redirectUri, endpoints: endpointOverrides() });
}
function newCalendarApi(auth) {
    const opts = { version: 'v3', auth };
    if (process.env.GOOGLE_API_ROOT_URL) opts.rootUrl = process.env.GOOGLE_API_ROOT_URL;
    return google.calendar(opts);
}

// Google Calendar Configuration
const oauth2Client = newOAuthClient(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.BASE_URL // Redirect URL used during setup, though refresh token is already obtained
);

oauth2Client.setCredentials({
    refresh_token: process.env.GOOGLE_REFRESH_TOKEN
});

const calendar = newCalendarApi(oauth2Client);
const CALENDAR_ID = 'primary'; // Using the primary calendar of the authenticated account

// Points the one client at a resolved configuration ({ clientId, clientSecret, refreshToken } from lib/google-config.js). Replacing the credentials also
// drops any cached access token, so the very next call signs in with the new refresh token.
function applyConfig(cfg) {
    oauth2Client._clientId = cfg.clientId || undefined;
    oauth2Client._clientSecret = cfg.clientSecret || undefined;
    oauth2Client.setCredentials(cfg.refreshToken ? { refresh_token: cfg.refreshToken } : {});
}

// Reads the saved configuration (settings table first, then the environment) and applies it. Never throws: a failure here must not stop the server.
async function reloadFromSettings() {
    try {
        applyConfig(await require('./google-config').resolveGoogleConfig());
    } catch (e) {
        console.error('Google Calendar settings could not be loaded:', e.message);
    }
}

/**
 * Removes a Google Calendar event
 * @param {string} eventId
 */
async function deleteGoogleEvent(eventId) {
    // A cancellation / expiry / erasure: the shared Microsoft 365 calendar removes its entry too, a few seconds later (lazy require: no load-order dependency).
    try { require('./calendar-m365').requestSync('booking removed'); } catch (e) { /* must never affect the cancellation */ }
    if (!eventId) return;
    try {
        await calendar.events.delete({ calendarId: CALENDAR_ID, eventId: eventId }, { timeout: 8000 });
        console.log(`✓ Deleted GCal Event: ${eventId}`);
    } catch (error) {
        let why; try { why = require('./google-config').classify(error).message; } catch (e) { why = String((error && error.message) || error).slice(0, 200); }   // never the raw error: it carries the request
        console.error(`Error deleting GCal event ${eventId}:`, why);
    }
}

module.exports = { calendar, CALENDAR_ID, deleteGoogleEvent, oauth2Client, newOAuthClient, newCalendarApi, applyConfig, reloadFromSettings };

// After module.exports is set (lib/google-config.js reaches back into this module lazily, so neither needs the other while loading).
setImmediate(reloadFromSettings);
