// Business profile - storage and the admin view. The rules live in lib/business-profile-core.js (pure); this file only reads and writes.
//
//   loadIssuer()          what a new quotation / invoice may say about us (the ONE source every document generator uses)
//   snapshotOf(issuer)    the JSON frozen into quotations.issuer_snapshot / invoices.issuer_snapshot when a document is issued
//   adminView(role)       everything the Business Profile page shows
//   saveProfile(...)      validate -> confirm registration changes -> write -> audit
//
// Banking is NOT stored here: bank_details (lib/eft.js) stays the single source, this file only reads the active version to show it and to
// cross-check the account holder against the legal name.
const db = require('../database');
const { dbGet, dbRun } = require('./db-helpers');
const { logAudit } = require('./audit-log');
const core = require('./business-profile-core');
const eftCore = require('./eft-core');
const { getVatRate } = require('./document-totals');

const SENSITIVE_FOR_MANAGERS = ['income_tax_reference'];

async function getRow() {
    try { return (await dbGet('SELECT * FROM business_profile WHERE id = 1')) || null; }
    catch (e) { return null; }   // a database that has not run migration 110 yet: documents fall back to the legacy identity
}

function rowToProfile(row) {
    if (!row) return null;
    const p = Object.assign({}, row);
    p.directors = core.parseDirectors(row.directors);
    delete p.director_id_enc;
    p.director_id_set = !!row.director_id_enc;
    return p;
}

async function loadIssuer() {
    return core.issuerView(await getRow());
}

function snapshotOf(issuer) {
    const i = issuer || {};
    return JSON.stringify({
        v: 1, source: i.source || 'legacy', businessType: i.businessType, legalName: i.legalName, tradingName: i.tradingName || '',
        registrationNumber: i.registrationNumber || '', vatRegistered: !!i.vatRegistered, vatNumber: i.vatNumber || '',
        registeredOffice: i.registeredOffice || '', email: i.email || '', phone: i.phone || '', website: i.website || '',
        issuedAt: new Date().toISOString()
    });
}

// An invoice follows the identity the QUOTATION it came from carried (the commercial agreement), not whatever the profile says today.
// A quotation made before migration 110 has no snapshot -> the current profile is used (the same as before this feature existed).
function issuerFromSnapshot(json) {
    if (!json) return null;
    try {
        const s = JSON.parse(json);
        if (!s || typeof s !== 'object' || !s.legalName) return null;
        return {
            source: 'snapshot', businessType: s.businessType || 'company', legalName: s.legalName, tradingName: s.tradingName || '',
            registrationNumber: s.registrationNumber || '', vatRegistered: !!s.vatRegistered, vatNumber: s.vatRegistered ? (s.vatNumber || '') : '',
            notVatRegistered: !s.vatRegistered && !s.vatNumber, registeredOffice: s.registeredOffice || '', email: s.email || '', phone: s.phone || '', website: s.website || ''
        };
    } catch (e) { return null; }
}

const luhn = (id) => {
    let sum = 0;
    for (let i = 0; i < id.length; i++) {
        let d = parseInt(id[id.length - 1 - i], 10);
        if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
        sum += d;
    }
    return sum % 10 === 0;
};

async function bankingSummary(legalName) {
    let bank = null, enabled = false;
    try { bank = await dbGet('SELECT * FROM bank_details WHERE is_active = 1'); } catch (e) { /* table missing on an old database */ }
    try { const s = await dbGet('SELECT enabled FROM eft_settings WHERE id = 1'); enabled = !!(s && s.enabled); } catch (e) { /* same */ }
    if (!bank) return { configured: false, eft_enabled: enabled };
    const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    return {
        configured: true, eft_enabled: enabled, version: bank.version, account_holder: bank.account_holder, bank_name: bank.bank_name,
        account_number_masked: eftCore.maskAccountNumber(bank.account_number), account_type: bank.account_type, branch_code: bank.branch_code, swift_code: bank.swift_code || '',
        holder_matches_legal_name: !!legalName && norm(bank.account_holder) === norm(legalName)
    };
}

