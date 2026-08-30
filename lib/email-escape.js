// Phase 5 (HOUSEKEEPING-NOTES.md): relocated from app.js verbatim — escaping for the free-text
// booking/client fields interpolated into outgoing HTML emails. Distinct from lib/html-sanitize.js
// (which sanitizes admin-authored rich-text content sections, not per-send email interpolation).

// so a malicious booking (e.g. message = "<img src=x onerror=...>") can't inject markup into
// the admin's notification inbox or a client's mailbox. Escapes & < > " (not ' — avoids mangling
// apostrophes in the rare plain-text subject case). Only the whitelisted free-text fields are
// escaped; recipient emails, dates, amounts, ids and URLs are left untouched.
function escapeEmailHtml(s) {
    return String(s == null ? '' : s)
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
