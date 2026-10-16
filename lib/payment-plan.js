// Client-designed payment plans: the server side of js/shared/payment-plan-rules.js.
//
// The rules module is pure (no DB, no clock). This module feeds it fresh database state, decides
// whether the client may change the plan right now, and writes a validated plan. It is used by:
//   - POST /api/public/bookings/:id/track          (payment_plan block + per-row source/locked)
//   - POST /api/public/bookings/:id/accept-quote   (client designs the plan while accepting)
//   - POST /api/public/bookings/:id/payment-plan   (client rearranges the unpaid milestones)
// Admin-built plans (Setup Milestones, the admin QUOTED->ACCEPTED auto plan) never come through
// here: they are not bound by the client rules (owner decision).
//
// Design notes (docs-internal/client-payment-plans.md):
//   - "Locked" (paid) milestones are decided from bookings.amount_paid, never from status flags:
//     alignMilestonePayments marks rows paid seconds after the money lands, and a refund can leave a
//     stale 'paid' flag behind. buildContext walks the rows the same way the waterfall does.
//   - A plan change never updates or deletes a milestone row. Old unpaid rows become 'superseded'
//     and new rows are inserted: reminders_log.schedule_id is a foreign key (a DELETE fails once a
//     reminder was sent), new ids make the 7/2-day reminders fire again for the new dates, and
//     PayFast intents keep pointing at the row they were built for.
//   - Everything that runs inside a write transaction here is a plain DB read/write on the shared
//     connection: no network, no nested withDbTransaction (that would deadlock the queue).
const moment = require('moment-timezone');
const PaymentPlanRules = require('../js/shared/payment-plan-rules');
const invoicing = require('./invoicing');
const { dbGet, dbAll, dbRun } = require('./db-helpers');
const { insertPaymentScheduleMilestone } = require('../database/repositories/finance.repository');

const BUSINESS_TZ = 'Africa/Johannesburg';
// A PayFast redirect younger than this may still turn into an ITN; rearranging the plan under it
// could leave the payment crediting a row that no longer exists (see PAYMENT_IN_PROGRESS).
const PAYMENT_IN_PROGRESS_MINUTES = 60;
// Request-size bound for the milestones array. The real limit (4 payments in total) is a plan rule
// with a friendly message from validatePlan; this only stops absurd payloads early.
const MAX_MILESTONES_IN_REQUEST = 10;

const LIVE_ROW_SQL = `SELECT id, description, due_date, expected_amount, status, sequence, source, updated_at
    FROM payment_schedules
    WHERE booking_id = ? AND LOWER(COALESCE(status,'pending')) NOT IN ('superseded','cancelled')
    ORDER BY due_date ASC, id ASC`;

const REASONS = {
    NO_QUOTE: 'No quote has been issued for this booking yet.',
    NOT_QUOTED: 'This quote can no longer be accepted.',
    NOT_ACCEPTED: 'The payment plan for this booking can no longer be changed online. Please contact us if you need help.',
    FULLY_PAID: 'This booking is fully paid, so there is nothing left to schedule.',
    REFUNDED: 'This booking has been refunded, so its payment plan can no longer be changed.',
    EVENT_PASSED: 'Your event date has passed, so the payment plan can no longer be changed. Please contact us if you need help.',
    NO_UNPAID: 'There are no unpaid payments to rearrange. Please contact us if you have a question about your balance.',
    NEEDS_ADMIN: 'A payment on this booking needs to be reconciled first — please contact us to change your plan.',
    NO_SLOTS: 'Please contact us to change your payment plan.',
    PAYMENT_IN_PROGRESS: 'A payment was started less than an hour ago. You can change your plan once it has been processed.'
};

// ───────────────────────── dates and policies ─────────────────────────

// "Today" for every plan rule is the business's own calendar date, never the server's or UTC's
// (between 00:00 and 02:00 SAST the UTC date is still yesterday).
function todaySast() {
    return moment().tz(BUSINESS_TZ).format('YYYY-MM-DD');
}

