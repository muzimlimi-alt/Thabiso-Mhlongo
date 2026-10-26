const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const moment = require('moment-timezone');
const { decodeStoredDeep } = require('../lib/html-sanitize');
// Pure rules only (no database): this module stays importable on its own. Callers hand in `opts.issuer` (lib/business-profile.js
// loadIssuer(), or the snapshot frozen on the quotation); without one the identity printed before the business profile existed is used.
const { documentTitle, documentBusinessName, legacyIssuer } = require('../lib/business-profile-core');

const GOLD       = '#D4AF37';
const GOLD_LIGHT = '#FDF8E6';
const DARK       = '#1A1A1A';
const GREY       = '#666666';
const LIGHT_GREY = '#F5F5F5';
const MID_GREY   = '#DDDDDD';
const WHITE      = '#FFFFFF';
const LIGHT_TEXT = '#F0EEE6';

// Wordmark fonts — Cormorant Garamond, matching the rest of the brand
// Falls back to PDFKit's built-in Times-Roman/Times-Italic if TTF files are missing.
const WORDMARK_FONT_REGULAR = path.join(__dirname, '..', 'fonts', 'CormorantGaramond-Regular.ttf');
const WORDMARK_FONT_ITALIC  = path.join(__dirname, '..', 'fonts', 'CormorantGaramond-Italic.ttf');

class PDFService {
    // The shared letterhead: brand bar + title, then the issuer band (legal name, registration / VAT numbers, address, contact). Quotation, invoice,
    // agreement and advancing pack all come through here. Returns the Y of the band's bottom edge so the page content can start below it.
    // `issuer` = lib/business-profile-core issuerView() / a snapshot of it; `vatCharged` = VAT is charged on THIS document (decides TAX INVOICE).
    _drawHeader(doc, type, number, issuer, vatCharged) {
        issuer = issuer || legacyIssuer();
        const isQuoteOrInvoice = type === 'Quote' || type === 'Invoice';
        const TOP_NAME_WIDTH = 206;   // x=28 to x=234 — stops well short of the title block, which starts at x=250

        // The quotation/invoice header carries no logo — in its place, top-left of the gold bar, the business name the owner
        // actually wants leading the document: the trading name when one is configured, else the registered company name
        // (lib/business-profile-core documentBusinessName). The dark band below always names the REGISTERED company, never the
        // trading name (_drawIssuerBandStacked) — the two rows answer different questions ("who you're dealing with" vs "who this
        // legally is") and must not say the same thing only some of the time.
        //
        // Same size as the document title (22pt) and the same y — they read as one aligned row — for as long as the name actually
        // fits on one line at that size; a longer name steps the size down (same shrink-to-fit idea _drawWordmark already uses for
        // the wordmark) rather than overlapping the title or wrapping to an unreadably small multi-line block.
        const topName = isQuoteOrInvoice ? documentBusinessName(issuer) : null;
        let topNameSize = 22, topNameH = 0;
        if (topName) {
            doc.font('Helvetica-Bold');
            for (; topNameSize > 11; topNameSize--) {
                if (doc.fontSize(topNameSize).widthOfString(topName) <= TOP_NAME_WIDTH) break;
            }
            topNameH = doc.fontSize(topNameSize).heightOfString(topName, { width: TOP_NAME_WIDTH });
        }

        // The gold bar only needs to hold the 70px wordmark card on the agreement/advancing-pack header; the quotation/invoice
        // header has no card to hold (no logo), so it is normally shorter there, just tall enough for the title + number — and
        // only taller when the name above still needs a second line even at the smallest size, up to a cap (a quote/invoice with a
        // 3-line address spilled a blank page at the first, uncapped version of this — test/quote-flow.test.js).
        const goldH = isQuoteOrInvoice ? Math.min(100, Math.max(68, 24 + topNameH + 10)) : 100;
        doc.rect(0, 0, 612, goldH).fillColor(GOLD).fill();

        if (topName) {
            doc.fillColor(DARK).font('Helvetica-Bold').fontSize(topNameSize)
               .text(topName, 28, 24, { width: TOP_NAME_WIDTH, height: goldH - 24 - 6, ellipsis: true });
        }

        // The agreement/advancing-pack header is unchanged: same dark/obsidian wordmark card as before.
        if (!isQuoteOrInvoice) {
            // Dark/obsidian backing behind the wordmark. The brand mark is a light
            // "Thabiso" + gold italic "Mhlongo" lockup designed for dark surfaces.
            // A dark card keeps it legible and echoes the dark company band below.
            // Sized larger (220x70, Y=15) to make the logo look prominent and premium.
            doc.roundedRect(20, 15, 220, 70, 3).fillColor(DARK).fill();
            doc.roundedRect(20, 15, 220, 70, 3).lineWidth(0.75).strokeColor(GOLD).stroke();

            this._drawWordmark(doc, 20, 15, 220, 70);
        }

        // Document title — right side of gold bar (aligned to the right margin of 584).
        // QUOTATION for a quotation. An invoice reads TAX INVOICE only when we are VAT-registered AND confirmed with SARS AND VAT is charged on
        // it; otherwise it is plainly INVOICE and never implies VAT was charged (lib/business-profile-core documentTitle).
        const label = documentTitle(type, issuer, vatCharged);
        doc.fillColor(DARK).font('Helvetica-Bold').fontSize(22)
           .text(label, 250, 24, { width: 334, align: 'right' });

        doc.font('Helvetica').fontSize(9).fillColor(DARK)
           .text(`# ${number}`, 250, 52, { width: 334, align: 'right' });

        if (isQuoteOrInvoice) return this._drawIssuerBandStacked(doc, issuer, goldH);

        // Issuer band (agreement / advancing pack — unchanged). Companies always show the registration number (Companies Act s32);
        // the VAT number only when VAT is active (registered AND confirmed).
        const ids = [];
        if (issuer.registrationNumber) ids.push(`Reg No: ${issuer.registrationNumber}`);
        if (issuer.vatRegistered && issuer.vatNumber) ids.push(`VAT No: ${issuer.vatNumber}`);
        const contact = [issuer.email, issuer.phone, issuer.website].filter(Boolean).join('  ·  ');
        const lines = [
            { t: issuer.legalName + (issuer.tradingName ? `  t/a ${issuer.tradingName}` : ''), ids: ids.join('   ·   '), font: 'Helvetica-Bold', size: 9, color: WHITE },
            issuer.registeredOffice ? { t: issuer.registeredOffice, font: 'Helvetica', size: 7.5, color: '#AAAAAA' } : null,
            contact ? { t: contact, font: 'Helvetica', size: 7.5, color: '#AAAAAA' } : null
        ].filter(Boolean);
        const bandH = 14 + lines.length * 11;
        doc.rect(0, goldH, 612, bandH).fillColor(DARK).fill();
        let by = goldH + 8;
        lines.forEach(l => {
            if (l.ids) {   // legal name, then the registration / VAT numbers on the same line
                doc.fillColor(l.color).font(l.font).fontSize(l.size).text(l.t, 28, by, { width: 556, lineBreak: false });
                const w = doc.widthOfString(l.t);
                doc.fillColor('#D8D8D8').font('Helvetica').fontSize(7.5).text(l.ids, 28 + w + 14, by + 1, { width: Math.max(60, 556 - w - 14), height: 12, ellipsis: true });
            } else {
                doc.fillColor(l.color).font(l.font).fontSize(l.size).text(l.t, 28, by, { width: 556, height: 12, ellipsis: true });
            }
            by += l.size > 8 ? 12 : 11;
        });
        return goldH + bandH;
    }

