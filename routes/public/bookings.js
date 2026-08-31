const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const fs = require('fs');
const multer = require('multer');
const moment = require('moment-timezone');
const db = require('../../database');
const {
    ipRateLimiter, otpRequestRateLimiter, mutateRateLimiter, lookupRateLimiter, trackRateLimiter,
    bookingRateLimiter
} = require('../../middleware/rate-limiters');
const { requireBookingAccessToken } = require('../../middleware/booking-access');
const { encodeUserHtml } = require('../../lib/html-sanitize');
const { getEmailFooterContext } = require('../../lib/email-context');
const { resolveDocsPath, docsWriteDir } = require('../../lib/runtime-paths');
const {
    asBookingText, OTP_TTL_MINUTES, OTP_MAX_ATTEMPTS, ACCESS_TOKEN_TTL_MINUTES,
    generateOtpCode, hashAccessToken
} = require('../../lib/booking-tracking');
const { MIN_ADVANCE_HOURS, CURRENT_POLICY_VERSION } = require('../../lib/booking-policy');
const { addMinutesToTime, parseDurationToMinutes } = require('../../lib/time-utils');
const { findOrCreateClient, findOrCreateVenueFromPlace } = require('../../lib/client-venue');
const { calculateCancellationRefund } = require('../../lib/cancellation-refund');
const { sendCancellationEmail } = require('../../lib/booking-cancellation-email');
const { sendQuoteAcceptedEmail, sendBookingReceivedEmail } = require('../../lib/booking-notifications');
const { generatePayFastSignature } = require('../../lib/payfast-signature');
const {
    syncBookingToCalendar, checkDateAvailability, hasCalendarConflict, isWithinWorkingHours
} = require('../../lib/calendar-sync');
const { autoBuildDepositBalanceSchedule, generateInvoice } = require('../../lib/invoicing');
const { generateContract } = require('../../lib/contracts');
const { dbGet, dbRun } = require('../../lib/db-helpers');
// Phase 5: MUST stay the exact same singleton module.exports app.js and every other route file
// import — see lib/db-transaction.js's own header comment.
const { withDbTransaction } = require('../../lib/db-transaction');
const bannerRegistry = require('../../js/bannerRegistry');
const emailComponents = require('../../js/emailComponents');
const { sendEmail } = require('../../js/emailService');
const {
    getBookingEmailForTracking, consumeUnconsumedAccessCodes, insertBookingAccessCode,
    getActiveAccessCodeForVerification, consumeAccessCodeById, incrementAccessCodeAttempts,
    insertBookingAccessToken, getBookingById, insertBookingNoteFromTracker,
    insertBookingService, insertBookingLineItem
} = require('../../database/repositories/bookings.repository');
const {
    getInvoiceForTracking, getQuoteVersionInfoForTracking, getLatestQuoteFileForPublicDownload,
    voidInvoicesForCancelledBookingAsync, markQuotationAcceptedAsync
} = require('../../database/repositories/invoices-quotations.repository');
const {
    getPaymentSchedulesForTracking, getCancellationSummaryForTracking,
    insertCancellationForPublicCancel, cancelPendingPaymentSchedulesAsync,
    getPaymentSchedulesForPayfastInit
} = require('../../database/repositories/finance.repository');
const { releaseDateHoldsForBookingAsync } = require('../../database/repositories/calendar.repository');
const { getNotificationEmail } = require('../../database/repositories/settings.repository');
const router = express.Router();

// Phase 5 (HOUSEKEEPING-NOTES.md): moved from app.js verbatim, byte-identical — single-consumer
// (the draft-autosave route below).
// Best-effort estimate of the value of selected services (lost-revenue analytics).
async function estimateDraftValue(services) {
    try {
        if (!Array.isArray(services) || services.length === 0) return 0;
        const ids = services.map(s => parseInt(s.service_id)).filter(n => !isNaN(n));
        if (!ids.length) return 0;
        const placeholders = ids.map(() => '?').join(',');
        const rows = await new Promise(resolve =>
            db.all(`SELECT id, base_price, default_price FROM services WHERE id IN (${placeholders})`, ids,
                (err, r) => resolve(err ? [] : (r || []))));
        let total = 0;
        for (const s of services) {
            const row = rows.find(r => r.id === parseInt(s.service_id));
            if (!row) continue;
            const price = parseFloat(row.base_price != null ? row.base_price : (row.default_price || 0)) || 0;
            const qty = parseInt(s.quantity || s.quantity_minutes || 1) || 1;
            total += price * qty;
        }
        return Math.round(total * 100) / 100;
    } catch (e) { return 0; }
}

// ---- Public: opt out of recovery reminders ----
// BUG-2: a GET must NOT mutate state — corporate email-security scanners pre-fetch links and would
// silently unsubscribe engaged users. The GET renders a confirmation page; the POST performs it.
function _abOptOutPage(inner) {
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Booking reminders</title></head>
        <body style="font-family:Arial,sans-serif;background:#0a0a0a;color:#e8e8e8;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px;">
        <div style="max-width:460px;text-align:center;border:1px solid rgba(255,255,255,0.12);border-radius:12px;padding:36px 28px;">
        ${inner}
        <p style="color:#888;font-size:13px;margin:22px 0 0;">Thabiso Mhlongo Management</p>
        </div></body></html>`;
}

// ---- Public: upsert a draft (autosave). Uses only ipRateLimiter (100/hr) so debounced autosaves aren't blocked. ----
router.post('/api/public/bookings/draft', ipRateLimiter, async (req, res) => {
    try {
        const b = req.body || {};
        const draftToken = (b.draft_token || '').toString().slice(0, 80);
        if (!draftToken) return res.status(400).json({ success: false, message: 'Missing draft token.' });

        const email = (b.email || '').toString().trim().slice(0, 200);
        // POPIA data minimisation: only persist once a valid email exists (Step 2+).
        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return res.json({ success: true, skipped: true });
        }

        const eventDate = (b.event_date || '').toString().slice(0, 20);
        // If a real booking already exists for this email+date, don't track it as abandoned.
        if (eventDate) {
            const existing = await new Promise(resolve => db.get(
                `SELECT id FROM bookings WHERE lower(email)=lower(?) AND date=? AND status NOT IN ('CANCELLED','EXPIRED') LIMIT 1`,
                [email, eventDate], (e, row) => resolve(row)));
            if (existing) return res.json({ success: true, converted: true });
        }

        const services = Array.isArray(b.services) ? b.services : [];
        const servicesJson = JSON.stringify(services.map(s => ({ service_id: s.service_id, name: s.name, quantity: s.quantity || s.quantity_minutes || 1 })));
        const estValue = await estimateDraftValue(services);
        const currentStep = Math.min(4, Math.max(1, parseInt(b.current_step) || 1));
        const consent = b.consent_given ? 1 : 0;
        const source = (b.source || '').toString().slice(0, 120);
        const ua = (req.headers['user-agent'] || '').toString().slice(0, 255);
        const ip = (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim();
        const msg = (b.message || '').toString().slice(0, 2000);

        const resumeToken = crypto.randomBytes(24).toString('hex');

        // Atomic UPSERT keyed by draft_token — race-safe (BUG-1). On conflict, resume_token/
        // created_at are preserved (not in the SET list), furthest_step stays monotonic, and
        // terminal statuses (RECOVERED/WON/LOST/CLOSED) are never downgraded back to ABANDONED.
        db.run(
            `INSERT INTO abandoned_bookings
                (draft_token, resume_token, name, company, email, cell, event_name, event_date, event_start_time,
                 performance_slot, performance_duration, event_location, venue_address, city, country, venue_type, event_type, message,
                 services_json, current_step, furthest_step, consent_given, est_value, source, ip_address, user_agent)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
             ON CONFLICT(draft_token) DO UPDATE SET
                name=excluded.name, company=excluded.company, email=excluded.email, cell=excluded.cell,
                event_name=excluded.event_name, event_date=excluded.event_date, event_start_time=excluded.event_start_time,
                performance_slot=excluded.performance_slot, performance_duration=excluded.performance_duration,
                event_location=excluded.event_location, venue_address=excluded.venue_address, city=excluded.city,
                country=excluded.country, venue_type=excluded.venue_type, event_type=excluded.event_type, message=excluded.message,
                services_json=excluded.services_json, current_step=excluded.current_step,
                furthest_step=MAX(abandoned_bookings.furthest_step, excluded.furthest_step),
                consent_given=excluded.consent_given, est_value=excluded.est_value,
                source=COALESCE(NULLIF(excluded.source, ''), abandoned_bookings.source),
                ip_address=excluded.ip_address, user_agent=excluded.user_agent, last_activity_at=CURRENT_TIMESTAMP,
                status=CASE WHEN abandoned_bookings.status IN ('RECOVERED','WON','LOST','CLOSED') THEN abandoned_bookings.status ELSE 'ABANDONED' END`,
            [draftToken, resumeToken, encodeUserHtml(b.name) || null, encodeUserHtml(b.company) || null, email, b.cell || null, encodeUserHtml(b.event_name) || null, eventDate || null, b.event_start_time || null,
             encodeUserHtml(b.performance_slot) || null, encodeUserHtml(b.performance_duration) || null, encodeUserHtml(b.event_location) || null, encodeUserHtml(b.venue_address) || null, encodeUserHtml(b.city) || null, encodeUserHtml(b.country) || null, encodeUserHtml(b.venue_type) || null, encodeUserHtml(b.event_type) || null, encodeUserHtml(msg),
             servicesJson, currentStep, currentStep, consent, estValue, source, ip, ua],
            (err) => {
                if (err) { console.error('[Booking Recovery] draft upsert failed:', err.message); return res.status(500).json({ success: false }); }
                // Return the row's resume_token (the original one if this was an update).
                db.get(`SELECT resume_token FROM abandoned_bookings WHERE draft_token=?`, [draftToken],
                    (e2, row) => res.json({ success: true, resume_token: row ? row.resume_token : resumeToken }));
            });
    } catch (e) { console.error('[Booking Recovery] draft endpoint error:', e.message); res.status(500).json({ success: false }); }
});

// ---- Public: fetch a draft for resume (prefill the wizard) ----
router.get('/api/public/bookings/draft/:resumeToken', ipRateLimiter, (req, res) => {
    db.get(`SELECT * FROM abandoned_bookings WHERE resume_token=?`, [req.params.resumeToken], (err, row) => {
        if (err || !row) return res.status(404).json({ success: false, message: 'Draft not found.' });
        if (row.opt_out || row.status === 'RECOVERED' || row.status === 'CLOSED') {
            return res.status(410).json({ success: false, message: 'This booking draft is no longer available.' });
        }
        let services = [];
        try { services = row.services_json ? JSON.parse(row.services_json) : []; } catch (e) {}
        res.json({ success: true, draft: {
            draft_token: row.draft_token,
            name: row.name, company: row.company, email: row.email, cell: row.cell,
            event_name: row.event_name, event_date: row.event_date, event_start_time: row.event_start_time,
            performance_slot: row.performance_slot, performance_duration: row.performance_duration,
            event_location: row.event_location, venue_address: row.venue_address, city: row.city, country: row.country, venue_type: row.venue_type,
            event_type: row.event_type, message: row.message, services,
            current_step: row.current_step, furthest_step: row.furthest_step
        }});
    });
});

router.get('/api/public/bookings/draft/:resumeToken/optout', ipRateLimiter, (req, res) => {
    const token = encodeURIComponent(req.params.resumeToken); // safe inside the form action attribute
    res.setHeader('Content-Type', 'text/html');
    res.send(_abOptOutPage(
        '<div style="font-size:34px;color:#D4AF37;margin-bottom:12px;">&#9993;</div>'
        + '<h2 style="font-weight:400;margin:0 0 10px;">Stop booking reminders?</h2>'
        + '<p style="color:#b0b0b0;font-size:14px;margin:0 0 22px;">You will no longer receive emails reminding you to finish your booking request.</p>'
        + '<form method="POST" action="/api/public/bookings/draft/' + token + '/optout" style="margin:0;">'
        + '<button type="submit" style="padding:12px 24px;background:#D4AF37;color:#000;border:none;border-radius:4px;font-weight:bold;font-size:14px;cursor:pointer;">Yes, stop reminders</button>'
        + '</form>'
        + '<a href="' + (process.env.BASE_URL || '') + '/" style="display:inline-block;margin-top:16px;color:#888;text-decoration:none;font-size:13px;">No, take me back to the site</a>'
    ));
});

router.post('/api/public/bookings/draft/:resumeToken/optout', ipRateLimiter, (req, res) => {
    db.run(`UPDATE abandoned_bookings SET opt_out=1, status=CASE WHEN status IN ('RECOVERED','WON') THEN status ELSE 'CLOSED' END WHERE resume_token=?`,
        [req.params.resumeToken], function (err) {
            res.setHeader('Content-Type', 'text/html');
            const back = '<a href="' + (process.env.BASE_URL || '') + '/" style="display:inline-block;margin-top:8px;color:#D4AF37;text-decoration:none;font-size:14px;">Return to the website &rarr;</a>';
            if (err) return res.status(500).send(_abOptOutPage('<div style="font-size:34px;color:#888;margin-bottom:12px;">&#9888;</div><h2 style="font-weight:400;margin:0 0 10px;">Something went wrong.</h2><p style="color:#b0b0b0;font-size:14px;">Please try again later.</p>' + back));
            res.send(_abOptOutPage('<div style="font-size:34px;color:#D4AF37;margin-bottom:12px;">&#10003;</div><h2 style="font-weight:400;margin:0 0 10px;">You have been unsubscribed.</h2><p style="color:#b0b0b0;font-size:14px;">You will not receive any more booking reminders.</p>' + back));
        });
});

// Step 1: request a code. Always responds with the same generic message regardless of whether the
// id/email combination matches a real booking — mirrors the existing anti-enumeration pattern in
// /api/admin/forgot-password. Only a real match actually queues an email.
router.post('/api/public/bookings/:id/track/request-code', ipRateLimiter, otpRequestRateLimiter, (req, res) => {
    const email = asBookingText(req.body.email);
    const bookingId = parseInt(req.params.id, 10);
    const generic = { success: true, message: 'If those details match a booking, a verification code has been sent to the email on file.' };
    if (!email || !bookingId) return res.status(400).json({ success: false, message: 'Booking ID and email are required.' });

    getBookingEmailForTracking(bookingId, async (err, row) => {
        if (err || !row || row.email.trim().toLowerCase() !== email.trim().toLowerCase()) {
            return res.json(generic);
        }
        try {
            // Kill any earlier unconsumed code for this booking so only the most recent one sent is live.
            await consumeUnconsumedAccessCodes(bookingId);
            const code = generateOtpCode();
            const codeHash = await bcrypt.hash(code, 10);
            const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60000).toISOString();
            await insertBookingAccessCode(bookingId, row.email, codeHash, expiresAt);

            const banner = await bannerRegistry.resolveBanner('booking_verification_code');
            const { socialLinks } = await getEmailFooterContext();
            await sendEmail({
                to: row.email,
                subject: `Your verification code: ${code}`,
                htmlContent: emailComponents.renderPremiumEmail({
                    preheaderText: `Your verification code is ${code}. It expires in ${OTP_TTL_MINUTES} minutes.`,
                    bannerSrc: banner?.src, bannerAlt: banner?.alt, subtitle: banner?.subtitle,
                    headline: banner?.headline || 'Verify Your Booking',
                    bodyHtml:
                        `<p style="margin:0 0 12px;">Use this code to view booking <strong style="color:#FAFAFA;">#${bookingId}</strong> (${emailComponents.esc(row.event_name || row.event_type || 'your event')}):</p>` +
                        `<p style="margin:0; color:#B0B0B0; font-size:13px;">This code expires in ${OTP_TTL_MINUTES} minutes. If you didn't request this, you can safely ignore this email.</p>`,
                    cards: [{ rows: [{ label: 'Verification code', value: code, mono: true, highlight: true }] }],
                    socialLinks
                }),
                preWrapped: true,
                titleOverride: 'Verify Your Booking',
                trigger_event: 'Booking: Tracker Verification Code'
            });
        } catch (e) {
            console.error('[Tracking OTP] request-code failed:', e.message);
        }
        res.json(generic);
    });
});

