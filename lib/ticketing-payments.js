// Event ticketing - payments through the EXISTING PayFast integration (docs-internal/ticketing.md):
//   * checkout: the same signed redirect as bookings (lib/payfast-signature.js buildPayfastCheckout), m_payment_id TKT_<order id>;
//   * confirmation: ONLY PayFast's server-to-server notification (the same /api/payment/webhook/payfast endpoint - routes/public/payment.js
//     hands TKT_ ids here) or the safety net reading PayFast's own history (lib/payfast-reconcile.js). The buyer's return to the site is
//     never proof of payment.
//   * confirmTicketPayment() is the ONE place an order becomes paid and tickets are issued, for both of those paths.
//
// Checks on a ticket notification (shared steps in lib/payfast-itn-checks.js, applied as the booking path applies them, except where noted):
//   timestamp (production) -> signature (refused in EVERY mode - stricter than bookings, which only warn in sandbox) -> source IP
//   (production) -> merchant id -> PayFast validate POST (production) -> PayFast payment id present -> amount EXACTLY the order total.
// Each notification is stored once in ticket_webhook_events (the only place its full payload lives); a payment is processed once
// (verified-row partial UNIQUE index + ticket_orders.gateway_payment_id UNIQUE + an order-status guard).
const { dbRun, dbGet, dbAll } = require('./db-helpers');
const core = require('./ticketing-core');
const ticketing = require('./ticketing');
const { verifyPayFastItnSignature, buildPayfastCheckout, payfastBaseUrl, payfastNotifyBaseUrl } = require('./payfast-signature');
const { isSandboxPayfast, itnTimestampCheck, itnSourceIp, confirmItnWithPayfast } = require('./payfast-itn-checks');
const { PAYFAST_VALID_IPS } = require('../middleware/rate-limiters');

const nowIso = () => new Date().toISOString();
const tag = (order) => `ticket order #${order && order.id}`;

// ---------------------------------------------------------------- checkout (the redirect to PayFast)

// order: a pending order that has its buyer details (lib/ticketing.js startCheckout). The amount comes from the order row, never the request.
function buildCheckout(order, event, req) {
    const base = payfastBaseUrl(req);
    const ref = encodeURIComponent(order.public_reference);
    const name = core.splitName(order.buyer_name);
    return buildPayfastCheckout({
        return_url: `${base}/?tickets=${ref}&payment=success`,
        cancel_url: `${base}/?tickets=${ref}&payment=cancel`,
        notify_url: `${payfastNotifyBaseUrl(req)}/api/payment/webhook/payfast`,
        name_first: name.first.substring(0, 100),
        name_last: name.last.substring(0, 100),
        email_address: order.buyer_email,
        m_payment_id: order.m_payment_id,
        amount: core.centsToAmountString(order.total_cents),
        item_name: `Tickets - ${(event && event.event_title) || 'Show'} - Order ${order.id}`
    });
}

// ---------------------------------------------------------------- the audit trail of every notification

