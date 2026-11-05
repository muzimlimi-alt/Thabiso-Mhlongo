// Business Activity & Alert Management System - the engine modules call (docs-internal/notifications.md).
//
//     const notify = require('./notify');
//     notify.emit('finance.eft_proof_submitted', { submissionId, bookingId, amount, clientName }, { req });
//
// emit() is the ONLY thing a module does: it records the event in the Activity Log, then - if the registry (lib/notify-events.js) says it is
// worth the owner's attention - creates or updates ONE incident in admin_notifications and, for the priorities the owner chose, e-mails
// the notification address through the existing outbox (retries, SMTP pause and delivery log all come with it).
//
// House rules (the same ones every existing alert e-mail follows):
//   * emit() NEVER throws and never rejects - a notification problem must not break a payment, a booking or a page. Call it AFTER the
//     transaction commits and do not await it on a user's critical path (`notify.emit(...)` alone is fine; it is already async).
//   * Nothing secret goes in: sanitize() strips credential-looking keys and values and truncates long text before anything is stored.
//   * Repeats are grouped: while an incident is open, a repeat only raises occurrence_count (and escalates / re-emails on thresholds).
//   * Read != resolved. Reading is per admin (admin_notification_reads); an incident closes only through resolve()/the API with who+when.
//   * This reads/writes the shared sqlite connection, so - like logAudit - it must not run inside withDbTransaction().

const crypto = require('crypto');
const { dbRun, dbGet, dbAll } = require('./db-helpers');
const registry = require('./notify-events');
const { decodeStoredText } = require('./html-sanitize');

const nowIso = () => new Date().toISOString();

// ── sanitising ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const SENSITIVE_KEY = /pass(word|phrase|wd)?|secret|token|api.?key|merchant.?key|authorization|cookie|cvv|card.?(number|no|num)|signature|credential|private.?key|access.?key|session/i;
const DROP_FROM_DETAILS = new Set(['email', 'clientEmail', 'html', 'htmlContent']);   // render hints / personal data that has no business in the log
const MAX_STRING = 500;

