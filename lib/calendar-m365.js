// Admin Calendar <-> the shared Microsoft 365 calendar of the booking mailbox (Microsoft Graph). Design, rules and set-up: docs-internal/calendar-m365.md.
//
// The website database stays AUTHORITATIVE for booking status, quotes, invoices and payments. Microsoft 365 is the shared scheduling calendar. So:
//   * website -> Microsoft: eligible bookings / public events are published as ONE event each (ACCEPTED = tentative, CONFIRMED = busy; enquiries never). What should be on the
//     calendar is recomputed from the database ("desired state") and compared with what was last sent, so every kind of change - and a change that was missed - is caught
//     without hooking each place that edits a booking. Create / update / remove follow from the comparison.
//   * Microsoft -> website: the calendar is read through Graph calendarView/delta. Events the website published are recognised through calendar_links; a change made to
//     one in Outlook is FLAGGED (status 'conflict') and nothing is overwritten on either side until an administrator decides; an event deleted in Outlook is flagged
//     ('external_deleted') and never re-created on its own, and its booking is never touched. Everybody else's appointments are mirrored read-only; Busy / Out-of-office ones
//     also hold the date for the public booking form (date_holds, block_type 'm365_sync'). A calendar change never edits a booking, quote, invoice or payment.
//   * No loops: the mapping table is the only identity; our own write is recognised by its change key (or by unchanged content when Exchange re-stamps the key);
//     pulled data never feeds the push (only database rows do); a foreign event is never sent back.
//   * No duplicates: the link row and a random create_token are written BEFORE anything is sent and the token is Graph's transactionId, so a retry after a crash or a lost
//     answer returns the same event instead of creating a second one.
//   * Recoverable: calendar_links doubles as the queue (pending / error rows with back-off); nothing the website wants on the calendar is dropped when Microsoft is down.
//   * Pull runs before push, so an edit made in Outlook is seen before the website would write over it.
// It is OFF until an administrator switches it on (and then only after a live check proves the app can write to the calendar).
'use strict';
const crypto = require('crypto');
const moment = require('moment-timezone');
const db = require('../database');
const graph = require('./m365-graph');
const model = require('./calendar-m365-model');
const { encodeEntities, decodeStoredText } = require('./html-sanitize');

const RUN_INTERVAL_MS = 2 * 60 * 1000;
const NUDGE_DELAY_MS = 4000;
const MAX_PUSH_OPS_PER_RUN = 60;
const MAX_PAGES_PER_RUN = 30;
const PAGE_SIZE = 50;
const WINDOW_PAST_DAYS = 30;
const WINDOW_FUTURE_DAYS = 365;
const REBASELINE_AFTER_MS = 24 * 60 * 60 * 1000;      // the delta window rolls forward once a day (a fresh full read)
const BACKOFF_MS = [60 * 1000, 5 * 60 * 1000, 15 * 60 * 1000, 60 * 60 * 1000, 6 * 60 * 60 * 1000];
const LOG_RETENTION_DAYS = 90;                         // the sync log (who / what / outcome) is kept for a quarter, then pruned
const KEEP_PAST_DAYS = 7;                              // a not-yet-published booking whose date is further back than this is not back-filled
const PREFER = `outlook.timezone="${model.GRAPH_TZ}"`;

const dbGet = (sql, p = []) => new Promise((resolve, reject) => db.get(sql, p, (e, r) => e ? reject(e) : resolve(r)));
const dbAll = (sql, p = []) => new Promise((resolve, reject) => db.all(sql, p, (e, r) => e ? reject(e) : resolve(r)));
const dbRun = (sql, p = []) => new Promise((resolve, reject) => db.run(sql, p, function (e) { e ? reject(e) : resolve(this); }));
const nowIso = () => new Date().toISOString();
const short = (v, n = 300) => String(v == null ? '' : v).replace(/\s+/g, ' ').slice(0, n);

let lastPrune = 0;
let running = false;
let defaultDeps = {};          // tests only (see _internals.setDefaultDeps): what scheduled / nudged runs use instead of the real settings
let nudgeTimer = null;
let nudgeAgain = false;

// ── state ────────────────────────────────────────────────────────────────────
const getState = () => dbGet('SELECT * FROM calendar_sync_state WHERE id = 1');
async function saveState(patch) {
    const keys = Object.keys(patch);
    if (!keys.length) return;
    await dbRun(`UPDATE calendar_sync_state SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = 1`, keys.map((k) => patch[k]));
}

async function logSync({ direction, action, sourceType = null, sourceId = null, graphEventId = null, outcome = 'ok', category = null, message = null, actorId = null }) {
    try {
        await dbRun(
            `INSERT INTO calendar_sync_log (direction, action, source_type, source_id, graph_event_id, outcome, category, message, actor_id) VALUES (?,?,?,?,?,?,?,?,?)`,
            [direction, action, sourceType, sourceId, graphEventId, outcome, category, message == null ? null : short(message), actorId]
        );
    } catch (e) { console.error('[calendar-m365] log write failed:', e.message); }
}

// Old log rows are removed at most every few hours, at the end of a successful run (no extra timer).
async function pruneLog(force = false) {
    if (!force && Date.now() - lastPrune < 6 * 60 * 60 * 1000) return 0;
    lastPrune = Date.now();
    try { return (await dbRun(`DELETE FROM calendar_sync_log WHERE at < datetime('now', ?)`, ['-' + LOG_RETENTION_DAYS + ' days'])).changes || 0; }
    catch (e) { console.error('[calendar-m365] log pruning failed:', e.message); return 0; }
}

