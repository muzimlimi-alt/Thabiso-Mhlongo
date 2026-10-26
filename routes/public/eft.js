// Manual EFT - the client's side (docs-internal/eft-payments.md): upload a proof of payment, and open one's own proof.
// What the client is offered (the banking details, the reference, their earlier submissions) arrives with the booking on POST .../track.
//
// Every route here sits behind requireBookingAccessToken - the same e-mailed-code session every other action on a booking needs - so a proof
// can only ever be sent for, or read from, the booking the person has proven they own. Uploading never credits anything (lib/eft.js).
const express = require('express');
const multer = require('multer');
const { ipRateLimiter, trackRateLimiter, popUploadRateLimiter } = require('../../middleware/rate-limiters');
const { requireBookingAccessToken } = require('../../middleware/booking-access');
const { getBookingByIdAsync } = require('../../database/repositories/bookings.repository');
const eft = require('../../lib/eft');
const core = require('../../lib/eft-core');
const notify = require('../../lib/eft-notifications');
const router = express.Router();

// Authenticated BEFORE multer reads the file (the token travels in the x-booking-access-token header), size-capped by the administrator's limit.
function receiveProof(req, res, next) {
    eft.getEftSettings().then((settings) => {
        const upload = multer({
            storage: multer.memoryStorage(),
            limits: { fileSize: settings.max_upload_mb * 1024 * 1024, files: 1, fields: 8, parts: 10 }
        }).single('proof');
        upload(req, res, (err) => {
            if (!err) return next();
            if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ success: false, message: `That file is too large. The limit is ${settings.max_upload_mb} MB.` });
            return res.status(400).json({ success: false, message: 'The upload could not be read. Please attach a single PDF, JPG or PNG.' });
        });
    }).catch((e) => { console.error('[EFT upload]', e.message); res.status(500).json({ success: false, message: 'Something went wrong. Please try again.' }); });
}

router.post('/api/public/bookings/:id/eft/proof', popUploadRateLimiter, ipRateLimiter, requireBookingAccessToken, receiveProof, async (req, res) => {
    try {
        const booking = await getBookingByIdAsync(req.params.id);
        if (!booking) return res.status(404).json({ success: false, message: 'Booking not found.' });
        // the token proves the e-mail; it must still be this booking's own
        if (String(booking.email || '').trim().toLowerCase() !== String(req.trackingEmail || '').trim().toLowerCase()) {
            return res.status(401).json({ success: false, message: 'Please verify your booking again.', code: 'TOKEN_REQUIRED' });
        }
        const result = await eft.createSubmission({
            booking, email: req.trackingEmail, ip: req.ip,
            file: req.file ? { buffer: req.file.buffer, mimetype: req.file.mimetype, originalname: req.file.originalname } : null,
            fields: req.body || {}
        });
        if (!result.ok) return res.status(result.status).json({ success: false, message: result.message, errors: result.errors });

        const reference = core.paymentReference(booking.id, result.invoice && result.invoice.invoice_number);
        notify.sendProofReceivedEmail(booking, result.submission, reference).catch(e => console.error('[EFT] Received email failed:', e.message));
        notify.sendAdminProofNotification(booking, result.submission).catch(e => console.error('[EFT] Admin alert failed:', e.message));
        res.json({
            success: true,
            message: 'Thank you - we have received your proof of payment. Your booking will be updated once we have verified it. This is not yet a confirmation of payment.',
            submission: eft.clientView(result.submission)
        });
    } catch (e) {
        console.error('[EFT upload]', e.message);
        res.status(500).json({ success: false, message: 'We could not save your proof of payment. Please try again.' });
    }
});

// The client's own file back. A submission on any other booking is "not found" - the answer never reveals that it exists.
router.get('/api/public/bookings/:id/eft/proof/:sid', ipRateLimiter, trackRateLimiter, requireBookingAccessToken, async (req, res) => {
    try {
        const sub = await eft.getSubmission(req.params.sid);
        if (!sub || sub.booking_id !== parseInt(req.params.id, 10)) return res.status(404).json({ success: false, message: 'Proof of payment not found.' });
        const doc = await eft.openProofFile(sub);
        if (!doc) return res.status(404).json({ success: false, message: 'Proof of payment not found.' });
        const ext = (core.PROOF_TYPES[sub.proof_mime] || {}).ext || 'bin';
        res.setHeader('Content-Type', sub.proof_mime);
        res.setHeader('Content-Disposition', `attachment; filename="proof-of-payment-${sub.id}.${ext}"`);
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Cache-Control', 'private, no-store');
        if (doc.stream) doc.stream.pipe(res); else res.sendFile(doc.diskPath);
    } catch (e) {
        console.error('[EFT download]', e.message);
        res.status(500).json({ success: false, message: 'Something went wrong. Please try again.' });
    }
});

module.exports = router;
