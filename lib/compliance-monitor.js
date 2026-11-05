// Compliance expiry reminders (docs-internal/notifications.md). Phase 1 watches the one expiry date the system already holds - the B-BBEE
// certificate in the business profile; Phase 3 generalises this to a list of documents (domain, SSL, Microsoft 365, API credentials, tax ...).
//
// One incident per (item, expiry date) - compliance.expiring - refreshed every day with the days left. The owner is e-mailed ONCE per stage:
// 90, 60, 30, 14 and 7 days before, on the day, and weekly after expiry until a new date is recorded. expiry_reminders_sent makes that true
// however often the check runs (restarts included). Recording a new expiry date resolves the old incident automatically.
const { dbRun, dbGet, dbAll } = require('./db-helpers');
const notify = require('./notify');

const STAGES = [90, 60, 30, 14, 7, 0];
const DAY = 86400000;

// "today" in the business's own time zone (South Africa, UTC+2, no DST)
function todaySast(now = Date.now()) { return new Date(now + 2 * 3600000).toISOString().slice(0, 10); }
function daysBetween(fromIso, toIso) { return Math.round((Date.parse(toIso + 'T00:00:00Z') - Date.parse(fromIso + 'T00:00:00Z')) / DAY); }

// The stage a number of days-left falls in, or null while it is still further away than the first reminder.
function stageFor(daysLeft) {
    if (daysLeft < 0) return `expired-w${Math.floor(-daysLeft / 7)}`;   // weekly after expiry, until a new date is recorded
    let stage = null;
    for (const s of STAGES) if (daysLeft <= s) stage = `d${s}`;
    return stage;
}

async function checkItem({ itemKey, name, reference, expiryDate, link }, today) {
    const open = await dbAll(`SELECT id, dedupe_key FROM admin_notifications WHERE event_type = 'compliance.expiring' AND entity_id = ? AND status IN ('open','acknowledged')`, [itemKey]);
    const currentKey = expiryDate ? `compliance.expiring|expiry:${itemKey}:${expiryDate}` : null;
    // a different (renewed) date - or none - closes the old incident
    for (const row of open) {
        if (row.dedupe_key !== currentKey) {
            await notify.resolve('compliance.expiring', { key: row.dedupe_key.split('|')[1] }, { note: expiryDate ? `A new expiry date was recorded (${expiryDate}).` : 'The expiry date was removed.' });
        }
    }
    if (!expiryDate || !/^\d{4}-\d{2}-\d{2}$/.test(expiryDate)) return null;
    const daysLeft = daysBetween(today, expiryDate);
    const stage = stageFor(daysLeft);
    if (!stage) return null;
    const ins = await dbRun('INSERT OR IGNORE INTO expiry_reminders_sent (item_key, expiry_date, stage, sent_at) VALUES (?, ?, ?, ?)', [itemKey, expiryDate, stage, new Date().toISOString()]);
    const newStage = ins.changes === 1;
    // An admin who resolved / archived it ("renewal submitted") is not nagged again until the NEXT reminder stage.
    if (!newStage && currentKey) {
        const closed = await dbGet(`SELECT id FROM admin_notifications WHERE dedupe_key = ? AND status IN ('resolved','archived') LIMIT 1`, [currentKey]);
        const stillOpen = await dbGet(`SELECT id FROM admin_notifications WHERE dedupe_key = ? AND status IN ('open','acknowledged') LIMIT 1`, [currentKey]);
        if (closed && !stillOpen) return { itemKey, daysLeft, stage, emailed: false, skipped: 'closed by an admin' };
    }
    await notify.emit('compliance.expiring', { itemKey, name, reference, expiryDate, daysLeft, stage, link, emailNow: newStage }, { actorType: 'system' });
    return { itemKey, daysLeft, stage, emailed: newStage };
}

