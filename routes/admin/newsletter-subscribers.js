const express = require('express');
const crypto = require('crypto');
const multer = require('multer');
const { requireAdmin } = require('../../middleware/auth');
const { requireRole } = require('../../middleware/rbac');
const {
    countSubscribers, listSubscribers, getSubscriberStats, insertSubscriberManual, updateSubscriberProfile,
    getSubscriberForStatusToggle, updateSubscriberStatus, deleteSubscriber, bulkUpdateSubscriberStatus,
    bulkConfirmPendingSubscribers, getPendingSubscribersForBulkActivate, bulkDeleteSubscribers,
    updateSubscriberFromCsvRow, insertSubscriberFromCsvRow,
} = require('../../database/repositories/newsletter.repository');
const { sanitizeEmailInput, isValidBirthday } = require('../../lib/validation');
const { resolveActor } = require('../../lib/actor');
const { sendNewsletterWelcomeEmail } = require('../../lib/newsletter-emails');
const { withDbTransaction } = require('../../lib/db-transaction');
const { dbRun } = require('../../lib/db-helpers');
// Only used by the CSV import route below — no other call site, so defined locally rather than
// added to the shared lib/uploads.js (which holds the admin image-upload instance).
const subscriberCsvUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
const router = express.Router();

// Get all subscribers
router.get('/api/admin/newsletter/subscribers', requireAdmin, (req, res) => {
    // Generic sortable-column pair (matches the Users table's own sort convention) rather than a
    // fixed enum — this is an admin-only internal API with one caller (the Subscribers tab), so
    // there's no other consumer's contract to preserve.
    const sortColumns = { email: 'LOWER(email)', first_name: 'LOWER(COALESCE(first_name, \'\'))', subscribed_at: 'subscribed_at', status: 'status', birthday: 'birthday' };
    const page = Math.max(1, parseInt(req.query.page) || 1);
    // Honour a client-supplied limit (capped) so the "Export All" path can request the full list.
    const limit = Math.min(Math.max(1, parseInt(req.query.limit) || 50), 100000);
    const offset = (page - 1) * limit;
    const sortCol = sortColumns[req.query.sort] ? req.query.sort : 'subscribed_at';
    const sortDir = req.query.order === 'ASC' ? 'ASC' : 'DESC';
    const search = (req.query.search || '').trim();

    // Birthday is two columns with NULLs (no birthday on file) always sorted last, regardless of direction.
    const orderClause = sortCol === 'birthday'
        ? `(birthday_month IS NULL) ASC, birthday_month ${sortDir}, birthday_day ${sortDir}`
        : `${sortColumns[sortCol]} ${sortDir}`;

    const conditions = [];
    const qp = [];
    if (search) {
        conditions.push("(LOWER(email) LIKE LOWER(?) OR LOWER(first_name) LIKE LOWER(?))");
        qp.push(`%${search}%`, `%${search}%`);
    }
    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    countSubscribers(whereClause, qp, (err, countRow) => {
        if (err) return res.status(500).json({ success: false, message: err.message });
        listSubscribers(whereClause, orderClause, [...qp, limit, offset], (err2, rows) => {
            if (err2) return res.status(500).json({ success: false, message: err2.message });
            const total = countRow.total;
            res.json({ success: true, subscribers: rows, total, page, pages: Math.ceil(total / limit) });
        });
    });
});

// KPI stats for the Subscribers tab — kept as its own lightweight endpoint (three small COUNTs)
// rather than folded into the paginated list response, which would recompute them on every page
// turn/search for no reason.
router.get('/api/admin/newsletter/subscribers/stats', requireAdmin, (req, res) => {
    getSubscriberStats(
        (err, row) => {
            if (err) return res.status(500).json({ success: false, message: err.message });
            res.json({
                success: true,
                stats: { total: row.total || 0, active: row.active || 0, new_7d: row.new_7d || 0 }
            });
        }
    );
});

