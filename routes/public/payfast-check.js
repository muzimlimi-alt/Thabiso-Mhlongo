// A buyer has just come back from PayFast to their booking page: ask the safety net (lib/payfast-reconcile.js) to confirm THEIR payment with PayFast's own
// records now, instead of waiting for a notification that may be late or lost. Behind the same e-mailed-code session as every other action on a booking, so a
// person can only ever ask about the booking they have proven they own; it only looks at that booking's own pending payment attempts, is throttled per
// booking and per address, and answers with a status word - never an amount, a PayFast id or anything from PayFast's records.
const express = require('express');
const { ipRateLimiter, trackRateLimiter } = require('../../middleware/rate-limiters');
const { requireBookingAccessToken } = require('../../middleware/booking-access');
const { getBookingByIdAsync } = require('../../database/repositories/bookings.repository');
const reconcile = require('../../lib/payfast-reconcile');
const router = express.Router();

router.post('/api/public/bookings/:id/payment-check', ipRateLimiter, trackRateLimiter, requireBookingAccessToken, async (req, res) => {
    try {
        const bookingId = parseInt(req.params.id, 10);
        const booking = await getBookingByIdAsync(bookingId);
        if (!booking) return res.status(404).json({ success: false, message: 'Booking not found.' });
        // the token proves the e-mail; it must still be this booking's own
        if (String(booking.email || '').trim().toLowerCase() !== String(req.trackingEmail || '').trim().toLowerCase()) {
            return res.status(401).json({ success: false, message: 'Please verify your booking again.', code: 'TOKEN_REQUIRED' });
        }
        const r = await reconcile.reconcileNow({ reason: 'buyer-return', bookingId, minIntentAgeSeconds: reconcile.RETURN_MIN_AGE_SECONDS });
        let status = 'waiting';
        if (r.recovered && r.recovered.length) status = 'recorded';
        else if (r.skipped === 'throttled' || r.skipped === 'busy') status = 'busy';
        else if (r.skipped || r.checked === 0) status = 'nothing';
        else if (r.ok === false) status = 'unavailable';
        res.json({ success: true, status });
    } catch (e) {
        console.error('[PayFast payment-check]', e.message);
        res.status(500).json({ success: false, message: 'Something went wrong. Please try again.' });
    }
});

module.exports = router;
