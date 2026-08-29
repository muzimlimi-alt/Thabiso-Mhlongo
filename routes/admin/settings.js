const express = require('express');
const db = require('../../database');
const { requireAdmin } = require('../../middleware/auth');
const { requireRole } = require('../../middleware/rbac');
const { bookingConfig } = require('../../lib/booking-config');
const {
    getMinBookingGapSetting, getTypeBuffersSetting, saveMinBookingGapMinutes, saveTypeBuffers,
    getAllSettings, upsertSetting,
} = require('../../database/repositories/settings.repository');
const router = express.Router();

// Admin — read per-day working hours
router.get('/api/admin/working-hours', requireAdmin, (req, res) => {
    db.all("SELECT day_of_week, start_time, end_time, is_working_day FROM working_hours ORDER BY day_of_week", [], (err, rows) => {
        if (err) return res.status(500).json({ success: false, error: err.message });
        getMinBookingGapSetting((err2, gapRow) => {
            getTypeBuffersSetting((err3, tbRow) => {
                let type_buffers = {};
                if (!err3 && tbRow) { try { type_buffers = JSON.parse(tbRow.setting_value) || {}; } catch(e) {} }
                res.json({
                    success: true,
                    schedule: rows || [],
                    min_booking_gap_minutes: (!err2 && gapRow) ? parseInt(gapRow.setting_value) || 30 : 30,
                    type_buffers
                });
            });
        });
    });
});

// Admin — save per-day working hours + gap
router.put('/api/admin/working-hours', requireAdmin, (req, res) => {
    const { schedule, min_booking_gap_minutes, type_buffers } = req.body;
    if (!Array.isArray(schedule) || schedule.length !== 7) {
        return res.status(400).json({ success: false, message: 'schedule must be an array of 7 day objects.' });
    }
    const timeRe = /^\d{2}:\d{2}$/;
    for (const d of schedule) {
        if (typeof d.day_of_week !== 'number' || d.day_of_week < 0 || d.day_of_week > 6) {
            return res.status(400).json({ success: false, message: `Invalid day_of_week: ${d.day_of_week}` });
        }
        if (!timeRe.test(d.start_time) || !timeRe.test(d.end_time)) {
            return res.status(400).json({ success: false, message: `start_time/end_time must be HH:MM for day ${d.day_of_week}` });
        }
    }
    const gap = parseInt(min_booking_gap_minutes);
    if (isNaN(gap) || gap < 0) {
        return res.status(400).json({ success: false, message: 'min_booking_gap_minutes must be a non-negative integer.' });
    }
    const safeTypeBuffers = (type_buffers && typeof type_buffers === 'object') ? type_buffers : {};
    db.serialize(() => {
        schedule.forEach(d => {
            db.run(
                `INSERT INTO working_hours (day_of_week, start_time, end_time, is_working_day)
                 VALUES (?, ?, ?, ?)
                 ON CONFLICT(day_of_week) DO UPDATE SET
                     start_time = excluded.start_time,
                     end_time   = excluded.end_time,
                     is_working_day = excluded.is_working_day`,
                [d.day_of_week, d.start_time, d.end_time, d.is_working_day ? 1 : 0]
            );
        });
        saveMinBookingGapMinutes(String(gap));
        saveTypeBuffers(JSON.stringify(safeTypeBuffers), (err) => {
                if (err) return res.status(500).json({ success: false, error: err.message });
                bookingConfig.minGapMins = gap;
                bookingConfig.typeBuffers = safeTypeBuffers;
                res.json({ success: true, message: 'Working hours saved.' });
            });
    });
});