// Step 2: verify a code, issue a booking-scoped access token.
router.post('/api/public/bookings/:id/track/verify-code', ipRateLimiter, mutateRateLimiter, async (req, res) => {
    const email = asBookingText(req.body.email);
    const code = asBookingText(req.body.code);
    const bookingId = parseInt(req.params.id, 10);
    if (!email || !code) return res.status(400).json({ success: false, message: 'Email and code are required.' });

    try {
        const codeRow = await getActiveAccessCodeForVerification(bookingId, email);
        if (!codeRow) {
            return res.status(400).json({ success: false, message: 'That code is invalid or has expired. Please request a new one.' });
        }
        if (codeRow.attempts >= OTP_MAX_ATTEMPTS) {
            await consumeAccessCodeById(codeRow.id);
            return res.status(400).json({ success: false, message: 'Too many incorrect attempts. Please request a new code.' });
        }

        const match = await bcrypt.compare(code, codeRow.code_hash);
        if (!match) {
            await incrementAccessCodeAttempts(codeRow.id);
            const remaining = OTP_MAX_ATTEMPTS - (codeRow.attempts + 1);
            return res.status(400).json({ success: false, message: remaining > 0 ? `Incorrect code. ${remaining} attempt(s) remaining.` : 'Too many incorrect attempts. Please request a new code.' });
        }

        await consumeAccessCodeById(codeRow.id);
        const rawToken = crypto.randomBytes(32).toString('hex');
        const expiresAt = new Date(Date.now() + ACCESS_TOKEN_TTL_MINUTES * 60000).toISOString();
        await insertBookingAccessToken(bookingId, email, hashAccessToken(rawToken), expiresAt);

        res.json({ success: true, access_token: rawToken, expires_in: ACCESS_TOKEN_TTL_MINUTES * 60 });
    } catch (e) {
        console.error('[Tracking OTP] verify-code failed:', e.message);
        res.status(500).json({ success: false, message: 'Could not verify your code. Please try again.' });
    }
});

// Email-only booking lookup with pagination (5 lookups per 10 min per IP)
router.post('/api/public/bookings/lookup', lookupRateLimiter, (req, res) => {
    const { email, page } = req.body;
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim())) {
        return res.status(400).json({ success: false, message: 'A valid email address is required.' });
    }
    const offset = ((parseInt(page) || 1) - 1) * 10;
    const emailNorm = email.trim();
    // First fetch total count so client can show "Load more"
    db.get(
        `SELECT COUNT(*) AS total FROM bookings
         WHERE lower(email) = lower(?) AND status NOT IN ('CANCELLED')`,
        [emailNorm],
        (cErr, countRow) => {
            const total = (countRow && !cErr) ? countRow.total : 0;
            db.all(
                `SELECT id, event_name, date, status, created_at FROM bookings
                 WHERE lower(email) = lower(?) AND status NOT IN ('CANCELLED')
                 ORDER BY created_at DESC LIMIT 10 OFFSET ?`,
                [emailNorm, offset],
                (err, rows) => {
                    if (err) return res.status(500).json({ success: false, message: 'Lookup failed.' });
                    if (!rows || !rows.length) return res.json({ success: false, message: 'No bookings found for that email address.' });
                    res.json({ success: true, bookings: rows, total, page: parseInt(page) || 1 });
                }
            );
        }
    );
});

router.post('/api/public/bookings/:id/track', ipRateLimiter, trackRateLimiter, requireBookingAccessToken, (req, res) => {
    getBookingById(req.params.id, (err, row) => {
        if (err || !row) return res.status(404).json({ success: false, message: 'Booking not found.' });

        // Include latest invoice if exists
        getInvoiceForTracking(row.id, (e, inv) => {
            getPaymentSchedulesForTracking(row.id, (e2, schedule) => {
                db.all(`SELECT s.name AS service_name, s.pricing_model, bs.quantity_minutes, bs.unit_price,
                               (bs.unit_price * bs.quantity_minutes) AS line_total
                        FROM booking_services bs
                        JOIN services s ON bs.service_id = s.id
                        WHERE bs.booking_id = ?`, [row.id], (e3, services) => {
                    getQuoteVersionInfoForTracking(row.id, (qvErr, qv) => {
                            getCancellationSummaryForTracking(row.id, (cErr, cancRow) => {
                                    db.get("SELECT pdf_url, status, sent_to_client_at, signed_by_client_at, signed_by_comedian_at, is_frozen FROM contracts WHERE booking_id = ?", [row.id], (contractErr, contractRow) => {
                                        // SEC: build the public payload from an explicit allowlist rather than
                                        // spreading the full `bookings` row and denylisting a few gateway fields.
                                        // The denylist previously missed `admin_notes` — a free-text field admins
                                        // write about the client — plus every other internal-only column (IPs,
                                        // FK ids, reminder-sent timestamps, etc.), all of which were silently
                                        // exposed in the JSON response to anyone tracking that booking. This
                                        // table gains new columns constantly, so a denylist rots; an allowlist
                                        // of exactly what the tracking UI reads does not.
                                        const publicBooking = {
                                            id: row.id,
                                            status: row.status,
                                            payment_status: row.payment_status,
                                            event_name: row.event_name,
                                            event_type: row.event_type,
                                            date: row.date,
                                            quote_amount: row.quote_amount,
                                            quote_details: row.quote_details,
                                            quote_expiry_date: row.quote_expiry_date,
                                            company: row.company,
                                            vat_number: row.vat_number,
                                            total_amount: row.total_amount,
                                            amount_paid: row.amount_paid,
                                            amount_outstanding: row.amount_outstanding
                                        };

                                        res.json({
                                            success: true,
                                            booking: publicBooking,
                                            invoice: inv || null,
                                            payment_schedule: schedule || [],
                                            services: services || [],
                                            quote_version: qv ? qv.version : null,
                                            quote_version_count: qv ? qv.total_versions : 0,
                                            cancellation: cancRow || null,
                                            contract: contractRow || null
                                        });
                                    });
                                });
                        }
                    );
                });
            });
        });
    });
});

