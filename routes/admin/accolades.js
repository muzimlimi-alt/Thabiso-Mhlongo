// Accolades & Recognition admin CRUD — same shape as routes/admin/team.js (requireAdmin on reads and
// edits, requireRole(['administrator']) on delete, logAudit + resolveActor for the audit trail and the
// "Last updated by" footer). Every rule about what a valid accolade is, and what the website does with
// it, lives in lib/accolades.js; this file only sequences the writes.
//
// Writes run inside withDbTransaction (lib/db-transaction.js): the duplicate check and the write it
// guards happen back to back, so a double-clicked Save cannot record the same award twice (the unique
// index in database.js is the backstop), and no write can land inside another route's open transaction.
const express = require('express');
const { requireAdmin } = require('../../middleware/auth');
const { requireRole } = require('../../middleware/rbac');
const { dbRun, dbGet, dbAll } = require('../../lib/db-helpers');
const { withDbTransaction } = require('../../lib/db-transaction');
const { logAudit } = require('../../lib/audit-log');
const { resolveActor } = require('../../lib/actor');
const { getAdminAccoladesView, prepareAccolade, findDuplicate, auditSnapshot } = require('../../lib/accolades');
const router = express.Router();

const BULK_MAX = 200;
// Bulk actions other than delete (delete is administrator-only, see the route below).
const BULK_CHANGES = {
    publish:   { status: 'active' },
    unpublish: { status: 'inactive' },
    feature:   { featured: 1 },
    unfeature: { featured: 0 }
};

// Awaited before responding, so the audit row exists by the time the admin (or a test) sees the
// save succeed. A failed audit write is logged, never turned into a failed save.
const logAuditSafe = entry => logAudit(entry).catch(e => console.error('logAudit failed:', e));

async function lastUpdated(req) {
    const actor = await resolveActor(req.session.adminId);
    return { name: actor.name, role: actor.role, at: new Date().toISOString() };
}

function parseId(raw) {
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? n : null;
}

// A list of distinct positive ids, or null.
function parseIdList(list, max) {
    if (!Array.isArray(list) || !list.length || list.length > max) return null;
    const ids = list.map(Number);
    if (!ids.every(n => Number.isInteger(n) && n > 0) || new Set(ids).size !== ids.length) return null;
    return ids;
}

const isUniqueViolation = e => /UNIQUE constraint failed/i.test((e && e.message) || '');

function duplicateBody(dup) {
    return {
        success: false,
        duplicate_id: dup ? dup.id : null,
        message: 'This accolade is already recorded' + (dup && dup.status !== 'active' ? ' (it is currently hidden from the website)' : '')
            + ' — edit the existing entry instead of adding it again.'
    };
}

const failed = (status, message, extra) => ({ status, body: Object.assign({ success: false, message }, extra || {}) });

// Admin: every accolade, published or not, in the SAME order as the website, annotated with what the
// website does with each (is_public / public_position) — built by lib/accolades.js, which the public
// API also uses, so the two views cannot drift apart.
router.get('/api/admin/accolades', requireAdmin, async (req, res) => {
    try {
        res.set('Cache-Control', 'no-store');
        res.json(await getAdminAccoladesView());
    } catch (err) {
        console.error('[Accolades] list failed:', err.message);
        res.status(500).json({ success: false, message: 'Could not load accolades.' });
    }
});

router.post('/api/admin/accolades', requireAdmin, async (req, res) => {
    const prepared = prepareAccolade(req.body, null);
    if (prepared.error) return res.status(400).json({ success: false, message: prepared.error, field: prepared.field });
    const v = prepared.values;
    try {
        const outcome = await withDbTransaction(async () => {
            const dup = await findDuplicate(v, null);
            if (dup) return { status: 409, body: duplicateBody(dup) };
            try {
                const r = await dbRun(
                    `INSERT INTO accolades (title, category, year, achievement_date, organisation, event_name, result, description, location,
                                            image, organisation_logo, certificate_file, external_url, source_url, featured, status, display_order, created_by)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                             COALESCE(?, (SELECT IFNULL(MAX(display_order), 0) + 1 FROM accolades)), ?)`,
                    [v.title, v.category, v.year, v.achievement_date, v.organisation, v.event_name, v.result, v.description, v.location,
                     v.image, v.organisation_logo, v.certificate_file, v.external_url, v.source_url, v.featured, v.status, v.display_order,
                     req.session.adminId]);
                return { status: 200, id: r.lastID };
            } catch (e) {
                if (isUniqueViolation(e)) return { status: 409, body: duplicateBody(await findDuplicate(v, null)) };
                throw e;
            }
        });
        if (outcome.status !== 200) return res.status(outcome.status).json(outcome.body);
        const row = await dbGet('SELECT * FROM accolades WHERE id = ?', [outcome.id]);
        await logAuditSafe({ tableName: 'accolades', recordId: outcome.id, action: 'create', req, oldValues: null, newValues: auditSnapshot(row) });
        res.json({ success: true, id: outcome.id, last_updated: await lastUpdated(req) });
    } catch (err) {
        console.error('[Accolades] create failed:', err.message);
        res.status(500).json({ success: false, message: 'Could not save the accolade.' });
    }
});

