// Phase 5 (HOUSEKEEPING-NOTES.md): relocated from app.js verbatim. Shared by the admin contract
// routes (routes/admin/bookings.js), the public quote-acceptance flow, and applyStatusChange
// (neither yet moved) — generateContract is called from all three.
const db = require('../database');
const path = require('path');
const crypto = require('crypto');
const moment = require('moment-timezone');
const pdfService = require('../js/pdfService');
const { encodeUserHtml } = require('./html-sanitize');
const { docsWriteDir } = require('./runtime-paths');
const { getVatRate, resolveLineTaxClasses, computeDocumentTotals } = require('./document-totals');
const { getActiveQuoteForContractFeeData, getQuoteLineItems } = require('../database/repositories/invoices-quotations.repository');
const { getPaymentSchedulesForDocument } = require('../database/repositories/finance.repository');

// Contract Builder — seed/fallback clause text. Copied verbatim from what pdfService.generateContract()
// used to hardcode, so the builder form's placeholders match what a contract would render if a field
// is left blank, and the legacy (no-override) auto-generate path keeps producing byte-identical prose.
const DEFAULT_CONTRACT_CLAUSES = {
    cancellation: 'Cancellations are subject to the standard cancellation policy; the deposit may be non-refundable depending on the notice given before the event date.',
    forceMajeure: 'Neither party is liable for a failure to perform caused by events beyond reasonable control (illness, extreme weather, disaster, or lawful restriction); the parties will act in good faith to reschedule or refund fairly.',
    travelHospitality: '',
    rightsRecording: '',
    additionalClauses: ''
};

// Resolves fee/line-items/schedule the same way generateInvoice does (quotations → quote_line_items,
// fallback quote_details) — shared by generateContract() (actual PDF math) and the builder-data
// pre-fill route (display only), so both always agree on the same numbers.
async function resolveContractFeeData(bookingId, booking) {
    const vatRate = await getVatRate();
    const activeQuote = await getActiveQuoteForContractFeeData(bookingId);

    let items = [];
    let quoteData = {};
    try { quoteData = JSON.parse(booking.quote_details || '{}'); } catch (ex) {}
    if (activeQuote) {
        const qLines = await getQuoteLineItems(activeQuote.id);
        if (qLines.length) items = qLines.map(li => ({ description: li.description, quantity: parseFloat(li.quantity) || 1, unit_price: parseFloat(li.unit_price) || 0, service_id: li.service_id }));
    }
    if (items.length === 0 && Array.isArray(quoteData.items)) items = quoteData.items;
    await resolveLineTaxClasses(items);
    const applyVat = !!quoteData.apply_vat;
    const discount = parseFloat(quoteData.discount) || 0;

    let total;
    if (items.length > 0) {
        total = computeDocumentTotals(items, { discount, applyVat, vatRate }).total;
    } else {
        const subtotal = parseFloat((booking.quote_amount || '0').replace(/[^0-9.]/g, '')) || parseFloat(booking.total_amount) || 0;
        total = subtotal;
        items = [{ description: 'Performance Booking Service', quantity: 1, unit_price: subtotal }];
    }

    const schedules = await getPaymentSchedulesForDocument(bookingId);

    return { items, total, applyVat, schedules, quoteNumber: activeQuote ? activeQuote.quote_number : null };
}

