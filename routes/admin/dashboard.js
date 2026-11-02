const express = require('express');
const db = require('../../database');
const { requireAdmin } = require('../../middleware/auth');
const { requireRole } = require('../../middleware/rbac');
const { getSettingVal, upsertSetting } = require('../../database/repositories/settings.repository');
const router = express.Router();

// =============================================
// getSettingVal(key) — helper to retrieve a setting value dynamically — now lives in
// database/repositories/settings.repository.js (Phase 4, HOUSEKEEPING-NOTES.md).

router.get('/api/admin/dashboard/social_kpis', requireAdmin, (req, res) => {
    db.all("SELECT * FROM social_kpi_stats ORDER BY id ASC", [], async (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        
        let needsDbUpdate = false;
        const now = new Date();
        const updatedRows = [];

        for (const row of rows) {
            // Cache timeout is 1 hour
            const lastUpdated = new Date(row.last_updated);
            const isStale = (now - lastUpdated) > 60 * 60 * 1000;
            
            if (row.manual_override === 0 && isStale) {
                let liveFollowers = null;
                let liveLikes = null;
                
                try {
                    if (row.platform_name === 'YouTube') {
                        const ytApiKey = await getSettingVal('youtube_api_key') || process.env.YOUTUBE_API_KEY;
                        const ytChannelId = await getSettingVal('youtube_channel_id') || process.env.YOUTUBE_CHANNEL_ID;
                        if (ytApiKey && ytChannelId) {
                            const ytUrl = `https://www.googleapis.com/youtube/v3/channels?part=statistics&id=${ytChannelId}&key=${ytApiKey}`;
                            const apiRes = await fetch(ytUrl);
                            if (apiRes.ok) {
                                const data = await apiRes.json();
                                if (data.items && data.items.length > 0) {
                                    liveFollowers = parseInt(data.items[0].statistics.subscriberCount) || null;
                                    liveLikes = parseInt(data.items[0].statistics.viewCount) || null;
                                }
                            }
                        }
                    } else if (row.platform_name === 'Facebook') {
                        const fbAccessToken = await getSettingVal('facebook_page_access_token') || process.env.FACEBOOK_PAGE_ACCESS_TOKEN;
                        const fbPageId = await getSettingVal('facebook_page_id') || process.env.FACEBOOK_PAGE_ID;
                        if (fbAccessToken && fbPageId) {
                            const fbUrl = `https://graph.facebook.com/v19.0/${fbPageId}?fields=fan_count,talking_about_count&access_token=${fbAccessToken}`;
                            const apiRes = await fetch(fbUrl);
                            if (apiRes.ok) {
                                const data = await apiRes.json();
                                liveFollowers = data.fan_count || null;
                                liveLikes = data.fan_count || null;
                            }
                        }
                    } else if (row.platform_name === 'Instagram') {
                        const igAccessToken = await getSettingVal('instagram_access_token') || process.env.INSTAGRAM_ACCESS_TOKEN;
                        const igUserId = await getSettingVal('instagram_user_id') || process.env.INSTAGRAM_USER_ID;
                        if (igAccessToken && igUserId) {
                            const igUrl = `https://graph.facebook.com/v19.0/${igUserId}?fields=followers_count,media_count&access_token=${igAccessToken}`;
                            const apiRes = await fetch(igUrl);
                            if (apiRes.ok) {
                                const data = await apiRes.json();
                                liveFollowers = data.followers_count || null;
                                liveLikes = data.media_count || null;
                            }
                        }
                    } else if (row.platform_name === 'X (Twitter)') {
                        const twBearerToken = await getSettingVal('twitter_bearer_token') || process.env.TWITTER_BEARER_TOKEN;
                        const twUsername = await getSettingVal('twitter_username') || process.env.TWITTER_USERNAME;
                        if (twBearerToken && twUsername) {
                            const twUrl = `https://api.twitter.com/2/users/by/username/${twUsername}?user.fields=public_metrics`;
                            const apiRes = await fetch(twUrl, {
                                headers: {
                                    'Authorization': `Bearer ${twBearerToken}`
                                }
                            });
                            if (apiRes.ok) {
                                const data = await apiRes.json();
                                if (data.data && data.data.public_metrics) {
                                    liveFollowers = data.data.public_metrics.followers_count || null;
                                    liveLikes = data.data.public_metrics.tweet_count || null;
                                }
                            }
                        }
                    } else if (row.platform_name === 'TikTok') {
                        const ttAccessToken = await getSettingVal('tiktok_access_token') || process.env.TIKTOK_ACCESS_TOKEN;
                        if (ttAccessToken) {
                            const ttUrl = `https://open.tiktokapis.com/v2/user/info/?fields=follower_count,likes_count`;
                            const apiRes = await fetch(ttUrl, {
                                headers: {
                                    'Authorization': `Bearer ${ttAccessToken}`
                                }
                            });
                            if (apiRes.ok) {
                                const data = await apiRes.json();
                                if (data.data && data.data.user) {
                                    liveFollowers = data.data.user.follower_count || null;
                                    liveLikes = data.data.user.likes_count || null;
                                }
                            }
                        }
                    }
                } catch (e) {
                    console.error(`Failed to fetch live stats for ${row.platform_name}:`, e.message);
                }

                if (liveFollowers !== null) {
                    needsDbUpdate = true;
                    row.follower_count = liveFollowers;
                    if (liveLikes !== null) row.like_count = liveLikes;
                    row.last_updated = now.toISOString();
                    
                    // Run update to DB
                    db.run(
                        "UPDATE social_kpi_stats SET follower_count = ?, like_count = ?, last_updated = CURRENT_TIMESTAMP WHERE id = ?",
                        [row.follower_count, row.like_count, row.id]
                    );
                }
            }
            updatedRows.push(row);
        }

        const credentials = {
            youtube_api_key: await getSettingVal('youtube_api_key') || '',
            youtube_channel_id: await getSettingVal('youtube_channel_id') || '',
            facebook_page_access_token: await getSettingVal('facebook_page_access_token') || '',
            facebook_page_id: await getSettingVal('facebook_page_id') || '',
            instagram_access_token: await getSettingVal('instagram_access_token') || '',
            instagram_user_id: await getSettingVal('instagram_user_id') || '',
            twitter_bearer_token: await getSettingVal('twitter_bearer_token') || '',
            twitter_username: await getSettingVal('twitter_username') || '',
            tiktok_access_token: await getSettingVal('tiktok_access_token') || ''
        };

        res.json({ success: true, kpis: updatedRows, credentials: credentials });
    });
});

