// Manual EFT - the "Pay by EFT" block on the invoice PDF (js/pdfService.js). pdfService is a pure module (pdfkit only, no database), so the real
// generator is called here directly and the PDF's own text is read back - the same way invoice-title.test.js does it.
// What the block must do: appear on an INVOICE that was handed banking details, carry the complete details and the reference, say that a
// payment is subject to verification of cleared funds, never appear on a quotation, never appear when no details were passed, and survive a long note
// that pushes it onto a second page.
const fs = require('fs');
const os = require('os');
const path = require('path');
const pdfService = require('../js/pdfService');
const { extractPdfText } = require('./support');

const booking = (over = {}) => ({
    id: 99101, name: 'Pay By EFT Client', email: 'pay.by.eft@example.invalid', cell: '+27821234567', event_name: 'EFT block test', event_type: 'Corporate',
    date: '2026-12-01', event_location: 'Test Hall', apply_vat: false, discount: 0, terms: 'Standard terms apply.', ...over
});
const line = (price) => [{ description: 'Test engagement', quantity: 1, unit_price: price, total_price: price, pricing_model: 'flat_fee' }];
const eftBlock = (over = {}) => ({
    version: 3, accountHolder: 'Thabiso Mhlongo Entertainment', bankName: 'First National Bank', accountNumber: '62001234567', accountType: 'Current / Cheque',
    branchCode: '250655', swiftCode: null, referenceNote: 'Use the invoice number as your reference', paymentInstructions: null, reference: 'INV-2026-9101', ...over
});
const schedule = [{ description: 'Deposit (50%)', due_date: '2026-11-01', expected_amount: 1250 }, { description: 'Balance (50%)', due_date: '2026-11-25', expected_amount: 1250 }];

module.exports = async function ({ check }) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eft-pdf-'));
    const render = async (type, opts, name, bk = booking(), sched = schedule) => {
        const file = path.join(dir, name + '.pdf');
        await pdfService.generateDocument(type, bk, line(2500), file, sched, type === 'Invoice' ? 'INV-2026-9101' : null, opts);
        return extractPdfText(fs.readFileSync(file)).replace(/\s+/g, ' ');
    };
    try {
        const withEft = await render('Invoice', { eft: eftBlock() }, 'with');
        check('an invoice given banking details carries a PAY BY EFT block', /PAY BY EFT \(BANK TRANSFER\)/.test(withEft), withEft.slice(-700));
        check('...with the COMPLETE details a client needs: holder, bank, account number, type, branch code',
            /Thabiso Mhlongo Entertainment/.test(withEft) && /First National Bank/.test(withEft) && /62001234567/.test(withEft) && /Current \/ Cheque/.test(withEft) && /250655/.test(withEft), withEft.slice(-700));
        check('...and the payment reference to quote (the invoice number)', /Payment reference\s+INV-2026-9101/.test(withEft), withEft.slice(-700));
        check('...the administrator\'s own reference note is printed', /Use the invoice number as your reference/.test(withEft), withEft.slice(-700));
        check('...and it says payment is subject to verification and confirmation of cleared funds (an upload is not a payment)', /subject to verification and confirmation of cleared funds/.test(withEft), withEft.slice(-700));
        check('...and tells the client what is being paid: the invoice number, the booking reference and the amount payable', /Invoice number\s+INV-2026-9101/.test(withEft) && /Booking reference\s+#99101/.test(withEft) && /Amount payable\s+R 2500\.00/.test(withEft), withEft.slice(-800));
        check('...and to upload the proof of payment', /upload your proof of payment/.test(withEft), withEft.slice(-700));
        check('...the invoice is still plainly INVOICE with its schedule intact', /\bINVOICE\b/.test(withEft) && /PAYMENT SCHEDULE/.test(withEft) && /Deposit \(50%\)/.test(withEft), withEft.slice(0, 500));

        const swift = await render('Invoice', { eft: eftBlock({ swiftCode: 'FIRNZAJJ' }) }, 'swift');
        check('a SWIFT / BIC code is printed when there is one', /SWIFT \/ BIC\s+FIRNZAJJ/.test(swift), swift.slice(-600));
        check('...and not when there is none', !/SWIFT/.test(withEft), '');

        const without = await render('Invoice', {}, 'without');
        check('an invoice WITHOUT banking details (EFT off, or issued before it existed) has no EFT block at all', !/PAY BY EFT/.test(without) && !/Account number/.test(without) && !/First National/.test(without), without.slice(-500));

        const quote = await render('Quote', { eft: eftBlock() }, 'quote', booking(), []);
        check('a QUOTATION never carries banking details, even if some are passed in', !/PAY BY EFT/.test(quote) && !/62001234567/.test(quote), quote.slice(-400));

        const noSchedule = await render('Invoice', { eft: eftBlock() }, 'nosched', booking(), []);
        check('an invoice with no payment schedule still gets the block (the portal sentence stays too)', /PAY BY EFT/.test(noSchedule) && /portal link/.test(noSchedule), noSchedule.slice(-500));

        const long = await render('Invoice', { eft: eftBlock({ paymentInstructions: 'Please make payment within 7 days of the invoice date. '.repeat(14) }) }, 'long',
            booking({ terms: 'Long terms. '.repeat(160) }), schedule);
        check('a very long note / terms still renders the whole block (it flows onto a new page instead of being cut off)', /PAY BY EFT/.test(long) && /62001234567/.test(long) && /subject to verification and confirmation of cleared funds/.test(long), long.length + ' chars');
        const pageCount = (fs.readFileSync(path.join(dir, 'long.pdf')).toString('latin1').match(/\/Type\s*\/Page\b/g) || []).length;
        check('...which really did need a second page', pageCount >= 2, 'pages=' + pageCount);

        const encoded = await render('Invoice', { eft: eftBlock({ accountHolder: 'Smith &amp; Sons' }) }, 'encoded');
        check('text that arrives entity-encoded prints as plain text in the PDF ("Smith &amp; Sons" -> "Smith & Sons")', /Smith & Sons/.test(encoded) && !/&amp;/.test(encoded), encoded.slice(-500));
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
};
