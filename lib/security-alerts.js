// Sign-in alerts for the Notification Centre (docs-internal/notifications.md). Every failed admin sign-in is recorded in the Activity Log; three or
// more for the same account within 15 minutes raise ONE "repeated failed sign-ins" incident (escalating to critical as it continues). A single
// typo is never an alert. The password is never passed anywhere; the account is the e-mail the person typed (truncated by the engine).
const { dbGet } = require('./db-helpers');
const notify = require('./notify');

const WINDOW_MS = 15 * 60 * 1000;
const THRESHOLD = 3;

async function recordFailedLogin(req, account, reason) {
    try {
        const who = String(account || 'unknown').trim().toLowerCase().slice(0, 254) || 'unknown';
        const ip = (req && req.ip) || '';
        await notify.emit('security.login_failed', { account: who, reason, ip }, { actorType: 'system', actorLabel: ip || null });
        const row = await dbGet(`SELECT COUNT(*) AS n FROM activity_log WHERE event_type = 'security.login_failed' AND entity_id = ? AND occurred_at > ?`,
            [who, new Date(Date.now() - WINDOW_MS).toISOString()]);
        if (row && row.n >= THRESHOLD) await notify.emit('security.login_failed_repeated', { account: who, recent: row.n, ip }, { actorType: 'system', actorLabel: ip || null });
    } catch (e) {
        console.error('[security-alerts]', e && e.message);
    }
}

module.exports = { recordFailedLogin, THRESHOLD };
