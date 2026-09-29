// Website Sections switch (Settings → Website Sections) — the one server-side reader of the
// `section_visibility` setting, shared by every content module that has to tell the admin "this
// whole section is switched off" (lib/team.js, lib/accolades.js). The map itself is written by the
// admin site-content route and read by the public page through GET /api/public/site-content; a key
// that is absent or true means visible, only an explicit false hides the section.
const { getSettingsByKeys } = require('../database/repositories/settings.repository');

async function isPublicSectionVisible(key) {
    const rows = await new Promise((resolve, reject) =>
        getSettingsByKeys(['section_visibility'], (err, r) => (err ? reject(err) : resolve(r || []))));
    let vis = {};
    try { vis = rows[0] && rows[0].setting_value ? JSON.parse(rows[0].setting_value) : {}; } catch (e) { vis = {}; }
    return vis[key] !== false;
}

module.exports = { isPublicSectionVisible };
