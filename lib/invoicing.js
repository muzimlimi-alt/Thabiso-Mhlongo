// Phase 5 (HOUSEKEEPING-NOTES.md): the invoice-generation financial core — moved out of the app.js
// monolith byte-identical. Every dependency was already either an existing Phase 4 repository
// export or an already-relocated lib/ module (findOrCreateClient, getVatRate/resolveLineTaxClasses/
// computeDocumentTotals, docsWriteDir, sendInvoiceEmail) — no new repository work needed. Both
// functions have remaining callers scattered across still-deferred app.js routes and the moved
// public accept-quote route; app.js re-imports both.
const fs = require('fs');
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
const { dbRun, dbGet } = require('./db-helpers');
// WHO issues the invoice: the identity (and VAT status) the approved quotation carried, else today's business profile (lib/business-profile.js).
const businessProfile = require('./business-profile');
const { taxInvoiceAdvice } = require('./business-profile-core');
// Phase 5: MUST stay the exact same singleton module.exports app.js and every other route file
// import — see lib/db-transaction.js's own header comment.
const { withDbTransaction } = require('./db-transaction');
const pdfService = require('../js/pdfService');
const { roundToCents } = require('../js/shared/payment-plan-rules');
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

// The Booking Policies "Deposit percentage" (policies.deposit_percentage) — the same value the
// quote builder and contract PDF quote to the client — so the milestones actually built match
// what the paperwork says. Falls back to 50 when unset or not a number; clamped to 0–100.
async function getDepositPercentage() {
    const row = await dbGet("SELECT policy_value FROM policies WHERE policy_key = 'deposit_percentage'").catch(() => null);
    const pct = parseFloat(row && row.policy_value);
    if (isNaN(pct)) return 50;
    return Math.min(100, Math.max(0, pct));
}

