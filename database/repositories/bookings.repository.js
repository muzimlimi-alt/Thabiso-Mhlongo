// Bookings domain repository — Phase 4 of the housekeeping effort (HOUSEKEEPING-NOTES.md).
// Covers bookings, booking_notes, booking_services, booking_line_items, booking_access_codes,
// booking_access_tokens. Every SQL string below is byte-identical to where it lived in server.js
// before this move. No req/res, no email sending, no PDF generation, no calendar calls.
//
// This is the largest and highest-risk domain in Phase 4 (~229 bookings-table statements alone,
// plus payment/calendar interleaving throughout) — being extracted in staged sub-passes, each
// verified with the full test suite + smoke test before the next. See HOUSEKEEPING-NOTES.md for
// the staging plan and the running list of cross-domain statements left in server.js.
//
// BOOKING_DELETE_PURGE / BOOKING_DELETE_UNLINK (server.js, DELETE /api/admin/bookings/:id) are
// deliberately NOT touched — a hand-ordered, FK-constraint-sensitive cascade array; splitting it
// across domain repositories risks reintroducing the exact bugs its comments describe fixing.
const db = require('../../database');

function promised(sql, params) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function (err) { err ? reject(err) : resolve(this); });
    });
}
function promisedGet(sql, params) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => err ? reject(err) : resolve(row));
    });
}
function promisedAll(sql, params) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows));
    });
}

// "SELECT * FROM bookings WHERE id = ?" is the single most common statement in this domain —
// 41 byte-identical occurrences across both callback style (db.get + callback) and promise style
// (the shared dbGet wrapper). Two functions, not a conversion of either style into the other.
function getBookingById(id, callback) {
    db.get("SELECT * FROM bookings WHERE id = ?", [id], callback);
}
function getBookingByIdAsync(id) {
    return new Promise((resolve, reject) => {
        db.get("SELECT * FROM bookings WHERE id = ?", [id], (err, row) => err ? reject(err) : resolve(row));
    });
}

// ══════════════════════════════════════════════════════════════════════════
// Stage 1 — Reporting / analytics (read-only). Most reporting queries here
// join across domains by nature (a financial report needs bookings+transactions
// etc.) and stay in server.js as cross-domain statements; only the handful of
// genuinely single-table ones below moved.
// ══════════════════════════════════════════════════════════════════════════
function getBookingsTrend(start, end, callback) {
    db.all(`
        SELECT
            date(created_at)  AS label,
            COUNT(*)          AS bookings,
            SUM(CASE WHEN status IN ('CONFIRMED','COMPLETED','QUOTED','ACCEPTED') THEN 1 ELSE 0 END) AS confirmed
        FROM bookings
        WHERE date(created_at) BETWEEN ? AND ?
        GROUP BY label
        ORDER BY label ASC`,
        [start, end], callback);
}
function stampReviewEmailSent(bookingId, callback) {
    db.run("UPDATE bookings SET review_email_sent_at = CURRENT_TIMESTAMP WHERE id = ?", [bookingId], callback);
}
function unlinkBookingClient(bookingId, callback) {
    db.run("UPDATE bookings SET client_id = NULL WHERE id = ?", [bookingId], callback);
}
// Was duplicated identically in payment-schedules POST and .../rebalance.
function getBookingTotalAmount(bookingId, callback) {
    db.get('SELECT total_amount FROM bookings WHERE id = ?', [bookingId], callback);
}
// Allowlist, not a denylist. Booking intake writes amount_outstanding = the service catalogue
// estimate on a NEW booking that has never been quoted, so a bare "NOT IN ('CANCELLED','EXPIRED')"
// counted every unsubmitted enquiry as a receivable — an hourly MC enquiry silently added R2 950.
// A quote that has been sent but not accepted (QUOTED) is not a receivable either. Only an
// accepted commitment is money owed.
function getOutstandingTotal(callback) {
    db.get(`
        SELECT COALESCE(SUM(amount_outstanding), 0) AS total_outstanding
        FROM bookings
        WHERE status IN ('ACCEPTED', 'CONFIRMED', 'COMPLETED')
    `, [], callback);
}
// Soft-declined leads (disposition 'not_a_fit'/'archived') are excluded from the active pipeline
// funnel — they were never a live deal, so counting them would inflate/distort conversion math
// the same way a raw status overload would have (see BOOKING_DISPOSITIONS in server.js).
function getBookingStatusCounts(callback) {
    db.get(`
        SELECT
            COUNT(CASE WHEN status = 'PENDING'   THEN 1 END) AS pending_count,
            COUNT(CASE WHEN status = 'QUOTED'    THEN 1 END) AS quoted_count,
            COUNT(CASE WHEN status = 'CONFIRMED' THEN 1 END) AS confirmed_count
        FROM bookings
        WHERE status NOT IN ('CANCELLED', 'EXPIRED')
          AND (disposition = 'active' OR disposition IS NULL)
    `, [], callback);
}

// ══════════════════════════════════════════════════════════════════════════
// Stage 2 — Background cron jobs (startBackgroundClerk() + named run*Job() functions).
// Every job here fans out to email sends per matched row — only the SELECT-candidates /
// mark-handled UPDATE statements moved; the email loop and any cross-domain (events/invoices/
// clients-joined) statement stayed in server.js exactly where it was.
// ══════════════════════════════════════════════════════════════════════════

