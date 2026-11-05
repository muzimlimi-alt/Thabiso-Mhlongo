// Notification Centre API (docs-internal/notifications.md). The engine that WRITES notifications is lib/notify.js; this file only lists them
// and moves them through their lifecycle for the signed-in admin, via lib/notify-store.js. Every list is filtered on the server by the
// caller's role (administrator: everything; manager: operations; assistant: bookings/enquiries/subscribers) - the browser never decides.
const express = require('express');
const { requireAdmin } = require('../../middleware/auth');
const { requireRole } = require('../../middleware/rbac');
const store = require('../../lib/notify-store');
const notify = require('../../lib/notify');
const jobMonitor = require('../../lib/job-monitor');
const registry = require('../../lib/notify-events');
const router = express.Router();

const who = (req) => ({ id: req.session.adminId, role: req.session.role || 'assistant' });
const wrap = (fn) => (req, res) => fn(req, res).catch((err) => {
    console.error('[notifications api]', err && err.message);
    res.status(500).json({ success: false, message: 'Could not complete that request.' });
});

router.get('/api/admin/notifications', requireAdmin, wrap(async (req, res) => {
    res.json({ success: true, ...(await store.list(who(req), req.query)) });
}));

router.get('/api/admin/notifications/summary', requireAdmin, wrap(async (req, res) => {
    res.json({ success: true, ...(await store.summary(who(req))) });
}));

router.get('/api/admin/notifications/meta', requireAdmin, (req, res) => {
    const role = who(req).role;
    res.json({
        success: true, priorities: registry.PRIORITIES,
        categories: registry.categoriesFor(role).map((c) => ({ category: c, label: registry.CATEGORIES[c].label }))
    });
});

router.post('/api/admin/notifications/read', requireAdmin, wrap(async (req, res) => {
    const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
    const n = await store.setRead(who(req), ids, req.body.read !== false);
    res.json({ success: true, updated: n });
}));

router.post('/api/admin/notifications/read-all', requireAdmin, wrap(async (req, res) => {
    res.json({ success: true, updated: await store.markAllRead(who(req)) });
}));

// (Express 5: no regex inside a route path - the id is validated here. The fixed paths above - summary, meta, read, read-all - are matched first.)
const idOf = (req) => (/^\d{1,12}$/.test(req.params.id) ? Number(req.params.id) : null);

router.get('/api/admin/notifications/:id', requireAdmin, wrap(async (req, res) => {
    const id = idOf(req);
    const n = id === null ? null : await store.get(who(req), id);
    if (!n) return res.status(404).json({ success: false, message: 'Notification not found.' });
    res.json({ success: true, notification: n });
}));

router.post('/api/admin/notifications/:id/:action', requireAdmin, wrap(async (req, res) => {
    const id = idOf(req);
    if (id === null || ['ack', 'resolve', 'archive'].indexOf(req.params.action) < 0) return res.status(404).json({ success: false, message: 'Notification not found.' });
    const r = await store.transition(who(req), id, req.params.action, { note: req.body && req.body.note, req });
    if (!r.ok) return res.status(r.status).json({ success: false, message: r.message });
    res.json({ success: true, notification: r.notification });
}));

router.get('/api/admin/activity', requireAdmin, wrap(async (req, res) => {
    res.json({ success: true, ...(await store.activity(who(req), req.query)) });
}));

// ── preferences: every admin, for themselves ───────────────────────────────────────────────────────────────────────────────────────
router.get('/api/admin/notification-prefs', requireAdmin, wrap(async (req, res) => {
    res.json({ success: true, prefs: await store.getPrefs(who(req)), note: 'Security, financial-integrity and critical system alerts always appear, whatever is switched off here.' });
}));
router.put('/api/admin/notification-prefs', requireAdmin, wrap(async (req, res) => {
    const n = await store.setPrefs(who(req), req.body && req.body.prefs);
    res.json({ success: true, updated: n, prefs: await store.getPrefs(who(req)) });
}));

// ── business-wide rules, recipients, thresholds: administrator only ────────────────────────────────────────────────────────────────
const ADMIN = requireRole(['administrator']);
router.get('/api/admin/notification-rules', requireAdmin, ADMIN, wrap(async (req, res) => {
    res.json({ success: true, rules: await store.getRules() });
}));
router.put('/api/admin/notification-rules/:event', requireAdmin, ADMIN, wrap(async (req, res) => {
    const r = await store.setRule(who(req), req.params.event, req.body || {});
    if (!r.ok) return res.status(r.status).json({ success: false, message: r.message });
    res.json({ success: true, rules: await store.getRules() });
}));
router.get('/api/admin/notification-settings', requireAdmin, ADMIN, wrap(async (req, res) => {
    res.json({ success: true, settings: await store.getSettings() });
}));
router.put('/api/admin/notification-settings', requireAdmin, ADMIN, wrap(async (req, res) => {
    const r = await store.setSettings(req.body || {});
    if (!r.ok) return res.status(400).json({ success: false, errors: r.errors, message: 'Some settings could not be saved.' });
    res.json({ success: true, settings: await store.getSettings() });
}));