    // The quotation/invoice issuer band: the REGISTERED company name (never the trading name — that already led the gold bar
    // above), then registration/VAT numbers, then the address, then the e-mail — each on its own left-aligned line (no field is
    // printed with an empty value; a line with nothing to say is skipped, never blank).
    // Line heights are deliberately tight (not the agreement header's roomier 11-12px) — this band can run to six or seven lines
    // (a 3-line address plus both id lines) where the old one ever had three, and a quotation still has to fit on one page.
    _drawIssuerBandStacked(doc, issuer, top) {
        const name = issuer.legalName || null;
        const idLines = [];
        if (issuer.registrationNumber) idLines.push(`Reg No: ${issuer.registrationNumber}`);
        if (issuer.vatRegistered && issuer.vatNumber) idLines.push(`VAT No: ${issuer.vatNumber}`);
        const addrLines = Array.isArray(issuer.addressLines) ? issuer.addressLines.filter(Boolean) : (issuer.registeredOffice ? [issuer.registeredOffice] : []);
        const lines = [
            name ? { t: name, font: 'Helvetica-Bold', size: 10, color: WHITE } : null,
            ...idLines.map(t => ({ t, font: 'Helvetica', size: 7.5, color: '#D8D8D8' })),
            ...addrLines.map(t => ({ t, font: 'Helvetica', size: 7, color: '#AAAAAA' })),
            issuer.email ? { t: issuer.email, font: 'Helvetica', size: 7, color: '#AAAAAA' } : null
        ].filter(Boolean);
        const lineH = (l) => (l.size >= 10 ? 13 : 9.5);
        const bandH = 10 + lines.reduce((h, l) => h + lineH(l), 0);
        doc.rect(0, top, 612, bandH).fillColor(DARK).fill();
        let by = top + 7;
        lines.forEach(l => {
            doc.fillColor(l.color).font(l.font).fontSize(l.size).text(l.t, 28, by, { width: 556, height: 11, ellipsis: true });
            by += lineH(l);
        });
        return top + bandH;
    }

    // Draws "Thabiso" (regular) + "Mhlongo" (italic, gold) as native PDF text,
    // sized to fill the card and baseline-aligned between the two weights.
    // No image asset to upload, fetch, or keep in sync — just text + fonts.
    _drawWordmark(doc, cardX, cardY, cardW, cardH) {
        const haveCustomFont = fs.existsSync(WORDMARK_FONT_REGULAR) && fs.existsSync(WORDMARK_FONT_ITALIC);
        const regularFont = haveCustomFont ? WORDMARK_FONT_REGULAR : 'Times-Roman';
        const italicFont  = haveCustomFont ? WORDMARK_FONT_ITALIC  : 'Times-Italic';

        const firstName = 'Thabiso';
        const surname   = 'Mhlongo';
        const gap       = 6;
        const maxWidth  = cardW - 16; // 8pt padding each side

        // Largest firstName size (surname scaled at 0.65x for larger display) that fits the card width
        let size1 = 42, size2, w1, w2;
        for (; size1 >= 10; size1--) {
            size2 = Math.round(size1 * 0.65);
            doc.font(regularFont).fontSize(size1);
            w1 = doc.widthOfString(firstName);
            doc.font(italicFont).fontSize(size2);
            w2 = doc.widthOfString(surname);
            if (w1 + gap + w2 <= maxWidth) break;
        }

        const totalW  = w1 + gap + w2;
        const startX  = cardX + (cardW - totalW) / 2;
        const centerY = cardY + cardH / 2;

        // Baseline-align the two words using real font ascender/descender metrics
        // rather than just centering each text box (which looks uneven at mixed sizes).
        doc.font(regularFont).fontSize(size1);
        const f1 = doc._font;
        const upm1 = (f1.font && f1.font.unitsPerEm) || 1000;
        const asc1 = (f1.ascender / upm1) * size1;
        const desc1 = (f1.descender / upm1) * size1; // negative

        doc.font(italicFont).fontSize(size2);
        const f2 = doc._font;
        const upm2 = (f2.font && f2.font.unitsPerEm) || 1000;
        const asc2 = (f2.ascender / upm2) * size2;

        const baselineY = centerY + (asc1 + desc1) / 2;

        doc.font(regularFont).fontSize(size1).fillColor(LIGHT_TEXT)
           .text(firstName, startX, baselineY - asc1, { lineBreak: false });

        doc.font(italicFont).fontSize(size2).fillColor(GOLD)
           .text(surname, startX + w1 + gap, baselineY - asc2, { lineBreak: false });
    }

    // The date a quotation is valid until: the expiry the administrator chose for it (YYYY-MM-DD - the same date the
    // booking tracker enforces when the client accepts), formatted for the document. null when the caller passed none.
    _chosenExpiry(opts) {
        const m = opts && opts.quoteExpiry ? moment(opts.quoteExpiry, 'YYYY-MM-DD', true) : null;
        return m && m.isValid() ? m.format('DD MMM YYYY') : null;
    }