// S0: promote stale NEW bookings to PENDING after 24h with no admin action.
function getStaleNewBookings(nowLocal, callback) {
    db.all(`SELECT id, name, email, event_name, event_type, date FROM bookings
            WHERE status = 'NEW'
            AND datetime(created_at, '+24 hours') < ?`, [nowLocal], callback);
}
function promoteBookingToPending(bookingId) {
    db.run(`UPDATE bookings SET status='PENDING', pending_at=CURRENT_TIMESTAMP WHERE id=?`, [bookingId]);
}
// S6: auto-complete CONFIRMED fully-paid bookings whose event date has passed.
function getConfirmedPaidPastEvents(todayLocal, callback) {
    db.all(`SELECT id, event_id, name, email, event_name, event_type, date, event_location,
                   total_amount, amount_paid, quote_amount
            FROM bookings
            WHERE status = 'CONFIRMED'
            AND payment_status = 'PAID'
            AND date < ?`, [todayLocal], callback);
}
function markBookingAutoCompleted(bookingId) {
    db.run(`UPDATE bookings SET status='COMPLETED', completed_at=CURRENT_TIMESTAMP WHERE id=?`, [bookingId]);
}
// 1. Expire unquoted PENDING bookings after 48h of inactivity.
function getStalePendingBookings(nowLocal, callback) {
    db.all(`SELECT id, name, email, event_name, event_type, date FROM bookings
            WHERE status = 'PENDING'
            AND datetime(created_at, '+48 hours') < ?`, [nowLocal], callback);
}
function expirePendingBooking(bookingId) {
    db.run(`UPDATE bookings SET status = 'EXPIRED', message = COALESCE(message,'') || '\n[System: Expired due to 48h inactivity]' WHERE id = ?`, [bookingId]);
}
// 2. Expire QUOTED bookings after quote_expiry_date.
function getOverdueQuotedBookings(todayLocal, callback) {
    db.all(`SELECT id, google_event_id, name, email, event_name, event_type, date FROM bookings
            WHERE status = 'QUOTED'
            AND quote_expiry_date < ?`, [todayLocal], callback);
}
function expireQuotedBooking(bookingId) {
    db.run("UPDATE bookings SET status = 'EXPIRED' WHERE id = ?", [bookingId]);
}
function clearBookingGoogleEventId(bookingId) {
    db.run("UPDATE bookings SET google_event_id = NULL WHERE id = ?", [bookingId]);
}
// 3. Warn clients 24h before quote expires.
function getQuotesExpiringTomorrow(tomorrowLocal, callback) {
    db.all(`SELECT id, name, email, event_name, event_type, date, quote_expiry_date
            FROM bookings WHERE status = 'QUOTED'
            AND date(quote_expiry_date) = ?
            AND quote_expiry_warned IS NULL`, [tomorrowLocal], callback);
}
function markQuoteExpiryWarned(bookingId) {
    db.run("UPDATE bookings SET quote_expiry_warned = CURRENT_TIMESTAMP WHERE id = ?", [bookingId]);
}
// 3b. Warn the admin about PENDING enquiries about to auto-expire.
function getPendingEnquiriesNearingExpiry(nowLocal, callback) {
    db.all(`SELECT id, name, email, event_name, event_type, date FROM bookings
            WHERE status = 'PENDING'
            AND datetime(created_at, '+24 hours') < ?
            AND datetime(created_at, '+48 hours') > ?
            AND pending_expiry_warned IS NULL`, [nowLocal, nowLocal], callback);
}
function markPendingExpiryWarned(bookingId) {
    db.run("UPDATE bookings SET pending_expiry_warned = CURRENT_TIMESTAMP WHERE id = ?", [bookingId]);
}
// 4. Overdue payment reminder — mark-reminded UPDATE only; the SELECT joins `clients` and stays
// in server.js as a cross-domain statement.
function markBookingOverdueReminded(bookingId) {
    db.run("UPDATE bookings SET overdue_reminded_at = CURRENT_TIMESTAMP WHERE id = ?", [bookingId]);
}

// runQuoteFollowUpJob()
function getBookingsForQuoteFollowUp(cutoffStr, callback) {
    db.all(`SELECT id, name, email, event_type, date, quote_amount, quote_expiry_date
            FROM bookings
            WHERE status = 'QUOTED'
              AND DATE(quoted_at) <= ?
              AND quote_follow_up_sent_at IS NULL
              AND (quote_expiry_date IS NULL OR quote_expiry_date > DATE('now'))`,
        [cutoffStr], callback);
}
function markQuoteFollowUpSent(bookingId) {
    db.run("UPDATE bookings SET quote_follow_up_sent_at = CURRENT_TIMESTAMP WHERE id = ?", [bookingId]);
}
// runAbandonedBookingReminderJob() — defensive check that a real booking hasn't since been made
// for the same email+date before sending a recovery-nudge email for an abandoned draft.
function findActiveBookingByEmailAndDate(email, date, callback) {
    db.get(`SELECT id FROM bookings WHERE lower(email)=lower(?) AND date=? AND status NOT IN ('CANCELLED','EXPIRED') LIMIT 1`,
        [email, date], callback);
}
// runDepositBalanceReminderJob()
function getBookingsForDepositBalanceReminder(targetDate, callback) {
    db.all(
        `SELECT id, name, email, event_name, event_type, date AS event_date,
                amount_outstanding, total_amount, deposit_balance_reminded_at
         FROM bookings
         WHERE payment_status = 'DEPOSIT_PAID'
           AND status = 'CONFIRMED'
           AND date IS NOT NULL AND date <= ?
           AND (deposit_balance_reminded_at IS NULL
                OR deposit_balance_reminded_at < DATE('now', '-7 days'))`,
        [targetDate], callback);
}
function markDepositBalanceReminded(bookingId) {
    db.run("UPDATE bookings SET deposit_balance_reminded_at = CURRENT_TIMESTAMP WHERE id = ?", [bookingId]);
}
// runEventReminderJob()
function getConfirmedBookingsOnDate(targetStr, callback) {
    db.all(
        `SELECT id, name, email, event_name, event_type, date, event_location
         FROM bookings
         WHERE status = 'CONFIRMED'
           AND date = ?
           AND event_reminder_sent_at IS NULL`,
        [targetStr], callback);
}
function markEventReminderSent(bookingId) {
    db.run("UPDATE bookings SET event_reminder_sent_at = CURRENT_TIMESTAMP WHERE id = ?", [bookingId]);
}
// runPostEventFollowupJob() — the mark-sent half already shares stampReviewEmailSent() above.
function getCompletedBookingsAwaitingReview(callback) {
    db.all(`SELECT b.*, b.name AS name, b.email AS email
            FROM bookings b
            WHERE b.status = 'COMPLETED'
              AND b.review_email_sent_at IS NULL
              AND date(b.date) <= date('now', '-1 day')`,
        [], callback);
}

// ══════════════════════════════════════════════════════════════════════════
// Stage 3 — Admin CRUD/status routes (minus applyStatusChange()'s core cascade and
// POST .../cancel, both deferred to the payment/ledger stage since they cascade
// invoices/payment_schedules/refunds) + legacy one-off tooling.
// ══════════════════════════════════════════════════════════════════════════