// 3. Download Invoice (Public Secured)
router.get('/api/public/bookings/:id/invoice/download', ipRateLimiter, trackRateLimiter, requireBookingAccessToken, async (req, res) => {
    // A booking accumulates one invoice per revision (INV-…, INV-…-R2, …), the superseded ones VOID.
    // Without the filter and ordering this `db.get` returned the lowest rowid — the VOID original —
    // and served the client a stale invoice after any re-quote.
    db.get(`SELECT i.file_path, i.invoice_number
            FROM bookings b
            JOIN invoices i ON b.id = i.booking_id
            WHERE b.id = ? AND UPPER(i.status) <> 'VOID'
            ORDER BY i.created_at DESC, i.id DESC
            LIMIT 1`, [req.params.id], async (err, row) => {

        if (err || !row) return res.status(404).send('Invoice not found');

        const filePath = resolveDocsPath('invoices', row.file_path);
        if (fs.existsSync(filePath)) {
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `attachment; filename=Invoice_${row.invoice_number}.pdf`);
            res.sendFile(filePath);
        } else {
            res.status(404).send('Physical PDF file not found on server.');
        }
    });
});

// Download Contract (Public Secured)
router.get('/api/public/bookings/:id/contract/download', ipRateLimiter, trackRateLimiter, requireBookingAccessToken, async (req, res) => {
    db.get(`SELECT c.pdf_url
            FROM bookings b
            JOIN contracts c ON b.id = c.booking_id
            WHERE b.id = ?`, [req.params.id], async (err, row) => {

        if (err || !row || !row.pdf_url) return res.status(404).send('Contract not found');

        const filePath = resolveDocsPath('contracts', row.pdf_url);
        if (fs.existsSync(filePath)) {
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `attachment; filename=Contract_${row.pdf_url}`);
            res.sendFile(filePath);
        } else {
            res.status(404).send('Physical PDF file not found on server.');
        }
    });
});

// Public: download own quote PDF (verified via access token)
router.post('/api/public/bookings/:id/quote/download', ipRateLimiter, trackRateLimiter, requireBookingAccessToken, (req, res) => {
    db.get("SELECT * FROM bookings WHERE id = ?", [req.params.id], (err, booking) => {
        if (err || !booking) return res.status(404).json({ success: false, message: 'Booking not found.' });
        if (!['QUOTED','ACCEPTED','CONFIRMED','COMPLETED'].includes(booking.status))
            return res.status(403).json({ success: false, message: 'No quote available for your booking.' });
        getLatestQuoteFileForPublicDownload(
            req.params.id, (e, q) => {
                if (e || !q) return res.status(404).json({ success: false, message: 'Quote PDF not found.' });
                const filePath = resolveDocsPath('quotes', q.file_path);
                if (!fs.existsSync(filePath))
                    return res.status(404).json({ success: false, message: 'Quote file not found on server.' });
                res.setHeader('Content-Type', 'application/pdf');
                res.setHeader('Content-Disposition', `attachment; filename=Quote_${q.quote_number}.pdf`);
                res.sendFile(filePath);
            });
    });
});

// Public: client self-cancellation (PENDING/QUOTED/ACCEPTED only)
router.post('/api/public/bookings/:id/cancel', mutateRateLimiter, ipRateLimiter, requireBookingAccessToken, async (req, res) => {
    const { reason, reason_code } = req.body;
    db.get("SELECT * FROM bookings WHERE id = ?", [req.params.id], (err, booking) => {
        if (err || !booking) return res.status(404).json({ success: false, message: 'Booking not found.' });
        const cancellable = ['PENDING','QUOTED','ACCEPTED'];
        if (!cancellable.includes(booking.status))
            return res.status(400).json({ success: false, message: `Booking cannot be cancelled at status ${booking.status}. Contact us directly.` });

        db.get("SELECT policy_value FROM policies WHERE policy_key = 'cancellation_policy'", [], async (e, policy) => {
            const calc = calculateCancellationRefund(booking, policy ? policy.policy_value : '');

            const outcome = await withDbTransaction(async () => {
                try {
                    await dbRun("BEGIN IMMEDIATE");
                } catch (beginErr) {
                    console.error('[Public Cancel] BEGIN IMMEDIATE failed:', beginErr.message);
                    return { status: 500, body: { success: false, message: 'Database busy. Please retry.' } };
                }
                try {
                    await dbRun("UPDATE bookings SET status = 'CANCELLED', cancelled_at = CURRENT_TIMESTAMP WHERE id = ?", [req.params.id]);
                    await insertCancellationForPublicCancel(req.params.id, reason || 'Client request', reason_code || null, calc.totalPaid, calc.refund, calc.retention);
                    // Released with the cancellation, not after it: this ran post-COMMIT and could
                    // leave the date held against a booking that no longer holds it.
                    await releaseDateHoldsForBookingAsync(req.params.id);
                    // Bug fix: this cascade was missing here even though both admin cancel paths
                    // (the dedicated /cancel route and the generic status-change handler) apply it —
                    // without it, a client self-cancelling an ACCEPTED booking left its invoice SENT
                    // and its payment-schedule rows pending, corrupting AR/outstanding-balance reporting.
                    await voidInvoicesForCancelledBookingAsync(req.params.id);
                    await cancelPendingPaymentSchedulesAsync(req.params.id);

                    await dbRun("COMMIT");
                    return { ok: true };
                } catch (txErr) {
                    await dbRun("ROLLBACK").catch(() => {});
                    console.error('[Public Cancel] Failed — rolled back, booking unchanged:', txErr.message);
                    return { status: 500, body: { success: false } };
                }
            });

            if (!outcome.ok) return res.status(outcome.status).json(outcome.body);

            booking.name = booking.client_name || booking.name;
            try { await sendCancellationEmail(booking, { reason: reason || 'Client request', refund_due: calc.refund, rule: calc.rule, days_until_event: calc.daysUntilEvent }); } catch(ce) {}
            getNotificationEmail().then(notifEmail => {
                sendEmail({ to: notifEmail, subject: `Client Cancelled – Booking #${req.params.id}`,
                    htmlContent: emailComponents.renderSystemEmail({
                        preheaderText: `${booking.name} cancelled booking #${req.params.id}.`,
                        category: 'Booking Requests',
                        severity: 'action',
                        leadFact: `<strong style="color:#FAFAFA;">${emailComponents.esc(booking.name)}</strong> cancelled booking <strong style="color:#FAFAFA;">#${req.params.id}</strong>.`,
                        cards: [{ rows: [
                            { label: 'Reason', value: reason || 'Not provided', mono: false },
                            { label: 'Refund Due', value: `R${calc.refund.toFixed(2)}`, highlight: true }
                        ] }]
                    }),
                    preWrapped: true,
                    titleOverride: 'Client Cancellation', trigger_event: 'Admin: Client Cancellation' }).catch(() => {});
            });
            res.json({ success: true, message: 'Booking cancelled.', refund_due: calc.refund, refund_policy: calc.rule });
        });
    });
});

// C7: Public — submit a post-event review (COMPLETED bookings only, verified via access token)
router.post('/api/public/bookings/:id/review', mutateRateLimiter, ipRateLimiter, requireBookingAccessToken, (req, res) => {
    const { rating, review_text } = req.body;
    const ratingNum = parseInt(rating, 10);
    if (!ratingNum || ratingNum < 1 || ratingNum > 5) return res.status(400).json({ success: false, message: 'Rating must be between 1 and 5.' });

    db.get("SELECT * FROM bookings WHERE id = ?", [req.params.id], (err, booking) => {
        if (err || !booking) return res.status(404).json({ success: false, message: 'Booking not found.' });
        if (booking.status !== 'COMPLETED')
            return res.status(400).json({ success: false, message: 'Reviews can only be submitted for completed bookings.' });

        const clientName = booking.client_name || booking.name || 'Anonymous';
        db.run(
            `INSERT INTO service_reviews (booking_id, client_name, rating, review_text)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(booking_id) DO UPDATE SET rating=excluded.rating, review_text=excluded.review_text, submitted_at=CURRENT_TIMESTAMP`,
            [req.params.id, encodeUserHtml(clientName), ratingNum, encodeUserHtml(review_text) || null],
            function(insErr) {
                if (insErr) return res.status(500).json({ success: false, message: 'Could not save review.' });
                // Notify admin of new review
                getNotificationEmail().then(notifEmail => sendEmail({
                    to: notifEmail,
                    subject: `New Review Submitted – Booking #${req.params.id} (${ratingNum}★)`,
                    htmlContent: emailComponents.renderSystemEmail({
                        preheaderText: `${clientName} left a ${ratingNum}/5 review for booking #${req.params.id}.`,
                        category: 'Thank You & Reviews',
                        severity: 'info',
                        leadFact: `<strong style="color:#FAFAFA;">${emailComponents.esc(clientName)}</strong> has submitted a <strong style="color:#D4AF37;">${ratingNum}/5</strong> review for Booking <strong style="color:#FAFAFA;">#${req.params.id}</strong>.`,
                        bodyHtml:
                            (review_text ? `<blockquote style="border-left:3px solid #D4AF37; padding:10px 16px; margin:0 0 12px; color:#E6E6E6; background:#1A1A1A;">${review_text}</blockquote>` : '') +
                            `<p style="margin:0; color:#B0B0B0;">Log in to the admin panel to approve or manage reviews.</p>`
                    }),
                    preWrapped: true,
                    titleOverride: 'New Client Review',
                    trigger_event: 'Admin: New Review Submitted'
                })).catch(() => {});
                res.json({ success: true, message: 'Thank you! Your review has been submitted.' });
            }
        );
    });
});

// Phase 5 (HOUSEKEEPING-NOTES.md): moved from app.js verbatim, byte-identical — single-consumer
// (the attachments route below).
// Booking client attachments (posters, briefs, programmes)
const bookingAttachUpload = multer({
    storage: multer.diskStorage({
        destination: function (req, file, cb) {
            cb(null, docsWriteDir('booking_attachments'));
        },
        filename: function (req, file, cb) {
            const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
            cb(null, `booking-${req.params.id || 'new'}-${Date.now()}-${safe}`);
        }
    }),
    fileFilter: function (req, file, cb) {
        const allowedMimes = [
            'application/pdf',
            'application/msword',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'image/jpeg', 'image/png', 'image/webp'
        ];
        if (allowedMimes.includes(file.mimetype)) return cb(null, true);
        cb(new Error('Allowed types: PDF, Word, JPEG, PNG, WEBP'));
    },
    limits: { fileSize: 10 * 1024 * 1024 }
});

// Public: upload supporting files after booking is created (max 5 × 10 MB)
router.post('/api/public/bookings/:id/attachments',
    mutateRateLimiter, ipRateLimiter,
    bookingAttachUpload.array('attachments', 5),
    (req, res) => {
        const { email } = req.body;
        if (!email) return res.status(400).json({ success: false, message: 'Email required.' });
        if (!req.files || req.files.length === 0)
            return res.status(400).json({ success: false, message: 'No files received.' });

        db.get("SELECT * FROM bookings WHERE id = ?", [req.params.id], (err, booking) => {
            if (err || !booking) return res.status(404).json({ success: false, message: 'Booking not found.' });
            if ((booking.email || '').trim().toLowerCase() !== email.trim().toLowerCase())
                return res.status(401).json({ success: false, message: 'Email does not match.' });

            const existing = JSON.parse(booking.attachment_files || '[]');
            const added = req.files.map(f => ({
                filename: f.filename,
                original_name: f.originalname,
                mime_type: f.mimetype,
                size: f.size
            }));
            const merged = [...existing, ...added].slice(0, 10);

            db.run("UPDATE bookings SET attachment_files = ? WHERE id = ?",
                [JSON.stringify(merged), req.params.id],
                (upErr) => {
                    if (upErr) return res.status(500).json({ success: false });
                    res.json({ success: true, files: added });
                }
            );
        });
    }
);

