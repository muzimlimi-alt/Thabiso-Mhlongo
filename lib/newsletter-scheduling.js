// Newsletter campaign scheduling — Phase 5 of the housekeeping effort (HOUSEKEEPING-NOTES.md).
// Moved out of the app.js monolith byte-identical.
//
// scheduledJobs MUST stay a singleton (same reasoning as lib/db-transaction.js's dbTxnQueue): it's
// the one map every caller (this file's own scheduleNewsletterSend, and the cancel/update routes)
// keys node-schedule Job objects by scheduled_newsletters.id, so cancelling/rescheduling a
// newsletter finds the same in-memory job the create path registered. Every caller must import
// this exact module, never keep their own map.
const fs = require('fs');
const schedule = require('node-schedule');
const bannerRegistry = require('../js/bannerRegistry');
const emailComponents = require('../js/emailComponents');
const { sendEmail } = require('../js/emailService');
const { applyMergeFields } = require('../js/mergeFields');
const { getEmailFooterContext, emailBaseUrl } = require('./email-context');
const {
    claimScheduledNewsletterForSending, getActiveSubscribersForSegment,
    markScheduledNewsletterFailed, markScheduledNewsletterSkipped, markScheduledNewsletterSent,
    insertCampaignLog, getPendingScheduledNewsletters,
} = require('../database/repositories/newsletter.repository');

const scheduledJobs = {}; // key: scheduled_newsletters.id → job object

// Newsletter audience segmentation — an optional extra SQL condition layered on top of the
// existing `status = 'active'` filter both send paths already apply. Returns a raw SQL fragment
// (starting with "AND") plus its bound params; '' (no extra filter) for 'all'/unknown segments.
// An invalid/missing value for a value-requiring segment matches nothing rather than erroring,
// so a bad request never accidentally broadcasts to everyone.
function buildSegmentCondition(segment, segmentValue) {
    switch (segment) {
        case 'new_30d':
            return { condition: "AND subscribed_at >= datetime('now', '-30 days')", params: [] };
        case 'birthday_month': {
            const month = parseInt(segmentValue, 10);
            if (!Number.isInteger(month) || month < 1 || month > 12) return { condition: 'AND 0', params: [] };
            return { condition: 'AND birthday_month = ?', params: [month] };
        }
        case 'has_tag': {
            const tag = String(segmentValue || '').trim();
            if (!tag) return { condition: 'AND 0', params: [] };
            return { condition: 'AND tags LIKE ?', params: [`%"${tag}"%`] };
        }
        case 'source': {
            const src = String(segmentValue || '').trim();
            if (!src) return { condition: 'AND 0', params: [] };
            return { condition: 'AND source = ?', params: [src] };
        }
        case 'booking_clients':
            return { condition: 'AND email IN (SELECT DISTINCT email FROM bookings)', params: [] };
        case 'dormant': {
            const days = parseInt(segmentValue, 10);
            const d = (Number.isInteger(days) && days > 0) ? days : 180;
            return { condition: "AND subscribed_at <= datetime('now', ?) AND email NOT IN (SELECT DISTINCT email FROM bookings)", params: [`-${d} days`] };
        }
        default:
            return { condition: '', params: [] };
    }
}

