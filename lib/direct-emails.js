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
const path = require('path');
const schedule = require('node-schedule');
const db = require('../database');
const bannerRegistry = require('../js/bannerRegistry');
const emailComponents = require('../js/emailComponents');
const { sendEmail } = require('../js/emailService');
const { getEmailFooterContext } = require('./email-context');
const { PROJECT_ROOT } = require('./runtime-paths');
const { scheduledJobs } = require('./newsletter-scheduling');
const { markInquiryReplied } = require('../database/repositories/inquiries.repository');

function scheduleDirectEmailSend(emailItem) {
    const rawDt = emailItem.scheduled_at;
    if (!rawDt) return;
    const fireDate = new Date(rawDt.includes('T') ? rawDt : rawDt.replace(' ', 'T') + 'Z');
    if (isNaN(fireDate.getTime())) return;

    if (fireDate <= new Date()) {
        // past date, send immediately
        sendDirectEmail(emailItem.id);
        return;
    }

    const jobKey = `direct_${emailItem.id}`;
    if (scheduledJobs[jobKey]) {
        scheduledJobs[jobKey].cancel();
    }

    scheduledJobs[jobKey] = schedule.scheduleJob(fireDate, function() {
        sendDirectEmail(emailItem.id);
    });
}

async function sendDirectEmail(id) {
    return new Promise((resolve, reject) => {
        db.get("SELECT * FROM direct_emails WHERE id = ?", [id], async (err, emailItem) => {
            if (err) return reject(err);
            if (!emailItem) return reject(new Error('Email item not found'));
            if (emailItem.status === 'sent') return resolve();

            let toList = [];
            try { toList = JSON.parse(emailItem.to_emails || '[]'); } catch(e) { toList = [emailItem.to_emails]; }
            let ccList = [];
            try { ccList = JSON.parse(emailItem.cc_emails || '[]'); } catch(e) { ccList = []; }
            let bccList = [];
            try { bccList = JSON.parse(emailItem.bcc_emails || '[]'); } catch(e) { bccList = []; }

            const to = toList.join(', ');
            const cc = ccList.length ? ccList.join(', ') : null;
            const bcc = bccList.length ? bccList.join(', ') : null;

            let attachments = [];
            if (emailItem.attachment_paths) {
                try {
                    const paths = JSON.parse(emailItem.attachment_paths);
                    paths.forEach(p => {
                        if (p && p.path) {
                            const resolvedPath = path.isAbsolute(p.path) ? p.path : path.join(PROJECT_ROOT, p.path);
                            attachments.push({ filename: p.filename || path.basename(p.path), path: resolvedPath });
                        }
                    });
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

                const result = await sendEmail({
                    to,
                    subject: emailItem.subject || 'Message from Thabiso Mhlongo Management',
                    htmlContent: html,
                    preWrapped: true,
                    replyTo: emailItem.reply_to || process.env.EMAIL_USER || 'admin@thabisomhlongo.com',
                    cc,
                    bcc,
                    attachments,
                    trigger_event: emailItem.inquiry_id ? 'Admin: Inquiry Reply' : 'Admin: Direct Compose',
                    related_entity: emailItem.inquiry_id ? 'inquiries' : null,
                    related_id: emailItem.inquiry_id || null
                });

                if (result.success) {
                    db.run("UPDATE direct_emails SET status = 'sent', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [id], (updErr) => {
                        if (emailItem.inquiry_id) {
                            // responded_at only set once — first response, not every subsequent reply
                            markInquiryReplied(emailItem.inquiry_id);
                        }
                        resolve();
                    });
                } else {
                    db.run("UPDATE direct_emails SET status = 'failed', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [id], () => resolve());
                }
            } catch (error) {
                console.error(`Failed to send direct email #${id}:`, error);
                db.run("UPDATE direct_emails SET status = 'failed', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [id], () => reject(error));
            }

            const jobKey = `direct_${id}`;
            if (scheduledJobs[jobKey]) {
                delete scheduledJobs[jobKey];
            }
        });
    });
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

module.exports = { scheduleDirectEmailSend, sendDirectEmail, loadPendingDirectEmails };