// Hardened Payment Initiation Endpoint
// SEC: every other public /bookings/:id/* action (track, accept-quote, cancel, contract/sign)
// verifies the caller controls the booking's own email before returning anything. This route used
// to skip that check entirely, so POSTing a payment_type against any (sequential, easily-guessed)
// booking id returned the client's full name, email address and exact quoted amount — an
// unauthenticated PII leak — and produced a live, signed PayFast redirect for someone else's
// booking. Now gated behind the same access_token every other tracking route requires.
router.post('/api/public/bookings/:id/pay', ipRateLimiter, mutateRateLimiter, requireBookingAccessToken, (req, res) => {
    const { payment_type } = req.body; // Expects 'DEPOSIT' or 'FULL'
    console.log(`[DEBUG] POST /api/public/bookings/${req.params.id}/pay - Type: ${payment_type}`);

    if (!payment_type || !['DEPOSIT', 'FULL'].includes(payment_type)) {
        return res.status(400).json({ success: false, message: 'Invalid payment type. Must be DEPOSIT or FULL.' });
    }

    db.get("SELECT * FROM bookings WHERE id = ?", [req.params.id], (err, row) => {
        if (err || !row) return res.status(404).json({ success: false, message: 'Booking not found.' });

        try {
            // Status gate: only allow payment for ACCEPTED or CONFIRMED bookings
            const status = (row.status || '').toUpperCase();
            if (!['ACCEPTED', 'CONFIRMED'].includes(status)) {
                console.log(`[DEBUG] Pay failed: status is ${status}`);
                return res.status(400).json({ success: false, message: `Payment not available — booking status is ${status}. Quote must be accepted first.` });
            }

            // Duplicate payment guard
            const payStatus = (row.payment_status || 'UNPAID').toUpperCase();
            if (payStatus === 'PAID') {
                console.log(`[DEBUG] Pay failed: already paid`);
                return res.status(400).json({ success: false, message: 'This booking has already been fully paid.' });
            }
            // P2-14: Deposit can only be paid from UNPAID state. DEPOSIT_PAID, PARTIALLY_PAID etc.
            // should proceed to balance/full payment only — not re-pay the deposit.
            if (payment_type === 'DEPOSIT' && payStatus !== 'UNPAID') {
                console.log(`[DEBUG] Pay failed: deposit attempted when payStatus=${payStatus}`);
                return res.status(400).json({ success: false, message: payStatus === 'DEPOSIT_PAID'
                    ? 'A deposit has already been paid. You can only pay the remaining balance.'
                    : `Deposit payment is not available for a booking with status ${payStatus}.` });
            }

            // Server-side amount calculation — query payment_schedules for milestone-aware amounts
            let baseAmt = 0;
            if (row.quote_amount) {
                baseAmt = parseFloat(row.quote_amount.replace(/[^0-9.]/g, ''));
            }
            if (isNaN(baseAmt) || baseAmt <= 0) {
                console.log(`[DEBUG] Pay failed: invalid amount ${row.quote_amount}`);
                return res.status(400).json({ success: false, message: 'Invalid quote amount. Please contact management.' });
            }

            getPaymentSchedulesForPayfastInit(
                row.id,
                (schedErr, schedules) => {
                try {
                    let amt = baseAmt;
                    let milestoneDesc = 'Full Payment';

                    if (!schedErr && schedules && schedules.length > 0) {
                        if (payment_type === 'DEPOSIT') {
                            amt = parseFloat(schedules[0].expected_amount);
                            milestoneDesc = schedules[0].description;
                        } else if (payStatus === 'DEPOSIT_PAID') {
                            amt = schedules.reduce((sum, s) => sum + parseFloat(s.expected_amount), 0);
                            milestoneDesc = 'Balance Payment';
                        }
                    } else {
                        if (payment_type === 'DEPOSIT') { amt = baseAmt / 2; milestoneDesc = 'Deposit'; }
                        else if (payStatus === 'DEPOSIT_PAID') { amt = baseAmt / 2; milestoneDesc = 'Balance'; }
                    }

                    // Derive the public base URL so PayFast's ITN callback always reaches this server.
                    // Set BASE_URL in .env for production (e.g. https://thabisomhlongo.com).
                    // When tunnelling locally (ngrok / cloudflared) the forwarded host header is used automatically.
                    const proto = req.get('x-forwarded-proto') || req.protocol;
                    const host  = req.get('x-forwarded-host')  || req.get('host');
                    const baseUrl = (process.env.BASE_URL || `${proto}://${host}`).replace(/\/$/, '');

                    const isPortal = req.body.return_path === 'portal';
                    const clientName = row.name || 'Client';

                    const pfData = {
                        merchant_id: process.env.PAYFAST_MERCHANT_ID || '10000100',
                        merchant_key: process.env.PAYFAST_MERCHANT_KEY || '46f0cd694581a',
                        return_url: isPortal ? `${baseUrl}/booking?id=${row.id}&payment=success` : `${baseUrl}/?track=${row.id}&payment=success`,
                        cancel_url: isPortal ? `${baseUrl}/booking?id=${row.id}&payment=cancel`  : `${baseUrl}/?track=${row.id}&payment=cancel`,
                        notify_url: `${baseUrl}/api/payment/webhook/payfast`,
                        name_first: (clientName.split(' ')[0] || '').substring(0, 100),
                        name_last: (clientName.split(' ').slice(1).join(' ') || '').substring(0, 100),
                        email_address: row.email,
                        m_payment_id: `${row.id}_${payment_type}`,
                        amount: amt.toFixed(2),
                        item_name: `Booking ${row.id} - ${row.event_name || row.event_type || 'Event'} - ${milestoneDesc}`.substring(0, 100).replace(/[^a-zA-Z0-9.\- ]/g, '').replace(/\s+/g, ' ')
                    };

                    // Remove empty or null values to ensure signature matches submitted form data
                    Object.keys(pfData).forEach(key => {
                        if (pfData[key] === '' || pfData[key] === null || pfData[key] === undefined) {
                            delete pfData[key];
                        }
                    });

                    const passphrase = process.env.PAYFAST_PASSPHRASE || null;
                    pfData.signature = generatePayFastSignature(pfData, passphrase);

                    const pfHost = process.env.PAYFAST_URL || 'https://sandbox.payfast.co.za/eng/process';

                    console.log(`[PayFast] Payment initiated: Booking #${row.id}, Type: ${payment_type}, Amount: R${amt.toFixed(2)}`);
                    res.json({ success: true, pfData: pfData, pfHost: pfHost });
                } catch (ex) {
                    console.error("Pay Route Error:", ex);
                    res.status(500).json({ success: false, message: 'Internal server error.' });
                }
            });
        } catch (ex) {
            console.error("Pay Route Error:", ex);
            res.status(500).json({ success: false, message: 'Internal server error.' });
        }
    });
});

// PUBLIC — client e-signs the contract online (typed-name acknowledgement, two-party model).
// Email-verified like accept-quote (Gap 1 accepted risk). Records the client signature; the admin
// then countersigns via PUT /contract/sign to finalise. The contract PDF is already served
// statically, so this endpoint only captures intent + attribution.
router.post('/api/public/bookings/:id/contract/sign', mutateRateLimiter, ipRateLimiter, requireBookingAccessToken, (req, res) => {
    const bookingId = req.params.id;
    const email = req.trackingEmail;
    const signatoryName = asBookingText(req.body.signatory_name);
    const agreed = req.body.agreed === true || req.body.agreed === 'true';

    if (!agreed) return res.status(400).json({ success: false, message: 'You must confirm your agreement to sign.' });
    if (signatoryName.length < 2 || signatoryName.length > 120) {
        return res.status(400).json({ success: false, message: 'Please enter your full legal name.' });
    }
    const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || 'unknown';

    db.get("SELECT id, email FROM bookings WHERE id = ?", [bookingId], (err, booking) => {
        if (err || !booking) return res.status(404).json({ success: false, message: 'Booking not found.' });
        db.get("SELECT status, is_frozen, signed_by_client_at, pdf_url, content_hash FROM contracts WHERE booking_id = ?", [bookingId], (cErr, contract) => {
            if (cErr) return res.status(500).json({ success: false, message: cErr.message });
            if (!contract) return res.status(404).json({ success: false, message: 'No contract is available for this booking yet.' });
            if (contract.is_frozen === 1 || contract.status === 'signed') {
                return res.status(400).json({ success: false, message: 'This contract has already been finalised.' });
            }
            if (contract.status !== 'sent') {
                return res.status(400).json({ success: false, message: 'This contract is not ready for signing yet. Please wait for it to be sent to you.' });
            }
            if (contract.signed_by_client_at) {
                return res.status(409).json({ success: false, message: 'You have already signed this contract. It is now awaiting our countersignature.' });
            }

            // Bind the signature to the exact document signed: hash the actual PDF bytes on disk (works
            // for both generated and uploaded contracts) so the signed version is provable and any later
            // change to the file is detectable. Stored inside client_signature_data alongside attribution.
            let signedFileHash = null;
            try {
                if (contract.pdf_url) {
                    const cpath = resolveDocsPath('contracts', contract.pdf_url);
                    if (fs.existsSync(cpath)) signedFileHash = crypto.createHash('sha256').update(fs.readFileSync(cpath)).digest('hex');
                }
            } catch (hErr) { console.error('[Contract Sign] Could not hash PDF for booking #' + bookingId + ':', hErr.message); }

            // Signature = intent + attribution, bound to the document. Store the typed name,
            // server-stamped time, IP, UA, the signed PDF's hash, and the content_hash of record.
            const signatureData = JSON.stringify({
                name: signatoryName,
                signed_at: new Date().toISOString(),
                ip: clientIp,
                user_agent: (req.headers['user-agent'] || '').slice(0, 300),
                signed_file_sha256: signedFileHash,
                content_hash_at_signing: contract.content_hash || null
            });
            db.run(
                `UPDATE contracts
                 SET client_signature_data = ?, signed_by_client_at = CURRENT_TIMESTAMP, client_ip_address = ?, updated_at = CURRENT_TIMESTAMP
                 WHERE booking_id = ? AND signed_by_client_at IS NULL`,
                [signatureData, clientIp, bookingId],
                function (uErr) {
                    if (uErr) return res.status(500).json({ success: false, message: uErr.message });
                    if (this.changes === 0) {
                        return res.status(409).json({ success: false, message: 'You have already signed this contract.' });
                    }
                    db.run(`INSERT INTO audit_log (table_name, record_id, action, new_values, changed_by, ip_address)
                            VALUES ('contracts', ?, 'CLIENT_SIGNED', ?, ?, ?)`,
                        [bookingId, JSON.stringify({ signatory_name: signatoryName }), email, clientIp], () => {});
                    // Notify the admin that the client signed and a countersignature is due.
                    getNotificationEmail().then(notifEmail => notifEmail && sendEmail({
                        to: notifEmail,
                        subject: `Contract signed by client — Booking #${bookingId}`,
                        htmlContent: emailComponents.renderSystemEmail({
                            preheaderText: `${signatoryName} signed the contract for booking #${bookingId} — countersignature due.`,
                            category: 'Contracts & Signatures',
                            severity: 'action',
                            leadFact: `<strong style="color:#FAFAFA;">${emailComponents.esc(signatoryName)}</strong> has signed the contract for booking <strong style="color:#FAFAFA;">#${bookingId}</strong> online.`,
                            bodyHtml: `<p style="margin:0; color:#E6E6E6;">Log in to the admin panel to countersign and finalise it.</p>`
                        }),
                        preWrapped: true,
                        titleOverride: 'Client Signed Contract',
                        trigger_event: 'Admin: Client Signed Contract'
                    })).catch(() => {});
                    res.json({ success: true, message: 'Thank you — your signature has been recorded. Our team will countersign to finalise the contract.' });
                }
            );
        });
    });
});

