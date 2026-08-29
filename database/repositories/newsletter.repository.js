// Newsletter domain repository — Phase 4 of the housekeeping effort (HOUSEKEEPING-NOTES.md).
// Covers newsletter_subscribers, newsletter_campaigns, newsletter_drafts, scheduled_newsletters.
// Every SQL string below is byte-identical to where it lived in server.js before this move. No
// req/res, no email sending, no PDF generation, no calendar calls — pure data access. Several
// functions here are called from routes/functions in server.js that ALSO send email per-recipient
// (scheduleNewsletterSend, the campaign dispatch route) — only their SQL moved, per the plan's
// rule 5; the email loop itself stays in server.js untouched.
const db = require('../../database');

function promised(sql, params) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function (err) { err ? reject(err) : resolve(this); });
    });
}

// ── Public subscribe / confirm / unsubscribe ──
function insertPendingSubscriber(email, unsubscribe_token, ip_address, user_agent, source, policyVersion, first_name, birthdayDayVal, birthdayMonthVal, callback) {
    db.run(`INSERT INTO newsletter_subscribers (email, status, active, unsubscribe_token, ip_address, user_agent, source, popia_consent, consent_timestamp, policy_version, first_name, birthday_day, birthday_month) VALUES (?, 'pending_confirmation', 0, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP, ?, ?, ?, ?)`,
        [email, unsubscribe_token, ip_address, user_agent, source, policyVersion, first_name, birthdayDayVal, birthdayMonthVal], callback);
}
function getSubscriberDuplicateCheck(email, callback) {
    db.get("SELECT subscriber_id, status, unsubscribe_token, modified_on FROM newsletter_subscribers WHERE LOWER(email) = LOWER(?)", [email], callback);
}
function touchSubscriberCooldown(subscriberId, callback) {
    db.run("UPDATE newsletter_subscribers SET modified_on = CURRENT_TIMESTAMP WHERE subscriber_id = ? AND (modified_on IS NULL OR datetime(modified_on) <= datetime('now', '-5 minutes'))",
        [subscriberId], callback);
}
function reactivateSubscriber(policyVersion, first_name, birthdayDayVal, birthdayMonthVal, ip_address, user_agent, source, subscriberId, callback) {
    db.run(`UPDATE newsletter_subscribers SET status = 'pending_confirmation', active = 0, confirmed_at = NULL,
            popia_consent = 1, consent_timestamp = CURRENT_TIMESTAMP, policy_version = ?, first_name = ?,
            birthday_day = ?, birthday_month = ?, ip_address = ?, user_agent = ?, source = ?, modified_on = CURRENT_TIMESTAMP
            WHERE subscriber_id = ?`,
        [policyVersion, first_name, birthdayDayVal, birthdayMonthVal, ip_address, user_agent, source, subscriberId], callback);
}
function getSubscriberForConfirm(email, token, callback) {
    db.get("SELECT subscriber_id, status, first_name, unsubscribe_token FROM newsletter_subscribers WHERE LOWER(email) = LOWER(?) AND unsubscribe_token = ?", [email, token], callback);
}
function confirmSubscriber(subscriberId, callback) {
    db.run("UPDATE newsletter_subscribers SET status = 'active', active = 1, confirmed_at = CURRENT_TIMESTAMP, modified_on = CURRENT_TIMESTAMP WHERE subscriber_id = ?", [subscriberId], callback);
}
function getSubscriberForUnsubscribe(email, token, callback) {
    db.get("SELECT subscriber_id FROM newsletter_subscribers WHERE LOWER(email) = LOWER(?) AND unsubscribe_token = ?", [email, token], callback);
}
function unsubscribeSubscriber(subscriberId, callback) {
    db.run("UPDATE newsletter_subscribers SET status = 'unsubscribed', active = 0, modified_on = CURRENT_TIMESTAMP WHERE subscriber_id = ?", [subscriberId], callback);
}

