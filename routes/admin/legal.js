const express = require('express');
const db = require('../../database');
const { requireAdmin } = require('../../middleware/auth');
const { requireRole } = require('../../middleware/rbac');
const router = express.Router();

// Next version number for a document: max numeric base + 0.1, with optional "-draft" suffix.
function computeNextLegalVersion(rows, isDraft) {
    let maxBase = 1.0;
    (rows || []).forEach(r => {
        const base = parseFloat(String(r.version_number).replace('-draft', ''));
        if (!isNaN(base) && base > maxBase) maxBase = base;
    });
    const s = ((Math.round(maxBase * 10) + 1) / 10).toFixed(1);
    return isDraft ? s + '-draft' : s;
}

// Route 1 — Overview stats + recent activity
router.get('/api/admin/legal/overview', requireAdmin, (req, res) => {
    const stats = {};
    db.get("SELECT COUNT(*) AS c FROM legal_documents WHERE status='published'", [], (e1, r1) => {
        stats.active_documents = r1 ? r1.c : 0;
        db.get("SELECT COUNT(*) AS c FROM legal_document_versions WHERE is_published=1", [], (e2, r2) => {
            stats.published_versions = r2 ? r2.c : 0;
            db.get("SELECT COUNT(*) AS c FROM consent_audit", [], (e3, r3) => {
                stats.total_consent_records = r3 ? r3.c : 0;
                db.get("SELECT COUNT(*) AS c FROM contracts WHERE status='signed'", [], (e4, r4) => {
                    stats.signed_contracts = r4 ? r4.c : 0;
                    db.get("SELECT COUNT(*) AS c FROM contracts WHERE status='draft'", [], (e5, r5) => {
                        stats.draft_contracts = r5 ? r5.c : 0;
                        db.all(`SELECT lv.id, lv.version_number, lv.change_summary, lv.is_published, lv.created_at, lv.published_by,
                                       ld.document_type, ld.title
                                FROM legal_document_versions lv
                                JOIN legal_documents ld ON ld.id = lv.document_id
                                ORDER BY lv.created_at DESC, lv.id DESC LIMIT 5`, [], (e6, recent) => {
                            res.json({ success: true, stats, recent_activity: recent || [] });
                        });
                    });
                });
            });
        });
    });
});

// Route 2 — All documents with current-version metadata
router.get('/api/admin/legal/documents', requireAdmin, (req, res) => {
    db.all(`SELECT ld.*, lv.version_number, lv.content_html, lv.published_at, lv.published_by, lv.change_summary
            FROM legal_documents ld
            LEFT JOIN legal_document_versions lv ON lv.id = ld.current_version_id
            ORDER BY ld.document_type`, [], (err, docs) => {
        if (err) return res.status(500).json({ success: false, message: err.message });
        res.json({ success: true, documents: docs || [] });
    });
});

// Route 9 — Full version history for one document type (registered before :type so the 3-segment path is explicit)
router.get('/api/admin/legal/documents/:type/history', requireAdmin, (req, res) => {
    db.get("SELECT id FROM legal_documents WHERE document_type = ?", [req.params.type], (err, doc) => {
        if (err) return res.status(500).json({ success: false, message: err.message });
        if (!doc) return res.status(404).json({ success: false, message: 'Unknown document type' });
        db.all("SELECT * FROM legal_document_versions WHERE document_id = ? ORDER BY created_at DESC, id DESC", [doc.id], (e2, versions) => {
            if (e2) return res.status(500).json({ success: false, message: e2.message });
            res.json({ success: true, document_type: req.params.type, versions: versions || [] });
        });
    });
});

// Route 4 — Save a new draft version (write)
router.post('/api/admin/legal/documents/:type/draft', requireAdmin, requireRole(['administrator']), (req, res) => {
    const type = req.params.type;
    let content = (req.body.content_html || '').toString();
    if (!content.trim()) return res.status(400).json({ success: false, message: 'Content cannot be empty.' });
    if (content.length > 500000) content = content.substring(0, 500000);
    const summary = ((req.body.change_summary || '').toString().substring(0, 500)) || null;
    db.get("SELECT id FROM legal_documents WHERE document_type = ?", [type], (err, doc) => {
        if (err) return res.status(500).json({ success: false, message: err.message });
        if (!doc) return res.status(400).json({ success: false, message: 'Unknown document type' });
        db.all("SELECT version_number FROM legal_document_versions WHERE document_id = ?", [doc.id], (e2, rows) => {
            const nextVer = computeNextLegalVersion(rows, true);
            db.run(`INSERT INTO legal_document_versions (document_id, version_number, content_html, change_summary, is_published)
                    VALUES (?,?,?,?,0)`, [doc.id, nextVer, content, summary], function (e3) {
                if (e3) return res.status(500).json({ success: false, message: e3.message });
                db.run("UPDATE legal_documents SET status='draft', updated_at=CURRENT_TIMESTAMP WHERE id=?", [doc.id]);
                res.json({ success: true, version: { id: this.lastID, version_number: nextVer } });
            });
        });
    });
});

