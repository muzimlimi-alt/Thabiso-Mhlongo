// Accolades & Recognition — the single source of truth for WHICH accolades are on the website, in
// WHAT ORDER, and with WHICH FIELDS. Same design as lib/team.js (Management Team):
//
//   GET /api/public/accolades  (routes/public/site-content.js)  -> listPublicAccolades()
//   GET /api/admin/accolades   (routes/admin/accolades.js)      -> getAdminAccoladesView()
//
// Both pages render the result with the same view code (js/accolades-view.js), so the admin preview
// can never show an accolade differently from the website. Visibility, ordering, the published field
// list and write-side validation live here and nowhere else.
//
// Accolades vs Milestones: career_highlights (admin "Career", public "Milestones") is the career
// JOURNEY — things Thabiso did. This table is EXTERNAL recognition — wins, nominations and honours
// that others awarded. They are kept apart so neither list turns into a copy of the other.
//
// Text storage: app.js's deepEscapeBody HTML-entity-encodes every request-body string before any
// route runs, so "Comics' Choice & Co" arrives as "Comics&#x27; Choice &amp; Co". Award names are
// full of apostrophes and ampersands, so prepareAccolade() decodes that and the table stores what the
// admin actually typed. That is safe ONLY because every reader inserts these values as text, never as
// HTML: js/accolades-view.js and js/admin/accolades.js build the DOM with .text()/.attr() or escape
// explicitly, and the shared Change History / audit views escape every value
// (js/admin/security-audit.js). Keep it that way — never render these fields with .html().
const fs = require('fs');
const path = require('path');
const { dbAll, dbGet } = require('./db-helpers');
const { unescapeHtml } = require('./html-sanitize');
const { UPLOADS_PATH, PROJECT_ROOT } = require('./runtime-paths');
const { isPublicSectionVisible } = require('./section-visibility');

const CATEGORIES = ['win', 'nomination', 'accolade'];
const CATEGORY_LABELS = { win: 'Win', nomination: 'Nomination', accolade: 'Accolade' };
const STATUSES = ['active', 'inactive'];
// Website order: newest year first (the section reads as a timeline), then the admin's own order
// within a year (display_order — drag-to-reorder in the admin), then creation order.
const ORDER_BY = 'year DESC, display_order ASC, id ASC';
// SQL twin of isPubliclyVisible() below — keep the two in step. NULL or any unknown status is hidden.
const PUBLIC_WHERE = "status = 'active'";

// Published on the website. Everything else on the row (status, display_order, created_by/at,
// updated_by/at) is internal and never leaves the server through the public API. To publish another
// field, add it here — nothing else needs to change.
const PUBLIC_FIELDS = ['id', 'title', 'category', 'year', 'achievement_date', 'organisation', 'event_name', 'result',
    'description', 'location', 'image', 'organisation_logo', 'certificate_file', 'external_url', 'source_url', 'featured'];

// Every column the admin form writes (create/update/audit use exactly this list).
const WRITABLE_COLUMNS = ['title', 'category', 'year', 'achievement_date', 'organisation', 'event_name', 'result',
    'description', 'location', 'image', 'organisation_logo', 'certificate_file', 'external_url', 'source_url',
    'featured', 'status', 'display_order'];

// Free-text fields and their maximum length, in characters as typed.
const TEXT_LIMITS = { title: 160, organisation: 160, event_name: 160, result: 80, location: 120, description: 2000 };
const URL_FIELDS = ['external_url', 'source_url'];
const URL_MAX = 500;
// Media is uploaded through the shared /upload route with section=accolades (lib/uploads.js), which
// stores it in images/accolades/. The certificate may be a PDF or a scan; the other two are pictures.
const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'];
const MEDIA_FIELDS = {
    image: IMAGE_EXTS,
    organisation_logo: IMAGE_EXTS,
    certificate_file: ['pdf', 'jpg', 'jpeg', 'png', 'webp']
};
const YEAR_MIN = 1950;
// Next year is allowed: nominations are often announced ahead of the ceremony's own year.
const yearMax = () => new Date().getFullYear() + 1;

const FIELD_LABELS = {
    title: 'Title', category: 'Category', year: 'Year', achievement_date: 'Date',
    organisation: 'Awarding organisation', event_name: 'Event / ceremony', result: 'Result',
    description: 'Description', location: 'Location', image: 'Achievement image',
    organisation_logo: 'Organisation logo', certificate_file: 'Certificate', external_url: 'External URL',
    source_url: 'Source / reference URL', status: 'Status', featured: 'Featured', display_order: 'Display order'
};

function isPubliclyVisible(row) {
    return !!row && row.status === 'active';
}