// The SAST calendar date of a stored timestamp. SQLite's CURRENT_TIMESTAMP (accepted_at and
// friends) is UTC with no zone marker: 'YYYY-MM-DD HH:MM:SS'. An explicit offset or 'Z' is honoured.
// Returns null for anything unparseable.
function sastDateOf(utcTimestamp) {
    if (utcTimestamp === null || utcTimestamp === undefined || utcTimestamp === '') return null;
    let m;
    if (utcTimestamp instanceof Date) {
        m = moment(utcTimestamp);
    } else {
        const s = String(utcTimestamp).trim().replace(' ', 'T');
        m = moment.utc(s, moment.ISO_8601, true);
    }
    if (!m.isValid()) return null;
    return m.tz(BUSINESS_TZ).format('YYYY-MM-DD');
}

// Booking Policies "Minimum instalment amount" (policies.min_installment_amount): the smallest
// payment a client may schedule when splitting their balance. Built like getDepositPercentage:
// falls back to the default (R500) when unset or not a number, never negative, rounded to cents.
async function getMinInstallmentAmount() {
    const row = await dbGet("SELECT policy_value FROM policies WHERE policy_key = 'min_installment_amount'").catch(() => null);
    const value = parseFloat(row && row.policy_value);
    if (!Number.isFinite(value)) return PaymentPlanRules.DEFAULT_MIN_PAYMENT;
    return Math.round(Math.max(0, value) * 100) / 100;
}

// ───────────────────────── reading state ─────────────────────────

// Live milestones (not superseded/cancelled), paid ones included, in the waterfall's order.
function loadLiveRows(bookingId) {
    return dbAll(LIVE_ROW_SQL, [bookingId]);
}

function planModeFor(booking, mode) {
    if (mode === 'accept' || mode === 'change') return mode;
    return String((booking && booking.status) || '').toUpperCase() === 'QUOTED' ? 'accept' : 'change';
}

// Which total the plan must add up to.
//   accept: the quote being accepted (the accept route's own quotedTotal; generateInvoice only
//           writes bookings.total_amount after acceptance, from that same quote);
//   change: bookings.total_amount, falling back to the quote exactly like the PayFast ITN's
//           overpayment guard (routes/public/payment.js), so the plan and the guard agree.
function planTotalOf(booking, mode) {
    if (mode === 'accept') {
        return parseFloat(booking.quote_amount) || parseFloat(booking.total_amount) || 0;
    }
    return parseFloat(booking.total_amount)
        || parseFloat(String(booking.quote_amount || '0').replace(/[^0-9.]/g, ''))
        || 0;
}

// The rules context for a booking. opts.totalAmount overrides the total (rands); opts.today
// overrides the SAST date (tests).
async function buildPlanContext(booking, mode, liveRows, opts = {}) {
    const planMode = planModeFor(booking, mode);
    const today = opts.today || todaySast();
    const [depositPercentage, minPaymentAmount] = await Promise.all([
        invoicing.getDepositPercentage(),
        getMinInstallmentAmount()
    ]);
    const totalAmount = opts.totalAmount !== undefined && opts.totalAmount !== null
        ? opts.totalAmount
        : planTotalOf(booking, planMode);
    // The 7-day first-payment window is anchored to the ORIGINAL acceptance (accepted_at is a UTC
    // CURRENT_TIMESTAMP, so convert it to the SAST calendar date), so repeated edits can't keep
    // pushing the deposit back. At acceptance itself, the acceptance date is today.
    const acceptedDate = planMode === 'accept'
        ? today
        : (sastDateOf(booking.accepted_at) || sastDateOf(booking.acceptance_agreed_at));
    return PaymentPlanRules.buildContext({
        mode: planMode,
        today,
        totalAmount,
        amountPaid: parseFloat(booking.amount_paid) || 0,
        liveRows: liveRows || [],
        eventDate: booking.date || booking.event_date || null,
        acceptedDate,
        depositPercentage,
        minPaymentAmount
    });
}