// Add a subscriber manually
router.post('/api/admin/newsletter/subscribers', requireAdmin, requireRole(['administrator', 'manager']), (req, res) => {
    const { email } = req.body;
    const first_name = (typeof req.body.first_name === 'string') ? sanitizeEmailInput(req.body.first_name).slice(0, 100) : null;
    if (!email) return res.status(400).json({ success: false, message: 'Email is required' });

    const ip_address = req.ip || req.connection.remoteAddress || 'unknown';
    const user_agent = req.get('User-Agent') || 'unknown';
    const source = 'admin_dashboard';
    const adminId = req.session.adminId;

    const unsubscribe_token = crypto.randomBytes(16).toString('hex');

    // Need to insert both 'status' and 'active' to maintain backwards compatibility
    insertSubscriberManual(email, unsubscribe_token, ip_address, user_agent, source, adminId, first_name || null, function(err) {
        if (err) {
            console.error("DEBUG ERROR ADDING SUBSCRIBER MANUAL:", err);
            if (err.message.includes('UNIQUE')) {
                 return res.status(409).json({ success: false, message: 'This email is already subscribed!' });
            }
            return res.status(500).json({ success: false, message: 'Server error adding subscriber' });
        }
        res.json({ success: true, message: 'Subscriber added successfully.', subscriber_id: this.lastID });
    });
});

// Update a subscriber's personalization/profile fields — kept separate from the status-toggle
// endpoint below since that one is already wired to bulk actions and shouldn't be overloaded.
router.put('/api/admin/newsletter/subscribers/:id', requireAdmin, requireRole(['administrator', 'manager']), (req, res) => {
    const subscriberId = req.params.id;
    const adminId = req.session.adminId;

    // Partial update: only fields actually present in the request are written. A caller (e.g. a
    // birthday-only edit) that omits first_name/tags/internal_notes must not wipe them to NULL.
    const setClauses = [];
    const params = [];

    if (typeof req.body.first_name === 'string') {
        setClauses.push('first_name = ?');
        params.push(sanitizeEmailInput(req.body.first_name).slice(0, 100) || null);
    }
    if (typeof req.body.internal_notes === 'string') {
        setClauses.push('internal_notes = ?');
        params.push(req.body.internal_notes.slice(0, 2000));
    }
    if (Array.isArray(req.body.tags)) {
        setClauses.push('tags = ?');
        params.push(JSON.stringify(req.body.tags.map(t => String(t).trim()).filter(Boolean)));
    }
    const hasDay = req.body.birthday_day != null && req.body.birthday_day !== '';
    const hasMonth = req.body.birthday_month != null && req.body.birthday_month !== '';
    if (hasDay || hasMonth) {
        if (!hasDay || !hasMonth || !isValidBirthday(req.body.birthday_day, req.body.birthday_month)) {
            return res.status(400).json({ success: false, message: 'Please provide both a valid birthday day and month.' });
        }
        setClauses.push('birthday_day = ?', 'birthday_month = ?');
        params.push(parseInt(req.body.birthday_day, 10), parseInt(req.body.birthday_month, 10));
    } else if ('birthday_day' in req.body || 'birthday_month' in req.body) {
        // Both keys present but empty/null — an explicit clear (matches the edit drawer's own
        // "Day"/"Month" blank-option behavior), not an omission.
        setClauses.push('birthday_day = NULL', 'birthday_month = NULL');
    }

    if (!setClauses.length) return res.json({ success: true, message: 'Nothing to update.' });

    setClauses.push('modified_on = CURRENT_TIMESTAMP', 'modified_by = ?');
    params.push(adminId, subscriberId);

    updateSubscriberProfile(setClauses, params, async function(err) {
        if (err) return res.status(500).json({ success: false, message: err.message });
        if (this.changes === 0) return res.status(404).json({ success: false, message: 'Subscriber not found' });
        const actor = await resolveActor(adminId);
        res.json({ success: true, message: 'Subscriber updated successfully.', last_updated: { name: actor.name, role: actor.role, at: new Date().toISOString() } });
    });
});

// (D9) Removed duplicate DELETE /api/admin/newsletter/subscribers/:id — the canonical copy
// with the 404-on-no-change guard lives below ("Delete subscriber permanently").