// (Both writes go through the transaction queue - see the note at the top of lib/ticketing.js.)
async function recordNotification({ orderId, pfData, raw, source, outcome }) {
    const r = await ticketing.inTransaction(() => dbRun(
        `INSERT INTO ticket_webhook_events (order_id, gateway_payment_id, m_payment_id, payment_status, amount_cents, source, verified, outcome, raw_payload, received_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
        [orderId || null, pfData.pf_payment_id ? String(pfData.pf_payment_id) : null, pfData.m_payment_id || null, pfData.payment_status || null,
         core.amountStringToCents(pfData.amount_gross), source, outcome, JSON.stringify(raw || pfData), nowIso()]));
    return r.lastID;
}
const setOutcome = (id, outcome) => (id ? ticketing.inTransaction(() => dbRun('UPDATE ticket_webhook_events SET outcome = ? WHERE id = ?', [outcome, id])).catch(() => {}) : Promise.resolve());

// ---------------------------------------------------------------- the one place an order becomes paid

// Resolves one of:
//   { ok, order, tickets, late }        - paid, tickets issued (late = the hold had lapsed but stock allowed re-reserving)
//   { refundRequired, order }            - PayFast took the money but the tickets were gone: no tickets, flagged for a refund
//   { duplicate } | { mismatch } | { notFound } | { notPayable, status }
// webhookEventId: the ticket_webhook_events row of an ITN (null for a safety-net recovery, which writes its own row).
const rollbackAs = (outcome) => Object.assign(new Error('ticketing: rolled back'), { rollbackAs: outcome });

async function confirmTicketPayment({ orderId, pfPaymentId, amountCents, source, webhookEventId, raw }) {
    if (!pfPaymentId) return { notPayable: true, status: 'no_payment_id' };
    const result = await ticketing.inTransaction(async () => {
        const order = await ticketing.getOrderById(orderId);
        if (!order) return { notFound: true };
        if (order.status === 'paid' || order.status === 'refunded') return { duplicate: true, order };
        if (amountCents !== order.total_cents) return { mismatch: true, order };
        if (order.gateway_payment_id && order.gateway_payment_id !== String(pfPaymentId)) return { duplicate: true, order };

        // This payment is processed once: a VERIFIED row per (PayFast payment, status). A replay fails the UNIQUE index -> duplicate.
        try {
            if (webhookEventId) {
                await dbRun("UPDATE ticket_webhook_events SET verified = 1, order_id = ?, outcome = 'processing' WHERE id = ?", [order.id, webhookEventId]);
            } else {
                await dbRun(
                    `INSERT INTO ticket_webhook_events (order_id, gateway_payment_id, m_payment_id, payment_status, amount_cents, source, verified, outcome, raw_payload, received_at)
                     VALUES (?, ?, ?, 'COMPLETE', ?, ?, 1, 'processing', ?, ?)`,
                    [order.id, String(pfPaymentId), order.m_payment_id, amountCents, source || 'reconcile', JSON.stringify(raw || null), nowIso()]);
            }
        } catch (e) {
            if (/UNIQUE/.test(e.message)) return { duplicate: true, order };
            throw e;
        }

        const items = await dbAll('SELECT ticket_type_id, quantity FROM ticket_order_items WHERE order_id = ?', [order.id]);
        let late = false;
        let stockOk = true;
        if (order.status === 'pending') {
            // The hold still exists (even if its time passed, nothing has released it yet): held -> sold.
            for (const it of items) {
                const r = await dbRun('UPDATE ticket_types SET reserved = reserved - ?, sold = sold + ? WHERE id = ? AND reserved >= ?', [it.quantity, it.quantity, it.ticket_type_id, it.quantity]);
                if (!r.changes) throw new Error(`ticketing: hold accounting broken for order ${order.id} tier ${it.ticket_type_id}`);
            }
        } else {
            // expired / failed: the hold was released, so the payment arrived LATE - take the tickets from what is left, all or nothing.
            late = true;
            await dbRun('SAVEPOINT late_stock');
            for (const it of items) {
                const r = await dbRun('UPDATE ticket_types SET sold = sold + ? WHERE id = ? AND sold + reserved + ? <= capacity', [it.quantity, it.ticket_type_id, it.quantity]);
                if (!r.changes) { stockOk = false; break; }
            }
            if (stockOk) await dbRun('RELEASE late_stock');
            else { await dbRun('ROLLBACK TO late_stock'); await dbRun('RELEASE late_stock'); }
        }

        // From here on stock has moved: any "no" must ROLL BACK (throw), never return - a normal return commits.
        const t = nowIso();
        let flip;
        try {
            flip = await dbRun(
                `UPDATE ticket_orders SET status = 'paid', paid_at = ?, gateway_payment_id = ?, refund_required = ?, refund_reason = ?
                 WHERE id = ? AND status IN ('pending', 'expired', 'failed')`,
                [t, String(pfPaymentId), stockOk ? 0 : 1, stockOk ? null : 'Paid after the hold ran out, and the tickets had sold out meanwhile.', order.id]);
        } catch (e) {
            if (/UNIQUE/.test(e.message)) throw rollbackAs({ duplicate: true, order });
            throw e;
        }
        if (!flip.changes) throw rollbackAs({ duplicate: true, order });

        const tickets = [];
        if (stockOk) {
            let names = [];
            try { names = JSON.parse(order.holder_names || '[]') || []; } catch (e) { names = []; }
            let n = 0;
            for (const it of items) {
                for (let i = 0; i < it.quantity; i++, n++) {
                    const token = core.randomToken();
                    const ins = await dbRun('INSERT INTO tickets (order_id, ticket_type_id, holder_name, token, created_at) VALUES (?, ?, ?, ?, ?)',
                        [order.id, it.ticket_type_id, names[n] || order.buyer_name || null, token, t]);
                    tickets.push({ id: ins.lastID, token });
                }
            }
        }
        const outcome = stockOk ? (late ? 'paid_late' : 'paid') : 'refund_required';
        await dbRun("UPDATE ticket_webhook_events SET outcome = ? WHERE order_id = ? AND gateway_payment_id = ? AND verified = 1", [outcome, order.id, String(pfPaymentId)]);
        const fresh = await ticketing.getOrderById(order.id);
        return stockOk ? { ok: true, order: fresh, tickets, late } : { refundRequired: true, order: fresh };
    }).catch((e) => { if (e && e.rollbackAs) return e.rollbackAs; throw e; });

    // After the commit: tickets by e-mail, or the refund notices. Never inside the transaction (the mail queue is its own writer).
    if (result.ok || result.refundRequired) {
        const delivery = require('./ticketing-delivery');
        if (result.ok) delivery.deliverOrder(result.order.id, { reason: result.late ? 'paid_late' : 'paid' }).catch(e => console.error(`[Ticketing] delivery failed for ${tag(result.order)}:`, e.message));
        else delivery.notifyRefundRequired(result.order.id).catch(e => console.error(`[Ticketing] refund notice failed for ${tag(result.order)}:`, e.message));
    }
    return result;
}

// A FAILED payment ends the order and gives its tickets back (a CANCELLED one keeps the hold so the buyer can try again, as bookings do).
async function failOrder(orderId) {
    return ticketing.inTransaction(() => ticketing.releaseHoldInTxn(orderId, 'failed'));
}

// ---------------------------------------------------------------- the notification (called by routes/public/payment.js; 200 already sent)

async function handleItn(req, pfData) {
    const isSandbox = isSandboxPayfast();
    const orderId = core.orderIdFromPaymentId(pfData.m_payment_id);
    const itnAsPosted = req.pfRawBody || pfData;      // exactly as PayFast posted it (app.js keeps this copy for the signature)
    let eventId = null;
    const refuse = async (outcome, logLine) => {
        console.error(`[Ticketing ITN] ${pfData.m_payment_id}: ${logLine}`);
        if (eventId) await setOutcome(eventId, outcome);
        else await recordNotification({ orderId, pfData, raw: itnAsPosted, source: 'itn', outcome }).catch(() => {});
        return { refused: outcome };
    };
    try {
        const order = orderId ? await ticketing.getOrderById(orderId) : null;
        eventId = await recordNotification({ orderId: order ? order.id : null, pfData, raw: itnAsPosted, source: 'itn', outcome: 'received' });

        const ts = itnTimestampCheck(pfData, isSandbox);
        if (ts.stale) return refuse('rejected_stale_timestamp', `stale timestamp (${ts.ageMins.toFixed(1)} min) - possible replay`);
        const sig = verifyPayFastItnSignature(itnAsPosted, process.env.PAYFAST_PASSPHRASE || null);
        if (!sig.valid) return refuse('rejected_signature', 'signature mismatch');
        if (!isSandbox && !PAYFAST_VALID_IPS.has(itnSourceIp(req))) return refuse('rejected_source_ip', `source address ${itnSourceIp(req)} is not PayFast`);
        if (String(pfData.merchant_id) !== String(process.env.PAYFAST_MERCHANT_ID)) return refuse('rejected_merchant', 'merchant id mismatch');
        if (!order) return refuse('rejected_unknown_order', 'no such ticket order');
        const pfValid = await confirmItnWithPayfast(itnAsPosted, isSandbox);
        if (!pfValid && !isSandbox) return refuse('rejected_validate', 'PayFast did not confirm this notification');
        if (!pfData.pf_payment_id) return refuse('rejected_no_payment_id', 'no PayFast payment id');

        const status = String(pfData.payment_status || '').toUpperCase();
        if (status === 'COMPLETE') {
            const amountCents = core.amountStringToCents(pfData.amount_gross);
            if (amountCents === null || amountCents !== order.total_cents) {
                await refuse('rejected_amount_mismatch', `amount ${pfData.amount_gross} does not match the order total ${core.centsToAmountString(order.total_cents)}`);
                require('./ticketing-delivery').alertAdmin({
                    subject: `Ticket payment amount mismatch - Order ${order.id}`,
                    lead: `PayFast reported <strong>R${core.centsToAmountString(amountCents || 0)}</strong> for ticket order <strong>#${order.id}</strong>, which costs <strong>R${core.centsToAmountString(order.total_cents)}</strong>. Nothing was issued.`,
                    body: 'Check the payment in the PayFast dashboard and refund it if needed.', trigger: 'Admin: Ticket Payment Mismatch'
                }).catch(() => {});
                return { refused: 'rejected_amount_mismatch' };
            }
            const r = await confirmTicketPayment({ orderId: order.id, pfPaymentId: pfData.pf_payment_id, amountCents, source: 'itn', webhookEventId: eventId });
            if (r.duplicate) { await setOutcome(eventId, 'ignored_duplicate'); return { duplicate: true }; }
            if (r.mismatch) { await setOutcome(eventId, 'rejected_amount_mismatch'); return { refused: 'rejected_amount_mismatch' }; }
            console.log(`[Ticketing ITN] ${tag(order)}: ${r.ok ? (r.late ? 'paid (late, re-reserved)' : 'paid') : 'paid but sold out - refund required'}`);
            return r;
        }
        if (status === 'FAILED') {
            const released = await failOrder(order.id);
            await setOutcome(eventId, released ? 'payment_failed' : 'payment_failed_ignored');
            console.warn(`[Ticketing ITN] ${tag(order)}: payment FAILED${released ? ' - hold released' : ''}`);
            return { failed: true };
        }
        await setOutcome(eventId, 'status_' + status.toLowerCase());
        console.warn(`[Ticketing ITN] ${tag(order)}: payment status ${status} - order unchanged`);
        return { ignored: status };
    } catch (e) {
        console.error(`[Ticketing ITN] ${pfData.m_payment_id}: unhandled error:`, e.message);
        if (eventId) await setOutcome(eventId, 'error');
        return { error: e.message };
    }
}