// Assembles the contract as a self-contained HTML snapshot (makes `contracts.content_html` live —
// previously defined in the schema but never written). Used for both the stored record and the
// Builder's live Preview. Every free-text clause is HTML-escaped before interpolation — this is
// what makes it safe to assemble server-side from admin-submitted text.
function assembleContractHtml(booking, feeData, clauses, contractNo) {
    const esc = (s) => (encodeUserHtml(s) || '').replace(/\n/g, '<br>');
    const money = n => 'R ' + (parseFloat(n) || 0).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const clientLine = `${booking.name || ''}${booking.company ? ' / ' + booking.company : ''}`;
    const depositPct = parseFloat(clauses.depositPercentage) || 50;
    const depositAmt = Math.round(feeData.total * depositPct) / 100;
    const balanceAmt = Math.max(0, feeData.total - depositAmt);

    const optionalSection = (title, text) => text ? `<h3>${esc(title)}</h3><p>${esc(text)}</p>` : '';

    const scheduleRows = (feeData.schedules || []).map((s, i) =>
        `<li>${esc(s.description || 'Milestone')} — due ${esc(s.due_date || 'TBC')}: <strong>${money(s.expected_amount)}</strong></li>`
    ).join('');

    return `<!doctype html><html><head><meta charset="utf-8"><title>Agreement ${esc(contractNo)}</title>
<style>
  body{font-family:Helvetica,Arial,sans-serif;color:#222;max-width:720px;margin:32px auto;padding:0 16px;line-height:1.5;}
  h1{font-size:20px;margin-bottom:4px;} h2{font-size:12px;color:#888;font-weight:normal;margin-top:0;}
  h3{font-size:14px;border-bottom:2px solid #C9A44C;padding-bottom:4px;margin-top:28px;}
  p{font-size:13px;} table{border-collapse:collapse;width:100%;font-size:13px;} td{padding:3px 0;}
  ul{font-size:13px;padding-left:18px;}
</style></head><body>
<h1>Performance Engagement Agreement</h1>
<h2>Agreement ${esc(contractNo)} &middot; Prepared ${esc(moment().format('DD MMMM YYYY'))}</h2>
<p>This Agreement records the terms on which the Artist will provide the engagement described below to the Client. It becomes binding once signed by both parties.</p>

<h3>Parties</h3>
<table>
<tr><td><strong>The Client</strong></td><td>${esc(clientLine)} (${esc(booking.email)}${booking.cell ? ' &middot; ' + esc(booking.cell) : ''})</td></tr>
${(booking.vat_number || booking.client_vat_number) ? `<tr><td><strong>Client VAT No</strong></td><td>${esc(booking.vat_number || booking.client_vat_number)}</td></tr>` : ''}
</table>

<h3>Engagement Details</h3>
<table>
<tr><td><strong>Event</strong></td><td>${esc(booking.event_name || booking.event_type)}</td></tr>
<tr><td><strong>Type</strong></td><td>${esc(booking.event_type)}</td></tr>
<tr><td><strong>Date</strong></td><td>${esc(booking.date)}</td></tr>
<tr><td><strong>Venue</strong></td><td>${esc(booking.event_location)}</td></tr>
</table>

<h3>Fee &amp; Payment</h3>
<p><strong>Total engagement fee: ${money(feeData.total)}${feeData.applyVat ? ' (VAT inclusive)' : ''}.</strong><br>
A deposit of ${depositPct}% (${money(depositAmt)}) secures the booking; the balance of ${money(balanceAmt)} is payable per the schedule below.</p>
<p>${esc(clauses.paymentTerms)}</p>
${scheduleRows ? `<ul>${scheduleRows}</ul>` : ''}

<h3>Cancellation Policy</h3>
<p>${esc(clauses.cancellation)}</p>

<h3>Force Majeure</h3>
<p>${esc(clauses.forceMajeure)}</p>

${optionalSection('Travel & Hospitality', clauses.travelHospitality)}
${optionalSection('Rights & Recording', clauses.rightsRecording)}
${optionalSection('Additional Clauses', clauses.additionalClauses)}

<h3>General Terms</h3>
<p>1. The Artist will perform professionally and to the best of their ability for the agreed duration. The Client will provide a safe, suitable performance environment and any technical requirements agreed in advance.<br>
2. This Agreement is governed by and construed under the laws of the Republic of South Africa.</p>
</body></html>`;
}

// Auto-generate a branded booking contract PDF from booking data (mirrors generateInvoice).
// Saves as a DRAFT; never overwrites a signed/frozen contract. Returns { success, contract } or { skipped }.
// `clauseOverrides` is optional — when omitted (the quote-acceptance auto-call, unchanged), clause
// text resolves from policies + DEFAULT_CONTRACT_CLAUSES exactly as before this Builder existed;
// when provided (the Builder route), submitted text wins per-field, defaulting only for blanks.
// Booking must be past quote acceptance before a contract can exist — a contract embodies an
// accepted engagement, so it may not precede acceptance. Shared by generateContract() and the
// send/upload routes so the ordering can't be bypassed from any entry point.
const CONTRACT_ELIGIBLE_STATUSES = ['ACCEPTED', 'CONFIRMED', 'COMPLETED'];

