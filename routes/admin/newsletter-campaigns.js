const express = require('express');
const fs = require('fs');
const moment = require('moment-timezone');
const bannerRegistry = require('../../js/bannerRegistry');
const emailComponents = require('../../js/emailComponents');
const { sendEmail } = require('../../js/emailService');
const { applyMergeFields } = require('../../js/mergeFields');
const { requireAdmin } = require('../../middleware/auth');
const { requireRole } = require('../../middleware/rbac');
const { newsletterUpload } = require('../../lib/uploads');
const { getEmailFooterContext, emailBaseUrl } = require('../../lib/email-context');
const { scheduledJobs, buildSegmentCondition, scheduleNewsletterSend } = require('../../lib/newsletter-scheduling');
const { sanitizeEmailInput, EMAIL_FORMAT_RE } = require('../../lib/validation');
const { sanitizeAboutHtml } = require('../../lib/html-sanitize');
const {
    BIRTHDAY_SETTING_KEYS, BIRTHDAY_SETTING_DEFAULTS, mergeBirthdayOverrides, getBirthdaySettings, renderBirthdayEmail,
    registerBirthdayJob,
} = require('../../lib/newsletter-birthday');
const {
    insertDraft, updateDraft, listDrafts, getDraft, deleteDraft,
    insertScheduledNewsletter, getScheduledNewsletterById, listScheduledNewsletters,
    getScheduledNewsletterAttachmentsIfPending, cancelScheduledNewsletter, updateScheduledNewsletter,
    getAudienceCount, getSubscriberBirthdayFields,
} = require('../../database/repositories/newsletter.repository');
const { getSettingsByKeys, upsertSettingWithConflictClause } = require('../../database/repositories/settings.repository');
const router = express.Router();

// --- Newsletter Drafts ---

// Save Draft
router.post('/api/admin/newsletter/drafts', requireAdmin, requireRole(['administrator', 'manager']), newsletterUpload.none(), (req, res) => {
    const { subject, content } = req.body;
    insertDraft(subject, content, function(err) {
        if (err) {
            return res.status(500).json({ success: false, message: err.message });
        }
        res.json({ success: true, id: this.lastID });
    });
});

// Update Draft
router.put('/api/admin/newsletter/drafts/:id', requireAdmin, requireRole(['administrator', 'manager']), newsletterUpload.none(), (req, res) => {
    const { subject, content } = req.body;
    const { id } = req.params;
    updateDraft(subject, content, id, function(err) {
        if (err) {
            return res.status(500).json({ success: false, message: err.message });
        }
        res.json({ success: true });
    });
});

// Get All Drafts
router.get('/api/admin/newsletter/drafts', requireAdmin, (req, res) => {
    listDrafts((err, rows) => {
        if (err) {
            return res.status(500).json({ success: false, message: err.message });
        }
        res.json(rows);
    });
});

// Get Single Draft
router.get('/api/admin/newsletter/drafts/:id', requireAdmin, (req, res) => {
    const { id } = req.params;
    getDraft(id, (err, row) => {
        if (err) {
            return res.status(500).json({ success: false, message: err.message });
        }
        res.json(row);
    });
});

// Delete Draft
router.delete('/api/admin/newsletter/drafts/:id', requireAdmin, requireRole(['administrator', 'manager']), (req, res) => {
    const { id } = req.params;
    deleteDraft(id, function(err) {
        if (err) {
            return res.status(500).json({ success: false, message: err.message });
        }
        res.json({ success: true });
    });
});

// Newsletter Preview — renders through the exact same path a real send uses
// (emailComponents.renderPremiumEmail + the resolved newsletter_campaign banner), so what an
// admin previews is what subscribers actually get. Previously used the older emailTemplates
// wrapper, which had drifted from the real send rendering.
router.post('/api/admin/newsletter/preview', requireAdmin, newsletterUpload.none(), async (req, res) => {
    try {
        const { subject, content } = req.body;
        if (!content) return res.status(400).json({ success: false, message: 'Content is required.' });

        const sampleSubscriber = {
            first_name: 'Alex', email: 'alex@example.com',
            subscribed_at: new Date().toISOString(),
            birthday_day: new Date().getDate(), birthday_month: new Date().getMonth() + 1
        };
        const previewSubject = applyMergeFields(subject || 'Newsletter Preview', sampleSubscriber, '#');
        const previewBody = applyMergeFields(content, sampleSubscriber, '#');

        const { socialLinks } = await getEmailFooterContext();
        // Preview always renders the banner against the requesting host, not emailBaseUrl()'s
        // production fallback — a banner uploaded on dev/staging otherwise 404s in the preview.
        const previewBaseUrl = `${req.protocol}://${req.get('host')}`;
        const banner = await bannerRegistry.resolveBanner('newsletter_campaign', { baseUrlOverride: previewBaseUrl });
        const html = emailComponents.renderPremiumEmail({
            preheaderText: previewSubject,
            bannerSrc: banner?.src, bannerAlt: banner?.alt, subtitle: banner?.subtitle,
            headline: previewSubject,
            bodyHtml: previewBody,
            unsubscribeUrl: '#',
            socialLinks
        });
        res.json({ success: true, html });
    } catch(e) {
        console.error('[Preview] Error generating preview:', e.message);
        res.status(500).json({ success: false, message: 'Could not generate preview: ' + e.message });
    }
});

