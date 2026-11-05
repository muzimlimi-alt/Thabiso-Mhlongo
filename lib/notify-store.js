// Business Activity & Alert Management System - the READ side and the lifecycle (docs-internal/notifications.md).
// lib/notify.js is what modules call to announce things; this file is what the Notification Centre API (routes/admin/notifications.js) uses
// to list, count and move incidents through their lifecycle. Everything here is scoped to ONE admin: what they may see (their role's
// categories, narrowed by the event's own audience), what is unread FOR THEM, and what they have switched off for themselves.
//
// Views (the owner's three):   action    - kind 'action', still open/acknowledged
//                              attention - kind 'attention', still open/acknowledged
//                              activity  - the Activity Log (activity_log), a chronological record, never "unread"
// Filters on the inbox:        all (not archived) | unread | urgent (critical + high, still open) | action | resolved (resolved + archived)

const { dbRun, dbGet, dbAll } = require('./db-helpers');
const registry = require('./notify-events');
const notify = require('./notify');
const { logAudit } = require('./audit-log');

const nowIso = () => new Date().toISOString();
const OPEN = `('open','acknowledged')`;
const PRIORITY_ORDER = `CASE n.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END`;

const ph = (arr) => arr.map(() => '?').join(',');
const like = (q) => `%${String(q).replace(/[\\%_]/g, (c) => '\\' + c)}%`;
const parse = (s) => { try { return s ? JSON.parse(s) : null; } catch (e) { return null; } };

// ── scope ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Returns { where, params } restricting alias `n` to what this admin may see, honouring their own in-app switches (mandatory always shows).
async function scope(admin, alias = 'n') {
    const types = registry.eventsFor(admin.role);
    const muted = await dbAll('SELECT category FROM notification_prefs WHERE admin_id = ? AND in_app = 0', [admin.id]);
    const where = [`${alias}.event_type IN (${types.length ? ph(types) : "''"})`];
    const params = types.slice();
    if (muted.length) {
        where.push(`(${alias}.mandatory = 1 OR ${alias}.category NOT IN (${ph(muted)}))`);
        params.push(...muted.map((m) => m.category));
    }
    return { where, params };
}

function shape(row, admin) {
    const cat = registry.CATEGORIES[row.category] || { label: row.category };
    const statuses = row.email_statuses ? String(row.email_statuses).split(',') : [];
    let delivery = null;
    if (row.email_state === 'queued') delivery = statuses.length ? (statuses.indexOf('failed') >= 0 ? 'failed' : statuses.every((s) => s === 'sent') ? 'sent' : 'pending') : 'pending';
    return {
        id: row.id, event_type: row.event_type, category: row.category, category_label: cat.label, priority: row.priority, kind: row.kind,
        title: row.title, body: row.body, entity_type: row.entity_type, entity_id: row.entity_id,
        link: parse(row.link_json), actions: parse(row.actions_json) || [],
        status: row.status, occurrence_count: row.occurrence_count, first_seen_at: row.first_seen_at, last_seen_at: row.last_seen_at,
        acknowledged_by: row.ack_name || null, acknowledged_at: row.ack_at, resolved_by: row.resolved_name || null, resolved_at: row.resolved_at,
        resolution_note: row.resolution_note, resolved_auto: !!row.resolved_auto, archived_at: row.archived_at,
        is_read: !!row.is_read, mandatory: !!row.mandatory, email_state: row.email_state, email_delivery: delivery, reference: row.correlation_id,
        details: admin.role === 'administrator' ? parse(row.details_json) : undefined
    };
}

const SELECT = `
    SELECT n.*, a1.full_name AS ack_full, a1.username AS ack_user, a2.full_name AS resolved_full, a2.username AS resolved_user,
           (r.admin_id IS NOT NULL) AS is_read,
           (SELECT group_concat(o.status) FROM notifications o WHERE o.related_entity = 'admin_notification' AND o.related_id = n.id) AS email_statuses
      FROM admin_notifications n
      LEFT JOIN admins a1 ON a1.id = n.ack_by
      LEFT JOIN admins a2 ON a2.id = n.resolved_by
      LEFT JOIN admin_notification_reads r ON r.notification_id = n.id AND r.admin_id = ?`;
const withNames = (row) => { row.ack_name = row.ack_full || row.ack_user; row.resolved_name = row.resolved_full || row.resolved_user; return row; };

