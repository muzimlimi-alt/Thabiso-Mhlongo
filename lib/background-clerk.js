// Phase 5 (HOUSEKEEPING-NOTES.md): relocated from app.js verbatim — processNotificationQueue,
// checkStuckNotifications, and startBackgroundClerk (which wires all three, plus the Google
// Calendar hold sync, onto their intervals) moved together since they share the
// _notificationSweepRunning single-flight guard and startBackgroundClerk calls the other two
// directly. app.js still calls startBackgroundClerk() once, at the same module-load-time position.
const db = require('../database');
const moment = require('moment-timezone');
const emailComponents = require('../js/emailComponents');
const { sendEmail } = require('../js/emailService');
const { syncCalendarHolds } = require('./calendar-sync');
const { deleteGoogleEvent } = require('./google-calendar');
const { getNotificationEmail } = require('../database/repositories/settings.repository');
const {
    getBookingById,
    getStaleNewBookings, promoteBookingToPending, getConfirmedPaidPastEvents, markBookingAutoCompleted,
    getStalePendingBookings, expirePendingBooking, getOverdueQuotedBookings, expireQuotedBooking,
    clearBookingGoogleEventId, getQuotesExpiringTomorrow, markQuoteExpiryWarned,
    getPendingEnquiriesNearingExpiry, markPendingExpiryWarned, markBookingOverdueReminded,
} = require('../database/repositories/bookings.repository');
const { markInvoicePaidForAutoComplete } = require('../database/repositories/invoices-quotations.repository');
const { advanceAutoCompletedEventS6, getPastStandaloneEventsForAutoComplete, advanceStandaloneEventCompleted } = require('../database/repositories/calendar.repository');
const { sendQuoteExpiredEmail, sendPendingExpiredEmail } = require('./scheduled-job-emails');
const { sendBookingUnderReviewEmail, sendBookingCompletedEmail, sendAdminCompletionSummaryEmail, sendDepositBalanceDueEmail, sendQuoteExpiryWarningEmail } = require('./booking-notifications');