async function runComplianceCheck(now = Date.now()) {
    const today = todaySast(now);
    const out = [];
    const bp = await dbGet('SELECT bbbee_certificate_number, bbbee_level, bbbee_expiry_date FROM business_profile WHERE id = 1').catch(() => null);
    if (bp) {
        const r = await checkItem({
            itemKey: 'bbbee', name: 'B-BBEE certificate', reference: bp.bbbee_certificate_number || '',
            expiryDate: bp.bbbee_expiry_date || '', link: { section: 'businessAdmin' }
        }, today);
        if (r) out.push(r);
    }
    // the owner's own list (compliance_items, migration 120)
    const items = await dbAll('SELECT * FROM compliance_items WHERE is_active = 1').catch(() => []);
    for (const it of items) {
        const r = await checkItem({
            itemKey: `doc:${it.id}`, name: it.name, reference: it.reference || '', expiryDate: it.expiry_date,
            link: { section: 'notificationsAdmin', tab: 'ntfPanelExpiry' }
        }, today);
        if (r) out.push(r);
    }
    // an item that was deleted or switched off: its open reminder closes
    const active = new Set(items.map((it) => `doc:${it.id}`));
    const stale = await dbAll(`SELECT DISTINCT entity_id FROM admin_notifications WHERE event_type = 'compliance.expiring' AND entity_id LIKE 'doc:%' AND status IN ('open','acknowledged')`).catch(() => []);
    for (const s of stale) if (!active.has(s.entity_id)) await notify.resolve('compliance.expiring', s.entity_id, { note: 'The item was removed from the expiry list.' });
    return out;
}

// ── the expiry list (API helpers for routes/admin/notifications.js) ─────────────────────────────────────────────────────────────────
const KINDS = { licence: 'Business licence / certificate', tax: 'Tax compliance', vat: 'VAT registration', domain: 'Domain registration', ssl: 'SSL certificate',
    m365: 'Microsoft 365 / e-mail subscription', api: 'API credentials / integration authorisation', insurance: 'Insurance', other: 'Other' };

function validateItem(body) {
    const errors = {};
    const clean = {};
    const str = (v) => (v === undefined || v === null ? '' : String(v).trim());
    clean.kind = str(body.kind) || 'other';
    if (!KINDS[clean.kind]) errors.kind = 'Choose a type from the list.';
    clean.name = str(body.name).slice(0, 120);
    if (clean.name.length < 2) errors.name = 'Give it a name (at least 2 characters).';
    clean.reference = str(body.reference).slice(0, 120) || null;
    clean.expiry_date = str(body.expiry_date);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(clean.expiry_date) || isNaN(Date.parse(clean.expiry_date + 'T00:00:00Z'))) errors.expiry_date = 'Enter the expiry date (YYYY-MM-DD).';
    clean.notes = str(body.notes).slice(0, 500) || null;
    clean.is_active = body.is_active === false || body.is_active === 0 || body.is_active === '0' ? 0 : 1;
    return { clean, errors };
}

async function listItems(now = Date.now()) {
    const today = todaySast(now);
    const rows = await dbAll('SELECT * FROM compliance_items ORDER BY is_active DESC, expiry_date ASC');
    const bp = await dbGet('SELECT bbbee_certificate_number, bbbee_expiry_date FROM business_profile WHERE id = 1').catch(() => null);
    const shape = (r) => ({ ...r, kind_label: KINDS[r.kind] || r.kind, days_left: r.expiry_date ? daysBetween(today, r.expiry_date) : null });
    const items = rows.map(shape);
    const fixed = bp && bp.bbbee_expiry_date ? [{ id: null, kind: 'bbbee', kind_label: 'B-BBEE certificate', name: 'B-BBEE certificate', reference: bp.bbbee_certificate_number || null,
        expiry_date: bp.bbbee_expiry_date, is_active: 1, read_only: true, managed_in: 'Business Profile', days_left: daysBetween(today, bp.bbbee_expiry_date) }] : [];
    return { items: fixed.concat(items), kinds: KINDS };
}

function registerComplianceMonitor() {
    const run = require('./job-monitor').monitored('compliance-expiry', 'Compliance expiry reminders', 24 * 60 * 60 * 1000, () => runComplianceCheck());
    setTimeout(() => {
        run().catch((e) => console.error('[Compliance] Startup check failed:', e.message));
        setInterval(() => run().catch((e) => console.error('[Compliance] Daily check failed:', e.message)), 24 * 60 * 60 * 1000);
    }, 75000);
}

module.exports = { runComplianceCheck, registerComplianceMonitor, stageFor, todaySast, validateItem, listItems, KINDS };
