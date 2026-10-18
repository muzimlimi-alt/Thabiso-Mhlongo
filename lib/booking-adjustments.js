// Manual ADJUSTMENTS (credit / debit) logged against a booking, and how they ride on top of the approved quotation.
//
// POST /api/admin/transactions/manual with transaction_type 'adjustment' records a transactions row whose notes start "[Adjustment: credit]"
// or "[Adjustment: debit]" and moves the booking total (credit lowers it, never below R0; debit raises it). The invoice is then rebuilt from
// the approved quotation (lib/approved-quote.js) - and used to write the quotation's total straight back over the adjusted one, so an
// adjustment lasted only until the next rebuild, which the adjustment itself triggered.
//
// The rule now: an invoice is the approved quotation PLUS the adjustments logged since that quotation was issued (a new quotation starts
// fresh), applied in the order they were logged with exactly the arithmetic the ledger uses. They are separate lines - never folded into a
// quoted line - and VAT is NOT recalculated for them: the VAT of the approved quotation stays as quoted, as the ledger always treated an
// adjustment as a change to the amount payable and nothing more.
//
// Pure (no database access): the query lives in database/repositories/finance.repository.js (getStandingAdjustmentRows).
const NOTE_RE = /^\[Adjustment: (credit|debit)\]\s*([\s\S]*)$/;
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// One transactions row -> { id, direction, requested, note }, or null when it cannot be applied (no recorded direction, or no positive amount).
function parseAdjustmentRow(row) {
    if (!row) return null;
    const m = NOTE_RE.exec(String(row.notes || '').trim());
    const requested = round2(row.amount);
    if (!m || !(requested > 0)) return null;
    return { id: row.id, direction: m[1], requested, note: m[2].trim() };
}

// baseTotal: the approved quotation's total. rows: transactions rows in the order they were logged.
// Returns { base, total, net, lines }. Each line is what was REALLY applied (a credit larger than what is left stops at R0, so its line shows
// the smaller amount) - signed, so lines add up to `net`.
function applyAdjustments(baseTotal, rows) {
    const base = round2(baseTotal);
    let total = base;
    const lines = [];
    for (const raw of (rows || [])) {
        const a = parseAdjustmentRow(raw);
        if (!a) continue;
        const before = total;
        total = a.direction === 'credit' ? Math.max(0, round2(total - a.requested)) : round2(total + a.requested);
        const signed = round2(total - before);
        if (signed === 0) continue;   // a credit against an already-zero total changes nothing, so it has no line
        const label = `Adjustment (${a.direction})`;
        lines.push({
            id: a.id, direction: a.direction, requested: a.requested, applied: Math.abs(signed), signed, note: a.note,
            label, description: a.note ? `${label} – ${a.note}` : label
        });
    }
    return { base, total, net: round2(total - base), lines };
}

module.exports = { parseAdjustmentRow, applyAdjustments };
