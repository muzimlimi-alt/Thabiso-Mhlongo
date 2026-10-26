// Direct-email scheduling and sending — Phase 5 of the housekeeping effort
// (HOUSEKEEPING-NOTES.md). Moved out of the app.js monolith byte-identical. `direct_emails` was
// never claimed by any Phase 4 domain repository, so this uses `db` directly.
//
// sendDirectEmail originally resolved a relative attachment path against __dirname (of app.js,
// the project root) — __dirname inside lib/ would instead resolve one level too deep, so this uses
// PROJECT_ROOT from lib/runtime-paths.js instead (the same one-level-deep anchor pattern already
// established there and in database/repositories/*.js).
//
// scheduledJobs comes from lib/newsletter-scheduling.js — this module's jobs share that same map
// (keyed by a `direct_${id}` prefix to avoid colliding with newsletter's numeric keys), so this
// file must import that exact module rather than keep its own map. See that file's header comment.
//
// REPLIES TO INQUIRIES (Contact/Inquiries <-> Microsoft 365, Phase 4). "Sent" here only ever means "handed to the notification outbox" - the
// outbox, not this function, learns whether Microsoft 365 accepted the mail. So for an inquiry-linked email this function:
//   - takes the recipient from the INQUIRY (the stored To is ignored), so a forged or edited draft cannot send "a reply" anywhere else;
//   - tags the subject with the inquiry reference ([INQ-000123]) and adds In-Reply-To / References / X-TM-Inquiry-Id, so the customer's
//     answer can be matched back to the inquiry (lib/inbox-sync.js);
//   - records the reply in the conversation (inquiry_messages, state 'queued') tied to its outbox row;
//   - does NOT mark the inquiry 'replied' - lib/inquiry-messages.js does that when (and only when) the outbox reports the mail accepted;
//   - reports a failure to queue to the caller instead of pretending it worked.
const path = require('path');
const schedule = require('node-schedule');
const db = require('../database');
const bannerRegistry = require('../js/bannerRegistry');
const emailComponents = require('../js/emailComponents');
const { sendEmail } = require('../js/emailService');
const { getSenderEmail } = require('./smtp-config');
const { getEmailFooterContext } = require('./email-context');
const { PROJECT_ROOT } = require('./runtime-paths');
const objectStorage = require('./object-storage');
const { scheduledJobs } = require('./newsletter-scheduling');
const { decodeStoredText } = require('./html-sanitize');
const { referenceFor } = require('./contact-validation');
const inquiryMessages = require('./inquiry-messages');

const dbGet = (sql, p = []) => new Promise((resolve, reject) => db.get(sql, p, (e, r) => e ? reject(e) : resolve(r)));
const dbRun = (sql, p = []) => new Promise((resolve, reject) => db.run(sql, p, function (e) { e ? reject(e) : resolve(this); }));

function scheduleDirectEmailSend(emailItem) {
    const rawDt = emailItem.scheduled_at;
    if (!rawDt) return;
    const fireDate = new Date(rawDt.includes('T') ? rawDt : rawDt.replace(' ', 'T') + 'Z');
    if (isNaN(fireDate.getTime())) return;
    const fire = () => sendDirectEmail(emailItem.id).catch((e) => console.error(`Scheduled direct email #${emailItem.id} could not be sent:`, e.message));

    if (fireDate <= new Date()) {
        // past date, send immediately
        fire();
        return;
    }

    const jobKey = `direct_${emailItem.id}`;
    if (scheduledJobs[jobKey]) {
        scheduledJobs[jobKey].cancel();
    }

    scheduledJobs[jobKey] = schedule.scheduleJob(fireDate, fire);
}

// The reference tag that lets a customer's answer find its inquiry, added once.
const withReference = (subject, ref) => (String(subject).includes(`[${ref}]`) ? subject : `${subject} [${ref}]`);