async function vatRateInfo() {
    let from = null;
    try { const r = await dbGet(`SELECT effective_from FROM tax_rates WHERE COALESCE(is_default,0)=1 AND (effective_from IS NULL OR effective_from <= date('now')) AND (effective_to IS NULL OR effective_to >= date('now')) ORDER BY effective_from DESC, id DESC LIMIT 1`); from = r ? r.effective_from : null; } catch (e) { /* none */ }
    return { rate: await getVatRate(), effective_from: from };
}

async function adminView(role) {
    const row = await getRow();
    const profile = rowToProfile(row);
    if (!profile) return { success: true, profile: null, missing: true };
    const isAdmin = role === 'administrator';
    const issuer = core.issuerView(row);
    const out = {
        success: true, can_edit: isAdmin, profile,
        computed: {
            vat_active: core.vatActive(row), issuer,
            titles: { quote: core.documentTitle('Quote', issuer, false), invoice_without_vat: core.documentTitle('Invoice', issuer, false), invoice_with_vat: core.documentTitle('Invoice', issuer, true) },
            bbbee: core.bbbeeStatus(profile), vat_rate: await vatRateInfo(), banking: await bankingSummary(profile.legal_name),
            warnings: core.validateProfile(core.normalizeInput(profile)).warnings
        },
        options: { business_types: core.BUSINESS_TYPES, months: core.MONTHS }
    };
    if (!isAdmin) SENSITIVE_FOR_MANAGERS.forEach(f => { if (out.profile[f]) out.profile[f] = core.mask(out.profile[f], 3); });
    return out;
}

// The registration facts whose change alters what future documents say or charge. Changing any needs an explicit confirmation.
const REGISTRATION_FIELDS = ['is_tax_registered', 'is_vat_registered', 'vat_number', 'vat_number_verified', 'business_type'];
function registrationChanges(existing, merged) {
    const label = { is_tax_registered: 'registered for tax with SARS', is_vat_registered: 'registered for VAT', vat_number: 'VAT number', vat_number_verified: 'VAT number confirmed with SARS', business_type: 'business type' };
    return REGISTRATION_FIELDS.filter(f => String(existing[f] == null ? '' : existing[f]) !== String(merged[f] == null ? '' : merged[f])).map(f => ({ field: f, label: label[f], from: existing[f], to: merged[f] }));
}

