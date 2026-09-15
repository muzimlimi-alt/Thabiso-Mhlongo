const express = require('express');
const { dbRun } = require('../../lib/db-helpers');
const { withDbTransaction } = require('../../lib/db-transaction');
const { escapeEmailFields } = require('../../lib/email-escape');
const { getEmailFooterContext, emailBaseUrl } = require('../../lib/email-context');
const { syncBookingToCalendar } = require('../../lib/calendar-sync');
const { generatePayFastSignature } = require('../../lib/payfast-signature');
const {
    payfastItnRateLimiter, PAYFAST_VALID_IPS
} = require('../../middleware/rate-limiters');
const {
    logPaymentEvent, alignMilestonePayments
} = require('../../lib/payment-processing');
const {
    sendPaymentReceivedEmail, sendAdminPaymentNotification, sendDepositBalanceDueEmail,
    sendBookingConfirmedEmail, sendPaidReceiptEmail
} = require('../../lib/booking-notifications');
const bannerRegistry = require('../../js/bannerRegistry');
const emailComponents = require('../../js/emailComponents');
const { sendEmail } = require('../../js/emailService');
const { getNotificationEmail } = require('../../database/repositories/settings.repository');
const {
    getBookingByIdAsync, markBookingPaymentFailedIfUnpaid, getBookingById, setBookingEventId,
    applyPayfastPaymentToBooking
} = require('../../database/repositories/bookings.repository');
const { insertAutoCreatedEvent } = require('../../database/repositories/calendar.repository');
const {
    getPayfastTransactionByReference, insertPayfastTransaction, getPaymentLogsForBooking
} = require('../../database/repositories/finance.repository');
const { markInvoicePaidIfOpenAsync } = require('../../database/repositories/invoices-quotations.repository');
const router = express.Router();

async function sendPaymentFailedEmail(booking) {
    booking = escapeEmailFields(booking);
    const { id, name, email, event_name, event_type, date, total_amount, quote_amount } = booking;
    const displayTotal = total_amount || (quote_amount ? parseFloat((quote_amount || '0').replace(/[^0-9.]/g, '')) : 0);
    // PAYMENT-CRITICAL: `R${...}` amount format kept verbatim (no space).
    const { socialLinks } = await getEmailFooterContext();
    const banner = await bannerRegistry.resolveBanner('payment_failed');
    const html = emailComponents.renderPremiumEmail({
        preheaderText: `We couldn't complete your payment for booking #${id}.`,
        bannerSrc: banner?.src, bannerAlt: banner?.alt, subtitle: banner?.subtitle,
        headline: banner?.headline || 'Payment Not Completed',
        greeting: `Hi ${name},`,
        bodyHtml:
            `We noticed that your payment for <strong style="color:#FAFAFA;">${event_name || event_type}</strong> on <strong style="color:#FAFAFA;">${date}</strong> was not completed successfully.` +
            (displayTotal > 0 ? `<p style="margin:12px 0 0;"><strong style="color:#D4AF37;">Amount Due:</strong> R${parseFloat(displayTotal).toFixed(2)}</p>` : '') +
            `<p style="margin:10px 0 0; color:#E6E6E6;">Please try again via your booking tracker, or contact us directly if you need assistance. <span style="color:#B0B0B0; font-size:13px;">(Booking reference #${id})</span></p>` +
            `<p style="margin:10px 0 0; color:#B0B0B0; font-size:13px;">If this was a mistake, no action is needed — your booking remains active.</p>`,
        cta: { label: 'Try Payment Again', url: `${emailBaseUrl()}/?track=${id}&email=${encodeURIComponent(email)}` },
        socialLinks
    });
    const result = await sendEmail({
        to: email, subject: `Payment Unsuccessful – Booking #${id}`,
        htmlContent: html, preWrapped: true, titleOverride: 'Payment Not Completed',
        trigger_event: 'Booking: Payment Failed'
    });
    return result.success;
}

// ==========================================
// PayFast Payment Gateway
// ==========================================
// PAYFAST_VALID_IPS and payfastItnRateLimiter moved to middleware/rate-limiters.js (Phase 5,
// HOUSEKEEPING-NOTES.md) — both destructured in with every other rate limiter near the top of
// this file now.