// --- Audit Log Retrieval ---
// P3-16: Pass ?include_financial=true to merge financial_audit_log entries into the response.
router.get('/api/admin/audit_log', requireAdmin, (req, res) => {
    const limit = parseInt(req.query.limit) || 100;
    const page = req.query.page ? parseInt(req.query.page) : null;
    const offset = page ? (page - 1) * limit : (parseInt(req.query.offset) || 0);
    const table = req.query.table || null;
    // A bare record_id without a table is meaningless — ids aren't unique across tables, only
    // (table_name, record_id) pairs are (idx_audit_table_record is keyed on both).
    const recordId = (req.query.record_id && table) ? parseInt(req.query.record_id) : null;
    const dateFrom = req.query.date_from || null;
    const dateTo = req.query.date_to || null;
    const search = req.query.search || '';
    const sort = req.query.sort || 'change_timestamp';
    const order = req.query.order || 'DESC';
    const includeFinancial = req.query.include_financial === 'true';

    let conditions = [];
    let params = [];
    if (table) { conditions.push("audit_log.table_name = ?"); params.push(table); }
    if (recordId) { conditions.push("audit_log.record_id = ?"); params.push(recordId); }
    if (dateFrom) { conditions.push("date(audit_log.change_timestamp) >= ?"); params.push(dateFrom); }
    if (dateTo) { conditions.push("date(audit_log.change_timestamp) <= ?"); params.push(dateTo); }
    if (search) {
        conditions.push("(audit_log.table_name LIKE ? OR audit_log.action LIKE ? OR audit_log.changed_by LIKE ? OR actor.full_name LIKE ? OR actor.username LIKE ?)");
        params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
    }
    const whereString = conditions.length ? " WHERE " + conditions.join(" AND ") : "";

    const allowedSortCols = ['change_timestamp', 'table_name', 'action'];
    const safeSort = allowedSortCols.includes(sort) ? sort : 'change_timestamp';
    const safeOrder = String(order).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    // LEFT JOIN admins purely to resolve a readable actor name for the numeric-id changed_by
    // convention (all newly-touched "Last Updated By" routes, plus events' pre-existing rows) —
    // guarded to only match when changed_by is actually numeric, so literal values like 'system'/
    // 'public'/an email address never accidentally match an admin id.
    const fromJoin = " FROM audit_log LEFT JOIN admins actor ON audit_log.changed_by GLOB '[0-9]*' AND CAST(audit_log.changed_by AS INTEGER) = actor.id";
    const dataQuery = "SELECT audit_log.*, actor.full_name AS actor_full_name, actor.username AS actor_username" + fromJoin + whereString + " ORDER BY " + safeSort + " " + safeOrder + " LIMIT ? OFFSET ?";
    const dataParams = params.concat([limit, offset]);

    db.all(dataQuery, dataParams, (err, rows) => {
        if (err) { console.error('audit_log query failed:', err); return res.status(500).json({ success: false, message: 'Could not load the audit trail. Please try again.' }); }
        if (!includeFinancial) {
            db.get("SELECT COUNT(*) AS total" + fromJoin + whereString, params, (cErr, cRow) => {
                const total = cErr ? (rows || []).length : (parseInt(cRow && cRow.total) || 0);
                return res.json({ success: true, logs: rows || [], total: total, page: page || 1, totalPages: Math.ceil(total / limit) || 1 });
            });
            return;
        }

        // Merge financial_audit_log rows — normalise to same shape as audit_log
        let finConditions = [];
        let finParams = [];
        if (dateFrom) { finConditions.push("date(timestamp) >= ?"); finParams.push(dateFrom); }
        if (dateTo)   { finConditions.push("date(timestamp) <= ?"); finParams.push(dateTo); }
        const finQuery = `SELECT id, event_type AS action, entity_type AS table_name, entity_id AS record_id,
                                  NULL AS old_values, notes AS new_values, changed_by, timestamp AS change_timestamp,
                                  amount, 'financial' AS log_source
                          FROM financial_audit_log` +
            (finConditions.length ? ' WHERE ' + finConditions.join(' AND ') : '') +
            ' ORDER BY timestamp DESC LIMIT 500';

        db.all(finQuery, finParams, (fErr, finRows) => {
            const auditRows = (rows || []).map(r => ({ ...r, log_source: 'audit' }));
            const merged = [...auditRows, ...(fErr ? [] : (finRows || []))]
                .sort((a, b) => new Date(b.change_timestamp) - new Date(a.change_timestamp))
                .slice(0, limit);
            res.json({ success: true, logs: merged, financial_log_error: fErr ? fErr.message : null });
        });
    });
});

