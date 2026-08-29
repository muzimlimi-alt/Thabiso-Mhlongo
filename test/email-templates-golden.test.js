// Characterisation test for js/emailTemplates.js, per Phase 2 of the housekeeping plan: "email
// rendering for each template in js/emailTemplates.js, with merge fields populated. Snapshot the
// rendered HTML to test/golden/." This module exports exactly two functions —
// createEmailWrapper (the legacy email shell) and createQuoteTable — both called directly here
// with merge-field-shaped arguments, the same way email.test.js already snapshots
// emailComponents.renderSystemEmail() output for the cron-digest and PayFast-alert guards.
//
// createEmailWrapper is largely superseded: js/emailService.js only calls it when a caller does
// NOT set preWrapped:true, and every live email path this suite's other tests exercise
// (email.test.js) sets preWrapped:true, routing through emailComponents.js instead — see
// server.js's own comments calling this "the currently-disabled createEmailWrapper path". It is
// not yet proven dead by the four-check rule in AGENTS.md section 4 (a full source/DB/template/
// runtime sweep is Phase 8's job, not Phase 2's), so it is characterised here as still-live code,
// not quarantined or skipped.
const fs = require('fs');
const path = require('path');
const emailTemplates = require('../js/emailTemplates');

const GOLDEN_DIR = path.join(__dirname, 'golden');

function compareGolden(name, actual) {
    if (!fs.existsSync(GOLDEN_DIR)) fs.mkdirSync(GOLDEN_DIR, { recursive: true });
    const file = path.join(GOLDEN_DIR, name);
    if (!fs.existsSync(file)) {
        fs.writeFileSync(file, actual, 'utf8');
        return { pass: true, detail: `golden file created (first run): ${name}` };
    }
    const golden = fs.readFileSync(file, 'utf8');
    return { pass: golden === actual, detail: golden === actual ? 'matches golden' : `DIFFERS from golden ${name} (lengths: golden=${golden.length} actual=${actual.length})` };
}

module.exports = async function ({ check }) {
    // ── createQuoteTable: merge-field-populated rows, as a quote-summary caller would build them ──
    const quoteRows = [
        { label: 'Service', value: 'Travel Buyout – Gauteng' },
        { label: 'Amount', value: 'R 2 500.00' },
        { label: 'Total Due', value: 'R 2 500.00', highlight: true },
    ];
    const tableHtml = emailTemplates.createQuoteTable(quoteRows);
    check('createQuoteTable: renders one <tr> per row', (tableHtml.match(/<tr>/g) || []).length === quoteRows.length, `rows=${(tableHtml.match(/<tr>/g) || []).length}`);
    check('createQuoteTable: every label/value renders verbatim', quoteRows.every(r => tableHtml.includes(r.label) && tableHtml.includes(r.value)),
        quoteRows.filter(r => !tableHtml.includes(r.label) || !tableHtml.includes(r.value)).map(r => r.label).join(', ') || 'all present');
    check('createQuoteTable: the highlighted row uses the gold accent color, others do not',
        tableHtml.includes('#D4AF37') && (tableHtml.match(/#D4AF37/g) || []).length === 1,
        `#D4AF37 occurrences=${(tableHtml.match(/#D4AF37/g) || []).length}`);
    const tableGolden = compareGolden('createQuoteTable.golden.html', tableHtml);
    check('createQuoteTable: matches golden snapshot', tableGolden.pass, tableGolden.detail);

    // ── createEmailWrapper: full shell, merge fields populated (title, content, unsubscribe link,
    // banner image, social links) — the richest call shape any real caller uses ──
    const content = `<p>Hi {{name}}, your booking <strong>#{{booking_id}}</strong> is confirmed.</p>${tableHtml}`;
    const wrapperHtml = emailTemplates.createEmailWrapper(
        content,
        'Booking Confirmed',
        'https://example.invalid/unsubscribe?token=test-token',
        'https://example.invalid/banner.jpg',
        [{ platform_name: 'Instagram', platform_url: 'https://instagram.com/example' }],
        'banner'
    );
    check('createEmailWrapper: single DOCTYPE (no double-wrap)', (wrapperHtml.match(/<!DOCTYPE/g) || []).length === 1, `count=${(wrapperHtml.match(/<!DOCTYPE/g) || []).length}`);
    check('createEmailWrapper: title rendered into both <title> and the H1', wrapperHtml.includes('<title>Booking Confirmed</title>') && wrapperHtml.includes('>Booking Confirmed</h1>'), 'not found');
    check('createEmailWrapper: content merge fields passed through untouched (wrapper does not itself substitute {{}} tokens)',
        wrapperHtml.includes('{{name}}') && wrapperHtml.includes('{{booking_id}}'), 'merge tokens missing — wrapper may now be escaping or stripping them');
    check('createEmailWrapper: banner image rendered (branding="banner")', wrapperHtml.includes('https://example.invalid/banner.jpg'), 'banner src missing');
    check('createEmailWrapper: unsubscribe link rendered verbatim', wrapperHtml.includes('https://example.invalid/unsubscribe?token=test-token'), 'unsubscribe link missing');
    check('createEmailWrapper: social link rendered for the platform given', wrapperHtml.includes('instagram.com/example'), 'social link missing');
    check('createEmailWrapper: still uses the legacy .btn-luxe/.text-muted classes (not yet migrated off — same status as when email.test.js documented their removal from OTHER templates)',
        wrapperHtml.includes('.btn-luxe') && wrapperHtml.includes('.text-muted'), 'expected legacy classes to still be present in the shell CSS');
    const wrapperGolden = compareGolden('createEmailWrapper.golden.html', wrapperHtml);
    check('createEmailWrapper: matches golden snapshot', wrapperGolden.pass, wrapperGolden.detail);

    // ── createEmailWrapper: branding='none' and no unsubscribeUrl — the minimal call shape ──
    const minimalHtml = emailTemplates.createEmailWrapper('<p>Plain notice.</p>', 'Plain Notice', null, null, [], 'none');
    check('createEmailWrapper (minimal): no unsubscribe block when unsubscribeUrl is null', !minimalHtml.includes('Unsubscribe from this list'), 'unsubscribe block present unexpectedly');
    check('createEmailWrapper (minimal): header border removed when branding="none"', minimalHtml.includes('border-bottom: none;'), 'expected border-bottom:none for branding=none');
    check('createEmailWrapper (minimal): falls back to the default social icon set when none are supplied', minimalHtml.includes('title="Instagram"') && minimalHtml.includes('title="Twitter"') && minimalHtml.includes('title="Facebook"'),
        'expected the three default (href="#") social icons');
    const minimalGolden = compareGolden('createEmailWrapper-minimal.golden.html', minimalHtml);
    check('createEmailWrapper (minimal): matches golden snapshot', minimalGolden.pass, minimalGolden.detail);
};