// Create Scheduled Newsletter
router.post('/api/admin/newsletter/schedule', requireAdmin, requireRole(['administrator', 'manager']), newsletterUpload.array('attachments', 10), (req, res) => {
    const { subject, content, scheduled_at, segment, segment_value } = req.body;
    if (!content) return res.status(400).json({ success: false, message: 'Content is required.' });
    if (!scheduled_at) return res.status(400).json({ success: false, message: 'scheduled_at is required.' });
    const fireDate = new Date(scheduled_at);
    if (isNaN(fireDate.getTime()) || fireDate <= new Date()) {
        return res.status(400).json({ success: false, message: 'scheduled_at must be a valid future date and time.' });
    }
    const attachmentPaths = JSON.stringify((req.files || []).map(f => ({ filename: f.originalname, path: f.path })));
    insertScheduledNewsletter(subject, content, scheduled_at, attachmentPaths, segment || null, segment_value || null, function(err) {
        if (err) {
            return res.status(500).json({ success: false, message: err.message });
        }
        const newId = this.lastID;
        getScheduledNewsletterById(newId, (err, row) => {
            if (!err && row) {
                scheduleNewsletterSend(row);
            }
        });
        res.json({ success: true, id: newId });
    });
});

// Get All Scheduled Newsletters
router.get('/api/admin/newsletter/schedule', requireAdmin, (req, res) => {
    listScheduledNewsletters((err, rows) => {
        if (err) {
            return res.status(500).json({ success: false, message: err.message });
        }
        res.json(rows);
    });
});

// Cancel Scheduled Newsletter
router.delete('/api/admin/newsletter/schedule/:id', requireAdmin, requireRole(['administrator', 'manager']), (req, res) => {
    const { id } = req.params;
    // Fetch attachment paths before cancelling so we can clean up files
    getScheduledNewsletterAttachmentsIfPending(id, (fetchErr, row) => {
        cancelScheduledNewsletter(id, function(err) {
            if (err) return res.status(500).json({ success: false, message: err.message });
            if (this.changes === 0) {
                return res.status(400).json({ success: false, message: 'Newsletter is not pending and cannot be cancelled.' });
            }
            if (scheduledJobs[id]) {
                scheduledJobs[id].cancel();
                delete scheduledJobs[id];
            }
            if (!fetchErr && row && row.attachment_paths) {
                try { JSON.parse(row.attachment_paths).forEach(a => fs.unlink(a.path, () => {})); } catch(e) {}
            }
            res.json({ success: true });
        });
    });
});

// Update Scheduled Newsletter
router.put('/api/admin/newsletter/schedule/:id', requireAdmin, requireRole(['administrator', 'manager']), newsletterUpload.array('attachments', 10), (req, res) => {
    const { subject, content, scheduled_at, segment, segment_value } = req.body;
    const { id } = req.params;
    const newFiles = req.files || [];

    // Same validation as POST — an edit that silently sets an invalid/past date would otherwise
    // create a row that can never fire (the same "orphaned pending row" bug, reachable via the
    // ordinary edit UI rather than just a server restart).
    if (!scheduled_at) return res.status(400).json({ success: false, message: 'scheduled_at is required.' });
    const editFireDate = new Date(scheduled_at);
    if (isNaN(editFireDate.getTime()) || editFireDate <= new Date()) {
        newFiles.forEach(f => fs.unlink(f.path, () => {}));
        return res.status(400).json({ success: false, message: 'scheduled_at must be a valid future date and time.' });
    }

    // Fetch existing row to handle attachment file management
    getScheduledNewsletterAttachmentsIfPending(id, (fetchErr, existing) => {
        let attachmentPaths;
        if (newFiles.length > 0) {
            // New files uploaded — delete old ones and replace
            if (!fetchErr && existing && existing.attachment_paths) {
                try { JSON.parse(existing.attachment_paths).forEach(a => fs.unlink(a.path, () => {})); } catch(e) {}
            }
            attachmentPaths = JSON.stringify(newFiles.map(f => ({ filename: f.originalname, path: f.path })));
        } else {
            // No new files — keep existing attachment_paths unchanged
            attachmentPaths = (existing && existing.attachment_paths) || '[]';
        }

        updateScheduledNewsletter(subject, content, scheduled_at, attachmentPaths, segment || null, segment_value || null, id, function(err) {
            if (err) {
                newFiles.forEach(f => fs.unlink(f.path, () => {}));
                return res.status(500).json({ success: false, message: err.message });
            }
            if (this.changes === 0) {
                newFiles.forEach(f => fs.unlink(f.path, () => {}));
                return res.status(400).json({ success: false, message: 'Schedule not found or no longer pending.' });
            }
            if (scheduledJobs[id]) {
                scheduledJobs[id].cancel();
                delete scheduledJobs[id];
            }
            getScheduledNewsletterById(id, (err, row) => {
                if (!err && row && row.status === 'pending') {
                    scheduleNewsletterSend(row);
                }
            });
            res.json({ success: true });
        });
    });
});