// ── list / summary ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
async function list(admin, q = {}) {
    const sc = await scope(admin);
    const where = [...sc.where];
    const params = [admin.id, ...sc.params];
    const view = q.view === 'action' || q.view === 'attention' ? q.view : null;
    if (view) { where.push('n.kind = ?'); params.push(view); }
    // A view (Action required / Attention) shows what is still OPEN unless told otherwise; the inbox with no view shows everything not archived.
    const filter = q.filter || (view ? 'open' : 'all');
    if (filter === 'unread') where.push(`n.status IN ${OPEN} AND r.admin_id IS NULL`);
    else if (filter === 'urgent') where.push(`n.status IN ${OPEN} AND n.priority IN ('critical','high')`);
    else if (filter === 'action') where.push(`n.kind = 'action' AND n.status IN ${OPEN}`);
    else if (filter === 'open') where.push(`n.status IN ${OPEN}`);
    else if (filter === 'resolved') where.push(`n.status IN ('resolved','archived')`);
    else where.push(`n.status != 'archived'`);
    if (q.category && registry.CATEGORIES[q.category]) { where.push('n.category = ?'); params.push(q.category); }
    if (q.priority && registry.PRIORITIES.indexOf(q.priority) >= 0) { where.push('n.priority = ?'); params.push(q.priority); }
    if (q.from && /^\d{4}-\d{2}-\d{2}/.test(q.from)) { where.push('n.last_seen_at >= ?'); params.push(q.from); }
    if (q.to && /^\d{4}-\d{2}-\d{2}/.test(q.to)) { where.push('n.last_seen_at < ?'); params.push(String(q.to).length === 10 ? q.to + 'T23:59:59.999Z' : q.to); }
    if (q.q && String(q.q).trim()) { where.push(`(n.title LIKE ? ESCAPE '\\' OR n.body LIKE ? ESCAPE '\\' OR n.correlation_id LIKE ? ESCAPE '\\')`); const l = like(String(q.q).trim().slice(0, 100)); params.push(l, l, l); }

    const pageSize = Math.min(100, Math.max(1, parseInt(q.pageSize, 10) || 25));
    const page = Math.max(1, parseInt(q.page, 10) || 1);
    const sql = `${SELECT} WHERE ${where.join(' AND ')}`;
    const total = await dbGet(`SELECT COUNT(*) AS c FROM admin_notifications n LEFT JOIN admin_notification_reads r ON r.notification_id = n.id AND r.admin_id = ? WHERE ${where.join(' AND ')}`, params);
    const rows = await dbAll(`${sql} ORDER BY (n.status IN ('open','acknowledged')) DESC, ${PRIORITY_ORDER}, n.last_seen_at DESC LIMIT ? OFFSET ?`, [...params, pageSize, (page - 1) * pageSize]);
    return { items: rows.map((r) => shape(withNames(r), admin)), total: total.c, page, pageSize };
}

async function summary(admin) {
    const sc = await scope(admin);
    const base = `FROM admin_notifications n LEFT JOIN admin_notification_reads r ON r.notification_id = n.id AND r.admin_id = ? WHERE ${sc.where.join(' AND ')} AND n.status IN ${OPEN}`;
    const p = [admin.id, ...sc.params];
    const c = await dbGet(
        `SELECT SUM(r.admin_id IS NULL) AS unread, SUM(n.kind = 'action') AS action, SUM(n.kind = 'attention') AS attention,
                SUM(n.priority IN ('critical','high')) AS urgent, SUM(n.priority = 'critical') AS critical,
                SUM(n.priority = 'critical' AND r.admin_id IS NULL) AS critical_unread ${base}`, p);
    const latest = await dbAll(`${SELECT} WHERE ${sc.where.join(' AND ')} AND n.status IN ${OPEN} ORDER BY (r.admin_id IS NULL) DESC, ${PRIORITY_ORDER}, n.last_seen_at DESC LIMIT 8`, [admin.id, ...sc.params]);
    return {
        unread: c.unread || 0, action: c.action || 0, attention: c.attention || 0, urgent: c.urgent || 0, critical: c.critical || 0, critical_unread: c.critical_unread || 0,
        latest: latest.map((r) => shape(withNames(r), admin))
    };
}

async function get(admin, id) {
    const sc = await scope(admin);
    const row = await dbGet(`${SELECT} WHERE n.id = ? AND ${sc.where.join(' AND ')}`, [admin.id, id, ...sc.params]);
    return row ? shape(withNames(row), admin) : null;
}