    // Returns the Y coordinate of the bottom of the cards
    _drawInfoSection(doc, booking, clientVat, type, opts = {}, topY = 148) {
        const cardW  = 270;
        const leftX  = 28;
        const rightX = 314;
        const valW   = cardW - 86; // width available for event value text

        const validDays = parseInt(process.env.QUOTE_VALIDITY_DAYS) || 14;
        // opts.docDate: a re-render of an already issued invoice (refreshInvoicePdf) passes the date it
        // was issued with, pre-formatted; a new document is dated today.
        const docDate   = opts.docDate || moment().format('DD MMM YYYY');
        // "VALID UNTIL" is the expiry chosen on the quote. Only a caller that passes none gets the old "N days from today".
        const expDate   = this._chosenExpiry(opts) || moment().add(validDays, 'days').format('DD MMM YYYY');

        const eventRows = [
            ['BOOKING REF', `#${booking.id}`],
            ['EVENT',  booking.event_name || 'N/A'],
            ['DATE',   booking.date],
            ['VENUE',  booking.event_location || 'TBD'],
        ];
        // A quotation says when it was issued and exactly when it lapses; an invoice says when it was issued, when it falls due and which quotation it came from.
        if (type === 'Quote') {
            eventRows.push(['QUOTE DATE', docDate], ['VALID UNTIL', expDate]);
        } else {
            eventRows.push(['INVOICE DATE', docDate]);
            const due = opts.dueDate ? moment(opts.dueDate, 'YYYY-MM-DD', true) : null;
            if (due && due.isValid()) eventRows.push(['PAYMENT DUE', due.format('DD MMM YYYY')]);
            if (type === 'Invoice' && opts.quoteNumber) eventRows.push(['QUOTE REF', opts.quoteNumber]);
        }
        // Opportunistic cross-reference: only present when a contract already existed at the time
        // this invoice was generated (see generateInvoice in server.js) — older/earlier invoices
        // simply omit the row, same optional-citation pattern as the contract's quote citation.
        if (type === 'Invoice' && opts.contractNumber) {
            eventRows.push(['AGREEMENT', opts.contractNumber]);
        }

        // Pre-measure each event row so we know exact heights before drawing
        const rowHeights = eventRows.map(([, val]) => {
            const measured = doc.font('Helvetica').fontSize(8.5).heightOfString(val, { width: valW });
            return Math.max(14, measured) + 2;
        });

        // Total content height for each card
        const labelBarH   = 16;
        const topPad      = 7;
        const bottomPad   = 10;

        const eventBodyH  = rowHeights.reduce((a, b) => a + b, 0);
        const eventCardH  = labelBarH + topPad + eventBodyH + bottomPad;

        // Bill-to card height (simple fixed rows)
        let billBodyH = 14; // name
        if (booking.company) billBodyH += 12;
        if (clientVat)       billBodyH += 11;
        // The customer's postal address, when we hold one (a full tax invoice needs it). Never invented.
        const clientAddress = String(opts.clientAddress || '').split('\n').map(s => s.trim()).filter(Boolean).join(', ');
        const addrH = clientAddress ? doc.font('Helvetica').fontSize(8).heightOfString(clientAddress, { width: cardW - 16 }) + 2 : 0;
        billBodyH += addrH;
        billBodyH += 11 + 11; // email + cell
        const billCardH = labelBarH + topPad + billBodyH + bottomPad;

        const cardH = Math.max(eventCardH, billCardH, 100);

        // ── LEFT CARD: BILL TO ──────────────────────────────────────────────
        doc.rect(leftX, topY, cardW, cardH).fillColor(LIGHT_GREY).fill();
        doc.rect(leftX, topY, cardW, labelBarH).fillColor(GOLD).fill();
        doc.fillColor(DARK).font('Helvetica-Bold').fontSize(7)
           .text('BILL TO', leftX + 8, topY + 5, { characterSpacing: 1.5 });

        let ly = topY + labelBarH + topPad;
        doc.fillColor(DARK).font('Helvetica-Bold').fontSize(10)
           .text(booking.name, leftX + 8, ly);
        ly += 14;
        if (booking.company) {
            doc.font('Helvetica').fontSize(8.5).fillColor(GREY)
               .text(booking.company, leftX + 8, ly);
            ly += 12;
        }
        if (clientVat) {
            doc.font('Helvetica').fontSize(7.5).fillColor(GREY)
               .text(`VAT No: ${clientVat}`, leftX + 8, ly);
            ly += 11;
        }
        if (clientAddress) {
            doc.font('Helvetica').fontSize(8).fillColor(GREY).text(clientAddress, leftX + 8, ly, { width: cardW - 16 });
            ly += addrH;
        }
        doc.font('Helvetica').fontSize(8.5).fillColor(GREY)
           .text(booking.email, leftX + 8, ly);
        ly += 11;
        doc.text(booking.cell, leftX + 8, ly);

        doc.rect(leftX, topY, cardW, cardH).lineWidth(0.5).strokeColor(MID_GREY).stroke();

        // ── RIGHT CARD: EVENT DETAILS ────────────────────────────────────────
        doc.rect(rightX, topY, cardW, cardH).fillColor(LIGHT_GREY).fill();
        doc.rect(rightX, topY, cardW, labelBarH).fillColor(DARK).fill();
        doc.fillColor(GOLD).font('Helvetica-Bold').fontSize(7)
           .text('EVENT DETAILS', rightX + 8, topY + 5, { characterSpacing: 1.5 });

        let ry = topY + labelBarH + topPad;
        eventRows.forEach(([lbl, val], i) => {
            doc.font('Helvetica-Bold').fontSize(7).fillColor(GREY)
               .text(lbl + ':', rightX + 8, ry);
            doc.font('Helvetica').fontSize(8.5).fillColor(DARK)
               .text(val, rightX + 78, ry, { width: valW });
            ry += rowHeights[i];
        });

        doc.rect(rightX, topY, cardW, cardH).lineWidth(0.5).strokeColor(MID_GREY).stroke();

        return topY + cardH; // bottom edge — used by caller to position table
    }

    _drawTableHeader(doc, y) {
        doc.rect(28, y, 556, 20).fillColor(DARK).fill();
        doc.fillColor(GOLD).font('Helvetica-Bold').fontSize(8)
           .text('SERVICE DESCRIPTION', 38, y + 6, { characterSpacing: 0.6 });
        doc.text('AMOUNT', 38, y + 6, { width: 546, align: 'right' });
        return y + 20;
    }

    _drawFooter(doc, type, opts = {}) {
        const bottom = doc.page.height - 65;
        doc.rect(28, bottom, 556, 1.5).fillColor(GOLD).fill();

        const validDays = parseInt(process.env.QUOTE_VALIDITY_DAYS) || 14;
        const validUntil = type === 'Quote' ? this._chosenExpiry(opts) : null;
        // The validity sentence belongs to the QUOTATION only. This footer is shared with the invoice, which used to print "Quotes are valid
        // for 14 days." too; an invoice just thanks the client (no payment terms are invented here - those live on the invoice itself).
        const thanks = validUntil
            ? `Thank you for your business. This quotation is valid until ${validUntil}.`
            : (type === 'Quote' ? `Thank you for your business. Quotes are valid for ${validDays} days.` : 'Thank you for your business.');
        // The footer sits inside the page's bottom margin (28pt) and PDFKit starts a new page for any line that ends below
        // that margin, so the last footer line used to spill onto an otherwise blank second page of every quote and
        // invoice. Lifting the margin while these three lines are drawn keeps the document to the pages its content needs.
        // Footer identity (same issuer as the header): legal name, registration / VAT numbers, registered office, contact. A company
        // always carries its registration number; "Not registered for VAT" is printed only when the profile says so outright.
        const issuer = opts.issuer || legacyIssuer();
        const idBits = [issuer.legalName];
        if (issuer.registrationNumber) idBits.push(`Reg No ${issuer.registrationNumber}`);
        if (issuer.vatRegistered && issuer.vatNumber) idBits.push(`VAT No ${issuer.vatNumber}`);
        else if (issuer.notVatRegistered) idBits.push('Not registered for VAT');
        const contact = [issuer.email, issuer.website, issuer.phone].filter(Boolean).join('  ·  ');
        const footLines = [
            thanks,
            idBits.join('  ·  '),
            issuer.registeredOffice ? `Registered office: ${issuer.registeredOffice}` : '',
            contact
        ].filter(Boolean);
        const bottomMargin = doc.page.margins.bottom;
        doc.page.margins.bottom = 0;
        doc.fillColor(GREY).font('Helvetica').fontSize(7.5);
        footLines.forEach((t, i) => doc.text(t, 28, bottom + 6 + i * 11, { align: 'center', width: 556, height: 10, ellipsis: true }));
        doc.page.margins.bottom = bottomMargin;
    }

    formatDuration(mins) {
        if (!mins || mins <= 0) return '0m';
        const h = Math.floor(mins / 60);
        const m = mins % 60;
        if (h > 0 && m > 0) return `${h}h ${m}m`;
        if (h > 0) return `${h}h`;
        return `${m}m`;
    }