// A PayFast redirect built recently that has not been fulfilled yet. intents.created_at is a UTC
// CURRENT_TIMESTAMP, compared against SQLite's own UTC clock.
async function hasPaymentInProgress(bookingId) {
    const row = await dbGet(
        `SELECT 1 AS hit FROM payfast_payment_intents
         WHERE booking_id = ? AND status = 'pending'
           AND created_at > datetime('now', ?)
         LIMIT 1`,
        [bookingId, `-${PAYMENT_IN_PROGRESS_MINUTES} minutes`]);
    return !!row;
}

// NOT_ACCEPTED on a booking that is still QUOTED: same code (the plan can't be changed yet), but
// the client is pointed at the accept step, where the plan is designed.
const QUOTE_PENDING_MESSAGE = 'Please accept your quote first. You can design your payment plan as part of accepting it.';

function verdict(code, message) {
    return { code, message: message || REASONS[code] || null };
}

// Why the client may not edit the plan right now (code null = editable). Checked in the order the
// spec lists, so the client sees the most fundamental reason first.
async function judgeEditability(booking, mode, ctx) {
    const status = String(booking.status || '').toUpperCase();
    if (mode === 'accept') {
        // Quote expiry is enforced by the accept route itself (it answers 410 with the date).
        if (status !== 'QUOTED') return verdict('NOT_QUOTED');
        if (!(ctx.total_cents > 0)) return verdict('NO_QUOTE');
        if (!(ctx.remaining_cents > 0)) return verdict('FULLY_PAID');
        return verdict(null);
    }

    if (!['ACCEPTED', 'CONFIRMED'].includes(status)) {
        return verdict('NOT_ACCEPTED', status === 'QUOTED' ? QUOTE_PENDING_MESSAGE : null);
    }
    const payStatus = String(booking.payment_status || '').toUpperCase();
    if (payStatus === 'PAID' || !(ctx.remaining_cents > 0)) return verdict('FULLY_PAID');
    if (payStatus === 'REFUNDED') return verdict('REFUNDED');
    if (ctx.event_passed) return verdict('EVENT_PASSED');
    if (!ctx.unpaid_rows.length) return verdict('NO_UNPAID');
    // Part of a milestone is paid, or a row flagged 'paid' isn't covered by the money: rearranging
    // would either drop money on the floor or un-pay a row. The admin sorts these out.
    if (!ctx.consistent) return verdict('NEEDS_ADMIN');
    if (ctx.slots <= 0) return verdict('NO_SLOTS');
    if (await hasPaymentInProgress(booking.id)) return verdict('PAYMENT_IN_PROGRESS');
    return verdict(null);
}

/**
 * Everything the tracker and the plan routes need about a booking's plan, from fresh DB state.
 * Safe to call inside an open BEGIN IMMEDIATE transaction (reads only, no network).
 * @param {Object} bookingRow  a full `bookings` row
 * @param {'accept'|'change'} [mode]  defaults to 'accept' for QUOTED bookings, else 'change'
 * @returns {Promise<{ctx, editable, reason_code, reason, plan_version, liveRows}>}
 */
async function loadPlanState(bookingRow, mode, opts = {}) {
    if (!bookingRow || bookingRow.id === undefined || bookingRow.id === null) {
        throw new TypeError('loadPlanState: a bookings row is required');
    }
    const planMode = planModeFor(bookingRow, mode);
    const liveRows = await loadLiveRows(bookingRow.id);
    const ctx = await buildPlanContext(bookingRow, planMode, liveRows, opts);
    const decision = await judgeEditability(bookingRow, planMode, ctx);
    return {
        ctx,
        editable: decision.code === null,
        reason_code: decision.code,
        reason: decision.message,
        plan_version: PaymentPlanRules.planVersion(liveRows, ctx.paid_cents, ctx.total_cents),
        liveRows
    };
}

// The `payment_plan` block of /track and of the change route's response.
function publicPlanState(state) {
    return {
        mode: state.ctx.mode,
        editable: state.editable,
        reason_code: state.reason_code,
        reason: state.reason,
        plan_version: state.plan_version,
        context: state.ctx
    };
}

