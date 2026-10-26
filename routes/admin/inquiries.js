const express = require('express');
const db = require('../../database');
const { requireAdmin } = require('../../middleware/auth');
const { requireRole } = require('../../middleware/rbac');
const { resolveActor } = require('../../lib/actor');
const {
    countInquiriesByStatus, countMyInquiries, countInquiries, updateInquiryStatus,
    unassignInquiry, assignInquiry, updateInquiryPriority, listInquiryCategories, updateInquiryCategory,
    listInquiryNotes, insertInquiryNote, getInquiryNoteById, deleteInquiryNote,
    bulkUpdateInquiryStatus, bulkDeleteInquiries, deleteInquiry,
} = require('../../database/repositories/inquiries.repository');
const { getAssignableAdmins, checkAdminActiveById, getAdminDisplayNameById } = require('../../database/repositories/auth-users.repository');
const inquiryMessages = require('../../lib/inquiry-messages');
const { sendDirectEmail } = require('../../lib/direct-emails');
const router = express.Router();
// Customer-replies-from-the-mailbox controls (administrator only) live in their own file; mounted here so this stays the one place the Inquiries API is wired up.
router.use(require('./inbox-sync'));

// --- Inquiries ---
router.get('/api/admin/inquiries', requireAdmin, (req, res) => {
    const validStatuses = ['all', 'unread', 'read', 'replied', 'archived'];
    const validSorts = ['newest', 'oldest', 'name'];
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
    const offset = (page - 1) * limit;
    const statusFilter = validStatuses.includes(req.query.status) ? req.query.status : 'all';
    const sortBy = validSorts.includes(req.query.sort) ? req.query.sort : 'newest';
    const search = (req.query.search || '').trim();
    const category = (req.query.category || '').trim();

    const orderClause = sortBy === 'oldest' ? 'submitted_at ASC' :
                        sortBy === 'name' ? "LOWER(COALESCE(sender_name,'')) ASC" :
                        'submitted_at DESC';

    const conditions = [];
    const qp = [];
    if (statusFilter !== 'all') { conditions.push("status = ?"); qp.push(statusFilter); }
    if (category) { conditions.push("category = ?"); qp.push(category); }
    if (req.query.mine === '1') {
        conditions.push("assigned_to = ?"); qp.push(req.session.adminId);
    } else if (req.query.assigned_to) {
        const assignedTo = parseInt(req.query.assigned_to);
        if (!isNaN(assignedTo)) { conditions.push("assigned_to = ?"); qp.push(assignedTo); }
    }
    const validPriorities = ['low', 'normal', 'high', 'urgent'];
    if (validPriorities.includes(req.query.priority)) { conditions.push("priority = ?"); qp.push(req.query.priority); }
    if (search) {
        conditions.push("(LOWER(sender_name) LIKE LOWER(?) OR LOWER(sender_email) LIKE LOWER(?) OR LOWER(COALESCE(subject,'')) LIKE LOWER(?) OR LOWER(COALESCE(message_body,'')) LIKE LOWER(?))");
        const term = `%${search}%`;
        qp.push(term, term, term, term);
    }
    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    // Folder badge counts are global totals (independent of current filter/search).
    db.get("SELECT policy_value FROM policies WHERE policy_key = 'inquiry_response_sla_hours'", [], (errS, slaRow) => {
        const slaHours = (!errS && slaRow && parseInt(slaRow.policy_value) > 0) ? parseInt(slaRow.policy_value) : 24;
        // overdue: still awaiting a first response and past the SLA window — purely derived at query
        // time from submitted_at vs the policy value, no background job needed.
        const dataSql = `SELECT inquiries.*, COALESCE(admins.full_name, admins.username) AS assigned_to_name,
                                 CASE WHEN status IN ('unread','read') AND submitted_at < datetime('now', '-' || ? || ' hours') THEN 1 ELSE 0 END AS overdue,
                                 (SELECT m.delivery_status FROM inquiry_messages m WHERE m.inquiry_id = inquiries.inquiry_id AND m.direction = 'out' ORDER BY m.id DESC LIMIT 1) AS last_reply_status,
                                 (SELECT COUNT(*) FROM inquiry_messages m WHERE m.inquiry_id = inquiries.inquiry_id AND m.direction = 'in') AS inbound_count
                          FROM inquiries LEFT JOIN admins ON admins.id = inquiries.assigned_to
                          ${whereClause} ORDER BY ${orderClause} LIMIT ? OFFSET ?`;

        countInquiriesByStatus((errC, countRows) => {
        if (errC) return res.status(500).json({ success: false, message: errC.message });
        const counts = { all: 0, unread: 0, read: 0, replied: 0, archived: 0, drafts: 0, scheduled: 0, mine: 0 };
        (countRows || []).forEach(r => {
            if (counts.hasOwnProperty(r.status)) counts[r.status] = r.c;
            counts.all += r.c;
        });

        // Query direct_emails count for drafts & scheduled
        db.all("SELECT status, COUNT(*) AS c FROM direct_emails GROUP BY status", [], (errD, directRows) => {
            if (!errD && directRows) {
                directRows.forEach(r => {
                    if (r.status === 'draft') counts.drafts = r.c;
                    if (r.status === 'scheduled') counts.scheduled = r.c;
                });
            }

            countMyInquiries(req.session.adminId, (errM, mineRow) => {
                if (!errM && mineRow) counts.mine = mineRow.c;

            countInquiries(whereClause, qp, (err, countRow) => {
                if (err) return res.status(500).json({ success: false, message: err.message });
                db.all(dataSql, [slaHours, ...qp, limit, offset], (err2, rows) => {
                    if (err2) return res.status(500).json({ success: false, message: err2.message });
                    const total = countRow.total;
                    res.json({ success: true, inquiries: rows, counts, total, page, pages: Math.ceil(total / limit), sla_hours: slaHours });
                });
            });
            });
        });
        });
    });
});

