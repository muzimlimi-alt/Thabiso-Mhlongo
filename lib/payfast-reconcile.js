// The PayFast safety net: records a payment PayFast has really received but whose notification (ITN) never reached this server.
//
// The problem: a buyer pays at PayFast and sees "payment successful"; the booking only turns paid when PayFast's server-to-server notification arrives.
// If that notification is lost (a deploy at that moment, a server error, PayFast giving up retrying, or - on a local run - an address PayFast cannot reach)
// the client has paid and the booking stays unpaid, with nothing to put it right but someone noticing.
//
// What this does: asks PayFast's OWN account history (lib/payfast-api.js - authenticated with our merchant id and passphrase, so it is PayFast speaking, not a
// request anyone could forge) which payments it received, and records a payment ONLY when it matches one of our pending payment attempts exactly:
// the attempt's own payment reference, the exact amount to the cent, in rand, made after the attempt was started, and not already in the ledger. Anything
// that does not fit that - a different amount, an earlier attempt, a second payment for the same attempt - is NEVER credited: it is shown to an
// administrator (and e-mailed once) to decide.
//
// How it records: through the same atomic steps as the notification (routes/public/payment.js) - the intent is flipped pending -> fulfilled (the guard that
// makes two runs, or this and a late notification, unable to both win), ONE transactions row keyed by PayFast's payment id (UNIQUE: a late notification for
// the same payment is then ignored as a duplicate, exactly as a repeated one is), the booking credited with the shared credit statement (with its overpayment
// guard), the invoice settled if that finished the booking - all or nothing. The e-mails, calendar, milestones and auto-created event follow after the commit.
//
// When it runs: every 5 minutes in the background (only calls PayFast when an attempt has been waiting more than 10 minutes), when a buyer returns from
// PayFast to their booking page (their own booking only, throttled), and when an administrator presses "Check PayFast now". It backs off when PayFast
// is failing and says so on the admin screen. Switch off with PAYFAST_RECONCILE=off. Not scheduled under NODE_ENV=test.
'use strict';
const { dbRun, dbGet, dbAll } = require('./db-helpers');
const { withDbTransaction } = require('./db-transaction');
const api = require('./payfast-api');
const { logAudit } = require('./audit-log');
const { syncBookingToCalendar } = require('./calendar-sync');
const { logPaymentEvent, alignMilestonePayments } = require('./payment-processing');
const {
    sendPaymentReceivedEmail, sendAdminPaymentNotification, sendDepositBalanceDueEmail, sendBookingConfirmedEmail, sendPaidReceiptEmail
} = require('./booking-notifications');
const emailComponents = require('../js/emailComponents');
const { sendEmail } = require('../js/emailService');
const { getNotificationEmail } = require('../database/repositories/settings.repository');
const { getBookingByIdAsync, applyPayfastPaymentToBooking, setBookingEventId } = require('../database/repositories/bookings.repository');
const { markInvoicePaidIfOpenAsync } = require('../database/repositories/invoices-quotations.repository');
const { insertAutoCreatedEvent } = require('../database/repositories/calendar.repository');
const { insertPayfastTransaction } = require('../database/repositories/finance.repository');

const JOB_INTERVAL_MS = 5 * 60 * 1000;
const JOB_MIN_AGE_SECONDS = 10 * 60;             // the notification normally arrives within seconds; give it ten minutes before going to look
const RETURN_MIN_AGE_SECONDS = 30;               // a buyer who has just come back: a short wait so a notification already on its way wins by itself
const LOOKBACK_DAYS = 21;
const MIN_GAP_MS = Number.isFinite(parseInt(process.env.PAYFAST_RECONCILE_MIN_GAP_MS, 10)) ? parseInt(process.env.PAYFAST_RECONCILE_MIN_GAP_MS, 10) : 15 * 1000;   // never two background / buyer calls to PayFast closer than this (tests set 0)
const BOOKING_THROTTLE_MS = 30 * 1000;           // a buyer's page can ask about its own booking at most this often
const FAILURES_BEFORE_ALERT = 3;

