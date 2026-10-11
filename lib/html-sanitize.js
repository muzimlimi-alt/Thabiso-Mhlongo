// HTML encode/sanitize helpers — Phase 5 of the housekeeping effort (HOUSEKEEPING-NOTES.md). Moved
// out of the app.js monolith byte-identical. All pure functions (no db/session access), used
// across many routes (encodeUserHtml alone at ~27 call sites) — relocated here rather than
// duplicated into each route file that needs one of them.

// ADMIN-XSS: neutralize stored HTML at the input boundary. The admin panel renders many
// booking/client fields via innerHTML/.html() without escaping, so a malicious public
// submission (e.g. message = "<img src=x onerror=...>") would execute JS in the admin's
// authenticated session. Encoding < > " here means no tag/attribute can ever form from stored
// data, in the admin DOM, emails, or PDFs. '&' is deliberately left raw so output-layer
// escaping (EMAIL-1) handles it without double-encoding common values like "Tom & Jerry".
function encodeUserHtml(s) {
    if (s == null) return s;
    return String(s).replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function unescapeHtml(str) {
    if (!str || typeof str !== 'string') return '';
    return str
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#x27;/g, "'");
}

// app.js's deepEscapeBody stores user text entity-encoded exactly ONCE, and some sections (career highlights)
// render that stored text as HTML. An editor that loads a stored value back into a form box and saves it again
// used to stack another layer on every edit, which the public page then shows as literal entity text
// ("&amp;quot;Celeste &amp;amp; Da Big Dudes"). This collapses any number of stacked layers back to the single-layer
// form (the same five characters deepEscapeBody encodes). It is idempotent:
// normalizeEncodedText(normalizeEncodedText(x)) === normalizeEncodedText(x). A literal "&amp;" typed on purpose
// can't survive it, which is acceptable for the short titles and descriptions it is used on.
function normalizeEncodedText(s) {
    if (s == null) return s;
    let t = String(s);
    for (let i = 0; i < 10; i++) {
        const decoded = unescapeHtml(t);
        if (decoded === t) break;
        t = decoded;
    }
    return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
}

const ALLOWED_ABOUT_TAGS = /<(script|style|iframe|object|embed|form|input|button)\b[^>]*>[\s\S]*?<\/\1>|<(script|style|iframe|object|embed|form|input|button)\b[^>]*\/?>/gi;
const STRIP_ON_ATTRS = /\s+on\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*)/gi;
const STRIP_JS_HREF = /href\s*=\s*(?:"javascript:[^"]*"|'javascript:[^']*')/gi;

function sanitizeAboutHtml(html) {
    if (!html || typeof html !== 'string') return '';
    return html
        .replace(ALLOWED_ABOUT_TAGS, '')
        .replace(STRIP_ON_ATTRS, '')
        .replace(STRIP_JS_HREF, 'href="#"');
}

// Public homepage sections whose visibility admins can toggle (stored as a JSON map in the
// `section_visibility` setting). A key absent/true = visible; only an explicit false hides it.
// `announcement` is intentionally NOT here — its visibility shares the `announcement_enabled` key.
const SECTION_KEYS = ['hero', 'features', 'services', 'about', 'career', 'accolades', 'footprint', 'team', 'gallery', 'events', 'social', 'newsletter', 'testimonials', 'contact', 'footer'];

module.exports = { encodeUserHtml, unescapeHtml, normalizeEncodedText, sanitizeAboutHtml, SECTION_KEYS };