// ── read state (per admin) ────────────────────────────────────────────────────────────────────────────────────────────────────────
async function visibleIds(admin, ids) {
    if (!ids.length) return [];
    const sc = await scope(admin);
    const rows = await dbAll(`SELECT n.id FROM admin_notifications n WHERE n.id IN (${ph(ids)}) AND ${sc.where.join(' AND ')}`, [...ids, ...sc.params]);
    return rows.map((r) => r.id);
}
async function setRead(admin, ids, read) {
    const vis = await visibleIds(admin, ids.map(Number).filter(Number.isInteger).slice(0, 200));
    for (const id of vis) {
        if (read) await dbRun('INSERT OR IGNORE INTO admin_notification_reads (notification_id, admin_id, read_at) VALUES (?, ?, ?)', [id, admin.id, nowIso()]);
        else await dbRun('DELETE FROM admin_notification_reads WHERE notification_id = ? AND admin_id = ?', [id, admin.id]);
    }
    return vis.length;
}
async function markAllRead(admin) {
    const sc = await scope(admin);
    const res = await dbRun(
        `INSERT OR IGNORE INTO admin_notification_reads (notification_id, admin_id, read_at)
         SELECT n.id, ?, ? FROM admin_notifications n WHERE ${sc.where.join(' AND ')} AND n.status IN ${OPEN}`,
        [admin.id, nowIso(), ...sc.params]);
    return res.changes || 0;
}

// ── lifecycle: acknowledge -> resolve -> archive (reading never does any of these) ─────────────────────────────────────────────────
async function transition(admin, id, action, { note, req } = {}) {
    const cur = await get(admin, id);
    if (!cur) return { ok: false, status: 404, message: 'Notification not found.' };
    const ts = nowIso();
    const trimmed = note ? String(note).trim().slice(0, 500) : null;
    if (action === 'ack') {
        if (cur.status !== 'open') return { ok: false, status: 409, message: cur.status === 'acknowledged' ? 'Already acknowledged.' : 'This notification is already closed.' };
        await dbRun(`UPDATE admin_notifications SET status = 'acknowledged', ack_by = ?, ack_at = ? WHERE id = ? AND status = 'open'`, [admin.id, ts, id]);
        await dbRun('INSERT OR IGNORE INTO admin_notification_reads (notification_id, admin_id, read_at) VALUES (?, ?, ?)', [id, admin.id, ts]);
    } else if (action === 'resolve') {
        if (cur.status !== 'open' && cur.status !== 'acknowledged') return { ok: false, status: 409, message: 'This notification is already closed.' };
        if (cur.kind === 'action' && !trimmed) return { ok: false, status: 400, message: 'Add a short note saying what was done.' };
        await dbRun(`UPDATE admin_notifications SET status = 'resolved', resolved_by = ?, resolved_at = ?, resolution_note = ?, resolved_auto = 0 WHERE id = ? AND status IN ${OPEN}`, [admin.id, ts, trimmed, id]);
        await dbRun('INSERT OR IGNORE INTO admin_notification_reads (notification_id, admin_id, read_at) VALUES (?, ?, ?)', [id, admin.id, ts]);
    } else if (action === 'archive') {
        if (cur.status === 'archived') return { ok: false, status: 409, message: 'Already archived.' };
        if (cur.kind === 'action' && (cur.status === 'open' || cur.status === 'acknowledged')) return { ok: false, status: 409, message: 'Resolve an action-required item before archiving it.' };
        await dbRun(`UPDATE admin_notifications SET status = 'archived', archived_at = ?${cur.status === 'open' || cur.status === 'acknowledged' ? ", resolved_by = ?, resolved_at = ?, resolved_auto = 0" : ''} WHERE id = ?`,
            cur.status === 'open' || cur.status === 'acknowledged' ? [ts, admin.id, ts, id] : [ts, id]);
    } else return { ok: false, status: 400, message: 'Unknown action.' };
    // Audit trail: who closed what, and why (the notification row itself holds who/when too).
    logAudit({ tableName: 'admin_notifications', recordId: id, action: action.toUpperCase(), req, newValues: { event: cur.event_type, title: cur.title, note: trimmed } }).catch(() => {});
    return { ok: true, notification: await get(admin, id) };
}