let running = false;
let lastApiCallAt = 0;
const lastForBooking = new Map();

// ── configuration (read live: Admin > Settings changes process.env immediately) ─────────────────────────────
const config = (env = process.env) => api.resolveConfig(env);

// ── state ────────────────────────────────────────────────────────────────────────────────────────────────────
const getState = () => dbGet('SELECT * FROM payfast_reconcile_state WHERE id = 1');
async function saveState(patch) {
    const keys = Object.keys(patch);
    if (!keys.length) return;
    await dbRun(`UPDATE payfast_reconcile_state SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = 1`, keys.map((k) => patch[k]));
}
const sqliteTime = (d) => d.toISOString().slice(0, 19).replace('T', ' ');

async function getStatus() {
    const cfg = config();
    const s = await getState();
    let stats = null; try { stats = s.last_stats ? JSON.parse(s.last_stats) : null; } catch (e) { /* ignore */ }
    const waiting = await dbGet(`SELECT COUNT(*) AS n FROM payfast_payment_intents WHERE status = 'pending' AND created_at >= datetime('now', ?) AND created_at <= datetime('now', ?)`,
        [`-${LOOKBACK_DAYS} days`, `-${JOB_MIN_AGE_SECONDS} seconds`]);
    const open = await dbGet(`SELECT COUNT(*) AS n FROM payfast_reconcile_findings WHERE status = 'open'`);
    return {
        enabled: cfg.enabled, configured: cfg.configured, sandbox: cfg.sandbox,
        lastRunAt: s.last_run_at, lastSuccessAt: s.last_success_at, lastError: s.last_error, lastErrorCategory: s.last_error_category,
        consecutiveFailures: s.consecutive_failures, retryAfter: s.retry_after, lastStats: stats,
        waitingAttempts: waiting.n, openFindings: open.n
    };
}

// ── findings ─────────────────────────────────────────────────────────────────────────────────────────────────
async function listFindings({ includeResolved = true, limit = 50 } = {}) {
    return dbAll(`SELECT f.*, b.name AS client_name, b.event_name FROM payfast_reconcile_findings f LEFT JOIN bookings b ON b.id = f.booking_id
                  ${includeResolved ? '' : "WHERE f.status = 'open'"} ORDER BY CASE f.status WHEN 'open' THEN 0 ELSE 1 END, f.first_seen_at DESC, f.id DESC LIMIT ?`,
        [Math.max(1, Math.min(200, parseInt(limit, 10) || 50))]);
}

// Resolves with true when this call created the row (the first time PayFast's payment id is reported).
async function insertFinding(f) {
    const r = await dbRun(
        `INSERT OR IGNORE INTO payfast_reconcile_findings (pf_payment_id, m_payment_id, booking_id, kind, gross_amount, paid_at, detail, status, transaction_id, resolved_at, resolution_note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ${f.status === 'resolved' ? 'CURRENT_TIMESTAMP' : 'NULL'}, ?)`,
        [String(f.pfPaymentId), f.mPaymentId || null, f.bookingId || null, f.kind, f.gross == null ? null : f.gross, f.paidAt || null, f.detail || null,
         f.status || 'open', f.transactionId || null, f.status === 'resolved' ? (f.note || null) : null]);
    return r.changes === 1;
}

