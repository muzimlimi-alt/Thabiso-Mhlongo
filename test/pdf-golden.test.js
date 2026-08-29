// Characterisation test for invoice/quote PDF generation, per Phase 2 of the housekeeping plan:
// download the PDF, assert its extracted text carries the reference number, amounts and client
// name verbatim, and keep a normalized golden copy under test/golden/ so a future move that
// silently reshapes the PDF (wrong font call, a dropped section, a mis-ordered table) shows up as
// a diff instead of passing silently.
//
// Two of this app's own reference-number formats are NOT timestamp-free identifiers — they are
// derived per environment/run:
//   - invoice_number: `INV-${year}-${bookingId padded to 4}` (server.js ~line 1422)
//   - quote reference: `QT-${bookingId}-${YYMMDDHHmmss}`      (server.js ~line 13762)
// Since bookingId depends on how many rows already exist in whatever database.sqlite this test
// run's throwaway copy came from, and the quote reference embeds a to-the-second timestamp, a
// byte-for-byte golden compare would fail on every single run even with zero real change. The
// plan asks for "byte comparison of structure, not of timestamps" — here that means normalizing
// out these dynamic reference formats plus literal calendar dates, then comparing the rest
// byte-for-byte. Amounts are NOT normalized: this fixture's amounts are fixed inputs, so a
// changed amount in the golden diff is a real structural regression, not noise.
//
// Two more dynamic values turned up only by actually running this twice and diffing: the PDF
// prints the raw booking id verbatim as "BOOKING REF: #<id>" (a third, undocumented reference
// format, distinct from invoice_number/quote reference above), and this file's own fixture email
// embeds Date.now(). Both are masked below for the same reason as the other two.
const fs = require('fs');
const path = require('path');
const { api, pub, one, future, sleep, getTrackingToken, apiBinary, extractPdfText } = require('./support');

const SVC = 15; // 'Travel Buyout – Gauteng' (active, flat fee, zero lead time) — see booking.test.js
const GOLDEN_DIR = path.join(__dirname, 'golden');
const CLIENT_NAME = 'PDF Golden Test Client';
const AMOUNT = 2500;

// Date offsets 860-870 are reserved for this file (see calendar.test.js's comment on why offsets
// must not collide across *.test.js files sharing one server/DB per npm test run).
const DATE_RE = /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b|\b\d{1,2}\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+\d{4}\b|\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+\d{1,2},?\s+\d{4}\b/g;

