// Server-side judgement of one Contact form submission (the pure half of lib/contact-intake.js: no database, no e-mail, so it can be
// unit-tested directly). The browser's checks in js/myscript.js are a courtesy; THIS is the rule.
//
// Text convention: app.js deepEscapeBody has already entity-encoded every string of the JSON body once (docs-internal/stored-text.md),
// so every value is DECODED first and judged as the plain text the visitor typed.
'use strict';
const { decodeStoredText } = require('./html-sanitize');

// The #contactCategory option that has always also created a PENDING booking row (matched exactly, not by substring).
const BOOKING_CATEGORY = 'Booking Inquiry';

const LIMITS = { categoryMax: 60, nameMin: 2, nameMax: 100, subjectMin: 3, subjectMax: 150, messageMin: 10, messageMax: 5000, emailMax: 254, phoneMax: 25 };
const MIN_FILL_MS = 2500;                 // a human cannot read and fill this form faster than this

// A single mailbox address: no list separators, no whitespace, no angle brackets/quotes/parentheses - so one address can never become two.
const EMAIL_RE = /^[A-Za-z0-9._%+'-]{1,64}@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,24}$/;
const isMailbox = (v) => typeof v === 'string' && v.length <= LIMITS.emailMax && EMAIL_RE.test(v) && !v.includes('..') && !/^\.|\.@|@\./.test(v);
const PHONE_RE = /^\+?\d{7,15}$/;

const referenceFor = (id) => 'INQ-' + String(id).padStart(6, '0');
const idFromReference = (ref) => { const m = /^INQ-0*(\d+)$/i.exec(String(ref || '').trim()); return m ? Number(m[1]) : null; };

const oneLine = (s) => s.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
const multiLine = (s) => s.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').replace(/\n{4,}/g, '\n\n\n').trim();
const text = (v) => (typeof v === 'string' ? decodeStoredText(v) : '');

/**
 * Judges one submitted body. Returns { errors, clean, spam }.
 *   errors = { field: message }   (visitor-safe: only describes the visitor's own input)
 *   clean  = the plain-text values (decoded, trimmed, control characters removed)
 *   spam   = 'honeypot' | 'too-fast' | null   (silent traps)
 */
function validateSubmission(body, now = Date.now()) {
    const b = body && typeof body === 'object' ? body : {};
    const errors = {};

    const name = oneLine(text(b.name));
    if (name.length < LIMITS.nameMin) errors.name = `Please enter your full name (minimum ${LIMITS.nameMin} characters).`;
    else if (name.length > LIMITS.nameMax) errors.name = `Your name is too long (maximum ${LIMITS.nameMax} characters).`;

    const email = text(b.email).trim();
    if (!isMailbox(email)) errors.email = 'Please enter one valid email address.';

    let cell = oneLine(text(b.cell));
    if (cell) {
        const digits = cell.replace(/[\s().-]/g, '');
        if (cell.length > LIMITS.phoneMax || !PHONE_RE.test(digits)) errors.cell = 'Please enter a valid phone number (7 to 15 digits, e.g. +27 82 123 4567).';
        else cell = digits;
    }

    // A label only (the admin filters and tags by it): any plain text up to 60 characters; empty means General Inquiry. Only an exact
    // 'Booking Inquiry' has side effects, so a made-up category can never route a submission anywhere.
    const category = oneLine(text(b.category)).slice(0, LIMITS.categoryMax) || 'General Inquiry';

    const subject = oneLine(text(b.subject));
    if (subject && subject.length < LIMITS.subjectMin) errors.subject = `The subject must be at least ${LIMITS.subjectMin} characters (or leave it empty).`;
    else if (subject.length > LIMITS.subjectMax) errors.subject = `The subject is too long (maximum ${LIMITS.subjectMax} characters).`;

    const message = multiLine(text(b.message));
    if (message.length < LIMITS.messageMin) errors.message = `Your message is too short. Please provide more details (minimum ${LIMITS.messageMin} characters).`;
    else if (message.length > LIMITS.messageMax) errors.message = `Your message is too long (maximum ${LIMITS.messageMax} characters).`;

    const consent = b.popia_consent === true || b.popia_consent === 'true' || b.popia_consent === 1 || b.popia_consent === '1' || b.popia_consent === 'on';
    if (!consent) errors.popia_consent = 'POPIA consent is required to submit an inquiry.';

    // Silent traps. `contact_hp` is a field real visitors never see; `form_started_at` is when the page rendered the form.
    let spam = null;
    if (typeof b.contact_hp === 'string' && b.contact_hp.trim() !== '') spam = 'honeypot';
    const started = Number(b.form_started_at);
    if (!spam && Number.isFinite(started) && started > 0 && started <= now + 60000 && now - started < MIN_FILL_MS) spam = 'too-fast';

    return { errors, clean: { name, email, cell, category, subject, message }, spam };
}

/**
 * A recipient list typed into the admin composer (array, JSON text or one address). EVERY entry must be exactly one valid mailbox
 * address - no display names, no lists inside an entry, no line breaks - so a stored list can never carry another recipient or header.
 * Returns { ok, list } (decoded, trimmed, de-duplicated) or { ok:false, error }.
 */
function cleanAddressList(value, { max = 10 } = {}) {
    let arr = value;
    if (typeof arr === 'string') { try { const p = JSON.parse(arr); arr = Array.isArray(p) ? p : [arr]; } catch (e) { arr = [arr]; } }
    if (arr == null || arr === '') return { ok: true, list: [] };
    if (!Array.isArray(arr)) return { ok: false, error: 'Recipients must be a list of email addresses.' };
    const list = [];
    for (const raw of arr) {
        const address = typeof raw === 'string' ? decodeStoredText(raw).trim() : '';
        if (!isMailbox(address)) return { ok: false, error: `"${oneLine(address).slice(0, 60)}" is not a valid email address.` };
        if (!list.some((x) => x.toLowerCase() === address.toLowerCase())) list.push(address);
    }
    if (list.length > max) return { ok: false, error: `Too many recipients (maximum ${max}).` };
    return { ok: true, list };
}

module.exports = { validateSubmission, cleanAddressList, isMailbox, referenceFor, idFromReference, BOOKING_CATEGORY, LIMITS };
