// Manual EFT payments - the rules that need no database: what counts as valid banking details, how an account number is masked for logs,
// what a proof-of-payment file really is (its bytes, not its name), what a client may claim, what an admin must verify.
// Kept free of any require() that opens the database so tests (and the PDF/e-mail code) can load it without side effects.
// The database side is lib/eft.js, the review/ledger side lib/eft-approval.js; the full picture is docs-internal/eft-payments.md.
const { decodeStoredText } = require('./html-sanitize');

// ---------------------------------------------------------------- banking details

const ACCOUNT_TYPES = Object.freeze({ current: 'Current / Cheque', savings: 'Savings', transmission: 'Transmission', business: 'Business' });
const ACCOUNT_TYPE_ALIASES = Object.freeze({ cheque: 'current', checking: 'current', cheque_account: 'current', current_account: 'current' });

// Banking details are stored as validated PLAIN text (like accolades and the team - lib/html-sanitize.js describes the other, entity-encoded
// convention): the request body arrives entity-encoded, so it is decoded first and then held to a strict character set. Every consumer that
// prints it as HTML escapes it itself.
const NAME_CHARS = /^[\p{L}\p{N} &.,'()\/+@#-]+$/u;
const FREE_TEXT_CHARS = /^[^<>`\u0000-\u0008\u000B-\u001F\u007F]*$/;

const tidy = (v) => decodeStoredText(v == null ? '' : String(v)).replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();

// input: the raw fields of the admin form. Returns { clean, errors }; `clean` is only meaningful when `errors` is empty.
function validateBankDetails(input) {
    const src = input || {};
    const errors = {};
    const clean = {};

    clean.account_holder = tidy(src.account_holder).replace(/\n/g, ' ');
    if (clean.account_holder.length < 2 || clean.account_holder.length > 100) errors.account_holder = 'Account holder must be 2 to 100 characters.';
    else if (!NAME_CHARS.test(clean.account_holder)) errors.account_holder = 'Account holder may only contain letters, numbers, spaces and & . , \' ( ) / + @ # -';

    clean.bank_name = tidy(src.bank_name).replace(/\n/g, ' ');
    if (clean.bank_name.length < 2 || clean.bank_name.length > 60) errors.bank_name = 'Bank name must be 2 to 60 characters.';
    else if (!NAME_CHARS.test(clean.bank_name)) errors.bank_name = 'Bank name may only contain letters, numbers, spaces and & . , \' ( ) / + @ # -';

    clean.account_number = String(src.account_number == null ? '' : src.account_number).replace(/[\s-]/g, '');
    if (!/^\d{6,16}$/.test(clean.account_number)) errors.account_number = 'Account number must be 6 to 16 digits.';

    const typeKey = String(src.account_type == null ? '' : src.account_type).trim().toLowerCase().replace(/[\s/-]+/g, '_');
    clean.account_type = ACCOUNT_TYPE_ALIASES[typeKey] || typeKey;
    if (!Object.prototype.hasOwnProperty.call(ACCOUNT_TYPES, clean.account_type)) errors.account_type = 'Choose an account type: ' + Object.keys(ACCOUNT_TYPES).join(', ') + '.';

    clean.branch_code = String(src.branch_code == null ? '' : src.branch_code).replace(/[\s-]/g, '');
    if (!/^\d{5,8}$/.test(clean.branch_code)) errors.branch_code = 'Branch code must be 5 to 8 digits.';

    const swift = String(src.swift_code == null ? '' : src.swift_code).replace(/\s/g, '').toUpperCase();
    if (swift && !/^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(swift)) errors.swift_code = 'SWIFT / BIC code must be 8 or 11 letters and digits (or left blank).';
    clean.swift_code = swift || null;

    clean.reference_note = tidy(src.reference_note).replace(/\n/g, ' ') || null;
    if (clean.reference_note && (clean.reference_note.length > 200 || !FREE_TEXT_CHARS.test(clean.reference_note))) errors.reference_note = 'The reference note must be under 200 characters and cannot contain < > or backticks.';

    clean.payment_instructions = tidy(src.payment_instructions) || null;
    if (clean.payment_instructions && (clean.payment_instructions.length > 500 || !FREE_TEXT_CHARS.test(clean.payment_instructions))) errors.payment_instructions = 'The payment instructions must be under 500 characters and cannot contain < > or backticks.';

    return { clean, errors };
}

// 1234567890 -> ******7890. Used everywhere an account number could reach a log, an audit row or an error message.
function maskAccountNumber(n) {
    const s = String(n == null ? '' : n).replace(/\s/g, '');
    if (!s) return '';
    if (s.length <= 4) return '*'.repeat(s.length);
    return '*'.repeat(s.length - 4) + s.slice(-4);
}

const DETAIL_FIELDS = ['account_holder', 'bank_name', 'account_number', 'account_type', 'branch_code', 'swift_code', 'reference_note', 'payment_instructions'];

function sameBankDetails(a, b) {
    if (!a || !b) return false;
    return DETAIL_FIELDS.every(f => String(a[f] == null ? '' : a[f]) === String(b[f] == null ? '' : b[f]));
}
function changedBankFields(before, after) {
    return DETAIL_FIELDS.filter(f => String((before || {})[f] == null ? '' : before[f]) !== String((after || {})[f] == null ? '' : after[f]));
}

// A row as it may appear in an audit entry or a log line: the account number masked, nothing else secret.
function auditViewOfBankDetails(row) {
    if (!row) return null;
    const out = {};
    for (const f of ['id', 'version', 'account_holder', 'bank_name', 'account_type', 'branch_code', 'swift_code', 'reference_note', 'payment_instructions', 'is_active']) out[f] = row[f] == null ? null : row[f];
    out.account_number = maskAccountNumber(row.account_number);
    return out;
}

// The one shape of banking details that is printed (invoice PDF, invoice e-mail) or shown to a verified client. Complete, because a client
// cannot pay into a masked number - the account number is only ever masked for LOGS.
function printableBankDetails(row, reference) {
    if (!row) return null;
    return {
        version: row.version,
        accountHolder: row.account_holder,
        bankName: row.bank_name,
        accountNumber: row.account_number,
        accountType: ACCOUNT_TYPES[row.account_type] || row.account_type,
        branchCode: row.branch_code,
        swiftCode: row.swift_code || null,
        referenceNote: row.reference_note || null,
        paymentInstructions: row.payment_instructions || null,
        reference: reference || null
    };
}

// What the client must put on the transfer: the invoice number (it is what the invoice already tells them to quote), else the booking.
function paymentReference(bookingId, invoiceNumber) {
    return invoiceNumber ? String(invoiceNumber) : `BOOKING-${bookingId}`;
}

// ---------------------------------------------------------------- proof-of-payment files

const PROOF_TYPES = Object.freeze({
    'application/pdf': { ext: 'pdf', label: 'PDF' },
    'image/jpeg': { ext: 'jpg', label: 'JPG' },
    'image/png': { ext: 'png', label: 'PNG' }
});
const DECLARED_MIME_ALIASES = Object.freeze({ 'image/jpg': 'image/jpeg', 'image/pjpeg': 'image/jpeg', 'application/x-pdf': 'application/pdf' });
const MAX_UPLOAD_MB_DEFAULT = 5;
const MAX_UPLOAD_MB_LIMIT = 15;

// What a file REALLY is, from its first bytes. The name and the declared content type are the client's claim and prove nothing.
function sniffProofType(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < 8) return null;
    if (buf.slice(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
    if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'image/jpeg';
    if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) return 'image/png';
    return null;
}

// file: { buffer, mimetype, originalname }. Returns { ok, mime, ext, label } or { ok:false, message }.
function checkProofFile(file, maxMb) {
    if (!file || !Buffer.isBuffer(file.buffer) || file.buffer.length === 0) return { ok: false, message: 'Please attach your proof of payment.' };
    const limit = Math.max(1, Math.min(MAX_UPLOAD_MB_LIMIT, parseInt(maxMb, 10) || MAX_UPLOAD_MB_DEFAULT)) * 1024 * 1024;
    if (file.buffer.length > limit) return { ok: false, message: `That file is too large. The limit is ${Math.round(limit / 1024 / 1024)} MB.` };
    const declared = DECLARED_MIME_ALIASES[String(file.mimetype || '').toLowerCase()] || String(file.mimetype || '').toLowerCase();
    if (!PROOF_TYPES[declared]) return { ok: false, message: 'Only PDF, JPG or PNG files are accepted.' };
    const real = sniffProofType(file.buffer);
    if (!real) return { ok: false, message: 'That file is not a valid PDF, JPG or PNG.' };
    if (real !== declared) return { ok: false, message: 'The file contents do not match its type. Please upload the original PDF, JPG or PNG.' };
    return { ok: true, mime: real, ext: PROOF_TYPES[real].ext, label: PROOF_TYPES[real].label };
}

// The name a person recognises, never one that can climb out of a folder or break a header. Display only: the file is stored under a random name.
function safeDisplayName(name) {
    const base = String(name == null ? '' : name).split(/[\\/]/).pop().replace(/[^\p{L}\p{N}._ ()-]+/gu, '_').replace(/^\.+/, '').trim();
    return (base || 'proof').slice(0, 120);
}

// ---------------------------------------------------------------- amounts and dates

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

function parseMoney(v) {
    if (v == null) return NaN;
    const s = String(v).trim().replace(/^R\s*/i, '').replace(/[\s,]/g, '');
    if (!/^\d+(\.\d{1,2})?$/.test(s)) return NaN;
    return round2(parseFloat(s));
}

function isIsoDate(s) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))) return false;
    const d = new Date(s + 'T00:00:00Z');
    return !isNaN(d) && d.toISOString().slice(0, 10) === s;
}

const addDays = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);

// What a client says they paid. Amount: positive and not more than is still owed (a typo is caught here, not at the bank). Date: optional,
// a real date within the last 180 days and not in the future. today: 'YYYY-MM-DD'.
function validateClaim(fields, outstanding, today) {
    const f = fields || {};
    const errors = {};
    const clean = {};
    clean.amount = parseMoney(f.amount);
    if (!(clean.amount > 0)) errors.amount = 'Enter the amount you paid, for example 2500.00.';
    else if (clean.amount > round2(outstanding) + 0.009) errors.amount = `That is more than the R${round2(outstanding).toFixed(2)} still outstanding on this booking.`;

    const date = String(f.payment_date == null ? '' : f.payment_date).trim();
    if (date) {
        if (!isIsoDate(date)) errors.payment_date = 'Enter the payment date as YYYY-MM-DD.';
        else if (date > addDays(today, 1)) errors.payment_date = 'The payment date cannot be in the future.';
        else if (date < addDays(today, -180)) errors.payment_date = 'That payment date is too long ago. Please contact us instead.';
        else clean.payment_date = date;
    }

    clean.reference = tidy(f.reference).replace(/\n/g, ' ').slice(0, 100) || null;
    if (clean.reference && !FREE_TEXT_CHARS.test(clean.reference)) errors.reference = 'The reference cannot contain < > or backticks.';
    clean.note = tidy(f.note).slice(0, 500) || null;
    if (clean.note && !FREE_TEXT_CHARS.test(clean.note)) errors.note = 'The note cannot contain < > or backticks.';
    return { clean, errors };
}

// What an administrator must establish before a proof becomes money: the amount, the bank's reference, the date it reached the account.
function validateVerification(fields, today) {
    const f = fields || {};
    const errors = {};
    const clean = {};
    clean.amount = parseMoney(f.verified_amount);
    if (!(clean.amount > 0)) errors.verified_amount = 'Enter the amount that reached the bank account.';
    clean.reference = tidy(f.verified_reference).replace(/\n/g, ' ');
    if (!clean.reference) errors.verified_reference = 'Enter the reference shown on the bank statement.';
    else if (clean.reference.length > 100 || !FREE_TEXT_CHARS.test(clean.reference)) errors.verified_reference = 'The reference must be under 100 characters and cannot contain < > or backticks.';
    const date = String(f.verified_date == null ? '' : f.verified_date).trim();
    if (!isIsoDate(date)) errors.verified_date = 'Enter the date the money reached the account (YYYY-MM-DD).';
    else if (date > addDays(today, 1)) errors.verified_date = 'The date cannot be in the future.';
    else clean.date = date;
    clean.note = tidy(f.note).slice(0, 500) || null;
    return { clean, errors };
}

// A reason that is shown to the client has to say something.
function validateReason(note) {
    const t = tidy(note).slice(0, 500);
    if (t.length < 3) return { ok: false, message: 'Please give the client a reason (at least a few words).' };
    if (!FREE_TEXT_CHARS.test(t)) return { ok: false, message: 'The reason cannot contain < > or backticks.' };
    return { ok: true, note: t };
}

module.exports = {
    ACCOUNT_TYPES, PROOF_TYPES, MAX_UPLOAD_MB_DEFAULT, MAX_UPLOAD_MB_LIMIT, DETAIL_FIELDS,
    validateBankDetails, maskAccountNumber, sameBankDetails, changedBankFields, auditViewOfBankDetails, printableBankDetails, paymentReference,
    sniffProofType, checkProofFile, safeDisplayName,
    round2, parseMoney, isIsoDate, addDays, validateClaim, validateVerification, validateReason, tidy
};