// Route 5 — Publish a draft (latest, or a specific version_id) (write)
router.post('/api/admin/legal/documents/:type/publish', requireAdmin, requireRole(['administrator']), (req, res) => {
    const type = req.params.type;
    const by = req.session.username || 'admin';
    db.get("SELECT id FROM legal_documents WHERE document_type = ?", [type], (err, doc) => {
        if (err) return res.status(500).json({ success: false, message: err.message });
        if (!doc) return res.status(400).json({ success: false, message: 'Unknown document type' });
        const publishVersion = (versionId) => {
            db.get("SELECT * FROM legal_document_versions WHERE id = ? AND document_id = ?", [versionId, doc.id], (e2, ver) => {
                if (e2) return res.status(500).json({ success: false, message: e2.message });
                if (!ver) return res.status(404).json({ success: false, message: 'Version not found for this document.' });
                const cleanNum = String(ver.version_number).replace('-draft', '');
                db.run("UPDATE legal_document_versions SET is_published=1, version_number=?, published_at=CURRENT_TIMESTAMP, published_by=? WHERE id=?",
                    [cleanNum, by, ver.id], (e3) => {
                        if (e3) return res.status(500).json({ success: false, message: e3.message });
                        db.run(`UPDATE legal_documents SET status='published', current_version_id=?, last_published_at=CURRENT_TIMESTAMP,
                                last_published_by=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`, [ver.id, by, doc.id], () => {
                            res.json({ success: true, message: 'Document published.', version_number: cleanNum, published_at: new Date().toISOString() });
                        });
                    });
            });
        };
        if (req.body.version_id) {
            publishVersion(parseInt(req.body.version_id));
        } else {
            db.get("SELECT id FROM legal_document_versions WHERE document_id = ? ORDER BY created_at DESC, id DESC LIMIT 1", [doc.id], (e4, latest) => {
                if (e4) return res.status(500).json({ success: false, message: e4.message });
                if (!latest) return res.status(400).json({ success: false, message: 'No version to publish.' });
                publishVersion(latest.id);
            });
        }
    });
});

// Route 6 — Restore a previous version as a new draft (write)
router.post('/api/admin/legal/documents/:type/restore/:versionId', requireAdmin, requireRole(['administrator']), (req, res) => {
    const type = req.params.type;
    db.get("SELECT id FROM legal_documents WHERE document_type = ?", [type], (err, doc) => {
        if (err) return res.status(500).json({ success: false, message: err.message });
        if (!doc) return res.status(400).json({ success: false, message: 'Unknown document type' });
        db.get("SELECT * FROM legal_document_versions WHERE id = ? AND document_id = ?", [req.params.versionId, doc.id], (e2, old) => {
            if (e2) return res.status(500).json({ success: false, message: e2.message });
            if (!old) return res.status(404).json({ success: false, message: 'Version not found.' });
            db.all("SELECT version_number FROM legal_document_versions WHERE document_id = ?", [doc.id], (e3, rows) => {
                const nextVer = computeNextLegalVersion(rows, true);
                db.run(`INSERT INTO legal_document_versions (document_id, version_number, content_html, change_summary, is_published)
                        VALUES (?,?,?,?,0)`, [doc.id, nextVer, old.content_html, 'Restored from version ' + old.version_number], function (e4) {
                    if (e4) return res.status(500).json({ success: false, message: e4.message });
                    db.run("UPDATE legal_documents SET status='draft', updated_at=CURRENT_TIMESTAMP WHERE id=?", [doc.id]);
                    res.json({ success: true, message: 'Restored as new draft.', new_version_id: this.lastID });
                });
            });
        });
    });
});