// POST /api/admin/bookings (admin manual create) — duplicate-check, pre-lock (callback style,
// wrapped in the route's own `new Promise`) and post-lock (promise style, was `dbGet`) variants.
function getActiveDuplicateBookingForEmailDate(email, date, callback) {
    db.get(
        `SELECT id FROM bookings
         WHERE lower(email) = lower(?) AND date = ? AND status NOT IN ('CANCELLED','EXPIRED')
         LIMIT 1`,
        [email, date], callback);
}
function getActiveDuplicateBookingForEmailDateAsync(email, date) {
    return promisedGet(
        `SELECT id FROM bookings
         WHERE lower(email) = lower(?) AND date = ? AND status NOT IN ('CANCELLED','EXPIRED')
         LIMIT 1`,
        [email, date]);
}
// The INSERT itself — 29 positional values, passed straight through in the same order as the
// original VALUES clause (documented at the call site, not renamed here to avoid a 29-parameter
// signature that's harder to keep in sync than the positional array already was).
function insertAdminBooking(values) {
    return promised(
        `INSERT INTO bookings
            (name, company, email, cell, event_name, date, event_start_time, performance_start_time,
             performance_end_time, performance_duration,
             event_type, event_location, city, venue_place_id, budget_range, message, status,
             popia_consent, consent_timestamp, client_id, venue_id,
             quote_amount, total_amount, amount_outstanding, payment_status, quote_expiry_date, policy_version, source, consent_source, source_inquiry_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP,?,?,?,?,?,?,?,?,?, 'admin_recorded', ?)`,
        values);
}

// POST /api/admin/bookings/:id/reopen
function getBookingStatusNameEmail(id, callback) {
    db.get("SELECT id, status, name, email FROM bookings WHERE id = ?", [id], callback);
}
function reopenBooking(bookingId, callback) {
    db.run(
        `UPDATE bookings SET status = 'PENDING', quote_amount = NULL, quote_details = NULL, quote_expiry_date = NULL, quoted_at = NULL WHERE id = ?`,
        [bookingId], callback);
}
// POST /api/admin/bookings/:id/book-again — the SELECT reuses getBookingById (same callback shape).
function insertBookAgainBooking(values, callback) {
    db.run(
        `INSERT INTO bookings (
            name, company, email, cell,
            event_name, date, event_start_time, performance_slot, performance_duration,
            event_location, venue_address, city, country, venue_type,
            event_type, audience_size, audience_demographic, budget_range,
            travel_accommodation, message,
            status, payment_status, rebooked_from_id, created_at
         ) VALUES (
            ?, ?, ?, ?,
            ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?,
            ?, ?, ?, ?,
            ?, ?,
            'NEW', 'UNPAID', ?, CURRENT_TIMESTAMP
         )`,
        values, callback);
}
// POST /api/admin/bookings/:id/complete — the SELECT reuses getBookingById. This UPDATE's spacing
// around "=" differs from markBookingAutoCompleted's cron-job version, so it's byte-distinct, not
// a duplicate to consolidate.
function markBookingCompletedManual(bookingId, callback) {
    db.run("UPDATE bookings SET status = 'COMPLETED', completed_at = CURRENT_TIMESTAMP WHERE id = ?", [bookingId], callback);
}
// PATCH /api/admin/bookings/:id/buffer
function updateBookingBuffer(mins, id, callback) {
    db.run("UPDATE bookings SET buffer_minutes = ? WHERE id = ?", [mins, id], callback);
}
// PUT /api/admin/bookings/:id/disposition
function getBookingDisposition(id, callback) {
    db.get("SELECT disposition FROM bookings WHERE id = ?", [id], callback);
}
function updateBookingDisposition(disposition, bookingId, callback) {
    db.run("UPDATE bookings SET disposition = ? WHERE id = ?", [disposition, bookingId], callback);
}
// POST /api/admin/bookings/:id/respond
function markBookingPendingAfterRespond(bookingId, callback) {
    db.run("UPDATE bookings SET status = 'PENDING' WHERE id = ?", [bookingId], callback);
}
// Legacy POST /send-email — the sibling 'isBooking' branch of what the inquiries domain already
// extracted for this same route's inquiry branch.
function insertLegacyBookingFromContactForm(name, email, cell, category, messageText, callback) {
    db.run(`INSERT INTO bookings (name, email, cell, date, event_type, message, status, popia_consent, consent_timestamp) VALUES (?, ?, ?, ?, ?, ?, 'PENDING', 1, CURRENT_TIMESTAMP)`,
        [name, email, cell, 'TBD', category, messageText], callback);
}
// Legacy migration tooling (POST /api/admin/migrate, POST /api/admin/system/migrate-legacy-data)
function getAllBookingsForMigration(callback) {
    db.all("SELECT id, name, company, email, cell, event_location, venue_address, date FROM bookings", [], callback);
}
function getAllBookingsFull(callback) {
    db.all("SELECT * FROM bookings", [], callback);
}
// Byte-identical across both legacy migration routes.
function updateBookingClientVenue(clientId, venueId, bookingId, callback) {
    db.run("UPDATE bookings SET client_id = ?, venue_id = ? WHERE id = ?", [clientId, venueId, bookingId], callback);
}
// DELETE /api/admin/bookings/:id — the pre-cascade SELECT reuses getBookingByIdAsync; this is only
// the route's own final row-delete, OUTSIDE BOOKING_DELETE_PURGE/BOOKING_DELETE_UNLINK (see file
// header — those two arrays are deliberately not touched).
function deleteBookingById(id) {
    return promised("DELETE FROM bookings WHERE id = ?", [id]);
}

// ══════════════════════════════════════════════════════════════════════════
// Stage 4 — Quote / invoice / contract / advancing-pack generation. These functions do heavy
// PDF generation and email sending in server.js — only their bookings-table SQL moved.
// ══════════════════════════════════════════════════════════════════════════

// generateInvoice() — the booking fetch itself joins `clients` and stays in server.js.
function setBookingClientId(clientId, bookingId, callback) {
    db.run("UPDATE bookings SET client_id = ? WHERE id = ?", [clientId, bookingId], callback);
}
// Inside generateInvoice()'s own transaction — participates via the shared `db` connection.
function updateBookingLedgerAfterInvoice(total, amountOutstanding, bookingId) {
    return promised(
        "UPDATE bookings SET total_amount = ?, amount_outstanding = ?, payment_status = CASE WHEN payment_status IS NULL THEN 'UNPAID' ELSE payment_status END WHERE id = ?",
        [total, amountOutstanding, bookingId]);
}