// ── Activity Log ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
async function activity(admin, q = {}) {
    const types = registry.eventsFor(admin.role);
    const where = [`a.event_type IN (${types.length ? ph(types) : "''"})`];
    const params = types.slice();
    if (q.category && registry.CATEGORIES[q.category]) { where.push('a.category = ?'); params.push(q.category); }
    if (q.severity && registry.PRIORITIES.indexOf(q.severity) >= 0) { where.push('a.severity = ?'); params.push(q.severity); }
    if (q.actor_type && ['admin', 'client', 'system', 'gateway'].indexOf(q.actor_type) >= 0) { where.push('a.actor_type = ?'); params.push(q.actor_type); }
    if (q.from && /^\d{4}-\d{2}-\d{2}/.test(q.from)) { where.push('a.occurred_at >= ?'); params.push(q.from); }
    if (q.to && /^\d{4}-\d{2}-\d{2}/.test(q.to)) { where.push('a.occurred_at < ?'); params.push(String(q.to).length === 10 ? q.to + 'T23:59:59.999Z' : q.to); }
    if (q.q && String(q.q).trim()) { where.push(`(a.summary LIKE ? ESCAPE '\\' OR a.entity_id LIKE ? ESCAPE '\\' OR a.actor_label LIKE ? ESCAPE '\\' OR a.correlation_id LIKE ? ESCAPE '\\' OR a.details_json LIKE ? ESCAPE '\\')`); const l = like(String(q.q).trim().slice(0, 100)); params.push(l, l, l, l, l); }
    const pageSize = Math.min(100, Math.max(1, parseInt(q.pageSize, 10) || 50));
    const page = Math.max(1, parseInt(q.page, 10) || 1);
    const total = await dbGet(`SELECT COUNT(*) AS c FROM activity_log a WHERE ${where.join(' AND ')}`, params);
    const rows = await dbAll(`SELECT a.* FROM activity_log a WHERE ${where.join(' AND ')} ORDER BY a.occurred_at DESC, a.id DESC LIMIT ? OFFSET ?`, [...params, pageSize, (page - 1) * pageSize]);
    return {
        items: rows.map((r) => ({
            id: r.id, occurred_at: r.occurred_at, event_type: r.event_type, category: r.category, category_label: (registry.CATEGORIES[r.category] || {}).label || r.category,
            severity: r.severity, actor_type: r.actor_type, actor_label: r.actor_label, entity_type: r.entity_type, entity_id: r.entity_id, summary: r.summary,
            reference: r.correlation_id, details: admin.role === 'administrator' ? parse(r.details_json) : undefined
        })),
        total: total.c, page, pageSize
    };
}

// ── preferences (per admin) ────────────────────────────────────────────────────────────────────────────────────────────────────────
async function getPrefs(admin) {
    const rows = await dbAll('SELECT category, in_app, email_min_priority FROM notification_prefs WHERE admin_id = ?', [admin.id]);
    const byCat = {};
    for (const r of rows) byCat[r.category] = r;
    return registry.categoriesFor(admin.role).map((c) => ({
        category: c, label: registry.CATEGORIES[c].label,
        in_app: byCat[c] && byCat[c].in_app !== null ? !!byCat[c].in_app : true,
        email_min_priority: byCat[c] ? byCat[c].email_min_priority : null
    }));
}
async function setPrefs(admin, items) {
    const allowed = new Set(registry.categoriesFor(admin.role));
    let n = 0;
    for (const it of Array.isArray(items) ? items : []) {
        if (!allowed.has(it.category)) continue;
        const inApp = it.in_app === undefined || it.in_app === null ? null : (it.in_app ? 1 : 0);
        const emailMin = it.email_min_priority && (registry.PRIORITIES.indexOf(it.email_min_priority) >= 0 || it.email_min_priority === 'never') ? it.email_min_priority : null;
        await dbRun(
            `INSERT INTO notification_prefs (admin_id, category, in_app, email_min_priority, updated_at) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(admin_id, category) DO UPDATE SET in_app = excluded.in_app, email_min_priority = excluded.email_min_priority, updated_at = excluded.updated_at`,
            [admin.id, it.category, inApp, emailMin, nowIso()]);
        n++;
    }
    return n;
}