// The tracker's `payment_schedule` rows (the columns getPaymentSchedulesForTracking returns, in
// due-date order) plus `source` and `locked`, built from the same rows as the plan context so the
// two always agree.
function toTrackingSchedule(state) {
    const locked = new Set((state.ctx.locked_ids || []).map(String));
    return (state.liveRows || []).map(r => ({
        id: r.id,
        description: r.description,
        due_date: r.due_date,
        expected_amount: r.expected_amount,
        status: r.status,
        updated_at: r.updated_at,
        sequence: r.sequence,
        source: r.source || null,
        locked: locked.has(String(r.id))
    }));
}

// ───────────────────────── request input ─────────────────────────

/**
 * Shape check for a client-supplied `milestones` array (the rules themselves are validatePlan's
 * job, run later against fresh data inside the transaction). Only {amount, due_date} survive:
 * clients never send descriptions, labels are always server-generated.
 * @returns {{ok:true, milestones:Array|null} | {ok:false, message:string}}
 */
function parseMilestonesInput(value, { required = false } = {}) {
    if (value === undefined || value === null) {
        return required ? { ok: false, message: 'Please add at least one payment to your plan.' } : { ok: true, milestones: null };
    }
    if (!Array.isArray(value)) return { ok: false, message: 'Your payment plan could not be read. Please reload the page and try again.' };
    if (value.length === 0) return { ok: false, message: 'Please add at least one payment to your plan.' };
    if (value.length > MAX_MILESTONES_IN_REQUEST) {
        return { ok: false, message: `A payment plan can have at most ${PaymentPlanRules.MAX_PAYMENTS} payments in total.` };
    }
    const milestones = [];
    for (let i = 0; i < value.length; i++) {
        const m = value[i];
        if (!m || typeof m !== 'object' || Array.isArray(m)) {
            return { ok: false, message: `Payment ${i + 1} could not be read. Please reload the page and try again.` };
        }
        const amount = m.amount;
        const due = m.due_date;
        if ((typeof amount === 'string' && amount.length > 32) || (typeof due === 'string' && due.length > 32)) {
            return { ok: false, message: `Payment ${i + 1} could not be read. Please reload the page and try again.` };
        }
        milestones.push({ amount, due_date: due });
    }
    return { ok: true, milestones };
}

// The ready-made plan used when a client accepts without designing one (an old open tab sends no
// `milestones`): `preferredCount` payments (installment_count, default 2), else the largest valid
// preset with fewer payments. null when no preset satisfies the rules (e.g. no payment slots left).
function pickDefaultPreset(ctx, preferredCount) {
    let n = parseInt(preferredCount, 10);
    if (!(n >= 1 && n <= PaymentPlanRules.MAX_PAYMENTS)) n = 2;
    for (let k = Math.min(n, ctx.slots); k >= 1; k--) {
        const preset = PaymentPlanRules.buildPreset(ctx, k);
        if (preset) return preset;
    }
    return null;
}

// ───────────────────────── summaries (audit, notes, emails) ─────────────────────────

function summariseRows(rows, lockedIds) {
    const locked = new Set((lockedIds || []).map(String));
    return (rows || []).map(r => {
        const isLocked = locked.has(String(r.id));
        return {
            id: r.id,
            description: r.description,
            due_date: String(r.due_date || '').slice(0, 10),
            amount: PaymentPlanRules.roundToCents(r.expected_amount) / 100,
            // Locked rows are paid by money even while their flag still lags behind.
            status: isLocked ? 'paid' : String(r.status || 'pending').toLowerCase(),
            locked: isLocked
        };
    });
}

// "R 4,000.00 due 2 Nov 2026 (paid)"
function describeSummaryRow(row) {
    return `${PaymentPlanRules.formatRand(PaymentPlanRules.roundToCents(row.amount))} due ${PaymentPlanRules.formatDate(row.due_date)}`
        + (row.status === 'paid' ? ' (paid)' : '');
}

