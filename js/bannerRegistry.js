/**
 * Thabiso Mhlongo — Email Banner Registry Resolver (Prompt 5)
 * =============================================================
 * Looks up the active banner assigned to a lifecycle email's template_key and
 * returns it in the shape js/emailComponents.js's bannerSlot()/renderPremiumEmail()
 * already accept. Returns null when unassigned/archived/missing — the caller's
 * existing hardcoded headline fallback takes over unchanged (bannerSlot degrades
 * gracefully by design).
 *
 * Independent of:
 *  - js/emailAssets.js (the single global CID banner used only by the legacy,
 *    currently-disabled createEmailWrapper path)
 *  - direct_emails.selected_banner_url (the separate "Direct Emails" composer)
 */
'use strict';

const db = require('../database');

// Per-template_key cache (60s TTL, mirrors server.js's getEmailFooterContext pattern).
const _cache = new Map(); // template_key -> { at, value }
const TTL_MS = 60000;

function emailBaseUrl() {
    return (process.env.BASE_URL || process.env.SITE_URL || 'https://www.thabisomhlongo.com').replace(/\/$/, '');
}

/**
 * @param {string} templateKey
 * @returns {Promise<{src:string, alt:string, headline:string|null, subtitle:string|null}|null>}
 */
async function resolveBanner(templateKey) {
    const cached = _cache.get(templateKey);
    if (cached && Date.now() - cached.at < TTL_MS) return cached.value;

    const value = await new Promise((resolve) => {
        db.get(
            `SELECT b.image_url, b.alt_text, b.headline, b.subtitle
             FROM email_template_banners etb
             JOIN banners b ON b.id = etb.banner_id
             WHERE etb.template_key = ? AND b.status = 'active'`,
            [templateKey],
            (err, row) => {
                if (err || !row) return resolve(null);
                resolve({
                    src: `${emailBaseUrl()}${row.image_url}`,
                    alt: row.alt_text,
                    headline: row.headline || null,
                    subtitle: row.subtitle || null
                });
            }
        );
    });

    _cache.set(templateKey, { at: Date.now(), value });
    return value;
}

/** Invalidate the cache immediately after a create/update/assign/archive write. */
function invalidateCache(templateKey) {
    if (templateKey) _cache.delete(templateKey);
    else _cache.clear();
}

module.exports = { resolveBanner, invalidateCache, emailBaseUrl };