// Route 3 — Single document + current content + all versions
router.get('/api/admin/legal/documents/:type', requireAdmin, (req, res) => {
    db.get("SELECT * FROM legal_documents WHERE document_type = ?", [req.params.type], (err, doc) => {
        if (err) return res.status(500).json({ success: false, message: err.message });
        if (!doc) return res.status(404).json({ success: false, message: 'Unknown document type' });
        db.all("SELECT * FROM legal_document_versions WHERE document_id = ? ORDER BY created_at DESC, id DESC", [doc.id], (e2, versions) => {
            if (e2) return res.status(500).json({ success: false, message: e2.message });
            const current = (versions || []).find(v => v.id === doc.current_version_id) || null;
            res.json({ success: true, document: Object.assign({}, doc, {
                versions: versions || [],
                current_content_html: current ? current.content_html : '',
                current_version_number: current ? current.version_number : null
            }) });
        });
    });
});

// Route 7 — Consent audit (paginated, joined with booking name/email)
router.get('/api/admin/legal/consent-audit', requireAdmin, (req, res) => {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    // Cap at 10000 so the "Export CSV" path (limit=10000) returns the full set; the UI page-size
    // select only offers 20/50, so normal paged reads stay naturally bounded.
    const limit = Math.min(10000, Math.max(1, parseInt(req.query.limit) || 20));
    const search = (req.query.search || '').trim().substring(0, 100);
    const type = req.query.type || 'all';
    const offset = (page - 1) * limit;
    const conds = [], qp = [];
    if (type !== 'all') { conds.push("ca.consent_type = ?"); qp.push(type); }
    if (search) { const t = '%' + search + '%'; conds.push("(b.name LIKE ? OR b.email LIKE ? OR ca.ip_address LIKE ? OR ca.source_email LIKE ?)"); qp.push(t, t, t, t); }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    db.get(`SELECT COUNT(*) AS total FROM consent_audit ca LEFT JOIN bookings b ON b.id = ca.booking_id ${where}`, qp, (e1, cnt) => {
        if (e1) return res.status(500).json({ success: false, message: e1.message });
        db.all(`SELECT ca.id, ca.booking_id, ca.ip_address, ca.consented_at, ca.consent_type, ca.policy_version, ca.source_email, ca.consent_source,
                       b.name AS booking_name, b.email AS booking_email
                FROM consent_audit ca LEFT JOIN bookings b ON b.id = ca.booking_id
                ${where} ORDER BY ca.consented_at DESC, ca.id DESC LIMIT ? OFFSET ?`, [...qp, limit, offset], (e2, records) => {
            if (e2) return res.status(500).json({ success: false, message: e2.message });
            const total = cnt.total;
            res.json({ success: true, records: records || [], total, page, limit, pages: Math.ceil(total / limit) });
        });
    });
});

// Route 8 — Contract registry (all contracts joined with booking)
router.get('/api/admin/legal/contracts', requireAdmin, (req, res) => {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, parseInt(req.query.limit) || 20);
    const status = req.query.status || 'all';
    const search = (req.query.search || '').trim().substring(0, 100);
    const offset = (page - 1) * limit;
    const conds = [], qp = [];
    if (status !== 'all') { conds.push("c.status = ?"); qp.push(status); }
    if (search) { const t = '%' + search + '%'; conds.push("(b.name LIKE ? OR b.email LIKE ? OR b.event_name LIKE ?)"); qp.push(t, t, t); }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    db.get(`SELECT COUNT(*) AS total FROM contracts c LEFT JOIN bookings b ON b.id = c.booking_id ${where}`, qp, (e1, cnt) => {
        if (e1) return res.status(500).json({ success: false, message: e1.message });
        db.all(`SELECT c.id, c.booking_id, c.template_version, c.status, c.is_frozen, c.pdf_url, c.uploaded_by, c.signed_by, c.signed_date,
                       c.sent_to_client_at, c.signed_by_client_at, c.created_at, c.updated_at,
                       b.name AS client_name, b.email AS client_email, b.event_name, b.date AS event_date,
                       b.status AS booking_status, b.payment_status AS booking_payment_status
                FROM contracts c LEFT JOIN bookings b ON b.id = c.booking_id
                ${where} ORDER BY c.updated_at DESC, c.id DESC LIMIT ? OFFSET ?`, [...qp, limit, offset], (e2, contracts) => {
            if (e2) return res.status(500).json({ success: false, message: e2.message });
            const total = cnt.total;
            res.json({ success: true, contracts: contracts || [], total, page, limit, pages: Math.ceil(total / limit) });
        });
    });
});

module.exports = router;