// Booking / client text is stored entity-encoded once (stored-text convention); notifications store PLAIN text and escape where they render,
// so every string is decoded here first - "O&#x27;Brien" must not reach a title as-is.
function scrubString(str) {
    let out = String(decodeStoredText(str))
        .replace(/Bearer\s+[A-Za-z0-9._~+\/=-]+/gi, 'Bearer [redacted]')
        .replace(/(\b(?:key|token|access_token|refresh_token|signature|secret|client_secret|password|passwd|passphrase|apikey|api_key)\s*[=:]\s*)[^&\s"',;]+/gi, '$1[redacted]')
        .replace(/[A-Za-z0-9+\/_-]{40,}={0,2}/g, '[redacted]');
    if (out.length > MAX_STRING) out = out.slice(0, MAX_STRING) + '…';
    return out;
}

function sanitize(value, depth = 0, keepDropped = false) {
    if (value === null || value === undefined) return value;
    const t = typeof value;
    if (t === 'number' || t === 'boolean') return value;
    if (t === 'string') return scrubString(value);
    if (t === 'function' || t === 'symbol') return undefined;
    if (value instanceof Error) return scrubString(value.message || String(value));
    if (depth >= 4) return '[…]';
    if (Array.isArray(value)) return value.slice(0, 20).map((v) => sanitize(v, depth + 1, keepDropped));
    if (t === 'object') {
        const out = {};
        for (const k of Object.keys(value).slice(0, 40)) {
            if (SENSITIVE_KEY.test(k)) { out[k] = '[redacted]'; continue; }
            if (depth === 0 && !keepDropped && DROP_FROM_DETAILS.has(k)) continue;
            const v = sanitize(value[k], depth + 1, keepDropped);
            if (v !== undefined) out[k] = v;
        }
        return out;
    }
    return undefined;
}

// ── settings + rules (30 s cache: emit() is called on hot paths) ──────────────────────────────────────────────────────────────────
const CACHE_MS = 30000;
let settingsCache = { at: 0, map: {} };
let rulesCache = { at: 0, map: {} };

async function setting(key, fallback) {
    if (Date.now() - settingsCache.at > CACHE_MS) {
        const rows = await dbAll(`SELECT setting_key, setting_value FROM settings WHERE setting_key IN ('notifications_enabled','notification_backup_emails','ntf_email_min_priority')`);
        const map = {};
        for (const r of rows) map[r.setting_key] = r.setting_value;
        settingsCache = { at: Date.now(), map };
    }
    const v = settingsCache.map[key];
    return v === undefined || v === null || v === '' ? fallback : v;
}
async function rules() {
    if (Date.now() - rulesCache.at > CACHE_MS) {
        const rows = await dbAll('SELECT event_type, enabled, priority, email FROM notification_rules');
        const map = {};
        for (const r of rows) map[r.event_type] = r;
        rulesCache = { at: Date.now(), map };
    }
    return rulesCache.map;
}
function invalidateCaches() { settingsCache.at = 0; rulesCache.at = 0; }

// ── helpers ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const rank = (p) => (registry.PRIORITY_RANK[p] === undefined ? 9 : registry.PRIORITY_RANK[p]);
const json = (v) => (v === undefined || v === null ? null : JSON.stringify(v));
const warned = new Set();

function actorOf(ctx) {
    const sess = ctx && ctx.req && ctx.req.session;
    if (ctx && ctx.actor) return ctx.actor;
    if (sess && sess.adminId) return { type: 'admin', id: String(sess.adminId), label: sess.username || `admin #${sess.adminId}` };
    return { type: (ctx && ctx.actorType) || 'system', id: null, label: (ctx && ctx.actorLabel) || null };
}

function build(def, key, payload) {
    const call = (f, fallback) => { try { const v = typeof f === 'function' ? f(payload) : f; return v === undefined ? fallback : v; } catch (e) { return fallback; } };
    return {
        title: String(call(def.title, key)).slice(0, 300),
        body: call(def.body, null),
        entity: call(def.entity, null),
        link: call(def.link, null),
        actions: def.actions || null
    };
}

// ── emit ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
function emit(eventKey, payload, ctx) {
    try {
        return emitAsync(eventKey, payload || {}, ctx || {}).catch((err) => { console.error(`[notify] ${eventKey} failed: ${err && err.message}`); return null; });
    } catch (err) {
        console.error(`[notify] ${eventKey} failed: ${err && err.message}`);
        return Promise.resolve(null);
    }
}

async function emitAsync(eventKey, payload, ctx) {
    const def = registry.get(eventKey);
    if (!def) {
        if (!warned.has(eventKey)) { warned.add(eventKey); console.warn(`[notify] unknown event "${eventKey}" - not recorded`); }
        return null;
    }
    const ruleMap = await rules();
    const rule = ruleMap[eventKey] || null;
    const priority = (rule && rule.priority) || def.priority;
    const actor = actorOf(ctx);
    const correlationId = payload.correlationId || crypto.randomBytes(4).toString('hex');
    const dedupeLocal = def.dedupe ? String(def.dedupe(payload)) : `${eventKey}:${crypto.randomBytes(6).toString('hex')}`;
    const dedupeKey = `${eventKey}|${dedupeLocal}`;
    // Titles, bodies and e-mails are built from a SCRUBBED copy (a secret inside an error message must not reach any stored text). The
    // pre-rendered `email` hint some callers pass is already trusted markup, so it goes through untouched.
    const safe = { ...sanitize(payload, 0, true), ...(payload.email !== undefined ? { email: payload.email } : {}), actorLabel: payload.actorLabel || actor.label };
    const view = build(def, eventKey, safe);
    const entity = view.entity || {};
    const details = sanitize(payload);

    // 1. Activity Log: every event, whatever it does next (not subject to the on/off rule - the log is the audit trail).
    await dbRun(
        `INSERT INTO activity_log (occurred_at, event_type, category, severity, actor_type, actor_id, actor_label, entity_type, entity_id, summary, details_json, correlation_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [nowIso(), eventKey, def.category, priority, actor.type, actor.id, actor.label, entity.type || null, entity.id === undefined || entity.id === null ? null : String(entity.id), view.title, json(details), correlationId]
    );

    if (def.kind === 'activity') return null;
    if ((await setting('notifications_enabled', '1')) === '0') return null;
    if (rule && rule.enabled === 0 && !def.mandatory) return null;

    // 2. The incident: update the open one, reopen a resolved one, or create.
    const outcome = await upsertIncident({ def, eventKey, dedupeKey, priority, view, entity, details, correlationId, payload: safe });
    if (!outcome) return null;

    // 3. E-mail, once per incident (first occurrence / reopen / escalation / explicit stage change).
    if (outcome.emailNow) await sendIncidentEmail({ def, rule, row: outcome.row, payload, priority: outcome.row.priority });
    return outcome.row.id;
}

async function upsertIncident(ctx) {
    const { def, eventKey, dedupeKey, view, entity, details, correlationId, payload } = ctx;
    const ts = nowIso();
    let priority = ctx.priority;
    for (let attempt = 0; attempt < 2; attempt++) {
        const open = await dbGet(`SELECT * FROM admin_notifications WHERE dedupe_key = ? AND status IN ('open','acknowledged') ORDER BY id DESC LIMIT 1`, [dedupeKey]);
        if (open) {
            // The increment is atomic in SQL (concurrent repeats must not overwrite each other's count); escalation is a CONDITIONAL
            // update so exactly one of several simultaneous emitters is credited with it (and sends the one escalation e-mail).
            await dbRun(
                `UPDATE admin_notifications SET occurrence_count = occurrence_count + ?, last_seen_at = ?${def.refreshOnRepeat ? ', title = ?, body = ?, link_json = ?' : ''}, details_json = ?, correlation_id = ?
                 WHERE id = ?`,
                [def.countRepeats === false ? 0 : 1, ts, ...(def.refreshOnRepeat ? [view.title, view.body, json(view.link)] : []), json(details), correlationId, open.id]
            );
            let row = await dbGet('SELECT * FROM admin_notifications WHERE id = ?', [open.id]);
            let target = row.priority;
            if (def.refreshOnRepeat && rank(priority) !== rank(target)) target = priority;   // a compliance item moves with its deadline
            for (const step of (def.escalate || [])) {
                if (row.occurrence_count >= step.at && rank(step.priority) < rank(target)) target = step.priority;
            }
            let escalated = false;
            if (target !== row.priority) {
                const res = await dbRun(`UPDATE admin_notifications SET priority = ? WHERE id = ? AND priority = ?`, [target, open.id, row.priority]);
                if (res.changes) {
                    escalated = rank(target) < rank(row.priority);   // only getting MORE urgent re-surfaces and re-e-mails
                    if (escalated) await dbRun('DELETE FROM admin_notification_reads WHERE notification_id = ?', [open.id]);
                    row = await dbGet('SELECT * FROM admin_notifications WHERE id = ?', [open.id]);
                }
            }
            const thresholdHit = def.countRepeats !== false && [10, 100, 1000].indexOf(row.occurrence_count) >= 0 && row.priority === target && !escalated;
            return { row, created: false, emailNow: escalated || !!payload.emailNow || thresholdHit };
        }
        if (def.reopen) {
            const resolved = await dbGet(`SELECT * FROM admin_notifications WHERE dedupe_key = ? AND status = 'resolved' ORDER BY id DESC LIMIT 1`, [dedupeKey]);
            if (resolved) {
                await dbRun(
                    `UPDATE admin_notifications SET status = 'open', occurrence_count = occurrence_count + 1, last_seen_at = ?, priority = ?, title = ?, body = ?, link_json = ?,
                        ack_by = NULL, ack_at = NULL, resolved_by = NULL, resolved_at = NULL, resolution_note = NULL, resolved_auto = 0, details_json = ?, correlation_id = ?
                     WHERE id = ?`,
                    [ts, priority, view.title, view.body, json(view.link), json(details), correlationId, resolved.id]
                );
                await dbRun('DELETE FROM admin_notification_reads WHERE notification_id = ?', [resolved.id]);
                return { row: await dbGet('SELECT * FROM admin_notifications WHERE id = ?', [resolved.id]), created: false, reopened: true, emailNow: def.emailOnlyWhenAsked ? !!payload.emailNow : true };
            }
        }
        try {
            const res = await dbRun(
                `INSERT INTO admin_notifications (dedupe_key, event_type, category, priority, kind, title, body, entity_type, entity_id, link_json, actions_json, status,
                    occurrence_count, first_seen_at, last_seen_at, mandatory, correlation_id, details_json)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', 1, ?, ?, ?, ?, ?)`,
                [dedupeKey, eventKey, def.category, priority, def.kind, view.title, view.body, entity.type || null, entity.id === undefined || entity.id === null ? null : String(entity.id),
                    json(view.link), json(view.actions), ts, ts, def.mandatory ? 1 : 0, correlationId, json(details)]
            );
            return { row: await dbGet('SELECT * FROM admin_notifications WHERE id = ?', [res.lastID]), created: true, emailNow: def.emailOnlyWhenAsked ? !!payload.emailNow : true };
        } catch (err) {
            if (attempt === 0 && /UNIQUE/i.test(err.message)) continue;   // a concurrent emit created it first - fold into that incident
            throw err;
        }
    }
    return null;
}

