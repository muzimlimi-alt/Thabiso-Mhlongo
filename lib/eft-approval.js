// Manual EFT - the review actions an administrator takes on a client's proof of payment. This is the ONLY code that turns a proof into money.
//
// Approving is one atomic unit, shaped exactly like the PayFast ITN's credit (routes/public/payment.js) so a manually-verified payment lands in
// the ledger the same way a card payment does and every existing report, reconciliation and cancellation-refund sees it:
//   flip the submission pending -> approved (the guard that makes a second approval impossible)
//   + ONE transactions row (source 'manual', method 'bank_transfer', the proof file attached, transaction_date = the day the bank received it)
//   + the booking credited with the shared credit statement (amount_paid, outstanding, payment_status from the schedule, status -> CONFIRMED)
//   + the invoice marked PAID when that settles the booking.
// A failure anywhere rolls back all of it. E-mails, calendar, payment milestones and the auto-created event run after the commit.
const { dbRun, dbGet } = require('./db-helpers');
const { withDbTransaction } = require('./db-transaction');
const { normalizeEncodedText } = require('./html-sanitize');
const { logAudit } = require('./audit-log');
const { syncBookingToCalendar } = require('./calendar-sync');
const { logPaymentEvent, alignMilestonePayments } = require('./payment-processing');
const {
    sendDepositBalanceDueEmail, sendBookingConfirmedEmail, sendPaidReceiptEmail, sendAdminPaymentNotification
} = require('./booking-notifications');
const eftNotify = require('./eft-notifications');
const core = require('./eft-core');
const eft = require('./eft');
const { getBookingByIdAsync, applyPayfastPaymentToBooking, setBookingEventId } = require('../database/repositories/bookings.repository');
const { markInvoicePaidIfOpenAsync } = require('../database/repositories/invoices-quotations.repository');
const { insertAutoCreatedEvent } = require('../database/repositories/calendar.repository');

const fail = (status, message, extra) => ({ ok: false, status, message, ...(extra || {}) });

// A payment is never recorded against a booking that no longer exists as a commitment.
const NO_PAYMENT_STATUSES = ['CANCELLED', 'EXPIRED'];