// installmentCount: 1-4 (anything else defaults to 2). Same rule for every count: the first payment
// is the deposit-percentage policy, the remainder is split evenly across the rest (rounding drift
// absorbed into the last one) — matches the client's own preset buttons exactly
// (PaymentPlanRules.buildPreset in js/shared/payment-plan-rules.js), so an admin-built plan for a
// given count never looks different from what the client would have been offered for that count.
// opts.source tags who authored this batch ('auto' default | 'client' | 'admin'), read by the admin
// drawer + the "Setup Milestones" overwrite guard.
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
    let count = parseInt(installmentCount, 10);
    if (!(count >= 1 && count <= 4)) count = 2; // anything else defaults to 2, preserves old behaviour
    const firstDue = moment().add(7, 'days');
    const lastDue = eventDate ? moment(eventDate).subtract(2, 'days') : moment().add(30, 'days');
    // Distinct labels once a payment exists, so the invoice PDF never shows two rows both called
    // "Deposit" for different amounts.
    const outstandingPrefix = paidSum > 0 ? 'Outstanding Balance – ' : '';

    const depositPct = await getDepositPercentage();
    // 0% or 100% deposit, or a single requested payment, leaves no room for a split: one milestone
    // for the whole remaining amount instead of a R0.00 row.
    if (count === 1 || depositPct >= 100 || depositPct <= 0) {
        const label = paidSum > 0 ? 'Outstanding Balance – Full Payment' : 'Full Payment';
        const due = depositPct >= 100 ? firstDue : lastDue;
        await insertPaymentScheduleMilestone(bookingId, label, due.format('YYYY-MM-DD'), remaining, 1, source);
        return;
    }

    const depositAmount = Math.round((remaining * depositPct / 100) * 100) / 100;
    const rest = Math.round((remaining - depositAmount) * 100) / 100;
    const amounts = [depositAmount];
    if (count === 2) {
        amounts.push(rest); // the whole remainder is the single balance payment
    } else {
        // Integer-cents floor + remainder-in-last, same as PaymentPlanRules' own splitEqually — so an
        // admin-built plan rounds identically to what the client's preset buttons would have offered.
        const restCents = Math.round(rest * 100);
        const shareCents = Math.floor(restCents / (count - 1));
        for (let i = 0; i < count - 2; i++) amounts.push(shareCents / 100);
        amounts.push((restCents - shareCents * (count - 2)) / 100); // absorbs rounding drift
    }

    // Dates: the deposit at firstDue, the balance at lastDue, any middle payments spaced evenly
    // between them — generalises the old 2/3-way logic's single midpoint. Each is clamped to land
    // strictly after the one before it, so a short-notice event (firstDue and lastDue close
    // together, or lastDue before firstDue) never produces an out-of-order or duplicate due date.
    const dates = [firstDue];
    for (let i = 1; i < count - 1; i++) {
        let d = firstDue.clone().add(Math.floor(lastDue.diff(firstDue, 'days') * i / (count - 1)), 'days');
        if (!d.isAfter(dates[dates.length - 1])) d = dates[dates.length - 1].clone().add(1, 'day');
        if (!d.isBefore(lastDue)) d = lastDue.clone().subtract(1, 'day');
        dates.push(d);
    }
    dates.push(dates[dates.length - 1].isBefore(lastDue) ? lastDue : dates[dates.length - 1].clone().add(1, 'day'));

    const balancePct = Math.round((100 - depositPct) * 100) / 100;
    for (let i = 0; i < count; i++) {
        let label;
        if (count === 2) {
            label = i === 0
                ? (paidSum > 0 ? `Outstanding Balance – Deposit (${depositPct}%)` : `${depositPct}% Deposit`)
                : (paidSum > 0 ? `Outstanding Balance – Final (${balancePct}%)`   : `${balancePct}% Balance`);
        } else {
            const pct = Math.round((amounts[i] / remaining) * 1000) / 10; // one decimal, e.g. 16.7
            label = `${outstandingPrefix}Installment ${i + 1} of ${count} (${pct}%)`;
        }
        await insertPaymentScheduleMilestone(bookingId, label, dates[i].format('YYYY-MM-DD'), amounts[i], i + 1, source);
    }
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
        db.get(`SELECT b.*, c.vat_number AS client_vat_number, c.billing_address AS client_billing_address
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

                    // The issuing identity: an invoice follows the quotation it was built from (so a later change to the business profile cannot
                    // re-label an agreed document); a quotation made before the profile existed carries none, so today's profile is used - exactly
                    // the identity-and-VAT behaviour that was in force before this feature.
                    const issuer = businessProfile.issuerFromSnapshot(activeQuote && activeQuote.issuer_snapshot) || await businessProfile.loadIssuer();
                    const dueDate = moment().add(7, 'days').format('YYYY-MM-DD');   // the same 7 days insertInvoice() has always allowed

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
                            eft: eftBlock,
                            issuer, dueDate, quoteNumber: activeQuote ? activeQuote.quote_number : null, clientAddress: booking.client_billing_address || ''
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
                            // freeze who issued it, and make the stored due date the one printed on the PDF
                            await dbRun('UPDATE invoices SET issuer_snapshot = ?, due_date = ? WHERE id = ?', [businessProfile.snapshotOf(issuer), dueDate, newInvoiceId]);

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

                    // Advisory only: what a VAT-registered business should still capture on a full tax invoice (never blocks the invoice).
                    const advice = taxInvoiceAdvice(issuer, { total, vatCharged: applyVat, clientName: booking.name, clientAddress: booking.client_billing_address, clientVat: booking.vat_number || booking.client_vat_number, clientCompany: booking.company });
                    resolve({ success: true, message: autoSend ? 'Invoice generated and emailed.' : 'Invoice generated as a draft.', invoice_id: invoiceId, status: autoSend ? 'SENT' : 'DRAFT', pdfUrl: `/api/admin/bookings/${bookingId}/invoice/download`, warnings: advice });
                } catch (ex) {
                    console.error("Invoice Gen Error:", ex);
                    reject(ex);
                }
            });
        });
    });
}

// ── Invoice PDF refresh after a payment-plan change ─────────────────────────────────────────────
// A client rearranging their unpaid milestones changes neither the total nor the line items, so the
// invoice itself must NOT be voided and renumbered (generateInvoice would issue INV-…-R2, reset the
// invoice due date and, with autoSend, email the client again). Only the PDF is stale: it prints the
// payment schedule. This re-renders the current live invoice's PDF in place — same invoice number,
// issue date (DOC DATE), status, totals and line items — under a new file name, and points
// invoices.file_path at it. The old PDF file is kept (anything already emailed or downloaded stays
// reproducible).
//
// Resolves { refreshed: true, invoice_id, invoice_number, file_path } or { refreshed: false, reason }
// and NEVER rejects: it runs as a post-commit side effect whose failure must not fail the request.
// reason is one of the REFRESH_* codes below, or an error message for an unexpected failure.
//
// Must not be called from inside withDbTransaction (it opens its own guarded section for the
// file_path update — a nested call would deadlock the queue).
const REFRESH_NO_LIVE_INVOICE = 'no-live-invoice';   // nothing issued yet / only VOID or PAID invoices
const REFRESH_BOOKING_NOT_FOUND = 'booking-not-found';
const REFRESH_TOTALS_CHANGED = 'totals-changed';     // recomputed figures no longer match the issued invoice
const REFRESH_INVOICE_CHANGED = 'invoice-changed';   // the invoice was voided/paid while the PDF rendered

// Per-booking chain: two plan changes in quick succession each trigger a refresh, and without
// ordering the slower (older) render could land last and leave the PDF showing the earlier plan.
// Chaining makes every refresh start after the previous one for that booking has finished, so the
// last one to run reads the newest schedule. Single process, so an in-memory map is sufficient.
const _refreshChains = new Map();

function refreshInvoicePdf(bookingId) {
    const key = String(bookingId);
    const previous = _refreshChains.get(key) || Promise.resolve();
    const run = previous
        .then(() => refreshInvoicePdfNow(bookingId))
        .catch(err => ({ refreshed: false, reason: (err && err.message) || 'refresh-failed' }));
    _refreshChains.set(key, run);
    run.then(() => { if (_refreshChains.get(key) === run) _refreshChains.delete(key); });
    return run;
}

// The DOC DATE an issued invoice's PDF carries, as 'DD MMM YYYY', or null when the row has no usable
// date (pdfService then prints today's). generateInvoice renders the PDF with moment() — the app's
// zone, Africa/Johannesburg — and inserts the row straight after, so created_at (a UTC
// CURRENT_TIMESTAMP) shown in that same zone reproduces the printed date. invoice_date is only the
// fallback: it is the UTC CURRENT_DATE, a day early for an invoice issued between 00:00 and 02:00 SAST.
function issuedDocDate(invoice) {
    const created = invoice && invoice.created_at ? moment.utc(String(invoice.created_at), moment.ISO_8601) : null;
    if (created && created.isValid()) return moment(created.valueOf()).format('DD MMM YYYY');
    const issued = invoice && invoice.invoice_date ? moment(String(invoice.invoice_date).slice(0, 10), 'YYYY-MM-DD', true) : null;
    return issued && issued.isValid() ? issued.format('DD MMM YYYY') : null;
}

async function refreshInvoicePdfNow(bookingId) {
    let pdfPath = null;
    let pointedAtNewFile = false;
    try {
        // Same booking read as generateInvoice, so the PDF's bill-to/VAT details render identically.
        const booking = await dbGet(`SELECT b.*, c.vat_number AS client_vat_number
                FROM bookings b LEFT JOIN clients c ON b.client_id = c.id WHERE b.id = ?`, [bookingId]);
        if (!booking) return { refreshed: false, reason: REFRESH_BOOKING_NOT_FOUND };

        // The live invoice: the newest one that is neither VOID nor PAID (generateInvoice voids every
        // other non-PAID invoice when it issues one, so there is normally exactly one). A PAID invoice
        // is a final document and is never re-rendered.
        const invoice = await dbGet(
            `SELECT id, invoice_number, status, total_amount, file_path, invoice_date, created_at FROM invoices
             WHERE booking_id = ? AND UPPER(COALESCE(status, '')) NOT IN ('VOID', 'PAID')
             ORDER BY created_at DESC, id DESC LIMIT 1`, [bookingId]);
        if (!invoice) return { refreshed: false, reason: REFRESH_NO_LIVE_INVOICE };

        // Same approved-basis pricing as generateInvoice (lib/approved-quote.js) — a refreshed PDF must
        // price the booking with exactly the same logic as the invoice it replaces, never today's
        // catalogue/VAT rate (see this function's own header comment).
        const activeQuote = await getActiveQuoteForInvoiceGen(bookingId);
        const qLines = activeQuote ? await getQuoteLineItems(activeQuote.id) : [];
        const basis = await approvedQuoteBasis(booking, qLines);
        const { applyVat, discount, vatRate } = basis;
        let items = basis.items;
        let total;
        if (items.length > 0) {
            total = computeDocumentTotals(items, { discount, applyVat, vatRate }).total;
        } else {
            const subtotal = basis.quoteData.subtotal || parseFloat((booking.quote_amount || '0').replace(/[^0-9.]/g, '')) || 0;
            const vatable = Math.max(0, subtotal - discount);
            total = vatable + (applyVat ? (basis.quoteData.vat || (vatable * vatRate)) : 0);
            items = [{ description: 'Performance Booking Service', quantity: 1, unit_price: subtotal, tax_class: 'standard' }];
        }
        // The refreshed PDF must show the issued invoice's figures. If the quote, VAT rate or a line's
        // tax class changed since it was issued, re-rendering would print a total the ledger doesn't
        // hold — leave the PDF alone and let the caller tell the admin to regenerate the invoice.
        if (roundToCents(total) !== roundToCents(invoice.total_amount)) {
            console.warn(`[Invoice Refresh] Booking #${bookingId}: recomputed total R${Number(total).toFixed(2)} differs from invoice ${invoice.invoice_number} (R${Number(invoice.total_amount).toFixed(2)}) — PDF not refreshed.`);
            return { refreshed: false, reason: REFRESH_TOTALS_CHANGED };
        }

        booking.apply_vat = applyVat;
        booking.discount = discount;
        booking.vat_rate = vatRate;

        // Same naming scheme as generateInvoice. A refresh in the same second as the previous render
        // would reuse the current file's name (and overwrite the very file the ledger points at), so
        // it takes a numeric suffix instead.
        const invoicesDir = docsWriteDir('invoices');
        const stamp = moment().format('YYYYMMDDHHmmss');
        let pdfFileName = `${invoice.invoice_number}-${stamp}.pdf`;
        for (let n = 2; pdfFileName === invoice.file_path || fs.existsSync(path.join(invoicesDir, pdfFileName)); n++) {
            if (n > 50) throw new Error('could not allocate a new invoice PDF file name');
            pdfFileName = `${invoice.invoice_number}-${stamp}-${n}.pdf`;
        }
        pdfPath = path.join(invoicesDir, pdfFileName);

        const paymentSchedules = await getPaymentSchedulesForDocument(bookingId);
        // Cite the contract when one exists now, exactly as generateInvoice would at this moment.
        const existingContract = await dbGet("SELECT contract_number FROM contracts WHERE booking_id = ?", [bookingId]).catch(() => null);
        // docDate: the re-rendered PDF is the same (tax) invoice, so it keeps the date it was issued
        // with. Left to pdfService it would print today's date, and every plan change would re-date it.
        await pdfService.generateDocument('Invoice', booking, items, pdfPath, paymentSchedules, invoice.invoice_number,
            { contractNumber: existingContract ? existingContract.contract_number : null, docDate: issuedDocDate(invoice) });
        await objectStorage.syncFileToStorage(pdfPath);

        // Guarded like every other write on the shared connection, so this UPDATE can't be swept
        // into (and rolled back with) another request's open transaction. The status guard skips an
        // invoice that was voided or paid while the PDF was rendering.
        const changes = await withDbTransaction(async () => {
            await dbRun("BEGIN IMMEDIATE");
            try {
                let result;
                try {
                    result = await dbRun(
                        `UPDATE invoices SET file_path = ?, updated_at = CURRENT_TIMESTAMP
                         WHERE id = ? AND UPPER(COALESCE(status, '')) NOT IN ('VOID', 'PAID')`,
                        [pdfFileName, invoice.id]);
                } catch (updErr) {
                    // invoices.updated_at is part of the table definition, but a very old database
                    // may predate it — the file path is what matters.
                    if (!/no such column/i.test(String(updErr && updErr.message))) throw updErr;
                    result = await dbRun(
                        `UPDATE invoices SET file_path = ?
                         WHERE id = ? AND UPPER(COALESCE(status, '')) NOT IN ('VOID', 'PAID')`,
                        [pdfFileName, invoice.id]);
                }
                await dbRun("COMMIT");
                return result.changes;
            } catch (txErr) {
                await dbRun("ROLLBACK").catch(() => {});
                throw txErr;
            }
        });
        if (!changes) {
            await objectStorage.deleteFile(pdfPath).catch(() => {});
            return { refreshed: false, reason: REFRESH_INVOICE_CHANGED };
        }
        pointedAtNewFile = true;
        return { refreshed: true, invoice_id: invoice.id, invoice_number: invoice.invoice_number, file_path: pdfFileName };
    } catch (err) {
        console.error(`[Invoice Refresh] Booking #${bookingId}: PDF refresh failed:`, err && err.message ? err.message : err);
        // A half-written or never-referenced new PDF is just litter; the invoice still points at its
        // previous (complete) file.
        if (pdfPath && !pointedAtNewFile) await objectStorage.deleteFile(pdfPath).catch(() => {});
        return { refreshed: false, reason: (err && err.message) || 'refresh-failed' };
    }
}

module.exports = {
    autoBuildDepositBalanceSchedule, generateInvoice, getDepositPercentage, refreshInvoicePdf,
    REFRESH_NO_LIVE_INVOICE, REFRESH_BOOKING_NOT_FOUND, REFRESH_TOTALS_CHANGED, REFRESH_INVOICE_CHANGED
};