// POST /api/admin/bookings/:id/quote — the booking fetch (joins clients), the services-catalog
// lookups and the payment_schedules/invoices/contracts re-quote cascade all stay in server.js
// (cross-domain). Only the bookings-table status/total UPDATE, and this same transaction's
// booking_services/booking_line_items refresh (this domain's own satellite tables), moved.
function updateBookingAfterQuote(quote_amount, quote_details, quote_expiry_date, nextStatus, finalTotal, newOutstanding, bookingId) {
    return promised(
        "UPDATE bookings SET quote_amount = ?, quote_details = ?, quote_expiry_date = ?, status = ?, quoted_at = CURRENT_TIMESTAMP, total_amount = ?, amount_outstanding = ? WHERE id = ?",
        [quote_amount, quote_details, quote_expiry_date, nextStatus, finalTotal, newOutstanding, bookingId]);
}
function deleteBookingLineItems(bookingId) {
    return promised("DELETE FROM booking_line_items WHERE booking_id = ?", [bookingId]);
}
function deleteBookingServices(bookingId) {
    return promised("DELETE FROM booking_services WHERE booking_id = ?", [bookingId]);
}
function insertBookingLineItem(bookingId, serviceId, description, quantity, unitPrice) {
    return promised("INSERT INTO booking_line_items (booking_id, service_id, description, quantity, unit_price) VALUES (?, ?, ?, ?, ?)",
        [bookingId, serviceId, description, quantity, unitPrice]);
}
function insertBookingService(bookingId, serviceId, quantityMinutes, unitPrice, totalPrice) {
    return promised("INSERT INTO booking_services (booking_id, service_id, quantity_minutes, unit_price, total_price) VALUES (?, ?, ?, ?, ?)",
        [bookingId, serviceId, quantityMinutes, unitPrice, totalPrice]);
}

// POST /api/admin/bookings/:id/contract (upload) — the eligibility check.
function getBookingStatus(id, callback) {
    db.get("SELECT status FROM bookings WHERE id = ?", [id], callback);
}
// POST /api/admin/bookings/:id/contract/remind
function getBookingForContractRemind(id, callback) {
    db.get(`SELECT id, name, email, event_name, date FROM bookings WHERE id = ?`, [id], callback);
}
// PUT /api/admin/bookings/:id/advancing
function getBookingIdStatusAsync(id) {
    return promisedGet("SELECT id, status FROM bookings WHERE id = ?", [id]);
}

// ══════════════════════════════════════════════════════════════════════════
// Stage 5 — Venue & calendar-adjacent booking routes, and events-domain routes that touch
// bookings via JOIN. date_holds and events are separate domains (not yet extracted) — every
// date_holds/events/venues statement inside these mixed functions stays in server.js; only the
// bookings-table statements below moved.
// ══════════════════════════════════════════════════════════════════════════

// hasCalendarConflict() — the date_holds half of its conflict check stays in server.js.
// excludeClause is one of two hardcoded literals (' AND id != ?' or ''), assembled in server.js.
function getBookingsOnDateForCalendarConflict(excludeClause, params, callback) {
    db.all(
        `SELECT event_start_time, performance_end_time, performance_duration, event_type, buffer_minutes
         FROM bookings
         WHERE date = ? AND status NOT IN ('CANCELLED','EXPIRED')${excludeClause}`,
        params, callback);
}
// syncBookingToCalendar() — the booking_services/services JOIN (cross-domain) stays in server.js.
function setBookingGoogleEventId(eventId, bookingId) {
    db.run("UPDATE bookings SET google_event_id = ? WHERE id = ?", [eventId, bookingId]);
}
// syncCalendarHolds() — every date_holds and events statement in this function stays in
// server.js; this is its only bookings-table statement. Never rejects (matches the original
// inline `new Promise((resolve) => ...)` which always resolves, defaulting to []).
function getBookingsWithGoogleEventIdAsync() {
    return new Promise((resolve) => {
        db.all("SELECT google_event_id FROM bookings WHERE google_event_id IS NOT NULL", [], (err, rows) => resolve(rows || []));
    });
}
// checkDateAvailability() — the date_holds and events checks stay in server.js.
function getBookingsOnDateForAvailability(excludeClause, bookingParams, callback) {
    db.all(
        `SELECT event_start_time, performance_end_time, performance_duration
         FROM bookings WHERE date = ? AND status NOT IN ('CANCELLED', 'EXPIRED')${excludeClause}`,
        bookingParams, callback);
}
// findHoldDateConflict() — the date_holds half stays in server.js.
function getBookingsOnDateForHoldConflict(date, callback) {
    db.all("SELECT id, event_start_time, performance_end_time, performance_duration, event_type, buffer_minutes FROM bookings WHERE date = ? AND status NOT IN ('CANCELLED', 'EXPIRED')", [date], callback);
}
// checkEventConflicts() — the date_holds and events halves stay in server.js.
function getBookingsOnDateForEventConflict(eventDateStr, excludeId, callback) {
    db.all(
        `SELECT id, event_start_time, performance_end_time, performance_duration
         FROM bookings
         WHERE date = ? AND status != 'CANCELLED' AND (event_id IS NULL OR event_id != ?)`,
        [eventDateStr, excludeId], callback);
}

