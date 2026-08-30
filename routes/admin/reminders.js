const express = require('express');
const db = require('../../database');
const { requireAdmin } = require('../../middleware/auth');
const { runPaymentReminderJob } = require('../../lib/payment-reminders');
const router = express.Router();

// ========================================
// PAYMENT REMINDERS LOG ENDPOINTS
// ========================================

router.get('/api/admin/reminders', requireAdmin, (req, res) => {
    const limit = parseInt(req.query.limit) || 100;
    const booking_id = req.query.booking_id ? parseInt(req.query.booking_id) : null;
    let query = `
        SELECT r.*, b.name AS client_name, b.event_name, b.email AS client_email
        FROM reminders_log r
        LEFT JOIN bookings b ON b.id = r.booking_id
        ${booking_id ? 'WHERE r.booking_id = ?' : ''}
        ORDER BY r.sent_at DESC LIMIT ?
    `;
    const params = booking_id ? [booking_id, limit] : [limit];
    db.all(query, params, (err, rows) => {
        if (err) return res.status(500).json({ success: false, message: err.message });
        res.json({ success: true, reminders: rows || [] });
    });
});

router.post('/api/admin/reminders/run', requireAdmin, async (req, res) => {
    try {
        const result = await runPaymentReminderJob();
        res.json({ success: true, sent: result.sent, skipped: result.skipped, errors: result.errors });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

module.exports = router;