// Links are rendered into href attributes — only plain http(s) URLs are ever published.
function safeUrl(value) {
    if (typeof value !== 'string') return null;
    const s = value.trim();
    return s.length <= URL_MAX && /^https?:\/\/[^\s<>"]+$/i.test(s) ? s : null;
}

// Only a file in this feature's own upload folder, with an allowed extension. The file-name pattern
// has no slash, so a stored path can never climb out of images/accolades/.
const MEDIA_PATH_RE = /^images\/accolades\/([A-Za-z0-9][A-Za-z0-9._-]*)$/;
function safeMediaPath(value, exts) {
    if (typeof value !== 'string') return null;
    const s = value.trim();
    const m = MEDIA_PATH_RE.exec(s);
    if (!m || !m[1].includes('.')) return null;
    return exts.includes(m[1].split('.').pop().toLowerCase()) ? s : null;
}

// Uploads are written under UPLOADS_PATH (the project's images/ folder by default); when UPLOADS_PATH
// points elsewhere the repo's own images/ is still served as a fallback (app.js), so check both.
function mediaFileExists(relPath) {
    const name = relPath.replace(/^images\/accolades\//, '');
    return [path.join(UPLOADS_PATH, 'accolades', name), path.join(PROJECT_ROOT, 'images', 'accolades', name)]
        .some(p => { try { return fs.statSync(p).isFile(); } catch (e) { return false; } });
}

function toPublicAccolade(row) {
    const out = {};
    PUBLIC_FIELDS.forEach(k => { out[k] = row[k] === undefined ? null : row[k]; });
    URL_FIELDS.forEach(k => { out[k] = safeUrl(out[k]); });
    Object.keys(MEDIA_FIELDS).forEach(k => { out[k] = safeMediaPath(out[k], MEDIA_FIELDS[k]); });
    out.category = CATEGORIES.includes(row.category) ? row.category : 'accolade';
    out.year = Number(row.year);
    out.featured = row.featured == 1 ? 1 : 0;
    return out;
}

// Exactly what the website shows, in the order it shows it.
async function listPublicAccolades() {
    const rows = await dbAll(`SELECT * FROM accolades WHERE ${PUBLIC_WHERE} ORDER BY ${ORDER_BY}`);
    return rows.map(toPublicAccolade);
}

async function isAccoladesSectionVisible() {
    return isPublicSectionVisible('accolades');
}

// Every accolade (hidden ones must stay manageable) in the SAME order as the website, each annotated
// with what the website does with it: whether it is public and at which position. The creator /
// last editor names come from the admins table for the cards' "Updated … by …" line.
async function getAdminAccoladesView() {
    const [rows, sectionVisible] = await Promise.all([
        dbAll(`SELECT a.*,
                      (SELECT COALESCE(NULLIF(full_name, ''), username) FROM admins WHERE id = a.created_by) AS created_by_name,
                      (SELECT COALESCE(NULLIF(full_name, ''), username) FROM admins WHERE id = a.updated_by) AS updated_by_name
               FROM accolades a
               ORDER BY ${ORDER_BY}`),
        isAccoladesSectionVisible()
    ]);
    let position = 0;
    const accolades = rows.map(row => {
        const isPublic = isPubliclyVisible(row);
        return Object.assign({}, row, { is_public: isPublic, public_position: isPublic ? ++position : null });
    });
    return {
        success: true,
        accolades,
        section_visible: sectionVisible,
        public_fields: PUBLIC_FIELDS,
        categories: CATEGORIES,
        category_labels: CATEGORY_LABELS,
        statuses: STATUSES,
        limits: Object.assign({}, TEXT_LIMITS, { url: URL_MAX, year_min: YEAR_MIN, year_max: yearMax() })
    };
}

// One incoming value, decoded from app.js's entity-encoding (see the header), trimmed, '' -> null.
function cleanInput(value) {
    if (value === undefined || value === null) return value;
    if (typeof value === 'number') return String(value);
    if (typeof value !== 'string') return value;
    const s = unescapeHtml(value).trim();
    return s === '' ? null : s;
}

function isRealDate(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m) return false;
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

function toFlag(v) {
    if (v === true || v === 1 || v === '1' || v === 'true') return 1;
    if (v === false || v === 0 || v === '0' || v === 'false' || v === null) return 0;
    return undefined;
}

// Builds the complete record a create (existing = null) or update (existing = the current row) would
// store, and validates THAT — so a partial update is checked against the record it produces and never
// trips over fields it did not touch. Returns { values } or { error, field }.
function prepareAccolade(input, existing) {
    const src = input || {};
    const base = existing || {};
    const given = k => Object.prototype.hasOwnProperty.call(src, k) && src[k] !== undefined;
    const fail = (field, error) => ({ error, field });
    const v = {};

    for (const k of Object.keys(TEXT_LIMITS)) {
        if (given(k)) {
            if (src[k] !== null && typeof src[k] !== 'string' && typeof src[k] !== 'number') return fail(k, `${FIELD_LABELS[k]} must be text.`);
            v[k] = cleanInput(src[k]);
        } else {
            v[k] = base[k] == null ? null : base[k];
        }
        if (v[k] != null && v[k].length > TEXT_LIMITS[k]) return fail(k, `${FIELD_LABELS[k]} is limited to ${TEXT_LIMITS[k]} characters.`);
    }
    if (!v.title) return fail('title', 'Title is required.');

    const category = given('category') ? cleanInput(src.category) : base.category;
    if (category == null) return fail('category', 'Category is required.');
    v.category = String(category).toLowerCase();
    if (!CATEGORIES.includes(v.category)) return fail('category', 'Category must be Win, Nomination or Accolade.');

    let year = given('year') ? cleanInput(src.year) : base.year;
    if (year == null) return fail('year', 'Year is required.');
    if (typeof year === 'string' && !/^\d{4}$/.test(year)) return fail('year', `Year must be a four-digit year between ${YEAR_MIN} and ${yearMax()}.`);
    year = Number(year);
    if (!Number.isInteger(year) || year < YEAR_MIN || year > yearMax()) return fail('year', `Year must be a four-digit year between ${YEAR_MIN} and ${yearMax()}.`);
    v.year = year;

    v.achievement_date = given('achievement_date') ? cleanInput(src.achievement_date) : (base.achievement_date || null);
    if (v.achievement_date != null) {
        if (typeof v.achievement_date !== 'string' || !isRealDate(v.achievement_date)) return fail('achievement_date', 'Date must be a real calendar date (YYYY-MM-DD).');
        // A ceremony can fall in the year after the awards year it honours ("2024 Awards", held
        // February 2025), so one year either way is allowed — anything further is almost certainly a typo.
        const dateYear = Number(v.achievement_date.slice(0, 4));
        if (Math.abs(dateYear - v.year) > 1) return fail('achievement_date', `The date (${dateYear}) does not match the year (${v.year}).`);
    }

    for (const k of URL_FIELDS) {
        v[k] = given(k) ? cleanInput(src[k]) : (base[k] == null ? null : base[k]);
        if (v[k] != null && !safeUrl(v[k])) return fail(k, `${FIELD_LABELS[k]} must be a full http(s) link, e.g. https://example.com.`);
    }

    for (const k of Object.keys(MEDIA_FIELDS)) {
        v[k] = given(k) ? cleanInput(src[k]) : (base[k] == null ? null : base[k]);
        if (v[k] == null) continue;
        if (!safeMediaPath(v[k], MEDIA_FIELDS[k])) {
            return fail(k, `${FIELD_LABELS[k]} must be a file uploaded here (${MEDIA_FIELDS[k].join(', ').toUpperCase()}).`);
        }
        // Only a NEW reference is checked on disk, so an unrelated edit is never blocked by a file that
        // went missing later (the drawer shows that one as broken; the admin can replace or remove it).
        if (v[k] !== base[k] && !mediaFileExists(v[k])) {
            return fail(k, `${FIELD_LABELS[k]} could not be found on the server — please upload it again.`);
        }
    }

    const status = given('status') ? cleanInput(src.status) : (STATUSES.includes(base.status) ? base.status : 'inactive');
    if (!STATUSES.includes(status)) return fail('status', 'Status must be Active or Inactive.');
    v.status = status;

    if (given('featured')) {
        const flag = toFlag(src.featured);
        if (flag === undefined) return fail('featured', 'Featured must be yes or no.');
        v.featured = flag;
    } else {
        v.featured = base.featured == 1 ? 1 : 0;
    }

    // null on a create = "put it at the end", decided by the INSERT itself.
    v.display_order = existing ? base.display_order : null;
    if (given('display_order')) {
        const raw = typeof src.display_order === 'string' ? src.display_order.trim() : src.display_order;
        if (raw !== null && raw !== '') {
            const n = (typeof raw === 'number' || typeof raw === 'string') ? Number(raw) : NaN;
            if (!Number.isInteger(n) || n < 0 || n > 1000000) return fail('display_order', 'Display order must be a whole number (0 or more).');
            v.display_order = n;
        }
    }

    return { values: v };
}

// The same award recorded twice: same title + category + year + organisation, case-insensitively —
// the rule the unique index in database.js enforces (SQLite lower(), so both sides agree).
async function findDuplicate(values, excludeId) {
    return dbGet(`SELECT id, status FROM accolades
                  WHERE lower(title) = lower(?) AND category = ? AND year = ?
                    AND lower(COALESCE(organisation, '')) = lower(COALESCE(?, ''))
                    AND id != ?`,
        [values.title, values.category, values.year, values.organisation, excludeId || 0]);
}

// The subset of a row that audit_log records (the same columns on both sides of a change, so the
// Change History diff only ever shows what actually changed).
function auditSnapshot(row) {
    const out = {};
    WRITABLE_COLUMNS.forEach(k => { out[k] = row && row[k] !== undefined ? row[k] : null; });
    return out;
}

module.exports = {
    CATEGORIES, CATEGORY_LABELS, STATUSES, ORDER_BY, PUBLIC_WHERE, PUBLIC_FIELDS, WRITABLE_COLUMNS,
    TEXT_LIMITS, URL_FIELDS, URL_MAX, MEDIA_FIELDS, YEAR_MIN,
    isPubliclyVisible, safeUrl, safeMediaPath, toPublicAccolade,
    listPublicAccolades, isAccoladesSectionVisible, getAdminAccoladesView,
    prepareAccolade, findDuplicate, auditSnapshot
};
