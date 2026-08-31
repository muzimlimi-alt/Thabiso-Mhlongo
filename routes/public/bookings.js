const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const fs = require('fs');
const multer = require('multer');
const db = require('../../database');
const {
    ipRateLimiter, otpRequestRateLimiter, mutateRateLimiter, lookupRateLimiter, trackRateLimiter
} = require('../../middleware/rate-limiters');
const { requireBookingAccessToken } = require('../../middleware/booking-access');
const { encodeUserHtml } = require('../../lib/html-sanitize');
const { getEmailFooterContext } = require('../../lib/email-context');
const { resolveDocsPath, docsWriteDir } = require('../../lib/runtime-paths');
const {
    asBookingText, OTP_TTL_MINUTES, OTP_MAX_ATTEMPTS, ACCESS_TOKEN_TTL_MINUTES,
    generateOtpCode, hashAccessToken
} = require('../../lib/booking-tracking');
const { calculateCancellationRefund } = require('../../lib/cancellation-refund');
const { sendCancellationEmail } = require('../../lib/booking-cancellation-email');
const { generatePayFastSignature } = require('../../lib/payfast-signature');
const { dbRun } = require('../../lib/db-helpers');
// Phase 5: MUST stay the exact same singleton module.exports app.js and every other route file
// import — see lib/db-transaction.js's own header comment.
const { withDbTransaction } = require('../../lib/db-transaction');
const bannerRegistry = require('../../js/bannerRegistry');
const emailComponents = require('../../js/emailComponents');
const { sendEmail } = require('../../js/emailService');
const {
    getBookingEmailForTracking, consumeUnconsumedAccessCodes, insertBookingAccessCode,
    getActiveAccessCodeForVerification, consumeAccessCodeById, incrementAccessCodeAttempts,
    insertBookingAccessToken, getBookingById, insertBookingNoteFromTracker
} = require('../../database/repositories/bookings.repository');
const {
    getInvoiceForTracking, getQuoteVersionInfoForTracking, getLatestQuoteFileForPublicDownload,
    voidInvoicesForCancelledBookingAsync
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

module.exports = router;