// ── the expiry list (compliance_items; lib/compliance-monitor.js sends the staged reminders) ─────────────────────────────────────────
// Administrators and managers keep it; only an administrator deletes. Every change is audited and re-checked at once.
const compliance = require('../../lib/compliance-monitor');
const { logAudit } = require('../../lib/audit-log');
const { dbRun, dbGet } = require('../../lib/db-helpers');
const OPS = requireRole(['administrator', 'manager']);
router.get('/api/admin/compliance-items', requireAdmin, OPS, wrap(async (req, res) => {
    res.json({ success: true, ...(await compliance.listItems()) });
}));
router.post('/api/admin/compliance-items', requireAdmin, OPS, wrap(async (req, res) => {
    const v = compliance.validateItem(req.body || {});
    if (Object.keys(v.errors).length) return res.status(400).json({ success: false, errors: v.errors, message: Object.values(v.errors)[0] });
    const ts = new Date().toISOString();
    const r = await dbRun(`INSERT INTO compliance_items (kind, name, reference, expiry_date, notes, is_active, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [v.clean.kind, v.clean.name, v.clean.reference, v.clean.expiry_date, v.clean.notes, v.clean.is_active, req.session.adminId, req.session.adminId, ts, ts]);
    logAudit({ tableName: 'compliance_items', recordId: r.lastID, action: 'create', req, newValues: v.clean }).catch(() => {});
    compliance.runComplianceCheck().catch(() => {});
    res.json({ success: true, id: r.lastID, ...(await compliance.listItems()) });
}));
router.put('/api/admin/compliance-items/:id', requireAdmin, OPS, wrap(async (req, res) => {
    const id = /^\d{1,12}$/.test(req.params.id) ? Number(req.params.id) : null;
    const before = id ? await dbGet('SELECT * FROM compliance_items WHERE id = ?', [id]) : null;
    if (!before) return res.status(404).json({ success: false, message: 'Item not found.' });
    const v = compliance.validateItem({ ...before, ...(req.body || {}) });
    if (Object.keys(v.errors).length) return res.status(400).json({ success: false, errors: v.errors, message: Object.values(v.errors)[0] });
    await dbRun(`UPDATE compliance_items SET kind = ?, name = ?, reference = ?, expiry_date = ?, notes = ?, is_active = ?, updated_by = ?, updated_at = ? WHERE id = ?`,
        [v.clean.kind, v.clean.name, v.clean.reference, v.clean.expiry_date, v.clean.notes, v.clean.is_active, req.session.adminId, new Date().toISOString(), id]);
    logAudit({ tableName: 'compliance_items', recordId: id, action: 'update', req, oldValues: before, newValues: v.clean }).catch(() => {});
    compliance.runComplianceCheck().catch(() => {});
    res.json({ success: true, ...(await compliance.listItems()) });
}));
router.delete('/api/admin/compliance-items/:id', requireAdmin, ADMIN, wrap(async (req, res) => {
    const id = /^\d{1,12}$/.test(req.params.id) ? Number(req.params.id) : null;
    const before = id ? await dbGet('SELECT * FROM compliance_items WHERE id = ?', [id]) : null;
    if (!before) return res.status(404).json({ success: false, message: 'Item not found.' });
    await dbRun('DELETE FROM compliance_items WHERE id = ?', [id]);
    logAudit({ tableName: 'compliance_items', recordId: id, action: 'delete', req, oldValues: before }).catch(() => {});
    compliance.runComplianceCheck().catch(() => {});
    res.json({ success: true, ...(await compliance.listItems()) });
}));

// ── system health (jobs, queue, open alerts) ───────────────────────────────────────────────────────────────────────────────────────
router.get('/api/admin/system-health', requireAdmin, ADMIN, wrap(async (req, res) => {
    res.json({ success: true, ...(await jobMonitor.health()) });
}));

// ── browser errors from the admin portal ────────────────────────────────────────────────────────────────────────────────────────────
// Signed-in admins only (the public site would be a spam target) and capped per session, so a render loop cannot flood the log.
const clientErrorBudget = new Map();   // adminId -> { windowStart, n }
router.post('/api/admin/client-errors', requireAdmin, (req, res) => {
    const id = String(req.session.adminId);
    const now = Date.now();
    const b = clientErrorBudget.get(id);
    if (!b || now - b.windowStart > 60000) clientErrorBudget.set(id, { windowStart: now, n: 1 });
    else if (++b.n > 20) return res.status(204).end();
    const body = req.body || {};
    const message = String(body.message || 'Script error').slice(0, 300);
    const source = String(body.source || '').slice(0, 200);
    const page = String(body.page || '').replace(/[?#].*$/, '').slice(0, 120);
    notify.emit('system.client_error', { fingerprint: notify.fingerprint(message, source, body.line), message, source: source ? `${source}${body.line ? ':' + Number(body.line) : ''}` : '', page: page || 'the admin portal' }, { req });
    res.status(204).end();
});

module.exports = router;
