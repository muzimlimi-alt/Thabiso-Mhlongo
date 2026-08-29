// Newsletter birthday automation — Phase 5 of the housekeeping effort (HOUSEKEEPING-NOTES.md).
// Moved out of the app.js monolith byte-identical.
//
// birthdayJob MUST stay a singleton (same reasoning as scheduledJobs in
// lib/newsletter-scheduling.js and dbTxnQueue in lib/db-transaction.js): registerBirthdayJob()
// cancels whatever job is already registered before creating the new one, so two separate copies
// of this module would leave an uncancellable duplicate cron firing daily.
const moment = require('moment-timezone');
const schedule = require('node-schedule');
const db = require('../database');
const bannerRegistry = require('../js/bannerRegistry');
const emailComponents = require('../js/emailComponents');
const { sendEmail } = require('../js/emailService');
const { applyMergeFields } = require('../js/mergeFields');
const { getEmailFooterContext, emailBaseUrl } = require('./email-context');
const { sanitizeAboutHtml } = require('./html-sanitize');
const { getBirthdaySettings: repoGetBirthdaySettings } = require('../database/repositories/settings.repository');
const { getSubscribersWithBirthdayToday } = require('../database/repositories/newsletter.repository');

// Config + template copy live in the generic `settings` table (same store/pattern as
// PUT /api/admin/site-content), not a new table — see BIRTHDAY_SETTING_DEFAULTS below.
const BIRTHDAY_SETTING_DEFAULTS = {
    birthday_automation_enabled: '0',
    birthday_send_time: '09:00',
    birthday_test_mode: '0',
    birthday_test_recipient: '',
    birthday_email_subject: 'Happy Birthday, {{first_name}}!',
    birthday_email_heading: 'Happy Birthday, {{first_name}}!',
    birthday_email_body:
        '<p style="text-align:center;">Wishing you a wonderful day, {{first_name}}! Thank you for being part of the inner circle this past year.</p>',
    birthday_email_cta_label: '',
    birthday_email_cta_url: '',
    birthday_email_footer_note: ''
};
const BIRTHDAY_SETTING_KEYS = Object.keys(BIRTHDAY_SETTING_DEFAULTS);

// Merges the currently-edited (unsaved) form fields over the saved settings, so Preview/Send Test
// reflect what the admin is about to save, not just what was last saved — same reasoning as the
// newsletter Compose tab's own preview, which previews the unsaved Quill draft.
function mergeBirthdayOverrides(saved, body) {
    const merged = { ...saved };
    ['birthday_email_subject', 'birthday_email_heading', 'birthday_email_cta_label', 'birthday_email_cta_url'].forEach(k => {
        if (typeof body[k] === 'string') merged[k] = body[k].replace(/<[^>]*>/g, '').slice(0, k === 'birthday_email_cta_url' ? 500 : 200);
    });
    if (typeof body.birthday_email_body === 'string') merged.birthday_email_body = sanitizeAboutHtml(body.birthday_email_body).slice(0, 5000);
    if (typeof body.birthday_email_footer_note === 'string') merged.birthday_email_footer_note = sanitizeAboutHtml(body.birthday_email_footer_note).slice(0, 500);
    return merged;
}

function getBirthdaySettings() {
    return repoGetBirthdaySettings(BIRTHDAY_SETTING_KEYS, BIRTHDAY_SETTING_DEFAULTS);
}

// Shared render path for preview/send-test/the real sweep — mirrors the newsletter campaign
// send paths exactly (merge fields -> renderPremiumEmail -> resolved banner).
async function renderBirthdayEmail(settings, subscriber, unsubscribeUrl, baseUrlOverride) {
    const { socialLinks } = await getEmailFooterContext();
    const banner = await bannerRegistry.resolveBanner('subscriber_birthday', baseUrlOverride ? { baseUrlOverride } : undefined);
    const subject = applyMergeFields(settings.birthday_email_subject, subscriber, unsubscribeUrl);
    const heading = applyMergeFields(settings.birthday_email_heading, subscriber, unsubscribeUrl);
    const body = applyMergeFields(settings.birthday_email_body, subscriber, unsubscribeUrl);
    const footerNote = settings.birthday_email_footer_note
        ? `<p style="text-align:center; margin-top:18px; color:#707070; font-size:12px;">${applyMergeFields(settings.birthday_email_footer_note, subscriber, unsubscribeUrl)}</p>`
        : '';
    return emailComponents.renderPremiumEmail({
        preheaderText: subject,
        bannerSrc: banner?.src, bannerAlt: banner?.alt, subtitle: banner?.subtitle,
        headline: banner?.headline || heading,
        bodyHtml: body + footerNote,
        cta: settings.birthday_email_cta_label && settings.birthday_email_cta_url
            ? { label: settings.birthday_email_cta_label, url: settings.birthday_email_cta_url } : null,
        unsubscribeUrl,
        socialLinks
    });
}