router.put('/api/admin/inquiries/:id/status', requireAdmin, requireRole(['administrator', 'manager']), (req, res) => {
    const { status } = req.body;
    const validStatuses = ['unread', 'read', 'replied', 'archived'];
    if (!validStatuses.includes(status)) {
        return res.status(400).json({ success: false, message: 'Invalid status.' });
    }
    updateInquiryStatus(status, req.params.id, function(err) {
        if (err) return res.status(500).json({ success: false, message: err.message });
        res.json({ success: true });
    });
});

// Active admins eligible to be assigned an inquiry (deliberately narrower than /api/admin/users,
// which is administrator-only and returns full PII) — any authenticated admin can view the list.
router.get('/api/admin/inquiries/assignable-admins', requireAdmin, (req, res) => {
    getAssignableAdmins((err, rows) => {
        if (err) return res.status(500).json({ success: false, message: err.message });
        res.json({ success: true, admins: rows });
    });
});

router.put('/api/admin/inquiries/:id/assign', requireAdmin, requireRole(['administrator', 'manager']), (req, res) => {
    const { assigned_to } = req.body;
    if (assigned_to === null || assigned_to === undefined || assigned_to === '') {
        return unassignInquiry(req.session.adminId, req.session.role || null, req.params.id, async function(err) {
            if (err) return res.status(500).json({ success: false, message: err.message });
            const actor = await resolveActor(req.session.adminId);
            res.json({ success: true, last_updated: { name: actor.name, role: actor.role, at: new Date().toISOString() } });
        });
    }
    const targetId = parseInt(assigned_to);
    if (isNaN(targetId)) return res.status(400).json({ success: false, message: 'Invalid assignee.' });
    checkAdminActiveById(targetId, (err, row) => {
        if (err) return res.status(500).json({ success: false, message: err.message });
        if (!row) return res.status(400).json({ success: false, message: 'Assignee must be an active admin.' });
        assignInquiry(targetId, req.session.adminId, req.session.role || null, req.params.id, async function(err2) {
            if (err2) return res.status(500).json({ success: false, message: err2.message });
            const actor = await resolveActor(req.session.adminId);
            res.json({ success: true, last_updated: { name: actor.name, role: actor.role, at: new Date().toISOString() } });
        });
    });
});

router.put('/api/admin/inquiries/:id/priority', requireAdmin, requireRole(['administrator', 'manager']), (req, res) => {
    const { priority } = req.body;
    const validPriorities = ['low', 'normal', 'high', 'urgent'];
    if (!validPriorities.includes(priority)) {
        return res.status(400).json({ success: false, message: 'Invalid priority.' });
    }
    updateInquiryPriority(priority, req.session.adminId, req.session.role || null, req.params.id, async function(err) {
        if (err) return res.status(500).json({ success: false, message: err.message });
        const actor = await resolveActor(req.session.adminId);
        res.json({ success: true, last_updated: { name: actor.name, role: actor.role, at: new Date().toISOString() } });
    });
});