function scheduleNewsletterSend(schedItem, { fireImmediately = false } = {}) {
    // Handle both ISO8601 ("2025-05-12T14:00:00.000Z") and SQLite datetime ("2025-05-12 14:00:00")
    const rawDt = schedItem.scheduled_at;
    let fireDate = new Date(rawDt.includes('T') ? rawDt : rawDt.replace(' ', 'T') + 'Z');
    if (fireImmediately) {
        // node-schedule's handling of a Date already in the past is unreliable/undocumented — give
        // it a concrete few-seconds-out target instead, so a recovered overdue row is guaranteed to
        // fire while still reusing this function's exact send logic (including the atomic claim below).
        fireDate = new Date(Date.now() + 2000);
    } else if (isNaN(fireDate.getTime()) || fireDate <= new Date()) {
        return;
    }

    const job = schedule.scheduleJob(fireDate, function() {
        // Atomic claim: only one caller can ever win this row. Replaces the old soft
        // `db.get` status re-check, which left a real (if narrow, single-process) window for the
        // same row to be processed twice — see the ripple note on campaigns/unified's display_status
        // CASE, which needed a matching update for this new transient 'sending' value.
        claimScheduledNewsletterForSending(schedItem.id, async function(claimErr) {
            if (claimErr || this.changes !== 1) {
                delete scheduledJobs[schedItem.id];
                return;
            }

            const { condition: segCondition, params: segParams } = buildSegmentCondition(schedItem.segment, schedItem.segment_value);
            getActiveSubscribersForSegment(segCondition, segParams, async (err2, subscribers) => {
                if (err2) {
                    markScheduledNewsletterFailed(schedItem.id);
                    delete scheduledJobs[schedItem.id];
                    return;
                }
                if (!subscribers || subscribers.length === 0) {
                    markScheduledNewsletterSkipped(schedItem.id);
                    delete scheduledJobs[schedItem.id];
                    return;
                }

                let jobAttachments = [];
                if (schedItem.attachment_paths) {
                    try {
                        jobAttachments = JSON.parse(schedItem.attachment_paths)
                            .filter(a => fs.existsSync(a.path))
                            .map(a => ({ filename: a.filename, path: a.path }));
                    } catch(e) {}
                }

                // Campaign content is the admin's own authored HTML — run through the merge-field
                // engine per recipient, then wrapped with the brand shell + a per-recipient
                // unsubscribe link (preWrapped bypasses sendEmailDirectly's own subscriber lookup,
                // so it's built here instead).
                const { socialLinks: schedSocialLinks } = await getEmailFooterContext();
                const campaignBanner = await bannerRegistry.resolveBanner('newsletter_campaign');
                let successCount = 0;
                let failCount = 0;
                for (const sub of subscribers) {
                    try {
                        const unsubscribeUrl = sub.unsubscribe_token
                            ? `${emailBaseUrl()}/unsubscribe.html?token=${sub.unsubscribe_token}&email=${encodeURIComponent(sub.email)}`
                            : null;
                        const personalizedSubject = applyMergeFields(schedItem.subject, sub, unsubscribeUrl);
                        const personalizedBody = applyMergeFields(schedItem.content, sub, unsubscribeUrl);
                        const html = emailComponents.renderPremiumEmail({
                            preheaderText: personalizedSubject,
                            bannerSrc: campaignBanner?.src, bannerAlt: campaignBanner?.alt, subtitle: campaignBanner?.subtitle,
                            headline: personalizedSubject,
                            bodyHtml: personalizedBody,
                            unsubscribeUrl,
                            socialLinks: schedSocialLinks
                        });
                        const result = await sendEmail({
                            to: sub.email,
                            subject: personalizedSubject,
                            htmlContent: html,
                            preWrapped: true,
                            titleOverride: personalizedSubject,
                            attachments: jobAttachments,
                            trigger_event: 'Newsletter: Scheduled Campaign'
                        });
                        if (result.success) { successCount++; } else { failCount++; }
                    } catch (e) {
                        failCount++;
                        console.error(`Scheduled newsletter [${schedItem.id}]: failed sending to ${sub.email}:`, e.message);
                    }
                    // No artificial delay — see the equivalent comment in POST /api/admin/campaigns;
                    // real SMTP pacing is handled independently by processNotificationQueue().
                }

                markScheduledNewsletterSent(successCount, failCount, schedItem.id);
                insertCampaignLog(schedItem.subject, schedItem.content, subscribers.length, successCount, failCount);
                jobAttachments.forEach(a => fs.unlink(a.path, () => {}));
                delete scheduledJobs[schedItem.id];
                console.log(`✅ Scheduled newsletter [${schedItem.id}] dispatched: sent ${successCount}/${subscribers.length}, failures: ${failCount}`);
            });
        });
    });
    scheduledJobs[schedItem.id] = job;
}

// Phase 5 (HOUSEKEEPING-NOTES.md): relocated from app.js verbatim. app.js still exports this
// (re-imported from here) alongside loadPendingDirectEmails, since server.js calls both directly
// from its own app.listen() callback.
// --- Newsletter Scheduling ---
function loadPendingScheduledJobs() {
    // Fetch ALL pending rows and partition future-vs-overdue in JS rather than filtering with SQL's
    // `scheduled_at > datetime('now')` — that comparison is a byte-for-byte TEXT compare, and
    // scheduled_at is stored as an ISO instant ("...T06:25:42.296Z") while datetime('now') returns
    // "...08:25:42" (space, no T) — 'T' (0x54) sorts after ' ' (0x20) at that byte offset
    // UNCONDITIONALLY, so the old SQL filter treated every same-day-overdue row as "still pending"
    // and handed it to scheduleNewsletterSend(), which then silently dropped it via its own
    // fireDate <= new Date() guard. This table is low-volume (one comedian's newsletter, not a
    // mass-mailer), so fetching everything and partitioning in JS is simpler and correct.
    getPendingScheduledNewsletters((err, rows) => {
        if (err) return console.error('Failed to load scheduled jobs:', err);
        let recovered = 0;
        rows.forEach(row => {
            const rawDt = row.scheduled_at;
            const fireDate = new Date(rawDt.includes('T') ? rawDt : rawDt.replace(' ', 'T') + 'Z');
            if (isNaN(fireDate.getTime())) return; // corrupt row — leave for manual review, don't guess
            if (fireDate.getTime() <= Date.now()) {
                recovered++;
                scheduleNewsletterSend(row, { fireImmediately: true });
            } else {
                scheduleNewsletterSend(row);
            }
        });
        if (recovered > 0) console.log(`[Newsletter] Recovering ${recovered} overdue scheduled campaign(s) after restart`);
    });
}

module.exports = { scheduledJobs, buildSegmentCondition, scheduleNewsletterSend, loadPendingScheduledJobs };