router.post('/api/admin/dashboard/social_kpis', requireAdmin, requireRole(['administrator', 'manager']), (req, res) => {
    const { platform_name, follower_count, like_count, trend_percentage, trend_direction, manual_override, goal_target } = req.body;

    if (!platform_name) {
        return res.status(400).json({ success: false, message: 'Platform name is required.' });
    }

    db.get("SELECT * FROM social_kpi_stats WHERE platform_name = ?", [platform_name], (err, row) => {
        if (err || !row) return res.status(404).json({ success: false, message: 'Platform stats not found.' });

        const updatedFollowers = follower_count !== undefined ? parseInt(follower_count) : row.follower_count;
        const updatedLikes = like_count !== undefined ? parseInt(like_count) : row.like_count;
        const updatedTrendPct = trend_percentage !== undefined ? parseFloat(trend_percentage) : row.trend_percentage;
        const updatedTrendDir = trend_direction !== undefined ? trend_direction : row.trend_direction;
        const updatedOverride = manual_override !== undefined ? (manual_override ? 1 : 0) : row.manual_override;
        const updatedGoal = goal_target !== undefined ? (parseInt(goal_target) || 0) : row.goal_target;

        db.run(
            `UPDATE social_kpi_stats
             SET follower_count = ?,
                 like_count = ?,
                 trend_percentage = ?,
                 trend_direction = ?,
                 manual_override = ?,
                 goal_target = ?,
                 last_updated = CURRENT_TIMESTAMP
             WHERE platform_name = ?`,
            [updatedFollowers, updatedLikes, updatedTrendPct, updatedTrendDir, updatedOverride, updatedGoal, platform_name],
            function(updateErr) {
                if (updateErr) return res.status(500).json({ success: false, error: updateErr.message });
                res.json({ success: true, message: `Social media stats updated for ${platform_name}.` });
            }
        );
    });
});