// Single-flight guard: a batch (attachments / slow SMTP) can take longer than the 20s
// setInterval, and two overlapping sweeps would double-send the same 'pending' rows. We serialize
// in-process because an intra-DB claim isn't available — the notifications.status CHECK constraint
// only permits ('pending','sent','failed','read','dismissed'), so the previous
// `SET status='sending'` flip always failed the CHECK (its error was ignored), leaving the
// double-send guard non-functional and sent_at never written.
let _notificationSweepRunning = false;
async function processNotificationQueue() {
    if (_notificationSweepRunning) return; // a prior sweep is still draining the queue
    _notificationSweepRunning = true;
    try {
        // Process up to 10 pending notifications
        const rows = await new Promise((resolve) => {
            db.all(
                `SELECT * FROM notifications
                 WHERE status = 'pending' AND channel = 'email'
                 AND (scheduled_at IS NULL OR scheduled_at <= datetime('now'))
                 LIMIT 10`,
                [],
                (err, r) => {
                    if (err) { console.error('[Notification Queue] Error fetching pending emails:', err.message); return resolve([]); }
                    resolve(r || []);
                }
            );
        });
        if (rows.length === 0) return;

        const { sendEmailDirectly } = require('../js/emailService');

        for (const row of rows) {
            let emailDetails = {};
            try {
                emailDetails = JSON.parse(row.body || '{}');
            } catch (e) {
                console.error(`[Notification Queue] Failed to parse body for notification #${row.id}:`, e.message);
                db.run("UPDATE notifications SET status = 'failed', error_message = ? WHERE id = ?", ['JSON_PARSE_ERROR: ' + e.message, row.id]);
                continue;
            }

            // Map attachment paths to standard nodemailer attachments array
            const attachments = [];
            if (row.attachment_paths) {
                try {
                    const paths = JSON.parse(row.attachment_paths);
                    paths.forEach(p => {
                        if (typeof p === 'string') {
                            const pathModule = require('path');
                            const resolvedPath = pathModule.isAbsolute(p) ? p : pathModule.join(__dirname, p);
                            const filename = pathModule.basename(p);
                            attachments.push({ filename, path: resolvedPath });
                        }
                    });
                } catch(e) {
                    console.error(`[Notification Queue] Failed to parse attachments for #${row.id}:`, e.message);
                }
            }

            try {
                const result = await sendEmailDirectly({
                    to: row.recipient_email,
                    subject: row.subject,
                    htmlContent: emailDetails.htmlContent,
                    plainTextAlternative: emailDetails.plainTextAlternative,
                    attachments: attachments,
                    fromName: row.recipient_name || emailDetails.fromName || "Thabiso Mhlongo Management",
                    replyTo: emailDetails.replyTo,
                    skipBrandAttachments: emailDetails.skipBrandAttachments,
                    titleOverride: emailDetails.titleOverride,
                    trigger_event: emailDetails.trigger_event || 'Notification Queue Dispatch',
                    preWrapped: emailDetails.preWrapped,
                    cc: emailDetails.cc,
                    bcc: emailDetails.bcc,
                    branding: emailDetails.branding
                });

                if (result.success) {
                    db.run("UPDATE notifications SET status = 'sent', sent_at = CURRENT_TIMESTAMP WHERE id = ?", [row.id]);
                    console.log(`✓ [Notification Queue] Successfully sent email #${row.id} to ${row.recipient_email}`);
                } else {
                    throw new Error(result.error || 'SMTP_SEND_FAILED');
                }
            } catch (sendErr) {
                console.error(`❌ [Notification Queue] Failed to send email #${row.id} to ${row.recipient_email}:`, sendErr.message);
                const newRetryCount = (row.retry_count || 0) + 1;
                const nextStatus = newRetryCount >= 3 ? 'failed' : 'pending';
                db.run(
                    "UPDATE notifications SET status = ?, retry_count = ?, error_message = ? WHERE id = ?",
                    [nextStatus, newRetryCount, sendErr.message.substring(0, 255), row.id]
                );
            }
        }
    } finally {
        _notificationSweepRunning = false;
    }
}

async function checkStuckNotifications() {
    db.get(
        `SELECT COUNT(*) AS count FROM notifications
         WHERE status IN ('pending', 'sending')
         AND datetime(created_at, '+10 minutes') < datetime('now')`,
        [],
        async (err, row) => {
            if (err) {
                console.error('[Background Clerk] Error checking stuck notifications:', err.message);
                return;
            }
            if (row && row.count > 0) {
                const count = row.count;
                db.all(
                    `SELECT id, recipient_email, subject, status, created_at FROM notifications
                     WHERE status IN ('pending', 'sending')
                     AND datetime(created_at, '+10 minutes') < datetime('now')
                     ORDER BY created_at DESC LIMIT 5`,
                    [],
                    async (err2, details) => {
                        const notifEmail = await getNotificationEmail();
                        const { sendEmailDirectly } = require('../js/emailService');
                        const body = emailComponents.renderSystemEmail({
                            preheaderText: `${count} notification(s) stuck in the queue for over 10 minutes.`,
                            category: 'System',
                            severity: 'alert',
                            leadFact: `There are <strong style="color:#FAFAFA;">${count}</strong> notification(s) stuck in the queue for more than 10 minutes.`,
                            bodyHtml: `<p style="margin:0; color:#E6E6E6;">This may indicate that the background queue processor is down, experiencing high latency, or has crashed.</p>`,
                            cards: (details || []).length ? [{
                                title: 'Stuck Notifications',
                                rows: (details || []).map(d => ({ label: `#${d.id} — ${d.status}`, value: `To ${d.recipient_email} · ${d.created_at}`, mono: false }))
                            }] : []
                        });

                        await sendEmailDirectly({
                            to: notifEmail,
                            subject: `⚠️ Alert: ${count} Stuck Notification(s) in Queue`,
                            htmlContent: body,
                            preWrapped: true,
                            titleOverride: 'Stuck Notification Alert',
                            trigger_event: 'System: Stuck Notification Alert',
                            skipBrandAttachments: true
                        }).catch(sendErr => console.error('[Background Clerk] Failed to send stuck notifications alert:', sendErr.message));
                    }
                );
            }
        }
    );
}

