const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const fs = require('fs');
const db = require('../../database');
const {
    ipRateLimiter, otpRequestRateLimiter, mutateRateLimiter, lookupRateLimiter, trackRateLimiter
} = require('../../middleware/rate-limiters');
const { requireBookingAccessToken } = require('../../middleware/booking-access');
const { encodeUserHtml } = require('../../lib/html-sanitize');
const { getEmailFooterContext } = require('../../lib/email-context');
const { resolveDocsPath } = require('../../lib/runtime-paths');
const {
    asBookingText, OTP_TTL_MINUTES, OTP_MAX_ATTEMPTS, ACCESS_TOKEN_TTL_MINUTES,
    generateOtpCode, hashAccessToken
} = require('../../lib/booking-tracking');
const bannerRegistry = require('../../js/bannerRegistry');
const emailComponents = require('../../js/emailComponents');
const { sendEmail } = require('../../js/emailService');
const {
    getBookingEmailForTracking, consumeUnconsumedAccessCodes, insertBookingAccessCode,
    getActiveAccessCodeForVerification, consumeAccessCodeById, incrementAccessCodeAttempts,
    insertBookingAccessToken, getBookingById
} = require('../../database/repositories/bookings.repository');
const {
    getInvoiceForTracking, getQuoteVersionInfoForTracking, getLatestQuoteFileForPublicDownload
} = require('../../database/repositories/invoices-quotations.repository');
const {
    getPaymentSchedulesForTracking, getCancellationSummaryForTracking
} = require('../../database/repositories/finance.repository');
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

module.exports = router;