async function generateContract(bookingId, clauseOverrides = null) {
    const existing = await new Promise(r => db.get("SELECT status, is_frozen FROM contracts WHERE booking_id = ?", [bookingId], (e, row) => r(row || null)));
    if (existing && (existing.status === 'signed' || existing.is_frozen === 1)) {
        return { skipped: true, reason: 'signed' };
    }

    const booking = await new Promise((res, rej) => db.get(
        `SELECT b.*, c.vat_number AS client_vat_number FROM bookings b LEFT JOIN clients c ON b.client_id = c.id WHERE b.id = ?`,
        [bookingId], (e, row) => e ? rej(e) : (row ? res(row) : rej(new Error('Booking not found')))));

    // Acceptance-before-contract: don't generate a contract for a booking that hasn't accepted its
    // quote yet. The auto-generate on acceptance runs after the status is already ACCEPTED, so it
    // passes; only premature manual attempts are blocked.
    if (!CONTRACT_ELIGIBLE_STATUSES.includes((booking.status || '').toUpperCase())) {
        return { skipped: true, reason: 'not_accepted' };
    }

    const feeData = await resolveContractFeeData(bookingId, booking);

    const policyRows = await new Promise(r => db.all("SELECT policy_key, policy_value FROM policies", [], (e, rows) => r(e ? [] : (rows || []))));
    const policies = {};
    policyRows.forEach(p => { policies[p.policy_key] = p.policy_value; });

    const overrides = clauseOverrides || {};
    const finalClauses = {
        paymentTerms: overrides.paymentTerms || policies.payment_terms || '',
        cancellation: overrides.cancellation || policies.cancellation_policy || DEFAULT_CONTRACT_CLAUSES.cancellation,
        forceMajeure: overrides.forceMajeure || DEFAULT_CONTRACT_CLAUSES.forceMajeure,
        travelHospitality: overrides.travelHospitality || DEFAULT_CONTRACT_CLAUSES.travelHospitality,
        rightsRecording: overrides.rightsRecording || DEFAULT_CONTRACT_CLAUSES.rightsRecording,
        additionalClauses: overrides.additionalClauses || DEFAULT_CONTRACT_CLAUSES.additionalClauses,
        depositPercentage: policies.deposit_percentage || '50'
    };

    const contractNo = `AGR-${moment().format('YYYY')}-${String(bookingId).padStart(4, '0')}`;
    const pdfFileName = `${contractNo}-${moment().format('YYYYMMDDHHmmss')}.pdf`;
    const contractsDir = docsWriteDir('contracts');
    const pdfPath = path.join(contractsDir, pdfFileName);

    await pdfService.generateContract(booking, feeData.items, pdfPath, {
        policies, schedules: feeData.schedules, totals: { total: feeData.total, applyVat: feeData.applyVat }, contractNo, clauses: finalClauses,
        sourceQuoteNumber: feeData.quoteNumber
    });

    const contentHtml = assembleContractHtml(booking, feeData, finalClauses, contractNo);
    const contentHash = crypto.createHash('sha256').update(contentHtml).digest('hex');
    const templateVersion = clauseOverrides ? 'builder-v1' : 'auto-v1';

    await new Promise((res, rej) => db.run(
        `INSERT INTO contracts (booking_id, template_version, pdf_url, content_html, content_hash, builder_clauses, contract_amount, source_quote_number, contract_number, status, uploaded_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', 'system', CURRENT_TIMESTAMP)
         ON CONFLICT(booking_id) DO UPDATE SET
            pdf_url = excluded.pdf_url,
            template_version = excluded.template_version,
            content_html = excluded.content_html,
            content_hash = excluded.content_hash,
            builder_clauses = excluded.builder_clauses,
            contract_amount = excluded.contract_amount,
            source_quote_number = excluded.source_quote_number,
            contract_number = excluded.contract_number,
            status = 'draft',
            uploaded_by = 'system',
            is_frozen = 0,
            updated_at = CURRENT_TIMESTAMP`,
        [bookingId, templateVersion, pdfFileName, contentHtml, contentHash, JSON.stringify(finalClauses), feeData.total, feeData.quoteNumber, contractNo], (e) => e ? rej(e) : res()));

    db.run(`INSERT INTO audit_log (table_name, record_id, action, changed_by, changes_json) VALUES ('contracts', ?, 'GENERATE', 'system', ?)`,
        [bookingId, JSON.stringify({ file: pdfFileName, contract_no: contractNo, status: 'draft' })], () => {});

    const row = await new Promise(r => db.get("SELECT * FROM contracts WHERE booking_id = ?", [bookingId], (e, r2) => r(r2 || null)));
    return { success: true, contract: row };
}

module.exports = {
    DEFAULT_CONTRACT_CLAUSES, CONTRACT_ELIGIBLE_STATUSES,
    resolveContractFeeData, assembleContractHtml, generateContract
};
