const express = require('express');
const bcrypt = require('bcrypt');
const db = require('../../database');
const { dbGet, dbRun } = require('../../lib/db-helpers');
const { ipRateLimiter, otpRequestRateLimiter, mutateRateLimiter } = require('../../middleware/rate-limiters');
const { OTP_TTL_MINUTES, OTP_MAX_ATTEMPTS, generateOtpCode } = require('../../lib/booking-tracking');
const { getEmailFooterContext } = require('../../lib/email-context');
const { encodeUserHtml } = require('../../lib/html-sanitize');
const { resolvePopiaTargets, getBookingErasureImpact, createPopiaRequest, POPIA_REASONS } = require('../../lib/popia');
const bannerRegistry = require('../../js/bannerRegistry');
const emailComponents = require('../../js/emailComponents');
const { sendEmail } = require('../../js/emailService');
const { getInquiriesForEmail } = require('../../database/repositories/inquiries.repository');
const router = express.Router();

// Looks up the latest unconsumed, unexpired code for `email` and checks it against `code`.
// `consume:false` (used by the preview endpoint) leaves the row alone on a correct match so the
// same code can still be used again by the final submit; `consume:true` marks it spent. The
// attempts budget is shared across every caller of this function, so hitting the preview endpoint
// doesn't grant extra guesses beyond OTP_MAX_ATTEMPTS.
async function verifyPopiaOtp(email, code, { consume }) {
    if (!code) return { ok: false, message: 'A verification code is required.' };
    const codeRow = await dbGet(
        `SELECT id, code_hash, attempts FROM popia_verification_codes
         WHERE lower(email) = lower(?) AND consumed = 0 AND expires_at > CURRENT_TIMESTAMP
         ORDER BY created_at DESC LIMIT 1`,
        [email]
    );
    if (!codeRow) {
        return { ok: false, message: 'That code is invalid or has expired. Please request a new one.' };
    }
    if (codeRow.attempts >= OTP_MAX_ATTEMPTS) {
        await dbRun("UPDATE popia_verification_codes SET consumed = 1 WHERE id = ?", [codeRow.id]);
        return { ok: false, message: 'Too many incorrect attempts. Please request a new code.' };
    }

    const match = await bcrypt.compare(code, codeRow.code_hash);
    if (!match) {
        await dbRun("UPDATE popia_verification_codes SET attempts = attempts + 1 WHERE id = ?", [codeRow.id]);
        const remaining = OTP_MAX_ATTEMPTS - (codeRow.attempts + 1);
        await dbRun(
            `INSERT INTO audit_log (table_name, record_id, action, user_email, change_timestamp) VALUES ('popia_verification_codes', ?, 'POPIA_OTP_FAILED', ?, CURRENT_TIMESTAMP)`,
            [codeRow.id, email]
        ).catch(() => {});
        return { ok: false, message: remaining > 0 ? `Incorrect code. ${remaining} attempt(s) remaining.` : 'Too many incorrect attempts. Please request a new code.' };
    }

    if (consume) {
        await dbRun("UPDATE popia_verification_codes SET consumed = 1 WHERE id = ?", [codeRow.id]);
    }
    return { ok: true, codeId: codeRow.id };
}

router.post('/api/public/popia/request-otp', ipRateLimiter, otpRequestRateLimiter, async (req, res) => {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
        return res.status(400).json({ success: false, message: 'A valid email address is required.' });
    }
    try {
        // Kill any earlier unconsumed code for this email so only the most recently sent one is live.
        await dbRun("UPDATE popia_verification_codes SET consumed = 1 WHERE lower(email) = lower(?) AND consumed = 0", [email]);
        const code = generateOtpCode();
        const codeHash = await bcrypt.hash(code, 10);
        const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60000).toISOString();
        const ins = await dbRun("INSERT INTO popia_verification_codes (email, code_hash, expires_at) VALUES (?, ?, ?)", [email, codeHash, expiresAt]);

        const banner = await bannerRegistry.resolveBanner('popia_verification_code');
        const { socialLinks } = await getEmailFooterContext();
        await sendEmail({
            to: email,
            subject: `Your POPIA verification code: ${code}`,
            htmlContent: emailComponents.renderPremiumEmail({
                preheaderText: `Your verification code is ${code}. It expires in ${OTP_TTL_MINUTES} minutes.`,
                bannerSrc: banner?.src, bannerAlt: banner?.alt, subtitle: banner?.subtitle,
                headline: banner?.headline || 'Verify Your Email',
                bodyHtml:
                    `<p style="margin:0 0 12px;">Use this code to verify your email address for your POPIA data erasure request:</p>` +
                    `<p style="margin:0; color:#B0B0B0; font-size:13px;">This code expires in ${OTP_TTL_MINUTES} minutes. If you didn't request this, you can safely ignore this email.</p>`,
                cards: [{ rows: [{ label: 'Verification code', value: code, mono: true, highlight: true }] }],
                socialLinks
            }),
            preWrapped: true,
            titleOverride: 'Verify Your Email',
            trigger_event: 'POPIA: Erasure Verification Code'
        });

        await dbRun(
            `INSERT INTO audit_log (table_name, record_id, action, user_email, ip_address, change_timestamp) VALUES ('popia_verification_codes', ?, 'POPIA_OTP_REQUESTED', ?, ?, CURRENT_TIMESTAMP)`,
            [ins.lastID, email, req.ip]
        ).catch(() => {});

        res.json({ success: true, message: 'A verification code has been sent to that email address.' });
    } catch (e) {
        console.error('[POPIA OTP] request-otp failed:', e.message);
        res.status(500).json({ success: false, message: 'Could not send a verification code. Please try again.' });
    }
});