// Per-account dashboard preferences: what ONE administrator chose for THEIR dashboard, remembered on the server (the settings table, one key per
// account) so it follows the account to any browser or device. Today: whether the Social Media Channels cards show (default: shown).
// A choice made before this existed was saved for everyone (dashboard_show_social_cards); it is used until the account makes its own.
const prefKey = (adminId) => `dashboard_pref_${Number(adminId)}_social_cards`;
router.get('/api/admin/dashboard/preferences', requireAdmin, async (req, res) => {
    try {
        const own = await getSettingVal(prefKey(req.session.adminId));
        const legacy = own === null || own === undefined ? await getSettingVal('dashboard_show_social_cards') : null;
        const v = own !== null && own !== undefined ? own : legacy;
        res.set('Cache-Control', 'no-store');
        res.json({ success: true, preferences: { social_cards: String(v === null || v === undefined ? '1' : v) !== '0' } });
    } catch (e) { res.status(500).json({ success: false, message: 'Could not load your dashboard preferences.' }); }
});
router.put('/api/admin/dashboard/preferences', requireAdmin, (req, res) => {
    const b = req.body || {};
    if (typeof b.social_cards !== 'boolean') return res.status(400).json({ success: false, message: 'social_cards must be true or false.' });
    upsertSetting(prefKey(req.session.adminId), b.social_cards ? '1' : '0', (err) => {
        if (err) return res.status(500).json({ success: false, message: 'Could not save your dashboard preference.' });
        res.json({ success: true, preferences: { social_cards: b.social_cards } });
    });
});

// The admin's look (Finish / House accent / Presence, js/appearance.js), per account like the preference above. The browser keeps a copy in
// localStorage so the page paints right away; this is the copy that follows the account to another machine. Values are checked against the
// same lists the page uses. GET gives { appearance: null } until the account has chosen.
const APPEARANCE = { theme: ['dark', 'light', 'ember'], accent: ['gold', 'vetiver', 'cassis', 'cuivre'], presence: ['editorial', 'boutique', 'operations'] };
const appearanceKey = (adminId) => `admin_pref_${Number(adminId)}_appearance`;
router.get('/api/admin/preferences/appearance', requireAdmin, async (req, res) => {
    try {
        const raw = await getSettingVal(appearanceKey(req.session.adminId));
        let a = null;
        try { a = raw ? JSON.parse(raw) : null; } catch (e) { a = null; }
        if (a && !Object.keys(APPEARANCE).every(k => APPEARANCE[k].includes(a[k]))) a = null;
        res.set('Cache-Control', 'no-store');
        res.json({ success: true, appearance: a });
    } catch (e) { res.status(500).json({ success: false, message: 'Could not load your appearance.' }); }
});
router.put('/api/admin/preferences/appearance', requireAdmin, (req, res) => {
    const b = req.body || {};
    if (!Object.keys(APPEARANCE).every(k => APPEARANCE[k].includes(b[k]))) return res.status(400).json({ success: false, message: 'Unknown appearance value.' });
    const clean = { theme: b.theme, accent: b.accent, presence: b.presence };
    upsertSetting(appearanceKey(req.session.adminId), JSON.stringify(clean), (err) => {
        if (err) return res.status(500).json({ success: false, message: 'Could not save your appearance.' });
        res.json({ success: true, appearance: clean });
    });
});

module.exports = router;