// Quote revision request (public) — client requests extension or revision of a QUOTED booking
router.post('/api/public/bookings/:id/quote-revision-request', mutateRateLimiter, ipRateLimiter, requireBookingAccessToken, async (req, res) => {
    const { request_type, message } = req.body;
    const email = req.trackingEmail;
    if (!request_type || !['extension', 'revision'].includes(request_type)) {
        return res.status(400).json({ success: false, message: 'request_type must be "extension" or "revision".' });
    }
    if (!message || message.trim().length < 10) {
        return res.status(400).json({ success: false, message: 'Please provide more detail about your request (at least 10 characters).' });
    }

    db.get("SELECT * FROM bookings WHERE id = ?", [req.params.id], async (err, row) => {
        if (err || !row) return res.status(404).json({ success: false, message: 'Booking not found.' });
        // Gap 4 (Phase 2): 'RESPONDED' was a legacy status retired in Phase 2 — only 'QUOTED' is valid.
        if (row.status !== 'QUOTED') {
            return res.status(400).json({ success: false, message: 'Quote revision requests can only be made on bookings in QUOTED status.' });
        }

        const typeLabel = request_type === 'extension' ? 'Quote Expiry Extension' : 'Quote Revision';
        const notifEmail = await getNotificationEmail();

        const adminHtml = emailComponents.renderSystemEmail({
            preheaderText: `${typeLabel} request from ${row.name} for booking #${row.id}.`,
            category: 'Quotes & Proposals',
            severity: 'action',
            leadFact: `A client has submitted a <strong style="color:#D4AF37;">${typeLabel}</strong> request for booking <strong style="color:#FAFAFA;">#${row.id}</strong>.`,
            bodyHtml: `<p style="margin:0; color:#B0B0B0; font-size:12px;">Please review this request in the admin panel and respond to the client accordingly.</p>`,
            cards: [{
                rows: [
                    { label: 'Client', value: row.name, mono: false },
                    { label: 'Email', value: row.email },
                    { label: 'Event', value: `${row.event_name || row.event_type} on ${row.date}`, mono: false },
                    { label: 'Quote Amount', value: `R ${parseFloat(row.quote_amount || 0).toFixed(2)}`, highlight: true },
                    { label: 'Quote Expiry', value: row.quote_expiry_date || 'Not set' },
                    { label: 'Request Type', value: typeLabel, mono: false, highlight: true },
                    { label: 'Client Message', value: message.trim(), mono: false }
                ]
            }]
        });

        try {
            // Log the client's request as a booking note first (critical operation)
            const noteText = `[${typeLabel} Request]\n"${message.trim()}"`;
            await insertBookingNoteFromTracker(row.id, encodeUserHtml(noteText));

            // Send email notifications asynchronously in the background (no await)
            sendEmail({
                to: notifEmail,
                subject: `[ACTION REQUIRED] ${typeLabel} Request – Booking #${row.id}`,
                htmlContent: adminHtml,
                preWrapped: true,
                titleOverride: `${typeLabel} Request`,
                trigger_event: 'Booking: Quote Revision Request'
            }).catch(e => console.error('[Quote Revision Request] Admin email notification failed:', e.message));

            getEmailFooterContext().then(async ({ socialLinks }) => {
                const banner = await bannerRegistry.resolveBanner('custom_response');
                return sendEmail({
                    to: row.email,
                    subject: `We've Received Your Request – Booking #${row.id}`,
                    htmlContent: emailComponents.renderPremiumEmail({
                        preheaderText: `We've received your request for booking #${row.id}.`,
                        bannerSrc: banner?.src, bannerAlt: banner?.alt, subtitle: banner?.subtitle,
                        headline: banner?.headline || 'Request Received',
                        greeting: `Hi ${row.name},`,
                        bodyHtml:
                            `We've received your <strong style="color:#D4AF37;">${typeLabel.toLowerCase()}</strong> request for booking <strong style="color:#FAFAFA;">#${row.id}</strong>. Our team will review your request and get back to you shortly.` +
                            `<p style="margin:10px 0 0; color:#B0B0B0; font-size:12px;">Your request: "${message.trim()}"</p>`,
                        socialLinks
                    }),
                    preWrapped: true,
                    titleOverride: 'Request Received',
                    trigger_event: 'Booking: Quote Revision Acknowledgement'
                });
            }).catch(e => console.error('[Quote Revision Request] Client email acknowledgement failed:', e.message));

            res.json({ success: true, message: 'Your request has been recorded. We will be in touch shortly.' });
        } catch (dbErr) {
            console.error('[Quote Revision Request] DB insert failed:', dbErr.message);
            res.status(500).json({ success: false, message: 'Failed to record your request in the database.' });
        }
    });
});

// Accept quote (public) — client formally accepts a sent quote
// Gap 1 (Phase 2, resolved 2026-07-16): acceptance used to be authenticated by matching the stored
// email address alone. Now gated behind requireBookingAccessToken — the caller must have already
// proven control of the booking's inbox via the /track/request-code + /track/verify-code OTP flow.
// Phase 5 (HOUSEKEEPING-NOTES.md): moved from app.js verbatim, byte-identical — single-consumer
// (the accept-quote route directly below).
async function sendAdminQuoteAcceptedNotification(booking) {
    const notifEmail = await getNotificationEmail();
    const { id, name, email, event_name, event_type, date } = booking;
    const body = emailComponents.renderSystemEmail({
        preheaderText: `${name} accepted the quote for booking #${id} — invoice auto-generated.`,
        category: 'Quotes & Proposals',
        severity: 'action',
        leadFact: `<strong style="color:#FAFAFA;">${emailComponents.esc(name)}</strong> (${email}) has accepted the quote for booking <strong style="color:#FAFAFA;">#${id}</strong>.`,
        bodyHtml: `<p style="margin:0; color:#E6E6E6;">An invoice has been auto-generated. Log in to confirm the booking.</p>`,
        cards: [{ rows: [{ label: 'Event', value: `${event_name || event_type} on ${date}`, mono: false }] }]
    });
    await sendEmail({ to: notifEmail, subject: `Invoice Issued – Booking #${id} Awaiting Payment`,
        htmlContent: body, preWrapped: true, replyTo: email, titleOverride: 'Invoice Issued – Action Required',
        trigger_event: 'Admin: Quote Accepted Notification' });
}

