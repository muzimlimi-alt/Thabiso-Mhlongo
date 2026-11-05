// The admin-editable homepage content, read in ONE place for both readers:
//   - the public API (routes/public/site-content.js: /api/public/site-content, /manager, /contact_info, /about-me), which the homepage
//     script (js/myscript.js) still calls after load, and
//   - the server-side fill (lib/homepage-render.js), which writes the same values into index.html before it is sent, so a visitor never
//     sees the file's built-in text or a hidden section first and then watch it change.
// Same data, same shape: the two can never disagree.
const db = require('../database');
const { getSettingsByKeys } = require('../database/repositories/settings.repository');
const { unescapeHtml, SECTION_KEYS } = require('./html-sanitize');

// Stored as key-value rows in `settings`. hero_subtitle + services_heading may contain simple admin-authored HTML (e.g. <em>) and are
// sanitised when saved; eyebrow + card fields are plain text. Values fall back to the static index.html when unset.
const SITE_CONTENT_KEYS = ['announcement_text', 'announcement_enabled', 'announcement_rotate', 'announcement_speed', 'hero_tagline', 'hero_subtitle', 'services_eyebrow', 'services_heading', 'services_items', 'features_items', 'section_visibility'];

function getSiteContent() {
    return new Promise((resolve, reject) => {
        getSettingsByKeys(SITE_CONTENT_KEYS, (err, rows) => {
            if (err) return reject(err);
            const map = {};
            (rows || []).forEach((r) => { map[r.setting_key] = r.setting_value; });
            let items = [], features = [], sectionVis = {};
            try { items = map.services_items ? JSON.parse(map.services_items) : []; } catch (e) { items = []; }
            try { features = map.features_items ? JSON.parse(map.features_items) : []; } catch (e) { features = []; }
            try { sectionVis = map.section_visibility ? JSON.parse(map.section_visibility) : {}; } catch (e) { sectionVis = {}; }
            // Resolve to an explicit map: every known section defaults to visible unless stored false.
            const sections = {};
            SECTION_KEYS.forEach((k) => { sections[k] = sectionVis[k] !== false; });
            resolve({
                success: true,
                announcement: { text: map.announcement_text || '', enabled: map.announcement_enabled !== '0', rotate: map.announcement_rotate !== '0', speed: Math.min(10, Math.max(1, parseInt(map.announcement_speed, 10) || 5)) },
                hero_tagline: map.hero_tagline || '',
                hero_subtitle: map.hero_subtitle || '',
                services: {
                    eyebrow: map.services_eyebrow || '',
                    heading: map.services_heading || '',
                    items: Array.isArray(items) ? items : []
                },
                features: { items: Array.isArray(features) ? features : [] },
                sections: sections
            });
        });
    });
}

function getManager() {
    return new Promise((resolve, reject) => {
        db.get('SELECT * FROM manager_details ORDER BY manager_id ASC LIMIT 1', [], (err, row) => (err ? reject(err) : resolve(row || null)));
    });
}

function getContactInfo() {
    return new Promise((resolve, reject) => {
        db.get('SELECT * FROM contact_info ORDER BY quote_id ASC LIMIT 1', [], (err, row) => (err ? reject(err) : resolve(row || { email: '', quote: '', signature: '' })));
    });
}

function getAboutMe() {
    return new Promise((resolve, reject) => {
        db.get('SELECT image_path, paragraph1, paragraph2, paragraph3 FROM about_me WHERE id = 1', (err, row) => {
            if (err) return reject(err);
            if (row) {
                row.paragraph1 = unescapeHtml(row.paragraph1);
                row.paragraph2 = unescapeHtml(row.paragraph2);
                row.paragraph3 = unescapeHtml(row.paragraph3);
            }
            resolve(row || { image_path: 'images/image-slider-1.jpg', paragraph1: '', paragraph2: '', paragraph3: '' });
        });
    });
}

module.exports = { SITE_CONTENT_KEYS, getSiteContent, getManager, getContactInfo, getAboutMe };