// ── e-mail channel ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
async function sendIncidentEmail({ def, rule, row, payload, priority }) {
    try {
        let spec = null;
        if (def.email === false) return markEmail(row.id, 'skipped');
        if (rule && rule.email === 0 && !def.mandatory) return markEmail(row.id, 'skipped');
        const forced = rule && rule.email === 1;
        if (!forced) {
            const min = await setting('ntf_email_min_priority', 'high');
            if (min === 'never' || rank(priority) > rank(min)) return markEmail(row.id, 'skipped');
        }
        if (typeof def.email === 'function') {
            spec = def.email({ ...payload, notificationId: row.id });
            if (!spec) return markEmail(row.id, 'skipped');
        } else {
            const esc = require('../js/emailComponents').esc;
            spec = {
                subject: `${priority === 'critical' ? '[URGENT] ' : ''}${row.title}`, titleOverride: row.title, trigger: 'Admin: Notification', category: registry.CATEGORIES[def.category].label,
                severity: priority === 'critical' ? 'alert' : def.kind === 'action' ? 'action' : 'warning',
                lead: esc(row.title),
                bodyHtml: `<p style="margin:0; color:#E6E6E6;">${esc(row.body || '')}</p><p style="margin:12px 0 0; color:#9a9a9a;">Open the admin portal &rarr; Notification Centre to acknowledge or resolve this.${row.correlation_id ? ` Ref ${esc(row.correlation_id)}.` : ''}</p>`
            };
        }
        const emailComponents = require('../js/emailComponents');
        const { sendEmail } = require('../js/emailService');
        const { getNotificationEmail } = require('../database/repositories/settings.repository');
        const primary = await getNotificationEmail();
        const recipients = new Set(primary ? [primary] : []);
        if (priority === 'critical') {
            for (const a of String(await setting('notification_backup_emails', '')).split(',').map((x) => x.trim()).filter(Boolean)) recipients.add(a);
        }
        if (!recipients.size) return markEmail(row.id, 'skipped');
        const html = emailComponents.renderSystemEmail({
            preheaderText: spec.subject, category: spec.category || 'System Notification', severity: spec.severity || 'warning',
            leadFact: spec.lead || '', bodyHtml: spec.bodyHtml || '', cards: spec.cards || []
        });
        for (const to of recipients) {
            await sendEmail({
                to, subject: spec.subject, htmlContent: html, preWrapped: true, titleOverride: spec.titleOverride || row.title, trigger_event: spec.trigger || 'Admin: Notification',
                replyTo: spec.replyTo || null, related_entity: 'admin_notification', related_id: row.id
            });
        }
        await dbRun(`UPDATE admin_notifications SET email_state = 'queued', emailed_at = ? WHERE id = ?`, [nowIso(), row.id]);
    } catch (err) {
        console.error(`[notify] e-mail for notification ${row && row.id} failed: ${err && err.message}`);
        await markEmail(row.id, 'error').catch(() => {});
    }
}
function markEmail(id, state) { return dbRun('UPDATE admin_notifications SET email_state = ? WHERE id = ?', [state, id]); }

