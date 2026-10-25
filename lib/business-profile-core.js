// Business profile - the pure rules (no database, no Express), shared by the admin route, the PDF generator and the tests.
//
// ONE row describes WHO issues our quotations and invoices (company or individual), which SARS registrations apply, and where we
// are. lib/business-profile.js stores it; everything a document prints about us comes from issuerView() below, so a quotation, an
// invoice and the preview can never disagree. docs-internal/business-profile-2026.md has the audit, the legal checks and the decisions.
//
// Three things are kept deliberately apart (they are different registrations with different numbers):
//   * CIPC company registration   -> registration_number (YYYY/NNNNNN/07), enterprise_number (K + 10 digits)
//   * SARS income-tax registration -> is_tax_registered + income_tax_reference (10 digits)
//   * VAT registration             -> is_vat_registered + vat_number (10 digits, starts with 4) + the owner's "verified on SARS" attestation
// Ticking income-tax registration never means VAT.
const { decodeStoredText } = require('./html-sanitize');

const BUSINESS_TYPES = ['company', 'individual'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DIRECTOR_STATUSES = ['active', 'resigned'];
const MAX_DIRECTORS = 10;

// field -> max length. Text fields only; booleans and the secret are handled separately below.
const TEXT_FIELDS = {
    business_type: 20, legal_name: 120, trading_name: 120,
    registration_number: 30, enterprise_number: 20, cipc_tracking_number: 20, registration_date: 10,
    enterprise_type: 60, enterprise_status: 40, financial_year_end: 12,
    sars_registered_name: 120, sars_taxpayer_number: 30, income_tax_reference: 20, tax_registration_date: 10, provisional_tax_period: 6,
    vat_number: 20, vat_registration_date: 10,
    registered_address: 300, postal_address: 300, physical_address: 300, correspondence_address: 300,
    contact_email: 120, contact_phone: 30, website: 120, admin_email: 120,
    bbbee_certificate_number: 40, bbbee_level: 120, bbbee_issue_date: 10, bbbee_expiry_date: 10
};
const BOOL_FIELDS = ['is_tax_registered', 'is_vat_registered', 'vat_number_verified'];
const DATE_FIELDS = ['registration_date', 'tax_registration_date', 'vat_registration_date', 'bbbee_issue_date', 'bbbee_expiry_date'];
const ALL_FIELDS = Object.keys(TEXT_FIELDS).concat(BOOL_FIELDS, ['directors']);

// Shown to every administrator + manager. Never sent to the browser: the director's ID number (stored encrypted, revealed on demand).
const PATTERNS = {
    registration_number: /^\d{4}\/\d{6}\/\d{2}$/,
    enterprise_number: /^K\d{10}$/i,
    cipc_tracking_number: /^\d{6,15}$/,
    income_tax_reference: /^\d{10}$/,
    vat_number: /^4\d{9}$/,
    provisional_tax_period: /^\d{4}(0[1-9]|1[0-2])$/,
    email: /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]{2,}$/,
    phone: /^[+()\d][\d\s()+-]{5,28}$/,
    website: /^(https?:\/\/)?[a-z0-9][a-z0-9.-]*\.[a-z]{2,}(\/\S*)?$/i
};

const isoDate = (s) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const d = new Date(s + 'T00:00:00Z');
    return !isNaN(d) && d.toISOString().slice(0, 10) === s;
};
const truthy = (v) => v === true || v === 1 || v === '1' || v === 'true' || v === 'on';
const clean = (v, max) => {
    if (v == null) return '';
    // The request sanitiser entity-encodes every body string once; this record is stored DECODED and rendered as text (like Team/Accolades).
    return decodeStoredText(String(v)).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/\r\n?/g, '\n').trim().slice(0, max);
};

// Whitespace and a leading "K" casing are cosmetic - store the canonical form so format checks and comparisons are exact.
function canonical(field, value) {
    if (value === '') return '';
    switch (field) {
        case 'income_tax_reference': case 'vat_number': case 'cipc_tracking_number': case 'provisional_tax_period':
            return value.replace(/[\s-]/g, '');
        case 'enterprise_number': return value.replace(/\s/g, '').toUpperCase();
        case 'registration_number': return value.replace(/\s/g, '');
        case 'contact_email': case 'admin_email': return value.toLowerCase();
        default: return value;
    }
}

function parseDirectors(value) {
    if (Array.isArray(value)) return value;
    if (typeof value !== 'string' || !value.trim()) return [];
    try { const v = JSON.parse(value); return Array.isArray(v) ? v : []; } catch (e) { return []; }
}

