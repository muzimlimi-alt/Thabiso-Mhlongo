// Phase 5 (HOUSEKEEPING-NOTES.md): logPaymentEvent/alignMilestonePayments/updateBookingMilestones/
// deriveBookingStatusAfterPayment/processManualPayment relocated here verbatim from app.js as a
// prerequisite for moving the remaining /api/admin/bookings/* payment routes. Byte-identical bodies
// — only the imports below are new (they replace app.js's own top-of-file destructures).
const db = require('../database');
const { dbRun } = require('./db-helpers');
const { syncBookingToCalendar } = require('./calendar-sync');
const { generateInvoice } = require('./invoicing');
const {
    sendPaymentReceivedEmail, sendAdminPaymentNotification, sendDepositBalanceDueEmail,
    sendBookingConfirmedEmail, sendPaidReceiptEmail
} = require('./booking-notifications');
const {
    getBookingAmountPaid, applyManualPaymentToBooking, getBookingForAutoEventOnPayment,
    getBookingById, setBookingEventId
} = require('../database/repositories/bookings.repository');
const { insertAutoCreatedEvent } = require('../database/repositories/calendar.repository');
const {
    insertPaymentLogEntry, insertLoggedPaymentTransaction,
    getActiveScheduleRowsForAlignment, markScheduleRowsPaid, markScheduleRowsPending
} = require('../database/repositories/finance.repository');
const {
    markInvoicePaidIfOpen, getOpenInvoiceIdForReceiptCheck
} = require('../database/repositories/invoices-quotations.repository');

function logPaymentEvent(bookingId, eventType, pfData, sigValid = true, referenceOverride = null, opts = {}) {
    const amount = parseFloat(pfData.amount_gross) || 0;

    // 1. Log to generic payment_logs for ITN history
    insertPaymentLogEntry(
        bookingId, eventType, JSON.stringify(pfData), sigValid, amount,
        (err) => {
            if (err) {
                console.error(`[Audit Log] Failed to insert log for booking #${bookingId}:`, err.message);
                // payment_logs.booking_id is NOT NULL + FK-constrained to bookings(id), so an ITN
                // referencing a booking id that doesn't exist (garbled, spoofed, or replayed) can
                // never get a row there -- silently leaving zero audit trail for exactly the kind of
                // event most worth reviewing. Fall back to audit_log (no FK on record_id) so at least
                // one record survives. Deferred fix #2 (HOUSEKEEPING-NOTES.md).
                dbRun(
                    `INSERT INTO audit_log (table_name, record_id, action, new_values, reason) VALUES (?, ?, ?, ?, ?)`,
                    ['payment_logs', bookingId, eventType, JSON.stringify(pfData), `payment_logs insert failed: ${err.message}`]
                ).catch((fallbackErr) => console.error(`[Audit Log] Fallback insert also failed for booking #${bookingId}:`, fallbackErr.message));
            }
        }
    );

    // 2. If it's a successful verified payment, also log to the official transactions table
    if (!opts.auditOnly && (eventType === 'VERIFIED_OK' || eventType === 'MANUAL_PAYMENT_RECORDED')) {
        const pfMethodMap = {
            cc: 'credit_card', dc: 'credit_card',          // Visa/MC credit & debit
            ef: 'bank_transfer',                            // Instant EFT
            mp: 'payfast', bc: 'payfast', payfast: 'payfast', // Masterpass / Bitcoin (legacy)
            mc: 'payfast',   // MoreTyme credit
            sc: 'payfast',   // Scan to Pay
            cd: 'payfast',   // Capitec Pay
            mt: 'payfast',   // MobiCred
            cf: 'payfast',   // Payflex / PayJustNow
            zp: 'payfast',   // Zero Pay
            rp: 'payfast',   // RCS Pay
            cash: 'cash', check: 'check', bank_transfer: 'bank_transfer', manual: 'cash'
        };
        const rawMethod = (pfData.payment_method || '').toLowerCase();
        const mappedMethod = pfMethodMap[rawMethod] || 'payfast'; // default to gateway name, not 'other'
        const txSource = eventType === 'VERIFIED_OK' ? 'payfast' : 'manual';
        const txReference = referenceOverride || pfData.pf_payment_id || pfData.m_payment_id || 'manual';
        insertLoggedPaymentTransaction(
            bookingId, amount, mappedMethod, txReference, txSource,
            (err) => { if (err) console.error(`[Transactions] Insert failed for booking #${bookingId}:`, err.message); });
    }
}

