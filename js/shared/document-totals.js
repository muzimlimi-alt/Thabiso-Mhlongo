/**
 * Quote / invoice money math - ONE implementation, loaded by the server (lib/document-totals.js re-exports it, and the quote
 * route, invoicing and contracts all go through that) and by the admin Quote Builder (admin.html), so the figures an
 * administrator previews while building a quote are produced by the very code that stores the total.
 *
 * Rules (FIN-2): VAT is charged only on taxable lines (tax_class other than 'exempt' / 'zero-rated'); a discount is split
 * across the taxable and exempt parts in proportion to their subtotals; VAT is rounded to the cent and so is the total.
 * A line is quantity x unit price whatever its pricing model. A missing / zero quantity counts as 1.
 */
(function (root, factory) {
    var api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;   // Node: require('.../js/shared/document-totals')
    else root.DocumentTotals = api;                                            // browser: window.DocumentTotals
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    function computeDocumentTotals(items, options) {
        var opts = options || {};
        var discount = opts.discount === undefined ? 0 : opts.discount;
        var applyVat = opts.applyVat === undefined ? false : opts.applyVat;
        var vatRate = opts.vatRate === undefined ? 0.15 : opts.vatRate;

        var vatableSubtotal = 0, exemptSubtotal = 0;
        (items || []).forEach(function (it) {
            var qty = parseFloat(it.quantity_minutes) || parseFloat(it.quantity) || 1;
            var price = parseFloat(it.unit_price) || 0;
            var amt = qty * price;
            var tc = it.tax_class || 'standard';
            if (tc === 'exempt' || tc === 'zero-rated') exemptSubtotal += amt; else vatableSubtotal += amt;
        });
        var subtotal = vatableSubtotal + exemptSubtotal;
        var dp = Math.max(0, parseFloat(discount) || 0);
        var ratio = subtotal > 0 ? vatableSubtotal / subtotal : 1;
        var vatableBase = Math.max(0, vatableSubtotal - dp * ratio);
        var exemptBase = Math.max(0, exemptSubtotal - dp * (1 - ratio));
        var vat = applyVat ? Math.round(vatableBase * vatRate * 100) / 100 : 0;
        var total = Math.round((vatableBase + exemptBase + vat) * 100) / 100;
        return { subtotal: subtotal, vatableBase: vatableBase, exemptBase: exemptBase, vat: vat, total: total, discount: dp };
    }

    return { computeDocumentTotals: computeDocumentTotals };
}));
