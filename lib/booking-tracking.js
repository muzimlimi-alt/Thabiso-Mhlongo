// Phase 5 (HOUSEKEEPING-NOTES.md): shared helpers for the public booking self-service surface
// (/api/public/bookings/*) — moved out of the app.js monolith byte-identical. asBookingText is used
// pervasively across that whole surface (including the public booking-intake route, not yet moved);
// generateOtpCode/hashAccessToken/the three constants back the tracker OTP flow
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

// Owner rule: a client only sees amounts once a quotation has been sent to them. Before that a booking's stored
// figures are only the catalogue-based working estimate (0 for services priced individually) and must not reach
// the public tracking response. Revealed = a quotation has been issued for the booking (any version) OR the
// booking has reached a status that can only follow a quotation.
const QUOTED_OR_LATER_STATUSES = ['QUOTED', 'ACCEPTED', 'CONFIRMED', 'COMPLETED'];
function pricesRevealed({ status, quoteVersionCount } = {}) {
    return (parseInt(quoteVersionCount, 10) || 0) > 0 || QUOTED_OR_LATER_STATUSES.includes(String(status || '').toUpperCase());
}

module.exports = {
    asBookingText, OTP_TTL_MINUTES, OTP_MAX_ATTEMPTS, ACCESS_TOKEN_TTL_MINUTES,
    generateOtpCode, hashAccessToken, pricesRevealed, QUOTED_OR_LATER_STATUSES
};
