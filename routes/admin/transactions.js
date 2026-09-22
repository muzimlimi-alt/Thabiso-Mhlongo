const express = require('express');
const db = require('../../database');
const { requireAdmin } = require('../../middleware/auth');
const { requireRole } = require('../../middleware/rbac');
const { syncBookingToCalendar } = require('../../lib/calendar-sync');
const { generateInvoice } = require('../../lib/invoicing');
const {
    logPaymentEvent, alignMilestonePayments, deriveBookingStatusAfterPayment, updateBookingMilestones
} = require('../../lib/payment-processing');
const {
    sendPaymentReceivedEmail, sendAdminPaymentNotification, sendDepositBalanceDueEmail,
    sendBookingConfirmedEmail, sendPaidReceiptEmail
} = require('../../lib/booking-notifications');
const {
    getBookingById, applyManualTransactionPaymentToBooking, updateBookingLedgerAfterManualRefund,
    updateBookingLedgerAfterAdjustment
} = require('../../database/repositories/bookings.repository');
const { insertManualTransaction } = require('../../database/repositories/finance.repository');
const {
    markInvoicePaidIfOpen, getOpenInvoiceIdForAdjustmentRegen
} = require('../../database/repositories/invoices-quotations.repository');
const router = express.Router();

// Phase 5 (HOUSEKEEPING-NOTES.md): expense-tracking admin routes (and VALID_EXPENSE_CATEGORIES,
// receiptStorage/uploadReceipt above) moved to routes/admin/expenses.js.







