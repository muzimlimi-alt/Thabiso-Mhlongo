// Phase 5 (HOUSEKEEPING-NOTES.md): applyStatusChange relocated here verbatim from app.js as a
// prerequisite for moving PUT /api/admin/bookings/:id and PUT .../status. Byte-identical body —
// only the imports below are new (they replace app.js's own top-of-file destructures).
const db = require('../database');
const { dbRun } = require('./db-helpers');
const { withDbTransaction } = require('./db-transaction');
const { resolveActor } = require('./actor');
const { deleteGoogleEvent } = require('./google-calendar');
const { calculateCancellationRefund } = require('./cancellation-refund');
const { sendCancellationEmail } = require('./booking-cancellation-email');
const { syncBookingToCalendar } = require('./calendar-sync');
const { autoBuildDepositBalanceSchedule, generateInvoice } = require('./invoicing');
const { generateContract } = require('./contracts');
const {
    sendBookingUnderReviewEmail, sendQuoteAcceptedEmail, sendBookingConfirmedEmail,
    sendBookingCompletedEmail, sendAdminCompletionSummaryEmail
} = require('./booking-notifications');
const {
    getBookingOutstandingForCompleteGuard, updateBookingStatusCore, clearBookingPublicAndEventId,
    clearBookingGoogleEventId, setBookingCancellationAttribution, getBookingById, setBookingEventId
} = require('../database/repositories/bookings.repository');
const {
    getEventGoogleCalendarId, demoteEventForCancelledBooking, clearEventGoogleCalendarId,
    insertAutoCreatedEvent, advanceEventToCompleted, releaseDateHoldsForBooking
} = require('../database/repositories/calendar.repository');
const {
    cancelPendingPaymentSchedules, insertCancellationForStatusChange
} = require('../database/repositories/finance.repository');
const {
    voidInvoicesForCancelledBooking, markQuotationAccepted, revertQuotationToSent,
    markInvoicePaidOnStatusComplete
} = require('../database/repositories/invoices-quotations.repository');

