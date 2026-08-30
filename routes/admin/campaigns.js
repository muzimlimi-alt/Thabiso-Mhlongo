const express = require('express');
const fs = require('fs');
const { requireAdmin } = require('../../middleware/auth');
const { requireRole } = require('../../middleware/rbac');
const { newsletterUpload } = require('../../lib/uploads');
const { buildSegmentCondition, scheduledJobs } = require('../../lib/newsletter-scheduling');
const { getEmailFooterContext, emailBaseUrl } = require('../../lib/email-context');
const bannerRegistry = require('../../js/bannerRegistry');
const emailComponents = require('../../js/emailComponents');
const { sendEmail } = require('../../js/emailService');
const { applyMergeFields } = require('../../js/mergeFields');
const {
    getActiveSubscribersForSegment, insertCampaignLog, deleteCampaign,
    countUnifiedCampaigns, listUnifiedCampaigns, bulkDeleteCampaigns,
    getScheduledAttachmentsForIds, bulkDeleteScheduled
} = require('../../database/repositories/newsletter.repository');
const { getAdminEmailById } = require('../../database/repositories/auth-users.repository');
const router = express.Router();

// scheduleNewsletterSend moved to lib/newsletter-scheduling.js (imported near the top of this file).






// ==========================================
// Admin Newsletter Dispatch Route
// ==========================================
router.post('/api/admin/campaigns', requireAdmin, requireRole(['administrator', 'manager']), newsletterUpload.array('attachments', 10), async (req, res) => {
    const { subject, message, segment, segment_value } = req.body;
    const uploadedFiles = req.files || [];

    if (!subject || !message) {
        uploadedFiles.forEach(f => fs.unlink(f.path, () => {}));
        return res.status(400).json({ success: false, message: 'Subject and message are required.' });
    }

    const attachments = uploadedFiles.map(f => ({ filename: f.originalname, path: f.path }));
    const { condition: segCondition, params: segParams } = buildSegmentCondition(segment, segment_value);

    // First fetch the segmented subscriber list
    getActiveSubscribersForSegment(segCondition, segParams, async (err, rows) => {
        if (err) {
            uploadedFiles.forEach(f => fs.unlink(f.path, () => {}));
            return res.status(500).json({ success: false, message: 'Database error fetching subscribers' });
        }

        if (!rows || rows.length === 0) {
            uploadedFiles.forEach(f => fs.unlink(f.path, () => {}));
            return res.status(400).json({ success: false, message: 'No active subscribers match this audience.' });
        }

        let successCount = 0;
        let errors = [];

        console.log(`Starting premium newsletter dispatch to ${rows.length} recipients...`);

        // Campaign content is the admin's own authored HTML — run through the merge-field engine
        // per recipient, then wrapped with the brand shell + a per-recipient unsubscribe link.
        const { socialLinks: campaignSocialLinks } = await getEmailFooterContext();
        const campaignBanner = await bannerRegistry.resolveBanner('newsletter_campaign');
        for (const sub of rows) {
            const recipientEmail = sub.email;
            try {
                const unsubscribeUrl = sub.unsubscribe_token
                    ? `${emailBaseUrl()}/unsubscribe.html?token=${sub.unsubscribe_token}&email=${encodeURIComponent(recipientEmail)}`
                    : null;
                const personalizedSubject = applyMergeFields(subject, sub, unsubscribeUrl);
                const personalizedBody = applyMergeFields(message, sub, unsubscribeUrl);
                const html = emailComponents.renderPremiumEmail({
                    preheaderText: personalizedSubject,
                    bannerSrc: campaignBanner?.src, bannerAlt: campaignBanner?.alt, subtitle: campaignBanner?.subtitle,
                    headline: personalizedSubject,
                    bodyHtml: personalizedBody,
                    unsubscribeUrl,
                    socialLinks: campaignSocialLinks
                });
                const result = await sendEmail({
                    to: recipientEmail,
                    subject: personalizedSubject,
                    htmlContent: html,
                    preWrapped: true,
                    titleOverride: personalizedSubject,
                    attachments,
                    trigger_event: 'Newsletter: Campaign Dispatch'
                });

                if (result.success) {
                    successCount++;
                    if (successCount % 10 === 0) console.log(`Newsletter progress: ${successCount}/${rows.length} sent...`);
                } else {
                    throw result.error || new Error('Dispatch failed');
                }
                // No artificial delay here — sendEmail() only queues into `notifications`; real SMTP
                // pacing is already handled independently by processNotificationQueue()'s own
                // interval/batch-size cadence, so pacing it again here just blocks the request.
            } catch (error) {
                console.error(`ERROR: Failed sending to ${recipientEmail}:`, error.message);
                errors.push({ email: recipientEmail, error: error.message });
            }
        }

        // Log campaign to database then clean up temp attachment files
        insertCampaignLog(subject, message, rows.length, successCount, errors.length, function(err) {
            if (err) console.error("CRITICAL: Error logging campaign to DB:", err);
            uploadedFiles.forEach(f => fs.unlink(f.path, () => {}));

            const finalMessage = `Newsletter dispatch complete. Successfully sent: ${successCount}/${rows.length}. Failures: ${errors.length}.`;
            console.log(`✅ ${finalMessage}`);

            res.json({
                success: true,
                message: finalMessage,
                stats: { total: rows.length, sent: successCount, failed: errors.length },
                failures: errors.slice(0, 50)
            });
        });
    });
});

