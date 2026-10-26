// The conversation on an inquiry (table inquiry_messages) and the truth about whether each reply was actually delivered.
//
// The rule this module exists to enforce: an admin reply is NOT "sent" when it is queued. sendEmail() only puts the message in the
// notification outbox; Microsoft 365 may still refuse it (sign-in, throttling, a bad address). So:
//   - queueing a reply creates an inquiry_messages row in state 'queued', tied to its outbox row (notification_id);
//   - reconcileDelivery() - run after every outbox sweep and whenever a thread is read - derives the row's state from the outbox row:
//         outbox 'sent'                      -> 'accepted'  (Microsoft 365 took it; the server's own reply is in email_logs) AND ONLY NOW the
//                                               inquiry becomes 'replied' (responded_at on the first reply), credited to the admin who wrote it
//         outbox 'failed'                    -> 'failed'    (+ the reason; the composer item is flagged 'failed' so it can be sent again)
//         outbox 'pending' after a failed try-> 'attempted' (still retrying)
//   - a failed reply never changes the inquiry's status.
// Deriving the state from the outbox (instead of hooking each place the worker can succeed or fail) means every path - normal send, retries
// exhausted, the 24-hour expiry, a corrupt row, a missing attachment - ends up reflected here.
'use strict';
const crypto = require('crypto');
const db = require('../database');
const { getSenderEmail } = require('./smtp-config');

const dbGet = (sql, p = []) => new Promise((resolve, reject) => db.get(sql, p, (e, r) => e ? reject(e) : resolve(r)));
const dbAll = (sql, p = []) => new Promise((resolve, reject) => db.all(sql, p, (e, r) => e ? reject(e) : resolve(r)));
const dbRun = (sql, p = []) => new Promise((resolve, reject) => db.run(sql, p, function (e) { e ? reject(e) : resolve(this); }));

// A Message-ID we choose ourselves (so it is known before sending and can be matched when the customer answers). Nodemailer passes it through.
function newMessageId(inquiryId) {
    const domain = String(getSenderEmail() || '').split('@')[1] || 'thabisomhlongo.com';
    return `<inq-${inquiryId}-${crypto.randomUUID()}@${domain.replace(/[^A-Za-z0-9.-]/g, '')}>`;
}

async function createOutbound({ inquiryId, directEmailId, notificationId, messageId, subject, bodyHtml, to, cc, sentBy, sentByName }) {
    const r = await dbRun(
        `INSERT INTO inquiry_messages (inquiry_id, direction, source, message_id, from_address, to_addresses, cc_addresses, subject, body_html,
                                       direct_email_id, notification_id, delivery_status, sent_by, sent_by_name)
         VALUES (?, 'out', 'admin_reply', ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
        [inquiryId, messageId, getSenderEmail() || null, JSON.stringify(to || []), JSON.stringify(cc || []), subject || '', bodyHtml || '',
            directEmailId || null, notificationId || null, sentBy || null, sentByName || null]);
    return r.lastID;
}

// A failed reply sent again: the SAME conversation row goes back to 'queued' against a new outbox row.
async function requeue(id, { notificationId, sentBy, sentByName }) {
    await dbRun(`UPDATE inquiry_messages SET delivery_status = 'queued', attempts = 0, last_error = NULL, accepted_at = NULL, notification_id = ?,
                 sent_by = COALESCE(?, sent_by), sent_by_name = COALESCE(?, sent_by_name) WHERE id = ? AND direction = 'out'`,
        [notificationId, sentBy || null, sentByName || null, id]);
}

// Oldest first, the shape the admin thread renders. Recipients/addresses are parsed so the client does not guess.
async function listForInquiry(inquiryId) {
    const rows = await dbAll(`SELECT id, inquiry_id, direction, source, message_id, from_address, to_addresses, cc_addresses, subject, body_html, body_text,
                                     delivery_status, attempts, last_error, sent_by, sent_by_name, occurred_at, accepted_at, direct_email_id
                              FROM inquiry_messages WHERE inquiry_id = ? ORDER BY occurred_at ASC, id ASC`, [inquiryId]);
    const parse = (v) => { try { return JSON.parse(v || '[]'); } catch (e) { return []; } };
    return rows.map((r) => ({ ...r, to_addresses: parse(r.to_addresses), cc_addresses: parse(r.cc_addresses) }));
}

// The Message-ID of the newest message in the thread that the customer's mail client has seen - used as In-Reply-To / References on the next reply.
async function lastKnownMessageId(inquiryId) {
    const r = await dbGet(`SELECT message_id FROM inquiry_messages WHERE inquiry_id = ? AND message_id IS NOT NULL
                           AND (direction = 'in' OR delivery_status = 'accepted') ORDER BY occurred_at DESC, id DESC LIMIT 1`, [inquiryId]);
    return r ? r.message_id : null;
}

const OPEN = "delivery_status IN ('queued', 'attempted')";   // every transition below is guarded by this, so two overlapping reconciles cannot both act on one row

async function reconcileDelivery() {
    const rows = await dbAll(
        `SELECT m.id, m.inquiry_id, m.direct_email_id, m.sent_by, m.delivery_status AS cur, m.attempts,
                n.status AS n_status, n.retry_count, n.error_message, n.sent_at
         FROM inquiry_messages m JOIN notifications n ON n.id = m.notification_id
         WHERE m.direction = 'out' AND m.delivery_status IN ('queued', 'attempted')`);
    for (const r of rows) {
        if (r.n_status === 'sent') {
            const u = await dbRun(`UPDATE inquiry_messages SET delivery_status = 'accepted', accepted_at = COALESCE(?, CURRENT_TIMESTAMP), attempts = ?, last_error = NULL WHERE id = ? AND ${OPEN}`,
                [r.sent_at, (r.retry_count || 0) + 1, r.id]);
            if (u.changes) await markReplied(r.inquiry_id, r.sent_by);
        } else if (r.n_status === 'failed') {
            const u = await dbRun(`UPDATE inquiry_messages SET delivery_status = 'failed', attempts = ?, last_error = ? WHERE id = ? AND ${OPEN}`,
                [r.retry_count || 0, (r.error_message || 'The mail could not be delivered.').slice(0, 480), r.id]);
            if (u.changes && r.direct_email_id) await dbRun(`UPDATE direct_emails SET status = 'failed', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'sent'`, [r.direct_email_id]);
        } else if ((r.retry_count > 0 || r.error_message) && (r.cur !== 'attempted' || r.attempts !== (r.retry_count || 0))) {
            await dbRun(`UPDATE inquiry_messages SET delivery_status = 'attempted', attempts = ?, last_error = ? WHERE id = ? AND ${OPEN}`,
                [r.retry_count || 0, (r.error_message || '').slice(0, 480) || null, r.id]);
        }
    }
    return rows.length;
}

// 'replied' + responded_at (first reply only), credited to the admin who wrote the reply. Runs only when a reply was ACCEPTED.
async function markReplied(inquiryId, adminId) {
    const row = adminId ? await dbGet('SELECT role FROM admins WHERE id = ?', [adminId]).catch(() => null) : null;
    await dbRun(`UPDATE inquiries SET status = 'replied', responded_at = COALESCE(responded_at, CURRENT_TIMESTAMP),
                 updated_by = ?, updated_by_role = ?, updated_at = CURRENT_TIMESTAMP WHERE inquiry_id = ?`,
        [adminId || null, (row && row.role) || null, inquiryId]);
}

module.exports = { newMessageId, createOutbound, requeue, listForInquiry, lastKnownMessageId, reconcileDelivery, markReplied };