// Audience count preview — lets the admin see how many subscribers a segment resolves to before
// actually sending, without duplicating the segment-matching SQL (shares buildSegmentCondition
// with both real send paths above).
router.get('/api/admin/newsletter/campaigns/audience-count', requireAdmin, (req, res) => {
    const { condition, params } = buildSegmentCondition(req.query.segment, req.query.segment_value);
    getAudienceCount(condition, params, (err, row) => {
        if (err) return res.status(500).json({ success: false, message: err.message });
        res.json({ success: true, count: row.count || 0 });
    });
});

router.get('/api/admin/newsletter/birthday-settings', requireAdmin, (req, res) => {
    getSettingsByKeys(BIRTHDAY_SETTING_KEYS, (err, rows) => {
        if (err) return res.status(500).json({ success: false, message: err.message });
        const map = {};
        (rows || []).forEach(r => { map[r.setting_key] = r.setting_value; });
        const result = {};
        BIRTHDAY_SETTING_KEYS.forEach(k => { result[k] = map[k] != null ? map[k] : BIRTHDAY_SETTING_DEFAULTS[k]; });
        res.json({ success: true, settings: result });
    });
});

router.put('/api/admin/newsletter/birthday-settings', requireAdmin, requireRole(['administrator', 'manager']), (req, res) => {
    const b = req.body || {};
    const updates = {};
    if (typeof b.birthday_automation_enabled !== 'undefined') updates.birthday_automation_enabled = b.birthday_automation_enabled ? '1' : '0';
    if (typeof b.birthday_send_time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(b.birthday_send_time)) updates.birthday_send_time = b.birthday_send_time;
    if (typeof b.birthday_test_mode !== 'undefined') updates.birthday_test_mode = b.birthday_test_mode ? '1' : '0';
    if (typeof b.birthday_test_recipient === 'string') {
        const val = sanitizeEmailInput(b.birthday_test_recipient);
        if (!val || EMAIL_FORMAT_RE.test(val)) updates.birthday_test_recipient = val;
    }
    if (typeof b.birthday_email_subject === 'string') updates.birthday_email_subject = b.birthday_email_subject.replace(/<[^>]*>/g, '').slice(0, 200);
    if (typeof b.birthday_email_heading === 'string') updates.birthday_email_heading = b.birthday_email_heading.replace(/<[^>]*>/g, '').slice(0, 200);
    if (typeof b.birthday_email_body === 'string') updates.birthday_email_body = sanitizeAboutHtml(b.birthday_email_body).slice(0, 5000);
    if (typeof b.birthday_email_cta_label === 'string') updates.birthday_email_cta_label = b.birthday_email_cta_label.replace(/<[^>]*>/g, '').slice(0, 60);
    if (typeof b.birthday_email_cta_url === 'string') updates.birthday_email_cta_url = b.birthday_email_cta_url.replace(/<[^>]*>/g, '').slice(0, 500);
    if (typeof b.birthday_email_footer_note === 'string') updates.birthday_email_footer_note = sanitizeAboutHtml(b.birthday_email_footer_note).slice(0, 500);

    const keys = Object.keys(updates);
    if (!keys.length) return res.json({ success: true });
    let pending = keys.length, failed = false;
    keys.forEach(key => {
        upsertSettingWithConflictClause(key, updates[key], (err) => {
                if (err && !failed) { failed = true; console.error('save birthday-settings failed:', err); return res.status(500).json({ success: false, message: 'Could not save birthday settings. Please try again.' }); }
                if (--pending === 0 && !failed) {
                    if ('birthday_send_time' in updates || 'birthday_automation_enabled' in updates) registerBirthdayJob();
                    res.json({ success: true, message: 'Birthday automation settings updated.' });
                }
            });
    });
});