// Helpers for payment schedules & milestones alignment
// Greedy waterfall: walk the booking's LIVE milestones in due order and mark each one the running
// payment total fully covers as 'paid'.
//
// Only live rows participate. This used to `SELECT *` — superseded and cancelled rows included — and
// rewrite every row's status, so any payment after an admin re-quote resurrected the superseded
// milestones and let them consume the paid budget. It also demoted 'overdue' rows to 'pending' on
// every call, silently undoing the overdue cron.
//
// Deliberately NOT wrapped in withDbTransaction: every caller runs this inside a post-commit
// side-effect block that issues further independent statements on the shared sqlite connection, and a
// BEGIN here would sweep those into this transaction. The two set-based UPDATEs below are each atomic
// on their own, and a partial failure is re-derived by the next align or cron run.
function alignMilestonePayments(bookingId, amountPaid, callback) {
    getActiveScheduleRowsForAlignment(
        bookingId,
        (err, schedules) => {
            if (err || !schedules || schedules.length === 0) {
                if (callback) callback(err);
                return;
            }

            let remainingPaid = parseFloat(amountPaid) || 0;
            const toPaid = [];    // covered, not yet marked paid
            const toPending = []; // previously paid, no longer covered (a refund) — the cron re-flags overdue

            for (const s of schedules) {
                const expected = parseFloat(s.expected_amount) || 0;
                const current = String(s.status || 'pending').toLowerCase();
                if (remainingPaid + 0.009 >= expected) {
                    remainingPaid -= expected;
                    if (current !== 'paid') toPaid.push(s.id);
                } else {
                    remainingPaid = 0; // the first milestone we cannot fully cover stops the waterfall
                    // Leave pending/due_soon/overdue alone — only a previously-paid row is demoted.
                    if (current === 'paid') toPending.push(s.id);
                }
            }

            if (toPaid.length === 0 && toPending.length === 0) {
                if (callback) callback(null);
                return;
            }

            // ids come from the SELECT above, never from user input.
            const runPaid = (next) => {
                if (toPaid.length === 0) return next(null);
                markScheduleRowsPaid(toPaid.map(() => '?').join(','), toPaid, next);
            };
            const runPending = (next) => {
                if (toPending.length === 0) return next(null);
                markScheduleRowsPending(toPending.map(() => '?').join(','), toPending, next);
            };
            runPaid((e1) => runPending((e2) => { if (callback) callback(e1 || e2); }));
        }
    );
}

function updateBookingMilestones(bookingId, callback) {
    getBookingAmountPaid(bookingId, (err, row) => {
        if (err || !row) {
            if (callback) callback(err);
            return;
        }
        const paid = parseFloat(row.amount_paid) || 0;
        alignMilestonePayments(bookingId, paid, callback);
    });
}

// The single rule for how a recorded payment moves bookings.status. Owner decision (2026-07-10):
// a deposit confirms. Any real payment on a booking the client has committed to (ACCEPTED or
// CONFIRMED) moves it to CONFIRMED; a full payment on a booking that never got a formal acceptance
// advances it to ACCEPTED so the acceptance step isn't skipped; anything else leaves status alone.
//
// The PayFast ITN encodes the same rule as a race-free SQL CASE and is deliberately NOT routed
// through this helper — reading the status into JS first would reintroduce a read-then-write window.
// Keep the two in sync by meaning, not by shared code.
function deriveBookingStatusAfterPayment(currentStatus, paymentStatus) {
    const cur = String(currentStatus || '').toUpperCase();
    const pay = String(paymentStatus || '').toUpperCase();
    const isRealPayment = ['DEPOSIT_PAID', 'PARTIALLY_PAID', 'PAID'].includes(pay);
    if (isRealPayment && ['ACCEPTED', 'CONFIRMED'].includes(cur)) return 'CONFIRMED';
    if (pay === 'PAID') return 'ACCEPTED';
    return currentStatus;
}