// Send Test (to self) — fires one real, personalized email of the current (possibly unsaved)
// Compose content to the logged-in admin's own address, same reasoning/pattern as the Birthday
// tab's Send Test (Phase 3): admins can confirm rendering before committing to a real broadcast.
router.post('/api/admin/campaigns/send-test', requireAdmin, requireRole(['administrator', 'manager']), newsletterUpload.none(), async (req, res) => {
    try {
        const { subject, message } = req.body;
        if (!subject || !message) return res.status(400).json({ success: false, message: 'Subject and message are required.' });

        const admin = await getAdminEmailById(req.session.adminId);
        if (!admin || !admin.email) return res.status(400).json({ success: false, message: 'Could not find your admin email address.' });

        const sampleSubscriber = { first_name: 'Alex', email: admin.email, subscribed_at: new Date().toISOString() };
        const unsubscribeUrl = '#';
        const personalizedSubject = applyMergeFields(subject, sampleSubscriber, unsubscribeUrl);
        const personalizedBody = applyMergeFields(message, sampleSubscriber, unsubscribeUrl);
        const { socialLinks } = await getEmailFooterContext();
        const campaignBanner = await bannerRegistry.resolveBanner('newsletter_campaign');
        const html = emailComponents.renderPremiumEmail({
            preheaderText: personalizedSubject,
            bannerSrc: campaignBanner?.src, bannerAlt: campaignBanner?.alt, subtitle: campaignBanner?.subtitle,
            headline: personalizedSubject,
            bodyHtml: personalizedBody,
            unsubscribeUrl,
            socialLinks
        });
        await sendEmail({
            to: admin.email,
            subject: '[TEST] ' + personalizedSubject,
            htmlContent: html,
            preWrapped: true,
            titleOverride: personalizedSubject,
            trigger_event: 'Newsletter: Campaign Test'
        });
        res.json({ success: true, message: 'Test email queued to ' + admin.email + '.' });
    } catch (e) {
        console.error('[Campaign Send Test] Error:', e.message);
        res.status(500).json({ success: false, message: 'Could not send test email: ' + e.message });
    }
});

// --- Subscribers & Campaigns ---
// (Quick Wins) Removed legacy GET /api/admin/subscribers — an unpaginated duplicate of
// GET /api/admin/newsletter/subscribers, which the admin UI actually calls.
// (D11) Removed legacy GET /api/admin/campaigns — superseded by GET /api/admin/campaigns/unified
// (the only campaigns-list route the frontend calls). The POST /api/admin/campaigns send route is unaffected.
router.delete('/api/admin/campaigns/:id', requireAdmin, requireRole(['administrator']), (req, res) => {
    deleteCampaign(req.params.id, function(err) {
        if (err) return res.status(500).json({ success: false, message: err.message });
        if (this.changes === 0) return res.status(404).json({ success: false, message: 'Campaign not found.' });
        res.json({ success: true });
    });
});

