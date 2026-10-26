// Phase 5 (HOUSEKEEPING-NOTES.md): relocated from app.js verbatim. Shared by generateInvoice
// (not yet moved), the admin quote route (not yet moved), and lib/contracts.js's
// resolveContractFeeData — single source of truth for quote/invoice/contract money math.
const db = require('../database');

// Now selects the current default rate by effective-date window.
function getVatRate() {
    return new Promise(resolve => {
        db.get(`SELECT rate FROM tax_rates
                WHERE COALESCE(is_default, 0) = 1
                  AND (effective_from IS NULL OR effective_from <= date('now'))
                  AND (effective_to   IS NULL OR effective_to   >= date('now'))
                ORDER BY effective_from DESC, id DESC LIMIT 1`,
            [], (err, row) => resolve((!err && row && row.rate != null) ? parseFloat(row.rate) : 0.15));
    });
}

// FIN-2: VAT applies only to taxable lines. Resolve each line's tax_class from the services
// catalog (lines without a service_id — e.g. custom quote lines — default to 'standard'/taxable).
// Mutates items in place, adding a tax_class where missing.
async function resolveLineTaxClasses(items) {
    if (!Array.isArray(items) || items.length === 0) return items;
    const ids = [...new Set(items.map(i => parseInt(i.service_id)).filter(n => !isNaN(n)))];
    const byId = {};
    if (ids.length) {
        const rows = await new Promise(res => db.all(
            `SELECT id, tax_class FROM services WHERE id IN (${ids.map(() => '?').join(',')})`, ids,
            (e, r) => res(e ? [] : (r || []))));
        rows.forEach(s => { byId[s.id] = s.tax_class; });
    }
    for (const it of items) {
        if (!it.tax_class) it.tax_class = byId[parseInt(it.service_id)] || 'standard';
    }
    return items;
}

// FIN-2: single source of truth for quote/invoice money math. The implementation lives in js/shared/document-totals.js
// because the admin Quote Builder runs the SAME code in the browser, so its live preview cannot drift from the stored
// total. VAT is charged only on taxable (non-exempt) lines; a discount is split across taxable/exempt in proportion
// to their subtotals.
const { computeDocumentTotals } = require('../js/shared/document-totals');

module.exports = { getVatRate, resolveLineTaxClasses, computeDocumentTotals };
