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
const router = express.Router();

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
                                 CASE WHEN status IN ('unread','read') AND submitted_at < datetime('now', '-' || ? || ' hours') THEN 1 ELSE 0 END AS overdue
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
