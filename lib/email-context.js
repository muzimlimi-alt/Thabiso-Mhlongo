// Shared email-sending context — Phase 5 of the housekeeping effort (HOUSEKEEPING-NOTES.md). Moved
// out of the app.js monolith byte-identical. Used by nearly every email-composing function in the
// app (getEmailFooterContext alone at ~44 call sites), not just newsletter ones.
const db = require('../database');

// ── Prompt 3 email rebuild: shared footer context ──
// Rebuilt PREMIUM emails render their own full shell (js/emailComponents.js) and are queued
// with preWrapped:true, so they resolve their own footer social links here rather than via the
// central createEmailWrapper path. Cached briefly (emails are low-frequency).
let _emailFooterCache = { at: 0, socialLinks: [] };
async function getEmailFooterContext() {
    if (Date.now() - _emailFooterCache.at < 60000) return { socialLinks: _emailFooterCache.socialLinks };
    const socialLinks = await new Promise((resolve) => {
        db.all("SELECT platform_name, platform_url FROM social_links WHERE is_active = 1 ORDER BY display_order ASC",
            [], (err, rows) => resolve(err ? [] : (rows || [])));
    });
    _emailFooterCache = { at: Date.now(), socialLinks };
    return { socialLinks };
}

// Base tracking/portal URL used by client email CTAs (matches the existing link defaults).
function emailBaseUrl() {
    return (process.env.BASE_URL || process.env.SITE_URL || 'https://www.thabisomhlongo.com').replace(/\/$/, '');
}

module.exports = { getEmailFooterContext, emailBaseUrl };