// Registered before /:id so "reorder" is never read as an id. The body lists EVERY accolade id in the
// new order (the admin always sends the full list); a stale list is refused rather than half-applied.
router.put('/api/admin/accolades/reorder', requireAdmin, async (req, res) => {
    const ids = parseIdList(req.body && req.body.order, 100000);
    if (!ids) return res.status(400).json({ success: false, message: 'order must list every accolade id exactly once.' });
    try {
        const outcome = await withDbTransaction(async () => {
            const known = (await dbAll('SELECT id FROM accolades')).map(r => r.id);
            const knownSet = new Set(known);
            if (known.length !== ids.length || !ids.every(id => knownSet.has(id))) {
                return failed(409, 'The list changed since it was loaded — refresh and try again.');
            }
            try {
                await dbRun('BEGIN IMMEDIATE');
            } catch (beginErr) {
                console.error('[Accolades] reorder BEGIN failed:', beginErr.message);
                return failed(500, 'Could not save the new order.');
            }
            try {
                for (let i = 0; i < ids.length; i++) {
                    await dbRun('UPDATE accolades SET display_order = ? WHERE id = ?', [i, ids[i]]);
                }
                await dbRun('COMMIT');
                return { status: 200, body: { success: true } };
            } catch (e) {
                await dbRun('ROLLBACK').catch(() => {});
                console.error('[Accolades] reorder failed:', e.message);
                return failed(500, 'Could not save the new order.');
            }
        });
        if (outcome.status === 200) {
            await logAuditSafe({ tableName: 'accolades', recordId: 0, action: 'reorder', req, oldValues: null, newValues: { order: ids } });
        }
        res.status(outcome.status).json(outcome.body);
    } catch (err) {
        console.error('[Accolades] reorder failed:', err.message);
        res.status(500).json({ success: false, message: 'Could not save the new order.' });
    }
});

// Publish / unpublish / feature / unfeature / delete several accolades at once, all-or-nothing. Delete
// goes through the same administrator-only gate as the single DELETE route below.
router.post('/api/admin/accolades/bulk', requireAdmin,
    (req, res, next) => (req.body && req.body.action === 'delete' ? requireRole(['administrator'])(req, res, next) : next()),
    async (req, res) => {
        const action = req.body && req.body.action;
        // Own keys only: "constructor" / "__proto__" must not resolve to something inherited.
        if (action !== 'delete' && !(typeof action === 'string' && Object.prototype.hasOwnProperty.call(BULK_CHANGES, action))) {
            return res.status(400).json({ success: false, message: 'Unknown bulk action.' });
        }
        const ids = parseIdList(req.body.ids, BULK_MAX);
        if (!ids) return res.status(400).json({ success: false, message: `Select between 1 and ${BULK_MAX} accolades.` });
        const change = BULK_CHANGES[action] || null;
        try {
            const outcome = await withDbTransaction(async () => {
                const rows = await dbAll(`SELECT * FROM accolades WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
                if (rows.length !== ids.length) return failed(404, 'Some of the selected accolades no longer exist — refresh and try again.');
                // Rows already in the requested state are left alone (and not audited as a no-op change).
                const targets = change ? rows.filter(r => Object.keys(change).some(k => r[k] != change[k])) : rows;
                if (!targets.length) return { status: 200, body: { success: true, changed: 0 }, targets };
                try {
                    await dbRun('BEGIN IMMEDIATE');
                } catch (beginErr) {
                    console.error('[Accolades] bulk BEGIN failed:', beginErr.message);
                    return failed(500, 'Could not apply the bulk action.');
                }
                try {
                    for (const row of targets) {
                        if (action === 'delete') {
                            await dbRun('DELETE FROM accolades WHERE id = ?', [row.id]);
                        } else {
                            const col = Object.keys(change)[0];
                            await dbRun(`UPDATE accolades SET ${col} = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
                                [change[col], req.session.adminId, row.id]);
                        }
                    }
                    await dbRun('COMMIT');
                    return { status: 200, body: { success: true, changed: targets.length }, targets };
                } catch (e) {
                    await dbRun('ROLLBACK').catch(() => {});
                    console.error('[Accolades] bulk failed:', e.message);
                    return failed(500, 'Could not apply the bulk action.');
                }
            });
            if (outcome.status === 200) {
                await Promise.all((outcome.targets || []).map(row => logAuditSafe({
                    tableName: 'accolades', recordId: row.id, action: action === 'delete' ? 'delete' : 'update', req,
                    oldValues: auditSnapshot(row), newValues: change ? auditSnapshot(Object.assign({}, row, change)) : null,
                    reason: `Bulk action: ${action}`
                })));
                outcome.body.last_updated = await lastUpdated(req);
            }
            res.status(outcome.status).json(outcome.body);
        } catch (err) {
            console.error('[Accolades] bulk failed:', err.message);
            res.status(500).json({ success: false, message: 'Could not apply the bulk action.' });
        }
    });

