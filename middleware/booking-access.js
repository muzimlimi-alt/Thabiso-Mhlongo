// Phase 5 (HOUSEKEEPING-NOTES.md): moved out of the app.js monolith byte-identical, alongside
// requireAdmin's own move to this directory. Verifies req.params.id + a bearer access_token
// (JSON body for POST, query string for GET downloads) against booking_access_tokens. On success
// attaches the verified email as req.trackingEmail — routes trust this, not any client-supplied
// `email` field, for ownership checks. The token itself is high-entropy (32 random bytes), so a
// fast indexed sha256 lookup is appropriate here — unlike the low-entropy OTP code (see
// lib/booking-tracking.js), which is bcrypt-hashed and rate-limited on attempts instead.
const { hashAccessToken } = require('../lib/booking-tracking');
const { getBookingAccessTokenByHash, touchBookingAccessToken } = require('../database/repositories/bookings.repository');

function requireBookingAccessToken(req, res, next) {
    const bookingId = parseInt(req.params.id, 10);
    const token = (req.body && req.body.access_token) || req.query.access_token;
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