// Toggle subscriber status (Active/Inactive)
router.put('/api/admin/newsletter/subscribers/:id/status', requireAdmin, requireRole(['administrator', 'manager']), (req, res) => {
    const subscriberId = req.params.id;
    const { status } = req.body; // Expects 'active' or 'inactive'
    const adminId = req.session.adminId;

    if (!status || (status !== 'active' && status !== 'inactive')) {
        return res.status(400).json({ success: false, message: 'Invalid status' });
    }

    getSubscriberForStatusToggle(subscriberId, (selErr, row) => {
        if (selErr) return res.status(500).json({ success: false, error: selErr.message });
        if (!row) return res.status(404).json({ success: false, message: 'Subscriber not found' });

        // An admin force-activating a still-pending row should behave the same as the subscriber
        // confirming it themselves: get counted as active AND receive the real welcome email.
        const wasPending = row.status === 'pending_confirmation' && status === 'active';
        const confirmedAtClause = wasPending ? ", confirmed_at = CURRENT_TIMESTAMP" : "";

        updateSubscriberStatus(confirmedAtClause, status, status === 'active' ? 1 : 0, adminId, subscriberId, function(err) {
            if (err) return res.status(500).json({ success: false, error: err.message });
            if (this.changes === 0) return res.status(404).json({ success: false, message: 'Subscriber not found' });
            if (wasPending) sendNewsletterWelcomeEmail(row.email, row.first_name, row.unsubscribe_token).catch(e => console.error('Error sending welcome email to ' + row.email + ':', e));
            res.json({ success: true, message: `Subscriber marked as ${status}` });
        });
    });
});

// Delete subscriber permanently
router.delete('/api/admin/newsletter/subscribers/:id', requireAdmin, requireRole(['administrator']), (req, res) => {
    const subscriberId = req.params.id;

    deleteSubscriber(subscriberId, function(err) {
        if (err) return res.status(500).json({ success: false, error: err.message });
        if (this.changes === 0) return res.status(404).json({ success: false, message: 'Subscriber not found' });
        res.json({ success: true, message: 'Subscriber deleted permanently' });
    });
});

// Bulk Toggle Subscriber Status
router.put('/api/admin/newsletter/subscribers/bulk-status', requireAdmin, requireRole(['administrator', 'manager']), (req, res) => {
    const { ids, status } = req.body;
    const adminId = req.session.adminId;

    if (!ids || !Array.isArray(ids) || !ids.length) {
        return res.status(400).json({ success: false, message: 'Invalid or empty IDs array' });
    }
    if (!status || (status !== 'active' && status !== 'inactive')) {
        return res.status(400).json({ success: false, message: 'Invalid status' });
    }

    const placeholders = ids.map(() => '?').join(',');

    const runBulkUpdate = (pendingRows) => {
        bulkUpdateSubscriberStatus(placeholders, status, status === 'active' ? 1 : 0, adminId, ids, function(err) {
            if (err) return res.status(500).json({ success: false, error: err.message });
            if (pendingRows.length) {
                const pendingPlaceholders = pendingRows.map(() => '?').join(',');
                bulkConfirmPendingSubscribers(pendingPlaceholders, pendingRows.map(r => r.subscriber_id), () => {});
                pendingRows.forEach(r => sendNewsletterWelcomeEmail(r.email, r.first_name, r.unsubscribe_token).catch(e => console.error('Error sending welcome email to ' + r.email + ':', e)));
            }
            res.json({ success: true, message: `${this.changes} subscribers marked as ${status}` });
        });
    };

    if (status === 'active') {
        // Same reasoning as the single-toggle endpoint: any row that was still pending
        // confirmation gets the real welcome email + confirmed_at, batched.
        getPendingSubscribersForBulkActivate(placeholders, ids, (selErr, pendingRows) => {
            if (selErr) return res.status(500).json({ success: false, error: selErr.message });
            runBulkUpdate(pendingRows || []);
        });
    } else {
        runBulkUpdate([]);
    }
});

// Bulk Delete Subscribers
router.post('/api/admin/newsletter/subscribers/bulk-delete', requireAdmin, requireRole(['administrator']), (req, res) => {
    const { ids } = req.body;

    if (!ids || !Array.isArray(ids) || !ids.length) {
        return res.status(400).json({ success: false, message: 'Invalid or empty IDs array' });
    }

    const placeholders = ids.map(() => '?').join(',');

    bulkDeleteSubscribers(placeholders, ids, function(err) {
        if (err) return res.status(500).json({ success: false, error: err.message });
        res.json({ success: true, message: `${this.changes} subscribers deleted permanently` });
    });
});

