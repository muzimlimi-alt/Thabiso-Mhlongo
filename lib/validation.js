// Small standalone validation/sanitization helpers — Phase 5 of the housekeeping effort
// (HOUSEKEEPING-NOTES.md). Moved out of the app.js monolith byte-identical.

const sanitizeEmailInput = (input) => {
    if (typeof input !== 'string') return input;
    // Remove newlines to prevent header injection
    return input.replace(/[\r\n]/g, '').trim();
};

// Day/month-only birthday validation (no year, ever — see newsletter_subscribers schema).
// Feb is capped at 29, not 28: a Feb-29 birthday is real, it just won't recur every year.
const BIRTHDAY_DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const isValidBirthday = (day, month) => {
    const d = parseInt(day, 10), m = parseInt(month, 10);
    if (!Number.isInteger(d) || !Number.isInteger(m)) return false;
    if (m < 1 || m > 12) return false;
    if (d < 1 || d > BIRTHDAY_DAYS_IN_MONTH[m - 1]) return false;
    return true;
};

module.exports = { sanitizeEmailInput, isValidBirthday };