async function approveSubmission(id, input, req) {
    const adminId = (req && req.session && req.session.adminId) || null;
    const sub = await eft.getSubmission(id);
    if (!sub) return fail(404, 'Proof of payment not found.');
    if (sub.status !== 'pending') return fail(409, `This proof of payment has already been reviewed (${sub.status.replace('_', ' ')}). Nothing was changed.`);

    const v = core.validateVerification(input, eft.today());
    if (Object.keys(v.errors).length) return fail(400, Object.values(v.errors)[0], { errors: v.errors });
    const reference = normalizeEncodedText(v.clean.reference);
    const note = v.clean.note ? normalizeEncodedText(v.clean.note) : null;

    // The same bank line must not become two payments: a transaction with this reference and amount already exists. An administrator who
    // knows better (two genuine R500 transfers with a generic reference) confirms it explicitly, and the override is audited.
    const twin = await dbGet(
        `SELECT id, booking_id FROM transactions WHERE LOWER(reference) = LOWER(?) AND ROUND(amount, 2) = ? AND transaction_type = 'payment'
           AND status = 'completed' AND COALESCE(is_duplicate, 0) = 0 LIMIT 1`, [reference, v.clean.amount]);
    if (twin && !(input && input.confirm_duplicate)) {
        return fail(409, `A payment of R${v.clean.amount.toFixed(2)} with the reference "${v.clean.reference}" is already in the ledger (booking #${twin.booking_id}). If this is a different transfer, confirm to record it anyway.`,
            { duplicate_warning: true });
    }

    const outcome = await withDbTransaction(async () => {
        try { await dbRun('BEGIN IMMEDIATE'); }
        catch (e) { return { busy: true }; }
        try {
            // 1. the guard: exactly one approval can ever win this row
            const flip = await dbRun(
                `UPDATE eft_payment_submissions SET status = 'approved', verified_amount = ?, verified_reference = ?, verified_date = ?, review_note = ?,
                        reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
                 WHERE id = ? AND status = 'pending'`,
                [v.clean.amount, reference, v.clean.date, note, adminId, sub.id]);
            if (flip.changes === 0) { await dbRun('ROLLBACK').catch(() => {}); return { conflict: true }; }

            const booking = await getBookingByIdAsync(sub.booking_id);
            if (!booking) { await dbRun('ROLLBACK').catch(() => {}); return { missing: true }; }
            if (NO_PAYMENT_STATUSES.includes(String(booking.status || '').toUpperCase())) {
                await dbRun('ROLLBACK').catch(() => {});
                return { blocked: `Cannot record a payment on a ${String(booking.status).toUpperCase()} booking. Reject this proof and refund the client if they have paid.` };
            }
            const currentTotal = eft.bookingTotal(booking);
            if (!(currentTotal > 0)) { await dbRun('ROLLBACK').catch(() => {}); return { blocked: 'This booking has no total amount, so a payment cannot be applied safely. Set the booking total first.' }; }
            const outstanding = eft.bookingOutstanding(booking);
            // Stricter than the card path's R1 tolerance: a verified bank amount is exact, and more than is owed is a refund decision.
            if (v.clean.amount > outstanding + 0.009) {
                await dbRun('ROLLBACK').catch(() => {});
                return { overpayment: true, outstanding };
            }

            // 2. the ledger row
            const tx = await dbRun(
                `INSERT INTO transactions (booking_id, invoice_id, amount, transaction_type, payment_method, reference, transaction_date, status, source,
                                           proof_of_payment_path, notes, is_verified)
                 VALUES (?, ?, ?, 'payment', 'bank_transfer', ?, ?, 'completed', 'manual', ?, ?, 1)`,
                [booking.id, sub.invoice_id || null, v.clean.amount, reference, v.clean.date, sub.proof_filename, `Manual EFT - proof of payment #${sub.id}`]);

            // 3. the credit - the very statement the card payment uses
            const credit = await applyPayfastPaymentToBooking(
                v.clean.amount, currentTotal, 'EFT', reference, null, JSON.stringify({ source: 'eft', submission_id: sub.id }), 'bank_transfer', booking.id);
            if (credit.changes === 0) { await dbRun('ROLLBACK').catch(() => {}); return { overpayment: true, outstanding }; }

            // 4. link both ways, settle the invoice if that finished the booking
            await dbRun('UPDATE eft_payment_submissions SET transaction_id = ? WHERE id = ?', [tx.lastID, sub.id]);
            const fresh = await getBookingByIdAsync(booking.id);
            if (fresh && fresh.payment_status === 'PAID') await markInvoicePaidIfOpenAsync(booking.id);
            await eft.eventRow(sub.id, 'approved', 'admin', adminId, 'pending', 'approved',
                `Verified R${v.clean.amount.toFixed(2)}, reference "${v.clean.reference}", received ${v.clean.date}.` + (twin ? ' Duplicate warning overridden.' : '') + (v.clean.note ? ` Note: ${v.clean.note}` : ''));
            await dbRun('COMMIT');
            return { ok: true, fresh, transactionId: tx.lastID, previous: booking };
        } catch (e) {
            await dbRun('ROLLBACK').catch(() => {});
            // the unique index on transaction_id / a constraint: nothing was kept
            return { error: e };
        }
    });

    if (outcome.busy) return fail(503, 'The database is busy. Please try again in a moment.');
    if (outcome.conflict) return fail(409, 'This proof of payment was just reviewed by someone else. Nothing was changed.');
    if (outcome.missing) return fail(404, 'The booking for this proof of payment no longer exists.');
    if (outcome.blocked) return fail(409, outcome.blocked);
    if (outcome.overpayment) {
        return fail(409, `That is more than the R${outcome.outstanding.toFixed(2)} still outstanding on this booking, so it was not applied. Enter the amount that settles the booking, and refund or credit any excess separately.`,
            { overpayment: true, max_amount: outcome.outstanding });
    }
    if (outcome.error) {
        console.error(`[EFT] Approving proof #${sub.id} failed - rolled back, nothing recorded:`, outcome.error.message);
        return fail(500, 'The payment could not be recorded, and nothing was changed. Please try again.');
    }

    // ── Committed. Everything below is a side effect and may not undo the payment. ──
    const fresh = outcome.fresh;
    const newAmountPaid = parseFloat(fresh.amount_paid) || 0;
    const newOutstanding = parseFloat(fresh.amount_outstanding) || 0;
    const newPaymentStatus = fresh.payment_status;
    const approved = await eft.getSubmission(sub.id);

    await logAudit({
        tableName: 'eft_payment_submissions', recordId: sub.id, action: 'EFT_APPROVED', req,
        oldValues: { status: 'pending' },
        newValues: { status: 'approved', booking_id: sub.booking_id, transaction_id: outcome.transactionId, verified_amount: v.clean.amount, verified_reference: v.clean.reference, verified_date: v.clean.date, payment_status: newPaymentStatus, duplicate_override: !!twin },
        reason: v.clean.note
    }).catch(e => console.error('[EFT] Audit write failed:', e.message));
    logPaymentEvent(sub.booking_id, 'EFT_PAYMENT_APPROVED', { amount_gross: v.clean.amount, payment_method: 'bank_transfer', m_payment_id: `EFT-${sub.id}`, submission_id: sub.id }, true, reference, { auditOnly: true });

    (async () => {
        await syncBookingToCalendar(fresh).catch(e => console.error('[EFT] Calendar sync failed:', e.message));
        await eftNotify.sendProofApprovedEmail(fresh, approved, { newAmountPaid, newOutstanding, newPaymentStatus }).catch(e => console.error('[EFT] Approved email failed:', e.message));
        sendAdminPaymentNotification(fresh, newAmountPaid, newPaymentStatus).catch(e => console.error('[EFT] Admin payment notification failed:', e.message));
        if (newPaymentStatus === 'DEPOSIT_PAID' && newOutstanding > 0) {
            sendDepositBalanceDueEmail(fresh, newOutstanding).catch(e => console.error('[EFT] Balance-due email failed:', e.message));
        }
        if (newPaymentStatus === 'PAID') {
            sendBookingConfirmedEmail(fresh).catch(e => console.error('[EFT] Confirmed email failed:', e.message));
            sendPaidReceiptEmail(fresh).catch(e => console.error('[EFT] Paid receipt email failed:', e.message));
        }
        // the events row a confirmed booking gets on every other payment path
        if (fresh.status === 'CONFIRMED' && !fresh.event_id) {
            const evDatetime = fresh.date + (fresh.event_start_time ? ' ' + fresh.event_start_time : ' 00:00:00');
            insertAutoCreatedEvent(fresh.event_name || fresh.event_type || 'Booking Event', evDatetime, fresh.event_location || null, fresh.venue_id || null, fresh.id,
                function (evErr) {
                    if (evErr) { console.error('[Auto-Event] EFT: insert failed for booking #' + fresh.id + ':', evErr.message); return; }
                    setBookingEventId(this.lastID, fresh.id);
                });
        }
        alignMilestonePayments(fresh.id, newAmountPaid, (psErr) => { if (psErr) console.error('[EFT] Payment schedule update failed:', psErr.message); });
    })();

    return { ok: true, status: 200, message: `Payment of R${v.clean.amount.toFixed(2)} recorded for booking #${sub.booking_id}.`, transaction_id: outcome.transactionId, payment_status: newPaymentStatus, amount_paid: newAmountPaid, amount_outstanding: newOutstanding };
}

