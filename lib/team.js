// Management Team — the single source of truth for WHO is on the website, in WHAT ORDER, and with
// WHICH FIELDS.
//
// Both APIs go through this module:
//   GET /api/public/team  (routes/public/site-content.js)  -> listPublicMembers()
//   GET /api/admin/team   (routes/admin/team.js)           -> getAdminTeamView()
// and both pages render the result with the same view code (js/team-view.js), so the admin can
// never show, order or describe the team differently from the public site. Anything that decides
// visibility, ordering or the published field list lives here and nowhere else.
const db = require('../database');
const { isPublicSectionVisible } = require('./section-visibility');

const TEAM_STATUSES = ['active', 'inactive'];
const TEAM_ORDER_BY = 'display_order ASC, id ASC';
// SQL twin of isPubliclyVisible() below — keep the two in step. A NULL status means "active"
// (the column default), so it is public on both sides.
const PUBLIC_WHERE = "COALESCE(status, 'active') = 'active'";

// Fields published on the website. Everything else on the row (email, phone, created_by,
// updated_by, timestamps, status, display_order) is internal and never leaves the server through
// the public API. To publish another field, add it here — nothing else needs to change.
const PUBLIC_FIELDS = ['id', 'name', 'role', 'biography', 'image_path', 'website', 'twitter', 'linkedin', 'instagram', 'behance', 'featured'];
const LINK_FIELDS = ['website', 'twitter', 'linkedin', 'instagram', 'behance'];
const BIO_MAX = 600;

function isPubliclyVisible(row) {
    const status = row && row.status != null ? row.status : 'active';
    return status === 'active';
}

// Links are rendered into href attributes — only plain http(s) URLs are ever published.
function safeUrl(value) {
    if (typeof value !== 'string') return null;
    const s = value.trim();
    return /^https?:\/\/\S+$/i.test(s) ? s : null;
}

function toPublicMember(row) {
    const out = {};
    PUBLIC_FIELDS.forEach(k => { out[k] = row[k] === undefined ? null : row[k]; });
    LINK_FIELDS.forEach(k => { out[k] = safeUrl(out[k]); });
    out.featured = row.featured == 1 ? 1 : 0;
    return out;
}

function all(sql, params) {
    return new Promise((resolve, reject) => db.all(sql, params || [], (err, rows) => (err ? reject(err) : resolve(rows))));
}

// Exactly what the website shows, in the order it shows it.
async function listPublicMembers() {
    const rows = await all(`SELECT * FROM team_members WHERE ${PUBLIC_WHERE} ORDER BY ${TEAM_ORDER_BY}`);
    return rows.map(toPublicMember);
}

// The Website Sections switch (Settings) hides the whole section regardless of its members.
async function isTeamSectionVisible() {
    return isPublicSectionVisible('team');
}

// Every member (the admin must be able to manage hidden ones) — same ordering as the website —
// annotated with what the website does with each: whether it is public and at which position.
async function getAdminTeamView() {
    const [rows, sectionVisible] = await Promise.all([
        all(`SELECT * FROM team_members ORDER BY ${TEAM_ORDER_BY}`),
        isTeamSectionVisible()
    ]);
    let position = 0;
    const members = rows.map(row => {
        const isPublic = isPubliclyVisible(row);
        return Object.assign({}, row, { is_public: isPublic, public_position: isPublic ? ++position : null });
    });
    return { success: true, members, section_visible: sectionVisible, public_fields: PUBLIC_FIELDS, bio_max: BIO_MAX };
}

// Write-side validation shared by create and update. Returns an error message, or null when fine.
// Only fields actually present are checked, so a partial update never trips over unrelated data.
function validateTeamInput(input) {
    if (input.status !== undefined && !TEAM_STATUSES.includes(input.status)) {
        return `Status must be one of: ${TEAM_STATUSES.join(', ')}.`;
    }
    if (typeof input.biography === 'string' && input.biography.length > BIO_MAX) {
        return `Biography is limited to ${BIO_MAX} characters.`;
    }
    for (const k of LINK_FIELDS) {
        const v = input[k];
        if (typeof v === 'string' && v.trim() && !safeUrl(v)) {
            return `${k.charAt(0).toUpperCase() + k.slice(1)} must be a full http(s) link, e.g. https://example.com.`;
        }
    }
    return null;
}

// Trim a link/free-text value to what gets stored; empty becomes NULL.
function cleanText(value) {
    if (typeof value !== 'string') return value == null ? null : value;
    const s = value.trim();
    return s || null;
}

module.exports = {
    TEAM_STATUSES, TEAM_ORDER_BY, PUBLIC_WHERE, PUBLIC_FIELDS, LINK_FIELDS, BIO_MAX,
    isPubliclyVisible, safeUrl, toPublicMember,
    listPublicMembers, isTeamSectionVisible, getAdminTeamView,
    validateTeamInput, cleanText
};