// P3-16: Dedicated financial_audit_log endpoint (separate from main audit_log)
router.get('/api/admin/financial_audit_log', requireAdmin, requireRole(['administrator', 'manager']), (req, res) => {
    const limit = parseInt(req.query.limit) || 100;
    const offset = parseInt(req.query.offset) || 0;
    const dateFrom = req.query.date_from || null;
    const dateTo   = req.query.date_to   || null;

    let conditions = [];
    let params = [];
    if (dateFrom) { conditions.push("date(timestamp) >= ?"); params.push(dateFrom); }
    if (dateTo)   { conditions.push("date(timestamp) <= ?"); params.push(dateTo); }
    params.push(limit, offset);

    db.all(
        `SELECT * FROM financial_audit_log${conditions.length ? ' WHERE ' + conditions.join(' AND ') : ''} ORDER BY timestamp DESC LIMIT ? OFFSET ?`,
        params,
        (err, rows) => {
            if (err) return res.status(500).json({ success: false, error: err.message });
            res.json({ success: true, logs: rows || [] });
        }
    );
});

// --- Policies ---
router.get('/api/admin/policies', requireAdmin, (req, res) => {
    db.all("SELECT policy_key, policy_value FROM policies", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        const obj = {};
        (rows || []).forEach(r => { obj[r.policy_key] = r.policy_value; });
        res.json({ success: true, policies: obj });
    });
});

router.put('/api/admin/policies', requireAdmin, (req, res) => {
    const { policies } = req.body;
    if (!policies || typeof policies !== 'object') return res.status(400).json({ error: 'policies object required.' });
    const keys = Object.keys(policies);
    let pending = keys.length;
    if (pending === 0) return res.json({ success: true });
    let failed = false;
    keys.forEach(key => {
        db.run("INSERT OR REPLACE INTO policies (policy_key, policy_value, updated_at) VALUES (?,?,CURRENT_TIMESTAMP)",
            [key, String(policies[key])], (err) => {
                if (err && !failed) { failed = true; return res.status(500).json({ error: err.message }); }
                if (--pending === 0 && !failed) res.json({ success: true });
            });
    });
});

// --- Settings ---
router.get('/api/admin/settings', requireAdmin, (req, res) => {
    getAllSettings((err, rows) => {
        if (err) { console.error('load settings failed:', err); return res.status(500).json({ success: false, message: 'Could not load settings. Please try again.' }); }
        const obj = {};
        (rows || []).forEach(r => { obj[r.setting_key] = r.setting_value; });
        // Merge env-only keys so the frontend can read them (read-only exposure)
        if (process.env.CALENDAR_FEED_SECRET) obj.CALENDAR_FEED_SECRET = process.env.CALENDAR_FEED_SECRET;
        res.json({ success: true, settings: obj });
    });
});

router.put('/api/admin/settings', requireAdmin, (req, res) => {
    const { settings } = req.body;
    if (!settings || typeof settings !== 'object') return res.status(400).json({ error: 'settings object required.' });
    const envMap = {
        payfast_merchant_id: 'PAYFAST_MERCHANT_ID', payfast_merchant_key: 'PAYFAST_MERCHANT_KEY',
        payfast_passphrase: 'PAYFAST_PASSPHRASE', payfast_url: 'PAYFAST_URL',
        smtp_host: 'SMTP_HOST', smtp_port: 'SMTP_PORT', smtp_user: 'SMTP_USER',
        smtp_pass: 'SMTP_PASS', smtp_from: 'SMTP_FROM',
        email_banner: 'EMAIL_BANNER'
    };
    const keys = Object.keys(settings);
    let pending = keys.length;
    if (pending === 0) return res.json({ success: true });
    let failed = false;
    keys.forEach(key => {
        const val = String(settings[key]);
        if (val !== null && val !== undefined && val !== '') {
            if (envMap[key]) process.env[envMap[key]] = val;
        }
        upsertSetting(key, val, (err) => {
                if (err && !failed) { failed = true; console.error('save settings failed:', err); return res.status(500).json({ success: false, message: 'Could not save settings. Please try again.' }); }
                if (--pending === 0 && !failed) res.json({ success: true });
            });
    });
});

module.exports = router;