// POST /api/admin/transactions/manual — log a manual payment, refund, or adjustment
router.post('/api/admin/transactions/manual', requireAdmin, requireRole(['administrator', 'manager']), (req, res) => {
    const { booking_id, amount, transaction_type, payment_method, reference, notes, transaction_date, direction } = req.body;
    if (!amount || isNaN(parseFloat(amount)) || parseFloat(amount) <= 0)
        return res.status(400).json({ success: false, message: 'A valid positive amount is required.' });
    const validTypes = ['payment', 'refund', 'adjustment'];
    if (!transaction_type || !validTypes.includes(transaction_type))
        return res.status(400).json({ success: false, message: 'Transaction type must be payment, refund, or adjustment.' });
    if (transaction_type === 'adjustment' && (!direction || !['credit', 'debit'].includes(direction)))
        return res.status(400).json({ success: false, message: 'Adjustment direction must be credit or debit.' });
    // Deferred fix #5 (HOUSEKEEPING-NOTES.md): transactions.booking_id is NOT NULL in the schema, so
    // a missing booking_id always threw a raw SQLite constraint error from insertManualTransaction
    // below rather than the clean validation error this route otherwise gives. Reject it here instead.
    if (!booking_id)
        return res.status(400).json({ success: false, message: 'A booking is required to log a manual transaction.' });

    const amt = parseFloat(amount).toFixed(2);
    const txDate = transaction_date || new Date().toISOString().split('T')[0];
    const finalNotes = transaction_type === 'adjustment'
        ? (notes ? `[Adjustment: ${direction}] ${notes.trim()}` : `[Adjustment: ${direction}]`)
        : (notes ? notes.trim() : null);

    // D-2: normalize to a value the transactions.payment_method CHECK permits
    // ('cash','check','bank_transfer','credit_card','payfast','other'). The UI sends 'eft'/'card',
    // which the CHECK rejects — the INSERT then 500'd and the manual payment went unrecorded.
    const PM_MAP = { eft: 'bank_transfer', bank_transfer: 'bank_transfer', card: 'credit_card',
        credit_card: 'credit_card', cash: 'cash', check: 'check', cheque: 'check', payfast: 'payfast' };
    const normalizedMethod = (transaction_type === 'adjustment' || !payment_method)
        ? null
        : (PM_MAP[String(payment_method).toLowerCase().trim()] || 'other');

    insertManualTransaction(
        booking_id || null, amt, transaction_type, normalizedMethod, reference || null, finalNotes, txDate,
        function(err) {
            if (err) return res.status(500).json({ success: false, message: err.message });
            const txId = this.lastID;
            
            // Log to financial_audit_log
            const adminUser = req.session.username || 'system';
            db.run(
                `INSERT INTO financial_audit_log (event_type, entity_type, entity_id, amount, changed_by, notes)
                 VALUES ('MANUAL_PAYMENT', 'transaction', ?, ?, ?, ?)`,
                [txId, parseFloat(amt), adminUser, `Type: ${transaction_type}, Method: ${payment_method || 'N/A'}, Ref: ${reference || 'N/A'}, Notes: ${finalNotes || ''}`],
                () => {}
            );

            // Update booking financials if linked
            if (booking_id) {
                if (transaction_type === 'payment') {
                    // Fetch booking row to compute new outstanding balance and run notifications/sync
                    getBookingById(booking_id, (bookErr, row) => {
                        if (bookErr || !row) {
                            console.error(`[Manual Transaction] Booking #${booking_id} not found:`, bookErr?.message);
                            return res.json({ success: true, transaction_id: txId, message: 'Transaction logged but booking not found.' });
                        }

                        const total = parseFloat(row.total_amount) ||
                                      parseFloat((row.quote_amount || '0').replace(/[^0-9.]/g, '')) || 0;
                        const existingPaid = parseFloat(row.amount_paid) || 0;
                        const paid = existingPaid + parseFloat(amt);
                        const outstanding = Math.max(0, total - paid);

                        // Determine correct payment status
                        const isFullyPaid = total > 0 ? paid >= total : false;
                        let payment_status = 'PARTIALLY_PAID';
                        if (isFullyPaid) {
                            payment_status = 'PAID';
                        } else {
                            const depositThreshold = total * 0.5;
                            if (paid >= depositThreshold) {
                                payment_status = 'DEPOSIT_PAID';
                            }
                        }

                        // A deposit confirms, same as every other payment path.
                        const newStatus = deriveBookingStatusAfterPayment(row.status, payment_status);

                        applyManualTransactionPaymentToBooking(
                            payment_status, paid, outstanding, total, newStatus, booking_id,
                            (upErr) => {
                                if (upErr) {
                                    console.error('[Manual Transaction] Booking update failed:', upErr.message);
                                    return res.json({ success: true, transaction_id: txId, message: 'Transaction logged but booking update failed.' });
                                }

                                // Record payment event
                                logPaymentEvent(booking_id, 'MANUAL_PAYMENT_RECORDED', {
                                    amount_gross: parseFloat(amt),
                                    payment_method: payment_method || 'manual',
                                    pf_payment_id: null,
                                    m_payment_id: `MANUAL-${booking_id}-${Date.now()}`
                                }, true);

                                db.run(`INSERT INTO audit_log (table_name, record_id, action, new_values, changed_by, change_timestamp)
                                        VALUES ('bookings', ?, 'PAYMENT', ?, ?, CURRENT_TIMESTAMP)`,
                                    [booking_id, JSON.stringify({ amount_paid: paid, payment_status, amount_outstanding: outstanding }), adminUser],
                                    (aErr) => { if (aErr) console.error('[Audit] Manual payment transaction log failed:', aErr.message); });

                                (async () => {
                                    await syncBookingToCalendar(booking_id);
                                    sendPaymentReceivedEmail(row, parseFloat(amt), outstanding, payment_status).catch(e => console.error('Manual transaction payment email failed:', e));
                                    sendAdminPaymentNotification(row, parseFloat(amt), payment_status).catch(e => console.error('Admin payment notification failed:', e.message));

                                    alignMilestonePayments(booking_id, paid, (psErr) => {
                                        if (psErr) console.error('[Manual Transaction] payment_schedules update failed:', psErr.message);
                                    });

                                    if (payment_status === 'DEPOSIT_PAID' && outstanding > 0) {
                                        sendDepositBalanceDueEmail(row, outstanding).catch(e => console.error('Deposit balance-due email failed:', e.message));
                                    }

                                    if (payment_status === 'PAID') {
                                        markInvoicePaidIfOpen(booking_id);
                                        getBookingById(booking_id, (e, updated) => {
                                            if (!e && updated) {
                                                sendBookingConfirmedEmail(updated).catch(e => console.error('Confirmed email failed:', e.message));
                                                setTimeout(() => sendPaidReceiptEmail(updated).catch(e => console.error('Paid receipt email failed:', e.message)), 600);
                                            }
                                        });
                                    }
                                })();

                                res.json({ success: true, transaction_id: txId, message: 'Transaction logged and booking updated.' });
                            }
                        );
                    });
                } else if (transaction_type === 'refund') {
                    getBookingById(booking_id, (bookErr, row) => {
                        if (bookErr || !row) {
                            return res.json({ success: true, transaction_id: txId, message: 'Transaction logged but booking not found.' });
                        }
                        // FIN-4: recompute outstanding as (total - new paid), NOT additively — the old
                        // `amount_outstanding + amt` could push outstanding above total_amount (e.g. a
                        // refund larger than amount_paid) and never re-derived payment_status, leaving a
                        // refunded booking still marked PAID.
                        const total = parseFloat(row.total_amount) || parseFloat((row.quote_amount || '0').replace(/[^0-9.]/g, '')) || 0;
                        const newPaid = Math.max(0, (parseFloat(row.amount_paid) || 0) - parseFloat(amt));
                        const outstanding = Math.max(0, total - newPaid);
                        let payment_status;
                        if (total > 0 && newPaid >= total)      payment_status = 'PAID';
                        else if (newPaid <= 0)                   payment_status = 'UNPAID';
                        else if (newPaid >= total * 0.5)         payment_status = 'DEPOSIT_PAID';
                        else                                     payment_status = 'PARTIALLY_PAID';
                        updateBookingLedgerAfterManualRefund(
                            newPaid, outstanding, payment_status, booking_id, (upErr) => {
                                if (upErr) {
                                    console.error('[Manual Transaction] Refund booking update failed:', upErr.message);
                                    return res.json({ success: true, transaction_id: txId, message: 'Transaction logged but booking update failed.' });
                                }
                                updateBookingMilestones(booking_id, (psErr) => {
                                    if (psErr) console.error('[Manual Transaction] Milestone update failed:', psErr.message);
                                });
                                db.run(`INSERT INTO audit_log (table_name, record_id, action, new_values, changed_by, change_timestamp)
                                        VALUES ('bookings', ?, 'REFUND', ?, ?, CURRENT_TIMESTAMP)`,
                                    [booking_id, JSON.stringify({ amount_paid: newPaid, amount_outstanding: outstanding, payment_status }), adminUser],
                                    (aErr) => { if (aErr) console.error('[Audit] Manual refund log failed:', aErr.message); });
                                res.json({ success: true, transaction_id: txId, message: 'Refund recorded and booking updated.' });
                            });
                    });
                } else if (transaction_type === 'adjustment') {
                    getBookingById(booking_id, (bookErr, row) => {
                        if (bookErr || !row) {
                            console.error(`[Manual Transaction] Booking #${booking_id} not found:`, bookErr?.message);
                            return res.json({ success: true, transaction_id: txId, message: 'Transaction logged but booking not found.' });
                        }
                        const total = parseFloat(row.total_amount) || 0;
                        const newTotal = direction === 'credit' ? Math.max(0, total - parseFloat(amt)) : total + parseFloat(amt);
                        const paid = parseFloat(row.amount_paid) || 0;
                        const outstanding = Math.max(0, newTotal - paid);

                        // Determine correct payment status
                        const isFullyPaid = newTotal > 0 ? paid >= newTotal : false;
                        let payment_status = row.payment_status;
                        if (isFullyPaid) {
                            payment_status = 'PAID';
                        } else if (newTotal > 0) {
                            const depositThreshold = newTotal * 0.5;
                            if (paid >= depositThreshold) {
                                payment_status = 'DEPOSIT_PAID';
                            } else if (paid > 0) {
                                payment_status = 'PARTIALLY_PAID';
                            } else {
                                payment_status = 'UNPAID';
                            }
                        }

                        // A deposit confirms, same as every other payment path.
                        const newStatus = deriveBookingStatusAfterPayment(row.status, payment_status);

                        updateBookingLedgerAfterAdjustment(
                            payment_status, newTotal, outstanding, newStatus, booking_id,
                            (upErr) => {
                                if (upErr) {
                                    console.error('[Manual Transaction] Booking update failed:', upErr.message);
                                    return res.json({ success: true, transaction_id: txId, message: 'Transaction logged but booking update failed.' });
                                }

                                // Log audit trails
                                db.run(`INSERT INTO audit_log (table_name, record_id, action, new_values, changed_by, change_timestamp)
                                        VALUES ('bookings', ?, 'ADJUSTMENT', ?, ?, CURRENT_TIMESTAMP)`,
                                    [booking_id, JSON.stringify({ total_amount: newTotal, payment_status, amount_outstanding: outstanding }), adminUser],
                                    (aErr) => { if (aErr) console.error('[Audit] Manual adjustment log failed:', aErr.message); });

                                (async () => {
                                    await syncBookingToCalendar(booking_id);
                                    updateBookingMilestones(booking_id, (psErr) => {
                                        if (psErr) console.error('[Manual Transaction] Milestone update failed:', psErr.message);
                                    });

                                    // Void and regenerate invoice if one exists that is not paid/void
                                    getOpenInvoiceIdForAdjustmentRegen(booking_id, async (invErr, invRow) => {
                                        if (!invErr && invRow) {
                                            try {
                                                await generateInvoice(booking_id);
                                            } catch (e) {
                                                console.error('[Manual Transaction] Auto-regeneration of invoice failed:', e.message);
                                            }
                                        }
                                    });
                                })();

                                res.json({ success: true, transaction_id: txId, message: 'Transaction logged and booking total adjusted.' });
                            }
                        );
                    });
                } else {
                    res.json({ success: true, transaction_id: txId, message: 'Transaction logged.' });
                }
            } else {
                res.json({ success: true, transaction_id: txId, message: 'Transaction logged.' });
            }
        }
    );
});

module.exports = router;