// Turn a raw request body (or a stored row) into the canonical field set. Only keys that are PRESENT are returned, so a partial PUT
// changes only what it names.
function normalizeInput(raw) {
    const out = {};
    if (!raw || typeof raw !== 'object') return out;
    for (const [f, max] of Object.entries(TEXT_FIELDS)) {
        if (raw[f] === undefined) continue;
        out[f] = canonical(f, clean(raw[f], max));
    }
    for (const f of BOOL_FIELDS) if (raw[f] !== undefined) out[f] = truthy(raw[f]) ? 1 : 0;
    if (raw.directors !== undefined) {
        out.directors = parseDirectors(raw.directors).slice(0, MAX_DIRECTORS + 1).map(d => ({
            name: clean(d && d.name, 120), role: clean(d && d.role, 60) || 'Director',
            status: DIRECTOR_STATUSES.includes(String(d && d.status).toLowerCase()) ? String(d.status).toLowerCase() : (d && d.status ? String(d.status).toLowerCase() : 'active'),
            appointed: clean(d && d.appointed, 10)
        }));
    }
    return out;
}

// `merged` = stored row overlaid with the normalized input. Returns { errors: {field: message}, warnings: [string] }.
// The backend is the only judge: the browser mirrors some of this for convenience but is never trusted.
function validateProfile(merged, today) {
    const errors = {};
    const warnings = [];
    const m = merged || {};
    const type = m.business_type || 'company';
    const todayIso = today || new Date().toISOString().slice(0, 10);

    if (!BUSINESS_TYPES.includes(type)) errors.business_type = 'Choose Registered company or Individual / sole proprietor.';
    if (!m.legal_name) errors.legal_name = type === 'individual' ? 'Enter the full legal name (or trading name) that appears on documents.' : 'Enter the registered company name, including (PTY) LTD.';
    if (type === 'company') {
        if (!m.registration_number) errors.registration_number = 'A registered company needs its CIPC registration number (format 2025/575967/07).';
    }
    // Format checks apply to whatever is present, whatever the switches say - garbage is never stored. Blank is fine unless a rule below says otherwise.
    if (m.registration_number && !PATTERNS.registration_number.test(m.registration_number)) errors.registration_number = 'Use the CIPC format YYYY/NNNNNN/NN, for example 2025/575967/07.';
    if (m.enterprise_number && !PATTERNS.enterprise_number.test(m.enterprise_number)) errors.enterprise_number = 'The enterprise number is the letter K followed by 10 digits, for example K2025575967.';
    if (m.cipc_tracking_number && !PATTERNS.cipc_tracking_number.test(m.cipc_tracking_number)) errors.cipc_tracking_number = 'The CIPC tracking / certificate number is digits only.';
    if (m.income_tax_reference && !PATTERNS.income_tax_reference.test(m.income_tax_reference)) errors.income_tax_reference = 'A SARS income-tax reference number is 10 digits.';
    // SARS numbers are told apart by their first digit: VAT 4, PAYE 7, income tax 0 / 1 / 2 / 3 / 9. Only the clear mix-ups are refused (a number that
    // is 10 digits and starts with 4 or 7 cannot be an income-tax reference); every other first digit is accepted, because the published prefix lists
    // are secondary sources and a genuine number must never be turned away.
    else if (m.income_tax_reference && /^4/.test(m.income_tax_reference)) errors.income_tax_reference = 'This looks like a VAT number (VAT numbers start with 4). Enter it under "registered for VAT". The income-tax reference starts with 0, 1, 2, 3 or 9.';
    else if (m.income_tax_reference && /^7/.test(m.income_tax_reference)) errors.income_tax_reference = 'This looks like a PAYE reference (they start with 7), not an income-tax reference (which starts with 0, 1, 2, 3 or 9).';
    if (m.provisional_tax_period && !PATTERNS.provisional_tax_period.test(m.provisional_tax_period)) errors.provisional_tax_period = 'Use YYYYMM, for example 202508.';
    if (m.vat_number && !PATTERNS.vat_number.test(m.vat_number)) {
        errors.vat_number = (PATTERNS.income_tax_reference.test(m.vat_number) && /^[01239]/.test(m.vat_number))
            ? 'This looks like an income-tax reference number (they start with 0, 1, 2, 3 or 9). A South African VAT number is 10 digits and starts with 4.'
            : 'A South African VAT number is 10 digits and starts with 4.';
    }
    if (m.financial_year_end && !MONTHS.includes(m.financial_year_end)) errors.financial_year_end = 'Choose a month.';
    if (m.contact_email && !PATTERNS.email.test(m.contact_email)) errors.contact_email = 'Enter a valid email address.';
    if (m.admin_email && !PATTERNS.email.test(m.admin_email)) errors.admin_email = 'Enter a valid email address.';
    if (m.contact_phone && !PATTERNS.phone.test(m.contact_phone)) errors.contact_phone = 'Enter a valid phone number.';
    if (m.website && !PATTERNS.website.test(m.website)) errors.website = 'Enter a website such as www.example.co.za.';
    for (const f of DATE_FIELDS) if (m[f] && !isoDate(m[f])) errors[f] = 'Use a valid date.';
    if (!errors.bbbee_expiry_date && m.bbbee_issue_date && m.bbbee_expiry_date && m.bbbee_expiry_date < m.bbbee_issue_date) errors.bbbee_expiry_date = 'The expiry date cannot be before the issue date.';

    // Registrations. Income tax and VAT are separate switches; VAT sits on top of tax registration (a VAT vendor is a registered taxpayer).
    if (m.is_tax_registered && !m.income_tax_reference) errors.income_tax_reference = 'Enter the SARS income-tax reference number, or untick "registered for tax with SARS".';
    if (m.is_vat_registered) {
        if (!m.is_tax_registered) errors.is_vat_registered = 'VAT registration is held by a SARS-registered taxpayer. Tick "registered for tax with SARS" first, or untick VAT.';
        if (!m.vat_number) errors.vat_number = 'Enter the VAT registration number, or untick "registered for VAT".';
        else if (!errors.vat_number && !m.vat_number_verified) warnings.push('The VAT number is saved but not yet confirmed against SARS. VAT stays OFF on quotations and invoices until you tick "I have confirmed this VAT number with SARS".');
    }

    // Directors (companies only). The ID number is never part of this list.
    const dirs = Array.isArray(m.directors) ? m.directors : [];
    if (dirs.length > MAX_DIRECTORS) errors.directors = `At most ${MAX_DIRECTORS} directors can be listed.`;
    else dirs.forEach((d, i) => {
        if (!d.name) errors.directors = errors.directors || `Director ${i + 1} needs a name.`;
        if (d.appointed && !isoDate(d.appointed)) errors.directors = errors.directors || `Director ${i + 1} has an invalid appointment date.`;
        if (!DIRECTOR_STATUSES.includes(d.status)) errors.directors = errors.directors || `Director ${i + 1} status must be active or resigned.`;
    });

    const bb = bbbeeStatus(m, todayIso);
    if (bb.state === 'expired') warnings.push(`The B-BBEE certificate expired on ${m.bbbee_expiry_date}.`);
    else if (bb.state === 'expiring') warnings.push(`The B-BBEE certificate expires in ${bb.days} day${bb.days === 1 ? '' : 's'} (${m.bbbee_expiry_date}).`);
    return { errors, warnings };
}

