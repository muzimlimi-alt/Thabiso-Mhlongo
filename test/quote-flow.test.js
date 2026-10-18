// Rate card 2026, Phase 5: the booking -> Quote Builder -> quotation -> acceptance path consumes the updated services without
// disturbing any existing commercial agreement. (How the same screens behave in a browser: test/browser/quote-builder.js.)
//
//   1. the booking screens can tell "a quote was issued" from "the catalogue estimate" (has_quote / unpriced_lines / per-line pricing)
//   2. a quotation per pricing type: fixed is pre-filled, range / from / enquiry need an explicit amount and keep their meaning
//   3. VAT on taxable lines only, exempt lines, a split discount, a flat line with quantity 2, an hourly line - to the cent
//   4. the quote PDF: "valid until" is the chosen expiry, one page, line amounts agree with the stored total
//   5. historical protection: editing a rate leaves the saved quote, the booking, its PDF AND the invoice untouched
//   6. acceptance: the payment milestones add up to the quote total (2 and 3 instalments)
//
// Date offsets 1260-1279 are reserved for this file (see calendar.test.js on why offsets must not collide across test files; grep
// the WHOLE test folder before picking - service-visibility books through a helper, `mk(1200, ...)`, which a search for `future(` misses).
const moment = require('moment-timezone');
const { computeDocumentTotals } = require('../js/shared/document-totals');