function processManualPayment(req, res, row) {
    const { amount_paid } = req.body;

        const total = parseFloat(row.total_amount) ||
                      parseFloat((row.quote_amount || '0').replace(/[^0-9.]/g, '')) || 0;
        const paid  = Math.max(0, parseFloat(amount_paid) || 0);
        if (total > 0 && paid > total) {
            return res.status(400).json({ success: false, message: `Overpayment detected. Total is R${total.toFixed(2)} but you entered R${paid.toFixed(2)}.`, overpayment: true, max_amount: total });
        }
        const existingPaid = parseFloat(row.amount_paid) || 0;
        const delta = paid - existingPaid;
        if (paid < existingPaid) {
            // P2-4: Reducing amount_paid without a refund record creates ledger drift.
            // Force the admin to use the dedicated refund endpoint instead.
            return res.status(400).json({
                success: false,
                message: `Cannot reduce the recorded payment from R${existingPaid.toFixed(2)} to R${paid.toFixed(2)} via this form. Use the Refund endpoint to record a refund and update the ledger — this creates a proper audit trail and transaction record.`
            });
        }
        const outstanding = Math.max(0, total - paid);
        // Derive payment_status from the amount rather than trusting the request body. The body field
        // is now advisory — an admin could otherwise record R1 as 'PAID'. Same thresholds as
        // /transactions/manual: >= total → PAID, >= half → DEPOSIT_PAID, > 0 → PARTIALLY_PAID.
        let payment_status;
        if (total > 0 && paid >= total)        payment_status = 'PAID';
        else if (total > 0 && paid >= total * 0.5) payment_status = 'DEPOSIT_PAID';
        else if (paid > 0)                     payment_status = 'PARTIALLY_PAID';
        else                                   payment_status = 'UNPAID';

        const newStatus = deriveBookingStatusAfterPayment(row.status, payment_status);

        applyManualPaymentToBooking(
            payment_status, paid, outstanding, total, newStatus, req.params.id,
            function(err) {
                if (err) return res.status(500).json({ success: false, error: err.message });

                // Record in transactions table + audit log
                if (delta > 0) {
                    logPaymentEvent(req.params.id, 'MANUAL_PAYMENT_RECORDED', {
                        amount_gross: delta,
                        payment_method: 'manual',
                        pf_payment_id: null,
                        m_payment_id: `MANUAL-${req.params.id}-${Date.now()}`
                    }, true);
                } else if (delta < 0) {
                    logPaymentEvent(req.params.id, 'MANUAL_PAYMENT_REDUCED', {
                        amount_gross: Math.abs(delta),
                        old_amount: existingPaid,
                        payment_method: 'manual',
                        m_payment_id: `MANUAL-REDUCE-${req.params.id}-${Date.now()}`
                    }, true);
                }
                db.run(`INSERT INTO audit_log (table_name, record_id, action, new_values, changed_by, change_timestamp)
                        VALUES ('bookings', ?, 'PAYMENT', ?, ?, CURRENT_TIMESTAMP)`,
                    [req.params.id, JSON.stringify({ amount_paid: paid, payment_status, amount_outstanding: outstanding }), req.session.adminId || 'admin'],
                    (aErr) => { if (aErr) console.error('[Audit] Manual payment log failed:', aErr.message); });

                // Auto-create events row when manual payment results in CONFIRMED (mirrors PayFast ITN behaviour)
                if (newStatus === 'CONFIRMED') {
                    getBookingForAutoEventOnPayment(req.params.id, (evSelErr, bRow) => {
                        if (evSelErr || !bRow || bRow.event_id) return;
                        const evDatetime = bRow.date + (bRow.event_start_time ? ' ' + bRow.event_start_time : ' 00:00:00');
                        insertAutoCreatedEvent(
                            bRow.event_name || bRow.event_type || 'Booking Event', evDatetime, bRow.event_location || null, bRow.venue_id || null, req.params.id,
                            function(evErr) {
                                if (evErr) { console.error('[Auto-Event] ManualPayment: Insert failed for booking #' + req.params.id + ':', evErr.message); return; }
                                setBookingEventId(this.lastID, req.params.id);
                            }
                        );
                    });
                }

                (async () => {
                    await syncBookingToCalendar(req.params.id);
                    sendPaymentReceivedEmail(row, paid, outstanding, payment_status).catch(e => console.error('Manual payment email failed:', e));
                    sendAdminPaymentNotification(row, paid, payment_status).catch(e => console.error('Admin payment notification failed:', e.message));
                    // Update payment schedule: mark due items as paid
                    alignMilestonePayments(req.params.id, paid, (psErr) => {
                        if (psErr) console.error('[Payment] payment_schedules update failed:', psErr.message);
                    });
                    if (payment_status === 'DEPOSIT_PAID' && outstanding > 0) {
                        sendDepositBalanceDueEmail(row, outstanding).catch(e => console.error('Deposit balance-due email failed:', e.message));
                    }
                    if (payment_status === 'PAID') {
                        const markPaidAndNotify = () => {
                            markInvoicePaidIfOpen(req.params.id);
                            getBookingById(req.params.id, (e, updated) => {
                                if (!e && updated) {
                                    sendBookingConfirmedEmail(updated).catch(e => console.error('Confirmed email after manual payment failed:', e.message));
                                    setTimeout(() => sendPaidReceiptEmail(updated).catch(e => console.error('Paid receipt email (manual) failed:', e.message)), 600);
                                }
                            });
                        };
                        // Ensure an invoice exists before sending the receipt — manual bookings that
                        // skipped quote acceptance have no invoice yet, so generate one on the spot.
                        getOpenInvoiceIdForReceiptCheck(
                            req.params.id,
                            (invCheckErr, existingInv) => {
                                if (!existingInv) {
                                    generateInvoice(req.params.id)
                                        .then(markPaidAndNotify)
                                        .catch(genErr => {
                                            console.error('[ManualPayment] Invoice auto-generation failed:', genErr.message);
                                            markPaidAndNotify();
                                        });
                                } else {
                                    markPaidAndNotify();
                                }
                            }
                        );
                    }
                })();

                res.json({ success: true, message: `Payment recorded for booking #${req.params.id}.` });
            }
        );
}

module.exports = {
    logPaymentEvent, alignMilestonePayments, updateBookingMilestones, deriveBookingStatusAfterPayment,
    processManualPayment
};
