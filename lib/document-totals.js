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

// FIN-2: single source of truth for quote/invoice money math — mirrors pdfService's totals block
// so the stored total and the printed document always agree. VAT is charged only on taxable
// (non-exempt) lines; a discount is split across taxable/exempt in proportion to their subtotals.
function computeDocumentTotals(items, { discount = 0, applyVat = false, vatRate = 0.15 } = {}) {
    let vatableSubtotal = 0, exemptSubtotal = 0;
    for (const it of (items || [])) {
        const qty = parseFloat(it.quantity_minutes) || parseFloat(it.quantity) || 1;
        const price = parseFloat(it.unit_price) || 0;
        const amt = qty * price;
        const tc = it.tax_class || 'standard';
        if (tc === 'exempt' || tc === 'zero-rated') exemptSubtotal += amt; else vatableSubtotal += amt;
    }
    const subtotal = vatableSubtotal + exemptSubtotal;
    const dp = Math.max(0, parseFloat(discount) || 0);
    const ratio = subtotal > 0 ? vatableSubtotal / subtotal : 1;
    const vatableBase = Math.max(0, vatableSubtotal - dp * ratio);
    const exemptBase  = Math.max(0, exemptSubtotal - dp * (1 - ratio));
    const vat = applyVat ? Math.round(vatableBase * vatRate * 100) / 100 : 0;
    const total = Math.round((vatableBase + exemptBase + vat) * 100) / 100;
    return { subtotal, vatableBase, exemptBase, vat, total, discount: dp };
}

module.exports = { getVatRate, resolveLineTaxClasses, computeDocumentTotals };