// ============================================================
// Public booking tracker — email-verification second factor.
//
// Previously, "booking id + the email on file" alone was accepted as proof of ownership across
// every public tracking route (/track, /pay, /accept-quote, /cancel, /contract/sign, downloads).
// Booking ids are sequential and easily guessed, and an email address is often knowable to a third
// party (a colleague, a shared inbox, a leak elsewhere) — so that pair falls short of proving the
// caller actually controls the client's inbox. This flow adds that proof:
//   1. POST /track/request-code  — emails a 6-digit code to the address on file.
//   2. POST /track/verify-code   — exchanges a correct code for a booking-scoped access_token.
// Every tracking route below now requires that access_token (via requireBookingAccessToken)
// instead of a bare client-supplied email.
// ============================================================
// Phase 5 (HOUSEKEEPING-NOTES.md): OTP_TTL_MINUTES/OTP_MAX_ATTEMPTS/ACCESS_TOKEN_TTL_MINUTES/
// generateOtpCode/hashAccessToken moved to lib/booking-tracking.js; requireBookingAccessToken
// (which depends on hashAccessToken) moved to middleware/booking-access.js, alongside requireAdmin.
// None of the five has a remaining caller in app.js — the booking-tracker routes and verifyPopiaOtp
// (its only caller of OTP_MAX_ATTEMPTS) all moved to routes/public/{bookings,popia}.js, each
// importing whichever of these it still needs directly.



// Phase 5 (HOUSEKEEPING-NOTES.md): verifyPopiaOtp (the POPIA OTP verification helper — mirrors the
// booking-tracker OTP mechanics above but keyed by email alone) moved to routes/public/popia.js
// alongside its three call sites (preview, erasure-requests, compliance/request-forget), all of
// which moved together in the same batch.