    /**
     * @param {string} [docNumberOverride] - Render this exact document number on the PDF instead of
     *   deriving one. Invoices must pass it: generateInvoice() allocates `invoices.invoice_number`
     *   itself, and the derived `INV-<bookingId>-<YYMM>` below never matched the stored number, so
     *   the number on the client's PDF disagreed with the ledger.
     */
    async generateDocument(type, booking, lineItems, outputPath, schedules = [], docNumberOverride = null, opts = {}) {
        // A PDF prints plain text, but the database holds entity-encoded text ("O&#x27;Brien &amp; Sons") - decode the
        // whole record first or the quote/invoice shows the raw entities. See lib/html-sanitize.js.
        booking = decodeStoredDeep(booking);
        lineItems = decodeStoredDeep(lineItems);
        schedules = decodeStoredDeep(schedules);
        opts = decodeStoredDeep(opts);
        return new Promise((resolve, reject) => {
            const doc = new PDFDocument({ margin: 28 });
            const stream = fs.createWriteStream(outputPath);
            doc.pipe(stream);

            // The business identity on this document. Callers pass the issuer (lib/business-profile.js loadIssuer(), or the snapshot frozen on
            // the quotation an invoice came from); with none, the legacy identity is printed. VAT is charged ONLY when the document says so
            // (booking.apply_vat - the quotation's own choice, kept on its stored basis); nothing here decides VAT from an amount or an env var.
            const issuer       = opts.issuer || legacyIssuer();
            const vatCharged   = !!booking.apply_vat;
            const clientVat    = booking.vat_number || booking.client_vat_number || '';

            const docNumber = docNumberOverride || (type === 'Quote'
                ? `QT-${booking.id}-${moment().format('YYMMDDHHmmss')}`
                : `INV-${booking.id}-${moment().format('YYMM')}`);

            // 1. Header
            const bandBottom = this._drawHeader(doc, type, docNumber, issuer, vatCharged);

            // 2. Info cards — returns bottom Y so table starts below cards
            const cardsBottomY = this._drawInfoSection(doc, booking, clientVat, type, opts, bandBottom + 12);

            // 3. Line items table — starts 14px below the cards
            let currentY = this._drawTableHeader(doc, cardsBottomY + 10);
            let subtotal        = 0;
            let vatableSubtotal = 0;
            let exemptSubtotal  = 0;
            let rowIndex        = 0;

            const finCatLabels = {
                'PERFORMANCE_REV': 'Performance Revenue',
                'TRAVEL_REIMB':    'Travel & Reimbursement',
                'PRODUCTION':      'Production',
                'OTHER':           'Other',
            };

            const categoryGroups = [];
            const categoryIndex  = {};
            lineItems.forEach(item => {
                const cat = item.financial_category || 'UNCATEGORIZED';
                if (categoryIndex[cat] === undefined) {
                    categoryIndex[cat] = categoryGroups.length;
                    categoryGroups.push({ label: cat, items: [] });
                }
                categoryGroups[categoryIndex[cat]].items.push(item);
            });

            const renderLineItem = (item) => {
                const isFlat      = item.pricing_model === 'flat' || item.pricing_model === 'flat_fee' || item.is_flat;
                const isPerMinute = item.pricing_model === 'per_minute';
                const isPerHour   = item.pricing_model === 'per_hour';

                const qty   = parseFloat(item.quantity) || parseFloat(item.quantity_minutes) || 0;
                const price = parseFloat(item.unit_price) || 0;   // the line's own stored price, never today's catalogue fee
                // A flat-fee line is the price alone only for a single unit. Two nights of a flat "per night" add-on is
                // 2 x the price - the stored quote total, the email and the invoice all say so, and the PDF must too.
                const flatSingle = isFlat && !(qty > 1);

                let lineAmt = parseFloat(item.total_price);
                if (isNaN(lineAmt)) {
                    lineAmt = flatSingle ? price : (qty * price);
                }

                const unitLabel = item.display_unit || (isPerMinute ? 'min' : (isPerHour ? 'hr' : 'unit'));
                const desc = item.description || item.service_name || item.name;

                let lineText = desc;
                const glCode = item.revenue_gl_code || null;
                if (glCode) lineText += ` [GL: ${glCode}]`;

                const setup = parseInt(item.setup_time_minutes) || 0;
                const perf  = parseInt(item.performance_length_minutes) || 0;
                if (setup > 0 || perf > 0) {
                    lineText += ' (';
                    if (setup > 0) lineText += `Setup: ${this.formatDuration(setup)}`;
                    if (setup > 0 && perf > 0) lineText += ', ';
                    if (perf > 0) lineText += `Perf: ${this.formatDuration(perf)}`;
                    lineText += ')';
                }

                let subText = '';
                if (qty > 0 && !flatSingle) {
                    subText = `${qty} ${unitLabel} × R ${price.toFixed(2)}`;
                } else if (flatSingle) {
                    subText = 'Flat Fee';
                }

                const taxClass = item.tax_class || 'standard';
                const isExempt = taxClass === 'exempt' || taxClass === 'zero-rated';
                if (isExempt) {
                    exemptSubtotal += lineAmt;
                } else {
                    vatableSubtotal += lineAmt;
                }

                const rowH = subText ? 30 : 20;

                // Alternating row background
                if (rowIndex % 2 === 0) {
                    doc.rect(28, currentY, 556, rowH).fillColor(LIGHT_GREY).fill();
                }

                const descLabel = lineText + (isExempt ? '  [EXEMPT]' : '');
                doc.fillColor(DARK).font('Helvetica-Bold').fontSize(9)
                   .text(descLabel, 38, currentY + (subText ? 5 : 6), { width: 430 });

                if (subText) {
                    doc.font('Helvetica').fontSize(7.5).fillColor(GREY)
                       .text(subText, 38, currentY + 17, { width: 430 });
                }

                doc.font('Helvetica-Bold').fontSize(9).fillColor(DARK)
                   .text(`R ${lineAmt.toFixed(2)}`, 38, currentY + (subText ? 11 : 6), { width: 546, align: 'right' });

                subtotal += lineAmt;
                currentY += rowH;
                rowIndex++;

                doc.moveTo(28, currentY).lineTo(584, currentY)
                   .lineWidth(0.3).strokeColor(MID_GREY).stroke();

                if (currentY > 710) { doc.addPage(); currentY = 50; }
            };

            categoryGroups.forEach(group => {
                if (categoryGroups.length > 1) {
                    doc.rect(28, currentY, 556, 16).fillColor('#2A2A2A').fill();
                    doc.fillColor(GOLD).font('Helvetica-Bold').fontSize(7)
                       .text(
                           (finCatLabels[group.label] || group.label).toUpperCase(),
                           38, currentY + 4, { characterSpacing: 1.2 }
                       );
                    currentY += 16;
                }
                group.items.forEach(renderLineItem);
            });

            currentY += 18;

            // 4. Totals block (right-aligned)
            const totalsX = 370;
            const totalsW = 214;
            const discount = parseFloat(booking.discount) || 0;
            const applyVat = vatCharged;

            let vatableBase = vatableSubtotal;
            let exemptBase  = exemptSubtotal;

            const totalsBlockStartY = currentY;

            const drawTotalsRow = (label, value, bold, highlight) => {
                const rh = 22;
                if (highlight) {
                    doc.rect(totalsX, currentY, totalsW, rh).fillColor(GOLD).fill();
                } else if (bold) {
                    doc.rect(totalsX, currentY, totalsW, rh).fillColor(GOLD_LIGHT).fill();
                }

                const fc = bold ? DARK : GREY;
                const fn = bold ? 'Helvetica-Bold' : 'Helvetica';
                const fs = highlight ? 11 : (bold ? 10 : 9);
                const ty = currentY + Math.round((rh - fs) / 2);

                doc.font(fn).fontSize(fs).fillColor(fc).text(label, totalsX + 10, ty);
                doc.font(fn).fontSize(fs).fillColor(fc)
                   .text(value, totalsX + 10, ty, { width: totalsW - 20, align: 'right' });

                doc.moveTo(totalsX, currentY + rh).lineTo(totalsX + totalsW, currentY + rh)
                   .lineWidth(0.3).strokeColor(MID_GREY).stroke();

                currentY += rh;
            };

            // Manual adjustments (credit / debit) - invoices only. They are the booking's own post-quotation changes to the amount payable
            // (lib/booking-adjustments.js): shown after VAT as rows of their own, never folded into a line, and the TOTAL includes them.
            // `amount` is signed and is what was really applied, so the printed total equals the stored invoice total.
            const adjustments = (type === 'Invoice' && Array.isArray(opts.adjustments))
                ? opts.adjustments.filter(a => a && Number.isFinite(parseFloat(a.amount)) && parseFloat(a.amount) !== 0)
                : [];
            const drawAdjustments = (totalBefore) => {
                if (!adjustments.length) return totalBefore;
                drawTotalsRow('Total before adjustments', `R ${totalBefore.toFixed(2)}`, false, false);
                let running = totalBefore;
                adjustments.forEach(a => {
                    const amt = parseFloat(a.amount);
                    drawTotalsRow(a.label || 'Adjustment', `${amt < 0 ? '-' : '+'} R ${Math.abs(amt).toFixed(2)}`, false, false);
                    running += amt;
                });
                return Math.round(running * 100) / 100;
            };

            if (discount > 0) {
                drawTotalsRow('Subtotal', `R ${subtotal.toFixed(2)}`, false, false);
                drawTotalsRow('Discount', `- R ${discount.toFixed(2)}`, false, false);

                const totalSub = vatableSubtotal + exemptSubtotal;
                if (totalSub > 0) {
                    const vatRatio = vatableSubtotal / totalSub;
                    vatableBase = Math.max(0, vatableSubtotal - (discount * vatRatio));
                    exemptBase  = Math.max(0, exemptSubtotal - (discount * (1 - vatRatio)));
                }
            }

            if (applyVat) {
                // FIN-1/2: use the rate the server calc used (passed on the booking) so the PDF total
                // matches the stored invoice/quote total; fall back to env / 0.15 for legacy callers.
                const vatRate = parseFloat(booking.vat_rate ?? process.env.VAT_RATE) || 0.15;
                // Rounded exactly as the stored total is (js/shared/document-totals.js): VAT to the cent, then the total
                // to the cent - otherwise a half-cent case could print a total one cent away from the quotation record.
                const vat     = Math.round(vatableBase * vatRate * 100) / 100;
                const total   = Math.round((vatableBase + exemptBase + vat) * 100) / 100;

                // A VAT document shows the amount before VAT as well as the VAT itself (a discount already printed the Subtotal row above).
                if (!(discount > 0)) drawTotalsRow('Subtotal (excl. VAT)', `R ${subtotal.toFixed(2)}`, false, false);
                if (discount > 0) {
                    drawTotalsRow('Net Taxable', `R ${vatableBase.toFixed(2)}`, false, false);
                }

                drawTotalsRow(
                    `VAT (${(vatRate * 100).toFixed(0)}%)`,
                    `R ${vat.toFixed(2)}`, false, false
                );
                const grand = drawAdjustments(total);
                drawTotalsRow('TOTAL (incl. VAT)', `R ${grand.toFixed(2)}`, true, true);
                subtotal = grand;
            } else {
                const total = Math.round((vatableBase + exemptBase) * 100) / 100;
                const grand = drawAdjustments(total);
                drawTotalsRow('TOTAL AMOUNT', `R ${grand.toFixed(2)}`, true, true);
                subtotal = grand;
            }

            // What has already been received when the invoice is issued (e.g. a deposit paid before the invoice was regenerated), and what is
            // still owed. A snapshot at issue: later payments show on the booking page and the ledger, not on this file.
            const paidAtIssue = type === 'Invoice' ? (parseFloat(booking.amount_paid) || 0) : 0;
            if (paidAtIssue > 0) {
                drawTotalsRow('Paid to date', `- R ${Math.min(paidAtIssue, subtotal).toFixed(2)}`, false, false);
                drawTotalsRow('BALANCE DUE', `R ${Math.max(0, Math.round((subtotal - paidAtIssue) * 100) / 100).toFixed(2)}`, true, false);
            }

            // Outer border around totals block
            doc.rect(totalsX, totalsBlockStartY, totalsW, currentY - totalsBlockStartY)
               .lineWidth(0.5).strokeColor(MID_GREY).stroke();

            // The reason given for each adjustment, under the totals (the rows above stay short enough to sit beside their amounts)
            const adjustmentNotes = adjustments.filter(a => a.note).map(a => `${a.label || 'Adjustment'}: ${a.note}`);
            if (adjustmentNotes.length) {
                const noteText = adjustmentNotes.join('\n');
                const noteH = doc.font('Helvetica').fontSize(7.5).heightOfString(noteText, { width: totalsW });
                doc.fillColor(GREY).font('Helvetica').fontSize(7.5).text(noteText, totalsX, currentY + 5, { width: totalsW, align: 'right' });
                currentY += noteH + 5;
            }

            // 4b. Pricing conditions — quotations only. Prices are never public, so the rate card's conditions
            // (currency, VAT, travel / accommodation / rider, rate validity) are printed where a client first
            // sees an amount. The lines are built once by the quote route (lib/pricing-conditions.js).
            if (type === 'Quote' && Array.isArray(opts.pricingConditions) && opts.pricingConditions.length) {
                const condText = opts.pricingConditions.map(l => '•  ' + l).join('\n');
                const condH = doc.font('Helvetica').fontSize(8.5).heightOfString(condText, { width: 536, lineGap: 2 });
                currentY += 14;
                if (currentY + condH + 40 > 740) { doc.addPage(); currentY = 50; }
                doc.rect(28, currentY, 556, 15).fillColor(DARK).fill();
                doc.fillColor(GOLD).font('Helvetica-Bold').fontSize(7)
                   .text('PRICING CONDITIONS', 38, currentY + 4, { characterSpacing: 1.2 });
                currentY += 15;
                doc.rect(28, currentY, 556, condH + 14).fillColor(LIGHT_GREY).fill();
                doc.font('Helvetica').fontSize(8.5).fillColor(GREY)
                   .text(condText, 38, currentY + 7, { width: 536, lineGap: 2 });
                currentY += condH + 14;
            }

            // 5. Terms & Policies
            currentY += 20;
            if (currentY > 710) { doc.addPage(); currentY = 50; }

            if (type === 'Invoice') {
                doc.rect(28, currentY, 556, 15).fillColor(DARK).fill();
                doc.fillColor(GOLD).font('Helvetica-Bold').fontSize(7)
                   .text('PAYMENT SCHEDULE', 38, currentY + 4, { characterSpacing: 1.2 });
                currentY += 15;

                if (schedules && schedules.length > 0) {
                    const rowH = 18;
                    schedules.forEach((s, i) => {
                        const rowY = currentY + i * rowH;
                        doc.rect(28, rowY, 556, rowH).fillColor(i % 2 === 0 ? LIGHT_GREY : WHITE).fill();
                        doc.font('Helvetica').fontSize(8).fillColor(GREY)
                           .text(s.description, 38, rowY + 5, { width: 220 });
                        doc.font('Helvetica').fontSize(8).fillColor(GREY)
                           .text(s.due_date, 268, rowY + 5, { width: 130 });
                        doc.font('Helvetica-Bold').fontSize(8).fillColor(GOLD)
                           .text(`R ${parseFloat(s.expected_amount).toFixed(2)}`, 408, rowY + 5, { width: 160, align: 'right' });
                    });
                    currentY += schedules.length * rowH + 6;
                } else {
                    doc.rect(28, currentY, 556, 28).fillColor(LIGHT_GREY).fill();
                    doc.fillColor(GREY).font('Helvetica').fontSize(8)
                       .text('Please use your Invoice Number as reference when making payment.', 38, currentY + 5)
                       .text('Payments can be made securely via the portal link sent to your email.', 38, currentY + 16);
                    currentY += 36;
                }
            }

            // 5b. Pay by EFT - invoices only, and only when Manual EFT was switched on and banking details existed when THIS invoice was issued
            // (lib/invoicing.js passes them in). The details are a snapshot of the version in force at that moment: an invoice already issued is
            // never redrawn when the banking details change later, so what a client holds is what they were told. docs-internal/eft-payments.md.
            if (type === 'Invoice' && opts.eft) {
                const e = opts.eft;
                const detailRows = [
                    ['Account holder', e.accountHolder], ['Bank', e.bankName], ['Account number', e.accountNumber],
                    ['Account type', e.accountType], ['Branch code', e.branchCode]
                ];
                if (e.swiftCode) detailRows.push(['SWIFT / BIC', e.swiftCode]);
                // what is being paid and against what: the same figures the invoice above carries (subtotal holds the grand total by now)
                detailRows.push(['Invoice number', docNumber], ['Booking reference', `#${booking.id}`], ['Amount payable', `R ${(Number(subtotal) || 0).toFixed(2)}`]);
                detailRows.push(['Payment reference', e.reference]);
                const notes = [e.referenceNote, e.paymentInstructions,
                    'After you have paid, upload your proof of payment on your booking page. Payment is subject to verification and confirmation of cleared funds in our bank account.'].filter(Boolean).join('\n');
                const rowH = 16;
                const notesH = doc.font('Helvetica').fontSize(8).heightOfString(notes, { width: 536, lineGap: 1.5 });
                const blockH = 15 + detailRows.length * rowH + notesH + 18;
                currentY += 10;
                if (currentY + blockH > 740) { doc.addPage(); currentY = 50; }
                doc.rect(28, currentY, 556, 15).fillColor(DARK).fill();
                doc.fillColor(GOLD).font('Helvetica-Bold').fontSize(7)
                   .text('PAY BY EFT (BANK TRANSFER)', 38, currentY + 4, { characterSpacing: 1.2 });
                currentY += 15;
                detailRows.forEach((r, i) => {
                    const rowY = currentY + i * rowH;
                    const isRef = r[0] === 'Payment reference';
                    doc.rect(28, rowY, 556, rowH).fillColor(i % 2 === 0 ? LIGHT_GREY : WHITE).fill();
                    doc.font('Helvetica').fontSize(8).fillColor(GREY).text(r[0], 38, rowY + 4, { width: 150 });
                    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(isRef ? GOLD : DARK).text(String(r[1] == null ? '' : r[1]), 200, rowY + 4, { width: 372 });
                });
                currentY += detailRows.length * rowH;
                doc.rect(28, currentY, 556, notesH + 12).fillColor(LIGHT_GREY).fill();
                doc.font('Helvetica').fontSize(8).fillColor(GREY).text(notes, 38, currentY + 6, { width: 536, lineGap: 1.5 });
                currentY += notesH + 18;
            }

            const terms = booking.terms || 'Standard cancellation policy applies.';
            // How to accept - quotations only, as the first line of the terms (no extra block, so a quotation still fits on one page). The accept
            // button lives on the client's booking page (the link in the email that carried this quotation) and acceptance is refused after the expiry.
            const until = type === 'Quote' ? this._chosenExpiry(opts) : null;
            const acceptLine = type === 'Quote' ? `To accept this quotation, choose Accept on your booking page (link in the email it came with)${until ? ` on or before ${until}` : ''}.` : '';
            const acceptH = acceptLine ? doc.font('Helvetica-Bold').fontSize(8.5).heightOfString(acceptLine, { width: 536 }) + 4 : 0;
            const termsNeed = 15 + acceptH + doc.font('Helvetica').fontSize(8.5).heightOfString(terms, { width: 536 }) + 14;
            if (currentY > 710 || currentY + termsNeed > 722) { doc.addPage(); currentY = 50; }

            doc.rect(28, currentY, 556, 15).fillColor(DARK).fill();
            doc.fillColor(GOLD).font('Helvetica-Bold').fontSize(7)
               .text('TERMS & CONDITIONS', 38, currentY + 4, { characterSpacing: 1.2 });
            currentY += 15;

            const termsH = doc.font('Helvetica').fontSize(8.5)
                              .heightOfString(terms, { width: 536 });
            doc.rect(28, currentY, 556, acceptH + termsH + 14).fillColor(LIGHT_GREY).fill();
            if (acceptLine) doc.font('Helvetica-Bold').fontSize(8.5).fillColor(DARK).text(acceptLine, 38, currentY + 7, { width: 536 });
            doc.font('Helvetica').fontSize(8.5).fillColor(GREY)
               .text(terms, 38, currentY + 7 + acceptH, { width: 536 });
            currentY += acceptH + termsH + 20;

            // (The "valid Tax Invoice for VAT purposes in terms of section 20" sentence that used to close the invoice is gone with the
            // TAX INVOICE title: the document is simply an invoice.)

            // 6. Footer
            this._drawFooter(doc, type, Object.assign({}, opts, { issuer }));

            doc.end();
            stream.on('finish', () => resolve({ path: outputPath, number: docNumber, total: subtotal }));
            stream.on('error', reject);
        });
    }

