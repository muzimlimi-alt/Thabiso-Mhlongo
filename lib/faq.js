// FAQ - the single source of truth for WHICH questions are on the website, in WHAT ORDER, with WHICH FIELDS. Same design as lib/accolades.js
// and lib/team.js:
//
//   GET /api/public/faqs   (routes/public/site-content.js)  -> listPublicFaqs()
//   GET /api/admin/faqs    (routes/admin/faq.js)            -> getAdminFaqView()
//
// Both pages render with the same view code (js/faq-view.js), so the admin preview can never show a question differently from the website.
//
// Text storage: app.js's deepEscapeBody entity-encodes every request-body string before a route runs ("Don't" arrives as "Don&#x27;t").
// Questions are full of apostrophes, so prepareFaq() decodes and the table stores what the admin typed. That is safe ONLY because every
// reader inserts these values as TEXT (js/faq-view.js and js/admin/faq.js use textContent / .text(); the audit views escape). Never render
// a question or answer with innerHTML / .html(). Answers are plain text: blank lines separate paragraphs, nothing else is interpreted.
const { dbAll, dbGet } = require('./db-helpers');
const { unescapeHtml } = require('./html-sanitize');
const { isPublicSectionVisible } = require('./section-visibility');

// Website order of the groups, and their headings.
const CATEGORIES = ['bookings', 'payments', 'events', 'general'];
const CATEGORY_LABELS = { bookings: 'Bookings & quotes', payments: 'Payments', events: 'Shows & tickets', general: 'General' };
const STATUSES = ['active', 'inactive'];
const LIMITS = { question: { min: 5, max: 200 }, answer: { min: 5, max: 3000 } };

const CATEGORY_ORDER_SQL = `CASE category ${CATEGORIES.map((c, i) => `WHEN '${c}' THEN ${i}`).join(' ')} ELSE 99 END`;
const ORDER_BY = `${CATEGORY_ORDER_SQL}, display_order ASC, id ASC`;
const PUBLIC_WHERE = "status = 'active'";
// Published on the website - status, order and who/when stay on the server.
const PUBLIC_FIELDS = ['id', 'question', 'answer', 'category'];

function toPublic(row) {
    const out = {};
    PUBLIC_FIELDS.forEach((k) => { out[k] = row[k] === undefined ? null : row[k]; });
    out.category = CATEGORIES.includes(row.category) ? row.category : 'general';
    out.category_label = CATEGORY_LABELS[out.category];
    return out;
}

async function listPublicFaqs() {
    const rows = await dbAll(`SELECT * FROM faqs WHERE ${PUBLIC_WHERE} ORDER BY ${ORDER_BY}`);
    return rows.map(toPublic);
}

async function getAdminFaqView() {
    const rows = await dbAll(`SELECT f.*, a.full_name AS updated_by_name, a.username AS updated_by_user FROM faqs f LEFT JOIN admins a ON a.id = COALESCE(f.updated_by, f.created_by) ORDER BY ${ORDER_BY}`);
    return {
        items: rows.map((r) => ({ ...toPublic(r), status: r.status, display_order: r.display_order, created_at: r.created_at, updated_at: r.updated_at || r.created_at, updated_by: r.updated_by_name || r.updated_by_user || null })),
        categories: CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABELS[c] })),
        section_visible: await isPublicSectionVisible('faq'),
        published: rows.filter((r) => r.status === 'active').length
    };
}

// Validates the record a create / update would PRODUCE (existing row merged with the changes) and returns clean column values.
function prepareFaq(input, existing) {
    const src = { ...(existing || {}), ...(input || {}) };
    const errors = {};
    const text = (v) => unescapeHtml(String(v === undefined || v === null ? '' : v)).replace(/\r\n?/g, '\n');
    const clean = {};
    clean.question = text(src.question).replace(/\s+/g, ' ').trim();
    if (clean.question.length < LIMITS.question.min) errors.question = 'Write the question (at least 5 characters).';
    else if (clean.question.length > LIMITS.question.max) errors.question = `Keep the question under ${LIMITS.question.max} characters.`;
    // answers keep their paragraphs: trim each line, collapse 3+ line breaks to one blank line
    clean.answer = text(src.answer).split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
    if (clean.answer.length < LIMITS.answer.min) errors.answer = 'Write the answer (at least 5 characters).';
    else if (clean.answer.length > LIMITS.answer.max) errors.answer = `Keep the answer under ${LIMITS.answer.max.toLocaleString('en-ZA')} characters.`;
    clean.category = String(src.category || 'general');
    if (!CATEGORIES.includes(clean.category)) errors.category = 'Choose a category from the list.';
    clean.status = String(src.status || 'inactive');
    if (!STATUSES.includes(clean.status)) errors.status = 'Status must be Published or Hidden.';
    const order = Number(src.display_order === undefined || src.display_order === null || src.display_order === '' ? 0 : src.display_order);
    clean.display_order = Number.isInteger(order) && order >= 0 && order <= 100000 ? order : 0;
    return { clean, errors };
}

async function findDuplicate(question, exceptId) {
    return dbGet('SELECT id FROM faqs WHERE lower(question) = lower(?) AND id != ?', [question, exceptId || 0]);
}

// The next position at the end of a category (new questions go last).
async function nextOrder(category) {
    const r = await dbGet('SELECT COALESCE(MAX(display_order), 0) AS m FROM faqs WHERE category = ?', [category]);
    return (r ? r.m : 0) + 1;
}

const auditSnapshot = (row) => (row ? { question: row.question, answer: row.answer, category: row.category, status: row.status, display_order: row.display_order } : null);

module.exports = { CATEGORIES, CATEGORY_LABELS, LIMITS, listPublicFaqs, getAdminFaqView, prepareFaq, findDuplicate, nextOrder, auditSnapshot };