// Read-only, pre-submission preview: verifies the code WITHOUT consuming it, then shows the client
// exactly which of their bookings are in scope for cancellation and the refund figures that will
// actually apply — reusing the same calculateCancellationRefund() the real cancellation step uses,
// via the shared getBookingErasureImpact() (defined further below, alongside the erasure lifecycle
// functions it's grouped with), so this preview can never drift from what processing will do.
router.post('/api/public/popia/preview', ipRateLimiter, mutateRateLimiter, async (req, res) => {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
    const otpCode = typeof req.body?.otp_code === 'string' ? req.body.otp_code.trim() : '';
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
        return res.status(400).json({ success: false, message: 'A valid email address is required.' });
    }
    const verify = await verifyPopiaOtp(email, otpCode, { consume: false });
    if (!verify.ok) return res.status(400).json({ success: false, message: verify.message });

    try {
        const { bookingIds } = await resolvePopiaTargets(email);
        const impact = await getBookingErasureImpact(bookingIds);
        res.json({ success: true, bookings: impact });
    } catch (e) {
        console.error('[POPIA] preview failed:', e.message);
        res.status(500).json({ success: false, message: 'Could not generate a preview. Please try again.' });
    }
});

// Phase 5 (HOUSEKEEPING-NOTES.md): the request-lifecycle block that used to run from here
// (POPIA_REASONS) through notifyPopiaCancellations() — popiaReferenceNumber, createPopiaRequest,
// approvePopiaRequest, rejectPopiaRequest, processPopiaRequest, completePopiaAnonymization,
// deletePopiaFiles, isBookingInPopiaErasureScope, cancelActiveBookingsForErasure,
// getUnresolvedRefundBookingIds, notifyPopiaCancellations — moved to lib/popia.js. Of these, only
// POPIA_REASONS and createPopiaRequest are re-imported above (alongside resolvePopiaTargets/
// getBookingErasureImpact) — the public routes immediately below only ever create a request, never
// approve/process/notify one; the rest have no remaining caller in app.js.

// Public request form (index.html footer -> #popiaErasureModal)
router.post('/api/public/popia/erasure-requests', ipRateLimiter, mutateRateLimiter, async (req, res) => {
    const { email, otp_code, reason, reason_other_text, additional_comments, consequences_acknowledged } = req.body || {};
    const emailNorm = typeof email === 'string' ? email.trim() : '';
    if (!emailNorm || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(emailNorm)) {
        return res.status(400).json({ success: false, message: 'A valid email address is required.' });
    }
    if (!POPIA_REASONS.includes(reason)) {
        return res.status(400).json({ success: false, message: 'Please select a valid reason for your request.' });
    }
    if (reason === 'other' && !String(reason_other_text || '').trim()) {
        return res.status(400).json({ success: false, message: 'Please describe your reason for the request.' });
    }
    if (!consequences_acknowledged) {
        return res.status(400).json({ success: false, message: 'Please confirm you understand the consequences of this request before submitting.' });
    }

    // Verify but don't consume yet — only mark the code spent once createPopiaRequest() has actually
    // succeeded, so a transient DB failure doesn't force the client to request an entirely new code
    // for a problem that wasn't theirs.
    const verify = await verifyPopiaOtp(emailNorm, typeof otp_code === 'string' ? otp_code.trim() : '', { consume: false });
    if (!verify.ok) return res.status(400).json({ success: false, message: verify.message });

    const outcome = await createPopiaRequest({
        email: emailNorm,
        reason,
        reasonOtherText: reason === 'other' ? encodeUserHtml(String(reason_other_text).trim().slice(0, 500)) : null,
        additionalComments: additional_comments ? encodeUserHtml(String(additional_comments).trim().slice(0, 2000)) : null,
        source: 'public',
        ip: req.ip,
        userAgent: req.get('User-Agent') || null,
        actorEmail: emailNorm
    });
    if (!outcome.ok) return res.status(outcome.status).json(outcome.body);

    await dbRun("UPDATE popia_verification_codes SET consumed = 1 WHERE id = ?", [verify.codeId]).catch(() => {});
    await dbRun(
        `INSERT INTO audit_log (table_name, record_id, action, user_email, change_timestamp) VALUES ('popia_erasure_requests', ?, 'POPIA_OTP_VERIFIED', ?, CURRENT_TIMESTAMP)`,
        [outcome.id, emailNorm]
    ).catch(() => {});

    try {
        const { socialLinks } = await getEmailFooterContext();
        const html = emailComponents.renderPremiumEmail({
            preheaderText: `We've received your data erasure request — Ref #${outcome.reference_number}.`,
            headline: 'Data Erasure Request Received',
            greeting: 'Hello,',
            bodyHtml: `We've received your request to have your personal information anonymised under POPIA. Your reference number is <strong style="color:#D4AF37;">${outcome.reference_number}</strong> — please keep this for your records.<br><br>Our team will review your request and process it in accordance with our data retention obligations. You'll receive a further email once it has been actioned.`,
            cards: [{
                title: 'Request Summary',
                rows: [
                    { label: 'Reference', value: outcome.reference_number },
                    { label: 'Email', value: emailNorm },
                    { label: 'Submitted', value: new Date().toLocaleDateString('en-ZA') }
                ]
            }],
            socialLinks
        });
        await sendEmail({
            to: emailNorm,
            subject: `Data Erasure Request Received — Ref #${outcome.reference_number}`,
            htmlContent: html,
            preWrapped: true,
            titleOverride: 'Data Erasure Request Received',
            trigger_event: 'POPIA: Erasure Request Received'
        });
    } catch (emailErr) {
        console.error('[POPIA] confirmation email failed:', emailErr.message);
    }

    res.json({ success: true, message: 'Your data erasure request has been received. Please check your email for confirmation.', reference_number: outcome.reference_number });
});

