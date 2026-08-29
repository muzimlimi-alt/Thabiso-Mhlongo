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
const SECTION_KEYS = ['hero', 'features', 'services', 'about', 'career', 'footprint', 'gallery', 'events', 'social', 'newsletter', 'testimonials', 'contact', 'footer'];

module.exports = { encodeUserHtml, unescapeHtml, sanitizeAboutHtml, SECTION_KEYS };