// PUT /api/admin/bookings/:id/venue — unlink branch. The events UPDATE that follows it stays in
// server.js (events domain).
function updateBookingVenueUnlink(bookingId, callback) {
    db.run(
        `UPDATE bookings SET
            venue_id = NULL, venue_place_id = NULL, venue_address = NULL,
            city = NULL, country = NULL, modified_on = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [bookingId], callback);
}
// PUT .../venue (link, legacy venue_id path) and PUT .../venue-google both run an
// otherwise-similar UPDATE, but at different nesting depth in server.js (different multi-line
// whitespace) — byte-distinct, so kept as two functions rather than consolidated, same as
// markBookingCompletedManual/markBookingAutoCompleted in Stage 3.
function updateBookingVenueLinkLegacy(venueId, placeId, location, address, city, country, bookingId, callback) {
    db.run(
        `UPDATE bookings SET
            venue_id = ?, venue_place_id = ?, event_location = ?,
            venue_address = ?, city = ?, country = ?,
            modified_on = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [venueId, placeId, location, address, city, country, bookingId], callback);
}
// PUT .../venue-google. See updateBookingVenueLinkLegacy comment above re: not consolidating.
function updateBookingVenueGoogle(venueId, placeId, location, address, city, country, bookingId, callback) {
    db.run(
        `UPDATE bookings SET
            venue_id = ?, venue_place_id = ?, event_location = ?,
            venue_address = ?, city = ?, country = ?,
            modified_on = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [venueId, placeId, location, address, city, country, bookingId], callback);
}
// Shared by the venue unlink/link/venue-google routes above (3 byte-identical call sites).
function getBookingEventId(bookingId, callback) {
    db.get("SELECT event_id FROM bookings WHERE id = ?", [bookingId], callback);
}
// PATCH /api/admin/bookings/:id/venue (free-text venue editor).
function updateBookingVenueFreeText(location, address, city, country, venueType, bookingId, callback) {
    db.run(
        `UPDATE bookings SET event_location = ?, venue_address = ?, city = ?, country = ?,
         venue_type = ?, modified_on = CURRENT_TIMESTAMP WHERE id = ?`,
        [location, address, city, country, venueType, bookingId], callback);
}

// PATCH /api/admin/bookings/:id/date — dynamic SET clause (event_start_time/performance fields
// only included when `time` was supplied); setClauses/params are still assembled in server.js
// from other business logic (quote-expiry recalculation, buffer math) — only the db.run itself,
// with its already-built clause string and params array, moved.
function updateBookingDateAndTimeFields(setClausesSql, params) {
    return new Promise((resolve, reject) =>
        db.run(`UPDATE bookings SET ${setClausesSql} WHERE id = ?`, params, err => err ? reject(err) : resolve()));
}

// PUT /api/admin/events/:id and PATCH /api/admin/events/:id/date both fetch the linked booking
// via this exact never-rejects pattern (resolves null on error) before re-checking calendar
// conflicts — distinct from getBookingByIdAsync (which rejects on a DB error).
function getBookingByIdSafeAsync(id) {
    return new Promise((resolve) => {
        db.get("SELECT * FROM bookings WHERE id = ?", [id], (err, row) => resolve(err ? null : row));
    });
}

// PUT /api/admin/bookings/:id/public — promote/demote. The events INSERT/UPDATE/DELETE and the
// venues-joined lookup/preview SELECTs all stay in server.js (events/venues domains).
function setBookingPublicWithNewEvent(ticketLink, eventId, bookingId, callback) {
    db.run("UPDATE bookings SET is_public = 1, ticket_link = ?, event_id = ? WHERE id = ?", [ticketLink, eventId, bookingId], callback);
}
function setBookingPublicTicketLink(ticketLink, bookingId, callback) {
    db.run("UPDATE bookings SET is_public = 1, ticket_link = ? WHERE id = ?", [ticketLink, bookingId], callback);
}
function clearBookingPublicWithEvent(bookingId, callback) {
    db.run("UPDATE bookings SET is_public = 0, ticket_link = NULL, event_id = NULL WHERE id = ?", [bookingId], callback);
}
function clearBookingPublicTicketLink(bookingId, callback) {
    db.run("UPDATE bookings SET is_public = 0, ticket_link = NULL WHERE id = ?", [bookingId], callback);
}

// POST /api/admin/events and PUT /api/admin/events/:id both link the event back onto its
// booking with this exact fire-and-forget statement (2 byte-identical call sites, neither
// passes a callback).
// Stage 6 (applyStatusChange, CONFIRMED branch) added a 3rd call site that needs an error-logging
// callback, unlike the first two (fire-and-forget) — callback defaults to undefined, so those two
// call unchanged (db.run treats a missing/undefined 3rd arg the same as not passing one).
function setBookingEventId(eventId, bookingId, callback) {
    db.run("UPDATE bookings SET event_id = ? WHERE id = ?", [eventId, bookingId], callback);
}
// POST /api/admin/events, block_type==='booking' — creates a placeholder booking for a
// calendar-only block. The reverse events.booking_id write-back (using the callback's `this`)
// stays in server.js, unchanged; the callback is passed through here so sqlite3's `this` binding
// on it is preserved.
function insertPlaceholderBookingForEvent(values, callback) {
    db.run("INSERT INTO bookings (name, email, cell, date, event_name, event_location, event_type, message, status, event_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        values, callback);
}
// PUT /api/admin/events/:id — sync the booking's date/time when the event's event_datetime
// changed. Same dynamic-suffix technique as the original inline call.
function updateBookingDateFromEventEdit(datePart, timePart, bookingId) {
    db.run("UPDATE bookings SET date = ?" + (timePart ? ", event_start_time = ?" : "") + " WHERE id = ?",
        timePart ? [datePart, timePart, bookingId] : [datePart, bookingId]);
}
// DELETE /api/admin/events/:id — null out the booking's event_id before the event row is deleted.
function clearBookingEventIdWhereEventId(eventId, callback) {
    db.run("UPDATE bookings SET event_id = NULL WHERE event_id = ?", [eventId], callback);
}
// PATCH /api/admin/events/:id/date — drag-reschedule of a booking-linked public event.
function setBookingDateAndStartTimeFromEvent(date, startTime, bookingId, callback) {
    db.run("UPDATE bookings SET date = ?, event_start_time = ? WHERE id = ?", [date, startTime, bookingId], callback);
}

// ══════════════════════════════════════════════════════════════════════════
// Satellite-table catalog (booking_notes, booking_access_codes, booking_access_tokens,
// booking_line_items) + two core `bookings`-table statements found while reading through the
// POPIA-erasure functions for the satellite pass (resolvePopiaTargets/anonymizeClientData) that
// hadn't been caught by any earlier stage. Every booking_services/booking_line_items statement
// that JOINs `services` (a separate, not-yet-extracted domain) stays in server.js — see
// getCompletedBookingsAwaitingReview-style comments above for the same pattern elsewhere in this
// file. BOOKING_DELETE_PURGE's own DELETEs against these same tables are never touched (file header).
// ══════════════════════════════════════════════════════════════════════════

// resolvePopiaTargets() — the clients/inquiries halves stay in server.js (clients.repository.js
// doesn't exist yet; inquiries already uses the analogous getInquiryIdsForEmail()).
function getBookingIdsForEmail(email) {
    return promisedAll(`SELECT id FROM bookings WHERE LOWER(email) = LOWER(?)`, [email]);
}
// anonymizeClientData() — this booking anonymize UPDATE.
function anonymizeBookingsForErasure(email) {
    return promised(`UPDATE bookings SET
            name = 'POPIA ANONYMIZED', company = NULL, email = 'deleted-' || id || '@po-pia.com',
            cell = '0000000000', message = 'Content removed per deletion request.'
            WHERE LOWER(email) = LOWER(?)`, [email]);
}
// anonymizeClientData() — booking_access_codes/booking_access_tokens are short-lived tracker
// secrets with nothing to preserve, so these are hard deletes rather than anonymizing UPDATEs.
function deleteBookingAccessCodesForErasure(email) {
    return promised(`DELETE FROM booking_access_codes WHERE LOWER(email) = LOWER(?)`, [email]);
}
function deleteBookingAccessTokensForErasure(email) {
    return promised(`DELETE FROM booking_access_tokens WHERE LOWER(email) = LOWER(?)`, [email]);
}
function redactBookingNotesForErasure(bookingPh, bookingIds) {
    return promised(`UPDATE booking_notes SET note = '[Redacted per POPIA erasure request]' WHERE booking_id IN (${bookingPh})`, bookingIds);
}
// GET /api/admin/popia/requests/:id preview — the sibling of countInquiryNotesForIds() in
// inquiries.repository.js, called from the same Promise.all().
function countBookingNotesForIds(bookingPh, bookingIds) {
    return promisedGet(`SELECT COUNT(*) AS c FROM booking_notes WHERE booking_id IN (${bookingPh})`, bookingIds);
}

// requireBookingAccessToken() middleware.
function getBookingAccessTokenByHash(tokenHash, bookingId, callback) {
    db.get(
        "SELECT id, email FROM booking_access_tokens WHERE token_hash = ? AND booking_id = ? AND expires_at > CURRENT_TIMESTAMP",
        [tokenHash, bookingId], callback);
}
function touchBookingAccessToken(tokenId) {
    db.run("UPDATE booking_access_tokens SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?", [tokenId]);
}
// POST /api/public/bookings/:id/track/request-code
function getBookingEmailForTracking(bookingId, callback) {
    db.get("SELECT id, email, event_name, event_type FROM bookings WHERE id = ?", [bookingId], callback);
}
function consumeUnconsumedAccessCodes(bookingId) {
    return promised("UPDATE booking_access_codes SET consumed = 1 WHERE booking_id = ? AND consumed = 0", [bookingId]);
}
function insertBookingAccessCode(bookingId, email, codeHash, expiresAt) {
    return promised("INSERT INTO booking_access_codes (booking_id, email, code_hash, expires_at) VALUES (?, ?, ?, ?)",
        [bookingId, email, codeHash, expiresAt]);
}
// POST /api/public/bookings/:id/track/verify-code
function getActiveAccessCodeForVerification(bookingId, email) {
    return promisedGet(
        `SELECT id, code_hash, attempts FROM booking_access_codes
         WHERE booking_id = ? AND lower(email) = lower(?) AND consumed = 0 AND expires_at > CURRENT_TIMESTAMP
         ORDER BY created_at DESC LIMIT 1`,
        [bookingId, email]);
}
// Shared by 2 byte-identical call sites in verify-code (max-attempts lockout, and post-match consume).
function consumeAccessCodeById(codeId) {
    return promised("UPDATE booking_access_codes SET consumed = 1 WHERE id = ?", [codeId]);
}
function incrementAccessCodeAttempts(codeId) {
    return promised("UPDATE booking_access_codes SET attempts = attempts + 1 WHERE id = ?", [codeId]);
}
function insertBookingAccessToken(bookingId, email, tokenHash, expiresAt) {
    return promised("INSERT INTO booking_access_tokens (booking_id, email, token_hash, expires_at) VALUES (?, ?, ?, ?)",
        [bookingId, email, tokenHash, expiresAt]);
}

// POST /api/public/bookings/:id/track — client-facing quote/decline note. Hardcodes author
// as 'Client', distinct from the admin notes route's insertBookingNote() below which takes an
// author parameter.
function insertBookingNoteFromTracker(bookingId, noteHtml) {
    return promised("INSERT INTO booking_notes (booking_id, note, author) VALUES (?, ?, 'Client')", [bookingId, noteHtml]);
}

// DELETE /api/admin/services/:id (hard-delete guard) — booking_line_items half only; the sibling
// quote_line_items COUNT stays in server.js (not a table this domain covers).
function countBookingLineItemsForService(serviceId, callback) {
    db.get("SELECT COUNT(*) as cnt FROM booking_line_items WHERE service_id=?", [serviceId], callback);
}

// GET/POST/DELETE /api/admin/bookings/:id/notes — threaded admin notes CRUD.
function getBookingNotesForBooking(bookingId, callback) {
    db.all("SELECT id, note, author, created_at FROM booking_notes WHERE booking_id = ? ORDER BY created_at ASC", [bookingId], callback);
}
function insertBookingNote(bookingId, note, author, callback) {
    db.run("INSERT INTO booking_notes (booking_id, note, author) VALUES (?, ?, ?)", [bookingId, note, author], callback);
}
function getBookingNoteById(noteId, callback) {
    db.get("SELECT id, note, author, created_at FROM booking_notes WHERE id = ?", [noteId], callback);
}
function deleteBookingNote(noteId, bookingId, callback) {
    db.run("DELETE FROM booking_notes WHERE id = ? AND booking_id = ?", [noteId, bookingId], callback);
}

// ══════════════════════════════════════════════════════════════════════════
// Stage 6 (final) — Payment & ledger routes, applyStatusChange()'s core cascade, and the admin
// cancel route. Every statement against `transactions`, `invoices`, `cancellations`, `events`,
// `date_holds`, `payment_schedules`, `policies`, `quotations`, `audit_log` or `financial_audit_log`
// — including the refund route's correlated subquery reading `transactions` from inside a
// `bookings` UPDATE's SET clause, which is cross-domain in the same way a JOIN would be even
// though it isn't literally one — stays in server.js exactly where it was. Only each function's
// own `bookings`-table statement moved. BEGIN IMMEDIATE/COMMIT/ROLLBACK are never touched;
// promise-returning functions here use the same shared `db` connection so they participate in
// whatever transaction (withDbTransaction, or none) the caller is already inside.
// ══════════════════════════════════════════════════════════════════════════

// POST /api/payment/webhook/payfast — the atomic ledger-credit UPDATE inside withDbTransaction().
// Column refs read the pre-update row (documented at the call site), so this is one statement,
// not decomposable into smaller pieces without changing its atomicity guarantee.
function applyPayfastPaymentToBooking(itnAmount, currentTotal, paymentType, pfPaymentId, receivedSignature, rawPayloadJson, paymentMethod, bookingId) {
    return promised(
        `UPDATE bookings SET
            amount_paid = COALESCE(amount_paid,0) + ?,
            total_amount = ?,
            amount_outstanding = MAX(0, ? - (COALESCE(amount_paid,0) + ?)),
            payment_status = CASE
                WHEN (COALESCE(amount_paid,0) + ?) >= ? THEN 'PAID'
                WHEN ? = 'DEPOSIT' THEN 'DEPOSIT_PAID'
                ELSE 'PARTIALLY_PAID' END,
            status = CASE WHEN status IN ('ACCEPTED','CONFIRMED') THEN 'CONFIRMED' ELSE status END,
            payment_reference = ?, payment_signature = ?, payment_raw_data = ?, payment_method = ?,
            confirmed_at = CURRENT_TIMESTAMP, last_payment_date = CURRENT_TIMESTAMP, payment_date = CURRENT_TIMESTAMP
        WHERE id = ? AND (COALESCE(amount_paid,0) + ?) <= ? + 1.0`,
        [
            itnAmount, currentTotal, currentTotal, itnAmount, itnAmount, currentTotal, paymentType,
            pfPaymentId, receivedSignature, rawPayloadJson, paymentMethod,
            bookingId, itnAmount, currentTotal
        ]);
}
// PayFast ITN — payment_status !== 'COMPLETE' branch.
function markBookingPaymentFailedIfUnpaid(bookingId) {
    db.run("UPDATE bookings SET payment_status = 'FAILED' WHERE id = ? AND payment_status = 'UNPAID'", [bookingId]);
}

// processManualPayment() — the ledger UPDATE. Byte-distinct from the transactions/manual route's
// otherwise-similar UPDATE below (different nesting depth in server.js) — kept separate per the
// same rule as updateBookingVenueLinkLegacy/updateBookingVenueGoogle in Stage 5.
function applyManualPaymentToBooking(paymentStatus, paid, outstanding, total, newStatus, bookingId, callback) {
    db.run(
        `UPDATE bookings SET
            payment_status = ?, amount_paid = ?, amount_outstanding = ?,
            total_amount = CASE WHEN COALESCE(total_amount, 0) = 0 THEN ? ELSE total_amount END,
            status = ?,
            last_payment_date = CURRENT_TIMESTAMP, payment_date = CURRENT_TIMESTAMP,
            confirmed_at = CASE WHEN ? = 'PAID' AND confirmed_at IS NULL THEN CURRENT_TIMESTAMP ELSE confirmed_at END
         WHERE id = ?`,
        [paymentStatus, paid, outstanding, total, newStatus, paymentStatus, bookingId], callback);
}
// processManualPayment() — auto-create-event lookup (distinct column list from every other
// getBooking* function in this file).
function getBookingForAutoEventOnPayment(bookingId, callback) {
    db.get("SELECT event_id, date, event_start_time, event_name, event_type, event_location, venue_id FROM bookings WHERE id = ?", [bookingId], callback);
}

// updateBookingMilestones() — the one bookings-table statement in the payment_schedules waterfall
// helper; alignMilestonePayments() itself is entirely payment_schedules and stays in server.js.
function getBookingAmountPaid(bookingId, callback) {
    db.get(`SELECT amount_paid FROM bookings WHERE id = ?`, [bookingId], callback);
}

// getBookingErasureImpact() — the policies lookup alongside this stays in server.js.
function getBookingsByIds(bookingPh, bookingIds) {
    return promisedAll(`SELECT * FROM bookings WHERE id IN (${bookingPh})`, bookingIds);
}
// cancelActiveBookingsForErasure() — mirrors the admin cancel route's cancellation UPDATE below,
// but with different columns (cancellation_reason/cancelled_by are set here; the admin route's
// version leaves them for its own separate INSERT INTO cancellations to carry) — not a duplicate.
function cancelBookingForErasureAsync(cancelReason, bookingId) {
    return promised(
        `UPDATE bookings SET status = 'CANCELLED', cancellation_reason = ?, cancelled_by = 'client', cancelled_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [cancelReason, bookingId]);
}
// Shared by cancelActiveBookingsForErasure() and the admin cancel route below (2 byte-identical
// `await dbRun(...)` call sites) — the fire-and-forget version used by applyStatusChange is a
// separate function (clearBookingPublicAndEventId, no promise) for the same reason
// getBookingById/getBookingByIdAsync are two functions rather than one.
function clearBookingPublicAndEventIdAsync(bookingId) {
    return promised(`UPDATE bookings SET is_public = 0, event_id = NULL WHERE id = ?`, [bookingId]);
}
// cancelActiveBookingsForErasure() — async sibling of the existing fire-and-forget
// clearBookingGoogleEventId() above (Stage 2), needed here because the call site awaits it.
function clearBookingGoogleEventIdAsync(bookingId) {
    return promised(`UPDATE bookings SET google_event_id = NULL WHERE id = ?`, [bookingId]);
}