// Bulk Import Subscribers via CSV
router.post('/api/admin/newsletter/subscribers/import', requireAdmin, requireRole(['administrator', 'manager']), subscriberCsvUpload.single('csv'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ success: false, message: 'No file uploaded' });
    }

    const adminId = req.session.adminId;

    try {
        const fileContent = req.file.buffer.toString('utf-8');
        const lines = fileContent.split(/\r?\n/);

        if (lines.length < 2) {
             return res.json({ success: false, message: 'File is empty or has no data rows' });
        }

        const headers = lines[0].toLowerCase().split(',').map(h => h.trim());
        const emailIdx = headers.indexOf('email');
        const statusIdx = headers.indexOf('status');
        const firstNameIdx = headers.indexOf('first_name');
        // Day/month-only, format MM-DD (e.g. "07-14") — never a year, matching the schema.
        const birthdayIdx = headers.indexOf('birthday');
        // Semicolon-separated: this importer's line.split(',') has no quoted-field support, so a
        // comma inside a tags cell would misalign every column after it.
        const tagsIdx = headers.indexOf('tags');

        if (emailIdx === -1) {
            return res.status(400).json({ success: false, message: 'Missing "email" column in header' });
        }

        let successCount = 0;
        let updateCount = 0;
        let errorCount = 0;
        let processedCount = 0;

        // Queued behind the other guarded transactions on the shared connection: a CSV import that
        // ran while a booking was mid-transaction used to fail with "cannot start a transaction
        // within a transaction", and its statements could be swept into the booking's rollback.
        const outcome = await withDbTransaction(async () => {
            try {
                await dbRun("BEGIN IMMEDIATE");
            } catch (beginErr) {
                console.error('[CSV Import] BEGIN IMMEDIATE failed:', beginErr.message);
                return { status: 500, body: { success: false, message: 'Database busy. Please retry.' } };
            }
            try {
                for (let i = 1; i < lines.length; i++) {
                    const line = lines[i].trim();
                    if (!line) continue;

                    const cols = line.split(',');
                    const email = (cols[emailIdx] || '').trim();
                    let status = statusIdx !== -1 ? (cols[statusIdx] || '').trim().toLowerCase() : 'active';
                    const firstName = firstNameIdx !== -1 ? (cols[firstNameIdx] || '').trim() : '';
                    const tagsRaw = tagsIdx !== -1 ? (cols[tagsIdx] || '').trim() : '';
                    const tagsJson = tagsRaw ? JSON.stringify(tagsRaw.split(';').map(t => t.trim()).filter(Boolean)) : null;

                    let birthdayDay = null, birthdayMonth = null;
                    if (birthdayIdx !== -1) {
                        const m = (cols[birthdayIdx] || '').trim().match(/^(\d{1,2})-(\d{1,2})$/);
                        if (m && isValidBirthday(m[2], m[1])) {
                            birthdayMonth = parseInt(m[1], 10);
                            birthdayDay = parseInt(m[2], 10);
                        }
                        // Malformed birthday values are ignored (left unset), not treated as a row error.
                    }

                    if (!status || (status !== 'active' && status !== 'inactive')) status = 'active';

                    if (!email || !email.includes('@')) {
                        errorCount++;
                        continue;
                    }

                    const unsubscribe_token = crypto.randomBytes(16).toString('hex');
                    const active = status === 'active' ? 1 : 0;

                    processedCount++;

                    // A malformed row is counted and skipped, as before — one bad line must not
                    // roll back an otherwise good import.
                    try {
                        const upd = await updateSubscriberFromCsvRow(status, firstName, birthdayDay, birthdayMonth, tagsJson, adminId, email);
                        if (upd.changes > 0) {
                            updateCount++;
                        } else {
                            await insertSubscriberFromCsvRow(email, status, active, unsubscribe_token, adminId, firstName || null, birthdayDay, birthdayMonth, tagsJson);
                            successCount++;
                        }
                    } catch (rowErr) {
                        errorCount++;
                    }
                }

                await dbRun("COMMIT");
                return { ok: true };
            } catch (txErr) {
                await dbRun("ROLLBACK").catch(() => {});
                console.error('[CSV Import] Failed — rolled back, no subscribers imported:', txErr.message);
                return { status: 500, body: { success: false, message: 'Transaction failed: ' + txErr.message } };
            }
        });

        if (!outcome.ok) return res.status(outcome.status).json(outcome.body);

        res.json({
            success: true,
            message: `Import complete: ${successCount} added, ${updateCount} updated, ${errorCount} failed.`
        });

    } catch (e) {
        res.status(500).json({ success: false, message: 'Server error: ' + e.message });
    }
});

module.exports = router;
