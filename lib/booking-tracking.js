// Phase 5 (HOUSEKEEPING-NOTES.md): shared helpers for the public booking self-service surface
// (/api/public/bookings/*) — moved out of the app.js monolith byte-identical. asBookingText is used
// pervasively across that whole surface (including the public booking-intake route, not yet moved);
// generateOtpCode/hashAccessToken/parseBookingIdParam/the constants back the tracker OTP flow
// (track/request-code, track/verify-code) and requireBookingAccessToken (middleware/booking-access.js).
const crypto = require('crypto');

// A JSON body may send a number, array or object where a string is expected. Calling
// .trim()/.replace() on those throws before any validation runs, so every scalar is coerced
// first; non-scalars collapse to '' and are then caught by the required-field check.
function asBookingText(v) {
    if (v == null) return '';
    if (typeof v === 'string') return v.trim();
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    return '';
}

const OTP_TTL_MINUTES = 10;
const OTP_MAX_ATTEMPTS = 5;
const ACCESS_TOKEN_TTL_MINUTES = 60;

function generateOtpCode() {
    return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}
function hashAccessToken(rawToken) {
    return crypto.createHash('sha256').update(String(rawToken)).digest('hex');
}

// The booking id in a tracker URL (:id), as a positive integer, or 0 when it is not spelled as a
// plain positive integer ('15' only — not '015', '15.0', '1.5e1' or ' 15'). The routes that hand out
// access (track/request-code, track/verify-code) and the check that honours it
// (requireBookingAccessToken) must agree on this: when the first two used parseInt, '0015' got a code
// emailed and a token issued that every token-guarded route then refused, trapping the client in a
// "session expired" loop.
function parseBookingIdParam(raw) {
    const s = String(raw == null ? '' : raw);
    return /^[1-9]\d{0,15}$/.test(s) ? Number(s) : 0;
}
// What a client is told when they typed the booking number some other way.
const BOOKING_ID_FORMAT_MESSAGE = 'Please enter your booking number as shown in your emails, e.g. 42.';

module.exports = {
    asBookingText, OTP_TTL_MINUTES, OTP_MAX_ATTEMPTS, ACCESS_TOKEN_TTL_MINUTES,
    generateOtpCode, hashAccessToken, parseBookingIdParam, BOOKING_ID_FORMAT_MESSAGE
};
