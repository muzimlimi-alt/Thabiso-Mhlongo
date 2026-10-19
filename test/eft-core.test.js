// Manual EFT - the rules that need no server (lib/eft-core.js): banking-detail validation, masking, what a file REALLY is, what a client may
// claim and what an administrator must verify. The behaviour that touches the database and the ledger is in eft-flow.test.js.
// lib/eft-core.js opens no database, so it is safe to require here (lib files that do must never be required from a test).
const core = require('../lib/eft-core');
const { makeTestPng } = require('./support');

module.exports = async function ({ check }) {
    const good = { account_holder: 'Thabiso Mhlongo Entertainment', bank_name: 'First National Bank', account_number: '6200 1234-567', account_type: 'Cheque', branch_code: '250 655', swift_code: 'fabzzajj', reference_note: 'Use your invoice number', payment_instructions: 'Email proof to bookings@example.invalid' };

    // ═══ banking details ═══
    const v = core.validateBankDetails(good);
    check('banking details: a complete, ordinary set validates with no errors', Object.keys(v.errors).length === 0, JSON.stringify(v.errors));
    check('banking details: spaces and hyphens leave the numbers, "Cheque" becomes the current-account key, SWIFT is upper-cased',
        v.clean.account_number === '62001234567' && v.clean.branch_code === '250655' && v.clean.account_type === 'current' && v.clean.swift_code === 'FABZZAJJ', JSON.stringify(v.clean));
    check('banking details: the entity-encoded form a request body arrives in is stored as plain text ("Smith &amp; Sons" -> "Smith & Sons")',
        core.validateBankDetails({ ...good, account_holder: 'Smith &amp; Sons O&#x27;Brien' }).clean.account_holder === "Smith & Sons O'Brien", '');
    const bad = (patch) => Object.keys(core.validateBankDetails({ ...good, ...patch }).errors);
    check('banking details: a missing holder / bank is refused', bad({ account_holder: '' }).includes('account_holder') && bad({ bank_name: ' ' }).includes('bank_name'), '');
    check('banking details: the account number must be 6-16 digits (letters, 5 digits and 17 digits are refused)',
        bad({ account_number: '12AB567890' }).includes('account_number') && bad({ account_number: '12345' }).includes('account_number') && bad({ account_number: '1'.repeat(17) }).includes('account_number')
        && !bad({ account_number: '123456' }).includes('account_number') && !bad({ account_number: '1'.repeat(16) }).includes('account_number'), '');
    check('banking details: the branch code must be 5-8 digits', bad({ branch_code: 'ABC123' }).includes('branch_code') && bad({ branch_code: '1234' }).includes('branch_code') && !bad({ branch_code: '12345' }).includes('branch_code'), '');
    check('banking details: an unknown account type is refused', bad({ account_type: 'crypto' }).includes('account_type') && !bad({ account_type: 'savings' }).includes('account_type') && !bad({ account_type: 'Transmission' }).includes('account_type'), '');
    check('banking details: a malformed SWIFT code is refused, a blank one is fine', bad({ swift_code: '12' }).includes('swift_code') && !bad({ swift_code: '' }).includes('swift_code') && core.validateBankDetails({ ...good, swift_code: '' }).clean.swift_code === null, '');
    check('banking details: markup can never be stored (< > in the holder, the note or the instructions are refused)',
        bad({ account_holder: 'A<script>alert(1)</script>' }).includes('account_holder') && bad({ reference_note: 'x<b>y' }).includes('reference_note') && bad({ payment_instructions: 'go to <a href=x>here</a>' }).includes('payment_instructions'), '');
    check('banking details: over-long free text is refused', bad({ reference_note: 'x'.repeat(201) }).includes('reference_note') && bad({ payment_instructions: 'x'.repeat(501) }).includes('payment_instructions') && bad({ account_holder: 'x'.repeat(101) }).includes('account_holder'), '');

    // ═══ masking (what may reach a log) ═══
    check('masking: only the last four digits of an account number survive', core.maskAccountNumber('62001234567') === '*******4567' && core.maskAccountNumber(' 1234 5678 ') === '****5678', core.maskAccountNumber('62001234567'));
    check('masking: a very short number is wholly hidden, nothing becomes "undefined"', core.maskAccountNumber('1234') === '****' && core.maskAccountNumber('') === '' && core.maskAccountNumber(null) === '', '');
    const row = { id: 3, version: 2, ...v.clean, is_active: 1 };
    const audited = core.auditViewOfBankDetails(row);
    check('masking: the audit view of a row never contains the full account number but keeps what is needed to understand the change',
        !JSON.stringify(audited).includes('62001234567') && audited.account_number === '*******4567' && audited.bank_name === good.bank_name && audited.version === 2, JSON.stringify(audited));
    const printed = core.printableBankDetails(row, 'INV-2026-0044');
    check('printed details: the invoice / client view is COMPLETE (a client cannot pay into a masked number) and carries the reference',
        printed.accountNumber === '62001234567' && printed.accountType === 'Current / Cheque' && printed.reference === 'INV-2026-0044' && printed.branchCode === '250655', JSON.stringify(printed));
    check('change detection: identical details are the same; a changed account number is listed as the changed field',
        core.sameBankDetails(row, { ...row }) && !core.sameBankDetails(row, { ...row, account_number: '99999999' }) && core.changedBankFields(row, { ...row, account_number: '99999999', bank_name: 'Nedbank' }).join() === 'bank_name,account_number', '');
    check('reference: the invoice number when there is one, else the booking', core.paymentReference(42, 'INV-2026-0042') === 'INV-2026-0042' && core.paymentReference(42, null) === 'BOOKING-42', '');

    // ═══ what a file REALLY is ═══
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n');
    const png = makeTestPng(8, 8);
    const jpeg = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10]), Buffer.from('JFIF'), Buffer.alloc(40, 1), Buffer.from([0xFF, 0xD9])]);
    check('sniffing: PDF, JPEG and PNG are recognised from their first bytes', core.sniffProofType(pdf) === 'application/pdf' && core.sniffProofType(jpeg) === 'image/jpeg' && core.sniffProofType(png) === 'image/png', '');
    check('sniffing: a script, an executable, HTML, an empty file and a truncated header are NOT',
        [Buffer.from('#!/bin/sh\necho hi\n'), Buffer.from('MZ\x90\x00\x03\x00\x00\x00\x04\x00'), Buffer.from('<html><body>hi</body></html>'), Buffer.alloc(0), Buffer.from([0xFF, 0xD8]), Buffer.from('%PDF')].every(b => core.sniffProofType(b) === null), '');
    const file = (buffer, mimetype, originalname = 'proof') => ({ buffer, mimetype, originalname });
    check('file check: a real PDF, JPG and PNG are accepted with their own extension and a label',
        core.checkProofFile(file(pdf, 'application/pdf'), 5).ext === 'pdf' && core.checkProofFile(file(jpeg, 'image/jpeg'), 5).ext === 'jpg' && core.checkProofFile(file(png, 'image/png'), 5).label === 'PNG', '');
    check('file check: the common alias image/jpg is accepted when the bytes are a JPEG', core.checkProofFile(file(jpeg, 'image/jpg'), 5).ok === true, '');
    check('file check: a PNG that claims to be a PDF (type does not match the bytes) is refused', core.checkProofFile(file(png, 'application/pdf'), 5).ok === false, '');
    check('file check: an executable renamed proof.pdf and declared application/pdf is refused (bytes, not name)', core.checkProofFile(file(Buffer.from('MZ\x90\x00\x03\x00\x00\x00\x04\x00\x00\x00'), 'application/pdf', 'proof.pdf'), 5).ok === false, '');
    check('file check: a WEBP, a GIF, text and a Word file are not accepted types', ['image/webp', 'image/gif', 'text/plain', 'application/msword', 'application/octet-stream', ''].every(t => core.checkProofFile(file(png, t), 5).ok === false), '');
    check('file check: an empty upload is refused with a friendly message', /attach/i.test(core.checkProofFile(file(Buffer.alloc(0), 'image/png'), 5).message || '') && core.checkProofFile(null, 5).ok === false, '');
    const big = Buffer.concat([png, Buffer.alloc(2 * 1024 * 1024 + 1)]);
    check('file check: the administrator\'s size limit is enforced (2 MB + 1 byte fails a 2 MB limit, passes a 3 MB one)', core.checkProofFile(file(big, 'image/png'), 2).ok === false && core.checkProofFile(file(big, 'image/png'), 3).ok === true, '');
    check('file check: a limit above the hard cap or a nonsense one is clamped, not trusted', core.checkProofFile(file(Buffer.concat([png, Buffer.alloc(16 * 1024 * 1024)]), 'image/png'), 500).ok === false && core.checkProofFile(file(png, 'image/png'), 'abc').ok === true, '');
    check('display name: a path, markup or an enormous name can never leave the filename unsafe',
        core.safeDisplayName('../../etc/passwd') === 'passwd' && !/[<>\\/]/.test(core.safeDisplayName('a<b>c\\d/e.png')) && core.safeDisplayName('x'.repeat(500)).length <= 120 && core.safeDisplayName('') === 'proof' && core.safeDisplayName('.htaccess') === 'htaccess', core.safeDisplayName('../../etc/passwd'));

    // ═══ amounts and dates ═══
    check('money: plain, "R" prefixed and thousands-separated amounts parse; junk, negatives, 3 decimals and zero do not',
        core.parseMoney('2500') === 2500 && core.parseMoney('R 2,500.50') === 2500.5 && Number.isNaN(core.parseMoney('abc')) && Number.isNaN(core.parseMoney('-5')) && Number.isNaN(core.parseMoney('10.999')) && Number.isNaN(core.parseMoney('')) && core.parseMoney('0') === 0, '');
    const today = '2026-10-19';
    const claim = (patch, outstanding = 5000) => core.validateClaim({ amount: '2500', payment_date: '2026-10-18', ...patch }, outstanding, today);
    check('claim: a normal claim validates', Object.keys(claim({}).errors).length === 0 && claim({}).clean.amount === 2500, JSON.stringify(claim({}).errors));
    check('claim: more than is outstanding is refused, exactly the outstanding amount is fine', !!claim({ amount: '5000.01' }).errors.amount && !claim({ amount: '5000' }).errors.amount, '');
    check('claim: no amount / zero / negative is refused', !!claim({ amount: '' }).errors.amount && !!claim({ amount: '0' }).errors.amount && !!claim({ amount: '-100' }).errors.amount, '');
    check('claim: the payment date is optional, but a future, an impossible or a very old date is refused',
        !claim({ payment_date: '' }).errors.payment_date && !!claim({ payment_date: '2026-10-25' }).errors.payment_date && !!claim({ payment_date: '2026-02-30' }).errors.payment_date && !!claim({ payment_date: '2025-01-01' }).errors.payment_date && !!claim({ payment_date: 'yesterday' }).errors.payment_date, '');
    check('claim: tomorrow is tolerated (a client a timezone ahead), the day after is not', !claim({ payment_date: '2026-10-20' }).errors.payment_date && !!claim({ payment_date: '2026-10-21' }).errors.payment_date, '');
    check('claim: markup in the reference or the note is refused', !!claim({ reference: '<img src=x>' }).errors.reference && !!claim({ note: 'hi <script>' }).errors.note, '');

    const ver = (patch) => core.validateVerification({ verified_amount: '2500', verified_reference: 'FNB Ref 8841', verified_date: '2026-10-18', ...patch }, today);
    check('verification: amount, bank reference and date are all required', Object.keys(ver({}).errors).length === 0 && !!ver({ verified_amount: '' }).errors.verified_amount && !!ver({ verified_reference: '  ' }).errors.verified_reference && !!ver({ verified_date: '' }).errors.verified_date, JSON.stringify(ver({}).errors));
    check('verification: a future date and an impossible date are refused', !!ver({ verified_date: '2027-01-01' }).errors.verified_date && !!ver({ verified_date: '2026-13-01' }).errors.verified_date, '');
    check('reason: a rejection needs a real sentence for the client, and no markup', core.validateReason('no').ok === false && core.validateReason('').ok === false && core.validateReason('The amount is not on our statement.').ok === true && core.validateReason('see <b>this</b>').ok === false, '');
};
