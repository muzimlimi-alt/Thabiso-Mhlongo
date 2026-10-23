// (2026-10-23, business profile: an invoice can now read TAX INVOICE - but only when the business is VAT-registered AND has confirmed its VAT number AND
// VAT is charged on that document; see test/business-profile.test.js. What this file pins is unchanged: with NO issuer handed in, the amount of the invoice
// or a client's VAT number never decide the title, and a quotation reads QUOTATION.)
// The invoice just reads INVOICE (owner, 2026-10-19). The PDF used to be titled "TAX INVOICE" - and to print "This is a valid Tax Invoice for VAT
// purposes in terms of section 20 of the Value-Added Tax Act" - for every invoice of R5,000 or more, or one carrying a client VAT number, whether or
// not any VAT was charged. Now the title is the plain document type and the legal sentence is gone. Money is untouched: what makes an invoice
// carry VAT (the quotation's VAT choice, or our VAT registration for a qualifying invoice) is the same as before.
// pdfService is a pure module (pdfkit only, no database), so the real generator is called here directly and the PDF's own text is read back.
const fs = require('fs');
const os = require('os');
const path = require('path');
const pdfService = require('../js/pdfService');
const { extractPdfText } = require('./support');

const booking = (over = {}) => ({
    id: 99001, name: 'Invoice Title Client', email: 'invoice.title@example.invalid', cell: '+27821234567', event_name: 'Invoice title test', event_type: 'Corporate',
    date: '2026-12-01', event_location: 'Test Hall', apply_vat: false, discount: 0, terms: 'Standard terms apply.', ...over
});
const line = (price) => [{ description: 'Test engagement', quantity: 1, unit_price: price, total_price: price, pricing_model: 'flat_fee' }];

module.exports = async function ({ check }) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'invoice-title-'));
    const render = async (type, bk, items, name) => {
        const file = path.join(dir, name + '.pdf');
        await pdfService.generateDocument(type, bk, items, file, [], type === 'Invoice' ? 'INV-TITLE-0001' : null, {});
        return extractPdfText(fs.readFileSync(file)).replace(/\s+/g, ' ');
    };
    try {
        const big = await render('Invoice', booking(), line(7500), 'big');
        check('an invoice of R7,500 (R5,000 or more) reads INVOICE', /\bINVOICE\b/.test(big) && !/TAX INVOICE/i.test(big), big.slice(0, 300));
        check('...and no longer claims to be "a valid Tax Invoice for VAT purposes"', !/valid Tax Invoice|section 20 of the Value-Added Tax Act/i.test(big), big.slice(-400));
        check('...it still carries its number and amount', /INV-TITLE-0001/.test(big) && /7[ ,]?500/.test(big), big.slice(0, 400));

        const withVat = await render('Invoice', booking({ vat_number: '4123456789' }), line(2500), 'clientvat');
        check('an invoice for a client who gave a VAT number reads INVOICE too (not TAX INVOICE)', /\bINVOICE\b/.test(withVat) && !/TAX INVOICE/i.test(withVat), withVat.slice(0, 300));
        check('...and still prints the client\'s VAT number in the bill-to box', /VAT No:\s*4123456789/.test(withVat), withVat.slice(0, 600));

        const small = await render('Invoice', booking(), line(2500), 'small');
        check('a small invoice reads INVOICE (as before)', /\bINVOICE\b/.test(small) && !/TAX INVOICE/i.test(small), small.slice(0, 300));

        const quote = await render('Quote', booking(), line(7500), 'quote');
        check('a quotation is not an invoice: it reads QUOTATION and never INVOICE', /\bQUOTATION\b/.test(quote) && !/\bINVOICE\b/.test(quote), quote.slice(0, 300));
    } finally {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
    }
};
