// Phase 5 (HOUSEKEEPING-NOTES.md): relocated from app.js verbatim — escaping for the free-text
// booking/client fields interpolated into outgoing HTML emails. Distinct from lib/html-sanitize.js
// (which sanitizes admin-authored rich-text content sections, not per-send email interpolation).

const { decodeStoredText } = require('./html-sanitize');

// so a malicious booking (e.g. message = "<img src=x onerror=...>") can't inject markup into
// the admin's notification inbox or a client's mailbox. Escapes & < > " (not ' — avoids mangling
// apostrophes in the rare plain-text subject case). Only the whitelisted free-text fields are
// escaped; recipient emails, dates, amounts, ids and URLs are left untouched.
//
// The values arrive from the database already entity-encoded once (app.js deepEscapeBody - see lib/html-sanitize.js),
// so they are decoded to plain text FIRST; escaping the stored form directly double-encoded it, and clients saw
// "Hi O&#x27;Brien &amp; Sons". It is idempotent: escaping an already-escaped value gives the same result.
function escapeEmailHtml(s) {
    return String(decodeStoredText(s == null ? '' : s))
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
const EMAIL_ESCAPE_FIELDS = ['name', 'client_name', 'company', 'company_name', 'client_company',
    'message', 'event_name', 'event_location', 'venue_address', 'venue_name', 'city', 'country',
    'event_type', 'venue_type', 'audience_demographic', 'budget_range', 'performance_slot',
    'performance_duration', 'cancellation_reason'];
function escapeEmailFields(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    const copy = { ...obj };
    for (const f of EMAIL_ESCAPE_FIELDS) {
        if (typeof copy[f] === 'string') copy[f] = escapeEmailHtml(copy[f]);
    }
    return copy;
}

module.exports = { escapeEmailHtml, EMAIL_ESCAPE_FIELDS, escapeEmailFields };
