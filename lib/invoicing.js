// Phase 5 (HOUSEKEEPING-NOTES.md): the invoice-generation financial core — moved out of the app.js
// monolith byte-identical. Every dependency was already either an existing Phase 4 repository
// export or an already-relocated lib/ module (findOrCreateClient, getVatRate/resolveLineTaxClasses/
// computeDocumentTotals, docsWriteDir, sendInvoiceEmail) — no new repository work needed. Both
// functions have remaining callers scattered across still-deferred app.js routes and the moved
// public accept-quote route; app.js re-imports both.
const path = require('path');
const moment = require('moment-timezone');
const db = require('../database');
const { findOrCreateClient } = require('./client-venue');
const { computeDocumentTotals } = require('./document-totals');
// The lines, tax classes and VAT rate the quotation was APPROVED with (see the file's header): invoices are built from these.
const { approvedQuoteBasis } = require('./approved-quote');
const { docsWriteDir } = require('./runtime-paths');
const objectStorage = require('./object-storage');
const { sendInvoiceEmail } = require('./invoice-email');
const eftData = require('./eft');
const eftCore = require('./eft-core');
const { dbRun } = require('./db-helpers');
// Phase 5: MUST stay the exact same singleton module.exports app.js and every other route file
// import — see lib/db-transaction.js's own header comment.
const { withDbTransaction } = require('./db-transaction');
const pdfService = require('../js/pdfService');
const {
    getLivePaymentScheduleCount, getPaidPaymentScheduleSum, insertPaymentScheduleMilestone,
    getPaymentSchedulesForDocument, getStandingAdjustmentRows
} = require('../database/repositories/finance.repository');
// Manual adjustments logged since the approved quotation was issued ride on top of it (see the file's header).
const { applyAdjustments } = require('./booking-adjustments');
const {
    getInvoiceForPaidCheck, getActiveQuoteForInvoiceGen, getQuoteLineItems,
    getInvoiceNumberCollisionCount, voidSupersededInvoiceForRegen, insertInvoice,
    insertInvoiceLineItem, markInvoiceSent
} = require('../database/repositories/invoices-quotations.repository');
const { setBookingClientId, updateBookingLedgerAfterInvoice } = require('../database/repositories/bookings.repository');

// installmentCount: 2 (default, byte-identical to the original 50/50 behaviour) or 3 (client-
// selectable installment plans — 30/30/40 split, reusing the admin milestone editor's existing
// preset ratio). opts.source tags who authored this batch ('auto' default | 'client' | 'admin'),
// read by the admin drawer + the "Setup Milestones" overwrite guard.
async function autoBuildDepositBalanceSchedule(bookingId, totalAmount, eventDate, installmentCount = 2, opts = {}) {
    if (!(totalAmount > 0)) return;
    const liveRow = await getLivePaymentScheduleCount(bookingId);
    if ((liveRow ? liveRow.cnt : 0) > 0) return; // admin-configured milestones exist — don't touch
    const paidRow = await getPaidPaymentScheduleSum(bookingId);
    const paidSum = paidRow ? (parseFloat(paidRow.paidSum) || 0) : 0;
    const remaining = Math.round((totalAmount - paidSum) * 100) / 100;
    if (remaining <= 0.009) {
        console.warn(`[Auto-Schedule] Booking #${bookingId}: paid milestones (R${paidSum.toFixed(2)}) already cover the total (R${totalAmount.toFixed(2)}) — no new milestones created.`);
        return;
    }
    const source = opts.source || 'auto';
    const count = installmentCount === 3 ? 3 : 2; // anything else defaults to 2, preserves old behaviour
    const firstDue = moment().add(7, 'days');
    const lastDue = eventDate ? moment(eventDate).subtract(2, 'days') : moment().add(30, 'days');
    // Distinct labels once a payment exists, so the invoice PDF never shows two rows both called
    // "50% Deposit" for different amounts.
    const outstandingPrefix = paidSum > 0 ? 'Outstanding Balance – ' : '';

    if (count === 3) {
        const p1 = Math.round((remaining * 0.30) * 100) / 100;
        const p2 = Math.round((remaining * 0.30) * 100) / 100;
        const p3 = Math.round((remaining - p1 - p2) * 100) / 100; // absorbs rounding drift
        // Installment 2 sits at the midpoint between 1 and 3, clamped so short-notice events
        // (where firstDue and lastDue are close together, or lastDue precedes firstDue) never
        // produce an out-of-order or duplicate due date.
        let midDue = firstDue.clone().add(Math.floor(lastDue.diff(firstDue, 'days') / 2), 'days');
        if (!midDue.isAfter(firstDue)) midDue = firstDue.clone().add(1, 'day');
        if (!midDue.isBefore(lastDue)) midDue = lastDue.clone().subtract(1, 'day');
        await insertPaymentScheduleMilestone(bookingId, `${outstandingPrefix}Installment 1 of 3 (30%)`, firstDue.format('YYYY-MM-DD'), p1, 1, source);
        await insertPaymentScheduleMilestone(bookingId, `${outstandingPrefix}Installment 2 of 3 (30%)`, midDue.format('YYYY-MM-DD'), p2, 2, source);
        await insertPaymentScheduleMilestone(bookingId, `${outstandingPrefix}Installment 3 of 3 (40%)`, lastDue.format('YYYY-MM-DD'), p3, 3, source);
        return;
    }

    const depositAmount = Math.round((remaining * 0.5) * 100) / 100;
    const balanceAmount = Math.round((remaining - depositAmount) * 100) / 100;
    const depositLabel = paidSum > 0 ? 'Outstanding Balance – Deposit (50%)' : '50% Deposit';
    const balanceLabel = paidSum > 0 ? 'Outstanding Balance – Final (50%)'   : '50% Balance';
    await insertPaymentScheduleMilestone(bookingId, depositLabel, firstDue.format('YYYY-MM-DD'), depositAmount, 1, source);
    await insertPaymentScheduleMilestone(bookingId, balanceLabel, lastDue.format('YYYY-MM-DD'), balanceAmount, 2, source);
}