// The latest log entries for an administrator (what the sync did, to which record, and why it failed). Messages were redacted when written; nothing from a booking's contact details is ever logged.
async function recentLog(limit = 50) {
    const rows = await dbAll(
        `SELECT l.id, l.at, l.direction, l.action, l.source_type, l.source_id, l.outcome, l.category, l.message, a.username AS actor
         FROM calendar_sync_log l LEFT JOIN admins a ON a.id = l.actor_id ORDER BY l.id DESC LIMIT ?`, [Math.min(Math.max(Number(limit) || 50, 1), 200)]);
    return rows.map((r) => ({ id: r.id, at: r.at, direction: r.direction, action: r.action, sourceType: r.source_type, sourceId: r.source_id, outcome: r.outcome, category: r.category, message: r.message, actor: r.actor || null }));
}

// What an API may show: no checkpoint URL, nothing from any event.
async function getStatus() {
    const s = await getState();
    let stats = null; try { stats = s.last_stats ? JSON.parse(s.last_stats) : null; } catch (e) { /* ignore */ }
    const counts = {};
    for (const r of await dbAll('SELECT sync_status, COUNT(*) AS n FROM calendar_links GROUP BY sync_status')) counts[r.sync_status] = r.n;
    const ext = await dbGet('SELECT COUNT(*) AS n FROM calendar_external_events WHERE end_date >= ?', [moment.tz(model.BUSINESS_TZ).format('YYYY-MM-DD')]);
    return {
        enabled: !!s.enabled, mailbox: s.mailbox || null, baselineAt: s.baseline_at, lastRunAt: s.last_run_at, lastSuccessAt: s.last_success_at,
        lastError: s.last_error, lastErrorCategory: s.last_error_category, consecutiveFailures: s.consecutive_failures, retryAfter: s.retry_after,
        lastStats: stats, hasCheckpoint: !!s.delta_link, links: counts, upcomingExternal: ext ? ext.n : 0, businessTimeZone: model.BUSINESS_TZ
    };
}

async function setEnabled(enabled, adminId) {
    const s = await getState();
    const patch = { enabled: enabled ? 1 : 0, enabled_by: adminId || null };
    if (enabled) { patch.retry_after = null; patch.consecutive_failures = 0; patch.last_error = null; patch.last_error_category = null; patch.delta_link = null; patch.baseline_at = null; }
    await saveState(patch);
    await logSync({ direction: 'admin', action: enabled ? 'enable' : 'disable', outcome: 'ok', actorId: adminId || null });
    return { before: !!s.enabled, after: !!enabled };
}

// ── safe URLs from Microsoft (shown to an administrator as links) ───────────────────────
const MS_HOST = /(^|\.)(office\.com|office365\.com|microsoft\.com|live\.com|skype\.com|outlook\.com)$/i;
function safeLink(u) {
    if (!u) return null;
    try {
        const url = new URL(String(u));
        if (url.username || url.password) return null;
        if (url.protocol === 'https:' && MS_HOST.test(url.hostname)) return url.toString().slice(0, 1000);
        if (process.env.NODE_ENV !== 'production' && url.protocol === 'http:' && /^(127\.0\.0\.1|localhost)$/.test(url.hostname)) return url.toString().slice(0, 1000);   // the fake Graph in tests
    } catch (e) { /* not a URL */ }
    return null;
}

// ── window ──────────────────────────────────────────────────────────────────────
function currentWindow() {
    const base = moment.tz(model.BUSINESS_TZ).startOf('day');
    return {
        startDateTime: base.clone().subtract(WINDOW_PAST_DAYS, 'days').format('YYYY-MM-DDTHH:mm:ssZ'),
        endDateTime: base.clone().add(WINDOW_FUTURE_DAYS, 'days').format('YYYY-MM-DDTHH:mm:ssZ'),
        startDate: base.clone().subtract(WINDOW_PAST_DAYS, 'days').format('YYYY-MM-DD')
    };
}

