// Phase 5 (HOUSEKEEPING-NOTES.md): moved out of the app.js monolith byte-identical, alongside
// requireAdmin's own move to this directory. Verifies req.params.id + a bearer access_token
// (JSON body for POST, query string for GET downloads) against booking_access_tokens. On success
// attaches the verified email as req.trackingEmail — routes trust this, not any client-supplied
// `email` field, for ownership checks. The token itself is high-entropy (32 random bytes), so a
// fast indexed sha256 lookup is appropriate here — unlike the low-entropy OTP code (see
// lib/booking-tracking.js), which is bcrypt-hashed and rate-limited on attempts instead.
const { hashAccessToken, parseBookingIdParam } = require('../lib/booking-tracking');
const { getBookingAccessTokenByHash, touchBookingAccessToken } = require('../database/repositories/bookings.repository');

function requireBookingAccessToken(req, res, next) {
    // The URL id must be a plain positive integer. Routes behind this check pass req.params.id
    // straight into SQL, and SQLite compares numeric-looking text to an INTEGER column by value —
    // so '1.5e1' (or '015', ' 15') matches booking #15, while parseInt('1.5e1') is 1. Without this,
    // a token verified for booking #1 would let those routes read and change booking #15.
    // track/request-code and track/verify-code apply the same parser, so no token is ever issued for
    // an id spelled in a way this check refuses.
    const bookingId = parseBookingIdParam(req.params.id);
    // A multipart upload (proof of payment) is authenticated BEFORE multer reads a single byte of the file, so its body is not parsed yet:
    // those requests send the token in a header instead.
    const token = (req.body && req.body.access_token) || req.query.access_token || req.get('x-booking-access-token');
    if (!bookingId || !token) {
        return res.status(401).json({ success: false, message: 'Please verify your booking to continue.', code: 'TOKEN_REQUIRED' });
    }
    getBookingAccessTokenByHash(
        hashAccessToken(token), bookingId,
        (err, row) => {
            if (err || !row) {
                return res.status(401).json({ success: false, message: 'Your verification session has expired. Please verify your booking again.', code: 'TOKEN_REQUIRED' });
            }
            req.trackingEmail = row.email;
            touchBookingAccessToken(row.id);
            next();
        }
    );
}

module.exports = { requireBookingAccessToken };