/**
 * Generates an invoice for a booking and saves it to the DB.
 * Draft-then-send model: by default the invoice is created as a reviewable DRAFT and NO email is
 * sent — the admin reviews it, then explicitly Sends (POST /invoices/:id/send flips DRAFT→SENT and
 * emails). Pass { autoSend: true } to create it as SENT and email immediately in one step — used by
 * the public accept-quote flow, where the client is actively expecting the invoice.
 * @param {number|string} bookingId
 * @param {{autoSend?: boolean}} [opts]
 * @returns {Promise<Object>}
 */
async function generateInvoice(bookingId, opts = {}) {
    const autoSend = !!opts.autoSend;
    return new Promise((resolve, reject) => {
        db.get(`SELECT b.*, c.vat_number AS client_vat_number
                FROM bookings b LEFT JOIN clients c ON b.client_id = c.id WHERE b.id = ?`, [bookingId], async (err, booking) => {
            if (err || !booking) return reject(new Error('Booking not found'));

            // Ensure client_id is resolved and updated in booking record if missing
            let clientId = booking.client_id;
            if (!clientId) {
                try {
                    clientId = await findOrCreateClient(booking.name, booking.email, booking.cell, booking.company, booking.vat_number);
                    await new Promise((resVal, rejVal) => {
                        setBookingClientId(clientId, bookingId, upErr => upErr ? rejVal(upErr) : resVal());
                    });
                    booking.client_id = clientId;
                } catch(e) {
                    console.error("[generateInvoice] Failed to resolve client:", e);
                    return reject(e);
                }
            }

            // Superseding the previous invoice now happens inside the write transaction below —
            // running it here voided the booking's existing invoice before the replacement was even
            // built, so any later failure (PDF, insert) left the booking with no live invoice at all.
            getInvoiceForPaidCheck(bookingId, async (e, inv) => {
                if (inv) return resolve({ success: true, message: 'Invoice already paid — no regeneration needed.', invoice_id: inv.id, pdfUrl: `/api/admin/bookings/${bookingId}/invoice/download` });

                try {
                    // P3-10: Prefer quote_line_items from active quotations row over legacy quote_details JSON
                    const activeQuote = await getActiveQuoteForInvoiceGen(bookingId);
                    const qLines = activeQuote ? await getQuoteLineItems(activeQuote.id) : [];

                    // The APPROVED basis of the quotation (lib/approved-quote.js): its lines, each line's tax class as issued, the discount,
                    // the VAT switch and the VAT rate it was issued at - never today's catalogue or today's VAT rate, so no edit to a
                    // service (tax class, price, name, active flag) or to the national rate can change what the client approved.
                    // apply_vat + discount live in booking.quote_details JSON - the quotations table has no such columns (FIN-3).
                    // FIN-2: every line carries a tax_class so VAT is charged only on taxable lines and the PDF matches.
                    const basis = await approvedQuoteBasis(booking, qLines);
                    const { applyVat, discount, vatRate, quoteData } = basis;
                    let items = basis.items;

                    let subtotal, tax, total;
                    if (items.length > 0) {
                        const t = computeDocumentTotals(items, { discount, applyVat, vatRate });
                        subtotal = t.subtotal; tax = t.vat; total = t.total;
                        // Diagnostic only: an invoice IS the approved quotation, so these always agree for a record made by this code.
                        const approvedTotal = parseFloat(quoteData.finalTotal);
                        if (Number.isFinite(approvedTotal) && Math.abs(total - approvedTotal) > 0.01) {
                            console.warn(`[Invoice] Booking #${bookingId}: invoice total R${total.toFixed(2)} differs from the approved quotation total R${approvedTotal.toFixed(2)}.`);
                        }
                    } else {
                        console.warn(`[Invoice Warning] Booking #${bookingId}: no line items from quotations or quote_details — using fallback.`);
                        subtotal = quoteData.subtotal || parseFloat((booking.quote_amount || '0').replace(/[^0-9.]/g, '')) || 0;
                        const vatable = Math.max(0, subtotal - discount);
                        tax = applyVat ? (quoteData.vat || (vatable * vatRate)) : 0;
                        total = vatable + tax;
                        items = [{ description: 'Performance Booking Service', quantity: 1, unit_price: subtotal, tax_class: 'standard' }];
                    }

                    // Manual adjustments (credit / debit) the admin logged SINCE this quotation was issued (a new quotation starts fresh)
                    // are part of what the client owes, so the invoice carries them as their own lines and rows below the approved
                    // amounts, applied exactly as the ledger applied them. They used to be lost here: the invoice was rebuilt from the
                    // quotation alone and its total written straight back over the adjusted booking total. VAT is deliberately NOT
                    // recalculated - the quoted VAT stays as approved (lib/booking-adjustments.js).
                    const adj = applyAdjustments(total, await getStandingAdjustmentRows(bookingId, activeQuote ? activeQuote.created_at : null));
                    if (adj.lines.length) {
                        subtotal = Math.round((subtotal + adj.net) * 100) / 100;   // the stored subtotal is the sum of the invoice's lines
                        total = adj.total;
                    }

                    // Allocate the invoice number. `invoices.invoice_number` is UNIQUE and a voided
                    // invoice keeps its number forever (statutory: a number is never reused), so a
                    // regenerated invoice takes the next revision instead of colliding. Before this,
                    // re-quoting an ACCEPTED booking voided its invoice and the replacement could
                    // never be inserted — the booking was left with no live invoice for the rest of
                    // the year.
                    //   first issue:  INV-2026-0044
                    //   regenerated:  INV-2026-0044-R2, -R3, …
                    const baseNumber = `INV-${moment().format('YYYY')}-${bookingId.toString().padStart(4, '0')}`;
                    const priorIssued = await getInvoiceNumberCollisionCount(bookingId, baseNumber, `${baseNumber}-R%`);
                    const invNumber = priorIssued === 0 ? baseNumber : `${baseNumber}-R${priorIssued + 1}`;

                    // Enrich booking with VAT flag and discount from quote
                    booking.apply_vat = applyVat;
                    booking.discount = discount;
                    booking.vat_rate = vatRate; // FIN-1/2: PDF uses the same rate as the server calc

                    // Generate PDF
                    const pdfFileName = `${invNumber}-${moment().format('YYYYMMDDHHmmss')}.pdf`;
                    const invoicesDir = docsWriteDir('invoices');
                    const pdfPath = path.join(invoicesDir, pdfFileName);

                    const paymentSchedules = await getPaymentSchedulesForDocument(bookingId);
                    // Cite the related contract if one already exists at invoice-generation time (it
                    // often doesn't — accept-parity generates the invoice before the contract — so this
                    // is opportunistic, same as the contract PDF's optional "Per accepted quote" line).
                    const existingContract = await new Promise(resolve => {
                        db.get("SELECT contract_number FROM contracts WHERE booking_id = ?", [bookingId], (e, r) => resolve(e ? null : r));
                    });
                    // invNumber is passed through so the number on the client's PDF is the number in
                    // the ledger. generateDocument() otherwise derives `INV-<bookingId>-<YYMM>`, which
                    // has never matched invoices.invoice_number.
                    // Manual EFT: when it is switched on and banking details exist, THIS invoice carries them - the version in force right
                    // now, remembered below in invoices.bank_details_id so a later change to the details never rewrites it.
                    const eftState = await eftData.getEftState();
                    const eftBlock = eftState.available ? eftCore.printableBankDetails(eftState.details, eftCore.paymentReference(bookingId, invNumber)) : null;
                    const pdfResult = await pdfService.generateDocument('Invoice', booking, items, pdfPath, paymentSchedules, invNumber,
                        {
                            contractNumber: existingContract ? existingContract.contract_number : null,
                            adjustments: adj.lines.map(a => ({ label: a.label, note: a.note, amount: a.signed })),
                            eft: eftBlock
                        });
                    await objectStorage.syncFileToStorage(pdfPath);

                    // Create the invoice record. Voiding the superseded invoice, inserting the new
                    // invoice and its line items, and updating the booking are one atomic unit,
                    // queued behind every other guarded transaction on the shared connection.
                    const invoiceId = await withDbTransaction(async () => {
                        await dbRun("BEGIN IMMEDIATE");
                        try {
                            await voidSupersededInvoiceForRegen(bookingId);

                            // Draft-then-send: created as DRAFT for admin review unless autoSend
                            // (client accept-quote) asks to publish + email immediately as SENT.
                            const ins = await insertInvoice(bookingId, booking.client_id, invNumber, subtotal, tax, total, autoSend ? 'SENT' : 'DRAFT', pdfFileName);
                            const newInvoiceId = ins.lastID;
                            if (eftBlock) await dbRun('UPDATE invoices SET bank_details_id = ? WHERE id = ?', [eftState.details.id, newInvoiceId]);

                            // Sequential and error-checked. These previously ran as a parallel forEach
                            // whose error argument was ignored, so a failed line item still committed an
                            // invoice whose total no line item supported.
                            for (const item of items) {
                                await insertInvoiceLineItem(newInvoiceId, item.description, item.quantity, item.unit_price);
                            }
                            // each adjustment as its own signed line (a credit is negative), so the lines still add up to the subtotal
                            for (const a of adj.lines) {
                                await insertInvoiceLineItem(newInvoiceId, a.description, 1, a.signed);
                            }

                            await updateBookingLedgerAfterInvoice(total, total - (booking.amount_paid || 0), bookingId);

                            await dbRun("COMMIT");
                            return newInvoiceId;
                        } catch (txErr) {
                            await dbRun("ROLLBACK").catch(() => {});
                            throw txErr;
                        }
                    });

                    // Side effects only after the commit. A draft is NOT emailed — the admin reviews
                    // it and sends explicitly. Only autoSend (client accept-quote) emails here.
                    if (autoSend) {
                        try {
                            await sendInvoiceEmail(booking, pdfPath);
                            markInvoiceSent(invoiceId, () => {});
                        } catch (emErr) { console.error("Invoice Email Error:", emErr); }
                    }

                    resolve({ success: true, message: autoSend ? 'Invoice generated and emailed.' : 'Invoice generated as a draft.', invoice_id: invoiceId, status: autoSend ? 'SENT' : 'DRAFT', pdfUrl: `/api/admin/bookings/${bookingId}/invoice/download` });
                } catch (ex) {
                    console.error("Invoice Gen Error:", ex);
                    reject(ex);
                }
            });
        });
    });
}

module.exports = { autoBuildDepositBalanceSchedule, generateInvoice };