module.exports = async function ({ check, api, pub, one, q, future, sleep, apiBinary, extractPdfText, getTrackingToken }) {
    const eq = (name, got, want) => check(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    const money = (n) => Math.round(Number(n) * 100) / 100;
    const sameMoney = (a, b) => money(a) === money(b);
    const pageCount = (buf) => (buf.toString('latin1').match(/\/Type \/Page\b/g) || []).length;

    let seq = 0, day = 1260;
    const emails = new Map();
    const createdIds = [];   // fixtures archived at the end so they do not linger in the shared test DB

    const idOf = async (name) => (await one('SELECT id FROM services WHERE name = ?', [name])).id;
    const manual = async (services, label) => {
        const email = `qflow.${Date.now()}.${seq++}@example.invalid`;
        const r = await api('POST', '/api/admin/bookings', {
            name: `QFlow ${label}`, email, cell: '+27821234567', event_date: future(day++), event_name: `QFLOW ${label}`,
            event_type: 'Corporate', event_location: 'Flow Hall', message: 'Quote flow integration test booking, over ten characters.',
            services, status: 'NEW', override_working_hours: true
        });
        if (r.body && r.body.booking_id) emails.set(r.body.booking_id, email);
        return r;
    };
    const expiryFor = async (bookingId) => {
        const bk = await one('SELECT date FROM bookings WHERE id = ?', [bookingId]);
        return new Date(Date.parse(bk.date) - 10 * 86400000).toISOString().slice(0, 10);
    };
    const quote = async (bookingId, items, over = {}) => api('POST', `/api/admin/bookings/${bookingId}/quote`, {
        quote_expiry_date: await expiryFor(bookingId), terms: 'Flow terms apply.', apply_vat: false, discount: 0, items, ...over
    });
    const fullRow = async (id) => ((await api('GET', '/api/admin/bookings/full')).body || []).find(b => b.id === id);
    const detail = async (id) => (await api('GET', `/api/admin/bookings/${id}`)).body;
    const quotePdf = async (id) => { const d = await apiBinary('GET', `/api/admin/bookings/${id}/quote/download`); return { buf: d.buffer, text: extractPdfText(d.buffer), status: d.status }; };
    const invoicePdf = async (id) => { const d = await apiBinary('GET', `/api/admin/bookings/${id}/invoice/download`); return { buf: d.buffer, text: extractPdfText(d.buffer), status: d.status }; };
    const accept = async (id, installments) => {
        const token = await getTrackingToken(id, emails.get(id));
        return pub('POST', `/api/public/bookings/${id}/accept-quote`, { access_token: token, terms_agreed: true, installment_count: installments });
    };

    const sClub = await idOf('Club – 10 min Set (Guest Spot)');                  // fixed R5,000
    const sHead = await idOf('Writing – Head Writer (per month)');               // range R90,000 – R140,000 per month
    const sFilm = await idOf('Writing – Film / Telenovela Script (per draft)');  // enquire
    const sActing = await idOf('Acting – Per SAGA');                             // enquire, minimum R15,000 per session
    const sCombo = await idOf('Private – Performance + MC Combo');               // from R50,000
    const sConsult = await idOf('Writing – Consultation');                       // fixed R2,500 per hour
    const sTravel = await idOf('Travel Buyout – Gauteng');                       // VAT-exempt flat fee
    const sNight = await idOf('Accommodation – Single Night');                   // VAT-exempt flat fee, no maximum quantity

    // ═══ 1. The booking screens can tell an issued quote from the catalogue estimate ═══
    const bFixed = (await manual([{ service_id: sClub }], 'fixed')).body.booking_id;
    const bRange = (await manual([{ service_id: sHead }], 'range')).body.booking_id;
    const bMixed = (await manual([{ service_id: sClub }, { service_id: sCombo }], 'mixed')).body.booking_id;
    const bEnq = (await manual([{ service_id: sFilm }], 'enquire')).body.booking_id;
    const bMin = (await manual([{ service_id: sActing }], 'enquire-min')).body.booking_id;
    check('fixtures: five bookings created through the manual booking route', [bFixed, bRange, bMixed, bEnq, bMin].every(Boolean), JSON.stringify([bFixed, bRange, bMixed, bEnq, bMin]));

    let row = await fullRow(bFixed);
    check('list: a fixed-price booking with no quote is NOT quoted, although its estimate is R5,000',
        row && row.has_quote === 0 && row.unpriced_lines === 0 && /5000/.test(String(row.quote_amount)), JSON.stringify(row && { h: row.has_quote, u: row.unpriced_lines, q: row.quote_amount }));
    row = await fullRow(bRange);
    check('list: an individually priced booking has no quote and one line still to be priced',
        row && row.has_quote === 0 && row.unpriced_lines === 1, JSON.stringify(row && { h: row.has_quote, u: row.unpriced_lines, q: row.quote_amount }));
    row = await fullRow(bMixed);
    check('list: a mixed booking counts only the individually priced line as unpriced', row && row.has_quote === 0 && row.unpriced_lines === 1, JSON.stringify(row && { h: row.has_quote, u: row.unpriced_lines }));
    check('list: "enquire" and "enquire with minimum" bookings each have one line to price',
        (await fullRow(bEnq)).unpriced_lines === 1 && (await fullRow(bMin)).unpriced_lines === 1);

    const paged = await api('GET', '/api/admin/bookings?limit=200&sortBy=created_at&order=DESC');
    const pagedRow = ((paged.body && paged.body.bookings) || []).find(b => b.id === bRange);
    check('the paginated list carries the same fields', paged.status === 200 && pagedRow && pagedRow.has_quote === 0 && pagedRow.unpriced_lines === 1, `${paged.status} ${JSON.stringify(pagedRow && { h: pagedRow.has_quote, u: pagedRow.unpriced_lines })}`);

    let d = await detail(bMixed);
    const dClub = (d.services || []).find(s => s.service_id === sClub), dCombo = (d.services || []).find(s => s.service_id === sCombo);
    check('detail: a fixed line carries its snapshot, the catalogue fee, its label and tax class',
        dClub && dClub.unit_price === 5000 && dClub.catalogue_unit_price === 5000 && dClub.unpriced === false && dClub.quote_required === false
        && dClub.price_label === 'R5,000' && dClub.price_type === 'fixed' && dClub.tax_class === 'standard', JSON.stringify(dClub));
    check('detail: a "from" line has no amount (snapshot 0, catalogue 0), is flagged unpriced and keeps its published label',
        dCombo && dCombo.unit_price === 0 && dCombo.catalogue_unit_price === 0 && dCombo.unpriced === true && dCombo.quote_required === true
        && dCombo.price_label === 'From R50,000' && dCombo.price_type === 'from', JSON.stringify(dCombo));
    check('detail: the booking itself reports no quote', d.has_quote === 0 && d.unpriced_lines === 1, JSON.stringify({ h: d.has_quote, u: d.unpriced_lines }));

    const lines = (await api('GET', `/api/admin/bookings/${bMixed}/details`)).body.line_items || [];
    const lClub = lines.find(l => l.service_id === sClub), lCombo = lines.find(l => l.service_id === sCombo);
    check('line items (Deal View): the fixed line is priced, the "from" line is "to be quoted" with its published label',
        lClub && lClub.unpriced === false && lCombo && lCombo.unpriced === true && lCombo.price_label === 'From R50,000', JSON.stringify(lines.map(l => ({ s: l.service_id, u: l.unpriced, l: l.price_label }))));

    // ═══ 2. A quotation per pricing type ═══
    let r = await quote(bFixed, [{ service_id: sClub, description: 'Club – 10 min Set (Guest Spot)', quantity: 1, unit_price: 5000, pricing_model: 'flat_fee' }]);
    check('fixed: quote issued at the catalogue fee', r.status === 200 && r.body.success, `${r.status} ${JSON.stringify(r.body)}`);
    row = await fullRow(bFixed);
    check('fixed: the booking is now quoted (has_quote 1), nothing left to price, the list shows the quote total',
        row.has_quote === 1 && row.unpriced_lines === 0 && sameMoney(row.quote_amount, 5000) && row.status === 'QUOTED', JSON.stringify({ h: row.has_quote, u: row.unpriced_lines, q: row.quote_amount, s: row.status }));
    check('fixed: stored total is R5,000', sameMoney((await one('SELECT total_amount FROM quotations WHERE booking_id = ?', [bFixed])).total_amount, 5000));

    r = await quote(bRange, [{ service_id: sHead, description: 'Head Writer', quantity: 1, unit_price: 0, pricing_model: 'flat_fee' }]);
    check('range: a quote with no amount is refused and names the service', r.status === 400 && /Head Writer/.test(r.body.message || '') && /priced individually/.test(r.body.message || ''), `${r.status} ${JSON.stringify(r.body)}`);
    row = await fullRow(bRange);
    check('range: the refused quote left the booking unquoted and still unpriced',
        row.has_quote === 0 && row.unpriced_lines === 1 && (await one('SELECT COUNT(*) c FROM quotations WHERE booking_id = ?', [bRange])).c === 0, JSON.stringify({ h: row.has_quote, u: row.unpriced_lines }));
    r = await quote(bRange, [{ service_id: sHead, description: 'Head Writer', quantity: 1, unit_price: 100000, pricing_model: 'flat_fee' }]);
    check('range: an agreed amount inside the published range is accepted with no warning', r.status === 200 && !r.body.warnings, `${r.status} ${JSON.stringify(r.body)}`);
    let bs = await q('SELECT unit_price, quantity_minutes FROM booking_services WHERE booking_id = ?', [bRange]);
    check('range: the booking line now carries exactly the agreed amount (never a band value)', bs.length === 1 && bs[0].unit_price === 100000, JSON.stringify(bs));
    row = await fullRow(bRange);
    check('range: the booking is quoted at the agreed amount, no unpriced lines left', row.has_quote === 1 && row.unpriced_lines === 0 && sameMoney(row.quote_amount, 100000), JSON.stringify({ h: row.has_quote, u: row.unpriced_lines, q: row.quote_amount }));

    r = await quote(bMixed, [
        { service_id: sClub, description: 'Club set', quantity: 1, unit_price: 5000, pricing_model: 'flat_fee' },
        { service_id: sCombo, description: 'Performance + MC combo', quantity: 1, unit_price: 40000, pricing_model: 'flat_fee' }]);
    check('"from": quoted below its starting price is allowed but warned about', r.status === 200 && (r.body.warnings || []).some(w => /below its published starting price of R50,000/.test(w)), `${r.status} ${JSON.stringify(r.body)}`);
    check('"from": the quote total is the sum of the agreed amounts (R45,000), not the starting price', sameMoney((await one('SELECT total_amount FROM quotations WHERE booking_id = ?', [bMixed])).total_amount, 45000));

    r = await quote(bEnq, [{ service_id: sFilm, description: 'Film script', quantity: 1, unit_price: 25000, pricing_model: 'flat_fee' }]);
    check('enquiry: an agreed amount is accepted (nothing published, nothing to warn about)', r.status === 200 && !r.body.warnings, `${r.status} ${JSON.stringify(r.body)}`);

    r = await quote(bMin, [{ service_id: sActing, description: 'Acting', quantity: 1, unit_price: 10000, pricing_model: 'flat_fee' }]);
    check('enquiry with a minimum: below the minimum is allowed but warned about', r.status === 200 && (r.body.warnings || []).some(w => /below its published minimum of R15,000/.test(w)), `${r.status} ${JSON.stringify(r.body)}`);
    r = await quote(bMin, [{ service_id: sActing, description: 'Acting', quantity: 1, unit_price: 15000, pricing_model: 'flat_fee' }]);
    check('...a revised quote at the minimum is a new version with no warning', r.status === 200 && !r.body.warnings && r.body.version === 2, `${r.status} ${JSON.stringify(r.body)}`);
    check('...the earlier version is archived, the new one is current', (await q('SELECT version, archived, total_amount FROM quotations WHERE booking_id = ? ORDER BY version', [bMin])).map(x => `${x.version}:${x.archived}:${x.total_amount}`).join(',') === '1:1:10000,2:0:15000');
    row = await fullRow(bMin);
    check('...and the booking list shows the revised total', row.has_quote === 1 && sameMoney(row.quote_amount, 15000), JSON.stringify({ h: row.has_quote, q: row.quote_amount }));

    // ═══ 3 + 4. VAT / exempt lines / discount / flat quantity 2 - and the PDF that prints them ═══
    const bVat = (await manual([{ service_id: sClub }, { service_id: sTravel }, { service_id: sNight }], 'vat')).body.booking_id;
    const vatItems = [
        { service_id: sClub, description: 'Club set', quantity: 1, unit_price: 5000, pricing_model: 'flat_fee' },
        { service_id: sTravel, description: 'Travel buyout', quantity: 1, unit_price: 2500, pricing_model: 'flat_fee' },
        { service_id: sNight, description: 'Accommodation, two nights', quantity: 2, unit_price: 2200, pricing_model: 'flat_fee' }
    ];
    const vatExpiry = await expiryFor(bVat);
    r = await quote(bVat, vatItems, { apply_vat: true, discount: 900 });
    check('VAT quote with an exempt line, a flat line x2 and a discount is issued', r.status === 200 && r.body.success, `${r.status} ${JSON.stringify(r.body)}`);
    // Typed by hand, not taken from the code under test: taxable 5,000 + exempt 6,900 = 11,900; the R900 discount splits 5/11.9 : 6.9/11.9
    // -> taxable base 4,621.85, exempt base 6,378.15; VAT 15% of 4,621.85 = 693.28; total 11,000.00 + 693.28.
    const vq = await one('SELECT total_amount FROM quotations WHERE booking_id = ?', [bVat]);
    const vb = await one('SELECT quote_amount, total_amount, quote_details, amount_outstanding FROM bookings WHERE id = ?', [bVat]);
    const vd = JSON.parse(vb.quote_details);
    check('VAT: stored total is R11,693.28 (VAT 693.28 charged on the taxable line only)', sameMoney(vq.total_amount, 11693.28) && vb.quote_amount === '11693.28' && sameMoney(vb.total_amount, 11693.28) && sameMoney(vb.amount_outstanding, 11693.28), JSON.stringify({ vq, vb: { a: vb.quote_amount, t: vb.total_amount } }));
    check('VAT: the stored breakdown agrees (subtotal 11,900.00, VAT 693.28)', sameMoney(vd.subtotal, 11900) && sameMoney(vd.vat, 693.28) && sameMoney(vd.finalTotal, 11693.28), JSON.stringify({ s: vd.subtotal, v: vd.vat, f: vd.finalTotal }));
    const shared = computeDocumentTotals(vatItems.map(i => ({ ...i, tax_class: i.service_id === sClub ? 'standard' : 'exempt' })), { discount: 900, applyVat: true, vatRate: 0.15 });
    check('the shared totals module (what the Quote Builder previews with) gives the same figures', sameMoney(shared.total, 11693.28) && sameMoney(shared.vat, 693.28) && sameMoney(shared.subtotal, 11900), JSON.stringify(shared));
    const ql = await q('SELECT service_id, quantity, unit_price FROM quote_line_items WHERE quotation_id IN (SELECT id FROM quotations WHERE booking_id = ?) ORDER BY id', [bVat]);
    check('the quote lines keep every quantity and price as sent (accommodation x2 @ R2,200)', ql.length === 3 && ql[2].quantity === 2 && ql[2].unit_price === 2200 && ql[0].unit_price === 5000, JSON.stringify(ql));

    let pdf = await quotePdf(bVat);
    check('quote PDF: downloads and is a PDF', pdf.status === 200 && pdf.buf.slice(0, 4).toString('latin1') === '%PDF', `${pdf.status}`);
    check('quote PDF: the document is ONE page (the footer used to spill onto a blank second page)', pageCount(pdf.buf) === 1, `pages=${pageCount(pdf.buf)}`);
    const expiryText = moment(vatExpiry, 'YYYY-MM-DD').format('DD MMM YYYY');
    check('quote PDF: "VALID UNTIL" is the expiry chosen on the quote, not today + 14 days', pdf.text.includes(`VALID UNTIL: ${expiryText}`), `looking for "${expiryText}" in ${pdf.text.slice(0, 500)}`);
    check('quote PDF: the footer says the quotation is valid until that date', pdf.text.includes(`This quotation is valid until ${expiryText}.`) && !/Quotes are valid for \d+ days/.test(pdf.text), pdf.text.slice(-300));
    check('quote PDF: VAT row, VAT amount, discount and total match the record',
        /VAT \(15%\)/.test(pdf.text) && pdf.text.includes('693.28') && pdf.text.includes('11693.28') && pdf.text.includes('900.00') && pdf.text.includes('11900.00'), pdf.text.slice(0, 900));
    check('quote PDF: the flat line with quantity 2 prints 2 x R2,200.00 = R4,400.00 (it used to print R2,200.00)', pdf.text.includes('2 unit × R 2200.00') && pdf.text.includes('R 4400.00'), pdf.text.slice(0, 900));
    check('quote PDF: the two exempt lines are marked (the taxable one is not) and single-quantity flat lines keep their "Flat Fee" label',
        (pdf.text.match(/\[EXEMPT\]/g) || []).length === 2 && /Club set\s+Flat Fee/.test(pdf.text) && /Travel buyout\s+\[EXEMPT\]\s+Flat Fee/.test(pdf.text), pdf.text.slice(0, 900));
    check('quote PDF: pricing conditions travel with the quotation (rand, VAT wording, travel exclusions)', /South African rand/.test(pdf.text) && /VAT at 15% is added in the totals above/.test(pdf.text), pdf.text.slice(0, 1400));

    // The quotation EMAIL repeats the breakdown: it must agree with the stored quotation and the PDF (it once did its own VAT sum over
    // every line, exempt ones included: R1,650.00 VAT / R12,650.00 here, with "Total Quote: 11693.28" printed right under it).
    let mail = null;
    for (let i = 0; i < 60 && !mail; i++) {
        mail = await one("SELECT body FROM notifications WHERE type='email' AND subject = ? AND recipient_email = ? ORDER BY id DESC LIMIT 1", [`Quotation for Booking #${bVat}`, emails.get(bVat)]);
        if (!mail) await sleep(100);
    }
    // notifications.body is a JSON envelope ({htmlContent, ...}); read the real HTML, then the text a client would read.
    const mailHtml = mail ? (() => { try { return JSON.parse(mail.body).htmlContent || mail.body; } catch (e) { return mail.body; } })() : '';
    const mailText = mailHtml.replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&zwnj;/g, ' ').replace(/\s+/g, ' ');
    check('quote email: arrives with the service breakdown', !!mail && /Service Breakdown/.test(mailText), mailText.slice(0, 300));
    check('quote email: the flat line x2 reads "2 × R 2200.00 ... R 4400.00" and the exempt lines say so',
        /Accommodation, two nights \(VAT exempt\) 2 × R 2200\.00 R 4400\.00/.test(mailText) && /Travel buyout \(VAT exempt\) Flat Fee R 2500\.00/.test(mailText) && /Club set Flat Fee R 5000\.00/.test(mailText), mailText.slice(0, 900));
    check('quote email: subtotal, discount, VAT on the taxable part only, and total equal the stored quotation (R693.28, R11,693.28)',
        /Subtotal R 11900\.00/.test(mailText) && /Discount - R 900\.00/.test(mailText) && /VAT \(15%\) R 693\.28/.test(mailText) && /Total \(Incl\. VAT\) R 11693\.28/.test(mailText) && !/1650\.00|12650\.00/.test(mailText), mailText.slice(0, 1200));
    check('quote email: the "Total Quote" line agrees with the breakdown above it', /Total Quote: 11693\.28/.test(mailText), mailText.slice(-500));

    // ═══ An hourly line (hours, not minutes) ═══
    const bHour = (await manual([{ service_id: sConsult, quantity_minutes: 120 }], 'hourly')).body.booking_id;
    bs = await q('SELECT quantity_minutes, unit_price FROM booking_services WHERE booking_id = ?', [bHour]);
    check('hourly: a 2 hour booking stores 2 (hours) at R2,500', bs.length === 1 && bs[0].quantity_minutes === 2 && bs[0].unit_price === 2500, JSON.stringify(bs));
    d = await detail(bHour);
    check('hourly: the detail row says per hour and the catalogue fee is R2,500', d.services[0].pricing_model === 'per_hour' && d.services[0].catalogue_unit_price === 2500 && d.services[0].price_label === 'R2,500 per hour', JSON.stringify(d.services[0]));
    r = await quote(bHour, [{ service_id: sConsult, description: 'Consultation', quantity: 2, unit_price: 2500, pricing_model: 'per_hour' }]);
    check('hourly: quote issued (2 hours x R2,500 = R5,000)', r.status === 200 && sameMoney((await one('SELECT total_amount FROM quotations WHERE booking_id = ?', [bHour])).total_amount, 5000), `${r.status} ${JSON.stringify(r.body)}`);
    pdf = await quotePdf(bHour);
    check('hourly: the PDF shows "2 hr × R 2500.00" and R5,000.00, on one page', pdf.text.includes('2 hr × R 2500.00') && pdf.text.includes('R 5000.00') && pageCount(pdf.buf) === 1, pdf.text.slice(0, 700));

    // ═══ 5. Historical protection: editing a rate leaves every saved commercial record alone ═══
    const mkSvc = await api('POST', '/api/admin/services', { name: `ZZ-QF ${Date.now().toString(36)}`, category: 'Other', is_taxable: true, is_active: true, default_price: 1000, pricing_model: 'flat_fee' });
    const zzId = mkSvc.body && mkSvc.body.id;
    if (zzId) createdIds.push(zzId);
    check('fixture: a fixed R1,000 service', mkSvc.status === 200 && !!zzId, `${mkSvc.status} ${JSON.stringify(mkSvc.body)}`);
    const bHist = (await manual([{ service_id: zzId }], 'history')).body.booking_id;
    r = await quote(bHist, [{ service_id: zzId, description: 'Historic service', quantity: 1, unit_price: 1000, pricing_model: 'flat_fee' }]);
    check('history: booking quoted at R1,000', r.status === 200, `${r.status} ${JSON.stringify(r.body)}`);
    const snapshot = async (id) => JSON.stringify({
        bs: await q('SELECT unit_price, total_price FROM booking_services WHERE booking_id = ?', [id]),
        bl: await q('SELECT quantity, unit_price FROM booking_line_items WHERE booking_id = ?', [id]),
        ql: await q('SELECT quantity, unit_price FROM quote_line_items WHERE quotation_id IN (SELECT id FROM quotations WHERE booking_id = ?)', [id]),
        qt: await q('SELECT total_amount, version FROM quotations WHERE booking_id = ?', [id]),
        bk: await one('SELECT total_amount, quote_amount, quote_details FROM bookings WHERE id = ?', [id])
    });
    const histBefore = await snapshot(bHist);
    const pdfBefore = (await quotePdf(bHist)).text;
    const svcRow = ((await api('GET', '/api/admin/services')).body || []).find(s => s.id === zzId);
    r = await api('PUT', `/api/admin/services/${zzId}`, { ...svcRow, default_price: 1500, is_deleted: 0, is_active: true });
    check('history: the service fee is raised to R1,500', r.status === 200 && Number(((await api('GET', '/api/admin/services')).body.find(s => s.id === zzId)).default_price) === 1500, `${r.status} ${JSON.stringify(r.body)}`);
    check('history: the saved booking, its lines, its quote lines and every total are byte-for-byte unchanged', histBefore === await snapshot(bHist), histBefore);
    check('history: the downloaded quote PDF still shows R1,000.00 and never R1,500.00', (await quotePdf(bHist)).text === pdfBefore && pdfBefore.includes('1000.00') && !pdfBefore.includes('1500.00'));
    d = await detail(bHist);
    check('history: the booking detail keeps the quoted amount beside today\'s catalogue fee (the Quote Builder revises from the former)',
        d.has_quote === 1 && d.services[0].unit_price === 1000 && d.services[0].catalogue_unit_price === 1500, JSON.stringify({ h: d.has_quote, s: d.services[0] }));
    const bNew = (await manual([{ service_id: zzId }], 'after-rise')).body.booking_id;
    bs = await q('SELECT unit_price FROM booking_services WHERE booking_id = ?', [bNew]);
    d = await detail(bNew);
    check('history: a NEW booking uses the current fee (R1,500); it has no quote yet', bs[0].unit_price === 1500 && d.has_quote === 0 && d.services[0].catalogue_unit_price === 1500, JSON.stringify({ bs, h: d.has_quote }));
    r = await accept(bHist, 2);
    check('history: the client accepts the old quote after the rate rise', r.status === 200 && r.body.success && r.body.invoice_generated, `${r.status} ${JSON.stringify(r.body)}`);
    const hInv = await one('SELECT id, total_amount, invoice_number FROM invoices WHERE booking_id = ? ORDER BY id DESC LIMIT 1', [bHist]);
    const hInvLines = await q('SELECT quantity, unit_price FROM invoice_line_items WHERE invoice_id = ?', [hInv && hInv.id]);
    check('history: the invoice carries the QUOTED R1,000, not today\'s R1,500', hInv && sameMoney(hInv.total_amount, 1000) && hInvLines.length === 1 && hInvLines[0].unit_price === 1000, JSON.stringify({ hInv, hInvLines }));
    const hSched = await q(`SELECT expected_amount FROM payment_schedules WHERE booking_id = ? AND status NOT IN ('superseded','cancelled')`, [bHist]);
    check('history: its payment milestones add up to R1,000', sameMoney(hSched.reduce((s, x) => s + x.expected_amount, 0), 1000), JSON.stringify(hSched));
    const invText = (await invoicePdf(bHist)).text;
    check('history: the invoice PDF shows R1,000.00 and not R1,500.00', invText.includes('1000.00') && !invText.includes('1500.00'), invText.slice(0, 600));

    // ═══ 6. Acceptance: milestones add up to the quote total, to the cent ═══
    const quotedTotal = async (id) => money((await one('SELECT total_amount FROM quotations WHERE booking_id = ? AND archived = 0 ORDER BY id DESC LIMIT 1', [id])).total_amount);
    const live = async (id) => (await q(`SELECT expected_amount FROM payment_schedules WHERE booking_id = ? AND status NOT IN ('superseded','cancelled')`, [id])).map(x => x.expected_amount);
    const sum = (a) => money(a.reduce((s, x) => s + x, 0));

    r = await accept(bVat, 2);
    check('milestones (VAT + exempt + discount + qty 2): accepted', r.status === 200 && r.body.success, `${r.status} ${JSON.stringify(r.body)}`);
    let sched = await live(bVat);
    const vInv = await one('SELECT id, total_amount FROM invoices WHERE booking_id = ? ORDER BY id DESC LIMIT 1', [bVat]);
    check('milestones (2): two rows summing to the quote total R11,693.28', sched.length === 2 && sum(sched) === 11693.28, JSON.stringify(sched));
    check('the invoice total equals the quote total (VAT once, exempt lines exempt, discount applied once)', vInv && sameMoney(vInv.total_amount, 11693.28), JSON.stringify(vInv));
    const vBooking = await one('SELECT total_amount, amount_outstanding, status FROM bookings WHERE id = ?', [bVat]);
    check('the booking ledger agrees: total and outstanding are the quote total', sameMoney(vBooking.total_amount, 11693.28) && sameMoney(vBooking.amount_outstanding, 11693.28) && vBooking.status === 'ACCEPTED', JSON.stringify(vBooking));
    const vInvPdf = await invoicePdf(bVat);
    check('the invoice PDF: one page, total R11,693.28, accommodation x2 = R4,400.00', pageCount(vInvPdf.buf) === 1 && vInvPdf.text.includes('11693.28') && vInvPdf.text.includes('2 unit × R 2200.00') && vInvPdf.text.includes('R 4400.00'), vInvPdf.text.slice(0, 900));

    r = await accept(bHour, 3);
    sched = await live(bHour);
    check('milestones (3 instalments, hourly line): three rows summing to R5,000.00', r.status === 200 && sched.length === 3 && sum(sched) === 5000 && sum(sched) === await quotedTotal(bHour), `${r.status} ${JSON.stringify(sched)}`);
    check('...the hourly invoice total is R5,000.00 as quoted', sameMoney((await one('SELECT total_amount FROM invoices WHERE booking_id = ? ORDER BY id DESC LIMIT 1', [bHour])).total_amount, 5000));

    r = await accept(bRange, 2);
    sched = await live(bRange);
    check('milestones (range service quoted at R100,000): two rows summing to the AGREED amount', r.status === 200 && sum(sched) === 100000, `${r.status} ${JSON.stringify(sched)}`);
    check('...and the invoice is for the agreed amount (never a band value)', sameMoney((await one('SELECT total_amount FROM invoices WHERE booking_id = ? ORDER BY id DESC LIMIT 1', [bRange])).total_amount, 100000));
    row = await fullRow(bRange);
    check('after acceptance the booking is still "quoted" for the lists and nothing is unpriced', row.has_quote === 1 && row.unpriced_lines === 0, JSON.stringify({ h: row.has_quote, u: row.unpriced_lines }));

    for (const id of createdIds) await api('DELETE', `/api/admin/services/${id}`);   // soft-archive: gone from every list, history intact
};