router.post('/api/public/bookings/:id/accept-quote', mutateRateLimiter, ipRateLimiter, requireBookingAccessToken, async (req, res) => {
    const { terms_agreed } = req.body;
    const email = req.trackingEmail;
    if (!terms_agreed) return res.status(400).json({ success: false, message: 'You must agree to the terms and conditions to accept this quote.' });

    // Client-supplied and written straight to bookings.vat_number, which the admin panel renders.
    // Same treatment as every other public free-text field: bounded and output-encoded.
    const vat_number = asBookingText(req.body.vat_number);
    if (vat_number.length > 30) return res.status(400).json({ success: false, message: 'VAT number must be under 30 characters.' });

    const bookingId = req.params.id;
    const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || 'unknown';

    try {
        const row = await dbGet("SELECT * FROM bookings WHERE id = ?", [bookingId]);
        if (!row) return res.status(404).json({ success: false, message: 'Booking not found.' });

        // Gap 4 (Phase 2): 'RESPONDED' was a legacy status retired in Phase 2 — only 'QUOTED' is valid here.
        if (row.status !== 'QUOTED') {
            return res.status(400).json({ success: false, message: `Cannot accept quote – current status is ${row.status}.` });
        }
        // quote_amount is written by the quote route as finalTotal.toFixed(2), so a zero quote is the
        // string "0.00" — the old `=== '0'` check never caught it.
        const quotedTotal = parseFloat(row.quote_amount);
        if (!Number.isFinite(quotedTotal) || quotedTotal <= 0) {
            return res.status(400).json({ success: false, message: 'No quote has been issued for this booking yet.' });
        }
        // Expiry is compared in the business's own timezone. This used to use the UTC date, so between
        // midnight and 02:00 SAST a quote that expired yesterday was still acceptable.
        if (row.quote_expiry_date) {
            const todayLocal = moment().tz('Africa/Johannesburg').format('YYYY-MM-DD');
            if (row.quote_expiry_date < todayLocal) {
                return res.status(410).json({ success: false, message: `This quote expired on ${row.quote_expiry_date}. Please contact us to request a revised quote.` });
            }
        }

        // Acceptance is one atomic unit: the status flip, the quotation stamp, the audit row and the
        // payment schedule. Previously these were four independent statements and two of them swallowed
        // their errors, so a schedule failure left an ACCEPTED booking with no payment plan — and
        // generateInvoice() then rendered an invoice PDF with no split.
        const outcome = await withDbTransaction(async () => {
            try {
                await dbRun("BEGIN IMMEDIATE");
            } catch (beginErr) {
                console.error('[Accept-Quote] BEGIN IMMEDIATE failed:', beginErr.message);
                return { status: 503, body: { success: false, message: 'We could not record your acceptance just now. Please try again in a moment.' } };
            }
            try {
                // Compare-and-swap on the status. The check above is a read, and the event loop yields
                // between it and this write, so two concurrent acceptances could both pass it. Guarding
                // the UPDATE with `AND status = 'QUOTED'` makes exactly one of them win.
                //
                // A deposit confirms a booking. Re-accepting after a re-quote therefore lands back on
                // CONFIRMED when money has already been paid, rather than demoting a part-paid booking
                // to ACCEPTED. Expressed as a CASE so the rule stays race-free inside the same statement.
                const upd = await dbRun(
                    `UPDATE bookings SET
                            status = CASE WHEN COALESCE(amount_paid, 0) > 0 THEN 'CONFIRMED' ELSE 'ACCEPTED' END,
                            accepted_at = CURRENT_TIMESTAMP, acceptance_ip = ?,
                            acceptance_agreed_at = CURRENT_TIMESTAMP, vat_number = COALESCE(?, vat_number)
                     WHERE id = ? AND status = 'QUOTED'`,
                    [clientIp, encodeUserHtml(vat_number) || null, bookingId]
                );
                if (upd.changes === 0) {
                    await dbRun("ROLLBACK").catch(() => {});
                    return { status: 409, body: { success: false, message: 'This quote has already been accepted.' } };
                }

                await markQuotationAcceptedAsync(bookingId);

                // P3-3: Audit log for quote acceptance
                await dbRun(`INSERT INTO audit_log (table_name, record_id, action, new_values, changed_by, change_timestamp, ip_address)
                        VALUES ('bookings', ?, 'QUOTE_ACCEPTED', ?, ?, CURRENT_TIMESTAMP, ?)`,
                    [bookingId, JSON.stringify({ accepted_by: email, ip: clientIp, amount: row.quote_amount }), email, clientIp]);

                // Auto-create the default 50/50 split only when there is no LIVE UNPAID plan.
                // F3: both rows must exist before generateInvoice() reads payment_schedules for the PDF.
                //
                // A surviving PAID row must NOT suppress creation. Re-quoting an ACCEPTED booking
                // supersedes every unpaid milestone but leaves the paid ones (the money moved), and the
                // old "does a plan exist?" count treated that paid deposit as an admin-configured plan —
                // so a client who paid R500 on a R1000 quote, re-quoted to R5000, ended up owing R4500
                // against no milestones at all. Detection therefore excludes 'paid' too.
                //
                // The split covers the OUTSTANDING balance, measured against the paid rows'
                // expected_amount rather than bookings.amount_paid: the invariant below is defined over
                // expected_amount, and expected_amount is what the invoice PDF renders.
                //
                // Invariant: SUM(expected_amount) over live (non-superseded, non-cancelled) rows == total_amount.
                // Shared with the admin QUOTED→ACCEPTED path (applyStatusChange) so the two never diverge.
                const totalAmount = quotedTotal || parseFloat(row.total_amount) || 0;
                await autoBuildDepositBalanceSchedule(bookingId, totalAmount, row.date || row.event_date);

                // Read back what the CASE above actually resolved to, so the response and the client
                // email report the real status rather than assuming ACCEPTED.
                const settled = await dbGet("SELECT status FROM bookings WHERE id = ?", [bookingId]);

                await dbRun("COMMIT");
                return { ok: true, newStatus: (settled && settled.status) || 'ACCEPTED' };
            } catch (txErr) {
                await dbRun("ROLLBACK").catch(() => {});
                console.error('[Accept-Quote] Failed — rolled back, booking still QUOTED (#' + bookingId + '):', txErr.message);
                return { status: 500, body: { success: false, message: 'We could not record your acceptance. Please try again.' } };
            }
        });

        if (!outcome.ok) return res.status(outcome.status).json(outcome.body);
        const newStatus = outcome.newStatus;

        // ---- Side effects, after the commit. None of these may prevent the response. ----
        // generateInvoice() and generateContract() open their own guarded transactions, so they must
        // run outside the one above or they would deadlock behind it in the queue.
        await syncBookingToCalendar(bookingId).catch(e => console.error('[Accept-Quote] Calendar sync failed:', e.message));

        // Gap 2 (Phase 2): Track whether invoice generation succeeds so we can give an honest
        // client-facing message. The acceptance is NOT rolled back if the invoice fails — the booking
        // is accepted; only the invoice email promise changes.
        let invoiceGenerated = false;
        try {
            // Client is actively expecting the invoice — generate AND email it (autoSend), unlike the
            // admin acceptance path which produces a DRAFT for review first.
            await generateInvoice(bookingId, { autoSend: true });
            invoiceGenerated = true;
        } catch(invErr) {
            console.error('[Invoice] Auto-generation failed during acceptance (booking #' + bookingId + '):', invErr);
        }

        // Auto-generate a DRAFT booking contract alongside the invoice. Non-blocking —
        // acceptance must never fail because of contract generation; it's a draft for admin review.
        try { await generateContract(bookingId); }
        catch(cErr) { console.error('[Auto-Contract] Generation failed during acceptance (booking #' + bookingId + '):', cErr.message); }

        // Guarded: this used to be a bare `await` inside a sqlite3 callback, where a rejection became
        // an unhandled rejection and the client never received a response for a booking already accepted.
        await sendQuoteAcceptedEmail({ ...row, status: newStatus }, { invoiceGenerated })
            .catch(e => console.error('[Accept-Quote] Client confirmation email failed:', e.message));
        sendAdminQuoteAcceptedNotification({ ...row, status: newStatus })
            .catch(e => console.error('Admin quote-accepted notification failed:', e.message));

        // Gap 2: Conditionally tell the client about the invoice based on whether it was generated.
        const acceptMsg = invoiceGenerated
            ? 'Quote accepted successfully. Your invoice has been generated and emailed to you.'
            : 'Quote accepted successfully. Our team will be in touch shortly with your invoice details.';
        res.json({ success: true, message: acceptMsg, newStatus, invoice_generated: invoiceGenerated });
    } catch (e) {
        console.error('[Accept-Quote] Unexpected failure (booking #' + bookingId + '):', e);
        res.status(500).json({ success: false, message: 'We could not process your acceptance. Please contact us directly.' });
    }
});

// Phase 5 (HOUSEKEEPING-NOTES.md): both moved from app.js verbatim, byte-identical —
// single-consumer (the booking-intake route directly below).
// --- Legacy Duration Parser ---
function parseDurationMins(durationRaw) {
    if (!durationRaw) return 60;
    if (typeof durationRaw === 'number') return durationRaw;
    const str = String(durationRaw).toLowerCase().trim();
    if (/^\d+$/.test(str)) return parseInt(str, 10);

    let mins = 0;
    const hrsMatch = str.match(/(\d+)\s*h/);
    if (hrsMatch) mins += parseInt(hrsMatch[1], 10) * 60;
    const minMatch = str.match(/(\d+)\s*m/);
    if (minMatch) mins += parseInt(minMatch[1], 10);

    return mins > 0 ? mins : 60;
}

// Free-text columns that have no DB-level length limit. Anything not listed here is either
// validated by its own rule (email/cell/date) or is not a client-supplied string.
const BOOKING_TEXT_LIMITS = {
    company: 150, event_name: 200, event_location: 200, venue_address: 300,
    city: 100, country: 100, venue_type: 60, event_type: 60,
    audience_size: 40, audience_demographic: 120, budget_range: 60,
    performance_slot: 40, performance_duration: 40,
    vat_number: 30, source: 100, referrer: 500,
    // Was the one client-supplied free-text field with no cap (real Google Place IDs run
    // ~27-100 chars; 300 is generous headroom) — found in an end-to-end booking-flow audit.
    venuePlaceId: 300,
    // Alternative/backup dates, content-suitability note, optional self-reported lead source —
    // all optional, no required-field check added for any of them.
    alternative_dates: 300, content_notes: 500, heard_about: 200
};