// ==========================================
// PayFast ITN (Instant Transaction Notification) — SECURE
// ==========================================
router.post('/api/payment/webhook/payfast', payfastItnRateLimiter, async (req, res) => {
    // Step 1: Immediately acknowledge to PayFast
    res.sendStatus(200);
    
    const pfData = req.body;
    if (!pfData || !pfData.m_payment_id) {
        console.error('[PayFast ITN] Empty or malformed ITN received.');
        return;
    }

    console.log(`[PayFast ITN] Received notification for m_payment_id: ${pfData.m_payment_id}`);

    const parts = (pfData.m_payment_id || '').split('_');
    const bookingId = parseInt(parts[0], 10);
    const paymentType = parts[1] || 'FULL';

    if (isNaN(bookingId)) {
        console.error('[PayFast ITN] Invalid bookingId in m_payment_id:', pfData.m_payment_id);
        return;
    }

    try {
        // ── 0. Log & detect environment ──
        logPaymentEvent(bookingId, 'ITN_RECEIVED', pfData, false);
        const isSandbox = (process.env.PAYFAST_URL || '').includes('sandbox');

        // P3-15: Timestamp replay protection — reject ITNs older than 30 minutes in production.
        if (!isSandbox && pfData.timestamp) {
            const itnTime = new Date(pfData.timestamp);
            const ageMins = (Date.now() - itnTime.getTime()) / 60000;
            if (isNaN(itnTime.getTime()) || ageMins > 30) {
                console.error(`[PayFast ITN] STALE TIMESTAMP for booking #${bookingId}: timestamp=${pfData.timestamp}, age=${ageMins.toFixed(1)}m — rejecting as possible replay.`);
                logPaymentEvent(bookingId, 'FAILED_STALE_TIMESTAMP', pfData, false);
                return;
            }
        }

        // ── A. Signature Validation ──
        const passphrase = process.env.PAYFAST_PASSPHRASE || null;
        const receivedSignature = pfData.signature;

        // Reconstruct signature from all params EXCEPT 'signature'
        let sigData = {};
        for (let key in pfData) {
            if (key !== 'signature') sigData[key] = pfData[key];
        }
        const calculatedSignature = generatePayFastSignature(sigData, passphrase);

        if (calculatedSignature !== receivedSignature) {
            console.error(`[PayFast ITN] SIGNATURE MISMATCH booking #${bookingId} — expected: ${calculatedSignature}, received: ${receivedSignature}`);
            logPaymentEvent(bookingId, 'FAILED_SIGNATURE', pfData, false);
            if (!isSandbox) return; // Hard-fail in production only
            // In sandbox: log and continue — passphrase in .env may differ from sandbox account setting
            console.warn(`[PayFast ITN] Sandbox: proceeding despite mismatch. Verify PAYFAST_PASSPHRASE in .env matches your sandbox merchant account.`);
        } else {
            console.log(`[PayFast ITN] ✓ Signature valid for booking #${bookingId}`);
        }

        // ── B. Source IP Validation ──
        // Use req.ip, not the raw X-Forwarded-For header. `app.set('trust proxy', 1)` is configured,
        // so Express resolves req.ip from the trusted proxy hop. Reading X-Forwarded-For directly and
        // taking its leftmost value let a caller spoof an allowlisted PayFast IP with a header, which
        // would defeat this check entirely.
        const sourceIp = (req.ip || req.connection.remoteAddress || '').split(',')[0].trim().replace('::ffff:', '');

        if (!isSandbox && !PAYFAST_VALID_IPS.includes(sourceIp)) {
            console.error(`[PayFast ITN] INVALID SOURCE IP: ${sourceIp}`);
            logPaymentEvent(bookingId, 'FAILED_IP', pfData, true);
            return;
        }
        console.log(`[PayFast ITN] ✓ Source IP valid: ${sourceIp}`);

        // ── B2. Merchant ID Validation ──
        if (String(pfData.merchant_id) !== String(process.env.PAYFAST_MERCHANT_ID)) {
            console.error(`[PayFast ITN] MERCHANT ID MISMATCH booking #${bookingId}: got ${pfData.merchant_id}, expected ${process.env.PAYFAST_MERCHANT_ID}`);
            logPaymentEvent(bookingId, 'FAILED_MERCHANT_ID', pfData, false);
            return;
        }
        console.log(`[PayFast ITN] ✓ Merchant ID valid for booking #${bookingId}`);

        // ── C. Database Lookup ──
        const booking = await getBookingByIdAsync(bookingId);

        if (!booking) {
            console.error(`[PayFast ITN] Booking #${bookingId} NOT FOUND.`);
            return;
        }

        if (booking.payment_status === 'PAID') {
            console.warn(`[PayFast ITN] Booking #${bookingId} already fully PAID. Ignoring duplicate ITN.`);
            logPaymentEvent(bookingId, 'IGNORED_DUPLICATE', pfData, true);
            return;
        }

        // ── D. PayFast Server Confirmation (POST BACK) ──
        const pfValidateHost = isSandbox
            ? 'https://sandbox.payfast.co.za/eng/query/validate'
            : 'https://www.payfast.co.za/eng/query/validate';
            
        // Include BOTH payload AND signature for validation POST per PayFast requirements
        let validateParams = [];
        for (let key in pfData) {
            validateParams.push(`${key}=${encodeURIComponent(pfData[key]).replace(/%20/g, '+')}`);
        }
        const validateBody = validateParams.join('&');
        
        let pfServerValid = false;
        try {
            const https = require('https');
            const urlModule = require('url');
            const parsedUrl = urlModule.parse(pfValidateHost);
            
            pfServerValid = await new Promise((resolve) => {
                const options = {
                    hostname: parsedUrl.hostname, port: 443, path: parsedUrl.path, method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(validateBody), 'connection': 'close' },
                    rejectUnauthorized: !isSandbox,
                    timeout: 8000
                };
                const request = https.request(options, (response) => {
                    let data = '';
                    response.on('data', (chunk) => data += chunk);
                    response.on('end', () => resolve(data.trim() === 'VALID'));
                });
                request.on('timeout', () => { request.destroy(); resolve(false); });
                request.on('error', () => resolve(false));
                request.write(validateBody);
                request.end();
            });
        } catch (serverErr) {
            console.error('[PayFast ITN] Server confirmation error:', serverErr.message);
        }

        if (!pfServerValid && !isSandbox) {
            console.error(`[PayFast ITN] SERVER CONFIRMATION FAILED for booking #${bookingId}`);
            logPaymentEvent(bookingId, 'FAILED_API_VALIDATION', pfData, true);
            return;
        }

        // Idempotency guard: check BEFORE inserting the transaction record.
        // In production, require pf_payment_id — synthetic keys based on amount+status can collide
        // on PayFast retries with rounding differences, creating duplicate transactions.
        if (!pfData.pf_payment_id && !isSandbox) {
            console.error(`[PayFast ITN] Missing pf_payment_id for booking #${bookingId} in production — rejecting to prevent synthetic-key dedup collision.`);
            logPaymentEvent(bookingId, 'FAILED_NO_PAYMENT_ID', pfData, false);
            return; // res already sent with 200 at top; return stops processing
        }
        const itnRef = pfData.pf_payment_id || `synthetic-${bookingId}-${pfData.amount_gross}-${pfData.payment_status}`;
        const alreadyProcessed = await getPayfastTransactionByReference(itnRef, bookingId);
        if (alreadyProcessed) {
            console.warn(`[PayFast ITN] Duplicate ITN ignored for ref=${itnRef} booking #${bookingId}`);
            logPaymentEvent(bookingId, 'IGNORED_DUPLICATE', pfData, true);
            return;
        }

        // ══════════════════════════════════════════
        // Ledger Execution Engine
        // ══════════════════════════════════════════
        if (pfData.payment_status === 'COMPLETE') {
            const itnAmount = parseFloat(pfData.amount_gross) || 0;
            const currentTotal = parseFloat(booking.total_amount) || parseFloat((booking.quote_amount||'0').replace(/[^0-9.]/g, '')) || 0;
            // P2-13: If we still can't resolve a total, reject the ITN — overpayment guard cannot function without it.
            if (currentTotal === 0) {
                console.error(`[PayFast ITN] REJECTED: booking #${bookingId} has no resolvable total_amount. Cannot apply payment safely.`);
                logPaymentEvent(bookingId, 'FAILED_NO_TOTAL', pfData, true);
                getNotificationEmail().then(notifEmail => {
                    if (!notifEmail) return;
                    // PAYMENT-GATEWAY (HIGH): `R${itnAmount.toFixed(2)}` and the booking ID kept verbatim.
                    sendEmail({
                        to: notifEmail,
                        subject: `PayFast ITN Rejected – Missing Total – Booking #${bookingId}`,
                        htmlContent: emailComponents.renderSystemEmail({
                            preheaderText: `PayFast ITN for booking #${bookingId} rejected — no total_amount set.`,
                            category: 'Payments & Invoices',
                            severity: 'alert',
                            leadFact: `A PayFast ITN for booking <strong style="color:#FAFAFA;">#${bookingId}</strong> (R${itnAmount.toFixed(2)}) was <strong style="color:#E8A83E;">rejected</strong> because the booking has no total_amount set.`,
                            bodyHtml: `<p style="margin:0; color:#E6E6E6;">Set the booking total and replay the transaction manually.</p>`
                        }),
                        preWrapped: true,
                        titleOverride: 'ITN Rejected – Missing Total',
                        trigger_event: 'Admin: ITN No Total'
                    });
                }).catch(e => console.error('[ITN] Admin alert failed:', e.message));
                return;
            }

            const rawMethod = (pfData.payment_method || '').toLowerCase();
            const PF_METHOD_MAP = { cc: 'credit_card', dc: 'credit_card', ef: 'bank_transfer', mp: 'payfast',
                bc: 'payfast', payfast: 'payfast', mc: 'payfast', sc: 'payfast', cd: 'payfast', mt: 'payfast',
                cf: 'payfast', zp: 'payfast', rp: 'payfast' };
            const mappedMethod = PF_METHOD_MAP[rawMethod] || 'payfast';

            // The transactions row, the ledger credit and the invoice→PAID sync are ONE atomic unit.
            //
            // Idempotency is enforced by the DB, not by the check-then-act SELECT above. transactions
            // .pf_payment_id is UNIQUE and was never populated on this path, so a replayed or
            // concurrent duplicate ITN could pass the pre-check and credit twice. We now write
            // pf_payment_id inside the transaction; a duplicate ITN fails the UNIQUE constraint and
            // the whole credit rolls back. Legacy/manual rows have NULL pf_payment_id, and SQLite
            // permits many NULLs in a UNIQUE column, so no backfill is needed.
            //
            // F4: the credit is a single atomic UPDATE — increment, outstanding/status derivation and
            // the overpayment guard (WHERE new_total <= total + R1) in one statement. Column refs read
            // the pre-update row, so (amount_paid + ?) is the post-credit total across every clause.
            const outcome = await withDbTransaction(async () => {
                try {
                    await dbRun("BEGIN IMMEDIATE");
                } catch (beginErr) {
                    console.error(`[PayFast ITN] BEGIN IMMEDIATE failed for booking #${bookingId}:`, beginErr.message);
                    return { retry: true };
                }
                try {
                    await insertPayfastTransaction(bookingId, itnAmount, mappedMethod, itnRef, pfData.pf_payment_id || null, pfData.payment_status, receivedSignature);

                    const credit = await applyPayfastPaymentToBooking(
                        itnAmount, currentTotal, paymentType,
                        pfData.pf_payment_id || null, receivedSignature, JSON.stringify(pfData), pfData.payment_method || 'payfast',
                        bookingId
                    );
                    if (credit.changes === 0) {
                        await dbRun("ROLLBACK").catch(() => {}); // overpayment guard blocked it — undo the tx insert too
                        return { overpayment: true };
                    }

                    const fresh = await getBookingByIdAsync(bookingId);
                    if (fresh && fresh.payment_status === 'PAID') {
                        await markInvoicePaidIfOpenAsync(bookingId);
                    }

                    await dbRun("COMMIT");
                    return { ok: true, fresh };
                } catch (txErr) {
                    await dbRun("ROLLBACK").catch(() => {});
                    if (/UNIQUE constraint/i.test(txErr.message || '')) return { duplicate: true };
                    return { error: txErr };
                }
            });

            // res.sendStatus(200) was already sent (correct for PayFast), so nothing can be returned to
            // the caller — every outcome is logged and, where it matters, an admin is alerted.
            if (outcome.retry) { logPaymentEvent(bookingId, 'DEFERRED_DB_BUSY', pfData, true); return; }
            if (outcome.duplicate) {
                console.warn(`[PayFast ITN] Duplicate pf_payment_id for booking #${bookingId} — rejected by UNIQUE constraint.`);
                logPaymentEvent(bookingId, 'IGNORED_DUPLICATE', pfData, true, itnRef, { auditOnly: true });
                return;
            }
            if (outcome.error) {
                console.error(`[PayFast ITN] Credit transaction failed for booking #${bookingId}:`, outcome.error.message);
                logPaymentEvent(bookingId, 'CRITICAL_ERROR', pfData, false);
                // PAYMENT-GATEWAY (HIGH): `R${itnAmount.toFixed(2)}`, booking ID and the error message
                // (outcome.error.message) are kept verbatim.
                getNotificationEmail().then(notifEmail => notifEmail && sendEmail({ to: notifEmail,
                    subject: `PayFast ITN Failed – Booking #${bookingId}`,
                    htmlContent: emailComponents.renderSystemEmail({
                        preheaderText: `PayFast payment for booking #${bookingId} could not be recorded.`,
                        category: 'Payments & Invoices',
                        severity: 'alert',
                        leadFact: `A verified PayFast payment for booking <strong style="color:#FAFAFA;">#${bookingId}</strong> (R${itnAmount.toFixed(2)}) could not be recorded: ${outcome.error.message}.`,
                        bodyHtml: `<p style="margin:0; color:#E6E6E6;">The booking ledger is unchanged. Replay manually.</p>`
                    }),
                    preWrapped: true,
                    titleOverride: 'ITN Processing Failed', trigger_event: 'Admin: ITN Failure' })).catch(() => {});
                return;
            }
            if (outcome.overpayment) {
                console.warn(`[PayFast ITN] OVERPAYMENT REJECTED for booking #${bookingId} (atomic guard). Total: ${currentTotal}, ITN amount: ${itnAmount}`);
                logPaymentEvent(bookingId, 'OVERPAYMENT_REJECTED', pfData, true);
                // PAYMENT-GATEWAY (HIGH): both `R${amount}` figures and the booking ID kept verbatim.
                getNotificationEmail().then(notifEmail => {
                    sendEmail({ to: notifEmail,
                        subject: `Overpayment Detected – Booking #${bookingId}`,
                        htmlContent: emailComponents.renderSystemEmail({
                            preheaderText: `Overpayment detected for booking #${bookingId} — credit NOT applied.`,
                            category: 'Payments & Invoices',
                            severity: 'alert',
                            leadFact: `PayFast sent <strong style="color:#FAFAFA;">R${itnAmount.toFixed(2)}</strong> for booking <strong style="color:#FAFAFA;">#${bookingId}</strong> but crediting it would exceed the R${currentTotal.toFixed(2)} booking total.`,
                            bodyHtml: `<p style="margin:0; color:#E6E6E6;">Credit was <strong style="color:#E8A83E;">NOT applied</strong>. Manual review required.</p>`
                        }),
                        preWrapped: true,
                        titleOverride: 'Overpayment Alert', trigger_event: 'Admin: Overpayment Alert' });
                }).catch((emailErr) => {
                    console.error(`[PayFast ITN] CRITICAL: Overpayment admin notification failed for booking #${bookingId}:`, emailErr.message);
                });
                return;
            }

            // ── Committed. The transactions row exists; log the payment_logs audit entries only. ──
            logPaymentEvent(bookingId, 'VERIFIED_OK', pfData, true, itnRef, { auditOnly: true });
            const updatedRow = outcome.fresh;
            const newAmountPaid = parseFloat(updatedRow.amount_paid) || 0;
            const newOutstanding = parseFloat(updatedRow.amount_outstanding) || 0;
            const newPaymentStatus = updatedRow.payment_status;

            console.log(`[PayFast ITN] ✅ Booking #${bookingId} Ledger Updated: Paid=R${newAmountPaid.toFixed(2)}, Remaining=R${newOutstanding.toFixed(2)}, Status=${newPaymentStatus}`);
            logPaymentEvent(bookingId, 'LEDGER_UPDATED_COMPLETE', pfData, true, itnRef, { auditOnly: true });

            // ── Side effects, all after the commit. None may re-enter the transaction queue. ──
            await syncBookingToCalendar(updatedRow).catch(e => console.error('[PayFast ITN] Calendar sync failed:', e.message));
            await sendPaymentReceivedEmail(updatedRow, newAmountPaid, newOutstanding, newPaymentStatus).catch(e => console.error('Payment-received email failed:', e.message));
            sendAdminPaymentNotification(updatedRow, newAmountPaid, newPaymentStatus)
                .catch(e => console.error('Admin payment notification failed:', e.message));
            if (newPaymentStatus === 'DEPOSIT_PAID' && newOutstanding > 0) {
                sendDepositBalanceDueEmail(updatedRow, newOutstanding).catch(e => console.error('Deposit balance-due email failed:', e.message));
            }
            if (newPaymentStatus === 'PAID') {
                sendBookingConfirmedEmail(updatedRow).catch(e => console.error('Confirmed email after payment failed:', e.message));
                // Invoice was set PAID inside the transaction; just send the receipt.
                sendPaidReceiptEmail(updatedRow).catch(e => console.error('Paid receipt email (ITN) failed:', e.message));
            }
            // Auto-create the events row whenever the payment CONFIRMED the booking — deposit or full.
            // This used to be gated on newPaymentStatus === 'PAID', so a PayFast deposit that confirmed
            // the booking got no events row, while the identical deposit recorded via the manual-payment
            // route (processManualPayment) and an admin status-change (applyStatusChange) both do create
            // one. Gating on the resulting CONFIRMED status makes all three paths consistent.
            // created_by is NULL, not 'system': events.created_by is an INTEGER FK to admins(id), so the
            // string 'system' failed the FK constraint every time — which is why this auto-create had
            // NEVER produced a row on any of the three paths. NULL is the system-created marker (existing
            // rows already use it) and is what admins(id) FK allows for an event no admin authored.
            if (updatedRow.status === 'CONFIRMED' && !updatedRow.event_id) {
                const evDatetime = updatedRow.date + (updatedRow.event_start_time ? ' ' + updatedRow.event_start_time : ' 00:00:00');
                insertAutoCreatedEvent(
                    updatedRow.event_name || updatedRow.event_type || 'Booking Event', evDatetime,
                    updatedRow.event_location || null, updatedRow.venue_id || null, bookingId,
                    function(evErr) {
                        if (evErr) { console.error('[Auto-Event] PayFast: Insert failed for booking #' + bookingId + ':', evErr.message); return; }
                        setBookingEventId(this.lastID, bookingId);
                    }
                );
            }
            // Mark payment schedule items as paid based on total amount now credited
            alignMilestonePayments(bookingId, newAmountPaid, (psErr) => {
                if (psErr) console.error(`[Payment Schedules] Update failed for booking #${bookingId}:`, psErr.message);
            });
        } else {
            console.warn(`[PayFast ITN] Payment status is "${pfData.payment_status}" (not COMPLETE) for booking #${bookingId}`);
            logPaymentEvent(bookingId, `STATUS_${pfData.payment_status.toUpperCase()}`, pfData, true);
            // CANCELLED: customer aborted — keep UNPAID (retryable); do not mark as FAILED
            // FAILED/other: set FAILED on UNPAID bookings; preserve DEPOSIT_PAID for balance-payment failures
            if (pfData.payment_status === 'CANCELLED') {
                console.log(`[PayFast ITN] Booking #${bookingId} payment cancelled by customer. Status unchanged (retryable).`);
            } else {
                markBookingPaymentFailedIfUnpaid(bookingId);
            }
            getBookingById(bookingId, (e, failedRow) => {
                if (!e && failedRow) {
                    if (pfData.payment_status !== 'CANCELLED') {
                        sendPaymentFailedEmail(failedRow).catch(e => console.error('Payment-failed email error:', e.message));
                    }
                    // C6: If a balance payment failed on a partially-paid booking, explicitly alert admin.
                    // PAYMENT-GATEWAY (HIGH): client name, booking ID and pfData.payment_status verbatim.
                    if (failedRow.payment_status === 'DEPOSIT_PAID') {
                        getNotificationEmail().then(notifEmail => sendEmail({
                            to: notifEmail,
                            subject: `⚠️ Balance Payment Failed – Booking #${bookingId}`,
                            htmlContent: emailComponents.renderSystemEmail({
                                preheaderText: `Balance payment failed for booking #${bookingId} — deposit remains on record.`,
                                category: 'Payments & Invoices',
                                severity: 'alert',
                                leadFact: `A balance payment attempt by <strong style="color:#FAFAFA;">${failedRow.name || failedRow.client_name}</strong> for Booking <strong style="color:#FAFAFA;">#${bookingId}</strong> has failed.`,
                                bodyHtml: `<p style="margin:0; color:#E6E6E6;">The booking still has a deposit on record. Payment status remains <strong style="color:#D4AF37;">DEPOSIT_PAID</strong>. Please follow up with the client.</p>`,
                                cards: [{ rows: [{ label: 'PayFast Status', value: pfData.payment_status, highlight: true }] }]
                            }),
                            preWrapped: true,
                            titleOverride: 'Balance Payment Failed',
                            trigger_event: 'Admin: Balance Payment Failed'
                        })).catch(err => console.error('Admin balance-failed email error:', err.message));
                    }
                }
            });
        }

    } catch (itnError) {
        console.error(`[PayFast ITN] Unhandled error processing ITN for booking #${bookingId}:`, itnError);
        logPaymentEvent(bookingId, `CRITICAL_ERROR`, pfData, false);
    }
});