/**
 * Periodically cleans up expired holds and pending bookings
 */
function startBackgroundClerk() {
    console.log('Starting [Background Clerk] - Monitoring holds and expirations...');

    // Sync Google Calendar holds every 15 minutes
    setInterval(syncCalendarHolds, 15 * 60 * 1000);
    // Also run it immediately on start
    syncCalendarHolds();

    // Sweep and process asynchronous email queue every 20 seconds
    setInterval(processNotificationQueue, 20 * 1000);
    processNotificationQueue();

    // Check for stuck email notifications every 10 minutes
    setInterval(checkStuckNotifications, 10 * 60 * 1000);
    // Run once on startup after 30 seconds
    setTimeout(checkStuckNotifications, 30 * 1000);

    setInterval(() => {
      try {
        const nowLocal = moment().tz('Africa/Johannesburg').format('YYYY-MM-DD HH:mm:ss');
        const todayLocal = moment().tz('Africa/Johannesburg').format('YYYY-MM-DD');
        const tomorrowLocal = moment().tz('Africa/Johannesburg').add(1, 'day').format('YYYY-MM-DD');
        const overdueLimitLocal = moment().tz('Africa/Johannesburg').subtract(7, 'days').format('YYYY-MM-DD HH:mm:ss');

        // S0: Promote stale NEW bookings to PENDING after 24 hours with no admin action
        getStaleNewBookings(nowLocal, (err, rows) => {
            if (rows && rows.length > 0) {
                rows.forEach(row => {
                    promoteBookingToPending(row.id);
                    sendBookingUnderReviewEmail(row).catch(e => console.error(`[S0] Under-review email failed for #${row.id}:`, e.message));
                });
                console.log(`✓ [S0] Promoted ${rows.length} NEW booking(s) to PENDING after 24h.`);
            }
        });

        // S6: Auto-complete CONFIRMED fully-paid bookings whose event date has passed
        getConfirmedPaidPastEvents(todayLocal, (err, rows) => {
            if (rows && rows.length > 0) {
                rows.forEach(row => {
                    markBookingAutoCompleted(row.id);
                    if (row.event_id) {
                        advanceAutoCompletedEventS6(row.event_id, (e) => { if (e) console.error('[AutoComplete] Event advance failed:', e.message); });
                    }
                    // Parity with manual completion (applyStatusChange): also mark the linked invoice PAID
                    // and send the admin completion summary — not just the client completion email.
                    markInvoicePaidForAutoComplete(row.id,
                        (e) => { if (e) console.error('[S6] Invoice mark-paid failed:', e.message); });
                    sendBookingCompletedEmail(row).catch(e =>
                        console.error(`[S6] Completion email failed for #${row.id}:`, e.message)
                    );
                    getBookingById(row.id, (e, full) => {
                        if (!e && full) sendAdminCompletionSummaryEmail(full).catch(err => console.error(`[S6] Admin completion summary failed for #${row.id}:`, err.message));
                    });
                });
                console.log(`✓ [S6] Auto-completed ${rows.length} fully-paid past-event booking(s) (completion + admin summary emails sent).`);
            }
        });

        // S7: Auto-complete standalone public events (no linked booking) whose date has passed.
        // Booking-linked events already advance via S6 above - a standalone event (created directly
        // in the Events module) had no equivalent, so it could sit at "Upcoming" indefinitely after
        // the show had already happened, until an admin noticed and fixed it manually.
        getPastStandaloneEventsForAutoComplete(nowLocal, (err, rows) => {
            if (rows && rows.length > 0) {
                rows.forEach(row => {
                    advanceStandaloneEventCompleted(row.event_id);
                });
                console.log(`✓ [S7] Auto-completed ${rows.length} past standalone event(s).`);
            }
        });

        // 1. Expire unquoted PENDING bookings after 48 hours of inactivity
        getStalePendingBookings(nowLocal, (err, rows) => {
            if (rows && rows.length > 0) {
                rows.forEach(row => {
                    expirePendingBooking(row.id);
                    sendPendingExpiredEmail(row).catch(e => console.error(`Expiry email failed for booking #${row.id}:`, e.message));
                });
                console.log(`✓ Expired ${rows.length} inactive pending requests (clients notified).`);
            }
        });

        // 2. Expire QUOTED bookings after quote_expiry_date
        getOverdueQuotedBookings(todayLocal, (err, rows) => {
            if (rows && rows.length > 0) {
                rows.forEach(row => {
                    expireQuotedBooking(row.id);
                    // Null the local ID once we've asked Google to delete it — otherwise every future
                    // syncBookingToCalendar() for this booking takes the "already synced" update branch
                    // against an event that no longer exists on Google, fails, and never re-creates it.
                    if (row.google_event_id) {
                        deleteGoogleEvent(row.google_event_id);
                        clearBookingGoogleEventId(row.id);
                    }
                    sendQuoteExpiredEmail(row).catch(e => console.error(`Quote expiry email failed for booking #${row.id}:`, e.message));
                });
                console.log(`✓ Expired ${rows.length} overdue quotes (clients notified).`);
            }
        });

        // 3. Warn clients 24h before quote expires
        getQuotesExpiringTomorrow(tomorrowLocal, (err, rows) => {
            if (rows && rows.length > 0) {
                rows.forEach(row => {
                    markQuoteExpiryWarned(row.id);
                    sendQuoteExpiryWarningEmail(row).catch(e => console.error('Quote warning email failed:', e.message));
                });
            }
        });

        // 3b. Warn the ADMIN about PENDING enquiries about to auto-expire — the final window
        // before step 1 auto-EXPIRES them at 48h from creation. Prevents leads being silently
        // lost. One digest per enquiry (pending_expiry_warned flag stops hourly re-spam).
        getPendingEnquiriesNearingExpiry(nowLocal, async (err, rows) => {
            if (rows && rows.length > 0) {
                const notifEmail = await getNotificationEmail();
                rows.forEach(row => {
                    markPendingExpiryWarned(row.id);
                });
                const digestBody = emailComponents.renderSystemEmail({
                    preheaderText: `${rows.length} enquiry(ies) expiring within ~24 hours.`,
                    category: 'Booking Requests',
                    severity: 'action',
                    leadFact: `The following enquiries will <strong style="color:#FAFAFA;">auto-expire within the next ~24 hours</strong> unless a quote is sent — after which the client is notified their request lapsed.`,
                    bodyHtml: `<p style="margin:0; color:#E6E6E6;">Open the Bookings pipeline and send a quote to keep them alive.</p>`,
                    cards: [{
                        title: 'Expiring Enquiries',
                        rows: rows.map(r => ({ label: `#${r.id} — ${r.name}`, value: `${r.event_name || r.event_type || 'Event'}${r.date ? ' (event ' + r.date + ')' : ''}`, mono: false }))
                    }]
                });
                sendEmail({ to: notifEmail, subject: `Enquiries expiring soon – ${rows.length} pending request(s) need a quote`,
                    htmlContent: digestBody, preWrapped: true,
                    titleOverride: 'Enquiries Expiring Soon', trigger_event: 'Admin: Pending Expiry Warning' }).catch(() => {});
                console.log(`✓ [3b] Warned admin about ${rows.length} pending enquiry(ies) nearing auto-expiry.`);
            }
        });

        // 4. Overdue payment reminder (CONFIRMED, unpaid, event date passed)
        db.all(`SELECT b.*, COALESCE(c.email, b.email) as email, COALESCE(c.full_name, b.name) as name
                FROM bookings b LEFT JOIN clients c ON b.client_id = c.id
                WHERE b.status = 'CONFIRMED'
                AND b.payment_status NOT IN ('PAID')
                AND b.date < ?
                AND (b.overdue_reminded_at IS NULL OR b.overdue_reminded_at < ?)`, [todayLocal, overdueLimitLocal], async (err, rows) => {
            if (rows && rows.length > 0) {
                const notifEmail = await getNotificationEmail();
                rows.forEach(row => {
                    markBookingOverdueReminded(row.id);
                });
                const totalOverdue = rows.reduce((sum, r) => sum + parseFloat(r.amount_outstanding || 0), 0);
                const digestBody = emailComponents.renderSystemEmail({
                    preheaderText: `${rows.length} overdue booking(s), R${totalOverdue.toFixed(2)} outstanding.`,
                    category: 'Payments & Invoices',
                    severity: 'alert',
                    leadFact: `The following confirmed bookings have unpaid balances with past event dates.`,
                    cards: [{
                        title: 'Overdue Bookings',
                        rows: rows.map(r => ({ label: `#${r.id} — ${r.name}`, value: `R${parseFloat(r.amount_outstanding || 0).toFixed(2)} outstanding`, mono: false }))
                    }]
                });
                sendEmail({ to: notifEmail, subject: `Overdue Payments – ${rows.length} booking(s), R${totalOverdue.toFixed(2)} due`,
                    htmlContent: digestBody, preWrapped: true,
                    titleOverride: 'Overdue Payment Alert', trigger_event: 'Admin: Overdue Payment Digest' }).catch(() => {});
            }
        });

        // 5. Pre-event balance reminders: 7, 3, 1 days before event for CONFIRMED bookings with outstanding balance
        for (const daysBefore of [7, 3, 1]) {
            const targetStr = moment().tz('Africa/Johannesburg').add(daysBefore, 'days').format('YYYY-MM-DD');

            db.all(`SELECT b.id, COALESCE(c.full_name, b.name) as name, COALESCE(c.email, b.email) as email,
                           b.event_name, b.event_type, b.date, b.amount_outstanding, b.total_amount
                    FROM bookings b LEFT JOIN clients c ON b.client_id = c.id
                    WHERE b.status = 'CONFIRMED'
                      AND b.date = ?
                      AND b.amount_outstanding > 0.01`,
                [targetStr], (err, rows) => {
                    if (err || !rows || rows.length === 0) return;
                    rows.forEach(row => {
                        // Idempotency keyed on the table's real columns. This used to SELECT and INSERT a
                        // `reminder_type` column that does not exist on reminders_log — the SELECT errored,
                        // its callback saw no prior row, so the reminder was RE-SENT every hour, and the
                        // INSERT errored too so nothing was ever recorded. These are event-based (not tied
                        // to a payment_schedules milestone), so schedule_id is NULL and days_before (7/3/1)
                        // distinguishes them; the milestone reminders (which always carry a non-NULL
                        // schedule_id) can never collide with this key.
                        db.get("SELECT id FROM reminders_log WHERE booking_id = ? AND schedule_id IS NULL AND days_before = ?",
                            [row.id, daysBefore], (e, existing) => {
                                if (e) { console.error(`Balance-due reminder lookup failed for #${row.id}:`, e.message); return; }
                                if (existing) return; // already sent this window — do not re-send
                                sendDepositBalanceDueEmail(row, row.amount_outstanding)
                                    .then(() => {
                                        db.run("INSERT OR IGNORE INTO reminders_log (booking_id, schedule_id, days_before, due_date, amount_due, recipient_email, status) VALUES (?, NULL, ?, ?, ?, ?, 'sent')",
                                            [row.id, daysBefore, row.date, row.amount_outstanding, row.email],
                                            (insErr) => { if (insErr) console.error(`Balance-due reminder log failed for #${row.id}:`, insErr.message); });
                                        console.log(`✓ Balance-due reminder (${daysBefore}d) sent for booking #${row.id}`);
                                    })
                                    .catch(e => console.error(`Balance-due reminder failed for #${row.id}:`, e.message));
                            });
                    });
                }
            );
        }

        // Google Calendar holds synchronization is run outside this interval to prevent duplicate timers

      } catch (clerkErr) {
          console.error('[Background Clerk] Unhandled error in interval:', clerkErr.message);
      }
    }, 3600000); // Run every hour
}

module.exports = { startBackgroundClerk };
