// Event ticketing - the door: what a scanned ticket looks like to staff, and DOOR LINKS (migration 115).
// A door link is a per-show, expiring, revocable link an administrator / manager creates in Events -> Ticket Sales and gives a volunteer.
// Opened on any phone (/checkin?pass=...), it can look up and check in tickets for THAT show only - no portal account, no buyer e-mails or
// phone numbers, no money, nothing about other shows. Only a SHA-256 hash of its secret is stored; the link is shown once, when created.
// Door staff with a portal login keep using the same scanner with their session (routes/admin/ticketing.js).
const crypto = require('crypto');
const { dbRun, dbGet, dbAll } = require('./db-helpers');
const core = require('./ticketing-core');
const ticketing = require('./ticketing');

const hash = (secret) => crypto.createHash('sha256').update(String(secret)).digest('hex');
const LABEL_MAX = 40;

// What a scanned ticket looks like at the door. Never the buyer's e-mail / phone. checked_in_seconds_ago is by the SERVER's clock so a
// phone can tell "my own check-in a moment ago went through" without trusting its own clock (js/checkin.js).
function doorView(t) {
    return t && {
        token: t.token, event_id: t.event_id, event_title: core.tidy(t.event_title), when: core.formatSast(core.eventStart({ event_datetime: t.event_datetime })),
        tier: t.tier_name, holder: t.holder_name || t.buyer_name || '', order_id: t.order_id,
        status: t.voided_at || t.order_status !== 'paid' ? 'void' : (t.checked_in_at ? 'checked_in' : 'valid'),
        checked_in_at: t.checked_in_at, checked_in_label: t.checked_in_at ? core.formatSast(t.checked_in_at, 'HH:mm') : null,
        checked_in_by: t.checked_in_by_name || (t.checked_in_via ? t.checked_in_via + ' (door link)' : null),
        checked_in_seconds_ago: t.checked_in_at ? Math.max(0, Math.round((Date.now() - Date.parse(t.checked_in_at)) / 1000)) : null
    };
}

// Default expiry: the end of show night (the show's start + 12 hours), or 24 hours from now for an undated show.
function defaultExpiry(event, now = new Date()) {
    const start = core.eventStart(event);
    const end = start ? new Date(start.getTime() + 12 * 3600 * 1000) : new Date(now.getTime() + 24 * 3600 * 1000);
    return (end > now ? end : new Date(now.getTime() + 6 * 3600 * 1000)).toISOString();
}

// Resolves { pass, secret } - the secret is returned ONCE (it only exists in the link from now on).
async function createPass(eventId, label, adminId) {
    const ev = await ticketing.getEvent(eventId);
    if (!ev) throw new ticketing.Refusal(404, 'Event not found.');
    if (ev.booking_id) throw new ticketing.Refusal(409, 'This event does not sell tickets.');
    const clean = core.oneLine(label).slice(0, LABEL_MAX);
    if (clean.length < 2) throw new ticketing.Refusal(400, 'Give the door link a name (e.g. "Front door" or the volunteer\'s name).');
    const secret = core.randomToken();
    const ins = await ticketing.inTransaction(() => dbRun(
        'INSERT INTO ticket_door_passes (event_id, token_hash, label, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
        [ev.event_id, hash(secret), clean, adminId || null, new Date().toISOString(), defaultExpiry(ev)]));
    return { pass: await dbGet('SELECT id, event_id, label, created_at, expires_at, revoked_at, last_used_at FROM ticket_door_passes WHERE id = ?', [ins.lastID]), secret };
}

const listPasses = (eventId) => dbAll(
    `SELECT p.id, p.label, p.created_at, p.expires_at, p.revoked_at, p.last_used_at, a.username AS created_by_name,
            (SELECT COUNT(*) FROM tickets k WHERE k.checked_in_via = p.label AND k.order_id IN (SELECT id FROM ticket_orders WHERE event_id = p.event_id)) AS check_ins
     FROM ticket_door_passes p LEFT JOIN admins a ON a.id = p.created_by WHERE p.event_id = ? ORDER BY p.id DESC`, [eventId]);

async function revokePass(eventId, passId) {
    const r = await ticketing.inTransaction(() => dbRun('UPDATE ticket_door_passes SET revoked_at = ? WHERE id = ? AND event_id = ? AND revoked_at IS NULL', [new Date().toISOString(), passId, eventId]));
    if (!r.changes) throw new ticketing.Refusal(404, 'That door link was not found or is already switched off.');
}

// The pass behind a request's x-door-pass header, or null (unknown, switched off, expired). Touches last_used_at at most once a minute.
async function resolvePass(secret) {
    if (!core.isTokenShape(secret)) return null;
    const p = await dbGet('SELECT * FROM ticket_door_passes WHERE token_hash = ?', [hash(secret)]);
    const now = new Date().toISOString();
    if (!p || p.revoked_at || p.expires_at <= now) return null;
    if (!p.last_used_at || Date.parse(now) - Date.parse(p.last_used_at) > 60000) {
        ticketing.inTransaction(() => dbRun('UPDATE ticket_door_passes SET last_used_at = ? WHERE id = ?', [now, p.id])).catch(() => {});
    }
    return p;
}

module.exports = { doorView, defaultExpiry, createPass, listPasses, revokePass, resolvePass, hash };