/**
 * Hands one saved direct email to the outbox. Resolves when it is QUEUED (not when it is delivered); rejects when it could not be queued
 * (the item is then marked 'failed' and stays editable/sendable). actor = { id, name } of the admin pressing Send; a scheduled send has none
 * and falls back to whoever wrote the draft. opts.retryMessageId = re-send the SAME conversation row of a failed reply.
 */
async function sendDirectEmailOnce(id, actor, opts) {
    const emailItem = await dbGet('SELECT * FROM direct_emails WHERE id = ?', [id]);
    if (!emailItem) throw new Error('Email item not found');
    if (emailItem.status === 'sent') return;
    const fail = async (message) => { await dbRun("UPDATE direct_emails SET status = 'failed', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [id]); throw new Error(message); };

    let toList = [];
    try { toList = JSON.parse(emailItem.to_emails || '[]'); } catch (e) { toList = [emailItem.to_emails]; }
    let ccList = [];
    try { ccList = JSON.parse(emailItem.cc_emails || '[]'); } catch (e) { ccList = []; }
    let bccList = [];
    try { bccList = JSON.parse(emailItem.bcc_emails || '[]'); } catch (e) { bccList = []; }

    // An inquiry reply goes to the inquiry's own sender - whatever the draft says.
    let inquiry = null;
    if (emailItem.inquiry_id) {
        inquiry = await dbGet('SELECT inquiry_id, sender_email FROM inquiries WHERE inquiry_id = ?', [emailItem.inquiry_id]);
        if (!inquiry) await fail('The inquiry this reply belongs to no longer exists.');
        toList = [decodeStoredText(inquiry.sender_email)];
    }

    const to = toList.join(', ');
    const cc = ccList.length ? ccList.join(', ') : null;
    const bcc = bccList.length ? bccList.join(', ') : null;

    let attachments = [];
    if (emailItem.attachment_paths) {
        try {
            const paths = JSON.parse(emailItem.attachment_paths);
            for (const p of paths) {
                if (p && p.path) {
                    const resolvedPath = path.isAbsolute(p.path) ? p.path : path.join(PROJECT_ROOT, p.path);
                    if (await objectStorage.fileExists(resolvedPath)) {
                        attachments.push({ filename: p.filename || path.basename(p.path), content: await objectStorage.readFile(resolvedPath) });
                    }
                }
            }
        } catch (e) {
            console.error('Failed to parse attachments for direct email:', e);
        }
    }

    try {
        // Route through the same registry-resolved rendering every other PREMIUM email uses —
        // branding_option/selected_banner_url are no longer read (see direct-emails/preview
        // below): they pointed at the legacy branded-logic branch in sendEmailDirectly(), which
        // never runs (EMAIL_OVERHAUL_ENABLED is unset in every deployment), so this email was
        // going out completely raw — no wrapper, no banner, no footer, no unsubscribe.
        const templateKey = emailItem.inquiry_id ? 'inquiry_reply' : 'direct_compose';
        const banner = await bannerRegistry.resolveBanner(templateKey);
        const { socialLinks } = await getEmailFooterContext();
        const html = emailComponents.renderPremiumEmail({
            preheaderText: emailItem.subject || 'A message from Thabiso Mhlongo Management.',
            bannerSrc: banner?.src, bannerAlt: banner?.alt, subtitle: banner?.subtitle,
            headline: banner?.headline || (emailItem.inquiry_id ? 'Management Response' : 'Direct Message'),
            bodyHtml: emailItem.body, // already real HTML from Quill's root.innerHTML — embed verbatim
            socialLinks
        });

        let subject = emailItem.subject || 'Message from Thabiso Mhlongo Management';
        let messageId = null, headers = null, existing = null;
        if (inquiry) {
            subject = withReference(subject, referenceFor(inquiry.inquiry_id));
            existing = opts.retryMessageId ? await dbGet('SELECT id, message_id FROM inquiry_messages WHERE id = ? AND inquiry_id = ?', [opts.retryMessageId, inquiry.inquiry_id]) : null;
            messageId = (existing && existing.message_id) || inquiryMessages.newMessageId(inquiry.inquiry_id);
            headers = { 'X-TM-Inquiry-Id': String(inquiry.inquiry_id) };
            const previous = await inquiryMessages.lastKnownMessageId(inquiry.inquiry_id);
            if (previous) { headers['In-Reply-To'] = previous; headers.References = previous; }
        }

        const result = await sendEmail({
            to,
            subject,
            htmlContent: html,
            preWrapped: true,
            replyTo: emailItem.reply_to || getSenderEmail() || 'admin@thabisomhlongo.com',
            cc,
            bcc,
            attachments,
            messageId,
            headers,
            trigger_event: emailItem.inquiry_id ? 'Admin: Inquiry Reply' : 'Admin: Direct Compose',
            related_entity: emailItem.inquiry_id ? 'inquiries' : null,
            related_id: emailItem.inquiry_id || null
        });
        if (!result.success) await fail(result.error || 'The email could not be queued for delivery.');

        // Handed to the outbox. ('sent' on a direct email means exactly that; the delivery truth for a reply lives in inquiry_messages.)
        await dbRun("UPDATE direct_emails SET status = 'sent', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [id]);

        if (inquiry) {
            const adminId = (actor && actor.id) || emailItem.created_by || null;
            let adminName = (actor && actor.name) || null;
            if (adminId && !adminName) {
                const a = await dbGet('SELECT COALESCE(full_name, username) AS name FROM admins WHERE id = ?', [adminId]).catch(() => null);
                adminName = a && a.name;
            }
            if (existing) await inquiryMessages.requeue(existing.id, { notificationId: result.notificationId, sentBy: adminId, sentByName: decodeStoredText(adminName) });
            else await inquiryMessages.createOutbound({
                inquiryId: inquiry.inquiry_id, directEmailId: id, notificationId: result.notificationId, messageId, subject: decodeStoredText(subject), bodyHtml: emailItem.body,
                to: toList, cc: ccList, sentBy: adminId, sentByName: decodeStoredText(adminName)
            });
        }
    } catch (error) {
        console.error(`Failed to send direct email #${id}:`, error.message);
        await dbRun("UPDATE direct_emails SET status = 'failed', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status <> 'sent'", [id]).catch(() => {});
        throw error;
    } finally {
        const jobKey = `direct_${id}`;
        if (scheduledJobs[jobKey]) delete scheduledJobs[jobKey];
    }
}

// One send per item at a time (a double click or a schedule firing while the admin presses Send must not queue the mail twice).
const sendingNow = new Set();
async function sendDirectEmail(id, actor = null, opts = {}) {
    if (sendingNow.has(String(id))) throw new Error('This email is already being sent.');
    sendingNow.add(String(id));
    try { return await sendDirectEmailOnce(id, actor, opts); } finally { sendingNow.delete(String(id)); }
}

// Phase 5 (HOUSEKEEPING-NOTES.md): relocated from app.js verbatim. app.js still exports this
// (re-imported from here) alongside loadPendingScheduledJobs, since server.js calls both directly
// from its own app.listen() callback.
function loadPendingDirectEmails() {
    db.all(
        "SELECT * FROM direct_emails WHERE status = 'scheduled'",
        (err, rows) => {
            if (err) return console.error('Failed to load scheduled direct emails:', err);
            rows.forEach(row => {
                const rawDt = row.scheduled_at;
                const fireDate = new Date(rawDt.includes('T') ? rawDt : rawDt.replace(' ', 'T') + 'Z');
                if (isNaN(fireDate.getTime()) || fireDate <= new Date()) {
                    sendDirectEmail(row.id).catch(e => console.error('Error sending immediate/expired direct email:', e.message));
                } else {
                    scheduleDirectEmailSend(row);
                }
            });
        }
    );
}

module.exports = { scheduleDirectEmailSend, sendDirectEmail, loadPendingDirectEmails, withReference };
