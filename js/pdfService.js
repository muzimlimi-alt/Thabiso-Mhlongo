const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const moment = require('moment-timezone');

const TAX_INVOICE_THRESHOLD = 5000;
const OUR_VAT_REG = process.env.COMPANY_VAT_NUMBER || '';

const GOLD       = '#D4AF37';
const GOLD_LIGHT = '#FDF8E6';
const DARK       = '#1A1A1A';
const GREY       = '#666666';
const LIGHT_GREY = '#F5F5F5';
const MID_GREY   = '#DDDDDD';
const WHITE      = '#FFFFFF';

class PDFService {
    constructor() {
        this.logoPath = path.join(__dirname, '..', 'images', 'logo4.png');
        this.companyInfo = {
            name:    process.env.COMPANY_NAME    || "Thabiso Mhlongo Management",
            address: process.env.COMPANY_ADDRESS || "Johannesburg, South Africa",
            email:   process.env.COMPANY_EMAIL   || "bookings@thabisomhlongo.com",
            website: process.env.COMPANY_WEBSITE || "www.thabisomhlongo.com"
        };
    }

    _drawHeader(doc, type, number, isTaxInvoice) {
        // Gold bar
        doc.rect(0, 0, 612, 100).fillColor(GOLD).fill();

        // White backing behind logo so it's visible on any gold shade
        doc.roundedRect(20, 8, 148, 84, 3).fillColor(WHITE).fill();

        const logo = this.logoSource || this.logoPath;
        try {
            if (logo && (typeof logo !== 'string' || fs.existsSync(logo))) {
                doc.image(logo, 22, 10, { width: 144, height: 80, fit: [144, 80] });
            }
        } catch(e) {
            console.error("Error drawing logo:", e);
        }

        // Document type — right side of gold bar
        const label = isTaxInvoice ? 'TAX INVOICE' : type.toUpperCase();
        doc.fillColor(DARK).font('Helvetica-Bold').fontSize(22)
           .text(label, 180, 26, { width: 410, align: 'right' });

        doc.font('Helvetica').fontSize(9).fillColor(DARK)
           .text(`# ${number}`, 180, 54, { width: 410, align: 'right' });

        if (isTaxInvoice && OUR_VAT_REG) {
            doc.fontSize(8).text(`VAT Reg: ${OUR_VAT_REG}`, 180, 67, { width: 410, align: 'right' });
        }

        // Dark company sub-band
        doc.rect(0, 100, 612, 32).fillColor(DARK).fill();

        doc.fillColor(WHITE).font('Helvetica-Bold').fontSize(8.5)
           .text(this.companyInfo.name, 28, 108);

        doc.font('Helvetica').fontSize(7.5).fillColor('#AAAAAA')
           .text(
               `${this.companyInfo.email}  ·  ${this.companyInfo.website}  ·  ${this.companyInfo.address}`,
               28, 120, { width: 556 }
           );
    }