async function applyStatusChange(bookingId, requestedStatus, currentStatus, res, options = {}) {
    const ALLOWED_TRANSITIONS = {
        'NEW': ['PENDING','QUOTED','CANCELLED'],
        'PENDING': ['QUOTED','CANCELLED'],
        'QUOTED': ['ACCEPTED','CANCELLED'],
        'ACCEPTED': ['QUOTED','CONFIRMED','CANCELLED'],
        'CONFIRMED': ['COMPLETED','CANCELLED'],
        'COMPLETED': ['CANCELLED'],
        'CANCELLED': [],
        'EXPIRED': ['CANCELLED','PENDING']
    };
    const allowed = ALLOWED_TRANSITIONS[currentStatus] || [];
    if (!allowed.includes(requestedStatus)) {
        return res.status(400).json({ success: false, message: `Invalid transition from ${currentStatus} to ${requestedStatus}` });
    }
    // Guard: block COMPLETED when any payment is still outstanding
    if (requestedStatus === 'COMPLETED') {
        const chk = await getBookingOutstandingForCompleteGuard(bookingId);
        if (!chk.e) {
            const outstanding = parseFloat(chk.row?.amount_outstanding) || 0;
            if (outstanding > 0.01) {
                return res.status(400).json({ success: false, message: `Cannot complete — R${outstanding.toFixed(2)} is still outstanding. Record full payment before completing.` });
            }
        }
    }
    // pending_at is now tracked; all other timestamps already mapped
    const tsFields = { PENDING: 'pending_at', QUOTED: 'quoted_at', ACCEPTED: 'accepted_at', CONFIRMED: 'confirmed_at', COMPLETED: 'completed_at', CANCELLED: 'cancelled_at' };
    const tsField = tsFields[requestedStatus];
    // modified_by/modified_by_role are set here in the same UPDATE so the audit_bookings_update
    // trigger can read them via NEW.modified_by(_role) into audit_log.actor_role — this replaces the
    // parallel explicit audit_log insert that used to sit below, which double-wrote a row for every
    // status change (once here, once from the trigger that already fires on any bookings UPDATE).
    updateBookingStatusCore(requestedStatus, tsField, options.adminId, options.role, bookingId, async function(upErr) {
        if (upErr) return res.status(500).json({ success: false, error: upErr.message });
        const actor = await resolveActor(options.adminId);
        getBookingById(bookingId, async (e, b) => {
            if (!e && b) {
                if (b.event_id && !['ACCEPTED', 'CONFIRMED', 'COMPLETED'].includes(requestedStatus)) {
                    clearBookingPublicAndEventId(bookingId);
                    // On cancellation, switch the linked public event to draft rather than deleting it.
                    // Also clears events.booking_id — matches POST /:id/cancel's identical cascade
                    // (see that route) so both cancellation entry points leave the same state instead of
                    // each clearing only one side of the bookings.event_id <-> events.booking_id pair.
                    if (requestedStatus === 'CANCELLED') {
                        getEventGoogleCalendarId(b.event_id, (evErr, evRow) => {
                            demoteEventForCancelledBooking('Linked booking #' + bookingId + ' was cancelled', b.event_id);
                            // The event may have its own separate Google Calendar entry (synced via
                            // syncEventToCalendar, independent of the booking's own google_event_id
                            // handled above) — without this it stays live/public on Google even though
                            // it's now locally demoted to draft.
                            if (!evErr && evRow && evRow.google_calendar_event_id) {
                                deleteGoogleEvent(evRow.google_calendar_event_id);
                                clearEventGoogleCalendarId(b.event_id);
                            }
                        });
                    }
                }

                if (requestedStatus === 'CANCELLED') {
                    const reason = options.reason || 'Booking cancelled by admin';
                    await deleteGoogleEvent(b.google_event_id);
                    // Null it now that we've asked Google to delete it, or any later sync attempt for
                    // this booking silently fails forever (update-against-a-deleted-event, never
                    // falls back to re-creating it — see the identical fix in POST /:id/cancel).
                    if (b.google_event_id) clearBookingGoogleEventId(bookingId);
                    // E1: store cancellation reason/attribution AND run the SAME financial + hold
                    // cascade as POST /api/admin/bookings/:id/cancel, so cancelling via the status
                    // API leaves an identical state (previously this path skipped payment_status,
                    // invoice void, schedule cancel and hold release).
                    // Same trigger constraint as the dedicated cancel route: 'CANCELLED' is not a legal
                    // payment_status, and this statement had no error callback — so the ABORT silently
                    // discarded cancellation_reason and cancelled_by along with it.
                    setBookingCancellationAttribution(reason, bookingId,
                        (e) => { if (e) console.error('[Status Cancel] Failed to record cancellation attribution:', e.message); });
                    releaseDateHoldsForBooking(bookingId,
                        (e) => { if (e) console.error('[Status Cancel] Hold release failed:', e.message); });
                    voidInvoicesForCancelledBooking(bookingId,
                        (e) => { if (e) console.error('[Status Cancel] Invoice void failed:', e.message); });
                    cancelPendingPaymentSchedules(bookingId,
                        (e) => { if (e) console.error('[Status Cancel] Payment schedule cancel failed:', e.message); });
                    // Apply the same refund policy calculator used by client self-cancellation
                    db.get("SELECT policy_value FROM policies WHERE policy_key = 'cancellation_policy'", [], (pErr, policy) => {
                        const calc = calculateCancellationRefund(b, policy ? policy.policy_value : '');
                        // D-1: cancellations.cancelled_by has a CHECK IN ('client','comedian','mutual','force_majeure')
                        // — 'admin' violated it, so this INSERT failed silently (no cancellation record via the
                        // status API). Use 'comedian' (business-initiated), matching the dedicated /cancel endpoint's
                        // default for admin-initiated cancellations. Attribution to admin stays on bookings.cancelled_by.
                        insertCancellationForStatusChange(bookingId, reason, calc.totalPaid, calc.refund, calc.retention,
                            (cErr) => { if (cErr) console.error('[Status Cancel] Cancellation record insert failed:', cErr.message); });
                        // SC-3: Include policy rule + timing in cancellation email
                        sendCancellationEmail(b, { reason, refund_due: calc.refund, rule: calc.rule, days_until_event: calc.daysUntilEvent }).catch(e => console.error('Cancel email failed:', e.message));
                    });
                } else {
                    await syncBookingToCalendar(b);
                }
                if (requestedStatus === 'PENDING') sendBookingUnderReviewEmail(b).catch(e => console.error('Under-review email failed:', e.message));
                if (requestedStatus === 'ACCEPTED') {
                    // Update active quotation's status to 'accepted'
                    markQuotationAccepted(bookingId, (err) => {
                        if (err) console.error('[Status Change] Failed to update quotation status to accepted:', err.message);
                    });
                    sendQuoteAcceptedEmail(b).catch(e => console.error('Invoiced email failed:', e.message));
                    // Parity with client self-acceptance: build the deposit/balance schedule + a DRAFT
                    // invoice (admin reviews & sends, unlike the client path which emails immediately) +
                    // a draft contract — so admin-accept and client-accept leave identical state instead
                    // of admin-accept leaving the booking bare. Fire-and-forget with logging, matching
                    // the other post-status side effects; a refresh reflects it.
                    (async () => {
                        try {
                            const total = parseFloat(b.total_amount) || 0;
                            await withDbTransaction(async () => {
                                await dbRun("BEGIN IMMEDIATE");
                                try {
                                    await autoBuildDepositBalanceSchedule(b.id, total, b.date);
                                    await dbRun("COMMIT");
                                } catch (schErr) { await dbRun("ROLLBACK").catch(() => {}); throw schErr; }
                            });
                            await generateInvoice(b.id, { autoSend: false }); // DRAFT — admin sends explicitly
                            await generateContract(b.id).catch(cErr => console.error('[Status Accept] Contract draft failed:', cErr.message));
                        } catch (finErr) {
                            console.error('[Status Accept] Auto-finalize failed for booking #' + b.id + ':', finErr.message);
                        }
                    })();
                }
                if (requestedStatus === 'QUOTED') {
                    // Revert active quotation's status to 'sent'
                    revertQuotationToSent(bookingId, (err) => {
                        if (err) console.error('[Status Change] Failed to revert quotation status to sent:', err.message);
                    });
                }
                if (requestedStatus === 'CONFIRMED') {
                    sendBookingConfirmedEmail(b).catch(e => console.error('Confirmed email failed:', e.message));
                    // Auto-create an events row if none exists yet for this booking
                    if (!b.event_id) {
                        const eventDatetime = b.date + (b.event_start_time ? ' ' + b.event_start_time : ' 00:00:00');
                        insertAutoCreatedEvent(
                            b.event_name || b.event_type || 'Booking Event', eventDatetime, b.event_location || null, b.venue_id || null, b.id,
                            function(evInsErr) {
                                if (evInsErr) { console.error('[Auto-Event] Insert failed for booking #' + b.id + ':', evInsErr.message); return; }
                                setBookingEventId(this.lastID, b.id,
                                    (evUpErr) => { if (evUpErr) console.error('[Auto-Event] Booking event_id link failed:', evUpErr.message); });
                            }
                        );
                    }
                }
                if (requestedStatus === 'COMPLETED') {
                    sendBookingCompletedEmail(b).catch(e => console.error('Completed email failed:', e.message));
                    sendAdminCompletionSummaryEmail(b).catch(e => console.error('Admin completion summary failed:', e.message));
                    // S6-4: Auto-mark invoice as paid when booking is completed with full payment
                    markInvoicePaidOnStatusComplete(b.id);
                    // Parity with the dedicated POST /:id/complete route and the hourly auto-complete
                    // sweep — both advance the linked event; this generic status path used to leave it
                    // stuck at 'upcoming' when completed via PUT /:id or /:id/status instead.
                    if (b.event_id) {
                        advanceEventToCompleted(b.event_id);
                    }
                }
            }
        });
        res.json({ success: true, newStatus: requestedStatus, last_updated: { name: actor.name, role: actor.role, at: new Date().toISOString() } });
    });
}

module.exports = { applyStatusChange };
