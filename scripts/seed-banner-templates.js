#!/usr/bin/env node
/*
 * One-time email_template_banners seed (Prompt 5). IDEMPOTENT — safe to re-run.
 *
 * The banner registry pack assumes an existing "email template" row to attach banner_id to, but no
 * such table existed before this work. This seeds one row per already-rebuilt PREMIUM email
 * (js/emailComponents.js's renderPremiumEmail call sites, Prompts 3-4), keyed by a hand-defined stable
 * template_key, with banner_id left NULL. Unassigned/NULL is not a placeholder state — bannerSlot()
 * already renders its existing hardcoded text-headline fallback for a NULL banner, so seeding these
 * rows changes nothing about how emails render until an admin explicitly assigns a banner via
 * PUT /api/admin/email-templates/assign.
 *
 * Usage:
 *   node scripts/seed-banner-templates.js            # dry run — reports only
 *   node scripts/seed-banner-templates.js --apply    # insert missing rows (additive, INSERT OR IGNORE)
 *
 * Always back up database.sqlite before --apply.
 */
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3');
const DB = path.resolve(__dirname, '..', 'database.sqlite');
const APPLY = process.argv.includes('--apply');

const db = new sqlite3.Database(DB);
const all = (sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => e ? rej(e) : res(r)));
const run = (sql, p = []) => new Promise((res, rej) => db.run(sql, p, function (e) { e ? rej(e) : res(this); }));

// template_key -> category. One entry per renderPremiumEmail call site across Prompt 3 Batches 1-6.
// contract_sign_reminder and newsletter_campaign each cover 2 call sites that share one template.
// booking_cancelled and booking_date_changed (sendCancellationEmail / sendDateChangedEmail, both
// Batch 2) were missing from the original Prompt 5 plan's map — audit gap closed while wiring Batch A.
const TEMPLATE_MAP = {
    booking_received_client: 'Booking Requests',
    booking_under_review: 'Booking Requests',
    pending_expired: 'Booking Requests',

    booking_cancelled: 'Booking Confirmations',
    booking_date_changed: 'Booking Confirmations',

    quote: 'Quotes & Proposals',
    quote_accepted: 'Quotes & Proposals',
    quote_expired: 'Quotes & Proposals',
    quote_expiry_warning: 'Quotes & Proposals',
    quote_still_open: 'Quotes & Proposals',
    custom_response: 'Quotes & Proposals',

    contract_sent: 'Contracts & Signatures',
    contract_sign_reminder: 'Contracts & Signatures',

    invoice: 'Payments & Invoices',
    invoice_pre_due: 'Payments & Invoices',
    invoice_overdue: 'Payments & Invoices',
    payment_received: 'Payments & Invoices',
    deposit_balance_due: 'Payments & Invoices',
    payment_failed: 'Payments & Invoices',
    refund_processed: 'Payments & Invoices',
    schedule_payment_reminder: 'Payments & Invoices',
    balance_payment_reminder: 'Payments & Invoices',

    booking_confirmed: 'Booking Confirmations',

    booking_completed: 'Thank You & Reviews',
    review_request: 'Thank You & Reviews',

    abandoned_booking_recovery: 'Booking Recovery',

    contact_auto_reply: 'Contact & Support',
    inquiry_reply: 'Contact & Support',
    direct_compose: 'Contact & Support',
    booking_management_response: 'Contact & Support',

    newsletter_welcome: 'Newsletters & Marketing',
    newsletter_campaign: 'Newsletters & Marketing',

    dashboard_invite: 'User Accounts & Security',
    password_reset: 'User Accounts & Security'
};

(async () => {
    const existing = await all(`SELECT template_key FROM email_template_banners`);
    const existingKeys = new Set(existing.map(r => r.template_key));
    const keys = Object.keys(TEMPLATE_MAP);
    const missing = keys.filter(k => !existingKeys.has(k));

    console.log(`template_key rows expected : ${keys.length}`);
    console.log(`already seeded             : ${keys.length - missing.length}`);
    console.log(`missing                    : ${missing.length}`);

    if (!APPLY) {
        console.log('\nDry run. Re-run with --apply to insert the missing rows.');
        process.exit(0);
    }

    let inserted = 0;
    for (const key of missing) {
        const result = await run(
            `INSERT OR IGNORE INTO email_template_banners (template_key, category) VALUES (?, ?)`,
            [key, TEMPLATE_MAP[key]]);
        if (result.changes > 0) inserted++;
    }
    console.log(`\ninserted ${inserted} email_template_banners row(s).`);

    const notesPath = path.resolve(__dirname, '..', 'docs', 'banner-migration-notes.md');
    const grouped = {};
    for (const [key, category] of Object.entries(TEMPLATE_MAP)) {
        (grouped[category] = grouped[category] || []).push(key);
    }
    const categoryOrder = [
        'Booking Requests', 'Quotes & Proposals', 'Contracts & Signatures', 'Payments & Invoices',
        'Booking Confirmations', 'Event Reminders', 'Thank You & Reviews', 'Booking Recovery',
        'Contact & Support', 'Newsletters & Marketing', 'User Accounts & Security'
    ];
    let notes = `# Banner Registry — Migration Notes\n\n`;
    notes += `Generated by \`scripts/seed-banner-templates.js\`. Run: ${new Date().toISOString()}\n\n`;
    notes += `## No prior per-template banner data exists\n\n`;
    notes += `Before this migration, no per-email-template banner concept existed. The only banner in the ` +
        `codebase is a single **global** image (\`js/emailAssets.js\` → \`images/banner/banner_4_centerstage1.png\`, ` +
        `CID-attached), used exclusively by the legacy \`createEmailWrapper\` path, which is disabled by default ` +
        `(\`EMAIL_OVERHAUL_ENABLED\` unset) and never invoked by the rebuilt \`preWrapped\` emails this registry ` +
        `targets. That global image is untouched and remains fully independent of this table.\n\n`;
    notes += `This migration seeds one \`email_template_banners\` row per already-rebuilt PREMIUM email template, ` +
        `all with \`banner_id = NULL\`. \`bannerSlot()\` renders its existing hardcoded text-headline fallback for ` +
        `a NULL banner, so this seed changes nothing about how any email renders until an admin explicitly ` +
        `assigns a banner via \`PUT /api/admin/email-templates/assign\`.\n\n`;
    notes += `## Seeded template_key → category map\n\n`;
    for (const category of categoryOrder) {
        const list = grouped[category];
        notes += `### ${category}\n\n`;
        if (list && list.length) {
            for (const key of list) notes += `- \`${key}\`\n`;
        } else {
            notes += `_No template seeded yet — category reserved for future use._\n`;
        }
        notes += `\n`;
    }
    fs.writeFileSync(notesPath, notes);
    console.log(`wrote ${notesPath}`);

    const total = (await all(`SELECT COUNT(*) c FROM email_template_banners`))[0].c;
    console.log(`\nemail_template_banners now has ${total} row(s) (expect ${keys.length}).`);
    process.exit(0);
})().catch(e => { console.error('seed failed:', e.message); process.exit(1); });
