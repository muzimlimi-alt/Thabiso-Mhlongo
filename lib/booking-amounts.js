// Which bookings carry an AGREED amount - and which only a catalogue ESTIMATE.
//
// From the moment an enquiry arrives, bookings.quote_amount / total_amount / amount_outstanding hold the service-catalogue estimate of what
// it would cost (the published rate for a fixed-price service, 0 for one priced individually). That is a rate, not money. A report,
// export or screen must not present it as "quoted" or "outstanding" until a quotation exists, otherwise every rate-card change would
// read as new booked value.
//
// A booking carries an agreed amount when a quotation stands for it (or it was ever stamped quoted_at), or its status can only follow
// a quotation or a commitment (an admin-created booking entered straight at CONFIRMED has no quotation, but its amount IS the commitment).
// Receivables are narrower still - accepted commitments only - and live in getOutstandingTotal (database/repositories/bookings.repository.js).
const AGREED_STATUSES = Object.freeze(['QUOTED', 'ACCEPTED', 'CONFIRMED', 'COMPLETED']);

// SQL predicate for a query that aliases bookings as `b` (or the alias given).
function agreedAmountSql(b = 'b') {
    const list = AGREED_STATUSES.map(s => `'${s}'`).join(',');
    return `(${b}.quoted_at IS NOT NULL OR ${b}.status IN (${list})
             OR EXISTS (SELECT 1 FROM quotations aq WHERE aq.booking_id = ${b}.id AND UPPER(COALESCE(aq.status, '')) != 'VOID'))`;
}

// The same rule for a booking row already in memory (needs quoted_at and status; has_quote, when present, counts too).
function hasAgreedAmount(row) {
    if (!row) return false;
    return !!(row.quoted_at || Number(row.has_quote) === 1 || AGREED_STATUSES.includes(String(row.status || '').toUpperCase()));
}

const AMOUNT_BASIS_LABEL = Object.freeze({ quoted: 'Quoted', none: 'No quotation yet' });

// What ONE transactions row contributes to the money RECEIVED on a booking: a payment counts in full, a refund / chargeback comes off, and a
// manual ADJUSTMENT (credit / debit, lib/booking-adjustments.js) counts as nothing - it changes what is owed, never what was received.
// Summing every completed transaction as money in made an adjustment look like a payment (a false ledger discrepancy, an inflated "paid"
// after a cancellation refund). For a query that aliases transactions as `t` (or the alias given).
function receivedAmountSql(t = 't') {
    return `CASE WHEN ${t}.transaction_type IN ('refund','chargeback') THEN -${t}.amount WHEN ${t}.transaction_type = 'adjustment' THEN 0 ELSE ${t}.amount END`;
}

module.exports = { AGREED_STATUSES, agreedAmountSql, hasAgreedAmount, AMOUNT_BASIS_LABEL, receivedAmountSql };
