const express = require('express');
const path = require('path');
const db = require('../../database');
const bannerRegistry = require('../../js/bannerRegistry');
const emailComponents = require('../../js/emailComponents');
const { requireAdmin } = require('../../middleware/auth');
const { requireRoleForInquiryEmail } = require('../../middleware/rbac');
const { emailAttachUpload } = require('../../lib/uploads');
const { PROJECT_ROOT } = require('../../lib/runtime-paths');
const objectStorage = require('../../lib/object-storage');
const { getEmailFooterContext } = require('../../lib/email-context');
const { sanitizeAboutHtml } = require('../../lib/html-sanitize');
const { scheduledJobs } = require('../../lib/newsletter-scheduling');
const { scheduleDirectEmailSend, sendDirectEmail } = require('../../lib/direct-emails');
const { cleanAddressList } = require('../../lib/contact-validation');
const { decodeStoredText } = require('../../lib/html-sanitize');
const router = express.Router();

const dbGet = (sql, params = []) => new Promise((resolve, reject) => db.get(sql, params, (e, r) => e ? reject(e) : resolve(r)));

// Every address that reaches the mail server is validated HERE, whatever the composer sent: each entry must be exactly one mailbox address
// (no lists inside an entry, no display names, no line breaks). For a reply to an inquiry the recipient is not up to the browser at all: it is
// the inquiry's own sender. Returns { to, cc, bcc, replyTo } (plain, decoded) or { error }.
function buildRecipients({ inquiry, to, cc, bcc, replyTo }) {
    const toR = inquiry ? { ok: true, list: [decodeStoredText(inquiry.sender_email)] } : cleanAddressList(to);
    if (!toR.ok) return { error: toR.error };
    if (!toR.list.length) return { error: 'Recipient and body are required.' };
    const ccR = cleanAddressList(cc), bccR = cleanAddressList(bcc);
    if (!ccR.ok) return { error: ccR.error };
    if (!bccR.ok) return { error: bccR.error };
    if (toR.list.length + ccR.list.length + bccR.list.length > 20) return { error: 'Too many recipients (maximum 20).' };
    let rt = null;
    if (replyTo) {
        const r = cleanAddressList([replyTo]);
        if (!r.ok) return { error: 'The Reply-To address is not a valid email address.' };
        rt = r.list[0];
    }
    return { to: toR.list, cc: ccR.list, bcc: bccR.list, replyTo: rt };
}

// Attachment upload for direct emails
router.post('/api/admin/direct-emails/upload', requireAdmin, emailAttachUpload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded' });
    res.json({
        success: true,
        filename: req.file.filename,
        originalName: req.file.originalname,
        size: req.file.size,
        path: `docs/email_attachments/${req.file.filename}`
    });
});

// List drafts and scheduled direct emails
router.get('/api/admin/direct-emails', requireAdmin, (req, res) => {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = 50;
    const offset = (page - 1) * limit;
    const statusFilter = req.query.status === 'scheduled' ? 'scheduled' : 'draft';
    const search = (req.query.search || '').trim();

    const conditions = ["status = ?"];
    const qp = [statusFilter];
    
    if (search) {
        conditions.push("(LOWER(to_emails) LIKE LOWER(?) OR LOWER(subject) LIKE LOWER(?) OR LOWER(body) LIKE LOWER(?))");
        const term = `%${search}%`;
        qp.push(term, term, term);
    }
    
    const whereClause = `WHERE ${conditions.join(' AND ')}`;
    const countSql = `SELECT COUNT(*) AS total FROM direct_emails ${whereClause}`;
    const dataSql  = `SELECT * FROM direct_emails ${whereClause} ORDER BY updated_at DESC LIMIT ? OFFSET ?`;

    db.get(countSql, qp, (err, countRow) => {
        if (err) return res.status(500).json({ error: err.message });
        db.all(dataSql, [...qp, limit, offset], (err2, rows) => {
            if (err2) return res.status(500).json({ error: err2.message });
            const total = countRow ? countRow.total : 0;
            res.json({
                success: true,
                emails: rows || [],
                total,
                page,
                pages: Math.ceil(total / limit)
            });
        });
    });
});

// Get detail of single direct email
router.get('/api/admin/direct-emails/:id', requireAdmin, (req, res) => {
    db.get("SELECT * FROM direct_emails WHERE id = ?", [req.params.id], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: 'Email item not found' });
        res.json({ success: true, email: row });
    });
});