// ── resolve (called by the workflows themselves: "the EFT was approved, so its alert is done") ──────────────────────────────────────
// match: an entity id string/number (resolves every open incident of this event for that entity) or { key } (a dedupe key local part).
async function resolve(eventKey, match, opts = {}) {
    try {
        const sess = opts.req && opts.req.session;
        const by = sess && sess.adminId ? sess.adminId : null;
        const note = opts.note ? String(opts.note).slice(0, 500) : null;
        let res;
        if (match && typeof match === 'object' && match.key !== undefined) {
            res = await dbRun(`UPDATE admin_notifications SET status = 'resolved', resolved_at = ?, resolved_by = ?, resolution_note = ?, resolved_auto = ? WHERE dedupe_key = ? AND status IN ('open','acknowledged')`,
                [nowIso(), by, note, by ? 0 : 1, `${eventKey}|${match.key}`]);
        } else {
            res = await dbRun(`UPDATE admin_notifications SET status = 'resolved', resolved_at = ?, resolved_by = ?, resolution_note = ?, resolved_auto = ? WHERE event_type = ? AND entity_id = ? AND status IN ('open','acknowledged')`,
                [nowIso(), by, note, by ? 0 : 1, eventKey, String(match)]);
        }
        return res.changes || 0;
    } catch (err) {
        console.error(`[notify] resolve ${eventKey} failed: ${err && err.message}`);
        return 0;
    }
}

// A short stable id for "the same error": used to group repeats of one failure and as the reference quoted in the notification.
function fingerprint(...parts) {
    return crypto.createHash('sha1').update(parts.map((x) => String(x === undefined || x === null ? '' : x)).join('|')).digest('hex').slice(0, 10);
}
// /api/bookings/123/pay/AbC...token -> /api/bookings/:x/pay/:x  (no ids or tokens in a stored route, and one fingerprint per route shape)
function normalizeRoute(p) {
    return String(p || '').split('?')[0].split('/').map((seg) => (/\d/.test(seg) || seg.length > 24 ? ':x' : seg)).join('/').slice(0, 120);
}

module.exports = { emit, resolve, sanitize, fingerprint, normalizeRoute, invalidateCaches, _emitAsync: emitAsync };