// POST /api/admin/bookings/:id/cancel — the transactional status UPDATE. Distinct from
// cancelBookingForErasureAsync above (no cancellation_reason/cancelled_by columns — this route
// records those via its own INSERT INTO cancellations instead, which stays in server.js).
function cancelBookingAsync(bookingId) {
    return promised("UPDATE bookings SET status = 'CANCELLED', cancelled_at = CURRENT_TIMESTAMP WHERE id = ?", [bookingId]);
}

// PUT /api/admin/bookings/:id/refund — final payment_status re-derivation. The ledger recalculation
// UPDATE above it (a correlated subquery against `transactions`) is cross-domain and stays put.
function setBookingPaymentStatus(paymentStatus, bookingId, callback) {
    db.run("UPDATE bookings SET payment_status = ? WHERE id = ?", [paymentStatus, bookingId], callback);
}

// POST /api/admin/bookings/:id/reconcile/sync — realign the booking ledger to match the
// transactions table total (computed in server.js from the cross-domain SUM query above it).
function updateBookingLedgerFromReconcile(paid, outstanding, paymentStatus, newStatus, bookingId, callback) {
    db.run(
        `UPDATE bookings SET
            amount_paid = ?, amount_outstanding = ?, payment_status = ?, status = ?,
            confirmed_at = CASE WHEN ? = 'PAID' AND confirmed_at IS NULL THEN CURRENT_TIMESTAMP ELSE confirmed_at END
         WHERE id = ?`,
        [paid, outstanding, paymentStatus, newStatus, paymentStatus, bookingId], callback);
}