// Create draft or scheduled direct email
router.post('/api/admin/direct-emails', requireAdmin, requireRoleForInquiryEmail, async (req, res) => {
    try {
        const { inquiry_id, to_emails, cc_emails, bcc_emails, reply_to, subject, body: rawBody, branding_option, selected_banner_url, attachment_paths, scheduled_at, status } = req.body;
        // Quill's HTML arrives unescaped (RAW_HTML_BODY_FIELDS in app.js) - strip scripts/handlers instead.
        const body = sanitizeAboutHtml(rawBody);
        if (!body) return res.status(400).json({ error: 'Recipient and body are required.' });

        // A reply must belong to a REAL inquiry (a forged or stale id is refused) and then goes to that inquiry's sender, whatever the request says.
        let inquiry = null;
        if (inquiry_id !== undefined && inquiry_id !== null && inquiry_id !== '') {
            const inquiryId = Number(inquiry_id);
            if (!Number.isInteger(inquiryId) || inquiryId < 1) return res.status(400).json({ error: 'Invalid inquiry.' });
            inquiry = await dbGet('SELECT inquiry_id, sender_email FROM inquiries WHERE inquiry_id = ?', [inquiryId]);
            if (!inquiry) return res.status(404).json({ error: 'That inquiry does not exist.' });
        }
        const rec = buildRecipients({ inquiry, to: to_emails, cc: cc_emails, bcc: bcc_emails, replyTo: reply_to });
        if (rec.error) return res.status(400).json({ error: rec.error });

        const emailStatus = status === 'scheduled' ? 'scheduled' : 'draft';
        const cleanAttachments = attachment_paths ? (typeof attachment_paths === 'string' ? attachment_paths : JSON.stringify(attachment_paths)) : '[]';
        const cleanSubject = String(subject || '').replace(/[\r\n]+/g, ' ').trim();

        db.run(
            `INSERT INTO direct_emails (inquiry_id, to_emails, cc_emails, bcc_emails, reply_to, subject, body, branding_option, selected_banner_url, attachment_paths, scheduled_at, status, created_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [inquiry ? inquiry.inquiry_id : null, JSON.stringify(rec.to), JSON.stringify(rec.cc), JSON.stringify(rec.bcc), rec.replyTo, cleanSubject, body, branding_option || 'logo', selected_banner_url || null, cleanAttachments, scheduled_at || null, emailStatus, req.session.adminId || null],
            function(err) {
                if (err) return res.status(500).json({ error: err.message });
                const newId = this.lastID;

                db.get("SELECT * FROM direct_emails WHERE id = ?", [newId], (err2, row) => {
                    if (err2 || !row) return res.json({ success: true, id: newId });
                    if (row.status === 'scheduled') {
                        scheduleDirectEmailSend(row);
                    }
                    res.json({ success: true, email: row });
                });
            }
        );
    } catch (e) {
        console.error('direct-emails create failed:', e.message);
        res.status(500).json({ error: 'The message could not be saved.' });
    }
});

// Update draft or scheduled direct email
router.put('/api/admin/direct-emails/:id', requireAdmin, requireRoleForInquiryEmail, async (req, res) => {
    try {
        const { to_emails, cc_emails, bcc_emails, reply_to, subject, body: rawBody, branding_option, selected_banner_url, attachment_paths, scheduled_at, status } = req.body;
        const body = sanitizeAboutHtml(rawBody);
        const { id } = req.params;
        if (!body) return res.status(400).json({ error: 'Recipient and body are required.' });

        const existing = await dbGet('SELECT id, inquiry_id, status FROM direct_emails WHERE id = ?', [id]);
        if (!existing) return res.status(404).json({ error: 'Email item not found' });
        // Once handed to the outbox it is history: editing and re-saving it as a draft would let it be sent a second time.
        if (existing.status === 'sent') return res.status(409).json({ error: 'This message has already been sent.' });

        // inquiry_id never changes after creation (it is not read from the request); an inquiry reply keeps going to that inquiry's sender.
        const inquiry = existing.inquiry_id ? await dbGet('SELECT inquiry_id, sender_email FROM inquiries WHERE inquiry_id = ?', [existing.inquiry_id]) : null;
        const rec = buildRecipients({ inquiry, to: to_emails, cc: cc_emails, bcc: bcc_emails, replyTo: reply_to });
        if (rec.error) return res.status(400).json({ error: rec.error });

        const emailStatus = status === 'scheduled' ? 'scheduled' : 'draft';
        const cleanAttachments = attachment_paths ? (typeof attachment_paths === 'string' ? attachment_paths : JSON.stringify(attachment_paths)) : '[]';
        const cleanSubject = String(subject || '').replace(/[\r\n]+/g, ' ').trim();

        // Cancel existing schedule if there is one
        const jobKey = `direct_${id}`;
        if (scheduledJobs[jobKey]) {
            scheduledJobs[jobKey].cancel();
            delete scheduledJobs[jobKey];
        }

        db.run(
            `UPDATE direct_emails
             SET to_emails = ?, cc_emails = ?, bcc_emails = ?, reply_to = ?, subject = ?, body = ?, branding_option = ?, selected_banner_url = ?, attachment_paths = ?, scheduled_at = ?, status = ?, updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [JSON.stringify(rec.to), JSON.stringify(rec.cc), JSON.stringify(rec.bcc), rec.replyTo, cleanSubject, body, branding_option || 'logo', selected_banner_url || null, cleanAttachments, scheduled_at || null, emailStatus, id],
            function(err) {
                if (err) return res.status(500).json({ error: err.message });

                db.get("SELECT * FROM direct_emails WHERE id = ?", [id], (err2, row) => {
                    if (err2 || !row) return res.json({ success: true });
                    if (row.status === 'scheduled') {
                        scheduleDirectEmailSend(row);
                    }
                    res.json({ success: true, email: row });
                });
            }
        );
    } catch (e) {
        console.error('direct-emails update failed:', e.message);
        res.status(500).json({ error: 'The message could not be saved.' });
    }
});