    // Branded booking contract, generated from booking data. Reuses the same header/
    // wordmark/brand palette as invoices & quotes; renders a legal-document body
    // (parties, engagement, fee & schedule, terms, signatures). opts:
    //   { policies:{cancellation_policy,payment_terms,deposit_percentage}, schedules:[], totals:{total,applyVat}, contractNo,
    //     clauses:{paymentTerms,cancellation,forceMajeure,travelHospitality,rightsRecording,additionalClauses} }
    // `clauses` fields are final resolved text (server.js already picked override-vs-default) —
    // this method just renders whatever it's given, falling back to `policies`/hardcoded copy
    // only if called without `clauses` at all (defensive; the one real call site always passes it).
    async generateContract(booking, lineItems, outputPath, opts = {}) {
        return new Promise((resolve, reject) => {
            try {
                const doc = new PDFDocument({ margin: 28 });
                const stream = fs.createWriteStream(outputPath);
                doc.pipe(stream);

                const policies   = opts.policies || {};
                const schedules  = opts.schedules || [];
                const totals     = opts.totals || {};
                const clauses    = opts.clauses || {};
                const contractNo = opts.contractNo || `AGR-${booking.id}`;
                const sourceQuoteNumber = opts.sourceQuoteNumber || null;
                const LEFT = 28, WIDTH = 556;
                const money = n => 'R ' + (parseFloat(n) || 0).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

                const fee = (parseFloat(totals.total) || 0) || (lineItems || []).reduce((s, i) => {
                    const tot = parseFloat(i.total_price);
                    if (!isNaN(tot)) return s + tot;
                    return s + (parseFloat(i.quantity || i.quantity_minutes || 1) * parseFloat(i.unit_price || 0));
                }, 0);
                const depositPct = parseFloat(policies.deposit_percentage) || 50;
                const depositAmt = Math.round(fee * depositPct) / 100;
                const balanceAmt = Math.max(0, fee - depositAmt);
                const clientLine = `${booking.name || ''}${booking.company ? ' / ' + booking.company : ''}`;

                // Header (reused)
                const issuer = opts.issuer || legacyIssuer();
                const bandBottom = this._drawHeader(doc, 'Agreement', contractNo, issuer, false);

                const pageBreakGuard = () => { if (doc.y > doc.page.height - 110) doc.addPage(); };
                let sectionNum = 1;
                const sectionTitle = (t) => {
                    pageBreakGuard();
                    doc.moveDown(0.7);
                    doc.font('Helvetica-Bold').fontSize(11).fillColor(DARK).text(`${sectionNum++}. ${t}`, LEFT, doc.y, { width: WIDTH });
                    const yy = doc.y + 2;
                    doc.rect(LEFT, yy, 42, 1.5).fillColor(GOLD).fill();
                    doc.moveDown(0.7);
                };
                const para = (t, o = {}) => {
                    pageBreakGuard();
                    doc.font(o.font || 'Helvetica').fontSize(o.size || 9).fillColor(o.color || '#333333')
                       .text(t, LEFT, doc.y, { width: WIDTH, align: o.align || 'left', lineGap: 1.5 });
                };
                const kv = (k, v) => {
                    pageBreakGuard();
                    doc.font('Helvetica-Bold').fontSize(9).fillColor(DARK).text(k + ':  ', LEFT, doc.y, { continued: true });
                    doc.font('Helvetica').fillColor('#333333').text(String(v == null || v === '' ? 'TBC' : v));
                };

                // Title
                doc.font('Helvetica-Bold').fontSize(16).fillColor(DARK).text('Performance Engagement Agreement', LEFT, bandBottom + 18, { width: WIDTH });
                doc.font('Helvetica').fontSize(9).fillColor(GREY).text(`Agreement ${contractNo}  ·  Prepared ${moment().format('DD MMMM YYYY')}${sourceQuoteNumber ? '  ·  Per accepted quote ' + sourceQuoteNumber : ''}`, LEFT, doc.y + 2, { width: WIDTH });
                doc.moveDown(0.5);
                para('This Agreement records the terms on which the Artist will provide the engagement described below to the Client. It becomes binding once signed by both parties.', { color: GREY, size: 8.5 });

                sectionTitle('Parties');
                kv('The Artist', `${issuer.legalName}${issuer.registrationNumber ? '  (Reg No ' + issuer.registrationNumber + ')' : ''}  (${issuer.email})`);
                kv('The Client', `${clientLine}  (${booking.email || ''}${booking.cell ? ' · ' + booking.cell : ''})`);
                if (booking.vat_number || booking.client_vat_number) kv('Client VAT No', booking.vat_number || booking.client_vat_number);

                sectionTitle('Engagement Details');
                kv('Event', booking.event_name || booking.event_type);
                kv('Type', booking.event_type);
                kv('Date', booking.date);
                kv('Performance slot', booking.performance_slot);
                kv('Duration', booking.performance_duration ? this.formatDuration(parseInt(booking.performance_duration)) : 'TBC');
                kv('Venue', booking.event_location);

                sectionTitle('Fee & Payment');
                para(`Total engagement fee: ${money(fee)}${totals.applyVat ? ' (VAT inclusive)' : ''}.`, { size: 9.5, color: DARK, font: 'Helvetica-Bold' });
                para(`A deposit of ${depositPct}% (${money(depositAmt)}) secures the booking; the balance of ${money(balanceAmt)} is payable per the schedule below.`);
                const paymentTermsText = clauses.paymentTerms || policies.payment_terms;
                if (paymentTermsText) para(paymentTermsText, { color: GREY, size: 8.5 });
                if (schedules.length) {
                    doc.moveDown(0.3);
                    schedules.forEach((s, i) => {
                        pageBreakGuard();
                        doc.font('Helvetica').fontSize(8.5).fillColor('#333333')
                           .text(`${i + 1}. ${s.description || 'Milestone'} — due ${s.due_date || 'TBC'}`, LEFT + 6, doc.y, { continued: true })
                           .font('Helvetica-Bold').fillColor(DARK).text('   ' + money(s.expected_amount));
                    });
                }

                sectionTitle('Cancellation Policy');
                para(clauses.cancellation || policies.cancellation_policy || 'Cancellations are subject to the standard cancellation policy; the deposit may be non-refundable depending on the notice given before the event date.', { size: 8.5 });

                sectionTitle('Force Majeure');
                para(clauses.forceMajeure || 'Neither party is liable for a failure to perform caused by events beyond reasonable control (illness, extreme weather, disaster, or lawful restriction); the parties will act in good faith to reschedule or refund fairly.', { size: 8.5 });

                if (clauses.travelHospitality) {
                    sectionTitle('Travel & Hospitality');
                    para(clauses.travelHospitality, { size: 8.5 });
                }

                if (clauses.rightsRecording) {
                    sectionTitle('Rights & Recording');
                    para(clauses.rightsRecording, { size: 8.5 });
                }

                if (clauses.additionalClauses) {
                    sectionTitle('Additional Clauses');
                    para(clauses.additionalClauses, { size: 8.5 });
                }

                sectionTitle('General Terms');
                [
                    'The Artist will perform professionally and to the best of their ability for the agreed duration. The Client will provide a safe, suitable performance environment and any technical requirements agreed in advance.',
                    'This Agreement is governed by and construed under the laws of the Republic of South Africa.'
                ].forEach((c, i) => para(`${i + 1}. ${c}`, { size: 8.5 }));

                sectionTitle('Signatures');
                if (doc.y > doc.page.height - 150) doc.addPage();
                doc.moveDown(1.2);
                const sigY = doc.y;
                const colW = (WIDTH - 40) / 2;
                const sigBlock = (x, role, name) => {
                    doc.font('Helvetica-Bold').fontSize(9).fillColor(DARK).text(role, x, sigY, { width: colW });
                    if (name) doc.font('Helvetica').fontSize(8.5).fillColor('#333333').text(name, x, sigY + 12, { width: colW });
                    doc.rect(x, sigY + 44, colW, 1).fillColor(MID_GREY).fill();
                    doc.font('Helvetica').fontSize(8).fillColor(GREY).text('Signature', x, sigY + 48, { width: colW });
                    doc.rect(x, sigY + 80, colW, 1).fillColor(MID_GREY).fill();
                    doc.text('Name / Date', x, sigY + 84, { width: colW });
                };
                sigBlock(LEFT, 'The Client', clientLine);
                sigBlock(LEFT + colW + 40, 'The Artist', issuer.legalName);

                // Contract footer (dedicated — the shared footer is quote-worded)
                const bottom = doc.page.height - 66;
                doc.rect(28, bottom, 556, 1.5).fillColor(GOLD).fill();
                doc.fillColor(GREY).font('Helvetica').fontSize(7.5)
                   .text(`${issuer.legalName}${issuer.registrationNumber ? '  ·  Reg No ' + issuer.registrationNumber : ''}  ·  ${issuer.email}  ·  ${issuer.website}`, 28, bottom + 8, { align: 'center', width: 556 })
                   .text('This document was generated by the Thabiso Mhlongo Official Booking System.', 28, bottom + 19, { align: 'center', width: 556 });

                doc.end();
                stream.on('finish', () => resolve({ success: true, path: outputPath, number: contractNo }));
                stream.on('error', reject);
            } catch (e) { reject(e); }
        });
    }

