// Public Contact form intake (POST /send-email). The ONE place that turns a website submission into an inquiry.
//
// Order of work, and why:
//   1. validate on the server (the browser's checks are a courtesy, never the rule);
//   2. quiet spam traps (honeypot / impossibly fast submit) - answered like a success so bots learn nothing;
//   3. per-address limit + duplicate detection (a double click or a replayed POST never creates a second inquiry or a second email);
//   4. PERSIST the inquiry (awaited). If this fails the visitor is told so - nothing is claimed that did not happen;
//   5. only then notify: the notification and the visitor's receipt go through the notification outbox (js/emailService.js sendEmail),
//      which stores them durably and retries. A Microsoft 365 outage therefore delays mail but never loses an inquiry or fails the form.
//
// Recipients are decided HERE, on the server: the notification goes to Admin > Contact Details (contact_info.email) or, failing that,
// the configured Microsoft 365 mailbox. Nothing the browser sends can choose it. The visitor's address appears only as Reply-To on the
// notification, and as the single recipient of their own receipt.
//
// Text convention: app.js deepEscapeBody has already entity-encoded every string of the JSON body once (docs-internal/stored-text.md).
// So: validate the DECODED text, store the single-layer encoded form, and put DECODED text into e-mail subjects / escape it for HTML bodies.
'use strict';
const db = require('../database');
const { decodeStoredText, normalizeEncodedText } = require('./html-sanitize');
const { validateSubmission, isMailbox, referenceFor, idFromReference, BOOKING_CATEGORY, LIMITS } = require('./contact-validation');
const emailComponents = require('../js/emailComponents');
const bannerRegistry = require('../js/bannerRegistry');
const { getEmailFooterContext } = require('./email-context');
const { sendEmail: queueEmail } = require('../js/emailService');
const { getSenderEmail } = require('./smtp-config');
const inquiriesRepo = require('../database/repositories/inquiries.repository');
const bookingsRepo = require('../database/repositories/bookings.repository');

const { esc } = emailComponents;

// notifications.related_entity values for the two mails a submission produces ('inquiries' is already used for admin replies).
const INTAKE_ENTITY = 'inquiry_intake';
const RECEIPT_ENTITY = 'inquiry_receipt';

const PER_ADDRESS_LIMIT = { count: 3, window: '-1 hour' };
const DUPLICATE_WINDOW = '-24 hours';

// ── small promise wrapper (this module owns its few queries; the repositories keep the inserts) ──────────────
const dbGet = (sql, params = []) => new Promise((resolve, reject) => db.get(sql, params, (e, r) => e ? reject(e) : resolve(r)));

// The notification address: Admin > Contact Details, else the Microsoft 365 mailbox that sends the site's mail, else the historical default.
async function resolveReceiver() {
    let configured = null;
    try { const row = await dbGet('SELECT email FROM contact_info ORDER BY quote_id ASC LIMIT 1'); configured = row && decodeStoredText(row.email); } catch (e) { /* use the fallbacks */ }
    return [configured, getSenderEmail(), 'admin@thabisomhlongo.com'].map((v) => (typeof v === 'string' ? v.trim() : v)).find(isMailbox);
}

// ── e-mail content (look unchanged; values escaped for HTML, subjects plain) ─────────────────────────────────
function adminNotification(ref, c) {
    const mailto = `<a href="mailto:${esc(c.email)}" style="color:#D4AF37; text-decoration:none;">${esc(c.email)}</a>`;
    const tel = c.cell ? `<a href="tel:${esc(c.cell)}" style="color:#D4AF37; text-decoration:none;">${esc(c.cell)}</a>` : 'N/A';
    const rows = [
        { label: 'Reference', value: ref, mono: true },
        { label: 'Name', value: c.name, mono: false },
        { label: 'Email', rawValue: mailto },
        { label: 'Phone', rawValue: tel },
        { label: 'Category', value: c.category, mono: false, highlight: true },
        { label: 'Subject', value: c.subject || 'No Subject', mono: false }
    ];
    return emailComponents.renderSystemEmail({
        preheaderText: `New website inquiry: ${c.subject || 'No Subject'}.`,
        category: 'Contact & Support',
        severity: 'action',
        leadFact: 'You have received a new contact message through the Thabiso Mhlongo official website.',
        bodyHtml:
            `<p style="margin:14px 0 6px; color:#D4AF37; font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:0.7px;">Message Body</p>` +
            `<div style="padding:16px; background:#1A1A1A; border-left:3px solid #D4AF37; white-space:pre-wrap; color:#E6E6E6; font-size:14px; line-height:1.6;">${esc(c.message).replace(/\n/g, '<br>')}</div>` +
            `<p style="margin:16px 0 0; color:#707070; font-size:11px; text-align:center;">This email was securely dispatched and logged in the CRM database. Reply to it to answer the visitor directly, or answer from Admin &gt; Inquiries to keep the history.</p>`,
        cards: [{ rows }]
    });
}