router.get('/api/admin/campaigns/unified', requireAdmin, (req, res) => {
    const validStatuses = ['all', 'sent', 'scheduled', 'failed', 'cancelled'];
    const validSorts = ['date_desc', 'date_asc', 'subject_asc'];
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = 10;
    const offset = (page - 1) * limit;
    const statusFilter = validStatuses.includes(req.query.status) ? req.query.status : 'all';
    const sortBy = validSorts.includes(req.query.sort) ? req.query.sort : 'date_desc';
    const search = (req.query.search || '').trim();

    const orderClause = sortBy === 'date_asc' ? 'date ASC' :
                        sortBy === 'subject_asc' ? "LOWER(COALESCE(subject,'')) ASC" :
                        'date DESC';

    const conditions = [];
    const qp = [];
    if (statusFilter !== 'all') { conditions.push("display_status = ?"); qp.push(statusFilter); }
    if (search) { conditions.push("LOWER(COALESCE(subject,'')) LIKE LOWER(?)"); qp.push(`%${search}%`); }
    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const inner = `
        SELECT id, 'campaign' AS source, subject, content, 'sent' AS display_status, sent_at AS date
        FROM newsletter_campaigns
        UNION ALL
        SELECT id, 'schedule' AS source, subject, content,
            CASE WHEN status = 'pending' THEN 'scheduled'
                 WHEN status = 'sending' THEN 'scheduled'
                 WHEN status LIKE 'sent%' THEN 'sent'
                 WHEN status = 'cancelled' THEN 'cancelled'
                 ELSE 'failed' END AS display_status,
            COALESCE(scheduled_at, created_at) AS date
        FROM scheduled_newsletters`;

    countUnifiedCampaigns(inner, whereClause, qp, (err, countRow) => {
        if (err) return res.status(500).json({ success: false, message: err.message });
        listUnifiedCampaigns(inner, whereClause, orderClause, [...qp, limit, offset], (err2, rows) => {
            if (err2) return res.status(500).json({ success: false, message: err2.message });
            const total = countRow.total;
            res.json({ success: true, campaigns: rows, total, page, pages: Math.ceil(total / limit) });
        });
    });
});

router.post('/api/admin/campaigns/bulk-delete', requireAdmin, requireRole(['administrator']), (req, res) => {
    const { items } = req.body;
    if (!Array.isArray(items) || !items.length) {
        return res.status(400).json({ success: false, message: 'No items specified.' });
    }
    const campaignIds = items.filter(x => x.source === 'campaign' && x.id).map(x => parseInt(x.id));
    const scheduleIds = items.filter(x => x.source === 'schedule' && x.id).map(x => parseInt(x.id));

    scheduleIds.forEach(id => {
        if (scheduledJobs[id]) { scheduledJobs[id].cancel(); delete scheduledJobs[id]; }
    });

    let pending = 0;
    const done = () => { if (--pending === 0) res.json({ success: true }); };
    const fail = (err) => { if (!res.headersSent) res.status(500).json({ success: false, message: err.message }); };

    if (campaignIds.length) {
        pending++;
        const ph = campaignIds.map(() => '?').join(',');
        bulkDeleteCampaigns(ph, campaignIds, err => { if (err) return fail(err); done(); });
    }
    if (scheduleIds.length) {
        pending++;
        const ph = scheduleIds.map(() => '?').join(',');
        getScheduledAttachmentsForIds(ph, scheduleIds, (err, rows) => {
            if (!err && rows) {
                rows.forEach(r => {
                    if (r.attachment_paths) {
                        try { JSON.parse(r.attachment_paths).forEach(a => fs.unlink(a.path, () => {})); } catch(e) {}
                    }
                });
            }
            bulkDeleteScheduled(ph, scheduleIds, err2 => { if (err2) return fail(err2); done(); });
        });
    }
    if (pending === 0) res.json({ success: true });
});

module.exports = router;