// POST /api/admin/transactions/manual — payment branch. See applyManualPaymentToBooking() above
// for why this isn't consolidated with it despite the near-identical SQL.
function applyManualTransactionPaymentToBooking(paymentStatus, paid, outstanding, total, newStatus, bookingId, callback) {
    db.run(
        `UPDATE bookings SET
            payment_status = ?, amount_paid = ?, amount_outstanding = ?,
            total_amount = CASE WHEN COALESCE(total_amount, 0) = 0 THEN ? ELSE total_amount END,
            status = ?,
            last_payment_date = CURRENT_TIMESTAMP, payment_date = CURRENT_TIMESTAMP,
            confirmed_at = CASE WHEN ? = 'PAID' AND confirmed_at IS NULL THEN CURRENT_TIMESTAMP ELSE confirmed_at END
         WHERE id = ?`,
        [paymentStatus, paid, outstanding, total, newStatus, paymentStatus, bookingId], callback);
}
// POST /api/admin/transactions/manual — refund branch.
function updateBookingLedgerAfterManualRefund(paid, outstanding, paymentStatus, bookingId, callback) {
    db.run(`UPDATE bookings SET amount_paid = ?, amount_outstanding = ?, payment_status = ? WHERE id = ?`,
        [paid, outstanding, paymentStatus, bookingId], callback);
}
// POST /api/admin/transactions/manual — adjustment branch.
function updateBookingLedgerAfterAdjustment(paymentStatus, newTotal, outstanding, newStatus, bookingId, callback) {
    db.run(
        `UPDATE bookings SET
            payment_status = ?, total_amount = ?, amount_outstanding = ?,
            status = ?,
            confirmed_at = CASE WHEN ? = 'PAID' AND confirmed_at IS NULL THEN CURRENT_TIMESTAMP ELSE confirmed_at END
         WHERE id = ?`,
        [paymentStatus, newTotal, outstanding, newStatus, paymentStatus, bookingId], callback);
}