function normalize(text) {
    return text
        .replace(/INV-\d{4}-\d+/g, 'INV-<YEAR>-<ID>')
        .replace(/QT-\d+-\d+/g, 'QT-<ID>-<TIMESTAMP>')
        .replace(/#\d+/g, '#<ID>')
        .replace(/[\w.+-]+@[\w.-]+\.\w+/g, '<EMAIL>')
        .replace(DATE_RE, '<DATE>')
        .replace(/[ \t]+/g, ' ')
        .trim();
}

// Compares against (or creates, on first run) a golden file. Returns { pass, detail }.
function compareGolden(name, normalizedText) {
    if (!fs.existsSync(GOLDEN_DIR)) fs.mkdirSync(GOLDEN_DIR, { recursive: true });
    const file = path.join(GOLDEN_DIR, name);
    if (!fs.existsSync(file)) {
        fs.writeFileSync(file, normalizedText, 'utf8');
        return { pass: true, detail: `golden file created (first run): ${name}` };
    }
    const golden = fs.readFileSync(file, 'utf8');
    return { pass: golden === normalizedText, detail: golden === normalizedText ? 'matches golden' : `DIFFERS from golden ${name} (lengths: golden=${golden.length} actual=${normalizedText.length})` };
}

module.exports = async function ({ check }) {
    const em = `pdfgolden.${Date.now()}@example.invalid`;
    const created = await api('POST', '/api/admin/bookings', {
        name: CLIENT_NAME, email: em, cell: '+27821234567', event_date: future(860),
        event_name: 'PDF Golden Test Event', event_type: 'Corporate', event_location: 'Golden Test Hall',
        message: 'Phase 2 PDF golden-copy characterisation test booking.',
        services: [{ service_id: SVC }], status: 'NEW', override_working_hours: true,
    });
    check('fixture: booking created', created.status === 200 && !!created.body.booking_id, `${created.status}`);
    const id = created.body.booking_id;
    if (!id) return;

    await sleep(50);
    const bkRow = await one('SELECT date FROM bookings WHERE id=?', [id]);
    const expiry = new Date(Date.parse(bkRow.date) - 10 * 86400000).toISOString().slice(0, 10);
    const quoteRes = await api('POST', `/api/admin/bookings/${id}/quote`, {
        quote_expiry_date: expiry, terms: 'Standard terms apply.', apply_vat: false, discount: 0,
        items: [{ service_id: SVC, description: 'Travel Buyout – Gauteng', quantity: 1, unit_price: AMOUNT }],
    });
    check('fixture: quote issued', quoteRes.status === 200, `${quoteRes.status}`);

    // ── Quote PDF ──
    const quoteDl = await apiBinary('GET', `/api/admin/bookings/${id}/quote/download`);
    check('quote PDF: download 200', quoteDl.status === 200, `${quoteDl.status}`);
    check('quote PDF: looks like a real PDF (starts with %PDF)', quoteDl.buffer.slice(0, 4).toString('latin1') === '%PDF', quoteDl.buffer.slice(0, 8).toString('latin1'));
    const quoteText = extractPdfText(quoteDl.buffer);
    check('quote PDF: client name appears verbatim', quoteText.includes(CLIENT_NAME), quoteText.slice(0, 300));
    check('quote PDF: amount appears (2 500.00 or 2500.00)', quoteText.includes('2 500.00') || quoteText.includes('2500.00') || quoteText.includes('2,500.00'), quoteText.slice(0, 300));
    const quoteRow = await one('SELECT quote_number FROM quotations WHERE booking_id=? ORDER BY id DESC LIMIT 1', [id]);
    check('quote PDF: fixture has a quote_number to check against', !!(quoteRow && quoteRow.quote_number), JSON.stringify(quoteRow));
    if (quoteRow && quoteRow.quote_number) {
        check('quote PDF: quote_number appears verbatim', quoteText.includes(quoteRow.quote_number), `looking for ${quoteRow.quote_number}`);
    }
    const quoteGolden = compareGolden('quote.golden.txt', normalize(quoteText));
    check('quote PDF: matches normalized golden structure', quoteGolden.pass, quoteGolden.detail);

    // ── Accept, to generate the invoice ──
    const token = await getTrackingToken(id, em);
    const acceptRes = await pub('POST', `/api/public/bookings/${id}/accept-quote`, { access_token: token, terms_agreed: true });
    check('fixture: quote accepted (generates the invoice)', acceptRes.status === 200 && acceptRes.body.success, `${acceptRes.status}`);

    // ── Invoice PDF ──
    const invDl = await apiBinary('GET', `/api/admin/bookings/${id}/invoice/download`);
    check('invoice PDF: download 200', invDl.status === 200, `${invDl.status}`);
    check('invoice PDF: looks like a real PDF (starts with %PDF)', invDl.buffer.slice(0, 4).toString('latin1') === '%PDF', invDl.buffer.slice(0, 8).toString('latin1'));
    const invText = extractPdfText(invDl.buffer);
    check('invoice PDF: client name appears verbatim', invText.includes(CLIENT_NAME), invText.slice(0, 300));
    check('invoice PDF: amount appears (2 500.00 or 2500.00)', invText.includes('2 500.00') || invText.includes('2500.00') || invText.includes('2,500.00'), invText.slice(0, 300));
    const invRow = await one('SELECT invoice_number FROM invoices WHERE booking_id=? ORDER BY id DESC LIMIT 1', [id]);
    check('invoice PDF: fixture has an invoice_number to check against', !!(invRow && invRow.invoice_number), JSON.stringify(invRow));
    if (invRow && invRow.invoice_number) {
        check('invoice PDF: invoice_number appears verbatim', invText.includes(invRow.invoice_number), `looking for ${invRow.invoice_number}`);
    }
    const invGolden = compareGolden('invoice.golden.txt', normalize(invText));
    check('invoice PDF: matches normalized golden structure', invGolden.pass, invGolden.detail);
};