async function visitorReceipt(ref, c) {
    const { socialLinks } = await getEmailFooterContext();
    const banner = await bannerRegistry.resolveBanner('contact_auto_reply');
    return emailComponents.renderPremiumEmail({
        preheaderText: `We've received your message - thanks for reaching out, ${c.name}!`,
        bannerSrc: banner?.src, bannerAlt: banner?.alt, subtitle: banner?.subtitle,
        headline: banner?.headline || "We've Received Your Message",
        greeting: `Hi ${esc(c.name)},`,
        bodyHtml:
            `Thank you for reaching out to Thabiso Mhlongo Management. We have successfully received your inquiry regarding <strong style="color:#D4AF37;">"${esc(c.subject || 'General Inquiry')}"</strong> ` +
            `(reference <strong style="color:#D4AF37;">${esc(ref)}</strong>) and will respond as soon as possible.` +
            `<p style="margin:10px 0 0; color:#E6E6E6;">In the meantime, feel free to follow Thabiso on social media for the latest updates and tour dates.</p>` +
            `<p style="margin:18px 0 0; color:#B0B0B0;">Stay funny,<br><span style="font-family:'Cormorant Garamond',Georgia,serif; font-size:18px; color:#D4AF37;">Thabiso Mhlongo Management</span></p>`,
        socialLinks
    });
}

// ── the intake ───────────────────────────────────────────────────────────────────────────────────────────────
const SUCCESS_MESSAGE = 'Thank you - your message has been received. A confirmation is on its way to your inbox.';
const inflight = new Map();   // concurrent identical submissions share one outcome (single-process app)

/**
 * input: { body, ip, userAgent, referrer }.  deps (tests only): { insertInquiry, queueEmail }.
 * Resolves { status, body } for the route to send. Never throws.
 */
async function submitContact(input, deps = {}) {
    const { body, ip = '', userAgent = '', referrer = '' } = input || {};
    const insertInquiry = deps.insertInquiry || inquiriesRepo.insertInquiry;
    const queue = deps.queueEmail || queueEmail;

    const v = validateSubmission(body);
    const bad = Object.keys(v.errors);
    if (bad.length) return { status: 400, body: { success: false, message: v.errors[bad[0]], errors: v.errors } };
    if (v.spam) {
        console.warn(`[contact] submission ignored (${v.spam})`);   // no personal data in the log
        return { status: 200, body: { success: true, message: SUCCESS_MESSAGE } };
    }
    const c = v.clean;
    const emailKey = c.email.toLowerCase();
    const storedMessage = normalizeEncodedText(c.message);

    const key = emailKey + '\u0000' + storedMessage;
    if (inflight.has(key)) {
        const first = await inflight.get(key);
        return first.status === 200 && first.body.reference ? { status: 200, body: { ...first.body, duplicate: true, message: 'We already have this message from you - thank you. We will be in touch.' } } : first;
    }
    const work = persistAndNotify(c, emailKey, storedMessage, { ip: String(ip).slice(0, 64), userAgent: String(userAgent).slice(0, 500), referrer: String(referrer).slice(0, 500) }, { insertInquiry, queue });
    inflight.set(key, work);
    try { return await work; } finally { inflight.delete(key); }
}

