// Pricing conditions that travel WITH a quotation: printed on the quotation PDF and shown in the emails that
// present the quoted price (the quotation email and the quote reminder).
//
// Prices are never public (owner decision, 2026-10-17): a client first sees an amount when the quotation is
// sent, so that is where the rate card's conditions belong - currency, VAT, travel / accommodation / rider and
// the validity of the rates. The wording follows the official rate card, adapted only where the quotation itself
// makes a sentence untrue:
//   - VAT: a quotation either has VAT added in its totals or it does not, so the sentence says which.
//   - travel / accommodation / rider: excluded unless they are itemised on this quotation (the catalogue sells
//     them as add-ons).
//   - validity: only printed while the rate card is still valid, never after it has expired.
//   - individually priced services: a short plain-language note, only when the quotation has such a line.
// No discounts, deposits, payment terms or other commercial conditions are added here.
const moment = require('moment-timezone');

const RATE_CARD_VALIDITY_KEY = 'rate_card_valid_until';

const pad = (s) => String(s == null ? '' : s);

// PURE. `validUntil` / `today` are ISO dates (YYYY-MM-DD); `today` is injectable so the rule is testable.
function buildQuotationConditions({ applyVat = false, vatRate = 0.15, validUntil = null, today = null, individuallyQuoted = false } = {}) {
    const lines = ['All amounts are in South African rand (ZAR).'];
    const pct = Math.round((parseFloat(vatRate) || 0.15) * 100);
    lines.push(applyVat
        ? `Fees exclude VAT. VAT at ${pct}% is added in the totals above.`
        : 'VAT is not included in the amounts above.');
    lines.push('Fees exclude travel, accommodation and rider unless they are itemised in this quotation.');
    if (individuallyQuoted) {
        lines.push('Some services are priced individually for each engagement; the amounts shown for those items are the tailored fees for this event.');
    }
    const day = pad(today || moment().tz('Africa/Johannesburg').format('YYYY-MM-DD'));
    if (/^\d{4}-\d{2}-\d{2}$/.test(pad(validUntil)) && validUntil >= day) {
        lines.push(`Rates are valid until ${moment(validUntil, 'YYYY-MM-DD').format('D MMMM YYYY')}.`);
    }
    return lines;
}

// Reads the rate-card validity from settings, then builds the lines. Never throws: a settings read failure just
// omits the validity sentence (the rest of the conditions are still correct).
async function getQuotationConditions(opts = {}) {
    let validUntil = null;
    try {
        // lazy require: the repository imports the database module
        validUntil = await require('../database/repositories/settings.repository').getSettingVal(RATE_CARD_VALIDITY_KEY);
    } catch (e) { /* omit the validity sentence */ }
    return buildQuotationConditions({ ...opts, validUntil });
}

const escapeHtml = (s) => pad(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// The block the emails embed, styled like the email's own service-breakdown panel. Empty input -> ''.
function conditionsHtml(lines) {
    if (!Array.isArray(lines) || !lines.length) return '';
    return '<div style="margin:16px 0 0; padding:12px 14px; background:#111; border-radius:4px; font-size:12px; line-height:1.6; color:#9A9A9A;">' +
        '<strong style="color:#D4AF37;">Pricing conditions</strong><br>' +
        lines.map(l => '&bull; ' + escapeHtml(l)).join('<br>') + '</div>';
}

module.exports = { buildQuotationConditions, getQuotationConditions, conditionsHtml, RATE_CARD_VALIDITY_KEY };
