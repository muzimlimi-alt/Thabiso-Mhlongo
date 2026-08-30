const express = require('express');
const db = require('../../database');
const { requireAdmin } = require('../../middleware/auth');
const { requireRole } = require('../../middleware/rbac');
const { exportRateLimiter } = require('../../middleware/rate-limiters');
const { sendAbandonedBookingReminderEmail } = require('../../lib/abandoned-booking-email');
const router = express.Router();

// ---- Admin: list abandoned bookings (search / filter / sort / paginate) ----
router.get('/api/admin/abandoned-bookings', requireAdmin, (req, res) => {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 25));
    const offset = (page - 1) * limit;
    const status = (req.query.status || 'all').toString();
    const stage = (req.query.stage || 'all').toString();
    const search = (req.query.search || '').toString().trim();
    const sort = (req.query.sort || 'recent').toString();

    const where = [], params = [];
    if (status && status !== 'all') { where.push('status = ?'); params.push(status.toUpperCase()); }
    if (stage && stage !== 'all') { where.push('furthest_step = ?'); params.push(parseInt(stage) || 1); }
    if (search) { where.push('(name LIKE ? OR email LIKE ? OR event_name LIKE ? OR event_type LIKE ?)'); const s = `%${search}%`; params.push(s, s, s, s); }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const orderSql = sort === 'oldest' ? 'last_activity_at ASC'
        : sort === 'value' ? 'est_value DESC'
        : sort === 'reminders' ? 'reminders_sent DESC'
        : 'last_activity_at DESC';

    const cols = `id, name, company, email, cell, event_name, event_date, event_type, event_location, current_step, furthest_step,
                  consent_given, status, reminders_sent, last_reminder_at, last_activity_at, created_at, converted_booking_id, opt_out, source, est_value`;
    db.get(`SELECT COUNT(*) AS total FROM abandoned_bookings ${whereSql}`, params, (err, countRow) => {
        if (err) return res.status(500).json({ success: false, message: 'DB error' });
        const total = countRow ? countRow.total : 0;
        db.all(`SELECT ${cols} FROM abandoned_bookings ${whereSql} ORDER BY ${orderSql} LIMIT ? OFFSET ?`,
            [...params, limit, offset], (err2, rows) => {
                if (err2) return res.status(500).json({ success: false, message: 'DB error' });
                res.json({ success: true, items: rows || [], total, page, pages: Math.max(1, Math.ceil(total / limit)) });
            });
    });
});

// ---- Admin: recovery statistics (registered before /:id) ----
router.get('/api/admin/abandoned-bookings/stats', requireAdmin, (req, res) => {
    db.all(`SELECT status, COUNT(*) AS c, COALESCE(SUM(est_value),0) AS v FROM abandoned_bookings GROUP BY status`, [], (err, rows) => {
        if (err) return res.status(500).json({ success: false });
        const byStatus = {}; let total = 0, openValue = 0;
        (rows || []).forEach(r => { byStatus[r.status] = { count: r.c, value: r.v }; total += r.c; });
        const recovered = (byStatus.RECOVERED?.count || 0) + (byStatus.WON?.count || 0);
        ['ABANDONED', 'REMINDED'].forEach(s => { if (byStatus[s]) openValue += byStatus[s].value; });
        db.all(`SELECT furthest_step, COUNT(*) AS c FROM abandoned_bookings GROUP BY furthest_step`, [], (e2, frows) => {
            const funnel = { 1: 0, 2: 0, 3: 0, 4: 0 };
            (frows || []).forEach(r => { funnel[r.furthest_step] = r.c; });
            res.json({ success: true, stats: {
                total,
                abandoned: byStatus.ABANDONED?.count || 0,
                reminded: byStatus.REMINDED?.count || 0,
                recovered,
                won: byStatus.WON?.count || 0,
                lost: byStatus.LOST?.count || 0,
                closed: byStatus.CLOSED?.count || 0,
                conversion_rate: total > 0 ? Math.round((recovered / total) * 1000) / 10 : 0,
                est_lost_value: Math.round(openValue * 100) / 100,
                funnel
            }});
        });
    });
});

// ---- Admin: CSV export (registered before /:id) ----
router.get('/api/admin/abandoned-bookings/export', requireAdmin, exportRateLimiter, (req, res) => {
    const cols = ['id', 'name', 'company', 'email', 'cell', 'event_name', 'event_date', 'event_type', 'event_location', 'current_step', 'furthest_step', 'consent_given', 'status', 'reminders_sent', 'last_reminder_at', 'last_activity_at', 'created_at', 'converted_booking_id', 'opt_out', 'source', 'est_value'];
    db.all(`SELECT ${cols.join(', ')} FROM abandoned_bookings ORDER BY last_activity_at DESC`, [], (err, rows) => {
        if (err) return res.status(500).send('Export failed');
        const escapeCsv = (v) => { if (v == null) return ''; const s = String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
        const csv = [cols.join(',')].concat((rows || []).map(r => cols.map(c => escapeCsv(r[c])).join(','))).join('\n');
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="abandoned-bookings-${new Date().toISOString().slice(0, 10)}.csv"`);
        res.send(csv);
    });
});

// ---- Admin: single draft detail ----
router.get('/api/admin/abandoned-bookings/:id', requireAdmin, (req, res) => {
    db.get(`SELECT * FROM abandoned_bookings WHERE id=?`, [req.params.id], (err, row) => {
        if (err || !row) return res.status(404).json({ success: false, message: 'Not found' });
        try { row.services = row.services_json ? JSON.parse(row.services_json) : []; } catch (e) { row.services = []; }
        res.json({ success: true, item: row });
    });
});

// ---- Admin: manually resend a reminder (admin-initiated; respects opt-out) ----
router.post('/api/admin/abandoned-bookings/:id/resend-reminder', requireAdmin, requireRole(['administrator', 'manager']), (req, res) => {
    db.get(`SELECT * FROM abandoned_bookings WHERE id=?`, [req.params.id], async (err, row) => {
        if (err || !row) return res.status(404).json({ success: false, message: 'Not found' });
        if (row.opt_out) return res.status(400).json({ success: false, message: 'This contact has opted out of reminders.' });
        if (!row.email) return res.status(400).json({ success: false, message: 'No email on this draft.' });
        const ok = await sendAbandonedBookingReminderEmail(row);
        if (!ok) return res.status(502).json({ success: false, message: 'Email could not be sent.' });
        db.run(`UPDATE abandoned_bookings SET reminders_sent=reminders_sent+1, last_reminder_at=CURRENT_TIMESTAMP,
                    status=CASE WHEN status='ABANDONED' THEN 'REMINDED' ELSE status END WHERE id=?`,
            [req.params.id], () => res.json({ success: true, message: 'Reminder sent.' }));
    });
});

// ---- Admin: mark as won / lost / closed (or re-open to abandoned) ----
router.put('/api/admin/abandoned-bookings/:id/status', requireAdmin, requireRole(['administrator', 'manager']), (req, res) => {
    const allowed = ['WON', 'LOST', 'CLOSED', 'ABANDONED'];
    const status = (req.body.status || '').toString().toUpperCase();
    if (!allowed.includes(status)) return res.status(400).json({ success: false, message: 'Invalid status.' });
    db.run(`UPDATE abandoned_bookings SET status=? WHERE id=?`, [status, req.params.id], function (err) {
        if (err) return res.status(500).json({ success: false });
        res.json({ success: true, message: 'Status updated.' });
    });
});

module.exports = router;
