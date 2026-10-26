// The homepage "What I do" cards. Since the 2026 rate card they follow its five categories (lib/service-pricing.js GROUPS) and,
// like the rest of the public site, say nothing about prices - a client first sees an amount in the quotation.
//
// They live in the `services_items` setting (the admin edits them under About Me > Homepage content). Three places hold the same
// default text and must agree: this file (seed + migration), index.html (what shows before the setting loads) and
// js/admin/about.js (an empty editor); test/homepage-services.test.js checks all three.

// The four cards the site shipped with before the rate card. Kept ONLY so the one-time migration can recognise a setting that was
// never edited (byte-for-byte equal) and replace it; an owner-edited set is left exactly as they wrote it.
const OLD_DEFAULT_CARDS = [
    { title: 'Stand-Up', description: 'Solo sets, festivals & comedy nights', image: '' },
    { title: 'MC & Host', description: 'Galas, weddings & corporate events', image: '' },
    { title: 'TV, Podcast & Film', description: 'Acting, presenting & writing', image: '' },
    { title: 'Voice-Over', description: 'Radio & TV ads', image: '' }
];

// One card per rate-card category, in the rate card's order.
const NEW_DEFAULT_CARDS = [
    { title: 'Club & Theatre', description: 'Guest spots, support sets, headline shows & club nights', image: '' },
    { title: 'Corporate & Events', description: 'Comedic performances & MC duties for conferences, galas & corporate days', image: '' },
    { title: 'Private Functions, Weddings & Year-End Events', description: 'MC, performance & hosting for private celebrations', image: '' },
    { title: 'Writing & Creative Services', description: 'Copywriting, joke & roast writing, scripts and script editing', image: '' },
    { title: 'Acting, Voice-Over & Brand Campaigns', description: 'Screen acting, voice-over & brand content campaigns', image: '' }
];

// The one-time migration (schema_migrations version 107), run from database.js at the end of init. The stored cards are replaced ONLY
// while they are still byte-for-byte the four shipped cards - cards an owner has edited are never overwritten - and only once (the
// marker row), so a deliberate later edit back to the old text is not undone at the next start. One conditional UPDATE: no
// read-modify-write window. Exported as SQL so the test runs this exact statement against a throwaway database.
const MIGRATION_VERSION = 107;
const MIGRATION_NAME = 'homepage_service_cards_2026';
const UPDATE_SQL = `UPDATE settings SET setting_value = ? WHERE setting_key = 'services_items' AND setting_value = ?
                    AND NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = ${MIGRATION_VERSION})`;
const updateParams = () => [JSON.stringify(NEW_DEFAULT_CARDS), JSON.stringify(OLD_DEFAULT_CARDS)];
const MARKER_SQL = `INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (${MIGRATION_VERSION}, '${MIGRATION_NAME}')`;

module.exports = { OLD_DEFAULT_CARDS, NEW_DEFAULT_CARDS, MIGRATION_VERSION, MIGRATION_NAME, UPDATE_SQL, updateParams, MARKER_SQL };