function bbbeeStatus(m, todayIso) {
    if (!m || !m.bbbee_expiry_date || !isoDate(m.bbbee_expiry_date)) return { state: 'none', days: null };
    const t = isoDate(todayIso) ? todayIso : new Date().toISOString().slice(0, 10);
    const days = Math.round((Date.parse(m.bbbee_expiry_date + 'T00:00:00Z') - Date.parse(t + 'T00:00:00Z')) / 86400000);
    if (days < 0) return { state: 'expired', days };
    if (days <= 60) return { state: 'expiring', days };
    return { state: 'valid', days };
}

// VAT is ACTIVE (may be charged, may print a VAT number, may title an invoice TAX INVOICE) only when every link holds. Anything less
// leaves documents exactly as an unregistered business would issue them.
function vatActive(row) {
    return !!(row && row.is_tax_registered && row.is_vat_registered && row.vat_number_verified && PATTERNS.vat_number.test(String(row.vat_number || '')));
}

const oneLine = (s) => String(s || '').split('\n').map(x => x.trim()).filter(Boolean).join(', ');

// What a DOCUMENT may say about us. Built from the stored row; frozen into quotations.issuer_snapshot / invoices.issuer_snapshot when a
// document is issued. Deliberately excludes: income-tax reference, director ID, B-BBEE, admin email, banking (those are not letterhead).
function issuerView(row, fallback) {
    if (!row) return legacyIssuer(fallback);
    const company = (row.business_type || 'company') === 'company';
    const vat = vatActive(row);
    const rawAddress = row.registered_address || row.physical_address || row.postal_address || '';
    const registered = oneLine(row.registered_address) || oneLine(row.physical_address) || oneLine(row.postal_address);
    return {
        source: 'profile',
        businessType: company ? 'company' : 'individual',
        legalName: row.legal_name || (fallback && fallback.name) || '',
        tradingName: row.trading_name || '',
        registrationNumber: company ? (row.registration_number || '') : '',
        vatRegistered: vat,
        vatNumber: vat ? row.vat_number : '',
        // an honest "no VAT" statement only when the owner has said so explicitly (not when the registration is merely unconfirmed)
        notVatRegistered: !row.is_vat_registered,
        registeredOffice: registered,
        // The same address, kept as separate lines (street / suburb-city-postal / ...) instead of comma-joined - the quotation and
        // invoice header prints it one line per line (addressLines); registeredOffice (one-lined) is still what everything else uses.
        addressLines: addressLines(rawAddress),
        email: row.contact_email || '',
        phone: row.contact_phone || '',
        website: row.website || ''
    };
}

