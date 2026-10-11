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

// HOW STORED TEXT WORKS (read this before touching a form, an email or a PDF).
// app.js's deepEscapeBody entity-encodes every string in a JSON request body before any route runs, so the database
// holds text like "Tom &amp; Jerry&#x27;s" - encoded exactly ONCE. That form is right for exactly one consumer: HTML that
// is injected as markup (the browser decodes it once). Every other consumer must work from the decoded text:
//   - a form box an admin edits   -> decodeStoredText() (js/admin/stored-text.js on the client), otherwise saving
//                                    encodes it again and each edit stacks another layer ("&amp;amp;quot;")
//   - an email subject, a PDF, a calendar event, an email body that escapes its own values -> decodeStoredText() first
//   - the write path itself       -> normalizeEncodedText(), so a save is idempotent whatever the client sends
// Multipart (file-upload) routes skip deepEscapeBody entirely - their body is not parsed until after it runs - so those
// routes call normalizeBodyFields() after multer and store the same single-layer form as every JSON route.

// The plain text behind a stored value: decodes every stacked layer (older saves stacked them) until it is stable.
// A literal "&amp;" typed on purpose can't survive this, which is acceptable for names, titles and short notes.
function decodeStoredText(s) {
    if (s == null) return s;
    let t = String(s);
    for (let i = 0; i < 10; i++) {
        const decoded = unescapeHtml(t);
        if (decoded === t) break;
        t = decoded;
    }
    return t;
}

// decodeStoredText over every string in a value (objects and arrays are copied, other types pass through) - for
// consumers that print plain text from a whole record, like a PDF.
function decodeStoredDeep(v) {
    if (typeof v === 'string') return decodeStoredText(v);
    if (Array.isArray(v)) return v.map(decodeStoredDeep);
    if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
        const out = {};
        for (const k of Object.keys(v)) out[k] = decodeStoredDeep(v[k]);
        return out;
    }
    return v;
}

// Encodes the same five characters deepEscapeBody does.
function encodeEntities(t) {
    return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
}

// The single-layer stored form of any input - raw text, already-encoded text, or text with stacked layers.
// Idempotent: normalizeEncodedText(normalizeEncodedText(x)) === normalizeEncodedText(x).
function normalizeEncodedText(s) {
    if (s == null) return s;
    return encodeEntities(decodeStoredText(s));
}

// Route middleware for multipart routes (put it AFTER multer): stores the named text fields in the single-layer form.
function normalizeBodyFields(fields) {
    return (req, res, next) => {
        if (req.body && typeof req.body === 'object') {
            for (const f of fields) if (typeof req.body[f] === 'string') req.body[f] = normalizeEncodedText(req.body[f]);
        }
        next();
    };
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

module.exports = { encodeUserHtml, unescapeHtml, decodeStoredText, decodeStoredDeep, encodeEntities, normalizeEncodedText, normalizeBodyFields, sanitizeAboutHtml, SECTION_KEYS };