// applyStatusChange() — the COMPLETED-transition outstanding-balance guard. Preserves the exact
// never-rejects, resolve({e,row}) shape of the original inline `new Promise(r => ...)`.
function getBookingOutstandingForCompleteGuard(bookingId) {
    return new Promise(r => db.get("SELECT amount_outstanding FROM bookings WHERE id = ?", [bookingId], (e, row) => r({ e, row })));
}
// applyStatusChange() — the core status UPDATE. tsField (which extra timestamp column to stamp,
// or none) is resolved in server.js from the tsFields status→column map — a business rule, not
// a data-access concern — and passed in already resolved.
function updateBookingStatusCore(requestedStatus, tsField, adminId, role, bookingId, callback) {
    const sql = tsField
        ? `UPDATE bookings SET status = ?, ${tsField} = CURRENT_TIMESTAMP, modified_by = ?, modified_by_role = ?, modified_on = CURRENT_TIMESTAMP WHERE id = ?`
        : `UPDATE bookings SET status = ?, modified_by = ?, modified_by_role = ?, modified_on = CURRENT_TIMESTAMP WHERE id = ?`;
    db.run(sql, [requestedStatus, adminId || null, role || null, bookingId], callback);
}
// applyStatusChange() — fire-and-forget sibling of clearBookingPublicAndEventIdAsync above, for
// the one call site (the non-CANCELLED demote-from-public branch) that doesn't await it.
function clearBookingPublicAndEventId(bookingId) {
    db.run(`UPDATE bookings SET is_public = 0, event_id = NULL WHERE id = ?`, [bookingId]);
}
// applyStatusChange() — CANCELLED branch attribution write (the trigger-safe replacement for
// writing 'CANCELLED' into payment_status directly, per the inline comment at the call site).
function setBookingCancellationAttribution(reason, bookingId, callback) {
    db.run("UPDATE bookings SET cancellation_reason = ?, cancelled_by = 'admin' WHERE id = ?", [reason, bookingId], callback);
}

module.exports = {
    getBookingById, getBookingByIdAsync,
    getBookingsTrend, stampReviewEmailSent, unlinkBookingClient, getBookingTotalAmount,
    getOutstandingTotal, getBookingStatusCounts,
    getStaleNewBookings, promoteBookingToPending, getConfirmedPaidPastEvents, markBookingAutoCompleted,
    getStalePendingBookings, expirePendingBooking, getOverdueQuotedBookings, expireQuotedBooking,
    clearBookingGoogleEventId, getQuotesExpiringTomorrow, markQuoteExpiryWarned,
    getPendingEnquiriesNearingExpiry, markPendingExpiryWarned, markBookingOverdueReminded,
    getBookingsForQuoteFollowUp, markQuoteFollowUpSent, findActiveBookingByEmailAndDate,
    getBookingsForDepositBalanceReminder, markDepositBalanceReminded,
    getConfirmedBookingsOnDate, markEventReminderSent, getCompletedBookingsAwaitingReview,
    getActiveDuplicateBookingForEmailDate, getActiveDuplicateBookingForEmailDateAsync, insertAdminBooking,
    getBookingStatusNameEmail, reopenBooking, insertBookAgainBooking, markBookingCompletedManual,
    updateBookingBuffer, getBookingDisposition, updateBookingDisposition, markBookingPendingAfterRespond,
    insertLegacyBookingFromContactForm, getAllBookingsForMigration, getAllBookingsFull,
    updateBookingClientVenue, deleteBookingById,
    setBookingClientId, updateBookingLedgerAfterInvoice,
    updateBookingAfterQuote, deleteBookingLineItems, deleteBookingServices,
    insertBookingLineItem, insertBookingService, getBookingStatus, getBookingForContractRemind,
    getBookingIdStatusAsync,
    getBookingsOnDateForCalendarConflict, setBookingGoogleEventId, getBookingsWithGoogleEventIdAsync,
    getBookingsOnDateForAvailability, getBookingsOnDateForHoldConflict, getBookingsOnDateForEventConflict,
    updateBookingVenueUnlink, updateBookingVenueLinkLegacy, updateBookingVenueGoogle, getBookingEventId,
    updateBookingVenueFreeText, updateBookingDateAndTimeFields, getBookingByIdSafeAsync,
    setBookingPublicWithNewEvent, setBookingPublicTicketLink, clearBookingPublicWithEvent, clearBookingPublicTicketLink,
    setBookingEventId, insertPlaceholderBookingForEvent, updateBookingDateFromEventEdit,
    clearBookingEventIdWhereEventId, setBookingDateAndStartTimeFromEvent,
    getBookingIdsForEmail, anonymizeBookingsForErasure, deleteBookingAccessCodesForErasure,
    deleteBookingAccessTokensForErasure, redactBookingNotesForErasure, countBookingNotesForIds,
    getBookingAccessTokenByHash, touchBookingAccessToken, getBookingEmailForTracking,
    consumeUnconsumedAccessCodes, insertBookingAccessCode, getActiveAccessCodeForVerification,
    consumeAccessCodeById, incrementAccessCodeAttempts, insertBookingAccessToken,
    insertBookingNoteFromTracker, countBookingLineItemsForService,
    getBookingNotesForBooking, insertBookingNote, getBookingNoteById, deleteBookingNote,
    applyPayfastPaymentToBooking, markBookingPaymentFailedIfUnpaid,
    applyManualPaymentToBooking, getBookingForAutoEventOnPayment, getBookingAmountPaid,
    getBookingsByIds, cancelBookingForErasureAsync, clearBookingPublicAndEventIdAsync, clearBookingGoogleEventIdAsync,
    cancelBookingAsync, setBookingPaymentStatus, updateBookingLedgerFromReconcile,
    applyManualTransactionPaymentToBooking, updateBookingLedgerAfterManualRefund, updateBookingLedgerAfterAdjustment,
    getBookingOutstandingForCompleteGuard, updateBookingStatusCore, clearBookingPublicAndEventId,
    setBookingCancellationAttribution,
};