// Legacy public compat route — previously anonymized bookings/inquiries INSTANTLY, unauthenticated,
// for any email posted to it (no verification the caller owned the address, no review step, no
// audit trail). Rewritten to create a reviewable request like every other entry point instead, and
// now gated behind the same OTP verification as /erasure-requests — otherwise this would remain a
// way to bypass that requirement entirely. Callers must first hit /request-otp for the email, same
// as the primary flow.
router.post('/api/public/compliance/request-forget', ipRateLimiter, mutateRateLimiter, async (req, res) => {
    const emailNorm = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
    if (!emailNorm || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(emailNorm)) {
        return res.status(400).json({ success: false, message: 'A valid email address is required.' });
    }
    const otpCode = typeof req.body?.otp_code === 'string' ? req.body.otp_code.trim() : '';
    const verify = await verifyPopiaOtp(emailNorm, otpCode, { consume: false });
    if (!verify.ok) return res.status(400).json({ success: false, message: verify.message });

    const outcome = await createPopiaRequest({
        email: emailNorm, reason: 'other', reasonOtherText: 'Submitted via legacy /request-forget endpoint',
        source: 'public', ip: req.ip, userAgent: req.get('User-Agent') || null, actorEmail: emailNorm
    });
    if (!outcome.ok) return res.status(outcome.status).json(outcome.body);

    await dbRun("UPDATE popia_verification_codes SET consumed = 1 WHERE id = ?", [verify.codeId]).catch(() => {});
    await dbRun(
        `INSERT INTO audit_log (table_name, record_id, action, user_email, change_timestamp) VALUES ('popia_erasure_requests', ?, 'POPIA_OTP_VERIFIED', ?, CURRENT_TIMESTAMP)`,
        [outcome.id, emailNorm]
    ).catch(() => {});

    res.json({ success: true, message: 'Your data erasure request has been received and will be reviewed by our team.', reference_number: outcome.reference_number });
});

// 2. Data Portability (Export Request)
router.post('/api/public/compliance/export-data', ipRateLimiter, (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, message: 'Email required.' });

    const dataExport = {};
    
    db.all("SELECT * FROM bookings WHERE LOWER(email) = LOWER(?)", [email], (err, bookings) => {
        if (err) console.error('[POPIA] export-data bookings query failed:', err.message);
        dataExport.bookings = bookings || [];
        getInquiriesForEmail(email, (err, inquiries) => {
            if (err) console.error('[POPIA] export-data inquiries query failed:', err.message);
            dataExport.inquiries = inquiries || [];
            
            if (dataExport.bookings.length === 0 && dataExport.inquiries.length === 0) {
                return res.status(404).json({ success: false, message: 'No data found for this email address.' });
            }

            // In production, we'd email this as a secure ZIP/PDF.
            // For now, we return the JSON payload.
            res.json({
                success: true,
                message: 'Data export generated successfully.',
                data: dataExport
            });
        });
    });
});

module.exports = router;