async function resolveFinding(id, adminId, note, req) {
    const text = String(note || '').trim().slice(0, 500);
    if (text.length < 3) return { ok: false, status: 400, message: 'Please say what was done about it (a few words).' };
    const row = await dbGet('SELECT * FROM payfast_reconcile_findings WHERE id = ?', [parseInt(id, 10) || 0]);
    if (!row) return { ok: false, status: 404, message: 'Not found.' };
    if (row.status === 'resolved') return { ok: false, status: 409, message: 'This was already resolved.' };
    const r = await dbRun(`UPDATE payfast_reconcile_findings SET status = 'resolved', resolved_at = CURRENT_TIMESTAMP, resolved_by = ?, resolution_note = ? WHERE id = ? AND status = 'open'`, [adminId || null, text, row.id]);
    if (r.changes === 0) return { ok: false, status: 409, message: 'This was already resolved.' };
    await logAudit({ tableName: 'payfast_reconcile_findings', recordId: row.id, action: 'PAYFAST_FINDING_RESOLVED', req, oldValues: { status: 'open' }, newValues: { status: 'resolved', pf_payment_id: row.pf_payment_id, booking_id: row.booking_id }, reason: text })
        .catch((e) => console.error('[PayFast safety net] Audit write failed:', e.message));
    return { ok: true, status: 200, message: 'Marked as resolved.' };
}

// ── recording one recovered payment ──────────────────────────────────────────────────────────────────────────
const METHOD_OF_FUNDING = { CREDIT_CARD: 'credit_card', CC: 'credit_card', DEBIT_CARD: 'credit_card', DC: 'credit_card', EFT: 'bank_transfer', INSTANT_EFT: 'bank_transfer' };

// The payment attempt is for ONE instalment (or the deposit / the whole amount). If that has already been settled some other way - an EFT approved, a payment
// recorded by hand - PayFast's money is a second payment for it: the client may have paid twice. That needs a person, so it is reported, never credited.
// Returns why it is settled, or null.
async function alreadySettledReason(intent, booking) {
    const sched = /_SCHED(\d+)$/.exec(String(intent.m_payment_id || ''));
    if (sched) {
        const s = await dbGet('SELECT status FROM payment_schedules WHERE id = ? AND booking_id = ?', [parseInt(sched[1], 10), intent.booking_id]);
        if (s && String(s.status || '').toLowerCase() === 'paid') return 'that instalment was already marked as paid by another payment';
        return null;
    }
    const type = String(intent.payment_type || '').toUpperCase();
    const status = String((booking && booking.payment_status) || '').toUpperCase();
    if (type === 'FULL' && status === 'PAID') return 'the booking was already paid in full by another payment';
    if (type === 'DEPOSIT' && (status === 'DEPOSIT_PAID' || status === 'PAID')) return 'the deposit was already paid by another payment';
    return null;
}

async function recordRecovered(intent, row, reason) {
    const amount = row.grossCents / 100;
    const bookingId = intent.booking_id;
    const pfId = String(row.pfPaymentId);
    const outcome = await withDbTransaction(async () => {
        try { await dbRun('BEGIN IMMEDIATE'); } catch (e) { return { busy: true }; }
        const bail = async (result) => { await dbRun('ROLLBACK').catch(() => {}); return result; };
        try {
            if (String(intent.m_payment_id).split('_')[0] !== String(bookingId)) return await bail({ blocked: 'The payment reference does not belong to this booking.' });
            const booking = await getBookingByIdAsync(bookingId);
            if (!booking) return await bail({ blocked: 'The booking no longer exists.' });
            const total = parseFloat(booking.total_amount) || parseFloat(String(booking.quote_amount || '0').replace(/[^0-9.]/g, '')) || 0;
            if (!(total > 0)) return await bail({ blocked: 'The booking has no total amount, so a payment cannot be applied safely.' });
            if (await dbGet('SELECT id FROM transactions WHERE pf_payment_id = ?', [pfId])) return await bail({ raced: true });        // the notification arrived after all
            const settled = await alreadySettledReason(intent, booking);
            if (settled) return await bail({ duplicate: settled });
            const flip = await dbRun(`UPDATE payfast_payment_intents SET status = 'fulfilled', fulfilled_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'pending'`, [intent.id]);
            if (flip.changes === 0) return await bail({ raced: true });                                                                  // another run (or the notification) got there first
            const method = METHOD_OF_FUNDING[String(row.fundingType || '').toUpperCase().replace(/\s+/g, '_')] || 'payfast';
            const tx = await insertPayfastTransaction(bookingId, amount, method, pfId, pfId, 'COMPLETE', null);
            const credit = await applyPayfastPaymentToBooking(
                amount, total, intent.payment_type || 'FULL', pfId, null,
                JSON.stringify({ source: 'payfast-history-reconciliation', reason, pf_payment_id: pfId, m_payment_id: intent.m_payment_id, amount_gross: amount.toFixed(2), paid_at: row.date, funding_type: row.fundingType || null }),
                'payfast', bookingId);
            if (credit.changes === 0) return await bail({ blocked: `Recording it would take the booking above its total of R${total.toFixed(2)}.` });
            const fresh = await getBookingByIdAsync(bookingId);
            if (fresh && fresh.payment_status === 'PAID') await markInvoicePaidIfOpenAsync(bookingId);
            await dbRun('COMMIT');
            return { ok: true, fresh, transactionId: tx.lastID, previous: booking };
        } catch (e) {
            await dbRun('ROLLBACK').catch(() => {});
            if (/UNIQUE constraint/i.test(e.message || '')) return { raced: true };                // the notification for this very payment won the race
            return { error: e };
        }
    });
    return outcome;
}