// ── Admin subscriber CRUD ──
function countSubscribers(whereClause, qp, callback) {
    db.get(`SELECT COUNT(*) AS total FROM newsletter_subscribers ${whereClause}`, qp, callback);
}
function listSubscribers(whereClause, orderClause, params, callback) {
    db.all(`SELECT * FROM newsletter_subscribers ${whereClause} ORDER BY ${orderClause} LIMIT ? OFFSET ?`, params, callback);
}
function getSubscriberStats(callback) {
    db.get(
        `SELECT
            COUNT(*) AS total,
            SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
            SUM(CASE WHEN subscribed_at >= datetime('now', '-7 days') THEN 1 ELSE 0 END) AS new_7d
         FROM newsletter_subscribers`,
        callback
    );
}
function insertSubscriberManual(email, unsubscribe_token, ip_address, user_agent, source, adminId, first_name, callback) {
    db.run(`INSERT INTO newsletter_subscribers (email, status, active, unsubscribe_token, ip_address, user_agent, source, created_by, first_name) VALUES (?, 'active', 1, ?, ?, ?, ?, ?, ?)`,
        [email, unsubscribe_token, ip_address, user_agent, source, adminId, first_name], callback);
}
function updateSubscriberProfile(setClauses, params, callback) {
    db.run(`UPDATE newsletter_subscribers SET ${setClauses.join(', ')} WHERE subscriber_id = ?`, params, callback);
}
function getSubscriberForStatusToggle(subscriberId, callback) {
    db.get("SELECT status, email, first_name, unsubscribe_token FROM newsletter_subscribers WHERE subscriber_id = ?", [subscriberId], callback);
}
function updateSubscriberStatus(confirmedAtClause, status, active, adminId, subscriberId, callback) {
    db.run(`UPDATE newsletter_subscribers
            SET status = ?, active = ?, modified_on = CURRENT_TIMESTAMP, modified_by = ?${confirmedAtClause}
            WHERE subscriber_id = ?`,
        [status, active, adminId, subscriberId], callback);
}
function deleteSubscriber(subscriberId, callback) {
    db.run(`DELETE FROM newsletter_subscribers WHERE subscriber_id = ?`, [subscriberId], callback);
}
function bulkUpdateSubscriberStatus(placeholders, status, active, adminId, ids, callback) {
    db.run(`UPDATE newsletter_subscribers
             SET status = ?, active = ?, modified_on = CURRENT_TIMESTAMP, modified_by = ?
             WHERE subscriber_id IN (${placeholders})`,
        [status, active, adminId, ...ids], callback);
}
function bulkConfirmPendingSubscribers(pendingPlaceholders, subscriberIds, callback) {
    db.run(`UPDATE newsletter_subscribers SET confirmed_at = CURRENT_TIMESTAMP WHERE subscriber_id IN (${pendingPlaceholders})`,
        subscriberIds, callback);
}
function getPendingSubscribersForBulkActivate(placeholders, ids, callback) {
    db.all(`SELECT subscriber_id, email, first_name, unsubscribe_token FROM newsletter_subscribers WHERE subscriber_id IN (${placeholders}) AND status = 'pending_confirmation'`,
        ids, callback);
}
function bulkDeleteSubscribers(placeholders, ids, callback) {
    db.run(`DELETE FROM newsletter_subscribers WHERE subscriber_id IN (${placeholders})`, ids, callback);
}

// ── CSV import (caller wraps these in its own existing BEGIN/COMMIT/ROLLBACK — unchanged) ──
function updateSubscriberFromCsvRow(status, firstName, birthdayDay, birthdayMonth, tagsJson, adminId, email) {
    return promised(
        `UPDATE newsletter_subscribers
         SET status = ?,
             first_name = COALESCE(NULLIF(?, ''), first_name),
             birthday_day = COALESCE(?, birthday_day),
             birthday_month = COALESCE(?, birthday_month),
             tags = COALESCE(?, tags),
             modified_on = CURRENT_TIMESTAMP, modified_by = ?
         WHERE LOWER(email) = LOWER(?)`,
        [status, firstName, birthdayDay, birthdayMonth, tagsJson, adminId, email]
    );
}
function insertSubscriberFromCsvRow(email, status, active, unsubscribe_token, adminId, firstName, birthdayDay, birthdayMonth, tagsJson) {
    return promised(
        `INSERT INTO newsletter_subscribers (email, status, active, unsubscribe_token, source, created_by, first_name, birthday_day, birthday_month, tags)
         VALUES (?, ?, ?, ?, 'csv_import', ?, ?, ?, ?, ?)`,
        [email, status, active, unsubscribe_token, adminId, firstName, birthdayDay, birthdayMonth, tagsJson]
    );
}

