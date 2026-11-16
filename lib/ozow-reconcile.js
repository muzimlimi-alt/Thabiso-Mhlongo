// Ozow safety net: recovers a payment Ozow received but whose webhook notification never arrived.
//
// Calls Ozow's GetTransactionByReference API to check whether a pending payment attempt actually
// succeeded. If Ozow confirms it, the payment is recorded through the same atomic ledger path as
// the webhook handler (routes/public/payment.js).
//
// When it runs:
// - When a buyer returns from Ozow to their booking page (their booking only, throttled)
// - Triggered by POST /api/public/bookings/:id/ozow-check
'use strict';
const { dbRun, dbAll, dbGet } = require('./db-helpers');
const { withDbTransaction } = require('./db-transaction');
const { getTransactionStatus, ozowCreds, isOzowComplete } = require('./ozow');
const { logPaymentEvent } = require('./payment-processing');
const { getBookingByIdAsync, applyPayfastPaymentToBooking, setBookingEventId } = require('../database/repositories/bookings.repository');
const { markInvoicePaidIfOpenAsync } = require('../database/repositories/invoices-quotations.repository');
const {
    getOzowTransactionByReference, insertOzowTransaction, markPaymentIntentFulfilled
} = require('../database/repositories/finance.repository');
const {
    sendPaymentReceivedEmail, sendAdminPaymentNotification, sendDepositBalanceDueEmail,
    sendBookingConfirmedEmail, sendPaidReceiptEmail
} = require('./booking-notifications');
const { syncBookingToCalendar } = require('./calendar-sync');
const notify = require('./notify');

const BOOKING_THROTTLE_MS = 30 * 1000;
const lastCheckForBooking = new Map();

async function getPendingOzowIntents(bookingId) {
    return dbAll(
        `SELECT * FROM payfast_payment_intents
         WHERE booking_id = ? AND status = 'pending'
         ORDER BY created_at DESC`,
        [bookingId]
    );
}