// After the commit - the same follow-up the notification gives a card payment (routes/public/payment.js). None of it may undo the payment.
async function afterRecorded(fresh, intent, row) {
    const newAmountPaid = parseFloat(fresh.amount_paid) || 0;
    const newOutstanding = parseFloat(fresh.amount_outstanding) || 0;
    const status = fresh.payment_status;
    await syncBookingToCalendar(fresh).catch((e) => console.error('[PayFast safety net] Calendar sync failed:', e.message));
    await sendPaymentReceivedEmail(fresh, newAmountPaid, newOutstanding, status).catch((e) => console.error('[PayFast safety net] Payment-received email failed:', e.message));
    sendAdminPaymentNotification(fresh, newAmountPaid, status).catch((e) => console.error('[PayFast safety net] Admin payment notification failed:', e.message));
    if (status === 'DEPOSIT_PAID' && newOutstanding > 0) sendDepositBalanceDueEmail(fresh, newOutstanding).catch((e) => console.error('[PayFast safety net] Balance-due email failed:', e.message));
    if (status === 'PAID') {
        sendBookingConfirmedEmail(fresh).catch((e) => console.error('[PayFast safety net] Confirmed email failed:', e.message));
        sendPaidReceiptEmail(fresh).catch((e) => console.error('[PayFast safety net] Paid receipt email failed:', e.message));
    }
    if (fresh.status === 'CONFIRMED' && !fresh.event_id) {
        const evDatetime = fresh.date + (fresh.event_start_time ? ' ' + fresh.event_start_time : ' 00:00:00');
        insertAutoCreatedEvent(fresh.event_name || fresh.event_type || 'Booking Event', evDatetime, fresh.event_location || null, fresh.venue_id || null, fresh.id,
            function (evErr) {
                if (evErr) { console.error('[Auto-Event] PayFast safety net: insert failed for booking #' + fresh.id + ':', evErr.message); return; }
                setBookingEventId(this.lastID, fresh.id);
            });
    }
    alignMilestonePayments(fresh.id, newAmountPaid, (e) => { if (e) console.error('[PayFast safety net] Payment schedule update failed:', e.message); });
}

// ── e-mail to the owner ──────────────────────────────────────────────────────────────────────────────────────
const esc = (s) => emailComponents.esc(s);
async function adminMail(subject, titleOverride, trigger, { severity, lead, cards, bodyHtml }) {
    const to = await getNotificationEmail();
    if (!to) return;
    const html = emailComponents.renderSystemEmail({ preheaderText: subject, category: 'Payments & Invoices', severity, leadFact: lead, cards, bodyHtml });
    await sendEmail({ to, subject, htmlContent: html, preWrapped: true, titleOverride, trigger_event: trigger });
}