// Flat {"Payment 2 of 3": "R 4,000.00 due 2 Nov 2026"} for audit_log.old_values/new_values, so the
// admin Change History card can diff it key by key. Repeated descriptions get a " (2)" suffix.
function summaryToFlatObject(rows) {
    const out = {};
    (rows || []).forEach(r => {
        const base = String(r.description || 'Payment');
        let key = base;
        for (let n = 2; Object.prototype.hasOwnProperty.call(out, key); n++) key = `${base} (${n})`;
        out[key] = describeSummaryRow(r);
    });
    return out;
}

// ───────────────────────── writing ─────────────────────────

function planError(code, message) {
    const err = new Error(message);
    err.code = code;
    return err;
}

/**
 * Replaces the unpaid part of a booking's plan with `normalizedRows`.
 * MUST run inside an open BEGIN IMMEDIATE transaction, with `ctx` built inside that same
 * transaction (loadPlanState / buildPlanContext). The caller has already validated the rows
 * (validatePlan / buildPreset); this function only writes them and proves the result is sound.
 *   - supersedes exactly ctx.unpaid_rows (and only while still pending/overdue: a row an
 *     interleaved alignMilestonePayments just marked paid is left alone and the check below
 *     rolls the whole change back);
 *   - inserts the new rows with server-generated labels and sequence numbers that continue after
 *     the locked rows, so /pay's sequence order equals the waterfall's due-date order;
 *   - checks the invariant SUM(live expected_amount) == total, in cents; throws on mismatch.
 * @param {number|string} bookingId
 * @param {Object} ctx  from PaymentPlanRules.buildContext
 * @param {Array<{amount_cents:number, due_date:string}>} normalizedRows  in due-date order
 * @param {{source?: 'client'|'auto'|'admin'}} [opts]
 * @returns {Promise<{before:Array, after:Array, inserted:Array}>} row summaries
 *          ({id, description, due_date, amount (rands), status, locked}) for audit/notifications
 */