// Partial updates are fine: lib/accolades.js validates the record the change would PRODUCE.
router.put('/api/admin/accolades/:id', requireAdmin, async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(404).json({ success: false, message: 'Accolade not found.' });
    try {
        const outcome = await withDbTransaction(async () => {
            const existing = await dbGet('SELECT * FROM accolades WHERE id = ?', [id]);
            if (!existing) return failed(404, 'Accolade not found.');
            const prepared = prepareAccolade(req.body, existing);
            if (prepared.error) return failed(400, prepared.error, { field: prepared.field });
            const v = prepared.values;
            const dup = await findDuplicate(v, id);
            if (dup) return { status: 409, body: duplicateBody(dup) };
            try {
                await dbRun(
                    `UPDATE accolades SET title = ?, category = ?, year = ?, achievement_date = ?, organisation = ?, event_name = ?, result = ?,
                            description = ?, location = ?, image = ?, organisation_logo = ?, certificate_file = ?, external_url = ?, source_url = ?,
                            featured = ?, status = ?, display_order = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP
                     WHERE id = ?`,
                    [v.title, v.category, v.year, v.achievement_date, v.organisation, v.event_name, v.result,
                     v.description, v.location, v.image, v.organisation_logo, v.certificate_file, v.external_url, v.source_url,
                     v.featured, v.status, v.display_order, req.session.adminId, id]);
            } catch (e) {
                if (isUniqueViolation(e)) return { status: 409, body: duplicateBody(await findDuplicate(v, id)) };
                throw e;
            }
            return { status: 200, existing, values: v };
        });
        if (outcome.status !== 200) return res.status(outcome.status).json(outcome.body);
        await logAuditSafe({ tableName: 'accolades', recordId: id, action: 'update', req, oldValues: auditSnapshot(outcome.existing), newValues: auditSnapshot(outcome.values) });
        res.json({ success: true, last_updated: await lastUpdated(req) });
    } catch (err) {
        console.error('[Accolades] update failed:', err.message);
        res.status(500).json({ success: false, message: 'Could not save the accolade.' });
    }
});

// Permanent delete — administrator only, like every other content section. To take an accolade off
// the website without losing it, set it Inactive instead. The full record stays in audit_log.
router.delete('/api/admin/accolades/:id', requireAdmin, requireRole(['administrator']), async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(404).json({ success: false, message: 'Accolade not found.' });
    try {
        const outcome = await withDbTransaction(async () => {
            const existing = await dbGet('SELECT * FROM accolades WHERE id = ?', [id]);
            if (!existing) return failed(404, 'Accolade not found.');
            await dbRun('DELETE FROM accolades WHERE id = ?', [id]);
            return { status: 200, existing };
        });
        if (outcome.status !== 200) return res.status(outcome.status).json(outcome.body);
        await logAuditSafe({ tableName: 'accolades', recordId: id, action: 'delete', req, oldValues: auditSnapshot(outcome.existing), newValues: null });
        res.json({ success: true });
    } catch (err) {
        console.error('[Accolades] delete failed:', err.message);
        res.status(500).json({ success: false, message: 'Could not delete the accolade.' });
    }
});

module.exports = router;