// The daily sweep — matches today's day/month against subscribers, sends (or redirects to the
// test recipient in test mode), and dedupes on a per-subscriber-per-year basis via the existing
// email_logs table (no new log table). Exported so it can be invoked directly for testing without
// waiting for the real cron time.
async function runBirthdayAutomationSweep() {
    const settings = await getBirthdaySettings();
    if (settings.birthday_automation_enabled !== '1') return;

    const today = moment().tz('Africa/Johannesburg');
    const day = today.date(), month = today.month() + 1;
    console.log(`[Birthday Automation] Sweeping for birthdays on ${month}/${day}...`);

    const subscribers = await new Promise((resolve, reject) => {
        getSubscribersWithBirthdayToday(day, month, (err, rows) => err ? reject(err) : resolve(rows || []));
    });
    if (!subscribers.length) { console.log('[Birthday Automation] No birthdays today.'); return; }

    let sent = 0, skipped = 0;
    for (const sub of subscribers) {
        try {
            const alreadySent = await new Promise((resolve, reject) => {
                db.get(
                    `SELECT 1 FROM email_logs WHERE recipient_email = ? AND trigger_event = 'Newsletter: Birthday'
                     AND strftime('%Y', sent_at) = strftime('%Y', 'now') LIMIT 1`,
                    [sub.email], (err, row) => err ? reject(err) : resolve(!!row)
                );
            });
            if (alreadySent) { skipped++; continue; }

            const recipientEmail = settings.birthday_test_mode === '1' ? settings.birthday_test_recipient : sub.email;
            if (!recipientEmail) { skipped++; continue; }

            const unsubscribeUrl = sub.unsubscribe_token
                ? `${emailBaseUrl()}/unsubscribe.html?token=${sub.unsubscribe_token}&email=${encodeURIComponent(sub.email)}`
                : `${emailBaseUrl()}/unsubscribe.html`;
            const html = await renderBirthdayEmail(settings, sub, unsubscribeUrl);
            const subject = applyMergeFields(settings.birthday_email_subject, sub, unsubscribeUrl);
            await sendEmail({
                to: recipientEmail,
                subject,
                htmlContent: html,
                preWrapped: true,
                titleOverride: subject,
                trigger_event: settings.birthday_test_mode === '1' ? 'Newsletter: Birthday Test' : 'Newsletter: Birthday'
            });
            sent++;
        } catch (e) {
            console.error(`[Birthday Automation] Failed for ${sub.email}:`, e.message);
        }
        await new Promise(r => setTimeout(r, 200));
    }
    console.log(`[Birthday Automation] Done. Sent: ${sent}, skipped (already sent this year / no recipient): ${skipped}.`);
}

// Registers (or re-registers) the one persistent daily job from the current birthday_send_time
// setting. Deliberately not run-once-at-boot (unlike the overdue sweep) — a redeploy mid-day must
// not trigger an unexpected birthday blast.
let birthdayJob = null; // the one persistent, runtime-reconfigurable daily birthday-automation job
function registerBirthdayJob() {
    if (birthdayJob) { birthdayJob.cancel(); birthdayJob = null; }
    getBirthdaySettings().then(settings => {
        const [hour, minute] = settings.birthday_send_time.split(':').map(Number);
        birthdayJob = schedule.scheduleJob(`${minute} ${hour} * * *`, () => {
            runBirthdayAutomationSweep().catch(e => console.error('[Birthday Automation] Sweep error:', e.message));
        });
    }).catch(e => console.error('[Birthday Automation] Could not register job:', e.message));
}

module.exports = {
    BIRTHDAY_SETTING_DEFAULTS, BIRTHDAY_SETTING_KEYS,
    mergeBirthdayOverrides, getBirthdaySettings, renderBirthdayEmail,
    runBirthdayAutomationSweep, registerBirthdayJob,
};
