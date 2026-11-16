// Ozow safety net: a buyer who just returned from Ozow can trigger a check against Ozow's own API
// to confirm and record their payment, in case the webhook notification was missed.
// Mirrors routes/public/payfast-check.js — same guards, same response shape.
const express = require('express');
const { ipRateLimiter, trackRateLimiter } = require('../../middleware/rate-limiters');
const { requireBookingAccessToken } = require('../../middleware/booking-access');
const { getBookingByIdAsync } = require('../../database/repositories/bookings.repository');
const ozowReconcile = require('../../lib/ozow-reconcile');
const router = express.Router();

router.post('/api/public/bookings/:id/ozow-check', ipRateLimiter, trackRateLimiter, requireBookingAccessToken, async (req, res) => {
    try {
        const bookingId = parseInt(req.params.id, 10);
        const booking = await getBookingByIdAsync(bookingId);
        if (!booking) return res.status(404).json({ success: false, message: 'Booking not found.' });
        if (String(booking.email || '').trim().toLowerCase() !== String(req.trackingEmail || '').trim().toLowerCase()) {
            return res.status(401).json({ success: false, message: 'Please verify your booking again.', code: 'TOKEN_REQUIRED' });
        }
        const r = await ozowReconcile.reconcileBooking(bookingId);
        let status = 'waiting';
        if (r.recovered && r.recovered.length) status = 'recorded';
        else if (r.skipped === 'throttled') status = 'busy';
        else if (r.skipped === 'already_paid') status = 'recorded';
        else if (r.reason === 'ozow_not_configured') status = 'unavailable';
        else if (r.checked === 0) status = 'nothing';
        else status = 'waiting';
        res.json({ success: true, status });
    } catch (e) {
        console.error('[Ozow payment-check]', e.message);
        res.status(500).json({ success: false, message: 'Something went wrong. Please try again.' });
    }
});

module.exports = router;