// body: the (already request-sanitised) JSON. Returns { status, body } for the route to send.
async function saveProfile(body, req) {
    const existing = await getRow();
    if (!existing) return { status: 500, body: { success: false, message: 'The business profile is not set up yet - restart the server so the database upgrade can run.' } };
    const input = core.normalizeInput(body);
    const merged = Object.assign({}, existing, input);
    merged.directors = input.directors !== undefined ? input.directors : core.parseDirectors(existing.directors);
    for (const f of core.BOOL_FIELDS) merged[f] = merged[f] ? 1 : 0;

    // optimistic concurrency: two administrators editing at once must not silently overwrite each other
    if (body.version !== undefined && parseInt(body.version, 10) !== existing.version) {
        return { status: 409, body: { success: false, code: 'STALE', message: 'Someone else changed the business profile since you opened it. Reload the page and re-apply your changes.' } };
    }

    // a NEW VAT number has to be re-confirmed with SARS; the attestation in this very request counts for the number in this request
    const numberChanged = merged.vat_number !== existing.vat_number;
    if (numberChanged && input.vat_number_verified === undefined) merged.vat_number_verified = 0;

    const { errors, warnings } = core.validateProfile(merged);

    let directorIdEnc;   // undefined = leave as is
    const rawId = body.director_id_number == null ? '' : String(body.director_id_number).replace(/[\s-]/g, '');
    if (body.clear_director_id === true || body.clear_director_id === 'true') directorIdEnc = null;
    else if (rawId) {
        if (!/^\d{13}$/.test(rawId) || !luhn(rawId)) errors.director_id_number = 'A South African ID number is 13 digits and must pass its check digit.';
        else {
            try { directorIdEnc = require('./smtp-config').encryptSecret(rawId); }
            catch (e) { return { status: 500, body: { success: false, message: e.message } }; }
        }
    }

    if (Object.keys(errors).length) return { status: 400, body: { success: false, message: 'Business profile not saved: ' + Object.values(errors).join(' '), errors, warnings } };

    const changes = registrationChanges(existing, merged);
    if (changes.length && !(body.confirm_registration_change === true || body.confirm_registration_change === 'true')) {
        return { status: 409, body: { success: false, code: 'CONFIRM_REQUIRED', changes, message: 'This changes what future quotations and invoices say and charge. Confirm the change to save it. Documents already issued are not changed.' } };
    }

    const adminId = req && req.session ? req.session.adminId || null : null;
    const cols = Object.keys(core.TEXT_FIELDS).concat(core.BOOL_FIELDS);
    const sets = cols.map(c => `${c} = ?`);
    const params = cols.map(c => merged[c]);
    sets.push('directors = ?'); params.push(JSON.stringify(merged.directors));
    // who confirmed the VAT number, and when - only when this save is the one that confirmed it
    if (merged.vat_number_verified && (!existing.vat_number_verified || numberChanged)) { sets.push('vat_verified_at = CURRENT_TIMESTAMP', 'vat_verified_by = ?'); params.push(String(adminId || 'admin')); }
    if (!merged.vat_number_verified && existing.vat_number_verified) { sets.push('vat_verified_at = NULL', 'vat_verified_by = NULL'); }
    if (directorIdEnc !== undefined) { sets.push('director_id_enc = ?'); params.push(directorIdEnc); }
    sets.push('version = version + 1', 'updated_by = ?', 'updated_at = CURRENT_TIMESTAMP'); params.push(adminId);
    const res = await dbRun(`UPDATE business_profile SET ${sets.join(', ')} WHERE id = 1 AND version = ?`, params.concat([existing.version]));
    if (!res.changes) return { status: 409, body: { success: false, code: 'STALE', message: 'Someone else changed the business profile at the same moment. Reload and try again.' } };

    const diff = { old: {}, new: {} };
    for (const c of cols.concat(['directors'])) {
        const a = c === 'directors' ? JSON.stringify(core.parseDirectors(existing.directors)) : String(existing[c] == null ? '' : existing[c]);
        const b = c === 'directors' ? JSON.stringify(merged.directors) : String(merged[c] == null ? '' : merged[c]);
        if (a !== b) { diff.old[c] = SENSITIVE_FOR_MANAGERS.includes(c) ? core.mask(a, 3) : a; diff.new[c] = SENSITIVE_FOR_MANAGERS.includes(c) ? core.mask(b, 3) : b; }
    }
    if (directorIdEnc !== undefined) { diff.new.director_id = directorIdEnc ? 'set' : 'cleared'; diff.old.director_id = existing.director_id_enc ? 'set' : 'not set'; }
    logAudit({ tableName: 'business_profile', recordId: 1, action: 'update', req, oldValues: diff.old, newValues: diff.new, reason: changes.length ? 'registration change confirmed: ' + changes.map(c => c.label).join(', ') : undefined })
        .catch(e => console.error('logAudit failed:', e.message));
    return { status: 200, body: Object.assign(await adminView('administrator'), { saved: true, warnings }) };
}

async function revealDirectorId(req) {
    const row = await getRow();
    if (!row || !row.director_id_enc) return { status: 404, body: { success: false, message: 'No ID number is stored.' } };
    const plain = require('./smtp-config').decryptSecret(row.director_id_enc);
    if (!plain) return { status: 500, body: { success: false, message: 'The stored ID number cannot be decrypted on this server (the encryption key changed).' } };
    logAudit({ tableName: 'business_profile', recordId: 1, action: 'reveal_director_id', req, oldValues: null, newValues: null }).catch(e => console.error('logAudit failed:', e.message));
    return { status: 200, body: { success: true, director_id_number: plain } };
}

module.exports = { getRow, loadIssuer, snapshotOf, issuerFromSnapshot, adminView, saveProfile, revealDirectorId, registrationChanges };
