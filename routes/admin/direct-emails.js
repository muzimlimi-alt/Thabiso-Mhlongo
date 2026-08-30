const express = require('express');
const fs = require('fs');
const db = require('../../database');
const bannerRegistry = require('../../js/bannerRegistry');
const emailComponents = require('../../js/emailComponents');
const { requireAdmin } = require('../../middleware/auth');
const { requireRoleForInquiryEmail } = require('../../middleware/rbac');
const { emailAttachUpload } = require('../../lib/uploads');
const { getEmailFooterContext } = require('../../lib/email-context');
const { scheduledJobs } = require('../../lib/newsletter-scheduling');
const { scheduleDirectEmailSend, sendDirectEmail } = require('../../lib/direct-emails');
const router = express.Router();

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
router.post('/api/admin/direct-emails', requireAdmin, requireRoleForInquiryEmail, (req, res) => {
    const { inquiry_id, to_emails, cc_emails, bcc_emails, reply_to, subject, body, branding_option, selected_banner_url, attachment_paths, scheduled_at, status } = req.body;
    
    if (!to_emails || !body) {
        return res.status(400).json({ error: 'Recipient and body are required.' });
    }

    const emailStatus = status === 'scheduled' ? 'scheduled' : 'draft';
    const cleanTo = Array.isArray(to_emails) ? JSON.stringify(to_emails) : JSON.stringify([to_emails]);
    const cleanCc = cc_emails ? (Array.isArray(cc_emails) ? JSON.stringify(cc_emails) : JSON.stringify([cc_emails])) : '[]';
    const cleanBcc = bcc_emails ? (Array.isArray(bcc_emails) ? JSON.stringify(bcc_emails) : JSON.stringify([bcc_emails])) : '[]';
    const cleanAttachments = attachment_paths ? (typeof attachment_paths === 'string' ? attachment_paths : JSON.stringify(attachment_paths)) : '[]';

    db.run(
        `INSERT INTO direct_emails (inquiry_id, to_emails, cc_emails, bcc_emails, reply_to, subject, body, branding_option, selected_banner_url, attachment_paths, scheduled_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [inquiry_id || null, cleanTo, cleanCc, cleanBcc, reply_to || null, subject || '', body, branding_option || 'logo', selected_banner_url || null, cleanAttachments, scheduled_at || null, emailStatus],
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
});

// Update draft or scheduled direct email
router.put('/api/admin/direct-emails/:id', requireAdmin, requireRoleForInquiryEmail, (req, res) => {
    const { to_emails, cc_emails, bcc_emails, reply_to, subject, body, branding_option, selected_banner_url, attachment_paths, scheduled_at, status } = req.body;
    const { id } = req.params;

    if (!to_emails || !body) {
        return res.status(400).json({ error: 'Recipient and body are required.' });
    }

    const emailStatus = status === 'scheduled' ? 'scheduled' : 'draft';
    const cleanTo = Array.isArray(to_emails) ? JSON.stringify(to_emails) : JSON.stringify([to_emails]);
    const cleanCc = cc_emails ? (Array.isArray(cc_emails) ? JSON.stringify(cc_emails) : JSON.stringify([cc_emails])) : '[]';
    const cleanBcc = bcc_emails ? (Array.isArray(bcc_emails) ? JSON.stringify(bcc_emails) : JSON.stringify([bcc_emails])) : '[]';
    const cleanAttachments = attachment_paths ? (typeof attachment_paths === 'string' ? attachment_paths : JSON.stringify(attachment_paths)) : '[]';

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
        [cleanTo, cleanCc, cleanBcc, reply_to || null, subject || '', body, branding_option || 'logo', selected_banner_url || null, cleanAttachments, scheduled_at || null, emailStatus, id],
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
                    if (p && p.path && fs.existsSync(p.path)) {
                        fs.unlink(p.path, () => {});
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

// Send direct email immediately
router.post('/api/admin/direct-emails/:id/send', requireAdmin, requireRoleForInquiryEmail, (req, res) => {
    const { id } = req.params;
    
    // Cancel schedule job if it exists
    const jobKey = `direct_${id}`;
    if (scheduledJobs[jobKey]) {
        scheduledJobs[jobKey].cancel();
        delete scheduledJobs[jobKey];
    }

    sendDirectEmail(id)
        .then(() => res.json({ success: true, message: 'Message sending initiated.' }))
        .catch(e => res.status(500).json({ error: e.message }));
});

// Preview direct email html
// Mirrors sendDirectEmail()'s rendering exactly (registry-resolved banner via renderPremiumEmail) so
// the preview shown here is byte-identical in shape to what actually sends — previously this called
// createEmailWrapper() unconditionally while the real send (gated by the always-off
// EMAIL_OVERHAUL_ENABLED flag) shipped raw HTML, so preview and reality had permanently diverged.
router.post('/api/admin/direct-emails/preview', requireAdmin, async (req, res) => {
    const { body, subject, inquiry_id } = req.body;
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
