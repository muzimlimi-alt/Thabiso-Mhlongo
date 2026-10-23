// Business profile - table definition and the first-boot row (migration 110).
//
// SEED RULES (the repo is public, so this file carries ONLY what the CIPC register already makes public):
//   * legal identity, registration numbers, dates, registered address, director's NAME, B-BBEE certificate details;
//   * NO income-tax reference, NO director ID number, NO banking, NO personal email - the administrator types those into
//     Business > Business Profile (banking stays where it already lives: the versioned bank_details / EFT card).
//   * Both registration switches start OFF. Income-tax registration is turned on by the administrator together with the reference
//     number; VAT is turned on only after the VAT number is confirmed. Nothing here can switch VAT on - EXCEPT an existing
//     COMPANY_VAT_NUMBER environment setting, which is carried over once (that setting already made the old PDF code add VAT).
//   * INSERT OR IGNORE: an administrator's edits are never overwritten by a restart.
const { PATTERNS } = require('./business-profile-core');

const COLUMNS = [
    ['business_type', "TEXT NOT NULL DEFAULT 'company'"],
    ['legal_name', "TEXT NOT NULL DEFAULT ''"], ['trading_name', "TEXT NOT NULL DEFAULT ''"],
    ['registration_number', "TEXT NOT NULL DEFAULT ''"], ['enterprise_number', "TEXT NOT NULL DEFAULT ''"], ['cipc_tracking_number', "TEXT NOT NULL DEFAULT ''"],
    ['registration_date', "TEXT NOT NULL DEFAULT ''"], ['enterprise_type', "TEXT NOT NULL DEFAULT ''"], ['enterprise_status', "TEXT NOT NULL DEFAULT ''"],
    ['financial_year_end', "TEXT NOT NULL DEFAULT ''"],
    ['is_tax_registered', 'INTEGER NOT NULL DEFAULT 0'],
    ['sars_registered_name', "TEXT NOT NULL DEFAULT ''"], ['sars_taxpayer_number', "TEXT NOT NULL DEFAULT ''"], ['income_tax_reference', "TEXT NOT NULL DEFAULT ''"],
    ['tax_registration_date', "TEXT NOT NULL DEFAULT ''"], ['provisional_tax_period', "TEXT NOT NULL DEFAULT ''"],
    ['is_vat_registered', 'INTEGER NOT NULL DEFAULT 0'], ['vat_number', "TEXT NOT NULL DEFAULT ''"], ['vat_registration_date', "TEXT NOT NULL DEFAULT ''"],
    ['vat_number_verified', 'INTEGER NOT NULL DEFAULT 0'], ['vat_verified_at', 'DATETIME'], ['vat_verified_by', 'TEXT'],
    ['registered_address', "TEXT NOT NULL DEFAULT ''"], ['postal_address', "TEXT NOT NULL DEFAULT ''"],
    ['physical_address', "TEXT NOT NULL DEFAULT ''"], ['correspondence_address', "TEXT NOT NULL DEFAULT ''"],
    ['contact_email', "TEXT NOT NULL DEFAULT ''"], ['contact_phone', "TEXT NOT NULL DEFAULT ''"], ['website', "TEXT NOT NULL DEFAULT ''"], ['admin_email', "TEXT NOT NULL DEFAULT ''"],
    ['directors', "TEXT NOT NULL DEFAULT '[]'"], ['director_id_enc', 'TEXT'],
    ['bbbee_certificate_number', "TEXT NOT NULL DEFAULT ''"], ['bbbee_level', "TEXT NOT NULL DEFAULT ''"],
    ['bbbee_issue_date', "TEXT NOT NULL DEFAULT ''"], ['bbbee_expiry_date', "TEXT NOT NULL DEFAULT ''"],
    ['version', 'INTEGER NOT NULL DEFAULT 1'], ['updated_by', 'INTEGER'], ['updated_at', 'DATETIME DEFAULT CURRENT_TIMESTAMP']
];

const CREATE_SQL = `CREATE TABLE IF NOT EXISTS business_profile (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    ${COLUMNS.map(([c, d]) => `${c} ${d}`).join(',\n    ')}
)`;

function seedRow(env) {
    const e = env || process.env;
    const envVat = String(e.COMPANY_VAT_NUMBER || '').replace(/[\s-]/g, '');
    const carryVat = PATTERNS.vat_number.test(envVat);
    const row = {
        id: 1,
        business_type: 'company',
        legal_name: 'MTV CREATIVES (PTY) LTD',
        registration_number: '2025/575967/07', enterprise_number: 'K2025575967', cipc_tracking_number: '9439823846',
        registration_date: '2025-07-19', enterprise_type: 'Private company', enterprise_status: 'In business', financial_year_end: 'July',
        sars_registered_name: 'MTV CREATIVES', sars_taxpayer_number: '2025/575967/07', tax_registration_date: '2025-07-19', provisional_tax_period: '202508',
        registered_address: '59 Stone Crest, Frederick Street\nKengies / Stone Crest, Fourways\nGauteng, 0059',
        postal_address: '59 Stone Crest, Frederick Street\nKengies / Stone Crest, Fourways\nGauteng, 0059',
        contact_email: e.COMPANY_EMAIL || 'bookings@thabisomhlongo.com',
        website: e.COMPANY_WEBSITE || 'www.thabisomhlongo.com',
        directors: JSON.stringify([{ name: 'Thabiso Mhlongo', role: 'Director', status: 'active', appointed: '2025-07-19' }]),
        bbbee_certificate_number: '9439823846', bbbee_level: 'Level 1 contributor (Exempted Micro Enterprise) - 135% procurement recognition',
        bbbee_issue_date: '2025-11-19', bbbee_expiry_date: '2026-11-18'
    };
    if (carryVat) Object.assign(row, { is_tax_registered: 1, is_vat_registered: 1, vat_number: envVat, vat_number_verified: 1, vat_verified_by: 'carried over from COMPANY_VAT_NUMBER' });
    return row;
}

function insertParams(row) {
    const cols = Object.keys(row);
    return { sql: `INSERT OR IGNORE INTO business_profile (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, params: cols.map(c => row[c]) };
}

module.exports = { COLUMNS, CREATE_SQL, seedRow, insertParams, MIGRATION_VERSION: 110, MIGRATION_NAME: 'business_profile_and_document_issuer' };
