// Administrator / manager controls for the Microsoft 365 calendar integration (lib/calendar-m365.js). Mounted by routes/admin/calendar.js.
// Setup, permissions, conflict rules and troubleshooting: docs-internal/calendar-m365.md.
//   read (any signed-in admin role)      status strip, list of entries needing attention, one entry's sync panel
//   administrator                        switch the sync on / off (verify-before-enable), test calendar access, read the sync log
//   administrator or manager             sync now, retry a failed entry, resolve a conflict, re-create a deleted entry
const express = require('express');
const { requireAdmin } = require('../../middleware/auth');
const { requireRole } = require('../../middleware/rbac');
const { logAudit } = require('../../lib/audit-log');
const graph = require('../../lib/m365-graph');
const sync = require('../../lib/calendar-m365');
const router = express.Router();
const adminOnly = [requireAdmin, requireRole(['administrator'])];
const managerUp = [requireAdmin, requireRole(['administrator', 'manager'])];
const fail = (res, e, what) => { console.error('calendar-sync ' + what + ' failed:', e && e.message); res.status(500).json({ success: false, message: 'The calendar sync request could not be completed.' }); };
const entryId = (req) => { const n = Number(req.params.id); return Number.isInteger(n) && n > 0 ? n : null; };

router.get('/api/admin/calendar-sync', requireAdmin, async (req, res) => {
    try { res.json({ success: true, ...(await sync.getStatus()) }); } catch (e) { fail(res, e, 'status'); }
});

// "Test calendar access": checks the SAVED settings only (no form values, so no secret travels in the request): Graph sign-in, reading the shared
// calendar, and creating + removing one invisible test event (the only proof that write permission is in force). A failed check is a normal
// result (HTTP 200, ok:false), exactly like Test Connection.
router.post('/api/admin/calendar-sync/test', ...adminOnly, async (req, res) => {
    try { res.json({ success: true, ...(await graph.diagnoseCalendar()) }); } catch (e) { fail(res, e, 'test'); }
});

// Switch on / off. Switching ON is verify-before-enable: the app must first prove it can sign in AND write to the calendar - otherwise nothing changes and the
// administrator is told which step failed and what to do.
router.put('/api/admin/calendar-sync', ...adminOnly, async (req, res) => {
    const enabled = req.body && req.body.enabled;
    if (typeof enabled !== 'boolean') return res.status(400).json({ success: false, message: '"enabled" must be true or false.' });
    try {
        if (enabled) {
            const check = await graph.diagnoseCalendar();
            if (!check.ok) {
                const failed = check.steps.find((s) => !s.ok);
                return res.status(422).json({ success: false, message: 'The calendar sync was NOT switched on - the check failed. ' + (failed ? failed.message : ''), steps: check.steps });
            }
        }
        const change = await sync.setEnabled(enabled, req.session.adminId);
        logAudit({ tableName: 'calendar_sync_state', recordId: 1, action: 'update', req, oldValues: { enabled: change.before }, newValues: { enabled: change.after } })
            .catch((e) => console.error('logAudit failed:', e.message));
        if (enabled) sync.requestSync('switched on');
        res.json({ success: true, ...(await sync.getStatus()) });
    } catch (e) { fail(res, e, 'switch'); }
});

// "Sync now": one run immediately, ignoring the back-off. Only while the sync is switched on (switching it on is what proves the connection).
router.post('/api/admin/calendar-sync/run', ...managerUp, async (req, res) => {
    try {
        const status = await sync.getStatus();
        if (!status.enabled) return res.status(409).json({ success: false, message: 'The Microsoft 365 calendar sync is switched off. An administrator can switch it on (this checks the connection).' });
        await sync.logSync({ direction: 'admin', action: 'run_now', outcome: 'ok', actorId: req.session.adminId });
        const result = await sync.runSync({ force: true });
        res.json({ success: true, result: { ok: !!result.ok, skipped: result.skipped || null, category: result.category || null, error: result.error || null, stats: result.stats || null }, status: await sync.getStatus() });
    } catch (e) { fail(res, e, 'run'); }
});

// What the sync did and why (administrator only, like the other diagnostics): the first place to look when an entry will not sync.
router.get('/api/admin/calendar-sync/log', ...adminOnly, async (req, res) => {
    try { res.json({ success: true, entries: await sync.recentLog(req.query.limit) }); } catch (e) { fail(res, e, 'log'); }
});

router.get('/api/admin/calendar-sync/entries', requireAdmin, async (req, res) => {
    try {
        const status = ['pending', 'synced', 'error', 'conflict', 'external_deleted', 'removed'].includes(req.query.status) ? req.query.status : null;
        const sourceType = ['booking', 'event'].includes(req.query.type) ? req.query.type : null;
        res.json({ success: true, entries: await sync.listEntries({ status, sourceType, limit: req.query.limit, offset: req.query.offset }) });
    } catch (e) { fail(res, e, 'list'); }
});

router.get('/api/admin/calendar-sync/entry', requireAdmin, async (req, res) => {
    const id = Number(req.query.id);
    if (!['booking', 'event'].includes(req.query.type) || !Number.isInteger(id) || id <= 0) return res.status(400).json({ success: false, message: 'type (booking or event) and id are required.' });
    try { res.json({ success: true, entry: await sync.getEntry(req.query.type, id) }); } catch (e) { fail(res, e, 'entry'); }
});

const action = (name, fn) => router.post('/api/admin/calendar-sync/entries/:id/' + name, ...managerUp, async (req, res) => {
    const id = entryId(req);
    if (!id) return res.status(400).json({ success: false, message: 'A valid entry id is required.' });
    try {
        const out = await fn(id, req);
        if (!out.ok) return res.status(out.status || 400).json({ success: false, message: out.message });
        sync.requestSync('admin action');
        res.json({ success: true, entry: sync.publicLink(out.link) });
    } catch (e) { fail(res, e, name); }
});
action('retry', (id, req) => sync.retryLink(id, req.session.adminId));
action('recreate', (id, req) => sync.recreateLink(id, req.session.adminId));
action('resolve', (id, req) => sync.resolveConflict(id, req.body && req.body.choice, req.session.adminId, { applyExternalSchedule: sync.applyExternalSchedule }));

module.exports = router;
