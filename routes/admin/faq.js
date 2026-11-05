// FAQ admin CRUD - same shape as routes/admin/accolades.js: requireAdmin on reads and edits (content any admin role may keep), administrator-only
// delete, logAudit + resolveActor for the audit trail and the "Last updated by" footer. Every rule about what a valid question is lives in
// lib/faq.js; this file only sequences the writes. Re-ordering rewrites a category's positions in one transaction, so two quick clicks cannot
// leave two questions on the same position.
const express = require('express');
const { requireAdmin } = require('../../middleware/auth');
const { requireRole } = require('../../middleware/rbac');
const { dbRun, dbGet, dbAll } = require('../../lib/db-helpers');
const { withDbTransaction } = require('../../lib/db-transaction');
const { logAudit } = require('../../lib/audit-log');
const { resolveActor } = require('../../lib/actor');
const faq = require('../../lib/faq');
const router = express.Router();

const logAuditSafe = (entry) => logAudit(entry).catch((e) => console.error('logAudit failed:', e));
const parseId = (raw) => { const n = Number(raw); return Number.isInteger(n) && n > 0 ? n : null; };
async function lastUpdated(req) {
    const actor = await resolveActor(req.session.adminId);
    return { name: actor.name, role: actor.role, at: new Date().toISOString() };
}
const fail = (res, e, what) => { console.error(`faq ${what} failed:`, e && e.message); res.status(500).json({ success: false, message: 'The FAQ could not be saved. Please try again.' }); };
const invalid = (res, errors) => res.status(400).json({ success: false, errors, message: Object.values(errors)[0] });

router.get('/api/admin/faqs', requireAdmin, async (req, res) => {
    try { res.json({ success: true, ...(await faq.getAdminFaqView()) }); }
    catch (e) { fail(res, e, 'list'); }
});

router.post('/api/admin/faqs', requireAdmin, async (req, res) => {
    try {
        const { clean, errors } = faq.prepareFaq(req.body || {});
        if (Object.keys(errors).length) return invalid(res, errors);
        if (await faq.findDuplicate(clean.question)) return invalid(res, { question: 'That question is already in the FAQ.' });
        if (!req.body || req.body.display_order === undefined) clean.display_order = await faq.nextOrder(clean.category);
        const r = await dbRun(`INSERT INTO faqs (question, answer, category, display_order, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [clean.question, clean.answer, clean.category, clean.display_order, clean.status, req.session.adminId, new Date().toISOString()]);
        await logAuditSafe({ tableName: 'faqs', recordId: r.lastID, action: 'create', req, newValues: faq.auditSnapshot(clean) });
        res.json({ success: true, id: r.lastID, last_updated: await lastUpdated(req), ...(await faq.getAdminFaqView()) });
    } catch (e) {
        if (/UNIQUE/.test(e.message)) return invalid(res, { question: 'That question is already in the FAQ.' });
        fail(res, e, 'create');
    }
});

router.put('/api/admin/faqs/:id', requireAdmin, async (req, res) => {
    try {
        const id = parseId(req.params.id);
        const before = id ? await dbGet('SELECT * FROM faqs WHERE id = ?', [id]) : null;
        if (!before) return res.status(404).json({ success: false, message: 'That question was not found. It may have been deleted.' });
        const { clean, errors } = faq.prepareFaq(req.body || {}, before);
        if (Object.keys(errors).length) return invalid(res, errors);
        if (await faq.findDuplicate(clean.question, id)) return invalid(res, { question: 'That question is already in the FAQ.' });
        // moving to another category puts it at the end of that group
        if (clean.category !== before.category && (!req.body || req.body.display_order === undefined)) clean.display_order = await faq.nextOrder(clean.category);
        await dbRun(`UPDATE faqs SET question = ?, answer = ?, category = ?, display_order = ?, status = ?, updated_by = ?, updated_at = ? WHERE id = ?`,
            [clean.question, clean.answer, clean.category, clean.display_order, clean.status, req.session.adminId, new Date().toISOString(), id]);
        await logAuditSafe({ tableName: 'faqs', recordId: id, action: 'update', req, oldValues: faq.auditSnapshot(before), newValues: faq.auditSnapshot(clean) });
        res.json({ success: true, last_updated: await lastUpdated(req), ...(await faq.getAdminFaqView()) });
    } catch (e) {
        if (/UNIQUE/.test(e.message)) return invalid(res, { question: 'That question is already in the FAQ.' });
        fail(res, e, 'update');
    }
});

// Move one place up or down within its category (the website lists categories in a fixed order, then this order).
router.post('/api/admin/faqs/:id/move', requireAdmin, async (req, res) => {
    try {
        const id = parseId(req.params.id);
        const dir = req.body && req.body.direction;
        if (!id || (dir !== 'up' && dir !== 'down')) return res.status(400).json({ success: false, message: 'Say which question to move, up or down.' });
        const outcome = await withDbTransaction(async () => {
            const row = await dbGet('SELECT id, category FROM faqs WHERE id = ?', [id]);
            if (!row) return { status: 404 };
            const list = await dbAll('SELECT id FROM faqs WHERE category = ? ORDER BY display_order ASC, id ASC', [row.category]);
            const i = list.findIndex((r) => r.id === id);
            const j = dir === 'up' ? i - 1 : i + 1;
            if (j < 0 || j >= list.length) return { status: 200, moved: false };
            [list[i], list[j]] = [list[j], list[i]];
            await dbRun('BEGIN IMMEDIATE');
            try {
                for (let k = 0; k < list.length; k++) await dbRun('UPDATE faqs SET display_order = ? WHERE id = ?', [k + 1, list[k].id]);
                await dbRun('COMMIT');
            } catch (e) { await dbRun('ROLLBACK').catch(() => {}); throw e; }
            return { status: 200, moved: true, category: row.category };
        });
        if (outcome.status === 404) return res.status(404).json({ success: false, message: 'That question was not found.' });
        if (outcome.moved) await logAuditSafe({ tableName: 'faqs', recordId: id, action: 'reorder', req, newValues: { direction: dir } });
        res.json({ success: true, moved: !!outcome.moved, ...(await faq.getAdminFaqView()) });
    } catch (e) { fail(res, e, 'move'); }
});

router.delete('/api/admin/faqs/:id', requireAdmin, requireRole(['administrator']), async (req, res) => {
    try {
        const id = parseId(req.params.id);
        const before = id ? await dbGet('SELECT * FROM faqs WHERE id = ?', [id]) : null;
        if (!before) return res.status(404).json({ success: false, message: 'That question was not found.' });
        await dbRun('DELETE FROM faqs WHERE id = ?', [id]);
        await logAuditSafe({ tableName: 'faqs', recordId: id, action: 'delete', req, oldValues: faq.auditSnapshot(before) });
        res.json({ success: true, ...(await faq.getAdminFaqView()) });
    } catch (e) { fail(res, e, 'delete'); }
});

module.exports = router;