// ── rules + settings (administrator) ───────────────────────────────────────────────────────────────────────────────────────────────
async function getRules() {
    const rows = await dbAll('SELECT event_type, enabled, priority, email FROM notification_rules');
    const by = {};
    for (const r of rows) by[r.event_type] = r;
    return Object.keys(registry.EVENTS).map((k) => {
        const e = registry.EVENTS[k]; const r = by[k] || {};
        return {
            event_type: k, category: e.category, category_label: registry.CATEGORIES[e.category].label, kind: e.kind, mandatory: !!e.mandatory, default_priority: e.priority,
            enabled: r.enabled === undefined || r.enabled === null ? true : !!r.enabled, priority: r.priority || null,
            email: r.email === undefined || r.email === null ? null : !!r.email, sends_email_by_default: e.email !== false
        };
    });
}
async function setRule(admin, eventType, body) {
    const e = registry.get(eventType);
    if (!e) return { ok: false, status: 404, message: 'Unknown event.' };
    const enabled = body.enabled === undefined || body.enabled === null ? null : (body.enabled ? 1 : 0);
    const priority = body.priority || null;
    const email = body.email === undefined || body.email === null ? null : (body.email ? 1 : 0);
    if (priority && registry.PRIORITIES.indexOf(priority) < 0) return { ok: false, status: 400, message: 'Priority must be critical, high, medium or info.' };
    if (e.mandatory && enabled === 0) return { ok: false, status: 400, message: 'This is a security / financial-integrity / critical-system alert and cannot be switched off.' };
    if (e.mandatory && email === 0) return { ok: false, status: 400, message: 'The e-mail for this alert cannot be switched off.' };
    if (e.mandatory && priority && registry.PRIORITY_RANK[priority] > Math.min(registry.PRIORITY_RANK[e.priority], 1)) return { ok: false, status: 400, message: 'This alert cannot be lowered below High.' };
    await dbRun(
        `INSERT INTO notification_rules (event_type, enabled, priority, email, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(event_type) DO UPDATE SET enabled = excluded.enabled, priority = excluded.priority, email = excluded.email, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
        [eventType, enabled, priority, email, admin.id, nowIso()]);
    notify.invalidateCaches();
    return { ok: true };
}

const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;
async function getSettings() {
    const rows = await dbAll(`SELECT setting_key, setting_value FROM settings WHERE setting_key IN ('notifications_enabled','notification_backup_emails','ntf_email_min_priority','notification_email','ntf_low_stock_threshold')`);
    const m = {};
    for (const r of rows) m[r.setting_key] = r.setting_value;
    const lowStock = parseInt(m.ntf_low_stock_threshold, 10);
    return {
        enabled: m.notifications_enabled !== '0',
        primary_email: m.notification_email || '',
        backup_emails: String(m.notification_backup_emails || '').split(',').map((x) => x.trim()).filter(Boolean),
        email_min_priority: m.ntf_email_min_priority || 'high',
        low_stock_threshold: Number.isInteger(lowStock) && lowStock >= 0 ? lowStock : require('./ticket-alerts').DEFAULT_THRESHOLD
    };
}
async function setSettings(body) {
    const errors = {};
    const put = (k, v) => dbRun('INSERT OR REPLACE INTO settings (setting_key, setting_value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)', [k, String(v)]);
    if (body.enabled !== undefined) await put('notifications_enabled', body.enabled ? '1' : '0');
    if (body.email_min_priority !== undefined) {
        if (['critical', 'high', 'medium', 'info', 'never'].indexOf(body.email_min_priority) < 0) errors.email_min_priority = 'Choose critical, high, medium, info or never.';
        else await put('ntf_email_min_priority', body.email_min_priority);
    }
    if (body.backup_emails !== undefined) {
        const list = (Array.isArray(body.backup_emails) ? body.backup_emails : String(body.backup_emails).split(',')).map((x) => String(x).trim()).filter(Boolean);
        if (list.length > 5) errors.backup_emails = 'At most 5 backup addresses.';
        else if (list.some((x) => !EMAIL_RE.test(x) || x.length > 254)) errors.backup_emails = 'One of the backup addresses is not a valid e-mail address.';
        else await put('notification_backup_emails', list.join(','));
    }
    if (body.low_stock_threshold !== undefined) {
        const n = Number(body.low_stock_threshold);
        if (!Number.isInteger(n) || n < 0 || n > 10000) errors.low_stock_threshold = 'The low-stock alert must be a whole number from 0 to 10,000 (0 = off).';
        else await put('ntf_low_stock_threshold', n);
    }
    if (body.primary_email !== undefined) {
        const v = String(body.primary_email).trim();
        if (!EMAIL_RE.test(v) || v.length > 254) errors.primary_email = 'Enter a valid e-mail address.';
        else await put('notification_email', v);
    }
    notify.invalidateCaches();
    return Object.keys(errors).length ? { ok: false, errors } : { ok: true };
}

module.exports = { list, summary, get, setRead, markAllRead, transition, activity, getPrefs, setPrefs, getRules, setRule, getSettings, setSettings, scope };