// ── links ─────────────────────────────────────────────────────────────────────
const linkByGraph = (id) => dbGet('SELECT * FROM calendar_links WHERE graph_event_id = ?', [id]);
const linkById = (id) => dbGet('SELECT * FROM calendar_links WHERE id = ?', [id]);
async function saveLink(id, patch) {
    const keys = Object.keys(patch);
    await dbRun(`UPDATE calendar_links SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [...keys.map((k) => patch[k]), id]);
}
const dueAt = (attempts) => new Date(Date.now() + BACKOFF_MS[Math.min(Math.max(attempts, 1), BACKOFF_MS.length) - 1]).toISOString();

// ── sources: what the website wants published ───────────────────────────────────────
const BOOKING_SQL = `SELECT b.id, b.status, b.date, b.event_start_time, b.performance_end_time, b.performance_duration, b.event_name, b.event_type, b.event_location, b.city, b.name,
                            COALESCE(c.full_name, b.name) AS client_name, v.name AS venue_name
                     FROM bookings b LEFT JOIN clients c ON b.client_id = c.id LEFT JOIN venues v ON b.venue_id = v.id`;
const EVENT_SQL = `SELECT e.event_id, e.event_title, e.event_datetime, e.event_start_time, e.event_end_time, e.event_status, e.booking_id, e.ticket_sales_link,
                          COALESCE(v.name, e.venue_name) AS venue_name
                   FROM events e LEFT JOIN venues v ON e.venue_id = v.id`;

const chunks = (arr, n = 400) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };

// Map of "type:id" -> { type, id, want (desired entry or null), keep (an existing entry is left alone), gone (source row no longer exists) }
async function loadSources(links) {
    const out = new Map();
    const horizon = moment.tz(model.BUSINESS_TZ).subtract(KEEP_PAST_DAYS, 'days').format('YYYY-MM-DD');
    const add = (type, id, row) => {
        if (!row) { out.set(`${type}:${id}`, { type, id, want: null, keep: false, gone: true }); return; }
        if (type === 'booking') out.set(`booking:${id}`, { type, id, want: model.desiredForBooking(row), keep: model.bookingRule(row.status).keep, gone: false });
        else out.set(`event:${id}`, { type, id, want: model.desiredForEvent(row), keep: model.eventRule(row.event_status, row.booking_id).keep, gone: false });
    };
    // new candidates
    for (const b of await dbAll(`${BOOKING_SQL} WHERE b.status IN ('ACCEPTED','CONFIRMED') AND b.date >= ?`, [horizon])) add('booking', b.id, b);
    for (const e of await dbAll(`${EVENT_SQL} WHERE e.booking_id IS NULL AND e.event_status IN ('upcoming','live','sold_out') AND substr(e.event_datetime, 1, 10) >= ?`, [horizon])) add('event', e.event_id, e);
    // everything that already has a link, whatever its status now (so a cancellation or a deletion is noticed)
    for (const type of ['booking', 'event']) {
        const ids = links.filter((l) => l.source_type === type).map((l) => l.source_id).filter((id) => !out.has(`${type}:${id}`));
        for (const part of chunks(ids)) {
            const rows = await dbAll(`${type === 'booking' ? BOOKING_SQL : EVENT_SQL} WHERE ${type === 'booking' ? 'b.id' : 'e.event_id'} IN (${part.map(() => '?').join(',')})`, part);
            const found = new Map(rows.map((r) => [type === 'booking' ? r.id : r.event_id, r]));
            for (const id of part) add(type, id, found.get(id));
        }
    }
    return out;
}

// ── Microsoft calls for one entry ───────────────────────────────────────────────────
const evPath = (id) => `/calendar/events/${encodeURIComponent(id)}`;
const writeHeaders = { Prefer: PREFER };

async function failLink(link, res, action, stats) {
    const attempts = (link.attempt_count || 0) + 1;
    const unconfirmed = !!res.unconfirmed;
    await saveLink(link.id, {
        // an unconfirmed create stays 'pending' with its token: the repeat is safe (Graph answers with the event it already made)
        sync_status: link.graph_event_id || !unconfirmed ? 'error' : 'pending', attempt_count: attempts, next_attempt_at: dueAt(attempts),
        last_error: short(unconfirmed ? 'Microsoft 365 did not confirm the change; it will be checked again automatically. ' + res.message : res.message), last_error_category: res.category || 'unknown'
    });
    await logSync({ direction: 'push', action, sourceType: link.source_type, sourceId: link.source_id, graphEventId: link.graph_event_id, outcome: 'error', category: res.category, message: res.message });
    stats.push.errors++;
}

async function dropExternalMirror(graphId) {
    await dbRun('DELETE FROM date_holds WHERE m365_event_id = ?', [graphId]);
    await dbRun('DELETE FROM calendar_external_events WHERE graph_event_id = ?', [graphId]);
}

async function createRemote(ctx, link, want, stats, request) {
    const res = await request(ctx, {
        method: 'POST', path: '/calendar/events', body: { ...want, transactionId: link.create_token }, resource: 'calendar', idempotent: true, headers: writeHeaders
    });
    if (!res.ok) { if (res.systemic) return res; await failLink(link, res, 'create', stats); return null; }
    const ev = res.json || {};
    await saveLink(link.id, {
        graph_event_id: ev.id, web_link: safeLink(ev.webLink), change_key: ev.changeKey || null, sync_status: 'synced', pushed_hash: model.hashDesired(want), pushed_json: JSON.stringify(model.comparable(want)),
        attempt_count: 0, next_attempt_at: null, last_error: null, last_error_category: null, conflict_json: null, last_pushed_at: nowIso(), last_synced_at: nowIso(), last_seen_at: nowIso()
    });
    if (ev.id) await dropExternalMirror(ev.id);   // if an earlier, unrecorded attempt had already made it, the pull may have mirrored it as somebody else's
    await logSync({ direction: 'push', action: 'create', sourceType: link.source_type, sourceId: link.source_id, graphEventId: ev.id });
    stats.push.created++;
    return null;
}

async function updateRemote(ctx, link, want, stats, request) {
    const res = await request(ctx, { method: 'PATCH', path: evPath(link.graph_event_id), body: want, resource: 'calendar', item: true, headers: writeHeaders });
    if (!res.ok && res.category === 'notfound') {
        await saveLink(link.id, { sync_status: 'external_deleted', last_error: 'This event was deleted in Microsoft 365.', last_error_category: 'notfound', next_attempt_at: null, conflict_json: null });
        await logSync({ direction: 'push', action: 'update', sourceType: link.source_type, sourceId: link.source_id, graphEventId: link.graph_event_id, outcome: 'error', category: 'notfound', message: 'The event no longer exists in Microsoft 365; not re-created automatically.' });
        stats.pull.externalDeleted++;
        return null;
    }
    if (!res.ok) { if (res.systemic) return res; await failLink(link, res, 'update', stats); return null; }
    const ev = res.json || {};
    await saveLink(link.id, {
        change_key: ev.changeKey || link.change_key, web_link: safeLink(ev.webLink) || link.web_link, sync_status: 'synced', pushed_hash: model.hashDesired(want), pushed_json: JSON.stringify(model.comparable(want)),
        attempt_count: 0, next_attempt_at: null, last_error: null, last_error_category: null, conflict_json: null, last_pushed_at: nowIso(), last_synced_at: nowIso()
    });
    await logSync({ direction: 'push', action: 'update', sourceType: link.source_type, sourceId: link.source_id, graphEventId: link.graph_event_id });
    stats.push.updated++;
    return null;
}

async function removeRemote(ctx, link, stats, request, why) {
    if (link.graph_event_id) {
        const res = await request(ctx, { method: 'DELETE', path: evPath(link.graph_event_id), resource: 'calendar', item: true });
        if (!res.ok && res.category !== 'notfound') { if (res.systemic) return res; await failLink(link, res, 'delete', stats); return null; }
    }
    await saveLink(link.id, { sync_status: 'removed', next_attempt_at: null, attempt_count: 0, last_error: null, last_error_category: null, conflict_json: null, last_synced_at: nowIso() });
    await logSync({ direction: 'push', action: 'delete', sourceType: link.source_type, sourceId: link.source_id, graphEventId: link.graph_event_id, message: why });
    stats.push.deleted++;
    return null;
}

// ── push: website -> Microsoft ───────────────────────────────────────────────────────
// Resolves null, or the failing result when the whole run must stop (sign-in / permission problems fail every call the same way).
async function pushPhase(ctx, stats, { force, request }) {
    const links = await dbAll('SELECT * FROM calendar_links');
    const byKey = new Map(links.map((l) => [`${l.source_type}:${l.source_id}`, l]));
    const sources = await loadSources(links);
    const keys = new Set([...sources.keys(), ...byKey.keys()]);
    const now = Date.now();
    let ops = 0;
    const take = () => { if (ops >= MAX_PUSH_OPS_PER_RUN) { stats.push.deferred++; return false; } ops++; return true; };

    for (const key of keys) {
        const src = sources.get(key) || { type: key.split(':')[0], id: Number(key.split(':')[1]), want: null, keep: false, gone: true };
        let link = byKey.get(key);
        const want = src.want;

        if (!link) {
            if (!want) continue;
            // the queue entry (with its token) is written before anything is sent - even when this run has no budget left, the entry is not lost
            const ins = await dbRun(`INSERT INTO calendar_links (source_type, source_id, create_token, sync_status) VALUES (?, ?, ?, 'pending')`, [src.type, src.id, crypto.randomUUID()]);
            link = await linkById(ins.lastID);
            if (!take()) continue;
            const stop = await createRemote(ctx, link, want, stats, request);
            if (stop) return stop;
            continue;
        }

        if (link.sync_status === 'external_deleted') {
            if (!want && !src.keep) { await saveLink(link.id, { sync_status: 'removed', last_error: null, last_error_category: null }); }
            else stats.push.waiting++;
            continue;
        }
        if (link.sync_status === 'conflict') {
            if (!want && !src.keep) { if (!take()) continue; const stop = await removeRemote(ctx, link, stats, request, src.gone ? 'the website record was deleted' : 'no longer eligible'); if (stop) return stop; }
            else stats.push.waiting++;
            continue;
        }
        if (link.sync_status === 'removed') {
            if (!want) continue;
            if (!take()) continue;
            // eligible again: a fresh entry with a fresh token (the old Microsoft event, if any, was already removed)
            await saveLink(link.id, { graph_event_id: null, create_token: crypto.randomUUID(), sync_status: 'pending', pushed_hash: null, pushed_json: null, change_key: null, web_link: null, attempt_count: 0, next_attempt_at: null, last_error: null, last_error_category: null });
            link = await linkById(link.id);
            const stop = await createRemote(ctx, link, want, stats, request);
            if (stop) return stop;
            continue;
        }

        // pending | error | synced
        if (!want) {
            if (src.keep) continue;                                      // COMPLETED: leave what is there
            if (!take()) continue;
            const stop = await removeRemote(ctx, link, stats, request, src.gone ? 'the website record was deleted' : 'no longer eligible');
            if (stop) return stop;
            continue;
        }
        const needs = !link.graph_event_id || model.hashDesired(want) !== link.pushed_hash;
        if (!needs) { if (link.sync_status !== 'synced') await saveLink(link.id, { sync_status: 'synced', attempt_count: 0, next_attempt_at: null, last_error: null, last_error_category: null }); continue; }
        if (!force && link.next_attempt_at && Date.parse(link.next_attempt_at) > now) { stats.push.waiting++; continue; }
        if (!take()) continue;
        const stop = link.graph_event_id ? await updateRemote(ctx, link, want, stats, request) : await createRemote(ctx, link, want, stats, request);
        if (stop) return stop;
    }
    return null;
}

// ── pull: Microsoft -> website ────────────────────────────────────────────────────────
async function markExternalDeleted(link, why, stats) {
    if (link.sync_status === 'external_deleted' || link.sync_status === 'removed') return;
    await saveLink(link.id, { sync_status: 'external_deleted', last_error: 'This event was deleted in Microsoft 365.', last_error_category: 'notfound', next_attempt_at: null, conflict_json: null });
    await logSync({ direction: 'pull', action: 'external_delete', sourceType: link.source_type, sourceId: link.source_id, graphEventId: link.graph_event_id, message: why });
    stats.pull.externalDeleted++;
}

async function syncHolds(r) {
    const want = model.blocksAvailability(r) ? model.daysCovered(r) : [];
    const have = await dbAll('SELECT id, hold_date, start_time, end_time FROM date_holds WHERE m365_event_id = ?', [r.id]);
    const haveBy = new Map(have.map((h) => [h.hold_date, h]));
    const wantBy = new Map(want.map((w) => [w.date, w]));
    for (const h of have) if (!wantBy.has(h.hold_date)) await dbRun('DELETE FROM date_holds WHERE id = ?', [h.id]);
    for (const w of want) {
        const h = haveBy.get(w.date);
        if (!h) {
            await dbRun(`INSERT INTO date_holds (hold_date, notes, status, hold_expires_at, start_time, end_time, block_type, m365_event_id) VALUES (?, 'Microsoft 365 calendar', 'active', '9999-12-31 23:59:59', ?, ?, 'm365_sync', ?)`,
                [w.date, w.start, w.end, r.id]);
        } else if ((h.start_time || null) !== w.start || (h.end_time || null) !== w.end) {
            await dbRun(`UPDATE date_holds SET start_time = ?, end_time = ?, status = 'active' WHERE id = ?`, [w.start, w.end, h.id]);
        }
    }
    return want.length;
}

async function upsertExternal(r, stats) {
    const blocks = model.blocksAvailability(r);
    await dbRun(
        `INSERT INTO calendar_external_events (graph_event_id, subject, start_date, start_time, end_date, end_time, all_day, show_as, location, is_online, join_url, web_link, series_master_id, change_key, blocks, graph_modified_at, last_seen_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
         ON CONFLICT(graph_event_id) DO UPDATE SET subject=excluded.subject, start_date=excluded.start_date, start_time=excluded.start_time, end_date=excluded.end_date, end_time=excluded.end_time,
            all_day=excluded.all_day, show_as=excluded.show_as, location=excluded.location, is_online=excluded.is_online, join_url=excluded.join_url, web_link=excluded.web_link,
            series_master_id=excluded.series_master_id, change_key=excluded.change_key, blocks=excluded.blocks, graph_modified_at=excluded.graph_modified_at, last_seen_at=CURRENT_TIMESTAMP`,
        [r.id, encodeEntities(r.subject), r.startDate, r.startTime, r.endDate, r.endTime, r.isAllDay ? 1 : 0, r.showAs, encodeEntities(r.location), r.isOnline ? 1 : 0, safeLink(r.joinUrl), safeLink(r.webLink),
            r.seriesMasterId, r.changeKey, blocks ? 1 : 0, r.modifiedAt]
    );
    stats.pull.holds += await syncHolds(r);
}

async function handleRemoved(id, stats) {
    stats.pull.removed++;
    const link = await linkByGraph(id);
    if (link) { await markExternalDeleted(link, 'removed in the delta feed', stats); return; }
    await dropExternalMirror(id);
}

async function handleEvent(e, stats, seen) {
    const r = model.normalizeRemote(e);
    if (!r) { stats.pull.unreadable++; return; }
    if (seen) seen.add(r.id);
    const link = await linkByGraph(r.id);
    if (!link) {
        if (r.isCancelled) { await dropExternalMirror(r.id); return; }
        stats.pull.foreign++;
        await upsertExternal(r, stats);
        return;
    }
    stats.pull.known++;
    await dbRun('DELETE FROM calendar_external_events WHERE graph_event_id = ?', [r.id]);
    if (link.sync_status === 'removed') return;                           // we deleted it; Microsoft has not caught up yet
    if (r.isCancelled) { await markExternalDeleted(link, 'cancelled in Microsoft 365', stats); return; }
    if (link.sync_status === 'external_deleted') {
        // it is back (restored in Outlook): treat it as ours again and compare
        await saveLink(link.id, { sync_status: 'pending', last_error: null, last_error_category: null });
    }
    const patch = { last_seen_at: nowIso(), web_link: safeLink(r.webLink) || link.web_link };
    if (r.changeKey && r.changeKey === link.change_key) { await saveLink(link.id, patch); return; }   // our own write coming back: the loop breaker
    let pushed = null; try { pushed = link.pushed_json ? JSON.parse(link.pushed_json) : null; } catch (err) { pushed = null; }
    const remote = model.remoteComparable(r);
    if (pushed && model.sameSchedule(remote, pushed)) {
        // Exchange re-stamped the change key (or only the body / categories changed): nothing the website owns differs
        await saveLink(link.id, { ...patch, change_key: r.changeKey });
        return;
    }
    if (!pushed) { await saveLink(link.id, { ...patch, change_key: r.changeKey }); return; }   // a create that was recorded without its content; adopt
    // somebody changed the schedule / title / place / availability in Outlook: flag it, change nothing
    const snapshot = JSON.stringify(remote);
    if (link.sync_status !== 'conflict' || link.conflict_json !== snapshot) {
        await saveLink(link.id, { ...patch, change_key: r.changeKey, sync_status: 'conflict', conflict_json: snapshot, last_error: 'Changed in Microsoft 365; the website and the calendar now disagree.', last_error_category: 'conflict', next_attempt_at: null });
        await logSync({ direction: 'pull', action: 'conflict', sourceType: link.source_type, sourceId: link.source_id, graphEventId: r.id, outcome: 'skipped', category: 'conflict', message: 'edited in Microsoft 365' });
        stats.pull.conflicts++;
    } else {
        await saveLink(link.id, patch);
    }
}

// Reads the calendar through calendarView/delta. Three situations:
//   * a saved deltaLink and a baseline younger than a day -> only what changed since;
//   * a saved nextLink without a baseline -> a full read that ran out of its page budget: carry on where it stopped (no sweep: this run did not see all of it);
//   * otherwise -> a fresh full read of the window (first run, once a day, or after Microsoft dropped the checkpoint), which ends with a sweep of what was not seen.
async function pullPhase(ctx, state, stats, { request, maxPages = MAX_PAGES_PER_RUN, pageSize = PAGE_SIZE }) {
    const win = currentWindow();
    const baselineAge = state.baseline_at ? Date.now() - Date.parse(state.baseline_at) : Infinity;
    const resuming = !!state.delta_link && !state.baseline_at;
    let mode = resuming ? 'resume' : (state.delta_link && baselineAge <= REBASELINE_AFTER_MS ? 'incremental' : 'full');
    for (let attempt = 1; attempt <= 2; attempt++) {
        const headers = { Prefer: `odata.maxpagesize=${pageSize}, ${PREFER}` };
        let req = mode === 'full'
            ? { path: '/calendarView/delta', query: { startDateTime: win.startDateTime, endDateTime: win.endDateTime }, headers }
            : { url: state.delta_link, path: '/calendarView/delta', headers };
        const seen = mode === 'full' ? new Set() : null;
        let checkpoint = null, finished = false, failure = null;
        for (let page = 0; page < maxPages; page++) {
            const res = await request(ctx, { ...req, resource: 'calendar' });
            if (!res.ok) { failure = res; break; }
            stats.pull.pages++;
            for (const e of (res.json && res.json.value) || []) {
                stats.pull.seen++;
                try { if (e['@removed']) await handleRemoved(e.id, stats); else await handleEvent(e, stats, seen); }
                catch (err) { console.error('[calendar-m365] one event could not be processed:', err.message); stats.pull.unreadable++; }   // never log the event itself
            }
            const j = res.json || {};
            if (j['@odata.deltaLink']) { checkpoint = j['@odata.deltaLink']; finished = true; break; }
            if (!j['@odata.nextLink']) { finished = true; break; }
            checkpoint = j['@odata.nextLink'];                    // if the page budget runs out, the next run continues from here
            req = { url: j['@odata.nextLink'], path: '/calendarView/delta', headers };
        }
        if (failure) {
            if (failure.category === 'resync' && mode !== 'full' && attempt === 1) { mode = 'full'; await saveState({ delta_link: null, baseline_at: null }); continue; }   // Microsoft dropped the checkpoint: read the window afresh, once
            return failure;
        }
        if (mode === 'full' && finished && seen) await finishFullRound(seen, win, stats);
        const patch = { mailbox: ctx.mailbox, window_start: win.startDate, window_end: win.endDateTime.slice(0, 10) };
        if (finished) { patch.delta_link = checkpoint || state.delta_link; patch.baseline_at = mode === 'incremental' ? state.baseline_at : nowIso(); }
        else { patch.delta_link = checkpoint; patch.baseline_at = null; }       // unfinished full read: remember where to resume
        await saveState(patch);
        return null;
    }
    return null;
}

// A complete read of the window: whatever the window no longer contains was removed (or aged out) - tidy the mirrors; a website-owned entry that is inside the window but absent is flagged.
async function finishFullRound(seen, win, stats) {
    for (const m of await dbAll('SELECT graph_event_id, end_date FROM calendar_external_events')) {
        if (!seen.has(m.graph_event_id)) { await dropExternalMirror(m.graph_event_id); stats.pull.removed++; }
    }
    for (const l of await dbAll(`SELECT * FROM calendar_links WHERE graph_event_id IS NOT NULL AND sync_status IN ('synced','pending','error','conflict')`)) {
        if (seen.has(l.graph_event_id)) continue;
        let start = ''; try { start = JSON.parse(l.pushed_json || '{}').start || ''; } catch (e) { /* ignore */ }
        if (start && start.slice(0, 10) >= win.startDate) await markExternalDeleted(l, 'absent from a full read of the calendar', stats);
    }
}

// ── one run ──────────────────────────────────────────────────────────────────────
const newStats = () => ({
    pull: { pages: 0, seen: 0, known: 0, foreign: 0, removed: 0, conflicts: 0, externalDeleted: 0, unreadable: 0, holds: 0 },
    push: { created: 0, updated: 0, deleted: 0, errors: 0, waiting: 0, deferred: 0 }
});

async function failRun(state, category, message, systemic, throttled) {
    const n = (state.consecutive_failures || 0) + 1;
    const waitMin = throttled ? 5 : systemic ? 15 : Math.min(60, Math.pow(2, Math.min(n, 5)));
    await saveState({
        last_run_at: nowIso(), last_error: short(message, 480), last_error_category: category, consecutive_failures: n, retry_after: new Date(Date.now() + waitMin * 60000).toISOString()
    });
    await logSync({ direction: 'system', action: 'run', outcome: 'error', category, message });
    return { ok: false, category, error: message };
}

/**
 * One sync run (pull, then push). force = ignore the enabled switch and the back-off (the administrator's "Sync now"). deps (tests only): { resolveContext, graphRequest }.
 * Resolves { ok, stats } or { ok:false, category, error } or { ok:true, skipped } - never throws.
 */
async function runSync({ force = false, deps = defaultDeps } = {}) {
    if (running) { nudgeAgain = true; return { ok: true, skipped: 'a sync is already running' }; }
    running = true;
    try {
        let state = await getState();
        if (!force && !state.enabled) return { ok: true, skipped: 'sync is switched off' };
        const resolveContext = deps.resolveContext || graph.resolveContext;
        const request = deps.graphRequest || graph.graphRequest;

        const r = await resolveContext();
        if (!r.ok) return await failRun(state, 'config', r.message, true, false);
        const ctx = r.ctx;
        if (state.mailbox && state.mailbox !== ctx.mailbox) { await saveState({ delta_link: null, baseline_at: null }); state = await getState(); }

        const stats = newStats();
        const pulled = await pullPhase(ctx, state, stats, { request, maxPages: deps.maxPages, pageSize: deps.pageSize });
        if (pulled) return { ...(await failRun(state, pulled.category, pulled.message, !!pulled.systemic, pulled.category === 'throttled')), stats };   // no push while the calendar cannot be read: an Outlook edit must be seen first
        const pushed = await pushPhase(ctx, stats, { force, request });
        if (pushed) return { ...(await failRun(state, pushed.category, pushed.message, !!pushed.systemic, pushed.category === 'throttled')), stats };

        await saveState({
            last_run_at: nowIso(), last_success_at: nowIso(), last_error: null, last_error_category: null, consecutive_failures: 0, retry_after: null, mailbox: ctx.mailbox, last_stats: JSON.stringify(stats)
        });
        pruneLog().catch(() => {});
        const p = stats.push, q = stats.pull;
        if (p.created || p.updated || p.deleted || q.conflicts || q.externalDeleted) {
            console.log(`[calendar-m365] pushed ${p.created} new, ${p.updated} updated, ${p.deleted} removed; ${q.conflicts} changed and ${q.externalDeleted} deleted in Microsoft 365 (flagged).`);
        }
        return { ok: true, stats };
    } catch (e) {
        console.error('[calendar-m365] run failed:', e.message);
        try { return await failRun(await getState(), 'internal', 'The sync hit an unexpected problem.', false, false); } catch (e2) { return { ok: false, category: 'internal', error: 'The sync hit an unexpected problem.' }; }
    } finally {
        running = false;
        if (nudgeAgain) { nudgeAgain = false; requestSync('queued while running'); }
    }
}

// The scheduler's entry point (lib/background-clerk.js): cheap when switched off.
async function runIfDue() {
    const s = await getState().catch(() => null);
    if (!s || !s.enabled) return null;
    if (s.retry_after && Date.now() < Date.parse(s.retry_after)) return null;
    if (s.last_run_at && Date.now() - Date.parse(s.last_run_at) < RUN_INTERVAL_MS) return null;
    return runSync();
}

// "Something that may be on the calendar just changed": a debounced run a few seconds later (the periodic run is the safety net). Never throws, never blocks the caller.
function requestSync(reason) {
    if (nudgeTimer) return;
    nudgeTimer = setTimeout(async () => {
        nudgeTimer = null;
        try {
            const s = await getState();
            if (!s || !s.enabled || (s.retry_after && Date.now() < Date.parse(s.retry_after))) return;
            await runSync();
        } catch (e) { console.error('[calendar-m365] nudged run failed:', e.message); }
    }, NUDGE_DELAY_MS);
    if (nudgeTimer.unref) nudgeTimer.unref();
}

// ── administrator actions ───────────────────────────────────────────────────────────
// A failed entry is retried at once (the back-off is cleared) by the next run.
async function retryLink(id, adminId) {
    const link = await linkById(id);
    if (!link) return { ok: false, status: 404, message: 'That calendar entry was not found.' };
    if (link.sync_status !== 'error' && link.sync_status !== 'pending') return { ok: false, status: 409, message: 'Only a failed or waiting entry can be retried.' };
    await saveLink(link.id, { next_attempt_at: null, updated_by: adminId || null });
    await logSync({ direction: 'admin', action: 'retry', sourceType: link.source_type, sourceId: link.source_id, graphEventId: link.graph_event_id, actorId: adminId || null });
    return { ok: true, link: await linkById(id) };
}

// An entry deleted in Outlook comes back only when an administrator asks for it.
async function recreateLink(id, adminId) {
    const link = await linkById(id);
    if (!link) return { ok: false, status: 404, message: 'That calendar entry was not found.' };
    if (link.sync_status !== 'external_deleted') return { ok: false, status: 409, message: 'Only an entry deleted in Microsoft 365 can be re-created.' };
    await saveLink(link.id, { sync_status: 'removed', graph_event_id: null, updated_by: adminId || null });
    await logSync({ direction: 'admin', action: 'recreate', sourceType: link.source_type, sourceId: link.source_id, graphEventId: link.graph_event_id, actorId: adminId || null });
    return { ok: true, link: await linkById(id) };
}

// Somebody changed an entry in Outlook. 'keep_website': the website's version is sent again (the Outlook change is overwritten, on purpose, by an administrator).
// 'accept_microsoft': the Microsoft version becomes the booking's / event's schedule through deps.applyExternalSchedule - the existing, validated date-change path
// (conflict check, client notice) - never by writing the tables from here.
async function resolveConflict(id, choice, adminId, deps = {}) {
    const link = await linkById(id);
    if (!link) return { ok: false, status: 404, message: 'That calendar entry was not found.' };
    if (link.sync_status !== 'conflict') return { ok: false, status: 409, message: 'This entry has no conflict to resolve.' };
    if (choice === 'keep_website') {
        await saveLink(link.id, { sync_status: 'pending', pushed_hash: null, conflict_json: null, last_error: null, last_error_category: null, next_attempt_at: null, updated_by: adminId || null });
        await logSync({ direction: 'admin', action: 'resolve_keep_website', sourceType: link.source_type, sourceId: link.source_id, graphEventId: link.graph_event_id, actorId: adminId || null });
        return { ok: true, link: await linkById(id) };
    }
    if (choice === 'accept_microsoft') {
        const apply = deps.applyExternalSchedule;
        if (typeof apply !== 'function') return { ok: false, status: 501, message: 'Accepting the Microsoft 365 time is not available.' };
        let remote = null; try { remote = JSON.parse(link.conflict_json || 'null'); } catch (e) { remote = null; }
        if (!remote) return { ok: false, status: 409, message: 'The Microsoft 365 version is no longer known; run a sync first.' };
        const applied = await apply({ link, remote, adminId });
        if (!applied || !applied.ok) return { ok: false, status: applied && applied.status || 422, message: (applied && applied.message) || 'The change could not be applied.' };
        // the schedule now matches Microsoft; the next push re-sends the website's own wording of it (title, place, availability) if that differs
        await saveLink(link.id, { sync_status: 'pending', pushed_hash: null, pushed_json: JSON.stringify(remote), conflict_json: null, last_error: null, last_error_category: null, next_attempt_at: null, updated_by: adminId || null });
        await logSync({ direction: 'admin', action: 'resolve_accept_microsoft', sourceType: link.source_type, sourceId: link.source_id, graphEventId: link.graph_event_id, actorId: adminId || null });
        return { ok: true, link: await linkById(id) };
    }
    return { ok: false, status: 400, message: 'choice must be keep_website or accept_microsoft.' };
}

// ── the calendar screen ──────────────────────────────────────────────────────────────────────
// Everybody else's appointments, as read-only calendar items. Titles are decoded to plain text here: the screen must put them on the page as TEXT, never as HTML.
async function externalCalendarEvents() {
    const from = moment.tz(model.BUSINESS_TZ).subtract(WINDOW_PAST_DAYS + 1, 'days').format('YYYY-MM-DD');
    const rows = await dbAll('SELECT * FROM calendar_external_events WHERE end_date >= ? ORDER BY start_date, start_time', [from]);
    return rows.map((r) => {
        const allDay = !!r.all_day;
        return {
            id: 'x-' + r.graph_event_id, title: decodeStoredText(r.subject) || '(No title)', allDay,
            start: allDay ? r.start_date : `${r.start_date}T${r.start_time || '00:00'}`,
            end: allDay ? r.end_date : `${r.end_date}T${r.end_time || r.start_time || '00:00'}`,
            extendedProps: {
                type: 'external', source: 'm365', showAs: r.show_as, location: decodeStoredText(r.location || ''), blocks: !!r.blocks,
                webLink: safeLink(r.web_link), joinUrl: safeLink(r.join_url), isOnline: !!r.is_online, recurring: !!r.series_master_id
            }
        };
    });
}

// Adds each booking's / event's sync entry (extendedProps.m365), hides the holds that only mirror Microsoft appointments (the appointment itself is shown instead),
// and appends the Microsoft appointments. Never throws: on any problem the calendar is served as it was.
async function decorateCalendarEvents(events) {
    try {
        const ofType = (t) => events.filter((e) => e.extendedProps && e.extendedProps.type === t);
        const [bookings, publicEvents] = await Promise.all([
            summariesFor('booking', ofType('booking').map((e) => e.extendedProps.dbId)),
            summariesFor('event', ofType('public_event').map((e) => e.extendedProps.dbId))
        ]);
        for (const e of ofType('booking')) e.extendedProps.m365 = bookings.get(Number(e.extendedProps.dbId)) || null;
        for (const e of ofType('public_event')) e.extendedProps.m365 = publicEvents.get(Number(e.extendedProps.dbId)) || null;
        const shown = events.filter((e) => !(e.extendedProps && e.extendedProps.type === 'hold' && e.extendedProps.blockType === 'm365_sync'));
        return shown.concat(await externalCalendarEvents());
    } catch (e) {
        console.error('[calendar-m365] could not add Microsoft 365 information to the calendar:', e.message);
        return events;
    }
}

// "Use the Microsoft 365 time": see lib/booking-reschedule.js (required lazily: it pulls in the booking e-mail and calendar code).
const applyExternalSchedule = (args) => require('./booking-reschedule').applyExternalSchedule(args);

// ── what an API / the calendar screen may show about an entry ───────────────────────────────
// Plain text out of the shared calendar (conflict.* comes from Outlook): render with textContent, never as HTML. No tokens, no create_token, no checkpoint.
function publicLink(l) {
    if (!l) return null;
    let conflict = null;
    if (l.conflict_json) { try { const c = JSON.parse(l.conflict_json); conflict = { subject: c.subject, start: c.start, end: c.end, isAllDay: !!c.isAllDay, location: c.location, showAs: c.showAs }; } catch (e) { conflict = null; } }
    const attention = ['error', 'conflict', 'external_deleted'].includes(l.sync_status);
    return {
        id: l.id, sourceType: l.source_type, sourceId: l.source_id, status: l.sync_status, lastSyncedAt: l.last_synced_at, lastSeenAt: l.last_seen_at, lastPushedAt: l.last_pushed_at,
        attempts: l.attempt_count, nextAttemptAt: l.next_attempt_at, error: attention || l.last_error ? l.last_error : null, errorCategory: l.last_error_category || null,
        webLink: safeLink(l.web_link), hasMicrosoftEvent: !!l.graph_event_id, conflict
    };
}
const linkForSource = (type, id) => dbGet('SELECT * FROM calendar_links WHERE source_type = ? AND source_id = ?', [type, id]);
async function getEntry(type, id) { return publicLink(await linkForSource(type, id)); }
async function listEntries({ status = null, sourceType = null, limit = 100, offset = 0 } = {}) {
    const where = [], params = [];
    if (status) { where.push('sync_status = ?'); params.push(status); }
    if (sourceType) { where.push('source_type = ?'); params.push(sourceType); }
    const rows = await dbAll(`SELECT * FROM calendar_links ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`, [...params, Math.min(Math.max(Number(limit) || 100, 1), 500), Math.max(Number(offset) || 0, 0)]);
    return rows.map(publicLink);
}
// Map sourceId -> summary for a page of bookings / events (the calendar screen's badges)
async function summariesFor(type, ids) {
    const out = new Map();
    for (const part of chunks([...new Set(ids.map(Number).filter(Number.isFinite))])) {
        for (const l of await dbAll(`SELECT * FROM calendar_links WHERE source_type = ? AND source_id IN (${part.map(() => '?').join(',')})`, [type, ...part])) out.set(l.source_id, publicLink(l));
    }
    return out;
}

module.exports = {
    runSync, runIfDue, requestSync, getStatus, setEnabled, retryLink, recreateLink, resolveConflict, logSync, currentWindow, safeLink, RUN_INTERVAL_MS,
    publicLink, getEntry, listEntries, summariesFor, linkForSource, applyExternalSchedule, externalCalendarEvents, decorateCalendarEvents, pruneLog, recentLog,
    // for the calendar API and tests
    _internals: { getState, saveState, linkById, dbAll, dbGet, dbRun, setDefaultDeps: (d) => { defaultDeps = d || {}; } }
};
