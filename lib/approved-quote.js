// The APPROVED commercial basis of a booking's quotation: the lines, each line's tax class, the discount, the VAT switch and the VAT rate
// the quotation was issued with. Invoices and contracts are built from THIS - never from today's catalogue or today's VAT rate - so
// editing a service (tax class, price, name, active flag) or the national VAT rate can never move an amount the client approved.
//
// Where the approved data lives:
//   quote_line_items   description / quantity / unit_price / service_id per line (the approved amounts; no tax class)
//   bookings.quote_details  JSON written when the quotation was issued: items (each WITH its tax_class, same order as the quote lines),
//                      discount, apply_vat, vat, finalTotal and - since the 2026 rate-card work - vat_rate.
// A quotation issued before those fields existed falls back, field by field, to what the application always did: the line's CURRENT
// tax class (resolveLineTaxClasses) and the CURRENT VAT rate.
const { getVatRate, resolveLineTaxClasses } = require('./document-totals');

// The VAT rate a quotation was issued at, or null for one issued before the rate was recorded.
function storedVatRate(quoteDetails) {
    let qd = quoteDetails;
    if (typeof qd === 'string') { try { qd = JSON.parse(qd || '{}'); } catch (e) { return null; } }
    const r = qd ? parseFloat(qd.vat_rate) : NaN;
    return (Number.isFinite(r) && r >= 0 && r <= 1) ? r : null;
}

const sameService = (a, b) => (a == null && b == null) || (a != null && b != null && parseInt(a, 10) === parseInt(b, 10));

// qLines: the rows of quote_line_items for the booking's active quotation (may be empty for a legacy booking).
async function approvedQuoteBasis(booking, qLines) {
    let quoteData = {};
    try { quoteData = JSON.parse((booking && booking.quote_details) || '{}') || {}; } catch (e) { quoteData = {}; }
    const stored = Array.isArray(quoteData.items) ? quoteData.items : [];

    let items = [];
    if (qLines && qLines.length > 0) {
        items = qLines.map(li => ({ description: li.description, quantity: parseFloat(li.quantity) || 1, unit_price: parseFloat(li.unit_price) || 0, service_id: li.service_id }));
        // Same order, same count: the quotation's own record of each line's tax class beats whatever the service says now.
        if (stored.length === items.length) {
            items.forEach((it, i) => {
                if (stored[i] && stored[i].tax_class && sameService(stored[i].service_id, it.service_id)) it.tax_class = stored[i].tax_class;
            });
        }
    } else if (stored.length > 0) {
        items = stored;   // legacy source: the quote_details lines already carry their tax class
    }
    await resolveLineTaxClasses(items);   // only fills a line that still has no class (a legacy record): the catalogue, as before

    const vatRate = storedVatRate(quoteData);
    return {
        items,
        applyVat: !!quoteData.apply_vat,
        discount: parseFloat(quoteData.discount) || 0,
        vatRate: vatRate !== null ? vatRate : await getVatRate(),
        quoteData
    };
}

module.exports = { approvedQuoteBasis, storedVatRate };