// Callers that pass no issuer (older call sites, or a database without the profile row) keep the identity they always printed.
function legacyIssuer(env) {
    const e = env || process.env;
    const addr = e.COMPANY_ADDRESS || 'Johannesburg, South Africa';
    return {
        source: 'legacy', businessType: 'company', legalName: e.COMPANY_NAME || 'Thabiso Mhlongo Management', tradingName: '',
        registrationNumber: '', vatRegistered: false, vatNumber: '', notVatRegistered: false,
        registeredOffice: addr, addressLines: addressLines(addr),
        email: e.COMPANY_EMAIL || 'bookings@thabisomhlongo.com', phone: '', website: e.COMPANY_WEBSITE || 'www.thabisomhlongo.com'
    };
}

// A raw, possibly multi-line stored address -> its non-empty lines, trimmed. Capped at 4 - a real address is 2-3 lines; this is only a
// guard against a header growing unreasonably tall if something far longer is ever pasted into the field.
function addressLines(raw) {
    return String(raw || '').split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 4);
}

// The name a quotation or invoice leads with (lib/pdfService.js header): the trading name when one is configured (meaningful, non-blank -
// that is what the field is for, a public-facing name instead of the registered legal entity), otherwise the legal name (which, for an
// individual/sole proprietor, IS already the configured business name - business-profile.js's own label for that field says so). The
// registered company name and registration number are never dropped - they still print on their own line(s) right below it.
function documentBusinessName(issuer) {
    const trading = issuer && issuer.tradingName && String(issuer.tradingName).trim();
    return trading || (issuer && issuer.legalName) || null;
}

// The title printed on a document. TAX INVOICE needs all of: VAT registered AND confirmed with SARS (issuer.vatRegistered), AND VAT
// actually charged on this document. Otherwise the plain INVOICE - never implying VAT was charged.
function documentTitle(type, issuer, vatCharged) {
    if (type === 'Quote') return 'QUOTATION';
    if (type === 'Invoice') return (issuer && issuer.vatRegistered && vatCharged) ? 'TAX INVOICE' : 'INVOICE';
    return String(type || '').toUpperCase();
}

// Advisory only (never blocks): what a VAT-registered business should still capture on a full tax invoice (supply over R5,000, VAT Act s20).
// Per SARS the recipient's VAT number is needed when the recipient is a VAT vendor, so a missing number is a prompt to ask, not an error.
const FULL_TAX_INVOICE_OVER = 5000;
// A customer's VAT number as typed on a form: spaces/dashes are ignored; '' = none given; null = not a South African VAT number (10 digits, starts with 4).
function normaliseClientVat(value) {
    const s = String(value == null ? '' : value).replace(/[\s-]/g, '');
    if (!s) return '';
    return PATTERNS.vat_number.test(s) ? s : null;
}
const CLIENT_VAT_MESSAGE = 'A South African VAT number is 10 digits and starts with 4 (for example 4010123456). Leave it empty if you are not a VAT vendor.';

function taxInvoiceAdvice(issuer, { total, vatCharged, clientName, clientAddress, clientVat, clientCompany } = {}) {
    const out = [];
    if (!issuer || !issuer.vatRegistered || !vatCharged) return out;
    if ((parseFloat(total) || 0) > FULL_TAX_INVOICE_OVER) {
        if (!clientName) out.push('A full tax invoice needs the customer\'s name.');
        if (!clientAddress) out.push('A full tax invoice (over R5,000) needs the customer\'s address - none is on record.');
        if (clientCompany && !clientVat) out.push('The customer is a company with no VAT number on record. If it is a VAT vendor its VAT number must appear on this tax invoice.');
    }
    return out;
}

// Shapes for the admin API. The income-tax reference is masked for managers; the director ID never travels.
function mask(value, keep = 3) {
    const s = String(value || '');
    return s.length <= keep ? s : '•'.repeat(s.length - keep) + s.slice(-keep);
}

module.exports = {
    normaliseClientVat, CLIENT_VAT_MESSAGE, BUSINESS_TYPES, MONTHS, DIRECTOR_STATUSES, TEXT_FIELDS, BOOL_FIELDS, ALL_FIELDS, PATTERNS, FULL_TAX_INVOICE_OVER,
    normalizeInput, validateProfile, bbbeeStatus, vatActive, issuerView, legacyIssuer, documentTitle, documentBusinessName, taxInvoiceAdvice, parseDirectors, mask, oneLine, isoDate
};