// Distinct previously-used categories, for the tag/category autocomplete datalist.
router.get('/api/admin/inquiries/categories', requireAdmin, (req, res) => {
    listInquiryCategories((err, rows) => {
        if (err) return res.status(500).json({ success: false, message: err.message });
        res.json({ success: true, categories: (rows || []).map(r => r.category) });
    });
});

router.put('/api/admin/inquiries/:id/category', requireAdmin, (req, res) => {
    const category = (req.body.category || '').trim().slice(0, 100);
    updateInquiryCategory(category || null, req.session.adminId, req.session.role || null, req.params.id, async function(err) {
        if (err) return res.status(500).json({ success: false, message: err.message });
        const actor = await resolveActor(req.session.adminId);
        res.json({ success: true, last_updated: { name: actor.name, role: actor.role, at: new Date().toISOString() } });
    });
});

router.get('/api/admin/inquiries/:id/notes', requireAdmin, (req, res) => {
    listInquiryNotes(
        req.params.id,
        (err, rows) => {
            if (err) return res.status(500).json({ success: false, message: err.message });
            res.json({ success: true, notes: rows || [] });
        }
    );
});

router.post('/api/admin/inquiries/:id/notes', requireAdmin, (req, res) => {
    const { note } = req.body;
    if (!note || !note.trim()) return res.status(400).json({ success: false, message: 'Note text is required.' });
    // Author/created_by derive from the session rather than trusting client input.
    getAdminDisplayNameById(req.session.adminId, (err0, adminRow) => {
        const author = (adminRow && adminRow.name) || req.session.username || 'Admin';
        insertInquiryNote(
            req.params.id, note.trim(), author, req.session.adminId,
            function(err) {
                if (err) return res.status(500).json({ success: false, message: err.message });
                getInquiryNoteById(this.lastID, (e, row) => {
                    res.json({ success: true, note: row });
                });
            }
        );
    });
});

router.delete('/api/admin/inquiries/:id/notes/:noteId', requireAdmin, (req, res) => {
    deleteInquiryNote(
        req.params.noteId, req.params.id,
        function(err) {
            if (err) return res.status(500).json({ success: false, message: err.message });
            if (this.changes === 0) return res.status(404).json({ success: false, message: 'Note not found.' });
            res.json({ success: true });
        }
    );
});

// --- Conversation: the admin's replies (with their real delivery state) and the customer's answers read from the mailbox ---
const toId = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };
const dbGet = (sql, params = []) => new Promise((resolve, reject) => db.get(sql, params, (e, r) => e ? reject(e) : resolve(r)));
const dbAll = (sql, params = []) => new Promise((resolve, reject) => db.all(sql, params, (e, r) => e ? reject(e) : resolve(r)));

// The two mails a website submission queued (lib/contact-intake.js), as the outbox sees them. Same vocabulary as a reply's delivery state:
// queued -> attempted (a try failed, retrying) -> accepted (Microsoft 365 took it) | failed. The inquiry being saved is a separate fact from these.
function intakeState(rows, entity) {
    const n = rows.filter((r) => r.related_entity === entity).pop();
    if (!n) return null;
    const state = n.status === 'sent' ? 'accepted' : n.status === 'failed' ? 'failed' : (n.retry_count > 0 || n.error_message) ? 'attempted' : 'queued';
    return { state, to: n.recipient_email, at: n.sent_at || n.created_at, error: state === 'failed' || state === 'attempted' ? (n.error_message || null) : null };
}

router.get('/api/admin/inquiries/:id/messages', requireAdmin, async (req, res) => {
    const id = toId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: 'Invalid inquiry.' });
    try {
        const inquiry = await dbGet('SELECT inquiry_id, source FROM inquiries WHERE inquiry_id = ?', [id]);
        if (!inquiry) return res.status(404).json({ success: false, message: 'Inquiry not found.' });
        await inquiryMessages.reconcileDelivery();   // so the state shown is the outbox's latest, not the last sweep's
        const messages = await inquiryMessages.listForInquiry(id);
        const intakeRows = await dbAll("SELECT related_entity, status, retry_count, error_message, recipient_email, sent_at, created_at FROM notifications WHERE related_id = ? AND related_entity IN ('inquiry_intake', 'inquiry_receipt') ORDER BY id", [id]);
        res.json({
            success: true, source: inquiry.source || 'web_form', messages,
            intake: { notification: intakeState(intakeRows, 'inquiry_intake'), receipt: intakeState(intakeRows, 'inquiry_receipt') },
            pending: messages.some((m) => m.direction === 'out' && (m.delivery_status === 'queued' || m.delivery_status === 'attempted'))
                || [intakeState(intakeRows, 'inquiry_intake'), intakeState(intakeRows, 'inquiry_receipt')].some((x) => x && (x.state === 'queued' || x.state === 'attempted'))
        });
    } catch (e) {
        console.error('inquiry messages failed:', e.message);
        res.status(500).json({ success: false, message: 'The conversation could not be loaded.' });
    }
});

