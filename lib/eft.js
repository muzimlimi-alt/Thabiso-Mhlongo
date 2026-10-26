// Manual EFT payments - the database side: the versioned banking details, the on/off switch and upload limit, and a client's
// proof-of-payment submissions. The pure rules live in lib/eft-core.js, the review actions that touch the ledger in lib/eft-approval.js.
//
// Two promises hold through all of it (docs-internal/eft-payments.md):
//   1. UPLOADING A PROOF NEVER CREDITS ANYTHING. createSubmission() writes a 'pending' row and a file; only an administrator's approval
//      (lib/eft-approval.js) writes the ledger.
//   2. BANKING DETAILS ARE VERSIONED. Changing them retires the active row and adds a new one; an invoice keeps the version it was issued with.
const crypto = require('crypto');
const path = require('path');
const moment = require('moment-timezone');
const { dbRun, dbGet, dbAll } = require('./db-helpers');
const { DOCS_PATH } = require('./runtime-paths');
const { withDbTransaction } = require('./db-transaction');
const objectStorage = require('./object-storage');
const { normalizeEncodedText } = require('./html-sanitize');
const core = require('./eft-core');

const today = () => moment().tz('Africa/Johannesburg').format('YYYY-MM-DD');

// A booking can hold at most this many proofs waiting for review, and accept this many uploads in a day: a runaway client (or script)
// cannot fill the review queue or the disk. Enforced here, in the database, so it holds whatever the HTTP rate limiter does.
const MAX_PENDING_PER_BOOKING = 3;
const MAX_UPLOADS_PER_BOOKING_PER_DAY = 10;
const PAYABLE_BOOKING_STATUSES = ['ACCEPTED', 'CONFIRMED'];

// ---------------------------------------------------------------- settings and banking details

async function getEftSettings() {
    const row = await dbGet('SELECT enabled, max_upload_mb, updated_at FROM eft_settings WHERE id = 1');
    return { enabled: !!(row && row.enabled), max_upload_mb: (row && row.max_upload_mb) || core.MAX_UPLOAD_MB_DEFAULT, updated_at: row ? row.updated_at : null };
}

async function getActiveBankDetails() {
    return (await dbGet('SELECT * FROM bank_details WHERE is_active = 1')) || null;
}

async function getBankDetailsById(id) {
    if (!id) return null;
    return (await dbGet('SELECT * FROM bank_details WHERE id = ?', [id])) || null;
}

// Manual EFT is on offer only when an administrator switched it on AND there are banking details to show.
async function getEftState() {
    const settings = await getEftSettings();
    const details = await getActiveBankDetails();
    return { settings, details, available: !!(settings.enabled && details) };
}

async function listBankDetailsVersions() {
    return dbAll(`SELECT b.id, b.version, b.account_holder, b.bank_name, b.account_number, b.account_type, b.branch_code, b.swift_code,
                         b.reference_note, b.payment_instructions, b.is_active, b.created_at, b.retired_at,
                         ca.username AS created_by_name, ra.username AS retired_by_name,
                         (SELECT COUNT(*) FROM invoices i WHERE i.bank_details_id = b.id) AS invoice_count
                  FROM bank_details b
                  LEFT JOIN admins ca ON ca.id = b.created_by
                  LEFT JOIN admins ra ON ra.id = b.retired_by
                  ORDER BY b.version DESC`);
}

// Invoices that are still being paid and were issued with a given version - the ones whose printed details just went out of date.
async function openInvoicesOnVersion(bankDetailsId) {
    if (!bankDetailsId) return 0;
    const row = await dbGet(`SELECT COUNT(*) AS n FROM invoices WHERE bank_details_id = ? AND UPPER(status) NOT IN ('PAID', 'VOID')`, [bankDetailsId]);
    return row ? row.n : 0;
}