async function mailRecovered(intent, row, fresh, previous) {
    const cancelled = ['CANCELLED', 'EXPIRED'].includes(String(previous.status || '').toUpperCase());
    await adminMail(`[PayFast] Recorded a payment whose notification never arrived - booking #${intent.booking_id}`, 'PayFast Payment Recovered', 'Admin: PayFast Payment Recovered', {
        severity: cancelled ? 'alert' : 'warning',
        lead: `PayFast received <strong style="color:#FAFAFA;">R${(row.grossCents / 100).toFixed(2)}</strong> for booking <strong style="color:#FAFAFA;">#${intent.booking_id}</strong>, but its notification never reached this website. The safety net checked PayFast's own records, found the payment and <strong style="color:#D4AF37;">recorded it</strong>.`,
        cards: [{ rows: [
            { label: 'Booking', value: `#${intent.booking_id} · ${previous.name || ''}`, mono: false },
            { label: 'PayFast payment id', value: String(row.pfPaymentId) },
            { label: 'Paid at (PayFast clock)', value: row.date },
            { label: 'Payment status now', value: String(fresh.payment_status), highlight: true }
        ] }],
        bodyHtml: `<p style="margin:0; color:#E6E6E6;">${cancelled ? `<strong style="color:#E8A83E;">This booking is ${esc(previous.status)}</strong> - the client has paid for something that is no longer going ahead, so a refund may be due. ` : ''}If these keep happening, PayFast's notifications are not reaching the site: check that the live site is reachable and that PayFast's notify URL is correct.</p>`
    });
}

async function mailFindings(findings) {
    if (!findings.length) return;
    await adminMail(`[PayFast] ${findings.length} payment(s) need your attention`, 'PayFast Payments Need Attention', 'Admin: PayFast Reconciliation Finding', {
        severity: 'alert',
        lead: `PayFast's own records show ${findings.length === 1 ? 'a payment that was' : findings.length + ' payments that were'} <strong style="color:#E8A83E;">not recorded automatically</strong>, because ${findings.length === 1 ? 'it does' : 'they do'} not match the payment that was set up exactly. Nothing was credited.`,
        cards: [{ title: 'Payments to check', rows: findings.map((f) => ({ label: `#${f.bookingId} · ${f.pfPaymentId}`, value: f.detail, mono: false })) }],
        bodyHtml: `<p style="margin:0; color:#E6E6E6;">Open <strong>Finance &rarr; Reconciliation</strong> in the admin panel. If a payment is genuine, record it on the booking by hand; then mark it resolved there.</p>`
    });
}

async function mailFailure(category, message) {
    await adminMail('[PayFast] The safety net cannot reach PayFast', 'PayFast Safety Net Problem', 'Admin: PayFast Safety Net Failure', {
        severity: 'alert',
        lead: category === 'AUTH'
            ? `PayFast <strong style="color:#E8A83E;">refused the merchant credentials</strong> the safety net uses. Until that is fixed, a payment whose notification is lost will not be recovered automatically.`
            : `The safety net could not get PayFast's payment history several times in a row. Until it can, a payment whose notification is lost will not be recovered automatically.`,
        cards: [{ rows: [{ label: 'Problem', value: String(message || category), mono: false }] }],
        bodyHtml: `<p style="margin:0; color:#E6E6E6;">${category === 'AUTH' ? 'Check the PayFast merchant id and passphrase under <strong>Admin Settings &rarr; PayFast</strong> (the passphrase must be the one set in the PayFast dashboard).' : 'It will keep trying, with longer pauses. Normal payments are not affected.'}</p>`
    });
}