// Send a FAILED reply again (same conversation row, new outbox entry). Both ids must belong together - a forged pair is a 404.
router.post('/api/admin/inquiries/:id/messages/:mid/retry', requireAdmin, requireRole(['administrator', 'manager']), async (req, res) => {
    const id = toId(req.params.id), mid = toId(req.params.mid);
    if (!id || !mid) return res.status(400).json({ success: false, message: 'Invalid request.' });
    try {
        await inquiryMessages.reconcileDelivery();
        const msg = await dbGet('SELECT id, direction, delivery_status, direct_email_id FROM inquiry_messages WHERE id = ? AND inquiry_id = ?', [mid, id]);
        if (!msg) return res.status(404).json({ success: false, message: 'Message not found.' });
        if (msg.direction !== 'out' || msg.delivery_status !== 'failed') return res.status(409).json({ success: false, message: 'Only a reply that failed can be sent again.' });
        const draft = msg.direct_email_id ? await dbGet('SELECT id FROM direct_emails WHERE id = ?', [msg.direct_email_id]) : null;
        if (!draft) return res.status(409).json({ success: false, message: 'The original draft no longer exists - please write the reply again.' });
        await new Promise((resolve) => db.run("UPDATE direct_emails SET status = 'failed' WHERE id = ? AND status = 'sent'", [draft.id], () => resolve()));
        await sendDirectEmail(draft.id, { id: req.session.adminId }, { retryMessageId: msg.id });
        res.json({ success: true, queued: true, message: 'Reply queued again.' });
    } catch (e) {
        console.error('inquiry reply retry failed:', e.message);
        res.status(500).json({ success: false, message: 'The reply could not be queued: ' + e.message });
    }
});

router.put('/api/admin/inquiries/bulk-status', requireAdmin, requireRole(['administrator', 'manager']), (req, res) => {
    const { ids, status } = req.body;
    const validStatuses = ['read', 'unread', 'replied', 'archived'];
    if (!Array.isArray(ids) || !ids.length) {
        return res.status(400).json({ success: false, message: 'No messages specified.' });
    }
    if (!validStatuses.includes(status)) {
        return res.status(400).json({ success: false, message: 'Invalid status.' });
    }
    const cleanIds = ids.map(x => parseInt(x)).filter(x => !isNaN(x));
    if (!cleanIds.length) {
        return res.status(400).json({ success: false, message: 'No valid message IDs.' });
    }
    const ph = cleanIds.map(() => '?').join(',');
    bulkUpdateInquiryStatus(ph, status, cleanIds, function(err) {
        if (err) return res.status(500).json({ success: false, message: err.message });
        const label = status.charAt(0).toUpperCase() + status.slice(1);
        res.json({ success: true, message: `${this.changes} message(s) marked as ${label}` });
    });
});

router.post('/api/admin/inquiries/bulk-delete', requireAdmin, requireRole(['administrator']), (req, res) => {
    const { ids } = req.body;
    if (!Array.isArray(ids) || !ids.length) {
        return res.status(400).json({ success: false, message: 'No messages specified.' });
    }
    const cleanIds = ids.map(x => parseInt(x)).filter(x => !isNaN(x));
    if (!cleanIds.length) {
        return res.status(400).json({ success: false, message: 'No valid message IDs.' });
    }
    const ph = cleanIds.map(() => '?').join(',');
    bulkDeleteInquiries(ph, cleanIds, function(err) {
        if (err) return res.status(500).json({ success: false, message: err.message });
        res.json({ success: true, message: `${this.changes} message(s) deleted` });
    });
});

router.delete('/api/admin/inquiries/:id', requireAdmin, requireRole(['administrator']), (req, res) => {
    deleteInquiry(req.params.id, function(err) {
        if (err) return res.status(500).json({ success: false, message: err.message });
        res.json({ success: true });
    });
});

module.exports = router;