// Replaces the active banking details with a NEW version (never an edit in place). Resolves { unchanged } when nothing differs, so an
// administrator pressing Save twice does not mint a version, else { created, previous }. `clean` comes from core.validateBankDetails().
async function saveBankDetails(clean, adminId) {
    return withDbTransaction(async () => {
        await dbRun('BEGIN IMMEDIATE');
        try {
            const previous = await dbGet('SELECT * FROM bank_details WHERE is_active = 1');
            if (previous && core.sameBankDetails(previous, clean)) {
                await dbRun('ROLLBACK');
                return { unchanged: true, current: previous };
            }
            const top = await dbGet('SELECT COALESCE(MAX(version), 0) AS v FROM bank_details');
            if (previous) {
                await dbRun('UPDATE bank_details SET is_active = 0, retired_at = CURRENT_TIMESTAMP, retired_by = ? WHERE id = ?', [adminId || null, previous.id]);
            }
            const ins = await dbRun(
                `INSERT INTO bank_details (version, account_holder, bank_name, account_number, account_type, branch_code, swift_code,
                                           reference_note, payment_instructions, is_active, created_by)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
                [top.v + 1, clean.account_holder, clean.bank_name, clean.account_number, clean.account_type, clean.branch_code, clean.swift_code,
                 clean.reference_note, clean.payment_instructions, adminId || null]);
            const created = await dbGet('SELECT * FROM bank_details WHERE id = ?', [ins.lastID]);
            await dbRun('COMMIT');
            return { created, previous: previous || null };
        } catch (e) {
            await dbRun('ROLLBACK').catch(() => {});
            throw e;
        }
    });
}

// enabled: boolean; maxUploadMb: integer 1..15. Turning EFT on needs banking details to exist - there would be nothing to show a client.
async function saveEftSettings({ enabled, maxUploadMb }, adminId) {
    const before = await getEftSettings();
    const next = { enabled: enabled === undefined ? before.enabled : !!enabled, max_upload_mb: maxUploadMb === undefined ? before.max_upload_mb : parseInt(maxUploadMb, 10) };
    if (!Number.isInteger(next.max_upload_mb) || next.max_upload_mb < 1 || next.max_upload_mb > core.MAX_UPLOAD_MB_LIMIT) {
        return { error: `The upload limit must be a whole number from 1 to ${core.MAX_UPLOAD_MB_LIMIT} MB.` };
    }
    if (next.enabled && !(await getActiveBankDetails())) return { error: 'Add the banking details before turning Manual EFT on.' };
    await dbRun('UPDATE eft_settings SET enabled = ?, max_upload_mb = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1', [next.enabled ? 1 : 0, next.max_upload_mb, adminId || null]);
    return { before, after: await getEftSettings() };
}

// ---------------------------------------------------------------- what a booking owes, and which invoice it is paid against

function bookingTotal(booking) {
    return parseFloat(booking.total_amount) || parseFloat(String(booking.quote_amount || '0').replace(/[^0-9.]/g, '')) || 0;
}
function bookingOutstanding(booking) {
    return Math.max(0, core.round2(bookingTotal(booking) - (parseFloat(booking.amount_paid) || 0)));
}
function isPayable(booking) {
    return PAYABLE_BOOKING_STATUSES.includes(String(booking.status || '').toUpperCase()) && String(booking.payment_status || 'UNPAID').toUpperCase() !== 'PAID';
}

async function currentInvoiceFor(bookingId) {
    return (await dbGet(`SELECT id, invoice_number, status, bank_details_id FROM invoices
                         WHERE booking_id = ? AND UPPER(status) <> 'VOID' ORDER BY created_at DESC, id DESC LIMIT 1`, [bookingId])) || null;
}

// ---------------------------------------------------------------- views

// What a client may see of their own submission: never the file's name or hash, an address, an e-mail or an admin's id.
function clientView(r) {
    const finished = r.status !== 'pending';
    return {
        id: r.id,
        status: r.status,
        claimed_amount: r.claimed_amount,
        claimed_date: r.claimed_date,
        claimed_reference: r.claimed_reference,
        // the name the client gave their own file (cleaned for display) - never the stored name
        file_name: r.proof_original_name || null,
        submitted_at: r.created_at,
        reviewed_at: finished ? r.reviewed_at : null,
        verified_amount: r.status === 'approved' ? r.verified_amount : null,
        // the reason an administrator wrote FOR the client; the note on an approval is internal
        review_note: (r.status === 'rejected' || r.status === 'replacement_requested') ? r.review_note : null
    };
}

async function submissionsForBooking(bookingId) {
    const rows = await dbAll('SELECT * FROM eft_payment_submissions WHERE booking_id = ? ORDER BY id DESC LIMIT 25', [bookingId]);
    return rows.map(clientView);
}

// What the tracking page needs to offer (and explain) paying by EFT. null when there is nothing to show. The banking details go ONLY to a
// client who has verified they own the booking, only while it can still be paid, and always as the CURRENT details - with a note when the
// invoice in their hands was issued with an earlier set.
async function panelForBooking(booking) {
    const state = await getEftState();
    const submissions = await submissionsForBooking(booking.id);
    const payable = isPayable(booking);
    if (!state.available && !submissions.length) return null;
    const out = { enabled: state.available, submissions, can_upload: false, bank_details: null };
    if (!state.available || !payable) return out;

    const invoice = await currentInvoiceFor(booking.id);
    const pending = submissions.filter(s => s.status === 'pending').length;
    out.bank_details = core.printableBankDetails(state.details, core.paymentReference(booking.id, invoice && invoice.invoice_number));
    out.outstanding = bookingOutstanding(booking);
    out.max_upload_mb = state.settings.max_upload_mb;
    out.accepted_types = Object.values(core.PROOF_TYPES).map(t => t.label);
    out.pending_count = pending;
    out.can_upload = pending < MAX_PENDING_PER_BOOKING;
    out.details_changed = !!(invoice && invoice.bank_details_id && invoice.bank_details_id !== state.details.id);
    return out;
}

// ---------------------------------------------------------------- submitting a proof

function eventRow(submissionId, action, actorType, actorId, fromStatus, toStatus, note) {
    return dbRun(`INSERT INTO eft_submission_events (submission_id, action, actor_type, actor_id, from_status, to_status, note) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [submissionId, action, actorType, actorId || null, fromStatus || null, toStatus || null, note || null]);
}

// ctx: { booking, email, ip, file: { buffer, mimetype, originalname }, fields: { amount, payment_date, reference, note, schedule_id } }
// Resolves { ok:true, submission } or { ok:false, status, message, errors? }. NEVER touches the booking or the ledger.
async function createSubmission(ctx) {
    const { booking, email, ip, file, fields } = ctx;
    const state = await getEftState();
    if (!state.available) return { ok: false, status: 409, message: 'Paying by EFT is not available right now. Please use the card payment option or contact us.' };
    if (!isPayable(booking)) {
        return { ok: false, status: 400, message: String(booking.payment_status || '').toUpperCase() === 'PAID'
            ? 'This booking has already been paid in full.'
            : 'You can send proof of payment once your quote is accepted.' };
    }

    const checked = core.checkProofFile(file, state.settings.max_upload_mb);
    if (!checked.ok) return { ok: false, status: 400, message: checked.message };

    const claim = core.validateClaim(fields, bookingOutstanding(booking), today());
    if (Object.keys(claim.errors).length) return { ok: false, status: 400, message: Object.values(claim.errors)[0], errors: claim.errors };

    const sha = crypto.createHash('sha256').update(file.buffer).digest('hex');
    const pending = (await dbGet(`SELECT COUNT(*) AS n FROM eft_payment_submissions WHERE booking_id = ? AND status = 'pending'`, [booking.id])).n;
    if (pending >= MAX_PENDING_PER_BOOKING) {
        return { ok: false, status: 429, message: `You already have ${pending} proofs of payment waiting for review on this booking. We will be in touch once they have been checked.` };
    }
    const recent = (await dbGet(`SELECT COUNT(*) AS n FROM eft_payment_submissions WHERE booking_id = ? AND created_at >= datetime('now', '-1 day')`, [booking.id])).n;
    if (recent >= MAX_UPLOADS_PER_BOOKING_PER_DAY) {
        return { ok: false, status: 429, message: 'You have sent a lot of files today. Please wait until tomorrow or email us your proof of payment.' };
    }
    const same = await dbGet(`SELECT id, status FROM eft_payment_submissions WHERE booking_id = ? AND proof_sha256 = ? AND status IN ('pending', 'approved') LIMIT 1`, [booking.id, sha]);
    if (same) {
        return { ok: false, status: 409, message: same.status === 'approved'
            ? 'That proof of payment has already been accepted.'
            : 'That proof of payment has already been sent and is waiting for review.' };
    }
    // Not blocked - a person can honestly attach the same screenshot to a second booking - but the reviewer is told.
    const elsewhere = await dbGet(`SELECT id, booking_id FROM eft_payment_submissions WHERE proof_sha256 = ? AND booking_id <> ? ORDER BY id LIMIT 1`, [sha, booking.id]);

    let scheduleId = null;
    if (fields && fields.schedule_id) {
        const sid = parseInt(fields.schedule_id, 10);
        const row = Number.isInteger(sid) ? await dbGet(`SELECT id FROM payment_schedules WHERE id = ? AND booking_id = ? AND LOWER(COALESCE(status, 'pending')) NOT IN ('superseded', 'cancelled')`, [sid, booking.id]) : null;
        if (!row) return { ok: false, status: 400, message: 'That payment instalment does not belong to this booking.' };
        scheduleId = row.id;
    }

    const invoice = await currentInvoiceFor(booking.id);
    // The stored name is random and carries no client-supplied text; the extension comes from the bytes. The file goes into the same private
    // payment_proofs store the admin manual-payment proofs use, so an approved proof is already retrievable through the ledger's own link.
    const filename = `eft-${booking.id}-${crypto.randomBytes(12).toString('hex')}.${checked.ext}`;
    await objectStorage.putBuffer(`docs/payment_proofs/${filename}`, file.buffer, checked.mime);

    try {
        const submission = await withDbTransaction(async () => {
            await dbRun('BEGIN IMMEDIATE');
            try {
                const ins = await dbRun(
                    `INSERT INTO eft_payment_submissions (booking_id, invoice_id, schedule_id, claimed_amount, claimed_date, claimed_reference, client_note,
                            proof_filename, proof_original_name, proof_mime, proof_size, proof_sha256, status, bank_details_id, submitted_by_email, submitted_ip)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
                    [booking.id, invoice ? invoice.id : null, scheduleId, claim.clean.amount, claim.clean.payment_date || null,
                     claim.clean.reference ? normalizeEncodedText(claim.clean.reference) : null, claim.clean.note ? normalizeEncodedText(claim.clean.note) : null,
                     filename, core.safeDisplayName(file.originalname), checked.mime, file.buffer.length, sha, state.details.id, email || null, ip || null]);
                await eventRow(ins.lastID, 'submitted', 'client', null, null, 'pending',
                    `Client uploaded ${checked.label} (${Math.round(file.buffer.length / 1024)} KB), claims R${claim.clean.amount.toFixed(2)}.` +
                    (elsewhere ? ` Warning: the same file was already submitted for booking #${elsewhere.booking_id} (submission #${elsewhere.id}).` : ''));
                await dbRun('COMMIT');
                return await dbGet('SELECT * FROM eft_payment_submissions WHERE id = ?', [ins.lastID]);
            } catch (e) {
                await dbRun('ROLLBACK').catch(() => {});
                throw e;
            }
        });
        return { ok: true, submission, invoice };
    } catch (e) {
        await objectStorage.deleteFile(path.join(DOCS_PATH, 'payment_proofs', filename)).catch(() => {});
        throw e;
    }
}

// ---------------------------------------------------------------- the admin's view

async function pendingCount() {
    return (await dbGet(`SELECT COUNT(*) AS n FROM eft_payment_submissions WHERE status = 'pending'`)).n;
}

async function listSubmissions({ status, bookingId, limit, offset } = {}) {
    const where = [];
    const params = [];
    if (status && ['pending', 'approved', 'rejected', 'replacement_requested'].includes(status)) { where.push('s.status = ?'); params.push(status); }
    if (bookingId) { where.push('s.booking_id = ?'); params.push(parseInt(bookingId, 10) || 0); }
    const lim = Math.max(1, Math.min(200, parseInt(limit, 10) || 50));
    const off = Math.max(0, parseInt(offset, 10) || 0);
    const rows = await dbAll(
        `SELECT s.id, s.booking_id, s.status, s.claimed_amount, s.claimed_date, s.claimed_reference, s.proof_mime, s.proof_size, s.created_at,
                s.verified_amount, s.verified_reference, s.verified_date, s.reviewed_at, s.transaction_id,
                b.name AS client_name, b.email AS client_email, b.event_name, b.date AS event_date, b.total_amount, b.amount_paid, b.amount_outstanding,
                i.invoice_number, a.username AS reviewed_by_name,
                (SELECT COUNT(*) FROM eft_payment_submissions d WHERE d.proof_sha256 = s.proof_sha256 AND d.booking_id <> s.booking_id) AS same_file_elsewhere
         FROM eft_payment_submissions s
         JOIN bookings b ON b.id = s.booking_id
         LEFT JOIN invoices i ON i.id = s.invoice_id
         LEFT JOIN admins a ON a.id = s.reviewed_by
         ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
         ORDER BY CASE s.status WHEN 'pending' THEN 0 ELSE 1 END, s.created_at DESC, s.id DESC
         LIMIT ? OFFSET ?`, [...params, lim, off]);
    const total = (await dbGet(`SELECT COUNT(*) AS n FROM eft_payment_submissions s ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`, params)).n;
    return { rows, total };
}

async function getSubmission(id) {
    const sid = parseInt(id, 10);
    if (!Number.isInteger(sid) || sid <= 0) return null;
    return (await dbGet('SELECT * FROM eft_payment_submissions WHERE id = ?', [sid])) || null;
}

async function getSubmissionDetail(id) {
    const s = await getSubmission(id);
    if (!s) return null;
    const booking = await dbGet(`SELECT id, name, email, cell, event_name, event_type, date, status, payment_status, total_amount, quote_amount, amount_paid, amount_outstanding FROM bookings WHERE id = ?`, [s.booking_id]);
    const invoice = s.invoice_id ? await dbGet('SELECT id, invoice_number, status, total_amount FROM invoices WHERE id = ?', [s.invoice_id]) : null;
    const events = await dbAll(`SELECT e.id, e.action, e.actor_type, e.actor_id, e.from_status, e.to_status, e.note, e.created_at, a.username AS actor_name
                                FROM eft_submission_events e LEFT JOIN admins a ON e.actor_type = 'admin' AND a.id = e.actor_id
                                WHERE e.submission_id = ? ORDER BY e.id`, [s.id]);
    const schedule = s.schedule_id ? await dbGet('SELECT id, description, due_date, expected_amount, status FROM payment_schedules WHERE id = ?', [s.schedule_id]) : null;
    const sameFile = await dbAll('SELECT id, booking_id, status FROM eft_payment_submissions WHERE proof_sha256 = ? AND id <> ? ORDER BY id LIMIT 5', [s.proof_sha256, s.id]);
    const bank = s.bank_details_id ? await getBankDetailsById(s.bank_details_id) : null;
    // the stored file name is an internal handle (the file is fetched through the proof route by submission id), not something to hand out
    const { proof_sha256, proof_filename, submitted_ip, ...rest } = s;
    return {
        submission: { ...rest, proof_sha256_prefix: String(proof_sha256 || '').slice(0, 12), submitted_ip },
        booking: booking ? { ...booking, total: bookingTotal(booking), outstanding: bookingOutstanding(booking) } : null,
        invoice, schedule, events, same_file_elsewhere: sameFile.filter(x => x.booking_id !== s.booking_id),
        bank_details_shown: bank ? { version: bank.version, bank_name: bank.bank_name, account_number_masked: core.maskAccountNumber(bank.account_number) } : null
    };
}

// The file's bytes for an HTTP response: { stream, contentType, contentLength } (R2) or { diskPath } (disk), else null.
async function openProofFile(submission) {
    if (!submission || !submission.proof_filename) return null;
    return objectStorage.resolveDocument('payment_proofs', submission.proof_filename);
}

module.exports = {
    MAX_PENDING_PER_BOOKING, MAX_UPLOADS_PER_BOOKING_PER_DAY, PAYABLE_BOOKING_STATUSES, today,
    getEftSettings, getActiveBankDetails, getBankDetailsById, getEftState, listBankDetailsVersions, openInvoicesOnVersion,
    saveBankDetails, saveEftSettings,
    bookingTotal, bookingOutstanding, isPayable, currentInvoiceFor,
    clientView, submissionsForBooking, panelForBooking, createSubmission,
    eventRow, pendingCount, listSubmissions, getSubmission, getSubmissionDetail, openProofFile
};