// ── Drafts CRUD ──
function insertDraft(subject, content, callback) {
    db.run("INSERT INTO newsletter_drafts (subject, content) VALUES (?, ?)", [subject, content], callback);
}
function updateDraft(subject, content, id, callback) {
    db.run("UPDATE newsletter_drafts SET subject = ?, content = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [subject, content, id], callback);
}
function listDrafts(callback) {
    db.all("SELECT id, subject, content, created_at, updated_at FROM newsletter_drafts ORDER BY updated_at DESC", [], callback);
}
function getDraft(id, callback) {
    db.get("SELECT id, subject, content, created_at, updated_at FROM newsletter_drafts WHERE id = ?", [id], callback);
}
function deleteDraft(id, callback) {
    db.run("DELETE FROM newsletter_drafts WHERE id = ?", [id], callback);
}

// ── Scheduled-send engine (server.js keeps the full email-sending loop; only SQL moved) ──
function getPendingScheduledNewsletters(callback) {
    db.all("SELECT * FROM scheduled_newsletters WHERE status = 'pending'", callback);
}
function claimScheduledNewsletterForSending(id, callback) {
    db.run("UPDATE scheduled_newsletters SET status = 'sending' WHERE id = ? AND status = 'pending'", [id], callback);
}
function getActiveSubscribersForSegment(segCondition, segParams, callback) {
    db.all(
        `SELECT email, unsubscribe_token, first_name, subscribed_at, birthday_day, birthday_month
         FROM newsletter_subscribers WHERE status = 'active' ${segCondition}`,
        segParams, callback);
}
function markScheduledNewsletterFailed(id) {
    db.run("UPDATE scheduled_newsletters SET status = 'failed' WHERE id = ?", [id]);
}
function markScheduledNewsletterSkipped(id) {
    db.run("UPDATE scheduled_newsletters SET status = 'skipped' WHERE id = ?", [id]);
}
function markScheduledNewsletterSent(successCount, failCount, id) {
    db.run("UPDATE scheduled_newsletters SET status = 'sent', success_count = ?, fail_count = ? WHERE id = ?",
        [successCount, failCount, id]);
}
function insertCampaignLog(subject, content, recipientCount, successCount, failCount, callback) {
    db.run("INSERT INTO newsletter_campaigns (subject, content, recipient_count, success_count, fail_count) VALUES (?, ?, ?, ?, ?)",
        [subject, content, recipientCount, successCount, failCount], callback);
}

// ── Schedule CRUD ──
function insertScheduledNewsletter(subject, content, scheduled_at, attachmentPaths, segment, segmentValue, callback) {
    db.run("INSERT INTO scheduled_newsletters (subject, content, scheduled_at, attachment_paths, segment, segment_value) VALUES (?, ?, ?, ?, ?, ?)",
        [subject, content, scheduled_at, attachmentPaths, segment, segmentValue], callback);
}
function getScheduledNewsletterById(id, callback) {
    db.get("SELECT * FROM scheduled_newsletters WHERE id = ?", [id], callback);
}
function listScheduledNewsletters(callback) {
    db.all("SELECT id, subject, content, scheduled_at, status, created_at FROM scheduled_newsletters ORDER BY scheduled_at DESC", [], callback);
}
function getScheduledNewsletterAttachmentsIfPending(id, callback) {
    db.get("SELECT attachment_paths FROM scheduled_newsletters WHERE id = ? AND status = 'pending'", [id], callback);
}
function cancelScheduledNewsletter(id, callback) {
    db.run("UPDATE scheduled_newsletters SET status = 'cancelled' WHERE id = ? AND status = 'pending'", [id], callback);
}
function updateScheduledNewsletter(subject, content, scheduled_at, attachmentPaths, segment, segmentValue, id, callback) {
    db.run("UPDATE scheduled_newsletters SET subject = ?, content = ?, scheduled_at = ?, attachment_paths = ?, segment = ?, segment_value = ? WHERE id = ? AND status = 'pending'",
        [subject, content, scheduled_at, attachmentPaths, segment, segmentValue, id], callback);
}

// ── Campaign dispatch (server.js keeps the full email-sending loop; only SQL moved) ──
function getAudienceCount(condition, params, callback) {
    db.get(`SELECT COUNT(*) AS count FROM newsletter_subscribers WHERE status = 'active' ${condition}`, params, callback);
}

// ── Birthday send-test/sweep (reads only; writing/sending stays in server.js) ──
function getSubscriberBirthdayFields(email, callback) {
    db.get("SELECT first_name, unsubscribe_token, subscribed_at, birthday_day, birthday_month FROM newsletter_subscribers WHERE LOWER(email) = LOWER(?)", [email], callback);
}
function getSubscribersWithBirthdayToday(day, month, callback) {
    db.all("SELECT * FROM newsletter_subscribers WHERE status = 'active' AND birthday_day = ? AND birthday_month = ?", [day, month], callback);
}

// ── Campaign delete/list/bulk-delete ──
function deleteCampaign(id, callback) {
    db.run("DELETE FROM newsletter_campaigns WHERE id = ?", [id], callback);
}
function countUnifiedCampaigns(inner, whereClause, qp, callback) {
    db.get(`SELECT COUNT(*) AS total FROM (${inner}) ${whereClause}`, qp, callback);
}
function listUnifiedCampaigns(inner, whereClause, orderClause, params, callback) {
    db.all(`SELECT * FROM (${inner}) ${whereClause} ORDER BY ${orderClause} LIMIT ? OFFSET ?`, params, callback);
}
function bulkDeleteCampaigns(ph, campaignIds, callback) {
    db.run(`DELETE FROM newsletter_campaigns WHERE id IN (${ph})`, campaignIds, callback);
}
function getScheduledAttachmentsForIds(ph, scheduleIds, callback) {
    db.all(`SELECT attachment_paths FROM scheduled_newsletters WHERE id IN (${ph})`, scheduleIds, callback);
}
function bulkDeleteScheduled(ph, scheduleIds, callback) {
    db.run(`DELETE FROM scheduled_newsletters WHERE id IN (${ph})`, scheduleIds, callback);
}

// ── Single statements extracted out of multi-domain functions (only this table's statement
// moved; the surrounding orchestration — inquiries anonymization, bookings/communication_log
// erasure, etc. — stays in server.js exactly where it was) ──
function deleteOldUnsubscribedSubscribers(callback) {
    db.run("DELETE FROM newsletter_subscribers WHERE status = 'unsubscribed' AND modified_on < date('now', '-1 year')", callback);
}
function deleteSubscriberForErasure(email) {
    return promised(`DELETE FROM newsletter_subscribers WHERE LOWER(email) = LOWER(?)`, [email]);
}

module.exports = {
    insertPendingSubscriber, getSubscriberDuplicateCheck, touchSubscriberCooldown, reactivateSubscriber,
    getSubscriberForConfirm, confirmSubscriber, getSubscriberForUnsubscribe, unsubscribeSubscriber,
    countSubscribers, listSubscribers, getSubscriberStats, insertSubscriberManual, updateSubscriberProfile,
    getSubscriberForStatusToggle, updateSubscriberStatus, deleteSubscriber, bulkUpdateSubscriberStatus,
    bulkConfirmPendingSubscribers, getPendingSubscribersForBulkActivate, bulkDeleteSubscribers,
    updateSubscriberFromCsvRow, insertSubscriberFromCsvRow,
    insertDraft, updateDraft, listDrafts, getDraft, deleteDraft,
    getPendingScheduledNewsletters, claimScheduledNewsletterForSending, getActiveSubscribersForSegment,
    markScheduledNewsletterFailed, markScheduledNewsletterSkipped, markScheduledNewsletterSent, insertCampaignLog,
    insertScheduledNewsletter, getScheduledNewsletterById, listScheduledNewsletters,
    getScheduledNewsletterAttachmentsIfPending, cancelScheduledNewsletter, updateScheduledNewsletter,
    getAudienceCount,
    getSubscriberBirthdayFields, getSubscribersWithBirthdayToday,
    deleteCampaign, countUnifiedCampaigns, listUnifiedCampaigns, bulkDeleteCampaigns,
    getScheduledAttachmentsForIds, bulkDeleteScheduled,
    deleteOldUnsubscribedSubscribers, deleteSubscriberForErasure,
};