// Preview — same construction as /api/admin/newsletter/preview, against a sample subscriber whose
// birthday is today (so {{birthday}} resolves to something real). Uses multipart form-data (like
// the newsletter Compose preview) rather than JSON, so the body-content field isn't HTML-escaped
// by the global deepEscapeBody middleware.
router.post('/api/admin/newsletter/birthday-settings/preview', requireAdmin, newsletterUpload.none(), async (req, res) => {
    try {
        const saved = await getBirthdaySettings();
        const settings = mergeBirthdayOverrides(saved, req.body || {});
        const today = moment().tz('Africa/Johannesburg');
        const sampleSubscriber = { first_name: 'Alex', email: 'alex@example.com', birthday_day: today.date(), birthday_month: today.month() + 1 };
        const html = await renderBirthdayEmail(settings, sampleSubscriber, '#', `${req.protocol}://${req.get('host')}`);
        res.json({ success: true, html });
    } catch (e) {
        console.error('[Birthday Preview] Error:', e.message);
        res.status(500).json({ success: false, message: 'Could not generate preview: ' + e.message });
    }
});

// Send Test — fires one real email to birthday_test_recipient using the current (possibly unsaved)
// template fields, so an admin can confirm it actually renders/arrives correctly before saving and
// enabling the real automation.
router.post('/api/admin/newsletter/birthday-settings/send-test', requireAdmin, requireRole(['administrator', 'manager']), newsletterUpload.none(), async (req, res) => {
    try {
        const saved = await getBirthdaySettings();
        const settings = mergeBirthdayOverrides(saved, req.body || {});
        const testRecipient = (typeof req.body.birthday_test_recipient === 'string' && req.body.birthday_test_recipient) || saved.birthday_test_recipient;
        if (!testRecipient) {
            return res.status(400).json({ success: false, message: 'Set a test recipient email first.' });
        }
        const today = moment().tz('Africa/Johannesburg');
        // Bug fix: this always built a tokenless /unsubscribe.html link, which the unsubscribe page
        // correctly (from its own perspective) rejects as invalid — every test send's unsubscribe
        // link was broken by construction. Mirrors runBirthdayAutomationSweep()'s real-token lookup:
        // if the test recipient happens to be an actual subscriber, give them a working link and
        // their real {{first_name}} (previously always hardcoded to "Alex", masking whether the
        // real per-subscriber lookup actually works); if not (a throwaway inbox that isn't
        // subscribed to anything), fall back to the placeholder name and the bare unsubscribe page.
        // Also covers {{subscription_date}}: sampleSubscriber never set subscribed_at at all, so
        // that merge field silently rendered as an empty string in every test send. And
        // {{birthday}}: owner decision (2026-07-16) — show the recipient's real stored birthday
        // when they're an actual subscriber, only falling back to today's date (so the field still
        // resolves to *something*) when the test recipient isn't a real subscriber at all.
        const testSubRow = await new Promise((resolve) => {
            getSubscriberBirthdayFields(testRecipient, (err, row) => resolve(row));
        });
        const sampleSubscriber = {
            first_name: (testSubRow && testSubRow.first_name) || 'Alex',
            email: testRecipient,
            birthday_day: (testSubRow && testSubRow.birthday_day) || today.date(),
            birthday_month: (testSubRow && testSubRow.birthday_month) || (today.month() + 1),
            subscribed_at: testSubRow && testSubRow.subscribed_at
        };
        const unsubscribeUrl = (testSubRow && testSubRow.unsubscribe_token)
            ? `${emailBaseUrl()}/unsubscribe.html?token=${testSubRow.unsubscribe_token}&email=${encodeURIComponent(testRecipient)}`
            : `${emailBaseUrl()}/unsubscribe.html`;
        const html = await renderBirthdayEmail(settings, sampleSubscriber, unsubscribeUrl);
        const subject = applyMergeFields(settings.birthday_email_subject, sampleSubscriber, unsubscribeUrl);
        await sendEmail({
            to: testRecipient,
            subject: '[TEST] ' + subject,
            htmlContent: html,
            preWrapped: true,
            titleOverride: subject,
            trigger_event: 'Newsletter: Birthday Test'
        });
        res.json({ success: true, message: 'Test email queued to ' + testRecipient + '.' });
    } catch (e) {
        console.error('[Birthday Send Test] Error:', e.message);
        res.status(500).json({ success: false, message: 'Could not send test email: ' + e.message });
    }
});

module.exports = router;