router.post('/api/public/bookings', ipRateLimiter, bookingRateLimiter, async (req, res) => {
    let {
        name, company, email, cell,
        event_name, event_date, event_start_time, performance_slot, performance_duration,
        event_location, venue_address, city, country, venue_type,
        event_type, audience_size, audience_demographic, budget_range, travel_accommodation, message,
        alternative_dates, content_notes, heard_about,
        services, venuePlaceId, popia_consent, vat_number
    } = req.body;
    // req.body.policy_version is deliberately ignored — see CURRENT_POLICY_VERSION.

    // Normalize every free-text field once, up-front. Downstream code (validation, the INSERT
    // params, findOrCreateClient) then works on trimmed strings only.
    name = asBookingText(name);               company = asBookingText(company);
    email = asBookingText(email);             cell = asBookingText(cell);
    event_name = asBookingText(event_name);   event_date = asBookingText(event_date);
    event_start_time = asBookingText(event_start_time);
    performance_slot = asBookingText(performance_slot);
    performance_duration = asBookingText(performance_duration);
    event_location = asBookingText(event_location); venue_address = asBookingText(venue_address);
    city = asBookingText(city);               country = asBookingText(country);
    venue_type = asBookingText(venue_type);   event_type = asBookingText(event_type);
    audience_size = asBookingText(audience_size);
    audience_demographic = asBookingText(audience_demographic);
    budget_range = asBookingText(budget_range);
    alternative_dates = asBookingText(alternative_dates);
    content_notes = asBookingText(content_notes);
    heard_about = asBookingText(heard_about);
    message = asBookingText(message);         vat_number = asBookingText(vat_number);
    venuePlaceId = asBookingText(venuePlaceId);

    // Bug fix: `message` ("Additional Notes") is explicitly labelled optional on the public form
    // (index.html) and the client-side validator deliberately never blocks on it — but this check
    // and the length-minimum below still required it server-side, so a client leaving it blank sailed
    // through all 4 steps and only got rejected at final submit with a generic, unrouted error.
    if (!name || !email || !cell || !event_date || !event_location || !event_type) {
        return res.status(400).json({ success: false, message: 'Missing required booking fields.' });
    }

    // Field length and format validation
    if (name.length < 2 || name.length > 150)
        return res.status(400).json({ success: false, message: 'Name must be between 2 and 150 characters.' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200)
        return res.status(400).json({ success: false, message: 'Invalid email address.' });
    const cleanCell = cell.replace(/[\s\-().]/g, '');
    if (!/^\+?[0-9]{7,15}$/.test(cleanCell))
        return res.status(400).json({ success: false, message: 'Please enter a valid phone number (e.g. +27821234567 or +442071234567).' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(event_date))
        return res.status(400).json({ success: false, message: 'Invalid event date format.' });
    // Only enforce a minimum when something was actually typed — matches the "optional" label.
    if (message && message.length < 10)
        return res.status(400).json({ success: false, message: 'Please provide a message of at least 10 characters, or leave it blank.' });
    if (message.length > 2000)
        return res.status(400).json({ success: false, message: 'Message must be under 2000 characters.' });

    // Cap every remaining free-text column. Without this a single request can write megabytes
    // into TEXT columns that have no length constraint.
    const overLimit = Object.entries(BOOKING_TEXT_LIMITS)
        .find(([field, max]) => asBookingText(req.body[field]).length > max);
    if (overLimit) {
        return res.status(400).json({ success: false, message: `The ${overLimit[0].replace(/_/g, ' ')} field must be under ${overLimit[1]} characters.` });
    }

    // Calendar-real date, and never in the past. Previously the only date sanity check was the
    // per-service lead time, which is skipped entirely for the 13 services with
    // booking_lead_time_days = 0 — so a backdated event_date was accepted and saved.
    const eventMoment = moment(event_date, 'YYYY-MM-DD', true);
    if (!eventMoment.isValid())
        return res.status(400).json({ success: false, message: 'Invalid event date format.' });
    if (eventMoment.isBefore(moment().startOf('day')))
        return res.status(400).json({ success: false, message: 'The event date cannot be in the past.' });
    if (eventMoment.isAfter(moment().add(5, 'years')))
        return res.status(400).json({ success: false, message: 'The event date is too far in the future. Please contact us directly for bookings more than 5 years ahead.' });

    // Bug fix: MIN_ADVANCE_HOURS was previously enforced only by GET /api/public/availability (the
    // calendar's "too soon" warning) — never re-checked here, so a direct API call or an edited
    // hidden #bookDate value bypassed it entirely. Mirrors that endpoint's exact midnight-based
    // check (server.js ~6318) so a date the calendar already approved is never re-rejected here.
    const advanceHoursCheck = (new Date(event_date + 'T00:00:00') - new Date()) / (1000 * 60 * 60);
    if (advanceHoursCheck < MIN_ADVANCE_HOURS) {
        return res.status(400).json({ success: false, message: `Bookings require at least ${MIN_ADVANCE_HOURS} hours advance notice. Please choose a later date.` });
    }

    // event_start_time reaches moment(), addMinutesToTime() and the working-hours gate unvalidated.
    // A non-time value ("abc") produced "NaN:NaN" end times and an Invalid-date ISO conversion.
    if (event_start_time) {
        const tm = event_start_time.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
        if (!tm) return res.status(400).json({ success: false, message: 'Invalid event start time. Use HH:MM (24-hour), e.g. 19:30.' });
        event_start_time = `${tm[1].padStart(2, '0')}:${tm[2]}`; // zero-pad so string compares and moment() parsing are safe
    }

    // CRITICAL: the public form never sends event_start_time — it sends performance_slot
    // ("HH:MM–HH:MM", or the literal "All Day / Custom Hours"). Every conflict-detection query
    // (checkDateAvailability, hasCalendarConflict) keys off event_start_time, so leaving it null
    // made every public booking invisible to double-booking protection — two different clients
    // could book the same date/time, and the working-hours gate below (which only runs
    // `if (event_start_time)`) never ran at all. Derive it here, before any availability check,
    // so the booking's real window drives both the pre-check and the persisted row.
    let perfSlotStart = null, perfSlotEnd = null;
    if (performance_slot) {
        const slotMatch = performance_slot.match(/(\d{1,2}:\d{2})\s*[–\-]\s*(\d{1,2}:\d{2})/);
        if (slotMatch) {
            const padTime = (t) => { const [h, m] = t.split(':'); return `${h.padStart(2, '0')}:${m}`; };
            perfSlotStart = padTime(slotMatch[1]);
            perfSlotEnd = padTime(slotMatch[2]);
        }
    }
    if (!event_start_time && perfSlotStart) {
        event_start_time = perfSlotStart;
    }
    // A performance_slot that doesn't parse to a range (e.g. "All Day / Custom Hours") and no
    // explicit event_start_time means the client is asking to occupy the whole day — checked
    // against existing bookings/holds/events at step 3 below, same as any other all-day request.
    const isAllDayRequest = !event_start_time;

    if (!popia_consent) {
        return res.status(400).json({ success: false, message: 'POPIA consent is required to submit a booking request.' });
    }


    try {
        // ── Read-only gates run first ─────────────────────────────────────────────────────
        // findOrCreateClient() / findOrCreateVenueFromPlace() are the first statements in this
        // handler that WRITE. They used to run before service validation, lead-time, per-day,
        // quantity and calendar-conflict checks — so every 400/409 raised by those gates left an
        // orphan clients row (email is UNIQUE, poisoning the next legitimate signup) and an orphan
        // venues row behind. All rejections now happen before the first write.

        // 1. SECURE SERVICE VALIDATION & SNAPSHOTTING
        if (!services || !Array.isArray(services) || services.length === 0) {
            return res.status(400).json({ success: false, message: 'At least one service must be selected.' });
        }

        const svcIds = services.map(s => parseInt(s.service_id)).filter(id => !isNaN(id));
        if (svcIds.length === 0) {
            return res.status(400).json({ success: false, message: 'Invalid services provided.' });
        }

        const placeholders = svcIds.map(() => '?').join(',');
        const query = `SELECT * FROM services WHERE id IN (${placeholders})`;
        const dbServices = await new Promise((resolve, reject) => {
            db.all(query, svcIds, (err, rows) => {
                if (err) reject(err); else resolve(rows);
            });
        });

        let selectedServices = [];
        let calculatedBaseScope = 0;

        for (const inputSvc of services) {
            const srv = dbServices.find(s => s.id === parseInt(inputSvc.service_id));
            if (!srv || (srv.is_active !== undefined && srv.is_active === 0) || srv.is_deleted === 1) {
                return res.status(400).json({ success: false, message: `Service ID ${inputSvc.service_id} is invalid or inactive.` });
            }

            // Lead Time Validation
            if (srv.booking_lead_time_days > 0) {
                const today = moment().startOf('day');
                const eventDate = moment(event_date).startOf('day');
                const diffDays = eventDate.diff(today, 'days');
                if (diffDays < srv.booking_lead_time_days) {
                    return res.status(400).json({ success: false, message: `Booking for ${srv.name} requires at least ${srv.booking_lead_time_days} days advance notice.` });
                }
            }

            // Availability Rule Validation (per_day)
            if (srv.availability_rule === 'per_day') {
                const alreadyBooked = await new Promise((resolve) => {
                    db.get(`SELECT bs.id FROM booking_services bs
                            JOIN bookings b ON bs.booking_id = b.id
                            WHERE bs.service_id = ? AND b.date = ? AND b.status IN ('CONFIRMED', 'ACCEPTED', 'QUOTED')`,
                        [srv.id, event_date], (err, row) => resolve(row));
                });
                if (alreadyBooked) {
                    return res.status(409).json({ success: false, message: `The service ${srv.name} is already booked for ${event_date}.` });
                }
            }

            const model = srv.pricing_model || 'flat';
            const isFlat = model === 'flat' || model === 'flat_fee';
            const isPerMinute = model === 'per_minute';
            const isPerHour = model === 'per_hour';
            
            const rawDur = parseDurationMins(performance_duration);
            let qtyMinutes = 1; // Used as billable quantity now
            
            if (isPerMinute) qtyMinutes = rawDur;
            else if (isPerHour) qtyMinutes = Math.ceil(rawDur / 60);
            else if (!isFlat) qtyMinutes = parseInt(inputSvc.quantity_minutes) || 1; // Fallback for other models

            if (!isFlat) {
                const minQ = srv.min_quantity || 1;
                const maxQ = srv.max_quantity || 999999;
                if (qtyMinutes < minQ || qtyMinutes > maxQ) {
                    return res.status(400).json({ success: false, message: `Quantity for ${srv.name} must be between ${minQ} and ${maxQ}.` });
                }
            } else {
                qtyMinutes = 1; // Default to 1 unit for flat fee if not specified
            }

            const unitPrice = parseFloat(srv.base_price != null ? srv.base_price : (srv.default_price ?? 0));
            const lineTotal = isFlat ? unitPrice : (unitPrice * qtyMinutes); 
            
            calculatedBaseScope += lineTotal;
            selectedServices.push({
                service_id: srv.id,
                name: srv.name,
                quantity_minutes: qtyMinutes,
                unit_price: unitPrice,
                total_price: lineTotal,
                pricing_model: model
            });
        }

        // 2. OCCUPANCY WINDOW — a single duration now drives the working-hours gate, the conflict
        //    window and the persisted performance_end_time. These used to disagree: working hours
        //    were checked against the form's performance_duration while the stored end time (which
        //    later bookings are conflict-checked against) used the service-catalogue duration, so a
        //    booking could pass the gate and then persist an end time outside working hours.
        const maxServiceMins = dbServices.reduce((max, srv) => {
            const total = (parseInt(srv.performance_length_minutes) || 0)
                        + (parseInt(srv.setup_time_minutes) || 0);
            return Math.max(max, total);
        }, 0);
        const formMins = performance_duration ? parseDurationToMinutes(performance_duration) : 0;
        const durationMins = Math.max(maxServiceMins, formMins) || 120;
        const startTime = moment(`${event_date} ${event_start_time || '18:00'}`, 'YYYY-MM-DD HH:mm', true).toISOString();
        const endTime   = moment(startTime).add(durationMins, 'minutes').toISOString();

        // 3. DATE AVAILABILITY — holds, standalone events, already-booked dates.
        //    checkDateAvailability() calls back with (err) and no result on a DB error; resolving
        //    that as `undefined` used to throw on `.available` a line later.
        const availableResult = await new Promise((resolve, reject) => {
            checkDateAvailability(event_date, (err, result) => err ? reject(err) : resolve(result));
        });
        if (!availableResult.available) {
            return res.status(409).json({ success: false, message: 'The selected date is no longer available.' });
        }
        // An all-day request ("All Day / Custom Hours", or no slot given) can't share a date with
        // any existing timed booking — checkDateAvailability() only rejects whole-day holds/events/
        // bookings above; a same-day timed booking still comes back as `available: true` with a
        // busy range, which is fine for another timed request but not for one asking for the whole day.
        if (isAllDayRequest && availableResult.busy_ranges && availableResult.busy_ranges.length > 0) {
            return res.status(409).json({ success: false, message: 'The selected date already has a booking on it and is not available for a full-day request.' });
        }

        // 4. DUPLICATE CHECK: same email + same date with an already-active booking
        const existingBooking = await new Promise((resolve, reject) =>
            db.get(
                `SELECT id FROM bookings
                 WHERE lower(email) = lower(?) AND date = ? AND status NOT IN ('CANCELLED','EXPIRED')
                 LIMIT 1`,
                [email, event_date],
                (err, row) => err ? reject(err) : resolve(row)
            )
        );
        if (existingBooking) {
            return res.status(409).json({
                success: false,
                existing_id: existingBooking.id,
                message: `You already have an active booking (#${existingBooking.id}) for this date. Please track that booking, or contact us if you need to make changes.`
            });
        }

        // 5. Server-side working hours enforcement (timed bookings only)
        if (event_start_time) {
            const endHHMM = addMinutesToTime(event_start_time, durationMins);
            const wh = await isWithinWorkingHours(event_date, event_start_time, endHHMM);
            if (!wh.allowed) {
                return res.status(400).json({ success: false, message: wh.reason });
            }
        }

        // 6. Time overlap against the busy ranges from the availability check
        if ((performance_slot || event_start_time) && availableResult.busy_ranges && availableResult.busy_ranges.length > 0) {
            // L2: compare by minutes, not lexically. performance_slot comes from the public form and
            // may be non-zero-padded (e.g. "9:00"), where the string compare "9:00" < "10:00" is false
            // and would miss a real overlap. toMin() normalizes both sides.
            const toMin = (t) => { const [h, m] = String(t).split(':').map(Number); return (h || 0) * 60 + (m || 0); };
            const overlap = (s1, e1, s2, e2) => (toMin(s1) < toMin(e2)) && (toMin(s2) < toMin(e1));
            let from, to;
            // Prefer performance_slot ("HH:MM–HH:MM") for the most accurate window
            if (performance_slot && performance_slot.includes('–')) {
                const slotParts = performance_slot.split('–');
                from = slotParts[0].trim();
                to = slotParts[1].trim();
            } else if (event_start_time) {
                from = event_start_time;
                to = addMinutesToTime(from, durationMins);
            }

            let conflict = false;
            if (from && to) {
                availableResult.busy_ranges.forEach(r => {
                    if (overlap(from, to, r.start, r.end)) {
                        conflict = true;
                    }
                });
            }

            if (conflict) {
                return res.status(409).json({ success: false, message: 'The selected time slot overlaps with a blocked period or another booking.' });
            }
        }

        // 7. CALENDAR CONFLICT DETECTION (local holds + bookings + Google free/busy)
        const isBusy = await hasCalendarConflict(startTime, endTime);
        if (isBusy) {
            return res.status(409).json({
                success: false,
                message: 'This date and time are currently unavailable on Thabiso\'s schedule. Please select another slot or contact us for special inquiries.'
            });
        }

        // 8. NORMALIZE RELATIONAL CORE ENTITIES — the first writes in this handler.
        const clientId = await findOrCreateClient(name, email, cell, company, vat_number);
        const venueId = await findOrCreateVenueFromPlace(event_location, venue_address, city, country, venuePlaceId);

        let initialQuoteAmountStr = `R ${calculatedBaseScope.toFixed(2)}`;
        let initialTotalAmount = calculatedBaseScope;
        let paymentStatus = 'UNPAID';

        // Default expiry: event date minus 14 days; overridden when admin generates the actual quote
        const defaultQuoteExpiry = moment(event_date).subtract(14, 'days').format('YYYY-MM-DD');

        // 9. SAVE TO DATABASE — booking + all child rows are committed atomically inside
        //    BEGIN IMMEDIATE, serialized against every other guarded transaction on the shared
        //    connection. Same-client multi-booking on the same day is allowed; date, time-overlap
        //    and duplicate rules are all re-checked inside the lock so two concurrent submissions
        //    cannot double-book a slot.
        const outcome = await withDbTransaction(async () => {
            try {
                await dbRun("BEGIN IMMEDIATE");
            } catch (beginErr) {
                console.error('[Booking] BEGIN IMMEDIATE failed:', beginErr.message);
                return { status: 500, body: { success: false, message: 'Database error while saving booking.' } };
            }

            try {
                // Re-check availability inside the lock to close the race window. A DB error here is
                // NOT the same as an unavailable date — reporting "no longer available" on a transient
                // SQLITE_BUSY sends the client away from a date that is in fact free.
                let lockedAvail;
                try {
                    lockedAvail = await new Promise((resolve, reject) =>
                        checkDateAvailability(event_date, (e, r) => e ? reject(e) : resolve(r)));
                } catch (availErr) {
                    await dbRun("ROLLBACK").catch(() => {});
                    console.error('[Booking] In-lock availability re-check failed:', availErr.message);
                    return { status: 503, body: { success: false, message: 'We could not confirm availability just now. Please try again in a moment.' } };
                }
                if (!lockedAvail.available) {
                    await dbRun("ROLLBACK").catch(() => {});
                    return { status: 409, body: { success: false, message: 'The selected date is no longer available.' } };
                }
                if (isAllDayRequest && lockedAvail.busy_ranges && lockedAvail.busy_ranges.length > 0) {
                    await dbRun("ROLLBACK").catch(() => {});
                    return { status: 409, body: { success: false, message: 'The selected date already has a booking on it and is not available for a full-day request.' } };
                }

                // F1: re-run the time-overlap check INSIDE the write lock. skipGoogle=true keeps it to
                // fast local reads (no network call while holding BEGIN IMMEDIATE). Because writers
                // serialize, a second concurrent submission now sees the first (committed) booking here
                // and is rejected instead of double-booking the slot.
                const lockedBusy = await hasCalendarConflict(startTime, endTime, null, true);
                if (lockedBusy) {
                    await dbRun("ROLLBACK").catch(() => {});
                    return { status: 409, body: { success: false, message: 'This date and time were just booked. Please select another slot or contact us for special inquiries.' } };
                }

                // F3: re-run the same-email/same-date duplicate check inside the lock, closing the
                // same race window F1 closes for calendar conflicts.
                const lockedDuplicate = await dbGet(
                    `SELECT id FROM bookings
                     WHERE lower(email) = lower(?) AND date = ? AND status NOT IN ('CANCELLED','EXPIRED')
                     LIMIT 1`,
                    [email, event_date]
                );
                if (lockedDuplicate) {
                    await dbRun("ROLLBACK").catch(() => {});
                    return {
                        status: 409,
                        body: {
                            success: false,
                            existing_id: lockedDuplicate.id,
                            message: `You already have an active booking (#${lockedDuplicate.id}) for this date. Please track that booking, or contact us if you need to make changes.`
                        }
                    };
                }

                // F2: write ALL child rows inside the transaction, then COMMIT. If any child insert
                // fails we ROLLBACK, so we never persist a booking without the services / line items
                // its quote_amount was calculated from.
                const insert = await dbRun(`INSERT INTO bookings (
                            name, company, email, cell,
                            event_name, date, event_start_time, performance_slot, performance_duration,
                            event_location, venue_address, city, country, venue_type,
                            event_type, audience_size, audience_demographic, budget_range, travel_accommodation, message, status,
                            alternative_dates, content_notes, heard_about,
                            client_id, venue_id, quote_amount, total_amount, amount_outstanding, payment_status, popia_consent, consent_timestamp, vat_number, venue_place_id, quote_expiry_date, policy_version, source, referrer, consent_source
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, "NEW", ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP, ?, ?, ?, ?, ?, ?, 'public_form')`,
                    [
                        encodeUserHtml(name), encodeUserHtml(company) || null, email, cell,
                        encodeUserHtml(event_name) || null, event_date, event_start_time || null, encodeUserHtml(performance_slot) || null, encodeUserHtml(performance_duration) || null,
                        encodeUserHtml(event_location), encodeUserHtml(venue_address) || null, encodeUserHtml(city) || null, encodeUserHtml(country) || null, encodeUserHtml(venue_type) || null,
                        encodeUserHtml(event_type), encodeUserHtml(audience_size) || null, encodeUserHtml(audience_demographic) || null, encodeUserHtml(budget_range) || null, travel_accommodation ? 1 : 0, encodeUserHtml(message),
                        encodeUserHtml(alternative_dates) || null, encodeUserHtml(content_notes) || null, encodeUserHtml(heard_about) || null,
                        clientId, venueId, initialQuoteAmountStr, initialTotalAmount, initialTotalAmount, paymentStatus, vat_number || null, encodeUserHtml(venuePlaceId) || null, defaultQuoteExpiry, CURRENT_POLICY_VERSION,
                        encodeUserHtml(asBookingText(req.body.source)) || null, encodeUserHtml(asBookingText(req.body.referrer)) || null
                    ]
                );
                const bookingId = insert.lastID;

                // POPIA consent audit — immutable record of when/where consent was given
                await dbRun(
                    `INSERT INTO consent_audit (booking_id, ip_address, user_agent, policy_version, consent_source) VALUES (?, ?, ?, ?, 'public_form')`,
                    [bookingId, req.ip || null, req.headers['user-agent'] || null, CURRENT_POLICY_VERSION]
                );

                // Audit trail for booking creation (trigger only fires on UPDATE, not INSERT).
                // Records the normalized values that were actually persisted, plus the originating
                // IP — audit_log.ip_address was previously left NULL for every public submission.
                await dbRun(
                    `INSERT INTO audit_log (table_name, record_id, action, new_values, changed_by, ip_address) VALUES ('bookings', ?, 'CREATE', ?, 'public', ?)`,
                    [bookingId, JSON.stringify({ name, email, date: event_date, status: 'NEW' }), req.ip || null]
                );

                // X3: derive the performance window from performance_slot when it parses, otherwise
                // from event_start_time + the occupancy duration. Both the start and the end are
                // written: previously the event_start_time branches set only performance_end_time,
                // leaving performance_start_time NULL on every timed booking without a slot string.
                // perfSlotStart/perfSlotEnd were already parsed from performance_slot above (they're
                // also what event_start_time was derived from, when it wasn't given explicitly).
                let perfStart = perfSlotStart, perfEnd = perfSlotEnd;
                if (!perfStart && event_start_time) {
                    perfStart = event_start_time;
                    perfEnd = addMinutesToTime(event_start_time, durationMins);
                }
                if (perfStart && perfEnd) {
                    await dbRun("UPDATE bookings SET performance_start_time = ?, performance_end_time = ? WHERE id = ?",
                        [perfStart, perfEnd, bookingId]);
                }

                // 10. INSERT BOOKING SERVICES (Relational)
                for (const srv of selectedServices) {
                    await insertBookingService(bookingId, srv.service_id, srv.quantity_minutes, srv.unit_price, srv.total_price);
                    await insertBookingLineItem(bookingId, srv.service_id, srv.name, srv.quantity_minutes, srv.unit_price);
                }

                // All child rows persisted — commit the whole booking atomically.
                await dbRun("COMMIT");
                return { ok: true, bookingId };
            } catch (dbErr) {
                await dbRun("ROLLBACK").catch(() => {});
                console.error("[Booking] Transactional insert failed — rolled back, no partial booking saved:", dbErr.message);
                return { status: 500, body: { success: false, message: 'Database error while saving booking.' } };
            }
        });

        if (!outcome.ok) {
            return res.status(outcome.status).json(outcome.body);
        }
        const bookingId = outcome.bookingId;

        // ---- Side effects run AFTER commit (non-blocking; must never roll back the booking) ----

        // 11. SYNC TO GOOGLE CALENDAR (Asynchronously/Non-blocking)
        syncBookingToCalendar(bookingId).catch(calErr => {
            console.error('[Booking] Google Calendar sync failed (booking still saved):', calErr.message);
            // Alert admin so the orphaned calendar slot can be fixed manually
            getNotificationEmail().then(notifEmail => sendEmail({
                to: notifEmail,
                subject: `⚠️ Google Calendar Sync Failed – New Booking #${bookingId}`,
                htmlContent: emailComponents.renderSystemEmail({
                    preheaderText: `Booking #${bookingId} saved but its Google Calendar event failed.`,
                    category: 'System',
                    severity: 'alert',
                    leadFact: `Booking <strong style="color:#FAFAFA;">#${bookingId}</strong> was saved successfully but the Google Calendar event could not be created.`,
                    bodyHtml: `<p style="margin:0 0 10px; color:#B0B0B0; font-size:12px;">Error: ${calErr.message}</p><p style="margin:0; color:#E6E6E6;">Please create the calendar entry manually to avoid a scheduling conflict.</p>`
                }),
                preWrapped: true,
                titleOverride: 'Calendar Sync Failed',
                trigger_event: 'System: Calendar Sync Failure',
                skipBrandAttachments: true
            })).catch(() => {});
        });

        // 12. DISPATCH EMAILS CONCURRENTLY (Asynchronously/Non-blocking)
        sendBookingReceivedEmail(bookingId, req.body).catch(e => console.error("Async email dispatch failed:", e));

        // Booking Recovery: mark any matching abandoned draft as recovered (non-blocking)
        if (req.body.draft_token) {
            db.run(`UPDATE abandoned_bookings SET status='RECOVERED', converted_booking_id=?, last_activity_at=CURRENT_TIMESTAMP
                    WHERE draft_token=? AND status NOT IN ('RECOVERED','WON')`,
                [bookingId, req.body.draft_token],
                (e) => { if (e) console.error('[Booking Recovery] convert-mark failed:', e.message); });
        }

        res.json({ success: true, message: 'Booking submitted successfully! Check your inbox for confirmation.', booking_id: bookingId });
    } catch (e) {
        console.error("[Booking] Intake failed before commit:", e);
        res.status(500).json({ success: false, message: "We could not process your booking request. Please try again, or contact us directly if the problem persists." });
    }
});

module.exports = router;