async function writeClientPlanInTx(bookingId, ctx, normalizedRows, opts = {}) {
    const source = opts.source || 'client';
    if (!ctx || !Array.isArray(ctx.unpaid_rows)) throw planError('PLAN_INVALID', 'writeClientPlanInTx: a plan context is required');
    const rows = (Array.isArray(normalizedRows) ? normalizedRows : []).map(r => ({
        amount_cents: typeof r.amount_cents === 'number' ? r.amount_cents : PaymentPlanRules.toCents(r.amount),
        due_date: r.due_date
    }));
    if (!rows.length) throw planError('PLAN_INVALID', 'writeClientPlanInTx: at least one milestone is required');
    rows.forEach((r, i) => {
        if (!Number.isInteger(r.amount_cents) || r.amount_cents <= 0 || !PaymentPlanRules.isValidDate(r.due_date)) {
            throw planError('PLAN_INVALID', `writeClientPlanInTx: milestone ${i + 1} is not a valid amount/date`);
        }
        if (i > 0 && !(r.due_date > rows[i - 1].due_date)) {
            throw planError('PLAN_INVALID', 'writeClientPlanInTx: milestones must have strictly ascending due dates');
        }
    });

    // The context must describe the rows as they are right now: same live set, nothing added or
    // superseded since it was built.
    const beforeRows = await loadLiveRows(bookingId);
    const expectedIds = ctx.locked_ids.concat(ctx.unpaid_rows.map(r => r.id)).map(String).sort();
    const actualIds = beforeRows.map(r => String(r.id)).sort();
    if (expectedIds.join(',') !== actualIds.join(',')) {
        throw planError('PLAN_CONFLICT', `Booking #${bookingId}: the payment plan changed while it was being saved`);
    }
    const before = summariseRows(beforeRows, ctx.locked_ids);

    const supersedeIds = ctx.unpaid_rows.map(r => r.id);
    if (supersedeIds.length) {
        const placeholders = supersedeIds.map(() => '?').join(',');
        const upd = await dbRun(
            `UPDATE payment_schedules SET status = 'superseded', updated_at = CURRENT_TIMESTAMP
             WHERE booking_id = ? AND id IN (${placeholders})
               AND LOWER(COALESCE(status,'pending')) IN ('pending','overdue')`,
            [bookingId, ...supersedeIds]);
        if (upd.changes !== supersedeIds.length) {
            throw planError('PLAN_CONFLICT', `Booking #${bookingId}: an unpaid milestone changed status while the plan was being saved`);
        }
    }

    const labels = PaymentPlanRules.labelPlan(ctx, rows);
    const base = Number(ctx.sequence_base) || 0;
    const inserted = [];
    for (let i = 0; i < rows.length; i++) {
        const amount = rows[i].amount_cents / 100;
        const res = await insertPaymentScheduleMilestone(bookingId, labels[i], rows[i].due_date, amount, base + i + 1, source);
        inserted.push({ id: res && res.lastID, description: labels[i], due_date: rows[i].due_date, amount, sequence: base + i + 1, status: 'pending', locked: false });
    }

    // Renumber the paid rows' "Payment k of N" labels so the whole schedule reads consistently
    // (otherwise a paid "Deposit – Payment 1 of 3" sits above new "Payment 2 of 4" rows). Only labels
    // this feature generated are touched — a classic "50% Deposit" or an admin's own wording is left
    // alone — and only the description changes, never an amount or date.
    const totalCount = ctx.locked_ids.length + rows.length;
    const lockedSet = new Set(ctx.locked_ids.map(String));
    const lockedRows = beforeRows.filter(r => lockedSet.has(String(r.id)));
    for (let j = 0; j < lockedRows.length; j++) {
        const m = /^(Deposit – |Final Payment – )?Payment \d+ of \d+$/.exec(String(lockedRows[j].description || ''));
        if (!m) continue;
        // New rows always follow the locked ones, so a paid row is never the final payment any more.
        const relabel = `${m[1] === 'Deposit – ' ? m[1] : ''}Payment ${j + 1} of ${totalCount}`;
        if (relabel !== lockedRows[j].description) {
            await dbRun('UPDATE payment_schedules SET description = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [relabel, lockedRows[j].id]);
        }
    }

    // Invariant, to the cent: the live milestones add up to exactly the booking total. Summed per
    // row in integer cents (a SQL SUM of REALs can land a hair off a whole cent).
    const afterRows = await loadLiveRows(bookingId);
    const liveCents = afterRows.reduce((sum, r) => sum + PaymentPlanRules.roundToCents(r.expected_amount), 0);
    if (liveCents !== ctx.total_cents) {
        throw planError('PLAN_INVARIANT',
            `Booking #${bookingId}: live milestones total ${PaymentPlanRules.formatRand(liveCents)} but the booking total is ${PaymentPlanRules.formatRand(ctx.total_cents)}`);
    }

    return { before, after: summariseRows(afterRows, ctx.locked_ids), inserted };
}

// ───────────────────────── after a client plan change ─────────────────────────

/**
 * Keeps the contract in step with a changed plan, outside any transaction (generateContract opens
 * its own). Only an auto-generated, unsent DRAFT is regenerated. A sent, client-signed,
 * countersigned or frozen contract is never touched (re-rendering it would pull the document out
 * from under a signature), and neither is a PDF the admin uploaded by hand.
 * @returns {Promise<{state:'none'|'draft-regenerated'|'sent'|'signed'|'frozen', regenerated:boolean,
 *                    stale:boolean, detail:string|null}>}
 *          stale = the contract still shows the previous schedule.
 */
async function syncContractAfterPlanChange(bookingId) {
    let contract;
    try {
        contract = await dbGet(
            `SELECT status, is_frozen, signed_by_client_at, uploaded_by, template_version, builder_clauses
             FROM contracts WHERE booking_id = ?`, [bookingId]);
    } catch (e) {
        console.error(`[Payment Plan] Booking #${bookingId}: could not read the contract:`, e.message);
        return { state: 'none', regenerated: false, stale: false, detail: 'unreadable' };
    }
    if (!contract) return { state: 'none', regenerated: false, stale: false, detail: null };

    const status = String(contract.status || '').toLowerCase();
    if (Number(contract.is_frozen) === 1) return { state: 'frozen', regenerated: false, stale: true, detail: null };
    if (status === 'signed' || contract.signed_by_client_at) return { state: 'signed', regenerated: false, stale: true, detail: null };
    if (status === 'sent') return { state: 'sent', regenerated: false, stale: true, detail: null };
    if (status !== 'draft') return { state: 'sent', regenerated: false, stale: true, detail: `status ${status || 'unknown'}` };

    // An uploaded PDF (uploaded_by = the admin's username) can't be re-rendered from the plan, and
    // regenerating would silently replace the admin's document with a generated one.
    if (contract.uploaded_by && contract.uploaded_by !== 'system') {
        return { state: 'sent', regenerated: false, stale: true, detail: 'uploaded' };
    }

    // A draft the admin shaped in the Contract Builder keeps its clauses: pass them back in, exactly
    // as the Builder's own generate does, rather than resetting them to the policy defaults.
    let clauseOverrides = null;
    if (contract.template_version === 'builder-v1' && contract.builder_clauses) {
        try { clauseOverrides = JSON.parse(contract.builder_clauses); } catch (e) { clauseOverrides = null; }
    }
    try {
        // Required lazily: lib/contracts pulls in the PDF renderer, which nothing else here needs.
        const { generateContract } = require('./contracts');
        const result = await generateContract(bookingId, clauseOverrides);
        if (result && result.success) return { state: 'draft-regenerated', regenerated: true, stale: false, detail: null };
        if (result && result.skipped && result.reason === 'signed') return { state: 'signed', regenerated: false, stale: true, detail: null };
        return { state: 'sent', regenerated: false, stale: true, detail: (result && result.reason) || 'not-regenerated' };
    } catch (e) {
        console.error(`[Payment Plan] Booking #${bookingId}: draft contract regeneration failed:`, e.message);
        return { state: 'sent', regenerated: false, stale: true, detail: 'regeneration-failed' };
    }
}

/**
 * Re-renders the live invoice PDF in place (lib/invoicing.js refreshInvoicePdf). Never throws.
 * @returns {Promise<{refreshed:boolean, stale:boolean, reason:string|null}>}
 *          stale = an issued invoice still shows the previous schedule.
 */
async function refreshInvoiceAfterPlanChange(bookingId) {
    if (typeof invoicing.refreshInvoicePdf !== 'function') {
        console.warn(`[Payment Plan] Booking #${bookingId}: refreshInvoicePdf is unavailable — invoice PDF not refreshed.`);
        return { refreshed: false, stale: true, reason: 'unavailable' };
    }
    try {
        const r = await invoicing.refreshInvoicePdf(bookingId);
        const refreshed = !!(r && r.refreshed);
        const reason = (r && r.reason) || null;
        // No live invoice (none issued yet, or only VOID/PAID ones) means there is nothing stale.
        const noInvoice = reason === (invoicing.REFRESH_NO_LIVE_INVOICE || 'no-live-invoice')
            || reason === (invoicing.REFRESH_BOOKING_NOT_FOUND || 'booking-not-found');
        return { refreshed, stale: !refreshed && !noInvoice, reason };
    } catch (e) {
        console.error(`[Payment Plan] Booking #${bookingId}: invoice PDF refresh failed:`, e.message);
        return { refreshed: false, stale: true, reason: e.message || 'refresh-failed' };
    }
}

module.exports = {
    BUSINESS_TZ,
    PAYMENT_IN_PROGRESS_MINUTES,
    MAX_MILESTONES_IN_REQUEST,
    REASONS,
    getMinInstallmentAmount,
    todaySast,
    sastDateOf,
    loadLiveRows,
    planTotalOf,
    buildPlanContext,
    hasPaymentInProgress,
    loadPlanState,
    publicPlanState,
    toTrackingSchedule,
    parseMilestonesInput,
    pickDefaultPreset,
    summariseRows,
    describeSummaryRow,
    summaryToFlatObject,
    writeClientPlanInTx,
    syncContractAfterPlanChange,
    refreshInvoiceAfterPlanChange
};
