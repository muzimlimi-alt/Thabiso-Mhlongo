/**
 * Thabiso Mhlongo — Newsletter Personalization / Merge Fields
 * =============================================================
 * Pure function module — no DB, no fs — same style as js/emailComponents.js.
 * Replaces {{token}} placeholders in admin-authored subject/body text with
 * per-subscriber values before handing off to emailComponents.renderPremiumEmail.
 */

'use strict';

const MONTH_NAMES = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
];

function formatBirthday(day, month) {
    const d = parseInt(day, 10), m = parseInt(month, 10);
    if (!Number.isInteger(d) || !Number.isInteger(m) || m < 1 || m > 12 || d < 1) return '';
    return `${d} ${MONTH_NAMES[m - 1]}`;
}

function formatSubscriptionDate(subscribedAt) {
    if (!subscribedAt) return '';
    const iso = subscribedAt.includes('T') ? subscribedAt : subscribedAt.replace(' ', 'T') + 'Z';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleDateString('en-ZA', { day: 'numeric', month: 'long', year: 'numeric' });
}

// Unmatched {{tokens}} are left as-is rather than stripped, so a typo in a template is visible
// instead of silently vanishing from the sent email.
function applyMergeFields(text, subscriber = {}, unsubscribeUrl = '') {
    if (!text) return text;
    const values = {
        first_name: subscriber.first_name || 'there',
        email: subscriber.email || '',
        birthday: formatBirthday(subscriber.birthday_day, subscriber.birthday_month),
        subscription_date: formatSubscriptionDate(subscriber.subscribed_at),
        unsubscribe_link: unsubscribeUrl || ''
    };
    return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key) =>
        Object.prototype.hasOwnProperty.call(values, key) ? values[key] : match
    );
}

module.exports = { applyMergeFields, formatBirthday, formatSubscriptionDate };