// ---------------------------------------------------------------- the safety net (lib/payfast-reconcile.js)

// Unpaid ticket orders that went to PayFast, in the shape lib/payfast-api.js planRecovery() matches against PayFast's own history:
// { id, ticket_order_id, booking_id: null, m_payment_id, expected_amount, status: 'pending', created_at: 'YYYY-MM-DD HH:MM:SS' UTC }.
// "Started" is when the buyer was sent to PayFast (checkout_started_at), so an older payment under the same reference can never match.
// Expired / failed orders are included: a payment that arrives after its hold ended is still the buyer's money (confirmTicketPayment
// re-reserves the tickets if any are left, else flags the order for a refund).
async function pendingPaymentIntents({ minAgeSeconds = 0, lookbackDays = 21, orderId = null } = {}) {
    const now = Date.now();
    const params = [new Date(now - lookbackDays * 86400000).toISOString(), new Date(now - Math.max(0, minAgeSeconds) * 1000).toISOString()];
    let sql = `SELECT id, m_payment_id, total_cents, checkout_started_at FROM ticket_orders
               WHERE status IN ('pending', 'expired', 'failed') AND checkout_started_at IS NOT NULL AND checkout_started_at >= ? AND checkout_started_at <= ?`;
    if (orderId) { sql += ' AND id = ?'; params.push(orderId); }
    const rows = await dbAll(sql + ' ORDER BY checkout_started_at', params);
    return rows.map(r => ({
        id: 'ticket-' + r.id, ticket_order_id: r.id, booking_id: null, m_payment_id: r.m_payment_id,
        expected_amount: core.centsToAmountString(r.total_cents), status: 'pending',
        created_at: r.checkout_started_at.slice(0, 19).replace('T', ' ')
    }));
}

// PayFast payment ids already recorded against a ticket order (the safety net must not record them again).
async function recordedGatewayIds(pfIds) {
    const out = new Set();
    for (let i = 0; i < pfIds.length; i += 200) {
        const chunk = pfIds.slice(i, i + 200);
        for (const r of await dbAll(`SELECT gateway_payment_id FROM ticket_orders WHERE gateway_payment_id IN (${chunk.map(() => '?').join(',')})`, chunk)) out.add(String(r.gateway_payment_id));
    }
    return out;
}

module.exports = { buildCheckout, confirmTicketPayment, failOrder, handleItn, recordNotification, pendingPaymentIntents, recordedGatewayIds };