async function reconcileBooking(bookingId, opts = {}) {
    const creds = ozowCreds();
    if (!creds.siteCode || !creds.apiKey) {
        return { ok: false, reason: 'ozow_not_configured' };
    }

    const now = Date.now();
    const lastCheck = lastCheckForBooking.get(bookingId) || 0;
    if (!opts.force && now - lastCheck < BOOKING_THROTTLE_MS) {
        return { ok: true, skipped: 'throttled' };
    }
    lastCheckForBooking.set(bookingId, now);

    const booking = await getBookingByIdAsync(bookingId);
    if (!booking) return { ok: false, reason: 'booking_not_found' };
    if (booking.payment_status === 'PAID') return { ok: true, skipped: 'already_paid' };

    const intents = await getPendingOzowIntents(bookingId);
    if (!intents.length) return { ok: true, checked: 0, reason: 'no_pending_intents' };

    let recovered = [];

    for (const intent of intents) {
        const txRef = intent.m_payment_id;

        const alreadyProcessed = await getOzowTransactionByReference(txRef, bookingId);
        if (alreadyProcessed) continue;

        let apiResult;
        try {
            apiResult = await getTransactionStatus(txRef);
        } catch (e) {
            console.error(`[Ozow Reconcile] API lookup failed for ref=${txRef}:`, e.message);
            continue;
        }

        const transactions = Array.isArray(apiResult) ? apiResult : (apiResult ? [apiResult] : []);
        const completed = transactions.find(t => isOzowComplete(t.status || t.Status));
        if (!completed) continue;

        const ozowAmount = parseFloat(completed.amount || completed.Amount) || 0;
        const ozowTxId = completed.transactionId || completed.TransactionId || txRef;
        const expectedAmount = parseFloat(intent.expected_amount) || 0;

        if (expectedAmount > 0 && Math.abs(ozowAmount - expectedAmount) > 0.01) {
            console.error(`[Ozow Reconcile] AMOUNT MISMATCH booking #${bookingId}: Ozow=R${ozowAmount.toFixed(2)}, expected=R${expectedAmount.toFixed(2)} (ref=${txRef})`);
            logPaymentEvent(bookingId, 'OZOW_RECONCILE_AMOUNT_MISMATCH', { txRef, ozowAmount, expectedAmount }, true);
            if (!creds.isTest) continue;
            console.warn(`[Ozow Reconcile] Test mode: proceeding despite amount mismatch.`);
        }

        const freshBooking = await getBookingByIdAsync(bookingId);
        if (!freshBooking || freshBooking.payment_status === 'PAID') break;

        const currentTotal = parseFloat(freshBooking.total_amount) || parseFloat((freshBooking.quote_amount || '0').replace(/[^0-9.]/g, '')) || 0;
        if (currentTotal === 0) {
            console.error(`[Ozow Reconcile] booking #${bookingId} has no resolvable total_amount.`);
            continue;
        }

        const parts = txRef.split('_');
        const rawType = parts[1] || 'FULL';
        const paymentType = rawType.startsWith('SCHED') ? 'SCHED' : rawType;

        const outcome = await withDbTransaction(async () => {
            try { await dbRun("BEGIN IMMEDIATE"); } catch (e) { return { retry: true }; }
            try {
                await insertOzowTransaction(bookingId, ozowAmount, 'ozow', ozowTxId, 'Complete', '');

                const credit = await applyPayfastPaymentToBooking(
                    ozowAmount, currentTotal, paymentType,
                    ozowTxId, '', JSON.stringify(completed), 'ozow',
                    bookingId
                );
                if (credit.changes === 0) {
                    await dbRun("ROLLBACK").catch(() => {});
                    return { overpayment: true };
                }

                const updated = await getBookingByIdAsync(bookingId);
                if (updated && updated.payment_status === 'PAID') {
                    await markInvoicePaidIfOpenAsync(bookingId);
                }

                await dbRun("COMMIT");
                return { ok: true, fresh: updated };
            } catch (txErr) {
                await dbRun("ROLLBACK").catch(() => {});
                if (/UNIQUE constraint/i.test(txErr.message || '')) return { duplicate: true };
                return { error: txErr };
            }
        });

        if (outcome.duplicate || outcome.retry) continue;
        if (outcome.error) {
            console.error(`[Ozow Reconcile] Credit failed booking #${bookingId}:`, outcome.error.message);
            continue;
        }
        if (outcome.overpayment) {
            console.warn(`[Ozow Reconcile] Overpayment rejected booking #${bookingId}`);
            continue;
        }

        markPaymentIntentFulfilled(txRef).catch(e =>
            console.error(`[Ozow Reconcile] markPaymentIntentFulfilled failed:`, e.message));
        logPaymentEvent(bookingId, 'OZOW_RECONCILE_OK', { txRef, ozowTxId, ozowAmount }, true);

        const updatedRow = outcome.fresh;
        const newAmountPaid = parseFloat(updatedRow.amount_paid) || 0;
        const newOutstanding = parseFloat(updatedRow.amount_outstanding) || 0;
        const newPaymentStatus = updatedRow.payment_status;

        console.log(`[Ozow Reconcile] Booking #${bookingId} recovered: Paid=R${newAmountPaid.toFixed(2)}, Remaining=R${newOutstanding.toFixed(2)}, Status=${newPaymentStatus}`);
        notify.emit('finance.payment_received', { bookingId, amount: ozowAmount, method: 'ozow', paymentStatus: newPaymentStatus, source: 'ozow-reconcile' }, { actorType: 'gateway', actorLabel: 'Ozow (reconcile)' });

        await syncBookingToCalendar(updatedRow).catch(e => console.error('[Ozow Reconcile] Calendar sync failed:', e.message));
        await sendPaymentReceivedEmail(updatedRow, newAmountPaid, newOutstanding, newPaymentStatus).catch(e => console.error('[Ozow Reconcile] Email failed:', e.message));
        sendAdminPaymentNotification(updatedRow, newAmountPaid, newPaymentStatus).catch(e => console.error('[Ozow Reconcile] Admin notification failed:', e.message));
        if (newPaymentStatus === 'DEPOSIT_PAID' && newOutstanding > 0) {
            sendDepositBalanceDueEmail(updatedRow, newOutstanding).catch(() => {});
        }
        if (newPaymentStatus === 'PAID') {
            sendBookingConfirmedEmail(updatedRow).catch(() => {});
            sendPaidReceiptEmail(updatedRow).catch(() => {});
        }

        recovered.push({ txRef, ozowTxId, amount: ozowAmount, paymentStatus: newPaymentStatus });
        if (newPaymentStatus === 'PAID') break;
    }

    return { ok: true, checked: intents.length, recovered };
}

module.exports = { reconcileBooking, BOOKING_THROTTLE_MS };