// Phase 5 (HOUSEKEEPING-NOTES.md): logPaymentEvent/alignMilestonePayments/updateBookingMilestones
// moved to lib/payment-processing.js — see the require near the top of this file for the re-import.

// ==========================================
// Payment Return Pages (cosmetic — ITN is the real confirmation)
// ==========================================
// Fetch ITN Audit Logs for Admin
router.get('/api/bookings/:id/payment-logs', (req, res) => {
    if (!req.session || !req.session.adminId) {
        return res.status(401).json({ success: false, message: 'Unauthorized' });
    }
    getPaymentLogsForBooking(req.params.id, (err, rows) => {
        if (err) return res.status(500).json({ success: false, message: 'Database error fetching logs' });
        res.json({ success: true, logs: rows });
    });
});

// Phase 5 (HOUSEKEEPING-NOTES.md): deriveBookingStatusAfterPayment/processManualPayment moved to
// lib/payment-processing.js — see the require near the top of this file for the re-import.

router.get('/payment/success', (req, res) => {
    const bookingId = req.query.booking_id || '';
    res.send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Payment Successful | Thabiso Mhlongo</title>
<link rel="icon" href="images/icon.png" type="image/gif" sizes="16x16">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0e0e0e;color:#fff;font-family:Arial,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center;padding:20px}
.card{background:#161616;border:1px solid #2a2a2a;border-radius:16px;padding:50px 40px;max-width:480px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,0.5)}
.icon{font-size:64px;margin-bottom:20px;animation:pop 0.6s ease}
@keyframes pop{0%{transform:scale(0)}50%{transform:scale(1.2)}100%{transform:scale(1)}}
h2{color:#4CAF50;font-size:24px;margin-bottom:12px}
p{color:#aaa;font-size:15px;line-height:1.6;margin-bottom:8px}
.ref{color:#D4AF37;font-weight:bold;font-size:18px;margin:16px 0}
.note{color:#666;font-size:12px;margin-top:20px;padding-top:16px;border-top:1px solid #2a2a2a}
.btn{display:inline-block;margin-top:24px;padding:12px 30px;background:#D4AF37;color:#111;font-weight:bold;text-decoration:none;border-radius:6px;transition:all 0.2s}
.btn:hover{background:#d6d435;transform:translateY(-2px)}
</style></head><body>
<div class="card">
<div class="icon">✅</div>
<h2>Payment Received!</h2>
<p>Thank you for your payment. Your booking is being confirmed.</p>
${bookingId ? `<div class="ref">Booking #${bookingId.replace(/[^0-9]/g, '')}</div>` : ''}
<p>You will receive a confirmation email shortly with all the details.</p>
<a href="/index.html${bookingId ? '?track=' + bookingId.replace(/[^0-9]/g, '') + '&payment=success' : ''}" class="btn">Track My Booking</a>
<p class="note">This page is for your reference only. Payment verification happens securely in the background via PayFast.</p>
</div></body></html>`);
});

router.get('/payment/cancel', (req, res) => {
    const bookingId = req.query.booking_id || '';
    res.send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Payment Cancelled | Thabiso Mhlongo</title>
<link rel="icon" href="images/icon.png" type="image/gif" sizes="16x16">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0e0e0e;color:#fff;font-family:Arial,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center;padding:20px}
.card{background:#161616;border:1px solid #2a2a2a;border-radius:16px;padding:50px 40px;max-width:480px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,0.5)}
.icon{font-size:64px;margin-bottom:20px}
h2{color:#FF9800;font-size:24px;margin-bottom:12px}
p{color:#aaa;font-size:15px;line-height:1.6;margin-bottom:8px}
.btn{display:inline-block;margin-top:24px;padding:12px 30px;background:#D4AF37;color:#111;font-weight:bold;text-decoration:none;border-radius:6px;transition:all 0.2s;margin-right:10px}
.btn:hover{background:#d6d435;transform:translateY(-2px)}
.btn-outline{background:transparent;color:#D4AF37;border:2px solid #D4AF37}
.btn-outline:hover{background:#D4AF37;color:#111}
.note{color:#666;font-size:12px;margin-top:20px;padding-top:16px;border-top:1px solid #2a2a2a}
</style></head><body>
<div class="card">
<div class="icon">⚠️</div>
<h2>Payment Cancelled</h2>
<p>Your payment was not completed. No charges have been made.</p>
<p>You can try again at any time from the booking tracker.</p>
<div style="margin-top:24px">
<a href="/index.html${bookingId ? '?track=' + bookingId.replace(/[^0-9]/g, '') + '&payment=cancel' : ''}" class="btn">Try Again</a>
<a href="/index.html" class="btn btn-outline">Back to Homepage</a>
</div>
<p class="note">If you're experiencing issues with payment, please contact management directly.</p>
</div></body></html>`);
});

module.exports = router;