    // Returns the Y coordinate of the bottom of the cards
    _drawInfoSection(doc, booking, clientVat, type) {
        const topY   = 148;
        const cardW  = 270;
        const leftX  = 28;
        const rightX = 314;
        const valW   = cardW - 86; // width available for event value text

        const validDays = parseInt(process.env.QUOTE_VALIDITY_DAYS) || 14;
        const docDate   = moment().format('DD MMM YYYY');
        const expDate   = moment().add(validDays, 'days').format('DD MMM YYYY');

        const eventRows = [
            ['EVENT',  booking.event_name || 'N/A'],
            ['DATE',   booking.date],
            ['VENUE',  booking.event_location || 'TBD'],
            type === 'Quote' ? ['VALID UNTIL', expDate] : ['DOC DATE', docDate],
        ];

        // Pre-measure each event row so we know exact heights before drawing
        const rowHeights = eventRows.map(([, val]) => {
            const measured = doc.font('Helvetica').fontSize(8.5).heightOfString(val, { width: valW });
            return Math.max(14, measured) + 3;
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

    _drawFooter(doc) {
        const bottom = doc.page.height - 65;
        doc.rect(28, bottom, 556, 1.5).fillColor(GOLD).fill();

        const validDays = parseInt(process.env.QUOTE_VALIDITY_DAYS) || 14;
        doc.fillColor(GREY).font('Helvetica').fontSize(7.5)
           .text(`Thank you for your business. Quotes are valid for ${validDays} days.`,
               28, bottom + 8, { align: 'center', width: 556 })
           .text(`${this.companyInfo.name}  ·  ${this.companyInfo.email}  ·  ${this.companyInfo.website}`,
               28, bottom + 20, { align: 'center', width: 556 })
           .text('Generated by Thabiso Mhlongo Official Booking System',
               28, bottom + 32, { align: 'center', width: 556 });
    }

    formatDuration(mins) {
        if (!mins || mins <= 0) return '0m';
        const h = Math.floor(mins / 60);
        const m = mins % 60;
        if (h > 0 && m > 0) return `${h}h ${m}m`;
        if (h > 0) return `${h}h`;
        return `${m}m`;
    }

    async generateDocument(type, booking, lineItems, outputPath) {
        if (process.env.DOC_LOGO) {
            try {
                const res = await fetch(process.env.DOC_LOGO);
                if (res.ok) {
                    const arrayBuffer = await res.arrayBuffer();
                    this.logoSource = Buffer.from(arrayBuffer);
                }
            } catch (e) {
                console.error("Failed to fetch custom logo:", e);
                this.logoSource = null;
            }
        } else {
            this.logoSource = null;
        }

        return new Promise((resolve, reject) => {
            const doc = new PDFDocument({ margin: 28 });
            const stream = fs.createWriteStream(outputPath);
            doc.pipe(stream);

            // Determine TAX INVOICE
            const lineTotal = lineItems.reduce((s, i) => {
                const tot = parseFloat(i.total_price);
                if (!isNaN(tot)) return s + tot;
                const qty   = parseFloat(i.quantity || i.quantity_minutes || 1);
                const price = parseFloat(i.unit_price || i.default_price || 0);
                const isFlat = i.pricing_model === 'flat' || i.pricing_model === 'flat_fee' || i.is_flat;
                return s + (isFlat ? price : qty * price);
            }, 0);
            const clientVat    = booking.vat_number || booking.client_vat_number || '';
            const isTaxInvoice = type === 'Invoice' && (lineTotal >= TAX_INVOICE_THRESHOLD || !!clientVat);

            const docNumber = type === 'Quote'
                ? `QT-${booking.id}-${moment().format('YYMMDDHHmmss')}`
                : `INV-${booking.id}-${moment().format('YYMM')}`;

            // 1. Header
            this._drawHeader(doc, type, docNumber, isTaxInvoice);

            // 2. Info cards — returns bottom Y so table starts below cards
            const cardsBottomY = this._drawInfoSection(doc, booking, clientVat, type);

            // 3. Line items table — starts 14px below the cards
            let currentY = this._drawTableHeader(doc, cardsBottomY + 14);
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
                const price = parseFloat(item.unit_price || item.default_price || 0);

                let lineAmt = parseFloat(item.total_price);
                if (isNaN(lineAmt)) {
                    lineAmt = isFlat ? price : (qty * price);
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
                if (qty > 0 && !isFlat) {
                    subText = `${qty} ${unitLabel} × R ${price.toFixed(2)}`;
                } else if (isFlat) {
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
            const applyVat = booking.apply_vat || (isTaxInvoice && OUR_VAT_REG);

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
                const vatRate = parseFloat(process.env.VAT_RATE) || 0.15;
                const vat     = vatableBase * vatRate;
                const total   = vatableBase + exemptBase + vat;

                if (discount > 0) {
                    drawTotalsRow('Net Taxable', `R ${vatableBase.toFixed(2)}`, false, false);
                }

                drawTotalsRow(
                    `VAT (${((parseFloat(process.env.VAT_RATE) || 0.15) * 100).toFixed(0)}%)`,
                    `R ${vat.toFixed(2)}`, false, false
                );
                drawTotalsRow('TOTAL (incl. VAT)', `R ${total.toFixed(2)}`, true, true);
                subtotal = total;
            } else {
                const total = vatableBase + exemptBase;
                drawTotalsRow('TOTAL AMOUNT', `R ${total.toFixed(2)}`, true, true);
                subtotal = total;
            }

            // Outer border around totals block
            doc.rect(totalsX, totalsBlockStartY, totalsW, currentY - totalsBlockStartY)
               .lineWidth(0.5).strokeColor(MID_GREY).stroke();

            // 5. Terms & Policies
            currentY += 28;
            if (currentY > 710) { doc.addPage(); currentY = 50; }

            if (type === 'Invoice') {
                doc.rect(28, currentY, 556, 15).fillColor(DARK).fill();
                doc.fillColor(GOLD).font('Helvetica-Bold').fontSize(7)
                   .text('PAYMENT TERMS', 38, currentY + 4, { characterSpacing: 1.2 });
                currentY += 15;

                doc.rect(28, currentY, 556, 28).fillColor(LIGHT_GREY).fill();
                doc.fillColor(GREY).font('Helvetica').fontSize(8)
                   .text('Please use your Invoice Number as reference when making payment.', 38, currentY + 5)
                   .text('Payments can be made securely via the portal link sent to your email.', 38, currentY + 16);
                currentY += 36;
            }

            if (currentY > 710) { doc.addPage(); currentY = 50; }

            const terms = booking.terms || 'Standard cancellation policy applies.';
            doc.rect(28, currentY, 556, 15).fillColor(DARK).fill();
            doc.fillColor(GOLD).font('Helvetica-Bold').fontSize(7)
               .text('TERMS & CONDITIONS', 38, currentY + 4, { characterSpacing: 1.2 });
            currentY += 15;

            const termsH = doc.font('Helvetica').fontSize(8.5)
                              .heightOfString(terms, { width: 536 });
            doc.rect(28, currentY, 556, termsH + 14).fillColor(LIGHT_GREY).fill();
            doc.font('Helvetica').fontSize(8.5).fillColor(GREY)
               .text(terms, 38, currentY + 7, { width: 536 });
            currentY += termsH + 20;

            if (type === 'Invoice' && isTaxInvoice) {
                if (currentY > 700) { doc.addPage(); currentY = 50; }
                doc.font('Helvetica').fontSize(7.5).fillColor('#999999')
                   .text(
                       'This is a valid Tax Invoice for VAT purposes in terms of section 20 of the Value-Added Tax Act 89 of 1991.',
                       38, currentY, { width: 536 }
                   );
            }

            // 6. Footer
            this._drawFooter(doc);

            doc.end();
            stream.on('finish', () => resolve({ path: outputPath, number: docNumber, total: subtotal }));
            stream.on('error', reject);
        });
    }
}

module.exports = new PDFService();