    // Show-day operations pack (run-of-show, technical, hospitality, contacts, travel).
    // Structurally a free-form sectioned document like generateContract(), not a line-items
    // invoice, so it does NOT go through generateDocument()'s type dispatch. `contacts` is a
    // caller-supplied snapshot (auto-sourced + extras already merged) — this method just renders
    // whatever it's given. `pack.internal_notes` is intentionally never rendered here — it's
    // office-only and must not leak into a document sent to the client or venue.
    async generateAdvancingPack(booking, pack, rosItems, contacts, outputPath, opts = {}) {
        return new Promise((resolve, reject) => {
            try {
                const doc = new PDFDocument({ margin: 28 });
                const stream = fs.createWriteStream(outputPath);
                doc.pipe(stream);

                const LEFT = 28, WIDTH = 556;
                const packNo = `ADV-${booking.id}`;

                const issuer = opts.issuer || legacyIssuer();
                const bandBottom = this._drawHeader(doc, 'Advancing Pack', packNo, issuer, false);

                const pageBreakGuard = () => { if (doc.y > doc.page.height - 110) doc.addPage(); };
                const sectionTitle = (t) => {
                    pageBreakGuard();
                    doc.moveDown(0.7);
                    doc.font('Helvetica-Bold').fontSize(11).fillColor(DARK).text(t, LEFT, doc.y, { width: WIDTH });
                    const yy = doc.y + 2;
                    doc.rect(LEFT, yy, 42, 1.5).fillColor(GOLD).fill();
                    doc.moveDown(0.7);
                };
                const para = (t, o = {}) => {
                    pageBreakGuard();
                    doc.font(o.font || 'Helvetica').fontSize(o.size || 9).fillColor(o.color || '#333333')
                       .text(t, LEFT, doc.y, { width: WIDTH, align: o.align || 'left', lineGap: 1.5 });
                };
                const kv = (k, v) => {
                    pageBreakGuard();
                    doc.font('Helvetica-Bold').fontSize(9).fillColor(DARK).text(k + ':  ', LEFT, doc.y, { continued: true });
                    doc.font('Helvetica').fillColor('#333333').text(String(v == null || v === '' ? 'TBC' : v));
                };

                doc.font('Helvetica-Bold').fontSize(16).fillColor(DARK).text('Advancing Pack', LEFT, bandBottom + 18, { width: WIDTH });
                doc.font('Helvetica').fontSize(9).fillColor(GREY).text(`${packNo}  ·  Prepared ${moment().format('DD MMMM YYYY')}`, LEFT, doc.y + 2, { width: WIDTH });
                doc.moveDown(0.5);

                sectionTitle('Event');
                kv('Event', booking.event_name || booking.event_type);
                kv('Date', booking.date);
                kv('Venue', booking.event_location);

                sectionTitle('Run of Show');
                if (rosItems && rosItems.length) {
                    rosItems.forEach((item) => {
                        pageBreakGuard();
                        doc.font('Helvetica-Bold').fontSize(9).fillColor(DARK)
                           .text(`${item.time_label || '—'}   ${item.title}`, LEFT, doc.y);
                        const meta = [item.detail, item.responsible ? 'Responsible: ' + item.responsible : ''].filter(Boolean).join('  ·  ');
                        if (meta) doc.font('Helvetica').fontSize(8).fillColor(GREY).text(meta, LEFT + 8, doc.y);
                        doc.moveDown(0.35);
                    });
                } else {
                    para('No run-of-show items recorded.', { color: GREY, size: 8.5 });
                }

                sectionTitle('Technical');
                kv('Mic type', pack.mic_type);
                kv('PA spec', pack.pa_spec);
                kv('Monitors', pack.monitors);
                kv('Lighting', pack.lighting);
                kv('Stage layout', pack.stage_layout);
                kv('Equipment responsibility', pack.equipment_responsibility);

                sectionTitle('Hospitality');
                kv('Green room notes', pack.green_room_notes);
                kv('Meals', pack.meals);
                kv('Dietary', pack.dietary);
                kv('Parking / Wi-Fi', pack.parking_wifi);

                sectionTitle('Contacts');
                if (contacts && contacts.length) {
                    contacts.forEach((c) => {
                        pageBreakGuard();
                        doc.font('Helvetica-Bold').fontSize(9).fillColor(DARK).text(`${c.role || 'Contact'}: ${c.name || 'TBC'}`, LEFT, doc.y);
                        const meta = [c.phone, c.email].filter(Boolean).join('  ·  ');
                        if (meta) doc.font('Helvetica').fontSize(8).fillColor(GREY).text(meta, LEFT + 8, doc.y);
                        doc.moveDown(0.35);
                    });
                } else {
                    para('No contacts recorded.', { color: GREY, size: 8.5 });
                }

                sectionTitle('Travel & Accommodation');
                kv('Travel type', pack.travel_type);
                kv('Flights', pack.flights);
                kv('Hotel', pack.hotel);
                kv('Ground transport', pack.ground_transport);

                const bottom = doc.page.height - 66;
                doc.rect(28, bottom, 556, 1.5).fillColor(GOLD).fill();
                doc.fillColor(GREY).font('Helvetica').fontSize(7.5)
                   .text(`${issuer.legalName}${issuer.registrationNumber ? '  ·  Reg No ' + issuer.registrationNumber : ''}  ·  ${issuer.email}  ·  ${issuer.website}`, 28, bottom + 8, { align: 'center', width: 556 })
                   .text('This document was generated by the Thabiso Mhlongo Official Booking System.', 28, bottom + 19, { align: 'center', width: 556 });

                doc.end();
                stream.on('finish', () => resolve({ success: true, path: outputPath, number: packNo }));
                stream.on('error', reject);
            } catch (e) { reject(e); }
        });
    }
}

module.exports = new PDFService();