// kind: 'rejected' (the payment is not accepted) or 'replacement_requested' (the proof is unusable - send a better one). Either way the client
// gets the reason and nothing is credited.
async function reviewWithoutPayment(id, kind, noteInput, req) {
    const adminId = (req && req.session && req.session.adminId) || null;
    const reason = core.validateReason(noteInput);
    if (!reason.ok) return fail(400, reason.message);
    const sub = await eft.getSubmission(id);
    if (!sub) return fail(404, 'Proof of payment not found.');
    if (sub.status !== 'pending') return fail(409, `This proof of payment has already been reviewed (${sub.status.replace('_', ' ')}). Nothing was changed.`);
    const note = normalizeEncodedText(reason.note);

    const outcome = await withDbTransaction(async () => {
        try { await dbRun('BEGIN IMMEDIATE'); } catch (e) { return { busy: true }; }
        try {
            const flip = await dbRun(
                `UPDATE eft_payment_submissions SET status = ?, review_note = ?, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
                 WHERE id = ? AND status = 'pending'`, [kind, note, adminId, sub.id]);
            if (flip.changes === 0) { await dbRun('ROLLBACK').catch(() => {}); return { conflict: true }; }
            await eft.eventRow(sub.id, kind, 'admin', adminId, 'pending', kind, reason.note);
            await dbRun('COMMIT');
            return { ok: true };
        } catch (e) {
            await dbRun('ROLLBACK').catch(() => {});
            return { error: e };
        }
    });
    if (outcome.busy) return fail(503, 'The database is busy. Please try again in a moment.');
    if (outcome.conflict) return fail(409, 'This proof of payment was just reviewed by someone else. Nothing was changed.');
    if (outcome.error) { console.error(`[EFT] Reviewing proof #${sub.id} failed:`, outcome.error.message); return fail(500, 'The review could not be saved. Please try again.'); }

    await logAudit({
        tableName: 'eft_payment_submissions', recordId: sub.id, action: kind === 'rejected' ? 'EFT_REJECTED' : 'EFT_REPLACEMENT_REQUESTED', req,
        oldValues: { status: 'pending' }, newValues: { status: kind, booking_id: sub.booking_id }, reason: reason.note
    }).catch(e => console.error('[EFT] Audit write failed:', e.message));

    const booking = await getBookingByIdAsync(sub.booking_id).catch(() => null);
    if (booking) eftNotify.sendProofRejectedEmail(booking, { ...sub, review_note: note }, kind).catch(e => console.error('[EFT] Rejection email failed:', e.message));
    return { ok: true, status: 200, message: kind === 'rejected' ? 'Proof rejected. The client has been told why.' : 'Replacement requested. The client has been asked for a new proof.' };
}

const rejectSubmission = (id, note, req) => reviewWithoutPayment(id, 'rejected', note, req);
const requestReplacement = (id, note, req) => reviewWithoutPayment(id, 'replacement_requested', note, req);

module.exports = { approveSubmission, rejectSubmission, requestReplacement };