// Delete draft or cancel scheduled email
router.delete('/api/admin/direct-emails/:id', requireAdmin, (req, res) => {
    const { id } = req.params;
    const jobKey = `direct_${id}`;
    if (scheduledJobs[jobKey]) {
        scheduledJobs[jobKey].cancel();
        delete scheduledJobs[jobKey];
    }

    db.get("SELECT attachment_paths FROM direct_emails WHERE id = ?", [id], (err, row) => {
        if (!err && row && row.attachment_paths) {
            try {
                const paths = JSON.parse(row.attachment_paths);
                paths.forEach(p => {
                    if (p && p.path) {
                        const resolvedPath = path.isAbsolute(p.path) ? p.path : path.join(PROJECT_ROOT, p.path);
                        objectStorage.deleteFile(resolvedPath).catch(() => {});
                    }
                });
            } catch(e) {}
        }
        db.run("DELETE FROM direct_emails WHERE id = ?", [id], function(err2) {
            if (err2) return res.status(500).json({ error: err2.message });
            res.json({ success: true });
        });
    });
});

// Send direct email immediately. "Sent" = handed to the outbox: the response says QUEUED, and for an inquiry reply the conversation
// (GET /api/admin/inquiries/:id/messages) shows whether Microsoft 365 then accepted or refused it.
router.post('/api/admin/direct-emails/:id/send', requireAdmin, requireRoleForInquiryEmail, (req, res) => {
    const { id } = req.params;

    // Cancel schedule job if it exists
    const jobKey = `direct_${id}`;
    if (scheduledJobs[jobKey]) {
        scheduledJobs[jobKey].cancel();
        delete scheduledJobs[jobKey];
    }

    db.get('SELECT status FROM direct_emails WHERE id = ?', [id], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: 'Email item not found' });
        if (row.status === 'sent') return res.status(409).json({ error: 'This message has already been sent.' });
        sendDirectEmail(id, { id: req.session.adminId })
            .then(() => res.json({ success: true, queued: true, message: 'Message queued for delivery.' }))
            .catch(e => res.status(/already being sent/i.test(e.message) ? 409 : 500).json({ error: e.message }));
    });
});

// Preview direct email html
// Mirrors sendDirectEmail()'s rendering exactly (registry-resolved banner via renderPremiumEmail) so
// the preview shown here is byte-identical in shape to what actually sends — previously this called
// createEmailWrapper() unconditionally while the real send (gated by the always-off
// EMAIL_OVERHAUL_ENABLED flag) shipped raw HTML, so preview and reality had permanently diverged.
router.post('/api/admin/direct-emails/preview', requireAdmin, async (req, res) => {
    const { body: rawBody, subject, inquiry_id } = req.body;
    const body = sanitizeAboutHtml(rawBody);
    const templateKey = inquiry_id ? 'inquiry_reply' : 'direct_compose';
    const banner = await bannerRegistry.resolveBanner(templateKey);
    const { socialLinks } = await getEmailFooterContext();

    const html = emailComponents.renderPremiumEmail({
        preheaderText: subject || 'A message from Thabiso Mhlongo Management.',
        bannerSrc: banner?.src, bannerAlt: banner?.alt, subtitle: banner?.subtitle,
        headline: banner?.headline || (inquiry_id ? 'Management Response' : 'Direct Message'),
        bodyHtml: body,
        socialLinks
    });
    res.json({ success: true, html });
});

module.exports = router;