async function recordFailure(err) {
    const s = await getState();
    const n = (s.consecutive_failures || 0) + 1;
    const wait = err.code === 'AUTH' ? 60 * 60 : (err.code === 'RATE_LIMIT' && err.retryAfterSeconds) ? err.retryAfterSeconds : Math.min(60 * 60, 5 * 60 * Math.pow(2, n - 1));
    const patch = { last_run_at: sqliteTime(new Date()), last_error: String(err.message || err).slice(0, 300), last_error_category: err.code || 'ERROR', consecutive_failures: n, retry_after: sqliteTime(new Date(Date.now() + wait * 1000)) };
    const alertAt = err.code === 'AUTH' ? 1 : FAILURES_BEFORE_ALERT;
    if (n >= alertAt && !s.failure_alerted) { patch.failure_alerted = 1; mailFailure(err.code, err.message).catch((e) => console.error('[PayFast safety net] Failure e-mail failed:', e.message)); }
    await saveState(patch);
}

// ── one check ────────────────────────────────────────────────────────────────────────────────────────────────
// opts: { reason: 'job' | 'admin' | 'buyer-return', bookingId (limit to one booking), minIntentAgeSeconds, dryRun, adminId, req }
async function reconcileNow(opts = {}) {
    const reason = opts.reason || 'admin';
    const cfg = config();
    if (!cfg.enabled) return { ok: true, skipped: 'disabled', message: 'The PayFast safety net is switched off (PAYFAST_RECONCILE=off).' };
    if (!cfg.configured) return { ok: true, skipped: 'not-configured', message: 'No PayFast merchant id is configured.' };
    if (running) return { ok: true, skipped: 'busy', message: 'A check is already running.' };

    const now = Date.now();
    if (opts.bookingId && reason === 'buyer-return') {                    // a buyer's page is throttled per booking; an administrator is never held back
        const last = lastForBooking.get(opts.bookingId) || 0;
        if (now - last < BOOKING_THROTTLE_MS) return { ok: true, skipped: 'throttled', message: 'Checked a moment ago.' };
    }
    if (reason !== 'admin' && now - lastApiCallAt < MIN_GAP_MS) return { ok: true, skipped: 'throttled', message: 'PayFast was asked a moment ago.' };

    const minAge = Number.isFinite(opts.minIntentAgeSeconds) ? opts.minIntentAgeSeconds : (reason === 'admin' ? 0 : JOB_MIN_AGE_SECONDS);
    const params = [`-${LOOKBACK_DAYS} days`, `-${Math.max(0, minAge)} seconds`];
    let sql = `SELECT * FROM payfast_payment_intents WHERE status = 'pending' AND created_at >= datetime('now', ?) AND created_at <= datetime('now', ?)`;
    if (opts.bookingId) { sql += ' AND booking_id = ?'; params.push(opts.bookingId); }
    const intents = await dbAll(sql + ' ORDER BY created_at', params);
    if (!intents.length) return { ok: true, checked: 0, recovered: [], findings: [], message: 'No payment is waiting to be confirmed.' };

    if (opts.bookingId && reason === 'buyer-return') {                    // only a check that really asks PayFast uses up the buyer's allowance
        lastForBooking.set(opts.bookingId, now);
        if (lastForBooking.size > 500) for (const k of lastForBooking.keys()) { if (now - lastForBooking.get(k) > 10 * 60 * 1000) lastForBooking.delete(k); }
    }
    running = true;
    try {
        const earliest = Math.min(...intents.map((i) => Date.parse(String(i.created_at).replace(' ', 'T') + 'Z')));
        const saDay = (ms) => new Date(ms + 2 * 3600 * 1000).toISOString().slice(0, 10);
        const from = saDay(earliest - 24 * 3600 * 1000), to = saDay(now + 24 * 3600 * 1000);
        let history;
        lastApiCallAt = Date.now();
        try {
            history = await api.fetchHistory(cfg, { from, to });
        } catch (e) {
            if (!opts.dryRun) await recordFailure(e);
            console.error(`[PayFast safety net] Could not read PayFast's history (${e.code || 'error'}): ${e.message}`);
            return { ok: false, error: e.code || 'ERROR', message: e.message, checked: intents.length, recovered: [], findings: [] };
        }

        const pfIds = history.rows.map((r) => r.pfPaymentId).filter(Boolean);
        const recorded = new Set();
        for (let i = 0; i < pfIds.length; i += 200) {
            const chunk = pfIds.slice(i, i + 200);
            for (const t of await dbAll(`SELECT pf_payment_id FROM transactions WHERE pf_payment_id IN (${chunk.map(() => '?').join(',')})`, chunk)) recorded.add(String(t.pf_payment_id));
        }
        const plan = api.planRecovery(intents, history.rows, recorded);
        const summary = { ok: true, checked: intents.length, historyRows: history.rows.length, recovered: [], findings: [], dryRun: !!opts.dryRun };

        // findings first (they need a person), then the recoveries
        const needAttention = [];
        for (const f of plan.findings) {
            const entry = { pfPaymentId: f.row.pfPaymentId, mPaymentId: f.row.mPaymentId, bookingId: f.intent.booking_id, kind: f.kind, gross: f.row.grossCents / 100, paidAt: f.row.date, detail: f.detail };
            summary.findings.push(entry);
            if (!opts.dryRun && await insertFinding(entry)) needAttention.push(entry);
        }
        for (const { intent, row } of plan.recover) {
            const entry = { bookingId: intent.booking_id, pfPaymentId: String(row.pfPaymentId), amount: row.grossCents / 100, paidAt: row.date };
            const reportAsDuplicate = async (why) => {
                const detail = `PayFast received R${entry.amount.toFixed(2)} (${row.date}) for ${intent.m_payment_id}, but ${why}. Nothing was recorded here: the client may have paid twice and be owed a refund, or the other payment may have been recorded in error.`;
                const dup = { pfPaymentId: row.pfPaymentId, mPaymentId: intent.m_payment_id, bookingId: intent.booking_id, kind: 'duplicate_payment', gross: entry.amount, paidAt: row.date, detail };
                summary.findings.push(dup);
                if (!opts.dryRun && await insertFinding(dup)) needAttention.push(dup);
            };
            const settledBefore = await alreadySettledReason(intent, await getBookingByIdAsync(intent.booking_id));       // a preview must not promise what the recording would refuse
            if (settledBefore) { await reportAsDuplicate(settledBefore); continue; }
            if (opts.dryRun) { summary.recovered.push({ ...entry, dryRun: true }); continue; }
            const out = await recordRecovered(intent, row, reason);
            if (out.ok) {
                summary.recovered.push(entry);
                const note = `Recorded automatically from PayFast's own history (${reason}); the notification never arrived.`;
                await insertFinding({ pfPaymentId: row.pfPaymentId, mPaymentId: intent.m_payment_id, bookingId: intent.booking_id, kind: 'recovered', gross: entry.amount, paidAt: row.date, detail: note, status: 'resolved', transactionId: out.transactionId, note });
                logPaymentEvent(intent.booking_id, 'RECONCILED_FROM_PAYFAST', { amount_gross: entry.amount, payment_method: 'payfast', pf_payment_id: String(row.pfPaymentId), m_payment_id: intent.m_payment_id, payment_status: 'COMPLETE' }, true, String(row.pfPaymentId), { auditOnly: true });
                await logAudit({ tableName: 'bookings', recordId: intent.booking_id, action: 'PAYFAST_PAYMENT_RECOVERED', req: opts.req, oldValues: { payment_status: out.previous.payment_status, amount_paid: out.previous.amount_paid },
                    newValues: { payment_status: out.fresh.payment_status, amount_paid: out.fresh.amount_paid, pf_payment_id: String(row.pfPaymentId), transaction_id: out.transactionId }, reason })
                    .catch((e) => console.error('[PayFast safety net] Audit write failed:', e.message));
                afterRecorded(out.fresh, intent, row).catch((e) => console.error('[PayFast safety net] Follow-up failed:', e.message));
                mailRecovered(intent, row, out.fresh, out.previous).catch((e) => console.error('[PayFast safety net] Recovery e-mail failed:', e.message));
            } else if (out.raced) {
                summary.raced = (summary.raced || 0) + 1;                      // the notification (or another check) recorded it first: nothing to do
            } else if (out.duplicate) {
                await reportAsDuplicate(out.duplicate);                          // settled between the preview above and the recording
            } else if (out.blocked || out.error || out.busy) {
                const why = out.blocked || (out.busy ? 'The database was busy; it will be tried again.' : (out.error && out.error.message) || 'Unexpected error.');
                console.error(`[PayFast safety net] Booking #${intent.booking_id}: PayFast payment ${row.pfPaymentId} NOT recorded - ${why}`);
                if (!out.busy) {
                    const detail = `PayFast received R${entry.amount.toFixed(2)} (${row.date}) for ${intent.m_payment_id}, which matches the payment set up, but it could not be recorded: ${why}`;
                    const blocked = { pfPaymentId: row.pfPaymentId, mPaymentId: intent.m_payment_id, bookingId: intent.booking_id, kind: 'blocked', gross: entry.amount, paidAt: row.date, detail };
                    summary.findings.push(blocked);
                    if (await insertFinding(blocked)) needAttention.push(blocked);
                }
            }
        }
        if (!opts.dryRun) {
            mailFindings(needAttention).then(() => needAttention.length && dbRun(`UPDATE payfast_reconcile_findings SET notified_at = CURRENT_TIMESTAMP WHERE pf_payment_id IN (${needAttention.map(() => '?').join(',')})`, needAttention.map((f) => String(f.pfPaymentId))))
                .catch((e) => console.error('[PayFast safety net] Findings e-mail failed:', e.message));
            await saveState({ last_run_at: sqliteTime(new Date()), last_success_at: sqliteTime(new Date()), last_error: null, last_error_category: null, consecutive_failures: 0, retry_after: null, failure_alerted: 0,
                last_stats: JSON.stringify({ reason, checked: intents.length, historyRows: history.rows.length, recovered: summary.recovered.length, findings: summary.findings.length, at: new Date().toISOString() }) });
        }
        summary.message = summary.recovered.length ? `${summary.recovered.length} payment(s) ${opts.dryRun ? 'would be recorded' : 'recorded'} from PayFast's own records.` : (summary.findings.length ? 'Nothing was recorded; some payments need a person to look at them.' : 'PayFast has no payment waiting that we have not recorded.');
        return summary;
    } finally {
        running = false;
    }
}

// The background tick: costs one tiny query when nothing is waiting, and respects the back-off after a failure.
async function runIfDue() {
    const cfg = config();
    if (!cfg.enabled || !cfg.configured) return null;
    const s = await getState();
    if (s.retry_after && Date.parse(String(s.retry_after).replace(' ', 'T') + 'Z') > Date.now()) return null;
    return reconcileNow({ reason: 'job' });
}

function registerPayFastReconcileJob() {
    if (process.env.NODE_ENV === 'test') return;                          // tests drive it explicitly
    setTimeout(() => {
        runIfDue().catch((e) => console.error('[PayFast safety net] Startup run failed:', e.message));
        setInterval(() => runIfDue().catch((e) => console.error('[PayFast safety net] Scheduled run failed:', e.message)), JOB_INTERVAL_MS);
    }, 2 * 60 * 1000);
}

module.exports = {
    config, getStatus, listFindings, resolveFinding, reconcileNow, runIfDue, registerPayFastReconcileJob,
    JOB_MIN_AGE_SECONDS, RETURN_MIN_AGE_SECONDS, BOOKING_THROTTLE_MS
};