async function persistAndNotify(c, emailKey, storedMessage, meta, deps) {
    try {
        // duplicates first (a repeat of the same message is answered with the original reference, silently), then the per-address cap
        const dup = await dbGet(`SELECT inquiry_id FROM inquiries WHERE LOWER(sender_email) = ? AND message_body = ? AND submitted_at > datetime('now', ?) ORDER BY inquiry_id DESC LIMIT 1`, [emailKey, storedMessage, DUPLICATE_WINDOW]);
        if (dup) return { status: 200, body: { success: true, duplicate: true, message: 'We already have this message from you - thank you. We will be in touch.', reference: referenceFor(dup.inquiry_id) } };

        const recent = await dbGet(`SELECT COUNT(*) AS n FROM inquiries WHERE LOWER(sender_email) = ? AND submitted_at > datetime('now', ?)`, [emailKey, PER_ADDRESS_LIMIT.window]);
        if (recent && recent.n >= PER_ADDRESS_LIMIT.count) {
            return { status: 429, body: { success: false, message: 'You have sent several messages recently. Please wait a little while before sending another, or contact us directly.' } };
        }
    } catch (e) {
        console.error('[contact] duplicate/limit check failed:', e.message);   // not fatal: persisting is what matters
    }

    // ── 4. persist ──
    const receiver = await resolveReceiver();
    const storedName = normalizeEncodedText(c.name);
    const storedSubject = c.subject ? normalizeEncodedText(c.subject) : 'No Subject';
    let inquiryId;
    try {
        inquiryId = await new Promise((resolve, reject) => deps.insertInquiry(
            storedName, c.email, receiver, c.cell || '', normalizeEncodedText(c.category), storedSubject, storedMessage,
            meta.referrer || '/send-email', meta.ip, meta.userAgent,
            function (err) { err ? reject(err) : resolve(this.lastID); }));
    } catch (e) {
        console.error('[contact] could not save an inquiry:', e.message);
        return { status: 503, body: { success: false, message: 'We could not save your message right now. Please try again in a few minutes.' } };
    }
    const ref = referenceFor(inquiryId);

    // A "Booking Inquiry" has always also created a PENDING booking row (the Bookings pipeline relies on it); keep that, and link the two so
    // the inquiry shows as converted and the admin cannot create a second booking from it by accident.
    let bookingId = null;
    if (c.category.toLowerCase() === BOOKING_CATEGORY.toLowerCase()) {
        try {
            const bodyText = c.subject ? `${storedSubject}\n\n${storedMessage}` : storedMessage;
            bookingId = await new Promise((resolve, reject) => bookingsRepo.insertLegacyBookingFromContactForm(
                storedName, c.email, c.cell || '', normalizeEncodedText(c.category), bodyText, function (err) { err ? reject(err) : resolve(this.lastID); }, inquiryId));
            await inquiriesRepo.linkInquiryToBooking(bookingId, inquiryId);
        } catch (e) {
            console.error(`[contact] ${ref}: the legacy booking row could not be created:`, e.message);   // the inquiry itself is safe
        }
    }

    // ── 5. notify (best effort - the outbox keeps and retries them) ──
    const out = { notification: 'not queued', receipt: 'not queued' };
    try {
        const r = await deps.queue({
            to: receiver,
            subject: `Website Inquiry: ${c.subject || 'No Subject'} [${ref}]`,
            htmlContent: adminNotification(ref, c),
            preWrapped: true,
            replyTo: c.email,
            titleOverride: 'New Website Inquiry',
            trigger_event: 'Contact Form: Admin Notification',
            related_entity: INTAKE_ENTITY,
            related_id: inquiryId
        });
        out.notification = r && r.success ? 'queued' : 'FAILED to queue';
    } catch (e) { out.notification = 'FAILED to queue'; console.error(`[contact] ${ref}: notification:`, e.message); }

    try {
        const r = await deps.queue({
            to: c.email,
            subject: `Thank you for your message, ${c.name}! [${ref}]`,   // the tag lets a customer's answer to this receipt find its inquiry (lib/inbox-sync.js)
            htmlContent: await visitorReceipt(ref, c),
            preWrapped: true,
            titleOverride: "We've Received Your Message!",
            trigger_event: 'Contact Form: Visitor Receipt',
            related_entity: RECEIPT_ENTITY,
            related_id: inquiryId
        });
        out.receipt = r && r.success ? 'queued' : 'FAILED to queue';
    } catch (e) { out.receipt = 'FAILED to queue'; console.error(`[contact] ${ref}: receipt:`, e.message); }

    console.log(`[contact] ${ref} saved (${c.category}${bookingId ? `, booking #${bookingId}` : ''}); notification ${out.notification}; receipt ${out.receipt}`);
    return { status: 200, body: { success: true, reference: ref, message: out.receipt === 'queued' ? SUCCESS_MESSAGE : 'Thank you - your message has been received. We will be in touch soon.' } };
}

module.exports = { submitContact, validateSubmission, resolveReceiver, referenceFor, idFromReference, isMailbox, BOOKING_CATEGORY, INTAKE_ENTITY, RECEIPT_ENTITY, LIMITS };
