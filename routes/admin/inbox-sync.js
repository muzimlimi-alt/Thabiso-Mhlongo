// Administrator controls for reading customer replies from the booking mailbox (lib/inbox-sync.js). Mounted by routes/admin/inquiries.js.
// Every route is administrator-only: switching this on lets the site read a mailbox, which is the same level of trust as the Email (SMTP) settings.
const express = require('express');
const { requireAdmin } = require('../../middleware/auth');
const { requireRole } = require('../../middleware/rbac');
const { logAudit } = require('../../lib/audit-log');
const inboxSync = require('../../lib/inbox-sync');
const graph = require('../../lib/m365-graph');
const router = express.Router();
const adminOnly = [requireAdmin, requireRole(['administrator'])];

router.get('/api/admin/inbox-sync', ...adminOnly, async (req, res) => {
    try { res.json({ success: true, ...(await inboxSync.getStatus()) }); }
    catch (e) { console.error('inbox-sync status failed:', e.message); res.status(500).json({ success: false, message: 'The sync status could not be loaded.' }); }
});

// Switch on / off. Switching ON is verify-before-enable (like saving the SMTP settings): the app must first prove it can sign in to Microsoft Graph and read
// the inbox - otherwise nothing changes and the administrator is told which step failed and what to do.
router.put('/api/admin/inbox-sync', ...adminOnly, async (req, res) => {
    const enabled = req.body && req.body.enabled;
    if (typeof enabled !== 'boolean') return res.status(400).json({ success: false, message: '"enabled" must be true or false.' });
    try {
        if (enabled) {
            const check = await graph.diagnose();
            if (!check.ok) {
                const failed = check.steps.find((s) => !s.ok);
                return res.status(422).json({ success: false, message: 'Reading the mailbox was NOT switched on - the check failed. ' + (failed ? failed.message : ''), steps: check.steps });
            }
        }
        const change = await inboxSync.setEnabled(enabled, req.session.adminId);
        logAudit({ tableName: 'inbox_sync_state', recordId: 1, action: 'update', req, oldValues: { enabled: change.before }, newValues: { enabled: change.after } })
            .catch((e) => console.error('logAudit failed:', e.message));
        res.json({ success: true, ...(await inboxSync.getStatus()) });
    } catch (e) {
        console.error('inbox-sync switch failed:', e.message);
        res.status(500).json({ success: false, message: 'The setting could not be saved.' });
    }
});

// "Sync now": one run immediately, ignoring the back-off. Only while the sync is switched on (switching it on is what proves the connection).
router.post('/api/admin/inbox-sync/run', ...adminOnly, async (req, res) => {
    try {
        const status = await inboxSync.getStatus();
        if (!status.enabled) return res.status(409).json({ success: false, message: 'Reading the mailbox is switched off. Switch it on first (this checks the connection).' });
        const result = await inboxSync.runSync({ force: true });
        res.json({ success: true, result, status: await inboxSync.getStatus() });
    } catch (e) {
        console.error('inbox-sync run failed:', e.message);
        res.status(500).json({ success: false, message: 'The sync could not be run.' });
    }
});

module.exports = router;
